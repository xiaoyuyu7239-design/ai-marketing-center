import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireGoldenEvaluationLease,
  cleanupGoldenArtifactOrphans,
  deleteGoldenArtifacts,
  GoldenEvaluationBusyError,
  resolveGoldenArtifact,
  storeGoldenAudioArtifact,
  storeGoldenRemoteArtifacts,
  verifyGoldenArtifacts,
} from "@server/admin/evals/artifacts";
import { ffmpegBin } from "@backend/shared/ffmpeg-path";

function png() {
  return readFileSync(join(process.cwd(), "public/examples/juicer.png"));
}

function realMp3(root: string) {
  const path = join(root, "fixture.mp3");
  const generated = spawnSync(ffmpegBin(), [
    "-v", "error", "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=16000",
    "-t", "6", "-codec:a", "libmp3lame", "-y", path,
  ]);
  if (generated.status !== 0) throw new Error(`ffmpeg fixture failed: ${generated.stderr?.toString()}`);
  return readFileSync(path);
}

describe("Golden media artifact storage", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-golden-artifacts-"));
    process.env.APP_DATA_DIR = dataDir;
  });

  afterEach(() => {
    delete process.env.APP_DATA_DIR;
    delete process.env.HUIMAI_EVAL_STORAGE_MAX_BYTES;
    delete process.env.HUIMAI_EVAL_ARTIFACT_HOSTS;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("downloads only through the HTTPS + SSRF policy and writes an opaque atomic file", async () => {
    const fetcher = vi.fn(async () => new Response(png(), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }));
    const [artifact] = await storeGoldenRemoteArtifacts(
      "eval_test_001",
      "image",
      ["https://cdn.example.test/result.png"],
      { fetcher },
    );

    expect(fetcher).toHaveBeenCalledWith(
      "https://cdn.example.test/result.png",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
      4,
      { allowedProtocols: ["https:"], allowedPorts: ["", "443"] },
    );
    expect(artifact.filename).toMatch(/^[0-9a-f-]+\.png$/);
    expect(artifact.url).toBe(`/api/admin/model-evals/artifacts/eval_test_001/${artifact.filename}`);
    expect(readdirSync(join(dataDir, "admin-evals"))).toEqual([artifact.filename]);
    await expect(resolveGoldenArtifact("eval_other_001", artifact.url, "image")).rejects.toThrow(/URL|\u8bb0\u5f55/);
    await expect(verifyGoldenArtifacts(
      "eval_test_001",
      [artifact.url],
      "image",
      [artifact],
    )).resolves.toHaveLength(1);
  });

  it("rejects HTTP, MIME confusion and path-like artifact identities", async () => {
    const fetcher = vi.fn(async () => new Response(png(), { status: 200 }));
    await expect(storeGoldenRemoteArtifacts(
      "eval_test_002",
      "image",
      ["http://cdn.example.test/result.png"],
      { fetcher },
    )).rejects.toThrow(/HTTPS/);
    expect(fetcher).not.toHaveBeenCalled();

    const confused = vi.fn(async () => new Response(realMp3(dataDir), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }));
    await expect(storeGoldenRemoteArtifacts(
      "eval_test_002",
      "image",
      ["https://cdn.example.test/not-image"],
      { fetcher: confused },
    )).rejects.toThrow(/image|\u6709\u6548/);

    await expect(resolveGoldenArtifact(
      "eval_test_002",
      "/api/admin/model-evals/artifacts/eval_test_002/..%2Fsecret.mp3",
      "audio",
    )).rejects.toThrow(/URL|\u6587\u4ef6/);
  });

  it("enforces the aggregate storage ceiling and validates real audio bytes", async () => {
    const audio = realMp3(dataDir);
    process.env.HUIMAI_EVAL_STORAGE_MAX_BYTES = String(audio.byteLength + 512);
    const first = await storeGoldenAudioArtifact("eval_audio_001", audio);
    expect(first).toHaveLength(1);
    expect(first[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first[0].probe.durationSeconds).toBeGreaterThan(5);
    await expect(storeGoldenAudioArtifact("eval_audio_002", audio)).rejects.toThrow(/\u603b\u5b58\u50a8|\u989d\u5ea6/);
  });

  it("rejects a magic-only truncated file that ffprobe cannot decode", async () => {
    const fake = Buffer.alloc(256);
    fake.write("ID3", 0, "ascii");
    await expect(storeGoldenAudioArtifact("eval_audio_bad", fake)).rejects.toThrow(/ffprobe|\u89e3\u6790/);
  });

  it("detects post-review tampering and supports deletion/orphan cleanup", async () => {
    const fetcher = vi.fn(async () => new Response(png(), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }));
    const [kept] = await storeGoldenRemoteArtifacts(
      "eval_keep_001",
      "image",
      ["https://cdn.example.test/kept.png"],
      { fetcher },
    );
    const [orphan] = await storeGoldenRemoteArtifacts(
      "eval_orphan_001",
      "image",
      ["https://cdn.example.test/orphan.png"],
      { fetcher },
    );
    const root = join(dataDir, "admin-evals");
    await cleanupGoldenArtifactOrphans([
      { id: "eval_keep_001", artifactUrls: [kept.url] },
    ], { now: Date.now() + 1_000, orphanGraceMs: 0 });
    expect(existsSync(join(root, kept.filename))).toBe(true);
    expect(existsSync(join(root, orphan.filename))).toBe(false);

    appendFileSync(join(root, kept.filename), Buffer.from([0]));
    await expect(verifyGoldenArtifacts(
      "eval_keep_001",
      [kept.url],
      "image",
      [kept],
    )).rejects.toThrow(/元数据|哈希|一致/);
    await deleteGoldenArtifacts("eval_keep_001", [kept.url]);
    expect(existsSync(join(root, kept.filename))).toBe(false);
  });

  it("serializes paid Golden evaluations across processes", async () => {
    const release = await acquireGoldenEvaluationLease();
    await expect(acquireGoldenEvaluationLease()).rejects.toBeInstanceOf(GoldenEvaluationBusyError);
    await release();
    const releaseAgain = await acquireGoldenEvaluationLease();
    await releaseAgain();
  });

  it("enforces the configured artifact hostname allowlist before download", async () => {
    process.env.HUIMAI_EVAL_ARTIFACT_HOSTS = "cdn.allowed.test,*.assets.allowed.test";
    const fetcher = vi.fn(async () => new Response(png(), {
      status: 200,
      headers: { "Content-Type": "image/png" },
    }));
    await expect(storeGoldenRemoteArtifacts(
      "eval_host_bad",
      "image",
      ["https://cdn.blocked.test/result.png"],
      { fetcher },
    )).rejects.toThrow(/白名单/);
    expect(fetcher).not.toHaveBeenCalled();

    await storeGoldenRemoteArtifacts(
      "eval_host_good",
      "image",
      ["https://v1.assets.allowed.test/result.png"],
      { fetcher },
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://v1.assets.allowed.test/result.png",
      expect.any(Object),
      4,
      expect.objectContaining({
        allowedHosts: ["cdn.allowed.test", "*.assets.allowed.test"],
        allowedPorts: ["", "443"],
      }),
    );
  });
});
