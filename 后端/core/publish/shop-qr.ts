import { dirname } from "path";
import { mkdir } from "fs/promises";
import QRCode from "qrcode";
import { buildShopLink, type ShopLinkOpts } from "./shop-link";

export interface ShopQrOptions extends ShopLinkOpts {
  size?: number;
  margin?: number;
  dark?: string;
  light?: string;
}

export async function generateShopQr(
  shopUrl: string,
  outPath: string,
  opts: ShopQrOptions = {}
): Promise<string> {
  const link = buildShopLink(shopUrl, opts);
  if (!link) throw new Error("无效的商品链接，无法生成二维码");

  const width = Math.min(2048, Math.max(128, Math.round(opts.size ?? 512)));
  await mkdir(dirname(outPath), { recursive: true });
  await QRCode.toFile(outPath, link, {
    type: "png",
    width,
    margin: Math.max(0, Math.round(opts.margin ?? 2)),
    color: {
      dark: opts.dark || "#000000",
      light: opts.light || "#FFFFFF",
    },
    errorCorrectionLevel: "M",
  });

  return link;
}
