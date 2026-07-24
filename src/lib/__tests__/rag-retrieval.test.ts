import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { buildUserPrompt } from "@backend/script-engine/prompts";
import type { RagSampleRecord } from "@backend/core/rag";

// 用 APP_DATA_DIR 指向临时库，动态导入 rag 模块（导入 @backend/db 会跑迁移），不碰开发用的 data/sqlite.db。
// 纯过滤/排序/降级/格式化用注入样本，不依赖 DB；末尾单独验证真实灌库 → 检索的落库回环。
describe("素材 RAG 检索", () => {
  let dataDir: string;
  let rag: typeof import("@backend/core/rag");

  const SAMPLES: RagSampleRecord[] = [
    {
      id: "template:beauty:0",
      category: "beauty",
      storeType: null,
      structure: { name: "素颜逆袭", shots: [{ type: "hook", duration: 3 }, { type: "cta", duration: 4 }] },
      expression: "素颜怼脸，痘印斑点清晰可见",
      searchText: "美妆护肤 素颜逆袭 妆前妆后对比 底妆斑驳卡粉 遮瑕 粉底液",
      source: "template",
    },
    {
      id: "template:food:0",
      category: "food",
      storeType: null,
      structure: { name: "爆浆特写", shots: [{ type: "hook", duration: 3 }] },
      expression: "爆浆拉丝瞬间",
      searchText: "食品零食 爆浆 拉丝 微距 质地特写 诱人",
      source: "template",
    },
    {
      id: "hook:visual_shock",
      category: null,
      storeType: null,
      expression: "【视觉冲击】镜头怼上一擦就破的纸巾——你家现在用的是不是这种？",
      searchText: "视觉冲击 极致画面 爆浆 拉丝 脏净对比 微距质地",
      source: "hook",
    },
    {
      id: "local_trend:common:0",
      category: null,
      storeType: "local",
      expression: "同城探店 / 打卡：把门店做成同城人今天去哪儿的答案",
      searchText: "同城探店 打卡 门店 同城客流",
      source: "local_trend",
    },
    {
      id: "local_trend:food:0",
      category: "food",
      storeType: "local",
      expression: "深夜食堂：晚饭点前 1-2 小时发，接住今晚吃什么",
      searchText: "下班觅食 深夜食堂 今晚吃什么 晚饭",
      source: "local_trend",
    },
    {
      id: "user_template:sd",
      category: "beauty",
      storeType: null,
      videoMode: "scene_demo",
      styleType: "story",
      expression: "场景演示脚本",
      searchText: "美妆 场景演示 故事线",
      source: "user_template",
    },
  ];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-rag-test-"));
    process.env.APP_DATA_DIR = dataDir;
    delete process.env.HUIMAI_RAG_EMBEDDER; // 强制默认词法编码器
    rag = await import("@backend/core/rag");
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ============ 一级结构化硬过滤正确性 ============
  describe("结构化硬过滤", () => {
    it("电商美妆：排除异品类与同城样本，保留通用样本", () => {
      const ids = rag
        .structuralFilter(SAMPLES, { text: "", category: "beauty", storeType: "ecommerce" })
        .map((s) => s.id);
      expect(ids).toContain("template:beauty:0"); // 同品类
      expect(ids).toContain("hook:visual_shock"); // 通用（category=null）
      expect(ids).not.toContain("template:food:0"); // 异品类剔除
      expect(ids).not.toContain("local_trend:common:0"); // 同城样本对电商剔除
      expect(ids).not.toContain("local_trend:food:0");
    });

    it("同城食品门店：召回同城样本 + 通用样本，剔除异品类", () => {
      const ids = rag
        .structuralFilter(SAMPLES, { text: "", category: "food", storeType: "local" })
        .map((s) => s.id);
      expect(ids).toContain("template:food:0");
      expect(ids).toContain("hook:visual_shock");
      expect(ids).toContain("local_trend:common:0"); // 通用同城
      expect(ids).toContain("local_trend:food:0");
      expect(ids).not.toContain("template:beauty:0"); // 异品类剔除
    });

    it("显式声明冲突才排除：videoMode/styleType 不匹配剔除已声明的样本", () => {
      const declared = rag.structuralFilter(SAMPLES, {
        text: "",
        category: "beauty",
        storeType: "ecommerce",
        videoMode: "product_closeup",
      });
      // user_template:sd 声明了 videoMode=scene_demo，与查询 product_closeup 冲突 → 剔除
      expect(declared.map((s) => s.id)).not.toContain("user_template:sd");
      // 未声明 videoMode 的 template:beauty:0 不受影响
      expect(declared.map((s) => s.id)).toContain("template:beauty:0");
    });
  });

  // ============ 二级语义排序 ============
  describe("语义排序", () => {
    it("命中语义最贴近的同品类结构样本，走 semantic 链路", async () => {
      const res = await rag.retrieveRagSamples(
        { text: "换季烂脸 妆前妆后对比 底妆卡粉怎么救", category: "beauty", storeType: "ecommerce" },
        { samples: SAMPLES },
      );
      expect(res.mode).toBe("semantic");
      expect(res.hits[0].sample.id).toBe("template:beauty:0");
      expect(res.hits[0].semantic).toBe(true);
      expect(res.hits.length).toBeLessThanOrEqual(3);
    });

    it("topK 生效", async () => {
      const res = await rag.retrieveRagSamples(
        { text: "画面 质地 特写", category: "food", storeType: "ecommerce" },
        { samples: SAMPLES, topK: 1 },
      );
      expect(res.hits.length).toBe(1);
    });
  });

  // ============ 降级链 ============
  describe("降级链", () => {
    it("编码器抛错 → 结构化降级，仍返回候选（非空）", async () => {
      const res = await rag.retrieveRagSamples(
        { text: "任意查询", category: "beauty", storeType: "ecommerce" },
        {
          samples: SAMPLES,
          embedder: () => {
            throw new Error("embed boom");
          },
        },
      );
      expect(res.mode).toBe("structural");
      expect(res.hits.length).toBeGreaterThan(0);
      expect(res.hits.every((h) => h.semantic === false)).toBe(true);
    });

    it("查询文本为空 → 结构化降级", async () => {
      const res = await rag.retrieveRagSamples(
        { text: "   ", category: "beauty", storeType: "ecommerce" },
        { samples: SAMPLES },
      );
      expect(res.mode).toBe("structural");
      expect(res.hits.length).toBeGreaterThan(0);
    });

    it("过滤无候选 → empty，且 buildRagHint 返回空串", async () => {
      const onlyLocal = SAMPLES.filter((s) => s.id === "local_trend:common:0");
      const res = await rag.retrieveRagSamples(
        { text: "x", category: "beauty", storeType: "ecommerce" },
        { samples: onlyLocal },
      );
      expect(res.mode).toBe("empty");
      expect(res.hits).toEqual([]);
      const hint = await rag.buildRagHint(
        { text: "x", category: "beauty", storeType: "ecommerce" },
        { samples: onlyLocal },
      );
      expect(hint).toBe("");
    });

    it("空语料 → 空串（冷启动等于现状，零风险）", async () => {
      const hint = await rag.buildRagHint({ text: "x", category: "beauty" }, { samples: [] });
      expect(hint).toBe("");
    });
  });

  // ============ 注入格式 ============
  describe("注入提示格式", () => {
    it("电商美妆：含表头与结构参考行", async () => {
      const hint = await rag.buildRagHint(
        { text: "妆前妆后 底妆卡粉", category: "beauty", storeType: "ecommerce" },
        { samples: SAMPLES },
      );
      expect(hint.startsWith("【同行优质结构参考")).toBe(true);
      expect(hint).toContain("参考结构「素颜逆袭」（美妆护肤）");
      expect(hint).toContain("黄金3秒(3s)→行动号召(4s)");
    });

    it("同城门店：含同城场景角度行", async () => {
      const hint = await rag.buildRagHint(
        { text: "今晚吃什么 深夜", category: "food", storeType: "local" },
        { samples: SAMPLES },
      );
      expect(hint).toContain("同城场景角度");
    });
  });

  // ============ 知识库装配 ============
  describe("静态知识库装配", () => {
    it("覆盖三类静态来源，id 唯一且 searchText 非空，确定性可重复", () => {
      const kb = rag.buildStaticKnowledgeBase();
      expect(kb.length).toBeGreaterThan(20);
      const sources = new Set(kb.map((s) => s.source));
      expect(sources.has("template")).toBe(true);
      expect(sources.has("hook")).toBe(true);
      expect(sources.has("local_trend")).toBe(true);
      expect(kb.every((s) => s.searchText.trim().length > 0)).toBe(true);
      const ids = kb.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length); // id 唯一
      // 确定性：两次装配的 id 序列一致
      expect(rag.buildStaticKnowledgeBase().map((s) => s.id)).toEqual(ids);
    });
  });

  // ============ 本地词法编码器 ============
  describe("本地词法编码器", () => {
    it("确定性 + 自相似为 1 + 相关文本高于无关文本", () => {
      const a = rag.lexicalEmbed("换季烂脸 底妆卡粉");
      const a2 = rag.lexicalEmbed("换季烂脸 底妆卡粉");
      expect(a).toEqual(a2);
      expect(rag.cosineSimilarity(a, a2)).toBeCloseTo(1, 5);
      const related = rag.lexicalEmbed("底妆卡粉 换季 烂脸怎么办");
      const unrelated = rag.lexicalEmbed("数码相机 续航 快充");
      expect(rag.cosineSimilarity(a, related)).toBeGreaterThan(rag.cosineSimilarity(a, unrelated));
    });

    it("tokenize 产出字 unigram + bigram", () => {
      const toks = rag.tokenize("底妆");
      expect(toks).toContain("底");
      expect(toks).toContain("妆");
      expect(toks).toContain("底妆");
    });
  });

  // ============ 注入段在最终生成 prompt 中可见（验收清单第 2 项） ============
  describe("RAG 注入段进入最终 prompt", () => {
    it("buildRagHint 产物经 performanceHint 注入后可在 buildUserPrompt 输出中看到", async () => {
      const ragHint = await rag.buildRagHint(
        { text: "妆前妆后 底妆卡粉 遮瑕", category: "beauty", storeType: "ecommerce" },
        { samples: SAMPLES },
      );
      expect(ragHint).not.toBe("");
      const prompt = buildUserPrompt({
        productName: "水润遮瑕粉底液",
        category: "beauty",
        styleType: "pain_point",
        performanceHint: ragHint,
      });
      expect(prompt).toContain("【同行优质结构参考");
      expect(prompt).toContain("参考结构「素颜逆袭」");
    });
  });

  // ============ 神经编码器缺失（断网/删模型）→ 自动回退词法编码器 ============
  describe("神经编码器缺失回退", () => {
    it("HUIMAI_RAG_EMBEDDER=neural 但子工具不存在时，embedBatch 回退词法编码器且仍产出向量", () => {
      const prevFlag = process.env.HUIMAI_RAG_EMBEDDER;
      const prevTool = process.env.HUIMAI_RAG_EMBED_TOOL;
      process.env.HUIMAI_RAG_EMBEDDER = "neural";
      process.env.HUIMAI_RAG_EMBED_TOOL = join(dataDir, "does-not-exist-embed.mjs");
      try {
        const res = rag.embedBatch(["换季烂脸怎么救"]);
        expect(res.embedderId).toBe("lexical-charhash-v1");
        expect(res.vectors[0].length).toBeGreaterThan(0);
      } finally {
        if (prevFlag === undefined) delete process.env.HUIMAI_RAG_EMBEDDER;
        else process.env.HUIMAI_RAG_EMBEDDER = prevFlag;
        if (prevTool === undefined) delete process.env.HUIMAI_RAG_EMBED_TOOL;
        else process.env.HUIMAI_RAG_EMBED_TOOL = prevTool;
      }
    });
  });

  // ============ 真实灌库 → 检索 落库回环 ============
  describe("灌库与落库回环", () => {
    it("首次灌库落库，二次幂等跳过", async () => {
      const first = await rag.seedRagSamples();
      expect(first.count).toBeGreaterThan(20);
      expect(first.embedderId).toBe("lexical-charhash-v1");
      const second = await rag.seedRagSamples();
      expect(second.seeded).toBe(false);
      expect(second.reason).toBe("up-to-date");
    });

    it("默认加载器从库中读出并语义检索命中", async () => {
      const res = await rag.retrieveRagSamples({
        text: "换季烂脸 妆前妆后 底妆卡粉 遮瑕",
        category: "beauty",
        storeType: "ecommerce",
      });
      expect(res.candidateCount).toBeGreaterThan(0);
      expect(res.mode).toBe("semantic");
      expect(res.hits[0].sample.category === "beauty" || res.hits[0].sample.category === null).toBe(true);
    });
  });
});
