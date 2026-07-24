import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";

// 单用户模式（CLIPFORGE_SINGLE_USER=1）：CLI/MCP/Electron 的免登录路径。
// 关键行为：无 cookie 也放行 + 自动认领多租户改造前的无主存量数据。
describe("单用户模式", () => {
  let dataDir: string;
  let listProjects: typeof import("@/app/api/project/route").GET;
  let createProject: typeof import("@/app/api/project/route").POST;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-single-user-test-"));
    process.env.APP_DATA_DIR = dataDir;
    process.env.CLIPFORGE_SINGLE_USER = "1";
    ({ GET: listProjects, POST: createProject } = await import("@/app/api/project/route"));

    // 直接往库里塞一条"无主"存量项目，模拟多租户改造前的本地数据
    const { getDb } = await import("@backend/db");
    const { projects } = await import("@backend/db/schema");
    await getDb().insert(projects).values({ name: "升级前的老项目" });
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    delete process.env.CLIPFORGE_SINGLE_USER;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("无 cookie 也能建项目/看列表，且存量无主项目被认领可见", async () => {
    const createRes = await createProject(
      new NextRequest("http://localhost/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "CLI 新建项目", productName: "测试商品" }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.merchantId).toBeTruthy();

    const listRes = await listProjects(new NextRequest("http://localhost/api/project"));
    expect(listRes.status).toBe(200);
    const rows = await listRes.json();
    const names = rows.map((r: { name: string }) => r.name);
    expect(names).toContain("CLI 新建项目");
    expect(names).toContain("升级前的老项目"); // 孤儿数据被认领后可见
  });

  it("单用户商家使用不限量套餐", async () => {
    const { getDb } = await import("@backend/db");
    const { merchants } = await import("@backend/db/schema");
    const { eq } = await import("drizzle-orm");
    const [merchant] = await getDb().select().from(merchants).where(eq(merchants.email, "local@single-user"));
    expect(merchant.planId).toBe("unlimited");
  });
});
