import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createIssue, listIssues } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });

describe("the member's own tasks list (my-tasks)", () => {
  test("a member's assigned list leaves out tasks they cannot see", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const mine = { type: "person" as const, id: bia.id };
    const make = (title: string, assignee: { type: "person" | "agent"; id: string } | null) =>
      createIssue(deps, person(f.owner.id), f.org.id, {
        title,
        assignees: assignee ? [assignee] : [],
      });

    const visible = await make("A minha, de todos", mine);
    const ownersTask = await make("Do dono", { type: "person", id: f.owner.id });
    const agentsTask = await make("Do agente", { type: "agent", id: f.agent.id });
    const hidden = await make("A minha, mas só do dono", mine);
    // A task limited to the owner that names Bia as its assignee but not in its audience: she cannot open it.
    await f.db
      .update(schema.issues)
      .set({ restricted: true, audienceUserIds: [f.owner.id] })
      .where(eq(schema.issues.id, hidden.id));

    const list = await listIssues(f.db, person(bia.id), f.org.id, { assignee: mine });
    expect(list.map((i) => i.title)).toEqual([visible.title]);
    // Not the ones of someone else or of an agent, which the same call reads for who asks for them.
    expect(list.map((i) => i.id)).not.toContain(ownersTask.id);
    expect(list.map((i) => i.id)).not.toContain(agentsTask.id);

    // The owner is an administrator: they read the limited one too.
    const ownerList = await listIssues(f.db, person(f.owner.id), f.org.id, { assignee: mine });
    expect(ownerList.map((i) => i.title).sort()).toEqual([hidden.title, visible.title].sort());
  });

  test("leaving canceled tasks out happens before the cap, so they cannot spend it", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const mine = { type: "person" as const, id: f.owner.id };
    for (const title of ["c1", "c2", "c3"]) {
      const made = await createIssue(deps, person(f.owner.id), f.org.id, { title, assignees: [mine] });
      await f.db.update(schema.issues).set({ status: "canceled" }).where(eq(schema.issues.id, made.id));
    }
    await createIssue(deps, person(f.owner.id), f.org.id, { title: "aberta", assignees: [mine] });
    const list = await listIssues(f.db, person(f.owner.id), f.org.id, {
      assignee: mine,
      notStatus: "canceled",
      limit: 2,
    });
    expect(list.map((i) => i.title)).toEqual(["aberta"]);
  });
});
