import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLegalProfile } from "@backend/core/legal/legal-profile";
import {
  LEGAL_DOCUMENTS,
  LEGAL_EFFECTIVE_DATE,
  type LegalDocumentSlug,
} from "@backend/shared/legal-documents";

export const dynamic = "force-dynamic";

const documents = Object.values(LEGAL_DOCUMENTS);

function legalDocument(slug: string) {
  return documents.find((item) => item.slug === slug);
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const document = legalDocument(slug);
  return { title: document ? `${document.title} | 绘卖AI` : "法律文档 | 绘卖AI" };
}

function Terms() {
  const profile = getLegalProfile();
  return (
    <>
      <Section title="一、服务与适用范围">
        <p>{profile.entityName}（下称“我们”）通过 {profile.brandName} 提供营销脚本、图片、视频、配音、素材管理和导出等辅助创作功能。邀请内测功能可能调整、中断或下线，我们会尽合理努力提前说明。</p>
      </Section>
      <Section title="二、账号与使用资格">
        <p>你应使用本人有权管理的邮箱注册，妥善保管账号，并对账号内的操作负责。不得转售邀请资格、共享账号、绕过额度或安全控制，也不得以自动化方式干扰服务稳定性。</p>
      </Section>
      <Section title="三、你提交的内容">
        <p>你保留对商品图、品牌资料、脚本和其他上传内容依法享有的权利，并确认有权将其用于营销创作。为提供生成、存储、转码和导出服务，你授权我们在服务所需范围内处理这些内容。</p>
        <p>不得上传侵犯著作权、商标权、肖像权、隐私权或其他合法权益的内容；不得生成违法、欺诈、歧视、暴力、色情或误导性广告内容。</p>
      </Section>
      <Section title="四、AI 输出与人工复核">
        <p>AI 输出具有概率性，可能不准确、不完整、重复或与第三方内容相似。发布前你必须人工核对商品事实、价格、功效、授权、平台规则和广告合规性；AI 输出不构成法律、医疗、财务或其他专业意见。</p>
      </Section>
      <Section title="五、素材、标识与平台发布">
        <p>第三方素材的授权条件以来源页为准；需要署名的素材应按导出页 credits 完整标注。AI 生成内容会按产品设置添加显式标识和文件元数据，用户不得恶意移除、伪造或规避依法需要的标识。</p>
      </Section>
      <Section title="六、内测额度与服务变更">
        <p>邀请内测额度仅用于产品验证，不代表未来正式版本的价格或权益。我们可基于成本、安全与公平使用需要调整内测额度，并在产品内给出说明。</p>
      </Section>
      <Section title="七、暂停与终止">
        <p>出现违法侵权、密钥或账号滥用、攻击服务、绕过安全机制或严重影响其他用户的情形时，我们可限制或暂停相关功能。你可通过下方联系方式申请注销账号和删除可删除的数据。</p>
      </Section>
      <Section title="八、联系我们">
        <p>运营主体：{profile.entityName}</p>
        <p>服务与权利请求联系渠道：{profile.contact}</p>
      </Section>
    </>
  );
}

function Privacy() {
  const profile = getLegalProfile();
  return (
    <>
      <Section title="一、我们处理的信息">
        <p>包括注册邮箱及店铺画像、你主动上传的商品与品牌资料、项目脚本和媒体文件、生成与导出记录、效果回填数据，以及保障账号安全和排查故障所需的请求时间、错误与用量记录。</p>
      </Section>
      <Section title="二、处理目的">
        <p>用于身份验证、提供 AI 生成与视频合成、保存项目、执行额度控制、改进店铺个性化效果、保障安全、处理反馈和履行合规义务。我们不会把你的私有素材作为其他商家的可见素材。</p>
      </Section>
      <Section title="三、第三方处理">
        <p>仅在你使用对应能力时，相关提示词、参考图片、音视频或必要参数会传输给已启用的模型或素材服务商。当前部署披露：{profile.aiProviderDisclosure}。这些服务商按其服务条款和隐私规则处理请求，我们会尽量减少传输范围。</p>
      </Section>
      <Section title="四、保存期限">
        <p>账号存续期间，我们保存项目和账号数据以便你继续使用。服务日志原则上保存不超过 {profile.retentionDays} 天；模型服务商侧的保存期限以其已披露政策及本部署合同配置为准。注销或删除请求完成后，备份中的残留会在备份轮换周期内清除，但法律要求或争议处理所需数据除外。</p>
      </Section>
      <Section title="五、安全措施">
        <p>我们采用租户隔离、私有媒体鉴权、加密传输、会话保护、访问限流、备份与最小权限等措施。互联网服务不存在绝对安全；如发现账号异常，请立即联系我们。</p>
      </Section>
      <Section title="六、你的权利">
        <p>你可在产品内查看或更正部分资料，并可联系我们申请访问、更正、导出、删除个人信息或注销账号。为防止冒用，我们可能先核验账号归属。</p>
      </Section>
      <Section title="七、未成年人">
        <p>本服务面向具有经营或内容发布能力的成年人，不以未成年人为目标用户。若发现未经适当授权提交的未成年人信息，请联系我们处理。</p>
      </Section>
      <Section title="八、联系我们">
        <p>个人信息处理者：{profile.entityName}</p>
        <p>隐私与数据权利联系渠道：{profile.contact}</p>
      </Section>
    </>
  );
}

function AiNotice() {
  const profile = getLegalProfile();
  return (
    <>
      <Section title="一、AI 能力如何工作">
        <p>{profile.brandName} 会把你的业务参数、提示词及必要参考素材发送给当前已发布的模型策略。当前部署披露：{profile.aiProviderDisclosure}。不同流程可能使用不同模型，实际模型与运行记录以服务端配置为准。</p>
      </Section>
      <Section title="二、输出限制">
        <p>生成结果可能存在事实错误、文字瑕疵、画面变形、品牌细节偏差、版权或平台适配风险。你应在发布前逐项复核，不应把模型输出当作确定事实或专业结论。</p>
      </Section>
      <Section title="三、内容与权利保证">
        <p>使用人物照片、声音、商标、商品素材或受保护作品前，你应取得所需授权。人脸或敏感素材被安全策略拒绝时，不得通过更换更宽松的模型规避拦截。</p>
      </Section>
      <Section title="四、AI 生成标识">
        <p>邀请内测默认对成片烧录“AI生成/辅助”标识，并写入文件元数据。你仍应根据实际发布地区和平台规则补充平台侧声明，不得故意删除依法要求的标识。</p>
      </Section>
      <Section title="五、禁止用途">
        <p>不得用于冒充他人、虚假宣传、欺诈、操纵评价、侵犯肖像或隐私、制作违法内容，或规避模型服务商与平台的安全规则。</p>
      </Section>
      <Section title="六、反馈与联系">
        <p>如输出包含不当内容、疑似侵权或错误标识，请停止发布并通过 {profile.contact} 联系 {profile.entityName}。</p>
      </Section>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-bold text-foreground">{title}</h2>
      <div className="space-y-2 text-sm leading-7 text-muted-foreground">{children}</div>
    </section>
  );
}

export default async function LegalPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const document = legalDocument(slug);
  if (!document) notFound();

  return (
    <main className="min-h-screen bg-background px-5 py-10 text-foreground">
      <article className="mx-auto max-w-3xl space-y-8 rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-10">
        <header className="space-y-3 border-b border-border pb-6">
          <Link href="/" className="text-sm font-semibold text-primary">← 返回绘卖AI</Link>
          <h1 className="text-3xl font-black">{document.title}</h1>
          <p className="text-xs text-muted-foreground">版本：{document.version} · 生效日期：{LEGAL_EFFECTIVE_DATE}</p>
        </header>
        {(slug as LegalDocumentSlug) === "terms" ? <Terms /> : null}
        {(slug as LegalDocumentSlug) === "privacy" ? <Privacy /> : null}
        {(slug as LegalDocumentSlug) === "ai-notice" ? <AiNotice /> : null}
      </article>
    </main>
  );
}
