# 0221. A board's own columns, templates, and a company's page

- Status: Accepted
- Date: 2026-11-13
- Extends: ADR 0171 (projects/boards), ADR 0219 (companies over boards), ADR 0176 (what an agent sees of the boards)

## Context

Three things read wrong the first time a real workspace used companies and boards.

1. **Every board had the same columns.** ADR 0171 decided one set per workspace; a software team's pipeline (Backlog,
   Especificar, Ready for dev, Em dev, PR, QA, Ajuste, Deploy, Concluído) then also had to be the pipeline of every
   other board, and a board of a different kind could not have its own flow.
2. **A company's page showed tasks.** Picking a company in the toolbar filtered the board to every task of every one
   of its boards. A company holds no task: what a person wants there is *which board*, then that board's kanban.
3. **A new task could name its board, never its company**, and a new board started from whatever the workspace
   happened to have, with no way to say "start from the development pipeline".

## Decision

### 1. Columns belong to a board

`issue_columns.project_id` (null: the workspace's own set). A board shows its own columns when it has them and the
workspace's otherwise, so nothing changes for a board that never asked. The first time a board's columns are edited
(`ensureBoardColumns`), it copies the workspace's into itself and the change lands there: editing a board never edits
another board or the workspace.

`issue_columns` keeps `stage` (todo, in progress, in review, done, canceled), so the system's own moves — an agent
starts work, a pull request is linked — still land in the first column of the stage.

`columnForMove` refuses a column of another board: a task moves inside its own board. A list across boards resolves
each task's column against every column of the workspace (`allColumns`), not against one board's set.

### 2. Templates

`issue_column_templates` (name, `[{ name, stage }]`) is a set of columns saved once. A workspace starts with two
(`SEEDED_TEMPLATES`): a plain **Kanban**, and **Desenvolvimento**, the pipeline above. A new board picks one in its
dialog and gets its own copy; "Salvar como modelo" saves a board's current columns as a new template.

Applying a template to a board replaces its columns and moves each task whose column went away to the first column of
its stage, so no task is left without a place.

### 3. A company's page lists its boards

`?space=` with no `?project=` renders the company's boards — each with its colour and how many tasks are open in it,
and "Novo board" — instead of a task list; picking one opens `?project=`, the kanban. The company's counts still come
from `GET …/issue-projects`, which keeps the aggregate (`spaces[].open`).

### 4. A new task names its company first

The new-task dialog offers Empresa and then Board, the boards filtered to that company; picking a board sets its
company, and changing the company drops a board of another one. A task still belongs to a board alone: the company is
the board's.

### 5. What an agent sees

`list_boards` lists each board with the columns that board actually has (its own, or the workspace's, marked as such),
and `update_issue`/`create_issue` resolve `column` inside the task's board — a name from another board's flow is
refused with the names that exist. So an agent can run a pipeline it did not build.

## Consequences

- A board that never edited its columns still follows the workspace's, including later changes to it. The moment it is
  edited, it stops following, silently and on purpose.
- Deleting a board deletes its columns with it (cascade); its tasks stay, with no board.
- The columns dialog on a board edits that board. The workspace's own set is only editable from a view without a board.
- Not in this change: a template that keeps following (a "board type" boards subscribe to), per-column automations,
  and reordering a template after it was applied.
