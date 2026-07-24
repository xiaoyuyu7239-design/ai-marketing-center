import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { checkReadinessMock } = vi.hoisted(() => ({
  checkReadinessMock: vi.fn(),
}));

vi.mock("@backend/core/ops/health", () => ({
  checkReadiness: checkReadinessMock,
}));

import { GET } from "@/app/api/health/ready/route";

const READY_CHECKS = {
  database: { ok: true },
  dataDirectory: { ok: true },
  disk: { ok: true },
  ffmpeg: { ok: true },
  ffprobe: { ok: true },
};

describe("GET /api/health/ready", () => {
  let workingDirectory: string;

  beforeEach(() => {
    workingDirectory = mkdtempSync(join(tmpdir(), "huimai-ready-route-"));
    mkdirSync(join(workingDirectory, ".next"));
    vi.spyOn(process, "cwd").mockReturnValue(workingDirectory);
    checkReadinessMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workingDirectory, { recursive: true, force: true });
  });

  it("就绪时返回 200、不可缓存，并用构建产物 BUILD_ID 标识代码版本", async () => {
    const buildId = "a".repeat(40);
    writeFileSync(join(workingDirectory, ".next", "BUILD_ID"), `${buildId}\n`);
    process.env.HUIMAI_CODE_VERSION = "b".repeat(40);
    checkReadinessMock.mockResolvedValue({ ok: true, checks: READY_CHECKS });

    try {
      const response = await GET();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("x-huimai-code-version")).toBe(buildId);
      expect(await response.json()).toEqual({ status: "ready" });
    } finally {
      delete process.env.HUIMAI_CODE_VERSION;
    }
  });

  it("任一依赖失败时返回不泄露内部检查细节的 503", async () => {
    writeFileSync(join(workingDirectory, ".next", "BUILD_ID"), "c".repeat(64));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    checkReadinessMock.mockResolvedValue({
      ok: false,
      checks: {
        ...READY_CHECKS,
        database: { ok: false, error: "sensitive database path" },
      },
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get("x-huimai-code-version")).toBe("c".repeat(64));
    expect(await response.json()).toEqual({ status: "not_ready" });
    expect(consoleError).toHaveBeenCalledOnce();
  });
});
