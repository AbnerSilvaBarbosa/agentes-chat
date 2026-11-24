import { and, desc, type Executor, eq, inArray, ne, schema, sql } from "@agenteschat/db";
import type { ProposalRow } from "./po-proposals";
import { taskSeenSql } from "./task-access";
import { untrustedBlock } from "./untrusted";
import { cleanFolder } from "./wiki";

const { issueColumns, issueProjects, issueSpaces, issues, users } = schema;

type IssueRow = typeof issues.$inferSelect;

/**
 * The wiki folder a company's specs live in (ADR 0229 addendum): `<company>/Specs`, the place the company's wiki
 * already keeps them, one folder `<number>` per card under it. A `/` in the name would make a folder level of its own,
 * so it becomes `-`. The wiki tools of a PO chat keep to this folder among the companies' `Specs` folders.
 */
export const specFolder = (company: string) => cleanFolder(`${company.replace(/\//g, "-")}/Specs`);

/** The folder of one card's spec pages under its company's: `<company>/Specs/<number>`. */
export const cardSpecFolder = (companyFolder: string, number: number) => cleanFolder(`${companyFolder}/${number}`);

/**
 * The folder of one company (ADR 0229): `specFolder` of its name, and two companies whose names make the same folder
 * ("A/B" and "A-B", or the same name in other capitals) must not share it, or each reads and writes the other's specs.
 * The earliest company keeps the plain folder, so pages already written stay where they are; each later one gets
 * its id's last six characters in brackets after the name ("A-B [1f3a9c]/Specs"), the same on every call.
 */
export async function specFolderOf(db: Executor, orgId: string, space: { id: string; name: string }) {
  const plain = specFolder(space.name);
  const all = await db
    .select({ id: issueSpaces.id, name: issueSpaces.name, createdAt: issueSpaces.createdAt })
    .from(issueSpaces)
    .where(eq(issueSpaces.orgId, orgId));
  const sharing = all
    .filter((c) => specFolder(c.name).toLowerCase() === plain.toLowerCase())
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  if (sharing.length < 2 || sharing[0]?.id === space.id) return plain;
  return cleanFolder(`${space.name.replace(/\//g, "-")} [${space.id.replace(/-/g, "").slice(-6)}]/Specs`);
}

/**
 * Whether `folder` is, or is under, another company's `Specs` folder (compared in any capitals): `<company>/Specs…`,
 * or the first form's `Specs/<company>…`, unless it is the PO chat's own.
 */
export function otherCompanysSpecs(folder: string, own: string) {
  const f = folder.toLowerCase();
  const mine = own.toLowerCase();
  const specs = /^[^/]+\/specs(\/|$)/.test(f) || f.startsWith("specs/");
  return specs && f !== mine && !f.startsWith(`${mine}/`);
}

/**
 * A PO chat's search hits kept to its company (ADR 0229): an issue hit only when its board is the company's (a card
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
  const own = await specFolderOf(db, orgId, { id: scope.spaceId, name: scope.name });
  const folders = new Map(pages.map((p) => [p.id, p.folder]));
  return hits.filter((h) => {
    if (h.kind === "issue") return mine.has(h.sourceId);
    if (h.kind === "wiki") return !otherCompanysSpecs(folders.get(h.sourceId) ?? "", own);
    return true;
  });
}

/**
 * The wiki page's title for a card (ADR 0229): the card's title without the characters a wiki title cannot hold
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
 * What a spec run reads (ADR 0229), in place of the generic task block: the card, the company, where and under which
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
  const folder = cardSpecFolder(await specFolderOf(db, orgId, { id: proposal.spaceId, name: company }), issue.number);
  const pageTitle = (kind: "Spec" | "Design" | "Tarefas") =>
    `${issue.number} · ${kind} — ${title}`.slice(0, 200).trim();
  const [specTitle, designTitle, tasksTitle] = [pageTitle("Spec"), pageTitle("Design"), pageTitle("Tarefas")];
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
      "## Write the three pages of the tlc-spec-driven method, the way the company's other specs in the wiki are written",
      'FIRST, before writing anything: open your skill "tlc-spec-driven" with read_skill_file (name "tlc-spec-driven", path "SKILL.md", then the files of its references/ folder that its Specify, Design and Tasks phases name: specify.md, design.md, tasks.md; list the folder with a path ending in "/") and follow it. If you have no such skill, say so in your answer and follow the form below.',
      `Save them all in the folder ${JSON.stringify(folder)}. Read one of the company's finished spec folders first (search the wiki for "Spec —") and copy its form, its tone and its links.`,
      `1. ${JSON.stringify(specTitle)}: it opens with one line "Pasta ${issue.number}: [[the three titles]]", then "# ${issue.number} · ${title}", then "**Approved**: pendente (aguarda o sim do Abner)" and a line with the card, board and risk 1/2/3. Then the EARS spec:`,
      "## Problem Statement · ## Goals (checkboxes) · ## Out of Scope (table: Feature | Reason) · ## Assumptions & Open Questions (table: Assumption | Chosen default | Rationale | Confirmed?) · ## User Stories (P1, P2, P3, each with: User Story, Why, numbered Acceptance Criteria, Independent Test) · ## Edge Cases · ## Requirement Traceability (ID | Story | Status Pending, IDs like <ABBR>-01) · ## Success Criteria",
      'Acceptance criteria are one behavior each: "WHEN <event> THEN the system SHALL <response>", "WHILE <state> ...", "IF <condition> THEN ...", or "The system SHALL ..." with a concrete value, never "quickly".',
      `2. ${JSON.stringify(designTitle)}: "# ${issue.number} · Design técnico": the repos and files to change with what changes in each, the decisions and why, the risks. Read the code first; name real files.`,
      `3. ${JSON.stringify(tasksTitle)}: "# ${issue.number} · Tarefas": the "**Approved**: pendente" line, the **Build** and **Run <name>** commands, atomic tasks (each with Tests and Gate) in phases, and a ## Checks section with one check per acceptance criterion.`,
      "A small card still gets the three pages; keep Design and Tarefas short, never empty.",
    ].join("\n"),
    [
      "## Save it",
      `1. create_wiki_page for each of the three pages, with the folder ${JSON.stringify(folder)}, the title above and tags ${JSON.stringify(
        [
          company
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "spec",
          "spec",
        ],
      )}. They are wiki pages the whole workspace may read: write no secrets. If a title is taken, retry once with " (${company})" added to it.`,
      `2. attach_spec with the page ${JSON.stringify(specTitle)} (the Spec, not the others) and the final acceptance criteria (one string each, copied from the spec's stories).`,
      "3. Answer in two sentences: where the spec is and what it assumes.",
      "Do not move the card, and do not ask anything: the system moves the card when you are done.",
    ].join("\n"),
  ].join("\n\n");
}
