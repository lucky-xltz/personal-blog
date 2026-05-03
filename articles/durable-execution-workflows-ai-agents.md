---
title: "Durable Execution 深度解析：构建可靠的长时间运行工作流与 AI Agent"
date: 2026-05-03
category: 技术
tags: [Durable Execution, AI Agent, Inngest, Temporal, 工作流引擎, 微服务]
author: 林小白
readtime: 16
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
---

# Durable Execution 深度解析：构建可靠的长时间运行工作流与 AI Agent

当你的 AI Agent 需要 30 分钟来完成一个复杂的代码审查任务时，中间服务器重启了怎么办？当你的数据处理流水线运行到一半，Pod 被调度器驱逐了怎么办？传统的请求-响应模型在面对长时间运行的任务时显得力不从心。

**Durable Execution（持久化执行）** 正是为解决这类问题而诞生的架构模式。2026 年，随着 AI Agent 从实验室走向生产环境，这一模式正在成为构建可靠分布式系统的关键基础设施。

## 为什么传统方案不够用？

先看一个典型的 AI Agent 场景：用户请求 Agent 帮忙分析一个代码仓库的安全漏洞。Agent 需要：

1. 克隆仓库（30 秒）
2. 调用 LLM 分析代码结构（20 秒）
3. 逐文件扫描依赖（2 分钟）
4. 生成报告并发送通知（10 秒）

如果用传统的同步 API 实现，问题显而易见：

```python
# ❌ 传统方式：脆弱的长运行任务
@app.post("/analyze")
async def analyze_repo(request: AnalyzeRequest):
    repo = await clone_repo(request.url)           # 如果这里超时？
    structure = await llm_analyze(repo)             # 如果 LLM API 限流？
    vulns = await scan_dependencies(repo)           # 如果 Pod 被驱逐？
    report = await generate_report(vulns)           # 所有工作白费！
    return report
```

任何一步失败，整个流程从头再来。用户等了 3 分钟，结果收到一个 502 错误。

你可能会想到用消息队列 + 状态机来解决。但手写重试逻辑、状态持久化、并发控制、死信队列……这些基础设施代码很快就会淹没你的业务逻辑。

## 什么是 Durable Execution？

Durable Execution 是一种容错的代码执行方式，它将函数的状态持久化到外部存储中，使得函数能够在网络故障、超时、基础设施中断后从断点恢复执行，而不需要从头重跑。

核心思想可以用一句话概括：**把执行过程变成事件流，每一步的结果都被持久化，失败后从上一个成功的步骤恢复。**

### 工作原理

```
┌─────────────────────────────────────────────────┐
│                  Durable Execution Engine         │
│                                                   │
│  ┌─────────┐   ┌─────────┐   ┌─────────┐       │
│  │ Step 1  │──▶│ Step 2  │──▶│ Step 3  │       │
│  │ clone   │   │ llm     │   │ scan    │       │
│  │ ✅ done │   │ ✅ done │   │ ⏳ run  │       │
│  └─────────┘   └─────────┘   └─────────┘       │
│       │              │              │             │
│       ▼              ▼              ▼             │
│  ┌──────────────────────────────────────┐       │
│  │        State Store (Postgres)         │       │
│  │  step1: {status: "done", result: ...} │       │
│  │  step2: {status: "done", result: ...} │       │
│  │  step3: {status: "running"}           │       │
│  └──────────────────────────────────────┘       │
└─────────────────────────────────────────────────┘
```

当服务器重启时，引擎从状态存储中恢复已执行步骤的结果，跳过已完成的步骤，直接从未完成的步骤继续。这就是 **Step Memoization（步骤记忆）** 机制。

## Inngest：开发者友好的 Durable Execution

[Inngest](https://www.inngest.com) 是目前最受欢迎的 Durable Execution 引擎之一，以开发者体验著称。它不需要独立的基础设施——你的函数以标准 HTTP 端点运行，Inngest 负责调度和状态管理。

### 核心概念

Inngest 的编程模型基于三个核心概念：

- **Function**：一个完整的业务流程，由多个 Step 组成
- **Step**：一个独立的、可重试的工作单元
- **Event**：触发函数执行的事件

### 基础示例

```typescript
import { Inngest } from "inngest";

const inngest = new Inngest({ id: "my-app" });

// 定义一个 Durable Function
const analyzeRepo = inngest.createFunction(
  { id: "analyze-repo", retries: 3 },
  { event: "repo/analyze.requested" },
  async ({ event, step }) => {
    // Step 1: 克隆仓库（独立重试，不会重复执行已完成的步骤）
    const repo = await step.run("clone-repo", async () => {
      return await cloneRepository(event.data.repoUrl);
    });

    // Step 2: LLM 分析（如果 LLM 限流，自动重试这一步）
    const analysis = await step.run("llm-analyze", async () => {
      return await callLLM({
        model: "claude-sonnet-4",
        prompt: `Analyze the structure of ${repo.name}`,
      });
    });

    // Step 3: 依赖扫描（可以与 Step 4 并行执行）
    const vulns = await step.run("scan-deps", async () => {
      return await scanDependencies(repo.path);
    });

    // Step 4: 等待外部事件（比如等待人工审批）
    const approval = await step.waitForEvent("wait-approval", {
      event: "repo/analyze.approved",
      timeout: "24h",
    });

    // Step 5: 生成报告
    const report = await step.run("generate-report", async () => {
      return await generateReport({ repo, analysis, vulns, approval });
    });

    return { reportId: report.id };
  }
);
```

### 为什么这很强大？

上面的代码看起来就像普通的异步函数，但它拥有超能力：

**1. 自动断点恢复**

假设服务器在 Step 2（LLM 分析）完成后崩溃。重启后，引擎会：
- 读取状态存储，发现 Step 1 和 Step 2 已完成
- 跳过它们，直接执行 Step 3
- 用户无感知

**2. 细粒度重试**

每个 Step 有独立的重试策略。如果 LLM 调用因为限流失败，只重试那一个调用，不影响已完成的克隆操作。

**3. 内置等待**

`step.waitForEvent` 让函数"暂停"等待外部事件，但不占用任何计算资源。24 小时后如果没人审批，自动超时。这在传统异步模型中需要手写定时器和状态机。

**4. 并行执行**

```typescript
// Step 3 和 Step 4 并行执行
const [vulns, tests] = await Promise.all([
  step.run("scan-vulns", () => scanVulnerabilities(repo)),
  step.run("run-tests", () => runTestSuite(repo)),
]);
```

## Temporal：工业级工作流引擎

[Temporal](https://temporal.io) 是另一个主流的 Durable Execution 引擎，源自 Uber 的 Cadence 项目，更适合大规模、高可靠性的场景。

### 核心差异

| 特性 | Inngest | Temporal |
|------|---------|----------|
| 基础设施 | 无需独立部署，连接你的计算节点 | 需要部署 Temporal Server 集群 |
| 编程模型 | Step 记忆化，普通语言原语 | 确定性重放，严格运行时规则 |
| 流量控制 | 内置并发、优先级、限流、去抖 | 企业版才有优先级和公平调度 |
| 自部署 | 单二进制 + SQLite/Postgres | 多组件集群 + Cassandra/Postgres |
| 适用场景 | Serverless 优先，快速迭代 | 大规模、高可靠生产环境 |

### Temporal 的确定性重放

Temporal 使用一种叫 **Deterministic Replay（确定性重放）** 的机制。工作流代码必须是确定性的——相同输入必须产生相同的执行路径。

```python
from temporalio import workflow, activity
from datetime import timedelta

@activity.defn
async def clone_repo(url: str) -> dict:
    """每个 I/O 操作封装为 Activity"""
    return await do_clone(url)

@activity.defn
async def llm_analyze(repo_path: str) -> str:
    """LLM 调用也是 Activity"""
    return await call_llm(repo_path)

@workflow.defn
class RepoAnalysisWorkflow:
    @workflow.run
    async def run(self, request: dict) -> dict:
        # 工作流逻辑必须是确定性的
        repo = await workflow.execute_activity(
            clone_repo,
            request["url"],
            start_to_close_timeout=timedelta(minutes=2),
        )

        analysis = await workflow.execute_activity(
            llm_analyze,
            repo["path"],
            start_to_close_timeout=timedelta(minutes=1),
            retry_policy=RetryPolicy(maximum_attempts=3),
        )

        # 等待信号（人工审批）
        signal = await workflow.wait_condition(
            lambda: self.approved,
            timeout=timedelta(hours=24),
        )

        return {"analysis": analysis, "approved": signal}
```

### AI Agent 的新范式：Agent Loop in Workflow

2026 年 4 月，Temporal 团队发布了与 Google ADK（Agent Development Kit）的集成，提出了一个关键架构模式：

> **Agentic Loop 放在 Workflow 中，非确定性调用放在 Activity 中。**

Agent 的主循环（思考 → 选择工具 → 执行 → 观察 → 再思考）是一个确定性的状态机，而每次 LLM 调用和工具执行都是独立的 Activity：

```python
# Agent 主循环 — 确定性 Workflow
@workflow.defn
class AgentWorkflow:
    @workflow.run
    async def run(self, task: str) -> str:
        messages = [{"role": "user", "content": task}]

        for _ in range(MAX_ITERATIONS):
            # LLM 调用 — 非确定性，封装为 Activity
            response = await workflow.execute_activity(
                llm_call,
                messages,
                start_to_close_timeout=timedelta(minutes=1),
            )

            if response.get("stop"):
                return response["content"]

            # 工具调用 — 每个工具是独立 Activity
            for tool_call in response.get("tool_calls", []):
                result = await workflow.execute_activity(
                    execute_tool,
                    tool_call,
                    start_to_close_timeout=timedelta(seconds=30),
                    retry_policy=RetryPolicy(maximum_attempts=3),
                )
                messages.append({"role": "tool", "content": result})
```

这种架构的优势在于：

- **细粒度重试**：只重试失败的那个 LLM 调用或工具调用，不重跑整个 Agent 循环
- **完整可观测性**：每次 LLM 调用、工具执行都有独立的时间线和日志
- **零成本暂停**：Agent 等待人工审批时不消耗任何资源
- **状态完整重建**：服务器重启后，Agent 从上一个成功的步骤继续

## 实战：从零构建 Durable AI Agent

让我们用 Inngest 构建一个生产级的代码审查 Agent：

```typescript
import { Inngest } from "inngest";

const inngest = new Inngest({ id: "code-review-agent" });

// 工具定义
const tools = {
  read_file: async (path: string) => fs.readFile(path, "utf-8"),
  run_linter: async (path: string) => exec(`eslint ${path} --json`),
  search_code: async (query: string) => ripgrep(query),
};

export const codeReviewAgent = inngest.createFunction(
  {
    id: "code-review-agent",
    retries: 2,
    concurrency: { limit: 10 }, // 最多 10 个并发审查
  },
  { event: "pr/opened" },
  async ({ event, step }) => {
    const { prNumber, repoUrl, diff } = event.data;

    // Step 1: 理解 PR 变更
    const understanding = await step.run("understand-changes", async () => {
      return await callLLM({
        model: "claude-sonnet-4",
        system: "You are a senior code reviewer. Analyze the diff and identify key areas to review.",
        prompt: diff,
        max_tokens: 2000,
      });
    });

    // Step 2: 并行执行静态分析
    const [lintResults, typeCheckResults] = await Promise.all([
      step.run("run-lint", () => tools.run_linter(event.data.changedFiles)),
      step.run("type-check", () => exec("tsc --noEmit --json")),
    ]);

    // Step 3: 深度审查（带工具调用）
    const review = await step.run("deep-review", async () => {
      return await callLLMWithTools({
        model: "claude-sonnet-4",
        system: "Review the code for bugs, security issues, and improvements.",
        messages: [
          { role: "user", content: `Diff:\n${diff}\n\nLint:\n${JSON.stringify(lintResults)}` },
        ],
        tools: Object.entries(tools).map(([name, fn]) => ({
          name,
          execute: fn,
        })),
      });
    });

    // Step 4: 发布审查结果
    await step.run("post-review", async () => {
      await github.pulls.createReview({
        owner: event.data.owner,
        repo: event.data.repo,
        pull_number: prNumber,
        event: review.hasBlockingIssues ? "REQUEST_CHANGES" : "APPROVE",
        body: formatReview(review),
      });
    });

    return { prNumber, status: "reviewed" };
  }
);
```

这段代码的关键优势：

- **并发控制**：`concurrency: { limit: 10 }` 防止同时审查太多 PR 导致 LLM API 超限
- **断点恢复**：如果 Step 2 的 lint 执行到一半服务器重启，只重新执行 lint，不重跑 LLM 分析
- **独立重试**：如果 GitHub API 偶尔超时，只重试发评论那一步
- **零基础设施**：不需要 Redis、消息队列或状态数据库

## 最佳实践与陷阱

### ✅ Do

**1. 保持 Step 粒度适中**

```typescript
// ✅ 好：每个 Step 是一个有意义的工作单元
await step.run("validate-input", () => validate(data));
await step.run("process-payment", () => charge(data));
await step.run("send-receipt", () => email(data));

// ❌ 太细：每个函数调用一个 Step
await step.run("parse-body", () => JSON.parse(body));
await step.run("check-email", () => /.+@.+/.test(email));

// ❌ 太粗：整个函数一个 Step（失去 Durable Execution 的意义）
await step.run("do-everything", () => doAllTheThings(data));
```

**2. 设计幂等的 Step**

Durable Execution 不保证 Step 只执行一次（网络分区可能导致重复触发）。确保你的 Step 是幂等的：

```typescript
// ✅ 幂等：用唯一 ID 去重
await step.run("charge-payment", async () => {
  const existing = await db.charges.findByOrderId(orderId);
  if (existing) return existing;
  return await payment.charge({ orderId, amount });
});
```

**3. 合理设置超时**

```typescript
await step.run("call-external-api", () => callAPI(), {
  timeout: "30s",  // 单步超时
});
```

### ❌ Don't

**1. 不要在 Step 中使用时间依赖的逻辑**

```typescript
// ❌ 非确定性：重放时时间不同
const start = Date.now();
await doWork();
console.log(`Took ${Date.now() - start}ms`);
```

**2. 不要在 Step 外部做副作用操作**

```typescript
// ❌ 副作用不在 Step 中，重放时会重复执行
await sendEmail(user);  // 这会在每次重放时发送！
await step.run("save", () => db.save(data));

// ✅ 把所有副作用放进 Step
await step.run("send-email", () => sendEmail(user));
await step.run("save", () => db.save(data));
```

**3. 不要假设内存状态跨 Step 存活**

```typescript
// ❌ 变量在重启后丢失
let counter = 0;
await step.run("step1", () => counter++);
// 重启后 counter 为 0

// ✅ 通过 Step 返回值传递状态
const counter = await step.run("step1", () => incrementAndGet());
```

## 架构选型指南

选择 Durable Execution 引擎时，考虑以下因素：

| 场景 | 推荐 | 理由 |
|------|------|------|
| 快速原型 / 中小型项目 | Inngest | 零基础设施，DX 优秀 |
| 大规模生产 / 金融级可靠性 | Temporal | 成熟稳定，强一致性保证 |
| Serverless 优先 | Inngest | 原生支持，按需扩缩 |
| 已有 Kubernetes 基础设施 | Temporal | 可自部署，完全控制 |
| AI Agent 工作流 | 两者均可 | Temporal + ADK 集成更成熟 |

## 2026 年的趋势

Durable Execution 正在从边缘走向主流：

1. **AI Agent 基础设施化**：Mendral、Temporal、Inngest 等团队都在探索如何让 AI Agent 的执行更可靠。Agent 的长时间运行特性天然适合 Durable Execution。

2. **框架集成加速**：Temporal 已与 Google ADK、OpenAI Agents SDK、Pydantic AI、Vercel AI SDK 集成，每个 LLM/工具调用自动成为 Durable Activity。

3. **混合架构兴起**：Agent Harness（控制循环）运行在 Durable Execution 引擎上，沙箱（代码执行环境）按需创建和销毁。这种架构兼顾了安全性和可靠性。

4. **成本优化**：沙箱只在执行命令时活跃，其余时间挂起（25ms 恢复）。长时间等待 CI、人工审批时不消耗计算资源。

## 总结

Durable Execution 不是一个新概念——数据库事务、消息队列、状态机都在解决类似的问题。但它的价值在于，把这些能力以一种对开发者友好的方式整合到了编程模型中。

你不需要写重试逻辑、不需要管理状态存储、不需要处理并发冲突。你只需要像写普通异步函数一样写代码，引擎负责其余一切。

在 AI Agent 时代，这一模式变得尤为重要。当 Agent 的执行时间从秒级扩展到小时级，当 Agent 需要与外部系统（LLM、工具、人工审批）深度交互时，Durable Execution 提供了构建可靠系统的基石。

如果你正在构建任何需要"长时间运行"的系统——无论是 AI Agent、数据流水线、订单处理还是 CI/CD——都值得认真评估 Durable Execution。

---

*相关阅读：*

- [深入理解 Model Context Protocol：AI 工具调用的统一标准](/article/model-context-protocol-deep-dive)
- [eBPF 深度实战：Linux 内核可编程革命的原理、工具与生产实践](/article/ebpf-deep-dive-linux-kernel)
- [WebTransport 深度实战：WebSocket 之后的下一代实时通信协议](/article/webtransport-realtime-revolution-2026)
