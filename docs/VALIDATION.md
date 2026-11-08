# 公开版验证记录

验证对象：公开版 1.0.0，由本仓库 `build.mjs` 生成的 `dist/index.html`。记录日期：2026-11-09。

## 自动检查

本机 Node.js 24.16.0，使用锁文件执行 `npm ci --ignore-scripts --offline --no-audit --no-fund` 后，`npm test` 全部通过。

| 检查 | 通过 |
| --- | ---: |
| 本地文件读取及 I/O 失败回退 | 10 |
| 半透明剪贴合成 | 15 |
| 实际像素选层 | 29 |
| PNG / JPG 编码、水印、尺寸与内存预算 | 16 |
| SVG / 图片栅格导出 | 8 |
| 空图层、单层预览及资源释放 | 8 |
| 七组滤镜与处理顺序 | 13 |
| 无 AI 运行时、格式前置拒绝及真实工具栏 | 4 |
| **合计** | **103** |

## 浏览器验收

通过本机预览服务，在内置浏览器中运行交付 HTML 的实际 Worker、适配器和 UI。验收页由自制样例驱动，没有替换解析或合成结果。

| 页面 | 通过 |
| --- | ---: |
| `browser-check.html` | 24 |
| `svg-browser-check.html` | 17 |
| `image-browser-check.html` | 17 |
| `image-filters-browser-check.html` | 10 |
| `public-browser-check.html` | 7 |
| `tabs-browser-check.html` | 12 |
| **合计** | **87** |

多标签检查增加了目标标签的实际画布绘制归属与尺寸诊断，PNG 像素断言保持严格；更新后的验收连续两次 12/12。最初缺少绘制归属诊断的运行出现过一次 PNG 像素失败，未据此修改应用代码。

在主工作区人工点击 PSD 示例橙色球体，右侧对应图层被选中并显示属性。`workspace.jpg` 来自这个实际状态。文件拒绝检查覆盖选择输入和拖放，包括伪装为图片 MIME 的 AI/PDF；确认读取次数、新标签、新 Worker 均为零。

## 验证范围

本次没有覆盖所有操作系统、浏览器版本、设计软件生成的文件或直接 `file://` 打开方式。复杂 PSD/SVG 的还原限制见 README。GitHub CI 配置已准备，本次未创建远程仓库、推送或在 GitHub 执行 CI。
