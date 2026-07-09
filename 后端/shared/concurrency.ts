/**
 * 有界并发 map（无依赖、保序、可单测）。
 * 用 `limit` 个 worker 轮流取下一个项处理，避免一次性打爆下游 API / 连接池，又比串行快。
 * 结果按输入顺序返回（results[idx]）。某项 fn 抛错则整体 reject。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const n = Math.max(1, Math.min(limit, items.length));

  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export type Limiter = <T>(fn: () => Promise<T> | T) => Promise<T>;

export function createLimiter(max: number): Limiter {
  const limit = Math.max(1, Math.floor(max) || 1);
  let active = 0;
  const queue: Array<() => void> = [];

  function release() {
    active--;
    const next = queue.shift();
    if (next) next();
  }

  return function schedule<T>(fn: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active++;
        Promise.resolve().then(fn).then(
          (value) => {
            release();
            resolve(value);
          },
          (error) => {
            release();
            reject(error);
          }
        );
      };

      if (active < limit) start();
      else queue.push(start);
    });
  };
}
