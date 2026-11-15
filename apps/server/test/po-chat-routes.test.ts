import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { insertMessage, proposeCard } from "@agenteschat/engine";
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

  // A PO's proposal in bia's chat (what its tool writes in a run): a board of the company, a message of hers, a run.
  const board = (await (
    await api(owner, "/issue-projects", { json: { name: "Entregas", spaceId: acme.id } })
  ).json()) as { id: string };
  const [biaUser] = await t.db.select().from(schema.users).where(eq(schema.users.email, "bia@example.com"));
  if (!biaUser) throw new Error("no user");
  const propose = async (title: string) => {
    const trigger = await insertMessage(t.db, {
      orgId,
      channelId: chat.channelId,
      author: { type: "person", userId: biaUser.id },
      body: title,
    });
    const [run] = await t.db
      .insert(schema.agentRuns)
      .values({
        orgId,
        agentId,
        channelId: chat.channelId,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
        trigger: "mention",
        hop: 1,
        status: "running",
      })
      .returning();
    if (!run) throw new Error("no run");
    return proposeCard(
      { db: t.db },
      {
        orgId,
        agentId,
        runId: run.id,
        channelId: chat.channelId,
        threadRootId: trigger.id,
        triggerMessageId: trigger.id,
      },
      { title, summary: "Resumo", criteria: ["um", "dois"], board: "Entregas" },
    );
  };
  const issuesNow = async () => (await t.db.select().from(schema.issues)).length;
  const first = await propose("Tela de login");
  const second = await propose("Cadastro");
  const confirm = (b: typeof owner, id: string, edits?: Record<string, unknown>) =>
    api(b, `/card-proposals/${id}/confirm`, { json: edits ?? {} });
  const dismiss = (b: typeof owner, id: string) => api(b, `/card-proposals/${id}/dismiss`, { json: {} });

  // Another person (even the owner) does not decide for her: 403, and nothing is created.
  expect((await confirm(owner, first.id)).status).toBe(403);
  expect((await dismiss(owner, first.id)).status).toBe(403);
  expect(await issuesNow()).toBe(0);

  // Confirm with an edited title returns the view with the created card.
  const confirmed = await confirm(bia, first.id, { title: "Tela de entrada" });
  expect(confirmed.status).toBe(200);
  const view = (await confirmed.json()) as {
    id: string;
    status: string;
    title: string;
    project: { id: string; name: string };
    issue: { id: string; number: number } | null;
  };
  expect(view).toMatchObject({ id: first.id, status: "confirmed", title: "Tela de entrada" });
  expect(view.project).toEqual({ id: board.id, name: "Entregas" });
  expect(view.issue?.number).toBeGreaterThan(0);
  expect(await issuesNow()).toBe(1);

  // A second decision on it, either way, is refused with its own code and creates nothing.
  for (const again of [await confirm(bia, first.id), await dismiss(bia, first.id)]) {
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: { code: "card_proposal.decided" } });
  }
  expect(await issuesNow()).toBe(1);

  // Dismiss returns the dismissed view and creates nothing; confirming it afterwards is refused.
  const dismissed = await dismiss(bia, second.id);
  expect(dismissed.status).toBe(200);
  expect(await dismissed.json()).toMatchObject({ id: second.id, status: "dismissed", issue: null });
  expect(await issuesNow()).toBe(1);
  expect(await (await confirm(bia, second.id)).json()).toMatchObject({ error: { code: "card_proposal.decided" } });

  // The card's own refusal answers its error and the proposal stays pending: an archived board.
  const third = await propose("Relatorios");
  await api(owner, `/issue-projects/${board.id}`, { method: "PATCH", json: { archived: true } });
  const refused = await confirm(bia, third.id);
  expect(refused.status).toBe(400);
  expect(await refused.json()).toMatchObject({ error: { code: "issue_project.archived" } });
  expect(await issuesNow()).toBe(1);
  const [still] = await t.db.select().from(schema.poCardProposals).where(eq(schema.poCardProposals.id, third.id));
  expect(still?.status).toBe("pending");
  // A proposal that is not in this workspace is a 404.
  expect((await confirm(bia, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
});
