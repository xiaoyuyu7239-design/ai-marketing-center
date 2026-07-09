/**
 * 钩子变体 A/B：固定脚本的后续分镜，只把第 1 镜（钩子）按不同机制重写，
 * 得到 N 条「只有开场不同」的可比变体；每条打 hookId 标签，投放后按 hookId 回流选赢家。
 *
 * 纯函数、零 LLM / 零 Key——直接用钩子模式库生成，贴合免 Key 兜底哲学。
 * 注意：变体的开场口播取自模式库示例，是「机制级 A/B 草稿」（用于测哪种钩子机制更能卖），
 * 不是逐字打磨的成稿——测出赢家机制后再精修最划算。
 */
import type { Shot } from "../db/schema";
import type { ProductCategory } from "./templates";
import { selectHookPatterns, type HookPattern } from "./hook-patterns";

export interface ScriptLike {
  title?: string;
  styleType?: string;
  totalDuration?: number;
  shots: Shot[];
}

export interface HookVariant {
  /** 所用钩子机制 id（= HookPattern.id）；效果回流按它聚合 */
  hookId: string;
  hookName: string;
  script: ScriptLike;
}

/** 用某机制重写第 1 镜：口播换成该机制的钩子，画面描述补上该机制的「截停」做法（保留原画面意图） */
function rewriteHookShot(shot: Shot, p: HookPattern): Shot {
  return {
    ...shot,
    type: "hook",
    voiceover: p.example,
    description: shot.description ? `${p.stop}（沿用原画面意图：${shot.description}）` : p.stop,
  };
}

/**
 * 由一条基准脚本生成 N 条钩子变体（只改第 1 镜，shot 2..N 原样保留）。
 * patterns 省略则按品类优选；传入则用指定机制集合。
 */
export function buildHookVariants(
  base: ScriptLike,
  category: ProductCategory,
  n = 3,
  patterns?: HookPattern[]
): HookVariant[] {
  if (!base.shots.length) return [];
  const picks = (patterns ?? selectHookPatterns(category, n)).slice(0, n);
  return picks.map((p) => ({
    hookId: p.id,
    hookName: p.name,
    script: {
      ...base,
      shots: base.shots.map((s, i) => (i === 0 ? rewriteHookShot(s, p) : s)),
    },
  }));
}
