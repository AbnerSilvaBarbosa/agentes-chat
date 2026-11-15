import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, schema, sql } from "@agenteschat/db";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { insertMessage, messageView } from "./messages";
import { enqueueRunJob } from "./mission-runs";
import { poAgentOf } from "./po-chat";
import { type ProposalRow, syncProposalCard } from "./po-proposals";
import { specBrief } from "./po-spec-brief";
import { bodyCode } from "./run-tools";
import { admitTaskAgents } from "./task-access";
import { ensureTaskConversation } from "./task-conversation";

const { agentRuns, poCardProposals } = schema;

export interface SpecDeps {
  db: Database;
  pubsub?: PubSub;
}

/** The most spec runs of one company working at once (ADR 0185): the others wait in the order they were confirmed. */
export const SPEC_RUNS_PER_COMPANY = 3;

/** `meta.cardSpec` of the message that starts a spec run: what `context.ts` reads to give the run its spec brief. */
export interface CardSpecMeta {
  proposalId: string;
  issueId: string;
  spaceId: string;
}

/** The start message's `meta.cardSpec`, or null for any other message. */
export function cardSpecOf(meta: Record<string, unknown> | null | undefined): CardSpecMeta | null {
  const v = meta?.cardSpec as Partial<CardSpecMeta> | undefined;
  if (!v || typeof v.proposalId !== "string" || typeof v.issueId !== "string" || typeof v.spaceId !== "string")
    return null;
  return { proposalId: v.proposalId, issueId: v.issueId, spaceId: v.spaceId };
}

/** A start that cannot go on now (the PO's thread already has a run): the row stays queued, the tick tries again. */
class StartHeld extends Error {}

type Step = "none" | "full" | "held" | "started" | "failed" | "raced";

/**
 * Starts the first queued spec of a company when a slot is free. The cap and the order are checked under the
 * company's advisory lock in the same transaction that writes the run, so two pumps at once start no more than three
 * runs in all and never one out of turn (ADR 0005: no Redis).
 */
async function startNextSpec(deps: SpecDeps, spaceId: string): Promise<Step> {
  const { db } = deps;
  const [head] = await db
    .select()
    .from(poCardProposals)
    .where(and(eq(poCardProposals.spaceId, spaceId), eq(poCardProposals.specState, "queued")))
    .orderBy(asc(poCardProposals.specQueuedAt), asc(poCardProposals.id))
    .limit(1);
  if (!head) return "none";
  if ((await runningIn(db, spaceId)) >= SPEC_RUNS_PER_COMPANY) return "full";
  const po = await poAgentOf(db, head.orgId);
  if (!po) {
    await endSpec(deps, head, "failed", "po_missing");
    return "failed";
  }
  if (!head.issueId) {
    await endSpec(deps, head, "failed", "card_gone");
    return "failed";
  }
  const issueId = head.issueId;
  // The conversation exists before the transaction: making it takes the card's row lock in a transaction of its own.
  const conversation = await ensureTaskConversation(db, issueId);
  await admitTaskAgents(db, head.orgId, conversation.channelId, { ids: [po.id] });
  const [issue] = await db
    .select({ number: schema.issues.number })
    .from(schema.issues)
    .where(eq(schema.issues.id, issueId));
  if (!issue) {
    await endSpec(deps, head, "failed", "card_gone");
    return "failed";
  }

  try {
    const made = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`po-specs:${spaceId}`}))`);
      if ((await runningIn(tx, spaceId)) >= SPEC_RUNS_PER_COMPANY) return null;
      const [first] = await tx
        .select({ id: poCardProposals.id })
        .from(poCardProposals)
        .where(and(eq(poCardProposals.spaceId, spaceId), eq(poCardProposals.specState, "queued")))
        .orderBy(asc(poCardProposals.specQueuedAt), asc(poCardProposals.id))
        .limit(1)
        .for("update");
      if (!first || first.id !== head.id) return "raced" as const;
      // The person's own line, so the wiki's "a person asked" rule is met by the message the run answers.
      const start = await insertMessage(tx, {
        orgId: head.orgId,
        channelId: conversation.channelId,
        threadId: conversation.rootId,
        author: { type: "person", userId: head.requesterUserId },
        body: `Write the spec of card #${issue.number} and save it in the wiki.`,
        meta: {
          cardSpec: { proposalId: head.id, issueId, spaceId } satisfies CardSpecMeta,
          ...bodyCode("card_spec_start", { number: String(issue.number) }),
        },
      });
      const { run } = await enqueueRunJob(tx, start, po.id);
      // A run of the PO already works in that thread: the message joined it, and it would not read the brief.
      if (!run) throw new StartHeld();
      // Linked to the card but never assigned to the PO: an assigned card moves out of Especificar on its first tool.
      await tx.update(agentRuns).set({ issueId }).where(eq(agentRuns.id, run.id));
      const [row] = await tx
        .update(poCardProposals)
        .set({ specState: "running", specRunId: run.id, agentId: po.id, specError: null })
        .where(eq(poCardProposals.id, head.id))
        .returning();
      if (!row) throw new Error("spec start lost its row");
      return { row, start, run };
    });
    if (made === null) return "full";
    if (made === "raced") return "raced";
    if (deps.pubsub) {
      await publishMessageCreated(deps.pubsub, messageView(made.start));
      await publishChannelEvent(deps.pubsub, {
        type: "agent.thinking",
        channelId: conversation.channelId,
        threadId: conversation.rootId,
        agentId: po.id,
        runId: made.run.id,
      });
    }
    await syncProposalCard(deps, made.row).catch(() => undefined);
    return "started";
  } catch (error) {
    if (error instanceof StartHeld) return "held";
    throw error;
  }
}

const runningIn = async (db: Pick<Database, "select">, spaceId: string) => {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(poCardProposals)
    .where(and(eq(poCardProposals.spaceId, spaceId), eq(poCardProposals.specState, "running")));
  return r?.n ?? 0;
};

/**
 * Starts the company's queued specs while fewer than `SPEC_RUNS_PER_COMPANY` are running, in the order they were
 * confirmed. Returns how many started. A spec that cannot start at all (no PO, the card gone) ends failed and the next
 * one is tried.
 */
export async function pumpSpecs(deps: SpecDeps, spaceId: string): Promise<number> {
  let started = 0;
  for (let i = 0; i < 100; i++) {
    const step = await startNextSpec(deps, spaceId);
    if (step === "started") started++;
    else if (step !== "failed" && step !== "raced") break;
  }
  return started;
}

/**
 * Ends a spec that never got a run (no PO, the card gone): written in the proposal and shown on the card in the
 * chat. The settle of a run that did start is `settleSpecRun`.
 */
async function endSpec(deps: SpecDeps, row: ProposalRow, state: "failed" | "stopped", reason: string) {
  const [ended] = await deps.db
    .update(poCardProposals)
    .set({ specState: state, specError: reason.slice(0, 300) })
    .where(and(eq(poCardProposals.id, row.id), eq(poCardProposals.specState, "queued")))
    .returning();
  if (ended) await syncProposalCard(deps, ended).catch(() => undefined);
}

/**
 * The spec brief of a run, when the message it answers is a spec start (`meta.cardSpec`) and the run is the one the
 * proposal started: the same agent answering any other message of that conversation gets the generic task block.
 */
export async function specBriefOfRun(
  db: Database,
  run: { id: string; orgId: string },
  trigger: { meta: Record<string, unknown> | null },
): Promise<string | null> {
  const spec = cardSpecOf(trigger.meta);
  if (!spec) return null;
  const [proposal] = await db
    .select()
    .from(poCardProposals)
    .where(and(eq(poCardProposals.id, spec.proposalId), eq(poCardProposals.orgId, run.orgId)));
  if (!proposal || proposal.specRunId !== run.id) return null;
  const [issue] = await db
    .select()
    .from(schema.issues)
    .where(and(eq(schema.issues.id, spec.issueId), eq(schema.issues.orgId, run.orgId)));
  return issue ? specBrief(db, run.orgId, proposal, issue) : null;
}
