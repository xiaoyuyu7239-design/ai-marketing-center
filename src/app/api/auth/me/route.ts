import { NextRequest, NextResponse } from "next/server";
import { requireMerchant } from "@backend/core/auth/require-merchant";
import { getMerchantProfile, updateMerchantProfile } from "@backend/core/auth/merchant-profile";

// 当前登录商家信息 + 建档画像（用于前端判断登录态/水合会话/回填建档表单）
export async function GET(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const merchant = await getMerchantProfile(auth.merchant.id);
  return NextResponse.json({ merchant: merchant ?? auth.merchant });
}

// 更新商家建档画像（店铺名/品类/地区/目标客户/价格带/主投平台/门店类型/商圈/地址/绑定标签）
export async function PATCH(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  try {
    const body = await req.json().catch(() => ({}));
    const merchant = await updateMerchantProfile(auth.merchant.id, body);
    return NextResponse.json({ merchant });
  } catch (error) {
    console.error("更新商家信息失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "更新商家信息失败" },
      { status: 500 }
    );
  }
}
