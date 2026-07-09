import { describe, it, expect, vi } from "vitest";
import { SiliconFlowProvider } from "@backend/providers/siliconflow";
import { AlibabaProvider } from "@backend/providers/alibaba";
import { FalAIProvider } from "@backend/providers/fal-ai";
import { ProviderError } from "@backend/providers/base";

/**
 * 第二轮审计修复回归：provider 在调 .map/取嵌套字段前未守卫 API 响应，
 * malformed 响应（200 但缺 images/output/request_id）会崩 TypeError 而非清晰错误。
 * 现统一抛 ProviderError——这里 mock request 返回空响应，断言抛的是 ProviderError 而非裸 TypeError。
 */
const cfg = (name: string) => ({ name, apiKey: "test", baseUrl: "https://example.com" });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockRequest = (p: any, value: unknown) => vi.spyOn(p, "request").mockResolvedValue(value);

describe("provider 响应守卫（审计修复，malformed 响应抛 ProviderError 而非崩溃）", () => {
  it("SiliconFlow generateImage：images 缺失 → ProviderError 而非 TypeError", async () => {
    const p = new SiliconFlowProvider(cfg("siliconflow"));
    mockRequest(p, {}); // 无 images
    await expect(p.generateImage({ modelId: "m", mode: "text-to-image", prompt: "x" })).rejects.toThrow(ProviderError);
  });

  it("Alibaba generateImage：output 缺失 → ProviderError 而非 TypeError", async () => {
    const p = new AlibabaProvider(cfg("alibaba"));
    mockRequest(p, {}); // 无 output.task_id
    await expect(p.generateImage({ modelId: "m", mode: "text-to-image", prompt: "x" })).rejects.toThrow(ProviderError);
  });

  it("FalAI generateImage：request_id 缺失 → ProviderError 而非生成 'm::undefined' 任务", async () => {
    const p = new FalAIProvider(cfg("fal"));
    mockRequest(p, {}); // 无 request_id
    await expect(p.generateImage({ modelId: "m", mode: "text-to-image", prompt: "x" })).rejects.toThrow(ProviderError);
  });
});
