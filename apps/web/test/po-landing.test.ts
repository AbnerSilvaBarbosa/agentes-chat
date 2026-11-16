import { afterEach, describe, expect, test } from "bun:test";
import { setupDom } from "@agenteschat/ui/testing/dom";

setupDom();

const companies = [{ id: "livora" }, { id: "atlas" }, { id: "nova" }];

import { poLanding, rememberedPoCompany, rememberPoCompany } from "@/lib/po-landing";

const landing = (user: string, org: string) => poLanding(companies, rememberedPoCompany(user, org));

afterEach(() => localStorage.clear());

describe("the company the PO view opens on", () => {
  test("gives the remembered company while it is still live", () => {
    expect(poLanding(companies, "atlas")).toBe("atlas");
    rememberPoCompany("u1", "o1", "nova");
    expect(landing("u1", "o1")).toBe("nova");
  });

  test("gives the first company when none is remembered or the remembered one is gone", () => {
    expect(poLanding(companies, null)).toBe("livora");
    expect(poLanding(companies, "archived")).toBe("livora");
    expect(landing("u1", "o1")).toBe("livora");
    rememberPoCompany("u1", "o1", "archived");
    expect(landing("u1", "o1")).toBe("livora");
  });

  test("gives nothing when the workspace has no company", () => {
    expect(poLanding([], "atlas")).toBeNull();
    expect(poLanding([], rememberedPoCompany("u1", "o1"))).toBeNull();
    expect(rememberedPoCompany("u1", "o1")).toBeNull();
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
      expect(landing("u1", "o1")).toBe("livora");
    } finally {
      proto.getItem = getItem;
      proto.setItem = setItem;
    }
  });
});
