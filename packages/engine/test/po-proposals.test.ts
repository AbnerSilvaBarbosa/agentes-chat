import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  applyColumnTemplate,
  boardColumnsOf,
  confirmCardProposal,
  createIssue,
  createIssueProject,
  createIssueSpace,
  createIssueToolSource,
  dismissCardProposal,
  ForbiddenError,
  grantScopes,
  insertMessage,
  listColumnTemplates,
  listIssueColumns,
  listIssues,
  openPoChat,
  type PoDeps,
  proposeCard,
  updateIssueProject,
} from "../src";
import { REFUSALS, toolPolicy } from "../src/tools/run-policy";
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

const proposalRow = async (id: string) => {
  const [row] = await f.db.select().from(schema.poCardProposals).where(eq(schema.poCardProposals.id, id));
  if (!row) throw new Error("no proposal");
  return row;
};

describe("a person confirms or discards a proposal", () => {
  test("confirm creates the card in Especificar as the person", async () => {
    f = await setup();
    const { deps, board, ctx } = await poRun(f);
    const sets = await listColumnTemplates(f.db, f.owner.id, f.org.id);
    const dev = sets.find((s) => s.name === "Desenvolvimento");
    if (!dev) throw new Error("missing seeded set");
    await applyColumnTemplate(deps, f.owner.id, f.org.id, board.id, dev.id);
    const proposal = await proposeCard(deps, ctx, {
      title: "Tela de login",
      summary: "Entrar com e-mail",
      criteria: ["Mostra erro"],
      board: "Entregas",
    });

    const view = await confirmCardProposal(deps, f.owner.id, f.org.id, proposal.id);
    expect(view.status).toBe("confirmed");
    const [issue] = await f.db.select().from(schema.issues);
    expect(await f.db.select().from(schema.issues)).toHaveLength(1);
    expect(view.issue).toEqual({ id: issue?.id as string, number: issue?.number as number });
    const columns = await listIssueColumns(f.db, f.owner.id, f.org.id, board.id);
    const especificar = columns.find((c) => c.name === "Especificar");
    expect(issue?.columnId).toBe(especificar?.id);
    expect(issue?.status).toBe("todo");
    expect(issue?.createdByType).toBe("person");
    expect(issue?.createdById).toBe(f.owner.id);
    expect(issue?.title).toBe("Tela de login");
    expect(issue?.description).toBe("Entrar com e-mail");
    expect((issue?.criteria ?? []).map((c) => c.text)).toEqual(["Mostra erro"]);
    expect(issue?.projectId).toBe(board.id);
    // The card message in the chat shows the same snapshot.
    const [card] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, (await proposalRow(proposal.id)).messageId as string));
    expect(card?.meta).toMatchObject({ cardProposal: { status: "confirmed", issue: { number: issue?.number } } });
  });

  test("a board with no Especificar column takes the card in its first todo column", async () => {
    f = await setup();
    const { deps, ctx } = await poRun(f);
    const proposal = await proposeCard(deps, ctx, { title: "Sem coluna propria", board: "Entregas" });
    await confirmCardProposal(deps, f.owner.id, f.org.id, proposal.id);
    const [issue] = await f.db.select().from(schema.issues);
    const first = (await boardColumnsOf(f.db, f.org.id, proposal.project.id)).find((c) => c.stage === "todo");
    expect(first).toBeDefined();
    expect(issue?.columnId).toBe(first?.id);
    expect(issue?.status).toBe("todo");
  });

  test("confirm with edited fields creates the edited card", async () => {
    f = await setup();
    const { deps, company, ctx } = await poRun(f);
    const other = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Backlog geral", spaceId: company.id });
    const proposal = await proposeCard(deps, ctx, {
      title: "Original",
      summary: "Resumo original",
      criteria: ["a", "b"],
      board: "Entregas",
    });
    const view = await confirmCardProposal(deps, f.owner.id, f.org.id, proposal.id, {
      title: "  Editado ",
      summary: "Resumo novo",
      criteria: ["so um"],
      projectId: other.id,
    });
    const [issue] = await f.db.select().from(schema.issues);
    expect(issue?.title).toBe("Editado");
    expect(issue?.description).toBe("Resumo novo");
    expect((issue?.criteria ?? []).map((c) => c.text)).toEqual(["so um"]);
    expect(issue?.projectId).toBe(other.id);
    // The snapshot shows what was created, not what was proposed.
    expect(view).toMatchObject({
      title: "Editado",
      summary: "Resumo novo",
      criteria: ["so um"],
      project: { id: other.id, name: "Backlog geral" },
      status: "confirmed",
    });
  });

  test("dismiss creates nothing", async () => {
    f = await setup();
    const { deps, ctx } = await poRun(f);
    const proposal = await proposeCard(deps, ctx, { title: "Nao", board: "Entregas" });
    const view = await dismissCardProposal(deps, f.owner.id, f.org.id, proposal.id);
    expect(view.status).toBe("dismissed");
    expect(view.issue).toBeNull();
    expect(await f.db.select().from(schema.issues)).toHaveLength(0);
    const [card] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, (await proposalRow(proposal.id)).messageId as string));
    expect(card?.meta).toMatchObject({ cardProposal: { status: "dismissed" } });
  });

  test("a decided proposal refuses a second decision", async () => {
    f = await setup();
    const { deps, ctx } = await poRun(f);
    const created = await proposeCard(deps, ctx, { title: "Um", board: "Entregas" });
    const discarded = await proposeCard(deps, ctx, { title: "Dois", board: "Entregas" });
    await confirmCardProposal(deps, f.owner.id, f.org.id, created.id);
    await dismissCardProposal(deps, f.owner.id, f.org.id, discarded.id);
    const refusal = { code: "card_proposal.decided" };
    await expect(confirmCardProposal(deps, f.owner.id, f.org.id, created.id)).rejects.toMatchObject(refusal);
    await expect(dismissCardProposal(deps, f.owner.id, f.org.id, created.id)).rejects.toMatchObject(refusal);
    await expect(confirmCardProposal(deps, f.owner.id, f.org.id, discarded.id)).rejects.toMatchObject(refusal);
    await expect(dismissCardProposal(deps, f.owner.id, f.org.id, discarded.id)).rejects.toMatchObject(refusal);
    // Still one card, and the dismissed one stayed dismissed.
    expect(await f.db.select().from(schema.issues)).toHaveLength(1);
    expect((await proposalRow(discarded.id)).status).toBe("dismissed");
  });

  test("two confirms at once create one card", async () => {
    f = await setup();
    const { deps, ctx } = await poRun(f);
    const proposal = await proposeCard(deps, ctx, { title: "Duplo clique", board: "Entregas" });
    const results = await Promise.allSettled([
      confirmCardProposal(deps, f.owner.id, f.org.id, proposal.id),
      confirmCardProposal(deps, f.owner.id, f.org.id, proposal.id),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await f.db.select().from(schema.issues)).toHaveLength(1);
  });

  test("an archived board refuses and the proposal stays pending", async () => {
    f = await setup();
    const { deps, board, ctx } = await poRun(f);
    const proposal = await proposeCard(deps, ctx, { title: "Tarde demais", board: "Entregas" });
    await updateIssueProject(deps, f.owner.id, f.org.id, board.id, { archived: true });
    await expect(confirmCardProposal(deps, f.owner.id, f.org.id, proposal.id)).rejects.toThrow();
    expect(await f.db.select().from(schema.issues)).toHaveLength(0);
    expect((await proposalRow(proposal.id)).status).toBe("pending");
    // The person picks another board with Editar and the same proposal then goes through.
    const other = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Outra", spaceId: proposal.spaceId });
    const view = await confirmCardProposal(deps, f.owner.id, f.org.id, proposal.id, { projectId: other.id });
    expect(view.status).toBe("confirmed");
    expect(await f.db.select().from(schema.issues)).toHaveLength(1);
  });

  test("a member without the right to post is refused and nothing is created", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const { deps, ctx } = await poRun(f, bia.id);
    const proposal = await proposeCard(deps, ctx, { title: "Sem direito", board: "Entregas" });
    // Takes `post` away from every member (the `everyone` role's base).
    await f.db
      .update(schema.orgRoles)
      .set({ permissions: [] })
      .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
    await expect(confirmCardProposal(deps, bia.id, f.org.id, proposal.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await f.db.select().from(schema.issues)).toHaveLength(0);
    expect((await proposalRow(proposal.id)).status).toBe("pending");
  });

  test("only the requester decides, and a creating row older than two minutes can be claimed again", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    const { deps, ctx } = await poRun(f);
    const proposal = await proposeCard(deps, ctx, { title: "So dele", board: "Entregas" });
    // Another member and an administrator who is not the requester are both refused.
    await expect(confirmCardProposal(deps, bia.id, f.org.id, proposal.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(dismissCardProposal(deps, bia.id, f.org.id, proposal.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await proposalRow(proposal.id)).status).toBe("pending");

    // A confirm that crashed after the claim: fresh, it blocks; older than two minutes, it is claimable.
    await f.db
      .update(schema.poCardProposals)
      .set({ status: "creating", decidedAt: new Date() })
      .where(eq(schema.poCardProposals.id, proposal.id));
    await expect(confirmCardProposal(deps, f.owner.id, f.org.id, proposal.id)).rejects.toMatchObject({
      code: "card_proposal.decided",
    });
    await f.db
      .update(schema.poCardProposals)
      .set({ decidedAt: new Date(Date.now() - 3 * 60_000) })
      .where(eq(schema.poCardProposals.id, proposal.id));
    const view = await confirmCardProposal(deps, f.owner.id, f.org.id, proposal.id);
    expect(view.status).toBe("confirmed");
    expect(await f.db.select().from(schema.issues)).toHaveLength(1);
  });
});

describe("the propose_card tool", () => {
  test("propose_card posts a card with title, summary, criteria and board", async () => {
    f = await setup();
    const { ctx, chat } = await poRun(f);
    await grantScopes(f.db, f.org.id, f.agent.id, [{ connectionId: null, scope: "issues:write" }]);
    const tool = (await createIssueToolSource(f.artifactDeps).tools({ db: f.db, ...ctx })).find(
      (t) => t.name === "propose_card",
    );
    const out = await tool?.execute(
      {
        title: "Tela de login",
        summary: "Entrar com e-mail e senha",
        criteria: ["Mostra erro de senha", "Lembra o e-mail"],
        board: "Entregas",
      },
      { db: f.db, ...ctx },
    );
    expect(out?.isError).toBeUndefined();
    expect(out?.content).toContain("waits for the person's confirmation");
    expect(out?.content).toContain("never say the card exists");
    const [row] = await f.db.select().from(schema.poCardProposals);
    expect(row).toMatchObject({
      title: "Tela de login",
      summary: "Entrar com e-mail e senha",
      criteria: ["Mostra erro de senha", "Lembra o e-mail"],
      status: "pending",
      channelId: chat.channelId,
    });
    const [card] = await f.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, row?.messageId as string));
    expect(card?.meta).toMatchObject({
      cardProposal: {
        title: "Tela de login",
        project: { name: "Entregas" },
        criteria: ["Mostra erro de senha", "Lembra o e-mail"],
      },
    });
    expect(await allIssues(f)).toHaveLength(0);
  });
});

describe("who may propose a card", () => {
  const tool = { name: "propose_card", scope: "issues:write", connectionId: null };
  const brief = {
    routineId: "00000000-0000-4000-8000-000000000001",
    routineRunId: "00000000-0000-4000-8000-000000000002",
    name: "Pedidos do dia",
    creatorUserId: "user_creator",
    deliverTo: { channelId: "00000000-0000-4000-8000-000000000003", threadId: null },
    access: "act" as const,
    report: "when_new" as const,
    trigger: "schedule" as const,
    dueAt: new Date().toISOString(),
  };

  test("propose_card is refused to a routine and allowed to a person's run", () => {
    for (const access of ["read", "act"] as const) {
      expect(toolPolicy({ kind: "routine", personId: null, brief: { ...brief, access } }, tool)).toEqual({
        action: "refuse",
        reason: REFUSALS.routineElsewhere,
      });
    }
    // A run a routine's report or work woke keeps the routine's bounds.
    for (const reason of ["routine_report", "routine"] as const) {
      expect(toolPolicy({ kind: "unattended", personId: null, reason, brief }, tool)).toEqual({
        action: "refuse",
        reason: REFUSALS.fedElsewhere,
      });
    }
    expect(toolPolicy({ kind: "person", personId: "user_ana" }, tool)).toEqual({ action: "allow" });
  });

  test("an agent set to always ask adds no approval before a card that is itself the question", () => {
    expect(toolPolicy({ kind: "person", personId: "user_ana" }, tool, "always")).toEqual({ action: "allow" });
    // Another tool that writes in the same scope does ask at this level: the exemption is the proposal's own.
    expect(
      toolPolicy(
        { kind: "person", personId: "user_ana" },
        { name: "create_issue", scope: "issues:write", connectionId: null },
        "always",
      ),
    ).toEqual({ action: "approve" });
  });

  test("a card is never proposed without a person's own request, whoever runs it", async () => {
    f = await setup();
    const { deps, ctx } = await poRun(f);
    const own = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: ctx.channelId,
      author: { type: "agent", agentId: f.agent.id, runId: ctx.runId, hop: 1 },
      body: "on its own",
    });
    await expect(
      proposeCard(deps, { ...ctx, triggerMessageId: own.id }, { title: "Sozinho", board: "Entregas" }),
    ).rejects.toThrow();
    expect(await f.db.select().from(schema.poCardProposals)).toHaveLength(0);
  });
});
