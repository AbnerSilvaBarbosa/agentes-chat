import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { ApiError, type CardProposalView, type Message, type PoCompany } from "@agenteschat/client";
import { act, cleanup, fireEvent, within } from "@testing-library/react";
import { ADA_ID, createFakeApi, ORG_ID, seedState } from "./fake-api";
import { renderApp, screen, settle } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

/** The PO's card proposal in its chat (ADR 0185): the card the person confirms, edits or drops. */

const CHANNEL = "po-chat-s-acme";
const company: PoCompany = {
  id: "s-acme",
  name: "Acme",
  color: "#3366ff",
  image: null,
  archived: false,
  open: 0,
  channelId: null,
};

const proposal = (patch: Partial<CardProposalView> = {}): CardProposalView => ({
  id: "p1",
  agentId: ADA_ID,
  requesterUserId: "",
  spaceId: "s-acme",
  title: "Pagar com Pix",
  summary: "O cliente paga o pedido com Pix.",
  criteria: ["O QR code aparece", "O pedido confirma sozinho"],
  project: { id: "b-prod", name: "Produto" },
  status: "pending",
  duplicateOf: null,
  issue: null,
  spec: null,
  ...patch,
});

async function scene(patch: Partial<CardProposalView> = {}, tweak?: (api: ReturnType<typeof createFakeApi>) => void) {
  const state = seedState({ poAgentId: ADA_ID, poCompanies: [company] });
  const card = proposal({ requesterUserId: state.me?.user.id ?? "", ...patch });
  state.cardProposals = { [card.id]: card };
  const message: Message = {
    id: "m-card",
    channelId: CHANNEL,
    threadId: null,
    author: { type: "agent", id: ADA_ID },
    body: `Proposta de card: ${card.title}`,
    mentionedAgentIds: [],
    agentRunId: null,
    meta: { bodyCode: "card_proposal", bodyParams: { title: card.title }, cardProposal: card },
    createdAt: new Date().toISOString(),
  };
  state.messages.push(message);
  const api = createFakeApi(state);
  tweak?.(api);
  for (const [name, id] of [
    ["Produto", "b-prod"],
    ["Plataforma", "b-plat"],
  ] as const) {
    const board = await api.issues.createProject(ORG_ID, { name, spaceId: "s-acme" });
    // Ids are random: the card names the board by the one made here.
    if (id === "b-prod") card.project = { id: board.id, name };
  }
  await renderApp(`/org/${ORG_ID}/po/s-acme`, { api });
  await settle(8);
  return state;
}

const row = () => document.querySelector(".rq-open, .rq-done") as HTMLElement;
const click = async (el: HTMLElement) => {
  await act(async () => fireEvent.click(el));
  await settle(6);
};
const button = (name: string) => within(row()).getByRole("button", { name });

describe("a pending proposal", () => {
  test("shows title, summary, criteria and board, with Criar, Editar and Descartar for who it was written for", async () => {
    await scene();
    expect(row().textContent).toContain("Pagar com Pix");
    expect(row().textContent).toContain("O cliente paga o pedido com Pix.");
    const items = [...row().querySelectorAll(".po-card__criteria li")].map((li) => li.textContent);
    expect(items).toEqual(["O QR code aparece", "O pedido confirma sozinho"]);
    expect(row().textContent).toContain("Board: Produto");
    for (const name of ["Criar", "Editar", "Descartar"]) expect(button(name)).toBeTruthy();
  });

  test("someone else reads who decides and gets no buttons", async () => {
    await scene({ requesterUserId: "u-other" });
    expect(within(row()).queryByRole("button", { name: "Criar" })).toBeNull();
    expect(within(row()).queryByRole("button", { name: "Editar" })).toBeNull();
    expect(row().textContent).toContain("decide se o card é criado");
  });

  test("a title that repeats an open card's says so and links that card", async () => {
    await scene({ duplicateOf: { number: 12, title: "Pagar com Pix" } });
    expect(row().textContent).toContain("Já existe o card #12 com este título");
    const link = within(row()).getByRole("link", { name: "#12" });
    expect(link.getAttribute("href")).toContain("/issues/12");
  });
});

describe("Criar and Descartar", () => {
  test("Criar creates the card as proposed and the line says so with its number as a link", async () => {
    const state = await scene();
    await click(button("Criar"));
    const call = state.calls.find((c) => c.method === "po.confirmProposal");
    expect(call?.args[1]).toBe("p1");
    expect(call?.args[2]).toBeUndefined();
    expect(row().textContent).toContain("card criado");
    expect(within(row()).getByRole("link", { name: "#1" }).getAttribute("href")).toContain("/issues/1");
    expect(within(row()).queryByRole("button", { name: "Criar" })).toBeNull();
  });

  test("Descartar drops it and the line says so", async () => {
    const state = await scene();
    await click(button("Descartar"));
    expect(state.calls.some((c) => c.method === "po.dismissProposal")).toBe(true);
    expect(row().textContent).toContain("descartado");
    expect(row().textContent).not.toContain("card criado");
  });

  test("a refusal shows under the buttons and the proposal stays", async () => {
    await scene({}, (api) => {
      api.po.confirmProposal = async () => {
        throw new ApiError(400, "issue_project.archived", "That board is archived");
      };
    });
    await click(button("Criar"));
    expect(within(row()).getByRole("alert")).toBeTruthy();
    expect(button("Criar")).toBeTruthy();
    expect(row().textContent).not.toContain("card criado");
  });
});

describe("Editar", () => {
  test("turns the fields into inputs and Criar sends what was edited: title, summary, criteria added and removed, board", async () => {
    const state = await scene();
    await click(button("Editar"));
    const title = within(row()).getByLabelText("Título") as HTMLInputElement;
    const summary = within(row()).getByLabelText("Resumo") as HTMLTextAreaElement;
    expect(title.value).toBe("Pagar com Pix");
    await act(async () => fireEvent.change(title, { target: { value: "Pagar com Pix ou cartão" } }));
    await act(async () => fireEvent.change(summary, { target: { value: "Resumo novo" } }));
    // remove the first criterion, add one
    await click(within(row()).getAllByRole("button", { name: "Tirar o critério" })[0] as HTMLElement);
    const add = within(row()).getByPlaceholderText("Adicionar critério");
    await act(async () => fireEvent.change(add, { target: { value: "O recibo chega por e-mail" } }));
    await act(async () => fireEvent.keyDown(add, { key: "Enter" }));
    // the board
    const box = within(row()).getByRole("combobox", { name: "Board" });
    box.focus();
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    await act(async () => fireEvent.click(screen().getByRole("option", { name: "Plataforma" })));
    await settle(4);
    await click(button("Criar"));
    const edits = state.calls.find((c) => c.method === "po.confirmProposal")?.args[2] as Record<string, unknown>;
    expect(edits).toMatchObject({
      title: "Pagar com Pix ou cartão",
      summary: "Resumo novo",
      criteria: ["O pedido confirma sozinho", "O recibo chega por e-mail"],
    });
    expect(typeof edits.projectId).toBe("string");
    expect(edits.projectId).not.toBe("b-prod");
    expect(row().textContent).toContain("Pagar com Pix ou cartão");
    expect(row().textContent).toContain("card criado");
  });

  test("offers only the company's live boards", async () => {
    await scene();
    await click(button("Editar"));
    const box = within(row()).getByRole("combobox", { name: "Board" });
    box.focus();
    await act(async () => fireEvent.keyDown(box, { key: "Enter" }));
    const options = screen()
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options.sort()).toEqual(["Plataforma", "Produto"]);
  });
});

describe("worst case data", () => {
  test("a long title and thirty criteria stay inside the card, whole", async () => {
    const long =
      "Reestruturação completa do atendimento ao cliente da clínica com triagem e retorno automático ".repeat(3);
    const criteria = Array.from({ length: 30 }, (_, i) => `Critério ${i + 1} ${"muito longo ".repeat(6)}`.trim());
    await scene({ title: long.trim(), criteria });
    const card = row();
    expect(card.textContent).toContain(long.trim());
    expect(card.querySelectorAll(".po-card__criteria li")).toHaveLength(30);
    expect(card.closest(".rq-open")).toBe(card);
  });
});
