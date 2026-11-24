import { type Database, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { CONCLUDED, OPEN, workspaceTimezone } from "./company-dashboard";
import { effectiveColumnSql, waitingSql } from "./issue-columns";
import { spaceImageUrl } from "./issue-projects";
import { requireActiveMembership } from "./organizations";
import { taskSeenSql } from "./task-access";

/**
 * The factory on Início (ADR 0228): one panel per company and the tasks that wait for a person, for one viewer. Read
 * when Início opens, from rows that exist; nothing is stored. The stage, done and late definitions are the company
 * Painel's (`OPEN`, `CONCLUDED`, `workspaceTimezone`), so the two never drift.
 */

/** Panels a read returns at most; `companiesTotal` says how many there are. */
export const FACTORY_COMPANIES_MAX = 20;
/** Waiting tasks listed at most; `waiting.total` counts them all. */
export const FACTORY_WAITING_MAX = 5;
/** The days "done" looks back over on a panel. */
export const FACTORY_DONE_DAYS = 7;

const DAY_MS = 86_400_000;

export interface FactoryCompany {
  id: string;
  name: string;
  color: string;
  image: string | null;
  /** Open tasks by stage; `done` is what was concluded in the last 7 days. */
  stages: { todo: number; in_progress: number; in_review: number; done: number };
  late: number;
  waiting: number;
}

export interface WaitingTask {
  id: string;
  number: number;
  title: string;
  stage: "todo" | "in_progress" | "in_review";
  spaceId: string;
  spaceName: string;
  projectId: string;
  projectName: string;
  /** Null: the stage's own name. */
  columnName: string | null;
  /** ISO time of the task's last change of status, column or board. */
  since: string;
}

export interface FactoryHome {
  /** At most 20, most waiting first, then by name. */
  companies: FactoryCompany[];
  /** Every company with a live task the viewer sees. */
  companiesTotal: number;
  waiting: { total: number; items: WaitingTask[] };
}

/**
 * The live tasks `userId` sees, as a CTE named `live`: not canceled, on a board and a company that are not archived.
 * With `columns`, each one also carries the column it sits in and whether it waits for a person; without, nothing
 * waits (a workspace that flagged no column skips the per-task column read).
 */
function liveTasks(userId: string, orgId: string, columns: boolean): SQL {
  const column = columns ? sql`${effectiveColumnSql("i")}` : sql``;
  const waiting = columns ? waitingSql("i") : sql`false`;
  const columnName = columns ? sql`col.name` : sql`null::text`;
  return sql`live as (
      select i.id, i.number, i.title, i.status, i.created_at, i.due_date, i.column_since, i.project_id,
        s.id as space_id, s.name as space_name, p.name as project_name,
        ${columnName} as column_name, ${waiting} as waiting
      from ${schema.issues} i
      join ${schema.issueProjects} p on p.id = i.project_id
      join ${schema.issueSpaces} s on s.id = p.space_id
      ${column}
      where i.org_id = ${orgId}::uuid and p.archived_at is null and s.archived_at is null
        and i.status <> 'canceled' and ${taskSeenSql("i", sql`${userId}::text`)}
    ),
    t as (select * from live)`;
}

/** Whether the workspace flagged any column: without one nothing waits, and no task needs its column read. */
async function anyFlagged(db: Database, orgId: string) {
  const [row] = rowsOf<{ flagged: boolean }>(
    await db.execute(
      sql`select exists (select 1 from ${schema.issueColumns} where org_id = ${orgId}::uuid and waits_for_person) as flagged`,
    ),
  );
  return row?.flagged === true;
}

/** The factory for `userId`: the panels, and the tasks waiting for a person (`now`: for tests). */
export async function factoryHome(
  db: Database,
  userId: string,
  orgId: string,
  now: Date = new Date(),
): Promise<FactoryHome> {
  await requireActiveMembership(db, userId, orgId);
  const tz = await workspaceTimezone(db, orgId);
  const flagged = await anyFlagged(db, orgId);
  const since = new Date(now.getTime() - FACTORY_DONE_DAYS * DAY_MS).toISOString();
  const nowAt = now.toISOString();

  const panels = rowsOf<{
    id: string;
    name: string;
    color: string;
    image: string | null;
    todo: number;
    in_progress: number;
    in_review: number;
    done: number;
    late: number;
    waiting: number;
    total: number;
  }>(
    await db.execute(sql`with ${liveTasks(userId, orgId, flagged)}, ${CONCLUDED}
      select s.id, s.name, s.color, s.image, g.todo, g.in_progress, g.in_review, g.done, g.late, g.waiting, g.total
      from (
        select space_id,
          count(*) filter (where status = 'todo')::int as todo,
          count(*) filter (where status = 'in_progress')::int as in_progress,
          count(*) filter (where status = 'in_review')::int as in_review,
          count(*) filter (where done_at >= ${since}::timestamptz)::int as done,
          count(*) filter (where ${OPEN} and due_date < (${nowAt}::timestamptz at time zone ${tz})::date)::int as late,
          count(*) filter (where waiting)::int as waiting,
          (count(*) over ())::int as total
        from c group by space_id
      ) g join ${schema.issueSpaces} s on s.id = g.space_id
      order by g.waiting desc, lower(s.name), s.id
      limit ${FACTORY_COMPANIES_MAX}`),
  );
  // The tasks in flagged columns, longest waiting first: a workspace that flagged none reads nothing.
  const waitingRows = flagged
    ? rowsOf<{
        id: string;
        number: number;
        title: string;
        status: WaitingTask["stage"];
        space_id: string;
        space_name: string;
        project_id: string;
        project_name: string;
        column_name: string | null;
        column_since: Date | string;
        total: number;
      }>(
        await db.execute(sql`with ${liveTasks(userId, orgId, true)}
      select id, number, title, status, space_id, space_name, project_id, project_name, column_name,
        column_since, (count(*) over ())::int as total
      from live where waiting
      order by column_since asc, number asc, id asc
      limit ${FACTORY_WAITING_MAX}`),
      )
    : [];
  return {
    companies: panels.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      image: p.image ? spaceImageUrl(orgId, p.image) : null,
      stages: { todo: p.todo, in_progress: p.in_progress, in_review: p.in_review, done: p.done },
      late: p.late,
      waiting: p.waiting,
    })),
    companiesTotal: panels[0]?.total ?? 0,
    waiting: {
      total: waitingRows[0]?.total ?? 0,
      items: waitingRows.map((r) => ({
        id: r.id,
        number: r.number,
        title: r.title,
        stage: r.status,
        spaceId: r.space_id,
        spaceName: r.space_name,
        projectId: r.project_id,
        projectName: r.project_name,
        columnName: r.column_name,
        since: new Date(r.column_since).toISOString(),
      })),
    },
  };
}
