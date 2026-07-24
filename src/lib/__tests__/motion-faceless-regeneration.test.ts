import { describe, expect, it, vi } from "vitest";
import {
  MOTION_FACELESS_RETRY_MARKER,
  buildFacelessRegenerationPrompt,
  hasFacelessRetryMarker,
  isCurrentProviderSafetyFailure,
  regenerateFacelessAsset,
  shouldFallbackAfterProviderSafetyRetry,
} from "@frontend/lib/motion-faceless-regeneration";
import type { AssetItem } from "@backend/core/stock/assets-view";

function asset(overrides: Partial<AssetItem> = {}): AssetItem {
  return {
    shotId: 3,
    type: "demo",
    duration: 2,
    description: "模特展示红色毛衣",
    prompt: "red sweater campaign",
    visualSource: "ai_generate",
    status: "done",
    thumbnailUrl: "/api/files/project-1/shot-3.jpg",
    assetFileUrl: "/api/files/project-1/shot-3.jpg",
    ...overrides,
  };
}

describe("无脸安全重生", () => {
  it("用持久标记跨刷新限制为最多一次，并生成强制头部外裁切提示", () => {
    expect(hasFacelessRetryMarker(asset())).toBe(false);
    expect(hasFacelessRetryMarker(asset({ assetPrompt: `${MOTION_FACELESS_RETRY_MARKER} saved` }))).toBe(true);
    const prompt = buildFacelessRegenerationPrompt(asset());
    expect(prompt).toContain(MOTION_FACELESS_RETRY_MARKER);
    expect(prompt).toContain("头部以下裁切");
    expect(prompt).toContain("Preserve the exact product identity");
    expect(prompt.length).toBeLessThanOrEqual(6_000);
  });

  it("先生成再追加保存新素材版本，不把短效供应商 URL 直接当完成结果", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ imageUrls: ["https://provider.test/temporary.png"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "asset-safe",
        filePath: "/api/files/project-1/asset-safe.png",
        type: "ai_generated",
        prompt: `${MOTION_FACELESS_RETRY_MARKER} persisted`,
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    const result = await regenerateFacelessAsset({
      projectId: "project-1",
      asset: asset(),
      imageOptions: { width: 1080, height: 1920 },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.filePath).toBe("/api/files/project-1/asset-safe.png");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const saveBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(saveBody.sourceUrl).toBe("https://provider.test/temporary.png");
    expect(saveBody.prompt).toContain(MOTION_FACELESS_RETRY_MARKER);
  });

  it("已有重生标记时在任何 API 调用前停止", async () => {
    const fetchImpl = vi.fn();
    await expect(regenerateFacelessAsset({
      projectId: "project-1",
      asset: asset({ assetPrompt: MOTION_FACELESS_RETRY_MARKER }),
      imageOptions: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow("已经执行过一次");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("供应商人脸拒绝只能恢复当前 asset/hash；无脸版再拒绝直接静态收口", () => {
    const currentAsset = asset({ assetId: "asset-current" });
    const safetyFailure = {
      assessment: { assetId: "asset-current", imageHash: "a".repeat(64) },
      latestJob: {
        status: "failed",
        sourceAssetId: "asset-current",
        sourceImageHash: "a".repeat(64),
        error: { suggestedAction: "regenerate_faceless" },
      },
    };
    expect(isCurrentProviderSafetyFailure(currentAsset, safetyFailure)).toBe(true);
    expect(shouldFallbackAfterProviderSafetyRetry(currentAsset, safetyFailure)).toBe(false);
    expect(isCurrentProviderSafetyFailure(currentAsset, {
      ...safetyFailure,
      latestJob: { ...safetyFailure.latestJob, sourceAssetId: "asset-old" },
    })).toBe(false);
    expect(shouldFallbackAfterProviderSafetyRetry(
      asset({
        assetId: "asset-current",
        assetPrompt: `${MOTION_FACELESS_RETRY_MARKER} persisted`,
      }),
      safetyFailure,
    )).toBe(true);
  });
});
