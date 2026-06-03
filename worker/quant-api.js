/**
 * Cloudflare Worker - 量化交易数据存储
 * 
 * 功能说明：
 * 1. 存储用户持仓数据
 * 2. 存储交易历史记录
 * 3. 存储策略配置
 * 4. 提供买卖接口
 * 
 * 部署信息：
 * - 复用现有 Worker: personal-blog-analytics
 * - KV 命名空间: BLOG_VIEWS (复用)
 * - 前缀: quant_ 区分量化数据
 * 
 * API 接口：
 * 1. GET /api/quant/state - 获取交易状态
 * 2. POST /api/quant/state - 保存交易状态
 * 3. POST /api/quant/trade - 执行交易（预留）
 * 4. GET /api/quant/history - 获取交易历史
 */

// 在现有 Worker 中添加以下路由：

// 量化交易 - 获取状态
if (url.pathname === '/api/quant/state' && request.method === 'GET') {
  try {
    const state = await env.BLOG_VIEWS.get('quant_state');
    return new Response(JSON.stringify({
      success: true,
      state: state ? JSON.parse(state) : null
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

// 量化交易 - 保存状态
if (url.pathname === '/api/quant/state' && request.method === 'POST') {
  try {
    const { state } = await request.json();
    await env.BLOG_VIEWS.put('quant_state', JSON.stringify(state));
    return new Response(JSON.stringify({ success: true }), {
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

// 量化交易 - 执行交易（预留接口）
if (url.pathname === '/api/quant/trade' && request.method === 'POST') {
  try {
    const { action, stockCode, quantity, price } = await request.json();
    
    // 验证参数
    if (!action || !stockCode || !quantity || !price) {
      return new Response(JSON.stringify({ error: 'Missing parameters' }), {
        status: 400,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // TODO: 接入真实交易 API
    // 目前返回模拟成功
    const result = {
      success: true,
      action,
      stockCode,
      quantity,
      price,
      timestamp: new Date().toISOString(),
      message: '模拟交易成功（待接入真实API）'
    };

    // 记录交易历史
    let history = await env.BLOG_VIEWS.get('quant_history');
    history = history ? JSON.parse(history) : [];
    history.unshift(result);
    // 保留最近100条
    if (history.length > 100) history = history.slice(0, 100);
    await env.BLOG_VIEWS.put('quant_history', JSON.stringify(history));

    return new Response(JSON.stringify(result), {
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

// 量化交易 - 获取历史
if (url.pathname === '/api/quant/history' && request.method === 'GET') {
  try {
    const history = await env.BLOG_VIEWS.get('quant_history');
    return new Response(JSON.stringify({
      success: true,
      history: history ? JSON.parse(history) : []
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
