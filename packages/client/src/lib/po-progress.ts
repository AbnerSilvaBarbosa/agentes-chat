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

/** The fixed codes a spec's failure carries, as `poCard.specReason.*` words. */
const SPEC_REASONS = new Set(["po_missing", "card_gone", "no_spec_page", "run_missing", "stopped", "failed"]);

/**
 * The words key of a spec failure's reason: a known code has its own sentence, a stop with no reason reads "stopped",
 * any other text is the run's own and has no key (null: show it as written).
 */
export function specReasonKey(reason: string | null): string | null {
  if (!reason) return "poCard.specReason.stopped";
  return SPEC_REASONS.has(reason) ? `poCard.specReason.${reason}` : null;
}

/** The `columns` the task list is asked for to see a whole group: its keys joined by a bar (`?columns=a|b`). */
export const columnsParam = (group: Pick<PoProgressGroup, "columns">) => group.columns.join("|");
