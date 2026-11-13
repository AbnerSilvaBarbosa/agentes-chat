import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  companyDashboard,
  createIssue,
  createIssueColumn,
  createOrganization,
  NotFoundError,
  normalizeDays,
  updateIssue,
} from "../src";
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

describe("companyDashboard assignees", () => {
  const as = (type: "agent" | "person", id: string) => ({ assigneeType: type, assigneeId: id });

  test("lists each assignee with open and done tasks", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task({ status: "todo", ...as("agent", f.agent.id) });
    await task({ status: "in_review", ...as("agent", f.agent.id) });
    await task({ status: "done", moves: [["done", 4]], ...as("agent", f.agent.id) });
    await task({ status: "done", moves: [["done", 60]], ...as("agent", f.agent.id) });
    await task({ status: "canceled", ...as("agent", f.agent.id) });
    const d = await read();
    expect(d.assignees).toEqual([{ type: "agent", id: f.agent.id, name: f.agent.name, open: 2, done: 1 }]);
    expect(d.unassigned).toBe(0);
  });

  test("orders assignees by open tasks then name", async () => {
    f = await setup();
    const { task, read } = await scene();
    const ana = await addMember(f.db, f.org.id, "member", "Ana");
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    // The fixture agent is "Dev"; Ana and Dev tie on two, Caio has three.
    for (const [who, n] of [
      [as("person", caio.id), 3],
      [as("person", ana.id), 2],
      [as("agent", f.agent.id), 2],
    ] as const) {
      for (let i = 0; i < n; i++) await task({ status: "todo", ...who });
    }
    await task({ status: "todo" });
    const d = await read();
    expect(d.assignees.map((a) => [a.name, a.open])).toEqual([
      ["Caio", 3],
      ...[f.agent.name, "Ana"].sort().map((name) => [name, 2]),
    ]);
    expect(d.assignees.map((a) => a.type)).toContain("agent");
    expect(d.unassigned).toBe(1);
  });

  test("shows a missing assignee as removed with its counts", async () => {
    f = await setup();
    const { task, read } = await scene();
    const gone = crypto.randomUUID();
    await task({ status: "todo", ...as("agent", gone) });
    await task({ status: "done", moves: [["done", 2]], ...as("agent", gone) });
    expect((await read()).assignees).toEqual([{ type: "removed", id: gone, name: "", open: 1, done: 1 }]);
  });
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe("companyDashboard times", () => {
  /** A task made `made` days ago, started `start` days ago (null: never), concluded `end` days ago. */
  const finished = (made: number, start: number | null, end: number) => ({
    status: "done" as const,
    createdAt: ago(made),
    moves: [...(start === null ? [] : [["in_progress", start] as [Status, number]]), ["done", end] as [Status, number]],
  });

  test("lead time is measured from creation to conclusion", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task(finished(10, 9, 8)); // 2 days
    await task(finished(10, 9, 6)); // 4 days
    await task(finished(10, 9, 0)); // 10 days
    const d = await read();
    expect(d.leadTime).toEqual({ count: 3, medianMs: 4 * DAY, averageMs: (16 * DAY) / 3 });
  });

  test("work time is measured from the first Em andamento", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task(finished(20, 10, 8)); // 2 days of work
    await task(finished(20, 10, 6)); // 4 days
    const d = await read();
    expect(d.workTime).toEqual({ count: 2, medianMs: 3 * DAY, averageMs: 3 * DAY });
    // Concluded before the period's start, the first is not measured.
    expect((await read(7)).workTime).toEqual({ count: 1, medianMs: 4 * DAY, averageMs: 4 * DAY });
  });

  test("keeps a task that never started out of the work time", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task(finished(10, null, 5)); // lead 5 days
    await task(finished(10, 9, 5)); // lead 5 days, work 4
    const d = await read();
    expect(d.leadTime.count).toBe(2);
    expect(d.workTime).toEqual({ count: 1, medianMs: 4 * DAY, averageMs: 4 * DAY });
  });

  test("measures a reopened task to its last conclusion", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task({
      status: "done",
      createdAt: ago(20),
      moves: [
        ["in_progress", 15],
        ["done", 12],
        ["in_progress", 5],
        ["done", 2],
      ],
    });
    const d = await read();
    expect(d.leadTime.medianMs).toBe(18 * DAY);
    expect(d.workTime.medianMs).toBe(13 * DAY);
  });

  test("counts a task concluded by a column move like one concluded by a status change", async () => {
    f = await setup();
    const { board, spaceId } = await scene();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = { type: "person" as const, userId: f.owner.id };
    const columns = await createIssueColumn(deps, f.owner.id, f.org.id, { name: "Entregue", stage: "done" });
    const entregue = columns.find((c) => c.name === "Entregue")?.id as string;
    const a = await createIssue(deps, ana, f.org.id, { title: "By column", projectId: board?.id });
    const b = await createIssue(deps, ana, f.org.id, { title: "By status", projectId: board?.id });
    await updateIssue(deps, ana, f.org.id, a.id, { columnId: entregue });
    await updateIssue(deps, ana, f.org.id, b.id, { status: "done" });
    const d = await companyDashboard(f.db, f.owner.id, f.org.id, spaceId, 7);
    expect(d.stages.done).toBe(2);
    expect(d.leadTime.count).toBe(2);
  });

  test("gives null times when no task was concluded", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task({ status: "todo" });
    const d = await read();
    expect(d.leadTime).toEqual({ count: 0, medianMs: null, averageMs: null });
    expect(d.workTime).toEqual({ count: 0, medianMs: null, averageMs: null });
  });
});
