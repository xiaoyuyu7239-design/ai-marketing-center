import "server-only";

import { createHash, randomBytes } from "crypto";
import { eq } from "drizzle-orm";
import type { NextRequest, NextResponse } from "next/server";
import { getDb } from "@backend/db";
import { merchants, merchantSessions } from "@backend/db/schema";

export const SESSION_COOKIE = "cf_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

export interface AuthedMerchant {
  id: string;
  email: string;
  shopName: string | null;
  planId: string;
}

function sessionTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 商家建档画像（可空字段；用于脚本生成默认值与个性化推荐） */
export interface MerchantProfile extends AuthedMerchant {
  category: string | null;
  region: string | null;
  targetAudience: string | null;
  priceRange: string | null;
  platforms: string | null;
  /** 经营形态：ecommerce=纯电商（默认）/ local=实体门店 / both=两者都有 */
  storeType: string | null;
  /** 商圈/地标/地铁站（同城内容的位置钩子） */
  landmark: string | null;
  /** 门店地址/位置指引（POI 提醒与到店指引用） */
  storeAddress: string | null;
  /** 商家绑定的常用话题标签，逗号分隔（发布文案每次自动带上） */
  customTags: string | null;
}

export async function createSession(merchantId: string) {
  const db = getDb();
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  // 浏览器只持有原始随机 token；数据库仅保存摘要，备份泄露时不能直接复用会话。
  await db.insert(merchantSessions).values({ id: sessionTokenHash(token), merchantId, expiresAt });
  return { token, expiresAt };
}

export async function destroySession(token: string) {
  const db = getDb();
  await db.delete(merchantSessions).where(eq(merchantSessions.id, sessionTokenHash(token)));
}

/** 按 token 查会话并换取商家信息；不存在或已过期返回 null（过期的会话顺手清掉，不阻塞调用方） */
export async function getMerchantByToken(token: string | undefined): Promise<AuthedMerchant | null> {
  if (!token) return null;
  const db = getDb();
  const rows = await db
    .select({
      id: merchants.id,
      email: merchants.email,
      shopName: merchants.shopName,
      planId: merchants.planId,
      expiresAt: merchantSessions.expiresAt,
    })
    .from(merchantSessions)
    .innerJoin(merchants, eq(merchantSessions.merchantId, merchants.id))
    .where(eq(merchantSessions.id, sessionTokenHash(token)));

  const row = rows[0];
  if (!row) return null;
  if (!row.expiresAt || row.expiresAt.getTime() < Date.now()) {
    await destroySession(token);
    return null;
  }
  return { id: row.id, email: row.email, shopName: row.shopName, planId: row.planId };
}

export function getMerchantFromRequest(req: NextRequest): Promise<AuthedMerchant | null> {
  return getMerchantByToken(req.cookies.get(SESSION_COOKIE)?.value);
}

export function setSessionCookie(res: NextResponse, token: string, expiresAt: Date) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.delete(SESSION_COOKIE);
}
