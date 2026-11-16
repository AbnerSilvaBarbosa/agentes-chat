import { describe, expect, test } from "bun:test";
import { ValidationError } from "../src/errors";
import { type Assignment, assigneeEvents, assignmentOf, columnsOf, planAssignees } from "../src/issue-assignees";

const p = (id: string) => ({ type: "person" as const, id });
const a = (id: string) => ({ type: "agent" as const, id });
const none: Assignment = { agentId: null, people: [] };

/** The code a refused plan carries; fails the test when the plan was accepted. */
function refusal(before: Assignment, change: Parameters<typeof planAssignees>[1]) {
  try {
    planAssignees(before, change);
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).code;
  }
  throw new Error("the plan was accepted");
}

describe("planAssignees", () => {
  test("a person added beside the principal keeps the principal and is listed in order", () => {
    const after = planAssignees({ agentId: null, people: ["ana"] }, { add: [p("bia"), p("caio")] });
    expect(after).toEqual({ agentId: null, people: ["ana", "bia", "caio"] });
    expect(columnsOf(after)).toEqual({ assigneeType: "person", assigneeId: "ana" });
  });

  test("removing someone keeps the others in their order", () => {
    const after = planAssignees({ agentId: null, people: ["ana", "bia", "caio", "dani"] }, { remove: [p("bia")] });
    expect(after.people).toEqual(["ana", "caio", "dani"]);
  });

  test("making another person the principal swaps them with the current one", () => {
    const after = planAssignees({ agentId: null, people: ["ana", "bia", "caio"] }, { principal: p("caio") });
    expect(after.people).toEqual(["caio", "ana", "bia"]);
    expect(columnsOf(after).assigneeId).toBe("caio");
  });

  test("a sixth person also with is refused with issue.assignees_max", () => {
    const full = { agentId: null, people: ["p0", "p1", "p2", "p3", "p4", "p5"] };
    expect(planAssignees(none, { assignees: full.people.map(p) }).people).toHaveLength(6);
    expect(refusal(full, { add: [p("p6")] })).toBe("issue.assignees_max");
    expect(refusal(none, { assignees: [...full.people, "p6"].map(p) })).toBe("issue.assignees_max");
  });

  test("a card of six people refuses an agent with issue.assignees_max", () => {
    const six = { agentId: null, people: ["p0", "p1", "p2", "p3", "p4", "p5"] };
    expect(refusal(six, { assignee: a("ag") })).toBe("issue.assignees_max");
    // Five people beside an agent are fine: the agent is the principal, the five are also with.
    const five = { agentId: null, people: ["p0", "p1", "p2", "p3", "p4"] };
    expect(planAssignees(five, { assignee: a("ag") })).toEqual({ agentId: "ag", people: five.people });
  });

  test("an agent given to a card with another agent replaces it and keeps the people", () => {
    const after = planAssignees({ agentId: "dev", people: ["ana", "bia"] }, { assignee: a("qa") });
    expect(after).toEqual({ agentId: "qa", people: ["ana", "bia"] });
  });

  test("an agent given to a card whose principal is a person becomes the principal and the person stays also with", () => {
    const after = planAssignees({ agentId: null, people: ["ana"] }, { assignee: a("dev") });
    expect(after).toEqual({ agentId: "dev", people: ["ana"] });
    expect(columnsOf(after)).toEqual({ assigneeType: "agent", assigneeId: "dev" });
  });

  test("removing the agent promotes the first person also with", () => {
    const after = planAssignees({ agentId: "dev", people: ["ana", "bia"] }, { remove: [a("dev")] });
    expect(after).toEqual({ agentId: null, people: ["ana", "bia"] });
    expect(columnsOf(after).assigneeId).toBe("ana");
  });

  test("removing the principal person promotes the next one and with none leaves the card unassigned", () => {
    const next = planAssignees({ agentId: null, people: ["ana", "bia"] }, { remove: [p("ana")] });
    expect(columnsOf(next)).toEqual({ assigneeType: "person", assigneeId: "bia" });
    const alone = planAssignees({ agentId: null, people: ["ana"] }, { remove: [p("ana")] });
    expect(alone).toEqual(none);
    expect(columnsOf(alone)).toEqual({ assigneeType: null, assigneeId: null });
    // Removing the agent of a card with no one else leaves it unassigned too.
    expect(planAssignees({ agentId: "dev", people: [] }, { remove: [a("dev")] })).toEqual(none);
  });

  test("two agents in one request are refused with issue.two_agents and nothing changes", () => {
    const before = Object.freeze({ agentId: "dev", people: Object.freeze(["ana"]) as string[] });
    expect(refusal(before, { assignees: [a("x"), a("y"), p("ana")] })).toBe("issue.two_agents");
    expect(refusal(before, { add: [a("y")] })).toBe("issue.two_agents");
    expect(refusal(none, { assignee: a("x"), add: [a("y")] })).toBe("issue.two_agents");
    expect(before).toEqual({ agentId: "dev", people: ["ana"] });
    // The same agent named twice is one agent, not two.
    expect(planAssignees(none, { assignees: [a("x"), a("x")] })).toEqual({ agentId: "x", people: [] });
  });

  test("the same person named twice is one entry", () => {
    expect(planAssignees(none, { assignees: [p("ana"), p("bia"), p("ana")] }).people).toEqual(["ana", "bia"]);
    expect(planAssignees({ agentId: null, people: ["ana"] }, { add: [p("bia"), p("bia")] }).people).toEqual([
      "ana",
      "bia",
    ]);
  });

  test("the principal named also with stays the principal only", () => {
    const after = planAssignees({ agentId: null, people: ["ana", "bia"] }, { add: [p("ana")] });
    expect(after.people).toEqual(["ana", "bia"]);
    const withAgent = planAssignees({ agentId: "dev", people: ["ana"] }, { add: [a("dev"), p("ana")] });
    expect(withAgent).toEqual({ agentId: "dev", people: ["ana"] });
  });

  test("a person assigned to a card with an agent is added also with, without an agent replaces the principal", () => {
    expect(planAssignees({ agentId: "dev", people: ["ana"] }, { assignee: p("bia") })).toEqual({
      agentId: "dev",
      people: ["ana", "bia"],
    });
    // Already there: kept where it is.
    expect(planAssignees({ agentId: "dev", people: ["ana", "bia"] }, { assignee: p("ana") }).people).toEqual([
      "ana",
      "bia",
    ]);
    // No agent: the person replaces the principal, the others stay.
    expect(planAssignees({ agentId: null, people: ["ana", "bia"] }, { assignee: p("caio") })).toEqual({
      agentId: null,
      people: ["caio", "bia"],
    });
    // A person who was also with takes the principal's place without a duplicate.
    expect(planAssignees({ agentId: null, people: ["ana", "bia", "caio"] }, { assignee: p("caio") }).people).toEqual([
      "caio",
      "bia",
    ]);
    // Nobody on the card: the person becomes the principal. null clears every one.
    expect(planAssignees(none, { assignee: p("ana") }).people).toEqual(["ana"]);
    expect(planAssignees({ agentId: "dev", people: ["ana", "bia"] }, { assignee: null })).toEqual(none);
  });

  test("principal on a card with an agent is refused with issue.principal_is_agent", () => {
    expect(refusal({ agentId: "dev", people: ["ana", "bia"] }, { principal: p("bia") })).toBe(
      "issue.principal_is_agent",
    );
  });

  test("a principal who is not on the card is refused with issue.principal_not_on_card", () => {
    expect(refusal({ agentId: null, people: ["ana"] }, { principal: p("zed") })).toBe("issue.principal_not_on_card");
  });

  test("the whole list replaces the card's people and agent, in order", () => {
    const after = planAssignees({ agentId: "dev", people: ["ana", "bia"] }, { assignees: [p("caio"), p("ana")] });
    expect(after).toEqual({ agentId: null, people: ["caio", "ana"] });
    const withAgent = planAssignees({ agentId: null, people: ["ana"] }, { assignees: [p("bia"), a("qa"), p("ana")] });
    expect(withAgent).toEqual({ agentId: "qa", people: ["bia", "ana"] });
  });

  test("the pieces of one request apply in the order assignees, assignee, remove, add, principal", () => {
    const after = planAssignees(
      { agentId: null, people: ["ana"] },
      { assignees: [p("ana"), p("bia")], remove: [p("ana")], add: [p("caio")], principal: p("caio") },
    );
    expect(after.people).toEqual(["caio", "bia"]);
  });

  test("assignmentOf reads a card's columns and rows, and columnsOf writes them back", () => {
    expect(assignmentOf({ assigneeType: "agent", assigneeId: "dev" }, ["ana"])).toEqual({
      agentId: "dev",
      people: ["ana"],
    });
    expect(assignmentOf({ assigneeType: "person", assigneeId: "ana" }, ["bia"])).toEqual({
      agentId: null,
      people: ["ana", "bia"],
    });
    expect(assignmentOf({ assigneeType: null, assigneeId: null }, [])).toEqual(none);
    expect(columnsOf({ agentId: "dev", people: ["ana"] })).toEqual({ assigneeType: "agent", assigneeId: "dev" });
  });
});

const nameOf = (x: { type: "person" | "agent"; id: string }) => `${x.type}:${x.id}`;
const kinds = (before: Assignment, after: Assignment) => assigneeEvents(before, after, nameOf).map((e) => e.event);

describe("assigneeEvents", () => {
  test("history events say each change: added, removed, swapped, agent replaced, promoted", () => {
    // Added beside a principal that stays: one event for the person, none for the principal.
    const added = assigneeEvents({ agentId: null, people: ["ana"] }, { agentId: null, people: ["ana", "bia"] }, nameOf);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      event: "assignee_added",
      data: { assignee: { type: "person", id: "bia" }, name: "person:bia" },
    });
    // Removed: the others stay.
    const removed = assigneeEvents(
      { agentId: null, people: ["ana", "bia"] },
      { agentId: null, people: ["ana"] },
      nameOf,
    );
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      event: "assignee_removed",
      data: { assignee: { type: "person", id: "bia" }, name: "person:bia" },
    });
    // Swapped among people, no agent: one principal_changed and nothing else.
    const swapped = assigneeEvents(
      { agentId: null, people: ["ana", "bia"] },
      { agentId: null, people: ["bia", "ana"] },
      nameOf,
    );
    expect(swapped).toHaveLength(1);
    expect(swapped[0]).toMatchObject({
      event: "principal_changed",
      data: { assignee: { type: "person", id: "bia" }, name: "person:bia" },
    });
    // Agent for another agent: one agent_replaced, never also assigned; the people stay unmentioned.
    const replaced = assigneeEvents(
      { agentId: "dev", people: ["ana", "bia"] },
      { agentId: "qa", people: ["ana", "bia"] },
      nameOf,
    );
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({
      event: "agent_replaced",
      data: { from: { agentId: "dev", name: "agent:dev" }, to: { agentId: "qa", name: "agent:qa" }, kept: 2 },
    });
    // The agent leaves and the first person is promoted: assigned with promoted, nobody "removed".
    const promoted = assigneeEvents(
      { agentId: "dev", people: ["ana", "bia"] },
      { agentId: null, people: ["ana", "bia"] },
      nameOf,
    );
    expect(promoted).toHaveLength(1);
    expect(promoted[0]).toMatchObject({
      event: "assigned",
      data: { assignee: { type: "person", id: "ana" }, promoted: true },
    });
  });

  test("everyone taken off is one assigned event with no assignee", () => {
    const events = assigneeEvents({ agentId: null, people: ["ana", "bia"] }, { agentId: null, people: [] }, nameOf);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event: "assigned", data: { assignee: null } });
  });

  test("a new principal is one assigned event and the person it replaced is taken off", () => {
    expect(kinds({ agentId: null, people: ["ana"] }, { agentId: null, people: ["caio"] })).toEqual([
      "assigned",
      "assignee_removed",
    ]);
    // Nobody before: the first person is assigned, the rest are added.
    expect(kinds(none, { agentId: null, people: ["ana", "bia"] })).toEqual(["assigned", "assignee_added"]);
    const [assigned] = assigneeEvents(none, { agentId: null, people: ["ana"] }, nameOf);
    expect(assigned?.data).not.toHaveProperty("promoted");
  });

  test("an agent over a person principal is assigned and the person is not removed", () => {
    expect(kinds({ agentId: null, people: ["ana"] }, { agentId: "dev", people: ["ana"] })).toEqual(["assigned"]);
  });

  test("a card that did not change has no events", () => {
    expect(kinds({ agentId: "dev", people: ["ana"] }, { agentId: "dev", people: ["ana"] })).toEqual([]);
  });
});
