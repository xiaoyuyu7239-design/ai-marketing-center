import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getDb } from "@backend/db";
import { projects, scripts } from "@backend/db/schema";
import {
  applyStoreMemoryPatch,
  getStoreMemory,
  learnFromScript,
  saveStoreMemory,
  type StoreMemoryPatch,
} from "@backend/core/memory/store-memory";

export async function GET() {
  try {
    return NextResponse.json({ memory: await getStoreMemory() });
  } catch (error) {
    console.error("读取店铺习惯失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取店铺习惯失败" },
      { status: 500 }
    );
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const current = await getStoreMemory();
    const memory = await saveStoreMemory(applyStoreMemoryPatch(current, body as StoreMemoryPatch));
    return NextResponse.json({ memory });
  } catch (error) {
    console.error("保存店铺习惯失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存店铺习惯失败" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    if (body.action !== "learn-script") {
      return NextResponse.json({ error: "未知的记忆操作" }, { status: 400 });
    }

    const projectId = typeof body.projectId === "string" ? body.projectId : "";
    const scriptId = typeof body.scriptId === "string" ? body.scriptId : "";
    if (!projectId || !scriptId) {
      return NextResponse.json({ error: "缺少项目或脚本" }, { status: 400 });
    }

    const db = getDb();
    const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
    if (!project) {
      return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    }
    const [script] = await db.select().from(scripts).where(eq(scripts.id, scriptId));
    if (!script || script.projectId !== projectId) {
      return NextResponse.json({ error: "脚本不存在" }, { status: 404 });
    }

    const current = await getStoreMemory();
    const memory = await saveStoreMemory(
      learnFromScript(current, {
        productName: project.productName ?? project.name,
        category: project.productCategory ?? "",
        styleType: script.styleType,
        title: script.title ?? "",
        shots: script.shots ?? [],
      })
    );
    return NextResponse.json({ memory });
  } catch (error) {
    console.error("学习店铺习惯失败:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "学习店铺习惯失败" },
      { status: 500 }
    );
  }
}
