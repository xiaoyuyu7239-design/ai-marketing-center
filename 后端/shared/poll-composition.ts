/** 共享 composition 精确轮询；服务端任务超时不等于失败，超时后仍可凭 compositionId 稍后查看。 */

interface ComposeStatus {
  status: string;
  url?: string | null;
  errorMessage?: string | null;
}

class TerminalPollError extends Error {}

export interface PollCompositionOpts {
  intervalMs?: number;
  timeoutMs?: number;
  onStatus?: (status: string) => void;
  failMessage?: string;
  timeoutMessage?: string;
  signal?: AbortSignal;
  /** 连续网络/5xx 错误上限；成功一次后清零。 */
  maxConsecutiveErrors?: number;
  /** 单次状态请求超时；防止一个挂起 fetch 绕过整个轮询 deadline。 */
  requestTimeoutMs?: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("操作已取消", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("操作已取消", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function pollComposition(
  projectId: string,
  compositionId: string,
  opts: PollCompositionOpts = {},
): Promise<string> {
  if (!compositionId?.trim()) throw new Error("合成任务未返回 compositionId，无法安全轮询");
  const {
    intervalMs = 3_000,
    timeoutMs = 15 * 60 * 1_000,
    failMessage = "合成失败",
    timeoutMessage = "等待已超时，但任务可能仍在后台执行；请稍后回到项目查看",
    maxConsecutiveErrors = 5,
    requestTimeoutMs = 10_000,
  } = opts;
  const deadline = Date.now() + timeoutMs;
  const url = `/api/project/${encodeURIComponent(projectId)}/compose?compositionId=${encodeURIComponent(compositionId)}`;
  let consecutiveErrors = 0;

  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new DOMException("操作已取消", "AbortError");
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const requestSignal = AbortSignal.timeout(Math.min(Math.max(250, requestTimeoutMs), remainingMs));
      const signal = opts.signal ? AbortSignal.any([opts.signal, requestSignal]) : requestSignal;
      const response = await fetch(url, { cache: "no-store", signal });
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        const data = await response.json().catch(() => ({}));
        throw new TerminalPollError(
          typeof data.error === "string" ? data.error : "合成任务不存在或无权查看",
        );
      }
      if (!response.ok) throw new Error(`查询任务状态失败（HTTP ${response.status}）`);
      const data = await response.json();
      const composition: ComposeStatus | undefined = data.composition;
      if (!composition) throw new Error("合成任务状态不存在");
      consecutiveErrors = 0;
      opts.onStatus?.(composition.status);
      if (composition.status === "done" && composition.url) return composition.url;
      if (composition.status === "failed") {
        throw new TerminalPollError(composition.errorMessage || failMessage);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof TerminalPollError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        throw new Error(`暂时无法查询合成任务状态：${message}。任务仍可能在后台执行，请稍后回来查看`);
      }
    }
    await delay(Math.max(250, intervalMs), opts.signal);
  }
  throw new Error(timeoutMessage);
}
