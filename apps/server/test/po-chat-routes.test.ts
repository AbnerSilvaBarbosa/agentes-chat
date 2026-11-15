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

test("the routes list, open, confirm and refuse a second decision", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const api = (b: typeof owner, path: string, init?: Parameters<typeof owner>[1]) =>
    b(`/api/app/organizations/${orgId}${path}`, init);
  const company = async (name: string) =>
    (await (await api(owner, "/issue-spaces", { json: { name } })).json()) as { id: string };
  const acme = await company("Acme Corp");

  // No PO: nothing to list, and opening is refused.
  expect(await (await api(owner, "/po")).json()).toEqual({ agentId: null, companies: [] });
  expect((await api(owner, "/po/chats", { json: { spaceId: acme.id } })).status).toBe(400);

  await api(owner, "/settings", { method: "PATCH", json: { poAgentId: agentId } });
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const listed = (await (await api(bia, "/po")).json()) as {
    agentId: string;
    companies: { id: string; name: string; open: number; channelId: string | null }[];
  };
  expect(listed.agentId).toBe(agentId);
  expect(listed.companies.map((c) => [c.name, c.open, c.channelId])).toEqual([["Acme Corp", 0, null]]);

  const opened = await api(bia, "/po/chats", { json: { spaceId: acme.id } });
  expect(opened.status).toBe(200);
  const chat = (await opened.json()) as { channelId: string; agentId: string; space: { id: string; name: string } };
  expect(chat).toMatchObject({ agentId, space: { id: acme.id, name: "Acme Corp" } });
  // The same chat again, and it now shows in the list.
  expect(((await (await api(bia, "/po/chats", { json: { spaceId: acme.id } })).json()) as typeof chat).channelId).toBe(
    chat.channelId,
  );
  expect(((await (await api(bia, "/po")).json()) as typeof listed).companies[0]?.channelId).toBe(chat.channelId);

  // A company that does not exist in this workspace is a 404.
  expect((await api(bia, "/po/chats", { json: { spaceId: "00000000-0000-4000-8000-000000000000" } })).status).toBe(404);
});
