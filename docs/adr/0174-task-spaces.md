# 0174. Spaces in Tarefas: a company over its boards

- Status: Accepted
- Date: 2026-11-12
- Extends: ADR 0171 (projects in Tarefas, one per task, each with its own board), ADR 0151 (who sees a task)

## Context

ADR 0171 gave a task one project and each project a board — the same board with only its tasks. A workspace that runs
several clients or products then had one flat list of boards: "CRM", "Site", "App", "CRM do cliente B", with colours to
tell them apart and nothing above them. People who run a software house asked for the shape every tracker they know has:
a company (a client, a product line) at the top, its boards under it, the tasks inside those boards. A person wants to
open "Empresa A" and see everything that company has, then narrow down to the board of one project.

## Decision

### 1. A space is a group of boards, and holds no task

`issue_spaces`: `org_id`, `name`, `color` (one of the roles' seven, `ROLE_COLORS`), `archived_at`. One name per
workspace whatever its capitals (a unique index on `org_id, lower(name)`), cut at 80 characters, and a workspace holds
at most 100.

`issue_projects.space_id` points at one, or is null (a board outside every space). A task keeps pointing at its board
alone: there is no task whose board and space could disagree, and `projectsById`, the cards and every agent's view of a
task keep reading exactly what they read before.

The names stay unique in the workspace and not per space (ADR 0171 §1): agents name a board by its name (`create_issue`,
`update_issue`, `list_issues`), and a name that meant two boards would make those tools guess. A workspace that needs
"Site" under two companies names them apart ("Site B").

### 2. A company's board is every task of its boards

`GET …/issues?spaceId=` filters on the server, as `projectId` does and for the same reason (the list is capped, so
filtering in the browser would leave a busy workspace half empty). Tarefas carries it in the address (`?space=<id>`),
one history entry per company, and the two filters exclude each other: picking a company leaves the board of a single
board, and picking a board leaves the company.

The title wears the company's dot and name; the boards keep their own. `GET …/issue-projects` now answers
`{ spaces, projects, unfiled }`: each space with the open tasks in its boards that the reader sees, each board with its
own, all of them following each task's audience (ADR 0151), so a company never tells of work its reader can't open.

### 3. The screens

Two chips in the toolbar, "Empresa" and "Board", instead of the one "Projeto": the first is the companies with their
counts, the second the boards grouped under their company's name (the boards in no space, and the archived ones, under
no heading). A board's dialog carries the company it joins, "Sem empresa" by default.

The company's own menu, on its board: edit, archive, delete. Deleting a company keeps its boards and their tasks, in no
space (the column's foreign key clears it); archiving it takes it out of the pickers and lets its boards stay where
they are.

Agents are untouched: they never name a space, and a board they create through `new_project` is created in no space,
for a person to file.

## Consequences

- Removing a space never loses a task or a board. It is one update of `issue_projects.space_id`.
- The boards menu now reads as a tree one level deep. A third level (a folder between company and board) was not asked
  for and is not built.
- Board names stay unique in the whole workspace, so two companies can't each have a "Site" without a different name.
  Changing that needs `projectByName` to take a space too, and every agent's tool with it.
- A board's own columns are still the workspace's (ADR 0171, "Not in this change"), so a company with a different
  pipeline needs that change first.
