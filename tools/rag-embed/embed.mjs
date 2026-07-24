#!/usr/bin/env node
/**
 * 可选神经编码器（bge-small-zh-v1.5 via transformers.js / ONNX）。
 *
 * 定位：素材 RAG 的「语义排序」升级项。默认不启用；主程序走零依赖词法编码器。
 * 启用方式：在本目录 `pnpm install`（首跑联网下载模型，随后离线），
 *   再设 `HUIMAI_RAG_EMBEDDER=neural` 让主程序按子进程调用本工具。
 *
 * 协议（与 后端/core/rag/embed.ts 约定一致）：
 *   stdin  : JSON { "texts": string[] }
 *   stdout : JSON { "vectors": number[][] }   // 每条 512 维、均值池化 + L2 归一
 * 只输出一行 JSON，供主程序安全解析；任何异常以非 0 退出，主程序自动回退词法编码器。
 *
 * 隔离原因：仿 tools/matting，把重依赖（onnxruntime/transformers）关在子工具目录，
 * 不进主程序 webpack/standalone，避免 512MiB 体积门禁与 CUDA 库误下载问题。
 */
import { pipeline, env } from "@xenova/transformers";

// 只用本地/缓存模型，禁用远程动态加载路径之外的行为；允许首跑下载到本地缓存
env.allowLocalModels = true;

const MODEL_ID = process.env.HUIMAI_RAG_EMBED_MODEL || "Xenova/bge-small-zh-v1.5";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const raw = await readStdin();
  const { texts } = JSON.parse(raw || "{}");
  if (!Array.isArray(texts)) {
    process.stderr.write("input must be { texts: string[] }\n");
    process.exit(2);
  }
  if (texts.length === 0) {
    process.stdout.write(JSON.stringify({ vectors: [] }));
    return;
  }

  const extractor = await pipeline("feature-extraction", MODEL_ID);
  // 均值池化 + L2 归一，得到句向量；bge 系列推荐检索时对 query 加指令前缀，这里语料/查询对称，先不加以保持简单
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const vectors = output.tolist();
  process.stdout.write(JSON.stringify({ vectors }));
}

main().catch((err) => {
  process.stderr.write(`rag-embed failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
