import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@server/admin/admin-auth";
import { listMerchants, updateMerchantPlan } from "@server/admin/merchants";

// 商家列表（含套餐/本月用量/内容规模），内部运营后台用
export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ merchants: await listMerchants() });
  } catch (error) {
    console.error("读取商家列表失败:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "读取商家列表失败" }, { status: 500 });
  }
}

// 调整商家套餐/赠送额度：body { merchantId, planId?, quotaBonus? }
export async function PATCH(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const merchantId = typeof body.merchantId === "string" ? body.merchantId : "";
    if (!merchantId) return NextResponse.json({ error: "缺少 merchantId" }, { status: 400 });
    const result = await updateMerchantPlan(merchantId, { planId: body.planId, quotaBonus: body.quotaBonus });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("更新商家套餐失败:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "更新商家套餐失败" }, { status: 500 });
  }
}
