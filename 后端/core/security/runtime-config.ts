import "server-only";

export type HuimaiDeploymentMode = "saas" | "desktop";

export function deploymentMode(): HuimaiDeploymentMode {
  const configured = process.env.HUIMAI_DEPLOYMENT_MODE?.trim().toLowerCase();
  if (configured === "saas" || configured === "desktop") return configured;
  if (configured) throw new Error("HUIMAI_DEPLOYMENT_MODE 只能是 saas 或 desktop");
  // 生产服务默认按公网 SaaS 收紧；开发/测试保留旧单机模式的兼容入口。
  if (process.env.NODE_ENV === "production") return "saas";
  return process.env.CLIPFORGE_SINGLE_USER === "1" ? "desktop" : "saas";
}

export function isDesktopDeployment(): boolean {
  return deploymentMode() === "desktop";
}

export function singleUserModeEnabled(): boolean {
  return isDesktopDeployment() && process.env.CLIPFORGE_SINGLE_USER === "1";
}

function hasListValue(value: string | undefined): boolean {
  return Boolean(value?.split(/[\n,;]/).some((item) => item.trim()));
}

/** 公网启动前的硬门禁；配置错误时必须阻止进程继续提供服务。 */
export function assertRuntimeConfiguration(): void {
  const mode = deploymentMode();
  const singleUser = process.env.CLIPFORGE_SINGLE_USER === "1";

  if (mode === "saas" && singleUser) {
    throw new Error("SaaS 部署禁止设置 CLIPFORGE_SINGLE_USER=1");
  }
  if (mode === "desktop" && process.env.NODE_ENV === "production" && !singleUser) {
    throw new Error("桌面部署必须显式设置 CLIPFORGE_SINGLE_USER=1");
  }

  if (mode !== "saas" || process.env.NODE_ENV !== "production") return;

  if (process.env.HUIMAI_PUBLIC_SIGNUP === "1" && process.env.HUIMAI_INVITE_ONLY === "1") {
    throw new Error("HUIMAI_PUBLIC_SIGNUP 与 HUIMAI_INVITE_ONLY 不能同时开启");
  }
  const emails = process.env.HUIMAI_INVITE_EMAILS || process.env.CLIPFORGE_INVITE_EMAILS;
  const codes = process.env.HUIMAI_INVITE_CODES || process.env.CLIPFORGE_INVITE_CODES;
  if (hasListValue(codes)) {
    throw new Error("邀请内测的生产环境禁止使用可重复邀请码；请配置 HUIMAI_INVITE_EMAILS 邮箱白名单");
  }
  if (process.env.HUIMAI_PUBLIC_SIGNUP !== "1" && !hasListValue(emails)) {
    throw new Error("邀请内测必须配置 HUIMAI_INVITE_EMAILS；如确需公开注册须显式设置 HUIMAI_PUBLIC_SIGNUP=1");
  }

  if (!process.env.HUIMAI_LEGAL_ENTITY?.trim()) {
    throw new Error("生产环境必须配置 HUIMAI_LEGAL_ENTITY 运营主体名称");
  }
  if (!process.env.HUIMAI_LEGAL_CONTACT?.trim()) {
    throw new Error("生产环境必须配置 HUIMAI_LEGAL_CONTACT 用户与隐私联系渠道");
  }
  const retentionDays = Number(process.env.HUIMAI_DATA_RETENTION_DAYS);
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) {
    throw new Error("生产环境必须配置 1-3650 之间的 HUIMAI_DATA_RETENTION_DAYS");
  }
  if (!process.env.HUIMAI_AI_PROVIDER_DISCLOSURE?.trim()) {
    throw new Error("生产环境必须配置 HUIMAI_AI_PROVIDER_DISCLOSURE，披露实际启用的模型服务商");
  }
  if (!process.env.HUIMAI_AIGC_SERVICE_PROVIDER?.trim()) {
    throw new Error("生产环境必须配置 HUIMAI_AIGC_SERVICE_PROVIDER，用于成片隐式标识中的服务提供者名称或编码");
  }
}
