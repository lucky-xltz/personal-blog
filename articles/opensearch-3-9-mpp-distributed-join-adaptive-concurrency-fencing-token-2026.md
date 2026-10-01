---
title: "OpenSearch 3.9.0 深度拆解:MPP 分布式 join、自适应并发限制、对象存储 fencing token 与虚拟线程执行器"
date: 2026-10-01
category: 技术
tags: [OpenSearch, OpenSearch 3.9.0, 搜索引擎, Lucene, Lucene 10.5, 分布式查询, MPP, MassiveParallelProcessing, 分布式join, DistributedJoin, shuffle, HashShuffle, BroadcastJoin, AnalyticsEngine, Arrow, ArrowFlight, 列式传输, 协调器, CoordinatorReduce, LateMaterialization, 并发限制, ConcurrencyLimit, Vegas, Gradient2, AIMD, 自适应限流, AdaptiveConcurrency, Netflix concurrency-limits, HTTP429, 限流, RateLimit, 背压, BackPressure, 虚拟线程, VirtualThread, JDK21, Loom, ContextPreservingExecutorService, 线程池, ThreadPool, 远程存储, RemoteStore, 存算分离, fencingtoken, FencingToken, primaryterm, 对象存储, S3, conditionalwrite, CAS, 零副本, ZeroReplica, 自动恢复, AutoRestore, NO_VALID_SHARD_COPY, 零停机部署, ZeroDowntime, drain, 滚动升级, RollingUpgrade, 拉取式摄入, PullIngestion, IngestionPayloadDecoder, Kafka, Avro, Protobuf, 插件SPI, PluginSPI, 动态映射, DynamicMapping, kNN, kNN向量, 向量检索, CVE-2026-63136, max_determinized_states, 堆耗尽, 漏洞, 安全, 快照, Snapshot, 二次扫描, 性能优化, 性能对比, 查询优化, 查询裁剪, can_match, shardpruning, FieldDomain, Elasticsearch, 兼容性, RestHighLevelClient, Jackson, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1635776062127-d379bfcba9e4?w=600&h=400&fit=crop
excerpt: "2026 年 9 月 29 日发布的 OpenSearch 3.9.0 是一个「把调度权从开发者手里拿走、交给运行时」的版本。六件事的改变方向高度一致:MPP 框架让 join 和聚合第一次真正在数据节点间 shuffle 而不是堆在协调器(PR #21844,+50311 行,join 大于 100 万行才走分布式,broadcast 上限 64MB,shuffle 前剪列把宽表流量压掉 5-25 倍);自适应并发限制模块把 Vegas/Gradient2/AIMD 三种 TCP 拥塞控制算法搬到传输层,任何 transport action 都能用集群设置动态限流,默认 monitor_only 不拒绝、enforced 模式直接 HTTP 429;对象存储 fencing token(PR #22774)让 S3 自己当见证人,零副本索引一次节点宕机就从「RED 到永远」变成自动恢复;虚拟线程执行器(PR #22485)落地但还没有任何代码在用,是给未来铺的路;零停机部署 drain/finish API(PR #21448)让被 drain 的节点既不持主分片也不收搜索流量;CVE-2026-63136 给 completion suggester 的 max_determinized_states 补上上限,混合版本集群里被打补丁的数据节点会拒绝未打补丁协调节点发来的越界值。本文按「查询执行 → 流量治理 → 存储可靠性 → 执行器演进 → 摄入与映射 → 安全边界」六条线拆完 6 大承重级革新,每项附可运行配置与生产升级建议。"
---

# OpenSearch 3.9.0 深度拆解:MPP 分布式 join、自适应并发限制、对象存储 fencing token 与虚拟线程执行器

> 2026 年 9 月 29 日，OpenSearch 3.9.0 发布。这个版本的 13 个 Features 和 30 个 Enhancements 里，有六件事的方向高度一致：**把调度决策从开发者/运维的手里拿走，交给运行时自己算**。

过去三年所有 OpenSearch 版本的叙事多少都能概括成「加个插件」「加个查询类型」。3.9.0 不是。它改的是三个核心问题的**决策主体**：

- **join 该在哪执行** —— 以前永远是「协调器攒全量、单点 reduce」，3.9.0 让运行时按行数自己选；
- **并发该开多少** —— 以前是集群里拍一个 `thread_pool.search.queue_size`，3.9.0 让 RTT 反馈自己调；
- **节点挂了谁能证明自己是主** —— 以前至少需要一个副本当见证人，3.9.0 让对象存储自己当见证人。

加上铺路用的虚拟线程执行器、把 API 边界从「尽力而为」变成显式声明的部署 drain API、以及一个堵住堆耗尽 DoS 的 CVE，凑成本文的六条线。**主线是「协调器瓶颈的终结」**，支线是「见证人的虚拟化」和「执行器的世代交替」。

---

## 一、问题的源头：协调器是搜索里唯一的「单点 reduce」

### 1.1 搜索的 fan-out/reduce 模型

搜索和聚合从设计的第一天起就是「分散扫描、集中汇总」：

```
client → coordinator → shard-1 (data node A)  ─┐
                  → shard-2 (data node B)  ─┤→ coordinator reduce → client
                  → shard-N (data node C)  ─┘
```

每个分片本地求出「我这一份的前 10 条 / 我的桶的部分计数」，发给协调器；协调器把 N 份部分结果合并成最终结果。这个模型对**单分片内可以完全并行、跨分片只需要合并少量数据**的场景是完美的。top-10 搜索就是教科书案例：每个分片最多发 10×N_shard 条 docid 回去，协调器的内存压力是常数级的。

### 1.2 这个模型在哪里碎掉

**聚合的中间态不能合并。** `SUM(amount) GROUP BY store_id`，如果一个 store 的订单被分片打散到 5 个节点（很常见，因为写入是按 `_id` 或哈希均衡的），每个节点只能给出「我这个分片上 store_X 的部分和」。想合并必须**把所有 store 的部分值都发到协调器**。

假设 1000 万种商品、1000 个分片：协调器要收 1000 万 × 3 列（key + 两个度量）的中间态。列存化之后每个 long 是 8 字节，key 用 ordinals 压完算 4-8 字节，一轮大 GROUP BY 的中间态轻易到几 GB。协调器 JVM 的 young gen 扛不住，要么 GC 停顿几百毫秒，要么直接 reduce 阶段 OOM。

**join 更惨。** 一个搜索查询里 `orders` join `customers`，传统做法是：

1. 先查一边（比如命中 5000 条 orders 的 docid）；
2. 把 5000 个 customer_id 发给所有分片做 terms lookup；
3. 收回命中结果，在协调器里做合并过滤。

这本质上是**应用层手写的两阶段 join**。它要求写查询的人知道「哪边小、先查哪边、fan-out 多大」，而这个知识在数据分布变化时就失效了。更糟的是 terms lookup 的 fan-out 是乘法级的：5000 个 id × 1000 个分片 = 500 万次分片级查询。

### 1.3 行业做过什么

**Spark / Presto / Doris 的答案都是 MPP。** 「MPP」（Massively Parallel Processing）在这里的具体含义是：**把 join 和 aggregation 的执行计划重写成一棵可以跨节点交换（shuffle / broadcast）的阶段树**，而不是「每个分片各自算 + 协调器合并」。

核心是两种数据交换算子：

| 算子 | 做法 | 什么时候用 |
|------|------|-----------|
| **Hash shuffle** | 把两份数据按 join key 的哈希**重新分发**到 N 个分区，保证同 key 的数据落在同一个 worker | 两边都大 |
| **Broadcast** | 把小的一整份**复制**到每个 worker，大的一边本地扫描 | 一边小（装得下） |

代价是阶段数变多、要走网络。所以 MPP 引擎的优化器都有一个**代价模型**来决定「这个 join 值不值得分布式化」。

**OpenSearch 之前的答案是「不做」。** 聚合走 fan-out/reduce；join 只提供应用层的 terms lookup 和 lookup runtime field。要在 OpenSearch 上跑分析负载，标准答案是「导出去，用 Spark/Flink/Doris 跑」。3.9.0 的 PR #21844（+50311 行，308 个文件）就是把这个缺了十年的空缺补上 —— **不完美，默认关**，但骨架在了。

---

## 二、核心设计：MPP 执行框架（PR #21844，analytics engine）

### 2.1 整体结构

3.9.0 的 MPP 框架跑在 analytics engine（PPL / SQL 语义层）里，不影响 `_search` REST 路径。整体执行计划从「协调器单点 reduce」变成多阶段：

```
SHARD_FRAGMENT (各数据节点本地扫描+过滤+部分投影)
      ↓ Arrow IPC
COORDINATOR_REDUCE (协调器合并分片级结果)     ← 传统模式止步于此
      ↓
LATE_MATERIALIZATION (sort/head 之后的延迟取字段)
      ↓
[shuffle / broadcast 交换算子]                 ← 3.9.0 新增
      ↓
FINAL (最终 gather)
```

**关键设计决策：这套机制不取代已有的 fan-out/reduce。** 它在**外面包了一层决策**：

| 设置 | 作用 | 默认值 |
|------|------|--------|
| `analytics.mpp.enabled` | 总开关 + 熔断开关（出事可一键关） | `false` |
| `analytics.mpp.distribute.min_rows` | 行数地板 —— join/agg 的**较大子树扫描**小于这个数就留在协调器 | `1000000` |
| `analytics.mpp.shuffle.aggregate.enabled` | 分布式聚合子开关（关掉不影响分布式 join） | `true` |

**`min_rows = 1000000` 是这个框架最值得说的一行配置。** 它承认了一个事实：MPP 的固定开销（阶段初始化、shuffle 网络往返、序列化）在**小查询上比协调器 reduce 还贵**。一百万行是作者拍的一个「过了这条线，shuffle 的并行收益才开始压过开销」的经验阈值。

这跟 Spark SQL 的 `spark.sql.autoBroadcastJoinThreshold`（默认 10MB）是同一种思路，只不过 Spark 阈的是字节数，OpenSearch 阈的是行数。**两者的决策都必须由运行时做**：开发者写 `SELECT ... JOIN` 的时候不可能知道右表今天是 50 万行还是 5000 万行。

### 2.2 两种交换算子与代价模型

```
analytics.mpp.broadcast.max_bytes     64mb   broadcast 上限，超了降级成 hash shuffle
analytics.mpp.broadcast.probe_estimate -1    代价估算用的 probe 节点数，-1 = 规划时的数据节点数
analytics.mpp.shuffle.partitions       -1    hash shuffle 分区数，-1 = probe 侧数据节点数
```

**broadcast 的降级路径是这个框架能落地的关键。** 一个 join 如果小边超过 64MB，优化器**不会失败**，而是把它重新规划（或回退）成 hash shuffle。这保证了同一个查询在数据量变化时行为是连续的，不会出现「昨天能跑今天报错」。

`shuffle.partitions = -1`（等于数据节点数）也是个有意思的选择。Spark 的默认 `spark.sql.shuffle.partitions = 200` 是**固定的**（因为不知道集群多大），这在 3 节点和 100 节点上是同一个数，导致小集群上每个分区太小、大集群上每个分区太挤。OpenSearch 直接取数据节点数，**分区数随集群伸缩**，代价是查询并发度被节点数绑死。

### 2.3 shuffle 的内存与落盘

```
analytics.mpp.shuffle.node_budget_percent   80    每 node 的 on-heap shuffle 预算，占 -Xmx 的百分比，0 = 不设上限
analytics.mpp.shuffle.spill.enabled         false 中间结果落盘而不是 fail fast
analytics.mpp.shuffle.spill.directory       ""    spill 根目录（每查询一个子目录），空 = <path.data>/shuffle_spill
analytics.mpp.shuffle.spill.max_bytes       50gb  每 node 的落盘上限
analytics.coordinator.buffer_limit          0     FINAL gather 的每查询协调器分配上限，0 = 共享协调器分配器
```

**`spill.enabled = false` 是一个深思熟虑的默认值。** 传统 MPP 引擎（Spark / Presto）默认开启落盘，因为它们的假设是「查询跑几分钟，OOM 的代价远大于写盘」。OpenSearch 的搜索集群假设是「查询 50-300ms 就该回来」，一次磁盘 spill 的延迟（几十 ms）就足以让 P99 变得无法接受。**所以默认策略是「宁可在内存里 fail fast，也不要静默地把查询变慢十倍」**，要跑分析负载的人自己开 spill。

这个取舍在 `node_budget_percent = 80` 上也看得出来 —— shuffle 默认可以吃掉堆的 80%。这是一个「我知道这很激进，但熔断开关（`analytics.mpp.enabled=false`）给你留着」的姿态。

### 2.4 shuffle 负载优化：剪列与压缩

```
analytics.mpp.shuffle.prune_columns   true   shuffle 前丢掉没有任何算子引用的列
analytics.mpp.shuffle.compress        false  压缩 shuffle IPC chunk（标准 Arrow IPC 压缩）
analytics.mpp.compression.codec       zstd   压缩编码（zstd / lz4）
analytics.mpp.compression.zstd.level  1      zstd 级别（对齐 Spark shuffle 默认），范围 1-22
```

**`prune_columns = true` 默认开启，是这套框架里最便宜也最值钱的一个优化。** 宽表场景（事实表 40-80 列是常态）的 join 只需要 join key 加下游真正引用的列。PR body 里给的量级是 **5-25×** 的 shuffle 流量削减。

原理很直白：join `orders`（60 列）on `customer_id` 只取 `amount`，shuffle 的就是 `customer_id` + `amount` 两列，不是 60 列。列式存储下这是「免费」的优化 —— 每列在 Arrow 里是独立的 buffer，丢掉一列就是少一次内存拷贝。

`zstd.level = 1` 而不是默认的 3，是对「shuffle 是 CPU 敏感路径」的妥协。zstd level 1 到 3 的压缩率差异（通常 5-10%）远不如它省下的 CPU 对并发的影响。

### 2.5 可靠性

```
analytics.mpp.shuffle.recv_timeout   60s   每分区接收超时，卡住的 shuffle producer 的最后兜底
```

一个 shuffle 生产者卡住时，消费者不会无限等。60 秒之后查询失败，而不是占着资源挂在那里。**这个超时存在本身就说明作者把这套东西当作生产特性在考虑**，不是实验玩具。

### 2.6 基准与诚实边界

PR 附了 TPC-H SF=1 和 SF=10 的三路 join 基准。**注意一个重要的诚实边界：MPP 的默认是关闭的（`analytics.mpp.enabled=false`）。** 这意味着所有基准都是「开了 MPP 才有的数」，不是开箱即用的提升。3.9.0 交付的是**框架和开关**，不是默认行为。

**我的判断**：这个姿态是对的。一个 +50311 行、跨 308 个文件的新执行框架，先以 opt-in 形式让有真实分析负载的用户试出问题，比直接默认开启让所有人当小白鼠强。**「默认关 + 有熔断开关 + 有行数地板 + 有落盘选项」这四件套，是基础设施新特性从实验到默认的教科书路径。**

---

## 三、自适应并发限制：把 TCP 拥塞控制搬到传输层（PR #22312）

### 3.1 问题的本质：固定队列大小的三个失效模式

OpenSearch（和 Elasticsearch）的线程池模型一直有一个隐含假设：**运维能拍出一个正确的队列大小**。`thread_pool.search.queue_size: 1000`，然后祈祷。

这个假设有三种碎法：

**失效一：硬件代际差。** 同一个 `queue_size`，在 2023 年的 32 vCPU 机器和 2026 年的 192 vCPU 机器上是完全不同的语义。升级硬件等于隐式改了限流。

**失效二：负载异质。** 一个集群里同时跑仪表盘查询（50ms）和报表查询（40s）。固定队列大小对两者一视同仁 —— 40s 的查询占着位置，50ms 的查询在后面排队到超时。**你想要的是「按延迟反馈调」，不是「按位置调」**。

**失效三：雪崩。** 队列满了就返回 429，这没问题。但 429 的时机是「队列已经满了」，而不是「系统开始劣化」。等队列满的时候，GC 停顿已经开始了，缓存已经失效了，整个系统在悬崖边上。

### 3.2 三种算法：从 TCP 借来的教科书

3.9.0 的并发限制模块直接用了 Netflix 的 [concurrency-limits](https://github.com/Netflix/concurrency-limits) 库，提供三种算法：

| 算法 | 核心机制 | 特点 |
|------|---------|------|
| **Vegas**（默认） | 基于基线 RTT 与实时 RTT 的**差值**判断拥塞（不看丢包） | 在真正拥塞前就开始退避；对噪声敏感 |
| **Gradient2** | 用 RTT 梯度（变化率）而非绝对差值 | 对基线漂移更稳健 |
| **AIMD** | 经典 Additive Increase / Multiplicative Decrease | 最简单最稳健，收敛慢 |

**为什么这三种是「教科书」的？** 它们就是 TCP 拥塞控制的三个世代。Vegas 是 1995 年的（基于延迟），AIMD 是 1988 年 Jacobson 的（基于丢包），Gradient2 是 Netflix 对 Vegas 的工业改良。**把网络层三十年的反馈控制经验搬到应用层，是因为问题结构完全一样**：一个共享资源（网络 / 线程池），N 个竞争者（连接 / 请求），一个可观测的劣化信号（RTT 上升 / 延迟上升），目标是在不崩溃的前提下压到最大吞吐。

**Vegas 的直觉**（这是理解整套东西的关键）：

```
基线 RTT（无负载）= R_base  （由启动期探测得到）
实时 RTT          = R_now
队列中的请求数     ≈ (R_now - R_base) / R_base × in_flight
```

如果 `R_now > R_base`，说明请求在**某个队列里**等着。差值越大，排的队越长。Vegas 在排队变长**之前**就开始降并发，所以比等丢包的 AIMD 更平滑。

### 3.3 三种运行模式：默认是「只看不动」

```
concurrency_limit.action.search.mode = disabled | monitor_only | enforced
```

| 模式 | 行为 | 用途 |
|------|------|------|
| `disabled`（默认） | 完全不介入 | 3.9.0 的默认姿态：不改变任何行为 |
| `monitor_only` | 记录指标但不拒绝请求 | 先观测，确认算法对你的负载收敛 |
| `enforced` | 超限直接 HTTP 429 | 生产限流 |

**`monitor_only` 是这个功能最好的设计。** 一个自适应限流器，在你验证过它的收敛行为之前就打开拒绝开关，是在拿生产流量赌博。先观测（当前 limit、in-flight、拒绝数、RTT 全部进 `_nodes/stats`），看图表确认「它推高/回退的时机跟你人工判断的一致」，再切 `enforced`。

### 3.4 完整配置示例

```json
PUT /_cluster/settings
{
  "persistent": {
    "concurrency_limit.action.search.action_name": "indices:data/read/search",
    "concurrency_limit.action.search.mode": "enforced",
    "concurrency_limit.action.search.algorithm": "vegas",
    "concurrency_limit.action.search.limit.initial": 20,
    "concurrency_limit.action.search.limit.max": 200,
    "concurrency_limit.action.search.vegas.baseline_reset_load_threshold": 0.5,
    "concurrency_limit.action.search.burst.capacity": 10,
    "concurrency_limit.action.search.burst.close_after": 5,
    "concurrency_limit.action.search.burst.open_after": 5
  }
}
```

逐项解读：

- **`action_name`** —— 限流可以挂在**任何 transport action** 上（search、bulk、自定义插件的 action）。这是「不写代码就能保护新 action」的关键。
- **`limit.initial: 20` / `limit.max: 200`** —— 算法在这个区间内自适应。下限保证不过度保守，上限防止算法在某些病态条件下把自己推到无限大。
- **`baseline_reset_load_threshold: 0.5`** —— **这是 Vegas 最容易踩的坑，也是这个 PR 里最有技术含量的一行配置。**

### 3.5 Vegas 基线投毒：一个真实的反馈循环陷阱

Vegas 的 `R_base` 是在**无负载**时探测得到的。问题是：**什么时候重新探测基线？**

朴素实现是「周期性地用最新最小 RTT 重置基线」。这在高负载下是灾难：

```
负载 70%  → RTT 上升到 200ms → 重置基线为 200ms
          → 现在 R_now == R_base，Vegas 认为「没有排队」
          → 继续加并发 → RTT 300ms → 重置基线为 300ms
          → 永远觉得没问题，一路推到 OOM
```

这就是**基线投毒（baseline poisoning）**：算法自己把劣化的状态当成新的正常状态，反馈循环完全失效。

3.9.0 的解法是**门控基线重置**：只有当 in-flight 低于 `baseline_reset_load_threshold`（默认 0.5，即当前并发低于最大值的一半）时，才允许重置基线。**只有在系统真的闲下来的时候，才允许它重新定义「什么是闲」。**

**这个陷阱不是理论上的。** Netflix 的 concurrency-limits 文档专门讲过它。任何在生产跑过自适应限流的人都知道，大部分翻车不是算法选错，而是基线被毒掉。

### 3.6 突发容量与迟滞

```
burst.capacity: 10       在自适应基础限之上的额外余量
burst.close_after: 5     连续 5 个样本低于阈值后关闭突发模式
burst.open_after: 5      连续 5 个样本高于阈值后打开突发模式
```

突发容量解决的是**瞬时尖峰**（比如整点所有仪表盘同时刷新）。算法的稳态限制是保守的（为了保护 P99），但真实的负载有合法的尖峰。突发余量允许短时超限，用一个**有状态的开关**（连续 N 个样本才切换）避免在边界上来回抖动。

`increase_barrier` / `decrease_barrier` 是同一个思路在算法层面上的应用：**升降并发都需要连续 N 个样本一致，用迟滞（hysteresis）抑制振荡**。

### 3.7 请求分区：把一个全局限制拆成多个子池

```
premium 子池 / standard 子池，resolver 可插拔（byHeader / fixed / bySearchType）
```

一个全局并发限制解决不了**租户隔离**。1000 个并发里，一个写错查询的大租户可以把其他所有租户的查询挤到超时。分区功能把总限制按名字拆成子池，resolver 决定请求进哪个池子：

- **`byHeader`** —— 按 HTTP header（比如 `X-Tenant-ID`）路由；
- **`bySearchType`** —— 按查询类型路由（比如 `async_search` 走一个池，普通 search 走另一个）；
- **`fixed`** —— 固定分配（典型用法：留 20% 给内部运维查询）。

**这是把「限流」从「保护节点」升级成「保护租户」**，是多租户搜索平台的刚需。

### 3.8 可观测性：决策过程必须可见

```
GET /_nodes/stats?metric=concurrency_limiter
```

返回每个 limiter 的当前 limit、in-flight、累计拒绝数、RTT。**一个自适应限流器如果不暴露自己的状态，跟一个随机拒绝器没有区别** —— 出了问题你根本不知道是「算法在正确地拒绝」还是「算法疯了」。

两个通道都给了：`_nodes/stats` 的 pull 路径（版本门控到 `V_3_8_0`），以及通过 `MetricsRegistry` 注册的 push 路径（给 Prometheus 这类系统用）。还有 `ConcurrencyLimiterStatsPlugin` SPI，让第三方监控插件可以解耦地采集。

---

## 四、对象存储 fencing token：让 S3 自己当见证人（PR #22774）

### 4.1 主分片选举为什么需要见证人

这是整套设计里最精妙的一块。先说问题。

OpenSearch 的 primary term 是一个**单调递增的代**，每次主分片切换就 +1。写入的合法性检查是：「我的 term 是不是当前最新的？」这依赖一个共识：**集群得有一个机制判断「谁是合法的主」**。

远程存储（remote store）+ 段复制（segment replication）的 failover 路径是：**副本当见证人来验证主分片的 term** —— 副本们投票确认「我们认为 term 应该是 t+1」。这个机制需要一个**至少一个副本**在场。

### 4.2 零副本索引的死局

**零副本索引（zero-replica index）在这个机制下是死局。** 节点挂了，没有任何副本当见证人，分片进入 `NO_VALID_SHARD_COPY` 状态，**永久 RED**，即使远端对象存储里有一份完整副本。

唯一的出路是手动跑 `_remotestore/_restore`。在一个 200 节点的集群里，每天有节点抖动是常态；一个零副本索引遇到抖动就是一次人工介入。

### 4.3 fencing token：把见证人从内存搬到对象存储

PR #22774 的核心思路：**让对象存储自己当见证人。**

协议（原文记号 `inv(t)` = `invertLong(t)`）：

1. **每个 primary term 一个对象**：`fence__inv(term)`。前缀列表（prefix listing）按命名排序，**最高 term 排在最前面** —— 这个命名顺序就是对象存储对「集群管理器授权」的排序，**完全不需要集群管理器参与 I/O**。

2. **条件写（conditional write）**：只有 CAS（compare-and-swap）成功的副本才能更新 fence。竞争失败的副本被 **fenced**，永远无法确认写入。

3. **这给了零副本索引一个多写安全（multi-writer safety）属性** —— 这是 PR #22904（自动恢复）需要的前提。

**精妙之处在于「用对象存储的语义而不是额外服务」。** 不需要引入 Raft / Paxos，不需要一个新的共识服务，不需要任何额外的有状态组件。S3 的条件写（conditional put，`If-None-Match` 语义）就是唯一的仲裁者。

**为什么对象名是 `invertLong(term)` 而不是 `term` 本身？** 对象存储的列表接口按**字典序**返回。`term` 递增时字典序也对（单调和字典序一致），但 inverted long 保证数值大的 term 在字典序里**排前面**。这样一次 prefix listing 的第一个结果就是最新 term —— **把「找最大值」从「列出全部取 max」变成「取第一个」**，I/O 从 O(terms) 降到 O(1)。这是一个极其克制的、把对象存储 API 语义用到极致的设计。

### 4.4 自动恢复：从「RED 到永远」到自愈（PR #22904）

RFC #22768 的 Phase 1。触发条件**与副本数无关**：

| 配置 | 节点全挂时的行为 |
|------|-----------------|
| 零副本索引 | 一个节点挂了就触发 |
| 多副本索引 | 所有持有副本的节点都挂了才触发；只要有一个 in-sync 副本存活，走正常的 failover 提升，触发器不介入 |

转换过程：集群管理器把丢失的主分片重新指向 `RemoteStoreRecoverySource`，分配到一个存活节点。**分片从 `NO_VALID_SHARD_COPY` 变成分配中。**

**注意分工的诚实边界**：PR #22774 只做 fencing token（多写安全），**分配触发器不在那个 PR 里**，在 #22904。这种拆分本身是好实践 —— 先把正确性的地基铺好，再叠加自动化。

### 4.5 一个必须说清的取舍

PR body 明确说：对使用 `request` 级别持久化的复制索引，这是一个 **trade**（见证人从「副本」变成「对象存储」，即 `NO_REPLICATION` 路径）；对零副本索引是**纯赚**。

**不要把这条理解成「零副本索引现在安全了所以可以随便用」。** fencing token 保证的是**多写安全**（不会有两个 primary 同时写同一个对象路径），它不提供**可用性**：恢复过程还是要从远端把整个分片拉回来，这期间的读仍然不可得。**它把「数据损坏」降级成「暂时不可用」**，这已经是从 P0 到 P1 的巨大进步，但不是银弹。

---

## 五、虚拟线程执行器：世代交替的地基（PR #22485）

### 5.1 虚拟线程解决了什么

JDK 21 GA 的虚拟线程（Project Loom）解决的是**线程数与并发数的耦合**。平台线程（platform thread）是 1:1 映射到 OS 线程的，每个 ~1-2MB 栈；虚拟线程是 N:1 映射到载体线程（carrier thread）的，栈在堆上按需分配。

对一个搜索节点来说，这意味着「每个搜索请求一个线程」不再是一个奢侈的模型。今天 OpenSearch 的线程池是**有限工作集 + 队列 + 拒绝**的模型，核心原因就是平台线程贵。虚拟线程下，「每请求一线程」的阻塞 I/O 模型重新变得可行。

### 5.2 这个 PR 实际做了什么

四个东西：

1. **`ContextPreservingExecutorService`** —— 一个 `ExecutorService` 包装器，在所有任务提交路径上**保留 ThreadContext**。这是把虚拟线程引入 OpenSearch 的**最大技术障碍**：OpenSearch 的安全、追踪、关联 ID 全部依赖 ThreadLocal 风格的 ThreadContext。虚拟线程在 yield 时会切换载体线程，ThreadLocal 语义必须显式传播。

2. **`OpenSearchExecutors.newVirtualThreadPerTaskExecutor`** —— 创建保留上下文的、带命名线程的 virtual-thread-per-task 执行器。

3. **`VIRTUAL` 线程池类型** —— 加进 `ThreadPool`。**序列化成 `SCALING`** 跟 3.8.0 之前的节点通信 —— 那些节点不认识 `virtual` 类型。这是一个教科书级的**滚动升级兼容性处理**。

4. **泛化 `ThreadPool` 的关闭逻辑**，覆盖 direct executor 之外的所有执行器类型。

### 5.3 诚实边界：这是地基，不是楼

PR body 明确写着：**「Nothing in this code base uses virtual threads yet; this is groundwork for future efforts to build on VTs.」**

3.9.0 里**没有任何代码实际使用虚拟线程**。这是一个纯基础设施 PR。**但我认为它是这个版本里长期价值最高的一项**，理由有三：

1. **ThreadContext 传播是最难的工程问题**，先解决它，后面所有「把某个线程池换成虚拟线程」的 PR 都能直接复用。
2. **滚动升级的序列化兼容**（序列化成 `SCALING`）说明作者在考虑**生产落地路径**，不是做个 demo。
3. **同版本里 PR #22743 修了一个虚拟线程调度器死锁**（见 §8.2）—— 说明虚拟线程已经有人在真实路径上跑了，这个地基是被需要的。

**预判**：3.10/3.11 会看到第一个真正使用 `VIRTUAL` 类型的线程池（最可能是 search 之外的 I/O 密集路径，比如 snapshot 恢复或远程存储上传）。这是一条值得持续盯的线。

---

## 六、零停机部署 API：从「尽力而为」到显式状态机（PR #21448）

### 6.1 滚动升级的经典痛点

标准做法是「排空节点 → 升级 → 重启 → 等恢复 → 放流量」。排空靠的是分片重分配（allocation filtering）+ 等待集群健康。这个流程有三个黑洞：

1. **排空的「完成」没有定义。** 你 `PUT _cluster/settings` 排空了一个节点，然后轮询 `_cluster/health`。健康变绿了，但你不知道是「真的排空完了」还是「集群觉得现在还行」。
2. **搜索流量不等你。** 分片重分配完成不代表客户端不再往这个节点发搜索请求（连接池还持有连接）。
3. **节点回来之后没有「预热」。** 分片恢复了，缓存是冷的，一放流量就是一波慢查询。

### 6.2 两个 API：drain 和 finish

```
# 排空（基于节点属性）
POST /_deployment/{node_attribute}/{value}/_drain

# 完成部署（恢复流量接收）
POST /_deployment/{node_attribute}/{value}/_finish
```

**drain 之后节点进入一个显式状态**：

| 属性 | drain 后 |
|------|---------|
| 持有主分片 | ❌ 不再合格 |
| 接收搜索流量 | ❌ 不再接收 |

**关键设计：`finish` 之前，回来的节点仍然不收搜索流量**，即使恢复已经完成。这给了运维一个显式的「检查点」：恢复完了、缓存预热了、你确认了，才放流量。

### 6.3 为什么是基于节点属性

部署通常不是「升级节点 A」，而是「升级所有带 `role: warm` 的节点」或者「上线一个新版本池子」。基于属性（`{node_attribute}/{value}`）的 API 天然支持这种**批量、声明式**的部署语义。

### 6.4 诚实边界：这是 partial implementation

PR 明确说是 issue #21180 的**部分实现**，未来还要加：

- **node dial-up 状态** —— 渐进地放搜索流量（而不是一刀切）；
- **shadow 状态** —— 把搜索流量**并行**发到新节点，用于预热和验证。

**「shadow 状态」是这个 API 真正的大招。** 它让「上线新版本」从「先排空再放流量」变成「新旧并行跑、验证完再切」—— 这是**没有停机窗口**的部署。等它落地，OpenSearch 的滚动升级会变成一个完全连续的操作。

**有趣的花絮**：PR 的 Co-Author 里写着 `Claude Opus 4.6`，作者还把生成代码用的 TASK.md 挂了出来（一个 gist）。**这是「AI 写的基础设施代码进了主干」的一个公开样本**，而且代码质量足够过 review —— 恰好呼应今天早间日报里 AI 写代码的各种讨论。

---

## 七、摄入与映射：两条被低估的支线

### 7.1 拉取式摄入的 payload decoder 框架（PR #22364）

OpenSearch 的 pull-based ingestion（从 Kafka 之类的话题拉数据）有一个性能浪费：**消息到字段映射必须走 JSON 序列化/反序列化往返**。Kafka 里的 Avro 或 Protobuf 消息，先解成 JSON 字符串，再解析成字段 Map —— 两次序列化。

3.9.0 加了一个可扩展的解码层：

```
IngestionPayloadDecoder        每 shard 一个，decode(BytesReference) -> Map<String,Object>，Closeable
IngestionPayloadDecoderFactory  节点级，validate(Settings) + create(IndexMetadata, shardId, Settings)
IngestionPayloadDecoderRegistry 启动期构建的命名注册表，重名 fail fast
```

插件现在可以注册自定义的 wire-format decoder，**把原始消息字节直接解成字段 Map**，跳过 JSON 往返。

**为什么说它被低估**：表面上这只是省了一次序列化，但它改变了「OpenSearch 摄入」的扩展模型。以前要支持新格式你得改 mapper；现在它是一个**插件 SPI**。这跟 Flink 的 `DeserializationSchema`、Kafka Connect 的 `Converter` 是同一层抽象 —— **把「解码」从核心引擎里解耦出来**。

**诚实边界**：3.9.0 只内置了 `XContentIngestionPayloadDecoder`（保留现有 JSON/XContent 行为）。Avro / Protobuf decoder 要等插件生态跟进。

### 7.2 动态映射的插件 SPI（PR #22607）

以前动态映射（dynamic mapping）的「这个 JSON 值属于什么类型」判断**写死在核心**。一个 mapper 插件想让自己的字段类型参与动态映射，得绕很大弯。

3.9.0 抽出三个核心接口：

```
DynamicFieldTypeInferencer      推断「这个 JSON 值是什么类型」
DynamicTemplateTypeHandler      处理 dynamic template 的类型映射
FieldValueParserSupplier        提供字段值解析器
```

核心只负责**检测 JSON 值**，然后把「这是不是我的、什么类型」的决策**委托给注册过的插件**。**核心里不放任何插件特定的类型知识。**

**第一个消费者是 k-NN 插件**（自动映射向量字段 + `match_mapping_type: "knn_vector"` 动态模板，在 companion PR 里）。但接口是刻意通用化的 —— PR body 举了个例子：一个地理插件可以用**完全相同的 SPI** 把 `{"lat": .., "lon": ..}` 对象认成 `geo_point`，**核心零改动**。

**这条线的长期价值**：向量检索（k-NN）已经从「搜索的附加功能」变成「搜索的核心负载」。让 k-NN 字段能跟普通字段一样自动映射，是降低 RAG 应用接入成本的实质一步。

---

## 八、修掉的真实生产 bug 与安全边界

### 8.1 PPL 晚物化的固定 5 秒延迟（PR #22609）

**症状**：任何 plan 里带晚物化 fetch 阶段的 PPL 查询（所有 `... | sort <col> | head K | fields <非排序键列>` 形态），都要付一个**固定的 ~5 秒**，且**与行数、列数、扫描字节数完全无关**，每查询一条 WARN 日志：

```
[reduce-sink] timed out waiting for reduce teardown: taskId=...
```

**受影响查询的 profile（749M 文档里取 50 行，扫描本身 60-90ms）**：

| Stage | Type | Elapsed |
|-------|------|---------|
| 0 | SHARD_FRAGMENT | 78 ms |
| 1 | COORDINATOR_REDUCE | 79 ms |
| 2 | **LATE_MATERIALIZATION** | **5037 ms** |
| 3 | COORDINATOR_REDUCE | 5038 ms |

**80 毫秒的查询付 5 秒。** 这是「一个常量把一个快查询变成慢查询」的典型 —— 比 OOM 更隐蔽，因为它不报错，只是慢。

**根因**是一个只有超时能打破的 teardown 循环：`DatafusionReduceSink.closeImpl`（REDUCING 分支）先发 `cancel_query`，然后 `reduceDone.await(5, SECONDS)`。这个等待本身在一个循环里，而 cancel 的传播路径要等这个循环退出才能推进 —— **死锁，只有 5 秒超时能解**。

**为什么值得单独说**：这是一个**只在「快查询」上才暴露的 bug**。扫描 30 秒的查询根本看不见这 5 秒；只有扫描几十毫秒的交互式查询才会被它放大几十倍。**监控里它长得很像「网络抖动」**，因为延迟是固定常量、没有错误、跟负载无关。

### 8.2 虚拟线程调度器死锁（PR #22743）

**症状**：Flight client 的大规模流失败可以**死锁虚拟线程调度器**，把节点**无限期卡住**，而节点**还在报告自己健康**。

**根因链条极其精密**：

1. `FlightTransportResponse#openAndPrefetchAsync` 让每个流的 open/prefetch 跑在自己的虚拟线程上；
2. 失败路径把 throwable 交给 `logger.error`/`warn`；
3. OpenSearch 的 `OpenSearchJsonLayout` **总是**追加 `%exceptionAsJson`，所以每次都走到 log4j 的**扩展**堆栈渲染器；
4. 那个渲染器要解析每个栈帧的声明类来标注源 JAR —— 用 `Class.forName`（native frame）和另一种加载路径；
5. **类加载在虚拟线程上阻塞时，会钉住（pin）载体线程**；
6. 载体线程被钉住 → 调度器没有可用载体 → 所有其他虚拟线程饿死 → 节点卡死但健康检查照过。

**修复**：失败路径不再把 throwable 记进日志。

**这个 bug 的价值在于它是一个「新技术栈的全新失败模式」**：一个**日志库的堆栈渲染**能搞死一个**调度器**。在平台线程世界里，类加载阻塞只会阻塞那一个线程；在虚拟线程世界里，它能钉住载体线程、饿死整个节点。**§5 的虚拟线程地基不是白铺的 —— 它已经在真实路径上咬人了。**

### 8.3 CVE-2026-63136：completion suggester 的堆耗尽（PR #22924）

**漏洞**：completion suggester 的 regex 和 fuzzy 选项接受**无上限**的 `max_determinized_states`。一个任意大的值（比如 `Integer.MAX_VALUE`）会禁用 Lucene 的 determinize 安全护栏，让一个精心构造的模式在 Lucene 抛出自己的复杂度异常**之前**耗尽堆。

**为什么它跟之前的修复不是同一个**：PR #22557 给 `regexp` / `query_string` 查询补过同一个上限，但**从没覆盖 completion 路径** —— `CompletionSuggestionContext` 把这些值直接喂给 `regexpQuery(...)` / `FuzzyCompletionQuery`。

**修复的两个细节值得学**：

1. **复用已有常量** `RegexpQueryBuilder.MAX_DETERMINIZE_WORK_LIMIT`，不引入新的 magic value；
2. **传输层反序列化也过同一个校验** —— 这保证**混合版本集群里，一个已打补丁的数据节点会拒绝未打补丁的协调节点发来的越界值**。

**第二点是关键。** 搜索集群的滚动升级窗口里，新老版本会共存。如果只在 REST 层校验，一个未升级的协调节点会把越界值广播给数据节点 —— 攻击面在升级完成之前是开着的。**「每一跳都校验」是修复这类漏洞的正确姿势。**

### 8.4 快照删除的二次扫描（PR #22968）

**症状**：在有大量快照和索引的仓库上，删快照的 CPU 占用**以分钟计**，而且串行化阻塞其他仓库操作（快照终结在仓库 generation 上排队）。

**根因**代码就一行，但它是 O(n²)：

```java
updatedIndexMetaIdentifiers.keySet()
    .removeIf(k -> updatedIndexMetaLookup.values().stream()
        .noneMatch(identifiers -> identifiers.containsValue(k)));
```

对**每个**标识符，扫一遍**所有剩余快照**的查找表。代价是 O(标识符 × 总跟踪条目)。**这是在生产集群上观察到的**：作者在选出的 cluster-manager 上抓了线程转储，看到快照删除线程在 `Collection.removeIf` → `stream().noneMatch` 里 on-CPU。

**这类 bug 是「慢得让人误以为卡死了」的典型**：不报错、不 OOM、就是慢，慢到快照删除背压了整个仓库的 generation。

### 8.5 Arrow 原生内存池的两道护栏（PR #22697 + #22762）

**问题一（#22762）**：`ArrowBasePlugin.derivePoolMaxDefault` 按 `node.native_memory.limit` 的百分比给每个原生池（flight/ingest/query）定 max。当这个 limit 解析成 `0b` 时 —— **这在受限容器里是默认情况**（物理内存探测返回 0，`OsProbe.getTotalPhysicalMemorySize() == 0`）—— 它返回 `Long.MAX_VALUE`，**池子完全无界**。

无界池的唯一天花板是 JVM 级的 `MaxDirectMemorySize`，**被节点上所有 direct memory 用户共享**。一次并发分配风暴会让池子耗尽共享预算，抛出 `OutOfDirectMemoryError` —— **全局耗尽，会打击任何 direct 分配，而且它是 `Error`，会破坏节点稳定性**。

**修复**：池子有界时，同样的压力表现为**每个池子内部受控的** OOM —— 爆炸半径被限制在单个池。

**问题二（#22697）**：每流出站缓冲水位默认 64MB（最小 1MB）**远大于需要**。水位约束的是**流水线深度**，不是单个批次 —— gRPC 会完整接受一次超水位的写入，所以一个比它大的批次照样通过，生产者只是之后 park。更小的水位保持每流出站内存低，让**更多流可以并发共享 Flight 分配器池**。

默认 64MB → **512KB**，最小 1MB → 256KB。**这是一个「默认值错配导致并发能力被人为压低」的典型**：参数看起来是在保护内存，实际上是在限制并发。

### 8.6 其他值得记的改动

| 改动 | 说明 |
|------|------|
| **PR #22935 / #22865 / #22991** | 远程存储 flush 三连：未提交段的集群级 flush 设置、恢复基于大小的周期 flush、`index.periodic_flush_interval` 变更动态应用到运行中的分片 |
| **PR #22783** | 文档复制 failover 时提升**最低版本**的副本，防止滚动升级期间副本卡住 |
| **PR #22533→#21033** | 多 term 聚合的桶 key 用 ordinals 而非 byte 值 |
| **PR #22450** | `LongKeyedBucketOrds` 的桶计数 O(1) 查找 |
| **PR #22510** | wildcard 字段类型下 `wildcardQuery`/`regexpQuery` 在没有 TermQuery 时改走 `prefixQuery` 加速 |
| **PR #22776** | filtered alias 保留 `constant_score`，保住 Lucene 的 no-scoring 快速路径 |
| **PR #22856** | posting enum 的 `advance()` 不再做取消检查，降 CPU |
| **PR #22531** | histogram / auto_date_histogram / range 聚合的段内搜索（intra-segment search） |
| **PR #22483** | `FieldDomain` metadata producer API，增强 `can_match` 分片裁剪 |
| **PR #23032** | tiered cache 默认分区数改 16（高核实例命中率更好） |
| **PR #23008** | `RestHighLevelClient` 正式 deprecate，让位给 `opensearch-java` 客户端 |
| **PR #22704** | 核心移除 Jackson 2.x 依赖（3.6 已全面迁 3.x，兼容线终于切断） |
| **PR #22898** | Lucene 升级到 10.5.1；**PR #22808** JDK 升 25.0.4.1+1 |

---

## 九、5 套搜索/分析引擎 17 维度对比

| 维度 | OpenSearch 3.9.0 | Elasticsearch 9.5.x | Quickwit 0.10 | Vespa 8.x | Doris 3.0 |
|------|------------------|---------------------|---------------|-----------|-----------|
| **join 模型** | MPP 多阶段（shuffle/broadcast，opt-in） | 应用层 lookup + ES|QL join（有限） | 不支持 join | 广播/分层 join（原生分布式） | MPP（Broadcast/Shuffle/Colocate） |
| **join 决策主体** | 运行时（`min_rows=1M` + `broadcast.max=64mb`） | 无自动代价模型 | N/A | 运行时 | 运行时 + Colocate hint |
| **分布式聚合** | opt-in，`shuffle.aggregate.enabled` | 协调器 reduce | 段级合并 + 协调器 | 分层部分聚合 | 原生 MPP 两阶段 |
| **协调器瓶颈缓解** | shuffle 让 join/agg 下沉到数据节点 | 仍为单点 | 仍为单点 | 原生无此问题（设计即分布式） | 原生无此问题 |
| **列式传输格式** | Arrow IPC（shuffle） | 内部二进制 | 原生列存 | Tensor + Tensor Map | 内部 |
| **自适应并发** | Vegas/Gradient2/AIMD，3 模式，per-action 动态 | 固定队列 + 自适应调度（不同机制） | 无 | 无（自带容量调度） | 无（Workload Group 硬限） |
| **限流状态可见** | `_nodes/stats?metric=concurrency_limiter` + push metrics | `_nodes/stats` 线程池队列 | 无 | 无 | Workload Group metrics |
| **远程存储集成** | 原生（fencing token + 自动恢复） | 原生（Snapshots + searchable snapshots） | 原生（存算分离，S3 一等公民） | 原生 | 原生（存算分离 3.0 GA） |
| **零副本可用性** | fencing token 自动恢复（3.9.0） | 不支持（需副本） | 天然（存储即来源） | 需副本 | 需副本 |
| **滚动升级体验** | drain/finish 显式状态机（partial，dial-up/shadow 待定） | 节点排空 + 健康检查 | 无状态查询节点，天然滚动 | 无状态容器节点 | 无状态 BE/CN |
| **拉取摄入** | Kafka 拉取 + 可插拔 payload decoder | Logstash / ES|QL kafka connector | Kafka/.native | kafka-importer | Routine Load / DataX |
| **向量检索** | k-NN 插件（SPI 化动态映射） | 原生 dense_vector + kNN | 原生 | 原生 tensor | 原生 |
| **虚拟线程** | `VIRTUAL` 线程池类型（地基已铺，尚无使用者） | 部分 | 无（Rust，无 JVM） | 无 | 无 |
| **分析查询语言** | PPL / SQL（analytics engine） | ES|QL（全新的流水线语言） | 不支持 SQL | YQL / 搜索 + 排序 | 完整 SQL + 物化视图 |
| **混合负载隔离** | WLM + 并发限制分区 | WLM | 天然（只有搜索） | 资源组 | Workload Group |
| **安全边界** | CVE-2026-63136 补齐 determinize 上限 + 每跳校验 | 类似 CVE 历史 | 基础 | 成熟 | 基础 |
| **默认姿态** | 保守（MPP/并发限制都默认关，monitor_only） | 激进（ES|QL 默认可用） | 保守 | 激进 | 中等 |

**读这张表的三个要点**：

1. **OpenSearch 在「把分布式执行做对」这条线上，这次追上了第一梯队**，但姿态是**保守的**（opt-in、默认关、有熔断）—— 这对一个有大量生产部署的项目是正确的。
2. **自适应并发限制是这五个里最独特的**：把 TCP 拥塞控制算法搬到搜索传输层，其他引擎都是「固定队列 / 硬限制」思路。
3. **Vespa 和 Doris 在分布式执行上是「生来如此」的**（Vespa 的分层架构、Doris 的 MPP），OpenSearch 是在**既有 fan-out/reduce 架构上长出来的**，这个包袱决定了它必须 opt-in。

---

## 十、5 段可运行代码

### 10.1 MPP 框架：开启并验证分布式 join

```bash
# 1. 开启 MPP（先在测试集群验证，默认是关的）
PUT /_cluster/settings
{
  "persistent": {
    "analytics.mpp.enabled": true,
    "analytics.mpp.distribute.min_rows": 1000000,
    "analytics.mpp.shuffle.aggregate.enabled": true,
    "analytics.mpp.broadcast.max_bytes": "64mb",
    "analytics.mpp.shuffle.prune_columns": true,
    "analytics.mpp.shuffle.spill.enabled": false,
    "analytics.mpp.shuffle.node_budget_percent": 80
  }
}

# 2. 跑一个会触发分布式 join 的 PPL 查询
#    （字段替换成你自己的；orders 明显大于 100 万行才会走 MPP）
POST /_plugins/_ppl
{
  "query": "source=orders | join ON orders.customer_id = customers.customer_id | stats sum(orders.amount) as total by customers.region | sort -total | head 20"
}

# 3. 检查 shuffle 是否真的发生了（看 LATE_MATERIALIZATION / shuffle 阶段）
GET /_plugins/_ppl/_explain
{
  "query": "source=orders | join ON orders.customer_id = customers.customer_id | stats sum(orders.amount) by customers.region"
}

# 4. 出事时的一键熔断（不需要重启）
PUT /_cluster/settings
{ "persistent": { "analytics.mpp.enabled": false } }
```

**调试技巧**：如果 join 没走分布式，先怀疑行数地板。`_explain` 的输出里看较大子树的估算行数是不是小于 `min_rows`。宽表记得确认 `prune_columns` 生效（看 shuffle 阶段的列数，不是源表的列数）。

### 10.2 自适应并发限制：从观测到执行的三步

```bash
# 第 1 步：monitor_only 模式观测（不拒绝任何请求）
PUT /_cluster/settings
{
  "persistent": {
    "concurrency_limit.action.search.action_name": "indices:data/read/search",
    "concurrency_limit.action.search.mode": "monitor_only",
    "concurrency_limit.action.search.algorithm": "vegas",
    "concurrency_limit.action.search.limit.initial": 20,
    "concurrency_limit.action.search.limit.max": 200,
    "concurrency_limit.action.search.vegas.baseline_reset_load_threshold": 0.5
  }
}

# 第 2 步：观察算法收敛（连续看 1-2 个高峰周期）
GET /_nodes/stats?metric=concurrency_limiter
# 重点关注：current limit 是否随负载上升/下降，rejected 是否在期望的时机出现
# 如果 current limit 一直顶在 limit.max 不动 → 怀疑基线被毒，调低 baseline_reset_load_threshold
# 如果 limit 在剧烈振荡 → 调大 increase_barrier / decrease_barrier

# 第 3 步：确认收敛行为后再切 enforced
PUT /_cluster/settings
{
  "persistent": {
    "concurrency_limit.action.search.mode": "enforced",
    "concurrency_limit.action.search.burst.capacity": 10,
    "concurrency_limit.action.search.burst.close_after": 5,
    "concurrency_limit.action.search.burst.open_after": 5
  }
}
# 此时超限的搜索会收到 HTTP 429
```

**关键检查点**：`monitor_only` 阶段**至少跑一个完整的负载周期**（早高峰 + 午低谷 + 晚高峰）。Vegas 的基线是在低负载期建立的，没经历过低谷就切 enforced，等于用一个可能被毒掉的基线做拒绝决策。

### 10.3 租户分区：一个全局限制不够用的时候

```json
PUT /_cluster/settings
{
  "persistent": {
    "concurrency_limit.action.search.action_name": "indices:data/read/search",
    "concurrency_limit.action.search.mode": "enforced",
    "concurrency_limit.action.search.algorithm": "vegas",
    "concurrency_limit.action.search.limit.initial": 10,
    "concurrency_limit.action.search.limit.max": 100,

    "//": "把总限制拆成子池：byHeader 按 X-Tenant-ID 路由",
    "concurrency_limit.action.search.partition.resolver": "byHeader",
    "concurrency_limit.action.search.partition.header": "X-Tenant-ID",
    "concurrency_limit.action.search.partition.names": "premium,standard,internal",
    "concurrency_limit.action.search.partition.premium.share": 50,
    "concurrency_limit.action.search.partition.standard.share": 30,
    "concurrency_limit.action.search.partition.internal.share": 20
  }
}
```

**验证分区生效**：带不同 header 打查询，观察 `_nodes/stats` 里每个子池的 in-flight 是独立计数的。一个大租户把 standard 池打满，premium 池的查询不应该被影响。

### 10.4 零副本索引的 fencing token 与自动恢复

```bash
# 1. 创建一个零副本 + 远程存储的索引（**仅适用于 fencing token 保护下的场景**）
PUT /zero-replica-logs
{
  "settings": {
    "index.number_of_replicas": 0,
    "index.remote_store.enabled": true,
    "index.remote_store.translog.metadata_path": "org-opensearch-translog",
    "index.remote_store.segment.metadata_path": "org-opensearch-segments"
  }
}

# 2. 写入一些数据然后验证
POST /zero-replica-logs/_doc?refresh=true
{ "@timestamp": "2026-10-01T18:00:00Z", "level": "WARN", "msg": "fencing token test" }

GET /zero-replica-logs/_count

# 3. 模拟节点丢失（在测试集群上）
#    关掉持有该分片主副本的节点

# 4. 3.9.0 之前：分片会停在 NO_VALID_SHARD_COPY，永久 RED
#    3.9.0 之后（fencing token + auto-restore）：
#      集群管理器自动把主分片指向 RemoteStoreRecoverySource
#      分配到存活节点 → 从远端拉回完整副本 → 恢复 GREEN
GET /_cluster/health/zero-replica-logs
GET /_cat/shards/zero-replica-logs?v

# 5. 确认 fence 对象存在于远程仓库（前缀列表，最高 term 在最前）
#    AWS CLI 示例（bucket/prefix 换成你的）：
#    aws s3api list-objects-v2 --bucket my-bucket --prefix "org-opensearch/fence__" \
#        --query 'Contents[].Key' --output text
```

**验证要点**：fence 对象名是 `fence__inv(<term>)`，`inv` 是 `invertLong`。列表输出的**第一个**就是最高 term（这就是 §4.3 里 O(1) 取最新 term 的 trick）。如果看到两个不同 term 的 fence 对象，说明发生过竞争，CAS 输掉的那一方被 fenced。

### 10.5 零停机部署：drain → 升级 → finish

```bash
# 场景：升级所有角色为 warm 的节点

# 1. 排空（被 drain 的节点不再持有主分片、不再收搜索流量）
POST /_deployment/node_attr/warm/_drain

# 2. 确认排空完成（等分片重分配 + 节点状态）
GET /_cat/nodes?v&h=name,node.role,segments.count
GET /_cluster/health?wait_for_status=yellow&timeout=120s

# 3. 此时被 drain 的节点上没有主分片，可以安全停机升级
#    for node in warm-nodes; do ssh $node 'systemctl stop opensearch'; ... ; done

# 4. 节点升级后回来
#    **注意：即使恢复完成，它们仍然不收搜索流量，直到你 _finish**

# 5. （未来版本）在 finish 之前可以做缓存预热
#    POST /_deployment/node_attr/warm/_prewarm?indices=<hot-indices>

# 6. 显式完成部署，恢复搜索流量
POST /_deployment/node_attr/warm/_finish

# 7. 验证流量回来了（对比各节点的 search_total 应该恢复）
GET /_nodes/stats/indices/search?human
```

**回滚姿势**：`_drain` 是可逆的 —— 如果升级过程中发现问题，跑 `_finish` 会把节点重新放回服务（分片重分配会自己处理）。**整个部署过程中搜索流量始终有地方可去**，这是它比「排空 + 等健康」优越的核心。

---

## 十一、性能数据汇总

| 场景 | 改动 | 数量级 | 来源 |
|------|------|--------|------|
| 宽表 shuffle 流量 | `prune_columns`（默认开） | **5-25×** 削减 | PR #21844 body |
| PPL 晚物化固定延迟 | teardown 循环修复 | **5037ms → ~80ms**（78ms 扫描） | PR #22609 profile |
| 快照删除（大仓库） | 二次扫描改线性 | CPU **分钟级 → 亚秒**（O(ids×entries) → O(ids)） | PR #22968 |
| Flight 每流出站缓冲 | 64MB → 512KB | 更多流并发共享分配器池 | PR #22697 |
| Tiered cache 分区 | nextPow2(cores×1.5) → 16 | 高核实例命中率提升 | PR #23032 |
| 规则/查询 dispatch | if-else 链 → enum switch | O(1) 分发 | PR #22568 |

**关于 MPP 的基准**：PR 附了 TPC-H SF=1 / SF=10 的三路 join 基准（图片形式）。**我不会转述图上的数字** —— 我无法从 release notes 独立验证它们，而且它们是在 `analytics.mpp.enabled=true`（非默认）下的测量。**「5-25× shuffle 削减」是 PR 作者在 body 里的文字陈述，可信度高于截图数字，但也请按你自己的负载复测。**

---

## 十二、6 条 6-12 个月可验证硬指标

1. **MPP 默认仍然关闭** —— 3.9.0 发布时 `analytics.mpp.enabled` 是 `false`。**6-12 个月内观察它何时变成默认 `true`**，或者 OpenSearch 是否选择永远保持 opt-in（像 Elasticsearch 对 ES|QL 的某些特性的态度）。这是判断「这个框架是否真的成熟」的单一最强信号。
2. **`min_rows = 1000000` 的阈值会不会被调** —— 这是作者拍的经验值。观察后续版本是否有基于真实部署反馈的调整（上调说明固定开销比预想的大，下调说明阈值太保守）。
3. **虚拟线程的第一个真实使用者** —— 3.9.0 铺了 `VIRTUAL` 线程池类型但无人使用。**盯 3.10 / 3.11 的 release notes，看哪个线程池第一个换成虚拟线程**（我赌 snapshot 恢复或远程存储上传这类 I/O 密集路径）。
4. **`_deployment` API 的 dial-up / shadow 状态落地** —— PR 明确说是 partial implementation。shadow 状态（新旧节点并行跑流量预热）落地的那一天，OpenSearch 才有真正的零停机升级。
5. **`monitor_only` 模式在生产集群的收敛报告** —— 这是这个版本最容易产出可验证数据的地方：开 `monitor_only`，把 `_nodes/stats?metric=concurrency_limiter` 的 limit 曲线跟你的 QPS / P99 曲线叠在一起看。**如果 limit 的升降跟 P99 的升降在时间上对齐，说明算法在正确地跟踪你的负载。**
6. **fencing token 在真实 S3 上的延迟** —— 协议依赖对象存储的条件写。**测一下你的 S3 后端的 conditional put 延迟**（尤其如果用非 AWS 的 S3 兼容存储），这决定了 failover 的额外耗时。PR #23041 刚把默认 SSE 类型 revert 回 `bucket_default` 来修 S3 兼容存储的上传问题 —— **说明非 AWS 后端的兼容性是 3.9.0 的一个活跃痛点。**

---

## 十三、6 条 6-12 个月可观察未来信号

1. **k-NN 插件用上动态映射 SPI** —— PR #22607 的 companion PR 是 k-NN 的第一个消费者。观察 RAG 场景下「向量字段自动映射」是否成为默认体验，以及地理插件是否跟上（这是 SPI 通用性的检验）。
2. **Avro / Protobuf payload decoder 出现** —— 框架已铺好（`IngestionPayloadDecoder` SPI），但内置只有 XContent。第三方插件什么时候出现，决定这条线的实际价值。
3. **自适应限流算法从 search 扩散到 bulk** —— `action_name` 是可配置的，但 3.9.0 的测试聚焦 search。bulk 路径的 RTT 分布完全不同（有 refresh 的抖动），看算法在写入路径上是否收敛。
4. **Lucene 10.5.1 的后续反应** —— 每次 Lucene 大版本升级都会带出一波回归（这次 OpenSearch 跟得很快）。观察 3.9.x 的 patch 发布频率。
5. **`RestHighLevelClient` 的移除时间表** —— 3.9.0 只是 deprecate。观察哪个版本真正移除，那是 OpenSearch 2.x 时代客户端的最后退场。
6. **PR #21448 的 AI 协作模式会不会成为常态** —— 这个 PR 公开标注了 Claude Opus 4.6 作为 Co-Author。如果基础设施项目开始常规性地公开 AI 贡献，这对软件工程实践的影响比这个 API 本身大得多。

---

## 十四、总结与最佳实践

### ✅ 该用

1. **有真实分析负载（PPL/SQL）、join 或大 GROUP BY 卡在协调器** → 开 MPP，但**先在测试集群**，先确认 `min_rows` 地板和 `broadcast.max_bytes` 上限对你的数据量合理，开 `prune_columns`。
2. **集群有异质负载（快查询 + 慢报表混跑）、固定队列大小调不好** → 自适应并发限制，**务必先 `monitor_only` 跑一个完整负载周期**，看懂 limit 曲线再切 `enforced`。
3. **零副本远程存储索引** → 3.9.0 升级，fencing token + 自动恢复是**纯赚**（多副本索引是 trade，要评估）。
4. **有节点属性的批量滚动升级** → `_deployment` drain/finish，特别是升级窗口紧的场景。
5. **Kafka 摄入走 JSON 往返是瓶颈** → 关注 payload decoder 插件生态，内部格式（Avro/Protobuf）值得自己写一个 decoder。

### ❌ 千万别用

1. **不要在生产上直接开 `analytics.mpp.enabled=true` 不做验证**。+50311 行的新框架，`shuffle.node_budget_percent=80` 默认可以吃 80% 的堆，`spill.enabled=false` 意味着超了就 fail fast。**先跑 SF=1 的基准，再上生产**。
2. **不要跳过 `monitor_only` 直接切 `enforced`**。自适应限流器的拒绝决策依赖基线，基线需要低负载期建立。直接开 = 拿生产流量赌算法收敛。
3. **不要把 fencing token 理解成「零副本索引现在 100% 安全」**。它保证的是**多写安全**（不损坏），不是**可用性**（恢复期间仍不可读）。零副本仍然是零副本。
4. **不要在慢查询路径上对 PPL 的 5 秒延迟视而不见**。如果你用 PPL 且有 `sort | head | fields` 形态，**3.9.0 之前你的每个交互式查询都可能白付 5 秒**。升级后对 profile 的 `LATE_MATERIALIZATION` 阶段。
5. **不要把 `concurrency_limit.action.search.limit.max` 设得过高**。自适应算法的收敛需要时间，上限过高时它可以把自己推到 OOM 才开始退。

### 5 步生产升级 checklist

1. **快照备份** —— 升级前对全部索引做一次完整快照。3.9.0 改了快照删除的元数据路径（PR #22968），虽然修的是性能，元数据变更永远值得一次干净备份。
2. **先升级数据节点，最后升级协调节点** —— CVE-2026-63136 的修复在**传输层反序列化也做了校验**，所以已打补丁的数据节点会拒绝未打补丁协调节点的越界值。**这个顺序保证保护在升级窗口里就是生效的。**
3. **混合版本期间不要建新索引** —— `VIRTUAL` 线程池类型序列化成 `SCALING` 给老节点，这是兼容性设计，但混合版本期间新建索引的 setting 传播仍有风险。
4. **升级后立即验证并发限制器的状态** —— `GET /_nodes/stats?metric=concurrency_limiter` 应该返回空或全 `disabled`（因为默认是关的）。**如果非空且你没配过，说明有别的插件在用这个 SPI，先搞清楚是谁。**
5. **观察快照删除和 Flight 流的回归** —— 这两个是 3.9.0 改动最深的路径（二次扫描修复 + 缓冲水位从 64MB 降到 512KB）。升级后跑一次真实的快照删除（大仓库）和一次 Arrow Flight 查询负载。

### 5 条最佳实践

1. **新执行框架的采用节奏 = 「默认关 + 有熔断 + 有地板 + 有落盘」** —— 这是 MPP 框架给基础设施新特性的模板。任何改变查询执行路径的特性，都应该先以 opt-in 形式让真实用户试出问题。**「默认关」不是不自信，是对生产部署的尊重。**
2. **自适应限流的基线必须在低负载期建立** —— Vegas 的 `R_base` 是无负载探测值。`baseline_reset_load_threshold=0.5` 的门控机制是这套算法能用住的核心，**任何自己实现自适应限流的人都要处理基线投毒**。
3. **正确性问题的解法是「让无状态的东西当见证人」** —— fencing token 用对象存储的条件写替代了「至少一个副本」。**这个思路可以推广**：任何需要共识但不想引入新共识服务的地方，问自己「能不能用现有存储的 CAS 语义」。
4. **修复安全漏洞要在每一跳校验** —— CVE-2026-63136 不只在 REST 层校验，还在传输层反序列化校验，保证混合版本集群的升级窗口里保护是生效的。**只在一层校验 = 升级期间保护是开着的。**
5. **虚拟线程不是免费的** —— PR #22743 的调度器死锁说明：类加载阻塞在虚拟线程上会钉住载体线程、饿死整个节点。**「把线程池换成虚拟线程」之前，先把 ThreadContext 传播和类加载热路径理清楚**（这正是 PR #22485 在铺的地基）。

---

## 写在最后

OpenSearch 3.9.0 的六件事可以被一句话串起来：**这个版本把三类「需要人来做」的决策交给了运行时** —— join 的执行位置（MPP 代价模型）、并发的上限（Vegas 反馈控制）、主分片的合法性（对象存储 CAS）。

这个趋势本身比任何单个特性都重要。搜索引擎过去十年的核心张力是「它是一个搜索引擎，但用户越来越拿它当分析库使」。之前的解法是「导出去，用别的引擎跑」—— 这在数据量小的时候可以，在实时性要求高的时候就是断裂的。**3.9.0 的 MPP 框架把这个断裂接上了一部分**，代价是复杂度（多阶段执行、shuffle 内存预算、落盘策略）。

**三个长期判断**：

1. **协调器单点 reduce 会逐渐被淘汰** —— 不是因为协调器不够快，而是因为集群规模和数据量让「所有中间态汇聚到一个节点」在数学上就不成立。MPP opt-in 只是第一步，**6-12 个月内会有第二个引擎特性建立在 shuffle 之上**（最可能是分布式窗口函数或两阶段 GROUP BY 的自动切换）。
2. **自适应并发限制会成为搜索平台的标配** —— Netflix concurrency-limits 的思路在微服务层已经普及，搜索引擎是最后一批还在用「固定队列大小」的基础设施。**「按 RTT 反馈调并发」会像「按 CPU 用率扩容」一样变成默认直觉**，而 `monitor_only` 模式是这个过渡期的正确姿势。
3. **「让无状态存储当见证人」会成为存算分离的通用模式** —— fencing token 用对象存储的条件写替代了副本见证。**在一切都在走向存算分离的背景下，「正确性不再依赖内存中的副本数」是一个必然方向**。零副本从「配置错误」变成「受支持的部署形态」，这个变化的影响会比 3.9.0 本身更远。

**最后一句**：这个版本最让我尊敬的地方不是 +50311 行的 MPP 框架，而是它**把每个新特性都给了明确的「默认关 / monitor_only / opt-in」姿态和熔断开关**。在一个有大量生产部署的系统上，**「敢默认关」比「敢默认开」需要更大的工程自信**。
