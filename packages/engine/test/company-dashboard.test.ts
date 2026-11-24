import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema, sql } from "@agenteschat/db";
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
      /** Who has it (its first assignee, ADR 0188); left out: nobody. */
      assignedTo?: { type: "agent" | "person"; id: string };
    } = {},
  ) {
    const { moves, assignedTo, ...values } = input;
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
    if (assignedTo && row) {
      await f.db.insert(schema.issueAssignees).values({
        orgId: f.org.id,
        issueId: row.id,
        assigneeType: assignedTo.type,
        assigneeId: assignedTo.id,
        position: 0,
      });
    }
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
    await task({ status: "canceled" });
    const d = await read();
    expect(d.days).toBe(30);
    // Every task of the company, whatever the period (the canceled ones never count).
    expect(d.total).toBe(6);
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
  const as = (type: "agent" | "person", id: string) => ({ assignedTo: { type, id } });

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
    const eva = await addMember(f.db, f.org.id, "member", "Éva");
    // The fixture agent is "Dev"; "ana" (lower case), Dev and Éva tie on two, Caio has three: the tie reads in the
    // language's order (accents and capitals do not jump the queue), not by code unit.
    await f.db.update(schema.users).set({ name: "ana" }).where(eq(schema.users.id, ana.id));
    for (const [who, n] of [
      [as("person", caio.id), 3],
      [as("person", ana.id), 2],
      [as("person", eva.id), 2],
      [as("agent", f.agent.id), 2],
    ] as const) {
      for (let i = 0; i < n; i++) await task({ status: "todo", ...who });
    }
    await task({ status: "todo" });
    const d = await read();
    expect(d.assignees.map((a) => [a.name, a.open])).toEqual([
      ["Caio", 3],
      ["ana", 2],
      ["Dev", 2],
      ["Éva", 2],
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

describe("companyDashboard weeks, late and unassigned", () => {
  const doneAt = (at: Date) => ({
    status: "done" as const,
    moves: [["done", (NOW.getTime() - at.getTime()) / DAY] as [Status, number]],
  });

  test("has one entry per week of the period", async () => {
    f = await setup();
    const { read } = await scene();
    // 2026-11-11 is a Wednesday: 7 days back starts on a Wednesday, so two Mondays.
    expect((await read(7)).weekly.map((w) => w.weekStart)).toEqual(["2026-11-02", "2026-11-09"]);
    const month = (await read(30)).weekly.map((w) => w.weekStart);
    expect(month).toEqual(["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"]);
    const quarter = (await read(90)).weekly;
    expect(quarter).toHaveLength(14);
    expect(quarter[0]?.weekStart).toBe("2026-08-10");
    expect(quarter.at(-1)?.weekStart).toBe("2026-11-09");
  });

  test("keeps a week with no delivery as zero", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task(doneAt(new Date("2026-11-10T09:00:00Z"))); // Tuesday of this week
    await task(doneAt(new Date("2026-11-10T10:00:00Z")));
    await task(doneAt(new Date("2026-10-20T09:00:00Z"))); // the week of 10-19
    const d = await read();
    expect(d.weekly).toEqual([
      { weekStart: "2026-10-12", count: 0 },
      { weekStart: "2026-10-19", count: 1 },
      { weekStart: "2026-10-26", count: 0 },
      { weekStart: "2026-11-02", count: 0 },
      { weekStart: "2026-11-09", count: 2 },
    ]);
    expect(d.weekly.reduce((n, w) => n + w.count, 0)).toBe(d.stages.done);
  });

  test("weeks and today follow the workspace's time zone", async () => {
    f = await setup();
    const { task, read } = await scene();
    await f.db
      .insert(schema.organizationSettings)
      .values({ orgId: f.org.id, timezone: "America/Sao_Paulo" })
      .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { timezone: "America/Sao_Paulo" } });
    // Monday 01:00 UTC is still Sunday night in São Paulo: last week's bar.
    await task(doneAt(new Date("2026-11-09T01:00:00Z")));
    // Due on the 10th, 02:00 UTC on the 11th is still the 10th there: not yet past.
    await task({ status: "todo", dueDate: "2026-11-10" });
    const d = await companyDashboard(
      f.db,
      f.owner.id,
      f.org.id,
      (await f.db.select().from(schema.issueSpaces))[0]?.id as string,
      30,
      new Date("2026-11-11T02:00:00Z"),
    );
    expect(d.weekly.find((w) => w.weekStart === "2026-11-02")?.count).toBe(1);
    expect(d.weekly.find((w) => w.weekStart === "2026-11-09")?.count).toBe(0);
    expect(d.late).toBe(0);
    expect((await read()).late).toBe(1);
  });

  test("counts the open tasks due before today", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task({ status: "todo", dueDate: "2026-11-10" });
    await task({ status: "in_progress", dueDate: "2026-09-01" });
    await task({ status: "todo", dueDate: "2026-11-11" }); // today is not late
    await task({ status: "todo", dueDate: "2026-11-30" });
    await task({ status: "todo" });
    await task({ status: "done", dueDate: "2026-11-01", moves: [["done", 2]] });
    await task({ status: "canceled", dueDate: "2026-11-01" });
    expect((await read()).late).toBe(2);
  });

  test("counts the open tasks with no assignee", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task({ status: "todo" });
    await task({ status: "in_review" });
    await task({ status: "todo", ...as("agent", f.agent.id) });
    await task({ status: "done", moves: [["done", 2]] });
    await task({ status: "canceled" });
    expect((await read()).unassigned).toBe(2);
  });

  test("late and unassigned ignore the period", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task({ status: "todo", dueDate: "2025-01-01", createdAt: ago(300) });
    const [d7, d90] = [await read(7), await read(90)];
    expect([d7.late, d7.unassigned]).toEqual([1, 1]);
    expect([d90.late, d90.unassigned]).toEqual([1, 1]);
  });

  test("counts a task for the company it is in now", async () => {
    f = await setup();
    const { task, read, board } = await scene();
    const [other] = await f.db.insert(schema.issueSpaces).values({ orgId: f.org.id, name: "Outra" }).returning();
    const [elsewhere] = await f.db
      .insert(schema.issueProjects)
      .values({ orgId: f.org.id, name: "Fora", spaceId: other?.id })
      .returning();
    const moved = await task({ ...doneAt(ago(2)), projectId: elsewhere?.id });
    const stays = await task(doneAt(ago(2)));
    expect((await read()).stages.done).toBe(1);
    // The board changes company after the conclusion: the task counts where it is now.
    await f.db.update(schema.issues).set({ projectId: board?.id }).where(eq(schema.issues.id, moved.id));
    await f.db
      .update(schema.issueProjects)
      .set({ spaceId: other?.id })
      .where(eq(schema.issueProjects.id, board?.id as string));
    expect((await read()).stages.done).toBe(0);
    // The company the board moved to counts both tasks, the one concluded in another company included.
    const there = await companyDashboard(f.db, f.owner.id, f.org.id, other?.id as string, 30, NOW);
    expect(there.stages.done).toBe(2);
    expect(there.total).toBe(2);
    expect(stays.id).not.toBe(moved.id);
  });

  test("counts a task concluded a minute ago in every period", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task(doneAt(new Date(NOW.getTime() - 60_000)));
    for (const days of [7, 30, 90]) {
      const d = await read(days);
      expect(d.stages.done).toBe(1);
      expect(d.weekly.at(-1)).toEqual({ weekStart: "2026-11-09", count: 1 });
    }
  });
});

describe("companyDashboard cost", () => {
  /** A run of `agentId` on `issueId`, started `daysAgo`, with usage rows costing `usd` each. */
  async function run(issueId: string | null, agentId: string, daysAgo: number, ...usd: number[]) {
    const gone = crypto.randomUUID();
    const [r] = await f.db
      .insert(schema.agentRuns)
      .values({
        orgId: f.org.id,
        agentId,
        channelId: f.general.id,
        threadRootId: gone,
        triggerMessageId: gone,
        trigger: "mention",
        hop: 1,
        issueId,
        createdAt: ago(daysAgo),
      })
      .returning();
    for (const n of usd) {
      await f.db.insert(schema.usageRecords).values({
        orgId: f.org.id,
        agentId,
        runId: r?.id,
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        requestedModel: "claude-sonnet-5-5",
        inputTokens: 1,
        outputTokens: 1,
        costNanoUsd: n * 1e9,
        createdAt: ago(daysAgo),
      });
    }
  }

  test("sums the cost of the runs tied to the company's tasks", async () => {
    f = await setup();
    const { task, read } = await scene();
    const other = await f.db
      .insert(schema.agents)
      .values({ orgId: f.org.id, name: "Bruno", handle: "bruno", instructions: "x", model: "claude-sonnet-5-5" })
      .returning();
    const a = await task({ status: "in_progress" });
    const b = await task({ status: "todo" });
    await run(a.id, f.agent.id, 2, 1.5, 0.5);
    await run(b.id, f.agent.id, 3, 1);
    await run(a.id, other[0]?.id as string, 1, 5);
    // Not tied to a task of the company, or to no task.
    await run(null, f.agent.id, 1, 100);
    const d = await read();
    expect(d.cost?.totalUsd).toBeCloseTo(8, 6);
    expect(d.cost?.byAgent.map((x) => [x.name, x.usd])).toEqual([
      ["Bruno", 5],
      [f.agent.name, 3],
    ]);
  });

  test("counts a run in the period it started in", async () => {
    f = await setup();
    const { task, read } = await scene();
    const a = await task({ status: "in_progress" });
    await run(a.id, f.agent.id, 3, 2);
    await run(a.id, f.agent.id, 20, 7);
    expect((await read(7)).cost?.totalUsd).toBe(2);
    expect((await read(30)).cost?.totalUsd).toBe(9);
  });

  test("gives zero with no run", async () => {
    f = await setup();
    const { task, read } = await scene();
    await task({ status: "todo" });
    expect((await read()).cost).toEqual({ totalUsd: 0, byAgent: [] });
  });

  test("gives no cost to a member who may not view usage", async () => {
    f = await setup();
    const { task, read } = await scene();
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    const a = await task({ status: "in_progress" });
    await run(a.id, f.agent.id, 1, 4);
    expect((await read(30, member.id)).cost).toBeNull();
    expect((await read(30, f.owner.id)).cost?.totalUsd).toBe(4);
  });
});

describe("companyDashboard size", () => {
  test("computes 1000 tasks in under a second", async () => {
    f = await setup();
    const { board, spaceId } = await scene();
    const statuses = ["todo", "in_progress", "in_review", "done", "done"] as const;
    const tasks = Array.from({ length: 1000 }, (_, i) => ({
      id: crypto.randomUUID(),
      orgId: f.org.id,
      number: 100_000 + i,
      title: `Bulk ${i}`,
      status: statuses[i % statuses.length] as (typeof statuses)[number],
      projectId: board?.id,
      dueDate: i % 7 === 0 ? "2026-10-01" : null,
      createdByType: "person",
      createdById: f.owner.id,
      createdAt: ago(60 + (i % 20)),
    }));
    await f.db.insert(schema.issues).values(tasks);
    await f.db.insert(schema.issueAssignees).values(
      tasks
        .filter((_, i) => i % 3 !== 0)
        .map((t) => ({
          orgId: f.org.id,
          issueId: t.id,
          assigneeType: "agent",
          assigneeId: f.agent.id,
          position: 0,
        })),
    );
    const events = tasks.flatMap((t, i) => [
      {
        orgId: f.org.id,
        issueId: t.id,
        kind: "event",
        authorType: "person",
        authorId: f.owner.id,
        text: "start",
        event: "status_changed",
        data: { to: "in_progress" },
        createdAt: ago(40 - (i % 20)),
      },
      ...(t.status === "done"
        ? [
            {
              orgId: f.org.id,
              issueId: t.id,
              kind: "event",
              authorType: "person",
              authorId: f.owner.id,
              text: "done",
              event: "status_changed",
              data: { to: "done" },
              createdAt: ago(i % 25),
            },
          ]
        : []),
    ]);
    await f.db.insert(schema.issueActivity).values(events);
    const runs = tasks.slice(0, 300).map((t) => ({
      id: crypto.randomUUID(),
      status: "done" as const,
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: t.id,
      triggerMessageId: t.id,
      trigger: "mention" as const,
      hop: 1,
      issueId: t.id,
      createdAt: ago(5),
    }));
    await f.db.insert(schema.agentRuns).values(runs);
    await f.db.insert(schema.usageRecords).values(
      runs.map((r) => ({
        orgId: f.org.id,
        agentId: f.agent.id,
        runId: r.id,
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        requestedModel: "claude-sonnet-5-5",
        inputTokens: 1,
        outputTokens: 1,
        costNanoUsd: 1_000_000,
        createdAt: ago(5),
      })),
    );
    await companyDashboard(f.db, f.owner.id, f.org.id, spaceId, 30, NOW); // warm the plan
    const started = performance.now();
    const d = await companyDashboard(f.db, f.owner.id, f.org.id, spaceId, 90, NOW);
    const took = performance.now() - started;
    expect(d.stages.todo + d.stages.in_progress + d.stages.in_review).toBe(600);
    expect(d.cost?.byAgent).toHaveLength(1);
    expect(took).toBeLessThan(1000);
  });
});

/** A run of `agentId` on `issueId` started at `at`, with one usage row costing `usd`. */
async function addRun(issueId: string, agentId: string, at: Date, usd: number) {
  const id = crypto.randomUUID();
  const [r] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId,
      channelId: f.general.id,
      threadRootId: id,
      triggerMessageId: id,
      trigger: "mention",
      hop: 1,
      issueId,
      createdAt: at,
    })
    .returning();
  await f.db.insert(schema.usageRecords).values({
    orgId: f.org.id,
    agentId,
    runId: r?.id,
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    requestedModel: "claude-sonnet-5-5",
    inputTokens: 1,
    outputTokens: 1,
    costNanoUsd: usd * 1e9,
    createdAt: at,
  });
}

const as = (type: "agent" | "person", id: string) => ({ assignedTo: { type, id } });
const EMPTY_SPAN = { count: 0, medianMs: null, averageMs: null };

describe("companyDashboard review", () => {
  test("leaves a task hidden from the viewer out of every number", async () => {
    f = await setup();
    const { task, read } = await scene();
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    // Bia may view usage, so the cost is computed for her and must not carry what she cannot see.
    await f.db
      .update(schema.orgRoles)
      .set({ permissions: sql`array_append(${schema.orgRoles.permissions}, 'view_usage')` })
      .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
    const hiddenTo = { restricted: true, audienceUserIds: [f.owner.id] };
    const visible = await task({ status: "todo" });
    // Open, assigned, late, with a run.
    const open = await task({ status: "in_progress", dueDate: "2026-10-01", ...hiddenTo, ...as("agent", f.agent.id) });
    // Done in the period, assigned to a person, started, with a run.
    const done = await task({
      status: "done",
      createdAt: ago(10),
      moves: [
        ["in_progress", 9],
        ["done", 2],
      ],
      ...hiddenTo,
      ...as("person", f.owner.id),
    });
    await addRun(open.id, f.agent.id, ago(1), 10);
    await addRun(done.id, f.agent.id, ago(1), 10);
    await addRun(visible.id, f.agent.id, ago(1), 0.5);

    const seen = await read(30, member.id);
    expect(seen.total).toBe(1);
    expect(seen.stages).toEqual({ todo: 1, in_progress: 0, in_review: 0, done: 0 });
    expect(seen.assignees).toEqual([]);
    expect(seen.unassigned).toBe(1);
    expect(seen.late).toBe(0);
    expect(seen.leadTime).toEqual(EMPTY_SPAN);
    expect(seen.workTime).toEqual(EMPTY_SPAN);
    expect(seen.weekly.every((w) => w.count === 0)).toBe(true);
    expect(seen.cost).toEqual({ totalUsd: 0.5, byAgent: [{ agentId: f.agent.id, name: f.agent.name, usd: 0.5 }] });
    // The administrator sees all three, so the same rows are there to be hidden.
    const all = await read(30, f.owner.id);
    expect([all.total, all.late, all.stages.done, all.cost?.totalUsd]).toEqual([3, 1, 1, 20.5]);
  });

  test("keeps the cost of the runs of canceled tasks, which no count includes", async () => {
    f = await setup();
    const { task, read } = await scene();
    const canceled = await task({ status: "canceled", ...as("agent", f.agent.id) });
    const open = await task({ status: "todo" });
    await addRun(canceled.id, f.agent.id, ago(1), 20);
    await addRun(open.id, f.agent.id, ago(1), 1);
    const d = await read();
    expect(d.cost?.totalUsd).toBe(21);
    expect(d.total).toBe(1);
    expect(d.assignees).toEqual([]);
  });

  test("a company whose tasks are all canceled or hidden has a total of zero", async () => {
    f = await setup();
    const { task, read } = await scene();
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    await task({ status: "canceled" });
    await task({ status: "todo", restricted: true, audienceUserIds: [f.owner.id] });
    expect((await read(30, member.id)).total).toBe(0);
    expect((await read(30, f.owner.id)).total).toBe(1);
  });

  test("counts the tasks of an archived board and of an archived company", async () => {
    f = await setup();
    const { task, read, board, spaceId } = await scene();
    await task({ status: "todo", ...as("agent", f.agent.id) });
    await task(finishedAt(2));
    await f.db
      .update(schema.issueProjects)
      .set({ archivedAt: NOW })
      .where(eq(schema.issueProjects.id, board?.id as string));
    await f.db.update(schema.issueSpaces).set({ archivedAt: NOW }).where(eq(schema.issueSpaces.id, spaceId));
    const d = await read();
    expect(d.total).toBe(2);
    expect(d.stages).toEqual({ todo: 1, in_progress: 0, in_review: 0, done: 1 });
    expect(d.assignees).toEqual([{ type: "agent", id: f.agent.id, name: f.agent.name, open: 1, done: 0 }]);
  });

  test("lists a person who left the workspace as removed, and drops an assignee with no count", async () => {
    f = await setup();
    const { task, read } = await scene();
    const left = await addUser(f.db, "Saiu");
    const idle = await addMember(f.db, f.org.id, "member", "Parado");
    await task({ status: "todo", ...as("person", left.id) });
    // Concluded before the period and nothing open: no row.
    await task({ ...finishedAt(50), ...as("person", idle.id) });
    const d = await read();
    expect(d.assignees).toEqual([{ type: "removed", id: left.id, name: "", open: 1, done: 0 }]);
  });

  test("measures the period at exactly 7, 30 and 90 days for deliveries and runs", async () => {
    f = await setup();
    const { task, read } = await scene();
    const open = await task({ status: "todo" });
    for (const days of [7, 30, 90]) {
      const edge = ago(days);
      const justBefore = new Date(edge.getTime() - 1);
      await task({ ...finishedAt(days) });
      await task({ status: "done", moves: [["done", (NOW.getTime() - justBefore.getTime()) / DAY]] });
      await addRun(open.id, f.agent.id, edge, days);
      await addRun(open.id, f.agent.id, justBefore, 1000);
    }
    // Exactly N days back is in, a millisecond older is out. A period also holds the shorter ones' edges, and a
    // millisecond past the 7 day edge is still inside 30 (and so on): 1, 3 and 5 deliveries; 7, 7+1000+30 and
    // 7+1000+30+1000+90 dollars.
    expect((await read(7)).stages.done).toBe(1);
    expect((await read(30)).stages.done).toBe(3);
    expect((await read(90)).stages.done).toBe(5);
    expect((await read(7)).cost?.totalUsd).toBe(7);
    expect((await read(30)).cost?.totalUsd).toBe(1037);
    expect((await read(90)).cost?.totalUsd).toBe(2127);
  });
});

/** A task concluded `days` before now, exactly. */
const finishedAt = (days: number) => ({ status: "done" as const, moves: [["done", days]] as [Status, number][] });
