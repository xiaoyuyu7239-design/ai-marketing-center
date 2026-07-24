import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * 素材 RAG 评测（可重复执行）：`pnpm vitest run rag-eval`。
 *
 * 评测集 = 人工构造的 22 条「画像 × 商品」query，每条预标注应命中的样本（结构名 / 同城场景关键词）。
 * 指标：召回率@3、类别准确率、检索耗时。断言兼作回归门禁，结果写入 codex交流记忆库/RAG评测结果.json 供 19/20 号文档引用。
 */

interface EvalQuery {
  id: string;
  category: string;
  storeType: "ecommerce" | "local";
  text: string;
  /** exact=商品描述与模板用词高度重叠；paraphrase=换一种口语说法（更考验语义）；local=同城场景 */
  group: "exact" | "paraphrase" | "local";
  /** 结构类：应命中的模板结构名；同城类：应命中的场景关键词（任一即算命中） */
  expectStructure?: string;
  expectLocalKeywords?: string[];
}

const QUERIES: EvalQuery[] = [
  // —— exact：商品描述与模板用词高度重叠（贴近老板真实填写） ——
  { id: "beauty-1", category: "beauty", storeType: "ecommerce", group: "exact", text: "遮瑕粉底液 妆前妆后 斑驳卡粉 素颜出门效果", expectStructure: "素颜逆袭" },
  { id: "beauty-2", category: "beauty", storeType: "ecommerce", group: "exact", text: "30%烟酰胺精华 换季烂脸 暗沉发黄 核心成分", expectStructure: "成分党种草" },
  { id: "beauty-3", category: "beauty", storeType: "ecommerce", group: "exact", text: "唇釉一抹变色 奶茶色 薄涂厚涂 色号", expectStructure: "一抹变色" },
  { id: "beauty-4", category: "beauty", storeType: "ecommerce", group: "exact", text: "约会妆教 底妆眼影腮红唇妆 分步骤", expectStructure: "约会妆教" },
  { id: "food-1", category: "food", storeType: "ecommerce", group: "exact", text: "零食试吃测评 坚果饮品糕点 真实好吃", expectStructure: "试吃测评" },
  { id: "food-2", category: "food", storeType: "ecommerce", group: "exact", text: "预制菜调味料 懒人快手食谱 半成品", expectStructure: "懒人食谱" },
  { id: "food-3", category: "food", storeType: "ecommerce", group: "exact", text: "办公室分享装零食 巧克力果干 下午茶投喂", expectStructure: "办公室投喂" },
  { id: "food-4", category: "food", storeType: "ecommerce", group: "exact", text: "夜宵泡面卤味烧烤 深夜越看越饿", expectStructure: "深夜放毒" },
  { id: "food-5", category: "food", storeType: "ecommerce", group: "exact", text: "低卡代餐蛋白棒 无糖有机 健康轻食", expectStructure: "健康轻食" },
  { id: "home-1", category: "home", storeType: "ecommerce", group: "exact", text: "清洁用品收纳工具 除湿除味 痛点解决", expectStructure: "痛点解决方案" },
  { id: "home-2", category: "home", storeType: "ecommerce", group: "exact", text: "扫地机器人洗碗机 洗衣凝珠 解放双手家务", expectStructure: "家务革命" },
  { id: "home-3", category: "home", storeType: "ecommerce", group: "exact", text: "出租屋改造 墙贴灯带置物架 焕新", expectStructure: "出租屋改造" },
  { id: "home-4", category: "home", storeType: "ecommerce", group: "exact", text: "香薰家纺床品 桌面摆件 好物开箱", expectStructure: "好物开箱" },
  { id: "fashion-1", category: "fashion", storeType: "ecommerce", group: "exact", text: "连衣裙外套 一整套穿搭变身", expectStructure: "穿搭变身" },
  { id: "fashion-2", category: "fashion", storeType: "ecommerce", group: "exact", text: "显瘦遮肉连衣裙 大码小个子 身材焦虑", expectStructure: "身材焦虑终结" },
  { id: "fashion-3", category: "fashion", storeType: "ecommerce", group: "exact", text: "羽绒服防晒衣 换季新品 季节换新", expectStructure: "季节换新" },
  { id: "tech-1", category: "tech", storeType: "ecommerce", group: "exact", text: "手机耳机智能手表 新品开箱首测", expectStructure: "开箱首测" },
  { id: "tech-2", category: "tech", storeType: "ecommerce", group: "exact", text: "充电宝蓝牙耳机数据线 对比横评谁更好", expectStructure: "对比横评" },
  { id: "tech-3", category: "tech", storeType: "ecommerce", group: "exact", text: "键盘显示器扩展坞 效率神器提升", expectStructure: "效率神器" },
  // —— paraphrase：换口语说法、少直接抄模板用词（更考验字面语义鲁棒性） ——
  { id: "para-beauty", category: "beauty", storeType: "ecommerce", group: "paraphrase", text: "一上妆就浮粉卡纹，痘印怎么都遮不住，想要看不出化过的伪素颜", expectStructure: "素颜逆袭" },
  { id: "para-food", category: "food", storeType: "ecommerce", group: "paraphrase", text: "加班到很晚肚子饿，想来点重口味的宵夜解解馋", expectStructure: "深夜放毒" },
  { id: "para-home", category: "home", storeType: "ecommerce", group: "paraphrase", text: "家里乱糟糟收拾不过来，还老有异味，想找点能帮上忙的小东西", expectStructure: "痛点解决方案" },
  { id: "para-tech", category: "tech", storeType: "ecommerce", group: "paraphrase", text: "几款充电宝到底哪个更耐用更值，帮我横向比一比", expectStructure: "对比横评" },
  // —— 同城门店 ——
  { id: "local-1", category: "food", storeType: "local", group: "local", text: "深夜食堂 今晚吃什么 下班觅食", expectLocalKeywords: ["深夜食堂", "觅食", "下班"] },
  { id: "local-2", category: "food", storeType: "local", group: "local", text: "同城探店打卡 周末去哪儿", expectLocalKeywords: ["探店", "打卡", "周末"] },
  { id: "local-3", category: "beauty", storeType: "local", group: "local", text: "换季换发型 素人变身 前后对比", expectLocalKeywords: ["换发型", "before", "对比", "变身"] },
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

describe("素材 RAG 评测", () => {
  let dataDir: string;
  let rag: typeof import("@backend/core/rag");
  let corpusSize = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "huimai-rag-eval-"));
    process.env.APP_DATA_DIR = dataDir;
    delete process.env.HUIMAI_RAG_EMBEDDER; // 词法编码器基线
    rag = await import("@backend/core/rag");
    const seed = await rag.seedRagSamples();
    corpusSize = seed.count;
  });

  afterAll(() => {
    delete process.env.APP_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("召回率@3 / 类别准确率 / 检索耗时达标并留档", async () => {
    let recallHits = 0;
    let categoryMatched = 0;
    let categoryTotal = 0;
    const latencies: number[] = [];
    const perQuery: Array<{ id: string; group: string; hit: boolean; topNames: string[]; ms: number }> = [];
    const groupTotals: Record<string, { hit: number; total: number }> = {};

    // 预热一次，排除首个查询的库加载/缓存冷启动对耗时统计的干扰
    await rag.retrieveRagSamples({ text: QUERIES[0].text, category: QUERIES[0].category, storeType: QUERIES[0].storeType });

    for (const q of QUERIES) {
      const t0 = Date.now();
      const res = await rag.retrieveRagSamples({ text: q.text, category: q.category, storeType: q.storeType }, { topK: 3 });
      const ms = Date.now() - t0;
      latencies.push(ms);

      const top = res.hits.map((h) => h.sample);
      const topNames = top.map((s) => s.structure?.name ?? s.scene ?? s.id);

      let hit = false;
      if (q.expectStructure) {
        hit = top.some((s) => s.structure?.name === q.expectStructure);
      } else if (q.expectLocalKeywords) {
        hit = top.some(
          (s) =>
            s.source === "local_trend" &&
            q.expectLocalKeywords!.some((kw) => `${s.scene ?? ""}${s.expression ?? ""}`.toLowerCase().includes(kw.toLowerCase())),
        );
      }
      if (hit) recallHits++;
      groupTotals[q.group] ??= { hit: 0, total: 0 };
      groupTotals[q.group].total++;
      if (hit) groupTotals[q.group].hit++;

      for (const s of top) {
        categoryTotal++;
        if (s.category === q.category || s.category === null) categoryMatched++;
      }
      perQuery.push({ id: q.id, group: q.group, hit, topNames, ms });
    }

    const recallAt3 = recallHits / QUERIES.length;
    const categoryAccuracy = categoryMatched / categoryTotal;
    const sortedLat = [...latencies].sort((a, b) => a - b);
    const avgMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const p95Ms = percentile(sortedLat, 95);
    const maxMs = sortedLat[sortedLat.length - 1];

    const recallByGroup: Record<string, number> = {};
    for (const [g, v] of Object.entries(groupTotals)) recallByGroup[g] = Number((v.hit / v.total).toFixed(4));

    const report = {
      generatedAt: new Date().toISOString(),
      embedder: rag.activeEmbedderId(),
      querySet: QUERIES.length,
      corpusSize,
      metrics: {
        recallAt3: Number(recallAt3.toFixed(4)),
        recallAt3ByGroup: recallByGroup,
        categoryAccuracy: Number(categoryAccuracy.toFixed(4)),
        latencyMs: { avg: Number(avgMs.toFixed(2)), p95: p95Ms, max: maxMs },
      },
      missed: perQuery.filter((p) => !p.hit).map((p) => ({ id: p.id, group: p.group, topNames: p.topNames })),
    };

    // 控制台打印 + 落盘留档（供 19/20 号文档引用）
    console.log("\n[RAG 评测报告]\n" + JSON.stringify(report, null, 2) + "\n");
    try {
      writeFileSync(join(process.cwd(), "codex交流记忆库", "RAG评测结果.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    } catch {
      // 落盘失败不影响评测断言
    }

    // 回归门禁（词法编码器基线）
    expect(recallAt3).toBeGreaterThanOrEqual(0.8);
    expect(categoryAccuracy).toBeGreaterThanOrEqual(0.7);
    expect(avgMs).toBeLessThan(50);
  });
});
