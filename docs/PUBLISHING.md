# GitHub 发布准备

本目录是一份独立公开版源码：保留 PSD / PSB、SVG 和普通图片功能，移除了 AI 解析及展示用编辑控件。完整本地版应留在它自己的目录，不要把它的 Git 历史、依赖或私人样本复制进来。

## 本机验证

```sh
npm ci
npm test
npm run dev
```

在主页面和 README 列出的浏览器验收页检查导入、选层、滤镜、多标签及导出。`npm test` 不会自动执行浏览器验收。GitHub CI 同样仅运行 Node 测试和构建。

## 创建远程仓库并推送

当前整理步骤只准备本地仓库，不创建远程仓库或上传。确定公开后，在自己的 GitHub 账号下新建空仓库，例如 `mojing-studio`。不要预先添加 README 或 LICENSE，以免与本地首次提交冲突。

本地仓库已初始化时，先检查内容和远程地址：

```sh
git status
git log --oneline -3
git remote -v
```

以下命令中的 `YOUR_ACCOUNT` 必须替换成实际账号，确认后再手动执行：

```sh
git remote add origin https://github.com/YOUR_ACCOUNT/mojing-studio.git
git push -u origin main
```

默认忽略构建产物、安装依赖、发布目录、环境变量和测试结果。推送前不要使用 `git add -f` 绕过这些规则。`.github/workflows/ci.yml` 会在推送和 Pull Request 上构建检查，并保存 HTML 构建附件；它不自动部署网页或创建 Release。

## 提供给使用者的下载文件

```sh
npm run release
```

发布目录为 `release/mojing-studio-v1.0.0/`，包含独立 HTML、使用说明、截图和第三方许可证。把其中的 `墨境Studio.html` 作为主要下载，完整目录可打包 ZIP 附在 GitHub Release。

发布内容建议：

- 仓库简介：Offline PSD / SVG viewer and local image workbench in one HTML file.
- Topics：`psd`、`svg`、`image-processing`、`offline`、`javascript`。
- 首个版本标记：`v1.0.0`；描述以 `CHANGELOG.md` 为准。
- 截图只使用仓库自制示例。不要标注 AI/PDF、画笔或源文件编辑能力。

如需 GitHub Pages，在后续明确启用静态发布流程，将 `dist/index.html` 发布为入口。本仓库目前没有 Pages 自动部署工作流。
