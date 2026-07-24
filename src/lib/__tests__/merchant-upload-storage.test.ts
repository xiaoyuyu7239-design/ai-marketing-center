import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

describe("商户累计上传空间核算与并发预留", () => {
  let dataDir: string;
  let merchantId: string;
  let projectId: string;
  let sessionCookie: string;
  let storage: typeof import("@backend/core/security/merchant-upload-storage");
  let uploadProjectImages: typeof import("@/app/api/upload/route").POST;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-merchant-upload-"));
    process.env.APP_DATA_DIR = dataDir;
    const dbModule = await import("@backend/db");
    const schema = await import("@backend/db/schema");
    storage = await import("@backend/core/security/merchant-upload-storage");
    merchantId = "merchant-storage-a";
    projectId = "project-storage-a";
    dbModule.getDb().insert(schema.merchants).values({
      id: merchantId,
      email: "storage-a@example.com",
      passwordHash: "!test-only",
    }).run();
    dbModule.getDb().insert(schema.projects).values({
      id: projectId,
      merchantId,
      name: "空间核算项目",
    }).run();
    const session = await import("@backend/core/auth/session");
    const createdSession = await session.createSession(merchantId);
    sessionCookie = `${session.SESSION_COOKIE}=${createdSession.token}`;
    ({ POST: uploadProjectImages } = await import("@/app/api/upload/route"));

    mkdirSync(join(dataDir, "uploads", projectId), { recursive: true });
    writeFileSync(join(dataDir, "uploads", projectId, "project.bin"), Buffer.alloc(5));
    mkdirSync(join(dataDir, "uploads", "products", merchantId, "product-a"), { recursive: true });
    writeFileSync(join(dataDir, "uploads", "products", merchantId, "product-a", "owned.bin"), Buffer.alloc(4));

    // 两类历史无归属目录明确不计：旧 products/<productId> 和已从 DB 删除的孤儿项目。
    mkdirSync(join(dataDir, "uploads", "products", "legacy-product"), { recursive: true });
    writeFileSync(join(dataDir, "uploads", "products", "legacy-product", "legacy.bin"), Buffer.alloc(50));
    mkdirSync(join(dataDir, "uploads", "orphan-project"), { recursive: true });
    writeFileSync(join(dataDir, "uploads", "orphan-project", "orphan.bin"), Buffer.alloc(50));
  });

  beforeEach(() => {
    storage.resetMerchantUploadReservationsForTests();
    process.env.HUIMAI_MERCHANT_UPLOAD_MAX_BYTES = "16";
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    delete process.env.HUIMAI_MERCHANT_UPLOAD_MAX_BYTES;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("只统计该商户 DB 项目目录和 products/<merchantId>", async () => {
    await expect(storage.merchantOwnedUploadBytes(merchantId)).resolves.toBe(9);
  });

  it("并发预留串行核算，只有一个请求能占用最后空间", async () => {
    const results = await Promise.allSettled([
      storage.reserveMerchantUploadBytes(merchantId, 4),
      storage.reserveMerchantUploadBytes(merchantId, 4),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(storage.MerchantUploadQuotaExceededError);
    const accepted = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof storage.reserveMerchantUploadBytes>>> => result.status === "fulfilled");
    await accepted?.value.release();
  });

  it("失败/完成释放预留，release 幂等且之后可重新使用空间", async () => {
    const reservation = await storage.reserveMerchantUploadBytes(merchantId, 7);
    await expect(storage.reserveMerchantUploadBytes(merchantId, 1)).rejects.toBeInstanceOf(
      storage.MerchantUploadQuotaExceededError,
    );
    await reservation.release();
    await reservation.release();
    const next = await storage.reserveMerchantUploadBytes(merchantId, 7);
    await next.release();
  });

  it("真实上传路由在写盘前返回 413，不留下半批文件", async () => {
    process.env.HUIMAI_MERCHANT_UPLOAD_MAX_BYTES = "10";
    const form = new FormData();
    form.set("projectId", projectId);
    form.append("files", new Blob([Buffer.alloc(2)], { type: "image/png" }), "new.png");
    const before = readdirSync(join(dataDir, "uploads", projectId)).sort();
    const request = new NextRequest("http://test.local/api/upload", {
      method: "POST",
      headers: { Cookie: sessionCookie },
    });
    Object.defineProperty(request, "formData", { value: async () => form });
    const response = await uploadProjectImages(request);
    const payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(413);
    expect(payload).toMatchObject({ code: "MERCHANT_UPLOAD_QUOTA_EXCEEDED" });
    expect(readdirSync(join(dataDir, "uploads", projectId)).sort()).toEqual(before);
  });

  it("四个直接上传入口都在写盘前预留并在 finally 释放", () => {
    for (const route of [
      "src/app/api/upload/route.ts",
      "src/app/api/products/upload/route.ts",
      "src/app/api/project/[id]/materials/route.ts",
      "src/app/api/project/[id]/bgm/route.ts",
    ]) {
      const source = readFileSync(join(process.cwd(), route), "utf8");
      expect(source, route).toContain("reserveMerchantUploadBytes");
      expect(source, route).toContain("await reservation?.release()");
    }
  });
});
