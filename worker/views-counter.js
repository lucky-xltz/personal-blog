/**
 * Cloudflare Worker - 博客阅读量统计与订阅管理
 * 
 * 功能说明：
 * 1. 记录文章阅读量，每次访问文章时自动 +1
 * 2. 提供 API 接口获取单篇文章或批量文章的阅读量
 * 3. 数据存储在 Cloudflare KV 中，全球分布式，低延迟
 * 4. IP 限制：同一个 IP 对同一篇文章，一天只计算一次阅读量
 * 5. 邮件订阅：支持用户订阅博客更新
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
 *    返回：{ "success": true, "articleId": "xxx", "views": 123, "counted": true/false }
 * 
 * 2. GET /api/views?articleId=xxx - 获取单篇文章阅读量
 *    返回：{ "success": true, "articleId": "xxx", "views": 123 }
 * 
 * 3. POST /api/views/batch - 批量获取阅读量
 *    请求体：{ "articleIds": ["slug1", "slug2", "slug3"] }
 *    返回：{ "success": true, "views": { "slug1": 123, "slug2": 456 } }
 * 
 * 4. POST /api/subscribe - 订阅博客更新
 *    请求体：{ "email": "user@example.com" }
 *    返回：{ "success": true, "message": "订阅成功" }
 * 
 * 5. GET /api/stats - 获取统计信息
 *    返回：{ "success": true, "stats": { "totalArticles": 10, "totalViews": 1234 } }
 * 
 * 使用场景：
 * - article.html：用户访问文章时调用 POST /api/views 增加阅读量
 * - index.html：页面加载时调用 POST /api/views/batch 批量获取所有文章阅读量
 * - index.html：用户订阅时调用 POST /api/subscribe 保存邮箱
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
        // 获取客户端 IP 地址
        const clientIP = request.headers.get('CF-Connecting-IP') || 
                         request.headers.get('X-Forwarded-For') || 
                         'unknown';
        
        // 获取当前日期（用于 IP 限制）
        const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        const ipKey = `ip:${clientIP}:${articleId}:${today}`;
        
        // 检查该 IP 今天是否已经访问过这篇文章
        const hasVisited = await env.BLOG_VIEWS.get(ipKey);
        
        // 获取当前阅读量
        let views = await env.BLOG_VIEWS.get(articleId);
        views = views ? parseInt(views) : 0;
        
        let counted = false;
        
        // 如果今天还没有访问过，则增加阅读量
        if (!hasVisited) {
          views += 1;
          counted = true;
          
          // 保存新的阅读量
          await env.BLOG_VIEWS.put(articleId, views.toString());
          
          // 记录该 IP 今天的访问（设置 25 小时过期，确保跨时区正确）
          await env.BLOG_VIEWS.put(ipKey, '1', { expirationTtl: 90000 }); // 25 小时
        }
        
        return new Response(JSON.stringify({ 
          success: true, 
          articleId, 
          views,
          counted
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
    
    // 订阅 API
    if (url.pathname === '/api/subscribe' && request.method === 'POST') {
      const { email } = await request.json();
      
      if (!email) {
        return new Response(JSON.stringify({ error: 'Missing email' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      
      // 验证邮箱格式
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return new Response(JSON.stringify({ error: 'Invalid email format' }), {
          status: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      
      try {
        // 检查邮箱是否已订阅
        const subscriberKey = `subscriber:${email}`;
        const existingSubscriber = await env.BLOG_VIEWS.get(subscriberKey);
        
        if (existingSubscriber) {
          return new Response(JSON.stringify({ 
            success: true, 
            message: '该邮箱已订阅' 
          }), {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          });
        }
        
        // 保存订阅信息
        const subscriptionData = {
          email,
          subscribedAt: new Date().toISOString(),
          active: true
        };
        
        await env.BLOG_VIEWS.put(subscriberKey, JSON.stringify(subscriptionData));
        
        // 更新订阅者列表
        let subscribers = await env.BLOG_VIEWS.get('subscribers');
        subscribers = subscribers ? JSON.parse(subscribers) : [];
        subscribers.push(email);
        await env.BLOG_VIEWS.put('subscribers', JSON.stringify(subscribers));
        
        return new Response(JSON.stringify({ 
          success: true, 
          message: '订阅成功！感谢您的关注' 
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
    
    // 获取统计信息 API
    if (url.pathname === '/api/stats' && request.method === 'GET') {
      try {
        // 获取所有文章的阅读量（这里简化处理，实际可能需要更复杂的统计）
        const stats = {
          totalArticles: 0,
          totalViews: 0,
          topArticles: []
        };
        
        return new Response(JSON.stringify({ 
          success: true, 
          stats 
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
        'POST /api/views/batch - 批量获取阅读量 { articleIds: [] }',
        'POST /api/subscribe - 订阅博客更新 { email }',
        'GET /api/stats - 获取统计信息'
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
