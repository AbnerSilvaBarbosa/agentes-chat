import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { useIssueColumns } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { useOrg } from "@/components/org-context";
import { BoardColumnsDialog, ColumnEditor, type EditorColumn } from "@/pages/BoardColumns";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { pick } from "./new-agent-flow";
import { renderApp, renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));

const COLUMNS: EditorColumn[] = [
  { id: "a", name: "Backlog", stage: "todo" },
  { id: "b", name: "Teste humano", stage: "in_review", waits: true },
  { id: "c", name: "Concluído", stage: "done" },
];

describe("the switch Espera uma pessoa in the columns dialog", () => {
  /** The dialog on a board's columns, fed by the same query the board uses. */
  function Harness({ projectId }: { projectId: string | null }) {
    const { org } = useOrg();
    const columns = useIssueColumns(org.id, projectId).data ?? [];
    const [open, setOpen] = useState(true);
    return <BoardColumnsDialog open={open} projectId={projectId} columns={columns} onClose={() => setOpen(false)} />;
  }
  const open = async (projectId: string | null = "board-1") => {
    const state = seedState();
    await renderPage(<Harness projectId={projectId} />, { api: createFakeApi(state), org: true });
    await settle(4);
    return { state, dialog: screen().getByRole("dialog", { name: "Colunas do board" }) };
  };
  const stage = (dialog: HTMLElement, name: string) => within(dialog).getByRole("region", { name });

  test("shows the switch Espera uma pessoa on each column off by default", async () => {
    const { dialog } = await open();
    for (const name of ["A fazer", "Em andamento", "Em revisão", "Feito"]) {
      const switches = within(stage(dialog, name)).getAllByRole("switch", { name: "Espera uma pessoa" });
      expect(switches).toHaveLength(1);
      expect(switches[0]?.getAttribute("aria-checked")).toBe("false");
    }
  });

  test("turning the switch on sends the flag for that column", async () => {
    const { state, dialog } = await open();
    await click(within(stage(dialog, "Em revisão")).getByRole("switch", { name: "Espera uma pessoa" }));
    await settle(3);
    const sent = state.calls.filter((c) => c.method === "issues.updateColumn");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args[0]).toBe("col-in_review");
    expect(sent[0]?.args[1]).toMatchObject({ waitsForPerson: true, projectId: "board-1" });
    // The screen shows it on that column only, once the answer is back.
    expect(
      within(stage(dialog, "Em revisão"))
        .getByRole("switch", { name: "Espera uma pessoa" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      within(stage(dialog, "A fazer")).getByRole("switch", { name: "Espera uma pessoa" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("turning a flagged column's switch off sends the clear", async () => {
    const { state, dialog } = await open();
    const sw = () => within(stage(dialog, "A fazer")).getByRole("switch", { name: "Espera uma pessoa" });
    await click(sw());
    await settle(3);
    await click(sw());
    await settle(3);
    const sent = state.calls.filter((c) => c.method === "issues.updateColumn");
    expect(sent.map((c) => (c.args[1] as { waitsForPerson?: boolean }).waitsForPerson)).toEqual([true, false]);
    expect(sw().getAttribute("aria-checked")).toBe("false");
  });
});

describe("ColumnEditor's switch", () => {
  const editor = async (props: Partial<Parameters<typeof ColumnEditor>[0]> = {}) => {
    const calls: unknown[][] = [];
    await renderPage(
      <ColumnEditor
        columns={COLUMNS}
        onRename={() => {}}
        onStage={() => {}}
        onMove={() => {}}
        onAdd={() => {}}
        onDelete={() => {}}
        onWaits={(id, on) => {
          calls.push([id, on]);
        }}
        {...props}
      />,
      { api: createFakeApi(seedState()) },
    );
    return calls;
  };

  test("a flagged column's switch is on and the others are off", async () => {
    await editor();
    const state = (name: string) =>
      within(screen().getByRole("region", { name }))
        .getByRole("switch", { name: "Espera uma pessoa" })
        .getAttribute("aria-checked");
    expect(state("A fazer")).toBe("false");
    expect(state("Em revisão")).toBe("true");
    expect(state("Feito")).toBe("false");
  });

  test("the switch reports its column's id and the new value", async () => {
    const calls = await editor();
    await click(within(screen().getByRole("region", { name: "A fazer" })).getByRole("switch"));
    await click(within(screen().getByRole("region", { name: "Em revisão" })).getByRole("switch"));
    expect(calls).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  test("the editor shows no switch when it is read only or when it is given no handler", async () => {
    await editor({ readOnly: true });
    expect(screen().queryByRole("switch")).toBeNull();
    cleanup();
    await editor({ onWaits: undefined });
    expect(screen().queryByRole("switch")).toBeNull();
    expect(screen().getAllByRole("textbox", { name: "Nome da coluna" })).toHaveLength(3);
  });
});

describe("the status-set editor in Configurações › Tarefas", () => {
  type State = ReturnType<typeof seedState>;
  const go = async (state: State = seedState()) => {
    await renderApp(`/org/${ORG_ID}/settings/tasks`, { api: createFakeApi(state) });
    await settle(6);
    return state;
  };
  const set = "Desenvolvimento";
  const stage = (name: string) => within(screen().getByRole("region", { name: set })).getByRole("region", { name });
  const sw = (name: string) => within(stage(name)).getByRole("switch", { name: "Espera uma pessoa" });
  const names = (name: string) =>
    within(stage(name))
      .getAllByRole("textbox", { name: "Nome da coluna" })
      .map((i) => (i as HTMLInputElement).value);
  const saved = (state: State) =>
    state.calls.filter((c) => c.method === "issues.updateColumnTemplate").at(-1)?.args[1] as {
      columns: { name: string; stage: string; waitsForPerson?: boolean }[];
    };

  test("flagging a column saves the set with waitsForPerson on that column only", async () => {
    const state = await go();
    expect(sw("Em revisão").getAttribute("aria-checked")).toBe("false");
    await click(sw("Em revisão"));
    await settle(4);
    expect(sw("Em revisão").getAttribute("aria-checked")).toBe("true");
    expect(saved(state).columns.filter((c) => c.waitsForPerson)).toEqual([
      { name: "QA", stage: "in_review", waitsForPerson: true },
    ]);
    // Switching it off saves the set with no flag.
    await click(sw("Em revisão"));
    await settle(4);
    expect(saved(state).columns.some((c) => c.waitsForPerson)).toBe(false);
  });

  test("a status set's editor keeps a flag through a rename", async () => {
    const state = await go();
    await click(sw("Em revisão"));
    await settle(4);
    const field = within(stage("Em revisão")).getByRole("textbox", { name: "Nome da coluna" });
    await act(async () => fireEvent.change(field, { target: { value: "QA humano" } }));
    await act(async () => fireEvent.blur(field));
    await settle(4);
    expect(names("Em revisão")).toEqual(["QA humano"]);
    expect(saved(state).columns.find((c) => c.name === "QA humano")).toEqual({
      name: "QA humano",
      stage: "in_review",
      waitsForPerson: true,
    });
    expect(sw("Em revisão").getAttribute("aria-checked")).toBe("true");
  });

  test("a flagged column keeps its flag when its stage changes, and a column added starts unflagged", async () => {
    const state = await go();
    await click(sw("Em revisão"));
    await settle(4);
    await pick(within(stage("Em revisão")).getByRole("combobox", { name: "Etapa" }), "Em andamento");
    await settle(4);
    expect(saved(state).columns.find((c) => c.name === "QA")).toEqual({
      name: "QA",
      stage: "in_progress",
      waitsForPerson: true,
    });
    expect(names("Em andamento")).toEqual(["Ready for dev", "QA"]);
    // The moved column is the second of its new stage and still on.
    expect(
      within(stage("Em andamento"))
        .getAllByRole("switch")
        .map((s) => s.getAttribute("aria-checked")),
    ).toEqual(["false", "true"]);

    await click(within(stage("Feito")).getByRole("button", { name: "Adicionar coluna" }));
    const form = stage("Feito").querySelector("form") as HTMLFormElement;
    await act(async () =>
      fireEvent.change(within(form).getByRole("textbox", { name: "Nome da coluna" }), {
        target: { value: "Arquivado" },
      }),
    );
    await act(async () => fireEvent.submit(form));
    await settle(4);
    expect(saved(state).columns.find((c) => c.name === "Arquivado")).toEqual({ name: "Arquivado", stage: "done" });
  });

  test("moving a flagged column inside its stage keeps its flag", async () => {
    const state = await go();
    await click(within(stage("A fazer")).getByRole("button", { name: "Adicionar coluna" }));
    const form = stage("A fazer").querySelector("form") as HTMLFormElement;
    await act(async () =>
      fireEvent.change(within(form).getByRole("textbox", { name: "Nome da coluna" }), { target: { value: "Triagem" } }),
    );
    await act(async () => fireEvent.submit(form));
    await settle(4);
    expect(names("A fazer")).toEqual(["Backlog", "Triagem"]);
    await click(within(stage("A fazer")).getAllByRole("switch")[0] as HTMLElement);
    await settle(4);
    await click(within(stage("A fazer")).getAllByRole("button", { name: "Mover para a direita" })[0] as HTMLElement);
    await settle(4);
    expect(names("A fazer")).toEqual(["Triagem", "Backlog"]);
    expect(
      within(stage("A fazer"))
        .getAllByRole("switch")
        .map((s) => s.getAttribute("aria-checked")),
    ).toEqual(["false", "true"]);
    expect(saved(state).columns.find((c) => c.name === "Backlog")?.waitsForPerson).toBe(true);
  });

  test("a set the person may not edit shows no switch", async () => {
    const state = seedState();
    const org = state.me?.organizations[0];
    if (org) {
      org.role = "member";
      org.permissions = ["read"];
    }
    await go(state);
    expect(screen().getByRole("region", { name: set })).toBeTruthy();
    expect(screen().queryByRole("switch")).toBeNull();
  });
});
