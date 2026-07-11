import { describe, expect, it } from "vitest";
import {
  assertSafeAuthRuntime,
  createDevelopmentIdentity,
  resolveDevelopmentIdentityConfig,
} from "@server/auth/identity-provider";

describe("identity-provider boundary", () => {
  it("keeps development identity injection disabled unless explicitly enabled", () => {
    expect(resolveDevelopmentIdentityConfig({ NODE_ENV: "development" })).toEqual({ enabled: false });
  });

  it("allows explicit development injection outside production", () => {
    const env = { NODE_ENV: "test", CLIPFORGE_DEV_AUTH_ENABLED: "1" } as NodeJS.ProcessEnv;
    expect(resolveDevelopmentIdentityConfig(env)).toEqual({ enabled: true });
    expect(createDevelopmentIdentity({
      providerSubject: "developer-1",
      contactType: "email",
      verifiedContact: "developer@example.test",
    }, env)).toMatchObject({ provider: "development", providerSubject: "developer-1" });
  });

  it("rejects development identity injection in production", () => {
    const env = { NODE_ENV: "production", CLIPFORGE_DEV_AUTH_ENABLED: "1" } as NodeJS.ProcessEnv;
    expect(() => assertSafeAuthRuntime(env)).toThrow("Development identity injection cannot be enabled in production");
    expect(() => createDevelopmentIdentity({
      providerSubject: "developer-1",
      contactType: "email",
      verifiedContact: "developer@example.test",
    }, env)).toThrow("Development identity injection cannot be enabled in production");
  });

  it("does not accept empty provider subjects or unverified contacts", () => {
    const env = { NODE_ENV: "development", CLIPFORGE_DEV_AUTH_ENABLED: "1" } as NodeJS.ProcessEnv;
    expect(() => createDevelopmentIdentity({
      providerSubject: " ",
      contactType: "email",
      verifiedContact: "developer@example.test",
    }, env)).toThrow("Development provider subject is required");
    expect(() => createDevelopmentIdentity({
      providerSubject: "developer-1",
      contactType: "email",
      verifiedContact: " ",
    }, env)).toThrow("Verified development contact is required");
  });
});
