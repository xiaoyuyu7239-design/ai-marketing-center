import { describe, it, expect, afterEach } from "vitest";
import { join } from "path";
import { getDataDir, getMigrationsDir, getUploadsDir, getOutputDir } from "@backend/shared/paths";

const origData = process.env.APP_DATA_DIR;
const origMig = process.env.APP_MIGRATIONS_DIR;

afterEach(() => {
  if (origData === undefined) delete process.env.APP_DATA_DIR;
  else process.env.APP_DATA_DIR = origData;
  if (origMig === undefined) delete process.env.APP_MIGRATIONS_DIR;
  else process.env.APP_MIGRATIONS_DIR = origMig;
});

describe("paths 运行时路径解析", () => {
  it("未注入环境变量时回退到 cwd/data（开发态行为不变）", () => {
    delete process.env.APP_DATA_DIR;
    expect(getDataDir()).toBe(join(process.cwd(), "data"));
    expect(getUploadsDir()).toBe(join(process.cwd(), "data", "uploads"));
    expect(getOutputDir()).toBe(join(process.cwd(), "data", "output"));
  });

  it("注入 APP_DATA_DIR 时所有可写路径都迁过去（Electron 打包关键）", () => {
    process.env.APP_DATA_DIR = "/tmp/daihuo-userdata";
    expect(getDataDir()).toBe("/tmp/daihuo-userdata");
    expect(getUploadsDir()).toBe("/tmp/daihuo-userdata/uploads");
    expect(getOutputDir()).toBe("/tmp/daihuo-userdata/output");
  });

  it("迁移目录可单独注入（只读资源与可写数据分离）", () => {
    delete process.env.APP_MIGRATIONS_DIR;
    expect(getMigrationsDir()).toBe(join(process.cwd(), "drizzle"));
    process.env.APP_MIGRATIONS_DIR = "/res/drizzle";
    expect(getMigrationsDir()).toBe("/res/drizzle");
  });
});
