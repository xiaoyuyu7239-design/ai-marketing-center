import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";

let mediaAccess: typeof import("@backend/core/auth/media-access");

function jsonRequest(url: string, method: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function getRequest(url: string, cookie?: string): NextRequest {
  return new NextRequest(url, { headers: cookie ? { Cookie: cookie } : {} });
}

function extractCookie(res: Response): string {
  return res.headers.get("set-cookie")!.split(";")[0];
}

// 媒体文件路由的租户守卫：商家私有的上传件/成片不能"知道 URL 就能看"
describe("媒体文件访问守卫 /api/files /api/output", () => {
  let dataDir: string;
  let cookieA: string;
  let cookieB: string;
  let adminCookie: string;
  let projectId: string;
  let merchantAId: string;
  let merchantBId: string;
  let originalDeploymentMode: string | undefined;
  let originalSingleUser: string | undefined;
  let filesGet: typeof import("@/app/api/files/[...path]/route").GET;
  let outputGet: typeof import("@/app/api/output/[...path]/route").GET;

  const fileParams = (...segments: string[]) => ({ params: Promise.resolve({ path: segments }) });

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-media-access-test-"));
    process.env.APP_DATA_DIR = dataDir;
    originalDeploymentMode = process.env.HUIMAI_DEPLOYMENT_MODE;
    originalSingleUser = process.env.CLIPFORGE_SINGLE_USER;
    process.env.HUIMAI_DEPLOYMENT_MODE = "saas";
    delete process.env.CLIPFORGE_SINGLE_USER;
    mediaAccess = await import("@backend/core/auth/media-access");
    const { createAdminToken, ADMIN_COOKIE_NAME } = await import("@server/admin/admin-auth");
    adminCookie = `${ADMIN_COOKIE_NAME}=${createAdminToken()}`;
    const { POST: register } = await import("@/app/api/auth/register/route");
    const { POST: createProject } = await import("@/app/api/project/route");
    ({ GET: filesGet } = await import("@/app/api/files/[...path]/route"));
    ({ GET: outputGet } = await import("@/app/api/output/[...path]/route"));

    const registeredA = await register(jsonRequest("http://localhost/api/auth/register", "POST", { email: "media-a@example.com", password: "password-123" }));
    cookieA = extractCookie(registeredA);
    merchantAId = (await registeredA.json()).merchant.id;
    const registeredB = await register(jsonRequest("http://localhost/api/auth/register", "POST", { email: "media-b@example.com", password: "password-123" }));
    cookieB = extractCookie(registeredB);
    merchantBId = (await registeredB.json()).merchant.id;
    const projRes = await createProject(jsonRequest("http://localhost/api/project", "POST", { name: "媒体项目", productName: "商品" }, cookieA));
    projectId = (await projRes.json()).id;

    // 直接落两个文件：上传件 + 成片
    mkdirSync(join(dataDir, "uploads", projectId), { recursive: true });
    writeFileSync(join(dataDir, "uploads", projectId, "pic.png"), "fake-png");
    mkdirSync(join(dataDir, "output", projectId), { recursive: true });
    writeFileSync(join(dataDir, "output", projectId, "video.mp4"), "fake-mp4");
    // 商品库目录必须带 merchantId，不能继续把 products 当成全局共享区。
    mkdirSync(join(dataDir, "uploads", "products", merchantAId, "prod-1"), { recursive: true });
    writeFileSync(join(dataDir, "uploads", "products", merchantAId, "prod-1", "p.png"), "fake-png");
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    if (originalDeploymentMode === undefined) delete process.env.HUIMAI_DEPLOYMENT_MODE;
    else process.env.HUIMAI_DEPLOYMENT_MODE = originalDeploymentMode;
    if (originalSingleUser === undefined) delete process.env.CLIPFORGE_SINGLE_USER;
    else process.env.CLIPFORGE_SINGLE_USER = originalSingleUser;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("未登录：上传件与成片一律 401", async () => {
    expect((await filesGet(getRequest(`http://localhost/api/files/${projectId}/pic.png`), fileParams(projectId, "pic.png"))).status).toBe(401);
    expect((await outputGet(getRequest(`http://localhost/api/output/${projectId}/video.mp4`), fileParams(projectId, "video.mp4"))).status).toBe(401);
  });

  it("项目归属商家可读，其他商家 404，运营后台可读", async () => {
    expect((await filesGet(getRequest(`http://localhost/api/files/${projectId}/pic.png`, cookieA), fileParams(projectId, "pic.png"))).status).toBe(200);
    expect((await outputGet(getRequest(`http://localhost/api/output/${projectId}/video.mp4`, cookieA), fileParams(projectId, "video.mp4"))).status).toBe(200);

    expect((await filesGet(getRequest(`http://localhost/api/files/${projectId}/pic.png`, cookieB), fileParams(projectId, "pic.png"))).status).toBe(404);
    expect((await outputGet(getRequest(`http://localhost/api/output/${projectId}/video.mp4`, cookieB), fileParams(projectId, "video.mp4"))).status).toBe(404);

    // 运营审核成片预览
    expect((await outputGet(getRequest(`http://localhost/api/output/${projectId}/video.mp4`, adminCookie), fileParams(projectId, "video.mp4"))).status).toBe(200);
  });

  it("products/<merchantId> 仅所属商家可读，跨租户 404，运营后台可读", async () => {
    const url = `http://localhost/api/files/products/${merchantAId}/prod-1/p.png`;
    const params = fileParams("products", merchantAId, "prod-1", "p.png");

    expect((await filesGet(getRequest(url, cookieA), params)).status).toBe(200);
    expect((await filesGet(getRequest(url, cookieB), params)).status).toBe(404);
    expect((await filesGet(getRequest(url, adminCookie), params)).status).toBe(200);
  });

  it("商品路径用自己的 merchantId 作前缀再编码穿越到别的商家时仍按真实归属拒绝", async () => {
    const res = await filesGet(
      getRequest(
        `http://localhost/api/files/products/${merchantBId}/prod-b/..%2f..%2f${merchantAId}/prod-1/p.png`,
        cookieB
      ),
      fileParams("products", merchantBId, "prod-b", "..", "..", merchantAId, "prod-1", "p.png")
    );

    expect(res.status).toBe(404);
  });

  it("用自己 projectId 作首段 + 编码 .. 穿越到别人目录：归属校验按真实首段兜住", async () => {
    // 商家 B 建一个自己的项目作首段，再用 %2e%2e 穿越回商家 A 的成片目录
    const { POST: createProject } = await import("@/app/api/project/route");
    const projRes = await createProject(jsonRequest("http://localhost/api/project", "POST", { name: "B的项目", productName: "B商品" }, cookieB));
    const projectB = (await projRes.json()).id;
    // 路由拿到的 path 段是 URL 已解码的形态；用 ".." 段模拟 %2e%2e 解码后的结果
    const res = await outputGet(
      getRequest(`http://localhost/api/output/${projectB}/..%2f${projectId}/video.mp4`, cookieB),
      fileParams(projectB, "..", projectId, "video.mp4")
    );
    // 穿越后真实首段是商家 A 的 projectId，不属于 B → 404（绝不能 200 读到 A 的成片）
    expect(res.status).toBe(404);
  });
});

describe("请求体媒体引用归属解析", () => {
  it("只接受 products/<当前 merchantId>/<productId>/<file>", () => {
    const owned = "/api/files/products/merchant-a/product-a/cover.png";

    expect(mediaAccess.mediaRefBelongsToMerchant(owned, "merchant-a", "project-a")).toBe(true);
    expect(mediaAccess.mediaRefBelongsToMerchant(owned, "merchant-b", "project-b")).toBe(false);
    expect(mediaAccess.mediaRefBelongsToMerchant("/api/files/products/product-a/cover.png", "merchant-a", "project-a")).toBe(false);
  });

  it("编码 .. 会先归一化到真实商家，攻击者不能靠自己的前缀越权", () => {
    const traversed = "/api/files/products/merchant-b/product-b/%2e%2e/%2e%2e/merchant-a/product-a/secret.png";

    expect(mediaAccess.parseMediaRef(traversed)?.segments).toEqual([
      "products",
      "merchant-a",
      "product-a",
      "secret.png",
    ]);
    expect(mediaAccess.mediaRefBelongsToMerchant(traversed, "merchant-b", "project-b")).toBe(false);
    expect(mediaAccess.resolveOwnedUploadRef(traversed, "merchant-b", "project-b")).toBeNull();
  });

  it("编码穿出媒体根目录会被解析器直接拒绝", () => {
    const escaped = "/api/files/%2e%2e/%2e%2e/etc/passwd";

    expect(mediaAccess.parseMediaRef(escaped)).toBeNull();
    expect(mediaAccess.resolveOwnedUploadRef(escaped, "merchant-a", "project-a")).toBeNull();
  });
});
