import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { classifyAgentError } from "@server/admin/agents/service";
import { generateSpeech, type TTSConfig } from "@backend/core/media/tts";

const previousDataDir = process.env.APP_DATA_DIR;

function config(overrides: Partial<TTSConfig> = {}): TTSConfig {
  return {
    provider: "openai",
    baseUrl: "https://93.184.216.34/v1",
    apiKey: "test-only",
    model: "tts-fixed-20260716",
    voice: "voice-fixed",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.APP_DATA_DIR = `/private/tmp/huimai-tts-safety-${process.pid}-${crypto.randomUUID()}`;
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.APP_DATA_DIR;
  else process.env.APP_DATA_DIR = previousDataDir;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("付费 TTS 提交安全", () => {
  it("火山豆包 TTS 使用独立 V3 鉴权并按顺序拼接音频分片", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response([
        JSON.stringify({ code: 0, message: "OK", data: Buffer.from("first-").toString("base64") }),
        JSON.stringify({ code: 0, message: "OK", data: Buffer.from("second").toString("base64") }),
        JSON.stringify({ code: 20_000_000, message: "finished" }),
      ].join("\n"), { status: 200, headers: { "Content-Type": "application/x-ndjson" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const audio = await generateSpeech("测试口播", config({
      provider: "volcengine",
      baseUrl: "https://93.184.216.34/api/v3/tts",
      model: "seed-tts-2.0",
      voice: "zh_female_vv_uranus_bigtts",
      speed: 1.5,
    }));

    expect(audio.toString("utf8")).toBe("first-second");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://93.184.216.34/api/v3/tts/unidirectional");
    const headers = new Headers(init.headers);
    expect(headers.get("X-Api-Key")).toBe("test-only");
    expect(headers.get("X-Api-Resource-Id")).toBe("seed-tts-2.0");
    expect(headers.get("X-Api-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers.get("X-Control-Require-Usage-Tokens-Return")).toBeNull();
    expect(headers.get("Authorization")).toBeNull();
    expect(JSON.parse(String(init.body))).toMatchObject({
      req_params: {
        text: "测试口播",
        speaker: "zh_female_vv_uranus_bigtts",
        audio_params: { format: "mp3", sample_rate: 24_000, speech_rate: 50 },
        aigc_metadata: { enable: true },
      },
    });
  });

  it("火山豆包 TTS 缺少成功终态时不自动重提付费请求", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        code: 0,
        message: "OK",
        data: Buffer.from("partial-audio").toString("base64"),
      }), { status: 200, headers: { "Content-Type": "application/x-ndjson" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateSpeech("测试口播", config({
      provider: "volcengine",
      baseUrl: "https://93.184.216.35/api/v3/tts",
      model: "seed-tts-2.0",
      voice: "zh_female_vv_uranus_bigtts",
    }))).rejects.toMatchObject({ code: "SUBMISSION_UNCERTAIN" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("同步 TTS 的 5xx 不重试、也不触发跨供应商 fallback", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("upstream failed", { status: 503, statusText: "Unavailable" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    let caught: unknown;
    try {
      await generateSpeech("测试口播", config());
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "SUBMISSION_UNCERTAIN" });
    expect(classifyAgentError(caught)).toMatchObject({
      category: "unknown",
      fallbackAllowed: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("异步 TTS 返回内网或非 HTTPS 音频 URL 时拒绝下载", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { id: "task-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { status: "completed", outputs: ["http://127.0.0.1/private.mp3"] } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const pending = generateSpeech("测试口播", config({
      provider: "atlas",
      baseUrl: "https://93.184.216.35/api/v1",
    }));
    const rejected = expect(pending).rejects.toMatchObject({ code: "INVALID_RESULT" });
    await rejected;

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("付费 TTS 自定义端点指向私网时拒绝且不发出请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateSpeech("测试口播", config({
      baseUrl: "https://127.0.0.1/v1",
    }))).rejects.toMatchObject({ code: "SUBMISSION_UNCERTAIN" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
