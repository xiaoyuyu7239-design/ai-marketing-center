import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@server/admin/admin-auth";
import { getOpsSnapshot } from "@server/admin/ops";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await getOpsSnapshot(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("读取运维告警失败:", error);
    return NextResponse.json(
      { error: "读取运维告警失败" },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}
