---
title: "416 颗星拆解 PgDog：$5.5M 融资、12 个 Rust crate、1451 个文件，一个 3 人团队要把 PostgreSQL 池/分片代理重做一遍凭什么"
date: 2026-06-11
category: 技术
tags: [PgDog, PostgreSQL, Rust, 连接池, 分片, 负载均衡, Tokio, pg_query, AGPL, Vitess, Citus, PgBouncer, 数据库, 数据库代理, YC, Basis Set]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1639762681485-074b7f938ba0?w=600&h=400&fit=crop
---

# 416 颗星拆解 PgDog：$5.5M 融资、12 个 Rust crate、1451 个文件，一个 3 人团队要把 PostgreSQL 池/分片代理重做一遍凭什么

6 月 10 日，HN 首页出现一条 416 pts / 207 评论的融资公告：**PgDog is funded and coming to a database near you**。作者 levkk 自提交，标题直白，技术圈却集体亢奋——评论区出现 "Why Us" 段里那段把 Instacart 五年内 5x 流量峰值挂在 PG 上的经历、PgBouncer 三个老坑（pool exhaustion、客户端死连接、`SET` 语句）、以及 "应该把 PG 分片逻辑 upstream 化" 的产业级疑问。

这是一篇典型的"非爆款高分帖"：单点 416pts 在 HN 不算顶流，但评论区密度和工程质量足以让关注 PostgreSQL 生态的工程师读 30 分钟。比起 Bun 那种 2000+ pts 的"事件型爆款"，PgDog 这条更接近"产业级工具的产业级融资"——值得当作案例来拆。

## 一、PgDog 究竟是什么——不是又一款 PgBouncer

> "PgDog is a proxy for scaling PostgreSQL. It supports connection pooling, load balancing queries and sharding entire databases. Written in Rust, PgDog is fast, secure and can manage thousands of connections on commodity hardware."

把这句话拆开看，PgDog 同时承担三层职责：

1. **Connection pooler**（连接池）：替代 PgBouncer，把客户端成千上万的连接复用为后端几十个真实连接。
2. **Layer-7 load balancer**（应用层负载均衡）：解析 PostgreSQL wire protocol，把写操作路由到 primary，读操作路由到 replica。
3. **Sharding router**（分片路由器）：解析 SQL 提取 sharding key，自动把查询路由到对应分片，并处理跨分片查询、两阶段提交、shard key 更新、COPY 数据切分等复杂场景。

三层合一的设计哲学在 2026 年的开源世界里相当罕见。PgBouncer 干好第一层，HAProxy 干好第二层（但只到 TCP 4 层），Citus 把第三层塞进 PG 内核扩展，Vitess 把第二、三层绑在 MySQL 上。**把三层用一种语言、一个进程、一套配置同时干完**——这是 PgDog 的赌注。

## 二、$5.5M 背后的硬数字：12 个 crate、1451 个文件、AGPL-3.0

融资细节（来自 levkk 的 HN 自述）：

- **金额**：$5.5M
- **领投**：Basis Set
- **跟投**：Y Combinator、Pioneer Fund
- **团队**：3 人全职
- **运行时间**：约 18 个月（GitHub 仓库创建于 2024-12-27）

仓库当下的硬指标（截至 2026-06-11）：

| 指标 | 数值 | 含义 |
|------|------|------|
| Stars | 4716 | 已超过 PgBouncer（~2.5k）一个数量级 |
| Forks | 191 | 真正的企业级派生热度 |
| 文件总数 | 1451 | 远超"工具型"项目 |
| Workspace crates | 12 | pgdog, pgdog-config, pgdog-macros, pgdog-plugin, pgdog-postgres-types, pgdog-stats, pgdog-vector, plugins/pgdog-example-plugin, plugins/pgdog-primary-only-tables 等 |
| 核心 parser.rs | 107.8 KB | 把 pg_query 包装成自己的 statement 抽象层 |
| License | AGPL-3.0 | 关键，下文展开 |

Cargo.toml 的 workspace 结构（节选）：

```toml
[workspace]
resolver = "2"
exclude = ["fuzz"]
members = [
  "examples/demo",
  "integration/rust",
  "integration/two_pc_crash_safety/wal_helper",
  "pgdog",
  "pgdog-config",
  "pgdog-macros",
  "pgdog-plugin",
  "pgdog-postgres-types",
  "pgdog-stats",
  "pgdog-vector",
  "plugins/pgdog-example-plugin", "plugins/pgdog-primary-only-tables",
  "scripts/*",
]

[workspace.package]
edition = "2024"
```

值得注意的几个工程细节：

- **`edition = "2024"`**：紧跟 Rust 2024 edition，6 月 9 日有专门 PR #1044 "Update to Rust 2024"。
- **`lto = true; codegen-units = 1`**：release 启用 LTO + 单 codegen unit，给了单二进制 < 5MB 的底气。
- **Tokio + bytes crate**：避免不必要堆分配，README 明说"profile for performance regressions on a regular basis"。
- **集成测试巨多**：`integration/` 目录下 467 个文件——一个工具项目集成测试比源码还多，**意味着他们把 PgBouncer/Postgres/MySQL 各版本兼容都跑过一遍**。

## 三、它能干什么——三层能力的真实代码示例

### 3.1 连接池（替代 PgBouncer）

`pgdog.toml` 的最小配置：

```toml
[general]
port = 6432
default_pool_size = 10

[[databases]]
name = "pgdog"
host = "127.0.0.1"
```

`users.toml`：

```toml
[[users]]
name = "alice"
database = "pgdog"
password = "hunter2"
```

与 PgBouncer 的**关键差异**（README 原文）：

> "Unlike PgBouncer, PgDog can parse and handle `SET` statements and startup options, ensuring session state is set correctly when sharing server connections between clients with different parameters."

> "PgDog also has more advanced connection recovery options, like automatic abandoned transaction rollbacks and connection re-synchronization to avoid churning server connections during an application crash."

这恰好命中 HN 评论里 `welder` 提到的三个老坑：

> "1. pool exhaustion from idle connections inside open long-running transactions
> 2. SQLAlchemy's client-side pool using dead connections that PgBouncer had already killed, causing periodic request errors
> 3. Some tasks have to bypass PgBouncer when they use SET or prepared statements"

### 3.2 负载均衡（写主读从）

```toml
[[databases]]
name = "prod"
host = "10.0.0.1"
role = "primary"

[[databases]]
name = "prod"
host = "10.0.0.2"
role = "replica"
```

魔法在于：PgDog 用 `pg_query`（PostgreSQL 原生解析器的 Rust 绑定）解析 SQL，**自动识别写操作发到 primary、读操作发到 replica**。应用代码无需改。

事务里也可以显式指定只读：

```sql
BEGIN READ ONLY;
-- This goes to a replica.
SELECT * FROM users LIMIT 1;
COMMIT;
```

### 3.3 分片——这是 PgDog 的核心杀手锏

定义 sharded table：

```toml
[[databases]]
name = "prod"
host = "10.0.0.1"
shard = 0

[[databases]]
name = "prod"
host = "10.0.0.2"
shard = 1

[[sharded_tables]]
database = "prod"
column = "user_id"
```

应用代码**完全不用改**——只要 `WHERE user_id = $1` 这种带 sharding key 的查询，PgDog 会自动路由到对应分片。

跨分片查询 PgDog 会**自动分发到所有分片后内存合并**。支持的功能（README 表格）：

| Feature | Supported | Notes |
|-|-|-|
| Aggregates | Partial | `count`, `min`, `max`, `stddev`, `variance`, `sum`, `avg` |
| `ORDER BY` | Partial | 排序列必须在结果集里 |
| `GROUP BY` | Partial | 同上 |
| Multi-tuple `INSERT` | Supported | 每个 tuple 自动去对应分片 |
| Sharding key `UPDATE` | Supported | 拆成 `SELECT + INSERT + DELETE` |
| Subqueries | No | 在所有分片执行相同的 subquery |
| CTEs | No | 同上 |

跨分片写入靠 **PostgreSQL 两阶段提交**（two-phase commit）保证原子性：

```sql
PREPARE TRANSACTION '__pgdog_unique_id';
COMMIT PREPARED '__pgdog_unique_id';
```

PG 崩溃或客户端断线时，PgDog 会自动 rollback 阶段 I 的事务、commit 阶段 II 的事务。

**重分片（re-sharding）**——这是真正"产业级"的功能。PgDog 5 步加一台机器：

1. 创建新空 cluster，配置成新分片数
2. `schema-sync` 命令复制 schema
3. `data-sync` 用逻辑复制并行复制数据
4. `schema-sync --data-sync-complete` 创建二级索引（更快）
5. 切流量：`MAINTENANCE ON` → `RELOAD` → `MAINTENANCE OFF`

最妙的是最后一步——`RELOAD` 不恢复流量，`MAINTENANCE OFF` 才恢复，**所以多个 PgDog 容器之间的配置可以保证一致再切流量，无需 etcd/ZooKeeper 之类的协调服务**。这是 3 人团队能拿 $5.5M 的根本原因：**把"水平扩展 PostgreSQL"这个数据库行业 20 年没解决的难题，用应用层代理做到生产可用**。

## 四、社区三大阵营——HN 207 条评论里工程师们到底在吵什么

### 阵营 A："PgBouncer 已经够了"——质疑派

代表评论（`faangguyindia`）：

> "I am not using any tool like pgbouncer and have not run into any issues so far. Is it even required these days?"

代表评论（`moralestapia`）：

> "I was stress-testing the machine obviously, I'm not talking about the 10 rps, lol. For context, my numbers were something like 10k rps +/- 1k vanilla postgres and like 9k rps +/- 1k with pgbouncer in front of it. So ... slightly slower but big error bars so I wouldn't say for sure."

我的解读：这一派的核心论点是"对小流量实例 PgBouncer 完全够用"。**但他们忽略了一个事实**——PgBouncer 的三个老坑（pool exhaustion、死连接、SET 语句）在云原生、Kubernetes、SQLAlchemy 这种环境里**几乎必然出现**。lev 把"基础设施复杂性"作为分水岭是对的。

代表评论（`bourbonproof`）——质疑派的另一面：

> "the reason mongo is a joy to use in scaled env is because no additional setup/software needed and all drivers natively support secondary/primary writes/reads and topological changes. so it's end to end, and adding is as a new proxy in frontend of postgres leads to all clients being incompatible or the code itself has no control anymore about when to use a secondary"

这是来自 MongoDB 阵营的真实一击：**Mongo 的扩展性是"开箱即用"的，PG 的扩展性是"你需要先读懂 4 种 proxy"**。PgDog 没有解决这个根本问题，它只是让"读懂 4 种"变成"读懂 1 种"。

### 阵营 B："Vitess/Citus 已经做了"——错位归因派

代表评论（`gen220`）：

> "Is there an explainer for people who are broadly familiar with the DB space? It sounds like you're building an equivalent to Vitesse for Postgres, but it's not super clear from the article."

代表评论（`jeremyjh`）：

> "It's surprising they don't mention advantages over other sharding systems like Citus. Maybe it's just the fact that it's only a proxy and not core extensions? But that could limit capabilities."

代表评论（`BowBun`）：

> "I really wish they'd acknowledge the prior art and name that they've taken inspiration from - https://github.com/postgresml/pgcat"

我的解读：**这是 HN 207 条评论里最有价值的一派**。他们把 PgDog 拉进 PostgreSQL 生态坐标里：
- vs **Citus**（Microsoft，PG 内核扩展，sharding 透明但需要改 PG 本身）
- vs **Vitess**（YouTube/PlanetScale，MySQL 应用层 proxy，先发优势大）
- vs **pgcat**（PostgresML 维护，AGPL，应用层 proxy）
- vs **Neki**（PlanetScale 开源，AGPL，PG 分片新兵）
- vs **Multigres**（Vitess 团队转投 PG 的尝试）

**PgDog 的真正差异化**——根据 README + HN 作者回应：**协议层（pg_query）+ 应用层 + Rust 性能**。它不修改 PG 内核，纯应用层 proxy，意味着**未来 PG 17 → 18 → 19 升级零摩擦**；Citus 用户每次 PG 大版本升级都要等 Microsoft 发新版。

### 阵营 C："Enterprise Edition 边界在哪里"——审计派

代表评论（`aejm`）：

> "I notice there is an Enterprise Edition, can you please specify which features are not open source? Do you predict new features you add will be ee licensed as a way to pay back your VC funders?"

代表评论（`xenophonf`）：

> "This commit looks... odd. https://github.com/pgdogdev/pgdog/commit/36434f93f03dec1d7d4... I want to have as much fun as the next developer, but that makes me worry, what with supply chain attacks in the news and all."

我的解读：VC 投资必然要回报。**AGPL-3.0 的设计很聪明**——"内部使用完全免费，私有修改无需开源，但如果你拿 PgDog 提供公开服务（SaaS 形态），必须开源你的修改"。所以 PgDog 收钱的合理路径就是**Enterprise Edition**——给"我就是要用 PgDog 跑 SaaS 数据库"的人授权。

但 EE 边界在哪里，**README 没说**。这是 6 月 10 日之后 lev 应该立刻补的一段。一个 $5.5M 融资的项目不写清楚开源边界，会被怀疑"未来把所有好功能 EE 化"。lev 在 HN 评论区**还没回这条**，是技术/产品沟通上的小失误。

## 五、PG 圈的更大问题——为什么 PG 分片比 MySQL 难

`tschellenbach`（PlanetScale 创始人）的总结一针见血：

> "PgDog, Neki, multigres, awesome to see. And yes this is the main issue with postgres. Well this and not having index hints, looking forward to 19"

`eikenberry` 把痛点描述得更具体：

> "I've used Postgres at a few places and the #1 problem was always high availability, not scaling. One Postgres cluster could easily handle 100000 transactions per minute, but when a primary node went down it was a page and manually failing over to the spare then manually replacing the spare."

**PostgreSQL 20 年不解决分片，不是技术做不到，是社区政治。** Citus（被微软收）走内核扩展路线，pg_shard / pg_pathman 走内核路线都失败了——PG 社区对"修改 planner 行为"极度保守。Vitess 在 MySQL 上的成功本质是**绕开 MySQL 内核的扩展性争议**。PgDog 走的是同一条路：**承认内核短期内不会给你分片，我们在应用层做**。

这与 Linear 的本地优先、Bun 的 Rust 移植、Zeroserve 的 io_uring 是同一种范式——**绕开生态系统最保守的部分，从应用层/工具层突破**。

## 六、5 级时间梯度实操清单——你应该从 PgDog 拿走什么

### 立刻能做（5 分钟）
- 把现有的 PgBouncer 池配置复制成 `pgdog.toml` 格式，先连上不做切换
- 用 `psql` 测一下 `SET search_path TO ...; SELECT * FROM users LIMIT 1;`——**这一条 PgBouncer 不能正确处理**
- 看 PgDog 暴露的 OpenMetrics endpoint，能不能接到你现有的 Prometheus

### 当周能做（半天）
- 把生产数据库的**只读副本**接到 PgDog 的 `[[databases]] role="replica"` 配置里
- 跑一遍健康检查，确认 failover 切换时间
- 在 staging 跑一次 PgBouncer → PgDog 的灰度切换

### 季度能做（2-4 周）
- 评估**是否需要 sharding**——这个决策 PG 圈有 5 个先行指标：
  1. 单表 > 1TB
  2. 单 PG 实例 CPU 持续 > 70%
  3. 单 PG 实例 IOPS 持续 > 80%
  4. 大版本升级需要 ≥ 4 小时停机
  5. 备份恢复超过 6 小时
- 如果需要，**先按 schema 分片**（PgDog 支持 `sharded_schemas`）——比 hash 分片简单一个量级

### 半年能做（季度级投入）
- 把 PgDog 接到 K8s，用 Helm chart 部署
- 配置多 AZ failover
- 把 LISTEN/NOTIFY 迁移到 PgDog 的事务池模式（`mnbbrown` 在 HN 说他用了 6 个月"incredibly stable"）

### 年度能做（季度级投入）
- **真正的 re-sharding**——把现有 4TB 单库重新分到 8 个 500GB 分片
- 这一步需要：容量评估、schema 设计、流量切分计划、回滚预案
- **不要低估这个工程**——Re-sharding 失败一次 = 几个小时的不可用

## 七、5 个未来 6-12 个月可以验证的硬指标

1. **PgDog 是否进入 CNCF Sandbox**——Citus 没进，pgcat 也没进；如果 PgDog 进了，是生态地位质变
2. **Enterprise Edition 边界公开化**——AGPL 边界 + EE 范围 = 决定大型企业能不能用
3. **`pg_query` 升级到 PostgreSQL 19 解析器**——一旦 PG 19 出来（6-12 个月内），看 PgDog 多快跟进
4. **PlanetScale 的 Neki 与 PgDog 的差异化**——两边都是 AGPL、都做 PG 分片，6-12 个月内会有一篇双方对比的深度评测
5. **是否被 Supabase / Timescale / Neon 等 DBaaS 内置**——如果 Supabase 把它集成进 Supabase Cloud = 用户量级跨越

## 八、回到 207 条评论的回环

把今天 416 pts / 207c 的帖子从三个阵营再过一遍：

- **质疑派**问的"为啥不直接用 SSD"——其实回答在 2024 年 Instacart 5x 流量峰值的故事里
- **错位归因派**点出了 Vitess/Citus/Neki/pgcat 四个先驱——lev 后续应该写一篇 "vs everyone" 博客
- **审计派**点出 EE 边界 + 奇 commit——lev 应该立刻补 README

**这些评论都不是孤立的——它们是同一件事的三面**：

> **2026 年的 PostgreSQL 生态，正在从"内核扩展路线"向"应用层 proxy 路线"全面转向。** PgDog 是这场范式转移里**最有可能跑出来的开源方案**——3 人团队、$5.5M、12 个 crate、AGPL-3.0、4716 stars、$5.5M 估值靠的是**对 PG 社区政治的正确判断**而不是技术碾压。

而你——一个 2026 年中还在用 PG 的工程师——**真正应该从这场讨论里带走的**，不是 PgDog 这个具体项目（它可能成也可能不成），而是这种**"承认内核短期内不会给你分片"的应用层突破范式**。它同样适用于：

- 想做实时协作但不想 fork Yjs → 用 Linear 风格的本地优先
- 想做高性能 HTTP 但不想改 Node 内核 → 用 Bun 的 Rust runtime
- 想做 eBPF + io_uring 的 web server 但不想改 Linux → Zeroserve

**内核层是政治，应用层是工程。** PgDog 选了工程这条更艰难但更可控的路。

---

*相关阅读：*

- [Bun 在 Anthropic 入主半年后做了一件大事：6 天、6755 个 commit、零人工审阅的 Zig→Rust 移植到底发生了什么](/article/bun-anthropic-acquisition-zig-to-rust-ai-rewrite-2026)
- [Zeroserve 架构深度解析：当 io_uring、eBPF 与 Tarball 打包相遇，一个 1.2MB/实例的零配置 Web 服务器是怎么炼成的](/article/zeroserve-ebpf-io-uring-tarball-architecture-2026)
- [Linear 为什么那么快：481 颗星拆解一份价值 300ms 的本地优先架构蓝图](/article/linear-local-first-performance-2026)

---

**参考资源：**

- [PgDog GitHub 仓库](https://github.com/pgdogdev/pgdog) - 12 个 crate、1451 文件的完整 workspace
- [PgDog 文档](https://docs.pgdog.dev/) - 涵盖连接池、负载均衡、分片、跨分片查询、重分片全部功能
- [HN 讨论](https://news.ycombinator.com/item?id=48476466) - 416 pts / 207c 的产业级融资讨论
- [PgBouncer](https://www.pgbouncer.org/) - 上一代连接池的事实标准
- [Citus](https://github.com/citusdata/citus) - PostgreSQL 内核扩展路线的代表
- [Vitess](https://vitess.io/) - MySQL 应用层 proxy 的先驱
