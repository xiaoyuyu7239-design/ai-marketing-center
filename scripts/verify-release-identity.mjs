import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER_WITHOUT_BUILD_METADATA = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

function fail(message) {
  throw new Error(`release identity 校验失败：${message}`);
}

function assertSemver(version) {
  const match = SEMVER_WITHOUT_BUILD_METADATA.exec(version);
  if (!match) {
    fail(`package.json version 必须是无 build metadata 的 SemVer：${version}`);
  }
  const prerelease = match[4] ?? "";
  for (const identifier of prerelease.split(".").filter(Boolean)) {
    if (/^\d+$/u.test(identifier) && identifier.length > 1 && identifier.startsWith("0")) {
      fail(`预发布数字标识不得包含前导零：${identifier}`);
    }
  }
  return { prerelease: prerelease.length > 0 };
}

function parseBoolean(value, label) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  fail(`${label} 必须是 true 或 false：${String(value)}`);
}

export async function verifyReleaseIdentity({
  root = process.cwd(),
  tag,
  releasePrerelease,
  stableOnly = false,
} = {}) {
  const packagePath = resolve(root, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(packagePath, "utf8"));
  } catch (error) {
    fail(`无法读取 package.json：${error instanceof Error ? error.message : String(error)}`);
  }
  const version = manifest?.version;
  if (typeof version !== "string" || !version) fail("package.json 缺少 version");
  const { prerelease } = assertSemver(version);
  const expectedTag = `v${version}`;

  if (typeof tag !== "string" || tag !== expectedTag) {
    fail(`标签必须精确等于 ${expectedTag}，实际为 ${String(tag)}`);
  }
  if (stableOnly && prerelease) {
    fail(`桌面稳定版流水线拒绝预发布版本：${version}`);
  }
  if (releasePrerelease !== undefined) {
    const declaredPrerelease = parseBoolean(releasePrerelease, "GitHub Release prerelease");
    if (declaredPrerelease !== prerelease) {
      fail(
        `GitHub Release prerelease=${declaredPrerelease} 与 package.json 预发布状态 ${prerelease} 不一致`,
      );
    }
  }

  return { version, tag: expectedTag, prerelease };
}

function parseArgs(argv) {
  const args = { root: process.cwd(), tag: undefined, releasePrerelease: undefined, stableOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--root" && next) {
      args.root = next;
      index += 1;
    } else if (value === "--tag" && next) {
      args.tag = next;
      index += 1;
    } else if (value === "--release-prerelease" && next) {
      args.releasePrerelease = next;
      index += 1;
    } else if (value === "--stable-only") {
      args.stableOnly = true;
    } else {
      fail(`未知或缺少参数值：${value}`);
    }
  }
  return args;
}

async function main() {
  const result = await verifyReleaseIdentity(parseArgs(process.argv.slice(2)));
  process.stdout.write(
    `发布身份校验通过：${result.tag} (${result.prerelease ? "prerelease" : "stable"})\n`,
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
