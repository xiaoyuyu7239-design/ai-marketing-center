import "server-only";

import { eq, isNull } from "drizzle-orm";
import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@backend/db";
import { brandSettings, merchants, products, projects } from "@backend/db/schema";
import { getMerchantFromRequest, type AuthedMerchant } from "./session";
import { singleUserModeEnabled } from "@backend/core/security/runtime-config";

export type MerchantGuardResult = { merchant: AuthedMerchant } | { error: NextResponse };

const SINGLE_USER_EMAIL = "local@single-user";
let orphanDataAdopted = false;

/** 单用户升级路径：把多租户改造前留下的无主数据（merchant_id IS NULL）认领到本机默认商家名下，每进程只跑一次 */
async function adoptOrphanData(merchantId: string) {
  if (orphanDataAdopted) return;
  orphanDataAdopted = true;
  try {
    const db = getDb();
    await db.update(projects).set({ merchantId }).where(isNull(projects.merchantId));
    await db.update(products).set({ merchantId }).where(isNull(products.merchantId));
    await db.update(brandSettings).set({ merchantId }).where(isNull(brandSettings.merchantId));
  } catch (error) {
    console.warn("认领存量本地数据失败（不影响使用，下次启动重试）:", error);
    orphanDataAdopted = false;
  }
}

/**
 * 单用户模式（CLIPFORGE_SINGLE_USER=1）：自动建/取一个本机默认商家，跳过登录，
 * 并认领多租户改造前的存量本地项目（否则升级后老板会"看不到自己以前的项目"）。
 * 供 Electron 桌面版、CLI（bin/clipforge.mjs）、MCP 等无浏览器会话的本地单人场景使用；
 * 多租户 SaaS 部署绝不可开启此环境变量。
 */
async function getOrCreateSingleUserMerchant(): Promise<AuthedMerchant> {
  const db = getDb();
  const rows = await db
    .select({ id: merchants.id, email: merchants.email, shopName: merchants.shopName, planId: merchants.planId })
    .from(merchants)
    .where(eq(merchants.email, SINGLE_USER_EMAIL));
  const merchant =
    rows[0] ??
    (
      await db
        .insert(merchants)
        // 本机单人使用、模型 Key 也是用户自己的，配额不设限（unlimited 套餐在 db 启动时种入）
        .values({ email: SINGLE_USER_EMAIL, passwordHash: "!single-user-no-password", planId: "unlimited" })
        .returning({ id: merchants.id, email: merchants.email, shopName: merchants.shopName, planId: merchants.planId })
    )[0];
  await adoptOrphanData(merchant.id);
  return merchant;
}

/** 路由入口第一行调用：未登录统一返回 401，登录态一律走 session cookie，不信任请求体/查询参数里的任何 merchantId */
export async function requireMerchant(req: NextRequest): Promise<MerchantGuardResult> {
  const merchant = await getMerchantFromRequest(req);
  if (merchant) return { merchant };
  if (singleUserModeEnabled()) {
    return { merchant: await getOrCreateSingleUserMerchant() };
  }
  return { error: NextResponse.json({ error: "请先登录" }, { status: 401 }) };
}

export type ProjectGuardResult = { ok: true } | { error: NextResponse };

/**
 * 校验 projectId 属于当前商家。找不到或不属于该商家统一返回 404（不用 403），
 * 避免向调用方泄露"这个 id 存在，只是不是你的"这类信息。
 */
export async function requireOwnedProject(merchantId: string, projectId: string): Promise<ProjectGuardResult> {
  const db = getDb();
  const rows = await db
    .select({ merchantId: projects.merchantId })
    .from(projects)
    .where(eq(projects.id, projectId));
  const row = rows[0];
  if (!row || row.merchantId !== merchantId) {
    return { error: NextResponse.json({ error: "项目不存在" }, { status: 404 }) };
  }
  return { ok: true };
}
