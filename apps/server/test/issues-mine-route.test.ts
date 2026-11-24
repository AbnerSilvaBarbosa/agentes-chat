import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["ok"] }) });
});
afterEach(() => t.close());

test("assignee=me lists only the caller's own tasks, canceled ones left out (the member's own page)", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const meId = ((await (await owner("/api/app/me")).json()) as { user: { id: string } }).user.id;
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const make = async (title: string, assignee: { type: "person" | "agent"; id: string } | null) =>
    (await (await api("/issues", { json: { title, assignees: assignee ? [assignee] : [] } })).json()) as { id: string };
  await make("Minha aberta", { type: "person", id: meId });
  const dropped = await make("Minha cancelada", { type: "person", id: meId });
  await api(`/issues/${dropped.id}`, { method: "PATCH", json: { status: "canceled" } });
  await make("Do agente", { type: "agent", id: agentId });
  await make("De ninguém", null);

  const titles = async (query: string) =>
    ((await (await api(`/issues${query}`)).json()) as { issues: { title: string }[] }).issues
      .map((i) => i.title)
      .sort();
  expect(await titles("?assignee=me")).toEqual(["Minha aberta"]);
  // Without it the same call lists everything, so the filter is what narrows it.
  expect(await titles("")).toEqual(["De ninguém", "Do agente", "Minha aberta", "Minha cancelada"]);
  // A value other than `me` is refused: no one reads another person's list through it.
  expect((await api(`/issues?assignee=${agentId}`)).status).toBe(400);
});
