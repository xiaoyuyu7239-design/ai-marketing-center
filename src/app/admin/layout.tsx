import type { Metadata } from "next";
import { AdminLogin } from "@frontend/components/admin/admin-login";
import { AdminShell } from "@frontend/components/admin/admin-shell";
import {
  adminAuthConfigurationError,
  isAdminSession,
  isDefaultAdminPassword,
} from "@server/admin/admin-auth";

export const metadata: Metadata = {
  title: "工作人员后台 | ClipForge",
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const configurationError = adminAuthConfigurationError();
  if (configurationError) {
    return <AdminLogin defaultPassword={false} configurationError={configurationError} />;
  }

  const authed = await isAdminSession();

  if (!authed) {
    return <AdminLogin defaultPassword={isDefaultAdminPassword()} />;
  }

  return <AdminShell>{children}</AdminShell>;
}
