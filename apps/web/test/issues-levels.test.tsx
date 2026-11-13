import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { chromeFor, levelOf } from "@/pages/issues-level";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));

/** A company with a board, and one task in it, so no empty state takes the header's button. */
async function setup() {
  const api = createFakeApi(seedState());
  const clinic = await api.issues.createSpace(ORG_ID, { name: "Clínica Teo", color: "teal" });
  const site = await api.issues.createProject(ORG_ID, { name: "Site novo", color: "amber", spaceId: clinic.id });
  await api.issues.create(ORG_ID, { title: "Revisar a home", projectId: site.id });
  return { api, clinic, site };
}
const visit = async (api: Awaited<ReturnType<typeof setup>>["api"], search: string) => {
  await renderApp(`/org/${ORG_ID}/issues${search}`, { api });
  await settle(8);
};
/** The names of the buttons at the end of the page title's line. */
const headerActions = () =>
  [...(document.querySelector(".ac-pagehead__actions")?.querySelectorAll("button") ?? [])].map(
    (b) => b.textContent?.replace(/N$/, "").trim() ?? "",
  );
const anywhere = (name: string) => screen().queryAllByRole("button", { name: new RegExp(`^${name}`) });

describe("the level rule", () => {
  test("levelOf reads the address: a board wins over a company, a company over all", () => {
    expect(levelOf({})).toBe("root");
    expect(levelOf({ space: "s" })).toBe("company");
    expect(levelOf({ project: "p" })).toBe("board");
    expect(levelOf({ project: "p", space: "s" })).toBe("board");
    expect(levelOf({ all: true })).toBe("all");
    expect(levelOf({ project: "none", all: true })).toBe("board");
  });

  test("chromeFor gives each level its action and filters", () => {
    expect(chromeFor("root")).toEqual({ action: "company", filters: { space: false, board: false } });
    expect(chromeFor("company")).toEqual({ action: "board", filters: { space: false, board: false } });
    expect(chromeFor("board").action).toBe("task");
    expect(chromeFor("all")).toEqual({ action: "task", filters: { space: true, board: true } });
  });
});

describe("the header's action follows the level", () => {
  test("root header offers Nova empresa and no Nova tarefa", async () => {
    const { api } = await setup();
    await visit(api, "");
    expect(headerActions()).toEqual(["Nova empresa"]);
    expect(anywhere("Nova tarefa")).toHaveLength(0);
    // The button does what it says.
    await click(within(document.querySelector(".ac-pagehead__actions") as HTMLElement).getByRole("button"));
    await settle(3);
    expect(screen().getByRole("dialog", { name: "Nova empresa" })).toBeTruthy();
  });

  test("company page header offers Novo board and no Nova tarefa", async () => {
    const { api, clinic } = await setup();
    await visit(api, `?space=${clinic.id}`);
    expect(headerActions()).toEqual(["Novo board"]);
    expect(anywhere("Nova tarefa")).toHaveLength(0);
    await click(within(document.querySelector(".ac-pagehead__actions") as HTMLElement).getByRole("button"));
    await settle(3);
    expect(screen().getByRole("dialog", { name: "Novo board" })).toBeTruthy();
  });

  test("board header offers Nova tarefa", async () => {
    const { api, site } = await setup();
    await visit(api, `?project=${site.id}`);
    expect(headerActions()).toEqual(["Nova tarefa"]);
    await click(within(document.querySelector(".ac-pagehead__actions") as HTMLElement).getByRole("button"));
    await settle(3);
    expect(screen().getByRole("dialog", { name: "Nova tarefa" })).toBeTruthy();
  });

  test("all tasks header offers Nova tarefa", async () => {
    const { api } = await setup();
    await visit(api, "?all=1");
    expect(headerActions()).toEqual(["Nova tarefa"]);
  });

  test("the N shortcut makes a task only where tasks are shown", async () => {
    const { api } = await setup();
    await visit(api, "");
    await act(async () => fireEvent.keyDown(window, { key: "n" }));
    await settle(3);
    expect(screen().queryByRole("dialog", { name: "Nova tarefa" })).toBeNull();
  });
});

/** The toolbar's select triggers, by their words. */
const triggers = () =>
  [...document.querySelectorAll<HTMLElement>(".ac-toolbar .ac-filter__trigger")].map((t) => t.textContent ?? "");
const has = (word: string) => triggers().some((t) => t.startsWith(word));

describe("the filters follow the level", () => {
  test("root and company page show no Empresa or Board filter", async () => {
    const { api, clinic } = await setup();
    await visit(api, "");
    expect(has("Empresa")).toBe(false);
    expect(has("Board")).toBe(false);
    cleanup();
    await visit(api, `?space=${clinic.id}`);
    expect(has("Empresa")).toBe(false);
    expect(has("Board")).toBe(false);
  });

  test("inside a board no Empresa or Board filter", async () => {
    const { api, site } = await setup();
    await visit(api, `?project=${site.id}`);
    // The toolbar is there, with the filters that read the board's own tasks.
    expect(screen().getByRole("button", { name: /^Filtro/ })).toBeTruthy();
    expect(has("Empresa")).toBe(false);
    expect(has("Board")).toBe(false);
  });

  test("all tasks shows the Empresa and Board filters", async () => {
    const { api } = await setup();
    await visit(api, "?all=1");
    expect(has("Empresa")).toBe(true);
    expect(has("Board")).toBe(true);
    // And they work: picking the company narrows the page to it.
    const chip = [...document.querySelectorAll<HTMLElement>(".ac-toolbar .ac-filter__trigger")].find((t) =>
      t.textContent?.startsWith("Empresa"),
    ) as HTMLElement;
    await click(chip);
    await settle(3);
    const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find((o) =>
      o.textContent?.includes("Clínica Teo"),
    ) as HTMLElement;
    await click(option);
    await settle(6);
    // Picking the company opens its page: its boards, with the path and no select left in the toolbar.
    expect(screen().getByRole("navigation", { name: "Caminho" }).textContent).toContain("Clínica Teo");
    expect(has("Empresa")).toBe(false);
  });
});
