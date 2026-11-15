import { expect, test } from "bun:test";
import { describeAction } from "../src";

test("describeAction words a category an agent made, in English, for its own history", () => {
  expect(
    describeAction({
      kind: "channel_category.created",
      target: { type: "channel_category", id: "c1", title: "Livora" },
      params: { name: "Livora", channels: [] },
    }),
  ).toBe('created the category "Livora"');
});
