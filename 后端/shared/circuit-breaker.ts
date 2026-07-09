/**
 * 极简熔断器（无依赖、可单测）。
 * 连续失败达阈值即「打开」，冷却期内 isOpen() 为真——调用方据此 fail-fast，
 * 避免下游挂掉时每个请求都各自超时拖垮整批。一次成功即复位；冷却期后自动半开重试。
 * 注入 `now` 便于测冷却（默认 Date.now）。
 */
export class CircuitBreaker {
  private fails = 0;
  private openUntil = 0;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  isOpen(): boolean {
    return this.now() < this.openUntil;
  }

  recordSuccess(): void {
    this.fails = 0;
    this.openUntil = 0;
  }

  recordFailure(): void {
    this.fails++;
    if (this.fails >= this.threshold) this.openUntil = this.now() + this.cooldownMs;
  }
}
