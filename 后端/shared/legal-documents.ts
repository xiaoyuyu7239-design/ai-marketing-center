export const LEGAL_EFFECTIVE_DATE = "2026-07-16";

export const LEGAL_DOCUMENTS = {
  terms: {
    slug: "terms",
    title: "用户服务协议",
    version: "terms-2026-07-16-v1",
  },
  privacy: {
    slug: "privacy",
    title: "隐私政策",
    version: "privacy-2026-07-16-v1",
  },
  aiNotice: {
    slug: "ai-notice",
    title: "AI 功能使用须知",
    version: "ai-notice-2026-07-16-v1",
  },
} as const;

export type LegalDocumentSlug = (typeof LEGAL_DOCUMENTS)[keyof typeof LEGAL_DOCUMENTS]["slug"];

export const CURRENT_LEGAL_CONSENT = {
  termsVersion: LEGAL_DOCUMENTS.terms.version,
  privacyVersion: LEGAL_DOCUMENTS.privacy.version,
  aiNoticeVersion: LEGAL_DOCUMENTS.aiNotice.version,
} as const;

export function isCurrentLegalConsent(value: unknown): value is {
  accepted: true;
  termsVersion: string;
  privacyVersion: string;
  aiNoticeVersion: string;
} {
  if (!value || typeof value !== "object") return false;
  const consent = value as Record<string, unknown>;
  return consent.accepted === true
    && consent.termsVersion === CURRENT_LEGAL_CONSENT.termsVersion
    && consent.privacyVersion === CURRENT_LEGAL_CONSENT.privacyVersion
    && consent.aiNoticeVersion === CURRENT_LEGAL_CONSENT.aiNoticeVersion;
}
