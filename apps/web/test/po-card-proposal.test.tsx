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
  unread: 0,
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
  const app = await renderApp(`/org/${ORG_ID}/po/s-acme`, { api });
  await settle(8);
  return Object.assign(state, { app });
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
    // The worst case the limits allow, also what the geometry check lays out at 1280 and 390 (`capture.ts` saves
    // both states: the card and its edit form): a 300-character title, thirty 500-character criteria, a 20,000-character
    // summary ending in an unbroken address.
    const long = `${"Reestruturação completa do atendimento ao cliente da clínica com triagem e retorno ".repeat(4)}`
      .trim()
      .slice(0, 300);
    const criteria = Array.from({ length: 30 }, (_, i) =>
      `Critério ${i + 1} ${"muito longo ".repeat(45)}`.slice(0, 500),
    );
    const unbroken = `https://exemplo.com.br/${"caminho-sem-quebra-".repeat(40)}fim`;
    const summary = `${"Resumo longo do card. ".repeat(900)}${unbroken}`.slice(-20_000);
    await scene({ title: long, criteria, summary });
    const card = row();
    expect(card.textContent).toContain(long);
    expect(card.textContent).toContain(unbroken.slice(-60));
    expect(card.querySelectorAll(".po-card__criteria li")).toHaveLength(30);
    expect(card.closest(".rq-open")).toBe(card);
    await click(button("Editar"));
    expect(row().querySelectorAll("input, textarea").length).toBeGreaterThanOrEqual(32);
  });
});

describe("the spec's state on a confirmed card", () => {
  const confirmed = (spec: CardProposalView["spec"]) =>
    proposal({ status: "confirmed", issue: { id: "i1", number: 7 }, spec });
  const page = { slug: "specs/acme/pagar-com-pix", title: "Pagar com Pix" };

  test("queued says it is in progress and waiting, running says in progress", async () => {
    await scene(confirmed({ state: "queued", page: null, error: null }));
    expect(row().textContent).toContain("Spec em andamento, na fila");
    cleanup();
    await scene(confirmed({ state: "running", page: null, error: null }));
    expect(row().textContent).toContain("Spec em andamento");
    expect(row().textContent).not.toContain("na fila");
  });

  test("done says ready and Ver spec opens the wiki page of the spec", async () => {
    const { app } = await scene(confirmed({ state: "done", page, error: null }));
    expect(row().textContent).toContain("Spec pronta");
    await click(button("Ver spec"));
    expect(app.router.state.location.pathname).toBe(`/org/${ORG_ID}/wiki/specs%2Facme%2Fpagar-com-pix`);
  });

  test("a failed or stopped spec says why, and offers no page", async () => {
    await scene(confirmed({ state: "failed", page: null, error: "no_spec_page" }));
    expect(row().textContent).toContain("Spec não concluída: a execução terminou sem salvar a spec na wiki");
    expect(within(row()).queryByRole("button", { name: "Ver spec" })).toBeNull();
    cleanup();
    await scene(confirmed({ state: "stopped", page: null, error: "stopped" }));
    expect(row().textContent).toContain("Spec não concluída: foi interrompida");
    cleanup();
    await scene(confirmed({ state: "failed", page: null, error: "Rate limit reached" }));
    expect(row().textContent).toContain("Spec não concluída: Rate limit reached");
  });

  test("the line follows card.proposal.updated without a reload", async () => {
    const { app } = await scene(confirmed({ state: "running", page: null, error: null }));
    expect(row().textContent).toContain("Spec em andamento");
    await act(async () =>
      app.sockets.last().push({
        type: "event",
        channelId: CHANNEL,
        event: {
          type: "card.proposal.updated",
          channelId: CHANNEL,
          threadId: null,
          messageId: "m-card",
          proposal: confirmed({ state: "done", page, error: null }),
        },
      }),
    );
    await settle(4);
    expect(row().textContent).toContain("Spec pronta");
    expect(button("Ver spec")).toBeTruthy();
  });
});

describe("the card's page", () => {
  const withSpec = async (specPage: { id: string; slug: string; title: string | null } | null) => {
    const state = seedState();
    const api = createFakeApi(state);
    const [first] = await api.issues.list(ORG_ID, {});
    if (!first) throw new Error("no card");
    // A short title: the page's own title wrapping at 320 is another screen's concern.
    await api.issues.update(ORG_ID, first.id, { title: "Pix", specPage } as never);
    await renderApp(`/org/${ORG_ID}/issues/${first.number}`, { api });
    await settle(8);
  };

  test("links the spec's wiki page when specPage is set", async () => {
    await withSpec({ id: "w1", slug: "specs/acme/pagar-com-pix", title: "Pagar com Pix" });
    const link = screen().getByRole("link", { name: /Spec: Pagar com Pix/ });
    expect(link.getAttribute("href")).toContain("/wiki/specs%2Facme%2Fpagar-com-pix");
  });

  test("a restricted page is still linked, by its bare name", async () => {
    await withSpec({ id: "w1", slug: "specs/acme/x", title: null });
    expect(screen().getByRole("link", { name: "Spec" }).getAttribute("href")).toContain("/wiki/specs%2Facme%2Fx");
  });

  test("shows no such link when there is no specPage", async () => {
    await withSpec(null);
    expect(screen().queryByRole("link", { name: /^Spec/ })).toBeNull();
  });
});
