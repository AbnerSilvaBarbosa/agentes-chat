import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  archiveAgent,
  createIssue,
  createIssueProject,
  createIssueSpace,
  isPoChatKey,
  listPoCompanies,
  parsePoChatKey,
  poAgentOf,
  poChatKey,
  updateIssueSpace,
} from "../src";
import { addMember, addUser, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** Names the PO straight in the settings row: how the workspace picks one is the settings tests' business. */
async function setPo(agentId: string | null) {
  await f.db
    .insert(schema.organizationSettings)
    .values({ orgId: f.org.id, poAgentId: agentId })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { poAgentId: agentId } });
}

describe("the PO chat's key", () => {
  test("the key sorts to a:<po>|s:<company>|u:<person> and reads back; no other key reads as a PO chat", () => {
    const key = poChatKey("agent-1", "space-1", "user-1");
    expect(key).toBe("a:agent-1|s:space-1|u:user-1");
    expect(parsePoChatKey(key)).toEqual({ agentId: "agent-1", spaceId: "space-1", userId: "user-1" });
    expect(isPoChatKey(key)).toBe(true);
    // A plain DM with an agent, a DM between people, an agents' DM, a routine room, no key at all.
    for (const other of ["a:agent-1|u:user-1", "u:user-1|u:user-2", "a:agent-1|a:agent-2", "routine|abc", "", null]) {
      expect(parsePoChatKey(other)).toBeNull();
      expect(isPoChatKey(other)).toBe(false);
    }
    // Three parts that are not agent, company and person in that order are not a PO chat.
    expect(parsePoChatKey("a:x|u:y|u:z")).toBeNull();
    expect(parsePoChatKey("a:x|s:|u:z")).toBeNull();
  });
});

describe("the workspace's PO", () => {
  test("poAgentOf is the agent in the setting, and none when unset, archived or gone", async () => {
    f = await setup();
    expect(await poAgentOf(f.db, f.org.id)).toBeNull();
    await setPo(f.agent.id);
    expect((await poAgentOf(f.db, f.org.id))?.id).toBe(f.agent.id);
    await archiveAgent(f.db, f.owner.id, f.org.id, f.agent.id);
    expect(await poAgentOf(f.db, f.org.id)).toBeNull();
    await setPo(null);
    expect(await poAgentOf(f.db, f.org.id)).toBeNull();
  });
});

describe("the companies a PO chat opens for", () => {
  test("listPoCompanies lists the live companies the person may see, archived left out", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const acme = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Acme Corp" });
    const beta = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Beta Ltda" });
    const old = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Antiga SA" });
    await updateIssueSpace(deps, f.owner.id, f.org.id, old.id, { archived: true });
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Entregas", spaceId: acme.id });
    const person = { type: "person" as const, userId: f.owner.id };
    await createIssue(deps, person, f.org.id, { title: "Aberto para todos", projectId: board.id });
    await createIssue(deps, person, f.org.id, {
      title: "So para a Ana",
      projectId: board.id,
      audience: { mode: "people", userIds: [f.owner.id] },
    });

    // No PO: nothing to open.
    expect(await listPoCompanies(f.db, bia.id, f.org.id)).toEqual({ agentId: null, companies: [] });

    await setPo(f.agent.id);
    const forBia = await listPoCompanies(f.db, bia.id, f.org.id);
    expect(forBia.agentId).toBe(f.agent.id);
    expect(forBia.companies.map((c) => [c.name, c.open, c.channelId])).toEqual([
      ["Acme Corp", 1, null],
      ["Beta Ltda", 0, null],
    ]);
    // The owner sees both cards (an administrator), so the count is the reader's own.
    const forOwner = await listPoCompanies(f.db, f.owner.id, f.org.id);
    expect(forOwner.companies.find((c) => c.id === acme.id)?.open).toBe(2);
    expect(forOwner.companies.map((c) => c.id)).not.toContain(old.id);
    expect(forOwner.companies.find((c) => c.id === beta.id)).toBeDefined();
  });

  test("a person outside the workspace is refused", async () => {
    f = await setup();
    await setPo(f.agent.id);
    const stranger = await addUser(f.db, "zed");
    await expect(listPoCompanies(f.db, stranger.id, f.org.id)).rejects.toThrow();
  });
});
