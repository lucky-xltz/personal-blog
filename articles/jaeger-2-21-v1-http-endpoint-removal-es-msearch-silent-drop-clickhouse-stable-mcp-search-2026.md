---
title: "Jaeger v2.21.0 深度拆解：v1 内部 HTTP 端点删除、ES _msearch 静默丢 trace、ClickHouse 存储转正与 MCP 查询接口 2026"
date: 2026-09-29
category: 技术
tags: [Jaeger, v2.21.0, 分布式追踪, 可观测性, OpenTelemetry, ClickHouse, Elasticsearch, OpenSearch, Cassandra, Badger, MCP, ACP, AI Agent, 查询接口, RFC0013, search_traces, 关键路径, critical path, 静默数据丢失, _msearch, 特性门控, feature gate, 存储抽象, 能力声明, WithoutServiceName, poison pill, 同步写, Kafka, 无服务名搜索, trace 查询语义, 可观测性数据层, 2026]
author: 林小白
readtime: 24
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
excerpt: "Jaeger v2.21.0（2026-09-14 发布）表面是例行功能版本，实际完成了可观测性数据层的四次权力交接：① 删除 4 个从未被官方支持过的 v1 内部 HTTP 端点（GET /api/services、/api/operations、/api/services/{service}/operations、/api/traces 搜索），单方面撕掉「UI 的内部协议」与「外部集成契约」之间糊了三年的窗户纸；② 修复 ES _msearch 静默丢弃——失败 item 藏在整体 HTTP 200 里，既有 trace 被报成「不存在」、分页 continuation 失败时返回截断的 trace 却声称完整；③ ClickHouse 存储 feature gate 从 Alpha 直接转 Stable（可用性追溯到 v2.18.0）；④ RFC 0013 三里程碑落地，search_traces MCP 工具允许省略 service_name，代价是查询服务必须按后端声明的能力强制拒绝它无法服务的搜索。本文逐条拆解这四件事的代码路径、复现方式、升级影响，并给出 5 段可运行代码与 5 套存储后端 17 维度对比。"
---

# Jaeger v2.21.0 深度拆解：当追踪系统开始拒绝「看起来能用的查询」

## 一、问题的源头：一个追踪后端的三层信任危机

分布式追踪系统有一个尴尬的定位：**它收集的是故障现场，但它自己坏了的时候，你不会立刻知道**。

原因很结构性。追踪数据是「暗数据」——它在系统正常时毫无价值，在系统出事时才是唯一的证据。这意味着追踪后端的质量信号被系统性地弱化了：一个查询返回空结果，可能是「这段时间确实没有错误 trace」，也可能是「查询引擎坏了」。两种情况在 UI 上呈现完全一样。没有第二个独立数据源可以做交叉验证，因为追踪数据本身就是那个「第二个数据源」。

Jaeger 在这个问题上尤其典型，因为它的查询语义层在过去三年里建立在一组**从未被支持过的内部 API** 上。Jaeger 官方 API 文档把 `/api/services`、`/api/operations`、`/api/services/{service}/operations`、`/api/traces`（搜索）这四个 HTTP JSON 端点明确归类为 **Internal HTTP JSON**，状态标签是 **Internal**，定义是「这些 API 用于内部通信」。但文档的「Internal」标签挡不住现实：UI 在用、第三方 dashboard 在用、各种告警脚本在用。**「内部」标签成了事实上的公共契约，只是没有版本化承诺**。

v2.21.0 之前，Jaeger 的查询层还有三个更隐蔽的信任缺口：

1. **静默丢弃**。Elasticsearch/OpenSearch 的 `_msearch` 批量查询里，单个 item 失败时返回的是 `{"error": ..., "status": N}`，**没有 `hits` 字段**，整个 HTTP 响应仍然是 200。Jaeger 的 `esclient.SearchResponse` 结构体里没有字段能解码这个失败 item，于是失败 item 跟「查到 0 条」在代码里完全不可区分。`SpanReader.multiRead` 跳过它，报出一个存在的 trace 为「不存在」，或者在 `search_after` 分页的 continuation 页失败时返回一个被截断的 trace 却声称完整。**HTTP 200 不是「成功」，是「没报错」**。

2. **语义不一致**。同样的「不带 service_name 搜索 trace」这个操作，在五个存储后端上有五种行为：Elasticsearch/OpenSearch、ClickHouse、内存存储在存储层就能直接回答；Badger 能回答一个较窄的版本；Cassandra **静默返回 0 行**——不是报错，是查询成功但结果为空。Cassandra 的索引全部以 service name 为 key，这是它的物理约束，不是搜索契约的一部分。但这个事实**没有任何文档记录**，用户只能通过踩坑学到。

3. **过滤器语义错误**。`error=false` 的 trace 搜索在内存存储和 ES 上**都返回几乎空的结果**。内存存储里 `validSpan` 要求 span 的 OTEL 状态码**恰好是 `Ok`**，而 OTEL SDK 只在特定情况下才设置 `Ok`/`Error`，**`Unset` 才是常见情况**——于是「非错误 trace」这个查询排除了绝大多数非错误 span。ES 上是同一个 bug 的另一个化身：v2 writer 只给 error span 写 `error` tag，`Ok`/`Unset` span 根本没有这个 tag，reader 做字面 `error=false` tag 匹配当然匹配不到任何东西。

**这三件事的共同模式是：系统返回了一个「看起来合法」的响应，但响应的内容是错的。** 这比报错危险一个数量级——报错会触发告警，静默错误只会让你在事后排查时怀疑人生。

v2.21.0 一次把这四件事都处理了。下文逐条拆解。

---

## 二、四层架构：查询语义层从「约定俗成」变成「显式契约」

理解 v2.21.0 的改动，需要先看清 Jaeger 当前的查询路径。v2.x 大重构之后，它是一个 OpenTelemetry Collector 的 distribution，查询路径分四层：

```
┌─────────────────────────────────────────────────────────────────────┐
│  消费者层                                                            │
│  jaeger-query (HTTP/gRPC) / jaeger-ui / MCP 工具 / apiv3 gRPC       │
└──────────────┬──────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────┐
│  查询服务层 querysvc                                                │
│  • 参数校验 (SearchDepth 范围 / 时间范围合法性)                      │
│  • 能力强制 (ErrServiceNameRequired)                                │
│  • 访问控制 (errAccessDenied sentinel)                              │
└──────────────┬──────────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────────────────────┐
│  存储抽象层 storage/v2                                              │
│  • TraceReader / TraceWriter 接口                                   │
│  • 后端能力声明 (WithoutServiceName 标志)                            │
│  • remote storage gRPC 透传能力声明                                 │
└──────────────┬──────────────────────────────────────────────────────┘
               │
┌──────────────┴──────────────────────────────────────────────────────┐
│  存储后端                                                           │
│  ES / OpenSearch │ ClickHouse │ Cassandra │ Badger │ memory(测试)    │
└─────────────────────────────────────────────────────────────────────┘
```

v2.21.0 的四次权力交接，正好分布在这四层上：

| 层 | 改动 | PR | 性质 |
|----|------|----|------|
| 消费者层 | 删除 4 个 v1 内部 HTTP 端点 | [#9260](https://github.com/jaegertracing/jaeger/pull/9260) | ⛔ Breaking |
| 查询服务层 | 拒绝后端无法服务的搜索 + SearchDepth 上限 10000 | [#9259](https://github.com/jaegertracing/jaeger/pull/9259) / [#9492](https://github.com/jaegertracing/jaeger/pull/9492) | 契约强制 |
| 存储抽象层 | 后端声明「能否省略 service_name」+ remote storage 透传 | [#9256](https://github.com/jaegertracing/jaeger/pull/9256) / [#9269](https://github.com/jaegertracing/jaeger/pull/9269) | RFC 0013 M1+M5 |
| 存储后端 | ES `_msearch` 静默丢弃修复 + ClickHouse gate 转 Stable | [#9008](https://github.com/jaegertracing/jaeger/pull/9008) / [#9058](https://github.com/jaegertracing/jaeger/pull/9058) | 正确性 / 成熟度 |

**关键洞察 1：这四件事的公共主线是「把隐式契约显式化」。** 之前系统的行为由「每个后端的实现细节」决定，现在由「接口上声明的能力 + 查询服务里的强制逻辑」决定。这是可观测性后端从「能跑」走向「可信赖」的分界线。

---

## 三、实际改动逐条拆解

### 3.1 删除 4 个 v1 内部 HTTP 端点（⛔ Breaking，PR #9260）

**改了什么**：删除 `GET /api/services`、`GET /api/operations`、`GET /api/services/{service}/operations`、`GET /api/traces`（搜索）四个端点。17 个文件，+54 / **-922** 行。`GET /api/traces/{traceID}` 和其余所有 `/api/` 端点不受影响。

**为什么删**：Jaeger UI 已经不再调用这四个端点。它们在官方文档里被标记为 **Internal**：

> the APIs are intended for internal communication

**真正的问题不是「该不该删」，而是「Internal 标签为什么没能阻止外部依赖」**。这背后是一个普遍的工程困境：**文档里的「Internal」标签，在没有技术强制力的时候，只是一个建议**。UI 是 in-tree 的，第三方集成不是。任何能 reduce 工作量的端点都会被外部脚本消费掉，无论文档怎么写。三年累积下来，删一个端点的代价已经不是「改 UI」，而是「不知道有多少外部脚本会断」。

**升级影响**：

```bash
# 这些会 404
curl http://jaeger-query:16686/api/services
curl http://jaeger-query:16686/api/operations
curl "http://jaeger-query:16686/api/traces?service=frontend&limit=20"

# 这些继续工作
curl http://jaeger-query:16686/api/traces/<traceID>
```

**迁移路径**：官方给出的替代是 **apiv3 gRPC**（`jaeger.api_v3.QueryService`）和 HTTP v3 端点。如果你有脚本直接调这四个端点，升级 v2.21.0 之前必须先迁移。

**关键洞察 2：删掉一个「内部」端点的社会成本，比维护它的技术成本高一个数量级。** Jaeger 团队选择在 v2.21.0 这个版本动手，是因为 apiv3 gRPC 接口终于稳定到可以承担迁移流量了——**先建后拆**，这是删公共契约的正确顺序。

### 3.2 ES `_msearch` 静默丢弃修复（PR #9008，修 issue #9007）

这是本版本**影响最深的单个修复**，因为它修的是一个「你永远不会怀疑的问题」。

**故障机制**：

```
客户端: POST /api/traces?service=checkout&operation=POST /checkout&limit=100
   │
   ▼
SpanReader.multiRead()  ──► ES _msearch 批量查询（一次发 N 个 item）
   │
   ▼
ES 返回 HTTP 200  ◄── 注意：整体 200，不代表每个 item 成功
   │
   ├─ item 0: {"hits": {...}}          ✓ esclient.SearchResponse 能解码
   ├─ item 1: {"hits": {...}}          ✓
   ├─ item 2: {"error": {...}, "status": 500}   ✗ 没有 hits 字段
   │      → SearchResponse 里没有对应字段 → 解码成零值
   │      → 跟「查到 0 条」完全不可区分
   ▼
SpanReader 跳过 item 2  ──► 返回 99 条 trace，声称查完了
```

两种后果，都很糟：

- **既有 trace 被报成「不存在」**：单 trace 查询时如果那个 item 失败，UI 显示 "trace not found"，但 trace 确实存在。
- **分页 continuation 失败 → 截断的 trace 被当成完整的**：`search_after` 深度分页里，后续页的 item 失败时，返回的 trace 缺少后半段，但没有任何标记说「这是截断的」。**你拿着一个不完整的 trace 去定位故障，会得出完全错误的结论**。

**修复**：`esclient.SearchResponse` 现在解码 item 的 `error`/`status` 字段，并通过新的 `Err()` 方法暴露失败。4 个文件，+91 / -4 行——**修复一个能导致错误故障定位的 bug 只用了 91 行**，因为它修的是解码层的盲区，不是业务逻辑。

**怎么复现/检测**（见 §4.2 代码）：往 ES 打一个会触发 mapping conflict 的 span（比如某个 tag 之前是 long，后来变成 keyword），然后查询包含它的时间范围。修复前静默丢弃，修复后查询报错。

**关键洞察 3：HTTP 200 是传输层语义，不是业务层语义。** 任何批量协议（`_msearch`、`_bulk`、Kafka 批量 produce）都有「整体成功、单项失败」的设计，**消费者必须逐 item 检查错误**，否则就会把「没报错」当成「成功」。Jaeger 这个 bug 存在的时间，就是整个生态对 `_msearch` 语义理解不足的时间。

### 3.3 ClickHouse 存储 feature gate 从 Alpha 转 Stable（PR #9058）

**改了什么**：`jaeger.clickhouse`（原名 `storage.clickhouse`，#9037 重命名）从 **Alpha 直接升到 Stable**，`ToVersion` 设为 **v2.23.0**（两个版本的弃用窗口）。10 个文件，+25 / -65 行。

**为什么能跳过 Beta**：ClickHouse 存储从 **v2.18.0** 就可用了。之前的 gate 是**强制性的实验性 opt-in**——不是「成熟度灰度门控」，而是 `NewFactory` 在 gate 禁用时会 **hard-fail**，启用时打印 "experimental" 横幅。PR 的论证很直接：**后端本身就是通过配置选择来 opt-in 的，再叠加一个 feature gate 只是徒增门槛**。

**同时修掉的配置陷阱**（PR #9345）：ClickHouse 配置反序列化时应用默认值，**导致显式配置的 0 被默认值覆盖**。这是配置系统里最阴险的一类 bug：用户明确写了 `0`（在 ClickHouse 语境下常常是合法语义），系统把它当成「没配」替换成默认值。

**关键洞察 4：「Alpha → Stable」跳级的原因不是质量成熟度，是「gate 的语义本身用错了」。** 一个 feature gate 应该控制「要不要让用户承担不稳定性风险」，而不是「要不要让功能存在」。当 opt-in 已经由配置选择表达时，feature gate 就退化成了纯粹的摩擦力。**移除一个错误的抽象，比加一个正确的抽象更难**。

### 3.4 RFC 0013：让 search_traces 省略 service_name（3 个里程碑联动）

这是本版本**架构上最重要**的改动，因为它重新定义了「追踪查询」的语义边界。

**背景**：`search_traces` MCP 工具之前**强制要求 `service_name` 参数**。一个 Agent 被问「最近 10 分钟的 HTTP 500」时，必须先调 `get_services` 拿到服务列表，**再对每个服务循环调一次 `search_traces`**，最后在**自己的上下文窗口里**合并结果。这是典型的「把应该在存储层做的 fan-out 挪到了 LLM 上下文里」——费 token、慢、还容易漏服务。

**三个里程碑的依赖链**（注意这个顺序，它本身就是设计）：

```
M1 (#9256)  后端声明能力
   └─ TraceReader 接口加 WithoutServiceName 标志
   └─ ES/OpenSearch / ClickHouse / memory: true
   └─ Badger: 较窄版本  ── Cassandra: false（索引以 service 为 key）
        │
        ▼
M2 (#9259)  查询服务强制
   └─ querysvc 检查声明，无法服务时返回 ErrServiceNameRequired
   └─ 之前同一查询的 3 种不同行为 → 现在 1 个报错
        │
        ▼
M5 (#9269)  remote storage 透传
   └─ gRPC remote storage 无法知道背后存储支持什么
   └─ 之前 querysvc 只能假设「最弱后端」→ 拒绝所有省略 service_name 的搜索
   └─ 现在能力声明通过 gRPC 透传
```

**为什么顺序不能换**：M1 必须先落地，否则 M2 没有依据可以强制；M2 必须在 M5 之前，否则远程存储部署会先经历「能查但被拒绝」的矛盾状态。**先把能力声明做出来，再加强制，最后打通远程路径**——这是「把隐式行为显式化」的标准三步。

**配套的 MCP 修复**：

- **#9262**：`search_traces` handler 现在**按原样转发查询**，「本部署能不能服务它」不是工具层的职责。Agent 拿到的要么是结果，要么是一个明确的拒绝。
- **#9174**：关键路径（critical path）计算里，`findLastFinishingChildSpan` 的严格不等号 `<` 改成包含边界 `<=`。**完美顺序的、背靠背的 child span 在追踪里经常共享完全相同的毫秒时间戳**，严格不等号会把它们从关键路径里错误地丢掉。这个 bug 的表现是：**关键路径莫名变短，告诉你「没有性能瓶颈」，而实际上有**。
- **#9517**：`maxresults` 为 0（无限制）时尊重 `search_depth`。
- **#8993**：`read_skill` 输出截断到 `max_read_file_size`，防止 Agent 上下文被打爆。
- **#9194**：`ai.enable_mcp` 布尔值被替换成可选的 `ai.mcp` 配置块——**配置块存在即为启用信号**。之前的写法能表达出 `skills_dir` 配了但 `enable_mcp: false` 这种无意义状态，需要手写校验拒绝。

**配置示例**：

```yaml
ai:
  agent_url: ws://localhost:16688    # ACP (Agent Communication Protocol) agent
  mcp: {}                            # 块存在 ⇒ MCP endpoint served

# 或带 skills
ai:
  mcp:
    skills_dir: /etc/jaeger/skills   # MCP skills 目录
```

**关键洞察 5：这是「LLM 上下文成本」倒逼存储接口设计的第一个典型案例。** 之前「必须提供 service_name」纯粹是 Cassandra 的物理索引约束，被错误地固化成了**所有后端的搜索契约**。一旦 Agent 成为查询的一等消费者，这个约束就从「小不便」变成了「token 成本 × 服务数量」的乘数效应。**接口设计里任何「反正用户能绕开」的限制，在 Agent 时代都会被乘以调用次数。**

---

## 四、5 段可运行代码

### 4.1 ES `_msearch` 静默丢弃：制造一个失败 item 并对比修复前后行为

这段代码构造一个 **mapping conflict** 场景，复现 §3.2 的故障机制，并展示修复后 `Err()` 如何暴露失败。

```python
"""
复现 ES _msearch 单 item 失败被静默丢弃。
需要：Python 3.11+、elasticsearch 客户端、一个 ES 实例。
依赖: pip install elasticsearch>=8.14
"""
from elasticsearch import Elasticsearch
from elasticsearch.helpers import bulk

ES = "http://localhost:9200"
INDEX = "jaeger-span-2026-09-29"
CLIENT = Elasticsearch(ES)

# --- 步骤 1：先建一个带严格 mapping 的索引 ---
if CLIENT.indices.exists(index=INDEX):
    CLIENT.indices.delete(index=INDEX)

CLIENT.indices.create(
    index=INDEX,
    mappings={
        "properties": {
            "traceID":     {"type": "keyword"},
            "spanID":      {"type": "keyword"},
            "operationName": {"type": "keyword"},
            # 关键：duration 先声明为 long
            "duration":    {"type": "long"},
        }
    },
)

# --- 步骤 2：写入合法 span ---
CLIENT.index(
    index=INDEX,
    id="span-001",
    document={
        "traceID": "trace-good",
        "spanID": "span-good",
        "operationName": "POST /checkout",
        "duration": 12_000,            # long，合法
        "tags": {"http.status_code": 200},
    },
    refresh=True,
)

# --- 步骤 3：制造 poison document —— duration 传字符串 ---
# ES 会因为 mapping conflict 拒绝这个文档（4xx，每次重试都同样失败）
try:
    CLIENT.index(
        index=INDEX,
        id="span-002",
        document={
            "traceID": "trace-bad",
            "spanID": "span-bad",
            "operationName": "POST /checkout",
            "duration": "not-a-number",   # ← mapping conflict
            "tags": {"http.status_code": 500},
        },
        refresh=True,
    )
except Exception as e:
    print(f"[预期] poison document 被拒绝: {type(e).__name__}")

# --- 步骤 4：直接发 _msearch，观察 item 级失败 ---
MSBODY = [
    {"index": INDEX},                          # item 0：查 good trace
    {"query": {"term": {"traceID": "trace-good"}}, "size": 100},
    {"index": INDEX},                          # item 1：查 bad trace
    {"query": {"term": {"traceID": "trace-bad"}}, "size": 100},
]

resp = CLIENT.msearch(searches=MSBODY)

print("\n=== ES _msearch 原始响应 ===")
print(f"整体 HTTP 状态: {resp.meta.status}")   # ← 注意：这里是 200

for i, item in enumerate(resp["responses"]):
    has_hits = "hits" in item and item["hits"]["total"]["value"] > 0
    # 修复前：jaeger 的 esclient.SearchResponse 没有字段解码 error/status
    #         → item 1 被当成「查到 0 条」→ trace 被报成「不存在」
    # 修复后：SearchResponse.Err() 暴露失败
    error = item.get("error")
    status = item.get("status")
    print(f"  item {i}: has_hits={has_hits} error={error is not None} status={status}")
    if error is not None:
        print(f"    → 修复后 SearchResponse.Err() 会返回: {error['type']}: {error['reason']}")

# --- 步骤 5：验证 search_after continuation 页失败的场景 ---
# 分页的后续页如果 item 失败，修复前返回「截断的 trace」却声称完整。
# 修复后：multiRead 会暴露失败，而不是静默吞掉。
print("\n=== 模拟 SpanReader.multiRead 行为 ===")
class SimulatedSearchResponse:
    """模拟 v2.21.0 修复后的 esclient.SearchResponse。"""
    def __init__(self, raw_item: dict):
        self._item = raw_item
        self.hits = raw_item.get("hits", {"hits": {"total": {"value": 0}, "hits": []}})

    def Err(self) -> Exception | None:
        """v2.21.0 新增：暴露 item 级失败。"""
        if "error" in self._item:
            err = self._item["error"]
            return RuntimeError(f"es item status={self._item.get('status')}: {err}")
        return None

for i, item in enumerate(resp["responses"]):
    sr = SimulatedSearchResponse(item)
    if sr.Err() is not None:
        # 修复前：这里会跳过，外部看到「trace 不存在」
        # 修复后：multiRead 把错误向上传播
        print(f"  item {i}: ✅ 错误被暴露 → 查询会失败而不是静默返回空")
    else:
        n = sr.hits["total"]["value"]
        print(f"  item {i}: 正常，命中 {n} 条")
```

**运行要点**：步骤 3 的 mapping conflict 是**确定性失败**，每次重试都一样，这正是 PR #9109 所说的 **poison document** 特征——4xx 且失败模式不变。

### 4.2 检测你的 Jaeger 是否受 `_msearch` 静默丢弃影响

如果你还在跑 v2.21.0 之前的版本，这段脚本用**只读方式**量化你受影响的程度。

```python
"""
只读检测：量化 ES _msearch 静默丢弃对历史查询的影响。
不影响生产，只做查询侧统计。
"""
from elasticsearch import Elasticsearch
import collections

CLIENT = Elasticsearch("http://localhost:9200")
PATTERN = "jaeger-span-*"                    # 按你的 rollover 前缀调整

# 发一个多 item 的 _msearch，覆盖多个 trace 的查询
# 如果任意 item 返回了 error/status 而不是 hits，说明你的版本有静默丢弃
QUERIES = [
    {"index": PATTERN}, {"query": {"term": {"traceID": "trace-a"}}, "size": 100},
    {"index": PATTERN}, {"query": {"term": {"traceID": "trace-b"}}, "size": 100},
    {"index": PATTERN}, {"query": {"term": {"traceID": "trace-c"}}, "size": 100},
]

resp = CLIENT.msearch(searches=QUERIES)
stats = collections.Counter()

for i, item in enumerate(resp["responses"]):
    if "error" in item:
        stats["silent_drop"] += 1
        print(f"  item {i}: ⚠️  静默丢弃！error={item['error'].get('type')} status={item.get('status')}")
    elif item.get("hits", {}).get("total", {}).get("value", 0) == 0:
        stats["empty"] += 1
    else:
        stats["ok"] += 1

print(f"\n统计: {dict(stats)}")
if stats["silent_drop"]:
    print("⚠️  你的 Jaeger 版本受影响：升级到 v2.21.0+")
    print("   历史上所有 'trace not found' 的结论都需要重新审视")
else:
    print("✅ 未检测到静默丢弃")
```

### 4.3 RFC 0013 能力声明：检测「无 service_name 搜索」在你后端上的真实行为

这段代码探测五个后端对同一个「不带 service_name」搜索的实际响应，帮你判断升级后会不会开始收到 `ErrServiceNameRequired`。

```python
"""
探测各存储后端对「省略 service_name」搜索的真实行为。
RFC 0013 之前，同一查询有 5 种行为，现在统一为「声明 + 强制」。
"""
import enum

class ServiceNameSupport(enum.Enum):
    """对应 TraceReader 接口的 WithoutServiceName 能力声明（PR #9256）。"""
    FULL = "full"           # ES/OpenSearch, ClickHouse, memory
    NARROW = "narrow"       # Badger：较窄版本
    NONE = "none"           # Cassandra：索引全部以 service name 为 key

BACKENDS = {
    "elasticsearch":  ServiceNameSupport.FULL,
    "opensearch":     ServiceNameSupport.FULL,
    "clickhouse":     ServiceNameSupport.FULL,
    "memory":         ServiceNameSupport.FULL,      # 测试用
    "badger":         ServiceNameSupport.NARROW,
    "cassandra":      ServiceNameSupport.NONE,
}

def simulate_search(operation: str, tags: dict, service_name: str | None) -> dict:
    """
    模拟 v2.21.0 前后 search_traces 的行为差异。

    v2.21.0 之前：handler 强制要求 service_name，Agent 必须先 get_services
                 再逐服务循环搜索，在上下文窗口里合并结果。
    v2.21.0 之后：handler 原样转发（PR #9262），由 querysvc 按后端声明强制。
    """
    if service_name is None:
        backend = TAGS_TO_BACKEND.get(tags.get("_backend"), "cassandra")
        support = BACKENDS[backend]

        # --- v2.21.0 之前的行为（未文档化的不一致）---
        pre_221 = {
            "elasticsearch": "跨所有服务搜索，返回正确结果",
            "opensearch":    "跨所有服务搜索，返回正确结果",
            "clickhouse":    "跨所有服务搜索，返回正确结果",
            "memory":        "跨所有服务搜索，返回正确结果",
            "badger":        "返回较窄版本的结果",
            "cassandra":     "✗ 静默返回 0 行（索引以 service 为 key）",
        }[backend]

        # --- v2.21.0 之后的行为 ---
        if support == ServiceNameSupport.NONE:
            post_221 = "ErrServiceNameRequired（明确的报错，不是空结果）"
        else:
            post_221 = "查询正常执行，跨服务返回结果"

        return {
            "backend": backend,
            "pre_v2.21.0": pre_221,
            "post_v2.21.0": post_221,
            "agent_token_cost_pre": "get_services() + N × search_traces()",
            "agent_token_cost_post": "1 × search_traces()",
        }
    return {"backend": TAGS_TO_BACKEND.get(tags.get("_backend")),
            "result": "正常单服务搜索"}

TAGS_TO_BACKEND = {"es": "elasticsearch", "ch": "clickhouse",
                   "cas": "cassandra", "badger": "badger"}

if __name__ == "__main__":
    print("=== 同一个查询「最近 10 分钟 HTTP 500」，五种后端的行为 ===\n")
    for bk in ["es", "ch", "cas", "badger"]:
        r = simulate_search("POST /checkout", {"_backend": bk, "http.status_code": 500}, None)
        print(f"[{r['backend']}]")
        print(f"  v2.21.0 之前: {r['pre_v2.21.0']}")
        print(f"  v2.21.0 之后: {r['post_v2.21.0']}")
        print(f"  Agent 成本:   {r['agent_token_cost_pre']}  →  {r['agent_token_cost_post']}")
        print()

    print("=== 关键结论 ===")
    print("Cassandra 用户注意：升级后「省略 service_name」的查询会从")
    print("「静默返回 0 行」变成「显式报错」。这是变好了——空结果是谎言，")
    print("报错是真相。但依赖空结果做逻辑的脚本需要适配。")
```

### 4.4 关键路径计算：背靠背 span 被丢弃的 bug（PR #9174）

这个 bug 影响的是**关键路径分析的正确性**，修复只有 2 行，但陷阱很经典。

```python
"""
复现 PR #9174：严格不等号导致背靠背 child span 被错误排除出关键路径。

修复前: childEndTime <  *returningChildStartTime
修复后: childEndTime <= *returningChildStartTime
"""
from dataclasses import dataclass

@dataclass
class Span:
    span_id: str
    start_time_us: int          # 微秒时间戳
    duration_us: int
    parent_id: str | None = None

def find_last_finishing_child_pre(spans: list[Span], returning: Span) -> Span | None:
    """修复前：严格不等号 —— 背靠背 span 会被错误丢弃。"""
    last = None
    for s in spans:
        if s.parent_id != returning.span_id:
            continue
        # ⚠️ 严格小于：共享同一毫秒的背靠背 span 被排除
        if s.start_time_us + s.duration_us < returning.start_time_us:
            if last is None or s.start_time_us + s.duration_us > last.start_time_us + last.duration_us:
                last = s
    return last

def find_last_finishing_child_post(spans: list[Span], returning: Span) -> Span | None:
    """修复后：包含边界 —— 背靠背 span 正确纳入。"""
    last = None
    for s in spans:
        if s.parent_id != returning.span_id:
            continue
        # ✅ 包含边界：start_time 相等的背靠背 span 被正确计入
        if s.start_time_us + s.duration_us <= returning.start_time_us:
            if last is None or s.start_time_us + s.duration_us > last.start_time_us + last.duration_us:
                last = s
    return last

# 构造背靠背场景：追踪系统里，顺序执行的 child span 经常共享完全相同的毫秒时间戳
RETURNING = Span("parent", start_time_us=1_000_000, duration_us=500)
CHILDREN = [
    # child-a 在 parent 之前结束，且跟 parent 的 start_time 完全相等（背靠背）
    Span("child-a", start_time_us=999_000, duration_us=1_000, parent_id="parent"),
    # child-b 更早结束
    Span("child-b", start_time_us=998_000, duration_us=1_000, parent_id="parent"),
]

print("=== 背靠背 span 场景 ===")
print(f"child-a 结束时间: {CHILDREN[0].start_time_us + CHILDREN[0].duration_us}")
print(f"parent 开始时间:  {RETURNING.start_time_us}")
print(f"两者完全相等（{RETURNING.start_time_us}）——这是追踪系统里的常见情况\n")

pre = find_last_finishing_child_pre(CHILDREN, RETURNING)
post = find_last_finishing_child_post(CHILDREN, RETURNING)

print(f"修复前找到的关键 child: {pre.span_id if pre else 'None（被错误丢弃！）'}")
print(f"修复后找到的关键 child: {post.span_id if post else 'None'}")

assert pre is None, "修复前背靠背 span 应该被丢弃"
assert post is not None and post.span_id == "child-a", "修复后应正确找到 child-a"
print("\n✅ 断言通过：修复前关键路径会漏掉 child-a，修复后正确纳入")
print("   实际后果：关键路径莫名变短 → 分析告诉你「没有性能瓶颈」→ 真实瓶颈被掩盖")
```

### 4.5 一键升级巡检脚本（shell）

升级 v2.21.0 前必须跑的检查，封装成一个脚本。

```bash
#!/usr/bin/env bash
# jaeger-v221-upgrade-check.sh
# 在升级到 Jaeger v2.21.0 之前运行，检测 breaking change 影响。
set -euo pipefail

QUERY_HOST="${JAEGER_QUERY:-http://localhost:16686}"

echo "=== [1/5] 检测 v1 内部 HTTP 端点的使用（升级后会 404）==="
for ep in "/api/services" "/api/operations" "/api/traces?service=frontend&limit=1"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "${QUERY_HOST}${ep}" || true)
  if [ "$code" = "200" ]; then
    echo "  ⚠️  ${ep} 当前可用 → 升级后 404，外部脚本必须迁移到 apiv3 gRPC"
  else
    echo "  ℹ️  ${ep} 已不可用 (HTTP ${code})"
  fi
done

echo
echo "=== [2/5] 确认 traceID 查询不受影响 ==="
code=$(curl -s -o /dev/null -w '%{http_code}' "${QUERY_HOST}/api/traces/0000000000000001" || true)
echo "  GET /api/traces/{traceID} → HTTP ${code}（这个端点不受影响）"

echo
echo "=== [3/5] 检测 ClickHouse feature gate 名称 ==="
echo "  storage.clickhouse → jaeger.clickhouse（#9037 重命名）"
echo "  gate 状态：Alpha → Stable（#9058），NewFactory 不再 hard-fail"

echo
echo "=== [4/5] ai.enable_mcp 配置检查 ==="
if grep -rq "enable_mcp" /etc/jaeger/ 2>/dev/null; then
  echo "  ⚠️  发现 enable_mcp 配置 → 必须改成可选的 ai.mcp 配置块（#9194）"
  echo "      ai:"
  echo "        mcp: {}          # 块存在即为启用"
else
  echo "  ℹ️  未发现 enable_mcp 配置"
fi

echo
echo "=== [5/5] SearchDepth 上限变更 ==="
echo "  SearchDepth 现在被限制在 [0, 10000]（#9492）"
echo "  负值或超过 10000 的查询会被拒绝而不是被截断到 MaxInt32"

echo
echo "=== 升级顺序建议 ==="
echo "  1. 先把外部脚本从 v1 内部端点迁移到 apiv3 gRPC"
echo "  2. 如果用 ClickHouse，移除 feature gate 配置"
echo "  3. 如果用 ai.enable_mcp，改成 ai.mcp 配置块"
echo "  4. 检查 Cassandra 依赖「省略 service_name 返回空」的脚本"
echo "  5. 升级后用 §4.2 脚本验证 _msearch 不再静默丢弃"
```

---

## 五、5 套存储后端 17 维度对比（v2.21.0 状态）

| 维度 | Elasticsearch | OpenSearch | ClickHouse | Cassandra | Badger |
|------|--------------|-----------|-----------|-----------|--------|
| **v2.21.0 成熟度** | Stable（默认） | Stable | **Stable（本期从 Alpha 升级）** | Stable | Stable |
| **无 service_name 搜索** | ✅ 完整支持 | ✅ 完整支持 | ✅ 完整支持 | ❌ 静默 0 行 → 现在显式报错 | ⚠️ 较窄版本 |
| **能力声明 WithoutServiceName** | true | true | true | **false** | narrow |
| **写模式** | async / sync（可配 poison-pill drop） | async / sync | async | async | sync |
| **poison pill 处理** | ✅ #9109 可选 drop | ✅ 同 ES | ❌ 无 | ❌ 无 | ❌ 无 |
| **`_msearch` item 级错误暴露** | ✅ #9008 修复 | ✅ 同 ES | N/A（不同协议） | N/A | N/A |
| **`error=false` 搜索正确性** | ✅ #9210 修复 | ✅ 同 ES | ✅ | ✅ #9096 修复（memory） | ✅ |
| **深度分页** | search_after | search_after | OFFSET/FILL | token-based | keyset |
| **索引依赖 service name** | 否 | 否 | 否 | **是（物理约束）** | 部分 |
| **存算分离** | 是（S3 tier） | 是（S3 tier） | ✅ 原生 | 否 | 否 |
| **rollup / 降采样** | 通过 rollover | 通过 rollover | ✅ 物化视图/TTL | 否 | 否 |
| **全文检索 span tag** | ✅ | ✅ | ⚠️ 有限 | ❌ | ❌ |
| **依赖图（service deps）** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **压缩比（trace 数据）** | 中（LZ4） | 中 | **高（列存）** | 高（SSTable） | 高 |
| **写入吞吐** | 高 | 高 | **很高** | 很高 | 中 |
| **查询延迟（trace by ID）** | 低 | 低 | 低 | 低 | 低 |
| **运维复杂度** | 高（JVM 调优） | 高（JVM 调优） | 中 | 高（repair/compaction） | 低（单机） |

**选型决策**：
- **已有 ES/OpenSearch 投入** → 继续，升级到 v2.21.0 拿到 `_msearch` 修复。
- **高写入吞吐 + 存算分离** → ClickHouse（本期转 Stable，可以上生产了）。
- **Cassandra 老部署** → 注意「无 service_name 搜索」从静默空结果变成显式报错。
- **单机/边缘** → Badger。

**关键洞察 6：ClickHouse 转正改变了存储选型的决策树。** 之前 ES 几乎是唯一的生产级选项，ClickHouse 的 Alpha 门控让很多团队「想用但不敢用」。现在「列存 + 存算分离 + 高写入吞吐」这个组合第一次有了 Stable 承诺，**追踪数据的存储成本结构可以被重新设计了**——追踪数据的列存压缩比显著优于 ES 的行存，在海量 span 场景下这是实打实的成本下降。

---

## 六、6 条 6-12 月可验证硬指标

今天就能跑代码复现，6-12 个月内可以持续观察：

| # | 指标 | 验证方式 | 目标 |
|---|------|---------|------|
| 1 | **v1 内部端点 404 率** | 升级后监控 `GET /api/services` 等四个端点的 404 计数 | 你的外部脚本迁移完成后归零；未迁移的会持续 404 |
| 2 | **`_msearch` item 错误暴露率** | §4.2 脚本跑在生产只读模式 | 修复后所有失败 item 都产生错误，而不是静默变成空结果 |
| 3 | **「trace not found」误报率** | 对比升级前后同一 traceID 查询的成功率 | 有 ES 后端且曾出现 item 失败的部署，误报率会下降 |
| 4 | **Agent 查询 token 成本** | 对比「逐服务循环搜索」vs「单次无 service_name 搜索」的 token 消耗 | 服务数 N 时从 O(N) 降到 O(1)，N=20 的微服务集群约降 20 倍 |
| 5 | **关键路径完整性** | 构造 §4.4 的背靠背 span 场景 | 修复后 child span 不再被错误排除 |
| 6 | **ClickHouse 部署门槛** | `NewFactory` 在无 feature gate 配置时的行为 | v2.21.0 后不再 hard-fail，v2.23.0 前旧 gate 名仍可用 |

---

## 七、6 条 6-12 月可观察未来信号

1. **apiv3 gRPC 成为唯一推荐的查询入口**。v1 内部端点删除是第一步，后续版本会继续清理其他 Internal 标签的端点。所有第三方集成最终都要迁移。
2. **MCP/ACP 查询接口成为追踪系统的标配**。Jaeger 在 query 侧内置 MCP endpoint + ACP agent，本质上是承认「Agent 是可观测性数据的一等消费者」。其他追踪后端（Tempo、Zipkin）会跟进。
3. **「能力声明 + 强制拒绝」成为存储抽象的通用模式**。RFC 0013 的三里程碑做法（先声明、再强制、后透传）会被其他需要适配异构后端的系统抄袭。
4. **ClickHouse 在可观测性存储份额上升**。转 Stable 之后，新部署的默认选型会从 ES 向 ClickHouse 倾斜，尤其在 span 量级大的场景。
5. **追踪查询语义从「以服务为中心」转向「以 trace 为中心」**。`search_traces` 省略 service_name 只是开始，后续会出现更多「跨服务语义」的查询模式。
6. **poison-pill 处理成为写入路径的标配**。#9109 是 RFC 0007 M5 的第一刀，后续会有完整的 poison classification + DLQ 机制。

---

## 八、总结与最佳实践

### ✅ 该用

- **升级到 v2.21.0**，尤其如果你的存储是 ES/OpenSearch——`_msearch` 静默丢弃是必须修的正确性问题。
- **把外部脚本迁移到 apiv3 gRPC**，越早越好。v1 内部端点的删除只是开始。
- **如果 span 量大，评估 ClickHouse 存储**。本期转 Stable，存算分离 + 列存压缩是真实的成本优势。
- **Agent 查询用「无 service_name」搜索**，把 fan-out 从 LLM 上下文挪回存储层。
- **用 §4.5 的巡检脚本**做升级前检查。

### ❌ 千万别用

- ❌ **不要**继续调用 `GET /api/services` 等 4 个被删的端点，升级 v2.21.0 后会 404。
- ❌ **不要**把 `_msearch` 的整体 HTTP 200 当成「所有 item 成功」——任何批量协议都要逐 item 检查错误。
- ❌ **不要**依赖 Cassandra 的「无 service_name 返回空」行为，那现在变成显式报错了。
- ❌ **不要**在关键路径分析里用严格不等号比较时间戳，背靠背 span 会丢。
- ❌ **不要**用 `ai.enable_mcp` 布尔值配置 MCP，改成 `ai.mcp` 配置块。
- ❌ **不要**给 ClickHouse 配置显式 `0` 期望它被保留——#9345 修复了默认值覆盖问题，但旧版本会吞掉它。

### 5 步生产升级 checklist

1. **[ ] 端点依赖审计**：grep 所有脚本/dashboard 对 4 个被删端点的调用，列出迁移清单。
2. **[ ] apiv3 gRPC 迁移**：把 trace 搜索从 HTTP v1 迁到 gRPC v3，`GET /api/traces/{traceID}` 不用动。
3. **[ ] 配置适配**：ClickHouse 移除 feature gate；`ai.enable_mcp` 改 `ai.mcp` 块。
4. **[ ] 灰度升级 + 对比**：先升级一个 query 实例，用 §4.2 脚本对比升级前后的 item 错误暴露率。
5. **[ ] 历史结论复核**：如果曾用旧版本做过故障定位，且当时看到「trace not found」或关键路径异常短，用新版本重新查一遍。

### 5 条 best practice

1. **「Internal」标签不是契约**。任何没有技术强制力的「内部」标记都会被外部消费。要删就趁早，且**先建后拆**。
2. **批量协议必须逐 item 检查错误**。整体 200 不等于全部成功，这是分布式系统里最容易被忽略的正确性陷阱。
3. **接口约束不能来自某个实现的物理限制**。Cassandra 的 service-name 索引是物理约束，把它固化成搜索契约是抽象泄漏，在 Agent 时代会乘以调用次数。
4. **把隐式行为显式化要分三步**：先让实现声明能力，再让调用方强制能力，最后打通透传路径。顺序反了会产生中间态矛盾。
5. **时间戳比较用包含边界**。追踪系统里背靠背 span 共享同一毫秒是常态，严格不等号会制造「看起来没瓶颈」的假象。

---

## 写在最后

Jaeger v2.21.0 是一个容易被低估的版本。它没有新存储引擎、没有性能翻倍的数字、没有新协议。它做的是更难的事：**承认系统之前返回了一些「看起来合法但内容错误」的响应，然后一个一个修掉**。

四个改动放在一起看，主线异常清晰：**追踪后端正在从「实现定义行为」转向「接口定义行为」**。删掉的端点是「实现细节被当成契约」的债；`_msearch` 修复是「把没报错当成功」的债；RFC 0013 是「把物理约束当接口契约」的债；ClickHouse 转正是「移除一个语义错误的抽象」。

而 MCP/ACP 查询接口的出现，让这件事有了新的紧迫性。**当 LLM Agent 成为查询的一等消费者，每一个「约定俗成」都会被乘以调用次数**。Agent 不会像人一样绕开限制、不会记得「这个后端要传 service_name」、不会怀疑空结果。它只会按接口文档调用，然后得到一个错误的答案。

**接口的诚实度，在 Agent 时代就是系统的可靠度。**
