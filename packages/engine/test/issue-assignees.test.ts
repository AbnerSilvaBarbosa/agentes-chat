import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic, type RealtimeEvent } from "@agenteschat/adapters";
import { and, asc, eq, schema, sql } from "@agenteschat/db";
import {
  askAgentToImplement,
  createAgent,
  createIssue,
  getIssue,
  getIssueDetail,
  listIssueActivity,
  listIssues,
  NEW_AGENT_DEFAULTS,
  openTaskConversation,
  setIssueAudience,
  updateIssue,
  ValidationError,
} from "../src";
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

describe("creating a card with several people", () => {
  test("createIssue puts several people on the card beside the principal", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const [bia, caio] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
    ];
    const card = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "três",
      assignees: [
        actor("person", bia.id),
        actor("person", caio.id),
        actor("person", f.owner.id),
        actor("person", bia.id),
      ],
    });
    expect(card.assignee).toEqual(actor("person", bia.id));
    expect(card.alsoWith).toEqual([actor("person", caio.id), actor("person", f.owner.id)]);
    expect(await stateOf(card.id)).toMatchObject({ principal: ["person", bia.id], also: [caio.id, f.owner.id] });
    // The creation's history stays the single created event.
    const history = await f.db.select().from(schema.issueActivity).where(eq(schema.issueActivity.issueId, card.id));
    expect(history.map((h) => h.event)).toEqual(["created"]);
    // addAssignees goes beside whoever assignee names.
    const beside = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "ao lado",
      assignee: actor("person", bia.id),
      addAssignees: [actor("person", caio.id)],
    });
    expect(beside.assignee).toEqual(actor("person", bia.id));
    expect(beside.alsoWith).toEqual([actor("person", caio.id)]);
    // The old single assignee is unchanged.
    const old = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "um",
      assignee: actor("person", bia.id),
    });
    expect(old.assignee).toEqual(actor("person", bia.id));
    expect(old.alsoWith).toEqual([]);
  });

  test("createIssue with an agent and people keeps the agent as the principal", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const card = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "agente e gente",
      assignees: [actor("person", bia.id), actor("agent", f.agent.id)],
    });
    expect(card.assignee).toEqual(actor("agent", f.agent.id));
    expect(card.alsoWith).toEqual([actor("person", bia.id)]);
    expect(await stateOf(card.id)).toMatchObject({ principal: ["agent", f.agent.id], also: [bia.id] });
    const beside = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "assignee agente",
      assignee: actor("agent", f.agent.id),
      addAssignees: [actor("person", bia.id)],
    });
    expect(beside.assignee).toEqual(actor("agent", f.agent.id));
    expect(beside.alsoWith).toEqual([actor("person", bia.id)]);
  });

  test("createIssue refuses a sixth person also with, two agents and a non-member, and makes no card", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const people = [];
    for (const n of ["A", "B", "C", "D", "E", "F", "G"]) people.push(await addMember(f.db, f.org.id, "member", n));
    const outsider = await addUser(f.db, "Fora");
    const code = async (input: Parameters<typeof createIssue>[3]) =>
      (await createIssue(deps, person(f.owner.id), f.org.id, input).catch((e) => e)).code;
    expect(await code({ title: "sete", assignees: people.map((p) => actor("person", p.id)) })).toBe(
      "issue.assignees_max",
    );
    expect(
      await code({ title: "dois", assignees: [actor("agent", f.agent.id), actor("agent", crypto.randomUUID())] }),
    ).toBe("issue.two_agents");
    const nonMember = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "fora",
      assignees: [actor("person", outsider.id)],
    }).catch((e) => e);
    expect(nonMember.message).toBe("That person is not a member of this organization");
    expect(await f.db.select().from(schema.issues)).toHaveLength(0);
  });

  test("createIssue with a limited audience keeps every person it names on the card", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const [bia, caio] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
    ];
    const card = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "reservado",
      assignees: [actor("person", bia.id), actor("person", caio.id)],
      audience: { mode: "people", userIds: [] },
    });
    expect(card.audience.mode).toBe("people");
    expect([...card.audience.userIds].sort()).toEqual([bia.id, caio.id].sort());
    expect(card.alsoWith).toEqual([actor("person", caio.id)]);
  });
});

describe("changing who is responsible on a card", () => {
  const events = async (issueId: string) =>
    (await listIssueActivity(f.db, person(f.owner.id), f.org.id, issueId)).filter((a) => a.kind === "event");
  const deps = () => ({ db: f.db, pubsub: f.pubsub });

  test("adding someone records an assignee_added event and keeps the principal", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "dupla",
      assignee: actor("person", f.owner.id),
    });
    const heard: RealtimeEvent[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => heard.push(e));
    const view = await updateIssue(deps(), person(f.owner.id), f.org.id, card.id, {
      addAssignees: [actor("person", bia.id)],
    });
    expect(view.assignee).toEqual(actor("person", f.owner.id));
    expect(view.alsoWith).toEqual([actor("person", bia.id)]);
    const added = (await events(card.id)).filter((e) => e.event === "assignee_added");
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      author: { type: "person", id: f.owner.id },
      textCode: "assignee_added",
      textParams: { name: "Bia" },
    });
    // The principal was not re-announced.
    expect((await events(card.id)).filter((e) => e.event === "assigned")).toHaveLength(0);
    // The screen hears the card with its people inside the update.
    const update = heard
      .map((h) => (h as unknown as { event?: { type: string; issue?: { alsoWith?: unknown } } }).event)
      .find((e) => e?.type === "issue.updated");
    expect(update?.issue?.alsoWith).toEqual([actor("person", bia.id)]);
  });

  test("removing someone records an assignee_removed event and keeps the others", async () => {
    f = await setup();
    const [bia, caio] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
    ];
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "trio",
      assignees: [actor("person", f.owner.id), actor("person", bia.id), actor("person", caio.id)],
    });
    const view = await updateIssue(deps(), person(f.owner.id), f.org.id, card.id, {
      removeAssignees: [actor("person", bia.id)],
    });
    expect(view.assignee).toEqual(actor("person", f.owner.id));
    expect(view.alsoWith).toEqual([actor("person", caio.id)]);
    const removed = (await events(card.id)).filter((e) => e.event === "assignee_removed");
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({ textCode: "assignee_removed", textParams: { name: "Bia" } });
  });

  test("handing the card to another agent keeps the people and says so in the history", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "passa a bola",
      assignees: [actor("agent", f.agent.id), actor("person", bia.id)],
    });
    const view = await updateIssue(deps(), person(f.owner.id), f.org.id, card.id, { assignee: actor("agent", qa.id) });
    expect(view.assignee).toEqual(actor("agent", qa.id));
    expect(view.alsoWith).toEqual([actor("person", bia.id)]);
    expect(await stateOf(card.id)).toMatchObject({ principal: ["agent", qa.id], also: [bia.id] });
    const replaced = (await events(card.id)).filter((e) => e.event === "agent_replaced");
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({ textCode: "agent_replaced", textParams: { to: "QA" } });
    expect((await events(card.id)).filter((e) => e.event === "assigned")).toHaveLength(0);
    // A person given to a card that has an agent joins beside it; the agent stays the principal.
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    const joined = await updateIssue(deps(), person(f.owner.id), f.org.id, card.id, {
      assignee: actor("person", caio.id),
    });
    expect(joined.assignee).toEqual(actor("agent", qa.id));
    expect(joined.alsoWith).toEqual([actor("person", bia.id), actor("person", caio.id)]);
  });

  test("handing the card to another agent admits it to the task conversation", async () => {
    f = await setup();
    const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "sala",
      assignee: actor("agent", f.agent.id),
    });
    const room = await openTaskConversation(f.db, person(f.owner.id), f.org.id, card.id);
    const inRoom = async (agentId: string) =>
      (
        await f.db
          .select()
          .from(schema.channelMembers)
          .where(and(eq(schema.channelMembers.channelId, room.channelId), eq(schema.channelMembers.agentId, agentId)))
      ).length;
    expect(await inRoom(qa.id)).toBe(0);
    await updateIssue(deps(), person(f.owner.id), f.org.id, card.id, { assignee: actor("agent", qa.id) });
    expect(await inRoom(qa.id)).toBe(1);
    // An agent put on a card that had a person as principal joins as well.
    const other = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "outra sala",
      assignee: actor("person", f.owner.id),
    });
    const otherRoom = await openTaskConversation(f.db, person(f.owner.id), f.org.id, other.id);
    await updateIssue(deps(), person(f.owner.id), f.org.id, other.id, { assignee: actor("agent", f.agent.id) });
    const joinedOther = await f.db
      .select()
      .from(schema.channelMembers)
      .where(
        and(eq(schema.channelMembers.channelId, otherRoom.channelId), eq(schema.channelMembers.agentId, f.agent.id)),
      );
    expect(joinedOther).toHaveLength(1);
  });

  test("a plain assignee change still works as it did", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "antigo" });
    const first = await updateIssue(deps(), person(f.owner.id), f.org.id, card.id, {
      assignee: actor("person", f.owner.id),
    });
    expect(first.assignee).toEqual(actor("person", f.owner.id));
    expect(first.alsoWith).toEqual([]);
    const second = await updateIssue(deps(), person(f.owner.id), f.org.id, card.id, {
      assignee: actor("person", bia.id),
    });
    expect(second.assignee).toEqual(actor("person", bia.id));
    expect(second.alsoWith).toEqual([]);
    const cleared = await updateIssue(deps(), person(f.owner.id), f.org.id, card.id, { assignee: null });
    expect(cleared.assignee).toBeNull();
    const kinds = (await events(card.id)).map((e) => [e.event, e.textCode]);
    expect(kinds.filter(([e]) => e === "assigned")).toEqual([
      ["assigned", "assigned"],
      ["assigned", "assigned"],
      ["assigned", "unassigned"],
    ]);
  });

  test("the card refuses a sixth person, two agents and a non-member through updateIssue and changes nothing", async () => {
    f = await setup();
    const people = [];
    for (const n of ["A", "B", "C", "D", "E", "F", "G"]) people.push(await addMember(f.db, f.org.id, "member", n));
    const outsider = await addUser(f.db, "Fora");
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "cheio",
      assignees: people.slice(0, 6).map((p) => actor("person", p.id)),
    });
    const before = await stateOf(card.id);
    const code = async (patch: Parameters<typeof updateIssue>[4]) =>
      (await updateIssue(deps(), person(f.owner.id), f.org.id, card.id, patch).catch((e) => e)).code;
    expect(await code({ addAssignees: [actor("person", people[6]?.id as string)] })).toBe("issue.assignees_max");
    expect(await code({ assignees: [actor("agent", f.agent.id), actor("agent", crypto.randomUUID())] })).toBe(
      "issue.two_agents",
    );
    expect(await code({ principal: actor("person", outsider.id) })).toBe("issue.principal_not_on_card");
    const roomy = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "vazio" });
    const nonMember = await updateIssue(deps(), person(f.owner.id), f.org.id, roomy.id, {
      addAssignees: [actor("person", outsider.id)],
    }).catch((e) => e);
    expect(nonMember.message).toBe("That person is not a member of this organization");
    expect(await stateOf(roomy.id)).toMatchObject({ principal: [null, null], also: [] });
    expect(await stateOf(card.id)).toEqual(before);
    // Making a person also with the principal swaps them.
    const swapped = await updateIssue(deps(), person(f.owner.id), f.org.id, card.id, {
      principal: actor("person", people[2]?.id as string),
    });
    expect(swapped.assignee).toEqual(actor("person", people[2]?.id as string));
    expect((await events(card.id)).some((e) => e.event === "principal_changed")).toBe(true);
  });
});

describe("filtering by who is on a card", () => {
  test("the person filter lists a card where they are also with and the agent filter lists the principal only", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const [bia, caio] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
    ];
    const make = (title: string, input: Parameters<typeof createIssue>[3] = { title }) =>
      createIssue(deps, person(f.owner.id), f.org.id, { ...input, title });
    const principal = await make("principal", { title: "", assignee: actor("person", bia.id) });
    const beside = await make("ao lado do agente", {
      title: "",
      assignee: actor("agent", f.agent.id),
      addAssignees: [actor("person", bia.id)],
    });
    const amongPeople = await make("entre pessoas", {
      title: "",
      assignees: [actor("person", caio.id), actor("person", bia.id)],
    });
    const notHers = await make("de outro", { title: "", assignee: actor("person", caio.id) });
    const asOwner = (assignee: { type: "person" | "agent"; id: string }) =>
      listIssues(f.db, person(f.owner.id), f.org.id, { assignee });
    const ids = (list: { id: string }[]) => list.map((i) => i.id).sort();
    expect(ids(await asOwner(actor("person", bia.id)))).toEqual(ids([principal, beside, amongPeople]));
    expect(ids(await asOwner(actor("person", caio.id)))).toEqual(ids([amongPeople, notHers]));
    // The agent filter reads the principal only: the person filter does not leak into it, nor the reverse.
    expect(ids(await asOwner(actor("agent", f.agent.id)))).toEqual(ids([beside]));
    // Still limited by who sees the card: a card hidden from Bia stays out of her list.
    await f.db
      .update(schema.issues)
      .set({ restricted: true, audienceUserIds: [f.owner.id] })
      .where(eq(schema.issues.id, beside.id));
    const hers = await listIssues(f.db, person(bia.id), f.org.id, { assignee: actor("person", bia.id) });
    expect(ids(hers)).toEqual(ids([principal, amongPeople]));
  });
});

describe("who sees a card that has several people", () => {
  test("a limited audience keeps every person on the card", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const [bia, caio, dani, edu] = [
      await addMember(f.db, f.org.id, "member", "Bia"),
      await addMember(f.db, f.org.id, "member", "Caio"),
      await addMember(f.db, f.org.id, "member", "Dani"),
      await addMember(f.db, f.org.id, "member", "Edu"),
    ];
    const card = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "aberto",
      assignees: [actor("agent", f.agent.id), actor("person", bia.id), actor("person", caio.id)],
    });
    // A step with its own people: its principal and the person also with it.
    const step = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "passo",
      parentIssueId: card.id,
      assignees: [actor("person", edu.id), actor("person", caio.id)],
    });
    const narrowed = await setIssueAudience(deps, person(f.owner.id), f.org.id, card.id, {
      mode: "people",
      userIds: [dani.id],
    });
    // The agent is not a person to list; the card's people stay with the one chosen.
    expect([...narrowed.audience.userIds].sort()).toEqual([bia.id, caio.id, dani.id].sort());
    const stepRow = await getIssue(f.db, person(f.owner.id), f.org.id, { id: step.id });
    expect([...stepRow.audience.userIds].sort()).toEqual([bia.id, caio.id, dani.id, edu.id].sort());
    // Each of them still sees the card.
    for (const who of [bia, caio, dani]) {
      expect((await getIssue(f.db, person(who.id), f.org.id, { id: card.id })).id).toBe(card.id);
    }
    // When the principal is a person, the same: nobody on the card is cut off.
    const people = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "gente",
      assignees: [actor("person", bia.id), actor("person", caio.id)],
    });
    const only = await setIssueAudience(deps, person(f.owner.id), f.org.id, people.id, {
      mode: "people",
      userIds: [dani.id],
    });
    expect([...only.audience.userIds].sort()).toEqual([bia.id, caio.id, dani.id].sort());
  });
});

describe("asking an agent to implement a card", () => {
  test("asking an agent to implement a card keeps the person beside it", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const card = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "pede ao agente",
      assignees: [actor("person", f.owner.id), actor("person", bia.id)],
    });
    const asked = await askAgentToImplement(deps, f.owner.id, f.org.id, card.id, f.agent.id);
    expect(asked.assignee).toEqual(actor("agent", f.agent.id));
    // The person who was the principal stays on the card, ahead of the one already also with.
    expect(asked.alsoWith).toEqual([actor("person", f.owner.id), actor("person", bia.id)]);
    // The start message and the run are what they were: one line in the task's conversation and one run.
    const start = (await f.db.select().from(schema.messages)).filter((m) => m.meta?.issueWorkStart === true);
    expect(start).toHaveLength(1);
    expect(await f.db.select().from(schema.agentRuns)).toHaveLength(1);
  });
});
