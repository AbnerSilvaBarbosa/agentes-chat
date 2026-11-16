import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createIssueSpace, createOrganization } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

type Progress = {
  space: { id: string; name: string };
  groups: {
    key: string;
    kind: string;
    columns: string[];
    count: number;
    items: { number: number; title: string; boardName: string }[];
  }[];
  done: number;
};

/** A company "Clínica Teo" with a board "Entregas": two open cards, one done, one only the owner sees. */
async function scene() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const make = async (path: string, json: unknown) => (await (await api(path, { json })).json()) as { id: string };
  const space = await make("/issue-spaces", { name: "Clínica Teo" });
  const board = await make("/issue-projects", { name: "Entregas", spaceId: space.id });
  const task = (title: string, extra: object = {}) => make("/issues", { title, projectId: board.id, ...extra });
  await task("Tela de login");
  await task("Tela de pagamento");
  const finished = await task("Já feito");
  await api(`/issues/${finished.id}`, { method: "PATCH", json: { status: "done" } });
  const [member] = await t.db.select({ userId: schema.organizationMembers.userId }).from(schema.organizationMembers);
  await task("Só do dono", { audience: { mode: "people", userIds: [member?.userId] } });
  return { owner, orgId, api, spaceId: space.id };
}

test("GET progress gives the reader the groups and counts of their company", async () => {
  const { orgId, api, spaceId, owner } = await scene();
  const res = await api(`/po/companies/${spaceId}/progress`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as Progress;
  expect(body.space).toEqual({ id: spaceId, name: "Clínica Teo" });
  expect(body.done).toBe(1);
  const first = body.groups[0];
  expect(first?.kind).toBe("column");
  const open = body.groups.reduce((n, g) => n + g.count, 0);
  expect(open).toBe(3);
  expect(
    body.groups
      .flatMap((g) => g.items)
      .map((i) => `${i.title}@${i.boardName}`)
      .sort(),
  ).toEqual(["Só do dono@Entregas", "Tela de login@Entregas", "Tela de pagamento@Entregas"]);

  // A member who is not the audience of the limited card reads two; a stranger gets 403, no session 401.
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const seen = (await (
    await member(`/api/app/organizations/${orgId}/po/companies/${spaceId}/progress`)
  ).json()) as Progress;
  expect(seen.groups.reduce((n, g) => n + g.count, 0)).toBe(2);
  expect(JSON.stringify(seen)).not.toContain("Só do dono");
  await t.db.insert(schema.users).values({ id: "user_other", name: "Other", email: "other@example.com" });
  const { organization } = await createOrganization(t.db, "user_other", { name: "Other" });
  expect((await owner(`/api/app/organizations/${organization.id}/po/companies/${spaceId}/progress`)).status).toBe(403);
  expect((await browser(t)(`/api/app/organizations/${orgId}/po/companies/${spaceId}/progress`)).status).toBe(401);
});

test("GET progress is not found for a company of another workspace", async () => {
  const { api } = await scene();
  await t.db.insert(schema.users).values({ id: "user_other", name: "Other", email: "other@example.com" });
  const { organization } = await createOrganization(t.db, "user_other", { name: "Other" });
  const foreign = await createIssueSpace({ db: t.db }, "user_other", organization.id, { name: "Da outra" });
  expect((await api(`/po/companies/${foreign.id}/progress`)).status).toBe(404);
});

test("GET issues with columns lists only the tasks in those columns", async () => {
  const { api, spaceId } = await scene();
  const progress = (await (await api(`/po/companies/${spaceId}/progress`)).json()) as Progress;
  const filled = progress.groups.find((g) => g.count > 0);
  const keys = (filled?.columns ?? []).join("|");
  const ids = async (columns: string) =>
    (
      (await (await api(`/issues?columns=${encodeURIComponent(columns)}`)).json()) as { issues: { title: string }[] }
    ).issues
      .map((i) => i.title)
      .sort();
  expect(await ids(keys)).toEqual(["Só do dono", "Tela de login", "Tela de pagamento"]);
  expect(await ids("nenhuma coluna")).toEqual([]);
});
