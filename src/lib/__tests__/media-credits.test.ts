import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertMediaCreditsVerified,
  buildMediaCredits,
  licenseRequiresAttribution,
  requiredAttributionText,
} from "@backend/core/publish/media-credits";

describe("media credits", () => {
  it("CC0 / Public Domain 不强制署名，CC BY / BY-SA 强制署名", () => {
    expect(licenseRequiresAttribution("CC0 1.0")).toBe(false);
    expect(licenseRequiresAttribution("Public Domain")).toBe(false);
    expect(licenseRequiresAttribution("CC BY 4.0")).toBe(true);
    expect(licenseRequiresAttribution("CC BY-SA 3.0")).toBe(true);
    expect(licenseRequiresAttribution(undefined)).toBe(true);
  });

  it("只纳入实际 stock 素材和 BGM，并按来源去重", () => {
    const credits = buildMediaCredits({
      assets: [
        {
          type: "stock_footage",
          provider: "openverse",
          author: "Alice",
          license: "CC BY 4.0",
          sourceUrl: "https://media.example/a",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
          attributionText: "Alice / CC BY 4.0 / media.example/a",
        },
        {
          type: "stock_footage",
          author: "Alice duplicate",
          license: "CC BY 4.0",
          sourceUrl: "https://media.example/a",
        },
        { type: "user_upload", sourceUrl: "https://should-not-appear.example" },
      ],
      bgm: {
        provider: "wikimedia",
        author: "Bob",
        license: "Public Domain",
        sourceUrl: "https://media.example/music",
      },
    });

    expect(credits).toHaveLength(2);
    expect(credits[0]).toMatchObject({ mediaType: "visual", author: "Alice", requiresAttribution: true });
    expect(credits[1]).toMatchObject({ mediaType: "audio", author: "Bob", requiresAttribution: false });
    expect(requiredAttributionText(credits)).toBe("Alice / CC BY 4.0 / media.example/a");
  });

  it("许可未知不自动宣称可商用，并按保守策略要求署名", () => {
    const [credit] = buildMediaCredits({
      assets: [{ type: "stock_footage", author: "Unknown", sourceUrl: "https://media.example/unknown" }],
    });
    expect(credit).toMatchObject({ license: "许可未注明", licenseVerified: false, requiresAttribution: true });
    expect(() => assertMediaCreditsVerified([credit])).toThrow(/许可信息不完整/);
  });

  it("许可均可核验时允许进入合成", () => {
    const credits = buildMediaCredits({
      assets: [{ type: "stock_footage", provider: "openverse", license: "CC BY 4.0", sourceUrl: "https://media.example/a" }],
      bgm: { provider: "wikimedia", license: "Public Domain", sourceUrl: "https://media.example/b" },
    });
    expect(() => assertMediaCreditsVerified(credits)).not.toThrow();
  });

  it("本地自有 user_upload 不伪造第三方许可，也不进入 credits 门禁", () => {
    const credits = buildMediaCredits({
      assets: [{
        type: "user_upload",
        provider: "local",
        author: null,
        license: null,
        sourceUrl: null,
      }],
    });
    expect(credits).toEqual([]);
    expect(() => assertMediaCreditsVerified(credits)).not.toThrow();
  });

  it("compose worker 在真正 FFmpeg 前按实际使用素材执行许可门禁", () => {
    const source = readFileSync(
      join(process.cwd(), "后端", "core", "jobs", "compose-handler.ts"),
      "utf8",
    );
    const gateCall = source.lastIndexOf("assertEveryUsedStockHasCredit(");
    const composeCall = source.lastIndexOf("const outputPath = await composeVideo(config)");
    expect(gateCall).toBeGreaterThan(0);
    expect(composeCall).toBeGreaterThan(gateCall);
    expect(source).toContain("assertMediaCreditsVerified(credits)");
    expect(source).toContain("const credits = buildMediaCredits({ assets: usedCreditAssets");
  });
});
