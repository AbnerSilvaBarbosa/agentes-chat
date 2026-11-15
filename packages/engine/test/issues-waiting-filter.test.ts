import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { factoryHome, listIssues } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing");
  return v;
};
const NOW = new Date();
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
let counter = 0;

/** A company with two boards, one column of the review stage that waits for a person (the workspace's), and tasks. */
async function scene() {
  const [space] = await f.db.insert(schema.issueSpaces).values({ orgId: f.org.id, name: "Alfa" }).returning();
  const spaceId = must(space).id;
  const boards = await f.db
    .insert(schema.issueProjects)
    .values([
      { orgId: f.org.id, name: "Site", spaceId },
      { orgId: f.org.id, name: "App", spaceId },
    ])
    .returning();
  const [col] = await f.db
    .insert(schema.issueColumns)
    .values({ orgId: f.org.id, stage: "in_review", name: "Teste humano", position: 5, waitsForPerson: true })
    .returning();
  const task = async (input: Partial<typeof schema.issues.$inferInsert> = {}) => {
    const [row] = await f.db
      .insert(schema.issues)
      .values({
        orgId: f.org.id,
        number: ++counter,
        title: `Task ${counter}`,
        projectId: must(boards[0]).id,
        createdByType: "person",
        createdById: f.owner.id,
        ...input,
      })
      .returning();
    return must(row);
  };
  const waiting = (input: Partial<typeof schema.issues.$inferInsert> = {}) =>
    task({ status: "in_review", columnId: must(col).id, ...input });
  const owner = { type: "person" as const, userId: f.owner.id };
  return { spaceId, site: must(boards[0]), app: must(boards[1]), col: must(col), task, waiting, owner };
}

describe("listIssues waitingForPerson", () => {
  test("returns only tasks in flagged columns the viewer sees", async () => {
    f = await setup();
    const { waiting, task, owner } = await scene();
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    const assignedToAgent = await waiting({ assigneeType: "agent", assigneeId: crypto.randomUUID() });
    const unassigned = await waiting();
    const hidden = await waiting({ restricted: true, audienceUserIds: [f.owner.id] });
    await task({ status: "in_progress" });
    await task({ status: "todo" });
    await task({ status: "canceled" });

    const asMember = await listIssues(f.db, { type: "person", userId: member.id }, f.org.id, {
      waitingForPerson: true,
    });
    expect(asMember.map((i) => i.id).sort()).toEqual([assignedToAgent.id, unassigned.id].sort());
    const asOwner = await listIssues(f.db, owner, f.org.id, { waitingForPerson: true });
    expect(asOwner.map((i) => i.id).sort()).toEqual([assignedToAgent.id, unassigned.id, hidden.id].sort());
    // The same set the factory counts.
    expect((await factoryHome(f.db, owner.userId, f.org.id)).waiting.total).toBe(asOwner.length);
    // Without the filter, every task shows.
    expect((await listIssues(f.db, owner, f.org.id, {})).length).toBe(6);
  });

  test("leaves out a done task, an archived board and an archived company like the factory", async () => {
    f = await setup();
    const { waiting, app, spaceId, owner } = await scene();
    const live = await waiting();
    await waiting({ status: "done" });
    await waiting({ projectId: app.id });
    await f.db.update(schema.issueProjects).set({ archivedAt: new Date() }).where(eq(schema.issueProjects.id, app.id));
    const got = await listIssues(f.db, owner, f.org.id, { waitingForPerson: true });
    expect(got.map((i) => i.id)).toEqual([live.id]);
    await f.db.update(schema.issueSpaces).set({ archivedAt: new Date() }).where(eq(schema.issueSpaces.id, spaceId));
    expect(await listIssues(f.db, owner, f.org.id, { waitingForPerson: true })).toEqual([]);
  });

  test("combines with the company, the board and the search", async () => {
    f = await setup();
    const { waiting, task, site, app, spaceId, owner } = await scene();
    const [other] = await f.db.insert(schema.issueSpaces).values({ orgId: f.org.id, name: "Beta" }).returning();
    const [otherBoard] = await f.db
      .insert(schema.issueProjects)
      .values({ orgId: f.org.id, name: "Outro", spaceId: must(other).id })
      .returning();
    const onSite = await waiting({ title: "Login da tela" });
    const onApp = await waiting({ title: "Menu do app", projectId: app.id });
    const onOther = await waiting({ title: "Login de outra", projectId: must(otherBoard).id });
    await task({ title: "Login sem espera", status: "todo" });
    const run = (filters: Parameters<typeof listIssues>[3]) =>
      listIssues(f.db, owner, f.org.id, { waitingForPerson: true, ...filters }).then((r) => r.map((i) => i.id).sort());
    expect(await run({ spaceId })).toEqual([onSite.id, onApp.id].sort());
    expect(await run({ projectId: site.id })).toEqual([onSite.id]);
    expect(await run({ projectId: app.id })).toEqual([onApp.id]);
    expect(await run({ q: "login" })).toEqual([onSite.id, onOther.id].sort());
    expect(await run({ spaceId, q: "login" })).toEqual([onSite.id]);
  });

  test("runs before the cap, so a crowd of other tasks cannot hide a waiting one", async () => {
    f = await setup();
    const { waiting, task, owner } = await scene();
    const old = await waiting({ updatedAt: ago(30) });
    const rows = Array.from({ length: 210 }, () => ({
      orgId: f.org.id,
      number: ++counter,
      title: "Recent",
      status: "in_progress" as const,
      createdByType: "person" as const,
      createdById: f.owner.id,
      updatedAt: ago(1),
    }));
    await f.db.insert(schema.issues).values(rows);
    await task({ status: "todo" });
    // Unfiltered, the 200 most recent tasks leave the old one out.
    const all = await listIssues(f.db, owner, f.org.id, {});
    expect(all.length).toBe(200);
    expect(all.some((i) => i.id === old.id)).toBe(false);
    // Filtered in the query, it is there.
    const got = await listIssues(f.db, owner, f.org.id, { waitingForPerson: true });
    expect(got.map((i) => i.id)).toEqual([old.id]);
  });
});
