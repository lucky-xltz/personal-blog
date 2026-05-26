---
title: "SQLite 文艺复兴：从嵌入式玩具到国会图书馆认证的工业级数据库"
date: 2026-05-26
category: 技术
tags: [SQLite, 数据库, 性能优化, 后端架构, 数据持久化, WAL, Litestream]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1544383835-bda2bc66a55d?w=600&h=400&fit=crop
---

# SQLite 文艺复兴：从嵌入式玩具到国会图书馆认证的工业级数据库

如果你在 2020 年之前问一个后端工程师"SQLite 能用于生产环境吗"，大概率会收到一个意味深长的微笑。这个被贴上"嵌入式玩具数据库"标签长达二十年的项目，正在经历一场静悄悄的文艺复兴。

美国国会图书馆将其列为推荐数据存储格式。有人在十亿行数据上跑出了 10 万 TPS。Rails 8 将其作为默认数据库。Litestream 让它拥有了流式复制能力。这不是 SQLite 的中年危机，而是它的高光时刻。

## 一、国会图书馆的背书：为什么是 SQLite？

2018 年，美国国会图书馆（Library of Congress）将 SQLite 列为推荐的数据集存储格式。当时唯一获此殊荣的其他格式是 XML、JSON 和 CSV——都是纯文本格式。一个二进制数据库文件，凭什么与人类可读的文本格式并列？

国会图书馆在评估推荐格式时，考量了七个维度：

**披露度（Disclosure）**：SQLite 的完整规格文档公开可查。不像某些"开放标准"需要付费获取规范文档，SQLite 的文件格式规范（SQLite File Format）完全免费，任何人都可以据此编写兼容的读取器。

**采用度（Adoption）**：SQLite 可能是世界上部署最广泛的数据库。每一部 iPhone、每一个 Chrome 浏览器、每一个 Python 安装都包含 SQLite。据估计，全球有超过一万亿个 SQLite 数据库在运行。

**透明度（Transparency）**：虽然 SQLite 是二进制格式，但 `sqlite3` 命令行工具可以将其内容以人类可读的形式导出。一个 `.sqlite` 文件可以随时转换为 SQL 文本或 CSV。

**自文档性（Self-documentation）**：SQLite 数据库文件包含完整的表结构定义（`sqlite_master` 表），无需外部 schema 文件即可理解数据含义。

**外部依赖**：SQLite 的运行时依赖为零。不需要安装服务器、不需要守护进程、不需要配置文件。一个 C 库文件，或者干脆什么都不需要——大多数编程语言都内置了 SQLite 支持。

**专利风险**：SQLite 的代码进入公共领域（public domain），没有专利限制。

**技术保护机制**：没有加密、没有 DRM，数据完全开放。

这七个维度揭示了一个深层逻辑：**长期数据保存的最大敌人不是技术过时，而是依赖链断裂**。一个需要 PostgreSQL 15 + Python 3.11 + Django 4.2 才能读取的数据集，在五十年后可能已经无法访问。但一个 SQLite 文件，即使只剩下一个能编译 C 代码的环境，就能被完整读取。

正如一位 HN 用户评论的："几百年后的数据考古学家一定会在他们的工具箱里放着 SQLite。能创造出如此持久的东西，一定是种奇怪的感觉。"

## 二、十亿行上的十万 TPS：性能神话的解构

"SQLite 没有 MVCC！SQLite 只支持单写入者！SQLite 是给手机用的！"——这些耳熟能详的"常识"，在 Anders Murphy 的基准测试面前显得苍白无力。

### 测试环境

他在一台普通服务器上，向 SQLite 和 PostgreSQL 各导入了 **十亿行** 数据，然后模拟真实的交互式事务——不是简单的批量写入，而是包含应用层代码执行的完整事务周期。

### 核心发现

**PostgreSQL 的网络瓶颈**：

当应用服务器与数据库之间存在 5ms 网络延迟时，PostgreSQL 的 TPS 从 13,756 骤降至 1,214。加上串行化隔离级别（SQLite 默认就是串行化），TPS 进一步暴跌到 **6**。

这不是 PostgreSQL 的错。这是阿姆达尔定律（Amdahl's Law）的无情体现：当事务需要跨越网络持有行锁时，网络延迟成为了不可逾越的硬限制。无论你加多少 CPU、多少内存、多少服务器，都无法突破这个瓶颈。

**SQLite 的本地优势**：

同样的事务负载，SQLite 在本地文件系统上跑出了 **44,096 TPS**——是 PostgreSQL 在 5ms 延迟下的 36 倍。通过动态批处理（dynamic batching），SQLite 的 TPS 进一步飙升到 **186,157**。即使加上 SAVEPOINT 保证事务隔离性，依然维持在 **121,922 TPS**。

### 为什么单写入者反而是优势

SQLite 的"缺陷"——单写入者模型——在高并发场景下反而成为了性能优势的来源：

1. **无锁竞争**：不需要行锁、表锁、MVCC 快照隔离的开销
2. **批量优化**：单写入者天然适合事务批量提交，摊薄 fsync 成本
3. **零网络开销**：数据在本地磁盘，不存在网络往返延迟
4. **WAL 模式**：写入追加到 WAL 文件，读取者继续读主文件，并发读不阻塞

关键的性能调优参数：

```sql
PRAGMA journal_mode = WAL;           -- 写入前日志，允许并发读
PRAGMA synchronous = NORMAL;         -- 平衡性能与持久性
PRAGMA cache_size = -15625;          -- 15MB 缓存（负数单位为 KiB）
PRAGMA temp_store = MEMORY;          -- 临时表存内存
PRAGMA busy_timeout = 5000;          -- 5 秒锁等待超时
PRAGMA mmap_size = 268435456;        -- 256MB 内存映射
```

### 帕托分布下的真实压力

Anders 的测试使用了帕托分布（Pareto Distribution）来模拟真实世界的访问模式——少数账户承载大量交易，类似信用卡支付系统中 Amazon、Walmart 占据绝大多数交易的场景。

在这种极端不均匀的负载下，网络数据库的行锁竞争会被放大到灾难性的程度。而 SQLite 由于没有网络往返，天然免疫这个问题。

## 三、SQLite 在生产环境：血泪教训与实战智慧

理论上的性能数据令人兴奋，但真实的生产环境充满陷阱。一个运行在 SQLite 上的电商网站（处理真实的 Stripe 支付）分享了他们的实战经验。

### WAL 模式：并非万能药

WAL（Write-Ahead Logging）是 SQLite 并发能力的基石。它改变了写入模型：写入者追加到单独的 `-wal` 文件，而非直接修改主数据库文件。读取者继续从主文件读取，互不干扰。

```yaml
# Rails 8 的 SQLite 配置
production:
  primary:
    database: storage/production.sqlite3
  cache:
    database: storage/production_cache.sqlite3
  queue:
    database: storage/production_queue.sqlite3
  cable:
    database: storage/production_cable.sqlite3
```

四个 SQLite 数据库，一个 Docker 卷。这是 SQLite 的优雅之处——每个功能模块一个独立的数据库文件，备份就是简单的文件复制。

### 部署重叠：消失的订单

但优雅的背后藏着定时炸弹。当快速连续部署时——11 次提交在 2 小时内触发了 11 次蓝绿部署——容器重叠窗口开始叠加。容器 A 还在排空请求，容器 B 已经启动，容器 C 的部署又开始了。

结果：两笔 Stripe 支付成功的订单，永远消失在了数据库里。

```sql
SELECT * FROM sqlite_sequence WHERE name='orders';
-- seq: 17

SELECT MAX(id) FROM orders;
-- max: 15
```

自增计数器说分配了 17 个 ID，但只有 15 行数据。钱收了，记录没了。

**根因分析**：这不是 SQLite 的问题，而是部署流水线的问题。PostgreSQL 能在这种场景下正常工作，因为连接通过 TCP socket——新容器连接到同一个 PostgreSQL 服务器，数据库引擎管理写入顺序。但 SQLite 的写入顺序依赖文件系统级锁，在共享 Docker 卷上的容器重叠时会崩溃。

**解决方案**不是技术性的，而是流程性的：批量提交变更，避免快速连续推送。正如他们在 AI 代理治理文件中写的：

> 避免快速连续推送到 main——11 次推送/2 小时导致 Kamal 部署重叠，SQLite 并发访问丢失了订单 16/17。

### sqlite_sequence：被低估的调试利器

`sqlite_sequence` 表追踪每个表的最高自增值——即使该行已被删除。这是一个被严重低估的调试工具：

```ruby
def count_historical_tasks
  result = ActiveRecord::Base.connection.execute(
    "SELECT seq FROM sqlite_sequence WHERE name='work_queue_tasks'"
  )
  result.first&.fetch("seq", 0) || 0
end

# WorkQueueTask.count 返回 ~300（当前行数）
# sqlite_sequence 显示 3,700+（历史上创建的所有任务）
# 如果这两个数字意外偏离，说明有东西删除了不该删除的行
```

### 从 PostgreSQL 迁移的陷阱

SQLite 不是 PostgreSQL 的直接替代品，迁移时有几个常见的坑：

**没有 ILIKE**：PostgreSQL 开发者本能地写 `WHERE name ILIKE '%term%'`，SQLite 会报语法错误。用 `WHERE LOWER(name) LIKE '%term%'` 替代。

**json_extract 返回原生类型**：`json_extract(data, '$.id')` 如果存储的是数字，返回的是整数而非字符串。与字符串比较会静默失败。需要 `CAST(json_extract(...) AS TEXT)`。

**外键约束的破坏性**：在 Rails + SQLite 中，一个看似无害的 `add_foreign_key` 操作可能擦除整个生产表的数据。SQLite 的 `ALTER TABLE` 支持有限，某些迁移操作会触发表重建。

### SQLITE_BUSY：配置不是解决方案

```yaml
# config/database.yml
timeout: 5000  # 5 秒锁等待
```

`timeout` 是安全网，不是解决方案。如果频繁遇到 `SQLITE_BUSY`，说明应用层存在写入竞争问题，需要在架构层面解决——减少写入频率、优化事务范围、引入写入队列。

### 备份：用 sqlite3 .backup，不要用 cp

```bash
# ❌ 危险：可能抓到半写入的文件
cp production.sqlite3 backup.sqlite3

# ✅ 安全：sqlite3 .backup API 正确处理 WAL 模式
sqlite3 production.sqlite3 '.backup backup.sqlite3'
```

## 四、SQLite 生态系统的爆发

SQLite 的复兴不仅仅是因为它本身足够好，更因为围绕它构建的生态系统正在爆发式增长。

### Litestream：流式复制

Litestream 解决了 SQLite 最大的短板——没有内置的复制机制。它监听 WAL 文件的变化，实时流式备份到 S3、Azure Blob 或其他存储后端。

```bash
# 安装并配置 Litestream
litestream replicate /data/production.sqlite3 s3://mybucket/db

# 恢复到指定时间点
litestream restore -timestamp 2026-05-26T12:00:00Z /data/production.sqlite3
```

Litestream v0.5.0 带来了重大更新，包括 VFS（虚拟文件系统）层的改进，让复制更加可靠。Fly.io（Litestream 的维护者）甚至推出了可写的 VFS，让 SQLite 拥有了类似分布式数据库的写入能力。

### libSQL/Turso：SQLite 的分布式进化

Turso 基于 libSQL（SQLite 的开源 fork），提供了边缘数据库服务。它保持了 SQLite 的嵌入式特性，同时添加了分布式复制和 HTTP API。

### SQLite Online：11 年的单人开发

SQLite Online 是一个完全在浏览器中运行的 SQLite 环境，拥有 11,000 日活用户。这个项目由一个人独立开发了 11 年，证明了 SQLite 的稳定性和可维护性。

### 22GB 的 Hacker News 数据

有人将完整的 Hacker News 数据集（22GB）导入 SQLite，并构建了一个查询界面。这展示了 SQLite 处理大规模数据集的能力——在正确的索引和配置下，几十 GB 的数据库依然响应迅速。

## 五、何时使用 SQLite，何时选择 PostgreSQL

SQLite 不是 PostgreSQL 的替代品，而是互补品。选择的关键在于理解你的工作负载特征：

### 选择 SQLite 的场景

- **单服务器部署**：你的应用运行在一台服务器上，不需要跨机器访问数据库
- **读密集型工作负载**：75%+ 的请求是读取
- **写入量可控**：每秒写入事务在几千到几万的范围内
- **简单运维**：不想管理数据库服务器、连接池、主从复制
- **嵌入式场景**：移动应用、桌面应用、IoT 设备
- **数据分发**：需要将数据作为文件分发（如离线地图、百科数据）
- **长期存档**：数据需要在几十年后仍然可读

### 选择 PostgreSQL 的场景

- **多服务器写入**：需要多个应用服务器同时写入数据库
- **复杂查询**：需要窗口函数、CTE、高级 JSON 操作、全文搜索
- **高并发写入**：每秒写入事务超过 SQLite 的上限
- **团队协作**：多个开发者需要独立的数据库实例
- **生态系统**：需要 PostGIS、TimescaleDB 等扩展

### 混合架构

越来越多的项目采用混合架构：用 SQLite 处理本地缓存、会话存储、配置数据；用 PostgreSQL 处理核心业务数据。Rails 8 的多数据库支持让这种架构变得非常自然。

## 六、性能对比与优化建议

### 写入优化

```python
import sqlite3

conn = sqlite3.connect('app.db')
conn.execute('PRAGMA journal_mode=WAL')
conn.execute('PRAGMA synchronous=NORMAL')
conn.execute('PRAGMA cache_size=-64000')  # 64MB cache

# 批量插入：使用事务包裹
cursor = conn.cursor()
cursor.execute('BEGIN')
for batch in chunked(records, 10000):
    cursor.executemany(
        'INSERT INTO events (user_id, action, ts) VALUES (?, ?, ?)',
        batch
    )
cursor.execute('COMMIT')
```

### 读取优化

```sql
-- 覆盖索引：避免回表查询
CREATE INDEX idx_events_user_action
ON events (user_id, action)
INCLUDE (created_at, metadata);

-- 部分索引：只为活跃用户建索引
CREATE INDEX idx_active_users
ON users (last_login)
WHERE status = 'active';
```

### 连接池设计

```python
# 单写入者 + 多读取者模式
import sqlite3
from threading import Lock

class SQLitePool:
    def __init__(self, db_path, readers=4):
        self.writer = sqlite3.connect(db_path, check_same_thread=False)
        self.writer_lock = Lock()
        self.readers = [
            sqlite3.connect(f'file:{db_path}?mode=ro', uri=True)
            for _ in range(readers)
        ]

    def write(self, fn):
        with self.writer_lock:
            return fn(self.writer)

    def read(self, fn):
        # 轮询选择读取连接
        conn = self.readers[threading.get_ident() % len(self.readers)]
        return fn(conn)
```

## 总结

SQLite 的文艺复兴不是偶然。它反映了软件架构的一个深层趋势：**在足够多的场景下，简单性比功能丰富性更有价值**。

一个不需要守护进程、不需要连接池、不需要配置文件、备份就是文件复制、性能足以支撑大多数应用的数据库——这种简单性的价值，随着系统复杂性的增长而指数级增长。

国会图书馆的背书、十亿行上的十万 TPS、Rails 8 的默认选择——这些不是 SQLite 的终点，而是起点。当 Litestream 让它拥有了流式复制，当 libSQL 让它拥有了分布式能力，当 SQLite Online 让它跑在了浏览器里，这个"嵌入式玩具"已经成为了真正的工业级数据库。

正如 HN 用户 faangguyindia 所说："我从'SQLite 是玩具，不能用于真实数据'变成了'让我们在几乎所有场景都用 SQLite'。今天，我的大多数应用就是 go binary + SQLite + systemd service file。我从未丢失过数据。"

当然，SQLite 有它的边界。单服务器、单写入者、有限的 ALTER TABLE 支持——这些限制是真实的。但对绝大多数应用来说，这些限制永远不会成为瓶颈。

选择数据库不是信仰之争，而是工程决策。理解你的工作负载，理解工具的特性，然后做出理性的选择。在很多情况下，那个最简单的选择，就是最好的选择。

---

*相关阅读：*

- [PostgreSQL 非常规优化技巧](/article/pg-unconventional-optimizations-2026)
- [WebGPU：浏览器中的 GPU 革命](/article/webgpu-browser-gpu-revolution-2026)
- [io_uring：Linux I/O 的范式革命](/article/io-uring-linux-io-revolution-2026)
