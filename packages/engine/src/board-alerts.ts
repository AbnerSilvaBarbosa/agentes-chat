import { and, type Database, eq, inArray, isNull, schema } from "@agenteschat/db";
import { appLocale } from "@agenteschat/i18n/locale";
import { NotFoundError, ValidationError } from "./errors";
import { boardColumnsOf } from "./issue-columns";
import { requireActiveMembership } from "./organizations";
import { createRoutine, deleteRoutine, type RoutineDeps, routineSeer } from "./routines";

const { routines, agents, issueProjects, users } = schema;

type RoutineRow = typeof routines.$inferSelect;

/**
 * A board's alert rule (ADR 0175 addendum): one routine on `issue.moved`, narrowed to the board and the column a card
 * lands in (and the one it leaves, when the person said so), that wakes one agent. The routine is the rule, so budgets,
 * approvals and the loop guards apply unchanged and the routines page shows it too.
 */
export interface BoardAlertView {
  /** The routine's id. */
  id: string;
  agentId: string;
  agentName: string;
  /** The column a card lands in. */
  columnId: string;
  /** The column it leaves; null: any. */
  fromColumnId: string | null;
  /** The rule does not fire now: its routine is paused or its agent is archived. */
  paused: boolean;
  /** Why (`agent_archived`, or the routine's own reason); null when not paused. */
  pausedReason: string | null;
}

const filterOf = (r: Pick<RoutineRow, "eventFilter">) => (r.eventFilter ?? {}) as Record<string, string | undefined>;

async function boardOf(db: Database, orgId: string, projectId: string) {
  const [board] = await db
    .select()
    .from(issueProjects)
    .where(and(eq(issueProjects.id, projectId), eq(issueProjects.orgId, orgId)));
  if (!board) throw new NotFoundError("Board not found");
  return board;
}

/** The board's rules, as rows: its event routines on `issue.moved` that name a destination column. */
async function ruleRows(db: Database, orgId: string, projectId: string) {
  const [rows, columns] = await Promise.all([
    db
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.orgId, orgId),
          isNull(routines.deletedAt),
          eq(routines.triggerType, "event"),
          eq(routines.event, "issue.moved"),
        ),
      )
      .orderBy(routines.createdAt),
    db
      .select({ id: schema.issueColumns.id })
      .from(schema.issueColumns)
      .where(and(eq(schema.issueColumns.orgId, orgId), eq(schema.issueColumns.projectId, projectId))),
  ]);
  const own = new Set(columns.map((c) => c.id));
  return rows.filter((r) => {
    const filter = filterOf(r);
    if (!filter.columnId) return false;
    // Made for this board, or for a column only this board has (an agent's `column` with no `board`).
    return filter.projectId ? filter.projectId === projectId : own.has(filter.columnId);
  });
}

/**
 * The board's alert rules, whoever created them, as the person sees routines (`routineSeer`): a rule of an agent they
 * can't see does not show.
 */
export async function boardAlerts(
  db: Database,
  userId: string,
  orgId: string,
  projectId: string,
): Promise<BoardAlertView[]> {
  await requireActiveMembership(db, userId, orgId);
  await boardOf(db, orgId, projectId);
  const sees = await routineSeer(db, orgId, userId);
  const rows = (await ruleRows(db, orgId, projectId)).filter(sees);
  const agentIds = [...new Set(rows.map((r) => r.agentId))];
  const found = agentIds.length
    ? await db
        .select({ id: agents.id, name: agents.name, archivedAt: agents.archivedAt })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), inArray(agents.id, agentIds)))
    : [];
  return rows.map((r) => {
    const agent = found.find((a) => a.id === r.agentId);
    const filter = filterOf(r);
    const archived = !agent || !!agent.archivedAt;
    const paused = !r.active || archived;
    return {
      id: r.id,
      agentId: r.agentId,
      agentName: agent?.name ?? "",
      columnId: filter.columnId ?? "",
      fromColumnId: filter.fromColumnId || null,
      paused,
      pausedReason: !paused ? null : (r.pausedReason ?? (archived ? "agent_archived" : "paused")),
    };
  });
}

const STAGE_WORDS = {
  "pt-BR": {
    todo: "A fazer",
    in_progress: "Em andamento",
    in_review: "Em revisão",
    done: "Concluído",
    canceled: "Cancelado",
  },
  en: { todo: "To do", in_progress: "In progress", in_review: "In review", done: "Done", canceled: "Canceled" },
} as const;

/**
 * The fixed brief of a rule, in its creator's language (pt-BR or English): the card's number and title come with the
 * event of each run, so the text only says why the agent was woken and what is asked.
 */
export function alertBrief(locale: "pt-BR" | "en", board: string, to: string, from: string | null): string {
  if (locale === "pt-BR") {
    return [
      `Você foi avisado porque um card do board "${board}" foi movido${from ? ` de "${from}"` : ""} para "${to}".`,
      "O card, de onde veio, para onde foi e quem o moveu estão no evento deste aviso.",
      "Leia o card, faça o passo que esta etapa pede de você e diga no card o que você fez.",
    ].join("\n");
  }
  return [
    `You were alerted because a card of the board "${board}" moved${from ? ` from "${from}"` : ""} to "${to}".`,
    "The card, where it came from, where it went and who moved it are in this alert's event.",
    "Read the card, do the step this stage asks of you, and say on the card what you did.",
  ].join("\n");
}

/**
 * Adds a rule: when a card of the board goes to `columnId` (from `fromColumnId`, when given), `agentId` is woken. The
 * routine is made as the person makes one (`createRoutine`: who may manage routines for that agent and talk to it, the
 * agent's caps), in a DM with them, `act` so the agent can move and comment on the card.
 */
export async function addBoardAlert(
  deps: RoutineDeps,
  userId: string,
  orgId: string,
  projectId: string,
  input: { agentId: string; columnId: string; fromColumnId?: string | null },
): Promise<BoardAlertView> {
  const { db } = deps;
  await requireActiveMembership(db, userId, orgId);
  const board = await boardOf(db, orgId, projectId);
  const fromColumnId = input.fromColumnId || null;
  if (fromColumnId && fromColumnId === input.columnId) {
    throw new ValidationError("A card can't go from a status to itself", "board_alert.same_column");
  }
  const columns = await boardColumnsOf(db, orgId, projectId);
  const to = columns.find((c) => c.id === input.columnId);
  const from = fromColumnId ? columns.find((c) => c.id === fromColumnId) : null;
  if (!to || (fromColumnId && !from)) {
    throw new ValidationError("That status is not one of this board's", "board_alert.column_not_on_board");
  }
  const [person] = await db.select({ locale: users.locale }).from(users).where(eq(users.id, userId));
  const locale = (person?.locale ? appLocale([person.locale], true) : null) === "pt-BR" ? "pt-BR" : "en";
  const words = STAGE_WORDS[locale];
  const nameOf = (c: { name: string | null; stage: keyof typeof words }) => c.name ?? words[c.stage];
  const routine = await createRoutine(deps, userId, orgId, {
    name: `${board.name}: ${nameOf(to)}`,
    agentId: input.agentId,
    prompt: alertBrief(locale, board.name, nameOf(to), from ? nameOf(from) : null),
    target: { type: "dm" },
    trigger: {
      type: "event",
      event: "issue.moved",
      filter: { projectId, columnId: to.id, ...(from ? { fromColumnId: from.id } : {}) },
    },
    access: "act",
  });
  const rule = (await boardAlerts(db, userId, orgId, projectId)).find((r) => r.id === routine.id);
  if (!rule) throw new Error("the new rule is not listed");
  return rule;
}

/** Removes a rule: its routine is deleted, as from the routines page. Only the board's rules go by this door. */
export async function removeBoardAlert(
  deps: RoutineDeps,
  userId: string,
  orgId: string,
  projectId: string,
  ruleId: string,
): Promise<void> {
  const rules = await boardAlerts(deps.db, userId, orgId, projectId);
  if (!rules.some((r) => r.id === ruleId)) throw new NotFoundError("Alert not found");
  await deleteRoutine(deps, userId, orgId, ruleId);
}
