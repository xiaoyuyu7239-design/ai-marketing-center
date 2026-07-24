/**
 * Next.js 启动钩子（instrumentation 约定）—— 发布提醒的定时触发载体：
 * 服务进程起来后拉起提醒调度器，每分钟检查一轮"哪家店刚进黄金时段该推微信了"。
 *
 * 部署注意：时段判定用服务器本地时钟（"当日分钟数"口径），容器/服务器必须设 TZ=Asia/Shanghai，
 * 否则提醒时间会整体偏移。临时关闭调度可设 CLIPFORGE_DISABLE_SCHEDULER=1（如跑一次性脚本时）。
 */
export async function register() {
  // 只在 Node.js 运行时启动：edge 运行时和 next build 阶段都不能加载 better-sqlite3（原生模块），
  // 因此调度器必须用动态 import，条件不满足时连模块都不加载
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { assertRuntimeConfiguration } = await import("@backend/core/security/runtime-config");
  assertRuntimeConfiguration();
  const { assertAdminConfiguration } = await import("@server/admin/admin-auth");
  assertAdminConfiguration();

  // 即使关闭提醒调度，也必须初始化数据库并执行迁移；迁移失败应阻止实例启动。
  await import("@backend/db");

  // 持久任务 worker 与发布提醒是两条独立生命线：scheduler 被关闭时合成队列仍必须消费/恢复。
  const { startPersistentJobWorker } = await import("@backend/core/jobs/worker");
  startPersistentJobWorker();
  // 管理端媒体 Golden 评测单独使用持久队列：提交前先留存候选快照，
  // 远程 taskId checkpoint 后才能轮询；不与商家 compose 的额度/任务表混用。
  const { startGoldenMediaEvalJobWorker } = await import("@server/admin/evals/media-jobs/worker");
  startGoldenMediaEvalJobWorker();
  // 分镜转动态是分钟级付费异步任务：独立持久 worker 负责 taskId checkpoint、GET 轮询、
  // 限流等待和下载落库；页面关闭/进程重启都不会触发重复 POST。
  const { startMotionVideoJobWorker } = await import("@backend/core/video-jobs/worker");
  startMotionVideoJobWorker();

  if (process.env.CLIPFORGE_DISABLE_SCHEDULER === "1") return;

  const { startReminderScheduler } = await import("@backend/core/schedule/reminder-scheduler");
  startReminderScheduler();
}
