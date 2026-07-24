import { NextRequest, NextResponse } from "next/server";
import { getDataDir } from "@backend/shared/paths";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { requireMerchant } from "@backend/core/auth/require-merchant";
import { ensureStorageCapacity } from "@backend/core/security/storage-guard";
import { consumeExpensiveRouteRateLimit, rateLimitResponse } from "@backend/core/security/rate-limit";
import {
  merchantUploadStorageErrorResponse,
  reserveMerchantUploadBytes,
  type MerchantUploadReservation,
} from "@backend/core/security/merchant-upload-storage";
import {
  IMAGE_UPLOAD_TYPES,
  randomUploadFileName,
  validateUploadContentLength,
  validateUploadFiles,
  type UploadPolicyError,
} from "@backend/core/security/upload-policy";

/** 单文件最大大小（20MB） */
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const MAX_FILE_COUNT = 12;
const MAX_TOTAL_SIZE = 80 * 1024 * 1024;
const UPLOAD_POLICY = {
  maxFiles: MAX_FILE_COUNT,
  maxFileBytes: MAX_FILE_SIZE,
  maxTotalBytes: MAX_TOTAL_SIZE,
  allowedTypes: IMAGE_UPLOAD_TYPES,
} as const;

function uploadError(error: UploadPolicyError) {
  const fileName = error.fileName || "文件";
  const messages: Record<UploadPolicyError["code"], string> = {
    invalid_content_length: "无效的 Content-Length 请求头",
    content_length_exceeded: "上传请求体不能超过 80MB",
    no_files: "请上传至少一张图片",
    too_many_files: `单次最多上传 ${MAX_FILE_COUNT} 张图片`,
    invalid_file_entry: "files 字段必须为图片文件",
    empty_file: `文件 ${fileName} 不能为空`,
    file_too_large: `文件 ${fileName} 超过 20MB 大小限制`,
    total_too_large: "单次上传图片总大小不能超过 80MB",
    unsupported_extension: `文件 ${fileName} 扩展名不支持`,
    mime_extension_mismatch: `文件 ${fileName} 的扩展名与 MIME 类型不匹配或不受支持`,
  };
  return NextResponse.json({ error: messages[error.code] }, { status: error.status });
}

// 上传商品库图片：不绑定 project，按 merchantId/productId 隔离落盘。
// 返回的 /api/files/products/... 路径可被现有静态文件路由直接读取，刷新/跨页均有效（取代易失效的 blob: URL）
export async function POST(req: NextRequest) {
  // 鉴权：必须登录商家，防匿名写盘 DoS / 投毒。
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;

  const limit = consumeExpensiveRouteRateLimit(req, auth.merchant.id, "upload:products", {
    merchantBurst: 8,
    ipBurst: 24,
    merchantSustained: 30,
    ipSustained: 120,
  });
  if (!limit.allowed) return rateLimitResponse(limit, "商品图上传过于频繁，请稍后再试");

  const contentLengthError = validateUploadContentLength(req.headers, MAX_TOTAL_SIZE);
  if (contentLengthError) return uploadError(contentLengthError);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "上传表单格式无效" }, { status: 400 });
  }
  const productValue = formData.get("productId");
  const productId = typeof productValue === "string" ? productValue : "";

  if (!productId) {
    return NextResponse.json({ error: "缺少商品ID" }, { status: 400 });
  }

  // 校验 productId 防止路径穿越（只允许 UUID 格式或字母数字连字符）
  if (!/^[a-zA-Z0-9\-]+$/.test(productId)) {
    return NextResponse.json({ error: "无效的商品ID格式" }, { status: 400 });
  }

  // 整批文件先通过统一校验，再进行任何目录创建或写盘。
  const validation = validateUploadFiles(formData.getAll("files"), UPLOAD_POLICY);
  if (!validation.ok) return uploadError(validation.error);
  let reservation: MerchantUploadReservation | undefined;
  try {
    reservation = await reserveMerchantUploadBytes(auth.merchant.id, validation.totalBytes);
    await ensureStorageCapacity(validation.totalBytes);

    // 商品图按商家隔离：uploads/products/<merchantId>/<productId>/
    const uploadDir = join(getDataDir(), "uploads", "products", auth.merchant.id, productId);
    await mkdir(uploadDir, { recursive: true });

    const savedPaths: string[] = [];
    for (const { file, extension } of validation.files) {
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);
      const fileName = randomUploadFileName(extension);
      const filePath = join(uploadDir, fileName);
      await writeFile(filePath, buffer);
      savedPaths.push(`/api/files/products/${auth.merchant.id}/${productId}/${fileName}`);
    }
    return NextResponse.json({ paths: savedPaths });
  } catch (error) {
    const response = merchantUploadStorageErrorResponse(error);
    if (response) return response;
    throw error;
  } finally {
    await reservation?.release();
  }
}
