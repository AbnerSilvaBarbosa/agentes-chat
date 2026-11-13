import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  applyColumnTemplate,
  createColumnTemplate,
  createIssueProject,
  createIssueSpace,
  deleteColumnTemplate,
  ForbiddenError,
  listColumnTemplates,
  listIssueColumns,
  updateColumnTemplate,
  ValidationError,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const rejection = async (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("status sets", () => {
  test("creates a set with a name and columns", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const made = await createColumnTemplate(deps, f.owner.id, f.org.id, {
      name: "  Vendas ",
      columns: [
        { name: "Lead", stage: "todo" },
        { name: "Proposta", stage: "in_progress" },
        { name: "Fechado", stage: "done" },
      ],
    });
    expect(made).toMatchObject({ name: "Vendas", seeded: false });
    expect(made.columns).toEqual([
      { name: "Lead", stage: "todo" },
      { name: "Proposta", stage: "in_progress" },
      { name: "Fechado", stage: "done" },
    ]);
    const listed = await listColumnTemplates(f.db, f.owner.id, f.org.id);
    expect(listed.find((t) => t.id === made.id)?.columns).toHaveLength(3);
  });

  test("renames a set", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const made = await createColumnTemplate(deps, f.owner.id, f.org.id, {
      name: "Vendas",
      columns: [{ name: "Lead", stage: "todo" }],
    });
    const renamed = await updateColumnTemplate(deps, f.owner.id, f.org.id, made.id, { name: "Comercial" });
    expect(renamed).toMatchObject({ id: made.id, name: "Comercial" });
    expect(renamed.columns).toEqual([{ name: "Lead", stage: "todo" }]);
    // A name another set has, in any capitals, is refused.
    const taken = await rejection(updateColumnTemplate(deps, f.owner.id, f.org.id, made.id, { name: "kanban" }));
    expect(taken).toMatchObject({ code: "issue_template.name_taken" });
    // A seeded name is taken even before anyone has listed the sets.
    const seededName = await rejection(
      createColumnTemplate(deps, f.owner.id, f.org.id, { name: "Kanban", columns: [{ name: "A", stage: "todo" }] }),
    );
    expect(seededName).toMatchObject({ code: "issue_template.name_taken" });
    const again = await rejection(
      createColumnTemplate(deps, f.owner.id, f.org.id, { name: "COMERCIAL", columns: [{ name: "A", stage: "todo" }] }),
    );
    expect(again).toMatchObject({ code: "issue_template.name_taken" });
  });

  test("edits a set's columns", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const made = await createColumnTemplate(deps, f.owner.id, f.org.id, {
      name: "Vendas",
      columns: [
        { name: "Lead", stage: "todo" },
        { name: "Proposta", stage: "in_progress" },
      ],
    });
    const edit = (columns: { name: string; stage: "todo" | "in_progress" | "in_review" | "done" | "canceled" }[]) =>
      updateColumnTemplate(deps, f.owner.id, f.org.id, made.id, { columns });
    // Added.
    expect(
      (await edit([...made.columns, { name: "Contrato", stage: "in_review" }])).columns.map((c) => c.name),
    ).toEqual(["Lead", "Proposta", "Contrato"]);
    // Renamed and reordered.
    const reordered = await edit([
      { name: "Proposta enviada", stage: "in_progress" },
      { name: "Lead", stage: "todo" },
      { name: "Contrato", stage: "in_review" },
    ]);
    expect(reordered.columns.map((c) => c.name)).toEqual(["Proposta enviada", "Lead", "Contrato"]);
    // Moved of stage.
    const moved = await edit([
      { name: "Proposta enviada", stage: "in_progress" },
      { name: "Lead", stage: "in_progress" },
      { name: "Contrato", stage: "in_review" },
    ]);
    expect(moved.columns.map((c) => c.stage)).toEqual(["in_progress", "in_progress", "in_review"]);
    // Deleted.
    const left = await edit([{ name: "Lead", stage: "in_progress" }]);
    expect(left.columns).toEqual([{ name: "Lead", stage: "in_progress" }]);
    const stored = (await listColumnTemplates(f.db, f.owner.id, f.org.id)).find((t) => t.id === made.id);
    expect(stored?.columns).toEqual([{ name: "Lead", stage: "in_progress" }]);
  });

  test("a column renamed in place keeps its place and stage", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const made = await createColumnTemplate(deps, f.owner.id, f.org.id, {
      name: "Vendas",
      columns: [
        { name: "Lead", stage: "todo" },
        { name: "Proposta", stage: "in_progress" },
        { name: "Fechado", stage: "done" },
      ],
    });
    const renamed = await updateColumnTemplate(deps, f.owner.id, f.org.id, made.id, {
      columns: [
        { name: "Lead", stage: "todo" },
        { name: "Proposta enviada", stage: "in_progress" },
        { name: "Fechado", stage: "done" },
      ],
    });
    expect(renamed.columns).toEqual([
      { name: "Lead", stage: "todo" },
      { name: "Proposta enviada", stage: "in_progress" },
      { name: "Fechado", stage: "done" },
    ]);
  });

  test("columns reordered with their names unchanged keep names and stages", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const made = await createColumnTemplate(deps, f.owner.id, f.org.id, {
      name: "Vendas",
      columns: [
        { name: "Lead", stage: "todo" },
        { name: "Proposta", stage: "in_progress" },
        { name: "Fechado", stage: "done" },
      ],
    });
    const reordered = await updateColumnTemplate(deps, f.owner.id, f.org.id, made.id, {
      columns: [
        { name: "Fechado", stage: "done" },
        { name: "Lead", stage: "todo" },
        { name: "Proposta", stage: "in_progress" },
      ],
    });
    expect(reordered.columns).toEqual([
      { name: "Fechado", stage: "done" },
      { name: "Lead", stage: "todo" },
      { name: "Proposta", stage: "in_progress" },
    ]);
    const stored = (await listColumnTemplates(f.db, f.owner.id, f.org.id)).find((t) => t.id === made.id);
    expect(stored?.columns.map((c) => c.name)).toEqual(["Fechado", "Lead", "Proposta"]);
  });

  test("a board made in a company from a set's id ends with that set's columns", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const company = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Clínica Teo" });
    const own = await createColumnTemplate(deps, f.owner.id, f.org.id, {
      name: "Suporte",
      columns: [
        { name: "Triagem", stage: "todo" },
        { name: "Em atendimento", stage: "in_progress" },
        { name: "Resolvido", stage: "done" },
      ],
    });
    // The new-board dialog creates the board, then applies the chosen set's id.
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Atendimento", spaceId: company.id });
    await applyColumnTemplate(deps, f.owner.id, f.org.id, board.id, own.id);
    const columns = await listIssueColumns(f.db, f.owner.id, f.org.id, board.id);
    expect(columns.map((c) => [c.name, c.stage])).toEqual(own.columns.map((c) => [c.name, c.stage]));
    // A copy: editing the set afterwards leaves the board's columns as they were.
    await updateColumnTemplate(deps, f.owner.id, f.org.id, own.id, { columns: [{ name: "Só uma", stage: "todo" }] });
    expect((await listIssueColumns(f.db, f.owner.id, f.org.id, board.id)).map((c) => c.name)).toEqual([
      "Triagem",
      "Em atendimento",
      "Resolvido",
    ]);
    // A seeded set works the same way.
    const kanban = (await listColumnTemplates(f.db, f.owner.id, f.org.id)).find((t) => t.name === "Kanban");
    const other = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Obras", spaceId: company.id });
    await applyColumnTemplate(deps, f.owner.id, f.org.id, other.id, kanban?.id as string);
    expect((await listIssueColumns(f.db, f.owner.id, f.org.id, other.id)).map((c) => c.name)).toEqual(
      kanban?.columns.map((c) => c.name),
    );
  });

  test("deleting a set keeps the boards' columns", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const made = await createColumnTemplate(deps, f.owner.id, f.org.id, {
      name: "Vendas",
      columns: [
        { name: "Lead", stage: "todo" },
        { name: "Fechado", stage: "done" },
      ],
    });
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Pipeline" });
    await applyColumnTemplate(deps, f.owner.id, f.org.id, board.id, made.id);
    await deleteColumnTemplate(deps, f.owner.id, f.org.id, made.id);
    expect((await listColumnTemplates(f.db, f.owner.id, f.org.id)).some((t) => t.id === made.id)).toBe(false);
    const columns = await listIssueColumns(f.db, f.owner.id, f.org.id, board.id);
    expect(columns.map((c) => c.name)).toEqual(["Lead", "Fechado"]);
  });

  test("refuses an empty or over-long name", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const columns = [{ name: "Lead", stage: "todo" as const }];
    for (const name of ["", "   ", "x".repeat(41)]) {
      const refused = await rejection(createColumnTemplate(deps, f.owner.id, f.org.id, { name, columns }));
      expect(refused).toBeInstanceOf(ValidationError);
      expect(refused).toMatchObject({ code: "issue_template.name_invalid", params: { max: 40 } });
    }
    expect(
      (await createColumnTemplate(deps, f.owner.id, f.org.id, { name: "x".repeat(40), columns })).name,
    ).toHaveLength(40);
    const made = await createColumnTemplate(deps, f.owner.id, f.org.id, { name: "Ok", columns });
    expect(
      await rejection(updateColumnTemplate(deps, f.owner.id, f.org.id, made.id, { name: "y".repeat(41) })),
    ).toMatchObject({ code: "issue_template.name_invalid", params: { max: 40 } });
    expect(await rejection(updateColumnTemplate(deps, f.owner.id, f.org.id, made.id, { name: "" }))).toMatchObject({
      code: "issue_template.name_invalid",
    });
  });

  test("two renames to one name at once leave the loser a name_taken answer", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const columns = [{ name: "Lead", stage: "todo" as const }];
    const a = await createColumnTemplate(deps, f.owner.id, f.org.id, { name: "A", columns });
    const b = await createColumnTemplate(deps, f.owner.id, f.org.id, { name: "B", columns });
    const results = await Promise.all([
      rejection(updateColumnTemplate(deps, f.owner.id, f.org.id, a.id, { name: "Same" })),
      rejection(updateColumnTemplate(deps, f.owner.id, f.org.id, b.id, { name: "same" })),
    ]);
    const refused = results.filter((r) => r !== undefined);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toBeInstanceOf(ValidationError);
    expect(refused[0]).toMatchObject({ code: "issue_template.name_taken" });
  });

  test("refuses a set with no columns, and a member who may not create tasks", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    expect(
      await rejection(createColumnTemplate(deps, f.owner.id, f.org.id, { name: "Vazio", columns: [] })),
    ).toMatchObject({
      code: "issue_template.empty",
    });
    const made = await createColumnTemplate(deps, f.owner.id, f.org.id, {
      name: "Vendas",
      columns: [{ name: "Lead", stage: "todo" }],
    });
    expect(await rejection(updateColumnTemplate(deps, f.owner.id, f.org.id, made.id, { columns: [] }))).toMatchObject({
      code: "issue_template.empty",
    });
    const outsider = await rejection(
      createColumnTemplate(deps, "someone-else", f.org.id, { name: "Z", columns: [{ name: "A", stage: "todo" }] }),
    );
    expect(outsider).toBeDefined();
    // A member without the permission to post (the workspace's base role lacks it).
    const guest = await addMember(f.db, f.org.id, "member", "gus");
    await f.db.update(schema.orgRoles).set({ permissions: [] }).where(eq(schema.orgRoles.kind, "everyone"));
    expect(
      await rejection(
        createColumnTemplate(deps, guest.id, f.org.id, { name: "Z", columns: [{ name: "A", stage: "todo" }] }),
      ),
    ).toBeInstanceOf(ForbiddenError);
    expect(await rejection(updateColumnTemplate(deps, guest.id, f.org.id, made.id, { name: "Z" }))).toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("stores a set under the org_id", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const made = await createColumnTemplate(deps, f.owner.id, f.org.id, {
      name: "Vendas",
      columns: [{ name: "Lead", stage: "todo" }],
    });
    const [row] = await f.db
      .select()
      .from(schema.issueColumnTemplates)
      .where(eq(schema.issueColumnTemplates.id, made.id));
    expect(row?.orgId).toBe(f.org.id);
  });
});
