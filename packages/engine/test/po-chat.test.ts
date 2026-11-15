import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  archiveAgent,
  createAgent,
  createIssue,
  createIssueProject,
  createIssueSpace,
  getOrgSettings,
  isPoChatKey,
  listPoCompanies,
  openPoChat,
  parsePoChatKey,
  poAgentOf,
  poChatKey,
  scheduleDeletion,
  setAgentAudience,
  updateIssueSpace,
  updateOrgSettings,
  ValidationError,
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

describe("the workspace picks its PO", () => {
  test("a PO agent is set by the workspace and an archived one counts as none", async () => {
    f = await setup({ rightHand: true });
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).poAgentId).toBeNull();

    const saved = await updateOrgSettings(f.db, f.owner.id, f.org.id, { poAgentId: f.agent.id });
    expect(saved.poAgentId).toBe(f.agent.id);
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).poAgentId).toBe(f.agent.id);
    expect((await poAgentOf(f.db, f.org.id))?.id).toBe(f.agent.id);

    // An unknown agent, the right hand and an archived agent are refused; the PO stays.
    const [rightHand] = await f.db.select().from(schema.agents).where(eq(schema.agents.builtin, "right_hand"));
    expect(rightHand).toBeDefined();
    const refused = (agentId: string) =>
      updateOrgSettings(f.db, f.owner.id, f.org.id, { poAgentId: agentId }).then(
        () => undefined,
        (e: unknown) => e as { code?: string },
      );
    expect((await refused(crypto.randomUUID()))?.code).toBe("po.agent_invalid");
    expect((await refused((rightHand as { id: string }).id))?.code).toBe("po.agent_invalid");
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Old", handle: "old", role: "PO", instructions: "x", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await archiveAgent(f.db, f.owner.id, f.org.id, other.id);
    expect((await refused(other.id))?.code).toBe("po.agent_invalid");
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).poAgentId).toBe(f.agent.id);

    // The PO archived later reads as none; clearing stores null.
    await archiveAgent(f.db, f.owner.id, f.org.id, f.agent.id);
    expect(await poAgentOf(f.db, f.org.id)).toBeNull();
    const cleared = await updateOrgSettings(f.db, f.owner.id, f.org.id, { poAgentId: null });
    expect(cleared.poAgentId).toBeNull();
  });

  test("only who may configure picks the PO", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await expect(updateOrgSettings(f.db, bia.id, f.org.id, { poAgentId: f.agent.id })).rejects.toThrow();
    expect((await getOrgSettings(f.db, f.owner.id, f.org.id)).poAgentId).toBeNull();
  });
});

describe("opening a PO chat", () => {
  const deps = () => ({ db: f.db, pubsub: f.pubsub });
  const members = (channelId: string) =>
    f.db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, channelId))
      .then((rows) => rows.map((r) => r.userId ?? `agent:${r.agentId}`).sort());

  test("openPoChat refuses without a PO agent", async () => {
    f = await setup();
    const acme = await createIssueSpace(deps(), f.owner.id, f.org.id, { name: "Acme Corp" });
    const refusal = await openPoChat(f.db, f.owner.id, f.org.id, acme.id).then(
      () => undefined,
      (e: unknown) => e as ValidationError,
    );
    expect(refusal).toBeInstanceOf(ValidationError);
    expect(refusal?.code).toBe("po.none");
    expect(await f.db.select().from(schema.channels).where(eq(schema.channels.kind, "dm"))).toEqual([]);
  });

  test("each company has its own PO conversation and history", async () => {
    f = await setup();
    await setPo(f.agent.id);
    const acme = await createIssueSpace(deps(), f.owner.id, f.org.id, { name: "Acme Corp" });
    const beta = await createIssueSpace(deps(), f.owner.id, f.org.id, { name: "Beta Ltda" });
    const bia = await addMember(f.db, f.org.id, "member", "bia");

    const first = await openPoChat(f.db, f.owner.id, f.org.id, acme.id);
    expect(first.agentId).toBe(f.agent.id);
    expect(first.space).toMatchObject({ id: acme.id, name: "Acme Corp" });
    const [channel] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, first.channelId));
    expect(channel).toMatchObject({
      kind: "dm",
      visibility: "private",
      dmKey: `a:${f.agent.id}|s:${acme.id}|u:${f.owner.id}`,
    });
    expect(await members(first.channelId)).toEqual([f.owner.id, `agent:${f.agent.id}`].sort());

    // The same company again: the same conversation. Another company, or another person: its own.
    expect((await openPoChat(f.db, f.owner.id, f.org.id, acme.id)).channelId).toBe(first.channelId);
    const other = await openPoChat(f.db, f.owner.id, f.org.id, beta.id);
    expect(other.channelId).not.toBe(first.channelId);
    const theirs = await openPoChat(f.db, bia.id, f.org.id, acme.id);
    expect(theirs.channelId).not.toBe(first.channelId);
    expect(await members(theirs.channelId)).toEqual([bia.id, `agent:${f.agent.id}`].sort());

    // Each one is listed for its company once it exists.
    const listed = await listPoCompanies(f.db, f.owner.id, f.org.id);
    expect(listed.companies.map((c) => [c.name, c.channelId])).toEqual([
      ["Acme Corp", first.channelId],
      ["Beta Ltda", other.channelId],
    ]);
  });

  test("a company of another workspace, an archived one and a person the PO's audience refuses are refused", async () => {
    f = await setup();
    await setPo(f.agent.id);
    const acme = await createIssueSpace(deps(), f.owner.id, f.org.id, { name: "Acme Corp" });
    const old = await createIssueSpace(deps(), f.owner.id, f.org.id, { name: "Antiga SA" });
    await updateIssueSpace(deps(), f.owner.id, f.org.id, old.id, { archived: true });
    await expect(openPoChat(f.db, f.owner.id, f.org.id, crypto.randomUUID())).rejects.toThrow("Company not found");
    await expect(openPoChat(f.db, f.owner.id, f.org.id, old.id)).rejects.toThrow("archived");

    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await f.db.update(schema.agents).set({ ownerUserId: f.owner.id }).where(eq(schema.agents.id, f.agent.id));
    await setAgentAudience(f.db, f.owner.id, f.org.id, f.agent.id, { mode: "people", userIds: [], roleIds: [] });
    await expect(openPoChat(f.db, bia.id, f.org.id, acme.id)).rejects.toThrow();
    expect(
      await f.db
        .select()
        .from(schema.channels)
        .where(eq(schema.channels.dmKey, poChatKey(f.agent.id, acme.id, bia.id))),
    ).toEqual([]);
    // The owner, in the audience always, opens it.
    expect((await openPoChat(f.db, f.owner.id, f.org.id, acme.id)).channelId).toBeString();
  });

  test("an archived chat is reopened, and a workspace being deleted opens only the chats it has", async () => {
    f = await setup();
    await setPo(f.agent.id);
    const acme = await createIssueSpace(deps(), f.owner.id, f.org.id, { name: "Acme Corp" });
    const beta = await createIssueSpace(deps(), f.owner.id, f.org.id, { name: "Beta Ltda" });
    const first = await openPoChat(f.db, f.owner.id, f.org.id, acme.id);
    await f.db.update(schema.channels).set({ archivedAt: new Date() }).where(eq(schema.channels.id, first.channelId));
    expect((await openPoChat(f.db, f.owner.id, f.org.id, acme.id)).channelId).toBe(first.channelId);
    const [reopened] = await f.db.select().from(schema.channels).where(eq(schema.channels.id, first.channelId));
    expect(reopened?.archivedAt).toBeNull();

    await scheduleDeletion({ db: f.db }, f.owner.id, f.org.id, "owner");
    expect((await openPoChat(f.db, f.owner.id, f.org.id, acme.id)).channelId).toBe(first.channelId);
    await expect(openPoChat(f.db, f.owner.id, f.org.id, beta.id)).rejects.toThrow();
  });
});
