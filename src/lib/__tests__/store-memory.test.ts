import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@backend/db", () => ({ getDb: vi.fn() }));

import {
  buildStoreMemoryHint,
  defaultStoreMemory,
  learnFromScript,
  normalizeStoreMemory,
} from "@backend/core/memory/store-memory";
import type { Shot } from "@backend/db/schema";

describe("store memory", () => {
  it("normalizes messy persisted values", () => {
    const memory = normalizeStoreMemory({
      storeName: "  老王日用百货  ",
      mainCategories: ["home", "", "home"],
      platforms: ["kuaishou"],
      toneTags: ["接地气"],
      preferredStyles: ["pain_point"],
      ctaPhrases: ["  点击下方购买  "],
      bannedPhrases: ["第一"],
    });

    expect(memory.storeName).toBe("老王日用百货");
    expect(memory.mainCategories).toEqual(["home"]);
    expect(memory.ctaPhrases).toEqual(["点击下方购买"]);
  });

  it("learns style/category/cta from a selected script", () => {
    const shots = [
      { shotId: 1, type: "hook", duration: 3, voiceover: "家里纸巾别乱买" },
      { shotId: 2, type: "cta", duration: 3, voiceover: "点下方小黄车，今天囤更划算" },
    ] as Shot[];
    const memory = learnFromScript(defaultStoreMemory(), {
      productName: "云柔抽纸",
      category: "home",
      styleType: "pain_point",
      title: "纸巾别乱买",
      shots,
    });

    expect(memory.mainCategories).toContain("home");
    expect(memory.preferredStyles).toContain("pain_point");
    expect(memory.ctaPhrases[0]).toBe("点下方小黄车，今天囤更划算");
    expect(memory.likedExamples[0]).toMatchObject({ productName: "云柔抽纸", styleType: "pain_point" });
  });

  it("builds a compact prompt hint only when memory has content", () => {
    expect(buildStoreMemoryHint(defaultStoreMemory())).toBe("");
    const memory = {
      ...defaultStoreMemory(),
      storeName: "老王日用百货",
      mainCategories: ["home"],
      platforms: ["kuaishou"],
      toneTags: ["接地气", "实惠"],
      preferredStyles: ["comparison"],
    };

    const hint = buildStoreMemoryHint(memory, { productName: "加厚抽纸", category: "home" });
    expect(hint).toContain("店铺习惯记忆");
    expect(hint).toContain("老王日用百货");
    expect(hint).toContain("加厚抽纸");
    expect(hint).toContain("comparison");
  });
});
