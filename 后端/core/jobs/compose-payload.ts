import "server-only";

import { existsSync } from "node:fs";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "@backend/db";
import { assets, projects, scripts, videoClips, type Shot } from "@backend/db/schema";
import { resolveOwnedUploadRef } from "@backend/core/auth/media-access";
import { isRenderPreset, resolveRenderProfile } from "@backend/core/media/compose-presets";
import { DEFAULT_FREE_VOICE, FREE_TTS_VOICES } from "@backend/core/media/edge-tts";

const SHOT_TYPES = new Set<Shot["type"]>([
  "hook",
  "pain_point",
  "product_reveal",
  "demo",
  "social_proof",
  "cta",
]);
const TRANSITIONS = new Set<Shot["transition"]>([
  "ai_start_end",
  "ai_reference",
  "direct_concat",
  "ffmpeg_fade",
]);
const MOTIONS = new Set<NonNullable<Shot["motion"]>>([
  "zoom_in_slow",
  "pan_left",
  "pan_right",
  "ken_burns",
  "static",
]);
const OVERLAY_STYLES = new Set<NonNullable<Shot["textOverlay"]>["style"]>([
  "title",
  "subtitle",
  "highlight",
  "price",
]);
const FREE_VOICES = new Set(FREE_TTS_VOICES.map((voice) => voice.value));
const BGM_MOODS = new Set(["upbeat", "chill", "energetic", "emotional"]);
const FORBIDDEN_PAYLOAD_KEY = /^(?:apiKey|api_key|authorization|accessToken|access_token|secret|password|baseUrl|base_url|groupId|group_id)$/i;

export class ComposeJobInputError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ComposeJobInputError";
    this.status = status;
  }
}

export interface ComposeShotSnapshot {
  shotId: number;
  type: Shot["type"];
  duration: number;
  transition: Shot["transition"];
  voiceover: string;
  motion?: Shot["motion"];
  textOverlay?: Shot["textOverlay"];
}

export interface ComposeAssetSnapshot {
  id: string;
  shotId: number;
  fileRef: string;
  type: string;
  provider: string | null;
  author: string | null;
  license: string | null;
  sourceUrl: string | null;
  licenseUrl: string | null;
  attributionText: string | null;
  requiresAttribution: boolean | null;
}

export interface ComposeSourceAssetRow {
  id: string;
  shotId: number;
  filePath: string | null;
  type: string;
  provider: string | null;
  author: string | null;
  license: string | null;
  sourceUrl: string | null;
  licenseUrl: string | null;
  attributionText: string | null;
  requiresAttribution: boolean | null;
  createdAt: Date | null;
}

export interface ComposeVideoClipRow {
  id: string;
  shotId: number;
  assetId: string | null;
  filePath: string | null;
  status: string;
  createdAt: Date | null;
}

export interface ComposeJobPayloadV1 {
  version: 1;
  merchantId: string;
  projectId: string;
  selectedScriptId: string;
  project: {
    name: string;
    productName: string | null;
    productPrice: string | null;
    productCategory: string | null;
    productImages: string[];
  };
  shots: ComposeShotSnapshot[];
  assets: ComposeAssetSnapshot[];
  options: {
    output: {
      resolution: "720p" | "1080p";
      aspectRatio: "9:16" | "16:9" | "1:1";
      videoPreset: "veryfast" | "medium" | "slow";
      crf: number;
    };
    agentTts: boolean;
    freeTts: {
      enabled: boolean;
      voice: string;
      rate?: string;
    };
    bgmRef?: string;
    freeBgm: boolean;
    bgmMood?: string;
    bgmDuck: boolean;
    ctaText?: string;
    karaoke: boolean;
    productCard: boolean;
  };
}

export interface ComposePayloadBuildResult {
  payload: ComposeJobPayloadV1;
  resolution: "720p" | "1080p";
  aspectRatio: "9:16" | "16:9" | "1:1";
  ttsEnabled: boolean;
  bgmPath?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function sanitizeRate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.trim().match(/^([+-])(\d{1,3})%$/);
  if (!match || Number(match[2]) > 100) return undefined;
  return `${match[1]}${Number(match[2])}%`;
}

function sanitizeShot(value: Shot): ComposeShotSnapshot {
  if (!Number.isSafeInteger(value.shotId) || value.shotId < 0) {
    throw new ComposeJobInputError("脚本包含无效的分镜编号");
  }
  if (!SHOT_TYPES.has(value.type)) throw new ComposeJobInputError("脚本包含不支持的分镜类型");
  const duration = Number(value.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60) {
    throw new ComposeJobInputError(`分镜 ${value.shotId} 的时长无效`);
  }
  const transition = TRANSITIONS.has(value.transition) ? value.transition : "ai_start_end";
  const motion = value.motion && MOTIONS.has(value.motion) ? value.motion : undefined;
  const overlay = value.textOverlay;
  const textOverlay =
    overlay && OVERLAY_STYLES.has(overlay.style) && typeof overlay.text === "string" && overlay.text.trim()
      ? { text: overlay.text.trim().slice(0, 500), style: overlay.style }
      : undefined;
  return {
    shotId: value.shotId,
    type: value.type,
    duration,
    transition,
    voiceover: typeof value.voiceover === "string" ? value.voiceover.slice(0, 4_000) : "",
    ...(motion ? { motion } : {}),
    ...(textOverlay ? { textOverlay } : {}),
  };
}

function snapshotHasForbiddenKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(snapshotHasForbiddenKey);
  return Object.entries(value as Record<string, unknown>).some(
    ([key, child]) => FORBIDDEN_PAYLOAD_KEY.test(key) || snapshotHasForbiddenKey(child),
  );
}

export function assertComposePayloadHasNoSecrets(value: unknown): void {
  if (snapshotHasForbiddenKey(value)) {
    throw new Error("compose job payload 包含禁止持久化的密钥或服务端配置字段");
  }
}

export function resolveComposeFileRef(
  fileRef: string | undefined,
  merchantId: string,
  projectId: string,
): string | undefined {
  if (!fileRef) return undefined;
  const filePath = resolveOwnedUploadRef(fileRef, merchantId, projectId);
  return filePath && existsSync(filePath) ? filePath : undefined;
}

function newestRowFirst(
  left: { id: string; createdAt: Date | null },
  right: { id: string; createdAt: Date | null },
): number {
  const leftTime = left.createdAt?.getTime();
  const rightTime = right.createdAt?.getTime();
  const leftCreatedAt = leftTime !== undefined && Number.isFinite(leftTime)
    ? leftTime
    : Number.NEGATIVE_INFINITY;
  const rightCreatedAt = rightTime !== undefined && Number.isFinite(rightTime)
    ? rightTime
    : Number.NEGATIVE_INFINITY;
  if (leftCreatedAt !== rightCreatedAt) return rightCreatedAt > leftCreatedAt ? 1 : -1;
  return right.id === left.id ? 0 : right.id > left.id ? 1 : -1;
}

/**
 * 冻结合成素材：默认选每个分镜最新原素材；如有已完成的动态片段，
 * 只在 clip.assetId 能精确回指同分镜原素材时用视频覆盖 fileRef。许可/作者/来源
 * 仍来自被引用的原素材，避免“转动态”后丢失溯源。
 */
export function selectComposeAssetSnapshots(
  sourceAssets: ComposeSourceAssetRow[],
  clips: ComposeVideoClipRow[],
): ComposeAssetSnapshot[] {
  const orderedAssets = [...sourceAssets].sort(newestRowFirst);
  const sourceById = new Map(orderedAssets.map((asset) => [asset.id, asset]));
  const sourceByShot = new Map<number, ComposeSourceAssetRow>();
  for (const asset of orderedAssets) {
    if (asset.filePath && !sourceByShot.has(asset.shotId)) sourceByShot.set(asset.shotId, asset);
  }

  const latestClipByShot = new Map<number, ComposeVideoClipRow>();
  for (const clip of [...clips].sort(newestRowFirst)) {
    const currentSource = sourceByShot.get(clip.shotId);
    if (
      clip.status === "done" &&
      clip.filePath &&
      clip.assetId === currentSource?.id &&
      !latestClipByShot.has(clip.shotId)
    ) {
      latestClipByShot.set(clip.shotId, clip);
    }
  }

  return [...sourceByShot.entries()].map(([shotId, newestSource]) => {
    const clip = latestClipByShot.get(shotId);
    const linkedSource = clip?.assetId ? sourceById.get(clip.assetId) : undefined;
    const useClip = Boolean(
      clip?.filePath
      && linkedSource
      && linkedSource.id === newestSource.id
      && linkedSource.shotId === shotId,
    );
    const provenance = useClip ? linkedSource! : newestSource;
    return {
      id: provenance.id,
      shotId,
      fileRef: useClip ? clip!.filePath! : (newestSource.filePath as string),
      type: provenance.type,
      provider: provenance.provider,
      author: provenance.author,
      license: provenance.license,
      sourceUrl: provenance.sourceUrl,
      licenseUrl: provenance.licenseUrl,
      attributionText: provenance.attributionText,
      requiresAttribution: provenance.requiresAttribution,
    };
  });
}

export async function buildComposeJobPayload(
  merchantId: string,
  projectId: string,
  requestBody: unknown,
): Promise<ComposePayloadBuildResult> {
  const body = asRecord(requestBody);
  const db = getDb();
  const project = db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.merchantId, merchantId)))
    .limit(1)
    .all()[0];
  if (!project) throw new ComposeJobInputError("项目不存在", 404);

  const scriptRows = db.select().from(scripts).where(eq(scripts.projectId, projectId)).all();
  const selected = [...scriptRows]
    .sort((left, right) => {
      const selectedDiff = Number(Boolean(right.selected)) - Number(Boolean(left.selected));
      return selectedDiff || (right.version ?? 0) - (left.version ?? 0);
    })[0];
  if (!selected || !Array.isArray(selected.shots) || selected.shots.length === 0) {
    throw new ComposeJobInputError("尚未生成脚本，无法合成");
  }
  const shotSnapshots = (selected.shots as Shot[]).map(sanitizeShot);

  // 同一 shot 有多条历史素材时冻结最新一条，避免重启后 Map 顺序变化导致换素材/credits 漂移。
  const assetRows = db
    .select()
    .from(assets)
    .where(eq(assets.projectId, projectId))
    .orderBy(desc(assets.createdAt), desc(sql<number>`${assets}._rowid_`))
    .all();
  const clipRows = db
    .select()
    .from(videoClips)
    .where(and(eq(videoClips.projectId, projectId), eq(videoClips.status, "done")))
    .orderBy(desc(videoClips.createdAt), desc(sql<number>`${videoClips}._rowid_`))
    .all();
  const assetSnapshots = selectComposeAssetSnapshots(assetRows, clipRows);

  const productImages = Array.isArray(project.productImages)
    ? project.productImages.filter((value): value is string => typeof value === "string")
    : [];
  const snapshotAssetByShot = new Map(assetSnapshots.map((asset) => [asset.shotId, asset]));
  const hasAnyAsset = shotSnapshots.some((shot) =>
    resolveComposeFileRef(
      snapshotAssetByShot.get(shot.shotId)?.fileRef ?? productImages[0],
      merchantId,
      projectId,
    ),
  );
  if (!hasAnyAsset) {
    throw new ComposeJobInputError("没有可用素材，请先在素材步骤生成素材或上传商品图");
  }

  const validPreset = isRenderPreset(body.renderPreset) ? body.renderPreset : undefined;
  const profile = resolveRenderProfile(validPreset);
  const resolution: "720p" | "1080p" = validPreset
    ? profile.resolution
    : body.resolution === "720p"
      ? "720p"
      : "1080p";
  const aspectRatio = (["9:16", "16:9", "1:1"] as const).includes(
    body.aspectRatio as "9:16" | "16:9" | "1:1",
  )
    ? (body.aspectRatio as "9:16" | "16:9" | "1:1")
    : "9:16";

  const tts = asRecord(body.tts);
  const freeTtsInput = asRecord(body.freeTts);
  const agentTts = tts.enabled === true;
  const freeTtsEnabled = freeTtsInput.enabled === true;
  const requestedVoice = optionalText(freeTtsInput.voice, 100);
  const freeVoice = requestedVoice && FREE_VOICES.has(requestedVoice) ? requestedVoice : DEFAULT_FREE_VOICE;
  const freeRate = sanitizeRate(freeTtsInput.rate);

  let bgmRef: string | undefined;
  const requestedBgm = optionalText(body.bgmPath, 2_000);
  if (requestedBgm) {
    if (!resolveComposeFileRef(requestedBgm, merchantId, projectId)) {
      throw new ComposeJobInputError("所选背景音乐不属于当前商家或项目");
    }
    bgmRef = requestedBgm;
  }
  const requestedMood = optionalText(body.bgmMood, 40)?.toLowerCase();
  const bgmMood = requestedMood && BGM_MOODS.has(requestedMood) ? requestedMood : undefined;

  const payload: ComposeJobPayloadV1 = {
    version: 1,
    merchantId,
    projectId,
    selectedScriptId: selected.id,
    project: {
      name: project.name,
      productName: project.productName,
      productPrice: project.productPrice,
      productCategory: project.productCategory,
      productImages,
    },
    shots: shotSnapshots,
    assets: assetSnapshots,
    options: {
      output: {
        resolution,
        aspectRatio,
        videoPreset: profile.videoPreset,
        crf: profile.crf,
      },
      agentTts,
      freeTts: {
        enabled: freeTtsEnabled,
        voice: freeVoice,
        ...(freeRate ? { rate: freeRate } : {}),
      },
      ...(bgmRef ? { bgmRef } : {}),
      freeBgm: body.freeBgm === true,
      ...(bgmMood ? { bgmMood } : {}),
      bgmDuck: body.bgmDuck === true,
      ...(optionalText(body.ctaText, 160) ? { ctaText: optionalText(body.ctaText, 160) } : {}),
      karaoke: body.karaoke === true,
      productCard: body.productCard === true,
    },
  };
  assertComposePayloadHasNoSecrets(payload);

  return {
    payload,
    resolution,
    aspectRatio,
    ttsEnabled: agentTts || freeTtsEnabled,
    ...(bgmRef ? { bgmPath: bgmRef } : {}),
  };
}

export function parseComposeJobPayload(value: unknown): ComposeJobPayloadV1 {
  assertComposePayloadHasNoSecrets(value);
  const payload = value as Partial<ComposeJobPayloadV1> | null;
  if (
    !payload ||
    payload.version !== 1 ||
    typeof payload.merchantId !== "string" ||
    typeof payload.projectId !== "string" ||
    typeof payload.selectedScriptId !== "string" ||
    !payload.project ||
    !Array.isArray(payload.project.productImages) ||
    !Array.isArray(payload.shots) ||
    payload.shots.length === 0 ||
    !Array.isArray(payload.assets) ||
    !payload.options ||
    !payload.options.output ||
    !["720p", "1080p"].includes(payload.options.output.resolution) ||
    !["9:16", "16:9", "1:1"].includes(payload.options.output.aspectRatio)
  ) {
    throw new Error("compose job payload 无效或版本不受支持");
  }
  return payload as ComposeJobPayloadV1;
}
