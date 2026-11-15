import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  createIssue,
  createIssueProject,
  createIssueSpace,
  insertMessage,
  listIssues,
  openPoChat,
  type PoDeps,
  proposeCard,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });

/**
 * A workspace whose PO is the fixture's agent, a company "Acme" with a board "Entregas", and a run of the PO in the
 * owner's PO chat of that company, triggered by the owner's own message (what `propose_card` needs).
 */
async function poRun(fixture: Fixture, userId = fixture.owner.id) {
  const deps: PoDeps = { db: fixture.db, pubsub: fixture.pubsub };
  await fixture.db
    .insert(schema.organizationSettings)
    .values({ orgId: fixture.org.id, poAgentId: fixture.agent.id })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { poAgentId: fixture.agent.id } });
  const company = await createIssueSpace(deps, fixture.owner.id, fixture.org.id, { name: "Acme" });
  const board = await createIssueProject(deps, fixture.owner.id, fixture.org.id, {
    name: "Entregas",
    spaceId: company.id,
  });
  const chat = await openPoChat(fixture.db, userId, fixture.org.id, company.id);
  const trigger = await insertMessage(fixture.db, {
    orgId: fixture.org.id,
    channelId: chat.channelId,
    author: { type: "person", userId },
    body: "Precisamos de uma tela de login",
  });
  const [run] = await fixture.db
    .insert(schema.agentRuns)
    .values({
      orgId: fixture.org.id,
      agentId: fixture.agent.id,
      channelId: chat.channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  const ctx = {
    orgId: fixture.org.id,
    agentId: fixture.agent.id,
    runId: run.id,
    channelId: chat.channelId,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
  return { deps, company, board, chat, ctx, trigger };
}

const allIssues = (fixture: Fixture) => listIssues(fixture.db, person(fixture.owner.id), fixture.org.id, {});

describe("a PO proposes a card in its chat", () => {
  test("proposeCard writes the row and the card in the chat, for the person who asked", async () => {
    f = await setup();
    const { deps, board, chat, ctx } = await poRun(f);
    const view = await proposeCard(deps, ctx, {
      title: "  Tela de login  ",
      summary: "Entrar com e-mail e senha",
      criteria: ["Mostra erro de senha", "  ", "Lembra o e-mail"],
      board: "entregas",
    });
    expect(view).toMatchObject({
      agentId: f.agent.id,
      requesterUserId: f.owner.id,
      title: "Tela de login",
      summary: "Entrar com e-mail e senha",
      criteria: ["Mostra erro de senha", "Lembra o e-mail"],
      project: { id: board.id, name: "Entregas" },
      status: "pending",
      duplicateOf: null,
      issue: null,
      spec: null,
    });
    const [row] = await f.db.select().from(schema.poCardProposals).where(eq(schema.poCardProposals.id, view.id));
    expect(row?.status).toBe("pending");
    expect(row?.channelId).toBe(chat.channelId);
    const [card] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, row?.messageId as string));
    expect(card?.channelId).toBe(chat.channelId);
    expect(card?.authorAgentId).toBe(f.agent.id);
    expect(card?.meta).toMatchObject({ cardProposalId: view.id, cardProposal: { title: "Tela de login" } });
  });

  test("a proposed card is not an issue until confirmed", async () => {
    f = await setup();
    const { deps, ctx } = await poRun(f);
    expect(await allIssues(f)).toHaveLength(0);
    await proposeCard(deps, ctx, { title: "Tela de login", board: "Entregas" });
    expect(await allIssues(f)).toHaveLength(0);
    const rows = await f.db.select().from(schema.issues);
    expect(rows).toHaveLength(0);
  });

  test("several proposals wait at once and none is a card", async () => {
    f = await setup();
    const { deps, ctx, chat } = await poRun(f);
    const a = await proposeCard(deps, ctx, { title: "Login", board: "Entregas" });
    const b = await proposeCard(deps, ctx, { title: "Cadastro", board: "Entregas" });
    const c = await proposeCard(deps, ctx, { title: "Recuperar senha", board: "Entregas" });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    const waiting = await f.db
      .select()
      .from(schema.poCardProposals)
      .where(eq(schema.poCardProposals.channelId, chat.channelId));
    expect(waiting.map((p) => p.status)).toEqual(["pending", "pending", "pending"]);
    const cards = (
      await f.db.select().from(schema.messages).where(eq(schema.messages.channelId, chat.channelId))
    ).filter((m) => m.meta && "cardProposalId" in (m.meta as object));
    expect(cards).toHaveLength(3);
    expect(await allIssues(f)).toHaveLength(0);
  });

  test("a proposal repeating an open card's title carries a notice naming it", async () => {
    f = await setup();
    const { deps, board, ctx } = await poRun(f);
    const open = await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Tela de Login",
      projectId: board.id,
    });
    const done = await createIssue(deps, person(f.owner.id), f.org.id, { title: "Cadastro", projectId: board.id });
    await f.db.update(schema.issues).set({ status: "done" }).where(eq(schema.issues.id, done.id));

    const dup = await proposeCard(deps, ctx, { title: "tela de login", board: "Entregas" });
    expect(dup.duplicateOf).toEqual({ number: open.number, title: "Tela de Login" });
    // A finished card does not count, and a different title carries no notice.
    expect((await proposeCard(deps, ctx, { title: "Cadastro", board: "Entregas" })).duplicateOf).toBeNull();
    expect((await proposeCard(deps, ctx, { title: "Outra coisa", board: "Entregas" })).duplicateOf).toBeNull();
  });

  test("a card the requester cannot see is never named as the duplicate", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const { deps, board, ctx } = await poRun(f, bia.id);
    await createIssue(deps, person(f.owner.id), f.org.id, {
      title: "Folha de pagamento",
      projectId: board.id,
      audience: { mode: "people", userIds: [f.owner.id] },
    });
    const view = await proposeCard(deps, ctx, { title: "Folha de pagamento", board: "Entregas" });
    expect(view.duplicateOf).toBeNull();
    expect(view.requesterUserId).toBe(bia.id);
  });

  test("it needs a person's message and a PO chat, and a live board of the company", async () => {
    f = await setup();
    const { deps, ctx, trigger } = await poRun(f);
    // Outside a PO chat (the general channel): refused.
    await expect(
      proposeCard(deps, { ...ctx, channelId: f.general.id }, { title: "Login", board: "Entregas" }),
    ).rejects.toThrow();
    // A trigger that is not a person's message: refused.
    const bot = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: ctx.channelId,
      author: { type: "agent", agentId: f.agent.id, runId: ctx.runId, hop: 1 },
      body: "automatic",
    });
    await expect(
      proposeCard(deps, { ...ctx, triggerMessageId: bot.id }, { title: "Login", board: "Entregas" }),
    ).rejects.toThrow();
    // A board of another company, or one that does not exist: refused.
    const other = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Beta" });
    await createIssueProject(deps, f.owner.id, f.org.id, { name: "Loja", spaceId: other.id });
    await expect(proposeCard(deps, ctx, { title: "Login", board: "Loja" })).rejects.toThrow();
    await expect(proposeCard(deps, ctx, { title: "Login", board: "Nao existe" })).rejects.toThrow();
    // An empty title and thirty-one criteria are refused.
    await expect(proposeCard(deps, ctx, { title: "  ", board: "Entregas" })).rejects.toThrow();
    await expect(
      proposeCard(deps, ctx, {
        title: "Login",
        board: "Entregas",
        criteria: Array.from({ length: 31 }, (_, i) => `c${i}`),
      }),
    ).rejects.toThrow();
    expect(trigger.id).toBeDefined();
    expect(await f.db.select().from(schema.poCardProposals)).toHaveLength(0);
  });
});
