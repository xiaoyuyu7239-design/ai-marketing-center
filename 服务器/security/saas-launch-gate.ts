export type SaasLaunchGateInput = {
  nodeEnv: string | undefined;
  pathname: string;
};

export function shouldBlockSaasApi({ nodeEnv, pathname }: SaasLaunchGateInput) {
  if (nodeEnv !== "production") return false;
  if (!pathname.startsWith("/api/")) return false;
  return !pathname.startsWith("/api/admin/");
}
