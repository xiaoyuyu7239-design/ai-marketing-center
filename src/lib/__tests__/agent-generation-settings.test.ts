import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_GENERATION_SETTINGS,
  migrateLegacyLatestAgentGenerationSettings,
  normalizeAgentGenerationSettings,
  parseStoredAgentGenerationSettings,
} from "@backend/core/agent/agent-generation-settings";

const legacyDefault = {
  renderPreset: "fast",
  aspectRatio: "9:16",
  resolution: "720p",
  targetDuration: 30,
  styleType: "mood",
  voiceoverEnabled: false,
} as const;

describe("agent generation settings", () => {
  it("默认生成为竖屏、15s、标准、智能推荐", () => {
    expect(DEFAULT_AGENT_GENERATION_SETTINGS).toEqual({
      renderPreset: "fast",
      aspectRatio: "9:16",
      resolution: "720p",
      targetDuration: 15,
      styleType: "auto",
      voiceoverEnabled: false,
    });
    expect(normalizeAgentGenerationSettings(null)).toEqual(DEFAULT_AGENT_GENERATION_SETTINGS);
  });

  it("把浏览器中自动保存的旧默认迁移到新默认", () => {
    expect(migrateLegacyLatestAgentGenerationSettings(JSON.stringify(legacyDefault)))
      .toEqual(DEFAULT_AGENT_GENERATION_SETTINGS);
  });

  it("保留用户自定义的上次选择和旧项目参数", () => {
    const customized = { ...legacyDefault, targetDuration: 45, styleType: "story" };

    expect(migrateLegacyLatestAgentGenerationSettings(JSON.stringify(customized))).toEqual(customized);
    expect(parseStoredAgentGenerationSettings(JSON.stringify(legacyDefault))).toEqual(legacyDefault);
  });
});
