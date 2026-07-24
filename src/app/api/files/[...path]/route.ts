import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@backend/shared/paths";
import { parseRangeHeader } from "@backend/shared/http-range";
import { stat } from "fs/promises";
import { join, normalize, sep } from "path";
import { createReadStream, existsSync } from "fs";
import { Readable } from "stream";
import { guardMediaAccess } from "@backend/core/auth/media-access";

// 静态文件服务 - 提供上传的图片/视频访问（商家私有内容，需会话且校验项目归属）
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path } = await params;

  // 上传根目录
  const uploadsRoot = join(getDataDir(), "uploads");
  // 解码并归一化路径后再拼接，防止 ..%2f 等编码绕过造成路径穿越
  const decodedSegments = path.map((seg) => decodeURIComponent(seg));

  // 租户守卫：按归一化后的真实首段目录校验项目归属（未登录 401、越权 404、运营/单用户放行）
  const denied = await guardMediaAccess(req, uploadsRoot, decodedSegments);
  if (denied) return denied;

  const filePath = normalize(join(uploadsRoot, ...decodedSegments));

  // 校验最终路径必须仍位于上传根目录内
  if (filePath !== uploadsRoot && !filePath.startsWith(uploadsRoot + sep)) {
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
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    mp4: "video/mp4",
    webm: "video/webm",
  };

  const baseHeaders: Record<string, string> = {
    "Content-Type": mimeTypes[ext || ""] || "application/octet-stream",
    "Cache-Control": "private, no-store",
    "Vary": "Cookie",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
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
