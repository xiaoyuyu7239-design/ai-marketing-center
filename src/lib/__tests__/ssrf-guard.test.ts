import { afterEach, describe, it, expect, vi } from "vitest";
import { isBlockedIp, assertPublicUrl, safeFetch, safeFetchPinned } from "@backend/shared/ssrf-guard";

afterEach(() => vi.unstubAllGlobals());

describe("isBlockedIp", () => {
  it("拦截私网/回环/链路本地/保留 IPv4", () => {
    for (const ip of [
      "127.0.0.1", "10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1",
      "169.254.169.254", "0.0.0.0", "100.64.0.1", "224.0.0.1", "255.255.255.255",
      "198.18.0.1", "198.19.255.254",
    ]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it("放行公网 IPv4（含 172.16/12 与 100.64/10 的边界外）", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "192.167.0.1", "100.63.0.1", "13.107.21.200"]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });

  it("IPv6：回环/链路本地/ULA/映射内网 拦截，公网放行", () => {
    expect(isBlockedIp("::1")).toBe(true);
    expect(isBlockedIp("fe80::1")).toBe(true);
    expect(isBlockedIp("fc00::1")).toBe(true);
    expect(isBlockedIp("fd12::1")).toBe(true);
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true);
    expect(isBlockedIp("64:ff9b::7f00:1")).toBe(true);
    expect(isBlockedIp("fec0::1")).toBe(true);
    expect(isBlockedIp("ff02::1")).toBe(true);
    expect(isBlockedIp("2001:db8::1")).toBe(true);
    expect(isBlockedIp("::ffff:808:808")).toBe(false);
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });

  it("非法 IP 一律拦", () => {
    expect(isBlockedIp("notanip")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });
});

describe("assertPublicUrl（IP 字面量，无需 DNS）", () => {
  it("内网/元数据/回环 IP 抛错", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/")).rejects.toThrow();
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow();
    await expect(assertPublicUrl("http://10.0.0.5:6379/")).rejects.toThrow();
    await expect(assertPublicUrl("http://[::1]/")).rejects.toThrow();
    await expect(assertPublicUrl("http://[::ffff:7f00:1]/")).rejects.toThrow();
  });

  it("非 http/https 协议抛错", async () => {
    await expect(assertPublicUrl("ftp://8.8.8.8/")).rejects.toThrow();
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicUrl("not a url")).rejects.toThrow();
  });

  it("公网 IP 字面量通过", async () => {
    await expect(assertPublicUrl("http://8.8.8.8/")).resolves.toBeUndefined();
  });

  it("DNS 解析服从调用方完整 deadline", async () => {
    const signal = AbortSignal.abort(new Error("dns-deadline"));
    await expect(assertPublicUrl("https://example.com/", signal)).rejects.toThrow("dns-deadline");
  });
});

describe("safeFetch protocol policy", () => {
  it("阻止 HTTPS 产物通过重定向降级到 HTTP", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: "http://8.8.8.8/insecure" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(safeFetch(
      "https://8.8.8.8/artifact",
      {},
      4,
      { allowedProtocols: ["https:"] },
    )).rejects.toThrow(/\u534f\u8bae|http:/i);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("钉定 DNS 下载同样在建立连接前拒绝私网 HTTP(S)", async () => {
    await expect(safeFetchPinned("http://127.0.0.1/private"))
      .rejects.toThrow(/内网|保留地址/);
    await expect(safeFetchPinned("https://169.254.169.254/latest/meta-data/"))
      .rejects.toThrow(/内网|保留地址/);
  });
});
