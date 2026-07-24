import "server-only";

import { randomBytes } from "crypto";

export type UploadTypeMap = Readonly<Record<string, readonly string[]>>;

export const IMAGE_UPLOAD_TYPES: UploadTypeMap = {
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  webp: ["image/webp"],
  gif: ["image/gif"],
  bmp: ["image/bmp"],
};

export const MATERIAL_UPLOAD_TYPES: UploadTypeMap = {
  mp4: ["video/mp4"],
  webm: ["video/webm"],
  mov: ["video/quicktime"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  webp: ["image/webp"],
};

export const AUDIO_UPLOAD_TYPES: UploadTypeMap = {
  mp3: ["audio/mpeg", "audio/mp3"],
  wav: ["audio/wav", "audio/x-wav"],
  aac: ["audio/aac"],
  m4a: ["audio/mp4", "audio/x-m4a"],
};

export interface UploadPolicy {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  allowedTypes: UploadTypeMap;
}

export type UploadPolicyErrorCode =
  | "invalid_content_length"
  | "content_length_exceeded"
  | "no_files"
  | "too_many_files"
  | "invalid_file_entry"
  | "empty_file"
  | "file_too_large"
  | "total_too_large"
  | "unsupported_extension"
  | "mime_extension_mismatch";

export interface UploadPolicyError {
  code: UploadPolicyErrorCode;
  status: 400 | 413;
  fileName?: string;
}

export interface ValidatedUploadFile {
  file: File;
  extension: string;
  mimeType: string;
}

export type UploadValidationResult =
  | { ok: true; files: ValidatedUploadFile[]; totalBytes: number }
  | { ok: false; error: UploadPolicyError };

/**
 * 在 multipart 解析前用声明的请求体长度挡住明显超限的请求。
 * Content-Length 包含 multipart 边界，因此这里把 maxTotalBytes 视为整个请求体硬上限。
 */
export function validateUploadContentLength(
  headers: Pick<Headers, "get">,
  maxTotalBytes: number,
): UploadPolicyError | null {
  const raw = headers.get("content-length");
  if (raw === null) return null;

  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    return { code: "invalid_content_length", status: 400 };
  }
  const declaredBytes = Number(normalized);
  if (!Number.isSafeInteger(declaredBytes)) {
    return { code: "invalid_content_length", status: 400 };
  }
  if (declaredBytes > maxTotalBytes) {
    return { code: "content_length_exceeded", status: 413 };
  }
  return null;
}

function fileExtension(fileName: string): string | null {
  const baseName = fileName.split(/[\\/]/).pop()?.trim() ?? "";
  const dot = baseName.lastIndexOf(".");
  if (dot <= 0 || dot === baseName.length - 1) return null;
  const extension = baseName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]+$/.test(extension) ? extension : null;
}

/** 完整验证一批 multipart 文件；调用方只能在 ok=true 后开始写盘。 */
export function validateUploadFiles(
  entries: readonly FormDataEntryValue[],
  policy: UploadPolicy,
): UploadValidationResult {
  if (entries.length === 0) {
    return { ok: false, error: { code: "no_files", status: 400 } };
  }
  if (entries.length > policy.maxFiles) {
    return { ok: false, error: { code: "too_many_files", status: 400 } };
  }

  const files: ValidatedUploadFile[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (typeof entry === "string") {
      return { ok: false, error: { code: "invalid_file_entry", status: 400 } };
    }

    const fileName = entry.name || "未命名文件";
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
      return { ok: false, error: { code: "empty_file", status: 400, fileName } };
    }
    if (entry.size > policy.maxFileBytes) {
      return { ok: false, error: { code: "file_too_large", status: 400, fileName } };
    }

    const extension = fileExtension(entry.name);
    const allowedMimeTypes =
      extension && Object.prototype.hasOwnProperty.call(policy.allowedTypes, extension)
        ? policy.allowedTypes[extension]
        : undefined;
    if (!extension || !allowedMimeTypes) {
      return { ok: false, error: { code: "unsupported_extension", status: 400, fileName } };
    }

    const mimeType = entry.type.trim().toLowerCase();
    if (!mimeType || !allowedMimeTypes.includes(mimeType)) {
      return { ok: false, error: { code: "mime_extension_mismatch", status: 400, fileName } };
    }

    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > policy.maxTotalBytes) {
      return { ok: false, error: { code: "total_too_large", status: 400 } };
    }
    files.push({ file: entry, extension, mimeType });
  }

  return { ok: true, files, totalBytes };
}

/** 144 bit 随机令牌，避免时间戳/短 Math.random 文件名被枚举。 */
export function randomUploadFileName(extension: string, prefix?: string): string {
  const normalizedExtension = extension.trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(normalizedExtension)) {
    throw new Error("无效的上传文件扩展名");
  }
  const normalizedPrefix = prefix?.trim().replace(/[^a-zA-Z0-9_-]/g, "") || "";
  const token = randomBytes(18).toString("hex");
  return `${normalizedPrefix ? `${normalizedPrefix}-` : ""}${token}.${normalizedExtension}`;
}
