import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@backend/shared/paths";
import { parseRangeHeader } from "@backend/shared/http-range";
import { stat } from "fs/promises";
import { join, normalize, sep } from "path";
import { createReadStream, existsSync } from "fs";
import { Readable } from "stream";
import { guardMediaAccess } from "@backend/core/auth/media-access";

// 合成产物（视频）文件服务 - 提供 data/output 下的成片访问/下载（商家私有内容，需会话且校验项目归属）
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;

  const outputRoot = join(getDataDir(), "output");
  // 解码并归一化路径，防止 ..%2f 等编码绕过造成路径穿越
  const decodedSegments = path.map((seg) => decodeURIComponent(seg));

  // 租户守卫：按归一化后的真实首段目录校验项目归属（未登录 401、越权 404、运营/单用户放行）
  const denied = await guardMediaAccess(req, outputRoot, decodedSegments);
  if (denied) return denied;

  const filePath = normalize(join(outputRoot, ...decodedSegments));

  if (filePath !== outputRoot && !filePath.startsWith(outputRoot + sep)) {
    return NextResponse.json({ error: "非法路径" }, { status: 403 });
  }

  if (!existsSync(filePath)) {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }

  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }
  const size = fileStat.size;
  const ext = filePath.split(".").pop()?.toLowerCase();
  const mimeTypes: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
  };

  // 可选下载：?download=1 时提示浏览器下载
  const download = req.nextUrl.searchParams.get("download");
  const fileName = filePath.split(sep).pop() ?? "video.mp4";

  const baseHeaders: Record<string, string> = {
    "Content-Type": mimeTypes[ext || ""] || "application/octet-stream",
    "Cache-Control": "private, no-store",
    "Vary": "Cookie",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
    ...(download ? { "Content-Disposition": `attachment; filename="${fileName}"` } : {}),
  };

  const range = parseRangeHeader(req.headers.get("range"), size);
  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes */${size}`,
      },
    });
  }

  if (range) {
    const stream = Readable.toWeb(
      createReadStream(filePath, { start: range.start, end: range.end })
    ) as ReadableStream;
    return new NextResponse(stream, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${range.start}-${range.end}/${size}`,
        "Content-Length": String(range.end - range.start + 1),
      },
    });
  }

  const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new NextResponse(stream, {
    headers: {
      ...baseHeaders,
      "Content-Length": String(size),
    },
  });
}
