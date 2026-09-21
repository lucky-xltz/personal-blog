---
title: "GreptimeDB v1.2 / v1.3 深度拆解:当可观测性数据库开始为 Agent 设计查询接口 —— JSON2 结构化存储 + Prom Remote Write v2 + 实体关系语义层 + 5 大承重级革新 + 5 段实战代码 + 5 套可观测性方案 17 维度对比"
slug: "greptimedb-1-2-1-3-json2-semantic-layer-entity-graph-observability-2026"
date: 2026-09-21
category: 技术
tags:
  - GreptimeDB
  - 可观测性数据库
  - 时序数据库
  - JSON2
  - 语义层
  - 实体关系图
  - OpenTelemetry
  - OTLP
  - Prometheus Remote Write v2
  - Native Histogram
  - SQL/PGQ
  - DataFusion
  - Apache Arrow
  - Parquet
  - 对象存储
  - 存算分离
  - Agent RCA
  - LLM 排障
  - MCP
  - Flow
  - Rust
  - 云原生
  - 2026
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1639775167453-d4e11c2a2f06?w=600&h=400&fit=crop
excerpt: "GreptimeDB v1.2.1(2026-09-16)与 v1.3.0-alpha.1(2026-09-03)把可观测性数据库从「存遥测数据的列式库」改成了「为机器消费者设计的查询接口层」:JSON2 让日志列第一次可以被点路径 SQL 直接下钻,Prometheus Remote Write v2 把原生直方图变成一等公民,Table Semantic Layer + Entity Relationships RFC 让 Agent 不再靠猜列名排障。本文 5 大承重级革新逐一拆解:JSON2 结构化存储与 SWCS 压缩为什么能在 strict-window compaction 下把 Parquet 统计对齐回来;Remote Write v1 为什么对原生直方图「整包拒绝」而不是默写丢弃;语义层如何用 table_options 里一个保留命名空间把 OTLP 在入仓时丢掉的 instrument kind / temporality / unit / metadata_quality 全部补回来;实体图又为什么坚持「读时推导 + 不做图数据库」,用 4 层架构把 service call graph 变成一个 trace 自连接的 DataFusion 计划。配合 Agent RCA Bench 的 504 次实测(同模型同 prompt 只换查询接口:错误诊断少 40%、输入 token 低 48%、成本降 45%),以及 5 段可直接跑的 SQL / PromQL / Python 代码、5 套可观测性方案 17 维度对比、6 条 6-12 月可验证硬指标。"
---

# GreptimeDB v1.2 / v1.3 深度拆解:当可观测性数据库开始为 Agent 设计查询接口

> **一句话主旨**:2026 年的可观测性数据库竞争焦点,已经从「写入吞吐 / 压缩率 / 查询延迟」转到「**机器消费者能不能用一次查询拿到排障所需的全部上下文**」。GreptimeDB v1.2 / v1.3 的全部承重级改动——JSON2 结构化 JSON、Prom Remote Write v2、Table Semantic Layer、Entity Relationships Graph——都是同一件事的四个面:**把数据库自身变成 Agent 的查询接口层**,而不是让 Agent 在三个数据库之间自己拼上下文。

---

## §0 范围、版本与一手资料

### 0.1 本文覆盖的版本

| 版本 | 发布日期 | 定位 | 本文是否覆盖 |
|------|----------|------|--------------|
| **v1.2.0** | 2026-09-08 | 稳定版主版本(JSON2 / PRW v2 / Flow 可观测性 / Splunk HEC) | ✅ 重点 |
| **v1.2.1** | 2026-09-16 | 维护版(JSON2 compaction 数据丢失修复 + 查询正确性 + 稳定性) | ✅ 重点 |
| **v1.3.0-alpha.1** | 2026-09-03 | 预览版(实体关系图 M0+M1 / Native Histogram 查询覆盖) | ✅ 重点 |
| v1.3.0-alpha.1-nightly | 2026-09-07 | nightly 快照 | 顺带 |
| v1.1.x | 2026-06-18 | 上一稳定线(在线分区 / 语义层首发) | 背景 |

**为什么把一个维护版(v1.2.1)和主版本(v1.2.0)放一起讲**:**v1.2.1 修的 bug 是本文最有技术含量的部分之一**——JSON2 在 strict-window compaction 下因为 Parquet 统计量与投影(projection)错位而被错误剪枝,直接导致**已落盘数据丢失**。这恰恰是「结构化 JSON 存储」这个新特性在真实生产里踩的第一个坑,它把「列式存储里统计剪枝的边界在哪」这个一般性问题摆到了台面上。

### 0.2 一手资料清单

本文的技术细节全部来自以下一手文档(零二手转载),读者可按表核对:

| # | 资料 | 内容 | 获取方式 |
|---|------|------|----------|
| 1 | `GreptimeTeam/greptimedb` v1.2.0 release notes(53,770 字符) | 完整 changelog:JSON2 / PRW v2 / Splunk HEC / Flow Status / 6 个 breaking change | GitHub Releases API |
| 2 | `GreptimeTeam/greptimedb` v1.2.1 release notes(4,886 字符) | JSON2 数据丢失修复 + PromQL 正确性 + jemalloc 0.7 | GitHub Releases API |
| 3 | `GreptimeTeam/greptimedb` v1.3.0-alpha.1 release notes(24,307 字符) | 实体关系图 / Native Histogram 查询 / 语义表选项 | GitHub Releases API |
| 4 | `docs/rfcs/2026-05-28-table-semantic-layer.md`(Dennis Zhuang) | 语义层 RFC:`greptime.semantic.*` 词表 + `information_schema.table_semantics` | raw.githubusercontent |
| 5 | `docs/rfcs/2026-06-25-entity-relationships-and-graph-query.md` | 实体图 RFC:4 层架构 + 读时推导 + SQL/PGQ 路线 | raw.githubusercontent |
| 6 | `docs/rfcs/2026-08-04-native-histograms.md` | 原生直方图 RFC:协议决策 + PromQL 兼容 | raw.githubusercontent |
| 7 | `docs/rfcs/2024-08-06-json-datatype.md` | 旧 JSON(JSONB)类型 RFC:为什么它不够 | raw.githubusercontent |
| 8 | 仓库 README(15,805 字符) | 架构 / 部署模式 / 协议兼容矩阵 / 边界 | raw.githubusercontent |
| 9 | Issue #7685「GreptimeDB Roadmap 2026」 | v1.0 GA → v1.5 路线图与里程碑 | GitHub Issues API |
| 10 | Agent RCA Bench 官方报告(2026-09-11) | 504 次 Agent 排障实测:接口经济学 | greptime.com 博客 |

### 0.3 项目坐标(2026-09-21 快照)

| 维度 | 数据 |
|------|------|
| 仓库 | `GreptimeTeam/greptimedb` |
| 定位 | 开源可观测性数据库:metrics / logs / traces 一个列式引擎跑在对象存储上 |
| 许可证 | Apache-2.0 核心 + Enterprise License 外围(open-core) |
| 存储引擎 | Mito2(自研 region 引擎)+ Apache Parquet 文件 + Apache OpenDAL 数据访问抽象 |
| 查询引擎 | Apache DataFusion(分布式查询计划)+ PromQL 自研实现 |
| 内存模型 | Apache Arrow |
| 部署模式 | Standalone(单二进制)/ Distributed(Frontend / Datanode / Metasrv / Flownode 四组件) |
| 生产案例 | OceanBase Cloud:80+ 集群 / 300TB 日志,从 Loki 迁入后存储成本降 60%+ |
| Release 节奏 | stable(生产)/ canary(含预发布)/ nightly(main 周快照)三轨 |

---

## §1 问题的源头:为什么「存遥测数据」这件事在 2026 年不够了

### 1.1 三支柱架构的物理分裂,与它带来的「上下文搬运税」

过去十年,可观测性的事实标准是**三支柱(four pillars)分库存储**:Prometheus 存指标、Loki/ES 存日志、Tempo/Jaeger 存链路。这个划分在「人看仪表盘」的时代是合理的——仪表盘是预先画好的,查询是写死的,跨信号关联靠**人在浏览器里切换标签页**完成。

但 2026 年的主要消费者变了。**LLM Agent 做根因分析(RCA)**时,它没有浏览器,它只有工具调用。于是「跨信号关联」变成了一个必须由数据库直接回答的问题:

> 给定一个告警实体,它依赖谁?它们的遥测在哪?怎么一次拿到?

在三支柱架构下,Agent 需要:**(1)** 先查 Prometheus 的 `/api/v1/series` 猜指标名,**(2)** 再查 Loki 的 label 猜日志流,**(3)** 再查 Tempo 的 TraceQL 猜 span 过滤条件,**(4)** 然后在应用层把三份结果按时间戳和服务名拼起来。每一步都是一次「猜 + 试 + 截断」的往返。

**这不是性能问题,是接口经济学问题。** Greptime 自己的 Agent RCA Bench(见 §4.5)第一次把这件事量化了:在同样的 incident、同样的模型、同样的 prompt、同样的工具调用预算下,**只把查询接口从「Prometheus + Loki + Tempo 三套原生 API」换成「GreptimeDB 的 SQL + PromQL」,504 次调查的输入 token 就降了约 48%,错误诊断少 40%,单次调查成本从 ~$1.10 降到 ~$0.59。**

**关键洞察 1:** 在 Agent 时代,「查询接口返回的行数和 token 数」第一次成了数据库的核心指标,而不只是「网络流量」。一个返回 200 行跨信号 JOIN 结果的接口,比 3 个各返回 40 行但要 Agent 自己在上下文里 join 的接口便宜得多——因为**上下文是按 token 计费的,而且会随消息历史累积**。

### 1.2 第二个问题:遥测入仓时的「元数据沉默」

OTLP 协议在线上携带了丰富的元数据:instrument kind(counter / gauge / histogram)、temporality(cumulative / delta)、unit(UCUM 单位)、scope、resource 属性、语义约定版本。**但绝大多数遥测后端在把行写进表里的时候就全丢了**:

- 一个 `opentelemetry_traces` 表看起来和任何宽表一样,信号类型 / 来源 / 字段血缘只能靠命名猜;
- OTel→Prometheus 的翻译路径(v0.16+)主动丢掉 scope 属性和大部分 resource 属性,而且**表里不会记录「我丢了什么」**;
- Prometheus Remote Write v1 的 metadata 协议层面不可靠,下游表不会标明一个 counter 的类型是**声明**的还是从 `_total` 后缀**推断**的;
- 混合 temporality(OTel delta + Prometheus cumulative 落在同一张表)从 schema 完全不可恢复。

**这为什么重要?** 因为一个「推断出来的 counter」在被 `rate()` 之前应该被复核,一个 delta temporality 的 sum 不能直接做 cumulative 语义的 `increase()`。**所有下游消费者——告警生成器、仪表盘构建器、MCP server、ETL 管道、LLM agent——现在全都在靠列名猜这些。** 元数据在入仓时本来是有的,只是没人存下来。

### 1.3 第三个问题:结构化日志的「blob 困境」

日志是可观测性里体量最大、结构最差的部分。过去 GreptimeDB 的 JSON 类型(见 2024-08-06 RFC)实现为 **JSONB over Binary**:JSON 被编码成二进制 blob 整列存储。这带来三个直接后果:

1. **无法按字段建索引 / 无法按字段剪枝**——查 `attrs.http.status = 500` 必须把整个 blob 读出来解析;
2. **无法做 Parquet 列式统计剪枝**——blob 列的 min/max 统计对内部字段无意义;
3. **无法被查询计划器理解**——所有 JSON 内部字段的访问都退化成运行时 UDF 解析,而不是列扫描。

**在 Agent 场景下这个痛点被放大**:Agent 不知道日志里有哪些字段,它只能 `SELECT body FROM logs LIMIT 10` 先采样,在上下文里解析,再决定查什么。这直接就是 token。

### 1.4 一个被忽视的约束:对象存储成了主存储

GreptimeDB 从第一天就把 **S3 / GCS / Azure Blob 当主存储**(不是冷归档)。这个选择决定了后面所有优化方向:

- 存储成本极低 → 可以把 metrics / logs / traces **物理放一起**而不破产;
- 但对象存储的**访问成本不低**(每次 GET 都要列对象 + 读 range),所以**剪枝(pruning)质量就是性能**;
- 所以 v1.2 的 JSON2 特性核心不是「支持 JSON」,而是**「让 JSON 内部字段也能享受列式剪枝」**;
- 所以 v1.2.1 修的那个 bug 才那么严重:**剪枝错了就是数据丢失,不是慢**。

**这三个问题 + 一个物理约束,就是 v1.2 / v1.3 全部承重级改动的上下文。**

---

## §2 架构:一个引擎、四组件、一个表模型

### 2.1 表模型:tags / timestamp / fields

GreptimeDB 的**唯一表模型**是:tag 列(主键,用于 series 身份与索引)+ 一个 TIME INDEX 时间戳列 + field 列(数值负载)。Metrics、logs、traces **三种信号共享这一个模型**,差别只在列的语义。

这意味着:**跨信号关联在物理上就是一个 JOIN**,不需要跨进程、跨网络、跨查询语言。OTLP ingestion 把 span 写进 `opentelemetry_traces`、把日志记录写进 `opentelemetry_logs`,两张表都带 `trace_id`,所以「慢 span + 它里面的日志行」是一次查询:

```sql
SELECT t.service_name, t.span_name,
       t.duration_nano / 1000000 AS duration_ms,
       l.timestamp AS log_time, l.severity_text, l.body
FROM opentelemetry_traces t
JOIN opentelemetry_logs l ON l.trace_id = t.trace_id
WHERE t.timestamp > now() - INTERVAL '1' HOUR
  AND t.span_status_code = 'STATUS_CODE_ERROR'
ORDER BY t.duration_nano DESC
LIMIT 20;
```

**关键洞察 2:** 「all-in-one」的**结构性杠杆**不在「少装一个软件」,而在**关联发生在查询引擎内部**。在分裂架构里,实体目录(entity catalog)位于存储之上,要用应用代码缝合结果;在这里,关联是一个查询里的 join,拓扑是同一批表上的视图。

### 2.2 分布式部署:四个独立可伸缩的组件

| 组件 | 职责 | 有状态? |
|------|------|---------|
| **Frontend** | 协议入口(OTel / Prometheus / MySQL / PostgreSQL / gRPC / ES Bulk / Loki Push / InfluxDB line / Splunk HEC)+ 分布式查询引擎 | 无状态,水平伸缩 |
| **Datanode** | Region 引擎:WAL / memtable / SST / 缓存 / compaction / 索引;数据持久化到对象存储 | 有状态,弹性 |
| **Metasrv** | 元数据 / 路由 / 再分区 / 安全;底层可插拔 KV(etcd 或 RDS) | 有状态 |
| **Flownode**(可选) | 连续流计算(流式物化视图) | 有状态 |

**存算分离**:对象存储放数据,内存 + 本地磁盘缓存把最近和常查的数据拉近计算。这个架构直接对标的是「Thanos / Mimir 的长期存储 + 本地缓存」组合,但**它把缓存、WAL、compaction 都做进了 region 引擎(Mito2),而不是外挂一层 sidecar**。

### 2.3 协议兼容矩阵(入优于出,这是明确的产品取舍)

| 协议 | 兼容 | 不兼容 |
|------|------|--------|
| **Prometheus** | Remote Write 摄入(v1 + v2);PromQL 查询 | PromQL 覆盖有 gap,见官方兼容文档 |
| **Loki** | Push 摄入;通过 Grafana Alloy 双写可实现渐进切换 | LogQL 及其余 Loki 查询 API |
| **Elasticsearch** | `_bulk` 摄入(开源核心);QueryDSL 部分(企业版) | 其余 ES API |
| **OpenTelemetry** | OTLP metrics / traces / logs 摄入 | — |
| **Splunk** | HEC `/event` + `/raw` 端点(v1.2 新增) | — |
| **SQL 客户端** | MySQL wire(4002)/ PostgreSQL wire(4003,含 v1.2 新增 SCRAM 认证) | — |

**关键洞察 3:** 这个矩阵的设计哲学是 **「摄入兼容、查询方言化」**——迁移路径是「一次只切换一个信号的摄入,不用重建 collector」,但**查询层不承诺 100% LogQL / QueryDSL 兼容**。这是一个经过算计的取舍:让存量系统**先并行写入**(Loki 双写模式),再逐步把查询迁过来。代价是:LogQL 精通的工程师要学 SQL。

### 2.4 开源版 vs 企业版的边界(部署前必看)

**Apache-2.0 构建里包含**:集群部署、对象存储、Flow 引擎、全部摄入协议。

**企业版独占**:读副本(read replicas)、工作负载隔离(workload isolation)、**自动再分区(automated repartitioning)**、企业安全与治理、**soft-drop 表与恢复**(v1.2.0 起从 OSS 收回)。

> ⚠️ **v1.2 breaking change**:在 v1.2.0-beta1 里 soft-drop 是开源功能,beta2 起 OSS 的 metasrv 会**拒绝** `gc.experimental_soft_drop.enable = true`。从 beta1 升级前,必须先恢复需要的 soft-drop 表——**OSS 无法恢复或清除 beta1 已 soft-drop 的表,也不会清理其过期墓碑**。

---

## §3 五大承重级革新(逐一拆解)

按「承重级架构革新」的定义(改默认行为 / 解决历史遗留难题 / 引入新接口或协议 / 性能 ≥ 2x / 推动生态跟进,至少满足 3 项),v1.2 / v1.3 一共有 **5 项**——这是基础设施层深度文章的 sweet spot。

### 3.1 革新一:JSON2 —— 结构化存储的 JSON,带点路径 SQL 访问

**它解决了什么**:旧 JSON 类型的 blob 困境(§1.3)。

**核心改动**:JSON 数据不再作为整个 blob(JSONB)存储,而是**作为 struct 存储**。这带来一组之前不可能的能力:

- **SQL 点路径访问**:`attrs.http.status`(无需 UDF,无需解析 blob);
- **`json_get` 函数**:`json_get(attrs, 'http.path')`;
- **list 索引**:JSON 数组按下标取值;
- **空值与 NULL 语义**:`{}` 在插入时按 NULL 处理;
- **table-aware pipeline 转换**:日志管道可以把 JSON2 字段按表结构转换;
- **append_mode 表强制校验**:带 JSON2 列的表必须声明 `'append_mode' = 'true'`。

**完整用法**(v1.2.0 release notes 原例):

```sql
CREATE TABLE application_logs (
    ts TIMESTAMP TIME INDEX,
    attrs JSON2
) WITH (
    'append_mode' = 'true'
);

INSERT INTO application_logs VALUES
    (1, '{"http":{"status":200,"path":"/api/orders"}}');

SELECT
    attrs.http.status::BIGINT AS status,
    json_get(attrs, 'http.path')::STRING AS path
FROM application_logs;
```

**为什么必须 append_mode**:JSON2 的 struct schema 在 compaction 时需要按类型合并。**非 append 表上一次 compaction 可能同时看到不同 struct shape 的行**,这正是 v1.2.1 那个数据丢失 bug 的温床(见 §3.2)。

**承重级判定**:
- ✅ 引入新接口(点路径 SQL 是全新查询面);
- ✅ 解决历史遗留难题(JSONB 不可索引 / 不可剪枝);
- ✅ 推动生态(所有日志管道 / 仪表盘可以转向结构化日志查询);
- ✅ 潜在性能 ≥ 2x(列式剪枝 vs blob 全扫)。

### 3.2 革新二:JSON2 的 strict-window compaction 数据丢失 —— 一个值得单独讲的 bug

**这是 v1.2.1 最重要的修复,也是本文最有普遍教益的部分。**

**症状**:JSON2 数据在 compaction 期间丢失。

**根因链条**(PR #9129):
1. Parquet 文件按 row group 维护**统计量(min/max)**用于**谓词下推剪枝**;
2. 当查询带**投影(projection)**时,统计量在某些路径下**与实际投影后的列错位**;
3. strict-window compaction 依赖这些统计量判断哪些数据在窗口内;
4. 错位的统计量**错误地把 JSON2 数据剪掉了** → 数据丢失。

**修复**:
- #9129:修复投影下 Parquet 统计错位导致的错误剪枝;
- #9135:**compaction 时保留混合 JSON2 类型**(不再强行归一化);
- #9145:gRPC 原生 JSON2 行插入正确处理 SQL NULL(注意:这是服务端修复,客户端 SDK 支持在后续跟进)。

**普遍教益 —— 「剪枝的边界」**:

> 在所有把对象存储当主存储的列式库里,**剪枝(pruning)不是优化,是正确性的一部分**。任何「依赖文件级统计做过滤」的路径(compaction / 查询 / 索引),都必须保证**统计量与投影后的实际数据语义一致**。否则在 strict-window 这类「看不见的过滤」场景下,故障表现是**数据没了**,而不是查询慢了——这种故障比慢查询难发现一个数量级。

**v1.2.1 同时修复的其他正确性问题**(每一个都是生产级细节):

| 问题 | 修复(PR) |
|------|-----------|
| `count(*)` 在 online repartition 或 SPLIT PARTITION 后不正确 | #9154 |
| PromQL `rate()` 窗口对 counter reset 累加错误 | #9089 |
| PromQL `rate()` 跳过 NULL 样本时外推顺序错误 | #9118 |
| 混合 MIN/MAX 聚合应用了不完整的动态过滤器 | #9102 |
| MySQL 协议对带前导注释的 SQL 处理顺序(DataGrip 等 JDBC 客户端无法 introspect) | #9156 |
| jemalloc 0.7 线程缓存初始化导致崩溃 | #9103 / #9119 |
| CPU profiling 相关崩溃 → 换用 framehop unwinder | #9125 |

> ⚠️ **升级警告(v1.2.0 breaking change,未在 v1.2.1 修复)**:**使用 legacy `greptime.json` 类型的非 append 表,升级到 v1.2.0 后可能在 flush 或 compaction 时失败**。官方明确说明:这个问题在 v1.2.0 **未修复**。受影响表的正确做法是——**不要升级**,或者从旧版本环境**逻辑导出数据 + 在 v1.2.0 上新建表导入**;**不要拷贝旧表目录或元数据**;保留备份;在新表上**实际跑一遍 flush 和 compaction** 验证完整性后再切换。**只设 `append_mode` 不是可靠的补救措施。**

### 3.3 革新三:Prometheus Remote Write v2 + Native Histogram —— 「整包拒绝」的协议设计

**Remote Write v2 支持**(v1.2.0):GreptimeDB 可以接收 Prometheus Remote Write v2 请求,并通过 PromQL 查询原生直方图。

**启用方式**:

```toml
[http]
experimental_enable_prometheus_native_histogram = true
```

**Prometheus 侧配置**:

```yaml
remote_write:
  - url: http://greptimedb:4000/v1/prometheus/write
    protobuf_message: io.prometheus.write.v2.Request
```

**为什么这是承重级**:原生直方图(exponential histogram)是 Prometheus 2023 年以来的最大数据模型演进——**用动态分辨率的指数桶替代固定边界桶**,在长尾分位数查询上既省存储又保精度。但它对存储层提出了新要求:**一个 metric 的样本不再是 float,而是一个 struct**。

**GreptimeDB 的存储不变量**(native-histograms RFC):

> 在一个已解析的 catalog / schema / 物理表路由上下文里,**一个 metric 名恰好有一种持久化的样本类型**:float metric 用 `greptime_value`;native-histogram metric 用配置的原生直方图字段(默认 `greptime_native_histogram`)。**label 不改变这个选择。**

**最有意思的协议决策 —— Remote Write v1 的「整包拒绝」**:

> Remote Write v1.0 的标量样本继续支持。但任何 `TimeSeries.histograms` 字段都会让**整个请求**以 invalid-arguments 响应失败。

**为什么不是「忽略 histograms 字段、 ingest 其余样本」?** 因为那会造成**静默数据丢失**。在 protobuf 解码阶段整包拒绝,同时防止了两种故障:**(1)** 只发原生直方图的客户端数据全部丢失;**(2)** 一个混合标量与直方图 series 的请求被部分摄入(最难排查的状态)。

**承重级判定**:✅ 引入新协议(Remote Write v2)✅ 改默认行为(实验性默认关闭,但 v1 整包拒绝是硬约束)✅ 解决历史难题(原生直方图在 TSDB 里的持久化模型)✅ 推动生态(Prometheus 原生直方图生态的直接下游)。

### 3.4 革新四:Table Semantic Layer —— 用 table_options 里一个命名空间,补回入仓时丢的元数据

这是我认为**最有设计含量**的一项,因为它用一个极小的机制成本解决了一个很大的问题。

**机制**(三件套,全部复用已有 SQL 表面,**零新协议、零新 DDL 关键字**):

1. **`greptime.semantic.*` 表选项** —— 表级身份与血缘,装在现有的 `table_options` blob 里(和 `table_data_model` / `otlp_metric_compat` 同一个槽位);
2. **列 `COMMENT`** —— 列级补充(标准 SQL);
3. **`information_schema.table_semantics` 视图** —— 消费者侧的发现入口。

**词表(刻意做小)**:

| 分类 | Key | 示例 |
|------|-----|------|
| 通用 | `greptime.semantic.signal_type` | `trace` / `log` / `metric` / `event` |
| 通用 | `greptime.semantic.source` | `opentelemetry` / `prometheus` / `loki` / `elasticsearch` / `custom` |
| 通用 | `greptime.semantic.source_version` | Prometheus remote write `1.0` / `2.0` |
| 通用 | `greptime.semantic.pipeline` | `greptime_trace_v1` |
| Trace | `trace.conventions` | OTel `schema_url`,或 `mixed` / `unknown` |
| Metric | `metric.type` | `counter` / `gauge` / `histogram` / `summary` / `updown_counter` / `gauge_histogram` / `info` / `stateset` |
| Metric | `metric.unit` | UCUM:`s` / `By` / `{request}` |
| Metric | `metric.temporality` | `cumulative` / `delta` / `mixed`(仅 OTel) |
| Metric | **`metric.metadata_quality`** | **`declared`(OTLP / exposition)或 `inferred`(Prom RW v1 靠 `_total` 后缀猜)** |
| Metric | `metric.original_name` | Prometheus 化之前的 OTel 原名 |

**`metadata_quality` 是整个词表里最 load-bearing 的字段**:一个 `inferred` 出来的 counter,在 `rate()` 语义上下注前应该被复核。**这是给「置信度感知工具」用的**。

**刻意省略的 key,以及为什么**(RFC 里逐条给了理由,这是好设计的标志):

| 省略的 key | 理由 |
|-------------|------|
| `metric.monotonic` | 是 `type` 的函数 |
| `trace.has_events` / `has_links` | 对 v1 模型是常量,且可从 `span_events` / `span_links` 列推出 |
| `log.severity_scheme` / `log.body_format` | 常量 / 可采样得出,后者要 O(rows) 扫描 |
| `resource.attributes_preserved` | preserved 集合只是重述列 |
| `resource.attributes_dropped` | 无信息的布尔值;血统是 collector 配置关心的事,不是查询时语义 |

**设计原则**:**一个 key 只有在记录了「消费者无法廉价且可靠地自行恢复」的东西时,才配进入词表**。已经能从 metric 名约定推出的(`_total` / `_bucket` 后缀)、对唯一生产者是常量的、只是重述已有列的,一律不收。

**冲突与更新语义**(两个钉死的前置决策):
- **冲突**:长生命周期表可能看到多个来源的行,某些表级 key 无法表达真相 → v1 记 `mixed` 或 `unknown`,**而不是编一个单值**。下游必须把任何单值语义 key 当 best-effort,不当强证据。
- **更新**:语义选项在**建表时盖戳**,v1 不指定更新路径。`metadata_quality` 从 `inferred` 提升到 `declared` 属于后续 RFC。

**混合 temporality 的处理(一个真实的工程约束)**:生产环境从 cumulative 到 delta 的滚动切换,新老 exporter 会重叠,重试和延迟到达会延长重叠,**已保留的 cumulative 历史在集群收敛后仍必须可查**。所以在表级拒绝不同 temporality 会阻止原地迁移;把 delta 行路由到另一张表要么暴露不同的 metric,要么需要逻辑 union —— 还是缺一个 series 级的 temporality 判别符。**v1 的答案:保留一张表,把判别符存在 series 上** —— 每行带查询可见的 String tag `otlp_aggregation_temporality="delta"`,它是 series 身份的一部分,对 per-series `rate()` / `increase()` 是权威的;**表选项从不作为行级判别符使用**。

**发现入口(消费者的第一条 SQL)**:

```sql
SELECT table_catalog, table_schema, table_name, signal_type, source, pipeline
FROM information_schema.table_semantics;
```

返回每个语义标记表一行,核心列稳定 + `semantic_options` JSON 列携带其余 key 原文 + `entity_declarations` JSON 列列出该表贡献给图的实体。**新 key 进 JSON 列,不强制改视图 schema;只有广泛使用的 key 才被提升为一等列。**

**为什么不做新 DDL / 不做专表**(RFC 的 alternatives 分析):

| 方案 | 被否理由 |
|------|----------|
| 新 DDL 语法 `SEMANTIC trace WITH (...)` | 非标准,且逼每个客户端学新关键字;这点元数据不值得 |
| 专用 `_semantic` 系统表 | 给静态 per-table KV 双倍存储路径,还引入生命周期问题(drop / backfill) |
| 只用列 COMMENT | 发现(`WHERE signal_type='trace'`)退化成全文检索问题 |
| 全部编码进表名 | 就是现在的做法 —— 每加一个字段就多一条命名约定 |

**承重级判定**:✅ 引入新接口(`information_schema.table_semantics` 是全新查询面)✅ 解决历史遗留难题(入仓时丢的元数据)✅ 推动生态(RFC 明确说这个 shape 刻意贴近未来 OTEP 的 backend-catalog read API,且**承诺保持 shape 足够接近,使未来上游提案不强制 breaking 迁移**)。

### 3.5 革新五:Entity Relationships & Graph Query —— 「不做图数据库」的拓扑层

这是 2026-06-25 的 RFC,在 v1.3.0-alpha.1 里落地 M0+M1。它直接回答 §1.1 那个问题:**给定一个实体,它依赖谁,怎么拿到它们的遥测?**

**两个 load-bearing 决策**:

1. **GreptimeDB 不变成图数据库。** 实体和关系作为**表**暴露;图是已有数据上的**逻辑视图**,用 SQL 查(以后用 ISO SQL/PGQ 的 `GRAPH_TABLE` / `MATCH`)。**没有独立图存储,没有数据第二份拷贝。**
2. **图在读时推导。** `greptime_private.semantic_entities` 和 `greptime_private.semantic_relationships` 是**计算表**:扫描它们时实时从声明它们的遥测表派生行。**不需要物化,新实体在第一行落盘的瞬间就可见。**

**四层架构**:

```
Query (Layer 4)         │  SQL joins / WITH RECURSIVE 今天;          │
                       │  GRAPH_TABLE / MATCH 以后                   │
                       └───────────────┬─────────────────────────────┘
                                       │ reads
Exposure (Layer 2)     ┌───────────────▼────────────────────────────┐
                       │  greptime_private.semantic_entities         │ computed,
                       │  greptime_private.semantic_relationships     │ read-only
                       └───────▲────────────────────────────────────┘
                               │ derives at read time
Derivation (Layer 3)   ┌───────┴────────────────────────────────────┐
                       │  typed DataFusion plans:                    │
                       │  registry DISTINCT, trace self-join         │
                       └───────▲────────────────────────────────────┘
                               │ reads declarations + telemetry
Declaration (Layer 1)  ┌───────┴────────────────────────────────────┐
                       │  greptime.semantic.entity.* table           │
                       │  options on the telemetry tables            │
                       └────────────────────────────────────────────┘
```

**Layer 1 —— 声明实体身份**:三组 key(同样是 `greptime.semantic.` 命名空间,零新 DDL):

```
greptime.semantic.entity.<entity_type>.id          = 逗号分隔的列名
greptime.semantic.entity.<entity_type>.descriptive = 逗号分隔的列名   (可选)
greptime.semantic.entity.<entity_type>.scope       = 逗号分隔的列名   (可选)
```

**硬约束:`id` 列必须是 tag / 主键列**,这样身份保持可索引、可 join;埋在 JSON 属性包里的身份必须先通过 pipeline 投影成列。

```sql
CREATE TABLE app_request_latency (
  ts            TIMESTAMP(3) TIME INDEX,
  service_name  STRING,
  host_id       STRING,
  le            STRING,
  value         DOUBLE,
  PRIMARY KEY (service_name, host_id, le)
) WITH (
  'greptime.semantic.signal_type'       = 'metric',
  'greptime.semantic.entity.service.id' = 'service_name',
  'greptime.semantic.entity.host.id'    = 'host_id'
);
```

**零配置约定**(这是让图「开箱即用」的关键):

| 来源 | 自动推导出的实体 | 依据 |
|------|------------------|------|
| OTLP traces | `entity.service.id = service_name` | ingestion 路径建表时自动盖戳 |
| Prom 指标含 `job` | `service` | OTel↔Prom 兼容规范:`service.namespace`/`service.name` MUST 合并进 `job` |
| Prom 指标含 `job` + `instance` | `service.instance` | 同规范:`service.instance.id` MUST 转成 `instance` |
| Prom 指标含 `namespace` + `pod` | `k8s.pod` | kube-prometheus-stack relabel 约定 |
| Prom 指标含 `node` | `k8s.node` | 同上 |
| `kube_pod_info` | `k8s.pod runs_on k8s.node` | 同行 co-declaration 规则 |
| `kube_pod_owner` | `k8s.pod part_of k8s.workload` | 同上 |
| `target_info` | 富化 `service` 实体 | 同上 |

> ⚠️ **一个真实的连通性陷阱**:当 `service.namespace` 非空时,`job` = `<service.namespace>/<service.name>`,而 trace 表的默认身份是裸 `service_name`。**只有 `service.namespace` 为空且 `job` 没被 relabel 时,两派生的 service 节点才自动统一**;否则需要 pipeline 归一化或显式声明。**「图有多连通」取决于身份列对齐得多干净。**

**Layer 2 —— 两张计算表**:放在 `greptime_private` 而不是 `information_schema`,因为**扫描它们会触发对遥测表的真实推导**,这会打破 `information_schema` 「廉价元数据」的预期。**所有写路径上的 DDL/DML 都被拒绝。**

- `semantic_entities` = 节点集:每个**不同投影实体观察**一行,带观察窗口、类型与 id(+结构化 `entity_id_attrs`)、描述快照、`source_tables` 血统。**一个被三张表声明的实体,每个窗口至少三行。**
- `semantic_relationships` = 边集:每个 **(窗口, 边)** 一行,带端点、`rel_type`、`provenance`(`trace` / `attribute` / `declared` / `agent`)、`confidence`、`calls` 边的 RED 指标、JSON `attributes`。

**关系词表(小而带类型,且成对反向)**:

| `rel_type` | 含义(src → dst) | 主要 provenance | 反向(查询) |
|------------|-------------------|-----------------|-------------|
| `calls` | `service` 调用 `service` | trace | `called_by` |
| `runs_on` | `service.instance`/`process`/`k8s.pod` 跑在 `host`/`node` 上 | attribute | `hosts` |
| `contains` | `pod` → `container` | attribute/declared | `part_of` |
| `part_of` | `service.instance` → `service`,`k8s.pod` → `k8s.workload` | attribute/declared | `contains` |
| `depends_on` | 逻辑/声明的依赖 | declared | `dependency_of` |
| `owns` | 团队/service 拥有 dst | declared | `owned_by` |

**分层的原因**:`calls` 在**逻辑 `service`** 层;`runs_on` / `contains` 在**运行时 `service.instance` / `process` / `k8s.pod`** 层;`part_of` 连接两层。**这避免了「一个逻辑服务 runs_on 五台主机」这种错误拓扑。**

**Layer 3 —— 读时推导(技术内核)**:推导计划是**类型化的 DataFusion `Expr` / `DataFrame` 计划,不是 SQL 文本**——用户控制的标识符是纯值,没有引号 / 注入面;窗口谓词下推到源表扫描,享受文件 / 分区剪枝。**PoC 在 9 万–180 万行真实遥测上确认读时推导可行:一个 ~5.4 万行的边聚合约 31ms。**

**核心推导 —— service call graph** = 每个 `greptime_trace_v1` 表的自连接:client span 配对其子 server span,投影到 service 身份,按 60s 窗口聚合 RED 指标。它就是 Tempo service graph processor 与 OTel Collector `service_graph` connector 的 SQL 形态:

```sql
SELECT
  date_bin('60s', client."timestamp")               AS observed_at,
  'service'                                          AS src_type,
  client.service_name                                AS src_id,
  'service'                                          AS dst_type,
  server.service_name                                AS dst_id,
  'calls'                                            AS rel_type,
  'trace'                                            AS provenance,
  count(*)                                           AS request_count,
  count(*) FILTER (WHERE server.span_status_code = 'STATUS_CODE_ERROR')
                                                     AS error_count,
  sum(server.duration_nano) / 1e9                    AS duration_sum,
  count(*)                                           AS duration_count
FROM   otel_traces AS client
JOIN   otel_traces AS server
  ON   client.trace_id = server.trace_id
  AND  server.parent_span_id = client.span_id
WHERE  client.span_kind = 'SPAN_KIND_CLIENT'
  AND  server.span_kind = 'SPAN_KIND_SERVER'
  AND  client.service_name <> server.service_name
GROUP BY 1, src_id, dst_id;
```

**未插桩的对端变成虚拟节点**:没有匹配 server span 的 client span,会指向一个由 `peer.service` / `db.name` / `server.address` 命名的合成节点。

**推导契约(三条规范性原则,直接决定能否上生产)**:

1. **推导以调用者身份运行,绝不以内部超级用户。** 调用者读不了的源表被静默排除(其实体 / 描述属性 / `source_tables` 条目永不出现),join 派生的边需要读全部输入表的权限。**查计算表从不放大对底层遥测的访问。**
2. **源扫描窗口绝不窄于查询的 `observed_at` 范围。** 没有时间谓词 = 默认最后一小时;**计划器无法安全提取的谓词 = 报错要求显式范围,绝不静默回退到不完整结果。**
3. **窗口边界就是资源边界。** 裸 `SELECT * FROM semantic_entities` 最多扫声明表最后一小时;推导继承调用者的取消与 deadline,**不引入配额或溢出机制**。推导成本过高的大集群 → 去走物化(Future Work)。

**Agent 边(对本文主题的直接呼应)**:声明了 `agent` / `session` / `model` / `tool` 实体的 Agent 遥测表,像任何表一样进入注册表;span 结构推导出 `agent uses model` / `agent invoked tool` / `parent_agent calls agent` 边。Agent 还可以插入 `provenance = 'agent'`、`confidence < 1.0` 的边。**`provenance` 是边身份的一部分 → 一个 LLM 推断的边永远无法覆盖一个观测到的结构边。**

**Layer 4 —— 查询**:普通 SQL + `WITH RECURSIVE` 从第一天就能做多跳遍历(PoC 在真实 trace 树上走到深度 10,约 300 节点)。SQL/PGQ 是同一批数据上的人机工程学:因为 SQL/PGQ 要求 vertex key 唯一标识 vertex,而事实表每个窗口一行,所以属性图定义在 **snapshot relation** 上:`semantic_graph_snapshot(start, end)` 聚合查询范围,保证 **(1)** 每个 `(entity_type, entity_id)` 恰好一个 vertex;**(2)** 每条边的端点都在 vertex 集里(没有遥测派生行的端点被合成)。

```sql
CREATE PROPERTY GRAPH observability
  VERTEX TABLES (
    snapshot_entities
      KEY (entity_type, entity_id)
      LABEL entity PROPERTIES (entity_type, entity_id, scope, descriptive)
  )
  EDGE TABLES (
    snapshot_relationships
      KEY (src_type, src_id, rel_type, dst_type, dst_id, provenance)
      SOURCE      KEY (src_type, src_id) REFERENCES snapshot_entities (entity_type, entity_id)
      DESTINATION KEY (dst_type, dst_id) REFERENCES snapshot_entities (entity_type, entity_id)
      LABEL related PROPERTIES (rel_type, provenance, confidence, request_count, error_count, attributes)
  );

SELECT other_type, other_id, rel_type
FROM GRAPH_TABLE (observability
  MATCH (e IS entity WHERE e.entity_id = 'users')
        -[r IS related]-
        (o IS entity)
  COLUMNS (o.entity_type AS other_type, o.entity_id AS other_id, r.rel_type)
);
```

**执行计划**:`MATCH` 与 Cypher / GQL 共享 GPML 模式核心。定长模式重写成 joins,有界变长重写成有界 join 链 union(**没有新物理算子**);无界 / 最短路径在查询时从关系行构建临时内存 CSR(DuckPGQ 的做法)。

**为什么不做物化 / 不做图库(RFC 的 alternatives)**:

| 方案 | 被否理由 |
|------|----------|
| 默认物化图 | 读更便宜,但耦合摄入、引入 backfill 与生命周期管理、引入staleness、产生同一事实的第二份持久化表示。**读时推导赢在即时性与运维简单性;物化保留为大型部署的逃生舱。** |
| 真图数据库 / Apache AGE 式原生存储 | 双倍存储路径 + 复制已存在的数据。**目标是图「查询」,不是图「数据库」。** |
| 外挂 Cypher | 比 SQL/PGQ 重,且推向图存储模型;SQL/PGQ 在已有的 SQL 表面与计划器内交付同样的 MATCH 模式核心 |
| 只推导、不可声明 | 丢失没有 trace 的静态拓扑(ownership / 声明依赖),以及用户纠正错误推导边的能力 |
| 静态(非时间索引)关系模型 | 无法表达「事件发生时 14:23 的拓扑」,无法带边 RED 指标,需要外部过期机制 |

**承重级判定**:✅ 引入新接口(图查询面 + 未来 SQL/PGQ)✅ 解决历史遗留难题(跨信号拓扑要手 join)✅ 推动生态(MCP binding 已在 Future Work)✅ 性能(读时推导 + 文件剪枝下推,31ms 边聚合)。**这是 5 项里最「新」的一项——它定义了「可观测性数据库的读侧目录」这个品类。**

### 3.6 同期落地的其他重要改动

| 特性 | 说明 | 价值 |
|------|------|------|
| **Splunk HEC 摄入** | `/v1/splunk/services/collector/event` + `/raw` 端点,Splunk HEC 兼容客户端直接投递(#8321 / #8491) | 存量 Splunk 用户零改造迁移 |
| **Flow 运行时可观测性** | `SHOW FLOW STATUS` + `information_schema.flow_statistics`(#8392) | 流计算本身可观测 |
| **本地 SQL 文件访问沙箱化**(breaking) | standalone 下 `COPY` / 外部表路径限定在 copy root;分布式下本地路径禁用(#8708) | 安全;升级前必须迁移 |
| **PostgreSQL SCRAM 认证** | #8304,补齐 PG wire 的认证强度 | 生产可用性 |
| **MySQL 对象存储后端** | #8560 | 云上部署选择 |
| **`skip_wal` 可 ALTER TABLE 启用** | #8817 | 可调延迟 / 吞吐权衡 |
| **表级 `auto_flush_interval`** | #8357 / #8403 | 写放大控制 |
| **Import/Export Tool v2** | 并行分块 + 进度报告 + 状态路径覆盖(#8292-#8302) | 大规模数据迁移 |
| **字典编码 series key + 正确的正则过滤** | #8541 / #8688 | 高基数查询效率 |
| **RangeSelect 投影剪枝** | #8570 | 查询效率 |
| **专用 HTTP API 端口** | #8657 | 管控面隔离 |
| **HTTP bearer-token 认证** | #8719(v1.3-alpha) | API 安全 |
| **Dashboard v0.12.2 → v0.13.13** | 快照 / 可伸缩表格 / 全屏结果 / Trace 表选择 / 命令面板 | 内置体验 |

**被移除的东西**(升级前必须处理):
- `holt_winters` 函数移除 → 用 `double_exponential_smoothing`(#8457);
- `sparse_primary_key_encoding` 选项移除 → metric-engine 数据区默认稀疏主键编码,旧配置能加载但被忽略(#8470);
- **pipeline 整数转换不再静默回绕** —— 窄化现在检查目标范围,不匹配时走配置的 `on_failure` 行为(#8589)。

---

## §4 五段实战代码

### 4.1 代码一:本地起一个 GreptimeDB + OTLP 摄入 + 跨信号 JOIN

**起服务**(单命令,4 个端口:4000 HTTP / 4001 gRPC / 4002 MySQL / 4003 PostgreSQL):

```shell
docker run -p 127.0.0.1:4000-4003:4000-4003 \
  -v "$(pwd)/greptimedb_data:/greptimedb_data" \
  --name greptime --rm \
  greptime/greptimedb:latest standalone start \
  --http-addr 0.0.0.0:4000 \
  --grpc-bind-addr 0.0.0.0:4001 \
  --mysql-addr 0.0.0.0:4002 \
  --postgres-addr 0.0.0.0:4003
```

> 排障两条:连不上 → 检查 4000/4001/4002/4003 没被防火墙挡或占用;启动失败 → `docker logs greptime`。

**用 Python OTLP exporter 同时写 traces 和 logs**(两份遥测共享 `trace_id`,这是后面跨信号 JOIN 的物理基础):

```python
# pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp
from opentelemetry import trace, logs
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.sdk.logs import LoggerProvider, LoggingHandler
from opentelemetry.sdk.logs.export import BatchLogRecordProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.exporter.otlp.proto.http.log_exporter import OTLPLogExporter
import logging, random, time

trace.set_tracer_provider(TracerProvider())
trace.get_tracer_provider().add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(
        endpoint="http://localhost:4000/v1/otlp/v1/traces")))

logger_provider = LoggerProvider()
logs.set_logger_provider(logger_provider)
logger_provider.add_log_record_processor(
    BatchLogRecordProcessor(OTLPLogExporter(
        endpoint="http://localhost:4000/v1/otlp/v1/logs")))
logging.getLogger().addHandler(LoggingHandler(logger_provider=logger_provider))

tracer = trace.get_tracer(__name__)
logger = logging.getLogger("demo")

# 每个请求:一个 client span + 一个子 server span + 一条请求内日志
for i in range(500):
    with tracer.start_as_current_span("checkout", kind=trace.SpanKind.CLIENT) as c:
        c.set_attribute("service.name", "frontend")          # OTel 语义约定
        with tracer.start_as_current_span("process_order",
                                          kind=trace.SpanKind.SERVER) as s:
            s.set_attribute("service.name", "orders")
            time.sleep(random.uniform(0.001, 0.030))
            if random.random() < 0.08:                        # 注入 8% 错误
                s.set_status(trace.Status(trace.StatusCode.ERROR, "payment declined"))
                logger.error("order %d failed: payment declined", i)
            else:
                logger.info("order %d processed", i)
```

**跨信号 JOIN —— 找最慢的失败 span 及其请求内的日志行**(这就是三支柱架构下要三次 API 往返 + 应用层拼接的那件事):

```sql
SELECT
    t.service_name,
    t.span_name,
    t.duration_nano / 1000000.0                 AS duration_ms,
    l.timestamp                                 AS log_time,
    l.severity_text,
    l.body
FROM opentelemetry_traces t
JOIN opentelemetry_logs l ON l.trace_id = t.trace_id
WHERE t.timestamp > now() - INTERVAL '10' MINUTE
  AND t.span_status_code = 'STATUS_CODE_ERROR'
ORDER BY t.duration_nano DESC
LIMIT 20;
```

**调试技巧**:
- 摄入后先 `SELECT * FROM information_schema.tables WHERE table_name LIKE 'opentelemetry%'` 确认两张自动建的表;
- OTLP HTTP 端点的路径前缀是 `/v1/otlp/v1/...`,容易漏 `/v1`;
- 如果 JOIN 返回 0 行,先分别 `SELECT count(*) FROM opentelemetry_traces` 和 `opentelemetry_logs` 确认两边都有数据,再 `SELECT DISTINCT trace_id FROM opentelemetry_logs LIMIT 5` 看格式是否一致。

### 4.2 代码二:JSON2 结构化日志 + 点路径下钻

**建表 + 插入**(注意 `append_mode` 是 JSON2 表的硬要求):

```sql
CREATE TABLE application_logs (
    ts TIMESTAMP TIME INDEX,
    attrs JSON2
) WITH ('append_mode' = 'true');

INSERT INTO application_logs VALUES
    (1, '{"http":{"status":200,"path":"/api/orders","latency_ms":42}}'),
    (2, '{"http":{"status":500,"path":"/api/orders","latency_ms":2900}}'),
    (3, '{"http":{"status":200,"path":"/api/users","latency_ms":18}}'),
    (4, '{"http":{"status":503,"path":"/api/payments","latency_ms":120}}');
```

**点路径 + `json_get` 混合查询**:

```sql
-- 错误请求的路径与延迟分布
SELECT
    attrs.http.status::BIGINT                AS status,
    json_get(attrs, 'http.path')::STRING     AS path,
    attrs.http.latency_ms::DOUBLE            AS latency_ms
FROM application_logs
WHERE attrs.http.status::BIGINT >= 500
ORDER BY latency_ms DESC;
```

**对比旧 JSON(JSONB)写法**,体会「为什么 JSON2 是承重级」:

```sql
-- 旧方式:必须把整个 blob 读出来,用 UDF 在运行时解析
SELECT json_to_string(attrs) FROM application_logs_old;
-- 然后在应用层反序列化、过滤、聚合 —— 每一步都是 CPU,且无法走文件剪枝
```

**升级避坑(v1.2.0 / v1.2.1 的真坑)**:

```sql
-- ❌ 错误:非 append 的 legacy greptime.json 表不要直接升级
--    v1.2.0 已知 limitation:flush/compaction 可能失败,v1.2.1 未修
-- ✅ 正确迁移路径:
--    1. 旧版本环境 SELECT 导出
--    2. v1.2.0+ 上 CREATE TABLE ... WITH ('append_mode'='true') 用 JSON2
--    3. INSERT 导入
--    4. 在新表上实际跑一次 ALTER ... FLUSH + compaction,验证完整性
--    5. 不要拷贝旧表目录或元数据
```

**判断你受不受影响**:

```sql
-- 查所有非 append 的 JSON 列表
SELECT table_schema, table_name, column_name, data_type
FROM information_schema.columns
WHERE data_type LIKE '%JSON%';
-- 再对照它们的建表选项是否含 append_mode
```

### 4.3 代码三:Prometheus Remote Write v2 + 原生直方图端到端

**GreptimeDB 侧开启实验开关**:

```toml
# greptime.toml
[http]
experimental_enable_prometheus_native_histogram = true
```

**Prometheus 侧切换到 v2 协议**:

```yaml
# prometheus.yml
remote_write:
  - url: http://greptimedb:4000/v1/prometheus/write
    protobuf_message: io.prometheus.write.v2.Request   # 关键:换协议
    # v1 的写法(不传 protobuf_message)继续支持标量样本
    # 但带 histograms 字段的请求会被「整包拒绝」
```

**用 OTel 客户端发一个原生直方图(Python,累积 temporality)**:

```python
# pip install opentelemetry-api opentelemetry-sdk opentelemetry-exporter-otlp
from opentelemetry import metrics
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
import random

# 累积temporality + ExponentialHistogram 是硬约束;delta 会被拒绝
reader = PeriodicExportingMetricReader(
    OTLPMetricExporter(endpoint="http://localhost:4000/v1/otlp/v1/metrics"),
    export_interval_millis=5000)
metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
meter = metrics.get_meter("histo.demo")

# 指数桶:默认 schema,动态分辨率,长尾分位数查询又省又准
req_latency = meter.create_histogram(
    name="http.server.request.duration",
    description="request latency",
    unit="s")

for _ in range(2000):
    # 重尾分布:绝大多数快,极少数极慢 —— 这正是原生直方图的甜点场景
    req_latency.record(random.random() ** 8, {"route": "/api/orders"})
```

**用 PromQL 查询原生直方图(混合 classic / native 输入)**:

```promql
# v1.3.0-alpha.1 起支持:histogram_quantile 跨 classic + native 混合输入
histogram_quantile(0.99, sum(rate(http_server_request_duration_bucket[5m])) by (le))
# 原生直方图直接查询
histogram_quantile(0.99, http_server_request_duration)
histogram_fraction(0, 0.5, http_server_request_duration)
```

**踩坑清单(RFC 明确列出的「不做」)**:

| 场景 | 行为 |
|------|------|
| Remote Write **v1** 请求带 `histograms` 字段 | **整包失败**(invalid-arguments),不是静默丢 |
| OTLP **delta** temporality 的 ExponentialHistogram | **拒绝**(必须 cumulative) |
| OTel **Arrow** 格式的 ExponentialHistogram | **拒绝** —— Arrow wire 格式缺 `zero_threshold`,接受会静默改变分布 |
| OTLP scale > 8 | **降级到 schema 8**(合并冲突的稠密计数,**不可逆丢失桶间区分**) |
| OTLP scale < -4 | **拒绝** |
| 原生直方图 Remote **Read** | **deferred** —— 现有 Remote Read 只返回标量 |
| exemplar / min / max | 接收但**不持久化** |

**启用开关前先确认的 3 件事**:
1. **同 metric 名的样本类型互斥** —— float 用 `greptime_value`,histogram 用 `greptime_native_histogram`,**label 改不了这个选择**;
2. Remote Write v2 会在「两个 label set 用不同样本类型」时拒绝整个请求;
3. **持久化的 Struct 不保留原始 OTLP 点**,OTLP 只是传输层,查询只能走原生直方图语义。

### 4.4 代码四:语义层 + 实体图 —— 从「猜列名」到「查目录」

**第一步:发现哪些表被语义标记了(消费者的第一条 SQL)**

```sql
SELECT table_schema, table_name, signal_type, source, source_version, pipeline
FROM information_schema.table_semantics;
```

**第二步:补声明(只有非标准命名才需要,标准 OTLP/Prom-on-k8s 自动盖戳)**

```sql
-- 把业务指标表声明成 service + host 两个实体
ALTER TABLE app_request_latency SET (
  'greptime.semantic.entity.service.id' = 'service_name',
  'greptime.semantic.entity.host.id'    = 'host_id'
);

-- 声明 scope(注意:scope 不是身份的一部分,只是过滤/显示列)
ALTER TABLE app_metrics SET (
  'greptime.semantic.entity.service.id'     = 'service_name',
  'greptime.semantic.entity.service.scope'  = 'env'
);
```

**第三步:查实体注册表(「谁参与了这件事?」)**

```sql
SELECT entity_type, entity_id, source_tables
FROM greptime_private.semantic_entities
WHERE entity_type = 'service'
  AND observed_at >= now() - INTERVAL '15m';
-- 注意:一个被三张表声明的实体每个窗口至少三行
-- 消费者自己 DISTINCT:
SELECT DISTINCT entity_type, entity_id FROM greptime_private.semantic_entities
WHERE observed_at >= now() - INTERVAL '15m';
```

**第四步:查依赖边(之前不可能的那一步)**

```sql
SELECT dst_type, dst_id, request_count, error_count,
       duration_sum / NULLIF(duration_count, 0) AS mean_duration_s
FROM greptime_private.semantic_relationships
WHERE src_type = 'service' AND src_id = 'frontend'
  AND rel_type = 'calls'
  AND observed_at >= now() - INTERVAL '15m';
```

**第五步:多跳遍历(纯 SQL,从第一天就能用)**

```sql
WITH RECURSIVE impact AS (
    SELECT dst_type, dst_id, 1 AS hop
    FROM greptime_private.semantic_relationships
    WHERE src_id = 'frontend' AND rel_type = 'calls'
      AND observed_at >= now() - INTERVAL '15m'
    UNION ALL
    SELECT r.dst_type, r.dst_id, i.hop + 1
    FROM greptime_private.semantic_relationships r
    JOIN impact i ON r.src_id = i.dst_id
    WHERE r.rel_type = 'calls'
      AND r.observed_at >= now() - INTERVAL '15m'
      AND i.hop < 5                                        -- 有界深度
)
SELECT DISTINCT dst_id, min(hop) AS blast_radius
FROM impact
GROUP BY dst_id
ORDER BY blast_radius, dst_id;
```

**第六步:手工补一条声明边(保留 trace 观察不到的拓扑)**

```sql
INSERT INTO greptime_private.semantic_relationships_declared
    (observed_at, src_type, src_id, rel_type, dst_type, dst_id,
     provenance, scope, generation_id, confidence)
VALUES
    (now(), 'service', 'frontend', 'depends_on', 'service', 'users-db',
     'declared', '', '', 1.0);
-- provenance = 'declared' 的边与推导边「共存而非覆盖」
```

**推导契约的三条生产检查**:
1. **权限**:以调用者身份执行。查计算表前,确认调用者对源表有读权限——**否则实体被静默排除,且不会报错**;
2. **时间范围**:谓词必须能被计划器安全提取;不能提取会**报错要求显式范围**。不要靠默认值;
3. **资源**:裸 `SELECT * FROM semantic_entities` 至多扫最后一小时。要全量?走物化。

### 4.5 代码五:Agent RCA Bench —— 用代码复现「接口经济学」实验

这是把 §1.1 的论点变成可复现数字的部分。**Benchmark 的设计要点**:固定模型与 prompt,**只换查询接口**。

```python
"""
Agent RCA Bench 的可复现骨架(基于公开协议 rca-bench.greptime.com)

三个实验臂(Arm):
  - Split: Prometheus + Loki + Tempo 三套原生 API 的 tool wrapper
  - Raw:   只读 SQL + PromQL,打在 GreptimeDB 的 metric/log/trace 表上
  - Graph: Raw + table-semantics 检索 + semantic graph 查询工具

控制变量: 同一模型配置 / 同一 incident / 同一源遥测 / 同一工具调用预算
         调查方法与诊断契约在 system prompt 里 byte-identical
数据集:   OpenRCA / OpenRCA2 / RCA-100(14 个 incident)
规模:     6 个模型 × 14 个 incident × 2 次重复 × 3 臂 = 504 次
评分:     不用 LLM judge,correct counts 覆盖全部 run
"""
import json, subprocess, statistics

# v1.3.0-alpha.1 已实现的语义层检索工具(可作为 MCP 工具直接暴露)
SEMANTIC_TOOLS = {
    "search_table_semantics": """
        SELECT table_schema, table_name, signal_type, source, pipeline
        FROM information_schema.table_semantics
        WHERE table_name ILIKE '%' || $1 || '%'
    """,
    "query_semantic_graph": """
        SELECT dst_type, dst_id, rel_type, request_count, error_count,
               duration_sum / NULLIF(duration_count, 0) AS mean_s
        FROM greptime_private.semantic_relationships
        WHERE src_id = $1 AND observed_at >= now() - INTERVAL '15m'
    """,
}

def run_investigation(model: str, incident: str, arm: str) -> dict:
    """一次端到端调查:固定 model/prompt/数据/预算,只换查询接口。"""
    out = subprocess.run(
        ["rca-bench", "run", "--model", model, "--incident", incident,
         "--arm", arm, "--tools", json.dumps(list(SEMANTIC_TOOLS))],
        capture_output=True, text=True, timeout=1800)
    return json.loads(out.stdout)   # {correct: bool, input_tokens: int, tool_calls: int, cost_usd: float}

MODELS = ["gpt-5.6-sol", "deepseek-v4-pro", "claude-fable-5.1",
          "glm-5.3", "gemini-3.8-flash", "qwen3.8-max"]

results = {(m, a): run_investigation(m, "case_007", a)
           for m in MODELS for a in ("split", "raw", "graph")}

# 官方报告的核心数字(504 次,描述性总量,含错误调查)
def summarize():
    for m in MODELS:
        s, r = results[(m, "split")], results[(m, "raw")]
        print(f"{m:20s} split={s['correct']}/28 raw={r['correct']}/28 "
              f"input↓={100*(1-r['input_tokens']/s['input_tokens']):.2f}%")
    # 成本:168 次调查/臂,Split $183.95–187.39 vs Raw $98.37–100.50
    # ≈ $1.09–1.12 vs $0.59–0.60 per investigation
```

**官方实测结果(504 次)**:

| 模型 | Split 正确 /28 | Raw 正确 /28 | Raw 输入 token 降低 |
|------|----------------|--------------|---------------------|
| GPT-5.6-Sol | 13 | **22** | 53.00% |
| DeepSeek V4 Pro | 13 | **18** | 21.97% |
| Claude Fable 5.1 | 27 | 26 | 48.78% |
| GLM-5.3 | 10 | **14** | 27.07% |
| Gemini 3.8 Flash | 22 | **25** | 63.42% |
| Qwen3.8-Max | 20 | **25** | 24.40% |

**聚合**:Raw 168 次调查正确 **130** vs Split **105**(错误诊断少 40%);工具调用 6,129 vs 6,576(少 6.8%);累计输入 token 低约 48%;单次成本 **$0.59–0.60 vs $1.09–1.12**。6 个模型全部降低了输入 token,5 个提高了正确诊断数。

**统计严谨性(必须写清楚的边界)**:
- 12 个预定义 Raw–Split 端点中,**只有 3 个通过 Holm 校正**,全部是「输入降低」维度(Fable / Gemini / Qwen);
- 校正是按分别冻结的 4 模型与 2 模型队列(m=8 和 m=4)做的,**不是合并的 12 端点族**;
- 协议在 Git 里冻结并按 hash 绑定 artifact,**没有第三方注册**;
- 效率测试只纳入「两个诊断都正确 + 都引用了成功的非截断查询 + 无 runner 错误 + 没用尽预算」的对;合格重复对的差异先按 incident 取中位数,再做跨 incident 检验;
- **没有端到端效率端点通过校正**。

**语义层的双刃剑(官方自己的诚实结论)**:
- **检索任务**:35 个合格 model–incident 结果里,table discovery 返回行数**全部下降**;dependency retrieval 12 个里 11 个同时降低了行数和调用数;
- **端到端**:Graph 正确 **124** vs Raw **130**,**没有 Graph–Raw 效率端点通过校正**;
- **故障类型分裂**:Service component / dependency-edge 故障 106/120 → **112/120**(4/6 模型改善);**infrastructure node 故障 24/48 → 12/48**(下降)。

**关键洞察 4 —— 「工具回包塑造调查方向」**:在 node CPU 案例(Graph 臂)里,Fable 的第 21 次查询**已经返回了故障节点 CPU 从 ~6% 涨到接近 100% 的数据**,但它在最终答案里提到了这个证据**然后把它排除了**——理由是 checkout 的慢调用出现得更早,而 checkout 跑在另一个 CPU 正常的节点上。**48 个 Graph 调查里有 39 个收到了 `runs_on` / `part_of` 关系。**

> 官方原话: *"What a tool returns may influence what the model examines next. Once it takes a direction, later queries add more information about it, and the model may increasingly interpret new evidence through that explanation."*

**这句话是本文整个主题的反面注脚**:数据库把「哪些数据容易拿到」设计好了,Agent 就会被这些数据牵着走。**接口设计不只是成本问题,是认知引导问题。**

---

## §5 五套可观测性方案 17 维度对比

### 5.1 对比表一:存储后端方案对比(v1.2 时代)

| 维度 | GreptimeDB v1.2.1 | Prometheus + Thanos | Grafana Mimir | VictoriaMetrics | InfluxDB 3 Core |
|------|--------------------|----------------------|---------------|------------------|-----------------|
| **信号覆盖** | metrics + logs + traces 一引擎 | 仅 metrics | 仅 metrics | metrics(日志/trace 企业版) | metrics + logs(Enterprise) |
| **表模型** | tags / ts / fields 统一 | 时序 series | 时序 series | 时序 series | 表 + 列 |
| **查询语言** | **SQL + PromQL** | PromQL | PromQL | PromQL + MetricsQL | SQL(InfluxQL 兼容) |
| **存储底座** | **对象存储为主**(S3/GCS/Azure) | 对象存储(Thanos 侧) | 对象存储 | 本地 + 对象存储 | 对象存储 |
| **存算分离** | ✅ 原生 | 部分(Sidecar 拆分) | ✅ | 部分 | ✅ |
| **原生直方图** | ✅ RW v2 + OTLP(实验) | ✅(原生支持) | ❌ | 部分 | ❌ |
| **结构化 JSON 日志** | ✅ **JSON2 点路径 SQL** | ❌ | ❌ | ❌ | 部分 |
| **跨信号 JOIN** | ✅ **一次查询** | ❌ | ❌ | ❌ | ✅(同库内) |
| **实体/拓扑层** | ✅ **语义层 + 实体图(v1.3-alpha)** | service_graph connector | ❌ | ❌ | ❌ |
| **流处理** | ✅ Flow 引擎(OSS) | ❌ | ❌ | ❌ | ❌ |
| **部署模式** | standalone / 4 组件分布式 | 多 sidecar | 微服务 | 单二进制/集群 | 单节点/集群 |
| **压缩** | Parquet + 对象存储 | TSDB block | TSDB block | 自研 | Parquet |
| **协议兼容入** | OTLP/PromRW v1+v2/Loki/ES/InfluxDB/**Splunk HEC** | PromRW | PromRW | PromRW + InfluxDB | InfluxDB v1/v2 |
| **开源许可** | Apache-2.0(open-core) | Apache-2.0 | AGPLv3 | Apache-2.0(企业功能闭源) | MIT / Apache-2.0 |
| **生产规模案例** | OceanBase Cloud 80+ 集群 300TB 日志 | 广泛 | 广泛 | 广泛 | 中等 |
| **Agent 适配度** | **高(语义层 + 图 + SQL)** | 中(需外部拼接) | 低 | 中 | 中 |

### 5.2 对比表二:GreptimeDB 部署模式

| 维度 | Standalone | Distributed |
|------|------------|-------------|
| 目标场景 | 开发 / 小部署 | 生产 |
| 组件 | 单二进制 | Frontend + Datanode + Metasrv(+ Flownode) |
| 对象存储 | 可选(本地盘) | **推荐 / 必须** |
| 自动再分区 | — | **企业版** |
| 读副本 / 工作负载隔离 | — | **企业版** |
| 本地 SQL 文件访问 | 沙箱化(限定 copy root) | **禁用** |
| 元数据 KV | 内嵌 | etcd 或 RDS |
| 端口 | 4000/4001/4002/4003 | 按组件 |

### 5.3 对比表三:JSON 存储方案演进

| 维度 | 旧 JSON(JSONB / Binary) | **JSON2(v1.2)** |
|------|---------------------------|------------------|
| 存储格式 | 二进制 blob 整列 | **struct 结构化** |
| 字段访问 | UDF 运行时解析 | **SQL 点路径 + `json_get`** |
| 列式剪枝 | ❌ 不可能 | ✅ |
| Parquet 统计剪枝 | ❌ 无意义 | ✅(但见 §3.2 的错位陷阱) |
| list 索引 | ❌ | ✅ |
| 空值 / NULL | 不区分 | **显式语义** |
| 表类型约束 | 任意表 | **`append_mode = true`** |
| compaction 类型混合 | 不涉及 | **需保留混合类型(#9135)** |
| 插入路径 | MySQL/PG 自动转换 / `parse_json` | gRPC 原生行插入(#9145 修 NULL) |
| 已知风险 | 无(成熟) | **legacy 非 append 表升级可能失败(v1.2.0 未修)** |

### 5.4 对比表四:图/拓扑方案

| 维度 | GreptimeDB 实体图 | OTel Collector `service_graph` | Tempo service graphs | Backstage 软件目录 | 图数据库(Apache AGE) |
|------|--------------------|-------------------------------|----------------------|---------------------|---------------------|
| 数据存储 | **遥测表上的视图(零拷贝)** | 独立 metric | 独立存储 | 独立目录 | **独立存储(本 RFC 拒绝的模式)** |
| 时效性 | **第一行落盘即可见** | 有延迟 | 有延迟 | 手工维护 | 取决于同步 |
| 拓扑时间旅行 | ✅ **边是时间范围事实** | ❌ | 部分 | ❌ | ❌ |
| RED 指标随边 | ✅ | ✅ | ✅ | ❌ | ❌ |
| 声明边 + 推导边共存 | ✅ **provenance 在身份里** | ❌ | ❌ | 全声明 | n/a |
| 查询语言 | SQL + `WITH RECURSIVE`(+ SQL/PGQ 路线) | metric 查询 | TraceQL / API | GraphQL | Cypher |
| 跨信号关联 | ✅ **同引擎 JOIN** | ❌ | ❌ | ❌ | 需双写 |
| 权限模型 | ✅ **以调用者身份运行** | n/a | n/a | 独立 | 独立 |
| Agent 边 | ✅ `provenance='agent'` + `confidence<1.0` | ❌ | ❌ | ❌ | ❌ |

### 5.5 对比表五:RCA 查询接口(来自 Agent RCA Bench)

| 维度 | Split(Prom+Loki+Tempo) | Raw(GreptimeDB SQL/PromQL) | Graph(Raw + 语义层) |
|------|--------------------------|------------------------------|----------------------|
| 168 次调查正确数 | 105 | **130**(+24%) | 124 |
| 错误诊断 | 基线 | **-40%** | -29% |
| 累计输入 token | 基线 | **-48%** | 下降但语义工具**增加**输入(Fable 中位数 +7,129 tokens) |
| 工具调用 | 6,576 | **6,129**(-6.8%) | 369 次 graph 工具调用 / 168 次 |
| 单次成本 | $1.09–1.12 | **$0.59–0.60**(-45%) | 介于两者之间 |
| PromQL 使用 | 160 次 | **仅 22 次**(模型选 SQL) | 同 Raw |
| 跨信号 JOIN | 罕见(应用层) | **192 次成功 JOIN,仅 3 次跨信号类型** | 同 Raw |
| 通过校正的端点 | 基线 | **3 个(全是输入降低)** | **0 个** |
| node 故障正确率 | — | 24/48 | **12/48(下降)** |
| 依赖边故障正确率 | — | 106/120 | **112/120(上升)** |
| 最强方向 | 传统团队熟悉 | **token 经济学** | 聚焦检索、行数少 |
| 最弱方向 | token 浪费 + 需拼接 | 仍然要会 SQL | **可能误导调查方向** |

**关键洞察 5 —— 「跨信号 JOIN 比想象的少」**:在 336 次 Raw / Graph 调查里,192 次成功 JOIN 主要是**同信号内**配对(trace 内 span、metric 表之间),**只有 3 次join了不同信号类型**。**统一存储的最大收益不是「跨信号 JOIN 变多」,而是「同信号内的比较可以在查询里完成,不用把大结果集塞进上下文」。** 大结果会作为消息历史在后续请求里重复出现,累积输入 token。

---

## §6 六条 6-12 个月可验证硬指标

> 每一条都是**今天就能跑代码复现**的,不是路线图承诺。

**指标 1:JSON2 点路径查询 vs JSONB blob 扫描的延迟差**
在同样 1000 万行日志上,`WHERE attrs.http.status::BIGINT >= 500` 的 JSON2 查询 vs 旧 JSONB「全读 + 应用层解析」。预期 JSON2 显著更快(列式剪枝 + 统计可用)。**验证方法**:两张表同样数据,`EXPLAIN ANALYZE` 对比 scanned rows / pruned files。

**指标 2:JSON2 strict-window compaction 零数据丢失**
v1.2.1 上,构造混合 JSON2 struct shape 的 append 表,跑 strict-window compaction,比对 compaction 前后 `count(*)` 与校验和。**必须为 0 差异**。这是 §3.2 那个 bug 的直接回归测试。

**指标 3:实体图读时推导延迟**
在 90 万–180 万行真实遥测上(论文 PoC 规模),带 15 分钟窗口的 `SELECT * FROM greptime_private.semantic_relationships WHERE src_id = 'X'`。**预期边聚合约 31ms 量级**(PoC 数据:~5.4 万行边聚合 ~31ms)。**边界**:裸查(无时间范围)最多扫最后一小时。

**指标 4:Agent RCA 接口经济学的可复现**
按 §4.5 的协议跑 6 模型 × 14 incident × 2 重复 × 3 臂 = 504 次。**可复现的硬数字**:Raw vs Split 输入 token -48%、错误诊断 -40%、单次成本 $0.59–0.60 vs $1.09–1.12。**统计边界**:只有输入降低维度通过 Holm 校正。

**指标 5:Remote Write v2 整包拒绝的行为契约**
发一个 Remote Write **v1** 请求但带 `TimeSeries.histograms` 字段 → **必须整包 invalid-arguments 失败**;发 OTLP delta ExponentialHistogram → **必须被拒绝**;发 OTel Arrow ExponentialHistogram → **必须被拒绝**。**这三个「拒绝」是数据安全的正确性测试,不是功能缺失。**

**指标 6:OceanBase Cloud 规模基准**
公开案例:80+ GreptimeDB 集群、管理 **300TB 日志**、从 Grafana Loki 迁入后**存储成本降 60%+**。**验证方式**:按 TSBS benchmark(`docs/benchmarks/tsbs`)与 JSONBench(十亿记录冷跑第一)在自有数据规模上复现趋势。

---

## §7 六条 6-12 个月可观察未来信号

**信号 1:v1.3 正式版的实体图 M2(快照关系 + SQL/PGQ)**
v1.3.0-alpha.1 已落 M0+M1(声明 + 读时图)。M2 = `semantic_graph_snapshot(start, end)` + `CREATE PROPERTY GRAPH` + `GRAPH_TABLE`/`MATCH` + **MCP 工具面**。**观察点**:单跳 MATCH 是否如期 rewrite 成 join,有界变长是否成为 bounded union of join chains(无新物理算子)。**这是「SQL 里长出图查询」的品类验证时刻。**

**信号 2:语义层走向上游标准(OTEP)**
语义层 RFC 明确说:OTel 标准化了 producer 侧,**读侧(backend 暴露给客户端的目录 API)刻意留给厂商**;OTLP 单向、OpAMP 管 agent、OTEP-0243 是 producer 侧、`schema_url` 有去无回。**GreptimeDB 承诺保持 shape 足够接近未来 OTEP,不强制 breaking 迁移。** 观察点:OTel 社区是否出现 backend-catalog read API 的 OTEP 提案。

**信号 3:Remote Write 2.0 的 metadata 持久化**
RFC 明确:只用 table_options 不够(metadata-only 写、后续更新、已存在表都不走 auto-create);内存 registry 重启丢数据。**推荐后续:以 catalog / schema / metric family 为 key 的持久化 registry**,由 Remote Write v1 metadata-only 请求与 v2 per-series metadata 填充。**观察点**:这个 registry 是否落地,以及 `metadata_quality = declared` 的比例是否随 v2 普及上升。

**信号 4:Roadmap 2026 的 v1.4 / v1.5 交付**
| 版本 | 计划 | 状态 |
|------|------|------|
| v1.3 | Metric Engine 优化 / Compaction 优化 / ~~向量索引与 AI 函数~~(已划掉) | alpha 中 |
| v1.4 | **自适应资源管理 Phase 1** / Auto Rollup / Flow 增强 / Major compaction | Q3 |
| v1.5 | **自适应资源管理 Phase 2** / Remote Compaction&Indexing 生产就绪 / Log context search / **开放表格式兼容(Iceberg/DeltaLake)** | Q4 |
**信号点**:v1.5 的「Iceberg/DeltaLake 兼容」会把它推进湖仓一体竞争;自适应资源管理(细粒度内存追踪 / 成本自适应调度 / 零调优 spill / 自适应缓存 / workload 感知 compaction 调度 / 资源配额与准入控制)是它对「对象存储为主存储」这个选择的长期还债。

**信号 5:RCA Bench 反向影响接口设计**
官方报告最后说: *"could making one kind of information easier to obtain lead the model to spend too long on one kind of explanation?"* —— 他们明确要继续测**查询接口是否塑造模型的调查注意力**。**观察点**:node 故障从 24/48 掉到 12/48 这个结果,会不会反向改变语义工具的默认返回(比如不过度强调服务依赖边)。

**信号 6:Agent 遥测进入图的一等公民**
RFC 明确支持 `agent` / `session` / `model` / `tool` 实体声明与 `agent uses model` / `agent invoked tool` / `parent_agent calls agent` 边,且 Agent 自身可插 `provenance='agent'`、`confidence<1.0` 的推断边。**观察点**:随着 OTel GenAI 语义约定普及,**「AI 系统的可观测性图」会不会成为比基础设施拓扑更大的用例**——因为 agent 系统的拓扑比微服务更动态、更不可预测。

---

## §8 总结与最佳实践

### 8.1 ✅ 该用

1. **metrics + logs + traces 要在一个引擎里关联查询** —— 这是结构性杠杆,不是「少装软件」。OceanBase Cloud 的 300TB 日志案例是规模证据。
2. **日志有结构化字段且需要按字段下钻/建索引** —— JSON2 的点路径 SQL 是唯一不退化成 blob 全扫的选项。
3. **需要 SQL(不只是 PromQL/LogQL)表达复杂排障查询** —— 跨信号 JOIN / 窗口聚合 / 递归遍历在一个引擎里完成。
4. **对象存储当主存储、长保留、成本敏感** —— Parquet on S3 + 本地缓存。
5. **给 LLM agent 做排障工具(RCA / 告警自愈)** —— 语义层 + 实体图直接削减 token 与错误率。这是 2026 年最匹配的品类。

### 8.2 ❌ 千万别用

1. ❌ **不要用 v1.2.0 的 legacy `greptime.json` 非 append 表直接升级** —— 已知 flush/compaction 失败,v1.2.1 未修。走逻辑导出 + 新建表。
2. ❌ **不要让 Remote Write v1 客户端发原生直方图** —— 整包拒绝。要么升 v2 协议,要么保持标量。
3. ❌ **不要给 OTLP 发 delta temporality 的 ExponentialHistogram** 或 **OTel Arrow 格式** —— 前者要求 cumulative,后者缺 `zero_threshold`。
4. ❌ **不要裸 `SELECT * FROM greptime_private.semantic_entities`** —— 最多扫最后一小时,且不做去重会拿到每个声明来源一行。
5. ❌ **不要以为 `job` 和 `service_name` 会自动对齐** —— `service.namespace` 非空或 `job` 被 relabel 时,指标派生与 trace 派生的 service 节点**不会合并**,需要显式声明或 pipeline 归一化。
6. ❌ **不要依赖 OSS 版的 soft-drop / 自动再分区 / 读副本** —— v1.2.0 起 soft-drop 与恢复是企业功能;自动再分区与读副本也是。
7. ❌ **不要把 `information_schema.table_semantics` 当强证据** —— 单值语义 key 在多源表上是 `mixed` / `unknown`,是 best-effort。

### 8.3 五步生产部署 checklist

**Step 1 —— 版本与升级评估**
- [ ] 确认在 v1.2.1(不是 v1.2.0),JSON2 compaction 修复已包含
- [ ] 排查 legacy `greptime.json` 非 append 表 → 逻辑导出 + 新建 JSON2 append 表 + 实跑 flush/compaction 验证
- [ ] 检查 breaking changes:`holt_winters` → `double_exponential_smoothing`;移除 `sparse_primary_key_encoding`;pipeline 整数不再静默回绕(改走 `on_failure`);本地 SQL 文件路径沙箱化
- [ ] 从 v1.2.0-beta1 升级 → 先恢复所有 soft-drop 表(OSS 将无法恢复)

**Step 2 —— 部署拓扑**
- [ ] Standalone(开发/小部署)vs Distributed(Frontend / Datanode / Metasrv / Flownode)
- [ ] 对象存储 bucket + IAM 权限;内存 / 本地盘缓存大小规划
- [ ] Metasrv KV 选型(etcd vs RDS)
- [ ] 端口规划:4000 HTTP / 4001 gRPC / 4002 MySQL / 4003 PostgreSQL(或专用 HTTP API 端口 #8657)
- [ ] 认证:PostgreSQL SCRAM(#8304)/ HTTP bearer token(v1.3-alpha #8719)

**Step 3 —— 摄入管道**
- [ ] 优先 OTLP(metrics/traces/logs 统一入口),享受自动语义盖戳
- [ ] Prometheus 用户:Remote Write v1 保留,需要原生直方图才升 v2 + 开 `experimental_enable_prometheus_native_histogram`
- [ ] Splunk 存量:走 HEC `/event` + `/raw` 端点
- [ ] Loki 存量:Grafana Alloy 双写做渐进切换
- [ ] 日志:JSON2 + `append_mode='true'`,通过 pipeline 投影身份列(为实体图做准备)

**Step 4 —— 查询与语义层**
- [ ] `SELECT * FROM information_schema.table_semantics` 确认自动盖戳覆盖面
- [ ] 非标准命名的表补 `greptime.semantic.entity.<type>.id` 声明(**id 列必须是 tag/主键**)
- [ ] 检查 `job` / `service_name` 是否对齐(`service.namespace` 是否为空、`job` 是否被 relabel)
- [ ] 验证推导契约:调用者对源表的读权限;时间范围谓词能被计划器提取
- [ ] SQL 客户端:MySQL wire(4002)或 PostgreSQL wire(4003)

**Step 5 —— 可观测性之上**
- [ ] Grafana data source 插件 + 官方 Grafana dashboard
- [ ] `SHOW FLOW STATUS` / `information_schema.flow_statistics` 监控 Flow
- [ ] region 读负载 / 远程动态过滤器指标(#8316 / #8309)纳入告警
- [ ] 若做 Agent RCA:暴露 `search_table_semantics` + `query_semantic_graph` 为 MCP 工具;**监控语义工具的输入增量**(Fable 中位数 +7,129 tokens),并留意 §4.5 的「工具塑造调查方向」效应
- [ ] 升级留出验证窗口:跑 query regression harness(#8406)对比版本间性能

### 8.4 五条 best practice

1. **把「剪枝正确性」当一等测试目标。** 对象存储为主存储的列式库里,compaction / 查询 / 索引任何依赖文件级统计的过滤路径,都要测**投影后统计与数据语义一致**。故障表现是数据没了,不是慢了。
2. **协议边界宁「整包拒绝」勿「静默丢弃」。** Remote Write v1 对 histograms 的处理是教科书级示范:静默 partial ingestion 是最难排查的故障模式。你自己设计协议适配层时也照这个来。
3. **元数据机制要「最小化 + 复用已有表面」。** 语义层没有新协议、没有新 DDL 关键字,只用了 table_options 的保留命名空间 + 列 COMMENT + 一个 information_schema 视图。**一个 key 只有在消费者无法廉价自行恢复时才配进词表。**
4. **拓扑层要做「视图」不要做「图数据库」。** 读时推导 + 零拷贝 + 时间范围事实,换来的是即时性(新实体第一行落盘即可见)与无 staleness;代价是推导成本,用窗口边界当资源边界,物化留作逃生舱。
5. **测接口经济学,不只测性能。** Agent 时代要测:同一模型 + 同一 prompt,换查询接口后 **输入 token / 工具调用 / 正确率 / 成本** 的差异。同时诚实报告校正结果与负面发现(node 故障 24→12)。

---

## 写在最后:三个长期判断

**判断一:可观测性数据库的竞争焦点已经从「存储」转向「读侧目录」。**
过去十年的竞争是写入吞吐、压缩率、查询延迟。v1.2 / v1.3 这批改动说明:**谁能让 Agent 用最少的 token 拿到排障全上下文,谁就赢**。语义层(表级身份 + 入仓时丢的元数据)与实体关系图(跨信号拓扑)本质上是同一件事的两半——**把「发现成本」从应用层搬进数据库**。Greptime 的 RFC 甚至说这份 shape 刻意贴近未来 OTEP 的 backend-catalog read API。**我赌 2027 年 OTel 社区会出现读侧目录的正式提案**,而「语义层 + 实体图」会成为所有可观测性后端的标配层。

**判断二:统一存储的最大收益被误解了——不是「跨信号 JOIN 变多」。**
Agent RCA Bench 的真实数据打脸了这个直觉:336 次调查里 192 次成功 JOIN,**只有 3 次 join 了不同信号类型**。真正的收益是**「同信号内的比较在查询里完成,大结果不进上下文」**。这个发现反过来指导接口设计:**应该优先优化「让一次查询返回可直接消费的小结果」,而不是鼓励跨信号 JOIN**。

**判断三:Agent 时代,数据库的接口设计是一种「认知引导」,需要被当作安全相关的设计来对待。**
RCA Bench 里最发人深省的细节:工具已经返回了故障节点的 CPU 曲线,Agent 还是把它排除了,因为更早的 checkout 慢调用把它带偏了。**接口让什么数据「容易拿到」,就塑造了 Agent 的调查方向**;一旦选了方向,后续查询都在为这个解释添砖加瓦。这不只是成本问题——**它是 2026 年 AI 系统的新一类失败模式,而且发生在数据库层,不在模型层**。未来 12 个月,我认为「查询接口的注意力经济学」会成为可观测性 + Agent 交叉领域最值得投入的研究方向,而不是更大的模型或更长的 prompt。

---

## 数据来源

**一手(GreptimeDB 仓库)**:
- v1.2.0 / v1.2.1 / v1.3.0-alpha.1 release notes(GitHub Releases API)
- `docs/rfcs/2026-05-28-table-semantic-layer.md`(Dennis Zhuang)
- `docs/rfcs/2026-06-25-entity-relationships-and-graph-query.md`
- `docs/rfcs/2026-08-04-native-histograms.md`
- `docs/rfcs/2024-08-06-json-datatype.md`
- 仓库 `README.md`(架构 / 协议矩阵 / 边界 / 生产案例)
- Issue #7685「GreptimeDB Roadmap 2026」

**一手(Agent RCA Bench)**:
- 《Same Telemetry, Different Query Interfaces: Results from 504 Agent RCA Runs》(2026-09-11,greptime.com)
- rca-bench.greptime.com(公开代码 / 协议 / artifact)

**协议与标准**:
- Prometheus Remote Write 1.0 / 2.0 规范
- OpenTelemetry:OTLP / 语义约定 / Entity 数据模型 / Prometheus 兼容规范 / OpAMP / OTEP-0243 / Weaver
- UCUM 单位代码
- ISO SQL/PGQ(`GRAPH_TABLE` / `MATCH`);DuckPGQ(VLDB'23);Spanner Graph

**生态对照**:
- OTel Collector `service_graph` connector / Tempo service graphs / Grafana Asserts / Backstage / New Relic / Datadog / ServiceNow CSDM / Apache AGE

**基准**:
- TSBS(`docs/benchmarks/tsbs`)/ JSONBench 十亿记录冷跑第一 / OceanBase Cloud 80+ 集群 300TB 日志案例
