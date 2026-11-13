import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { formatUsd } from "@agenteschat/client/lib/format";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
/** Radix tabs choose on the pointer going down, as a person's click does. */
const choose = (el: Element) => act(async () => fireEvent.mouseDown(el, { button: 0 }));

/** A company with a board and one open task, so the Painel has something to count. */
async function setup(state = seedState()) {
  const api = createFakeApi(state);
  const clinic = await api.issues.createSpace(ORG_ID, { name: "Clínica Teo", color: "teal" });
  const site = await api.issues.createProject(ORG_ID, { name: "Site novo", color: "amber", spaceId: clinic.id });
  await api.issues.create(ORG_ID, { title: "Revisar a home", projectId: site.id });
  return { api, state, clinic, site };
}
const visit = async (api: ReturnType<typeof createFakeApi>, search: string) => {
  await renderApp(`/org/${ORG_ID}/issues${search}`, { api });
  await settle(8);
};
const tab = (name: string) => screen().queryByRole("tab", { name });
const asked = (state: ReturnType<typeof seedState>) =>
  state.calls.filter((c) => c.method === "issues.companyDashboard").map((c) => c.args[1]);

describe("the company page's tabs", () => {
  test("the company page shows Boards and Painel with Boards selected", async () => {
    const { api, clinic } = await setup();
    await visit(api, `?space=${clinic.id}`);
    expect(tab("Boards")?.getAttribute("aria-selected")).toBe("true");
    expect(tab("Painel")?.getAttribute("aria-selected")).toBe("false");
    // Boards is what the page shows now: the company's boards, and no Painel numbers.
    expect(document.querySelectorAll(".space-board").length).toBeGreaterThan(0);
    expect(document.querySelector(".cdash")).toBeNull();
  });

  test("the period choice offers 7, 30 and 90 with 30 selected", async () => {
    const { api, clinic } = await setup();
    await visit(api, `?space=${clinic.id}&tab=painel`);
    const period = screen().getByRole("radiogroup", { name: "Período" });
    const options = [...period.querySelectorAll('[role="radio"]')];
    expect(options.map((o) => o.textContent)).toEqual(["7 dias", "30 dias", "90 dias"]);
    expect(options.map((o) => o.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    // The path above it stays: Tarefas, then the company.
    expect(document.querySelector('nav[aria-label="Caminho"]')?.textContent).toContain("Clínica Teo");
  });

  test("picking another period asks the server for it", async () => {
    const { api, state, clinic } = await setup();
    await visit(api, `?space=${clinic.id}&tab=painel`);
    expect(asked(state)).toEqual([30]);
    await click(screen().getByRole("radio", { name: "90 dias" }));
    await settle(4);
    expect(asked(state)).toEqual([30, 90]);
    expect(screen().getByRole("radio", { name: "90 dias" }).getAttribute("aria-checked")).toBe("true");
    await click(screen().getByRole("radio", { name: "7 dias" }));
    await settle(4);
    expect(asked(state)).toEqual([30, 90, 7]);
  });

  test("selecting a tab keeps the company and puts the choice in the address", async () => {
    const { api, clinic } = await setup();
    const { router } = await renderApp(`/org/${ORG_ID}/issues?space=${clinic.id}`, { api });
    await settle(8);
    const search = () => router.state.location.searchStr;
    await choose(tab("Painel") as Element);
    await settle(4);
    expect(search()).toContain(clinic.id);
    expect(search()).toContain("tab=painel");
    expect(tab("Painel")?.getAttribute("aria-selected")).toBe("true");
    await choose(tab("Boards") as Element);
    await settle(4);
    expect(search()).not.toContain("tab=");
    expect(search()).toContain(clinic.id);
    expect(document.querySelectorAll(".space-board").length).toBeGreaterThan(0);
  });

  test("no Painel tab on a board, the root or Todas as tarefas", async () => {
    const { api, site } = await setup();
    await visit(api, `?project=${site.id}&tab=painel`);
    expect(tab("Painel")).toBeNull();
    expect(tab("Boards")).toBeNull();
    cleanup();
    await visit(api, "");
    expect(tab("Painel")).toBeNull();
    cleanup();
    await visit(api, "?all=1");
    expect(tab("Painel")).toBeNull();
  });
});

import type { CompanyDashboard } from "@agenteschat/client";
import { ADA_ID } from "./fake-api";

/** What the fake's Painel holds beyond its counts, whatever the period. */
const numbers = (extra: Partial<CompanyDashboard>) => seedState({ companyDashboard: () => extra });
const card = (name: string) => screen().getByRole("article", { name });
const bigNumber = (name: string) => card(name).querySelector(".wk-num")?.textContent;
const painel = (api: ReturnType<typeof createFakeApi>, clinic: { id: string }) =>
  visit(api, `?space=${clinic.id}&tab=painel`);

describe("the Painel's numbers", () => {
  test("Painel shows the numbers and keeps the path", async () => {
    const { api, clinic } = await setup(
      numbers({
        total: 12,
        stages: { todo: 4, in_progress: 3, in_review: 2, done: 7 },
        late: 5,
        unassigned: 6,
      }),
    );
    await painel(api, clinic);
    expect(bigNumber("A fazer")).toBe("4");
    expect(bigNumber("Em andamento")).toBe("3");
    expect(bigNumber("Em revisão")).toBe("2");
    expect(bigNumber("Concluídas")).toBe("7");
    expect(card("Concluídas").textContent).toContain("30 dias");
    expect(bigNumber("Atrasadas")).toBe("5");
    expect(bigNumber("Sem responsável")).toBe("6");
    // The path above it is still there, Tarefas and the company.
    const path = document.querySelector('nav[aria-label="Caminho"]')?.textContent ?? "";
    expect(path).toContain("Tarefas");
    expect(path).toContain("Clínica Teo");
  });

  test("a company with no task shows its empty state", async () => {
    const api = createFakeApi(seedState());
    const empty = await api.issues.createSpace(ORG_ID, { name: "Sem nada", color: "teal" });
    await painel(api, empty);
    expect(screen().getByText(/ainda não tem tarefas/)).toBeTruthy();
    expect(document.querySelector(".wgrid")).toBeNull();
    // Novo board is the way in: it opens the board dialog.
    const inPanel = within(document.querySelector(".cdash") as HTMLElement);
    await click(inPanel.getByRole("button", { name: "Novo board" }));
    await settle(3);
    expect(screen().getByRole("dialog", { name: "Novo board" })).toBeTruthy();
  });

  test("shows Sem responsável as the last row", async () => {
    const { api, clinic } = await setup(
      numbers({
        total: 9,
        unassigned: 2,
        assignees: [
          { type: "agent", id: ADA_ID, name: "Ada", open: 3, done: 1 },
          { type: "person", id: "person-x", name: "Bia", open: 1, done: 4 },
          { type: "removed", id: "gone", name: "", open: 0, done: 2 },
        ],
      }),
    );
    await painel(api, clinic);
    const rows = [...card("Responsáveis").querySelectorAll("li:not(.cdash__headrow)")].map((li) =>
      [...li.querySelectorAll(".wk-list__t, .cdash__n")].map((c) => c.textContent).join("|"),
    );
    expect(rows).toEqual(["Ada|3|1", "Bia|1|4", "Removido|0|2", "Sem responsável|2|"]);
    // The agent and the person have a face; the removed one and the unassigned row have none.
    expect(
      [...card("Responsáveis").querySelectorAll("li:not(.cdash__headrow)")].map((li) =>
        Boolean(li.querySelector(".ac-avatar")),
      ),
    ).toEqual([true, true, false, false]);
  });

  test("shows a dash for every time with no task concluded", async () => {
    const { api, clinic } = await setup();
    await painel(api, clinic);
    for (const name of ["Tempo até concluir", "Tempo de trabalho"]) {
      expect(bigNumber(name)).toContain("—");
      expect(card(name).textContent).toContain("0 tarefas medidas");
      expect(card(name).querySelectorAll(".wk-list__s")[0]?.textContent).toBe("—");
    }
  });

  test("shows the times as days and hours", async () => {
    const { api, clinic } = await setup(
      numbers({
        total: 3,
        leadTime: { count: 3, medianMs: 52 * 3_600_000, averageMs: 5 * 3_600_000 },
        workTime: { count: 1, medianMs: 3_600_000 * 30, averageMs: 3_600_000 * 30 },
      }),
    );
    await painel(api, clinic);
    expect(bigNumber("Tempo até concluir")).toContain("2d 4h");
    expect(card("Tempo até concluir").textContent).toContain("5h");
    expect(card("Tempo até concluir").textContent).toContain("3 tarefas medidas");
    expect(bigNumber("Tempo de trabalho")).toContain("1d 6h");
    expect(card("Tempo de trabalho").textContent).toContain("1 tarefa medida");
  });

  test("labels each bar with its week's first day", async () => {
    const weeks = ["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"];
    const { api, clinic } = await setup(
      numbers({ total: 5, weekly: weeks.map((weekStart, i) => ({ weekStart, count: [2, 0, 3, 1][i] ?? 0 })) }),
    );
    await painel(api, clinic);
    const bars = card("Concluídas por semana");
    const label = (d: string) =>
      new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(new Date(`${d}T12:00:00`));
    expect([...bars.querySelectorAll(".wk-axis span")].map((s) => s.textContent)).toEqual(weeks.map(label));
    // One bar per week, a week with no delivery drawn as a bar of zero.
    expect([...bars.querySelectorAll(".wk-bar__v")].map((s) => s.textContent)).toEqual(["2", "0", "3", "1"]);
  });

  test("keeps all 14 weeks of a 90 day period", async () => {
    const weeks = Array.from({ length: 14 }, (_, i) =>
      new Date(Date.UTC(2026, 7, 10 + i * 7)).toISOString().slice(0, 10),
    );
    const { api, clinic } = await setup(
      numbers({ total: 5, weekly: weeks.map((weekStart) => ({ weekStart, count: 1 })) }),
    );
    await painel(api, clinic);
    expect(card("Concluídas por semana").querySelectorAll(".wk-bar")).toHaveLength(14);
  });

  test("shows no cost block without cost", async () => {
    const { api, clinic } = await setup();
    await painel(api, clinic);
    expect(screen().queryByRole("article", { name: "Custo dos agentes" })).toBeNull();
    expect(document.body.textContent).not.toContain("US$");
  });

  test("shows $0.00 with no run", async () => {
    const { api, clinic } = await setup(numbers({ total: 1, cost: { totalUsd: 0, byAgent: [] } }));
    await painel(api, clinic);
    expect(bigNumber("Custo dos agentes")).toBe(formatUsd("pt-BR", 0));
    expect(bigNumber("Custo dos agentes")).toContain("0,00");
  });

  test("shows the cost of each agent beside the total", async () => {
    const { api, clinic } = await setup(
      numbers({
        total: 4,
        cost: { totalUsd: 3.5, byAgent: [{ agentId: ADA_ID, name: "Ada", usd: 3.5 }] },
      }),
    );
    await painel(api, clinic);
    expect(bigNumber("Custo dos agentes")).toBe(formatUsd("pt-BR", 3.5));
    expect(card("Custo dos agentes").querySelector("li")?.textContent).toBe(`Ada${formatUsd("pt-BR", 3.5)}`);
  });

  test("an archived company still shows its Painel", async () => {
    const { api, clinic } = await setup(
      numbers({ total: 3, stages: { todo: 3, in_progress: 0, in_review: 0, done: 0 } }),
    );
    await api.issues.updateSpace(ORG_ID, clinic.id, { archived: true });
    await painel(api, clinic);
    expect(tab("Painel")?.getAttribute("aria-selected")).toBe("true");
    expect(bigNumber("A fazer")).toBe("3");
  });
});
