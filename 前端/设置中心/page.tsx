"use client";

import { useState } from "react";
import Link from "next/link";
import { LuArrowLeft, LuPalette, LuPlus, LuShieldCheck, LuStar, LuTrash2, LuUpload, LuUser } from "react-icons/lu";
import { Button } from "@frontend/components/ui/button";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Input } from "@frontend/components/ui/input";
import { Label } from "@frontend/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@frontend/components/ui/tabs";
import { Textarea } from "@frontend/components/ui/textarea";
import { LanguageToggle } from "@frontend/components/language-toggle";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";
import { useBrandStore } from "@frontend/stores/brand-store";
import { useCharacterStore, type Character } from "@frontend/stores/project-store";
import { useT } from "@frontend/i18n";
import { Toggle } from "@frontend/components/ui/toggle";

export default function SettingsPage() {
  const t = useT("settings");
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    setSaved(true);
    setTimeout(() => setSaved(false), 1600);
  };

  return (
    <div className="min-h-screen grid-bg">
      <header className="sticky top-0 z-50 border-b border-border/50 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Link href="/project/agent">
              <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground hover:text-foreground">
                <LuArrowLeft className="size-4" />
                <span className="ml-1.5">{t("backHome")}</span>
              </Button>
            </Link>
            <div className="h-5 w-px bg-border/50" />
            <span className="flex items-center gap-2 text-sm font-semibold">
              <BrandWheatMark className="h-8 w-6 text-foreground" />
            </span>
          </div>
          <LanguageToggle />
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-6 py-10">
        <div className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">{t("pageTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">管理出镜人物、店铺视觉和水印偏好。</p>
        </div>

        <div className="mb-6 rounded-lg border border-primary/30 bg-primary/5 p-4">
          <div className="flex items-start gap-3">
            <LuShieldCheck className="mt-0.5 size-5 text-primary" />
            <div>
              <p className="text-sm font-medium">生成策略由工作人员统一维护</p>
              <p className="mt-1 text-xs text-muted-foreground">普通用户端只保留创作偏好，不展示模型服务的敏感连接信息。</p>
            </div>
          </div>
        </div>

        <Tabs defaultValue={0}>
          <TabsList className="mb-6">
            <TabsTrigger value={0}>
              <LuUser className="size-3.5" />
              {t("tabCharacters")}
            </TabsTrigger>
            <TabsTrigger value={1}>
              <LuPalette className="size-3.5" />
              {t("tabBrand")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value={0}>
            <CharacterManager />
          </TabsContent>
          <TabsContent value={1}>
            <BrandSettings />
          </TabsContent>
        </Tabs>

        <div className="mt-8 flex justify-end gap-3">
          {saved ? <span className="self-center text-sm text-emerald-400">{t("settingsSaved")}</span> : null}
          <Button onClick={handleSave} className="brand-gradient text-white">
            {t("saveSettings")}
          </Button>
        </div>
      </main>
    </div>
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
