import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent } from "@testing-library/react";
import { levelOf } from "@/pages/issues-level";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));

/** A company "Acme" with a board that owns Especificar and Ready for dev columns, and a card in each, and one in Em dev. */
async function scene() {
  const api = createFakeApi(seedState(), { seed: false });
  const acme = await api.issues.createSpace(ORG_ID, { name: "Acme", color: "teal" });
  const board = await api.issues.createProject(ORG_ID, { name: "Entregas", color: "amber", spaceId: acme.id });
  const added = async (name: string, stage: "todo" | "in_progress") =>
    (await api.issues.addColumn(ORG_ID, { name, stage, projectId: board.id })).find((c) => c.name === name);
  const specify = await added("Especificar", "todo");
  const ready = await added("Ready for dev", "in_progress");
  const dev = await added("Em dev", "in_progress");
  const card = (title: string, columnId?: string) =>
    api.issues
      .create(ORG_ID, { title, projectId: board.id })
      .then((c) => api.issues.update(ORG_ID, c.id, { columnId }));
  await card("Escrever spec", specify?.id);
  await card("Pronto para dev", ready?.id);
  await card("Em desenvolvimento", dev?.id);
  return { api, acme, board };
}

const visit = async (api: ReturnType<typeof createFakeApi>, search: string) => {
  const app = await renderApp(`/org/${ORG_ID}/issues${search}`, { api });
  await settle(10);
  return app;
};
const titles = () => [...document.querySelectorAll(".issue-card__title")].map((c) => c.textContent).sort();
const searchOf = (app: Awaited<ReturnType<typeof visit>>) =>
  app.router.state.location.search as Record<string, unknown>;

describe("Tarefas filtered to a company's columns", () => {
  test("a columns address shows the chip and asks the list for those columns", async () => {
    const { api, acme } = await scene();
    const asked = spyOn(api.issues, "list");
    await visit(api, `?space=${acme.id}&columns=especificar|ready for dev`);
    const last = asked.mock.calls.at(-1);
    expect(last?.[1]).toMatchObject({ spaceId: acme.id, columns: ["especificar", "ready for dev"] });
    // The tasks of those columns, as the whole list of tasks, not the company's page of boards.
    expect(titles()).toEqual(["Escrever spec", "Pronto para dev"]);
    expect(screen().getByText("Coluna: 2")).toBeTruthy();
    expect(screen().getByRole("button", { name: "Remover o filtro Coluna" })).toBeTruthy();
  });

  test("clearing the chip keeps the company in the address and drops only the columns", async () => {
    const { api, acme } = await scene();
    const app = await visit(api, `?space=${acme.id}&columns=especificar`);
    expect(screen().getByText("Coluna: Especificar")).toBeTruthy();
    await click(screen().getByRole("button", { name: "Remover o filtro Coluna" }));
    await settle(8);
    expect(searchOf(app).columns).toBeUndefined();
    expect(searchOf(app).space).toBe(acme.id);
    expect(screen().queryByRole("button", { name: "Remover o filtro Coluna" })).toBeNull();
  });

  test("without columns a company's address is its page of boards, with no chip", async () => {
    const { api, acme } = await scene();
    await visit(api, `?space=${acme.id}`);
    expect(screen().queryByRole("button", { name: "Remover o filtro Coluna" })).toBeNull();
    expect(titles()).toEqual([]);
  });

  test("a company and columns read as the whole list of tasks, every other address as before", () => {
    expect(levelOf({ space: "s1", columns: true })).toBe("all");
    expect(levelOf({ space: "s1" })).toBe("company");
    expect(levelOf({ project: "b1", space: "s1", columns: true })).toBe("board");
    expect(levelOf({ columns: true })).toBe("root");
  });
});
