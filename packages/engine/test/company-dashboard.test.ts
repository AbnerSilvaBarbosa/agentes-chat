import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { companyDashboard, createOrganization, NotFoundError, normalizeDays } from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** Noon on a Wednesday, so a week's Monday is two days back. */
const NOW = new Date("2026-11-11T12:00:00Z");
const ago = (days: number, from: Date = NOW) => new Date(from.getTime() - days * 86_400_000);

type Status = "todo" | "in_progress" | "in_review" | "done" | "canceled";

let counter = 0;

/** A company with one board; `task` puts a task on it (or on another board) with the events that tell its story. */
async function scene() {
  const [space] = await f.db.insert(schema.issueSpaces).values({ orgId: f.org.id, name: "Clínica Teo" }).returning();
  const [board] = await f.db
    .insert(schema.issueProjects)
    .values({ orgId: f.org.id, name: "Entregas", spaceId: space?.id })
    .returning();
  const spaceId = space?.id as string;

  async function task(
    input: Partial<typeof schema.issues.$inferInsert> & {
      /** `[status, daysAgo]` moves, oldest first, written as `status_changed` events. */
      moves?: [Status, number][];
      projectId?: string | null;
    } = {},
  ) {
    const { moves, ...values } = input;
    const [row] = await f.db
      .insert(schema.issues)
      .values({
        orgId: f.org.id,
        number: ++counter,
        title: `Task ${counter}`,
        projectId: board?.id,
        createdByType: "person",
        createdById: f.owner.id,
        createdAt: ago(40),
        ...values,
      })
      .returning();
    for (const [to, daysAgo] of moves ?? []) {
      await f.db.insert(schema.issueActivity).values({
        orgId: f.org.id,
        issueId: row?.id as string,
        kind: "event",
        authorType: "person",
        authorId: f.owner.id,
        text: `changed the status to ${to}`,
        event: "status_changed",
        data: { to },
        createdAt: ago(daysAgo),
      });
    }
    return row as typeof schema.issues.$inferSelect;
  }
  const read = (days: unknown = 30, userId: string = f.owner.id) =>
    companyDashboard(f.db, userId, f.org.id, spaceId, days, NOW);
  return { spaceId, board, task, read };
}

describe("companyDashboard stages", () => {
  test("counts the open tasks by stage and the done in the period", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task({ status: "todo" });
    await task({ status: "todo" });
    await task({ status: "in_progress" });
    await task({ status: "in_review" });
    await task({ status: "done", moves: [["done", 3]] });
    await task({ status: "done", moves: [["done", 50]] });
    const d = await read();
    expect(d.days).toBe(30);
    expect(d.stages).toEqual({ todo: 2, in_progress: 1, in_review: 1, done: 1 });
    expect((await read(90)).stages.done).toBe(2);
  });

  test("counts a task in the stage of its status whatever its column", async () => {
    f = await setup();
    const { task, read } = await scene();
    const [column] = await f.db
      .insert(schema.issueColumns)
      .values({ orgId: f.org.id, stage: "todo", name: "Backlog", position: 0 })
      .returning();
    await task({ status: "in_progress", columnId: column?.id });
    await task({ status: "in_review", columnId: null });
    expect((await read()).stages).toMatchObject({ todo: 0, in_progress: 1, in_review: 1 });
  });

  test("leaves canceled tasks out of every count", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task({
      status: "canceled",
      moves: [
        ["done", 2],
        ["canceled", 1],
      ],
    });
    await task({ status: "todo" });
    expect((await read()).stages).toEqual({ todo: 1, in_progress: 0, in_review: 0, done: 0 });
  });

  test("counts only the tasks the viewer may see", async () => {
    f = await setup();
    const { task, read } = await scene();
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    await task({ status: "todo" });
    await task({ status: "todo", restricted: true, audienceUserIds: [f.owner.id] });
    await task({ status: "todo", restricted: true, audienceUserIds: [member.id] });
    expect((await read(30, member.id)).stages.todo).toBe(2);
    expect((await read(30, f.owner.id)).stages.todo).toBe(3);
  });

  test("normalizeDays answers 30 for any other value", () => {
    expect([7, 30, 90].map(normalizeDays)).toEqual([7, 30, 90]);
    expect(["7", "90"].map(normalizeDays)).toEqual([7, 90]);
    for (const other of [0, 1, 14, 365, -7, "x", null, undefined, 7.5]) expect(normalizeDays(other)).toBe(30);
  });

  test("a space of another workspace is not found", async () => {
    f = await setup();
    const { spaceId } = await scene();
    const other = await addUser(f.db, "Out");
    const { organization } = await createOrganization(f.db, other.id, { name: "Other" });
    await expect(companyDashboard(f.db, other.id, organization.id, spaceId, 30, NOW)).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
