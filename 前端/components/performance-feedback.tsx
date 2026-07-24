"use client";

import { useState, useEffect, useCallback } from "react";
import { useLocale } from "@frontend/i18n";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";
import { Card, CardContent } from "@frontend/components/ui/card";
import { LuChartNoAxesColumn, LuCheck, LuLoaderCircle, LuScanLine } from "react-icons/lu";
import { fmtPct } from "@backend/shared/utils";
import type { StyleInsight, HookInsight } from "@backend/core/publish/performance-insights";
import type { MetricsOcrFields } from "@backend/core/publish/metrics-ocr";

// 风格 key → 展示名（聚合返回的是 styleType key）
const STYLE_LABEL: Record<string, { zh: string; en: string }> = {
  pain_point: { zh: "痛点种草", en: "Pain-point" },
  scene: { zh: "场景安利", en: "Scene" },
  comparison: { zh: "对比测评", en: "Comparison" },
  story: { zh: "故事种草", en: "Story" },
  custom: { zh: "自定义", en: "Custom" },
};

// 钩子机制 id → 展示名（与 hook-patterns 的 HOOK_PATTERNS 对应）
const HOOK_LABEL: Record<string, { zh: string; en: string }> = {
  visual_shock: { zh: "视觉冲击", en: "Visual shock" },
  suspense_question: { zh: "悬念提问", en: "Suspense" },
  contrast: { zh: "反差对比", en: "Contrast" },
  pain_strike: { zh: "痛点直击", en: "Pain-point" },
  before_after: { zh: "前后对比", en: "Before-after" },
  sound_hook: { zh: "声音钩子", en: "Sound hook" },
  challenge_doubt: { zh: "挑战质疑", en: "Challenge" },
  identity: { zh: "身份共鸣", en: "Identity" },
  number_benefit: { zh: "数字利益", en: "Number" },
  unexpected: { zh: "反常识意外", en: "Unexpected" },
};

const NUM_FIELDS = [
  { key: "views", zh: "播放", en: "Views" },
  { key: "likes", zh: "点赞", en: "Likes" },
  { key: "comments", zh: "评论", en: "Comments" },
  { key: "shares", zh: "转发", en: "Shares" },
  { key: "orders", zh: "成交", en: "Orders" },
] as const;

type FormState = { platform: string; hookId: string; views: string; likes: string; comments: string; shares: string; orders: string; note: string };
const EMPTY: FormState = { platform: "douyin", hookId: "", views: "", likes: "", comments: "", shares: "", orders: "", note: "" };

/**
 * 截图转 data URL，超过 1280px 的大图先在本地压小（jpeg 0.85）再传：
 * 视觉模型认数字用不上原图分辨率，压一下省流量也省平台侧 token。压缩失败就传原图。
 */
async function imageFileToDataUrl(file: File): Promise<string> {
  const raw: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("图片读取失败"));
      el.src = raw;
    });
    const maxSide = 1280;
    const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    if (scale >= 1) return raw;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) return raw;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    return raw;
  }
}

export function PerformanceFeedback({ projectId, publishedAt }: { projectId: string; publishedAt?: string | null }) {
  const locale = useLocale();
  const en = locale === "en";
  const [form, setForm] = useState<FormState>(EMPTY);
  const [insights, setInsights] = useState<StyleInsight[]>([]);
  const [hookInsights, setHookInsights] = useState<HookInsight[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [hasMetrics, setHasMetrics] = useState(true); // 默认 true：查清楚之前不闪回填提醒
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrMsg, setOcrMsg] = useState("");
  const [ocrError, setOcrError] = useState("");

  const loadInsights = useCallback(async () => {
    try {
      const r = await fetch("/api/insights/styles");
      const j = await r.json();
      setInsights(Array.isArray(j.insights) ? j.insights : []);
      setHookInsights(Array.isArray(j.hookInsights) ? j.hookInsights : []);
    } catch {
      /* 静默：洞察区为空即可 */
    }
  }, []);
  useEffect(() => {
    loadInsights();
  }, [loadInsights]);

  // 查这个项目回填过数据没有：发布满 1 天还没回填才提醒，别对着已回填的老板反复念叨
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/project/${projectId}/metrics`);
        if (!r.ok) return;
        const j = await r.json();
        if (!cancelled) setHasMetrics(j.hasPerformanceData === true);
      } catch {
        /* 静默：保持不提醒 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setSaved(false);
    setSaveError("");
    try {
      const r = await fetch(`/api/project/${projectId}/metrics`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(
          typeof j.error === "string" && j.error
            ? j.error
            : en
              ? "Couldn't save the performance data. Please try again."
              : "效果数据保存失败，请重试"
        );
      }
      setSaved(true);
      setHasMetrics(true);
      setForm({ ...EMPTY, platform: form.platform });
      void loadInsights();
    } catch (error) {
      setSaveError(
        error instanceof Error && error.message
          ? error.message
          : en
            ? "Couldn't save the performance data. Please try again."
            : "效果数据保存失败，请重试"
      );
    } finally {
      setSaving(false);
    }
  };

  // 截图识别：认出的数字只做预填，老板核对后仍需手点保存才进库
  const runOcr = useCallback(
    async (file: File) => {
      if (ocrBusy) return;
      setOcrBusy(true);
      setOcrMsg("");
      setOcrError("");
      try {
        const image = await imageFileToDataUrl(file);
        const r = await fetch(`/api/project/${projectId}/metrics/ocr`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ image }),
        });
        const j = await r.json();
        if (!r.ok) {
          setOcrError(j.error || (en ? "Couldn't read the screenshot — please type the numbers." : "识别失败，先手动填一下吧"));
          return;
        }
        const fields = j.fields as MetricsOcrFields;
        setForm((prev) => ({
          ...prev,
          platform: typeof j.platform === "string" && j.platform ? j.platform : prev.platform,
          views: fields.views != null ? String(fields.views) : prev.views,
          likes: fields.likes != null ? String(fields.likes) : prev.likes,
          comments: fields.comments != null ? String(fields.comments) : prev.comments,
          shares: fields.shares != null ? String(fields.shares) : prev.shares,
          orders: fields.orders != null ? String(fields.orders) : prev.orders,
        }));
        setOcrMsg(en ? "Numbers filled in — check them, then hit Save." : "认出的数字已经填好，核对一下再点保存");
      } catch {
        setOcrError(en ? "Couldn't read the screenshot — please type the numbers." : "识别失败，先手动填一下吧");
      } finally {
        setOcrBusy(false);
      }
    },
    [ocrBusy, projectId, en]
  );

  // 全局粘贴监听：只拦截剪贴板里的图片，粘贴文字不受影响
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (file) {
        e.preventDefault();
        void runOcr(file);
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [runOcr]);

  // 回填提醒：发布满 1 天且还没回填过数据
  const publishedMs = publishedAt ? Date.parse(publishedAt) : NaN;
  const daysSincePublish = Number.isFinite(publishedMs) ? Math.floor((Date.now() - publishedMs) / 86_400_000) : 0;
  const showNudge = daysSincePublish >= 1 && !hasMetrics;

  const styleName = (s: string) => STYLE_LABEL[s]?.[en ? "en" : "zh"] ?? s;
  const hookName = (h: string) => HOOK_LABEL[h]?.[en ? "en" : "zh"] ?? h;
  const fmtRate = (x: number) => fmtPct(x, 2);
  const canSave = Number(form.views) > 0;

  return (
    <Card className="glass-card">
      <CardContent className="p-5">
        <div className="flex items-center gap-2 mb-1">
          <LuChartNoAxesColumn className="w-4 h-4 text-primary" />
          <h3 className="text-sm font-semibold">{en ? "Performance feedback" : "效果回流"}</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          {en
            ? "After publishing, log this video's numbers → learn which script style actually sells, and let it feed back into future scripts."
            : "发布后回填这条数据 → 学出哪种脚本风格更能卖，反哺后续脚本生成。"}
        </p>

        {showNudge && (
          <p className="text-xs text-amber-500 mb-2">
            {en
              ? `Published ${daysSincePublish} day(s) ago — got the numbers? 10 seconds to log them and the AI learns what sells for your shop.`
              : `视频发出去 ${daysSincePublish} 天了，数据出来了吗？花 10 秒填一下，AI 就能越学越懂你的店。`}
          </p>
        )}

        {/* 截图识别：粘贴/上传数据截图 → 视觉模型认数字预填表单（人工核对后才保存） */}
        <div className="mb-3 rounded-lg border border-dashed border-border/70 bg-muted/10 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {ocrBusy ? <LuLoaderCircle className="w-4 h-4 text-primary animate-spin" /> : <LuScanLine className="w-4 h-4 text-primary" />}
            <span>
              {ocrBusy
                ? en
                  ? "Reading the screenshot…"
                  : "正在认图上的数字…"
                : en
                  ? "Paste a screenshot of your stats page (Ctrl+V) and the numbers fill in themselves,"
                  : "把抖音数据页截图直接粘贴到这里（Ctrl+V），数字自动填好，"}
            </span>
            {!ocrBusy && (
              <label htmlFor={`metrics-ocr-file-${projectId}`} className="cursor-pointer text-primary underline underline-offset-2">
                {en ? "or upload an image" : "或点这里上传截图"}
              </label>
            )}
            <input
              id={`metrics-ocr-file-${projectId}`}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void runOcr(file);
                e.target.value = "";
              }}
            />
          </div>
          {ocrMsg && <p className="text-[11px] text-emerald-500 mt-1">{ocrMsg}</p>}
          {ocrError && <p className="text-[11px] text-red-500 mt-1">{ocrError}</p>}
        </div>

        {/* 录入表单 */}
        <div className="flex flex-wrap items-end gap-2 mb-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">{en ? "Platform" : "平台"}</span>
            <select
              value={form.platform}
              onChange={(e) => setForm({ ...form, platform: e.target.value })}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="douyin">{en ? "Douyin" : "抖音"}</option>
              <option value="tiktok">TikTok</option>
              <option value="kuaishou">{en ? "Kuaishou" : "快手"}</option>
              <option value="xiaohongshu">{en ? "Xiaohongshu" : "小红书"}</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-muted-foreground">{en ? "Hook" : "钩子"}</span>
            <select
              value={form.hookId}
              onChange={(e) => setForm({ ...form, hookId: e.target.value })}
              title={en ? "Which hook mechanism this video used (for hook A/B)" : "这条用的哪种钩子机制（用于钩子 A/B）"}
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
            >
              <option value="">{en ? "— hook —" : "— 钩子 —"}</option>
              {Object.entries(HOOK_LABEL).map(([id, l]) => (
                <option key={id} value={id}>
                  {en ? l.en : l.zh}
                </option>
              ))}
            </select>
          </label>
          {NUM_FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[11px] text-muted-foreground">{en ? f.en : f.zh}</span>
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                value={form[f.key]}
                onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                className="h-9 w-20"
                placeholder="0"
              />
            </label>
          ))}
          <Button onClick={submit} disabled={!canSave || saving} size="sm" className="brand-gradient text-white h-9">
            {saved ? <LuCheck className="w-4 h-4 mr-1" /> : null}
            {saving ? (en ? "Saving…" : "保存中…") : saved ? (en ? "Saved" : "已保存") : en ? "Save" : "保存"}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground mb-4">
          {en ? "Tip: views is required; the script style is captured automatically." : "提示：「播放」必填；脚本风格会自动定格，无需手填。"}
        </p>
        {saveError && (
          <p role="alert" className="mb-4 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500">
            {saveError}
          </p>
        )}

        {/* 聚合洞察：哪种风格更能卖 */}
        {insights.length > 0 && (
          <div className="border-t border-border/50 pt-3">
            <p className="text-xs font-medium mb-2">
              {en ? "Which style sells best (all projects)" : "哪种风格更能卖（全部项目）"}
            </p>
            <div className="space-y-1.5">
              {insights.map((it, i) => (
                <div key={it.style} className="flex items-center gap-3 text-xs">
                  <span className={`w-16 shrink-0 ${i === 0 ? "text-emerald-500 font-medium" : ""}`}>
                    {i === 0 ? "🏆 " : ""}
                    {styleName(it.style)}
                  </span>
                  <span className="text-muted-foreground">
                    {en ? "conv." : "转化"} <b className={i === 0 ? "text-emerald-500" : ""}>{fmtRate(it.conversionRate)}</b>
                  </span>
                  <span className="text-muted-foreground">
                    {en ? "eng." : "互动"} {fmtRate(it.engagementRate)}
                  </span>
                  <span className="text-muted-foreground/70">
                    {en ? `${it.samples} sample(s)` : `${it.samples} 条样本`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 聚合洞察：哪个钩子机制更能卖 */}
        {hookInsights.length > 0 && (
          <div className="border-t border-border/50 pt-3 mt-3">
            <p className="text-xs font-medium mb-2">
              {en ? "Which hook sells best (all projects)" : "哪个钩子更能卖（全部项目）"}
            </p>
            <div className="space-y-1.5">
              {hookInsights.map((it, i) => (
                <div key={it.hookId} className="flex items-center gap-3 text-xs">
                  <span className={`w-16 shrink-0 ${i === 0 ? "text-emerald-500 font-medium" : ""}`}>
                    {i === 0 ? "🏆 " : ""}
                    {hookName(it.hookId)}
                  </span>
                  <span className="text-muted-foreground">
                    {en ? "conv." : "转化"} <b className={i === 0 ? "text-emerald-500" : ""}>{fmtRate(it.conversionRate)}</b>
                  </span>
                  <span className="text-muted-foreground">
                    {en ? "eng." : "互动"} {fmtRate(it.engagementRate)}
                  </span>
                  <span className="text-muted-foreground/70">
                    {en ? `${it.samples} sample(s)` : `${it.samples} 条样本`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
