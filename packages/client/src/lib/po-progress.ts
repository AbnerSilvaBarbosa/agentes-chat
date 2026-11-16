import type { PoProgressCard, PoProgressGroup } from "../api/types";

/**
 * What a row of the PO chat's progress panel says about its card's spec (ADR 0185 addendum): the spec's state as the PO
 * chat's proposal keeps it. A spec that is still to be written (queued, running) or did not finish belongs to a card
 * still to be specified, so those only show in a group of the to-do stage; a finished spec shows wherever the card sits,
 * with its page when the reader may open it. No spec, no badge.
 */
export type SpecBadge =
  | { kind: "queued" }
  | { kind: "running" }
  | { kind: "ready"; page: { slug: string; title: string } | null }
  | { kind: "failed"; reason: string | null };

export function specBadge(card: Pick<PoProgressCard, "spec">, group: Pick<PoProgressGroup, "stage">): SpecBadge | null {
  const spec = card.spec;
  if (!spec) return null;
  if (spec.state === "done") return { kind: "ready", page: spec.page };
  if (group.stage !== "todo") return null;
  if (spec.state === "queued") return { kind: "queued" };
  if (spec.state === "running") return { kind: "running" };
  return { kind: "failed", reason: spec.error };
}

/** The fixed codes a spec's failure carries, each with its `poCard.specReason.*` words. */
const SPEC_REASONS = {
  po_missing: "poCard.specReason.po_missing",
  card_gone: "poCard.specReason.card_gone",
  no_spec_page: "poCard.specReason.no_spec_page",
  run_missing: "poCard.specReason.run_missing",
  stopped: "poCard.specReason.stopped",
  failed: "poCard.specReason.failed",
} as const;

export type SpecReasonKey = (typeof SPEC_REASONS)[keyof typeof SPEC_REASONS];

/**
 * The words key of a spec failure's reason: a known code has its own sentence, a stop with no reason reads "stopped",
 * any other text reads as a plain failure: free text is never shown, the card's viewers are not the one who asked.
 */
export function specReasonKey(reason: string | null): SpecReasonKey {
  if (!reason) return SPEC_REASONS.stopped;
  return Object.hasOwn(SPEC_REASONS, reason) ? SPEC_REASONS[reason as keyof typeof SPEC_REASONS] : SPEC_REASONS.failed;
}

/** The `columns` the task list is asked for to see a whole group: its keys joined by a bar (`?columns=a|b`). */
export const columnsParam = (group: Pick<PoProgressGroup, "columns">) => group.columns.join("|");
