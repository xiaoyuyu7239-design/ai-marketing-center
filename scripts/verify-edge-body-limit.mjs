#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";

const MIN_EDGE_BYTES = 161 * 1024 * 1024;
const MAX_EDGE_BYTES = 192 * 1024 * 1024;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function requestOptions(target, probePath, headers) {
  return {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: "POST",
    path: probePath,
    headers: {
      "Content-Type": "application/octet-stream",
      "User-Agent": "huimai-edge-body-limit-verifier/1",
      ...headers,
    },
    timeout: 60_000,
  };
}

function contentLengthProbe(target, probePath, bytes) {
  return new Promise((resolveProbe, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(requestOptions(target, probePath, {
      "Content-Length": String(bytes),
      Expect: "100-continue",
    }));
    let settled = false;
    const done = (error, status) => {
      if (settled) return;
      settled = true;
      request.destroy();
      if (error) reject(error);
      else resolveProbe(status);
    };
    request.once("continue", () => done(new Error("边缘层接受了超限 Content-Length，请求可能进入应用")));
    request.once("response", (response) => {
      response.resume();
      done(undefined, response.statusCode || 0);
    });
    request.once("timeout", () => done(new Error("Content-Length 探针超时")));
    request.once("error", (error) => {
      if (!settled) done(error);
    });
    request.flushHeaders();
  });
}

function underLimitProbe(target, probePath, bytes) {
  return new Promise((resolveProbe, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(requestOptions(target, probePath, {
      "Content-Length": String(bytes),
      Expect: "100-continue",
    }));
    let settled = false;
    const done = (error, status) => {
      if (settled) return;
      settled = true;
      request.destroy();
      if (error) reject(error);
      else resolveProbe(status);
    };
    request.once("continue", () => done(undefined, 100));
    request.once("response", (response) => {
      response.resume();
      done(undefined, response.statusCode || 0);
    });
    request.once("timeout", () => done(new Error("未超限 Content-Length 对照探针超时")));
    request.once("error", (error) => {
      if (!settled) done(error);
    });
    request.flushHeaders();
  });
}

function chunkedProbe(target, probePath, bytes) {
  return new Promise((resolveProbe, reject) => {
    const transport = target.protocol === "https:" ? https : http;
    const request = transport.request(requestOptions(target, probePath, { "Transfer-Encoding": "chunked" }));
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    let sent = 0;
    let settled = false;
    const done = (error, status) => {
      if (settled) return;
      settled = true;
      request.destroy();
      if (error) reject(error);
      else resolveProbe(status);
    };
    const pump = () => {
      while (!settled && sent < bytes) {
        const size = Math.min(chunk.length, bytes - sent);
        sent += size;
        if (!request.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
          request.once("drain", pump);
          return;
        }
      }
      if (!settled) request.end();
    };
    request.once("response", (response) => {
      response.resume();
      done(undefined, response.statusCode || 0);
    });
    request.once("timeout", () => done(new Error("chunked 探针超时")));
    request.once("error", (error) => {
      if (!settled) done(error);
    });
    pump();
  });
}

async function main() {
  const target = new URL(required("HUIMAI_PUBLIC_BASE_URL"));
  if (target.protocol !== "https:" || target.username || target.password || target.search || target.hash) {
    throw new Error("HUIMAI_PUBLIC_BASE_URL 必须是无凭据、无查询参数的 HTTPS URL");
  }
  const maxBodyBytes = Number(required("HUIMAI_EDGE_MAX_BODY_BYTES"));
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < MIN_EDGE_BYTES || maxBodyBytes > MAX_EDGE_BYTES) {
    throw new Error(`HUIMAI_EDGE_MAX_BODY_BYTES 必须在 ${MIN_EDGE_BYTES}..${MAX_EDGE_BYTES} 之间`);
  }
  const probePath = required("HUIMAI_EDGE_BODY_LIMIT_PROBE_PATH");
  if (!/^\/api\/project\/[a-zA-Z0-9-]+\/materials$/.test(probePath)) {
    throw new Error("HUIMAI_EDGE_BODY_LIMIT_PROBE_PATH 必须指向 /api/project/<安全ID>/materials");
  }
  const gatewayConfigSha256 = required("HUIMAI_EDGE_GATEWAY_CONFIG_SHA256").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(gatewayConfigSha256)) {
    throw new Error("HUIMAI_EDGE_GATEWAY_CONFIG_SHA256 必须是部署机 nginx -T 输出的 SHA-256");
  }
  const underLimitBytes = maxBodyBytes - 1;
  const underLimitStatus = await underLimitProbe(target, probePath, underLimitBytes);
  if (underLimitStatus === 413 || underLimitStatus === 0) {
    throw new Error(`未超限对照探针不应返回 413，实际 ${underLimitStatus}`);
  }
  const oversized = maxBodyBytes + 1;
  const contentLengthStatus = await contentLengthProbe(target, probePath, oversized);
  if (contentLengthStatus !== 413) throw new Error(`Content-Length 探针期望 413，实际 ${contentLengthStatus}`);
  const chunkedStatus = await chunkedProbe(target, probePath, oversized);
  if (chunkedStatus !== 413) throw new Error(`chunked 探针期望 413，实际 ${chunkedStatus}`);

  const evidence = {
    schemaVersion: 1,
    baseOrigin: target.origin,
    probePath,
    gatewayConfigSha256,
    maxBodyBytes,
    underLimitBytes,
    underLimitStatus,
    contentLengthStatus,
    chunkedStatus,
    verifiedAt: new Date().toISOString(),
  };
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  const destination = resolve(required("HUIMAI_EDGE_BODY_LIMIT_EVIDENCE_FILE"));
  await writeFile(destination, serialized, { mode: 0o600 });
  const sha256 = createHash("sha256").update(serialized).digest("hex");
  process.stdout.write(`边缘请求体硬上限验证通过；证据 ${destination}\nSHA256=${sha256}\n`);
}

main().catch((error) => {
  process.stderr.write(`边缘请求体硬上限验证失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
