/**
 * 智谱 AI（bigmodel.cn）Provider
 * 主要价值：CogVideoX-Flash 免费图生视频，且允许含真人人脸的输入图（火山 seedance 会拒）——
 * 用作"人脸镜头"的降级通道；CogView-3-Flash 免费生图作附带能力。
 * 视频为异步任务：POST /videos/generations 建任务 → GET /async-result/{id} 轮询。
 */
import { BaseProvider, ProviderError } from './base'
import type {
  ImageOptions,
  ImageResult,
  VideoOptions,
  VideoResult,
  TaskStatus,
  TaskStatusEnum,
  Model,
  MediaType,
  ProviderConfig,
} from './types'

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'

interface ZhipuVideoTask {
  id?: string
  task_status?: string
  video_result?: Array<{ url?: string; cover_image_url?: string }>
  error?: { code?: string; message?: string }
}

interface ZhipuImageResponse {
  data?: Array<{ url?: string }>
  error?: { code?: string; message?: string }
}

export class ZhipuProvider extends BaseProvider {
  readonly name = 'zhipu'
  readonly displayName = '智谱 AI'

  constructor(config: ProviderConfig) {
    // BaseProvider.request 直接读 config.baseUrl，缺省时在这里补上智谱官方地址
    super({ ...config, baseUrl: config.baseUrl || DEFAULT_BASE_URL })
  }

  /** 生图：CogView 系列（同步返回） */
  async generateImage(options: ImageOptions): Promise<ImageResult> {
    const started = Date.now()
    const data = await this.request<ZhipuImageResponse>('/images/generations', {
      method: 'POST',
      body: {
        model: options.modelId || 'cogview-3-flash',
        prompt: options.prompt,
        ...(options.width && options.height && { size: `${options.width}x${options.height}` }),
      },
    })
    const urls = (data.data ?? []).map((d) => d.url).filter((u): u is string => !!u)
    if (!urls.length) {
      throw new ProviderError(
        `智谱生图未返回结果: ${data.error?.message ?? '空响应'}`,
        data.error?.code ?? 'ZHIPU_EMPTY_RESULT',
        this.name
      )
    }
    return { taskId: `zhipu-img-${started}`, imageUrls: urls, modelId: options.modelId || 'cogview-3-flash', duration: Date.now() - started }
  }

  /** 生视频：CogVideoX 系列（异步任务 + 轮询）；firstFrameUrl 支持公网 URL 或 base64 data URI */
  async generateVideo(options: VideoOptions): Promise<VideoResult> {
    const started = Date.now()
    const model = options.modelId || 'cogvideox-flash'
    // 输出比例对齐请求（否则跟随输入图比例，3:4 商品图会合成出黑边）；白底商品图由模型自然外扩
    const size =
      options.width && options.height
        ? options.width > options.height
          ? '1920x1080'
          : options.width === options.height
            ? '1024x1024'
            : '1080x1920'
        : undefined
    const body = {
      model,
      prompt: options.prompt,
      ...(options.firstFrameUrl && { image_url: options.firstFrameUrl }),
      ...(size && { size }),
      ...(options.duration != null && { duration: options.duration }),
      // 付费档（cogvideox-2/3）开质量优先：人脸镜头要的就是稳定不畸变；免费 flash 不支持该参数
      ...(!/flash/i.test(model) && { quality: 'quality' }),
      with_audio: options.audioEnabled ?? false,
    }
    // 免费档（cogvideox-flash）高峰期常态性 429，基类 2 次短退避不够用——
    // 建任务这一步再叠加长退避重试（实测拥堵窗口约 30-60 秒能挤进去）
    let created: ZhipuVideoTask | undefined
    const maxCreateAttempts = 5
    for (let attempt = 0; attempt < maxCreateAttempts; attempt++) {
      try {
        created = await this.request<ZhipuVideoTask>('/videos/generations', { method: 'POST', body })
        break
      } catch (e) {
        const is429 = e instanceof ProviderError && e.statusCode === 429
        const isBusy = e instanceof Error && /访问量过大|Too Many Requests/i.test(e.message)
        if ((is429 || isBusy) && attempt < maxCreateAttempts - 1) {
          await this.sleep(15000 + attempt * 10000)
          continue
        }
        throw e
      }
    }
    if (!created) {
      throw new ProviderError('智谱视频任务创建失败：持续限流', 'ZHIPU_RATE_LIMITED', this.name, 429)
    }
    if (!created.id) {
      throw new ProviderError(
        `智谱视频任务创建失败: ${created.error?.message ?? '未返回任务 ID'}`,
        created.error?.code ?? 'ZHIPU_TASK_ERROR',
        this.name
      )
    }

    const finalStatus = await this.pollTaskStatus(created.id, { interval: 5000 })
    if (!finalStatus.result) {
      throw new ProviderError('智谱视频任务完成但未返回结果', 'NO_RESULT', this.name)
    }
    const result = finalStatus.result as VideoResult
    result.modelId = options.modelId || 'cogvideox-flash'
    result.processingTime = Date.now() - started
    return result
  }

  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    const data = await this.request<ZhipuVideoTask>(`/async-result/${taskId}`)
    const status = this.mapStatus(data.task_status)
    const taskStatus: TaskStatus = { taskId, status }
    if (status === 'completed') {
      const urls = (data.video_result ?? []).map((v) => v.url).filter((u): u is string => !!u)
      taskStatus.result = {
        taskId,
        videoUrls: urls,
        coverImageUrl: data.video_result?.[0]?.cover_image_url,
        modelId: '',
      } as VideoResult
    }
    if (status === 'failed') {
      taskStatus.error = data.error?.message ?? '任务失败'
      taskStatus.errorCode = data.error?.code
    }
    return taskStatus
  }

  async listModels(mediaType?: MediaType): Promise<Model[]> {
    const models: Model[] = [
      {
        id: 'cogvideox-flash',
        name: 'CogVideoX-Flash（免费）',
        description: '智谱免费视频模型，支持文/图生视频；允许真人人脸首帧',
        modes: ['text-to-video', 'image-to-video'],
        mediaType: 'video',
        provider: this.name,
        supportsAudio: true,
      },
      {
        id: 'cogview-3-flash',
        name: 'CogView-3-Flash（免费）',
        description: '智谱免费图片模型',
        modes: ['text-to-image'],
        mediaType: 'image',
        provider: this.name,
      },
    ]
    return mediaType ? models.filter((m) => m.mediaType === mediaType) : models
  }

  private mapStatus(status: string | undefined): TaskStatusEnum {
    switch (status) {
      case 'PROCESSING':
        return 'processing'
      case 'SUCCESS':
        return 'completed'
      case 'FAIL':
        return 'failed'
      default:
        return 'pending'
    }
  }
}
