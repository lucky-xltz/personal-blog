/**
 * Cloudflare Worker - 博客阅读量统计
 * 
 * 功能说明：
 * 1. 记录文章阅读量，每次访问文章时自动 +1
 * 2. 提供 API 接口获取单篇文章或批量文章的阅读量
 * 3. 数据存储在 Cloudflare KV 中，全球分布式，低延迟
 * 
 * 部署信息：
 * - Worker 名称：personal-blog-analytics
 * - Worker 地址：https://analytics.blog.xltz.qzz.io
 * - KV 命名空间：BLOG_VIEWS
 * - KV 命名空间 ID：6a0e44707a7445fa894b693c220263d6
 * 
 * API 接口：
 * 1. POST /api/views - 增加阅读量
 *    请求体：{ "articleId": "文章slug" }
 *    返回：{ "success": true, "articleId": "xxx", "views": 123 }
 * 
 * 2. GET /api/views?articleId=xxx - 获取单篇文章阅读量
 *    返回：{ "success": true, "articleId": "xxx", "views": 123 }
 * 
 * 3. POST /api/views/batch - 批量获取阅读量
 *    请求体：{ "articleIds": ["slug1", "slug2", "slug3"] }
 *    返回：{ "success": true, "views": { "slug1": 123, "slug2": 456 } }
 * 
 * 使用场景：
 * - article.html：用户访问文章时调用 POST /api/views 增加阅读量
 * - index.html：页面加载时调用 POST /api/views/batch 批量获取所有文章阅读量
 * 
 * 修改说明：
 * 1. 修改此文件后，需要手动复制到 Cloudflare Worker 编辑器中
 * 2. 在 Cloudflare Dashboard 中进入 Worker 页面
 * 3. 点击 "Edit code" 按钮
 * 4. 删除原有代码，粘贴此文件内容
 * 5. 点击 "Save and Deploy" 保存并部署
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }
    
    // 增加阅读量 API
    if (url.pathname === '/api/views' && request.method === 'POST') {
      const { articleId } = await request.json();
      
      if (!articleId) {
        return new Response(JSON.stringify({ error: 'Missing articleId' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      
      try {
        // 获取当前阅读量
        let views = await env.BLOG_VIEWS.get(articleId);
        views = views ? parseInt(views) : 0;
        
        // 增加阅读量
        views += 1;
        await env.BLOG_VIEWS.put(articleId, views.toString());
        
        return new Response(JSON.stringify({ 
          success: true, 
          articleId, 
          views 
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }
    
    // 获取阅读量 API
    if (url.pathname === '/api/views' && request.method === 'GET') {
      const articleId = url.searchParams.get('articleId');
      
      if (!articleId) {
        return new Response(JSON.stringify({ error: 'Missing articleId' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      
      try {
        let views = await env.BLOG_VIEWS.get(articleId);
        views = views ? parseInt(views) : 0;
        
        return new Response(JSON.stringify({ 
          success: true, 
          articleId, 
          views 
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }
    
    // 批量获取阅读量 API
    if (url.pathname === '/api/views/batch' && request.method === 'POST') {
      const { articleIds } = await request.json();
      
      if (!articleIds || !Array.isArray(articleIds)) {
        return new Response(JSON.stringify({ error: 'Missing articleIds array' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      
      try {
        const viewsMap = {};
        
        for (const articleId of articleIds) {
          let views = await env.BLOG_VIEWS.get(articleId);
          viewsMap[articleId] = views ? parseInt(views) : 0;
        }
        
        return new Response(JSON.stringify({ 
          success: true, 
          views: viewsMap 
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
    }
    
    // 默认响应
    return new Response(JSON.stringify({ 
      error: 'Not found',
      endpoints: [
        'POST /api/views - 增加阅读量 { articleId }',
        'GET /api/views?articleId=xxx - 获取阅读量',
        'POST /api/views/batch - 批量获取阅读量 { articleIds: [] }'
      ]
    }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
};
