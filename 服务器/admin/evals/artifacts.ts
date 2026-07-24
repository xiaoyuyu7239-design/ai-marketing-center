import "server-only";

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { ffprobeBin } from "@backend/shared/ffmpeg-path";
import { getDataDir } from "@backend/shared/paths";
import {
  safeFetchPinned,
  type SafeFetchPolicy,
} from "@backend/shared/ssrf-guard";
import type {
  AgentEvalArtifactMetadata,
  AgentEvalRecord,
} from "@server/admin/agents/types";

export type GoldenArtifactMediaType = "image" | "video" | "audio";
export type StoredGoldenArtifact = AgentEvalArtifactMetadata;

export interface ResolvedGoldenArtifact extends StoredGoldenArtifact {
  filePath: string;
}

type SafeFetcher = (
  url: string,
  init?: RequestInit,
  maxRedirects?: number,
  policy?: SafeFetchPolicy,
) => Promise<Response>;

export interface GoldenArtifactStoreDependencies {
  fetcher?: SafeFetcher;
}

const ARTIFACT_FILENAME = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(png|jpg|webp|mp4|webm|mp3)$/;
const EVAL_ID = /^[A-Za-z0-9_-]{8,120}$/;
const ARTIFACT_ROUTE_PREFIX = "/api/admin/model-evals/artifacts";
const MAX_ARTIFACTS_PER_RECORD = 4;
const STORAGE_LOCK = ".storage.lock";
const EVALUATION_LOCK = ".evaluation.lock";
const LOCK_STALE_MS = 30 * 60_000;
const PART_STALE_MS = 10 * 60_000;
const ORPHAN_GRACE_MS = 60 * 60_000;
const execFileAsync = promisify(execFile);

function envBytes(name: string, fallback: number, min: number, max: number) {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(raw)));
}

function perItemLimit(mediaType: GoldenArtifactMediaType) {
  if (mediaType === "image") {
    return envBytes("HUIMAI_EVAL_MAX_IMAGE_BYTES", 20 * 1024 * 1024, 1024, 50 * 1024 * 1024);
  }
  if (mediaType === "audio") {
    return envBytes("HUIMAI_EVAL_MAX_AUDIO_BYTES", 20 * 1024 * 1024, 1024, 50 * 1024 * 1024);
  }
  return envBytes("HUIMAI_EVAL_MAX_VIDEO_BYTES", 200 * 1024 * 1024, 1024, 500 * 1024 * 1024);
}

function perRecordLimit() {
  return envBytes("HUIMAI_EVAL_MAX_RECORD_BYTES", 250 * 1024 * 1024, 1024, 600 * 1024 * 1024);
}

function totalStorageLimit() {
  return envBytes("HUIMAI_EVAL_STORAGE_MAX_BYTES", 2 * 1024 * 1024 * 1024, 1024, 20 * 1024 * 1024 * 1024);
}

function assertEvalId(evalId: string) {
  if (!EVAL_ID.test(evalId)) throw new Error("评测记录 ID 不合法");
}

async function artifactRoot() {
  await mkdir(getDataDir(), { recursive: true, mode: 0o700 });
  const dataRoot = await realpath(getDataDir());
  const root = join(/* turbopackIgnore: true */ dataRoot, "admin-evals");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("评测产物目录必须是非符号链接目录");
  }
  const resolved = await realpath(root);
  if (resolved !== root) throw new Error("评测产物目录解析异常");
  return root;
}

function detectArtifact(prefix: Buffer): Pick<StoredGoldenArtifact, "mediaType" | "mimeType"> | null {
  if (prefix.length >= 8 && prefix.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mediaType: "image", mimeType: "image/png" };
  }
  if (prefix.length >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff) {
    return { mediaType: "image", mimeType: "image/jpeg" };
  }
  if (prefix.length >= 12 && prefix.subarray(0, 4).toString("ascii") === "RIFF" && prefix.subarray(8, 12).toString("ascii") === "WEBP") {
    return { mediaType: "image", mimeType: "image/webp" };
  }
  if (prefix.length >= 12 && prefix.subarray(4, 8).toString("ascii") === "ftyp") {
    return { mediaType: "video", mimeType: "video/mp4" };
  }
  if (prefix.length >= 4 && prefix.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { mediaType: "video", mimeType: "video/webm" };
  }
  const hasId3 = prefix.length >= 3 && prefix.subarray(0, 3).toString("ascii") === "ID3";
  const hasMp3Frame = prefix.length >= 2 && prefix[0] === 0xff && (prefix[1] & 0xe0) === 0xe0;
  if (hasId3 || hasMp3Frame) return { mediaType: "audio", mimeType: "audio/mpeg" };
  return null;
}

function extensionFor(mimeType: string) {
  const extensions: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
  };
  const extension = extensions[mimeType];
  if (!extension) throw new Error("评测产物 MIME 不受支持");
  return extension;
}

function assertDeclaredContentType(response: Response, actualMediaType: GoldenArtifactMediaType) {
  const declared = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!declared || declared === "application/octet-stream" || declared === "binary/octet-stream") return;
  const declaredMediaType = declared.startsWith("image/")
    ? "image"
    : declared.startsWith("video/")
      ? "video"
      : declared.startsWith("audio/")
        ? "audio"
        : null;
  if (declaredMediaType !== actualMediaType) throw new Error("远程产物 Content-Type 与真实内容不一致");
}

function inspectPrefix(prefix: Buffer, sizeBytes: number, expectedMediaType: GoldenArtifactMediaType) {
  if (!sizeBytes) throw new Error("评测产物为空");
  if (sizeBytes > perItemLimit(expectedMediaType)) throw new Error("评测产物超过单项体积限制");
  const detected = detectArtifact(prefix.subarray(0, 32));
  if (!detected || detected.mediaType !== expectedMediaType) {
    throw new Error(`评测产物不是有效的 ${expectedMediaType} 文件`);
  }
  return detected;
}

interface ProbeJson {
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    duration?: string;
  }>;
  format?: { format_name?: string; duration?: string };
}

function positiveNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** ffprobe 必须真正解析完整容器/图像，magic bytes 不能代替该校验。 */
async function probeArtifact(filePath: string, expectedMediaType: GoldenArtifactMediaType) {
  let parsed: ProbeJson;
  try {
    const { stdout } = await execFileAsync(ffprobeBin(), [
      "-v", "error",
      "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height,duration",
      "-of", "json",
      filePath,
    ], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    parsed = JSON.parse(stdout) as ProbeJson;
  } catch {
    throw new Error(`评测产物无法被 ffprobe 完整解析为 ${expectedMediaType}`);
  }

  const expectedStreamType = expectedMediaType === "audio" ? "audio" : "video";
  const stream = parsed.streams?.find((item) => item.codec_type === expectedStreamType);
  if (!stream?.codec_name) throw new Error(`评测产物缺少 ${expectedStreamType} 码流`);
  const width = positiveNumber(stream.width);
  const height = positiveNumber(stream.height);
  if ((expectedMediaType === "image" || expectedMediaType === "video") && (!width || !height)) {
    throw new Error("评测图像/视频缺少有效尺寸");
  }
  const durationSeconds = positiveNumber(stream.duration) ?? positiveNumber(parsed.format?.duration);
  if ((expectedMediaType === "audio" || expectedMediaType === "video") && !durationSeconds) {
    throw new Error("评测音视频缺少有效时长");
  }
  const formatName = parsed.format?.format_name?.trim() || "unknown";
  return {
    formatName,
    codecName: stream.codec_name,
    ...(width ? { width } : {}),
    ...(height ? { height } : {}),
    ...(durationSeconds ? { durationSeconds } : {}),
  };
}

async function sha256File(filePath: string) {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function currentStorageBytes(root: string) {
  let total = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    // 崩溃遗留的 .part 也必须计入总额，否则可绕过存储上限。
    if (!entry.isFile()) continue;
    total += (await stat(join(/* turbopackIgnore: true */ root, entry.name))).size;
  }
  return total;
}

async function acquireFileLock(root: string, filename: string, waitMs: number) {
  const lockPath = join(/* turbopackIgnore: true */ root, filename);
  const token = `${process.pid}.${Date.now()}.${randomUUID()}`;
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(token, "utf8");
      await handle.sync();
      await handle.close();
      return async () => {
        const current = await readFile(lockPath, "utf8").catch(() => "");
        if (current === token) await unlink(lockPath).catch(() => undefined);
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST") throw error;
      const lockStat = await lstat(lockPath).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) throw new GoldenEvaluationBusyError();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

export class GoldenEvaluationBusyError extends Error {
  constructor() {
    super("已有媒体 Golden 评测正在执行，未发起新的付费请求");
    this.name = "GoldenEvaluationBusyError";
  }
}

/** 跨进程互斥：路由必须在任一付费请求前获取。 */
export async function acquireGoldenEvaluationLease() {
  const root = await artifactRoot();
  return acquireFileLock(root, EVALUATION_LOCK, 0);
}

async function withStorageLock<T>(operation: (root: string) => Promise<T>): Promise<T> {
  const root = await artifactRoot();
  const release = await acquireFileLock(root, STORAGE_LOCK, 15_000);
  try {
    return await operation(root);
  } finally {
    await release();
  }
}

function artifactUrl(evalId: string, filename: string) {
  return `${ARTIFACT_ROUTE_PREFIX}/${evalId}/${filename}`;
}

function configuredArtifactHosts() {
  return (process.env.HUIMAI_EVAL_ARTIFACT_HOSTS || "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostnameAllowed(hostname: string, entries: readonly string[]) {
  const normalized = hostname.toLowerCase();
  return entries.some((entry) => entry.startsWith("*.")
    ? normalized.endsWith(entry.slice(1)) && normalized !== entry.slice(2)
    : normalized === entry);
}

function artifactFetchPolicy(parsed: URL): SafeFetchPolicy {
  const hosts = configuredArtifactHosts();
  if (process.env.NODE_ENV === "production" && hosts.length === 0) {
    throw new Error("生产环境必须配置 HUIMAI_EVAL_ARTIFACT_HOSTS，未发起产物下载");
  }
  if (hosts.length && !hostnameAllowed(parsed.hostname, hosts)) {
    throw new Error(`评测产物主机未在白名单：${parsed.hostname}`);
  }
  return {
    allowedProtocols: ["https:"],
    allowedPorts: ["", "443"],
    ...(hosts.length ? { allowedHosts: hosts } : {}),
  };
}

async function finalizePart(
  root: string,
  evalId: string,
  expectedMediaType: GoldenArtifactMediaType,
  partPath: string,
  prefix: Buffer,
  sizeBytes: number,
  sha256: string,
) {
  const detected = inspectPrefix(prefix, sizeBytes, expectedMediaType);
  const probe = await probeArtifact(partPath, expectedMediaType);
  const filename = `${randomUUID()}.${extensionFor(detected.mimeType)}`;
  const finalPath = join(/* turbopackIgnore: true */ root, filename);
  await rename(partPath, finalPath);
  return {
    filename,
    url: artifactUrl(evalId, filename),
    mediaType: detected.mediaType,
    mimeType: detected.mimeType,
    sizeBytes,
    sha256,
    probe,
  } satisfies StoredGoldenArtifact;
}

async function persistBufferLocked(
  root: string,
  evalId: string,
  expectedMediaType: GoldenArtifactMediaType,
  buffer: Buffer,
) {
  const detected = inspectPrefix(buffer.subarray(0, 32), buffer.byteLength, expectedMediaType);
  if ((await currentStorageBytes(root)) + buffer.byteLength > totalStorageLimit()) {
    throw new Error("评测产物总存储额度已满，请先删除历史评测");
  }
  const partPath = join(/* turbopackIgnore: true */ root, `.${randomUUID()}.${extensionFor(detected.mimeType)}.part`);
  const handle = await open(partPath, "wx", 0o600);
  try {
    await handle.writeFile(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    return await finalizePart(
      root,
      evalId,
      expectedMediaType,
      partPath,
      buffer.subarray(0, 32),
      buffer.byteLength,
      createHash("sha256").update(buffer).digest("hex"),
    );
  } catch (error) {
    await unlink(partPath).catch(() => undefined);
    throw error;
  }
}

export async function storeGoldenRemoteArtifacts(
  evalId: string,
  expectedMediaType: "image" | "video",
  urls: readonly string[],
  dependencies: GoldenArtifactStoreDependencies = {},
) {
  assertEvalId(evalId);
  if (!urls.length || urls.length > MAX_ARTIFACTS_PER_RECORD) {
    throw new Error(`远程评测产物数量必须为 1-${MAX_ARTIFACTS_PER_RECORD}`);
  }
  const parsedUrls = urls.map((rawUrl) => {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new Error("评测产物 URL 不合法");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443")) {
      throw new Error("远程评测产物只允许无凭据 HTTPS 443 URL");
    }
    return { parsed, policy: artifactFetchPolicy(parsed) };
  });
  const fetcher = dependencies.fetcher ?? safeFetchPinned;

  return withStorageLock(async (root) => {
    const createdPaths: string[] = [];
    const saved: StoredGoldenArtifact[] = [];
    let recordBytes = 0;
    let occupiedBytes = await currentStorageBytes(root);
    try {
      for (const { parsed, policy } of parsedUrls) {
        const response = await fetcher(
          parsed.href,
          { signal: AbortSignal.timeout(30_000) },
          4,
          policy,
        );
        if (!response.ok) throw new Error(`评测产物下载失败（${response.status}）`);
        const declaredLength = Number(response.headers.get("content-length") || 0);
        if (Number.isFinite(declaredLength) && declaredLength > perItemLimit(expectedMediaType)) {
          await response.body?.cancel("产物超过单项限制");
          throw new Error("评测产物超过单项体积限制");
        }
        if (!response.body) throw new Error("评测产物响应为空");

        const partPath = join(/* turbopackIgnore: true */ root, `.${randomUUID()}.download.part`);
        const handle = await open(partPath, "wx", 0o600);
        createdPaths.push(partPath);
        const reader = response.body.getReader();
        const hash = createHash("sha256");
        const prefixChunks: Buffer[] = [];
        let prefixBytes = 0;
        let itemBytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            itemBytes += value.byteLength;
            if (itemBytes > perItemLimit(expectedMediaType)) {
              await reader.cancel("产物超过单项限制");
              throw new Error("评测产物超过单项体积限制");
            }
            if (recordBytes + itemBytes > perRecordLimit()) {
              await reader.cancel("产物超过单条限制");
              throw new Error("评测产物超过单条总体积限制");
            }
            if (occupiedBytes + itemBytes > totalStorageLimit()) {
              await reader.cancel("产物超过总存储限制");
              throw new Error("评测产物总存储额度已满，请先删除历史评测");
            }
            const chunk = Buffer.from(value);
            if (prefixBytes < 32) {
              const prefixChunk = chunk.subarray(0, Math.min(chunk.byteLength, 32 - prefixBytes));
              prefixChunks.push(prefixChunk);
              prefixBytes += prefixChunk.byteLength;
            }
            hash.update(chunk);
            await handle.writeFile(chunk);
          }
          await handle.sync();
        } finally {
          reader.releaseLock();
          await handle.close();
        }
        const prefix = Buffer.concat(prefixChunks, prefixBytes);
        const detected = inspectPrefix(prefix, itemBytes, expectedMediaType);
        assertDeclaredContentType(response, detected.mediaType);
        const artifact = await finalizePart(
          root,
          evalId,
          expectedMediaType,
          partPath,
          prefix,
          itemBytes,
          hash.digest("hex"),
        );
        createdPaths.push(join(/* turbopackIgnore: true */ root, artifact.filename));
        saved.push(artifact);
        recordBytes += itemBytes;
        occupiedBytes += itemBytes;
      }
      return saved;
    } catch (error) {
      await Promise.all(createdPaths.map((path) => unlink(path).catch(() => undefined)));
      throw error;
    }
  });
}

export async function storeGoldenAudioArtifact(evalId: string, audio: Buffer) {
  assertEvalId(evalId);
  return withStorageLock(async (root) => [await persistBufferLocked(root, evalId, "audio", audio)]);
}

function parseArtifactUrl(evalId: string, url: string) {
  assertEvalId(evalId);
  const escapedEvalId = evalId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${ARTIFACT_ROUTE_PREFIX}/${escapedEvalId}/([^/?#]+)$`).exec(url);
  if (!match || !ARTIFACT_FILENAME.test(match[1])) throw new Error("评测产物 URL 与记录不匹配");
  return match[1];
}

async function locateArtifact(evalId: string, url: string, expectedMediaType: GoldenArtifactMediaType) {
  const filename = parseArtifactUrl(evalId, url);
  const root = await artifactRoot();
  const filePath = join(/* turbopackIgnore: true */ root, filename);
  const fileStat = await lstat(filePath).catch(() => null);
  if (!fileStat || !fileStat.isFile() || fileStat.isSymbolicLink()) throw new Error("评测产物不存在");
  if (fileStat.size <= 0 || fileStat.size > perItemLimit(expectedMediaType)) throw new Error("评测产物体积异常");
  const handle = await open(filePath, "r");
  const prefix = Buffer.alloc(32);
  let bytesRead = 0;
  try {
    ({ bytesRead } = await handle.read(prefix, 0, prefix.byteLength, 0));
  } finally {
    await handle.close();
  }
  const detected = inspectPrefix(prefix.subarray(0, bytesRead), fileStat.size, expectedMediaType);
  return { filename, root, filePath, fileStat, detected };
}

/** 给媒体路由的轻量解析；评分/晋级必须使用下面的深度校验。 */
export async function resolveGoldenArtifactForServing(
  evalId: string,
  url: string,
  expectedMediaType: GoldenArtifactMediaType,
) {
  const located = await locateArtifact(evalId, url, expectedMediaType);
  return {
    filename: located.filename,
    url,
    filePath: located.filePath,
    mediaType: located.detected.mediaType,
    mimeType: located.detected.mimeType,
    sizeBytes: located.fileStat.size,
  };
}

export async function resolveGoldenArtifact(
  evalId: string,
  url: string,
  expectedMediaType: GoldenArtifactMediaType,
  expected?: AgentEvalArtifactMetadata,
): Promise<ResolvedGoldenArtifact> {
  const located = await locateArtifact(evalId, url, expectedMediaType);
  const [sha256, probe] = await Promise.all([
    sha256File(located.filePath),
    probeArtifact(located.filePath, expectedMediaType),
  ]);
  const resolved: ResolvedGoldenArtifact = {
    filename: located.filename,
    url,
    filePath: located.filePath,
    mediaType: located.detected.mediaType,
    mimeType: located.detected.mimeType,
    sizeBytes: located.fileStat.size,
    sha256,
    probe,
  };
  if (expected) {
    if (expected.url !== resolved.url
      || expected.filename !== resolved.filename
      || expected.mediaType !== resolved.mediaType
      || expected.mimeType !== resolved.mimeType
      || expected.sizeBytes !== resolved.sizeBytes
      || expected.sha256 !== resolved.sha256
      || JSON.stringify(expected.probe) !== JSON.stringify(resolved.probe)) {
      throw new Error("评测产物与入库哈希/探测元数据不一致");
    }
  }
  return resolved;
}

export async function verifyGoldenArtifacts(
  evalId: string,
  urls: readonly string[],
  expectedMediaType: GoldenArtifactMediaType,
  metadata: readonly AgentEvalArtifactMetadata[] = [],
) {
  if (!urls.length || urls.length > MAX_ARTIFACTS_PER_RECORD) throw new Error("没有可审核的真实评测产物");
  if (new Set(urls).size !== urls.length || metadata.length !== urls.length) {
    throw new Error("评测产物 URL/元数据数量不一致或重复");
  }
  return Promise.all(urls.map((url) => {
    const expected = metadata.find((item) => item.url === url);
    if (!expected) throw new Error("评测产物缺少入库哈希");
    return resolveGoldenArtifact(evalId, url, expectedMediaType, expected);
  }));
}

export async function deleteGoldenArtifacts(evalId: string, urls: readonly string[]) {
  if (!urls.length) return;
  await withStorageLock(async (root) => {
    await Promise.all(urls.map(async (url) => {
      try {
        const filename = parseArtifactUrl(evalId, url);
        await unlink(join(/* turbopackIgnore: true */ root, filename));
      } catch {
        // 只清理严格属于本记录的随机文件，异常时宁可留下孤儿也不删其它路径。
      }
    }));
  });
}

function referencedArtifactFilenames(records: readonly Pick<AgentEvalRecord, "id" | "artifactUrls">[]) {
  const referenced = new Set<string>();
  for (const record of records) {
    for (const url of record.artifactUrls ?? []) {
      try {
        referenced.add(parseArtifactUrl(record.id, url));
      } catch {
        // 损坏记录不能将任意路径加入保留集。
      }
    }
  }
  return referenced;
}

/** 删除过期 part 与已无记录引用的落盘孤儿，保留宽限防止误删刚生成的产物。 */
export async function cleanupGoldenArtifactOrphans(
  records: readonly Pick<AgentEvalRecord, "id" | "artifactUrls">[],
  options: { now?: number; orphanGraceMs?: number; partStaleMs?: number } = {},
) {
  return withStorageLock(async (root) => {
    const now = options.now ?? Date.now();
    const referenced = referencedArtifactFilenames(records);
    let deleted = 0;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === STORAGE_LOCK || entry.name === EVALUATION_LOCK) continue;
      const path = join(/* turbopackIgnore: true */ root, entry.name);
      const fileStat = await lstat(path).catch(() => null);
      if (!fileStat || fileStat.isSymbolicLink()) continue;
      const age = now - fileStat.mtimeMs;
      const stalePart = entry.name.startsWith(".") && entry.name.endsWith(".part")
        && age > (options.partStaleMs ?? PART_STALE_MS);
      const orphan = ARTIFACT_FILENAME.test(entry.name) && !referenced.has(entry.name)
        && age > (options.orphanGraceMs ?? ORPHAN_GRACE_MS);
      if (stalePart || orphan) {
        await unlink(path).catch(() => undefined);
        deleted += 1;
      }
    }
    return deleted;
  });
}

export function goldenArtifactUrlFor(evalId: string, filename: string) {
  assertEvalId(evalId);
  if (!ARTIFACT_FILENAME.test(filename)) throw new Error("评测产物文件名不合法");
  return artifactUrl(evalId, filename);
}
