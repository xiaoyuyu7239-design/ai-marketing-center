"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { LockKeyhole, LogIn } from "lucide-react";
import { Button } from "@frontend/components/ui/button";
import { Input } from "@frontend/components/ui/input";

export function AdminLogin({ defaultPassword }: { defaultPassword: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const login = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError("");
    const res = await fetch("/api/admin/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) {
      setError(data.error || "登录失败");
      return;
    }
    router.refresh();
  };

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <LockKeyhole className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">工作人员后台</h1>
            <p className="text-sm text-muted-foreground">请输入管理员口令继续</p>
          </div>
        </div>

        <form onSubmit={login} className="rounded-lg border border-border bg-card p-5 shadow-sm">
          <label className="text-xs text-muted-foreground" htmlFor="admin-password">
            管理员口令
          </label>
          <Input
            id="admin-password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="mt-1.5"
            autoFocus
          />
          {defaultPassword ? (
            <p className="mt-2 text-xs text-amber-400">
              当前未设置环境变量，开发默认口令为 clipforge-admin。
            </p>
          ) : null}
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
          <Button className="mt-4 w-full" disabled={!password.trim() || loading}>
            <LogIn className="size-4" />
            {loading ? "验证中" : "进入后台"}
          </Button>
        </form>
      </div>
    </main>
  );
}
