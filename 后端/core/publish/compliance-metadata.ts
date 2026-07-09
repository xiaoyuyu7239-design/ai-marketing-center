/**
 * AIGC 隐式标识（文件元数据）—— 对齐 GB 45438-2025《人工智能生成合成内容标识方法》对「隐式标识」的要求：
 * 在成片文件元数据中写入三要素 ① 生成合成标签 ② 服务提供者 ③ 内容制作编号。
 *
 * 这是国内 2026 发布抖音/快手的硬合规线：仅有画面上可感知的「AI 生成」显式标识（compliance-overlays.ts）还不够，
 * 缺隐式元数据会被平台自动检测判为「未标识 AI 内容」而限流。本文件只产出 ffmpeg `-metadata` 参数，
 * 不触碰 filter_complex（转场/音轨/字幕滤镜），纯命令尾 append，ffprobe 可断言，免 Key 零依赖。
 *
 * 实现说明：MP4 容器对自定义元数据键支持不稳定（可能被丢弃），故把三要素写入可靠回读的标准标签
 * comment / copyright / description，三要素全部编码进 comment 串。
 */

export interface AigcMetadataOpts {
  /** 内容制作编号（用 projectId / compositionId） */
  contentId: string;
  /** 服务提供者名称，默认 ClipForge */
  serviceProvider?: string;
}

/** 去掉在 shell 双引号串里有特殊含义的字符，防注入（值会被拼进 `-metadata k="..."`） */
function sanitize(v: string): string {
  return String(v ?? "").replace(/["$\\`\r\n]/g, "").trim();
}

/** 生成 GB 45438 隐式标识的 ffmpeg `-metadata` 参数串（拼到合成命令尾、输出文件之前）。 */
export function buildAigcMetadataArgs(opts: AigcMetadataOpts): string {
  const provider = sanitize(opts.serviceProvider || "ClipForge") || "ClipForge";
  const id = sanitize(opts.contentId).slice(0, 64) || "unknown";
  // 三要素：生成合成标签(AIGC=1/内容=AI生成合成) + 服务提供者 + 内容制作编号
  const triple = `AIGC=1; 内容=AI生成合成; 服务提供者=${provider}; 内容制作编号=${id}`;
  const fields: Array<[string, string]> = [
    ["comment", triple],
    ["copyright", `AI-generated content by ${provider}`],
    ["description", `本视频含AI生成合成内容（服务提供者:${provider} 编号:${id}）`],
  ];
  return fields.map(([k, v]) => `-metadata ${k}="${v}"`).join(" ");
}
