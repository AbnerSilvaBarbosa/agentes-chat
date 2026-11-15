import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, rowsOf, schema, sql } from "@agenteschat/db";
import { createIssue, createIssueColumn, listIssueColumns, updateIssue } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing");
  return v;
};
const LONG_AGO = "2020-01-01T00:00:00Z";

const sinceOf = async (id: string): Promise<Date> => {
  const [row] = await f.db
    .select({ at: schema.issues.columnSince })
    .from(schema.issues)
    .where(eq(schema.issues.id, id));
  return must(row).at;
};
/** Pins the clock to a past instant without touching status, column or board (so the trigger stays quiet). */
const pin = (id: string) =>
  f.db.execute(sql`update issues set column_since = ${LONG_AGO}::timestamptz where id = ${id}`);
const pinned = (at: Date) => at.getTime() === new Date(LONG_AGO).getTime();

test("the migration backfills each task with its last status change, else its creation", async () => {
  f = await setup();
  const deps = { db: f.db, pubsub: f.pubsub };
  const ana = person(f.owner.id);
  const moved = await createIssue(deps, ana, f.org.id, { title: "Moved" });
  const untouched = await createIssue(deps, ana, f.org.id, { title: "Untouched" });
  await f.db.execute(
    sql`update issues set created_at = '2021-03-01T00:00:00Z' where id in (${moved.id}, ${untouched.id})`,
  );
  for (const [at, to] of [
    ["2021-04-01T00:00:00Z", "in_progress"],
    ["2021-05-01T00:00:00Z", "in_review"],
  ] as const) {
    await f.db.insert(schema.issueActivity).values({
      orgId: f.org.id,
      issueId: moved.id,
      kind: "event",
      authorType: "person",
      authorId: f.owner.id,
      text: "moved",
      event: "status_changed",
      data: { to },
      createdAt: new Date(at),
    });
  }
  // A comment is not a status change.
  await f.db.insert(schema.issueActivity).values({
    orgId: f.org.id,
    issueId: moved.id,
    kind: "comment",
    authorType: "person",
    authorId: f.owner.id,
    text: "later comment",
    createdAt: new Date("2021-06-01T00:00:00Z"),
  });
  await pin(moved.id);
  await pin(untouched.id);

  // Replays the migration's own backfill statement.
  const file = must(
    readdirSync(join(import.meta.dir, "../../db/migrations")).find((n) => n.endsWith("_factory-home.sql")),
  );
  const backfill = must(
    readFileSync(join(import.meta.dir, "../../db/migrations", file), "utf8")
      .split("--> statement-breakpoint")
      .find((s) => /UPDATE "issues" SET "column_since"/.test(s)),
  );
  await f.db.execute(sql.raw(backfill));

  expect((await sinceOf(moved.id)).toISOString()).toBe("2021-05-01T00:00:00.000Z");
  expect((await sinceOf(untouched.id)).toISOString()).toBe("2021-03-01T00:00:00.000Z");
});

test("resets column_since on a status column or board change and on nothing else", async () => {
  f = await setup();
  const deps = { db: f.db, pubsub: f.pubsub };
  const ana = person(f.owner.id);
  const cols = await createIssueColumn(deps, f.owner.id, f.org.id, { name: "QA", stage: "in_review" });
  const review = must(cols.find((c) => c.stage === "in_review" && c.name === null));
  const qa = must(cols.find((c) => c.name === "QA"));
  const issue = await createIssue(deps, ana, f.org.id, { title: "Tela" });

  // A status change restarts the clock.
  await pin(issue.id);
  await updateIssue(deps, ana, f.org.id, issue.id, { status: "in_review" });
  expect(pinned(await sinceOf(issue.id))).toBe(false);

  // A move between two columns of one stage restarts it, though the status stays.
  await updateIssue(deps, ana, f.org.id, issue.id, { columnId: review.id });
  await pin(issue.id);
  const sameStage = await updateIssue(deps, ana, f.org.id, issue.id, { columnId: qa.id });
  expect(sameStage.status).toBe("in_review");
  expect(pinned(await sinceOf(issue.id))).toBe(false);

  // A change of board restarts it.
  const [space] = await f.db.insert(schema.issueSpaces).values({ orgId: f.org.id, name: "Acme" }).returning();
  const [board] = await f.db
    .insert(schema.issueProjects)
    .values({ orgId: f.org.id, spaceId: must(space).id, name: "Site" })
    .returning();
  await pin(issue.id);
  await f.db.execute(sql`update issues set project_id = ${must(board).id} where id = ${issue.id}`);
  expect(pinned(await sinceOf(issue.id))).toBe(false);

  // A title, priority or comment edit leaves it alone.
  await pin(issue.id);
  await updateIssue(deps, ana, f.org.id, issue.id, { title: "Tela nova", priority: "high" });
  await f.db.insert(schema.issueActivity).values({
    orgId: f.org.id,
    issueId: issue.id,
    kind: "comment",
    authorType: "person",
    authorId: f.owner.id,
    text: "ping",
  });
  expect(pinned(await sinceOf(issue.id))).toBe(true);
});

test("keeps column_since under the bypass setting, inside one transaction only", async () => {
  f = await setup();
  const deps = { db: f.db, pubsub: f.pubsub };
  const ana = person(f.owner.id);
  const issue = await createIssue(deps, ana, f.org.id, { title: "Tela" });
  const progress = must((await listIssueColumns(f.db, f.owner.id, f.org.id)).find((c) => c.stage === "in_progress"));
  await pin(issue.id);
  await f.db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('agentes.keep_column_since', 'on', true)`);
    await tx.execute(sql`update issues set status = 'in_progress', column_id = ${progress.id} where id = ${issue.id}`);
  });
  expect(pinned(await sinceOf(issue.id))).toBe(true);

  // The setting ended with its transaction: the next change restarts the clock.
  await f.db.execute(sql`update issues set status = 'in_review', column_id = null where id = ${issue.id}`);
  expect(pinned(await sinceOf(issue.id))).toBe(false);
  expect(
    rowsOf(await f.db.execute(sql`select current_setting('agentes.keep_column_since', true) as v`))[0],
  ).not.toMatchObject({
    v: "on",
  });
});
