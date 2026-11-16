import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema, sql } from "@agenteschat/db";
import { createIssue, getIssue, getIssueDetail, listIssues, ValidationError } from "../src";
import { applyAssignees, checkAssignees, coAssigneesOf, onCardSql } from "../src/issue-assignees";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });

/** Puts people also with a card by hand: the engine's writer comes with its own tests. */
async function putAlso(issueId: string, orgId: string, userIds: string[]) {
  await f.db.insert(schema.issueCoAssignees).values(
    userIds.map((userId, position) => ({
      issueId,
      orgId,
      userId,
      position,
      addedByType: "person",
      addedById: userId,
    })),
  );
}

describe("reading the people also with", () => {
  test("coAssigneesOf answers each card's people in order with one query for any number of cards", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const [bia, caio, dani] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
      await addMember(f.db, f.org.id, "member", "Dani"),
    ];
    const one = await createIssue(deps, person(f.owner.id), f.org.id, { title: "um" });
    const two = await createIssue(deps, person(f.owner.id), f.org.id, { title: "dois" });
    const empty = await createIssue(deps, person(f.owner.id), f.org.id, { title: "vazio" });
    // Inserted out of order on purpose: the position decides, not the insert.
    await putAlso(one.id, f.org.id, [dani.id, bia.id, caio.id]);
    await putAlso(two.id, f.org.id, [caio.id]);
    const map = await coAssigneesOf(f.db, [one.id, two.id, empty.id]);
    expect(map.get(one.id)).toEqual([dani.id, bia.id, caio.id]);
    expect(map.get(two.id)).toEqual([caio.id]);
    expect(map.has(empty.id)).toBe(false);
    expect((await coAssigneesOf(f.db, [])).size).toBe(0);
  });

  test("onCardSql is true for the principal person and a person also with, false for others and agent principals", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    const byPerson = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "de pessoa",
      assignee: { type: "person", id: f.owner.id },
    });
    const byAgent = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "de agente",
      assignee: { type: "agent", id: f.agent.id },
    });
    await putAlso(byPerson.id, f.org.id, [bia.id]);
    await putAlso(byAgent.id, f.org.id, [bia.id]);
    const titlesOf = async (userId: string) => {
      const rows = await f.db
        .select({ title: schema.issues.title })
        .from(schema.issues)
        .where(sql`${schema.issues.orgId} = ${f.org.id} and ${onCardSql("issues", sql`${userId}`)}`);
      return rows.map((r) => r.title).sort();
    };
    expect(await titlesOf(f.owner.id)).toEqual(["de pessoa"]);
    expect(await titlesOf(bia.id)).toEqual(["de agente", "de pessoa"]);
    expect(await titlesOf(caio.id)).toEqual([]);
    // An agent's id is never a person: the agent principal matches no person.
    expect(await titlesOf(f.agent.id)).toEqual([]);
  });

  test("the rows of a card are deleted with the card", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const card = await createIssue(deps, person(f.owner.id), f.org.id, { title: "some" });
    const kept = await createIssue(deps, person(f.owner.id), f.org.id, { title: "fica" });
    await putAlso(card.id, f.org.id, [bia.id]);
    await putAlso(kept.id, f.org.id, [bia.id]);
    await f.db.delete(schema.issues).where(eq(schema.issues.id, card.id));
    const rows = await f.db.select().from(schema.issueCoAssignees);
    expect(rows.map((r) => r.issueId)).toEqual([kept.id]);
  });
});

const actor = (type: "person" | "agent", id: string) => ({ type, id });

/** The card's principal columns and its people rows, read back raw. */
async function stateOf(issueId: string) {
  const [row] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, issueId));
  const rows = await f.db
    .select()
    .from(schema.issueCoAssignees)
    .where(eq(schema.issueCoAssignees.issueId, issueId))
    .orderBy(asc(schema.issueCoAssignees.position));
  return { principal: [row?.assigneeType, row?.assigneeId], also: rows.map((r) => r.userId), rows };
}

const change = (issueId: string, orgId: string, c: Parameters<typeof applyAssignees>[2], by = f.owner.id) =>
  f.db.transaction((tx) => applyAssignees(tx, { id: issueId, orgId }, c, actor("person", by)));

describe("writing who is responsible", () => {
  test("a person who is not a member or cannot see the card is refused", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    const outsider = await addUser(f.db, "Fora");
    const card = await createIssue(deps, person(f.owner.id), f.org.id, { title: "fechado" });
    const open = { agentId: null, people: [f.owner.id] };
    const scope = { channelId: null, restricted: true, audienceUserIds: [f.owner.id, bia.id] };

    // Not a member of the workspace.
    const nonMember = await checkAssignees(f.db, f.org.id, open, { add: [actor("person", outsider.id)] }, scope).catch(
      (e) => e,
    );
    expect(nonMember).toBeInstanceOf(ValidationError);
    expect(nonMember.message).toBe("That person is not a member of this organization");
    // A member the card is hidden from.
    const hidden = await checkAssignees(f.db, f.org.id, open, { add: [actor("person", caio.id)] }, scope).catch(
      (e) => e,
    );
    expect(hidden).toBeInstanceOf(ValidationError);
    expect(hidden.code).toBe("issue.assignee_outside");
    // The same through the whole list and through the hand-off.
    for (const c of [{ assignees: [actor("person", caio.id)] }, { assignee: actor("person", caio.id) }]) {
      expect((await checkAssignees(f.db, f.org.id, open, c, scope).catch((e) => e)).code).toBe(
        "issue.assignee_outside",
      );
    }
    // Someone who sees it passes; someone already on the card is not checked again (they can be taken off).
    await checkAssignees(f.db, f.org.id, open, { add: [actor("person", bia.id)] }, scope);
    await checkAssignees(
      f.db,
      f.org.id,
      { agentId: null, people: [f.owner.id, caio.id] },
      { assignees: [actor("person", caio.id)] },
      scope,
    );
    // An agent that was archived does not exist for this.
    await f.db.update(schema.agents).set({ archivedAt: new Date() }).where(eq(schema.agents.id, f.agent.id));
    const archived = await checkAssignees(f.db, f.org.id, open, { assignee: actor("agent", f.agent.id) }, scope).catch(
      (e) => e,
    );
    expect(archived.message).toBe("That agent does not exist in this organization");
    expect(card.id).toBeTruthy();
  });

  test("the principal's columns and the people's rows change together and a refusal writes nothing", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const [bia, caio] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
    ];
    const card = await createIssue(deps, person(f.owner.id), f.org.id, { title: "uma" });
    const done = await change(card.id, f.org.id, {
      assignees: [actor("person", bia.id), actor("person", caio.id), actor("person", f.owner.id)],
    });
    expect(done.after).toEqual({ agentId: null, people: [bia.id, caio.id, f.owner.id] });
    expect(done.events.map((e) => e.event)).toEqual(["assigned", "assignee_added", "assignee_added"]);
    expect(await stateOf(card.id)).toMatchObject({ principal: ["person", bia.id], also: [caio.id, f.owner.id] });

    // An agent over a person principal: the agent is the principal and every person is also with.
    await change(card.id, f.org.id, { assignee: actor("agent", f.agent.id) });
    expect(await stateOf(card.id)).toMatchObject({
      principal: ["agent", f.agent.id],
      also: [bia.id, caio.id, f.owner.id],
    });

    // Two agents refused: nothing moves, not the columns and not the rows.
    const before = await stateOf(card.id);
    const refused = await change(card.id, f.org.id, { add: [actor("agent", crypto.randomUUID())] }).catch((e) => e);
    expect(refused.code).toBe("issue.two_agents");
    expect(await stateOf(card.id)).toEqual(before);
    // Taking everyone off clears the principal and every row.
    await change(card.id, f.org.id, { assignee: null });
    expect(await stateOf(card.id)).toMatchObject({ principal: [null, null], also: [] });
  });

  test("rows are replaced as a set keeping who added the ones that stay", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const [bia, caio, dani] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
      await addMember(f.db, f.org.id, "member", "Dani"),
    ];
    const card = await createIssue(deps, person(f.owner.id), f.org.id, { title: "set" });
    await change(card.id, f.org.id, {
      assignees: [actor("person", f.owner.id), actor("person", bia.id), actor("person", caio.id)],
    });
    const first = await stateOf(card.id);
    const biaRow = first.rows.find((r) => r.userId === bia.id);
    expect(biaRow?.addedById).toBe(f.owner.id);
    // Another person reorders and adds: Bia keeps who added her and when; the order is the new one.
    await change(
      card.id,
      f.org.id,
      {
        assignees: [
          actor("person", f.owner.id),
          actor("person", caio.id),
          actor("person", bia.id),
          actor("person", dani.id),
        ],
      },
      dani.id,
    );
    const second = await stateOf(card.id);
    expect(second.also).toEqual([caio.id, bia.id, dani.id]);
    const biaAfter = second.rows.find((r) => r.userId === bia.id);
    expect(biaAfter?.addedById).toBe(f.owner.id);
    expect(biaAfter?.createdAt.getTime()).toBe(biaRow?.createdAt.getTime() as number);
    expect(second.rows.find((r) => r.userId === dani.id)?.addedById).toBe(dani.id);
  });

  test("two concurrent changes merge instead of losing one", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const [bia, caio] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
    ];
    const card = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "corrida",
      assignee: { type: "person", id: f.owner.id },
    });
    await Promise.all([
      change(card.id, f.org.id, { add: [actor("person", bia.id)] }),
      change(card.id, f.org.id, { add: [actor("person", caio.id)] }),
    ]);
    const state = await stateOf(card.id);
    expect(state.principal).toEqual(["person", f.owner.id]);
    expect([...state.also].sort()).toEqual([bia.id, caio.id].sort());
  });
});

describe("reading a card with its people", () => {
  test("a card is read with its principal and its people also with in order", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const [bia, caio] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
    ];
    const card = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "com gente",
      assignee: { type: "person", id: f.owner.id },
    });
    const alone = await createIssue(deps, person(f.owner.id), f.org.id, { title: "sozinho" });
    expect(card.alsoWith).toEqual([]);
    // Inserted out of order: the read follows the position.
    await f.db.insert(schema.issueCoAssignees).values([
      { issueId: card.id, orgId: f.org.id, userId: caio.id, position: 1, addedByType: "person", addedById: f.owner.id },
      { issueId: card.id, orgId: f.org.id, userId: bia.id, position: 0, addedByType: "person", addedById: f.owner.id },
    ]);
    const expected = [actor("person", bia.id), actor("person", caio.id)];
    const one = await getIssue(f.db, person(f.owner.id), f.org.id, { id: card.id });
    expect(one.assignee).toEqual({ type: "person", id: f.owner.id });
    expect(one.alsoWith).toEqual(expected);
    expect((await getIssueDetail(f.db, person(f.owner.id), f.org.id, { id: card.id })).alsoWith).toEqual(expected);
    const list = await listIssues(f.db, person(f.owner.id), f.org.id, {});
    expect(list.find((i) => i.id === card.id)?.alsoWith).toEqual(expected);
    expect(list.find((i) => i.id === alone.id)?.alsoWith).toEqual([]);
    // An agent that can see the card reads them too: nothing is hidden from it.
    const asAgent = await listIssues(
      f.db,
      { type: "agent", agentId: f.agent.id, channelId: f.general.id },
      f.org.id,
      {},
    );
    expect(asAgent.find((i) => i.id === card.id)?.alsoWith).toEqual(expected);
  });
});
