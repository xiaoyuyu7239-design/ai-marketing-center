import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@backend/shared/paths";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import { ensureStorageCapacity } from "@backend/core/security/storage-guard";
import { consumeExpensiveRouteRateLimit, rateLimitResponse } from "@backend/core/security/rate-limit";
import {
  merchantUploadStorageErrorResponse,
  reserveMerchantUploadBytes,
  type MerchantUploadReservation,
} from "@backend/core/security/merchant-upload-storage";
import {
  AUDIO_UPLOAD_TYPES,
  randomUploadFileName,
  validateUploadContentLength,
  validateUploadFiles,
  type UploadPolicyError,
} from "@backend/core/security/upload-policy";

const MAX_FILE_SIZE = 20 * 1024 * 1024;
const UPLOAD_POLICY = {
  maxFiles: 1,
  maxFileBytes: MAX_FILE_SIZE,
  maxTotalBytes: MAX_FILE_SIZE,
  allowedTypes: AUDIO_UPLOAD_TYPES,
} as const;

function uploadError(error: UploadPolicyError) {
  const messages: Record<UploadPolicyError["code"], string> = {
    invalid_content_length: "无效的 Content-Length 请求头",
    content_length_exceeded: "上传请求体不能超过 20MB",
    no_files: "未收到音频文件",
    too_many_files: "一次只能上传一个音频文件",
    invalid_file_entry: "file 字段必须为音频文件",
    empty_file: "音频文件不能为空",
    file_too_large: "音频不超过 20MB",
    total_too_large: "音频不超过 20MB",
    unsupported_extension: "仅支持 mp3/wav/aac/m4a 音频",
    mime_extension_mismatch: "音频扩展名与 MIME 类型不匹配或不受支持",
  };
  return NextResponse.json({ error: messages[error.code] }, { status: error.status });
}

// 上传背景音乐（合成时混入并自动压低，让位配音）
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const { id } = await params;
    if (!/^[a-zA-Z0-9-]+$/.test(id)) {
      return NextResponse.json({ error: "无效的项目ID" }, { status: 400 });
    }
    const owned = await requireOwnedProject(auth.merchant.id, id);
    if ("error" in owned) return owned.error;
    const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "upload:bgm", {
      merchantBurst: 4,
      ipBurst: 12,
      merchantSustained: 20,
      ipSustained: 60,
    });
    if (!limit.allowed) return rateLimitResponse(limit, "背景音乐上传过于频繁，请稍后再试");

    const contentLengthError = validateUploadContentLength(req.headers, MAX_FILE_SIZE);
    if (contentLengthError) return uploadError(contentLengthError);

    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json({ error: "上传表单格式无效" }, { status: 400 });
    }
    const validation = validateUploadFiles(formData.getAll("file"), UPLOAD_POLICY);
    if (!validation.ok) return uploadError(validation.error);
    let reservation: MerchantUploadReservation | undefined;
    try {
      reservation = await reserveMerchantUploadBytes(auth.merchant.id, validation.totalBytes);
      await ensureStorageCapacity(validation.totalBytes);

      const { file, extension } = validation.files[0];
      const dir = join(getDataDir(), "uploads", id);
      await mkdir(dir, { recursive: true });
      const fileName = randomUploadFileName(extension, "bgm");
      await writeFile(join(dir, fileName), Buffer.from(await file.arrayBuffer()));
      return NextResponse.json({ success: true, path: `/api/files/${id}/${fileName}`, name: file.name });
    } catch (error) {
      const response = merchantUploadStorageErrorResponse(error);
      if (response) return response;
      throw error;
    } finally {
      await reservation?.release();
    }
  } catch (error) {
    console.error("BGM 上传失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "上传失败" },
      { status: 500 }
    );
  }
}
