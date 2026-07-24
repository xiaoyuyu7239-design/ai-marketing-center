import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReleaseSourceEvidence } from "../../../scripts/verify-release-source.mjs";

const ALLOWLIST = "package.json\nsrc/\n";
const DOCKERFILE = "FROM scratch\nCOPY package.json ./\nCOPY src ./src\n";
const DOCKERIGNORE = "**\n!package.json\n!src/\n!src/**\n**/node_modules\n**/.next\n**/.env\n**/.env.*\n";

describe("production image operations baseline", () => {
  it("ships and smoke-checks the edge body-limit verifier in the runner image", () => {
    const dockerfile = readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "docker-publish.yml"),
      "utf8",
    );
    expect(dockerfile).toContain(
      "COPY --from=builder /app/scripts/verify-edge-body-limit.mjs ./scripts/verify-edge-body-limit.mjs",
    );
    expect(workflow).toContain("test -f scripts/verify-edge-body-limit.mjs");
  });
});

describe("release source boundary", () => {
  let root;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "huimai-release-source-"));
    mkdirSync(join(root, "config"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "config", "release-source-paths.txt"), ALLOWLIST);
    writeFileSync(join(root, "Dockerfile"), DOCKERFILE);
    writeFileSync(join(root, ".dockerignore"), DOCKERIGNORE);
    writeFileSync(join(root, "package.json"), "{}\n");
    writeFileSync(join(root, "src", "route.ts"), "export const ok = true;\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("只清单化白名单普通文件并生成确定性摘要", async () => {
    mkdirSync(join(root, "src", "node_modules"));
    writeFileSync(join(root, "src", "node_modules", "secret.js"), "not shipped\n");

    const first = await buildReleaseSourceEvidence({ root });
    const second = await buildReleaseSourceEvidence({ root });

    expect(first.totals.fileCount).toBe(2);
    expect(first.files.map((file) => file.path)).toEqual(["package.json", "src/route.ts"]);
    expect(first.sourceDigestSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.sourceDigestSha256).toBe(first.sourceDigestSha256);
  });

  it("拒绝白名单目录中的符号链接和环境密钥文件", async () => {
    symlinkSync(join(root, "package.json"), join(root, "src", "linked-package.json"));
    await expect(buildReleaseSourceEvidence({ root })).rejects.toThrow("不允许符号链接");

    rmSync(join(root, "src", "linked-package.json"));
    writeFileSync(join(root, "src", ".env.production"), "SECRET=value\n");
    await expect(buildReleaseSourceEvidence({ root })).rejects.toThrow("环境密钥");
  });

  it("拒绝 Dockerfile 重新放宽为 COPY 点目录", async () => {
    writeFileSync(join(root, "Dockerfile"), "FROM scratch\nCOPY . .\n");
    await expect(buildReleaseSourceEvidence({ root })).rejects.toThrow("不得使用 COPY .");
  });

  it("CI 模式拒绝白名单中的未跟踪文件", async () => {
    expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0);
    expect(spawnSync("git", ["add", "."], { cwd: root }).status).toBe(0);

    const tracked = await buildReleaseSourceEvidence({ root, requireGitTracked: true });
    expect(tracked.gitTrackedOnly).toBe(true);

    writeFileSync(join(root, "src", "generated.ts"), "export const generated = true;\n");
    await expect(buildReleaseSourceEvidence({ root, requireGitTracked: true }))
      .rejects.toThrow("不属于当前 commit");
  });
});
