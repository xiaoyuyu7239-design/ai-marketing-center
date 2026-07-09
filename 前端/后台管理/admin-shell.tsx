"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Activity,
  Bot,
  ClipboardList,
  FileText,
  Gauge,
  LogOut,
  Sparkles,
} from "lucide-react";
import { Button } from "@frontend/components/ui/button";
import { cn } from "@backend/shared/utils";

const nav = [
  { href: "/admin", label: "系统状态", icon: Gauge },
  { href: "/admin/agents", label: "Agent 配置", icon: Bot },
  { href: "/admin/prompts", label: "提示词管理", icon: FileText },
  { href: "/admin/model-evals", label: "模型评测", icon: Sparkles },
  { href: "/admin/runs", label: "生成记录", icon: ClipboardList },
];

export function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  const logout = async () => {
    await fetch("/api/admin/auth", { method: "DELETE" });
    router.refresh();
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 hidden w-64 border-r border-border bg-card/70 p-4 lg:flex lg:flex-col">
        <Link href="/admin" className="mb-6 flex items-center gap-3 px-2">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Activity className="size-4" />
          </div>
          <div>
            <p className="text-sm font-semibold">工作人员后台</p>
            <p className="text-xs text-muted-foreground">模型策略运营台</p>
          </div>
        </Link>
        <nav className="space-y-1">
          {nav.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/admin" ? pathname === item.href : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex h-9 items-center gap-2 rounded-md px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  active && "bg-primary/12 text-primary",
                )}
              >
                <Icon className="size-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="mt-auto space-y-2">
          <Link href="/" className="block rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">
            返回用户端
          </Link>
          <Button variant="outline" className="w-full justify-start" onClick={logout}>
            <LogOut className="size-4" />
            退出后台
          </Button>
        </div>
      </aside>

      <header className="sticky top-0 z-30 border-b border-border bg-background/90 px-4 py-3 backdrop-blur lg:hidden">
        <div className="flex items-center justify-between">
          <Link href="/admin" className="font-semibold">工作人员后台</Link>
          <Button variant="ghost" size="icon-sm" onClick={logout} aria-label="退出后台">
            <LogOut className="size-4" />
          </Button>
        </div>
        <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground">
              {item.label}
            </Link>
          ))}
        </div>
      </header>

      <main className="lg:pl-64">
        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </div>
      </main>
    </div>
  );
}
