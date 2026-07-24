import { isRenderPreset, type RenderPreset } from "@backend/core/media/compose-presets";

export type AgentAspectRatio = "9:16" | "16:9" | "1:1";
export type AgentResolution = "720p" | "1080p";
export type AgentTargetDuration = 15 | 30 | 45;
/** 内容方向：auto=按历史效果智能选（本地门店冷启动落到同城到店）；其余为老板显式点选的风格 */
export type AgentScriptStyle = "auto" | "pain_point" | "scenario" | "comparison" | "story" | "mood" | "local";

export interface AgentGenerationSettings {
  renderPreset: RenderPreset;
  aspectRatio: AgentAspectRatio;
  resolution: AgentResolution;
  targetDuration: AgentTargetDuration;
  styleType: AgentScriptStyle;
  /** AI 配音（TTS）：关闭则成片为纯 BGM+贴字。在生成前决定，合成页沿用（后置容易被遗忘） */
  voiceoverEnabled: boolean;
}

export const AGENT_GENERATION_SETTINGS_LATEST_KEY = "clipforge_agent_generation_settings:latest:v2";
export const LEGACY_AGENT_GENERATION_SETTINGS_LATEST_KEY = "clipforge_agent_generation_settings:latest";

export const DEFAULT_AGENT_GENERATION_SETTINGS: AgentGenerationSettings = {
  renderPreset: "fast",
  aspectRatio: "9:16",
  resolution: "720p",
  targetDuration: 15,
  // 默认交给转化数据与商家画像选方向；无数据时电商冷启为氛围大片，本地门店为同城到店
  styleType: "auto",
  // 本次只调整摘要中的四项默认值，配音仍保持默认关闭
  voiceoverEnabled: false,
};

const LEGACY_DEFAULT_AGENT_GENERATION_SETTINGS: AgentGenerationSettings = {
  renderPreset: "fast",
  aspectRatio: "9:16",
  resolution: "720p",
  targetDuration: 30,
  styleType: "mood",
  voiceoverEnabled: false,
};

/** 内容方向选项（工作台"做选择题"用；value 与 /api/llm/script 的 styleType 参数一致） */
export const SCRIPT_STYLE_OPTIONS: { value: AgentScriptStyle; label: string; hint: string }[] = [
  { value: "auto", label: "智能推荐", hint: "按你账号的历史转化数据自动选" },
  { value: "pain_point", label: "痛点种草", hint: "先戳痛点再给解法" },
  { value: "scenario", label: "场景安利", hint: "把商品放进生活场景" },
  { value: "comparison", label: "对比测评", hint: "用前用后/竞品对比" },
  { value: "story", label: "剧情故事", hint: "小剧情带出商品" },
  { value: "mood", label: "氛围大片", hint: "纯画面+音乐+一句短文案，像时尚广告片（建议关配音）" },
  { value: "local", label: "同城到店", hint: "给同城人看的到店内容：城市/商圈钩子+位置指引+到店号召（实体门店选这个）" },
];

const ASPECT_RATIOS = new Set<AgentAspectRatio>(["9:16", "16:9", "1:1"]);
const RESOLUTIONS = new Set<AgentResolution>(["720p", "1080p"]);
const TARGET_DURATIONS = new Set<AgentTargetDuration>([15, 30, 45]);
const SCRIPT_STYLES = new Set<AgentScriptStyle>(["auto", "pain_point", "scenario", "comparison", "story", "mood", "local"]);

export function projectAgentGenerationSettingsKey(projectId: string) {
  return `clipforge_agent_generation_settings:${projectId}`;
}

export function normalizeAgentGenerationSettings(value: unknown): AgentGenerationSettings {
  if (!value || typeof value !== "object") return DEFAULT_AGENT_GENERATION_SETTINGS;

  const raw = value as Partial<AgentGenerationSettings>;
  const rawPreset = isRenderPreset(raw.renderPreset) ? raw.renderPreset : undefined;
  const rawResolution = RESOLUTIONS.has(raw.resolution as AgentResolution)
    ? raw.resolution as AgentResolution
    : undefined;
  const useHdQuality = rawResolution === "1080p" || rawPreset === "hd";
  const renderPreset: RenderPreset = useHdQuality ? "hd" : "fast";
  const aspectRatio = ASPECT_RATIOS.has(raw.aspectRatio as AgentAspectRatio)
    ? raw.aspectRatio as AgentAspectRatio
    : DEFAULT_AGENT_GENERATION_SETTINGS.aspectRatio;
  const resolution: AgentResolution = useHdQuality ? "1080p" : "720p";
  const targetDuration = TARGET_DURATIONS.has(raw.targetDuration as AgentTargetDuration)
    ? raw.targetDuration as AgentTargetDuration
    : DEFAULT_AGENT_GENERATION_SETTINGS.targetDuration;
  const styleType = SCRIPT_STYLES.has(raw.styleType as AgentScriptStyle)
    ? raw.styleType as AgentScriptStyle
    : DEFAULT_AGENT_GENERATION_SETTINGS.styleType;
  const voiceoverEnabled = typeof raw.voiceoverEnabled === "boolean"
    ? raw.voiceoverEnabled
    : DEFAULT_AGENT_GENERATION_SETTINGS.voiceoverEnabled;

  return { renderPreset, aspectRatio, resolution, targetDuration, styleType, voiceoverEnabled };
}

export function parseStoredAgentGenerationSettings(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    return normalizeAgentGenerationSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * 仅用于迁移工作台的“上次选择”。项目级设置仍走 parseStoredAgentGenerationSettings，
 * 以便旧项目继续保留当时的 30s / 氛围大片参数。
 */
export function migrateLegacyLatestAgentGenerationSettings(raw: string | null | undefined) {
  const saved = parseStoredAgentGenerationSettings(raw);
  if (!saved) return null;

  const isLegacyDefault = (Object.keys(LEGACY_DEFAULT_AGENT_GENERATION_SETTINGS) as (keyof AgentGenerationSettings)[])
    .every((key) => saved[key] === LEGACY_DEFAULT_AGENT_GENERATION_SETTINGS[key]);

  return isLegacyDefault ? DEFAULT_AGENT_GENERATION_SETTINGS : saved;
}
