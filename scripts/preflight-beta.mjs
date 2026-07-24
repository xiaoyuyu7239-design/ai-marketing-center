#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { access, lstat, readdir, stat, statfs } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { verifyBackupDirectory } from "./backup-integrity.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILTIN_ENDPOINT_HOSTS = new Set([
  "api.atlascloud.ai",
  "api.openai.com",
  "api.siliconflow.cn",
  "api.deepseek.com",
  "openrouter.ai",
  "ark.cn-beijing.volces.com",
  "openspeech.bytedance.com",
  "dashscope.aliyuncs.com",
  "api.fal.ai",
  "api.replicate.com",
]);
const BUILTIN_FAULT_DOMAINS = new Map([
  ["api.atlascloud.ai", "atlascloud"],
  ["api.openai.com", "openai"],
  ["api.siliconflow.cn", "siliconflow"],
  ["api.deepseek.com", "deepseek"],
  ["openrouter.ai", "openrouter"],
  ["ark.cn-beijing.volces.com", "volcengine"],
  ["openspeech.bytedance.com", "volcengine"],
  ["dashscope.aliyuncs.com", "alibaba-cloud"],
  ["api.fal.ai", "fal-ai"],
  ["api.replicate.com", "replicate"],
]);
const SECRET_ENV_CHAINS = {
  "llm.primary": ["CLIPFORGE_LLM_API_KEY"],
  "llm.fallback": ["CLIPFORGE_LLM_FALLBACK_API_KEY"],
  "image.primary": ["CLIPFORGE_IMAGE_API_KEY"],
  "image.fallback": ["CLIPFORGE_IMAGE_FALLBACK_API_KEY"],
  "video.primary": ["CLIPFORGE_VIDEO_API_KEY"],
  "video.fallback": ["CLIPFORGE_VIDEO_FALLBACK_API_KEY"],
  "tts.primary": ["CLIPFORGE_TTS_API_KEY"],
  "tts.fallback": ["CLIPFORGE_TTS_FALLBACK_API_KEY"],
};
const PROMOTION_REQUEST_KIND = {
  script: "chat-json",
  "topic-script": "chat-json",
  "product-analysis": "vision-json",
  "publish-copy": "chat-json",
  "publish-ranker": "chat-json",
  diagnose: "chat-json",
  "metrics-ocr": "vision-json",
  retro: "chat-json",
  "weekly-report": "chat-json",
  imageAgent: "image-generation",
  videoAgent: "video-generation",
  ttsAgent: "tts-generation",
};
const KNOWN_AGENT_IDS = Object.freeze(Object.keys(PROMOTION_REQUEST_KIND));
const REQUIRED_ENABLED_AGENT_IDS = Object.freeze([
  "script",
  "product-analysis",
  "imageAgent",
  "videoAgent",
  "ttsAgent",
]);
const SHA256 = /^[0-9a-f]{64}$/;
const CANDIDATE_KEY = /^(primary|fallback):[^\u0000-\u001f\u007f]{1,1800}@([0-9a-f]{64})$/;
const MIN_EDGE_BODY_BYTES = 161 * 1024 * 1024;
const MAX_EDGE_BODY_BYTES = 192 * 1024 * 1024;
export const MIN_PRODUCTION_MIGRATION_COUNT = 27;
export const REQUIRED_PRODUCTION_MIGRATIONS = Object.freeze([
  "0018_persistent_jobs.sql",
  "0019_workflow_generation_usage.sql",
  "0020_compose_paid_tts_usage.sql",
  "0021_golden_media_eval_jobs.sql",
  "0022_generation_item_leases.sql",
  "0023_golden_tts_one_shot.sql",
  "0024_persistent_motion_video_jobs.sql",
  "0025_motion_asset_assessments.sql",
  "0026_motion_job_schema_upgrade.sql",
]);
const results = [];

function add(level, id, message) {
  results.push({ level, id, message });
}

function pass(id, message) {
  add("PASS", id, message);
}

function fail(id, message) {
  add("FAIL", id, message);
}

function env(name) {
  return process.env[name]?.trim() || "";
}

function isPlaceholder(value) {
  return /replace-with|example\.(?:com|invalid)|owner-[a-z]@/i.test(String(value || ""));
}

function list(value) {
  return value.split(/[\n,;]/).map((item) => item.trim()).filter(Boolean);
}

function requiredEnv(name, label = name) {
  if (env(name) && !isPlaceholder(env(name))) pass(`env:${name}`, `${label} 已配置`);
  else if (isPlaceholder(env(name))) fail(`env:${name}`, `${label} 仍是示例占位值`);
  else fail(`env:${name}`, `${label} 未配置`);
}

function requiredNonNegativeNumber(name, label = name) {
  const raw = env(name);
  const value = Number(raw);
  if (!raw) fail(`env:${name}`, `${label} 未配置`);
  else if (isPlaceholder(raw)) fail(`env:${name}`, `${label} 仍是示例占位值`);
  else if (!Number.isFinite(value) || value < 0) fail(`env:${name}`, `${label} 必须是非负有限数`);
  else pass(`env:${name}`, `${label}=${value} USD`);
}

function requiredPositiveInteger(name, label = name) {
  const raw = env(name);
  const value = Number(raw);
  if (!raw) fail(`env:${name}`, `${label} 未配置`);
  else if (isPlaceholder(raw)) fail(`env:${name}`, `${label} 仍是示例占位值`);
  else if (!Number.isSafeInteger(value) || value <= 0) fail(`env:${name}`, `${label} 必须是正安全整数`);
  else pass(`env:${name}`, `${label}=${value} bytes`);
}

export function productionMigrationDirectoryIssues(migrationFiles) {
  const present = new Set(migrationFiles);
  const issues = REQUIRED_PRODUCTION_MIGRATIONS
    .filter((name) => !present.has(name))
    .map((name) => `缺少 ${name}`);
  if (migrationFiles.length < MIN_PRODUCTION_MIGRATION_COUNT) {
    issues.push(`迁移 SQL 数量少于 ${MIN_PRODUCTION_MIGRATION_COUNT}（实际 ${migrationFiles.length}）`);
  }
  return issues;
}

function checkGoldenEvalEnvironment() {
  const codeVersion = env("HUIMAI_CODE_VERSION").toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(codeVersion) || isPlaceholder(codeVersion)) {
    fail("env:HUIMAI_CODE_VERSION", "HUIMAI_CODE_VERSION 必须是当前 release 的完整 40/64 位十六进制 commit SHA");
  } else {
    pass("env:HUIMAI_CODE_VERSION", "Golden 评测已绑定完整 release commit SHA");
  }
  const hosts = list(env("HUIMAI_EVAL_ARTIFACT_HOSTS"));
  if (!hosts.length) {
    fail("eval:artifact-hosts", "HUIMAI_EVAL_ARTIFACT_HOSTS 未配置");
  } else if (hosts.some(isPlaceholder)) {
    fail("eval:artifact-hosts", "Golden 产物主机白名单仍是示例占位值");
  } else if (hosts.some((host) => !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host))) {
    fail("eval:artifact-hosts", "Golden 产物白名单只能包含 hostname 或 *.domain，不能带协议/路径/端口");
  } else {
    pass("eval:artifact-hosts", `已配置 ${hosts.length} 个 Golden 产物主机规则`);
  }
  requiredNonNegativeNumber("HUIMAI_EVAL_MAX_IMAGE_COST_USD", "生图平均成本上限");
  requiredNonNegativeNumber("HUIMAI_EVAL_MAX_VIDEO_COST_USD", "生视频平均成本上限");
  requiredNonNegativeNumber("HUIMAI_EVAL_MAX_TTS_COST_USD", "TTS 平均成本上限");
  requiredPositiveInteger("HUIMAI_EVAL_STORAGE_MAX_BYTES", "Golden 评测产物总容量");
  requiredPositiveInteger("HUIMAI_EVAL_MAX_RECORD_BYTES", "Golden 单记录产物上限");
  const storageMax = Number(env("HUIMAI_EVAL_STORAGE_MAX_BYTES"));
  const recordMax = Number(env("HUIMAI_EVAL_MAX_RECORD_BYTES"));
  if (Number.isSafeInteger(storageMax) && Number.isSafeInteger(recordMax) && recordMax > storageMax) {
    fail("eval:storage-limits", "HUIMAI_EVAL_MAX_RECORD_BYTES 不能大于 HUIMAI_EVAL_STORAGE_MAX_BYTES");
  } else if (Number.isSafeInteger(storageMax) && Number.isSafeInteger(recordMax)) {
    pass("eval:storage-limits", "Golden 评测存储总量与单记录上限关系有效");
  }
}

function checkOperationalThresholds() {
  if (env("TZ") !== "Asia/Shanghai") fail("env:TZ", "邀请内测值守时区必须显式为 Asia/Shanghai");
  else pass("env:TZ", "值守时区为 Asia/Shanghai");
  for (const [name, label] of [
    ["HUIMAI_ALERT_PENDING_JOBS", "待执行任务告警数"],
    ["HUIMAI_ALERT_PENDING_AGE_MS", "最老待执行任务告警时长"],
    ["HUIMAI_ALERT_RATE_LIMIT_COUNT", "供应商 429 告警次数"],
  ]) {
    const value = Number(env(name));
    if (!Number.isSafeInteger(value) || value <= 0) fail(`env:${name}`, `${label}必须是正安全整数`);
    else pass(`env:${name}`, `${label}=${value}`);
  }
  const failureRate = Number(env("HUIMAI_ALERT_MODEL_FAILURE_RATE"));
  if (!Number.isFinite(failureRate) || failureRate <= 0 || failureRate > 1) {
    fail("env:HUIMAI_ALERT_MODEL_FAILURE_RATE", "模型失败率告警阈值必须在 (0, 1] 内");
  } else {
    pass("env:HUIMAI_ALERT_MODEL_FAILURE_RATE", `模型失败率告警阈值=${failureRate}`);
  }
  requiredNonNegativeNumber("HUIMAI_ALERT_DAILY_COST_USD", "24 小时已知模型成本上限");
}

function checkPublicBaseUrl() {
  const raw = env("HUIMAI_PUBLIC_BASE_URL");
  if (!raw) {
    fail("env:HUIMAI_PUBLIC_BASE_URL", "生产公网地址未配置");
    return;
  }
  if (isPlaceholder(raw)) {
    fail("env:HUIMAI_PUBLIC_BASE_URL", "生产公网地址仍是示例占位值");
    return;
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail("env:HUIMAI_PUBLIC_BASE_URL", "生产公网地址必须是无凭据、无查询参数的 HTTPS URL");
    } else {
      pass("env:HUIMAI_PUBLIC_BASE_URL", `生产公网地址已配置为 ${parsed.origin}${parsed.pathname}`);
    }
  } catch {
    fail("env:HUIMAI_PUBLIC_BASE_URL", "生产公网地址不是合法 URL");
  }
}

function isInside(parent, child) {
  const delta = relative(parent, child);
  return delta === "" || (!delta.startsWith("..") && !isAbsolute(delta));
}

function hasRawCredential(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasRawCredential);
  return Object.entries(value).some(([key, nested]) =>
    /^(?:api[_-]?key(?:configured)?|access[_-]?token|authorization|credential|password|private[_-]?key|token)$/i.test(key)
      || hasRawCredential(nested));
}

function secretConfigured(secretRef) {
  const chain = SECRET_ENV_CHAINS[secretRef];
  return Array.isArray(chain) && chain.some((name) => env(name) && !isPlaceholder(env(name)));
}

function allowedHost(hostname) {
  const configured = new Set([
    ...BUILTIN_ENDPOINT_HOSTS,
    ...list(env("HUIMAI_MODEL_ENDPOINT_HOSTS")).map((item) => item.toLowerCase()),
  ]);
  const normalized = hostname.toLowerCase();
  for (const item of configured) {
    if (item.startsWith("*.") && normalized.endsWith(item.slice(1)) && normalized !== item.slice(2)) return true;
    if (normalized === item) return true;
  }
  return false;
}

function configuredFaultDomains() {
  const result = new Map(BUILTIN_FAULT_DOMAINS);
  for (const item of list(env("HUIMAI_MODEL_ENDPOINT_FAULT_DOMAINS"))) {
    const [rawHost, rawDomain, ...rest] = item.split("=");
    const host = rawHost?.trim().toLowerCase();
    const domain = rawDomain?.trim().toLowerCase();
    if (rest.length || !host || !domain
      || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)
      || !/^[a-z0-9][a-z0-9._-]{1,99}$/.test(domain)) {
      fail("models:fault-domain-map", `HUIMAI_MODEL_ENDPOINT_FAULT_DOMAINS 含无效 host=domain：${item}`);
      continue;
    }
    result.set(host, domain);
  }
  return result;
}

function endpointFaultDomain(endpoint, domains) {
  try {
    return domains.get(new URL(endpoint?.baseUrl).hostname.toLowerCase()) || "unknown";
  } catch {
    return "invalid";
  }
}

function expectedSecretRef(agentId, role) {
  if (agentId === "imageAgent") return `image.${role}`;
  if (agentId === "videoAgent") return `video.${role}`;
  if (agentId === "ttsAgent") return `tts.${role}`;
  return `llm.${role}`;
}

function isFloatingModelAlias(model) {
  const normalized = String(model || "").trim().toLowerCase();
  return !normalized
    || /(?:^|[/_-])(?:latest|preview|experimental|default|auto)$/.test(normalized)
    || /^(?:gpt-4o|gpt-4o-mini|qwen-plus|qwen-max|qwen-turbo|deepseek-chat|deepseek-reasoner)$/.test(normalized)
    || /seedream-(?:4|5)(?:\.0)?(?:-lite|-pro)?$/.test(normalized)
    || /seedance-(?:1\.5|2\.0)(?:-lite|-pro)?$/.test(normalized);
}

function requiresRuntimeModelRewrite(endpoint) {
  const model = String(endpoint?.model || "");
  return (endpoint?.provider === "atlas-cloud" && model === "openai/gpt-image-2/text-to-image")
    || (endpoint?.provider === "fal-ai" && model === "openai/gpt-image-2")
    || model === "fal-ai/gpt-image-1.5"
    || (model.startsWith("black-forest-labs/flux") && !model.includes("kontext"))
    || model.endsWith("/text-to-image")
    || model.includes("/text-to-video")
    || model.includes("/image-to-video");
}

export function revisionEvidenceIssues(endpoint, evidenceDir) {
  const issues = [];
  const effectiveModels = [endpoint?.model, endpoint?.visionModel].filter(Boolean);
  if (effectiveModels.some(isFloatingModelAlias)) {
    issues.push(`使用浮动模型别名 ${effectiveModels.filter(isFloatingModelAlias).join("、")}`);
  }
  if (endpoint?.visionModel && endpoint.visionModel !== endpoint.model) {
    issues.push("单个端点包含不同的 model/visionModel，无法由一份 revision 证据覆盖");
  }
  if (requiresRuntimeModelRewrite(endpoint)) {
    issues.push("模型 ID 会被运行路由按模式改写，无法与单一 revision 证据一致");
  }
  const revision = String(endpoint?.deploymentRevision || "").trim();
  if (revision.length < 3 || revision.length > 300 || isPlaceholder(revision)
    || /[\u0000-\u001f\u007f]/.test(revision)
    || /(?:^|[/_-])(?:latest|preview|experimental|default|auto)$/.test(revision.toLowerCase())) {
    issues.push("缺少供应商可核验的不可变 deploymentRevision");
  }
  const evidenceFile = String(endpoint?.revisionEvidenceFile || "");
  const expectedHash = String(endpoint?.revisionEvidenceSha256 || "").toLowerCase();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(evidenceFile) || !SHA256.test(expectedHash)) {
    issues.push("revision 证据文件名或 SHA-256 不完整");
  }
  if (issues.length) return issues;
  if (!evidenceDir || !isAbsolute(evidenceDir)) {
    return ["HUIMAI_MODEL_REVISION_EVIDENCE_DIR 未配置为绝对路径"];
  }
  try {
    const canonicalDir = realpathSync(evidenceDir);
    const candidate = join(canonicalDir, evidenceFile);
    const info = lstatSync(candidate);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("证据必须是目录内的普通文件，不能是符号链接");
    const canonicalFile = realpathSync(candidate);
    if (!isInside(canonicalDir, canonicalFile)) throw new Error("证据文件越出受控目录");
    const size = statSync(canonicalFile).size;
    if (size <= 0 || size > 64 * 1024) throw new Error("规范化 revision 证据必须为 1 byte 至 64 KiB");
    const content = readFileSync(canonicalFile);
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== expectedHash) throw new Error("证据文件 SHA-256 不匹配");
    const evidence = JSON.parse(content.toString("utf8"));
    if (!exactKeys(evidence, [
      "schemaVersion",
      "endpointHost",
      "model",
      "deploymentRevision",
      "faultDomain",
      "immutable",
      "evidenceType",
      "sourceReference",
      "issuedAt",
    ]) || evidence.schemaVersion !== 1 || evidence.immutable !== true
      || !["provider-api-response", "provider-console-export", "provider-contract"].includes(evidence.evidenceType)) {
      throw new Error("revision 证据不是受支持的规范化 JSON");
    }
    const endpointHost = new URL(endpoint.baseUrl).hostname.toLowerCase();
    const faultDomain = endpointFaultDomain(endpoint, configuredFaultDomains());
    if (evidence.endpointHost !== endpointHost || evidence.model !== endpoint.model
      || evidence.deploymentRevision !== revision || evidence.faultDomain !== faultDomain) {
      throw new Error("revision 证据与 endpointHost/model/deploymentRevision/faultDomain 不一致");
    }
    if (typeof evidence.sourceReference !== "string" || evidence.sourceReference.length < 3
      || evidence.sourceReference.length > 500 || isPlaceholder(evidence.sourceReference)) {
      throw new Error("revision 证据 sourceReference 无效或仍是占位值");
    }
    const issuedAt = Date.parse(evidence.issuedAt);
    if (!Number.isFinite(issuedAt) || new Date(issuedAt).toISOString() !== evidence.issuedAt
      || issuedAt > Date.now() + 5 * 60_000) {
      throw new Error("revision 证据 issuedAt 不是有效 ISO 时间或来自未来");
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  return issues;
}

export function edgeBodyLimitEvidenceIssues(evidence, options) {
  const issues = [];
  if (!exactKeys(evidence, [
    "schemaVersion",
    "baseOrigin",
    "probePath",
    "gatewayConfigSha256",
    "maxBodyBytes",
    "underLimitBytes",
    "underLimitStatus",
    "contentLengthStatus",
    "chunkedStatus",
    "verifiedAt",
  ])) return ["边缘请求体证据格式不完整"];
  if (evidence.schemaVersion !== 1) issues.push("边缘请求体证据 schemaVersion 不受支持");
  if (evidence.baseOrigin !== options.expectedOrigin) issues.push("边缘请求体证据域名与 HUIMAI_PUBLIC_BASE_URL 不匹配");
  if (evidence.probePath !== options.expectedProbePath) issues.push("边缘请求体证据探针路径与当前配置不匹配");
  if (!SHA256.test(evidence.gatewayConfigSha256) || !SHA256.test(options.expectedGatewayConfigSha256)) {
    issues.push("边缘 Nginx 展开配置 SHA-256 未配置或格式无效");
  }
  if (evidence.gatewayConfigSha256 !== options.expectedGatewayConfigSha256) issues.push("边缘证据与当前 Nginx 展开配置哈希不匹配");
  if (evidence.maxBodyBytes !== options.expectedMaxBodyBytes) issues.push("边缘请求体证据上限与当前配置不匹配");
  if (evidence.underLimitBytes !== options.expectedMaxBodyBytes - 1
    || !Number.isInteger(evidence.underLimitStatus)
    || evidence.underLimitStatus <= 0
    || evidence.underLimitStatus === 413) {
    issues.push("边缘请求体证据缺少未超限成功对照组");
  }
  if (evidence.contentLengthStatus !== 413 || evidence.chunkedStatus !== 413) {
    issues.push("Content-Length 与 chunked 超限探针必须都返回 413");
  }
  const verifiedAt = Date.parse(evidence.verifiedAt);
  const now = options.nowMs ?? Date.now();
  if (!Number.isFinite(verifiedAt) || new Date(verifiedAt).toISOString() !== evidence.verifiedAt) {
    issues.push("边缘请求体证据 verifiedAt 不是标准 ISO 时间");
  } else if (verifiedAt > now + 5 * 60_000 || now - verifiedAt > 7 * 86_400_000) {
    issues.push("边缘请求体证据超过 7 天或来自未来");
  }
  return issues;
}

function checkEdgeBodyLimitEvidence() {
  const rawMax = env("HUIMAI_EDGE_MAX_BODY_BYTES");
  const maxBodyBytes = Number(rawMax);
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < MIN_EDGE_BODY_BYTES || maxBodyBytes > MAX_EDGE_BODY_BYTES) {
    fail("edge:body-limit", `HUIMAI_EDGE_MAX_BODY_BYTES 必须在 ${MIN_EDGE_BODY_BYTES}..${MAX_EDGE_BODY_BYTES} 之间`);
    return;
  }
  const evidenceFile = env("HUIMAI_EDGE_BODY_LIMIT_EVIDENCE_FILE");
  const expectedHash = env("HUIMAI_EDGE_BODY_LIMIT_EVIDENCE_SHA256").toLowerCase();
  if (!isAbsolute(evidenceFile) || !SHA256.test(expectedHash)) {
    fail("edge:body-limit", "边缘请求体证据必须使用绝对路径并配置 SHA-256");
    return;
  }
  try {
    const info = lstatSync(evidenceFile);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 64 * 1024) {
      throw new Error("证据必须是 1 byte 至 64 KiB 的普通文件，不能是符号链接");
    }
    const content = readFileSync(evidenceFile);
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (actualHash !== expectedHash) throw new Error("证据文件 SHA-256 不匹配");
    const publicOrigin = new URL(env("HUIMAI_PUBLIC_BASE_URL")).origin;
    const issues = edgeBodyLimitEvidenceIssues(JSON.parse(content.toString("utf8")), {
      expectedOrigin: publicOrigin,
      expectedProbePath: env("HUIMAI_EDGE_BODY_LIMIT_PROBE_PATH"),
      expectedGatewayConfigSha256: env("HUIMAI_EDGE_GATEWAY_CONFIG_SHA256").toLowerCase(),
      expectedMaxBodyBytes: maxBodyBytes,
    });
    if (issues.length) throw new Error(issues.join("；"));
    pass("edge:body-limit", "Content-Length 与 chunked 超限请求均在边缘层返回 413，证据新鲜且哈希匹配");
  } catch (error) {
    fail("edge:body-limit", `边缘请求体证据核验失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

async function checkBackupReleaseEvidence(backupDir) {
  const evidenceFile = env("HUIMAI_BACKUP_EVIDENCE_FILE");
  const evidenceHash = env("HUIMAI_BACKUP_EVIDENCE_SHA256").toLowerCase();
  const receiptFile = env("HUIMAI_BACKUP_OFFSITE_RECEIPT_FILE");
  const receiptHash = env("HUIMAI_BACKUP_OFFSITE_RECEIPT_SHA256").toLowerCase();
  const maxAgeMs = Number(env("HUIMAI_ALERT_BACKUP_AGE_MS"));
  if (!isAbsolute(evidenceFile) || !SHA256.test(evidenceHash)
    || !isAbsolute(receiptFile) || !SHA256.test(receiptHash)) {
    fail("backup:evidence", "备份证据与异机回执必须使用绝对路径并分别配置 SHA-256");
    return;
  }
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 24 * 60 * 60_000) {
    fail("backup:evidence", "HUIMAI_ALERT_BACKUP_AGE_MS 必须是 24 小时以内的正安全整数");
    return;
  }
  try {
    const readSmallEvidence = (file, expectedHash, label) => {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 64 * 1024) {
        throw new Error(`${label} 必须是 1 byte 至 64 KiB 的普通文件`);
      }
      const content = readFileSync(file);
      if (createHash("sha256").update(content).digest("hex") !== expectedHash) {
        throw new Error(`${label} SHA-256 不匹配`);
      }
      return { content, json: JSON.parse(content.toString("utf8")) };
    };
    const evidence = readSmallEvidence(evidenceFile, evidenceHash, "备份证据").json;
    const receipt = readSmallEvidence(receiptFile, receiptHash, "异机回执").json;
    if (!exactKeys(evidence, [
      "schemaVersion",
      "backupName",
      "manifestSha256",
      "backupCreatedAt",
      "verifiedAt",
      "writesFrozen",
      "freezeStartedAt",
      "freezeEndedAt",
      "offsiteReceiptFile",
      "offsiteReceiptSha256",
    ]) || evidence.schemaVersion !== 1
      || !/^backup-[a-zA-Z0-9-]{10,200}$/.test(evidence.backupName)
      || !SHA256.test(evidence.manifestSha256)
      || evidence.writesFrozen !== true) {
      throw new Error("备份证据格式无效、备份名不安全或未声明全部写入已冻结");
    }
    if (!exactKeys(receipt, ["schemaVersion", "provider", "objectKey", "versionId", "manifestSha256", "syncedAt"])
      || receipt.schemaVersion !== 1
      || [receipt.provider, receipt.objectKey, receipt.versionId].some((value) =>
        typeof value !== "string" || !value.trim() || isPlaceholder(value))
      || !SHA256.test(receipt.manifestSha256)) {
      throw new Error("异机回执格式无效或仍含占位值");
    }
    if (evidence.offsiteReceiptFile !== receiptFile.split(/[\\/]/).at(-1)
      || evidence.offsiteReceiptSha256 !== receiptHash
      || receipt.manifestSha256 !== evidence.manifestSha256) {
      throw new Error("备份证据没有绑定当前异机回执与 manifest");
    }
    const verified = await verifyBackupDirectory(join(backupDir, evidence.backupName), { maxAgeMs });
    if (verified.manifestSha256 !== evidence.manifestSha256
      || verified.manifest.createdAt !== evidence.backupCreatedAt) {
      throw new Error("备份证据与实际正式备份不一致");
    }
    const freezeStart = Date.parse(evidence.freezeStartedAt);
    const freezeEnd = Date.parse(evidence.freezeEndedAt);
    const backupCreated = Date.parse(evidence.backupCreatedAt);
    const verifiedAt = Date.parse(evidence.verifiedAt);
    const syncedAt = Date.parse(receipt.syncedAt);
    for (const [label, raw, parsed] of [
      ["freezeStartedAt", evidence.freezeStartedAt, freezeStart],
      ["freezeEndedAt", evidence.freezeEndedAt, freezeEnd],
      ["backupCreatedAt", evidence.backupCreatedAt, backupCreated],
      ["verifiedAt", evidence.verifiedAt, verifiedAt],
      ["syncedAt", receipt.syncedAt, syncedAt],
    ]) {
      if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) throw new Error(`${label} 不是标准 ISO 时间`);
    }
    const now = Date.now();
    if (freezeStart > backupCreated || backupCreated > freezeEnd || freezeEnd - freezeStart > 2 * 60 * 60_000) {
      throw new Error("冻结窗口未覆盖正式备份或超过 2 小时");
    }
    if (syncedAt < backupCreated || verifiedAt < syncedAt || verifiedAt > now + 5 * 60_000 || now - verifiedAt > maxAgeMs) {
      throw new Error("异机同步/验证时间顺序错误、来自未来或证据已过期");
    }
    pass("backup:evidence", `正式备份 ${evidence.backupName}、冻结窗口、逐文件哈希、SQLite/外键及异机版本回执均通过`);
  } catch (error) {
    fail("backup:evidence", `备份证据核验失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 供预检与回归测试共用的纯函数；disabled Agent 明确不需要证据。 */
export function promotionEvidenceIssues(agent, expectedCodeVersion) {
  if (agent?.enabled === false) return [];
  const evidence = agent?.promotionEvidence;
  const issues = [];
  if (!exactKeys(evidence, [
    "schemaVersion",
    "agentId",
    "requestKind",
    "primary",
    "fallback",
    "promptContentSha256",
    "draftConfigSha256",
    "goldenSetSha256",
    "codeVersion",
    "verifiedAt",
  ])) return ["缺少格式完整的 promotionEvidence"];
  if (evidence.schemaVersion !== 1) issues.push("promotionEvidence schemaVersion 不受支持");
  if (evidence.agentId !== agent.id) issues.push("promotionEvidence agentId 不匹配");
  const expectedKind = PROMOTION_REQUEST_KIND[agent.id];
  if (!expectedKind || evidence.requestKind !== expectedKind) issues.push("promotionEvidence requestKind 不匹配");
  for (const field of ["promptContentSha256", "draftConfigSha256", "goldenSetSha256"]) {
    if (typeof evidence[field] !== "string" || !SHA256.test(evidence[field])) issues.push(`${field} 不是 SHA-256`);
  }
  if (typeof evidence.codeVersion !== "string" || !evidence.codeVersion.trim()
    || evidence.codeVersion.length > 200 || /[\u0000-\u001f\u007f]/.test(evidence.codeVersion)) {
    issues.push("promotionEvidence codeVersion 格式无效");
  } else if (!expectedCodeVersion || evidence.codeVersion !== expectedCodeVersion) {
    issues.push("promotionEvidence codeVersion 不是当前 HUIMAI_CODE_VERSION");
  }
  const verifiedAt = typeof evidence.verifiedAt === "string" ? evidence.verifiedAt : "";
  const parsedAt = Date.parse(verifiedAt);
  if (!Number.isFinite(parsedAt) || new Date(parsedAt).toISOString() !== verifiedAt) {
    issues.push("promotionEvidence verifiedAt 不是标准 ISO 时间");
  }
  for (const role of ["primary", "fallback"]) {
    const candidate = evidence[role];
    if (!exactKeys(candidate, ["candidateKey", "evaluationFingerprint"])) {
      issues.push(`${role} 候选证据格式无效`);
      continue;
    }
    if (typeof candidate.evaluationFingerprint !== "string" || !SHA256.test(candidate.evaluationFingerprint)) {
      issues.push(`${role} evaluationFingerprint 不是 SHA-256`);
      continue;
    }
    const match = typeof candidate.candidateKey === "string" ? CANDIDATE_KEY.exec(candidate.candidateKey) : null;
    if (!match || match[1] !== role || match[2] !== candidate.evaluationFingerprint) {
      issues.push(`${role} candidateKey 与候选指纹不匹配`);
    }
  }
  return issues;
}

export function agentInventoryIssues(state) {
  const issues = [];
  const known = new Set(KNOWN_AGENT_IDS);
  const inspectSlot = (slotName, agents) => {
    if (!Array.isArray(agents)) {
      issues.push(`${slotName} 不是 Agent 数组`);
      return [];
    }
    const ids = agents.map((agent) => typeof agent?.id === "string" ? agent.id : "");
    const duplicates = [...new Set(ids.filter((id, index) => id && ids.indexOf(id) !== index))];
    const missing = KNOWN_AGENT_IDS.filter((id) => !ids.includes(id));
    const unknown = [...new Set(ids.filter((id) => !known.has(id)))];
    if (duplicates.length) issues.push(`${slotName} 存在重复 Agent：${duplicates.join("、")}`);
    if (missing.length) issues.push(`${slotName} 缺少 Agent：${missing.join("、")}`);
    if (unknown.length) issues.push(`${slotName} 存在未知 Agent：${unknown.map((id) => id || "(空)").join("、")}`);
    return agents;
  };

  const online = inspectSlot("online", state?.agents);
  inspectSlot("draft", state?.draftAgents);
  const disabledCore = REQUIRED_ENABLED_AGENT_IDS.filter((id) =>
    online.find((agent) => agent?.id === id)?.enabled !== true);
  if (disabledCore.length) {
    issues.push(`首邀核心 Agent 必须启用：${disabledCore.join("、")}`);
  }
  return issues;
}

function checkEndpoint(agentId, role, endpoint) {
  const id = `model:${agentId}:${role}`;
  if (!endpoint || typeof endpoint !== "object") {
    fail(id, `${agentId} ${role} 端点缺失`);
    return;
  }
  if (!endpoint.provider || !endpoint.model || !endpoint.baseUrl || !endpoint.secretRef) {
    fail(id, `${agentId} ${role} provider/model/baseUrl/secretRef 不完整`);
    return;
  }
  if ([endpoint.provider, endpoint.model, endpoint.baseUrl].some(isPlaceholder)) {
    fail(id, `${agentId} ${role} 端点仍包含示例占位值`);
    return;
  }
  if (!Object.hasOwn(SECRET_ENV_CHAINS, endpoint.secretRef)) {
    fail(id, `${agentId} ${role} 使用未授权 secretRef`);
    return;
  }
  const expectedRef = expectedSecretRef(agentId, role);
  if (endpoint.secretRef !== expectedRef) {
    fail(id, `${agentId} ${role} 必须使用专属凭据引用 ${expectedRef}`);
    return;
  }
  if (!secretConfigured(endpoint.secretRef)) {
    fail(id, `${agentId} ${role} 的 ${endpoint.secretRef} 没有可用部署 secret`);
  }
  try {
    const url = new URL(endpoint.baseUrl);
    if (url.protocol !== "https:") fail(id, `${agentId} ${role} 生产端点不是 HTTPS`);
    else if (!allowedHost(url.hostname)) fail(id, `${agentId} ${role} 主机 ${url.hostname} 不在白名单`);
    else if (secretConfigured(endpoint.secretRef)) pass(id, `${agentId} ${role} 端点和凭据引用有效`);
  } catch {
    fail(id, `${agentId} ${role} baseUrl 不是合法 URL`);
  }
  const revisionIssues = revisionEvidenceIssues(endpoint, env("HUIMAI_MODEL_REVISION_EVIDENCE_DIR"));
  if (revisionIssues.length) {
    fail(`${id}:version`, `${agentId} ${role} revision 证据核验失败：${revisionIssues.join("；")}`);
  } else {
    pass(`${id}:version`, `${agentId} ${role} 固定模型、deploymentRevision 与本地证据 SHA-256 已核验`);
  }
}

function checkAgentState(state) {
  if (!state || !Array.isArray(state.agents) || state.agents.length === 0) {
    fail("models:online", "数据库中没有可用的线上 Agent 策略");
    return;
  }
  if (!Array.isArray(state.draftAgents) || !state.previousAgents || typeof state.previousAgents !== "object") {
    fail("models:slots", "模型控制面缺少独立 draft/previous 槽；请先启动当前版本完成状态规范化");
  } else {
    pass("models:slots", "online/draft/previous 槽结构完整");
  }
  const inventoryIssues = agentInventoryIssues(state);
  if (inventoryIssues.length) fail("models:inventory", inventoryIssues.join("；"));
  else pass("models:inventory", "online/draft Agent 清单完整且首邀核心 Agent 已启用");
  if (hasRawCredential(state)) fail("models:plaintext", "模型策略 JSON 中仍含疑似明文凭据字段");
  else pass("models:plaintext", "模型策略 JSON 未发现明文凭据字段");

  const faultDomains = configuredFaultDomains();
  for (const agent of state.agents) {
    if (agent?.enabled === false) {
      pass(`model:${agent.id}:disabled`, `${agent.id} 已停用，不要求 Golden 发布证据`);
      continue;
    }
    const evidenceIssues = promotionEvidenceIssues(agent, env("HUIMAI_CODE_VERSION"));
    if (evidenceIssues.length) {
      fail(`model:${agent.id}:promotion-evidence`, evidenceIssues.join("；"));
    } else {
      pass(`model:${agent.id}:promotion-evidence`, `${agent.id} 主备 Golden 发布证据完整且属于当前代码版本`);
    }
    checkEndpoint(agent.id, "primary", agent.primary);
    checkEndpoint(agent.id, "fallback", agent.fallback);
    const primaryIdentity = endpointFaultDomain(agent.primary, faultDomains);
    const fallbackIdentity = endpointFaultDomain(agent.fallback, faultDomains);
    if ([primaryIdentity, fallbackIdentity].includes("invalid")) continue;
    if ([primaryIdentity, fallbackIdentity].includes("unknown")) {
      fail(`model:${agent.id}:fault-domain`, `${agent.id} 主备主机缺少受控故障域归属`);
    } else if (primaryIdentity === fallbackIdentity) {
      fail(`model:${agent.id}:fault-domain`, `${agent.id} 主备位于同一供应商故障域 ${primaryIdentity}`);
    } else {
      pass(`model:${agent.id}:fault-domain`, `${agent.id} 主备跨供应商故障域`);
    }
  }
}

async function checkDirectory(id, path, label, writable = true) {
  if (!isAbsolute(path)) {
    fail(id, `${label} 必须使用绝对路径：${path}`);
    return false;
  }
  try {
    const linkInfo = await lstat(path);
    if (linkInfo.isSymbolicLink()) throw new Error("不得使用符号链接目录");
    const info = await stat(path);
    if (!info.isDirectory()) throw new Error("不是目录");
    await access(path, writable ? fsConstants.R_OK | fsConstants.W_OK : fsConstants.R_OK);
    pass(id, `${label} 存在且${writable ? "可读写" : "可读"}`);
    return true;
  } catch (error) {
    fail(id, `${label} 不可用：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function findBinary(explicit, candidates) {
  for (const candidate of [explicit, ...candidates].filter(Boolean)) {
    const probe = spawnSync(candidate, ["-version"], { encoding: "utf8", timeout: 5_000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return explicit || candidates[0];
}

function checkMediaBinaries() {
  const ffmpeg = findBinary(env("FFMPEG_PATH"), [
    "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
    "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
    "ffmpeg",
  ]);
  const filters = spawnSync(ffmpeg, ["-hide_banner", "-filters"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 5 * 1024 * 1024,
  });
  const filterText = `${filters.stdout || ""}\n${filters.stderr || ""}`;
  if (filters.error || filters.status !== 0) fail("binary:ffmpeg", "FFmpeg 无法启动");
  else if (!/(^|\n).*\sdrawtext\s+V->V/m.test(filterText)) fail("binary:ffmpeg", "FFmpeg 缺少 drawtext 滤镜");
  else pass("binary:ffmpeg", "FFmpeg 可用且包含 drawtext");

  const ffprobe = findBinary(env("FFPROBE_PATH"), [
    "/opt/homebrew/opt/ffmpeg-full/bin/ffprobe",
    "/usr/local/opt/ffmpeg-full/bin/ffprobe",
    "ffprobe",
  ]);
  const probe = spawnSync(ffprobe, ["-version"], { encoding: "utf8", timeout: 5_000 });
  if (probe.error || probe.status !== 0) fail("binary:ffprobe", "FFprobe 无法启动");
  else pass("binary:ffprobe", "FFprobe 可用");
}

async function checkDatabase(dataDir) {
  const databasePath = join(dataDir, "sqlite.db");
  try {
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const integrity = database.pragma("integrity_check", { simple: true });
      if (integrity !== "ok") fail("database:integrity", `SQLite integrity_check=${String(integrity)}`);
      else pass("database:integrity", "SQLite integrity_check=ok");
      const requiredColumns = {
        jobs: ["request_hash", "generation_usage_id", "paid_tts_used"],
        generation_usage: ["project_id", "operation_key", "operation_type", "request_hash", "manifest_hash", "status"],
        generation_operation_items: [
          "usage_id",
          "item_key",
          "request_hash",
          "status",
          "lease_token",
          "lease_expires_at",
        ],
        golden_media_eval_jobs: [
          "idempotency_key",
          "request_hash",
          "candidate_key",
          "status",
          "remote_task_id",
          "lease_token",
          "lease_expires_at",
        ],
        motion_video_jobs: [
          "request_hash",
          "source_asset_id",
          "remote_task_id",
          "output_clip_id",
          "error_request_id",
          "paid_capability_used",
        ],
        motion_asset_assessments: [
          "asset_id",
          "image_hash",
          "eligibility_revision",
          "face_checked_image_hash",
          "face_detector_revision",
        ],
      };
      const missingSchema = [];
      for (const [table, columns] of Object.entries(requiredColumns)) {
        const present = new Set(
          database.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name),
        );
        if (present.size === 0) missingSchema.push(`${table}(table)`);
        else for (const column of columns) if (!present.has(column)) missingSchema.push(`${table}.${column}`);
      }
      const migrationCount = Number(
        database.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()?.count,
      );
      if (!Number.isSafeInteger(migrationCount) || migrationCount < MIN_PRODUCTION_MIGRATION_COUNT) {
        missingSchema.push(
          `__drizzle_migrations(${Number.isFinite(migrationCount) ? migrationCount : "invalid"}/${MIN_PRODUCTION_MIGRATION_COUNT})`,
        );
      }
      if (missingSchema.length) fail("database:migrations", `数据库未应用最新任务/计费 schema：${missingSchema.join("、")}`);
      else {
        const goldenJobSql = database.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'golden_media_eval_jobs'",
        ).get()?.sql || "";
        const motionJobSql = database.prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'motion_video_jobs'",
        ).get()?.sql || "";
        if (!goldenJobSql.includes("golden_media_eval_jobs_succeeded_checkpoint_check")) {
          fail("database:migrations", "数据库尚未应用 TTS one-shot 终态约束迁移 0023");
        } else if (
          !motionJobSql.includes("motion_video_jobs_succeeded_output_check")
          || !motionJobSql.includes("output_clip_id")
        ) {
          fail("database:migrations", "数据库尚未应用分镜动态任务结果片段升级迁移 0026");
        } else {
          pass(
            "database:migrations",
            `数据库已应用 ${migrationCount} 条迁移，包含合成/Golden/分镜动态持久任务与 0026 升级`,
          );
        }
      }
      const row = database.prepare("SELECT value FROM settings WHERE key = ? LIMIT 1").get("admin.agentStrategy.v1");
      if (!row?.value) {
        fail("models:state", "数据库尚未初始化模型控制面线上策略");
      } else {
        const state = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
        checkAgentState(state);
      }
    } finally {
      database.close();
    }
  } catch (error) {
    fail("database:open", `无法只读检查 SQLite：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  if (env("NODE_ENV") !== "production") fail("environment", "NODE_ENV 必须为 production");
  else pass("environment", "NODE_ENV=production");
  if (env("HUIMAI_DEPLOYMENT_MODE") !== "saas") fail("mode", "HUIMAI_DEPLOYMENT_MODE 必须显式设为 saas");
  else pass("mode", "部署模式为 saas");
  if (env("CLIPFORGE_SINGLE_USER") === "1") fail("mode:single-user", "公网 SaaS 禁止 CLIPFORGE_SINGLE_USER=1");
  else pass("mode:single-user", "未启用单用户绕过");
  if (env("HUIMAI_PUBLIC_SIGNUP") === "1") fail("invite:public", "邀请内测禁止 HUIMAI_PUBLIC_SIGNUP=1");
  else pass("invite:public", "公网自由注册已关闭");
  if (env("HUIMAI_INVITE_ONLY") !== "1") fail("invite:explicit", "邀请内测必须显式设置 HUIMAI_INVITE_ONLY=1");
  else pass("invite:explicit", "邀请制已显式开启");
  const inviteEmails = list(env("HUIMAI_INVITE_EMAILS"));
  if (inviteEmails.length === 0) fail("invite:emails", "HUIMAI_INVITE_EMAILS 为空");
  else if (inviteEmails.some(isPlaceholder)) fail("invite:emails", "邀请邮箱列表仍包含示例占位地址");
  else if (inviteEmails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) fail("invite:emails", "邀请邮箱列表包含无效地址");
  else pass("invite:emails", `已配置 ${inviteEmails.length} 个邀请邮箱`);
  if (env("HUIMAI_INVITE_CODES") || env("CLIPFORGE_INVITE_CODES")) fail("invite:codes", "生产邀请内测禁止可重复邀请码");
  else pass("invite:codes", "未启用可重复邀请码");

  const password = env("CLIPFORGE_ADMIN_PASSWORD");
  const sessionSecret = env("CLIPFORGE_ADMIN_SESSION_SECRET");
  if (isPlaceholder(password)) fail("admin:password", "CLIPFORGE_ADMIN_PASSWORD 仍是示例占位值");
  else if (password.length < 16) fail("admin:password", "CLIPFORGE_ADMIN_PASSWORD 少于 16 位");
  else pass("admin:password", "后台密码长度符合要求");
  if (isPlaceholder(sessionSecret)) fail("admin:session", "CLIPFORGE_ADMIN_SESSION_SECRET 仍是示例占位值");
  else if (sessionSecret.length < 32) fail("admin:session", "CLIPFORGE_ADMIN_SESSION_SECRET 少于 32 位");
  else pass("admin:session", "后台 session secret 长度符合要求");
  if (password && password === sessionSecret) fail("admin:separation", "后台密码与 session secret 不得相同");
  else pass("admin:separation", "后台密码与 session secret 已隔离");

  requiredEnv("HUIMAI_LEGAL_ENTITY", "运营主体");
  requiredEnv("HUIMAI_LEGAL_CONTACT", "客服/隐私联系渠道");
  requiredEnv("HUIMAI_AI_PROVIDER_DISCLOSURE", "模型服务商披露");
  requiredEnv("HUIMAI_AIGC_SERVICE_PROVIDER", "AIGC 服务提供者标识");
  checkPublicBaseUrl();
  if (env("HUIMAI_TRUST_PROXY") !== "1") {
    fail("proxy:trusted", "生产邀请内测必须显式设置 HUIMAI_TRUST_PROXY=1，并确保应用端口只允许受信反代访问");
  } else if (env("HUIMAI_CLIENT_IP_HEADER").toLowerCase() !== "x-real-ip") {
    fail("proxy:trusted", "HUIMAI_CLIENT_IP_HEADER 必须为 x-real-ip；禁止直接信任 X-Forwarded-For/CF-Connecting-IP");
  } else {
    pass("proxy:trusted", "仅信任受控反代覆盖写入的 X-Real-IP");
  }
  const edgeProbePath = env("HUIMAI_EDGE_BODY_LIMIT_PROBE_PATH");
  if (!/^\/api\/project\/[a-zA-Z0-9-]+\/materials$/.test(edgeProbePath)) {
    fail("edge:probe-path", "HUIMAI_EDGE_BODY_LIMIT_PROBE_PATH 必须指向材料上传路由 /api/project/<安全ID>/materials");
  } else {
    pass("edge:probe-path", "边缘上限探针命中 161 MiB 的最大上传路由");
  }
  checkEdgeBodyLimitEvidence();
  requiredPositiveInteger("HUIMAI_MERCHANT_UPLOAD_MAX_BYTES", "单商户累计上传空间上限");
  checkGoldenEvalEnvironment();
  checkOperationalThresholds();
  if (!env("HUIMAI_MODEL_REVISION_EVIDENCE_DIR")) {
    fail("models:revision-evidence-dir", "HUIMAI_MODEL_REVISION_EVIDENCE_DIR 未配置");
  } else if (!isAbsolute(env("HUIMAI_MODEL_REVISION_EVIDENCE_DIR"))) {
    fail("models:revision-evidence-dir", "模型 revision 证据目录必须是绝对路径");
  } else {
    await checkDirectory(
      "models:revision-evidence-dir",
      env("HUIMAI_MODEL_REVISION_EVIDENCE_DIR"),
      "模型 revision 证据目录",
      false,
    );
  }
  const retentionDays = Number(env("HUIMAI_DATA_RETENTION_DAYS"));
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) fail("legal:retention", "HUIMAI_DATA_RETENTION_DAYS 必须为 1-3650 的整数");
  else pass("legal:retention", `数据保留期为 ${retentionDays} 天`);

  const dataDir = resolve(env("APP_DATA_DIR") || join(ROOT, "data"));
  const backupDir = resolve(env("BACKUP_DIR") || "");
  const migrationsDir = resolve(env("APP_MIGRATIONS_DIR") || join(ROOT, "drizzle"));
  if (!env("APP_DATA_DIR")) fail("path:data:explicit", "生产必须显式配置 APP_DATA_DIR");
  if (!env("BACKUP_DIR")) fail("path:backup:explicit", "生产必须显式配置 BACKUP_DIR");
  const dataReady = await checkDirectory("path:data", dataDir, "数据目录");
  const backupReady = env("BACKUP_DIR") ? await checkDirectory("path:backup", backupDir, "备份目录", false) : false;
  const migrationsReady = await checkDirectory("path:migrations", migrationsDir, "迁移目录", false);
  if (migrationsReady) {
    const migrationFiles = (await readdir(migrationsDir)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    const migrationIssues = productionMigrationDirectoryIssues(migrationFiles);
    if (migrationIssues.length) {
      fail("migrations:jobs", `迁移目录未达到 0026/27 条基线：${migrationIssues.join("；")}`);
    } else {
      pass(
        "migrations:jobs",
        `迁移链包含 ${migrationFiles.length} 个 SQL 文件，已覆盖合成/Golden/分镜动态任务至 0026`,
      );
    }
  }
  if (dataReady && backupReady) {
    const canonicalDataDir = realpathSync(dataDir);
    const canonicalBackupDir = realpathSync(backupDir);
    if (isInside(canonicalDataDir, canonicalBackupDir) || isInside(canonicalBackupDir, canonicalDataDir)) fail("path:isolation", "APP_DATA_DIR 与 BACKUP_DIR 的真实路径不得互相包含");
    else pass("path:isolation", "数据目录与备份目录已隔离");
    const disk = await statfs(dataDir);
    const available = Number(disk.bavail) * Number(disk.bsize);
    const minimum = Number(env("CLIPFORGE_MIN_FREE_DISK_BYTES") || 2 * 1024 * 1024 * 1024);
    if (!Number.isSafeInteger(minimum) || minimum < 0) fail("disk:threshold", "CLIPFORGE_MIN_FREE_DISK_BYTES 不是有效非负整数");
    else if (available < minimum) fail("disk:free", `数据盘可用空间低于阈值（${available} < ${minimum} bytes）`);
    else pass("disk:free", `数据盘可用空间满足阈值（${available} bytes）`);
  }
  if (backupReady) await checkBackupReleaseEvidence(backupDir);

  checkMediaBinaries();
  if (dataReady) await checkDatabase(dataDir);
  const readyUrl = env("HUIMAI_PREFLIGHT_READY_URL");
  try {
    if (!readyUrl) throw new Error("HUIMAI_PREFLIGHT_READY_URL 未配置");
    const parsed = new URL(readyUrl);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
      || !/^\d+$/.test(parsed.port) || Number(parsed.port) < 1 || Number(parsed.port) > 65535
      || parsed.pathname !== "/api/health/ready" || parsed.username || parsed.password
      || parsed.search || parsed.hash) {
      throw new Error("readiness URL 必须精确使用 http://127.0.0.1:<port>/api/health/ready");
    }
    const response = await fetch(parsed, { signal: AbortSignal.timeout(8_000), redirect: "error" });
    const payload = await response.json().catch(() => null);
    if (response.status !== 200 || payload?.status !== "ready") {
      throw new Error(`readiness 必须返回 HTTP 200 和 {\"status\":\"ready\"}，实际 HTTP ${response.status}`);
    }
    if (response.headers.get("x-huimai-code-version") !== env("HUIMAI_CODE_VERSION")) {
      throw new Error("readiness 实例代码版本与 HUIMAI_CODE_VERSION 不一致");
    }
    if (!/no-store/i.test(response.headers.get("cache-control") || "")) {
      throw new Error("readiness 响应缺少 Cache-Control: no-store");
    }
    pass("http:ready", "loopback readiness、JSON 状态与当前代码版本均通过");
  } catch (error) {
    fail("http:ready", `readiness 请求失败：${error instanceof Error ? error.message : String(error)}`);
  }

  for (const item of results) {
    const symbol = item.level === "PASS" ? "✓" : item.level === "WARN" ? "!" : "✗";
    process.stdout.write(`${symbol} [${item.level}] ${item.id}: ${item.message}\n`);
  }
  const failures = results.filter((item) => item.level === "FAIL").length;
  const warnings = results.filter((item) => item.level === "WARN").length;
  process.stdout.write(`\n预检结果：${failures === 0 ? "通过" : "未通过"}；失败 ${failures}，警告 ${warnings}。\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  : false;
if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`预检异常：${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
