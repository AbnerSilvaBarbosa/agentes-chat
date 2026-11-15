import type { Database, schema } from "@agenteschat/db";
import { boardColumnsOf } from "./issue-columns";

type ColumnRow = typeof schema.issueColumns.$inferSelect;

const named = (c: ColumnRow, name: string) => c.name?.trim().toLowerCase() === name;

/**
 * Where a PO's card is born and where a finished spec sends it (ADR 0185). The card starts in the "Especificar"
 * column (any capitals) when it is a to-do column, else the board's first to-do column; a board always has one, as
 * every board has a column per stage. A finished spec moves it to "Priorizado" (any stage), else the first to-do
 * column after `specify`, else nowhere (null: it stays and the comment says so). The release to development is a
 * person's decision, so a column named "Ready for dev" is never the target, not even as the fallback.
 */
export async function specColumns(
  db: Database,
  orgId: string,
  projectId: string,
): Promise<{ specify: ColumnRow; prioritized: ColumnRow | null }> {
  // Board order, a board with none of its own reading the workspace's, as every column read does.
  const columns = await boardColumnsOf(db, orgId, projectId);
  const todo = columns.filter((c) => c.stage === "todo");
  const specify = todo.find((c) => named(c, "especificar")) ?? todo[0];
  if (!specify) throw new Error("a board has a column for every stage");
  const prioritized =
    columns.find((c) => named(c, "priorizado")) ??
    todo.slice(todo.indexOf(specify) + 1).find((c) => !named(c, "ready for dev")) ??
    null;
  return { specify, prioritized };
}
