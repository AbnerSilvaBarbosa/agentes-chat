import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, type Executor, eq, isNull, lt, or, schema, sql } from "@agenteschat/db";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { projectByName } from "./issue-projects";
import { createIssue } from "./issues";
import { insertMessage, messageView } from "./messages";
import { requireActiveMembership } from "./organizations";
import { poScopeOf } from "./po-chat";
import { specColumns } from "./po-columns";
import { pumpSpecs } from "./po-specs";
import { bodyCode } from "./run-tools";
import { replyThreadOf } from "./runs";
import { taskSeenSql } from "./task-access";

const { issues, issueProjects, messages, poCardProposals, wikiPages } = schema;

export type ProposalRow = typeof poCardProposals.$inferSelect;

export interface PoDeps {
  db: Database;
  pubsub?: PubSub;
}

/** The most criteria a proposal holds, and the longest one (the card's own limits, `createIssue`). */
export const PROPOSAL_LIMITS = { title: 300, summary: 20_000, criteria: 30, criterion: 500 };

/**
 * A PO's proposed card as the chat shows it (ADR 0185), kept in the card message's `meta.cardProposal` and rewritten by
 * `syncProposalCard`. `creating` (a confirm in flight) shows as `pending`.
 */
export interface CardProposalView {
  id: string;
  agentId: string;
  requesterUserId: string;
  spaceId: string;
  title: string;
  summary: string;
  criteria: string[];
  project: { id: string; name: string };
  status: "pending" | "confirmed" | "dismissed";
  duplicateOf: { number: number; title: string } | null;
  issue: { id: string; number: number } | null;
  spec: {
    state: "queued" | "running" | "done" | "failed" | "stopped";
    page: { slug: string; title: string } | null;
    error: string | null;
  } | null;
}

/** A proposal's text fields as they are stored: trimmed, within the card's limits, blank criteria dropped. */
export function cleanProposal(input: { title: string; summary?: string; criteria?: string[] }) {
  const title = input.title.trim();
  if (!title) throw new ValidationError("title is required");
  if (title.length > PROPOSAL_LIMITS.title)
    throw new ValidationError(`title is at most ${PROPOSAL_LIMITS.title} characters`);
  const summary = (input.summary ?? "").trim();
  if (summary.length > PROPOSAL_LIMITS.summary)
    throw new ValidationError(`summary is at most ${PROPOSAL_LIMITS.summary} characters`);
  const criteria = (input.criteria ?? []).map((c) => c.trim()).filter(Boolean);
  if (criteria.length > PROPOSAL_LIMITS.criteria)
    throw new ValidationError(`at most ${PROPOSAL_LIMITS.criteria} criteria`);
  if (criteria.some((c) => c.length > PROPOSAL_LIMITS.criterion))
    throw new ValidationError(`a criterion is at most ${PROPOSAL_LIMITS.criterion} characters`);
  return { title, summary, criteria };
}

/** The wiki page a card links as its spec; none when unlinked, trashed or limited to some people (never its title). */
async function specPageOf(db: Executor, issueId: string | null) {
  if (!issueId) return null;
  const [page] = await db
    .select({ slug: wikiPages.slug, title: wikiPages.title })
    .from(issues)
    .innerJoin(wikiPages, eq(wikiPages.id, issues.specPageId))
    .where(and(eq(issues.id, issueId), isNull(wikiPages.deletedAt), eq(wikiPages.restricted, false)));
  return page ?? null;
}

/** The proposal as the chat shows it: the board's and the duplicate's names and the card's number are read now. */
export async function cardProposalView(db: Executor, row: ProposalRow): Promise<CardProposalView> {
  const [project] = await db
    .select({ id: issueProjects.id, name: issueProjects.name })
    .from(issueProjects)
    .where(eq(issueProjects.id, row.projectId));
  const lookup = async (id: string | null) => {
    if (!id) return null;
    const [i] = await db
      .select({ id: issues.id, number: issues.number, title: issues.title })
      .from(issues)
      .where(eq(issues.id, id));
    return i ?? null;
  };
  const [duplicate, created] = await Promise.all([lookup(row.duplicateOfIssueId), lookup(row.issueId)]);
  return {
    id: row.id,
    agentId: row.agentId,
    requesterUserId: row.requesterUserId,
    spaceId: row.spaceId,
    title: row.title,
    summary: row.summary,
    criteria: row.criteria,
    project: project ?? { id: row.projectId, name: "" },
    status: row.status === "creating" ? "pending" : (row.status as "pending" | "confirmed" | "dismissed"),
    duplicateOf: duplicate ? { number: duplicate.number, title: duplicate.title } : null,
    issue: created ? { id: created.id, number: created.number } : null,
    // The state follows the spec run (queued, running, done...); the page joins when a spec is attached.
    spec: row.specState
      ? {
          state: row.specState as NonNullable<CardProposalView["spec"]>["state"],
          page: await specPageOf(db, row.issueId),
          error: row.specError,
        }
      : null,
  };
}

/**
 * The proposal's card in its conversation follows its decision, at once for who has it open: the one writer of
 * `meta.cardProposal`, called by every step that changes the proposal.
 */
export async function syncProposalCard(deps: PoDeps, row: ProposalRow): Promise<CardProposalView> {
  const view = await cardProposalView(deps.db, row);
  if (!row.messageId) return view;
  const [card] = await deps.db
    .update(messages)
    .set({ meta: sql`jsonb_set(${messages.meta}, '{cardProposal}', ${JSON.stringify(view)}::jsonb)` })
    .where(and(eq(messages.id, row.messageId), eq(messages.orgId, row.orgId)))
    .returning({ channelId: messages.channelId, threadId: messages.threadId });
  if (card)
    await publishChannelEvent(deps.pubsub, {
      type: "card.proposal.updated",
      channelId: card.channelId,
      threadId: card.threadId,
      messageId: row.messageId,
      proposal: view,
    });
  return view;
}

/**
 * The PO proposes a card in a PO chat (ADR 0185). Nothing is created: a row waits and a card in the conversation lets
 * the person who asked confirm, edit or discard it. Several proposals can wait in one chat. A title equal to an open
 * card of the company that the requester sees is named on the card, never one they cannot see.
 */
export async function proposeCard(
  deps: PoDeps,
  run: {
    orgId: string;
    agentId: string;
    runId: string;
    channelId: string;
    threadRootId: string;
    triggerMessageId: string;
  },
  input: { title: string; summary?: string; criteria?: string[]; board: string },
): Promise<CardProposalView> {
  const { db } = deps;
  const scope = await poScopeOf(db, run.orgId, run.channelId);
  if (!scope) throw new ValidationError("A card is proposed in a PO chat only");
  const [trigger] = await db
    .select({ userId: messages.authorUserId })
    .from(messages)
    .where(and(eq(messages.id, run.triggerMessageId), eq(messages.orgId, run.orgId)));
  if (!trigger?.userId) throw new ValidationError("Only a person's request can lead to a card proposal");
  const requester = trigger.userId;
  const fields = cleanProposal(input);
  // One live board of this company: an archived, foreign or unknown name is refused with the names that exist.
  const board = await projectByName(deps, run.orgId, input.board, "task", scope.spaceId);
  if (board.spaceId !== scope.spaceId) throw new ValidationError(`That board is not in ${scope.name}`);

  const [duplicate] = await db
    .select({ id: issues.id })
    .from(issues)
    .innerJoin(issueProjects, eq(issueProjects.id, issues.projectId))
    .where(
      and(
        eq(issues.orgId, run.orgId),
        eq(issueProjects.spaceId, scope.spaceId),
        sql`${issues.status} not in ('done', 'canceled')`,
        sql`lower(${issues.title}) = lower(${fields.title})`,
        taskSeenSql("issues", sql`${requester}::text`),
      ),
    )
    .limit(1);

  const made = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(poCardProposals)
      .values({
        orgId: run.orgId,
        agentId: run.agentId,
        runId: run.runId,
        requesterUserId: requester,
        channelId: run.channelId,
        spaceId: scope.spaceId,
        projectId: board.id,
        ...fields,
        duplicateOfIssueId: duplicate?.id ?? null,
      })
      .returning();
    if (!row) throw new Error("proposal insert returned nothing");
    const view = await cardProposalView(tx, row);
    const card = await insertMessage(tx, {
      orgId: run.orgId,
      channelId: run.channelId,
      threadId: replyThreadOf(run),
      author: { type: "agent", agentId: run.agentId, runId: run.runId, hop: 1 },
      body: `Card proposal: ${row.title}`,
      meta: { cardProposalId: row.id, cardProposal: view, ...bodyCode("card_proposal", { title: row.title }) },
    });
    const [linked] = await tx
      .update(poCardProposals)
      .set({ messageId: card.id })
      .where(eq(poCardProposals.id, row.id))
      .returning();
    return { row: linked ?? row, card, view };
  });
  if (deps.pubsub) await publishMessageCreated(deps.pubsub, messageView(made.card));
  return made.view;
}

/** What a person may change on a proposal before creating it. */
export interface ProposalEdits {
  title?: string;
  summary?: string;
  criteria?: string[];
  projectId?: string;
}

/** A confirm that began this long ago and never finished (a crash after the claim) can be claimed again. */
const STALE_CLAIM = sql`now() - interval '2 minutes'`;

const decided = () => new ValidationError("This proposal was already decided", "card_proposal.decided");

async function ownProposal(db: Database, userId: string, orgId: string, id: string): Promise<ProposalRow> {
  const [row] = await db
    .select()
    .from(poCardProposals)
    .where(and(eq(poCardProposals.id, id), eq(poCardProposals.orgId, orgId)));
  if (!row) throw new NotFoundError("Proposal not found");
  await requireActiveMembership(db, userId, orgId);
  // The chat is the person's own DM: only who asked decides, administrators included.
  if (row.requesterUserId !== userId) throw new ForbiddenError("Only the person who asked can decide this");
  return row;
}

/**
 * The person who asked confirms: the card is created as them, in the board's "Especificar" column (ADR 0185), with the
 * edits they made. One conditional update claims the proposal, so a second Criar, a Descartar or two Criar at once find
 * no row and are refused (`card_proposal.decided`): one card at most. The card's own refusal (no right to post, an
 * archived board) puts the claim back and the proposal stays pending, so another board can be picked.
 */
export async function confirmCardProposal(
  deps: PoDeps,
  userId: string,
  orgId: string,
  id: string,
  edits: ProposalEdits = {},
): Promise<CardProposalView> {
  const { db } = deps;
  const current = await ownProposal(db, userId, orgId, id);
  // The same refusal as opening the chat: an archived company takes no new card, and the proposal stays pending.
  const [space] = await db
    .select({ archivedAt: schema.issueSpaces.archivedAt })
    .from(schema.issueSpaces)
    .where(and(eq(schema.issueSpaces.id, current.spaceId), eq(schema.issueSpaces.orgId, orgId)));
  if (!space) throw new NotFoundError("Company not found");
  if (space.archivedAt) throw new ValidationError("That company is archived", "issue_space.archived");
  const fields = cleanProposal({
    title: edits.title ?? current.title,
    summary: edits.summary ?? current.summary,
    criteria: edits.criteria ?? current.criteria,
  });
  if (edits.projectId && edits.projectId !== current.projectId) {
    const [board] = await db
      .select({ id: issueProjects.id })
      .from(issueProjects)
      .where(
        and(
          eq(issueProjects.id, edits.projectId),
          eq(issueProjects.orgId, orgId),
          eq(issueProjects.spaceId, current.spaceId),
        ),
      );
    if (!board) throw new ValidationError("That board is not in this company");
  }
  const [claimed] = await db
    .update(poCardProposals)
    .set({
      status: "creating",
      decidedByUserId: userId,
      decidedAt: sql`now()`,
      ...fields,
      ...(edits.projectId ? { projectId: edits.projectId } : {}),
    })
    .where(
      and(
        eq(poCardProposals.id, id),
        eq(poCardProposals.orgId, orgId),
        or(
          eq(poCardProposals.status, "pending"),
          and(eq(poCardProposals.status, "creating"), lt(poCardProposals.decidedAt, STALE_CLAIM)),
        ),
      ),
    )
    .returning();
  if (!claimed) throw decided();
  let done: ProposalRow | undefined;
  try {
    const { specify } = await specColumns(db, orgId, claimed.projectId);
    // The card carries its proposal's id: a claim taken again after a stall (the card written, the mark not) finds
    // the card it already made and links it, never a second one.
    const [made] = await db
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.orgId, orgId), sql`${issues.source}->>'proposalId' = ${id}`))
      .limit(1);
    const issue =
      made ??
      (await createIssue(deps, { type: "person", userId }, orgId, {
        title: claimed.title,
        description: claimed.summary,
        criteria: claimed.criteria,
        projectId: claimed.projectId,
        columnId: specify.id,
        source: { type: "manual", proposalId: id },
      }));
    // Confirmed and queued for its spec in one write: the spec starts at once when the company has a slot.
    [done] = await db
      .update(poCardProposals)
      .set({ status: "confirmed", issueId: issue.id, specState: "queued", specQueuedAt: sql`now()`, specError: null })
      .where(and(eq(poCardProposals.id, id), eq(poCardProposals.status, "creating")))
      .returning();
  } catch (error) {
    const [back] = await db
      .update(poCardProposals)
      .set({ status: "pending" })
      .where(and(eq(poCardProposals.id, id), eq(poCardProposals.status, "creating")))
      .returning();
    // Written on purpose after the claim went back: the card shows the edits that were refused.
    if (back) await syncProposalCard(deps, back).catch(() => undefined);
    throw error;
  }
  // The card exists: a failure to show it, or to start its spec now, is not a refusal of the confirm (the tick starts it).
  const confirmed = await syncProposalCard(deps, done ?? (await ownProposal(db, userId, orgId, id)));
  const started = await pumpSpecs(deps, claimed.spaceId).catch(() => 0);
  if (started === 0) return confirmed;
  const [latest] = await db.select().from(poCardProposals).where(eq(poCardProposals.id, id));
  return latest ? cardProposalView(db, latest) : confirmed;
}

/** The person who asked discards the proposal: nothing is created. A decided proposal is refused. */
export async function dismissCardProposal(
  deps: PoDeps,
  userId: string,
  orgId: string,
  id: string,
): Promise<CardProposalView> {
  await ownProposal(deps.db, userId, orgId, id);
  const [row] = await deps.db
    .update(poCardProposals)
    .set({ status: "dismissed", decidedByUserId: userId, decidedAt: sql`now()` })
    .where(and(eq(poCardProposals.id, id), eq(poCardProposals.orgId, orgId), eq(poCardProposals.status, "pending")))
    .returning();
  if (!row) throw decided();
  return syncProposalCard(deps, row);
}
