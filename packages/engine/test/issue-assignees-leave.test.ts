import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import { createIssue, createOrganization, deleteAccount, removeMember } from "../src";
import { dropFromAssignments } from "../src/issue-assignees";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const deps = () => ({ db: f.db, pubsub: f.pubsub });
const owner = () => ({ type: "person" as const, userId: f.owner.id });
const who = (type: "person" | "agent", id: string) => ({ type, id });

/** The card's principal and people as the database holds them. */
async function stateOf(issueId: string) {
  const [row] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, issueId));
  const rows = await f.db
    .select()
    .from(schema.issueCoAssignees)
    .where(eq(schema.issueCoAssignees.issueId, issueId))
    .orderBy(asc(schema.issueCoAssignees.position));
  return { principal: [row?.assigneeType ?? null, row?.assigneeId ?? null], also: rows.map((r) => r.userId) };
}
const history = async (issueId: string) =>
  (await f.db.select().from(schema.issueActivity).where(eq(schema.issueActivity.issueId, issueId))).filter(
    (a) => a.kind === "event" && (a.data as { left?: boolean }).left === true,
  );
const leave = (userId: string, orgId = f.org.id) =>
  f.db.transaction((tx) => dropFromAssignments(tx, orgId, userId, "people card"));

describe("a person who leaves drops from the cards of the workspace", () => {
  test("a principal person who leaves is replaced by the next one", async () => {
    f = await setup();
    const [bia, caio, dani] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
      await addMember(f.db, f.org.id, "member", "Dani"),
    ];
    const card = await createIssue(deps(), owner(), f.org.id, {
      title: "tres",
      assignees: [who("person", bia.id), who("person", caio.id), who("person", dani.id)],
    });
    expect(await leave(bia.id)).toEqual([card.id]);
    // The first person also with is the principal now, and the rest keep their order.
    expect(await stateOf(card.id)).toEqual({ principal: ["person", caio.id], also: [dani.id] });
    const [event] = await history(card.id);
    expect(event).toMatchObject({
      event: "assigned",
      authorType: "person",
      authorId: bia.id,
      data: { assignee: { type: "person", id: caio.id }, promoted: true, left: true, via: "people card" },
    });
  });

  test("a principal person who leaves with nobody else leaves the card unassigned", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const card = await createIssue(deps(), owner(), f.org.id, { title: "sozinha", assignee: who("person", bia.id) });
    await leave(bia.id);
    expect(await stateOf(card.id)).toEqual({ principal: [null, null], also: [] });
    const [event] = await history(card.id);
    expect(event).toMatchObject({ event: "assigned", authorId: bia.id, data: { assignee: null, left: true } });
  });

  test("a person also with who leaves drops from the card and the principal stays", async () => {
    f = await setup();
    const [bia, caio] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
    ];
    const withAgent = await createIssue(deps(), owner(), f.org.id, {
      title: "com agente",
      assignees: [who("agent", f.agent.id), who("person", bia.id), who("person", caio.id)],
    });
    const withPerson = await createIssue(deps(), owner(), f.org.id, {
      title: "com pessoa",
      assignees: [who("person", f.owner.id), who("person", bia.id)],
    });
    expect((await leave(bia.id)).sort()).toEqual([withAgent.id, withPerson.id].sort());
    expect(await stateOf(withAgent.id)).toEqual({ principal: ["agent", f.agent.id], also: [caio.id] });
    expect(await stateOf(withPerson.id)).toEqual({ principal: ["person", f.owner.id], also: [] });
    const [event] = await history(withPerson.id);
    expect(event).toMatchObject({
      event: "assignee_removed",
      authorId: bia.id,
      data: { assignee: { type: "person", id: bia.id }, name: "Bia", left: true },
    });
  });

  test("cards of other workspaces are untouched and the change rolls back with the caller's transaction", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const { organization: other } = await createOrganization(f.db, f.owner.id, { name: "Outra" });
    await f.db
      .insert(schema.organizationMembers)
      .values({ orgId: other.id, userId: bia.id, role: "member" })
      .onConflictDoNothing();
    const here = await createIssue(deps(), owner(), f.org.id, { title: "aqui", assignee: who("person", bia.id) });
    const there = await createIssue(deps(), owner(), other.id, { title: "la", assignee: who("person", bia.id) });
    const untouched = await createIssue(deps(), owner(), f.org.id, { title: "de outra pessoa" });

    // A failure after the drop undoes it: it ran in the transaction it was given.
    await f.db
      .transaction(async (tx) => {
        await dropFromAssignments(tx, f.org.id, bia.id);
        throw new Error("stop");
      })
      .catch(() => {});
    expect(await stateOf(here.id)).toEqual({ principal: ["person", bia.id], also: [] });

    expect(await leave(bia.id)).toEqual([here.id]);
    expect(await stateOf(here.id)).toEqual({ principal: [null, null], also: [] });
    expect(await stateOf(there.id)).toEqual({ principal: ["person", bia.id], also: [] });
    expect(await stateOf(untouched.id)).toEqual({ principal: [null, null], also: [] });
    expect(await history(there.id)).toEqual([]);
    // Someone on no card changes nothing.
    expect(await leave(bia.id)).toEqual([]);
  });
});

describe("leaving through the engine's doors", () => {
  test("removing a member and deleting an account drop the person from the cards", async () => {
    f = await setup();
    const [bia, caio, dani] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
      await addMember(f.db, f.org.id, "member", "Dani"),
    ];
    const { organization: two } = await createOrganization(f.db, f.owner.id, { name: "Two" });
    await f.db.insert(schema.organizationMembers).values({ orgId: two.id, userId: caio.id, role: "member" });
    const first = await createIssue(deps(), owner(), f.org.id, {
      title: "da Bia",
      assignees: [who("person", bia.id), who("person", dani.id)],
    });
    const second = await createIssue(deps(), owner(), f.org.id, {
      title: "da Caio",
      assignees: [who("person", caio.id), who("person", bia.id)],
    });
    const third = await createIssue(deps(), owner(), two.id, { title: "em Two", assignee: who("person", caio.id) });

    // Removed from the workspace: promoted past them on one card, dropped from the other.
    await removeMember(f.db, f.owner.id, f.org.id, bia.id);
    expect(await stateOf(first.id)).toEqual({ principal: ["person", dani.id], also: [] });
    expect(await stateOf(second.id)).toEqual({ principal: ["person", caio.id], also: [] });

    // Deleting an account leaves every workspace it was in, cards included.
    await deleteAccount(f.db, caio.id, { pubsub: f.pubsub });
    expect(await stateOf(second.id)).toEqual({ principal: [null, null], also: [] });
    expect(await stateOf(third.id)).toEqual({ principal: [null, null], also: [] });
    expect((await history(second.id)).map((e) => e.authorId)).toContain(caio.id);
  });
});
