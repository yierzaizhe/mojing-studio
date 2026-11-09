# GitHub 发布流程

本目录是一份独立公开版源码：保留 PSD / PSB、SVG 和普通图片功能，移除了 AI 解析及展示用编辑控件。完整本地版应留在它自己的目录，不要把它的 Git 历史、依赖或私人样本复制进来。

## 本机验证

```sh
npm ci
npm test
npm run dev
```

在主页面和 README 列出的浏览器验收页检查导入、选层、滤镜、多标签及导出。`npm test` 不会自动执行浏览器验收。GitHub CI 同样仅运行 Node 测试和构建。

## 仓库与推送

公开仓库已创建：[yierzaizhe/mojing-studio](https://github.com/yierzaizhe/mojing-studio)。本地仓库也已初始化并有首次提交。接下来核对远程地址、推送源码，再上传发布文件；推送和 CI 结果以执行后的 GitHub 页面为准。

先检查本地内容和远程地址：

```sh
git status
git log --oneline -3
git remote -v
```

如果尚未设置 `origin`，添加已创建的仓库地址，再推送 `main`。已有 `origin` 时，确认其地址为 `https://github.com/yierzaizhe/mojing-studio.git`，省略添加命令：

```sh
git remote add origin https://github.com/yierzaizhe/mojing-studio.git
git push -u origin main
```

默认忽略构建产物、安装依赖、发布目录、环境变量和测试结果。推送前不要使用 `git add -f` 绕过这些规则。`.github/workflows/ci.yml` 配置为在推送和 Pull Request 上构建检查，并保存 HTML 构建附件；它不自动部署网页或创建 Release。推送后在 [Actions](https://github.com/yierzaizhe/mojing-studio/actions) 查看实际运行结果。

## 提供给使用者的下载文件

```sh
npm run release
```

发布目录为 `release/mojing-studio-v1.0.0/`，包含独立 HTML、使用说明、截图和第三方许可证。将完整目录压缩为 `mojing-studio-v1.0.0-offline.zip`，在本仓库创建标签为 `v1.0.0` 的 Release，并上传两个附件：

- `墨境Studio.html`：[单文件下载地址](https://github.com/yierzaizhe/mojing-studio/releases/download/v1.0.0/%E5%A2%A8%E5%A2%83Studio.html)。
- `mojing-studio-v1.0.0-offline.zip`：[离线 ZIP 下载地址](https://github.com/yierzaizhe/mojing-studio/releases/download/v1.0.0/mojing-studio-v1.0.0-offline.zip)。

[v1.0.0 Release 页面](https://github.com/yierzaizhe/mojing-studio/releases/tag/v1.0.0)。上述地址在对应 Release 和附件发布后生效；发布后核对附件名称、下载内容及许可证，再确认 README 中的下载入口可用。

发布内容建议：

- 仓库简介：Offline PSD / SVG viewer and local image workbench in one HTML file.
- Topics：`psd`、`svg`、`image-processing`、`offline`、`javascript`。
- 首个版本标记：`v1.0.0`；描述以 `CHANGELOG.md` 为准。
- 截图只使用仓库自制示例。不要标注 AI/PDF、画笔或源文件编辑能力。

如需 GitHub Pages，在后续明确启用静态发布流程，将 `dist/index.html` 发布为入口。本仓库目前没有 Pages 自动部署工作流。
