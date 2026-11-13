# 0182. The Painel of a company: its tasks' numbers, read when the tab opens

- Status: Accepted
- Date: 2026-11-13
- Extends: ADR 0174 and 0180 (companies over boards over cards, Tarefas by level), ADR 0151 (who sees which task), ADR 0135 (the Painéis' cards)

## Context

A company in Tarefas groups boards and their tasks, but a person who runs several clients could not see how one is doing:
how many tasks sit in each stage, who carries them, how long a task takes, how many were delivered, what is late and what
the agents' work cost. The Painéis hold what an agent builds and refreshes by routine, which is the wrong tool for numbers
the app already has.

## Decision

### 1. A tab on the company's page

A company's page has two tabs, "Boards" (what the page showed until now) and "Painel", chosen in the address
(`?space=<id>&tab=painel`) so the path above it and Back keep working. The tabs exist only at the company level
(`levelOf`): not on a board, the companies' root, "Todas as tarefas" or "Minhas tarefas". The Painel has a period choice
of 7, 30 or 90 days, 30 at first. Nothing is stored and no routine runs: the numbers are read when the tab opens and
when the period changes.

### 2. One read, one route

`companyDashboard` (`packages/engine/src/company-dashboard.ts`) computes everything for one viewer in one pass over
the tasks of the company's boards (archived boards included), behind
`GET /organizations/{orgId}/issue-spaces/{spaceId}/dashboard?days=` (a `days` other than 7, 30 or 90 is 30; a space of
another workspace is 404). It returns the stage counts, the assignees, lead and work time, deliveries per week, late and
unassigned, the cost and `total` (every task of the company the viewer sees, canceled left out: 0 is the empty company).
A company whose tasks are all canceled, or all hidden from the viewer, has a `total` of 0 and shows the empty state.
Every number counts only the tasks the viewer may see (`taskSeenSql`, ADR 0151), so a count never leaks a task they
cannot open. Canceled tasks are in no count.

### 3. Definitions

- A task counts in the stage of its **status**, whatever its board column. Done is counted only in the period.
- **Concluded in the period**: its status is `done` now and its last move to `done` falls in the period. A status change
  and a column move write the same `status_changed` event, so both conclude a task. A done task with no such event takes
  its creation as its conclusion.
- **Lead time** runs from creation to the last conclusion. **Work time** runs from the first move to Em andamento to
  the last conclusion; a task that never was Em andamento is in the lead time only. A task reopened and concluded again
  is measured to its last conclusion. Each time is a count, a median (`percentile_cont`) and an average in milliseconds,
  null with no task.
- A task counts for the company its board is in **now**, whatever company it was in when it was concluded.
- **Weeks** run Monday to Sunday in the workspace's time zone, one entry per week the period touches with Monday's date,
  a week with no delivery kept as zero.
- **Late**: open and due before today in the workspace's time zone. **Unassigned**: open with no assignee. Neither depends
  on the period.
- An assignee that no longer exists is `removed`, with its counts: an agent that is gone, or a person who is no longer a
  member of the workspace (the task keeps the id, the name is not shown). An assignee with nothing open and nothing
  concluded in the period has no row.
- The period is `now` minus 7, 30 or 90 days to the millisecond: a conclusion or a run exactly that old counts, one
  millisecond older does not. Archived boards and archived companies are counted like any other.

### 4. The cost is a permission, not a style

`cost` is the cost of the agent runs tied to the company's tasks (`agent_runs.issue_id`, `usage_records`) that started
in the period, in USD, total and per agent. It is computed only after `view_usage` (`canViewCost`): for anyone else the
query is not run, and the route leaves the `cost` key out of the body. A run counts in the period it started in, and the
runs of a canceled task still count: the money was spent.

### 5. Drawn with the Painéis' own cards

The screen (`apps/web/src/pages/CompanyDashboard.tsx`) uses `WidgetCard` for the numbers and the weekly bars and the
same card frame for the lists that hold a face or a time, so there is no new chart code. `WidgetBody` takes a `maxBars`
(12 unless a caller says more) because 90 days touch up to 14 weeks and each keeps its bar. Times read "2d 4h", "5h"
under a day, "<1h" under an hour, "2d" with no hours left over, and "—" for none (`formatSpan`,
`packages/client/src/lib/span.ts`). Each company's Painel is its own component instance (`key`), so another company's
numbers never show while it loads.

## Consequences

- No migration: the read uses rows and indexes that exist (`issue_activity (issue_id, created_at)`,
  `agent_runs (issue_id, created_at)`). A test seeds 1,000 tasks and holds the read under one second; that bound is wall clock on in-memory PGlite, which
  proves the shape of the query, not the production time.
- Not in this change: a Painel on each board, pinning a number to the Painéis, opening the tasks behind a number,
  export, and the phone and desktop shell.
