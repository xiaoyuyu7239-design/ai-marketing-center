import { NextRequest, NextResponse } from "next/server";
import { shouldBlockSaasApi } from "@server/security/saas-launch-gate";

export function proxy(request: NextRequest) {
  const blocked = shouldBlockSaasApi({
    nodeEnv: process.env.NODE_ENV,
    pathname: request.nextUrl.pathname,
  });

  if (blocked) {
    return NextResponse.json(
      {
        error: "服务端真实用户认证尚未启用，业务 API 已安全关闭。",
        code: "SAAS_AUTH_NOT_READY",
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/api/:path*"],
};
