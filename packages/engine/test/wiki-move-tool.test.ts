import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import { createWikiPage, deleteWikiPage, getWikiPage, insertMessage, type ToolContext, type WikiActor } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string): WikiActor => ({ type: "person", userId });
const wikiDeps = () => ({ db: f.db, pubsub: f.pubsub, search: f.context, artifacts: f.artifactDeps });

/** A run on a message the owner wrote: the agent acts at their request. */
async function askedBy(userId: string, body = "@dev organiza essas páginas na wiki"): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId },
    body,
  });
  const [run] = await f.db
    .insert(schema.agentRuns)
    .values({
      orgId: f.org.id,
      agentId: f.agent.id,
      channelId: f.general.id,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 0,
      status: "running",
    })
    .returning();
  return {
    db: f.db,
    orgId: f.org.id,
    agentId: f.agent.id,
    runId: (run as { id: string }).id,
    channelId: f.general.id,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

async function move(ctx: ToolContext, input: { pages: string[]; folder: string }) {
  const tool = (await f.tools?.list(ctx))?.find((t) => t.name === "move_wiki_page");
  if (!tool) throw new Error("move_wiki_page is not offered");
  return tool.execute(input, ctx);
}

const page = (title: string, folder?: string, body = "texto") =>
  createWikiPage(wikiDeps(), person(f.owner.id), f.org.id, { title, folder, body });
const folderOf = async (ref: string) => (await getWikiPage(f.db, person(f.owner.id), f.org.id, ref)).folder;

describe("move_wiki_page", () => {
  test("moves a page and says where it went", async () => {
    f = await setup({ wikiTools: true });
    await page("Spec 72");
    const out = await move(await askedBy(f.owner.id), { pages: ["Spec 72"], folder: "MBS/Specs/72" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("[[Spec 72]]");
    expect(out.content).toContain('"MBS/Specs/72"');
    expect(await folderOf("spec-72")).toBe("MBS/Specs/72");
  });

  test("moves several pages and lists the refused", async () => {
    f = await setup({ wikiTools: true });
    await page("Um");
    await page("Dois");
    const out = await move(await askedBy(f.owner.id), { pages: ["Um", "Dois", "Nao existe"], folder: "Pasta" });
    expect(await folderOf("um")).toBe("Pasta");
    expect(await folderOf("dois")).toBe("Pasta");
    expect(out.content).toContain("[[Um]]");
    expect(out.content).toContain("[[Dois]]");
    expect(out.content).toMatch(/Refused:\n- Nao existe: .*not found/i);
  });

  test("an empty folder moves a page to the root", async () => {
    f = await setup({ wikiTools: true });
    await page("Solta", "Antiga");
    const out = await move(await askedBy(f.owner.id), { pages: ["solta"], folder: "" });
    expect(out.content).toContain("the top level");
    expect(await folderOf("solta")).toBe("");
  });

  test("a moved page keeps its address and its links", async () => {
    f = await setup({ wikiTools: true });
    await page("Alvo");
    await page("Origem", undefined, "Veja [[Alvo]].");
    await move(await askedBy(f.owner.id), { pages: ["Alvo"], folder: "Arquivo" });
    const target = await getWikiPage(f.db, person(f.owner.id), f.org.id, "alvo");
    expect(target.slug).toBe("alvo");
    expect(target.backlinks.map((b) => (b.kind === "page" ? b.slug : ""))).toContain("origem");
  });

  test("records the move with the agent as actor", async () => {
    f = await setup({ wikiTools: true });
    const p = await page("Auditada", "A");
    await move(await askedBy(f.owner.id), { pages: ["Auditada"], folder: "B" });
    const rows = (await f.db.select().from(schema.auditLog)).filter((r) => r.action === "wiki.page_moved");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "agent", actorId: f.agent.id, targetId: p.id });
    expect(rows[0]?.details).toEqual({ from: "A", to: "B" });
  });

  test("a page already in the folder is left alone", async () => {
    f = await setup({ wikiTools: true });
    const p = await page("Quieta", "Casa");
    const out = await move(await askedBy(f.owner.id), { pages: ["Quieta"], folder: "Casa" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('[[Quieta]] was in "Casa" already');
    const after = await getWikiPage(f.db, person(f.owner.id), f.org.id, "quieta");
    expect(after.version).toBe(p.version);
    expect((await f.db.select().from(schema.auditLog)).filter((r) => r.action === "wiki.page_moved")).toEqual([]);
  });

  test("an empty list, over twenty and the same page twice", async () => {
    f = await setup({ wikiTools: true });
    await page("Repetida");
    const ctx = await askedBy(f.owner.id);
    const empty = await move(ctx, { pages: [], folder: "X" });
    expect(empty).toMatchObject({ isError: true });
    expect(empty.content).toMatch(/at least one page/);
    const many = await move(ctx, { pages: Array.from({ length: 21 }, (_, i) => `p${i}`), folder: "X" });
    expect(many).toMatchObject({ isError: true });
    expect(many.content).toMatch(/at most 20/);
    const twice = await move(ctx, { pages: ["Repetida", "repetida"], folder: "X" });
    expect(twice.content.match(/\[\[Repetida\]\]/g)).toHaveLength(1);
    expect(twice.content).not.toContain("Refused");
    expect(await folderOf("repetida")).toBe("X");
  });

  test("a title always names one page, so a move never has to pick between two", async () => {
    f = await setup({ wikiTools: true });
    await page("Plano", "A");
    await page("Plano B", "A");
    // A second page cannot take the same address, so no title can match two pages.
    await expect(page("Plano", "B")).rejects.toMatchObject({ code: "slug_taken" });
    const out = await move(await askedBy(f.owner.id), { pages: ["Plano"], folder: "C" });
    expect(out.content).not.toContain("Refused");
    expect(await folderOf("plano")).toBe("C");
    expect(await folderOf("plano-b")).toBe("A");
  });

  test("a deleted page is no such page", async () => {
    f = await setup({ wikiTools: true });
    await page("Apagada");
    await deleteWikiPage(wikiDeps(), person(f.owner.id), f.org.id, "apagada");
    const out = await move(await askedBy(f.owner.id), { pages: ["Apagada"], folder: "X" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Apagada: .*not found/i);
  });

  test("a folder name over the limit is refused", async () => {
    f = await setup({ wikiTools: true });
    await page("Curta");
    const out = await move(await askedBy(f.owner.id), { pages: ["Curta"], folder: "x".repeat(201) });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("200");
    expect(await folderOf("curta")).toBe("");
  });
});
