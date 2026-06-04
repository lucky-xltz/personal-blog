/**
 * llm-trader.test.js
 * Node ≥18 自带 fetch / AbortController
 *
 * 验证:
 *   1. parseLLMDecision  - JSON 解析/容错/字段归一化
 *   2. buildMarketContext - 分多类数据信息聚合
 *   3. buildLLMPrompt    - 提示词模板完整
 *   4. end-to-end mock   - 模拟模型返回 → executeBuy/Sell 联动
 *   5. live call (可选)  - 真实打 mimo-v2.5-pro
 *
 * 运行: node quant/llm-trader.test.js
 */

const path = require('path');
const fs   = require('fs');

// === 浏览器全局桩（让 llm-trader.js 在 Node 环境下运行）===
global.window = global;

// === 准备 fake 账户 / 策略 / 指标 ===
const STOCK_POOL = [
    { code: '600519', name: '贵州茅台', sector: '白酒' },
    { code: '000858', name: '五粮液',   sector: '白酒' },
    { code: '300750', name: '宁德时代', sector: '新能源' },
    { code: '600036', name: '招商银行', sector: '银行' },
];
const MODES = {
    balanced: { stopLoss: 0.03, takeProfit: 0.08, maxDailyTrades: 5, name: '稳健' },
    aggressive: { stopLoss: 0.05, takeProfit: 0.15, maxDailyTrades: 10, name: '激进' },
};
const TRADING_RULES = {
    MAX_SINGLE_POSITION: 0.30, MAX_SECTOR_EXPOSURE: 0.40, MAX_TOTAL_EXPOSURE: 0.80,
    STOP_LOSS_PCT: { balanced: 0.05, aggressive: 0.08 },
    TAKE_PROFIT_PCT: { balanced: 0.12, aggressive: 0.20 },
    T_PLUS_1: true,
};
const state = {
    mode: 'balanced',
    cash: 100000,
    positions: {},
    trades: [],
    dailyTrades: 0,
    equityHistory: [],
};

const priceHistory = {
    '600519': [1500,1510,1505,1520,1518,1525,1530,1528,1535,1540,1545,1550,1548,1555,1560,1565,1570,1568,1575,1580,1582,1585,1588,1590,1592,1595,1600,1602,1605,1610],
    '000858': [140,141,142,141,143,144,145,144,146,147,148,147,149,150,151,150,152,153,154,153,155,156,157,158,159,160,161,162,163,164],
    '300750': [200,201,199,198,200,202,203,201,202,204,205,206,205,207,208,209,210,208,209,211,212,213,214,213,215,216,217,218,219,220],
    '600036': [35,35.1,35.2,35.1,35.3,35.4,35.5,35.4,35.6,35.7,35.8,35.7,35.9,36,36.1,36,36.2,36.3,36.4,36.3,36.5,36.6,36.7,36.8,36.9,37,37.1,37.2,37.3,37.4],
};
const volumeHistory = {};
Object.keys(priceHistory).forEach(c => { volumeHistory[c] = priceHistory[c].map(() => 1e6); });

// 加载被测模块（注意：模块内会读 window.fetch；我们在调用 callLLM 之前替换）
function calcMA(arr, n) {
    if (arr.length < n) return arr.map(() => null);
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        if (i < n - 1) { out.push(null); continue; }
        const slice = arr.slice(i - n + 1, i + 1);
        out.push(slice.reduce((a, b) => a + b, 0) / n);
    }
    return out;
}
function calcRSI(arr, n = 14) {
    if (arr.length < n + 1) return 50;
    let gain = 0, loss = 0;
    for (let i = arr.length - n; i < arr.length; i++) {
        const d = arr[i] - arr[i - 1];
        if (d > 0) gain += d; else loss -= d;
    }
    if (loss === 0) return 100;
    const rs = gain / loss;
    return 100 - 100 / (1 + rs);
}
function calcEMA(arr, n) {
    const k = 2 / (n + 1);
    const ema = [arr[0]];
    for (let i = 1; i < arr.length; i++) ema.push(arr[i] * k + ema[i - 1] * (1 - k));
    return ema;
}
function calcMACD(arr) {
    const e12 = calcEMA(arr, 12), e26 = calcEMA(arr, 26);
    const dif = e12.map((v, i) => v - e26[i]);
    const dea = calcEMA(dif, 9);
    const macd = dif.map((v, i) => (v - dea[i]) * 2);
    return { dif: dif[dif.length - 1], dea: dea[dea.length - 1], macd: macd[macd.length - 1] };
}
function calcATR(arr, n = 14) {
    if (arr.length < 2) return 0;
    const trs = arr.slice(1).map((v, i) => Math.abs(v - arr[i]));
    const last = trs.slice(-n);
    return last.reduce((a, b) => a + b, 0) / last.length;
}
function calcTrendFilter(arr) {
    if (arr.length < 20) return 'unknown';
    const e = calcEMA(arr, 20);
    return e[e.length - 1] > e[e.length - 5] ? 'up' : 'down';
}

global.STOCK_POOL = STOCK_POOL;
global.MODES = MODES;
global.TRADING_RULES = TRADING_RULES;
global.state = state;
global.priceHistory = priceHistory;
global.volumeHistory = volumeHistory;
global.calcMA = calcMA;
global.calcRSI = calcRSI;
global.calcEMA = calcEMA;
global.calcMACD = calcMACD;
global.calcATR = calcATR;
global.calcTrendFilter = calcTrendFilter;
global.getStockPrice = (code) => {
    const arr = priceHistory[code];
    if (!arr || !arr.length) return null;
    const price = arr[arr.length - 1];
    return { code, price, changePct: ((price - arr[arr.length - 2]) / arr[arr.length - 2]) * 100, amount: 1e9 };
};
global.calculateTotalAssets = () => {
    let total = state.cash;
    Object.keys(state.positions).forEach(code => {
        const p = state.positions[code];
        const q = getStockPrice(code);
        total += p.quantity * 100 * (q ? q.price : p.avgCost);
    });
    return total;
};
global.evaluateAllStrategies = (code, quote) => {
    const prices = priceHistory[code] || [];
    const trend = calcTrendFilter(prices);
    const rsi = calcRSI(prices, 14);
    let action = 'wait', reason = '无明确信号', confidence = 0.3;
    if (trend === 'up' && rsi < 70) { action = 'buy'; reason = '趋势向上+RSI未超买'; confidence = 0.7; }
    if (trend === 'down' && rsi > 30) { action = 'sell'; reason = '趋势向下+RSI未超卖'; confidence = 0.6; }
    return {
        action, reason, confidence,
        buySignals: action === 'buy' ? 2 : 0,
        sellSignals: action === 'sell' ? 2 : 0,
        strategies: [],
        stopLoss: action === 'buy' ? quote.price * 0.97 : null,
        takeProfit: action === 'buy' ? quote.price * 1.08 : null,
    };
};
global.analyzeStock = (code, quote) => {
    const ev = global.evaluateAllStrategies(code, quote);
    return { score: ev.action === 'buy' ? 5 : ev.action === 'sell' ? -5 : 0, signals: [] };
};
global.executeBuy = (code, name, qty, price) => {
    const total = qty * 100 * price;
    const fee   = total * 0.0003;
    if (total + fee > state.cash) return false;
    state.cash -= total + fee;
    if (state.positions[code]) {
        const p = state.positions[code];
        p.avgCost = (p.avgCost * p.quantity + price * qty) / (p.quantity + qty);
        p.quantity += qty;
    } else {
        state.positions[code] = { name, quantity: qty, avgCost: price, peakPrice: price, trailingStopPct: 0.025 };
    }
    state.trades.unshift({ time: new Date().toISOString(), code, name, action: 'buy', quantity: qty, price });
    state.dailyTrades++;
    return true;
};
global.executeSell = (code, qty, price) => {
    const p = state.positions[code];
    if (!p || p.quantity < qty) return false;
    const total = qty * 100 * price;
    const fee   = total * 0.0003 + total * 0.001;
    state.cash += total - fee;
    p.quantity -= qty;
    if (p.quantity === 0) delete state.positions[code];
    state.trades.unshift({ time: new Date().toISOString(), code, name: p.name, action: 'sell', quantity: qty, price });
    state.dailyTrades++;
    return true;
};
global.executeBuyWithStrategy = (code, quote, ev) => {
    const stock = STOCK_POOL.find(s => s.code === code);
    if (!stock) return false;
    if (state.dailyTrades >= MODES[state.mode].maxDailyTrades) return false;
    // 简化仓位: 总资产 5%, 但至少买得起 1 手
    const totalAssets = global.calculateTotalAssets();
    const target = Math.max(1, Math.floor((totalAssets * 0.10) / (quote.price * 100)));
    // 资金允许的手数
    const maxLots = Math.floor(state.cash / (quote.price * 100 * 1.001));
    const lots = Math.max(0, Math.min(target, maxLots));
    if (lots < 1) return false;
    return global.executeBuy(code, stock.name, lots, quote.price);
};
global.executeSellWithStrategy = (code, quote, ev) => {
    const p = state.positions[code];
    if (!p) return false;
    return global.executeSell(code, p.quantity, quote.price);
};
global.addLog = (msg, type) => console.log(`[${type||'info'}] ${msg}`);

// 加载被测模块（注意：模块内会读 window.fetch；我们在调用 callLLM 之前替换）
const trader = require(path.resolve(__dirname, '../quant/llm-trader.js'));

// =========== inline 最小技术指标（Node 端, 不引用 quant.html 里的全局） ===========

// ===========================================================
// 测试（顺序 await, 避免异步日志串台）
// ===========================================================
let passed = 0, failed = 0;
function assert(cond, msg) {
    if (cond) { passed++; console.log('  ✅', msg); }
    else      { failed++; console.error('  ❌', msg); }
}
function group(name, fn) { console.log(`\n== ${name} ==`); const r = fn(); return r && r.then ? r : Promise.resolve(); }

(async () => {
    // group() 已经返回 Promise, 这里统一 await
    const g1 = group('1. parseLLMDecision 解析/容错', () => {
        // (a) 标准 JSON
        let r = trader.parseLLMDecision(JSON.stringify({
            marketView: 'bull',
            decisions: [{ code: '600519', name: '贵州茅台', action: 'buy', lots: 1, confidence: 0.8, reason: '趋势向上', stopLoss: 1500, takeProfit: 1700, urgency: 'normal' }],
            riskNotes: 'ok'
        }));
        assert(r.decisions.length === 1, '标准 JSON 解析成功');
        assert(r.decisions[0].action === 'buy', 'action 归一为 buy');
        assert(r.decisions[0].lots === 1, 'lots 是 1');
        assert(r.decisions[0].stopLoss === 1500, 'stopLoss 保留');

        const md = '```json\n' + JSON.stringify({ decisions: [{ code: '000858', action: 'sell', lots: 2 }] }) + '\n```';
        r = trader.parseLLMDecision(md);
        assert(r.decisions.length === 1 && r.decisions[0].action === 'sell', '剥 markdown fence');

        const noisy = '好的下面是结果：\n```json\n' + JSON.stringify({ decisions: [{ code: '300750', action: 'hold', confidence: 0.3 }] }) + '\n```\n请参考';
        r = trader.parseLLMDecision(noisy);
        assert(r.decisions[0].action === 'hold', '从杂讯中抽取 JSON');

        r = trader.parseLLMDecision(JSON.stringify({ decisions: [{ code: 'X', action: 'BUY!!', lots: -3 }] }));
        assert(r.decisions[0].action === 'hold', '非法 action 降级为 hold');
        assert(r.decisions[0].lots === 0, '负数 lots 归 0');

        let threw = false;
        try { trader.parseLLMDecision('not json at all'); } catch (e) { threw = true; }
        assert(threw, '完全无法解析时抛错');

        r = trader.parseLLMDecision('{}');
        assert(Array.isArray(r.decisions) && r.decisions.length === 0, '空 decisions 数组');
    });
    await g1;

    const g2 = group('2. buildMarketContext 分多类数据', () => {
        const candidates = STOCK_POOL.map(item => {
            const q = global.getStockPrice(item.code);
            return { stock: item, quote: q, evaluation: global.evaluateAllStrategies(item.code, q), analysis: global.analyzeStock(item.code, q), score: 1 };
        });
        const ctx = trader.buildMarketContext(candidates);
        assert(ctx.account.cash === 100000, 'account.cash');
        assert(ctx.account.maxDailyTrades === 5, 'account.maxDailyTrades 取自 mode');
        assert(Array.isArray(ctx.positions), 'positions 是数组');
        assert(Array.isArray(ctx.candidates) && ctx.candidates.length === 4, 'candidates 4 只');
        assert(ctx.candidates[0].technical && 'rsi' in ctx.candidates[0].technical, 'candidates 含 technical');
        assert(ctx.candidates[0].strategy && 'action' in ctx.candidates[0].strategy, 'candidates 含 strategy');
        assert(Array.isArray(ctx.sector) && ctx.sector.length >= 1, 'sector 聚合非空');
        assert(ctx.risk.maxSinglePosition === 0.3, 'risk 字段');
    });
    await g2;

    const g3 = group('3. buildLLMPrompt 模板', () => {
        const candidates = STOCK_POOL.map(item => ({ stock: item, quote: global.getStockPrice(item.code), evaluation: global.evaluateAllStrategies(item.code, global.getStockPrice(item.code)), analysis: null, score: 0 }));
        const ctx = trader.buildMarketContext(candidates);
        const p = trader.buildLLMPrompt(ctx);
        assert(p.includes('account'),    '含 account');
        assert(p.includes('positions'),  '含 positions');
        assert(p.includes('candidates'), '含 candidates');
        assert(p.includes('sector'),     '含 sector');
        assert(p.includes('risk'),       '含 risk');
        assert(p.includes('JSON Schema'),'含 schema 约束');
        assert(p.includes('buy') && p.includes('sell') && p.includes('hold'), '含 action 枚举');
        assert(p.includes('0.30') || p.includes('30%'), '含风控百分比');
    });
    await g3;

    const g4 = group('4. End-to-End: mock LLM → aiTradingDecision → 模拟下单', async () => {
        state.cash = 500000; state.positions = {}; state.trades = []; state.dailyTrades = 0;

        const mockLLMJson = {
            marketView: '白酒板块趋势向上, 银行震荡',
            decisions: [
                { code: '600519', name: '贵州茅台', action: 'buy', lots: 1, confidence: 0.8, reason: '趋势向上+板块强势', stopLoss: 1550, takeProfit: 1700, urgency: 'normal' },
                { code: '000858', name: '五粮液',   action: 'hold', confidence: 0.4, reason: '观望', stopLoss: null, takeProfit: null, urgency: 'low' },
                { code: '300750', name: '宁德时代', action: 'sell', lots: 2, confidence: 0.7, reason: '趋势转弱', stopLoss: null, takeProfit: null, urgency: 'high' },
            ],
            riskNotes: '银行板块仓位不重, 暂不加仓'
        };
        let callCount = 0;
        global.__realFetch = async (url, opts) => {
            callCount++;
            const body = JSON.parse(opts.body);
            assert(body.model === 'mimo-v2.5-pro', '请求 model 正确');
            assert(body.messages.length === 2, '请求 messages 完整');
            assert(body.messages[1].content.includes('candidates'), 'user prompt 含 candidates');
            assert(url.endsWith('/chat/completions'), '请求路径正确');
            return {
                ok: true, status: 200,
                json: async () => ({ choices: [{ message: { content: JSON.stringify(mockLLMJson) } }], usage: { total_tokens: 1234 } }),
            };
        };
        global.fetch = global.__realFetch;

        state.positions['300750'] = { name: '宁德时代', quantity: 2, avgCost: 200, peakPrice: 220, trailingStopPct: 0.025 };

        const result = await trader.aiTradingDecision();
        assert(result.ok === true, 'aiTradingDecision 成功');
        assert(callCount === 1, '只调用 LLM 1 次');
        assert(result.decision.decisions.length === 3, 'decision.decisions 3 条');
        assert(result.results.find(r => r.code === '600519' && r.action === 'buy' && r.ok), '600519 买入成功');
        assert(result.results.find(r => r.code === '300750' && r.action === 'sell' && r.ok), '300750 卖出成功');
        assert(result.results.find(r => r.code === '000858' && r.skipped), '000858 hold 被跳过');
        assert(state.positions['600519'] && state.positions['600519'].quantity >= 1, '600519 持仓已建');
        assert(!state.positions['300750'], '300750 持仓已清');
        assert(state.trades.length >= 2, 'trades 记录了 ≥2 笔');
    });
    await g4;

    await group('5. Live call (mimo-v2.5-pro) — 真实接口', async () => {
        if (!process.env.RUN_LIVE) {
            console.log('  ⏭  跳过（设 RUN_LIVE=1 启用真实调用）');
            return;
        }
        global.fetch = globalThis.fetch;
        const ctx = trader.buildMarketContext([]);
        const prompt = trader.buildLLMPrompt(ctx);
        const raw = await trader.callLLM(prompt);
        console.log('  📥 原文(前200):', String(raw).slice(0, 200));
        const decision = trader.parseLLMDecision(raw);
        assert(typeof decision.marketView === 'string', 'marketView 存在');
        assert(Array.isArray(decision.decisions), 'decisions 是数组');
    });

    console.log(`\n========= ${passed} passed, ${failed} failed =========`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });

