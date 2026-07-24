import { NextRequest, NextResponse } from "next/server";

import { isAdminRequest } from "@server/admin/admin-auth";
import {
  consumeRateLimit,
  rateLimitResponse,
  requestClientIp,
} from "@backend/core/security/rate-limit";
import {
  endpointReady,
  getAgentStrategy,
  publicAgents,
  redactAgentLogText,
  toLLMConfig,
  type AgentEndpointRole,
  type AgentEvalRecord,
  type AgentId,
} from "@server/admin/agents";
import {
  addEvalRecords,
  createEvalRecord,
  deleteEvalRecord,
  updateEvalRecord,
} from "@server/admin/evals";
import {
  getGoldenCase,
  validateGoldenSetIntegrity,
  type JsonGoldenCase,
} from "@server/admin/evals/golden-set";
import {
  deleteGoldenArtifacts,
  acquireGoldenEvaluationLease,
  cleanupGoldenArtifactOrphans,
  GoldenEvaluationBusyError,
  verifyGoldenArtifacts,
} from "@server/admin/evals/artifacts";
import { scoreHumanMediaCase } from "@server/admin/evals/scoring";
import {
  assertGoldenMediaCandidateReady,
  buildPromotionSummaries,
  candidateBindingFor,
  effectiveCandidateModel,
  getGoldenCaseReadiness,
  listGoldenCaseDtos,
  runGoldenJsonCase,
} from "@server/admin/evals/runner";
import {
  enqueueGoldenMediaEvalJobs,
  GoldenMediaJobIdempotencyConflictError,
  GoldenMediaJobInputError,
  GoldenMediaJobQueueLimitError,
  listGoldenMediaEvalJobs,
  normalizeGoldenMediaIdempotencyKey,
  prepareGoldenMediaEvalJobs,
  toGoldenMediaEvalJobDto,
} from "@server/admin/evals/media-jobs";
import { getAgentPrompt } from "@server/admin/prompts";

const CANDIDATE_ROLES = new Set<AgentEndpointRole>(["primary", "fallback"]);

function json(payload: unknown, init?: ResponseInit) {
  const response = NextResponse.json(payload, init);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

async function evalsPayload(state: Awaited<ReturnType<typeof getAgentStrategy>>) {
  const integrityIssues = validateGoldenSetIntegrity();
  return {
    strategyRevision: state.strategyRevision,
    draftVersion: state.draftVersion,
    onlineVersion: state.onlineVersion,
    // 评测入口只读 draft；普通生成链路仍只读 online。
    agents: publicAgents(state.draftAgents),
    onlineAgents: publicAgents(state.agents),
    prompts: state.prompts,
    evals: state.evals,
    mediaJobs: listGoldenMediaEvalJobs().map(toGoldenMediaEvalJobDto),
    golden: {
      integrityPassed: integrityIssues.length === 0,
      integrityIssues,
      cases: await listGoldenCaseDtos(),
      promotions: buildPromotionSummaries(state),
    },
  };
}

function parseCandidateRoles(body: Record<string, unknown>): AgentEndpointRole[] | null {
  const raw = Array.isArray(body.candidateRoles)
    ? body.candidateRoles
    : Array.isArray(body.candidates)
      ? body.candidates
      : ["primary"];
  if (!raw.length || raw.some((item) => typeof item !== "string" || !CANDIDATE_ROLES.has(item as AgentEndpointRole))) {
    return null;
  }
  return [...new Set(raw)] as AgentEndpointRole[];
}

function integrityFailure() {
  const issues = validateGoldenSetIntegrity();
  return issues.length ? json({ error: "Golden Set 完整性校验失败", issues }, { status: 503 }) : null;
}

function mediaJobErrorResponse(error: unknown) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "GOLDEN_MEDIA_JOB_REJECTED";
  const message = redactAgentLogText(error instanceof Error ? error.message : error);
  if (error instanceof GoldenMediaJobInputError) {
    return json({ error: message, code }, { status: 400 });
  }
  if (error instanceof GoldenMediaJobIdempotencyConflictError) {
    return json({ error: message, code }, { status: 409 });
  }
  if (error instanceof GoldenMediaJobQueueLimitError) {
    return json({ error: message, code }, { status: 429 });
  }
  return json({ error: message, code }, { status: 422 });
}

async function evaluationLeaseOrResponse() {
  try {
    return { release: await acquireGoldenEvaluationLease(), response: null };
  } catch (error) {
    if (error instanceof GoldenEvaluationBusyError) {
      return {
        release: null,
        response: json({ error: error.message, code: "GOLDEN_EVAL_BUSY" }, { status: 429 }),
      };
    }
    throw error;
  }
}

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) return json({ error: "Unauthorized" }, { status: 401 });
  return json(await evalsPayload(await getAgentStrategy()));
}

export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) return json({ error: "Unauthorized" }, { status: 401 });
  const limit = consumeRateLimit(`admin:model-evals:${requestClientIp(req)}`, {
    limit: 20,
    windowMs: 15 * 60_000,
  });
  if (!limit.allowed) return rateLimitResponse(limit, "模型评测请求过于频繁，未发起新的付费请求");
  const invalidGoldenSet = integrityFailure();
  if (invalidGoldenSet) return invalidGoldenSet;

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return json({ error: "评测数据格式不正确" }, { status: 400 });
  const agentId = typeof body.agentId === "string" ? body.agentId as AgentId : null;
  const caseId = typeof body.caseId === "string" ? body.caseId : null;
  const roles = parseCandidateRoles(body);
  if (!agentId || !caseId || !roles) {
    return json({ error: "必须提供 agentId、caseId 和非空的 primary/fallback 候选槽" }, { status: 400 });
  }

  let goldenCase;
  try {
    goldenCase = getGoldenCase(caseId);
  } catch {
    return json({ error: "未知 Golden case" }, { status: 404 });
  }
  if (goldenCase.agentId !== agentId) {
    return json({ error: "Golden case 与 Agent 不匹配" }, { status: 409 });
  }
  let mediaOperationKey: string | null = null;
  if (goldenCase.outputKind === "media") {
    try {
      mediaOperationKey = normalizeGoldenMediaIdempotencyKey(req.headers.get("idempotency-key") || "");
    } catch (error) {
      return mediaJobErrorResponse(error);
    }
  }
  const readiness = await getGoldenCaseReadiness(goldenCase);
  if (!readiness.ready) {
    return json({
      error: readiness.reason,
      code: "GOLDEN_CASE_NOT_READY",
      caseId: goldenCase.id,
    }, { status: 422 });
  }
  const state = await getAgentStrategy();
  const agent = state.draftAgents.find((item) => item.id === agentId);
  if (!agent) return json({ error: "未找到 Agent 草稿配置" }, { status: 404 });
  const requestedPromptVersion = typeof body.promptVersion === "string" ? body.promptVersion.trim() : "";
  if (requestedPromptVersion && requestedPromptVersion !== agent.promptVersion) {
    return json({
      error: `候选评测只能使用当前 draft prompt ${agent.promptVersion}，请先保存草稿`,
    }, { status: 409 });
  }
  const promptVersion = agent.promptVersion;
  const prompt = getAgentPrompt(state, agentId, promptVersion);

  // 所有候选端点在任一付费请求前整体预检，避免半组评测。
  const prepared = [] as Array<{
    role: AgentEndpointRole;
    config: ReturnType<typeof toLLMConfig>;
    binding: ReturnType<typeof candidateBindingFor>;
  }>;
  for (const role of roles) {
    const endpoint = agent[role];
    if (!endpointReady(endpoint)) {
      return json({
        error: `draft ${role} 候选端点或对应凭据未就绪，未发起任何模型请求`,
        code: "CANDIDATE_NOT_READY",
        candidateRole: role,
      }, { status: 422 });
    }
    try {
      const config = toLLMConfig(endpoint);
      if (goldenCase.outputKind === "media") {
        assertGoldenMediaCandidateReady(goldenCase, config);
      }
      const requestKind = getRequestKind(goldenCase);
      prepared.push({ role, config, binding: candidateBindingFor(state, agent, role, requestKind) });
    } catch (error) {
      return json({
        error: `draft ${role} 候选端点未通过安全策略：${redactAgentLogText(error instanceof Error ? error.message : error)}`,
        code: "CANDIDATE_NOT_READY",
        candidateRole: role,
      }, { status: 422 });
    }
  }

  let releaseEvaluationLease: (() => Promise<void>) | null = null;
  try {
    releaseEvaluationLease = await acquireGoldenEvaluationLease();
  } catch (error) {
    if (error instanceof GoldenEvaluationBusyError) {
      return json({ error: error.message, code: "GOLDEN_EVAL_BUSY" }, { status: 429 });
    }
    throw error;
  }

  try {
    // 在任一付费请求前清理崩溃遗留；孤儿文件有宽限期，不会误删刚生成的产物。
    await cleanupGoldenArtifactOrphans(state.evals);
    if (goldenCase.outputKind === "media") {
      try {
        // 该事务在 worker 可能 claim 任一候选之前，先把同批 primary/fallback
        // 的冻结候选、指纹和幂等键全部持久化。HTTP 请求内不再调用付费媒体端点。
        const inputs = await prepareGoldenMediaEvalJobs({
          operationKey: mediaOperationKey!,
          agentId,
          caseId: goldenCase.id,
          candidateRoles: roles,
          promptVersion,
          state,
        });
        const queued = enqueueGoldenMediaEvalJobs(inputs);
        return json({
          accepted: true,
          jobs: queued.map(({ job, duplicate }) => ({
            ...toGoldenMediaEvalJobDto(job),
            duplicate,
          })),
          golden: { promotions: buildPromotionSummaries(state) },
        }, {
          status: 202,
          headers: {
            Location: "/api/admin/model-evals",
            "Retry-After": "3",
          },
        });
      } catch (error) {
        return mediaJobErrorResponse(error);
      }
    }
    const results: AgentEvalRecord[] = [];
    for (const { role, config, binding } of prepared) {
      const endpoint = agent[role];
      const requestKind = getRequestKind(goldenCase);
      const candidateModel = effectiveCandidateModel(agent, role, requestKind);
      const started = Date.now();
      try {
        const result = await runGoldenJsonCase(goldenCase as JsonGoldenCase, config, prompt);
        results.push(createEvalRecord({
          agentId,
          candidateModel,
          provider: endpoint.provider,
          promptVersion,
          testCase: goldenCase.name,
          output: result.output,
          latencyMs: result.latencyMs,
          errored: false,
          jsonParsed: result.score.parsed,
          evaluationKind: "golden",
          status: "completed",
          caseId: goldenCase.id,
          ...binding,
          candidateRole: role,
          requestKind,
          structurePassed: result.score.structurePassed,
          qualityScore: result.score.qualityScore,
          actualCostUsd: result.actualCostUsd,
          artifactUrls: [],
          criteria: result.score.criteria,
          reviewIssues: result.score.issues.map((issue) => issue.message),
          score: result.score.qualityScore / 10,
        }));
      } catch {
        results.push(createEvalRecord({
          agentId,
          candidateModel,
          provider: endpoint.provider,
          promptVersion,
          testCase: goldenCase.name,
          output: "模型执行失败；供应商错误正文未持久化",
          latencyMs: Date.now() - started,
          errored: true,
          jsonParsed: false,
          evaluationKind: "golden",
          status: "failed",
          caseId: goldenCase.id,
          ...binding,
          candidateRole: role,
          requestKind,
          structurePassed: false,
          qualityScore: 0,
          actualCostUsd: null,
          artifactUrls: [],
          criteria: [],
          reviewIssues: ["模型执行失败"],
          score: 0,
        }));
      }
    }

    let saved;
    try {
      saved = await addEvalRecords(results);
    } catch (error) {
      await Promise.all(results.map((record) => deleteGoldenArtifacts(record.id, record.artifactUrls ?? [])));
      throw error;
    }
    const retainedIds = new Set(saved.evals.map((record) => record.id));
    await Promise.all(state.evals
      .filter((record) => !retainedIds.has(record.id))
      .map((record) => deleteGoldenArtifacts(record.id, record.artifactUrls ?? [])));
    return json({ results, golden: { promotions: buildPromotionSummaries(saved) } });
  } finally {
    await releaseEvaluationLease();
  }
}

export async function PATCH(req: NextRequest) {
  if (!isAdminRequest(req)) return json({ error: "Unauthorized" }, { status: 401 });
  const invalidGoldenSet = integrityFailure();
  if (invalidGoldenSet) return invalidGoldenSet;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const evalId = typeof body?.evalId === "string" ? body.evalId : "";
  const scores = body?.scores && typeof body.scores === "object" && !Array.isArray(body.scores)
    ? body.scores as Record<string, number>
    : null;
  if (!evalId || !scores) return json({ error: "必须提供 evalId 和 rubric scores" }, { status: 400 });

  const lease = await evaluationLeaseOrResponse();
  if (lease.response) return lease.response;
  try {
  const state = await getAgentStrategy();
  const record = state.evals.find((item) => item.id === evalId);
  if (!record || record.evaluationKind !== "golden" || !record.caseId) {
    return json({ error: "Golden 评测记录不存在" }, { status: 404 });
  }
  let goldenCase;
  try {
    goldenCase = getGoldenCase(record.caseId);
  } catch {
    return json({ error: "Golden case 已不存在，不能人工评分" }, { status: 409 });
  }
  if (goldenCase.outputKind !== "media") {
    return json({ error: "JSON Golden case 使用自动评分，不接受人工 rubric 覆盖" }, { status: 409 });
  }
  if (record.errored || (record.status !== "awaiting-human-review" && record.status !== "completed")) {
    return json({ error: "只能对已生成实际产物的媒体评测记录打分" }, { status: 409 });
  }
  const artifactUrls = Array.isArray(record.artifactUrls)
    ? record.artifactUrls.filter((url): url is string => typeof url === "string")
    : [];
  const artifactMetadata = Array.isArray(record.artifactMetadata) ? record.artifactMetadata : [];
  try {
    await verifyGoldenArtifacts(
      record.id,
      artifactUrls,
      goldenCase.requiredShape.mediaType,
      artifactMetadata,
    );
  } catch {
    return json({ error: "评测产物不存在、类型不匹配或不属于该记录，不能人工评分" }, { status: 409 });
  }
  const review = scoreHumanMediaCase(goldenCase, {
    mediaType: goldenCase.requiredShape.mediaType,
    artifactCount: artifactUrls.length,
    scores,
  });
  if (!review.reviewComplete || review.qualityScore === null) {
    return json({ error: "人工评分未完整", issues: review.issues }, { status: 400 });
  }

  const saved = await updateEvalRecord(evalId, (current) => ({
    ...current,
    status: "completed",
    structurePassed: null,
    qualityScore: review.qualityScore,
    score: review.qualityScore === null ? undefined : review.qualityScore / 10,
    humanScores: { ...scores },
    criteria: review.criteria,
    reviewIssues: review.issues,
  }));
  const updated = saved.evals.find((item) => item.id === evalId);
  return json({ record: updated, golden: { promotions: buildPromotionSummaries(saved) } });
  } finally {
    await lease.release();
  }
}

export async function DELETE(req: NextRequest) {
  if (!isAdminRequest(req)) return json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const evalId = typeof body?.evalId === "string" ? body.evalId : "";
  if (!evalId) return json({ error: "必须提供 evalId" }, { status: 400 });

  const lease = await evaluationLeaseOrResponse();
  if (lease.response) return lease.response;
  try {
  const state = await getAgentStrategy();
  const record = state.evals.find((item) => item.id === evalId);
  if (!record) return json({ error: "评测记录不存在" }, { status: 404 });
  const saved = await deleteEvalRecord(evalId);
  await deleteGoldenArtifacts(evalId, record.artifactUrls ?? []);
  await cleanupGoldenArtifactOrphans(saved.evals, { orphanGraceMs: 0 });
  return json({ ok: true, evalId, golden: { promotions: buildPromotionSummaries(saved) } });
  } finally {
    await lease.release();
  }
}

function getRequestKind(goldenCase: ReturnType<typeof getGoldenCase>) {
  if (goldenCase.familyId === "script-topic" || goldenCase.familyId === "structured-short") return "chat-json" as const;
  if (goldenCase.familyId === "vision-ocr") return "vision-json" as const;
  if (goldenCase.familyId === "image-generation") return "image-generation" as const;
  if (goldenCase.familyId === "video-generation") return "video-generation" as const;
  return "tts-generation" as const;
}
