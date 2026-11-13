import { expect, test } from "bun:test";
import { splitCardRefs } from "../src/lib/card-refs";

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
