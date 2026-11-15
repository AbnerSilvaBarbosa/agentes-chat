import { describe, expect, test } from "bun:test";
import { createHttpApi } from "../src/api/http-client";
import { keys } from "../src/api/keys";
import type { FactoryHome } from "../src/api/types";

const org = "/api/app/organizations/o1";

const home: FactoryHome = {
  companies: [
    {
      id: "s1",
      name: "Clínica Teo",
      color: "red",
      image: null,
      stages: { todo: 2, in_progress: 1, in_review: 3, done: 4 },
      late: 1,
      waiting: 2,
    },
  ],
  companiesTotal: 1,
  waiting: {
    total: 2,
    items: [
      {
        id: "i1",
        number: 12,
        title: "Revisar a tela",
        stage: "in_review",
        spaceId: "s1",
        spaceName: "Clínica Teo",
        projectId: "b1",
        projectName: "Entregas",
        columnName: "Teste humano",
        since: "2026-11-10T12:00:00.000Z",
      },
    ],
  },
};

function apiAnswering(body: unknown) {
  const seen: { method: string; url: string }[] = [];
  const api = createHttpApi({
    fetch: async (url: string, init: RequestInit) => {
      seen.push({ method: String(init.method), url });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { api, seen };
}

describe("the factory home through the client", () => {
  test("factoryHome reads GET …/factory-home and returns the body as it is", async () => {
    const { api, seen } = apiAnswering(home);
    const out = await api.issues.factoryHome("o1");
    expect(seen).toEqual([{ method: "GET", url: `${org}/factory-home` }]);
    expect(out).toEqual(home);
  });

  test("the list sends waiting=person when asked and nothing about it otherwise", async () => {
    const asked = apiAnswering({ issues: [] });
    await asked.api.issues.list("o1", { waiting: "person" });
    expect(asked.seen[0]?.url).toBe(`${org}/issues?waiting=person`);

    const plain = apiAnswering({ issues: [] });
    await plain.api.issues.list("o1", { q: "login" });
    expect(plain.seen[0]?.url).toBe(`${org}/issues?q=login`);
    expect(plain.seen[0]?.url).not.toContain("waiting");

    const both = apiAnswering({ issues: [] });
    await both.api.issues.list("o1", { spaceId: "s1", waiting: "person" });
    const query = new URL(`http://x${both.seen[0]?.url}`).searchParams;
    expect(query.get("spaceId")).toBe("s1");
    expect(query.get("waiting")).toBe("person");
  });
});

describe("the factory's query key", () => {
  test("sits under the issues prefix, so a task event refreshes it", () => {
    const prefix = keys.issues("o1");
    expect(keys.factoryHome("o1").slice(0, prefix.length)).toEqual([...prefix]);
    expect(keys.factoryHome("o1")).not.toEqual(keys.factoryHome("o2"));
  });

  test("a list key gains the waiting filter only when it is set", () => {
    expect(keys.issueList("o1", "")).toEqual(["org", "o1", "issues", "list", "", "", ""]);
    expect(keys.issueList("o1", "", "", "", "me")).toEqual(["org", "o1", "issues", "list", "", "", "", "me"]);
    const waiting = keys.issueList("o1", "", "", "", "", "person");
    expect(waiting).not.toEqual(keys.issueList("o1", ""));
    expect(waiting).not.toEqual(keys.issueList("o1", "", "", "", "person"));
    expect(waiting).toContain("person");
    // The same filter with another assignee is another list.
    expect(keys.issueList("o1", "", "", "", "me", "person")).not.toEqual(waiting);
  });
});
