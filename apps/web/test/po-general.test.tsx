import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { PoCompany } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** The PO's plain DM, where its routines write, reached from the PO view (ADR 0185 addendum). */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const company = (id: string, name: string): PoCompany => ({
  id,
  name,
  color: "#3366ff",
  image: null,
  archived: false,
  open: 3,
  channelId: null,
  unread: 0,
});

const scene = (unread = 0): FakeState => {
  const state = seedState({ poAgentId: ADA_ID, poCompanies: [company("s-acme", "Acme")] });
  seedDm(state, { type: "agent", id: ADA_ID }, { body: "Rotina: 3 tarefas paradas", unread });
  return state;
};

const go = async (state: FakeState, path: string) => {
  const app = await renderApp(`/org/${ORG_ID}/${path}`, { api: createFakeApi(state) });
  await settle(8);
  return app;
};
const entry = () => document.querySelector(".channel__header .po-general") as HTMLElement | null;
const poRow = () => document.querySelector('#app-nav a.sidebar__item[href$="/po"]') as HTMLElement | null;

describe("the PO's plain DM", () => {
  test("the PO view has an entry called Avisos e rotinas that opens the plain DM with its messages", async () => {
    const { router } = await go(scene(), "po/s-acme");
    expect(entry()?.textContent).toContain("Avisos e rotinas");
    await act(async () => fireEvent.click(entry() as HTMLElement));
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/po/general`);
    expect(screen().getByText("Rotina: 3 tarefas paradas")).toBeTruthy();
    // The way back to the chat by company.
    expect(entry()?.textContent).toContain("Conversa por empresa");
  });

  test("with nothing in the plain DM (the routines speak in the company's PO chat) there is no entry", async () => {
    await go(seedState({ poAgentId: ADA_ID, poCompanies: [company("s-acme", "Acme")] }), "po/s-acme");
    expect(entry()).toBeNull();
  });

  test("an unread plain DM shows its count on the entry", async () => {
    await go(scene(2), "po/s-acme");
    expect(within(entry() as HTMLElement).getByRole("img", { name: /2/ })).toBeTruthy();
    cleanup();
    await go(scene(0), "po/s-acme");
    expect(within(entry() as HTMLElement).queryByRole("img")).toBeNull();
  });

  test("?m= on the new route opens the plain DM at that message", async () => {
    const { router } = await go(scene(), "po/general?m=m-dm-ada");
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/po/general`);
    expect(router.state.location.search).toMatchObject({ m: "m-dm-ada" });
    expect(screen().getByText("Rotina: 3 tarefas paradas")).toBeTruthy();
  });

  test("a link with a message to the PO's agent DM is not swallowed: it opens the plain DM at the message", async () => {
    const { router } = await go(scene(), `dm/agent/${ADA_ID}?m=m-dm-ada`);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/po/general`);
    expect(router.state.location.search).toMatchObject({ m: "m-dm-ada" });
    expect(screen().getByText("Rotina: 3 tarefas paradas")).toBeTruthy();
  });

  test("the bare address of the PO's agent DM still goes to the PO view", async () => {
    const { router } = await go(scene(), `dm/agent/${ADA_ID}`);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/po/s-acme`);
  });

  test("the sidebar's PO row also counts a company's PO chat, where the routines write", async () => {
    const state = seedState({ poAgentId: ADA_ID, poCompanies: [{ ...company("s-acme", "Acme"), unread: 4 }] });
    await go(state, `c/${ENG_ID}`);
    expect(poRow()?.getAttribute("data-unread")).toBe("true");
    expect(within(poRow() as HTMLElement).getByRole("img", { name: /4/ })).toBeTruthy();
  });

  test("the sidebar's PO row lights with the plain DM's unread, and not without", async () => {
    await go(scene(3), `c/${ENG_ID}`);
    expect(poRow()?.getAttribute("data-unread")).toBe("true");
    expect(within(poRow() as HTMLElement).getByRole("img", { name: /3/ })).toBeTruthy();
    cleanup();
    await go(scene(0), `c/${ENG_ID}`);
    expect(poRow()?.getAttribute("data-unread")).toBeNull();
    expect(within(poRow() as HTMLElement).queryByRole("img")).toBeNull();
  });
});
