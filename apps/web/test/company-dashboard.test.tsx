import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
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
