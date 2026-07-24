import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertRuntimeConfiguration } from "@backend/core/security/runtime-config";

const ENV_KEYS = [
  "NODE_ENV",
  "HUIMAI_DEPLOYMENT_MODE",
  "CLIPFORGE_SINGLE_USER",
  "HUIMAI_PUBLIC_SIGNUP",
  "HUIMAI_INVITE_ONLY",
  "HUIMAI_INVITE_EMAILS",
  "CLIPFORGE_INVITE_EMAILS",
  "HUIMAI_INVITE_CODES",
  "CLIPFORGE_INVITE_CODES",
  "HUIMAI_LEGAL_ENTITY",
  "HUIMAI_LEGAL_CONTACT",
  "HUIMAI_DATA_RETENTION_DAYS",
  "HUIMAI_AI_PROVIDER_DISCLOSURE",
  "HUIMAI_AIGC_SERVICE_PROVIDER",
] as const;

let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

function productionSaasEnv() {
  Reflect.set(process.env, "NODE_ENV", "production");
  process.env.HUIMAI_DEPLOYMENT_MODE = "saas";
  process.env.HUIMAI_LEGAL_ENTITY = "测试运营主体";
  process.env.HUIMAI_LEGAL_CONTACT = "privacy@test.example";
  process.env.HUIMAI_DATA_RETENTION_DAYS = "30";
  process.env.HUIMAI_AI_PROVIDER_DISCLOSURE = "测试模型服务商";
  process.env.HUIMAI_AIGC_SERVICE_PROVIDER = "测试运营主体";
}

beforeEach(() => {
  originalEnv = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else Reflect.set(process.env, key, value);
  }
});

describe("SaaS 运行时安全门禁", () => {
  it("拒绝 saas 与 CLIPFORGE_SINGLE_USER=1 同时启用", () => {
    productionSaasEnv();
    process.env.CLIPFORGE_SINGLE_USER = "1";
    process.env.HUIMAI_INVITE_EMAILS = "allowed@example.com";

    expect(() => assertRuntimeConfiguration()).toThrow(/SaaS.*CLIPFORGE_SINGLE_USER=1/);
  });

  it("生产邀请内测未配置邮箱白名单时 fail-closed", () => {
    productionSaasEnv();

    expect(() => assertRuntimeConfiguration()).toThrow(/必须配置 HUIMAI_INVITE_EMAILS/);
  });

  it.each(["HUIMAI_INVITE_CODES", "CLIPFORGE_INVITE_CODES"] as const)(
    "生产邀请内测拒绝可重复邀请码配置 %s",
    (key) => {
      productionSaasEnv();
      process.env.HUIMAI_INVITE_EMAILS = "allowed@example.com";
      process.env[key] = "reusable-beta-code";

      expect(() => assertRuntimeConfiguration()).toThrow(/禁止使用可重复邀请码/);
    }
  );

  it("生产 SaaS 配置邮箱白名单后可以通过邀请门禁", () => {
    productionSaasEnv();
    process.env.HUIMAI_INVITE_EMAILS = "allowed@example.com";

    expect(() => assertRuntimeConfiguration()).not.toThrow();
  });

  it("生产环境缺少 AIGC 服务提供者标识时拒绝启动", () => {
    productionSaasEnv();
    process.env.HUIMAI_INVITE_EMAILS = "allowed@example.com";
    delete process.env.HUIMAI_AIGC_SERVICE_PROVIDER;

    expect(() => assertRuntimeConfiguration()).toThrow(/HUIMAI_AIGC_SERVICE_PROVIDER/);
  });
});
