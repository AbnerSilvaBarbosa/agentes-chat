import { afterEach, describe, expect, test } from "bun:test";
import { asc, eq, schema } from "@agenteschat/db";
import {
  addBoardAlert,
  applyColumnTemplate,
  boardAlerts,
  createIssue,
  createIssueProject,
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

describe("a rule wakes its agent", () => {
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
});
