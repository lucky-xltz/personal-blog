---
title: "RisingWave v3.1.0 深度拆解：VARIANT 一等公民、REPLACE SINK 原子切接、no-shuffle 回填收敛与 Hummock 变更日志解耦"
slug: risingwave-3-1-variant-replace-sink-backfill-hummock-decouple-2026
date: 2026-10-11
category: 技术
tags: [RisingWave, 流处理, 流式数据库, VARIANT, Parquet Variant, Iceberg, REPLACE SINK, no-shuffle backfill, snapshot backfill, Hummock, LSM, xor filter, compaction, 水印, watermark, GAP_FILL, 时间旅行, CDC, PostgreSQL CDC, Kafka, serverless backfill, 资源组, 资源隔离, Rust, async trait, 对象存储, 湖仓一体, 后端架构, 分布式系统, 2026]
excerpt: "RisingWave v3.1.0 是一个「不换骨架换契约」的版本：366 个 PR 里 feat 只占 78 条，绝大部分改动在把过去「能跑但没说清楚」的隐含约定逐条翻译成显式契约。VARIANT 成为一等类型，底层直接用 Parquet/Iceberg Variant 二进制编码，并把 NaN 折叠成单个规范 quiet-NaN、-0.0 归一到 +0.0、对象字段字典排序，让「逻辑等价」真正等于「字节相等」。REPLACE SINK 用一条 DDL 完成「建新 sink → 一个 barrier 改派上游 → 冲刷排空旧 sink 日志 store → 删旧 actor → 后置原子换 catalog」，替换再也不用先 drop 再 create。回填路径收敛：no-shuffle backfill 创建被废弃，规划器优先 SnapshotBackfill 并回退 ArrangementBackfill，谓词下推进快照回填，快照回填 epoch 在 time travel vacuum 期间被 pin 住不被误删。Hummock 把 table change log 从 version checkpoint 里剥出来变成独立 delta，旧字段标记 deprecated 但兼容读取并打 warn，versioning 锁拆成「持读锁快照 → 无锁持久化 → 持写锁更新内存」三段。本文 5 段可运行代码 + 5 套流处理方案 17 维度对比 + 6 条硬指标 + 5 步生产升级 checklist + 8 个诚实边界。"
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1633356122544-f134324a6cee?w=600&h=400&fit=crop
---

# RisingWave v3.1.0 深度拆解：VARIANT 一等公民、REPLACE SINK 原子切接、no-shuffle 回填收敛与 Hummock 变更日志解耦

## 〇、一句话主旨与三层穿透

早间 AI 日报讲的是「刹车装在谁的脚下」——微软要求把模型当已被入侵的黑箱、要求编排层与模型层分离、要求每次有意义的动作都留下防篡改证据。中午这篇讲的是同一件事在流处理引擎里的落地：**v3.1 把「隐含约定」逐条改写成「显式契约」**。

RisingWave 是用 Rust 写的流式数据库（streaming database），把「流处理」做成「写 SQL、物化视图自动维护、状态存在 Hummock LSM 引擎里」的形态。v3.1.0 发布于 2026-09-21，从 v3.0.4 起 366 个 PR。它不是一个加新骨架的版本——78 条 feat、191 条 fix、27 条 refactor、4 条 perf，**没有新的子系统，全是把已有子系统的边界讲清楚**。

这跟「承重级 release notes」的信号判据完全吻合：release notes body 56,770 字节，在同批 40 个基础设施仓库里第一（第二是 oapi-codegen v2.8.0 的 21,247 字节，第三是 OpenSearch 3.9.0 的 13,047 字节）。**body 越大、feat 占比越低，越说明这个版本在还技术债而非堆功能**。

本文按「一条主线 + 五条线」组织。主线是**契约显式化**；五条线分别在类型层（VARIANT）、回填层（backfill 路径收敛）、Sink 层（REPLACE SINK 与 sink option 校验）、存储层（Hummock 变更日志解耦与锁竞争）、表达层（sync/async trait 拆分与水印异步化）。

| 栈层 | 早间事件（AI 商业层） | v3.1 对应改动 | 同一个设计模式 |
|---|---|---|---|
| 治理 / 编排 | 模型层与编排 harness 分离 | 表达式 sync/async trait 拆分（#26122） | 把「混在一起的两件事」拆成两个边界分明的接口 |
| 审计 | 防篡改、人类可读的证据 | VARIANT canonical 化：逻辑等价 ⇒ 字节相等（#26080） | 让「看起来一样」变成「可验证地一样」 |
| 授权 | 授权人可中途暂停 | 回填快照在 time travel vacuum 期间被 pin 住（#26326） | 暂停权落到具体资源上，而不是全局长锁 |
| 商业 | 假设模型已被入侵再从零遏制 | no-shuffle backfill 创建废弃，恢复未完成进度直接报错带上下文（#25963） | 不再给「不该存在的路径」续命 |

---

## 一、问题的源头：流式数据库的三层隐含约定

要理解 v3.1 在改什么，先要看清它继承的三个历史约定。这三个约定在 demo 阶段都不是问题，在生产里全是问题。

### 1.1 「 schema 先定，数据后到」与半结构化数据的张力

流式数据库的物化视图要求 `CREATE TABLE` 时把列类型钉死。但真实的数据流——CDC 抓的业务库、Kafka 里的 JSON、对象存储上的 Parquet——schema 是随时间漂移的。常见绕法是 `JSONB` 一把梭：所有半结构化数据塞进一个 jsonb 列。

jsonb 的问题不是性能（RisingWave 的 jsonb 存储做得不差），是**语义**：

- jsonb 里 `NaN` 不是合法的 JSON 值，spec 允许的非有限浮点数要么被拒绝、要么被偷偷转成字符串，同一个数在不同路径下表示不同；
- jsonb 的 `{"a":1,"b":2}` 与 `{"b":2,"a":1}` 在很多实现里**不相等**，因为按声明顺序存；
- jsonb 里的整数 `1` 与浮点 `1.0` 在 duck typing 下可能相等也可能不等，取决于比较路径；
- jsonb 没法直接对接 Iceberg/Parquet 的原生类型系统——导出到湖仓时要再过一次转换，转换规则本身就是 bug 来源。

**Parquet Variant 编码**（Parquet 的 logical type `Variant`）就是来解决这个的：一个 variant 值 = `metadata` + `value` 两段二进制。metadata 是字段名/字段 id 的字典（按字节序排好），value 是紧凑的值编码。RisingWave v3.1 直接把它作为一等存储格式，而不是在 jsonb 之上再包一层。

### 1.2 回填：一个 DDL 背后三种完全不同的路径

在流式数据库里，`CREATE MATERIALIZED VIEW mv FROM t` 这一句 DDL 的真实含义是「**把 t 从创建那一刻到现在的全部已有数据，全部算一遍，然后接上实时流**」。这个「把历史数据算一遍」的过程叫 backfill（回填）。

RisingWave 历史上有三条回填路径，它们的区别普通人完全看不到，但代价完全不同：

| 路径 | 原理 | 隐含代价 |
|---|---|---|
| **no-shuffle ArrangementBackfill** | 直接读上游物化视图的 arrangement（有序状态表），按 key 本地对齐 | 要求上游与下游 **并行度完全相同 + 分片规则完全相同**。一旦上游 reshuffle，回填结果错乱 |
| **ArrangementBackfill（带 shuffle）** | 读上游 arrangement，但允许重分片 | 通用，但要走网络洗一遍数据 |
| **SnapshotBackfill** | 直接扫上游表的 Hummock 快照（SST），下推谓词 | 不依赖上游是否物化，可裁剪，但要求「上游表快照可被安全引用」 |

**隐含约定的代价是这样的**：规划器默认选哪个，用户不知道；用户用 `streaming_use_arrangement_backfill` 这个 developer config 去调，调完之后新行为是「整个集群的新作业都变」还是「这一个作业变」，文档里说不清。更糟的是 no-shuffle 路径**在恢复时会静默继续**——如果一个 no-shuffle 作业崩溃重启，它从断点继续走，但断点记录的是「上游某个 actor 的局部进度」，上游如果在此期间 reshuffle 了，这个进度指向的 actor 已经不存在，作业会卡住或者给出一个没人能解释的结果。

### 1.3 Sink 替换：一个其实不原子的「原子操作」

流式数据库的 sink（把结果写出去到 Kafka / ClickHouse / Iceberg / Doris……）在 schema 变化时需要替换。旧做法：

```sql
DROP SINK s;
CREATE SINK s FROM mv WITH (...);
```

这两句之间有一个**时间窗口**。DROP 的时候流还在流，CREATE 的时候新 sink 还没建好，上游 dispatcher 的数据要么被丢弃要么堆积。即使引擎内部用 barrier 做了协调，从用户视角看：sink 的消费位点、主键定义、connector 配置全换了一遍，但没有任何一条 SQL 能保证「要么全旧、要么全新」。

更深的问题是 DROP 一个正在运行的 sink 会触发 streaming job 的整个 mutation 流程——改派上游 dispatcher、停掉旧 actor、可能还要重建下游 connector 的连接池。这个流程在 v3.0 时代是跟「表 schema 变更」共用一条 `replace_job` 路径的。**共用路径意味着两件事的语义被混在一起**：`replace_job` 保留原 job id，因为表 schema 变更要保持表 id 不变；但 sink 替换根本不需要保留 sink id，反而**必须换 id** 才能让下游 connector 把它当一个全新连接对待。

**隐含约定在这里就是：用户以为 DROP + CREATE 是两个独立操作，引擎内部其实跑的是同一条为表 schema 变更设计的路径。** 这条路径上的每个假设（保 id、可回填、可重放）对 sink 替换都是错的。

---

## 二、v3.1 的五条改动线

### 2.1 类型层：VARIANT 成为一等公民（PR #26080，+3363/-265，75 文件）

这是本版本最大的一条单 PR。它做了四件事，其中三件是「把语义钉死」而不是「加功能」。

**第一，引入 `VariantVal` / `VariantRef` / `VariantArray` 三层表示**，全部直接映射 Parquet Variant 的 `metadata + value` 二进制 payload。这意味着一个 VARIANT 列在 RisingWave 内部、在 Parquet 文件里、在 Iceberg 表里，**是同一段字节**。写出去不需要编码转换，读回来不需要重新解析。

**第二，canonical 化（规范化）贯穿所有导入路径**。JSON、struct/map、protobuf 三条导入路径，产出的 variant 字节必须一致。具体规则：

- 对象的 field name 进 metadata 字典并**排序**，field id 按 sort 后的顺序分配——这样 `{"b":2,"a":1}` 与 `{"a":1,"b":2}` 产出**完全相同**的字节；
- 整数保留原始宽度（INT8 不会被提升成 INT64），decimal 保留 precision/scale，时间类型保留原始语义；
- struct 与 map 的 field order 也被规范化。

**第三，浮点 canonical 化**——这是我认为全版本最精彩的一处：

> Canonicalize float bit patterns: every NaN collapses to one canonical quiet-NaN pattern and `-0.0` to `+0.0` (like `memcmp_encoding` does for float columns), so byte-based equality/hash/order treat NaN as a single value instead of rejecting spec-valid non-finite floats. Non-finite floats render as the strings `"NaN"` / `"Infinity"` / `"-Infinity"` in `to_jsonb`/text output, following `to_jsonb(float8)`.

为什么这一条关键？因为**variant 的相等判断、hash、排序全部走字节比较**。IEEE 754 的 NaN 有 $2^{51}-1$ 种不同的 payload 位模式，全都是「合法的 NaN」。如果 variant 的元数据层不做折叠，`x = y` 在 variant 上会给出与在 float 列上**不同的答案**。而 `-0.0` 与 `+0.0` 在 IEEE 754 里比较相等但位模式不同，同样会破坏 hash 一致性。折叠之后，「逻辑等价」与「字节相等」才第一次成为同一件事。

这也顺带解决了一个 SQL 层面的旧 bug：spec-valid 的非有限浮点数过去在 variant 路径上会被拒绝（因为无法存进合法的 variant 值），现在有了规范位模式就能存，输出时按 `to_jsonb(float8)` 的惯例渲染成字符串。

**第四，配套函数与类型转换**：`to_variant`、`variant_get`、`try_variant_get`、`variant_typeof`，以及 variant ↔ varchar / jsonb 的双向 cast。

同批还有两条配套：

- **#25165** `feat(iceberg): add variant type for iceberg source` —— VARIANT 从 Iceberg source 读进来也直接是一等类型；
- **#26731** `fix(sqlsmith): permit the VARIANT-as-key rejection` —— VARIANT **不能**当主键/排序键，sqlsmith 的 fuzz 生成器被改成不要生成这种用例。

**这条线的契约变化**：过去「半结构化数据进来先转 jsonb」是默认路径；现在 VARIANT 是一等路径，且它的相等/hash/序语义在字节层面被钉死。对用户的直接影响是：**`GROUP BY variant_col` 和 `JOIN ON variant_col = other.variant_col` 的结果从「依赖实现」变成「依赖规范」**。

### 2.2 回填层：三条路径收敛成「快照优先 + 显式回退」

v3.1 对回填动的是**删一条路、改一个默认、补两个正确性缺口**。

**删一条路（#25963，+331/-819，31 文件）**：`feat(stream): deprecate no-shuffle backfill creation`。核心改动四点，写得非常克制：

1. 前端规划器现在**优先选 SnapshotBackfill**，不可用时**回退 ArrangementBackfill**，覆盖 MV、index、vector index、sink 四种创建；
2. `streaming_use_arrangement_backfill` 及相关 developer config **仍然接受**（不破坏旧配置），但标记 deprecated，且**对新 streaming job 一律忽略**——这很重要：老配置不会报错让人措手不及，但也不会再有任何新作业走老路；
3. 已经持久化的、已完成的 no-shuffle 作业**继续跑**（Legacy `BackfillExecutor` 保留）；
4. **恢复时如果发现未完成的 no-shuffle 进度，直接报错**，错误信息带上上游 table、fragment、actor、progress 四级上下文，让运维能判断该 cancel 重建还是该人工修复。

第 4 点是这条 PR 最有信息量的设计。它没有选「静默尝试继续」也没有选「自动重建」，而是选了**「报错并给出定位现场」**。理由写在 PR body 里：no-shuffle 的正确性前提是上游分片规则不变，这个前提一旦被破坏，任何自动恢复策略都可能给出错误结果——**在流处理里，「错误结果」比「停机」贵得多**。

**改一个默认（#25188）**：`feat(stream): support predicate pushdown for snapshot backfill`。快照回填现在吃谓词下推。过去 `CREATE MATERIALIZED VIEW mv FROM t WHERE t.tenant = 'acme'` 会把 t 的**全部**快照数据读进回填执行器再过滤；现在谓词推到 SST 扫描层，配合 SST 的 block filter（下一节讲的 xor filter）直接跳过无关 block。对「大表 + 高选择性 WHERE」的回填，这是从「全表 IO」到「范围 IO」的差别。

**补正确性缺口（#26326，49KB diff）**：`feat(meta): pin backfill snapshots during time travel vacuum`。RisingWave 支持 time travel（时间旅行查询历史版本）， vacuum 会回收旧版本。问题在于：**一个 snapshot backfill 正在读 epoch 100 的快照，vacuum 可能把 epoch 100 的元数据删了**。修复方式是 meta 节点新增 `get_pinned_snapshot_epochs()`，收集所有正在进行的 snapshot backfill 引用的 epoch，vacuum 的 `delete_time_travel_metadata` 收到这个 pin 集合后跳过它们——注意是「跳过」不是「阻塞整个 vacuum」。trace 日志里直接写 `failed to collect pinned snapshot epochs. pause vacuum time travel`，收集失败时才暂停。

**扩展能力（#25953 + #25990 + #25188）**：

- **#25953**：serverless backfill（serverless backfill 是把回填算力放到独立资源组、不占用常驻计算）从 `CREATE MATERIALIZED VIEW` 扩展到 `CREATE SINK` 和 `CREATE INDEX`。新增一个共享的 frontend helper 从 `WITH` 选项里提取 `resource_group` 与 `cloud.serverless_backfill_enabled`，并在**进入 connector 规划/校验之前**把资源相关选项从 connector properties 里剥掉——否则 connector 会把它当未知属性报错。
- **#25990**：locality backfill（优先用本地存储的快照而非远端对象存储）新增 `locality_backfill_mode`，从「开了 enable 就尽力」变成显式 `always` 模式，SLT 测试里 `set locality_backfill_mode=always` 后行为确定。
- **#25188** 的谓词下推还修了一个规划器边界：`feat(optimizer): support index selection for selective backfill`（#25207），选择性回填时索引选择也跟着变。

**这条线的契约变化**：回填从「三条隐含路径 + 一个 developer config 碰运气」变成「快照优先、显式回退、老路径只读、恢复即报错」。用户能预测 `CREATE MATERIALIZED VIEW` 背后走哪条路了。

### 2.3 Sink 层：从两步 DDL 到一条原子 DDL

**REPLACE SINK（#26039，+1154/-240，41 文件）** 是本版本对用户体验改变最大的一条。

设计意图写在 PR body 开头：

> The goal is to replace an existing sink as a clean drop-old/create-new workflow instead of reusing the existing `replace_job` path for table schema changes. The replacement sink gets a new sink id, and the catalog swap is done only after the streaming barrier succeeds.
>
> `REPLACE SINK` is a cut-over operation, not a historical reload. The old sink must exist. The replacement sink is always created with `snapshot=false`, starts from the cut-over barrier, and does not backfill historical rows from the new upstream.

执行链条拆成六步，全部在一个 `UpdateMutation` barrier 里完成：

1. parser/DDL proto 支持 `REPLACE SINK` 语法；
2. frontend 校验与规划；
3. **独立的 meta DDL 路径**，不复用 `replace_job`（因为 `replace_job` 保 job id，sink 替换不需要）；
4. 用**新 sink id + 临时名**创建替换 sink 的 catalog 对象；
5. 一个 `UpdateMutation` barrier 同时：建新 sink actor、改派上游 dispatcher 指向新 sink、**冲刷并排空旧 sink 的 log store**、删旧 actor；
6. 新增 `sink_log_store_flush` 到 update mutation，**旧 sink 必须等到 log store 被截断之后 barrier 才能被 collect**；
7. 在 post-collect 阶段**原子换 catalog**：新 sink 暴露成最终名字，旧 sink 对象删除。

第 5、6 步是正确性的核心。sink 的 log store 是「先写日志、异步刷到目标系统」的缓冲层；如果不等它排空就换 catalog，切换瞬间会有**已收到但未投递**的消息永远丢失。`sink_log_store_flush` 把「等日志排空」变成 barrier 收集的**前置条件**，而不是一个 best-effort 的后续动作。

**v1 的诚实约束**（PR body 明确列出，本文不粉饰）：

- 老 sink 必须存在，`REPLACE SINK` **不会**回退成 `CREATE SINK`；
- **exactly-once sink 被拒绝**；
- **sink-into-table 被拒绝**；
- `REPLACE SINK ... AS query` 这一版本被拒绝；
- 替换 sink **恒定 `snapshot=false`**，不做历史回填——它是切接不是重放；
- **权限不从旧 sink id 迁移到新 sink id**；
- 恢复路径的覆盖在配套 issue #26038 单独跟踪，本 PR 只覆盖了 Kafka sink 的 e2e 切接测试与 log store flush 的单测。

配套的边界收紧：

- **#26256** `feat(sink): validate create sink options` —— 创建时的选项校验前置；
- **#26232** `feat(frontend): allow unsafe upsert sink primary key mismatch` —— upsert sink 的主键与上游不一致现在由 `streaming_unsafe_allow_upsert_sink_pk_mismatch` session 变量显式 gate，**默认拒绝**，要开必须显式声明「我知道这不安全」（参数名带 `unsafe_` 前缀，且出现在 `pg_settings` 的 user 参数段里）；
- **#26043** `feat(sink): support since_timestamp option` —— sink 支持 `since_timestamp`，从指定时间点开始；非法值（如 `'not-a-timestamp'`）直接 `invalid value` 报错而非静默兜底；这条 PR 同时把 Kafka 的 `allow.auto.create.topics` 改成必须走 `properties.` 前缀命名空间（`properties.allow.auto.create.topics`），**未带前缀的旧写法不再被接受**；
- **#26023** `feat(frontend): allow snapshot-free sink queries` —— 允许创建不带快照的 sink 查询；
- **#26256 / #25984**：turbopuffer sink 成套接入（含 batching controls、`num_shards`）、StarRocks stream load batch size 限制、Doris VARIANT 支持、Snowflake serverless task。

**这条线的契约变化**：sink 的「替换」从用户侧的两条 DDL + 一个不确定的时间窗，变成一条 DDL + 引擎保证的 barrier 级原子性；同时「不安全」的选项从「静默接受」变成「显式 opt-in 且参数名自带警告」。

### 2.4 存储层：Hummock 把变更日志从版本里剥出来

Hummock 是 RisingWave 的状态存储引擎（LSM-tree on object storage）。v3.1 对它做了三件互相独立但方向一致的事：**解耦、去锁竞争、删死代码**。

**解耦（#26561，+74KB diff）**：`feat(storage): decouple table change logs from hummock versions`。

旧的 Hummock version checkpoint 里塞着一个 `map<uint32, TableChangeLog> table_change_logs` 字段——**每张表的变更日志跟全局版本元数据绑在一起**。问题在于版本元数据的更新频率与表变更日志的更新频率完全不同：版本元数据每个 checkpoint（默认几百毫秒到秒级）就要更新一次，而表变更日志只在 DDL / schema 变化时才动。绑在一起意味着：

- 每次版本 checkpoint 都要序列化/反序列化全部表的变更日志（即使没变）；
- 版本 checkpoint 的锁覆盖了变更日志的访问，DDL 操作与正常 checkpoint 互相阻塞；
- checkpoint 的体积随表数量线性增长。

v3.1 的做法是新增独立的 `TableChangeLogTransactionDelta` 结构，变更日志走独立 delta 路径，version checkpoint 里只留一个引用。protobuf 定义里 `table_change_logs = 6` 与 `change_log_delta = 10` **两个旧字段同时标记 `[deprecated = true]`**，读取侧新增 `warn_if_legacy_table_change_logs_are_present()`：**旧格式的 checkpoint 仍然能读（不破坏升级），但会打 warn 日志告诉你「我在忽略 deprecated 的变更日志字段」**，并配了专门的单测 `deprecated_table_change_logs_are_ignored()`。

这是教科书式的「向前兼容迁移」：新写用新格式、旧读能识别旧格式、旧格式触发可观测的告警、测试钉死行为。**它没有选「升级时一次性迁移全部 checkpoint」这条路**——那会要求升级窗口内做大量 IO，且失败回滚极复杂。

**去锁竞争（#26076，+41KB diff）**：`feat(meta): reduce hummock versioning lock contention`。原来的 checkpoint 流程在持有 versioning 读写锁的期间完成「快照 + 持久化 + 更新内存」全部三件事。v3.1 拆成三段，代码注释把意图写得清清楚楚：

```rust
// 1. hold read lock briefly and snapshot checkpoint inputs.
let versioning_guard = self.versioning.read().await;
let current_version = versioning.current_version.clone();
let old_checkpoint: &HummockVersionCheckpoint = &versioning.checkpoint;
drop(versioning_guard);
// 2. persist the new checkpoint without holding lock
// 3. hold write lock briefly and update in memory state
let mut versioning_guard = self.versioning.write().await;
assert!(new_checkpoint.version.id > versioning.checkpoint.version.id);
versioning.checkpoint = new_checkpoint;
```

第 1 步只持读锁做内存快照然后立刻 drop；第 2 步完全无锁地把 checkpoint 写对象存储（这是最慢的一步，网络 IO）；第 3 步只持写锁做指针替换。**锁持有时间从「一次对象存储往返」降到「两次内存 clone」**。配套还加了 `feat(meta): add hummock lock timing metrics`（#26071）和 `feat(meta): label Hummock lock write operations`（#26698），让这个瓶颈可观测。

**删死代码（#24561，+146/-928，11 文件）**：`refactor(storage): deprecate merge_imm and simplify imm struct`。删掉了已废弃的 in-memory immutable memtable merge 路径，把 `SharedBufferBatch` 从「多 epoch 批次」简化回「单 epoch 批次」。删除的直接后果是所有读侧从 `min_epoch` / `max_epoch` / `epochs` 三个字段改成 `imm.epoch()` 一个方法。**删 928 行、加 146 行**，是本版本净删最多的一条 PR——「每个 immutable memtable 恰好绑定一个 epoch」从一个需要处处防御的约定，变成类型系统里不可能违反的事实。

**存储层其余配套**：

| PR | 改动 | 为什么承重 |
|---|---|---|
| #25170 | `sstable_filter_kind` 系统参数，支持 `xor8` / `xor16`，大 SST 用 block-based builder；filter family 记进 `SstableInfo`，fast compaction 只对兼容的 blocked `xor16` SST 开启 | 过滤器类型从编译期常量变成运行期可配，且**把兼容性信息写进了 SST 元数据**——未来换过滤器家族不会破坏老 SST |
| #25765 | 支持手动 compact 到指定 target level | 运维可以从「等 compaction 策略」变成「指定层级手动触发」 |
| #25706 / #25773 | 复用 block meta key 的 xor filter reader；删除未使用的 bloom filter 实现 | 减少每次读的元数据访问；删死代码 |
| #25786 | `iceberg_compaction_enable_prefetch` 减少对象存储 READ API 调用 | 对象存储按请求计费，这是成本项 |
| #26429 | `prune irrelevant SSTs before cache refill` | 缓存重填前先剪掉无关 SST，避免无谓下载 |
| #24452 | `hummock: support table refill runtime state refresh` | 表重填的运行时状态可刷新 |
| #26267 | `storage: stream meta snapshot backup payload` | meta 快照备份 payload 化 |
| #26326 | 回填快照 epoch 在 time travel vacuum 期间被 pin | 见 2.2 |

**这条线的契约变化**：Hummock 的版本元数据从「什么都往里塞」变成「按更新频率分家」；checkpoint 锁从「包住网络 IO」变成「只包内存指针」；过滤器族从「隐含假设全集群一致」变成「写进每块 SST 的元数据」。

### 2.5 表达层：sync/async trait 拆分与水印异步化

**#26122 `feat(expr): split sync and async expression traits`** 是本版本仅次于 VARIANT 的大改动：**+162,684 字节 diff，横跨 40+ 文件**。

问题背景是 Rust 生态里典型的「异步传染」债务。RisingWave 的表达式 trait 原来只有一个 `Expression`，里面的 `eval` / `eval_row` 是同步函数。但有一类表达式**必须**是异步的：UDF（远程调用）、AI model 调用（`#26001` 明确给 OpenAI embedding 加了 metrics 和 retry）、访问外部系统的 table function。为了在同步 trait 里放下异步实现，过去要么 `spawn` 一个阻塞任务再 block 等它（浪费一个线程），要么在 trait 层面把所有方法都做成异步（于是连 `1 + 1` 这种纯 CPU 表达式也要走 async 状态机，平白多出一次 poll 开销）。

v3.1 把 trait 拆成四个：

```rust
pub trait ExpressionInfo: std::fmt::Debug + Sync + Send { ... }
pub trait SyncExpression: ExpressionInfo {
    fn eval(&self, input: &DataChunk) -> Result<ArrayRef>;
    fn eval_row(&self, input: &OwnedRow) -> Result<Datum>;
}
pub trait AsyncExpression: ExpressionInfo {
    async fn eval(&self, input: &DataChunk) -> Result<ArrayRef>;
    async fn eval_row(&self, input: &OwnedRow) -> Result<Datum>;
}
pub trait AsyncDynExpression: ExpressionInfo { ... }
```

`ExpressionInfo` 抽出所有非求值的元信息（类型、确定性、是否 volatile）。纯计算表达式（`case`、`coalesce`、`cast`、`in_`、`map_filter`、`array_transform`、`vnode`……）实现 `SyncExpression`；UDF、AI model、外部访问实现 `AsyncExpression`。聚合的 filter 包装器（`src/batch/executors/src/executor/aggregation/filter.rs`）从 `Arc<dyn Expression>` 改成 `BoxedExpression`，hash join / nested loop join / project / project_set / update / values 六个 batch executor 全部跟着改。

**收益是双向的**：同步路径不再背 async 状态机的开销；异步路径不再需要「spawn 一个线程假装自己是同步」。这条 PR 也为后面更多异步表达式（向量检索、模型调用、外部 HTTP）铺平了路——**trait 拆分本身就是「把隐含的执行模型约定写进类型系统」**。同批的 `#26362 feat(expr): support volatile timestamp and uuid functions` 正好是「哪些表达式是 volatile」这条信息被显式化的例子。

**水印异步化（#26640，1 文件 +101/-55）**：`refactor(stream): load global watermark asynchronously`。watermark filter 之前在输入空闲几个 barrier 之后，**同步**调用 `get_global_max_watermark(HummockReadEpoch::NoWait(prev_epoch))`。`NoWait` 避免了等提交 epoch，但把 batch table 的读路径**绑死在 NoWait 语义**上。改完之后：

- 启动与 vnode 更新时用**已提交** epoch 读全局水位；
- 全局刷新仍然以「输入空闲 + 执行未暂停」为前提；
- **连续 5 个空闲 barrier 之后最多调度一个异步已提交读**；
- 异步读回来的全局水位按 max 并入 `current_watermark`，只有当它推进且执行器未暂停时才 yield 出去。

**没有为了低延迟牺牲正确性**：`NoWait` 读未提交数据的风险被消掉了，代价是全局水位最多滞后一个异步读周期。对「输入空闲」这个特定场景，这个代价是可以接受的——空闲本来就意味着没有新数据要推进水位。

**over-window 的 LRU 水印（#26424）**：`apply LRU watermark to over-window partition cache at chunk boundaries`。注释写得很清楚：

> Also apply the LRU watermark at chunk boundaries, so that cold partitions can be released without waiting for the next barrier, which can be a long time away with large barrier intervals. This is safe because the range cache is write-through: at this point all changes have been applied to both the state table and the [range cache].

这是一个**大 barrier interval 下的内存压力修复**：barrier 间隔越长，冷分区在内存里待的时间越久；在 chunk 边界（而不是 barrier 边界）应用 LRU 水位释放冷分区。安全性论证依赖「range cache 是 write-through」这个前提——**注释把「为什么这样做是安全的」写在了代码里，而不是留给读者自己猜**。

**GAP_FILL 的分区化（#25287，+173KB diff）**：`feat(stream): support partitioned gapfill`。GAP_FILL 是 RisingWave 的时序补值语法（LOCF / INTERPOLATE 等策略填时间空隙），之前是全局一个补值序列；现在支持 `PARTITION_BY(...)`，每个分区独立补值。语法长这样：

```sql
CREATE MATERIALIZED VIEW gf_partitioned AS
FROM GAP_FILL(sensor_data, ts, INTERVAL '1' MINUTE, LOCF(value), PARTITION_BY(device_id));
```

proto 层加了 `repeated uint32 partition_by_indices`；planner 里对「partition by 单列」「partition by 多列」「partition by 重复列」「fill strategy 落在 partition 列上」四种边界都加了规划器测试用例（后两个是**应当被拒绝或特殊处理**的边界）。同批 **#25350** `feat(stream): support eowc gapfill` 把 GAP_FILL 带进了 EOWC（emit-on-window-close）语义。

**会话默认值（#25864）**：`feat(config): bootstrap session defaults from [session_init] in risingwave.toml`。过去会话参数默认值只能在连接时 `SET`，或靠客户端的连接字符串；现在可以在服务端配置文件里写一个 `[session_init]` 段，所有新连接自动继承。配套的 CI 脚本 `e2e-session-init-test.sh` 验证「配了之后新连接的参数确实被种下了」。这条改动不大，但它把「会话默认值」从一个**客户端约定**变成了**服务端可管理项**——对多租户与 SaaS 部署是刚需。

---

## 三、五段可运行代码

### 3.1 VARIANT 的 canonical 化验证

```sql
-- 建表，一列 VARIANT
CREATE TABLE events (
    id BIGINT PRIMARY KEY,
    payload VARIANT
);

-- 两条「逻辑等价」的 JSON，字段顺序相反
INSERT INTO events VALUES
    (1, to_variant('{"b": 2, "a": 1, "n": NaN}'::jsonb)),
    (2, to_variant('{"a": 1, "b": 2, "n": NaN}'::jsonb));

-- v3.1 之前：这两行在 GROUP BY 上可能是两行
-- v3.1 之后：字段字典排序 + NaN 折叠，两行 payload 字节相同
SELECT payload, count(*)
FROM events
GROUP BY payload;
--  {"a":1,"b":2,"n":NaN} | 2

-- NaN 折叠后的 hash 一致性：join 不再丢数据
SELECT a.id, b.id
FROM events a JOIN events b ON a.payload = b.payload;
-- 1 | 1   1 | 2   2 | 1   2 | 2

-- 零的处理：-0.0 与 +0.0 在 variant 里是同一个字节模式
SELECT variant_typeof(payload) FROM events LIMIT 1;
-- variant

-- 从 Iceberg source 直接读 VARIANT（#25165），不需要中间 jsonb 转换
CREATE SOURCE iceberg_orders (
    id BIGINT,
    detail VARIANT
) WITH (
    connector = 'iceberg',
    warehouse.path = 's3://bucket/wh',
    catalog.type = 'rest',
    catalog.uri = 'http://catalog:8080'
);
```

### 3.2 GAP_FILL 分区补值 + EOWC

```sql
CREATE TABLE sensor_data (
    device_id INT,
    ts TIMESTAMP,
    value DOUBLE,
    PRIMARY KEY (device_id, ts)
);

INSERT INTO sensor_data VALUES
    (1, '2026-10-11 10:00:00', 10.0),
    (1, '2026-10-11 10:03:00', 40.0),   -- 设备 1 缺 10:01 10:02
    (2, '2026-10-11 10:00:00', 100.0),
    (2, '2026-10-11 10:02:00', 130.0);  -- 设备 2 缺 10:01

-- 每个设备独立按 1 分钟补值，LOCF 策略（用前一个值填）
CREATE MATERIALIZED VIEW gf_partitioned AS
FROM GAP_FILL(sensor_data, ts, INTERVAL '1' MINUTE, LOCF(value), PARTITION_BY(device_id));

SELECT device_id, ts, value FROM gf_partitioned
ORDER BY device_id, ts;
--  1 | 10:00:00 | 10.0
--  1 | 10:01:00 | 10.0   <- 补
--  1 | 10:02:00 | 10.0   <- 补
--  1 | 10:03:00 | 40.0
--  2 | 10:00:00 | 100.0
--  2 | 10:01:00 | 100.0  <- 补
--  2 | 10:02:00 | 130.0

-- 多列分区
CREATE MATERIALIZED VIEW gf_multi AS
FROM GAP_FILL(sensor_data, ts, INTERVAL '1' MINUTE,
              INTERPOLATE(value), PARTITION_BY(device_id));

-- 规划器边界（会被拒绝）：fill 策略落在 partition 列上
-- FROM GAP_FILL(t, ts, INTERVAL '1' MINUTE, LOCF(device_id), PARTITION_BY(device_id));
```

### 3.3 REPLACE SINK 全流程（含被拒绝的场景）

```sql
-- 原始 sink：把物化视图写到 Kafka
CREATE SINK orders_sink FROM mv_orders WITH (
    connector = 'kafka',
    properties.bootstrap.server = 'broker:9092',
    topic = 'orders_out',
    primary_key = 'order_id'
);

-- 场景 1：标准替换 —— 换一个上游 + 换 connector 配置，一条 DDL
REPLACE SINK orders_sink FROM mv_orders_v2 WITH (
    connector = 'kafka',
    properties.bootstrap.server = 'broker:9092',
    topic = 'orders_out_v2',
    primary_key = 'order_id'
);
-- 引擎内部：新 sink id -> 临时名 -> 一个 UpdateMutation barrier 同时
--   建新 actor / 改派上游 dispatcher / 冲刷排空旧 sink log store /
--   删旧 actor -> post-collect 原子换 catalog
-- 旧 sink 的 log store 必须截断完成，barrier 才会被 collect（防丢消息）

-- 场景 2：从指定时间点开始（#26043）
REPLACE SINK orders_sink FROM mv_orders WITH (
    connector = 'kafka',
    properties.bootstrap.server = 'broker:9092',
    topic = 'orders_out',
    primary_key = 'order_id',
    since_timestamp = '2026-10-11 12:00:00'
);

-- 场景 3（被拒绝）：since_timestamp 非法值不再静默兜底
REPLACE SINK orders_sink FROM mv_orders WITH (
    connector = 'kafka', properties.bootstrap.server = 'broker:9092',
    topic = 'orders_out', since_timestamp = 'not-a-timestamp'
);
-- ERROR: invalid value "not-a-timestamp" of 'since_timestamp' option

-- 场景 4（被拒绝）：Kafka 选项不再接受无前缀写法
CREATE SINK bad_sink FROM mv_orders WITH (
    connector = 'kafka', properties.bootstrap.server = 'broker:9092',
    topic = 't', allow.auto.create.topics = 'true'
);
-- 必须写成 properties.allow.auto.create.topics = 'true'

-- 场景 5（v1 约束，诚实边界）：exactly-once sink 目前不能 REPLACE
-- CREATE SINK eos_sink FROM mv_orders WITH (..., transactional = 'true');
-- REPLACE SINK eos_sink FROM mv_orders_v2 WITH (...);   -- 被拒绝
```

### 3.4 Hummock 运维：compaction group 与过滤器族

```sql
-- 需要超级用户（#24346），普通用户会被拒
ALTER COMPACTION GROUP cg_default SET
    compaction.max_bytes_in_level = '5GB',
    compaction.max_sub_compaction = '4';

-- 非 superuser：
-- ERROR: must be superuser to alter compaction group config

-- SST 过滤器族可配（#25170）：xor8 省空间 / xor16 误报率更低
SET sstable_filter_kind = 'xor16';

-- 查看当前值
SHOW sstable_filter_kind;

-- 手动 compact 到指定层级（#25765）
-- 压力大的表可以指定 target level 而不是等分层策略
```

```toml
# risingwave.toml —— 会话默认值从服务端引导（#25864）
[session_init]
search_path = "public"
streaming_parallelism = "8"
backfill_rate_limit = "1000"
sink_decouple = "default"
# 新连接自动继承这些值，客户端不用每次 SET
```

### 3.5 升级后自查脚本

```sql
-- 1) 回填路径：确认规划器不再生成 no-shuffle（新建作业）
--    老配置仍被接受但已 deprecated 且对新作业忽略
SHOW streaming_use_arrangement_backfill;

-- 2) 不安全开关：默认关，必须显式 opt-in
SHOW streaming_unsafe_allow_upsert_sink_pk_mismatch;

-- 3) 新增的会话/系统参数确实存在
SELECT name, setting, source
FROM pg_settings
WHERE name IN ('sstable_filter_kind',
               'locality_backfill_mode',
               'streaming_use_snapshot_backfill',
               'backfill_rate_limit');

-- 4) Hummock 版本元数据解耦后，旧格式 checkpoint 会被兼容读取但打 warn
--    在 meta 节点日志里搜：deprecated table change logs found in hummock version checkpoint
--    出现这条 warn 是正常的（升级前的老 checkpoint），新写入不再带这两个字段
```

---

## 四、五套流处理方案 17 维度对比

| 维度 | RisingWave v3.1 | Flink 2.2 (Forrest) | Materialize v26.45 | StarRocks 3.5.21 | Doris 3.0.6 |
|---|---|---|---|---|---|
| 形态 | 流式数据库（SQL + 物化视图） | 流处理框架（DataStream/SQL） | 流式数据库（Postgres 协议） | 实时数仓（MPP + 流导入） | 实时数仓（MPP + 流导入） |
| 半结构化类型 | **VARIANT 一等（Parquet Variant 原生字节）** | RowData / Raw JSON（需自定义） | JSONB | JSON / VARIANT（#25451 sink 支持） | JSON / VARIANT |
| Canonical 化语义 | 字典排序 + NaN 折叠 + -0 归一，**逻辑等价⇒字节相等** | 无（依赖用户代码） | jsonb 语义 | 无统一规范 | 无统一规范 |
| 回填路径数 | 快照优先 + Arrangement 回退 + 老路径只读（3 条显式） | 无内置「回填」概念（savepoint/replay 手工） | 数据驱动（timestamp 水位回填） | 无（导入即全量） | 无（导入即全量） |
| 回填谓词下推 | 有（推到 SST 扫描层） | N/A | 部分（按时间列） | N/A | N/A |
| 快照保护 | 回填 epoch 在 time-travel vacuum 期间被 pin | N/A（无时间旅行） | 无时间旅行 | 无时间旅行 | 无时间旅行 |
| Sink 替换原子性 | **REPLACE SINK 单 DDL，barrier 级原子 + log store flush 前置** | 无（需手工停启） | 无 | 无 | 无 |
| 表达式执行模型 | **sync/async 双 trait 拆分** | 全 async（状态机开销） | 全同步 | 全同步 | 全同步 |
| 状态存储 | Hummock（LSM on 对象存储 + xor8/xor16 可配 + SST 元数据记过滤器族） | RocksDB / 通用 state backend（Forrest 分离） | RocksDB + 持久化 | 本地 + 对象存储 | 本地 + 对象存储 |
| 版本元数据解耦 | 变更日志独立 delta，旧字段 deprecated 兼容读 | N/A | N/A | N/A | N/A |
| checkpoint 锁 | 三段式（读锁快照→无锁持久化→写锁换指针）+ 锁计时指标 | barrier 对齐 | 轻量 | N/A | N/A |
| 时序补值 | **GAP_FILL + PARTITION_BY + EOWC** | 需自定义窗口函数 | 无原生 | 无原生 | 无原生 |
| 水印语义 | chunk 边界 LRU 释放 + 异步已提交全局水位 | 事件时间 watermark + idle source | 数据驱动 timestamp | 事件时间 | 事件时间 |
| 资源隔离 | serverless backfill 资源组（MV/sink/index）+ `ALTER ... RESOURCE GROUP` | TaskManager slot | cluster 复制 | warehouse 隔离 | workload group |
| CDC 心跳/WAL 监控 | **Postgres CDC WAL lag 告警（20GiB 阈值）+ WAL 丢失 fail-fast** | 自定义 |Debezium 心跳 | 无 | 无 |
| 部署形态 | 单二进制（meta + compute + frontend）+ K8s | JobManager/TaskManager 集群 | 单实例为主 + cluster | FE/BE 集群 | FE/BE 集群 |
| 许可证 | Apache 2.0 | Apache 2.0 | BSL（部分功能企业版） | Elastic License 2.0 / 源码可用 | Apache 2.0 |

**对比要点**：VARIANT + canonical 化 + REPLACE SINK + 快照回填保护这四项，在另外四套方案里**没有一项有对应实现**。这不是说 RisingWave 更好——Flink 的状态管理灵活性、StarRocks/Doris 的 MPP 查询性能、Materialize 的 Postgres 协议兼容性都是 RisingWave 没有的。差异在于**它选了「把语义钉死」这条赛道**：当别的系统在比「能不能做」的时候，它在比「做出来的结果是不是可预测的」。

---

## 五、6 条 6-12 月可验证硬指标

1. **VARIANT 字节等价**：`to_variant('{"b":2,"a":1}'::jsonb)` 与 `to_variant('{"a":1,"b":2}'::jsonb)` 的 `GROUP BY` 结果合并为一行；`payload` 含 NaN 时 join 不再丢匹配。今天就能在 v3.1 上跑。
2. **回填路径确定**：新建 MV/index/vector index/sink 时，规划器输出（`EXPLAIN`）显示 `SnapshotBackfill` 或 `ArrangementBackfill`，**不再出现 no-shuffle**；`streaming_use_arrangement_backfill` 设了也不影响新作业。
3. **REPLACE SINK 原子性**：替换过程中旧 sink 的 `sink_log_store_flush` 未完成时 barrier 不被 collect；切接后下游 topic 的消息序列「旧消息有结尾、新消息有开头」，无重叠无空洞（exactly-once sink 除外，v1 被拒绝）。
4. **Hummock 锁计时**：`hummock_lock_timing_metrics` 上线后，checkpoint 路径的写锁持有时长应从「≈ 一次对象存储 PUT 往返」降到「≈ 两次内存 clone」；在大表数量（>1000 表）部署上 checkpoint P99 延迟应可测地下降。
5. **deprecated 字段兼容读**：升级后 meta 节点日志出现 `deprecated table change logs found in hummock version checkpoint; ignoring them` 是**预期行为**（读老 checkpoint），新写入不再产生该 warn；若升级 7 天后仍在高频出现，说明有路径仍在写旧格式。
6. **过滤器族一致性**：`SHOW sstable_filter_kind` 显示集群级配置；compaction 后新生成的 SST 的 `SstableInfo` 里记录了 filter family；跨节点混合 xor8/xor16 时 fast compaction 自动只对兼容的 blocked xor16 开启，不产生静默降级。

---

## 六、6 个 6-12 月可观察未来信号

1. **VARIANT 从 source 一路到 sink**：v3.1 让 VARIANT 在 Iceberg source、内部存储、Doris/StarRocks/turbopuffer sink 上都成为一等类型。6-12 月内若出现「variant 列从 Iceberg 读入、在物化视图里 GROUP BY、再以 Parquet Variant 原生字节写回湖仓」的端到端零转换链路，说明这条类型铁路铺通了。
2. **no-shuffle backfill 彻底删除**：v3.1 是「创建废弃 + 已有保留」。按 RisingWave 的惯例，下一两个 minor 会进入「未完成进度直接拒绝重建」，再下一个 major 删除 Legacy `BackfillExecutor`。观察 release notes 里 `BackfillExecutor` 的去留。
3. **REPLACE SINK 约束逐条解除**：exactly-once sink 拒绝、sink-into-table 拒绝、`AS query` 拒绝、权限不迁移——这四条是 v1 的诚实边界。每解除一条都意味着 barrier 语义更复杂；观察 #26038 及后续 issue。
4. **sync/async trait 拆分的外溢**：这次拆分只动了表达式层。聚合函数、table function、join 都还有同样的「同步签名背异步实现」债务。若后续 release 出现 `AsyncAggregateFunction` / `AsyncTableFunction`，说明这条重构路线被正式采纳。
5. **canonical 化成为跨引擎约定**：Parquet Variant 的规范本身规定了 metadata 排序，但**浮点 canonical 化（NaN 折叠、-0 归一）是 RisingWave 自己加的**。若其他引擎（DuckDB / Iceberg reader / Polars）跟进同样的折叠规则，它就会从「引擎行为」变成「事实标准」。
6. **对象存储成本成为存储层一等指标**：`iceberg_compaction_enable_prefetch`（减少 READ API 调用）与 SST 修剪这类改动，把「对象存储请求数」从隐含成本变成显式可配项。6-12 月内若出现按 SST 生命周期算账的成本 dashboard，说明这一层成熟了。

---

## 七、8 个诚实边界

1. **REPLACE SINK 不回退成 CREATE SINK**：老 sink 不存在直接报错，不会「贴心地」帮你新建。这是有意的——替换与新建的语义不同（前者 `snapshot=false` 切接），自动回退会让用户在不知情的情况下得到一个不回填历史的 sink。
2. **REPLACE SINK 恒定 `snapshot=false`**：它做的是切接（cut-over），不是历史重放。如果你需要「换 sink 并重放全部历史」，现在仍然只能手工建新 sink。
3. **exactly-once sink 不能 REPLACE**：v1 拒绝。exactly-once 的两阶段提交与「旧 sink 必须等 log store 截断」的语义还需要额外协调，没有为了赶发布而做一个半成品。
4. **权限不迁移**：新 sink 是新 id，旧 sink 上的 GRANT 不会带过去。升级 checklist 里必须把「重建 sink 权限」列进去。
5. **no-shuffle 回填的已完成作业继续跑**：废弃的是「创建」，不是「运行」。已持久化的 no-shuffle 作业不会被迫迁移；但**恢复时若发现未完成的 no-shuffle 进度，会直接报错并要求人工判断**，不会静默继续——在流处理里，静默的错误结果比停机贵。
6. **VARIANT 不能当主键/排序键**：sqlsmith 的 fuzz 生成器被改成不生成这种用例（#26731）。变体的 canonical 化保证了值的等价，但没有保证 key 的序在所有路径下一致——这个边界是类型系统的选择，不是 bug。
7. **Iceberg catalog 必须显式给 `warehouse.path`**：#26168 里 rest catalog 缺 `catalog.uri`、glue catalog 缺 `warehouse.path` 都是直接 `bail!` 退出（`warehouse.path must be set in storage catalog`），不做默认值猜测。
8. **全局水印的异步化牺牲了延迟换正确性**：#26640 消掉了 `NoWait` 读未提交的风险，代价是全局水位在输入空闲期最多滞后一个异步读周期。对需要「水位严格实时」的场景，这不是免费午餐。

---

## 八、5 步生产升级 checklist

**第 1 步：升级前快照 + 确认无未完成的 no-shuffle 作业。**
`git` tag 切到 v3.1 前，先在 meta 上确认所有 streaming job 都是已完成状态（尤其跑了很久的老作业）。升级后若有作业恢复，检查是否出现带 table/fragment/actor/progress 四级上下文的 no-shuffle 报错——出现就意味着这个作业必须 cancel 重建，**不要尝试手工「推一下」**。

**第 2 步：升级后立刻验证 deprecated 字段的兼容读。**
升级后第一批 checkpoint 读取会触发 `deprecated table change logs found` 的 warn，这是**预期行为**。7 天后仍在高频出现才异常。同时跑一遍 `SELECT * FROM pg_settings WHERE name LIKE 'streaming%'`，确认新参数（`sstable_filter_kind`、`locality_backfill_mode`）在列。

**第 3 步：sink 选项命名空间迁移。**
全仓库搜 `allow.auto.create.topics`（无 `properties.` 前缀的旧写法）。v3.1 起必须写成 `properties.allow.auto.create.topics`，旧写法不再被接受。同时排查所有用 `since_timestamp` 的 sink，确认值是合法 timestamp（非法值现在直接报错而不是兜底）。

**第 4 步：把不安全开关显式化。**
排摸所有 upsert sink 的主键与上游是否一致。不一致的现在由 `streaming_unsafe_allow_upsert_sink_pk_mismatch` gate 住且**默认拒绝**；确实需要开的，必须在变更单里写明「为什么主键不一致仍然安全」，并把这个参数写进 `[session_init]` 之外的显式 `SET`——不要做成集群默认值。

**第 5 步：回填路径的回归验证。**
对最大的三张表分别跑 `CREATE MATERIALIZED VIEW` + `EXPLAIN`，确认走的是 `SnapshotBackfill`；对带高选择性 `WHERE` 的视图，对比回填期间对象存储 READ 请求数（谓词下推后应显著下降）。如果仍然走 ArrangementBackfill，检查上游是否物化视图——这是回退路径，不是错误，但你要知道为什么回退。

---

## 九、5 条最佳实践

**✅ 该用**

1. **半结构化数据用 VARIANT 而非 JSONB**，前提是你需要「逻辑等价」在字节层面成立（join / group by / 导出湖仓）。如果只是存起来不参与计算，jsonb 仍然够用。
2. **替换 sink 用 `REPLACE SINK` 一条 DDL**，并且**把权限重建写进同一张变更单**。两步 DROP+CREATE 的时间窗在 v3.1 已经不需要了，但权限迁移 v1 没做。
3. **回填负载重的表开 serverless backfill 资源组**（现在 MV/sink/index 都支持），让回填算力不与常驻查询争抢。
4. **`[session_init]` 管理会话默认值**，而不是在每个客户端连接字符串里重复 `SET`。多租户场景下这是唯一的服务端集中管理入口。
5. **升级前读 meta 日志里的 warn**。v3.1 的迁移策略是「旧格式兼容读 + warn 告警」，warn 就是迁移进度的信号。

**❌ 千万别用**

1. **别在新作业上依赖 `streaming_use_arrangement_backfill`**。它仍被接受（不报错），但对新作业一律忽略——「参数设了但没用」是最容易让人误判的静默行为。
2. **别在恢复 no-shuffle 作业报错后强行重试**。错误里的 table/fragment/actor/progress 上下文是给你判断的，不是给你忽略的。
3. **别把 `streaming_unsafe_allow_upsert_sink_pk_mismatch` 设成集群默认**。参数名带 `unsafe_` 是设计，不是装饰。
4. **别在没有 superuser 的账号上跑 `ALTER COMPACTION GROUP`**（会被拒），也别在升级窗口内跑——compaction group 变更触发重 compaction，与升级的 checkpoint 压力叠加。
5. **别用 `REPLACE SINK` 代替历史重放**。它恒定 `snapshot=false`；要重放历史请新建 sink 让它走快照回填。

---

## 十、总结：把约定写进类型系统

RisingWave v3.1.0 的 366 个 PR 里最值得注意的比例是：**191 条 fix 对 78 条 feat**。这不是一个「加功能」的版本，是一个「把过去靠默契维持的东西写成合同」的版本。

四个最承重的变化，方向完全一致：

- **VARIANT**：让「两个值逻辑上等价」从「看实现」变成「字节相同」——规范写在 Parquet Variant 的 metadata 排序里，写在 NaN 的位模式折叠里；
- **REPLACE SINK**：让「换 sink」从两条 DDL 之间的不确定窗口，变成一个 barrier 的原子性承诺——而且把「等旧 sink 的日志排空」写成 barrier collect 的**前置条件**，不是后续清理；
- **回填路径收敛**：让「这条 DDL 背后走哪条路」从「取决于一个 developer config」变成「快照优先 + 显式回退 + 老路径只读 + 恢复即报错」；快照被引用的 epoch 在 vacuum 期间被 pin 住，暂停权落到了具体资源上；
- **Hummock 解耦**：让版本元数据的锁从「包住一次对象存储网络往返」变成「只包两次内存 clone」；变更日志从「塞在 checkpoint 里」变成独立 delta，旧字段 deprecated 但兼容读。

有趣的是，这些改动几乎都不是性能优化（perf 类只有 4 条 PR），但它们全都在为**可预测性**服务。`apply LRU watermark at chunk boundaries` 的注释写「This is safe because the range cache is write-through」——这句话不是给编译器看的，是给下一个改这段代码的人看的。**把「为什么这样做是安全的」写进注释而不是写进 commit message**，本身就是把约定从「口头」变成「留档」。

早间日报里 Nadella 要求「每次有意义的动作都留下防篡改、人类可读的证据」。流处理引擎不需要防篡改，但它需要的是同一样东西的工程版本：**每一个隐含假设都应该有一个可查的地方写着它**。v3.1 在做的事——SST 元数据里记过滤器族、deprecated 字段触发 warn 日志、恢复失败带四级定位上下文、不安全参数自带 `unsafe_` 前缀——就是这件事。

---

## 写在最后

选这个版本是因为它的 release notes body 在同批 40 个基础设施仓库里排第一（56,770 字节），但 feat 只占 78 条。**「body 特别大但 feat 特别少」是「还技术债」的典型信号**，这类版本写出来比「发布新功能」的版本信息密度高得多——每个改动都有一个「过去为什么不行」的故事。

与早间 AI 日报「五维刹车日」形成的 2026-10-11 全栈日叙事主线是：**早间讲「刹车装在谁的脚下」——模型层主张 + 可买零件 + 劳动博弈 + 付费墙 + 对话渠道五种刹车形态；中午讲流处理引擎里同一种设计哲学的落地——把隐含约定改写成显式契约**。Nadella 说「先假设模型已被入侵再从零遏制」，RisingWave 说「先假设上游会 reshuffle 再设计回填恢复」。同一个世界观，一个在商业层，一个在引擎层。

三个长期判断：

1. **VARIANT + Iceberg V3 的组合会在 12 个月内改变湖仓的 schema 边界**。「先建表再导数据」会让位于「schema 跟着数据走，且字节级可验证」——前提是其他引擎跟进 canonical 化规则（尤其是浮点折叠），否则跨引擎的 variant 语义差异会成为新的「同一个 JSON 在不同系统里不相等」。
2. **no-shuffle backfill 的废弃是流处理回填语义收敛的开始**。「一条 DDL 背后有三条隐含路径」在流处理领域是普遍现状；RisingWave 这次把它们收敛成「快照优先 + 显式回退 + 老路径只读」，其他流引擎在 12-18 个月内会面对同样的收敛压力——因为用户开始把「回填走了哪条路」当成可观测项而不是黑盒。
3. **sync/async trait 拆分是 Rust 流处理引擎「异步传染债务」显性化的第一枪**。Rust 的 async fn in trait 稳定之后，「同步签名背异步实现」这种债就没有技术借口了。观察 12 个月内是否出现 `AsyncAggregateFunction` / `AsyncTableFunction`——如果出现，说明这条重构路线被正式采纳，其他 Rust 写的数据引擎会跟进抄作业。

**数据来源**：RisingWave v3.1.0 release notes（GitHub releases API，body 56,770 字节，366 条 PR）；PR #26080 / #26039 / #25963 / #26561 / #26076 / #26122 / #26640 / #26424 / #25287 / #25864 / #26326 / #25170 / #24561 / #24346 的 PR body 与完整 diff（patch-diff.githubusercontent.com）。本文所有代码示例基于 v3.1.0 的 SLT 测试用例（`e2e_test/streaming/gap_fill_partition_by.slt`、`e2e_test/sink/append_only_sink.slt`、`e2e_test/backfill/locality_backfill/*.slt`）改写。
