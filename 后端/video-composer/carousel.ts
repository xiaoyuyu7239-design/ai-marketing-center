import { dirname, join } from "path";
import { mkdir } from "fs/promises";
import { ffmpegBin } from "@backend/shared/ffmpeg-path";
import { buildDrawtext, resolveChineseFontFile, wrapCaption } from "./composer";

export interface CardVfOpts {
  text: string;
  width: number;
  fontFile?: string;
  fontSize?: number;
  fontColor?: string;
}

export function buildCardVf(opts: CardVfOpts): string {
  const fontSize = opts.fontSize ?? Math.round(opts.width * 0.055);
  const lines = wrapCaption(opts.text, fontSize, opts.width).split("\n");
  const lineH = Math.round(fontSize * 1.5);
  const blockH = lines.length * lineH;

  return lines
    .map((line, index) =>
      buildDrawtext({
        fontFile: opts.fontFile,
        text: line || " ",
        fontSize,
        fontColor: opts.fontColor ?? "white",
        borderW: Math.max(2, Math.round(opts.width * 0.004)),
        x: "(w-text_w)/2",
        y: `(h-${blockH})/2+${index * lineH}`,
      })
    )
    .join(",");
}

export const CARD_THEMES: Record<string, { gradient: [string, string]; fontColor: string }> = {
  night: { gradient: ["0x0b0b12", "0x2a1248"], fontColor: "white" },
  warm: { gradient: ["0x2a0e05", "0x6b2810"], fontColor: "white" },
  mint: { gradient: ["0x07231a", "0x0f4a32"], fontColor: "white" },
  mono: { gradient: ["0x111111", "0x2b2b2b"], fontColor: "white" },
  rose: { gradient: ["0x2a0a1a", "0x6b1040"], fontColor: "white" },
};

export function resolveCardTheme(name?: string) {
  return CARD_THEMES[(name || "").toLowerCase()] ?? CARD_THEMES.night;
}

export async function generateCard(opts: {
  text: string;
  outPath: string;
  width: number;
  height: number;
  fontFile?: string;
  fontSize?: number;
  fontColor?: string;
  gradient?: [string, string];
}): Promise<void> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const run = promisify(execFile);
  const [c0, c1] = opts.gradient ?? ["0x0b0b12", "0x2a1248"];
  const vf = buildCardVf({
    text: opts.text,
    width: opts.width,
    fontFile: opts.fontFile,
    fontSize: opts.fontSize,
    fontColor: opts.fontColor,
  });
  await mkdir(dirname(opts.outPath), { recursive: true });
  await run(ffmpegBin(), [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `gradients=s=${opts.width}x${opts.height}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${opts.width}:y1=${opts.height}`,
    "-vf",
    vf,
    "-frames:v",
    "1",
    opts.outPath,
  ]);
}

const MAX_CARDS = 12;

export async function generateCarousel(opts: {
  title: string;
  shots: Array<{ voiceover?: string }>;
  outDir: string;
  prefix: string;
  width: number;
  height: number;
  fontFile?: string;
  theme?: string;
}): Promise<string[]> {
  const fontFile = opts.fontFile ?? resolveChineseFontFile();
  const theme = resolveCardTheme(opts.theme);
  const paths: string[] = [];

  const titlePath = join(opts.outDir, `${opts.prefix}-0.png`);
  await generateCard({
    text: opts.title,
    outPath: titlePath,
    width: opts.width,
    height: opts.height,
    fontFile,
    fontSize: Math.round(opts.width * 0.085),
    gradient: theme.gradient,
    fontColor: theme.fontColor,
  });
  paths.push(titlePath);

  let index = 1;
  for (const shot of opts.shots) {
    if (index > MAX_CARDS) break;
    const text = (shot.voiceover ?? "").trim();
    if (!text) continue;
    const path = join(opts.outDir, `${opts.prefix}-${index}.png`);
    await generateCard({
      text: `${index}. ${text}`,
      outPath: path,
      width: opts.width,
      height: opts.height,
      fontFile,
      gradient: theme.gradient,
      fontColor: theme.fontColor,
    });
    paths.push(path);
    index++;
  }

  return paths;
}
