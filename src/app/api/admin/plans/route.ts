import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { isAdminRequest } from "@server/admin/admin-auth";
import { getDb } from "@backend/db";
import { plans } from "@backend/db/schema";
import { listPlans } from "@server/admin/merchants";

// 套餐列表（商家管理页的下拉选项）
export async function GET(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.json({ plans: await listPlans() });
}

// 新建套餐：body { id, name, monthlyGenerationQuota }。定价/支付未接入前，套餐只描述额度。
export async function POST(req: NextRequest) {
  if (!isAdminRequest(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    const body = await req.json().catch(() => ({}));
    const id = typeof body.id === "string" ? body.id.trim().toLowerCase() : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 40) : "";
    const quota = Number(body.monthlyGenerationQuota);
    if (!/^[a-z0-9-]{2,32}$/.test(id)) {
      return NextResponse.json({ error: "套餐 ID 需为 2-32 位小写字母/数字/连字符" }, { status: 400 });
    }
    if (!name) return NextResponse.json({ error: "请填写套餐名称" }, { status: 400 });
    if (!Number.isInteger(quota) || quota < 0 || quota > 1_000_000_000) {
      return NextResponse.json({ error: "月度额度必须是 0~10 亿之间的整数" }, { status: 400 });
    }
    const db = getDb();
    const existing = await db.select({ id: plans.id }).from(plans).where(eq(plans.id, id));
    if (existing.length > 0) return NextResponse.json({ error: "套餐 ID 已存在" }, { status: 409 });
    await db.insert(plans).values({ id, name, monthlyGenerationQuota: quota });
    return NextResponse.json({ success: true }, { status: 201 });
  } catch (error) {
    console.error("新建套餐失败:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "新建套餐失败" }, { status: 500 });
  }
}
