import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { UNREAD_REFRESH_MS } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { createFakeApi, ENG_ID, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => cleanup());

const ME = "u-walter";
const mine = { type: "person" as const, id: ME };
const joao = { type: "person" as const, id: "u-joao" };

const click = (el: Element) => act(async () => fireEvent.click(el));
/** A menu's trigger opens from the keyboard, as the neighbouring tests open them. */
const open = async (el: HTMLElement) => {
  el.focus();
  await act(async () => {
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.keyUp(el, { key: "Enter" });
  });
  await settle(3);
};
const type = (el: Element, value: string) => act(async () => fireEvent.change(el, { target: { value } }));

/** Acme with no task made yet, so what the page shows is only what a test assigns. */
async function setup(permissions?: string[]) {
  const state = seedState();
  if (permissions) Object.assign(state.me?.organizations[0] ?? {}, { role: "member", permissions });
  const api = createFakeApi(state, { seed: false });
  return { state, api };
}
type Setup = Awaited<ReturnType<typeof setup>>;

const visit = async (s: Setup, search = "") => {
  const r = await renderApp(`/org/${ORG_ID}/my-tasks${search}`, { api: s.api });
  await settle(8);
  return r;
};
const heading = () => document.querySelector("h1")?.textContent ?? "";
/** The titles of the cards on the board, in the order they are drawn. */
const titles = () => [...document.querySelectorAll(".issue-card__title")].map((c) => c.textContent);
const headerActions = () =>
  [...(document.querySelector(".ac-pagehead__actions")?.querySelectorAll("button") ?? [])].map(
    (b) => b.textContent?.replace(/N$/, "").trim() ?? "",
  );
const nav = () => document.getElementById("app-nav") as HTMLElement;

describe("Minhas tarefas: the page", () => {
  test("using the tool opens a page titled Minhas tarefas", async () => {
    const s = await setup();
    await s.api.issues.create(ORG_ID, { title: "Fechar o mês", assignee: mine });
    await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: s.api });
    await settle(8);
    await click(within(nav()).getByRole("link", { name: "Minhas tarefas" }));
    await settle(8);
    expect(heading()).toBe("Minhas tarefas");
    expect(titles()).toEqual(["Fechar o mês"]);
  });

  test("shows the tasks assigned to the member from every company and board, and no one else's", async () => {
    const s = await setup();
    const clinic = await s.api.issues.createSpace(ORG_ID, { name: "Clínica Teo", color: "teal" });
    const bakery = await s.api.issues.createSpace(ORG_ID, { name: "Padaria Lia", color: "amber" });
    const site = await s.api.issues.createProject(ORG_ID, { name: "Site novo", color: "amber", spaceId: clinic.id });
    const menu = await s.api.issues.createProject(ORG_ID, { name: "Cardápio", color: "teal", spaceId: bakery.id });
    await s.api.issues.create(ORG_ID, { title: "Revisar a home", projectId: site.id, assignee: mine });
    await s.api.issues.create(ORG_ID, { title: "Fotografar os pães", projectId: menu.id, assignee: mine });
    await s.api.issues.create(ORG_ID, { title: "Sem board nenhum", assignee: mine });
    await s.api.issues.create(ORG_ID, { title: "Do João", projectId: site.id, assignee: joao });
    await s.api.issues.create(ORG_ID, { title: "De ninguém", assignee: null });
    await visit(s);
    expect([...titles()].sort()).toEqual(["Fotografar os pães", "Revisar a home", "Sem board nenhum"]);
  });

  test("does not show canceled tasks", async () => {
    const s = await setup();
    await s.api.issues.create(ORG_ID, { title: "Segue valendo", assignee: mine });
    const dropped = await s.api.issues.create(ORG_ID, { title: "Desistimos disso", assignee: mine });
    await s.api.issues.update(ORG_ID, dropped.id, { status: "canceled" });
    await visit(s);
    expect(titles()).toEqual(["Segue valendo"]);
    expect(document.body.textContent).not.toContain("Desistimos disso");
  });

  test("shows a task of an archived board", async () => {
    const s = await setup();
    const old = await s.api.issues.createProject(ORG_ID, { name: "Site velho", color: "graphite" });
    await s.api.issues.create(ORG_ID, { title: "Ainda é minha", projectId: old.id, assignee: mine });
    await s.api.issues.updateProject(ORG_ID, old.id, { archived: true });
    await visit(s);
    expect(titles()).toEqual(["Ainda é minha"]);
  });

  test("adds and removes a task when its assignee changes, without a reload", async () => {
    const s = await setup();
    const kept = await s.api.issues.create(ORG_ID, { title: "Já era minha", assignee: mine });
    const other = await s.api.issues.create(ORG_ID, { title: "Era do João", assignee: joao });
    const r = await visit(s);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(3);
    expect(titles()).toEqual(["Já era minha"]);
    const heard = async () => {
      await act(async () => socket.push({ type: "event", scope: "org", event: { type: "issue.updated" } }));
      // The boards read again once per burst of events.
      await act(() => new Promise((done) => setTimeout(done, UNREAD_REFRESH_MS + 100)));
      await settle(6);
    };
    // Assigned to me: it joins the page.
    await s.api.issues.update(ORG_ID, other.id, { assignee: mine });
    await heard();
    expect([...titles()].sort()).toEqual(["Já era minha", "Era do João"].sort());
    // Taken from me: it leaves.
    await s.api.issues.update(ORG_ID, kept.id, { assignee: joao });
    await heard();
    expect(titles()).toEqual(["Era do João"]);
  });

  test("drops a deleted task", async () => {
    const s = await setup();
    const gone = await s.api.issues.create(ORG_ID, { title: "Vai sumir", assignee: mine });
    await s.api.issues.create(ORG_ID, { title: "Fica", assignee: mine });
    const r = await visit(s);
    const socket = r.sockets.last();
    await act(async () => socket.open());
    await settle(3);
    expect([...titles()].sort()).toEqual(["Fica", "Vai sumir"]);
    await s.api.issues.delete(ORG_ID, gone.id);
    await act(async () => socket.push({ type: "event", scope: "org", event: { type: "issue.deleted" } }));
    await act(() => new Promise((done) => setTimeout(done, UNREAD_REFRESH_MS + 100)));
    await settle(6);
    expect(titles()).toEqual(["Fica"]);
  });
});

describe("Minhas tarefas: the controls", () => {
  test("the header action is Nova tarefa, and nothing else", async () => {
    const s = await setup();
    await s.api.issues.create(ORG_ID, { title: "Algo meu", assignee: mine });
    await visit(s);
    expect(headerActions()).toEqual(["Nova tarefa"]);
  });

  test("a task made there is assigned to the member and shows in the list", async () => {
    const s = await setup();
    await s.api.issues.create(ORG_ID, { title: "Algo meu", assignee: mine });
    await visit(s);
    await click(within(document.querySelector(".ac-pagehead__actions") as HTMLElement).getByRole("button"));
    await settle(3);
    const dialog = screen().getByRole("dialog", { name: "Nova tarefa" });
    // The form already says who it is for.
    expect(within(dialog).getByRole("button", { name: /^Responsável: Walter/ })).toBeTruthy();
    await type(within(dialog).getByLabelText("Título"), "Pagar o contador");
    await click(within(dialog).getByRole("button", { name: "Criar tarefa" }));
    await settle(8);
    const made = (await s.api.issues.list(ORG_ID)).find((i) => i.title === "Pagar o contador");
    expect(made?.assignee).toEqual(mine);
    expect([...titles()].sort()).toEqual(["Algo meu", "Pagar o contador"]);
  });

  test("the header counts the open tasks: the done and the canceled are not in it", async () => {
    const s = await setup();
    await s.api.issues.create(ORG_ID, { title: "Uma", assignee: mine });
    await s.api.issues.create(ORG_ID, { title: "Duas", assignee: mine });
    const finished = await s.api.issues.create(ORG_ID, { title: "Feita", assignee: mine });
    await s.api.issues.update(ORG_ID, finished.id, { status: "done" });
    const dropped = await s.api.issues.create(ORG_ID, { title: "Cancelada", assignee: mine });
    await s.api.issues.update(ORG_ID, dropped.id, { status: "canceled" });
    await s.api.issues.create(ORG_ID, { title: "Do João", assignee: joao });
    await visit(s);
    expect(document.querySelector(".ac-pagehead")?.textContent).toContain("2 em aberto");
  });

  test("the page shows the Empresa and Board filters", async () => {
    const s = await setup();
    await s.api.issues.create(ORG_ID, { title: "Algo meu", assignee: mine });
    await visit(s);
    const triggers = [...document.querySelectorAll(".ac-toolbar .ac-filter__trigger")].map((t) => t.textContent);
    expect(triggers.some((t) => t?.startsWith("Empresa"))).toBe(true);
    expect(triggers.some((t) => t?.startsWith("Board"))).toBe(true);
  });

  test("a saved assignee filter from the other pages neither empties the page nor shows a chip", async () => {
    const s = await setup();
    await s.api.issues.create(ORG_ID, { title: "Algo meu", assignee: mine });
    await s.api.orgs.setIssuesView(ORG_ID, { ...(await s.api.orgs.issuesView(ORG_ID)), assignees: ["person:u-joao"] });
    await visit(s);
    expect(titles()).toEqual(["Algo meu"]);
    expect(document.querySelector(".ac-toolbar")?.textContent).not.toContain("João");
  });

  test("Filtro has no assignee choice, and the Empresa and Board selects are there", async () => {
    const s = await setup();
    await s.api.issues.create(ORG_ID, { title: "Algo meu", assignee: mine });
    await visit(s);
    const toolbar = document.querySelector(".ac-toolbar") as HTMLElement;
    const triggers = [...toolbar.querySelectorAll(".ac-filter__trigger")].map((t) => t.textContent);
    expect(triggers.some((t) => t?.startsWith("Empresa"))).toBe(true);
    expect(triggers.some((t) => t?.startsWith("Board"))).toBe(true);
    await open(within(toolbar).getByRole("button", { name: "Filtro" }));
    const menu = screen().getByRole("menu");
    expect(within(menu).queryByText("Responsável")).toBeNull();
    expect(within(menu).queryByRole("menuitemcheckbox", { name: "Eu" })).toBeNull();
    // The other filter is still offered.
    expect(within(menu).getByText("Prioridade")).toBeTruthy();
  });

  test("with no task the page says Nada com você agora and links to Todas as tarefas", async () => {
    const s = await setup();
    await s.api.issues.create(ORG_ID, { title: "Do João", assignee: joao });
    const r = await visit(s);
    expect(document.querySelector(".ac-empty__title")?.textContent).toBe("Nada com você agora");
    expect(titles()).toEqual([]);
    const link = screen().getByRole("link", { name: "Todas as tarefas" });
    await click(link);
    await settle(8);
    expect(r.router.state.location.pathname).toBe(`/org/${ORG_ID}/issues`);
    expect(heading()).toBe("Tarefas");
    expect(titles()).toEqual(["Do João"]);
  });

  test("without the right to create tasks there is no Nova tarefa", async () => {
    const s = await setup(["read", "talk_to_agents"]);
    await s.api.issues.create(ORG_ID, { title: "Algo meu", assignee: mine });
    await visit(s);
    expect(titles()).toEqual(["Algo meu"]);
    expect(screen().queryByRole("button", { name: "Nova tarefa" })).toBeNull();
    expect(headerActions()).toEqual([]);
  });
});
