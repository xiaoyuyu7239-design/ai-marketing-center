import { describe, it, expect } from "vitest";
import { buildLocalTagPack, normalizeCityName, parseCustomTags } from "@backend/core/publish/local-tags";

describe("normalizeCityName（城市名归一化）", () => {
  it("去掉省级前缀和市后缀", () => {
    expect(normalizeCityName("浙江省杭州市")).toBe("杭州");
    expect(normalizeCityName("杭州市")).toBe("杭州");
    expect(normalizeCityName("杭州")).toBe("杭州");
  });

  it("自治区全称也能剥离", () => {
    expect(normalizeCityName("广西壮族自治区南宁市")).toBe("南宁");
  });

  it("两字带'市'的直辖市保留语义（上海市→上海）", () => {
    expect(normalizeCityName("上海市")).toBe("上海");
  });

  it("空值与空白返回空串", () => {
    expect(normalizeCityName("")).toBe("");
    expect(normalizeCityName("  ")).toBe("");
    expect(normalizeCityName(null)).toBe("");
    expect(normalizeCityName(undefined)).toBe("");
  });
});

describe("parseCustomTags（绑定标签解析）", () => {
  it("接受 #、逗号、顿号、空格混排，统一去 # 去重", () => {
    expect(parseCustomTags("#杭州美甲, 滨江探店、#杭州美甲 周末去哪")).toEqual([
      "杭州美甲",
      "滨江探店",
      "周末去哪",
    ]);
  });

  it("最多 10 个", () => {
    const raw = Array.from({ length: 15 }, (_, i) => `标签${i}`).join(",");
    expect(parseCustomTags(raw)).toHaveLength(10);
  });

  it("空值返回空数组", () => {
    expect(parseCustomTags("")).toEqual([]);
    expect(parseCustomTags(null)).toEqual([]);
  });
});

describe("buildLocalTagPack（同城标签梯度 + POI 清单）", () => {
  const store = {
    city: "杭州市",
    landmark: "武林商圈",
    shopName: "老王牛肉面",
    storeAddress: "文三路 259 号",
    customTags: "杭州吃货,武林夜市",
  };

  it("标签按槽位梯度排列：门店 → 商圈 → 城市×品类 → 城市大盘 → 内容型 → 绑定标签", () => {
    const pack = buildLocalTagPack(store, { category: "food" });
    expect(pack.hashtags[0]).toBe("#老王牛肉面");
    expect(pack.hashtags[1]).toBe("#武林商圈");
    expect(pack.hashtags[2]).toBe("#杭州美食");
    expect(pack.hashtags[3]).toBe("#杭州探店");
    // 绑定标签必须在梯度里
    expect(pack.hashtags).toContain("#杭州吃货");
  });

  it("行政区型地标拼品类词（#西湖区美食 式实证用法）", () => {
    const pack = buildLocalTagPack({ ...store, landmark: "西湖区" }, { category: "food" });
    expect(pack.hashtags).toContain("#西湖区美食");
  });

  it("宁精勿多：最多 8 个、全部带 #、无重复", () => {
    const pack = buildLocalTagPack(store, { category: "food" });
    expect(pack.hashtags.length).toBeLessThanOrEqual(8);
    expect(pack.hashtags.every((h) => h.startsWith("#"))).toBe(true);
    expect(new Set(pack.hashtags).size).toBe(pack.hashtags.length);
  });

  it("非餐饮品类：城市大盘用 同城，城市×品类按品类词", () => {
    const pack = buildLocalTagPack(store, { category: "beauty" });
    expect(pack.hashtags).toContain("#杭州美容美发");
    expect(pack.hashtags).toContain("#杭州同城");
  });

  it("POI 清单是五件套：门店级 POI / 团购 / 评论区置顶 / 首小时回评 / 定位真实", () => {
    const pack = buildLocalTagPack(store, { category: "food" });
    expect(pack.poiChecklist).toHaveLength(5);
    const joined = pack.poiChecklist.join("\n");
    expect(joined).toContain("老王牛肉面 · 文三路 259 号");
    expect(joined).toContain("团购");
    expect(joined).toContain("置顶");
    expect(joined).toContain("1 小时");
    expect(joined).toContain("定位必须真实");
  });

  it("锚点说明含城市与商圈；没填城市时引导去建档", () => {
    expect(buildLocalTagPack(store, { category: "food" }).anchorNote).toContain("杭州 · 武林商圈");
    const noCity = buildLocalTagPack({ shopName: "小店" }, {});
    expect(noCity.anchorNote).toContain("还没填城市");
  });

  it("没填城市时不产出城市标签，但内容型与绑定标签仍在", () => {
    const pack = buildLocalTagPack({ shopName: "小店", customTags: "开业福利" }, { category: "food" });
    expect(pack.hashtags.join("")).not.toContain("undefined");
    expect(pack.hashtags).toContain("#探店");
    expect(pack.hashtags).toContain("#开业福利");
  });

  it("标签用法提示告知抖音取前 5 个", () => {
    expect(buildLocalTagPack(store, {}).tagHint).toContain("5 个");
  });
});
