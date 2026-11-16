# 0185. The PO chat: one conversation per company with the workspace's PO

- Status: Accepted
- Date: 2026-11-15
- Extends: ADR 0174 and 0179 (companies and boards), ADR 0151 (who sees which task), ADR 0023 (the wiki), ADR 0053 (unattended runs), ADR 0184 (the factory on Início)

## Context

A person who wants a card for a company talked to an agent in a plain DM: the agent could create the card with no
yes, knew every company at once, and left no place to read what was asked about one company. The product wants a
product owner (PO) agent that a person talks to about one company, that proposes cards a person confirms, and that
writes each confirmed card's spec in the wiki, with several specs at once and none of them moving a card toward
development by itself.

## Decision

### 1. The key and the sidebar rule

A PO chat is a DM (`channels.kind = 'dm'`) whose `dm_key` has a third segment, the company: `a:<po>|s:<company>|u:<person>`
(`poChatKey`, `parsePoChatKey` in `packages/engine/src/po-chat.ts`). `dm_key` is unique per organization, so there is
one conversation per person, PO and company with no new table or column. The company id is the only fact read from the
key. Every other reader of `dm_key` (membership, search, the wiki's `dmOther`, agent deletion, the `u:` and `a:` tests)
survives the extra segment, and a chat is archived with its PO.

The sidebar keys its direct messages by agent, so two chats with one agent would overwrite each other's row. `listDms`
leaves out the keys with `|s:` (`poChatKeyLike`); a PO chat is opened from the company (its page, the Início panel, the
switcher in the chat's header, search and notifications), never from the sidebar. A notice from a PO chat carries the
company (`NotificationSource.poSpaceId`) so it opens that chat, not the agent's plain DM.

### 2. The PO setting

`organization_settings.po_agent_id` (null: no PO) names the workspace's PO, picked by who may configure in
Configurações › Tarefas and readable by every member. `poAgentOf` returns the agent or null when it is unset, archived
or deleted, and every rule asks it. No role text is trusted. With no PO nothing is offered and `openPoChat` refuses.

### 3. What a PO chat holds

`context.ts` adds a per-turn block for a PO chat (`po-chat-context.ts`): the company, its boards and columns, the cards
the person sees (ADR 0151) with the link to each spec, a proposal still waiting, and the rules. The tools are scoped by
the chat's key (`poScopeOf`) and change nothing elsewhere: `list_issues`, `list_boards`, the card lookup and the company
by name stay inside the company. `create_issue` is not listed in a PO chat and its `execute` refuses too, because a
computer brain lists tools once. A PO chat proposes with `propose_card` (scope `issues:write`, in the run-policy's
`ELSEWHERE` and `ASKS_ITSELF` as `propose_event`: a routine or an unattended run never proposes, and an agent set to
always ask adds no approval before a card that is itself the question).

### 4. The proposal and its claim

A proposal is a row of `po_card_proposals` and a card in the conversation (`meta.cardProposal`, a snapshot rewritten by
`syncProposalCard`, event `card.proposal.updated`). Only the person it was proposed to decides: Criar (with the edits
they made to title, summary, criteria and board) or Descartar. Deciding is one conditional `update` that moves
`pending` to `creating` and returns the row, so two clicks create one card and the second answers `card_proposal.decided`
(400). A `creating` row older than 2 minutes can be claimed again, which recovers a crash between the claim and the
card. The card is made with `createIssue` as the person (their right to `post`, a live board of the company) in the
board's "Especificar" column; a refusal puts the claim back so the person can pick another board. The proposal notes an
open card with the same title (`duplicateOf`) but never blocks on it.

### 5. The spec run and its queue

A confirmed proposal is `spec_state = 'queued'`. `pumpSpecs` starts queued specs of a company, oldest first, up to 3
running at once (`SPEC_RUNS_PER_COMPANY`), counting and starting under an advisory lock per company (no Redis, ADR 0005).
`startSpecRun` writes a start message by the confirming person in the card's own conversation ("Escreva a spec do card
#N e salve na wiki") and runs the PO there with the brief of `po-spec-brief.ts`. That message is the request the wiki
write needs, and the page is written with that person's rights. The card is never assigned to the PO, so the assignee's
first tool call moves nothing, and no code path names "Ready for dev".

The PO saves the page with `create_wiki_page` in the folder `Specs/<company>` and calls `attach_spec` (listed only in a
spec run), which links the page (`issues.spec_page_id`, a foreign key that survives a rename) and writes the criteria
into the description and the card's checklist. `settleSpecRun` is called from the one hook every run ending already
passes (`onConsultedRunFinished`, also stop and recovery): a run that ends done with a page moves the card to
"Priorizado" only while it is still in "Especificar", comments the link and tells the PO chat; any other ending leaves
the card where it is with the reason. Either way the next queued spec starts. A `specs` tick every minute settles runs
that ended unheard and starts held specs. A spec run that waits on a person or an approval holds no slot (only working runs count toward the three, so three
questions never starve the queue), and the brief still forbids questions; a timeout is left for later.

### 6. The wiki scope by folder

The wiki has no company field (ADR 0023). In a PO chat the company's wiki is the folder `Specs/<company>`: search and
read drop and refuse pages in another company's `Specs/` folder, create defaults to the company's folder, and create,
update, move and link refuse another company's. Pages outside `Specs/` stay workspace knowledge.

### 7. Entries

"Conversar com o PO" on a live company's page in Tarefas and on its panel in the factory on Início (ADR 0184), only when
the workspace has a PO; the route `/org/$orgId/po/$spaceId` (the DM page with a company, a switcher among the companies
in its header); search hits and notifications open the chat of their company; the card's page shows its spec.

### 8. Deploy data step (not code, each needs its own go-ahead)

1. Set the workspace's PO to Paula in Configurações › Tarefas.
2. Pause or edit the Paula routine on `issue.moved` that moves a card from "Priorizado" to "Ready for dev", so a
   Priorizado card stays there until a person releases it (that routine fires on any move, whoever made it).
3. Give the boards the PO uses "Especificar" and "Priorizado" columns. A board without them works through the fallbacks:
   the first column of the `todo` stage, then the next `todo` column, or none (the card stays and the comment says so).

## Consequences

- One migration (`0262_po-chat`): `organization_settings.po_agent_id`, `issues.spec_page_id`, `po_card_proposals`.
  Additive.
- A PO chat is a person's DM everywhere the engine counts DMs, and its history stays readable by search when the
  workspace changes its PO; only the current PO's chats open.
- A proposal edited in Editar is not checked for a duplicate again.
- Existing cards get no spec: `attach_spec` exists only in a spec run.
- The phone and desktop shells, a timeout for a spec run that waits, and a company field on wiki pages are left for
  later decisions.

## Addendum: where a spec lives and what it holds

A card's spec is three wiki pages, the form the company's wiki already uses, saved in `<company>/Specs/<number>`:
`<number> · Spec — <title>` (the EARS spec, opened by a line linking the three), `<number> · Design — <title>` and
`<number> · Tarefas — <title>`. `attach_spec` links the Spec page to the card. The first form, `Specs/<company>`, is
still read as a company's folder by the PO chat's scope, so pages already there stay hidden from other companies.
The proposal card shows its summary, criteria and board above its buttons, and the PO's summary is two or three
sentences, with the detail in the criteria.

## Addendum: the progress panel

A company's PO chat has, at its right, a panel with the company's open cards by stage, so nobody has to ask the PO where
a card stands. It replaces the agent's own sidebar in that chat (the PO's page still opens from its name): a column on a
wide window, open at first and remembered per person, and on a narrow one a sheet over the chat that the header's
button opens.

- **The read.** `poProgress` in `packages/engine/src/po-progress.ts`, behind
  `GET /api/app/organizations/{orgId}/po/companies/{spaceId}/progress`. Nothing is stored. The cards are the ones the
  reader sees (ADR 0151); canceled cards and the cards of archived boards are in no number; done cards are one count,
  never rows. The groups follow the columns of the company's boards (`boardColumnsOf`) in board order: each open
  column up to "Ready for dev" is a group (a board without that column: its to-do columns), the same name on several
  boards is one group (`columnKey`), and every later open column is one tail group, "Em andamento até Concluído". A
  group lists 8 cards, longest in the column first (`issues.column_since`), and counts all of them. Each card carries
  its board, its spec state and reason (`po_card_proposals.spec_*`) and its spec page when the reader may open it.
- **No new event.** A card changing column is `updateIssue`'s `issue.updated`, announced to whoever sees the task, which
  the app already hears and which reads the issues query keys again once per burst (at most about two seconds). A
  spec being queued, started, finished or failed is `card.proposal.updated` on the PO chat's channel, open whenever the
  panel is, and reads the panel at once (`applyPoProposalEvent`). The panel never polls.
- **"Ver todos".** The task list takes `?columns=a|b` (the groups' `columnKey`s, with `?space=`): a name in lower case, or
  `stage:<stage>` for a column with no name. `listIssues` filters by the effective column of each task in one
  statement (`columnKeys`), and Tarefas shows the company's tasks in those columns with a chip that clears only the
  filter.
- **Out of scope.** The phone and the desktop shell, dragging a card in the panel, and cards of other companies.

## Addendum: the sidebar opens the PO

Section 1 said a PO chat is opened from the company, never from the sidebar. That changes: the person reached the PO
through Início and its button, while the PO agent's own row opened a plain DM with no company and no progress panel.

- The sidebar's tools show Início and, right under it, PO (while the workspace has a PO, `poAgentOf`), in team and
  personal workspaces alike. PO links to `/org/$orgId/po`.
- That route (`apps/web/src/routes/org.$orgId.po.index.tsx`) replaces itself with `/po/$spaceId` of the company the
  person opened last, else the first live one (`poLanding` in `apps/web/src/lib/po-landing.ts`). With no PO or no
  company it shows the page's empty state. The company route keeps the company it opens as the next one, per person
  and workspace, in the browser: a convenience, never state that has to survive.
- The PO agent's row opens the same route, and the address of a plain DM with the PO agent replaces itself with it:
  the PO has no company-less conversation. Messages already in such a DM stay stored and searchable; every other
  agent keeps its DM. The redirect keeps no `?m=`: the message belongs to the old conversation. A PO that is archived or no longer the workspace's PO is an ordinary agent again.
- `listDms` still leaves out the company chats (section 1): the agent's row is the one entry, not one row per company.

The phone and desktop shells are left for a later decision.
