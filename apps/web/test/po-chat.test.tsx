import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { type CardProposalView, keys, type Message, type PoCompany } from "@agenteschat/client";
import { act, cleanup } from "@testing-library/react";
import { ADA_ID, createFakeApi, type FakeState, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

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
