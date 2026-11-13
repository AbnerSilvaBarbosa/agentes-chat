# 0183. Card mentions: `#128` in chat is the card

- Status: Accepted
- Date: 2026-11-13
- Extends: ADR 0151 (who sees what), ADR 0174 (Tarefas)

## Context

An agent that says it works on card 128 wrote plain text: nobody could open the card from the message, and a person
could not write a card's number and have it mean the card. Channels already work that way with `#name` (a list in the
composer, a link in the message); cards had no equivalent.

## Decision

### 1. The format

A card is named by `#` and its number, digits only (`#128`). The channel rule is untouched: `CHANNEL_REF` needs a
letter, so a number never meant a channel. The finder is `splitCardRefs` (`packages/client/src/lib/card-refs.ts`):
`#<number>` after a space or punctuation, never `a#12`, `&#39;`, `##12` or `#12-plan`, no leading zero.

`#123` after the words "PR", "pull request" or "issue" (any case, one space) stays text, because that is GitHub's
number and not a card's. Inside a code span or a code block it stays text too. Nothing is stored on the message: the
number is read when the message is drawn.

### 2. The chip

`CardRef` (`apps/web/src/chat/CardRef.tsx`), passed to `Markdown` as `card` by `MessageBody`, is applied after the
`#channel` references and the internal ids, in every message from people and from agents, in channels, direct messages
and threads. It asks for the card by its number in the workspace (`useIssue`, `issues.number` is per workspace) and
draws "#128 title · status" as the task pill does, opening the card (in place inside a conversation). The query is the
one the card's page keeps, so a change of title or status shows without a reload. A long title wraps inside the chip.

### 3. Who sees what

The server answers 404 for a card the reader may not see (`taskSeenSql`, ADR 0151) and for one that does not exist or
is gone. The number then stays the text as written, with no title: a reader learns nothing of a card they cannot open.
A card of an archived board still gets its chip.

### 4. The picker

Typing `#` in the composer lists channels and cards in one list, channels first, at most eight rows (`pickOptions`: two
rows are kept for cards when channels are many). Digits give the cards whose number starts with them, letters the
channels whose name holds them and the cards whose title holds them. The cards come from the issues list the app has
already loaded (the 200 most recent) and, once something is typed after `#`, from the server too (`useIssues` with
that query, which matches a number or a title, told by the composer's `onQuery`), merged without repeats, so an older
card is found. Both lists are filtered by the server to what the member may see. Picking a card writes `#<number> `.

### 5. Agents

Every agent's instructions say that `#<number>` names a card in chat and shows as a link to it, to use it when naming
the card it works on, and not to write it after "PR" or "issue" for a GitHub number (`context.ts`).

## Consequences

- No migration and no new server route.
- A number that is no card (a step, a count written with `#`) asks the server once per workspace and stays text.
- Each key typed after `#` asks the server for the cards that match, and the loaded list answers meanwhile.
- Mentions inside a card's own description and comments, notifying the assignee, and the phone and desktop shell are
  left for later decisions.
