import { afterEach, beforeEach, expect, test } from "bun:test";
import { browser, createTestServer, joinByInvitation, seedOrg, signUp, type TestServer } from "./harness";

let t: TestServer;
beforeEach(async () => {
  t = await createTestServer({ reply: () => ({ chunks: ["Feito."] }) });
});
afterEach(() => t.close());

type Browser = ReturnType<typeof browser>;
type Card = {
  id: string;
  assignee: { type: string; id: string } | null;
  alsoWith: { type: string; id: string }[];
};

const who = (type: "person" | "agent", id: string) => ({ type, id });
const idOf = async (b: Browser) => ((await (await b("/api/app/me")).json()) as { user: { id: string } }).user.id;

/** The owner, two members who see the whole workspace, and the agent `@dev`. */
async function team() {
  const owner = browser(t);
  await signUp(owner, "owner@example.com");
  const { orgId, agentId } = await seedOrg(owner);
  const bia = await joinByInvitation(t, owner, orgId, "bia@example.com");
  const caio = await joinByInvitation(t, owner, orgId, "caio@example.com");
  const ids = { owner: await idOf(owner), bia: await idOf(bia), caio: await idOf(caio) };
  const api = (path: string, init?: Parameters<typeof owner>[1]) =>
    owner(`/api/app/organizations/${orgId}${path}`, init);
  const patch = (id: string, json: Record<string, unknown>) => api(`/issues/${id}`, { method: "PATCH", json });
  const make = async (json: Record<string, unknown>) => {
    const res = await api("/issues", { json });
    expect(res.status).toBe(201);
    return (await res.json()) as Card;
  };
  return { owner, bia, caio, ids, orgId, agentId, api, patch, make };
}

const codeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

test("POST creates a card with several people and answers alsoWith in order", async () => {
  const { ids, make, api } = await team();
  const card = await make({
    title: "em grupo",
    assignees: [who("person", ids.bia), who("person", ids.caio), who("person", ids.owner)],
  });
  expect(card.assignee).toEqual(who("person", ids.bia));
  expect(card.alsoWith).toEqual([who("person", ids.caio), who("person", ids.owner)]);
  // Read back the same, by id and in the list.
  const read = (await (await api(`/issues/${card.id}`)).json()) as Card;
  expect(read.alsoWith).toEqual(card.alsoWith);
  const listed = (await (await api("/issues")).json()) as { issues: Card[] };
  expect(listed.issues.find((i) => i.id === card.id)?.alsoWith).toEqual(card.alsoWith);
  // The old `assignee` alone still makes a card with one person.
  const single = await make({ title: "um so", assignee: who("person", ids.bia) });
  expect(single.assignee).toEqual(who("person", ids.bia));
  expect(single.alsoWith).toEqual([]);
});

test("PATCH assignees adds, removes and reorders people", async () => {
  const { ids, make, patch } = await team();
  const card = await make({ title: "muda a lista", assignee: who("person", ids.owner) });
  const added = (await (
    await patch(card.id, { addAssignees: [who("person", ids.bia), who("person", ids.caio)] })
  ).json()) as Card;
  expect(added.assignee).toEqual(who("person", ids.owner));
  expect(added.alsoWith).toEqual([who("person", ids.bia), who("person", ids.caio)]);
  const removed = (await (await patch(card.id, { removeAssignees: [who("person", ids.bia)] })).json()) as Card;
  expect(removed.alsoWith).toEqual([who("person", ids.caio)]);
  // The whole list, in a new order: the first person is the principal.
  const reordered = (await (
    await patch(card.id, { assignees: [who("person", ids.caio), who("person", ids.bia), who("person", ids.owner)] })
  ).json()) as Card;
  expect(reordered.assignee).toEqual(who("person", ids.caio));
  expect(reordered.alsoWith).toEqual([who("person", ids.bia), who("person", ids.owner)]);
});

test("PATCH principal swaps two people", async () => {
  const { ids, make, patch } = await team();
  const card = await make({
    title: "troca",
    assignees: [who("person", ids.owner), who("person", ids.bia), who("person", ids.caio)],
  });
  const swapped = (await (await patch(card.id, { principal: who("person", ids.bia) })).json()) as Card;
  expect(swapped.assignee).toEqual(who("person", ids.bia));
  expect(swapped.alsoWith).toEqual([who("person", ids.owner), who("person", ids.caio)]);
});

test("PATCH refuses a sixth person, two agents and a non-member with their codes", async () => {
  const { ids, make, patch, agentId, owner, orgId } = await team();
  const crowd = [];
  for (const n of ["a", "b", "c", "d", "e"]) {
    const b = await joinByInvitation(t, owner, orgId, `${n}@example.com`);
    crowd.push(await idOf(b));
  }
  // The owner and five people also with: the sixth is refused.
  const full = await make({
    title: "cheio",
    assignees: [who("person", ids.owner), ...crowd.map((id) => who("person", id))],
  });
  expect(full.alsoWith).toHaveLength(5);
  const sixth = await patch(full.id, { addAssignees: [who("person", ids.bia)] });
  expect(sixth.status).toBe(400);
  expect(await codeOf(sixth)).toBe("issue.assignees_max");

  const card = await make({ title: "poucos", assignees: [who("person", ids.owner), who("person", ids.bia)] });
  // Two agents in one list.
  // Only `@dev` exists: the second agent is a made-up id, which the plan refuses before anything is looked up.
  const two = await patch(card.id, { assignees: [who("agent", agentId), who("agent", crypto.randomUUID())] });
  expect(two.status).toBe(400);
  expect(await codeOf(two)).toBe("issue.two_agents");
  // A principal who is an agent, or not on the card.
  await patch(card.id, { assignee: who("agent", agentId) });
  const asAgent = await patch(card.id, { principal: who("person", ids.bia) });
  expect(await codeOf(asAgent)).toBe("issue.principal_is_agent");
  const plain = await make({ title: "sem agente", assignee: who("person", ids.owner) });
  const notOn = await patch(plain.id, { principal: who("person", ids.caio) });
  expect(await codeOf(notOn)).toBe("issue.principal_not_on_card");
  // Someone who is not a member of the workspace (an account that is not in it).
  const outsiderId = `user_${crypto.randomUUID()}`;
  const refused = await patch(plain.id, { addAssignees: [who("person", outsiderId)] });
  expect(refused.status).toBe(400);
  // Nothing changed on the refused cards.
  const still = (await (await owner(`/api/app/organizations/${orgId}/issues/${plain.id}`)).json()) as Card;
  expect(still.assignee).toEqual(who("person", ids.owner));
  expect(still.alsoWith).toEqual([]);
});

test("POST refuses two agents and a sixth person also with, and makes no card", async () => {
  const { ids, api, agentId, owner, orgId } = await team();
  const before = async () => ((await (await api("/issues")).json()) as { issues: Card[] }).issues.length;
  const count = await before();
  const two = await api("/issues", {
    json: { title: "dois", assignees: [who("agent", agentId), who("agent", crypto.randomUUID())] },
  });
  expect(two.status).toBe(400);
  expect(await codeOf(two)).toBe("issue.two_agents");

  const crowd = [];
  for (const n of ["a", "b", "c", "d", "e"]) {
    crowd.push(await idOf(await joinByInvitation(t, owner, orgId, `${n}@example.com`)));
  }
  // The principal and six people also with: the sixth is one too many.
  const sixth = await api("/issues", {
    json: {
      title: "demais",
      assignees: [ids.owner, ...crowd, ids.bia].map((id) => who("person", id)),
    },
  });
  expect(sixth.status).toBe(400);
  expect(await before()).toBe(count);
});

test("PATCH assignee naming an agent keeps the people", async () => {
  const { ids, make, patch, agentId } = await team();
  const card = await make({ title: "passa ao agente", assignees: [who("person", ids.owner), who("person", ids.bia)] });
  const handed = (await (await patch(card.id, { assignee: who("agent", agentId) })).json()) as Card;
  expect(handed.assignee).toEqual(who("agent", agentId));
  expect(handed.alsoWith).toEqual([who("person", ids.owner), who("person", ids.bia)]);
  // A person named on a card that has an agent joins beside it.
  const joined = (await (await patch(card.id, { assignee: who("person", ids.caio) })).json()) as Card;
  expect(joined.assignee).toEqual(who("agent", agentId));
  expect(joined.alsoWith).toEqual([who("person", ids.owner), who("person", ids.bia), who("person", ids.caio)]);
  // The old field takes everyone off with null.
  const cleared = (await (await patch(card.id, { assignee: null })).json()) as Card;
  expect(cleared.assignee).toBeNull();
  expect(cleared.alsoWith).toEqual([]);
});

test("assignee=me lists a card where the caller is also with", async () => {
  const { ids, make, bia, caio, api, owner, orgId } = await team();
  const mine = await make({ title: "da Bia", assignees: [who("person", ids.owner), who("person", ids.bia)] });
  const theirs = await make({ title: "do dono", assignee: who("person", ids.owner) });
  const mineFor = async (b: Browser) =>
    ((await (await b(`/api/app/organizations/${orgId}/issues?assignee=me`)).json()) as { issues: Card[] }).issues.map(
      (i) => i.id,
    );
  // Bia is also with one card, in one load; the owner is the principal of both; Caio is on none.
  expect(await mineFor(bia)).toEqual([mine.id]);
  expect((await mineFor(owner)).sort()).toEqual([mine.id, theirs.id].sort());
  expect(await mineFor(caio)).toEqual([]);

  // A card she cannot see is not hers to list, even with a row on it: the audience decides.
  const hidden = await make({
    title: "fechado",
    assignee: who("person", ids.owner),
    audience: { mode: "people", userIds: [ids.owner, ids.caio] },
  });
  const res = await api(`/issues/${hidden.id}`, { method: "PATCH", json: { addAssignees: [who("person", ids.bia)] } });
  expect(res.status).toBe(400);
  expect(await mineFor(bia)).toEqual([mine.id]);
});
