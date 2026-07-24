import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  delete: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  returning: vi.fn(),
}));

vi.mock("@backend/db", () => ({
  getDb: () => ({
    delete: mocks.delete,
    insert: mocks.insert,
  }),
}));

vi.mock("@backend/core/auth/require-merchant", () => ({
  requireMerchant: vi.fn(async () => ({ merchant: { id: "merchant-1" } })),
  requireOwnedProject: vi.fn(async () => ({ project: { id: "project-1" } })),
}));

vi.mock("@backend/core/auth/media-access", () => ({
  mediaRefBelongsToMerchant: vi.fn(() => true),
}));

import { POST } from "@/app/api/project/[id]/assets/route";

describe("POST /api/project/[id]/assets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.returning.mockResolvedValue([
      {
        id: "asset-new",
        projectId: "project-1",
        shotId: 2,
        filePath: "/api/files/project-1/source.png",
        status: "done",
      },
    ]);
    mocks.values.mockReturnValue({ returning: mocks.returning });
    mocks.insert.mockReturnValue({ values: mocks.values });
    mocks.delete.mockImplementation(() => {
      throw new Error("素材新版本不应删除历史行");
    });
  });

  it("追加新素材行而不删除同分镜原图", async () => {
    const request = new NextRequest("http://localhost/api/project/project-1/assets", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        shotId: 2,
        sourceUrl: "/api/files/project-1/source.png",
        type: "ai_generated",
        provider: "image-provider",
        model: "image-model-v1",
        prompt: "source prompt",
      }),
    });

    const response = await POST(request, {
      params: Promise.resolve({ id: "project-1" }),
    });

    expect(response.status).toBe(200);
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        shotId: 2,
        filePath: "/api/files/project-1/source.png",
        status: "done",
      }),
    );
  });
});
