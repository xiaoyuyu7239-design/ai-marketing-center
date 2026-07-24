import { NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkReadiness } from "@backend/core/ops/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

function readinessHeaders() {
  let codeVersion = "";
  try {
    codeVersion = readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    // dev/test 可能尚无 BUILD_ID；正式 standalone 制品缺失时预检会因响应头不匹配失败关闭。
  }
  return {
    ...NO_STORE_HEADERS,
    ...(codeVersion ? { "X-Huimai-Code-Version": codeVersion.slice(0, 200) } : {}),
  };
}

export async function GET() {
  const result = await checkReadiness();
  if (!result.ok) {
    // 路由响应保持通用，依赖名称、路径和二进制错误只写服务端日志。
    console.error("Readiness check failed", result.checks);
  }

  return NextResponse.json(
    { status: result.ok ? "ready" : "not_ready" },
    {
      status: result.ok ? 200 : 503,
      headers: readinessHeaders(),
    },
  );
}
