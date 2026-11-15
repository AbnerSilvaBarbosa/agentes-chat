import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

type Column = { id: string; name: string | null; stage: string; projectId: string | null; waitsForPerson: boolean };

async function boardWithColumn(owner: ReturnType<typeof browser>, orgId: string) {
  const org = `/api/app/organizations/${orgId}`;
  const board = (await (await owner(`${org}/issue-projects`, { json: { name: "Site" } })).json()) as { id: string };
  const made = await owner(`${org}/issue-columns`, {
    json: { name: "Teste humano", stage: "in_review", projectId: board.id },
  });
  const column = ((await made.json()) as { columns: Column[] }).columns.find((c) => c.name === "Teste humano");
  if (!column) throw new Error("no column");
  return { org, board, column };
}

test("PATCH with waitsForPerson flags the column of the board and answers the columns with the flag", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const { org, board, column } = await boardWithColumn(owner, orgId);
  expect(column.waitsForPerson).toBe(false);

  const on = await owner(`${org}/issue-columns/${column.id}`, {
    method: "PATCH",
    json: { waitsForPerson: true, projectId: board.id },
  });
  expect(on.status).toBe(200);
  const flagged = ((await on.json()) as { columns: Column[] }).columns;
  expect(flagged.find((c) => c.id === column.id)?.waitsForPerson).toBe(true);
  expect(flagged.filter((c) => c.waitsForPerson)).toHaveLength(1);

  const read = (await (await owner(`${org}/issue-columns?projectId=${board.id}`)).json()) as { columns: Column[] };
  expect(read.columns.filter((c) => c.waitsForPerson).map((c) => c.id)).toEqual([column.id]);

  const off = await owner(`${org}/issue-columns/${column.id}`, { method: "PATCH", json: { waitsForPerson: false } });
  expect(((await off.json()) as { columns: Column[] }).columns.some((c) => c.waitsForPerson)).toBe(false);
});

test("the flag works together with a name in one body", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const { org, board, column } = await boardWithColumn(owner, orgId);

  const both = await owner(`${org}/issue-columns/${column.id}`, {
    method: "PATCH",
    json: { name: "QA humano", waitsForPerson: true, projectId: board.id },
  });
  expect(both.status).toBe(200);
  const got = ((await both.json()) as { columns: Column[] }).columns.find((c) => c.id === column.id);
  expect(got).toMatchObject({ name: "QA humano", waitsForPerson: true });
});

test("answers 403 for a member without the right and leaves the flag", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const { org, board, column } = await boardWithColumn(owner, orgId);
  const member = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const { roles } = (await (await owner(`${org}/roles`)).json()) as {
    roles: { id: string; kind: string; permissions: string[] }[];
  };
  const everyone = roles.find((r) => r.kind === "everyone");
  const trimmed = await owner(`${org}/roles/${everyone?.id}`, {
    method: "PATCH",
    json: { permissions: (everyone?.permissions ?? []).filter((p) => p !== "post") },
  });
  expect(trimmed.status).toBe(204);

  const refused = await member(`${org}/issue-columns/${column.id}`, {
    method: "PATCH",
    json: { waitsForPerson: true, projectId: board.id },
  });
  expect(refused.status).toBe(403);
  const read = (await (await owner(`${org}/issue-columns?projectId=${board.id}`)).json()) as { columns: Column[] };
  expect(read.columns.find((c) => c.id === column.id)?.waitsForPerson).toBe(false);
});

test("a column that is not in the workspace is a 404", async () => {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId } = await seedOrg(owner);
  const res = await owner(`/api/app/organizations/${orgId}/issue-columns/00000000-0000-7000-8000-000000000000`, {
    method: "PATCH",
    json: { waitsForPerson: true },
  });
  expect(res.status).toBe(404);
});
