import type { Actor, Issue, IssuePatch } from "../api/types";

/**
 * Who is responsible on a card (ADR 0186): its principal (the card's agent when it has one, else its first person) and
 * up to five people also with it. These are the rules every screen reads, and the optimistic mirror of the server's
 * `planAssignees` (`packages/engine/src/issue-assignees.ts`), which decides.
 */

/** The most people also with a card beside its principal (mirror of the engine's `ASSIGNEES_MAX`). */
export const ASSIGNEES_MAX = 5;

/** The filter key of a card with nobody on it (`issues-view.ts`'s `none`). */
export const NO_ASSIGNEE_KEY = "none";

type OnCard = Pick<Issue, "assignee" | "alsoWith">;

const keyOf = (a: Actor) => `${a.type}:${a.id}`;
const same = (a: Actor, b: Actor) => a.type === b.type && a.id === b.id;

/** The principal first, then the people also with the card, in order. */
export const peopleOn = (issue: OnCard): Actor[] => [
  ...(issue.assignee ? [issue.assignee] : []),
  ...(issue.alsoWith ?? []),
];

/** Whether `actor` is the card's principal or a person also with it. */
export const isOnCard = (issue: OnCard, actor: Actor) => peopleOn(issue).some((a) => same(a, actor));

/** The keys a card matches in the toolbar filter and a saved view: the principal's, then each person also with it. */
export const assigneeKeys = (issue: OnCard): string[] => peopleOn(issue).map(keyOf);

/**
 * Whether a card passes an assignee filter (`agent:<id>`, `person:<id>` or `none`). An empty filter keeps every card; a
 * person's key matches the person on the card wherever they are; `none` matches only a card with nobody on it.
 */
export function matchesAssignees(issue: OnCard, keys: string[]) {
  if (keys.length === 0) return true;
  const on = assigneeKeys(issue);
  if (on.length === 0) return keys.includes(NO_ASSIGNEE_KEY);
  return keys.some((k) => on.includes(k));
}

type Change = Pick<IssuePatch, "assignees" | "assignee" | "removeAssignees" | "addAssignees" | "principal">;

const unique = <T>(list: T[]) => [...new Set(list)];

/**
 * The principal and the people a change leaves on a card, as the server will compute them, for the optimistic cache
 * (the server's answer replaces it). Null where the server would refuse (two agents, a principal who is an agent or
 * not on the card, more than five also with), so the cache is left alone and the refusal shows.
 */
export function assignmentWith(issue: OnCard, change: Change): { assignee: Actor | null; alsoWith: Actor[] } | null {
  let agentId = issue.assignee?.type === "agent" ? issue.assignee.id : null;
  let people = unique([
    ...(issue.assignee?.type === "person" ? [issue.assignee.id] : []),
    ...(issue.alsoWith ?? []).map((a) => a.id),
  ]);
  const peopleOf = (list: Actor[]) => unique(list.filter((a) => a.type === "person").map((a) => a.id));
  /** The one agent a list names; two different agents cannot be built. */
  const agentIn = (list: Actor[]) => {
    const found = unique(list.filter((a) => a.type === "agent").map((a) => a.id));
    return found.length > 1 ? undefined : (found[0] ?? null);
  };

  if (change.assignees) {
    const one = agentIn(change.assignees);
    if (one === undefined) return null;
    agentId = one;
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
  if (change.removeAssignees) {
    const gone = new Set(peopleOf(change.removeAssignees));
    people = people.filter((id) => !gone.has(id));
    if (agentId && change.removeAssignees.some((a) => a.type === "agent" && a.id === agentId)) agentId = null;
  }
  if (change.addAssignees) {
    const one = agentIn(change.addAssignees);
    if (one === undefined) return null;
    if (one && one !== agentId) {
      if (agentId) return null;
      agentId = one;
    }
    people = unique([...people, ...peopleOf(change.addAssignees)]);
  }
  if (change.principal) {
    const wanted = change.principal;
    if (wanted.type === "agent") {
      if (wanted.id !== agentId) return null;
    } else if (agentId || !people.includes(wanted.id)) {
      return null;
    } else {
      people = [wanted.id, ...people.filter((id) => id !== wanted.id)];
    }
  }

  const alsoWith = agentId ? people : people.slice(1);
  if (alsoWith.length > ASSIGNEES_MAX) return null;
  const person = (id: string): Actor => ({ type: "person", id });
  const assignee: Actor | null = agentId ? { type: "agent", id: agentId } : people[0] ? person(people[0]) : null;
  return { assignee, alsoWith: alsoWith.map(person) };
}
