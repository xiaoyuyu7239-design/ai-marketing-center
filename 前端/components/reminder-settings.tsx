"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LuBellRing, LuClock3, LuMessageCircle } from "react-icons/lu";
import { Badge } from "@frontend/components/ui/badge";
import { Button } from "@frontend/components/ui/button";
import { Card, CardContent } from "@frontend/components/ui/card";
import { Label } from "@frontend/components/ui/label";
import { Toggle } from "@frontend/components/ui/toggle";
import { useVideoApprovalStore } from "@frontend/stores/video-approval-store";

interface ReminderSettingsData {
  enabled: boolean;
  dailyTarget: number;
  wechatConfigured: boolean;
  bindingCount: number;
  windows: { start: number; end: number; label: string }[];
  windowSource: "calibrated" | "category";
  windowBasis: string;
  hint: string;
  inventory: { approvedUnpublished: number; publishedToday: number; remainingToday: number };
}

/** /api/wechat/bind 返回的绑定条目（该路由由并行分工实现，这里按契约防御性解析） */
interface WechatBinding {
  id: string;
  remark?: string | null;
  createdAt?: string | null;
}

function coerceBindings(value: unknown): WechatBinding[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .filter((item) => typeof item.id === "string")
    .map((item) => ({
      id: item.id as string,
      remark: typeof item.remark === "string" ? item.remark : null,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : null,
    }));
}

/** 二维码兜底有效期（秒）：服务端没回 expiresIn 时按微信带参临时码的 10 分钟算 */
const QR_FALLBACK_EXPIRES_SECONDS = 600;
/** 扫码后轮询绑定结果的间隔 */
const BIND_POLL_INTERVAL_MS = 3000;

// 设置页「发布提醒」Tab：提醒开关/每天几条 + 客人活跃时段展示 + 微信扫码绑定
export function ReminderSettings() {
  const setDailyPickCount = useVideoApprovalStore((state) => state.setDailyPickCount);

  const [data, setData] = useState<ReminderSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [needLogin, setNeedLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ===== 微信绑定区状态 =====
  const [bindings, setBindings] = useState<WechatBinding[]>([]);
  const [qrImageUrl, setQrImageUrl] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
  const [bindMessage, setBindMessage] = useState<string | null>(null);
  const pollTimerRef = useRef<number | null>(null);
  const expireTimerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (expireTimerRef.current !== null) {
      window.clearTimeout(expireTimerRef.current);
      expireTimerRef.current = null;
    }
  }, []);

  const loadBindings = useCallback(async (): Promise<WechatBinding[] | null> => {
    try {
      const res = await fetch("/api/wechat/bind", { cache: "no-store" });
      if (!res.ok) return null;
      const json = (await res.json().catch(() => ({}))) as { bindings?: unknown };
      const list = coerceBindings(json.bindings);
      setBindings(list);
      return list;
    } catch {
      return null;
    }
  }, []);

  // 进页面拉一次设置全貌；已开通微信时顺带拉绑定列表
  useEffect(() => {
    let ignore = false;
    fetch("/api/reminders/settings", { cache: "no-store" })
      .then(async (res) => {
        if (ignore) return;
        if (res.status === 401) {
          setNeedLogin(true);
          return;
        }
        if (!res.ok) {
          setError("设置没读出来，刷新一下再试试");
          return;
        }
        const json = (await res.json().catch(() => null)) as ReminderSettingsData | null;
        if (!ignore && json) {
          setData(json);
          if (json.wechatConfigured) void loadBindings();
        }
      })
      .catch(() => {
        if (!ignore) setError("网络不太顺，刷新一下再试试");
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [loadBindings]);

  // 离开页面时停掉轮询/过期定时器
  useEffect(() => stopPolling, [stopPolling]);

  const handleToggleEnabled = async (enabled: boolean) => {
    if (!data) return;
    const before = data.enabled;
    setData({ ...data, enabled });
    setError(null);
    try {
      const res = await fetch("/api/reminders/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        setData((d) => (d ? { ...d, enabled: before } : d));
        setError("没保存上，再点一次试试");
      }
    } catch {
      setData((d) => (d ? { ...d, enabled: before } : d));
      setError("网络不太顺，再点一次试试");
    }
  };

  const handleSetTarget = (count: number) => {
    setData((d) => (d ? { ...d, dailyTarget: count } : d));
    // store 的 setDailyPickCount 会同步写服务端，并让生成库存页的「数量」与这里始终一致
    setDailyPickCount(count);
  };

  const handleCreateQr = async () => {
    setQrLoading(true);
    setBindMessage(null);
    setError(null);
    stopPolling();
    try {
      const res = await fetch("/api/wechat/bind", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { qrImageUrl?: string; expiresIn?: number; error?: string };
      if (!res.ok || typeof json.qrImageUrl !== "string" || !json.qrImageUrl) {
        setError(typeof json.error === "string" && json.error ? json.error : "二维码没生成出来，稍后再试试");
        return;
      }
      setQrImageUrl(json.qrImageUrl);
      const baseline = bindings.length;

      // 每 3 秒问一次"绑上了没"，绑定数变多就是扫成功了
      pollTimerRef.current = window.setInterval(async () => {
        const list = await loadBindings();
        if (list && list.length > baseline) {
          stopPolling();
          setQrImageUrl(null);
          setBindMessage("绑定成功！到点会在微信上提醒你发视频");
          setData((d) => (d ? { ...d, bindingCount: list.length } : d));
        }
      }, BIND_POLL_INTERVAL_MS);

      // 二维码过期就收起来，让老板重新点一次
      const expiresIn = typeof json.expiresIn === "number" && json.expiresIn > 0 ? json.expiresIn : QR_FALLBACK_EXPIRES_SECONDS;
      expireTimerRef.current = window.setTimeout(() => {
        stopPolling();
        setQrImageUrl(null);
        setBindMessage("二维码过期了，点一下「扫码绑定」重新拿一张");
      }, expiresIn * 1000);
    } catch {
      setError("网络不太顺，稍后再试试");
    } finally {
      setQrLoading(false);
    }
  };

  const handleUnbind = async (id: string) => {
    setError(null);
    try {
      // 同时带 query 和 body，兼容 /api/wechat/bind 两种取参写法
      const res = await fetch(`/api/wechat/bind?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        setError("没解绑成功，再试一次");
        return;
      }
      setBindings((list) => {
        const next = list.filter((b) => b.id !== id);
        setData((d) => (d ? { ...d, bindingCount: next.length } : d));
        return next;
      });
      setBindMessage(null);
    } catch {
      setError("网络不太顺，再试一次");
    }
  };

  if (loading) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">正在读取提醒设置…</CardContent></Card>;
  }

  if (needLogin) {
    return (
      <Card>
        <CardContent className="p-6">
          <p className="text-sm font-medium">还没有登录</p>
          <p className="mt-1 text-xs text-muted-foreground">先在创作工作台登录商家账号，再回来设置发布提醒。</p>
          <Link href="/project/agent" className="mt-4 inline-block">
            <Button size="sm">去登录</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return <Card><CardContent className="p-6 text-sm text-muted-foreground">{error ?? "设置没读出来，刷新一下再试试"}</CardContent></Card>;
  }

  return (
    <div className="space-y-4">
      {/* a. 提醒开关 + 每天发几条 */}
      <Card>
        <CardContent className="space-y-5 p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="flex items-center gap-2 text-sm font-semibold">
                <LuBellRing className="size-4" />
                到点提醒我发视频
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                开着的话，到了你家客人最活跃的点，微信会提醒你：今天还差几条、先发哪条。
              </p>
            </div>
            <Toggle checked={data.enabled} onChange={handleToggleEnabled} />
          </div>

          <div>
            <Label>每天发几条</Label>
            <div className="mt-1.5 flex items-center gap-1.5">
              {[1, 2, 3, 4, 5].map((count) => (
                <button
                  key={count}
                  type="button"
                  onClick={() => handleSetTarget(count)}
                  className={`grid size-9 place-items-center rounded-lg border text-xs font-bold transition ${
                    data.dailyTarget === count
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-background text-muted-foreground hover:border-foreground/40"
                  }`}
                >
                  {count}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              今天已发 {data.inventory.publishedToday} 条，还差 {data.inventory.remainingToday} 条；库里备着 {data.inventory.approvedUnpublished} 条可以发。
            </p>
          </div>
        </CardContent>
      </Card>

      {/* b. 客人活跃时段 */}
      <Card>
        <CardContent className="space-y-3 p-6">
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex items-center gap-2 text-sm font-semibold">
              <LuClock3 className="size-4" />
              你家客人最活跃的时间
            </p>
            {data.windowSource === "calibrated" ? (
              <Badge>已按你家数据校准</Badge>
            ) : (
              <Badge variant="secondary">行业经验，数据攒够自动升级</Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {data.windows.map((w) => (
              <span
                key={`${w.start}-${w.end}`}
                className="rounded-lg border border-border bg-muted/40 px-2.5 py-1 text-xs font-bold"
              >
                {w.label}
              </span>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{data.windowBasis}</p>
        </CardContent>
      </Card>

      {/* c. 微信绑定 */}
      <Card>
        <CardContent className="space-y-4 p-6">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <LuMessageCircle className="size-4" />
            微信绑定
          </p>

          {!data.wechatConfigured ? (
            <p className="text-xs text-muted-foreground">
              微信提醒还没开通，请联系你的服务商配置好服务号后再来绑定。
            </p>
          ) : (
            <>
              <div className="flex items-center justify-between gap-4">
                <p className="text-xs text-muted-foreground">
                  已绑定 {bindings.length} 个微信，绑定的微信都会收到发布提醒（老板、店员都可以绑）。
                </p>
                <Button size="sm" onClick={handleCreateQr} disabled={qrLoading}>
                  {qrLoading ? "生成中…" : "扫码绑定"}
                </Button>
              </div>

              {qrImageUrl && (
                <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrImageUrl} alt="微信绑定二维码" className="size-44 rounded-md bg-white object-contain" />
                  <p className="text-xs text-muted-foreground">用微信扫一扫并关注，扫完自动绑定</p>
                </div>
              )}

              {bindMessage && <p className="text-xs font-semibold text-emerald-500">{bindMessage}</p>}

              {bindings.length > 0 && (
                <ul className="space-y-2">
                  {bindings.map((binding, index) => (
                    <li
                      key={binding.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
                    >
                      <span className="min-w-0 truncate text-xs font-medium">
                        {binding.remark || `微信 ${index + 1}`}
                        {binding.createdAt && (
                          <span className="ml-2 text-muted-foreground">
                            {new Date(binding.createdAt).toLocaleDateString()} 绑定
                          </span>
                        )}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="shrink-0 text-destructive hover:text-destructive"
                        onClick={() => handleUnbind(binding.id)}
                      >
                        解绑
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {error && <p className="text-xs font-semibold text-red-500">{error}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
