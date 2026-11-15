import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema, sql } from "@agenteschat/db";
import {
  createIssue,
  createIssueColumn,
  createIssueProject,
  ForbiddenError,
  listIssueColumns,
  NotFoundError,
  setColumnWaits,
  updateIssue,
  updateIssueColumn,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing");
  return v;
};
const rejection = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );
const LONG_AGO = "2020-01-01T00:00:00Z";

describe("a column that waits for a person", () => {
  test("a person who may edit sets and clears the flag on a column of a board", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Site" });
    // A new column starts unflagged.
    const made = await createIssueColumn(deps, f.owner.id, f.org.id, {
      name: "Teste humano",
      stage: "in_review",
      projectId: board.id,
    });
    const human = must(made.find((c) => c.name === "Teste humano" && c.projectId === board.id));
    expect(human.waitsForPerson).toBe(false);
    expect(made.filter((c) => c.projectId === board.id).every((c) => !c.waitsForPerson)).toBe(true);

    const on = await setColumnWaits(deps, f.owner.id, f.org.id, human.id, true, board.id);
    expect(on.find((c) => c.id === human.id)?.waitsForPerson).toBe(true);
    // The read of the board's columns carries it too.
    const read = await listIssueColumns(f.db, f.owner.id, f.org.id, board.id);
    expect(read.filter((c) => c.waitsForPerson).map((c) => c.id)).toEqual([human.id]);

    const off = await setColumnWaits(deps, f.owner.id, f.org.id, human.id, false, board.id);
    expect(off.find((c) => c.id === human.id)?.waitsForPerson).toBe(false);
  });

  test("keeps the flag when the column is renamed moved or changes stage", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Site" });
    const made = await createIssueColumn(deps, f.owner.id, f.org.id, {
      name: "Teste humano",
      stage: "in_review",
      projectId: board.id,
    });
    const other = await createIssueColumn(deps, f.owner.id, f.org.id, {
      name: "Revisão",
      stage: "in_review",
      projectId: board.id,
    });
    const human = must(made.find((c) => c.name === "Teste humano"));
    expect(other.some((c) => c.name === "Revisão")).toBe(true);
    await setColumnWaits(deps, f.owner.id, f.org.id, human.id, true, board.id);
    const task = await createIssue(deps, ana, f.org.id, { title: "Tela", projectId: board.id, columnId: human.id });

    const flagged = async () =>
      must((await listIssueColumns(f.db, f.owner.id, f.org.id, board.id)).find((c) => c.id === human.id));

    await updateIssueColumn(deps, f.owner.id, f.org.id, human.id, { name: "QA humano" });
    expect(await flagged()).toMatchObject({ name: "QA humano", waitsForPerson: true });

    await updateIssueColumn(deps, f.owner.id, f.org.id, human.id, { index: 0 });
    expect(await flagged()).toMatchObject({ waitsForPerson: true });

    await updateIssueColumn(deps, f.owner.id, f.org.id, human.id, { stage: "in_progress" });
    expect(await flagged()).toMatchObject({ stage: "in_progress", waitsForPerson: true });
    // Its tasks follow as before.
    const [after] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, task.id));
    expect(after).toMatchObject({ status: "in_progress", columnId: human.id });
  });

  test("flagging a column of a board that follows the workspace's set gives it its own copy first", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const ana = person(f.owner.id);
    // The workspace's set has two columns in "em revisão".
    const ws = await createIssueColumn(deps, f.owner.id, f.org.id, { name: "QA", stage: "in_review" });
    const review = must(ws.find((c) => c.stage === "in_review" && c.name === null));
    const qa = must(ws.find((c) => c.name === "QA"));
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Site" });
    expect(
      await f.db.select().from(schema.issueColumns).where(eq(schema.issueColumns.projectId, board.id)),
    ).toHaveLength(0);

    const inFirst = await createIssue(deps, ana, f.org.id, { title: "No primeiro", projectId: board.id });
    const inQa = await createIssue(deps, ana, f.org.id, { title: "No QA", projectId: board.id, columnId: qa.id });
    await updateIssue(deps, ana, f.org.id, inFirst.id, { columnId: review.id });
    // Pins the clocks so a restart would show.
    await f.db.execute(sql`update issues set column_since = ${LONG_AGO}::timestamptz where project_id = ${board.id}`);

    // Flagging the workspace's "QA" from the board's dialog.
    const after = await setColumnWaits(deps, f.owner.id, f.org.id, qa.id, true, board.id);

    const own = after.filter((c) => c.projectId === board.id);
    expect(own.map((c) => [c.stage, c.name, c.waitsForPerson])).toEqual(
      expect.arrayContaining([["in_review", "QA", true]]),
    );
    expect(own.filter((c) => c.waitsForPerson)).toHaveLength(1);
    // The workspace's own columns stay unflagged.
    expect(after.filter((c) => c.projectId === null).some((c) => c.waitsForPerson)).toBe(false);
    expect(own).toHaveLength(ws.length);

    // Each task stays in the column it was in, now the board's copy, and its clock was not restarted.
    const copyOf = (name: string | null, stage: string) => must(own.find((c) => c.name === name && c.stage === stage));
    const rows = await f.db.select().from(schema.issues).where(eq(schema.issues.projectId, board.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(inQa.id)?.columnId).toBe(copyOf("QA", "in_review").id);
    expect(byId.get(inFirst.id)?.columnId).toBe(copyOf(null, "in_review").id);
    for (const r of rows) expect(r.columnSince.toISOString()).toBe("2020-01-01T00:00:00.000Z");
  });

  test("refuses a flag change from a member without the right", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Site" });
    const made = await createIssueColumn(deps, f.owner.id, f.org.id, {
      name: "Teste",
      stage: "in_review",
      projectId: board.id,
    });
    const column = must(made.find((c) => c.name === "Teste"));
    const guest = await addMember(f.db, f.org.id, "member", "gus");
    await f.db.update(schema.orgRoles).set({ permissions: [] }).where(eq(schema.orgRoles.kind, "everyone"));

    expect(await rejection(setColumnWaits(deps, guest.id, f.org.id, column.id, true, board.id))).toBeInstanceOf(
      ForbiddenError,
    );
    const read = await listIssueColumns(f.db, f.owner.id, f.org.id, board.id);
    expect(read.find((c) => c.id === column.id)?.waitsForPerson).toBe(false);
  });

  test("a column of another workspace is not found", async () => {
    const other = await setup();
    f = await setup();
    try {
      const deps = { db: f.db, pubsub: f.pubsub };
      // Each setup is its own database: seed the other workspace's columns, then ask for one by its id here.
      const [foreign] = await other.db.select().from(schema.issueColumns).limit(1);
      const id = foreign?.id ?? (await listIssueColumns(other.db, other.owner.id, other.org.id))[0]?.id ?? "";
      expect(id).not.toBe("");
      expect(await rejection(setColumnWaits(deps, f.owner.id, f.org.id, id, true))).toBeInstanceOf(NotFoundError);
    } finally {
      await other.close();
    }
  });
});
