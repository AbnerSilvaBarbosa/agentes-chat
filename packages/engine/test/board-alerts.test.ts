import { afterEach, describe, expect, test } from "bun:test";
import {
  applyColumnTemplate,
  archiveAgent,
  boardAlerts,
  createIssueProject,
  createRoutine,
  templateByName,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { routineDeps } from "./routine-fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

/** A board with the "Desenvolvimento" pipeline as its own columns (Backlog, Especificar, Ready for dev, ...). */
async function pipeline(fx: Fixture, name = "CRM") {
  const deps = { db: fx.db, pubsub: fx.pubsub };
  const board = await createIssueProject(deps, fx.owner.id, fx.org.id, { name });
  const template = await templateByName(fx.db, fx.org.id, "Desenvolvimento");
  if (!template) throw new Error("no template");
  const columns = await applyColumnTemplate(deps, fx.owner.id, fx.org.id, board.id, template.id);
  const column = (columnName: string) => {
    const found = columns.find((c) => c.name === columnName);
    if (!found) throw new Error(`no column ${columnName}`);
    return found;
  };
  return { board, column };
}

/** An event routine on `issue.moved`, as an agent or the routines page would make one. */
const moveRoutine = (fx: Fixture, filter: Record<string, string>, creatorId = fx.owner.id) =>
  createRoutine(routineDeps(fx), creatorId, fx.org.id, {
    agentId: fx.agent.id,
    prompt: "Trabalhe no card.",
    target: { type: "dm" },
    trigger: { type: "event", event: "issue.moved", filter },
  });

describe("listing a board's rules", () => {
  test("lists only the board's routines that name a destination, whoever created them", async () => {
    f = await setup();
    const crm = await pipeline(f, "CRM");
    const site = await pipeline(f, "Site");
    const admin = await addMember(f.db, f.org.id, "admin", "Bia");
    const byOwner = await moveRoutine(f, {
      projectId: crm.board.id,
      columnId: crm.column("Especificar").id,
      fromColumnId: crm.column("Backlog").id,
    });
    // Another person's, made for a column only this board has (an agent's `column` with no `board`).
    const byAdmin = await moveRoutine(f, { columnId: crm.column("QA").id }, admin.id);
    // Not rules: no destination column, another board's, another event.
    await moveRoutine(f, { projectId: crm.board.id });
    await moveRoutine(f, { projectId: site.board.id, columnId: site.column("QA").id });
    await createRoutine(routineDeps(f), f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Faça a triagem.",
      target: { type: "dm" },
      trigger: { type: "event", event: "issue.created" },
    });

    const rules = await boardAlerts(f.db, f.owner.id, f.org.id, crm.board.id);
    expect(rules.map((r) => r.id).sort()).toEqual([byOwner.id, byAdmin.id].sort());
    expect(rules.find((r) => r.id === byOwner.id)).toMatchObject({
      agentId: f.agent.id,
      columnId: crm.column("Especificar").id,
      fromColumnId: crm.column("Backlog").id,
      paused: false,
      pausedReason: null,
    });
    expect(rules.find((r) => r.id === byAdmin.id)).toMatchObject({ fromColumnId: null });
    expect(await boardAlerts(f.db, f.owner.id, f.org.id, (await pipeline(f, "Vazio")).board.id)).toEqual([]);
  });

  test("shows a rule of an archived agent as paused", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const rule = await moveRoutine(f, { projectId: crm.board.id, columnId: crm.column("QA").id });
    await archiveAgent(f.db, f.owner.id, f.org.id, f.agent.id);
    const [listed] = await boardAlerts(f.db, f.owner.id, f.org.id, crm.board.id);
    expect(listed).toMatchObject({ id: rule.id, paused: true, pausedReason: "agent_archived" });
  });
});
