import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createOrganization } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

type Api = (path: string, init?: Parameters<ReturnType<typeof browser>>[1]) => Promise<Response>;
type Home = {
  companies: { id: string; name: string; waiting: number; stages: { todo: number; in_review: number } }[];
  companiesTotal: number;
  waiting: { total: number; items: { id: string; number: number; title: string; spaceName: string }[] };
};

/**
 * Two companies: "Clínica Teo" has two tasks waiting for a person (one the owner limited to themselves) and one that
 * does not; "Oculta" has one task only the owner sees.
 */
async function factory(owner: ReturnType<typeof browser>, orgId: string, ownerId: string) {
  const api: Api = (path, init) => owner(`/api/app/organizations/${orgId}${path}`, init);
  const make = async (path: string, json: unknown) => (await (await api(path, { json })).json()) as { id: string };
  const teo = await make("/issue-spaces", { name: "Clínica Teo" });
  const hidden = await make("/issue-spaces", { name: "Oculta" });
  const teoBoard = await make("/issue-projects", { name: "Entregas", spaceId: teo.id });
  const hiddenBoard = await make("/issue-projects", { name: "Segredo", spaceId: hidden.id });
  const made = await api("/issue-columns", { json: { name: "Teste humano", stage: "in_review" } });
  const column = ((await made.json()) as { columns: { id: string; name: string | null }[] }).columns.find(
    (c) => c.name === "Teste humano",
  );
  if (!column) throw new Error("no column");
  const flag = await api(`/issue-columns/${column.id}`, { method: "PATCH", json: { waitsForPerson: true } });
  expect(flag.status).toBe(200);
  // A task is made, then moved into the flagged column (the move sets its stage).
  const inColumn = async (json: object) => {
    const task = await make("/issues", json);
    const moved = await api(`/issues/${task.id}`, { method: "PATCH", json: { columnId: column.id } });
    expect(moved.status).toBe(200);
    return task;
  };
  const waiting = (title: string, extra: object = {}) => inColumn({ title, projectId: teoBoard.id, ...extra });
  const shown = await waiting("Revisar a tela");
  const limited = await waiting("Só do dono", { audience: { mode: "people", userIds: [ownerId] } });
  await make("/issues", { title: "Sem espera", projectId: teoBoard.id });
  await inColumn({
    title: "Segredo do dono",
    projectId: hiddenBoard.id,
    audience: { mode: "people", userIds: [ownerId] },
  });
  return { api, shown, limited };
}

async function ownerId(orgId: string) {
  const [row] = await t.db
    .select({ userId: schema.organizationMembers.userId })
    .from(schema.organizationMembers)
    .where(eq(schema.organizationMembers.orgId, orgId));
  return row?.userId as string;
}

test("serves the factory to a member and refuses a stranger and a request without a session", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const { api } = await factory(owner, orgId, await ownerId(orgId));

  const res = await api("/factory-home");
  expect(res.status).toBe(200);
  const body = (await res.json()) as Home;
  expect(body.companies.map((c) => c.name).sort()).toEqual(["Clínica Teo", "Oculta"]);
  expect(body.waiting.total).toBe(3);
  expect(body.companiesTotal).toBe(2);

  // Another workspace, asked about by someone who is not in it.
  await t.db.insert(schema.users).values({ id: "user_other", name: "Other", email: "other@example.com" });
  const { organization } = await createOrganization(t.db, "user_other", { name: "Other" });
  expect((await owner(`/api/app/organizations/${organization.id}/factory-home`)).status).toBe(403);
  const anonymous = browser(t);
  expect((await anonymous(`/api/app/organizations/${orgId}/factory-home`)).status).toBe(401);
});

test("waiting person lists the flagged tasks and another value is refused", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const { api, shown, limited } = await factory(owner, orgId, await ownerId(orgId));

  const res = await api("/issues?waiting=person");
  expect(res.status).toBe(200);
  const ids = ((await res.json()) as { issues: { id: string }[] }).issues.map((i) => i.id);
  expect(ids).toContain(shown.id);
  expect(ids).toContain(limited.id);
  expect(ids).toHaveLength(3);

  expect((await api("/issues?waiting=anyone")).status).toBe(400);
  expect((await api("/issues?waiting=")).status).toBe(400);
});

test("the body holds nothing the viewer may not see", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const { api, shown } = await factory(owner, orgId, await ownerId(orgId));
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");

  const res = await member(`/api/app/organizations/${orgId}/factory-home`);
  expect(res.status).toBe(200);
  const raw = await res.text();
  const body = JSON.parse(raw) as Home;
  expect(body.companies.map((c) => c.name)).toEqual(["Clínica Teo"]);
  expect(body.companiesTotal).toBe(1);
  expect(body.companies[0]?.waiting).toBe(1);
  expect(body.waiting.total).toBe(1);
  expect(body.waiting.items.map((i) => i.id)).toEqual([shown.id]);
  for (const secret of ["Só do dono", "Segredo do dono", "Oculta", "Segredo"]) expect(raw).not.toContain(secret);

  // The list the filter serves holds the same: nothing limited to the owner.
  const list = await member(`/api/app/organizations/${orgId}/issues?waiting=person`);
  const issues = ((await list.json()) as { issues: { id: string; title: string }[] }).issues;
  expect(issues.map((i) => i.id)).toEqual([shown.id]);
  void api;
});
