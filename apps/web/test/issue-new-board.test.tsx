import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

async function setup() {
  const state = seedState();
  const api = createFakeApi(state);
  const clinic = await api.issues.createSpace(ORG_ID, { name: "Clínica Teo", color: "teal" });
  const bakery = await api.issues.createSpace(ORG_ID, { name: "Padaria Lia", color: "amber" });
  const old = await api.issues.createSpace(ORG_ID, { name: "Empresa velha", color: "graphite" });
  await api.issues.updateSpace(ORG_ID, old.id, { archived: true });
  return { state, api, clinic, bakery };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const visit = async (api: Setup["api"], search: string) => {
  await renderApp(`/org/${ORG_ID}/issues${search}`, { api });
  await settle(8);
};
/** "Novo board" from a company's page: the button at the end of the page title's line. */
const fromCompany = async (s: Setup) => {
  await visit(s.api, `?space=${s.clinic.id}`);
  await click(within(document.querySelector(".ac-pagehead__actions") as HTMLElement).getByRole("button"));
  await settle(3);
  return screen().getByRole("dialog", { name: "Novo board" });
};
/** "Novo board" with no company in sight: from the Board select of all tasks. */
const fromRoot = async (s: Setup) => {
  await visit(s.api, "?all=1");
  const chip = [...document.querySelectorAll<HTMLElement>(".ac-toolbar .ac-filter__trigger")].find((t) =>
    t.textContent?.startsWith("Board"),
  ) as HTMLElement;
  await click(chip);
  await settle(3);
  await click(within(document.body).getByRole("button", { name: "Novo board" }));
  await settle(3);
  return screen().getByRole("dialog", { name: "Novo board" });
};
const optionsOf = async (dialog: HTMLElement, name: string) => {
  await click(within(dialog).getByRole("combobox", { name }));
  await settle(3);
  return [...document.querySelectorAll<HTMLElement>("[role=option]")].map((o) => o.textContent?.trim() ?? "");
};
const calls = (s: Setup, method: string) => s.state.calls.filter((c) => c.method === method);

describe("Novo board knows its company", () => {
  test("from a company there is no Empresa field", async () => {
    const dialog = await fromCompany(await setup());
    expect(within(dialog).queryByRole("combobox", { name: "Empresa" })).toBeNull();
    expect(within(dialog).queryByText("Empresa")).toBeNull();
    // The rest of the form is there.
    expect(within(dialog).getByRole("combobox", { name: "Colunas do board" })).toBeTruthy();
  });

  test("from a company the board is created in it", async () => {
    const s = await setup();
    const dialog = await fromCompany(s);
    await type(within(dialog).getByRole("textbox"), "Site novo");
    await click(within(dialog).getByRole("button", { name: "Criar board" }));
    await settle(8);
    expect(calls(s, "issues.createProject").at(-1)?.args[0]).toMatchObject({ name: "Site novo", spaceId: s.clinic.id });
    // The new board opens, and its path says where it lives.
    expect(screen().getByRole("navigation", { name: "Caminho" }).textContent).toContain("Clínica Teo›Site novo");
  });

  test("from the root Empresa shows Sem empresa", async () => {
    const dialog = await fromRoot(await setup());
    const field = within(dialog).getByRole("combobox", { name: "Empresa" });
    expect(field.textContent).toContain("Sem empresa");
  });

  test("an archived company is not offered", async () => {
    const dialog = await fromRoot(await setup());
    const options = await optionsOf(dialog, "Empresa");
    expect(options.some((o) => o.includes("Clínica Teo"))).toBe(true);
    expect(options.some((o) => o.includes("Padaria Lia"))).toBe(true);
    expect(options.some((o) => o.includes("Empresa velha"))).toBe(false);
  });

  test("columns select lists the sets by name", async () => {
    const dialog = await fromCompany(await setup());
    expect(await optionsOf(dialog, "Colunas do board")).toEqual(["As do workspace", "Desenvolvimento", "Kanban"]);
  });

  test("columns select puts a person's own sets in the name order with the seeded ones", async () => {
    const s = await setup();
    const columns = [{ name: "Entrada", stage: "todo" as const }];
    await s.api.issues.createColumnTemplate(ORG_ID, { name: "Suporte", columns });
    await s.api.issues.createColumnTemplate(ORG_ID, { name: "Aviação", columns });
    const dialog = await fromCompany(s);
    expect(await optionsOf(dialog, "Colunas do board")).toEqual([
      "As do workspace",
      "Aviação",
      "Desenvolvimento",
      "Kanban",
      "Suporte",
    ]);
  });

  test("the board gets a copy of the chosen set", async () => {
    const s = await setup();
    const dialog = await fromCompany(s);
    await type(within(dialog).getByRole("textbox"), "App");
    await click(within(dialog).getByRole("combobox", { name: "Colunas do board" }));
    await settle(3);
    await click(
      [...document.querySelectorAll<HTMLElement>("[role=option]")].find((o) =>
        o.textContent?.includes("Desenvolvimento"),
      ) as HTMLElement,
    );
    await click(within(dialog).getByRole("button", { name: "Criar board" }));
    await settle(10);
    expect(calls(s, "issues.applyColumnTemplate").at(-1)?.args).toEqual([
      (await s.api.issues.projects(ORG_ID)).projects.find((p) => p.name === "App")?.id,
      "tpl-dev",
    ]);
    const board = (await s.api.issues.projects(ORG_ID)).projects.find((p) => p.name === "App");
    const columns = (await s.api.issues.columns(ORG_ID, board?.id)).filter((c) => c.projectId === board?.id);
    expect(columns.map((c) => c.name)).toEqual(["Backlog", "Ready for dev", "QA", "Concluído"]);
  });
});
