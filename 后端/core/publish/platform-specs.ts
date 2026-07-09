/**
 * 各带货平台的成片规格 —— 多平台导出（重编码到目标比例）的单一事实来源。
 * 抖音 / 快手 / TikTok Shop 为 9:16 竖屏；小红书偏好 3:4。纯数据 + 取值函数，可单测。
 */

export interface PlatformSpec {
  name: string;
  w: number;
  h: number;
  ratio: string;
}

export const PLATFORM_SPECS: Record<string, PlatformSpec> = {
  douyin: { name: "抖音", w: 1080, h: 1920, ratio: "9:16" },
  kuaishou: { name: "快手", w: 1080, h: 1920, ratio: "9:16" },
  xiaohongshu: { name: "小红书", w: 1080, h: 1440, ratio: "3:4" },
  tiktok: { name: "TikTok Shop", w: 1080, h: 1920, ratio: "9:16" },
};

/** 取某平台规格；未知平台返回 undefined。 */
export function getPlatformSpec(platform: string): PlatformSpec | undefined {
  return PLATFORM_SPECS[platform];
}
