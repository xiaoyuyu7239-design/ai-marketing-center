import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// reminder-service 模块链会带出 @backend/db（导入即建库），所以整个测试文件统一走
// "先设 APP_DATA_DIR 指向临时目录、再动态导入" 的模式，不碰开发用的 data/sqlite.db。
let svc: typeof import("@backend/core/notify/reminder-service");
let dbModule: typeof import("@backend/db");
let schema: typeof import("@backend/db/schema");
let dataDir: string;

/** 微信假配置（WECHAT_DRY_RUN=1 时 send 干跑成功，不打真实网络） */
const WECHAT_ENV = {
  WECHAT_APP_ID: "wx-test-appid",
  WECHAT_APP_SECRET: "test-secret",
  WECHAT_CALLBACK_TOKEN: "test-token",
  WECHAT_TEMPLATE_ID: "tpl-test",
  WECHAT_DRY_RUN: "1",
} as const;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "clipforge-reminder-test-"));
  process.env.APP_DATA_DIR = dataDir;
  Object.assign(process.env, WECHAT_ENV);
  svc = await import("@backend/core/notify/reminder-service");
  dbModule = await import("@backend/db");
  schema = await import("@backend/db/schema");
});

afterAll(() => {
  delete process.env.APP_DATA_DIR;
  for (const key of Object.keys(WECHAT_ENV)) delete process.env[key];
  rmSync(dataDir, { recursive: true, force: true });
});

// 时段样例：类似 fashion 的午间 + 晚间两段
const NOON = { startMinute: 12 * 60, endMinute: 13 * 60 + 30 }; // 720-810
const EVENING = { startMinute: 19 * 60, endMinute: 21 * 60 + 30 }; // 1140-1290
const WINDOWS = [NOON, EVENING];

describe("findDueWindow 刚进时段判定", () => {
  it("正好在窗口开始那一分钟 → 命中", () => {
    expect(svc.findDueWindow(WINDOWS, 1140)).toEqual(EVENING);
  });

  it("容差边界：默认容 5 分钟，开始后第 4 分钟命中、第 5 分钟不再命中", () => {
    expect(svc.findDueWindow(WINDOWS, 1144)).toEqual(EVENING); // 1140 ∈ (1139, 1144]
    expect(svc.findDueWindow(WINDOWS, 1145)).toBeNull(); // 1140 不 > 1140
  });

  it("还没到窗口开始 → 不命中（哪怕只差一分钟）", () => {
    expect(svc.findDueWindow(WINDOWS, 1139)).toBeNull();
  });

  it("在窗口内但早已过了开头 → 不命中（提醒只在进窗时推一次）", () => {
    expect(svc.findDueWindow(WINDOWS, 1200)).toBeNull();
  });

  it("一天多个窗口时取到对的那个", () => {
    expect(svc.findDueWindow(WINDOWS, 722)).toEqual(NOON);
  });

  it("自定义容差生效", () => {
    expect(svc.findDueWindow(WINDOWS, 1148, 10)).toEqual(EVENING);
    expect(svc.findDueWindow(WINDOWS, 1148, 5)).toBeNull();
  });
});

describe("composeReminderPush 提醒文案", () => {
  const basis = "按你家最近 12 条视频的实际效果，这几个点发出去看的人最多";
  const baseInput = { window: EVENING, windowLabel: "19:00-21:30", basis, dateLabel: "07-12" };

  it("库里有货：催发文案带还差几条、库存数、推荐片名和依据", () => {
    const push = svc.composeReminderPush({
      ...baseInput,
      inventory: {
        approvedUnpublished: 5,
        publishedToday: 1,
        dailyTarget: 3,
        remainingToday: 2,
        topCandidates: [{ projectId: "p1", name: "春季新品连衣裙" }],
      },
    });
    expect(push.title).toBe("该发视频啦");
    expect(push.body).toContain("还差 2 条");
    expect(push.body).toContain("5 条");
    expect(push.body).toContain("《春季新品连衣裙》");
    expect(push.body).toContain(basis); // 依据注入，老板知道"为什么是现在"
    expect(push.body).toContain("21:30"); // "现在到几点前"用窗口结束时刻
    expect(push.date).toBe("07-12 19:00-21:30");
  });

  it("没有推荐片名时不带书名号推荐", () => {
    const push = svc.composeReminderPush({
      ...baseInput,
      inventory: { approvedUnpublished: 2, publishedToday: 0, dailyTarget: 3, remainingToday: 3, topCandidates: [] },
    });
    expect(push.title).toBe("该发视频啦");
    expect(push.body).not.toContain("《");
    expect(push.body).toContain("还差 3 条");
  });

  it("库存为空：走补货文案，仍然带时段依据", () => {
    const push = svc.composeReminderPush({
      ...baseInput,
      inventory: { approvedUnpublished: 0, publishedToday: 0, dailyTarget: 3, remainingToday: 3, topCandidates: [] },
    });
    expect(push.title).toBe("库里没视频可发了");
    expect(push.body).toContain("批量生成");
    expect(push.body).toContain(basis);
    expect(push.date).toBe("07-12 19:00-21:30");
  });
});

describe("runReminderTick 集成（临时库 + 微信干跑）", () => {
  let merchantAId: string; // 有货可发：应收到 sent 提醒
  let merchantBId: string; // 今天目标已完成：应落 skipped 流水
  // fashion 晚间窗口 19:00 开始后 2 分钟（容差内），2026-07-12
  const dueTime = new Date(2026, 6, 12, 19, 2);

  beforeAll(async () => {
    const db = dbModule.getDb();
    const { merchants, projects, publishRecords, wechatBindings } = schema;

    // 商家 A：fashion 品类、无回流样本（走行业模板时段），库里 1 条已入库未发布
    const [merchantA] = await db
      .insert(merchants)
      .values({ email: "remind-a@test.local", passwordHash: "salt:hash", category: "fashion" })
      .returning();
    merchantAId = merchantA.id;
    const [projectA] = await db
      .insert(projects)
      .values({ name: "春季新品连衣裙", merchantId: merchantAId })
      .returning();
    await db.insert(publishRecords).values({
      merchantId: merchantAId,
      projectId: projectA.id,
      approvedAt: new Date(2026, 6, 11, 10, 0),
    });
    await db.insert(wechatBindings).values({ merchantId: merchantAId, openId: "openid-a" });

    // 商家 B：每天目标 1 条且今天已发 1 条 → 到点应记 skipped 不打扰
    const [merchantB] = await db
      .insert(merchants)
      .values({ email: "remind-b@test.local", passwordHash: "salt:hash", category: "fashion", dailyPublishTarget: 1 })
      .returning();
    merchantBId = merchantB.id;
    const [projectB] = await db
      .insert(projects)
      .values({ name: "今早已发的视频", merchantId: merchantBId })
      .returning();
    await db.insert(publishRecords).values({
      merchantId: merchantBId,
      projectId: projectB.id,
      approvedAt: new Date(2026, 6, 11, 9, 0),
      publishedAt: new Date(2026, 6, 12, 10, 0),
    });
    await db.insert(wechatBindings).values({ merchantId: merchantBId, openId: "openid-b" });

    // 商家 C：开了提醒但没绑微信 → 整轮都应跳过（不计入 checked）
    await db
      .insert(merchants)
      .values({ email: "remind-c@test.local", passwordHash: "salt:hash", category: "fashion" });
  });

  it("微信未配置时直接返回全零，不做任何事", async () => {
    const saved = process.env.WECHAT_APP_ID;
    delete process.env.WECHAT_APP_ID;
    const stats = await svc.runReminderTick(dueTime);
    expect(stats).toEqual({ checked: 0, sent: 0, failed: 0, skipped: 0 });
    process.env.WECHAT_APP_ID = saved;
  });

  it("不在任何窗口开头的时刻：只检查不动作，不落流水", async () => {
    const stats = await svc.runReminderTick(new Date(2026, 6, 12, 15, 0));
    expect(stats).toEqual({ checked: 2, sent: 0, failed: 0, skipped: 0 });
    const db = dbModule.getDb();
    expect(await db.select().from(schema.reminderLogs)).toHaveLength(0);
  });

  it("刚进窗口：有货的商家推送并落 sent 流水，目标已完成的落 skipped 流水", async () => {
    const stats = await svc.runReminderTick(dueTime);
    expect(stats).toEqual({ checked: 2, sent: 1, failed: 0, skipped: 1 });

    const db = dbModule.getDb();
    const logs = await db.select().from(schema.reminderLogs);
    expect(logs).toHaveLength(2);

    const sentLog = logs.find((l) => l.merchantId === merchantAId);
    expect(sentLog?.status).toBe("sent");
    expect(sentLog?.planDate).toBe("2026-07-12");
    expect(sentLog?.windowKey).toBe("1140-1290"); // fashion 晚间 19:00-21:30
    expect(sentLog?.detail).toContain("春季新品连衣裙"); // detail 存文案摘要
    expect(sentLog?.detail).toContain("还差 3 条");

    const skippedLog = logs.find((l) => l.merchantId === merchantBId);
    expect(skippedLog?.status).toBe("skipped");
    expect(skippedLog?.detail).toBe("今天目标已完成");
  });

  it("同窗口第二次 tick：流水去重，不重复推送也不重复写日志", async () => {
    const stats = await svc.runReminderTick(new Date(2026, 6, 12, 19, 3));
    expect(stats).toEqual({ checked: 2, sent: 0, failed: 0, skipped: 2 });
    const db = dbModule.getDb();
    expect(await db.select().from(schema.reminderLogs)).toHaveLength(2);
  });
});
