import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  link,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const DEFAULT_ALLOWLIST = "config/release-candidate-paths.txt";
const execFileAsync = promisify(execFile);
const MAX_CANDIDATE_FILE_BYTES = 100 * 1024 * 1024;
const OMITTED_NAMES = new Set([
  ".DS_Store",
  ".next",
  ".pnpm-store",
  "coverage",
  "node_modules",
]);
const FORBIDDEN_TOP_LEVEL = new Set([
  ".agents",
  ".claude",
  ".codex",
  ".codex-node-env",
  ".git",
  ".next",
  ".pnpm-store",
  "agent",
  "ai营销的立项",
  "backups",
  "codex交流记忆库",
  "data",
  "dist-vite",
  "node_modules",
  "output",
  "prompt",
  "release",
  "standalone-landing",
  "uploads",
  "vite.config.ts",
  "展示界面.MOV",
  "提示词文档",
  "版本存档",
  "视频",
  "视频参考",
  "视频背景",
  "项目",
]);
const FORBIDDEN_ANYWHERE = new Set([".git", ".next", ".pnpm-store", "node_modules"]);
const FORBIDDEN_SUFFIXES = [
  ".7z",
  ".dmg",
  ".exe",
  ".gz",
  ".key",
  ".p12",
  ".pem",
  ".pfx",
  ".rar",
  ".tar",
  ".tgz",
  ".zip",
];

function fail(message) {
  throw new Error(`release candidate 边界校验失败：${message}`);
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
  if (FORBIDDEN_TOP_LEVEL.has(segments[0])) fail(`白名单命中禁止路径：${value}`);
  return { directory, path: unwrapped };
}

function assertCandidatePath(relativePath, size) {
  const segments = relativePath.split("/");
  if (FORBIDDEN_TOP_LEVEL.has(segments[0])
    || segments.some((segment) => FORBIDDEN_ANYWHERE.has(segment))) {
    fail(`候选文件命中禁止目录：${relativePath}`);
  }
  if (segments.some((segment) => segment === ".env" || segment.startsWith(".env."))) {
    fail(`候选文件疑似环境密钥：${relativePath}`);
  }
  const lower = relativePath.toLocaleLowerCase("en-US");
  if (FORBIDDEN_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    fail(`候选文件是禁止的密钥/归档/安装包：${relativePath}`);
  }
  if (size > MAX_CANDIDATE_FILE_BYTES) {
    fail(`单文件超过 ${MAX_CANDIDATE_FILE_BYTES} bytes：${relativePath} (${size})`);
  }
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
    if (seen.has(key)) fail(`白名单包含重复/大小写/Unicode 冲突：${item.path}`);
    for (const prior of seen) {
      if (key.startsWith(`${prior}/`) || prior.startsWith(`${key}/`)) {
        fail(`白名单包含重叠路径：${item.path}`);
      }
    }
    seen.add(key);
  }
  return { absolute, items, raw };
}

async function walk(absolutePath, relativePath, entries, portablePaths) {
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink()) fail(`不允许符号链接：${relativePath}`);
  if (stats.isDirectory()) {
    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((a, b) => Buffer.from(a.name).compare(Buffer.from(b.name)));
    for (const child of children) {
      if (OMITTED_NAMES.has(child.name)) continue;
      await walk(
        join(absolutePath, child.name),
        slashPath(join(relativePath, child.name)),
        entries,
        portablePaths,
      );
    }
    return;
  }
  if (!stats.isFile()) fail(`只允许普通文件：${relativePath}`);
  assertCandidatePath(relativePath, stats.size);
  const key = portableKey(relativePath);
  if (portablePaths.has(key)) fail(`存在大小写或 Unicode 归一化冲突：${relativePath}`);
  portablePaths.add(key);
  entries.push({
    path: relativePath,
    bytes: stats.size,
    mode: stats.mode & 0o777,
    sha256: await hashFile(absolutePath),
  });
}

async function git(root, args, options = {}) {
  try {
    return await execFileAsync("git", ["-C", root, ...args], {
      encoding: options.encoding ?? "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    fail(`git ${args.join(" ")} 执行失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function assertGitTracked(root, entries) {
  const { stdout: trackedBuffer } = await git(root, ["ls-files", "-z"], { encoding: "buffer" });
  const tracked = new Set(trackedBuffer.toString("utf8").split("\0").filter(Boolean));
  const missing = entries.map((entry) => entry.path).filter((path) => !tracked.has(path));
  if (missing.length) {
    fail(`白名单文件不属于当前 commit：${missing.slice(0, 10).join("、")}${missing.length > 10 ? ` 等 ${missing.length} 个` : ""}`);
  }
  const forbidden = [...tracked].filter((path) => FORBIDDEN_TOP_LEVEL.has(path.split("/")[0]));
  if (forbidden.length) {
    fail(`当前 commit 跟踪了禁止路径：${forbidden.slice(0, 10).join("、")}`);
  }
  const { stdout: status } = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status.length) fail("要求 Git 证据时工作树必须完全干净");
}

export async function buildReleaseCandidateEvidence({
  root = process.cwd(),
  allowlistPath = DEFAULT_ALLOWLIST,
  requireGitTracked = false,
} = {}) {
  const projectRoot = await realpath(resolve(root));
  const { absolute: allowlistAbsolute, items, raw } = await readAllowlist(projectRoot, allowlistPath);
  const entries = [];
  const portablePaths = new Set();
  for (const item of items) {
    const absolute = resolve(projectRoot, item.path);
    if (!isInside(projectRoot, absolute)) fail(`白名单路径越界：${item.path}`);
    const resolved = await realpath(absolute).catch(() => fail(`白名单路径不存在：${item.path}`));
    if (!isInside(projectRoot, resolved)) fail(`白名单路径经符号链接越界：${item.path}`);
    const stats = await lstat(absolute);
    if (stats.isSymbolicLink()) fail(`白名单根路径不允许符号链接：${item.path}`);
    if (item.directory !== stats.isDirectory()) {
      fail(`白名单文件/目录声明与实际类型不一致：${item.path}`);
    }
    await walk(absolute, item.path, entries, portablePaths);
  }

  entries.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
  const digest = createHash("sha256");
  for (const entry of entries) {
    digest.update(`${entry.path}\0${entry.bytes}\0${entry.mode.toString(8).padStart(3, "0")}\0${entry.sha256}\n`);
  }
  if (requireGitTracked) await assertGitTracked(projectRoot, entries);
  return {
    schemaVersion: 1,
    allowlist: slashPath(relative(projectRoot, allowlistAbsolute)),
    allowlistSha256: createHash("sha256").update(raw).digest("hex"),
    candidateOverlayDigestSha256: digest.digest("hex"),
    gitTrackedOnly: requireGitTracked,
    totals: {
      fileCount: entries.length,
      bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    },
    items,
    files: entries.map((entry) => ({ ...entry, mode: entry.mode.toString(8).padStart(3, "0") })),
  };
}

export async function stageReleaseCandidate({
  root = process.cwd(),
  destination,
  allowlistPath = DEFAULT_ALLOWLIST,
} = {}) {
  if (!destination) fail("缺少隔离 Git clone 目标目录");
  const projectRoot = await realpath(resolve(root));
  const destinationRoot = await realpath(resolve(destination)).catch(() => fail("目标目录必须已存在"));
  if (isInside(projectRoot, destinationRoot) || isInside(destinationRoot, projectRoot)) {
    fail("源项目与隔离目标不得相互包含");
  }
  const { stdout: inside } = await git(destinationRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.trim() !== "true") fail("目标不是 Git 工作树");
  const { stdout: status } = await git(
    destinationRoot,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  );
  if (status.length) fail("隔离 Git clone 在覆盖前必须完全干净");

  const evidence = await buildReleaseCandidateEvidence({ root: projectRoot, allowlistPath });
  for (const item of evidence.items) {
    const target = resolve(destinationRoot, item.path);
    if (!isInside(destinationRoot, target)) fail(`目标路径越界：${item.path}`);
    if (item.directory) {
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
    }
  }
  for (const entry of evidence.files) {
    const source = resolve(projectRoot, entry.path);
    const target = resolve(destinationRoot, entry.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
    await chmod(target, Number.parseInt(entry.mode, 8));
  }
  return evidence;
}

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    allowlistPath: DEFAULT_ALLOWLIST,
    destination: "",
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
    } else if (value === "--destination" && next) {
      args.destination = next;
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
  if (args.destination && args.requireGitTracked) {
    fail("--destination 与 --require-git-tracked 不得同时使用");
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
  const evidence = args.destination
    ? await stageReleaseCandidate(args)
    : await buildReleaseCandidateEvidence(args);
  if (args.evidencePath) await writeEvidenceExclusive(args.evidencePath, evidence);
  process.stdout.write(
    `发布候选边界校验通过：${evidence.totals.fileCount} files / ${evidence.totals.bytes} bytes\n`
      + `candidate overlay SHA-256: ${evidence.candidateOverlayDigestSha256}\n`
      + (args.destination ? `staged clone: ${resolve(args.destination)}\n` : "")
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
