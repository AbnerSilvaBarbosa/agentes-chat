import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, schema } from "@agenteschat/db";
import {
  createAgent,
  createWikiPage,
  DEFAULT_AGENT_SCOPES,
  deleteWikiPage,
  drainOutbox,
  getWikiPage,
  insertMessage,
  runRoutineNow,
  setAgentScopes,
  setWikiFolderAudience,
  setWikiPageAudience,
  setWikiPageLock,
  type ToolContext,
  WIKI_WRITE_REFUSAL,
  type WikiActor,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";
import { channelRoutine, routineDeps } from "./routine-fixtures";

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

  test("a ref naming no live page is no such page while the others still move", async () => {
    f = await setup({ wikiTools: true });
    await page("Um");
    await page("Dois");
    await page("Apagada");
    await deleteWikiPage(wikiDeps(), person(f.owner.id), f.org.id, "apagada");
    const out = await move(await askedBy(f.owner.id), {
      pages: ["Um", "Fantasma", "Apagada", "Dois"],
      folder: "Pasta",
    });
    expect(out.isError).toBeFalsy();
    expect(await folderOf("um")).toBe("Pasta");
    expect(await folderOf("dois")).toBe("Pasta");
    expect(out.content).toMatch(/- Fantasma: Page not found/);
    expect(out.content).toMatch(/- Apagada: Page not found/);
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

  test("a page the agent cannot see is no such page", async () => {
    f = await setup({ wikiTools: true });
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Infra", handle: "infra", role: "Infra", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await page("Segredo");
    await setWikiPageAudience(wikiDeps(), f.owner.id, f.org.id, "segredo", null, [other.id]);
    const out = await move(await askedBy(f.owner.id), { pages: ["Segredo"], folder: "X" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Segredo: Page not found/);
    expect(await folderOf("segredo")).toBe("");
  });

  test("a locked page is refused with the reason", async () => {
    f = await setup({ wikiTools: true });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await page("Trancada");
    await page("Dela");
    await setWikiPageLock(wikiDeps(), f.owner.id, f.org.id, "trancada", true);
    await setWikiPageAudience(wikiDeps(), f.owner.id, f.org.id, "dela", null, undefined, {
      editors: { roleIds: [], userIds: [f.owner.id] },
      agentEditorIds: null,
    });
    const out = await move(await askedBy(bia.id), { pages: ["Trancada", "Dela"], folder: "X" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Trancada: .*locked/);
    expect(out.content).toMatch(/Dela: .*Only the people chosen edit this page/);
    expect(await folderOf("trancada")).toBe("");
    expect(await folderOf("dela")).toBe("");
  });

  test("refuses a move into a closed folder that would hide the page from who asked", async () => {
    f = await setup({ wikiTools: true });
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await page("Aberta");
    await page("Livre");
    await setWikiFolderAudience(wikiDeps(), f.owner.id, f.org.id, "Fechada", { roleIds: [], userIds: [ana.id] }, null);
    const out = await move(await askedBy(bia.id), { pages: ["Aberta"], folder: "Fechada" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Aberta: You don't have access to this page/);
    expect(await folderOf("aberta")).toBe("");
    // A page already limited stays no wider where it lands: the folder cannot open it.
    await setWikiPageAudience(wikiDeps(), f.owner.id, f.org.id, "livre", null, [f.agent.id]);
    const open = await move(await askedBy(f.owner.id), { pages: ["Livre"], folder: "Qualquer" });
    expect(open.isError).toBeFalsy();
    const [row] = (await f.db.select().from(schema.wikiPages)).filter((r) => r.slug === "livre");
    expect(row).toMatchObject({ folder: "Qualquer", agentsLimited: true });
    expect(row?.audienceAgentIds).toEqual([f.agent.id]);
  });

  test("a page entering a limited folder takes its audience", async () => {
    f = await setup({ wikiTools: true });
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    await page("Entrando");
    await setWikiFolderAudience(wikiDeps(), f.owner.id, f.org.id, "Fechada", { roleIds: [], userIds: [ana.id] }, null);
    const out = await move(await askedBy(f.owner.id), { pages: ["Entrando"], folder: "Fechada" });
    expect(out.isError).toBeFalsy();
    const [row] = (await f.db.select().from(schema.wikiPages)).filter((r) => r.slug === "entrando");
    expect(row).toMatchObject({ folder: "Fechada", restricted: true, audienceFolder: "Fechada" });
    expect(row?.audienceUserIds).toEqual([ana.id]);
  });

  test("a run no one asked is refused", async () => {
    f = await setup({ wikiTools: true });
    await page("Intocada");
    const own = await insertMessage(f.db, {
      orgId: f.org.id,
      channelId: f.general.id,
      author: { type: "agent", agentId: f.agent.id, runId: null, hop: 0, stretchId: null },
      body: "Vou organizar a wiki.",
    });
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: f.agent.id,
      runId: crypto.randomUUID(),
      channelId: f.general.id,
      threadRootId: own.id,
      triggerMessageId: own.id,
    };
    expect(await move(ctx, { pages: ["Intocada"], folder: "X" })).toEqual({
      content: WIKI_WRITE_REFUSAL,
      isError: true,
    });
    expect(await folderOf("intocada")).toBe("");
  });

  test("without the wiki write scope the tool is not offered", async () => {
    f = await setup({ wikiTools: true });
    const ctx = await askedBy(f.owner.id);
    expect((await f.tools?.list(ctx))?.map((t) => t.name)).toContain("move_wiki_page");
    await setAgentScopes(
      f.db,
      f.owner.id,
      f.org.id,
      f.agent.id,
      DEFAULT_AGENT_SCOPES.filter((s) => s !== "wiki:write").map((scope) => ({ connectionId: null, scope })),
    );
    const listed = (await f.tools?.list(ctx))?.map((t) => t.name) ?? [];
    expect(listed).toContain("read_wiki_page");
    expect(listed).not.toContain("move_wiki_page");
  });

  test("empty levels and extra spaces do not count toward the folder limit", async () => {
    f = await setup({ wikiTools: true });
    await page("Curta");
    const out = await move(await askedBy(f.owner.id), {
      pages: ["Curta"],
      folder: `${"/".repeat(250)}z`,
    });
    expect(out.isError).toBeFalsy();
    expect(await folderOf("curta")).toBe("z");
  });

  test("a folder level over 80 characters is refused, never cut", async () => {
    f = await setup({ wikiTools: true });
    await page("Curta");
    const out = await move(await askedBy(f.owner.id), { pages: ["Curta"], folder: `Ok/${"y".repeat(150)}` });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("80");
    expect(await folderOf("curta")).toBe("");
  });

  test("a page limited to other people is no such page for who asked", async () => {
    f = await setup({ wikiTools: true });
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await page("Reservada");
    await setWikiPageAudience(wikiDeps(), f.owner.id, f.org.id, "reservada", { roleIds: [], userIds: [ana.id] });
    const out = await move(await askedBy(bia.id), { pages: ["Reservada"], folder: "X" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Reservada: Page not found/);
    expect(await folderOf("reservada")).toBe("");
  });

  test("an agent outside the page's editors is refused", async () => {
    f = await setup({ wikiTools: true });
    const other = await createAgent(
      f.db,
      f.owner.id,
      f.org.id,
      { name: "Infra", handle: "infra", role: "Infra", credentialId: f.credential.id },
      { model: "claude-sonnet-5-5" },
    );
    await page("Cuidada");
    await setWikiPageAudience(wikiDeps(), f.owner.id, f.org.id, "cuidada", null, undefined, {
      editors: null,
      agentEditorIds: [other.id],
    });
    const out = await move(await askedBy(f.owner.id), { pages: ["Cuidada"], folder: "X" });
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/Cuidada: Only the people chosen edit this page/);
    expect(await folderOf("cuidada")).toBe("");
  });

  test("a routine's run moves for its creator", async () => {
    f = await setup({ wikiTools: true });
    await page("Da rotina");
    const routine = await channelRoutine(f, { access: "act", prompt: "Guarda as páginas na pasta Rotina." });
    await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
    await drainOutbox(f.db, f.handlers);
    const run = (await f.db.select().from(schema.agentRuns)).find((r) => r.background);
    if (!run) throw new Error("the routine did not fire");
    const ctx: ToolContext = {
      db: f.db,
      orgId: f.org.id,
      agentId: run.agentId,
      runId: run.id,
      channelId: run.channelId,
      threadRootId: run.threadRootId,
      triggerMessageId: run.triggerMessageId ?? run.threadRootId,
    };
    const out = await move(ctx, { pages: ["Da rotina"], folder: "Rotina" });
    expect(out.isError).toBeFalsy();
    expect(await folderOf("da-rotina")).toBe("Rotina");
  });

  test("the right hand does not move a page for someone who may not edit the wiki", async () => {
    f = await setup({ wikiTools: true });
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    await page("Dele");
    await f.db.update(schema.agents).set({ builtin: "right_hand" }).where(eq(schema.agents.id, f.agent.id));
    const [everyone] = await f.db
      .select()
      .from(schema.orgRoles)
      .where(and(eq(schema.orgRoles.orgId, f.org.id), eq(schema.orgRoles.kind, "everyone")));
    await f.db
      .update(schema.orgRoles)
      .set({ permissions: (everyone?.permissions ?? []).filter((k) => k !== "edit_wiki") })
      .where(eq(schema.orgRoles.id, everyone?.id ?? ""));
    const out = await move(await askedBy(bia.id), { pages: ["Dele"], folder: "X" });
    expect(out).toEqual({ content: WIKI_WRITE_REFUSAL, isError: true });
    expect(await folderOf("dele")).toBe("");
  });

  test("a limited page entering a narrower folder is narrowed and the answer says so", async () => {
    f = await setup({ wikiTools: true });
    const ana = await addMember(f.db, f.org.id, "member", "ana");
    const bia = await addMember(f.db, f.org.id, "member", "bia");
    // Restricted pages reach a run only through its conversation's members: a private channel of these three.
    await f.db.update(schema.channels).set({ visibility: "private" }).where(eq(schema.channels.id, f.general.id));
    await page("Dupla");
    await setWikiPageAudience(wikiDeps(), f.owner.id, f.org.id, "dupla", { roleIds: [], userIds: [ana.id, bia.id] });
    await setWikiFolderAudience(wikiDeps(), f.owner.id, f.org.id, "Fechada", { roleIds: [], userIds: [ana.id] }, null);
    const out = await move(await askedBy(f.owner.id), { pages: ["Dupla"], folder: "Fechada" });
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain('now limited to the audience of "Fechada"');
    const [row] = (await f.db.select().from(schema.wikiPages)).filter((r) => r.slug === "dupla");
    expect(row?.audienceUserIds).toEqual([ana.id]);
  });
});
