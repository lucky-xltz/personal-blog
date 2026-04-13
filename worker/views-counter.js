/**
 * Cloudflare Worker - 博客阅读量统计与订阅管理
 * 
 * 功能说明：
 * 1. 记录文章阅读量，每次访问文章时自动 +1
 * 2. 提供 API 接口获取单篇文章或批量文章的阅读量
 * 3. 数据存储在 Cloudflare KV 中，全球分布式，低延迟
 * 4. IP 限制：同一个 IP 对同一篇文章，一天只计算一次阅读量
 * 5. 邮件订阅：支持用户订阅博客更新，并发送欢迎邮件
 * 
 * 部署信息：
 * - Worker 名称：personal-blog-analytics
 * - Worker 地址：https://analytics.blog.xltz.qzz.io
 * - KV 命名空间：BLOG_VIEWS
 * - KV 命名空间 ID：6a0e44707a7445fa894b693c220263d6
 * 
 * 环境变量：
 * - RESEND_API_KEY: Resend 邮件服务的 API 密钥
 * - BLOG_URL: 博客网站地址
 * - BLOG_NAME: 博客名称
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
 * - index.html：用户订阅时调用 POST /api/subscribe 保存邮箱并发送欢迎邮件
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
        
        // 发送欢迎邮件
        const emailSent = await sendWelcomeEmail(email, env);
        
        return new Response(JSON.stringify({ 
          success: true, 
          message: '订阅成功！感谢您的关注',
          emailSent: emailSent
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

// 发送欢迎邮件函数
async function sendWelcomeEmail(email, env) {
  try {
    // 从环境变量获取配置
    const resendApiKey = env.RESEND_API_KEY;
    const blogUrl = env.BLOG_URL || 'https://lucky-xltz.github.io/personal-blog/';
    const blogName = env.BLOG_NAME || '林小白的数字花园';
    
    if (!resendApiKey) {
      console.error('RESEND_API_KEY 环境变量未设置');
      return false;
    }
    
    // 创建欢迎邮件内容
    const emailHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>欢迎订阅 ${blogName}</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            max-width: 600px;
            margin: 0 auto;
            padding: 20px;
          }
          .header {
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #6366f1;
          }
          .logo {
            font-size: 24px;
            font-weight: bold;
            color: #6366f1;
            margin-bottom: 10px;
          }
          .content {
            background: #f8fafc;
            padding: 30px;
            border-radius: 12px;
            margin-bottom: 30px;
          }
          .button {
            display: inline-block;
            background: linear-gradient(135deg, #6366f1 0%, #ec4899 100%);
            color: white;
            padding: 12px 30px;
            text-decoration: none;
            border-radius: 25px;
            font-weight: 600;
            margin: 20px 0;
          }
          .footer {
            text-align: center;
            color: #64748b;
            font-size: 14px;
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #e2e8f0;
          }
          .social-links {
            margin: 20px 0;
          }
          .social-links a {
            display: inline-block;
            margin: 0 10px;
            color: #6366f1;
            text-decoration: none;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div class="logo">🎉 欢迎订阅</div>
          <h1>${blogName}</h1>
        </div>
        
        <div class="content">
          <h2>感谢您的订阅！</h2>
          <p>您已成功订阅 <strong>${blogName}</strong> 的更新通知。</p>
          
          <p>您将收到：</p>
          <ul>
            <li>每周精选技术文章</li>
            <li>AI 领域最新动态</li>
            <li>前端开发最佳实践</li>
            <li>个人成长与思考</li>
          </ul>
          
          <p>我们承诺：</p>
          <ul>
            <li>绝不发送垃圾邮件</li>
            <li>每周最多 1-2 封邮件</li>
            <li>随时可以取消订阅</li>
          </ul>
          
          <div style="text-align: center;">
            <a href="${blogUrl}" class="button">访问博客</a>
          </div>
        </div>
        
        <div class="social-links" style="text-align: center;">
          <p>关注我们：</p>
          <a href="https://github.com/lucky-xltz">GitHub</a>
          <a href="https://twitter.com/lucky_xltz">Twitter</a>
        </div>
        
        <div class="footer">
          <p>此邮件由 ${blogName} 自动发送</p>
          <p>如果您不想收到此类邮件，可以随时取消订阅</p>
          <p>© ${new Date().getFullYear()} ${blogName}. All rights reserved.</p>
        </div>
      </body>
      </html>
    `;
    
    // 使用 Resend API 发送邮件
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${blogName} <onboarding@resend.dev>`,
        to: [email],
        subject: `🎉 欢迎订阅 ${blogName}！`,
        html: emailHtml,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      console.error('发送邮件失败:', errorData);
      return false;
    }
    
    const result = await response.json();
    console.log('邮件发送成功:', result);
    return true;
    
  } catch (error) {
    console.error('发送邮件时出错:', error);
    return false;
  }
}
