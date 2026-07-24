import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@server/admin/admin-auth";
import { listReviewQueue, setReviewStatus } from "@server/admin/merchants";

// 内容审核队列：?status=pending|approved|rejected 过滤，缺省返回全部
export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const status = req.nextUrl.searchParams.get("status") ?? undefined;
    return NextResponse.json({ records: await listReviewQueue(status) });
  } catch (error) {
    console.error("读取审核队列失败:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取审核队列失败" }, { status: 500 });
  }
}

// 审核动作：body { recordId, reviewStatus: "approved"|"rejected"|"pending" }
// 驳回后该内容立即从商家的待发布库/今日推荐消失（商家端按 reviewStatus 过滤）
export async function PATCH(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const recordId = typeof body.recordId === "string" ? body.recordId : "";
    if (!recordId) return NextResponse.json({ error: "缺少 recordId" }, { status: 400 });
    const result = await setReviewStatus(recordId, body.reviewStatus, body.reviewNote);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("更新审核状态失败:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新审核状态失败" }, { status: 500 });
  }
}
