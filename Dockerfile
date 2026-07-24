# syntax=docker/dockerfile:1
# 绘卖AI 邀请内测镜像：Next standalone + 静态 ffmpeg + 内置中文字体。
# 生产启动必须显式注入邀请名单、运营主体、后台强凭据和服务端模型 secret；缺项会失败关闭。

# ---- 构建阶段 ----
FROM node:22-bookworm-slim AS builder
WORKDIR /app
ARG HUIMAI_CODE_VERSION
# better-sqlite3 是原生模块，需要编译工具链（-o Acquire::Retries 兜底镜像源偶发 5xx）
RUN apt-get update && apt-get install -y --no-install-recommends -o Acquire::Retries=5 python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 容器只跑 web，跳过 Electron 二进制下载，加快安装
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN pnpm install --frozen-lockfile
# 默认拒绝的 Docker context 与显式 COPY 共同限定发布源码边界；禁止把数据、密钥、
# 研发资料或参考媒体带进 builder cache。路径变更后先运行 ops:verify-release-source。
COPY next.config.ts next-env.d.ts tsconfig.json postcss.config.mjs tailwind.config.js ./
COPY src ./src
COPY 前端 ./前端
COPY 后端 ./后端
COPY 服务器 ./服务器
COPY public ./public
COPY drizzle ./drizzle
COPY scripts ./scripts
COPY tools/matting ./tools/matting
# 抠图/人脸安全子工具是独立 npm 工程；必须在 Linux builder 里安装原生依赖，
# 不能复用宿主机的 tools/matting/node_modules。安装脚本显式关闭无用 CUDA/TensorRT 包。
RUN node scripts/ensure-motion-runtime.mjs --refresh
RUN printf '%s' "$HUIMAI_CODE_VERSION" | grep -Eq '^([0-9a-f]{40}|[0-9a-f]{64})$'
RUN HUIMAI_CODE_VERSION="$HUIMAI_CODE_VERSION" pnpm build
# 取出 ffmpeg-static / @ffprobe-installer 的静态二进制（项目已依赖），
# 运行阶段直接用，避免 apt 装 ffmpeg —— 镜像更可移植，且不受构建网络/代理影响。
RUN node -e "require('fs').copyFileSync(require('ffmpeg-static'),'/ffmpeg')" \
  && node -e "require('fs').copyFileSync(require('@ffprobe-installer/ffprobe').path,'/ffprobe')" \
  && chmod +x /ffmpeg /ffprobe

# ---- 运行阶段 ----
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HUIMAI_DEPLOYMENT_MODE=saas
# 静态 ffmpeg/ffprobe（来自 npm 依赖，无需 apt；app 无 FFMPEG_PATH 时回退到 PATH 里的 ffmpeg）。
# 中文字体也无需系统包：内置 public/fonts/subtitle.otf 且 resolveChineseFontFile 优先用它。
COPY --from=builder /ffmpeg /usr/local/bin/ffmpeg
COPY --from=builder /ffprobe /usr/local/bin/ffprobe
# Next standalone 产物（含最小 server.js + 必要 node_modules，含外部化的 better-sqlite3）
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Next nft 不会追踪 execFile 启动的独立子工具，需显式复制。
COPY --from=builder /app/tools/matting ./tools/matting
# drizzle 迁移（运行时读取，nft 不追踪，需显式带上）
COPY --from=builder /app/drizzle ./drizzle
# 可校验的在线备份/恢复工具；备份卷必须与 /data 独立挂载。
COPY --from=builder /app/scripts/backup-data.mjs ./scripts/backup-data.mjs
COPY --from=builder /app/scripts/restore-data.mjs ./scripts/restore-data.mjs
COPY --from=builder /app/scripts/backup-integrity.mjs ./scripts/backup-integrity.mjs
COPY --from=builder /app/scripts/verify-backup.mjs ./scripts/verify-backup.mjs
COPY --from=builder /app/scripts/preflight-beta.mjs ./scripts/preflight-beta.mjs
# 真实 HTTPS 上线必须在部署环境执行边缘请求体正/反向探针；运行镜像携带与 release 同版脚本。
COPY --from=builder /app/scripts/verify-edge-body-limit.mjs ./scripts/verify-edge-body-limit.mjs
# 数据（sqlite + uploads + output）落可写卷，便于持久化
ENV APP_DATA_DIR=/data
RUN groupadd --system --gid 1001 huimai \
  && useradd --system --uid 1001 --gid huimai --home-dir /app huimai \
  && mkdir -p /data /backups \
  && chown -R huimai:huimai /app /data /backups
VOLUME ["/data", "/backups"]
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
USER huimai
CMD ["node", "server.js"]
