import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";

// 从零建库跑一遍全部 drizzle 迁移，验证迁移链本身不出错，以及商家/套餐/租户外键关系可用。
// 用真实的 @backend/db 模块（非 mock），靠 APP_DATA_DIR 指向临时目录隔离，不碰开发用的 data/sqlite.db。
describe("数据库迁移链", () => {
  let dataDir: string;
  let dbModule: typeof import("@backend/db");
  let schema: typeof import("@backend/db/schema");

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "clipforge-db-test-"));
    process.env.APP_DATA_DIR = dataDir;
    dbModule = await import("@backend/db");
    schema = await import("@backend/db/schema");
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("全部迁移可在空库上应用成功", () => {
    // beforeAll 阶段导入 @backend/db 时已经跑过迁移；能走到这里说明没有抛错
    expect(dbModule.db).toBeTruthy();
  });

  it("应用 28 条迁移并落到 0027 素材 RAG 最终 schema", () => {
    const sqlite = new Database(join(dataDir, "sqlite.db"), { readonly: true, fileMustExist: true });
    try {
      expect(sqlite.prepare("SELECT count(*) AS count FROM __drizzle_migrations").get()).toEqual({ count: 28 });
      const jobColumns = sqlite.prepare("PRAGMA table_info('motion_video_jobs')").all() as Array<{ name: string }>;
      const assessmentColumns = sqlite.prepare("PRAGMA table_info('motion_asset_assessments')").all() as Array<{ name: string }>;
      expect(jobColumns.map((column) => column.name)).toContain("output_clip_id");
      expect(jobColumns.map((column) => column.name)).toContain("error_request_id");
      expect(jobColumns.map((column) => column.name)).not.toContain("output_asset_id");
      expect(assessmentColumns.map((column) => column.name)).toContain("face_detector_revision");
      // 0027 素材 RAG 知识库表落库
      const ragColumns = sqlite.prepare("PRAGMA table_info('rag_samples')").all() as Array<{ name: string }>;
      expect(ragColumns.map((column) => column.name)).toContain("search_text");
      expect(ragColumns.map((column) => column.name)).toContain("embedding");
    } finally {
      sqlite.close();
    }
  });

  it("启动时已幂等种入默认 trial 套餐", async () => {
    const { db } = dbModule;
    const { plans } = schema;
    const [plan] = await db.select().from(plans).where(eq(plans.id, "trial"));
    expect(plan).toBeTruthy();
    expect(plan.monthlyGenerationQuota).toBeGreaterThan(0);
  });

  it("商家 → 套餐 / 商家 → 项目 的外键关系可正常写入", async () => {
    const { db } = dbModule;
    const { merchants, projects } = schema;

    const [merchant] = await db
      .insert(merchants)
      .values({ email: "owner@example.com", passwordHash: "salt:hash", planId: "trial" })
      .returning();
    expect(merchant.planId).toBe("trial");

    const [project] = await db
      .insert(projects)
      .values({ name: "测试项目", merchantId: merchant.id })
      .returning();
    expect(project.merchantId).toBe(merchant.id);
  });

  it("启动清理会幂等删除旧版明文视频 fallback 设置", async () => {
    const { db, scrubDeprecatedSensitiveSettings } = dbModule;
    const { settings } = schema;
    await db.insert(settings).values({
      key: "video_face_fallback",
      value: { apiKey: "must-be-removed", model: "legacy" },
    });

    expect(scrubDeprecatedSensitiveSettings()).toBe(1);
    expect(await db.select().from(settings).where(eq(settings.key, "video_face_fallback"))).toEqual([]);
    expect(scrubDeprecatedSensitiveSettings()).toBe(0);
  });

  it("0026 可从已落库的 output_asset_id 草案无损升级，不让旧库 worker 空转", () => {
    const upgradeDir = mkdtempSync(join(tmpdir(), "huimai-motion-schema-upgrade-"));
    const sqlite = new Database(join(upgradeDir, "sqlite.db"));
    try {
      sqlite.pragma("foreign_keys = ON");
      sqlite.exec(`
        CREATE TABLE merchants (id text PRIMARY KEY NOT NULL);
        CREATE TABLE projects (id text PRIMARY KEY NOT NULL, merchant_id text NOT NULL REFERENCES merchants(id));
        CREATE TABLE generation_usage (id text PRIMARY KEY NOT NULL);
        CREATE TABLE generation_operation_items (id text PRIMARY KEY NOT NULL);
        CREATE TABLE assets (id text PRIMARY KEY NOT NULL, project_id text NOT NULL REFERENCES projects(id));
        CREATE TABLE video_clips (
          id text PRIMARY KEY NOT NULL,
          project_id text NOT NULL REFERENCES projects(id),
          shot_id integer NOT NULL,
          asset_id text REFERENCES assets(id),
          file_path text,
          duration integer,
          provider text,
          model text,
          transition_type text,
          status text NOT NULL,
          created_at integer
        );
      `);
      sqlite.exec(readFileSync(join(process.cwd(), "drizzle", "0024_persistent_motion_video_jobs.sql"), "utf8"));
      sqlite.exec(`
        INSERT INTO merchants (id) VALUES ('merchant-1');
        INSERT INTO projects (id, merchant_id) VALUES ('project-1', 'merchant-1');
        INSERT INTO generation_usage (id) VALUES ('usage-1');
        INSERT INTO generation_operation_items (id) VALUES ('item-1');
        INSERT INTO assets (id, project_id) VALUES ('source-asset-1', 'project-1'), ('legacy-output-asset-1', 'project-1');
        INSERT INTO motion_video_jobs (
          id, merchant_id, project_id, generation_usage_id, generation_item_id,
          operation_key, item_key, request_hash, shot_id, source_asset_id, payload,
          status, remote_task_id, output_asset_id, output_file_path, paid_capability_used
        ) VALUES (
          'job-legacy-1', 'merchant-1', 'project-1', 'usage-1', 'item-1',
          'motion-legacy', 'shot:1', '${"a".repeat(64)}', 1, 'source-asset-1', '{}',
          'succeeded', 'remote-1', 'legacy-output-asset-1', '/api/files/project-1/legacy.mp4', 1
        );
      `);
      sqlite.exec(readFileSync(join(process.cwd(), "drizzle", "0026_motion_job_schema_upgrade.sql"), "utf8"));

      const columns = sqlite.prepare("PRAGMA table_info('motion_video_jobs')").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toContain("output_clip_id");
      expect(columns.map((column) => column.name)).toContain("error_request_id");
      expect(columns.map((column) => column.name)).not.toContain("output_asset_id");
      expect(sqlite.prepare("SELECT status, output_clip_id AS outputClipId FROM motion_video_jobs WHERE id = ?")
        .get("job-legacy-1")).toEqual({
        status: "succeeded",
        outputClipId: "motion-migrated-job-legacy-1",
      });
      expect(sqlite.prepare("SELECT project_id AS projectId, asset_id AS assetId, file_path AS filePath, status FROM video_clips WHERE id = ?")
        .get("motion-migrated-job-legacy-1")).toEqual({
        projectId: "project-1",
        assetId: "source-asset-1",
        filePath: "/api/files/project-1/legacy.mp4",
        status: "done",
      });
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(() => sqlite.prepare("DELETE FROM video_clips WHERE id = ?").run("motion-migrated-job-legacy-1"))
        .toThrow();
    } finally {
      sqlite.close();
      rmSync(upgradeDir, { recursive: true, force: true });
    }
  });
});
