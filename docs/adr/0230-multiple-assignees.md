# 0230. Several people on a card, never two agents

- Status: Superseded by ADR 0188 (2026-11-24). Both teams built several people on a task; this fork now uses the shared
  `issue_assignees` list (people and agents, in order), and migration 0345 carries the "also with" rows into it. Kept as
  the history of the "principal plus people" model.
- Date: 2026-11-16
- Extends: ADR 0219 (Tarefas), ADR 0225 (Minhas tarefas), ADR 0226 (Painel), ADR 0145 (task conversations), ADR 0151 (who sees what)

## Context

A card had one responsible, a person or an agent. Work often needs a person beside the agent that carries the card (the
owner who tests it, a second person who follows it), and giving a card to a second person took the first one off it, so
the person who had to test or decide dropped out of "Minhas tarefas" and out of the card's notices. The development flow
also hands a card from one agent to the next (developer, QA, release), and each agent has its own rules, so two agents
must never work the same card at once.

## Decision

### 1. The model: a principal and the people also with it

`issues.assignee_type` and `issues.assignee_id` stay what they are: the card's **principal**. The people "também com"
are rows of a new table, `issue_co_assignees` (`issue_id`, `org_id`, `user_id`, `position`, who added them and when, one
row per person, migration 0263). A row is a person only: an agent is never also with a card. There is no backfill, every
existing card has no rows.

One invariant carries the design: **when a card has an agent, the agent is the principal**. So every reader that wakes
an agent, holds a run, builds a context or counts a card keeps reading `assignee` (`agentReaches`, `workOf`,
`startedWork`, `openTasksBrief`, `context.ts`, `task-conversation.ts`, the team readers) and none changes. The other
invariants, kept by the one writer: no principal means no rows, a principal
who is a person has no row of their own, at most five rows.

### 2. One rule, one writer, every door

`packages/engine/src/issue-assignees.ts` holds the rules. `planAssignees(before, change)` is pure: a change is any of
`assignees` (the whole list, in order), `assignee` (the hand-off meaning below), `removeAssignees`, `addAssignees` and
`principal`, applied in that order. `applyAssignees` is the only code that writes the principal's columns and the rows:
it locks the issue row, plans on the locked state, writes, and returns the history events. `createIssue`,
`updateIssue`, the screen's routes, `update_issue` and `create_issue` of the agents and undo all send an `AssigneeChange`
to it, so the rules cannot differ by door.

| Change | Rule |
| --- | --- |
| `assignees: [..]` | the one agent in the list (two: `issue.two_agents`) is the principal, the people replace the list, in order, deduplicated |
| `assignee: agent` | the agent replaces the card's agent, the people stay (the hand-off); over a person principal the agent becomes the principal and that person moves to "também com" |
| `assignee: person` | with an agent on the card the person is added beside the agent; without one the person replaces the first person, the others stay |
| `assignee: null` | everyone is taken off |
| `removeAssignees` | each named person leaves; the agent too when named, and the first person is then the principal |
| `addAssignees` | people appended, deduplicated; an agent only when the card has none |
| `principal: person` | the person moves to the front, refused while an agent is on the card (`issue.principal_is_agent`) or when the person is not on the card (`issue.principal_not_on_card`) |

More than five people also with the card is `issue.assignees_max`, counted after the change, so a card of six people
refuses an agent until one is taken off. The person added is checked (a member who sees the card, `issue.assignee_outside`)
and a person already on the card never is, so someone who lost sight of it can still be taken off.

The old `assignee` field keeps its hand-off meaning on every door (`askAgentToImplement`, `useStartAgentOnTask`, the
phone and older clients); the picker and undo use the whole-list form.

### 3. History

`issue_activity` gets `agent_replaced` (from, to), `assignee_added`, `assignee_removed` and `principal_changed`, beside
`assigned`. The names are stored in `data` when written, so the history reads right after a rename or a removal, and the
words are `issues.event.*` in both languages.

### 4. Who hears it and who counts

- The list filter for a person (`assignee=me`, the toolbar's person, Minhas tarefas) is "principal or also with"
  (`onCardSql`); for an agent it is the principal.
- A person newly on a card hears `issue_assigned` once, a person taken off has it resolved, and the status notice reaches
  everyone on the card (`issueFollowers`, `notifyIssueChanged` with the people before and after). A swap between two
  people who are both still on it sends nothing.
- A limited audience keeps every person on the card, and on each step (`chosenScope`, `setIssueAudience`).
- The company Painel and the per-agent counts keep counting the principal only: one card counts once, and "Sem
  responsável" stays honest because no principal means no rows.
- A person who leaves a workspace or deletes their account leaves its cards (`dropFromAssignments`, in the removal's
  transaction): the rows go and, when they were the principal, the first person also with the card is promoted or the
  card is left with nobody, with one `left` event per card.
- Undo restores the people: the snapshot holds `alsoWith` and the restore sends the whole list.

### 5. The agents' tools

`update_issue` gets `add_assignee` and `remove_assignee` (people by handle or name, up to five) to share a card without
replacing anyone; `create_issue` gets `add_assignee`. The tool refuses an agent in `add_assignee` before calling the
engine, and a call that names two agents; the engine refuses it too (`issue.two_agents`). The descriptions say that a
card has at most one agent, that a hand-off keeps the people and that naming a person on a card that has an agent adds
them beside it. The result of a hand-off says who stayed.

### 6. The screens

- `AssigneesField` (`apps/web/src/components/issues/AssigneesField.tsx`) is the one picker, on the card's properties
  line and in the new card dialog. Its trigger shows up to three faces, the principal's name and `+N`. Its menu names
  the principal, lists the people also with it (a row makes one the principal, never while an agent is on the card) and
  checks every person and agent of the workspace: a tick adds, taking it off removes. Choosing another agent says it takes
  the agent's place and the people stay. At five also with the unticked people are out of reach with the hint. Each
  change is the whole list in order or `principal`, and the answer of the server is what the card shows.
- The shared rules the screens read are `packages/client/src/lib/issue-assignees.ts` (`peopleOn`, `isOnCard`,
  `matchesAssignees`, `assigneeKeys`, `assignmentWith`, the optimistic mirror of `planAssignees`, null where the server
  refuses).
- A board card and a list row draw the principal then up to three faces and a count; the card's description reads every
  name once. The toolbar's person filter offers everyone on any loaded card. Grouped by assignee a card sits under its
  principal only (one card, one column); dropping a card on a person's column while an agent has it adds the person
  beside the agent, leaves the card where it is and says so from the server's answer, with Desfazer.

## Consequences

- One migration (0263), purely additive, no data step.
- The calendar draws one face per due date, the principal's, and the phone's "mine" counts the principal only: the
  server list for `assignee=me` is complete, and `isOnCard` is written for the phone's follow-up. Both are left for
  later decisions, as is a role per person (reviewer, approver) and an option for two agents.
- Any future writer of `assignee_type` or `assignee_id` that bypasses `applyAssignees` would break the invariant that
  every agent-side reader relies on.
