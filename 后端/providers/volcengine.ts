/**
 * 火山引擎（方舟 Ark）Provider 实现
 * 文档参考（官方）：
 * - 图像（Seedream）同步：POST /api/v3/images/generations  https://www.volcengine.com/docs/82379/1541523
 * - 视频（Seedance）异步：POST /api/v3/contents/generations/tasks + GET /tasks/{id}  https://www.volcengine.com/docs/82379/1366799
 * 鉴权：Authorization: Bearer <ARK_API_KEY>
 * 说明：旧的 visual.volcengineapi.com Visual 服务需 AK/SK 签名，已弃用，统一改走方舟 Ark。
 */

import { BaseProvider, ProviderError } from './base'
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
interface ArkImageResponse {
  model?: string
  data?: Array<{ url?: string; b64_json?: string; size?: string }>
  images?: string[] // 个别文档返回 images 数组，做兼容
  error?: { code?: string; message?: string }
}

/** 视频任务创建响应 */
interface ArkTaskCreateResponse {
  id: string
  error?: { code?: string; message?: string }
}

/** 视频任务查询响应 */
interface ArkTaskQueryResponse {
  id: string
  model?: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  content?: { video_url?: string }
  error?: { code?: string; message?: string }
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

/** 把宽高映射为 Ark 图像 size；超出 Ark 像素范围则回退 "2K"（由模型按 prompt 决定比例） */
function toImageSize(width?: number, height?: number): string {
  const w = width ?? 0
  const h = height ?? 0
  const total = w * h
  // Ark 总像素范围 [2560x1440=3686400, 4096x4096=16777216]
  if (total >= 3686400 && total <= 16777216) return `${w}x${h}`
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
      throw new ProviderError(
        `火山方舟图像生成失败: ${resp.error.message ?? resp.error.code}`,
        resp.error.code ?? 'ARK_IMAGE_ERROR',
        this.name
      )
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

    // content：文本 + 可选首帧图（image_url）
    const content: Array<Record<string, unknown>> = [{ type: 'text', text }]
    if (options.firstFrameUrl) {
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

    const created = await this.request<ArkTaskCreateResponse>(
      '/contents/generations/tasks',
      { method: 'POST', body }
    )
    if (created.error || !created.id) {
      throw new ProviderError(
        `火山方舟视频任务创建失败: ${created.error?.message ?? '未返回任务 ID'}`,
        created.error?.code ?? 'ARK_TASK_ERROR',
        this.name
      )
    }

    const finalStatus = await this.pollTaskStatus(created.id, { interval: 5000 })
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
      taskStatus.error = data.error?.message
      taskStatus.errorCode = data.error?.code
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
