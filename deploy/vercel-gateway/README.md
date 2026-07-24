# 绘卖 AI Vercel 网关

这个目录部署一个轻量 Vercel 外部重写网关，把公开的 `*.vercel.app` 地址转发到绘卖 AI 的持久化单机服务。

它刻意不在 Vercel Functions 中运行主应用：主应用依赖 SQLite、FFmpeg、持久上传目录和后台任务，本地文件系统不适合 Vercel 的无状态运行模型。

## 部署

```bash
vercel deploy --prod --yes
```

生产模式下，源站必须已经为 `vercel.json` 中的 HTTPS hostname 安装有效证书，并只将请求反代到 `127.0.0.1:3000`。

当前腾讯云公网层会重置 443，因此 `vercel.json` 暂时指向受限的 HTTP 只读预览入口。该入口只允许无 Cookie、无 Authorization 的 GET/HEAD 页面和静态资源请求；`/api/*` 与所有写方法都返回 503/405。腾讯云放行 443 后，应把 destination 改回 `https://124.220.90.186/:path*` 并重新部署，才能启用登录、上传和业务 API。

## 验证

- `/` 应返回 `307` 并保持在 Vercel 域名下跳转到 `/start`。
- `/start`、`/project/agent`、`/api/health/live` 应返回 `200`。
- 完整 HTTPS 模式下，登录/注册的 `Set-Cookie` 应绑定 Vercel 域名，不能泄露源站 hostname。
- 大于 4.5 MB 的案例视频应支持 Range 请求；这证明请求走的是外部 rewrite，而非 Vercel Function 响应体。
- 当前只读模式下，`/api/*` 应返回 503，POST 应返回 405，且请求 Cookie 不得传到应用。
- API 和用户态页面保持 `no-store`；带 hash 的 Next.js 静态资源可以继续使用源站缓存策略。
