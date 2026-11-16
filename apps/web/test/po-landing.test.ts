import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

import { landOnPoCompany, poLanding, rememberedPoCompany, rememberPoCompany } from "@/lib/po-landing";

const companies = [{ id: "livora" }, { id: "atlas" }, { id: "nova" }];

afterEach(() => localStorage.clear());

describe("the company the PO view opens on", () => {
  test("gives the remembered company while it is still live", () => {
    expect(poLanding(companies, "atlas")).toBe("atlas");
    rememberPoCompany("u1", "o1", "nova");
    expect(landOnPoCompany("u1", "o1", companies)).toBe("nova");
  });

  test("gives the first company when none is remembered or the remembered one is gone", () => {
    expect(poLanding(companies, null)).toBe("livora");
    expect(poLanding(companies, "archived")).toBe("livora");
    expect(landOnPoCompany("u1", "o1", companies)).toBe("livora");
    rememberPoCompany("u1", "o1", "archived");
    expect(landOnPoCompany("u1", "o1", companies)).toBe("livora");
  });

  test("gives nothing when the workspace has no company", () => {
    expect(poLanding([], "atlas")).toBeNull();
    expect(landOnPoCompany("u1", "o1", [])).toBeNull();
    expect(rememberedPoCompany("u1", "o1")).toBeNull();
  });

  test("replaces a remembered company that is gone", () => {
    rememberPoCompany("u1", "o1", "archived");
    landOnPoCompany("u1", "o1", companies);
    expect(rememberedPoCompany("u1", "o1")).toBe("livora");
  });

  test("keeps the choice apart for each person and workspace", () => {
    rememberPoCompany("u1", "o1", "atlas");
    rememberPoCompany("u2", "o1", "nova");
    rememberPoCompany("u1", "o2", "livora");
    expect(rememberedPoCompany("u1", "o1")).toBe("atlas");
    expect(rememberedPoCompany("u2", "o1")).toBe("nova");
    expect(rememberedPoCompany("u1", "o2")).toBe("livora");
  });

  test("a throwing storage opens the first company", () => {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const { getItem, setItem } = proto;
    proto.getItem = () => {
      throw new Error("blocked");
    };
    proto.setItem = () => {
      throw new Error("blocked");
    };
    try {
      expect(landOnPoCompany("u1", "o1", companies)).toBe("livora");
    } finally {
      proto.getItem = getItem;
      proto.setItem = setItem;
    }
  });
});
