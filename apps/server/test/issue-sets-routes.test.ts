import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

type Set = { id: string; name: string; seeded: boolean; columns: { name: string; stage: string }[] };

test("status sets API: create with columns, rename, replace the columns, list", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}/issue-column-templates`;

  const created = await owner(base, {
    json: {
      name: "Vendas",
      columns: [
        { name: "Lead", stage: "todo" },
        { name: "Fechado", stage: "done" },
      ],
    },
  });
  expect(created.status).toBe(201);
  const set = (await created.json()) as Set;
  expect(set).toMatchObject({ name: "Vendas", seeded: false });
  expect(set.columns.map((c) => c.name)).toEqual(["Lead", "Fechado"]);

  const renamed = await owner(`${base}/${set.id}`, { method: "PUT", json: { name: "Comercial" } });
  expect(renamed.status).toBe(200);
  const afterRename = ((await renamed.json()) as { templates: Set[] }).templates;
  expect(afterRename.find((s) => s.id === set.id)).toMatchObject({ name: "Comercial" });
  expect(afterRename.filter((s) => s.seeded).map((s) => s.name)).toEqual(["Kanban", "Desenvolvimento"]);

  const edited = await owner(`${base}/${set.id}`, {
    method: "PUT",
    json: { columns: [{ name: "Contato", stage: "in_progress" }] },
  });
  const listed = ((await edited.json()) as { templates: Set[] }).templates;
  expect(listed.find((s) => s.id === set.id)?.columns).toEqual([{ name: "Contato", stage: "in_progress" }]);
  expect(((await (await owner(base)).json()) as { templates: Set[] }).templates.map((s) => s.name)).toContain(
    "Comercial",
  );

  // The older body still copies a board's columns.
  const copied = await owner(base, { json: { name: "Cópia" } });
  expect(copied.status).toBe(201);
});

test("status sets API: a refusal returns the engine's code, a bad body is a validation error", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const base = `/api/app/organizations/${orgId}/issue-column-templates`;
  const lead = [{ name: "Lead", stage: "todo" }];

  const long = await owner(base, { json: { name: "x".repeat(41), columns: lead } });
  expect(long.status).toBe(400);
  expect(await long.json()).toMatchObject({ error: { code: "issue_template.name_invalid" } });
  const empty = await owner(base, { json: { name: "Vazio", columns: [] } });
  expect(empty.status).toBe(400);
  expect(await empty.json()).toMatchObject({ error: { code: "issue_template.empty" } });
  const taken = await owner(base, { json: { name: "kanban", columns: lead } });
  expect(taken.status).toBe(400);
  expect(await taken.json()).toMatchObject({ error: { code: "issue_template.name_taken" } });

  const made = (await (await owner(base, { json: { name: "Vendas", columns: lead } })).json()) as Set;
  const clear = await owner(`${base}/${made.id}`, { method: "PUT", json: { columns: [] } });
  expect(clear.status).toBe(400);
  expect(await clear.json()).toMatchObject({ error: { code: "issue_template.empty" } });
  // Not the body's shape: a stage that is not one.
  const bad = await owner(`${base}/${made.id}`, { method: "PUT", json: { columns: [{ name: "A", stage: "nope" }] } });
  expect(bad.status).toBe(400);
  const unknown = await owner(`${base}/00000000-0000-7000-8000-000000000000`, { method: "PUT", json: { name: "Z" } });
  expect(unknown.status).toBe(404);
});

test("status sets API: a member who may not create tasks is forbidden", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const org = `/api/app/organizations/${orgId}`;
  const base = `${org}/issue-column-templates`;
  const made = (await (
    await owner(base, { json: { name: "Vendas", columns: [{ name: "Lead", stage: "todo" }] } })
  ).json()) as Set;

  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  // Every member's base role loses the permission to post (and so to create tasks).
  const { roles } = (await (await owner(`${org}/roles`)).json()) as {
    roles: { id: string; kind: string; permissions: string[] }[];
  };
  const everyone = roles.find((r) => r.kind === "everyone");
  const trimmed = await owner(`${org}/roles/${everyone?.id}`, {
    method: "PATCH",
    json: { permissions: (everyone?.permissions ?? []).filter((p) => p !== "post") },
  });
  expect(trimmed.status).toBe(204);

  const create = await member(base, { json: { name: "Z", columns: [{ name: "A", stage: "todo" }] } });
  expect(create.status).toBe(403);
  const edit = await member(`${base}/${made.id}`, { method: "PUT", json: { name: "Z" } });
  expect(edit.status).toBe(403);
  // Reading stays open to them.
  expect((await member(base)).status).toBe(200);
});
