import { describe, expect, it } from "vitest";
import {
  IMAGE_UPLOAD_TYPES,
  randomUploadFileName,
  validateUploadContentLength,
  validateUploadFiles,
} from "./upload-policy";

const TEST_POLICY = {
  maxFiles: 2,
  maxFileBytes: 4,
  maxTotalBytes: 6,
  allowedTypes: IMAGE_UPLOAD_TYPES,
} as const;

function image(name: string, type: string, bytes = "ok") {
  return new File([bytes], name, { type });
}

describe("upload-policy", () => {
  it("在解析 multipart 前按 Content-Length 早返 413", () => {
    expect(validateUploadContentLength(new Headers({ "content-length": "6" }), 6)).toBeNull();
    expect(validateUploadContentLength(new Headers({ "content-length": "7" }), 6)).toEqual({
      code: "content_length_exceeded",
      status: 413,
    });
    expect(validateUploadContentLength(new Headers({ "content-length": "not-a-number" }), 6)).toEqual({
      code: "invalid_content_length",
      status: 400,
    });
    expect(validateUploadContentLength(new Headers({ "content-length": "1e2" }), 100)).toEqual({
      code: "invalid_content_length",
      status: 400,
    });
  });

  it("整批通过扩展名和 MIME 配对校验后返回规范化结果", () => {
    const result = validateUploadFiles(
      [image("front.JPG", "image/jpeg"), image("back.png", "image/png")],
      TEST_POLICY,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totalBytes).toBe(4);
    expect(result.files.map((item) => item.extension)).toEqual(["jpg", "png"]);
  });

  it("拒绝零字节、超数量和超总量文件", () => {
    expect(validateUploadFiles([image("empty.jpg", "image/jpeg", "")], TEST_POLICY)).toMatchObject({
      ok: false,
      error: { code: "empty_file" },
    });
    expect(
      validateUploadFiles(
        [image("a.jpg", "image/jpeg"), image("b.jpg", "image/jpeg"), image("c.jpg", "image/jpeg")],
        TEST_POLICY,
      ),
    ).toMatchObject({ ok: false, error: { code: "too_many_files" } });
    expect(
      validateUploadFiles(
        [image("a.jpg", "image/jpeg", "1234"), image("b.jpg", "image/jpeg", "1234")],
        TEST_POLICY,
      ),
    ).toMatchObject({ ok: false, error: { code: "total_too_large" } });
  });

  it("拒绝扩展名与 MIME 不匹配的伪装文件", () => {
    expect(validateUploadFiles([image("payload.jpg", "image/png")], TEST_POLICY)).toMatchObject({
      ok: false,
      error: { code: "mime_extension_mismatch", fileName: "payload.jpg" },
    });
    expect(validateUploadFiles([image("payload.svg", "image/svg+xml")], TEST_POLICY)).toMatchObject({
      ok: false,
      error: { code: "unsupported_extension" },
    });
    expect(validateUploadFiles([image("payload.constructor", "image/jpeg")], TEST_POLICY)).toMatchObject({
      ok: false,
      error: { code: "unsupported_extension" },
    });
  });

  it("生成不可枚举且互不相同的随机文件名", () => {
    const first = randomUploadFileName("JPG");
    const second = randomUploadFileName("jpg");
    expect(first).toMatch(/^[a-f0-9]{36}\.jpg$/);
    expect(second).toMatch(/^[a-f0-9]{36}\.jpg$/);
    expect(second).not.toBe(first);
  });
});
