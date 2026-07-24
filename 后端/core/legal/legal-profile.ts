import "server-only";

export interface LegalProfile {
  brandName: string;
  entityName: string;
  contact: string;
  retentionDays: number;
  aiProviderDisclosure: string;
}

export function getLegalProfile(): LegalProfile {
  const retention = Number(process.env.HUIMAI_DATA_RETENTION_DAYS || 30);
  return {
    brandName: process.env.HUIMAI_BRAND_NAME?.trim() || "绘卖AI",
    entityName: process.env.HUIMAI_LEGAL_ENTITY?.trim() || "绘卖AI 产品团队（开发环境）",
    contact: process.env.HUIMAI_LEGAL_CONTACT?.trim() || "support@example.invalid",
    retentionDays: Number.isInteger(retention) && retention > 0 ? retention : 30,
    aiProviderDisclosure:
      process.env.HUIMAI_AI_PROVIDER_DISCLOSURE?.trim()
      || "产品运行环境中由工作人员启用并在本须知披露的模型服务商",
  };
}
