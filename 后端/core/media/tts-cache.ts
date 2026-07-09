import { createHash } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { join } from "path";
import { getDataDir } from "@backend/shared/paths";

const MIN_CACHE_BYTES = 100;

export function ttsCacheKey(parts: Record<string, unknown>): string {
  const entries = Object.keys(parts)
    .filter((key) => {
      const value = parts[key];
      return value !== undefined && value !== null && value !== "";
    })
    .sort()
    .map((key) => [key, parts[key]]);

  return createHash("sha1").update(JSON.stringify(entries), "utf8").digest("hex");
}

function cachePath(key: string): string | null {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) return null;
  return join(getDataDir(), "cache", "tts", `${key}.mp3`);
}

export async function readTtsCache(key: string): Promise<Buffer | null> {
  try {
    const file = cachePath(key);
    if (!file) return null;
    const buffer = await readFile(file);
    return buffer.length >= MIN_CACHE_BYTES ? buffer : null;
  } catch {
    return null;
  }
}

export async function writeTtsCache(key: string, data: Buffer): Promise<void> {
  try {
    if (!data || data.length < MIN_CACHE_BYTES) return;
    const file = cachePath(key);
    if (!file) return;
    await mkdir(join(getDataDir(), "cache", "tts"), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch {
    // Cache I/O must never break generation.
  }
}
