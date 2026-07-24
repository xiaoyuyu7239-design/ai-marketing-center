"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LuArrowLeft, LuBellRing, LuLogOut, LuPalette, LuPlus, LuStar, LuStore, LuTrash2, LuUpload, LuUser } from "react-icons/lu";
import { Button } from "@frontend/components/ui/button";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Input } from "@frontend/components/ui/input";
import { Label } from "@frontend/components/ui/label";
import { Textarea } from "@frontend/components/ui/textarea";
import { LanguageToggle } from "@frontend/components/language-toggle";
import { ReminderSettings } from "@frontend/components/reminder-settings";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";
import { useBrandStore } from "@frontend/stores/brand-store";
import { useCharacterStore, type Character } from "@frontend/stores/project-store";
import { useT } from "@frontend/i18n";
import { Toggle } from "@frontend/components/ui/toggle";

type SettingsTab = "merchant" | "characters" | "brand" | "reminders";

// 出镜人物与品牌素材目前只保存在浏览器本地，尚未完整接入主生成链路。
// 先从普通用户端隐藏，保留实现以便后续接通后再开放。
const ENABLE_ADVANCED_CREATIVE_PREFERENCES = false;

export default function SettingsPage() {
  const t = useT("settings");
  const [activeTab, setActiveTab] = useState<SettingsTab>("merchant");

  const visibleTabs = [
    { value: "merchant" as const, label: t("tabMerchant"), icon: LuStore },
    ...(ENABLE_ADVANCED_CREATIVE_PREFERENCES
      ? [
          { value: "characters" as const, label: t("tabCharacters"), icon: LuUser },
          { value: "brand" as const, label: t("tabBrand"), icon: LuPalette },
        ]
      : []),
    { value: "reminders" as const, label: t("tabReminders"), icon: LuBellRing },
  ];

  return (
    <div className="workflow-light settings-light min-h-screen bg-[#F6F7F9] text-[#111111]">
      <header className="sticky top-0 z-50 border-b border-[#E2E5EA] bg-white/92 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1120px] items-center justify-between px-5 sm:px-8">
          <div className="flex items-center gap-3">
            <Link
              href="/project/agent"
              className="-ml-2 inline-flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-extrabold text-[#68717E] transition hover:bg-[#F0F2F5] hover:text-[#111111]"
            >
              <LuArrowLeft className="size-4" />
              <span>{t("backHome")}</span>
            </Link>
            <div className="h-6 w-px bg-[#E2E5EA]" />
            <span className="flex items-center text-[#111827]" aria-label="绘卖AI">
              <BrandWheatMark className="h-9 w-7" />
            </span>
          </div>
          <LanguageToggle className="text-[#68717E] hover:bg-[#F0F2F5] hover:text-[#111111]" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1120px] px-5 py-8 sm:px-8 sm:py-12">
        <div className="mb-8">
          <p className="text-[12px] font-black tracking-[0.18em] text-[#8A94A0]">绘卖AI</p>
          <h1 className="mt-2 text-[28px] font-black leading-tight tracking-[-0.02em] text-[#111111] sm:text-[34px]">
            {t("pageTitle")}
          </h1>
          <p className="mt-2 max-w-2xl text-sm font-semibold leading-6 text-[#68717E] sm:text-[15px]">
            {t("pageSubtitle")}
          </p>
        </div>

        <div
          className="mb-8 flex w-fit max-w-full items-center gap-1 overflow-x-auto rounded-2xl border border-[#DDE2E8] bg-white p-1.5 shadow-[0_8px_28px_rgba(17,24,39,0.05)]"
          role="tablist"
          aria-label={t("pageTitle")}
        >
          {visibleTabs.map((tab) => {
            const Icon = tab.icon;
            const selected = activeTab === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setActiveTab(tab.value)}
                className={`inline-flex h-10 items-center gap-2 rounded-xl px-4 text-sm font-extrabold whitespace-nowrap transition ${
                  selected
                    ? "bg-[#111111] text-white shadow-sm"
                    : "text-[#68717E] hover:bg-[#F0F2F5] hover:text-[#111111]"
                }`}
              >
                <Icon className="size-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        <section role="tabpanel" className="max-w-[1040px]">
          {activeTab === "merchant" ? <MerchantProfileSettings /> : null}
          {activeTab === "reminders" ? <ReminderSettings /> : null}
          {ENABLE_ADVANCED_CREATIVE_PREFERENCES && activeTab === "characters" ? <CharacterManager /> : null}
          {ENABLE_ADVANCED_CREATIVE_PREFERENCES && activeTab === "brand" ? <BrandSettings /> : null}
        </section>

        {/* 底部原有的全局"保存设置"按钮是假保存（只弹提示不落任何数据）已移除：
            出镜人物/品牌设置改动即存，商家信息 tab 有自己的真实保存按钮 */}
      </main>
    </div>
  );
}

const PROFILE_CATEGORY_OPTIONS = [
  { value: "beauty", label: "美妆护肤" },
  { value: "food", label: "食品零食" },
  { value: "home", label: "家居日用" },
  { value: "fashion", label: "服饰鞋包" },
  { value: "tech", label: "数码3C" },
  { value: "other", label: "其他" },
];

interface MerchantProfileForm {
  shopName: string;
  category: string;
  region: string;
  targetAudience: string;
  priceRange: string;
  platforms: string;
  storeType: string;
  landmark: string;
  storeAddress: string;
  customTags: string;
}

const EMPTY_PROFILE: MerchantProfileForm = {
  shopName: "", category: "", region: "", targetAudience: "", priceRange: "", platforms: "",
  storeType: "", landmark: "", storeAddress: "", customTags: "",
};

// 经营形态：实体门店/都有 会开启同城内容策略（城市锚点脚本 + 同城标签梯度 + POI 发布清单）
const STORE_TYPE_OPTIONS = [
  { value: "ecommerce", label: "纯电商", hint: "线上卖货，视频面向全国" },
  { value: "local", label: "实体门店", hint: "做同城到店客流，视频带城市/商圈锚点" },
  { value: "both", label: "都有", hint: "线上卖货也有门店，同城策略同样开启" },
];

// 商家建档：填一次，之后生成脚本时自动带上品类/人群/价格带默认值（老板不用每次填）
function MerchantProfileSettings() {
  const [form, setForm] = useState<MerchantProfileForm>(EMPTY_PROFILE);
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (res) => {
        if (ignore) return;
        if (!res.ok) {
          setEmail(null);
          return;
        }
        const data = await res.json().catch(() => ({}));
        const merchant = data.merchant ?? {};
        setEmail(typeof merchant.email === "string" ? merchant.email : null);
        setForm({
          shopName: merchant.shopName ?? "",
          category: merchant.category ?? "",
          region: merchant.region ?? "",
          targetAudience: merchant.targetAudience ?? "",
          priceRange: merchant.priceRange ?? "",
          platforms: merchant.platforms ?? "",
          storeType: merchant.storeType ?? "",
          landmark: merchant.landmark ?? "",
          storeAddress: merchant.storeAddress ?? "",
          customTags: merchant.customTags ?? "",
        });
      })
      .catch(() => {
        if (!ignore) setEmail(null);
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  const handleSaveProfile = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof data.error === "string" ? data.error : "保存失败，请重试");
        return;
      }
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 1600);
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = "/project/agent";
  };

  if (loading) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">正在读取商家信息…</CardContent></Card>;
  }

  if (!email) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm font-medium">还没有登录</p>
          <p className="mt-1 text-xs text-muted-foreground">先在创作工作台登录商家账号，再回来完善店铺信息。</p>
          <Link href="/project/agent" className="mt-4 inline-block">
            <Button size="sm">去登录</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="space-y-5 p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold">账号：{email}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">建档信息会作为生成脚本时的默认品类、人群和价格带。</p>
          </div>
          <Button variant="outline" size="sm" onClick={handleLogout}>
            <LuLogOut className="size-3.5" />
            <span className="ml-1">退出登录</span>
          </Button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="profile-shop-name">店铺/品牌名</Label>
            <Input
              id="profile-shop-name"
              value={form.shopName}
              onChange={(event) => setForm((f) => ({ ...f, shopName: event.target.value }))}
              placeholder="如：云柔纸品旗舰店"
              className="mt-1.5"
            />
          </div>
          <div>
            <Label>主营品类</Label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {PROFILE_CATEGORY_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, category: f.category === option.value ? "" : option.value }))}
                  className={`h-9 rounded-lg border px-3 text-xs font-bold transition ${
                    form.category === option.value
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:border-foreground/40"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          <div className="sm:col-span-2">
            <Label>经营形态</Label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {STORE_TYPE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.hint}
                  onClick={() => setForm((f) => ({ ...f, storeType: f.storeType === option.value ? "" : option.value }))}
                  className={`h-9 rounded-lg border px-3 text-xs font-bold transition ${
                    form.storeType === option.value
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:border-foreground/40"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {(form.storeType === "local" || form.storeType === "both") && (
              <p className="mt-1.5 text-xs text-muted-foreground">
                已开启同城模式：生成的视频会带城市/商圈钩子和到店号召，发布文案自动配同城标签和挂 POI 提醒。
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="profile-region">城市</Label>
            <Input
              id="profile-region"
              value={form.region}
              onChange={(event) => setForm((f) => ({ ...f, region: event.target.value }))}
              placeholder="如：杭州（同城内容的城市锚点）"
              className="mt-1.5"
            />
          </div>
          <div>
            <Label htmlFor="profile-price-range">主力价格带</Label>
            <Input
              id="profile-price-range"
              value={form.priceRange}
              onChange={(event) => setForm((f) => ({ ...f, priceRange: event.target.value }))}
              placeholder="如：50-150元"
              className="mt-1.5"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="profile-audience">目标客户</Label>
            <Input
              id="profile-audience"
              value={form.targetAudience}
              onChange={(event) => setForm((f) => ({ ...f, targetAudience: event.target.value }))}
              placeholder="如：25-35岁注重性价比的宝妈"
              className="mt-1.5"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="profile-platforms">主投平台</Label>
            <Input
              id="profile-platforms"
              value={form.platforms}
              onChange={(event) => setForm((f) => ({ ...f, platforms: event.target.value }))}
              placeholder="如：douyin,xiaohongshu"
              className="mt-1.5"
            />
          </div>
          {(form.storeType === "local" || form.storeType === "both") && (
            <>
              <div>
                <Label htmlFor="profile-landmark">商圈 / 地标</Label>
                <Input
                  id="profile-landmark"
                  value={form.landmark}
                  onChange={(event) => setForm((f) => ({ ...f, landmark: event.target.value }))}
                  placeholder="如：武林商圈 / 西湖区"
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="profile-store-address">门店地址（POI）</Label>
                <Input
                  id="profile-store-address"
                  value={form.storeAddress}
                  onChange={(event) => setForm((f) => ({ ...f, storeAddress: event.target.value }))}
                  placeholder="如：文三路 259 号 1 层"
                  className="mt-1.5"
                />
              </div>
              <div className="sm:col-span-2">
                <Label htmlFor="profile-custom-tags">常用话题标签（每条发布自动带上）</Label>
                <Input
                  id="profile-custom-tags"
                  value={form.customTags}
                  onChange={(event) => setForm((f) => ({ ...f, customTags: event.target.value }))}
                  placeholder="如：杭州美甲,滨江探店（逗号分隔，最多 10 个）"
                  className="mt-1.5"
                />
              </div>
            </>
          )}
        </div>

        {error && <p className="text-xs font-semibold text-red-500">{error}</p>}
        <div className="flex items-center justify-end gap-3">
          {savedAt ? <span className="text-sm text-emerald-500">已保存</span> : null}
          <Button onClick={handleSaveProfile} disabled={saving}>
            {saving ? "保存中…" : "保存商家信息"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CharacterManager() {
  const t = useT("settings");
  const { characters, addCharacter, updateCharacter, removeCharacter } = useCharacterStore();
  const [isCreating, setIsCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", description: "", appearance: "", voiceStyle: "" });

  const resetForm = () => {
    setForm({ name: "", description: "", appearance: "", voiceStyle: "" });
    setIsCreating(false);
    setEditingId(null);
  };

  const handleSave = () => {
    if (!form.name.trim()) return;
    if (editingId) {
      updateCharacter(editingId, {
        name: form.name,
        description: form.description,
        appearance: form.appearance,
        voiceProfile: form.voiceStyle ? { style: form.voiceStyle } : undefined,
      });
    } else {
      addCharacter({
        id: crypto.randomUUID(),
        name: form.name,
        description: form.description,
        appearance: form.appearance,
        referenceImages: [],
        voiceProfile: form.voiceStyle ? { style: form.voiceStyle } : undefined,
        isDefault: characters.length === 0,
      });
    }
    resetForm();
  };

  const startEdit = (char: Character) => {
    setEditingId(char.id);
    setIsCreating(true);
    setForm({
      name: char.name,
      description: char.description || "",
      appearance: char.appearance || "",
      voiceStyle: char.voiceProfile?.style || "",
    });
  };

  const setAsDefault = (id: string) => {
    characters.forEach((char) => updateCharacter(char.id, { isDefault: char.id === id }));
  };

  return (
    <div className="space-y-4">
      <Card className="glass-card">
        <CardContent className="p-4">
          <p className="text-sm text-muted-foreground leading-relaxed">{t("characterIntro")}</p>
        </CardContent>
      </Card>

      {characters.map((char) => (
        <Card key={char.id} className={`glass-card ${char.isDefault ? "ring-1 ring-primary/50" : ""}`}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10">
                  <LuUser className="size-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">{char.name}</h3>
                    {char.isDefault ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-xs text-primary">
                        <LuStar className="size-3" />
                        {t("characterDefault")}
                      </span>
                    ) : null}
                  </div>
                  {char.description ? <p className="mt-1 text-xs text-muted-foreground">{char.description}</p> : null}
                  {char.appearance ? <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/70">{t("characterAppearancePrefix", { appearance: char.appearance })}</p> : null}
                  {char.voiceProfile?.style ? <p className="mt-0.5 text-xs text-muted-foreground/70">{t("characterVoicePrefix", { voice: char.voiceProfile.style })}</p> : null}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {!char.isDefault ? (
                  <Button variant="ghost" size="icon-sm" onClick={() => setAsDefault(char.id)} aria-label={t("characterDefault")}>
                    <LuStar className="size-3.5" />
                  </Button>
                ) : null}
                <Button variant="ghost" size="sm" onClick={() => startEdit(char)}>{t("characterEdit")}</Button>
                <Button variant="ghost" size="icon-sm" className="text-destructive hover:text-destructive" onClick={() => removeCharacter(char.id)} aria-label={t("delete")}>
                  <LuTrash2 className="size-3.5" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}

      {isCreating ? (
        <Card className="glass-card ring-1 ring-primary/30">
          <CardContent className="space-y-4 p-5">
            <h3 className="text-sm font-semibold">{editingId ? t("characterFormEditTitle") : t("characterFormAddTitle")}</h3>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              {t("characterNameLabel")}
              <Input value={form.name} onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))} placeholder={t("characterNamePlaceholder")} />
            </label>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              {t("characterDescLabel")}
              <Input value={form.description} onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))} placeholder={t("characterDescPlaceholder")} />
            </label>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              {t("characterAppearanceLabel")}
              <Textarea value={form.appearance} onChange={(e) => setForm((prev) => ({ ...prev, appearance: e.target.value }))} placeholder={t("characterAppearancePlaceholder")} rows={3} />
            </label>
            <label className="space-y-1.5 text-xs text-muted-foreground">
              {t("characterVoiceLabel")}
              <Input value={form.voiceStyle} onChange={(e) => setForm((prev) => ({ ...prev, voiceStyle: e.target.value }))} placeholder={t("characterVoicePlaceholder")} />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={resetForm}>{t("characterCancel")}</Button>
              <Button size="sm" onClick={handleSave} disabled={!form.name.trim()}>{editingId ? t("characterSaveEdit") : t("characterAddSubmit")}</Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Button variant="outline" className="h-12 w-full border-dashed" onClick={() => setIsCreating(true)}>
          <LuPlus className="size-4" />
          {t("characterAddButton")}
        </Button>
      )}
    </div>
  );
}

const WATERMARK_POSITIONS = [
  { value: "top-left" as const, labelKey: "brandPositionTopLeft" },
  { value: "top-right" as const, labelKey: "brandPositionTopRight" },
  { value: "bottom-left" as const, labelKey: "brandPositionBottomLeft" },
  { value: "bottom-right" as const, labelKey: "brandPositionBottomRight" },
] as const;

function BrandSettings() {
  const t = useT("settings");
  const { brand, updateBrand, updateWatermark } = useBrandStore();

  return (
    <div className="space-y-6">
      <Card className="glass-card">
        <CardContent className="p-5">
          <h3 className="mb-4 text-sm font-semibold">{t("brandShopTitle")}</h3>
          <div className="grid gap-4">
            <label className="space-y-1.5 text-xs text-muted-foreground">
              {t("brandNameLabel")}
              <Input value={brand.name} onChange={(e) => updateBrand({ name: e.target.value })} placeholder={t("brandNamePlaceholder")} />
            </label>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Logo</Label>
              <div className="flex items-center gap-4">
                <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border-2 border-dashed border-border bg-muted/30">
                  {brand.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={brand.logoUrl} alt={t("brandLogoAlt")} className="h-full w-full object-contain" />
                  ) : (
                    <LuUpload className="size-5 text-muted-foreground/60" />
                  )}
                </div>
                <label className="cursor-pointer">
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      const reader = new FileReader();
                      reader.onload = (ev) => updateBrand({ logoUrl: ev.target?.result as string });
                      reader.readAsDataURL(file);
                    }}
                  />
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium hover:bg-accent">
                    <LuUpload className="size-3" />
                    {t("brandUploadLogo")}
                  </span>
                </label>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="glass-card">
        <CardContent className="p-5">
          <h3 className="mb-4 text-sm font-semibold">{t("brandColorTitle")}</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              ["primaryColor", t("brandPrimaryColor"), brand.primaryColor],
              ["secondaryColor", t("brandSecondaryColor"), brand.secondaryColor],
            ].map(([key, label, value]) => (
              <label key={key} className="space-y-1.5 text-xs text-muted-foreground">
                {label}
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={value}
                    onChange={(event) => updateBrand({ [key]: event.target.value })}
                    className="size-9 rounded-lg border border-border bg-transparent"
                  />
                  <Input value={value} onChange={(event) => updateBrand({ [key]: event.target.value })} className="font-mono text-xs uppercase" maxLength={7} />
                </div>
              </label>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="glass-card">
        <CardContent className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t("brandWatermarkTitle")}</h3>
            <Toggle checked={brand.watermark.enabled} onChange={(enabled) => updateWatermark({ enabled })} />
          </div>
          {brand.watermark.enabled ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {WATERMARK_POSITIONS.map((pos) => (
                  <button
                    key={pos.value}
                    onClick={() => updateWatermark({ position: pos.value })}
                    className={`h-9 rounded-lg border text-xs font-medium transition-colors ${
                      brand.watermark.position === pos.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border bg-background text-muted-foreground hover:bg-accent"
                    }`}
                  >
                    {t(pos.labelKey)}
                  </button>
                ))}
              </div>
              <label className="block space-y-1.5 text-xs text-muted-foreground">
                {t("brandWatermarkOpacity")}
                <input
                  type="range"
                  min="10"
                  max="100"
                  step="5"
                  value={Math.round(brand.watermark.opacity * 100)}
                  onChange={(event) => updateWatermark({ opacity: Number(event.target.value) / 100 })}
                  className="w-full accent-primary"
                />
              </label>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card className="glass-card">
        <CardContent className="p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-semibold">{t("brandOutroTitle")}</h3>
            <Toggle checked={brand.outroEnabled} onChange={(enabled) => updateBrand({ outroEnabled: enabled })} />
          </div>
          {brand.outroEnabled ? (
            <label className="space-y-1.5 text-xs text-muted-foreground">
              {t("brandOutroTextLabel")}
              <Textarea value={brand.outroText ?? ""} onChange={(event) => updateBrand({ outroText: event.target.value })} rows={2} placeholder={t("brandOutroTextPlaceholder")} />
            </label>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
