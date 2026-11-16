import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { NotFoundError, poProgress } from "../src";
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
type Stage = "todo" | "in_progress" | "in_review" | "done" | "canceled";
type Spec = [name: string | null, stage: Stage];
let counter = 0;

/** The pipeline a software board runs, the PO's boards: Especificar and Especificado before Ready for dev. */
const PIPELINE: Spec[] = [
  ["Especificar", "todo"],
  ["Especificado", "todo"],
  ["Ready for dev", "in_progress"],
  ["Em desenvolvimento", "in_progress"],
  ["Revisão QA", "in_review"],
  ["Concluído", "done"],
];

/** A company with boards that own the given columns, and a way to put cards in them. */
async function company(name = "Acme") {
  const [space] = await f.db.insert(schema.issueSpaces).values({ orgId: f.org.id, name }).returning();
  const spaceId = must(space).id;
  const board = async (boardName: string, columns: Spec[] = PIPELINE) => {
    const [row] = await f.db
      .insert(schema.issueProjects)
      .values({ orgId: f.org.id, name: boardName, spaceId })
      .returning();
    const projectId = must(row).id;
    const made: Record<string, typeof schema.issueColumns.$inferSelect> = {};
    for (const [i, [columnName, stage]] of columns.entries()) {
      const [col] = await f.db
        .insert(schema.issueColumns)
        .values({ orgId: f.org.id, projectId, stage, name: columnName, position: i })
        .returning();
      made[columnName ?? `stage:${stage}`] = must(col);
    }
    const card = async (title: string, columnName: string, extra: Partial<typeof schema.issues.$inferInsert> = {}) => {
      const column = must(made[columnName]);
      const [issue] = await f.db
        .insert(schema.issues)
        .values({
          orgId: f.org.id,
          number: ++counter,
          title,
          projectId,
          status: column.stage,
          columnId: column.id,
          createdByType: "person",
          createdById: f.owner.id,
          ...extra,
        })
        .returning();
      return must(issue);
    };
    return { id: projectId, row: must(row), columns: made, card };
  };
  return { spaceId, board };
}

const read = (spaceId: string, userId = f.owner.id) => poProgress(f.db, userId, f.org.id, spaceId);
const group = (p: Awaited<ReturnType<typeof read>>, key: string) => must(p.groups.find((g) => g.key === key));

describe("poProgress", () => {
  test("groups the cards by the board's columns in board order, each with its count", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Entregas");
    await b.card("A", "Especificar");
    await b.card("B", "Especificar");
    await b.card("C", "Especificado");
    await b.card("D", "Ready for dev");
    await b.card("E", "Em desenvolvimento");
    const p = await read(c.spaceId);
    expect(p.space).toEqual({ id: c.spaceId, name: "Acme" });
    expect(p.groups.map((g) => [g.key, g.count])).toEqual([
      ["especificar", 2],
      ["especificado", 1],
      ["ready for dev", 1],
      ["tail", 1],
    ]);
    expect(group(p, "especificar").items.map((i) => i.title)).toEqual(["A", "B"]);
    expect(group(p, "especificar").name).toBe("Especificar");
  });

  test("an older board's Priorizado is the group after Especificar", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Antigo", [
      ["Especificar", "todo"],
      ["Priorizado", "todo"],
      ["Ready for dev", "in_progress"],
      ["Em dev", "in_progress"],
      ["Concluído", "done"],
    ]);
    await b.card("Escolhido", "Priorizado");
    const p = await read(c.spaceId);
    expect(p.groups.map((g) => g.key)).toEqual(["especificar", "priorizado", "ready for dev", "tail"]);
    expect(group(p, "priorizado").items.map((i) => i.title)).toEqual(["Escolhido"]);
  });

  test("every column after Ready for dev is one tail group of the open stages", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Entregas");
    await b.card("Dev", "Em desenvolvimento");
    await b.card("QA", "Revisão QA");
    await b.card("Feito", "Concluído");
    const p = await read(c.spaceId);
    const tail = group(p, "tail");
    expect(tail.kind).toBe("tail");
    expect(tail.count).toBe(2);
    expect(tail.items.map((i) => i.title).sort()).toEqual(["Dev", "QA"]);
    expect(tail.columns.sort()).toEqual(["em desenvolvimento", "revisão qa"]);
    // A board that has no Ready for dev: to-do columns are groups, the later open ones the tail.
    const plain = await c.board("Simples", [
      ["A fazer", "todo"],
      ["Em andamento", "in_progress"],
      ["Concluído", "done"],
    ]);
    await plain.card("Solto", "Em andamento");
    const again = await read(c.spaceId);
    expect(again.groups.map((g) => g.key)).toEqual(["especificar", "especificado", "ready for dev", "a fazer", "tail"]);
    expect(group(again, "tail").count).toBe(3);
  });

  test("lists at most 8 cards a group and counts all of them", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Entregas");
    for (let i = 1; i <= 11; i++) await b.card(`Card ${i}`, "Especificar");
    const g = group(await read(c.spaceId), "especificar");
    expect(g.count).toBe(11);
    expect(g.items).toHaveLength(8);
  });

  test("columns of the same name on two boards are one group, each card naming its board", async () => {
    f = await setup();
    const c = await company();
    const first = await c.board("Site");
    const second = await c.board("App", [
      ["especificar", "todo"],
      ["Ready for dev", "in_progress"],
      ["Em dev", "in_progress"],
      ["Concluído", "done"],
    ]);
    await first.card("Da home", "Especificar");
    await second.card("Do login", "especificar");
    const p = await read(c.spaceId);
    expect(p.groups.filter((g) => g.key === "especificar")).toHaveLength(1);
    const g = group(p, "especificar");
    expect(g.count).toBe(2);
    expect(g.items.map((i) => [i.title, i.boardName]).sort()).toEqual([
      ["Da home", "Site"],
      ["Do login", "App"],
    ]);
  });

  test("leaves out a card the person may not see, a canceled one and a card of an archived board", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    const c = await company();
    const b = await c.board("Entregas");
    const old = await c.board("Velho");
    await b.card("Visível", "Especificar");
    await b.card("Só do dono", "Especificar", { restricted: true, audienceUserIds: [f.owner.id] });
    await b.card("Cancelado", "Especificar", { status: "canceled" });
    await old.card("No arquivado", "Especificar");
    await f.db.update(schema.issueProjects).set({ archivedAt: new Date() }).where(eq(schema.issueProjects.id, old.id));
    const asMember = await read(c.spaceId, member.id);
    expect(group(asMember, "especificar").items.map((i) => i.title)).toEqual(["Visível"]);
    expect(group(asMember, "especificar").count).toBe(1);
    const asOwner = await read(c.spaceId);
    expect(group(asOwner, "especificar").items.map((i) => i.title)).toEqual(["Visível", "Só do dono"]);
  });

  test("counts done cards in one number and lists none", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Entregas");
    await b.card("Feito 1", "Concluído");
    await b.card("Feito 2", "Concluído");
    await b.card("Aberto", "Especificar");
    const p = await read(c.spaceId);
    expect(p.done).toBe(2);
    expect(p.groups.flatMap((g) => g.items.map((i) => i.title))).toEqual(["Aberto"]);
  });

  test("a card in Especificar carries its spec state and reason", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Entregas");
    const states: [string, "queued" | "running" | "failed", string | null][] = [
      ["Na fila", "queued", null],
      ["Rodando", "running", null],
      ["Falhou", "failed", "no_spec_page"],
    ];
    for (const [title, state, error] of states) {
      const card = await b.card(title, "Especificar");
      await f.db.insert(schema.poCardProposals).values({
        orgId: f.org.id,
        agentId: f.agent.id,
        requesterUserId: f.owner.id,
        channelId: crypto.randomUUID(),
        spaceId: c.spaceId,
        projectId: b.id,
        title,
        status: "confirmed",
        issueId: card.id,
        specState: state,
        specError: error,
      });
    }
    await b.card("Sem spec", "Especificar");
    const items = group(await read(c.spaceId), "especificar").items;
    const by = (title: string) => must(items.find((i) => i.title === title));
    expect(by("Na fila").spec).toEqual({ state: "queued", page: null, error: null });
    expect(by("Rodando").spec).toEqual({ state: "running", page: null, error: null });
    expect(by("Falhou").spec).toEqual({ state: "failed", page: null, error: "no_spec_page" });
    expect(by("Sem spec").spec).toBeNull();
  });

  test("a card with a spec page carries its page wherever it sits", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Entregas");
    const page = async (slug: string, restricted = false) =>
      must(
        (
          await f.db
            .insert(schema.wikiPages)
            .values({
              orgId: f.org.id,
              slug,
              title: `Spec ${slug}`,
              restricted,
              createdByType: "person",
              createdById: f.owner.id,
              updatedByType: "person",
              updatedById: f.owner.id,
            })
            .returning()
        )[0],
      );
    const ready = await page("spec-pronto");
    const secret = await page("spec-secreta", true);
    await b.card("Pronto", "Ready for dev", { specPageId: ready.id });
    await b.card("Secreto", "Ready for dev", { specPageId: secret.id });
    const items = group(await read(c.spaceId), "ready for dev").items;
    const by = (title: string) => must(items.find((i) => i.title === title));
    expect(by("Pronto").spec).toEqual({
      state: "done",
      page: { slug: "spec-pronto", title: "Spec spec-pronto" },
      error: null,
    });
    // A page the viewer may not open is no link.
    expect(by("Secreto").spec).toBeNull();
  });

  test("orders a group longest in the column first and reports the column clock", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Entregas");
    const at = (days: number) => new Date(Date.parse("2026-11-10T12:00:00Z") - days * 86_400_000);
    await b.card("Recente", "Especificar", { columnSince: at(1) });
    await b.card("Antigo", "Especificar", { columnSince: at(9) });
    const items = group(await read(c.spaceId), "especificar").items;
    expect(items.map((i) => i.title)).toEqual(["Antigo", "Recente"]);
    expect(items[0]?.since).toBe(at(9).toISOString());
  });

  test("a renamed column shows its new name on the next read", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Entregas");
    await b.card("A", "Especificar");
    expect(group(await read(c.spaceId), "especificar").name).toBe("Especificar");
    await f.db
      .update(schema.issueColumns)
      .set({ name: "Escrever spec" })
      .where(eq(schema.issueColumns.id, must(b.columns.Especificar).id));
    const p = await read(c.spaceId);
    expect(p.groups[0]?.name).toBe("Escrever spec");
    expect(p.groups[0]?.key).toBe("escrever spec");
    expect(p.groups[0]?.count).toBe(1);
  });

  test("a board that follows the workspace's column set is grouped by the stage columns", async () => {
    f = await setup();
    const c = await company();
    const [row] = await f.db
      .insert(schema.issueProjects)
      .values({ orgId: f.org.id, name: "Sem colunas", spaceId: c.spaceId })
      .returning();
    const projectId = must(row).id;
    const task = (title: string, status: "todo" | "in_progress") =>
      f.db.insert(schema.issues).values({
        orgId: f.org.id,
        number: ++counter,
        title,
        projectId,
        status,
        createdByType: "person",
        createdById: f.owner.id,
      });
    await task("A fazer", "todo");
    await task("Andando", "in_progress");
    const p = await read(c.spaceId);
    expect(p.groups.map((g) => [g.key, g.count])).toEqual([
      ["stage:todo", 1],
      ["tail", 1],
    ]);
    expect(group(p, "stage:todo").items.map((i) => i.title)).toEqual(["A fazer"]);
  });

  test("the done count leaves out a hidden, an archived board's and another company's done card", async () => {
    f = await setup();
    const member = await addMember(f.db, f.org.id, "member", "Bia");
    const c = await company();
    const other = await company("Outra");
    const b = await c.board("Entregas");
    const old = await c.board("Velho");
    const elsewhere = await other.board("De fora");
    await b.card("Feito", "Concluído");
    await b.card("Só do dono", "Concluído", { restricted: true, audienceUserIds: [f.owner.id] });
    await old.card("No arquivado", "Concluído");
    await elsewhere.card("Da outra", "Concluído");
    await f.db.update(schema.issueProjects).set({ archivedAt: new Date() }).where(eq(schema.issueProjects.id, old.id));
    expect((await read(c.spaceId, member.id)).done).toBe(1);
    expect((await read(c.spaceId)).done).toBe(2);
  });

  test("a stopped spec carries its state and the stopped code", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Entregas");
    const card = await b.card("Parou", "Especificar");
    await f.db.insert(schema.poCardProposals).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      requesterUserId: f.owner.id,
      channelId: crypto.randomUUID(),
      spaceId: c.spaceId,
      projectId: b.id,
      title: "Parou",
      status: "confirmed",
      issueId: card.id,
      specState: "stopped",
      specError: "stopped",
    });
    const item = must(group(await read(c.spaceId), "especificar").items[0]);
    expect(item.spec).toEqual({ state: "stopped", page: null, error: "stopped" });
  });

  test("a spec's reason is a fixed code, never the text the proposal holds", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Entregas");
    const card = await b.card("Falhou", "Especificar");
    await f.db.insert(schema.poCardProposals).values({
      orgId: f.org.id,
      agentId: f.agent.id,
      requesterUserId: f.owner.id,
      channelId: crypto.randomUUID(),
      spaceId: c.spaceId,
      projectId: b.id,
      title: "Falhou",
      status: "confirmed",
      issueId: card.id,
      specState: "failed",
      specError: "token sk-secret rejected by the provider",
    });
    const item = must(group(await read(c.spaceId), "especificar").items[0]);
    expect(item.spec).toEqual({ state: "failed", page: null, error: "failed" });
  });

  test("a to-do column listed after Ready for dev still has its cards in a group, none dropped", async () => {
    f = await setup();
    const c = await company();
    const b = await c.board("Estranho", [
      ["Especificar", "todo"],
      ["Ready for dev", "in_progress"],
      ["Voltou", "todo"],
      ["Concluído", "done"],
    ]);
    await b.card("Perdido", "Voltou");
    await b.card("Normal", "Especificar");
    const p = await read(c.spaceId);
    // The board draws the stages in order, so the to-do column is a group of its own; either way every open card counts once.
    expect(p.groups.reduce((n, g) => n + g.count, 0)).toBe(2);
    expect(p.groups.flatMap((g) => g.items.map((i) => i.title)).sort()).toEqual(["Normal", "Perdido"]);
  });

  test("a key that is a head column on one board is that group on every board, list and count alike", async () => {
    f = await setup();
    const c = await company();
    const first = await c.board("Site", [
      ["Revisão", "todo"],
      ["Ready for dev", "in_progress"],
      ["Concluído", "done"],
    ]);
    const second = await c.board("App", [
      ["Ready for dev", "in_progress"],
      ["Revisão", "in_review"],
      ["Concluído", "done"],
    ]);
    await first.card("Do site", "Revisão");
    await second.card("Do app", "Revisão");
    const p = await read(c.spaceId);
    expect(group(p, "revisão").count).toBe(2);
    expect(group(p, "revisão").columns).toEqual(["revisão"]);
    const tail = group(p, "tail");
    expect(tail.count).toBe(0);
    expect(tail.columns).not.toContain("revisão");
  });

  test("a company of another workspace is not found", async () => {
    f = await setup();
    const [org] = await f.db.insert(schema.organizations).values({ name: "Outra" }).returning();
    const [space] = await f.db
      .insert(schema.issueSpaces)
      .values({ orgId: must(org).id, name: "Da outra" })
      .returning();
    await expect(read(must(space).id)).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a company without a card has its groups empty and no done count", async () => {
    f = await setup();
    const c = await company();
    await c.board("Entregas");
    const p = await read(c.spaceId);
    expect(p.done).toBe(0);
    expect(p.groups.length).toBeGreaterThan(0);
    expect(p.groups.every((g) => g.count === 0 && g.items.length === 0)).toBe(true);
    // No board at all: nothing to group.
    const bare = await company("Sem board");
    expect((await read(bare.spaceId)).groups).toEqual([]);
  });
});
