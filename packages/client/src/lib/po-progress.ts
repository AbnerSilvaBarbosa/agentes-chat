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

/**
 * The group the panel starts closed: the board's first to-do column named Backlog, a long list that would push the cards
 * being specified below the fold. Only the group's own key says so; every other group stays open.
 */
export const isBacklog = (group: Pick<PoProgressGroup, "kind" | "stage" | "key">) =>
  group.kind === "column" && group.stage === "todo" && group.key === "backlog";

/** A card whose spec is queued or running: the cards the panel's "Gerando spec" block lists. */
export interface LiveSpec {
  card: PoProgressCard;
  state: "queued" | "running";
}

/** Every card with a spec still being written, across the groups, running ones first. */
export function liveSpecs(groups: readonly PoProgressGroup[]): LiveSpec[] {
  const live: LiveSpec[] = [];
  for (const group of groups)
    for (const card of group.items) {
      const badge = specBadge(card, group);
      if (badge?.kind === "queued" || badge?.kind === "running") live.push({ card, state: badge.kind });
    }
  return [...live.filter((l) => l.state === "running"), ...live.filter((l) => l.state === "queued")];
}

/** A group that holds a card with a live spec never collapses: what is happening in it must stay in view. */
export const hasLiveSpec = (group: PoProgressGroup) => liveSpecs([group]).length > 0;

/**
 * How long a spec has been waiting or running, on a minute clock: whole hours and the minutes left, from the spec's
 * queued time, else from when the card entered its column. Never negative (a clock a little behind reads zero).
 */
export function specElapsed(card: PoProgressCard, now: number): { hours: number; minutes: number } {
  const from = Date.parse(card.spec?.queuedAt ?? card.since);
  const total = Math.max(0, Math.floor((now - (Number.isFinite(from) ? from : now)) / 60_000));
  return { hours: Math.floor(total / 60), minutes: total % 60 };
}
