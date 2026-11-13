import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { pick } from "./new-agent-flow";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

type State = ReturnType<typeof seedState>;
const go = async (state: State = seedState()) => {
  await renderApp(`/org/${ORG_ID}/settings/tasks`, { api: createFakeApi(state) });
  await settle(6);
  return state;
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const blur = (el: Element) => act(async () => fireEvent.blur(el));
const card = (name: string) => screen().getByRole("region", { name });
const stage = (set: string, name: string) => within(card(set)).getByRole("region", { name });
const namesIn = (el: HTMLElement) =>
  within(el)
    .getAllByRole("textbox", { name: "Nome da coluna" })
    .map((i) => (i as HTMLInputElement).value);
const call = (state: State, method: string) => state.calls.filter((c) => c.method === method);
const nav = () => screen().getByRole("navigation", { name: "Seções das configurações" });

/** A member of the workspace who may read but not create tasks. */
const readOnly = () => {
  const state = seedState();
  const org = state.me?.organizations[0];
  if (org) {
    org.role = "member";
    org.permissions = ["read"];
  }
  return state;
};

describe("Configurações › Tarefas", () => {
  test("settings lists Tarefas", async () => {
    await go();
    const link = within(nav()).getByRole("button", { name: "Avançado" });
    await click(link);
    expect(within(nav()).getByRole("link", { name: "Tarefas" })).toBeTruthy();
    expect(screen().getByRole("heading", { level: 2, name: "Tarefas" })).toBeTruthy();
  });

  test("lists every set with its columns by stage", async () => {
    await go();
    expect(screen().getByRole("heading", { level: 2, name: "Kanban" })).toBeTruthy();
    expect(screen().getByRole("heading", { level: 2, name: "Desenvolvimento" })).toBeTruthy();
    expect(namesIn(stage("Kanban", "A fazer"))).toEqual(["A fazer"]);
    expect(namesIn(stage("Kanban", "Feito"))).toEqual(["Concluído"]);
    expect(namesIn(stage("Desenvolvimento", "A fazer"))).toEqual(["Backlog"]);
    expect(namesIn(stage("Desenvolvimento", "Em andamento"))).toEqual(["Ready for dev"]);
    expect(namesIn(stage("Desenvolvimento", "Em revisão"))).toEqual(["QA"]);
    expect(namesIn(stage("Desenvolvimento", "Feito"))).toEqual(["Concluído"]);
  });

  test("the seeded sets show no Delete, a set made here does", async () => {
    await go();
    expect(within(card("Kanban")).queryByRole("button", { name: "Excluir conjunto" })).toBeNull();
    expect(within(card("Desenvolvimento")).queryByRole("button", { name: "Excluir conjunto" })).toBeNull();
    // Their columns stay editable.
    expect(within(card("Kanban")).getAllByRole("textbox", { name: "Nome da coluna" }).length).toBeGreaterThan(0);
    expect(within(card("Kanban")).getByRole("button", { name: "Renomear conjunto" })).toBeTruthy();
  });

  test("creates a set with a name, which then shows in the list with a column per stage", async () => {
    const state = await go();
    await click(screen().getByRole("button", { name: "Novo conjunto" }));
    const dialog = screen().getByRole("dialog", { name: "Novo conjunto de colunas" });
    const field = within(dialog).getByRole("textbox", { name: "Nome do conjunto" });
    expect(field.getAttribute("maxlength")).toBe("40");
    const save = within(dialog).getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await type(field, "Suporte");
    await click(save);
    await settle(4);
    expect(call(state, "issues.createColumnTemplate")[0]?.args[0]).toMatchObject({
      name: "Suporte",
      columns: [
        { name: "A fazer", stage: "todo" },
        { name: "Em andamento", stage: "in_progress" },
        { name: "Em revisão", stage: "in_review" },
        { name: "Feito", stage: "done" },
      ],
    });
    expect(screen().queryByRole("dialog")).toBeNull();
    expect(screen().getByRole("heading", { level: 2, name: "Suporte" })).toBeTruthy();
    expect(namesIn(stage("Suporte", "Em revisão"))).toEqual(["Em revisão"]);
  });

  test("a name another set has is refused in the dialog, in words", async () => {
    await go();
    await click(screen().getByRole("button", { name: "Novo conjunto" }));
    const dialog = screen().getByRole("dialog", { name: "Novo conjunto de colunas" });
    await type(within(dialog).getByRole("textbox", { name: "Nome do conjunto" }), "kanban");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(within(dialog).getByText("Já existe um conjunto com esse nome.")).toBeTruthy();
    expect(screen().queryByRole("heading", { level: 2, name: "kanban" })).toBeNull();
  });

  test("renames a set and the list shows the new name", async () => {
    const state = await go();
    await click(within(card("Kanban")).getByRole("button", { name: "Renomear conjunto" }));
    const dialog = screen().getByRole("dialog", { name: "Renomear Kanban" });
    const field = within(dialog).getByRole("textbox", { name: "Nome do conjunto" }) as HTMLInputElement;
    expect(field.value).toBe("Kanban");
    await type(field, "Fluxo simples");
    await click(within(dialog).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(call(state, "issues.updateColumnTemplate")[0]?.args).toEqual(["tpl-kanban", { name: "Fluxo simples" }]);
    expect(screen().getByRole("heading", { level: 2, name: "Fluxo simples" })).toBeTruthy();
    expect(screen().queryByRole("heading", { level: 2, name: "Kanban" })).toBeNull();
  });

  test("edits a set's columns: add, rename, reorder, move of stage and delete, each saved and shown", async () => {
    const state = await go();
    const set = "Desenvolvimento";
    const saved = () =>
      call(state, "issues.updateColumnTemplate").at(-1)?.args[1] as { columns: { name: string; stage: string }[] };

    // Add at the end of a stage.
    await click(within(stage(set, "Feito")).getByRole("button", { name: "Adicionar coluna" }));
    const form = stage(set, "Feito").querySelector("form") as HTMLFormElement;
    await type(within(form).getByRole("textbox", { name: "Nome da coluna" }), "Arquivado");
    await act(async () => fireEvent.submit(form));
    await settle(4);
    expect(namesIn(stage(set, "Feito"))).toEqual(["Concluído", "Arquivado"]);
    expect(saved().columns.at(-1)).toEqual({ name: "Arquivado", stage: "done" });

    // Rename on blur.
    const first = within(stage(set, "A fazer")).getAllByRole("textbox", { name: "Nome da coluna" })[0] as HTMLElement;
    await type(first, "Ideias");
    await blur(first);
    await settle(4);
    expect(namesIn(stage(set, "A fazer"))).toEqual(["Ideias"]);

    // Reorder inside the stage: a second column, then the first moves after it.
    await click(within(stage(set, "A fazer")).getByRole("button", { name: "Adicionar coluna" }));
    const adding = stage(set, "A fazer").querySelector("form") as HTMLFormElement;
    await type(within(adding).getByRole("textbox", { name: "Nome da coluna" }), "Triagem");
    await act(async () => fireEvent.submit(adding));
    await settle(4);
    expect(namesIn(stage(set, "A fazer"))).toEqual(["Ideias", "Triagem"]);
    await click(
      within(stage(set, "A fazer")).getAllByRole("button", { name: "Mover para a direita" })[0] as HTMLElement,
    );
    await settle(4);
    expect(namesIn(stage(set, "A fazer"))).toEqual(["Triagem", "Ideias"]);

    // Move of stage: "QA" goes to Em andamento, at its end.
    await pick(within(stage(set, "Em revisão")).getByRole("combobox", { name: "Etapa" }), "Em andamento");
    await settle(4);
    expect(namesIn(stage(set, "Em andamento"))).toEqual(["Ready for dev", "QA"]);
    expect(within(stage(set, "Em revisão")).queryByRole("textbox")).toBeNull();
    expect(saved().columns.find((c) => c.name === "QA")).toMatchObject({ stage: "in_progress" });

    // Delete a column.
    await click(within(stage(set, "A fazer")).getAllByRole("button", { name: "Excluir coluna" })[0] as HTMLElement);
    await settle(4);
    expect(namesIn(stage(set, "A fazer"))).toEqual(["Ideias"]);
    expect(saved().columns.some((c) => c.name === "Triagem")).toBe(false);
  });

  test("deletes a set after a confirmation, and its boards are not touched", async () => {
    const state = await go();
    await click(screen().getByRole("button", { name: "Novo conjunto" }));
    await type(within(screen().getByRole("dialog")).getByRole("textbox", { name: "Nome do conjunto" }), "Suporte");
    await click(within(screen().getByRole("dialog")).getByRole("button", { name: "Salvar" }));
    await settle(4);

    await click(within(card("Suporte")).getByRole("button", { name: "Excluir conjunto" }));
    const dialog = screen().getByRole("dialog", { name: 'Excluir o conjunto "Suporte"?' });
    expect(within(dialog).getByText("Os boards que começaram dele ficam com as suas colunas.")).toBeTruthy();
    expect(call(state, "issues.deleteColumnTemplate")).toHaveLength(0);
    await click(within(dialog).getByRole("button", { name: "Excluir conjunto" }));
    await settle(4);
    expect(call(state, "issues.deleteColumnTemplate")).toHaveLength(1);
    expect(screen().queryByRole("heading", { level: 2, name: "Suporte" })).toBeNull();
    expect(call(state, "issues.updateColumn")).toHaveLength(0);
  });

  test("a set with no columns says so and offers Adicionar coluna", async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await api.issues.createColumnTemplate(ORG_ID, { name: "Vazio", columns: [{ name: "X", stage: "todo" }] });
    // Legacy rows may hold none: the fake keeps the list as given.
    await api.issues.updateColumnTemplate(ORG_ID, (await api.issues.columnTemplates(ORG_ID)).at(-1)?.id ?? "", {
      columns: [],
    });
    await renderApp(`/org/${ORG_ID}/settings/tasks`, { api });
    await settle(6);
    const set = card("Vazio");
    expect(within(set).getByText("Este conjunto não tem colunas.")).toBeTruthy();
    await click(within(set).getAllByRole("button", { name: "Adicionar coluna" })[0] as HTMLElement);
    const form = set.querySelector("form") as HTMLFormElement;
    await type(within(form).getByRole("textbox", { name: "Nome da coluna" }), "Primeira");
    await act(async () => fireEvent.submit(form));
    await settle(4);
    expect(namesIn(stage("Vazio", "A fazer"))).toEqual(["Primeira"]);
  });

  test("read-only without permission to create tasks", async () => {
    await go(readOnly());
    expect(screen().getByText("Só quem pode criar tarefas muda os conjuntos.")).toBeTruthy();
    // The sets and their columns are there to read.
    expect(screen().getByRole("heading", { level: 2, name: "Desenvolvimento" })).toBeTruthy();
    expect(within(stage("Desenvolvimento", "A fazer")).getByText("Backlog")).toBeTruthy();
    // Nothing changes a set: no field, no button inside the settings body.
    const body = document.querySelector(".settings__body") as HTMLElement;
    expect(within(body).queryByRole("textbox")).toBeNull();
    expect(within(body).queryByRole("combobox")).toBeNull();
    expect(within(body).queryByRole("button", { name: "Novo conjunto" })).toBeNull();
    expect(within(body).queryByRole("button", { name: /Renomear|Excluir|Adicionar|Mover/ })).toBeNull();
  });
});
