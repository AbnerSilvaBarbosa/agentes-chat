import { afterEach, expect, test } from "bun:test";
import { systemText } from "@agenteschat/providers";
import { drainOutbox, postPersonMessage } from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

test("the instructions say #number names a card", async () => {
  const prompts: string[] = [];
  f = await setup({
    reply: (req) => {
      prompts.push(systemText(req.system ?? ""));
      return { chunks: ["ok"] };
    },
  });
  await postPersonMessage({ db: f.db, pubsub: f.pubsub }, f.owner.id, f.org.id, f.general.id, { body: "@dev bom dia" });
  await drainOutbox(f.db, f.handlers);
  expect(prompts.length).toBeGreaterThan(0);
  for (const prompt of prompts) {
    expect(prompt).toContain("`#<number>` names a card in chat");
    expect(prompt).toContain("shows to people as a link to it");
    expect(prompt).toContain("use it when you name the card you work on");
    expect(prompt).toContain('Never write it after "PR" or "issue" for a GitHub number');
  }
});
