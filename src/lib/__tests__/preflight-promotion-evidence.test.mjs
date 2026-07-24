import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  agentInventoryIssues,
  edgeBodyLimitEvidenceIssues,
  MIN_PRODUCTION_MIGRATION_COUNT,
  productionMigrationDirectoryIssues,
  promotionEvidenceIssues,
  REQUIRED_PRODUCTION_MIGRATIONS,
  revisionEvidenceIssues,
} from "../../../scripts/preflight-beta.mjs";

const agentIds = [
  "script",
  "topic-script",
  "product-analysis",
  "publish-copy",
  "publish-ranker",
  "diagnose",
  "metrics-ocr",
  "retro",
  "weekly-report",
  "imageAgent",
  "videoAgent",
  "ttsAgent",
];

const fingerprint = "b".repeat(64);
const validEvidence = {
  schemaVersion: 1,
  agentId: "script",
  requestKind: "chat-json",
  primary: {
    candidateKey: `primary:openai/model-a@${fingerprint}`,
    evaluationFingerprint: fingerprint,
  },
  fallback: {
    candidateKey: `fallback:siliconflow/model-b@${fingerprint}`,
    evaluationFingerprint: fingerprint,
  },
  promptContentSha256: "c".repeat(64),
  draftConfigSha256: "d".repeat(64),
  goldenSetSha256: "e".repeat(64),
  codeVersion: "build-sha-123",
  verifiedAt: "2026-07-16T08:00:00.000Z",
};

describe("production preflight migration baseline", () => {
  const migrationFiles = readdirSync(join(process.cwd(), "drizzle"))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();

  it("requires the 27-migration chain through the final motion schema upgrade", () => {
    expect(MIN_PRODUCTION_MIGRATION_COUNT).toBe(27);
    expect(REQUIRED_PRODUCTION_MIGRATIONS).toContain("0024_persistent_motion_video_jobs.sql");
    expect(REQUIRED_PRODUCTION_MIGRATIONS).toContain("0025_motion_asset_assessments.sql");
    expect(REQUIRED_PRODUCTION_MIGRATIONS).toContain("0026_motion_job_schema_upgrade.sql");
    expect(productionMigrationDirectoryIssues(migrationFiles)).toEqual([]);
  });

  it("fails closed when 0026 or the 27-file baseline is missing", () => {
    expect(productionMigrationDirectoryIssues(
      migrationFiles.filter((name) => name !== "0026_motion_job_schema_upgrade.sql"),
    ).join(" ")).toMatch(/0026_motion_job_schema_upgrade/);
    expect(productionMigrationDirectoryIssues(migrationFiles.slice(0, 26)).join(" "))
      .toMatch(/27/);
  });
});

describe("production preflight promotion evidence", () => {
  it("accepts complete current-build evidence", () => {
    expect(promotionEvidenceIssues({
      id: "script",
      enabled: true,
      promotionEvidence: validEvidence,
    }, "build-sha-123")).toEqual([]);
  });

  it("fails closed for missing, stale, malformed, or role-swapped evidence", () => {
    expect(promotionEvidenceIssues({ id: "script", enabled: true }, "build-sha-123").join(" "))
      .toMatch(/promotionEvidence/);
    expect(promotionEvidenceIssues({
      id: "script",
      enabled: true,
      promotionEvidence: validEvidence,
    }, "different-build").join(" ")).toMatch(/HUIMAI_CODE_VERSION/);
    expect(promotionEvidenceIssues({
      id: "script",
      enabled: true,
      promotionEvidence: { ...validEvidence, unexpected: true },
    }, "build-sha-123").join(" ")).toMatch(/格式完整/);
    expect(promotionEvidenceIssues({
      id: "script",
      enabled: true,
      promotionEvidence: {
        ...validEvidence,
        primary: {
          ...validEvidence.primary,
          candidateKey: `fallback:openai/model-a@${fingerprint}`,
        },
      },
    }, "build-sha-123").join(" ")).toMatch(/primary candidateKey/);
  });

  it("allows an intentionally disabled Agent without evidence", () => {
    expect(promotionEvidenceIssues({ id: "script", enabled: false }, "build-sha-123")).toEqual([]);
  });
});

describe("production preflight Agent inventory", () => {
  const validState = () => ({
    agents: agentIds.map((id) => ({ id, enabled: true })),
    draftAgents: agentIds.map((id) => ({ id, enabled: true })),
  });

  it("requires complete online/draft inventories and enabled first-invite core Agents", () => {
    expect(agentInventoryIssues(validState())).toEqual([]);

    const optionalDisabled = validState();
    optionalDisabled.agents.find((agent) => agent.id === "weekly-report").enabled = false;
    expect(agentInventoryIssues(optionalDisabled)).toEqual([]);

    const coreDisabled = validState();
    coreDisabled.agents.find((agent) => agent.id === "videoAgent").enabled = false;
    expect(agentInventoryIssues(coreDisabled).join(" ")).toMatch(/核心 Agent.*videoAgent/);

    const incomplete = validState();
    incomplete.draftAgents = incomplete.draftAgents.filter((agent) => agent.id !== "ttsAgent");
    expect(agentInventoryIssues(incomplete).join(" ")).toMatch(/draft 缺少 Agent.*ttsAgent/);

    const duplicate = validState();
    duplicate.agents.push({ id: "script", enabled: true });
    expect(agentInventoryIssues(duplicate).join(" ")).toMatch(/online 存在重复 Agent.*script/);
  });
});

describe("production preflight immutable model revision", () => {
  it("rejects floating aliases, missing metadata and mismatched evidence hashes", () => {
    const dir = mkdtempSync(join(tmpdir(), "huimai-model-revision-"));
    try {
      const content = JSON.stringify({
        schemaVersion: 1,
        endpointHost: "api.openai.com",
        model: "gpt-4o-2024-08-06",
        deploymentRevision: "openai:gpt-4o:2024-08-06",
        faultDomain: "openai",
        immutable: true,
        evidenceType: "provider-console-export",
        sourceReference: "redacted-provider-console-export-20260716",
        issuedAt: "2026-07-16T08:00:00.000Z",
      });
      const file = "primary.json";
      writeFileSync(join(dir, file), content);
      const endpoint = {
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-2024-08-06",
        deploymentRevision: "openai:gpt-4o:2024-08-06",
        revisionEvidenceFile: file,
        revisionEvidenceSha256: createHash("sha256").update(content).digest("hex"),
      };
      expect(revisionEvidenceIssues(endpoint, dir)).toEqual([]);
      expect(revisionEvidenceIssues({ ...endpoint, model: "gpt-4o" }, dir).join(" ")).toMatch(/浮动/);
      expect(revisionEvidenceIssues({ ...endpoint, model: "vendor/text-to-video" }, dir).join(" ")).toMatch(/按模式改写/);
      expect(revisionEvidenceIssues({ ...endpoint, visionModel: "different-fixed-vision" }, dir).join(" ")).toMatch(/model\/visionModel/);
      expect(revisionEvidenceIssues({ ...endpoint, deploymentRevision: "latest" }, dir).join(" ")).toMatch(/deploymentRevision/);
      expect(revisionEvidenceIssues({ ...endpoint, revisionEvidenceSha256: "0".repeat(64) }, dir).join(" ")).toMatch(/SHA-256 不匹配/);
      expect(revisionEvidenceIssues({ ...endpoint, revisionEvidenceFile: "../outside.json" }, dir).join(" ")).toMatch(/文件名/);
      const mismatchedContent = JSON.stringify({ ...JSON.parse(content), faultDomain: "forged-provider" });
      writeFileSync(join(dir, "mismatched.json"), mismatchedContent);
      expect(revisionEvidenceIssues({
        ...endpoint,
        revisionEvidenceFile: "mismatched.json",
        revisionEvidenceSha256: createHash("sha256").update(mismatchedContent).digest("hex"),
      }, dir).join(" ")).toMatch(/faultDomain 不一致|与 endpointHost/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("production preflight edge body limit evidence", () => {
  const valid = {
    schemaVersion: 1,
    baseOrigin: "https://beta.example.com",
    probePath: "/api/project/edge-body-limit-probe/materials",
    gatewayConfigSha256: "a".repeat(64),
    maxBodyBytes: 168820736,
    underLimitBytes: 168820735,
    underLimitStatus: 100,
    contentLengthStatus: 413,
    chunkedStatus: 413,
    verifiedAt: "2026-07-16T08:00:00.000Z",
  };
  const options = {
    expectedOrigin: "https://beta.example.com",
    expectedProbePath: "/api/project/edge-body-limit-probe/materials",
    expectedGatewayConfigSha256: "a".repeat(64),
    expectedMaxBodyBytes: 168820736,
    nowMs: Date.parse("2026-07-16T09:00:00.000Z"),
  };

  it("requires fresh matching evidence for both Content-Length and chunked probes", () => {
    expect(edgeBodyLimitEvidenceIssues(valid, options)).toEqual([]);
    expect(edgeBodyLimitEvidenceIssues({ ...valid, chunkedStatus: 401 }, options).join(" ")).toMatch(/413/);
    expect(edgeBodyLimitEvidenceIssues({ ...valid, underLimitStatus: 413 }, options).join(" ")).toMatch(/对照组/);
    expect(edgeBodyLimitEvidenceIssues({ ...valid, baseOrigin: "https://other.example.com" }, options).join(" ")).toMatch(/域名/);
    expect(edgeBodyLimitEvidenceIssues(
      { ...valid, verifiedAt: "2026-07-01T08:00:00.000Z" },
      options,
    ).join(" ")).toMatch(/7 天/);
  });
});
