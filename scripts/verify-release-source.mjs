import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  lstat,
  link,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const DEFAULT_ALLOWLIST = "config/release-source-paths.txt";
const execFileAsync = promisify(execFile);
const MAX_RELEASE_FILE_BYTES = 100 * 1024 * 1024;
const OMITTED_NAMES = new Set(["node_modules", ".next", ".pnpm-store", ".DS_Store"]);
const FORBIDDEN_TOP_LEVEL_SEGMENTS = new Set([
  ".git",
  ".github",
  ".agents",
  ".codex",
  ".claude",
  ".vscode",
  ".idea",
  "data",
  "backups",
  "release",
  "coverage",
  "uploads",
  "output",
  "版本存档",
  "视频背景",
  "视频参考",
]);
const FORBIDDEN_ANYWHERE_SEGMENTS = new Set([
  ".git",
  ".next",
  ".pnpm-store",
  "node_modules",
]);
const FORBIDDEN_ARCHIVE_SUFFIXES = [
  ".7z",
  ".dmg",
  ".exe",
  ".gz",
  ".rar",
  ".tar",
  ".tgz",
  ".zip",
];

function fail(message) {
  throw new Error(`release source 校验失败：${message}`);
}

function slashPath(value) {
  return value.split(sep).join("/");
}

function portableKey(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function validateRelativePath(value, { allowDirectorySuffix = false } = {}) {
  const directory = allowDirectorySuffix && value.endsWith("/");
  const unwrapped = directory ? value.slice(0, -1) : value;
  if (!unwrapped || isAbsolute(unwrapped) || unwrapped.includes("\\")) {
    fail(`白名单路径不是安全的 POSIX 相对路径：${value}`);
  }
  const segments = unwrapped.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    fail(`白名单路径包含空段、. 或 ..：${value}`);
  }
  if (FORBIDDEN_TOP_LEVEL_SEGMENTS.has(segments[0])) {
    fail(`白名单路径命中禁止目录：${value}`);
  }
  if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) {
    fail(`白名单路径命中环境密钥文件：${value}`);
  }
  return { directory, path: unwrapped };
}

async function hashFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function readAllowlist(root, allowlistPath) {
  const absolute = resolve(root, allowlistPath);
  if (!isInside(root, absolute)) fail("白名单文件越出项目根目录");
  const raw = await readFile(absolute, "utf8");
  const items = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => validateRelativePath(line, { allowDirectorySuffix: true }));
  if (!items.length) fail("白名单为空");

  const seen = new Set();
  for (const item of items) {
    const key = portableKey(item.path);
    if (seen.has(key)) fail(`白名单包含重复或大小写/Unicode 冲突路径：${item.path}`);
    seen.add(key);
  }
  return { absolute, items, raw };
}

function assertReleaseFilePath(relativePath, size) {
  const segments = relativePath.split("/");
  if (FORBIDDEN_TOP_LEVEL_SEGMENTS.has(segments[0])
    || segments.some((segment) => FORBIDDEN_ANYWHERE_SEGMENTS.has(segment))) {
    fail(`发布文件命中禁止目录：${relativePath}`);
  }
  if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) {
    fail(`发布文件疑似环境密钥：${relativePath}`);
  }
  const lower = relativePath.toLocaleLowerCase("en-US");
  if (FORBIDDEN_ARCHIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    fail(`发布文件是禁止的归档/安装包：${relativePath}`);
  }
  if (size > MAX_RELEASE_FILE_BYTES) {
    fail(`单文件超过 ${MAX_RELEASE_FILE_BYTES} bytes 上限：${relativePath} (${size})`);
  }
}

async function walk(root, absolutePath, relativePath, entries, portablePaths) {
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink()) fail(`不允许符号链接：${relativePath}`);
  if (stats.isDirectory()) {
    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const child of children) {
      if (OMITTED_NAMES.has(child.name)) continue;
      await walk(
        root,
        join(absolutePath, child.name),
        slashPath(join(relativePath, child.name)),
        entries,
        portablePaths,
      );
    }
    return;
  }
  if (!stats.isFile()) fail(`只允许普通文件：${relativePath}`);

  assertReleaseFilePath(relativePath, stats.size);
  const key = portableKey(relativePath);
  if (portablePaths.has(key)) fail(`存在大小写或 Unicode 归一化冲突：${relativePath}`);
  portablePaths.add(key);
  entries.push({
    path: relativePath,
    bytes: stats.size,
    mode: (stats.mode & 0o777).toString(8).padStart(3, "0"),
    sha256: await hashFile(absolutePath),
  });
}

function dockerCopySources(dockerfile) {
  const sources = [];
  for (const rawLine of dockerfile.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line.startsWith("COPY ") || line.startsWith("COPY --from=")) continue;
    if (line === "COPY . ." || line.startsWith("COPY . ")) {
      fail("Dockerfile 不得使用 COPY .；必须逐项显式复制白名单路径");
    }
    const parts = line.slice(5).trim().split(/\s+/u);
    if (parts.some((part) => part.startsWith("--"))) {
      fail(`暂不接受带选项的本地 COPY，请显式审计：${line}`);
    }
    if (parts.length < 2) fail(`无法解析 Dockerfile COPY：${line}`);
    sources.push(...parts.slice(0, -1).map((part) => part.replace(/\/$/u, "")));
  }
  return sources;
}

function verifyDockerBoundary(allowlist, dockerfile, dockerignore) {
  const expected = new Set(allowlist.map((item) => item.path));
  const copied = dockerCopySources(dockerfile);
  const copiedSet = new Set(copied);
  for (const source of copiedSet) {
    if (!expected.has(source)) fail(`Dockerfile COPY 不在发布白名单：${source}`);
  }
  for (const source of expected) {
    if (!copiedSet.has(source)) fail(`发布白名单路径未被 Dockerfile COPY：${source}`);
  }

  const patterns = dockerignore
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (patterns[0] !== "**") fail(".dockerignore 必须以 ** 默认拒绝全部上下文");
  const patternSet = new Set(patterns);
  for (const item of allowlist) {
    if (item.directory) {
      if (!patternSet.has(`!${item.path}/`) || !patternSet.has(`!${item.path}/**`)) {
        fail(`.dockerignore 未精确放行目录：${item.path}/`);
      }
    } else if (!patternSet.has(`!${item.path}`)) {
      fail(`.dockerignore 未精确放行文件：${item.path}`);
    }
  }
  for (const requiredDeny of ["**/node_modules", "**/.next", "**/.env", "**/.env.*"]) {
    if (!patternSet.has(requiredDeny)) fail(`.dockerignore 缺少纵深拒绝规则：${requiredDeny}`);
  }
}

async function assertGitTrackedOnly(projectRoot, items, entries) {
  const boundaryFiles = ["Dockerfile", ".dockerignore", DEFAULT_ALLOWLIST];
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["-C", projectRoot, "ls-files", "-z", "--", ...boundaryFiles, ...items.map((item) => item.path)],
      { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    ));
  } catch (error) {
    fail(`无法读取 Git 发布边界：${error instanceof Error ? error.message : String(error)}`);
  }
  const tracked = new Set(stdout.toString("utf8").split("\0").filter(Boolean));
  const required = [...boundaryFiles, ...entries.map((entry) => entry.path)];
  const untracked = required.filter((path) => !tracked.has(path));
  if (untracked.length) {
    fail(`发布边界包含不属于当前 commit 的文件：${untracked.slice(0, 10).join("、")}${untracked.length > 10 ? ` 等 ${untracked.length} 个` : ""}`);
  }
}

export async function buildReleaseSourceEvidence({
  root = process.cwd(),
  allowlistPath = DEFAULT_ALLOWLIST,
  requireGitTracked = false,
} = {}) {
  const projectRoot = await realpath(resolve(root));
  const { absolute: allowlistAbsolute, items, raw: allowlistRaw } = await readAllowlist(
    projectRoot,
    allowlistPath,
  );
  const entries = [];
  const portablePaths = new Set();
  for (const item of items) {
    const absolute = resolve(projectRoot, item.path);
    if (!isInside(projectRoot, absolute)) fail(`白名单路径越界：${item.path}`);
    const resolved = await realpath(absolute).catch(() => fail(`白名单路径不存在：${item.path}`));
    if (!isInside(projectRoot, resolved)) fail(`白名单路径通过符号链接越界：${item.path}`);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) fail(`白名单根路径不允许符号链接：${item.path}`);
    if (item.directory !== stats.isDirectory()) {
      fail(`白名单文件/目录声明与实际类型不一致：${item.path}${item.directory ? "/" : ""}`);
    }
    await walk(projectRoot, absolute, item.path, entries, portablePaths);
  }

  entries.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const digest = createHash("sha256");
  for (const entry of entries) {
    digest.update(`${entry.path}\0${entry.bytes}\0${entry.mode}\0${entry.sha256}\n`);
  }
  const dockerfile = await readFile(join(projectRoot, "Dockerfile"), "utf8");
  const dockerignore = await readFile(join(projectRoot, ".dockerignore"), "utf8");
  verifyDockerBoundary(items, dockerfile, dockerignore);
  if (requireGitTracked) await assertGitTrackedOnly(projectRoot, items, entries);

  return {
    schemaVersion: 1,
    allowlist: slashPath(relative(projectRoot, allowlistAbsolute)),
    allowlistSha256: createHash("sha256").update(allowlistRaw).digest("hex"),
    sourceDigestSha256: digest.digest("hex"),
    gitTrackedOnly: requireGitTracked,
    totals: {
      fileCount: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    },
    files: entries,
  };
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    allowlistPath: DEFAULT_ALLOWLIST,
    evidencePath: "",
    requireGitTracked: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    const next = argv[index + 1];
    if (value === "--root" && next) {
      args.root = next;
      index += 1;
    } else if (value === "--allowlist" && next) {
      args.allowlistPath = next;
      index += 1;
    } else if (value === "--evidence" && next) {
      args.evidencePath = next;
      index += 1;
    } else if (value === "--require-git-tracked") {
      args.requireGitTracked = true;
    } else {
      fail(`未知或缺少参数值：${value}`);
    }
  }
  return args;
}

async function writeEvidenceExclusive(filePath, evidence) {
  const absolute = resolve(filePath);
  const temporary = join(dirname(absolute), `.${basename(absolute)}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await link(temporary, absolute);
  } catch (error) {
    if (error?.code === "EEXIST") fail(`证据文件已存在，拒绝覆盖：${absolute}`);
    throw error;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const evidence = await buildReleaseSourceEvidence(args);
  if (args.evidencePath) await writeEvidenceExclusive(args.evidencePath, evidence);
  process.stdout.write(
    `发布源码边界校验通过：${evidence.totals.fileCount} files / ${evidence.totals.bytes} bytes\n`
      + `source SHA-256: ${evidence.sourceDigestSha256}\n`
      + (args.evidencePath ? `evidence: ${resolve(args.evidencePath)}\n` : ""),
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
