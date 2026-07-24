import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

import { NextRequest, NextResponse } from "next/server";

import { parseRangeHeader } from "@backend/shared/http-range";
import { isAdminRequest } from "@server/admin/admin-auth";
import { getAgentStrategy } from "@server/admin/agents";
import { resolveGoldenArtifactForServing } from "@server/admin/evals/artifacts";
import { getGoldenCase } from "@server/admin/evals/golden-set";

function noStoreJson(payload: unknown, status: number) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ evalId: string; artifactId: string }> },
) {
  if (!isAdminRequest(req)) return noStoreJson({ error: "Unauthorized" }, 401);
  const { evalId, artifactId } = await params;
  if (!/^[A-Za-z0-9_-]{8,120}$/.test(evalId) || !/^[A-Za-z0-9.-]{20,100}$/.test(artifactId)) {
    return noStoreJson({ error: "评测产物不存在" }, 404);
  }

  const state = await getAgentStrategy();
  const record = state.evals.find((item) => item.id === evalId);
  if (!record || record.evaluationKind !== "golden" || !record.caseId) {
    return noStoreJson({ error: "评测产物不存在" }, 404);
  }
  let goldenCase;
  try {
    goldenCase = getGoldenCase(record.caseId);
  } catch {
    return noStoreJson({ error: "评测产物不存在" }, 404);
  }
  if (goldenCase.outputKind !== "media") {
    return noStoreJson({ error: "评测产物不存在" }, 404);
  }

  const requestedUrl = `/api/admin/model-evals/artifacts/${evalId}/${artifactId}`;
  if (!Array.isArray(record.artifactUrls) || !record.artifactUrls.includes(requestedUrl)) {
    // evalId 与文件必须同时出现在同一条持久化记录里，不允许跨记录猜测随机文件名。
    return noStoreJson({ error: "评测产物不存在" }, 404);
  }

  let artifact;
  try {
    artifact = await resolveGoldenArtifactForServing(evalId, requestedUrl, goldenCase.requiredShape.mediaType);
  } catch {
    return noStoreJson({ error: "评测产物不存在" }, 404);
  }

  const headers: Record<string, string> = {
    "Content-Type": artifact.mimeType,
    "Content-Length": String(artifact.sizeBytes),
    "Cache-Control": "private, no-store",
    Vary: "Cookie",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Accept-Ranges": "bytes",
  };
  const range = parseRangeHeader(req.headers.get("range"), artifact.sizeBytes);
  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: { ...headers, "Content-Range": `bytes */${artifact.sizeBytes}` },
    });
  }
  if (range) {
    const stream = Readable.toWeb(createReadStream(artifact.filePath, { start: range.start, end: range.end })) as ReadableStream;
    return new NextResponse(stream, {
      status: 206,
      headers: {
        ...headers,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Range": `bytes ${range.start}-${range.end}/${artifact.sizeBytes}`,
      },
    });
  }
  const stream = Readable.toWeb(createReadStream(artifact.filePath)) as ReadableStream;
  return new NextResponse(stream, { headers });
}
