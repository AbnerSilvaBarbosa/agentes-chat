import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  applyColumnTemplate,
  createIssue,
  createIssueColumn,
  createIssueProject,
  createIssueSpace,
  createIssueToolSource,
  createOrganization,
  createRoutine,
  deleteIssueProject,
  deleteIssueSpace,
  ForbiddenError,
  getIssue,
  grantScopes,
  listColumnTemplates,
  listIssueActivity,
  listIssueColumns,
  listIssueProjects,
  listIssues,
  openTasksBrief,
  PROJECTS_MAX,
  projectByName,
  updateIssue,
  updateIssueProject,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const rejection = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as ValidationError,
  );

describe("task projects", () => {
  test("a task takes one project, the list filters by it, and deleting the project keeps its tasks", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    const clinic = await createIssueProject(deps, f.owner.id, f.org.id, { name: "  Clínica   Teo ", color: "teal" });
    const bakery = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Padaria Lia" });
    expect(clinic).toMatchObject({ name: "Clínica Teo", color: "teal", archived: false, open: 0 });
    expect(bakery.color).toBe("graphite");

    const a = await createIssue(deps, ana, f.org.id, { title: "Lembrete de retorno", projectId: clinic.id });
    const b = await createIssue(deps, ana, f.org.id, { title: "Cardápio com fotos", projectId: bakery.id });
    const loose = await createIssue(deps, ana, f.org.id, { title: "Organizar o trimestre" });
    expect(a.project).toEqual({ id: clinic.id, name: "Clínica Teo", color: "teal", archived: false, spaceId: null });
    expect(loose.project).toBeNull();

    const titles = async (projectId?: string) =>
      (await listIssues(f.db, ana, f.org.id, { projectId })).map((i) => i.title).sort();
    expect(await titles(clinic.id)).toEqual(["Lembrete de retorno"]);
    expect(await titles("none")).toEqual(["Organizar o trimestre"]);
    expect(await titles()).toHaveLength(3);
    // The search still reads titles, inside a project too.
    expect((await listIssues(f.db, ana, f.org.id, { q: "cardápio", projectId: bakery.id })).map((i) => i.id)).toEqual([
      b.id,
    ]);
    expect(await listIssues(f.db, ana, f.org.id, { q: "cardápio", projectId: clinic.id })).toEqual([]);

    // Moving it and taking it out are events in the task's activity; setting the same project again is not.
    await updateIssue(deps, ana, f.org.id, loose.id, { projectId: clinic.id });
    await updateIssue(deps, ana, f.org.id, loose.id, { projectId: clinic.id });
    const out = await updateIssue(deps, ana, f.org.id, loose.id, { projectId: null });
    expect(out.project).toBeNull();
    const events = (await listIssueActivity(f.db, ana, f.org.id, loose.id)).filter(
      (e) => e.event === "project_changed",
    );
    expect(events.map((e) => [e.textCode, e.textParams])).toEqual([
      ["project_set", { project: "Clínica Teo" }],
      ["project_removed", {}],
    ]);

    // Closed tasks leave the count. Deleting the project clears it from its tasks and deletes none.
    await updateIssue(deps, ana, f.org.id, b.id, { status: "done" });
    const listed = await listIssueProjects(f.db, f.owner.id, f.org.id);
    expect(listed.projects.map((p) => [p.name, p.open])).toEqual([
      ["Clínica Teo", 1],
      ["Padaria Lia", 0],
    ]);
    expect(listed.unfiled).toBe(1);
    await deleteIssueProject(deps, f.owner.id, f.org.id, clinic.id);
    expect((await getIssue(f.db, ana, f.org.id, { id: a.id })).project).toBeNull();
    expect(await titles()).toHaveLength(3);
    expect((await listIssueProjects(f.db, f.owner.id, f.org.id)).unfiled).toBe(2);
  });

  test("names are unique whatever their capitals, cut at 80 characters, and colours come from the roles' list", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const first = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Petshop Bruno" });
    const taken = await rejection(createIssueProject(deps, f.owner.id, f.org.id, { name: "petshop bruno" }));
    expect(taken).toMatchObject({ code: "issue_project.name_taken" });
    const other = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Mercado Ana" });
    expect(
      await rejection(updateIssueProject(deps, f.owner.id, f.org.id, other.id, { name: "PETSHOP BRUNO" })),
    ).toMatchObject({
      code: "issue_project.name_taken",
    });
    // Its own name in other capitals is a rename, not a clash.
    expect((await updateIssueProject(deps, f.owner.id, f.org.id, first.id, { name: "PetShop Bruno" })).name).toBe(
      "PetShop Bruno",
    );
    const long = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Projeto ".repeat(40) });
    expect(long.name).toHaveLength(79);
    expect(await rejection(createIssueProject(deps, f.owner.id, f.org.id, { name: "   " }))).toBeInstanceOf(
      ValidationError,
    );
    expect(
      await rejection(createIssueProject(deps, f.owner.id, f.org.id, { name: "Azul", color: "sky" })),
    ).toBeInstanceOf(ValidationError);
    expect((await updateIssueProject(deps, f.owner.id, f.org.id, first.id, { color: "violet" })).color).toBe("violet");
  });

  test("an archived project keeps its tasks and takes no new one; a project of another workspace is refused", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    const old = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Acme 2025" });
    const kept = await createIssue(deps, ana, f.org.id, { title: "Fechar o ano", projectId: old.id });
    const loose = await createIssue(deps, ana, f.org.id, { title: "Sem projeto" });
    expect((await updateIssueProject(deps, f.owner.id, f.org.id, old.id, { archived: true })).archived).toBe(true);

    expect((await getIssue(f.db, ana, f.org.id, { id: kept.id })).project).toMatchObject({ archived: true });
    expect((await listIssues(f.db, ana, f.org.id, { projectId: old.id })).map((i) => i.id)).toEqual([kept.id]);
    // Its own task can still be edited, and saved with the project it already has.
    expect((await updateIssue(deps, ana, f.org.id, kept.id, { title: "Fechar 2025", projectId: old.id })).title).toBe(
      "Fechar 2025",
    );
    expect(await rejection(createIssue(deps, ana, f.org.id, { title: "Nova", projectId: old.id }))).toMatchObject({
      code: "issue_project.archived",
    });
    expect(await rejection(updateIssue(deps, ana, f.org.id, loose.id, { projectId: old.id }))).toMatchObject({
      code: "issue_project.archived",
    });
    // Archived ones list last, and come back.
    await createIssueProject(deps, f.owner.id, f.org.id, { name: "Zeta" });
    expect((await listIssueProjects(f.db, f.owner.id, f.org.id)).projects.map((p) => p.name)).toEqual([
      "Zeta",
      "Acme 2025",
    ]);
    await updateIssueProject(deps, f.owner.id, f.org.id, old.id, { archived: false });
    expect((await updateIssue(deps, ana, f.org.id, loose.id, { projectId: old.id })).project?.id).toBe(old.id);

    const { organization: elsewhere } = await createOrganization(f.db, f.owner.id, { name: "Outra" });
    const [foreign] = await f.db
      .insert(schema.issueProjects)
      .values({ orgId: elsewhere.id, name: "De fora" })
      .returning();
    expect(await rejection(updateIssue(deps, ana, f.org.id, loose.id, { projectId: foreign?.id ?? "" }))).toMatchObject(
      {
        code: "issue_project.not_found",
      },
    );
    expect(await rejection(deleteIssueProject(deps, f.owner.id, f.org.id, foreign?.id ?? ""))).toBeDefined();
  });

  test("who may create tasks manages projects; a workspace holds 200; the counts follow who sees each task", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bruno = await addMember(f.db, f.org.id, "member", "Bruno");
    const project = await createIssueProject(deps, bruno.id, f.org.id, { name: "Do Bruno" });
    // A task limited to the owner is not counted for Bruno.
    await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Só da Ana",
      projectId: project.id,
      audience: { mode: "people", userIds: [f.owner.id] },
    });
    await createIssue(deps, person(f.owner.id), f.org.id, { title: "De todos", projectId: project.id });
    const open = async (userId: string) => (await listIssueProjects(f.db, userId, f.org.id)).projects[0]?.open;
    expect(await open(f.owner.id)).toBe(2);
    expect(await open(bruno.id)).toBe(1);

    expect(await rejection(createIssueProject(deps, "someone-else", f.org.id, { name: "Outro" }))).toBeInstanceOf(
      ForbiddenError,
    );

    await f.db
      .insert(schema.issueProjects)
      .values(Array.from({ length: PROJECTS_MAX - 1 }, (_, k) => ({ orgId: f.org.id, name: `Cliente ${k + 1}` })));
    expect(await rejection(createIssueProject(deps, f.owner.id, f.org.id, { name: "Um a mais" }))).toMatchObject({
      code: "issue_project.too_many",
    });
  });

  test("agents set a project by name: an unknown one is refused with the existing names, a new one only when asked", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    await grantScopes(
      f.db,
      f.org.id,
      f.agent.id,
      ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope })),
    );
    const tools = await createIssueToolSource(f.artifactDeps).tools(ctx);
    const run = async (name: string, input: Record<string, unknown>) => {
      const out = await tools.find((t) => t.name === name)?.execute(input, ctx);
      return { content: String(out?.content ?? ""), isError: out?.isError === true };
    };
    await createIssueProject(deps, f.owner.id, f.org.id, { name: "Clínica Teo" });
    const hidden = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Antigo" });
    await updateIssueProject(deps, f.owner.id, f.org.id, hidden.id, { archived: true });

    const typo = await run("create_issue", { title: "Agenda", project: "Clinica" });
    expect(typo.isError).toBe(true);
    expect(typo.content).toContain('The projects are: "Clínica Teo".');
    expect(typo.content).not.toContain("Antigo");
    expect(await listIssues(f.db, person(f.owner.id), f.org.id)).toEqual([]);

    // Its name in any capitals is the same project.
    const made = await run("create_issue", { title: "Agenda", project: "clínica teo" });
    expect(made).toMatchObject({ isError: false });
    expect(made.content).toContain("Agenda [Clínica Teo · todo]");
    // Asked for a new one: made on the spot, once.
    const fresh = await run("create_issue", { title: "Vitrine", project: "Mercado Ana", new_project: true });
    expect(fresh.content).toContain("[Mercado Ana · todo]");
    await run("create_issue", { title: "Preços", project: "mercado ana", new_project: true });
    const names = (await listIssueProjects(f.db, f.owner.id, f.org.id)).projects.map((p) => p.name);
    expect(names).toEqual(["Clínica Teo", "Mercado Ana", "Antigo"]);

    const only = await run("list_issues", { project: "Mercado Ana" });
    expect(only.content.split("\n")).toHaveLength(2);
    expect(only.content).not.toContain("Agenda");
    expect((await run("list_issues", { project: "Nada" })).isError).toBe(true);
    // An archived project is read, never written to.
    expect(await run("list_issues", { project: "antigo" })).toEqual({ content: "No issues.", isError: false });
    const late = await run("create_issue", { title: "Tarde", project: "Antigo", new_project: true });
    expect(late.isError).toBe(true);
    expect(late.content).toContain("is archived");

    const [agenda] = await listIssues(f.db, person(f.owner.id), f.org.id, { q: "Agenda" });
    const moved = await run("update_issue", { issue: `#${agenda?.number}`, project: "Mercado Ana" });
    expect(moved.content).toContain("[Mercado Ana · todo]");
    const cleared = await run("update_issue", { issue: `#${agenda?.number}`, project: "none" });
    expect(cleared.content).not.toContain("[Clínica Teo · todo]");
    expect((await run("list_issues", { project: "none" })).content).toContain("Agenda");
    expect((await run("list_issues", { project: "None" })).content).toContain("Agenda");
    // A change that names no project leaves it where it is.
    await run("update_issue", { issue: `#${agenda?.number}`, project: "Clínica Teo" });
    const kept = await run("update_issue", { issue: `#${agenda?.number}`, priority: "high" });
    expect(kept.content).toContain("[Clínica Teo · todo]");
  });

  test("an agent's open tasks say each one's project", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const project = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Padaria Lia" });
    const assignee = { type: "agent" as const, id: f.agent.id };
    await createIssue(deps, person(f.owner.id), f.org.id, { title: "Pedido no site", assignee, projectId: project.id });
    await createIssue(deps, person(f.owner.id), f.org.id, { title: "Sem projeto", assignee });
    const brief = await openTasksBrief(f.db, f.org.id, f.agent.id, f.general.id, false);
    expect(brief).toContain("Pedido no site (todo, project Padaria Lia)");
    expect(brief).toContain("Sem projeto (todo)");
  });
});

describe("task spaces", () => {
  test("a company groups boards, and its board is every task of them", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    const acme = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "  Empresa   A ", color: "teal" });
    expect(acme).toMatchObject({ name: "Empresa A", color: "teal", archived: false, open: 0 });
    const crm = await createIssueProject(deps, f.owner.id, f.org.id, { name: "CRM", spaceId: acme.id });
    const site = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Site", spaceId: acme.id });
    const loose = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Solto" });
    expect(crm.spaceId).toBe(acme.id);
    expect(loose.spaceId).toBeNull();

    const a = await createIssue(deps, ana, f.org.id, { title: "Criar lead", projectId: crm.id });
    expect(a.project).toMatchObject({ name: "CRM", spaceId: acme.id });
    await createIssue(deps, ana, f.org.id, { title: "Landing", projectId: site.id });
    await createIssue(deps, ana, f.org.id, { title: "Fora", projectId: loose.id });

    const list = await listIssueProjects(f.db, f.owner.id, f.org.id);
    expect(list.spaces).toEqual([{ ...acme, open: 2 }]);
    expect(list.projects.find((p) => p.name === "CRM")?.open).toBe(1);

    // The company's board is every task of every board in it.
    const inSpace = await listIssues(f.db, ana, f.org.id, { spaceId: acme.id });
    expect(inSpace.map((i) => i.title).sort()).toEqual(["Criar lead", "Landing"]);
  });

  test("a space has one name whatever its capitals, and moving a board out of it is allowed", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const box = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Box" });
    const taken = await rejection(createIssueSpace(deps, f.owner.id, f.org.id, { name: "box" }));
    expect(taken?.code).toBe("issue_space.name_taken");

    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "App", spaceId: box.id });
    const moved = await updateIssueProject(deps, f.owner.id, f.org.id, board.id, { spaceId: null });
    expect(moved.spaceId).toBeNull();
    const unknown = await rejection(
      updateIssueProject(deps, f.owner.id, f.org.id, board.id, { spaceId: crypto.randomUUID() }),
    );
    expect(unknown?.code).toBe("issue_space.not_found");
  });

  test("deleting a company keeps its boards, with their tasks", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const space = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Empresa B" });
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Loja", spaceId: space.id });
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Carrinho", projectId: board.id });

    await deleteIssueSpace(deps, f.owner.id, f.org.id, space.id);
    const list = await listIssueProjects(f.db, f.owner.id, f.org.id);
    expect(list.spaces).toEqual([]);
    expect(list.projects.find((p) => p.id === board.id)?.spaceId).toBeNull();
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id })).project?.name).toBe("Loja");
  });

  test("a person of no workspace makes no company", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const denied = await createIssueSpace(deps, "someone-else", f.org.id, { name: "Nova" }).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(ForbiddenError);
  });
});

describe("what an agent sees of the boards", () => {
  /** An agent's tools, holding the issue scopes, in the general channel. */
  const agentTools = async (f: Fixture) => {
    const ctx = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: crypto.randomUUID(),
      triggerMessageId: crypto.randomUUID(),
    };
    await grantScopes(
      f.db,
      f.org.id,
      f.agent.id,
      ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope })),
    );
    const tools = await createIssueToolSource(f.artifactDeps).tools(ctx);
    return async (name: string, input: Record<string, unknown> = {}) => {
      const out = await tools.find((t) => t.name === name)?.execute(input, ctx);
      return { content: String(out?.content ?? ""), isError: out?.isError === true };
    };
  };

  test("list_boards shows each company over its boards and the columns, and list_issues lines say where a task sits", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const run = await agentTools(f);
    const acme = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Empresa A" });
    const crm = await createIssueProject(deps, f.owner.id, f.org.id, { name: "CRM", spaceId: acme.id });
    await createIssueProject(deps, f.owner.id, f.org.id, { name: "Site", spaceId: acme.id });
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Criar lead", projectId: crm.id });

    const boards = await run("list_boards");
    expect(boards.isError).toBe(false);
    expect(boards.content).toContain("Empresa A");
    expect(boards.content).toContain("· CRM (1 open)");
    expect(boards.content).toContain("· Site (0 open)");
    expect(boards.content).toContain("Columns per board:");
    expect(boards.content).toContain("· CRM: todo:");

    const all = await run("list_issues");
    expect(all.content).toContain(`#${issue.number} [todo] Criar lead [Empresa A · CRM ·`);
    const onlyCompany = await run("list_issues", { company: "empresa a" });
    expect(onlyCompany.content).toContain("Criar lead");
    const typo = await run("list_issues", { company: "Empresa B" });
    expect(typo.isError).toBe(true);
    expect(typo.content).toContain('The companies are: "Empresa A".');
  });

  test("update_issue moves a card to a column by name, and refuses a column nothing has", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const run = await agentTools(f);
    const columns = await listIssueColumns(f.db, f.owner.id, f.org.id);
    const qa = await createIssueColumn(deps, f.owner.id, f.org.id, { name: "QA", stage: "in_review", afterId: null });
    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Login quebrado" });

    const moved = await run("update_issue", { issue: `#${issue.number}`, column: "qa" });
    expect(moved.isError).toBe(false);
    const after = await getIssue(f.db, person(f.owner.id), f.org.id, { id: issue.id });
    expect(after.columnId).toBe(qa.find((c) => c.name === "QA")?.id ?? null);
    expect(after.status).toBe("in_review");

    const typo = await run("update_issue", { issue: `#${issue.number}`, column: "Em testes" });
    expect(typo.isError).toBe(true);
    expect(typo.content).toContain('There is no column named "Em testes"');
    expect(columns.length).toBeGreaterThan(0);
  });

  test("create_issue starts the card in the column it names, without firing issue.moved", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const run = await agentTools(f);
    const ready = await createIssueColumn(deps, f.owner.id, f.org.id, {
      name: "Ready for dev",
      stage: "in_progress",
      afterId: null,
    });
    const watcher = await createRoutine({ db: f.db, pubsub: f.pubsub } as never, f.owner.id, f.org.id, {
      agentId: f.agent.id,
      prompt: "Implemente.",
      target: { type: "channel", channelId: f.general.id },
      trigger: { type: "event", event: "issue.moved" },
    });
    const made = await run("create_issue", { title: "Carrinho", column: "Ready for dev" });
    expect(made.isError).toBe(false);
    const [created] = await listIssues(f.db, person(f.owner.id), f.org.id, { q: "Carrinho" });
    expect(created?.status).toBe("in_progress");
    expect(created?.columnId).toBe(ready.find((c) => c.name === "Ready for dev")?.id);
    const runs = await f.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.routineId, watcher.id));
    expect(runs).toHaveLength(0);
  });
});

describe("a board's own columns", () => {
  test("a template gives the board its own columns, and moving a card resolves them inside that board", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const templates = await listColumnTemplates(f.db, f.owner.id, f.org.id);
    const dev = templates.find((t) => t.name === "Desenvolvimento");
    expect(dev).toBeDefined();
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Produto" });
    await applyColumnTemplate(deps, f.owner.id, f.org.id, board.id, dev?.id ?? "");

    const columns = await listIssueColumns(f.db, f.owner.id, f.org.id, board.id);
    expect(columns.map((c) => c.name)).toEqual([
      "Backlog",
      "Especificar",
      "Ready for dev",
      "Em dev",
      "Ajuste",
      "Deploy",
      "PR / Develop",
      "QA",
      "Concluído",
    ]);
    expect(columns.every((c) => c.projectId === board.id)).toBe(true);
    // The workspace's own set is untouched: another board still follows it.
    const workspace = await listIssueColumns(f.db, f.owner.id, f.org.id);
    expect(workspace.every((c) => c.projectId === null)).toBe(true);

    const issue = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Checkout", projectId: board.id });
    const moved = await updateIssue(deps, person(f.owner.id), f.org.id, issue.id, {
      columnId: columns.find((c) => c.name === "QA")?.id ?? "",
    });
    expect(moved.status).toBe("in_review");
    // A column of the workspace is not one of this board's.
    const foreign = await rejection(
      updateIssue(deps, person(f.owner.id), f.org.id, issue.id, { columnId: workspace[0]?.id ?? "" }),
    );
    expect((foreign as unknown as { message?: string })?.message).toContain("board");
  });
});

describe("two companies, one board name", () => {
  test('each company may have an "Entregas", and an agent\'s bare name says which', async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const acme = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Empresa A" });
    const beta = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Empresa B" });
    const a = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Entregas", spaceId: acme.id });
    const b = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Entregas", spaceId: beta.id });
    expect(a.name).toBe("Entregas");
    expect(b.spaceId).toBe(beta.id);
    // The same company twice, in any capitals, is still refused.
    const twice = await rejection(
      createIssueProject(deps, f.owner.id, f.org.id, { name: "entregas", spaceId: acme.id }),
    );
    expect(twice?.code).toBe("issue_project.name_taken");

    // An agent naming only the board is told which companies have one.
    const loose = await rejection(projectByName(deps, f.org.id, "Entregas", "new"));
    expect(loose?.code).toBe("issue_project.ambiguous");
    expect(loose?.message).toContain("Empresa A › Entregas");
    expect(loose?.message).toContain("Empresa B › Entregas");
    // With the company it is that one, and a new one is made there.
    expect((await projectByName(deps, f.org.id, "Entregas", "task", beta.id)).id).toBe(b.id);
    const made = await projectByName(deps, f.org.id, "Suporte", "new", beta.id);
    expect(made.spaceId).toBe(beta.id);
  });

  test("moving a board to a company that already has its name is refused", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const acme = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Empresa A" });
    const beta = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Empresa B" });
    await createIssueProject(deps, f.owner.id, f.org.id, { name: "Entregas", spaceId: acme.id });
    const loose = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Entregas" });
    expect(loose.spaceId).toBeNull();
    const denied = await rejection(updateIssueProject(deps, f.owner.id, f.org.id, loose.id, { spaceId: acme.id }));
    expect(denied?.code).toBe("issue_project.name_taken");
    // Into the other company it goes, and then it may be renamed there freely.
    await updateIssueProject(deps, f.owner.id, f.org.id, loose.id, { spaceId: beta.id });
    const renamed = await updateIssueProject(deps, f.owner.id, f.org.id, loose.id, { name: "Entregas v2" });
    expect(renamed.name).toBe("Entregas v2");
  });
});
