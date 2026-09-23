---
title: "Agent Router（原 Envoy AI Gateway）v1.0 GA 深度拆解：AI 网关运行时层如何吃掉模型定价战的成本红利"
date: 2026-09-23
category: 技术
tags: [Agent Router, Envoy AI Gateway, AI Gateway, LLM Gateway, Envoy, Envoy Gateway, Gateway API, Kubernetes, CRD, v1beta1, 模型路由, 流量管理, MCP, MCPRoute, Model Context Protocol, 多租户, 限流, 配额管理, 供应商抽象, OpenAI兼容API, 跨厂商翻译, Anthropic, AWS Bedrock, Google Gemini, Azure OpenAI, 故障转移, 流式failover, OpenTelemetry, GenAI, 可观测性, 渐进式迁移, A/B测试, 成本优化, 推理成本, Token计数, 2026]
author: 林小白
readtime: 24
cover: https://images.unsplash.com/photo-1639725726221-803d-33b7a4e19d34?w=600&h=400&fit=crop
excerpt: "2026 年 9 月，Envoy AI Gateway 正式更名升级为 Agent Router（Agentic AI Foundation 项目），并带着 v1.0 GA 与 v1.1.0 两个版本进入「稳定 1.x API」时代。这篇文章拆解它为什么是 2026 年 AI 基础设施里最值得投入的一层：一个 OpenAI 兼容端点统一 16 家供应商、跨厂商协议双向翻译、MCP 网关聚合 + CEL 授权、按 token/配额限流、流式空闲超时故障转移、每请求凭证覆盖、OTel GenAI 追踪。当上游模型在同一天把价格砍半（GPT-6 Sol/Luna 对半、Opus 5.5 缓存读取降 60%），真正的成本红利不在「选更便宜的模型」，而在「让网关替你按请求粒度选模型、做缓存、做故障转移」——本文含 5 段可运行 CRD/代码、5 套方案 17 维度对比、6 条可验证硬指标与 5 步生产落地 checklist。"
---

# Agent Router（原 Envoy AI Gateway）v1.0 GA 深度拆解：AI 网关运行时层如何吃掉模型定价战的成本红利

> 早上 OpenAI 把 GPT-6 Sol/Luna 的价格直接砍到 5.6 系列的一半，Anthropic 在前 90 分钟把 Opus 5.5 的缓存读取价格砍掉 60%。一天之内两家前沿实验室同时降价，看起来是客户的胜利。但如果你在公司里负责「每月 200 万美元推理账单」这件事，你会发现自己并没有因此轻松——因为**降的是目录价，不是你的实际成本**。真正决定你付多少钱的，不是你选了哪个模型，而是你的**流量能不能在请求粒度上被调度**。这就是 2026 年「AI 网关运行时层」成为独立栈层的背景：Envoy AI Gateway 在这个月更名升级为 **Agent Router**，发布 **v1.0 GA** 与 **v1.1.0**，把「AI 流量治理」做成了一个稳定的、有 API 兼容承诺的 Kubernetes 一等公民。

**本文核心结论（先给答案）：**

- **Agent Router 不是一个代理转发器**，它是 CNCF Envoy Gateway 之上的一个**控制平面**：用 `AIGatewayRoute` / `AIServiceBackend` / `BackendSecurityPolicy` / `GatewayConfig` / `MCPRoute` 五个 `v1beta1` CRD 描述「谁能用什么模型、走哪个供应商、花多少配额、失败怎么办」，数据面仍然是 Envoy。**Agent Router 控制平面，Envoy 承载数据面。**
- **v1.0 GA 最重要的不是功能，而是承诺**：五个核心 CRD 在整个 1.x 系列**不会发生破坏性变更**（除非关键安全修复，且会带迁移文档）。这是「把 AI 网关放进生产」的门槛性条件——在此之前的所有 AI 网关项目都还在「下个版本改 CRD」的状态。
- **v1.1.0 补齐了生产化的最后四块砖**：跨供应商 **token 计数 API**（路由/限流/成本归因的前提）、**每请求凭证覆盖**（多租户不共享一把上游密钥）、**流式空闲超时 + 故障转移**（流式推理的静默挂起不再需要人工摘节点）、**OTel GenAI 语义约定追踪**（可观测性对齐全生态）。
- **更名不是换皮**：代码、维护者、发布节奏、Apache 2.0 许可证、CRD 与 API group（`aigateway.envoyproxy.io`）、CLI（`aigw`）、命名空间（`envoy-ai-gateway-system`）、容器镜像与 Go module 路径**全部不变**。仓库从 `envoyproxy/ai-gateway` 迁到 `theagentrouter/agent-router`，旧链接全部自动重定向。**你昨天写的 manifest，明天照样 apply。**
- **与定价战的互补关系**：模型层降价解决的是「单价」，网关层解决的是「用量 × 单价 × 可用性」的**乘积**。没有网关，降价红利会被「所有请求都打最贵模型」「没有缓存命中」「单供应商故障导致全站 500」这三件事吃掉。RouteLLM 的公开实验证明：一个请求级路由器（`mf` router）在保持 95% GPT-4 水平的前提下可把成本降低最多 85%——**这个收益比任何一次目录价降价的幅度都大一个数量级**。

---

## 1. 问题的源头：每个团队都在重写同一个网关

先说清楚「AI 网关运行时层」到底解决了什么历史问题。

### 1.1 接入一个供应商 ≠ 一个 SDK

一个真实的中型企业（200-500 名工程师，3-5 个 AI 产品线）在 2025-2026 年的典型状态是这样的：

| 产品线 | 主供应商 | 协议 | 凭证管理 | 限流 | 故障转移 |
|--------|----------|------|----------|------|----------|
| 客服 Copilot | OpenAI | `/v1/chat/completions` | 环境变量 | 无 | 无（挂了就挂了） |
| 文档问答 | Azure OpenAI | `/openai/deployments/...` | Key Vault 轮换 | 应用层令牌桶 | 切到 OpenAI（硬编码） |
| 代码助手 | Anthropic | `/v1/messages`（thinking blocks） | 1Password | 无 | 无 |
| 内部 BI Agent | AWS Bedrock | `/converse`（另一套 schema） | IAM Role | 无 | 无 |
| 端侧兜底 | 自托管 vLLM | OpenAI 兼容 | 无 | 无 | 无 |

这不是「技术选型分散」，这是**每个团队都在不知不觉地重写同一个网关**：SDK 封装层、重试层、超时层、密钥管理层、成本归因层、灰度切换层。每个团队写得都不一样，每个团队都觉得自己那套「够用了」。直到有一天 CFO 拿着账单问「为什么客服 Copilot 上个月花了 40 万美元，其中 60% 的请求其实是『总结这个工单』这种活，小模型完全干得了」——然后你发现**你根本没有能力回答这个问题**，因为你甚至无法把「总结工单」这类请求和「多步推理」这类请求在流量上区分开。

### 1.2 为什么不能用 API 网关直接套

有人会说：这不就是 API 网关的事吗？用 Kong / APISIX / Envoy Gateway 加几个 upstream 不就完了？

答案是：**LLM 流量破坏了传统 API 网关的四个隐含假设**。

1. **请求不是一次性的，是流式的**。传统网关的「请求 → 响应」模型在 LLM 这里变成了「请求 → 一个可能持续 30-90 秒的 SSE 流，且第一个 token 之前有一段不可预测的静默（TTFT 可能是 200ms，也可能是 8s）」。传统网关的 idle timeout 要么设得很小（误杀慢启动的上游），要么设得很大（上游真的挂了，客户端挂在那里 90 秒）。**v1.1.0 的 `streamIdleTimeout` 就是为了解决这一件事**：它只约束「两个字节之间的间隔」，不约束「整个流多久」，并且能在**首 token 之前**触发时把请求故障转移到下一个供应商。
2. **成本计量单位不是请求数，是 token**。传统网关的限流器按 RPS 或 QPS 工作。LLM 的成本是 `输入token × 单价 + 输出token × 单价`，而单价**每个模型不一样、每个供应商不一样、缓存命中时又不一样**（Opus 5.5 缓存读取 $0.20/百万 token，是正常输入价 $4 的 5%）。**按 RPS 限流等于不限流**。这就是 v1.0 的「token- and quota-aware rate limiting」与 v1.1.0 的跨供应商 `/tokenize` API 存在的原因。
3. **协议不是一套，是五六套且仍在增殖**。OpenAI 有 `/v1/chat/completions` 和新的 `/v1/responses`；Anthropic 有 `/v1/messages`（带 thinking blocks）；Bedrock 有 `/converse` 和 `/invoke-model`；Gemini 有 `/v1beta/openai` 前缀和非 OpenAI 原生 schema。客户端代码一旦绑定某一套，换供应商就是重写。**Agent Router 的跨厂商翻译层把这件事从应用代码里挪到了数据面**。
4. **可观测性的对象不是「HTTP 状态码」，是「生成质量」**。一个 HTTP 200 的流可能输出的是幻觉内容；一个 500 的请求可能是上游过载而不是你的代码有 bug。GenAI 可观测性需要 `gen_ai.*` 语义属性（模型名、token 用量、reasoning token 单列、TTFT、token 间延迟），**v1.1.0 用 `AI_GATEWAY_TRACING_SEMCONV=genai` 一个开关接入了 OpenTelemetry GenAI 约定**。

### 1.3 物理约束与业务约束的交汇点

把上面四点压成一句话：**LLM 流量的治理粒度必须比 HTTP 更细（token 级），协议必须比 REST 更宽容（多 schema 翻译），失效模式必须比同步调用更复杂（流式中途失效）**。这就是为什么 2025-2026 年会出现一批专门的 AI 网关项目，也是为什么 Envoy 这个「老牌数据面」会被选作底座——**它已经解决了连接管理、重试、断路、mTLS、可观测性这些「非 AI」的部分**，AI 网关只需要在上面加「AI 特有的语义」。

Agent Router 的定位用一句话概括就是：**Agent Router controls. Envoy carries.**（Agent Router 控制平面，Envoy 承载数据平面。）

---

## 2. 三层架构：控制平面 CRD、跨厂商翻译层、Two-Tier 网关模式

### 2.1 五个核心 CRD：把 AI 流量治理声明式化

v1.0 GA 把五个 CRD 的 `v1beta1` 版本声明为**稳定契约**。理解这五个 CRD 的分工，就理解了整个系统的设计哲学。

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        应用层（你的代码）                              │
│          只用 OpenAI SDK，指向网关的 /v1/chat/completions              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ 一个端点，N 个供应商
┌──────────────────────────────▼──────────────────────────────────────┐
│  Tier One Gateway（集中式入口）                                       │
│  ┌────────────┐ ┌───────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │AIGateway   │ │AIService     │ │BackendSecurity│ │  Gateway     │  │
│  │Route       │ │Backend       │ │Policy         │ │  Config      │  │
│  │ 路由规则    │ │ 供应商后端    │ │ 上游凭证       │ │ ext-proc 配置│  │
│  │ hostname   │ │ modelName     │ │ API key /     │ │ 资源/环境变量 │  │
│  │ 限流/配额   │ │ Override      │ │ AWS SigV4 /   │ │ forwardProxy │  │
│  └────────────┘ └───────────────┘ └──────────────┘ └──────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  MCPRoute —— MCP 服务器聚合 + CEL 授权 + hostname 范围         │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ Envoy Gateway + ext-proc（gRPC）
┌──────────────────────────────▼──────────────────────────────────────┐
│  Tier Two Gateway（自托管推理集群入口）                                │
│  endpoint picker / Gateway API Inference Extension / vLLM 集群         │
└─────────────────────────────────────────────────────────────────────┘
```

**逐个拆解：**

- **`AIGatewayRoute`**：路由的顶层入口。绑定 hostname（多租户）、定义路由规则（`AIGatewayRouteRule`）、挂载限流策略与故障转移策略。**这是应用团队最常打交道的 CRD。**
- **`AIServiceBackend`**：一个「逻辑后端 = 一个供应商的一个模型」。**`modelNameOverride` 是这里的关键设计**——网关对外暴露一个稳定的、应用-facing 的模型名，内部映射到供应商特定的模型名。所有「换供应商」「灰度新模型」「A/B 测试」都变成改这一个字段，客户端代码零改动。
- **`BackendSecurityPolicy`**：集中管理上游凭证。支持 API key、AWS（SigV4）、Azure、GCP 云原生身份（含 **GKE Workload Identity via Application Default Credentials**，彻底不在集群里放长期密钥）。v1.1.0 新增 `credentialOverride`：**每请求级凭证覆盖**。
- **`GatewayConfig`**：网关级的 ext-proc（external processor）配置——资源需求、环境变量、容器设置，以及 v1.1.0 的 HTTP CONNECT 前置代理。
- **`MCPRoute`**：MCP（Model Context Protocol）网关。把多个 MCP server 聚合到一个端点，支持工具路由与 include/exclude 过滤、CEL 规则的细粒度授权、每后端的 header 转发与 JWT claim 投影。v1.1.0 加了 hostname 范围限定与 `backendSelector`（CEL 选择器，在 session initialize 时求值，默认 Deny）。

### 2.2 跨厂商翻译层：把协议差异留在网关里

v1.0 的翻译能力清单（全部是一等支持，不是实验特性）：

| 翻译路径 | 说明 |
|----------|------|
| Anthropic `/v1/messages` → OpenAI `/v1/chat/completions` | Claude 原生客户端可以直连任意 OpenAI 兼容后端 |
| Anthropic Messages → AWS Bedrock `/converse` | 不换协议就能打到 Bedrock |
| Anthropic Messages → AWS Bedrock `/invoke-model` | 原生路径，Claude on Bedrock |
| OpenAI `reasoning_effort` → Bedrock `reasoning_config` | 一个推理强度旋钮跨 Anthropic / OpenAI / Gemini 生效 |
| OpenAI `/v1/responses` → 各供应商 | 新 Responses API 全支持（流式/非流式、function calling、MCP tools、reasoning、多轮） |
| OpenAI `/v1/embeddings` → Bedrock / Gemini | 嵌入层也统一 |

**翻译层最容易被低估的价值在于「迁移成本」**。假设你今天想把客服 Copilot 从 Azure OpenAI 切到 Bedrock 上的 Claude，在没有翻译层的情况下你要改：SDK、请求 schema、流式解析（SSE 事件结构不同）、工具调用字段名、reasoning blocks 处理。有了翻译层，**你改的是 `AIServiceBackend` 里的一行 `modelNameOverride`**。这不是「省了几天工作」的问题，这是把「供应商锁定」从一个架构问题降级成一个配置问题。

### 2.3 Two-Tier Gateway 模式：平台团队与应用团队的分工线

Agent Router 明确推荐**两层网关**模式，这是它对企业架构最有启发的一点：

- **Tier One Gateway（集中式入口）**：认证、顶层路由、全局限流。平台团队拥有。所有外部供应商流量（OpenAI / Anthropic / Bedrock / Gemini…）从这里进出，凭证集中管理，成本归因在这里做。
- **Tier Two Gateway（自托管推理集群入口）**：对自托管模型（vLLM / SGLang / TensorRT-LLM 集群）的细粒度访问控制，带 **endpoint picker** 支持与 **Gateway API Inference Extension** 集成，做推理优化（按 GPU 负载、按 KV cache 命中率选择端点）。推理平台团队拥有。

**为什么必须是两层而不是一层？** 因为两类流量的治理诉求完全不同：外部供应商流量的核心问题是「成本与供应商依赖」，自托管流量的核心问题是「集群利用率与调度」。把它们塞进一个网关，结果是平台团队既要懂供应商计费又要懂 GPU 调度，两个都做不好。Two-tier 模式让每个团队只为自己那层的指标负责。

---

## 3. 版本细节：v1.0 GA 与 v1.1.0 到底改了什么

### 3.1 v1.0.0（2026-06-23）：GA 的含义是「承诺」而非「功能」

v1.0.0 的发布说明第一句就划定了重点：

> 1.0 is a commitment, not just another feature release.

具体承诺内容（引自官方支持策略）：

- **API 兼容性**：`v1beta1` CRD 在整个 1.x 系列保持稳定；新字段只做向后兼容的新增；破坏性变更只会出现在未来的 2.0，且必然带迁移路径。
- **控制器升级**：升级控制器不会破坏有效配置；一次最多跨两个 minor 版本升级。
- **Envoy Gateway 兼容性**：每个版本都构建在最新的稳定 Envoy Gateway（及 Envoy Proxy）之上；**升级 Agent Router 之前先把 Envoy Gateway 升级**。
- **生命周期**：一个版本支持到「之后两个版本」为止。

**v1.0 的完整功能面（GA 时的能力清单）：**

| 能力域 | 具体内容 |
|--------|----------|
| 通用 LLM 访问 | **16 家供应商**一个端点：OpenAI、Azure OpenAI、Google Gemini、Google Vertex AI、AWS Bedrock、Anthropic、Mistral、Cohere、Groq、Together AI、DeepInfra、DeepSeek、Hunyuan、SambaNova、Grok、Tetrate Agent Router Service |
| 端点覆盖 | `/v1/chat/completions`、`/v1/completions`、`/v1/embeddings`、`/v1/images/generations`、`/v1/audio/transcriptions`、`/v1/audio/translations`、`/v1/audio/speech`、`/v1/responses` |
| 多模态 | chat 请求接受 image、`audio_url`、`video_url` 内容片段 |
| MCP 网关 | `MCPRoute` 聚合多 MCP server；工具路由与 include/exclude 过滤；CEL 细粒度授权（`tools/list` 与 `tools/call` 同一套规则，**调用者只能发现自己被允许调用的工具**）；每后端 header 转发 + JWT claim 投影 |
| 流量管理 | hostname 多租户路由；**token 级与配额级限流**（`QuotaPolicy` + 后端限流过滤器注入）；供应商 fallback；**Gateway API Inference Extension 的 InferencePool 支持** |
| 认证与合规 | `BackendSecurityPolicy`（API key / AWS / Azure / GCP，含 GKE Workload Identity）；**请求/响应体脱敏**（合规） |
| 可观测性 | OpenTelemetry 追踪（OpenInference 兼容，可对接 Arize Phoenix）；Prometheus 指标：token 用量、TTFT、token 间延迟，**reasoning token 单独计量** |

**GA 时的依赖基线**：Go 1.26.4 / Envoy Gateway v1.8.1 / Envoy Proxy v1.38.1 / Gateway API v1.5.1 / **Gateway API Inference Extension v1.0.2** / MCP Go SDK v1.6.1。

**早期生产采用者**（官方致谢中点名的）：**Bloomberg、LY Corporation、Alan by Comma Soft、NRP**。维护者来自 **Tetrate、Bloomberg、Tencent、Nutanix**。这个采用者名单本身就是「大企业敢把 AI 流量放上来」的信号——Bloomberg 与 LY Corporation 的流量规模不是玩具级。

### 3.2 v1.1.0（2026-08-21）：补齐生产化的最后四块砖

v1.1.0 是稳定 1.x API 上的第一个 minor 版本，**从 v1.0 升级不需要任何 CRD 迁移**，唯一的运维侧变更是 Helm chart 给控制器加了受限的 security context（非 root UID/GID 65532、能力全删、禁止提权、RuntimeDefault seccomp）。

**① Token 计数 API（跨供应商）**

这是 v1.1.0 里最容易被外行忽略、内行最激动的一个功能。

- **vLLM 兼容的 `/tokenize`**：对 **vLLM、Vertex AI Gemini、GCP Anthropic、AWS Bedrock Converse、AWS Anthropic** 生效，无需生成补全就能数 token。
- Anthropic 原生客户端走 `/anthropic/v1/messages/count_tokens`。
- Responses API 客户端走 `/v1/responses/input_tokens`（OpenAI 与 Azure OpenAI）。

**为什么关键**：token 是 LLM 成本与限流的唯一正确计量单位。在 `/tokenize` 之前，你要么按 RPS 限流（等于不限流），要么在应用里自己维护一份分词器（每个模型一份，版本漂移就错）。现在网关统一提供了「**这个请求大概会花多少 token**」的答案，**基于 token 的配额限流、成本预算、路由决策才第一次成为可能**。注意这是「输入 token」级别的预估，输出 token 仍需按模型历史均值估算——别把它当成精确计费工具，把它当成**容量规划与配额治理的标尺**。

**② 每请求上游凭证 `credentialOverride`**

- 一个受信任的 filter 可以**逐请求**提供上游凭证，而不是在 `BackendSecurityPolicy` 里共享一把静态 key。
- 凭证来源：**Envoy 动态 metadata（推荐）** 或一个请求 header（网关会在发往后端前剥除）。
- 支持 API key、Anthropic、Azure、GCP、AWS SigV4。
- `fallbackToConfigured` 默认 `true`：请求没带覆盖凭证时回落到配置值。

**为什么关键**：这是**多租户 AI 平台的合规刚需**。想象一个 SaaS 平台，每个企业客户自带自己的 OpenAI 企业账户密钥（BYOK，Bring Your Own Key）。在 `credentialOverride` 之前，你只能在应用层解密客户密钥再转发，密钥明文出现在应用内存与日志里；现在网关在数据面完成「按租户取密钥 → 签名 → 转发 → 剥除」，应用层只负责把租户身份放进 dynamic metadata。**安全边界的移动，比功能本身重要。**

**③ 流式空闲超时 + 故障转移**

```yaml
AIGatewayRouteRule.streamIdleTimeout  # 可选，Gateway API duration 格式
```

语义非常精确：
- **它约束的是「上游多久没吐字节」，不是「整个流多久」。**
- 如果在**第一个 token 之前**触发，且配了重试策略，**请求会故障转移到下一个 backend**。
- 如果在**流式传输中途**触发，返回 504（已经吐了 header/body，没法透明重试了）。
- 官方建议与 `BackendTrafficPolicy` 的重试策略配对，让重试覆盖 reset。

**为什么关键**：这是流式推理里最恶心的失效模式——**上游不是返回 500，而是静静地看着你**。在 LLM 场景里，provider 侧排队、模型过载、网络中间件 buffer 满了，都会表现为「连接活着但没数据」。传统网关对此完全无能为力：要么靠一个粗暴的整体超时（误杀合理的慢推理），要么完全不设（客户端挂死）。`streamIdleTimeout` 是我见过的对「流式 TTFT 抖动」这个问题最干净的解法。

**④ MCP 网关增强**

- `MCPRoute.spec.hostnames`：把一个 MCP 端点限定到特定 host（最多 16 个）。
- `MCPRoute.spec.backendSelector`：**CEL 选择器，在 session initialize 时求值，限制一次会话 fan-out 到哪些后端，`defaultAction` 默认 Deny。**
- initialize 响应现在广播**合并后的后端能力**；控制器每个 namespace 共享一个 Envoy Gateway `Backend`。

**为什么关键**：MCP 正在成为 Agent 的「工具总线」。当你的 Agent 后面挂了 20 个 MCP server（有的能查生产数据库，有的只能查维基），**「谁能调哪个工具」必须是平台级强制，而不是 Agent 自觉**。`backendSelector` 默认 Deny + initialize 时求值，意味着**一个 Agent 会话建立的那一刻，它的工具边界就已经被网关钉死了**，不会出现「跑着跑着越权」。

**⑤ 观测性对齐**

- 环境变量 `AI_GATEWAY_TRACING_SEMCONV=gen_ai` 让 ext-proc 发出 `gen_ai.*` span 属性（OpenTelemetry GenAI 语义约定）。
- 随附 `examples/monitoring/grafana-dashboard.json` 示例面板。
- 控制器与 ext-proc 支持 `--logFormat=json`。
- MCP resource reads 会在 access-log metadata 里填 `mcp_resource_uri`。

**⑥ 翻译层补全**

- Vertex AI 上的 Claude 支持 **JSON-schema 约束解码**（structured output，针对 advertise `output_config` 的模型）。
- OpenAI `reasoning_effort` 转发到 Bedrock 成 `reasoning_config`。
- Responses API 支持 `tool_search` 内建工具与 `additional_tools`，保留未知 tool 类型，接受 Codex 风格的 agent input items。

**⑦ Helm 与运维**

- 可发 **PDB**（PodDisruptionBudget）、支持 `topologySpreadConstraints`、附加 `podLabels`。
- **过滤器配置拆分到多个 Secret**：大型网关配置不再撞上 Kubernetes 的 **1 MiB Secret 大小上限**。这是一个只有真在生产里跑过的人才会遇到的坑——当你有几百条路由 + 几十个供应商后端，单个 Secret 真的会超限。

**v1.1.0 依赖基线**：Go 1.26.4 / Envoy Gateway v1.8.1 / Envoy Proxy v1.38.1 / Gateway API v1.5.1 / Inference Extension v1.0.2 / **MCP Go SDK v1.7.0**（唯一升级的）。

### 3.3 更名：从 Envoy AI Gateway 到 Agent Router

这是 2026 年 9 月最重要的一次项目身份变更，但**技术含义比名字小得多**：

| 维度 | 是否变化 |
|------|----------|
| 代码 / 维护者 / 发布节奏 / Apache 2.0 许可 | ❌ 不变 |
| CRD 与 API group（`aigateway.envoyproxy.io`） | ❌ 不变 |
| CLI（`aigw`） | ❌ 不变 |
| 命名空间（`envoy-ai-gateway-system`） | ❌ 不变 |
| 容器镜像（`docker.io/envoyproxy/ai-gateway-*`） | ❌ 不变 |
| Helm chart / Go module 路径（`github.com/envoyproxy/ai-gateway`） | ❌ 不变 |
| 仓库地址 | ✅ `envoyproxy/ai-gateway` → `theagentrouter/agent-router`（旧链接自动重定向） |
| 网站 | ✅ → `theagentrouter.ai`（旧链接自动重定向） |
| 治理 | ✅ 成为 **Agentic AI Foundation** 项目 |

官方原话：**「Your manifests from yesterday apply tomorrow.」**（你昨天的 manifest，明天照样适用。）

**怎么解读这个更名**：名字从「AI Gateway」变成「Agent Router」，说明社区的注意力重心已经从「把 LLM API 网关化」挪到了「**Agent 流量的治理**」——MCP 网关、工具授权、会话级后端选择这些 v1.1.0 的增强，全都是面向 Agent 场景而非纯 chat 场景的。 roadmap 上接着要做的也是：**独立 `MCPBackend` CRD**（把 MCP 后端配置从 `MCPRoute` 解耦）、更深的 MCP 授权（跨 tools/resources/prompts）、**更完整的配额感知路由**（自动绕开被限流的上游）、更多翻译路径与多模态。

---

## 4. 五段实战代码：从 5 分钟上到到生产配置

> 所有配置均基于 v1.1.0 的 `v1beta1` API，可直接 `kubectl apply`。

### 4.1 本地 5 分钟起步：`aigw run`

Agent Router 现在支持**脱离 Kubernetes 直接当本地 OpenAI 兼容路由器**跑：

```shell
# 安装 CLI（见官方文档）
OPENAI_API_KEY=sk-your-key aigw run
```

然后把任意 OpenAI 兼容客户端指向 `http://localhost:1975/v1`。CLI 会自动做 provider 自动配置。

这个路径的价值不在「生产」，而在于：**你可以在 5 分钟内验证「我的应用代码零改动能不能跑通网关」**。所有迁移评估都该从这里开始，而不是从画架构图开始。

### 4.2 核心路由：多供应商 + 模型虚拟化 + 故障转移

```yaml
---
# 1. 供应商后端：对外稳定模型名 → 供应商真实模型名
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIServiceBackend
metadata:
  name: openai-gpt6-sol
  namespace: ai-gateway-system
spec:
  timeout: 120s
  clients:
    - name: openai
      serviceName: openai
      weight: 100
      apiVersion: openai/v1
      model: gpt-6-sol            # 供应商侧真实模型名
      modelNameOverride:          # 应用看到的稳定名（关键设计）
        name: prod-chat-primary
---
# 2. 另一个供应商：同样的逻辑名，不同实现
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIServiceBackend
metadata:
  name: bedrock-claude
  namespace: ai-gateway-system
spec:
  timeout: 120s
  clients:
    - name: bedrock
      serviceName: bedrock-runtime
      apiVersion: aws-bedrock/converse
      model: anthropic.claude-opus-5-5
      modelNameOverride:
        name: prod-chat-primary   # 与上同名 → 路由层可在两者间故障转移/灰度
---
# 3. 凭证集中管理（不在集群里放明文 key 时的推荐姿势）
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: BackendSecurityPolicy
metadata:
  name: openai-shared
  namespace: ai-gateway-system
spec:
  type: APIKey
  apiKey:
    secretRef: openai-prod-key    # Secret 引用，支持外部密钥管理器同步
  # v1.1.0 新增：每请求凭证覆盖（BYOK 多租户）
  credentialOverride:
    fromDynamicMetadata:          # 推荐：Envoy dynamic metadata
      key: ai_gateway.tenant_key
    fallbackToConfigured: true     # 请求没带 → 回落到上面的静态 key
---
# 4. 路由：hostname 多租户 + 限流 + 故障转移
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIGatewayRoute
metadata:
  name: chat-route
  namespace: ai-gateway-system
spec:
  hostnames:
    - chat.ai.example.com         # 只有这个 host 下的租户看到这批模型
  targetRefs:
    - name: chat-gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  rules:
    - name: primary-with-failover
      matches:
        - headers:
            - name: x-model-tier
              value: primary
      backendRefs:
        - name: openai-gpt6-sol
          weight: 90
        - name: bedrock-claude    # 故障转移目标
          weight: 10
      # v1.1.0：流式空闲超时（约束「字节间隔」而非「总时长」）
      streamIdleTimeout: 45s
      rateLimits:
        - type: Global
          cost:
            requestCost:
              source: TokenUsage   # 按 token 计费，不是按 RPS
```

**这段配置里最值钱的三行**：

1. `modelNameOverride`：客户端永远只认 `prod-chat-primary`。哪天你想把 90% 流量从 GPT-6 Sol 换成 Opus 5.5，**改的是这两个 CRD 的权重，客户端一行代码不动**。这就是「模型虚拟化」——把模型选型从应用代码里解耦出来。
2. `streamIdleTimeout: 45s`：上游 45 秒不吐字节就触发策略——首 token 前重试到 `bedrock-claude`，中途返回 504 而不是让客户端挂死。
3. `cost.source: TokenUsage`：限流按 token 算。一个「总结工单」的轻请求和一个「多步推理」的重请求在限流器眼里是两个量级的东西，这才对。

### 4.3 MCP 网关：工具边界在会话建立时就被钉死

```yaml
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: MCPRoute
metadata:
  name: agent-tools
  namespace: ai-gateway-system
spec:
  hostnames:                      # v1.1.0：MCP 端点限定 host（最多 16 个）
    - agents.internal.example.com
  targetRefs:
    - name: tools-gateway
      kind: Gateway
      group: gateway.networking.k8s.io
  backends:
    - name: wiki-mcp
      serviceName: wiki-mcp
      port: 8080
    - name: prod-db-mcp            # 高危：只能特定会话用
      serviceName: prod-db-mcp
      port: 8080
      filters:
        - type: HeaderMutation
          headerMutation:
            set:
              - name: x-jwt-claims
                valueFrom: jwt     # JWT claim 投影到后端
  # v1.1.0：会话级后端选择（initialize 时求值，默认 Deny）
  backendSelector:
    - matchExpressions:
        - key: tier
          operator: In
          values: ["trusted-agents"]
  rules:
    - name: db-tools-need-approval
      matches:
        - tools:
            - names: ["prod-db.query", "prod-db.write"]
      # CEL 授权：tools/list 与 tools/call 用同一套规则
      # → 调用者只能发现自己被允许调用的工具
      authorization:
        allowExpression: "request.auth.claims['roles'].exists(r, r == 'db-operator')"
    - name: wiki-tools-open
      matches:
        - tools:
            - names: ["wiki.search", "wiki.read"]
      authorization:
        allowExpression: "true"
```

**设计要点**：注意 `tools/list` 与 `tools/call` 使用同一套授权规则。这不是实现细节，这是一个**安全模型选择**：如果 list 与 call 用不同规则，Agent 会在「以为自己有某个工具」→「调用被拒」之间产生大量无效推理步骤，甚至把拒绝信息当成提示词注入。**让可见性等于可调用性**，是 MCP 网关的正确姿势。

### 4.4 Tier Two：自托管推理集群的 endpoint picker

```yaml
---
# 自托管 vLLM 集群注册成 InferencePool（Gateway API Inference Extension）
apiVersion: inference.networking.x-k8s.io/v1alpha1
kind: InferencePool
metadata:
  name: vllm-gpu-pool
  namespace: inference-system
spec:
  selector:
    app: vllm
  targetPortNumber: 8000
  # 扩展：按 KV cache 命中率与队列长度挑端点
---
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIServiceBackend
metadata:
  name: internal-deepseek
  namespace: ai-gateway-system
spec:
  timeout: 300s                   # 自托管长推理，总超时可以放宽
  clients:
    - name: vllm
      serviceName: vllm-gpu-pool
      apiVersion: openai/v1       # vLLM 暴露 OpenAI 兼容 API
      model: deepseek-v4-r1
      modelNameOverride:
        name: prod-chat-internal
---
# Tier One 把「内部优先、外部兜底」写进路由权重
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: AIGatewayRoute
metadata:
  name: cost-optimized-route
  namespace: ai-gateway-system
spec:
  rules:
    - backendRefs:
        - name: internal-deepseek  # 自托管：固定成本，优先
          weight: 80
        - name: openai-gpt6-sol    # 外部：突发时兜底
          weight: 20
      streamIdleTimeout: 60s       # 自托管大模型 TTFT 更高，阈值放宽
```

**成本工程的核心算术**：假设自托管 vLLM 集群的摊销成本是外部 GPT-6 Sol 的 1/8。把 80% 的可路由流量导到自托管，账单直接降一个量级；而保留 20% 外部容量，意味着突发流量不会因为自托管队列排满而失败。**这个「8:2」不是拍脑袋，是靠 Tier One/Tier Two 分层 + `streamIdleTimeout` 故障转移兜底才成立的**——没有故障转移，你不敢把 80% 流量压到自托管集群上。

### 4.5 用 `gen_ai.*` 追踪把成本归因到业务线

```yaml
---
# GatewayConfig：打开 OTel GenAI 语义约定追踪
apiVersion: aigateway.envoyproxy.io/v1beta1
kind: GatewayConfig
metadata:
  name: ai-gateway-config
  namespace: ai-gateway-system
spec:
  # v1.1.0：HTTP CONNECT 前置代理（PrivateLink 场景刚需）
  forwardProxy:
    address: corp-egress.internal:3128
  # ext-proc 环境变量
  env:
    - name: AI_GATEWAY_TRACING_SEMCONV
      value: genai                # 发出 gen_ai.* span 属性
    - name: OTEL_EXPORTER_OTLP_ENDPOINT
      value: http://otel-collector.observability.svc:4317
  # 大型配置拆分到多个 Secret，绕开 1 MiB 上限（v1.1.0）
  filterConfigSecrets:
    - name: ai-filters-part-1
    - name: ai-filters-part-2
---
# 采集侧：解析 gen_ai.* 做按业务线的成本归因
# collector config 片段
processors:
  attributes/genai_cost:
    actions:
      - key: cost_usd
        from_attribute: gen_ai.usage.input_tokens
        action: upsert
      # 输出成本 = input_tokens * 单价 + output_tokens * 单价
      # reasoning token 单独计量（v1.0 指标已拆分）
```

**归因链条**：`hostname（租户）+ 路由规则（业务线）+ gen_ai.usage.input_tokens/output_tokens + modelNameOverride（逻辑模型）` → 每条流的真实成本。这就是 CFO 那个问题（「客服 Copilot 为什么花 40 万」）第一次有了精确答案。注意 **reasoning token 在 v1.0 的 Prometheus 指标里就是单独计量的**——在推理模型时代，reasoning token 经常占到输出成本的 40-70%，混在一起统计会让成本数据完全失真。

---

## 5. 性能与方案对比：5 套 AI 网关方案 17 维度横评

### 5.1 五套方案全景

2026 年你要选一个 AI 网关方案，实际是在这五类里选：

| 方案 | 代表 | 定位 |
|------|------|------|
| **A. Envoy-native 控制平面** | **Agent Router（Envoy AI Gateway）** | Kubernetes CRD + Envoy 数据面，平台团队视角 |
| **B. Python 应用层路由器** | **RouteLLM** | 请求级「强/弱模型」路由，成本优先的学术派方案 |
| **C. 托管商业 AI 网关** | OpenRouter / Portkey / LiteLLM Proxy | 一行 baseURL 接入，按量计费或自托管 |
| **D. 云厂商原生网关** | AWS Bedrock Gateway / Azure AI Foundry / Vertex AI Gateway | 单云内深度集成，跨云能力弱 |
| **E. 通用 API 网关 + 自研 AI 中间件** | Kong / APISIX + 自己写翻译与 token 计量 | 灵活但维护成本高 |

### 5.2 17 维度对比表

| 维度 | Agent Router | RouteLLM | LiteLLM Proxy | OpenRouter | 云厂商原生 |
|------|-------------|----------|---------------|------------|------------|
| **数据面** | Envoy Proxy（C++） | Python（FastAPI） | Python | 托管 | 云内 |
| **控制平面** | 5 个 `v1beta1` CRD（GA 稳定） | 配置文件 | YAML + Admin UI | 无（SaaS） | 云控制台 |
| **部署形态** | K8s / 本地 `aigw run` | Python 进程 | Docker / K8s | SaaS | 云原生 |
| **供应商数** | **16（GA 声明）** | 任意（经 LiteLLM） | 100+ | 300+ 模型 | 单云（3-10） |
| **跨厂商协议翻译** | **一等支持（Anthropic↔OpenAI↔Bedrock/Gemini 双向）** | 不涉及（路由层） | 好（OpenAI 格式为枢纽） | 好 | 差（锁定本云） |
| **MCP 网关** | **是（`MCPRoute` + CEL 授权）** | 否 | 否 | 否 | 部分 |
| **token 级限流** | **是（`/tokenize` 跨供应商 + `QuotaPolicy`）** | 否 | 部分 | 否 | 是（云内） |
| **流式故障转移** | **是（`streamIdleTimeout`，首 token 前可重试）** | 否 | 重试，无空闲超时语义 | 否 | 云内自动 |
| **多租户隔离** | **hostname 路由 + 每请求凭证覆盖** | 否 | 虚拟 key | API key 级 | 云账号级 |
| **凭证管理** | API key / **AWS SigV4 / Azure / GCP WI** | 环境变量 | 多种 | 平台代管 | IAM |
| **可观测性** | **OTel `gen_ai.*` + Prometheus + Grafana 面板** | 评估框架（非 APM） | 基本 | 平台内 | 云监控 |
| **成本归因粒度** | **租户 × 业务线 × 逻辑模型 × token（reasoning 单列）** | 路由级节省报告 | 按 key | 按请求 | 云账单 |
| **推理成本节省（公开数据）** | 无官方基准（依赖路由策略） | **最高 85%（保 95% GPT-4 水平）** | 依赖路由配置 | 依赖模型选择 | 无 |
| **API 稳定性承诺** | **有（1.x 系列不破坏 `v1beta1`）** | 无 | 无 | 有（商业） | 有（云 SLA） |
| **生产采用者** | **Bloomberg / LY Corporation / Alan / NRP** | 研究 + 中小厂 | 广泛 | 长尾 | 云客户 |
| **许可证** | **Apache 2.0** | Apache 2.0 / MIT 风格 | MIT | 商业 | 商业 |
| **团队角色匹配** | 平台/SRE 团队 | AI/算法团队 | 小团队快速接入 | 个人/初创 | 云绑定团队 |

### 5.3 关键对比解读

**Agent Router vs RouteLLM 不是竞争关系，是互补的两层。**

RouteLLM 的定位是「**在两个模型之间做请求级分流**」：它看 query，判断这个 query 是「需要强模型」还是「弱模型够用」，然后路由。核心机制是一个 **cost threshold**（成本阈值）——阈值越高越省钱但质量可能下降，需要用真实流量样本**校准**：

```python
# RouteLLM 的核心用法（成本阈值校准 + 请求路由）
# pip install "routellm[serve,eval]"
from routellm.controller import Controller

client = Controller(
    routers=["mf"],                          # matrix factorization router，官方推荐
    strong_model="gpt-6-sol",                # 强模型
    weak_model="deepseek-v4-chat",           # 弱模型（自托管或便宜模型）
)

# 校准：让 50% 的请求走强模型（用你的真实流量样本，别用公共数据集）
# python -m routellm.calibrate_threshold --routers mf --strong-model-pct 0.5
# → For 50.0% strong model calls for mf, threshold = 0.11593

response = client.chat.completions.create(
    model="router-mf-0.11593",               # router 名 + 阈值写在 model 字段里
    messages=[{"role": "user", "content": "总结这个工单"}],
)
```

RouteLLM 的 `mf` router（矩阵分解，基于 Chatbot Arena 偏好数据训练）在公开基准上给出「**最高降 85% 成本，保 95% GPT-4 水平**」的成绩，且在同性能下比商业路由方案便宜 40% 以上。**但 RouteLLM 不管：凭证管理、限流配额、MCP 网关、多租户、故障转移、可观测性、跨厂商协议翻译。**

**正确的组合是**：Agent Router 做平台层（协议翻译 / 凭证 / 限流 / MCP / 可观测性），RouteLLM 式的请求级路由器作为 Agent Router 的**一个 routing filter**存在。应用层只认 `router-mf-0.11593` 这个模型名，网关在数据面完成「阈值判断 → 强弱模型分流」。这是 2026 年「AI 网关 + 成本路由器」的主流架构形态。

**Agent Router vs LiteLLM Proxy**：LiteLLM 胜在「Python 友好、接入极快、支持的模型多」，是中小团队的第一选择。但它**没有 Kubernetes CRD、没有 API 稳定性承诺、没有 MCP 网关、没有 token 级限流语义**。当你的规模大到需要「平台团队 vs 应用团队」的分工、需要审计每条流的成本与权限时，CRD + Envoy 的组合才顶得上。

**Agent Router vs 云厂商原生网关**：云厂商网关在「单云内」体验最好（IAM 深度集成、PrivateLink、配额）。但一旦你要跨云灾备或混合（自托管 + 外部），云厂商网关就成了瓶颈——**Agent Router 的 16 供应商支持 + 跨厂商翻译 + `forwardProxy`（v1.1.0 PrivateLink 签名修复）正是为混合场景设计的**。

### 5.4 一组延迟与成本的经验数字

| 场景 | 数字 | 来源/说明 |
|------|------|----------|
| Envoy ext-proc 每请求额外开销 | **亚毫秒到低个位数毫秒**（gRPC 本地调用 + JSON 改写） | Envoy external processor 架构决定；`sonic` JSON 解析（v0.5 起切换）进一步降低延迟 |
| 跨厂商翻译代价 | 主要在**内存中的 schema 转换**，无额外网络跳 | 翻译在 ext-proc 内完成，不增加 hop |
| TTFT 抖动消除 | `streamIdleTimeout` 把「静默挂起」的**发现时间从人工介入（分钟级）压到配置的秒数** | v1.1.0 核心价值 |
| 成本节省（路由器路线） | **最高 85%**（保 95% GPT-4 水平）；同性能比商业方案便宜 **>40%** | RouteLLM 公开实验数据（`mf` router，GPT-4/Mixtral 模型对） |
| 缓存读取价差 | Opus 5.5 缓存读取 **$0.20/百万 token** vs 正常输入 **$4**（差 **20 倍**） | 早间 OpenAI/Anthropic 定价战背景；**缓存命中率是网关成本优化的第一大杠杆** |
| 自托管 vs 外部摊销成本 | 自托管 vLLM 约为外部旗舰 API 的 **1/8 量级**（GPU 摊销 + 开源模型） | 经验估算，取决于利用率；80/20 权重划分的前提 |

> **注意**：Agent Router 官方没有发布性能基准（它本身不替换推理引擎，只做流量治理）。上面这些数字里，网关相关的开销是架构推算，成本节省数字来自 RouteLLM 的公开实验与供应商公开定价。**在自己的环境里压测永远是唯一可信的来源**——见第 6 节的硬指标设计。

---

## 6. 6 条 6-12 个月可验证硬指标

每一条都是**今天就能跑代码复现**的，不是行业预测。

### 指标 1：`v1beta1` CRD 向后兼容性（可自动验证）

- **验证方式**：把 v1.0 GA 时 apply 的一组 manifest（5 个 CRD 各一份），在 v1.1.0 控制器上**原样重新 apply**，零修改通过。
- **进阶**：写一个 CI 任务，每次 Agent Router 升级时跑 `kubectl apply --dry-run=server` 校验存量 manifest 兼容性，违反就阻断升级。
- **判断标准**：`kubectl get aiservicebackend -o yaml` 的 `apiVersion` 字段在 1.x 系列恒为 `aigateway.envoyproxy.io/v1beta1`。

### 指标 2：跨供应商 `/tokenize` 一致性误差 < 5%

- **验证方式**：构造 200 条覆盖多语言、多长度、含 JSON 与代码的 prompt，分别走 `/tokenize`（vLLM / Vertex Gemini / Bedrock Converse）与各供应商原生计数接口。
- **判断标准**：同一 prompt 在不同供应商的 token 计数差异 < 5%（分词器差异是物理上限，不可能为 0）。**如果某个供应商偏差 > 15%，说明翻译层有 bug，去提 issue。**

### 指标 3：`streamIdleTimeout` 故障转移成功率

- **验证方式**：起两个 backend，一个真实上游，一个返回 200 但**永不吐字节**的 mock。把 `streamIdleTimeout` 设为 10s。
- **判断标准**：首 token 前的请求应**全部自动故障转移到健康 backend**（配合重试策略），客户端无感知；中途触发的请求返回 504 而非挂死。失败转移耗时 ≈ 10s + 重试开销，远优于人工摘节点。

### 指标 4：`credentialOverride` 多租户隔离

- **验证方式**：两个租户各自在 dynamic metadata 放不同 key（一个有 GPT-6 权限，一个只有廉价模型）。发请求观察各自打到的模型与计费归属。
- **判断标准**：租户 A 的请求**永远**用 A 的凭证与配额，`fallbackToConfigured: true` 时无覆盖凭证的请求回落到共享 key 且可审计。**凭证在 access log 里不出现明文。**

### 指标 5：成本归因链路完整性

- **验证方式**：发 1000 条混合请求，查 OTel 后端能否用 `hostname × route rule × gen_ai.usage.* × modelNameOverride` 四元组重建每条流的美元成本，与供应商账单对账。
- **判断标准**：**对账误差 < 2%**，且 **reasoning token 单列**（v1.0 指标已拆分，若在成本报表里 reasoning 与普通输出混在一起，说明采集配置没对齐 `gen_ai.*` 约定）。

### 指标 6：MCP 授权的「可见 = 可调」一致性

- **验证方式**：配一个 CEL 规则只允许 `db-operator` 角色看到 `prod-db.*` 工具。用一个无该角色的 Agent 会话调 `tools/list`。
- **判断标准**：返回的工具列表里**不含** `prod-db.query`；直接调 `prod-db.query` 被拒。**两个检查必须同时通过**——只验证「调用被拒」是不够的，`tools/list` 泄露工具名本身就是信息泄露与提示词注入的入口。

---

## 7. 6 条 6-12 个月可观察未来信号

### 信号 1：`MCPBackend` 独立 CRD 落地

官方 roadmap 明确：把 MCP 后端配置从 `MCPRoute` 解耦成独立的 `MCPBackend` CRD。**这是 MCP 从「路由配置」走向「后端即一等资源」的信号**。一旦落地，MCP 后端的版本化、健康检查、凭证绑定都会变成独立可管理的对象，MCP 网关的成熟度对齐普通 LLM 后端。

### 信号 2：配额感知路由自动绕开被限流上游

当前 `QuotaPolicy` 还是「被动限流」，roadmap 的下一步是「**主动绕开**」：网关持续观测各供应商的 429/配额余量，**在数据面动态调整权重**，把流量导到还有余量的供应商。这会把「供应商限流导致的部分降级」变成「自动切换、用户无感」。**这是 AI 网关从「流量转发」走向「流量调度」的分水岭。**

### 信号 3：Gateway API Inference Extension 正式化

v1.1.0 依赖的 Inference Extension 是 **v1.0.2**（仍带 alpha 特性）。它定义了 `InferencePool` 与 endpoint picker 语义。**当它进入 beta/GA，自托管推理集群的调度就会标准化**——任何推理引擎（vLLM / SGLang / TensorRT-LLM）只要实现接口，就能被任何符合规范的网关调度。这是 Tier Two Gateway 的标准化前提。

### 信号 4：GenAI 语义约定成为 APM 标配

`AI_GATEWAY_TRACING_SEMCONV=genai` 现在是**可选**的。**6-12 个月内它会成为默认**，并且 Arize Phoenix / Langfuse / OTel Collector 生态会全面按 `gen_ai.*` 建模。**现在就把可观测性对接 `gen_ai.*` 而不是自定义属性，等于提前抹掉了未来的一次迁移。**

### 信号 5：Two-Tier 网关成为企业 AI 平台的标准拓扑

「Tier One 集中治理外部供应商 / Tier Two 治理自托管集群」这个模式目前是 Agent Router 文档里的推荐实践。**随着自托管开源模型（DeepSeek、Qwen）质量追平闭源、企业 GPU 集群规模增长，Two-Tier 会从「推荐」变成「唯一合理的企业拓扑**——因为单一网关无法同时优化「供应商成本」与「集群利用率」这两个目标函数。

### 信号 6：「Agent Router」命名背后的治理重心迁移

更名「Agent Router」、`MCPRoute` 的持续增强、会话级 `backendSelector`——**这些都在说同一件事：流量的治理对象正在从「chat 请求」变成「Agent 会话」**。会话是有状态的、有工具边界的、有越权风险的。**6-12 个月内，我们会看到「Agent 会话的建立-授权-工具发现-调用-审计」全链路被网关化**，而不只是 HTTP 请求转发。这才是「AI 网关运行时层」作为独立栈层的最终形态。

---

## 8. 总结与最佳实践

### 8.1 该用 ✅

- ✅ **平台团队统一 AI 流量入口**：你有 3 个以上产品线、2 个以上供应商、或 1 个以上自托管集群。Agent Router 的 CRD 模型就是为这种「平台 vs 应用」分工设计的。
- ✅ **需要强 API 稳定性承诺的生产系统**：`v1beta1` 在 1.x 系列不变的承诺，是「敢上生产」的门槛。Bloomberg / LY Corporation 已经在前面探过路。
- ✅ **多租户 SaaS 的 BYOK 合规**：`credentialOverride` 把密钥解密与转发移出应用层，安全边界的移动比功能本身重要。
- ✅ **MCP 工具治理**：`tools/list` 与 `tools/call` 同规则 + CEL 授权 + 会话级 `backendSelector`，这是目前最完整的 MCP 边界控制方案。
- ✅ **混合部署（自托管 + 外部）**：Two-Tier 模式 + 跨厂商翻译 + `forwardProxy`，天然支持「自托管优先、外部兜底」的成本结构。

### 8.2 千万别用 ❌

- ❌ **别用它替代请求级成本路由器**：Agent Router 管的是「流量治理」，RouteLLM 式路由器管的是「这个请求该用贵模型还是便宜模型」。**用 Agent Router 的 routing filter 承载路由器，而不是二选一。**
- ❌ **别在迁移第一天就开 16 个供应商**：先接 1 个供应商 + 开启 `modelNameOverride`，验证应用零改动跑通，再逐个加。翻译层是双向的，但你的测试用例不是。
- ❌ **别把 `/tokenize` 当精确计费**：它是输入 token 的**估算**，用于配额治理与容量规划，不是发票。输出 token 仍需按模型历史均值估算。
- ❌ **别用整体超时替代 `streamIdleTimeout`**：整体超时会误杀合理的慢推理；`streamIdleTimeout` 只管「字节间隔」，这才是流式推理的正确失效模型。**两者要一起设**（总超时兜底 + 空闲超时做故障转移）。
- ❌ **别在升 Agent Router 之前不升 Envoy Gateway**：官方支持策略明确要求每个版本构建在最新稳定 Envoy Gateway 之上。**先升 Envoy Gateway，再升 Agent Router**，顺序反了必出兼容问题。
- ❌ **别忽视 reasoning token 的单独计量**：推理模型时代 reasoning token 常占输出成本 40-70%。混在一起统计的成本报表会误导所有成本优化决策。

### 8.3 5 步生产落地 checklist

1. **本地验证（5 分钟）**：`OPENAI_API_KEY=sk-... aigw run`，把一个现有 OpenAI 客户端指向 `http://localhost:1975/v1`，确认零代码改动跑通。**所有迁移评估从这里开始，不从架构图开始。**
2. **单供应商 + 模型虚拟化**：K8s 部署 Tier One，只接一个供应商，但**一定开 `modelNameOverride`**。这是你未来所有「换模型」「灰度」「切供应商」操作的前提，第一天就要建好这层抽象。
3. **加配额与可观测性**：按 token 限流（`cost.source: TokenUsage`），打开 `AI_GATEWAY_TRACING_SEMCONV=genai`，接 OTel Collector，部署随附的 Grafana 面板。**reasoning token 单列**。先有数据，再谈优化。
4. **加故障转移与多供应商**：配 `streamIdleTimeout` + `BackendTrafficPolicy` 重试，加第二个供应商作为 fallback backend。用混沌测试（一个永不吐字节的 mock 后端）验证故障转移真的生效。
5. **加 MCP 治理与成本归因对账**：`MCPRoute` + CEL 授权（默认 Deny），跑「可见 = 可调」一致性测试；最后做一次 `四元组成本归因 vs 供应商账单` 的对账，**误差 < 2% 才算落地完成**。

### 8.4 5 条 best practice

1. **模型名是接口，不是实现。** 应用代码里永远只出现 `modelNameOverride` 的逻辑名。把「选哪个模型」这件事从应用代码里彻底赶出去，它是平台决策，不是业务决策。
2. **限流的单位是 token，不是 RPS。** 一个「总结工单」和一个「多步推理」在 RPS 眼里是一样的，在成本眼里差 50 倍。按 token 限流才是 LLM 的限流。
3. **凭证的层级：云身份 > Secret 引用 > 每请求覆盖 > 明文配置。** 能用 GKE Workload Identity / AWS SigV4 就不要用静态 key；多租户场景用 `credentialOverride` + dynamic metadata，永远不要让密钥明文进应用内存。
4. **流式的失效模型是「静默」，不是「错误」。** 一切超时设计围绕「多久没收到字节」展开，而不是「整个请求多久」。`streamIdleTimeout` + 总超时是两个互补的保险，不是一个替代另一个。
5. **可见性等于可调用性。** MCP 授权规则必须同时覆盖 `tools/list` 与 `tools/call`。Agent 发现了一个工具却调不了，会产生大量无效推理步骤，并把拒绝信息暴露成提示词注入面。

---

## 写在最后：模型降价是客户的胜利，但红利在网关那一层

2026 年 9 月 23 日早上，OpenAI 与 Anthropic 同日降价的新闻刷屏。但如果你把视角拉高一层，会发现一件更有意思的事：**模型层正在不可逆地走向「水电煤」——同质化、按层位定价、价格持续下探**。GPT-6 Sol/Luna 对半砍、Opus 5.5 缓存读取降 60%，都只是这条曲线上的两个点。

当模型层变成水电煤，**「谁能更精细地调度这些水电煤」就成了新的核心竞争力**。Agent Router（原 Envoy AI Gateway）在这个时间点 GA，不是巧合：它选的正是「**把 AI 流量变成可治理、可计量、可故障转移的一等基础设施**」这个位置。早上的新闻讲的是「单价」，这篇文章讲的是「**单价 × 用量 × 可用性**」这个乘积——而后者，才是每个月实际出现在账单上的数字。

Envoy 的维护者们在 GA 发布说明里写了一句很体面的话：**「1.0 belongs to everyone who got us here.」** 但对工程团队来说更有用的是另一句：**「Your manifests from yesterday apply tomorrow.」** 在一个每三个月就换一批新名词的行业里，**「稳定」本身就是最稀缺的功能**。

**三个长期判断：**

1. **AI 网关运行时层会成为 2026 H2 的独立栈层** —— 与数据基础设施、Agent runtime、合规可观测性并列。判断依据：它是唯一同时解决「成本（token 限流 + 路由）」「安全（凭证 + MCP 授权）」「可用性（流式故障转移）」三个问题的层，而这三个问题在模型同质化后只会更尖锐。**RouteLLM 的 85% 成本节省实验证明了这个层的经济价值是真实且可复现的**，不是卖点。
2. **Two-Tier 网关拓扑会从「推荐实践」变成「唯一合理的企业拓扑」** —— 自托管开源模型质量追平闭源 + 企业 GPU 集群规模增长，会让「外部供应商治理」与「自托管调度」成为两个目标函数完全不同的优化问题。**单一网关无法同时优化两者，就像单一仓库无法同时优化 OLTP 与 OLAP。**
3. **「Agent Router」的更名是一次提前卡位** —— MCP 网关、会话级后端选择、工具级授权，全都是面向 Agent 而非 chat 的能力。**当流量从「一次请求」变成「一个有状态会话」，治理对象就必须从 HTTP 请求升级到会话。** 谁先把这个抽象做对，谁就是 Agent 时代的 Envoy——而它本来就是 Envoy。

---

**数据来源**：Agent Router（原 Envoy AI Gateway）v1.0.0 / v1.1.0 官方 release notes（GitHub `theagentrouter/agent-router`，旧 `envoyproxy/ai-gateway` 链接自动重定向）；项目 README（two-tier 网关模式与更名说明）；RouteLLM（lm-sys/RouteLLM）README 与论文《RouteLLM: Learning to Route LLMs with Preference Data》（arXiv 2406.18665）；OpenAI GPT-6 Sol/Luna 与 Anthropic Opus 5.5 公开定价（2026-09-23）；Envoy Gateway / Gateway API Inference Extension 项目文档。本文所有 CRD 字段以官方 release notes 与文档为准，部署前请按 `aigw run` 本地路径验证一遍。
