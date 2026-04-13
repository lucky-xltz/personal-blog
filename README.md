# 林小白的数字花园

一个充满活力与温度的个人博客，采用"液态玻璃态"设计语言，结合玻璃拟态与流体艺术，创造既有质感又有动感的视觉体验。

## 项目简介

这是一个基于纯 HTML + CSS + JavaScript 构建的个人博客网站，具有以下特点：

- **现代化设计**：采用玻璃拟态设计风格，大圆角、渐变色、毛玻璃效果
- **响应式布局**：完美适配桌面端、平板和移动设备
- **文章系统**：支持 Markdown 文章，自动生成目录和阅读时间
- **阅读量统计**：基于 Cloudflare Workers + KV 的实时阅读量统计
- **自动发布**：支持定时发布 AI 新闻和技术文章

## 技术栈

- **前端**：HTML5 + CSS3 + Vanilla JavaScript
- **字体**：Google Fonts (Inter, Outfit, JetBrains Mono)
- **Markdown 渲染**：Marked.js
- **阅读量统计**：Cloudflare Workers + KV
- **部署**：Cloudflare Pages / GitHub Pages
- **版本控制**：Git + GitHub

## 项目结构

```
personal-blog/
├── articles/                    # 博客文章目录
│   ├── articles.json           # 文章索引配置
│   ├── ai-news-2026-04-13.md   # AI 新闻文章
│   ├── nextjs-large-scale-architecture.md  # 技术文章
│   ├── tailwind-v4-upgrade-guide.md        # 技术文章
│   └── ...                     # 其他文章
│
├── worker/                     # Cloudflare Worker 目录
│   ├── views-counter.js        # 阅读量统计 Worker 代码
│   └── README.md               # Worker 部署文档
│
├── index.html                  # 博客首页
├── article.html                # 文章详情页
├── README.md                   # 项目说明文档
└── .gitignore                  # Git 忽略文件
```

## 快速开始

### 1. 克隆项目

```bash
git clone https://github.com/lucky-xltz/personal-blog.git
cd personal-blog
```

### 2. 本地预览

由于是纯静态网站，可以直接用浏览器打开 `index.html` 文件，或者使用本地服务器：

```bash
# 使用 Python
python -m http.server 8000

# 使用 Node.js
npx serve .

# 使用 PHP
php -S localhost:8000
```

然后在浏览器中访问 `http://localhost:8000`

### 3. 添加新文章

#### 3.1 创建 Markdown 文件

在 `articles/` 目录下创建新的 `.md` 文件：

```bash
touch articles/my-new-article.md
```

#### 3.2 编写文章内容

文章需要包含 Front Matter（元数据）：

```markdown
---
title: "文章标题"
date: 2026-04-13
category: 技术
tags: 标签1, 标签2, 标签3
author: 林小白
readtime: 10
cover: https://example.com/cover-image.jpg
---

# 文章标题

文章正文内容...

## 小标题

正文内容...
```

#### 3.3 更新文章索引

编辑 `articles/articles.json`，添加新文章的索引信息：

```json
{
  "slug": "my-new-article",
  "title": "文章标题",
  "date": "2026-04-13",
  "category": "技术",
  "tags": ["标签1", "标签2", "标签3"],
  "excerpt": "文章摘要，介绍文章主要内容...",
  "cover": "https://example.com/cover-image.jpg",
  "readtime": 10,
  "views": 0
}
```

#### 3.4 更新首页文章卡片

编辑 `index.html`，在 `articles-grid` 中添加新的文章卡片：

```html
<article class="article-card reveal" data-slug="my-new-article">
    <div class="article-image">
        <img src="https://example.com/cover-image.jpg" alt="封面描述">
    </div>
    <span class="article-category tech">技术</span>
    <h3 class="article-title">文章标题</h3>
    <p class="article-excerpt">文章摘要...</p>
    <div class="article-meta">
        <span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
            </svg>
            2026年4月13日
        </span>
        <span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                <circle cx="12" cy="12" r="3"></circle>
            </svg>
            0 阅读
        </span>
    </div>
</article>
```

## 阅读量统计

本项目使用 Cloudflare Workers + KV 实现阅读量统计功能。

### 工作原理

1. **文章详情页**：用户访问文章时，自动调用 Worker API 增加阅读量
2. **首页**：批量获取所有文章的阅读量并显示
3. **数据存储**：阅读量数据存储在 Cloudflare KV 中，全球分布式

### API 接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/views` | POST | 增加阅读量 |
| `/api/views?articleId=xxx` | GET | 获取单篇文章阅读量 |
| `/api/views/batch` | POST | 批量获取阅读量 |

### 部署 Worker

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 "Workers & Pages"
3. 创建新的 Worker：`personal-blog-analytics`
4. 复制 `worker/views-counter.js` 的内容到 Worker 编辑器
5. 创建 KV 命名空间：`BLOG_VIEWS`
6. 绑定 KV 命名空间到 Worker
7. 部署 Worker

详细部署文档请参考 [worker/README.md](worker/README.md)

## 自动发布系统

本项目配置了定时任务，自动发布博客文章：

| 时间 | 内容类型 | 说明 |
|------|----------|------|
| 每天 9:30 | AI 新闻 | 综合当天 AI 领域重要新闻 |
| 每天 12:00 | 技术文章 | 前端开发、后端架构等技术话题 |
| 每天 18:00 | 技术文章 | 与中午文章不同的技术话题 |

### 工作流程

1. **内容搜索**：自动搜索相关新闻和技术文章
2. **文章撰写**：生成高质量、有深度的博客文章
3. **文件更新**：创建 Markdown 文件，更新索引和首页
4. **Git 提交**：自动提交并推送到 GitHub
5. **自动部署**：触发 Cloudflare Pages 或 GitHub Pages 构建

## 设计系统

### 色彩系统

```css
:root {
  --primary: #6366F1;      /* 靛蓝紫 */
  --secondary: #EC4899;    /* 玫瑰粉 */
  --accent: #14B8A6;       /* 青绿色 */
  --background: #0F172A;   /* 深空蓝 */
  --surface: #1E293B;      /* 柔和灰蓝 */
  --text: #F8FAFC;         /* 月光白 */
  --text-muted: #94A3B8;   /* 银灰 */
}
```

### 字体系统

- **标题**：Outfit (现代几何感)
- **正文**：Inter (高可读性)
- **代码**：JetBrains Mono (等宽字体)

### 圆角系统

- **卡片**：24px
- **按钮**：16px
- **胶囊**：9999px

## 浏览器兼容性

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## 性能优化

1. **图片优化**：使用 Unsplash 的 WebP 格式图片
2. **字体加载**：使用 Google Fonts 的 `display=swap` 优化
3. **代码高亮**：简单的语法高亮，避免重型库
4. **动画优化**：使用 CSS transform 和 opacity 实现动画

## 部署方式

### Cloudflare Pages（推荐）

1. 将项目推送到 GitHub
2. 在 Cloudflare Pages 中连接 GitHub 仓库
3. 设置构建命令：无（静态网站）
4. 设置输出目录：`/`
5. 部署

### GitHub Pages

1. 在 GitHub 仓库设置中启用 GitHub Pages
2. 选择 `main` 分支作为源
3. 保存设置

### 其他静态托管

项目是纯静态网站，可以部署到任何静态托管服务：
- Vercel
- Netlify
- AWS S3 + CloudFront
- 阿里云 OSS

## 贡献指南

欢迎提交 Issue 和 Pull Request！

### 提交 Issue

1. 使用清晰的标题描述问题
2. 提供复现步骤
3. 附上截图（如果适用）

### 提交 Pull Request

1. Fork 项目
2. 创建功能分支：`git checkout -b feature/my-feature`
3. 提交更改：`git commit -m 'Add some feature'`
4. 推送分支：`git push origin feature/my-feature`
5. 提交 Pull Request

## 更新日志

### 2026-04-13

- 添加 Cloudflare Workers KV 阅读量统计功能
- 发布 AI 日报文章
- 发布 Next.js 大型应用架构指南
- 发布 Tailwind CSS v4 升级指南
- 添加自动发布系统

### 2026-04-12

- 初始化项目
- 完成基础页面设计
- 实现文章系统

## 许可证

MIT License

## 联系方式

- **作者**：林小白
- **GitHub**：[@lucky-xltz](https://github.com/lucky-xltz)
- **博客**：[林小白的数字花园](https://lucky-xltz.github.io/personal-blog/)

## 致谢

- 设计灵感来自 [Glassmorphism](https://glassmorphism.com/)
- 字体来自 [Google Fonts](https://fonts.google.com/)
- 图片来自 [Unsplash](https://unsplash.com/)
- Markdown 渲染使用 [Marked.js](https://marked.js.org/)

---

*用 ❤️ 和 ☕ 制作*
