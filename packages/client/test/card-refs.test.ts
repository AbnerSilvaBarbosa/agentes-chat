import { expect, test } from "bun:test";
import { pickOptions, splitCardRefs } from "../src/lib/card-refs";

const channel = (name: string, isMember = true) => ({ name, isMember });
const card = (number: number, title: string) => ({ number, title });

test("finds only a number that stands alone", () => {
  expect(splitCardRefs("veja #128.")).toEqual([{ text: "veja " }, { text: "#128", number: 128 }, { text: "." }]);
  expect(splitCardRefs("(#7) e #9")).toEqual([
    { text: "(" },
    { text: "#7", number: 7 },
    { text: ") e " },
    { text: "#9", number: 9 },
  ]);
  expect(splitCardRefs("a#12 &#39; ##12 #12-plano #12a #007 #0")).toEqual([
    { text: "a#12 &#39; ##12 #12-plano #12a #007 #0" },
  ]);
  expect(splitCardRefs("#128 e #128").filter((p) => p.number === 128)).toHaveLength(2);
});

test("leaves a number after PR as text", () => {
  for (const words of ["PR #123", "pr #123", "pull request #123", "Pull Request #123", "issue #123", "Issue #123"]) {
    expect(splitCardRefs(`veja ${words}, e #5`).map((p) => p.number)).toEqual([undefined, 5, undefined]);
  }
  expect(splitCardRefs("PR #123")).toEqual([{ text: "PR #123" }]);
  // Other words in between, or the word inside another word, do not count.
  expect(splitCardRefs("a PR com #123").some((p) => p.number === 123)).toBe(true);
  expect(splitCardRefs("sprint #123").some((p) => p.number === 123)).toBe(true);
});

test("lists channels first then cards, eight at most", () => {
  const channels = [channel("eng"), channel("general"), channel("ops")];
  const cards = Array.from({ length: 12 }, (_, i) => card(i + 1, `Tarefa ${i + 1}`));
  const picked = pickOptions("", channels, cards);
  expect(picked.channels.map((c) => c.name)).toEqual(["eng", "general", "ops"]);
  expect(picked.cards.map((c) => c.number)).toEqual([1, 2, 3, 4, 5]);
  expect(picked.channels.length + picked.cards.length).toBe(8);
  // Many channels still leave room for a card.
  const many = Array.from({ length: 20 }, (_, i) => channel(`canal${i}`));
  const crowded = pickOptions("", many, cards);
  expect(crowded.channels).toHaveLength(6);
  expect(crowded.cards.map((c) => c.number)).toEqual([1, 2]);
});

test("digits list the cards whose number starts with them", () => {
  const cards = [card(120, "B"), card(5, "C"), card(12, "A"), card(212, "D"), card(121, "E")];
  expect(pickOptions("12", [channel("eng")], cards).cards.map((c) => c.number)).toEqual([12, 120, 121]);
  expect(pickOptions("12", [channel("eng")], cards).channels).toEqual([]);
  expect(pickOptions("9", [], cards).cards).toEqual([]);
});

test("letters list channels by name and cards by title", () => {
  const channels = [channel("deploys"), channel("eng")];
  const cards = [card(1, "Login quebra no deploy"), card(2, "Deploy das 9h"), card(3, "Revisar textos")];
  const picked = pickOptions("deploy", channels, cards);
  expect(picked.channels.map((c) => c.name)).toEqual(["deploys"]);
  expect(picked.cards.map((c) => c.number)).toEqual([2, 1]);
  expect(pickOptions("zzz", channels, cards)).toEqual({ channels: [], cards: [] });
});
