---
title: "SQLite 即消息队列：用 Honker 在单文件数据库中实现持久化任务调度"
date: 2026-05-01
category: 技术
tags: [SQLite, 消息队列, 后端架构, 任务调度, 数据库]
author: 林小白
readtime: 15
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
---

# SQLite 即消息队列：用 Honker 在单文件数据库中实现持久化任务调度

如果你的应用已经在用 SQLite 做主数据库，那么你大概率还需要一个 Redis 来跑任务队列、一个 Cron 来做定时调度、可能还有一个 Kafka 或 SQS 来做事件流。这意味着你的单机应用突然需要维护三四个基础设施组件——而它们各自有独立的备份策略、故障模式和运维成本。

有没有可能，把这些能力全部塞进那个 `.db` 文件里？

2026 年初，一个叫 **Honker** 的 SQLite 扩展给出了答案：它在 SQLite 的基础上实现了持久化任务队列、事件流、Pub/Sub 通知和 Cron 调度器——全部运行在一个加载了扩展的 SQLite 数据库里，无需任何外部守护进程。

本文将深入剖析 Honker 的架构设计、内部实现原理、性能特征，并与 Redis/BullMQ/SQS 等传统方案做全面对比。

## 传统架构的"双写问题"

在典型的 Web 应用中，创建订单和发送通知邮件往往是两个独立的操作：

```python
# 传统架构：业务写入 + 消息队列是两次独立操作
db.execute("INSERT INTO orders (id, total) VALUES (?, ?)", [42, 99])
redis.lpush("email_queue", json.dumps({"to": "alice@example.com", "order_id": 42}))
```

这段代码有一个致命问题：**如果数据库写入成功但 Redis 推送失败，订单创建了但邮件永远不会发出**。反之亦然。这就是分布式系统中臭名昭著的"双写问题"（Dual Write Problem）。

业界的解决方案通常是引入分布式事务（如 Saga 模式）、事务性发件箱（Transactional Outbox）模式、或者直接用支持事务的消息队列。但每种方案都增加了架构复杂度。

Honker 的解法极其简洁：**既然业务数据在 SQLite 里，那队列也放在 SQLite 里，用同一个事务提交**。

```python
import honker

db = honker.open("app.db")
q = db.queue("emails")

# 业务写入和队列入队在同一个 SQLite 事务中
with db.transaction() as tx:
    tx.execute("INSERT INTO orders (id, total) VALUES (?, ?)", [42, 99])
    q.enqueue({"to": "alice@example.com", "order_id": 42}, tx=tx)
# 事务提交 = 两者同时生效；事务回滚 = 两者同时消失
```

没有双写问题，没有分布式事务，没有额外的基础设施。这就是 SQLite 作为"单一数据源"的终极形态。

## Honker 的架构设计

### 唤醒机制：PRAGMA data_version 的妙用

消息队列的核心挑战之一是：消费者怎么知道有新消息了？

传统消息队列靠长轮询或 WebSocket 推送。Redis 用 `BRPOP` 阻塞读取。Kafka 用消费者轮询。Honker 选择了一条不同的路：**轮询 SQLite 的 `PRAGMA data_version`**。

`PRAGMA data_version` 是 SQLite 内置的一个单调递增计数器。任何连接对数据库的提交操作都会让这个值加 1。Honker 的后台线程每 **1 毫秒**检查一次这个值：

```c
// 伪代码：Honker 的唤醒循环
while (running) {
    int current_version = sqlite3_data_version(db);
    if (current_version != last_seen_version) {
        // 有新提交，通知所有订阅者
        notify_all_subscribers();
        last_seen_version = current_version;
    }
    usleep(1000); // 1ms
}
```

每次 `PRAGMA data_version` 的读取开销约为 **3 微秒**——这比执行一条 `SELECT` 查询便宜两个数量级。而且，**无论有多少个消费者订阅者，唤醒线程只有一个**。订阅者的增加不会增加轮询开销，因为唤醒信号是共享的。

这意味着：
- **跨进程唤醒延迟**：在 Apple M 系列芯片上，p50 约为 **0.7 毫秒**
- **空闲成本**：每个数据库每秒 1000 次轻量级 PRAGMA 读取，无页面缓存压力
- **无写锁竞争**：PRAGMA 读取不持有任何锁

### 内部表结构

Honker 在首次调用 `honker_bootstrap()` 时创建一系列内部表（以 `_honker_` 前缀命名）：

**`_honker_live`——任务队列的核心表：**

| 列名 | 类型 | 说明 |
|------|------|------|
| `id` | INTEGER | 自增主键 |
| `queue` | TEXT | 队列名称 |
| `payload` | TEXT | JSON 负载 |
| `priority` | INTEGER | 优先级（越大越先被消费） |
| `run_at` | INTEGER | 可被认领的最早时间戳 |
| `attempts` | INTEGER | 已尝试次数 |
| `max_attempts` | INTEGER | 最大尝试次数 |
| `expires_at` | INTEGER | 过期时间戳 |
| `state` | TEXT | `pending` 或 `processing` |
| `claim_expires_at` | INTEGER | 认领过期时间 |
| `worker_id` | TEXT | 认领的 Worker 标识 |
| `last_error` | TEXT | 最后一次错误信息 |

关键的性能优化在于这个**部分索引**：

```sql
CREATE INDEX _honker_live_claim_idx ON _honker_live
  (queue, priority DESC, run_at, id)
  WHERE state IN ('pending', 'processing');
```

这个索引只覆盖 `pending` 和 `processing` 状态的行。已经完成或失败的任务（`dead` 状态）被移到 `_honker_dead` 表，完全不影响索引大小和查询性能。**一个有 10 万条死信记录的队列，认领速度和空队列一样快**——因为部分索引天然排除了死信状态。

**`_honker_stream`——事件流的存储层：**

这是一个纯追加（append-only）的事件日志表。`(topic, offset)` 的部分索引确保即使有数百万条历史事件，读取仍然是 O(log n) 的。

**`_honker_stream_consumers`——消费者偏移量：**

每个消费者每个主题一条记录，存储 `(name, topic) -> offset` 的映射。这实现了类似 Kafka Consumer Group 的语义：每个消费者独立消费同一事件流，互不干扰。

## 队列：生产者-消费者模式

### 入队

Honker 的队列支持丰富的入队选项：

```python
import honker

db = honker.open("app.db")
q = db.queue("emails")

# 基础入队
q.enqueue({"to": "alice@example.com", "subject": "Welcome"})

# 延迟入队：60 秒后才能被认领
q.enqueue({"to": "bob@example.com"}, delay=60)

# 高优先级：优先被消费
q.enqueue({"to": "urgent@example.com"}, priority=10)

# 设置过期时间：1 小时后自动过期
q.enqueue({"to": "timely@example.com"}, expires=3600)
```

### 消费与确认

消费者通过 `claim` 方法认领任务，处理完成后通过 `ack` 确认：

```python
async for job in q.claim("worker-1"):
    try:
        await send_email(job.payload)
        job.ack()  # 确认完成，任务被标记为 dead
    except Exception as e:
        # 延迟 60 秒后重试，记录错误信息
        job.retry(delay_s=60, error=str(e))
```

`claim` 方法内部执行的 SQL 大致如下：

```sql
-- 认领单个任务（简化版）
UPDATE _honker_live
SET state = 'processing',
    worker_id = 'worker-1',
    attempts = attempts + 1,
    claim_expires_at = strftime('%s', 'now') + 300
WHERE id = (
    SELECT id FROM _honker_live
    WHERE queue = 'emails'
      AND state = 'pending'
      AND run_at <= strftime('%s', 'now')
    ORDER BY priority DESC, run_at, id
    LIMIT 1
)
RETURNING *;
```

### 批量认领与心跳

对于高吞吐场景，批量认领可以显著减少往返次数：

```python
# 一次认领 100 个任务
jobs = q.claim_batch("worker-1", n=100)
for j in jobs:
    process(j.payload)
# 批量确认
q.ack_batch([j.id for j in jobs], "worker-1")
```

对于长时间运行的任务，心跳机制防止认领超时：

```python
from honker import heartbeat

async for job in q.claim("worker-1"):
    async with heartbeat(job, every_s=60):
        await long_running_task(job.payload)
    job.ack()
```

### 装饰器风格的任务定义

Honker 还提供了类似 Huey/Celery 的装饰器 API：

```python
@q.task(retries=3, timeout_s=30)
def send_email(to, subject):
    # 实际发送邮件的逻辑
    return {"sent_at": time.time()}

# 调用时自动入队
result = send_email("alice@example.com", "Welcome!")

# 阻塞等待结果（可选）
print(result.get(timeout=10))
```

## 事件流：类 Kafka 的消费语义

事件流（Stream）提供了比队列更丰富的消费模型：每个消费者独立维护自己的偏移量，可以回溯、重放。

```python
s = db.stream("orders")

# 发布事件
s.publish({"id": 42, "amount": 9900, "status": "created"})

# 原子发布：业务写入和事件发布在同一事务中
with db.transaction() as tx:
    tx.execute("INSERT INTO orders (id, amount) VALUES (?, ?)", [42, 9900])
    s.publish({"id": 42, "amount": 9900, "status": "created"}, tx=tx)
```

### 消费者订阅

```python
# 自动保存偏移量（默认每 1000 条或 1 秒）
async for event in s.subscribe(consumer="email-worker"):
    await send_order_email(event.payload)
    # 偏移量自动保存，重启后从上次位置继续
```

### 精确一次语义

对于需要精确一次处理（exactly-once）的场景，可以手动控制偏移量保存：

```python
async for event in s.subscribe(consumer="invariant-writer", save_every_n=0, save_every_s=0):
    with db.transaction() as tx:
        apply_to_read_model(event.payload, tx=tx)
        # 在同一事务中保存偏移量 = 精确一次语义
        s.save_offset("invariant-writer", event.offset, tx=tx)
```

这种模式的核心思想是：**事件处理和偏移量更新在同一个事务中提交**。如果处理失败回滚了，偏移量也不会更新，重启后会重新处理同一批事件。配合幂等的写入逻辑，就能实现端到端的精确一次语义。

## Pub/Sub：实时通知

对于需要即时通知但不需要持久化的场景（如 WebSocket 推送），Pub/Sub 是最合适的选择：

```python
# 发送通知
with db.transaction() as tx:
    tx.execute("INSERT INTO orders VALUES (?, ?)", [42, 9900])
    tx.notify("orders", {"id": 42, "event": "placed"})
    # 业务写入和通知在同一事务中，所有监听者都会收到

# 监听通知
async for notif in db.listen("orders"):
    print(f"Channel: {notif.channel}, Payload: {notif.payload}")
    # 在 WebSocket handler 中推送给前端
    await ws.send(json.dumps(notif.payload))
```

Pub/Sub 的跨进程唤醒延迟约为 **1-2 毫秒**，适合对实时性要求不极端的场景（如 UI 更新通知）。如果你需要微秒级的延迟，仍然应该选择 Redis Pub/Sub 或 Unix Socket。

## 定时调度器

Honker 内置了 Cron 调度器，可以注册定时任务并在指定时间自动入队：

```python
from honker import Scheduler, crontab

scheduler = Scheduler(db)

# 每天凌晨 3 点执行备份
scheduler.add(
    name="nightly-backup",
    queue="backups",
    schedule=crontab("0 3 * * *"),
    payload={"target": "s3"},
    expires=3600,  # 任务 1 小时后过期
)

# 每 5 分钟执行健康检查
scheduler.add(
    name="heartbeat",
    queue="health",
    schedule=crontab("*/5 * * * *"),
)

# 启动调度器（阻塞运行）
asyncio.run(scheduler.run())
```

调度器内部维护一个 `_honker_scheduler_tasks` 表，每次 tick 时检查是否有到期的任务需要入队。由于调度器运行在 SQLite 扩展内部，定时任务的入队也是事务性的——不会出现"调度器认为任务已入队但实际失败"的情况。

## 原生 SQL 接口

除了语言绑定，Honker 还提供了完整的 SQL 函数接口，可以直接在 SQLite CLI 或任何支持 SQLite 的工具中使用：

```sql
-- 加载扩展
.load ./libhonker
SELECT honker_bootstrap();

-- 生产者：入队一条消息
SELECT honker_enqueue('emails', '{"to":"alice"}', NULL, NULL, 0, 3, NULL);
-- 参数：队列名, payload, run_at, delay, priority, max_attempts, expires

-- 消费者：批量认领
SELECT honker_claim_batch('emails', 'worker-1', 32, 300);
-- 参数：队列名, worker_id, 批量大小, 可见性超时秒数

-- 确认完成
SELECT honker_ack(1, 'worker-1');

-- 重试（延迟 60 秒）
SELECT honker_retry(1, 'worker-1', 60, 'timeout error');

-- 事件流
SELECT honker_stream_publish('orders', 'order-42', '{"amount":9900}');
SELECT honker_stream_read_since('orders', 0, 100);

-- 分布式锁
SELECT honker_lock_acquire('import-job', 'worker-1', 300);

-- 速率限制
SELECT honker_rate_limit_try('api-calls', 100, 60);
-- 100 次/分钟的速率限制
```

完整的 SQL 函数参考：

| 分类 | 函数 | 参数数 | 说明 |
|------|------|--------|------|
| 队列 | `honker_enqueue` | 7 | 入队 |
| 队列 | `honker_claim_batch` | 4 | 批量认领 |
| 队列 | `honker_ack` | 2 | 确认完成 |
| 队列 | `honker_retry` | 4 | 重试 |
| 队列 | `honker_fail` | 3 | 标记失败 |
| 队列 | `honker_heartbeat` | 3 | 续约心跳 |
| 流 | `honker_stream_publish` | 3 | 发布事件 |
| 流 | `honker_stream_read_since` | 3 | 读取事件 |
| 流 | `honker_stream_save_offset` | 3 | 保存偏移量 |
| 锁 | `honker_lock_acquire` | 3 | 分布式锁 |
| 限流 | `honker_rate_limit_try` | 3 | 速率限制 |

## 性能基准

Honker 的性能指标（在 Apple M 系列笔记本上测试）：

| 指标 | 数值 |
|------|------|
| 跨进程唤醒延迟 (p50) | ~0.7 ms |
| Pub/Sub 延迟 | 1-2 ms |
| `PRAGMA data_version` 读取 | ~3 µs |
| 空闲 CPU 开销 | 每毫秒 1 次轻量 SELECT |
| 队列认领复杂度 | O(log n)（部分索引） |
| 流读取复杂度 | O(log n)（即使有百万条历史事件） |

关键的架构优势：
- **写锁无竞争**：PRAGMA 读取不持有任何锁
- **订阅者线性扩展**：一个共享轮询线程服务所有订阅者
- **死信隔离**：死信表独立，不影响活跃队列的性能

## 与传统方案的全面对比

### Honker vs Redis + BullMQ

| 维度 | Honker | Redis + BullMQ |
|------|--------|----------------|
| 数据持久性 | ACID，随业务数据一起备份 | 需要单独的 RDB/AOF 策略 |
| 双写问题 | 不存在（同一事务） | 存在（需要 Outbox 模式） |
| 运维成本 | 零（SQLite 扩展） | 需要维护 Redis 实例 |
| 部署复杂度 | 单文件 | 需要 Redis 服务 + 连接管理 |
| 内存占用 | 极低（磁盘存储） | 高（内存存储） |
| 吞吐量 | 单写者限制 | 更高（多线程） |
| 功能丰富度 | 基础队列+流+Pub/Sub | 完整的任务编排（链、组、延迟队列） |
| 适用场景 | 单机/嵌入式应用 | 分布式/高吞吐系统 |

### Honker vs AWS SQS

| 维度 | Honker | AWS SQS |
|------|--------|---------|
| 事务性 | 与业务写入同一事务 | 需要单独的 API 调用 |
| 成本 | 免费（开源） | 按请求数计费 |
| 网络依赖 | 无（本地文件） | 需要网络连接 |
| 可扩展性 | 单机限制 | 近乎无限 |
| 消息保序 | 支持（通过 priority + run_at） | FIFO 队列支持 |
| 适用场景 | 单机应用、开发环境 | 大规模分布式系统 |

### Honker vs pg_notify / pg-boss

| 维度 | Honker | pg_notify / pg-boss |
|------|--------|---------------------|
| 数据库 | SQLite（单文件） | PostgreSQL（需要服务端） |
| 重试机制 | 内置（max_attempts + retry） | pg_notify 无重试，pg-boss 有 |
| 可见性 | 内置 claim 超时 | 需要自行实现 |
| 部署 | 零配置 | 需要 PostgreSQL 实例 |
| 适用场景 | 轻量级/嵌入式 | 已有 PostgreSQL 的项目 |

## 实际应用场景

### 场景一：单机 Web 应用的任务队列

一个跑在 Fly.io 上的单实例 Web 应用，用 SQLite 做主数据库。需要异步发送邮件、生成报表、处理图片：

```python
import honker

db = honker.open("/data/app.db")
db.execute("SELECT honker_bootstrap()")

# 注册任务
email_queue = db.queue("emails")
report_queue = db.queue("reports")

# Web handler 中：注册用户后发送欢迎邮件
async def register_user(request):
    with db.transaction() as tx:
        tx.execute("INSERT INTO users (name, email) VALUES (?, ?)",
                   [request.name, request.email])
        email_queue.enqueue({
            "to": request.email,
            "template": "welcome",
            "user_name": request.name
        }, tx=tx)
    return {"status": "ok"}

# Worker 进程中：消费邮件队列
async def email_worker():
    async for job in email_queue.claim("email-worker-1"):
        try:
            await send_email(job.payload)
            job.ack()
        except Exception as e:
            job.retry(delay_s=30, error=str(e))
```

### 场景二：事件溯源的读模型更新

```python
orders_stream = db.stream("orders")

# 写入订单时同时发布事件
async def create_order(order_data):
    with db.transaction() as tx:
        tx.execute("INSERT INTO orders (...) VALUES (...)", order_data)
        orders_stream.publish(order_data, tx=tx)

# 读模型更新器：消费事件流，维护查询用的物化视图
async def read_model_updater():
    async for event in orders_stream.subscribe(consumer="read-model"):
        with db.transaction() as tx:
            # 更新查询用的物化视图
            tx.execute("""
                INSERT OR REPLACE INTO order_summary (id, total, status, updated_at)
                VALUES (?, ?, ?, ?)
            """, [event.payload["id"], event.payload["total"],
                  event.payload["status"], event.timestamp])
            # 在同一事务中保存偏移量 = 精确一次语义
            orders_stream.save_offset("read-model", event.offset, tx=tx)
```

### 场景三：分布式锁防止重复执行

```python
# 优雅的分布式锁模式
async def import_job_worker():
    while True:
        # 尝试获取锁，TTL 300 秒
        acquired = db.execute(
            "SELECT honker_lock_acquire('data-import', 'worker-1', 300)"
        ).fetchone()[0]

        if acquired:
            try:
                await run_data_import()
            finally:
                # 锁会在 TTL 后自动过期，但主动释放更干净
                pass
        else:
            await asyncio.sleep(10)  # 等待后重试
```

## 局限性与注意事项

Honker 并非银弹，使用前需要了解它的设计边界：

**SQLite 的单写者限制**：同一时刻只能有一个写入者。虽然 WAL 模式允许多个并发读取者，但写入操作是串行的。如果你的应用写入 QPS 超过数千，可能需要考虑其他方案。

**不支持任务编排**：没有任务链（chain）、任务组（group）、扇出（chord）等高级编排能力。如果你需要 DAG 工作流，应该选择 Temporal 或 Prefect。

**不适合分布式系统**：Honker 的设计前提是所有组件共享同一个 SQLite 文件。如果你的应用是多实例部署，需要使用 NFS 或 LiteFS 等方案让所有实例访问同一个数据库文件。

**通知不会自动清理**：`_honker_notifications` 表需要手动调用 `prune_notifications()` 来清理旧记录，否则会持续增长。

**无多写者复制**：不像 Turso 或 LiteFS 那样提供跨节点的写入复制。

## 总结与展望

Honker 代表了一种有趣的设计哲学：**如果你的数据已经在 SQLite 里，就不要引入额外的基础设施**。它用 `PRAGMA data_version` 这个几乎零成本的机制解决了跨进程通知问题，用部分索引保证了队列认领的 O(log n) 性能，用事务性入队消灭了双写问题。

对于单机应用、嵌入式系统、桌面应用或者那些"周末写着玩结果上了生产"的项目来说，Honker 是一个完美的选择。它让你在不引入 Redis、Kafka 或 SQS 的情况下，获得可靠的异步任务处理能力。

而对于更复杂的分布式场景，Honker 的设计也为未来的扩展留下了空间——想象一下，如果 SQLite 能像 Postgres 那样支持 `LISTEN/NOTIFY` 的原生语义，或者像 Turso 那样提供多节点复制，那么"SQLite 即消息队列"这个理念将拥有更广阔的应用前景。

在"数据库即平台"的趋势下，SQLite 正在从一个嵌入式数据库演变为一个轻量级的应用基础设施平台。Honker 只是这个趋势的一个缩影。

---

*相关阅读：*

- [用 Rust 重写 PostgreSQL 扩展：pgrx 框架深度实战](/article/pgrx-rust-postgres-extensions)
- [软件供应链安全实战：从 Bitwarden CLI 被攻击事件看 Node.js 项目防护体系](/article/nodejs-supply-chain-security-practices)
- [本地大模型实战指南：从量化部署到生产级优化](/article/local-llm-deployment-guide)
