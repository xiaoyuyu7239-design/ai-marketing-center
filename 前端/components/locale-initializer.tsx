"use client";

import { useEffect } from "react";
import { useSettingsStore } from "@frontend/stores/settings-store";
import { useLocale } from "@frontend/i18n";
import { detectBrowserLocale } from "@frontend/i18n/config";

/**
 * 语言初始化器（挂在根布局，无渲染）：
 * 1) 首屏按用户系统/浏览器语言自动判定界面语言（仅当用户未手动切换过，localeSource==="auto"）；
 * 2) 让 <html lang> 跟随当前界面语言，利于无障碍与 SEO。
 */
export function LocaleInitializer() {
  const locale = useLocale();

  // 跟随系统语言自动判定（用户手动切过则不覆盖）
  useEffect(() => {
    const { localeSource, applyAutoLocale } = useSettingsStore.getState();
    // 仅当用户没手动选过（auto，或旧版持久化里没有该字段）才跟随系统语言
    if (localeSource !== "user") {
      applyAutoLocale(detectBrowserLocale());
    }
  }, []);

  // 同步 <html lang>
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    }
  }, [locale]);

  return null;
}
