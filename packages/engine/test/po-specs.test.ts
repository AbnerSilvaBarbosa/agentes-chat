import { afterEach, describe, expect, test } from "bun:test";
import { countQueries, eq, schema } from "@agenteschat/db";
import {
  applyColumnTemplate,
  createIssue,
  createIssueColumn,
  createIssueProject,
  createIssueSpace,
  createWikiPage,
  deleteWikiPage,
  getIssue,
  listColumnTemplates,
  listIssueActivity,
  listIssues,
  specColumns,
  updateIssue,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

async function board(name: string, template?: string) {
  const deps = { db: f.db, pubsub: f.pubsub };
  const company = await createIssueSpace(deps, f.owner.id, f.org.id, { name: `Empresa ${name}` });
  const project = await createIssueProject(deps, f.owner.id, f.org.id, { name, spaceId: company.id });
  if (template) {
    const sets = await listColumnTemplates(f.db, f.owner.id, f.org.id);
    const set = sets.find((s) => s.name === template);
    if (!set) throw new Error("missing seeded set");
    await applyColumnTemplate(deps, f.owner.id, f.org.id, project.id, set.id);
  }
  return { deps, project };
}

const add = (
  b: Awaited<ReturnType<typeof board>>,
  name: string,
  stage: "todo" | "in_progress" | "in_review" | "done",
) => createIssueColumn(b.deps, f.owner.id, f.org.id, { name, stage, projectId: b.project.id });

describe("the columns a spec moves a card through", () => {
  test("the card is born in the todo column named Especificar, and Ready for dev is never the target", async () => {
    f = await setup();
    const { project } = await board("CRM", "Desenvolvimento");
    const { specify, prioritized } = await specColumns(f.db, f.org.id, project.id);
    expect(specify.name).toBe("Especificar");
    expect(specify.stage).toBe("todo");
    // The seeded pipeline has Backlog and Especificar as its only todo columns and no Priorizado: no target, and
    // never its "Ready for dev" that follows.
    expect(prioritized).toBeNull();
  });

  test("the names are matched in any capitals", async () => {
    f = await setup();
    const b = await board("Site");
    await add(b, "ESPECIFICAR", "todo");
    await add(b, "priorizado", "in_progress");
    const { specify, prioritized } = await specColumns(f.db, f.org.id, b.project.id);
    expect(specify.name).toBe("ESPECIFICAR");
    expect(prioritized?.name).toBe("priorizado");
  });

  test("falls back to the first todo column and the next todo column", async () => {
    f = await setup();
    const b = await board("Loja");
    await add(b, "Ideias", "todo");
    const { specify, prioritized } = await specColumns(f.db, f.org.id, b.project.id);
    // The board kept the workspace's todo column first (no name of its own), the added one after it.
    expect(specify.stage).toBe("todo");
    expect(specify.name).toBeNull();
    expect(prioritized?.name).toBe("Ideias");
  });

  test("a todo column named Ready for dev is never chosen, even as the fallback", async () => {
    f = await setup();
    const b = await board("App");
    await add(b, "Ready for dev", "todo");
    const { specify, prioritized } = await specColumns(f.db, f.org.id, b.project.id);
    expect(specify.name).not.toBe("Ready for dev");
    expect(prioritized).toBeNull();
  });

  test("Priorizado wins over the fallback even when it sits in another stage", async () => {
    f = await setup();
    const b = await board("Portal");
    await add(b, "Especificar", "todo");
    await add(b, "Outra", "todo");
    await add(b, "Priorizado", "in_review");
    const { specify, prioritized } = await specColumns(f.db, f.org.id, b.project.id);
    expect(specify.name).toBe("Especificar");
    expect(prioritized?.name).toBe("Priorizado");
    expect(prioritized?.stage).toBe("in_review");
  });

  test("a board with no columns of its own reads the workspace's", async () => {
    f = await setup();
    const { project } = await board("Sem colunas");
    const { specify, prioritized } = await specColumns(f.db, f.org.id, project.id);
    expect(specify.projectId).toBeNull();
    expect(specify.stage).toBe("todo");
    expect(prioritized).toBeNull();
  });
});

describe("a card links its spec page", () => {
  const wikiDeps = () => ({ db: f.db, pubsub: f.pubsub, search: f.context, artifacts: f.artifactDeps });
  const owner = () => ({ type: "person" as const, userId: f.owner.id });
  const card = (title = "Cadastro") => createIssue({ db: f.db, pubsub: f.pubsub }, owner(), f.org.id, { title });
  const page = (title: string) => createWikiPage(wikiDeps(), owner(), f.org.id, { title, body: "Spec." });

  test("a card with no spec has no specPage, and linking one shows its id, slug and title", async () => {
    f = await setup();
    const issue = await card();
    expect(issue.specPage).toBeNull();
    const spec = await page("Spec do cadastro");
    const linked = await updateIssue({ db: f.db, pubsub: f.pubsub }, owner(), f.org.id, issue.id, {
      specPageId: spec.id,
    });
    expect(linked.specPage).toEqual({ id: spec.id, slug: spec.slug, title: "Spec do cadastro" });
    expect((await getIssue(f.db, owner(), f.org.id, { id: issue.id })).specPage?.slug).toBe(spec.slug);
  });

  test("linking writes one spec_linked event and a repeat writes none; null unlinks", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const issue = await card();
    const spec = await page("Spec A");
    await updateIssue(deps, owner(), f.org.id, issue.id, { specPageId: spec.id });
    await updateIssue(deps, owner(), f.org.id, issue.id, { specPageId: spec.id });
    const events = () =>
      listIssueActivity(f.db, owner(), f.org.id, issue.id).then((a) => a.filter((x) => x.event === "spec_linked"));
    expect(await events()).toHaveLength(1);
    const cleared = await updateIssue(deps, owner(), f.org.id, issue.id, { specPageId: null });
    expect(cleared.specPage).toBeNull();
    expect(await events()).toHaveLength(2);
  });

  test("a page that does not exist in the workspace is refused and the card keeps no link", async () => {
    f = await setup();
    const issue = await card();
    await expect(
      updateIssue({ db: f.db, pubsub: f.pubsub }, owner(), f.org.id, issue.id, {
        specPageId: "019e0000-0000-7000-8000-000000000000",
      }),
    ).rejects.toThrow();
    expect((await getIssue(f.db, owner(), f.org.id, { id: issue.id })).specPage).toBeNull();
  });

  test("a trashed page reads as no spec, and a restricted page keeps its title out", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const a = await card("Um");
    const b = await card("Dois");
    const gone = await page("Apagada");
    const secret = await page("Segredo");
    await updateIssue(deps, owner(), f.org.id, a.id, { specPageId: gone.id });
    await updateIssue(deps, owner(), f.org.id, b.id, { specPageId: secret.id });
    await deleteWikiPage(wikiDeps(), owner(), f.org.id, gone.slug);
    await f.db.update(schema.wikiPages).set({ restricted: true }).where(eq(schema.wikiPages.id, secret.id));
    expect((await getIssue(f.db, owner(), f.org.id, { id: a.id })).specPage).toBeNull();
    expect((await getIssue(f.db, owner(), f.org.id, { id: b.id })).specPage).toEqual({
      id: secret.id,
      slug: secret.slug,
      title: null,
    });
  });

  test("a list of 200 linked cards reads its pages with the queries of a list of 2", async () => {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    const spec = await page("Spec comum");
    const first = await card("Base");
    await updateIssue(deps, owner(), f.org.id, first.id, { specPageId: spec.id });
    const [row] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, first.id));
    if (!row) throw new Error("no row");
    const two = await countQueries(() => listIssues(f.db, owner(), f.org.id));
    const { id: _id, number, ...rest } = row;
    await f.db
      .insert(schema.issues)
      .values(Array.from({ length: 199 }, (_, i) => ({ ...rest, number: number + 1 + i, title: `Copia ${i}` })));
    const many = await countQueries(() => listIssues(f.db, owner(), f.org.id, { limit: 500 }));
    expect(many.result).toHaveLength(200);
    expect(many.result.every((c) => c.specPage?.title === "Spec comum")).toBe(true);
    expect(many.queries).toBe(two.queries);
  });
});
