import { describe, expect, test } from "bun:test";
import { createHttpApi } from "../src/api/http-client";
import type { IssueColumn, IssueColumnTemplate } from "../src/api/types";

const org = "/api/app/organizations/o1";

const column = (over: Partial<IssueColumn> = {}): IssueColumn => ({
  id: "c1",
  stage: "in_review",
  name: "Teste humano",
  position: 0,
  projectId: "b1",
  waitsForPerson: false,
  ...over,
});

function apiAnswering(body: unknown) {
  const seen: { method: string; url: string; body: unknown }[] = [];
  const api = createHttpApi({
    fetch: async (url: string, init: RequestInit) => {
      seen.push({ method: String(init.method), url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { api, seen };
}

describe("a column's flag through the client", () => {
  test("updateColumn sends the flag with the board's id as a PATCH and returns the columns with the flag", async () => {
    const { api, seen } = apiAnswering({ columns: [column({ waitsForPerson: true })] });
    const out = await api.issues.updateColumn("o1", "c1", { waitsForPerson: true, projectId: "b1" });
    expect(seen).toEqual([
      { method: "PATCH", url: `${org}/issue-columns/c1`, body: { waitsForPerson: true, projectId: "b1" } },
    ]);
    expect(out[0]?.waitsForPerson).toBe(true);
  });

  test("a rename sends no flag, so it cannot clear one", async () => {
    const { api, seen } = apiAnswering({ columns: [column()] });
    await api.issues.updateColumn("o1", "c1", { name: "QA" });
    expect(seen[0]?.body).toEqual({ name: "QA" });
  });

  test("the columns of a board read with their flags", async () => {
    const { api } = apiAnswering({ columns: [column({ waitsForPerson: true }), column({ id: "c2" })] });
    const read = await api.issues.columns("o1", "b1");
    expect(read.map((c) => c.waitsForPerson)).toEqual([true, false]);
  });

  test("a status set's columns carry the flag both ways", async () => {
    const set: IssueColumnTemplate = {
      id: "t1",
      name: "Entrega",
      seeded: false,
      columns: [
        { name: "Fazer", stage: "todo" },
        { name: "Teste humano", stage: "in_review", waitsForPerson: true },
      ],
    };
    const { api, seen } = apiAnswering({ templates: [set] });
    const out = await api.issues.updateColumnTemplate("o1", "t1", { columns: set.columns });
    expect(seen[0]).toMatchObject({ method: "PUT", url: `${org}/issue-column-templates/t1` });
    expect(seen[0]?.body).toEqual({ columns: set.columns });
    expect(out[0]?.columns[1]?.waitsForPerson).toBe(true);
    expect(out[0]?.columns[0]?.waitsForPerson).toBeUndefined();
  });
});
