import { describe, expect, test } from "bun:test";
import type { CardProposalView } from "../src/api/types";
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
