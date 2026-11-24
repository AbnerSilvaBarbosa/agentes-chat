import { type Database, eq, rowsOf, type SQL, schema, sql } from "@agenteschat/db";
import { nanoUsdToUsd } from "@agenteschat/providers";
import { NotFoundError } from "./errors";
import { requireActiveMembership } from "./organizations";
import { taskSeenSql } from "./task-access";
import { canViewCost } from "./usage";

/**
 * A company's Painel (ADR 0226): the numbers of the tasks on its boards, for one viewer and one period. Read when the
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
  /** Every task of the company the viewer sees, canceled left out, whatever the period: 0 is the empty company. */
  total: number;
  /** Open tasks by stage, and the tasks concluded in the period. */
  stages: { todo: number; in_progress: number; in_review: number; done: number };
  /** Who carries the tasks, agents and people together; a person or agent that is gone is `removed` (no name). */
  assignees: { type: "agent" | "person" | "removed"; id: string; name: string; open: number; done: number }[];
  /** Open tasks with no assignee (the screen's last row). */
  unassigned: number;
  /** From a task's creation to its last conclusion, over the tasks concluded in the period. */
  leadTime: SpanStats;
  /** From the first time a task became Em andamento to its last conclusion; a task that never was is out of it. */
  workTime: SpanStats;
  /** One entry per week of the period (Monday's date in the workspace's time zone), a week with no delivery kept as 0. */
  weekly: { weekStart: string; count: number }[];
  /** Open tasks due before today (the workspace's time zone), whatever the period. */
  late: number;
  /**
   * What the agents' runs tied to the company's tasks cost, those started in the period. Null for a member who may not
   * view usage: it is never computed for them, so it is absent from what they are sent.
   */
  cost: { totalUsd: number; byAgent: { agentId: string; name: string; usd: number }[] } | null;
}

/** How long tasks took: how many were measured, the median and the average in milliseconds (null: none). */
export interface SpanStats {
  count: number;
  medianMs: number | null;
  averageMs: number | null;
}

/** The workspace's time zone, UTC when none is set (or it is not one Postgres reads). */
export async function workspaceTimezone(db: Database, orgId: string) {
  const [row] = await db
    .select({ tz: schema.organizationSettings.timezone })
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.orgId, orgId));
  const tz = row?.tz ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

const DAY_MS = 86_400_000;
/** The Monday of the week holding `date` ("YYYY-MM-DD"). */
const mondayOf = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`);
  return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY_MS;
};

export const OPEN = sql`status in ('todo', 'in_progress', 'in_review')`;

/**
 * The tasks of the company's boards (archived boards included) that `userId` sees, as a CTE named `vis`. Canceled
 * ones are in it: `t` (the next CTE) leaves them out of every count. A task counts for its first assignee only (the
 * first in its list, ADR 0188), whoever else has it.
 */
function visibleTasks(userId: string, orgId: string, spaceId: string) {
  return sql`vis as (
      select i.id, i.status, i.created_at, i.due_date, lead.assignee_type, lead.assignee_id
      from ${schema.issues} i join ${schema.issueProjects} p on p.id = i.project_id
      left join lateral (
        select ia.assignee_type, ia.assignee_id from ${schema.issueAssignees} ia
        where ia.issue_id = i.id order by ia.position limit 1
      ) lead on true
      where i.org_id = ${orgId}::uuid and p.space_id = ${spaceId}::uuid and ${taskSeenSql("i", sql`${userId}::text`)}
    ),
    t as (select * from vis where status <> 'canceled')`;
}

/**
 * The conclusion of each task of `t`: the task's status is `done` now and its last move to `done` (a status change or
 * a column move write the same event) is the date; a done task with no such event takes its creation.
 */
export const CONCLUDED = sql`ev as (
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
  const mayViewCost = await canViewCost(db, userId, orgId);
  const period = normalizeDays(days);
  const [space] = rowsOf<{ id: string }>(
    await db.execute(sql`select id from ${schema.issueSpaces} where id = ${spaceId}::uuid and org_id = ${orgId}::uuid`),
  );
  if (!space) throw new NotFoundError("Not found");
  const since = new Date(now.getTime() - period * DAY_MS).toISOString();
  const nowAt = now.toISOString();
  const tz = await workspaceTimezone(db, orgId);

  /** One read over the company's tasks: `select` sees `c`, each task with its conclusion and start. */
  const over = async <T>(select: SQL) =>
    rowsOf<T>(await db.execute(sql`with ${visibleTasks(userId, orgId, spaceId)}, ${CONCLUDED} ${select}`));
  const doneInPeriod = sql`done_at >= ${since}::timestamptz`;

  const [[stages], people, [times], weeks, [bounds], runs] = await Promise.all([
    over<{
      total: number;
      todo: number;
      in_progress: number;
      in_review: number;
      done: number;
      unassigned: number;
      late: number;
    }>(sql`select count(*)::int as total, count(*) filter (where status = 'todo')::int as todo,
        count(*) filter (where status = 'in_progress')::int as in_progress,
        count(*) filter (where status = 'in_review')::int as in_review,
        count(*) filter (where ${doneInPeriod})::int as done,
        count(*) filter (where ${OPEN} and assignee_id is null)::int as unassigned,
        count(*) filter (where ${OPEN} and due_date < (${nowAt}::timestamptz at time zone ${tz})::date)::int as late
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
        (ag.id is null and um.user_id is null) as removed,
        count(*) filter (where ${OPEN})::int as open, count(*) filter (where ${doneInPeriod})::int as done
      from c
      left join ${schema.agents} ag on c.assignee_type = 'agent' and ag.id::text = c.assignee_id and ag.org_id = ${orgId}::uuid
      -- A person is an assignee only while a member of the workspace: one who left reads as removed.
      left join ${schema.organizationMembers} um on c.assignee_type = 'person' and um.user_id = c.assignee_id
        and um.org_id = ${orgId}::uuid
      left join ${schema.users} u on um.user_id = u.id
      where c.assignee_id is not null
      group by c.assignee_type, c.assignee_id, ag.id, ag.name, um.user_id, u.name
      having count(*) filter (where ${OPEN}) > 0 or count(*) filter (where ${doneInPeriod}) > 0`),
    over<{
      lead_count: number;
      lead_median: number | null;
      lead_average: number | null;
      work_count: number;
      work_median: number | null;
      work_average: number | null;
    }>(sql`select count(lead)::int as lead_count, percentile_cont(0.5) within group (order by lead) as lead_median,
        avg(lead)::float8 as lead_average, count(work)::int as work_count,
        percentile_cont(0.5) within group (order by work) as work_median, avg(work)::float8 as work_average
      from (select greatest(0, extract(epoch from done_at - created_at) * 1000) as lead,
          case when first_start is not null then greatest(0, extract(epoch from done_at - first_start) * 1000) end as work
        from c where ${doneInPeriod}) m`),
    // A conclusion is never past now: a clock a little ahead still counts in this week.
    over<{
      week: string;
      count: number;
    }>(sql`select date_trunc('week', least(done_at, ${nowAt}::timestamptz) at time zone ${tz})::date::text as week,
        count(*)::int as count
      from c where ${doneInPeriod} group by 1`),
    rowsOf<{ first: string; today: string }>(
      await db.execute(sql`select (${since}::timestamptz at time zone ${tz})::date::text as first,
        (${nowAt}::timestamptz at time zone ${tz})::date::text as today`),
    ),
    // Only for who may view usage: the rows are not even read for anyone else.
    mayViewCost
      ? db
          .execute(
            sql`with ${visibleTasks(userId, orgId, spaceId)}
        select ar.agent_id::text as agent_id, ag.name, coalesce(sum(ur.cost_nano_usd), 0)::float8 as nano
        from ${schema.agentRuns} ar join vis on vis.id = ar.issue_id
        left join ${schema.agents} ag on ag.id = ar.agent_id and ag.org_id = ar.org_id
        left join ${schema.usageRecords} ur on ur.run_id = ar.id
        where ar.org_id = ${orgId}::uuid and ar.created_at >= ${since}::timestamptz
        group by ar.agent_id, ag.name`,
          )
          .then((r) => rowsOf<{ agent_id: string; name: string | null; nano: number }>(r))
      : Promise.resolve(null),
  ]);
  const { total, unassigned, late, ...counts } = stages ?? {
    total: 0,
    unassigned: 0,
    late: 0,
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
  };
  const assignees = people
    .map((p) => ({
      type: p.removed ? ("removed" as const) : p.kind === "agent" ? ("agent" as const) : ("person" as const),
      id: p.id,
      name: p.agent_name ?? p.person_name ?? "",
      open: p.open,
      done: p.done,
    }))
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const span = (count: number | undefined, median: number | null | undefined, average: number | null | undefined) => ({
    count: count ?? 0,
    medianMs: median == null ? null : Math.round(median),
    averageMs: average == null ? null : Math.round(average),
  });
  const delivered = new Map(weeks.map((w) => [w.week, w.count]));
  const weekly: CompanyDashboard["weekly"] = [];
  if (bounds) {
    for (let at = mondayOf(bounds.first); at <= mondayOf(bounds.today); at += 7 * DAY_MS) {
      const weekStart = new Date(at).toISOString().slice(0, 10);
      weekly.push({ weekStart, count: delivered.get(weekStart) ?? 0 });
    }
  }
  return {
    days: period,
    total,
    stages: counts,
    assignees,
    unassigned,
    leadTime: span(times?.lead_count, times?.lead_median, times?.lead_average),
    workTime: span(times?.work_count, times?.work_median, times?.work_average),
    weekly,
    late,
    cost: runs
      ? {
          totalUsd: nanoUsdToUsd(runs.reduce((n, r) => n + r.nano, 0)),
          byAgent: runs
            .map((r) => ({ agentId: r.agent_id, name: r.name ?? "", usd: nanoUsdToUsd(r.nano) }))
            .sort((a, b) => b.usd - a.usd || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
        }
      : null,
  };
}
