export interface MediaCredit {
  mediaType: "visual" | "audio";
  provider: string | null;
  author: string;
  license: string;
  sourceUrl: string;
  licenseUrl: string | null;
  attributionText: string;
  requiresAttribution: boolean;
  licenseVerified: boolean;
}
