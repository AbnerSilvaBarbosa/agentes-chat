# 0223. Tarefas opens on the companies, boards carry their controls, and columns have a screen

- Status: Accepted
- Date: 2026-11-13
- Extends: ADR 0219 (companies over boards), ADR 0221 (a board's own columns, templates)

## Context

With companies and per-board columns in place, three things still cost a person time.

1. **Tarefas opened on every task.** A company's page was one click away in a chip, and the workspace's whole board was
   the landing. What a person with several clients wants first is the list of clients.
2. **A board could only be edited from inside itself.** Renaming, archiving or deleting it meant opening it, finding
   "⋯" and coming back.
3. **Moving a column between stages was impossible.** A column's stage was fixed at creation: changing a review column
   into a progress one meant deleting it and building another, which moved every card by hand — exactly the work a
   board is supposed to save.

## Decision

### 1. The root is the companies

`/issues` renders the workspace's companies — each with the open tasks in its boards and how many boards it has — then
the boards in no company, "Nova empresa" and "Todas as tarefas". Picking a company opens **its boards**; picking one
opens the kanban; "Todas as tarefas" opens the whole workspace's board, which is what the page showed before and now
lives at `?all=1`.

The chain is the address: `/issues` → `/issues?space=` → `/issues?project=`, each a history entry, and picking a
company or a board leaves `?all`.

### 2. A board's card carries its controls

Each board in a company's grid has a "⋯" with Editar, Arquivar and Excluir, for whoever may create tasks, opening the
same dialogs the board's own menu opens. Nobody has to go into a board to rename or delete it.

### 3. Columns do have a screen

`PATCH …/issue-columns/{id}` takes `stage`: the column moves to that stage's end **and every task in it takes that
stage**, each one's move recorded in its activity (`status_changed`, "(its column moved to another stage)"). It is one
transaction: a column and its tasks never disagree about the stage.

`BoardColumnsDialog` ("Colunas do board", from the board's menu) draws the board's columns grouped by stage: rename in
place, pick a stage, move up or down inside the stage, delete (disabled when the stage would be left empty), add, and
apply a template or save the board's columns as one.

## Consequences

- The board of the whole workspace is one more click, and it is named ("Todas as tarefas") instead of being the default.
- Moving a stage is a durable change to tasks: a "QA" column dragged into `done` marks every task in it as done. The
  activity says why, per task, and the audible text is the same one a person's own move writes.
- The stage is still what the system moves a task to (an agent starts work, a pull request is linked), so a column
  moved out of its stage does not come back by itself.
- Not in this change: dragging a column on the kanban itself, reordering columns across stages in one gesture, and
  deleting a company's board from the company's own menu (it is on each board's card).
