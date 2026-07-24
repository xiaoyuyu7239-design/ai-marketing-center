import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@backend/shared/paths";
import { writeFile, mkdir, readdir } from "fs/promises";
import { join } from "path";
import { classifyMaterial } from "@backend/providers/local-stock";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import { ensureStorageCapacity } from "@backend/core/security/storage-guard";
import { consumeExpensiveRouteRateLimit, rateLimitResponse } from "@backend/core/security/rate-limit";
import {
  merchantUploadStorageErrorResponse,
  reserveMerchantUploadBytes,
  type MerchantUploadReservation,
} from "@backend/core/security/merchant-upload-storage";
import {
  MATERIAL_UPLOAD_TYPES,
  randomUploadFileName,
  validateUploadContentLength,
  validateUploadFiles,
  type UploadPolicyError,
} from "@backend/core/security/upload-policy";

const SAFE_ID = /^[a-zA-Z0-9\-]+$/;
/** 单文件上限 80MB（视频较大，与素材下载上限一致） */
const MAX_FILE_SIZE = 80 * 1024 * 1024;
const MAX_FILE_COUNT = 12;
const MAX_TOTAL_SIZE = 160 * 1024 * 1024;
const UPLOAD_POLICY = {
  maxFiles: MAX_FILE_COUNT,
  maxFileBytes: MAX_FILE_SIZE,
  maxTotalBytes: MAX_TOTAL_SIZE,
  allowedTypes: MATERIAL_UPLOAD_TYPES,
} as const;

function uploadError(error: UploadPolicyError) {
  const fileName = error.fileName || "文件";
  const messages: Record<UploadPolicyError["code"], string> = {
    invalid_content_length: "无效的 Content-Length 请求头",
    content_length_exceeded: "上传请求体不能超过 160MB",
    no_files: "请上传至少一个视频或图片文件",
    too_many_files: `单次最多上传 ${MAX_FILE_COUNT} 个素材`,
    invalid_file_entry: "files 字段必须为视频或图片文件",
    empty_file: `文件 ${fileName} 不能为空`,
    file_too_large: `文件 ${fileName} 超过 80MB 大小限制`,
    total_too_large: "单次上传素材总大小不能超过 160MB",
    unsupported_extension: `文件 ${fileName} 扩展名不支持`,
    mime_extension_mismatch: `文件 ${fileName} 的扩展名与 MIME 类型不匹配或不受支持`,
  };
  return NextResponse.json({ error: messages[error.code] }, { status: error.status });
}

/** 项目本地素材池目录：uploads/{id}/materials/ */
function materialsDir(projectId: string) {
  return join(getDataDir(), "uploads", projectId, "materials");
}

/** GET /api/project/[id]/materials —— 列出该项目本地素材池（自带 B-roll） */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;
  let names: string[] = [];
  try {
    names = await readdir(materialsDir(id));
  } catch {
    /* 无目录 = 空池 */
  }
  const materials = names
    .map((name) => ({ name, mediaType: classifyMaterial(name) }))
    .filter((m) => m.mediaType !== null)
    .map((m) => ({ name: m.name, mediaType: m.mediaType, url: `/api/files/${id}/materials/${m.name}` }));
  return NextResponse.json({ materials });
}

/**
 * POST /api/project/[id]/materials —— 上传自有视频/图片 B-roll 到本地素材池。
 * 用自拍/自有素材配画面：上传到项目素材池，免网络免 Key。
 * multipart：files=<File[]>。落到 uploads/{id}/materials/，文件名重命名（不用原名，防安全问题）。
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const { id } = await params;
  if (!id || !SAFE_ID.test(id)) return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });
  const owned = await requireOwnedProject(auth.merchant.id, id);
  if ("error" in owned) return owned.error;
  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "upload:materials", {
    merchantBurst: 4,
    ipBurst: 12,
    merchantSustained: 20,
    ipSustained: 60,
  });
  if (!limit.allowed) return rateLimitResponse(limit, "素材上传过于频繁，请稍后再试");

  const contentLengthError = validateUploadContentLength(req.headers, MAX_TOTAL_SIZE);
  if (contentLengthError) return uploadError(contentLengthError);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "上传表单格式无效" }, { status: 400 });
  }
  // 整批文件先通过统一校验，再进行任何目录创建或写盘。
  const validation = validateUploadFiles(formData.getAll("files"), UPLOAD_POLICY);
  if (!validation.ok) return uploadError(validation.error);
  let reservation: MerchantUploadReservation | undefined;
  try {
    reservation = await reserveMerchantUploadBytes(auth.merchant.id, validation.totalBytes);
    await ensureStorageCapacity(validation.totalBytes);

    const dir = materialsDir(id);
    await mkdir(dir, { recursive: true });
    const saved: { name: string; mediaType: string; url: string }[] = [];
    for (const { file, extension } of validation.files) {
      const mediaType = classifyMaterial(`upload.${extension}`)!;
      const fileName = randomUploadFileName(extension);
      await writeFile(join(dir, fileName), Buffer.from(await file.arrayBuffer()));
      saved.push({ name: fileName, mediaType, url: `/api/files/${id}/materials/${fileName}` });
    }
    return NextResponse.json({ materials: saved });
  } catch (error) {
    const response = merchantUploadStorageErrorResponse(error);
    if (response) return response;
    throw error;
  } finally {
    await reservation?.release();
  }
}
