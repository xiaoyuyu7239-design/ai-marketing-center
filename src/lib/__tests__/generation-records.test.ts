import { describe, expect, it } from "vitest";
import {
  LOW_GENERATION_INVENTORY_THRESHOLD,
  compactCount,
  getApprovedProjects,
  getPublishableProjects,
  isLowGenerationInventory,
  rankTodayPublishCandidates,
  type GenerationProject,
} from "@frontend/lib/generation-records";
import type { ApprovedVideoRecord } from "@frontend/stores/video-approval-store";

const project = (patch: Partial<GenerationProject>): GenerationProject => ({
  id: patch.id ?? "project-1",
  name: patch.name ?? "测试商品 推广",
  status: patch.status ?? "done",
  productName: patch.productName ?? "测试商品",
  productDescription: patch.productDescription ?? "卖点完整",
  productImages: patch.productImages ?? ["/cover.png"],
  createdAt: patch.createdAt ?? "2026-07-08T08:00:00.000Z",
  updatedAt: patch.updatedAt ?? "2026-07-08T09:00:00.000Z",
});

const approved = (...ids: string[]): Record<string, ApprovedVideoRecord> =>
  Object.fromEntries(ids.map((id) => [id, { projectId: id, approvedAt: "2026-07-08T10:00:00.000Z" }]));

describe("generation records", () => {
  it("生成库存少于阈值才提醒", () => {
    expect(LOW_GENERATION_INVENTORY_THRESHOLD).toBe(5);
    expect(isLowGenerationInventory(4)).toBe(true);
    expect(isLowGenerationInventory(5)).toBe(false);
    expect(isLowGenerationInventory(6)).toBe(false);
  });

  it("紧凑展示库存和待发布数量", () => {
    expect(compactCount(-2)).toBe("0");
    expect(compactCount(12)).toBe("12");
    expect(compactCount(120)).toBe("99+");
  });

  it("只从已成片且认可入库、未发布的视频里选今日待发布", () => {
    const projects = [
      project({ id: "approved-a", productName: "A" }),
      project({ id: "approved-b", productName: "B" }),
      project({ id: "draft", status: "script" }),
      project({ id: "not-approved", productName: "C" }),
    ];

    expect(getApprovedProjects(projects, approved("approved-a", "approved-b", "draft")).map((item) => item.id)).toEqual([
      "approved-a",
      "approved-b",
    ]);

    expect(
      getPublishableProjects(projects, approved("approved-a", "approved-b"), {
        "approved-a": { projectId: "approved-a", publishedAt: "2026-07-08T11:00:00.000Z" },
      }).map((item) => item.id)
    ).toEqual(["approved-b"]);

    const picked = rankTodayPublishCandidates(
      projects,
      approved("approved-a", "approved-b"),
      2,
      "balanced",
      new Date("2026-07-08"),
      { "approved-a": { projectId: "approved-a", publishedAt: "2026-07-08T11:00:00.000Z" } }
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]?.project.id).toBe("approved-b");
  });

  it("近 7 天发布过同品类时，待发布排序降低同质内容", () => {
    const today = new Date("2026-07-08T12:00:00.000Z");
    const projects = [
      project({ id: "published-home", productCategory: "home", updatedAt: "2026-07-08T11:30:00.000Z" }),
      project({ id: "candidate-home", productCategory: "home", updatedAt: "2026-07-08T11:00:00.000Z" }),
      project({ id: "candidate-food", productCategory: "food", updatedAt: "2026-07-01T09:00:00.000Z" }),
    ];
    const picked = rankTodayPublishCandidates(
      projects,
      approved("published-home", "candidate-home", "candidate-food"),
      2,
      "fresh",
      today,
      { "published-home": { projectId: "published-home", publishedAt: "2026-07-08T10:00:00.000Z" } }
    );

    expect(picked.map((item) => item.project.id)).toContain("candidate-food");
  });
});
