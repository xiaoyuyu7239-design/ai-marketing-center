import "server-only";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { AgentRuntimeConfig } from "@server/admin/agents";
import { runAgentOperation } from "@backend/core/agent/agent-strategy";
import { generateSpeech, type TTSConfig } from "@backend/core/media/tts";
import { generateSpeechFree } from "@backend/core/media/edge-tts";
import { readTtsCache, ttsCacheKey, writeTtsCache } from "@backend/core/media/tts-cache";
import {
  fetchFreeBgm,
  moodQueryForCategory,
  moodQueryForMood,
  type FreeBgmResult,
} from "@backend/core/media/free-bgm";
import { buildComplianceOverlays } from "@backend/core/publish/compliance-overlays";
import { assertMediaCreditsVerified, buildMediaCredits } from "@backend/core/publish/media-credits";
import type { MediaCredit } from "@backend/core/publish/media-credit-types";
import { getTTSProviderMeta, type TTSProvider } from "@backend/core/media/tts-presets";
import { getDataDir, getUploadsDir } from "@backend/shared/paths";
import { ffmpegBin, ffprobeBin } from "@backend/shared/ffmpeg-path";
import { isAudibleFromVolumedetect } from "@backend/video-composer/audio-probe";
import {
  chunkCaption,
  composeVideo,
  FADE_DURATION,
  resolveChineseFontFamily,
  type ClipInput,
  type ComposeConfig,
} from "@backend/video-composer/composer";
import { buildKaraokeAss } from "@backend/video-composer/karaoke";
import {
  parseComposeJobPayload,
  resolveComposeFileRef,
  type ComposeAssetSnapshot,
  type ComposeShotSnapshot,
} from "./compose-payload";
import {
  checkpointJobResult,
  JobLeaseLostError,
  markJobPaidTtsUsed,
  sanitizeJobError,
  type JobRecord,
} from "./repository";

const execFileAsync = promisify(execFile);
const MIN_REUSABLE_AUDIO_BYTES = 100;
export const MAX_PAID_TTS_VOICEOVER_SHOTS = 12;
export const PAID_TTS_WORKFLOW_BUDGET_MS = 180_000;

class PaidTtsWorkflowBudgetError extends Error {
  constructor() {
    super("付费配音工作流已达 180 秒总预算");
    this.name = "PaidTtsWorkflowBudgetError";
  }
}

interface FreeBgmCheckpoint {
  fileRef: string;
  author: string;
  license: string;
  sourceUrl: string;
  provider: string;
  licenseUrl?: string;
  attributionText?: string;
  requiresAttribution?: boolean;
}

export interface ComposeJobResult {
  outputPath: string;
  credits: MediaCredit[];
  paidTtsUsed: boolean;
}

interface TtsAudioProvenance {
  version: 1;
  source: "agent" | "free";
  textHash: string;
}

function normalizeAgentTTSProvider(provider: string | undefined): TTSProvider {
  switch ((provider || "").toLowerCase()) {
    case "volcengine":
    case "doubao-speech":
    case "doubao-tts":
      return "volcengine";
    case "atlas":
    case "atlas-cloud":
      return "atlas";
    case "falai":
    case "fal-ai":
      return "falai";
    case "minimax":
      return "minimax";
    default:
      return "openai";
  }
}

function agentConfigToTTSConfig(config: AgentRuntimeConfig): TTSConfig {
  const provider = normalizeAgentTTSProvider(config.provider);
  const meta = getTTSProviderMeta(provider);
  const apiKey = config.apiKey?.trim();
  const baseUrl = (config.baseUrl || meta.baseUrl).trim();
  const model = (config.model || meta.defaultModel).trim();
  const voice = (config.voice || meta.defaultVoice).trim();
  if (!apiKey) throw new Error("ttsAgent 未配置 API Key");
  if (!baseUrl || !model || !voice) throw new Error("ttsAgent 模型策略缺少 baseUrl、model 或 voice");
  return {
    provider,
    baseUrl,
    apiKey,
    model,
    voice,
    ...(config.speed != null ? { speed: config.speed } : {}),
    ...(config.groupId ? { groupId: config.groupId } : {}),
  };
}

function defaultMotion(shot: ComposeShotSnapshot): string {
  if (shot.motion) return shot.motion;
  switch (shot.type) {
    case "hook":
      return "zoom_in_slow";
    case "product_reveal":
      return "ken_burns";
    case "demo":
      return "pan_right";
    case "cta":
      return "static";
    default:
      return "ken_burns";
  }
}

async function videoHasAudio(filePath: string): Promise<boolean> {
  try {
    const streams = await execFileAsync(
      ffprobeBin(),
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", filePath],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    if (!streams.stdout.trim()) return false;
    const volume = await execFileAsync(
      ffmpegBin(),
      ["-i", filePath, "-af", "volumedetect", "-f", "null", "-"],
      { maxBuffer: 5 * 1024 * 1024 },
    );
    return isAudibleFromVolumedetect(volume.stderr);
  } catch {
    return false;
  }
}

async function probeDuration(filePath: string): Promise<number> {
  try {
    const result = await execFileAsync(
      ffprobeBin(),
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    return Number.parseFloat(result.stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

async function reusableAudio(filePath: string): Promise<boolean> {
  const info = await stat(filePath).catch(() => null);
  return Boolean(info?.isFile() && info.size >= MIN_REUSABLE_AUDIO_BYTES);
}

async function writeAudioAtomic(filePath: string, audio: Buffer): Promise<void> {
  const partPath = `${filePath}.${process.pid}.part`;
  await unlink(partPath).catch(() => undefined);
  try {
    await writeFile(partPath, audio, { mode: 0o600 });
    await rename(partPath, filePath);
  } catch (error) {
    await unlink(partPath).catch(() => undefined);
    throw error;
  }
}

function ttsProvenancePath(filePath: string): string {
  return `${filePath}.source.json`;
}

function ttsTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function reusableAudioSource(
  filePath: string,
  text: string,
): Promise<TtsAudioProvenance["source"] | "unknown" | null> {
  if (!(await reusableAudio(filePath))) return null;
  try {
    const parsed = JSON.parse(await readFile(ttsProvenancePath(filePath), "utf8")) as Partial<TtsAudioProvenance>;
    if (
      parsed.version === 1 &&
      (parsed.source === "agent" || parsed.source === "free") &&
      parsed.textHash === ttsTextHash(text)
    ) return parsed.source;
  } catch {
    // 旧版本/异常中断遗留音频没有可信来源：可以复用，但绝不能据此认定付费能力已使用。
  }
  return "unknown";
}

async function writeAudioWithProvenance(
  filePath: string,
  audio: Buffer,
  source: TtsAudioProvenance["source"],
  text: string,
): Promise<void> {
  const provenancePath = ttsProvenancePath(filePath);
  const provenancePart = `${provenancePath}.${process.pid}.part`;
  await unlink(filePath).catch(() => undefined);
  await unlink(provenancePart).catch(() => undefined);
  try {
    const provenance: TtsAudioProvenance = { version: 1, source, textHash: ttsTextHash(text) };
    // 先落 provenance、再落音频：崩溃在两者之间时没有可复用音频；不会把未知旧音频误算成付费产物。
    await writeFile(provenancePart, JSON.stringify(provenance), { mode: 0o600 });
    await rename(provenancePart, provenancePath);
    await writeAudioAtomic(filePath, audio);
  } catch (error) {
    await unlink(provenancePart).catch(() => undefined);
    if (!(await reusableAudio(filePath))) await unlink(provenancePath).catch(() => undefined);
    throw error;
  }
}

function localPathToFileRef(localPath: string, projectId: string): string | null {
  const uploadsRoot = getUploadsDir();
  const rel = relative(uploadsRoot, localPath);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  const segments = rel.split(sep);
  if (segments[0] !== projectId || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return `/api/files/${segments.map(encodeURIComponent).join("/")}`;
}

function parseFreeBgmCheckpoint(value: unknown): FreeBgmCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Partial<FreeBgmCheckpoint>;
  if (
    typeof item.fileRef !== "string" ||
    typeof item.author !== "string" ||
    typeof item.license !== "string" ||
    typeof item.sourceUrl !== "string" ||
    typeof item.provider !== "string"
  ) {
    return null;
  }
  return item as FreeBgmCheckpoint;
}

function checkpointToFreeBgm(
  checkpoint: FreeBgmCheckpoint,
  merchantId: string,
  projectId: string,
): FreeBgmResult | null {
  const localPath = resolveComposeFileRef(checkpoint.fileRef, merchantId, projectId);
  return localPath ? { ...checkpoint, localPath } : null;
}

async function resolveFreeBgm(
  job: JobRecord,
  workerId: string,
  leaseToken: string,
  merchantId: string,
  projectId: string,
  query: string,
): Promise<FreeBgmResult | null> {
  const existing = parseFreeBgmCheckpoint((job.result as Record<string, unknown> | null)?.freeBgm);
  if (existing) {
    const restored = checkpointToFreeBgm(existing, merchantId, projectId);
    if (restored) return restored;
  }

  const fetched = await fetchFreeBgm(projectId, query);
  if (!fetched) return null;
  const fileRef = localPathToFileRef(fetched.localPath, projectId);
  if (!fileRef) throw new Error("免费 BGM 下载路径不在当前项目素材目录内");
  const checkpoint: FreeBgmCheckpoint = {
    fileRef,
    author: fetched.author,
    license: fetched.license,
    sourceUrl: fetched.sourceUrl,
    provider: fetched.provider,
    ...(fetched.licenseUrl ? { licenseUrl: fetched.licenseUrl } : {}),
    ...(fetched.attributionText ? { attributionText: fetched.attributionText } : {}),
    ...(typeof fetched.requiresAttribution === "boolean"
      ? { requiresAttribution: fetched.requiresAttribution }
      : {}),
  };
  const saved = checkpointJobResult(job.id, workerId, leaseToken, {
    ...(job.result || {}),
    freeBgm: checkpoint,
  });
  if (!saved) throw new JobLeaseLostError();
  return fetched;
}

function assertEveryUsedStockHasCredit(
  usedAssets: readonly ComposeAssetSnapshot[],
  freeBgm: FreeBgmResult | null,
  credits: readonly MediaCredit[],
): void {
  const missingVisual = usedAssets.some(
    (asset) => asset.type === "stock_footage" && (!asset.sourceUrl?.trim() || !asset.license?.trim()),
  );
  const missingBgm = Boolean(freeBgm && (!freeBgm.sourceUrl?.trim() || !freeBgm.license?.trim()));
  if (missingVisual || missingBgm) {
    throw new Error("实际使用的第三方素材缺少来源或许可，请更换素材或补充可核验许可后再合成");
  }
  assertMediaCreditsVerified(credits);
}

/**
 * 先对冻结快照中本次真正会选中的 stock 画面做许可预检。
 * 这个 gate 必须早于任何 TTS/免费 BGM 网络请求，避免明知不能合成仍消耗外部能力。
 */
function assertSelectedStockSourcesBeforeNetwork(
  shots: readonly ComposeShotSnapshot[],
  assetByShot: ReadonlyMap<number, ComposeAssetSnapshot>,
  merchantId: string,
  projectId: string,
): void {
  for (const shot of shots) {
    const asset = assetByShot.get(shot.shotId);
    if (
      asset?.type === "stock_footage" &&
      resolveComposeFileRef(asset.fileRef, merchantId, projectId) &&
      (!asset.sourceUrl?.trim() || !asset.license?.trim())
    ) {
      throw new Error("实际选中的第三方素材缺少来源或许可，请更换素材或补充可核验许可后再合成");
    }
  }
}

async function runWithinPaidTtsBudget<T>(
  remainingMs: number,
  operation: () => Promise<T>,
): Promise<T> {
  if (remainingMs <= 0) throw new PaidTtsWorkflowBudgetError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new PaidTtsWorkflowBudgetError()), remainingMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runComposeJob(
  job: JobRecord,
  workerId: string,
  leaseToken: string,
): Promise<ComposeJobResult> {
  const payload = parseComposeJobPayload(job.payload);
  if (
    job.type !== "compose" ||
    !job.compositionId ||
    job.projectId !== payload.projectId ||
    job.merchantId !== payload.merchantId ||
    job.leaseToken !== leaseToken
  ) {
    throw new Error("compose job 归属、类型或租约快照不一致");
  }

  const { merchantId, projectId } = payload;
  const compositionId = job.compositionId;
  const useAgentTts = payload.options.agentTts;
  const useFreeTts = payload.options.freeTts.enabled;
  let paidTtsUsed = job.paidTtsUsed;
  const assetByShot = new Map(payload.assets.map((asset) => [asset.shotId, asset]));
  assertSelectedStockSourcesBeforeNetwork(payload.shots, assetByShot, merchantId, projectId);

  const paidTtsDeadline = Date.now() + PAID_TTS_WORKFLOW_BUDGET_MS;
  let paidTtsRequests = 0;
  let paidTtsLimitLogged = false;
  const ttsDir = join(getDataDir(), "uploads", projectId, "tts", compositionId);
  if (useAgentTts || useFreeTts) await mkdir(ttsDir, { recursive: true });

  async function buildVoiceover(
    shotId: number,
    text: string,
  ): Promise<{ filePath: string; paid: boolean } | undefined> {
    if (!text || (!useAgentTts && !useFreeTts)) return undefined;
    const filePath = join(ttsDir, `shot-${shotId}.mp3`);
    const reusableSource = await reusableAudioSource(filePath, text);
    if (reusableSource) {
      const paid = reusableSource === "agent";
      if (paid) {
        if (!markJobPaidTtsUsed(job.id, workerId, leaseToken)) throw new JobLeaseLostError();
        paidTtsUsed = true;
      }
      return { filePath, paid };
    }

    if (useAgentTts) {
      const remainingPaidBudget = paidTtsDeadline - Date.now();
      if (
        paidTtsRequests < MAX_PAID_TTS_VOICEOVER_SHOTS &&
        remainingPaidBudget > 0
      ) {
        try {
          paidTtsRequests += 1;
          // compose 是一个 workflow：用户额度由 HTTP 入队边界按 Idempotency-Key 只预留 1 次。
          // worker 内逐镜 TTS 是该 workflow 的子调用，若再 runMetered 会每镜重复扣额度，crash retry 还会翻倍。
          const audio = await runWithinPaidTtsBudget(
            remainingPaidBudget,
            () => runAgentOperation(
              "ttsAgent",
              `${projectId}:${compositionId}:tts:${shotId}`,
              async (config) => generateSpeech(text, agentConfigToTTSConfig(config)),
            ),
          );
          await writeAudioWithProvenance(filePath, audio, "agent", text);
          if (!markJobPaidTtsUsed(job.id, workerId, leaseToken)) throw new JobLeaseLostError();
          paidTtsUsed = true;
          return { filePath, paid: true };
        } catch (error) {
          if (error instanceof JobLeaseLostError) throw error;
          const detail = sanitizeJobError(error);
          if (!useFreeTts) {
            console.warn(`分镜 ${shotId} 后台配音生成失败（已跳过）: ${detail}`);
            return undefined;
          }
          console.warn(`分镜 ${shotId} 后台配音失败，改用免费配音兜底: ${detail}`);
        }
      } else if (!paidTtsLimitLogged) {
        paidTtsLimitLogged = true;
        console.warn(
          `付费配音已达 ${MAX_PAID_TTS_VOICEOVER_SHOTS} 镜或 ${PAID_TTS_WORKFLOW_BUDGET_MS / 1_000} 秒总预算，其余旁白改用免费配音或跳过`,
        );
      }
    }

    if (!useFreeTts) return undefined;
    try {
      const freeCacheKey = ttsCacheKey({
        provider: "edge-free",
        voice: payload.options.freeTts.voice,
        rate: payload.options.freeTts.rate,
        text,
      });
      const cached = await readTtsCache(freeCacheKey);
      const audio =
        cached ??
        (await generateSpeechFree(text, {
          voice: payload.options.freeTts.voice,
          rate: payload.options.freeTts.rate,
        }));
      if (!cached) await writeTtsCache(freeCacheKey, audio);
      await writeAudioWithProvenance(filePath, audio, "free", text);
      return { filePath, paid: false };
    } catch (error) {
      console.warn(`分镜 ${shotId} 免费配音生成失败（已跳过）: ${sanitizeJobError(error)}`);
      return undefined;
    }
  }

  const rendered: { shot: ComposeShotSnapshot; clip: ClipInput; duration: number }[] = [];
  const usedCreditAssets: ComposeAssetSnapshot[] = [];
  for (const shot of payload.shots) {
    const selectedAsset = assetByShot.get(shot.shotId);
    const fileRef = selectedAsset?.fileRef ?? payload.project.productImages[0];
    const localPath = resolveComposeFileRef(fileRef, merchantId, projectId);
    if (!localPath) continue;
    if (selectedAsset) usedCreditAssets.push(selectedAsset);

    const isVideo = /\.(mp4|webm|mov|m4v|ogv|ogg|mkv|avi)$/i.test(localPath);
    const nativeAudio = isVideo ? await videoHasAudio(localPath) : false;
    const voiceover =
      shot.voiceover && !nativeAudio ? await buildVoiceover(shot.shotId, shot.voiceover) : undefined;
    const audioPath = voiceover?.filePath;
    if (voiceover?.paid) paidTtsUsed = true;
    let duration = shot.duration || 3;
    if (audioPath) {
      const ttsDuration = await probeDuration(audioPath);
      if (ttsDuration > 0) duration = Math.min(Math.max(ttsDuration + 0.4, 1.5), 20);
    }
    const clip: ClipInput = {
      type: isVideo ? "video" : "image",
      filePath: localPath,
      duration,
      transition: shot.transition || "ai_start_end",
      ...(isVideo ? { hasAudio: nativeAudio } : { motion: defaultMotion(shot) }),
      ...(audioPath ? { audioPath } : {}),
    };
    rendered.push({ shot, clip, duration });
  }
  if (rendered.length === 0) throw new Error("没有可用素材，请重新上传或生成素材后再试");

  let timeline = 0;
  const subtitleTexts: { text: string; startTime: number; endTime: number }[] = [];
  const karaokeLines: { text: string; startTime: number; endTime: number }[] = [];
  const overlays: {
    text: string;
    style: "title" | "highlight" | "price" | "disclosure";
    startTime: number;
    endTime: number;
  }[] = [];
  rendered.forEach((item, index) => {
    if (index > 0 && item.clip.transition === "ffmpeg_fade") timeline -= FADE_DURATION;
    const start = timeline;
    timeline += item.duration;
    const end = timeline;
    if (item.shot.voiceover) {
      subtitleTexts.push(...chunkCaption(item.shot.voiceover, start, end));
      karaokeLines.push({ text: item.shot.voiceover, startTime: start, endTime: end });
    }
    const overlay = item.shot.textOverlay;
    if (overlay && overlay.style !== "subtitle" && overlay.text) {
      overlays.push({
        text: overlay.text,
        style: overlay.style as "title" | "highlight" | "price",
        startTime: start,
        endTime: end,
      });
    }
  });
  overlays.push(
    ...buildComplianceOverlays(
      { aiDisclosure: true, ctaText: payload.options.ctaText },
      timeline,
    ),
  );

  let bgmLocal = resolveComposeFileRef(payload.options.bgmRef, merchantId, projectId);
  let freeBgmCredit: FreeBgmResult | null = null;
  if (!bgmLocal && payload.options.freeBgm) {
    const query = payload.options.bgmMood
      ? moodQueryForMood(payload.options.bgmMood)
      : moodQueryForCategory(payload.project.productCategory);
    freeBgmCredit = await resolveFreeBgm(
      job,
      workerId,
      leaseToken,
      merchantId,
      projectId,
      query,
    );
    if (freeBgmCredit) {
      bgmLocal = freeBgmCredit.localPath;
      console.info(
        `[bgm] 免费配乐: ${freeBgmCredit.author} · ${freeBgmCredit.license} · ${freeBgmCredit.sourceUrl}`,
      );
    }
  }

  const credits = buildMediaCredits({ assets: usedCreditAssets, bgm: freeBgmCredit });
  assertEveryUsedStockHasCredit(usedCreditAssets, freeBgmCredit, credits);

  const config: ComposeConfig = {
    projectId,
    compositionId,
    clips: rendered.map((item) => item.clip),
    output: {
      ...payload.options.output,
      ...(bgmLocal
        ? { bgmPath: bgmLocal, bgmVolume: 0.18, bgmDuck: payload.options.bgmDuck }
        : {}),
    },
    subtitle: subtitleTexts.length > 0 ? { texts: subtitleTexts, position: "bottom" } : undefined,
    overlays,
  };

  if (payload.options.karaoke && karaokeLines.length > 0) {
    const ass = buildKaraokeAss(karaokeLines, { fontName: resolveChineseFontFamily() });
    const assDir = join(getDataDir(), "output", projectId);
    await mkdir(assDir, { recursive: true });
    const assPath = join(assDir, `karaoke_${compositionId}.ass`);
    const assPart = `${assPath}.${process.pid}.part`;
    await writeFile(assPart, ass, "utf8");
    await rename(assPart, assPath);
    config.subtitle = { texts: [], karaokeAssPath: assPath };
  }

  if (payload.options.productCard) {
    const cardImage = resolveComposeFileRef(
      payload.project.productImages[0],
      merchantId,
      projectId,
    );
    if (cardImage) {
      config.productCard = {
        imagePath: cardImage,
        name: payload.project.productName || payload.project.name || undefined,
        price: payload.project.productPrice || undefined,
      };
    }
  }

  const outputPath = await composeVideo(config);
  if (!outputPath || !existsSync(outputPath)) throw new Error("FFmpeg 未生成完整成片文件");
  return { outputPath, credits, paidTtsUsed };
}
