import "server-only";

import { createHash } from "node:crypto";

/**
 * 微信服务号通知通道 —— 发布提醒的触达层（黄金时段到点 → 模板消息推到老板/店员微信上）。
 *
 * 前置条件（SaaS 运维侧配置，商家无感）：
 * - 已认证的微信服务号（订阅号/个人号没有模板消息权限）；
 * - 服务号后台配置服务器地址指向 /api/wechat/callback（Token 与 WECHAT_CALLBACK_TOKEN 一致）；
 * - 模板消息里选好一个提醒模板，模板 id 填到 WECHAT_TEMPLATE_ID。
 *
 * 环境变量：
 * - WECHAT_APP_ID / WECHAT_APP_SECRET：服务号凭证
 * - WECHAT_CALLBACK_TOKEN：回调签名校验 Token（服务号后台"服务器配置"里填的那个）
 * - WECHAT_TEMPLATE_ID：发布提醒的模板消息 id
 * - WECHAT_TEMPLATE_FIELDS：可选，JSON 映射模板字段名，默认 {"title":"first","body":"keyword1","date":"keyword2","remark":"remark"}
 * - APP_BASE_URL：可选，提醒消息点开跳转的站点地址（如 https://xxx.com），不填则消息不带链接
 * - WECHAT_DRY_RUN=1：干跑模式，不真调微信接口只打日志（本地开发/测试用）
 *
 * 未配置时所有函数安全降级（返回 configured=false / ok=false），不影响其余功能。
 */

const API_BASE = "https://api.weixin.qq.com";

export interface WechatNotifyConfig {
  appId: string;
  appSecret: string;
  callbackToken: string;
  templateId: string;
  /** 提醒消息点开跳转的站点根地址，可空 */
  linkBase: string | null;
}

/** 发布提醒的消息内容（与具体模板字段解耦，字段映射见 WECHAT_TEMPLATE_FIELDS） */
export interface ReminderPush {
  /** 标题句，如"该发视频啦" */
  title: string;
  /** 正文，如"现在是你家客人最活跃的点，今天还差 2 条，库里有 5 条可发" */
  body: string;
  /** 日期/时段，如"07-12 17:00-19:00" */
  date: string;
  /** 尾注，如"点开挑一条发出去" */
  remark?: string;
}

export function getWechatConfig(): WechatNotifyConfig | null {
  const appId = process.env.WECHAT_APP_ID?.trim();
  const appSecret = process.env.WECHAT_APP_SECRET?.trim();
  const callbackToken = process.env.WECHAT_CALLBACK_TOKEN?.trim();
  const templateId = process.env.WECHAT_TEMPLATE_ID?.trim();
  if (!appId || !appSecret || !callbackToken || !templateId) return null;
  return {
    appId,
    appSecret,
    callbackToken,
    templateId,
    linkBase: process.env.APP_BASE_URL?.trim().replace(/\/+$/, "") || null,
  };
}

export function isWechatConfigured(): boolean {
  return getWechatConfig() !== null;
}

function isDryRun(): boolean {
  return process.env.WECHAT_DRY_RUN === "1";
}

// ===== access_token（内存缓存，standalone 单进程部署够用）=====

let cachedToken: { token: string; expiresAt: number } | null = null;

async function fetchAccessToken(config: WechatNotifyConfig): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) return cachedToken.token;
  const res = await fetch(
    `${API_BASE}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(config.appId)}&secret=${encodeURIComponent(config.appSecret)}`
  );
  const data = (await res.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
  if (!data.access_token) {
    throw new Error(`获取微信 access_token 失败: ${data.errcode ?? ""} ${data.errmsg ?? "未知错误"}`);
  }
  // 提前 120 秒过期，避开临界点竞态
  cachedToken = { token: data.access_token, expiresAt: now + ((data.expires_in ?? 7200) - 120) * 1000 };
  return data.access_token;
}

/** 强制作废缓存的 token（40001 等失效场景重试用；测试也用它复位） */
export function invalidateWechatToken(): void {
  cachedToken = null;
}

// ===== 模板消息发送 =====

const DEFAULT_TEMPLATE_FIELDS = { title: "first", body: "keyword1", date: "keyword2", remark: "remark" };

/** 模板字段映射：默认经典模板（first/keyword1/keyword2/remark），可用 WECHAT_TEMPLATE_FIELDS 覆盖以适配类目模板 */
export function templateFieldMap(): typeof DEFAULT_TEMPLATE_FIELDS {
  const raw = process.env.WECHAT_TEMPLATE_FIELDS;
  if (!raw) return DEFAULT_TEMPLATE_FIELDS;
  try {
    const parsed = JSON.parse(raw) as Partial<typeof DEFAULT_TEMPLATE_FIELDS>;
    return { ...DEFAULT_TEMPLATE_FIELDS, ...parsed };
  } catch {
    console.warn("WECHAT_TEMPLATE_FIELDS 不是合法 JSON，使用默认字段映射");
    return DEFAULT_TEMPLATE_FIELDS;
  }
}

/** 组装模板消息请求体（纯函数，可单测） */
export function buildTemplatePayload(
  openId: string,
  push: ReminderPush,
  config: Pick<WechatNotifyConfig, "templateId" | "linkBase">,
  fields: typeof DEFAULT_TEMPLATE_FIELDS = templateFieldMap()
): Record<string, unknown> {
  const data: Record<string, { value: string }> = {
    [fields.title]: { value: push.title },
    [fields.body]: { value: push.body },
    [fields.date]: { value: push.date },
    [fields.remark]: { value: push.remark ?? "点开看看今天发哪条" },
  };
  return {
    touser: openId,
    template_id: config.templateId,
    ...(config.linkBase ? { url: `${config.linkBase}/products` } : {}),
    data,
  };
}

/** 给一个 openid 推一条发布提醒；失败不抛错，返回 { ok, error } 由调用方记流水 */
export async function sendPublishReminder(openId: string, push: ReminderPush): Promise<{ ok: boolean; error?: string }> {
  const config = getWechatConfig();
  if (!config) return { ok: false, error: "微信服务号未配置" };
  if (isDryRun()) {
    console.log(`[微信干跑] 发给 ${openId}:`, JSON.stringify(buildTemplatePayload(openId, push, config)));
    return { ok: true };
  }
  try {
    const payload = buildTemplatePayload(openId, push, config);
    let data = await postTemplate(config, payload);
    if (data.errcode === 40001) {
      // token 失效（如后台重置了 secret）：作废缓存重试一次
      invalidateWechatToken();
      data = await postTemplate(config, payload);
    }
    if (data.errcode && data.errcode !== 0) {
      return { ok: false, error: `微信返回 ${data.errcode}: ${data.errmsg ?? ""}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "发送失败" };
  }
}

async function postTemplate(
  config: WechatNotifyConfig,
  payload: Record<string, unknown>
): Promise<{ errcode?: number; errmsg?: string }> {
  const token = await fetchAccessToken(config);
  const res = await fetch(`${API_BASE}/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as { errcode?: number; errmsg?: string };
}

// ===== 绑定二维码（带参临时码：扫码关注 → 回调事件里带 scene → 绑定 openid ↔ 商家）=====

/** 绑定二维码有效期（秒）：设置页展示用，过期让商家重新点一次 */
export const BIND_QR_EXPIRE_SECONDS = 600;

/** scene 前缀：回调事件里凭它识别"这是绑定动作" */
export const BIND_SCENE_PREFIX = "bind:";

export async function createBindQr(
  merchantId: string
): Promise<{ ok: boolean; qrImageUrl?: string; expiresIn?: number; error?: string }> {
  const config = getWechatConfig();
  if (!config) return { ok: false, error: "微信服务号未配置" };
  if (isDryRun()) {
    return { ok: true, qrImageUrl: `https://example.com/dry-run-qr/${merchantId}`, expiresIn: BIND_QR_EXPIRE_SECONDS };
  }
  try {
    const token = await fetchAccessToken(config);
    const res = await fetch(`${API_BASE}/cgi-bin/qrcode/create?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expire_seconds: BIND_QR_EXPIRE_SECONDS,
        action_name: "QR_STR_SCENE",
        action_info: { scene: { scene_str: `${BIND_SCENE_PREFIX}${merchantId}` } },
      }),
    });
    const data = (await res.json()) as { ticket?: string; expire_seconds?: number; errcode?: number; errmsg?: string };
    if (!data.ticket) {
      return { ok: false, error: `生成二维码失败: ${data.errcode ?? ""} ${data.errmsg ?? ""}` };
    }
    return {
      ok: true,
      qrImageUrl: `https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=${encodeURIComponent(data.ticket)}`,
      expiresIn: data.expire_seconds ?? BIND_QR_EXPIRE_SECONDS,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "生成二维码失败" };
  }
}

// ===== 回调校验与事件解析（纯函数，可单测）=====

/** 服务号"服务器配置"的签名校验：sha1(sort(token, timestamp, nonce)) === signature */
export function verifyWechatSignature(
  params: { signature?: string | null; timestamp?: string | null; nonce?: string | null },
  token: string
): boolean {
  const { signature, timestamp, nonce } = params;
  if (!signature || !timestamp || !nonce) return false;
  const digest = createHash("sha1").update([token, timestamp, nonce].sort().join("")).digest("hex");
  return digest === signature;
}

export interface WechatEvent {
  /** 扫码/关注者的 openid */
  openId: string;
  /** subscribe=扫码关注 / SCAN=已关注再扫 / unsubscribe=取关 */
  event: string;
  /** 带参二维码的 scene（subscribe 时微信会加 qrscene_ 前缀，这里已剥掉） */
  sceneKey: string | null;
}

/** 从微信回调的 XML 里抽出关心的事件字段；不是事件消息返回 null。不引第三方 XML 库，字段固定用正则够用 */
export function parseWechatEventXml(xml: string): WechatEvent | null {
  const pick = (tag: string): string | null => {
    const match = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`))
      ?? xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
    return match ? match[1].trim() : null;
  };
  if ((pick("MsgType") ?? "").toLowerCase() !== "event") return null;
  const openId = pick("FromUserName");
  const event = pick("Event");
  if (!openId || !event) return null;
  const rawKey = pick("EventKey");
  const sceneKey = rawKey ? rawKey.replace(/^qrscene_/, "") : null;
  return { openId, event, sceneKey };
}
