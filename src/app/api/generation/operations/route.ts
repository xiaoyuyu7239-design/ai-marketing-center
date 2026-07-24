import { NextRequest, NextResponse } from "next/server";
import { requireMerchant, requireOwnedProject } from "@backend/core/auth/require-merchant";
import {
  createGenerationOperation,
  GenerationOperationConflictError,
  hashGenerationRequest,
  InvalidGenerationOperationError,
  QuotaExceededError,
  safeGenerationErrorMessage,
} from "@backend/core/auth/usage";
import { consumeExpensiveRouteRateLimit, EXPENSIVE_RATE_LIMIT_PRESETS, rateLimitResponse } from "@backend/core/security/rate-limit";
import { getDb } from "@backend/db";
import { projects, scripts, settings, type Shot } from "@backend/db/schema";
import { eq } from "drizzle-orm";

const MAX_BATCH_ITEMS = 9;
const SHOT_ITEM_RE = /^shot:(?:0|[1-9]\d{0,8})$/;
const PACK_ITEM_RE = /^pack:[0-8]$/;

function assertBatchItemsBelongToProject(
  projectId: string,
  kind: "image" | "video",
  itemKeys: readonly string[],
): string {
  if (itemKeys.length === 0 || itemKeys.length > MAX_BATCH_ITEMS || new Set(itemKeys).size !== itemKeys.length) {
    throw new InvalidGenerationOperationError("一次批量生成必须包含 1-9 个不重复生成项");
  }
  const db = getDb();
  const project = db.select({ contentType: projects.contentType }).from(projects)
    .where(eq(projects.id, projectId)).limit(1).all()[0];
  if (!project) throw new InvalidGenerationOperationError("项目不存在");

  const packItems = itemKeys.every((key) => PACK_ITEM_RE.test(key));
  const shotItems = itemKeys.every((key) => SHOT_ITEM_RE.test(key));
  if (packItems) {
    if (kind !== "image" || project.contentType !== "image_pack") {
      throw new InvalidGenerationOperationError("图片套装生成项与当前项目类型不一致");
    }
    const spec = db.select({ value: settings.value }).from(settings)
      .where(eq(settings.key, `image_pack:${projectId}`)).limit(1).all()[0]?.value as
      | { images?: unknown[] }
      | null
      | undefined;
    const imageCount = Array.isArray(spec?.images) ? Math.min(spec.images.length, MAX_BATCH_ITEMS) : 0;
    const allowed = new Set(Array.from({ length: imageCount }, (_, index) => `pack:${index}`));
    if (!itemKeys.every((key) => allowed.has(key))) {
      throw new InvalidGenerationOperationError("图片套装生成项不在服务端当前规格内");
    }
    return hashGenerationRequest({ type: "image-pack", projectId, spec: spec ?? null });
  }

  if (!shotItems) throw new InvalidGenerationOperationError("分镜 itemKey 不合法");
  const rows = db.select().from(scripts).where(eq(scripts.projectId, projectId)).all();
  const selected = [...rows].sort((left, right) =>
    Number(Boolean(right.selected)) - Number(Boolean(left.selected)) || (right.version ?? 0) - (left.version ?? 0)
  )[0];
  const shots = Array.isArray(selected?.shots) ? selected.shots as Shot[] : [];
  const allowed = new Set(shots
    .filter((shot) => Number.isSafeInteger(shot.shotId) && shot.shotId >= 0)
    .map((shot) => `shot:${shot.shotId}`));
  if (!selected || !itemKeys.every((key) => allowed.has(key))) {
    throw new InvalidGenerationOperationError("批量生成项不属于服务端当前选中脚本");
  }
  return hashGenerationRequest({
    type: "selected-script",
    projectId,
    scriptId: selected.id,
    shots: shots.map((shot) => ({ shotId: shot.shotId, type: shot.type, duration: shot.duration })),
  });
}

/**
 * 批量生成前先创建完整 manifest；父流水在这里原子预占 1 次额度，后续 N 个 item
 * 只更新子项状态。同 operationId 重放返回原状态，不会重复扣额度。
 */
export async function POST(req: NextRequest) {
  const auth = await requireMerchant(req);
  if ("error" in auth) return auth.error;
  const limit = consumeExpensiveRouteRateLimit(
    req,
    auth.merchant.id,
    "generation:manifest",
    EXPENSIVE_RATE_LIMIT_PRESETS.auxiliaryModel,
  );
  if (!limit.allowed) return rateLimitResponse(limit, "创建生成任务过于频繁，请稍后再试");

  const body = await req.json().catch(() => ({}));
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const operationId = typeof body.operationId === "string" ? body.operationId.trim() : "";
  const kind = body.kind === "video" ? "video" : body.kind === "image" ? "image" : "";
  const itemKeys: string[] = Array.isArray(body.itemKeys)
    ? body.itemKeys.filter((item: unknown): item is string => typeof item === "string")
    : [];
  if (!projectId || !operationId || !kind || itemKeys.length !== body.itemKeys?.length) {
    return NextResponse.json({ error: "缺少有效的 projectId、operationId、kind 或 itemKeys" }, { status: 400 });
  }
  const owned = await requireOwnedProject(auth.merchant.id, projectId);
  if ("error" in owned) return owned.error;

  try {
    const agentId = kind === "video" ? "videoAgent" as const : "imageAgent" as const;
    const operationType = `${kind}-batch`;
    const projectConstraintHash = assertBatchItemsBelongToProject(projectId, kind, itemKeys);
    const result = createGenerationOperation({
      merchantId: auth.merchant.id,
      projectId,
      operationKey: operationId,
      operationType,
      agentId,
      requestHash: hashGenerationRequest({
        projectId,
        operationType,
        itemKeys: [...itemKeys].sort(),
        projectConstraintHash,
      }),
      items: itemKeys.map((itemKey) => ({ itemKey, agentId })),
    });
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 });
  } catch (error) {
    if (error instanceof QuotaExceededError) {
      return NextResponse.json({ error: error.message }, { status: 402 });
    }
    if (error instanceof InvalidGenerationOperationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof GenerationOperationConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("创建批量生成 manifest 失败:", safeGenerationErrorMessage(error));
    return NextResponse.json({ error: "创建生成任务失败，请稍后重试" }, { status: 500 });
  }
}
