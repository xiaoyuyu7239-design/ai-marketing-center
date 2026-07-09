/**
 * 素材匹配辅助 —— 服务"无商品也能成片，且永远有画面"的目标
 *
 * broadenQuery：当某个英文检索词在素材库一无所获时，产出由具体到宽泛的回退检索词，
 * 直到能命中素材（避免新手输入的生僻主题导致某个分镜没有任何画面可用）。
 */

/** 万能兜底检索词：任何免费素材库都有大量结果 */
const UNIVERSAL_FALLBACKS = ["abstract background", "lifestyle", "nature", "light"];

/**
 * 给一个英文检索词，产出由具体到宽泛的回退检索词序列（不含原词、已去重）。
 * 例：broadenQuery("quantum entanglement physics")
 *   → ["entanglement physics", "physics", "abstract background", "lifestyle", "nature", "light"]
 * 纯函数，便于单测。
 */
export function broadenQuery(query: string): string[] {
  const q = (query || "").trim();
  const words = q.split(/\s+/).filter(Boolean);
  const out: string[] = [];

  if (words.length > 2) out.push(words.slice(-2).join(" ")); // 末两词
  if (words.length > 1) out.push(words[words.length - 1]); // 末词（通常是主体名词）
  out.push(...UNIVERSAL_FALLBACKS);

  const seen = new Set<string>([q.toLowerCase()]);
  return out.filter((t) => {
    const k = t.toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 拼出某个分镜的素材检索词：优先英文 stockKeywords，回退到画面描述/配音 */
export function shotQuery(shot: { stockKeywords?: string[]; description?: string; voiceover?: string }): string {
  if (shot.stockKeywords?.length) return shot.stockKeywords.join(" ");
  return (shot.description || shot.voiceover || "").trim();
}

// ==================== 候选择优打分 ====================
// 现状只取检索命中的第一条，易配错画面/整片重复同图。下面在多候选里按
// 关键词重合 + 竖屏方向 + 与相邻分镜去重 打分选最优。纯函数、可单测。

type ShotLike = { stockKeywords?: string[]; description?: string; voiceover?: string };

export interface CandidateLike {
  /** 唯一标识，用于相邻分镜去重 */
  id?: string;
  /** 素材自带标签 */
  tags?: string[];
  /** 标题/描述 */
  title?: string;
  orientation?: "portrait" | "landscape" | "square";
  type?: "image" | "video";
}

export interface ScoreOpts {
  /** 偏好竖屏(9:16)，默认 true */
  preferPortrait?: boolean;
  /** 偏好动态视频 B-roll，默认 false */
  preferVideo?: boolean;
  /** 已用过的候选 id（相邻分镜去重，避免整片同图） */
  usedIds?: Set<string>;
}

const terms = (s: string) =>
  (s || "")
    .toLowerCase()
    .split(/[^a-z0-9一-鿿]+/)
    .filter(Boolean);

/** 给一个候选打分（越高越合适）。纯函数。 */
export function scoreCandidate(shot: ShotLike, candidate: CandidateLike, opts: ScoreOpts = {}): number {
  const wantTerms = new Set([...(shot.stockKeywords ?? []), ...terms(shotQuery(shot))].flatMap((t) => terms(t)));
  const candTerms = new Set([...(candidate.tags ?? []), ...terms(candidate.title ?? "")].flatMap((t) => terms(t)));
  let overlap = 0;
  for (const t of candTerms) if (wantTerms.has(t)) overlap++;
  let score = overlap * 10; // 关键词命中权重最高

  if (opts.preferPortrait !== false) {
    if (candidate.orientation === "portrait") score += 5;
    else if (candidate.orientation === "landscape") score -= 3; // 横屏铺竖屏会糊/留黑边
  }
  if (opts.preferVideo && candidate.type === "video") score += 4;
  if (candidate.id && opts.usedIds?.has(candidate.id)) score -= 8; // 整片别重复同一素材

  return score;
}

/** 从多个候选里选最优（无候选返回 undefined）。挑中后调用方可把其 id 加入 usedIds 供后续去重。 */
export function pickBestCandidate<T extends CandidateLike>(shot: ShotLike, candidates: T[], opts: ScoreOpts = {}): T | undefined {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const c of candidates) {
    const s = scoreCandidate(shot, c, opts);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  return best;
}
