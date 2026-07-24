import Link from "next/link";
import { getLegalProfile } from "@backend/core/legal/legal-profile";

function contactHref(contact: string) {
  if (/^https:\/\//i.test(contact)) return contact;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact)) {
    return `mailto:${contact}?subject=${encodeURIComponent("绘卖AI 内测问题反馈")}`;
  }
  return null;
}

export default function SupportPage() {
  const profile = getLegalProfile();
  const href = contactHref(profile.contact);

  return (
    <main className="min-h-screen bg-[#F6F7F9] px-5 py-12 text-[#111] sm:px-8">
      <div className="mx-auto max-w-2xl rounded-3xl border border-[#DFE4EA] bg-white p-6 shadow-sm sm:p-9">
        <p className="text-xs font-black tracking-[0.18em] text-[#7B8490]">绘卖AI · 邀请内测</p>
        <h1 className="mt-3 text-3xl font-black">帮助与问题反馈</h1>
        <p className="mt-3 text-sm font-semibold leading-6 text-[#5F6874]">
          内测期间由工作人员陪跑。生成失败、结果异常、额度或隐私问题都可以直接反馈，我们会据此定位到服务端运行记录。
        </p>

        <section className="mt-8 rounded-2xl bg-[#F4F5F7] p-5">
          <h2 className="font-extrabold">反馈时请附上</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm font-semibold leading-6 text-[#4E5865]">
            <li>登录邮箱、项目名称和发生时间；</li>
            <li>停在哪一步，以及页面显示的完整报错；</li>
            <li>可以复现问题的操作顺序；</li>
            <li>如涉及敏感素材，先说明情况，不要通过非约定渠道直接发送原文件。</li>
          </ul>
        </section>

        <section className="mt-6 rounded-2xl border border-[#DFE4EA] p-5">
          <h2 className="font-extrabold">当前服务边界</h2>
          <p className="mt-2 text-sm font-semibold leading-6 text-[#5F6874]">
            当前为小规模邀请内测。任务可能因模型服务限流、余额、内容安全校验或本机合成资源而延迟；请勿反复点击创建付费生成任务。页面显示失败时，先保留项目并通过下方渠道联系工作人员。
          </p>
        </section>

        <div className="mt-8 flex flex-wrap gap-3">
          {href ? (
            <a
              href={href}
              target={href.startsWith("https://") ? "_blank" : undefined}
              rel={href.startsWith("https://") ? "noreferrer" : undefined}
              className="inline-flex h-11 items-center rounded-xl bg-[#111] px-5 text-sm font-extrabold text-white"
            >
              联系工作人员：{profile.contact}
            </a>
          ) : (
            <div className="rounded-xl bg-[#FFF4E5] px-4 py-3 text-sm font-bold text-[#8A4B00]">
              联系渠道：{profile.contact}
            </div>
          )}
          <Link href="/project/agent" className="inline-flex h-11 items-center rounded-xl border border-[#D8DEE6] px-5 text-sm font-extrabold">
            返回创作台
          </Link>
        </div>
      </div>
    </main>
  );
}
