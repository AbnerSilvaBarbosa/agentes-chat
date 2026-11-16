import { and, type Database, desc, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { boardColumnsOf, columnOf } from "./issue-columns";
import { taskSeenSql } from "./task-access";
import { untrustedBlock } from "./untrusted";

const { issueProjects, issues, poCardProposals, wikiPages } = schema;

/** How many cards the block lists before it says how many more there are (`list_issues` reads the rest). */
export const PO_BRIEF_CARDS = 80;

/**
 * What a PO knows of its company at the start of every turn in a PO chat (ADR 0185): the company, its live boards with
 * their columns, the cards the person sees (open first, with their column and spec), the proposals still waiting, and
 * the rules of the chat. Read live each turn, so it never goes stale. Titles are typed by anyone, so the card list sits
 * inside the untrusted envelope; the rules sit outside it.
 */
export async function poChatBrief(
  db: Database,
  orgId: string,
  scope: { spaceId: string; name: string },
  personId: string,
): Promise<string> {
  const allBoards = await db
    .select({ id: issueProjects.id, name: issueProjects.name, archivedAt: issueProjects.archivedAt })
    .from(issueProjects)
    .where(and(eq(issueProjects.orgId, orgId), eq(issueProjects.spaceId, scope.spaceId)))
    .orderBy(issueProjects.name);
  const boards = allBoards.filter((b) => !b.archivedAt);
  const columnsOfBoard = new Map(
    await Promise.all(allBoards.map(async (b) => [b.id, await boardColumnsOf(db, orgId, b.id)] as const)),
  );
  const boardColumns = boards.map((b) => columnsOfBoard.get(b.id) ?? []);
  const boardLines = boards.map(
    (b, i) =>
      `- ${b.name}: ${(boardColumns[i] ?? []).map((c) => `"${c.name ?? c.stage}"`).join(" → ") || "no columns"}`,
  );

  const mine = and(
    eq(issues.orgId, orgId),
    sql`${issues.projectId} in (select id from ${issueProjects} where ${eq(issueProjects.spaceId, scope.spaceId)})`,
    taskSeenSql("issues", sql`${personId}::text`),
  );
  const [counted, cards] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(issues).where(mine),
    db
      .select({
        number: issues.number,
        title: issues.title,
        status: issues.status,
        columnId: issues.columnId,
        projectId: issues.projectId,
        specTitle: wikiPages.title,
        specRestricted: wikiPages.restricted,
        specPageId: issues.specPageId,
      })
      .from(issues)
      .leftJoin(wikiPages, and(eq(wikiPages.id, issues.specPageId), isNull(wikiPages.deletedAt)))
      .where(mine)
      .orderBy(sql`(${issues.status} in ('done', 'canceled'))`, desc(issues.updatedAt))
      .limit(PO_BRIEF_CARDS),
  ]);
  const total = counted[0]?.n ?? 0;
  const boardName = new Map(allBoards.map((p) => [p.id, p.name]));
  const cardLines = cards.map((c) => {
    const there = c.projectId ? columnOf(columnsOfBoard.get(c.projectId) ?? [], c) : null;
    const column = there ? (there.name ?? there.stage) : c.status;
    const spec =
      c.specPageId && c.specTitle !== null
        ? c.specRestricted
          ? "spec: (restricted page)"
          : `spec: [[${c.specTitle}]]`
        : "no spec";
    return `#${c.number} ${c.title} [${(c.projectId && boardName.get(c.projectId)) || "no board"} › ${column}] ${spec}`;
  });
  if (total > cards.length) cardLines.push(`${total - cards.length} more: use list_issues`);

  const waiting = await db
    .select({ title: poCardProposals.title })
    .from(poCardProposals)
    .where(
      and(
        eq(poCardProposals.orgId, orgId),
        eq(poCardProposals.spaceId, scope.spaceId),
        eq(poCardProposals.requesterUserId, personId),
        inArray(poCardProposals.status, ["pending", "creating"]),
      ),
    )
    .orderBy(poCardProposals.createdAt);

  return [
    `# Your company in this chat: ${scope.name}`,
    "This chat is about this one company. Its boards and their columns:",
    ...(boardLines.length ? boardLines : ["- (no live boards yet)"]),
    "",
    `Its cards that this person sees (open first, ${PO_BRIEF_CARDS} at most):`,
    untrustedBlock("cards", cardLines.length ? cardLines.join("\n") : "(none)", 20_000),
    ...(waiting.length
      ? [
          "",
          "Proposals still waiting for this person to confirm (not cards yet):",
          untrustedBlock("proposals", waiting.map((w) => `- ${w.title}`).join("\n"), 8_000),
        ]
      : []),
    "",
    "Rules of this chat:",
    "- Propose a card with `propose_card`. Nothing exists until the person confirms it: say it is a proposal, never that the card was made.",
    "- Check the list above for a similar title before proposing.",
    "- Specs are written by background runs after a card is confirmed; do not write one in this chat unless asked.",
    "- The list above is the truth now, over anything said earlier in this chat: a card that is listed was confirmed, and one marked `spec: [[Page]]` already has its spec in the wiki, written by that background run. Never say a listed card was only proposed or has no spec.",
    "- Keep a proposal's summary to two or three sentences, with the detail in the criteria; the long reading belongs in the spec.",
    `- Stay in ${scope.name}: do not read or change another company's cards, boards or specs.`,
  ].join("\n");
}
