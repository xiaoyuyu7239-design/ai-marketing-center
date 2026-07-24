import "server-only";

import { createHash } from "crypto";
import { isIP } from "node:net";
import { NextResponse, type NextRequest } from "next/server";

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

export interface ExpensiveRouteRateLimitOptions {
  /** 单个商户在突发窗口内可发起的请求数。 */
  merchantBurst: number;
  /** 同一来源 IP 在突发窗口内可发起的请求数。 */
  ipBurst: number;
  /** 单个商户在持续窗口内可发起的请求数。 */
  merchantSustained: number;
  /** 同一来源 IP 在持续窗口内可发起的请求数。 */
  ipSustained: number;
  burstWindowMs?: number;
  sustainedWindowMs?: number;
}

export interface AuthenticatedIpRateLimitOptions {
  burst: number;
  sustained: number;
  burstWindowMs?: number;
  sustainedWindowMs?: number;
}

export const EXPENSIVE_RATE_LIMIT_PRESETS = {
  // 邀测商户可能有 10 家共享同一门店/园区 NAT；成本控制以 merchant 桶为主，
  // 所有 IP 桶至少容纳 10 个合法商户的完整额度，只拦截明显异常聚合流量。
  llm: { merchantBurst: 6, ipBurst: 60, merchantSustained: 30, ipSustained: 300 },
  auxiliaryModel: { merchantBurst: 10, ipBurst: 100, merchantSustained: 60, ipSustained: 600 },
  image: { merchantBurst: 12, ipBurst: 120, merchantSustained: 40, ipSustained: 400 },
  // 正常批量链路一次最多提交 9 镜，额外保留 3 次有限重试空间。
  video: { merchantBurst: 12, ipBurst: 120, merchantSustained: 15, ipSustained: 150 },
  compose: { merchantBurst: 5, ipBurst: 50, merchantSustained: 20, ipSustained: 200 },
  cpu: { merchantBurst: 4, ipBurst: 40, merchantSustained: 20, ipSustained: 200 },
} as const satisfies Record<string, ExpensiveRouteRateLimitOptions>;

export const AUTHENTICATED_IP_RATE_LIMIT_PRESETS = {
  providerProbe: { burst: 10, sustained: 60 },
  paidTtsPreview: { burst: 6, sustained: 30 },
} as const satisfies Record<string, AuthenticatedIpRateLimitOptions>;

const globalForRateLimit = globalThis as typeof globalThis & {
  __huimaiRateLimitBuckets?: Map<string, RateLimitBucket>;
};

const buckets = globalForRateLimit.__huimaiRateLimitBuckets ?? new Map<string, RateLimitBucket>();
globalForRateLimit.__huimaiRateLimitBuckets = buckets;

function compactExpired(now: number) {
  if (buckets.size < 2_000) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function consumeRateLimit(key: string, options: RateLimitOptions): RateLimitResult {
  const now = Date.now();
  if (process.env.NODE_ENV === "test" && process.env.HUIMAI_RATE_LIMIT_TESTS !== "1") {
    return {
      allowed: true,
      remaining: options.limit,
      resetAt: now + options.windowMs,
      retryAfterSeconds: 0,
    };
  }
  compactExpired(now);
  const hashedKey = createHash("sha256").update(key).digest("hex");
  const current = buckets.get(hashedKey);
  const bucket = !current || current.resetAt <= now ? { count: 0, resetAt: now + options.windowMs } : current;
  bucket.count += 1;
  buckets.set(hashedKey, bucket);

  const allowed = bucket.count <= options.limit;
  return {
    allowed,
    remaining: Math.max(0, options.limit - bucket.count),
    resetAt: bucket.resetAt,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000)),
  };
}

export function requestClientIp(req: NextRequest): string {
  // HTTP 转发头全部可由客户端伪造。只有部署明确声明“应用仅能被受信反代访问”时，
  // 才读取反代覆盖写入的单一 X-Real-IP；永不信任客户端可追加的 XFF/CF 头。
  if (process.env.HUIMAI_TRUST_PROXY !== "1") return "untrusted-proxy";
  const configuredHeader = (process.env.HUIMAI_CLIENT_IP_HEADER || "x-real-ip").trim().toLowerCase();
  if (configuredHeader !== "x-real-ip") return "invalid-proxy-config";
  const candidate = req.headers.get("x-real-ip")?.trim() || "";
  return isIP(candidate) ? candidate.toLowerCase() : "unknown";
}

function combineRateLimitResults(results: readonly RateLimitResult[]): RateLimitResult {
  const denied = results.filter((result) => !result.allowed);
  if (denied.length > 0) {
    return denied.reduce((strictest, result) =>
      result.retryAfterSeconds > strictest.retryAfterSeconds ? result : strictest
    );
  }
  return {
    allowed: true,
    remaining: Math.min(...results.map((result) => result.remaining)),
    resetAt: Math.max(...results.map((result) => result.resetAt)),
    retryAfterSeconds: 0,
  };
}

/**
 * 模型、付费和高 CPU HTTP 入口的统一双维度门禁。
 *
 * 同时限制商户与来源 IP，并同时保留分钟突发和小时持续窗口。商户额度、供应商
 * 队列和任务幂等都不能替代这里的请求速率限制。当前邀请内测是单实例部署，桶与
 * 其它进程内安全门禁一致；扩展到多实例前应把状态迁移到共享存储。
 */
export function consumeExpensiveRouteRateLimit(
  req: NextRequest,
  merchantId: string,
  scope: string,
  options: ExpensiveRouteRateLimitOptions,
): RateLimitResult {
  const burstWindowMs = options.burstWindowMs ?? 60_000;
  const sustainedWindowMs = options.sustainedWindowMs ?? 60 * 60_000;
  const ip = requestClientIp(req);
  return combineRateLimitResults([
    consumeRateLimit(`expensive:${scope}:merchant:${merchantId}:burst`, {
      limit: options.merchantBurst,
      windowMs: burstWindowMs,
    }),
    consumeRateLimit(`expensive:${scope}:ip:${ip}:burst`, {
      limit: options.ipBurst,
      windowMs: burstWindowMs,
    }),
    consumeRateLimit(`expensive:${scope}:merchant:${merchantId}:sustained`, {
      limit: options.merchantSustained,
      windowMs: sustainedWindowMs,
    }),
    consumeRateLimit(`expensive:${scope}:ip:${ip}:sustained`, {
      limit: options.ipSustained,
      windowMs: sustainedWindowMs,
    }),
  ]);
}

/** 已通过后台/桌面鉴权、但没有商户身份的旧控制面入口使用 IP 双窗口限制。 */
export function consumeAuthenticatedIpRateLimit(
  req: NextRequest,
  scope: string,
  options: AuthenticatedIpRateLimitOptions,
): RateLimitResult {
  const ip = requestClientIp(req);
  return combineRateLimitResults([
    consumeRateLimit(`authenticated:${scope}:ip:${ip}:burst`, {
      limit: options.burst,
      windowMs: options.burstWindowMs ?? 60_000,
    }),
    consumeRateLimit(`authenticated:${scope}:ip:${ip}:sustained`, {
      limit: options.sustained,
      windowMs: options.sustainedWindowMs ?? 60 * 60_000,
    }),
  ]);
}

export function rateLimitResponse(result: RateLimitResult, message = "请求过于频繁，请稍后再试") {
  return NextResponse.json(
    { error: message },
    {
      status: 429,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(result.retryAfterSeconds),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1_000)),
      },
    }
  );
}

export function resetRateLimitsForTests() {
  if (process.env.NODE_ENV === "test") buckets.clear();
}
