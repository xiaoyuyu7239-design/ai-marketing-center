import { describe, it, expect } from "vitest";
import {
  buildLocalStoreGuide,
  buildUserPrompt,
  stylePrompts,
  styleNameMap,
  LOCAL_TREND_HOOKS,
  type ScriptGenerationInput,
} from "@backend/script-engine/prompts";
import { buildPublishPrompt } from "@backend/core/publish/publish-pack";

const baseInput: ScriptGenerationInput = {
  productName: "招牌牛肉面",
  category: "food",
  styleType: "local",
  targetDuration: 20,
};

const store = { city: "杭州", landmark: "武林商圈", storeName: "老王牛肉面", storeAddress: "文三路 259 号" };

describe("buildLocalStoreGuide（同城内容指令）", () => {
  it("包含同城三信号：文案地域词 / 画面地域元素 / 本地互动引导", () => {
    const guide = buildLocalStoreGuide(store, "food");
    expect(guide).toContain("文案地域词");
    expect(guide).toContain("画面地域元素");
    expect(guide).toContain("本地互动引导");
  });

  it("门店信息注入到位（城市/商圈/门店/地址）", () => {
    const guide = buildLocalStoreGuide(store, "food");
    expect(guide).toContain("杭州");
    expect(guide).toContain("武林商圈");
    expect(guide).toContain("老王牛肉面");
    expect(guide).toContain("文三路 259 号");
  });

  it("到店 CTA 铁律：禁止电商挂车话术", () => {
    const guide = buildLocalStoreGuide(store, "food");
    expect(guide).toContain("严禁出现\"点击小黄车\"");
    expect(guide).toContain("到店动作");
  });

  it("注入品类对应的本地热点（餐饮=饭点前/深夜食堂等）", () => {
    const guide = buildLocalStoreGuide(store, "food");
    for (const hook of LOCAL_TREND_HOOKS.food) expect(guide).toContain(hook);
    expect(guide).toContain(LOCAL_TREND_HOOKS.common[0]);
  });

  it("没填门店信息也能出通用同城指令（不出现 undefined）", () => {
    const guide = buildLocalStoreGuide({}, "beauty");
    expect(guide).not.toContain("undefined");
    expect(guide).toContain("同城内容策略");
  });
});

describe("buildUserPrompt 的同城注入", () => {
  it("带 localStore 时注入同城策略、替代电商流量热点", () => {
    const prompt = buildUserPrompt({ ...baseInput, localStore: store });
    expect(prompt).toContain("同城内容策略");
    expect(prompt).not.toContain("流量热点契合");
  });

  it("不带 localStore 时保持电商链路原样", () => {
    const prompt = buildUserPrompt({ ...baseInput, styleType: "scene" });
    expect(prompt).toContain("流量热点契合");
    expect(prompt).not.toContain("同城内容策略");
  });

  it("同城到店风格结构存在且有中文名", () => {
    expect(stylePrompts.local).toContain("同城到店");
    expect(styleNameMap.local).toBe("同城到店");
  });
});

describe("buildPublishPrompt 的同城分支", () => {
  it("本地门店：要求城市锚点标题、同城标签梯度、到店 CTA、必带绑定标签", () => {
    const prompt = buildPublishPrompt(
      {
        productName: "招牌牛肉面",
        category: "food",
        platform: "douyin",
        localStore: { city: "杭州市", landmark: "武林商圈", shopName: "老王牛肉面", customTags: "杭州吃货" },
      },
      "zh"
    );
    expect(prompt).toContain("同城到店客流");
    expect(prompt).toContain("\"杭州\"");
    expect(prompt).toContain("#杭州吃货");
    expect(prompt).toContain("严禁\"点击小黄车\"");
    expect(prompt).toContain("话题最多 5 个");
  });

  it("小红书平台提示：标题写成搜索题", () => {
    const prompt = buildPublishPrompt(
      { productName: "美甲款式", category: "beauty", platform: "xiaohongshu", localStore: { city: "杭州" } },
      "zh"
    );
    expect(prompt).toContain("搜索题");
  });

  it("无 localStore 时保持电商文案 prompt 原样", () => {
    const prompt = buildPublishPrompt({ productName: "精华液", category: "beauty" }, "zh");
    expect(prompt).toContain("电商带货短视频运营");
    expect(prompt).not.toContain("同城");
  });
});
