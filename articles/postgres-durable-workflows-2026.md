---
title: "Postgres 即编排器：用 SELECT FOR UPDATE SKIP LOCKED 构建持久化工作流"
date: 2026-05-29
category: 技术
tags: [PostgreSQL, 工作流, 分布式系统, 后端架构, 数据库, 持久化执行, AI Agent]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
---

# Postgres 即编排器：用 SELECT FOR UPDATE SKIP LOCKED 构建持久化工作流

Temporal、Airflow、AWS Step Functions——这些"持久化执行"系统解决的核心问题其实只有一个：**程序崩溃后如何从中断处继续执行**。但如果你已经在用 Postgres，你可能根本不需要这些额外的基础设施。

这篇文章将展示如何仅用 Postgres 的原生能力——事务、行锁、`SKIP LOCKED`、`LISTEN/NOTIFY`——构建一个生产级的持久化工作流引擎。不是玩具示例，而是能处理 AI Agent 多步推理、支付回调、邮件序列等真实场景的系统。

## 什么是持久化执行（Durable Execution）

持久化执行的核心思想很简单：**把每一步的执行结果写入数据库，崩溃后从最后的检查点恢复**。

```
普通函数：
  step1() → step2() → step3() → [崩溃] → 从头重来 ❌

持久化函数：
  step1() → 写入DB → step2() → 写入DB → [崩溃] → 从step3恢复 ✅
```

传统方案（如 Temporal）的架构是：

```
┌──────────┐     ┌───────────────┐     ┌──────────┐
│  Client   │────▶│  Orchestrator │────▶│  Worker   │
└──────────┘     │  (独立服务)    │     └──────────┘
                 │  ┌──────────┐ │
                 │  │ Database │ │
                 │  └──────────┘ │
                 └───────────────┘
```

问题在于：**编排器本身成了额外的单点故障和运维负担**。如果持久化执行的本质是"把状态写进数据库"，那为什么需要一个独立的编排服务？

## Postgres 原生方案：去掉中间人

直接让应用服务器和 Postgres 通信：

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│  Client   │────▶│ App Srv 1 │────▶│ Postgres  │
└──────────┘     └──────────┘     │ (队列+状态) │
                 ┌──────────┐     │            │
                 │ App Srv 2 │────▶│            │
                 └──────────┘     └──────────┘
```

核心 SQL 只需要一个表：

```sql
CREATE TABLE workflows (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    -- pending / running / completed / failed / suspended
    input       JSONB,
    output      JSONB,
    current_step INT DEFAULT 0,
    max_attempts INT DEFAULT 3,
    attempt     INT DEFAULT 1,
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE workflow_steps (
    id          BIGSERIAL PRIMARY KEY,
    workflow_id BIGINT REFERENCES workflows(id),
    step_index  INT NOT NULL,
    step_name   TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    input       JSONB,
    output      JSONB,
    error       TEXT,
    started_at  TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    UNIQUE(workflow_id, step_index)
);
```

## 核心机制：SKIP LOCKED 队列

Postgres 11 引入的 `FOR UPDATE SKIP LOCKED` 是构建无竞争队列的关键。当多个 worker 同时尝试获取任务时：

```sql
-- Worker 获取下一个待处理任务（原子操作，无竞争）
WITH next_task AS (
    SELECT id FROM workflows
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED  -- 跳过已被其他worker锁定的行
)
UPDATE workflows
SET status = 'running', updated_at = now()
FROM next_task
WHERE workflows.id = next_task.id
RETURNING workflows.*;
```

`SKIP LOCKED` 的妙处在于：

1. **无锁等待**：其他 worker 正在处理的任务直接跳过，不会阻塞
2. **原子性**：`SELECT ... FOR UPDATE` + `UPDATE` 在同一个事务中，不会重复分配
3. **无外部依赖**：不需要 Redis、RabbitMQ 或任何消息中间件

这正是 [Armin Ronacher（Flask 作者）在 Absurd 项目](https://lucumr.pocoo.org/2025/11/3/absurd-workflows/)中使用的方法——他把整个持久化工作流引擎压缩成了一个 `.sql` 文件加薄薄的 SDK 层。

## 检查点与恢复：事件溯源模式

持久化执行的核心是**检查点（checkpoint）**。每完成一步，将结果写入数据库；崩溃后，从检查点恢复而非从头开始。

```sql
-- 记录步骤完成（检查点）
INSERT INTO workflow_steps (workflow_id, step_index, step_name, status, output, completed_at)
VALUES ($1, $2, $3, 'completed', $4, now())
ON CONFLICT (workflow_id, step_index)
DO UPDATE SET status = 'completed', output = $4, completed_at = now();

-- 更新工作流进度
UPDATE workflows
SET current_step = current_step + 1, updated_at = now()
WHERE id = $1;

-- 如果所有步骤完成，标记工作流完成
UPDATE workflows
SET status = 'completed', output = $5, updated_at = now()
WHERE id = $1 AND current_step >= total_steps;
```

恢复逻辑同样简单：

```sql
-- 获取已完成的步骤（用于重放）
SELECT step_index, step_name, output
FROM workflow_steps
WHERE workflow_id = $1 AND status = 'completed'
ORDER BY step_index;
```

应用层只需跳过已完成的步骤，从 `current_step` 继续：

```python
async def execute_workflow(workflow_id):
    # 1. 获取工作流状态
    wf = await db.fetch_one("SELECT * FROM workflows WHERE id = $1", workflow_id)
    
    # 2. 获取已完成的步骤（检查点）
    completed = await db.fetch_all(
        "SELECT step_index, output FROM workflow_steps WHERE workflow_id = $1 AND status = 'completed'",
        workflow_id
    )
    completed_map = {s['step_index']: s['output'] for s in completed}
    
    # 3. 从当前步骤继续
    steps = get_workflow_steps(wf['name'])
    for i, step in enumerate(steps):
        if i in completed_map:
            continue  # 跳过已完成的步骤
        
        try:
            result = await step.execute(completed_map)
            # 写入检查点
            await save_checkpoint(workflow_id, i, step.name, result)
            completed_map[i] = result
        except Exception as e:
            await mark_step_failed(workflow_id, i, str(e))
            raise
```

## 超时、重试与死信队列

生产环境不能没有重试机制。Postgres 的事务特性让这变得优雅：

```sql
-- 获取超时或失败的任务进行重试
WITH retryable AS (
    SELECT id FROM workflows
    WHERE status = 'running'
      AND updated_at < now() - INTERVAL '5 minutes'  -- 超时阈值
      AND attempt < max_attempts
    FOR UPDATE SKIP LOCKED
)
UPDATE workflows
SET status = 'pending',
    attempt = attempt + 1,
    current_step = 0,  -- 从头重放（检查点会跳过已完成步骤）
    updated_at = now()
FROM retryable
WHERE workflows.id = retryable.id
RETURNING workflows.*;

-- 死信：超过最大重试次数的标记为失败
UPDATE workflows
SET status = 'dead_letter', updated_at = now()
WHERE status = 'running'
  AND updated_at < now() - INTERVAL '5 minutes'
  AND attempt >= max_attempts;
```

注意 `current_step = 0` 不会丢弃已完成的步骤——恢复逻辑会从检查点表中加载已完成步骤的输出，跳过它们继续执行。

## LISTEN/NOTIFY：实时事件驱动

Postgres 的 `LISTEN/NOTIFY` 提供了轻量级的发布/订阅机制，非常适合驱动工作流事件：

```sql
-- 定义通知触发器
CREATE OR REPLACE FUNCTION notify_workflow_event()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM pg_notify('workflow_events', json_build_object(
        'workflow_id', NEW.id,
        'status', NEW.status,
        'name', NEW.name
    )::text);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_status_change
AFTER UPDATE OF status ON workflows
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION notify_workflow_event();
```

应用层监听：

```python
import asyncpg

async def listen_workflow_events():
    conn = await asyncpg.connect(dsn)
    await conn.add_listener('workflow_events', lambda *args: handle_event(args))
    # 保持连接活跃...
```

这让你可以实现：
- **等待事件**：工作流暂停，等待外部系统发送通知（如支付回调）
- **级联触发**：工作流 A 完成后自动触发工作流 B
- **实时仪表板**：前端 WebSocket 推送工作流状态变更

## 实战：AI Agent 持久化执行

AI Agent 是持久化执行的杀手级应用——Agent 的推理过程可能包含多步 LLM 调用、工具执行、人工审批，任何一步都可能需要暂停和恢复。

```python
async def run_agent(task_id, prompt):
    messages = [{"role": "user", "content": prompt}]
    step = 0
    
    while step < 20:
        # 检查点：如果这一步已完成，从数据库恢复结果
        checkpoint = await get_checkpoint(task_id, step)
        if checkpoint:
            messages.extend(checkpoint['output']['messages'])
            step += 1
            continue
        
        # 执行 LLM 调用
        response = await llm.chat(
            model="claude-haiku-4-5",
            messages=messages,
            tools=available_tools
        )
        
        # 写入检查点
        await save_checkpoint(task_id, step, "llm_call", {
            "messages": response.messages,
            "finish_reason": response.finish_reason
        })
        
        messages.extend(response.messages)
        
        # 如果需要调用工具
        if response.finish_reason == "tool_use":
            tool_result = await execute_tool(response.tool_call)
            await save_checkpoint(task_id, step + 1, "tool_exec", {
                "result": tool_result
            })
            messages.append({"role": "tool", "content": tool_result})
            step += 2
        else:
            break
    
    return messages[-1]['content']
```

当进程崩溃时，新的 worker 接手，从最后的检查点继续——LLM 不需要重新生成已经完成的推理步骤，节省了时间和成本。

## 与 Temporal 的对比

| 维度 | Postgres 原生 | Temporal |
|------|-------------|----------|
| **运维复杂度** | 零额外组件 | 需要部署 Temporal Server + 数据库 |
| **学习成本** | SQL + 简单 SDK | Workflow/Activity 概念、DSL |
| **可观测性** | 直接 SQL 查询 | Temporal Web UI（更丰富） |
| **扩展性** | 受限于 PG 连接数 | 专门为大规模设计 |
| **版本管理** | 需要自己实现 | 内置 workflow versioning |
| **适用场景** | 中小规模、已有 PG | 大规模、跨语言、复杂编排 |

**选 Postgres 原生方案的理由**：
- 你的应用已经在用 Postgres
- 工作流规模在每秒数千个以内
- 团队更熟悉 SQL 而非 Temporal DSL
- 不想引入额外的基础设施

**选 Temporal 的理由**：
- 需要跨语言支持（Go/Java/TypeScript）
- 工作流非常复杂（嵌套子工作流、信号、查询）
- 需要 Temporal 提供的高级可观测性
- 每秒需要处理数万个工作流

## 性能考量与优化

### 批量操作

单个事务中处理多个步骤可以显著减少 I/O：

```sql
-- 批量插入检查点
INSERT INTO workflow_steps (workflow_id, step_index, step_name, status, output)
VALUES
    ($1, 0, 'parse_input', 'completed', '{"parsed": true}'),
    ($1, 1, 'validate', 'completed', '{"valid": true}'),
    ($1, 2, 'process', 'completed', '{"result": 42}')
ON CONFLICT (workflow_id, step_index) DO NOTHING;
```

### 索引策略

```sql
-- 关键索引：worker 获取任务的查询路径
CREATE INDEX idx_workflows_pending
ON workflows (created_at)
WHERE status = 'pending';

-- 检查点查询
CREATE INDEX idx_steps_workflow
ON workflow_steps (workflow_id, step_index);

-- 超时任务查找
CREATE INDEX idx_workflows_timeout
ON workflows (updated_at)
WHERE status = 'running';
```

### 分区表

对于高吞吐场景，按时间分区工作流表：

```sql
CREATE TABLE workflows (
    -- ... 同上
) PARTITION BY RANGE (created_at);

CREATE TABLE workflows_2026_05 PARTITION OF workflows
FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
```

老分区可以 `DETACH` 后归档或删除，保持主表精简。

## pgmq：生产级消息队列

如果你不想从零实现队列逻辑，[pgmq](https://github.com/tembo-io/pgmq) 是一个成熟的 Postgres 扩展，提供了标准的消息队列语义：

```sql
-- 安装
CREATE EXTENSION pgmq;

-- 创建队列
SELECT pgmq.create('workflow_tasks');

-- 发送消息
SELECT pgmq.send('workflow_tasks', '{"workflow_id": 123, "step": 0}');

-- 消费消息（自动 SKIP LOCKED）
SELECT * FROM pgmq.read('workflow_tasks', 30, 1);
-- 30秒可见性超时，1条消息

-- 确认处理完成
SELECT pgmq.delete('workflow_tasks', msg_id);
```

pgmq 的底层正是 `SELECT ... FOR UPDATE SKIP LOCKED`，但封装了死信队列、可见性超时、归档等生产必需功能。

## 踩坑指南

### 1. 长事务锁持有

SKIP LOCKED 会在事务期间持有行锁。如果步骤执行时间很长（如调用外部 API），锁会被长时间持有，阻塞其他 worker。

**解决方案**：拆分为两阶段——先用短事务获取任务并标记状态，再在事务外执行长时间操作，最后用短事务写入结果。

```python
# 阶段1：获取任务（短事务）
async with db.transaction():
    task = await db.fetch_one("SELECT ... FOR UPDATE SKIP LOCKED ...")
    await db.execute("UPDATE workflows SET status='running' WHERE id=$1", task['id'])

# 阶段2：执行操作（事务外）
result = await call_external_api(task['input'])

# 阶段3：写入结果（短事务）
async with db.transaction():
    await save_checkpoint(task['id'], step, result)
```

### 2. 时钟偏移

多服务器场景下，各服务器时钟可能有微小偏差。用 `now()` 而非应用层时间戳——Postgres 的 `now()` 在事务内是稳定的。

### 3. JSONB 性能

大量检查点数据会让 JSONB 字段膨胀。定期清理已完成工作流的详细步骤数据，只保留最终结果。

## 总结

Postgres 已经是你系统中最可靠的组件。利用它的事务、行锁和通知机制，你可以在不引入任何新基础设施的情况下获得持久化执行能力。

**核心模式回顾**：
1. `FOR UPDATE SKIP LOCKED` → 无竞争任务分配
2. 检查点表 + 事件溯源 → 崩溃恢复
3. `LISTEN/NOTIFY` → 实时事件驱动
4. 超时 + 重试计数 → 死信处理

正如 Armin Ronacher 所说：持久化工作流本质上就是**一个队列加一个状态存储**——而 Postgres 同时擅长这两件事。Absurd 项目把整个引擎压缩成了一个 SQL 文件；DBOS 在此基础上提供了 TypeScript/Python SDK 和云服务。

下次当你考虑引入 Temporal 或 Airflow 之前，先问自己：**Postgres 能不能直接做？** 答案很可能是"能"。

---

*相关阅读：*

- [超越索引：PostgreSQL 那些不为人知的非常规优化技巧](/article/pg-unconventional-optimizations-2026)
- [SQLite 文艺复兴：从嵌入式玩具到国会图书馆认证的工业级数据库](/article/sqlite-renaissance-2026)
- [告别 Date 地狱：Node.js 26 正式启用 Temporal API](/article/nodejs-26-temporal-api-2026)
