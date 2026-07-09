/** 分镜类型 → 展示信息（在多页面间重复定义，收拢到这里） */

export interface ShotTypeInfo {
  labelKey: string;
  /** Tailwind 颜色类，默认 "bg-muted text-muted-foreground" */
  color: string;
}

export const SHOT_TYPE_INFO: Record<string, ShotTypeInfo> = {
  hook:          { labelKey: "shotTypeHook",          color: "bg-muted text-muted-foreground" },
  pain_point:    { labelKey: "shotTypePainPoint",     color: "bg-muted text-muted-foreground" },
  product_reveal:{ labelKey: "shotTypeProductReveal", color: "bg-muted text-muted-foreground" },
  demo:          { labelKey: "shotTypeDemo",          color: "bg-muted text-muted-foreground" },
  social_proof:  { labelKey: "shotTypeSocialProof",   color: "bg-muted text-muted-foreground" },
  cta:           { labelKey: "shotTypeCta",           color: "bg-muted text-muted-foreground" },
};

/** 脚本风格 → i18n 词条 key */
export const STYLE_LABEL_KEYS: Record<string, string> = {
  pain_point: "stylePainPoint",
  scene:      "styleScene",
  comparison: "styleComparison",
  story:      "styleStory",
  auto:       "styleAuto",
};
