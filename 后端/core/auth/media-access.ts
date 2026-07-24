import "server-only";

import { join, normalize, posix, relative, sep } from "path";
import { NextResponse, type NextRequest } from "next/server";
import { isAdminRequest } from "@server/admin/admin-auth";
import { getDataDir } from "@backend/shared/paths";
import { singleUserModeEnabled } from "@backend/core/security/runtime-config";
import { requireMerchant, requireOwnedProject } from "./require-merchant";

/**
 * 取 `/api/files|output/<...>` 路径归一化后的真实首段目录（通常是 projectId 或 "products"）。
 * `..` / `%2e%2e` 穿越会在此坍缩暴露真身；无法解析或穿出根返回 null。
 * 用于路由入口对 body 里的媒体路径做归属围栏（配合调用方校验 === 本项目 id 或 "products"）。
 */
export interface ParsedMediaRef {
  kind: "files" | "output";
  segments: string[];
}

/** 解析并归一化本地媒体 URL。拒绝反斜线、绝对路径、空段和任何归一化后仍越界的 `..`。 */
export function parseMediaRef(ref: string): ParsedMediaRef | null {
  const m = ref.match(/^\/api\/(files|output)\/([^?#]+)(?:[?#].*)?$/);
  if (!m) return null;
  let decoded = m[2];
  try {
    decoded = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  if (!decoded || decoded.includes("\\") || decoded.includes("\0") || decoded.startsWith("/")) return null;
  const normalized = posix.normalize(decoded);
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) return null;
  return { kind: m[1] as ParsedMediaRef["kind"], segments };
}

export function mediaFirstSegment(ref: string): string | null {
  return parseMediaRef(ref)?.segments[0] ?? null;
}

/**
 * 请求体中的媒体引用是否属于当前商家/项目。商品库从邀请内测起使用
 * `/api/files/products/<merchantId>/<productId>/<file>`，不再把整个 products 目录视作共享区。
 */
export function mediaRefBelongsToMerchant(
  ref: string,
  merchantId: string,
  projectId?: string,
  options: { allowOutput?: boolean; allowProducts?: boolean } = {}
): boolean {
  const parsed = parseMediaRef(ref);
  if (!parsed) return false;
  if (parsed.kind === "output" && options.allowOutput !== true) return false;
  if (projectId && parsed.segments[0] === projectId) return true;
  if (options.allowProducts !== false && parsed.kind === "files" && parsed.segments[0] === "products") {
    if (parsed.segments[1] === merchantId && parsed.segments.length >= 4) return true;
    return singleUserModeEnabled() && parsed.segments.length >= 3;
  }
  return false;
}

/**
 * 将已通过商家/项目归属校验的 `/api/files/...` 引用解析为 uploads 下的绝对路径。
 * 所有需要直接读盘的业务路由都应复用它，避免“归属解析”和“读盘解析”口径不一致。
 */
export function resolveOwnedUploadRef(
  ref: string,
  merchantId: string,
  projectId?: string
): string | null {
  const parsed = parseMediaRef(ref);
  if (!parsed || parsed.kind !== "files") return null;
  if (!mediaRefBelongsToMerchant(ref, merchantId, projectId)) return null;
  const root = normalize(join(getDataDir(), "uploads"));
  const filePath = normalize(join(root, ...parsed.segments));
  if (filePath !== root && !filePath.startsWith(root + sep)) return null;
  return filePath;
}

/**
 * 媒体文件访问守卫（/api/files、/api/output 共用）：
 * 这两个路由服务的都是商家私有内容（上传的商品图/成片视频），多租户下不能"知道 URL 就能看"。
 *
 * 关键：归属校验必须基于「归一化后的真实首段目录」，而不是原始 URL 首段——否则用自己的 projectId
 * 作首段过校验、再用 %2e%2e（编码的 ..）穿越到兄弟项目目录，就能读到别的商家的文件。
 * 这里把 decodedSegments 拼进 root 后 normalize，先做 root 围栏，再取 relative(root, 真实路径) 的首段判归属。
 *
 * 规则：运营后台会话放行全部；商家会话只放行自己项目目录（首段=自己的 projectId）与商品库目录（products/）；
 * 单用户模式由 requireMerchant 内部兜底，桌面版/CLI 无 cookie 也照常可读。
 * 返回 null 表示放行，否则返回应直接回给客户端的错误响应。
 */
export async function guardMediaAccess(
  req: NextRequest,
  root: string,
  decodedSegments: string[]
): Promise<NextResponse | null> {
  // 先算真实路径并做 root 围栏（与路由内的校验同口径，防 ..%2f 穿出 root）
  const filePath = normalize(join(root, ...decodedSegments));
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    return NextResponse.json({ error: "非法路径" }, { status: 403 });
  }

  if (isAdminRequest(req)) return null;

  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error; // 401

  // 归一化后相对 root 的首段目录，才是文件真正归属的目录（穿越后的兄弟目录会在这里暴露真身）
  const realSegments = relative(root, filePath).split(sep).filter(Boolean);
  const realFirst = realSegments[0];
  if (!realFirst || realFirst === "..") {
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }
  // 商品库图片必须位于 uploads/products/<merchantId>/<productId>/...；旧共享目录只兼容本地单用户模式。
  if (realFirst === "products") {
    if (req.nextUrl.pathname.startsWith("/api/output/")) {
      return NextResponse.json({ error: "文件不存在" }, { status: 404 });
    }
    if (realSegments[1] === auth.merchant.id && realSegments.length >= 4) return null;
    if (singleUserModeEnabled() && realSegments.length >= 3) return null;
    return NextResponse.json({ error: "文件不存在" }, { status: 404 });
  }

  const owned = await requireOwnedProject(auth.merchant.id, realFirst);
  if ("error" in owned) return owned.error; // 404（不区分"不存在"与"不是你的"）
  return null;
}
