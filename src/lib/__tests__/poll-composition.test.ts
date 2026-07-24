import { afterEach, describe, expect, it, vi } from "vitest";
import { pollComposition } from "@backend/shared/poll-composition";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("pollComposition", () => {
  it("首次立即查询且始终带精确 compositionId，串行轮询到 done", async () => {
    vi.useFakeTimers({ now: new Date("2026-07-16T00:00:00Z") });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ composition: { status: "pending" } }))
      .mockResolvedValueOnce(
        jsonResponse({ composition: { status: "done", url: "/api/output/p/final_c.mp4" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = pollComposition("project / 1", "composition / 1", {
      intervalMs: 250,
      timeoutMs: 2_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/project/project%20%2F%201/compose?compositionId=composition%20%2F%201",
    );
    await vi.advanceTimersByTimeAsync(250);
    await expect(result).resolves.toBe("/api/output/p/final_c.mp4");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("持久 failed 原因与 404 都是立即终态，不会继续重试", async () => {
    const failedFetch = vi.fn(async () =>
      jsonResponse({ composition: { status: "failed", errorMessage: "许可未核验" } }),
    );
    vi.stubGlobal("fetch", failedFetch);
    await expect(pollComposition("p", "c")).rejects.toThrow("许可未核验");
    expect(failedFetch).toHaveBeenCalledTimes(1);

    const missingFetch = vi.fn(async () => jsonResponse({ error: "合成任务不存在" }, 404));
    vi.stubGlobal("fetch", missingFetch);
    await expect(pollComposition("p", "missing")).rejects.toThrow("合成任务不存在");
    expect(missingFetch).toHaveBeenCalledTimes(1);
  });

  it("连续网络/5xx 到阈值后停止，文案明确任务可能仍在后台", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(jsonResponse({ error: "busy" }, 503));
    vi.stubGlobal("fetch", fetchMock);

    const result = pollComposition("p", "c", {
      intervalMs: 250,
      timeoutMs: 2_000,
      maxConsecutiveErrors: 2,
    });
    const assertion = expect(result).rejects.toThrow(/仍可能在后台执行/);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("请求未返回时不会启动重叠轮询", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockReturnValueOnce(firstResponse)
      .mockResolvedValueOnce(
        jsonResponse({ composition: { status: "done", url: "/api/output/p/final.mp4" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = pollComposition("p", "c", { intervalMs: 250, timeoutMs: 3_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFirst?.(jsonResponse({ composition: { status: "running" } }));
    await vi.advanceTimersByTimeAsync(250);
    await expect(result).resolves.toBe("/api/output/p/final.mp4");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("单次挂起请求会在 requestTimeout 到期后中止，不绕过总 deadline", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = pollComposition("p", "c", {
      requestTimeoutMs: 300,
      timeoutMs: 5_000,
      maxConsecutiveErrors: 1,
    });
    const assertion = expect(result).rejects.toThrow(/任务仍可能在后台执行/);
    await vi.advanceTimersByTimeAsync(300);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("超时只结束客户端等待，不把服务端任务误报为失败", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ composition: { status: "running" } })),
    );
    const result = pollComposition("p", "c", { intervalMs: 250, timeoutMs: 500 });
    const assertion = expect(result).rejects.toThrow(/任务可能仍在后台执行/);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });
});
