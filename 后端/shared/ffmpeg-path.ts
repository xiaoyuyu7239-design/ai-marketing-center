import { existsSync } from "fs";
import { spawnSync } from "child_process";

/**
 * ffmpeg / ffprobe 二进制路径解析 —— 让命令可指向随包二进制，支撑 Electron 打包
 *
 * 开发态：优先使用带字幕滤镜的系统 ffmpeg-full；否则回退到 PATH。
 * Electron 打包：主进程会注入随包二进制，但 macOS 上未签名 ffmpeg 可能被系统 SIGKILL。
 * 因此运行时会做一次轻量健康检查，坏的注入路径会自动让位给可运行的系统路径。
 *
 * 注意：返回值会被拼进 shell 命令字符串，路径可能含空格，调用处用双引号包裹。
 */

const HOMEBREW_FULL = "/opt/homebrew/opt/ffmpeg-full/bin";
const INTEL_HOMEBREW_FULL = "/usr/local/opt/ffmpeg-full/bin";
const HOMEBREW = "/opt/homebrew/bin";
const INTEL_HOMEBREW = "/usr/local/bin";

let cachedFfmpeg: string | undefined;
let cachedFfprobe: string | undefined;
const ffmpegProbeCache = new Map<string, { ok: boolean; reason?: string }>();
const ffprobeProbeCache = new Map<string, boolean>();

function skipProbe(): boolean {
  return process.env.NODE_ENV === "test" || process.env.CLIPFORGE_SKIP_FFMPEG_PROBE === "1";
}

function uniq(values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

function commandExists(cmd: string): boolean {
  return !cmd.includes("/") || existsSync(cmd);
}

function probeFfprobe(bin: string): boolean {
  if (!commandExists(bin)) return false;
  const cached = ffprobeProbeCache.get(bin);
  if (cached != null) return cached;
  const r = spawnSync(bin, ["-version"], { stdio: "ignore", timeout: 5000 });
  const ok = !r.error && r.status === 0;
  ffprobeProbeCache.set(bin, ok);
  return ok;
}

function probeFfmpeg(bin: string): { ok: boolean; reason?: string } {
  if (!commandExists(bin)) return { ok: false, reason: `${bin} 不存在` };
  const cached = ffmpegProbeCache.get(bin);
  if (cached) return cached;

  const version = spawnSync(bin, ["-version"], { stdio: "ignore", timeout: 5000 });
  if (version.error || version.status !== 0) {
    const reason = version.error?.message || `退出码 ${version.status ?? "unknown"}${version.signal ? ` / ${version.signal}` : ""}`;
    const result = { ok: false, reason: `${bin} 无法启动（${reason}）` };
    ffmpegProbeCache.set(bin, result);
    return result;
  }

  const filters = spawnSync(bin, ["-hide_banner", "-filters"], {
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 5 * 1024 * 1024,
  });
  const out = `${filters.stdout || ""}\n${filters.stderr || ""}`;
  if (filters.error || filters.status !== 0) {
    const reason = filters.error?.message || `退出码 ${filters.status ?? "unknown"}${filters.signal ? ` / ${filters.signal}` : ""}`;
    const result = { ok: false, reason: `${bin} 无法读取滤镜列表（${reason}）` };
    ffmpegProbeCache.set(bin, result);
    return result;
  }
  if (!/(^|\n).*\sdrawtext\s+V->V/m.test(out)) {
    const result = { ok: false, reason: `${bin} 缺少 drawtext 字幕滤镜` };
    ffmpegProbeCache.set(bin, result);
    return result;
  }

  const result = { ok: true };
  ffmpegProbeCache.set(bin, result);
  return result;
}

/** ffmpeg 可执行文件路径（含空格时调用方需加引号） */
export function ffmpegBin(): string {
  if (skipProbe()) return process.env.FFMPEG_PATH || "ffmpeg";
  if (cachedFfmpeg) return cachedFfmpeg;

  const candidates = uniq([
    process.env.FFMPEG_PATH,
    `${HOMEBREW_FULL}/ffmpeg`,
    `${INTEL_HOMEBREW_FULL}/ffmpeg`,
    "ffmpeg",
    `${HOMEBREW}/ffmpeg`,
    `${INTEL_HOMEBREW}/ffmpeg`,
  ]);

  cachedFfmpeg = candidates.find((bin) => probeFfmpeg(bin).ok) || process.env.FFMPEG_PATH || "ffmpeg";
  return cachedFfmpeg;
}

/** ffprobe 可执行文件路径（含空格时调用方需加引号） */
export function ffprobeBin(): string {
  if (skipProbe()) return process.env.FFPROBE_PATH || "ffprobe";
  if (cachedFfprobe) return cachedFfprobe;

  const candidates = uniq([
    process.env.FFPROBE_PATH,
    `${HOMEBREW_FULL}/ffprobe`,
    `${INTEL_HOMEBREW_FULL}/ffprobe`,
    "ffprobe",
    `${HOMEBREW}/ffprobe`,
    `${INTEL_HOMEBREW}/ffprobe`,
  ]);

  cachedFfprobe = candidates.find((bin) => probeFfprobe(bin)) || process.env.FFPROBE_PATH || "ffprobe";
  return cachedFfprobe;
}

export function ffmpegHealthError(): string | null {
  if (skipProbe()) return null;
  const bin = ffmpegBin();
  const probe = probeFfmpeg(bin);
  if (probe.ok) return null;
  return `FFmpeg 不可用：${probe.reason || "未知错误"}。请安装带 drawtext/libass 的 FFmpeg（macOS 推荐 brew install ffmpeg-full），或设置 FFMPEG_PATH 指向可运行的 ffmpeg。`;
}
