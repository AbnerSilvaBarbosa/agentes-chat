import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type ApiClient, ApiError, useIssueColumns } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { useOrg } from "@/components/org-context";
import { BoardColumnsDialog } from "@/pages/BoardColumns";
import { createFakeApi, ORG_ID, seedState } from "./fake-api";
import { pick } from "./new-agent-flow";
import { renderPage, screen, settle } from "./render";

afterEach(() => cleanup());

const click = (el: Element) => act(async () => fireEvent.click(el));
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));
const blur = (el: Element) => act(async () => fireEvent.blur(el));

const BOARD = "board-1";

/** The columns dialog of one board, fed by the same query the board page uses. */
function Harness() {
  const { org } = useOrg();
  const columns = useIssueColumns(org.id, BOARD).data ?? [];
  const [open, setOpen] = useState(true);
  return <BoardColumnsDialog open={open} projectId={BOARD} columns={columns} onClose={() => setOpen(false)} />;
}

async function open(
  prepare: (api: ApiClient) => Promise<unknown> | unknown = () => {},
  wrap = (api: ApiClient) => api,
) {
  const state = seedState();
  const base = createFakeApi(state);
  await prepare(base);
  await renderPage(<Harness />, { api: wrap(base), org: true });
  await settle(4);
  const dialog = screen().getByRole("dialog", { name: "Colunas do board" });
  return { state, api: base, dialog, alerts: within(dialog).getByRole("region", { name: "Avisos" }) };
}

const rows = (alerts: HTMLElement) => alerts.querySelectorAll(".board-alerts__row");
const text = (el: Element | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("a board's Avisos", () => {
  test("a board with no rule shows its empty state", async () => {
    const { alerts } = await open();
    expect(within(alerts).getByText("Nenhum aviso ainda")).toBeTruthy();
    expect(within(alerts).getByRole("button", { name: "Novo aviso" })).toBeTruthy();
    expect(rows(alerts)).toHaveLength(0);
  });

  test("lists the board's rules as De status para status → agent, each with a remove button", async () => {
    const { alerts } = await open(async (api) => {
      const ada = (await api.agents.list(ORG_ID))[0];
      await api.issues.addBoardAlert(ORG_ID, BOARD, {
        agentId: ada?.id ?? "",
        columnId: "col-in_progress",
        fromColumnId: "col-todo",
      });
      await api.issues.addBoardAlert(ORG_ID, BOARD, { agentId: ada?.id ?? "", columnId: "col-done" });
    });
    const list = [...rows(alerts)];
    expect(list.map(text)).toEqual(["De A fazer para Em andamento → Ada", "De Qualquer para Feito → Ada"]);
    for (const row of list) {
      expect(within(row as HTMLElement).getByRole("button", { name: "Remover aviso" })).toBeTruthy();
    }
    expect(within(alerts).queryByText("Nenhum aviso ainda")).toBeNull();
  });

  test("adding a rule asks for the destination, the source (Qualquer) and the agent, then shows the new row", async () => {
    const { alerts, state } = await open();
    await click(within(alerts).getByRole("button", { name: "Novo aviso" }));
    const to = within(alerts).getByRole("combobox", { name: "Para o status" });
    const from = within(alerts).getByRole("combobox", { name: "Do status" });
    const agent = within(alerts).getByRole("combobox", { name: "Agente a avisar" });
    // The source starts at Qualquer.
    expect(from.textContent).toContain("Qualquer");

    await pick(to, "Em andamento");
    await pick(from, "A fazer");
    await pick(agent, "Atlas");
    await click(within(alerts).getByRole("button", { name: "Salvar" }));
    await settle(4);

    expect(state.calls.find((c) => c.method === "issues.addBoardAlert")?.args).toEqual([
      BOARD,
      { agentId: expect.any(String), columnId: "col-in_progress", fromColumnId: "col-todo" },
    ]);
    expect([...rows(alerts)].map(text)).toEqual(["De A fazer para Em andamento → Atlas"]);
    // The form closed: the button is back.
    expect(within(alerts).getByRole("button", { name: "Novo aviso" })).toBeTruthy();
  });

  test("removing a rule takes its row away and brings the empty state back", async () => {
    const { alerts, state } = await open(async (api) => {
      const ada = (await api.agents.list(ORG_ID))[0];
      await api.issues.addBoardAlert(ORG_ID, BOARD, { agentId: ada?.id ?? "", columnId: "col-done" });
    });
    expect(rows(alerts)).toHaveLength(1);
    await click(within(alerts).getByRole("button", { name: "Remover aviso" }));
    await settle(4);
    expect(state.calls.some((c) => c.method === "issues.removeBoardAlert")).toBe(true);
    expect(rows(alerts)).toHaveLength(0);
    expect(within(alerts).getByText("Nenhum aviso ainda")).toBeTruthy();
  });

  test("a renamed column shows its new name in the rule", async () => {
    const { alerts, dialog } = await open(async (api) => {
      const ada = (await api.agents.list(ORG_ID))[0];
      await api.issues.addBoardAlert(ORG_ID, BOARD, { agentId: ada?.id ?? "", columnId: "col-in_progress" });
    });
    expect(text(rows(alerts)[0])).toBe("De Qualquer para Em andamento → Ada");
    const field = within(within(dialog).getByRole("region", { name: "Em andamento" })).getByRole("textbox", {
      name: "Nome da coluna",
    });
    await type(field, "Em dev");
    await blur(field);
    await settle(4);
    expect(text(rows(alerts)[0])).toBe("De Qualquer para Em dev → Ada");
  });

  test("a refused rule says why and adds no row", async () => {
    const { alerts } = await open(undefined, (api) => ({
      ...api,
      issues: {
        ...api.issues,
        addBoardAlert: () =>
          Promise.reject(
            new ApiError(403, "routine.manage_forbidden", "Only an admin or the agent's owner can do this"),
          ),
      },
    }));
    await click(within(alerts).getByRole("button", { name: "Novo aviso" }));
    await click(within(alerts).getByRole("button", { name: "Salvar" }));
    await settle(4);
    expect(document.body.textContent).toContain("Só o dono do agente ou um admin pode fazer isso.");
    expect(rows(alerts)).toHaveLength(0);
    // The form stays, with what was chosen.
    expect(within(alerts).getByRole("button", { name: "Salvar" })).toBeTruthy();
  });
});
