import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import { createIssue, listNotifications, updateIssue } from "../src";
import { notifyIssueChanged } from "../src/notification-producers";
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
const inbox = (userId: string) => listNotifications(deps(), userId, f.org.id, {});
const kindsOf = async (userId: string, kind: string) => (await inbox(userId)).items.filter((n) => n.kind === kind);

describe("who hears about a card with several people", () => {
  test("a person added also with is notified once", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    const card = await createIssue(deps(), owner(), f.org.id, { title: "dupla", assignee: who("person", bia.id) });
    expect(await kindsOf(caio.id, "issue_assigned")).toHaveLength(0);

    await updateIssue(deps(), owner(), f.org.id, card.id, { addAssignees: [who("person", caio.id)] });
    const heard = await kindsOf(caio.id, "issue_assigned");
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ count: 1, source: { issueId: card.id } });

    // Naming them again changes nothing, so nothing more is sent.
    await updateIssue(deps(), owner(), f.org.id, card.id, { addAssignees: [who("person", caio.id)] });
    const rows = await f.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, caio.id), eq(schema.notifications.kind, "issue_assigned")));
    expect(rows).toHaveLength(1);
    // The principal was already on it and heard nothing new from this change.
    expect((await kindsOf(bia.id, "issue_assigned")).every((n) => n.count === 1)).toBe(true);
  });

  test("a status change reaches the people also with as it reaches the principal", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    const card = await createIssue(deps(), owner(), f.org.id, {
      title: "muda de fase",
      assignees: [who("person", bia.id), who("person", caio.id)],
    });
    const agentActor = { type: "agent" as const, agentId: f.agent.id, channelId: f.general.id };
    await updateIssue(deps(), agentActor, f.org.id, card.id, { status: "in_review" });
    for (const id of [bia.id, caio.id]) {
      const [status] = await kindsOf(id, "issue_status");
      expect(status).toMatchObject({ latest: { statusFrom: "todo", statusTo: "in_review" } });
    }
  });

  test("a person taken off has the assigned notice resolved", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    const card = await createIssue(deps(), owner(), f.org.id, {
      title: "sai do card",
      assignees: [who("person", bia.id), who("person", caio.id)],
    });
    expect(await kindsOf(caio.id, "issue_assigned")).toHaveLength(1);
    await updateIssue(deps(), owner(), f.org.id, card.id, { removeAssignees: [who("person", caio.id)] });
    const [row] = await f.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, caio.id), eq(schema.notifications.kind, "issue_assigned")));
    expect(row?.doneAt).not.toBeNull();
    // The one still on the card keeps theirs.
    const [kept] = await f.db
      .select()
      .from(schema.notifications)
      .where(and(eq(schema.notifications.userId, bia.id), eq(schema.notifications.kind, "issue_assigned")));
    expect(kept?.doneAt).toBeNull();
  });

  test("a swap between two people already on the card notifies nobody", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    const card = await createIssue(deps(), owner(), f.org.id, {
      title: "troca o principal",
      assignees: [who("person", bia.id), who("person", caio.id)],
    });
    const count = async () => (await f.db.select().from(schema.notifications)).length;
    const before = await count();
    await updateIssue(deps(), owner(), f.org.id, card.id, { principal: who("person", caio.id) });
    expect(await count()).toBe(before);
    for (const id of [bia.id, caio.id]) {
      const [n] = await f.db
        .select()
        .from(schema.notifications)
        .where(and(eq(schema.notifications.userId, id), eq(schema.notifications.kind, "issue_assigned")));
      expect(n?.doneAt).toBeNull();
    }
  });

  test("only people who see the card are told", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    const card = await createIssue(deps(), owner(), f.org.id, {
      title: "fechado",
      audience: { mode: "people", userIds: [f.owner.id, bia.id] },
    });
    const [row] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, card.id));
    if (!row) throw new Error("no card");
    await notifyIssueChanged(deps(), who("person", f.owner.id), null, row, { before: [], after: [bia.id, caio.id] });
    expect(await kindsOf(bia.id, "issue_assigned")).toHaveLength(1);
    expect(await kindsOf(caio.id, "issue_assigned")).toHaveLength(0);
  });
});
