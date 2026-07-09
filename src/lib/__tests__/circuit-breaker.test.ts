import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "@backend/shared/circuit-breaker";

describe("CircuitBreaker", () => {
  it("初始关闭；达阈值连续失败后打开", () => {
    const b = new CircuitBreaker(2, 1000);
    expect(b.isOpen()).toBe(false);
    b.recordFailure();
    expect(b.isOpen()).toBe(false); // 1 次未到阈值
    b.recordFailure();
    expect(b.isOpen()).toBe(true); // 第 2 次到阈值 → 打开
  });

  it("一次成功即复位（清零失败计数与开断）", () => {
    const b = new CircuitBreaker(2, 1000);
    b.recordFailure();
    b.recordSuccess();
    b.recordFailure();
    expect(b.isOpen()).toBe(false); // 复位后只累计了 1 次，未到阈值
  });

  it("冷却期后自动半开（注入时钟）", () => {
    let t = 0;
    const b = new CircuitBreaker(1, 1000, () => t);
    b.recordFailure();
    expect(b.isOpen()).toBe(true);
    t = 999;
    expect(b.isOpen()).toBe(true);
    t = 1001;
    expect(b.isOpen()).toBe(false); // 冷却到期 → 半开放行
  });
});
