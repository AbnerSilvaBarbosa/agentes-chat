import { afterEach, describe, expect, test } from "bun:test";
import {
  applyColumnTemplate,
  createAgent,
  createIssueColumn,
  createIssueProject,
  createIssueSpace,
  createIssueToolSource,
  getIssue,
  grantScopes,
  listColumnTemplates,
  listIssueColumns,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });

/** The tools an agent holding the issue scopes gets in the general channel: what it can do with the board. */
async function agentTools(fixture: Fixture) {
  const ctx = {
    db: fixture.db,
    orgId: fixture.org.id,
    agentId: fixture.agent.id,
    runId: crypto.randomUUID(),
    channelId: fixture.general.id,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
  };
  await grantScopes(
    fixture.db,
    fixture.org.id,
    fixture.agent.id,
    ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope })),
  );
  const tools = await createIssueToolSource(fixture.artifactDeps).tools(ctx);
  const run = async (name: string, input: Record<string, unknown> = {}) => {
    const out = await tools.find((t) => t.name === name)?.execute(input, ctx);
    return { content: String(out?.content ?? ""), isError: out?.isError === true, data: out?.data };
  };
  return { tools, run };
}

/** A company "Empresa A" with a board "CRM" on the seeded "Desenvolvimento" columns, and a plain board "Site". */
async function pipeline(fixture: Fixture) {
  const deps = { db: fixture.db, pubsub: fixture.pubsub };
  const company = await createIssueSpace(deps, fixture.owner.id, fixture.org.id, { name: "Empresa A" });
  const crm = await createIssueProject(deps, fixture.owner.id, fixture.org.id, {
    name: "CRM",
    spaceId: company.id,
  });
  const site = await createIssueProject(deps, fixture.owner.id, fixture.org.id, { name: "Site" });
  const sets = await listColumnTemplates(fixture.db, fixture.owner.id, fixture.org.id);
  const dev = sets.find((s) => s.name === "Desenvolvimento");
  if (!dev) throw new Error("missing seeded set");
  await applyColumnTemplate(deps, fixture.owner.id, fixture.org.id, crm.id, dev.id);
  return { deps, company, crm, site };
}

const issueOf = (data: unknown) => (data as { issue: { id: string } }).issue.id;

describe("what agents can do with cards", () => {
  test("create_issue places a card in a board column with an owner", async () => {
    f = await setup();
    const { crm } = await pipeline(f);
    const { run } = await agentTools(f);

    const made = await run("create_issue", {
      title: "Importar leads",
      project: "CRM",
      company: "Empresa A",
      column: "Ready for dev",
      assignee: "me",
    });
    expect(made.isError).toBe(false);
    const card = await getIssue(f.db, person(f.owner.id), f.org.id, { id: issueOf(made.data) });
    const columns = await listIssueColumns(f.db, f.owner.id, f.org.id, crm.id);
    const ready = columns.find((c) => c.name === "Ready for dev");
    if (!ready) throw new Error("the board lacks its column");
    expect(card.project?.id).toBe(crm.id);
    expect(card.columnId).toBe(ready.id);
    expect(card.status).toBe("in_progress");
    expect(card.assignee).toEqual({ type: "agent", id: f.agent.id });
  });

  test("update_issue moves a card to a column of its board", async () => {
    f = await setup();
    await pipeline(f);
    const { run } = await agentTools(f);
    const made = await run("create_issue", { title: "Tela", project: "CRM", column: "Backlog" });
    const id = issueOf(made.data);

    const moved = await run("update_issue", { issue: id, column: "QA" });
    expect(moved.isError).toBe(false);
    expect(moved.content).toContain("CRM · QA");
    const card = await getIssue(f.db, person(f.owner.id), f.org.id, { id });
    expect(card.status).toBe("in_review");

    // A stage word takes that stage's first column.
    const done = await run("update_issue", { issue: id, column: "done" });
    expect(done.isError).toBe(false);
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id })).status).toBe("done");

    // A bare stage sets the stage too.
    await run("update_issue", { issue: id, status: "in_progress" });
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id })).status).toBe("in_progress");
  });

  test("update_issue sets and clears the owner", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Other", handle: "other", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    expect(other.id).not.toBe(f.agent.id);
    const { run } = await agentTools(f);
    const id = issueOf((await run("create_issue", { title: "Contrato" })).data);
    const assigneeOf = async () => (await getIssue(f.db, person(f.owner.id), f.org.id, { id })).assignee;

    await run("update_issue", { issue: id, assignee: "me" });
    expect(await assigneeOf()).toEqual({ type: "agent", id: f.agent.id });
    await run("update_issue", { issue: id, assignee: "@dev" });
    expect(await assigneeOf()).toEqual({ type: "agent", id: f.agent.id });
    // Another agent's handle sets that agent, not the caller.
    const toOther = await run("update_issue", { issue: id, assignee: "@other" });
    expect(toOther.isError).toBe(false);
    expect(await assigneeOf()).toEqual({ type: "agent", id: other.id });
    await run("update_issue", { issue: id, assignee: "me" });
    expect(await assigneeOf()).toEqual({ type: "agent", id: f.agent.id });
    const toPerson = await run("update_issue", { issue: id, assignee: "bia" });
    expect(toPerson.isError).toBe(false);
    expect(await assigneeOf()).toEqual({ type: "person", id: bia.id });
    await run("update_issue", { issue: id, assignee: "none" });
    expect(await assigneeOf()).toBeNull();
  });

  test("update_issue places a card in a company and a board", async () => {
    f = await setup();
    const { crm } = await pipeline(f);
    const { run } = await agentTools(f);
    const id = issueOf((await run("create_issue", { title: "Solta" })).data);
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id })).project).toBeNull();

    const placed = await run("update_issue", { issue: id, project: "CRM", company: "Empresa A" });
    expect(placed.isError).toBe(false);
    expect(placed.content).toContain("Empresa A · CRM");
    const card = await getIssue(f.db, person(f.owner.id), f.org.id, { id });
    expect(card.project).toMatchObject({ id: crm.id, name: "CRM" });
    expect(card.project?.spaceId).toBeTruthy();

    const out = await run("update_issue", { issue: id, project: "none" });
    expect(out.isError).toBe(false);
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id })).project).toBeNull();
  });

  test("update_issue refuses a company alone and lists its boards", async () => {
    f = await setup();
    const { crm } = await pipeline(f);
    const { run } = await agentTools(f);
    const id = issueOf((await run("create_issue", { title: "Solta" })).data);

    const refused = await run("update_issue", { issue: id, company: "Empresa A" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("Empresa A");
    expect(refused.content).toContain('"CRM"');
    expect(refused.content).not.toContain('"Site"');
    // Nothing moved.
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id })).project).toBeNull();
    // A company that does not exist is refused with the ones that do.
    const unknown = await run("update_issue", { issue: id, company: "Nenhuma" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain('"Empresa A"');
    // Other fields alongside a company-only call change nothing either.
    expect((await run("update_issue", { issue: id, company: "Empresa A", priority: "high" })).isError).toBe(true);
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id })).priority).not.toBe("high");
    expect(crm.name).toBe("CRM");
  });

  test("update_issue picks the board by its company when two companies share a board name", async () => {
    f = await setup();
    const { deps, company, crm } = await pipeline(f);
    const second = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Empresa B" });
    const crmB = await createIssueProject(deps, f.owner.id, f.org.id, { name: "CRM", spaceId: second.id });
    const { run } = await agentTools(f);
    const id = issueOf((await run("create_issue", { title: "Lead" })).data);

    // Without the company the name is ambiguous, and nothing moves.
    const ambiguous = await run("update_issue", { issue: id, project: "CRM" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content).toContain("Empresa B");
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id })).project).toBeNull();

    expect((await run("update_issue", { issue: id, project: "CRM", company: "Empresa B" })).isError).toBe(false);
    expect((await getIssue(f.db, person(f.owner.id), f.org.id, { id })).project?.id).toBe(crmB.id);
    expect((await run("update_issue", { issue: id, project: "CRM", company: "Empresa A" })).isError).toBe(false);
    const card = await getIssue(f.db, person(f.owner.id), f.org.id, { id });
    expect(card.project).toMatchObject({ id: crm.id, spaceId: company.id });
  });

  test("refuses a column the board lacks", async () => {
    f = await setup();
    const { deps, site } = await pipeline(f);
    await createIssueColumn(deps, f.owner.id, f.org.id, { name: "Triagem", stage: "todo", projectId: site.id });
    const { run } = await agentTools(f);

    const onCreate = await run("create_issue", { title: "X", project: "CRM", column: "Triagem" });
    expect(onCreate.isError).toBe(true);
    expect(onCreate.content).toContain('There is no column named "Triagem"');
    expect(onCreate.content).toContain('"Ready for dev"');
    expect(onCreate.content).toContain('"QA"');
    expect(onCreate.content.split("The columns are:")[1]).not.toContain("Triagem");

    const id = issueOf((await run("create_issue", { title: "Y", project: "CRM" })).data);
    const onMove = await run("update_issue", { issue: id, column: "Triagem" });
    expect(onMove.isError).toBe(true);
    expect(onMove.content).toContain("The columns are:");
    expect(onMove.content).toContain('"Backlog"');
  });

  test("list_boards returns each board with its company and columns", async () => {
    f = await setup();
    await pipeline(f);
    const { run } = await agentTools(f);

    const boards = await run("list_boards");
    expect(boards.isError).toBe(false);
    const lines = boards.content.split("\n");
    // The company stands over its board; a board with no company is listed apart.
    const company = lines.indexOf("Empresa A");
    expect(company).toBeGreaterThanOrEqual(0);
    expect(lines[company + 1]).toContain("· CRM (0 open)");
    const loose = lines.indexOf("No company");
    expect(loose).toBeGreaterThan(company);
    expect(lines[loose + 1]).toContain("· Site (0 open)");
    // Each board's own columns, by stage.
    const crmColumns = lines.find((l) => l.startsWith("  · CRM:")) ?? "";
    expect(crmColumns).toContain('todo: "Backlog", "Especificar"');
    expect(crmColumns).toContain('in_review: "PR / Develop", "QA"');
    expect(crmColumns).not.toContain("(the workspace's)");
    const siteColumns = lines.find((l) => l.startsWith("  · Site:")) ?? "";
    expect(siteColumns).toContain("(the workspace's)");
  });

  test("the tools keep every field agents need", async () => {
    f = await setup();
    const { tools } = await agentTools(f);
    const fields = (name: string) => {
      const schema = tools.find((t) => t.name === name)?.inputSchema as { properties?: Record<string, unknown> };
      return Object.keys(schema?.properties ?? {});
    };
    expect(fields("create_issue")).toEqual(expect.arrayContaining(["column", "assignee", "company", "project"]));
    expect(fields("update_issue")).toEqual(
      expect.arrayContaining(["column", "status", "assignee", "company", "project"]),
    );
    expect(fields("list_issues")).toEqual(expect.arrayContaining(["company", "project"]));
    expect(tools.map((t) => t.name)).toContain("list_boards");
  });
});
