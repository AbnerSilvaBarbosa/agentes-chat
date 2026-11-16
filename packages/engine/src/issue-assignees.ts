import { and, asc, type Database, type Executor, eq, inArray, type SQL, schema, sql } from "@agenteschat/db";
import { ValidationError } from "./errors";
import { checkAssignee, type TaskScope, type WorkActor } from "./issues";

const { issueCoAssignees, issueActivity, issues, outbox, users, agents } = schema;

/**
 * Who is responsible on a card (ADR 0186). A card has at most one agent, which is always its principal, and people in
 * order. `issues.assignee_type/assignee_id` hold the principal, and `issue_co_assignees` the people beside it, so every
 * reader that wakes an agent keeps reading one column. This file is the one place that decides a change and writes it.
 */

/** The most people "also with" a card may have beside its principal. */
export const ASSIGNEES_MAX = 5;

/** `agentId` is the card's agent, if any; `people` are the person ids in order. The principal is the agent, else `people[0]`. */
export interface Assignment {
  agentId: string | null;
  people: string[];
}

/** One request to change who is on a card. Its pieces apply in the order they are listed here. */
export interface AssigneeChange {
  /** The whole list: replaces the agent and the people. */
  assignees?: WorkActor[];
  /** The hand-off: an agent replaces the agent; a person is added beside an agent, or replaces the principal without one; `null` clears everyone. */
  assignee?: WorkActor | null;
  remove?: WorkActor[];
  add?: WorkActor[];
  /** Moves a person to the front; refused while an agent is on the card. */
  principal?: WorkActor;
}

const unique = <T>(list: T[]) => [...new Set(list)];

/** The people of a list of actors, deduped, in order. */
const peopleOf = (list: WorkActor[]) => unique(list.filter((a) => a.type === "person").map((a) => a.id));

/** The one agent a list names; two different agents are refused. */
function agentIn(list: WorkActor[]): string | null {
  const agents = unique(list.filter((a) => a.type === "agent").map((a) => a.id));
  if (agents.length > 1) throw twoAgents();
  return agents[0] ?? null;
}

const twoAgents = () =>
  new ValidationError("A card has at most one agent. Hand it to the agent you want instead", "issue.two_agents");

/** The card's principal as its two columns, and the people beside it as rows (read back by `assignmentOf`). */
export function assignmentOf(
  row: { assigneeType: string | null; assigneeId: string | null },
  co: string[],
): Assignment {
  if (!row.assigneeType || !row.assigneeId) return { agentId: null, people: [] };
  if (row.assigneeType === "agent") return { agentId: row.assigneeId, people: [...co] };
  return { agentId: null, people: unique([row.assigneeId, ...co]) };
}

/** The principal's two columns. */
export function columnsOf(a: Assignment): { assigneeType: "person" | "agent" | null; assigneeId: string | null } {
  if (a.agentId) return { assigneeType: "agent", assigneeId: a.agentId };
  const first = a.people[0];
  return first ? { assigneeType: "person", assigneeId: first } : { assigneeType: null, assigneeId: null };
}

/** The people "also with": every person beside an agent, or all but the first without one. */
export const alsoWithOf = (a: Assignment) => (a.agentId ? a.people : a.people.slice(1));

/**
 * The result of a change, or a refusal that changes nothing. Pure: no database, `before` is never touched. The pieces
 * apply as `assignees`, `assignee`, `remove`, `add`, `principal`, then the limit is checked on who is also with.
 */
export function planAssignees(before: Assignment, change: AssigneeChange): Assignment {
  let agentId = before.agentId;
  let people = [...before.people];

  if (change.assignees) {
    agentId = agentIn(change.assignees);
    people = peopleOf(change.assignees);
  }

  if (change.assignee !== undefined) {
    const to = change.assignee;
    if (to === null) {
      agentId = null;
      people = [];
    } else if (to.type === "agent") {
      agentId = to.id;
    } else if (agentId) {
      if (!people.includes(to.id)) people.push(to.id);
    } else {
      people = unique([to.id, ...people.slice(1)]);
    }
  }

  if (change.remove) {
    const gone = new Set(change.remove.filter((a) => a.type === "person").map((a) => a.id));
    people = people.filter((id) => !gone.has(id));
    if (agentId && change.remove.some((a) => a.type === "agent" && a.id === agentId)) agentId = null;
  }

  if (change.add) {
    const agent = agentIn(change.add);
    if (agent && agent !== agentId) {
      if (agentId) throw twoAgents();
      agentId = agent;
    }
    people = unique([...people, ...peopleOf(change.add)]);
  }

  if (change.principal) {
    const wanted = change.principal;
    if (wanted.type === "agent") {
      if (wanted.id !== agentId) throw notOnCard();
    } else if (agentId) {
      throw new ValidationError(
        "The card's agent is its principal. Hand the card to a person to change that",
        "issue.principal_is_agent",
      );
    } else if (!people.includes(wanted.id)) {
      throw notOnCard();
    } else {
      people = [wanted.id, ...people.filter((id) => id !== wanted.id)];
    }
  }

  const after = { agentId, people };
  if (alsoWithOf(after).length > ASSIGNEES_MAX) {
    throw new ValidationError(
      agentId && people.length > ASSIGNEES_MAX
        ? `Take someone off the card before handing it to an agent: at most ${ASSIGNEES_MAX} people can be on it beside the agent`
        : `A card has at most ${ASSIGNEES_MAX} people beside its principal`,
      "issue.assignees_max",
    );
  }
  return after;
}

const notOnCard = () => new ValidationError("That person is not on the card", "issue.principal_not_on_card");

/** A card's principal: its agent, else its first person. */
function principalOf(a: Assignment): WorkActor | null {
  if (a.agentId) return { type: "agent", id: a.agentId };
  const first = a.people[0];
  return first ? { type: "person", id: first } : null;
}

export interface AssigneeEvent {
  text: string;
  event: "assigned" | "agent_replaced" | "assignee_added" | "assignee_removed" | "principal_changed";
  data: Record<string, unknown>;
}

/**
 * What the card's history says about a change, pure. A principal that changed is one `assigned` event (or
 * `agent_replaced` between two agents, or `principal_changed` for a swap among people); each person gained beside it is
 * `assignee_added` and each person lost `assignee_removed`. Everyone taken off is the single `assigned` event with no
 * assignee. Names go into `data` so the history reads right after a rename or a removal.
 */
export function assigneeEvents(
  before: Assignment,
  after: Assignment,
  name: (who: WorkActor) => string,
): AssigneeEvent[] {
  const events: AssigneeEvent[] = [];
  const was = principalOf(before);
  const now = principalOf(after);
  const same = was?.type === now?.type && was?.id === now?.id;
  const person = (id: string): WorkActor => ({ type: "person", id });
  let announced: string | null = null;

  if (before.agentId && after.agentId && before.agentId !== after.agentId) {
    const from = name({ type: "agent", id: before.agentId });
    const to = name({ type: "agent", id: after.agentId });
    events.push({
      text: `handed the issue from ${from} to ${to}`,
      event: "agent_replaced",
      data: {
        from: { agentId: before.agentId, name: from },
        to: { agentId: after.agentId, name: to },
        kept: after.people.length,
      },
    });
  } else if (!same) {
    if (!now) {
      return [{ text: "removed the assignee", event: "assigned", data: { assignee: null } }];
    }
    const swap =
      !before.agentId &&
      !after.agentId &&
      was !== null &&
      before.people.includes(now.id) &&
      after.people.includes(was.id);
    if (swap) {
      events.push({
        text: `made ${name(now)} the principal`,
        event: "principal_changed",
        data: { assignee: now, name: name(now) },
      });
    } else {
      // Promoted: a person who was already on the card became its principal (the agent left, or the principal did).
      const promoted = now.type === "person" && before.people.includes(now.id);
      events.push({
        text: "assigned the issue",
        event: "assigned",
        data: { assignee: now, ...(promoted ? { promoted: true } : {}) },
      });
    }
    if (now.type === "person") announced = now.id;
  }

  for (const id of after.people) {
    if (before.people.includes(id) || id === announced) continue;
    events.push({
      text: `added ${name(person(id))} to the issue`,
      event: "assignee_added",
      data: { assignee: person(id), name: name(person(id)) },
    });
  }
  for (const id of before.people) {
    if (after.people.includes(id)) continue;
    events.push({
      text: `took ${name(person(id))} off the issue`,
      event: "assignee_removed",
      data: { assignee: person(id), name: name(person(id)) },
    });
  }
  return events;
}

/** The people also with each card, in order, for any number of cards in one query. A card with none has no entry. */
export async function coAssigneesOf(db: Database, issueIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (issueIds.length === 0) return out;
  const rows = await db
    .select({ issueId: issueCoAssignees.issueId, userId: issueCoAssignees.userId })
    .from(issueCoAssignees)
    .where(inArray(issueCoAssignees.issueId, issueIds))
    .orderBy(asc(issueCoAssignees.issueId), asc(issueCoAssignees.position));
  for (const r of rows) out.set(r.issueId, [...(out.get(r.issueId) ?? []), r.userId]);
  return out;
}

/**
 * Whether `userId` is a person on the `issues` row `alias`: its principal, or a person also with it. An agent
 * principal matches nobody here (an agent filter reads the principal columns). Sight of the card is `taskSeenSql`.
 */
export function onCardSql(alias: string, userId: SQL): SQL {
  const t = sql.raw(alias);
  return sql`((${t}.assignee_type = 'person' and ${t}.assignee_id = ${userId})
    or exists (select 1 from ${issueCoAssignees} ic where ic.issue_id = ${t}.id and ic.user_id = ${userId}))`;
}

/**
 * Whoever a change adds to a card must be a member who sees it (or a live agent), the same checks as before for a
 * single assignee. Someone already on the card is not checked again, so a person who lost sight of it can be taken off.
 */
export async function checkAssignees(
  db: Database,
  orgId: string,
  current: Assignment,
  change: AssigneeChange,
  scope: TaskScope,
) {
  const named = [...(change.assignees ?? []), ...(change.assignee ? [change.assignee] : []), ...(change.add ?? [])];
  const seen = new Set<string>();
  for (const who of named) {
    const key = `${who.type}:${who.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const already = who.type === "agent" ? current.agentId === who.id : current.people.includes(who.id);
    if (!already) await checkAssignee(db, orgId, who, scope);
  }
}

/** Display names for the history: people by their account name, agents by theirs. Unknown ids read as their id. */
async function namesFor(tx: Executor, orgId: string, states: Assignment[]) {
  const people = unique(states.flatMap((s) => s.people));
  const agentIds = unique(states.flatMap((s) => (s.agentId ? [s.agentId] : [])));
  const names = new Map<string, string>();
  if (people.length) {
    for (const u of await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, people))) {
      names.set(`person:${u.id}`, u.name);
    }
  }
  if (agentIds.length) {
    const rows = await tx
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)));
    for (const a of rows) names.set(`agent:${a.id}`, a.name);
  }
  return (who: WorkActor) => names.get(`${who.type}:${who.id}`) ?? who.id;
}

/**
 * The one writer of who is responsible on a card, inside the caller's transaction. It locks the card's row, reads the
 * people there, plans the change from that state, then writes the principal's two columns and the rows together, so two
 * people editing at once merge instead of losing one, and a refusal writes nothing. It does not write the history: the
 * caller records `events`, authored by whoever made the change.
 */
export async function applyAssignees(
  tx: Executor,
  issue: { id: string; orgId: string },
  change: AssigneeChange,
  author: WorkActor,
  /** Runs on the locked row's people, before the plan: who was on the card when the lock was taken (ADR 0186). */
  check?: (before: Assignment) => Promise<void>,
): Promise<{ before: Assignment; after: Assignment; events: AssigneeEvent[] }> {
  const [row] = await tx
    .select({ assigneeType: issues.assigneeType, assigneeId: issues.assigneeId })
    .from(issues)
    .where(eq(issues.id, issue.id))
    .for("update");
  if (!row) throw new ValidationError("Issue not found", "not_found");
  const rows = await tx
    .select()
    .from(issueCoAssignees)
    .where(eq(issueCoAssignees.issueId, issue.id))
    .orderBy(asc(issueCoAssignees.position));
  const before = assignmentOf(
    row,
    rows.map((r) => r.userId),
  );
  await check?.(before);
  const after = planAssignees(before, change);
  const events = assigneeEvents(before, after, await namesFor(tx, issue.orgId, [before, after]));
  const alsoWith = alsoWithOf(after);
  const unchanged =
    before.agentId === after.agentId &&
    before.people.length === after.people.length &&
    before.people.every((id, i) => id === after.people[i]);
  if (unchanged) return { before, after, events };

  await tx
    .update(issues)
    .set({ ...columnsOf(after), updatedAt: new Date() })
    .where(eq(issues.id, issue.id));
  const kept = new Set(alsoWith);
  const gone = rows.filter((r) => !kept.has(r.userId)).map((r) => r.userId);
  if (gone.length) {
    await tx
      .delete(issueCoAssignees)
      .where(and(eq(issueCoAssignees.issueId, issue.id), inArray(issueCoAssignees.userId, gone)));
  }
  const had = new Map(rows.map((r) => [r.userId, r]));
  for (const [position, userId] of alsoWith.entries()) {
    if (had.has(userId)) {
      if (had.get(userId)?.position !== position) {
        await tx
          .update(issueCoAssignees)
          .set({ position })
          .where(and(eq(issueCoAssignees.issueId, issue.id), eq(issueCoAssignees.userId, userId)));
      }
    } else {
      await tx.insert(issueCoAssignees).values({
        issueId: issue.id,
        orgId: issue.orgId,
        userId,
        position,
        addedByType: author.type,
        addedById: author.id,
      });
    }
  }
  return { before, after, events };
}

/**
 * A person who leaves a workspace leaves its cards (ADR 0186), inside the caller's transaction and in one batch of
 * statements, not one transaction per card. The cards they were also with simply lose them; a card they were the
 * principal of goes to its first person also with, or to nobody. Each card gets one history event authored by the
 * leaver with `left: true` (and `via`, the audit's way of leaving, when there is one), its `updated_at` moves and it is
 * indexed again. Returns the ids of the cards that changed.
 */
export async function dropFromAssignments(
  tx: Executor,
  orgId: string,
  userId: string,
  via?: string | null,
): Promise<string[]> {
  const leaver: WorkActor = { type: "person", id: userId };
  const alsoOn = (
    await tx
      .delete(issueCoAssignees)
      .where(and(eq(issueCoAssignees.orgId, orgId), eq(issueCoAssignees.userId, userId)))
      .returning({ issueId: issueCoAssignees.issueId })
  ).map((r) => r.issueId);
  const principalOn = (
    await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.orgId, orgId), eq(issues.assigneeType, "person"), eq(issues.assigneeId, userId)))
  ).map((r) => r.id);
  const heirs = new Map<string, string>();
  if (principalOn.length) {
    const next = await tx
      .selectDistinctOn([issueCoAssignees.issueId], {
        issueId: issueCoAssignees.issueId,
        userId: issueCoAssignees.userId,
      })
      .from(issueCoAssignees)
      .where(inArray(issueCoAssignees.issueId, principalOn))
      .orderBy(asc(issueCoAssignees.issueId), asc(issueCoAssignees.position));
    for (const n of next) heirs.set(n.issueId, n.userId);
    const promoted = [...heirs.keys()];
    if (promoted.length) {
      await tx.execute(sql`update ${issues} i set assignee_id = n.user_id, updated_at = now()
        from (select distinct on (issue_id) issue_id, user_id from ${issueCoAssignees}
          where issue_id = any(${`{${promoted.join(",")}}`}::uuid[]) order by issue_id, position) n
        where i.id = n.issue_id`);
      // The principal keeps no row of their own.
      await tx.execute(sql`delete from ${issueCoAssignees} ic using ${issues} i
        where ic.issue_id = i.id and i.id = any(${`{${promoted.join(",")}}`}::uuid[]) and ic.user_id = i.assignee_id`);
    }
    await tx
      .update(issues)
      .set({ assigneeType: null, assigneeId: null, updatedAt: new Date() })
      .where(and(inArray(issues.id, principalOn), eq(issues.assigneeId, userId)));
  }
  if (alsoOn.length) await tx.update(issues).set({ updatedAt: new Date() }).where(inArray(issues.id, alsoOn));

  const touched = unique([...principalOn, ...alsoOn]);
  if (touched.length === 0) return [];
  const heirIds = unique([...heirs.values()]);
  const name = await namesFor(tx, orgId, [{ agentId: null, people: [userId, ...heirIds] }]);
  const left = name(leaver);
  await tx.insert(issueActivity).values(
    touched.map((issueId) => {
      const heir = heirs.get(issueId);
      const base = { orgId, issueId, kind: "event", authorType: "person", authorId: userId };
      const marks = { left: true, ...(via ? { via } : {}) };
      if (heir) {
        return {
          ...base,
          text: "assigned the issue",
          event: "assigned",
          data: { assignee: { type: "person", id: heir }, promoted: true, ...marks },
        };
      }
      if (principalOn.includes(issueId)) {
        return { ...base, text: "removed the assignee", event: "assigned", data: { assignee: null, ...marks } };
      }
      return {
        ...base,
        text: `took ${left} off the issue`,
        event: "assignee_removed",
        data: { assignee: leaver, name: left, ...marks },
      };
    }),
  );
  await tx
    .insert(outbox)
    .values(
      touched.map((sourceId) => ({
        orgId,
        kind: "search.index",
        payload: { kind: "issue", sourceId },
        nextAttemptAt: new Date(),
        maxAttempts: 8,
      })),
    )
    .onConflictDoNothing();
  return touched;
}
