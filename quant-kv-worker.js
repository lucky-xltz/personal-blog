// Cloudflare KV Worker for Quant Trading System
// Deploy: npx wrangler deploy (or via Cloudflare Dashboard)

export default {
    async fetch(request, env) {
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
        };

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        try {
            // Health check
            if (path === '/health') {
                return new Response(JSON.stringify({ status: 'ok', timestamp: Date.now() }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }

            // GET /get?key=xxx
            if (path === '/get' && request.method === 'GET') {
                const key = url.searchParams.get('key');
                if (!key) {
                    return new Response(JSON.stringify({ error: 'key required' }), {
                        status: 400,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    });
                }
                const value = await env.QUANT_KV.get(key, { type: 'json' });
                return new Response(JSON.stringify({ key, value }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }

            // POST /set  body: { key, value }
            if (path === '/set' && request.method === 'POST') {
                const body = await request.json();
                if (!body.key) {
                    return new Response(JSON.stringify({ error: 'key required' }), {
                        status: 400,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    });
                }
                await env.QUANT_KV.put(body.key, JSON.stringify(body.value));
                return new Response(JSON.stringify({ success: true }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }

            // DELETE /del?key=xxx
            if (path === '/del' && request.method === 'DELETE') {
                const key = url.searchParams.get('key');
                if (!key) {
                    return new Response(JSON.stringify({ error: 'key required' }), {
                        status: 400,
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                    });
                }
                await env.QUANT_KV.delete(key);
                return new Response(JSON.stringify({ success: true }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }

            // List all keys (for debugging)
            if (path === '/list' && request.method === 'GET') {
                const keys = await env.QUANT_KV.list();
                return new Response(JSON.stringify({ keys: keys.keys }), {
                    headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
            }

            return new Response(JSON.stringify({ error: 'Not found' }), {
                status: 404,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });

        } catch (e) {
            return new Response(JSON.stringify({ error: e.message }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
        }
    }
};
