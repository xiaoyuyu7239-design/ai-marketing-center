/**
 * AI Provider 基础抽象类
 * 提供通用的 HTTP 请求、错误处理、任务轮询等能力
 */

import type {
  AIProvider,
  ProviderConfig,
  ImageOptions,
  ImageResult,
  VideoOptions,
  VideoResult,
  TaskStatus,
  Model,
  MediaType,
  TaskStatusEnum,
} from './types'
import { readResponseBuffer, safeFetch } from '../shared/ssrf-guard'

const MAX_PROVIDER_JSON_BYTES = 10 * 1024 * 1024
/**
 * 错误响应只需要极少量诊断字段。单独设小上限，避免上游用 4xx
 * 返回超大 HTML/JSON 时占满内存。
 */
export const MAX_PROVIDER_ERROR_JSON_BYTES = 64 * 1024

export type ProviderErrorCategory =
  | 'safety'
  | 'billing'
  | 'auth'
  | 'rate_limit'
  | 'invalid_input'
  | 'configuration'
  | 'provider_5xx'
  | 'timeout'
  | 'network'
  | 'unknown'

export type ProviderErrorSuggestedAction =
  | 'replace_input'
  | 'check_billing'
  | 'check_configuration'
  | 'retry_later'
  | 'review_request'
  | 'contact_support'

export interface SafeProviderErrorDto {
  /** 绘卖稳定错误码，不是上游原始错误体。 */
  code: string
  category: ProviderErrorCategory
  message: string
  retryable: boolean
  retryAfterSeconds?: number
  requestId?: string
  suggestedAction: ProviderErrorSuggestedAction
}

export interface ProviderErrorOptions {
  category?: ProviderErrorCategory
  retryable?: boolean
  retryAfterSeconds?: number
  requestId?: string
  /** 只保留受限长度和字符集约束的上游 code，不保留原始错误对象。 */
  upstreamCode?: string
}

interface ProviderErrorSummary {
  code?: string
  message?: string
  requestId?: string
}

const PROVIDER_ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/
const PROVIDER_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/

function safeProviderCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return PROVIDER_ERROR_CODE.test(normalized) ? normalized : undefined
}

function safeProviderRequestId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return PROVIDER_REQUEST_ID.test(normalized) ? normalized : undefined
}

/**
 * message 只用于服务端分类/诊断，不会被 safe DTO 返回。即便上游误将凭据
 * 放进 message，也会在留存前脱敏；原始字符串不挂到 ProviderError 上。
 */
function safeProviderMessage(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/((?:authorization|api[_-]?key|access[_-]?token|secret|password)\s*[=:]\s*["']?)[^\s,;"'}]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/g, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
  return normalized || undefined
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value) => value !== undefined)
}

/**
 * 仅从 JSON 白名单路径提取 code/message/requestId。其它字段（包括可能回显的
 * prompt、Authorization、apiKey）不会进入错误对象。
 */
function providerErrorSummary(value: unknown): ProviderErrorSummary {
  const root = recordValue(value)
  const nested = recordValue(root.error)
  return {
    code: firstDefined([
      safeProviderCode(nested.code),
      safeProviderCode(root.code),
    ]),
    message: firstDefined([
      safeProviderMessage(nested.message),
      safeProviderMessage(root.message),
    ]),
    requestId: firstDefined([
      safeProviderRequestId(nested.requestId),
      safeProviderRequestId(nested.request_id),
      safeProviderRequestId(root.requestId),
      safeProviderRequestId(root.request_id),
    ]),
  }
}

async function readProviderErrorSummary(response: Response): Promise<ProviderErrorSummary> {
  const contentLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(contentLength) && contentLength > MAX_PROVIDER_ERROR_JSON_BYTES) {
    await response.body?.cancel('provider-error-too-large').catch(() => undefined)
    return {}
  }
  try {
    const payload = await readResponseBuffer(response, MAX_PROVIDER_ERROR_JSON_BYTES)
    return providerErrorSummary(JSON.parse(payload.toString('utf8')) as unknown)
  } catch {
    // 非 JSON/超限/中途断开都按无诊断字段处理，绝不回退到 response.text()。
    await response.body?.cancel('provider-error-invalid').catch(() => undefined)
    return {}
  }
}

function providerErrorHaystack(statusCode?: number, code?: string, message?: string) {
  return `${statusCode ?? ''} ${code ?? ''} ${message ?? ''}`
}

export function classifyProviderError(input: {
  statusCode?: number
  code?: string
  message?: string
}): ProviderErrorCategory {
  const { statusCode } = input
  const haystack = providerErrorHaystack(statusCode, input.code, input.message)

  // 内部端点安全拒绝是配置错误，不是内容安全拒绝。
  if (/^(?:UNSAFE_ENDPOINT|CONFIG(?:URATION)?_ERROR)$/i.test(input.code || '')) {
    return 'configuration'
  }
  // 内容安全常用 400/403，必须比 auth/invalid_input 更早判定。
  if (/content[_ .:-]?policy|safety|moderation|sensitive|risk[_ .:-]?control|unsafe[_ .:-]?(?:content|image|input)|face[_ .:-]?blocked|InputImageSensitiveContentDetected|安全校验|安全策略|内容审核|敏感内容|肖像保护/i.test(haystack)) {
    return 'safety'
  }
  if (statusCode === 402 || /insufficient[_ .:-]?(?:quota|balance|credit)|billing|payment[_ .:-]?required|account[_ .:-]?(?:arrears|overdue)|余额不足|账户欠费|请充值|额度(?:不足|已用完)/i.test(haystack)) {
    return 'billing'
  }
  if (statusCode === 429 || /rate[_ .:-]?limit|too[_ .:-]?many[_ .:-]?requests|throttl|限流|请求过于频繁/i.test(haystack)) {
    return 'rate_limit'
  }
  if (statusCode === 401 || statusCode === 403 || /invalid[_ .:-]?(?:api[_ .:-]?)?key|unauthori[sz]ed|forbidden|permission[_ .:-]?denied|authentication|鉴权失败|凭据无效|密钥无效/i.test(haystack)) {
    return 'auth'
  }
  if (/UNSAFE_ENDPOINT|CONFIG(?:URATION)?_ERROR|模型端点配置无效|配置不完整/i.test(haystack)) {
    return 'configuration'
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) return 'provider_5xx'
  if (/TIMEOUT|AbortError|ETIMEDOUT|timed?\s*out|超时/i.test(haystack)) return 'timeout'
  if (/NETWORK_ERROR|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|fetch failed|network error|网络异常|连接失败/i.test(haystack)) return 'network'
  if (
    (statusCode !== undefined && statusCode >= 400 && statusCode <= 499)
    || /invalid[_ .:-]?(?:argument|input|parameter|request)|bad[_ .:-]?request|unprocessable|参数无效|输入无效/i.test(haystack)
  ) return 'invalid_input'
  return 'unknown'
}

function retryableCategory(category: ProviderErrorCategory): boolean {
  return category === 'rate_limit' || category === 'provider_5xx' || category === 'timeout' || category === 'network'
}

function stableProviderCode(category: ProviderErrorCategory, code?: string): string {
  if (code === 'SUBMISSION_UNCERTAIN') return 'SUBMISSION_UNCERTAIN'
  if (code === 'ARK_FACE_BLOCKED' || code === 'FACE_BLOCKED') return 'FACE_BLOCKED'
  const codes: Record<ProviderErrorCategory, string> = {
    safety: 'SAFETY_BLOCKED',
    billing: 'BILLING_REQUIRED',
    auth: 'AUTH_FAILED',
    rate_limit: 'RATE_LIMITED',
    invalid_input: 'INVALID_INPUT',
    configuration: 'CONFIGURATION_ERROR',
    provider_5xx: 'PROVIDER_UNAVAILABLE',
    timeout: 'PROVIDER_TIMEOUT',
    network: 'PROVIDER_NETWORK_ERROR',
    unknown: 'PROVIDER_ERROR',
  }
  return codes[category]
}

function safeProviderMessageFor(category: ProviderErrorCategory, code?: string): string {
  if (code === 'SUBMISSION_UNCERTAIN') return '供应商提交结果未知，请勿重复提交，并联系工作人员核查'
  if (code === 'ARK_FACE_BLOCKED' || code === 'FACE_BLOCKED') return '素材中的清晰人脸未通过视频模型安全校验，请更换无脸构图或使用静态运镜'
  const messages: Record<ProviderErrorCategory, string> = {
    safety: '素材未通过模型安全校验，请更换素材后重试',
    billing: '模型服务额度不足，请联系工作人员处理',
    auth: '模型服务鉴权失败，请联系工作人员检查配置',
    rate_limit: '模型服务当前较忙，请稍后重试',
    invalid_input: '当前素材或参数不符合模型要求，请调整后重试',
    configuration: '模型策略暂不可用，请联系工作人员',
    provider_5xx: '模型服务暂时异常，请稍后重试',
    timeout: '模型生成超时，请稍后重试',
    network: '模型服务网络异常，请稍后重试',
    unknown: '模型生成失败，请稍后重试',
  }
  return messages[category]
}

function suggestedAction(category: ProviderErrorCategory): ProviderErrorSuggestedAction {
  const actions: Record<ProviderErrorCategory, ProviderErrorSuggestedAction> = {
    safety: 'replace_input',
    billing: 'check_billing',
    auth: 'check_configuration',
    rate_limit: 'retry_later',
    invalid_input: 'review_request',
    configuration: 'check_configuration',
    provider_5xx: 'retry_later',
    timeout: 'retry_later',
    network: 'retry_later',
    unknown: 'contact_support',
  }
  return actions[category]
}

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after')?.trim()
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(86_400, Math.ceil(seconds))
  const at = Date.parse(value)
  if (!Number.isFinite(at)) return undefined
  return Math.min(86_400, Math.max(0, Math.ceil((at - Date.now()) / 1_000)))
}

/** API 请求错误 */
export class ProviderError extends Error {
  /** 错误码 */
  code: string
  /** HTTP 状态码 */
  statusCode?: number
  /** 所属平台 */
  provider: string
  /** 不依赖上游文案的稳定分类。 */
  category: ProviderErrorCategory
  retryable: boolean
  retryAfterSeconds?: number
  requestId?: string
  upstreamCode?: string

  constructor(
    message: string,
    code: string,
    provider: string,
    statusCode?: number,
    options: ProviderErrorOptions = {},
  ) {
    super(message)
    this.name = 'ProviderError'
    this.code = safeProviderCode(code) ?? 'PROVIDER_ERROR'
    this.provider = provider
    this.statusCode = statusCode
    this.upstreamCode = safeProviderCode(options.upstreamCode)
    this.category = options.category ?? classifyProviderError({
      statusCode,
      code: this.upstreamCode || this.code,
      message,
    })
    this.retryable = options.retryable ?? retryableCategory(this.category)
    if (typeof options.retryAfterSeconds === 'number' && Number.isFinite(options.retryAfterSeconds)) {
      this.retryAfterSeconds = Math.min(86_400, Math.max(0, Math.ceil(options.retryAfterSeconds)))
    }
    this.requestId = safeProviderRequestId(options.requestId)
  }
}

/** API/持久任务可直接使用的安全 DTO；不返回 provider message 或原始错误体。 */
export function toSafeProviderErrorDto(
  error: unknown,
  fallbackMessage = '模型生成失败，请稍后重试',
): SafeProviderErrorDto {
  if (!(error instanceof ProviderError)) {
    return {
      code: 'PROVIDER_ERROR',
      category: 'unknown',
      message: fallbackMessage,
      retryable: false,
      suggestedAction: 'contact_support',
    }
  }
  return {
    code: stableProviderCode(error.category, error.code),
    category: error.category,
    message: safeProviderMessageFor(error.category, error.code),
    retryable: error.retryable,
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
    suggestedAction: suggestedAction(error.category),
  }
}

/** 基础 Provider 抽象类 */
export abstract class BaseProvider implements AIProvider {
  abstract readonly name: string
  abstract readonly displayName: string

  protected config: ProviderConfig

  constructor(config: ProviderConfig) {
    this.config = config
  }

  // ==================== 抽象方法（子类必须实现） ====================

  abstract generateImage(options: ImageOptions): Promise<ImageResult>
  abstract generateVideo(options: VideoOptions): Promise<VideoResult>
  abstract getTaskStatus(taskId: string): Promise<TaskStatus>
  abstract listModels(mediaType?: MediaType): Promise<Model[]>

  // ==================== 通用工具方法 ====================

  /**
   * 发送 HTTP 请求
   * @param path API 路径（相对于 baseUrl）
   * @param options 请求选项
   * @returns 解析后的 JSON 数据
   */
  protected async request<T = unknown>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
      body?: unknown
      headers?: Record<string, string>
      timeout?: number
      /**
       * 默认只重试 GET。生成类 POST 一旦请求已发出，超时/断网/5xx 无法证明供应商
       * 没有受理；自动重试可能创建第二个付费任务。只有供应商明确提供幂等语义时，
       * 调用方才可以显式设为 always。
       */
      retry?: 'safe' | 'always' | 'never'
    } = {}
  ): Promise<T> {
    const { method = 'GET', body, headers = {}, timeout, retry = 'safe' } = options
    const url = `${this.config.baseUrl}${path}`
    const requestTimeout = timeout ?? this.config.timeout ?? 30000
    let endpoint: URL
    try {
      endpoint = new URL(url)
    } catch {
      throw new ProviderError('模型端点配置无效', 'UNSAFE_ENDPOINT', this.name)
    }
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) {
      throw new ProviderError('模型端点必须是无内嵌凭据的 HTTPS URL', 'UNSAFE_ENDPOINT', this.name)
    }
    const endpointPolicy = {
      allowedProtocols: ['https:'] as const,
      allowedHosts: [endpoint.hostname],
      allowedPorts: [endpoint.port],
    }

    // 构建请求头
    const mergedHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.getAuthHeaders(),
      ...this.config.headers,
      ...headers,
    }

    // 查询请求可重试；非幂等提交默认只发一次，避免供应商已受理后重复计费。
    const retryAllowed = retry === 'always' || (retry === 'safe' && method === 'GET')
    const maxRetries = retryAllowed ? 2 : 0
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), requestTimeout)
      try {
        const response = await safeFetch(url, {
          method,
          headers: mergedHeaders,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        }, 0, endpointPolicy)

        if (!response.ok) {
          // 429/5xx 属可重试瞬时错误
          if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
            await response.body?.cancel('provider-retry').catch(() => undefined)
            lastError = new ProviderError(
              `API 请求失败: ${response.status} ${response.statusText}`,
              'API_ERROR',
              this.name,
              response.status
            )
            await this.sleep(500 * Math.pow(2, attempt))
            continue
          }
          if (!retryAllowed && response.status >= 500) {
            await response.body?.cancel('submission-uncertain').catch(() => undefined)
            throw new ProviderError(
              '供应商提交结果未知，已停止自动重试以避免重复创建付费任务',
              'SUBMISSION_UNCERTAIN',
              this.name
            )
          }
          // 4xx 仅有界读取 JSON，并且只提取 code/message/requestId 白名单。
          // 5xx 错误体不影响分类，直接丢弃，避免误读 HTML/故障页。
          const summary = response.status >= 400 && response.status <= 499
            ? await readProviderErrorSummary(response)
            : {}
          if (response.status >= 500) {
            await response.body?.cancel('provider-error').catch(() => undefined)
          }
          const category = classifyProviderError({
            statusCode: response.status,
            code: summary.code,
            message: summary.message,
          })
          const internalCode = stableProviderCode(category)
          const diagnostic = summary.message
            ? `${safeProviderMessageFor(category)}：${summary.message}`
            : safeProviderMessageFor(category)
          throw new ProviderError(
            diagnostic,
            internalCode,
            this.name,
            response.status,
            {
              category,
              retryAfterSeconds: retryAfterSeconds(response),
              requestId: summary.requestId,
              upstreamCode: summary.code,
            },
          )
        }

        try {
          const payload = await readResponseBuffer(response, MAX_PROVIDER_JSON_BYTES)
          return JSON.parse(payload.toString('utf8')) as T
        } catch (error) {
          // 对非幂等付费提交，2xx 但响应损坏/过大仍无法证明供应商未受理；不得 fallback。
          if (!retryAllowed && method !== 'GET') {
            throw new ProviderError(
              '供应商可能已受理提交，但返回结果无法安全解析；已停止自动重试',
              'SUBMISSION_UNCERTAIN',
              this.name
            )
          }
          throw new ProviderError(
            `供应商返回无效 JSON${error instanceof Error && error.message.includes('超过') ? '（响应过大）' : ''}`,
            'INVALID_RESPONSE',
            this.name,
            response.status
          )
        }
      } catch (error) {
        clearTimeout(timeoutId)
        // 4xx 等非瞬时错误：直接抛出不重试
        if (error instanceof ProviderError && error.statusCode && error.statusCode < 500 && error.statusCode !== 429) {
          throw error
        }
        const isTimeout = error instanceof DOMException && error.name === 'AbortError'
        if (!retryAllowed && method !== 'GET' && !(error instanceof ProviderError)) {
          lastError = new ProviderError(
            '供应商提交结果未知，已停止自动重试以避免重复创建付费任务',
            'SUBMISSION_UNCERTAIN',
            this.name
          )
        } else {
          lastError = isTimeout
            ? new ProviderError(`请求超时（${requestTimeout}ms）`, 'TIMEOUT', this.name)
            : error instanceof ProviderError
              ? error
              : new ProviderError(`网络请求异常: ${error instanceof Error ? error.message : String(error)}`, 'NETWORK_ERROR', this.name)
        }
        // 网络/超时/瞬时错误：还有重试机会就退避后重试
        if (attempt < maxRetries) {
          await this.sleep(500 * Math.pow(2, attempt))
          continue
        }
        throw lastError
      } finally {
        clearTimeout(timeoutId)
      }
    }
    // 理论不会走到，兜底
    throw lastError instanceof Error ? lastError : new ProviderError('请求失败', 'UNKNOWN', this.name)
  }

  /**
   * 获取认证请求头
   * 子类可覆盖以自定义认证方式
   */
  protected getAuthHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
    }
  }

  /**
   * 轮询任务状态直到完成
   * @param taskId 任务 ID
   * @param options 轮询选项
   * @returns 最终的任务状态
   */
  protected async pollTaskStatus(
    taskId: string,
    options: {
      /** 轮询间隔（毫秒），默认 3000 */
      interval?: number
      /** 最大轮询次数，默认 200 */
      maxAttempts?: number
      /** 完成状态判断，默认检查 completed/failed/cancelled */
      isTerminal?: (status: TaskStatusEnum) => boolean
    } = {}
  ): Promise<TaskStatus> {
    const {
      interval = 3000,
      maxAttempts = 200,
      isTerminal = (s) => ['completed', 'failed', 'cancelled'].includes(s),
    } = options

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const status = await this.getTaskStatus(taskId)

      if (isTerminal(status.status)) {
        if (status.status === 'failed') {
          throw new ProviderError(
            `任务失败: ${status.error ?? '未知错误'}`,
            status.errorCode ?? 'TASK_FAILED',
            this.name
          )
        }
        return status
      }

      // 等待指定间隔后继续轮询
      await this.sleep(interval)
    }

    throw new ProviderError(
      `任务轮询超时，已尝试 ${maxAttempts} 次`,
      'POLL_TIMEOUT',
      this.name
    )
  }

  /**
   * 校验异步任务完成后确有结果，否则抛统一的 NO_RESULT。
   * 收敛各 provider 重复的「if (!finalStatus.result) throw」守卫——把 3 行降为 1 行、口径统一，
   * 减少某个 provider 漏写守卫而隐性失败的风险（审计曾因 provider 各自实现而发现重复 bug）。
   */
  protected requireResult<T>(result: T | undefined | null, message = '任务完成但未返回结果', code = 'NO_RESULT'): T {
    if (result == null) throw new ProviderError(message, code, this.name)
    return result
  }

  /**
   * 延迟执行
   * @param ms 延迟毫秒数
   */
  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 上传文件到指定 URL 获取远程地址
   * 部分平台需要先上传图片/视频素材
   * @param fileUrl 本地或远程文件 URL
   * @param uploadPath 上传 API 路径
   * @returns 上传后的远程文件 URL
   */
  protected async uploadMedia(fileUrl: string, uploadPath: string): Promise<string> {
    // 默认实现：直接返回原始 URL（假设平台支持远程 URL）
    // 子类可覆盖此方法实现平台特定的上传逻辑
    void uploadPath;
    return fileUrl
  }
}
