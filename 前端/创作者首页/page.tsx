"use client";

/**
 * 新版「先做后配」落地页（暗色创作台方向）。
 * 作为新路由 /start 独立存在，不动正在被 i18n 改写的首页；
 * 首屏 CTA 引导用户进入登录页，后续模型策略由工作人员后台统一维护。
 */

import Link from "next/link";
import { Play, Settings } from "lucide-react";
import { useT, useLocale, useSetLocale } from "@frontend/i18n";
import { LOCALES, LOCALE_LABELS } from "@frontend/i18n/config";
import { BrandWheatMark } from "@frontend/components/brand-wheat-logo";

export default function StartPage() {
  const t = useT("start");
  const locale = useLocale();
  const setLocale = useSetLocale();
  // 语言切换（中文 ⇄ English）
  const toggleLocale = () => setLocale(LOCALES[(LOCALES.indexOf(locale) + 1) % LOCALES.length]);

  return (
    <div className="cf-root">
      <style>{`
        .cf-root{--teal:#58E6D8;--teal2:#6FF7EA;--ink:#05211D;--text:#121418;--dim:#596171;--muted:#7B8494;--surface:#FFFFFF;--surface2:#F7FAFC;--bd:#E7EBF0;--bd2:#D9E0E8;
          min-height:100vh;background:#FFFFFF;color:var(--text);position:relative;overflow:hidden;
          font-family:ui-sans-serif,"PingFang SC","Microsoft YaHei",system-ui,-apple-system,"Segoe UI",sans-serif;}
        .cf-bg-video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;pointer-events:none}
        .cf-amb{display:none}
        .cf-grid{display:none}
        .cf-wrap{position:relative;z-index:1;max-width:1240px;min-height:100vh;margin:0 auto;padding:0 28px;display:flex;flex-direction:column}
        .cf-nav{display:flex;align-items:center;justify-content:space-between;height:78px;flex:0 0 auto}
        .cf-brand{display:flex;align-items:center;color:#111827}
        .cf-mark{width:38px;height:46px;display:grid;place-items:center}
        .cf-brand-name{font-family:"STKaiti","Kaiti SC","KaiTi","Songti SC",serif;font-size:27px;font-weight:800;line-height:1;letter-spacing:.08em;color:#111827;text-shadow:0 1px 0 rgba(255,255,255,.8)}
        .cf-gear{width:34px;height:34px;border-radius:999px;border:1px solid var(--bd);background:#fff;color:#4B5563;display:grid;place-items:center;transition:.18s}
        .cf-gear:hover{color:#111827;border-color:#C7D0DC;background:#F8FAFC}
        .cf-nav-r{display:flex;align-items:center;gap:8px}
        .cf-nlink{font-size:14px;font-weight:600;color:#394150;text-decoration:none;padding:7px 11px;border-radius:999px;border:1px solid transparent;transition:.18s}
        .cf-nlink:hover{color:#111827;border-color:var(--bd)}
        .cf-hero{flex:1;min-height:calc(100vh - 78px);display:flex;align-items:flex-end;justify-content:center;padding:0 0 clamp(64px,13vh,118px);text-align:center}
        .cf-center{width:100%;display:flex;flex-direction:column;align-items:center;gap:0}
        .cf-h1{font-family:"STXingkai","Xingkai SC","HanziPen SC","Kaiti SC","KaiTi","STKaiti",serif;font-weight:800;font-size:clamp(19px,1.85vw,26px);line-height:1.15;letter-spacing:.03em;margin:0;color:#FFFFFF;text-shadow:0 2px 0 rgba(255,255,255,.22),0 6px 16px rgba(5,22,32,.42),0 0 18px rgba(140,218,255,.24);-webkit-text-stroke:.2px rgba(255,255,255,.4)}
        .cf-h1 .hl{color:inherit;text-shadow:inherit}
        .cf-command-wrap{width:min(330px,100%);position:relative}
        .cf-command{width:100%;display:flex;align-items:center;padding:7px;border:1px solid rgba(255,255,255,.42);border-radius:13px;background:rgba(255,255,255,.24);backdrop-filter:blur(18px) saturate(108%);-webkit-backdrop-filter:blur(18px) saturate(108%);box-shadow:0 14px 34px -30px rgba(17,24,39,.28),0 1px 0 rgba(255,255,255,.46) inset;transition:border-color .18s,box-shadow .18s}
        .cf-command:hover{border-color:rgba(255,255,255,.52);box-shadow:0 0 0 3px rgba(255,255,255,.08),0 16px 38px -32px rgba(17,24,39,.28),0 1px 0 rgba(255,255,255,.5) inset}
        .cf-cta{height:52px;width:100%;padding:0 14px 0 20px;border:0;border-radius:9px;background:linear-gradient(135deg,rgba(245,247,250,.66),rgba(187,195,205,.54));color:#343A43;font:inherit;font-size:15px;font-weight:760;letter-spacing:.09em;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:12px;white-space:nowrap;box-shadow:0 10px 22px -18px rgba(78,86,98,.38);transition:transform .18s,box-shadow .18s,background .18s}
        .cf-cta:hover{transform:translateY(-1px);background:linear-gradient(135deg,rgba(248,250,252,.72),rgba(196,204,214,.6));box-shadow:0 14px 26px -20px rgba(17,24,39,.36)}
        .cf-cta:focus-visible{outline:3px solid rgba(255,255,255,.8);outline-offset:4px}
        .cf-cta-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
        .cf-play{width:32px;height:32px;flex:0 0 32px;border-radius:999px;background:rgba(52,58,67,.12);color:#3F4650;display:grid;place-items:center;box-shadow:0 6px 16px -12px rgba(17,24,39,.42)}
        .cf-play svg{fill:currentColor;margin-left:2px}
        @media (max-width:720px){
          .cf-wrap{padding:0 16px}
          .cf-nav-r{gap:2px}
          .cf-nlink{padding:7px 8px}
          .cf-hero{padding-bottom:clamp(54px,11vh,72px)}
          .cf-center{gap:0}
          .cf-h1{font-size:18px;line-height:1.15}
          .cf-command-wrap{width:min(318px,100%)}
          .cf-command{padding:6px;border-radius:12px}
          .cf-cta{height:48px;border-radius:8px;font-size:14px;padding:0 12px 0 17px;gap:10px}
          .cf-play{width:30px;height:30px;flex-basis:30px}
        }
        @media (max-width:520px){
          .cf-brand{font-size:0}
          .cf-brand-name{display:none}
        }
      `}</style>

      <video className="cf-bg-video" autoPlay muted loop playsInline preload="auto" aria-hidden="true">
        <source src="/showcase-bg.mp4" type="video/mp4" />
      </video>
      <div className="cf-amb" />
      <div className="cf-grid" />
      <div className="cf-wrap">
        <nav className="cf-nav">
          <div className="cf-brand">
            <span className="cf-mark">
              <BrandWheatMark className="h-[46px] w-[34px] text-[#111827]" style={{ opacity: 0.9, filter: "drop-shadow(0 4px 8px rgba(255,255,255,.2))" }} />
            </span>
          </div>
          <div className="cf-nav-r">
            <button type="button" onClick={toggleLocale} className="cf-nlink" title={locale === "zh" ? "Switch to English" : "切换到中文"}>{LOCALE_LABELS[locale]}</button>
            <Link href="/products" className="cf-nlink">{t("navProducts")}</Link>
            <Link href="/batch" className="cf-nlink">{t("navBatch")}</Link>
            <Link href="/settings" className="cf-gear" aria-label={t("navSettings")}>
              <Settings size={16} strokeWidth={2} />
            </Link>
          </div>
        </nav>

        <section className="cf-hero">
          <div className="cf-center">
            <div className="cf-command-wrap">
              <div className="cf-command">
                <Link href="/project/agent" className="cf-cta" aria-label={t("workspaceCtaAria")}>
                  <span className="cf-cta-label">{t("ctaStart")}</span>
                  <span className="cf-play" aria-hidden="true">
                    <Play size={16} strokeWidth={0} />
                  </span>
                </Link>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
