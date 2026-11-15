import { and, desc, type Executor, eq, inArray, ne, schema, sql } from "@agenteschat/db";
import type { ProposalRow } from "./po-proposals";
import { taskSeenSql } from "./task-access";
import { untrustedBlock } from "./untrusted";
import { cleanFolder } from "./wiki";

const { issueColumns, issueProjects, issueSpaces, issues, users } = schema;

type IssueRow = typeof issues.$inferSelect;

/**
 * The wiki folder a company's specs live in (ADR 0185): `Specs/<company>`. A `/` in the name would make a folder level
 * of its own, so it becomes `-`. The wiki tools of a PO chat keep to this folder among the `Specs/` pages.
 */
export const specFolder = (company: string) => cleanFolder(`Specs/${company.replace(/\//g, "-")}`);

/** Whether `folder` is, or is under, another company's folder in `Specs/` (compared in any capitals). */
export function otherCompanysSpecs(folder: string, own: string) {
  const f = folder.toLowerCase();
  const mine = own.toLowerCase();
  return f.startsWith("specs/") && f !== mine && !f.startsWith(`${mine}/`);
}

/**
 * A PO chat's search hits kept to its company (ADR 0185): an issue hit only when its board is the company's (a card
 * on no board is not), a wiki hit unless the page sits under another company's `Specs/` folder. Other kinds stay.
 */
export async function keepHitsToCompany<T extends { kind: string; sourceId: string }>(
  db: Executor,
  orgId: string,
  scope: { spaceId: string; name: string },
  hits: T[],
): Promise<T[]> {
  const ids = (kind: string) => hits.filter((h) => h.kind === kind).map((h) => h.sourceId);
  const [cards, pages] = await Promise.all([
    ids("issue").length === 0
      ? []
      : db
          .select({ id: issues.id, spaceId: issueProjects.spaceId })
          .from(issues)
          .leftJoin(issueProjects, eq(issueProjects.id, issues.projectId))
          .where(and(eq(issues.orgId, orgId), inArray(issues.id, ids("issue")))),
    ids("wiki").length === 0
      ? []
      : db
          .select({ id: schema.wikiPages.id, folder: schema.wikiPages.folder })
          .from(schema.wikiPages)
          .where(and(eq(schema.wikiPages.orgId, orgId), inArray(schema.wikiPages.id, ids("wiki")))),
  ]);
  const mine = new Set(cards.filter((c) => c.spaceId === scope.spaceId).map((c) => c.id));
  const own = specFolder(scope.name);
  const folders = new Map(pages.map((p) => [p.id, p.folder]));
  return hits.filter((h) => {
    if (h.kind === "issue") return mine.has(h.sourceId);
    if (h.kind === "wiki") return !otherCompanysSpecs(folders.get(h.sourceId) ?? "", own);
    return true;
  });
}

/**
 * The wiki page's title for a card (ADR 0185): the card's title without the characters a wiki title cannot hold
 * (`[ ] | #`), on one line, at most 200 characters (`cleanTitle`'s own rule in `wiki.ts`).
 */
export const specPageTitle = (title: string) =>
  title
    .replace(/[[\]|#]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
    .trim() || "Spec";

/** How many other cards of the company the brief names, so the spec does not repeat a neighbour. */
const BRIEF_NEIGHBOURS = 30;

/**
 * What a spec run reads (ADR 0185), in place of the generic task block: the card, the company, where and under which
 * name to save the spec, the form the spec takes and what to do afterwards. The person's visible start message is the
 * request the wiki's write rule needs; the brief says so again. The card's title, summary and criteria, and the
 * neighbours' titles, are typed by anyone, so they sit inside the untrusted envelope and the rules outside it.
 */
export async function specBrief(
  db: Executor,
  orgId: string,
  proposal: Pick<ProposalRow, "requesterUserId" | "summary" | "criteria" | "spaceId" | "projectId">,
  issue: Pick<IssueRow, "id" | "number" | "title">,
): Promise<string> {
  const [[space], [board], [person]] = await Promise.all([
    db
      .select({ name: issueSpaces.name })
      .from(issueSpaces)
      .where(and(eq(issueSpaces.id, proposal.spaceId), eq(issueSpaces.orgId, orgId))),
    db
      .select({ name: issueProjects.name })
      .from(issueProjects)
      .where(and(eq(issueProjects.id, proposal.projectId), eq(issueProjects.orgId, orgId))),
    db.select({ name: users.name }).from(users).where(eq(users.id, proposal.requesterUserId)),
  ]);
  const company = space?.name ?? "the company";
  const neighbours = await db
    .select({ number: issues.number, title: issues.title, column: issueColumns.name, status: issues.status })
    .from(issues)
    .innerJoin(issueProjects, eq(issueProjects.id, issues.projectId))
    .leftJoin(issueColumns, eq(issueColumns.id, issues.columnId))
    .where(
      and(
        eq(issues.orgId, orgId),
        eq(issueProjects.spaceId, proposal.spaceId),
        ne(issues.id, issue.id),
        taskSeenSql("issues", sql`${proposal.requesterUserId}::text`),
      ),
    )
    .orderBy(desc(issues.updatedAt))
    .limit(BRIEF_NEIGHBOURS);
  const title = specPageTitle(issue.title);
  const folder = specFolder(company);
  const card = [
    `Title: ${issue.title}`,
    `Summary: ${proposal.summary.trim() || "(none)"}`,
    proposal.criteria.length
      ? `Criteria proposed:\n${proposal.criteria.map((c, i) => `${i + 1}. ${c}`).join("\n")}`
      : "Criteria proposed: (none)",
  ].join("\n");
  const others = neighbours.map((n) => `#${n.number} ${n.title} [${n.column ?? n.status}]`).join("\n");
  return [
    `# Your task: write the spec of card #${issue.number}`,
    `${person?.name ?? "A person"} confirmed this card in the PO chat of ${JSON.stringify(company)} and asked you, in the message you are answering, to write its spec and save it in the wiki. Work alone: do not ask questions. Where something is missing, decide, write the assumption in the spec's table with Confirmed? n, and go on.`,
    `## The card\n${untrustedBlock("card", card)}\nBoard: ${JSON.stringify(board?.name ?? "")}.`,
    others
      ? `## Other cards of the company (do not repeat them)\n${untrustedBlock("cards", others)}`
      : "## Other cards of the company\nNone yet.",
    [
      "## Write the spec the way your instructions describe (tlc-spec-driven, EARS). If they do not, use this form",
      `# ${title} Specification`,
      "## Problem Statement",
      "## Goals (checkboxes)",
      "## Out of Scope (table: Feature | Reason)",
      "## Assumptions & Open Questions (table: Assumption | Chosen default | Rationale | Confirmed?)",
      "## User Stories (P1, P2, P3, each with: User Story, Why, numbered Acceptance Criteria, Independent Test)",
      'Acceptance criteria are one behavior each: "WHEN <event> THEN the system SHALL <response>", "WHILE <state> ...", "IF <condition> THEN ...", or "The system SHALL ..." with a concrete value, never "quickly".',
      "## Edge Cases",
      "## Requirement Traceability (ID | Story | Status Pending), IDs like <ABBR>-01",
      "## Success Criteria",
    ].join("\n"),
    [
      "## Save it",
      `1. create_wiki_page with title ${JSON.stringify(title)}, folder ${JSON.stringify(folder)}, body the spec in Markdown. The page is a wiki page the whole workspace may read: write no secrets. If the title is taken, retry once with title ${JSON.stringify(specPageTitle(`${title} (${company})`))}.`,
      "2. attach_spec with the page and the final acceptance criteria (one string each, copied from the spec's stories).",
      "3. Answer in two sentences: where the spec is and what it assumes.",
      "Do not move the card, and do not ask anything: the system moves the card when you are done.",
    ].join("\n"),
  ].join("\n\n");
}
