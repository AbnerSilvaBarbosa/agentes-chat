import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import {
  type ApiClient,
  ApiError,
  type PoProgress,
  type PoProgressCard,
  type PoProgressGroup,
} from "@agenteschat/client";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { PoProgressPanel } from "@/components/po/PoProgressPanel";
import { createFakeApi, seedState } from "./fake-api";
import { renderPage, settle } from "./render";

afterEach(() => cleanup());

const READY = { id: "col-ready", name: "Ready for dev" };

const card = (over: Partial<PoProgressCard> = {}): PoProgressCard => ({
  id: "c1",
  number: 12,
  title: "Tela de login",
  boardId: "b1",
  boardName: "Entregas",
  since: new Date(Date.now() - 3_600_000).toISOString(),
  spec: { state: "done", page: null, error: null, queuedAt: null },
  releaseTo: READY,
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

const data = (groups: PoProgressGroup[]): PoProgress => ({ space: { id: "s-acme", name: "Acme" }, groups, done: 0 });

/** The panel over a fake whose `issues.update` the test controls; a success moves the card, as the server would. */
async function show(progress: PoProgress, update?: () => Promise<unknown>) {
  const state = seedState();
  state.poProgress = { "s-acme": progress };
  const base = createFakeApi(state);
  const sent: { id: string; patch: unknown }[] = [];
  const api: ApiClient = {
    ...base,
    issues: {
      ...base.issues,
      update: async (_org, id, patch) => {
        sent.push({ id, patch });
        await update?.();
        const current = state.poProgress?.["s-acme"] as PoProgress;
        const from = current.groups.find((g) => g.items.some((i) => i.id === id));
        const moved = from?.items.find((i) => i.id === id);
        const to = current.groups.find((g) => g.key === "ready for dev");
        if (from && moved && to) {
          from.items = from.items.filter((i) => i.id !== id);
          from.count -= 1;
          to.items.push({ ...moved, releaseTo: undefined });
          to.count += 1;
        }
        return {} as never;
      },
    },
  };
  await renderPage(<PoProgressPanel spaceId="s-acme" />, { api, org: true });
  await settle(4);
  return { state, sent };
}

const button = () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Liberar para dev");
const buttons = () => [...document.querySelectorAll("button")].filter((b) => b.textContent === "Liberar para dev");
const titles = (key: string) =>
  [...document.querySelectorAll(".po-group")]
    .find((s) => s.getAttribute("aria-label") === key)
    ?.querySelectorAll(".po-row__title");

const board = () => [
  group("especificar", "Especificar", []),
  group("especificado", "Especificado", [card()]),
  group("ready for dev", "Ready for dev", [], { stage: "in_progress" }),
];

describe("Liberar para dev", () => {
  test("shows on a card waiting in Especificado that the server says can be released", async () => {
    await show(data(board()));
    expect(buttons()).toHaveLength(1);
    expect(button()?.closest(".po-row")?.textContent).toContain("Tela de login");
  });

  test("shows on a card in an older board's Priorizado", async () => {
    await show(data([group("priorizado", "Priorizado", [card()]), group("ready for dev", "Ready for dev", [])]));
    expect(buttons()).toHaveLength(1);
  });

  test("never shows on a card in any other group, whatever the server sent", async () => {
    await show(
      data([
        group("especificar", "Especificar", [card({ id: "a", number: 1 })]),
        group("ready for dev", "Ready for dev", [card({ id: "b", number: 2 })], { stage: "in_progress" }),
        group("tail", "Em andamento", [card({ id: "c", number: 3 })], { kind: "tail", stage: "in_progress" }),
      ]),
    );
    expect(buttons()).toHaveLength(0);
  });

  test("is absent when the server named no Ready for dev column or the reader may not move the card", async () => {
    await show(data([group("especificado", "Especificado", [card({ releaseTo: undefined })])]));
    expect(buttons()).toHaveLength(0);
  });

  test("moves the card to its Ready for dev column as the person, and it shows there without a reload", async () => {
    const { sent } = await show(data(board()));
    await act(async () => fireEvent.click(button() as HTMLElement));
    await settle(4);
    expect(sent).toEqual([{ id: "c1", patch: { columnId: "col-ready" } }]);
    expect(titles("Ready for dev")?.length).toBe(1);
    expect(titles("Especificado")?.length ?? 0).toBe(0);
    expect(buttons()).toHaveLength(0);
  });

  test("is disabled while the move runs, so it is sent once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { sent } = await show(data(board()), () => gate);
    await act(async () => fireEvent.click(button() as HTMLElement));
    await settle(2);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
    await act(async () => fireEvent.click(button() as HTMLElement));
    expect(sent).toHaveLength(1);
    await act(async () => release());
    await settle(4);
    expect(sent).toHaveLength(1);
  });

  test("worst case: a long title and board name, a ready spec and a refusal all fit the row (the geometry check reads it)", async () => {
    const long = "Integração".repeat(12);
    await show(
      data([
        group("especificado", "Especificado", [
          card({
            title: `${long} ${long}`,
            boardName: `Quadro ${long}`,
            spec: { state: "done", page: { slug: "s", title: "Spec" }, error: null, queuedAt: null },
          }),
          card({ id: "c2", number: 1234, title: "Curto" }),
        ]),
        group("ready for dev", "Ready for dev", [], { stage: "in_progress" }),
      ]),
      () => Promise.reject(new ApiError(500, "internal", "x".repeat(200))),
    );
    await act(async () => fireEvent.click(buttons()[0] as HTMLElement));
    await settle(4);
    expect(buttons()).toHaveLength(2);
    expect(document.querySelector(".po-row [role=alert]")).toBeTruthy();
  });

  test("a refusal is said under the row and the card stays where it was", async () => {
    const { sent } = await show(data(board()), () =>
      Promise.reject(new ApiError(403, "routine.manage_forbidden", "Only an admin or the agent's owner can do this")),
    );
    await act(async () => fireEvent.click(button() as HTMLElement));
    await settle(4);
    expect(sent).toHaveLength(1);
    const row = button()?.closest(".po-row") as HTMLElement;
    expect(row.querySelector("[role=alert]")?.textContent).toContain("Não foi possível liberar");
    expect(titles("Especificado")?.length).toBe(1);
    expect((button() as HTMLButtonElement).disabled).toBe(false);
  });
});
