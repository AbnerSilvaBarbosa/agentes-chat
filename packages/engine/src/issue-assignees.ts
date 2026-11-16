import { ValidationError } from "./errors";
import type { WorkActor } from "./issues";

/**
 * Who is responsible on a card (ADR 0186). A card has at most one agent, which is always its principal, and people in
 * order. `issues.assignee_type/assignee_id` hold the principal, and `issue_co_assignees` the people beside it, so every
 * reader that wakes an agent keeps reading one column. This file is the one place that decides a change and writes it.
 */

/** The most people "also with" a card may have beside its principal. */
export const ASSIGNEES_MAX = 5;

/** `agentId` is the card's agent, if any; `people` are the person ids in order. The principal is the agent, else `people[0]`. */
export interface Assignment {
  agentId: string | null;
  people: string[];
}

/** One request to change who is on a card. Its pieces apply in the order they are listed here. */
export interface AssigneeChange {
  /** The whole list: replaces the agent and the people. */
  assignees?: WorkActor[];
  /** The hand-off: an agent replaces the agent; a person is added beside an agent, or replaces the principal without one; `null` clears everyone. */
  assignee?: WorkActor | null;
  remove?: WorkActor[];
  add?: WorkActor[];
  /** Moves a person to the front; refused while an agent is on the card. */
  principal?: WorkActor;
}

const unique = <T>(list: T[]) => [...new Set(list)];

/** The people of a list of actors, deduped, in order. */
const peopleOf = (list: WorkActor[]) => unique(list.filter((a) => a.type === "person").map((a) => a.id));

/** The one agent a list names; two different agents are refused. */
function agentIn(list: WorkActor[]): string | null {
  const agents = unique(list.filter((a) => a.type === "agent").map((a) => a.id));
  if (agents.length > 1) throw twoAgents();
  return agents[0] ?? null;
}

const twoAgents = () =>
  new ValidationError("A card has at most one agent. Hand it to the agent you want instead", "issue.two_agents");

/** The card's principal as its two columns, and the people beside it as rows (read back by `assignmentOf`). */
export function assignmentOf(
  row: { assigneeType: string | null; assigneeId: string | null },
  co: string[],
): Assignment {
  if (!row.assigneeType || !row.assigneeId) return { agentId: null, people: [] };
  if (row.assigneeType === "agent") return { agentId: row.assigneeId, people: [...co] };
  return { agentId: null, people: unique([row.assigneeId, ...co]) };
}

/** The principal's two columns. */
export function columnsOf(a: Assignment): { assigneeType: "person" | "agent" | null; assigneeId: string | null } {
  if (a.agentId) return { assigneeType: "agent", assigneeId: a.agentId };
  const first = a.people[0];
  return first ? { assigneeType: "person", assigneeId: first } : { assigneeType: null, assigneeId: null };
}

/** The people "also with": every person beside an agent, or all but the first without one. */
export const alsoWithOf = (a: Assignment) => (a.agentId ? a.people : a.people.slice(1));

/**
 * The result of a change, or a refusal that changes nothing. Pure: no database, `before` is never touched. The pieces
 * apply as `assignees`, `assignee`, `remove`, `add`, `principal`, then the limit is checked on who is also with.
 */
export function planAssignees(before: Assignment, change: AssigneeChange): Assignment {
  let agentId = before.agentId;
  let people = [...before.people];

  if (change.assignees) {
    agentId = agentIn(change.assignees);
    people = peopleOf(change.assignees);
  }

  if (change.assignee !== undefined) {
    const to = change.assignee;
    if (to === null) {
      agentId = null;
      people = [];
    } else if (to.type === "agent") {
      agentId = to.id;
    } else if (agentId) {
      if (!people.includes(to.id)) people.push(to.id);
    } else {
      people = unique([to.id, ...people.slice(1)]);
    }
  }

  if (change.remove) {
    const gone = new Set(change.remove.filter((a) => a.type === "person").map((a) => a.id));
    people = people.filter((id) => !gone.has(id));
    if (agentId && change.remove.some((a) => a.type === "agent" && a.id === agentId)) agentId = null;
  }

  if (change.add) {
    const agent = agentIn(change.add);
    if (agent && agent !== agentId) {
      if (agentId) throw twoAgents();
      agentId = agent;
    }
    people = unique([...people, ...peopleOf(change.add)]);
  }

  if (change.principal) {
    const wanted = change.principal;
    if (wanted.type === "agent") {
      if (wanted.id !== agentId) throw notOnCard();
    } else if (agentId) {
      throw new ValidationError(
        "The card's agent is its principal. Hand the card to a person to change that",
        "issue.principal_is_agent",
      );
    } else if (!people.includes(wanted.id)) {
      throw notOnCard();
    } else {
      people = [wanted.id, ...people.filter((id) => id !== wanted.id)];
    }
  }

  const after = { agentId, people };
  if (alsoWithOf(after).length > ASSIGNEES_MAX) {
    throw new ValidationError(
      agentId && people.length > ASSIGNEES_MAX
        ? `Take someone off the card before handing it to an agent: at most ${ASSIGNEES_MAX} people can be on it beside the agent`
        : `A card has at most ${ASSIGNEES_MAX} people beside its principal`,
      "issue.assignees_max",
    );
  }
  return after;
}

const notOnCard = () => new ValidationError("That person is not on the card", "issue.principal_not_on_card");

/** A card's principal: its agent, else its first person. */
function principalOf(a: Assignment): WorkActor | null {
  if (a.agentId) return { type: "agent", id: a.agentId };
  const first = a.people[0];
  return first ? { type: "person", id: first } : null;
}

export interface AssigneeEvent {
  text: string;
  event: "assigned" | "agent_replaced" | "assignee_added" | "assignee_removed" | "principal_changed";
  data: Record<string, unknown>;
}

/**
 * What the card's history says about a change, pure. A principal that changed is one `assigned` event (or
 * `agent_replaced` between two agents, or `principal_changed` for a swap among people); each person gained beside it is
 * `assignee_added` and each person lost `assignee_removed`. Everyone taken off is the single `assigned` event with no
 * assignee. Names go into `data` so the history reads right after a rename or a removal.
 */
export function assigneeEvents(
  before: Assignment,
  after: Assignment,
  name: (who: WorkActor) => string,
): AssigneeEvent[] {
  const events: AssigneeEvent[] = [];
  const was = principalOf(before);
  const now = principalOf(after);
  const same = was?.type === now?.type && was?.id === now?.id;
  const person = (id: string): WorkActor => ({ type: "person", id });
  let announced: string | null = null;

  if (before.agentId && after.agentId && before.agentId !== after.agentId) {
    const from = name({ type: "agent", id: before.agentId });
    const to = name({ type: "agent", id: after.agentId });
    events.push({
      text: `handed the issue from ${from} to ${to}`,
      event: "agent_replaced",
      data: {
        from: { agentId: before.agentId, name: from },
        to: { agentId: after.agentId, name: to },
        kept: after.people.length,
      },
    });
  } else if (!same) {
    if (!now) {
      return [{ text: "removed the assignee", event: "assigned", data: { assignee: null } }];
    }
    const swap =
      !before.agentId &&
      !after.agentId &&
      was !== null &&
      before.people.includes(now.id) &&
      after.people.includes(was.id);
    if (swap) {
      events.push({
        text: `made ${name(now)} the principal`,
        event: "principal_changed",
        data: { assignee: now, name: name(now) },
      });
    } else {
      // Promoted: a person who was already on the card became its principal (the agent left, or the principal did).
      const promoted = now.type === "person" && before.people.includes(now.id);
      events.push({
        text: "assigned the issue",
        event: "assigned",
        data: { assignee: now, ...(promoted ? { promoted: true } : {}) },
      });
    }
    if (now.type === "person") announced = now.id;
  }

  for (const id of after.people) {
    if (before.people.includes(id) || id === announced) continue;
    events.push({
      text: `added ${name(person(id))} to the issue`,
      event: "assignee_added",
      data: { assignee: person(id), name: name(person(id)) },
    });
  }
  for (const id of before.people) {
    if (after.people.includes(id)) continue;
    events.push({
      text: `took ${name(person(id))} off the issue`,
      event: "assignee_removed",
      data: { assignee: person(id), name: name(person(id)) },
    });
  }
  return events;
}
