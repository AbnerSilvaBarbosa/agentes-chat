import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema, sql } from "@agenteschat/db";
import { createIssue } from "../src";
import { coAssigneesOf, onCardSql } from "../src/issue-assignees";
import { addMember, type Fixture, setup } from "./fixtures";

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
