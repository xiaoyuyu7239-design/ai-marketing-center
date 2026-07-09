"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LuArrowLeft, LuSparkles, LuCircleAlert, LuLoaderCircle, LuWandSparkles } from "react-icons/lu";
import { useT } from "@frontend/i18n";
import { LanguageToggle } from "@frontend/components/language-toggle";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Button } from "@frontend/components/ui/button";
import { Badge } from "@frontend/components/ui/badge";
import { Label } from "@frontend/components/ui/label";
import { Textarea } from "@frontend/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@frontend/components/ui/select";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";

// 旁白风格（与后端 TopicNarrationStyle 一一对应）；label/desc 在渲染时按语言取词
const narrationStyleValues = ["knowledge", "story", "lifestyle", "inspiration", "travel"] as const;

// 时长选项（label 为单位文本，无需翻译）
const durationOptions = [
  { value: "15", label: "15s" },
  { value: "25", label: "25s" },
  { value: "40", label: "40s" },
];

// 主题灵感示例（新手零门槛试用）；文案按语言取词，key 顺序与下方渲染一致
const exampleTopicKeys = ["exampleTopic1", "exampleTopic2", "exampleTopic3", "exampleTopic4", "exampleTopic5"];

export default function TopicProjectPage() {
  const t = useT("topic");
  const tc = useT("common");
  const router = useRouter();

  const [topic, setTopic] = useState("");
  const [narrationStyle, setNarrationStyle] = useState("knowledge");
  const [duration, setDuration] = useState("25");

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isValid = topic.trim().length >= 2;

  const handleGenerate = async () => {
    if (!isValid || isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/topic/script", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic.trim(),
          narrationStyle,
          targetDuration: Number(duration),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 即便生成失败，后端也可能已建好草稿项目并回传 projectId，便于跳转后重试
        if (data.projectId) {
          router.push(`/project/${data.projectId}/script`);
          return;
        }
        throw new Error(data.error || t("errorGenerateCheckLlm"));
      }
      // 成功：跳到脚本页查看多套方案，再走素材自动配齐 → 合成
      router.push(`/project/${data.projectId}/script`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorGenerate"));
      setIsSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen grid-bg">
      {/* 顶部导航 */}
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Link href="/project/agent">
              <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground -ml-2">
                <LuArrowLeft className="w-4 h-4" />
                <span className="ml-1">{tc("back")}</span>
              </Button>
            </Link>
            <div className="h-5 w-px bg-border/50" />
            <div className="flex items-center gap-2">
              <BrandWheatMark className="h-8 w-6 text-foreground" />
            </div>
          </div>
          <div className="flex items-center gap-1">
            <LanguageToggle />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-6 py-10">
        {/* 页面标题 */}
        <div className="mb-8">
          <div className="mb-3 inline-flex items-center gap-2 rounded-full bg-violet-500/10 px-3 py-1 text-xs font-medium text-violet-500">
            <LuSparkles className="w-3.5 h-3.5" />
            {t("heroBadge")}
          </div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">{t("heroTitle")}</h1>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("heroSubtitle")}
          </p>
        </div>

        <Card className="glass-card">
          <CardContent className="p-6 space-y-6">
            {/* 主题输入 */}
            <div className="space-y-2">
              <Label htmlFor="topic" className="text-sm font-medium">
                {t("topicLabel")} <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t("topicPlaceholder")}
                rows={3}
                className="resize-none"
              />
              {/* 灵感示例 */}
              <div className="flex flex-wrap gap-1.5 pt-1">
                <span className="text-xs text-muted-foreground self-center">{t("tryLabel")}</span>
                {exampleTopicKeys.map((key) => {
                  const text = t(key);
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setTopic(text)}
                      className="rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors"
                    >
                      {text}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* 旁白风格 */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t("narrationLabel")}</Label>
              <Select value={narrationStyle} onValueChange={(val) => setNarrationStyle(val ?? "knowledge")}>
                <SelectTrigger>
                  {/* Base UI 的 Select.Value 默认显示原始 value，用函数子节点映射为标签（按语言取词） */}
                  <SelectValue>
                    {(value: string) => t(`narration_${value}_label`)}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {narrationStyleValues.map((value) => (
                    <SelectItem key={value} value={value}>
                      {t(`narration_${value}_label`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {/* 选中风格的说明（放在 Select 外，避免触发器显示原始 value） */}
              <p className="text-xs text-muted-foreground">
                {t(`narration_${narrationStyle}_desc`)}
              </p>
            </div>

            {/* 时长 */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">{t("durationLabel")}</Label>
              <div className="flex gap-2">
                {durationOptions.map((o) => (
                  <button
                    key={o.value}
                    type="button"
                    onClick={() => setDuration(o.value)}
                    className={`flex-1 rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                      duration === o.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/60 text-muted-foreground hover:border-primary/40"
                    }`}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 错误提示 */}
            {error && (
              <div className="flex items-start gap-2 rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-sm text-destructive">
                <LuCircleAlert className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            {/* 生成按钮 */}
            <Button
              onClick={handleGenerate}
              disabled={!isValid || isSubmitting}
              className="w-full brand-gradient text-white"
              size="lg"
            >
              {isSubmitting ? (
                <>
                  <LuLoaderCircle className="w-4 h-4 animate-spin" />
                  <span className="ml-1.5">{t("generatingScript")}</span>
                </>
              ) : (
                <>
                  <LuWandSparkles className="w-4 h-4" />
                  <span className="ml-1.5">{t("ctaGenerate")}</span>
                </>
              )}
            </Button>

            {/* 流程提示 */}
            <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground pt-1">
              <Badge variant="secondary" className="text-[10px]">{t("flowStep1")}</Badge>
              <span className="text-border">→</span>
              <Badge variant="secondary" className="text-[10px]">{t("flowStep2")}</Badge>
              <span className="text-border">→</span>
              <Badge variant="secondary" className="text-[10px]">{t("flowStep3")}</Badge>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
