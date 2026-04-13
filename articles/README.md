---
AIGC:
    ContentProducer: Minimax Agent AI
    ContentPropagator: Minimax Agent AI
    Label: AIGC
    ProduceID: "00000000000000000000000000000000"
    PropagateID: "00000000000000000000000000000000"
    ReservedCode1: 304602210095410028e4bde168afc62de6cbda72c434fa8e24b84f060a34bbe39654683ecd022100c8e6e26b2917f31212df22c576013d6e8732652bcea7ec70b665d62f659a54b5
    ReservedCode2: 3046022100b2adf976c5bae7260233206df7fc9c1d45fc75ab1daf8e4d9a7b61485c432f19022100fff32577fc34814b184d09f5ab59940446aa921621bec547329832e8a6cbbcfb
---

# 文章目录说明

本文档介绍如何为博客添加新的文章。

## 文章文件结构

所有文章都存放在 `articles/` 目录下，采用 Markdown 格式编写。

```
articles/
├── articles.json          # 文章索引配置文件
├── vite-vue3-guide.md     # 文章1
├── design-system-guide.md  # 文章2
└── ...
```

## 添加新文章的步骤

### 1. 创建 Markdown 文件

在 `articles/` 目录下创建一个新的 `.md` 文件，文件名建议使用英文短横线命名，例如：

```bash
touch articles/my-new-article.md
```

### 2. 编写文章内容

文章文件需要包含 Front Matter（文章元数据），格式如下：

```markdown
---
title: 文章标题
date: 2024-03-20
category: 技术
tags: 标签1, 标签2, 标签3
author: 林小白
readtime: 10
cover: https://example.com/cover-image.jpg
---

# 文章正文从这里开始

这里是文章的正文内容...

## 小标题

正文内容...

## 代码示例

```javascript
console.log('Hello World');
```

## 总结

总结内容...
```

### 3. 更新文章索引

编辑 `articles/articles.json` 文件，添加新文章的索引信息：

```json
{
  "articles": [
    {
      "slug": "my-new-article",
      "title": "文章标题",
      "date": "2024-03-20",
      "category": "技术",
      "tags": ["标签1", "标签2", "标签3"],
      "excerpt": "文章摘要，介绍文章主要内容...",
      "cover": "https://example.com/cover-image.jpg",
      "readtime": 10,
      "views": 0
    },
    // ... 其他文章
  ]
}
```

**索引字段说明：**

| 字段 | 必填 | 说明 |
|------|------|------|
| slug | 是 | 文章唯一标识符，与文件名匹配（不含.md） |
| title | 是 | 文章标题 |
| date | 是 | 发布日期，格式：YYYY-MM-DD |
| category | 是 | 分类：技术 / 设计 / 随笔 |
| tags | 是 | 标签数组 |
| excerpt | 是 | 文章摘要，建议100-200字 |
| cover | 是 | 封面图片URL |
| readtime | 是 | 预计阅读时间（分钟） |
| views | 否 | 阅读量，默认0 |

### 4. 更新首页文章卡片

编辑 `index.html` 文件，在 `articles-grid` 中添加新的文章卡片：

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
            2024年3月20日
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

## 分类说明

文章分类及对应的 CSS 类名：

| 分类 | 类名 | 颜色 |
|------|------|------|
| 技术 | tech | 青色 (#14B8A6) |
| 设计 | design | 玫瑰粉 (#EC4899) |
| 随笔 | life | 紫色 (#A855F7) |

## 写作规范

### Front Matter 规范

- `title`: 文章标题，不超过50字
- `date`: 发布日期，格式必须为 YYYY-MM-DD
- `category`: 只能选择一个分类
- `tags`: 使用逗号分隔，最多5个标签
- `cover`: 建议使用 1200x600 尺寸的图片

### Markdown 写作建议

1. **标题层级**：建议使用 h2 和 h3，避免超过 h4
2. **代码块**：标注语言类型，便于语法高亮
3. **图片**：使用 `![描述](URL)` 格式
4. **链接**：相对路径链接到其他文章

### 示例代码块

````markdown
```javascript
// 带语言标注的代码块
function hello() {
    console.log('Hello World');
}
```
````

## 文章模板

```markdown
---
title: 你的文章标题
date: 2024-03-20
category: 分类
tags: 标签1, 标签2
author: 林小白
readtime: 10
cover: 封面图片URL
---

# 文章标题

文章简介...

## 第一部分

内容...

## 第二部分

内容...

### 子标题

详细内容...

## 总结

总结内容...

---

*相关阅读：*

- [相关文章1](/article/slug1)
- [相关文章2](/article/slug2)
```

## 注意事项

1. **文件编码**：所有文件必须使用 UTF-8 编码
2. **图片路径**：封面图片建议使用图床链接，避免使用本地路径
3. **Slug 唯一性**：每个文章的 slug 必须唯一
4. **日期格式**：严格按照 YYYY-MM-DD 格式

## 自动化工具（可选）

如果需要更自动化的文章管理，可以考虑：

1. 使用静态网站生成器（如 Hugo、Hexo）
2. 使用 CMS 系统（如 Netlify CMS、Forestry）
3. 编写脚本自动生成索引

---

如有问题，请查看 `SPEC.md` 设计规范文档。
