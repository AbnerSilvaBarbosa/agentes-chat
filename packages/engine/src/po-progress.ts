import { type Database, rowsOf, schema, sql } from "@agenteschat/db";
import { NotFoundError } from "./errors";
import { boardColumnsOf, columnKey, effectiveColumnSql } from "./issue-columns";
import type { IssueStatus } from "./issues";
import { requireActiveMembership } from "./organizations";
import { taskSeenSql } from "./task-access";

/**
 * The progress panel of a company's PO chat (ADR 0185 addendum): the company's open cards for one viewer, grouped by the
 * columns of its boards, read when the panel opens and again on the events the app already hears (a task changed, a
 * proposal's spec moved on). Nothing is stored. The visible cards are `taskSeenSql`'s (ADR 0151), as every list of
 * tasks; canceled cards and the cards of an archived board are in no number.
 */

/** Cards listed in a group; `count` says how many there are. */
export const PO_PROGRESS_GROUP_ROWS = 8;

/** The column that ends the head groups: everything open after it is the tail. */
const READY_FOR_DEV = "ready for dev";
const OPEN_STAGES: readonly IssueStatus[] = ["todo", "in_progress", "in_review"];
const TAIL_STAGES: readonly IssueStatus[] = ["in_progress", "in_review"];

export interface PoProgressSpec {
  state: "queued" | "running" | "done" | "failed" | "stopped";
  /** The spec's wiki page, when it exists and is not deleted or restricted. */
  page: { slug: string; title: string } | null;
  /** A fixed code (`po_missing`, `stopped`…) or the run's short reason; null while nothing failed. */
  error: string | null;
}

export interface PoProgressCard {
  id: string;
  number: number;
  title: string;
  boardId: string;
  boardName: string;
  /** ISO time the card entered its column (the column clock). */
  since: string;
  spec: PoProgressSpec | null;
}

export interface PoProgressGroup {
  /** The column's key (`columnKey`), or `tail`. */
  key: string;
  /** `column`: one column (the boards' same-named ones merged); `tail`: every open column after Ready for dev. */
  kind: "column" | "tail";
  stage: IssueStatus;
  /** Null: the stage's own name, said in the reader's language (as the board does), or the tail's label. */
  name: string | null;
  /** The keys the task list is asked for to see this group ("Ver todos"). */
  columns: string[];
  /** Every card of the group; `items` lists the first `PO_PROGRESS_GROUP_ROWS`, longest in the column first. */
  count: number;
  items: PoProgressCard[];
}

export interface PoProgress {
  space: { id: string; name: string };
  groups: PoProgressGroup[];
  /** Done cards the viewer sees on the company's live boards: one number, never rows. */
  done: number;
}

interface Layout {
  head: { key: string; name: string | null; stage: IssueStatus }[];
  tail: Set<string>;
}

/**
 * The groups a board's columns stand for, in board order: every open column up to and including "Ready for dev" (any
 * capitals) is its own group; every open column after it is the tail. A board without that column has its to-do
 * columns as groups and its in-progress and in-review ones as the tail. Done and canceled columns are never a group.
 */
function layoutOf(columns: { name: string | null; stage: IssueStatus }[]): Layout {
  const ready = columns.findIndex((c) => c.name?.trim().toLowerCase() === READY_FOR_DEV);
  const heads = ready >= 0 ? columns.slice(0, ready + 1) : columns.filter((c) => c.stage === "todo");
  const tails = ready >= 0 ? columns.slice(ready + 1) : columns;
  return {
    head: heads
      .filter((c) => OPEN_STAGES.includes(c.stage))
      .map((c) => ({ key: columnKey(c), name: c.name?.trim() || null, stage: c.stage })),
    tail: new Set(tails.filter((c) => TAIL_STAGES.includes(c.stage)).map(columnKey)),
  };
}

interface CardRow {
  id: string;
  number: number;
  title: string;
  status: IssueStatus;
  project_id: string;
  project_name: string;
  column_since: Date | string;
  column_name: string | null;
  column_stage: IssueStatus | null;
  spec_state: PoProgressSpec["state"] | null;
  spec_error: string | null;
  page_slug: string | null;
  page_title: string | null;
}

/** The company's progress for `userId` (`spaceId` of another workspace: not found). */
export async function poProgress(db: Database, userId: string, orgId: string, spaceId: string): Promise<PoProgress> {
  await requireActiveMembership(db, userId, orgId);
  const [space] = rowsOf<{ id: string; name: string }>(
    await db.execute(
      sql`select id, name from ${schema.issueSpaces} where id = ${spaceId}::uuid and org_id = ${orgId}::uuid`,
    ),
  );
  if (!space) throw new NotFoundError("Company not found");
  const boards = rowsOf<{ id: string; name: string }>(
    await db.execute(
      sql`select id, name from ${schema.issueProjects}
        where space_id = ${spaceId}::uuid and org_id = ${orgId}::uuid and archived_at is null
        order by created_at asc, id asc`,
    ),
  );

  // The groups, from each board's own columns: head groups merge by key in the order each is first met, every
  // board's tail is the one tail group.
  const layouts = new Map<string, Layout>();
  const heads = new Map<string, PoProgressGroup>();
  const tail: PoProgressGroup = {
    key: "tail",
    kind: "tail",
    stage: "in_progress",
    name: null,
    columns: [],
    count: 0,
    items: [],
  };
  const tailKeys = new Set<string>();
  for (const board of boards) {
    const layout = layoutOf(await boardColumnsOf(db, orgId, board.id));
    layouts.set(board.id, layout);
    for (const h of layout.head)
      if (!heads.has(h.key))
        heads.set(h.key, {
          key: h.key,
          kind: "column",
          stage: h.stage,
          name: h.name,
          columns: [h.key],
          count: 0,
          items: [],
        });
    for (const key of layout.tail) tailKeys.add(key);
  }
  tail.columns = [...tailKeys];
  const groups = [...heads.values(), tail];
  if (boards.length === 0) return { space, groups: [], done: 0 };

  const seen = taskSeenSql("i", sql`${userId}::text`);
  const rows = rowsOf<CardRow>(
    await db.execute(sql`select i.id, i.number, i.title, i.status, i.project_id, p.name as project_name,
        i.column_since, col.name as column_name, col.stage as column_stage,
        pr.spec_state, pr.spec_error, w.slug as page_slug, w.title as page_title
      from ${schema.issues} i
      join ${schema.issueProjects} p on p.id = i.project_id
      ${effectiveColumnSql("i")}
      left join ${schema.poCardProposals} pr on pr.issue_id = i.id
      left join ${schema.wikiPages} w on w.id = i.spec_page_id and w.deleted_at is null and not w.restricted
      where i.org_id = ${orgId}::uuid and p.space_id = ${spaceId}::uuid and p.archived_at is null
        and i.status in ('todo', 'in_progress', 'in_review') and ${seen}
      order by i.column_since asc, i.number asc, i.id asc`),
  );
  const [doneRow] = rowsOf<{ done: number }>(
    await db.execute(sql`select count(*)::int as done
      from ${schema.issues} i join ${schema.issueProjects} p on p.id = i.project_id
      where i.org_id = ${orgId}::uuid and p.space_id = ${spaceId}::uuid and p.archived_at is null
        and i.status = 'done' and ${seen}`),
  );

  for (const r of rows) {
    const layout = layouts.get(r.project_id);
    const key = columnKey({ name: r.column_name, stage: r.column_stage ?? r.status });
    const group = layout?.head.some((h) => h.key === key)
      ? heads.get(key)
      : TAIL_STAGES.includes(r.status)
        ? tail
        : undefined;
    if (!group) continue;
    group.count += 1;
    if (group.items.length >= PO_PROGRESS_GROUP_ROWS) continue;
    const page = r.page_slug ? { slug: r.page_slug, title: r.page_title ?? "" } : null;
    group.items.push({
      id: r.id,
      number: r.number,
      title: r.title,
      boardId: r.project_id,
      boardName: r.project_name,
      since: new Date(r.column_since).toISOString(),
      spec: r.spec_state
        ? { state: r.spec_state, page, error: r.spec_error }
        : page
          ? { state: "done", page, error: null }
          : null,
    });
  }
  return { space, groups, done: doneRow?.done ?? 0 };
}
