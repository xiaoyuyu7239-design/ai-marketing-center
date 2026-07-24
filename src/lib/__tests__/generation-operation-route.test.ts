import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

function request(body: unknown, cookie: string): NextRequest {
  return new NextRequest("http://test.local/api/generation/operations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

function extractCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("注册响应未下发会话 cookie");
  return cookie;
}

describe("/api/generation/operations 服务端 manifest 约束", () => {
  let dataDir: string;
  let cookie: string;
  let projectId: string;
  let imagePackProjectId: string;
  let post: typeof import("@/app/api/generation/operations/route").POST;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-generation-operation-route-"));
    process.env.APP_DATA_DIR = dataDir;
    const { POST: register } = await import("@/app/api/auth/register/route");
    const { POST: createProject } = await import("@/app/api/project/route");
    ({ POST: post } = await import("@/app/api/generation/operations/route"));

    const registered = await register(new NextRequest("http://test.local/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "generation-manifest@example.com",
        password: "correct-horse-battery",
        shopName: "Manifest 测试店",
      }),
    }));
    expect(registered.status).toBe(201);
    cookie = extractCookie(registered);

    const create = async (body: unknown) => {
      const response = await createProject(new NextRequest("http://test.local/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify(body),
      }));
      expect(response.status).toBe(201);
      return (await response.json()).id as string;
    };
    projectId = await create({ name: "分镜项目", productName: "测试商品" });
    imagePackProjectId = await create({
      name: "图片套装项目",
      productName: "套装商品",
      contentType: "image_pack",
    });

    const { getDb } = await import("@backend/db");
    const { scripts, settings } = await import("@backend/db/schema");
    getDb().insert(scripts).values({
      projectId,
      version: 1,
      selected: true,
      styleType: "scene",
      shots: [1, 2, 3].map((shotId) => ({
        shotId,
        type: "demo" as const,
        duration: 3,
        description: `分镜 ${shotId}`,
        camera: "固定",
        visualSource: "ai_generate" as const,
        transition: "direct_concat" as const,
        voiceover: "测试",
      })),
    }).run();
    getDb().insert(settings).values({
      key: `image_pack:${imagePackProjectId}`,
      value: { images: [{ prompt: "one" }, { prompt: "two" }] },
      updatedAt: new Date(),
    }).run();
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("只允许当前选中脚本中的最多 9 个分镜", async () => {
    const valid = await post(request({
      projectId,
      operationId: "image-batch:route-valid-001",
      kind: "image",
      itemKeys: ["shot:1", "shot:2"],
    }, cookie));
    expect(valid.status).toBe(201);
    await expect(valid.json()).resolves.toMatchObject({ expectedItems: 2, duplicate: false });

    const unknownShot = await post(request({
      projectId,
      operationId: "image-batch:route-unknown-001",
      kind: "image",
      itemKeys: ["shot:99"],
    }, cookie));
    expect(unknownShot.status).toBe(400);

    const tooMany = await post(request({
      projectId,
      operationId: "image-batch:route-many-001",
      kind: "image",
      itemKeys: Array.from({ length: 10 }, (_, index) => `shot:${index + 1}`),
    }, cookie));
    expect(tooMany.status).toBe(400);
  });

  it("图片套装 item 必须在服务端已保存规格内，且不能与分镜混用", async () => {
    const valid = await post(request({
      projectId: imagePackProjectId,
      operationId: "image-batch:pack-valid-001",
      kind: "image",
      itemKeys: ["pack:0", "pack:1"],
    }, cookie));
    expect(valid.status).toBe(201);

    const outsideSpec = await post(request({
      projectId: imagePackProjectId,
      operationId: "image-batch:pack-outside-001",
      kind: "image",
      itemKeys: ["pack:8"],
    }, cookie));
    expect(outsideSpec.status).toBe(400);

    const mixed = await post(request({
      projectId,
      operationId: "image-batch:mixed-route-001",
      kind: "image",
      itemKeys: ["shot:1", "pack:0"],
    }, cookie));
    expect(mixed.status).toBe(400);
  });
});
