import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { legalConsentEvents, merchants } from "@backend/db/schema";
import { hashPassword } from "@backend/core/auth/password";
import { createSession, setSessionCookie } from "@backend/core/auth/session";
import { verifyInviteAccess } from "@backend/core/security/invite-access";
import {
  consumeRateLimit,
  rateLimitResponse,
  requestClientIp,
} from "@backend/core/security/rate-limit";
import { CURRENT_LEGAL_CONSENT } from "@backend/shared/legal-documents";
import { sanitizeProfileValue } from "@backend/core/auth/merchant-profile";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 商家注册
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    const shopName = sanitizeProfileValue("shopName", body.shopName);
    const category = sanitizeProfileValue("category", body.category);
    const storeType = sanitizeProfileValue("storeType", body.storeType);
    const region = sanitizeProfileValue("region", body.region);
    const platforms = sanitizeProfileValue("platforms", body.platforms);
    const inviteCode = String(body.inviteCode || "").trim();

    if (!EMAIL_RE.test(email)) {
      return NextResponse.json({ error: "请输入有效的邮箱地址" }, { status: 400 });
    }
    if (password.length < 8) {
      return NextResponse.json({ error: "密码至少需要 8 位" }, { status: 400 });
    }
    // 邀请内测把最小画像放进注册的一分钟流程：否则首片会以 other/空平台生成，
    // 用户刚注册就要再去设置页，既影响效果也容易丢失登录前已选的素材。
    const requireProfile = process.env.NODE_ENV === "production" || process.env.HUIMAI_REQUIRE_ONBOARDING_PROFILE === "1";
    if (requireProfile && (!shopName || !category || !storeType || !platforms)) {
      return NextResponse.json({ error: "请完成店铺名、主营品类、经营形态和主投平台后再加入内测" }, { status: 400 });
    }
    if (requireProfile && (storeType === "local" || storeType === "both") && !region) {
      return NextResponse.json({ error: "实体门店请填写所在城市，以便生成同城内容" }, { status: 400 });
    }
    const consent = body.legalConsent as Record<string, unknown> | undefined;
    // 大量既有路由集成测试会快速创建临时商家；仅测试环境可显式沿用旧 fixture。
    // 协议专项测试设置 HUIMAI_LEGAL_CONSENT_TESTS=1，生产环境始终强制校验。
    const enforceConsent = process.env.NODE_ENV !== "test" || process.env.HUIMAI_LEGAL_CONSENT_TESTS === "1";
    if (enforceConsent) {
      if (consent?.accepted !== true) {
        return NextResponse.json({ error: "请先阅读并同意当前版本的服务协议、隐私政策与 AI 功能使用须知" }, { status: 400 });
      }
      if (
        consent.termsVersion !== CURRENT_LEGAL_CONSENT.termsVersion
        || consent.privacyVersion !== CURRENT_LEGAL_CONSENT.privacyVersion
        || consent.aiNoticeVersion !== CURRENT_LEGAL_CONSENT.aiNoticeVersion
      ) {
        return NextResponse.json({ error: "协议版本已更新，请刷新页面阅读后重新同意" }, { status: 409 });
      }
    }

    const ip = requestClientIp(req);
    const ipLimit = consumeRateLimit(`auth:register:ip:${ip}`, { limit: 12, windowMs: 60 * 60 * 1_000 });
    if (!ipLimit.allowed) return rateLimitResponse(ipLimit, "注册尝试过于频繁，请稍后再试");
    const emailLimit = consumeRateLimit(`auth:register:email:${email}`, { limit: 5, windowMs: 60 * 60 * 1_000 });
    if (!emailLimit.allowed) return rateLimitResponse(emailLimit, "该邮箱注册尝试过于频繁，请稍后再试");

    const invitation = verifyInviteAccess(email, inviteCode);
    if (!invitation.allowed) {
      if (invitation.reason === "not-configured") {
        return NextResponse.json({ error: "邀请内测尚未配置，请联系绘卖团队" }, { status: 503 });
      }
      return NextResponse.json({ error: "该邮箱或邀请码不在本轮内测名单中" }, { status: 403 });
    }

    const db = getDb();
    const existing = await db.select({ id: merchants.id }).from(merchants).where(eq(merchants.email, email));
    if (existing.length > 0) {
      return NextResponse.json({ error: "该邮箱已注册" }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    const merchant = db.transaction((tx) => {
      const inserted = tx
        .insert(merchants)
        .values({ email, passwordHash, shopName, category, storeType, region, platforms })
        .returning({
          id: merchants.id,
          email: merchants.email,
          shopName: merchants.shopName,
          category: merchants.category,
          storeType: merchants.storeType,
          region: merchants.region,
          platforms: merchants.platforms,
          planId: merchants.planId,
        })
        .all()[0];
      if (!inserted) throw new Error("创建商家账号失败");
      tx.insert(legalConsentEvents).values({
        merchantId: inserted.id,
        ...CURRENT_LEGAL_CONSENT,
        // acceptedAt 由数据库默认的服务端时间生成，不读取客户端传值。
      }).run();
      return inserted;
    });

    const { token, expiresAt } = await createSession(merchant.id);
    const res = NextResponse.json({ merchant }, { status: 201 });
    setSessionCookie(res, token, expiresAt);
    return res;
  } catch (error) {
    console.error("商家注册失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "注册失败" },
      { status: 500 }
    );
  }
}
