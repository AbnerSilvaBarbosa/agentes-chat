/**
 * `#128` in chat (web): a card named by its number (ADR 0227). Where the numbers are in a text, and what the "#"
 * picker offers beside the channels. A number is a workspace's own (`issues.number`), so the renderer asks for the
 * card by it; one that is no card the reader may see stays the text as written.
 */

import { CHANNEL_PICK_LIMIT, channelOptions } from "./channel-refs";

/** A piece of text: words, or a `#<number>` that may name a card. */
export type CardRefPart = { text: string; number?: undefined } | { text: string; number: number };

/**
 * `#<number>` after a space or punctuation, never `a#12`, `&#39;`, `##12`, a URL's `?a=#12` or `/p#12`, `#12-plan` (a
 * channel's name) or `#12é`. No leading zero, and at most nine digits.
 */
const CARD_REF = /(^|[^\w#&/=?])#([1-9][0-9]{0,8})(?![\w-]|\p{L})/gu;

/**
 * The words right before a number that make it GitHub's: `PR #123`, `PRs: #123`, `pull request (#123)`,
 * `pull-requests #123`, `issue #123`, with any whitespace between (`PR#123` is a word character before the mark).
 */
const GITHUB_WORD = /(?:^|[^\w])(?:PRs?|pull[\s-]requests?|issues?)[\s:(]*$/i;

/** A text split around the card numbers it holds ("veja #128." → "veja ", "#128" (128), "."). */
export function splitCardRefs(text: string): CardRefPart[] {
  const out: CardRefPart[] = [];
  let last = 0;
  for (const m of text.matchAll(CARD_REF)) {
    const start = (m.index ?? 0) + (m[1]?.length ?? 0);
    const digits = m[2] ?? "";
    if (GITHUB_WORD.test(text.slice(0, start))) continue;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: `#${digits}`, number: Number(digits) });
    last = start + 1 + digits.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

/** What the "#" picker needs to know of a card. */
export interface PickCard {
  number: number;
  title: string;
}

/** Rows kept for cards while channels are many, so a card is never out of reach of "#". */
const CARD_ROOM = 2;

/**
 * What "#<query>" can mean: the channels first (`channelOptions`), then the cards: digits give the cards whose number
 * starts with them, letters the cards whose title holds them (the ones it starts with first). At most `limit` rows.
 * `cards` come in the order to show when nothing was typed.
 */
export function pickOptions<C extends { name: string; isMember: boolean }, K extends PickCard>(
  query: string,
  channels: readonly C[],
  cards: readonly K[],
  limit = CHANNEL_PICK_LIMIT,
): { channels: C[]; cards: K[] } {
  const q = query.toLowerCase();
  const found = /^\d+$/.test(q)
    ? cards.filter((c) => String(c.number).startsWith(q)).sort((a, b) => a.number - b.number)
    : q
      ? cards
          .filter((c) => c.title.toLowerCase().includes(q))
          .sort((a, b) => Number(!a.title.toLowerCase().startsWith(q)) - Number(!b.title.toLowerCase().startsWith(q)))
      : [...cards];
  const named = channelOptions(query, channels, limit - Math.min(found.length, CARD_ROOM));
  return { channels: named, cards: found.slice(0, limit - named.length) };
}
