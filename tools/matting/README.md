# 本地图像子工具（零 API）

`matte.mjs`：抠出商品 → 换纯净背景 + 合成柔和接触阴影。商品像素零改动，
彻底消除"图生图重绘"的泛白/脑补。主程序通过 `后端/core/media/matte.ts` 以子进程调用（cwd 必须为本目录）。

`face-detect.mjs`：使用本地 UltraFace ONNX 模型检查图片中是否有清晰人脸。
只返回人脸存在性、置信度与位置，不识别身份、不上传图片；模型缺失或异常时上层必须按
`review_required` 失败关闭，不得直接提交付费视频。

## 依赖（独立于主项目 pnpm）
本目录有自己的 package.json 和 node_modules（sharp + ONNX Runtime + 抠图模型）。
**部署/换机后需在本目录单独执行：**

    cd tools/matting && npm install

（Docker 构建里也要加这一步；首次抠图会下载 ~40MB 模型到本地缓存，之后离线。）

## 手动用法
    node matte.mjs <输入图> <输出图> [背景hex，默认 #ECEAE6]
    node face-detect.mjs <输入图>

## 已知局限
抠图抠的是"显著前景"=商品+手。手持照片会残留手指，最佳输入是**商品单独放桌面拍**。
