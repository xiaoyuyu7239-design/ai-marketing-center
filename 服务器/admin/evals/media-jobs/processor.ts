import "server-only";

import { generateSpeech, type TTSConfig } from "@backend/core/media/tts";
import { ProviderError } from "@backend/providers";
import { MAX_EVALS } from "@server/admin/agents/constants";
import { getAgentStrategy, mutateAgentStrategy } from "@server/admin/agents/store";
import type {
  AgentEvalArtifactMetadata,
  AgentEvalRecord,
} from "@server/admin/agents/types";
import { nowIso } from "@server/admin/agents/utils";
import {
  acquireGoldenEvaluationLease,
  deleteGoldenArtifacts,
  GoldenEvaluationBusyError,
  storeGoldenAudioArtifact,
  storeGoldenRemoteArtifacts,
  verifyGoldenArtifacts,
} from "../artifacts";
import { extractActualCostUsd } from "../runner";
import {
  buildGoldenMediaProviderConnection,
  buildGoldenMediaProviderRequest,
  buildGoldenTtsOneShotRequest,
  goldenMediaJobBinding,
  goldenMediaJobConstraints,
  type GoldenMediaJobConstraints,
} from "./preparation";
import {
  GoldenMediaSubmissionUncertainError,
  pollGoldenMediaTask,
  submitGoldenMediaTask,
} from "./provider-adapter";
import {
  completeReconciledGoldenTtsEvalJob,
  GoldenMediaJobRetryableError,
  GoldenMediaPreSubmitRetryableError,
  listGoldenTtsJobsForReconciliation,
  type GoldenMediaEvalJobRecord,
} from "./repository";
import type { GoldenMediaJobPollOutcome } from "./worker";

function assertOutputConstraints(
  constraints: GoldenMediaJobConstraints,
  artifacts: readonly AgentEvalArtifactMetadata[],
) {
  const expectedCount = constraints.expectedArtifactCount;
  if (!Number.isInteger(expectedCount) || artifacts.length !== expectedCount) {
    throw new Error(`实际媒体评测产物应为 ${expectedCount} 个`);
  }
  if (artifacts.length < constraints.minimumArtifacts) {
    throw new Error("实际媒体评测产物数量不足");
  }
  for (const artifact of artifacts) {
    if (artifact.mediaType !== constraints.mediaType) {
      throw new Error("评测产物媒体类型与 Golden case 不一致");
    }
    if (artifact.mediaType === "image" || artifact.mediaType === "video") {
      const width = artifact.probe.width;
      const height = artifact.probe.height;
      if (!width || !height) throw new Error("媒体评测产物缺少实际尺寸");
      if (constraints.aspectRatio === "9:16") {
        const target = 9 / 16;
        if (Math.abs(width / height - target) / target > 0.04) {
          throw new Error("媒体评测产物实际比例不是可接受的 9:16");
        }
      }
    }
    if (artifact.mediaType === "video") {
      const expectedDuration = constraints.durationSeconds;
      if (!expectedDuration) throw new Error("视频评测任务缺少冻结时长约束");
      const duration = artifact.probe.durationSeconds;
      if (!duration || Math.abs(duration - expectedDuration) > 1) {
        throw new Error(`媒体评测视频实际时长应为 ${expectedDuration}±1 秒`);
      }
    }
    if (artifact.mediaType === "audio") {
      const range = constraints.durationRangeSeconds;
      const duration = artifact.probe.durationSeconds;
      if (!range || !duration || duration < range[0] || duration > range[1]) {
        throw new Error("评测 TTS 实际时长不在 Golden case 锁定范围内");
      }
    }
  }
}

function resultPayload(record: AgentEvalRecord) {
  return {
    evalId: record.id,
    status: record.status,
    actualCostUsd: record.actualCostUsd ?? null,
    artifactMetadata: record.artifactMetadata ?? [],
  };
}

async function completedRecordOutcome(
  job: GoldenMediaEvalJobRecord,
  record: AgentEvalRecord,
  constraints: GoldenMediaJobConstraints,
): Promise<GoldenMediaJobPollOutcome> {
  const binding = goldenMediaJobBinding(job);
  if (
    record.evaluationKind !== "golden"
    || (record.status !== "awaiting-human-review" && record.status !== "completed")
    || record.errored
    || record.caseId !== job.caseId
    || record.candidateKey !== binding.candidateKey
    || record.evaluationFingerprint !== binding.evaluationFingerprint
  ) throw new Error("同 ID 的媒体评测记录与持久 job 绑定不一致");
  const urls = record.artifactUrls ?? [];
  const metadata = record.artifactMetadata ?? [];
  await verifyGoldenArtifacts(record.id, urls, constraints.mediaType, metadata);
  assertOutputConstraints(constraints, metadata);
  return { state: "completed", result: resultPayload(record), artifactUrls: urls };
}

function artifactFailureIsRetryable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /下载失败（(?:408|425|429|5\d\d)）|fetch failed|network|ECONN|ENOTFOUND|EAI_AGAIN|超时/i.test(message);
}

async function persistCompletedRecord(
  job: GoldenMediaEvalJobRecord,
  constraints: GoldenMediaJobConstraints,
  remoteUrls: string[],
  taskStatus: Parameters<typeof extractActualCostUsd>[0],
) {
  let releaseEvaluationLease: (() => Promise<void>) | null = null;
  try {
    releaseEvaluationLease = await acquireGoldenEvaluationLease();
  } catch (error) {
    if (error instanceof GoldenEvaluationBusyError) throw new GoldenMediaJobRetryableError();
    throw error;
  }

  try {
    // 远程任务已付费完成；在同一跨进程 lease 内二次查重，再写产物和评测记录，
    // 与人工评分、删除、孤儿清理保持相同的互斥语义。
    const lockedState = await getAgentStrategy();
    const existing = lockedState.evals.find((item) => item.id === job.id);
    if (existing) return await completedRecordOutcome(job, existing, constraints);

    const expectedType = constraints.mediaType;
    if (expectedType !== "image" && expectedType !== "video") {
      throw new Error("持久媒体 worker 不支持该产物类型");
    }

    let artifacts: AgentEvalArtifactMetadata[] = [];
    try {
      artifacts = await storeGoldenRemoteArtifacts(job.id, expectedType, remoteUrls);
      assertOutputConstraints(constraints, artifacts);
    } catch (error) {
      await deleteGoldenArtifacts(job.id, artifacts.map((artifact) => artifact.url));
      if (artifactFailureIsRetryable(error)) throw new GoldenMediaJobRetryableError();
      throw error;
    }

    const binding = goldenMediaJobBinding(job);
    const latencyMs = Math.max(0, Date.now() - (job.startedAt?.getTime() ?? Date.now()));
    const record: AgentEvalRecord = {
      id: job.id,
      createdAt: nowIso(),
      agentId: job.agentId as AgentEvalRecord["agentId"],
      candidateModel: job.model,
      provider: job.provider,
      promptVersion: job.promptVersion,
      testCase: constraints.caseName,
      output: `已生成 ${artifacts.length} 个 ${expectedType} 评测产物，等待人工 rubric 评审`,
      latencyMs,
      errored: false,
      jsonParsed: false,
      evaluationKind: "golden",
      status: "awaiting-human-review",
      caseId: job.caseId,
      candidateKey: binding.candidateKey,
      candidateRole: job.candidateRole,
      requestKind: job.requestKind,
      structurePassed: null,
      qualityScore: null,
      actualCostUsd: extractActualCostUsd(taskStatus),
      artifactUrls: artifacts.map((artifact) => artifact.url),
      artifactMetadata: artifacts,
      evaluationFingerprint: binding.evaluationFingerprint,
      promptContentSha256: binding.promptContentSha256,
      draftConfigSha256: binding.draftConfigSha256,
      goldenSetSha256: binding.goldenSetSha256,
      codeVersion: binding.codeVersion,
      criteria: [],
      reviewIssues: ["等待人工 rubric 评审"],
    };
    try {
      await mutateAgentStrategy((state) => ({
        ...state,
        evals: [record, ...state.evals.filter((item) => item.id !== record.id)].slice(0, MAX_EVALS),
      }));
    } catch (error) {
      await deleteGoldenArtifacts(job.id, record.artifactUrls ?? []);
      throw error;
    }
    return {
      state: "completed" as const,
      result: resultPayload(record),
      artifactUrls: record.artifactUrls ?? [],
    };
  } finally {
    await releaseEvaluationLease();
  }
}

async function persistCompletedTtsRecordWithLeaseHeld(
  job: GoldenMediaEvalJobRecord,
  constraints: GoldenMediaJobConstraints,
  audio: Buffer,
): Promise<GoldenMediaJobPollOutcome> {
  if (constraints.mediaType !== "audio") throw new Error("TTS job 产物约束不是 audio");
  const lockedState = await getAgentStrategy();
  const existing = lockedState.evals.find((item) => item.id === job.id);
  if (existing) return completedRecordOutcome(job, existing, constraints);

  let artifacts: AgentEvalArtifactMetadata[] = [];
  try {
    artifacts = await storeGoldenAudioArtifact(job.id, audio);
    assertOutputConstraints(constraints, artifacts);
  } catch (error) {
    await deleteGoldenArtifacts(job.id, artifacts.map((artifact) => artifact.url));
    throw error;
  }

  const binding = goldenMediaJobBinding(job);
  const record: AgentEvalRecord = {
    id: job.id,
    createdAt: nowIso(),
    agentId: job.agentId as AgentEvalRecord["agentId"],
    candidateModel: job.model,
    provider: job.provider,
    promptVersion: job.promptVersion,
    testCase: constraints.caseName,
    output: "已生成 1 个 audio 评测产物，等待人工 rubric 评审",
    latencyMs: Math.max(0, Date.now() - (job.startedAt?.getTime() ?? Date.now())),
    errored: false,
    jsonParsed: false,
    evaluationKind: "golden",
    status: "awaiting-human-review",
    caseId: job.caseId,
    candidateKey: binding.candidateKey,
    candidateRole: job.candidateRole,
    requestKind: job.requestKind,
    structurePassed: null,
    qualityScore: null,
    // 现有 TTS API 不回传可验证的计费数据，必须保持未知，不伪造为 0。
    actualCostUsd: null,
    artifactUrls: artifacts.map((artifact) => artifact.url),
    artifactMetadata: artifacts,
    evaluationFingerprint: binding.evaluationFingerprint,
    promptContentSha256: binding.promptContentSha256,
    draftConfigSha256: binding.draftConfigSha256,
    goldenSetSha256: binding.goldenSetSha256,
    codeVersion: binding.codeVersion,
    criteria: [],
    reviewIssues: ["等待人工 rubric 评审"],
  };
  try {
    await mutateAgentStrategy((state) => ({
      ...state,
      evals: [record, ...state.evals.filter((item) => item.id !== record.id)].slice(0, MAX_EVALS),
    }));
  } catch (error) {
    await deleteGoldenArtifacts(job.id, record.artifactUrls ?? []);
    throw error;
  }
  return {
    state: "completed",
    result: resultPayload(record),
    artifactUrls: record.artifactUrls ?? [],
  };
}

export async function executePersistedGoldenTtsEvalJob(
  job: GoldenMediaEvalJobRecord,
): Promise<GoldenMediaJobPollOutcome> {
  if (job.status !== "submitting" || job.remoteTaskId || job.requestKind !== "tts-generation") {
    throw new Error("只有无 taskId 的 submitting TTS 任务才允许执行 one-shot");
  }

  const request = await buildGoldenTtsOneShotRequest(job);
  let releaseEvaluationLease: (() => Promise<void>) | null = null;
  try {
    // 必须在付费请求前拿到与评分/删除相同的 lease。busy 明确发生在 POST 前，可安全退回 pending。
    releaseEvaluationLease = await acquireGoldenEvaluationLease();
  } catch (error) {
    if (error instanceof GoldenEvaluationBusyError) throw new GoldenMediaPreSubmitRetryableError();
    throw error;
  }

  try {
    let audio: Buffer;
    try {
      audio = await generateSpeech(request.text, {
        provider: request.provider as TTSConfig["provider"],
        baseUrl: request.baseUrl,
        apiKey: request.apiKey,
        model: request.model,
        voice: request.voice,
        speed: request.speed,
        groupId: request.groupId,
      }, { bypassCache: true });
    } catch (error) {
      if (error instanceof ProviderError && error.code === "SUBMISSION_UNCERTAIN") {
        throw new GoldenMediaSubmissionUncertainError(job.provider);
      }
      throw error;
    }
    return await persistCompletedTtsRecordWithLeaseHeld(
      job,
      goldenMediaJobConstraints(job),
      audio,
    );
  } finally {
    await releaseEvaluationLease();
  }
}

/**
 * 收敛“音频+AgentEvalRecord 已落盘，但 SQLite 终态 checkpoint 前崩溃”的极小窗口。
 * 只做本地深校验与终态回写，绝不调用 TTS 供应商。
 */
export async function reconcilePersistedGoldenTtsEvalJob(): Promise<boolean> {
  const jobs = listGoldenTtsJobsForReconciliation();
  if (!jobs.length) return false;
  const state = await getAgentStrategy();
  for (const job of jobs) {
    if (!state.evals.some((item) => item.id === job.id)) continue;

    let releaseEvaluationLease: (() => Promise<void>) | null = null;
    try {
      releaseEvaluationLease = await acquireGoldenEvaluationLease();
    } catch (error) {
      if (error instanceof GoldenEvaluationBusyError) return false;
      throw error;
    }
    try {
      const lockedState = await getAgentStrategy();
      const record = lockedState.evals.find((item) => item.id === job.id);
      if (!record) continue;
      const outcome = await completedRecordOutcome(job, record, goldenMediaJobConstraints(job));
      if (outcome.state !== "completed") continue;
      return Boolean(completeReconciledGoldenTtsEvalJob(
        job.id,
        outcome.result,
        outcome.artifactUrls,
      ));
    } finally {
      await releaseEvaluationLease();
    }
  }
  return false;
}

export async function submitPersistedGoldenMediaEvalJob(
  job: GoldenMediaEvalJobRecord,
): Promise<string> {
  if (job.status !== "submitting" || job.remoteTaskId) {
    throw new Error("只有无 taskId 的 submitting 任务才允许发起付费提交");
  }
  const request = await buildGoldenMediaProviderRequest(job);
  return submitGoldenMediaTask(request);
}

export async function pollPersistedGoldenMediaEvalJob(
  job: GoldenMediaEvalJobRecord,
): Promise<GoldenMediaJobPollOutcome> {
  if (job.status !== "polling" || !job.remoteTaskId) {
    throw new Error("只有已持久化 taskId 的 polling 任务才允许查询供应商");
  }
  const constraints = goldenMediaJobConstraints(job);
  const request = buildGoldenMediaProviderConnection(job);
  const polled = await pollGoldenMediaTask(request, job.remoteTaskId);
  if (polled.state === "pending") return { state: "pending" };
  return persistCompletedRecord(job, constraints, polled.remoteUrls, polled.taskStatus);
}
