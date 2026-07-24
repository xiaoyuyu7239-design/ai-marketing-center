import { describe, expect, it } from "vitest";
import {
  acquireComposeOperation,
  clearComposeOperation,
  composePayloadFingerprint,
  type ComposeOperationStorage,
} from "@frontend/lib/compose-operation";

class MemoryStorage implements ComposeOperationStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

describe("compose operation 幂等键", () => {
  it("对象 key 顺序不影响稳定 payload 指纹，业务值变化会改变指纹", () => {
    const left = { resolution: "1080p", freeTts: { voice: "zh", enabled: true } };
    const same = { freeTts: { enabled: true, voice: "zh" }, resolution: "1080p" };
    const changed = { freeTts: { enabled: false, voice: "zh" }, resolution: "1080p" };

    expect(composePayloadFingerprint(left)).toBe(composePayloadFingerprint(same));
    expect(composePayloadFingerprint(changed)).not.toBe(composePayloadFingerprint(left));
  });

  it("同 project + scope + payload 在 TTL 内复用同一 key", () => {
    const storage = new MemoryStorage();
    const idFactory = ids("operation-0001", "operation-0002");
    const first = acquireComposeOperation("project-1", "video-preview", { freeTts: true }, {
      storage,
      now: 1_000,
      idFactory,
    });
    const replay = acquireComposeOperation("project-1", "video-preview", { freeTts: true }, {
      storage,
      now: 2_000,
      idFactory,
    });

    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
    expect(replay.persisted).toBe(true);
  });

  it("payload、project 或 scope 改变时生成隔离的新 key", () => {
    const storage = new MemoryStorage();
    const idFactory = ids("operation-0001", "operation-0002", "operation-0003", "operation-0004");
    const first = acquireComposeOperation("project-1", "video-preview", { resolution: "720p" }, { storage, idFactory });
    const changed = acquireComposeOperation("project-1", "video-preview", { resolution: "1080p" }, { storage, idFactory });
    const otherScope = acquireComposeOperation("project-1", "script-auto", { resolution: "1080p" }, { storage, idFactory });
    const otherProject = acquireComposeOperation("project-2", "video-preview", { resolution: "1080p" }, { storage, idFactory });

    expect(new Set([first.idempotencyKey, changed.idempotencyKey, otherScope.idempotencyKey, otherProject.idempotencyKey]).size).toBe(4);
  });

  it("TTL 过期后换 key；未到期的网络/轮询失败不会被 helper 自行清理", () => {
    const storage = new MemoryStorage();
    const idFactory = ids("operation-0001", "operation-0002");
    const first = acquireComposeOperation("project-1", "video-preview", {}, {
      storage,
      now: 1_000,
      ttlMs: 500,
      idFactory,
    });
    const pendingReplay = acquireComposeOperation("project-1", "video-preview", {}, {
      storage,
      now: 1_499,
      ttlMs: 500,
      idFactory,
    });
    const expired = acquireComposeOperation("project-1", "video-preview", {}, {
      storage,
      now: 1_500,
      ttlMs: 500,
      idFactory,
    });

    expect(pendingReplay.idempotencyKey).toBe(first.idempotencyKey);
    expect(expired.idempotencyKey).toBe("operation-0002");
  });

  it("终态只清理匹配记录，旧请求不能误删后来 payload 的 operation", () => {
    const storage = new MemoryStorage();
    const idFactory = ids("operation-0001", "operation-0002", "operation-0003");
    const old = acquireComposeOperation("project-1", "video-preview", { resolution: "720p" }, { storage, idFactory });
    const current = acquireComposeOperation("project-1", "video-preview", { resolution: "1080p" }, { storage, idFactory });

    expect(clearComposeOperation(old, storage)).toBe(false);
    expect(clearComposeOperation(current, storage)).toBe(true);
    const next = acquireComposeOperation("project-1", "video-preview", { resolution: "1080p" }, { storage, idFactory });
    expect(next.idempotencyKey).toBe("operation-0003");
  });
});
