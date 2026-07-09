/**
 * 共享合成轮询工具 — video / export / batch 三页去重。
 *
 * 向 /api/project/:id/compose 轮询直到 done/failed/timeout，
 * 返回合成结果 URL。
 *
 * @example
 * const url = await pollComposition("proj_123", "comp_456");
 * // 或传入自定义超时和回调
 * const url = await pollComposition("proj_123", "comp_456", { onStatus: (c) => console.log(c.status) });
 */

interface ComposeStatus {
  status: string;
  url?: string | null;
  errorMessage?: string | null;
}

export interface PollCompositionOpts {
  /** 轮询间隔 ms（默认 3000） */
  intervalMs?: number;
  /** 超时 ms（默认 300000 = 5分钟） */
  timeoutMs?: number;
  /** 每次状态更新回调（可用于 UI 进度展示） */
  onStatus?: (status: string) => void;
  /** 失败时的错误信息 */
  failMessage?: string;
  /** 超时时的错误信息 */
  timeoutMessage?: string;
}

export async function pollComposition(
  projectId: string,
  compositionId?: string,
  opts: PollCompositionOpts = {}
): Promise<string> {
  const {
    intervalMs = 3000,
    timeoutMs = 300_000,
    failMessage = "合成失败",
    timeoutMessage = "合成超时",
  } = opts;

  const qs = compositionId
    ? `?compositionId=${encodeURIComponent(compositionId)}`
    : "";

  return new Promise<string>((resolve, reject) => {
    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/project/${projectId}/compose${qs}`);
        const d = await r.json();
        const c: ComposeStatus | undefined = d.composition;
        if (!c) return;
        opts.onStatus?.(c.status);
        if (c.status === "done" && c.url) {
          clearInterval(poll);
          resolve(c.url);
        } else if (c.status === "failed") {
          clearInterval(poll);
          reject(new Error(c.errorMessage || failMessage));
        }
      } catch {
        // 单次轮询失败忽略，继续重试
      }
    }, intervalMs);

    setTimeout(() => {
      clearInterval(poll);
      reject(new Error(timeoutMessage));
    }, timeoutMs);
  });
}
