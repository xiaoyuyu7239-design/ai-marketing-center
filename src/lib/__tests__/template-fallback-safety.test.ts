import { describe, expect, it } from "vitest";
import {
  buildTemplateProductScript,
  buildTemplateTopicScript,
} from "@backend/script-engine/generator";

const llmConfig = { baseUrl: "", apiKey: "", model: "template-fallback" };

describe("模板降级草稿安全性", () => {
  it.each(["beauty", "food", "home", "fashion", "tech"] as const)(
    "商品模板（%s）不臆造卖点，并让每个旁白都明确要求人工补充且不可直接发布",
    (category) => {
      const [script] = buildTemplateProductScript({
        productName: "测试商品",
        category,
        styleType: "pain_point",
        targetDuration: 20,
        llmConfig,
      });
      const serialized = JSON.stringify(script);

      expect(script.title).toContain("占位草稿");
      expect(script.shots).toHaveLength(5);
      expect(script.shots.at(-1)?.type).toBe("cta");
      expect(script.shots.every((shot) => shot.voiceover.includes("待人工补充") && shot.voiceover.includes("不可直接发布"))).toBe(true);
      expect(serialized).not.toMatch(/一点点就能推很开|随时都能吃|解决好几个麻烦|续航也过关|同价位里少见|花得值/);
    },
  );

  it("短时长商品骨架仍以 CTA 收尾，不会因截断留下可误解的半套模板", () => {
    const [script] = buildTemplateProductScript({
      productName: "测试商品",
      category: "food",
      styleType: "scene",
      targetDuration: 16,
      llmConfig,
    });

    expect(script.shots).toHaveLength(4);
    expect(script.shots.at(-1)?.type).toBe("cta");
  });

  it("主题模板不把用户输入直接扩写成事实，中文和英文旁白均带不可发布标记", () => {
    const [zh] = buildTemplateTopicScript({
      topic: "某种食物可以治病",
      targetDuration: 20,
      llmConfig,
    });
    const [en] = buildTemplateTopicScript({
      topic: "One food cures illness",
      targetDuration: 16,
      llmConfig,
    });

    expect(zh.title).toContain("占位草稿");
    expect(zh.shots).toHaveLength(5);
    expect(zh.shots.every((shot) => shot.voiceover.includes("不可直接发布"))).toBe(true);
    expect(JSON.stringify(zh)).not.toContain("其实比想象中更简单");
    expect(en.title).toContain("[DRAFT]");
    expect(en.shots).toHaveLength(4);
    expect(en.shots.at(-1)?.type).toBe("cta");
    expect(en.shots.every((shot) => shot.voiceover.includes("DO NOT PUBLISH"))).toBe(true);
  });
});
