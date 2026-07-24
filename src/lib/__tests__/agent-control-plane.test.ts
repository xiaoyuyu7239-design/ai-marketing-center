import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import type {
  AgentConfig,
  AgentEvalRecord,
  AgentStrategyState,
} from "@server/admin/agents/types";
import {
  candidateBindingFor,
  effectiveCandidateModel,
  getPromotionDecisionForDraft,
  promotionEvidenceForDraft,
} from "@server/admin/evals/runner";
import { ProviderError } from "@backend/providers/base";

function repeatedScriptRecords(state: AgentStrategyState, prefix: string): AgentEvalRecord[] {
  const agent = state.draftAgents.find((item) => item.id === "script")!;
  return [0, 1, 2].flatMap((index) => (["primary", "fallback"] as const).map((role) => {
    const binding = candidateBindingFor(state, agent, role, "chat-json");
    return {
      id: `${prefix}-${role}-${index}`,
      createdAt: new Date(2026, 6, 16, 11, 0, index).toISOString(),
      agentId: "script" as const,
      candidateModel: effectiveCandidateModel(agent, role, "chat-json"),
      provider: agent[role].provider,
      promptVersion: agent.promptVersion,
      testCase: "科技品带货 20 秒分镜",
      output: "{}",
      latencyMs: 1_000,
      errored: false,
      jsonParsed: true,
      evaluationKind: "golden" as const,
      status: "completed" as const,
      caseId: "script.tech-earbuds.zh.v1",
      ...binding,
      candidateRole: role,
      requestKind: "chat-json" as const,
      structurePassed: true,
      qualityScore: 90,
      actualCostUsd: null,
      artifactUrls: [],
    };
  }));
}

describe("Agent 模型控制面", () => {
  let dataDir: string;
  let agentsModule: typeof import("@server/admin/agents");
  let defaultsModule: typeof import("@server/admin/agents/defaults");

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-agent-control-test-"));
    process.env.APP_DATA_DIR = dataDir;
    process.env.CLIPFORGE_LLM_BASE_URL = "https://api.atlascloud.ai/api/v1";
    process.env.CLIPFORGE_LLM_FALLBACK_BASE_URL = "https://api.siliconflow.cn/v1";
    process.env.CLIPFORGE_LLM_MODEL = "gpt-4o-2024-08-06";
    process.env.CLIPFORGE_LLM_VISION_MODEL = "gpt-4o-2024-08-06";
    process.env.CLIPFORGE_LLM_FALLBACK_MODEL = "gpt-4o-mini-2024-07-18";
    process.env.CLIPFORGE_LLM_FALLBACK_VISION_MODEL = "gpt-4o-mini-2024-07-18";
    process.env.CLIPFORGE_LLM_DEPLOYMENT_REVISION = "openai:gpt-4o:2024-08-06";
    process.env.CLIPFORGE_LLM_REVISION_EVIDENCE_FILE = "llm-primary.json";
    process.env.CLIPFORGE_LLM_REVISION_EVIDENCE_SHA256 = "a".repeat(64);
    process.env.CLIPFORGE_LLM_FALLBACK_DEPLOYMENT_REVISION = "openai:gpt-4o-mini:2024-07-18";
    process.env.CLIPFORGE_LLM_FALLBACK_REVISION_EVIDENCE_FILE = "llm-fallback.json";
    process.env.CLIPFORGE_LLM_FALLBACK_REVISION_EVIDENCE_SHA256 = "b".repeat(64);
    process.env.CLIPFORGE_LLM_API_KEY = "test-primary-secret";
    process.env.CLIPFORGE_LLM_FALLBACK_API_KEY = "test-fallback-secret";
    agentsModule = await import("@server/admin/agents");
    defaultsModule = await import("@server/admin/agents/defaults");
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    delete process.env.CLIPFORGE_LLM_BASE_URL;
    delete process.env.CLIPFORGE_LLM_FALLBACK_BASE_URL;
    delete process.env.CLIPFORGE_LLM_MODEL;
    delete process.env.CLIPFORGE_LLM_VISION_MODEL;
    delete process.env.CLIPFORGE_LLM_FALLBACK_MODEL;
    delete process.env.CLIPFORGE_LLM_FALLBACK_VISION_MODEL;
    delete process.env.CLIPFORGE_LLM_DEPLOYMENT_REVISION;
    delete process.env.CLIPFORGE_LLM_REVISION_EVIDENCE_FILE;
    delete process.env.CLIPFORGE_LLM_REVISION_EVIDENCE_SHA256;
    delete process.env.CLIPFORGE_LLM_FALLBACK_DEPLOYMENT_REVISION;
    delete process.env.CLIPFORGE_LLM_FALLBACK_REVISION_EVIDENCE_FILE;
    delete process.env.CLIPFORGE_LLM_FALLBACK_REVISION_EVIDENCE_SHA256;
    delete process.env.CLIPFORGE_LLM_API_KEY;
    delete process.env.CLIPFORGE_LLM_FALLBACK_API_KEY;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("读取旧状态时清除明文 key，且公开 DTO 不返回凭据字段", async () => {
    const base = defaultsModule.defaultState();
    const legacy = {
      ...base,
      strategyRevision: undefined,
      draftAgents: undefined,
      previousAgents: undefined,
      audit: undefined,
      agents: base.agents.map((agent) => agent.id === "script"
        ? {
            ...agent,
            primary: { ...agent.primary, apiKey: "sk-legacy-plaintext", apiKeyConfigured: true },
            previous: {
              ...agent,
              primary: { ...agent.primary, apiKey: "sk-previous-plaintext" },
            },
          }
        : agent),
    };
    const normalized = agentsModule.normalizeAgentStrategyState(legacy);
    expect(normalized.shouldRewrite).toBe(true);
    expect(normalized.scrubbedCredential).toBe(true);
    expect(JSON.stringify(normalized.state)).not.toContain("sk-legacy-plaintext");
    expect(JSON.stringify(normalized.state)).not.toContain("sk-previous-plaintext");
    expect(normalized.state.agents.find((agent) => agent.id === "script")?.primary.secretRef).toBe("llm.primary");

    const dto = agentsModule.publicAgent(normalized.state.agents[0]);
    expect(JSON.stringify(dto)).not.toMatch(/apiKey|test-primary-secret/);
    expect(dto.primary.secretConfigured).toBe(true);

    const { getDb } = await import("@backend/db");
    const { settings } = await import("@backend/db/schema");
    const { eq } = await import("drizzle-orm");
    const { STRATEGY_KEY } = await import("@server/admin/agents/constants");
    await getDb().insert(settings).values({ key: STRATEGY_KEY, value: legacy }).onConflictDoUpdate({
      target: settings.key,
      set: { value: legacy },
    });
    await agentsModule.getAgentStrategy();
    const persisted = await getDb().select({ value: settings.value }).from(settings).where(eq(settings.key, STRATEGY_KEY));
    expect(JSON.stringify(persisted[0]?.value)).not.toMatch(/apiKey|sk-legacy-plaintext|sk-previous-plaintext/);
  });

  it("拒绝浏览器传入 key/非白名单 secretRef，生产端点必须 HTTPS + hostname 白名单", () => {
    const base = defaultsModule.defaultState().agents;
    const withKey = [{
      ...base[0],
      primary: { ...base[0].primary, apiKey: "sk-browser" },
    }];
    expect(() => agentsModule.mergeAgentSecrets(base, withKey as never)).toThrow(/secretRef/);

    const invalidRef = {
      ...base[0].primary,
      secretRef: "HOME",
    };
    expect(() => agentsModule.sanitizeEndpoint(invalidRef, base[0].primary, "script", "primary"))
      .toThrow(/secretRef|凭据/);
    expect(() => agentsModule.sanitizeEndpoint(
      { ...base[0].primary, secretRef: "llm.fallback" },
      base[0].primary,
      "script",
      "primary",
    )).toThrow(/专属凭据引用 llm.primary/);

    expect(() => agentsModule.validateEndpointPolicy(
      { ...base[0].primary, baseUrl: "http://api.openai.com/v1" },
      { production: true },
    )).toThrow(/HTTPS/);
    expect(() => agentsModule.validateEndpointPolicy(
      { ...base[0].primary, baseUrl: "https://evil.example/v1" },
      { production: true },
    )).toThrow(/白名单/);
    expect(() => agentsModule.validateEndpointPolicy(
      { ...base[0].primary, model: "gpt-4o" },
      { production: true, requireRevision: true },
    )).toThrow(/浮动别名|固定模型/);
    expect(() => agentsModule.validateEndpointPolicy(
      {
        ...base[0].primary,
        provider: "atlas-cloud",
        model: "openai/gpt-image-2/text-to-image",
        visionModel: "openai/gpt-image-2/text-to-image",
      },
      { production: true, requireRevision: true },
    )).toThrow(/按模式改写/);
    expect(() => agentsModule.validateEndpointPolicy(
      { ...base[0].primary, visionModel: "different-fixed-vision-2026-07-16" },
      { production: true, requireRevision: true },
    )).toThrow(/只能绑定一个|视觉 Agent/);
    expect(() => agentsModule.validateEndpointPolicy(
      { ...base[0].primary, deploymentRevision: undefined },
      { production: true, requireRevision: true },
    )).toThrow(/deploymentRevision/);
    expect(() => agentsModule.validateEndpointPolicy(
      base[0].primary,
      { production: true, requireRevision: true },
    )).not.toThrow();

    const ttsAgent = base.find((agent) => agent.id === "ttsAgent")!;
    expect(() => agentsModule.validateEndpointPolicy(
      {
        ...ttsAgent.primary,
        provider: "volcengine",
        baseUrl: "https://openspeech.bytedance.com/api/v3/tts",
        model: "seed-tts-2.0",
      },
      { production: true },
    )).not.toThrow();
    expect(() => agentsModule.validateAgentFaultDomains(
      {
        ...ttsAgent.primary,
        provider: "volcengine",
        baseUrl: "https://openspeech.bytedance.com/api/v3/tts",
      },
      {
        ...ttsAgent.fallback,
        provider: "volcengine",
        baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      },
    )).toThrow(/同一供应商故障域/);

    expect(() => agentsModule.validateAgentFaultDomains(
      { ...base[0].primary, provider: "forged-same-label" },
      { ...base[0].fallback, provider: "forged-same-label" },
    )).not.toThrow();
    expect(() => agentsModule.validateAgentFaultDomains(
      { ...base[0].primary, provider: "provider-a" },
      { ...base[0].fallback, provider: "provider-b", baseUrl: base[0].primary.baseUrl },
    )).toThrow(/同一供应商故障域/);
  });

  it("生产 fallback 只读取专属密钥，不回退复用 primary 或通用旧密钥", () => {
    const originalFallback = process.env.CLIPFORGE_LLM_FALLBACK_API_KEY;
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.CLIPFORGE_LLM_FALLBACK_API_KEY;
    try {
      expect(agentsModule.resolveModelSecret("llm.primary")).toBe("test-primary-secret");
      expect(agentsModule.resolveModelSecret("llm.fallback")).toBe("");
    } finally {
      vi.unstubAllEnvs();
      if (originalFallback === undefined) delete process.env.CLIPFORGE_LLM_FALLBACK_API_KEY;
      else process.env.CLIPFORGE_LLM_FALLBACK_API_KEY = originalFallback;
    }
  });

  it("readiness 在线上 Prompt 缺失时与真实调用一样 fail-closed", () => {
    const state = defaultsModule.defaultState();
    const script = state.agents.find((agent) => agent.id === "script")!;
    state.prompts = state.prompts.filter(
      (prompt) => prompt.agentId !== "script" || prompt.version !== script.promptVersion,
    );
    expect(agentsModule.getAgentOperationReadiness(state, "script")).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/prompt.*缺失|重复|为空/i),
    });
  });

  it("严格清洗发布证据，浏览器无法向 draft 伪造或传承", () => {
    const base = defaultsModule.defaultState();
    const evidence = promotionEvidenceForDraft(base, "script", "2026-07-16T08:00:00.000Z");
    const script = base.draftAgents.find((agent) => agent.id === "script")!;
    const merged = agentsModule.mergeAgentSecrets(base.draftAgents, [{
      ...script,
      promotionEvidence: {
        ...evidence,
        primary: { ...evidence.primary, candidateKey: `primary:forged@${"f".repeat(64)}` },
      },
    }]);
    expect(merged[0].promotionEvidence).toBeUndefined();

    const normalized = agentsModule.normalizeAgentStrategyState({
      ...base,
      agents: base.agents.map((agent) => agent.id === "script" ? { ...agent, promotionEvidence: evidence } : agent),
      draftAgents: base.draftAgents.map((agent) => agent.id === "script" ? { ...agent, promotionEvidence: evidence } : agent),
    });
    expect(normalized.shouldRewrite).toBe(true);
    expect(normalized.state.agents.find((agent) => agent.id === "script")?.promotionEvidence).toEqual(evidence);
    expect(normalized.state.draftAgents.find((agent) => agent.id === "script")?.promotionEvidence).toBeUndefined();

    const malformedPublic = agentsModule.publicAgent({
      ...base.agents.find((agent) => agent.id === "script")!,
      promotionEvidence: { ...evidence, unexpected: true } as never,
    });
    expect(malformedPublic.promotionEvidence).toBeUndefined();
  });

  it("管理 API 不返回/不接受密钥，并明确返回 draft 与 online 两个槽", async () => {
    const { createAdminToken, ADMIN_COOKIE_NAME } = await import("@server/admin/admin-auth");
    const { GET, PUT } = await import("@/app/api/admin/agents/route");
    const cookie = `${ADMIN_COOKIE_NAME}=${createAdminToken()}`;
    const getResponse = await GET(new NextRequest("http://localhost/api/admin/agents", {
      headers: { Cookie: cookie },
    }));
    const payload = await getResponse.json();
    const serialized = JSON.stringify(payload);
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("cache-control")).toContain("no-store");
    expect(payload.agents).toHaveLength(payload.onlineAgents.length);
    expect(serialized).not.toMatch(/apiKey|test-primary-secret|test-fallback-secret/);

    const poisoned = payload.agents.map((agent: AgentConfig, index: number) => index === 0
      ? { ...agent, primary: { ...agent.primary, apiKey: "" } }
      : agent);
    const putResponse = await PUT(new NextRequest("http://localhost/api/admin/agents", {
      method: "PUT",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ agents: poisoned }),
    }));
    expect(putResponse.status).toBe(400);
    expect(await putResponse.json()).toMatchObject({ error: expect.stringMatching(/secretRef/) });
  });

  it("PUT 只改 draft；单 Agent 发布与回滚不影响其它 Agent", async () => {
    await agentsModule.saveAgentStrategy(defaultsModule.defaultState());
    const initial = await agentsModule.getAgentStrategy();
    const initialScript = initial.agents.find((agent) => agent.id === "script")!;
    const initialTopic = initial.agents.find((agent) => agent.id === "topic-script")!;
    const draft = {
      ...initial.draftAgents.find((agent) => agent.id === "script")!,
      primary: {
        ...initialScript.primary,
        model: "draft-only-model",
      },
    };

    await agentsModule.saveAgents([draft]);
    const afterDraft = await agentsModule.getAgentStrategy();
    expect(afterDraft.agents.find((agent) => agent.id === "script")?.primary.model).toBe(initialScript.primary.model);
    expect(afterDraft.draftAgents.find((agent) => agent.id === "script")?.primary.model).toBe("draft-only-model");

    await agentsModule.publishAgent("script");
    const published = await agentsModule.getAgentStrategy();
    expect(published.agents.find((agent) => agent.id === "script")?.primary.model).toBe("draft-only-model");
    expect(published.previousAgents.script?.primary.model).toBe(initialScript.primary.model);
    expect(published.agents.find((agent) => agent.id === "topic-script")?.primary.model).toBe(initialTopic.primary.model);
    expect(published.audit[0]).toMatchObject({ action: "published", agentId: "script" });

    await agentsModule.rollbackAgent("script");
    const rolledBack = await agentsModule.getAgentStrategy();
    expect(rolledBack.agents.find((agent) => agent.id === "script")?.primary.model).toBe(initialScript.primary.model);
    expect(rolledBack.agents.find((agent) => agent.id === "topic-script")?.primary.model).toBe(initialTopic.primary.model);
    expect(rolledBack.draftAgents.find((agent) => agent.id === "script")?.primary.model).toBe("draft-only-model");
    expect(rolledBack.audit[0]).toMatchObject({ action: "rolled_back", agentId: "script" });
  });

  it("生产发布门禁在当前 draft 主备没有 Golden Set 通过记录时失败关闭", async () => {
    await agentsModule.saveAgentStrategy(defaultsModule.defaultState());
    process.env.HUIMAI_ENFORCE_MODEL_PROMOTION_GATE = "1";
    try {
      await expect(agentsModule.publishAgent("script")).rejects.toThrow(/Golden Set/);
      const state = await agentsModule.getAgentStrategy();
      expect(state.audit.some((item) => item.action === "published")).toBe(false);
    } finally {
      delete process.env.HUIMAI_ENFORCE_MODEL_PROMOTION_GATE;
    }
  });

  it("生产发布不得用同一 case 重跑伪造主备晋级证据", async () => {
    const originalCodeVersion = process.env.HUIMAI_CODE_VERSION;
    process.env.HUIMAI_CODE_VERSION = "build-promotion-evidence-1";
    process.env.HUIMAI_ENFORCE_MODEL_PROMOTION_GATE = "1";
    try {
      const initial = defaultsModule.defaultState();
      initial.evals = repeatedScriptRecords(initial, "repeated-case");
      await agentsModule.saveAgentStrategy(initial);
      const prepared = await agentsModule.getAgentStrategy();
      const preparedAgent = prepared.draftAgents.find((agent) => agent.id === "script")!;
      expect(prepared.evals[0]).toMatchObject(
        candidateBindingFor(prepared, preparedAgent, "primary", "chat-json"),
      );
      const decision = getPromotionDecisionForDraft(prepared, "script", { production: true });
      expect(decision.passed).toBe(false);
      expect(decision.candidates.every((candidate) => candidate.summary?.distinctCaseCount === 1)).toBe(true);
      expect(decision.failures.join(" ")).toMatch(/case 种类数不足/);

      await expect(agentsModule.publishAgent("script")).rejects.toThrow(/case 种类数不足/);
      const blocked = await agentsModule.getAgentStrategy();
      expect(blocked.agents.find((agent) => agent.id === "script")?.promotionEvidence).toBeUndefined();
      expect(blocked.audit.some((record) => record.action === "published" && record.agentId === "script")).toBe(false);
    } finally {
      await agentsModule.saveAgentStrategy(defaultsModule.defaultState());
      delete process.env.HUIMAI_ENFORCE_MODEL_PROMOTION_GATE;
      if (originalCodeVersion === undefined) delete process.env.HUIMAI_CODE_VERSION;
      else process.env.HUIMAI_CODE_VERSION = originalCodeVersion;
    }
  });

  it("生产允许无证据 Agent 以 disabled 发布，重新启用必须完整 Golden", async () => {
    const originalCodeVersion = process.env.HUIMAI_CODE_VERSION;
    process.env.HUIMAI_CODE_VERSION = "build-disabled-agent-1";
    process.env.HUIMAI_ENFORCE_MODEL_PROMOTION_GATE = "1";
    try {
      await agentsModule.saveAgentStrategy(defaultsModule.defaultState());
      const state = await agentsModule.getAgentStrategy();
      const disabled = { ...state.draftAgents.find((agent) => agent.id === "script")!, enabled: false };
      await agentsModule.saveAgents([disabled]);
      await expect(agentsModule.publishAgent("script")).resolves.toBeDefined();
      const published = await agentsModule.getAgentStrategy();
      const publishedScript = published.agents.find((agent) => agent.id === "script")!;
      expect(publishedScript.enabled).toBe(false);
      expect(publishedScript.promotionEvidence).toBeUndefined();

      const enabled = { ...published.draftAgents.find((agent) => agent.id === "script")!, enabled: true };
      await agentsModule.saveAgents([enabled]);
      await expect(agentsModule.publishAgent("script")).rejects.toThrow(/Golden Set/);
    } finally {
      await agentsModule.saveAgentStrategy(defaultsModule.defaultState());
      delete process.env.HUIMAI_ENFORCE_MODEL_PROMOTION_GATE;
      if (originalCodeVersion === undefined) delete process.env.HUIMAI_CODE_VERSION;
      else process.env.HUIMAI_CODE_VERSION = originalCodeVersion;
    }
  });

  it("生产运行时拒绝缺失或不再匹配当前线上配置的 Golden 发布证据", async () => {
    const originalCodeVersion = process.env.HUIMAI_CODE_VERSION;
    process.env.HUIMAI_CODE_VERSION = "build-runtime-promotion-gate-1";
    process.env.HUIMAI_ENFORCE_MODEL_PROMOTION_GATE = "1";
    let calls = 0;
    try {
      const withoutEvidence = defaultsModule.defaultState();
      await agentsModule.saveAgentStrategy(withoutEvidence);
      expect(agentsModule.getAgentOperationReadiness(
        await agentsModule.getAgentStrategy(),
        "script",
      )).toMatchObject({ ready: false });
      await expect(agentsModule.runAgentOperation("script", "runtime-no-evidence", async () => {
        calls += 1;
        return "should-not-run";
      })).rejects.toThrow(/Golden 发布证据/);
      expect(calls).toBe(0);

      const published = defaultsModule.defaultState();
      const evidence = promotionEvidenceForDraft(
        published,
        "script",
        "2026-07-16T12:00:00.000Z",
      );
      published.agents = published.agents.map((agent) => agent.id === "script"
        ? {
            ...agent,
            strategyRevision: agent.strategyRevision + 1,
            promotionEvidence: evidence,
          }
        : agent);
      await agentsModule.saveAgentStrategy(published);
      expect(agentsModule.getAgentOperationReadiness(
        await agentsModule.getAgentStrategy(),
        "script",
      )).toMatchObject({ ready: true, endpointRole: "primary" });
      await expect(agentsModule.runAgentOperation("script", "runtime-valid-evidence", async () => {
        calls += 1;
        return "ok";
      })).resolves.toBe("ok");
      expect(calls).toBe(1);

      const tampered = await agentsModule.getAgentStrategy();
      tampered.agents = tampered.agents.map((agent) => agent.id === "script"
        ? {
            ...agent,
            primary: {
              ...agent.primary,
              model: "gpt-4o-2024-11-20",
              visionModel: "gpt-4o-2024-11-20",
            },
          }
        : agent);
      await agentsModule.saveAgentStrategy(tampered);
      expect(agentsModule.getAgentOperationReadiness(
        await agentsModule.getAgentStrategy(),
        "script",
      )).toMatchObject({ ready: false });
      await expect(agentsModule.runAgentOperation("script", "runtime-stale-evidence", async () => {
        calls += 1;
        return "should-not-run";
      })).rejects.toThrow(/发布证据与当前线上模型、Prompt 或配置不一致/);
      expect(calls).toBe(1);
    } finally {
      await agentsModule.saveAgentStrategy(defaultsModule.defaultState());
      delete process.env.HUIMAI_ENFORCE_MODEL_PROMOTION_GATE;
      if (originalCodeVersion === undefined) delete process.env.HUIMAI_CODE_VERSION;
      else process.env.HUIMAI_CODE_VERSION = originalCodeVersion;
    }
  });

  it("线上 prompt 不可原地改写，新 prompt 版本先进 draft 再随 Agent 发布/回滚", async () => {
    const { savePrompts } = await import("@server/admin/prompts");
    const before = await agentsModule.getAgentStrategy();
    const onlineAgent = before.agents.find((agent) => agent.id === "script")!;
    const onlinePrompt = before.prompts.find(
      (prompt) => prompt.agentId === "script" && prompt.version === onlineAgent.promptVersion,
    )!;
    await expect(savePrompts({
      prompts: before.prompts.filter((prompt) => prompt.id !== onlinePrompt.id),
    })).rejects.toThrow(/不得删除|引用/);
    await expect(savePrompts({
      prompts: before.prompts.map((prompt) => prompt.id === onlinePrompt.id
        ? { ...prompt, content: `${prompt.content}\n原地篡改` }
        : prompt),
    })).rejects.toThrow(/不可原地修改/);

    const version = "script-control-test-v2";
    const newPrompt = {
      ...onlinePrompt,
      id: "prompt_control_test_v2",
      version,
      content: `${onlinePrompt.content}\n新版本`,
      status: "draft" as const,
    };
    await savePrompts({
      prompts: [newPrompt, ...before.prompts],
      agents: before.draftAgents.map((agent) => agent.id === "script"
        ? { ...agent, promptVersion: version }
        : agent),
    });
    const drafted = await agentsModule.getAgentStrategy();
    expect(drafted.agents.find((agent) => agent.id === "script")?.promptVersion).toBe(onlineAgent.promptVersion);
    expect(drafted.draftAgents.find((agent) => agent.id === "script")?.promptVersion).toBe(version);

    await agentsModule.publishAgent("script");
    expect((await agentsModule.getAgentStrategy()).agents.find((agent) => agent.id === "script")?.promptVersion).toBe(version);
    await agentsModule.rollbackAgent("script");
    expect((await agentsModule.getAgentStrategy()).agents.find((agent) => agent.id === "script")?.promptVersion).toBe(onlineAgent.promptVersion);
  });

  it("普通运行只读 online；429 允许 fallback 并对每次 attempt 留痕，成本未知为 null", async () => {
    const before = await agentsModule.getAgentStrategy();
    const onlineModel = before.agents.find((agent) => agent.id === "script")!.primary.model;
    const draft = {
      ...before.draftAgents.find((agent) => agent.id === "script")!,
      primary: { ...before.draftAgents.find((agent) => agent.id === "script")!.primary, model: "not-published-model" },
    };
    await agentsModule.saveAgents([draft]);

    const observedModels: string[] = [];
    const result = await agentsModule.runAgentOperation("script", "fallback-case", async (config, _prompt, usedFallback) => {
      observedModels.push(config.model);
      if (!usedFallback) {
        const error = new Error("Too many requests") as Error & { status: number };
        error.status = 429;
        throw error;
      }
      return "ok";
    });
    expect(result).toBe("ok");
    expect(observedModels[0]).toBe(onlineModel);
    expect(observedModels).not.toContain("not-published-model");

    const state = await agentsModule.getAgentStrategy();
    const records = state.runs.filter((run) => run.userLabel === "fallback-case");
    expect(records).toHaveLength(2);
    expect(new Set(records.map((run) => run.requestId)).size).toBe(1);
    expect(records.map((run) => run.attempt).sort()).toEqual([1, 2]);
    expect(records.find((run) => run.endpointRole === "primary")).toMatchObject({
      success: false,
      errorCategory: "rate_limit",
    });
    expect(records.find((run) => run.endpointRole === "fallback")).toMatchObject({ success: true });
    expect(records.every((run) => run.costUsd === null && run.costEstimateUsd === null)).toBe(true);
  });

  it("安全拦截与普通 4xx 禁止 fallback；结构解析错误允许 fallback", async () => {
    expect(agentsModule.classifyAgentError(new Error("InputImageSensitiveContentDetected"))).toMatchObject({
      category: "safety",
      fallbackAllowed: false,
    });
    const badRequest = new Error("bad request") as Error & { status: number };
    badRequest.status = 400;
    expect(agentsModule.classifyAgentError(badRequest)).toMatchObject({
      category: "client_4xx",
      fallbackAllowed: false,
    });
    expect(agentsModule.classifyAgentError(new SyntaxError("Unexpected token in JSON"))).toMatchObject({
      category: "parse",
      fallbackAllowed: true,
    });
    expect(agentsModule.classifyAgentError(new ProviderError(
      "provider billing",
      "BILLING_REQUIRED",
      "probe",
      402,
      { category: "billing" },
    ))).toMatchObject({ category: "billing", fallbackAllowed: true });
    expect(agentsModule.classifyAgentError(new ProviderError(
      "provider auth",
      "AUTH_FAILED",
      "probe",
      401,
      { category: "auth" },
    ))).toMatchObject({ category: "configuration", fallbackAllowed: false });
    expect(agentsModule.classifyAgentError(new ProviderError(
      "provider invalid input",
      "INVALID_INPUT",
      "probe",
      422,
      { category: "invalid_input" },
    ))).toMatchObject({ category: "client_4xx", fallbackAllowed: false });

    let calls = 0;
    await expect(agentsModule.runAgentOperation("script", "safety-case", async () => {
      calls += 1;
      throw new Error("人脸素材未通过安全校验");
    })).rejects.toThrow(/安全校验/);
    expect(calls).toBe(1);
    const state = await agentsModule.getAgentStrategy();
    expect(state.runs.find((run) => run.userLabel === "safety-case")).toMatchObject({
      endpointRole: "primary",
      errorCategory: "safety",
      fallbackTriggered: false,
    });
  });

  it("按 attempt 累加真实遥测并记录路由实际使用的模型 ID", async () => {
    await agentsModule.runAgentOperation("script", "telemetry-case", async (_config, _prompt, _fallback, context) => {
      context.reportTelemetry({
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
        costUsd: 0.001,
      });
      context.reportTelemetry({
        usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
        costUsd: 0.002,
        effectiveModel: "ep-fixed-revision-20260716",
      });
      return "ok";
    });

    const state = await agentsModule.getAgentStrategy();
    expect(state.runs.find((run) => run.userLabel === "telemetry-case")).toMatchObject({
      model: "ep-fixed-revision-20260716",
      usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      costUsd: 0.003,
      costEstimateUsd: 0.003,
    });
  });
});
