import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import type { PoCompany } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** The sidebar's Início and PO rows, and the PO agent's own row (ADR 0185 addendum). */

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

const team = (patch: Partial<FakeState> = {}): FakeState =>
  seedState({ poAgentId: ADA_ID, poCompanies: [company("s-acme", "Acme")], ...patch });

const personal = (state: FakeState): FakeState => {
  const org = state.me?.organizations[0];
  if (org) org.mode = "personal";
  for (const a of state.approvals) a.status = "approved";
  for (const p of state.proposals) p.status = "accepted";
  return state;
};

const go = async (state: FakeState) => {
  await renderApp(`/org/${ORG_ID}/c/${ENG_ID}`, { api: createFakeApi(state) });
  await settle(8);
  return state;
};
const click = async (el: Element) => {
  await act(async () => fireEvent.click(el));
  await settle(3);
};
const nav = () => document.getElementById("app-nav") as HTMLElement;
/** The rows at the top of the tools, in order. */
const top = () =>
  [...nav().querySelectorAll(".sidebar__tools > a.sidebar__item")].map((a) => ({
    label: a.querySelector(".sidebar__item-label")?.textContent,
    href: a.getAttribute("href"),
  }));

describe("Início and PO in the sidebar's tools", () => {
  test("a PO row sits directly below Início while the workspace has a PO", async () => {
    await go(team());
    const [home, po] = top();
    expect(home?.label).toBe("Início");
    expect(po).toEqual({ label: "PO", href: `/org/${ORG_ID}/po` });
  });

  test("a workspace without a PO shows no PO row", async () => {
    await go(team({ poAgentId: null }));
    expect(top().map((r) => r.label)).not.toContain("PO");
    expect(top()[0]?.label).toBe("Início");
  });

  test("Início is in sight in a team and in a personal workspace", async () => {
    await go(team());
    expect(top()[0]).toEqual({ label: "Início", href: `/org/${ORG_ID}/home` });
    cleanup();
    await go(personal(team()));
    expect(top()[0]).toEqual({ label: "Início", href: `/org/${ORG_ID}/home` });
    expect(top()[1]?.label).toBe("PO");
  });

  test("the rail names the PO row as its tooltip", async () => {
    await go(team());
    const row = () => within(nav()).getByRole("link", { name: "PO" });
    expect(row().getAttribute("title")).toBeNull();
    await click(within(nav()).getByRole("button", { name: "Minimizar barra lateral" }));
    expect(row().getAttribute("title")).toBe("PO");
    await click(within(nav()).getByRole("button", { name: "Expandir barra lateral" }));
  });

  test("pressing the PO row opens the PO chat of the first company", async () => {
    const state = await go(team());
    await click(within(nav()).getByRole("link", { name: "PO" }));
    expect(state.calls.filter((c) => c.method === "po.openChat").map((c) => c.args[1])).toEqual(["s-acme"]);
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
  });
});

/** An agent's row in the sidebar's agent list: its link. */
const agentLink = (id: string) => nav().querySelector(`[data-agent-row="${id}"] a.sidebar__item`) as HTMLElement;

describe("the PO agent's row", () => {
  test("the PO agent's row opens the PO view", async () => {
    const state = await go(team());
    expect(agentLink(ADA_ID).getAttribute("href")).toBe(`/org/${ORG_ID}/po`);
    await click(agentLink(ADA_ID));
    expect(state.calls.filter((c) => c.method === "po.openChat").map((c) => c.args[1])).toEqual(["s-acme"]);
    expect(screen().getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    expect(document.querySelector(".po-switch")).not.toBeNull();
  });

  test("another agent's row opens its own DM", async () => {
    await go(team());
    expect(agentLink(ATLAS_ID).getAttribute("href")).toBe(`/org/${ORG_ID}/dm/agent/${ATLAS_ID}`);
  });

  test("an unset PO gives an ordinary agent row", async () => {
    await go(team({ poAgentId: null }));
    expect(agentLink(ADA_ID).getAttribute("href")).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
  });
});
