import { afterEach, describe, expect, test } from "bun:test";
import {
  applyColumnTemplate,
  createIssueColumn,
  createIssueProject,
  createIssueSpace,
  listColumnTemplates,
  specColumns,
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
