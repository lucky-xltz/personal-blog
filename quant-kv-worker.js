export default {
  async fetch(request, env) {
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers });
    }

    const url = new URL(request.url);
    const p = url.pathname;

    try {
      if (p === '/health') {
        return Response.json({ status: 'ok', ts: Date.now() }, { headers });
      }

      if (p === '/get') {
        const key = url.searchParams.get('key');
        if (!key) return Response.json({ error: 'key required' }, { status: 400, headers });
        const val = await env.QUANT_KV.get(key, { type: 'json' });
        return Response.json({ key, value: val }, { headers });
      }

      if (p === '/set' && request.method === 'POST') {
        const body = await request.json();
        if (!body.key) return Response.json({ error: 'key required' }, { status: 400, headers });
        await env.QUANT_KV.put(body.key, JSON.stringify(body.value));
        return Response.json({ success: true }, { headers });
      }

      if (p === '/del') {
        const key = url.searchParams.get('key');
        if (!key) return Response.json({ error: 'key required' }, { status: 400, headers });
        await env.QUANT_KV.delete(key);
        return Response.json({ success: true }, { headers });
      }

      if (p === '/list') {
        const keys = await env.QUANT_KV.list();
        return Response.json({ keys: keys.keys }, { headers });
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers });

    } catch (e) {
      return Response.json({ error: e.message }, { status: 500, headers });
    }
  }
};
