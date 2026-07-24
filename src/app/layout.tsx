import type { Metadata } from "next";
import "./globals.css";
import { LocaleInitializer } from "@frontend/components/locale-initializer";
import { BetaSupportLink } from "@frontend/components/beta-support-link";

export const metadata: Metadata = {
  // 构建环境可回退本机；生产预检强制要求显式 HTTPS 公网地址。
  metadataBase: new URL(process.env.HUIMAI_PUBLIC_BASE_URL || "http://localhost:3000"),
  title: "绘卖AI — 商家短视频创作助手",
  description:
    "面向受邀商家的短视频创作助手：从商品图到脚本、素材、配音、字幕与发布包。",
  keywords: [
    "AI 短视频",
    "带货短视频",
    "AI 视频生成",
    "抖音",
    "快手",
    "小红书",
    "TikTok",
    "text to video",
    "faceless video",
    "AI video generator",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="zh-CN"
      className="dark h-full antialiased"
      suppressHydrationWarning
    >
      <body className="min-h-full flex flex-col bg-background text-foreground" suppressHydrationWarning>
        <LocaleInitializer />
        {children}
        <BetaSupportLink />
      </body>
    </html>
  );
}
