import { describe, expect, it } from "vitest";
import { summarizeOps } from "@server/admin/ops";
import type { AgentRunRecord } from "@server/admin/agents/types";

const now = new Date("2026-07-16T08:00:00.000Z");
const ready = {
  ok: true,
  checks: {
    database: { ok: true },
    dataDirectory: { ok: true },
    disk: { ok: true },
    ffmpeg: { ok: true },
    ffprobe: { ok: true },
  },
};

function run(overrides: Partial<AgentRunRecord> = {}): AgentRunRecord {
  return {
    id: "run-1",
    requestId: "request-1",
    attempt: 1,
    endpointRole: "primary",
    createdAt: "2026-07-16T07:00:00.000Z",
    userLabel: "test",
    agentId: "script",
    agentName: "脚本",
    provider: "provider-a",
    model: "model-a-260716",
    strategyRevision: 1,
    codeVersion: "abc123",
    promptVersion: "script-v1",
    fallbackTriggered: false,
    success: true,
    latencyMs: 100,
    usage: null,
    costUsd: null,
    costEstimateUsd: null,
    ...overrides,
  };
}

describe("邀请内测运维告警聚合", () => {
  it("readiness、过期租约、欠费和缺备份均阻止放行", () => {
    const snapshot = summarizeOps({
      now,
      readiness: { ...ready, ok: false, checks: { ...ready.checks, disk: { ok: false, error: "full" } } },
      jobs: [{ status: "running", createdAt: new Date(now.getTime() - 60_000), leaseExpiresAt: new Date(now.getTime() - 1), errorCode: null }],
      runs: [run({ success: false, errorCategory: "billing", errorReason: "余额不足" })],
      backup: { configured: false, available: false, latestCompletedAt: null, ageMs: null },
    });

    expect(snapshot.status).toBe("critical");
    expect(snapshot.alerts.map((item) => item.id)).toEqual(expect.arrayContaining(["readiness", "expired-leases", "billing", "backup-config"]));
  });

  it("积压、429 和成本覆盖缺失形成可操作警告", () => {
    const jobs = Array.from({ length: 5 }, () => ({
      status: "pending" as const,
      createdAt: new Date(now.getTime() - 20 * 60_000),
      leaseExpiresAt: null,
      errorCode: null,
    }));
    const runs = [
      run(),
      ...Array.from({ length: 3 }, (_, index) => run({
        id: `rate-${index}`,
        requestId: `request-${index}`,
        success: false,
        errorCategory: "rate_limit",
      })),
      run({ id: "priced", requestId: "priced", costUsd: 0.01, costEstimateUsd: 0.01 }),
    ];
    const snapshot = summarizeOps({
      now,
      readiness: ready,
      jobs,
      runs,
      backup: { configured: true, available: true, latestCompletedAt: now.toISOString(), ageMs: 0 },
    });

    expect(snapshot.status).toBe("warning");
    expect(snapshot.costs.coverageRate24h).toBe(0.5);
    expect(snapshot.alerts.map((item) => item.id)).toEqual(expect.arrayContaining(["queue-backlog", "rate-limit", "cost-coverage"]));
  });

  it("无异常时保留人工冒烟提醒", () => {
    const snapshot = summarizeOps({
      now,
      readiness: ready,
      jobs: [],
      runs: [],
      backup: { configured: true, available: true, latestCompletedAt: now.toISOString(), ageMs: 0 },
    });
    expect(snapshot.status).toBe("healthy");
    expect(snapshot.costs.coverageRate24h).toBeNull();
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0].id).toBe("healthy");
  });
});
