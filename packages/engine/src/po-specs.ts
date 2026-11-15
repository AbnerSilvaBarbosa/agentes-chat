import type { PubSub } from "@agenteschat/adapters";
import { and, asc, type Database, eq, inArray, isNull, or, schema, sql } from "@agenteschat/db";
import { publishChannelEvent, publishMessageCreated } from "./events";
import { updateIssue } from "./issues";
import { insertMessage, type MessageView, messageView } from "./messages";
import { enqueueRunJob } from "./mission-runs";
import { enqueue } from "./outbox";
import { poAgentOf } from "./po-chat";
import { specColumns } from "./po-columns";
import { type ProposalRow, syncProposalCard } from "./po-proposals";
import { specBrief } from "./po-spec-brief";
import { bodyCode } from "./run-tools";
import { admitTaskAgents } from "./task-access";
import { ensureTaskConversation } from "./task-conversation";
import { withWikiLinks } from "./wiki-links";

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

/** Why a spec did not finish, as the card's comment and the PO chat say it (`specError` holds the code or the run's error). */
export function specReasonText(code: string | null): string {
  switch (code) {
    case "po_missing":
      return "the workspace has no PO to write it";
    case "card_gone":
      return "the card is gone";
    case "no_spec_page":
      return "the run ended without saving the spec in the wiki";
    case "run_missing":
      return "its run is gone";
    case null:
    case "":
      return "it stopped";
    default:
      return code;
  }
}

/**
 * Ends a spec that never got a run (no PO, the card gone): written in the proposal, the card and the PO chat told. The
 * settle of a run that did start is `settleSpecRun`.
 */
async function endSpec(deps: SpecDeps, row: ProposalRow, state: "failed" | "stopped", reason: string) {
  const [ended] = await deps.db
    .update(poCardProposals)
    .set({ specState: state, specError: reason.slice(0, 300) })
    .where(and(eq(poCardProposals.id, row.id), eq(poCardProposals.specState, "queued")))
    .returning();
  if (ended) await reportSpec(deps, ended, state);
}

/** A line of the PO in a conversation, notified like any message (`notifications.message` also refreshes the card's count). */
async function say(
  deps: SpecDeps,
  row: ProposalRow,
  at: { channelId: string; threadId: string | null },
  body: string,
  code: string,
  params: Record<string, string>,
) {
  const message = await deps.db.transaction(async (tx) => {
    const posted = await insertMessage(tx, {
      orgId: row.orgId,
      channelId: at.channelId,
      threadId: at.threadId,
      author: { type: "agent", agentId: row.agentId, runId: null, hop: 1, stretchId: null },
      body,
      meta: { cardSpecReport: { proposalId: row.id }, ...bodyCode(code, params) },
    });
    await enqueue(tx, {
      orgId: row.orgId,
      kind: "notifications.message",
      payload: { messageId: posted.id },
      dedupeKey: `notifications.message:${posted.id}`,
      maxAttempts: 4,
    });
    return posted;
  });
  if (deps.pubsub) {
    const [view] = (await withWikiLinks(deps.db, row.orgId, [messageView(message)])) as [MessageView];
    await publishMessageCreated(deps.pubsub, view);
  }
}

/**
 * What follows a spec's end, in order and each on its own so one failure never hides the next: the card moves (spec
 * done), the card's conversation gets the comment, the PO chat of the proposal's company hears it, the chat's card
 * shows the state, and the next queued spec starts. The report goes to the proposal's own chat, whichever company the
 * person has open now.
 */
async function reportSpec(deps: SpecDeps, row: ProposalRow, state: "done" | "failed" | "stopped") {
  const { db } = deps;
  const attempt = (step: Promise<unknown>) => step.catch(() => undefined);
  const [issue] = row.issueId ? await db.select().from(schema.issues).where(eq(schema.issues.id, row.issueId)) : [];
  const [page] = issue?.specPageId
    ? await db
        .select({ title: schema.wikiPages.title })
        .from(schema.wikiPages)
        .where(eq(schema.wikiPages.id, issue.specPageId))
    : [];
  const number = String(issue?.number ?? "");
  const title = issue?.title ?? row.title;
  let stays = false;
  if (state === "done" && issue) {
    // Where it goes is the board's "Priorizado" (else the next to-do column); a card a person already moved stays.
    await attempt(
      (async () => {
        const { specify, prioritized } = await specColumns(db, row.orgId, row.projectId);
        if (!prioritized) stays = true;
        else if (issue.columnId === specify.id || (issue.columnId === null && issue.status === specify.stage))
          await updateIssue(
            deps,
            { type: "agent", agentId: row.agentId, channelId: row.channelId },
            row.orgId,
            issue.id,
            { columnId: prioritized.id },
          );
      })(),
    );
  }
  const reason = specReasonText(row.specError);
  const [code, params, english] =
    state === "done"
      ? ([
          stays ? "card_spec_ready_stays" : "card_spec_ready",
          { number, title, page: page?.title ?? "" },
          `The spec of card #${number} "${title}" is ready: [[${page?.title ?? ""}]].${stays ? " The board has no column to move it to." : ""}`,
        ] as const)
      : ([
          "card_spec_failed",
          { number, title, reason },
          `The spec of card #${number} "${title}" did not finish: ${reason}. The card stays where it is.`,
        ] as const);
  if (issue)
    await attempt(
      (async () => {
        const conversation = await ensureTaskConversation(db, issue.id);
        await say(
          deps,
          row,
          { channelId: conversation.channelId, threadId: conversation.rootId },
          english,
          code,
          params,
        );
      })(),
    );
  await attempt(say(deps, row, { channelId: row.channelId, threadId: null }, english, code, params));
  await attempt(syncProposalCard(deps, row));
  await attempt(pumpSpecs(deps, row.spaceId));
}

/**
 * A run that works on a card's spec ended (`onConsultedRunFinished`, `onConsultedRunStopped`, the restart's recovery,
 * and the tick for one nobody heard): `done` with the spec page attached is a finished spec; any other ending, or a
 * `done` with no page, is a failed one (`canceled` is a stopped one). One conditional update settles it, so two
 * settles of one run report once. Then the card moves or stays, says why, and the next queued spec starts.
 */
export async function settleSpecRun(
  deps: SpecDeps,
  run: { id: string; orgId: string },
  status: "done" | "failed" | "canceled",
  error?: string,
): Promise<void> {
  const [proposal] = await deps.db
    .select()
    .from(poCardProposals)
    .where(
      and(
        eq(poCardProposals.specRunId, run.id),
        eq(poCardProposals.orgId, run.orgId),
        eq(poCardProposals.specState, "running"),
      ),
    );
  if (proposal) await settleRow(deps, proposal, status, error);
}

async function settleRow(
  deps: SpecDeps,
  proposal: ProposalRow,
  status: "done" | "failed" | "canceled",
  error?: string,
) {
  const { db } = deps;
  const [card] = proposal.issueId
    ? await db
        .select({ specPageId: schema.issues.specPageId })
        .from(schema.issues)
        .where(eq(schema.issues.id, proposal.issueId))
    : [];
  const state = status === "done" && card?.specPageId ? "done" : status === "canceled" ? "stopped" : "failed";
  const reason =
    state === "done"
      ? null
      : status === "done"
        ? "no_spec_page"
        : (error ?? (status === "canceled" ? "stopped" : "failed"));
  const [settled] = await db
    .update(poCardProposals)
    .set({ specState: state, specError: reason ? reason.slice(0, 300) : null })
    .where(and(eq(poCardProposals.id, proposal.id), eq(poCardProposals.specState, "running")))
    .returning();
  if (settled) await reportSpec(deps, settled, state);
}

/**
 * The tick (every minute): a `running` spec whose run is over, or gone, and that nobody settled (a restart between the
 * run's end and its hook) is settled now, and every company with queued specs is pumped, so a start that was held
 * goes on. Returns how many it settled.
 */
export async function reapSpecs(deps: SpecDeps): Promise<number> {
  const { db } = deps;
  const stale = await db
    .select({ row: poCardProposals, status: agentRuns.status, error: agentRuns.error })
    .from(poCardProposals)
    .leftJoin(agentRuns, eq(agentRuns.id, poCardProposals.specRunId))
    .where(
      and(
        eq(poCardProposals.specState, "running"),
        or(isNull(agentRuns.id), inArray(agentRuns.status, ["done", "failed", "canceled"])),
      ),
    )
    .limit(200);
  let settled = 0;
  for (const { row, status, error } of stale) {
    try {
      await settleRow(
        deps,
        row,
        status === "done" || status === "canceled" ? status : "failed",
        status ? (error ?? undefined) : "run_missing",
      );
      settled++;
    } catch {
      // The next tick tries again; one spec never holds back the rest.
    }
  }
  const waiting = await db
    .selectDistinct({ spaceId: poCardProposals.spaceId })
    .from(poCardProposals)
    .where(eq(poCardProposals.specState, "queued"));
  for (const { spaceId } of waiting) await pumpSpecs(deps, spaceId).catch(() => undefined);
  return settled;
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

/** The heading of the section of a card's description that holds its spec's acceptance criteria (`attach_spec`). */
export const CRITERIA_HEADING = "## Critérios de aceite";

/**
 * The description with its criteria section written: an existing section (from its heading to the next `##` heading)
 * is replaced, else one is added at the end, so attaching a spec twice never repeats it. No criteria drops the section.
 */
export function withCriteriaSection(description: string, criteria: string[]): string {
  const section = criteria.length ? `${CRITERIA_HEADING}\n\n${criteria.map((c) => `- ${c}`).join("\n")}` : "";
  const lines = description.split("\n");
  const start = lines.findIndex((l) => l.trim() === CRITERIA_HEADING);
  if (start < 0) return [description.trim(), section].filter(Boolean).join("\n\n");
  const next = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  const end = next < 0 ? lines.length : next;
  return [lines.slice(0, start).join("\n").trim(), section, lines.slice(end).join("\n").trim()]
    .filter(Boolean)
    .join("\n\n");
}
