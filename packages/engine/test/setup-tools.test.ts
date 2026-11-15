import { afterEach, describe, expect, test } from "bun:test";
import { orgTopic } from "@agenteschat/adapters";
import { eq, schema } from "@agenteschat/db";
import {
  type ActionCard,
  ADD_MCP_CARD,
  actionsFor,
  CONNECT_AI_CARD,
  CONNECT_APP_CARD,
  type ConnectAppCard,
  connectorListing,
  createChannel,
  createChannelCategory,
  createRole,
  createSetupToolSource,
  createToolGateway,
  DEFAULT_AGENT_SCOPES,
  deferrableGroups,
  INVITE_CARD,
  type InviteCard,
  insertMessage,
  linkRunActions,
  listChannelCategories,
  listChannels,
  MAX_CARDS_PER_RUN,
  MAX_CATEGORIES_PER_RUN,
  MAX_CHANNELS_PER_RUN,
  MCP_PRESETS,
  openAgentDm,
  presentTools,
  redoAgentAction,
  replyThreadOf,
  SETUP_SCOPE,
  setMemberRoles,
  type ToolContext,
  undoAgentAction,
} from "../src";
import { REFUSALS, toolKind, toolPolicy } from "../src/tools/run-policy";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** A run of @dev on a message `userId` wrote in #general: the tools act for that person. */
async function runFor(fx: Fixture, userId: string, body: string, channelId = fx.general.id): Promise<ToolContext> {
  const trigger = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId,
    author: { type: "person", userId },
    body,
  });
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run.id,
    channelId,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

/** Through the Tool Gateway, as a run calls them: scopes, the run policy and the input's schema apply. */
const gatewayOf = (fx: Fixture) => createToolGateway({ sources: [createSetupToolSource({ pubsub: fx.pubsub })] });
async function call(fx: Fixture, ctx: ToolContext, name: string, input: Record<string, unknown>) {
  const res = await gatewayOf(fx).invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name, input });
  if (res.type !== "result") throw new Error(`not a result: ${res.type}`);
  return res.output;
}

const addLia = async (fx: Fixture, ownerUserId: string) => {
  const [lia] = await fx.db
    .insert(schema.agents)
    .values({
      orgId: fx.org.id,
      name: "Lia",
      handle: "lia",
      role: "Research",
      instructions: "",
      model: "claude-sonnet-5-5",
      ownerUserId,
    })
    .returning();
  if (!lia) throw new Error("no lia");
  return lia;
};

const cards = async (fx: Fixture) =>
  (await fx.db.select().from(schema.messages).where(eq(schema.messages.orgId, fx.org.id))).filter(
    (m) => m.meta.actionCard,
  );
const channelNamed = async (fx: Fixture, name: string) =>
  (await fx.db.select().from(schema.channels).where(eq(schema.channels.orgId, fx.org.id))).find((c) => c.name === name);

describe("the setup group", () => {
  test("granted by default, its own group (loaded when the judge expects it), a card is a reply here and a channel goes elsewhere", async () => {
    f = await setup();
    expect(DEFAULT_AGENT_SCOPES).toContain(SETUP_SCOPE);
    const ctx = await runFor(f, f.owner.id, "cria um canal pro lançamento");
    const granted = await gatewayOf(f).granted(ctx);
    expect(granted.map((t) => t.name)).toEqual([
      "create_channel",
      "create_channel_category",
      "offer_connect_ai",
      "offer_connect_app",
      "offer_invites",
      "propose_agent",
      "propose_remove_agents",
      "propose_settings_change",
      "request_settings_change",
    ]);
    // An agent's own settings go with the conversation's rarer tools, whatever its setup grant (ADR 0137).
    expect(deferrableGroups(granted).map((g) => [g.key, g.tools.length])).toEqual([
      ["setup", 8],
      ["more", 1],
    ]);
    expect(deferrableGroups(granted)[0]?.label).toBe(
      "Workspace setup (connect an AI, an app or an MCP server, invite people, create channels, propose agents, archive or delete agents; the right hand: approvals, people, any screen)",
    );
    // Not loaded: behind find_tools; loaded: as they are.
    expect(presentTools(granted, undefined, []).map((t) => t.name)).toEqual(["find_tools", "use_tool"]);
    expect(presentTools(granted, undefined, ["setup"]).map((t) => t.name)).toEqual([
      "create_channel",
      "create_channel_category",
      "offer_connect_ai",
      "offer_connect_app",
      "offer_invites",
      "propose_agent",
      "propose_remove_agents",
      "propose_settings_change",
      "find_tools",
      "use_tool",
    ]);
    const kind = (name: string) => toolKind({ name, scope: SETUP_SCOPE, connectionId: null }).kind;
    expect(kind("offer_connect_ai")).toBe("here");
    expect(kind("propose_agent")).toBe("here");
    expect(kind("propose_remove_agents")).toBe("here");
    expect(kind("offer_connect_app")).toBe("here");
    expect(kind("offer_invites")).toBe("here");
    // An agent's own settings, as its permissions: no routine asks for them.
    expect(kind("request_settings_change")).toBe("elsewhere");
    expect(kind("create_channel")).toBe("elsewhere");
  });
});

describe("offer_connect_app", () => {
  test("an MCP server's address: a card whose button opens connecting by address with it; no address, the dialog asks", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "conecta https://mcp.acme.example.com/mcp");
    const events = f.listen(f.general.id);
    const out = await call(f, ctx, "offer_connect_app", {
      url: "https://mcp.acme.example.com/mcp",
      why: "Você pediu o MCP da Acme.",
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("Posted the card to connect mcp.acme.example.com");
    expect(out.content).not.toContain("can't connect");
    await call(f, ctx, "offer_connect_app", { why: "Me passe o endereço no diálogo." });
    const [mcp, any] = await cards(f);
    expect(mcp?.meta.actionCard).toEqual({
      kind: "connect_app",
      forUserId: f.owner.id,
      params: { url: "https://mcp.acme.example.com/mcp", why: "Você pediu o MCP da Acme." },
    } satisfies ConnectAppCard);
    expect(mcp?.meta).toMatchObject({ bodyCode: CONNECT_APP_CARD, bodyParams: { name: "mcp.acme.example.com" } });
    expect(mcp?.threadId).toBe(replyThreadOf(ctx));
    expect(any?.meta).toMatchObject({
      bodyCode: ADD_MCP_CARD,
      actionCard: { params: { why: "Me passe o endereço no diálogo." } },
    });
    expect(events).toContainEqual(expect.objectContaining({ type: "message.created", messageId: mcp?.id }));
  });

  test("`reason` goes on the card as `why` only when it is the one line the call has", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "conecta um mcp");
    const out = await call(f, ctx, "offer_connect_app", { reason: "Para ler as issues." });
    expect(out.isError).toBeUndefined();
    const [card] = await cards(f);
    expect(card?.meta).toMatchObject({ actionCard: { params: { why: "Para ler as issues." } } });

    // Never over a real `why`, an empty one included, and blank text is no reason at all.
    for (const input of [{ why: "Esse.", reason: "Outro." }, { why: "", reason: "Outro." }, { reason: "  " }, {}]) {
      const refused = await call(f, ctx, "offer_connect_app", input);
      expect(refused.isError).toBe(true);
      expect(refused.content).toStartWith("Invalid input:");
    }
    // A provider's arguments can parse to something else than an object: refused the same, never a crash.
    const text = await call(f, ctx, "offer_connect_app", "Outro." as unknown as Record<string, unknown>);
    expect(text.content).toStartWith("Invalid input:");
    expect(await cards(f)).toHaveLength(1);
  });

  test("a service by name, or a one-click server by its address, is the catalog's entry; unknown names and bad addresses are refused", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "conecta o linear");
    const preset = MCP_PRESETS.find((p) => !p.composio && !p.soon);
    if (!preset) throw new Error("no preset");
    await call(f, ctx, "offer_connect_app", { app: "Linear", why: "Para ler as issues." });
    await call(f, ctx, "offer_connect_app", { url: preset.serverUrl, why: "Esse." });
    expect((await cards(f)).map((m) => (m.meta.actionCard as ConnectAppCard).params)).toEqual([
      { connector: "linear", why: "Para ler as issues." },
      { connector: preset.id, why: "Esse." },
    ]);
    const unknown = await call(f, ctx, "offer_connect_app", { app: "Acme Interno", why: "x" });
    expect(unknown).toMatchObject({ isError: true });
    expect(unknown.content).toContain("isn't in the catalog");
    for (const url of ["http://mcp.acme.example.com", "https://user:secret@mcp.acme.example.com/mcp", "not a url"]) {
      const out = await call(f, ctx, "offer_connect_app", { url, why: "x" });
      expect(out.isError).toBe(true);
    }
    expect((await cards(f)).length).toBe(2);
  });

  test("who may not connect: the card for an admin where one can open it; a DM with no admin posts nothing and says to ask one", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const here = await runFor(f, bia.id, "conecta https://mcp.acme.example.com/mcp");
    const out = await call(f, here, "offer_connect_app", {
      url: "https://mcp.acme.example.com/mcp",
      why: "Pedido da Bia.",
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("can't connect apps: an admin here does it from the card");
    const hers = await createChannel(f.db, bia.id, f.org.id, { name: "bia-notes", visibility: "private" });
    const alone = await runFor(f, bia.id, "conecta", hers.id);
    const none = await call(f, alone, "offer_connect_app", { url: "https://mcp.acme.example.com/mcp", why: "x" });
    expect(none).toMatchObject({ isError: true });
    expect(none.content).toContain("offer to ask one");
    expect((await cards(f)).length).toBe(1);
  });
});

test("offer_connect_app: a mailbox or a database says where it's connected; a service this server can't connect posts nothing", async () => {
  f = await setup();
  const server = { oauthApps: {} };
  const gateway = createToolGateway({ sources: [createSetupToolSource({ pubsub: f.pubsub, catalog: server })] });
  const ctx = await runFor(f, f.owner.id, "conecta");
  const run = async (input: Record<string, unknown>) => {
    const res = await gateway.invoke(ctx, { toolUseId: `tu_${crypto.randomUUID()}`, name: "offer_connect_app", input });
    if (res.type !== "result") throw new Error(res.type);
    return res.output;
  };
  const gmail = await run({ app: "Gmail", why: "x" });
  expect(gmail).toMatchObject({ isError: true });
  expect(gmail.content).toContain("Add connector › Email");
  expect(gmail.content).not.toContain("https address");
  expect((await run({ app: "Postgres", why: "x" })).content).toContain("Add connector › Database");
  const listing = connectorListing(server);
  const soon = listing.find((e) => e.soon);
  const off = listing.find((e) => !e.available && !e.soon);
  if (!soon || !off) throw new Error("no soon or unavailable entry");
  expect((await run({ app: soon.label, why: "x" })).content).toContain("doesn't let agentes.chat connect in one click");
  expect((await run({ app: off.label, why: "x" })).content).toContain("isn't available on this installation");
  expect(await cards(f)).toEqual([]);
});

describe("offer_invites", () => {
  test("a card with the addresses for the invite dialog; bad addresses refused; who can't invite reads who does", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "convida a ana e a bia");
    const out = await call(f, ctx, "offer_invites", {
      emails: ["Ana@Example.com", "bia@example.com", "ana@example.com"],
      why: "O time de design.",
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("nobody is invited until a person sends it");
    const [card] = await cards(f);
    expect(card?.meta).toMatchObject({ bodyCode: INVITE_CARD });
    expect(card?.meta.actionCard).toEqual({
      kind: "invite_people",
      forUserId: f.owner.id,
      params: { emails: ["ana@example.com", "bia@example.com"], why: "O time de design." },
    } satisfies InviteCard);
    expect(await call(f, ctx, "offer_invites", { emails: ["ana"], why: "x" })).toMatchObject({
      isError: true,
      content: "Not an email address: ana.",
    });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const member = await runFor(f, bia.id, "convida o caio");
    const theirs = await call(f, member, "offer_invites", { emails: ["caio@example.com"], why: "Caio." });
    // Every member may invite by default; the card is theirs.
    expect(theirs.isError).toBeUndefined();
    expect((await cards(f)).length).toBe(2);
  });
});

describe("offer_connect_ai", () => {
  test("a card where the run replies: the step, the agents and the line the app's card shows", async () => {
    f = await setup();
    const lia = await addLia(f, f.owner.id);
    const ctx = await runFor(f, f.owner.id, "quero usar meu plano do Claude na Lia");
    const events = f.listen(f.general.id);
    const out = await call(f, ctx, "offer_connect_ai", {
      what: "claude",
      agents: ["@Lia"],
      why: "Você pediu para a Lia pensar com o seu plano do Claude.",
    });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("for Lia");
    const [card] = await cards(f);
    expect(card).toMatchObject({
      authorType: "agent",
      authorAgentId: f.agent.id,
      agentRunId: ctx.runId,
      threadId: replyThreadOf(ctx),
      body: "Connect a Claude plan for Lia: Você pediu para a Lia pensar com o seu plano do Claude.",
    });
    expect(card?.meta.bodyCode).toBe(CONNECT_AI_CARD);
    expect(card?.meta.actionCard).toEqual({
      kind: "connect_ai",
      forUserId: f.owner.id,
      params: { what: "claude", agentIds: [lia.id], why: "Você pediu para a Lia pensar com o seu plano do Claude." },
    } satisfies ActionCard);
    expect(events).toContainEqual(expect.objectContaining({ type: "message.created", messageId: card?.id }));
  });

  test("defaults: a plan for the agent itself; a key for the organization, with its provider", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "conecta");
    await call(f, ctx, "offer_connect_ai", { what: "chatgpt", why: "Para usar o seu plano do ChatGPT." });
    await call(f, ctx, "offer_connect_ai", { what: "api_key", provider: "openai", why: "Sua chave da OpenAI." });
    await call(f, ctx, "offer_connect_ai", { why: "Escolha como conectar." });
    expect((await cards(f)).map((m) => (m.meta.actionCard as ActionCard).params)).toEqual([
      { what: "chatgpt", agentIds: [f.agent.id], why: "Para usar o seu plano do ChatGPT." },
      { what: "api_key", provider: "openai", agentIds: [], why: "Sua chave da OpenAI." },
      { agentIds: [], why: "Escolha como conectar." },
    ]);
  });

  test("its input is checked: an unknown step or provider, no line, unknown handles; Gemini only as a key", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "conecta o gemini");
    for (const input of [
      { what: "gemini", why: "Conectar." },
      { what: "api_key", provider: "acme", why: "Conectar." },
      { what: "claude" },
      { what: "claude", why: "Conectar.", agents: Array.from({ length: 11 }, (_, i) => `@a${i}`) },
    ]) {
      const out = await call(f, ctx, "offer_connect_ai", input);
      expect(out.isError).toBe(true);
      expect(out.content).toContain("Invalid input");
    }
    const unknown = await call(f, ctx, "offer_connect_ai", { agents: ["@dev", "@nobody"], why: "Conectar." });
    expect(unknown).toMatchObject({ isError: true, content: "No agent @nobody here." });
    expect(await cards(f)).toEqual([]);
    // Google's plans can't be used in other products: Gemini comes as an API key.
    await call(f, ctx, "offer_connect_ai", { what: "api_key", provider: "gemini", why: "Sua chave do Gemini." });
    expect((await cards(f)).map((m) => (m.meta.actionCard as ActionCard).params)).toEqual([
      { what: "api_key", provider: "gemini", agentIds: [], why: "Sua chave do Gemini." },
    ]);
  });

  test(`at most ${MAX_CARDS_PER_RUN} cards per run`, async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "conecta tudo");
    for (let i = 0; i < MAX_CARDS_PER_RUN; i++) {
      expect((await call(f, ctx, "offer_connect_ai", { why: `Card ${i}` })).isError).toBeUndefined();
    }
    const over = await call(f, ctx, "offer_connect_ai", { why: "One more" });
    expect(over).toMatchObject({
      isError: true,
      content: `You already offered ${MAX_CARDS_PER_RUN} cards in this turn.`,
    });
    expect((await cards(f)).length).toBe(MAX_CARDS_PER_RUN);
    // Another run starts its own count.
    const next = await runFor(f, f.owner.id, "e mais um");
    expect((await call(f, next, "offer_connect_ai", { why: "Next run" })).isError).toBeUndefined();
  });
});

describe("create_channel", () => {
  test("the person's channel with people and agents; a receipt with Undo (archive) and Redo; a message there keeps it", async () => {
    f = await setup();
    const lia = await addLia(f, f.owner.id);
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const ctx = await runFor(f, f.owner.id, "cria o #lancamento com a bia e a lia");
    const out = await call(f, ctx, "create_channel", {
      name: "#Lancamento",
      topic: "Lançamento do Q4",
      people: ["bia", f.owner.email],
      agents: ["@lia"],
    });
    expect(out).toMatchObject({ content: "Created #lancamento with bia, @lia." });
    const channel = await channelNamed(f, "lancamento");
    expect(channel).toMatchObject({ topic: "Lançamento do Q4", createdByUserId: f.owner.id, archivedAt: null });
    const members = await f.db
      .select()
      .from(schema.channelMembers)
      .where(eq(schema.channelMembers.channelId, channel?.id ?? ""));
    expect(members.map((m) => m.userId ?? m.agentId).sort()).toEqual([f.owner.id, bia.id, lia.id].sort());

    const reply = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      threadId: replyThreadOf(ctx),
      author: { type: "agent", agentId: f.agent.id, runId: ctx.runId, hop: 1 },
      body: "Criei o #lancamento.",
    });
    await linkRunActions(f.db, f.org.id, ctx.runId, reply.id);
    const [action] = (await actionsFor(f.db, f.org.id, [reply.id])).get(reply.id) ?? [];
    expect(action).toMatchObject({
      kind: "channel.created",
      requestedByUserId: f.owner.id,
      target: { type: "channel", id: channel?.id, title: "lancamento" },
      params: { name: "lancamento" },
    });
    const deps = { db: f.db, pubsub: f.pubsub };
    const archived = async () => (await channelNamed(f, "lancamento"))?.archivedAt ?? null;
    await undoAgentAction(deps, f.owner.id, f.org.id, action?.id ?? "");
    expect(await archived()).not.toBeNull();
    await redoAgentAction(deps, f.owner.id, f.org.id, action?.id ?? "");
    expect(await archived()).toBeNull();
    // Someone already wrote there: undoing would hide it.
    await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: channel?.id ?? "",
      author: { type: "person", userId: bia.id },
      body: "oi!",
    });
    await expect(undoAgentAction(deps, f.owner.id, f.org.id, action?.id ?? "")).rejects.toMatchObject({
      code: "action.changed_since",
    });
    expect(await archived()).toBeNull();
  });

  test("with the rights of the person who asked: a member can't bring an agent they don't own, and nothing is created", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const ctx = await runFor(f, bia.id, "cria o #pesquisa com o dev");
    const refused = await call(f, ctx, "create_channel", { name: "pesquisa", agents: ["@dev"] });
    expect(refused).toMatchObject({
      isError: true,
      content: "Failed: Only an admin or the agent's owner can change where it works",
    });
    expect(await channelNamed(f, "pesquisa")).toBeUndefined();
    expect(await f.db.select().from(schema.agentActions)).toEqual([]);
    // Their own channel, with people, is theirs to make.
    expect(await call(f, ctx, "create_channel", { name: "pesquisa", people: ["ana"] })).toMatchObject({
      content: "Created #pesquisa with ana.",
    });
    expect(await channelNamed(f, "pesquisa")).toMatchObject({ createdByUserId: bia.id });
  });

  test("its input is checked: names, people and agents that aren't there", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria canais");
    expect(await call(f, ctx, "create_channel", { name: "Lançamento Q4" })).toMatchObject({
      isError: true,
      content: "Failed: channel name: lower-case letters, digits, - or _ (max 80)",
    });
    expect(await call(f, ctx, "create_channel", { name: "general" })).toMatchObject({
      isError: true,
      content: "Failed: #general already exists",
    });
    expect(await call(f, ctx, "create_channel", { name: "x", people: ["zé"] })).toMatchObject({
      isError: true,
      content: 'No one called "zé" in this organization.',
    });
    expect(await call(f, ctx, "create_channel", { name: "x", agents: ["@nobody"] })).toMatchObject({
      isError: true,
      content: "No agent @nobody here.",
    });
    expect((await call(f, ctx, "create_channel", { topic: "sem nome" })).content).toContain("Invalid input");
    expect(await channelNamed(f, "x")).toBeUndefined();
  });

  test(`at most ${MAX_CHANNELS_PER_RUN} channels per run`, async () => {
    expect(MAX_CHANNELS_PER_RUN).toBe(10);
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria seis canais");
    for (let i = 0; i < MAX_CHANNELS_PER_RUN; i++) {
      expect((await call(f, ctx, "create_channel", { name: `canal-${i}` })).isError).toBeUndefined();
    }
    expect(await call(f, ctx, "create_channel", { name: "canal-extra" })).toMatchObject({
      isError: true,
      content: `You already created ${MAX_CHANNELS_PER_RUN} channels in this turn.`,
    });
    expect(await channelNamed(f, "canal-extra")).toBeUndefined();
  });
});

const categoriesOf = (fx: Fixture) => listChannelCategories(fx.db, fx.owner.id, fx.org.id);
/** The receipts of a run, oldest first. */
const receiptsOf = async (fx: Fixture, ctx: ToolContext) =>
  (await fx.db.select().from(schema.agentActions).where(eq(schema.agentActions.runId, ctx.runId))).sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
  );

describe("create_channel_category", () => {
  test("creates the category at the end of the sidebar and names it", async () => {
    f = await setup();
    await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Interno" });
    const ctx = await runFor(f, f.owner.id, "cria a categoria Livora");
    const out = await call(f, ctx, "create_channel_category", { name: " Livora " });
    expect(out).toMatchObject({
      content: 'Created the category "Livora".',
      data: { category: { name: "Livora" } },
    });
    expect((await categoriesOf(f)).map((c) => c.name)).toEqual(["Interno", "Livora"]);
  });

  test("records one channel_category.created receipt with the name and the channels taken", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria a categoria Livora com o geral");
    await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas" });
    await call(f, ctx, "create_channel_category", { name: "Livora", channels: ["#vendas", "general"] });
    const rows = await receiptsOf(f, ctx);
    expect(rows).toHaveLength(1);
    const [category] = await categoriesOf(f);
    expect(rows[0]).toMatchObject({
      kind: "channel_category.created",
      requestedByUserId: f.owner.id,
      targetType: "channel_category",
      targetId: category?.id,
      target: { title: "Livora" },
      params: { name: "Livora", channels: ["vendas", "general"] },
    });
  });

  test("refuses a category name that exists ignoring case and names it", async () => {
    f = await setup();
    await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Livora" });
    const ctx = await runFor(f, f.owner.id, "cria a categoria livora");
    const out = await call(f, ctx, "create_channel_category", { name: "livora" });
    expect(out.isError).toBe(true);
    expect(out.content).toContain('The category "Livora" already exists');
    expect(await categoriesOf(f)).toHaveLength(1);
    expect(await receiptsOf(f, ctx)).toEqual([]);
  });

  test("refuses an empty category name and one over 40 characters", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria categorias");
    expect((await call(f, ctx, "create_channel_category", { name: "   " })).isError).toBe(true);
    const long = await call(f, ctx, "create_channel_category", { name: "x".repeat(41) });
    expect(long).toMatchObject({ isError: true });
    expect(long.content).toContain("at most 40 characters");
    expect(await categoriesOf(f)).toEqual([]);
    expect(await receiptsOf(f, ctx)).toEqual([]);
  });

  test("refuses a category from a person without manage_channels and creates nothing", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const ctx = await runFor(f, bia.id, "cria a categoria Livora");
    const out = await call(f, ctx, "create_channel_category", { name: "Livora" });
    expect(out).toEqual({
      content: "You can't create categories: it needs the right to manage channels. Nothing was created.",
      isError: true,
    });
    expect(await categoriesOf(f)).toEqual([]);
    expect(await receiptsOf(f, ctx)).toEqual([]);
  });

  test("refuses a category in a run with no person behind it", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria a categoria Livora");
    // Nobody asked: the trigger was an agent's note, not a person's message.
    await f.db
      .update(schema.messages)
      .set({ authorType: "agent", authorUserId: null, authorAgentId: f.agent.id })
      .where(eq(schema.messages.id, ctx.triggerMessageId ?? ""));
    const out = await call(f, ctx, "create_channel_category", { name: "Livora" });
    expect(out).toMatchObject({ isError: true });
    expect(await categoriesOf(f)).toEqual([]);
  });

  test("takes the named channels along in the order given", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas" });
    await createChannel(f.db, f.owner.id, f.org.id, { name: "suporte" });
    const secret = await createChannel(f.db, f.owner.id, f.org.id, { name: "diretoria", visibility: "private" });
    const ctx = await runFor(f, f.owner.id, "cria a categoria Livora");
    expect(
      (await call(f, ctx, "create_channel_category", { name: "Livora", channels: ["suporte", "#vendas"] })).content,
    ).toBe('Created the category "Livora" with #suporte, #vendas.');
    const [category] = await categoriesOf(f);
    const inside = (await listChannels(f.db, f.owner.id, f.org.id))
      .filter((c) => c.categoryId === category?.id)
      .map((c) => c.name);
    expect(inside).toEqual(["suporte", "vendas"]);

    // A channel that is not there, or that the person cannot see, is "not there" and nothing is made.
    const other = await runFor(f, bia.id, "cria a categoria Outra");
    const keepers = await createRole(f.db, f.owner.id, f.org.id, { name: "Keepers", permissions: ["manage_channels"] });
    await setMemberRoles(f.db, f.owner.id, f.org.id, bia.id, [keepers.id]);
    expect(await call(f, other, "create_channel_category", { name: "Outra", channels: ["nao-existe"] })).toEqual({
      content: "No channel #nao-existe.",
      isError: true,
    });
    expect(await call(f, other, "create_channel_category", { name: "Outra", channels: ["diretoria"] })).toEqual({
      content: `No channel #${secret.name}.`,
      isError: true,
    });
    expect((await categoriesOf(f)).map((c) => c.name)).toEqual(["Livora"]);
  });

  test("sends the layout broadcast once the category exists", async () => {
    f = await setup();
    const seen: { type?: string; event?: { type?: string } }[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => seen.push(e as never));
    const ctx = await runFor(f, f.owner.id, "cria a categoria Livora");
    await call(f, ctx, "create_channel_category", { name: "Livora" });
    expect(seen.filter((e) => e.event?.type === "channels.layout")).toHaveLength(1);
    // A refusal says nothing to anyone.
    seen.length = 0;
    await call(f, ctx, "create_channel_category", { name: "Livora" });
    expect(seen).toEqual([]);
  });

  test(`refuses the fourth category of a run`, async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria quatro categorias");
    for (let i = 0; i < MAX_CATEGORIES_PER_RUN; i++) {
      expect((await call(f, ctx, "create_channel_category", { name: `Cat ${i}` })).isError).toBeUndefined();
    }
    expect(await call(f, ctx, "create_channel_category", { name: "Cat extra" })).toEqual({
      content: `You already created ${MAX_CATEGORIES_PER_RUN} categories in this turn.`,
      isError: true,
    });
    expect(MAX_CATEGORIES_PER_RUN).toBe(3);
    expect(await categoriesOf(f)).toHaveLength(3);
  });

  test("lists create_channel_category and create_channel's category field in the setup tools", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria uma categoria");
    const granted = await gatewayOf(f).granted(ctx);
    expect(granted.map((t) => t.name)).toContain("create_channel_category");
    const channel = granted.find((t) => t.name === "create_channel");
    const schemaOf = channel?.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schemaOf.properties)).toContain("category");
  });

  test("create_channel_category is elsewhere and a routine's run is refused it", () => {
    const tool = { name: "create_channel_category", scope: SETUP_SCOPE, connectionId: null };
    expect(toolKind(tool).kind).toBe("elsewhere");
    const routine = {
      kind: "routine",
      personId: null,
      brief: {
        routineId: "00000000-0000-4000-8000-000000000001",
        routineRunId: "00000000-0000-4000-8000-000000000002",
        name: "Diária",
        creatorUserId: "user_creator",
        deliverTo: { channelId: "00000000-0000-4000-8000-000000000003", threadId: null },
        access: "act",
        report: "when_new",
        trigger: "schedule",
        dueAt: new Date().toISOString(),
      },
    } as const;
    expect(toolPolicy(routine as never, tool)).toEqual({ action: "refuse", reason: REFUSALS.routineElsewhere });
  });

  test("the descriptions say the person's rights, Undo and a person's request", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria uma categoria");
    const granted = await gatewayOf(f).granted(ctx);
    for (const name of ["create_channel_category", "create_channel"]) {
      const description = granted.find((t) => t.name === name)?.description ?? "";
      expect(description).toContain("person's rights");
      expect(description).toContain("Undo");
      expect(description).toContain("person");
      expect(description).toContain("current message");
    }
  });
});

describe("create_channel with a category", () => {
  const inCategory = async (fx: Fixture, categoryName: string) => {
    const category = (await categoriesOf(fx)).find((c) => c.name === categoryName);
    return (await listChannels(fx.db, fx.owner.id, fx.org.id))
      .filter((c) => c.categoryId === category?.id)
      .map((c) => c.name);
  };

  test("puts the channel at the end of an existing category", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const first = await createChannel(f.db, f.owner.id, f.org.id, { name: "vendas" });
    const second = await createChannel(f.db, f.owner.id, f.org.id, { name: "atendimento" });
    await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Livora", channelIds: [first.id, second.id] });
    // Bia may create channels, not categories: an existing one is hers to use.
    const ctx = await runFor(f, bia.id, "cria o canal suporte na categoria Livora");
    const out = await call(f, ctx, "create_channel", { name: "suporte", category: " livora " });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain('in the category "Livora"');
    expect(await inCategory(f, "Livora")).toEqual(["vendas", "atendimento", "suporte"]);
    expect(await categoriesOf(f)).toHaveLength(1);
  });

  test("makes a missing category first and reports both", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria o canal vendas na categoria Livora");
    const out = await call(f, ctx, "create_channel", { name: "vendas", category: "Livora" });
    expect(out).toMatchObject({
      content: 'Created #vendas in the category "Livora" (made now).',
      data: { channel: { name: "vendas" }, category: { name: "Livora" } },
    });
    expect((await categoriesOf(f)).map((c) => c.name)).toEqual(["Livora"]);
    expect(await inCategory(f, "Livora")).toEqual(["vendas"]);
  });

  test("records one channel.created receipt for the channel and its new category", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria o canal vendas na categoria Livora");
    await call(f, ctx, "create_channel", { name: "vendas", category: "Livora" });
    const rows = await receiptsOf(f, ctx);
    expect(rows).toHaveLength(1);
    const [category] = await categoriesOf(f);
    expect(rows[0]).toMatchObject({
      kind: "channel.created",
      params: { name: "vendas", category: "Livora", categoryCreated: true },
      after: { name: "vendas", categoryId: category?.id, categoryName: "Livora", categoryCreated: true },
    });
  });

  test("without a category it behaves as before", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria o canal vendas");
    expect(await call(f, ctx, "create_channel", { name: "vendas" })).toMatchObject({
      content: "Created #vendas.",
      data: { channel: { name: "vendas" } },
    });
    const rows = await receiptsOf(f, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "channel.created", params: { name: "vendas" }, after: { name: "vendas" } });
    expect(await categoriesOf(f)).toEqual([]);
    expect((await channelNamed(f, "vendas"))?.categoryId).toBeNull();
  });

  test("refuses a new category without manage_channels and creates neither", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const ctx = await runFor(f, bia.id, "cria o canal vendas na categoria Livora");
    expect(await call(f, ctx, "create_channel", { name: "vendas", category: "Livora" })).toEqual({
      content: "You can't create categories: it needs the right to manage channels. Nothing was created.",
      isError: true,
    });
    expect(await categoriesOf(f)).toEqual([]);
    expect(await channelNamed(f, "vendas")).toBeUndefined();
    expect(await receiptsOf(f, ctx)).toEqual([]);
  });

  test("a taken channel name leaves no new category behind", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria o canal general na categoria Livora");
    expect(await call(f, ctx, "create_channel", { name: "general", category: "Livora" })).toMatchObject({
      isError: true,
      content: "Failed: #general already exists",
    });
    expect(await call(f, ctx, "create_channel", { name: "Nome Ruim", category: "Livora" })).toMatchObject({
      isError: true,
    });
    expect(await categoriesOf(f)).toEqual([]);
    expect(await receiptsOf(f, ctx)).toEqual([]);
  });

  test("three channels in turn with the same new category make it once", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria vendas, suporte e financeiro na categoria Livora");
    for (const name of ["vendas", "suporte", "financeiro"])
      expect((await call(f, ctx, "create_channel", { name, category: "Livora" })).isError).toBeUndefined();
    expect((await categoriesOf(f)).map((c) => c.name)).toEqual(["Livora"]);
    expect((await inCategory(f, "Livora")).sort()).toEqual(["financeiro", "suporte", "vendas"]);
    const rows = await receiptsOf(f, ctx);
    expect(rows.map((r) => r.kind)).toEqual(["channel.created", "channel.created", "channel.created"]);
    expect(rows.map((r) => (r.params as { categoryCreated?: boolean }).categoryCreated === true)).toEqual([
      true,
      false,
      false,
    ]);
  });

  test("a category made earlier in the run is reused by create_channel whatever the case", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria a categoria Livora e um canal nela");
    await call(f, ctx, "create_channel_category", { name: "Livora" });
    const out = await call(f, ctx, "create_channel", { name: "vendas", category: "LIVORA" });
    expect(out.isError).toBeUndefined();
    expect((await categoriesOf(f)).map((c) => c.name)).toEqual(["Livora"]);
    expect(await inCategory(f, "Livora")).toEqual(["vendas"]);
    const rows = await receiptsOf(f, ctx);
    expect(rows.map((r) => r.kind)).toEqual(["channel_category.created", "channel.created"]);
    expect(rows[1]?.params).toEqual({ name: "vendas", category: "Livora" });
  });

  test("two parallel calls with the same new category make it once", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria vendas e suporte na categoria Livora");
    const [a, b] = await Promise.all([
      call(f, ctx, "create_channel", { name: "vendas", category: "Livora" }),
      call(f, ctx, "create_channel", { name: "suporte", category: "livora" }),
    ]);
    expect([a.isError, b.isError]).toEqual([undefined, undefined]);
    expect(await categoriesOf(f)).toHaveLength(1);
    expect((await inCategory(f, "Livora")).sort()).toEqual(["suporte", "vendas"]);
    const made = (await receiptsOf(f, ctx)).filter((r) => (r.params as { categoryCreated?: boolean }).categoryCreated);
    expect(made).toHaveLength(1);
  });

  test("sends the layout broadcast after the channel is placed", async () => {
    f = await setup();
    await createChannelCategory(f.db, f.owner.id, f.org.id, { name: "Livora" });
    const placedWhenTold: Promise<string[]>[] = [];
    const told: string[] = [];
    f.pubsub.subscribe(orgTopic(f.org.id), (e) => {
      const event = (e as { event?: { type?: string } }).event;
      if (event?.type === "channels.layout") {
        told.push("layout");
        placedWhenTold.push(
          listChannels(f.db, f.owner.id, f.org.id).then((all) =>
            all.filter((c) => c.categoryId !== null).map((c) => c.name),
          ),
        );
      }
      if (event?.type === "channels.changed") told.push("changed");
    });
    const ctx = await runFor(f, f.owner.id, "cria o canal vendas na categoria Livora");
    await call(f, ctx, "create_channel", { name: "vendas", category: "Livora" });
    expect(told.filter((t) => t === "layout")).toHaveLength(1);
    expect(await Promise.all(placedWhenTold)).toEqual([["vendas"]]);
  });

  test("refuses the fourth new category of a run, creating no channel for it", async () => {
    f = await setup();
    const ctx = await runFor(f, f.owner.id, "cria canais em quatro categorias");
    for (let i = 0; i < MAX_CATEGORIES_PER_RUN; i++)
      expect(
        (await call(f, ctx, "create_channel", { name: `canal-${i}`, category: `Cat ${i}` })).isError,
      ).toBeUndefined();
    expect(await call(f, ctx, "create_channel", { name: "canal-extra", category: "Cat extra" })).toEqual({
      content: `You already created ${MAX_CATEGORIES_PER_RUN} categories in this turn.`,
      isError: true,
    });
    expect(await channelNamed(f, "canal-extra")).toBeUndefined();
    // An existing one is still open to it.
    expect((await call(f, ctx, "create_channel", { name: "canal-4", category: "cat 0" })).isError).toBeUndefined();
  });
});

describe("a consulted agent's cards", () => {
  /** @dev answering a note from @lia in their DM; @lia's run answers the person's message in #general. */
  async function consulted(fx: Fixture, userId: string) {
    const lia = await addLia(fx, fx.owner.id);
    const asked = await insertMessage(fx.db, {
      orgId: fx.org.id,
      channelId: fx.general.id,
      author: { type: "person", userId },
      body: "@lia resume o canal de vendas do Slack",
    });
    const [askerRun] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: lia.id,
        channelId: fx.general.id,
        threadRootId: asked.id,
        triggerMessageId: asked.id,
        trigger: "mention",
        hop: 1,
        status: "running",
      })
      .returning();
    const dm = await openAgentDm(fx.db, fx.org.id, lia.id, fx.agent.id);
    const note = await insertMessage(fx.db, {
      orgId: fx.org.id,
      channelId: dm.id,
      author: { type: "agent", agentId: lia.id, runId: askerRun?.id ?? "", hop: 1 },
      body: "Resume o canal de vendas do Slack.",
    });
    const [run] = await fx.db
      .insert(schema.agentRuns)
      .values({
        orgId: fx.org.id,
        agentId: fx.agent.id,
        channelId: dm.id,
        threadRootId: note.id,
        triggerMessageId: note.id,
        trigger: "dm",
        hop: 2,
        status: "running",
      })
      .returning();
    if (!askerRun || !run) throw new Error("no runs");
    const ctx: ToolContext = {
      db: fx.db,
      orgId: fx.org.id,
      agentId: fx.agent.id,
      runId: run.id,
      channelId: dm.id,
      threadRootId: note.id,
      triggerMessageId: note.id,
    };
    const ask = () =>
      fx.db.insert(schema.agentConsultations).values({
        orgId: fx.org.id,
        askerRunId: askerRun.id,
        askerAgentId: lia.id,
        targetAgentId: fx.agent.id,
        channelId: dm.id,
        messageId: note.id,
        targetRunId: run.id,
        waitId: `async:${crypto.randomUUID()}`,
        question: note.body,
        kind: "note",
        chain: [lia.id],
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });
    return { ctx, dm, ask };
  }

  test("go where the person asked, never into the agents' DM; with nobody behind it, nothing is posted", async () => {
    f = await setup();
    const { ctx, dm, ask } = await consulted(f, f.owner.id);
    // A note that isn't a row (nobody to trace it to): the card would reach nobody.
    const lost = await call(f, ctx, "offer_connect_app", { app: "linear", why: "Para ler as tarefas." });
    expect(lost).toMatchObject({
      isError: true,
      content: expect.stringContaining("No person reads this conversation"),
    });
    expect(await cards(f)).toEqual([]);
    await ask();
    for (const [name, input] of [
      ["offer_connect_app", { app: "linear", why: "Para ler as tarefas." }],
      ["offer_connect_ai", { what: "claude", why: "Para pensar com o seu plano." }],
      ["offer_invites", { emails: ["bia@example.com"], why: "Ela cuida das vendas." }],
    ] as const) {
      expect((await call(f, ctx, name, input)).isError).toBeUndefined();
    }
    const posted = await cards(f);
    expect(posted).toHaveLength(3);
    for (const card of posted)
      expect({ channelId: card.channelId, threadId: card.threadId }).toEqual({
        channelId: f.general.id,
        threadId: null,
      });
    expect(posted.some((m) => m.channelId === dm.id)).toBe(false);
  });

  test("who may act is read where the card goes: a member's request in a public channel reaches an admin there", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const { ctx, ask } = await consulted(f, bia.id);
    await ask();
    const out = await call(f, ctx, "offer_connect_app", { app: "linear", why: "Para ler as tarefas." });
    expect(out.isError).toBeUndefined();
    expect(out.content).toContain("can't connect apps: an admin here does it from the card");
    expect((await cards(f)).map((m) => m.channelId)).toEqual([f.general.id]);
  });
});
