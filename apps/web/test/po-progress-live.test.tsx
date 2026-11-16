import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { domWindow, setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { PoProgress, PoProgressCard, PoProgressGroup, PoProgressSpec } from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { PoProgressPanel } from "@/components/po/PoProgressPanel";
import { createFakeApi, seedState } from "./fake-api";
import { renderPage, screen, settle } from "./render";

const reduce = (value: "reduce" | "no-preference") => {
  domWindow().happyDOM.settings.device.prefersReducedMotion = value;
};

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // Storage may be blocked.
  }
  reduce("no-preference");
});
afterEach(() => {
  cleanup();
  reduce("reduce");
});

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const spec = (state: PoProgressSpec["state"], queuedAt: string | null = null): PoProgressSpec => ({
  state,
  page: null,
  error: null,
  queuedAt,
});

const card = (over: Partial<PoProgressCard> = {}): PoProgressCard => ({
  id: "c1",
  number: 12,
  title: "Tela de login",
  boardId: "b1",
  boardName: "Entregas",
  since: minutesAgo(180),
  spec: null,
  ...over,
});

const group = (key: string, name: string, items: PoProgressCard[], over: Partial<PoProgressGroup> = {}) => ({
  key,
  kind: "column" as const,
  stage: "todo" as const,
  name,
  columns: [key],
  count: items.length,
  items,
  ...over,
});

const progress = (groups: PoProgressGroup[]): PoProgress => ({
  space: { id: "s-acme", name: "Acme" },
  groups,
  done: 0,
});

const withState = (data: PoProgress) => {
  const state = seedState();
  state.poProgress = { "s-acme": data };
  return state;
};

async function show(data: PoProgress) {
  const state = withState(data);
  await renderPage(<PoProgressPanel spaceId="s-acme" />, { api: createFakeApi(state), org: true });
  await settle(4);
  return state;
}

const live = () => document.querySelector(".po-live") as HTMLElement | null;
const names = () => [...document.querySelectorAll(".po-group")].map((s) => s.getAttribute("aria-label"));
const many = (n: number, from = 100) =>
  Array.from({ length: n }, (_, i) => card({ id: `b${i}`, number: from + i, title: `Card ${i}` }));

describe("the Gerando spec block", () => {
  test("is not drawn when no spec is queued or running", async () => {
    await show(
      progress([
        group("especificar", "Especificar", [card({ spec: spec("failed") }), card({ id: "d", spec: spec("done") })]),
      ]),
    );
    expect(live()).toBeNull();
    expect(document.querySelector(".po-pix")).toBeNull();
  });

  test("is the first thing in the panel, above every group, with a row per live card", async () => {
    await show(
      progress([
        group("backlog", "Backlog", many(3)),
        group("especificar", "Especificar", [
          card({ id: "q", number: 7, title: "Na fila aqui", spec: spec("queued", minutesAgo(2)) }),
          card({ id: "r", number: 8, title: "Rodando aqui", spec: spec("running", minutesAgo(5)) }),
        ]),
      ]),
    );
    const block = live() as HTMLElement;
    expect(block).toBeTruthy();
    expect(block.nextElementSibling?.classList.contains("po-group")).toBe(true);
    expect(block.previousElementSibling?.classList.contains("po-prog__head")).toBe(true);
    expect(block.querySelector("h3")?.textContent).toBe("Gerando spec2");
    const rows = [...block.querySelectorAll(".po-live__row")];
    // Running first, then the queue.
    expect(rows.map((r) => r.querySelector(".po-row__title")?.textContent)).toEqual([
      "#8 Rodando aqui",
      "#7 Na fila aqui",
    ]);
  });

  test("a row says how long it has waited on a minute clock", async () => {
    await show(
      progress([
        group("especificar", "Especificar", [
          card({ id: "a", number: 1, spec: spec("running", minutesAgo(5)) }),
          card({ id: "b", number: 2, spec: spec("queued", minutesAgo(75)) }),
          card({ id: "c", number: 3, spec: spec("running", new Date(Date.now() - 10_000).toISOString()) }),
        ]),
      ]),
    );
    const states = [...document.querySelectorAll(".po-live__state")].map((e) => e.textContent);
    expect(states).toEqual(["Gerando spec… · há 5 min", "Gerando spec… · há menos de 1 min", "Na fila · há 1h 15min"]);
  });

  test("the clock is one shared interval, cleaned when the panel goes", async () => {
    const real = { set: globalThis.setInterval, clear: globalThis.clearInterval };
    const live_ = new Set<unknown>();
    let made = 0;
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const id = real.set(fn, ms);
      made += 1;
      live_.add(id);
      return id;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: never) => {
      live_.delete(id);
      real.clear(id);
    }) as unknown as typeof clearInterval;
    try {
      await show(
        progress([
          group("especificar", "Especificar", [
            card({ id: "a", number: 1, spec: spec("running", minutesAgo(5)) }),
            card({ id: "b", number: 2, spec: spec("queued", minutesAgo(5)) }),
            card({ id: "c", number: 3 }),
          ]),
        ]),
      );
      const minuteClocks = made;
      expect(minuteClocks).toBeLessThanOrEqual(2);
      cleanup();
      // Whatever the panel started is stopped with it.
      expect(live_.size).toBeLessThanOrEqual(1);
    } finally {
      globalThis.setInterval = real.set;
      globalThis.clearInterval = real.clear;
    }
  });

  test("a running card has the moving mark, a queued one a still mark", async () => {
    await show(
      progress([
        group("especificar", "Especificar", [
          card({ id: "q", number: 7, spec: spec("queued") }),
          card({ id: "r", number: 8, spec: spec("running") }),
        ]),
      ]),
    );
    const marks = [...document.querySelectorAll(".po-live__row .po-pix")];
    expect(marks.map((m) => m.classList.contains("po-pix--run"))).toEqual([true, false]);
    expect(marks.map((m) => m.getAttribute("data-state"))).toEqual(["running", "queued"]);
  });

  test("with reduced motion the running mark has no animation class", async () => {
    reduce("reduce");
    await show(progress([group("especificar", "Especificar", [card({ spec: spec("running") })])]));
    const mark = document.querySelector(".po-live__row .po-pix") as HTMLElement;
    expect(mark).toBeTruthy();
    expect(mark.classList.contains("po-pix--run")).toBe(false);
    expect(mark.getAttribute("data-state")).toBe("running");
  });
});

describe("a Backlog group", () => {
  const data = () =>
    progress([
      group("backlog", "Backlog", many(9)),
      group("especificar", "Especificar", [card({ id: "e", number: 1 })]),
    ]);
  const toggle = () => document.querySelector(".po-group button[aria-expanded]") as HTMLButtonElement;

  test("starts closed: its name and count, a chevron and no rows; the others stay open", async () => {
    await show(data());
    const backlog = document.querySelector(".po-group") as HTMLElement;
    expect(backlog.querySelector("h3")?.textContent).toBe("Backlog9");
    expect(backlog.querySelectorAll(".po-row")).toHaveLength(0);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelectorAll(".po-group")[1]?.querySelectorAll(".po-row")).toHaveLength(1);
    expect(document.querySelectorAll(".po-group button[aria-expanded]")).toHaveLength(1);
  });

  test("the chevron opens it and closes it again, and the choice is remembered", async () => {
    await show(data());
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector(".po-group")?.querySelectorAll(".po-row")).toHaveLength(9);
    const saved = Object.entries(localStorage as unknown as Record<string, string>).find(([k]) =>
      k.startsWith("agentes.po.groups"),
    );
    expect(JSON.parse(saved?.[1] ?? "[]")).toEqual(["backlog"]);
    // A new panel opens it as the person left it.
    cleanup();
    await show(data());
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(document.querySelector(".po-group")?.querySelectorAll(".po-row")).toHaveLength(0);
  });

  test("Ver todos only shows while it is open", async () => {
    await show(progress([group("backlog", "Backlog", many(8), { count: 35 })]));
    expect(screen().queryByRole("link", { name: "Ver todos" })).toBeNull();
    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(screen().getByRole("link", { name: "Ver todos" })).toBeTruthy();
  });

  test("never closes while it holds a card with a spec being written", async () => {
    await show(
      progress([group("backlog", "Backlog", [...many(2), card({ id: "r", number: 9, spec: spec("running") })])]),
    );
    expect(document.querySelectorAll(".po-group .po-row")).toHaveLength(3);
    expect(document.querySelector(".po-group button[aria-expanded]")).toBeNull();
    expect(names()).toEqual(["Backlog"]);
  });

  test("a saved choice that storage refuses reads as closed", async () => {
    const real = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("blocked");
    };
    try {
      await show(data());
      expect(toggle().getAttribute("aria-expanded")).toBe("false");
    } finally {
      Storage.prototype.getItem = real;
    }
  });
});

describe("a spec that finishes", () => {
  test("its row settles with one highlight class, and a spec done from the start has none", async () => {
    const state = withState(
      progress([
        group("especificar", "Especificar", [
          card({ id: "a", number: 1, spec: spec("running") }),
          card({ id: "b", number: 2, spec: spec("done") }),
        ]),
      ]),
    );
    const { services } = await renderPage(<PoProgressPanel spaceId="s-acme" />, {
      api: createFakeApi(state),
      org: true,
    });
    await settle(4);
    expect(document.querySelectorAll(".po-row--settled")).toHaveLength(0);
    state.poProgress = {
      "s-acme": progress([
        group("especificar", "Especificar", [
          card({ id: "a", number: 1, spec: spec("done") }),
          card({ id: "b", number: 2, spec: spec("done") }),
        ]),
      ]),
    };
    await act(async () => {
      await services.queryClient.invalidateQueries();
    });
    await settle(4);
    const settled = [...document.querySelectorAll(".po-row--settled")];
    expect(settled).toHaveLength(1);
    expect(settled[0]?.textContent).toContain("Spec pronta");
    expect(live()).toBeNull();
  });
});
