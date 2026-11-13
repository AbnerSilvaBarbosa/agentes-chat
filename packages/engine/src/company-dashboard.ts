import { type Database, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { NotFoundError } from "./errors";
import { requireActiveMembership } from "./organizations";
import { taskSeenSql } from "./task-access";

/**
 * A company's Painel (ADR 0182): the numbers of the tasks on its boards, for one viewer and one period. Read when the
 * tab opens, from rows that exist (`issues`, `issue_activity`); nothing is stored.
 */

export const DASHBOARD_DAYS = [7, 30, 90] as const;
export type DashboardDays = (typeof DASHBOARD_DAYS)[number];

/** The period's length in days: 7, 30 or 90; anything else is 30. */
export function normalizeDays(days: unknown): DashboardDays {
  const n = typeof days === "string" ? Number(days) : days;
  return DASHBOARD_DAYS.find((d) => d === n) ?? 30;
}

export interface CompanyDashboard {
  days: DashboardDays;
  /** Open tasks by stage, and the tasks concluded in the period. */
  stages: { todo: number; in_progress: number; in_review: number; done: number };
  /** Who carries the tasks, agents and people together; a person or agent that is gone is `removed` (no name). */
  assignees: { type: "agent" | "person" | "removed"; id: string; name: string; open: number; done: number }[];
  /** Open tasks with no assignee (the screen's last row). */
  unassigned: number;
}

const OPEN = sql`status in ('todo', 'in_progress', 'in_review')`;

/**
 * The tasks of the company's boards (archived boards included) that `userId` sees, as a CTE named `vis`. Canceled
 * ones are in it: `t` (the next CTE) leaves them out of every count.
 */
function visibleTasks(userId: string, orgId: string, spaceId: string) {
  return sql`vis as (
      select i.id, i.status, i.created_at, i.due_date, i.assignee_type, i.assignee_id
      from ${schema.issues} i join ${schema.issueProjects} p on p.id = i.project_id
      where i.org_id = ${orgId}::uuid and p.space_id = ${spaceId}::uuid and ${taskSeenSql("i", sql`${userId}::text`)}
    ),
    t as (select * from vis where status <> 'canceled')`;
}

/**
 * The conclusion of each task of `t`: the task's status is `done` now and its last move to `done` (a status change or
 * a column move write the same event) is the date; a done task with no such event takes its creation.
 */
const CONCLUDED = sql`ev as (
      select a.issue_id, max(a.created_at) filter (where a.data->>'to' = 'done') as last_done,
        min(a.created_at) filter (where a.data->>'to' = 'in_progress') as first_start
      from ${schema.issueActivity} a join t on t.id = a.issue_id
      where a.event = 'status_changed' group by a.issue_id
    ),
    c as (
      select t.*, ev.first_start,
        case when t.status = 'done' then coalesce(ev.last_done, t.created_at) end as done_at
      from t left join ev on ev.issue_id = t.id
    )`;

/** The company's numbers for `userId` over the last `days` days (`now`: for tests). */
export async function companyDashboard(
  db: Database,
  userId: string,
  orgId: string,
  spaceId: string,
  days: unknown,
  now: Date = new Date(),
): Promise<CompanyDashboard> {
  await requireActiveMembership(db, userId, orgId);
  const period = normalizeDays(days);
  const [space] = rowsOf<{ id: string }>(
    await db.execute(sql`select id from ${schema.issueSpaces} where id = ${spaceId}::uuid and org_id = ${orgId}::uuid`),
  );
  if (!space) throw new NotFoundError("Not found");
  const since = new Date(now.getTime() - period * 86_400_000).toISOString();

  /** One read over the company's tasks: `select` sees `c`, each task with its conclusion and start. */
  const over = async <T>(select: SQL) =>
    rowsOf<T>(await db.execute(sql`with ${visibleTasks(userId, orgId, spaceId)}, ${CONCLUDED} ${select}`));
  const doneInPeriod = sql`done_at >= ${since}::timestamptz`;

  const [[stages], people] = await Promise.all([
    over<{
      todo: number;
      in_progress: number;
      in_review: number;
      done: number;
      unassigned: number;
    }>(sql`select count(*) filter (where status = 'todo')::int as todo,
        count(*) filter (where status = 'in_progress')::int as in_progress,
        count(*) filter (where status = 'in_review')::int as in_review,
        count(*) filter (where ${doneInPeriod})::int as done,
        count(*) filter (where ${OPEN} and assignee_id is null)::int as unassigned
      from c`),
    over<{
      kind: string;
      id: string;
      agent_name: string | null;
      person_name: string | null;
      removed: boolean;
      open: number;
      done: number;
    }>(sql`select c.assignee_type as kind, c.assignee_id as id, ag.name as agent_name, u.name as person_name,
        (ag.id is null and u.id is null) as removed,
        count(*) filter (where ${OPEN})::int as open, count(*) filter (where ${doneInPeriod})::int as done
      from c
      left join ${schema.agents} ag on c.assignee_type = 'agent' and ag.id::text = c.assignee_id and ag.org_id = ${orgId}::uuid
      left join ${schema.users} u on c.assignee_type = 'person' and u.id = c.assignee_id
      where c.assignee_id is not null
      group by c.assignee_type, c.assignee_id, ag.id, ag.name, u.id, u.name
      having count(*) filter (where ${OPEN}) > 0 or count(*) filter (where ${doneInPeriod}) > 0`),
  ]);
  const { unassigned = 0, ...counts } = stages ?? { todo: 0, in_progress: 0, in_review: 0, done: 0 };
  const assignees = people
    .map((p) => ({
      type: p.removed ? ("removed" as const) : p.kind === "agent" ? ("agent" as const) : ("person" as const),
      id: p.id,
      name: p.agent_name ?? p.person_name ?? "",
      open: p.open,
      done: p.done,
    }))
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { days: period, stages: counts, assignees, unassigned };
}
