# 0224. Tarefas by level: a path back up, a company's image, status sets with a screen, and the agent test

- Status: Accepted
- Date: 2026-11-13
- Extends: ADR 0219 (companies over boards), ADR 0221 (a board's own columns, templates), ADR 0223 (Tarefas opens on the companies)

## Context

With the root on the companies, four things still did not follow from the structure.

1. **Every level offered every control.** "Nova tarefa" and the Empresa and Board selects showed on the companies'
   root and on a company's boards, where no task is read, and "Novo board" asked a company's page for the company it
   was already standing in.
2. **A board was a dead end.** The only way up was the browser's back button.
3. **A company had a color and nothing else**, which is thin for a workspace that groups clients.
4. **Column templates had no screen** (a set could be saved from a board, never made or edited), and nothing pinned
   what an agent can do with a card.

## Decision

### 1. The level decides the chrome

`levelOf` and `chromeFor` (`apps/web/src/pages/issues-level.ts`, pure) name the level from the address: `root`
(`/issues`), `company` (`?space=`), `board` (`?project=`, which wins over a company) and `all` (`?all=1`). The header's
action is the level's own: "Nova empresa" on the root, "Novo board" on a company, "Nova tarefa" in a board and in all
tasks. The Empresa and Board selects show only on all tasks, the one level that reads tasks across places. The `N`
shortcut makes a task only where tasks are read.

A board made from a company's page is made in that company: `ProjectDialog` takes `lockedSpace` and draws no Empresa
field. From anywhere else it shows Empresa with "Sem empresa", never offering an archived company. "Colunas do board"
lists the workspace's own columns first, then the status sets by name, and the board gets a copy of the chosen set.

### 2. A path back up

`Breadcrumb` (`packages/ui`) draws "Tarefas › empresa › board" above the title: every item but the last is a link, the
last is text, and a company's image or color shows beside its name. "Tarefas" opens the root and the company opens its
boards. A board in no company shows "Tarefas › board".

### 3. A company holds an image

`issue_spaces.image` names a file in the platform bucket (the way a person's photo is kept), at most 1 MiB, PNG, JPEG
or WebP, stripped of metadata by the same code as avatars (`readImage`, its limit a parameter; avatars keep 2 MB). The
browser crops it square to 512×512 before sending, so the server checks bytes and size and never decodes pixels. An
unreadable or oversized file is refused and the old image stays. `GET …/issue-space-images/{file}` serves it to
members of the workspace only. Without an image the color shows, as before; one `SpaceMark` draws either on the card,
the chip, the picker and the path.

### 4. Status sets are managed in Configurações › Tarefas

The sets are the existing column templates. `createColumnTemplate` and `updateColumnTemplate` add the two calls the
code lacked: a name of 1 to 40 characters (longer or empty refused; stored names are never rewritten) and columns by
stage, at least one. The screen lists every set with its columns grouped by stage and lets whoever may create tasks
create, rename, edit the columns (add, rename, reorder, move of stage, delete) and delete a set; anyone else reads
them. The seeded sets (Kanban, Desenvolvimento) show no Delete, since they come back when missing; their columns stay
editable. A board keeps its own copy of a set's columns, so deleting or editing a set never changes a board.

### 5. What an agent can do with a card is pinned by a test

`packages/engine/test/issue-tools.test.ts` plays an agent through `create_issue` (board, column, assignee),
`update_issue` (move by column name and stage, set and clear the assignee, place in a company and a board) and
`list_boards` (each board with its company and columns), asserts that a column the board lacks is refused with the
board's columns listed, and reads the tools' input schemas so a missing `column`, `assignee`, `company` or `project`
field fails the test.

## Consequences

- A screen offers only what its level can do; the cost is one more rule to keep, held in one pure function with its
  own test.
- The image is written straight to the platform bucket (`deps.blobs`), not through `writeBlob`, so it counts in no
  workspace's storage meter (ADR 0079); the 1 MiB cap and one image per company keep it small.
- Names of sets stay unique in any capitals; a legacy name over 40 characters stays valid but cannot be re-saved
  unchanged.
- Not in this change: reordering the sets, and a board that follows later edits of the set it came from.
