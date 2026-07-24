/**
 * 火山引擎（方舟 Ark）Provider 实现
 * 文档参考（官方）：
 * - 图像（Seedream）同步：POST /api/v3/images/generations  https://www.volcengine.com/docs/82379/1541523
 * - 视频（Seedance）异步：POST /api/v3/contents/generations/tasks + GET /tasks/{id}  https://www.volcengine.com/docs/82379/1366799
 * 鉴权：Authorization: Bearer <ARK_API_KEY>
 * 说明：旧的 visual.volcengineapi.com Visual 服务需 AK/SK 签名，已弃用，统一改走方舟 Ark。
 */

import { BaseProvider, ProviderError, toSafeProviderErrorDto } from './base'
import type {
  ProviderConfig,
  ImageOptions,
  ImageResult,
  VideoOptions,
  VideoResult,
  TaskStatus,
  TaskStatusEnum,
  Model,
  MediaType,
} from './types'

// ==================== Ark API 响应类型 ====================

/** 图像生成响应（OpenAI 兼容：data[].url） */
interface ArkErrorPayload {
  code?: string
  message?: string
  request_id?: string
  requestId?: string
}

interface ArkImageResponse {
  model?: string
  data?: Array<{ url?: string; b64_json?: string; size?: string }>
  images?: string[] // 个别文档返回 images 数组，做兼容
  error?: ArkErrorPayload
  request_id?: string
}

/** 视频任务创建响应 */
interface ArkTaskCreateResponse {
  id: string
  error?: ArkErrorPayload
  request_id?: string
}

/** 视频任务查询响应 */
interface ArkTaskQueryResponse {
  id: string
  model?: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  content?: { video_url?: string }
  error?: ArkErrorPayload
  request_id?: string
}

function isArkFaceBlockCode(value: unknown): boolean {
  return typeof value === 'string'
    && /^(?:InputImageSensitiveContentDetected|ARK_FACE_BLOCKED|FACE_BLOCKED)$/i.test(value.trim())
}

function arkPayloadError(
  label: string,
  provider: string,
  error?: ArkErrorPayload,
  requestId?: string,
): ProviderError {
  const faceBlocked = isArkFaceBlockCode(error?.code)
  return new ProviderError(
    faceBlocked
      ? '视频平台肖像保护拒绝了含清晰人脸的输入图'
      : label,
    faceBlocked ? 'ARK_FACE_BLOCKED' : (error?.code || 'ARK_API_ERROR'),
    provider,
    undefined,
    {
      ...(faceBlocked ? { category: 'safety' as const } : {}),
      upstreamCode: error?.code,
      requestId: error?.request_id || error?.requestId || requestId,
    },
  )
}

function translateArkFaceBlocked(error: unknown, provider: string): unknown {
  if (!(error instanceof ProviderError)) return error
  if (!isArkFaceBlockCode(error.code) && !isArkFaceBlockCode(error.upstreamCode)) return error
  return new ProviderError(
    '视频平台风控不允许含清晰真人人脸的图片转视频（肖像保护）。请改用背影、侧影、颈部以下等无脸构图，或使用静态运镜。',
    'ARK_FACE_BLOCKED',
    provider,
    error.statusCode,
    {
      category: 'safety',
      retryable: false,
      requestId: error.requestId,
      upstreamCode: error.upstreamCode || error.code,
    },
  )
}

/** 把宽高映射为 Ark 视频 ratio */
function toRatio(width?: number, height?: number): string {
  const w = width ?? 0
  const h = height ?? 0
  if (w > h) return '16:9'
  if (h > w) return '9:16'
  if (w === h && w > 0) return '1:1'
  return 'adaptive'
}

/** 把宽高映射为 Ark 图像 size；低于最小像素数时按原比例放大，不得回退丢失比例的 "2K"。 */
function toImageSize(width?: number, height?: number): string {
  const w = width ?? 0
  const h = height ?? 0
  const total = w * h
  // Ark 总像素范围 [2560x1440=3686400, 4096x4096=16777216]
  if (total >= 3686400 && total <= 16777216) return `${w}x${h}`
  if (w > 0 && h > 0 && total < 3686400) {
    const scale = Math.sqrt(3686400 / total)
    // Ark 尺寸使用 8 的倍数更稳定；1080x1920 会得到精确 9:16 的 1440x2560。
    const scaledWidth = Math.min(4096, Math.ceil((w * scale) / 8) * 8)
    const scaledHeight = Math.min(4096, Math.ceil((h * scale) / 8) * 8)
    return `${scaledWidth}x${scaledHeight}`
  }
  return '2K'
}

export class VolcEngineProvider extends BaseProvider {
  readonly name = 'volcengine'
  readonly displayName = '火山引擎'

  constructor(config: ProviderConfig) {
    super({
      ...config,
      baseUrl: config.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
    })
  }

  /** 方舟 Ark 用 Bearer API Key 鉴权 */
  protected getAuthHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.config.apiKey}` }
  }

  /**
   * 生成图片（Seedream，同步返回，无需轮询）
   */
  async generateImage(options: ImageOptions): Promise<ImageResult> {
    const body: Record<string, unknown> = {
      model: options.modelId,
      prompt: options.prompt,
      size: toImageSize(options.width, options.height),
      response_format: 'url',
      watermark: false,
      // 图生图/编辑：传 image（URL 或 base64）
      ...(options.referenceImageUrl && { image: options.referenceImageUrl }),
      ...options.extra,
    }

    const resp = await this.request<ArkImageResponse>('/images/generations', {
      method: 'POST',
      body,
    })

    if (resp.error) {
      throw arkPayloadError('火山方舟图像生成失败', this.name, resp.error, resp.request_id)
    }

    // 优先 data[].url，兼容 images[] 字符串数组
    const urls = (resp.data?.map((d) => d.url).filter(Boolean) as string[]) ?? []
    if (urls.length === 0 && Array.isArray(resp.images)) {
      urls.push(...resp.images)
    }
    if (urls.length === 0) {
      throw new ProviderError('图像生成成功但未返回 URL', 'NO_RESULT', this.name)
    }

    return {
      taskId: 'sync',
      imageUrls: urls,
      modelId: options.modelId,
    }
  }

  /**
   * 生成视频（Seedance，异步任务 + 轮询）
   */
  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    let text = options.prompt
    if (options.audioEnabled && options.voiceover) {
      text = `${options.prompt}。旁白：「${options.voiceover}」`
    }

    // content：文本 + 可选首帧图（image_url）。
    // 首尾帧模式（flf2v）：同时给首帧+尾帧时必须显式标 role，模型生成"从 A 自然运动到 B"的过程——
    // 相邻分镜互为首尾帧可以让镜头之间咬合流动，是参考级成片的关键手法。
    const content: Array<Record<string, unknown>> = [{ type: 'text', text }]
    if (options.firstFrameUrl && options.lastFrameUrl) {
      content.push({ type: 'image_url', image_url: { url: options.firstFrameUrl }, role: 'first_frame' })
      content.push({ type: 'image_url', image_url: { url: options.lastFrameUrl }, role: 'last_frame' })
    } else if (options.firstFrameUrl) {
      content.push({ type: 'image_url', image_url: { url: options.firstFrameUrl } })
    }

    const body: Record<string, unknown> = {
      model: options.modelId,
      content,
      ratio: toRatio(options.width, options.height),
      ...(options.duration != null && { duration: options.duration }),
      generate_audio: options.audioEnabled ?? false,
      watermark: false,
      ...(options.seed != null && { seed: options.seed }),
      ...options.extra,
    }

    let created: ArkTaskCreateResponse
    try {
      created = await this.request<ArkTaskCreateResponse>(
        '/contents/generations/tasks',
        { method: 'POST', body }
      )
    } catch (e) {
      // 火山方舟对含清晰真人人脸的输入图直接拒绝图生视频（肖像保护风控），把平台报错翻译成可行动的提示
      throw translateArkFaceBlocked(e, this.name)
    }
    if (created.error || !created.id) {
      throw arkPayloadError(
        created.id ? '火山方舟视频任务创建失败' : '火山方舟视频任务未返回任务 ID',
        this.name,
        created.error,
        created.request_id,
      )
    }

    let finalStatus: TaskStatus
    try {
      finalStatus = await this.pollTaskStatus(created.id, { interval: 5000 })
    } catch (error) {
      throw translateArkFaceBlocked(error, this.name)
    }
    if (!finalStatus.result) {
      throw new ProviderError('任务完成但未返回结果', 'NO_RESULT', this.name)
    }
    const result = finalStatus.result as VideoResult
    result.modelId = options.modelId
    return result
  }

  /**
   * 查询任务状态（仅视频异步任务）
   */
  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const data = await this.request<ArkTaskQueryResponse>(
      `/contents/generations/tasks/${taskId}`
    )
    const status = this.mapStatus(data.status)

    const taskStatus: TaskStatus = { taskId: data.id, status }

    if (status === 'completed' && data.content?.video_url) {
      taskStatus.result = {
        taskId: data.id,
        videoUrls: [data.content.video_url],
        modelId: data.model ?? '',
        hasAudio: undefined,
      }
    }
    if (status === 'failed') {
      const failure = arkPayloadError('火山方舟视频任务生成失败', this.name, data.error, data.request_id)
      const safe = toSafeProviderErrorDto(failure)
      taskStatus.error = safe.message
      taskStatus.errorCode = safe.code
    }
    return taskStatus
  }

  /** Ark 任务状态 → 统一状态 */
  private mapStatus(s: ArkTaskQueryResponse['status']): TaskStatusEnum {
    switch (s) {
      case 'queued':
        return 'pending'
      case 'running':
        return 'processing'
      case 'succeeded':
        return 'completed'
      case 'failed':
        return 'failed'
      case 'cancelled':
        return 'cancelled'
      default:
        return 'processing'
    }
  }

  /**
   * 获取可用模型列表
   * 火山方舟模型用 doubao- 前缀；也可在控制台创建推理接入点用 endpoint ID 调用。
   * 来源：https://www.volcengine.com/docs/82379
   */
  async listModels(mediaType?: MediaType): Promise<Model[]> {
    const models: Model[] = [
      // ==================== 视频生成（Seedance） ====================
      {
        id: 'doubao-seedance-2-0-260128',
        name: 'Seedance 2.0',
        description: '字节豆包视频生成 2.0，电影级画质，支持原生音频',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
      {
        id: 'doubao-seedance-1-0-pro-250528',
        name: 'Seedance 1.0 Pro',
        description: '豆包视频 1.0 Pro，文/图生视频',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
      },
      // ==================== 图片生成（Seedream） ====================
      {
        id: 'doubao-seedream-5-0-260128',
        name: 'Seedream 5.0',
        description: '豆包图像 5.0，强中文理解、排版与质感（带货商品图佳）',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
      {
        id: 'doubao-seedream-4-0-250828',
        name: 'Seedream 4.0',
        description: '豆包图像 4.0，多图参考输入，商品保真编辑',
        modes: ['text-to-image', 'image-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
    ]

    if (mediaType) return models.filter((m) => m.mediaType === mediaType)
    return models
  }
}
