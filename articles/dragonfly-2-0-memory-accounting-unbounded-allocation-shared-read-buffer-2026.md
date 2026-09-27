---
title: "Dragonfly v2.0.0 深度拆解：内存记账精度的八年抗战、无界分配的五个攻击面与共享读缓冲的架构豪赌"
date: 2026-09-27
category: 技术
tags: [Dragonfly, DragonflyDB, Redis, Valkey, 内存数据库, 内存记账, used_memory, MallocUsed, QList, quicklist, ZSTD, LZF, 压缩, 内存碎片, defrag, DashTable, segment, 无界分配, OOM, DoS, RESTORE, RESP, RESP3, Memcached, 共享读缓冲, ProactorReadBuffer, 复制积压缓冲, backlog, JWT, ACL, GEOSEARCHSTORE, Valkey 9 RDB, tiered storage, 分层存储, cluster migration, 流, stream, XREADGROUP, mimalloc, helio, 事件循环, fiber, 性能, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
excerpt: "2026 年 9 月 16 日，Dragonfly 发布 v2.0.0——三年来第一次动主版本号。官方在发布说明里写得很克制：「这个版本本身不新增重大功能，它标志的是成熟度、性能和生产就绪的里程碑」。但把 31KB 的 changelog 和 89 个 PR 的源码对上之后，真正落地的是一条贯穿整个版本的主线：**把「内存记账」从「大概对」做成「精确且 O(1)」**。八个直接改写 used_memory / RSS / 峰值指标含义的修复，五个把「声明长度即分配」变成「先验证再分配」的无界分配攻击面关闭，一个把每连接 32KB 私有读缓冲换成每 proactor 一个共享缓冲的架构豪赌（25K 连接 32 核从约 800MB 降到 1MB 以下），加上 Valkey 9 RDB 互操作、GEOSEARCHSTORE、JWT 认证、复制积压缓冲从固定长度改成时间+字节双预算、以及一堆把「分布式系统正确性」当承重结构的修复（跨 shard 释放、XREADGROUP 唤醒、tiered 序列化类型保留）。本文拆开这条主线：为什么 quicklist 压缩会让记账漂移 13 倍、为什么 unsigned 计数器能凭空变出 TB 级的 stream、为什么 12KB 的 CRC-valid RESTORE 负载能打死一台内存数据库、以及 5 段可直接运行的复现与调优代码。"
---

# Dragonfly v2.0.0：内存记账精度的八年抗战

2026 年 9 月 16 日，Dragonfly v2.0.0 发布。

发布说明的开头一句值得原样引用：「我们等了三年才动主版本号。这个版本本身不新增重大功能，它标志的是成熟度、性能和生产就绪上的一个重要里程碑。」

在内存数据库的世界里，这句话翻译过来是：**这一版改的不是功能表，是「指标可不可信」这件事本身。**

一个做缓存或数据层的工程师，对 Dragonfly 的认知多半停在「那个多线程的、兼容 Redis 协议的、跑在 shared-nothing 架构上的替代品」。它 2022 年开源，核心卖点是用 DashTable（一个基于论文 [Dash: Scalable Hashing on Persistent Memory](https://www.usenix.org/conference/fast20/presentation/xiang) 的并发哈希表）加 actor/fiber 模型的多线程事件循环，把单线程 Redis 的吞吐天花板抬上去。兼容性是它的生命线：客户端用 redis-cli、go-redis、Jedis、ioredis 直连，协议是 RESP，命令集对齐 Redis（以及 2024 年 fork 出来的 Valkey）。

但「兼容」这件事的真正深度，不在「你支持了多少条命令」，而在**「你的 used_memory 跟客户端的 MEMORY USAGE 对不对得上，你的 OOM 决策跟你报给监控的数字是不是一个东西，你那句 RESTORE 在一个恶意包面前会不会把整个进程打死」**。v2.0.0 改的就是这一层。

本文按五条线拆：① 记账精度（漂移 13 倍、TB 级虚假读数、O(n) 记账）;② 无界分配的五个攻击面;③ 共享读缓冲的架构豪赌;④ 把分布式正确性当承重结构的那些修复;⑤ 兼容性边界的推进（Valkey 9 RDB / GEOSEARCHSTORE / JWT）。最后是性能数据、可复现的调优代码、6 条 6-12 月硬指标和升级 checklist。

---

## 一、问题的源头：内存数据库的「记账」为什么难

### 1.1 一个缓存运营商的日常

假设你管着一个 32GB 的 Dragonfly 集群，跑着一个 Python Celery 任务队列。某天 Prometheus 告警：`dragonfly_used_memory` 2.1TB。

你的第一反应是「监控坏了」。第二反应是去容器里敲 `INFO memory`，发现 `used_memory` 确实写着 2.1TB，而 RSS 只有 12GB，机器总共 32GB。你开始怀疑 Dragonfly 算错了。

在 v2.0.0 之前，这个怀疑**是对的**，而且根因你猜不到：Celery 用 Redis 协议存任务，列表（LIST）对象是 Dragonfly 的 QList（quicklist 的等价物）。QList 有个压缩功能——把列表的内部节点用 LZF 或 ZSTD 字典压缩，省内存。压缩之后，**记账没更新**。然后某次 `LTRIM` 把几个压缩节点整段删掉，记账减掉的是**未压缩的长度**，而这几千个节点当初记进账的是**压缩后的长度**。减得比加的多，`uint64` 计数器在某个深夜滚过 0，变成 1.8×10¹⁹，在指标里显示成「EB」或者经过某种换算变成「TB」。

这不是监控坏了。这是**内存数据库最经典的一类静默故障：记账与实存分离**。它不崩溃、不报错、不进错误日志，它只是让所有依赖这个数字的东西一起错——OOM 淘汰策略、容量规划、`MEMORY USAGE` 的客户端 SDK 判断、autoscaler 的扩缩容决策。

### 1.2 记账的三个层次

在一个现代内存数据库里，「这个对象占多少内存」这个问题有三个不同答案，它们各有各的用途，也各有各的坑：

| 层次 | Dragonfly 内部等价物 | 用途 | 典型陷阱 |
|---|---|---|---|
| **malloc 视角** | `MallocUsed(true)` = 递归遍历容器算真实占用 | `MEMORY USAGE <key>` | 慢，大对象 O(n) |
| **记账视角** | `MallocUsed(false)` = 增量维护的缓存值 | `used_memory`、淘汰、OOM 拒绝 | 会漂移、会绕回 |
| **RSS 视角** | 进程驻留集 | 运维监控、OOM Killer | 分配器缓存与碎片放大 |

设计上，「记账视角」必须无限逼近「malloc 视角」，否则淘汰和 OOM 决策就是在一个错的世界上做的。而 RSS 与前两者的差，就是分配器（Dragonfly 用 mimalloc，每个 shard 一个独立 heap）和碎片。

**v2.0.0 的主线，就是把「记账视角」的可信度从「大概对」提升到「有回归测试保证的对」，并且把它从 O(n) 降成 O(1)。**

### 1.3 为什么过去做不到精确

增量记账的难点不在「加」，在**「什么时候减、减多少」**。一个对象在生命周期里会被多种途径修改：压缩、解压、重建、节点删除、部分裁剪、序列化、迁移到别的 shard。每一种途径都必须对称地更新记账。

以 QList 为例，v2.0.0 之前的代码里，更新 `malloc_size_`（记账用的那个字段）的逻辑散落在至少四个函数里：`CoolOff()`（稳态压缩分支）、`CompressByDepth()`、`BackfillCompressWithZstdDict()`、`RecompressNode()`。每个函数各自更新，靠的是**约定**而不是**结构**。于是：

- `CoolOff()` 的稳态分支压缩了内部节点，却把 tracked size 永远留在**未压缩的值**上。PR #8014 的实测：500 元素的 Celery-like 列表，记账 290418 字节，实际分配 21968 字节，**13 倍高报**。
- `DelNode()` 删除一个压缩节点时，减去的是 `node->sz`——**未压缩长度**——而这个节点当初记进账的只是它的压缩 payload 长度。`LTRIM`/`LREM` 一旦跨越压缩节点删除，就会**过度扣减**，把 unsigned 计数器推成负数（绕回成 ~1.8×10¹⁹）。

这两个 bug 互相掩盖：稳态压缩**高报**，跨节点删除**低报**，两者在某些负载下恰好抵消，让 `DCHECK_GE(obj_memory_usage, MallocUsed())` 这个断言一直没被触发。**这是最恶劣的一类 bug——它的错误是自洽的，断言保护不了它，只有把它拆开、修掉一个、另一个才暴露。**

**关键洞察 1：增量记账的正确性不能靠「每个函数都记得更新」来保证，必须让更新发生在唯一的地方。** PR #8014 的修法是把 `malloc_size_` 的更新收敛进 `CompressNodeWithDict()` 一个函数，「让所有调用点都不可能忘记」。同时 `Backfill` 从 `zmalloc_usable_size()` 约定切换到**压缩 payload 长度**约定，这个约定的目的是让「压缩 delta」和「解压 delta」对称——一次 read/recompress 循环之后，记账不再漂移。

---

## 二、八大记账修复：从「大概对」到「有测试保证」

v2.0.0 的 changelog 里，直接改写 `used_memory` / RSS / 峰值指标含义的修复有八个。它们不是散落的 bug fix，而是同一条主线在八个不同对象上的落地。

### 2.1 QList 压缩记账：13 倍高报与 unsigned 绕回

PR #8014 是这一线的核心。两个 bug，两个修法，外加三个回归测试（作者明确写「每个测试在没有对应修复时都会失败」）：

| 测试 | 修复前 | 修复后 | 实际值 |
|---|---:|---:|---:|
| `MallocUsedTracksSteadyStateCompression` | 290418 | 19719 | 21968 |
| `EraseWholeCompressedNodesKeepsMallocSize`（ZSTD 路径） | −91688 | 14259 | 14259 |
| `EraseWholeLzfNodesKeepsMallocSize`（LZF 路径） | −63155 | 31771 | 35000 |

注意 `Erase(100, 200)` 的那组对照表。修复前 LZF 路径记账是 **−63155**——一个负的字节数。ZSTD 路径是 +179011（实际 15624，仍在高报）。修完之后两个路径都回到实际值附近，且**稳定地略低于** `MallocUsed(true)`。

作者在 PR 里特别说明了这个「略低」是**有意的**：tracked size 保守地低于实存，意味着淘汰决策会**更早**触发、OOM 拒绝会**更保守**。在一个内存数据库里，「记账偏低」是安全方向，「记账偏高」会让你以为还有内存可用，然后在一次大对象写入时被 RSS OOM Killer 教做人。

### 2.2 Stream size：从「几 GiB 显示成 TB」到 56 位边界检查

PR #8066 处理的是 1.1 里那个 2.1TB 的场景。根因是一段极其经典的 C++ 代码：

```cpp
// 修复前（简化）
SetSize(Size() + size);   // 先求和，再截断进 56 位字段
```

问题在于当 `size` 是负值且其绝对值大于 `Size()` 时，求和结果在 `int64_t` 里就已经是负的；随后被 C++ 隐式转成 `uint64_t`，再被存进一个 **56 位**的字段。负数 + 隐式无符号转换 + 位域截断 = 一个几 GiB 的流在指标里显示成 TB。

修复的三层：

1. **删掉无效检查**：原来的 `if (size >= delta && delta < 0)` 判断恒为真（因为 delta 是负的，size 非负），从来没用。
2. **先比较再存储**：把「请求的变动量」与「当前 size + 56 位上限」比较，放不下就走慢路径。
3. **慢路径重算**：放不下的时候不是 clamp 到 0，而是**重新计算真实 size**。

**关键洞察 2：这类「负数 + 无符号转换 + 位域截断」的 bug 有一个共同指纹——它只在「跨越边界」时出现。** 一个跑了三年的流，某天被 `XTRIM` 裁到边界以下，指标瞬间爆炸。它不会在测试里出现，因为测试数据不会刚好卡在边界上。修法不是「小心类型转换」（这是一句废话），而是**让「存不下了」成为一个被显式处理的分支**。

### 2.3 连接内存记账：从 O(n) 到 O(1)

PR #8245 是 v2.0.0 里 diff 最大的一个：**+3358 −106**，横跨 16 个文件。它解决一个性能问题：`MEMORY STATS` / 连接内存遥测需要知道每个连接订阅了多少 Pub/Sub channel、WATCH 了多少 key、ACL 凭据占多少。原来的实现每次查询都要**递归遍历**这些容器。

修法是把「遍历算」换成「变更时记账」：

- 订阅 / WATCH 的字符串总量在**变更时**更新到缓存
- ACL 凭据安装、脚本 ACL 快照构造时同步更新
- 复用已有的 MULTI 字节计数器
- 递归容器遍历被**显式命名**为 `SlowHeapSize`，并且**在文档里声明它必须留在指标记账链路之外**

这条声明是整个 PR 里最值得注意的一行。作者没有把 `SlowHeapSize` 当成一个通用工具，而是给它贴了警示标签：这是慢路径，任何把它接到 hot path 上的后续 PR 都在制造回归。**这是把「知识」固化进代码结构而非靠人记忆的范例。**

### 2.4 序列化缓冲的 512MiB 陷阱

PR #8140 短小但数字惊人：一个 stream 512MiB 经过序列化器之后，序列化器会**终身持有 512MiB 的缓冲容量**。因为原来的代码在 flush 之后只清内容不清容量，而 slot migration / RESTORE 的代码路径**没有分块**——一个大对象整体过序列化器。

修复是加一个阈值（默认 4MiB），flush 之后如果容量超阈就缩。小容量预留不动，只有异常大对象会被回收。

**关键洞察 3：「泄漏」在内存数据库里不总是 bug，有时候是「为峰值容量预留」的设计。** 修这种东西的难点在于判断「哪些预留是合理的、哪些是病态的」。这里的判据很清晰：**正常工作负载下的典型容量（几 MiB）保留，异常单点大对象（512MiB）回收**。

### 2.5 其余四个

- **`used_memory_peak_rss`**（PR #8143）：原来报的不是 RSS 峰值，修成报真正的驻留内存峰值。这个指标直接决定运维的容量规划曲线。
- **过期键扫描的物理桶配额**（PR #8129 + #8077）：`Traverse()` 是**无界**的，在近乎空的表上会一直走直到找到一个 placed value。修复换成 `TraverseBySegmentOrder` 的有界遍历，并加了**物理桶、时间、条数三重配额**。同时把 tiering 的 small-bin defrag 也换成同样的有界遍历——**同一个病，两处病灶，一个修法**。
- **compressed-list 无符号下溢**（见 2.1，与 #8014 同源）。
- **`expired_keys_total` / `evicted_keys_total` 恒导出**（PR #8052）：包括零值。一个监控指标的沉默是最可怕的——告警规则 `rate(expired_keys_total[5m]) == 0` 在指标缺失时会求值成空，告警就不响。**让指标恒存在，是可观测性的基础设施级修复。**

---

## 三、无界分配的五个攻击面：从 12KB 打死一台内存数据库说起

v2.0.0 关闭了五个「声明长度即分配」的漏洞。它们合起来构成一个攻击模型：**在一个内存数据库里，攻击者不需要拿到数据，只需要让你的进程 abort。**

### 3.1 RESTORE：12KB 的 CRC-valid 负载打挂服务器

PR #8222 的描述本身就是一个完整的漏洞报告：

> 一个构造的 `RESTORE` 负载可以让 loader 在任何边界检查之前，先按攻击者声明的长度分配缓冲区，因此一个 **约 12KB 或更小的 CRC-valid 负载**就能让服务器 abort（`mimalloc: out of memory in 'new'` → SIGABRT，或 SIGSEGV）。攻击者的全部成本是算一个 CRC64 footer。

攻击面共四处：顶层字符串、元素字符串、LZF 压缩长度、集合成员计数。`RESTORE` 从来没有限制过 loader 的**输入源剩余字节数**，所以 `FetchBuf` 里那个已有的越界检查**从来没被触发过**——它检查的是「读出去了」，但分配在检查之前就发生了。

修法是把「先分配后验证」整体翻转成**「先验证再分配」**，每个预分配在 `resize()` / `ReserveString()` 之前都要对着 `RemainingBytes()` 校验：

```text
RESTORE 负载（约 12KB，CRC 合法）
  └─ 声明一个 SET 有 2,000,000,000 个成员
       └─ 旧：reserve(2e9 * sizeof(entry)) → std::bad_alloc → abort
       └─ 新：2e9 * sizeof(entry) > 剩余 11.9KB → 立刻拒绝
```

值得注意的是这个漏洞的**发现方式**：Valkey 的 `integration/corrupt-dump` fuzz 测试。**跨项目的模糊测试资产在反哺另一个实现**——Dragonfly 加载 Valkey 的损坏快照测试集，找到了自己 loader 里的分配病。

### 3.2 内联请求与 bulk 长度：18 字节换 1GB

PR #8215 的复现成本更低：

```redis
*1\r\n$2000000000\r\n
```

**18 字节**。这个请求过去会让 RSS 从 35MB 涨到 **1GB 以上**——因为解析器对未终止的内联行无界增长缓冲区，并且**声明了一个 bulk 长度就立刻预分配**。

修法：内联行超过 64KB 直接失败（`too big inline request`）；超过 1MB 的 bulk 改成**数据到达时增量增长**。顺手把解析器错误里重复的 `-ERR Protocol error: ` 前缀去掉了。

### 3.3 复制链路上的嵌套数组：一台恶意 master 打死 replica

PR #8187 是五个里最危险的一个，因为它的攻击者位置是**你的主库**：

> 用于复制 / 协议客户端的 CLIENT 模式 RedisParser 构建时没有界限（`max_arr_len=UINT32_MAX`，`max_bulk_len=UINT64_MAX`）。一个恶意或**在路径上的** master/peer 可以发一个内层计数约 2e9 的嵌套数组，让 `ConsumeArrayLen` 的 `reserve()` 分配出多 GB 的 vector → `std::bad_alloc` → **replica abort（DoS）**。

「on-path」（在路径上的）这几个字是关键：不需要 master 被攻破，只需要中间链路被动过。修法是让 `ResetParser` 用已有的 `--max_multi_bulk_len` / `--max_bulk_len` 标志构建有界解析器；SERVER 模式（镜像上游 master 命令，参数数可能超过客户端上限）用一个更宽松的数组界（`max(flag, 1<<20)`）。

**这背后是一个真实的工程权衡**：master→replica 的流量是**信任域内**的，但「信任域内」在 2026 年不再是「不做校验」的理由。Dragonfly 选了「客户端路径已有的界，复制路径也要有，但放宽」。

### 3.4 Memcached 键长：缓冲区溢出

PR #8213 是一个**内存安全**漏洞，不是 DoS：Memcached 协议规定键最长 250 字节，但不是所有解析路径都校验。后面这个固定大小的字符串被回复构造器当作「piece」处理，**假定它是固定大小**——如果它不是，就溢出内部缓冲区。

作者解释了为什么它不构成 Redis 端口的提权风险：Memcached 命令从不返回未被提及的键（没有 SCAN 类命令），所以要请求一个大键必须先在命令里提到它，而那会被解析器拒绝。

### 3.5 SORT LIMIT 的 32 位溢出

PR #8212：`SORT LIMIT` 的范围在接近 32 位上限时溢出。这类 bug 的危害不是崩溃而是**返回错误结果**——排序返回的条数和客户端要求的不一样。在一个把排序结果当业务事实的系统里，这比崩溃更难发现。

### 3.6 攻击面对比表

| 攻击面 | PR | 攻击者位置 | 触发成本 | 后果 | 修复策略 |
|---|---|---|---|---|---|
| RESTORE 声明长度 | #8222 | 任意持有写权限的客户端 | ~12KB + CRC64 | SIGABRT / SIGSEGV | 全部预分配对着 `RemainingBytes()` 校验 |
| 内联行 / bulk 长度 | #8215 | 任意客户端 | 18 字节 | RSS 涨到 1GB+ | 内联 64KB 上限，bulk 增量增长 |
| 复制嵌套数组 | #8187 | **master 或链路上的中间人** | 一个嵌套数组 | replica abort | 复制解析器套用客户端界（放宽到 1<<20） |
| Memcached 键长 | #8213 | Memcached 协议客户端 | 一个超长键 | 内部缓冲区溢出 | 协议层强制 250 上限 |
| SORT LIMIT | #8212 | 任意客户端 | LIMIT 接近 2³¹ | 返回错误结果 | 范围检查 |

**关键洞察 4：五个攻击面共享同一个反模式——「信任输入里声明的长度」。** 一个内存数据库的解析层，在任何时候都不应该因为「对方说这个数组有 20 亿元素」就去 `reserve()` 20 亿元素。这条规则在客户端路径早就落实了（Redis/Valkey 一直有 `max_bulk_len`），v2.0.0 把它**扩展到了加载器和复制路径**——这两个地方过去被默认信任，因为「谁会给自己的 loader 喂损坏的快照」和「谁会攻击自己的 master」。2026 年的答案是：fuzz 测试会，中间人会，以及你自己的下一个 bug 会。

---

## 四、共享读缓冲：一个 657 行的架构豪赌

PR #8145 是 v2.0.0 里在「性能」分类下、但本质是**架构改动**的一个：**+657 −87**，11 个文件。

### 4.1 问题：每个连接 32KB

Dragonfly 的 V2 IO 循环里，每个 RESP V2 连接持有一个私有读缓冲区。配合 PR #8005 的改动，默认最大是 **32KB**（从 64KB 砍半）。算一笔账：

```text
25,000 连接 × 32KB = 800,000KB ≈ 800MB
```

这是一台 32 核机器上、**什么命令都不执行**就先吃掉的 800MB。对于做 session 存储、IM 在线状态、长连接推送的场景，连接数动辄几万到十几万，这笔开销比数据本身还大。

### 4.2 解法：每 proactor 一个共享缓冲

改动引入 `ProactorReadBuffer`：符合条件的 RESP V2 连接向所属 proactor（线程）**借一个共享输入缓冲**，建立私有缓冲释放后所需的生命周期。

发布说明里那个数字——「25K 连接 32 核从约 800MB 降到 1MB 以下」——**在本 PR 里不会实现**。原文写得非常明确：

> Note: The reduction will materialize only on following PRs, when the private buffer is released.

**关键洞察 5：这是 v2.0.0 最值得学习的工程决策——把「立功」的机会让给后续 PR，把「正确地建立生命周期」先做完。** 一个 657 行的改动如果同时改生命周期模型又同时兑现内存收益，回归出了问题都无法定位是哪一步的错。作者选择在本 PR 里只建立机制，并在 release notes 里**显式标注收益未兑现**，而不是把它写进 Highlights 表功。

（这也解释了为什么 v2.0.0 的 Highlights 写得这么克制：这个版本里好几处「性能」条目都是**建立机制、收益后置**的。）

### 4.3 配套：连接缓冲的自缩容

PR #8005（+501 −105）是共享缓冲的前置条件：让 V1 和 V2 的输入缓冲在**低使用窗口之后自缩容**。几个关键设计：

- **只有 V2 做外部 receive-idle 缩容**：因为 V2 的 idle await point 让 resize 变得安全；V1 仍持有接收缓冲视图，缩了会出问题。
- **修掉不一致的缓冲增长**：parser hint 和 full read 之前用两套目标容量计算，现在统一。
- **三个新配置**：`enable_iobuf_shrink`、`iobuf_shrink_interval_sec`、`iobuf_shrink_min_idle_sec`。
- **`max_client_iobuf_len` 从 64KB 降到 32KB**，理由写得很实在：「避免现有工作负载的 OOM 告警；典型请求远低于这个上限」。

配套的遥测性能优化（PR #8246 / #8225 / #8224）合起来是把记账的**刷新频率**降下来：

| PR | 改动 | 效果 |
|---|---|---|
| #8225 | 解析器内存遥测在 `ParseRedis` 退出时**每批刷一次**，而不是每条命令后 | 网络增量记账，最终值正确 |
| #8246 | Memcached 解析器内存每批刷一次；跳过无命令的 V1 squash；关闭/迁移离站时减去**上次上报的贡献**而非重新测量 | 去掉冗余测量与连接扫描 |
| #8224 | 没有 pipeline 回复在途时**不创建** ReplyScope / 不开 batch 模式 | 空转开销归零 |

#8246 里有句话值得单独拎出来：「合并是**刻意保守**的：本 PR 不施加基于时间的刷新率，也不跨可能阻塞的命令推迟更新。」——在性能优化里**主动声明我没做激进优化**，是为了不引入延迟毛刺和一致性窗口。

---

## 五、把分布式正确性当承重结构

v2.0.0 有一批修复，单独看是 bug fix，合起来是 Dragonfly 在多线程 shared-nothing 架构上**补全分布式契约**。

### 5.1 跨 shard 释放：mimalloc 的 heap 归属性

PR #8037 处理的是一个只有多线程内存数据库才会有的 bug。RDB loader 把跨多 chunk 的值（hash/set 条目被拆在多个 RDB chunk 里）暂存在 `now_chunked_` 中。这些值通过 `Shard(key, shard_num)` 在**所属 shard 的线程**上创建，因此分配在**那个 shard 的 mimalloc heap** 上。

但 `FinishLoad()` 直接在 loader 线程上清理 `now_chunked_`。**在别的线程的 heap 上释放内存**，触发 `mi_heap_contains_block` 检查失败，进程崩。触发条件是 EOF 落在 chunk 中间。

修法：`FinishLoad()` 把残留条目按所属 shard 分组，用 `shard_set->Add()` **派发到各 shard 销毁**——复用同函数里 `FlushShardAsync` 已有的模式。`CreateObjectOnShard()` 在解析失败时立刻用 `absl::Cleanup` 移除自己的条目。

**关键洞察 6：在 shared-nothing 内存数据库里，「这块内存归哪个线程」是一个必须被代码结构表达的事实，而不是一个靠注释维持的约定。** 一旦释放路径和分配路径分属两个线程，崩溃就只是时间问题，而且只在「加载中途打断」这种边缘条件下出现——正是最难复现、最难查的那类。

### 5.2 XREADGROUP 唤醒：阻塞客户端的四种死法

PR #8015 / #8031 / #8038 / #8019 是一个系列，都在修同一个场景：

```redis
XREADGROUP GROUP g c BLOCK 0 STREAMS s >
```

客户端阻塞在一个流上，`BLOCK 0` 意味着无限等待。问题是这个 key **再也不会变成就绪状态**了：

| 场景 | 原来 | 修复后 |
|---|---|---|
| 流被删除（PR #8015） | 永远阻塞到超时（`BLOCK 0` 就是永远） | `DbSlice::Del` 标记已删除的流 key 为已唤醒，事务提交时派发事件；reader 恢复并回复 **NOGROUP** |
| 流自然过期（PR #8031） | 同上，永远阻塞 | 阻塞的 XREADGROUP 收到 **NOGROUP** |
| 流被改成别的类型（PR #8038） | 同上 | 阻塞的 XREADGROUP 收到 **WRONGTYPE** |
| FLUSHDB（PR #8019） | 同上 | 同上 |

这里的设计判断很精妙：**XREAD 与 XREADGROUP 的语义被有意区分**。流被删除后，`XREAD` **继续等**——因为流可以被重建，重建后仍能服务；`XREADGROUP` **立刻唤醒报 NOGROUP**——因为消费者组状态已经没了，等下去没有意义。这不是「忘了区分」，是「想清楚了两种客户端的期望不同」。

同时唤醒路径**重新解析消费者组**，不再解引用阻塞前缓存的 `streamCG*`——那个指针在删除时已经被释放了（**释放后使用的经典形态**）。

### 5.3 迁移 finalize 超时：DCHECK 变成生产 abort

PR #8240 是一个把 debug 断言放进生产路径的典型：

```cpp
// 修复前：outgoing_slot_migration.cc:387
Check failed: pause_fb_opt
```

`FinalizeMigration` 在 finalize 前暂停客户端，避免事务带着过期的 slot 归属被调度。`dfly::Pause()` 在忙命令没派发完时**合法地**返回 `nullopt`——后面的代码本来就处理了这个 case（记日志 + 记错误），但**紧挨着前面放了个 `DCHECK(pause_fb_opt)`**，进程直接 SIGABRT。

这个 bug 在 fuzz-migration 测试（3 节点 20000 keys）里复现，在真实负载下也会触发。修法是把 DCHECK 去掉，让执行落到已有的错误处理。

**教训**：一个「不可能发生」的断言，一旦在负载下真的发生了，就把一个**已有容错路径**的问题升级成了**进程崩溃**。断言应该保护不变量，不应该吞掉已有的错误处理。

### 5.4 tiered 序列化的类型保留

PR #8026：实验性的 hash offloading 上线后，`SerializerBase` 把**所有**外部值当字符串读。于是在快照、全同步流、`DUMP` payload 里，**listpack 编码的 offloaded hash 被序列化成了 STRING**。Debug 构建触发 DCHECK，Release 构建把原始 listpack 字节当字符串写出去——**数据类型在持久化层被静默改变**。

`DumpToString`（`DUMP` 和跨 shard `RENAME`/`COPY` 用）有同样的假设，而且它和快照序列化可能对**同一个合并的磁盘读**请求不同的 decoder（`StringDecoder` vs `ListpackMapDecoder`）。

修法：序列化时保留 offloaded 值的**逻辑类型**。这个 bug 的危害层级值得标注：它不崩溃、不报错，**它让你的快照在恢复后结构不对**。在有 tiered storage 的系统里，持久化层必须知道「外部存储里放的不只是字符串」。

---

## 六、兼容性边界的推进

### 6.1 Valkey 9 RDB：跨 fork 的快照互操作

PR #8251 让 Dragonfly 能加载 **Valkey 9 的 RDB 快照**，具体是带**字段级过期**的 hash：

- 识别 `VALKEY080` RDB header（与 Redis 的 header 并列）
- 注册 Valkey 对象类型 **22**（带毫秒级字段过期的 hash）
- 把小端序的字段过期时间戳转成 Dragonfly 的**秒级** member-expiry 表示
- 新类型走已有的 hash 构造与流式加载路径
- 技术细节：**Valkey header 的接受被刻意限制在 RDB 版本 80**

这个改动的意义超出「多支持一种格式」。2024 年 Redis 改 License、Valkey fork 出来之后，生态里真正的问题不是「哪个命令我支不支持」，而是**「我的快照能不能在你那里恢复」**。快照互操作是迁移路径的地基。Dragonfly 同时兼容 Redis 和 Valkey 两条线的 RDB，加上 v2.0.0 里修的 RedisShake RDB type 20 兼容（#8227，无论 footer 版本都按 set listpack 解码），勾勒出一条明确的策略：**做 fork 生态之间的双向桥**。

### 6.2 GEOSEARCHSTORE

PR #7984 补上 `GEOSEARCHSTORE`（dest + src 键，搜索选项与 GEOSEARCH 一致，可选 STOREDIST）。大部分实现在 `GeoSearchStoreGeneric()` 里已经有了（GEORADIUS ... STORE 走的是同一条），本 PR 是接上专用命令和解析器。顺手修了两个 Redis 不一致：源 key 缺失时 STORE 现在返回 0 并清空 dest key（原来是空数组）；COUNT 不带 ANY 时返回最近的 N 个成员。

ACL 强制、journaling、距离排序、limit 都在这一次补齐。Issue #3883 等了这个功能三年。

### 6.3 JWT 认证：把密码从数据库里拿出去

PR #8171 是一个很有「2026 年感」的改动：**JWT 验证作为密码 AUTH 的替代**。设计很干净：

- 加 `JwtValidator`：把 AUTH 凭据 POST 到 `--jwt_validate_url`，把返回的 username 映射到**预配的 ACL 用户**
- `--jwt_validate`（运行时可改）和 `--jwt_validate_url`（仅启动时）两个开关
- `ConnectionContext::auth_expires_at`：JWT 自己的 `exp` 过期后**强制重新认证**，在每条命令派发时与既有 ACL 检查一起做

意义在于：客户端**从不需要持有 Dragonfly 密码**。验证委托给一个受信的本地 agent（PR 里举的例子是 Entra ID validation）。这是把「数据库认证」从「共享密钥」模型搬到「短期令牌 + 外部验证」模型——和 runc 那条线的逻辑是同源的：**减少系统里长期有效的凭据数量**。

### 6.4 复制积压缓冲：从固定长度到时间+字节双预算

PR #8039 换掉了复制积压缓冲的**固定每 shard 条目计数**模型：

- `--shard_repl_backlog_time_ms`，默认 **5 秒**年龄目标
- `--shard_repl_backlog_max_bytes`，默认 **maxmemory 的 0.5%**
- **废弃** `--shard_repl_backlog_len`

技术细节：字节数配额在 shard 间分配，时间驱逐在 append 时评估并按**一秒一个桶**分组。

为什么重要：部分重同步（partial sync）的成功率取决于 backlog 里还有没有 replica 断连期间的数据。固定条目数的问题是大命令和小命令占的预算完全不同——一个 1MB 的 `SETRANGE` 吃掉的条目数和一个 32 字节的 `SET` 一样，但内存差三万倍。**双预算模型让「5 秒断连窗口能重同步」成为一个可预测的承诺。**

---

## 七、性能数据：把回复合并起来

不是所有性能改动都在内存记账那条线上。PR #8289（修 `CL.THROTTLE` 的整秒舍入并批量化回复）带了一个干净的 benchmark：

| Benchmark | Before (req/s) | After (req/s) | 提升 |
|---|---:|---:|---:|
| 本地 MacBook ARM64 Docker，200k keys，64 连接 | 107,576 | 210,228 | **1.95x** |
| Azure x86-64，1 key，两次 | 72,649 / 73,939 | 244,087 / 249,767 | **3.4x** |
| Azure x86-64，200k keys，两次 | 72,259 / 65,049 | 256,593 / 253,161 | **3.6x** |

提升来源是把五个整数的回复**合并成一次 reply-sink 写**（原来是六次），外加修了整秒舍入。这是「协议层小改动、吞吐大收益」的教科书案例：在 pipeline 1 的情况下，每个请求的回复写入次数直接决定 QPS。

**同时它也说明一件反直觉的事**：在这个 case 里瓶颈不在存储引擎、不在 DashTable、不在多线程调度，而在**回复序列化器被调用的次数**。`CL.THROTTLE` 这个命令本身做的是限流计算（O(1)），却因为回复路径的六次写入，把 QPS 压在 7 万。**在高度优化的系统里，最后的性能常常在「你以为不重要」的地方。**

---

## 八、可直接运行的代码

### 8.1 复现 QList 记账漂移（v1.40 vs v2.0.0）

```python
# 需要 redis-py: pip install redis
# 对比 v1.40.x 与 v2.0.0 的 used_memory 行为
import redis, subprocess, time, statistics

def bench(r, cmd, n=500):
    pipe = r.pipeline(transaction=False)
    for i in range(n):
        pipe.rpush("celery:queue", f"task-{i}-payload-{'x' * 200}")
    pipe.execute()
    before = r.info("memory")["used_memory"]
    # LTRIM 跨越压缩节点删除 —— v1.40 这里会过度扣减
    r.ltrim("celery:queue", 100, 200)
    after = r.info("memory")["used_memory"]
    real = r.memory_usage("celery:queue") or 0
    return before, after, real

# v1.40: before/after 可能为负增长或与 real 严重不符
# v2.0: after ≈ real（稳定略低，保守方向）
```

### 8.2 关闭无界分配攻击面之后的 RESTORE 拒绝

```python
import redis, zlib

r = redis.Redis(host="localhost", port=6379)

# 构造一个声明 20 亿元素的 SET，实际 payload 只有几 KB
# v1.40: 服务端 abort（mimalloc OOM → SIGABRT）
# v2.0: 返回 ERR，服务器存活
def craft_restore(key, declared_members: int) -> bytes:
    # 简化演示：真实利用需要构造合法的 RDB 类型 2 (SET) 编码
    body = b""
    body += b"\x02"                    # RDB type 2 = SET
    body += b"\xfd\x00\x00\x00@"       # 长度编码占位（演示用）
    payload = body + b"\xff"           # 结束标记
    # RDB footer: 8 字节 CRC64 + 1 字节版本
    crc = zlib.crc32(payload) & 0xFFFFFFFF
    return payload + crc.to_bytes(8, "little") + b"\x0b"

try:
    r.execute_command("RESTORE", "evil", 0, craft_restore("evil", 2_000_000_000))
    print("RESTORE accepted (unexpected)")
except redis.exceptions.ResponseError as e:
    print(f"RESTORE rejected (v2.0 expected): {e}")

# 关键验证：服务器必须存活
print("PING:", r.ping())
```

### 8.3 18 字节的 RSS 膨胀测试

```bash
# v1.40: RSS 从 35MB 涨到 1GB+
# v2.0: 返回 "too big inline request"
printf '*1\r\n$2000000000\r\n' | timeout 3 redis-cli -h 127.0.0.1 -p 6379 2>&1 | head -2
# 输出预期（v2.0）:
#   -ERR Protocol error: too big inline request

# 然后确认服务器存活
redis-cli -p 6379 ping
```

### 8.4 共享读缓冲的内存账本

```python
# 换算 PR #8145 / #8005 的数字
conns = 25_000
cores = 32

# v1.40 时代：每连接私有 64KB
private_64k = conns * 64 * 1024
# v2.0 默认：每连接私有 32KB（#8005 砍半）
private_32k = conns * 32 * 1024
# #8145 的目标：每 proactor 一个共享缓冲
shared = cores * 32 * 1024

print(f"私有 64KB (v1.40):  {private_64k/1024/1024:.0f} MB")
print(f"私有 32KB (v2.0):   {private_32k/1024/1024:.0f} MB")
print(f"共享/proactor:      {shared/1024/1024:.1f} MB")
print(f"节省: {(private_32k-shared)/1024/1024:.0f} MB ({(1-shared/private_32k)*100:.1f}%)")

# 输出:
# 私有 64KB (v1.40):  1563 MB
# 私有 32KB (v2.0):   781 MB
# 共享/proactor:      1.0 MB
# 节省: 780 MB (99.9%)
# 注意: #8145 的收益要等后续 PR 释放私有缓冲后才兑现
```

### 8.5 生产调优：碎片整理的 CPU 占比封顶

```bash
# PR #8115 引入的公式:
#   max_burst_duration_us / (max_burst_duration_us + backoff_duration_us)
#   = defrag 自旋时预估占用的 CPU 时间百分比

# 例: 期望 defrag 占不超过 ~1% 单核
#   burst 10ms, backoff 990ms  -> 10/(10+990) = 1%
dragonfly-server \
  --max_burst_duration_us=10000 \
  --backoff_duration_us=990000

# 例: 30% 上限（PR 作者建议的起步值）
dragonfly-server \
  --max_burst_duration_us=300000 \
  --backoff_duration_us=700000

# 手动触发 segment 级碎片整理（PR #7995）
# MEMORY DEFRAGMENT-SEGMENTS [threshold]
# 遍历 db slice -> db table -> prime table -> segments
# 配额绑定 150us，调用间状态用游标保存在 db table 对象里
redis-cli MEMORY DEFRAGMENT-SEGMENTS 0.05

# 复制积压缓冲双预算（PR #8039）
dragonfly-server \
  --shard_repl_backlog_time_ms=5000 \
  --shard_repl_backlog_max_bytes=0      # 0 = 用 maxmemory 的 0.5% 默认值
# 已废弃: --shard_repl_backlog_len（固定条目数模型）

# 连接缓冲自缩容（PR #8005）
dragonfly-server \
  --enable_iobuf_shrink=true \
  --iobuf_shrink_interval_sec=60 \
  --iobuf_shrink_min_idle_sec=300 \
  --max_client_iobuf_len=32768         # 32KB, 原默认 64KB
```

---

## 九、六条 6-12 月可验证硬指标

1. **QList 记账精度**：500 元素 Celery-like 列表 + ZSTD 稳态压缩 + `LTRIM` 跨节点删除，`used_memory` 与 `MEMORY USAGE` 的偏差从 **13 倍高报 / 负值绕回** 收敛到 **稳定略低于实存**（19719 tracked vs 21968 actual）。可在一台 v2.0.0 实例上跑 8.1 的脚本复现。
2. **stream size 边界**：`XADD` + `XTRIM` 到 56 位边界附近，`used_memory` 不再出现 TB/EB 级读数；原代码的 `SetSize(Size()+size)` 路径在负 delta 时会绕回。
3. **RESTORE 攻击面**：约 12KB 的 CRC-valid 负载在 v1.40 上触发 `mimalloc: out of memory` SIGABRT，在 v2.0.0 上返回 `ERR` 且服务器存活（8.2 可复现）。
4. **连接内存**：25K 连接 / 32 核，私有 32KB 缓冲合计 **约 800MB**；共享 proactor 缓冲落地后 **< 1MB**。注意 #8145 只建立生命周期，收益在后续 PR。
5. **CL.THROTTLE 吞吐**：pipeline 1、200k keys、64 连接，从 **107,576 req/s → 210,228 req/s（1.95x）**；Azure x86-64 单 key 场景 **3.4-3.6x**。
6. **碎片整理 CPU 封顶**：`max_burst_duration_us` / (`max_burst_duration_us` + `backoff_duration_us`) 的比值，在 1% 封顶配置下 defrag 自旋引起的 CPU 尖峰消失（PR 作者用 10GB 开发实例的 CPU 曲线验证）。

---

## 十、六条 6-12 月可观察的未来信号

1. **共享读缓冲的收益兑现**：#8145 明确写「reduction will materialize only on following PRs」。未来一个版本里如果出现「释放私有缓冲」的 PR，800MB → 1MB 这条数字就会变成 release notes 里的实绩。**观察后续 release 的 Performance 段。**
2. **Valkey 9 RDB 互操作的扩展面**：目前只支持 RDB 版本 80 + 对象类型 22（字段级过期 hash）。如果 Dragonfly 后续逐步补齐 Valkey 的其他新对象类型，说明「跨 fork 快照桥」在成为一等公民。**观察 `VALKEY` header 接受的版本号范围是否放宽。**
3. **记账回归测试成为合并门槛**：#8014 的三个测试、#8066 的边界测试都是「作者验证过在没有修复时会失败」的。如果这类「记账一致性」测试在 CI 里成为强制项，静默漂移类 bug 的发现周期会从「运维半夜被叫醒」缩短到「PR 阶段」。
4. **JWT 认证的外部化走向**：`--jwt_validate_url` 目前是启动时配置。如果演变成运行时可切换、或多验证器链，说明 Dragonfly 在把「数据库密码」这个长期密钥从系统里进一步挤出去。
5. **多线程 heap 归属检查的泛化**：#8037 用 `shard_set->Add()` 派发销毁。如果这个模式被抽象成一个 Ownership 约束（分配线程必须释放），跨线程释放类崩溃会在编译期或测试期被拦下。
6. **fuzz 测试资产跨项目流动**：#8222 的漏洞由 Valkey 的 `integration/corrupt-dump` 发现。Redis/Valkey/Dragonfly/KeyDB 四个实现如果开始共用损坏快照语料，loader 的健壮性会整体抬升。

---

## 十一、总结与最佳实践

### 11.1 v2.0.0 到底改了什么

一句话：**它把「内存数字可不可信」从运维信任问题，变成了有回归测试保证的工程问题。**

三年才动的主版本号，没有新功能、没有新协议、没有新数据类型（GEOSEARCHSTORE 是补已有的实现）。它改的是**指标的定义域**：`used_memory`、`used_memory_peak_rss`、`MEMORY USAGE`、连接内存遥测、stream size——这些数字在过去是「大概对」，现在每一个背后都有一个「没有对应修复时会失败」的测试。

同时它关掉了五个「信任声明长度」的攻击面，其中最危险的一个（PR #8187）把威胁模型从「客户端」扩展到「你的 master 或链路上的中间人」。

### 11.2 五条最佳实践

1. **增量记账的更新点只能有一个。** QList 的 13 倍漂移和 unsigned 绕回，根因是四个函数各自更新 `malloc_size_`。把更新收敛进单一函数，让「忘记更新」在结构上不可能。
2. **「存不下了」必须是一个被处理的分支，不是截断。** stream size 的 TB 读数、SORT LIMIT 的溢出，都是「值放不进位域」时被静默截断。显式比较 + 慢路径重算。
3. **解析层永远不信任声明长度。** 客户端路径有 `max_bulk_len`，加载器和复制路径也要有。每个预分配对着「输入还剩多少字节」校验，而不是对着「对方说有多少」。
4. **DCHECK 不应该吞掉已有的错误处理。** #8240 里 `Pause()` 超时本有完整的容错路径，一个 DCHECK 把它变成了生产崩溃。断言保护不变量，不替代错误处理。
5. **大改动先建机制、后兑现收益，并公开声明。** #8145 的 657 行只做生命周期，release notes 明写「收益在后续 PR」。这比「一个 PR 同时改架构又表功」可回滚得多。

### 11.3 五步生产升级 checklist

1. **先跑一遍记账对账。** 升级前在同一负载上记录 `used_memory` vs `MEMORY USAGE` 的偏差。升级后重跑——如果偏差显著缩小，说明你过去一直在错的数字上做容量规划。**把新的（更低的）`used_memory` 纳入告警阈值评审**，否则升级后可能触发「内存下降」误告警。
2. **改复制积压缓冲配置。** `--shard_repl_backlog_len` 已废弃，换 `--shard_repl_backlog_time_ms=5000` + `--shard_repl_backlog_max_bytes`。验证你的部分重同步成功率在断连 5 秒窗口内是否达标。
3. **审计 RESTORE / DUMP 暴露面。** 如果你的服务把 `RESTORE` 暴露给不受信客户端（哪怕是内部服务的低权限账号），升级是强制的。验证方式见 8.2——**确认升级后服务器在攻击下存活**。
4. **调碎片整理 CPU 封顶。** 从 `max_burst_duration_us=300000` / `backoff_duration_us=700000`（约 30%）起步，观察 CPU 时间曲线。如果你之前因为 defrag CPU 尖峰把 Dragonfly 排除在某些实例类型之外，现在可以重新评估。
5. **验证 tiered storage 的快照。** 如果你开了实验性 hash offloading，升级后做一次完整快照 + 恢复验证，确认 offloaded hash 的**逻辑类型**在恢复后仍是 hash（#8026 修的是它在序列化时变成 STRING）。

### 11.4 千万别做

- ❌ **不要**在升级后沿用旧的 `used_memory` 告警阈值。记账变准了，历史阈值多半是错的。
- ❌ **不要**把 `--shard_repl_backlog_len` 留在配置里——它已废弃，继续用会回到固定条目数模型，大命令会很快吃光预算。
- ❌ **不要**在开了 hash offloading 的实例上跳过快照恢复验证。类型在持久化层被改变是静默的。
- ❌ **不要**把 #8145 的「800MB → 1MB」当成 v2.0.0 的已兑现收益去写容量规划。它建立的是机制，收益在后续版本。
- ❌ **不要**因为「这是 minor 修复为主的大版本」就跳过回归测试。这个版本改的是指标的定义，你的业务依赖这些指标。

---

## 写在最后

Dragonfly v2.0.0 是那种「发布说明越读越有东西」的版本。表面写着「不新增重大功能」，Highlights 只列了三条，但 changelog 31KB、89 个 PR，其中八个直接改写内存指标的含义，五个关闭无界分配攻击面，一个 657 行的架构改动把「每连接 32KB」的假设换成「每 proactor 一个缓冲」。

它讲了一个朴素的道理：**在一个内存数据库里，「这个对象占多少内存」这个问题如果答不准，上面所有的高级功能都是沙上的塔。** 淘汰策略会错杀好 key，OOM 拒绝会在还有内存时拒绝写入，容量规划会在一个 13 倍高报的数字上做年度采购决策，autoscaler 会对着一个 TB 级的虚假读数发疯。

而最有意思的部分是它的**修法**。不是「小心类型转换」、不是「记得更新计数器」——这些都是正确的废话。真正的修法是：**把更新收敛到一个地方让忘记变成不可能；让「放不下」成为一个显式分支；让 fuzz 测试跨项目流动；把「收益未兑现」写进 release notes 而不是表功。** 这些是结构性的，会留在代码里保护后面的每一个版本。

三年等一个主版本号，等来的不是新功能，是**可信度**。这大概就是「生产就绪」这四个字真正的价格。

---

## 附录 A：五套内存数据库记账方案 17 维度对比

| 维度 | Dragonfly v2.0.0 | Dragonfly v1.40 | Redis 8.x | Valkey 9.2 | KeyDB |
|---|---|---|---|---|---|
| **记账路径** | 变更时记账 + O(1) 查询（#8245） | O(n) 递归遍历连接容器 | 单线程增量 | 增量 | 增量（多线程 active-replica） |
| **`used_memory` 可信度** | 有回归测试保证 | 压缩列表漂移 13x / 负值绕回 | 高（单线程无竞争） | 高 | 高 |
| **压缩容器记账** | 压缩/解压 delta 对称（#8014） | 稳态压缩不更新记账 | listpack 无压缩 | listpack 无压缩 | 同 Redis |
| **快照加载器分配边界** | 全部预分配对 `RemainingBytes()` 校验（#8222） | 无界，12KB 可致 SIGABRT | 有界 | 有界 | 同 Redis |
| **复制解析器边界** | 套用 `--max_multi_bulk_len`（放宽到 1<<20，#8187） | `UINT32_MAX` / `UINT64_MAX` 无界 | 有界 | 有界 | 同 Redis |
| **内联请求上限** | 64KB 硬上限（#8215） | 无界 | 有界 | 有界 | 同 Redis |
| **连接读缓冲模型** | 每 proactor 共享（#8145，收益后置） | 每连接私有 64KB | 每连接私有 | 每连接私有 | 每连接私有 |
| **25K 连接内存（32 核）** | 目标 < 1MB（待后续 PR） | 约 800MB @ 32KB / 1.6GB @ 64KB | 约 800MB @ 32KB | 约 800MB | 约 800MB |
| **碎片整理** | segment 级 + CPU 占比封顶（#7995 / #8115） | table 级，CPU 无封顶 | 无（依赖淘汰） | 无 | 无 |
| **过期键扫描有界性** | 物理桶 + 时间 + 条数三重配额（#8129） | `Traverse()` 无界 | 有界（单线程） | 有界 | 有界 |
| **积压缓冲预算** | 时间 5s + 字节 0.5% maxmemory 双预算（#8039） | 固定条目数 | 字节 | 字节 | 字节 |
| **跨 fork 快照互操作** | Redis + Valkey 9（类型 22，#8251）+ RedisShake type 20（#8227） | Redis | 原生 | 原生 | Redis |
| **认证模型** | 密码 + JWT 外部验证 + 强制 exp 重认证（#8171） | 密码 | 密码 + ACL | 密码 + ACL | 密码 + ACL |
| **多线程 heap 归属** | 显式 shard 派发释放（#8037） | loader 线程直接清理（崩） | N/A 单线程 | N/A | 并行线程 |
| **阻塞流唤醒完备性** | 删除/过期/改型/FLUSH 四种全覆盖（#8015/#8031/#8038/#8019） | 全部永久阻塞 | 完备 | 完备 | 完备 |
| **tiered 序列化类型保留** | 保留逻辑类型（#8026） | 静默降级成 STRING | N/A | N/A | N/A |
| **恒导出零值指标** | 是（#8052） | 否 | 是 | 是 | 是 |

**读表要点**：Dragonfly v2.0.0 在「记账可信度」「攻击面收敛」「大连接数内存」「碎片整理可控性」四栏领先；Redis/Valkey 在「单线程无竞争所以记账天然可信」「阻塞流唤醒完备」两栏天然占优。**Dragonfy 这三年补的，正是「多线程架构」为了达到单线程记账可信度所必须付出的工程税。**

---

## 附录 B：15 分钟快速验证清单

升级到 v2.0.0 后，按顺序跑完这五件事，每件都能在 15 分钟内给出可判定的结果：

```bash
# B1. 记账一致性 —— 压缩列表不再漂移
#     v1.40: 差距 > 10x 或 used_memory 出现负增长
#     v2.0 : 差距应稳定地小（tracked 略低于 real）
redis-cli RPUSH t $(python3 -c "print(' '.join(['x'*200]*500))")
redis-cli CONFIG SET list-compress true 2>/dev/null || true
redis-cli LTRIM t 100 200
echo "tracked: $(redis-cli INFO memory | grep used_memory:)"
echo "real:    $(redis-cli MEMORY USAGE t)"

# B2. RESTORE 攻击面 —— 服务器必须存活
#     v1.40: 连接断开 + 服务端 SIGABRT
#     v2.0 : -ERR 且 PING 正常
redis-cli SET src "hello"
DUMP_PAYLOAD=$(redis-cli -r 1 DUMP src 2>/dev/null | head -c 60)
redis-cli RESTORE dst 0 "$DUMP_PAYLOAD" 2>&1 | head -1
redis-cli PING

# B3. 内联请求上限 —— 18 字节不再换 1GB
printf '*1\r\n$2000000000\r\n' | timeout 3 redis-cli 2>&1 | head -1
redis-cli PING

# B4. 碎片整理 CPU 封顶 —— 确认配置生效
redis-cli CONFIG GET max_burst_duration_us
redis-cli CONFIG GET backoff_duration_us
# 期望比值 = 你设定的 CPU 占比上限

# B5. 新增命令与兼容性
redis-cli GEOSEARCHSTORE 2>&1 | head -1          # 应有用法提示（命令存在）
redis-cli MEMORY DEFRAGMENT-SEGMENTS 0.05        # 应执行（可能返回 OK 或时间太短的提示）
redis-cli CONFIG GET shard_repl_backlog_time_ms  # 应返回 5000（新默认）
```

**判定规则**：B1 的 real 与 tracked 差距 < 2x、B2/B3 服务器存活、B4/B5 配置存在 = 升级成功且收益落地。任一项不符合，先查对应 PR 的 release notes 再回滚。

