import type { MediaCredit } from "./media-credit-types";

export interface CreditAssetInput {
  type?: string | null;
  provider?: string | null;
  author?: string | null;
  license?: string | null;
  sourceUrl?: string | null;
  licenseUrl?: string | null;
  attributionText?: string | null;
  requiresAttribution?: boolean | null;
}

export interface CreditBgmInput {
  provider?: string | null;
  author?: string | null;
  license?: string | null;
  sourceUrl?: string | null;
  licenseUrl?: string | null;
  attributionText?: string | null;
  requiresAttribution?: boolean | null;
}

function normalized(value: string | null | undefined): string {
  return value?.trim() || "";
}

export function licenseRequiresAttribution(
  license: string | null | undefined,
  explicit?: boolean | null
): boolean {
  if (typeof explicit === "boolean") return explicit;
  const value = normalized(license).toLowerCase().replace(/[_\s]+/g, "-");
  if (!value) return true;
  if (/cc0|public-domain|publicdomain|pdm/.test(value)) return false;
  return /cc-?by|by-sa|attribution/.test(value);
}

function toCredit(
  mediaType: MediaCredit["mediaType"],
  input: CreditAssetInput | CreditBgmInput
): MediaCredit | null {
  const sourceUrl = normalized(input.sourceUrl);
  if (!sourceUrl) return null;
  const author = normalized(input.author) || "作者未注明";
  const license = normalized(input.license) || "许可未注明";
  const attributionText = normalized(input.attributionText) || `${author}｜${license}｜${sourceUrl}`;
  return {
    mediaType,
    provider: normalized(input.provider) || null,
    author,
    license,
    sourceUrl,
    licenseUrl: normalized(input.licenseUrl) || null,
    attributionText,
    requiresAttribution: licenseRequiresAttribution(input.license, input.requiresAttribution),
    licenseVerified: Boolean(normalized(input.license)),
  };
}

/** 按本次实际使用的画面和配乐生成不可变 credits 快照，并按来源页去重。 */
export function buildMediaCredits(input: {
  assets?: readonly CreditAssetInput[];
  bgm?: CreditBgmInput | null;
}): MediaCredit[] {
  const candidates: MediaCredit[] = [];
  for (const asset of input.assets || []) {
    if (asset.type !== "stock_footage") continue;
    const credit = toCredit("visual", asset);
    if (credit) candidates.push(credit);
  }
  if (input.bgm) {
    const credit = toCredit("audio", input.bgm);
    if (credit) candidates.push(credit);
  }
  const unique = new Map<string, MediaCredit>();
  for (const credit of candidates) {
    if (!unique.has(credit.sourceUrl)) unique.set(credit.sourceUrl, credit);
  }
  return [...unique.values()];
}

export function requiredAttributionText(credits: readonly MediaCredit[]): string {
  return credits
    .filter((credit) => credit.requiresAttribution)
    .map((credit) => credit.attributionText)
    .filter(Boolean)
    .join("\n");
}

/**
 * 第三方 stock/BGM 没有可核验许可时不能静默进入成片。
 * 用户自己上传的素材不在 credits 中，其授权责任由上传确认与协议承接。
 */
export function assertMediaCreditsVerified(credits: readonly MediaCredit[]): void {
  const unverified = credits.filter((credit) => !credit.licenseVerified);
  if (unverified.length === 0) return;
  const providers = [...new Set(unverified.map((credit) => credit.provider || "未知来源"))].join("、");
  throw new Error(`发现许可信息不完整的第三方素材（${providers}），请更换素材或补充可核验许可后再合成`);
}
