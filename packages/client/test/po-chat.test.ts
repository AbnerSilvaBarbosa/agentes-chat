import { describe, expect, test } from "bun:test";
import type { CardProposalView } from "../src/api/types";
import { ApiError, createHttpApi } from "../src/index";
import { actionCardOf, cardProposalCardOf } from "../src/lib/action-cards";

const proposal = (patch: Partial<CardProposalView> = {}): CardProposalView => ({
  id: "p1",
  agentId: "po",
  requesterUserId: "u1",
  spaceId: "s1",
  title: "Pagar com Pix",
  summary: "Aceitar Pix no checkout.",
  criteria: ["O QR code aparece", "O pedido muda para pago"],
  project: { id: "b1", name: "Produto" },
  status: "pending",
  duplicateOf: null,
  issue: null,
  spec: null,
  ...patch,
});

describe("the card proposal as a chat card", () => {
  test("a whole proposal in meta.cardProposal is a card of its own kind, in every known state", () => {
    for (const status of ["pending", "confirmed", "dismissed"] as const) {
      const p = proposal({ status });
      expect(cardProposalCardOf({ cardProposal: p })).toEqual({ kind: "card_proposal", proposal: p });
    }
  });

  test("actionCardOf finds it among the other cards", () => {
    const p = proposal();
    expect(actionCardOf({ cardProposal: p })).toEqual({ kind: "card_proposal", proposal: p });
  });

  test("anything else is no card: no meta, no proposal, a missing id or title, an unknown status, no criteria list", () => {
    expect(cardProposalCardOf(null)).toBeNull();
    expect(cardProposalCardOf(undefined)).toBeNull();
    expect(cardProposalCardOf({})).toBeNull();
    expect(cardProposalCardOf({ cardProposal: "x" })).toBeNull();
    expect(cardProposalCardOf({ cardProposal: { ...proposal(), id: undefined } })).toBeNull();
    expect(cardProposalCardOf({ cardProposal: { ...proposal(), title: 3 } })).toBeNull();
    expect(cardProposalCardOf({ cardProposal: { ...proposal(), status: "creating" } })).toBeNull();
    expect(cardProposalCardOf({ cardProposal: { ...proposal(), criteria: undefined } })).toBeNull();
    expect(actionCardOf({ cardProposal: { ...proposal(), criteria: "a" } })).toBeNull();
  });
});

describe("the PO's reads and the proposal's decisions over http", () => {
  const org = "/api/app/organizations/o1";
  function api(responses: Record<string, { status: number; body: unknown }>) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method), body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = responses[`${init.method} ${url}`] ?? {
        status: 404,
        body: { error: { code: "not_found", message: "x" } },
      };
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    };
    return { po: createHttpApi({ fetch }).po, calls };
  }

  test("the overview is a GET of …/po and opening a chat posts the company", async () => {
    const overview = { agentId: "po", companies: [] };
    const chat = {
      channelId: "c1",
      agentId: "po",
      space: { id: "s1", name: "Acme", color: "#fff", image: null, archived: false },
    };
    const { po, calls } = api({
      [`GET ${org}/po`]: { status: 200, body: overview },
      [`POST ${org}/po/chats`]: { status: 200, body: chat },
    });
    expect(await po.overview("o1")).toEqual(overview);
    expect(await po.openChat("o1", "s1")).toEqual(chat);
    expect(calls[1]).toMatchObject({ method: "POST", body: { spaceId: "s1" } });
  });

  test("confirming sends the edited fields, dismissing sends none, both return the card", async () => {
    const done = proposal({ status: "confirmed", issue: { id: "i1", number: 7 } });
    const { po, calls } = api({
      [`POST ${org}/card-proposals/p1/confirm`]: { status: 200, body: done },
      [`POST ${org}/card-proposals/p1/dismiss`]: { status: 200, body: proposal({ status: "dismissed" }) },
    });
    expect(await po.confirmProposal("o1", "p1", { title: "Novo", criteria: ["a"] })).toEqual(done);
    expect(calls[0]?.body).toEqual({ title: "Novo", criteria: ["a"] });
    expect((await po.dismissProposal("o1", "p1")).status).toBe("dismissed");
    expect(calls[1]?.body).toEqual({});
  });

  test("a second decision is the server's 400 with its code", async () => {
    const { po } = api({
      [`POST ${org}/card-proposals/p1/confirm`]: {
        status: 400,
        body: { error: { code: "card_proposal.decided", message: "This proposal was already decided" } },
      },
    });
    const error = await po.confirmProposal("o1", "p1").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, code: "card_proposal.decided" });
  });
});
