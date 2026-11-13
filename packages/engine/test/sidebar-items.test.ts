import { afterEach, describe, expect, test } from "bun:test";
import {
  mySidebarItems,
  PERSONAL_SIDEBAR_ITEMS,
  SIDEBAR_ITEMS,
  setMySidebarItem,
  sidebarItemsOf,
  ValidationError,
} from "../src";
import { type Fixture, setup } from "./fixtures";

let f: Fixture;
afterEach(async () => {
  const current = f;
  f = undefined as unknown as Fixture;
  await current?.close();
});

describe("the sidebar's tools: Minhas tarefas (my-tasks)", () => {
  test("a team's tool list lists myTasks right after issues", () => {
    const list = [...SIDEBAR_ITEMS];
    expect(list[list.indexOf("issues") + 1]).toBe("myTasks");
    expect(list.filter((x) => x === "myTasks")).toHaveLength(1);
  });

  test("the personal list lists myTasks right after issues too", () => {
    const list = [...PERSONAL_SIDEBAR_ITEMS];
    expect(list[list.indexOf("issues") + 1]).toBe("myTasks");
    expect([...list].sort()).toEqual([...SIDEBAR_ITEMS].sort());
  });

  test("a saved choice for myTasks is accepted, one for an unknown tool is still refused", async () => {
    f = await setup();
    expect(sidebarItemsOf({ myTasks: "more", nope: "more" })).toEqual({ myTasks: "more" });
    expect(await setMySidebarItem(f.db, f.org.id, f.owner.id, "myTasks", "more")).toEqual({ myTasks: "more" });
    expect(await mySidebarItems(f.db, f.org.id, f.owner.id)).toEqual({ myTasks: "more" });
    // `auto` is for the tools with a count: myTasks has none.
    await expect(setMySidebarItem(f.db, f.org.id, f.owner.id, "myTasks", "auto")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(setMySidebarItem(f.db, f.org.id, f.owner.id, "nope" as never, "more")).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
