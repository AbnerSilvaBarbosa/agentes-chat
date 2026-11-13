import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  actionsFor,
  createWikiPage,
  getWikiPage,
  insertMessage,
  linkRunActions,
  redoAgentAction,
  replyThreadOf,
  type ToolContext,
  undoAgentAction,
  updateWikiPage,
  type WikiActor,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string): WikiActor => ({ type: "person", userId });
const wikiDeps = () => ({ db: f.db, pubsub: f.pubsub, search: f.context, artifacts: f.artifactDeps });
const deps = () => ({ db: f.db, pubsub: f.pubsub });

async function runContext(): Promise<ToolContext> {
  const trigger = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    author: { type: "person", userId: f.owner.id },
    body: "@dev guarda essas páginas na pasta Arquivo",
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
      hop: 1,
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

/** The agent moves the pages, replies, and the receipts that went on the reply come back. */
async function agentMoves(pages: string[], folder: string) {
  const ctx = await runContext();
  const tool = (await f.tools?.list(ctx))?.find((t) => t.name === "move_wiki_page");
  if (!tool) throw new Error("move_wiki_page is not offered");
  const out = await tool.execute({ pages, folder }, ctx);
  if (out.isError) throw new Error(out.content);
  const reply = await insertMessage(f.db, {
    orgId: f.org.id,
    channelId: f.general.id,
    threadId: replyThreadOf(ctx),
    author: { type: "agent", agentId: f.agent.id, runId: ctx.runId, hop: 0 },
    body: "Pronto.",
  });
  await linkRunActions(f.db, f.org.id, ctx.runId, reply.id);
  return (await actionsFor(f.db, f.org.id, [reply.id])).get(reply.id) ?? [];
}

const make = (title: string, folder?: string) =>
  createWikiPage(wikiDeps(), person(f.owner.id), f.org.id, { title, folder, body: "texto" });
const read = (ref: string) => getWikiPage(f.db, person(f.owner.id), f.org.id, ref);

describe("an agent's wiki move can be undone", () => {
  test("each moved page has its own receipt", async () => {
    f = await setup({ wikiTools: true });
    await make("Um", "Velha");
    await make("Dois");
    const actions = await agentMoves(["Um", "Dois"], "Arquivo");
    expect(actions.map((a) => a.kind)).toEqual(["wiki.page_moved", "wiki.page_moved"]);
    expect(actions.map((a) => a.target.title)).toEqual(["Um", "Dois"]);
    expect(actions[0]?.params).toMatchObject({ slug: "um", from: "Velha", to: "Arquivo" });
    const stored = await f.db.select().from(schema.agentActions);
    expect(stored.find((r) => r.targetId === actions[0]?.target.id)?.before).toMatchObject({ folder: "Velha" });
  });

  test("undo puts the page back in its folder", async () => {
    f = await setup({ wikiTools: true });
    await make("Um", "Velha");
    await make("Dois");
    const [first, second] = await agentMoves(["Um", "Dois"], "Arquivo");
    await undoAgentAction(deps(), f.owner.id, f.org.id, first?.id ?? "");
    const back = await read("um");
    expect(back).toMatchObject({ folder: "Velha", slug: "um" });
    // Only that page: the other keeps its move, and its own Undo goes to the top level.
    expect((await read("dois")).folder).toBe("Arquivo");
    await undoAgentAction(deps(), f.owner.id, f.org.id, second?.id ?? "");
    expect((await read("dois")).folder).toBe("");
    await redoAgentAction(deps(), f.owner.id, f.org.id, second?.id ?? "");
    expect((await read("dois")).folder).toBe("Arquivo");
  });

  test("undo is refused for a page changed after the move", async () => {
    f = await setup({ wikiTools: true });
    await make("Um", "Velha");
    const [action] = await agentMoves(["Um"], "Arquivo");
    const page = await read("um");
    await updateWikiPage(wikiDeps(), person(f.owner.id), f.org.id, "um", {
      baseVersion: page.version,
      body: "texto novo",
    });
    await expect(undoAgentAction(deps(), f.owner.id, f.org.id, action?.id ?? "")).rejects.toMatchObject({
      code: "action.changed_since",
    });
    expect((await read("um")).folder).toBe("Arquivo");
  });
});
