import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type PoCompany } from "@agenteschat/client";
import { act, cleanup } from "@testing-library/react";
import { rememberedPoCompany, rememberPoCompany } from "@/lib/po-landing";
import { ADA_ID, ATLAS_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

/** The PO view without a company: `/po` opens the company the person used last (ADR 0185, the sidebar's PO row). */

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

const withPo = (patch: Partial<FakeState> = {}): FakeState =>
  seedState({ poAgentId: ADA_ID, poCompanies: [company("s-acme", "Acme"), company("s-beta", "Beta")], ...patch });

const go = async (state: FakeState, path: string, api = createFakeApi(state)) => {
  const app = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(8);
  return app;
};

const meId = (state: FakeState) => state.me?.user.id ?? "";

const opened = (state: FakeState) => state.calls.filter((c) => c.method === "po.openChat").map((c) => c.args[1]);

describe("the PO route", () => {
  test("the PO route opens the company opened last", async () => {
    const state = withPo();
    rememberPoCompany(meId(state), ORG_ID, "s-beta");
    const app = await go(state, "po");
    expect(opened(state)).toEqual(["s-beta"]);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/po/s-beta`);
  });

  test("with nothing remembered the PO route opens the first company", async () => {
    const state = withPo();
    const app = await go(state, "po");
    expect(opened(state)).toEqual(["s-acme"]);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/po/s-acme`);
  });

  test("a remembered company that is gone gives the first one", async () => {
    const state = withPo();
    rememberPoCompany(meId(state), ORG_ID, "s-gone");
    await go(state, "po");
    expect(opened(state)).toEqual(["s-acme"]);
    expect(rememberedPoCompany(meId(state), ORG_ID)).toBe("s-acme");
  });

  test("opening a company remembers it for the next time", async () => {
    const state = withPo();
    await go(state, "po/s-beta");
    expect(rememberedPoCompany(meId(state), ORG_ID)).toBe("s-beta");
  });

  test("a PO with no company shows the empty message", async () => {
    const state = withPo({ poCompanies: [] });
    await go(state, "po");
    expect(screen().getByText("Nenhum PO para conversar sobre essa empresa.")).toBeTruthy();
    expect(screen().queryByRole("alert")).toBeNull();
    expect(opened(state)).toEqual([]);
  });

  test("a workspace without a PO shows the empty message", async () => {
    const state = withPo({ poAgentId: null });
    await go(state, "po");
    expect(screen().getByText("Nenhum PO para conversar sobre essa empresa.")).toBeTruthy();
    expect(opened(state)).toEqual([]);
  });

  test("while the overview loads the skeleton shows", async () => {
    const state = withPo();
    const api = createFakeApi(state);
    let release: (v: Awaited<ReturnType<typeof api.po.overview>>) => void = () => {};
    const held = new Promise<Awaited<ReturnType<typeof api.po.overview>>>((r) => {
      release = r;
    });
    const real = api.po.overview;
    api.po.overview = () => held;
    await go(state, "po", api);
    expect(screen().queryByText("Nenhum PO para conversar sobre essa empresa.")).toBeNull();
    expect(screen().getByRole("status", { name: "Carregando mensagens" })).toBeTruthy();
    await act(async () => release(await real(ORG_ID)));
    await settle(8);
    expect(opened(state)).toEqual(["s-acme"]);
  });

  test("the plain DM of the PO is replaced by the PO view", async () => {
    const state = withPo();
    const app = await go(state, `dm/agent/${ADA_ID}`);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/po/s-acme`);
    expect(opened(state)).toEqual(["s-acme"]);
    expect(state.calls.some((c) => c.method === "dms.open")).toBe(false);
  });

  test("another agent's DM address still opens its DM", async () => {
    const state = withPo();
    const app = await go(state, `dm/agent/${ATLAS_ID}`);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ATLAS_ID}`);
    expect(opened(state)).toEqual([]);
  });

  test("the redirects replace the history entry, so Back does not loop through the PO route", async () => {
    const state = withPo();
    const app = await go(state, `c/${ENG_ID}`);
    await act(async () => void app.router.navigate({ to: "/org/$orgId/po", params: { orgId: ORG_ID } }));
    await settle(8);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/po/s-acme`);
    await act(async () => app.router.history.back());
    await settle(8);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/c/${ENG_ID}`);
  });

  test("when the PO overview fails the PO's plain DM address shows an error, not the plain DM", async () => {
    const state = withPo();
    const api = createFakeApi(state);
    api.po.overview = async () => {
      throw new ApiError(500, "boom", "boom");
    };
    await go(state, `dm/agent/${ADA_ID}`, api);
    expect(screen().getByRole("button", { name: "Tentar de novo" })).toBeTruthy();
    expect(state.calls.some((c) => c.method === "dms.open")).toBe(false);
  });
});
