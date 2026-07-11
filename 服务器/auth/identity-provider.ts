import "server-only";

import type { ContactType } from "./model";

export type VerifiedExternalIdentity = {
  provider: string;
  providerSubject: string;
  contactType: ContactType;
  verifiedContact: string;
};

export interface IdentityProviderAdapter<TCredential> {
  readonly provider: string;
  verify(credential: TCredential): Promise<VerifiedExternalIdentity>;
}

export function resolveDevelopmentIdentityConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "production" && env.CLIPFORGE_DEV_AUTH_ENABLED === "1") {
    throw new Error("Development identity injection cannot be enabled in production");
  }
  return { enabled: env.NODE_ENV !== "production" && env.CLIPFORGE_DEV_AUTH_ENABLED === "1" };
}

export function assertSafeAuthRuntime(env: NodeJS.ProcessEnv = process.env) {
  resolveDevelopmentIdentityConfig(env);
}

export function createDevelopmentIdentity(
  input: Omit<VerifiedExternalIdentity, "provider">,
  env: NodeJS.ProcessEnv = process.env,
): VerifiedExternalIdentity {
  if (!resolveDevelopmentIdentityConfig(env).enabled) {
    throw new Error("Development identity injection is disabled");
  }
  const providerSubject = input.providerSubject.trim();
  const verifiedContact = input.verifiedContact.trim();
  if (!providerSubject) throw new Error("Development provider subject is required");
  if (!verifiedContact) throw new Error("Verified development contact is required");
  return { provider: "development", providerSubject, contactType: input.contactType, verifiedContact };
}
