import { describe, expect, test } from "bun:test";
import type { SidebarItem } from "../src/api/types";
import {
  inSidebarList,
  moveShownTool,
  PERSONAL_SIDEBAR_ITEMS,
  placeTool,
  SIDEBAR_ITEMS,
  sidebarItemOrder,
  sidebarPlace,
  withSidebarPlace,
} from "../src/lib/sidebar-items";

const after = (list: readonly SidebarItem[], item: SidebarItem) => list[list.indexOf(item) + 1];

describe("Minhas tarefas in the sidebar's tools", () => {
  test("the team's order lists myTasks right after issues, and it shows in the list by default", () => {
    expect(after(SIDEBAR_ITEMS, "issues")).toBe("myTasks");
    expect(after(sidebarItemOrder(false), "issues")).toBe("myTasks");
    expect(inSidebarList(sidebarPlace(undefined, "myTasks"), 0)).toBe(true);
  });

  test("personal order lists myTasks after issues, and it starts in More there", () => {
    expect(after(PERSONAL_SIDEBAR_ITEMS, "issues")).toBe("myTasks");
    expect(after(sidebarItemOrder(true), "issues")).toBe("myTasks");
    expect(sidebarPlace(undefined, "myTasks", true)).toBe("more");
  });

  test("a moved myTasks keeps its place", () => {
    const order = [...SIDEBAR_ITEMS];
    const moved = placeTool(order, "myTasks", "waiting", "before");
    expect(moved[0]).toBe("myTasks");
    expect(moved.filter((x) => x === "myTasks")).toHaveLength(1);
    const shown: SidebarItem[] = ["threads", "issues", "myTasks", "drive"];
    const up = moveShownTool(order, shown, "myTasks", -1);
    expect(up.filter((x) => shown.includes(x))).toEqual(["threads", "myTasks", "issues", "drive"]);
  });

  test("in More it is listed only there", () => {
    const items = withSidebarPlace(undefined, "myTasks", "more");
    expect(items).toEqual({ myTasks: "more" });
    const place = sidebarPlace(items, "myTasks");
    expect(inSidebarList(place, 0)).toBe(false);
    expect(inSidebarList(place, 5)).toBe(false);
    // Put back on its default it is dropped from the choices.
    expect(withSidebarPlace(items, "myTasks", "always")).toEqual({});
  });
});
