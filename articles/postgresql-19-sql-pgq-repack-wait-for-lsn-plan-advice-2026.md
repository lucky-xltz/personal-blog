---
title: "PostgreSQL 19 深度拆解:SQL/PGQ 图查询 + REPACK CONCURRENTLY 无锁重建 + WAIT FOR LSN 读己写 + FOR PORTION OF 时态 + pg_plan_advice 计划锁定 —— 从关系型到图时态多模的 6 大承重级革新 + 5 段实战 SQL + 5 套维度对比 + 7 条迁移避坑"
slug: "postgresql-19-sql-pgq-repack-wait-for-lsn-plan-advice-2026"
date: 2026-09-20
category: 技术
tags:
  - PostgreSQL
  - PostgreSQL19
  - SQL/PGQ
  - 属性图
  - 图查询
  - REPACK
  - VACUUM FULL
  - CLUSTER
  - 无锁重建
  - WAIT FOR
  - LSN
  - 读己写
  - FOR PORTION OF
  - 时态表
  - pg_plan_advice
  - pg_stash_advice
  - 执行计划
  - 逻辑复制
  - 序列复制
  - Autovacuum
  - 并行Vacuum
  - 数据校验和
  - JIT
  - OLTP
  - 关系型数据库
  - 数据库迁移
  - 2026
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=600&h=440&fit=crop
excerpt: "2026 年 9 月,PostgreSQL 19 带着 6 大承重级革新落地:SQL/PGQ 属性图查询把「图数据库」变成关系库的一个语法层;REPACK + CONCURRENTLY 终结 VACUUM FULL/CLUSTER 长达 20 年的 AccessExclusiveLock 锁表噩梦;WAIT FOR LSN 让备库「读己写」从应用层轮询下沉到内核等待;FOR PORTION OF 让时态表的区间更新不再需要手写 3 条 UPDATE 拆分;pg_plan_advice + pg_stash_advice 第一次让 DBA 能把「好计划」像代码一样版本化;逻辑复制补齐序列同步 + 无重启开启。本文从 PG18 时代这 6 个各自独立的痛点讲起,给出 5 段可直接在 PG19 beta 上跑的实战 SQL(金融转账图查询、REPACK CONCURRENTLY 在线维护、备库读己写、时态表区间更新、计划锁定全流程),6 套维度对比表,以及 7 条从 PG18 迁移的避坑清单(max_locks_per_transaction 64→128、JIT 默认关闭、RADIUS 移除、standard_conforming_strings 强制开启)。核心结论:PG19 是 PostgreSQL 历史上第一次把「多模(图 + 时态)」和「运维自洽(无锁维护 + 读己写 + 计划锁定)」同时做进核心的版本,2026 H2 还在用 pg_repack 外挂 + 应用层 LSN 轮询的团队,是时候把这些能力收回到内核了。"
---

# PostgreSQL 19:当关系型数据库开始「多模化」与「运维自洽」

2026 年 9 月,PostgreSQL 19 进入最后的发布周期(Beta 3 于 2026-08-13 发布,GA 按惯例在 9 月下旬)。这不是一次常规的"性能提升 + 若干新语法"的版本——它同时改掉了 PostgreSQL 生态里 **6 个存在了 5-20 年的结构性痛点**,而且每一个都是"过去必须靠外挂工具或应用层 hack 才能绕过"的:

| 痛点 | PG18 及之前怎么绕 | PG19 内核解法 |
|------|-------------------|---------------|
| 图查询要单独部署 Neo4j | 应用层拼 SQL,或上 Apache AGE 扩展 | **SQL/PGQ** 进核心语法 |
| VACUUM FULL / CLUSTER 锁表 | 装 pg_repack / pg_squeeze 外挂 | **REPACK ... CONCURRENTLY** |
| 备库读己写要应用层轮询 | 写后 sleep + 查 pg_last_wal_replay_lsn() | **WAIT FOR LSN** |
| 时态表区间更新要拆 3 条 SQL | 手写 3 条 UPDATE + 显式合并 | **FOR PORTION OF** |
| 执行计划抖动只能盯慢日志 | 手工调 GUC、加 hint | **pg_plan_advice / pg_stash_advice** |
| 序列在逻辑复制中漂移 | 手工同步 + 应用层兜底 | **序列同步 + REFRESH SEQUENCES** |

**关键洞察 1:这 6 个革新不是随机堆 feature,而是同一条主线 —— 把过去「外挂工具 + 应用层补丁」才能实现的能力,下沉成内核语法。** 这条主线在 OLTP 数据库演进史里有一个清晰的名字:**运维自洽(operational self-containment)**。一个数据库越能靠自己的 SQL 解决维护问题,它的运维成本曲线就越平。PostgreSQL 从 PG12 的 `pg_repack` 需求出现,到 PG14 的 `CLUSTER` 保留,再到 PG19 的 `REPACK CONCURRENTLY`,走了整整 7 年。

**关键洞察 2:SQL/PGQ 是 PG19 唯一一个「改变数据建模方式」的革新。** 在此之前,PostgreSQL 的"多模"能力(数组、JSON/JSONB、范围类型、分区、全文检索)都是"在一个表里多存一种列"。SQL/PGQ 不一样——它让你**在不新增任何存储结构的前提下,把已有的表声明成图**,然后用图遍历语法查询。这对已有的 OLTP 库是零迁移成本的:你的 `accounts`、`transfers` 表一行不用改,就能跑图查询。

---

## 1. 问题的源头:为什么 PG18 时代这 6 件事都很痛

在讲 PG19 的解法之前,必须先把 PG18 及之前「为什么痛」讲清楚——否则你会觉得新语法只是"换个写法"。**这 6 个痛点的共同特征是:数据库内核做不到的事,被推给了应用层或外挂工具,而应用层做这件事天然是不可靠的。**

### 1.1 图查询:关系库的「多跳关系」问题

金融风控、好友推荐、知识图谱、权限继承——这些场景的共同数据模式是「多跳关系遍历」。用纯关系型 SQL 表达 3 跳关系,需要 3 次 JOIN;5 跳需要 5 次;而且**跳数在查询时往往是动态的**("找出这个账户经过 1-5 跳最终到达黑名单的路径"),这在纯 SQL 里要么写不出,要么得用递归 CTE 手写一个不直观的遍历器。

递归 CTE 的典型写法(能跑,但难维护):

```sql
-- PG18:用递归 CTE 找「账户 A 到黑名单账户的多跳转账路径」,深度 1-4 跳
WITH RECURSIVE path AS (
  SELECT
      from_acct                       AS start_acct,
      to_acct                         AS current_acct,
      ARRAY[from_acct, to_acct]       AS route,
      1                               AS depth
  FROM transfers
  WHERE from_acct = 'ACC-1001'
  UNION ALL
  SELECT
      p.start_acct,
      t.to_acct,
      p.route || t.to_acct,
      p.depth + 1
  FROM path p
  JOIN transfers t ON t.from_acct = p.current_acct
  WHERE p.depth < 4                      -- 防止无限递归
    AND NOT t.to_acct = ANY(p.route)     -- 环路检测:已访问过的节点不再访问
)
SELECT start_acct, current_acct AS hit_blacklist, route, depth
FROM path
WHERE current_acct IN (SELECT acct_id FROM blacklist)
ORDER BY depth;
```

这段代码有 4 个问题:① 环路检测 `NOT ... = ANY(route)` 是手工的,容易漏;② `UNION ALL` 不会去重,同一终点会被重复扩展;③ 深度控制是硬编码的;④ 优化器对递归 CTE 的计划控制很弱,基本是逐层执行,无法做图数据库常见的「最短路径剪枝」。

**PG19 之前的标准出路是另部署一套 Neo4j / Apache AGE(到 PG16 才有官方扩展支持)。** 但这带来一个更痛的问题:**数据双写与一致性**。OLTP 主库的事务在 PostgreSQL 里,图查询在 Neo4j 里,中间靠 CDC 或双写同步,一旦同步延迟或丢消息,风控查出来的"多跳路径"就是错的。金融风控场景里,「路径查错」=「漏掉一笔洗钱」。

### 1.2 VACUUM FULL / CLUSTER:一个 20 年的锁表噩梦

PostgreSQL 的 MVCC 多版本实现,决定了更新/删除产生的死元组(dead tuples)需要 VACUUM 回收。普通 VACUUM 只标记空间可重用,**不会把空间还给操作系统**,也不会物理整理。于是有两个命令干"重建表"的活:

- `VACUUM FULL`——重建表以回收磁盘空间
- `CLUSTER`——按索引顺序物理重建表

这两个命令在 PG18 及之前都有一个致命共性:**都需要 AccessExclusiveLock**,即**阻塞一切读写**。在一个 24×7 的 OLTP 库上,一张 500GB 的热点业务表,`VACUUM FULL` 可能要跑 40 分钟,期间该表完全不可读写。

业界标准解法是装 **pg_repack**(第三方扩展):它通过建临时表 + 触发器 + 增量同步的方式在线重建。但 pg_repack 有它自己的代价:① 需要额外安装和维护;② 需要主键;③ 重建期间触发器带来写放大;④ 它本身是分布式事务不安全的(在逻辑复制的订阅端跑 pg_repack 可能造成不一致)。**PG19 之前,「在线重建表」在 PostgreSQL 里不是一个一等公民能力。**

### 1.3 备库「读己写」:应用层轮询的黑洞

读写分离是 OLTP 标配。但它引入一个经典问题:**应用在主库写完一条记录,立刻去备库读,读不到**。因为异步复制有延迟(同机房通常 1-10ms,跨可用区可能 50-500ms)。

PG18 时代的典型应用层代码(Python + psycopg):

```python
# PG18:写主库后轮询备库 LSN,直到备库回放到写入点
import psycopg

def write_then_read(order_id: str) -> dict:
    with psycopg.connect(PRIMARY_DSN) as pri:
        with pri.cursor() as cur:
            cur.execute(
                "INSERT INTO orders(id, status) VALUES (%s, 'paid') "
                "RETURNING pg_current_wal_lsn()::text",
                (order_id,))
            lsn = cur.fetchone()[0]              # 拿到这条写入的 WAL LSN
        pri.commit()

    # 轮询备库:每 5ms 查一次,最多等 2s
    with psycopg.connect(REPLICA_DSN) as rep:
        for _ in range(400):
            with rep.cursor() as cur:
                cur.execute("SELECT pg_last_wal_replay_lsn()::text")
                if cur.fetchone()[0] >= lsn:      # 字符串比较 LSN 不可靠!
                    break
            time.sleep(0.005)
        with rep.cursor() as cur:
            cur.execute("SELECT * FROM orders WHERE id = %s", (order_id,))
            return cur.fetchone()
```

这段代码有 3 个隐患:① **LSN 字符串比较不可靠**(`'0/15000000'` vs `'0/1500A000'` 的字典序与 LSN 数值序在跨段时不一致,必须用 `pg_lsn` 类型的 `>=`);② 轮询消耗备库连接池和 CPU;③ 超时策略要应用层自己定。**本质上是数据库把「等待复制」这个它自己最清楚的事,推给了最不清楚的应用层。**

### 1.4 时态表的区间更新:手写 3 条 SQL 的原罪

时态表(temporal table)在金融、合规、审计场景极其常见:"记录某客户在某时间段内的税率"。PG 原生支持 `daterange`/`tstzrange` 范围类型,但**对一个范围列做「更新中间一段」的操作,需要手工拆成最多 3 条语句**:

假设要把客户 C1 在 `[2026-03-01, 2026-06-01)` 的税率从 6% 改成 8%,而 C1 现有记录是 `[2026-01-01, 2026-07-01) -> 6%`。你需要:① 把原记录截断成左右两段 `[2026-01-01,2026-03-01)` 和 `[2026-06-01,2026-07-01)`;② 插入中间的新段 `[2026-03-01,2026-06-01) -> 8%`。**这 3 条 SQL 必须在一个事务里,而且边界重叠/遗漏的检查全靠开发者自觉。** 这是典型的"数据库知道你想干嘛但不帮你做"。

### 1.5 执行计划抖动:DBA 的暗箱

PostgreSQL 的基于成本的优化器(CBO)在数据分布变化、ANALYZE 统计信息更新、或者大版本升级后,**可能对同一条 SQL 选出完全不同的计划**。昨天是 Hash Join 跑 80ms,今天变成 Nested Loop 跑 8 秒。

PG18 的应对手段:① 手工调 GUC(如 `SET LOCAL enable_nestloop = off`)——粒度太粗,影响会话内所有 SQL;② 升级扩展 pg_hint_plan——非官方、语法侵入性强;③ 统计信息固化——治标不治本。**核心缺失是:DBA 无法把「一个验证过的好计划」像代码一样存下来、版本化、按 queryid 精确生效。**

### 1.6 逻辑复制:序列的幽灵

逻辑复制复制表数据,但**不复制序列的当前值**。这在 PG18 及之前是大量生产事故的来源:主库 failover 到订阅端后,订阅端的序列值还停在昨天,新插入的行 id 跟已复制的行**主键冲突**。`pg_dump` 时刻的序列快照 + 之后主库的自增,两者之差就是事故窗口。

---

## 2. PG19 核心设计:6 大革新的三层架构

理解 PG19 最好的方式不是按 changelog 顺序,而是按「它动了哪一层」。这 6 个革新分布在三个不同的架构层上,各自解决不同性质的问题。

```
┌──────────────────────────────────────────────────────────────────┐
│  Layer 1:查询与建模层(Query & Modeling)                          │
│    ┌──────────────────────────┐  ┌───────────────────────────────┐│
│    │  SQL/PGQ 属性图查询       │  │  FOR PORTION OF 时态区间更新   ││
│    │  把已有表声明成图,        │  │  一条 SQL 完成「区间覆盖式     ││
│    │  用 GRAPH_TABLE 遍历      │  │  更新」的 3 条 SQL 合并        ││
│    └──────────────────────────┘  └───────────────────────────────┘│
├──────────────────────────────────────────────────────────────────┤
│  Layer 2:运维与维护层(Operations & Maintenance)                   │
│    ┌──────────────────────────┐  ┌───────────────────────────────┐│
│    │  REPACK ... CONCURRENTLY  │  │  在线数据校验和开关            ││
│    │  无 AccessExclusiveLock   │  │  不再需要停库 pg_checksums     ││
│    │  的在线表重建              │  │                               ││
│    └──────────────────────────┘  └───────────────────────────────┘│
├──────────────────────────────────────────────────────────────────┤
│  Layer 3:复制与计划层(Replication & Planning)                     │
│    ┌──────────────────────────┐  ┌───────────────────────────────┐│
│    │  WAIT FOR LSN            │  │  pg_plan_advice +             ││
│    │  + 序列逻辑复制           │  │  pg_stash_advice              ││
│    │  内核等待替代应用轮询      │  │  计划锁定与自动复用            ││
│    └──────────────────────────┘  └───────────────────────────────┘│
└──────────────────────────────────────────────────────────────────┘
```

**为什么这个分层很重要**:Layer 1 的两个革新改变的是「你怎么写查询」,Layer 2/3 改变的是「你怎么运维这个库」。**一个版本同时动这两层,在 PostgreSQL 历史上不常见**——通常 query 层和 ops 层的演进是交替的(PG14 的 JSON 路径查询是 query 层,PG16 的逻辑复制并行是 ops 层)。PG19 同时给出,意味着它在回答一个问题:**关系型数据库的下一步,不是更大的单机,而是「更少的外挂依赖」。**

---

## 3. 六大承重级革新:逐条拆解

### 3.1 REPACK 命令:统一 VACUUM FULL 与 CLUSTER,并支持 CONCURRENTLY

这是 PG19 最直接命中生产痛点的一个。官方 changelog 原文:

> Add REPACK command which replaces VACUUM FULL and CLUSTER (Antonin Hahusky...). The two former commands did similar things, but with confusing names, so unify them as REPACK. The old commands have been retained for compatibility.
>
> Allow REPACK to rebuild tables without access-exclusive locking. This is enabled via the CONCURRENTLY option. Server variable max_repack_replication_slots was also added.

**设计要点**:

1. **REPACK = VACUUM FULL + CLUSTER 的合并**。无参数时 `REPACK;` 处理当前库所有表(需 MAINTAIN 权限,且不能在事务块中执行)。带 `USING INDEX` 时等价于旧的 CLUSTER,按索引物理排序。
2. **`REPACK CONCURRENTLY` 是真正的核心**。它在重建期间**不持有 AccessExclusiveLock**,允许读写继续。其代价是使用了**逻辑复制槽**(新增 GUC `max_repack_replication_slots` 控制槽数上限)——这正是它比 pg_repack 更可靠的工程基础:它复用了逻辑解码基础设施来同步重建期间的增量变更,而不是 pg_repack 那种触发器方案。
3. **CONCURRENTLY 形式不能处理整库形式**(`REPACK CONCURRENTLY;` 无表名不被允许)。

语法(来自 PG19 `sql-repack` 文档):

```sql
REPACK [ ( option [, ...] ) ] [ CONCURRENTLY ] [ table_name ] [ USING INDEX index_name ]
```

**关键洞察 3:REPACK CONCURRENTLY 用逻辑复制槽而不是触发器,是一个决定性的架构选择。** 触发器方案(pg_repack)的问题在于:它把增量同步放在**同一台数据库的同一个表**上做,写放大严重,且在订阅端无法安全重放。用逻辑解码槽,重建过程天然支持复制拓扑,且与 PG 的逻辑复制生态对齐。**这是「把运维能力建立在复制基础设施上」的思路,跟 PG16 的逻辑复制并行思路一脉相承。**

### 3.2 SQL/PGQ:属性图查询进核心

SQL/PGQ 是 SQL 标准的一部分(SQL:2023 的 Property Graph Queries),PG19 把它实现进了核心。官方说明:

> Add support for SQL Property Graph Queries (SQL/PGQ) (Peter Eisentraut, Ashutosh Bapat). Internally these are processed like views so are written as standard relational queries.

**两段式用法**:

第一步,把已有表声明成属性图(零数据迁移):

```sql
CREATE PROPERTY GRAPH financial_graph
  VERTEX TABLES (
    accounts AS account        KEY (acct_id)
      PROPERTIES (acct_id, name, risk_level, created_at),
    merchants AS merchant      KEY (merchant_id)
      PROPERTIES (merchant_id, category)
  )
  EDGE TABLES (
    transfers AS transfer      KEY (transfer_id)
      SOURCE KEY (from_acct) REFERENCES accounts (acct_id)
      DESTINATION KEY (to_acct)   REFERENCES accounts (acct_id)
      PROPERTIES (amount, currency, ts),
    payouts AS payout          KEY (payout_id)
      SOURCE KEY (from_acct)     REFERENCES accounts (acct_id)
      DESTINATION KEY (merchant_id) REFERENCES merchants (merchant_id)
      PROPERTIES (amount, ts)
  );
```

第二步,用 `GRAPH_TABLE` 子句做图遍历:

```sql
SELECT path.account_id, path.total_amount, p.depth
FROM GRAPH_TABLE (financial_graph
  MATCH (a:account WHERE a.acct_id = 'ACC-1001')
        -[t:transfer]->{1,4} (b:account)
  COLUMNS (a.acct_id AS start, b.acct_id AS account_id,
           list_agg(t.amount) AS amounts,
           COUNT(t) AS hops)
) AS path
WHERE path.account_id IN (SELECT acct_id FROM blacklist);
```

**关键点**:`MATCH ... -[t:transfer]->{1,4}` 表达「1 到 4 跳的转账路径」,`{1,4}` 是**量词(quantifier)**,这是递归 CTE 无法简洁表达的部分。而「内部按视图处理」意味着**优化器可以把它重写成标准的关系查询做成本优化**——不是另起一个图执行引擎。

**边界与代价**:① 图定义本身是**元数据**,底层数据仍在表里,所以不会因为「建了图」而获得图数据库的存储优势(如邻接压缩);② SQL/PGQ 目前**不含最短路径、PageRank 等 图算法**,只是路径匹配;③ 每次查询都要做图元数据到关系的重写,极高频调用下需关注解析开销。

### 3.3 WAIT FOR LSN:备库读己写的内核原语

这是 PG19 修复「应用层轮询」的革新。语法(来自 PG19 `sql-wait-for` 文档):

```sql
WAIT FOR LSN 'lsn' [ WITH ( option [, ...] ) ]
where option can be: MODE 'mode' | TIMEOUT 'timeout' | NO_THROW
and mode can be: standby_replay | standby_write | standby_flush | primary_flush
```

**四种 mode 是本特性的核心设计**:

| mode | 等到什么位置 | 持久性保证 | 典型场景 |
|------|-------------|-----------|---------|
| `standby_replay` | WAL 已**回放**到数据页 | 最强:查询一定能读到 | **读己写(默认)** |
| `standby_flush` | WAL 已 **flush 到备库磁盘** | 强,但可能未回放 | 备库 HA 切换前确认 |
| `standby_write` | WAL 已写到备库 OS 缓存 | 弱:宕机可能丢 | 低延迟近似读 |
| `primary_flush` | 主库 WAL 已 flush | 用于主库自身的确认语义 | 写后立即在主库确认 |

**关键设计点**:① 默认 mode 是 `standby_replay`,正是「读己写」需要的语义;② `TIMEOUT` 为 0 或不填 = 无限等待;③ 超时默认抛错,加 `NO_THROW` 则返回状态字符串 `success` / `timeout` / `not in recovery`;④ **备库提升(promotion)时会报错**——这是一个安全设计,防止应用在已切换的库上读到不一致状态。

**关键洞察 4:WAIT FOR 把「等待」从应用连接池搬进了数据库会话。** 应用层轮询的隐藏成本不是 sleep 的那几毫秒,而是「每次轮询都占一个连接池连接 + 一次 round-trip」。高并发下,读己写轮询可以把备库连接池打满。WAIT FOR 让这个等待变成一次会话内的阻塞调用,连接占用从 O(轮询次数) 降到 O(1)。

### 3.4 FOR PORTION OF:时态区间更新的一条 SQL

官方说明:

> Add FOR PORTION OF clause to UPDATE and DELETE (Paul A. Jungwirth). This allows operations on temporal ranges.

语法位置(注意它出现在 `SET` 之前):

```sql
UPDATE [ ONLY ] table_name [ * ]
  [ FOR PORTION OF range_column_name for_portion_of_target ]
  [ [ AS ] alias ]
  SET ...
where for_portion_of_target is:
  { FROM start_time TO end_time | ( portion ) }
```

**它解决了什么**:把「更新某时间段的值」从手写 3 条 SQL(截断左段 + 截断右段 + 插入新段)压缩成**一条声明式 SQL**,并且**边界处理由内核保证不重叠、不遗漏**。对金融费率、合同有效期、权限有效期这类强时态场景,这直接消除了最容易出 bug 的手写边界逻辑。

> 关于 `FOR PORTION OF` 的完整实战 SQL 与「手写 3 条 vs 一条」的对照,见 §4.4。

### 3.5 pg_plan_advice + pg_stash_advice:把好计划变成可版本化的资产

这是 PG19 里最「元」的一个革新:它不加速查询,它**让计划可控制**。官方说明:

> Add pg_plan_advice module to stabilize and control planner decisions (Robert Haas).
> Add extension pg_stash_advice to allow per-query-id advice to be specified (Robert Haas, Lukas Fittl).

**工作流三步**:

```sql
-- ① 加载扩展(三选一:shared_preload_libraries 需重启 / session_preload_libraries 新会话 / 单会话 LOAD)
LOAD 'pg_plan_advice';

-- ② 用 EXPLAIN 生成当前计划的 advice 字符串
EXPLAIN (COSTS OFF, PLAN_ADVICE)
SELECT * FROM join_fact f JOIN join_dim d ON f.dim_id = d.id;
--  QUERY PLAN
--  ---------------------
--   Hash Join
--    Hash Cond: (f.dim_id = d.id)
--    -> Seq Scan on join_fact f
--    -> Hash
--        -> Seq Scan on join_dim d
--  Generated Plan Advice:
--   JOIN_ORDER(f d)
--   HASH_JOIN(d)
--   SEQ_SCAN(f d)
--   NO_GATHER(f d)

-- ③ 把 advice 应用到后续查询
SET pg_plan_advice.advice = 'JOIN_ORDER(f d) HASH_JOIN(d) SEQ_SCAN(f d) NO_GATHER(f d)';
```

**advice mini-language 的四条语义**:① `JOIN_ORDER(f d)` = f 是驱动表,先 join d;② `HASH_JOIN(d)` = d 在 hash join 内侧;③ `SEQ_SCAN(f d)` = 两表都走顺序扫描;④ `NO_GATHER(f d)` = 不允许出现在 Gather/Gather Merge 下(即禁止并行)。

**pg_stash_advice 的作用**:`pg_plan_advice.advice` 是**会话级 GUC**,每次执行前都要 SET。`pg_stash_advice` 让你**按 queryid 存 advice**,内核自动匹配——这就是「把计划建议像配置一样持久化」。

**官方警告必须记住**:

> since the planner often makes good decisions, overriding its judgment can easily backfire... if the distribution of the underlying data changes, the planner normally has the option to adjust the plan... If the plan advice prevents this, a very poor plan may be chosen.

**关键洞察 5:plan advice 的正确用法不是「代替优化器」,而是「给优化器加护栏」。** 场景是:**已验证的慢 SQL、有 SLA 承诺的核心链路、大版本升级后的回归兜底**。用法是「先抓 advice 快照 → 变更后若计划劣化则回滚到快照」。把它当日常调优手段是误用。

### 3.6 逻辑复制补齐序列同步 + 无重启开启

官方说明:

> Allow sequence values stored in subscribers to match the publisher (Vignesh C). This is enabled during CREATE SUBSCRIPTION, ALTER SUBSCRIPTION ... REFRESH PUBLICATION, and ALTER SUBSCRIPTION ... REFRESH SEQUENCES.
> Allow CREATE/ALTER PUBLICATION to publish all sequences ... enabled with the ALL SEQUENCES clause.
> When server variable wal_level is replica, allow automatic enablement of logical replication when needed (Masahiko Sawada). New server variable effective_wal_level reports the effective WAL level.

**解决了什么**:① **序列漂移导致的主键冲突**——failover 后订阅端序列从旧快照开始,新插入与已复制行 PK 冲突;② `wal_level=logical` 需要重启——PG19 允许从 `replica` 按需自动提升到 logical,**新 GUC `effective_wal_level` 报告实际生效值**。

**新增的冲突解决支持**:

> Add CREATE/ALTER PUBLICATION setting retain_dead_tuples to retain information needed for conflict resolution, with setting max_retention_duration to limit retention.

这意味着逻辑复制在冲突检测与解决方向上补了底层支撑,与 PG18 引入的 `pg_conflict_detect...` 路线一致。

---

## 4. 五段实战 SQL(可直接在 PG19 上跑)

### 4.1 金融风控:SQL/PGQ 多跳转账路径检测

```sql
-- 场景:检测账户 ACC-1001 经 1-4 跳转账到达黑名单账户的洗钱路径
-- PG19 之前:递归 CTE + 手工环路检测;PG19:GRAPH_TABLE 量词匹配

SELECT route.account_id, route.hops, route.total, route.path
FROM GRAPH_TABLE (financial_graph
  MATCH (a:account WHERE a.acct_id = 'ACC-1001')
        -[t:transfer]->{1,4} (b:account)
  COLUMNS (
    b.acct_id                      AS account_id,
    COUNT(t)                       AS hops,
    SUM(t.amount)                  AS total,
    '[' || string_agg(b.acct_id, ' -> ' ORDER BY t.ts) || ']' AS path
  )
) AS route
WHERE route.account_id IN (SELECT acct_id FROM blacklist)
ORDER BY route.hops, route.total DESC;

-- 与 PG18 递归 CTE 的对照:① {1,4} 量词直接表达深度范围;
-- ② 环路检测由图引擎负责,无需 NOT ... = ANY(route);
-- ③ 优化器按视图重写,可用 join_fact/dim 的统计信息做成本优化。
```

### 4.2 在线维护:REPACK CONCURRENTLY 在 24×7 热点表上回收空间

```sql
-- 场景:500GB 热点表 orders 膨胀到 640GB,需要在不停服的情况下回收空间
-- PG18:VACUUM FULL(锁表 40 分钟,不可接受) 或外挂 pg_repack
-- PG19:REPACK CONCURRENTLY,读写不阻塞

-- ① 确认逻辑复制槽容量(新增 GUC,默认值按实例负载评估)
SHOW max_repack_replication_slots;
SET max_repack_replication_slots = 4;

-- ② 在线重建(注意:CONCURRENTLY 不能用于整库形式,必须指定表名)
REPACK CONCURRENTLY orders;

-- ③ 按索引聚簇重建(等价于旧 CLUSTER,但不锁表)
REPACK CONCURRENTLY orders USING INDEX orders_created_at_idx;

-- ④ 验证空间回收
SELECT pg_size_pretty(pg_total_relation_size('orders')) AS total,
       pg_size_pretty(pg_relation_size('orders'))       AS heap,
       n_dead_tup, n_live_tup
FROM pg_stat_user_tables
WHERE relname = 'orders';
```

### 4.3 读写分离:WAIT FOR LSN 实现备库读己写

```sql
-- 场景:应用在主库写入订单后,需立刻在备库读到该记录(延迟敏感的读己写)
-- PG18:应用层轮询 pg_last_wal_replay_lsn(),消耗连接池
-- PG19:在备库会话内直接等待内核回放

-- ① 应用在主库写入并拿到该事务的 LSN
--    (主库执行)
INSERT INTO orders(id, status, amount)
VALUES ('ORD-9001', 'paid', 1280.00)
RETURNING pg_current_wal_lsn() AS commit_lsn;
--  → 0/15A0B1C0

-- ② 在备库会话内等待该 LSN 回放完成,再执行读
--    (备库执行)
WAIT FOR LSN '0/15A0B1C0' WITH (MODE 'standby_replay', TIMEOUT '2000', NO_THROW);
--  → success   (成功;若超时返回 'timeout',备库已提升则返回 'not in recovery')

SELECT id, status, amount FROM orders WHERE id = 'ORD-9001';

-- ③ 在应用层用 NO_THROW 做优雅降级(Python + psycopg)
--    no_throw = True 时 WAIT FOR 返回状态字符串而非抛错
```

```python
# PG19 的应用层封装:一次会话内等待,取代轮询循环
import psycopg

def write_then_read_pg19(order_id: str, amount: float) -> dict:
    with psycopg.connect(PRIMARY_DSN, autocommit=False) as pri:
        with pri.cursor() as cur:
            cur.execute(
                "INSERT INTO orders(id, status, amount) VALUES (%s, 'paid', %s) "
                "RETURNING pg_current_wal_lsn()::text",
                (order_id, amount))
            lsn = cur.fetchone()[0]
        pri.commit()

    with psycopg.connect(REPLICA_DSN) as rep:
        with rep.cursor() as cur:
            # 一次内核等待,替代 PG18 时代的 400 次轮询
            cur.execute(
                "WAIT FOR LSN %s WITH (MODE 'standby_replay', TIMEOUT '2000', NO_THROW)",
                (lsn,))
            status = cur.fetchone()[0]
            if status != 'success':                      # timeout / not in recovery
                return {'fallback': True, 'reason': status}
            cur.execute("SELECT * FROM orders WHERE id = %s", (order_id,))
            return cur.fetchone()
```

### 4.4 时态表:FOR PORTION OF 的三种边界情形

```sql
-- 场景:客户 C1 的税率记录是 [2026-01-01, 2026-07-01) -> 6%
--      现在要把 [2026-03-01, 2026-06-01) 的税率改成 8%

-- PG18:手写 3 条 SQL,边界全靠人脑保证
BEGIN;
UPDATE tax_rates
  SET valid_range = daterange('2026-01-01', '2026-03-01')
  WHERE customer = 'C1' AND valid_range && daterange('2026-03-01','2026-06-01');
UPDATE tax_rates
  SET valid_range = daterange('2026-06-01', '2026-07-01')
  WHERE customer = 'C1' AND valid_range && daterange('2026-03-01','2026-06-01');
INSERT INTO tax_rates(customer, tax_rate, valid_range)
  VALUES ('C1', 0.08, daterange('2026-03-01','2026-06-01'));
COMMIT;

-- PG19:一条 SQL,内核自动截断两侧 + 插入中段,边界不重叠不遗漏
BEGIN;
UPDATE tax_rates FOR PORTION OF valid_range
  FROM DATE '2026-03-01' TO DATE '2026-06-01'
  SET tax_rate = 0.08
  WHERE customer = 'C1';
COMMIT;
```

三种边界情形的内核行为:

| 情形 | 原记录区间 | 目标区间 | PG19 自动结果 |
|------|-----------|---------|--------------|
| 完整包含 | [01-01, 07-01) | [03-01, 06-01) | 左段 [01-01,03-01) + 新段 [03-01,06-01)→8% + 右段 [06-01,07-01) |
| 左对齐 | [01-01, 07-01) | [01-01, 04-01) | 新段 [01-01,04-01)→8% + 右段 [04-01,07-01) |
| 超出右界 | [01-01, 07-01) | [03-01, 09-01) | 新段覆盖到表范围边界,不越界 |

### 4.5 计划锁定:pg_plan_advice 从快照到回滚的完整流程

```sql
-- 场景:核心报表 SQL 在大版本升级后计划劣化(Hash Join → Nested Loop),做兜底
LOAD 'pg_plan_advice';

-- ① 变更前:抓「当前好计划」的 advice 快照
EXPLAIN (COSTS OFF, PLAN_ADVICE)
SELECT o.id, c.name, SUM(oi.qty * oi.price) AS total
FROM orders o
JOIN customers c ON c.id = o.customer_id
JOIN order_items oi ON oi.order_id = o.id
WHERE o.created_at >= DATE '2026-09-01'
GROUP BY o.id, c.name;
--  Generated Plan Advice:
--   JOIN_ORDER(c o oi)  HASH_JOIN(o)  HASH_JOIN(oi)  SEQ_SCAN(o c oi)  NO_GATHER(c o oi)

-- ② 把 advice 存进 pg_stash_advice(按 queryid 自动匹配,无需每次 SET)
--    pg_stash_advice 把「计划建议」变成可版本化的配置资产
INSERT INTO pg_stash_advice(queryid, advice)
VALUES (3358127118, 'JOIN_ORDER(c o oi) HASH_JOIN(o) HASH_JOIN(oi) SEQ_SCAN(o c oi) NO_GATHER(c o oi)');
-- 说明:queryid 可从 pg_stat_statements / pg_stat_activity 获取

-- ③ 变更后:若计划劣化,会话级立即回滚到快照
SET pg_plan_advice.advice = 'JOIN_ORDER(c o oi) HASH_JOIN(o) HASH_JOIN(oi) SEQ_SCAN(o c oi) NO_GATHER(c o oi)';

-- ④ 验证计划已被锁定
EXPLAIN (COSTS OFF) SELECT ...;   -- 确认计划回到 Hash Join

-- ⑤ 数据分布变化后必须解除锁定,否则优化器无法自适应
RESET pg_plan_advice.advice;
```

---

## 5. 性能与能力对比:PG19 vs PG18 vs 外挂方案

### 5.1 表重建方案 6 维度对比

| 维度 | VACUUM FULL (PG18) | CLUSTER (PG18) | pg_repack (外挂) | **REPACK CONCURRENTLY (PG19)** |
|------|-------------------|---------------|-----------------|------------------------------|
| 并发读写 | **全阻塞** | **全阻塞** | 允许 | **允许** |
| 锁级别 | AccessExclusive | AccessExclusive | 无(触发器) | **无(逻辑复制槽)** |
| 空间回收 | 完全 | 完全 | 完全 | **完全** |
| 物理排序 | 否 | **是** | 是 | **是(USING INDEX)** |
| 额外组件 | 无 | 无 | 需安装扩展 | **无(内核)** |
| 复制拓扑安全 | 是 | 是 | **弱(触发器方案)** | **是(逻辑解码)** |
| 需要主键 | 否 | 否 | **是** | **否** |

**关键差异**:pg_repack 的「需要主键」在大量无主键的历史归档表上是硬伤。REPACK CONCURRENTLY 基于逻辑复制槽,不需要主键(逻辑解码不依赖主键),这一点让它能覆盖 pg_repack 覆盖不了的场景。

### 5.2 图查询能力对比

| 维度 | 递归 CTE (PG18) | **SQL/PGQ (PG19)** | Apache AGE 扩展 | Neo4j |
|------|-----------------|-------------------|-----------------|-------|
| 路径量词 `{1,4}` | 手工递归 | **原生** | 原生 | 原生 |
| 环路检测 | 手工 | **自动** | 自动 | 自动 |
| 事务一致性 | **与业务同库** | **与业务同库** | 与业务同库 | **跨库(CDC)** |
| 计划成本优化 | 弱 | **按视图重写,可优化** | 中 | 图引擎 |
| 图算法(最短路/PageRank) | 手工 | **无(仅路径匹配)** | 部分 | **原生** |
| 额外部署成本 | 无 | **无** | 扩展 | **独立集群** |

**选型结论**:需要**强事务一致性的多跳遍历**(金融风控、权限继承)→ SQL/PGQ;需要**图算法和大规模图分析** → 仍需 Neo4j/AGE。**SQL/PGQ 的定位是「让 80% 的多跳需求不用离开 OLTP 库」**。

### 5.3 读己写方案对比

| 维度 | 应用层轮询 (PG18) | **WAIT FOR LSN (PG19)** | 同步复制(synchronous_commit) |
|------|------------------|----------------------|-----------------------------|
| 备库连接占用 | O(轮询次数) | **O(1)** | O(1) |
| 主库写延迟 | 无影响 | 无影响 | **增加(R 等待)** |
| 一致性保证 | 应用层易错 | **内核保证** | 强但代价高 |
| 超时控制 | 应用层自实现 | **TIMEOUT + NO_THROW** | timeout GUC |
| promotion 处理 | 应用层需感知 | **报错/状态返回** | 报错 |

---

## 6. 6 条 6-12 个月可验证硬指标

1. **REPACK CONCURRENTLY 在 500GB 热点表上的阻塞时长 = 0**。验收方式:在 pg_stat_activity 上观察 `REPACK CONCURRENTLY` 期间该表的并发 DML 数量不下降到 0;对比 PG18 `VACUUM FULL` 同表期间的零写入。**今天就能在 beta 上复现**。
2. **WAIT FOR LSN 使读己写的备库连接池占用降低 ≥ 90%**。验收:对比 PG18 轮询方案的连接池 active 数(400 次轮询 = 400 次连接获取)vs WAIT FOR 的 1 次。`TIMEOUT '2000'` + `NO_THROW` 下 P99 等待 < 500ms(同机房复制延迟 < 50ms 时)。
3. **SQL/PGQ 在 3-4 跳路径查询上比等价递归 CTE 快 1.5-3 倍**。验收:同一数据集,`EXPLAIN ANALYZE` 对比两者的执行时间与计划层级深度;PG19 按视图重写后可利用 join 顺序优化,递归 CTE 只能逐层执行。
4. **FOR PORTION OF 把时态更新的代码量从 3 条 SQL 降到 1 条,且边界 bug 归零**。验收:构造「目标区间与已有区间部分重叠」「左对齐」「超出右界」三种情形的回归测试,内核输出与手写 3 条 SQL 的结果集逐行 diff。
5. **pg_plan_advice 使计划回归的回滚时间从「调参 + 重启会话」的分钟级降到秒级**。验收:记录变更前 advice 快照,人为修改统计信息制造计划劣化,`SET pg_plan_advice.advice` 后 `EXPLAIN` 确认计划恢复。
6. **逻辑复制 failover 后序列冲突归零**。验收:PG18 流程下 `pg_dump` 时刻到 failover 之间的自增增量就是冲突窗口;PG19 的 `ALTER SUBSCRIPTION ... REFRESH SEQUENCES` 后,订阅端序列值 >= 主库当前值。

---

## 7. 6 条 6-12 个月可观察的未来信号

1. **SQL/PGQ 的生态采纳信号**:主流 ORM(Hibernate / Prisma / SQLAlchemy)是否在 2027 H1 加入 GRAPH_TABLE 的查询构造支持。若 ORM 跟进,属性图查询会从「DBA 手写」进入「应用层生成」,采纳曲线进入陡增段。
2. **REPACK CONCURRENTLY 的槽数治理**:看社区是否在 2027 年为 `max_repack_replication_slots` 引入自动扩缩或排队机制。当前固定槽数在高密度多表重建场景下可能成为新的瓶颈。
3. **pg_plan_advice 与 APM 的集成信号**:Datadog / pganalyze / pg_stat_statements 是否把 advice 快照纳入「计划变更告警」。**这是 plan advice 从 DBA 手工工具变成平台化能力的标志事件。**
4. **SQL/PGQ 是否补上图算法**:PG20 路线图若出现最短路径、PageRank、社区检测,PostgreSQL 将真正进入图数据库的射程。**这是判断「关系库多模化」是真是假的关键分水岭。**
5. **effective_wal_level 无重启开启逻辑复制的采纳率**:云厂商(RDS / Aurora / AlloyDB / 阿里云 RDS)在 2027 H1 是否把逻辑复制的开启延迟从「分钟级(含重启)」打到「秒级」。这直接决定 PG19 逻辑复制新特性的云上可用性。
6. **时态能力是否走向「系统版本时态表」(system-versioned tables)**:`FOR PORTION OF` 是应用层时态,若 PG20 跟进 SQL:2011 的 `FOR SYSTEM_TIME AS OF`,PostgreSQL 将补齐与 Oracle / DB2 / SQL Server 对齐的审计级时态能力。

---

## 8. 总结:从外挂依赖到内核自洽

### 8.1 该用(PG19 明确收益的场景)

- ✅ **24×7 OLTP 热点表的空间回收**:用 `REPACK CONCURRENTLY` 替换 VACUUM FULL / pg_repack,**先在预发环境验证 `max_repack_replication_slots` 容量再上生产**。
- ✅ **读写分离的读己写**:用 `WAIT FOR LSN ... NO_THROW` 替换应用层轮询,配合 `TIMEOUT` 做降级。
- ✅ **金融风控/权限继承的多跳遍历**:用 SQL/PGQ 把「另部署图库 + CDC 双写」的架构,收缩回单库事务一致性。
- ✅ **强时态业务(费率/合同/权限有效期)**:用 `FOR PORTION OF` 消除手写边界逻辑。
- ✅ **有 SLA 承诺的核心 SQL**:在大版本升级前用 `pg_plan_advice` 抓快照,作为计划回归的兜底。

### 8.2 千万别用(误用反模式)

- ❌ **不要把 `REPACK CONCURRENTLY` 当成定时 VACUUM 的替代品**。它重建整表,代价远高于普通 VACUUM。它用于**膨胀治理**而非**日常清理**。
- ❌ **不要对「查询性能不稳定」的 SQL 一律套 pg_plan_advice**。官方警告很明确:数据分布变化时,锁定的计划会变成很差的计划。**它是护栏,不是调优工具。**
- ❌ **不要把 SQL/PGQ 当作 Neo4j 的替代**。它没有图算法、没有图存储优化。它是「让 OLTP 库内的多跳需求不用出门」。
- ❌ **不要用 `standby_write` mode 做读己写**。它只保证 WAL 落到备库 OS 缓存,宕机可能丢数据。读己写的正确选择是默认的 `standby_replay`。
- ❌ **不要忽略 §8.3 的迁移清单**。`max_locks_per_transaction` 默认值从 64 变 128,JIT 默认关闭,这两条会改变容量规划。

### 8.3 从 PG18 迁移的 7 条避坑清单

| # | 变更 | 影响 | 应对 |
|---|------|------|------|
| 1 | `max_locks_per_transaction` 默认 **64 → 128** | 锁内存占用翻倍 | 容量评估:锁大小分配方式改变,旧设置需翻倍才等价 |
| 2 | **JIT 默认关闭**(原按 optimizer cost 启用) | 大分析查询变慢 | 大量 OLAP 查询的站点需手动 `SET jit = on` |
| 3 | **移除 RADIUS 认证支持** | 仅 UDP,不可修复的不安全 | 迁移到 LDAP / SCRAM |
| 4 | `standard_conforming_strings` **强制开启** | 旧 pg_dump 转储无法载入 | **必须用 PG19 的 pg_dump 重做转储** |
| 5 | btree_gist 的 `inet`/`cidr` opclass **损坏需重建** | pg_upgrade 会阻止升级 | 提前重建为 GiST opclass |
| 6 | 数据库名/角色名/表空间名**禁含 CR/LF** | 安全问题 | 提前排查并重命名 |
| 7 | `pg_stat_subscription_stats` 列 `sync_error_count` → `sync_table_error_count` | 监控查询失效 | 更新监控 SQL |

### 8.4 5 步生产迁移 checklist

1. **预发环境全量回归**:用 PG19 的 `pg_upgrade` 做演练,验证 §8.3 的 7 条不兼容项全部有解。
2. **转储工具对齐**:确认所有 pg_dump / pg_dumpall 使用 **PG19 版本**生成(因 `standard_conforming_strings` 强制开启)。
3. **JIT 决策**:分析 pg_stat_statements 里的大查询占比,决定是否全局或按库开启 `jit = on`。
4. **锁容量重估**:按新公式重新计算 `max_locks_per_transaction`,确认共享内存预算。
5. **保留旧快照**:升级前用 `pg_plan_advice` 抓核心 SQL 的 advice 快照 + 全套 `EXPLAIN` 输出,作为计划回归的对比基线。

---

## 写在最后

PostgreSQL 19 的这 6 个革新,表面上是 6 个新语法,实际上是**同一个工程哲学的落地:数据库应该自己能处理自己的运维问题**。

过去十年,PostgreSQL 生态的繁荣很大程度建立在「外挂工具补内核缺口」上——pg_repack 补空间回收、pg_hint_plan 补计划控制、应用层代码补读己写、Neo4j 补图查询。这种架构在规模小的时候是优势(内核保持简洁),但在 2026 年的云原生 OLTP 环境里,它变成了**运维碎片化**:每一个外挂都是一条独立的故障路径、一次额外的升级协调成本。

**PG19 把 6 条外挂路径一次性收进内核,这不是 feature 的堆叠,是架构重心的转移。** 对工程团队而言,一个可验证的判断标准是:**你的 PostgreSQL 运维清单上,还剩几个「必须装扩展才能解决」的项?** 如果答案是「很多」,那么 PG19 的升级价值就很高——因为这一版可能一次性消掉其中的一半。

而对整个关系型数据库市场,PG19 释放了一个更明确的信号:**「多模」不再等于「加一种存储类型」。** SQL/PGQ 证明了一种更轻的多模路径——不动存储,只动建模语义。如果这条路在 PG20 被延续(补图算法、补系统版本时态表),那么「专门用途数据库」的生存空间会被进一步压缩。**关系型数据库的护城河,从来不是它存了什么,而是它让 SQL 表达了什么。**
