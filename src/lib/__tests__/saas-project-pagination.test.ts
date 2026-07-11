import { describe, expect, it } from "vitest";
import {
  decodeProjectCursor,
  encodeProjectCursor,
} from "@server/projects/pagination";

describe("project keyset cursors", () => {
  it("round-trips an ISO timestamp and UUID through base64url", () => {
    const cursor = {
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
      id: "11111111-1111-4111-8111-111111111111",
    };
    expect(decodeProjectCursor(encodeProjectCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed, oversized, or structurally invalid cursors", () => {
    expect(() => decodeProjectCursor("not-json"))
      .toThrow("Invalid project cursor");
    expect(() => decodeProjectCursor("a".repeat(513)))
      .toThrow("Invalid project cursor");
    const invalidId = Buffer.from(JSON.stringify({
      createdAt: "2030-01-01T00:00:00.000Z",
      id: "project-1",
    })).toString("base64url");
    expect(() => decodeProjectCursor(invalidId))
      .toThrow("Invalid project cursor");
  });
});
