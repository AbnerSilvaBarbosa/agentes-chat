import { afterEach, describe, expect, test } from "bun:test";
import { schema } from "@agenteschat/db";
import {
  createIssueProject,
  createIssueSpace,
  createIssueToolSource,
  grantScopes,
  insertMessage,
  openPoChat,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

/** A run context of the fixture's agent in `channelId`, triggered by a real message of the owner. */
async function runIn(fixture: Fixture, channelId: string) {
  const trigger = await insertMessage(fixture.db, {
    orgId: fixture.org.id,
    channelId,
    author: { type: "person", userId: fixture.owner.id },
    body: "Crie uma tarefa de login",
  });
  const [run] = await fixture.db
    .insert(schema.agentRuns)
    .values({
      orgId: fixture.org.id,
      agentId: fixture.agent.id,
      channelId,
      threadRootId: trigger.id,
      triggerMessageId: trigger.id,
      trigger: "mention",
      hop: 1,
      status: "running",
    })
    .returning();
  if (!run) throw new Error("no run");
  return {
    db: fixture.db,
    orgId: fixture.org.id,
    agentId: fixture.agent.id,
    runId: run.id,
    channelId,
    threadRootId: trigger.id,
    triggerMessageId: trigger.id,
  };
}

async function workspace(fixture: Fixture) {
  const deps = { db: fixture.db, pubsub: fixture.pubsub };
  await fixture.db
    .insert(schema.organizationSettings)
    .values({ orgId: fixture.org.id, poAgentId: fixture.agent.id })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { poAgentId: fixture.agent.id } });
  await grantScopes(
    fixture.db,
    fixture.org.id,
    fixture.agent.id,
    ["issues:read", "issues:write"].map((scope) => ({ connectionId: null, scope })),
  );
  const company = await createIssueSpace(deps, fixture.owner.id, fixture.org.id, { name: "Acme" });
  await createIssueProject(deps, fixture.owner.id, fixture.org.id, { name: "Entregas", spaceId: company.id });
  const chat = await openPoChat(fixture.db, fixture.owner.id, fixture.org.id, company.id);
  return { company, chat };
}

describe("a PO chat keeps to its company", () => {
  test("create_issue is refused in a PO chat and propose_card is listed", async () => {
    f = await setup();
    const { chat } = await workspace(f);
    const source = createIssueToolSource(f.artifactDeps);

    // In a PO chat: propose_card, never create_issue.
    const inPo = await runIn(f, chat.channelId);
    const poTools = await source.tools(inPo);
    expect(poTools.map((t) => t.name)).toContain("propose_card");
    expect(poTools.map((t) => t.name)).not.toContain("create_issue");

    // Anywhere else the listing is what it was: create_issue, no propose_card.
    const inGeneral = await runIn(f, f.general.id);
    const plainTools = await source.tools(inGeneral);
    expect(plainTools.map((t) => t.name)).toContain("create_issue");
    expect(plainTools.map((t) => t.name)).not.toContain("propose_card");
    // Nothing else differs: the two listings are the same but for the swapped tool.
    const names = (list: { name: string }[]) => list.map((t) => t.name).sort();
    expect(names(plainTools)).toEqual([...names(poTools).filter((n) => n !== "propose_card"), "create_issue"].sort());

    // A model that still calls the tool it remembers is refused by the code, and nothing is created.
    const create = (await source.tools(inGeneral)).find((t) => t.name === "create_issue");
    const refused = await create?.execute({ title: "Tela de login", project: "Entregas" }, inPo);
    expect(refused?.isError).toBe(true);
    expect(refused?.content).toContain("use propose_card");
    expect(await f.db.select().from(schema.issues)).toHaveLength(0);
    expect(await f.db.select().from(schema.poCardProposals)).toHaveLength(0);
  });
});
