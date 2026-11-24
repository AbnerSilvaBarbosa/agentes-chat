# 0228. The factory on Início: a column that waits for a person, and a panel per company

- Status: Accepted
- Date: 2026-11-14
- Extends: ADR 0108 (Início), ADR 0219, 0221 and 0179 (companies, a board's own columns, status sets), ADR 0226 (the company Painel), ADR 0151 (who sees which task)

## Context

A person who runs several clients through agents opens each board of each company to find the tasks that wait for them:
the step a person does ("Teste humano": try the work, release it or send it back) is only a column on a board. Início
shows the inbox and what agents do, and the company Painel shows one company, so nothing answered "how is each company
doing, and what waits for me" in one look.

## Decision

### 1. A flag on the column, not its name

`issue_columns.waits_for_person` (default false) marks a column whose tasks wait for a person. A name changes from one
client to the next; a flag survives renames, moves and stage changes (no gesture rewrites the row) and works for any flow.
The board's columns dialog and the status-set editor show an "Espera uma pessoa" switch on each column.

A board that still follows the workspace's set has no row of its own to flag. `setColumnWaits` gives it its own copy
first, as any column edit of a board should, and re-points the board's tasks to the copy of the column each was in; the
workspace's own columns stay as they were. It is checked with `requirePoster`, the right every column write already
asks. Status sets carry the flag per column (`templateColumns` keeps `waitsForPerson: true` and drops anything else), so a
board made from a set gets the flags, a board saved as a set copies them, and the seeded sets stay unflagged.

### 2. How long a task has waited: `issues.column_since`

`issues.column_since` is the time a task entered the column it sits in. A trigger (`issues_column_since`, migration
0261) sets it to `now()` when `status`, `column_id` or `project_id` changes, so no writer can forget it, the running
version of the app keeps it right during a deploy or after a rollback (it never names the column), and new rows fill it
by the default. The migration backfills it from the task's last `status_changed` event, else its creation.

Neither an event nor `updated_at` can answer this. Only a change of status writes an event: moving a task between two
columns of the same stage writes none. `updated_at` moves on every edit, a comment or a priority included. A transaction
may set `agentes.keep_column_since` to `on` to keep the clock (`setColumnWaits` does when it re-points a task to its
board's copy of the same column). A task that changes board restarts it, since it lands in that board's first column of
its stage.

### 3. What "waits for a person" and "live" mean

The column a task sits in is the one `columnOf` gives, in SQL (`effectiveColumnSql`): its own column when it is in the
board's set and in the task's stage, else the first column of its stage in the board's set (the workspace's when the
board has none). A task **waits for a person** when it is open (to do, in progress or in review), that column is flagged,
and whoever it is assigned to. A task is **live** when it is not canceled, its board and its company are not archived,
and the viewer sees it (`taskSeenSql`, ADR 0151). A company has a panel when it holds a live task.

### 4. One read, one route

`factoryHome` (`packages/engine/src/factory-home.ts`) returns, for one viewer, up to 20 panels (waiting first, then by
name), the count of companies, and the waiting tasks: the total and the first five, longest first. It is served by
`GET /organizations/{orgId}/factory-home`. Every number counts only tasks the viewer may see. Nothing is stored or
computed on a schedule: the block reads when Início opens and again on the `issue.*` events already wired to the issues'
query keys. A workspace that flagged no column skips the per-task column read.

### 5. The difference to the Painel's counts

Stages, "done" and "late" are the Painel's definitions (`OPEN`, `CONCLUDED`, `workspaceTimezone`, shared, not copied),
with "done" over the last 7 days. The one difference: the Painel counts the tasks of archived boards (ADR 0226 §3) and the
factory leaves archived boards and companies out, since they hold no live work. For a company with no archived board the
two agree.

### 6. "Ver tudo": `waiting=person`

`GET …/issues?waiting=person` (a literal, like `assignee=me`) lists only the tasks that wait for a person, with the same
SQL and the same live rule as the factory, applied before the list's cap so the list equals what the block counts.
Tarefas reads `?waiting=person` beside `?all=1`: it stays the level of "Todas as tarefas", with its toolbar, and shows a
removable chip "Esperando uma pessoa". Picking a company or a board leaves the filter, as it leaves `all`.

### 7. On Início

The "Fábrica" block sits on top of Início, between the first-steps link and "Peça a um agente": "Esperando seu teste"
over one panel per company, each panel opening the company's Painel. It draws nothing while loading, on an error, or
when no company has a task, so Início stays as it was.

## Consequences

- One migration (0261): two columns with defaults and a trigger, deploy-safe for the running version.
- No column is flagged by the migration, since it cannot know a client's names. After the deploy, a person flags the
  column ("Espera uma pessoa" in the board's columns dialog), or an operator runs
  `update issue_columns set waits_for_person = true where id = <the column>`. Until then no task waits and the block shows
  the panels alone.
- A task is still moved on its board: the list opens it, and approving or sending it back from the list is a later feature.
- Cost per company stays in the Painel, behind `view_usage`.
