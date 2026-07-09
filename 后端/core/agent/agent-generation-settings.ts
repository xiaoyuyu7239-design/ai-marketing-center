import { isRenderPreset, type RenderPreset } from "@backend/core/media/compose-presets";

export type AgentAspectRatio = "9:16" | "16:9" | "1:1";
export type AgentResolution = "720p" | "1080p";
export type AgentTargetDuration = 15 | 30 | 45;

export interface AgentGenerationSettings {
  renderPreset: RenderPreset;
  aspectRatio: AgentAspectRatio;
  resolution: AgentResolution;
  targetDuration: AgentTargetDuration;
}

export const AGENT_GENERATION_SETTINGS_LATEST_KEY = "clipforge_agent_generation_settings:latest";

export const DEFAULT_AGENT_GENERATION_SETTINGS: AgentGenerationSettings = {
  renderPreset: "fast",
  aspectRatio: "9:16",
  resolution: "720p",
  targetDuration: 30,
};

const ASPECT_RATIOS = new Set<AgentAspectRatio>(["9:16", "16:9", "1:1"]);
const RESOLUTIONS = new Set<AgentResolution>(["720p", "1080p"]);
const TARGET_DURATIONS = new Set<AgentTargetDuration>([15, 30, 45]);

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

  return { renderPreset, aspectRatio, resolution, targetDuration };
}

export function parseStoredAgentGenerationSettings(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    return normalizeAgentGenerationSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}
