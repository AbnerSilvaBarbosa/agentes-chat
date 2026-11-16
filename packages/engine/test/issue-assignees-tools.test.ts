import { afterEach, describe, expect, test } from "bun:test";
import {
  addChannelMember,
  createAgent,
  createChannel,
  createIssue,
  createIssueToolSource,
  getIssue,
  grantScopes,
  listMembers,
  NEW_AGENT_DEFAULTS,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const actor = (type: "person" | "agent", id: string) => ({ type, id });
const deps = () => ({ db: f.db, pubsub: f.pubsub });

/** The issue tools of the fixture's agent (`@dev`) in #general, with the issue scopes. */
async function agentTools(channelId = f.general.id) {
  const ctx = {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: crypto.randomUUID(),
    channelId,
    threadRootId: crypto.randomUUID(),
    triggerMessageId: crypto.randomUUID(),
  };
  await grantScopes(
    f.db,
    f.org.id,
    f.agent.id,
    ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope })),
  );
  const tools = await createIssueToolSource(f.artifactDeps).tools(ctx);
  const run = async (name: string, input: Record<string, unknown> = {}) => {
    const out = await tools.find((t) => t.name === name)?.execute(input, ctx);
    return { content: String(out?.content ?? ""), isError: out?.isError === true, data: out?.data };
  };
  return { tools, run };
}

/** Bia and Caio, as members with handles (`@bia`, `@caio`), and a second agent `@qa`. */
async function team() {
  const bia = await addMember(f.db, f.org.id, "member", "Bia");
  const caio = await addMember(f.db, f.org.id, "member", "Caio");
  await listMembers(f.db, f.org.id); // assigns their handles
  const qa = await createAgent(f.db, f.owner.id, f.org.id, { name: "QA", handle: "qa" }, NEW_AGENT_DEFAULTS);
  return { bia, caio, qa };
}

const read = (id: string) => getIssue(f.db, person(f.owner.id), f.org.id, { id });

describe("the agents' tools put several people on a card", () => {
  test("add_assignee adds a person also with and keeps the principal", async () => {
    f = await setup();
    const { bia, caio } = await team();
    const { run } = await agentTools();
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "dupla",
      assignee: actor("agent", f.agent.id),
    });
    const out = await run("update_issue", { issue: "#1", add_assignee: ["@bia", "@caio"] });
    expect(out.isError).toBe(false);
    const view = await read(card.id);
    expect(view.assignee).toEqual(actor("agent", f.agent.id));
    expect(view.alsoWith).toEqual([actor("person", bia.id), actor("person", caio.id)]);
    expect(out.content).toContain("(also with: Bia (@bia), Caio (@caio))");
  });

  test("remove_assignee takes a person off", async () => {
    f = await setup();
    const { bia, caio } = await team();
    const { run } = await agentTools();
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "tres",
      assignees: [actor("agent", f.agent.id), actor("person", bia.id), actor("person", caio.id)],
    });
    const out = await run("update_issue", { issue: "#1", remove_assignee: ["@bia"] });
    expect(out.isError).toBe(false);
    const view = await read(card.id);
    expect(view.assignee).toEqual(actor("agent", f.agent.id));
    expect(view.alsoWith).toEqual([actor("person", caio.id)]);
  });

  test("assignee naming an agent hands the card over and keeps the people", async () => {
    f = await setup();
    const { bia, qa } = await team();
    const { run } = await agentTools();
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "passa a bola",
      assignees: [actor("agent", f.agent.id), actor("person", bia.id)],
    });
    const out = await run("update_issue", { issue: "#1", assignee: "@qa" });
    expect(out.isError).toBe(false);
    const view = await read(card.id);
    expect(view.assignee).toEqual(actor("agent", qa.id));
    expect(view.alsoWith).toEqual([actor("person", bia.id)]);
    // The agent is told who stayed on the card.
    expect(out.content).toContain("Kept on it: Bia (@bia)");
  });

  test("two agents in one call are refused and nothing changes", async () => {
    f = await setup();
    const { bia } = await team();
    const { run } = await agentTools();
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, {
      title: "so um",
      assignees: [actor("agent", f.agent.id), actor("person", bia.id)],
    });
    const both = await run("update_issue", { issue: "#1", assignee: "@qa", add_assignee: ["@dev"] });
    expect(both.isError).toBe(true);
    expect(both.content).toContain("at most one agent");
    const other = await run("update_issue", { issue: "#1", assignee: "@qa", add_assignee: ["@qa"] });
    expect(other.isError).toBe(true);
    const view = await read(card.id);
    expect(view.assignee).toEqual(actor("agent", f.agent.id));
    expect(view.alsoWith).toEqual([actor("person", bia.id)]);
  });

  test("the update_issue description says one agent at most and that a hand-off keeps the people", async () => {
    f = await setup();
    const { tools } = await agentTools();
    const update = tools.find((t) => t.name === "update_issue");
    expect(update?.description).toContain("A card has at most one agent");
    expect(update?.description).toContain("keeps the people on it");
    expect(update?.description).toContain("add_assignee");
    const schema = update?.inputSchema as { properties: Record<string, { maxItems?: number }> };
    expect(schema.properties.add_assignee?.maxItems).toBe(5);
    expect(schema.properties.remove_assignee?.maxItems).toBe(5);
  });

  test("add_assignee with an agent is refused before the engine", async () => {
    f = await setup();
    await team();
    const { run } = await agentTools();
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "so gente" });
    const agent = await run("update_issue", { issue: "#1", add_assignee: ["@qa"] });
    expect(agent.isError).toBe(true);
    expect(agent.content).toContain("add_assignee takes people");
    expect(agent.content).toContain("assignee");
    // "me" and "none" belong to `assignee`, in either list.
    for (const field of ["add_assignee", "remove_assignee"]) {
      for (const word of ["me", "none"]) {
        const refused = await run("update_issue", { issue: "#1", [field]: [word] });
        expect(refused.isError).toBe(true);
      }
    }
    const view = await read(card.id);
    expect(view.assignee).toBeNull();
    expect(view.alsoWith).toEqual([]);
  });

  test("a person who cannot see the card is refused through the tool", async () => {
    f = await setup();
    const { bia, caio } = await team();
    // A card of a private channel the agent is in: Caio is not, so he does not see it.
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "secreto", visibility: "private" });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { agentId: f.agent.id });
    await addChannelMember(f.db, f.owner.id, f.org.id, secret.id, { userId: bia.id });
    const card = await createIssue(deps(), person(f.owner.id), f.org.id, { title: "fechado", channelId: secret.id });
    const { run } = await agentTools(secret.id);
    const refused = await run("update_issue", { issue: "#1", add_assignee: ["@caio"] });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("Add them to who sees it first");
    expect((await read(card.id)).alsoWith).toEqual([]);
    // Bia is in the channel: she can be added.
    expect((await run("update_issue", { issue: "#1", add_assignee: ["@bia"] })).isError).toBe(false);
    // A card with nobody on it: the first person added is its principal.
    expect((await read(card.id)).assignee).toEqual(actor("person", bia.id));
    expect(caio.id).toBeTruthy();
  });
});
