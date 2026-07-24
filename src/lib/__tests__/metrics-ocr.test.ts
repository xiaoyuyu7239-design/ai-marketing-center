import { describe, expect, it } from "vitest";
import {
  MAX_IMAGE_DATA_URL_LENGTH,
  parseCnNumber,
  parseMetricsOcrResponse,
  validateImageDataUrl,
} from "@backend/core/publish/metrics-ocr";

describe("截图 OCR：中文计数写法换算", () => {
  it("数字/纯数字串/千分位直接取整", () => {
    expect(parseCnNumber(3456)).toBe(3456);
    expect(parseCnNumber(12.7)).toBe(12);
    expect(parseCnNumber("3456")).toBe(3456);
    expect(parseCnNumber("1,234")).toBe(1234);
    expect(parseCnNumber(" 88 ")).toBe(88);
  });

  it("万/w/k/亿 后缀正确换算", () => {
    expect(parseCnNumber("1.2万")).toBe(12000);
    expect(parseCnNumber("2.3w")).toBe(23000);
    expect(parseCnNumber("2.3W")).toBe(23000);
    expect(parseCnNumber("1.5k")).toBe(1500);
    expect(parseCnNumber("1亿")).toBe(100_000_000);
  });

  it("认不出的一律 null（宁缺勿错，不编数字）", () => {
    expect(parseCnNumber(null)).toBeNull();
    expect(parseCnNumber(undefined)).toBeNull();
    expect(parseCnNumber("")).toBeNull();
    expect(parseCnNumber("abc")).toBeNull();
    expect(parseCnNumber("万")).toBeNull();
    expect(parseCnNumber(-5)).toBeNull();
    expect(parseCnNumber("-5")).toBeNull();
  });
});

describe("截图 OCR：识别结果解析", () => {
  it("混合类型字段各自规范化，平台小写归一", () => {
    const result = parseMetricsOcrResponse({
      platform: "Douyin",
      views: "1.2万",
      likes: 345,
      comments: "12",
      shares: null,
      orders: "认不清",
    });
    expect(result).not.toBeNull();
    expect(result!.fields).toEqual({ views: 12000, likes: 345, comments: 12, shares: null, orders: null });
    expect(result!.platform).toBe("douyin");
  });

  it("未知平台返回 null platform，不瞎猜", () => {
    const result = parseMetricsOcrResponse({ platform: "bilibili", views: 100 });
    expect(result!.platform).toBeNull();
  });

  it("一个数字都没认出（非数据页截图）→ null", () => {
    expect(parseMetricsOcrResponse({ platform: "douyin", views: null, likes: null })).toBeNull();
    expect(parseMetricsOcrResponse({})).toBeNull();
    expect(parseMetricsOcrResponse(null)).toBeNull();
    expect(parseMetricsOcrResponse("not-an-object")).toBeNull();
  });
});

describe("截图 OCR：图片入参校验", () => {
  it("png/jpg/webp data URL 放行", () => {
    expect(validateImageDataUrl("data:image/png;base64,iVBORw0KGgo=").ok).toBe(true);
    expect(validateImageDataUrl("data:image/jpeg;base64,/9j/4AAQ").ok).toBe(true);
    expect(validateImageDataUrl("data:image/webp;base64,UklGRg==").ok).toBe(true);
  });

  it("空值/非图片/svg/超大图拒绝，并给大白话原因", () => {
    expect(validateImageDataUrl(undefined)).toEqual({ ok: false, reason: expect.stringContaining("没收到截图") });
    expect(validateImageDataUrl("http://evil/x.png")).toEqual({ ok: false, reason: expect.stringContaining("png/jpg/webp") });
    expect(validateImageDataUrl("data:image/svg+xml;base64,PHN2Zz4=").ok).toBe(false);
    const huge = `data:image/png;base64,${"A".repeat(MAX_IMAGE_DATA_URL_LENGTH)}`;
    expect(validateImageDataUrl(huge)).toEqual({ ok: false, reason: expect.stringContaining("太大") });
  });
});
