import { describe, expect, test } from "bun:test";
import { resources } from "@agenteschat/i18n";
import i18next from "i18next";
import { ApiError } from "../src/api/http";
import type { Actor, Issue } from "../src/api/types";
import { actionTextValues } from "../src/lib/actions";
import { knownErrorText } from "../src/lib/errors";
import {
  ASSIGNEES_MAX,
  assigneeKeys,
  assignmentWith,
  isOnCard,
  matchesAssignees,
  peopleOn,
} from "../src/lib/issue-assignees";
import { issueEventText } from "../src/lib/issues";

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

describe("the words of several people on a card", () => {
  const lang = (lng: string) => {
    const instance = i18next.createInstance();
    void instance.init({ lng, fallbackLng: "en", resources, initAsync: false, interpolation: { escapeValue: false } });
    return instance.t;
  };
  const en = lang("en");
  const pt = lang("pt-BR");

  test("the new error codes and history words exist in both languages", () => {
    // Each refusal reads as a sentence of its own in each language, never the server's English or a bare key.
    const refusals = {
      "issue.assignees_max": ["at most 5 people", "No máximo 5 pessoas"],
      "issue.two_agents": ["at most one agent", "no máximo um agente"],
      "issue.principal_is_agent": ["agent is its principal", "agente é o principal"],
      "issue.principal_not_on_card": ["not on the task", "não está no card"],
    } as const;
    for (const [code, [inEnglish, inPortuguese]] of Object.entries(refusals)) {
      const error = new ApiError(400, code, "server words");
      expect(knownErrorText(en, error)?.toLowerCase()).toContain(inEnglish.toLowerCase());
      expect(knownErrorText(pt, error, "pt-BR")?.toLowerCase()).toContain(inPortuguese.toLowerCase());
    }

    // The history: each event the card's people write, in the person's language, with the name or names it carries.
    const event = (textCode: string, textParams: Record<string, string>) => ({
      text: "fallback",
      textCode,
      textParams,
    });
    const words = {
      assignee_added: [{ name: "Bia" }, "added Bia to the task", "pôs Bia também no card"],
      assignee_removed: [{ name: "Bia" }, "took Bia off the task", "tirou Bia do card"],
      principal_changed: [{ name: "Bia" }, "made Bia the principal", "tornou Bia o principal"],
      agent_replaced: [
        { from: "Dev", to: "QA" },
        "handed the task from Dev to QA and the people stay",
        "passou o card de Dev para QA e as pessoas ficam",
      ],
    } as const;
    for (const [code, [params, inEnglish, inPortuguese]] of Object.entries(words)) {
      expect(issueEventText(en, event(code, params))).toBe(inEnglish);
      expect(issueEventText(pt, event(code, params))).toBe(inPortuguese);
    }

    // The agent's receipt names the field.
    const receipt = {
      kind: "issue.updated" as const,
      target: { type: "issue" as const, id: "i1", number: 3 },
      params: { fields: ["alsoWith"] },
    };
    expect(actionTextValues(receipt, en).fields).toBe("the people also on it");
    expect(actionTextValues(receipt, pt).fields).toBe("as pessoas também no card");

    // The picker's and the card's words, in both languages: none is missing (a missing key reads as itself).
    const keys = [
      "issues.assignees.label",
      "issues.assignees.principal",
      "issues.assignees.alsoWith",
      "issues.assignees.makePrincipal",
      "issues.assignees.add",
      "issues.assignees.max",
      "issues.assignees.swapsAgent",
      "issues.drag.alsoWith",
    ];
    for (const key of keys) {
      for (const t of [en, pt]) expect(t(key, { name: "Bia", count: 1 })).not.toBe(key);
    }
    expect(pt("issues.assignees.label")).toBe("Responsável");
    expect(pt("issues.assignees.principal")).toBe("Principal");
    expect(pt("issues.assignees.alsoWith")).toBe("Também com");
    expect(pt("issues.assignees.makePrincipal")).toBe("Tornar principal");
    expect(pt("issues.assignees.add")).toBe("Adicionar pessoa");
    expect(pt("issues.assignees.max")).toBe("No máximo 5 pessoas também com");
    expect(pt("issues.assignees.swapsAgent")).toBe("Troca o agente e as pessoas ficam");
    expect(pt("issues.assignees.describedWith", { principal: "Ana", people: "Bia, Caio" })).toBe(
      "Responsável: Ana. Também com: Bia, Caio.",
    );
    expect(pt("issues.drag.alsoWith", { name: "Bia" })).toBe("Bia entrou no card");
  });
});
