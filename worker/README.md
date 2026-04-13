# Cloudflare Worker 部署文档

## 概述

本项目使用 Cloudflare Worker + KV 实现博客文章阅读量统计功能。

## 文件说明

- `views-counter.js` - Worker 主程序，负责处理阅读量的增加和查询

## 功能说明

1. **阅读量统计**：记录文章阅读量，每次访问文章时自动 +1
2. **IP 限制**：同一个 IP 对同一篇文章，一天只计算一次阅读量
3. **批量查询**：支持批量获取多篇文章的阅读量
4. **邮件订阅**：支持用户订阅博客更新
5. **跨域支持**：已配置 CORS，支持跨域请求

## 部署信息

| 项目 | 值 |
|------|-----|
| Worker 名称 | personal-blog-analytics |
| Worker 地址 | https://analytics.blog.xltz.qzz.io |
| KV 命名空间 | BLOG_VIEWS |
| KV 命名空间 ID | 6a0e44707a7445fa894b693c220263d6 |

## API 接口

### 1. 增加阅读量

```
POST /api/views
Content-Type: application/json

{
  "articleId": "文章slug"
}
```

**返回示例：**
```json
{
  "success": true,
  "articleId": "ai-news-2026-04-13",
  "views": 42
}
```

### 2. 获取单篇文章阅读量

```
GET /api/views?articleId=文章slug
```

**返回示例：**
```json
{
  "success": true,
  "articleId": "ai-news-2026-04-13",
  "views": 42
}
```

### 3. 批量获取阅读量

```
POST /api/views/batch
Content-Type: application/json

{
  "articleIds": ["slug1", "slug2", "slug3"]
}
```

**返回示例：**
```json
{
  "success": true,
  "views": {
    "slug1": 42,
    "slug2": 128,
    "slug3": 7
  }
}
```

### 4. 订阅博客更新

```
POST /api/subscribe
Content-Type: application/json

{
  "email": "user@example.com"
}
```

**返回示例：**
```json
{
  "success": true,
  "message": "订阅成功！感谢您的关注"
}
```

### 5. 获取统计信息

```
GET /api/stats
```

**返回示例：**
```json
{
  "success": true,
  "stats": {
    "totalArticles": 10,
    "totalViews": 1234,
    "topArticles": []
  }
}
```

## 修改和重新部署步骤

当您需要修改 Worker 代码时，请按以下步骤操作：

### 1. 修改代码

编辑 `worker/views-counter.js` 文件，进行所需的修改。

### 2. 登录 Cloudflare Dashboard

访问：https://dash.cloudflare.com

### 3. 进入 Worker 页面

1. 在左侧菜单中找到 "Workers & Pages"
2. 点击进入
3. 找到 `personal-blog-analytics` Worker
4. 点击 Worker 名称进入详情页

### 4. 编辑 Worker 代码

1. 点击 "Edit code" 按钮
2. 删除编辑器中的所有现有代码
3. 打开 `worker/views-counter.js` 文件，复制全部内容
4. 粘贴到 Cloudflare Worker 编辑器中

### 5. 保存并部署

1. 点击右上角的 "Save and Deploy" 按钮
2. 确认部署
3. 等待部署完成（通常几秒钟）

### 6. 验证部署

访问 Worker 地址验证是否正常工作：
https://analytics.blog.xltz.qzz.io

应该返回 API 文档信息。

## 前端集成

博客前端代码已集成阅读量统计功能：

### article.html

```javascript
// 增加阅读量
const workerUrl = 'https://analytics.blog.xltz.qzz.io';
const response = await fetch(`${workerUrl}/api/views`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ articleId: articleSlug }),
});
```

### index.html

```javascript
// 批量获取阅读量
const workerUrl = 'https://analytics.blog.xltz.qzz.io';
const response = await fetch(`${workerUrl}/api/views/batch`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ articleIds: allArticleSlugs }),
});
```

## 注意事项

1. **CORS 支持**：Worker 已配置 CORS，支持跨域请求
2. **错误处理**：所有 API 都有错误处理，返回标准 JSON 格式
3. **数据持久化**：阅读量数据存储在 Cloudflare KV 中，全球分布式
4. **性能优化**：KV 读取延迟低，适合高并发场景

## 故障排查

### 1. 阅读量不增加

- 检查 Worker 是否正常运行
- 检查 KV 命名空间绑定是否正确
- 检查前端代码中的 Worker 地址是否正确

### 2. API 返回错误

- 检查请求格式是否正确
- 检查 articleId 参数是否提供
- 查看 Worker 日志获取详细错误信息

### 3. 跨域问题

- Worker 已配置 CORS，支持所有来源的请求
- 如果仍有问题，检查浏览器控制台错误信息

## 监控和维护

1. **查看 Worker 日志**：
   - 在 Worker 详情页点击 "Logs"
   - 可以实时查看请求日志

2. **查看 KV 使用情况**：
   - 在左侧菜单找到 "KV"
   - 查看 `BLOG_VIEWS` 命名空间的使用情况

3. **性能监控**：
   - 在 Worker 详情页可以查看请求数、延迟等指标

## 扩展功能

未来可以考虑添加的功能：

1. **每日阅读量统计**：记录每天的阅读量变化
2. **热门文章排行**：按阅读量排序显示热门文章
3. **防刷机制**：添加 IP 限制或验证码
4. **缓存优化**：添加缓存头减少 KV 读取次数

## 更新日志

- 2026-04-13：初始版本，实现基本阅读量统计功能
