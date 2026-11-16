import { describe, expect, test } from "bun:test";
import type { PoProgressCard, PoProgressGroup } from "../src/api/types";
import { hasLiveSpec, isBacklog, liveSpecs, specElapsed } from "../src/lib/po-progress";

const live = (id: string, state: "queued" | "running" | "done", queuedAt: string | null = null): PoProgressCard => ({
  id,
  number: 12,
  title: "Tela de login",
  boardId: "b1",
  boardName: "Entregas",
  since: "2026-11-10T12:00:00.000Z",
  spec: { state, page: null, error: null, queuedAt },
});

const col = (key: string, stage: PoProgressGroup["stage"], items: PoProgressCard[]): PoProgressGroup => ({
  key,
  kind: "column",
  stage,
  name: key,
  columns: [key],
  count: items.length,
  items,
});

describe("the live specs block", () => {
  test("lists queued and running cards of the to-do stage, running first", () => {
    const groups = [
      col("backlog", "todo", [live("q", "queued"), live("d", "done")]),
      col("especificar", "todo", [live("r", "running")]),
      col("ready", "in_progress", [live("late", "running")]),
    ];
    expect(liveSpecs(groups).map((l) => [l.card.id, l.state])).toEqual([
      ["r", "running"],
      ["q", "queued"],
    ]);
  });

  test("a group with a live spec says so, and only the to-do column named backlog is a backlog", () => {
    expect(hasLiveSpec(col("backlog", "todo", [live("q", "queued")]))).toBe(true);
    expect(hasLiveSpec(col("backlog", "todo", [live("d", "done")]))).toBe(false);
    expect(isBacklog(col("backlog", "todo", []))).toBe(true);
    expect(isBacklog(col("especificar", "todo", []))).toBe(false);
    expect(isBacklog(col("backlog", "in_progress", []))).toBe(false);
  });

  test("the elapsed time counts from the queued time, else the column's, in whole minutes, never below zero", () => {
    const queued = live("a", "running", "2026-11-16T08:30:30Z");
    expect(specElapsed(queued, Date.parse("2026-11-16T10:00:00Z"))).toEqual({ hours: 1, minutes: 29 });
    expect(specElapsed(live("b", "running"), Date.parse("2026-11-10T12:07:59Z"))).toEqual({ hours: 0, minutes: 7 });
    expect(specElapsed(queued, Date.parse("2026-11-16T07:00:00Z"))).toEqual({ hours: 0, minutes: 0 });
  });
});
