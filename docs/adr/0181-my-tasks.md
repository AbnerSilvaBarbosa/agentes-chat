# 0181. Minhas tarefas: the member's own tasks, one click from the sidebar

- Status: Accepted
- Date: 2026-11-13
- Extends: ADR 0159 (the sidebar's tools and their order), ADR 0179 and 0180 (Tarefas opens on the companies, by level)

## Context

Tarefas opens on the companies. A person who wants to see what is theirs had to open "Todas as tarefas" and set the
assignee filter to "Eu" by hand, every time, and the filter is kept per person for every level, so it also emptied
boards they opened next.

## Decision

### 1. A sidebar tool

`myTasks` is a tool of the sidebar like the others: it comes right after `issues` in `SIDEBAR_ITEMS` and in the
personal order (`packages/engine/src/sidebar-items.ts`, mirrored in `packages/client/src/lib/sidebar-items.ts`), is
`always` in sight in a team's workspace and `more` in a personal one (ADR 0159), and takes the same choices (always, in
More; `auto` is only for the tools with a count, and this one has none). Only choices are stored, so no migration. The
row is "Minhas tarefas" (`shell.myTasks`), also listed by the command menu. The right hand's "Abrir" pages
(`APP_PAGES`) are not changed.

### 2. A page that is a level of Tarefas

`/org/$orgId/my-tasks` renders `IssuesPage` with `mine`, which adds a fifth level to the rule in
`apps/web/src/pages/issues-level.ts`: `mine`, the task action, both selects (Empresa and Board) and `assignee: false`,
so "Filtro" offers priority only and the assignee filter saved for the other pages is ignored here. It is the board the
person knows (the same layout, grouping, cards and dialogs), with:

- the tasks assigned to them as a person, read from the server (`GET …/issues?assignee=me`, which lists only the
  tasks they may see, `taskSeenSql`, ADR 0151): the list is capped, so the filter cannot be applied on the page;
- canceled tasks left out whatever the display option says, archived boards' tasks kept;
- the header count "N em aberto";
- the empty state "Nada com você agora" with a link to "Todas as tarefas";
- live updates through the events the board already hears (`issue.created`, `issue.updated`, `issue.deleted`).

The sidebar highlights "Minhas tarefas" on that address and not "Tarefas", the two being different addresses. A tool
put in More is still reached by its address and by the More menu.

### 3. A task made there is the member's

"Nova tarefa" on that page starts assigned to them (`NewIssueDialog` takes the assignee as a starting choice, which the
person can still change), so a task never vanishes from the page it was made on. The button is absent without the right
to create tasks, as everywhere in Tarefas.

## Consequences

- One more level in a pure rule, with its own test, and one more query parameter on the issues list.
- Tasks assigned to the member's agents, or created by them, are not here: only "assigned to me" was asked.
- Not in this change: a count on the sidebar row (what waits on the person already has one in "Esperando você"), a
  block on Início, the phone and the desktop shell.

- The member's list leaves canceled tasks out on the server, before the list's cap of 200, so done and canceled ones cannot spend it.
