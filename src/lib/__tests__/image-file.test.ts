import { describe, expect, it } from "vitest";
import { isSupportedImageFile } from "../image-file";

describe("isSupportedImageFile", () => {
  it("accepts standard image MIME types", () => {
    const file = new File(["x"], "product.png", { type: "image/png" });

    expect(isSupportedImageFile(file)).toBe(true);
  });

  it("accepts image files when the browser provides an empty MIME type", () => {
    const file = new File(["x"], "wechat-export.HEIC", { type: "" });

    expect(isSupportedImageFile(file)).toBe(true);
  });

  it("rejects non-image files", () => {
    const file = new File(["x"], "notes.txt", { type: "text/plain" });

    expect(isSupportedImageFile(file)).toBe(false);
  });
});
