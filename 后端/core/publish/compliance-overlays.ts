/**
 * 合规标识 + 购买 CTA 片尾贴 —— 两个可选的「带货 + 合规」叠加：
 *  - AI 生成标识：TikTok / 抖音自 2025 末起要求 AI 合成内容打标识；披露反而与更高转化正相关。
 *  - 购买 CTA 片尾卡：最后 ~2.5s 弹「点击下方小黄车」类引导，是带货的直接转化杠杆。
 * 复用 composer 现有 overlay（textOverlay）渲染管线，纯函数可单测。
 */

export type OverlayStyle = "title" | "highlight" | "price" | "disclosure";
export interface ComplianceOverlay {
  text: string;
  style: OverlayStyle;
  startTime: number;
  endTime: number;
}
export interface ComplianceOverlayOpts {
  /** 兼容旧调用；邀请内测由服务端强制显示，传 false 也不会关闭。 */
  aiDisclosure?: boolean;
  /** 服务端可配置的合规标识文案，默认「AI生成/辅助」 */
  disclosureText?: string;
  /** 片尾购买 CTA 文案（最后约 2.5s）；空/未传则不加 */
  ctaText?: string;
}

const CTA_TAIL_SECONDS = 2.5;

/** 由选项生成合规/CTA 叠加层；totalDuration 为成片真实总时长（秒） */
export function buildComplianceOverlays(opts: ComplianceOverlayOpts, totalDuration: number): ComplianceOverlay[] {
  const out: ComplianceOverlay[] = [];
  const total = Math.max(totalDuration, 0.1);

  // 邀请内测的成片统一强制显式标识，不能依赖各个前端入口是否记得传开关。
  const disclosure = (opts.disclosureText || "AI生成/辅助").trim() || "AI生成/辅助";
  out.push({ text: disclosure, style: "disclosure", startTime: 0, endTime: total });

  const cta = (opts.ctaText || "").trim();
  if (cta) {
    const dur = Math.min(CTA_TAIL_SECONDS, total);
    out.push({ text: cta, style: "highlight", startTime: Number(Math.max(0, total - dur).toFixed(3)), endTime: total });
  }

  return out;
}
