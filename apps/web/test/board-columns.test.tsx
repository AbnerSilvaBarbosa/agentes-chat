import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { useIssueColumns } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { useOrg } from "@/components/org-context";
import { BoardColumnsDialog, ColumnEditor, type EditorColumn } from "@/pages/BoardColumns";
import { createFakeApi, seedState } from "./fake-api";
import { pick } from "./new-agent-flow";
import { renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const blur = (el: Element) => act(async () => fireEvent.blur(el));

const COLUMNS: EditorColumn[] = [
  { id: "a", name: "Backlog", stage: "todo" },
  { id: "b", name: "Especificar", stage: "todo" },
  { id: "c", name: "Em dev", stage: "in_progress" },
  { id: "d", name: "Concluído", stage: "done" },
];
const stageOf = (name: string) => screen().getByRole("region", { name });

/** The editor with every callback written down. */
async function editor(props: Partial<Parameters<typeof ColumnEditor>[0]> = {}) {
  const calls: unknown[][] = [];
  const log =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  await renderPage(
    <ColumnEditor
      columns={COLUMNS}
      onRename={log("rename")}
      onStage={log("stage")}
      onMove={log("move")}
      onAdd={log("add")}
      onDelete={log("delete")}
      {...props}
    />,
    { api: createFakeApi(seedState()) },
  );
  return calls;
}

describe("ColumnEditor", () => {
  test("lists each stage with its columns, and a rename is sent when the field loses focus", async () => {
    const calls = await editor();
    const todo = stageOf("A fazer");
    expect(
      within(todo)
        .getAllByRole("textbox", { name: "Nome da coluna" })
        .map((i) => (i as HTMLInputElement).value),
    ).toEqual(["Backlog", "Especificar"]);
    expect(within(stageOf("Feito")).getAllByRole("textbox")).toHaveLength(1);

    const first = within(todo).getAllByRole("textbox", { name: "Nome da coluna" })[0] as HTMLElement;
    await type(first, "Ideias");
    expect(calls).toEqual([]);
    await blur(first);
    expect(calls).toEqual([["rename", "a", "Ideias"]]);
    // An empty or unchanged name sends nothing.
    const second = within(todo).getAllByRole("textbox", { name: "Nome da coluna" })[1] as HTMLElement;
    await type(second, "   ");
    await blur(second);
    expect(calls).toHaveLength(1);
  });

  test("moves a column up or down inside its stage; the ends cannot go further", async () => {
    const calls = await editor();
    const todo = stageOf("A fazer");
    const ups = within(todo).getAllByRole("button", { name: "Mover para a esquerda" });
    const downs = within(todo).getAllByRole("button", { name: "Mover para a direita" });
    expect((ups[0] as HTMLButtonElement).disabled).toBe(true);
    expect((downs[1] as HTMLButtonElement).disabled).toBe(true);
    await click(downs[0] as HTMLElement);
    await click(ups[1] as HTMLElement);
    expect(calls).toEqual([
      ["move", "a", 1],
      ["move", "b", 0],
    ]);
  });

  test("moves a column to another stage with its select", async () => {
    const calls = await editor();
    const select = within(stageOf("Em andamento")).getByRole("combobox", { name: "Etapa" });
    await pick(select, "Em revisão");
    expect(calls).toEqual([["stage", "c", "in_review"]]);
  });

  test("deletes a column, naming a neighbour of its stage; the last of a stage stays", async () => {
    const calls = await editor();
    const trash = within(stageOf("A fazer")).getAllByRole("button", { name: "Excluir coluna" });
    await click(trash[0] as HTMLElement);
    expect(calls).toEqual([["delete", "a", "b"]]);
    // One column alone in its stage cannot be deleted (the board keeps one per stage).
    expect(
      (within(stageOf("Em andamento")).getByRole("button", { name: "Excluir coluna" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("a set may drop its stage's last column when its own rule allows it", async () => {
    const calls = await editor({ canDelete: (_c, _in) => true });
    await click(within(stageOf("Em andamento")).getByRole("button", { name: "Excluir coluna" }));
    expect(calls).toEqual([["delete", "c", null]]);
  });

  test("adds a column at the end of a stage: the form opens, takes a name and closes once it was added", async () => {
    const calls = await editor();
    const done = stageOf("Feito");
    await click(within(done).getByRole("button", { name: "Adicionar coluna" }));
    const form = done.querySelector("form") as HTMLFormElement;
    const save = within(form).getByRole("button", { name: "Salvar" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await type(within(form).getByRole("textbox", { name: "Nome da coluna" }), "Arquivado");
    await act(async () => fireEvent.submit(form));
    await settle(2);
    expect(calls).toEqual([["add", "done", "Arquivado", "d"]]);
    // Closed: the button is back.
    expect(within(done).getByRole("button", { name: "Adicionar coluna" })).toBeTruthy();
  });

  test("a refused add keeps the form open with what was typed", async () => {
    await editor({ onAdd: () => Promise.reject(new Error("no")) });
    const todo = stageOf("A fazer");
    await click(within(todo).getByRole("button", { name: "Adicionar coluna" }));
    const form = todo.querySelector("form") as HTMLFormElement;
    await type(within(form).getByRole("textbox"), "Nova");
    await act(async () => fireEvent.submit(form));
    await settle(2);
    expect((within(todo).getAllByRole("textbox", { name: "Nome da coluna" }).at(-1) as HTMLInputElement).value).toBe(
      "Nova",
    );
  });

  test("with no columns every stage still offers Adicionar coluna", async () => {
    await editor({ columns: [] });
    expect(screen().getAllByRole("button", { name: "Adicionar coluna" })).toHaveLength(4);
  });

  test("read only: the names by stage and no control", async () => {
    await editor({ readOnly: true });
    expect(within(stageOf("A fazer")).getByText("Backlog")).toBeTruthy();
    expect(screen().queryByRole("textbox")).toBeNull();
    expect(screen().queryByRole("button")).toBeNull();
    expect(screen().queryByRole("region", { name: "Em revisão" })).toBeNull();
  });
});

describe("BoardColumnsDialog keeps its behaviour on top of the editor", () => {
  /** The dialog on the workspace's own columns, fed by the same query the board uses. */
  function Harness() {
    const { org } = useOrg();
    const columns = useIssueColumns(org.id, null).data ?? [];
    const [open, setOpen] = useState(true);
    return <BoardColumnsDialog open={open} projectId={null} columns={columns} onClose={() => setOpen(false)} />;
  }
  const open = async () => {
    const state = seedState();
    const api = createFakeApi(state);
    await renderPage(<Harness />, { api, org: true });
    await settle(4);
    return { state, dialog: screen().getByRole("dialog", { name: "Colunas do board" }) };
  };
  const section = (dialog: HTMLElement, stage: string) => within(dialog).getByRole("region", { name: stage });
  const names = (el: HTMLElement) =>
    within(el)
      .getAllByRole("textbox", { name: "Nome da coluna" })
      .map((i) => (i as HTMLInputElement).value);

  test("each stage shows its column, named after the stage until renamed; a rename is saved on blur", async () => {
    const { state, dialog } = await open();
    expect(names(section(dialog, "A fazer"))).toEqual(["A fazer"]);
    const field = within(section(dialog, "A fazer")).getByRole("textbox", { name: "Nome da coluna" });
    await type(field, "Esta semana");
    await blur(field);
    await settle(3);
    expect(state.calls.find((c) => c.method === "issues.updateColumn")?.args).toEqual([
      "col-todo",
      { name: "Esta semana" },
    ]);
    expect(names(section(dialog, "A fazer"))).toEqual(["Esta semana"]);
  });

  test("adds a column to a stage, then moves it up and sends it to another stage", async () => {
    const { state, dialog } = await open();
    const todo = () => section(dialog, "A fazer");
    await click(within(todo()).getByRole("button", { name: "Adicionar coluna" }));
    await type(within(todo()).getAllByRole("textbox", { name: "Nome da coluna" }).at(-1) as HTMLElement, "Ideias");
    await act(async () => fireEvent.submit(todo().querySelector("form") as HTMLFormElement));
    await settle(4);
    expect(state.calls.find((c) => c.method === "issues.addColumn")?.args[0]).toMatchObject({
      name: "Ideias",
      stage: "todo",
      afterId: "col-todo",
    });
    expect(names(todo())).toEqual(["A fazer", "Ideias"]);

    await click(within(todo()).getAllByRole("button", { name: "Mover para a esquerda" })[1] as HTMLElement);
    await settle(3);
    expect(names(todo())).toEqual(["Ideias", "A fazer"]);

    const select = within(todo()).getAllByRole("combobox", { name: "Etapa" })[0] as HTMLElement;
    await pick(select, "Feito");
    await settle(3);
    expect(names(section(dialog, "Feito"))).toContain("Ideias");
    expect(names(todo())).toEqual(["A fazer"]);
  });

  test("deletes a column, naming the one of its stage that takes its tasks; a stage's only column cannot go", async () => {
    const { state, dialog } = await open();
    expect(
      (within(section(dialog, "A fazer")).getByRole("button", { name: "Excluir coluna" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await click(within(section(dialog, "A fazer")).getByRole("button", { name: "Adicionar coluna" }));
    await type(
      within(section(dialog, "A fazer")).getAllByRole("textbox", { name: "Nome da coluna" }).at(-1) as HTMLElement,
      "Ideias",
    );
    await act(async () => fireEvent.submit(section(dialog, "A fazer").querySelector("form") as HTMLFormElement));
    await settle(4);
    await click(
      within(section(dialog, "A fazer")).getAllByRole("button", { name: "Excluir coluna" })[1] as HTMLElement,
    );
    await settle(3);
    expect(state.calls.find((c) => c.method === "issues.deleteColumn")?.args[1]).toBe("col-todo");
    expect(names(section(dialog, "A fazer"))).toEqual(["A fazer"]);
  });
});
