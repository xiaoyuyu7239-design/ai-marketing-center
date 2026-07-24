/**
 * SSRF 防护 —— 用户可控 URL（商品链接 ingest、抓取页里的 og:image）在服务端被 fetch 前必须过这里，
 * 否则可被构造成 http://169.254.169.254/（云元数据）、http://127.0.0.1:6379/（内网服务）等打内网。
 * 做法：校验协议 + DNS 解析主机的所有 IP 都不在私网/回环/链路本地/保留段；并手动跟随重定向、每一跳都重校验。
 */
import { Resolver } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import net from "net";

const DNS_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_DNS_LOOKUPS = 32;
const MAX_PINNED_REQUEST_BYTES = 10 * 1024 * 1024;
const MAX_CONFIGURED_DNS_SERVERS = 4;
let activeDnsLookups = 0;

/**
 * Clash/Surge 等 Fake-IP 代理会把公网域名解析到 198.18.0.0/15，SSRF 校验必须继续拒绝该保留段。
 * 本地预览可显式指定可信 DNS，取得并校验真实公网地址；生产默认仍使用系统 DNS。
 */
function configuredDnsServers(): string[] {
  const raw = (process.env.HUIMAI_SAFE_DNS_SERVERS || "").trim();
  if (!raw) return [];
  const servers = raw.split(",").map((item) => item.trim()).filter(Boolean);
  if (servers.length > MAX_CONFIGURED_DNS_SERVERS || servers.some((server) => net.isIP(server) === 0)) {
    throw new Error("HUIMAI_SAFE_DNS_SERVERS 仅支持最多 4 个逗号分隔的 DNS IP 地址");
  }
  return servers;
}

function ipv6Words(ip: string): number[] | null {
  if (ip.includes("%")) return null;
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return null;

  const parseHalf = (value: string): number[] | null => {
    if (!value) return [];
    const tokens = value.split(":");
    const result: number[] = [];
    for (const token of tokens) {
      if (token.includes(".")) {
        if (token !== tokens.at(-1) || !net.isIPv4(token)) return null;
        const bytes = token.split(".").map(Number);
        result.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
      result.push(Number.parseInt(token, 16));
    }
    return result;
  };

  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array.from({ length: missing }, () => 0), ...right];
}

function embeddedIpv4(high: number, low: number): string {
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

/** 判断 IP 是否落在禁止访问的私网/回环/链路本地/保留段（IPv4 + IPv6）。纯函数可单测。 */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
    if (p[0] === 0) return true; // 0.0.0.0/8 当前网络
    if (p[0] === 10) return true; // 10/8 私网
    if (p[0] === 127) return true; // 127/8 回环
    if (p[0] === 169 && p[1] === 254) return true; // 169.254/16 链路本地 + 云元数据
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true; // 172.16/12 私网
    if (p[0] === 192 && p[1] === 168) return true; // 192.168/16 私网
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // 100.64/10 CGNAT
    if (p[0] === 192 && p[1] === 0 && p[2] === 0) return true; // 192.0.0/24 IETF 协议分配
    if (p[0] === 192 && p[1] === 0 && p[2] === 2) return true; // TEST-NET-1
    if (p[0] === 192 && p[1] === 88 && p[2] === 99) return true; // 已废弃 6to4 relay
    if (p[0] === 198 && p[1] === 51 && p[2] === 100) return true; // TEST-NET-2
    if (p[0] === 203 && p[1] === 0 && p[2] === 113) return true; // TEST-NET-3
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return true; // 198.18/15 基准测试/常见透明代理内部段
    if (p[0] >= 224) return true; // 224+ 组播/保留
    return false;
  }
  if (net.isIPv6(ip)) {
    const words = ipv6Words(ip);
    if (!words) return true;
    const allZeroBeforeLast = words.slice(0, 7).every((value) => value === 0);
    if (words.every((value) => value === 0) || (allZeroBeforeLast && words[7] === 1)) return true;

    // IPv4-compatible / IPv4-mapped（含 URL 规范化后的 ::ffff:7f00:1）。
    if (words.slice(0, 6).every((value) => value === 0)) {
      return isBlockedIp(embeddedIpv4(words[6], words[7]));
    }
    if (words.slice(0, 5).every((value) => value === 0) && words[5] === 0xffff) {
      return isBlockedIp(embeddedIpv4(words[6], words[7]));
    }
    // NAT64 well-known / local-use 前缀与 6to4 内嵌 IPv4。
    if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((value) => value === 0)) {
      return isBlockedIp(embeddedIpv4(words[6], words[7]));
    }
    if (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1) return true;
    if (words[0] === 0x2002) return isBlockedIp(embeddedIpv4(words[1], words[2]));

    if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 链路本地
    if ((words[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 已废弃 site-local
    if ((words[0] & 0xff00) === 0xff00) return true; // ff00::/8 组播
    if ((words[0] & 0xe000) !== 0x2000) return true; // 当前全球单播分配范围外
    if (words[0] === 0x2001 && words[1] === 0) return true; // Teredo
    if (words[0] === 0x2001 && words[1] === 2) return true; // 基准测试
    if (words[0] === 0x2001 && words[1] === 0x0db8) return true; // 文档前缀
    if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x10) return true; // ORCHID
    if (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x20) return true; // ORCHIDv2
    if (words[0] === 0x3fff && (words[1] & 0xf000) === 0) return true; // 文档前缀 3fff::/20
    return false;
  }
  return true; // 非法 IP 一律拦
}

interface PublicUrlResolution {
  parsed: URL;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

function signalError(signal: AbortSignal) {
  return signal.reason instanceof Error ? signal.reason : new Error("请求已取消");
}

async function resolveHostname(host: string, signal: AbortSignal) {
  if (signal.aborted) throw signalError(signal);
  if (activeDnsLookups >= MAX_CONCURRENT_DNS_LOOKUPS) throw new Error("DNS 解析并发已达上限，请稍后重试");
  activeDnsLookups += 1;
  const resolver = new Resolver();
  const dnsServers = configuredDnsServers();
  if (dnsServers.length > 0) resolver.setServers(dnsServers);
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    if (signal.aborted) throw signalError(signal);
    const addresses: PublicUrlResolution["addresses"] = [];
    if (v4.status === "fulfilled") addresses.push(...v4.value.map((address) => ({ address, family: 4 as const })));
    if (v6.status === "fulfilled") addresses.push(...v6.value.map((address) => ({ address, family: 6 as const })));
    return addresses;
  } finally {
    signal.removeEventListener("abort", cancel);
    activeDnsLookups -= 1;
  }
}

async function resolvePublicUrl(rawUrl: string, suppliedSignal?: AbortSignal): Promise<PublicUrlResolution> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error("非法 URL");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("仅支持 http/https");
  if (u.username || u.password) throw new Error("URL 不得包含用户名或密码");
  // 去掉 IPv6 字面量的方括号（new URL 的 hostname 对 [::1] 会保留括号 → net.isIP 失败误走 DNS）
  const host = u.hostname.replace(/^\[/, "").replace(/\]$/, "");
  let addresses: PublicUrlResolution["addresses"];
  if (net.isIP(host)) {
    addresses = [{ address: host, family: net.isIPv4(host) ? 4 : 6 }];
  } else {
    const timeoutSignal = AbortSignal.timeout(DNS_TIMEOUT_MS);
    const signal = suppliedSignal ? AbortSignal.any([suppliedSignal, timeoutSignal]) : timeoutSignal;
    addresses = await resolveHostname(host, signal);
  }
  if (addresses.length === 0) throw new Error("无法解析主机");
  for (const { address } of addresses) {
    if (isBlockedIp(address)) throw new Error(`目标地址被拒绝（内网/保留地址 ${address}）`);
  }
  return { parsed: u, addresses };
}

/** 校验 URL：必须 http/https、主机解析出的所有 IP 都为公网，否则抛错。 */
export async function assertPublicUrl(rawUrl: string, signal?: AbortSignal): Promise<void> {
  await resolvePublicUrl(rawUrl, signal);
}

export interface SafeFetchPolicy {
  /** 可选协议白名单；用 ["https:"] 可阻止任意重定向降级到 HTTP。 */
  allowedProtocols?: readonly ("http:" | "https:")[];
  /** 可选主机白名单，支持 `*.example.com`；每次重定向都重新校验。 */
  allowedHosts?: readonly string[];
  /** URL.port 白名单；HTTPS 默认 443 在 URL API 中表示为空字符串。 */
  allowedPorts?: readonly string[];
}

function hostnameAllowed(hostname: string, entries: readonly string[]) {
  const normalized = hostname.toLowerCase();
  return entries.some((rawEntry) => {
    const entry = rawEntry.trim().toLowerCase();
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      return normalized.endsWith(suffix) && normalized !== suffix.slice(1);
    }
    return normalized === entry;
  });
}

/** SSRF 安全的 fetch：禁用自动重定向，手动逐跳跟随且每一跳都重新校验目标为公网。 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  maxRedirects = 4,
  policy: SafeFetchPolicy = {},
): Promise<Response> {
  let current = url;
  const signal = init.signal ?? AbortSignal.timeout(15_000);
  const hasAuthorization = new Headers(init.headers).has("authorization");
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsedCurrent = new URL(current);
    if (policy.allowedProtocols && !policy.allowedProtocols.includes(parsedCurrent.protocol as "http:" | "https:")) {
      throw new Error(`目标协议被拒绝（${parsedCurrent.protocol}）`);
    }
    if (policy.allowedHosts && !hostnameAllowed(parsedCurrent.hostname, policy.allowedHosts)) {
      throw new Error(`目标主机未在白名单（${parsedCurrent.hostname}）`);
    }
    if (policy.allowedPorts && !policy.allowedPorts.includes(parsedCurrent.port)) {
      throw new Error(`目标端口未在白名单（${parsedCurrent.port || "default"}）`);
    }
    const resolution = await resolvePublicUrl(current, signal);
    const host = parsedCurrent.hostname.replace(/^\[/, "").replace(/\]$/, "");
    // IP 字面量没有 DNS rebinding 窗口；保留原生 fetch 也便于本地兼容测试。
    // hostname 必须使用已校验地址建立连接，Host/SNI/证书仍校验原 hostname。
    const res = net.isIP(host)
      ? await fetch(current, { ...init, redirect: "manual", signal })
      : await requestPinned(resolution, { ...init, signal });
    if (res.status >= 300 && res.status < 400) {
      // maxRedirects=0 表示把 3xx 原样交给调用方分类；自动跟随始终关闭，凭据不会外发。
      if (hop === maxRedirects) return res;
      const loc = res.headers.get("location");
      if (!loc) return res;
      const next = new URL(loc, current);
      if (hasAuthorization && next.origin !== new URL(current).origin) {
        await res.body?.cancel("authorization-cross-origin-redirect");
        throw new Error("携带凭据的请求禁止跨域重定向");
      }
      await res.body?.cancel("redirect");
      current = next.href; // 解析可能的相对跳转
      continue;
    }
    return res;
  }
  throw new Error("重定向次数过多");
}

function responseHeaders(headers: import("node:http").IncomingHttpHeaders) {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) value.forEach((item) => result.append(name, item));
    else if (value !== undefined) result.set(name, value);
  }
  return result;
}

async function requestBodyBuffer(body: BodyInit | null | undefined): Promise<Buffer | null> {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  throw new Error("钉定 DNS 请求不支持流式/FormData 请求体");
}

async function requestPinned(
  resolution: PublicUrlResolution,
  init: RequestInit,
): Promise<Response> {
  const parsedCurrent = resolution.parsed;
  const method = (init.method || "GET").toUpperCase();
  const signal = init.signal ?? AbortSignal.timeout(15_000);
  const headers = new Headers(init.headers);
  const bodyBuffer = method === "GET" || method === "HEAD" ? null : await requestBodyBuffer(init.body);
  if (bodyBuffer && bodyBuffer.byteLength > MAX_PINNED_REQUEST_BYTES) {
    throw new Error("钉定 DNS 请求体超过 10MiB 限制");
  }
  if (bodyBuffer && !headers.has("content-length")) headers.set("content-length", String(bodyBuffer.byteLength));
  const pinned = resolution.addresses.find((item) => item.family === 4) ?? resolution.addresses[0];
  return new Promise<Response>((resolve, reject) => {
    const requestFn = (parsedCurrent.protocol === "https:" ? httpsRequest : httpRequest) as typeof httpsRequest;
    const request = requestFn(parsedCurrent, {
      method,
      headers: Object.fromEntries(headers.entries()),
      family: pinned.family,
      lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
    }, (incoming) => {
      const cleanupAbort = () => signal.removeEventListener("abort", abort);
      const abort = () => incoming.destroy(signalError(signal));
      incoming.once("close", cleanupAbort);
      signal.addEventListener("abort", abort, { once: true });
      const status = incoming.statusCode || 502;
      const body = method === "HEAD" || status === 204 || status === 205 || status === 304
        ? null
        : Readable.toWeb(incoming) as unknown as BodyInit;
      resolve(new Response(body, {
        status,
        statusText: incoming.statusMessage,
        headers: responseHeaders(incoming.headers),
      }));
    });
    const abortBeforeResponse = () => request.destroy(signalError(signal));
    if (signal.aborted) abortBeforeResponse();
    else signal.addEventListener("abort", abortBeforeResponse, { once: true });
    request.once("response", () => signal.removeEventListener("abort", abortBeforeResponse));
    request.once("error", (error) => {
      signal.removeEventListener("abort", abortBeforeResponse);
      reject(error);
    });
    if (bodyBuffer) request.write(bodyBuffer);
    request.end();
  });
}

/**
 * 将安全校验过的 DNS 结果钉到本次连接；下载以及小型 JSON 提交均可使用，
 * 消除“校验时是公网 IP、请求时重新解析成内网 IP”的 DNS rebinding 窗口。
 * HTTPS 原始 hostname 仍用于 Host/SNI/证书校验；每次重定向都重新解析、校验并钉定。
 */
export async function safeFetchPinned(
  url: string,
  init: RequestInit = {},
  maxRedirects = 4,
  policy: SafeFetchPolicy = {},
): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();

  let current = url;
  const signal = init.signal ?? AbortSignal.timeout(15_000);
  const initialHeaders = new Headers(init.headers);
  const hasAuthorization = initialHeaders.has("authorization");
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const resolution = await resolvePublicUrl(current, signal);
    const parsedCurrent = resolution.parsed;
    if (policy.allowedProtocols && !policy.allowedProtocols.includes(parsedCurrent.protocol as "http:" | "https:")) {
      throw new Error(`目标协议被拒绝（${parsedCurrent.protocol}）`);
    }
    if (policy.allowedHosts && !hostnameAllowed(parsedCurrent.hostname, policy.allowedHosts)) {
      throw new Error(`目标主机未在白名单（${parsedCurrent.hostname}）`);
    }
    if (policy.allowedPorts && !policy.allowedPorts.includes(parsedCurrent.port)) {
      throw new Error(`目标端口未在白名单（${parsedCurrent.port || "default"}）`);
    }

    const response = await requestPinned(resolution, { ...init, method, headers: initialHeaders, signal });

    if (response.status >= 300 && response.status < 400) {
      if (hop === maxRedirects || (method !== "GET" && method !== "HEAD")) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, current);
      if (hasAuthorization && next.origin !== parsedCurrent.origin) {
        await response.body?.cancel("authorization-cross-origin-redirect");
        throw new Error("携带凭据的请求禁止跨域重定向");
      }
      await response.body?.cancel("redirect");
      current = next.href;
      continue;
    }
    return response;
  }
  throw new Error("重定向次数过多");
}

/** 有上限地读取远程响应，避免 `arrayBuffer()` 被恶意或异常大响应撑爆内存。 */
export async function readResponseBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`远程文件超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB 限制`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("response-too-large");
        throw new Error(`远程文件超过 ${Math.ceil(maxBytes / 1024 / 1024)}MB 限制`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}
