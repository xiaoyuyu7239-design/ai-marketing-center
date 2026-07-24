# RAG 神经编码器子工具（可选）

素材 RAG 的**语义排序升级项**。默认**不启用**——主程序 `后端/core/rag/embed.ts` 走零依赖、离线、确定性的「词法编码器」（`lexical-charhash-v1`），已足够对同品类候选做重排，且符合项目「不烧付费余额 / 免费兜底」纪律。

本子工具把重依赖（`@xenova/transformers` / onnxruntime）隔离在独立目录，**不进主程序 webpack / standalone 产物**，与 `tools/matting` 同一套隔离思路，避免 512MiB 体积门禁与 CUDA 库误下载。

## 何时启用

需要更强中文语义匹配（近义、改写、跨表述召回）时。词法编码器只吃字面重叠，神经编码器（bge-small-zh-v1.5, 512 维）能召回语义相近但用词不同的样本。

## 启用步骤

```bash
# 1. 安装依赖（首次联网，下载模型到本地缓存，随后可离线）
cd tools/rag-embed && pnpm install

# 2. 让主程序启用神经编码器
export HUIMAI_RAG_EMBEDDER=neural
# 可选：自定义模型 / 子工具路径
# export HUIMAI_RAG_EMBED_MODEL=Xenova/bge-small-zh-v1.5
# export HUIMAI_RAG_EMBED_TOOL=/abs/path/to/tools/rag-embed/embed.mjs
```

启用后：知识库会按新编码器标识**自动重灌 embedding**（`seedVersion + embeddingModel` 幂等判定），检索器 query 与候选都改用神经向量。任何子工具/模型失败都会**自动回退词法编码器**，不影响出片。

## 协议

- stdin：`{ "texts": string[] }`
- stdout：`{ "vectors": number[][] }`（每条 512 维、均值池化 + L2 归一，一行 JSON）
- 失败：非 0 退出 + stderr 说明；主程序据此回退。

## 自测

```bash
echo '{"texts":["换季烂脸怎么救","家里纸巾一擦就破"]}' | node embed.mjs
```
