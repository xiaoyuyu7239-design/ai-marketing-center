import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { merchants } from "@backend/db/schema";
import type { MerchantProfile } from "./session";

/** 建档画像允许更新的字段白名单（禁止透传 email/passwordHash/planId 等敏感字段） */
export const PROFILE_FIELDS = [
  "shopName",
  "category",
  "region",
  "targetAudience",
  "priceRange",
  "platforms",
  "storeType",
  "landmark",
  "storeAddress",
  "customTags",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

const VALID_CATEGORIES = new Set(["beauty", "food", "home", "fashion", "tech", "other"]);
/** 经营形态：ecommerce=纯电商（默认）/ local=实体门店 / both=线上线下都有 */
const VALID_STORE_TYPES = new Set(["ecommerce", "local", "both"]);
const VALID_PLATFORMS = new Set(["douyin", "xiaohongshu", "kuaishou", "tiktok", "wechat_channels"]);
const MAX_TEXT = 120;

/**
 * 归一化商家绑定的常用标签：接受用户随手输入的 #、顿号、空格、中英文逗号混排，
 * 统一存成"去 # 前缀、逗号分隔、去重"的形式（发布文案包按此格式消费）。
 */
export function normalizeCustomTags(raw: string): string | null {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const piece of raw.split(/[,，、#\s]+/)) {
    const tag = piece.trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 10) break;
  }
  return tags.length ? tags.join(",").slice(0, MAX_TEXT) : null;
}

/** 清洗一条画像字段：裁长度、空串归 null；category/storeType 校验枚举；customTags 归一化 */
export function sanitizeProfileValue(field: ProfileField, raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim().slice(0, MAX_TEXT) : "";
  if (!text) return null;
  if (field === "category") return VALID_CATEGORIES.has(text.toLowerCase()) ? text.toLowerCase() : null;
  if (field === "storeType") return VALID_STORE_TYPES.has(text.toLowerCase()) ? text.toLowerCase() : null;
  if (field === "platforms") {
    const platforms = [...new Set(text.toLowerCase().split(/[,，;；\s]+/).filter((item) => VALID_PLATFORMS.has(item)))];
    return platforms.length ? platforms.join(",") : null;
  }
  if (field === "customTags") return normalizeCustomTags(text);
  return text;
}

export async function getMerchantProfile(merchantId: string): Promise<MerchantProfile | null> {
  const db = getDb();
  const rows = await db
    .select({
      id: merchants.id,
      email: merchants.email,
      shopName: merchants.shopName,
      planId: merchants.planId,
      category: merchants.category,
      region: merchants.region,
      targetAudience: merchants.targetAudience,
      priceRange: merchants.priceRange,
      platforms: merchants.platforms,
      storeType: merchants.storeType,
      landmark: merchants.landmark,
      storeAddress: merchants.storeAddress,
      customTags: merchants.customTags,
    })
    .from(merchants)
    .where(eq(merchants.id, merchantId));
  return rows[0] ?? null;
}

export async function updateMerchantProfile(
  merchantId: string,
  patch: Partial<Record<ProfileField, unknown>>
): Promise<MerchantProfile | null> {
  const updates: Record<string, string | null> = {};
  for (const field of PROFILE_FIELDS) {
    if (field in patch) updates[field] = sanitizeProfileValue(field, patch[field]);
  }
  if (Object.keys(updates).length > 0) {
    const db = getDb();
    await db.update(merchants).set({ ...updates, updatedAt: new Date() }).where(eq(merchants.id, merchantId));
  }
  return getMerchantProfile(merchantId);
}
