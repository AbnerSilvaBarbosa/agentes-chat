import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer();
});
afterEach(() => t.close());

test("the settings route stores the PO for who may configure, returns it to every member and refuses anyone else", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (b: typeof owner, path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);

  // No PO yet: the field reads null.
  expect(await (await api(owner, "/settings")).json()).toMatchObject({ poAgentId: null });

  const saved = await api(owner, "/settings", { method: "PATCH", json: { poAgentId: agentId } });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ poAgentId: agentId });

  // Every member reads it; one who may not configure cannot change it.
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  expect(await (await api(bia, "/settings")).json()).toMatchObject({ poAgentId: agentId });
  expect((await api(bia, "/settings", { method: "PATCH", json: { poAgentId: null } })).status).toBe(403);
  expect(await (await api(owner, "/settings")).json()).toMatchObject({ poAgentId: agentId });

  // An agent that is not in the workspace is refused; null clears it.
  const unknown = await api(owner, "/settings", {
    method: "PATCH",
    json: { poAgentId: "00000000-0000-4000-8000-000000000000" },
  });
  expect(unknown.status).toBe(400);
  expect(await (await api(owner, "/settings", { method: "PATCH", json: { poAgentId: null } })).json()).toMatchObject({
    poAgentId: null,
  });
});
