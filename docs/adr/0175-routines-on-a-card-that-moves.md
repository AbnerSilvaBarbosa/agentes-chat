# 0175. A routine on a card that moves: the board's pipeline hands work between agents

- Status: Accepted
- Date: 2026-11-13
- Extends: ADR 0053 (routines, unattended work), ADR 0171 (boards), ADR 0174 (companies over boards), ADR 0173 (an agent's approvals level)
- Code: `packages/db/src/schema/work.ts` (`routines.event_filter`, migration `0257_add-issue-moved-routines`);
  `packages/engine/src/routines.ts` (`ROUTINE_EVENTS`, `MAX_MOVE_HOPS`, `eventFilterAllows`, `fireRoutineEvent`'s
  `exceptRoutineId` and `match`), `packages/engine/src/issues.ts` (`fireIssueMoved`), `packages/engine/src/schedule-tools.ts`
  (`create_routine` and `update_routine`'s `board`, `company`, `column`, `from_column`, `moveFilterOf`);
  `packages/client/src/api/types.ts` (`RoutineEvent`); `apps/web/src/pages/RoutinesPage.tsx` (`ROUTINE_EVENTS`)

## Context

A routine could be started by an event, but the only event about a task was `issue.created` (ADR 0053 §6.5). A board's
pipeline — the reason people use boards — is not about creation: a card moves from "Especificar" to "Ready for dev" and
a developer agent picks it up, moves it to "QA", and a tester agent takes it from there. Every one of those hand-offs is
a move, and nothing could hear it.

The engines for both halves already existed: a routine with `access: act` may change tasks inside agentes.chat
(ADR 0053), and `update_issue` moves a card. What was missing was the event that ties one agent's move to the next
agent's start — and a way to say *which* move, since a workspace has dozens of boards and columns.

## Decision

### 1. `issue.moved`

Fired when a task's `status` or `column_id` actually changes, whatever moves it: a person dragging the card, an agent's
`update_issue`, a routine's run, or the system's own move when a linked pull request sends the task to review. The
payload: `issueId`, `number`, `from`, `to`, `fromColumnId`, `columnId`, `column` (its name), `projectId`, `spaceId`,
`by` (`person` or `agent`) and `depth`.

It is fired after the update is committed, from `updateIssue`, and it reaches only the routines whose creator can see
the task (ADR 0151), as `issue.created` does.

### 2. `routines.event_filter`

One `jsonb` per routine, empty by default: `projectId`, `spaceId`, `columnId`, `fromColumnId`. Each key a routine sets
must equal the event's, so a routine on "a card that lands in *Ready for dev* of *CRM*" fires on that move and on no
other. An event routine that names nothing keeps taking every event of its kind, as before.

Agents name them; the server resolves the names and refuses a guess with the ones that exist, as `projectByName` does
for boards: `board` (a board's name), `company` (a company's name, ADR 0174), `column` and `from_column` (a column's
name, or a stage name — `todo`, `in progress`, `in review`, `done`, `canceled` — which matches any column of that
stage). The web lists `issue.moved` among the events; the filter is set by the agent, and the routines page shows what
the routine hears.

### 3. No loops: three guards

A pipeline is a chain of automations that move a card, so the guards are what keeps it from becoming a ring.

- **A routine never fires itself.** A move a routine's own run made is fired with `exceptRoutineId`, and that routine
  is skipped. (The run's own brief says which routine it is: `runAuthorityById` → `brief.routineId`.)
- **A chain stops at `MAX_MOVE_HOPS` (3).** Each event carries its depth: the move that starts a chain is 1, a move
  made by a routine's run is one more than the depth of the event that started that run (read from the run's
  `routine_runs.event`). Past the cap nothing fires.
- **Nothing else changes.** The routine's budget, its run caps, its `access` and the agent's approvals level apply as
  always; a routine without `act` simply can't move the card, and says so.

## Consequences

- The pipeline people build: a card moves to "Priorizar" → the spec agent writes the spec and moves it to "Ready for
  dev" → the dev agent implements, opens the pull request (which moves the card to review on its own, ADR 0128) → a
  reviewer or a QA agent picks it up. Each step is one routine with one filter, and the agents themselves can create
  them when the person asks.
- A card moved twice to the same column far apart fires twice: there is no dedupe, because two visits to "Ajuste" are
  two pieces of work. The hop cap, and not a dedupe, is what bounds a chain.
- The chain's cost is the routines' own budgets: three hops are three runs of three agents.
- Not in this change: editing the filter from the routines page (people change the routine's instructions and the
  event; the filter is the agent's), a prompt per column, and firing on anything but status and column (a change of
  assignee or priority has no event yet).
