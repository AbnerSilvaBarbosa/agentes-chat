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
