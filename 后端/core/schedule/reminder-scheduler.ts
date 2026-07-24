import "server-only";

import { runReminderTick } from "@backend/core/notify/reminder-service";

/**
 * 发布提醒调度器 —— 进程内 setInterval 每分钟跑一轮 runReminderTick。
 * standalone 单进程部署（含 Electron）够用；将来多实例部署时需换成带分布式锁的外部调度。
 * 由 src/instrumentation.ts 在服务启动时拉起。
 */

const TICK_INTERVAL_MS = 60_000;

/**
 * 状态挂在 globalThis 上：dev 热重载会重新执行 register/本模块，
 * 模块级变量会被新实例重置，只有 Symbol.for 的全局键能跨模块实例识别"已经启动过"。
 */
const SCHEDULER_KEY = Symbol.for("clipforge.reminder-scheduler");

interface SchedulerState {
  interval: ReturnType<typeof setInterval>;
  /** 上一轮是否还在跑（重入保护：DB 慢/商家多导致一轮超过 60 秒时，跳过本轮而不是叠加并发） */
  running: boolean;
}

type GlobalWithScheduler = typeof globalThis & { [SCHEDULER_KEY]?: SchedulerState };

export function startReminderScheduler(): void {
  const g = globalThis as GlobalWithScheduler;
  if (g[SCHEDULER_KEY]) return; // 已在跑（dev 热重载/重复 register），不再起第二个

  const state = { running: false } as SchedulerState;
  state.interval = setInterval(async () => {
    if (state.running) return;
    state.running = true;
    try {
      const stats = await runReminderTick();
      // 只有真发生了动作才打日志，避免每分钟空转刷屏
      if (stats.sent + stats.failed + stats.skipped > 0) {
        console.log(
          `[发布提醒] 本轮检查 ${stats.checked} 家：推送 ${stats.sent}、失败 ${stats.failed}、跳过 ${stats.skipped}`
        );
      }
    } catch (err) {
      // 调度循环绝不能因单轮异常而死掉，记日志等下一轮
      console.error("[发布提醒] 本轮调度出错（下一轮继续）:", err);
    } finally {
      state.running = false;
    }
  }, TICK_INTERVAL_MS);
  // 不让定时器拖住进程退出（CLI 一次性命令、测试进程都要能正常结束）
  state.interval.unref?.();

  g[SCHEDULER_KEY] = state;
}

/** 停止调度（测试用；也供将来优雅停机钩子调用） */
export function stopReminderScheduler(): void {
  const g = globalThis as GlobalWithScheduler;
  const state = g[SCHEDULER_KEY];
  if (!state) return;
  clearInterval(state.interval);
  delete g[SCHEDULER_KEY];
}
