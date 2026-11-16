import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { Actor, Member } from "@agenteschat/client";
import { assignmentWith } from "@agenteschat/client/lib/issue-assignees";
import { ISSUES_VIEW_DEFAULT } from "@agenteschat/client/lib/issues-view";
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

describe("the new card dialog", () => {
  test("the new card dialog takes several people", async () => {
    const api = createFakeApi(seedState(), { seed: false });
    await api.issues.create(ORG_ID, { title: "Algo meu", assignee: walter });
    await renderApp(`/org/${ORG_ID}/my-tasks`, { api });
    await settle(8);
    // Minhas tarefas starts the card with the member as its first person.
    await click(within(document.querySelector(".ac-pagehead__actions") as HTMLElement).getByRole("button"));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Nova tarefa" });
    const field = within(dialog).getByRole("button", { name: /^Responsável: Walter/ });
    field.focus();
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
      fireEvent.keyUp(field, { key: "Enter" });
    });
    await settle(3);
    await click(within(screen().getByRole("menu")).getByRole("menuitemcheckbox", { name: /^João/ }));
    await act(async () => fireEvent.keyDown(screen().getByRole("menu"), { key: "Escape" }));
    await settle(3);
    expect(
      within(dialog)
        .getByRole("button", { name: /^Responsável/ })
        .getAttribute("aria-label"),
    ).toBe("Responsável: Walter. Também com: João.");
    await act(async () =>
      fireEvent.change(within(dialog).getByLabelText("Título"), { target: { value: "Testar o checkout" } }),
    );
    await click(within(dialog).getByRole("button", { name: "Criar tarefa" }));
    await settle(8);
    const made = (await api.issues.list(ORG_ID)).find((i) => i.title === "Testar o checkout");
    expect(made?.assignee).toEqual(walter);
    expect(made?.alsoWith).toEqual([joao]);
  });
});

/** The board's or the list's cards for a set of tasks: `layout` and what Exibição shows are the view's. */
async function cards(
  layout: "board" | "list",
  tasks: { title: string; assignees: Actor[] }[],
  fields: Partial<(typeof ISSUES_VIEW_DEFAULT)["fields"]> = {},
  extra: Member[] = CROWD,
) {
  const state = seedState();
  state.members.push(...extra);
  const base = structuredClone(ISSUES_VIEW_DEFAULT);
  state.issuesView = { ...base, layout, fields: { ...base.fields, ...fields } };
  const api = createFakeApi(state, { seed: false });
  for (const t of tasks) await api.issues.create(ORG_ID, t);
  // Minhas tarefas lists the cards the member is on, as the board's cards or the list's rows of the view.
  await renderApp(`/org/${ORG_ID}/my-tasks`, { api });
  await settle(8);
  return api;
}
const crowd = CROWD.map((m) => ({ type: "person" as const, id: m.userId }));
const cardOf = (title: string) =>
  [...document.querySelectorAll<HTMLElement>("[data-card]")].find((c) => c.textContent?.includes(title)) as HTMLElement;
/** What the card says to a screen reader about who has it. */
const heardWho = (card: HTMLElement) =>
  (card.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent)
    .find((text) => text?.startsWith("Responsável")) ?? "";

describe("the board and the list", () => {
  test("a board card and a list row show the faces and read every name", async () => {
    const tasks = [
      { title: "Cinco pessoas", assignees: [walter, joao, crowd[0], crowd[1], crowd[2]] as Actor[] },
      { title: "Com o agente", assignees: [ada, walter] as Actor[] },
      { title: "Sozinho", assignees: [walter] as Actor[] },
    ];
    for (const layout of ["board", "list"] as const) {
      await cards(layout, tasks);
      const many = cardOf("Cinco pessoas");
      // Walter has it; João and two more show as faces after him, one more is a count.
      expect(many.querySelector(".issue-card__who > .ac-who > b")?.textContent).toBe("Walter");
      expect(many.querySelectorAll(".issue-card__also > .ac-avatar")).toHaveLength(3);
      expect(many.querySelector(".issue-card__also .issue-card__more")?.textContent).toBe("+1");
      expect(heardWho(many)).toBe("Responsável: Walter. Também com: João, Bea, Caio, Dora.");
      // The agent is the principal and Walter, who is also with it, is one face.
      const agent = cardOf("Com o agente");
      expect(agent.querySelectorAll(".issue-card__also > .ac-avatar")).toHaveLength(1);
      expect(agent.querySelector(".issue-card__also .issue-card__more")).toBeNull();
      expect(heardWho(agent)).toBe("Responsável: Ada. Também com: Walter.");
      // One person alone looks as before: no faces, no count.
      const alone = cardOf("Sozinho");
      expect(alone.querySelector(".issue-card__also")).toBeNull();
      expect(heardWho(alone)).toBe("Responsável: Walter");
      cleanup();
    }
  });

  test("with Responsável off in Exibição the faces go with the principal", async () => {
    await cards("board", [{ title: "Dois", assignees: [walter, joao] }], { assignee: false });
    const card = cardOf("Dois");
    expect(card.querySelector(".issue-card__who")).toBeNull();
    expect(card.querySelector(".issue-card__also")).toBeNull();
  });
});
