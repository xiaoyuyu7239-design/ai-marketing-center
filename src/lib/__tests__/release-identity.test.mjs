import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyReleaseIdentity } from "../../../scripts/verify-release-identity.mjs";

const roots = [];

function fixture(version) {
  const root = mkdtempSync(join(tmpdir(), "huimai-release-identity-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ version })}\n`);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe("release identity", () => {
  it("accepts the exact invite-beta tag and prerelease flag", async () => {
    await expect(verifyReleaseIdentity({
      root: fixture("0.9.0-beta.1"),
      tag: "v0.9.0-beta.1",
      releasePrerelease: true,
    })).resolves.toMatchObject({ prerelease: true, tag: "v0.9.0-beta.1" });
  });

  it("rejects a mismatched tag or GitHub prerelease state", async () => {
    const root = fixture("0.9.0-beta.1");
    await expect(verifyReleaseIdentity({ root, tag: "v0.9.0" })).rejects.toThrow("精确等于");
    await expect(verifyReleaseIdentity({
      root,
      tag: "v0.9.0-beta.1",
      releasePrerelease: false,
    })).rejects.toThrow("预发布状态");
  });

  it("keeps prereleases out of the stable desktop workflow", async () => {
    await expect(verifyReleaseIdentity({
      root: fixture("0.9.0-beta.1"),
      tag: "v0.9.0-beta.1",
      stableOnly: true,
    })).rejects.toThrow("拒绝预发布");
  });

  it("rejects build metadata and numeric prerelease leading zeros", async () => {
    await expect(verifyReleaseIdentity({
      root: fixture("0.9.0-beta.01"),
      tag: "v0.9.0-beta.01",
    })).rejects.toThrow("前导零");
    await expect(verifyReleaseIdentity({
      root: fixture("0.9.0-beta.1+local"),
      tag: "v0.9.0-beta.1+local",
    })).rejects.toThrow("SemVer");
  });
});
