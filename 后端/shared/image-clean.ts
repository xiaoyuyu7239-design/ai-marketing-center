/** settings 表里存"原图↔清洗图"映射的 key（图片/视频两条线共用，供前端做对比与「改用原图」） */
export function imageCleanKey(projectId: string) {
  return `image_clean:${projectId}`;
}

/** 清洗映射的存储结构 */
export interface ImageCleanRecord {
  pairs: Array<{ original: string; cleaned: string | null }>;
  useCleaned: boolean;
}
