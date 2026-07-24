import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";

function jsonRequest(url: string, method: string, body: unknown, cookie?: string): NextRequest {
  return new NextRequest(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("响应没有 Set-Cookie，测试前置条件不满足");
  return setCookie.split(";")[0];
}

describe("商家数据租户隔离", () => {
  let dataDir: string;
  let register: typeof import("@/app/api/auth/register/route").POST;
  let listProjects: typeof import("@/app/api/project/route").GET;
  let createProject: typeof import("@/app/api/project/route").POST;
  let getProject: typeof import("@/app/api/project/[id]/route").GET;
  let patchProject: typeof import("@/app/api/project/[id]/route").PATCH;
  let deleteProject: typeof import("@/app/api/project/[id]/route").DELETE;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-tenant-test-"));
    process.env.APP_DATA_DIR = dataDir;
    ({ POST: register } = await import("@/app/api/auth/register/route"));
    ({ GET: listProjects, POST: createProject } = await import("@/app/api/project/route"));
    ({ GET: getProject, PATCH: patchProject, DELETE: deleteProject } = await import("@/app/api/project/[id]/route"));
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("两个商家各自建项目后互相看不到、改不动、删不掉对方的数据", async () => {
    const registerA = await register(jsonRequest("http://localhost/api/auth/register", "POST", { email: "merchant-a@example.com", password: "password-a-123" }));
    const cookieA = extractCookie(registerA);
    const registerB = await register(jsonRequest("http://localhost/api/auth/register", "POST", { email: "merchant-b@example.com", password: "password-b-123" }));
    const cookieB = extractCookie(registerB);

    const createA = await createProject(jsonRequest("http://localhost/api/project", "POST", { name: "商家A的项目", productName: "A的商品" }, cookieA));
    const projectA = await createA.json();
    const createB = await createProject(jsonRequest("http://localhost/api/project", "POST", { name: "商家B的项目", productName: "B的商品" }, cookieB));
    const projectB = await createB.json();
    expect(projectA.id).not.toBe(projectB.id);

    // 列表只看得到自己的
    const listA = await listProjects(jsonRequest("http://localhost/api/project", "GET", undefined, cookieA));
    const projectsA = await listA.json();
    expect(projectsA.map((p: { id: string }) => p.id)).toContain(projectA.id);
    expect(projectsA.map((p: { id: string }) => p.id)).not.toContain(projectB.id);

    // 商家 A 拿不到商家 B 的项目详情（统一 404，不是 403，不暴露"存在但不是你的"）
    const getBAsA = await getProject(jsonRequest(`http://localhost/api/project/${projectB.id}`, "GET", undefined, cookieA), {
      params: Promise.resolve({ id: projectB.id }),
    });
    expect(getBAsA.status).toBe(404);

    // 商家 A 改不动商家 B 的项目
    const patchBAsA = await patchProject(
      jsonRequest(`http://localhost/api/project/${projectB.id}`, "PATCH", { name: "被商家A改掉的名字" }, cookieA),
      { params: Promise.resolve({ id: projectB.id }) }
    );
    expect(patchBAsA.status).toBe(404);

    // 商家 A 删不掉商家 B 的项目；商家 B 自己还能看到它、名字也没被改
    await deleteProject(jsonRequest(`http://localhost/api/project/${projectB.id}`, "DELETE", undefined, cookieA), {
      params: Promise.resolve({ id: projectB.id }),
    });
    const getBAsB = await getProject(jsonRequest(`http://localhost/api/project/${projectB.id}`, "GET", undefined, cookieB), {
      params: Promise.resolve({ id: projectB.id }),
    });
    expect(getBAsB.status).toBe(200);
    const projectBData = await getBAsB.json();
    expect(projectBData.name).toBe("商家B的项目");

    // 商家 A 访问自己的项目一切正常（不是鉴权把自己也挡住了）
    const getAAsA = await getProject(jsonRequest(`http://localhost/api/project/${projectA.id}`, "GET", undefined, cookieA), {
      params: Promise.resolve({ id: projectA.id }),
    });
    expect(getAAsA.status).toBe(200);
  });

  it("未登录访问项目接口一律 401", async () => {
    const res = await listProjects(jsonRequest("http://localhost/api/project", "GET", undefined));
    expect(res.status).toBe(401);
  });
});
