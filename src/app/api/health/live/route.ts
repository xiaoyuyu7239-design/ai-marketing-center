import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
};

/** 只证明 Next.js 进程还能响应；这里故意不访问数据库、磁盘或 FFmpeg。 */
export function GET() {
  return NextResponse.json(
    { status: "ok" },
    {
      status: 200,
      headers: NO_STORE_HEADERS,
    },
  );
}
