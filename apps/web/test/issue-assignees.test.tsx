import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Actor, Member } from "@agenteschat/client";
import { assignmentWith } from "@agenteschat/client/lib/issue-assignees";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { useState } from "react";
import { type AssigneesChange, AssigneesField } from "@/components/issues/AssigneesField";
import { ADA_ID, ATLAS_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, renderPage, screen, settle, showIn } from "./render";

afterEach(() => cleanup());

/**
 * The responsible picker (ADR 0186) on its own: a card's principal and the people also with it, what its menu offers
 * and what each change asks of the server.
 */
const walter = { type: "person", id: "u-walter" } as const;
const joao = { type: "person", id: "u-joao" } as const;
const ada = { type: "agent", id: ADA_ID } as const;

const member = (userId: string, name: string): Member => ({
  userId,
  name,
  email: `${userId}@example.com`,
  image: null,
  role: "member",
  joinedAt: new Date(Date.now() - 86_400_000).toISOString(),
  handle: userId,
  timezone: "America/Sao_Paulo",
});
const CROWD = ["Bea", "Caio", "Dora", "Enzo", "Fê"].map((n) => member(`u-${n.toLowerCase()}`, n));
const idOf = (n: string) => `u-${n.toLowerCase()}`;

type Value = { assignee: Actor | null; alsoWith: Actor[] };

/** The picker holding what the server would answer, so a test sees what the card shows after each change. */
function Harness({ initial, seen, agents }: { initial: Value; seen: AssigneesChange[]; agents?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <AssigneesField
      value={value}
      agents={agents}
      onChange={(change) => {
        seen.push(change);
        const next = assignmentWith(value, change);
        if (next) setValue(next);
      }}
    />
  );
}

async function show(initial: Value, extra: Member[] = []) {
  const state = seedState();
  state.members.push(...extra);
  const api = createFakeApi(state, { seed: false });
  const seen: AssigneesChange[] = [];
  await renderPage(<Harness initial={initial} seen={seen} />, { api, org: true });
  await settle(4);
  return { seen };
}

/** The trigger stays in the page while its menu is open, hidden from the accessibility tree as a modal menu leaves it. */
const trigger = () => document.querySelector(".issue-assignees") as HTMLElement;
/** Opens the menu the way the neighbouring tests do: from the keyboard. */
const open = async () => {
  const el = trigger();
  el.focus();
  await act(async () => {
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyUp(el, { key: "Enter" });
  });
  await settle(3);
  return screen().getByRole("menu");
};
const click = (el: Element) => act(async () => fireEvent.click(el));
const names = (list: HTMLElement[]) => list.map((e) => e.querySelector(".ac-menu__label")?.textContent ?? "");

describe("the responsible picker", () => {
  test("the picker lets choose several people and shows the first as the principal", async () => {
    await show({ assignee: null, alsoWith: [] });
    // Nobody on it: the trigger asks for one.
    expect(trigger().textContent).toBe("Responsável");
    let menu = await open();
    await click(within(menu).getByRole("menuitemcheckbox", { name: /^Walter/ }));
    await click(within(menu).getByRole("menuitemcheckbox", { name: /^João/ }));
    // The first is the principal and the second is under Também com; the trigger reads both.
    expect(trigger().getAttribute("aria-label")).toBe("Responsável: Walter. Também com: João.");
    expect(trigger().textContent).toContain("Walter");
    expect(trigger().textContent).toContain("+1");
    await act(async () => fireEvent.keyDown(menu, { key: "Escape" }));
    await settle(3);
    menu = await open();
    const headings = [...menu.querySelectorAll(".ac-menu__heading")].map((h) => h.textContent);
    expect(headings).toEqual(["Responsável", "Também com", "Adicionar pessoa"]);
    const rows = within(menu).getAllByRole("menuitem");
    expect(names(rows)).toEqual(["WalterPrincipal", "JoãoTornar principal"]);
  });

  test("adding and removing a person sends the whole list in order", async () => {
    const { seen } = await show({ assignee: walter, alsoWith: [] }, CROWD);
    const menu = await open();
    await click(within(menu).getByRole("menuitemcheckbox", { name: /^João/ }));
    await click(within(menu).getByRole("menuitemcheckbox", { name: /^Bea/ }));
    // Taking João off leaves the others in their order.
    await click(within(menu).getByRole("menuitemcheckbox", { name: /^João/ }));
    const ids = seen.map((c) => c.assignees?.map((a) => a.id));
    expect(ids).toEqual([
      ["u-walter", "u-joao"],
      ["u-walter", "u-joao", idOf("Bea")],
      ["u-walter", idOf("Bea")],
    ]);
    expect(trigger().getAttribute("aria-label")).toBe("Responsável: Walter. Também com: Bea.");
  });

  test("make principal sends principal and is hidden while an agent is on the card", async () => {
    const { seen } = await show({ assignee: walter, alsoWith: [joao] });
    const menu = await open();
    await click(within(menu).getByRole("menuitem", { name: /^João/ }));
    expect(seen).toEqual([{ principal: joao }]);
    expect(trigger().getAttribute("aria-label")).toBe("Responsável: João. Também com: Walter.");
    cleanup();
    // The agent is the principal: no person is offered to be made one, and choosing another agent says it takes its place.
    await show({ assignee: ada, alsoWith: [walter, joao] });
    const again = await open();
    expect(within(again).queryByText("Tornar principal")).toBeNull();
    const rows = within(again).getAllByRole("menuitem");
    expect(names(rows)).toEqual(["AdaPrincipal", "Walter", "João"]);
    expect(within(again).getByRole("menuitemcheckbox", { name: /^Atlas/ }).textContent).toContain(
      "Troca o agente e as pessoas ficam",
    );
  });

  test("the sixth person's row is disabled with the hint", async () => {
    const crowd = CROWD.map((m) => ({ type: "person" as const, id: m.userId }));
    // Walter and five more: the card is full, and Fê has no room.
    const six = [joao, ...crowd.slice(0, 4)];
    await show({ assignee: walter, alsoWith: six }, CROWD);
    const menu = await open();
    const fe = within(menu).getByRole("menuitemcheckbox", { name: /^Fê/ });
    expect(fe.getAttribute("aria-disabled")).toBe("true");
    expect(within(menu).getByText("No máximo 5 pessoas também com")).toBeTruthy();
    // Someone already on it can still be taken off.
    expect(within(menu).getByRole("menuitemcheckbox", { name: /^Bea/ }).getAttribute("aria-disabled")).toBeNull();
  });
});

/** The card's page: its details' strip and the history under its tabs (the picker is the strip's Responsável). */
async function visit(setup: (api: ReturnType<typeof createFakeApi>) => Promise<number>) {
  const api = createFakeApi(seedState(), { seed: false });
  const number = await setup(api);
  const app = await renderApp(`/org/${ORG_ID}/issues/${number}`, { api });
  await settle(8);
  return { api, ...app };
}
const strip = () => screen().getByRole("group", { name: "Detalhes da tarefa" });

describe("the card's page", () => {
  test("the properties line shows the people also with", async () => {
    await visit(async (api) => {
      const card = await api.issues.create(ORG_ID, { title: "Testar o checkout", assignees: [walter, joao] });
      return card.number;
    });
    const field = within(strip()).getByRole("button", { name: /^Responsável/ });
    expect(field.getAttribute("aria-label")).toBe("Responsável: Walter. Também com: João.");
    expect(field.textContent).toContain("+1");
    // A person on it still lets the card be asked of an agent, and asking keeps both people beside the agent.
    const ask = screen().getByRole("region", { name: "Pedir a um agente" });
    await click(within(ask).getByRole("button", { name: /^Pedir à Ada/ }));
    await settle(4);
    expect(
      within(strip())
        .getByRole("button", { name: /^Responsável/ })
        .getAttribute("aria-label"),
    ).toBe("Responsável: Ada. Também com: Walter, João.");
    expect(screen().queryByRole("region", { name: "Pedir a um agente" })).toBeNull();
  });

  test("the history reads each new event in both languages", async () => {
    const { services } = await visit(async (api) => {
      const card = await api.issues.create(ORG_ID, { title: "Testar o checkout", assignees: [walter] });
      await api.issues.update(ORG_ID, card.id, { addAssignees: [joao] });
      await api.issues.update(ORG_ID, card.id, { principal: joao });
      await api.issues.update(ORG_ID, card.id, { assignee: ada });
      await api.issues.update(ORG_ID, card.id, { assignee: { type: "agent", id: ATLAS_ID } });
      await api.issues.update(ORG_ID, card.id, { removeAssignees: [walter] });
      return card.number;
    });
    await act(async () => fireEvent.mouseDown(screen().getByRole("tab", { name: "Histórico" }), { button: 0 }));
    await settle(4);
    const history = () => document.body.textContent ?? "";
    for (const words of [
      "pôs João também no card",
      "tornou João o principal",
      "passou o card de Ada para Atlas e as pessoas ficam",
      "tirou Walter do card",
    ])
      expect(history()).toContain(words);
    await showIn(services, "en");
    for (const words of [
      "added João to the task",
      "made João the principal",
      "handed the task from Ada to Atlas and the people stay",
      "took Walter off the task",
    ])
      expect(history()).toContain(words);
  });
});
