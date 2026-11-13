/**
 * `#128` in chat (web): a card named by its number (ADR 0183). Where the numbers are in a text, and what the "#"
 * picker offers beside the channels. A number is a workspace's own (`issues.number`), so the renderer asks for the
 * card by it; one that is no card the reader may see stays the text as written.
 */

/** A piece of text: words, or a `#<number>` that may name a card. */
export type CardRefPart = { text: string; number?: undefined } | { text: string; number: number };

/**
 * `#<number>` after a space or punctuation, never `a#12`, `&#39;`, `##12` or `#12-plan` (a channel's name). No leading
 * zero, and at most nine digits.
 */
const CARD_REF = /(^|[^\w#&/])#([1-9][0-9]{0,8})(?![\w-])/g;

/** The words right before a number that make it GitHub's: `PR #123`, `pull request #123`, `issue #123`. */
const GITHUB_WORD = /(?:^|[^\w])(?:PR|pull request|issue)\s$/i;

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
