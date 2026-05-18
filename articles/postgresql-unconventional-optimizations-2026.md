---
title: "PostgreSQL 非常规优化：三个被忽视的性能提升技巧"
date: 2026-05-18
category: 技术
tags: [PostgreSQL, 数据库, 性能优化, SQL, 索引, 数据库架构]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1544383835-bda2bc66a55d?w=600&h=400&fit=crop
---

# PostgreSQL 非常规优化：三个被忽视的性能提升技巧

PostgreSQL 是世界上最先进的开源关系型数据库之一，但即便是经验丰富的 DBA，也往往只用到了它冰山一角的能力。本文介绍三种非常规但极其有效的优化技巧——它们不涉及硬件升级、不依赖复杂的调参，却能带来数量级的性能提升。

这些技巧来自 Haki Benita 的深度技术文章，在 Hacker News 上获得了 431 个赞和 300+ 条讨论。让我们逐个拆解。

---

## 一、用 CHECK 约束消除全表扫描

### 问题场景

假设你有一张用户表，其中 `plan` 字段只有 `'free'` 和 `'pro'` 两个合法值：

```sql
CREATE TABLE users (
    id INT PRIMARY KEY,
    username TEXT NOT NULL,
    plan TEXT NOT NULL,
    CONSTRAINT plan_check CHECK (plan IN ('free', 'pro'))
);
```

插入 10 万条数据后，一位分析师写了这样一条查询：

```sql
SELECT * FROM users WHERE plan = 'Pro';  -- 注意大写 P
```

结果返回 0 行。因为实际值是 `'pro'`（小写），不是 `'Pro'`。这是个常见的人为错误，但代价是什么？

```sql
EXPLAIN ANALYZE SELECT * FROM users WHERE plan = 'Pro';
-- Seq Scan on users  (cost=0.00..2185.00 rows=100000 ...)
-- Execution Time: 45.123 ms
```

PostgreSQL 执行了一次**全表扫描**，读取了 10 万行数据，然后返回 0 行。明明 CHECK 约束已经告诉我们 `'Pro'` 不可能是合法值，但查询规划器并没有利用这个信息。

### 解决方案：constraint_exclusion

PostgreSQL 提供了一个隐藏参数 `constraint_exclusion`，启用后查询规划器会在生成执行计划时检查 CHECK 约束：

```sql
SET constraint_exclusion TO 'on';

EXPLAIN ANALYZE SELECT * FROM users WHERE plan = 'Pro';
-- Result  (cost=0.00..0.00 rows=0 ...)
-- Planning Time: 0.1 ms
-- Execution Time: 0.01 ms
```

从 45ms 降到 0.01ms——**4500 倍的性能提升**，仅仅因为 PostgreSQL 在规划阶段就判断出这个条件永远为假。

### 为什么默认关闭？

`constraint_exclusion` 默认值是 `partition`，只对分区表生效。全表开启会增加规划器的工作量——它需要对每条查询的每个条件逐一检查所有相关约束。对于简单的 OLTP 查询，这个开销可能得不偿失。

**适用场景**：
- BI / 报表环境：分析师手写查询，人为错误频率高
- 分区表：已经是标配，确保分区裁剪正常工作
- 数据校验严格的表：CHECK 约束丰富的表收益最大

```sql
-- postgresql.conf 或 per-session 设置
constraint_exclusion = partition  -- 默认值，只对分区表生效
constraint_exclusion = on         -- 对所有表生效，适合 BI 环境
```

---

## 二、虚拟生成列 + 函数索引：告别"纪律问题"

### 问题场景

你有一张销售表：

```sql
CREATE TABLE sale (
    id INT PRIMARY KEY,
    sold_at TIMESTAMPTZ NOT NULL,
    charged INT NOT NULL
);
```

分析师需要按天汇总销售额。你创建了一个函数索引：

```sql
CREATE INDEX sale_sold_at_date_ix 
ON sale((date_trunc('day', sold_at AT TIME ZONE 'UTC'))::date);
```

索引大小只有完整时间戳索引的 1/4，查询也更快。但问题是——分析师必须**精确使用完全相同的表达式**才能命中索引：

```sql
-- ✅ 命中索引
SELECT (date_trunc('day', sold_at AT TIME ZONE 'UTC'))::date, SUM(charged)
FROM sale
WHERE date_trunc('day', sold_at AT TIME ZONE 'UTC') BETWEEN '2025-01-01' AND '2025-01-31'
GROUP BY 1;

-- ❌ 无法命中索引（表达式略有不同）
SELECT (sold_at AT TIME ZONE 'UTC')::date, SUM(charged)
FROM sale
WHERE (sold_at AT TIME ZONE 'UTC')::date BETWEEN '2025-01-01' AND '2025-01-31'
GROUP BY 1;
```

这就是作者所说的**"纪律问题"**——在任何组织中，指望每个人都写出完全一致的表达式是不现实的。

### PostgreSQL 18 的解决方案：虚拟生成列

PostgreSQL 14 引入了生成列（Generated Columns），但它是**存储型**的——数据物理写入磁盘，增加存储开销。PostgreSQL 18 带来了**虚拟生成列**：

```sql
ALTER TABLE sale ADD sold_at_date DATE
GENERATED ALWAYS AS (date_trunc('day', sold_at AT TIME ZONE 'UTC'));
```

虚拟列不存储数据，每次读取时动态计算。现在分析师可以像普通列一样使用它：

```sql
SELECT sold_at_date, SUM(charged)
FROM sale
WHERE sold_at_date BETWEEN '2025-01-01' AND '2025-01-31'
GROUP BY 1;
```

**优势分析**：

| 维度 | 函数索引 | 虚拟生成列 |
|------|---------|-----------|
| 索引大小 | 小 | 同样小 |
| 查询速度 | 快 | 同样快 |
| 使用门槛 | 必须精确匹配表达式 | 当普通列用即可 |
| 团队协作 | 需要纪律 | 无需纪律 |
| 存储开销 | 仅索引 | 零（虚拟列不存储） |

### 当前限制

截至 PostgreSQL 18，虚拟生成列**尚不支持直接创建索引**：

```sql
CREATE INDEX sale_sold_at_date_ix ON sale(sold_at_date);
-- ERROR: indexes on virtual generated columns are not supported
```

你仍然需要在底层表达式上创建函数索引，但查询层面已经可以使用虚拟列名了。这是一个半成品的优雅方案——查询端的"纪律问题"已经解决，索引端的限制有望在 PostgreSQL 19 中解除。

---

## 三、用 Hash 索引 + 排除约束实现高效唯一性

### 问题场景

你有一张 URL 表，用于去重处理：

```sql
CREATE TABLE urls (
    id INT PRIMARY KEY,
    url TEXT NOT NULL,
    data JSON
);
```

插入 100 万条数据后，URL 平均长度 60 字节。你用 B-Tree 索引强制唯一性：

```sql
CREATE UNIQUE INDEX urls_url_unique_ix ON urls(url);
```

B-Tree 索引的大小？**128 MB**。因为 B-Tree 在叶节点存储完整的 URL 值。

### Hash 索引的优势

PostgreSQL 的 Hash 索引只存储哈希值（固定 8 字节），不存储原始值：

```sql
-- 但 Hash 索引不支持 UNIQUE！
CREATE UNIQUE INDEX urls_url_unique_hash ON urls USING HASH(url);
-- ERROR: access method "hash" does not support unique indexes
```

怎么办？用一个鲜为人知的特性——**排除约束（Exclusion Constraint）**：

```sql
ALTER TABLE urls 
ADD CONSTRAINT urls_url_unique_hash 
EXCLUDE USING HASH (url WITH =);
```

这创建了一个基于 Hash 索引的排除约束，效果等同于唯一约束——插入重复 URL 会报错。

### 性能对比

| 指标 | B-Tree UNIQUE | Hash 排除约束 |
|------|--------------|--------------|
| 索引大小 | 128 MB | 32 MB |
| 等值查询 | 快 | 同样快 |
| 范围查询 | ✅ 支持 | ❌ 不支持 |
| 外键引用 | ✅ 支持 | ❌ 不支持 |
| ON CONFLICT | ✅ 完全支持 | ⚠️ 部分支持 |

索引大小缩小到 1/4，等值查询性能相当。对于 URL 去重、会话令牌、API Key 这类**大文本 + 只做等值查询**的场景，这是巨大的存储优化。

### 限制和替代方案

Hash 排除约束有几个重要限制：

**1. 不支持外键引用**

```sql
CREATE TABLE page_visits (url TEXT REFERENCES urls(url));
-- ERROR: there is no unique constraint matching given keys
```

**2. ON CONFLICT 行为受限**

```sql
-- ❌ 不能用字段名
INSERT INTO urls (id, url) VALUES (1, 'https://example.com')
ON CONFLICT (url) DO NOTHING;
-- ERROR: there is no unique or exclusion constraint matching

-- ✅ 必须用约束名
INSERT INTO urls (id, url) VALUES (1, 'https://example.com')
ON CONFLICT ON CONSTRAINT urls_url_unique_hash DO NOTHING;

-- ❌ ON CONFLICT DO UPDATE 不支持
-- ✅ 替代方案：用 MERGE
MERGE INTO urls t
USING (VALUES (1, 'https://example.com')) AS s(id, url)
ON t.url = s.url
WHEN MATCHED THEN UPDATE SET id = s.id
WHEN NOT MATCHED THEN INSERT (id, url) VALUES (s.id, s.url);
```

**适用场景**：
- URL 去重 / 爬虫去重
- 会话令牌 / API Key 唯一性
- 任何大文本字段的等值唯一约束
- 不需要外键引用的场景

---

## 实战决策树

面对一张表的性能问题，如何选择合适的优化策略？

```
查询慢？
├── 全表扫描 + 有 CHECK 约束？
│   └── 启用 constraint_exclusion
├── 索引命中但表达式不匹配？
│   └── 虚拟生成列（PG18+）
├── 索引太大？
│   ├── 值很大 + 只做等值查询？
│   │   └── Hash 索引 + 排除约束
│   └── 需要范围查询？
│       └── B-Tree 但考虑降精度（函数索引）
└── 以上都不是？
    └── 回到常规优化：EXPLAIN ANALYZE、VACUUM、统计信息
```

---

## 最佳实践总结

1. **constraint_exclusion = on** 在 BI 环境中几乎免费，能在分析师写错条件时避免灾难性全表扫描
2. **虚拟生成列**是 PG18 的杀手级特性，彻底解决函数索引的"纪律问题"——让团队不需要记住复杂的表达式
3. **Hash 排除约束**是大文本去重的利器，索引大小可以缩小到 B-Tree 的 1/4 甚至更小
4. 这三种优化都**不需要改应用代码**，是纯数据库层面的改进
5. 在生产环境应用前，务必用 `EXPLAIN ANALYZE` 验证效果——优化器的行为因数据分布而异

PostgreSQL 的深度远超大多数人的想象。正如 HN 用户 `sc68cal` 所说：

> "我用了 PostgreSQL 十几年，每次深入文档都有一种'我只摸到了皮毛'的感觉。它太强大了。"

---

*相关阅读：*

- [Docker Compose 生产环境实战指南（2026）](/article/docker-compose-production-2026-guide)
- [工作量证明反爬虫系统深度剖析](/article/proof-of-work-anti-bot-systems-2026)
