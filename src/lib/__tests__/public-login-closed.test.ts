import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const workbenchSource = readFileSync(resolve(process.cwd(), "前端/创作工作台/page.tsx"), "utf8");

describe("public login availability", () => {
  it("does not persist or accept a browser-only user identity", () => {
    expect(workbenchSource).not.toContain("clipforge_user_session");
    expect(workbenchSource).not.toContain("saveUserSession");
    expect(workbenchSource).not.toContain("handleLoginSubmit");
    expect(workbenchSource).not.toContain("发送验证码");
    expect(workbenchSource).not.toContain('type="tel"');
  });

  it("explains that public login remains closed until a real provider is configured", () => {
    expect(workbenchSource).toContain("登录尚未开放");
    expect(workbenchSource).toContain("尚未配置真实登录服务");
  });
});
