import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

type Alert = {
  id: string;
  agentId: string;
  agentName: string;
  columnId: string;
  fromColumnId: string | null;
  paused: boolean;
  pausedReason: string | null;
};
type Column = { id: string; stage: string; name: string | null };

async function board(owner: ReturnType<typeof browser>, orgId: string) {
  const org = `/api/app/organizations/${orgId}`;
  const project = (await (await owner(`${org}/issue-projects`, { json: { name: "CRM" } })).json()) as { id: string };
  const columns = (
    (await (await owner(`${org}/issue-columns?projectId=${project.id}`)).json()) as { columns: Column[] }
  ).columns;
  return { org, project, columns, base: `${org}/issue-projects/${project.id}/alerts` };
}

test("lists, adds and removes a rule", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const { project, columns, base } = await board(owner, orgId);
  const progress = columns.find((c) => c.stage === "in_progress");
  const todo = columns.find((c) => c.stage === "todo");

  expect(((await (await owner(base)).json()) as { alerts: Alert[] }).alerts).toEqual([]);

  const created = await owner(base, {
    json: { agentId, columnId: progress?.id, fromColumnId: todo?.id },
  });
  expect(created.status).toBe(201);
  const alert = (await created.json()) as Alert;
  expect(alert).toMatchObject({ agentId, agentName: "Dev", fromColumnId: expect.any(String), paused: false });

  const listed = ((await (await owner(base)).json()) as { alerts: Alert[] }).alerts;
  expect(listed.map((a) => a.id)).toEqual([alert.id]);
  // It is a routine too: the routines page shows it.
  const routines = (
    (await (await owner(`/api/app/organizations/${orgId}/routines`)).json()) as {
      routines: { id: string; trigger: { type: string; event?: string } }[];
    }
  ).routines;
  expect(routines.find((r) => r.id === alert.id)?.trigger).toMatchObject({ type: "event", event: "issue.moved" });

  const gone = await owner(`${base}/${alert.id}`, { method: "DELETE" });
  expect(gone.status).toBe(204);
  expect(((await (await owner(base)).json()) as { alerts: Alert[] }).alerts).toEqual([]);
  expect((await owner(`${base}/${alert.id}`, { method: "DELETE" })).status).toBe(404);
  expect(project.id).toBeTruthy();
});

test("refuses a rule the member may not make", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const { columns, base } = await board(owner, orgId);
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const progress = columns.find((c) => c.stage === "in_progress");

  const refused = await member(base, { json: { agentId, columnId: progress?.id } });
  expect(refused.status).toBe(403);
  const body = (await refused.json()) as { error: { message: string } };
  expect(body.error.message).toBeTruthy();
  expect(((await (await owner(base)).json()) as { alerts: Alert[] }).alerts).toEqual([]);

  // A column that isn't the board's is a validation error with its code, from the owner too.
  const other = await owner(base, { json: { agentId, columnId: "00000000-0000-7000-8000-000000000000" } });
  expect(other.status).toBe(400);
  expect(await other.json()).toMatchObject({ error: { code: "board_alert.column_not_on_board" } });
});
