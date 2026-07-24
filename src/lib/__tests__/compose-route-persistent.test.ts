import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

function request(
  url: string,
  method: "GET" | "POST" | "DELETE",
  options: { body?: string; cookie?: string; idempotencyKey?: string } = {},
): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.idempotencyKey ? { "Idempotency-Key": options.idempotencyKey } : {}),
    },
    ...(options.body !== undefined ? { body: options.body } : {}),
  });
}

function extractCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("注册响应未下发会话 cookie");
  return cookie;
}

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

describe("/api/project/[id]/compose 持久入队", () => {
  let dataDir: string;
  let cookie: string;
  let secondCookie: string;
  let merchantId: string;
  let projectId: string;
  let composeGet: typeof import("@/app/api/project/[id]/compose/route").GET;
  let composePost: typeof import("@/app/api/project/[id]/compose/route").POST;
  let composeDelete: typeof import("@/app/api/project/[id]/compose/route").DELETE;
  let repository: typeof import("@backend/core/jobs/repository");

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-compose-route-"));
    process.env.APP_DATA_DIR = dataDir;
    const { POST: register } = await import("@/app/api/auth/register/route");
    const { POST: createProject } = await import("@/app/api/project/route");
    ({ GET: composeGet, POST: composePost, DELETE: composeDelete } = await import(
      "@/app/api/project/[id]/compose/route"
    ));
    repository = await import("@backend/core/jobs/repository");

    const registered = await register(
      request("http://test.local/api/auth/register", "POST", {
        body: JSON.stringify({
          email: "compose-route@example.com",
          password: "correct-horse-battery",
          shopName: "持久任务测试店",
        }),
      }),
    );
    expect(registered.status).toBe(201);
    cookie = extractCookie(registered);
    merchantId = (await registered.json()).merchant.id;

    const secondRegistered = await register(
      request("http://test.local/api/auth/register", "POST", {
        body: JSON.stringify({
          email: "compose-route-second@example.com",
          password: "correct-horse-battery",
          shopName: "第二租户测试店",
        }),
      }),
    );
    expect(secondRegistered.status).toBe(201);
    secondCookie = extractCookie(secondRegistered);

    const projectResponse = await createProject(
      request("http://test.local/api/project", "POST", {
        cookie,
        body: JSON.stringify({ name: "持久合成测试", productName: "测试商品" }),
      }),
    );
    expect(projectResponse.status).toBe(201);
    projectId = (await projectResponse.json()).id;

    const { getDb } = await import("@backend/db");
    const { assets, scripts } = await import("@backend/db/schema");
    getDb()
      .insert(scripts)
      .values({
        projectId,
        version: 1,
        selected: true,
        styleType: "scene",
        shots: [
          {
            shotId: 1,
            type: "hook",
            duration: 3,
            description: "商品特写",
            camera: "推近",
            visualSource: "user_upload",
            transition: "direct_concat",
            voiceover: "这是一条内测合成文案",
          },
        ],
      })
      .run();
    const fileRef = `/api/files/${projectId}/shot-1.png`;
    const projectUploads = join(dataDir, "uploads", projectId);
    mkdirSync(projectUploads, { recursive: true });
    writeFileSync(join(projectUploads, "shot-1.png"), Buffer.from("test-image"));
    getDb()
      .insert(assets)
      .values({ projectId, shotId: 1, type: "user_upload", filePath: fileRef, status: "done" })
      .run();
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("缺少 Idempotency-Key 直接 400，不留任何合成记录", async () => {
    const response = await composePost(
      request(`http://test.local/api/project/${projectId}/compose`, "POST", {
        cookie,
        body: JSON.stringify({ resolution: "720p" }),
      }),
      routeParams(projectId),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Idempotency-Key") });
  });

  it("POST 只入队并立即 202；同 key 仅允许同一冻结请求重放", async () => {
    const url = `http://test.local/api/project/${projectId}/compose`;
    const frozenBody = JSON.stringify({
      resolution: "720p",
      aspectRatio: "9:16",
      freeTts: { enabled: true },
    });
    const first = await composePost(
      request(url, "POST", {
        cookie,
        idempotencyKey: "compose-route-key-0001",
        body: frozenBody,
      }),
      routeParams(projectId),
    );
    expect(first.status).toBe(202);
    expect(first.headers.get("location")).toContain("compositionId=");
    expect(first.headers.get("retry-after")).toBe("3");
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ status: "pending", duplicate: false });

    const duplicate = await composePost(
      request(url, "POST", {
        cookie,
        idempotencyKey: "compose-route-key-0001",
        body: frozenBody,
      }),
      routeParams(projectId),
    );
    expect(duplicate.status).toBe(202);
    const duplicateBody = await duplicate.json();
    expect(duplicateBody).toMatchObject({
      jobId: firstBody.jobId,
      compositionId: firstBody.compositionId,
      duplicate: true,
    });

    const broken = await composePost(
      request(url, "POST", {
        cookie,
        idempotencyKey: "compose-route-key-0001",
        body: "{broken-json",
      }),
      routeParams(projectId),
    );
    expect(broken.status).toBe(400);

    const changed = await composePost(
      request(url, "POST", {
        cookie,
        idempotencyKey: "compose-route-key-0001",
        body: JSON.stringify({
          resolution: "1080p",
          aspectRatio: "9:16",
          freeTts: { enabled: true },
        }),
      }),
      routeParams(projectId),
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ error: expect.stringContaining("Idempotency-Key") });

    const exact = await composeGet(
      request(`${url}?compositionId=${firstBody.compositionId}`, "GET", { cookie }),
      routeParams(projectId),
    );
    expect(exact.status).toBe(200);
    const exactBody = await exact.json();
    expect(exactBody.composition).toMatchObject({
      id: firstBody.compositionId,
      jobId: firstBody.jobId,
      jobStatus: "pending",
      status: "pending",
      url: null,
    });
    expect(exactBody.composition).not.toHaveProperty("outputPath");
    expect(exact.headers.get("cache-control")).toContain("no-store");

    // 不让本用例的 pending 占用后续用例的全局单 worker claim。
    const cleanup = await composeDelete(
      request(`${url}?compositionId=${firstBody.compositionId}`, "DELETE", { cookie }),
      routeParams(projectId),
    );
    expect(cleanup.status).toBe(200);
  });

  it("GET 精确 compositionId 不存在返回 404，不会悟读 latest", async () => {
    const response = await composeGet(
      request(
        `http://test.local/api/project/${projectId}/compose?compositionId=missing-composition`,
        "GET",
        { cookie },
      ),
      routeParams(projectId),
    );
    expect(response.status).toBe(404);
  });

  it("GET 不带 compositionId 优先返回最新 done，不被更新的失败记录遮蔽", async () => {
    const { getDb } = await import("@backend/db");
    const { compositions } = await import("@backend/db/schema");
    const doneId = crypto.randomUUID();
    getDb().insert(compositions).values([
      {
        id: doneId,
        projectId,
        outputPath: `/data/output/${projectId}/stable-done.mp4`,
        resolution: "720p",
        aspectRatio: "9:16",
        status: "done",
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        id: crypto.randomUUID(),
        projectId,
        resolution: "720p",
        aspectRatio: "9:16",
        status: "failed",
        createdAt: new Date("2026-01-02T00:00:00.000Z"),
      },
    ]).run();

    const response = await composeGet(
      request(`http://test.local/api/project/${projectId}/compose`, "GET", { cookie }),
      routeParams(projectId),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      composition: {
        id: doneId,
        status: "done",
        fileName: "stable-done.mp4",
      },
    });
  });

  it("DELETE 持久取消 pending；GET 精确回传取消原因；running 取消返回 409", async () => {
    const url = `http://test.local/api/project/${projectId}/compose`;
    const queued = await composePost(
      request(url, "POST", {
        cookie,
        idempotencyKey: "compose-route-key-0002",
        body: JSON.stringify({ resolution: "720p" }),
      }),
      routeParams(projectId),
    );
    const queuedBody = await queued.json();
    const cancelled = await composeDelete(
      request(`${url}?compositionId=${queuedBody.compositionId}`, "DELETE", { cookie }),
      routeParams(projectId),
    );
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ jobStatus: "cancelled", cancelled: true });

    const cancelledGet = await composeGet(
      request(`${url}?compositionId=${queuedBody.compositionId}`, "GET", { cookie }),
      routeParams(projectId),
    );
    expect(await cancelledGet.json()).toMatchObject({
      composition: {
        jobStatus: "cancelled",
        status: "failed",
        errorMessage: "任务已由用户取消",
      },
    });

    const runningResponse = await composePost(
      request(url, "POST", {
        cookie,
        idempotencyKey: "compose-route-key-0003",
        body: JSON.stringify({ resolution: "720p" }),
      }),
      routeParams(projectId),
    );
    expect(runningResponse.status).toBe(202);
    const runningBody = await runningResponse.json();
    const claimed = repository.claimNextJob("route-test-worker", new Date(Date.now() + 1_000));
    expect(claimed?.compositionId).toBe(runningBody.compositionId);
    const conflict = await composeDelete(
      request(`${url}?compositionId=${runningBody.compositionId}`, "DELETE", { cookie }),
      routeParams(projectId),
    );
    expect(conflict.status).toBe(409);
  });

  it("路由不会把 job 归属扩大到其他商家", async () => {
    const result = repository.findComposeJobByIdempotency(
      merchantId,
      projectId,
      "compose-route-key-0001",
    );
    expect(result?.job.merchantId).toBe(merchantId);
    expect(result?.job.projectId).toBe(projectId);
  });

  it("第二租户无法 GET 或 DELETE 第一租户的真实 composition", async () => {
    const url = `http://test.local/api/project/${projectId}/compose`;
    const queued = await composePost(
      request(url, "POST", {
        cookie,
        idempotencyKey: "compose-route-isolation-0001",
        body: JSON.stringify({ resolution: "720p" }),
      }),
      routeParams(projectId),
    );
    expect(queued.status).toBe(202);
    const queuedBody = await queued.json();
    const exactUrl = `${url}?compositionId=${queuedBody.compositionId}`;

    const foreignGet = await composeGet(
      request(exactUrl, "GET", { cookie: secondCookie }),
      routeParams(projectId),
    );
    const foreignDelete = await composeDelete(
      request(exactUrl, "DELETE", { cookie: secondCookie }),
      routeParams(projectId),
    );
    expect(foreignGet.status).toBe(404);
    expect(foreignDelete.status).toBe(404);

    const ownerGet = await composeGet(
      request(exactUrl, "GET", { cookie }),
      routeParams(projectId),
    );
    expect(ownerGet.status).toBe(200);
    expect(await ownerGet.json()).toMatchObject({
      composition: { id: queuedBody.compositionId, jobStatus: "pending" },
    });

    const cleanup = await composeDelete(
      request(exactUrl, "DELETE", { cookie }),
      routeParams(projectId),
    );
    expect(cleanup.status).toBe(200);
  });
});
