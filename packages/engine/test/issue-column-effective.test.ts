import { afterEach, describe, expect, test } from "bun:test";
import { eq, rowsOf, schema, sql } from "@agenteschat/db";
import {
  boardColumnsOf,
  columnOf,
  createIssueColumn,
  createIssueProject,
  deleteIssueColumn,
  effectiveColumnSql,
  setColumnWaits,
  waitingSql,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

type Status = "todo" | "in_progress" | "in_review" | "done" | "canceled";
let counter = 0;
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing");
  return v;
};

async function task(input: { status: Status; projectId?: string | null; columnId?: string | null }) {
  const [row] = await f.db
    .insert(schema.issues)
    .values({
      orgId: f.org.id,
      number: ++counter,
      title: `Task ${counter}`,
      createdByType: "person",
      createdById: f.owner.id,
      status: input.status,
      projectId: input.projectId ?? null,
      columnId: input.columnId ?? null,
    })
    .returning();
  return must(row);
}

/** What the SQL says for each task: the column it resolves to and whether it waits. */
async function resolved(ids: string[]) {
  const rows = rowsOf<{ id: string; column_id: string | null; waits: boolean }>(
    await f.db.execute(sql`select i.id, col.id as column_id, ${waitingSql("i")} as waits
      from ${schema.issues} i ${effectiveColumnSql("i")}
      where i.org_id = ${f.org.id}::uuid`),
  );
  return new Map(rows.filter((r) => ids.includes(r.id)).map((r) => [r.id, r]));
}

/** A workspace with a second in-review column, a board with its own set and a board that follows the workspace's. */
async function scene() {
  const deps = { db: f.db, pubsub: f.pubsub };
  const own = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Own" });
  const follows = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Follows" });
  await createIssueColumn(deps, f.owner.id, f.org.id, { name: "Workspace QA", stage: "in_review" });
  await createIssueColumn(deps, f.owner.id, f.org.id, { name: "Own QA", stage: "in_review", projectId: own.id });
  await createIssueColumn(deps, f.owner.id, f.org.id, { name: "Own dev 2", stage: "in_progress", projectId: own.id });
  const workspace = await boardColumnsOf(f.db, f.org.id, null);
  const ownSet = await boardColumnsOf(f.db, f.org.id, own.id);
  return { deps, own, follows, workspace, ownSet };
}

describe("effectiveColumnSql", () => {
  test("resolves the column columnOf gives, for every way a task can sit", async () => {
    f = await setup();
    const { own, follows, workspace, ownSet } = await scene();
    const wsReview = workspace.filter((c) => c.stage === "in_review");
    const ownProgress = ownSet.filter((c) => c.stage === "in_progress");
    expect(wsReview.length).toBe(2);
    expect(ownProgress.length).toBe(2);

    const tasks = [
      // No column, a board that follows the workspace's set.
      await task({ status: "todo", projectId: follows.id }),
      // A column of another stage than its status is ignored.
      await task({ status: "todo", projectId: follows.id, columnId: must(wsReview[1]).id }),
      // A board with its own set, in the second column of its stage.
      await task({ status: "in_progress", projectId: own.id, columnId: must(ownProgress[1]).id }),
      // A follower in the workspace's second column of the stage.
      await task({ status: "in_review", projectId: follows.id, columnId: must(wsReview[1]).id }),
      // No board at all.
      await task({ status: "in_progress" }),
      // A board with its own set, still pointing at a workspace column: falls to the first of its stage.
      await task({ status: "in_review", projectId: own.id, columnId: must(wsReview[1]).id }),
      // Done, with no column.
      await task({ status: "done", projectId: own.id }),
    ];
    const got = await resolved(tasks.map((t) => t.id));
    for (const t of tasks) {
      const expected = columnOf(await boardColumnsOf(f.db, f.org.id, t.projectId), t);
      expect(got.get(t.id)?.column_id).toBe(must(expected).id);
    }
    // And the cases were not all the same column.
    expect(new Set(tasks.map((t) => got.get(t.id)?.column_id)).size).toBeGreaterThanOrEqual(5);
  });

  test("waitingSql is true for an open task in a flagged column and false otherwise", async () => {
    f = await setup();
    const { deps, own, follows, workspace, ownSet } = await scene();
    const ownQa = must(ownSet.find((c) => c.name === "Own QA"));
    const ownDone = must(ownSet.find((c) => c.stage === "done"));
    // Flag the board's QA and its done column (a done task must never wait), and the workspace's first in-review.
    await setColumnWaits(deps, f.owner.id, f.org.id, ownQa.id, true, own.id);
    await setColumnWaits(deps, f.owner.id, f.org.id, ownDone.id, true, own.id);
    const wsFirstReview = must(workspace.find((c) => c.stage === "in_review"));
    await setColumnWaits(deps, f.owner.id, f.org.id, wsFirstReview.id, true);

    const waiting = await task({ status: "in_review", projectId: own.id, columnId: ownQa.id });
    const unflagged = await task({ status: "in_progress", projectId: own.id });
    const done = await task({ status: "done", projectId: own.id, columnId: ownDone.id });
    const canceled = await task({ status: "canceled", projectId: own.id });
    const follower = await task({ status: "in_review", projectId: follows.id });
    const got = await resolved([waiting, unflagged, done, canceled, follower].map((t) => t.id));
    expect(got.get(waiting.id)?.waits).toBe(true);
    expect(got.get(unflagged.id)?.waits).toBe(false);
    expect(got.get(done.id)?.waits).toBe(false);
    expect(got.get(canceled.id)?.waits).toBe(false);
    // The follower sits in the workspace's flagged first in-review column.
    expect(got.get(follower.id)?.waits).toBe(true);
  });

  test("a deleted column no longer makes its task wait", async () => {
    f = await setup();
    const { deps, own, ownSet } = await scene();
    const ownQa = must(ownSet.find((c) => c.name === "Own QA"));
    const firstReview = must(ownSet.find((c) => c.stage === "in_review" && c.id !== ownQa.id));
    await setColumnWaits(deps, f.owner.id, f.org.id, ownQa.id, true, own.id);
    const t = await task({ status: "in_review", projectId: own.id, columnId: ownQa.id });
    expect((await resolved([t.id])).get(t.id)?.waits).toBe(true);

    await deleteIssueColumn(deps, f.owner.id, f.org.id, ownQa.id, firstReview.id);
    const [after] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, t.id));
    expect(after?.columnId).toBe(firstReview.id);
    const got = (await resolved([t.id])).get(t.id);
    expect(got?.column_id).toBe(firstReview.id);
    expect(got?.waits).toBe(false);
  });
});
