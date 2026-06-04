/**
 * llm-trader.js
 * --------------------------------------------------------------------
 *  LLM 驱动的量化交易决策模块（纯 JS / 浏览器 + Node 双端）
 *
 *  依赖 quant.html 已有的全局：
 *    - state, STOCK_POOL, MODES, TRADING_RULES
 *    - priceHistory[code], volumeHistory[code]
 *    - evaluateAllStrategies(code, quote)  本地多策略评估
 *    - computeSignalScore(code, quote)     综合信号打分
 *    - calculateTotalAssets() / getStockPrice(code)
 *    - executeBuyWithStrategy / executeSellWithStrategy
 *    - addLog(msg, type)
 *
 *  入口：
 *    import { aiTradingDecision } from './quant/llm-trader.js'
 *    或在 HTML 引入 <script src="quant/llm-trader.js"></script>
 * --------------------------------------------------------------------
 */

const LLM_CONFIG = {
    baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
    apiKey:  'tp-coj5n1xglqfeza26e5dxm3ll3w1jfki3ewz511r7samqr5vh',
    model:   'mimo-v2.5-pro',
    timeoutMs: 30000,
    temperature: 0.2,
    maxRetries: 2,
};

/* ============================================================
 *  1. 多类数据信息聚合（分多类数据）
 * ============================================================ */

/**
 * 把候选股票列表变成"分多类数据信息"——便于模型推理
 *   categories: 市场账户 | 持仓 | 候选 | 技术面 | 资金流 | 板块情绪
 */
function buildMarketContext(candidates /* [{ stock, quote, evaluation, score }] */) {
    const totalAssets = calculateTotalAssets();
    const cash        = state.cash;
    const invested    = totalAssets - cash;
    const exposurePct = totalAssets > 0 ? (invested / totalAssets) * 100 : 0;

    // 1) 账户概览
    const account = {
        totalAssets: round2(totalAssets),
        cash: round2(cash),
        invested: round2(invested),
        exposurePct: round2(exposurePct),
        dailyTrades: state.dailyTrades,
        maxDailyTrades: MODES[state.mode] ? MODES[state.mode].maxDailyTrades : 5,
        mode: state.mode,
        modeName: MODES[state.mode] ? MODES[state.mode].name : '稳健',
        isMarketOpen: isMarketOpen(),
    };

    // 2) 当前持仓
    const positions = Object.keys(state.positions).map(code => {
        const pos = state.positions[code];
        const quote = getStockPrice(code);
        const price = quote ? quote.price : pos.avgCost;
        const profitPct = ((price - pos.avgCost) / pos.avgCost) * 100;
        return {
            code,
            name: pos.name,
            quantity: pos.quantity,            // 手
            shares: pos.quantity * 100,
            avgCost: round2(pos.avgCost),
            currentPrice: round2(price),
            marketValue: round2(pos.quantity * 100 * price),
            profitPct: round2(profitPct),
            peakPrice: pos.peakPrice ? round2(pos.peakPrice) : null,
            trailingStopPct: pos.trailingStopPct,
            strategy: pos.strategy || null,
        };
    });

    // 3) 候选股票（含技术面+策略评估）
    const candidateRows = (candidates || []).map(c => {
        const stock  = c.stock;
        const quote  = c.quote;
        const ev     = c.evaluation || {};
        const prices = priceHistory[stock.code] || [];
        const tech   = computeQuickTech(prices, quote);

        return {
            code: stock.code,
            name: stock.name,
            sector: stock.sector,
            price: round2(quote.price),
            changePct: round2(quote.changePct || 0),
            amount: round2((quote.amount || 0) / 1e8),  // 亿
            // 技术面
            technical: {
                rsi: tech.rsi,
                macd: tech.macd,
                ma5: tech.ma5,
                ma20: tech.ma20,
                trend: tech.trend,
                atrPct: tech.atrPct,
                volatility: tech.volatility,
            },
            // 策略评估
            strategy: {
                action: ev.action || 'wait',
                confidence: ev.confidence || 0,
                buySignals: ev.buySignals || 0,
                sellSignals: ev.sellSignals || 0,
                reason: ev.reason || '',
                stopLoss: ev.stopLoss ? round2(ev.stopLoss) : null,
                takeProfit: ev.takeProfit ? round2(ev.takeProfit) : null,
            },
            // 综合打分
            score: round2(c.score || 0),
        };
    });

    // 4) 板块情绪（按 sector 聚合）
    const sectorMap = {};
    candidateRows.forEach(r => {
        if (!sectorMap[r.sector]) sectorMap[r.sector] = { sector: r.sector, count: 0, avgChange: 0, avgScore: 0, buyCnt: 0, sellCnt: 0 };
        const agg = sectorMap[r.sector];
        agg.count += 1;
        agg.avgChange += r.changePct;
        agg.avgScore += r.score;
        if (r.strategy.action === 'buy') agg.buyCnt += 1;
        if (r.strategy.action === 'sell') agg.sellCnt += 1;
    });
    const sector = Object.values(sectorMap).map(s => ({
        sector: s.sector,
        count: s.count,
        avgChangePct: round2(s.avgChange / Math.max(1, s.count)),
        avgScore: round2(s.avgScore / Math.max(1, s.count)),
        buyCount: s.buyCnt,
        sellCount: s.sellCnt,
    })).sort((a, b) => b.avgScore - a.avgScore);

    // 5) 风险/风控上下文（让模型也尊重规则）
    const risk = {
        maxSinglePosition: TRADING_RULES.MAX_SINGLE_POSITION,
        maxSectorExposure: TRADING_RULES.MAX_SECTOR_EXPOSURE,
        maxTotalExposure: TRADING_RULES.MAX_TOTAL_EXPOSURE,
        stopLossPct: TRADING_RULES.STOP_LOSS_PCT[state.mode],
        takeProfitPct: TRADING_RULES.TAKE_PROFIT_PCT[state.mode],
        tPlus1: TRADING_RULES.T_PLUS_1,
    };

    return {
        timestamp: new Date().toISOString(),
        account,
        positions,
        candidates: candidateRows,
        sector,
        risk,
    };
}

function computeQuickTech(prices, quote) {
    if (!prices || prices.length < 5) {
        return { rsi: null, macd: null, ma5: null, ma20: null, trend: 'unknown', atrPct: null, volatility: null };
    }
    const rsi = calcRSI(prices, 14);
    const ma5  = last(calcMA(prices, Math.min(5, prices.length)));
    const ma20 = prices.length >= 20 ? last(calcMA(prices, 20)) : null;
    let macd = null;
    if (prices.length >= 26) {
        const m = calcMACD(prices);
        macd = { dif: round3(m.dif), dea: round3(m.dea), macd: round3(m.macd) };
    }
    const atr = calcATR(prices, 14);
    const atrPct = quote && quote.price > 0 ? round2((atr / quote.price) * 100) : null;
    const trend = calcTrendFilter(prices);
    return {
        rsi: Math.round(rsi),
        macd,
        ma5: ma5  != null ? round2(ma5)  : null,
        ma20: ma20 != null ? round2(ma20) : null,
        trend,
        atrPct,
    };
}

function round2(v) { return Math.round((v || 0) * 100) / 100; }
function round3(v) { return Math.round((v || 0) * 1000) / 1000; }
function last(arr) { return Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null; }

function isMarketOpen() {
    const d = new Date();
    const day = d.getDay();
    if (day < 1 || day > 5) return false;
    const h = d.getHours(), m = d.getMinutes();
    const mins = h * 60 + m;
    return (mins >= 9 * 60 + 30 && mins <= 11 * 60 + 30) || (mins >= 13 * 60 && mins < 15 * 60);
}

/* ============================================================
 *  2. 量化交易提示词模板（强约束 JSON Schema）
 * ============================================================ */

function buildLLMPrompt(ctx) {
    return `你是一名专业的 A 股量化交易 AI，遵循"风控优先 + 顺势而为 + 严格止损止盈"的原则。下面是当前的市场上下文（已按"账户/持仓/候选/技术面/板块/风险"分多类整理）：

\`\`\`json
${JSON.stringify(ctx, null, 2)}
\`\`\`

【交易模式】${ctx.account.modeName}（止损 ${(ctx.risk.stopLossPct * 100).toFixed(0)}% / 止盈 ${(ctx.risk.takeProfitPct * 100).toFixed(0)}% / 日交易上限 ${ctx.account.maxDailyTrades} 次）

【决策规则】
1. 必须严格遵守风控上限：单票 ${(ctx.risk.maxSinglePosition * 100).toFixed(0)}%、单板块 ${(ctx.risk.maxSectorExposure * 100).toFixed(0)}%、总仓位 ${(ctx.risk.maxTotalExposure * 100).toFixed(0)}%。
2. 已有持仓优先考虑是否止盈/止损/持有，而不是开新仓。
3. 候选 action 仅三种：buy | sell | hold。
4. 候选股票中 strategy.action 为 wait 且 confidence < 0.6 时不要买。
5. 同板块已重仓时不要再加仓。
6. 必须输出合法 JSON，**只输出 JSON，不要任何解释、前后缀、Markdown**。

【输出 JSON Schema（严格遵守）】
{
  "marketView": "<=60字 总体看法: bull/bear/neutral/rotating + 简要逻辑>",
  "decisions": [
    {
      "code": "股票代码",
      "name": "股票名称",
      "action": "buy" | "sell" | "hold",
      "lots": <正整数, 多少手, 100 的倍数>,
      "confidence": <0~1 浮点>,
      "reason": "<=80字 中文理由>",
      "stopLoss": <number 或 null, 触发止损价>,
      "takeProfit": <number 或 null, 触发止盈价>,
      "urgency": "low" | "normal" | "high"
    }
  ],
  "riskNotes": "<=120字 风控说明, 包括为什么不开某些仓 / 为何减仓>"
}

请基于以上信息输出 JSON 决策。`;
}

/* ============================================================
 *  3. LLM 调用（OpenAI 兼容 chat/completions）
 * ============================================================ */

async function callLLM(prompt) {
    const url = `${LLM_CONFIG.baseURL}/chat/completions`;
    const body = {
        model: LLM_CONFIG.model,
        temperature: LLM_CONFIG.temperature,
        messages: [
            { role: 'system', content: '你是严格遵守 JSON Schema 的 A 股量化交易 AI，只输出 JSON。' },
            { role: 'user',   content: prompt },
        ],
        // 强制 JSON 输出（部分服务支持）
        response_format: { type: 'json_object' },
    };

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), LLM_CONFIG.timeoutMs);

    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${LLM_CONFIG.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!resp.ok) {
            const text = await resp.text().catch(() => '');
            throw new Error(`LLM HTTP ${resp.status}: ${text.slice(0, 300)}`);
        }
        const data = await resp.json();
        const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!content) throw new Error('LLM 返回内容为空');
        return content;
    } finally {
        clearTimeout(t);
    }
}

/* ============================================================
 *  4. 解析模型返回（容错）
 * ============================================================ */

function parseLLMDecision(rawText) {
    if (!rawText) throw new Error('LLM 返回为空');

    // 1) 去掉 markdown code fence
    let text = String(rawText).trim()
        .replace(/^```(?:json)?/i, '')
        .replace(/```\s*$/, '')
        .trim();

    // 2) 抽取首个 {...}
    const first = text.indexOf('{');
    const last  = text.lastIndexOf('}');
    if (first >= 0 && last > first) text = text.slice(first, last + 1);

    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch (e) {
        throw new Error('LLM JSON 解析失败: ' + e.message + ' | 原文: ' + text.slice(0, 200));
    }

    if (!parsed || typeof parsed !== 'object') throw new Error('LLM 返回非对象');
    if (!Array.isArray(parsed.decisions)) parsed.decisions = [];

    // 字段归一化 + 校验
    parsed.decisions = parsed.decisions
        .filter(d => d && typeof d === 'object' && d.code)
        .map(d => {
            const action = String(d.action || 'hold').toLowerCase();
            return {
                code: String(d.code),
                name: d.name || '',
                action: ['buy', 'sell', 'hold'].includes(action) ? action : 'hold',
                lots: Math.max(0, Math.floor(Number(d.lots) || 0)),
                confidence: clamp01(Number(d.confidence) || 0),
                reason: String(d.reason || '').slice(0, 200),
                stopLoss: numberOrNull(d.stopLoss),
                takeProfit: numberOrNull(d.takeProfit),
                urgency: ['low', 'normal', 'high'].includes(d.urgency) ? d.urgency : 'normal',
            };
        });

    return parsed;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function numberOrNull(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/* ============================================================
 *  5. 决策翻译 → 复用现有 executeBuy/Sell
 * ============================================================ */

async function aiTradingDecision() {
    // 1. 先用本地策略给所有候选打分（与原 tradingDecision 一致）
    const scored = STOCK_POOL.map(item => {
        const quote = getStockPrice(item.code);
        if (!quote || quote.price <= 0) return null;
        const evaluation = evaluateAllStrategies(item.code, quote);
        const analysis   = analyzeStock(item.code, quote);
        return {
            stock: item,
            quote,
            evaluation,
            analysis,
            score: analysis ? analysis.score : -999,
        };
    }).filter(Boolean).sort((a, b) => b.score - a.score);

    // 2. 组装上下文
    const ctx = buildMarketContext(scored);

    // 3. 拼 prompt + 调 LLM
    const prompt = buildLLMPrompt(ctx);
    addLog?.('🤖 正在向 LLM 请求决策…', 'action');

    let raw;
    let decision;
    let lastErr;
    for (let i = 0; i <= LLM_CONFIG.maxRetries; i++) {
        try {
            raw = await callLLM(prompt);
            decision = parseLLMDecision(raw);
            break;
        } catch (e) {
            lastErr = e;
            addLog?.('⚠️ LLM 调用/解析失败(' + (i + 1) + '): ' + e.message, 'warn');
        }
    }
    if (!decision) {
        addLog?.('❌ LLM 决策最终失败，回退本地策略: ' + lastErr?.message, 'error');
        return { ok: false, error: lastErr?.message, usedFallback: true };
    }

    addLog?.(`🧠 LLM 视角: ${decision.marketView || '-'}`, 'action');
    addLog?.(`📋 决策 ${decision.decisions.length} 条; 风控: ${decision.riskNotes || '-'}`, 'info');

    // 4. 把 LLM 决策翻译成 buy/sell 调用
    const results = [];
    for (const d of decision.decisions) {
        const stock = STOCK_POOL.find(s => s.code === d.code);
        const quote = getStockPrice(d.code);
        if (!stock || !quote) {
            results.push({ code: d.code, action: d.action, skipped: true, reason: '无行情/无股票' });
            continue;
        }

        // 已有持仓？
        const hasPos = !!state.positions[d.code];

        // === BUY ===
        if (d.action === 'buy') {
            if (hasPos) {
                results.push({ code: d.code, action: 'buy', skipped: true, reason: '已持仓, 不重复建仓' });
            } else if (d.lots <= 0) {
                results.push({ code: d.code, action: 'buy', skipped: true, reason: 'lots <= 0' });
            } else {
                const evaluation = {
                    action: 'buy',
                    reason: '[LLM] ' + d.reason,
                    confidence: d.confidence,
                    stopLoss: d.stopLoss,
                    takeProfit: d.takeProfit,
                };
                const ok = executeBuyWithStrategy(d.code, quote, evaluation);
                results.push({ code: d.code, action: 'buy', lots: d.lots, ok });
            }
        }
        // === SELL ===
        else if (d.action === 'sell') {
            if (!hasPos) {
                results.push({ code: d.code, action: 'sell', skipped: true, reason: '无持仓可卖' });
            } else {
                const evaluation = {
                    action: 'sell',
                    reason: '[LLM] ' + d.reason,
                    confidence: d.confidence,
                };
                const ok = executeSellWithStrategy(d.code, quote, evaluation);
                results.push({ code: d.code, action: 'sell', ok });
            }
        }
        // === HOLD ===
        else {
            results.push({ code: d.code, action: 'hold', skipped: true, reason: 'hold 不操作' });
        }
    }

    return { ok: true, decision, results };
}

/* ============================================================
 *  6. 导出（浏览器 + Node 双端）
 * ============================================================ */

const llmTrader = {
    LLM_CONFIG,
    buildMarketContext,
    buildLLMPrompt,
    callLLM,
    parseLLMDecision,
    aiTradingDecision,
};

if (typeof window !== 'undefined') {
    window.LLMTrader = llmTrader;
    // 也暴露为全局函数方便 HTML 内调用
    window.aiLLMTradingDecision = aiTradingDecision;
}
// 同时兼容 Node CommonJS（测试用）与浏览器 <script> 标签
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        LLM_CONFIG,
        buildMarketContext,
        buildLLMPrompt,
        callLLM,
        parseLLMDecision,
        aiTradingDecision,
    };
}
