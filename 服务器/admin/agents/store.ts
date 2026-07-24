import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { settings } from "@backend/db/schema";
import { MAX_AUDIT_RECORDS, STRATEGY_KEY } from "./constants";
import { defaultState } from "./defaults";
import { sanitizeAgentConfig, sanitizePromotionEvidence } from "./public";
import type {
  AgentConfig,
  AgentErrorCategory,
  AgentEvalRecord,
  AgentId,
  AgentPromptVersion,
  AgentRunRecord,
  AgentStrategyAuditAction,
  AgentStrategyAuditRecord,
  AgentStrategyState,
  AgentTokenUsage,
} from "./types";
import { nowIso, uid } from "./utils";

const ERROR_CATEGORIES = new Set<AgentErrorCategory>([
  "network",
  "timeout",
  "rate_limit",
  "provider_5xx",
  "billing",
  "empty_response",
  "parse",
  "safety",
  "client_4xx",
  "configuration",
  "unknown",
]);

const AUDIT_ACTIONS = new Set<AgentStrategyAuditAction>([
  "legacy_scrubbed",
  "draft_saved",
  "published",
  "rolled_back",
]);

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, fallback = "", maxLength = 2_000) {
  return typeof value === "string" ? value.slice(0, maxLength) : fallback;
}

function finiteNumber(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
}

function intValue(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Math.round(finiteNumber(value, fallback, min, max));
}

/** 旧错误信息可能把 SDK 请求头/密钥带进 JSON，读取时一并脱敏。 */
export function redactAgentLogText(value: unknown) {
  return stringValue(value, "", 4_000)
    .replace(/(authorization\s*[:=]\s*(?:bearer|key)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|key-[A-Za-z0-9_-]{8,})\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|access[_-]?token)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function containsLegacyCredential(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsLegacyCredential);
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) => {
    if (/^(?:api[_-]?key(?:configured)?|access[_-]?token|authorization|credential|password|private[_-]?key|token)$/i.test(key)) {
      return true;
    }
    return containsLegacyCredential(nested);
  });
}

function mergeAgentSlot(
  value: unknown,
  fallbacks: AgentConfig[],
  options: { preservePromotionEvidence: boolean },
): AgentConfig[] {
  const rawAgents = Array.isArray(value) ? value : [];
  return fallbacks.map((fallback) => {
    const raw = rawAgents.find((item) => recordValue(item).id === fallback.id) ?? fallback;
    return sanitizeAgentConfig(raw, fallback, {
      validateEndpoints: false,
      promotionEvidenceSource: options.preservePromotionEvidence ? "value" : "omit",
    });
  });
}

function normalizePrompts(value: unknown, base: AgentPromptVersion[]) {
  const rawPrompts = Array.isArray(value) ? value as AgentPromptVersion[] : [];
  if (!rawPrompts.length) return base;
  return [
    ...rawPrompts,
    ...base.filter((prompt) => !rawPrompts.some((item) => item.agentId === prompt.agentId && item.version === prompt.version)),
  ];
}

function normalizeUsage(value: unknown): AgentTokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const raw = recordValue(value);
  const token = (item: unknown) => typeof item === "number" && Number.isFinite(item)
    ? Math.max(0, Math.round(item))
    : null;
  return {
    inputTokens: token(raw.inputTokens),
    outputTokens: token(raw.outputTokens),
    totalTokens: token(raw.totalTokens),
  };
}

function normalizeRun(value: unknown, agents: AgentConfig[], index: number): AgentRunRecord | null {
  const raw = recordValue(value);
  const agent = agents.find((item) => item.id === raw.agentId);
  if (!agent) return null;
  const success = typeof raw.success === "boolean" ? raw.success : false;
  const endpointRole = raw.endpointRole === "fallback" || raw.endpointRole === "primary"
    ? raw.endpointRole
    : raw.fallbackTriggered
      ? "fallback"
      : "primary";
  const errorCategory = typeof raw.errorCategory === "string" && ERROR_CATEGORIES.has(raw.errorCategory as AgentErrorCategory)
    ? raw.errorCategory as AgentErrorCategory
    : undefined;
  // 旧字段 costEstimateUsd 来自延时猜测，不能当作真实成本沿用。
  const costUsd = typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd)
    ? Math.max(0, raw.costUsd)
    : null;
  const createdAt = stringValue(raw.createdAt, nowIso(), 100);
  const id = stringValue(raw.id, `legacy_run_${index}`, 200);
  return {
    id,
    requestId: stringValue(raw.requestId, id, 200),
    attempt: intValue(raw.attempt, endpointRole === "fallback" ? 2 : 1, 1, 20),
    endpointRole,
    createdAt,
    userLabel: stringValue(raw.userLabel, "unknown", 500),
    agentId: agent.id,
    agentName: stringValue(raw.agentName, agent.name, 200),
    provider: stringValue(raw.provider, "unknown", 200),
    model: stringValue(raw.model, "unknown", 500),
    strategyRevision: intValue(raw.strategyRevision, agent.strategyRevision, 1),
    codeVersion: stringValue(raw.codeVersion, "unknown", 200),
    promptVersion: stringValue(raw.promptVersion, agent.promptVersion, 200),
    fallbackTriggered: Boolean(raw.fallbackTriggered),
    ...(raw.fallbackReason ? { fallbackReason: redactAgentLogText(raw.fallbackReason) } : {}),
    ...(errorCategory ? { errorCategory } : {}),
    success,
    ...(raw.errorReason ? { errorReason: redactAgentLogText(raw.errorReason) } : {}),
    latencyMs: intValue(raw.latencyMs, 0, 0, 86_400_000),
    usage: normalizeUsage(raw.usage),
    costUsd,
    costEstimateUsd: costUsd,
  };
}

function normalizeAudit(value: unknown): AgentStrategyAuditRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const raw = recordValue(item);
    if (typeof raw.action !== "string" || !AUDIT_ACTIONS.has(raw.action as AgentStrategyAuditAction)) return [];
    const record: AgentStrategyAuditRecord = {
      id: stringValue(raw.id, `legacy_audit_${index}`, 200),
      createdAt: stringValue(raw.createdAt, nowIso(), 100),
      action: raw.action as AgentStrategyAuditAction,
      revision: intValue(raw.revision, 1, 1),
      summary: redactAgentLogText(raw.summary),
    };
    if (typeof raw.agentId === "string") record.agentId = raw.agentId as AgentId;
    if (typeof raw.fromRevision === "number") record.fromRevision = intValue(raw.fromRevision, 1, 1);
    return [record];
  }).slice(0, MAX_AUDIT_RECORDS);
}

function needsCanonicalRewrite(raw: Record<string, unknown>) {
  if (!("strategyRevision" in raw) || !Array.isArray(raw.draftAgents) || !raw.previousAgents || !Array.isArray(raw.audit)) return true;
  if (containsLegacyCredential(raw)) return true;
  const rawOnlineAgents = Array.isArray(raw.agents) ? raw.agents : [];
  if (rawOnlineAgents.some((agent) => {
    const item = recordValue(agent);
    if (!("promotionEvidence" in item)) return false;
    return JSON.stringify(item.promotionEvidence) !== JSON.stringify(sanitizePromotionEvidence(item.promotionEvidence));
  })) return true;
  if (Array.isArray(raw.draftAgents)
    && raw.draftAgents.some((agent) => "promotionEvidence" in recordValue(agent))) return true;
  if (Object.values(recordValue(raw.previousAgents)).some((agent) => {
    const item = recordValue(agent);
    if (!("promotionEvidence" in item)) return false;
    return JSON.stringify(item.promotionEvidence) !== JSON.stringify(sanitizePromotionEvidence(item.promotionEvidence));
  })) return true;
  const slots = [raw.agents, raw.draftAgents, ...Object.values(recordValue(raw.previousAgents))];
  if (slots.some((slot) => {
    const agents = Array.isArray(slot) ? slot : [slot];
    return agents.some((agent) => {
      const item = recordValue(agent);
      return !recordValue(item.primary).secretRef || !recordValue(item.fallback).secretRef || "previous" in item;
    });
  })) return true;
  return Array.isArray(raw.runs) && raw.runs.some((run) => {
    const item = recordValue(run);
    return !("requestId" in item) || !("costUsd" in item) || item.costEstimateUsd !== item.costUsd;
  });
}

export function normalizeAgentStrategyState(value: unknown): {
  state: AgentStrategyState;
  shouldRewrite: boolean;
  scrubbedCredential: boolean;
} {
  const base = defaultState();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { state: base, shouldRewrite: false, scrubbedCredential: false };
  }
  const raw = value as Record<string, unknown>;
  const scrubbedCredential = containsLegacyCredential(raw);
  const strategyRevision = intValue(raw.strategyRevision, base.strategyRevision, 1);
  const agents = mergeAgentSlot(raw.agents, base.agents, { preservePromotionEvidence: true });
  const draftAgents = mergeAgentSlot(
    Array.isArray(raw.draftAgents) ? raw.draftAgents : raw.agents,
    agents,
    { preservePromotionEvidence: false },
  );
  const rawPrevious = recordValue(raw.previousAgents);
  const previousAgents: Partial<Record<AgentId, AgentConfig>> = {};
  for (const onlineAgent of agents) {
    const legacyOnline = Array.isArray(raw.agents)
      ? raw.agents.find((item) => recordValue(item).id === onlineAgent.id)
      : undefined;
    const previous = rawPrevious[onlineAgent.id] ?? recordValue(legacyOnline).previous;
    if (previous) {
      previousAgents[onlineAgent.id] = sanitizeAgentConfig(previous, onlineAgent, {
        validateEndpoints: false,
        promotionEvidenceSource: "value",
      });
    }
  }

  const prompts = normalizePrompts(raw.prompts, base.prompts);
  const runs = (Array.isArray(raw.runs) ? raw.runs : [])
    .map((run, index) => normalizeRun(run, agents, index))
    .filter((run): run is AgentRunRecord => Boolean(run));
  const audit = normalizeAudit(raw.audit);
  if (scrubbedCredential) {
    audit.unshift({
      id: uid("audit"),
      createdAt: nowIso(),
      action: "legacy_scrubbed",
      revision: strategyRevision,
      summary: "已从旧模型策略 JSON 中移除明文凭据，端点改用受控 secretRef",
    });
  }

  const state: AgentStrategyState = {
    strategyRevision,
    onlineVersion: stringValue(raw.onlineVersion, base.onlineVersion, 200),
    draftVersion: stringValue(raw.draftVersion, base.draftVersion, 200),
    publishedAt: stringValue(raw.publishedAt, base.publishedAt, 100),
    agents,
    draftAgents,
    previousAgents,
    prompts,
    runs,
    evals: Array.isArray(raw.evals) ? raw.evals as AgentEvalRecord[] : base.evals,
    audit: audit.slice(0, MAX_AUDIT_RECORDS),
  };
  return {
    state,
    shouldRewrite: needsCanonicalRewrite(raw),
    scrubbedCredential,
  };
}

function canonicalState(value: AgentStrategyState) {
  return normalizeAgentStrategyState(value).state;
}

function readRawState(db = getDb()) {
  return db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, STRATEGY_KEY))
    .limit(1)
    .all()[0]?.value;
}

function writeState(nextState: AgentStrategyState, db = getDb()) {
  db.insert(settings)
    .values({ key: STRATEGY_KEY, value: nextState, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: nextState, updatedAt: new Date() },
    })
    .run();
  return nextState;
}

export async function getAgentStrategy(): Promise<AgentStrategyState> {
  const normalized = normalizeAgentStrategyState(readRawState());
  // 读旧状态时立即以受控格式覆写，缩短明文凭据在 settings JSON 中的存留时间。
  if (normalized.shouldRewrite) writeState(normalized.state);
  return normalized.state;
}

export async function saveAgentStrategy(nextState: AgentStrategyState) {
  return writeState(canonicalState(nextState));
}

/** SQLite 事务内读-改-写，发布/回滚/运行记录不会互相覆盖。 */
export async function mutateAgentStrategy(
  mutate: (current: AgentStrategyState) => AgentStrategyState,
) {
  const db = getDb();
  return db.transaction((tx) => {
    const raw = tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, STRATEGY_KEY))
      .limit(1)
      .all()[0]?.value;
    const current = normalizeAgentStrategyState(raw).state;
    const next = canonicalState(mutate(current));
    tx.insert(settings)
      .values({ key: STRATEGY_KEY, value: next, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value: next, updatedAt: new Date() },
      })
      .run();
    return next;
  });
}
