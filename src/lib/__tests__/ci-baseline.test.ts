import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import packageJson from "../../../package.json";

describe("CI baseline", () => {
  it("defines typecheck locally and runs it in GitHub Actions", () => {
    const workflow = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");

    expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
    expect(workflow).toContain("run: pnpm typecheck");
  });
});
