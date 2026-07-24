import "server-only";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";

const run = promisify(execFile);

/**
 * 商品图抠图 + 合成（本地免费，零 API）。
 * shell 调用隔离的子工具 tools/matting/matte.mjs（自带 sharp + @imgly 抠图，独立于主项目 pnpm）——
 * 商品像素零改动，彻底消除"图生图重绘"的泛白/脑补，只换纯净背景 + 合成柔和接触阴影。
 * 首次调用会下载抠图模型（~40MB）到子工具缓存，之后离线。失败返回 false（调用方保留原图）。
 */
export async function matteProductImage(
  inputAbsPath: string,
  outputAbsPath: string,
  bgHex?: string
): Promise<boolean> {
  const toolDir = join(/* turbopackIgnore: true */ process.cwd(), "tools", "matting");
  const script = join(/* turbopackIgnore: true */ toolDir, "matte.mjs");
  const args = [script, inputAbsPath, outputAbsPath, ...(bgHex ? [bgHex] : [])];
  try {
    // 首次含模型下载，给足 3 分钟。cwd 必须设为工具目录：@imgly 按 cwd 找它的 resources.json，
    // 从仓库根跑会去主项目 node_modules 找不到而 ENOENT。输入输出都用绝对路径，不受 cwd 影响。
    await run(process.execPath, args, { cwd: toolDir, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    return true;
  } catch (e) {
    console.warn("[matte] 抠图失败，保留原图:", e instanceof Error ? e.message.slice(0, 200) : e);
    return false;
  }
}
