import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type CardProposalView, keys, type Message, type PoCompany } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ENG_ID, type FakeState, ORG_ID, seedDm, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

const header = () => document.querySelector(".channel__header") as HTMLElement;

/** A Select (Radix): open it with the keyboard, pick the option. */
async function pick(combobox: HTMLElement, option: RegExp | string) {
  combobox.focus();
  await act(async () => fireEvent.keyDown(combobox, { key: "Enter" }));
  await act(async () => fireEvent.click(screen().getByRole("option", { name: option })));
  await settle(8);
}

/** The PO chat (ADR 0185): the route that opens a person's chat with the PO about one company. */

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const company = (id: string, name: string, patch: Partial<PoCompany> = {}): PoCompany => ({
  id,
  name,
  color: "#3366ff",
  image: null,
  archived: false,
  open: 3,
  channelId: null,
  ...patch,
});

const say = (channelId: string, id: string, body: string, meta: Message["meta"] = {}): Message => ({
  id,
  channelId,
  threadId: null,
  author: { type: "agent", id: ADA_ID },
  body,
  mentionedAgentIds: [],
  agentRunId: null,
  meta,
  createdAt: new Date().toISOString(),
});

const withPo = (patch: Partial<FakeState> = {}): FakeState => {
  const state = seedState({
    poAgentId: ADA_ID,
    poCompanies: [company("s-acme", "Acme"), company("s-beta", "Beta")],
    ...patch,
  });
  state.messages.push(say("po-chat-s-acme", "m-acme", "Resumo da Acme"));
  state.messages.push(say("po-chat-s-beta", "m-beta", "Resumo da Beta"));
  return state;
};

const go = async (state: FakeState, path: string) => {
  const api = createFakeApi(state);
  const app = await renderApp(`/org/${ORG_ID}/${path}`, { api });
  await settle(8);
  return app;
};

describe("the PO chat's route", () => {
  test("opens that company's chat with the PO: its own messages, opened through the company", async () => {
    const state = withPo();
    await go(state, "po/s-acme");
    expect(screen().getByText("Resumo da Acme")).toBeTruthy();
    expect(state.calls.filter((c) => c.method === "po.openChat").map((c) => c.args[1])).toEqual(["s-acme"]);
    expect(document.querySelector(".channel__header")?.textContent).toContain("Ada");
  });

  test("a workspace with no PO shows the page's empty state, not an error", async () => {
    await go(withPo({ poAgentId: null }), "po/s-acme");
    expect(screen().getByText("Nenhum PO para conversar sobre essa empresa.")).toBeTruthy();
    expect(screen().queryByText("Resumo da Acme")).toBeNull();
    expect(screen().queryByRole("alert")).toBeNull();
  });

  test("an unknown company shows the same empty state and opens no chat", async () => {
    const state = withPo();
    await go(state, "po/s-nowhere");
    expect(screen().getByText("Nenhum PO para conversar sobre essa empresa.")).toBeTruthy();
    expect(state.calls.some((c) => c.method === "po.openChat")).toBe(false);
  });

  test("an archived company is not one a chat opens for", async () => {
    const state = withPo({ poCompanies: [company("s-old", "Velha", { archived: true })] });
    await go(state, "po/s-old");
    expect(screen().getByText("Nenhum PO para conversar sobre essa empresa.")).toBeTruthy();
  });
});

describe("the header names the company and offers the others", () => {
  test("the PO's name, the company in its line, and a Select of the live companies with the chat's own chosen", async () => {
    const state = withPo({
      poCompanies: [
        company("s-acme", "Acme"),
        company("s-beta", "Beta"),
        company("s-old", "Velha", { archived: true }),
      ],
    });
    await go(state, "po/s-acme");
    expect(within(header()).getByRole("heading", { level: 1, name: "Ada" })).toBeTruthy();
    expect(header().querySelector(".channel__topic")?.textContent).toBe("PO · Acme");
    const box = within(header()).getByRole("combobox", { name: "Empresa" });
    expect(box.textContent).toContain("Acme");
    box.focus();
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    const options = screen()
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Acme", "Beta"]);
  });

  test("picking another company opens that company's chat with its own messages", async () => {
    const state = withPo();
    await go(state, "po/s-acme");
    expect(screen().getByText("Resumo da Acme")).toBeTruthy();
    await pick(within(header()).getByRole("combobox", { name: "Empresa" }), "Beta");
    expect(screen().getByText("Resumo da Beta")).toBeTruthy();
    expect(screen().queryByText("Resumo da Acme")).toBeNull();
    expect(header().querySelector(".channel__topic")?.textContent).toBe("PO · Beta");
    expect(state.calls.filter((c) => c.method === "po.openChat").map((c) => c.args[1])).toEqual(["s-acme", "s-beta"]);
  });

  test("a long company name stays whole in the line, and the switch is one control in the glyphs' row", async () => {
    const long = "Companhia Brasileira de Distribuição de Alimentos Frescos e Congelados do Nordeste Ltda";
    await go(withPo({ poCompanies: [company("s-acme", long)] }), "po/s-acme");
    expect(header().querySelector(".channel__topic")?.textContent).toBe(`PO · ${long}`);
    const acts = header().querySelector(".channel__acts") as HTMLElement;
    expect(acts.querySelectorAll(":scope > .po-switch")).toHaveLength(1);
    expect(acts.contains(within(header()).getByRole("combobox", { name: "Empresa" }))).toBe(true);
  });

  test("a plain DM with the same agent has no company switch", async () => {
    await go(withPo(), `dm/agent/${ADA_ID}`);
    expect(within(header()).queryByRole("combobox", { name: "Empresa" })).toBeNull();
    expect(header().querySelector(".channel__topic")?.textContent).not.toContain("PO ·");
  });
});

describe("a decided proposal rewrites its card in the chat", () => {
  const proposal = (status: CardProposalView["status"]): CardProposalView => ({
    id: "p1",
    agentId: ADA_ID,
    requesterUserId: "u1",
    spaceId: "s-acme",
    title: "Pagar com Pix",
    summary: "",
    criteria: ["O QR code aparece"],
    project: { id: "b1", name: "Produto" },
    status,
    duplicateOf: null,
    issue: status === "confirmed" ? { id: "i1", number: 7 } : null,
    spec: null,
  });

  test("card.proposal.updated puts the whole card into the message, whoever decided", async () => {
    const state = withPo();
    state.messages.push(say("po-chat-s-acme", "m-card", "Proposta", { cardProposal: proposal("pending") }));
    const { sockets, services } = await go(state, "po/s-acme");
    const read = () =>
      services.queryClient
        .getQueryData<Message[]>(keys.messages(ORG_ID, "po-chat-s-acme"))
        ?.find((m) => m.id === "m-card")?.meta?.cardProposal as CardProposalView | undefined;
    expect(read()?.status).toBe("pending");
    await act(async () =>
      sockets.last().push({
        type: "event",
        channelId: "po-chat-s-acme",
        event: {
          type: "card.proposal.updated",
          channelId: "po-chat-s-acme",
          threadId: null,
          messageId: "m-card",
          proposal: proposal("confirmed"),
        },
      }),
    );
    await settle(4);
    expect(read()).toMatchObject({ status: "confirmed", issue: { id: "i1", number: 7 } });
  });
});

describe("Conversar com o PO on a company's page", () => {
  const TALK = "Conversar com o PO";
  const talk = () => screen().queryAllByRole("button", { name: TALK });

  async function visit(search: string, patch: Partial<FakeState> = {}) {
    const state = seedState({ poAgentId: ADA_ID, ...patch });
    const api = createFakeApi(state);
    const acme = await api.issues.createSpace(ORG_ID, { name: "Acme", color: "teal" });
    const board = await api.issues.createProject(ORG_ID, { name: "Site", color: "amber", spaceId: acme.id });
    await api.issues.create(ORG_ID, { title: "Revisar a home", projectId: board.id });
    state.poCompanies ??= [company(acme.id, "Acme")];
    const query = search.replace("{space}", acme.id).replace("{board}", board.id);
    const app = await renderApp(`/org/${ORG_ID}/issues${query}`, { api });
    await settle(8);
    return { app, acme, state };
  }

  test("a company's page offers it and selecting it opens that company's PO chat", async () => {
    const { app, acme } = await visit("?space={space}");
    expect(talk()).toHaveLength(1);
    await act(async () => fireEvent.click(talk()[0] as HTMLElement));
    await settle(8);
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/po/${acme.id}`);
  });

  test("a workspace without a PO shows no such button", async () => {
    await visit("?space={space}", { poAgentId: null });
    expect(talk()).toHaveLength(0);
  });

  test("a board's page, the companies' root and Todas as tarefas show none", async () => {
    await visit("?project={board}");
    expect(talk()).toHaveLength(0);
    cleanup();
    await visit("");
    expect(talk()).toHaveLength(0);
    cleanup();
    await visit("?all=1");
    expect(talk()).toHaveLength(0);
  });

  test("an archived company offers none: no chat opens for it", async () => {
    await visit("?space={space}", { poCompanies: [] });
    expect(talk()).toHaveLength(0);
  });
});

describe("a search hit in a PO chat", () => {
  const box = () => within(header()).getByRole("combobox", { name: "Buscar" }) as HTMLInputElement;
  const typeIn = async (value: string) => {
    await act(async () => fireEvent.change(box(), { target: { value } }));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    await settle(4);
  };
  const enter = async () => {
    await act(async () => fireEvent.keyDown(box(), { key: "Enter" }));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    await settle(4);
  };
  const results = () => screen().queryByRole("complementary", { name: "Resultados da busca" }) as HTMLElement | null;

  const scene = () => {
    // Both chats exist already: the overview gives their channels.
    const state = withPo({
      poCompanies: [
        company("s-acme", "Acme", { channelId: "po-chat-s-acme" }),
        company("s-beta", "Beta", { channelId: "po-chat-s-beta" }),
      ],
    });
    state.messages.push(say("po-chat-s-acme", "m-zebra-po", "uma zebra no chat do PO da Acme"));
    state.messages.push(say("po-chat-s-beta", "m-zebra-beta", "outra zebra no chat da Beta"));
    seedDm(state, { type: "agent", id: ADA_ID }, { body: "uma zebra na DM" });
    return state;
  };

  test("is named by the PO and the company, and its link opens that company's PO chat at the message", async () => {
    const { router } = await go(scene(), `c/${ENG_ID}`);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Remover em: #eng" })));
    await typeIn("zebra");
    await enter();
    const place = within(results() as HTMLElement).getByRole("region", { name: "DM com Ada · Acme" });
    await act(async () => fireEvent.click(within(place).getByRole("button", { name: "Ir para a mensagem de Ada" })));
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/po/s-acme`);
    expect(router.state.location.search).toMatchObject({ m: "m-zebra-po" });
    expect(screen().getByText("uma zebra no chat do PO da Acme")).toBeTruthy();
  });

  test("a plain DM's hit still opens the DM, not a PO chat", async () => {
    const { router } = await go(scene(), `c/${ENG_ID}`);
    await act(async () => fireEvent.click(screen().getByRole("button", { name: "Remover em: #eng" })));
    await typeIn("zebra");
    await enter();
    const dm = within(results() as HTMLElement).getByRole("region", { name: "DM com Ada" });
    await act(async () => fireEvent.click(within(dm).getByRole("button", { name: "Ir para a mensagem de Ada" })));
    await settle(8);
    expect(router.state.location.pathname).toBe(`/org/${ORG_ID}/dm/agent/${ADA_ID}`);
  });

  test("the PO chat's own header search stays in that chat", async () => {
    await go(scene(), "po/s-acme");
    await typeIn("zebra");
    await enter();
    const panel = results() as HTMLElement;
    expect(within(panel).getByText(/chat do PO da Acme/)).toBeTruthy();
    expect(within(panel).queryByText(/chat da Beta/)).toBeNull();
    expect(within(panel).queryByText(/na DM/)).toBeNull();
  });
});
