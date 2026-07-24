import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReleaseCandidateEvidence,
  stageReleaseCandidate,
} from "../../../scripts/stage-release-candidate.mjs";

const roots = [];

function temporaryRoot(label) {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function sourceFixture() {
  const root = temporaryRoot("huimai-release-candidate-source-");
  mkdirSync(join(root, "config"), { recursive: true });
  mkdirSync(join(root, "src", "node_modules"), { recursive: true });
  writeFileSync(join(root, "config", "release-candidate-paths.txt"), "package.json\nsrc/\n");
  writeFileSync(join(root, "package.json"), "{\"version\":\"0.9.0-beta.1\"}\n");
  writeFileSync(join(root, "src", "current.ts"), "export const current = true;\n");
  writeFileSync(join(root, "src", "node_modules", "ignored.js"), "ignored\n");
  writeFileSync(join(root, "not-allowlisted.txt"), "do not copy\n");
  return root;
}

function cleanCloneFixture() {
  const root = temporaryRoot("huimai-release-candidate-clone-");
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Release Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "release@example.invalid"]);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "baseline only\n");
  writeFileSync(join(root, "src", "legacy.ts"), "export const legacy = true;\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-qm", "baseline"]);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("release candidate boundary", () => {
  it("is deterministic and omits dependency trees", async () => {
    const root = sourceFixture();
    const first = await buildReleaseCandidateEvidence({ root });
    const second = await buildReleaseCandidateEvidence({ root });
    expect(first.candidateOverlayDigestSha256).toBe(second.candidateOverlayDigestSha256);
    expect(first.files.map((entry) => entry.path)).toEqual(["package.json", "src/current.ts"]);
  });

  it("replaces allowlisted directories but preserves untouched baseline files", async () => {
    const source = sourceFixture();
    const destination = cleanCloneFixture();
    await stageReleaseCandidate({ root: source, destination });
    expect(existsSync(join(destination, "src", "legacy.ts"))).toBe(false);
    expect(readFileSync(join(destination, "src", "current.ts"), "utf8")).toContain("current = true");
    expect(readFileSync(join(destination, "AGENTS.md"), "utf8")).toBe("baseline only\n");
    expect(existsSync(join(destination, "not-allowlisted.txt"))).toBe(false);
    expect(existsSync(join(destination, "src", "node_modules"))).toBe(false);
  });

  it("rejects symlinks inside an allowlisted directory", async () => {
    const root = sourceFixture();
    symlinkSync(join(root, "package.json"), join(root, "src", "link.json"));
    await expect(buildReleaseCandidateEvidence({ root })).rejects.toThrow("符号链接");
  });

  it("rejects forbidden local research paths in the allowlist", async () => {
    const root = sourceFixture();
    writeFileSync(join(root, "config", "release-candidate-paths.txt"), "agent/\n");
    await expect(buildReleaseCandidateEvidence({ root })).rejects.toThrow("禁止路径");
  });
});
