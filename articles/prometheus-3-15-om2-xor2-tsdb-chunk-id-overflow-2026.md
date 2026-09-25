---
title: "Prometheus v3.15.0 深度拆解:OpenMetrics 2.0 抓取格式、XOR2 编码稳定化与 TSDB chunk ID 溢出修复"
date: 2026-09-25
category: 技术
tags: [Prometheus, Prometheus v3.15, OpenMetrics 2.0, OM2, 指标采集, exposition format, 文本解析器, lexer, CompositeValue, 直方图, native histogram, classic histogram, gaugehistogram, stateset, start timestamp, st@, created timestamp, st-storage, XOR2, chunk encoding, TSDB, Head block, chunk ID, out-of-order, OOO, WAL, 数据丢失, 静默数据丢失, appender, GC, series eviction, VPA, GOMEMLIMIT, auto-gomemlimit, cgroup, 内存限制, Unix Domain Sockets, UDS, scrape, zstd, 压缩, PromQL, 子查询对齐, peakSamples, query.max-samples, info 函数, FastRegexMatcher, 服务发现, AWS SD, MSK, ElastiCache, ECS, EC2, IONOS, remote write, OTLP, PromProto, 可观测性, 云原生, 监控, CNCF, Go, lex, yacc, 状态机, 协议设计, 2026]
excerpt: "Prometheus v3.15.0(2026-09-25 发布)把指标采集协议的三个历史欠账一次性结清:OpenMetrics 2.0 文本格式第一次有了生产可用的解析器(单行复合值把 1 个直方图从 N+2 行压成 1 行,start timestamp 内联到 st@ 后缀让 StartTimestamp 解析从 O(N) 深拷贝预读变成 O(1));XOR2 浮点 chunk 编码从实验特性变成稳定默认,旧 --enable-feature=xor2-encoding 弃用、改走 storage.tsdb.chunk_encoding.floats 配置项;TSDB Head 的 chunk ID 在 24 位空间里溢出 —— in-order 路径超过 2^23 后最高位撞上 out-of-order 标志位,查询直接返回 ErrNotFound,OOO 路径计数器无限增长直到 panic。还有四个工程上极痛的修复:gcSeries 在 appender 提交前就把 series 踢出 Head 造成静默数据丢失;WAL 写失败后脏缓冲回到对象池被后续记录拼接成「校验和合法但内容非法」的 WAL 记录;VPA 调整容器内存后 GOMEMLIMIT 仍停在启动时探测到的旧值;Unix Domain Socket 抓取等了 3 年的 issue #12024 终于落地。本文拆解 6 大承重级革新,每项附可运行配置、解析器原理与生产升级建议。"
cover: https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=600&h=400&fit=crop
readtime: 26
author: 林小白
---

# Prometheus v3.15.0 深度拆解:OpenMetrics 2.0 抓取格式、XOR2 编码稳定化与 TSDB chunk ID 溢出修复

> 2026 年 9 月 25 日,Prometheus v3.15.0 发布。这个版本的特殊性在于:它没有加任何"闪亮新功能",而是把 Prometheus 采集协议栈上三个欠了多年的技术债一次性结清 —— **文本 exposition 格式、chunk 编码、Head 内存索引的 ID 空间**。
>
> 这三件事的共同特征是:它们都是 Prometheus 在 2015 年前后定下来的契约,当时的设计假设(指标量级、直方图形态、单机内存)在 2026 年的云原生规模下全部被突破。v3.15 的做法不是重写,而是**在保持存储格式兼容的前提下,把「能撑多久」这个上限往后推**。

---

## 一、问题的源头:为什么一个监控系统的文本格式值得改三年

Prometheus 的文本 exposition 格式(Prometheus text format 0.0.4)稳定于 2014 年。它的设计哲学很明确:**让人能裸眼读、让客户端能裸手写、让解析器能裸解析**。这个哲学在 2015-2020 年间是正确的 —— 那时一个 exporter 暴露几十个 metric family、几百行文本是常态。

但 2020 年之后三件事把这个格式逼到了墙角:

**1. 直方图把行数炸成了 O(buckets)。** 一个带 20 个 bucket 的 classic histogram,在 0.0.4 格式里是 22 行(20 个 `_bucket{le="..."}` + 1 个 `_sum` + 1 个 `_count`)。如果一个服务有 200 个 API 端点 × 20 个 bucket,单次 scrape 就是 8400 行,而其中绝大部分行只是把同一个指标的维度重复一遍。文本体积、解析 CPU、标签内存全都被 bucket 数量线性放大。

**2. Created timestamp 的表示方式是反的。** PromQL 的 `rate()` 需要知道计数器的起点来判断 reset。Prometheus 的解法是让客户端暴露一个 `<metric>_created` 系列来携带 created timestamp。但 `_created` 是一个**独立 series**,解析器要拿到它必须做 peek-ahead:先深拷贝整个解析器状态去预读后面的行,确认存在 `st` 后再回到当前位置。这是一个 O(N) 的解析器操作,而且把一个逻辑上「属于同一个样本」的元数据拆成了两个 series,污染了查询面 —— 你 select 的时候会多出一堆 `_created` 序列。

**3. 指标数据模型进化了,文本格式没跟上。** 2023 年 native histogram(Google 的 sparse histogram 方案)进入 Prometheus,它把 bucket 的边界做成动态的,一个直方图只需要几十字节而不是 N×8 字节。但 0.0.4 文本格式根本没有表示 native histogram 的语法 —— 客户端只能序列化成 Protobuf(PromProto)。于是出现了「文本格式只能表示 classic histogram、Protobuf 才能表示 native histogram」的割裂, exporter 作者被迫维护两条代码路径。

OpenMetrics 2.0 就是为了解决这三件事。2024 年 OpenMetrics 项目并入 CNCF Prometheus 大家庭,2026 年 3 月规范发布 2.0.0-rc0,而 v3.15.0 是**第一个内置可用 OM2 解析器的 Prometheus 版本**。

**关键洞察 1:OM2 不是「更紧凑的格式」,而是「把元数据从 series 维度挪回 sample 维度」。** `_created` 系列消失、`st@` 内联,本质上是从「用额外 series 编码元数据」回退到「用 sample 内的字段编码元数据」。series 数量直接决定 TSDB 的内存占用(每个 series 的 memSeries 结构体在 arm64 上是 168 字节 + 标签集),一个 10 万 series 的实例去掉 `_created` 后能省掉可观内存,更重要的是查询 `rate()` 时不再需要做 series join。

---

## 二、三层架构:从 scrape 协议到 TSDB chunk 的数据通路

要理解 v3.15 改了什么,先要看清一条样本从 exporter 到磁盘的完整路径:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              scrape 协议层                                    │
│  Content-Type 协商 → HTTP GET → 响应体 → Content-Encoding 解压 → 解析器选择    │
└──────────────────────────────┬──────────────────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  textparse 解析器    │  promparse / openmetricsparser /
                    │  (lexer + parser)   │  openmetrics2parser / promproto
                    └──────────┬──────────┘
                               │  (metric family, series labels, value,
                               │   timestamp, start timestamp, exemplars)
                    ┌──────────▼──────────┐
                    │  scrape appender     │  v2 appender:start timestamp 合成、
                    │                      │  classic→native histogram 转换、
                    │                      │  stale marker、标签补全
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │  TSDB Head(内存)    │  memSeries(168B)+ chunk 列表 +
                    │                      │  OOO chunk + WAL 追加
                    └──────────┬──────────┘
                               │  (compaction / truncation)
                    ┌──────────▼──────────┐
                    │  TSDB block(磁盘)   │  XOR / XOR2 chunk + 倒排索引
                    └─────────────────────┘
```

v3.15 的 6 大承重级革新分布在这条通路的每一层:

| 层 | 革新 | 类型 | 影响 |
|----|------|------|------|
| scrape 协议层 | OpenMetrics 2.0 解析器 | FEATURE | 协议表达力:直方图 1 行表示、st 内联 |
| scrape 协议层 | Unix Domain Socket 抓取 | FEATURE | 部署拓扑:同节点零网络开销 |
| scrape 协议层 | zstd 压缩响应 | ENHANCEMENT | 带宽:抓取流量显著下降 |
| TSDB Head | chunk ID 溢出模运算回绕(2 个 PR) | BUGFIX | 正确性:长生命周期 series 不再查不到 |
| TSDB Head | GC 与 appender 竞争修复 | BUGFIX | 正确性:静默数据丢失 |
| 运行时 | `--auto-gomemlimit.refresh-interval` | FEATURE | 弹性:VPA 缩扩容即时生效 |

下面逐层拆。

---

## 三、革新 1:OpenMetrics 2.0 抓取格式 —— 从「行爆炸」到「单行复合值」

### 3.1 CompositeValue:一个直方图终于是一行了

OM2 的核心语法是 **CompositeValue**。classic histogram 从 N+2 行塌缩成一行:

```text
# HELP request_duration_bucket Classic histogram.
# TYPE request_duration_bucket histogram
request_duration_bucket {count:144,sum:53423.0,bucket:[+Inf:144,0.1:24,0.2:33,0.4:100,1.0:144]}
```

对比同一个指标在 OM1 / 0.0.4 里的样子:

```text
request_duration_bucket{le="0.1"} 24
request_duration_bucket{le="0.2"} 33
request_duration_bucket{le="0.4"} 100
request_duration_bucket{le="1.0"} 144
request_duration_bucket{le="+Inf"} 144
request_duration_sum 53423.0
request_duration_count 144
```

7 行 → 1 行。summary 的 `quantile` 也同样塌缩:

```text
# OM1:4 行 quantile + count + sum = 6 行
go_gc_duration_seconds{quantile="0.25"} 0.0001
go_gc_duration_seconds{quantile="0.5"} 0.0002
go_gc_duration_seconds{quantile="0.75"} 0.0003
go_gc_duration_seconds{quantile="1.0"} 0.0004
go_gc_duration_seconds_count 100
go_gc_duration_seconds_sum 1.5

# OM2:1 行
go_gc_duration_seconds {count:100,sum:1.5,quantile:[0.25:0.0001,0.5:0.0002,0.75:0.0003,1.0:0.0004]}
```

**native histogram 第一次有了文本表示**:

```text
acme_http_request_seconds{path="/api/v1",method="GET"} {count:2,sum:1.2e2,schema:0,zero_threshold:1e-4,zero_count:0,positive_spans:[1:2],positive_buckets:[1,1],bucket:[0.5:1,1:2,+Inf:2]}
```

注意 OM2 允许**同一个 sample 里 classic bucket 和 native bucket 共存**(`bucket:[...]` 字段里可以混合),这是为了让 exporter 能平滑迁移:先在 classic bucket 旁边把 native bucket 也暴露出来,验证下游解析正常后再摘掉 classic。

### 3.2 `st@`:start timestamp 从 series 变回后缀

OM2 把 start timestamp 编码成 sample 的一个后缀,位置严格固定:

```text
http_requests_total{method="get"} 1027.0 1395066363000 st@1395066363000
```

顺序是:`value [timestamp] [st@<ts>] [exemplar]`。

这对解析器是质变。OM1 里 `StartTimestamp()` 的实现必须做 peek-ahead:解析器在 OM1 里逐行前进,遇到 `<metric>_created` 才知道 start timestamp,但此时它已经在后面的行了 —— 实现方式是**深拷贝整个解析器状态**先往前探,探完再回退。OM2 的 lexer 直接把 `st@` 识别成一个独立 token(`tStartTimestamp`),解析器读到它就是 O(1) 的字段赋值。

PR #18606 的 benchmark 代码把这个差异写成了三个对照组,注释里写得很直白:

```go
// BenchmarkParseOM1VsOM2_CT compares OM1 and OM2 on metrics with created
// timestamps. OM1 carries CT on separate _created series, which forces
// StartTimestamp() to perform a parser deep-copy peek-ahead. OM2 carries CT
// inline (st@<ts>) and resolves StartTimestamp() in O(1).
func BenchmarkParseOM1VsOM2_CT(b *testing.B) {
	for _, tc := range []struct {
		parser string
		file   string
	}{
		{"omtext", "ct.bench.om.txt"},
		{"om2text", "ct.bench.om2.txt"},
	} {
		b.Run(fmt.Sprintf("parser=%v", tc.parser), func(b *testing.B) {
			benchParse(b, readTestdataFile(b, tc.file), tc.parser)
		})
	}
}
```

三个 benchmark 维度分别是:`AllTypes`(~30 个 metric family 的真实抓取形态)、`CT`(created timestamp 密集场景)、`Histograms`(直方图 / summary 密集场景)。**这三组恰好是 OM2 收益最大的三个面:解析 CPU、CT 深拷贝开销、行数压缩。**

### 3.3 解析器实现:lex + yacc 状态机,而不是手写扫描

值得注意的工程细节是 OM2 解析器没有手写,而是用 `lex` + `go tool yacc` 生成了一套 DFA。lexer 定义(来自 `model/textparse/openmetrics2lex.l`):

```lex
%{
func (l *openMetrics2Lexer) Lex() token {
    if l.i >= len(l.b) { return tEOF }
    c := l.b[l.i]
    l.start = l.i
%}

D     [0-9]
L     [a-zA-Z_]
M     [a-zA-Z_:]
C     [^\n]
S     [ ]

%x sComment sMeta1 sMeta2 sLabels sLValue sValue sTimestamp sExemplar sEValue sETimestamp

%%

#{S}                                  l.state = sComment
<sComment>HELP{S}                     l.state = sMeta1; return tHelp
<sComment>TYPE{S}                     l.state = sMeta1; return tType
<sComment>UNIT{S}                     l.state = sMeta1; return tUnit
<sComment>"EOF"\n?                    l.state = sInit; return tEOFWord
<sMeta1>\"(\\.|[^\\\"])*\"             l.state = sMeta2; return tMName
<sMeta1>{M}({M}|{D})*                  l.state = sMeta2; return tMName
<sMeta2>{S}{C}*\n                      l.state = sInit; return tText

{M}({M}|{D})*                          l.state = sValue; return tMName
<sValue>\{                             l.state = sLabels; return tBraceOpen
\{                                     l.state = sLabels; return tBraceOpen
<sLabels>{L}({L}|{D})*                 return tLName
<sLabels>\}                            l.state = sValue; return tBraceClose
<sValue>{S}[^ \n]+                     l.state = sTimestamp; return tValue
<sTimestamp>{S}st@[^ \n]+              l.state = sTimestamp; return tStartTimestamp
<sTimestamp>{S}[^ \n]+                 return tTimestamp
<sTimestamp>\n                         l.state = sInit; return tLinebreak
<sTimestamp>{S}#{S}\{                  l.state = sExemplar; return tComment
```

注释里明确标出了相对 OM 1.0 lexer 的两处差异:

```text
// The main differences from the OM 1.0 lexer are:
//   - Uses openMetrics2Lexer instead of openMetricsLexer.
//   - sTimestamp state recognises a new "st@<float>" token (tStartTimestamp).
//   - sETimestamp state recognises "{S}#{S}\{" to allow multiple exemplars per
//     sample.
```

第三点容易被忽略但很重要:**OM2 允许一个 sample 挂多个 exemplar**。OM 1.0 一个 sample 只能有一个 exemplar,这在 native histogram 场景下不够 —— 你可能想同时高亮一个 classic bucket 的 exemplar 和一个 native bucket 的 exemplar。多 exemplar 也让「每个 bucket 挂一个最近请求的 trace」这种调试场景成为可能。

### 3.4 启用方式与降级路径

特性开关是 `--enable-feature=openmetrics2`,通过 Content-Type 协商:

```
Accept: application/openmetrics-text; version=2.0.0
```

**降级路径设计得非常克制**:如果 target 返回 OM2 content type 但 Prometheus 没开特性开关,这次抓取**不会直接失败**,而是回退到 `fallback_scrape_protocol`(如果配置了),否则才失败。这个设计让灰度迁移可以单向进行:先升级 Prometheus 开开关,exporter 慢慢切,切错的目标只是降级到旧格式。

官方文档同时把丑话说在前面:

> OpenMetrics 2.0 support is **experimental**. The parser is not stable yet, so expositions that Prometheus accepts today may be rejected by a later release. Do not depend on the current behavior in production.

**这非常重要**:OM2 规范本身还是 2.0.0-**rc0**,Prometheus 明确声明「成功抓取不等于你的输出符合规范」。不要现在就把生产 exporter 全切 OM2。

```yaml
# v3.15 OM2 灰度配置
scrape_configs:
  - job_name: 'om2-canary'
    scrape_protocols: ['OpenMetricsText2.0.0', 'OpenMetricsText1.0.0', 'PrometheusText0.0.4']
    fallback_scrape_protocol: 'PrometheusText0.0.4'
    static_configs:
      - targets: ['canary-exporter:9100']
```

**关键洞察 2:OM2 的 CompositeValue 是「协议层向数据模型层对齐」,不是「协议层压缩」。** 它把文本格式从「只能表达 2015 年的指标类型」升级成「能表达 native histogram / gaugehistogram / stateset / info 的完整 Prometheus 数据模型」。这意味着 exporter 作者终于可以在不引入 Protobuf 依赖的前提下暴露 native histogram —— 对 Rust / C / 嵌入式 exporter 尤其重要,那边的 Protobuf 运行时是个负担。

---

## 四、革新 2:XOR2 浮点 chunk 编码稳定化 —— 从 feature flag 到配置项

### 4.1 XOR vs XOR2:省下的不只是空间

Prometheus 的浮点 sample 默认用 XOR 编码(Gorilla 论文方案):第一个 sample 存全量,后续只存 delta-of-delta。XOR2 是它的改良版,主要差别是**支持存储 start timestamp**。

这为什么重要?PromQL 的 `rate()` 需要处理 counter reset。传统做法是靠 `<metric>_created` 系列或者「值下降就算 reset」的启发式。但 `_created` 系列污染查询面,启发式在样本稀疏时不可靠。XOR2 的做法是把 ST 直接存进 chunk —— `reset` 判断从「猜」变成「读」。

代价是 chunk 内部布局变了。所以这个迁移路径被设计成渐进的:

| 阶段 | 行为 |
|------|------|
| Prometheus ≤ 3.10 | 只能用 `--enable-feature=xor2-encoding` 启用 |
| **v3.15(本次)** | feature flag **弃用**;改用 `storage.tsdb.chunk_encoding.floats: xor2` |
| 未来大版本 | feature flag 变成 no-op |

**约束必须讲清楚**:`st-storage` 开启时会**强制**启用 XOR2(以及 native histogram 的 ST chunk 格式),因为它需要 chunk 能存 ST。反过来的冲突是硬冲突 —— 在配置里显式写 `chunk_encoding.floats: xor` 同时开 `st-storage`,**config reload 会被拒绝**:

> Explicitly setting `chunk_encoding.floats: xor` in the config file while `st-storage` is active is rejected at config reload because XOR chunks do not store start timestamps.

这是 v3.15 里少见的「配置项之间有硬依赖」,升级时必须先想清楚 ST 策略再动 chunk 编码。

### 4.2 兼容性陷阱:直接读 TSDB 的下游

release notes 里那句提醒不是客套:

> Check that other software reading the TSDB directly (e.g. Thanos sidecar) supports XOR2 before enabling.

Thanos / Mimir / Cortex 这类组件在 certain 路径下会直接读 Prometheus 的本地 TSDB block。XOR2 chunk 对它们是不透明的。升级顺序必须是:**先升级下游读侧 → 再启用 XOR2**,否则会出现 block 写出来了但 sidecar 读不了的情况。

```yaml
# v3.15 推荐配置
storage:
  tsdb:
    chunk_encoding:
      floats: xor2    # 取代 --enable-feature=xor2-encoding
    out_of_order_time_window: 30m
```

### 4.3 `st-storage` 的连锁效应

`--enable-feature=st-storage` 现在会自动启用 XOR2 和 histogram ST chunk 编码,不用再同时传 `xor2-encoding` 和 `histograms-st-encoding`。这个简化本身说明 ST 这条链路在内部被打通了:WAL 有了新的 record type `SamplesV2`,贯穿 TSDB、Agent mode、Remote-Write 2.0。

**但 `SamplesV2` 有版本门槛**:

> It introduces new WAL record type (SamplesV2) that can only be replayed with Prometheus 3.11 or later versions.

**这是升级里最容易踩的坑**:跨大版本回滚时,如果 WAL 里有 `SamplesV2` 记录而回滚目标 < 3.11,启动会失败。v3.15 同时给 Agent mode 加了一个兜底:

```text
[BUGFIX] Agent: Ignore unknown WAL record types, to help users rolling back.
```

**关键洞察 3:ST(Sstart timestamp)是 Prometheus 用十年时间把一个「查询时的猜测」慢慢改造成「写入时的事实」的完整案例。** 路径是:`_created` 系列协议层编码(2018)→ `created-timestamp-zero-ingestion` 注入合成 0 样本(2022)→ `PrometheusProto` 原生字段(2023)→ OM2 `st@` 文本内联 + `st-storage` 贯通存储(2026)。每一步都在把信息从「查询时推断」往「采集时确定」挪。rate() 的 reset 判断成本从「O(窗口) 扫描 + join」变成了「O(1) 读 chunk 元数据」。

---

## 五、革新 3:TSDB Head chunk ID 溢出 —— 一个 24 位空间的设计终局

这是本次发布里最「基础设施」的一个修复,也是最容易在生产上被忽略的 —— 因为它的症状是**查询返回空 / ErrNotFound**,而不是 panic。

### 5.1 24 位 chunk ID 与那个被占用的高位

Prometheus 的 `HeadChunkRef` 是一个 64 位整数,其中 chunk ID 占 **24 位**,最高位(第 24 位)被保留为 **OOO(out-of-order)标志位**。这意味着 in-order chunk ID 的合法空间是 `[0, 2^23)`,而不是 `[0, 2^24)`。

**在 2025 年以前这不是问题。** 一个 series 的 Head chunk 在数据写入到一定量后被 truncate 成新的 chunk,ID 单调递增。要累计 838 万个 chunk,按每个 chunk 约 120 个 sample 算,需要同一个 series 在 Head 里积累约 10 亿个 sample —— 只有极端长生命周期的 high-cardinality counter 才会碰到。

但 **out-of-order 摄取路径**把这个时间大幅缩短了。OOO chunk 的生命周期管理不同:每次 OOO truncation cycle 都会推进 `firstOOOChunkID`。在一些重排严重的场景(消息队列回放、CDN 日志延迟到达、边缘设备离线重连),OOO truncation 会高频发生,计数器增长远快于 in-order 路径。

于是有了两个 PR:

**PR #19216(OOO 侧):** `firstOOOChunkID` 无界增长,溢出 23 位空间后 `NewHeadChunkRef` panic,`oooChunk()` 查询时 index-out-of-range。修法:在产生 / 消费 OOO chunk ID 的三处做模运算回绕 `& (oooChunkIDMask)`。

**PR #19450(in-order 侧,follow-up):** in-order chunk ID 存在 24 位字段里,但最高位是 OOO 标志位。**ID 一旦达到 `2^23`,最高位被置 1,查询会把这个 chunk 当成 OOO chunk,直接返回 `ErrNotFound`**。修法一致:分配和查询时都对 `2^23` 取模,truncate 时 `firstChunkID` 也按 `2^23` 推进。

两个路径的失败语义不同,PR 里讲得很清楚:

> The OOO path logs and drops data when the ID space is exhausted, since OOO ingestion is best-effort. The in-order path panics instead, since dropping would mean [data loss of in-order data].

**关键洞察 4:这是一个教科书级的「设计终局」案例。** 当年设计 24 位 chunk ID 时,显然假设「一个 series 在 Head 里不会活那么久」。这个假设在 2026 年的 OOO 摄取 + 长生命周期 series 场景下被突破,而且突破方式很阴险 —— **不是 OOM、不是 panic,是查询静默返回 ErrNotFound**。这种 bug 在生产上会表现为「某个老指标的某些时间窗口查不到」,极难定位。模运算回绕是正确修法:ID 空间被当成环形缓冲区使用,配合 Head 的其他约束保证引用活性。

---

## 六、革新 4:GC 与 appender 的竞争 —— 静默数据丢失的修复

如果chunk ID 溢出是「设计终局」,那这个是「并发终局」。

### 6.1 丢失路径

TSDB Head 有两条 GC 路径会驱逐 series:`gcSeries` 在 selected-series compaction 和 stale-series compaction 里都跑。问题出在时间窗口上:

```
t0: appender Accept() 一个 sample,series 被锁定
t1: sample 排队等待 Commit
t2: gcSeries 运行,认为这个 series 可以被驱逐(此时 sample 还没提交)
t3: appender Commit() —— series 已经不在 Head 里了,sample 丢失
```

PR #19272 先修了「resolve series 与 append 锁定」之间的竞争。PR #19470 处理的是 sample 已经排队之后的第二条丢失路径。

### 6.2 预约计数器方案

修法是**给每个排队的 sample 发一个预约(reservation)**:

```text
- Counts one reservation per accepted queued sample, plus a separate
  reservation for each newly indexed series.
- Keeps series in both head GC paths until all reservations have been
  released by commit or rollback.
- Packs the 30-bit count with the histogram end-time and garbage-collected
  flags, keeping memSeries at 168 bytes on arm64.
- Takes the V1 synthetic start-timestamp reservation only after both
  rejection checks, so a rejected zero sample cannot pin a series.
```

**注意第三个细节**:30 位计数器是**打包进现有字段**的(histogram end-time + GC flags),memSeries 结构体在 arm64 上**保持在 168 字节**。在一个持有 100 万 series 的 Head 里,结构体变大 8 字节就是 8MB 常驻内存。作者明确把这个约束写进了 PR 描述 —— 这不是顺手优化,是设计约束。

第四个细节是顺序正确性:V1 合成 start timestamp 的预约必须在**两个拒绝检查之后**才拿,否则一个被拒绝的 0 样本会永久 pin 住一个 series,造成内存泄漏。

同时新增了配套指标:

```text
prometheus_tsdb_head_series_pending_commit_underflow_total
```

这个 counter 记录「预约下溢」事件 —— 也就是 commit/rollback 释放的预约比预期多。**这是这种并发修复应该有的可观测性**:修好了竞态,同时给一个指标让运维知道竞态是否真的发生过。

**关键洞察 5:「静默数据丢失」是时序数据库最恶劣的失败模式。** 它不告警、不 panic、图表上只是一段平线或缺口,用户会归因于「应用没产生数据」。v3.15 的这三个修复(#19272 + #19470 + #19664)合起来堵住了 Head 在并发驱逐下的三条数据丢失路径,而且第 4 条(WAL 缓冲污染)也顺手修了 —— 见下节。升级到 v3.15 的最大理由不是性能,是**正确性**。

---

## 七、革新 5:WAL 缓冲污染 —— 校验和合法但内容非法

PR #19700 修的 bug 短到能一句话说完,但性质非常恶劣:

> A failed WAL write currently returns an encoded, non-empty buffer to the shared pool. A later append can reuse that buffer and concatenate its record with the failed record, producing a checksummed but invalid WAL record.

翻译成时序:**WAL 写失败后,编码过、非空的缓冲被还回共享对象池。下一次 append 从池里拿到这个缓冲,把自己的记录拼接在失败记录后面。最终写出去的 WAL 记录带着合法的校验和,但内容是两条记录的拼接。**

WAL 的设计契约是「校验和合法 ⇒ 记录可重放」。这个 bug 直接破坏了这个契约 —— 重放时会读到一条格式错误的记录,而 CRC 检查不会拦它。

修法很干净:所有路径(包括错误路径)从 `log()` / `logSeries()` 归还缓冲时**都归零长度**。并配了确定性回归测试:

```text
go test ./tsdb/agent -run '^TestAppenderBufferResetAfterWALWriteError$' -count=50
go test -race ./tsdb/agent -run '^TestAppenderBufferResetAfterWALWriteError$' -count=1
```

**50 次重复 + race detector** —— 因为这是对象池复用 bug,单次跑不一定撞上。

PR 末尾诚实地划了边界:

> This change intentionally does not address the separate partial-page WAL corruption tracked in #13027 or the failed-appender reuse issue described in #19699.

#13027 是一个 2023 年就报了的 issue:磁盘写满后 WAL 进入不可恢复状态。**这种「我修了什么 / 我没修什么」的诚实边界声明,是判断一个基础设施 PR 质量的重要信号。**

---

## 八、革新 6:运行时弹性与协议补全

### 8.1 `--auto-gomemlimit.refresh-interval`

`--auto-gomemlimit` 会在启动时探测 cgroup / 系统内存限制并设置 Go 的 `GOMEMLIMIT`(软内存上限,触发更激进的 GC)。**但它只在启动时探测一次。**

问题场景是 **Vertical Pod Autoscaler(VPA)** 动态调整容器内存。VPA 把 limit 从 8Gi 提到 16Gi,Prometheus 的 `GOMEMLIMIT` 仍然停在启动时的 8Gi —— 结果是**内存已经扩容了,GC 却还在按旧的、更紧张的水位线工作**,该用的内存用不上。

新 flag 接上 `automemlimit` 库已有的 `WithRefreshInterval` 选项:

```text
--auto-gomemlimit.refresh-interval
  Interval at which to re-detect the container or system memory limit and update
  GOMEMLIMIT accordingly. Useful when the limit can change at runtime, e.g. with
  a Vertical Pod Autoscaler. Set to 0 to detect the limit only once at startup.
  Note that a downward change in the limit can cause a temporary increase in
  garbage collection activity. Only used when --auto-gomemlimit is set.
  Default: 0s
```

**默认 0s(不刷新)是正确的**:向下调整 limit 会造成 GC 突然变多,这是有代价的行为,应该让用户显式 opt-in。

### 8.2 Unix Domain Socket 抓取(issue #12024)

等了 3 年的 feature。配置方式:

```yaml
scrape_configs:
  - job_name: 'node-uds'
    scrape_interval: 15s
    static_configs:
      - targets: ['unix:/var/run/node_exporter.sock']
```

实现上有意思的点是**它没有新建一套传输抽象**,而是在 URL 里用 `unix` scheme + query param 传 socket path,通过自定义 RoundTripper 和 Dialer 拦截来做 socket 连接,**保留了标准 HTTP / HTTPS 语义**:

```text
- Update config.CheckTargetAddress to permit addresses starting with 'unix:'.
- Update scrape.Target.URL() to generate 'unix' scheme URLs, utilizing query
  parameters to pass the socket path.
- Implement a custom RoundTripper and Dialer interception logic to manage Unix
  socket connections while preserving standard HTTP/HTTPS semantics.
```

这意味着 TLS、认证、重试这些 HTTP 层逻辑全部原样可用。**对 sidecar 部署(node_exporter 与 Prometheus 同节点)尤其有价值:省掉 loopback TCP 的全部协议栈开销,而且不占端口。**

### 8.3 zstd 抓取压缩

`--enable-feature=zstd-scrape`,在 Accept 头里声明 zstd:

```
Accept-Encoding: zstd
```

实现细节值得注意:**zstd 解码器被做成单并发、通过 pool 复用**。为什么单并发?因为 zstd decoder 是有状态的(持有字典 / 窗口),并发抓取 N 个 target 就需要 N 个 decoder 实例,内存随 target 数线性增长。pool 化单并发 decoder 是「CPU 换内存」的明确取舍。

另一个细节:**body size limit 作用于解压后的字节数**。这很重要 —— 否则 target 可以用压缩比欺骗限制,造成 OOM。

---

## 九、实际配置与代码

### 9.1 v3.15 完整生产配置(渐进式)

```yaml
# prometheus.yml —— v3.15 目标配置
global:
  scrape_interval: 30s
  scrape_timeout: 10s
  evaluation_interval: 30s
  scrape_protocols:
    - PrometheusProto              # 仍然优先,ST 传递最高效
    - OpenMetricsText1.0.0
    - OpenMetricsText0.0.1
    - PrometheusText0.0.4

scrape_configs:
  # 灰度 OM2 的目标
  - job_name: 'om2-canary'
    scrape_protocols: ['OpenMetricsText2.0.0', 'OpenMetricsText1.0.0']
    fallback_scrape_protocol: 'PrometheusText0.0.4'
    static_configs:
      - targets: ['canary-exporter:9100']

  # Unix Domain Socket 抓取(同节点 sidecar)
  - job_name: 'node-uds'
    static_configs:
      - targets: ['unix:/var/run/node_exporter.sock']

  # 高基数 exporter,先保持 OM1
  - job_name: 'kubernetes-nodes'
    scrape_protocols: ['OpenMetricsText1.0.0', 'PrometheusText0.0.4']
    kubernetes_sd_configs:
      - role: node
```

```yaml
# 启动参数(v3.15)
./prometheus \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/data/prometheus \
  --storage.tsdb.retention.time=30d \
  --storage.tsdb.chunk_encoding.floats=xor2 \
  --auto-gomemlimit \
  --auto-gomlimit.ratio=0.9 \
  --auto-gomemlimit.refresh-interval=5m \
  --enable-feature=zstd-scrape \
  --enable-feature=memory-snapshot-on-shutdown \
  --web.enable-lifecycle
```

### 9.2 OM2 输出长什么样(可直接喂给 Prometheus 测试)

```text
# HELP http_requests_total Total number of HTTP requests.
# TYPE http_requests_total counter
http_requests_total{method="get"} 1027.0 1395066363000 st@1395066363000
http_requests_total{method="post"} 3.0
# HELP rpc_duration_seconds RPC duration distribution.
# TYPE rpc_duration_seconds summary
rpc_duration_seconds{quantile="0.01"} 3102.0
rpc_duration_seconds{quantile="0.05"} 3272.0
rpc_duration_seconds{quantile="0.5"} 4773.0
rpc_duration_seconds_count 2693.0
rpc_duration_seconds_sum 1.7560473e+07
# HELP go_gc_duration_seconds GC duration percentiles.
# TYPE go_gc_duration_seconds summary
go_gc_duration_seconds {count:100,sum:1.5,quantile:[0.25:0.0001,0.5:0.0002,0.75:0.0003,1.0:0.0004]}
# HELP process_open_fds Number of open file descriptors.
# TYPE process_open_fds gauge
process_open_fds 8.0
# HELP up 1 if the target is up.
# TYPE up gauge
up 1.0
# HELP request_duration Classic histogram.
# TYPE request_duration histogram
request_duration {count:144,sum:53423.0,bucket:[+Inf:144,0.1:24,0.2:33,0.4:100,1.0:144]}
# HELP build_info Build information.
# TYPE build_info info
build_info{version="1.0.0"} 1.0
# HELP subsystem_enabled Subsystem stateset.
# TYPE subsystem_enabled stateset
subsystem_enabled{subsystem_enabled="auth"} 0.0
subsystem_enabled{subsystem_enabled="metrics"} 1.0
# EOF
```

几个值得注意的语法点:
- **`st@` 跟在 timestamp 后面**,顺序是 `value timestamp st@ts`
- **summary 的 quantile 是复合形式**,而 classic summary 的 `_count` / `_sum` 仍然可以单独行存在(向后兼容)
- **`# EOF` 是强制的**,OM 1.0 里 `# EOF` 是 MUST,v3.15 的解析器同样要求
- **stateset / info 类型第一次在文本格式里有了一等公民表示**

### 9.3 验证升级后没有回归

```bash
# 1. 检查 chunk 编码是否真的切到 XOR2
# (TSDB 的 block meta 里会记录 encoding)
promtool tsdb analyze /data/prometheus 01ABC...  # block ID

# 2. 检查 ST 是否被正确存储(st-storage 开启时)
# 查询应该能返回非空结果:
# rate() 的 reset 检测从「猜」变成「读」

# 3. 检查是否有预约下溢(并发竞争是否真的发生过)
# prometheus_tsdb_head_series_pending_commit_underflow_total

# 4. 检查 OOO chunk ID 是否在回绕前就触发过
# 观察 prometheus_tsdb_head_out_of_order_* 系列

# 5. 验证 WAL 没有被污染(升级后第一件事)
# 走一次干净的 WAL replay:
./promtool tsdb dump /data/prometheus/wal > /dev/null
```

### 9.4 抓取协议基准对比(可直接跑)

```go
// 从 PR #18606 抽出的 benchmark 对照组
// 跑法:
//   export bench=v1 && go test ./model/textparse/... \
//     -run '^$' -bench '^BenchmarkParseOM1VsOM2_AllTypes' \
//     -benchtime 2s -count 6 -cpu 2 -benchmem -timeout 999m \
//   | tee ${bench}.txt

func BenchmarkParseOM1VsOM2_AllTypes(b *testing.B) {
	// ~30 metric families 的真实抓取形态
	// OM2 更紧凑:classic histogram / summary 用单行复合形式
	// OM1 展开成每 bucket / quantile 一行 + _sum / _count
	for _, tc := range []struct {
		parser string
		file   string
	}{
		{"omtext", "alltypes.bench.om.txt"},
		{"om2text", "alltypes.bench.om2.txt"},
	} {
		b.Run(fmt.Sprintf("parser=%v", tc.parser), func(b *testing.B) {
			benchParse(b, readTestdataFile(b, tc.file), tc.parser)
		})
	}
}

func BenchmarkParseOM1VsOM2_CT(b *testing.B) {
	// created timestamp 密集场景
	// OM1:CT 在独立 _created 系列上,StartTimestamp() 必须深拷贝预读
	// OM2:CT 内联 st@,StartTimestamp() 是 O(1)
	for _, tc := range []struct {
		parser string
		file   string
	}{
		{"omtext", "ct.bench.om.txt"},
		{"om2text", "ct.bench.om2.txt"},
	} {
		b.Run(fmt.Sprintf("parser=%v", tc.parser), func(b *testing.B) {
			benchParse(b, readTestdataFile(b, tc.file), tc.parser)
		})
	}
}

func BenchmarkParseOM1VsOM2_Histograms(b *testing.B) {
	// classic histogram / summary 密集场景
	// OM1:每 bucket/quantile 一个系列 + _sum/_count
	// OM2:单行复合,解析器展开成同样的逻辑系列
	for _, tc := range []struct {
		parser string
		file   string
	}{
		{"omtext", "histograms.bench.om.txt"},
		{"om2text", "histograms.bench.om2.txt"},
	} {
		b.Run(fmt.Sprintf("parser=%v", tc.parser), func(b *testing.B) {
			benchParse(b, readTestdataFile(b, tc.file), tc.parser)
		})
	}
}
```

**这三个 benchmark 的设计本身就是一份评估清单**:任何声称「新格式更快」的方案,都应该在这三个维度(混合负载 / CT 密集 / 直方图密集)上给出对照数据。

---

## 十、性能与方案对比

### 10.1 OM2 vs OM1 vs PrometheusProto vs JSON:四路抓取协议对比

| 维度 | PrometheusText 0.0.4 | OpenMetrics 1.0 | **OpenMetrics 2.0** | PrometheusProto |
|------|---------------------|-----------------|---------------------|----------------|
| 规范状态 | 稳定(2014) | 稳定(2020) | **2.0.0-rc0(实验)** | 稳定 |
| 直方图表示 | 每 bucket 一行 | 每 bucket 一行 | **单行 CompositeValue** | Protobuf 字段 |
| native histogram | ❌ 无法表示 | ❌ 无法表示 | **✅ 单行表示** | ✅ |
| start timestamp | ❌ | `_created` 独立系列 | **`st@` 内联(O(1) 解析)** | ✅ 字段 |
| exemplar / sample | 1 个 | 1 个 | **多个** | ✅ |
| stateset / info 类型 | 无一等表示 | 无一等表示 | **✅** | ✅ |
| 解析器实现 | 手写 | 手写 | **lex + yacc DFA** | Protobuf |
| 人类可读 | ✅ 最强 | ✅ 强 | ✅ 强(复合值略需适应) | ❌ |
| 无依赖客户端可写 | ✅ | ✅ | ✅ | ❌ 需 Protobuf 运行时 |
| 解析 CPU(直方图密集) | 基准 | 基准 | **显著低于(行数 N+2→1)** | 最低 |
| 生态成熟度 | 100% | 95% | **< 5%(刚落地)** | 70% |
| v3.15 支持 | ✅ 默认 | ✅ 默认 | ✅ **feature flag** | ✅ 默认 |

**选型建议**:
- **生产默认 = PrometheusProto**:ST 传递最高效、解析最快、native histogram 原生支持
- **OM2 = 灰度阶段**:只给 canary 目标开,parser 明确不稳定
- **OM1 / 0.0.4 = 兜底**:所有旧 exporter 的 fallback_scrape_protocol

### 10.2 chunk 编码方案对比

| 维度 | XOR(默认) | **XOR2(v3.15 稳定化)** | delta-of-delta(Gorilla) | 恒定精度 |
|------|-----------|----------------------|------------------------|---------|
| 浮点 sample | ✅ | ✅ | ✅ | — |
| **存储 start timestamp** | ❌ | **✅** | ❌ | — |
| 相对 XOR 压缩率 | 1.0x | **~1.0-1.1x(几乎相同)** | 1.0x | — |
| 支持 OOO chunk | ✅ | ✅ | — | — |
| 配置方式 | 默认 | **`storage.tsdb.chunk_encoding.floats: xor2`** | — | — |
| feature flag 状态 | 无需 | **flag 弃用,改配置项** | — | — |
| Thanos sidecar 可读 | ✅ | **需先升级下游** | — | — |
| 与 st-storage 关系 | **互斥(硬冲突)** | **强制联动** | — | — |

**关键点**:XOR2 的收益**不是空间**,是**ST 存储**。别为了「压缩」去开它,要为了「rate() 的 reset 判断从猜测变成读取」去开。

### 10.3 TSDB Head 数据丢失路径修复对照

| 路径 | 触发条件 | 症状 | 修复 PR | 版本 |
|------|---------|------|---------|------|
| resolve / append 锁定竞争 | 高并发写 + series churn | 静默丢样本 | #19272 | v3.15 |
| **gcSeries 提前驱逐** | appender 排队中 + compaction | **静默丢样本** | **#19470** | **v3.15** |
| 查询时 series 被驱逐 | WAL replay 后活跃 reader | **查询 panic** | **#19664** | **v3.15** |
| **WAL 缓冲污染** | WAL 写失败 + 池复用 | **校验和合法的非法记录** | **#19700** | **v3.15** |
| in-order chunk ID 溢出 | 长生命周期 series > 2^23 chunk | **查询 ErrNotFound** | **#19450** | **v3.15** |
| OOO chunk ID 溢出 | 高频 OOO truncation | panic + index 越界 | #19216 | v3.15 |
| rejected 0 样本 pin series | V1 合成 ST + 拒绝 | 内存泄漏 | #19470 | v3.15 |
| 磁盘写满 WAL 不可恢复 | 磁盘满 | 启动失败 | **#13027(未修)** | — |

**注意最后一行**:#13027(2023 年报的磁盘写满导致 WAL 不可恢复)**在 v3.15 仍未修复**,PR #19700 明确声明不包含。升级不能解决这个问题,磁盘告警仍然必须独立部署。

---

## 十一、6 条 6-12 个月可验证硬指标

以下每条都可以在你自己的环境里直接跑:

**1. OM2 直方图行数压缩:N+2 → 1**
在一个暴露 200 个 API 端点 × 20 bucket 的服务上,抓取响应体行数从 ~8400 行降到 ~420 行。验证方式:开 `--enable-feature=extra-scrape-metrics`(或 v3.15 的 `extra_scrape_metrics` 配置项),对比 `scrape_body_size_bytes` 和 `scrape_samples_post_metric_relabeling` 在 OM1 / OM2 两个协议下的值。

**2. `st@` 让 StartTimestamp() 从 O(N) 深拷贝变成 O(1)**
跑 PR #18606 的 `BenchmarkParseOM1VsOM2_CT`:在 created timestamp 密集的 exposition 上,OM2 解析的 ns/op 和 allocs/op 应显著低于 OM1。命令:`go test ./model/textparse/... -run '^$' -bench '^BenchmarkParseOM1VsOM2_CT' -benchtime 2s -count 6 -cpu 2 -benchmem`。

**3. XOR2 + st-storage 联动后 series 数下降**
如果你之前用 `created-timestamp-zero-ingestion` + `_created` 系列,切到 `st-storage` 后,`prometheus_tsdb_head_series` 应下降约等于 `_created` 系列的数量。**注意:这只在 `_created` 系列占比高的实例上明显**。

**4. VPA 场景下 GOMEMLIMIT 刷新**
开 `--auto-gomemlimit --auto-gomemlimit.refresh-interval=5m`,然后 VPA 调整 limit。观察 `go_memstats_gc_cpu_fraction` 或 GC 频率在 refresh interval 周期内是否随之变化。**向下调整时会有一个 GC 突增窗口,这是预期行为,不是 bug。**

**5. UDS 抓取的 CPU / 延迟收益**
同一个 node_exporter,从 `localhost:9100` 切到 `unix:/var/run/node_exporter.sock`。对比 `scrape_duration_seconds` 与 Prometheus 进程的网络中断开销。**在几千个 target 的规模下,loopback TCP 的协议栈开销是可测的。**

**6. zstd 压缩的带宽节省**
对大 exposition(如 kube-state-metrics、cAdvisor)开 `zstd-scrape`。对比 `scrape_body_size_bytes`(未压缩)与实际网络字节数。**注意 body_size_limit 作用于解压后字节数 —— 不会因为压缩而绕过限制。**

---

## 十二、6 条 6-12 个月可观察的未来信号

**1. OpenMetrics 2.0 规范从 rc0 走向正式 2.0.0**
目前规范版本是 2.0.0-rc0(2026 年 3 月),状态标注为 Experimental,并明确声明「我们保留破坏兼容性的权利」。**Prometheus 明确声明「成功抓取不等于你的输出符合规范」,引导 exporter 作者去看 migration guide 而不是用「能不能被抓取」当正确性判据。** 6-12 个月内 rc1 / 正式版会出,parser 稳定化是解除 experimental 标注的前提。

**2. OM2 从 feature flag 变成默认 scrape_protocols 候选**
历史路径很清楚:`exemplar-storage` / `memory-snapshot-on-shutdown` / `created-timestamp-zero-ingestion` 都是先 feature flag、再默认、最后 flag 变 no-op。OM2 会走同一条路。**观察点:v3.16 / v3.17 是否把 `OpenMetricsText2.0.0` 加进默认 `scrape_protocols`。**

**3. `created-timestamp-zero-ingestion` 被 `st-storage` 替代**
官方文档已经明说:

> In the future this feature is meant to be a replacement of `created-timestamp-zero-ingestion` which injects synthetic 0 samples.

合成 0 样本是一个 hack(往 series 里注入假的 0 值 sample),`st-storage` 是正解。**观察点:废弃警告何时出现。** 一旦废弃,`_created` 系列 + 合成 0 样本这条路就进入倒计时。

**4. XOR2 成为默认 chunk 编码**
现在需要显式配置 `chunk_encoding.floats: xor2`。当 `st-storage` 的价值被验证后,XOR2 很可能成为默认值,旧 XOR 进入兼容模式。**观察点:v3.16+ 的 default 值变化,以及 Thanos / Mimir 对 XOR2 block 的读取支持何时 GA。**

**5. chunk ID 空间设计的反思**
24 位 chunk ID + 1 位 OOO 标志位的设计在 OOO 时代被突破,修法是模运算回绕(把 ID 空间当环形用)。**但这意味着 Head 的 ID 分配从「单调递增」变成了「环形复用」**,这是一个语义变化。观察后续版本是否引入更长的 ID 字段或 ID 空间重设计。**这也会影响 Thanos / Mimir 这类直接消费 Head 引用的下游。**

**6. 服务发现的 panic 清理潮**
v3.15 修了一大批 AWS SD 的 panic(MSK serverless、ElastiCache 缺字段、ECS 自定义 task group、EC2 缺字段、IONOS 缺字段)。**这反映了一个模式:云厂商 API 不断新增 optional 字段,而 Prometheus 的 SD 代码是按「字段存在」写的。** 6-12 个月内还会有新一轮。**告警建议:对 Prometheus 进程的 panic 做独立告警,SD panic 会整个进程崩掉,而不只是丢一个 target。**

---

## 十三、最佳实践与升级 checklist

### ✅ 该做

1. **优先升级到 v3.15,理由是正确性不是性能。** 三个静默数据丢失路径 + chunk ID 溢出(查询返回 ErrNotFound)+ WAL 缓冲污染,全都是不升级就一直在踩的坑。
2. **OM2 只给 canary 目标开。** parser 明确 experimental,规范还是 rc0,`fallback_scrape_protocol` 必须配。
3. **XOR2 启用前先升级下游读侧。** Thanos sidecar / Mimir 这些直接读 TSDB 的组件必须先支持 XOR2。
4. **`st-storage` 与 `chunk_encoding.floats: xor` 不要同时配。** config reload 会被拒绝,这是硬冲突。
5. **跨大版本回滚先检查 WAL。** `SamplesV2` record type 只能被 3.11+ replay;Agent mode 现在会忽略未知 record type 帮你回滚,server mode 不会。
6. **VPA 用户开 refresh-interval。** 默认 0s 是正确的保守默认,但如果你在用 VPA,这个 flag 是收益最高的单行配置。
7. **对 `prometheus_tsdb_head_series_pending_commit_underflow_total` 建告警。** 它是「并发竞争是否真的发生过」的直接信号。

### ❌ 千万别做

1. **不要现在把生产 exporter 全切 OM2。** 规范是 rc0,Prometheus 明确声明「成功抓取不等于符合规范」,而且「今天接受的 exposition 可能被后续版本拒绝」。
2. **不要为了「压缩」去开 XOR2。** 它的收益是 ST 存储,压缩率与 XOR 几乎相同。没有 ST 需求就不要动 chunk 编码。
3. **不要忽略 #13027。** 磁盘写满导致 WAL 不可恢复的问题**在 v3.15 仍未修复**。磁盘容量告警必须独立部署,不能指望 Prometheus 自己处理。
4. **不要在 SD panic 上省告警。** 一个 MSK serverless 集群的 API 响应缺字段就能让整个 Prometheus 进程崩掉。v3.15 修了一批,但这个失败模式本身(按「字段存在」写 SD 代码)没有根除。
5. **不要用 `scrape_body_size_bytes` 判断 zstd 的网络节省。** 它报告的是**解压后**字节数。要看网络层收益得从监控基础设施侧看。
6. **不要跳过 `promtool check config`。** v3.15 新增了配置项间的硬依赖(st-storage ↔ xor2),这是 config check 能拦住的。

### 5 步生产升级 checklist

```text
[ ] 1. 升级所有直接读 TSDB 的下游(Thanos / Mimir / Cortex)到支持 XOR2
[ ] 2. promtool check config 通过新配置(含 chunk_encoding / scrape_protocols)
[ ] 3. 在 canary 实例上跑 7 天,监控:
        - prometheus_tsdb_head_series_pending_commit_underflow_total(应为 0 或不增长)
        - 查询有无新的 ErrNotFound(chunk ID 溢出的症状)
        - scrape 失败率(OM2 灰度目标)
[ ] 4. 全量升级,保留旧版本二进制 + WAL 备份(回滚保险)
[ ] 5. 升级后第一件事:promtool tsdb dump /data/prometheus/wal(验证 WAL 没被污染)
```

---

## 十四、PromQL 行为变化:两个容易被忽略的 CHANGE

v3.15 除了存储层,还修了两个 PromQL 语义,值得单独拎出来:

### 14.1 子查询对齐:peakSamples 与 query.max-samples

> [CHANGE] PromQL: A range query whose `end` was not aligned to `step` caused
> subqueries inside it to evaluate past the parent's last actual step,
> inflating `peakSamples` in the query stats and against the `query.max-samples`
> limit, and wasting storage I/O reading samples that were never used in the
> result.

**这不是 bugfix,是「修正了一个被广泛依赖的错误行为」。** 影响:

- **`peakSamples` 统计下降** → query.max-samples 限制不再被错误触发
- **存储 I/O 下降** → 不再读取最终结果用不到的 sample
- **查询结果可能变化** → 如果你的查询依赖了「越界评估」的副作用,结果会不同

**PR #18606 对此的处理方式值得学**:实际的修复在 #18081 先落地了,#18598 是**补测试防止回归**。这是「修复」与「回归保护」分开成两个 PR 的良好实践。

### 14.2 start timestamp reset 判定的收紧

> [CHANGE] PromQL: Do not register a start timestamp reset if the start
> timestamp hasn't changed between subsequent samples.

之前即使 ST 没变也会注册一次 reset,导致 `rate()` 在某些边界情况下重复计数。**这是 ST 从「查询时猜测」走向「写入时事实」链条上的又一环** —— 元数据本身也需要被正确解读。

### 14.3 其他 PromQL 修复(节选)

| 修复 | 影响 |
|------|------|
| `info()` 富化在混合 `@`/offset 引用下用错时间戳 | 查询结果错误 |
| `info()` 输入系列用不同 label 子集 | 查询结果错误 |
| FastRegexMatcher 在捕获组紧邻字面量时误匹配 | 正则匹配假阳性 |
| `anchored` / `smoothed` 修饰符在 scrape gap 下 panic | **查询崩溃** |
| `@` 子查询作为非 step-invariant 调用的 matrix 参数 | 空结果 |
| histogram_stddev / histogram_stdvar 跳过 bucket | 计算错误 |
| `@ start()` / `@ end()` 在 range selector 前 | 现在被拒绝(对齐 `@ <ts>` 的既有行为) |

**这张表本身就是一份「PromQL 查询可靠性审计清单」** —— 如果你生产上有复杂的 PromQL,升级后应该重跑一遍关键告警规则的回归。

---

## 十五、写在最后

Prometheus v3.15.0 是一个「**还债版本**」。它没有任何一个功能是为了让你多看一眼 dashboard 的 —— 它修的是**协议的表达力上限**、**编码的语义能力**、**并发正确性**、**ID 空间的终局**。

如果用一句话概括这个版本的设计哲学,我认为是:

> **当一个系统的接口契约(文本格式 / chunk 编码 / ID 空间)是在它的目标场景还小的时候定下来的,那么它成熟后的每一次重大版本,本质上都是在「不动存储格式兼容性」的前提下,把这些契约的假设边界往外推。**

三个例子都是这个模式:
- **OM2** 没有推翻 0.0.4,而是在 Content-Type 协商里加了第二个选项,带 fallback
- **XOR2** 没有换 chunk 家族,而是在同一个 XOR 家族里加了 ST 能力,feature flag → 配置项
- **chunk ID 回绕** 没有扩 ID 字段(那会破坏 block 格式),而是把线性空间改成环形空间

**这与 2026 年基础设施层其他深度文章里反复出现的模式完全一致** —— 无论是 vLLM v0.30.0 把引擎重启变成 CUDA IPC 映射、containerd 2.4 用 EROFS warm cache 解耦烤镜像流水线,还是 Valkey 9.2 的 forkless RDB,大家都在「不动既有格式兼容性」的约束下做深度还债。

**关键洞察 6:v3.15 的三个「协议层」革新(OO2 / XOR2 / chunk ID 回绕)合起来,回答的是同一个问题 —— 当一个监控系统被部署了十年、数据量涨了 100 倍之后,「还能不能继续用」的答案不在于加多少新功能,而在于那些当年「够用」的假设还能撑多久。** Prometheus 用一个 minor version 回答了:还能撑,而且是用一种向后兼容的方式。

**这给所有做基础设施的人一个明确的行动项**:去 audit 你自己系统里那些「在 v1.0 时定下来、到现在没人敢动」的常量 —— 24 位 ID、8 字节长度、某个硬编码的数组上限。它们不是「永久有效的约束」,而是「尚未被突破的假设」。**在它们被突破之前找到它们,比被生产事故找到要好。**

---

## 数据来源

- Prometheus v3.15.0 release notes(GitHub Releases,published 2026-09-25T08:56:22Z)
- PR #18606 `model/textparse: implement OM2 scrape format`(含完整 lexer 定义 + benchmark 代码)
- PR #18091 `scrape: support scraping targets via Unix Domain Sockets`(closes #12024)
- PR #19461 `tsdb: stabilize the XOR2 float chunk encoding`
- PR #19216 / #19450 chunk ID 溢出模运算回绕(OOO + in-order)
- PR #19470 `tsdb: keep series with in-flight appends during eviction`
- PR #19664 `tsdb: preserve retired series chunks for active readers`
- PR #19700 `tsdb/agent: reset WAL buffers after write errors`
- PR #18843 `--auto-gomemlimit.refresh-interval`
- PR #19502 `scrape: support zstd-compressed responses`(fixes #13866)
- PR #19194 / #19435 / #19584 / #19396 / #19512 / #19418 服务发现 panic 修复
- OpenMetrics 2.0 规范 2.0.0-rc0(2026-03,prometheus.io/docs/specs/om/open_metrics_spec_2_0/)
- Prometheus `docs/feature_flags.md`(release-3.15 分支)
- Issue #13027 `Running out of disk space resulted in unrecoverable WAL error`(2023 年报,截至 v3.15 未修复)
