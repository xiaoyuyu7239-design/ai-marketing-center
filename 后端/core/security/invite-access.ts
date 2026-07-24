import "server-only";

import { createHash, timingSafeEqual } from "crypto";

function splitList(value: string | undefined): string[] {
  return (value || "")
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function configuredEmails(): Set<string> {
  return new Set(
    splitList(process.env.HUIMAI_INVITE_EMAILS || process.env.CLIPFORGE_INVITE_EMAILS).map((email) =>
      email.toLowerCase()
    )
  );
}

function configuredCodeHashes(): Buffer[] {
  return splitList(process.env.HUIMAI_INVITE_CODES || process.env.CLIPFORGE_INVITE_CODES).map((code) =>
    createHash("sha256").update(code).digest()
  );
}

/**
 * 公网生产默认关闭自由注册。只有显式设置 HUIMAI_PUBLIC_SIGNUP=1 才会开放；
 * 开发/测试环境可通过 HUIMAI_INVITE_ONLY=1 复现邀请制流程。
 */
export function isInviteOnlyRegistration(): boolean {
  if (process.env.HUIMAI_PUBLIC_SIGNUP === "1") return false;
  if (process.env.HUIMAI_INVITE_ONLY === "1") return true;
  if (configuredEmails().size > 0 || configuredCodeHashes().length > 0) return true;
  return process.env.NODE_ENV === "production";
}

export function inviteRegistrationConfigured(): boolean {
  return configuredEmails().size > 0 || configuredCodeHashes().length > 0;
}

function matchesInviteCode(inviteCode: string): boolean {
  if (!inviteCode) return false;
  const incoming = createHash("sha256").update(inviteCode.trim()).digest();
  return configuredCodeHashes().some(
    (expected) => expected.length === incoming.length && timingSafeEqual(expected, incoming)
  );
}

export type InviteAccessResult =
  | { allowed: true; source: "public" | "email" | "code" }
  | { allowed: false; reason: "not-configured" | "not-invited" };

export function verifyInviteAccess(email: string, inviteCode: string): InviteAccessResult {
  if (!isInviteOnlyRegistration()) return { allowed: true, source: "public" };
  if (!inviteRegistrationConfigured()) return { allowed: false, reason: "not-configured" };
  if (configuredEmails().has(email.trim().toLowerCase())) return { allowed: true, source: "email" };
  if (matchesInviteCode(inviteCode)) return { allowed: true, source: "code" };
  return { allowed: false, reason: "not-invited" };
}
