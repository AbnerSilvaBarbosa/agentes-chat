import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import {
  actionsFor,
  createIssue,
  createIssueToolSource,
  getIssue,
  insertMessage,
  linkRunActions,
  replyThreadOf,
  type ToolContext,
  type ToolDefinition,
  undoAgentAction,
  updateIssue,
} from "../src";
import { addMember, type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

const person = (userId: string) => ({ type: "person" as const, userId });
const actor = (type: "person" | "agent", id: string) => ({ type, id });
const deps = (fx: Fixture) => ({ db: fx.db, pubsub: fx.pubsub });

/**
 * A run's tool context whose trigger is a real message by the owner (tools act for them): in the
 * channel (the run answers there), or `inThread` (a reply under another message).
 */
async function runContext(fx: Fixture, body = "please organize this", inThread = false): Promise<ToolContext> {
  const root = inThread
    ? await insertMessage(fx.db, {
        orgId: fx.org.id,
        channelId: fx.general.id,
        author: { type: "person", userId: fx.owner.id },
        body: "deploy notes",
      })
    : null;
  const trigger = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    threadId: root?.id ?? null,
    author: { type: "person", userId: fx.owner.id },
    body,
  });
  // A real run on the person's message: who asked is read from it (ADR 0053's authority gate).
  const [run] = await fx.db
    .insert(schema.agentRuns)
    .values({
      orgId: fx.org.id,
      agentId: fx.agent.id,
      channelId: fx.general.id,
      threadRootId: root?.id ?? trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: fx.db,
    orgId: fx.org.id,
    agentId: fx.agent.id,
    runId: run.id,
    channelId: fx.general.id,
    threadRootId: root?.id ?? trigger.id,
    triggerMessageId: trigger.id,
  };
}

/** The run's reply: links the receipts to it, as the executor does when it posts (where the run answers). */
async function reply(fx: Fixture, ctx: ToolContext) {
  const m = await insertMessage(fx.db, {
    orgId: fx.org.id,
    channelId: fx.general.id,
    threadId: replyThreadOf(ctx),
    author: { type: "agent", agentId: fx.agent.id, runId: ctx.runId, hop: 0 },
    body: "Done.",
  });
  await linkRunActions(fx.db, fx.org.id, ctx.runId, m.id);
  return m;
}

async function toolsOf(sources: { tools(ctx: ToolContext): Promise<ToolDefinition[]> }[], ctx: ToolContext) {
  const all = (await Promise.all(sources.map((s) => s.tools(ctx)))).flat();
  return async (name: string, input: Record<string, unknown>) => {
    const tool = all.find((t) => t.name === name);
    if (!tool) throw new Error(`no ${name}`);
    const out = await tool.execute(input, ctx);
    if (out.isError) throw new Error(out.content);
    return out;
  };
}

describe("undo an agent's change of people", () => {
  test("undoing an agent's change of people restores the people", async () => {
    f = await setup();
    const bia = await addMember(f.db, f.org.id, "member", "Bia");
    const caio = await addMember(f.db, f.org.id, "member", "Caio");
    const ctx = await runContext(f);
    const call = await toolsOf([createIssueToolSource(f.artifactDeps)], ctx);
    const card = await createIssue(deps(f), person(f.owner.id), f.org.id, {
      title: "com gente",
      assignees: [actor("person", f.owner.id), actor("person", bia.id)],
    });
    // The agent takes the card: it becomes the principal and the two people stay, in order.
    await call("update_issue", { issue: "#1", assignee: "me" });
    const m = await reply(f, ctx);
    const [action] = (await actionsFor(f.db, f.org.id, [m.id])).get(m.id) ?? [];
    if (!action) throw new Error("no action");
    expect(action.params.fields).toEqual(["status", "assignee", "alsoWith"]);
    const [row] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.id, action.id));
    expect(row?.before).toMatchObject({
      assignee: actor("person", f.owner.id),
      alsoWith: [actor("person", bia.id)],
    });
    expect(row?.after).toMatchObject({
      assignee: actor("agent", f.agent.id),
      alsoWith: [actor("person", f.owner.id), actor("person", bia.id)],
    });

    // Someone edited the people after the agent: undoing would overwrite their work.
    await updateIssue(deps(f), person(f.owner.id), f.org.id, card.id, { addAssignees: [actor("person", caio.id)] });
    await expect(undoAgentAction(deps(f), f.owner.id, f.org.id, action.id)).rejects.toMatchObject({
      code: "action.changed_since",
    });
    const [kept] = await f.db.select().from(schema.agentActions).where(eq(schema.agentActions.id, action.id));
    expect(kept?.undoneAt).toBeNull();

    // As the agent left it, undo puts the principal and the whole list back in order.
    await updateIssue(deps(f), person(f.owner.id), f.org.id, card.id, { removeAssignees: [actor("person", caio.id)] });
    await undoAgentAction(deps(f), f.owner.id, f.org.id, action.id);
    const back = await getIssue(f.db, person(f.owner.id), f.org.id, { id: card.id });
    expect(back.assignee).toEqual(actor("person", f.owner.id));
    expect(back.alsoWith).toEqual([actor("person", bia.id)]);
  });
});
