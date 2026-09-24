---
title: "Valkey 9.2 深度拆解:forkless 快照、Path Hash 与 KV Cache 放置索引、ACL 角色化与后量子双证书"
date: 2026-09-24
category: 技术
tags: [Valkey, Redis, forkless, RDB, BGSAVE, Path Hash, radix tree, KV Cache, prefix cache, AI 推理, 路由, 放置索引, ACL, 角色, TLS, 后量子, ML-DSA, B+ tree, skiplist, LZ4, 压缩, 复制, 集群, 故障转移, 热键, 内存数据库, 缓存, 2026]
excerpt: "Valkey 9.2.0-rc1 (2026-09-16) 是这款 Redis 分叉两年来最大的一次架构跃迁。本文拆解 6 大承重级革新:forkless RDB 快照彻底消除 fork 的 COW 内存不确定性;全新 Path Hash 数据类型用 radix tree 把「KV Cache 放置索引」从应用层拍扁进服务端,一次 PHPREFIXES 调用拿回全部祖先前缀;ACL 角色化把 selector 集合变成可复用的一等公民;tls-alt-cert 双证书让后量子 ML-DSA 与 RSA 证书并行服务;有序集合底层从 skiplist 换成 B+ tree;XACKDEL/XDELEX 让流消息确认即删除。每项都附可运行代码、性能数据与生产迁移建议。"
cover: https://images.unsplash.com/photo-1553484764-6226b4c39235?w=600&h=400&fit=crop
readtime: 26
author: 林小白
---

# Valkey 9.2 深度拆解:forkless 快照、Path Hash 与 KV Cache 放置索引、ACL 角色化与后量子双证书

> 2026 年 9 月 16 日,Valkey 9.2.0-rc1 发布。这是自 2024 年 3 月 Redis 开源协议变更、Valkey 从 Redis 7.2.4 分叉以来,改动面最广、架构含金量最高的一个版本。它不是「修 bug + 加小特性」的常规迭代 —— 它一次性动了三件过去两年没人敢动的东西:**快照的 fork 模型本身**、**数据类型集合**、**ACL 权限模型**。

## 0. 一句话总结

**Valkey 9.2 把「缓存数据库」重新定位成「AI 推理时代的前缀索引 + 放置协调平面」**:forkless 快照让大内存实例的持久化不再是一场内存赌博;Path Hash 把分布式 KV Cache 放置索引从应用层拍扁进服务端,用 O(L+K) 的一次遍历替代应用层 O(L²) 的逐前缀查询;ACL 角色化 + 后量子双证书补齐了它作为企业级状态存储最后两块短板。

如果你在过去两年把 Valkey 当「更便宜的 Redis」用,9.2 是你该重新评估它的版本。

---

## 1. 问题的源头:三个被 fork 与应用层代码拖累的历史包袱

要理解 9.2 为什么是架构跃迁,得先看清它要解决的三个历史包袱。这三个问题都不是新问题,而是「从 Redis 时代就存在、但一直靠应用层代码或多花内存忍着」的问题。

### 1.1 包袱一:fork() 是内存数据库持久化的原罪

Redis/Valkey 的 BGSAVE 长期依赖一个 1970 年代 UNIX 的原语:`fork()`。主进程 fork 出子进程,子进程拿着 COW(Copy-On-Write)的页表去写 RDB 快照。这个模型在「内存小、写负载轻」的年代很优雅,但在 2026 年的部署条件下,它有四个越来越致命的问题:

| 问题 | 机理 | 2026 年的实际后果 |
|------|------|------------------|
| **COW 内存放大** | fork 后父进程每修改一个页,内核就把该页复制一份 | 一台 256GB 的实例,如果 save point 期间写覆盖了 30% 的页,峰值 RSS 可能冲到 332GB。容量规划必须按 `used_memory + 预估 COW` 算,而这个预估值只能靠经验猜 |
| **fork 本身的延迟** | fork 要遍历并复制整个页表,页表大小与 RSS 正相关 | 512GB RSS 的实例,一次 fork 可能阻塞主线程 800-1500ms。这段时间所有客户端的 P99 延迟一起飙 |
| **内存碎片与透明大页(THP)的相互作用** | THP 把 4KB 页聚合成 2MB 页,一次小写就触发整个 2MB 页的 COW | 业界经典顽疾。Valkey 的启动检查会警告 THP,但只能建议 `never` 或 `madvise`,无法根治 |
| **容器与 serverless 环境对 fork 不友好** | 沙箱(如 gVisor、Firecracker)、cgroup v2 内存上限、Python-on-Wasm 之类受限运行时的 fork 语义各异 | 在某些沙箱里 fork 直接被拒绝或语义残缺。「有 fork 才能持久化」成了部署的硬约束 |

**关键洞察 1:** `fork` 模型的本质问题不是「慢」,而是**不可预测**。COW 的量取决于 save 期间的写覆盖率,而写覆盖率是运行时变量。一个 save point 早上 3 点只 COW 2GB,晚上 8 点可能 COW 80GB。**你不能为一个不可预测的量做可靠的容量规划** —— 这才是运维真正讨厌 fork 的原因。9.2 的 forkless 模式把「持久化的内存开销」从「运行时写覆盖率相关」变成「启动时可配置的固定 4 字节/键」,把不可预测量变成了常量。

### 1.2 包袱二:前缀匹配在 KV 模型里的表达力缺口

第二个包袱更微妙,但在 2026 年尤其疼。先看一个真实的 AI 推理场景。

大模型推理普遍用 **prefix cache**(前缀缓存)来复用已计算的 KV Cache:把 prompt 切成固定大小的 block,每个 block 算哈希,链式累积哈希形成一个「累积哈希路径」。请求进来时,路由器(Router)要知道这个 prompt 的前缀分别缓存在哪些推理 Worker 上、各自命中到第几层。

**这个需求用现有数据类型怎么表达?** 你会本能地写:

```bash
# 方案 A:每个 block 哈希存成一个 Hash 的 field
HSET kv:placement:model-x <block-hash> <worker-list>
```

但前缀匹配的语义是:「给定查询路径 Q,找出所有满足 `p ⪯ Q`(p 是 Q 的字节前缀)的已存路径」。普通 Hash **没有前缀关系**——`H1`、`H2`、`H3` 是三个毫无关联的 field,你无法从 `BE64(C1)||BE64(C2)||BE64(C3)` 一次性推出 `BE64(C1)` 和 `BE64(C1)||BE64(C2)` 都是它的祖先。

于是应用层只能:

```bash
# 方案 B:暴力拆解 —— 对查询路径的每个前缀发一次查询
HGET kv:placement:model-x <C1>
HGET kv:placement:model-x <C1||C2>
HGET kv:placement:model-x <C1||C2||C3>
```

这就是 **O(L²) 的前缀拆解**:L 是路径深度,每个前缀一次网络往返。一个 128 层深的路径要发 128 个请求,还不算原子性 —— 你在第一跳和第三跳之间,Worker 的缓存可能已经淘汰了。

**也有人用 Sorted Set 试图搞定前缀关系。** 但 ZSet 的 score 是双精度浮点,排序语义是数值序,不是字节前缀序。`ZREVRANGEBYSCORE` 给不了你「所有祖先前缀」。Path Hash 的设计文档里有一句话很到位:

> The ordering of a Sorted Set is likewise not equivalent to a byte-prefix relationship.

**关键洞察 2:** 这个表达力缺口不是 AI 时代才有的 —— DNS 查找、路由表最长前缀匹配、文件系统路径、权限继承、autocomplete 索引全都是「祖先前缀枚举」问题。只是过去大家用 Hash + 应用层循环忍了。**Path Hash 的意义在于:它把「最长前缀匹配」和「全部祖先前缀枚举」变成了服务端的一次 O(L+K) 原子遍历,把这类工作负载从「N 次网络往返 + 应用层聚合」降级为「1 次网络往返」。**

### 1.3 包袱三:ACL 的「权限集合」不能复用

第三个包袱在权限层。Valkey 9.0 引入了 ACL selector(`user alice (+@read (~key:*))(+@write (~app:*))`),允许给一个用户配多个权限选择器。但 selector 是**内联在用户定义里**的,不能命名、不能复用。

设想一个真实场景:一个平台有 120 个微服务,分属 12 个业务域,每个域有一套「读缓存 + 写自己域的 key + 禁止危险命令」的权限模板。在 9.2 之前,你只能:

```bash
# 12 个域 × N 个用户,每个用户内联重复同一套 selector
ACL SETUSER svc-billing-1 (+@read +@write (~billing:*))(+@read (~billing:shared:*))
ACL SETUSER svc-billing-2 (+@read +@write (~billing:*))(+@read (~billing:shared:*))
# ... 120 遍,权限矩阵改一次就改 120 个用户
```

这是权限管理的「字符串重复」问题。**ACL 角色化就是把权限集合从「内联字符串」提升为「命名、可复用的一等公民」。**

---

## 2. 三层架构:Valkey 9.2 的核心设计

### 2.1 总体架构:事件循环 + rax 索引 + 多线程 I/O

先建立整体坐标。Valkey 的核心运行时是**单线程命令执行 + 多线程 I/O** 的经典模型:

```
                    ┌─────────────────────────────────────────┐
   客户端连接 ──────▶│  I/O 线程池 (io-threads)                │
                    │  ┌─────────────┐  ┌─────────────┐       │
                    │  │ io-thread 1 │  │ io-thread N │       │
                    │  └──────┬──────┘  └──────┬──────┘       │
                    └─────────┼────────────────┼─────────────┘
                              │ 读写就绪       │
                    ┌─────────▼────────────────▼─────────────┐
                    │        主事件循环 (main thread)         │
                    │  ┌─────────────────────────────────┐   │
                    │  │ 命令分发 → 执行 → 回复           │   │
                    │  └─────────────────────────────────┘   │
                    └───────┬───────────────────┬─────────────┘
                            │                   │
              ┌─────────────▼─────┐   ┌─────────▼──────────┐
              │  键空间 (KV 存储)  │   │ 持久化平面          │
              │  ┌─────────────┐  │   │ ┌────────────────┐ │
              │  │ object 层   │  │   │ │ RDB (forkless) │ │
              │  │ string/hash │  │   │ │ AOF            │ │
              │  │ list/set    │  │   │ └────────────────┘ │
              │  │ zset(btree) │  │   └────────────────────┘
              │  │ stream      │  │
              │  │ path-hash ◀──┼──── 9.2 新增数据类型
              │  └─────────────┘  │
              └───────────────────┘
```

9.2 的改动集中在右侧三个区域:**持久化平面**(forkless)、**object 层**(Path Hash + B+ tree zset + 流的 ack-delete)、**权限与传输平面**(ACL 角色 + 双证书)。

### 2.2 新数据类型 Path Hash:radix tree 上的前缀索引

Path Hash 的数据模型很干净:

```
Valkey key (顶级键,负责 namespace + Cluster slot + 树级 TTL)
└── Path Hash (RadixObject)
    └── rax index (radix tree)
        └── 路径 P1 (二进制安全字节串)
            └── field F1 -> V1   (field/value map)
            └── field F2 -> V2
        └── 路径 P1 || P2
            └── field F1 -> V3
```

形式化定义:`Tree: BinaryString -> Map<BinaryString, BinaryString>`。

这里有三层抽象,缺一不可:

1. **顶级键**:普通 Valkey 键,承担命名空间、Cluster 槽位路由、树级 TTL。它跟 String/Hash 键一样参与分片。
2. **路径(path)**:二进制安全的字节串,是 Path Hash 的逻辑键。**路径可以为空**,空路径代表根 payload。
3. **field/value map**:每个路径下挂一个 field 到 value 的映射。这个设计是点睛之笔 —— 见下文。

**为什么每个路径下是一个 field/value map 而不是一个值?** 这是设计文档里最值得琢磨的一处。如果每个路径只存一个值,那么「Worker A 把 block 缓存到 P2」和「Worker B 把 block 缓存到 P2」就得读-改-写整个值:

```
错误设计:每个路径一个值
path = BE64(C1)||BE64(C2)
value = [worker-a, worker-b, ...]   ← 两个 Bridge 并发更新 → 丢失更新
```

而 field/value map 把冲突粒度降到单个 field:

```
正确设计:每个路径一个 field map
path   = BE64(C1)||BE64(C2)
field  = worker-a
value  = generation=7,components=1111
```

`worker-a` 和 `worker-b` 各自 `PHSET`/`PHDEL`,命令天然幂等。**这是把「并发冲突的粒度」从「路径级」降到「field 级」的经典手段**,跟 CRDT 把冲突粒度降到字段级是同一个思路。

**编码升级策略**:小 payload 用 **listpack**(省内存),超过阈值**单向晋升为 dict**(field 更新接近 O(1))。删除后**不自动降级**,避免编码振荡带来的 CPU 抖动。这跟 Hash 的 listpack→hashtable 晋级是同一套工程哲学。

### 2.3 forkless 快照:把持久化从 fork 模型里解放出来

forkless 的核心思路:不在进程级做 COW 快照,而是在**键级**建立快照元数据。配置两个开关:

| 配置 | 取值 | 说明 |
|------|------|------|
| `forkless-infrastructure-enabled` | `yes`/`no`,默认 `no` | **immutable**:只能启动时配置,不能 `CONFIG SET` 改。开启时为每个键分配 4 字节额外元数据 |
| `bgsave-default-method` | `fork`/`forkless`,默认 `fork` | 可运行时修改。设为 `forkless` 时若加载了不兼容的 module,自动回退到 `fork` |

**关键设计取舍:`forkless-infrastructure-enabled` 为什么是 immutable?** 因为它改变的是**每个键的内存布局**(每键 +4 字节)。如果允许运行时开启,就要对整个键空间做原地重写,这本身就是一次大规模阻塞操作。用「启动时一次性付出 4 字节/键的代价」换「运行时零迁移成本」,是正确的工程权衡。

INFO 暴露了完整的可观测性:

```
INFO persistence
  rdb_current_bgsave_type: forkless
  rdb_last_bgsave_type: forkless
  forkless_estimated_seconds_remaining: 42
  rdb_bgsave_in_progress: 1        # 语义扩展:fork 或 forkless 都置 1
  rdb_current_bgsave_time_sec: 17
  current_fork_perc: 63            # 语义扩展:forkless 也报进度
```

注意 `rdb_bgsave_in_progress` / `rdb_current_bgsave_time_sec` / `current_fork_perc` 这三个字段的**语义被扩展**了 —— 它们不再只描述 fork,而是描述「任何后台保存」。这是一个兼容性细节:你现有的监控面板不用改代码就能同时监控两种模式。

### 2.4 权限平面:ACL 角色化

9.2 之前,一个用户的权限是 `selector` 的内联集合。9.2 之后,权限可以被命名、复用:

```bash
# 定义角色(命名、可复用的 selector 集合)
ACL SETROLE domain-billing (+@read +@write (~billing:*))(+@read (~billing:shared:*))
ACL SETROLE domain-readonly (+@read (~billing:*))

# 把角色分配给用户
ACL SETUSER svc-billing-1 on >password1 role:domain-billing
ACL SETUSER svc-billing-2 on >password2 role:domain-billing
ACL SETUSER reporting-job on >password3 role:domain-readonly
```

角色管理的完整命令面:

| 命令 | 作用 |
|------|------|
| `ACL SETROLE <name> <selectors>` | 创建/覆盖角色 |
| `ACL DELROLE <name>` | 删除角色 |
| `ACL GETROLE <name>` | 查看角色定义 |
| `ACL ROLES` | 列出全部角色 |
| 用户引用 `role:<name>` | 在 `ACL SETUSER`、ACL 文件、`valkey.conf` 中均可引用 |

**角色的作用域语义**:角色在**服务器级**定义,用户通过 `role:<name>` 引用。角色可以在 ACL 文件和 `valkey.conf` 中持久化 —— 这意味着你可以把权限矩阵版本化进配置仓库,走 GitOps 审批流。

### 2.5 传输平面:后量子双证书

`tls-alt-cert-file` / `tls-alt-key-file` / `tls-alt-key-file-pass` 三个新配置允许服务器**同时挂载两张证书**。典型用法:一张后量子 **ML-DSA** 证书 + 一张传统 RSA/ECDSA 证书。客户端用 TLS `certificate_authorities` + SNI 或证书选择逻辑决定握哪一张。

配套的可观测性:

```
INFO server
  tls_server_cert_serial: <实际加载证书的序列号>
  tls_server_cert_expiry: <过期时间>
# 双证书各自独立报告,auto-reload 监视两个证书文件
```

**为什么双证书而不是直接换?** 因为后量子迁移的现实是:**客户端能力分布是长尾的**。浏览器、新 SDK 支持 ML-DSA,但 2019 年的 IoT 固件、某些 JDK 8 长期支持版、内部遗留工具只认 RSA。双证书让你**在不中断服务的前提下**完成混合期过渡,而不是被迫选「安全」或「兼容」。

---

## 3. 版本细节:6 大承重级革新逐项拆解

按「改默认行为 / 解决历史遗留难题 / 引入新接口或协议 / 性能提升 ≥ 2x / 推动整个生态跟进」这五条标准筛选,9.2 里有 6 项达到「承重级」:

### 3.1 革新一:forkless RDB 快照(消除 COW 不确定性)

**解决了什么**:把快照的内存开销从「与 save 期间写覆盖率相关的不确定量」变成「每键 4 字节的常量」。

**架构改动**:
- 键级快照元数据(每键 +4 字节),开启 `forkless-infrastructure-enabled` 时分配
- `bgsave-default-method forkless` 时,主线程通过元数据追踪键的修改,后台线程序列化 RDB
- 自动兼容性回退:加载了不兼容的 module 时,forkless 降级为 fork
- 新增 `INFO persistence` 字段:`rdb_current_bgsave_type` / `rdb_last_bgsave_type` / `forkless_estimated_seconds_remaining`

**内部实现细节**:这是一个组合了 9 个 PR 的 feature branch(PR #3346 / #3469 / #3350 / #3562 / #3600 / #3553 / #4333 / #3648),合并于 2026-09-03(PR #4460)。**改动面之大,从 PR 拆分方式就能看出来 —— 这不是一个人 hack 一个周末的产物。**

**迁移注意**:
- `forkless-infrastructure-enabled` **必须重启**才能改,不能 `CONFIG SET`
- 每键 +4 字节。1 亿键 ≈ 400MB 额外内存,规划时加上
- module 兼容性:先在预发环境加载你的 module 试 `bgsave-default-method forkless`,观察是否自动回退 fork
- 默认不启用(`forkless-infrastructure-enabled no`)。**这是一个保守但正确的决策** —— forkless 改的是持久化的核心路径,默认开启等于把所有用户推进未验证状态

### 3.2 革新二:Path Hash 新数据类型(KV Cache 放置索引)

**解决了什么**:把「最长前缀匹配 + 全部祖先前缀枚举」从应用层的 O(L²) 网络往返降为服务端一次 O(L+K) 原子遍历。

**完整命令面(12 条)**:

| 命令 | 语法 | 用途 | 时间复杂度 |
|------|------|------|-----------|
| `PHSET` | `PHSET key path [FNX\|FXX] FIELDS n f v [f v...]` | 原子设置路径下若干 field | O(L + F·U) |
| `PHMSET` | `PHMSET key path FIELDS n f v [...] [path FIELDS n f v ...]` | 按路径分组原子批量设置 | O(ΣL + M·U) |
| `PHGET` | `PHGET key path field [field...]` | 精确路径读若干 field | O(L + F·U) |
| `PHMGET` | `PHMGET key path FIELDS n field [...] [path FIELDS n ...]` | 按精确路径分组批量读 | O(ΣL + M·U) |
| `PHGETALL` | `PHGETALL key path` | 读路径下全部 field/value | O(L + O) |
| `PHEXISTS` | `PHEXISTS key path` | 精确路径是否存在 | O(L) |
| `PHDEL` | `PHDEL key path [field...]` | 删 field 或整个路径 payload | O(L+F·U) / O(L+S) |
| `PHLONGEST` | `PHLONGEST key query [LENGTH] [WITHVALUES\|FIELDS n f...]` | 查询路径的最长已存前缀 | O(L + O) |
| `PHPREFIXES` | `PHPREFIXES key query [LENGTHS] [WITHVALUES\|FIELDS n f...] [COUNT c] [MAXLEN m]` | 查询路径的全部祖先前缀 | O(L + O) |
| `PHDELPREFIX` | `PHDELPREFIX key prefix` | 删除前缀下全部路径 | O(L + Σ(Pᵢ+Fᵢ)) |
| `PHSCAN` | `PHSCAN key cursor [PREFIX p] [COUNT c] [WITHVALUES]` | 增量遍历路径 | O(L + C + O) |
| `PHCARD` | `PHCARD key` | 逻辑路径数 | O(1) |

**几个设计细节值得单独说**:

**`PHPREFIXES` 的 `COUNT` 是硬上限不是 hint**。`COUNT 2` 保证最多返回 2 条。而且当匹配数超过 COUNT 时,保留**最深**的 count 条 —— 这符合路由场景的直觉:你要的是最深的命中,浅层命中信息量低。执行顺序是 `MAXLEN` 先过滤,`COUNT` 后截断。

**`LENGTHS` 选项省的是网络带宽**。查询路径可能是 128 × 8 = 1024 字节,返回 100 条匹配路径时,每条都带上完整路径字节就是 100KB 级的响应。`LENGTHS` 只返回每条的**字节长度**,调用方拿着自己手里的 query 切片即可。这是「调用方已知的信息不重复传输」的经典优化。

**`PHDELPREFIX` 不是增量的**。文档明确说明:它收集匹配路径到有界缓冲区、关闭迭代器、删除、重复,但**整个子树在同一个事件循环轮次内同步原子删除完毕**,chunking 不保证命令延迟。所以它是 `@slow` 命令,删一个巨大子树会造成主线程长延迟。**这是 v1 的有意限制** —— 文档里也给了未来路径:给 `rax` 加 subtree-detach 能力,把分离的节点交给 lazy-free 线程。

**失败语义的对称性**:`PHSET ... FNX`(所有 field 都不存在才写)和 `FXX`(所有 field 都存在才写)互斥,条件在**任何写入之前**对全部 field 求值。`FNX` 在键/路径不存在时成功并创建,`FXX` 在键/路径不存在时失败且不创建。这套语义跟 Redis 的 `SET NX/XX` 是同构的,迁移成本低。

**空路径与空树**:`PHDELPREFIX key ""` 清空整棵树但保留空的顶级 Path Hash 键。这遵循 Stream 的语义(`XTRIM` 可以留下空流),只有 `DEL`/`UNLINK` 删除顶级键。**空 Path Hash 对象会被 RDB、AOF rewrite、复制和 `COPY` 保留** —— 这是个容易踩的坑:你以为清空了,监控里键还在。

**RPO 的诚实表述**:设计文档明确指出 Path Hash 不提供同步复制或零 RPO,可靠性仍遵循所选的 Valkey 部署模型。它还区分了两类失败后果:**丢失 add → 假阴性 → 只是少复用缓存**;**丢失 delete → 假阳性 → 路由到已淘汰的 Worker**。因此建议 value 里带 **Worker generation**,路由器只接受当前活跃 generation。**这是把「最终一致性的风险」在应用层做成了单向安全失败模式** —— 假阳性比假阴性危险,所以把假阳性用 generation 兜底。

### 3.3 革新三:ACL 角色化(权限集合的一等公民)

见 §2.4 的命令面。这里强调三个工程细节:

1. **角色在 ACL 文件与 `valkey.conf` 中可持久化** —— 权限矩阵可以进 Git 仓库
2. **`ACL DIGEST` 新命令**返回当前生效 ACL 规则的指纹。这在自动化运维里非常有用:`ACL LOAD` 之后跑一次 `ACL DIGEST`,跟你配置仓库里的期望指纹比对,确认「你以为加载的权限」就是「实际生效的权限」。这是配置漂移检测的协议化手段
3. **`maxmemory-scripts` 配置**限制缓存 `EVAL` 脚本占用的内存,并**把 `SCRIPT LOAD` 标记为 DENYOOM** 使其尊重全局 maxmemory。**修的是真实的生产事故模式**:脚本缓存无上限时,高并发加载脚本的实例会 OOM

### 3.4 革新四:后量子双证书 + OpenSSL 4.0 适配

见 §2.5。补充一个细节:9.2 在 OpenSSL 4.0 构建上,如果证书的 `notBefore`/`notAfter` 字段非法会**记录警告**。另外 `tls_server_cert_serial` / 过期时间现在报告**实际从 `tls-cert-file` 加载的证书**,而不是「OpenSSL 先碰到的那张」。这是个细节但很关键 —— 之前字段可能报告错误的证书,导致过期监控误报。

**与 OpenSSL 4.1 / rustls 0.23.45 的后量子浪潮同频**:这是 2026 年传输安全层整体迁移的一个局部节点。Valkey 的定位是**状态存储**,证书过期或配置错误=数据不可达,所以它在证书可观测性上比一般中间件更谨慎。

### 3.5 革新五:有序集合从 skiplist 换成 B+ tree

大型有序集合底层从 skiplist 换成 B+ tree。`OBJECT ENCODING` 报告 `btree` 而不是 `skiplist`。

**为什么换?** skiplist 的每个节点带多层指针,且节点间指针缓存局部性差。B+ tree 的叶子节点紧凑排列,**范围扫描的缓存局部性显著更好**,而且每节点的扇出更大,树高更低。对 `ZRANGE` / `ZREMRANGEBYSCORE` 这类范围操作收益最明显。

**配套 bug 修复(说明改动确实有深度)**:修了「跨越多个 btree 叶子、共享边界 score 的成员」导致 `ZCOUNT` 结果错误和 `ZREMRANGEBYSCORE` 错误删除的问题(#4554)。**这类 bug 的存在恰恰说明 B+ tree 化是触及了存储层的真改动**,不是换个数据结构标签。

**迁移注意**:`OBJECT ENCODING` 的返回值变了。任何硬编码检查 `skiplist` 的监控/代码会失效。改成检查类型能力或用 `OBJECT HELP` 适配。

### 3.6 革新六:流的确认即删除(XACKDEL / XDELEX)

新命令 `XACKDEL` 和 `XDELEX`,带 `KEEPREF` / `DELREF` / `ACKED` 三种模式,在消费组不再需要消息时**原子地确认并删除**。

**解决了什么**:Stream 的经典痛点是**待处理消息堆积(PEL)**。`XACK` 只标记已处理,消息体留在流里;`XDEL` 只删除不确认。在「消费者组处理完就该清理」的场景里,你需要先 `XACK` 再 `XDEL` 两条命令,中间还存在非原子窗口。`XACKDEL` 一步到位。

**三种模式的语义分工**:
- `KEEPREF`:确认并删除消息,保留引用(用于审计)
- `DELREF`:确认并删除消息和引用
- `ACKED`:只处理已确认的消息

这跟 §3.2 的 Path Hash 一样,**都是把「两步操作」合并成「一步原子操作」** —— 9.2 的设计主旋律之一。

### 3.7 同批次的承重级性能与可靠性改动

除上面六项外,还有一批改动直接影响生产稳定性:

**热键检测内置化**:`HOTKEYS GET` / `HOTKEYS RESET`,通过 `hotkeys-top-k` 开启。**这取代了过去装 `redis-hotkey` 之类第三方工具或 sample `INFO` 的做法**。热键检测从「外挂工具」变成「服务端一等命令」。

**复制限流(`repl-throttling-enabled`)**:replica 落后时**主动减慢客户端写入**,避免触发断连和全量同步。**这是一个反直觉但正确的设计**:与其让 replica 积压到断连、然后付出一次全量同步的巨大代价,不如主动降速保护数据通路连续性。这是把「故障恢复成本」前置成「轻微的性能降级」。

**优先级连接保留**:`priority-subnets` 列出的 CIDR 来源连接被标记为优先,`maxclients-reserved` 为管理客户端保留槽位,`INFO clients` 报告 `connected_priority_clients`。**解决了「连接打满时连不上服务器排障」的经典死锁** —— 内存数据库 OOM 或连接打满时,你恰恰最需要能连上去。

**系统事件优先级**:`priority-preemptive-poll-interval-us` 让集群心跳、复制、槽迁移等系统关键事件优先于重客户端流量。**在高负载下保住控制平面的存活**。

**RDB LZ4 压缩**:`rdbcompression lz4` 支持全流式 LZ4 压缩(默认 per-string LZF 行为不变)。全量同步的 RDB payload 也在支持的前提下用 LZ4 压缩(#4075),稳态复制有可选 `repl-compression` LZ4 流压缩(#3853),按 replica 协商,老 replica 或 opt-out 的继续收明文。**这是把「跨 AZ/跨域同步带宽」当成一等成本来优化。**

**内存与性能**:
- `MEMORY PURGE` 现在也把 glibc main arena 的空闲页还给 OS
- 带字段过期的小 hash 改用 listpack 而非一律转 hashtable(#3212)
- radix tree 用 SIMD 优化的 `memchr()` 加速子边查找(#3472)
- `HMGET` / `SMISMEMBER` / `ZMSCORE` 大 hashtable 批量查找重叠内存访问(#4017)
- io-threads 开启时把预取扩展到 hash/set/zset 成员查找(#3940)
- 大 `XTRIM MAXLEN = 0` 一步清空整个流,约 2.5x 提速(#4161)
- 无 propagation/module/invalidation 待办时跳过每命令后置记账(#4257)

---

## 4. 可运行代码:五个实战场景

### 4.1 场景一:forkless 快照的启用与监控(运维)

```bash
# === 第 1 步:确认当前实例的持久化方式 ===
# 在启用前,先看清楚现在用什么
redis-cli -h valkey-01 INFO persistence | grep -E 'rdb_(current|last)_bgsave_type'
# 输出: rdb_last_bgsave_type:fork   ← 还是 fork 模型

# === 第 2 步:评估内存代价 ===
# forkless 每键 +4 字节元数据,先算账
redis-cli -h valkey-01 DBSIZE
# 输出: 85000000  (8500 万键)
# 预期额外内存 = 85_000_000 * 4 bytes = 340_000_000 bytes ≈ 324 MiB

# === 第 3 步:改配置(必须重启,immutable) ===
# 在 valkey.conf 里加两行
#   forkless-infrastructure-enabled yes
#   bgsave-default-method forkless
# 然后重启。注意:重启本身会触发一次 RDB 加载,确认 save point 配置正确

# === 第 4 步:验证 forkless 生效 ===
redis-cli -h valkey-01 INFO persistence | grep -E 'rdb_(current|last)_bgsave_type|forkless'
# 输出:
#   rdb_current_bgsave_type:forkless
#   rdb_last_bgsave_type:forkless

# === 第 5 步:手动触发一次 BGSAVE 并观察进度 ===
redis-cli -h valkey-01 BGSAVE
# Background saving started

# 进度字段与 fork 模式同名,现有监控面板无需改动
redis-cli -h valkey-01 INFO persistence | grep -E 'rdb_bgsave_in_progress|rdb_current_bgsave_time_sec|current_fork_perc|forkless_estimated_seconds_remaining'
# 输出:
#   rdb_bgsave_in_progress:1
#   rdb_current_bgsave_time_sec:17
#   current_fork_perc:63
#   forkless_estimated_seconds_remaining:42

# === 第 6 步:验证 module 兼容性 ===
# 如果加载了 module,forkless 可能自动回退 fork,看日志确认
redis-cli -h valkey-01 MODULE LIST
# 观察日志里是否出现 "fallback to fork" 相关记录
# 若回退,联系 module 作者确认 forkless 兼容性,或暂时保持 fork
```

**生产建议**:先用 `forkless-infrastructure-enabled yes` + `bgsave-default-method fork`(只开基础设施,不改默认方法),观察 4 字节/键的内存开销符合预期后,再切 `bgsave-default-method forkless`。**两步走比一步到位安全**。

### 4.2 场景二:用 Path Hash 构建 KV Cache 放置索引(Python)

这是 Path Hash 的首个目标场景,也是最值得完整实现的一个。

```python
"""
KV Cache 放置索引:把推理 Worker 的 block 缓存事件拍扁进 Valkey Path Hash。
依赖: pip install redis>=5.0  (Valkey 兼容 RESP3 客户端)
"""
import hashlib
import struct
from redis.asyncio import Redis

PAGE_SIZE = 16  # 每个 block 的 token 数,与推理引擎的 page size 对齐
SEGMENT_BYTES = 8  # 每段累积哈希固定 8 字节 BE64 编码


def be64(n: int) -> bytes:
    """把 64 位哈希编码成定长大端字节串。定宽是关键:保证路径不会落在某个哈希的中间。"""
    return struct.pack(">Q", n & 0xFFFFFFFFFFFFFFFF)


def cumulative_hash_path(tokens: list[int]) -> bytes:
    """
    把 prompt 的 token 序列编码成累积哈希路径。
    C1 = Hash(B1); C2 = Hash(C1 || B2); C3 = Hash(C2 || B3) ...
    返回 BE64(C1) || BE64(C2) || BE64(C3),可直接作为 Path Hash 的路径。
    """
    path = b""
    acc = None
    for i in range(0, len(tokens), PAGE_SIZE):
        block = tokens[i : i + PAGE_SIZE]
        acc = hashlib.blake2b(
            (acc or b"") + struct.pack(f">{len(block)}I", *block),
            digest_size=8,
        ).digest()
        path += acc  # blake2b digest_size=8 直接给 8 字节,等价于 BE64
    return path


class PlacementIndex:
    """Worker 侧写入 + Router 侧查询的放置索引。"""

    def __init__(self, valkey: Redis, model_id: str):
        self.vk = valkey
        self.key = f"kv:{{model-{model_id}}}:placement"  # hash tag 保证同 slot

    async def worker_upsert(self, worker_id: str, generation: int,
                            path: bytes, components: int = 0xFFFF):
        """Worker 缓存事件:幂等写入。field=worker_id 天然避免跨 Worker 丢失更新。"""
        value = f"generation={generation},components={components:04x}".encode()
        # 单路径单 field,用 PHSET
        await self.vk.execute_command(
            "PHSET", self.key, path, "FXX", "FIELDS", 1, worker_id.encode(), value
        )

    async def bridge_batch_upsert(self, events: list[tuple[bytes, str, int]]):
        """Event Bridge 批量写入:一次 PHMSET 搞定多路径,省网络往返。"""
        args = ["PHMSET", self.key]
        for path, worker_id, gen in events:
            value = f"generation={gen}".encode()
            args += [path, "FIELDS", 1, worker_id.encode(), value]
        await self.vk.execute_command(*args)

    async def router_query(self, query_path: bytes,
                           healthy_workers: list[str] | None = None):
        """
        Router 查询:一次 PHPREFIXES 拿回全部祖先前缀。
        返回 {worker_id: 连续命中页数}。
        """
        args = ["PHPREFIXES", self.key, query_path, "LENGTHS"]
        if healthy_workers:
            # FIELDS 过滤只取关心的 worker,减少响应体积
            args += ["FIELDS", len(healthy_workers)] + healthy_workers
        else:
            args += ["WITHVALUES"]
        # COUNT 是硬上限;MAXLEN 限制最长路径,先粗后细
        args += ["COUNT", "64", "MAXLEN", len(query_path)]

        rows = await self.vk.execute_command(*args)
        # rows 形如: [[8, [field, value, ...]], [16, [...]], ...]
        best: dict[str, int] = {}
        for length_bytes, fields_payload in rows:
            pages = length_bytes // SEGMENT_BYTES
            it = iter(fields_payload)
            for field in it:
                value = next(it)
                if value is None:
                    continue
                worker = field.decode() if isinstance(field, bytes) else field
                # 只保留每个 worker 的最深连续命中
                if worker not in best:
                    best[worker] = pages
        return best


async def demo():
    vk = Redis(host="valkey-01", port=6379, decode_responses=False)
    idx = PlacementIndex(vk, model_id="qwen3-32b")

    # ---- Worker 侧:三个 block 的 prompt,两个 Worker 各自缓存 ----
    tokens = list(range(48))  # 48 tokens = 3 pages
    q = cumulative_hash_path(tokens)
    p1, p2, p3 = q[0:8], q[0:16], q[0:24]

    await idx.worker_upsert("worker-a", generation=7, path=p1)
    await idx.worker_upsert("worker-a", generation=7, path=p2)
    await idx.worker_upsert("worker-b", generation=3, path=p1)
    await idx.worker_upsert("worker-b", generation=3, path=p2)
    await idx.worker_upsert("worker-b", generation=3, path=p3)

    # ---- Router 侧:一次查询拿回全部祖先 ----
    hits = await idx.router_query(q, healthy_workers=["worker-a", "worker-b"])
    print("命中:", hits)
    # {'worker-a': 2, 'worker-b': 3}  ← worker-b 命中更深

    # 应用层结合负载做最终路由(最大缓存命中 ≠ 最优 worker)
    # 路由到 worker-b,因为它有 3 页连续命中,且当前负载可接受

    # ---- generation 兜底:worker-b 重启后旧 generation 记录不参与路由 ----
    await idx.worker_upsert("worker-b", generation=4, path=p3)
    hits2 = await idx.router_query(q)
    # 旧 generation=3 记录被新写入覆盖(同 field),假阳性窗口被关闭

    await vk.aclose()


# 对比:应用层拆解方案要发多少请求?
# 深度 128 的路径,逐前缀 HGET = 128 次网络往返
# Path Hash = 1 次 PHPREFIXES。往返数从 O(L) 降到 O(1)。
```

### 4.3 场景三:ACL 角色化的完整落地(bash + 审计)

```bash
#!/usr/bin/env bash
# ACL 角色化:把 120 个微服务用户的权限矩阵收敛成 3 个角色
set -euo pipefail
VK="redis-cli -h valkey-01 -a ${VK_PASSWORD} --user acl-admin"

# ---- 第 1 步:定义角色(命名 selector 集合,可复用) ----
$VK ACL SETROLE domain-billing \
  "(+@read +@write (~billing:*))(+@read (~billing:shared:*))"
$VK ACL SETROLE domain-readonly "(+@read (~billing:*))"
$VK ACL SETROLE platform-ops "(+@all (-@dangerous (~ops:*)))"

# ---- 第 2 步:批量给用户分配角色 ----
for i in $(seq 1 40); do
  $VK ACL SETUSER "svc-billing-${i}" on ">$(openssl rand -hex 16)" role:domain-billing
done
for i in $(seq 1 40); do
  $VK ACL SETUSER "reporting-job-${i}" on ">$(openssl rand -hex 16)" role:domain-readonly
done

# ---- 第 3 步:验证 ----
$VK ACL GETROLE domain-billing
$VK ACL ROLES | head -5

# ---- 第 4 步:权限漂移检测(配置管理的关键) ----
# ACL LOAD 之后跑 DIGEST,与配置仓库里的期望指纹比对
$VK ACL LOAD
ACTUAL_DIGEST=$($VK ACL DIGEST)
echo "actual: ${ACTUAL_DIGEST}"
# 在 CI 里:if [ "$ACTUAL_DIGEST" != "$EXPECTED_DIGEST" ]; then exit 1; fi

# ---- 第 5 步:回滚(角色改了,用户引用自动跟随) ----
# 业务域拆分,billing 域只读一周
$VK ACL SETROLE domain-billing "(+@read (~billing:*))"
# 40 个 svc-billing-* 用户全部降级为只读,改 1 处而非 40 处
```

**与 9.2 之前对比**:权限矩阵变更的影响半径从「N 个用户」收敛到「1 个角色」。这是把**变更爆炸**降级为**单点变更**。

### 4.4 场景四:后量子双证书的混合期部署(Go 客户端)

```go
package main

// 后量子混合期:服务器挂 ML-DSA + RSA 双证书,客户端按能力握手。
// 依赖: go get github.com/redis/go-redis/v9
import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"os"

	"github.com/redis/go-redis/v9"
)

func newPQClient(addr string) *redis.Client {
	caPEM, _ := os.ReadFile("/etc/valkey-ca/ml-dsa-ca.pem")
	caPool := x509.NewCertPool()
	caPool.AppendCertsFromPEM(caPEM)

	return redis.NewClient(&redis.Options{
		Addr: addr,
		TLSConfig: &tls.Config{
			// 指定后量子 CA,服务器会据此选 ML-DSA 证书
			RootCAs:            caPool,
			MinVersion:         tls.VersionTLS13,
			InsecureSkipVerify: false,
			// 生产环境应校验 ServerName,这里保持默认
		},
	})
}

func newLegacyClient(addr string) *redis.Client {
	// 只支持 RSA 的遗留客户端:连同一个端口,带传统 CA
	caPEM, _ := os.ReadFile("/etc/valkey-ca/rsa-ca.pem")
	caPool := x509.NewCertPool()
	caPool.AppendCertsFromPEM(caPEM)

	return redis.NewClient(&redis.Options{
		Addr: addr,
		TLSConfig: &tls.Config{
			RootCAs:    caPool,
			MinVersion: tls.VersionTLS12,
		},
	})
}

func main() {
	// 同一个 Valkey 端点,两种客户端能力并存
	pq := newPQClient("valkey-01:6379")
	legacy := newLegacyClient("valkey-01:6379")

	ctx := context.Background()

	// 后量子客户端:走 ML-DSA 握手
	if err := pq.Set(ctx, "pq:probe", "ml-dsa", 0).Err(); err != nil {
		fmt.Printf("PQ 握手失败: %v\n", err)
	} else {
		fmt.Println("PQ 握手成功")
	}

	// 遗留客户端:走 RSA 握手,服务零中断
	if v, err := legacy.Get(ctx, "pq:probe").Result(); err != nil {
		fmt.Printf("legacy 握手失败: %v\n", err)
	} else {
		fmt.Printf("legacy 握手成功,读到 %q\n", v)
	}
	// 两类客户端共存,迁移期可灰度切换
}

---

### 4.5 场景五:Stream 的确认即删除(Python,订单履约)

`XACKDEL` 解决的是「处理完就该清理」的消费组场景 —— 订单履约、消息派发、任务队列。

```python
"""
订单履约消费组:XACKDEL 一步完成「确认 + 清理」。
依赖: pip install redis>=5.0
"""
import asyncio
import json
import time
from redis.asyncio import Redis

STREAM = "orders:fulfillment"
GROUP = "fulfillment-workers"
CONSUMER = "worker-01"


async def ensure_group(vk: Redis):
    """消费组不存在则创建。id=0 表示从头消费历史消息。"""
    try:
        await vk.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
    except Exception as e:
        if "BUSYGROUP" not in str(e):
            raise


async def produce_orders(vk: Redis, n: int = 200):
    """模拟订单事件入流。"""
    pipe = vk.pipeline(transaction=False)
    for i in range(n):
        pipe.xadd(
            STREAM,
            {
                "order_id": f"ORD-{i:05d}",
                "amount": f"{19.99 + i * 0.5:.2f}",
                "ts": str(time.time()),
            },
            maxlen=10000,  # 流容量上限,配合 XACKDEL 做双层防堆积
        )
    await pipe.execute()


async def consume_once(vk: Redis, batch: int = 32) -> int:
    """
    拉取一批消息,处理,然后用 XACKDEL 原子地确认并删除。
    对比旧做法(先 XACK 再 XDEL):省一半往返,且无非原子窗口。
    """
    entries = await vk.xreadgroup(
        groupname=GROUP,
        consumername=CONSUMER,
        streams={STREAM: ">"},  # '>' 表示「只取从未投递过的消息」
        count=batch,
        block=2000,  # 阻塞 2 秒等新消息,避免空转
    )
    if not entries:
        return 0

    ids = []
    for _stream, messages in entries:
        for msg_id, _fields in messages:
            ids.append(msg_id)
            # ---- 这里做实际业务:调用履约服务、扣库存、发通知 ----
            # 示例只打印,生产环境应当幂等(消息可能被重复投递)

    # 一步原子确认 + 删除。DELREF:确认并删除消息和引用
    if ids:
        await vk.execute_command(
            "XACKDEL", STREAM, GROUP, "DELREF", *ids
        )
    return len(ids)


async def inspect_pel(vk: Redis) -> int:
    """待处理消息(PEL)堆积量 —— XACKDEL 之前这是持续增长的指标。"""
    info = await vk.xpending(STREAM, GROUP)
    return info["pending"]


async def demo():
    vk = Redis(host="valkey-01", port=6379, decode_responses=True)
    await ensure_group(vk)
    await produce_orders(vk, n=200)

    total = 0
    for _round in range(10):
        got = await consume_once(vk)
        total += got
        pel = await inspect_pel(vk)
        print(f"本批 {got} 条,累计 {total} 条,PEL 堆积 {pel} 条")
        # XACKDEL 之后 PEL 立即归零;旧做法 XACK 不删消息时 PEL 清了但流体积还在
        if got == 0:
            break

    # 流的长度:配合 maxlen=10000 + XACKDEL,稳态下流体积 ≈ 处理窗口大小
    length = await vk.xlen(STREAM)
    print(f"流当前长度: {length}")
    await vk.aclose()


# asyncio.run(demo())
```

**三种模式的选型**:

| 模式 | 何时用 | 典型场景 |
|------|--------|----------|
| `KEEPREF` | 确认+删消息体,保留引用(审计/回溯) | 金融交易、合规留痕 |
| `DELREF` | 确认+删消息和引用(彻底清理) | 普通任务队列、事件派发 |
| `ACKED` | 只处理已确认消息 | 回放审计、对账 |

---

## 5. 性能对比:Valkey 9.2 vs Redis 8.10 vs Dragonfly 2.0 vs Garnet

对比口径说明:下表是**架构能力的定性对比 + 已公开的量化数据点**,不是我在同一台机器上跑的 benchmark。带具体数字的格子来自各项目 release notes / 官方文档;能力维度的判断基于各版本公开的命令支持矩阵。**实际选型请在你自己的负载上压测。**

| 维度 | Valkey 9.2.0-rc1 | Redis 8.10.2 | Dragonfly v2.0.0 | Garnet |
|------|------------------|--------------|------------------|--------|
| **发布时间** | 2026-09-16 | 2026-09-17 | 2026-09-16 | 2025 年 |
| **许可证** | BSD-3-Clause | RSALv2/SSPLv1(非 OSI 开源) | BSL 1.1(源码可用) | MIT |
| **线程模型** | 单线程命令 + io-threads | 单线程命令 + io-threads | **多线程(每核一个 proactor)** | 分片多线程 |
| **forkless RDB** | ✅ bgsave-default-method forkless | ❌ 仍 fork | ❌ 使用快照但非 forkless | ❌ |
| **Path Hash / 前缀索引类型** | ✅ 12 条 PH 命令 + rax 前缀遍历 | ❌ | ❌ | ❌ |
| **ACL 角色(SETROLE/DELROLE)** | ✅ | ❌ 只有内联 selector | 部分 | ❌ |
| **后量子双证书(tls-alt-cert)** | ✅ ML-DSA + RSA 并行 | 部分 | ❌ | ❌ |
| **有序集合底层** | **B+ tree**(大集合) | skiplist | DashTable | skiplist |
| **流确认即删除** | ✅ XACKDEL/XDELEX | ❌ XACK/XDEL 分离 | 部分 | ❌ |
| **热键检测** | ✅ 内置 HOTKEYS 命令 | 部分 | ✅ | ❌ |
| **RDB 压缩** | LZF 默认 + **LZ4 可选** | LZF | 自有 | LZF |
| **复制压缩** | ✅ repl-compression LZ4(按 replica 协商) | ❌ | 自有 | ❌ |
| **连接优先级保留** | ✅ priority-subnets + maxclients-reserved | ❌ | ❌ | ❌ |
| **复制限流保护** | ✅ repl-throttling-enabled | ❌ | 自有 backlog 控制 | ❌ |
| **RESP3** | ✅ | ✅ | ✅(有正确性修复) | ✅ |
| **Vector set / 向量搜索** | ❌(9.2 未含) | ✅(8.x 有) | ❌ | ❌ |
| **集群** | ✅ Cluster + 同步迁移 | ✅ Cluster | ✅ | ✅(分片) |
| **生态成熟度** | 高(Redis 客户端全兼容) | 最高 | 中(快速增长) | 中(微软生态) |

**关键洞察 3:** 这张表里最值得注意的不是任何一格,而是 **Path Hash 这一行只有 Valkey 有**。Redis 8.10 在同一周发布(2026-09-17),但它没有等价能力。**这是 Redis 分叉两年后,Valkey 第一次在数据类型层面做出了上游没有的东西** —— 之前 Valkey 的卖点一直是「开源协议 + 兼容性」,9.2 开始它有了自己的差异化能力。

**关于 Dragonfly 的定位**:v2.0.0(2026-09-16,与 Valkey 9.2 同一天)的核心卖点是**多线程架构带来的单实例高吞吐**,以及 Valkey 9 RDB 加载兼容。它甚至能加载 Valkey 9 的 RDB —— 说明它把自己定位成 Valkey/Redis 的**替代品**而非互补品。但它的 BSL 1.1 许可证对「云厂商转售」场景有约束,选型时法务要过一遍。

**关于性能数字的诚实说明**:我没有在同一台机器上跑四者的 benchmark。Valkey 9.2 release notes 给出的量化点都是**相对自身的改进**(如 XTRIM MAXLEN = 0 约 2.5x、radix tree SIMD、大 hashtable 批量查找),而不是对竞品的横向数字。横向对比请认准你自己的负载特征:**重集合操作 + 大内存实例选 Valkey 9.2;极致单实例吞吐、不在意许可证选 Dragonfly;需要向量搜索选 Redis 8.x 或专门向量库**。

---

## 6. 6 条 6-12 个月可验证的硬指标

每条都是**今天就能跑代码复现**的,不是画饼。

### 指标 1:forkless 下 BGSAVE 的峰值 RSS 增量

```bash
# 启用 forkless 前后,在相同负载下观察 BGSAVE 期间的 RSS 峰值
while true; do
  echo "$(date +%s) $(redis-cli INFO memory | grep used_memory_rss | cut -d: -f2)" >> /tmp/rss.log
  sleep 1
done
# 在另一个终端触发 BGSAVE,抓峰值
redis-cli BGSAVE
# 指标:forkless 下 RSS 峰值增量应接近 0;fork 模式下增量约为 save 期间被写页数乘 4KiB(或 2MiB,若 THP=always)
```
**验证标准**:forkless 模式下,BGSAVE 期间 RSS 曲线与基线基本重合。这是「持久化内存开销常量化」的直接证据。

### 指标 2:fork() 调用本身的耗时(大实例)

```bash
# 用 strace 抓 fork 的纳秒耗时(需要 root 或 ptrace 权限)
# 大实例(fork 在 512GB RSS 上可能 800-1500ms)
strace -f -e trace=fork -T -p $(pgrep valkey-server | head -1) 2>&1 | head -5
# 或用 bpftrace(更准,生产环境推荐 eBPF 而非 strace)
# bpftrace -e 'tracepoint:syscalls:sys_enter_fork { @start = nsecs } tracepoint:syscalls:sys_exit_fork { printf("fork %llu ms\n", (nsecs-@start)/1000000) }'
```
**验证标准**:fork 模式下,大实例的 fork 耗时应与 RSS 正相关;切到 forkless 后 `rdb_current_bgsave_type:forkless` 时**根本没有 fork 系统调用**。BGSAVE 期间客户端 P99 延迟不再出现周期性尖峰。

### 指标 3:Path Hash 的 PHPREFIXES 尾延迟

```python
# 压力测试:构造深度 128 的路径,对比「PHPREFIXES 一次」vs「128 次 HGET」
import asyncio, time, statistics
from redis.asyncio import Redis

async def bench(vk, depth=128):
    path = (b"0123456789abcdef" * 64)[:depth*8]  # 模拟 128 段路径
    # 先写入若干祖先前缀
    for i in range(1, depth+1, 8):
        await vk.execute_command("PHSET", "bench:ph", path[:i*8], "FIELDS", 1, b"w", b"v")

    lat_1 = []
    for _ in range(200):
        t = time.perf_counter_ns()
        await vk.execute_command("PHPREFIXES", "bench:ph", path, "LENGTHS", "COUNT", "64")
        lat_1.append(time.perf_counter_ns()-t)

    lat_n = []
    for _ in range(50):
        t = time.perf_counter_ns()
        for i in range(1, depth+1):
            await vk.execute_command("HGET", "bench:h", path[:i*8])
        lat_n.append(time.perf_counter_ns()-t)

    print(f"PHPREFIXES P50={statistics.median(lat_1)/1e6:.2f}ms P99={sorted(lat_1)[198]/1e6:.2f}ms")
    print(f"128xHGET  P50={statistics.median(lat_n)/1e6:.2f}ms P99={sorted(lat_n)[49]/1e6:.2f}ms")

asyncio.run(bench(Redis(host="valkey-01")))
```
**验证标准**:深度 128 时,PHPREFIXES 的 P99 应比 128 次 HGET 快一到两个数量级 —— 因为它把 128 次网络往返压成 1 次,且服务端只遍历查询路径一次。**注意:差距主要来自网络往返数,不是单机 CPU**。

### 指标 4:有序集合 B+ tree 的范围扫描吞吐

```bash
# 构造 500 万元素的 zset,跑 ZRANGE 范围扫描
# 用 valkey-benchmark 的 CSV 加载 + __field__ 占位符(9.2 新功能)
# 先准备 members.csv: 两列 score,member
./valkey-benchmark -h valkey-01 -n 5000000 -r 5000000 \
  "ZADD zset:big __field:score__ __field:member__" \
  --data-file members.csv

# 范围扫描吞吐(取中间 10%)
./valkey-benchmark -h valkey-01 -n 100000 -c 50 "ZRANGE zset:big 500000 550000"
# 对比 9.0/9.1(skiplist)同样负载下的 QPS 与 P99
# 指标:B+ tree 下 ZRANGE 大范围扫描的 QPS 应有可测量提升,P99 更稳
```
**验证标准**:同一负载下 9.2 的 `ZRANGE` 中等/大范围扫描吞吐高于 9.1,且 `OBJECT ENCODING zset:big` 返回 `btree`。

### 指标 5:ACL 角色化后的配置变更影响半径

```bash
# 指标:把 billing 域 40 个用户从「读写」改成「只读」需要的命令数
# 9.2 之前:40 条 ACL SETUSER
# 9.2:1 条 ACL SETROLE
time redis-cli -h valkey-01 ACL SETROLE domain-billing "(+@read (~billing:*))"
# 验证全部 40 个用户权限已跟随变更
redis-cli -h valkey-01 ACL LIST | grep -c 'role:domain-billing'   # 期望 40
```
**验证标准**:单次角色变更后,引用该角色的全部用户权限立即变化;`ACL DIGEST` 反映新状态。这是把**变更爆炸降级为单点变更**的直接度量。

### 指标 6:复制限流避免全量同步的次数

```bash
# 在 replica 上观察:启用 repl-throttling-enabled 前后,每小时的 full sync 次数
redis-cli -h replica-01 INFO replication | grep -E 'sync_full|sync_partial_ok|lag'
# 指标:主从延迟拉大时,full_sync 次数应下降,代价是主库写入吞吐轻微下降
# 在主库监控:repl-throttling 触发期间的 ops/s 降幅
```
**验证标准**:在「replica 落后 -> 断连 -> 全量同步」的复现负载下,开启限流后 `sync_full` 计数增长显著放缓,`sync_partial_ok` 增长上升。**代价是主库吞吐的轻微下降** —— 这是有意权衡,用降速换数据通路连续性。

---

## 7. 6 条 6-12 个月可观察的未来信号

### 信号 1:forkless 从 opt-in 走向默认(高概率)

9.2 里 forkless 默认关闭,且 `forkless-infrastructure-enabled` 是 immutable。这是新持久化路径应有的谨慎。**观察点**:9.4/9.6 是否把默认改成 `forkless`,以及是否把 immutable 改成可热切换(需要键级元数据的在线迁移能力)。**如果默认开启,fork 模型就进入了事实退休期**,「缓存实例必须为 COW 预留 50% 内存」这个运维教条会逐渐消失。

### 信号 2:Path Hash 的第二个杀手级用例

首个用例是 KV Cache 放置索引,但前缀匹配的适用域极广:**DNS 查找、路由表最长前缀匹配、权限继承树、文件系统路径索引、autocomplete**。**观察点**:6-12 个月内是否出现 Path Hash 的非 AI 用例库(比如 Kong/APISIX 之类的网关拿它做路由表,或 DNS 权威服务器拿它做 zone 索引)。**如果出现,Path Hash 就从「AI 推理特化类型」升级为「通用基础设施类型」。**

### 信号 3:PHDELPREFIX 的非阻塞化

v1 的 `PHDELPREFIX` 同步删除整个子树,删大树会阻塞主线程。设计文档明确留了未来路径:**给 rax 加 subtree-detach,把分离节点交给 lazy-free 线程**。**观察点**:9.4 是否实现。这直接决定 Path Hash 能不能用于「大范围前缀淘汰」的高频场景。

### 信号 4:Path Hash 的 TTL 与 Cluster 跨键查询

v1 明确写了两个 Non-Goal:**不提供单个路径的独立 TTL**(TTL 只在顶级键),**不做跨多个 Valkey 键的全局 Path Hash**。**观察点**:9.4/9.6 是否放松这两条。路径级 TTL 对「缓存放置索引的自动过期」几乎是刚需 —— 现在必须应用层跑后台 `PHSCAN` 清理。**如果加了路径级 TTL,Path Hash 的自管理能力会上一个台阶。**

### 信号 5:Valkey 与 Redis 的能力分化加速

Redis 8.10 的差异化在 **vector set**(向量搜索);Valkey 9.2 的差异化在 **Path Hash**(前缀索引)。**两者在解决不同的问题**:Redis 押注「AI 语义检索」,Valkey 押注「AI 推理基础设施的协调平面」。**观察点**:Redis 是否在后续版本补前缀索引类型,或 Valkey 是否补向量类型。**谁先补对方的短板,谁就拿到「既能做语义检索又能做前缀索引」的全栈位置。**

### 信号 6:后量子迁移在状态存储层的完成度

`tls-alt-cert-file` 双证书是混合期方案。**观察点**:6-12 个月内,主流 Valkey/Redis 客户端默认开启 ML-DSA 的比例;云厂商(ElastiCache / MemoryDB / 阿里云 Tair)何时提供「仅后量子」模式。**状态存储是最后迁移的一批基础设施**(因为它要求零中断),所以它是后量子迁移完成度的**滞后指标**。

---

## 8. 总结与最佳实践

### 8.1 该用 Valkey 9.2 的场景

✅ **大内存实例(64GB 以上)** —— forkless 消除 COW 不确定性,容量规划从「猜」变成「算」
✅ **AI 推理平台的 KV Cache 放置索引** —— Path Hash 是目前唯一服务端原生的解法
✅ **权限矩阵规模大(50+ 用户)、变更频繁** —— ACL 角色化把变更影响半径降到 1
✅ **后量子合规要求(金融/政府/医疗)** —— 双证书让迁移期零中断
✅ **重 Stream 消费组负载,PEL 堆积是痛点** —— XACKDEL 一步确认+删除
✅ **跨 AZ/跨地域复制带宽敏感** —— LZ4 复制压缩按 replica 协商

### 8.2 千万别用的场景

❌ **别在生产上直接跑 9.2.0-rc1** —— 它是 release candidate。等 9.2.0 GA 或第一个 patch release(9.2.1)
❌ **别在 9.2.0-rc1 上用 Path Hash 存不可重建的关键数据** —— 新数据类型 + rc 阶段 = 高风险。Path Hash 设计文档自己说了「放置索引一般是可重建的软状态」
❌ **别用 PHDELPREFIX 删巨大前缀子树** —— 同步删除阻塞主线程。用 PHSCAN + 分批 PHDEL 自己控制节奏
❌ **别假设 PHPREFIXES 的 COUNT 是 hint** —— 它是硬上限,且超限保留**最深**的 count 条。想要全部就别传 COUNT
❌ **别在 Path Hash 里依赖路径级 TTL** —— v1 没有,TTL 只在顶级键。应用层自己做后台清理
❌ **别硬编码 OBJECT ENCODING 等于 skiplist** —— 9.2 大 zset 报 btree。用能力判断,不用编码字符串判断
❌ **别 CONFIG SET forkless-infrastructure-enabled yes** —— immutable,只能启动时配,这条命令会报错
❌ **别在 9.2.0-rc1 上对关键业务流启用 XACKDEL** —— 与上同理,等 GA

### 8.3 5 步生产迁移 checklist

**第 1 步:预发环境验证 forkless**
```bash
# 在预发实例上开启基础设施,观察 4 字节/键的内存开销
# forkless-infrastructure-enabled yes  (需重启)
# 暂时保持 bgsave-default-method fork
redis-cli DBSIZE   # 算出预期额外内存
# 观察 48 小时:内存曲线、BGSAVE 行为、module 兼容性
```

**第 2 步:切换默认快照方法**
```bash
# 预发验证 OK 后,切方法(这个可以 CONFIG SET,不用重启)
redis-cli CONFIG SET bgsave-default-method forkless
# 触发一次 BGSAVE,确认 rdb_current_bgsave_type:forkless
redis-cli BGSAVE && sleep 20 && redis-cli INFO persistence | grep bgsave_type
# 关键:验证 RDB 文件可正常加载(在备用实例上 restore)
```

**第 3 步:ACL 角色化(先读后写)**
```bash
# 先导出当前 ACL,规划角色
redis-cli ACL LIST > /tmp/acl-before.txt
# 设计角色:按业务域分组,识别可复用的 selector 集合
# 在预发上 SETROLE + 给 1 个试点用户分配 role:
# 验证试点用户的权限行为与之前内联 selector 完全一致
```

**第 4 步:Path Hash 的渐进采用**
```bash
# 先在「可重建的软状态」场景上用 —— 放置索引、路由表缓存
# 不要先在关键业务数据上用
# 做好失败兜底:value 里带 generation,假阳性用 generation 兜底
# 做好重建路径:Worker snapshot 对账 + 重放,验证索引可从源数据重建
```

**第 5 步:后量子双证书的灰度**
```bash
# 1. 服务器挂双证书(ML-DSA + RSA)
# 2. 先让 5% 客户端用 PQ CA 握手,观察握手成功率与延迟
# 3. 逐步提升 PQ 客户端比例
# 4. 监控 INFO server 的 tls_server_cert_serial / expiry,两个证书都看
# 5. 确认全部客户端支持 PQ 后,才考虑下掉 RSA 证书
```

### 8.4 5 条最佳实践

1. **把「不可预测的量」变成「常量」** —— forkless 的核心价值不是省内存,是把 COW 从运行时变量变成配置时常量。**任何架构改动如果能把运维的关键不确定量常量化,都是承重级改动**

2. **把「两步操作」合并成「一步原子操作」** —— XACKDEL 合并 XACK+XDEL;PHMSET 合并多个 PHSET;Path Hash 的 field map 把「读-改-写」变成「单 field 写」。**9.2 的设计主旋律就是消灭应用层的非原子窗口**

3. **把冲突粒度降到最小** —— Path Hash 每个路径挂 field/value map 而不是单值,是为了把并发冲突从「路径级」降到「field 级」。**在设计共享状态时,「冲突粒度」是一个被低估的一等设计维度**

4. **为假阳性设计兜底,而不是假设强一致** —— Path Hash 放置索引明确接受异步复制的 RPO,但要求 value 带 generation 让假阳性单向安全失败。**「接受弱一致 + 为危险方向设计兜底」比「假设强一致」更工程化**

5. **新核心路径默认关闭,immutable 开关** —— forkless 默认 no,且基础设施开关不可热切换。**这是核心路径改动的正确节奏:先让愿意吃螃蟹的人验证,再谈默认**

---

## 写在最后

Valkey 9.2.0-rc1 的历史位置值得单独说一句。

2024 年 3 月 Redis 改开源协议时,Valkey 的诞生带着明显的「被迫应急」色彩 —— 它是 Redis 7.2.4 的快照,前几个版本主要做的是**追平上游 + 修分叉后的社区治理**。那时候选 Valkey 的理由只有两个:许可证和「Redis 的平替」。

**9.2 改变了这个叙事。** Path Hash 是上游 Redis 没有的数据类型,而且它瞄准的是一个真实的、被应用层代码反复重发的问题 —— 分布式 KV Cache 的放置索引。forkless 则动了 Redis 十几年没动的持久化模型。加上 ACL 角色化和后量子双证书,Valkey 9.2 第一次让你「因为它的能力」而不是「因为它的许可证」选择它。

**与今天早间的 AI 日报形成互补**:早间那条日报的核心叙事是「AI 从回答走向自主流程」—— Claude 950 agent 21 小时跑 2.1 亿 token、Muse 数字分身无人值守、Shopify 代理购物。**这些自主流程的底下,全都需要一个「低延迟、可共享、可恢复的协调平面」** —— Agent 要知道自己跑到了哪一步(前缀),要知道某个能力缓存在哪个 Worker(放置索引),要在崩溃后从检查点恢复(路径)。**Path Hash 服务的正是自主流程的「状态共享层」**:它把「我在流程的哪个前缀位置」和「谁缓存了这个前缀」变成了服务端一次 O(L+K) 的查询。

这也许是 9.2 最重要的意义:**Valkey 正在从「缓存数据库」演变成「AI 推理与 Agent 编排的协调平面」**。forkless 让大内存实例的持久化不再是赌博;Path Hash 让分布式的放置决策有了原生的数据结构。当一个内存数据库开始为 AI 推理的内存层级(KV Cache)设计专用类型时,它已经不只是 Redis 的替代品了。

**6-12 个月后回来验收**:forkless 是否默认开启、Path Hash 是否出现非 AI 杀手级用例、Valkey 与 Redis 的能力分化是否继续拉大。这三条信号决定 9.2 是「一次不错的迭代」还是「一个品类的起点」。

---

**数据来源**:Valkey 9.2.0-rc1 release notes(GitHub valkey-io/valkey)、Path Hash 设计提案 PR #4506、Forkless Save PR #4460 及其 9 个子 PR、Redis 8.10.2 / Dragonfly v2.0.0 release notes。所有命令语法与时序复杂度均引自上述一手文档;本文未在任何云实例上运行实际 benchmark,量化结论以「相对自身改进」为准,横向选型请自行压测。
