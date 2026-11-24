# 0222. A board's name is unique in its company, not in the workspace

- Status: Accepted
- Date: 2026-11-13
- Amends: ADR 0171 §1 (names unique per workspace), ADR 0219 §1 (which kept that rule and listed the cost)

## Context

ADR 0219 gave companies their boards and kept boards' names unique in the whole workspace, because agents name a
board by its name (`create_issue`, `update_issue`, `list_issues`) and a name that meant two boards would make those
tools guess. It listed the cost in its own consequences: two companies could not each have an "Entregas".

The first workspace with two clients hit it immediately: the second "Entregas" was refused with *"a project with that
name already exists"*, which is exactly the word a person with two clients does not expect — their pipeline repeats per
client by design.

## Decision

### 1. The unique index is scoped by company

`issue_projects_org_space_name` on `(org_id, coalesce(space_id, <nil uuid>), lower(name))`, replacing
`issue_projects_org_name`. The `coalesce` is not decoration: NULLs are distinct in a unique index, so two boards in no
company could otherwise share a name.

So: one "Entregas" per company (in any capitals), and one among the boards that belong to no company. Renaming a board
and moving a board between companies check the group it lands in.

### 2. A name alone may be ambiguous, and the tools say so

`projectByName` takes the company. With one, it looks in it. Without, it matches any board of the workspace: one match
is that board; none is the existing "unknown name" answer, with the boards listed **with their companies**; more than
one is `issue_project.ambiguous`, listing them as "Empresa A › Entregas, Empresa B › Entregas" and telling the agent to
say which company (or to use the board's id).

`create_issue` and `update_issue` gain `company` beside `project`, used only to resolve the board; `list_issues`
already had `company` and now passes it to the same lookup. `new_project: true` creates the board **in the company the
call named**, or in none.

### 3. The screens say which company

Two boards with the same name read as "Empresa A › Entregas" and "Empresa B › Entregas" wherever the company is not
already the heading — the task's board picker, the new-task menu — and stay plain in the boards chip, where the
company is the group's title. The "name taken" message says *"this company already has a board with that name"*.

## Consequences

- Existing workspaces need nothing: the older rule was stricter, so every row already satisfies the new one.
- An agent that names a board and nothing else still works while the name is unique; the moment a workspace has two,
  it is told to say the company, in one sentence, with both candidates named.
- Not in this change: a board id in the tools (the ambiguity message mentions it, but `project` takes a name), and
  renaming every board of a company at once.
