import type { Metadata } from "next";
import { AdminLogin } from "@frontend/components/admin/admin-login";
import { AdminShell } from "@frontend/components/admin/admin-shell";
import { isAdminSession, isDefaultAdminPassword } from "@server/admin/admin-auth";

export const metadata: Metadata = {
  title: "工作人员后台 | 绘卖AI",
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const authed = await isAdminSession();

  if (!authed) {
    return <AdminLogin defaultPassword={isDefaultAdminPassword()} />;
  }

  return <AdminShell>{children}</AdminShell>;
}
