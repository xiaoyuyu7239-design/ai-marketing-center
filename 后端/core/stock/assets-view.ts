import type { Shot } from "@backend/db/schema";

/**
 * 素材页视图行：由「选中脚本的分镜」+「已落库素材」派生。
 * 纯数据，无 React 依赖，供素材页初次加载与配画面后刷新复用（可单测）。
 */
export interface AssetItem {
  shotId: number;
  type: Shot["type"];
  duration: number;
  description: string;
  prompt: string;
  /** 脚本里的运镜描述（中文）；图生视频时与 description 拼成运动指令 */
  camera?: string;
  visualSource: Shot["visualSource"];
  status: "pending" | "generating" | "done" | "failed";
  thumbnailUrl?: string;
  error?: string;
  /** 转动态被平台人脸风控拦截：不再计入可转动态、不再重试，卡片上明确标注（仅前端状态，不落库） */
  motionBlocked?: boolean;
  /** 素材是否为视频（已转动态镜头/图生视频） */
  isVideo?: boolean;
  /** 已落库素材的真实类型（如 stock_footage 表示免费素材库自动配的画面） */
  assetType?: string;
  /** 已落库素材的唯一 ID；动态资格会将它与文件 hash 一起绑定。 */
  assetId?: string;
  /** 真实素材文件，与可能只是预览图的 thumbnailUrl 分开。 */
  assetFileUrl?: string;
  assetProvider?: string;
  assetModel?: string;
  /** 当前落库素材的生成 prompt，与脚本分镜 prompt 分开，用于识别已执行的安全重生标记。 */
  assetPrompt?: string;
}

/** 视频素材文件后缀（用于区分视频 vs 静态图，决定缩略图与「转动态」入口） */
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

/** GET /api/project/[id]/assets 返回行里本函数关心的子集 */
export interface SavedAssetRow {
  id?: string | null;
  shotId: number;
  filePath?: string | null;
  status?: string | null;
  type?: string | null;
  /** 视频素材的静态预览图（免费素材视频会落此列）；用作 <img> 缩略图，避免拿 mp4 当图渲染 */
  thumbnailPath?: string | null;
  provider?: string | null;
  model?: string | null;
  prompt?: string | null;
  /** API 会返回 ISO 时间字符串；纯函数也接受 DB Date/数字便于复用与测试。 */
  createdAt?: Date | string | number | null;
  /** SQLite 插入顺序；解决 timestamp 只到秒时 UUID 无法表示新旧的问题。 */
  revisionOrder?: number | null;
}

function createdAtMillis(value: SavedAssetRow["createdAt"]): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
  }
  return Number.NEGATIVE_INFINITY;
}

/**
 * 历史素材中每个分镜只选最新的已完成版本。
 * 有 revisionOrder 时以真实插入顺序定新旧；旧 API 数据才回退 createdAt/id。
 */
export function newestDoneAssetsByShot(
  savedAssets: SavedAssetRow[],
): Map<number, SavedAssetRow> {
  const ordered = [...savedAssets].sort((left, right) => {
    const leftRevision = typeof left.revisionOrder === "number" ? left.revisionOrder : null;
    const rightRevision = typeof right.revisionOrder === "number" ? right.revisionOrder : null;
    if (leftRevision != null && rightRevision != null && leftRevision !== rightRevision) {
      return rightRevision - leftRevision;
    }
    const leftCreatedAt = createdAtMillis(left.createdAt);
    const rightCreatedAt = createdAtMillis(right.createdAt);
    if (leftCreatedAt !== rightCreatedAt) return rightCreatedAt > leftCreatedAt ? 1 : -1;
    const leftId = left.id ?? "";
    const rightId = right.id ?? "";
    return rightId === leftId ? 0 : rightId > leftId ? 1 : -1;
  });
  const result = new Map<number, SavedAssetRow>();
  for (const asset of ordered) {
    if (
      asset &&
      asset.filePath &&
      asset.status === "done" &&
      !result.has(asset.shotId)
    ) {
      result.set(asset.shotId, asset);
    }
  }
  return result;
}

/**
 * 把「选中脚本分镜 + 已落库素材」合成素材页视图行。
 * - 已落库且就绪的素材（filePath 为 /api/files 可访问路径）→ 直接就绪并带缩略图；
 * - 商品原图分镜（product_image）→ 用首张商品图就绪；
 * - 其余分镜 → 待生成（pending）。
 * 纯函数，初次加载与「自动配画面」后刷新共用，保证两条路径行为一致。
 */
export function buildAssetRows(
  shots: Shot[],
  savedAssets: SavedAssetRow[],
  productImages: string[],
): AssetItem[] {
  // API 保留历史版本；视图对每个分镜只展示最新的已完成素材。
  const savedByShot = newestDoneAssetsByShot(savedAssets);
  const firstProduct = productImages[0];

  return shots.map((s) => {
    const saved = savedByShot.get(s.shotId);
    if (saved && saved.filePath) {
      // 视频素材：用静态预览图当缩略图（拿 mp4 当 <img> 会裂图），并标记 isVideo 以正确收起「转动态」入口
      const isVideo = VIDEO_EXT.test(saved.filePath);
      return {
        shotId: s.shotId,
        type: s.type,
        duration: s.duration,
        description: s.description,
        prompt: s.prompt ?? "",
        camera: s.camera,
        visualSource: s.visualSource,
        status: "done" as const,
        thumbnailUrl: isVideo && saved.thumbnailPath ? saved.thumbnailPath : saved.filePath,
        isVideo: isVideo || undefined,
        assetType: saved.type ?? undefined,
        assetId: saved.id ?? undefined,
        assetFileUrl: saved.filePath,
        assetProvider: saved.provider ?? undefined,
        assetModel: saved.model ?? undefined,
        assetPrompt: saved.prompt ?? undefined,
      };
    }
    return {
      shotId: s.shotId,
      type: s.type,
      duration: s.duration,
      description: s.description,
      prompt: s.prompt ?? "",
      camera: s.camera,
      visualSource: s.visualSource,
      status: s.visualSource === "product_image" ? ("done" as const) : ("pending" as const),
      thumbnailUrl: s.visualSource === "product_image" ? firstProduct : undefined,
      assetFileUrl: s.visualSource === "product_image" ? firstProduct : undefined,
    };
  });
}

/** 仍待配画面（pending）的分镜数 */
export function pendingShotCount(rows: AssetItem[]): number {
  return rows.filter((r) => r.status === "pending").length;
}

/** 仍待配画面、且不是商品原图（商品原图分镜不该用免费素材覆盖）的分镜数 */
export function pendingNonProductShotCount(rows: AssetItem[]): number {
  return rows.filter((r) => r.status === "pending" && r.visualSource !== "product_image").length;
}

/**
 * 是否应展示「自动配画面（免费素材）」入口（免费素材库 = keyless Openverse 图片，零生图 Key）：
 * - topic（无商品一句话成片）项目：始终提供，这是其首选出片路径；
 * - 其它项目（含带货）：当**未配置生图模型**、却仍有待配画面的非商品分镜时提供——
 *   让没有 AI Key 的用户也能给钩子/背书等 B-roll 分镜配好画面（商品原图分镜不受影响）。
 */
export function shouldOfferStockFill(
  rows: AssetItem[],
  contentType: string | undefined,
  hasImageModel: boolean,
): boolean {
  if (rows.length === 0) return false;
  if (contentType === "topic") return true;
  return !hasImageModel && pendingNonProductShotCount(rows) > 0;
}

/**
 * 是否需要提示「未配置默认生图模型」：
 * 未配模型、且仍有 AI 生成分镜尚未出图时才提示；若 AI 分镜都已生成（done），
 * 则不提示——避免与「N/N 个素材已就绪」自相矛盾，给小白造成"出错了"的错觉。
 */
export function needsImageModelWarning(rows: AssetItem[], hasImageModel: boolean): boolean {
  if (hasImageModel) return false;
  return rows.some((r) => r.visualSource === "ai_generate" && r.status !== "done");
}
