import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { listIssues } from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

const must = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Error("missing");
  return v;
};
let counter = 0;

/** A board with its own columns: Especificar and Ready for dev, an unnamed review column, and the tasks in them. */
async function scene(name = "Entregas") {
  const [board] = await f.db.insert(schema.issueProjects).values({ orgId: f.org.id, name }).returning();
  const projectId = must(board).id;
  const column = async (name: string | null, stage: "todo" | "in_progress" | "in_review", position: number) =>
    must(
      (
        await f.db.insert(schema.issueColumns).values({ orgId: f.org.id, projectId, stage, name, position }).returning()
      )[0],
    );
  const specify = await column("Especificar", "todo", 0);
  const ready = await column("Ready for dev", "in_progress", 0);
  const review = await column(null, "in_review", 0);
  const task = async (title: string, c: typeof specify, extra: Partial<typeof schema.issues.$inferInsert> = {}) =>
    must(
      (
        await f.db
          .insert(schema.issues)
          .values({
            orgId: f.org.id,
            number: ++counter,
            title,
            projectId,
            status: c.stage,
            columnId: c.id,
            createdByType: "person",
            createdById: f.owner.id,
            ...extra,
          })
          .returning()
      )[0],
    );
  return { projectId, specify, ready, review, task };
}

const titles = (rows: { title: string }[]) => rows.map((r) => r.title).sort();
const asOwner = () => ({ type: "person" as const, userId: f.owner.id });

describe("listIssues columnKeys", () => {
  test("lists only the tasks sitting in the named columns", async () => {
    f = await setup();
    const s = await scene();
    await s.task("Escrever a spec", s.specify);
    await s.task("Pronto para dev", s.ready);
    await s.task("Em revisão", s.review);
    const rows = await listIssues(f.db, asOwner(), f.org.id, { columnKeys: ["especificar", "ready for dev"] });
    expect(titles(rows)).toEqual(["Escrever a spec", "Pronto para dev"]);
    expect(await listIssues(f.db, asOwner(), f.org.id, { columnKeys: ["nenhuma"] })).toEqual([]);
  });

  test("matches a name in any capitals and a stage's own column by its stage key", async () => {
    f = await setup();
    const s = await scene();
    await s.task("Escrever a spec", s.specify);
    await s.task("Em revisão", s.review);
    expect(titles(await listIssues(f.db, asOwner(), f.org.id, { columnKeys: ["  ESPECIFICAR "] }))).toEqual([
      "Escrever a spec",
    ]);
    expect(titles(await listIssues(f.db, asOwner(), f.org.id, { columnKeys: ["stage:in_review"] }))).toEqual([
      "Em revisão",
    ]);
  });

  test("a task the person may not see stays out of the filtered list", async () => {
    f = await setup();
    const s = await scene();
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    await s.task("Do dono", s.specify, { restricted: true, audienceUserIds: [f.owner.id] });
    await s.task("De todos", s.specify);
    const rows = await listIssues(f.db, { type: "person", userId: member.id }, f.org.id, {
      columnKeys: ["especificar"],
    });
    expect(titles(rows)).toEqual(["De todos"]);
  });

  test("leaves out a task of an archived board, as the progress panel's count does", async () => {
    f = await setup();
    const live = await scene();
    const old = await scene("Velho");
    await live.task("Na viva", live.specify);
    await old.task("Na arquivada", old.specify);
    await f.db
      .update(schema.issueProjects)
      .set({ archivedAt: new Date() })
      .where(eq(schema.issueProjects.id, old.projectId));
    const rows = await listIssues(f.db, asOwner(), f.org.id, { columnKeys: ["especificar"] });
    expect(titles(rows)).toEqual(["Na viva"]);
  });
});
