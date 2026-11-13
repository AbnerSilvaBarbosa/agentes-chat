import type { PubSub } from "@agenteschat/adapters";
import { and, type Database, desc, eq, inArray, isNull, schema, sql } from "@agenteschat/db";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { publishOrgEvent } from "./events";
import type { IssueStatus } from "./issues";
import { can, requireActiveMembership } from "./organizations";

const { issueColumns, issueColumnTemplates, issues, issueActivity } = schema;

/** The stages a board column can sit in, in board order (canceled stays out of the board). */
export const BOARD_STAGES: readonly IssueStatus[] = ["todo", "in_progress", "in_review", "done", "canceled"];

/** A board column. `name` null: the stage's own name, in the reader's language. */
export interface IssueColumnView {
  id: string;
  stage: IssueStatus;
  name: string | null;
  position: number;
  /** The board it belongs to; null: the workspace's own set, which a board uses until it has its own. */
  projectId: string | null;
}

/** A set of columns a board can be created from (ADR 0177). */
export interface ColumnTemplateView {
  id: string;
  name: string;
  columns: { name: string; stage: IssueStatus }[];
  /** One of the two this workspace started with, which it may not delete. */
  seeded: boolean;
}

type ColumnRow = typeof issueColumns.$inferSelect;
type TemplateRow = typeof issueColumnTemplates.$inferSelect;

const view = (c: ColumnRow): IssueColumnView => ({
  id: c.id,
  stage: c.stage,
  name: c.name,
  position: c.position,
  projectId: c.projectId,
});
const stageOrder = (s: IssueStatus) => BOARD_STAGES.indexOf(s);
const sortColumns = (rows: ColumnRow[]) =>
  [...rows].sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage) || a.position - b.position);

/** Columns a stage holds at most (the board's add dialog mirrors it: packages/client/src/lib/issues.ts). */
const STAGE_COLUMNS_MAX = 10;

/**
 * The two templates a workspace starts with (ADR 0177): a plain kanban, and the pipeline a software team runs — the
 * columns a person would otherwise build by hand on every board. Names are data, in the words of the person who set
 * the workspace up; a board created from one gets its own copy.
 */
export const SEEDED_TEMPLATES: { name: string; columns: { name: string; stage: IssueStatus }[] }[] = [
  {
    name: "Kanban",
    columns: [
      { name: "A fazer", stage: "todo" },
      { name: "Em andamento", stage: "in_progress" },
      { name: "Em revisão", stage: "in_review" },
      { name: "Concluído", stage: "done" },
    ],
  },
  {
    name: "Desenvolvimento",
    columns: [
      { name: "Backlog", stage: "todo" },
      { name: "Especificar", stage: "todo" },
      { name: "Ready for dev", stage: "in_progress" },
      { name: "Em dev", stage: "in_progress" },
      { name: "PR / Develop", stage: "in_review" },
      { name: "QA", stage: "in_review" },
      { name: "Ajuste", stage: "in_progress" },
      { name: "Deploy", stage: "in_progress" },
      { name: "Concluído", stage: "done" },
    ],
  },
];

/**
 * The workspace's own columns (a board without its own uses them), board order; the first use creates one per stage.
 * Never mixed with a board's own: see `boardColumns`.
 */
export async function boardColumns(db: Database, orgId: string): Promise<ColumnRow[]> {
  const rows = await db
    .select()
    .from(issueColumns)
    .where(and(eq(issueColumns.orgId, orgId), isNull(issueColumns.projectId)));
  if (rows.length > 0) return sortColumns(rows);
  // Two first readers at once must not both seed: the lock serializes them.
  const seeded = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`issue_columns:${orgId}`}))`);
    const again = await tx
      .select()
      .from(issueColumns)
      .where(and(eq(issueColumns.orgId, orgId), isNull(issueColumns.projectId)));
    if (again.length > 0) return again;
    return tx
      .insert(issueColumns)
      .values(BOARD_STAGES.map((stage) => ({ orgId, stage, name: null, position: 0 })))
      .returning();
  });
  return sortColumns(seeded);
}

/**
 * Every column of the workspace, the boards' and its own (ADR 0177): what a list of tasks from several boards needs to
 * resolve each one's column. Not a board's set: see `boardColumnsOf`.
 */
export async function allColumns(db: Database, orgId: string): Promise<ColumnRow[]> {
  const [rows] = await Promise.all([db.select().from(issueColumns).where(eq(issueColumns.orgId, orgId))]);
  if (rows.length === 0) return boardColumns(db, orgId);
  return sortColumns(rows);
}

/** The columns a board shows: its own when it has them, else the workspace's. */
export async function boardColumnsOf(db: Database, orgId: string, projectId: string | null): Promise<ColumnRow[]> {
  if (!projectId) return boardColumns(db, orgId);
  const own = await db
    .select()
    .from(issueColumns)
    .where(and(eq(issueColumns.orgId, orgId), eq(issueColumns.projectId, projectId)));
  return own.length > 0 ? sortColumns(own) : boardColumns(db, orgId);
}

/**
 * The board's own columns, made from the workspace's the first time it changes them (ADR 0177): editing a board never
 * edits the workspace's set, so a board that never asked keeps following it.
 */
export async function ensureBoardColumns(db: Database, orgId: string, projectId: string): Promise<ColumnRow[]> {
  const own = await db
    .select()
    .from(issueColumns)
    .where(and(eq(issueColumns.orgId, orgId), eq(issueColumns.projectId, projectId)));
  if (own.length > 0) return sortColumns(own);
  // Read (and seed, if need be) outside the transaction: `boardColumns` opens one of its own, and one connection
  // can't hold two.
  const base = await boardColumns(db, orgId);
  const copied = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`issue_columns:${orgId}:${projectId}`}))`);
    const again = await tx
      .select()
      .from(issueColumns)
      .where(and(eq(issueColumns.orgId, orgId), eq(issueColumns.projectId, projectId)));
    if (again.length > 0) return again;
    return tx
      .insert(issueColumns)
      .values(
        base.map((c) => ({
          orgId,
          projectId,
          stage: c.stage,
          name: c.name,
          position: c.position,
        })),
      )
      .returning();
  });
  return sortColumns(copied);
}

/** Where an issue sits on the board: its column, or the first column of its stage. */
export function columnOf(columns: ColumnRow[], issue: { status: IssueStatus; columnId: string | null }) {
  const own = issue.columnId ? columns.find((c) => c.id === issue.columnId && c.stage === issue.status) : undefined;
  return own ?? columns.find((c) => c.stage === issue.status) ?? null;
}

/** On top of a column: lower ranks come first, and later moves get lower ranks. */
export const topRank = () => -Date.now();

export interface ColumnDeps {
  db: Database;
  pubsub?: PubSub;
}

async function requirePoster(db: Database, userId: string, orgId: string) {
  const membership = await requireActiveMembership(db, userId, orgId);
  if (!can(membership, "post")) throw new ForbiddenError();
}

async function announce(deps: ColumnDeps, orgId: string) {
  const columns = (await allColumns(deps.db, orgId)).map(view);
  await publishOrgEvent(deps.pubsub, { type: "org.broadcast", orgId, event: { type: "issue.columns", columns } });
  return columns;
}

const cleanName = (name: string) => {
  const n = name.trim().slice(0, 40);
  if (!n) throw new ValidationError("name is required");
  return n;
};

/** The columns of one board (`projectId`) or of the workspace (`null`), as the board shows them. */
export async function listIssueColumns(
  db: Database,
  userId: string,
  orgId: string,
  projectId: string | null = null,
): Promise<IssueColumnView[]> {
  await requireActiveMembership(db, userId, orgId);
  return (await boardColumnsOf(db, orgId, projectId)).map(view);
}

/** Adds a column to a stage of one board (or of the workspace): right after `afterId` when it is in the same stage. */
export async function createIssueColumn(
  deps: ColumnDeps,
  userId: string,
  orgId: string,
  input: { name: string; stage: IssueStatus; afterId?: string | null; projectId?: string | null },
): Promise<IssueColumnView[]> {
  await requirePoster(deps.db, userId, orgId);
  if (!BOARD_STAGES.includes(input.stage)) throw new ValidationError("invalid stage");
  const name = cleanName(input.name);
  const projectId = input.projectId ?? null;
  // A board that had none takes the workspace's as its own first: the change lands there, never on the workspace.
  const columns = projectId ? await ensureBoardColumns(deps.db, orgId, projectId) : await boardColumns(deps.db, orgId);
  const inStage = columns.filter((c) => c.stage === input.stage);
  if (inStage.length >= STAGE_COLUMNS_MAX) {
    throw new ValidationError(`A stage holds at most ${STAGE_COLUMNS_MAX} columns`, "issue_column.stage_full", {
      max: STAGE_COLUMNS_MAX,
    });
  }
  const at = input.afterId ? inStage.findIndex((c) => c.id === input.afterId) : -1;
  const before = at >= 0 ? inStage[at] : inStage.at(-1);
  const next = at >= 0 ? inStage[at + 1] : undefined;
  const position = !before ? 0 : next ? (before.position + next.position) / 2 : before.position + 1;
  await deps.db.insert(issueColumns).values({ orgId, projectId, stage: input.stage, name, position });
  return announce(deps, orgId);
}

/** Renames a column, or moves it inside its stage (`index`: its place among the stage's columns). */
export async function updateIssueColumn(
  deps: ColumnDeps,
  userId: string,
  orgId: string,
  columnId: string,
  patch: { name?: string; index?: number },
): Promise<IssueColumnView[]> {
  await requirePoster(deps.db, userId, orgId);
  const column = (
    await deps.db
      .select()
      .from(issueColumns)
      .where(and(eq(issueColumns.id, columnId), eq(issueColumns.orgId, orgId)))
  )[0];
  if (!column) throw new NotFoundError("Column not found");
  const columns = column.projectId
    ? await boardColumnsOf(deps.db, orgId, column.projectId)
    : await boardColumns(deps.db, orgId);
  if (patch.name !== undefined) {
    await deps.db
      .update(issueColumns)
      .set({ name: cleanName(patch.name) })
      .where(eq(issueColumns.id, column.id));
  }
  if (patch.index !== undefined) {
    const others = columns.filter((c) => c.stage === column.stage && c.id !== column.id);
    const at = Math.max(0, Math.min(others.length, Math.trunc(patch.index)));
    const order = [...others.slice(0, at), column, ...others.slice(at)];
    await deps.db.transaction(async (tx) => {
      for (const [i, c] of order.entries()) {
        if (c.position !== i) await tx.update(issueColumns).set({ position: i }).where(eq(issueColumns.id, c.id));
      }
    });
  }
  return announce(deps, orgId);
}

/**
 * Deletes a column; its issues go to `moveTo` (and to that column's stage, which is an event in each one's activity). A
 * stage keeps at least one column.
 */
export async function deleteIssueColumn(
  deps: ColumnDeps,
  userId: string,
  orgId: string,
  columnId: string,
  moveTo: string,
): Promise<IssueColumnView[]> {
  await requirePoster(deps.db, userId, orgId);
  const column = (
    await deps.db
      .select()
      .from(issueColumns)
      .where(and(eq(issueColumns.id, columnId), eq(issueColumns.orgId, orgId)))
  )[0];
  if (!column) throw new NotFoundError("Column not found");
  const columns = column.projectId
    ? await boardColumnsOf(deps.db, orgId, column.projectId)
    : await boardColumns(deps.db, orgId);
  const target = columns.find((c) => c.id === moveTo);
  if (!target || target.id === column.id) throw new ValidationError("Choose another column for its tasks");
  if (!columns.some((c) => c.stage === column.stage && c.id !== column.id)) {
    throw new ValidationError("Each stage keeps at least one column");
  }
  // Issues with no column sit in the stage's first column: when that is the one going away, they move too.
  const firstOfStage = columns.find((c) => c.stage === column.stage)?.id === column.id;
  await deps.db.transaction(async (tx) => {
    const moving = await tx
      .select({ id: issues.id, status: issues.status })
      .from(issues)
      .where(
        and(
          eq(issues.orgId, orgId),
          firstOfStage
            ? sql`(${issues.columnId} = ${column.id} or (${issues.columnId} is null and ${issues.status} = ${column.stage}))`
            : eq(issues.columnId, column.id),
        ),
      );
    for (const m of moving) {
      await tx
        .update(issues)
        .set({ columnId: target.id, status: target.stage, updatedAt: new Date() })
        .where(eq(issues.id, m.id));
      if (m.status !== target.stage) {
        await tx.insert(issueActivity).values({
          orgId,
          issueId: m.id,
          kind: "event",
          authorType: "person",
          authorId: userId,
          text: `moved to ${target.name ?? target.stage} (its column was deleted)`,
          event: "status_changed",
          data: { from: m.status, to: target.stage },
        });
      }
    }
    await tx.delete(issueColumns).where(eq(issueColumns.id, column.id));
  });
  return announce(deps, orgId);
}

/**
 * Validates a column for an issue move (ADR 0177): it must be a column of that task's board, or one of the workspace's
 * when the board has none of its own.
 */
export async function columnForMove(db: Database, orgId: string, columnId: string, projectId?: string | null) {
  const [column] = await db
    .select()
    .from(issueColumns)
    .where(and(eq(issueColumns.id, columnId), eq(issueColumns.orgId, orgId)));
  if (!column) throw new ValidationError("That column does not exist");
  if (projectId && column.projectId && column.projectId !== projectId) {
    throw new ValidationError("That column belongs to another board");
  }
  if (projectId && !column.projectId) {
    // The workspace's own columns stand in for a board that has none; a board with its own takes only those.
    const own = await db
      .select({ id: issueColumns.id })
      .from(issueColumns)
      .where(and(eq(issueColumns.orgId, orgId), eq(issueColumns.projectId, projectId)))
      .limit(1);
    if (own.length > 0) throw new ValidationError("That column belongs to the workspace, not to this board");
  }
  return column;
}

// ── Templates ────────────────────────────────────────────────────────────────

const templateRef = (t: TemplateRow): ColumnTemplateView => ({
  id: t.id,
  name: t.name,
  columns: t.columns as { name: string; stage: IssueStatus }[],
  seeded: SEEDED_TEMPLATES.some((s) => s.name.toLowerCase() === t.name.toLowerCase()),
});

/** The workspace's templates, the two seeded ones first; the first use creates them. */
export async function columnTemplates(db: Database, orgId: string): Promise<TemplateRow[]> {
  const rows = await db
    .select()
    .from(issueColumnTemplates)
    .where(eq(issueColumnTemplates.orgId, orgId))
    .orderBy(desc(issueColumnTemplates.createdAt));
  if (rows.length >= SEEDED_TEMPLATES.length) return rows;
  const seeded = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`issue_templates:${orgId}`}))`);
    const again = await tx
      .select()
      .from(issueColumnTemplates)
      .where(eq(issueColumnTemplates.orgId, orgId))
      .orderBy(desc(issueColumnTemplates.createdAt));
    if (again.length >= SEEDED_TEMPLATES.length) return again;
    const have = new Set(again.map((r) => r.name.toLowerCase()));
    const missing = SEEDED_TEMPLATES.filter((s) => !have.has(s.name.toLowerCase()));
    if (missing.length === 0) return again;
    await tx
      .insert(issueColumnTemplates)
      .values(missing.map((s) => ({ orgId, name: s.name, columns: s.columns })))
      .onConflictDoNothing();
    return tx
      .select()
      .from(issueColumnTemplates)
      .where(eq(issueColumnTemplates.orgId, orgId))
      .orderBy(desc(issueColumnTemplates.createdAt));
  });
  return seeded;
}

export async function listColumnTemplates(db: Database, userId: string, orgId: string) {
  await requireActiveMembership(db, userId, orgId);
  return (await columnTemplates(db, orgId)).map(templateRef);
}

/** A template by its name, in any capitals. */
export async function templateByName(db: Database, orgId: string, name: string) {
  const rows = await columnTemplates(db, orgId);
  return rows.find((t) => t.name.toLowerCase() === name.trim().toLowerCase()) ?? null;
}

/**
 * A board's columns become this template's (ADR 0177): the board gets its own copy, and the tasks of columns it no
 * longer has move to the first column of their stage.
 */
export async function applyColumnTemplate(
  deps: ColumnDeps,
  userId: string,
  orgId: string,
  projectId: string,
  templateId: string,
): Promise<IssueColumnView[]> {
  await requirePoster(deps.db, userId, orgId);
  const templates = await columnTemplates(deps.db, orgId);
  const template = templates.find((t) => t.id === templateId);
  if (!template) throw new NotFoundError("Template not found");
  const wanted = (template.columns as { name: string; stage: IssueStatus }[]).filter((c) =>
    BOARD_STAGES.includes(c.stage),
  );
  if (wanted.length === 0) throw new ValidationError("That template has no columns");
  // Copy-on-write first: a board that still followed the workspace gets its own set, then it is replaced.
  await ensureBoardColumns(deps.db, orgId, projectId);
  await deps.db.transaction(async (tx) => {
    const before = await tx
      .select()
      .from(issueColumns)
      .where(and(eq(issueColumns.orgId, orgId), eq(issueColumns.projectId, projectId)));
    await tx.delete(issueColumns).where(and(eq(issueColumns.orgId, orgId), eq(issueColumns.projectId, projectId)));
    const created = await tx
      .insert(issueColumns)
      .values(
        wanted.map((c, i) => ({
          orgId,
          projectId,
          stage: c.stage,
          name: c.name.trim().slice(0, 40) || null,
          position: i,
        })),
      )
      .returning();
    // Every task of the board whose column is gone lands in the first column of its stage.
    const byStage = (stage: string) => created.find((c) => c.stage === stage) ?? created[0];
    const gone = new Set(before.map((c) => c.id));
    const tasks = await tx
      .select({ id: issues.id, status: issues.status, columnId: issues.columnId })
      .from(issues)
      .where(and(eq(issues.orgId, orgId), eq(issues.projectId, projectId)));
    for (const task of tasks) {
      if (task.columnId && !gone.has(task.columnId)) continue;
      const column = byStage(task.status);
      if (!column) continue;
      await tx
        .update(issues)
        .set({ columnId: column.id, status: column.stage as IssueStatus, updatedAt: new Date() })
        .where(eq(issues.id, task.id));
    }
  });
  return announce(deps, orgId);
}

/** Saves a board's columns (or the workspace's) as a template the other boards can start from. */
export async function saveColumnTemplate(
  deps: ColumnDeps,
  userId: string,
  orgId: string,
  input: { name: string; projectId?: string | null },
): Promise<ColumnTemplateView> {
  await requirePoster(deps.db, userId, orgId);
  const name = input.name.trim().slice(0, 60);
  if (!name) throw new ValidationError("name is required");
  const columns = (await boardColumnsOf(deps.db, orgId, input.projectId ?? null)).map((c) => ({
    name: c.name ?? c.stage,
    stage: c.stage,
  }));
  if (columns.length === 0) throw new ValidationError("There are no columns to save");
  const [row] = await deps.db
    .insert(issueColumnTemplates)
    .values({ orgId, name, columns })
    .onConflictDoNothing()
    .returning();
  if (!row)
    throw new ValidationError(`There is already a template named "${name}"`, "issue_template.name_taken", { name });
  return templateRef(row);
}

/** Deletes a template. The boards made from it keep their columns. */
export async function deleteColumnTemplate(deps: ColumnDeps, userId: string, orgId: string, templateId: string) {
  await requirePoster(deps.db, userId, orgId);
  const gone = await deps.db
    .delete(issueColumnTemplates)
    .where(and(eq(issueColumnTemplates.id, templateId), eq(issueColumnTemplates.orgId, orgId)))
    .returning({ id: issueColumnTemplates.id });
  if (gone.length === 0) throw new NotFoundError("Template not found");
}

/** The columns of a board, by their ids: what a new task in that board may start in. */
export async function columnsOfBoard(db: Database, orgId: string, projectId: string | null) {
  const rows = await boardColumnsOf(db, orgId, projectId);
  return rows.map(view);
}

/** The first column of each stage, for a board: where the system puts a task that has none. */
export async function firstColumnsOfBoard(db: Database, orgId: string, projectId: string | null) {
  const rows = await boardColumnsOf(db, orgId, projectId);
  return new Map(rows.map((c) => [c.stage, c]));
}

/** Every column of these boards, by id (a list across boards resolves each one's column). */
export async function columnsById(db: Database, orgId: string, ids: string[]) {
  if (ids.length === 0) return new Map<string, ColumnRow>();
  const rows = await db
    .select()
    .from(issueColumns)
    .where(and(eq(issueColumns.orgId, orgId), inArray(issueColumns.id, ids)));
  return new Map(rows.map((c) => [c.id, c]));
}
