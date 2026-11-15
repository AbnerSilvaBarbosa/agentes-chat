import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { useIssueColumns } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { useOrg } from "@/components/org-context";
import { BoardColumnsDialog, ColumnEditor, type EditorColumn } from "@/pages/BoardColumns";
import { createFakeApi, seedState } from "./fake-api";
import { renderPage, screen, settle } from "./render";

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
