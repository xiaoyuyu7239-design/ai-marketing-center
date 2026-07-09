export interface ShopLinkOpts {
  platform?: string;
  affiliateCode?: string;
  campaign?: string;
}

export function buildShopLink(shopUrl: string | null | undefined, opts: ShopLinkOpts = {}): string {
  const raw = (shopUrl || "").trim();
  if (!raw) return "";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return "";

  const platform = (opts.platform || "").trim().toLowerCase();
  if (platform) url.searchParams.set("utm_source", platform);
  url.searchParams.set("utm_medium", "short_video");
  url.searchParams.set("utm_campaign", (opts.campaign || "").trim() || "clipforge");

  const affiliateCode = (opts.affiliateCode || "").trim();
  if (affiliateCode) url.searchParams.set("aff", affiliateCode);

  return url.toString();
}
