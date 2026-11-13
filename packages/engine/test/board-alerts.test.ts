import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  addBoardAlert,
  applyColumnTemplate,
  archiveAgent,
  boardAlerts,
  createIssueProject,
  createRoutine,
  ForbiddenError,
  listIssueColumns,
  templateByName,
  ValidationError,
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
    const found = columns.find((c) => c.projectId === board.id && c.name === columnName);
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

describe("adding a rule", () => {
  const alert = (fx: Fixture, userId: string, boardId: string, input: Parameters<typeof addBoardAlert>[4]) =>
    addBoardAlert(routineDeps(fx), userId, fx.org.id, boardId, input);
  const routineOf = async (fx: Fixture, id: string) =>
    (await fx.db.select().from(schema.routines).where(eq(schema.routines.id, id)))[0];

  test("saves a rule as an event routine on issue.moved, narrowed to the board and its columns", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const spec = crm.column("Especificar");
    const backlog = crm.column("Backlog");
    const rule = await alert(f, f.owner.id, crm.board.id, {
      agentId: f.agent.id,
      columnId: spec.id,
      fromColumnId: backlog.id,
    });
    expect(rule).toMatchObject({ agentId: f.agent.id, columnId: spec.id, fromColumnId: backlog.id, paused: false });
    const row = await routineOf(f, rule.id);
    expect(row).toMatchObject({
      triggerType: "event",
      event: "issue.moved",
      agentId: f.agent.id,
      access: "act",
      active: true,
      eventFilter: { projectId: crm.board.id, columnId: spec.id, fromColumnId: backlog.id },
    });
    // The fixed brief says the board, the status it went to and where it came from; the card comes with each run.
    expect(row?.prompt).toContain("CRM");
    expect(row?.prompt).toContain("Especificar");
    expect(row?.prompt).toContain("Backlog");
    expect(await boardAlerts(f.db, f.owner.id, f.org.id, crm.board.id)).toHaveLength(1);

    // No source: the filter names only the destination.
    const any = await alert(f, f.owner.id, crm.board.id, { agentId: f.agent.id, columnId: crm.column("QA").id });
    expect((await routineOf(f, any.id))?.eventFilter).toEqual({
      projectId: crm.board.id,
      columnId: crm.column("QA").id,
    });
    expect(any.fromColumnId).toBeNull();
  });

  test("a board that followed the workspace's columns names its own copy, which later edits keep", async () => {
    f = await setup();
    const board = await createIssueProject({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, { name: "Novo" });
    const workspace = await listIssueColumns(f.db, f.owner.id, f.org.id, board.id);
    expect(workspace.every((c) => c.projectId === null)).toBe(true);
    const picked = workspace.find((c) => c.stage === "in_progress");
    const rule = await alert(f, f.owner.id, board.id, { agentId: f.agent.id, columnId: picked?.id ?? "" });
    const own = await listIssueColumns(f.db, f.owner.id, f.org.id, board.id);
    expect(own.every((c) => c.projectId === board.id)).toBe(true);
    const copy = own.find((c) => c.stage === "in_progress");
    expect(copy).toBeDefined();
    expect(rule.columnId).toBe(copy?.id as string);
  });

  test("writes the brief in the person's language", async () => {
    f = await setup();
    const crm = await pipeline(f);
    await f.db.update(schema.users).set({ locale: "pt-BR" }).where(eq(schema.users.id, f.owner.id));
    const pt = await alert(f, f.owner.id, crm.board.id, { agentId: f.agent.id, columnId: crm.column("QA").id });
    expect((await routineOf(f, pt.id))?.prompt).toContain("Você foi avisado");
    await f.db.update(schema.users).set({ locale: "en" }).where(eq(schema.users.id, f.owner.id));
    const en = await alert(f, f.owner.id, crm.board.id, { agentId: f.agent.id, columnId: crm.column("Deploy").id });
    expect((await routineOf(f, en.id))?.prompt).toContain("You were alerted");
  });

  test("refuses a status that is not the board's and a source equal to the destination", async () => {
    f = await setup();
    const crm = await pipeline(f, "CRM");
    const site = await pipeline(f, "Site");
    const qa = crm.column("QA");
    await expect(
      alert(f, f.owner.id, crm.board.id, { agentId: f.agent.id, columnId: site.column("QA").id }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      alert(f, f.owner.id, crm.board.id, {
        agentId: f.agent.id,
        columnId: qa.id,
        fromColumnId: site.column("Backlog").id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      alert(f, f.owner.id, crm.board.id, { agentId: f.agent.id, columnId: qa.id, fromColumnId: qa.id }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await boardAlerts(f.db, f.owner.id, f.org.id, crm.board.id)).toEqual([]);
  });

  test("refuses a rule for an agent the member may not manage", async () => {
    f = await setup();
    const crm = await pipeline(f);
    const member = await addMember(f.db, f.org.id, "member", "Caio");
    await expect(
      alert(f, member.id, crm.board.id, { agentId: f.agent.id, columnId: crm.column("QA").id }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // An admin manages routines, but not for an agent that answers only its owner.
    const admin = await addMember(f.db, f.org.id, "admin", "Bia");
    await f.db
      .update(schema.agents)
      .set({ audienceMode: "owner", ownerUserId: f.owner.id })
      .where(eq(schema.agents.id, f.agent.id));
    await expect(
      alert(f, admin.id, crm.board.id, { agentId: f.agent.id, columnId: crm.column("QA").id }),
    ).rejects.toThrow();
    expect(await boardAlerts(f.db, f.owner.id, f.org.id, crm.board.id)).toEqual([]);
  });
});
