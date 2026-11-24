import { afterEach, expect, test } from "bun:test";
import { eq, schema } from "@agenteschat/db";
import type { ModelRequest } from "@agenteschat/providers";
import {
  createIssueProject,
  createIssueSpace,
  drainOutbox,
  listNotifications,
  listPoCompanies,
  openDm,
  openPoChat,
  runRoutineNow,
} from "../src";
import { type Fixture, setup } from "./fixtures";
import { channelRoutine, messagesIn, routineDeps } from "./routine-fixtures";

/** ADR 0229 addendum: the PO's routines speak in the company's PO chat; the plain DM is the fallback. */

let f: Fixture;
afterEach(async () => {
  await f?.close();
  f = undefined as unknown as Fixture;
});

const isRoutine = (req: ModelRequest) => (req.tools ?? []).some((t) => t.name === "hand_off");
const NEWS = "3 tarefas paradas em Especificar.";

const start = async () => {
  f = await setup({
    handOff: true,
    reply: (req) => {
      if (!isRoutine(req)) return { chunks: ["A conversation run should not have run."] };
      if (JSON.stringify(req.messages).includes("Posted.")) return { chunks: ["ok"] };
      return { chunks: [], toolUses: [{ name: "hand_off", input: { message: NEWS } }] };
    },
  });
};
const setPo = (agentId: string | null) =>
  f.db
    .insert(schema.organizationSettings)
    .values({ orgId: f.org.id, poAgentId: agentId })
    .onConflictDoUpdate({ target: schema.organizationSettings.orgId, set: { poAgentId: agentId } });
const company = (name: string) => createIssueSpace(routineDeps(f), f.owner.id, f.org.id, { name });
const fire = async (input: Parameters<typeof channelRoutine>[1]) => {
  const routine = await channelRoutine(f, { target: { type: "dm" }, ...input });
  await runRoutineNow(routineDeps(f), f.owner.id, f.org.id, routine.id);
  await drainOutbox(f.db, f.handlers);
  return routine;
};
const bodies = async (channelId: string) => (await messagesIn(f, channelId)).map((m) => m.body);
const plainDm = async () => (await openDm(f.db, f.owner.id, f.org.id, { agentId: f.agent.id })).id;
const poChat = async (spaceId: string) => (await openPoChat(f.db, f.owner.id, f.org.id, spaceId)).channelId;

test("a PO routine on a board's event reports in the PO chat of the board's company, waking nobody", async () => {
  await start();
  await setPo(f.agent.id);
  const acme = await company("Acme");
  await company("Beta");
  const board = await createIssueProject(routineDeps(f), f.owner.id, f.org.id, { name: "Entregas", spaceId: acme.id });
  await fire({
    trigger: { type: "event", event: "issue.moved", filter: { projectId: board.id } },
    name: "Parados",
  });
  const chat = await poChat(acme.id);
  expect(await bodies(chat)).toEqual([NEWS]);
  expect(await bodies(await plainDm())).toEqual([]);
  // Only the routine's own run: nothing started a conversational run of the PO in the chat.
  expect((await f.db.select().from(schema.agentRuns)).map((r) => r.background)).toEqual([true]);
  // The message is the routine's, and its notification opens the PO chat of that company.
  const notices = (await listNotifications({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id)).items.filter(
    (n) => n.kind === "dm",
  );
  expect(notices[0]?.source).toMatchObject({ dmId: chat, poSpaceId: acme.id });
});

test("a cron routine of the PO with one company reports in that company's PO chat", async () => {
  await start();
  await setPo(f.agent.id);
  const acme = await company("Acme");
  await fire({ trigger: { type: "schedule", phrase: "30 8 * * *" } });
  expect(await bodies(await poChat(acme.id))).toEqual([NEWS]);
  expect(await bodies(await plainDm())).toEqual([]);
});

test("an explicit spaceId wins over the single-company and event rules", async () => {
  await start();
  await setPo(f.agent.id);
  await company("Acme");
  const beta = await company("Beta");
  await fire({ target: { type: "dm", spaceId: beta.id }, trigger: { type: "schedule", phrase: "30 8 * * *" } });
  expect(await bodies(await poChat(beta.id))).toEqual([NEWS]);
});

test("two companies and no spaceId keep the plain DM", async () => {
  await start();
  await setPo(f.agent.id);
  const acme = await company("Acme");
  await company("Beta");
  await fire({ trigger: { type: "schedule", phrase: "30 8 * * *" } });
  expect(await bodies(await plainDm())).toEqual([NEWS]);
  expect(await bodies(await poChat(acme.id))).toEqual([]);
});

test("an agent that is not the PO keeps the plain DM, whatever companies there are", async () => {
  await start();
  await setPo(null);
  await company("Acme");
  await fire({ trigger: { type: "schedule", phrase: "30 8 * * *" } });
  expect(await bodies(await plainDm())).toEqual([NEWS]);
});

test("the PO chat holds the routine's message as unread for the person", async () => {
  await start();
  await setPo(f.agent.id);
  const acme = await company("Acme");
  await fire({ trigger: { type: "schedule", phrase: "30 8 * * *" } });
  const chat = await poChat(acme.id);
  const listed = async () => (await listPoCompanies(f.db, f.owner.id, f.org.id)).companies[0];
  expect(await listed()).toMatchObject({ channelId: chat, unread: 1 });
  await f.db.insert(schema.channelReads).values({ orgId: f.org.id, channelId: chat, userId: f.owner.id });
  expect((await listed())?.unread).toBe(0);
});
