import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import {
  addBoardAlert,
  applyColumnTemplate,
  boardAlerts,
  createIssue,
  createIssueProject,
  executeRoutineRun,
  MAX_MOVE_HOPS,
  templateByName,
  updateIssue,
  updateIssueProject,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { routineDeps } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (fx: Fixture) => ({ type: "person" as const, userId: fx.owner.id });
const deps = (fx: Fixture) => ({ db: fx.db, pubsub: fx.pubsub });

/** A board with the "Desenvolvimento" pipeline as its own columns. */
async function pipeline(fx: Fixture, name = "CRM") {
  const board = await createIssueProject(deps(fx), fx.owner.id, fx.org.id, { name });
  const template = await templateByName(fx.db, fx.org.id, "Desenvolvimento");
  if (!template) throw new Error("no template");
  const columns = await applyColumnTemplate(deps(fx), fx.owner.id, fx.org.id, board.id, template.id);
  const column = (columnName: string) => {
    const found = columns.find((c) => c.projectId === board.id && c.name === columnName);
    if (!found) throw new Error(`no column ${columnName}`);
    return found;
  };
  return { board, column };
}

const rule = (fx: Fixture, boardId: string, columnId: string, fromColumnId?: string, agentId: string = fx.agent.id) =>
  addBoardAlert(routineDeps(fx), fx.owner.id, fx.org.id, boardId, { agentId, columnId, fromColumnId });

const runsOf = (fx: Fixture, routineId: string) =>
  fx.db
    .select()
    .from(schema.routineRuns)
    .where(eq(schema.routineRuns.routineId, routineId))
    .orderBy(asc(schema.routineRuns.createdAt));

/** A card of the board sitting in `column`, so the next move has a known source. */
async function cardIn(fx: Fixture, boardId: string, columnId: string, title = "Lead") {
  const issue = await createIssue(deps(fx), person(fx), fx.org.id, { title, projectId: boardId });
  await updateIssue(deps(fx), person(fx), fx.org.id, issue.id, { columnId });
  return issue;
}
const move = (fx: Fixture, issueId: string, columnId: string, actor: Parameters<typeof updateIssue>[1] = person(fx)) =>
  updateIssue(deps(fx), actor, fx.org.id, issueId, { columnId });

describe("a rule wakes its agent", () => {
  test("starts a run of the agent on the move", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const alert = await rule(f, crm.board.id, crm.column("Especificar").id, crm.column("Backlog").id);
    const issue = await cardIn(f, crm.board.id, crm.column("Backlog").id);
    expect(await runsOf(f, alert.id)).toHaveLength(0);

    await move(f, issue.id, crm.column("Especificar").id);
    const runs = await runsOf(f, alert.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.event).toMatchObject({ type: "issue.moved", issueId: issue.id });
    // The routine's agent is the one that will be asked.
    const [routine] = await f.db.select().from(schema.routines).where(eq(schema.routines.id, alert.id));
    expect(routine?.agentId).toBe(f.agent.id);
    await executeRoutineRun(routineDeps(f), runs[0]?.id ?? "");
    const [started] = await runsOf(f, alert.id);
    expect(started?.status).toBe("started");
    const [agentRun] = await f.db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, started?.agentRunId ?? ""));
    expect(agentRun?.agentId).toBe(f.agent.id);
  });

  test("a rule with no source fires on any move into the destination", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const alert = await rule(f, crm.board.id, crm.column("QA").id);
    const a = await cardIn(f, crm.board.id, crm.column("Backlog").id, "A");
    const b = await cardIn(f, crm.board.id, crm.column("Em dev").id, "B");
    await move(f, a.id, crm.column("QA").id);
    await executeRoutineRun(routineDeps(f), (await runsOf(f, alert.id))[0]?.id ?? "");
    await move(f, b.id, crm.column("QA").id);
    const events = (await runsOf(f, alert.id)).map((r) => r.event);
    expect(JSON.stringify(events)).toContain(a.id);
    expect(JSON.stringify(events)).toContain(b.id);
  });

  test("a rule with a source ignores a move into the destination from another status", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const alert = await rule(f, crm.board.id, crm.column("QA").id, crm.column("Em dev").id);
    const issue = await cardIn(f, crm.board.id, crm.column("Backlog").id);
    await move(f, issue.id, crm.column("QA").id);
    expect(await runsOf(f, alert.id)).toHaveLength(0);
  });

  test("tells the agent the card and the move", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const alert = await rule(f, crm.board.id, crm.column("Especificar").id, crm.column("Backlog").id);
    const issue = await cardIn(f, crm.board.id, crm.column("Backlog").id, "Criar tela de login");
    await move(f, issue.id, crm.column("Especificar").id);
    const [run] = await runsOf(f, alert.id);
    expect(run?.event).toMatchObject({
      type: "issue.moved",
      issueId: issue.id,
      number: issue.number,
      title: "Criar tela de login",
      fromColumnId: crm.column("Backlog").id,
      fromColumn: "Backlog",
      columnId: crm.column("Especificar").id,
      column: "Especificar",
      projectId: crm.board.id,
      by: "person",
    });
    expect(String(run?.event?.summary)).toContain(`#${issue.number}`);
    expect(String(run?.event?.summary)).toContain("Criar tela de login");
    expect(String(run?.event?.summary)).toContain("Backlog");
    expect(String(run?.event?.summary)).toContain("Especificar");
  });

  test("a move to another status starts no run", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const alert = await rule(f, crm.board.id, crm.column("Especificar").id);
    const issue = await cardIn(f, crm.board.id, crm.column("Backlog").id);
    await move(f, issue.id, crm.column("Ready for dev").id);
    await move(f, issue.id, crm.column("QA").id);
    expect(await runsOf(f, alert.id)).toHaveLength(0);
  });

  test("two rules on one move start a run each", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const first = await rule(f, crm.board.id, crm.column("QA").id);
    const second = await rule(f, crm.board.id, crm.column("QA").id, crm.column("Em dev").id);
    const issue = await cardIn(f, crm.board.id, crm.column("Em dev").id);
    await move(f, issue.id, crm.column("QA").id);
    expect(await runsOf(f, first.id)).toHaveLength(1);
    expect(await runsOf(f, second.id)).toHaveLength(1);
  });

  test("a stage rule fires only when the destination matches", async () => {
    f = await setup();
    const crm = await pipeline(f);
    // "Backlog" and "Especificar" are both of the "todo" stage.
    const alert = await rule(f, crm.board.id, crm.column("Especificar").id);
    const issue = await cardIn(f, crm.board.id, crm.column("Ready for dev").id);
    await move(f, issue.id, crm.column("Backlog").id);
    expect(await runsOf(f, alert.id)).toHaveLength(0);
    await move(f, issue.id, crm.column("Especificar").id);
    expect(await runsOf(f, alert.id)).toHaveLength(1);
    // Inside the stage, leaving the rule's column fires nothing.
    await move(f, issue.id, crm.column("Backlog").id);
    expect(await runsOf(f, alert.id)).toHaveLength(1);
  });

  test("never fires itself and a chain stops after three", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const dev = await rule(f, crm.board.id, crm.column("Ready for dev").id);
    const qa = await rule(f, crm.board.id, crm.column("QA").id);
    const issue = await cardIn(f, crm.board.id, crm.column("Backlog").id);
    await move(f, issue.id, crm.column("Ready for dev").id);
    const [queued] = await runsOf(f, dev.id);
    await executeRoutineRun(routineDeps(f), queued?.id ?? "");
    const [devRun] = await runsOf(f, dev.id);
    const asDev = {
      type: "agent" as const,
      agentId: f.agent.id,
      channelId: f.general.id,
      runId: devRun?.agentRunId ?? undefined,
    };

    // The dev's own run moves the card out and back into its own column: it hears nothing; the next rule hears the first move.
    await move(f, issue.id, crm.column("QA").id, asDev);
    await move(f, issue.id, crm.column("Ready for dev").id, asDev);
    expect(await runsOf(f, dev.id)).toHaveLength(1);
    expect(await runsOf(f, qa.id)).toHaveLength(1);

    // A run that a chain of moves already carried to the cap sets nothing off (the first QA run works now, so a
    // new event would gather in a run of its own).
    await executeRoutineRun(routineDeps(f), (await runsOf(f, qa.id))[0]?.id ?? "");
    await move(f, issue.id, crm.column("Ready for dev").id, asDev);
    await f.db
      .update(schema.routineRuns)
      .set({ event: { type: "issue.moved", depth: MAX_MOVE_HOPS } })
      .where(eq(schema.routineRuns.id, devRun?.id ?? ""));
    await move(f, issue.id, crm.column("QA").id, asDev);
    expect(await runsOf(f, qa.id)).toHaveLength(1);
  });

  test("a rule whose routine cannot act still runs", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const alert = await rule(f, crm.board.id, crm.column("Especificar").id);
    await f.db.update(schema.routines).set({ access: "read" }).where(eq(schema.routines.id, alert.id));
    const issue = await cardIn(f, crm.board.id, crm.column("Backlog").id);
    await move(f, issue.id, crm.column("Especificar").id);
    const [queued] = await runsOf(f, alert.id);
    expect(queued).toBeDefined();
    await executeRoutineRun(routineDeps(f), queued?.id ?? "");
    expect((await runsOf(f, alert.id))[0]?.status).toBe("started");
  });

  test("an archived board fires none of its rules", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const alert = await rule(f, crm.board.id, crm.column("Especificar").id);
    const issue = await createIssue(deps(f), person(f), f.org.id, { title: "Lead", projectId: crm.board.id });

    await updateIssueProject(deps(f), f.owner.id, f.org.id, crm.board.id, { archived: true });
    await updateIssue(deps(f), person(f), f.org.id, issue.id, { columnId: crm.column("Especificar").id });
    expect(await runsOf(f, alert.id)).toHaveLength(0);
    // The rule stays listed.
    expect((await boardAlerts(f.db, f.owner.id, f.org.id, crm.board.id)).map((r) => r.id)).toEqual([alert.id]);

    // Brought back, the same move fires it again.
    await updateIssueProject(deps(f), f.owner.id, f.org.id, crm.board.id, { archived: false });
    await updateIssue(deps(f), person(f), f.org.id, issue.id, { columnId: crm.column("Backlog").id });
    await updateIssue(deps(f), person(f), f.org.id, issue.id, { columnId: crm.column("Especificar").id });
    expect(await runsOf(f, alert.id)).toHaveLength(1);
  });

  test("a rule with a source fires for a card whose row stores no column (it sat in its stage's first one)", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const alert = await rule(f, crm.board.id, crm.column("Especificar").id, crm.column("Backlog").id);
    // Made with no column and moved by the board: the row never stored Backlog, the card still sat in it.
    const issue = await createIssue(deps(f), person(f), f.org.id, { title: "Lead", projectId: crm.board.id });
    await move(f, issue.id, crm.column("Especificar").id);
    const runs = await runsOf(f, alert.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.event).toMatchObject({ fromColumn: "Backlog", column: "Especificar" });
  });

  test("an archived board fires none of its rules that name only its columns", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const alert = await rule(f, crm.board.id, crm.column("Especificar").id);
    // The way an agent makes one, with a column and no board: still the board's by its column.
    await f.db
      .update(schema.routines)
      .set({ eventFilter: { columnId: crm.column("Especificar").id } })
      .where(eq(schema.routines.id, alert.id));
    const issue = await createIssue(deps(f), person(f), f.org.id, { title: "Lead", projectId: crm.board.id });
    await updateIssueProject(deps(f), f.owner.id, f.org.id, crm.board.id, { archived: true });
    await move(f, issue.id, crm.column("Especificar").id);
    expect(await runsOf(f, alert.id)).toHaveLength(0);
  });
});
