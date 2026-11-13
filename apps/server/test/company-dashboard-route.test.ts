import { afterEach, beforeEach, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createIssueSpace, createOrganization } from "@agenteschat/engine";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

/** A company with one board and two tasks, one assigned to the agent. */
async function company(owner: ReturnType<typeof browser>, orgId: string, agentId: string) {
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const space = (await (await api("/issue-spaces", { json: { name: "Clínica Teo" } })).json()) as { id: string };
  const board = (await (await api("/issue-projects", { json: { name: "Entregas", spaceId: space.id } })).json()) as {
    id: string;
  };
  await api("/issues", { json: { title: "A", projectId: board.id, assignee: { type: "agent", id: agentId } } });
  await api("/issues", { json: { title: "B", projectId: board.id } });
  return { api, spaceId: space.id };
}

test("serves the numbers of a company for the period asked and falls back to 30 days", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const { api, spaceId } = await company(owner, orgId, agentId);

  const res = await api(`/issue-spaces/${spaceId}/dashboard?days=7`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    days: number;
    total: number;
    stages: { todo: number };
    unassigned: number;
    assignees: { type: string; open: number }[];
    weekly: unknown[];
  };
  expect(body).toMatchObject({ days: 7, total: 2, stages: { todo: 2 }, unassigned: 1 });
  expect(body.assignees).toMatchObject([{ type: "agent", open: 1 }]);
  expect(body.weekly.length).toBeGreaterThanOrEqual(2);
  expect(((await (await api(`/issue-spaces/${spaceId}/dashboard?days=14`)).json()) as { days: number }).days).toBe(30);
  expect(((await (await api(`/issue-spaces/${spaceId}/dashboard`)).json()) as { days: number }).days).toBe(30);
});

test("leaves the cost out of the body without usage access", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const { api, spaceId } = await company(owner, orgId, agentId);
  const member = await joinByInvitation(t, owner, orgId, "member@example.com");

  const ownerBody = (await (await api(`/issue-spaces/${spaceId}/dashboard`)).json()) as Record<string, unknown>;
  expect(ownerBody.cost).toEqual({ totalUsd: 0, byAgent: [] });

  const res = await member(`/api/app/organizations/${orgId}/issue-spaces/${spaceId}/dashboard`);
  expect(res.status).toBe(200);
  const raw = await res.text();
  expect("cost" in (JSON.parse(raw) as object)).toBe(false);
  expect(raw).not.toContain("totalUsd");
  expect(JSON.parse(raw)).toMatchObject({ total: 2 });
});

test("answers not found for a space of another workspace", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  // Another workspace's company, asked about through this one.
  const stranger = "user_stranger";
  await t.db.insert(schema.users).values({ id: stranger, name: "Stranger", email: "stranger@example.com" });
  const { organization } = await createOrganization(t.db, stranger, { name: "Other" });
  const foreign = await createIssueSpace({ db: t.db }, stranger, organization.id, { name: "Not yours" });
  const res = await owner(`/api/app/organizations/${orgId}/issue-spaces/${foreign.id}/dashboard`);
  expect(res.status).toBe(404);
});
