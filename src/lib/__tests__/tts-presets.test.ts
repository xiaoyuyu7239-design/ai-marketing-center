import { describe, expect, it } from "vitest";

import {
  DEFAULT_TTS_PROVIDER,
  OPENAI_TTS_PRESETS,
  getTTSProviderMeta,
  resolveTTSConfig,
} from "@backend/core/media/tts-presets";

describe("TTS 平台预设", () => {
  it("默认使用豆包语音 2.0 的独立接口与语音 Key", () => {
    expect(DEFAULT_TTS_PROVIDER).toBe("volcengine");
    expect(getTTSProviderMeta("volcengine")).toMatchObject({
      baseUrl: "https://openspeech.bytedance.com/api/v3/tts",
      defaultModel: "seed-tts-2.0",
      defaultVoice: "zh_female_vv_uranus_bigtts",
      keySource: "tts",
    });

    expect(resolveTTSConfig({
      enabled: true,
      provider: "volcengine",
      apiKey: "speech-key",
    }, {
      volcengine: { apiKey: "ark-key" },
    })).toMatchObject({
      provider: "volcengine",
      apiKey: "speech-key",
      model: "seed-tts-2.0",
      voice: "zh_female_vv_uranus_bigtts",
    });
  });

  it("不再把火山方舟误标成 OpenAI /audio/speech 兼容端点", () => {
    expect(OPENAI_TTS_PRESETS.some((preset) => /ark\.cn-|doubao-tts/i.test(
      `${preset.baseUrl} ${preset.model}`,
    ))).toBe(false);
    expect(getTTSProviderMeta("legacy-unknown").value).toBe("openai");
  });
});
