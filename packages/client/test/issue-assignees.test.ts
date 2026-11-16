import { describe, expect, test } from "bun:test";
import type { Actor, Issue } from "../src/api/types";
import {
  ASSIGNEES_MAX,
  assigneeKeys,
  assignmentWith,
  isOnCard,
  matchesAssignees,
  peopleOn,
} from "../src/lib/issue-assignees";

const person = (id: string): Actor => ({ type: "person", id });
const agent = (id: string): Actor => ({ type: "agent", id });
/** The only fields of a card these rules read. */
const card = (assignee: Actor | null, alsoWith?: Actor[]): Pick<Issue, "assignee" | "alsoWith"> => ({
  assignee,
  ...(alsoWith ? { alsoWith } : {}),
});

describe("who is on a card", () => {
  test("isOnCard is true for the principal and for each person also with", () => {
    const withAgent = card(agent("dev"), [person("ana"), person("bia")]);
    expect(isOnCard(withAgent, agent("dev"))).toBe(true);
    expect(isOnCard(withAgent, person("ana"))).toBe(true);
    expect(isOnCard(withAgent, person("bia"))).toBe(true);
    expect(isOnCard(withAgent, person("caio"))).toBe(false);
    // An agent is never on a card beside the principal, and the same id as a person is another actor.
    expect(isOnCard(withAgent, agent("ana"))).toBe(false);
    const withPerson = card(person("ana"), [person("bia")]);
    expect(isOnCard(withPerson, person("ana"))).toBe(true);
    expect(isOnCard(withPerson, person("bia"))).toBe(true);
    // A server from before sends no list; nobody on the card is on it.
    expect(isOnCard(card(person("ana")), person("bia"))).toBe(false);
    expect(isOnCard(card(null), person("ana"))).toBe(false);
    // The people of a card, principal first.
    expect(peopleOn(withAgent)).toEqual([agent("dev"), person("ana"), person("bia")]);
    expect(peopleOn(card(null))).toEqual([]);
  });

  test("matchesAssignees matches a person filter on a person also with", () => {
    const shared = card(agent("dev"), [person("ana"), person("bia")]);
    expect(assigneeKeys(shared)).toEqual(["agent:dev", "person:ana", "person:bia"]);
    // No filter keeps every card.
    expect(matchesAssignees(shared, [])).toBe(true);
    // A person key matches any of the people on the card, and an agent key the principal.
    expect(matchesAssignees(shared, ["person:bia"])).toBe(true);
    expect(matchesAssignees(shared, ["person:caio", "person:ana"])).toBe(true);
    expect(matchesAssignees(shared, ["agent:dev"])).toBe(true);
    expect(matchesAssignees(shared, ["person:caio"])).toBe(false);
    expect(matchesAssignees(shared, ["agent:other"])).toBe(false);
    // `none` is a card with nobody on it, and only that.
    expect(matchesAssignees(shared, ["none"])).toBe(false);
    expect(matchesAssignees(card(null, []), ["none"])).toBe(true);
    expect(matchesAssignees(card(null, []), ["person:ana"])).toBe(false);
    expect(matchesAssignees(card(null), ["none", "person:ana"])).toBe(true);
    // An agent that is not on the card matches nothing by being a person's id.
    expect(matchesAssignees(card(person("dev")), ["agent:dev"])).toBe(false);
    expect(ASSIGNEES_MAX).toBe(5);
  });
});

describe("the optimistic card", () => {
  const ana = person("ana");
  const bia = person("bia");
  const caio = person("caio");
  const dev = agent("dev");
  const qa = agent("qa");

  test("assignmentWith mirrors the server rules for the optimistic card", () => {
    // Add: appended and deduped, the principal stays.
    expect(assignmentWith(card(ana, [bia]), { addAssignees: [caio, bia, ana] })).toEqual({
      assignee: ana,
      alsoWith: [bia, caio],
    });
    // Remove: the others keep their order; removing the principal promotes the next person.
    expect(assignmentWith(card(ana, [bia, caio]), { removeAssignees: [bia] })).toEqual({
      assignee: ana,
      alsoWith: [caio],
    });
    expect(assignmentWith(card(ana, [bia, caio]), { removeAssignees: [ana] })).toEqual({
      assignee: bia,
      alsoWith: [caio],
    });
    expect(assignmentWith(card(ana, []), { removeAssignees: [ana] })).toEqual({ assignee: null, alsoWith: [] });
    // Swap: a person also with becomes the principal and the old principal takes their place in the list.
    expect(assignmentWith(card(ana, [bia, caio]), { principal: bia })).toEqual({
      assignee: bia,
      alsoWith: [ana, caio],
    });
    // Hand-off: an agent replaces the agent and the people stay; over a person, the person stays also with.
    expect(assignmentWith(card(dev, [ana, bia]), { assignee: qa })).toEqual({ assignee: qa, alsoWith: [ana, bia] });
    expect(assignmentWith(card(ana, [bia]), { assignee: dev })).toEqual({ assignee: dev, alsoWith: [ana, bia] });
    // A person named on a card with an agent is added beside it; without one they replace the principal.
    expect(assignmentWith(card(dev, [ana]), { assignee: bia })).toEqual({ assignee: dev, alsoWith: [ana, bia] });
    expect(assignmentWith(card(ana, [bia, caio]), { assignee: caio })).toEqual({
      assignee: caio,
      alsoWith: [bia],
    });
    // null takes everyone off; the whole list replaces everything, the agent being the principal.
    expect(assignmentWith(card(dev, [ana]), { assignee: null })).toEqual({ assignee: null, alsoWith: [] });
    expect(assignmentWith(card(ana, [bia]), { assignees: [bia, dev, caio] })).toEqual({
      assignee: dev,
      alsoWith: [bia, caio],
    });
    expect(assignmentWith(card(dev, []), { assignees: [caio, ana] })).toEqual({ assignee: caio, alsoWith: [ana] });
    // A server from before sends no list: it reads as none.
    expect(assignmentWith(card(ana), { addAssignees: [bia] })).toEqual({ assignee: ana, alsoWith: [bia] });
  });

  test("assignmentWith answers null where the server would refuse", () => {
    // Two agents, a principal who is an agent or not on the card, a sixth person: no optimistic change.
    expect(assignmentWith(card(dev, []), { assignees: [dev, qa] })).toBeNull();
    expect(assignmentWith(card(dev, []), { addAssignees: [qa] })).toBeNull();
    expect(assignmentWith(card(dev, [ana]), { principal: ana })).toBeNull();
    expect(assignmentWith(card(ana, [bia]), { principal: caio })).toBeNull();
    const five = ["a", "b", "c", "d", "e"].map(person);
    expect(assignmentWith(card(ana, five), { addAssignees: [caio] })).toBeNull();
    expect(assignmentWith(card(ana, five.slice(0, 4)), { addAssignees: [caio] })?.alsoWith).toHaveLength(5);
    // A card of six people given to an agent would make six also with.
    expect(assignmentWith(card(ana, five), { assignee: dev })).toBeNull();
  });
});
