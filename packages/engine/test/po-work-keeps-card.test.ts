import { afterEach, describe, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import { createIssue, createIssueProject, createIssueSpace, getIssue, setCriterion } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  await f?.close();
});

describe("the PO's work on a card", () => {
  async function card(agentIsPo: boolean) {
    f = await setup();
    const deps = { db: f.db, pubsub: f.pubsub };
    if (agentIsPo)
      await f.db
        .insert(schema.organizationSettings)
        .values({ orgId: f.org.id, poAgentId: f.agent.id })
        .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { poAgentId: f.agent.id } });
    const company = await createIssueSpace(deps, f.owner.id, f.org.id, { name: "Acme" });
    const board = await createIssueProject(deps, f.owner.id, f.org.id, { name: "Entregas", spaceId: company.id });
    const made = await createIssueWithCriterion(deps, board.id);
    return { deps, made };
  }
  async function createIssueWithCriterion(deps: { db: Fixture["db"]; pubsub: Fixture["pubsub"] }, projectId: string) {
    return createIssue(deps, { type: "person", userId: f.owner.id }, f.org.id, {
      title: "Especificar isto",
      projectId,
      assignee: { type: "agent", id: f.agent.id },
      criteria: ["um critério"],
    });
  }

  test("a card the PO works on keeps its status", async () => {
    const { deps, made } = await card(true);
    const crit = made.criteria[0];
    if (!crit) throw new Error("no criterion");
    await setCriterion(
      deps,
      { type: "agent", agentId: f.agent.id, channelId: f.general.id, runId: crypto.randomUUID() },
      f.org.id,
      made.id,
      crit.id,
      true,
    );
    const after = await getIssue(f.db, { type: "person", userId: f.owner.id }, f.org.id, { id: made.id });
    expect(after.status).toBe("todo");
    const [row] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, made.id));
    expect(row?.status).toBe("todo");
  });

  test("another agent's work on a card still starts it", async () => {
    const { deps, made } = await card(false);
    const crit = made.criteria[0];
    if (!crit) throw new Error("no criterion");
    await setCriterion(
      deps,
      { type: "agent", agentId: f.agent.id, channelId: f.general.id, runId: crypto.randomUUID() },
      f.org.id,
      made.id,
      crit.id,
      true,
    );
    const [row] = await f.db.select().from(schema.issues).where(eq(schema.issues.id, made.id));
    expect(row?.status).toBe("in_progress");
  });
});
