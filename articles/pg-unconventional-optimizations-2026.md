---
title: "超越索引：PostgreSQL 那些不为人知的非常规优化技巧"
date: 2026-05-26
category: 技术
tags: [PostgreSQL, 数据库, 性能优化, SQL, 后端架构, 索引]
author: 林小白
readtime: 15
cover: https://images.unsplash.com/photo-1544383835-bda2bc66a55d?w=600&h=400&fit=crop
---

# 超越索引：PostgreSQL 那些不为人知的非常规优化技巧

提到数据库优化，大多数开发者的工具箱里只有那么几样东西：加索引、改写查询、EXPLAIN ANALYZE 看看执行计划、VACUUM、CLUSTER…… 这些常规手段确实有效，但 PostgreSQL 的能力远不止于此。

本文介绍三种你可能从未用过的非常规优化技巧——它们不改架构、不加硬件，却能带来数量级的性能提升。

## 一、constraint_exclusion：让数据库跳过"不可能"的查询

### 问题场景

假设你有一张用户表，`plan` 字段只有两个合法值：`'free'` 和 `'pro'`，并设置了 CHECK 约束：

```sql
CREATE TABLE users (
    id INT PRIMARY KEY,
    username TEXT NOT NULL,
    plan TEXT NOT NULL,
    CONSTRAINT plan_check CHECK (plan IN ('free', 'pro'))
);

-- 插入 10 万条数据
INSERT INTO users
SELECT n, uuid_generate_v4(), (ARRAY['free', 'pro'])[ceil(random()*2)]
FROM generate_series(1, 100000) AS t(n);

ANALYZE users;
```

某天，一个分析师手抖写出了这样的查询：

```sql
SELECT * FROM users WHERE plan = 'Pro';  -- 注意大写 P
```

结果返回 0 行。但他不知道的是，这个查询扫描了整张表：

```
Seq Scan on users  (cost=0.00..2185.00 rows=1 width=45)
                   (actual time=7.406..7.407 rows=0.00 loops=1)
  Filter: (plan = 'Pro'::text)
  Rows Removed by Filter: 100000
  Buffers: shared hit=935
Execution Time: 7.436 ms
```

明明 CHECK 约束保证了 `plan` 只可能是 `'free'` 或 `'pro'`，查询 `'Pro'` 必然返回空——为什么 PostgreSQL 不跳过这次全表扫描？

### 解决方案

PostgreSQL 其实有这个能力，只是默认没有开启。设置 `constraint_exclusion` 参数即可：

```sql
SET constraint_exclusion TO 'on';

EXPLAIN ANALYZE SELECT * FROM users WHERE plan = 'Pro';
```

```
Result  (cost=0.00..0.00 rows=0 width=0)
        (actual time=0.000..0.001 rows=0.00 loops=1)
  One-Time Filter: false
Planning Time: 5.760 ms
Execution Time: 0.008 ms
```

执行时间从 7.4ms 降到 0.008ms——接近 1000 倍的提升！PostgreSQL 在规划阶段就根据 CHECK 约束判断出条件永远为 false，直接跳过了扫描。

### 为什么默认不开启？

默认值是 `partition`，只对分区表的继承树启用约束排除（即分区裁剪）。对所有表启用会增加规划开销，对于简单的 OLTP 查询，这个开销可能大于收益。

**但在 BI/报表环境中，强烈建议开启。** 分析师手写 SQL 犯错是常态，一条错误的全表扫描可能吃掉大量 I/O。在 `postgresql.conf` 中设置：

```conf
constraint_exclusion = on
```

或在特定数据库/用户级别设置：

```sql
ALTER DATABASE reporting_db SET constraint_exclusion TO 'on';
```

### 适用场景

- 报表系统、数据仓库等 ad-hoc 查询密集的环境
- 使用 CHECK 约束做过数据校验的表
- 分区表（默认已启用分区裁剪）

## 二、虚拟生成列 + 函数索引：PG 18 的杀手锏

### 问题场景

你有一张千万行的销售表：

```sql
CREATE TABLE sale (
    id INT PRIMARY KEY,
    sold_at TIMESTAMPTZ NOT NULL,
    charged INT NOT NULL
);

INSERT INTO sale (id, sold_at, charged)
SELECT
    n,
    '2025-01-01 UTC'::timestamptz + (interval '5 seconds') * n,
    ceil(random() * 100)
FROM generate_series(1, 10000000) AS t(n);

ANALYZE sale;
```

分析师经常按天汇总销售额：

```sql
SELECT date_trunc('day', sold_at AT TIME ZONE 'UTC')::date, SUM(charged)
FROM sale
WHERE date_trunc('day', sold_at AT TIME ZONE 'UTC')::date
      BETWEEN '2025-01-01' AND '2025-01-31'
GROUP BY 1;
```

全表扫描耗时约 627ms。你尝试加 B-Tree 索引：

```sql
CREATE INDEX sale_sold_at_ix ON sale(sold_at);
```

查询降到 187ms，但索引大小 214MB——接近表大小的一半！更糟的是，分析师改写查询用了 `::date` 而不是 `date_trunc`，索引就失效了，又回到全表扫描。

### 解决方案：函数索引 + 虚拟列

**第一步：创建精确匹配的函数索引**

```sql
CREATE INDEX sale_sold_at_date_ix ON sale (
    (date_trunc('day', sold_at AT TIME ZONE 'UTC')::date)
);
```

索引大小只有 154MB，查询降到 145ms。但问题还在——分析师可能用不同的表达式，索引就废了。

**第二步：用虚拟生成列强制统一表达式（PG 18）**

PostgreSQL 18 引入了虚拟生成列（Virtual Generated Columns）——列的值在每次访问时实时计算，不占用额外存储：

```sql
ALTER TABLE sale
ADD sold_at_date DATE
GENERATED ALWAYS AS (date_trunc('day', sold_at AT TIME ZONE 'UTC'));
```

现在分析师可以直接用这个列：

```sql
SELECT sold_at_date, SUM(charged)
FROM sale
WHERE sold_at_date BETWEEN '2025-01-01' AND '2025-01-31'
GROUP BY 1;
```

PostgreSQL 自动将虚拟列的表达式与函数索引匹配，查询走索引、145ms 完成。分析师不需要知道底层表达式是什么，也不可能写错。

### 为什么不用物化列？

PG 14 就支持 `STORED` 生成列，但物化列会把计算结果存到磁盘上——千万行表意味着额外几十 GB 存储，加上写入时的计算开销。虚拟列零存储开销，读时计算，配合索引完美匹配。

### 适用场景

- 需要对复杂表达式建索引（时区转换、JSON 提取、数学计算）
- 多个应用/分析师查询同一张表，表达式写法不统一
- 想要"计算列"的便利性但不想付出存储代价

## 三、Hash 索引 + 排他约束：5 倍压缩的唯一性保证

### 问题场景

你有一张 URL 表，每个 URL 可能长达几百字节：

```sql
CREATE TABLE urls (
    id INT PRIMARY KEY,
    url TEXT NOT NULL
);

-- 插入 100 万个 URL
INSERT INTO urls (id, url)
SELECT n, 'https://example.com/path/' || uuid_generate_v4() || '/very/long/resource'
FROM generate_series(1, 1000000) AS t(n);
```

需要保证 URL 唯一，常规做法是加 B-Tree 唯一索引：

```sql
CREATE UNIQUE INDEX urls_url_unique_ix ON urls(url);
-- 索引大小：154 MB
```

### 更好的方案：Hash 索引

Hash 索引只存储值的哈希，不存储原始值。对于长文本字段，压缩效果惊人：

```sql
-- PostgreSQL 不支持 Hash 唯一索引……
CREATE UNIQUE INDEX urls_url_unique_hash ON urls USING HASH(url);
-- ERROR: access method "hash" does not support unique indexes
```

但我们可以用**排他约束（Exclusion Constraint）**绕过这个限制：

```sql
ALTER TABLE urls
ADD CONSTRAINT urls_url_unique_hash
EXCLUDE USING HASH (url WITH =);
```

这创建了一个基于 Hash 索引的排他约束，效果等同于唯一约束：

```sql
INSERT INTO urls VALUES (1000002, 'https://example.com/existing');
-- OK

INSERT INTO urls VALUES (1000003, 'https://example.com/existing');
-- ERROR: conflicting key value violates exclusion constraint
```

索引大小对比：

```
urls_url_unique_ix   │ btree │ 154 MB
urls_url_unique_hash │ hash  │  32 MB
```

Hash 索引只有 B-Tree 的 1/5！查询速度也更快：

```sql
-- B-Tree: 0.046ms
-- Hash:  0.022ms（快 2 倍）
```

### 使用 MERGE 绕过 ON CONFLICT 的限制

排他约束不支持 `ON CONFLICT ... DO UPDATE`，但可以用 PG 的 `MERGE` 语句替代：

```sql
MERGE INTO urls t
USING (VALUES (1000004, 'https://example.com/new')) AS s(id, url)
ON t.url = s.url
WHEN MATCHED THEN UPDATE SET id = s.id
WHEN NOT MATCHED THEN INSERT (id, url) VALUES (s.id, s.url);
```

`MERGE` 能正常使用 Hash 索引，执行计划确认了 Index Scan。

### 注意事项

- **不能被外键引用**：外键要求引用唯一约束，排他约束不满足这个条件
- **Hash 碰撞**：理论上存在哈希碰撞的可能，但 PostgreSQL 的 Hash 函数在实际使用中碰撞概率极低
- **不支持 `ON CONFLICT DO UPDATE`**：需要用 `MERGE` 替代
- **WAL 支持**：PG 10+ 的 Hash 索引已完全支持 WAL 和流复制

### 适用场景

- URL、UUID、哈希值等长文本字段的唯一性约束
- 对存储空间敏感的场景（大表、云数据库按存储计费）
- 不需要范围查询（Hash 索引只支持 `=` 操作）

## 实战建议：什么时候用这些技巧？

| 技巧 | 适用场景 | 收益 | 风险 |
|------|---------|------|------|
| `constraint_exclusion = on` | 报表/BI 系统 | 避免错误查询的全表扫描 | 规划时间略增 |
| 虚拟生成列 + 函数索引 | 复杂表达式查询 | 索引匹配 + 零存储 | 仅 PG 18+ |
| Hash 索引 + 排他约束 | 长文本唯一性 | 5 倍存储压缩 | 不能被外键引用 |

### 性能对比总览

以千万行销售表为例，按天汇总查询：

```
全表扫描：                    627ms
B-Tree 索引（全列）：          187ms  索引 214MB
函数索引：                     145ms  索引 154MB
虚拟列 + 函数索引：            145ms  索引 154MB  零额外存储
```

以百万行 URL 表为例，唯一性约束：

```
B-Tree 唯一索引：              0.046ms  索引 154MB
Hash 排他约束：                0.022ms  索引  32MB
```

## 总结

PostgreSQL 的深度远超大多数开发者的认知。这三个技巧的共同特点是：

1. **不改架构**：不需要分库分表、不需要引入新组件
2. **不加硬件**：纯软件层面的优化
3. **可逆**：随时可以回退，不影响数据

下次面对性能问题时，在考虑"加机器"之前，先看看 PostgreSQL 的文档——你可能会发现，答案一直就在数据库里。

---

*相关阅读：*

- [io_uring：Linux I/O 的范式革命](/article/io-uring-linux-io-revolution-2026)
- [WebGPU：浏览器终于拿到了显卡的钥匙](/article/webgpu-browser-gpu-revolution-2026)
