import { afterEach, describe, expect, jest, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { createHttpApi } from "../src/api/http-client";
import { keys } from "../src/api/keys";
import {
  applyIssueEvent,
  applyPoProposalEvent,
  poProgressQuery,
  UNREAD_REFRESH_MS,
  UNREAD_SPREAD_MS,
} from "../src/api/queries";
import type { PoProgress, PoProgressCard, PoProgressGroup } from "../src/api/types";
import { columnsParam, specBadge, specReasonKey } from "../src/lib/po-progress";

const org = "/api/app/organizations/o1";

const card = (spec: PoProgressCard["spec"]): PoProgressCard => ({
  id: "i1",
  number: 12,
  title: "Tela de login",
  boardId: "b1",
  boardName: "Entregas",
  since: "2026-11-10T12:00:00.000Z",
  spec,
});
const todo = { stage: "todo" } as const;
const later = { stage: "in_progress" } as const;
const page = { slug: "specs/acme/12", title: "Spec 12" };

const progress: PoProgress = {
  space: { id: "s1", name: "Acme" },
  groups: [
    {
      key: "especificar",
      kind: "column",
      stage: "todo",
      name: "Especificar",
      columns: ["especificar"],
      count: 1,
      items: [card(null)],
    },
  ],
  done: 3,
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

describe("a card's spec badge", () => {
  test("a queued spec in a to-do group reads queued", () => {
    expect(specBadge(card({ state: "queued", page: null, error: null }), todo)).toEqual({ kind: "queued" });
  });

  test("a running spec reads running", () => {
    expect(specBadge(card({ state: "running", page: null, error: null }), todo)).toEqual({ kind: "running" });
  });

  test("a finished spec reads ready with its page, wherever the card sits", () => {
    const done = card({ state: "done", page, error: null });
    expect(specBadge(done, todo)).toEqual({ kind: "ready", page });
    expect(specBadge(done, later)).toEqual({ kind: "ready", page });
    // A page the reader may not open is still a ready spec, with no link.
    expect(specBadge(card({ state: "done", page: null, error: null }), later)).toEqual({ kind: "ready", page: null });
  });

  test("a failed or stopped spec reads failed with its reason, only in a to-do group", () => {
    expect(specBadge(card({ state: "failed", page: null, error: "no_spec_page" }), todo)).toEqual({
      kind: "failed",
      reason: "no_spec_page",
    });
    expect(specBadge(card({ state: "stopped", page: null, error: null }), todo)).toEqual({
      kind: "failed",
      reason: null,
    });
    expect(specBadge(card({ state: "failed", page: null, error: "x" }), later)).toBeNull();
    expect(specBadge(card({ state: "running", page: null, error: null }), later)).toBeNull();
  });

  test("a card with no spec has no badge", () => {
    expect(specBadge(card(null), todo)).toBeNull();
  });

  test("a failure's reason is a known code's words, a stop's own words, or a plain failure for any other text", () => {
    expect(specReasonKey("no_spec_page")).toBe("poCard.specReason.no_spec_page");
    expect(specReasonKey(null)).toBe("poCard.specReason.stopped");
    expect(specReasonKey("the model refused")).toBe("poCard.specReason.failed");
  });

  test("columnsParam joins a group's keys with a bar", () => {
    const g = { columns: ["em desenvolvimento", "revisão qa"] } as Pick<PoProgressGroup, "columns">;
    expect(columnsParam(g)).toBe("em desenvolvimento|revisão qa");
  });
});

describe("the progress through the client", () => {
  test("progress reads GET …/po/companies/<id>/progress and returns the body as it is", async () => {
    const { api, seen } = apiAnswering(progress);
    const out = await api.po.progress("o1", "s1");
    expect(seen).toEqual([{ method: "GET", url: `${org}/po/companies/s1/progress` }]);
    expect(out).toEqual(progress);
  });

  test("the list sends columns joined by a bar when asked and nothing about it otherwise", async () => {
    const asked = apiAnswering({ issues: [] });
    await asked.api.issues.list("o1", { spaceId: "s1", columns: ["especificar", "ready for dev"] });
    const query = new URL(`http://x${asked.seen[0]?.url}`).searchParams;
    expect(query.get("spaceId")).toBe("s1");
    expect(query.get("columns")).toBe("especificar|ready for dev");
    const plain = apiAnswering({ issues: [] });
    await plain.api.issues.list("o1", { q: "login" });
    expect(plain.seen[0]?.url).not.toContain("columns");
  });

  test("the panel asks on a key under the issues prefix and never on a timer", () => {
    const prefix = keys.issues("o1");
    expect(keys.poProgress("o1", "s1").slice(0, prefix.length)).toEqual([...prefix]);
    expect(keys.poProgress("o1", "s1")).not.toEqual(keys.poProgress("o1", "s2"));
    expect(keys.poProgress("o1", "s1").slice(0, keys.poProgress("o1").length)).toEqual([...keys.poProgress("o1")]);
    const options = poProgressQuery(createHttpApi({}), "o1", "s1");
    expect(options.queryKey).toEqual(keys.poProgress("o1", "s1"));
    for (const timer of ["refetchInterval", "refetchIntervalInBackground"]) expect(timer in options).toBe(false);
    // The list's key gains the column filter only when it is set.
    expect(keys.issueList("o1", "")).toEqual(["org", "o1", "issues", "list", "", "", ""]);
    expect(keys.issueList("o1", "", "", "s1", "", "", "a|b")).not.toEqual(keys.issueList("o1", "", "", "s1"));
  });
});

describe("the panel follows events", () => {
  afterEach(() => jest.useRealTimers());

  const seeded = () => {
    const qc = new QueryClient();
    qc.setQueryData(keys.poProgress("o1", "s1"), progress);
    qc.setQueryData(keys.poProgress("o2", "s1"), progress);
    return qc;
  };
  const stale = (qc: QueryClient, orgId = "o1") => qc.getQueryState(keys.poProgress(orgId, "s1"))?.isInvalidated;

  test("a card proposal update reads the panel at once", () => {
    const qc = seeded();
    applyPoProposalEvent(qc, "o1", { type: "card.proposal.updated" });
    expect(stale(qc)).toBe(true);
    // Another workspace's panel is left alone.
    expect(stale(qc, "o2")).toBe(false);
  });

  test("any other event leaves the panel alone", () => {
    const qc = seeded();
    applyPoProposalEvent(qc, "o1", { type: "message.created" });
    applyPoProposalEvent(qc, "o1", { type: "calendar.proposal.updated" });
    expect(stale(qc)).toBe(false);
  });

  test("a task event reads the panel again through the issues keys, once per burst", () => {
    jest.useFakeTimers();
    const qc = seeded();
    applyIssueEvent(qc, "o1", { type: "issue.updated" });
    applyIssueEvent(qc, "o1", { type: "issue.updated" });
    expect(stale(qc)).toBe(false);
    jest.advanceTimersByTime(UNREAD_REFRESH_MS + UNREAD_SPREAD_MS);
    expect(stale(qc)).toBe(true);
    expect(stale(qc, "o2")).toBe(false);
  });
});
