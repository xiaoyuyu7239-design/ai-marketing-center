import { NextRequest, NextResponse } from "next/server";

import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import { getMotionVideoJob, toMotionVideoJobDto } from "@backend/core/video-jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; jobId: string }> },
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const { id, jobId } = await params;
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;
  const job = getMotionVideoJob(auth.merchant.id, id, jobId);
  if (!job) {
    return NextResponse.json(
      { error: "动态任务不存在", code: "MOTION_JOB_NOT_FOUND" },
      { status: 404, headers: NO_STORE_HEADERS },
    );
  }
  return NextResponse.json({ job: toMotionVideoJobDto(job) }, { headers: NO_STORE_HEADERS });
}
