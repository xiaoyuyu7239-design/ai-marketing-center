/**
 * TTS 配音 —— 多平台统一入口。
 *
 * 支持五类付费 TTS，按 config.provider 分发（缺省 "openai" 向后兼容旧配置）：
 * - volcengine：豆包语音 V3 HTTP Chunked 单向流式接口，拼接 base64 mp3 分片。
 * - openai：OpenAI 兼容 /audio/speech（tts-1 / 硅基流动 CosyVoice 等），同步返回 mp3。
 * - atlas：Atlas Cloud generateAudio（xai/tts-v1），异步——提交拿 prediction id 后轮询取音频 URL。
 * - minimax：MiniMax 海螺 T2A v2，同步返回 hex 编码 mp3（国内端点需 GroupId）。
 * - falai：fal.ai（MiniMax Speech-02），队列异步——提交后轮询 status，完成取 audio.url。
 *
 * 所有 provider 统一产出 mp3 字节（Buffer），上层（合成/试听）无需关心差异。
 */

import type { TTSProvider } from "./tts-presets";
import { randomUUID } from "node:crypto";
import { CircuitBreaker } from "@backend/shared/circuit-breaker";
import { ProviderError } from "@backend/providers/base";
import { readResponseBuffer, safeFetch, safeFetchPinned } from "@backend/shared/ssrf-guard";
import { readTtsCache, ttsCacheKey, writeTtsCache } from "./tts-cache";

export interface TTSConfig {
  /** 平台，缺省 "openai" */
  provider?: TTSProvider;
  /** baseUrl（按平台含义不同：OpenAI 兼容根、Atlas/MiniMax/fal 的服务根） */
  baseUrl: string;
  apiKey: string;
  /** 模型 id */
  model: string;
  /** 音色 / voice_id */
  voice: string;
  /** 语速倍率，0.5~2（各平台会各自夹取到合法区间），默认 1 */
  speed?: number;
  /** MiniMax 国内端点的 GroupId（可选） */
  groupId?: string;
}

/** 生成配音音频，返回 mp3 字节。失败抛错，由调用方决定降级。 */
// 熔断：同一 provider 连续失败 2 次（多半 Key 失效/服务挂）就 fail-fast 后续配音，
// 别让一整批分镜每个都各自超时拖垮合成；冷却 30s 后自动半开重试。
const ttsBreakers = new Map<string, CircuitBreaker>();
function ttsBreaker(provider: string): CircuitBreaker {
  let b = ttsBreakers.get(provider);
  if (!b) {
    b = new CircuitBreaker(2, 30_000);
    ttsBreakers.set(provider, b);
  }
  return b;
}

export interface GenerateSpeechOptions {
  /** Golden 评测要真实命中指定候选，不能拿旧缓存冒充本次结果。 */
  bypassCache?: boolean;
}

export async function generateSpeech(
  text: string,
  config: TTSConfig,
  options: GenerateSpeechOptions = {},
): Promise<Buffer> {
  const clean = (text || "").trim();
  if (!clean) throw new Error("配音文本为空");
  const provider = config.provider || "openai";
  const cacheKey = ttsCacheKey({
    provider,
    baseUrl: config.baseUrl,
    model: config.model,
    voice: config.voice,
    speed: config.speed,
    text: clean,
  });
  if (!options.bypassCache) {
    const cached = await readTtsCache(cacheKey);
    if (cached) return checkedAudioBuffer(cached, provider);
  }

  const breaker = ttsBreaker(provider);
  if (breaker.isOpen()) {
    throw new Error(`配音服务(${provider})连续失败已暂时熔断——请检查对应平台 Key/服务，约 30 秒后自动重试`);
  }
  try {
    const buf = await dispatchTTS(clean, config);
    breaker.recordSuccess();
    if (!options.bypassCache) await writeTtsCache(cacheKey, buf);
    return buf;
  } catch (e) {
    breaker.recordFailure();
    throw e;
  }
}

function dispatchTTS(clean: string, config: TTSConfig): Promise<Buffer> {
  switch (config.provider) {
    case "volcengine":
      return generateSpeechVolcEngine(clean, config);
    case "atlas":
      return generateSpeechAtlas(clean, config);
    case "minimax":
      return generateSpeechMiniMax(clean, config);
    case "falai":
      return generateSpeechFal(clean, config);
    default:
      return generateSpeechOpenAI(clean, config);
  }
}

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_TTS_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_TTS_JSON_BYTES = 1024 * 1024;
// 豆包 V3 把音频作为 base64 NDJSON 分片返回，编码后约为原音频的 4/3，
// 再预留 2 MiB 给 JSON/时间戳；音频本身仍受 20 MiB 上限约束。
const MAX_VOLCENGINE_TTS_STREAM_BYTES = Math.ceil(MAX_TTS_AUDIO_BYTES * 4 / 3) + 2 * 1024 * 1024;
const ASYNC_TTS_DEADLINE_MS = 90_000;

function submissionUncertain(provider: string): ProviderError {
  return new ProviderError(
    "供应商提交结果未知，已停止自动重试以避免重复创建付费任务",
    "SUBMISSION_UNCERTAIN",
    provider,
  );
}

function ttsEndpointPolicy(url: string, provider: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ProviderError("TTS 模型地址配置无效", "UNSAFE_ENDPOINT", provider);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new ProviderError("TTS 模型地址必须是无内嵌凭据的 HTTPS URL", "UNSAFE_ENDPOINT", provider);
  }
  return {
    allowedProtocols: ["https:"] as const,
    allowedHosts: [parsed.hostname],
    allowedPorts: [parsed.port],
  };
}

async function safeTtsFetch(url: string, init: RequestInit, provider: string): Promise<Response> {
  const policy = ttsEndpointPolicy(url, provider);
  return safeFetch(url, init, 0, policy);
}

async function readTtsJson<T>(response: Response): Promise<T> {
  const payload = await readResponseBuffer(response, MAX_TTS_JSON_BYTES);
  return JSON.parse(payload.toString("utf8")) as T;
}

async function submitPaidTts(
  url: string,
  init: RequestInit,
  provider: string,
  label: string,
): Promise<Response> {
  // 先做静态 URL 校验；协议/凭据配置错误时请求尚未发出，不应误报供应商已受理。
  ttsEndpointPolicy(url, provider);
  let response: Response;
  try {
    response = await safeTtsFetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(30_000),
    }, provider);
  } catch {
    throw submissionUncertain(provider);
  }
  if (response.ok) return response;
  await response.body?.cancel("tts-provider-error").catch(() => undefined);
  if (response.status >= 500) throw submissionUncertain(provider);
  throw new ProviderError(
    `${label}: ${response.status} ${response.statusText}`,
    "API_ERROR",
    provider,
    response.status,
  );
}

function checkedAudioBuffer(value: Buffer, provider: string): Buffer {
  if (value.length === 0 || value.length > MAX_TTS_AUDIO_BYTES) {
    throw new ProviderError("TTS 返回的音频为空或超过 20MB 限制", "INVALID_RESULT", provider);
  }
  return value;
}

function sameProviderOrigin(candidate: string | undefined, base: string): string | null {
  if (!candidate) return null;
  try {
    const target = new URL(candidate);
    const expected = new URL(base);
    return target.protocol === "https:" && target.origin === expected.origin ? target.href : null;
  } catch {
    return null;
  }
}

/** 把响应里的音频字段（URL / data URI / base64 / hex）统一下载或解码成 Buffer */
async function audioToBuffer(input: string, provider: string): Promise<Buffer> {
  const s = input.trim();
  if (/^https?:\/\//i.test(s)) {
    const parsed = new URL(s);
    if (parsed.protocol !== "https:") {
      throw new ProviderError("TTS 音频下载地址必须使用 HTTPS", "INVALID_RESULT", provider);
    }
    // 供应商返回的 URL 也不盲信：逐跳校验公网地址，并限制响应体，防止 SSRF/内存耗尽。
    let response: Response;
    try {
      response = await safeFetchPinned(
        s,
        { signal: AbortSignal.timeout(30_000) },
        4,
        { allowedProtocols: ["https:"] },
      );
    } catch {
      throw new ProviderError("TTS 音频下载地址未通过安全校验", "INVALID_RESULT", provider);
    }
    if (!response.ok) {
      throw new ProviderError(`下载 TTS 音频失败: ${response.status}`, "INVALID_RESULT", provider);
    }
    return checkedAudioBuffer(await readResponseBuffer(response, MAX_TTS_AUDIO_BYTES), provider);
  }
  if (s.startsWith("data:")) {
    const comma = s.indexOf(",");
    if (comma === -1) throw new Error("音频 data URI 格式错误（缺少逗号分隔符）");
    return checkedAudioBuffer(Buffer.from(s.slice(comma + 1), "base64"), provider);
  }
  // 纯 hex（仅 0-9a-f 且偶数长度）按 hex 解，否则按 base64
  const value = /^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0
    ? Buffer.from(s, "hex")
    : Buffer.from(s, "base64");
  return checkedAudioBuffer(value, provider);
}

// ==================== 火山引擎豆包语音 V3 HTTP Chunked ====================
// 官方协议：https://www.volcengine.com/docs/6561/2528925?lang=zh

interface VolcEngineTtsChunk {
  code?: number;
  message?: string;
  data?: string;
}

function decodeVolcEngineAudioChunk(value: string): Buffer | null {
  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new ProviderError(
      "火山豆包 TTS 返回了无效音频分片",
      "INVALID_RESULT",
      "volcengine",
      undefined,
      { category: "unknown", retryable: false },
    );
  }
  return Buffer.from(normalized, "base64");
}

async function generateSpeechVolcEngine(text: string, config: TTSConfig): Promise<Buffer> {
  const base = (config.baseUrl || "https://openspeech.bytedance.com/api/v3/tts").replace(/\/+$/, "");
  const url = base.endsWith("/unidirectional") ? base : `${base}/unidirectional`;
  const provider = "volcengine";
  const resourceId = config.model || "seed-tts-2.0";
  const response = await submitPaidTts(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": config.apiKey,
      "X-Api-Resource-Id": resourceId,
      "X-Api-Request-Id": randomUUID(),
    },
    body: JSON.stringify({
      req_params: {
        text,
        speaker: config.voice || "zh_female_vv_uranus_bigtts",
        audio_params: {
          format: "mp3",
          sample_rate: 24_000,
          ...(config.speed != null && {
            speech_rate: Math.round((clamp(config.speed, 0.5, 2) - 1) * 100),
          }),
        },
        aigc_metadata: {
          enable: true,
          content_producer: process.env.HUIMAI_AIGC_SERVICE_PROVIDER?.trim() || "绘卖AI",
        },
      },
    }),
    signal: AbortSignal.timeout(90_000),
  }, provider, "火山豆包 TTS 请求失败");

  let raw: Buffer;
  try {
    raw = await readResponseBuffer(response, MAX_VOLCENGINE_TTS_STREAM_BYTES);
  } catch {
    throw submissionUncertain(provider);
  }

  const audio: Buffer[] = [];
  let totalBytes = 0;
  let completed = false;
  try {
    for (const line of raw.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      const chunk = JSON.parse(line) as VolcEngineTtsChunk;
      const code = Number(chunk.code ?? 0);
      if (code === 20_000_000) {
        completed = true;
        break;
      }
      if (code !== 0) {
        throw new ProviderError(
          `火山豆包 TTS 明确拒绝请求（code=${code}）`,
          "API_ERROR",
          provider,
          undefined,
          { category: "invalid_input", retryable: false, upstreamCode: String(code) },
        );
      }
      const decoded = decodeVolcEngineAudioChunk(chunk.data || "");
      if (!decoded) continue;
      totalBytes += decoded.length;
      if (totalBytes > MAX_TTS_AUDIO_BYTES) {
        throw new ProviderError(
          "火山豆包 TTS 返回的音频超过 20MB 限制",
          "INVALID_RESULT",
          provider,
          undefined,
          { category: "unknown", retryable: false },
        );
      }
      audio.push(decoded);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw submissionUncertain(provider);
  }
  if (!completed) throw submissionUncertain(provider);
  return checkedAudioBuffer(Buffer.concat(audio, totalBytes), provider);
}

// ==================== OpenAI 兼容 /audio/speech ====================

async function generateSpeechOpenAI(text: string, config: TTSConfig): Promise<Buffer> {
  const base = config.baseUrl.replace(/\/$/, "");
  const resp = await submitPaidTts(`${base}/audio/speech`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      input: text,
      voice: config.voice,
      response_format: "mp3",
      ...(config.speed != null && { speed: config.speed }),
    }),
  }, "openai", "TTS 请求失败");
  try {
    return checkedAudioBuffer(await readResponseBuffer(resp, MAX_TTS_AUDIO_BYTES), "openai");
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw submissionUncertain("openai");
  }
}

// ==================== Atlas Cloud generateAudio（异步轮询） ====================

interface AtlasPrediction {
  id?: string;
  status?: string;
  outputs?: string[];
  output?: string | { audio?: string; url?: string };
  audio?: string;
  error?: string;
  data?: AtlasPrediction;
}

async function generateSpeechAtlas(text: string, config: TTSConfig): Promise<Buffer> {
  const base = (config.baseUrl || "https://api.atlascloud.ai/api/v1").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" };

  const submit = await submitPaidTts(`${base}/model/generateAudio`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: config.model || "xai/tts-v1",
      text,
      language: "auto",
      voice_id: config.voice || "eve",
      codec: "mp3",
      ...(config.speed != null && { speed: clamp(config.speed, 0.7, 1.5) }),
    }),
    signal: AbortSignal.timeout(30000), // 提交加 30s 超时，避免挂起
  }, "atlas", "Atlas TTS 提交失败");
  let sj: { data?: { id?: string }; id?: string };
  try {
    sj = await readTtsJson<typeof sj>(submit);
  } catch {
    throw submissionUncertain("atlas");
  }
  const taskId = sj?.data?.id ?? sj?.id;
  if (!taskId) throw submissionUncertain("atlas");

  // 轮询 prediction（TTS 通常数秒内完成）
  const deadline = Date.now() + ASYNC_TTS_DEADLINE_MS;
  for (let i = 0; i < 60 && Date.now() < deadline; i++) {
    await sleep(1000);
    // 每次轮询加 10s 超时，且超时/网络抖动只跳过本轮（下轮再试），避免一次卡顿挂死整个生成
    let pr: Response;
    try {
      pr = await safeTtsFetch(
        `${base}/model/prediction/${taskId}`,
        { headers, signal: AbortSignal.timeout(10000) },
        "atlas",
      );
    } catch {
      continue;
    }
    if (!pr.ok) {
      await pr.body?.cancel("tts-poll-error").catch(() => undefined);
      continue;
    }
    let raw: AtlasPrediction;
    try {
      raw = await readTtsJson<AtlasPrediction>(pr);
    } catch {
      continue;
    }
    const p: AtlasPrediction = raw.data ?? raw;
    const status = (p.status || "").toLowerCase();
    if (status === "completed" || status === "succeeded") {
      const audio =
        p.outputs?.[0] ??
        (typeof p.output === "string" ? p.output : p.output?.url || p.output?.audio) ??
        p.audio;
      if (!audio) throw new Error("Atlas TTS 完成但未返回音频");
      return audioToBuffer(audio, "atlas");
    }
    if (status === "failed" || status === "error") {
      throw new Error(`Atlas TTS 失败: ${p.error || status}`);
    }
  }
  throw submissionUncertain("atlas");
}

// ==================== MiniMax 海螺 T2A v2（hex 解码） ====================

async function generateSpeechMiniMax(text: string, config: TTSConfig): Promise<Buffer> {
  const base = (config.baseUrl || "https://api.minimax.chat/v1").replace(/\/$/, "");
  const url = `${base}/t2a_v2` + (config.groupId ? `?GroupId=${encodeURIComponent(config.groupId)}` : "");
  const resp = await submitPaidTts(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model || "speech-2.6-hd",
      text,
      stream: false,
      output_format: "hex",
      language_boost: "auto",
      voice_setting: {
        voice_id: config.voice || "female-tianmei",
        speed: config.speed != null ? clamp(config.speed, 0.5, 2) : 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    }),
  }, "minimax", "MiniMax TTS 请求失败");
  let j: {
    data?: { audio?: string };
    base_resp?: { status_code?: number; status_msg?: string };
  };
  try {
    j = await readTtsJson<typeof j>(resp);
  } catch {
    throw submissionUncertain("minimax");
  }
  const code = j?.base_resp?.status_code;
  if (code != null && code !== 0) {
    throw new Error(`MiniMax TTS 失败: ${j?.base_resp?.status_msg || "未知错误"} (code=${code})`);
  }
  const hex = j?.data?.audio;
  if (!hex) throw new Error("MiniMax TTS 未返回音频（检查 Key / GroupId / 音色 id）");
  return checkedAudioBuffer(Buffer.from(hex, "hex"), "minimax");
}

// ==================== fal.ai（MiniMax Speech-02，队列异步） ====================

async function generateSpeechFal(text: string, config: TTSConfig): Promise<Buffer> {
  const base = (config.baseUrl || "https://queue.fal.run").replace(/\/$/, "");
  const model = config.model || "fal-ai/minimax/speech-02-hd";
  const headers = { Authorization: `Key ${config.apiKey}`, "Content-Type": "application/json" };

  const submit = await submitPaidTts(`${base}/${model}`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text,
      output_format: "url",
      voice_setting: {
        voice_id: config.voice || "Wise_Woman",
        speed: config.speed != null ? clamp(config.speed, 0.5, 2) : 1,
        vol: 1,
        pitch: 0,
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: "mp3", channel: 1 },
    }),
  }, "falai", "fal TTS 提交失败");
  let sj: { request_id?: string; status_url?: string; response_url?: string };
  try {
    sj = await readTtsJson<typeof sj>(submit);
  } catch {
    throw submissionUncertain("falai");
  }
  if (!sj?.request_id) throw submissionUncertain("falai");
  // 优先用返回的 status_url / response_url（最稳），否则按队列约定拼接
  // 返回 URL 会携带 Authorization，必须保持与已审核 baseUrl 同源，不能把 Key 发给任意主机。
  const statusUrl = sameProviderOrigin(sj.status_url, base)
    ?? `${base}/${model}/requests/${sj.request_id}/status`;
  const resultUrl = sameProviderOrigin(sj.response_url, base)
    ?? `${base}/${model}/requests/${sj.request_id}`;

  const deadline = Date.now() + ASYNC_TTS_DEADLINE_MS;
  for (let i = 0; i < 60 && Date.now() < deadline; i++) {
    await sleep(1000);
    const st = await safeTtsFetch(statusUrl, {
      headers,
      signal: AbortSignal.timeout(10_000),
    }, "falai").catch(() => null);
    if (!st) continue;
    if (!st.ok) {
      await st.body?.cancel("tts-poll-error").catch(() => undefined);
      continue;
    }
    let sjson: { status?: string };
    try {
      sjson = await readTtsJson<{ status?: string }>(st);
    } catch {
      continue;
    }
    const status = (sjson.status || "").toUpperCase();
    if (status === "COMPLETED") {
      const rr = await safeTtsFetch(resultUrl, {
        headers,
        signal: AbortSignal.timeout(30_000),
      }, "falai").catch(() => null);
      if (!rr || !rr.ok) {
        await rr?.body?.cancel("tts-result-error").catch(() => undefined);
        throw submissionUncertain("falai");
      }
      let result: { audio?: { url?: string } };
      try {
        result = await readTtsJson<{ audio?: { url?: string } }>(rr);
      } catch {
        throw submissionUncertain("falai");
      }
      const audioUrl = result?.audio?.url;
      if (!audioUrl) throw new Error("fal TTS 完成但未返回音频 URL");
      return audioToBuffer(audioUrl, "falai");
    }
    if (status === "FAILED" || status === "ERROR") {
      throw new Error("fal TTS 任务失败");
    }
  }
  throw submissionUncertain("falai");
}
