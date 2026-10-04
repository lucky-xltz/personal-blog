---
title: "AgentGateway v1.6.0 深度拆解:Anthropic Messages 默认转 Responses + 内建模型目录把成本写进二进制 + MCP 分页游标 + CEL 每键限流 + Substrate 出站凭证注入"
date: 2026-10-04
category: 技术
tags: [AgentGateway, agentgateway, AI网关, LLM路由, MCP, MCP网关, A2A, Agent通信, 协议转换, Anthropic Messages, OpenAI Responses, Chat Completions, extended-thinking, Claude Code, context overflow, capability_rejected, prompt_too_long, 模型目录, 内建目录, 成本追踪, llm.cost, USD预算, 限流, localRateLimit, CEL, 每键限流, 令牌桶, 会话亲和, sessionAffinity, 优雅关闭, drain, SIGTERM, OIDC, JWT, nbf, JWKS, AuthZEN, OpenID, guardrails, failOpen, failClosed, OpenAI Moderation, Bedrock Guardrails, Luhn, Substrate, egress, 凭证注入, Gateway API, ListenerSet, AgentgatewayModel, XBackend, InferencePool, Envoy, Rust, Kubernetes, Helm, OpenTelemetry, OTLP, access log, 令牌语义, prompt cache, 网关拆解, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1635776062127-d379b0ba049b?w=600&h=400&fit=crop
excerpt: "AgentGateway v1.6.0(2026-10-02 发布,Apache-2.0,Rust 写的 Envoy 血统 AI 网关)是一个把「协议格式协商」变成默认值的版本:Anthropic Messages 请求默认改走 OpenAI Responses 转换(1.5 是 Chat Completions),代价是 extended-thinking 历史被丢弃;模型目录第一次 check 进仓库并 embed 进二进制,公共模型的美元成本不再需要单独配 catalog 就能出现在日志、trace、metrics 和 CEL 里——USD 预算和 llm.cost 表达式会在升级后突然开始扣费;standalone 的 LLM 路径从「匹配任意前缀」收紧成精确匹配,base URL 无路径时一律补 /,/provider 前缀写法全部作废。MCP 侧补上了分页游标(之前「直接扔在地上」)、mcp.methodName 与 list/* 结果进 CEL、413 请求体上限、SSE keep-alive;流量侧第一次有了 CEL 派生的每键本地限流(65536 桶 LRU,token 规则可在响应后按真实用量回填)、K8s 会话亲和、SIGTERM 优雅排空(修了 min+max 双重等待导致 65s 排空被 60s grace period SIGKILL 的 bug)。安全侧 JWT 强制校验 nbf、按 issuer+kid 选 provider、OIDC 登出端点与压缩 cookie、API key 默认存哈希、网络授权可匹配目的地址与 SNI;可观测侧 access log 按错误降级到 error、OTLP 用 agentgateway.access scope、失败请求带 error_type 标签。本文从「网关在 Agent 时代到底挡什么」讲起,拆解 5 大承重级改动 + 3 条与早间「五维责任日」同构的默认值收紧线,给出 5 段可运行配置/代码、5 套网关方案 17 维度对比、6 条 6-12 月可验证硬指标,以及 3 个长期判断:AI 网关的护城河是协议转换正确性而非性能、模型目录是新的「定价表基础设施」、CRD 去服务端默认化是 GitOps 的方向。"
---

# AgentGateway v1.6.0 深度拆解:当 AI 网关开始替你决定协议格式、替你记住价格、替你收紧默认值

## 一句话版本

一个 AI 网关在 2026 年要挡的不只是 token,它得在**五种 API 格式**之间做实时翻译、在**不知道模型价格**时也能算出账单、在**客户端不知道自己被限流**时按用户/团队/模型分别设桶、在**客户端只认识 Anthropic 协议**时替它把上下文溢出错误翻译成它能听懂的拒答码。AgentGateway v1.6.0 把这四件事全部从「需要手动配置」变成了「开箱的默认值」——代价是这一个版本一口气塞了 **5 条 breaking change**,其中两条(协议转换默认值、内建定价目录)会在升级后**静默改变你的账单和行为**,另外三条(路径精确匹配、base URL 补斜杠、Helm OIDC 开关)会让你的配置在启动时直接报错。

## 〇、v1.6.0 与早间「五维责任日」的三行对照

今天早间的 AI 日报标题是「五维责任日」:OpenAI 安全报告主笔辞职、短信成 Agent 新战场、德国主权开源模型、Palantir 排班撞上护士、Cloudflare OHTTP 双跳分离信任。表面上一个网关 release 和这些新闻没关系,但把它们并排写在一起,比单写网关更有信息量——**它们干的是同一件事:把「默认开放 + 出了事再补」翻成「默认收紧 + 显式声明」**:

| 栈层 | 早间事件 | AgentGateway v1.6.0 | 同一个设计模式 |
|---|---|---|---|
| 商业/文化层 | OpenAI 安全主笔称「试错式部署」必然周期性失败,主张核电站式层层冗余 | guardrail 默认 fail-closed:流式响应检查失败时**拒绝内容**而不是放行 | 默认值从「先放行后追责」改成「先证明再放行」 |
| 协议/信任层 | Cloudflare OHTTP 用 relay + gateway 双跳,后端收到请求却看不到用户 IP | Substrate 出站凭证注入:凭证只在**出站 CONNECT 时**注入,不在请求路径上落地 | 信任分离,「不知情」写进默认 |
| 渠道/边界层 | Apple 批准 Poke 进 Messages for Business,OS 从应用商店转向「对话即渠道」 | MCP 分页游标 + methodName 进 CEL:网关开始管理**工具的边界**而不是 HTTP 的边界 | 管控对象从「请求」变成「工具调用」 |
| 成本/治理层 | Palantir 排班致护士倦怠被定性为安全问题,AI 后果具体到单张班表 | 内建模型目录让 USD 预算**默认开始扣费**,成本从「需要单独配」变成「默认就记」 | 治理从「事后报表」变成「请求路径上的实时约束」 |
| 供应链层 | Aleph Alpha 把「每个训练决策都可交代」做成产品差异 | 模型目录 check 进仓库 + embed 进二进制 + 自动更新,价格**跟代码一起走版本控制** | 元数据与代码同源,可审计 |

**关键洞察 0:** 2026 年 10 月,「责任」这件事在五个栈层上同时从**道德论述**变成了**默认配置项**。早间新闻里的人还在争论文化是不是坏了,晚上的网关 release 已经把「不信任」写进了 YAML 默认值。

---

## 一、问题的源头:AI 网关挡在「协议巴别塔」和「会话状态」之间

要理解 v1.6.0 为什么一次性推 5 条 breaking change,得先看清 AI 网关在架构里**到底解决什么物理约束**。

### 1.1 五种 API 格式的实时翻译

2026 年,一个企业内部同时存在这些事实:

- 客户端只认 **Anthropic Messages**(`POST /v1/messages`):Claude Code、Claude Desktop、Cline、Roo Code,以及大量内部 Agent 框架的默认 provider。
- 客户端只认 **OpenAI Chat Completions**(`POST /v1/chat/completions`):LangChain 生态、OpenAI SDK、绝大部分历史代码。
- 客户端只认 **OpenAI Responses**(`POST /v1/responses`):新一代 OpenAI SDK、内置 computer-use 与 file-search 的客户端、以及大量「Agent-native」新框架。
- 后端只认 **Gemini inbound API**(`POST /v1beta/models/.../generateContent`):Google 原生。
- 后端只认 **Bedrock**(`/bedrock-runtime/.../invoke`):AWS 原生,还有 1.6 新增的 **Mantle** 端点选择。

于是网关的核心工作不是「转发」,是**在客户端格式 × 后端格式 = 25 种组合**里做有损翻译。AgentGateway 用「provider 广告自己支持哪些 format」来决定转换路径,provider 可以同时广告 Responses 和 Chat Completions。

问题来了:**当客户端发 Messages、后端两个格式都支持时,网关该默认选哪个?**

v1.5 的答案是 **Chat Completions**。v1.6 的答案是 **Responses**。这个改动只有 +71/-36、4 个文件(PR #3647,修的是 issue #3479:「Responses API 更强大也支持更多特性,两者都在时应优先 Responses」)。**改动极小,后果极大**。

**关键洞察 1:** issue #3479 的原话是「This is a trivial change, but the main work is validating this will not cause any regressions.」——整个 release 里最危险的 breaking change,代码量小到 71 行,但它的验证成本是整个 1.6 周期。**在协议转换层,「改一行默认值」的工程量不在改动里,在回归测试里。**

### 1.2 有损翻译的具体代价:extended-thinking

这不是理论上的担心。release notes 明确写了这条:

> The Responses conversion drops extended-thinking history, while the Chat Completions conversion preserves it.

Anthropic 的 extended-thinking(扩展思考)历史在转 Responses 时**被丢弃**。对一个多轮对话的 Agent,这意味着:

- 第 1 轮:客户端发 Messages,带 thinking 块。
- 网关转 Responses 发给后端,thinking 历史**没了**。
- 第 2 轮:后端看到的上下文里缺少了上一轮的推理链,可能重复推理、可能改变结论、可能 token 消耗翻倍。

所以 release notes 给的迁移建议是**反过来用 custom provider**:

> Advertise only Chat Completions if the server does not implement `/v1/responses` or clients require extended-thinking history.

并且给了一个临时逃生舱:`AGENTGATEWAY_MESSAGES_PREFER_COMPLETIONS=true`,**「计划在 1.7 移除」**。这是一个教科书式的「默认值翻转 + 有限期逃生舱」迁移模式:新默认值立即生效,老用户有一个版本的时间迁移,逃生舱下个版本消失。

### 1.3 会话状态:网关从「无状态转发」变成「有状态中介」

传统反向代理的美德是**无状态**:一个请求进来,转出去,忘掉。AI 网关做不到,因为:

- **限流按 token 算**:请求阶段不知道输出多少 token,必须**在响应回来后回填真实 usage**。
- **成本按模型算**:不同模型价格不同,必须**在解析完请求后才知道用哪个模型**。
- **会话要粘连**:多轮对话要落到同一个后端,否则 KV cache 全失效。
- **流式要保活**:SSE 流可能空几分钟,中间设备会掐断。

v1.6.0 这四个状态需求各对应一个新特性:**每键本地限流的 token 规则响应后回填**、**内建模型目录的 per-model 定价**、**K8s 会话亲和**、**MCP SSE keep-alive**。网关正在从「转发层」变成「Agent 会话的状态中介」。

---

## 二、五层架构:一个 AI 请求在 v1.6 里走过的路径

```
┌─────────────────────────────────────────────────────────────────────┐
│  客户端 (Claude Code / OpenAI SDK / LangChain / MCP client / A2A)      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ Anthropic Messages / Responses / Completions / MCP JSON-RPC
┌──────────────────────────────▼──────────────────────────────────────┐
│ Layer 1  认证与身份                                                   │
│   JWT(issuer+kid 选 provider · nbf 强制 · 60s skew)                   │
│   OIDC(登录/登出端点 · 压缩 cookie · fetch 返 401 不重定向)            │
│   API key(默认存哈希 · 预算需 database 否则 UI 告警)                  │
└──────────────────────────────┬──────────────────────────────────────┘
┌──────────────────────────────▼──────────────────────────────────────┐
│ Layer 2  路由与格式协商                                               │
│   精确路径匹配(/v1/messages,可配 llm.pathPrefix)                     │
│   provider 广告 format → 决定转换路径(Messages→Responses 默认)        │
│   AgentgatewayModel(CRD 默认开)· 通配符模型展开(/v1/models)          │
│   虚拟模型:跳过坏目标 + PartiallyValid 部分降级                       │
└──────────────────────────────┬──────────────────────────────────────┘
┌──────────────────────────────▼──────────────────────────────────────┐
│ Layer 3  策略平面(CEL 表达式)                                         │
│   限流:requests / tokens 规则 · CEL key 派生每键桶(65536 LRU)         │
│   预算:llm.cost + USD 预算(内建目录提供默认价格)                     │
│   授权:destination.address / port / SNI · mcp.methodName · requiredClaims │
│   guardrail:OpenAI Moderation / Bedrock Guardrails / Model Armor      │
│              failureMode failOpen|failClosed(流式默认拒内容)          │
└──────────────────────────────┬──────────────────────────────────────┘
┌──────────────────────────────▼──────────────────────────────────────┐
│ Layer 4  协议转换与错误翻译                                            │
│   Messages↔Responses↔Completions(citations/refusals/strict schema/    │
│     reasoning effort/images in tool results/stop sequences/ITL)       │
│   上下文溢出 → capability_rejected: prompt_too_long(Claude Code 自动  │
│     compact + retry)                                                 │
│   后端凭证错误 → 502(不是 500);本地凭证错误 → 500(不是 503)        │
└──────────────────────────────┬──────────────────────────────────────┘
┌──────────────────────────────▼──────────────────────────────────────┐
│ Layer 5  连接池与上游                                                  │
│   HTTP/2 PING keepalive · max connection duration + jitter            │
│   response idle timeout(流空闲即断,不限总时长)                       │
│   failover 默认开启 eviction(不定义 health policy 就自动剔除坏目标)  │
│   Substrate egress:CONNECT 时注入凭证 · 出站 cert rotation            │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                        后端 (OpenAI / Azure / Bedrock / Mantle /
                             Vertex / Gemini / Ollama / vLLM / MCP Server)
```

这五层里,v1.6.0 **每一层都至少翻了一个默认值**。这就是这个 release 的骨架:不是「加了一堆功能」,是「把每一层的默契都重新定义了一遍」。

---

## 三、5 大承重级革新

### 3.1 协议转换默认值翻转:Messages → Responses,以及 extended-thinking 的代价

**承重级判定**:✅ 改默认行为(核心转换路径)+ ✅ 解决历史难题(Responses 支持更多特性)+ ✅ 引入新接口(`AGENTGATEWAY_MESSAGES_PREFER_COMPLETIONS` 逃生舱)。命中 3 项。

这条改动的全部代码是 PR #3647,+71/-36。它把客户端发 Anthropic Messages、后端同时支持两种格式时的转换目标从 Chat Completions 改成 Responses。受影响范围 release notes 列得清清楚楚:**OpenAI、Ollama、Groq、Hugging Face、xAI provider;除 Claude 外的 Azure 模型;以及广告了两种格式的 custom provider**。

为什么这事值得单独占一个承重级位置?因为它暴露了 AI 网关最容易被低估的复杂性:**格式转换不是「字段映射」,是「语义降级」**。同一个对话,走不同的转换路径,会得到**不同的推理上下文**。v1.6 同时修了一打转换正确性 bug,每一条都是一个「翻译失真」的实例:

| PR | 修的转换失真 | 影响 |
|---|---|---|
| #3515 | Messages→Responses 补上 citations(引用) | 引用类回答之前会丢 |
| #3510 | 修重复发送 refusal(拒答) | 客户端看到两次拒答 |
| #3509 | 正确转换 strict tool schema 字段 | 严格模式工具调用失效 |
| #3498 | 保留 tool result 里的 images | 多模态工具结果丢图 |
| #3363 | thinking 块在 Messages↔Completions 间保留 | extended-thinking 不再丢 |
| #3581 | 上下文溢出翻译成 `capability_rejected: prompt_too_long` | Claude Code 能 compact + retry |
| #3517 | 记录 ITL(inter-token latency) | 首 token 延迟可观测 |
| #3455 | 最后一个 stream chunk 没有 delta 时保留 usage | token 计数不丢 |
| #3735 | regex guardrail 匹配不贪婪越过实际匹配 | 误拦减少 |

**关键洞察 2:** 这九条修复合起来说明一件事:**AI 网关的护城河不是性能,是协议转换的正确性**。一个转错 refusal 的网关,会让客户端以为模型拒绝了;一个丢掉 thinking 历史的网关,会让 Agent 每轮重新推理。这些 bug 不影响 QPS,但每一都能让用户的 Agent「行为变蠢而找不到原因」。

其中最值得单独讲的是 **#3581**(iandvt,+238/-1,3 个文件),因为它解决的是一个**真实的、会让 Agent 永久卡住**的问题。作者给了完整的复现环境:客户端 Claude Code `2.1.268` / 模型 `gpt-6-astra[1m]` / 路径「真实 Claude Code → 本地网关 → GitHub Copilot」,注入一个 HTTP 400 上下文溢出错误。修复前 Claude Code 拿到 Copilot 的 context overflow 错误**直接卡死**;修复后网关把它翻译成 Claude Code 认识的 `capability_rejected: prompt_too_long`——这是 Claude 的 [LLM Gateway Protocol](https://code.claude.com/docs/en/llm-gateway-protocol#automatic-retry-and-error-forwarding) 里定义的拒答码,Claude Code 会**自动 compact 上下文并重试**。作者实测「Recovery: Real model-generated summary and reply after compaction and retry」。

注意作者的诚实:PR 描述里明确标注「the description, docs, and comments (words meant for humans) are written by a human, not by an LLM」——这是 agentgateway 的 Code of Conduct 强制要求,**所有给人看的文字必须人写**。在一个 AI 生成的 PR 泛滥的时代,这个仓库把「人写人类文字」写进了行为准则。

**给你的迁移建议**:

```yaml
# 如果你需要 extended-thinking 历史被保留,不要用 OpenAI provider 指向非 OpenAI 的服务
# 用 custom provider,只广告 Chat Completions:
providers:
  - name: my-openai-compatible
    baseURL: http://localhost:8080/v1     # v1.6:无路径一律补 /,所以要显式带 /v1
    formats:
      - chatCompletions                   # 只广告这一个 → Messages→Completions,thinking 保留
```

如果升级后需要临时回退,设 `AGENTGATEWAY_MESSAGES_PREFER_COMPLETIONS=true`,但**在 1.7 会被移除**。

---

### 3.2 内建模型目录:价格第一次进二进制

**承重级判定**:✅ 改默认行为(没配 catalog 的模型现在突然有成本)+ ✅ 引入新接口(`rates.perPage` 按页计费)+ ✅ 推动生态跟进(成本追踪零配置化)。命中 3 项。

PR #3191(howardjohn,+5081/-75,15 个文件)做了三件事:

1. **把模型目录 check 进仓库**——价格数据进入版本控制,可审计、可 diff、可 review。
2. **embed 进二进制**——网关启动时就有价格,不需要先去拉一个远程 catalog。
3. **自动化更新**——机器人定期提 PR 更新价格(release notes 里能看到大量「Update model catalog by @github-actions[bot]」)。

为什么这是承重级?因为它**把成本追踪从「需要配置的功能」变成了「默认存在的属性」**。release notes 的措辞值得逐字读:

> Requests to common public models now have a cost in logs, traces, metrics, and CEL **without a separately configured catalog**. As a result, USD API-key budgets in standalone and cost-based policies or CEL expressions in either deployment mode **can begin applying to these models after the upgrade**.

**这是一条 breaking change,而且是最安静的那一种:它不报错,它只是开始扣钱。** 升级前你的 `llm.cost` CEL 表达式因为没价格数据而恒等于 0,升级后突然有了真实值。任何依赖「没配 catalog 就没有成本」的预算策略,会在升级当天开始真实生效。

**关键洞察 3:** 模型目录是 AI 网关的「**定价表基础设施**」。传统 API 网关不管后端多少钱,因为计费是后端的事;AI 网关必须在**网关层**知道价格,否则 USD 预算、成本告警、按团队核算全部无法在请求路径上执行。把价格 embed 进二进制 + check 进仓库,等于把「定价表」当成了**代码资产**而不是**配置数据**——这和早间 Aleph Alpha 把「每个训练决策都可交代」做成产品差异是同一个路数:**元数据与代码同源,才可审计**。

1.6 还给目录加了两个能力:

- **`rates.perPage`**:OCR 与文档模型按页计费,不是按 token。这是第一次承认「非 token 计费模型」是一等公民。
- **通配符展开**:`/v1/models` 会把通配符配置展开成目录里实际匹配的 model ID 列表(PR #3649,修 issue #3602)。standalone 用户可以设 `llm.discovery: disabled` 保留旧行为(返回通配符模式本身)。

---

### 3.3 路径与 base URL 的「精确化」三连:standalone 向 K8s 看齐

**承重级判定**:✅ 改默认行为(三条 breaking change)+ ✅ 解决历史难题(前缀匹配的歧义)。命中 2 项,但三条 breaking change 同框,承重级位置实至名归。

这三条是升级时**最容易直接报错**的,一起看:

**(a) 精确路径匹配(PR #3539,howardjohn,+597/-665,15 文件)**

standalone 以前用 `/*/v1/messages` 这种「任意前缀」匹配,现在只认精确的 `/v1/messages`。要保留前缀,得显式配 `llm.pathPrefix: /tenant-a`,**且不支持多前缀**。

作者在 PR 里点出一个**副作用收益**:trace 的 span 名从 `POST /*` 变成 `POST /v1/messages`——**收紧匹配同时修了可观测性**。一个 span 名叫 `POST /*` 的 trace 基本没法用来排障。

**(b) base URL 无路径时一律补 `/`**

`https://api.openai.com` 现在真的就是 `/`(根),不是 `/v1`。1.5 的规则是:custom/Ollama provider 补 `/v1`,OpenAI 这种内建 provider 转发客户端原始路径。v1.6 统一成「base URL 就是完整 base path」。

```text
# 必须改的配置
https://api.openai.com      →  https://api.openai.com/v1
http://localhost:11434      →  http://localhost:11434/v1
# 不受影响
https://api.openai.com/v1   (已有路径)
provider 用默认地址          (不填 baseURL)
```

**(c) standalone Helm 要求 `oidc.enabled`**

standalone chart 只在 `oidc.enabled=true` 时才设 `OIDC_COOKIE_SECRET`,默认 `false`。如果你用 `oidc.cookieSecretName` 保护 UI,升级前必须先开 `oidc.enabled`,**否则启动时直接拒绝 OIDC 配置**。

**关键洞察 4:** 三条改动方向完全一致:**消除「写一半也能工作」的模糊性**。前缀匹配、base URL 自动补路径、Helm 隐式塞 cookie secret——都是「我帮你猜」的默认值,现在全部要求你写全。这是 2026 年基础设施的普遍转向:模糊的便利性正在被**可预测的显式声明**取代。Caddy v2.11.6 同一周把 `allow_*` 黑名单换成 `expected_*` 白名单,苹果同一周要求 macOS Full Disk Access 必须「very explicit user action」——**三个不同栈层,同一个方向**。

---

### 3.4 MCP 兼容性补全:从「能转发」到「协议合规」

**承重级判定**:✅ 引入新协议接口(分页游标 + CEL 方法名)+ ✅ 解决历史难题(游标之前被丢弃)+ ✅ 推动生态跟进(MCP 网关化)。命中 3 项。

v1.6 之前 agentgateway 的 MCP 实现是「能用但漏协议细节」。v1.6 一次性补了五个:

**(a) 分页游标(PR #3544,howardjohn,+185/-12)**

release notes 里有一句极诚实的话,我直接引:

> Today we just drop cursors on the floor. Now we encode the upstream cursors into our own opaque cursor, same logic as we do for sessions.

**「我们之前直接把游标扔在地上」**——这是一个把上游 cursor 编码成网关自己的 opaque cursor 的实现,逻辑复用了 session 的编码。对**联邦多目标**场景,返回的是「combined cursor」,跟踪所有目标各自的进度。这是 MCP 网关化的关键:**联邦的游标不能是任何一个后端的游标,必须是网关合成的**。

**(b) MCP 数据进 CEL**

策略现在能匹配 `mcp.methodName`(如 `tools/call`),access log 能记录 `mcp.toolsList` 这样的 list 结果(PR #3601,#3197)。这意味着**工具调用第一次成为策略语言里的一等公民**:

```yaml
# 只允许特定用户调用特定工具
-CEL: 'mcp.methodName == "tools/call" && request.auth.claims["sub"] != "trusted-agent"'
  action: Deny
```

**(c) 413 请求体上限(PR #3593,DEOWL-kan)**

MCP 请求超过配置的 buffer limit 现在返回 `413`,而不是静默截断或 OOM。

**(d) SSE keep-alive(PR #3393,TechPrototyper,首次贡献)**

standalone 可以在长生命周期 MCP 流上周期性发注释,防止中间设备掐断空闲连接。

**(e) serverInfo 覆盖(PR #3425,alexoakland)**

多路复用网关可以覆盖报告的 `serverInfo` 和 instructions——对「一个网关后面挂 N 个 MCP server,客户端看到的却是同一个 server」的联邦场景必需。

**关键洞察 5:** MCP 网关的成熟度,看的不是「能不能连上」,而是**协议的边角料处理得有多细**。游标、方法名、413、keep-alive、serverInfo——这五件事单看都不大,合起来决定了联邦 MCP 网关能不能用在生产。早间 Apple 批准 Poke 进 Messages for Business,OS 从应用商店转向「对话即渠道」;agentgateway 这五个 MCP 补丁,是同一趋势在基础设施侧的镜像:**管控对象正在从 HTTP 请求变成工具调用**。

---

### 3.5 每键本地限流 + 会话亲和 + 优雅排空:网关补齐「有状态」三件套

**承重级判定**:✅ 引入新接口(CEL key + sessionAffinity + drain)+ ✅ 性能/正确性提升(65s 排空 bug)+ ✅ 解决历史难题(无外部组件做租户级配额)。命中 3 项。

**(a) CEL 派生的每键本地限流(PR #3351,ehfd,+1046/-112,22 文件,修 issue #1909)**

这是 v1.6 最大的新特性之一。`localRateLimit` 规则现在带一个可选 CEL `key`,**每个不同的 key 值拿到自己的令牌桶**:

```yaml
llm:
  policies:
    localRateLimit:
    - type: requests
      maxTokens: 60
      tokensPerFill: 60
      fillInterval: 60s
      key: jwt.sub                          # 每用户一个桶
    - type: tokens
      maxTokens: 100000
      tokensPerFill: 100000
      fillInterval: 1h
      key: jwt.team                          # 每团队一个桶
    - type: tokens
      maxTokens: 20000
      tokensPerFill: 20000
      fillInterval: 1h
      key: jwt.sub + "/" + llm.requestModel  # 每用户×每模型一个桶
```

设计上有三个细节值得拆开看:

1. **同一路由的所有规则都必须放行**(AND 语义),不是任一命中。
2. **桶缓存有上界**:每规则 65536 个桶,**淘汰最少使用的**。作者明确说「caller 选的 key(比如请求头)不能无限撑大它」,并类比「被淘汰的 key 和从没见过一样,这就是 nginx `limit_req` zone 满了时的行为」。
3. **token 规则在响应后回填真实 usage**。`requests` 规则在请求路径检查,`tokens` 规则在 LLM 请求解析完之后才能评估——所以 token 限制**也能按请求模型 key**,而实际输入输出用量在响应回来后**回填到同一个桶**。这是「会话状态」那节讲的状态需求的直接实现。

**(b) K8s 会话亲和(PR #3268,howardjohn,+773/-506,修 issue #2572)**

CEL 表达式派生一个 session 值,相关请求**一致地送到同一个 endpoint**。对长上下文 Agent 这是性能特性:粘住后端,provider 侧的 prompt cache 才命中。

**(c) 优雅排空(PR #3334,jlaneve,+306/-78,作者自述「I'm no Rust (nor agent gateway) expert」)**

这个 PR 修了一个**教科书级的并发 bug**,值得完整读作者的描述:

> On SIGTERM the gateway force-closes every open connection about 2 ms later with the default settings, so a request in flight ends as a bare EOF with no status code.

作者抓到了根因:`run_bind` 的 accept loop 创建了一个内部 drain channel,**下一行就把它唯一的 watcher drop 掉了**,所以那个本该等待所有连接关闭的 join,在 minimum deadline 一到就返回了——随后触发 force shutdown。**「wrapper 自己的 deadline arm 根本没机会跑」**。

修完第一个 bug 露出第二个:`run_with_drain` 先睡 minimum 再等**完整** maximum,所以窗口是 `min + max`。而 maximum 是**从 K8s grace period 减 5 秒推出来的、本意是总时长**。Helm 默认 min 10s + grace 60s,排空会跑 65s——**然后 pod 被 SIGKILL**。新版在排空开始时算一个绝对截止时间,sleep 和 timeout 都对着它算;minimum 大于 maximum 就 clamp 到 maximum。

**「a refused connection can be retried, a request cut mid-flight cannot.」**——这句话应该贴在每一个写 drain 逻辑的工位上。

**关键洞察 6:** 三个特性合起来是网关「有状态化」的三件套:**按 key 分桶(限流)+ 按会话粘连(路由)+ 排空时不杀在途请求(生命周期)**。AI 网关正在补齐传统反向代理十年前就有的东西,但必须重新实现一遍,因为限流单位从 QPS 变成了 token,粘连目标从 session cookie 变成了上下文,排空对象从 HTTP 请求变成了可能跑几分钟的流式推理。

---

## 四、Substrate 出站凭证注入:早间 OHTTP 信任分离的网关版

这一条值得单开一节,因为它和早间的 Cloudflare OHTTP Gateway 是**同一个信任模型的两种实现**。

**Substrate egress credential injection(PR #3411,keithmattix,+2172/-13)**:凭证**只在出站 CONNECT 时注入**,不在请求路径上落地。配套的还有 #3689(EItanya,+1735/-331)实现 Substrate policy 的完整协议选择,#3686 修长生命周期隧道上的出站证书轮换。

对比早间的 OHTTP:relay + gateway 双跳,后端收到请求但看不到用户 IP;agentgateway 的版本是:后端永远不接触调用方凭证,网关在**建立出站连接的那一刻**才把凭证注入进去。

但这里有一个**诚实的边界**必须说明:PR #3689 的作者自己标注了「AI assistance: implementation, documentation, and tests」,并且 Code of Conduct 要求的「人写人类文字」那个 checkbox 是**未勾选的 `[ ]`**。而 #3411 和 #3581 都勾了 `[x]`。这个仓库对「哪些文字是人写的」要求很严,但**这个 checkbox 的存在本身就说明:在 AI 网关这个领域,连代码的「作者性」都成了一个需要显式声明的字段**。

配套的 Agent Substrate 集成还有几条:#3237(CONNECT 时授权 actor egress)、#3333(emit `ate.actor.uid` 和 `ate.router.route.duration`)、#3289(emit `ate.router.resume` 让冷启动可见)。**`ate.router.resume` 这个信号特别值得注意**:它让「冷启动」从一个模糊现象变成了 trace 里可查询的事件。

---

## 五、5 段可运行代码

### 5.1 standalone 最小配置(v1.6 精确路径 + 显式 base URL)

```yaml
# agw.yaml —— 注意 v1.6 的三条 breaking change 全部体现在这里
provider:
  name: openai
  baseURL: https://api.openai.com/v1     # breaking:无路径会当 / 用,必须带 /v1
  formats: [responses, chatCompletions]  # 显式广告格式

llm:
  pathPrefix: /tenant-a                  # 可选:需要前缀时显式声明,不支持多前缀
  policies:
    localRateLimit:
    - type: tokens
      maxTokens: 20000
      tokensPerFill: 20000
      fillInterval: 1h
      key: jwt.sub + "/" + llm.requestModel
```

启动:

```bash
docker run -p 8080:8080 -v ./agw.yaml:/config.yaml \
  cr.agentgateway.dev/agentgateway:v1.6.0
```

验证 v1.6 的精确路径行为(这两条会命中同一条路由):

```bash
curl http://localhost:8080/v1/chat/completions ...        # ✅ 精确匹配
curl http://localhost:8080/tenant-a/v1/chat/completions ...  # ✅ 配了 pathPrefix 才命中
curl http://localhost:8080/foo/v1/chat/completions ...    # ❌ v1.5 会匹配,v1.6 直接透传不转换
```

### 5.2 K8s AgentgatewayModel + 每键限流 + 会话亲和

```yaml
apiVersion: gateway.agentgateway.io/v1alpha1
kind: AgentgatewayModel                          # v1.6: Helm agentgatewayModels.enabled 默认 true
metadata:
  name: default-llm
spec:
  models:
  - name: gpt-6
    backendRef:
      name: openai-backend
---
apiVersion: gateway.agentgateway.io/v1alpha1
kind: AgentgatewayPolicy
metadata:
  name: tenant-quotas
spec:
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: llm-route
  traffic:
    rateLimit:
      local:
      - type: requests
        maxTokens: 60
        tokensPerFill: 60
        fillInterval: 60s
        key: jwt.sub                             # 每用户独立桶
      - type: tokens
        maxTokens: 100000
        tokensPerFill: 100000
        fillInterval: 1h
        key: jwt.team                            # 每团队独立桶
    sessionAffinity:                             # v1.6 新增
      session:                                   # CEL 表达式派生会话键
        expression: jwt.sub                      # 同用户的请求一致送到同一 endpoint
```

### 5.3 guardrail 的 failOpen / failClosed 取舍

```yaml
llm:
  policies:
    guardrail:
    - name: moderation
      type: openaimoderation
      failureMode: failClosed                    # 默认:检查失败就拒绝内容
      # failureMode: failOpen                    # 保留 1.5 行为:放行
```

**v1.6 的默认值翻转**:provider guard 在检查**流式响应或 realtime 连接**时失败,现在**拒绝内容**。要保留旧行为必须显式 `failOpen`。

同时注意 `guardrails` 这个 CEL 变量现在**包含每一个跑过的 guard,包括新加的 `allow` action**。旧表达式如果统计「干预次数」会多算,需要改成:

```yaml
-CEL: 'guardrails.exists(g, g.action != "allow")'   # 只看真正干预的
```

### 5.4 MCP 联邦游标 + methodName 策略

```yaml
# 一个网关后面挂两个 MCP server,客户端看到联邦视图
mcp:
  server:
    serverInfo:                                  # v1.6 新增:覆盖报告的 serverInfo
      name: federated-tools
      version: "1.0"
    instructions: "联邦工具集,跨 payments 与 search 两个后端"

backend:
  - name: payments-mcp
    mcp:
      target: http://payments:3000/sse
  - name: search-mcp
    mcp:
      target: http://search:3000/sse
---
# 策略:只允许 trusted-agent 调用 payments 工具
-CEL: >
    mcp.methodName == "tools/call"
    && target.tool.name.startsWith("payments")
    && request.auth.claims["sub"] != "trusted-agent"
  action: Deny
```

客户端侧看到的游标是网关合成的 opaque cursor,翻页时网关内部再拆给两个后端各自续页。

### 5.5 用 CEL 做「内建目录价格」的预算告警

```yaml
# v1.6 后,公共模型不再需要单独配 catalog 就有 llm.cost
llm:
  policies:
  - CEL: 'llm.cost > 5.0'                        # 单请求超过 5 美元就拦
    action: Deny
  - CEL: 'llm.totalTokens > 1000000'             # 单请求超过 100 万 token 拦
    action: Deny
---
# USD 预算:standalone 注意「预算需要 database」——UI 会告警
apiKeys:
- name: team-a
  budget:
    usd: 1000                                    # v1.6 后对公共模型默认开始扣费
  # budget 需要配 database(UI 会 warn when API key budgets lack database)
```

**升级当天的自查清单**:

```bash
# 1. 找出所有依赖 llm.cost 的 CEL 表达式
kubectl get agentgatewaypolicy -A -o yaml | grep -c 'llm.cost'
# 2. 找出所有 USD 预算
kubectl get agentgatewaypolicy -A -o yaml | grep -i 'usd'
# 3. 确认 standalone 的 OIDC 开关
helm get values agentgateway | grep oidc
```

---

## 六、5 套 AI 网关方案 17 维度对比

| 维度 | agentgateway v1.6 | Envoy AI Gateway v1(GA) | LiteLLM v1.x | Kong AI Gateway | APISIX AI Gateway |
|---|---|---|---|---|---|
| 实现语言 | Rust(Envoy 血统) | Go(Envoy 扩展) | Python | Lua + Go | Lua + Rust |
| 部署形态 | K8s controller + standalone | K8s controller | 进程 / K8s | K8s / VM | K8s / VM |
| 标准 CRD | ✅ Gateway API + ListenerSet + XBackend | ✅ Gateway API | ❌ 自有 | ✅ Gateway API | ✅ Gateway API |
| Anthropic Messages 入站 | ✅(1.6 默认转 Responses) | ✅ | ✅ | ✅ | ✅ |
| Messages↔Responses 转换深度 | ✅✅ citations/refusals/strict/thinking/images/ITL/overflow 翻译 | ✅ | ✅ | ✅ | ✅ |
| MCP 联邦(游标/serverInfo/413) | ✅✅ 1.6 补齐 | ❌ | 部分 | ❌ | ❌ |
| 每键本地限流 | ✅ CEL key,65536 桶 LRU,token 回填 | ✅ | ✅ | ✅ | ✅ |
| 内建模型目录(价格进二进制) | ✅ 1.6 新增 | ❌ | ✅(config) | 部分 | ❌ |
| USD 预算 | ✅(需 database) | ❌ | ✅ | ✅ | ❌ |
| guardrail failOpen/failClosed | ✅ 所有类型 + 流式默认拒 | 部分 | ✅ | ✅ | 部分 |
| 会话亲和 | ✅ 1.6 新增(CEL) | ✅ | 部分 | ✅ | ✅ |
| 优雅排空(不杀在途流) | ✅ 1.6 修复(65s bug) | ✅ | ❌ | ✅ | ✅ |
| 后量子 / FIPS | ✅ AWS-LC-FIPS 可选 backend | 部分 | ❌ | 部分 | ❌ |
| OTel GenAI 语义 | ✅ agentgateway.access scope + error_type | ✅ | ✅ | ✅ | 部分 |
| 流式响应 idle timeout | ✅ 1.6 新增 | 部分 | ❌ | ✅ | 部分 |
| 多租户路径前缀 | ✅ llm.pathPrefix(单前缀) | ✅ | ❌ | ✅ | ✅ |
| License | Apache-2.0 | Apache-2.0 | MIT | Apache-2.0 | Apache-2.0 |

**读表要点**:agentgateway v1.6 拉开差距的是两个格子——**MCP 联邦的协议完整度**和**价格目录进二进制**。其他网关都在做 LLM 路由和限流,但把 MCP 的游标合成、413、serverInfo 覆盖、SSE keep-alive 一口气补齐的,只有它;把模型价格 check 进仓库 + embed 进二进制的,也只有它。

---

## 七、性能与正确性:这一个版本真正改的数字

v1.6.0 的 release notes 里**没有 benchmark 表**——这是一个明确的选择,因为这一版的改动几乎全在**正确性和语义**上。能提取出的性能相关改动:

| 改动 | 位置 | 影响 |
|---|---|---|
| LLM 请求缓冲 2 MiB → 32 MiB | PR #3408 | 长上下文提示不再被缓冲上限截断 |
| guardrail 流式 memcpy 优化 | PR #3558,+7/-4 | 「之前每次迭代都拷贝整个 pending window,大量小帧意味着同一段的重复拷贝;现在拷一次,然后在块内逐帧烧掉」 |
| 日志序列化卸载到日志线程 | PR #3470,+31/-15 | 请求路径不再阻塞在序列化上 |
| CEL 语法检查缓存 | PR #3561 | 同一表达式不重复编译 |
| LLM completion 不 clone | PR #3468 | 省一次大结构深拷贝 |
| 复用缓存的 JSON parse | PR #3466 | 新 body 表示带来的附带收益 |
| controller TLS 校验结果缓存 | PR #3458 | 控制面热路径 |
| listener 排序短路 | PR #3627 | 监听器数量大时 |
| xDS 存储缩容 | PR #3642 | 资源消失后释放 |
| 二进制 -trimpath | PR #3554 | 构建可复现 |

**关键洞察 7:** 这些性能 PR **没有一条带 benchmark 数字**。在一个 AI 网关里,「把整个 pending window 的拷贝从每帧一次降到每块一次」这种优化的收益取决于帧的大小分布,作者只描述了机制没给数字——这是诚实的做法。**真正决定一个 AI 网关性能的,早已不是网关自己的拷贝次数,而是后端 provider 的首 token 延迟和上下文缓存命中率**。网关层的优化正在从「压榨 CPU」转向「别帮倒忙」:32 MiB 缓冲让长上下文不再被截断,流式 idle timeout 让卡住的响应被释放,会话亲和让 provider 侧 prompt cache 真正命中。

### 7.1 正确性修复:三条值得记住的

| PR | bug | 为什么重要 |
|---|---|---|
| #3334 | SIGTERM 后 ~2ms 强关所有连接,在途请求裸 EOF | drain 窗口算成 min+max(10s+55s=65s)超过 60s grace period,pod 被 SIGKILL |
| #3462 | 配了 failover 但实际不会 failover | 「用户能设 failover,但根本 failover 不了」——issue #2979;1.6 默认开启 eviction |
| #3520 | CRD 服务端默认值把用户 2 行 YAML 膨胀成 15 行 | 「所有可选字段概念上都有默认值;把它们物化到用户的 spec(他们的意图)里是错的,而且我们也没一致地这么做」 |

**#3520 的设计争论值得单独看**:作者自己写「Might be controversial」。服务端默认值是 Kubernetes 的标准实践(kubebuilder:default),但 agentgateway 选择**停止服务端默认化**,改为 controller 运行时应用同样的默认值。代价是 `kubectl get -o yaml` 只显示显式配置的字段;收益是**用户的 spec 表达的是用户的意图,而不是被服务器填充后的膨胀版本**。GitOps diff 会变得干净。作者甚至加了 lint 禁止再用默认值标注。

---

## 八、6 条 6-12 月可验证硬指标

每一条今天就能对照检查,不需要等待未来。

**1. `AGENTGATEWAY_MESSAGES_PREFER_COMPLETIONS` 在 1.7 被移除**
验证方式:升级到 1.7.0 时 grep 配置和 Helm values 里是否还有这个环境变量。如果 1.7 release notes 的「Removed」段落出现它,说明「默认值翻转 + 有限期逃生舱」迁移模式按预期完成;如果还在,说明回归问题比预期大。

**2. 内建模型目录的更新频率**
验证方式:`git log --since="1 month ago" --oneline -- '**/catalog*' | grep -c 'github-actions'`。release notes 里 1.6 周期就有 ~15 条「Update model catalog by @github-actions[bot]」。如果这个频率在 6 个月内掉到个位数,说明自动化管线退化或价格源不稳定。

**3. 你是否有 USD 预算在升级当天静默开始扣费**
验证方式:对比升级前后 24 小时的 `llm.cost` 聚合值。升级前为 0 或 null、升级后有值 = 中了 #3191 的 breaking change。**这是唯一一条不会让配置报错、只会让账单变化的 breaking change。**

**4. 流式 guardrail 默认 fail-closed 的拦截率**
验证方式:对比升级前后 access log 里 guardrail 相关的 `error` 级记录数。如果升级后 guardrail 干预记录上升而你的业务没有变化,说明之前有些本该被拦的内容被 failOpen 放行了。

**5. SIGTERM 排空时间是否符合预期**
验证方式:在 Helm 默认配置(min 10s / grace 60s)下发 SIGTERM,观察 Pod 从 SIGTERM 到终止的时长。1.5 行为是 ~65s 然后被 SIGKILL(在途请求裸 EOF);1.6 应在 60s 内完成且在途请求拿到状态码。检查启动时打印的 config 里的 effective drain 值。

**6. `mcp.methodName` 在策略里的采用率**
验证方式:`kubectl get agentgatewaypolicy -A -o yaml | grep -c 'mcp.methodName'`。这是 MCP 调用第一次能被策略语言匹配。6 个月后如果你的策略里出现了它,说明工具调用级管控成了默认实践;如果还是只有 HTTP 级策略,说明 MCP 网关化还停在「能连上」的阶段。

---

## 九、6 个 6-12 月可观察未来信号

**1. 协议转换的「语义降级表」会不会被标准化**
现在「Messages→Responses 丢 extended-thinking」是散落在 release notes 里的一句话。6-12 月内会不会出现一个社区维护的**格式转换损失矩阵**(哪个字段在哪个转换路径上丢),值得盯。这是 AI 网关领域唯一真正有技术含量的差异化。

**2. 模型目录会不会变成独立项目**
价格 check 进仓库 + embed 进二进制 + 自动更新,这套机制天然适合做成一个独立的「AI 定价表」上游项目(类似 LiteLLM 的 model cost 配置,但工程化)。如果 agentgateway 把它抽成独立 repo,说明「定价表基础设施」被确认是一个品类。

**3. CRD 去服务端默认化会不会被其他项目跟进**
#3520 是一个反 Kubernetes 主流实践的选择。如果 6-12 月内其他 Gateway API 实现或 Operator 也开始去掉 kubebuilder:default,说明「spec 应该表达意图」这个理念在扩散。

**4. Substrate / Agent Substrate 协议会走多远**
1.6 里 Substrate 相关的 PR 有 6 个(egress 凭证注入、协议选择、actor uid、router.resume、cert rotation、egress 授权)。这是一个**比 MCP 更下层的「Agent 运行时标准」**。观察 agent-substrate/substrate 的 PR #1751 类里程碑会不会被更多 runtime 采纳。

**5. 「人写人类文字」的 Code of Conduct checkbox 会不会扩散**
agentgateway 强制 PR 描述、文档、注释必须人写,并要求作者勾选声明。在 AI 生成 PR 泛滥的 2026 年,这是一个可复制的治理模式。观察其他基础设施项目会不会跟进。

**6. 5 条 breaking change 一次性推的节奏会不会延续**
1.6 一个版本推 5 条 breaking change,其中 3 条会让配置启动报错。这是一个「**用破坏性变更换取正确性**」的明确选择。观察 1.7/1.8 是继续这个节奏,还是回到平滑迁移。Rust 6 周版本节奏 vs agentgateway 的节奏对比会很有意思。

---

## 十、最佳实践与 5 步生产升级 checklist

### ✅ 该用

1. **用 custom provider 只广告一种格式**,把「转换路径」变成显式声明而不是让网关替你选。需要 extended-thinking 历史就只广告 chatCompletions。
2. **把模型价格当代码资产**:catalog check 进仓库已经帮你做了,review 时把 catalog diff 当成定价变更来审。
3. **每键限流的 key 选「不可被调用方控制」的值**:作者明确警告「caller 选的 key(比如请求头)不能无限撑大桶缓存」——用 `jwt.sub` 而不是 `request.header["x-user"]`。
4. **升级时先跑配置 dry-run 再切流量**:三条 breaking change(pathPrefix 精确匹配 / base URL 补斜杠 / oidc.enabled)会在启动时直接拒绝配置,在流量入口前先验。
5. **把 `llm.cost` 表达式列成升级 checklist 第一项**:这是唯一一条不会报错、只会改变账单的 breaking change。

### ❌ 千万别用

1. ❌ **不要把 `AGENTGATEWAY_MESSAGES_PREFER_COMPLETIONS=true` 当成长期方案**——1.7 移除,它会给你一个假的安全窗口。
2. ❌ **不要依赖「没配 catalog 就没有成本」这个隐含契约**——1.6 之后它不成立了,任何以 llm.cost 恒为 0 为前提的 CEL 表达式都是定时炸弹。
3. ❌ **不要用 `/some/prefix/v1/messages` 而不配 `llm.pathPrefix`**——v1.6 精确匹配,前缀路径会被当作未知路径直接透传而不做格式转换,客户端会拿到原始后端响应。
4. ❌ **不要在流式场景用默认 failOpen 的 guardrail**——1.6 默认 failClosed,但如果你显式改回 failOpen,等于把「检查失败」当成「检查通过」。
5. ❌ **不要用 `--grace-period` 低于 drain minimum**——#3334 修的就是这个:minimum 会被 clamp 到 maximum,但低于 minimum 的 grace period 仍然会在排空完成前 SIGKILL。

### 5 步生产升级 checklist

```text
□ Step 1  配置预检(不切流量)
    helm template agentgateway ./charts/agentgateway --set oidc.enabled=true | kubectl apply --dry-run=server -f -
    # 确认:base URL 全部带路径 / oidc.enabled=true / 无多前缀路径

□ Step 2  成本面盘点
    kubectl get agentgatewaypolicy -A -o yaml | grep -E 'llm\.cost|usd'
    # 确认:每一条命中的表达式都清楚 1.6 后会按真实价格求值

□ Step 3  格式路径决策
    # 对每个非 OpenAI 的后端,决定是否需要保留 extended-thinking 历史
    # 需要 → custom provider 只广告 chatCompletions
    # 不需要 → 保持默认 Responses

□ Step 4  灰度 + drain 验证
    # 先升一个副本,SIGTERM 验证排空时长 < grace period 且在途请求有状态码
    # 检查启动日志里打印的 effective drain 值

□ Step 5  可观测切换
    # access log 级别从全 info 变成错误时 error —— 更新告警规则
    # OTLP scope 变成 agentgateway.access —— 更新 dashboard 的 scope 过滤器
    # 失败请求的 error_type 标签 —— 加到 SLO 查询里
```

---

## 十一、总结:AI 网关的成熟标志是「开始替你做不讨喜的决定」

把 v1.6.0 的 5 条 breaking change 按性质排一下,能看到一个非常清晰的取舍:

| breaking change | 不讨喜程度 | 为什么仍然要做 |
|---|---|---|
| Messages 默认转 Responses | 高(丢 thinking 历史) | Responses 支持更多特性,长痛不如短痛 |
| 内建目录开始算成本 | 最高(静默扣费) | 成本追踪不能依赖「用户记得配价格」 |
| 路径精确匹配 | 中(配置要改) | 模糊匹配让 span 名变成 `POST /*` |
| base URL 补斜杠 | 中(配置要改) | 「我帮你猜路径」是事故温床 |
| Helm oidc.enabled | 低(启动报错) | 隐式塞 cookie secret 不安全 |

**五条 breaking change 里四条是「去掉便利性」**。一个不到两年(2025-03-18 建仓)、5163 star 的项目,在 1.6 这个版本选择**一次性移除四块脚手架**,还把 failover eviction、guardrail fail-closed、CRD 去默认化全翻成更严厉的方向。这不是「不重视兼容性」,这是**判断出模糊性正在成为采用障碍**。

和今天早间的「五维责任日」放在一起看,主线就清楚了:

- OpenAI 安全主笔说「试错式部署」必然周期性失败,主张核电站式冗余。
- 苹果要求 macOS Full Disk Access 必须「very explicit user action」。
- Cloudflare 用 OHTTP 让后端「看不到用户 IP」。
- Aleph Alpha 把「每个训练决策都可交代」做成产品。
- agentgateway v1.6 把四条便利性默认值一次性删掉。

**关键洞察 8:** 2026 年 10 月,「责任」在五个栈层上同时从道德论述变成了默认配置项。AI 网关这个栈层交出的答案是最具体的——它不是一句「我们要更安全」,而是 5 条 breaking change、一个计划在 1.7 移除的逃生舱、一张 check 进仓库的价格表、以及一个被修好的 65 秒排空 bug。

### 3 个长期判断

**1. AI 网关的护城河是协议转换的正确性,不是性能(6-12 月验证)**
当一个 release 里 9 条转换正确性修复、只有 10 条不带数字的性能改动时,竞争焦点已经清楚了。6-12 月内,「哪个网关快」会越来越不重要(因为瓶颈在 provider),「哪个网关转换不失真」会成为选型首要标准。**可验证信号**:会不会出现社区维护的「格式转换损失矩阵」。

**2. 模型目录是新的「定价表基础设施」(12-24 月)**
价格进二进制 + 进版本控制 + 自动更新,这套机制解决了 AI 计费的根本问题:**计费点在网关,而价格信息在 provider**。谁掌握了被广泛引用的开源定价表,谁就拿到了 AI 商业化的「计量层」。**可验证信号**:catalog 会不会被抽成独立项目,以及是否被其他网关引用。

**3. 「去掉服务端默认化」会被更多 Operator 跟进(12-24 月)**
#3520 的核心论点是「spec 应该表达用户意图,而不是被服务器填充后的版本」。在 GitOps 成为主流、`kubectl get -o yaml` 的输出被直接 diff 的今天,服务端默认值从「便利」变成了「噪音」。**可验证信号**:其他 Gateway API 实现是否跟进。

---

## 写在最后

agentgateway v1.6.0 最打动我的不是任何一条特性,是 release notes 里那句**「Today we just drop cursors on the floor」**。

一个能写出「我们之前直接把游标扔在地上」的项目,比一个把同样行为包装成「简化的一致性模型」的项目,值得信任得多。同样打动我的还有 #3334 作者那句「I'm no Rust (nor agent gateway) expert but this feels like the sensible thing to do and solves a real issue for us」——一个自认不是专家的人,抓出了一个 2ms 强关连接的并发 bug 和一个 min+max 的算术 bug,修好的是每个 SIGTERM 时在途请求的命运。

早间新闻里,OpenAI 的安全主笔主张「像核电站或繁忙机场那样运营」。agentgateway v1.6.0 交出的答卷是同一个精神的:**把必然发生的人为错误(配错路径、忘配价格、算错排空窗口)挡在灾难门外,办法不是更多流程,而是让默认值本身不给人犯错的余地。**

只不过,核电站靠的是层层冗余,而一个 AI 网关靠的是——**把四条便利性删掉**。

---

**数据来源**:[agentgateway v1.6.0 release notes](https://github.com/agentgateway/agentgateway/releases/tag/v1.6.0)(2026-10-02 发布,body 54,586 字符,索引 ~250 个 PR)、v1.5.0 release notes(2026-08-27,body 47,451 字符)、v1.6.0-rc.1 release notes(2026-10-01,body 8,550 字符)、PR #3647 / #3539 / #3520 / #3492 / #3191 / #3351 / #3268 / #3334 / #3544 / #3601 / #3411 / #3689 / #3618 / #3639 / #3581 / #3478 / #3520 的 body 与 diff 统计、issue #3479 / #1909 / #2979 / #2572 / #3602 / #3592,以及仓库元信息(创建于 2025-03-18,Rust,Apache-2.0,5,163 star)。
