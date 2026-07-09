/** 多语言配置：中文为默认/主语言，English 为可切换的全球语 */
export const LOCALES = ["zh", "en"] as const;
export type Locale = (typeof LOCALES)[number];

/** 默认语言：中文优先 */
export const DEFAULT_LOCALE: Locale = "zh";

/** 语言切换器上显示的名字 */
export const LOCALE_LABELS: Record<Locale, string> = {
  zh: "中文",
  en: "English",
};

/** 一个命名空间（一个页面/模块）的双语词条 */
export interface NamespaceMessages {
  zh: Record<string, string>;
  en: Record<string, string>;
}

/**
 * 按用户系统/浏览器语言自动判定界面语言。
 * 中文系统（zh / zh-CN / zh-TW…）→ zh；其余一律 → en（英语作为全球通用语兜底）。
 * 在无 navigator 的环境（SSR）返回默认语言。
 */
export function detectBrowserLocale(): Locale {
  if (typeof navigator === "undefined") return DEFAULT_LOCALE;
  const langs = (navigator.languages && navigator.languages.length
    ? navigator.languages
    : [navigator.language]) as string[];
  for (const l of langs) {
    if (!l) continue;
    if (l.toLowerCase().startsWith("zh")) return "zh";
    // 命中任何明确语言即采用英语兜底（我们仅提供 zh/en）
    return "en";
  }
  return DEFAULT_LOCALE;
}
