import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { companyDashboard, deleteIssueColumn, factoryHome, updateIssue } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** Noon on a Wednesday. */
const NOW = new Date("2026-11-11T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing");
  return v;
};

type Status = "todo" | "in_progress" | "in_review" | "done" | "canceled";
let counter = 0;

/** Makes a company with one board, and puts tasks on any board; `moves` write the `status_changed` events. */
async function company(name: string) {
  const [space] = await f.db.insert(schema.issueSpaces).values({ orgId: f.org.id, name }).returning();
  const spaceId = must(space).id;
  const board = async (boardName = "Entregas") => {
    const [row] = await f.db
      .insert(schema.issueProjects)
      .values({ orgId: f.org.id, name: boardName, spaceId })
      .returning();
    return must(row);
  };
  const first = await board();
  async function task(
    input: Partial<typeof schema.issues.$inferInsert> & { status?: Status; moves?: [Status, number][] } = {},
  ) {
    const { moves, ...values } = input;
    const [row] = await f.db
      .insert(schema.issues)
      .values({
        orgId: f.org.id,
        number: ++counter,
        title: `Task ${counter}`,
        projectId: first.id,
        createdByType: "person",
        createdById: f.owner.id,
        createdAt: ago(40),
        ...values,
      })
      .returning();
    for (const [to, daysAgo] of moves ?? []) {
      await f.db.insert(schema.issueActivity).values({
        orgId: f.org.id,
        issueId: must(row).id,
        kind: "event",
        authorType: "person",
        authorId: f.owner.id,
        text: `changed the status to ${to}`,
        event: "status_changed",
        data: { to },
        createdAt: ago(daysAgo),
      });
    }
    return must(row);
  }
  return { spaceId, board, first, task };
}

/** A column that waits for a person, in the review stage: the workspace's, or a board's own with `projectId`. */
const flagged = async ({
  name = "Teste humano",
  projectId = null,
  waitsForPerson = true,
}: {
  name?: string;
  projectId?: string | null;
  waitsForPerson?: boolean;
} = {}) => {
  const [col] = await f.db
    .insert(schema.issueColumns)
    .values({ orgId: f.org.id, projectId, stage: "in_review", name, position: 5, waitsForPerson })
    .returning();
  return must(col);
};

const read = (userId: string = f.owner.id) => factoryHome(f.db, userId, f.org.id, NOW);

describe("factoryHome panels", () => {
  test("makes one panel per company with a live task the viewer sees", async () => {
    f = await setup();
    const a = await company("Alfa");
    const b = await company("Beta");
    await company("Vazia");
    const hidden = await company("Oculta");
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    await a.task({ status: "todo" });
    await b.task({ status: "in_progress" });
    // A company whose only task the viewer may not see makes no panel for them.
    await hidden.task({ status: "todo", restricted: true, audienceUserIds: [f.owner.id] });

    const asMember = await read(member.id);
    expect(asMember.companies.map((c) => c.name)).toEqual(["Alfa", "Beta"]);
    expect(asMember.companiesTotal).toBe(2);
    const asOwner = await read();
    expect(asOwner.companies.map((c) => c.name).sort()).toEqual(["Alfa", "Beta", "Oculta"]);
  });

  test("a workspace with no live task gives no company", async () => {
    f = await setup();
    const a = await company("Alfa");
    await a.task({ status: "canceled" });
    expect(await read()).toEqual({ companies: [], companiesTotal: 0, waiting: { total: 0, items: [] } });
  });

  test("counts a company's open tasks by stage and its done in the last 7 days", async () => {
    f = await setup();
    const a = await company("Alfa");
    await f.db
      .update(schema.issueSpaces)
      .set({ color: "red", image: "abc.png" })
      .where(eq(schema.issueSpaces.id, a.spaceId));
    await a.task({ status: "todo" });
    await a.task({ status: "todo" });
    await a.task({ status: "in_progress" });
    await a.task({ status: "in_review" });
    await a.task({ status: "in_review" });
    await a.task({ status: "in_review" });
    await a.task({ status: "done", moves: [["done", 3]] });
    await a.task({ status: "done", moves: [["done", 6]] });
    // Concluded before the week: not counted.
    await a.task({ status: "done", moves: [["done", 10]] });
    const [panel] = (await read()).companies;
    expect(panel).toEqual({
      id: a.spaceId,
      name: "Alfa",
      color: "red",
      image: `/api/app/organizations/${encodeURIComponent(f.org.id)}/issue-space-images/abc.png`,
      stages: { todo: 2, in_progress: 1, in_review: 3, done: 2 },
      late: 0,
      waiting: 0,
    });
  });

  test("matches the Painel's stage counts for the same viewer", async () => {
    f = await setup();
    const a = await company("Alfa");
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    await a.task({ status: "todo" });
    await a.task({ status: "in_progress", moves: [["in_progress", 5]] });
    await a.task({ status: "in_review" });
    await a.task({
      status: "done",
      moves: [
        ["in_progress", 5],
        ["done", 2],
      ],
    });
    await a.task({ status: "done", moves: [["done", 20]] });
    await a.task({ status: "canceled" });
    await a.task({ status: "todo", restricted: true, audienceUserIds: [f.owner.id] });
    for (const viewer of [f.owner.id, member.id]) {
      const painel = await companyDashboard(f.db, viewer, f.org.id, a.spaceId, 7, NOW);
      const [panel] = (await read(viewer)).companies;
      expect(panel?.stages).toEqual(painel.stages);
      expect(panel?.late).toBe(painel.late);
    }
  });

  test("counts the late tasks and the tasks waiting for a person per company", async () => {
    f = await setup();
    const a = await company("Alfa");
    const b = await company("Beta");
    const [col] = await f.db
      .insert(schema.issueColumns)
      .values({ orgId: f.org.id, stage: "in_review", name: "Teste humano", position: 5, waitsForPerson: true })
      .returning();
    // Due before today (Nov 11): late when open; today and later are not; a done task is never late.
    await a.task({ status: "todo", dueDate: "2026-11-10" });
    await a.task({ status: "in_progress", dueDate: "2026-11-01" });
    await a.task({ status: "todo", dueDate: "2026-11-11" });
    await a.task({ status: "todo", dueDate: "2026-11-30" });
    await a.task({ status: "done", dueDate: "2026-10-01", moves: [["done", 2]] });
    await a.task({ status: "in_review", columnId: must(col).id });
    await a.task({ status: "in_review", columnId: must(col).id });
    // Beta's board has its own, unflagged set while the workspace's "Teste humano" is flagged: nothing of Beta waits.
    await flagged({ name: "Revisão", projectId: b.first.id, waitsForPerson: false });
    await b.task({ status: "in_review", dueDate: "2026-11-09" });
    const byName = new Map((await read()).companies.map((c) => [c.name, c]));
    expect(byName.get("Alfa")?.late).toBe(2);
    expect(byName.get("Alfa")?.waiting).toBe(2);
    expect(byName.get("Beta")?.late).toBe(1);
    expect(byName.get("Beta")?.waiting).toBe(0);
  });

  test("orders the panels by tasks waiting then by name", async () => {
    f = await setup();
    const names = ["Zeta", "alfa", "Beta", "Gama"];
    const spaces = new Map<string, Awaited<ReturnType<typeof company>>>();
    for (const n of names) spaces.set(n, await company(n));
    const [col] = await f.db
      .insert(schema.issueColumns)
      .values({ orgId: f.org.id, stage: "in_review", name: "Teste humano", position: 5, waitsForPerson: true })
      .returning();
    const waits = { status: "in_review" as const, columnId: must(col).id };
    await must(spaces.get("Zeta")).task(waits);
    await must(spaces.get("Zeta")).task(waits);
    await must(spaces.get("Gama")).task(waits);
    await must(spaces.get("alfa")).task({ status: "todo" });
    await must(spaces.get("Beta")).task({ status: "todo" });
    expect((await read()).companies.map((c) => c.name)).toEqual(["Zeta", "Gama", "alfa", "Beta"]);
  });

  test("counts only the tasks the viewer may see", async () => {
    f = await setup();
    const a = await company("Alfa");
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    await a.task({ status: "todo" });
    await a.task({ status: "todo", restricted: true, audienceUserIds: [f.owner.id] });
    await a.task({ status: "todo", restricted: true, audienceUserIds: [member.id] });
    expect(must((await read(member.id)).companies[0]).stages.todo).toBe(2);
    expect(must((await read()).companies[0]).stages.todo).toBe(3);
  });

  test("leaves canceled tasks archived boards and archived companies out of every number", async () => {
    f = await setup();
    const a = await company("Alfa");
    const archivedBoard = await a.board("Antigo");
    const gone = await company("Arquivada");
    await a.task({ status: "todo" });
    await a.task({ status: "canceled" });
    await a.task({ status: "todo", projectId: archivedBoard.id });
    await a.task({ status: "done", projectId: archivedBoard.id, moves: [["done", 1]] });
    await gone.task({ status: "todo" });
    await f.db
      .update(schema.issueProjects)
      .set({ archivedAt: NOW })
      .where(eq(schema.issueProjects.id, archivedBoard.id));
    await f.db.update(schema.issueSpaces).set({ archivedAt: NOW }).where(eq(schema.issueSpaces.id, gone.spaceId));
    const home = await read();
    expect(home.companies.map((c) => c.name)).toEqual(["Alfa"]);
    expect(home.companiesTotal).toBe(1);
    expect(must(home.companies[0]).stages).toEqual({ todo: 1, in_progress: 0, in_review: 0, done: 0 });
  });

  test("shows the first 20 companies and says how many there are", async () => {
    f = await setup();
    const col = await flagged();
    for (let i = 0; i < 23; i++) {
      const c = await company(`Empresa ${String(i).padStart(2, "0")}`);
      await c.task({ status: "todo" });
    }
    // The last by name waits for a person: the order comes before the cap of 20.
    const last = await company("Zzz Última");
    await last.task({ status: "in_review", columnId: col.id });
    const home = await read();
    expect(home.companies.length).toBe(20);
    expect(home.companiesTotal).toBe(24);
    expect(home.companies[0]?.name).toBe("Zzz Última");
    expect(home.companies[1]?.name).toBe("Empresa 00");
    expect(home.companies[19]?.name).toBe("Empresa 18");
  });

  test("a board with its own unflagged set does not wait while the workspace's set is flagged", async () => {
    f = await setup();
    const a = await company("Alfa");
    const own = await a.board("Próprio");
    const col = await flagged();
    // The board has its own set: a review column that does not wait, and no "Teste humano".
    const ownReview = await flagged({ name: "Revisão", projectId: own.id, waitsForPerson: false });
    const follows = await a.task({ status: "in_review", columnId: col.id });
    await a.task({ status: "in_review", projectId: own.id });
    await a.task({ status: "in_review", projectId: own.id, columnId: ownReview.id });
    const home = await read();
    expect(home.waiting.total).toBe(1);
    expect(home.waiting.items.map((i) => i.id)).toEqual([follows.id]);
    expect(must(home.companies[0]).waiting).toBe(1);
  });
});

describe("factoryHome waiting list", () => {
  const waits = (columnId: string, daysAgo: number) => ({
    status: "in_review" as const,
    columnId,
    columnSince: ago(daysAgo),
  });

  test("lists the tasks in flagged columns longest waiting first", async () => {
    f = await setup();
    const a = await company("Alfa");
    const b = await company("Beta");
    const col = await flagged();
    const fresh = await a.task({ title: "Recente", ...waits(col.id, 1) });
    const oldest = await b.task({ title: "Antiga", ...waits(col.id, 9) });
    const middle = await a.task({ title: "Meio", ...waits(col.id, 4) });
    // Same moment: the lower number first.
    const tieB = await a.task({ title: "Empate B", ...waits(col.id, 2) });
    const tieA = await b.task({ title: "Empate A", ...waits(col.id, 2) });
    await a.task({ title: "Fora", status: "in_progress" });
    const { waiting } = await read();
    expect(waiting.total).toBe(5);
    expect(waiting.items.map((i) => i.id)).toEqual([oldest.id, middle.id, tieB.id, tieA.id, fresh.id]);
    expect(waiting.items[0]).toEqual({
      id: oldest.id,
      number: oldest.number,
      title: "Antiga",
      stage: "in_review",
      spaceId: b.spaceId,
      spaceName: "Beta",
      projectId: b.first.id,
      projectName: "Entregas",
      columnName: "Teste humano",
      since: ago(9).toISOString(),
    });
  });

  test("reports since from the last status change or column move", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const a = await company("Alfa");
    const col = await flagged();
    const other = await flagged({ name: "Aprovação" });
    const task = await a.task({ title: "Tela", ...waits(col.id, 9) });
    const sinceOf = async () => must((await read()).waiting.items.find((i) => i.id === task.id)).since;
    expect(await sinceOf()).toBe(ago(9).toISOString());

    // A comment, a title and a priority edit leave it alone.
    await updateIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, task.id, {
      title: "Tela nova",
      priority: "high",
    });
    expect(await sinceOf()).toBe(ago(9).toISOString());

    // A move to another column of the same stage restarts it.
    const startedAt = Date.now() - 1000;
    await updateIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, task.id, { columnId: other.id });
    const moved = new Date(await sinceOf()).getTime();
    expect(moved).toBeGreaterThanOrEqual(startedAt);
    expect(moved).toBeLessThanOrEqual(Date.now());

    // A status change away and back restarts it again.
    await f.db
      .update(schema.issues)
      .set({ columnSince: ago(9) })
      .where(eq(schema.issues.id, task.id));
    await updateIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, task.id, { status: "in_progress" });
    await updateIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, task.id, { columnId: col.id });
    expect(Date.now() - new Date(await sinceOf()).getTime()).toBeLessThan(60_000);
  });

  test("lists five and the total when more wait", async () => {
    f = await setup();
    const a = await company("Alfa");
    const col = await flagged();
    const made = [];
    for (let i = 0; i < 8; i++) made.push(await a.task(waits(col.id, 20 - i)));
    const { waiting } = await read();
    expect(waiting.total).toBe(8);
    expect(waiting.items.map((i) => i.id)).toEqual(made.slice(0, 5).map((t) => t.id));
  });

  test("never lists a task the viewer may not see", async () => {
    f = await setup();
    const a = await company("Alfa");
    const col = await flagged();
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    const open = await a.task(waits(col.id, 3));
    const mine = await a.task({ ...waits(col.id, 5), restricted: true, audienceUserIds: [member.id] });
    const theirs = await a.task({ ...waits(col.id, 6), restricted: true, audienceUserIds: [f.owner.id] });
    const asMember = (await read(member.id)).waiting;
    expect(asMember.total).toBe(2);
    expect(asMember.items.map((i) => i.id)).toEqual([mine.id, open.id]);
    const asOwner = (await read()).waiting;
    expect(asOwner.items.map((i) => i.id)).toEqual([theirs.id, mine.id, open.id]);
  });

  test("never lists a canceled task or one on an archived board or company", async () => {
    f = await setup();
    const a = await company("Alfa");
    const gone = await company("Arquivada");
    const archivedBoard = await a.board("Antigo");
    const col = await flagged();
    const live = await a.task(waits(col.id, 3));
    await a.task({ ...waits(col.id, 4), status: "canceled" });
    await a.task({ ...waits(col.id, 5), projectId: archivedBoard.id });
    await gone.task(waits(col.id, 6));
    // A done task in a flagged column of the done stage never waits.
    const doneCol = await f.db
      .insert(schema.issueColumns)
      .values({ orgId: f.org.id, stage: "done", name: "Fechado", position: 5, waitsForPerson: true })
      .returning();
    await a.task({ status: "done", columnId: must(doneCol[0]).id, columnSince: ago(8) });
    await f.db
      .update(schema.issueProjects)
      .set({ archivedAt: NOW })
      .where(eq(schema.issueProjects.id, archivedBoard.id));
    await f.db.update(schema.issueSpaces).set({ archivedAt: NOW }).where(eq(schema.issueSpaces.id, gone.spaceId));
    const { waiting } = await read();
    expect(waiting.total).toBe(1);
    expect(waiting.items.map((i) => i.id)).toEqual([live.id]);
  });

  test("drops a task moved out of a flagged column and one whose column was deleted", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const a = await company("Alfa");
    const col = await flagged();
    const plain = must(
      (await f.db.select().from(schema.issueColumns).where(eq(schema.issueColumns.orgId, f.org.id))).find(
        (c) => c.stage === "in_progress" && !c.waitsForPerson,
      ) ??
        (
          await f.db
            .insert(schema.issueColumns)
            .values({ orgId: f.org.id, stage: "in_progress", position: 0 })
            .returning()
        )[0],
    );
    const movedOut = await a.task(waits(col.id, 3));
    const deleted = await a.task(waits(col.id, 4));
    const stays = await a.task(waits(col.id, 5));
    expect((await read()).waiting.total).toBe(3);

    await updateIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, movedOut.id, { columnId: plain.id });
    expect((await read()).waiting.items.map((i) => i.id)).toEqual([stays.id, deleted.id]);

    // Deleting the column sends its tasks to another column of the stage, which is not flagged.
    const review = await f.db
      .insert(schema.issueColumns)
      .values({ orgId: f.org.id, stage: "in_review", position: 0 })
      .returning();
    await deleteIssueColumn(deps, f.owner.id, f.org.id, col.id, must(review[0]).id);
    const after = (await read()).waiting;
    expect(after.total).toBe(0);
    expect(after.items).toEqual([]);
  });

  test("computes 1000 tasks in 10 companies in under 500 ms", async () => {
    f = await setup();
    const col = await flagged();
    const companies = [];
    for (let i = 0; i < 10; i++) companies.push(await company(`Empresa ${i}`));
    const statuses: Status[] = ["todo", "in_progress", "in_review", "done"];
    const rows = [];
    for (let i = 0; i < 1000; i++) {
      const c = must(companies[i % 10]);
      const status = must(statuses[i % 4]);
      rows.push({
        orgId: f.org.id,
        number: ++counter,
        title: `Task ${i}`,
        projectId: c.first.id,
        status,
        columnId: status === "in_review" && i % 8 === 2 ? col.id : null,
        createdByType: "person" as const,
        createdById: f.owner.id,
        createdAt: ago(40),
      });
    }
    await f.db.insert(schema.issues).values(rows);
    await read();
    const start = performance.now();
    const home = await read();
    const took = performance.now() - start;
    expect(home.companiesTotal).toBe(10);
    expect(home.waiting.total).toBeGreaterThan(0);
    expect(took).toBeLessThan(500);
  });
});
