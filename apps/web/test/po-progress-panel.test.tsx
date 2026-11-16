import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { PoProgress, PoProgressCard, PoProgressGroup } from "@agenteschat/client";
import { cleanup } from "@testing-library/react";
import { PoProgressPanel } from "@/components/po/PoProgressPanel";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const card = (over: Partial<PoProgressCard> = {}): PoProgressCard => ({
  id: "c1",
  number: 12,
  title: "Tela de login",
  boardId: "b1",
  boardName: "Entregas",
  since: hoursAgo(3),
  spec: null,
  ...over,
});

const group = (over: Partial<PoProgressGroup> = {}): PoProgressGroup => {
  const items = over.items ?? [];
  return {
    key: "especificar",
    kind: "column",
    stage: "todo",
    name: "Especificar",
    columns: ["especificar"],
    count: items.length,
    items,
    ...over,
  };
};

const progress = (groups: PoProgressGroup[], done = 0): PoProgress => ({
  space: { id: "s-acme", name: "Acme" },
  groups,
  done,
});

async function show(data: PoProgress) {
  const state = seedState();
  state.poProgress = { "s-acme": data };
  await renderPage(<PoProgressPanel spaceId="s-acme" />, { api: createFakeApi(state), org: true });
  await settle(4);
}

const sections = () => [...document.querySelectorAll(".po-group")] as HTMLElement[];

describe("the progress panel", () => {
  test("shows a group per column with its count, in the order the server sent", async () => {
    await show(
      progress([
        group({ items: [card(), card({ id: "c2", number: 13 })] }),
        group({ key: "especificado", name: "Especificado", columns: ["especificado"] }),
        group({
          key: "ready for dev",
          name: "Ready for dev",
          stage: "in_progress",
          columns: ["ready for dev"],
          items: [card({ id: "c3", number: 14 })],
        }),
      ]),
    );
    expect(sections().map((s) => s.querySelector("h3")?.textContent)).toEqual([
      "Especificar2",
      "Especificado0",
      "Ready for dev1",
    ]);
  });

  test("names the tail group Em andamento até Concluído and a nameless column by its stage", async () => {
    await show(
      progress([
        group({ key: "stage:todo", name: null, columns: ["stage:todo"], items: [card()] }),
        group({ key: "tail", kind: "tail", stage: "in_progress", name: null, columns: ["em dev"] }),
      ]),
    );
    const names = sections().map((s) => s.querySelector("h3")?.textContent);
    expect(names[1]).toBe("Em andamento até Concluído0");
    expect(names[0]).not.toContain("null");
    expect(names[0]).toMatch(/^[A-Za-zÀ-ú ]+1$/);
  });

  test("each row shows number, title, board and time in the column", async () => {
    await show(progress([group({ items: [card({ since: hoursAgo(50) })] })]));
    const row = document.querySelector(".po-row") as HTMLElement;
    expect(row.querySelector(".po-row__title")?.textContent).toBe("#12 Tela de login");
    expect(row.querySelector(".po-row__meta")?.textContent).toBe("Entregas · há 2d 2h");
  });

  test("each row is a link to its card", async () => {
    await show(progress([group({ items: [card({ number: 12 })] })]));
    const link = screen().getByRole("link", { name: /#12 Tela de login/ });
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/issues/12`);
  });

  test("past 8 cards Ver todos opens the company's tasks filtered to the column", async () => {
    const items = Array.from({ length: 8 }, (_, i) => card({ id: `c${i}`, number: i + 1 }));
    await show(progress([group({ items, count: 11, columns: ["especificar"] })]));
    expect(document.querySelectorAll(".po-row")).toHaveLength(8);
    expect(sections()[0]?.querySelector("h3")?.textContent).toBe("Especificar11");
    const more = screen().getByRole("link", { name: "Ver todos" });
    const url = new URL(more.getAttribute("href") ?? "", "http://x");
    expect(url.pathname).toBe(`/org/${ORG_ID}/issues`);
    // The router writes a string that reads as a number between quotes.
    const param = (name: string) => url.searchParams.get(name)?.replace(/^"|"$/g, "");
    expect(param("space")).toBe("s-acme");
    expect(param("columns")).toBe("especificar");
  });

  test("a group with every card listed has no Ver todos", async () => {
    await show(progress([group({ items: [card()] })]));
    expect(screen().queryByRole("link", { name: "Ver todos" })).toBeNull();
  });

  test("a company with no card says so in one line", async () => {
    await show(progress([group(), group({ key: "tail", kind: "tail", stage: "in_progress" })]));
    expect(screen().getByText("Nenhum card nesta empresa ainda.")).toBeTruthy();
    expect(document.querySelectorAll(".po-row")).toHaveLength(0);
  });

  test("a queued spec reads Na fila and a running one Spec em andamento", async () => {
    await show(
      progress([
        group({
          items: [
            card({ id: "q", number: 1, spec: { state: "queued", page: null, error: null } }),
            card({ id: "r", number: 2, spec: { state: "running", page: null, error: null } }),
          ],
        }),
      ]),
    );
    const specs = [...document.querySelectorAll(".po-row__spec")].map((e) => e.textContent);
    expect(specs).toEqual(["Na fila", "Spec em andamento"]);
  });

  test("a ready spec shows Ver spec opening the wiki page", async () => {
    await show(
      progress([
        group({
          stage: "in_progress",
          items: [card({ spec: { state: "done", page: { slug: "specs/acme/12", title: "Spec 12" }, error: null } })],
        }),
      ]),
    );
    expect(document.querySelector(".po-row__spec")?.textContent).toContain("Spec pronta");
    const link = screen().getByRole("link", { name: "Ver spec" });
    expect(link.getAttribute("href")).toBe(`/org/${ORG_ID}/wiki/specs%2Facme%2F12`);
  });

  test("a failed spec reads Spec falhou with its reason", async () => {
    await show(
      progress([
        group({
          items: [
            card({ id: "a", number: 1, spec: { state: "failed", page: null, error: "no_spec_page" } }),
            card({ id: "b", number: 2, spec: { state: "failed", page: null, error: "o modelo recusou" } }),
          ],
        }),
      ]),
    );
    const specs = [...document.querySelectorAll(".po-row__spec")].map((e) => e.textContent);
    expect(specs[0]).toBe("Spec falhou: a execução terminou sem salvar a spec na wiki");
    expect(specs[1]).toBe("Spec falhou: o modelo recusou");
  });

  test("the header links to the company's board", async () => {
    await show(progress([group()]));
    expect(screen().getByRole("heading", { name: "Andamento" })).toBeTruthy();
    expect(screen().getByText("Acme")).toBeTruthy();
    const link = screen().getByRole("link", { name: "Abrir o board" });
    const url = new URL(link.getAttribute("href") ?? "", "http://x");
    expect(url.pathname).toBe(`/org/${ORG_ID}/issues`);
    expect(url.searchParams.get("space")?.replace(/^"|"$/g, "")).toBe("s-acme");
  });

  test("the done count is one line under the groups", async () => {
    await show(progress([group({ items: [card()] })], 4));
    const line = screen().getByText("4 cards concluídos");
    expect(line.tagName).toBe("P");
    expect(line.previousElementSibling?.classList.contains("po-group")).toBe(true);
    expect(line.nextElementSibling).toBeNull();
  });

  test("a 300-character title and nine cards stay inside the panel, whole", async () => {
    const title = `${"Reestruturação completa do atendimento ao cliente da clínica ".repeat(6)}`.trim().slice(0, 300);
    const items = Array.from({ length: 8 }, (_, i) => card({ id: `c${i}`, number: 100 + i, title }));
    await show(progress([group({ items, count: 9 })]));
    expect(document.querySelectorAll(".po-row")).toHaveLength(8);
    expect(document.querySelector(".po-row__title")?.textContent).toContain(title);
    expect(document.querySelector(".po-side")).toBeTruthy();
  });

  test("a company the server does not know says it is gone", async () => {
    const state = seedState();
    await renderPage(<PoProgressPanel spaceId="s-nada" />, { api: createFakeApi(state), org: true });
    await settle(4);
    expect(screen().getByText(/Isso não está mais aqui/)).toBeTruthy();
    expect(document.querySelectorAll(".po-group")).toHaveLength(0);
  });
});
