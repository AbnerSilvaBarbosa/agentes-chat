import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema, sql } from "@agenteschat/db";
import {
  applyColumnTemplate,
  createColumnTemplate,
  createIssue,
  createIssueColumn,
  createIssueProject,
  ForbiddenError,
  listColumnTemplates,
  listIssueColumns,
  NotFoundError,
  saveColumnTemplate,
  setColumnWaits,
  updateColumnTemplate,
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

describe("status sets carry the flag", () => {
  test("a set keeps a flag only when it is true, and the seeded sets are unflagged", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const made = await createColumnTemplate(deps, f.owner.id, f.org.id, {
      name: "Entrega",
      columns: [
        { name: "Fazer", stage: "todo" },
        { name: "Teste humano", stage: "in_review", waitsForPerson: true },
        { name: "Talvez", stage: "in_review", waitsForPerson: "yes" as unknown as boolean },
        { name: "Pronto", stage: "done", waitsForPerson: false },
      ],
    });
    expect(made.columns).toEqual([
      { name: "Fazer", stage: "todo" },
      { name: "Teste humano", stage: "in_review", waitsForPerson: true },
      { name: "Talvez", stage: "in_review" },
      { name: "Pronto", stage: "done" },
    ]);
    const seeded = (await listColumnTemplates(f.db, f.owner.id, f.org.id)).filter((t) => t.seeded);
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.flatMap((t) => t.columns).some((c) => c.waitsForPerson)).toBe(false);
  });

  test("a board made from a set carries the flags of its columns", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const set = await createColumnTemplate(deps, f.owner.id, f.org.id, {
      name: "Entrega",
      columns: [
        { name: "Fazer", stage: "todo" },
        { name: "Teste humano", stage: "in_review", waitsForPerson: true },
        { name: "Pronto", stage: "done" },
      ],
    });
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Site" });
    const made = await applyColumnTemplate(deps, f.owner.id, f.org.id, board.id, set.id);
    const own = made.filter((c) => c.projectId === board.id);
    expect(own.map((c) => [c.name, c.waitsForPerson])).toEqual([
      ["Fazer", false],
      ["Teste humano", true],
      ["Pronto", false],
    ]);
  });

  test("a set saved from a board and edited keeps the flags", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Site" });
    const cols = await createIssueColumn(deps, f.owner.id, f.org.id, {
      name: "Teste humano",
      stage: "in_review",
      projectId: board.id,
    });
    const human = must(cols.find((c) => c.name === "Teste humano"));
    await setColumnWaits(deps, f.owner.id, f.org.id, human.id, true, board.id);

    const saved = await saveColumnTemplate(deps, f.owner.id, f.org.id, { name: "Do site", projectId: board.id });
    expect(saved.columns.filter((c) => c.waitsForPerson)).toEqual([
      { name: "Teste humano", stage: "in_review", waitsForPerson: true },
    ]);

    // An edit keeps the flags it is sent, and a column without one is unflagged.
    const edited = await updateColumnTemplate(deps, f.owner.id, f.org.id, saved.id, {
      columns: [
        ...saved.columns.map((c) => (c.name === "Teste humano" ? { ...c, name: "QA humano" } : c)),
        { name: "Extra", stage: "todo" },
      ],
    });
    expect(edited.columns.find((c) => c.name === "QA humano")).toEqual({
      name: "QA humano",
      stage: "in_review",
      waitsForPerson: true,
    });
    expect(edited.columns.filter((c) => c.waitsForPerson)).toHaveLength(1);
    const reread = (await listColumnTemplates(f.db, f.owner.id, f.org.id)).find((t) => t.id === saved.id);
    expect(reread?.columns.filter((c) => c.waitsForPerson).map((c) => c.name)).toEqual(["QA humano"]);
  });

  test("a set without the key reads as unflagged and a board made from it starts unflagged", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const [row] = await f.db
      .insert(schema.issueColumnTemplates)
      .values({ orgId: f.org.id, name: "Antigo", columns: [{ name: "Fazer", stage: "todo" }] })
      .returning();
    const old = (await listColumnTemplates(f.db, f.owner.id, f.org.id)).find((t) => t.id === must(row).id);
    expect(old?.columns.some((c) => c.waitsForPerson)).toBe(false);
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Site" });
    const made = await applyColumnTemplate(deps, f.owner.id, f.org.id, board.id, must(row).id);
    expect(made.filter((c) => c.projectId === board.id).every((c) => c.waitsForPerson === false)).toBe(true);
  });
});
