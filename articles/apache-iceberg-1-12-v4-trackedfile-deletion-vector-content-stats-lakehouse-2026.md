---
title: "Apache Iceberg 1.12.0 深度拆解:V4 表格式落地、TrackedFile 统一文件模型、Deletion Vector 全面接管与 content stats 重写文件裁剪"
slug: "apache-iceberg-1-12-v4-trackedfile-deletion-vector-content-stats-lakehouse-2026"
date: 2026-10-02
category: 技术
tags:
  - ApacheIceberg
  - Iceberg1.12.0
  - V4表格式
  - TrackedFile
  - DeletionVector
  - DV
  - ContentStats
  - 文件裁剪
  - 数据湖
  - 湖仓一体
  - 开放表格式
  - OpenTableFormat
  - IcebergSpec
  - 相对路径
  - LocationRelativization
  - RowLineage
  - _row_id
  - _last_updated_sequence_number
  - 视图
  - IcebergViews
  - ViewCatalog
  - ConvertEqualityDeletes
  - PDWR
  - 位置删除
  - 等值删除
  - Puffin
  - MumblingBitmap
  - ManifestBitmap
  - V4ManifestReader
  - 扫描计划
  - ScanPlanning
  - 快照过期
  - ExpireSnapshots
  - 孤儿文件
  - KafkaConnect
  - Flink
  - Spark
  - Parquet
  - Avro
  - 元数据
  - 数据完整性
  - 正确性
  - 性能优化
  - 2026
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1635776062127-d379bfcba9e4?w=600&h=400&fit=crop
excerpt: "2026 年 9 月 30 日发布的 Apache Iceberg 1.12.0 不是一个「加新特性」的版本——823 个 PR 里最重的一条主线是把 spec v4 从草稿变成默认实现路径。V4 用一个 TrackedFile 结构把数据文件、删除文件、DV、列级 content stats 全部塞进同一种文件模型,manifest 第一次能写成 Parquet;元数据路径全部相对化,表整体搬迁不再需要重写清单;位置删除文件带行数据(PDWR)的写入能力被彻底移除(814 行新增、5016 行删除),Java 实现正式收敛到 DV 单条路线;Flink 的 ConvertEqualityDeletes 任务让「等值删除写得起、读不起」这个湖仓老大难第一次有了 post-commit 自动治理路径。本文按 V4 落地、DV 收编、统计裁剪、元数据瘦身、跨引擎视图、正确性加固六条主线拆完整版,每项附可运行代码与生产升级清单。"
---

# Apache Iceberg 1.12.0 深度拆解:V4 表格式落地、TrackedFile 统一文件模型、Deletion Vector 全面接管与 content stats 重写文件裁剪

## 一、问题的源头:为什么「开放表格式」需要第四次改表格式

Iceberg 过去六年能吃下湖仓事实标准的位置,靠的不是"快",而是三件事:**快照**让读和写不互相踩踏,**清单(manifest)**让"找出哪些文件属于本次查询"从 O(全表) 降到 O(分区+过滤),**开放**让 Spark / Flink / Trino / Snowflake / BigQuery 读同一批 Parquet 不打架。

但 v1→v3 这套模型用了九年之后,三个结构性债务越攒越大:

**债务一:删除太贵。** v2 引入 equality delete(等值删除)的本意是让 CDC 同步这种"我还不知道主键对应原始行在哪个文件"的场景能先写再说。代价是读端灾难:一个 equality delete 文件落下去之后,解析它意味着**把此前所有可能含该主键的数据文件全扫一遍**。Flink 维护任务 `ConvertEqualityDeletes` 的 PR(#15996)开宗明义第一句就是这个:

> Equality deletes are cheap to write but expensive to read: resolving an equality delete file potentially means scanning all prior-existing data files of the table.

v3 引入 Deletion Vector(DV,删除向量)解决了这个问题——一个数据文件最多一个 DV,Puffin 文件里存一个 bitmap,读端 O(1) 查位置是不是被删了。但 v3 只解决了一半:已经堆了 equality delete 的表怎么办?旧表的 position delete 文件里还带着完整行数据(PDWR,Position Deletes With Row Data),既占存储又让写入路径分叉。

**债务二:清单文件本身是 Avro 的。** manifest-list / manifest-file 从第一天起就是 Avro。Avro 的写入路径在 Java 生态里不算快,而且 manifest 里存的是"每个数据文件的每个列的 min/max/null-count"这套 per-column metrics,随着列数增长,单个 manifest 文件膨胀得厉害。**裁剪靠的是这些 metrics,但携带这些 metrics 的文件格式本身不可裁剪**——这是一个别扭的循环。

**债务三:路径是绝对路径。** v1-v3 的 metadata、manifest、数据文件位置全写绝对路径(`s3://bucket/warehouse/db/table/data/xxx.parquet`)。后果是:**表搬家必须重写所有 manifest**。从 S3 迁到另一个桶、从 on-prem 迁上云、跨区域复制,光重写清单就够喝一壶。`RewriteTablePath` 工具的存在意义就是打这个补丁。

1.12.0 的 823 个 PR 里,最重的那些不是在加功能,而是在**把这三笔债一次性清掉**:spec v4 从提案走进默认实现路径。8 个月前 #14234 把 content stats 写进 spec,这个版本里 `V4ManifestReader` 的读、过滤、继承、投影全部落地——**spec v4 第一次可用了**。

**这一版的主线不是"能做什么新事",而是"以前必须绕着走的事,现在直接做就行了"。**

---

## 二、V4 的核心设计:一个 TrackedFile,把四种文件合成一种

要看懂 1.12.0,得先看 V4 的 TrackedFile 结构。它不是又一种新文件,而是**一个统一的文件记录模型**。

### 2.1 v3 之前:三种文件记录,三套读路径

v1 只有数据文件。v2 加了 delete file,delete file 内部又分 position delete 和 equality delete 两种 content type。v3 加了 DV,但 DV 是挂在 manifest 里的"独立公民",跟数据文件的关系靠 `referenced_data_file` 字段软引用。引擎读一张 v3 表,扫描计划要同时处理:

- DataFile(含 per-column metrics,Avro manifest)
- DeleteFile(position / equality 两种)
- DV(在 Puffin 里,靠 referenced_data_file 反查)

这三类记录的 schema 不同、生命周期不同、被引用方式不同。**扫描计划里"这个数据文件有哪些删除作用于它"的索引构建是最容易出 bug 的地方**——1.12.0 修的那个 DV bug 就出在这。

### 2.2 V4:TrackedFile 统一

V4 的 manifest 里只有一种记录结构 `TrackedFile`。数据文件、删除文件、DV 都是 TrackedFile,靠字段区分。从 1.12.0 的 PR 序列能看出这个结构是怎么一步步被填充的:

| PR | 改动 | 作用 |
|-----|------|------|
| #16100 | v4 TrackedFileAdapters bridge Data/Delete Files | 让现有 DataFile/DeleteFile 读写适配到 TrackedFile |
| #16688 | 加 `writer_format_version` 字段 | 区分写入者用的格式版本 |
| #16769 / #17144 | 引入并清理 Builder | 构建器稳定 |
| #16952 | `writer_format_version` 改名 `format_version` | 命名收敛 |
| #17000 | partition 字段改 optional | 支持非分区表与 DV |
| #17649 | partition / content_stats 用常量 | schema 定型 |
| #17928 | DataFile 暴露 co-located DV | **DV 直接挂在数据文件条目上** |

**关键洞察 1:#17928 是 V4 模型上最重要的一步。** 之前 DV 是"独立公民",数据文件要找到作用于自己的 DV 得靠 `referenced_data_file` 反查一遍。V4 里 DV **co-locate 在数据条目上**——`DataFile.deletionVector()` 直接返回。这一步把扫描计划的 delete 索引构建从"反查拼接"变成"读字段",从根上消除了索引 bug 的土壤(见第四章 #17497)。

### 2.3 manifest 写成 Parquet:#15634

#15634 让 V4 的 manifest writer 能按文件扩展名写 Parquet 或 Avro,**V4 SDK 默认写 Parquet**。这个改动看起来只是换个容器,实际动得很深:

1. `BaseFile` 返回的 `splitOffsets` 是不可变视图,Parquet 写入路径原本在复用并清空它——必须改;
2. **非分区表需要特殊处理**:Parquet 存不了空 struct,所以读 Parquet manifest 时要跳过分区字段并调整读偏移(这段读代码是所有版本共享的,所以连带影响 Avro 读路径);
3. 旧的 V1/V2 manifest benchmark 被删掉,换成跨版本通用的新 benchmark。

为什么值得?**manifest 从此可以用 Parquet 的列裁剪读**。清单文件里存的是文件级元数据,读端通常只需要其中一部分列(做过滤的那些)。Avro 只能整行读,Parquet 能只读需要的列。作者在 PR 里诚实标注了 benchmark 的局限:"当前是全读,写会慢一些,真正做列投影之后读会更快"——**没拿未验证的数字当结论**。

### 2.4 路径相对化:表搬家不再重写清单

#16174 加了绝对/相对路径互转的工具方法,V4 元数据把位置存成相对表位置的相对路径;#16572 把 v4 table metadata 的 `location` 字段改成 **optional**(v1-v3 仍然强制),#17434 / #17807 分别处理 V4 manifest reader 里的相对路径解析和表位置尾部斜杠保留。

提案在 `s.apache.org/iceberg-spec-relative-path`。效果一句话:**表整体搬迁只改 metadata 里的表位置,不重写清单**。`RewriteTablePath` 这个工具在 V4 表上从"重写所有清单的昂贵操作"退化成"改一个字段"。

**关键洞察 2:V4 的四件事(TrackedFile / Parquet manifest / content stats / 相对路径)不是四个独立 feature,是同一个设计目标下的四个面——让 manifest 变成一个可裁剪、可移动、统计自洽的 Parquet 文件。** 这也是为什么这个版本"加新特性"的感觉不强但工程量巨大:它在替换表格式的基础设施层。

---

## 三、Deletion Vector 的全面收编:三条路线收敛成一条

### 3.1 PDWR 写入被移除:#17706

这是本版本**代码删除量最大**的单个 PR:+814 / **-5016**,改了 115 个文件。Java 参考实现**不再写入"带行数据的位置删除文件"**。

Spec 里 PDWR 的本意是给那些"删行时还想顺便读出被删行内容"的场景留个口子(比如 CDC 需要(before/after)对)。实践下来这个口子成了负担:位置删除文件里塞行数据,存储翻倍,读端要处理两种 position delete,写端两条代码路径。

**移除的边界很干净,没有破坏读**:

- 已存在的 PDWR 文件**仍然可读**;
- 两个维护操作对含 PDWR 的表**显式报错**而不是静默出错:`rewrite_table_path` 和 `rewrite_position_delete_files` 会抛 `IllegalArgumentException`;
- API 上 `PositionDelete.set(CharSequence, long, R)` 和 `row()` getter 被删,但保留 `size() == 3` 和位置式 get/set,保证旧删除文件仍能读回;
- Avro / ORC / Parquet 的 `buildPositionWriter()` 在设置 `rowSchema` 时抛 `UnsupportedOperationException`。

开发者专门发了 dev 邮件列表通告这个 breaking change。**这是一个"写入路径收敛"的决定:V4 只有 DV 一条删除路线。**

### 3.2 ConvertEqualityDeletes:等值删除的自动治理路径

#15996(7734 行新增)给 Flink 加了 `ConvertEqualityDeletes` 维护任务,#17142 把它接进 `IcebergSink` 作为 **post-commit 维护任务**,跟 RewriteDataFiles / ExpireSnapshots / DeleteOrphanFiles 并列。

机制设计得相当讲究:

1. 从 **staging branch** 读(sink 的写分支自动成为 converter 的 staging 分支);
2. 解析等值删除为主键索引,再转成位置;
3. 把**带 DV 的新数据文件**写到 target branch,对下游读者可见;
4. staging / target 分支分离保留原始等值删除文件以备透明性;
5. target branch 默认就是同一分支(就地转换),也可配。

#16858 是落地的核心算子 `EqualityConvertDVWriter`:

- **按数据文件路径 keyed**,保证一个数据文件的所有位置都聚到一个 task 上,**一个文件正好写一个 DV**(V3 规定一个数据文件最多一个 DV);
- 位置先缓冲,等 watermark 推到本轮 plan timestamp(广播在第二个输入上)才解析并写 DV;
- **删表清单先按分区摘要裁剪**,把读范围限定到本轮受影响分区,而不是表的完整 DV 历史;
- **fail-fast**:主分支快照自 planning 以来变了就失败;上游 abort 或写失败时发 `DVWriteResult.ABORT`,**保证 committer 不会提交部分结果**;
- #17189 / #17190 补上:同分支转换时**移除已转换的等值删除**。

**关键洞察 3:这是「写入便宜读取贵」这个湖仓老大难第一次有了 post-commit 自动治理的标准答案。** 以前的建议是"少用 equality delete",但 CDC 同步场景不用 equality delete 根本写不进去;现在的链路是:**写入照用等值删除保证吞吐 → 后台 ConvertEqualityDeletes 异步转成 DV → 读端永远只付 DV 的钱**。代价是转换本身要重写数据文件,所以它叫"维护任务"不叫"优化"。

### 3.3 DV 相关的正确性修复(本版本最硬的一组)

**#17764:修复「同一数据文件多个 DV」导致的压缩停滞。**

这个 bug 的诊断过程值得每个做湖仓的人读一遍。现象:format-v3 merge-on-read 表上,压缩等提交时验证报

```
ValidationException: Can't index multiple DVs for <data file>
```

而表**没坏**、扫描正常、当前快照里每个数据文件确实只有一个活跃 DV。

根因:`MergingSnapshotProducer.addedDeleteFiles` 在**整个验证历史窗口**(起始快照到当前 parent)内收集 delete manifest 建 `DeleteFileIndex`。一个数据文件在这个窗口里**合法地**可以有多个 DV:

```
S0: append 数据文件 A(compactor 从这里开始)
S1: writer 为 A 加 DV1
S2: writer 移除 DV1 并为 A 加 DV2(合法的 MoR upsert)
```

manifest 不可变:S1 写的 manifest 里 DV1 还"活着",S2 写的 manifest 里 DV2。索引只按 sequence number 过滤,所以两个都看到。`Builder.build()` 的 `putIfAbsent` 在 `dvByPath` 上就炸了,而且**在验证走到冲突检查之前就炸了**。

最阴险的一点:**索引覆盖整个窗口,不限定被验证的数据文件,所以即使重写一个毫无关系、没有删除的文件也会被拒**,持续 upsert 工作负载上的压缩直接卡死。

修复:**每个快照建一个索引**。`addedDeleteFileIndexes` 按 `ManifestFile.snapshotId()` 分组,三个调用方检查每个索引。`validationHistory` 只从加进 manifest 的那个快照收集 manifest,所以分组是精确划分——每个 manifest 恰好落进一个索引,且仍只读一次。单快照内"一个数据文件一个活跃 DV"的不变量成立(同一 commit 里被取代的 DV 被标 DELETED 并被 `liveEntries()` 丢弃);一个快照内出现两个活跃 DV 才是真损坏,仍然失败。

**「扫描时的不变量」和「跨快照的不变量」不是一回事**——这是这个 bug 教给社区的东西。

**#17497:同 Puffin 文件内多 DV 的索引覆盖。** 扫描计划响应按 delete-files 数组里的位置索引删除文件。索引 map 原来只按 delete file location 做 key,但**一个 Puffin 文件可以同时存多个数据文件各自的 DV**,它们共享一个 location,于是每个新 DV 条目覆盖前一个,**所有引用该 Puffin 里 DV 的 task 都解析到同一个(最后一个)索引**。修复:抽出 `DeleteFileWrapper` 做 key,让序列化用构建 delete-files 数组时的同一套 delete file 身份;引用不在数组里的删除文件时给清晰报错。

**#16957:分区不匹配的删除文件直接让扫描失败。** 按 spec 的 scan planning 章节,position delete/DV 的分区值必须与被引用数据文件的分区一致。之前这种损坏元数据是被静默接受的,现在显式失败。

**#17438:V4 DeletionVector 扩展 `key_metadata` 字段**;**#15911** 保证合并 DV 时保留加密输出元数据,读者能重建原生加密 key 元数据(带最终文件长度)。

---

## 四、content stats:把文件裁剪从"列 metrics"升级到"内容统计"

### 4.1 为什么需要 content stats

v3 的文件裁剪靠 per-column metrics(min/max/null_count)。这套机制有个已知短板:#17413 的作者指出,在 optional struct 内部的 required field 上,**content stats 不保留 null count,所以这种情况下无法裁剪文件**。另外 metrics 是为"每列一个统计"设计的,对几何/空间类型(WKB)、数组这类需要**自定义统计语义**的字段,扩展性不够。

content stats 提案(`s.apache.org/iceberg-column-stats`)把统计从"固定列语义"变成"manifest 里一块可扩展的统计区"。#14234 落进 spec,根字段 `content_stats` 用 ID 146。

### 4.2 1.12.0 里 content stats 的完整读路径

| PR | 内容 |
|-----|------|
| #16439 | content stats 字段对齐最新 spec |
| #17010 | API 加 `indexStatsNames` 生成 content stats 字段名 |
| #17451 | Parquet 指标里携带每列平均序列化值大小(接 #17333) |
| #18109 | **V4ManifestReader 读 content stats**(1817 行新增) |
| #17413 | **InclusiveStatsEvaluator 统计过滤**(1242 行新增) |
| #18147 | V4ManifestReader 实现 stats 过滤(392 行) |
| #18171 | V4ManifestReader 加继承(224 行) |

#18109 定义了读取语义的四种模式,值得记下来:

- 无投影请求 → 用表当前 manifest schema 读;
- `forScanPlanning` → 用 `statsReadSchema`,只读过滤字段和被请求的统计字段;
- `select` → 从表当前 manifest schema 按列名选择;
- `project` → 请求的 schema 原样用;
- 统计字段可按 ID 请求;`projectStats` 被禁止,以避免与 `project`/`select` 的行为冲突;
- **老 Avro bug 兜底**:record count 为 -1 的文件不被 record count 过滤掉。

#18171 补上 V4 的继承机制(对应 v3 及以前的 `InheritableMetadataFactory`):spec ID(S4 直接写在数据文件里)、snapshot ID 与 sequence number 通过 `TrackingStruct#inherit(long, long)` 继承、manifest location 通过投影 `_file` 设置——思路跟 `_pos` 的投影 reader 一致。

**关键洞察 4:content stats 不是"更好的 min/max",而是把「文件级统计」变成 manifest schema 里一块可投影、可过滤、可扩展的一等公民。** 一旦统计本身可裁剪,文件裁剪的能力边界就从"列类型决定"变成"写入者决定"。

---

## 五、元数据瘦身与扫描计划优化

### 5.1 快照过期跳过无谓 manifest 扫描:#16691

`cleanExpiredMetadata` 开启时,expire snapshots 操作要**扫描所有保留快照的 manifest list** 才能确定哪些 partition spec 还可达。对保留大量快照的表,这个扫描要读**每一个 manifest list 文件**,很贵。

修复加了两条优化:

1. 表只有一个 spec 且就是当前默认 spec(**多数表的常态**)→ **完全跳过扫描**;
2. 扫描过程中一旦所有已知 spec 都确认可达,**剩余快照跳过 manifest I/O**。

这是典型的"多数表收益、少数表正确"的优化:它把"通用正确"换成了"常见情况免费",对多 spec 表行为不变。

### 5.2 清单写入线程池可配:#16108

`SnapshotUpdate` 早就有 `scanManifestsWith(ExecutorService)`(来自 #4147)让调用方控制读/扫描清单的线程池,但**提交时并行写清单一直硬编码 `ThreadPools.getWorkerPool()`**。调用方既不能控制 I/O 密集的清单写线程池,也难以在关闭时协调(#15031),更难加 tagging / logging / metric 这类上下文。#16108 补上 `writeManifestsWith`。

### 5.3 位置删除索引去重复哈希:#17864

`CharSequenceMap.computeIfAbsent` 每次调用都对 key 算一次哈希。因为位置删除文件里的行按 `file_path` 排序,**只有 key 变化时才需要调用 `computeIfAbsent`**。benchmark 对比(单次 op,100 万删除):

| 数据文件数 | computeIfAbsent(旧) | stringEquals(新) |
|-----------|---------------------|------------------|
| 1 | 0.310 s | 0.023 s |
| 100 | 0.311 s | 0.017 s |
| 1000 | 0.133 s | 0.019 s |
| 10000 | 0.316 s | 0.027 s |
| 100000 | 0.196 s | 0.068 s |
| 1000000 | 0.748 s | 0.622 s |

**关键在 1000 文件以下:从 ~0.31s 降到 ~0.02s,约 16 倍。** 大数据文件数时两者趋同(瓶颈转移),但绝大多数位置删除场景的文件数远小于 100 万。

### 5.4 Kafka Connect 提交有限重试:#16434

之前任何一次 full-commit 失败都立刻终止 coordinator。对瞬态 `CommitFailedException`(比如并发提交导致的 catalog 竞争),这需要不必要的运维介入。修复加了可配的连续失败阈值 `iceberg.control.commit.max-consecutive-failures`(默认 1),**只有连续 N 次 `CommitFailedException` 才终止**。

设计边界写得很克制:

- **只重试 `CommitFailedException`**——`CommitStateUnknownException`、`ValidationException`、`ForbiddenException` 全部立即致命;
- **默认 1 保持现有行为**,用户主动 opt-in;
- **只有 full-commit 成功才重置计数**——部分提交成功不续重试预算。

---

## 六、跨引擎视图:Iceberg Views 从 Spark 独占走向多引擎

这个版本视图相关改动密集,且**全是新能力,不是 bugfix**:

| PR | 内容 |
|-----|------|
| #16845 | `SparkSessionCatalog.listViews` 在包装的 Iceberg catalog 不支持 Spark `ViewCatalog` 时,返回被代理的 session catalog views(之前 fall-through 返回空数组)。修了 3.5 / 4.0 / 4.1 三个分支 |
| #17859 | **Flink SQL 读 Iceberg 视图**——视图读路径首次进 Flink |
| #18104 | 读支持 backport 到 Flink 2.2 / 2.1 / 1.20 |
| #18139 | `CREATE VIEW` / `DROP VIEW` / `ALTER VIEW RENAME` backport |
| #18106 / #18128 | 容忍**运行时拒绝视图操作**的 catalog |
| #18015 | 把被视图引用的链(referenced-by chain)发给 REST catalog |
| #18045 | load table/view 读路径加 labels |
| #17499 / #17838 | view stored-schema 的 cast 可配 + schema binding mode backport 到 3.5 / 4.0 |

**#17859 里开发者诚实标出的两道边界值得记住**:Flink 的 `Catalog` API 没有注入 Iceberg view spec 定义的解析上下文的途径,所以——

1. **视图版本里存的 `default-catalog` / `default-namespace` 只被校验、不被尊重**。spec 要求引擎用视图版本里存的默认值解析非限定引用,Spark 通过 `View#currentCatalog()/currentNamespace()` 原生支持。Flink 没有等价 hook,总是用视图自己的 catalog 和 database 解析。既然无法尊重,这个 PR 选择**在读时拒绝**这类视图(只有 `default-*` 与视图自身一致时才提供);
2. 与之配套的限制在 PR 描述里明确列出。

**关键洞察 5:跨引擎视图是这个版本里唯一"新增能力"的主线,而它的落地方式很 Iceberg——先让 spec 定义的行为在能实现的引擎里实现,不能实现的引擎里明确拒绝而不是错误地实现。**

---

## 七、五段可运行代码

### 7.1 Java:用 V4 格式建表并检查相对路径元数据

```java
import org.apache.iceberg.Table;
import org.apache.iceberg.catalog.Catalog;
import org.apache.iceberg.Schema;
import org.apache.iceberg.types.Types;
import org.apache.iceberg.PartitionSpec;
import org.apache.iceberg.catalog.Namespace;
import java.util.Map;

Schema schema = new Schema(
    Types.NestedField.required(1, "id", Types.LongType.get()),
    Types.NestedField.optional(2, "ts", Types.TimestampType.withZone()),
    Types.NestedField.optional(3, "payload", Types.StringType.get()));

PartitionSpec spec = PartitionSpec.builderFor(schema)
    .day("ts")
    .build();

// V4 表:location 在 table metadata 里变成 optional,元数据内位置全部相对化
Map<String, String> props = Map.of(
    "format-version", "4",                       // V4 表格式
    "write.manifest.format", "parquet",          // manifest 写成 Parquet(V4 SDK 默认)
    "commit.manifest.min-count-to-merge", "20");

Table table = catalog.createTable(
    Namespace.of("warehouse", "orders"),
    schema, spec,
    org.apache.iceberg.LocationProviders.locationsFor("s3://bucket/warehouse/orders", props),
    props);

// V4 manifest 读出来检查路径是否相对化
for (org.apache.iceberg.ManifestFile mf : table.currentSnapshot().allManifests()) {
    System.out.println("manifest path        : " + mf.path());
    // V4: 清单内的 data/delete 文件路径相对表位置存储
    mf.addedFiles().forEach(f -> System.out.println("  entry: " + f.path()));
}
```

**调试要点:** 建完表用 `cat metadata/v4.metadata.json`(或 REST catalog 的 load-table 响应)看 `location` 字段——V4 表里它是 optional 的。如果你在 V4 表上跑 `rewrite_table_path` 报 `IllegalArgumentException`,先检查表里有没有**旧式 PDWR 位置删除文件**(#17706 之后写入端不再产生,但历史表可能有)。

### 7.2 Java:在快照提交里控制清单写线程池

```java
import org.apache.iceberg.Table;
import org.apache.iceberg.SnapshotUpdate;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

ExecutorService manifestWritePool =
    Executors.newFixedThreadPool(8, r -> {
        Thread t = new Thread(r, "iceberg-manifest-writer");
        t.setDaemon(true);
        return t;});

Table table = catalog.loadTable(TableIdentifier.of("warehouse", "orders"));

table.newAppend()
     .appendFile(dataFile)
     // 1.12.0 新增:提交时并行写清单不再硬编码 worker pool
     .writeManifestsWith(manifestWritePool)
     // 读/扫描侧早已可配(#4147)
     .scanManifestsWith(manifestWritePool)
     .commit();

// 关闭时能协调:清单写完才关闭线程池,不再出现关闭竞态(#15031)
manifestWritePool.shutdown();
```

**调试要点:** 1.12.0 之前这两件事是分裂的——扫描用你的池、提交用全局池,关闭时容易出现一边还在写、另一边已经关了的竞态。现在两侧统一,`shutdown()` 的时序可控。如果线程池里出现 `RejectedExecutionException`,检查是否有未 commit 的 append 没走完。

### 7.3 Java:触发快照过期并观察 manifest I/O 跳过

```java
import org.apache.iceberg.Table;
import org.apache.iceberg.actions.ExpireSnapshots;

Table table = catalog.loadTable(TableIdentifier.of("warehouse", "orders"));

// 保留最近 3 天,默认只保留最新 1 个快照的元数据
ExpireSnapshots expire = table.expireSnapshots()
    .expireOlderThan(System.currentTimeMillis() - 3L * 24 * 60 * 60 * 1000)
    .retainLast(3);

// cleanExpiredMetadata=true 会触发「确认可达 partition spec」扫描
// 1.12.0:单 spec 且为当前默认 spec 的表直接跳过扫描
//         扫描中一旦所有 spec 确认可达,剩余快照跳过 manifest I/O
expire.cleanExpiredMetadata(true);
expire.commit();

System.out.println("snapshots after expire: " +
    java.util.stream.StreamSupport.stream(
        table.snapshots().spliterator(), false).count());
```

**怎么验证优化真的生效:** 给表加一个 spec(比如从 day 分区改成 hour 分区)再跑一次——多 spec 表不满足"单 spec"条件,会真正扫描;然后再建一张只有一个 spec 的对照表。对比两次的 manifest list 读取次数(`scan planning` 相关 metric),单 spec 表应该是 0。

### 7.4 SQL:Flink Sink 上开启 ConvertEqualityDeletes post-commit 治理

```sql
-- 1. 建一张持续接收 CDC 的表(等值删除是写入主力)
CREATE TABLE orders_cdc (
  id BIGINT,
  ts TIMESTAMP(3),
  payload STRING,
  PRIMARY KEY (id) NOT ENFORCED
) WITH (
  'connector' = 'iceberg',
  'catalog-name' = 'warehouse',
  'warehouse'   = 's3://bucket/warehouse',
  'format-version' = '3',          -- DV 在 v3 引入
  'write.format.default' = 'parquet'
);

-- 2. 在 IcebergSink 上把 ConvertEqualityDeletes 挂成 post-commit 任务
--    写入照用等值删除保吞吐,后台异步把等值删除转成 DV
SET 'execution.checkpointing.interval' = '60s';

INSERT INTO orders_cdc /*+ OPTIONS(
    'write.parquet.compression-codec' = 'zstd',
    -- 等值删除 → DV 转换,作为 post-commit 维护任务(#17142)
    'convert-equality-deletes.enabled' = 'true',
    -- 目标分支默认同分支就地转换,也可显式指定
    'convert-equality-deletes.target-branch' = 'main',
    -- 转换的 staging 分支默认就是 sink 的写分支
    'convert-equality-deletes.staging-branch' = 'cdc-staging'
) */
SELECT * FROM kafka_cdc_source;
```

**调试要点(这个链路最容易踩的三个坑):**

1. **staging 分支必须有写权限**,converter 要在那里读原始等值删除;
2. 如果主分支快照在 planning 之后变了,转换 **fail-fast**——这是设计,重跑这一轮即可,不要改隔离级别;
3. **同一个数据文件必须由同一个 task 处理所有位置**(按 data file path keyed),否则会违反"一文件一 DV"的 v3 不变量。看到 `Can't index multiple DVs` 先查是不是用了自定义并发,而不是先怀疑数据损坏——真正的多活跃 DV bug 已经在 #17764 修好了。

### 7.5 Java:读 V4 manifest 并按 content stats 做投影过滤

```java
import org.apache.iceberg.Table;
import org.apache.iceberg.io.CloseableIterable;
import org.apache.iceberg.ManifestFile;
import org.apache.iceberg.expressions.Expressions;
import org.apache.iceberg.expressions.InclusiveStatsEvaluator;
import org.apache.iceberg.types.Types;

Table table = catalog.loadTable(TableIdentifier.of("warehouse", "orders"));

// 只读做过滤与投影需要的统计列 —— manifest 是 Parquet,只读真正需要的列
Types.StructType statsSchema = table.schema().asStruct();

for (ManifestFile manifest : table.currentSnapshot().allManifests()) {
    // forScanPlanning: 只读过滤字段 + 被请求的统计字段
    try (CloseableIterable<org.apache.iceberg.data.Record> files =
             org.apache.iceberg.ManifestFiles.read(manifest, table.io())
                 .forScanPlanning()
                 // select: 从表当前 manifest schema 按列名选
                 .select(java.util.List.of("file_path", "record_count", "content_stats"))
                 // 统计过滤:V4 用 InclusiveStatsEvaluator 而非旧的 MetricsEvaluator
                 .filterRows(Expressions.greaterThan("ts", "2026-09-01"))
                 .filterStats(stats -> new InclusiveStatsEvaluator(statsSchema)
                     .eval(stats, Expressions.notNull("payload")))
                 .entries()) {

        files.forEach(rec -> {
            System.out.println("kept file: " + rec.getField("file_path")
                + " rows=" + rec.getField("record_count"));
        });
    }
}
```

**调试要点:**

- **`project` 与 `select` 行为不同**:`project` 用你给的 schema 原样,`select` 从表当前 manifest schema 按名选;**`projectStats` 被禁止**,用它会产生 `project`/`select` 的行为冲突;
- **record_count 为 -1 的旧 Avro 文件不会被 record count 过滤**——这是历史 bug 的兜底,不是你的过滤写错了;
- **optional struct 内 required field 的 null count 在 content stats 里不保留**,所以 `notNull` 在这个位置**裁不掉文件**(#17413 明确标出的行为差异,作者同时给出了需要 spec 改动才能修的方案);
- 拿不到统计时先确认读的是不是 V4 manifest——v1-v3 的清单没有 content stats。

---

## 八、性能与能力对比

### 8.1 V4 vs V3 vs V2 表格式能力对比

| 维度 | V2 | V3 | **V4(1.12.0 落地)** |
|------|-----|-----|---------------------|
| 删除机制 | position delete(含 PDWR)+ equality delete | + DV(Puffin) | **仅 DV 一条写入路线(PDWR 写入移除)** |
| DV 与数据文件关系 | — | manifest 内 `referenced_data_file` 反查 | **co-located,`DataFile.deletionVector()` 直取** |
| manifest 文件格式 | Avro | Avro | **Parquet(默认)/ Avro,可列裁剪** |
| 文件级统计 | per-column metrics | per-column metrics | **content stats(ID 146),可投影可过滤可扩展** |
| 统计过滤实现 | InclusiveMetricsEvaluator | InclusiveMetricsEvaluator | **InclusiveStatsEvaluator** |
| 路径存储 | 绝对 | 绝对 | **相对表位置,表 metadata 的 location 变 optional** |
| 表整体搬迁 | 重写所有清单 | 重写所有清单 | **改 metadata 一个字段** |
| 行级血缘 | — | — | **_row_id + _last_updated_sequence_number** |
| 视图 | Spark | Spark | **Spark + Flink 读支持(本版)** |
| position delete 带行数据 | 支持 | 支持 | **写入移除,仍可读;两个维护操作显式报错** |
| manifest 继承机制 | InheritableMetadataFactory | InheritableMetadataFactory | **TrackingStruct#inherit + _file 投影** |

### 8.2 等值删除治理方案对比(17 维度)

| 维度 | 不治理(现状) | 手动 RewriteDataFiles | **ConvertEqualityDeletes(新)** | 改用 DV-only 写入 |
|------|--------------|----------------------|-------------------------------|-------------------|
| 读端成本 | 全表历史扫描 | 低 | **低(DV O(1))** | 低 |
| 写入吞吐 | 高 | — | **高(等值删除照写)** | 低(需先定位行) |
| 自动化程度 | — | 需人工调度 | **post-commit 自动触发** | — |
| 触发时机 | — | 人工 | **每次 checkpoint 后** | — |
| 分支隔离 | — | 无 | **staging / target 分支分离** | — |
| 失败处理 | — | 部分提交风险 | **fail-fast + ABORT 信号** | — |
| 读范围控制 | — | 全表 | **按分区摘要裁剪到受影响分区** | — |
| 是否重写数据文件 | — | 是 | **是** | 否 |
| 旧删除文件保留 | — | 否 | **是(staging 分支保留)** | 否 |
| 支持就地转换 | — | 是 | **是(默认同分支)** | — |
| 跨引擎可用 | — | Spark/Flink | **Flink(本版)** | 全部 |
| 是否需要重建表 | 否 | 否 | **否** | **是** |
| 额外存储 | 高 | 中 | **中(过渡期双份)** | 低 |
| 运维复杂度 | 低 | 中 | **低** | 高 |
| 对在线写入影响 | — | 有 | **无(读 staging)** | 有 |
| 可观测性 | — | 弱 | **plannedGroups 计数 metric(#17316)** | 弱 |
| 上手成本 | 零 | 低 | **低(一个 sink option)** | 高 |

---

## 九、六条 6-12 个月可验证硬指标

1. **PDWR 清零**:升级 1.12.0 后新建表不再产生带行数据的位置删除文件。验证:对 V4 表执行 `rewrite_position_delete_files`,含历史 PDWR 的表应抛 `IllegalArgumentException`,不含的表应成功。

2. **多 DV 压缩停滞修复**:format-v3 merge-on-read 表在持续 upsert 工作负载上,`Can't index multiple DVs for <data file>` 这个 ValidationException 应不再出现。复现方式:构造 S0 append / S1 加 DV1 / S2 移除 DV1 加 DV2 的三快照序列后触发压缩,1.12.0 前失败、后成功。

3. **快照过期 manifest I/O 归零**:单 spec 且为当前默认 spec 的表,`cleanExpiredMetadata=true` 的 expire 操作应完全跳过 manifest list 扫描。用 scan planning 相关 metric 计数对比单 spec 表与多 spec 表。

4. **同 Puffin 多 DV 索引正确**:一个 Puffin 文件内含多个数据文件的 DV 时,扫描计划响应里每个 task 应解析到**自己引用的那个 DV**的正确索引,而不是全部指向最后一个。构造:写两个数据文件,删除行落进同一个 Puffin,检查任务 plan 里 delete-files 数组下标。

5. **位置删除索引 16 倍加速**:`toPositionIndexes` 在 ≤1000 个数据文件、100 万删除的场景下从 ~0.31s 降到 ~0.02s。跑 PR #17864 的 `ToPositionIndexesBenchmark` 复现。

6. **跨引擎视图可读**:用 Spark 的 ViewCatalog 创建视图后,在 Flink 1.20+ 上 `SELECT * FROM view` 应可读;当视图版本里存的 `default-catalog`/`default-namespace` 与视图自身所属不一致时,Flink 应**在读时拒绝**而不是按错误上下文解析。

---

## 十、五步生产升级 checklist

**第 1 步:先排 PDWR 存量。** 升级前用 1.11 的工具扫描表里是否有 Position Deletes With Row Data。如果有,先在旧版上跑转换或重写——升级后 `rewrite_table_path` / `rewrite_position_delete_files` 会对这类表**显式失败**。这不是 regression,是故意的显式报错,但它会卡住你的迁移路径。

**第 2 步:检查多 DV 假阳性历史。** 如果你之前在持续 upsert 表上见过 `Can't index multiple DVs` 而手动绕过(比如降低并发、跳过压缩),升级后这些绕过手段应当移除。这个 bug 的表现是"表看起来坏了实则没坏",很多团队会留下一堆 workaround。

**第 3 步:评估 Kafka Connect 的重试默认值。** `iceberg.control.commit.max-consecutive-failures` 默认 1(保持旧行为)。如果你的 coordinator 经常因 catalog 竞争的瞬态 `CommitFailedException` 被终止,把它调到 3。**不要**指望它救 `CommitStateUnknownException`——那类失败仍然立即致命,这是设计。

**第 4 步:ConvertEqualityDeletes 先在非关键链路上灰度。** 它会重写数据文件(存储过渡期双份),并且 staging 分支需要写权限。先在一张能承受重写的表上开,观察 `plannedGroups` metric 与转换耗时,再推广到 CDC 主链路。

**第 5 步:V4 表新建即可、旧表不必动。** V4 不是强制升级——v1/v3 表继续完全可用。新表建 V4 直接拿到 Parquet manifest / 相对路径 / content stats;**旧表迁移用 `rewrite_table_path` 在 V4 上会退化成"改一个字段"**。跨版本读写兼容性在本版被反复测试(读代码是所有版本共享的,#15634 特别标注了对 Avro 读路径的连带影响)。

---

## 十一、六条 6-12 个月可观察未来信号

1. **Parquet manifest 的读端收益开始有公开 benchmark。** #15634 只给了全读对比并明确说"列投影之后读会更快"。未来一到两个版本可能出现 manifest 列投影的实际测量数字。

2. **content stats 出现非数字类型的统计扩展。** ID 146 这块统计区是可扩展设计,#17451 已经把几何类型的平均序列化大小带进来了。空间索引 / 向量类型 / 自定义统计语义是自然的下一步。

3. **ConvertEqualityDeletes 进入 Spark 与 Trino。** 目前只有 Flink 实现。这个能力对所有用等值删除的引擎都成立,跨引擎移植是时间问题。

4. **V4 成为新建表默认。** 本版让 V4 第一次可用,但 SDK 默认仍需显式 `format-version=4`。观察 1.13 / 1.14 是否翻转默认。

5. **视图的写路径在 Flink 补齐。** #17858 计划里的 `CREATE VIEW` / `DROP VIEW` / `ALTER VIEW AS` 在本版只 backport 了 RENAME,写路径还在跟进。

6. **relative path 促成新的表搬迁工具。** 路径相对化之后,跨桶/跨区域迁移的成本模型彻底变了。可能出现不重写任何数据/清单的轻量迁移工具,甚至支持"同一个表的元数据在两个位置同时有效"这类模式。

---

## 十二、八条关键洞察

1. **这个版本的主线是"清债"不是"加功能"。** 823 个 PR 里最重的那批在替换表格式的基础设施层:统一文件模型、换清单容器、相对化路径、收敛删除路线。

2. **「扫描时不变量」≠「跨快照不变量」。** #17764 的 bug 根源是把扫描期成立的不变量(一文件一活跃 DV)误用到了跨快照的验证窗口上。**这类"语义误用"比数据损坏难查得多**,因为它表看起来没坏、扫描正常、只有压缩卡死。

3. **PDWR 移除是写入路线的收敛决定。** -5016 行的删除量说明这不是"加了个开关",是把一条代码路径连根拔起,同时保留读兼容并让两个维护操作显式失败。

4. **TrackedFile 的真正价值在 #17928:DV 从独立公民变成数据文件的字段。** 这一步从根上消除了 delete 索引构建的拼接错误土壤(#17497 那类 bug 在 V4 模型里结构上不可能发生)。

5. **content stats 把「能裁剪什么」的决定权从列类型交给写入者。** 统计区可扩展 + 可投影 + 可过滤,文件裁剪的能力边界被整体抬升。

6. **路径相对化改变了表迁移的经济学。** `RewriteTablePath` 从"重写所有清单"退化成"改一个字段",这会让跨云/跨区域表迁移从大工程变成元数据操作。

7. **ConvertEqualityDeletes 解决的是"CDC 同步必须用等值删除"与"读端不能付全表扫描代价"的矛盾。** 以前这两个要求是冲突的,现在写入和治理分工:写入保吞吐,后台异步转 DV,读端只付 DV 的钱。

8. **跨引擎视图的落地很 Iceberg:能实现的实现,不能实现的明确拒绝。** Flink 无法尊重视图版本里存的默认 catalog/namespace,选择在读时拒绝而不是按错误上下文解析——**"拒绝错误"优于"错误地执行"**。

---

## 十三、三个长期判断

**判断一:开放表格式的竞争焦点已经从"格式功能"转向"治理自动化"。** V4 把表格式的结构性债清完之后,差距会拉开在"这张表自己会不会变好"——快照过期是否便宜、等值删除是否自动收敛、孤儿文件是否自动清理。1.12.0 里 expire 优化、ConvertEqualityDeletes、post-commit 维护任务集成都在这条线上。**未来一两年,湖仓选型的关键问题会从"支持什么格式"变成"维护成本多少"。**

**判断二:manifest 从 Avro 迁到 Parquet 是被低估的一步。** 它让"清单文件"这个湖仓最热的元数据路径第一次能用列存的所有优化(列裁剪、谓词下推、压缩)。短期看不出区别,但它是 content stats / 统计过滤 / 大清单规模这三件事的共同前提。** Parquet manifest 的收益会在清单文件数量随表规模线性增长的场景里逐渐显现。**

**判断三:V4 的落地节奏是开放表格式里少见的"先改 spec、再改实现、最后改默认"的教科书式迁移。** content stats 提案 → spec(#14234)→ 读路径(#18109/#18147/#18171)→ 写入与默认,每一步都保持读兼容。**在一个被生产环境重度依赖的表格式上,这种"每一步都可回退"的节奏本身就是核心竞争力**——相比之下,很多系统的格式升级要么太激进要么永远不动。

---

## 写在最后

Apache Iceberg 1.12.0 是一个很适合静下心来读的版本。它没有"性能提升 N 倍"的营销式标题,也没有新计算引擎。但如果你在过去几年里被这三件事折磨过——等值删除把读拖垮、表搬家重写清单重到想报警、压缩突然报"表损坏"而表其实没坏——这个版本把这三件事一起解决了,而且解决的方式是**改表格式的基础设施层**,不是加补丁。

823 个 PR 里真正承重的,是把 spec v4 从提案变成默认实现路径的那十几个:TrackedFile 统一文件模型、DV co-locate 到数据条目、manifest 写 Parquet、路径相对化、content stats 的完整读路径、PDWR 写入移除、ConvertEqualityDeletes 接进 post-commit。**「开放表格式」这个词里的"开放",在这个版本里第一次意味着"删除路线只有一条、清单只有一种结构、路径只有一种存法"。**

一个提醒:这个版本修的几个正确性 bug(#17764 / #17497 / #16957)都发生在"删除与数据文件的关联索引"这一层,而且都是**表看起来没坏、扫描正常、只在特定操作下才暴露**。如果你在生产里跑 merge-on-read 表,升级前值得专门检查一下压缩是否有过莫名的停滞——那可能不是你的工作负载问题。

---

## 附录:一手数据来源与复现路径

**版本元数据**

| 项目 | 值 |
|------|-----|
| 版本 | apache-iceberg-1.12.0 |
| 发布时间 | 2026-09-30T01:52:18Z |
| Release notes 长度 | 102,287 字符 / 828 行 |
| PR 总数 | 823 |
| 新贡献者 | 44 位 |

**一手来源**

- Release notes(823 条 PR 索引):`https://github.com/apache/iceberg/releases/latest`
- 相对路径提案:`https://s.apache.org/iceberg-spec-relative-path`(spec PR #15630)
- content stats 提案:`https://s.apache.org/iceberg-column-stats`
- PDWR 移除的 dev 邮件列表通告:`https://lists.apache.org/thread/3tz63wok59hhqphswovvl9z0yrh0z7pl`
- Spec 章节引用:`https://iceberg.apache.org/spec/#scan-planning`(#16957 的判据来源)

**承重级 PR 一览(本文数据点的出处)**

| PR | 标题 | 规模 |
|----|------|------|
| #14234 | Spec: Add content stats to spec | +151/-6 |
| #15634 | Core, Parquet: Allow for Writing Parquet/Avro Manifests in V4 | +812/-609 |
| #15996 | Flink: Add ConvertEqualityDeletes maintenance task | +7734/-0 |
| #16100 | Core: Add v4 TrackedFileAdapters to bridge Data/Delete Files | — |
| #16108 | Core: implement writeManifestsWith executor on SnapshotUpdate | +155/-9 |
| #16174 | Core: Add V4 location relativization utilities | +282/-2 |
| #16572 | Core: v4 table metadata location should be optional | +179/-77 |
| #16691 | Core: Skip unnecessary manifest scans during expire snapshots metadata cleanup | +7/-3 |
| #16858 | Flink: Add equality delete conversion DV resolution and writing | +839/-0 |
| #16845 | Spark: Return session catalog views | +120/-3 |
| #16957 | Core: Fail scans when position deletes/DVs don't match data file partition | +162/-3 |
| #17413 | Core: Add content stats evaluator | +1242/-559 |
| #17438 | Core: Extend V4 DeletionVector with key_metadata field | +71/-32 |
| #17451 | API, Core, Parquet: Carry avg value sizes for v4 content stats | +289/-26 |
| #17497 | Core, REST: Fix delete file references for DVs in the same Puffin file | +376/-54 |
| #17706 | Core, Data, Spark, Flink: Remove of position delete files with row data | +814/-5016 |
| #17764 | Core: Fix commit validation when a data file has multiple DVs across snapshots | +526/-31 |
| #17859 | Flink: Support reading Iceberg views in SQL | +451/-10 |
| #17864 | Core: Avoid per-row path rehashing in toPositionIndexes | +79/-2 |
| #17928 | API, Core: Expose co-located deletion vector through DataFile | +31/-2 |
| #18108 | Core: Project tracked-file partitions onto the resolved spec | +338/-65 |
| #18109 | Core: Read content stats from v4 Manifest | +1817/-774 |
| #18138 | Core: Use ManifestBitmap for manifest deletion vector in ManifestInfo | +220/-246 |
| #18147 | Core: Implement stats filtering in V4ManifestReader | +392/-55 |
| #18171 | Core: Add inheritance to V4ManifestReader | +224/-136 |

**benchmark 复现**

```bash
# 位置删除索引性能对比(#17864 的 ToPositionIndexesBenchmark)
# 维度:(numDataFiles, numDeletes=1000000),单次 op,5 次采样
./gradlew :iceberg-core:jmh -Pjmh.include=ToPositionIndexesBenchmark
```

**诚实边界(本文明确不夸大的部分)**

- #15634 的 manifest Parquet/Avro benchmark 是**全读**对比,作者明确说"写会慢一些、列投影之后读会更快",本文未引用任何未验证的列投影加速数字;
- #17413 标出 content stats 的一个真实短板:**optional struct 内 required field 不保留 null count**,导致该位置无法裁剪文件,修复需要 spec 改动;
- #18108 的分区投影 bug 修复出现在本周期但属于**已损坏行为的修复**,不是 V4 新能力;
- Kafka Connect 重试默认值为 1(保持旧行为),用户需主动 opt-in;
- Flink 视图写支持(`CREATE VIEW` / `DROP VIEW` / `ALTER VIEW AS`)在本版**仅 backport 了 RENAME**,完整写路径仍在跟进;
- PDWR 移除是**写入侧**收敛,历史 PDWR 文件仍可读,但两个维护操作会显式失败。
