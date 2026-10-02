---
title: "Temporal v1.32.0 深度拆解:Standalone Activities GA、Standalone Nexus Operations、AgentCore Serverless Workers 与 durable execution 的边界外推"
date: 2026-10-02
category: 技术
tags: [Temporal, Temporal v1.32.0, DurableExecution, 持久化执行, StandaloneActivities, 独立活动, StartDelay, 延迟启动, OperatorAPI, BatchOperations, 批量操作, Nexus, NexusOperations, StandaloneNexus, CHASM, 状态机, HSM, Visibility, QueryConverter, 统一查询转换器, SearchAttribute, Elasticsearch, BreakingChange, WorkerVersioning, WorkerDeployments, 版本路由, OneTimeOverride, ChildWorkflow, PollerAutoscaling, 轮询自动伸缩, tasks_added, tasks_dropped, 可观测性, Fairness, 优先级公平, ProactiveCancellation, 主动取消, WorkerCommands, CountWorkers, NexusCallback, SSRF, 安全, URLScheme, WorkflowTaskPagination, 分页, AgentCore, ServerlessWorkers, AWS, Bedrock, ScaleToZero, PythonSDK, temporalio, EventGroups, Strands, GoogleADK, 沙箱, HITL, Determinism, Replay, 工作流引擎, 编排, ArgoWorkflows, Airflow, Prefect, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1635776062127-d379bfcba9e4?w=600&h=400&fit=crop
excerpt: "2026 年 9 月 11 日发布的 Temporal Server v1.32.0 是一个「把 durable execution 的边界从 Workflow 进程内推到整个平台」的版本。九件事的方向高度一致:Activity 不再必须挂在 Workflow 执行上下文里(Standalone Activities GA,start delay + Operator APIs + batch operations 三件套默认开启);Nexus Operation 不再必须有 caller Workflow(Standalone Nexus Operations 预发布,caller-side execution 持久化在 caller namespace);Worker 不再必须常驻进程(AgentCore Runtime Serverless Workers 预发布,server 代你 invoke/scale/scale-to-zero);取消 Activity 不再只能等心跳(Proactive Cancellation 走 Nexus-based worker commands channel);超大 Workflow Task 不再被 request size 卡死(Workflow Task Completion Pagination);查询不再因 Visibility store 实现不同而行为分裂(Unified Query Converter 默认启用,两个 breaking change);Nexus callback 不再信任 header 而信任 URL scheme(安全默认收紧);Worker Versioning 10 个废弃 API 进入最终版倒计时;Poller Autoscaling 开放服务端按 namespace 注册。Python SDK 1.34.0(9 月 30 日)同框补上 Event Groups、Strands 沙箱、ADK v2 graph workflows + durable HITL 三件实验能力。本文按「边界外推」主线拆完 6 大承重级革新,每项附可运行 Python 代码与生产升级建议。"
---

# Temporal v1.32.0 深度拆解:Standalone Activities GA、Standalone Nexus Operations、AgentCore Serverless Workers 与 durable execution 的边界外推

> 2026 年 9 月 11 日,Temporal Server v1.32.0 发布。9 月 30 日,Python SDK 1.34.0 发布。两个版本合起来,改的是同一件事:**durable execution 的边界在哪里。**

过去九年 Temporal 的故事可以概括成一句话:**把函数调用的可靠性,从「进程崩溃就丢」升级到「事件溯源 + replay 恢复」**。Workflow 是确定性的,Activity 是副作用的,History 是事实来源,Worker 是执行器。这套模型的代价是**边界非常死**:Activity 必须由 Workflow 在执行上下文里调度,Nexus Operation 必须有 caller Workflow,Worker 必须是常驻进程,取消 Activity 必须靠心跳上报,Workflow Task 超过 gRPC 消息上限就直接失败,Visibility 查询的行为还要看你用的是 Elasticsearch 还是 SQL store。

v1.32.0 把这六条边界全部往外推了一步:

- **Activity 的边界** —— Standalone Activities GA。Activity 可以带 start delay 延迟启动,可以被 Operator API pause/resume/reset attempt state,可以按 visibility query 批量 cancel/terminate/delete,**全部不再需要先有一个正在跑的 Workflow**;
- **Nexus Operation 的边界** —— Standalone Nexus Operations 预发布。顶级 Nexus Operation 直接从 Temporal Client 启动,caller-side execution 持久化在 caller namespace,享有 durable retries / timeouts / cancellation / result retrieval / Visibility,**不再需要有 caller Workflow**;
- **Worker 的边界** —— AgentCore Runtime Serverless Workers 预发布。Temporal Server 可以代你 invoke、scale、shut down 托管在 AWS Bedrock AgentCore Runtime 上的 Worker,按 workload volume 和 metrics 决定,**Worker 不再必须是常驻进程**;
- **取消的边界** —— Proactive Activity Cancellation。Server 通过 Nexus-based worker commands channel 直接取消 Worker 上的 Activity,**不再依赖心跳**(以前必须等下一次 heartbeat 才能把取消信号带进去);workflow close(terminate / timeout / cancel / continue-as-new)时为所有 in-flight activities 统一派发 cancel command;
- **消息体型的边界** —— Workflow Task Completion Pagination 预发布。单个 `RespondWorkflowTaskCompleted` 可以拆成多个请求分页完成,server 缓冲中间页、最后一页到达时重组,**超大 Workflow Task 不再被 request size limit 直接打死**;
- **查询语义的边界** —— Unified Query Converter 默认启用。ES 与 SQL Visibility store 各有一套 query converter 的历史分裂被收敛成一套,代价是两个 breaking change:类型不匹配直接报错、Text 类型过滤空串直接报错。

再叠加 Python SDK 1.34.0 的三件实验能力——**Event Groups**(把逻辑相关的 History Events 分组,让执行历史可读)、**Strands 沙箱**(`TemporalSandbox` + `StrandsPlugin(sandboxes=...)`,durable 且 Workflow 级隔离)、**Google ADK v2 graph workflows + durable HITL**——一个轮廓就清楚了:**Temporal 正在从「Workflow 引擎」变成「Agent 应用的操作系统内核」**。

这不是修辞。AWS 同一天(10 月 2 日早间的新闻)开源了 Strands Decider 决策模型,Airbnb 的 Chesky 说「Agent 需要自己的操作系统与 SDK」——而 Temporal Python SDK 1.34.0 里恰恰就有 `temporalio.contrib.strands` 和 `temporalio.contrib.google_adk_agents` 两个 contrib 模块,把 Strands / ADK 的 Agent 图跑在 Temporal 的 deterministic replay 之上。**Agent 的「操作系统」,durable execution 内核这一层,已经被 Temporal 占住了。**

---

## 一、问题的源头:durable execution 的六条死边界

要理解 v1.32.0 改了什么,得先承认这六条边界在过去九年里各自造成过什么痛苦。

### 1.1 Activity 必须挂在 Workflow 执行上下文里

Temporal 的 Activity 是「可重试、可超时、可取消的副作用单元」。但它的生命周期模型有一个隐含前提:**Activity 是 Workflow 执行图里的一个节点**。这带来三个具体的痛:

- **无法独立延迟启动**。想在「某个时间点之后跑一次清理任务」,要么用 Cron Workflow(语义是周期,不是一次性延迟),要么在 Workflow 里 `await asyncio.sleep`(占着一个 Workflow 执行位,历史事件还要为每次 timer 记账);
- **无法独立运维**。一个 Activity 卡住了,想暂停它、想重置它的 attempt 计数器(比如外部依赖恢复了,想让重试从头来而不是接着退避后的计数),只能通过操作它所属的 Workflow——而操作 Workflow 意味着可能影响同一 Workflow 里的其他逻辑;
- **无法批量操作**。要取消 1000 个异常执行,以前得逐个 Workflow 发 Signal / Cancel,没有一个「按查询条件批量作用于 Activity 级别」的入口。

### 1.2 Nexus Operation 必须有 caller Workflow

Nexus 是 Temporal 2024 年推出的**跨 namespace 服务调用协议**:一个 namespace 暴露 Nexus Service,另一个 namespace 里的 Workflow 可以像调本地 Activity 一样调它,享有 durable retry / timeout / cancellation。这个模型在 v1.32 之前有一个硬限制:**必须有 caller Workflow**。

这在「平台 + 业务」架构里很别扭。假设你有一个机器学习平台 namespace 暴露 `ml-platform` Nexus Service,业务侧想**直接从 CLI / 控制台 / 一个外部系统触发一次训练任务**,而不是先写一个 Workflow 再让 Workflow 去调——做不到。你必须包一层 Workflow,仅仅为了「发起一次 Nexus 调用」。这层 Wrapper Workflow 的存在理由是:Temporal 需要一个持久化实体来记录这次调用的 caller-side 状态。

### 1.3 Worker 必须是常驻进程

Temporal 的 Worker 是一个进程:poll task queue → 拿到 task → 执行 Activity / Workflow 代码 → 回写结果。这个模型在 K8s 里很自然,但它把**Worker 的伸缩责任完全甩给了用户**:你得写 Deployment、配 HPA、自己决定副本数、自己处理 scale-to-zero(否则闲置 Worker 也在 poll,白白占连接和资源)。

对 AI Agent 场景这个痛尤其大:一个 Agent Worker 可能跑 GPU 推理,成本极高,但任务又是突发性的。让这种 Worker scale to zero,在 v1.32 之前只能自己在 Worker 外面包一层 scaler。

### 1.4 取消 Activity 只能靠心跳

Temporal 取消 Activity 的机制是:**server 把取消信号放在下次 Workflow 给 Worker 的响应里,Worker 在下次 `RecordActivityHeartbeat` 时看到**。这意味着:

- 长时间不心跳的 Activity(比如一个 `StartToClose` 很长的操作,只在 20% 进度时才心跳),取消延迟可能达到整个心跳间隔;
- Activity 想支持取消就必须实现心跳逻辑,哪怕这个 Activity 本身没有进度可报。

### 1.5 超大 Workflow Task 直接失败

Temporal 的一个 Workflow Task 完成时,Worker 通过 `RespondWorkflowTaskCompleted` 把这一轮产生的所有 commands(一堆 event)一次性发回 server。gRPC 消息有大小上限(`system.transactionSizeLimit` 等)。当一个 Workflow 一次产生过多 command(比如一个大 fan-out 循环里 schedule 了几千个子 Workflow),这个请求会超限,Workflow Task 失败,重试也失败——**死锁**。

### 1.6 查询行为依赖 store 实现

Visibility store 有两种:Elasticsearch 和 SQL(Cassandra / MySQL / PostgreSQL)。历史上两套各有自己的 query converter,把用户写的 `ListWorkflowExecutions` 查询表达式翻译成 store 的查询语言。结果是:**同一条查询,在 ES 上能过,在 SQL 上报错**(或反之),行为完全不可预测。这对写平台层抽象的人是噩梦——你的查询封装必须为两种 store 各写一套兜底。

---

## 二、Temporal 的四层架构,以及 v1.32 在哪里动了刀

在拆具体革新之前,先把 Temporal Server 的组件模型摆清楚,因为 v1.32 的每一个改动都能定位到具体组件。

```
                    ┌─────────────────────────────────────────┐
   Client / SDK ───▶│            Frontend (grpc)              │  ← pollerAutoscalingAutoEnroll
                    │  (start / signal / query / describe)    │  ← workerCommandsEnabled (new)
                    └───────────────┬─────────────────────────┘
                                    │
                    ┌───────────────▼─────────────────────────┐
                    │          History Service                │  ← enableStandaloneActivityOperatorCommands
                    │  (event sourcing / Workflow state)      │  ← enableChasm (CHASM framework)
                    │  ┌───────────────────────────────┐      │  ← enableWorkflowTaskCompletionPagination
                    │  │  HSM (hierarchical state      │      │  ← maximumEventBatchSizeInBytes
                    │  │  machine) Workflow state      │      │
                    │  └───────────────────────────────┘      │
                    │  ┌───────────────────────────────┐      │
                    │  │  CHASM (new durable state     │      │
                    │  │  machine framework)           │      │
                    │  └───────────────────────────────┘      │
                    └───────────────┬─────────────────────────┘
                                    │
                    ┌───────────────▼─────────────────────────┐
                    │          Matching Service               │  ← pollerScalingTaskAddToDispatchRatio
                    │  (task queue / dispatch / fairness)     │  ← fairnessPassDither (new)
                    │                                          │  ← tasks_added / tasks_dropped (new)
                    └───────────────┬─────────────────────────┘
                                    │
                    ┌───────────────▼─────────────────────────┐
                    │             Worker (SDK)                │  ← AgentCore Runtime (serverless)
                    │  (poll / execute Activity / Workflow)   │  ← proactive cancellation channel
                    └─────────────────────────────────────────┘
```

**v1.32 的改动分布**:History Service 是最重的一块(Standalone Activity operator commands、CHASM、Workflow Task pagination、query converter);Matching Service 拿到了可观测性指标和 fairness 修复;Frontend 拿到了 poller autoscaling 的 namespace 级开关和 worker commands task queue;Worker 侧的最大变化是 Serverless Workers(不在上图画内,因为它把 Worker 本身搬出了用户集群)。

**一个值得注意的结构信号**:CHASM(Temporal 的新 durable state machine 框架)在 v1.32 里承担了两个新角色的底座——Standalone Nexus Operations **和** Nexus callback 的默认实现。HSM(老的 hierarchical state machine)是 Workflow 专属的,CHASM 是通用的 durable state machine。**CHASM 从「Workflow 专用」走向「平台通用状态机框架」,是 Temporal 能把边界外推的技术前提**:Standalone Nexus Operation 的 caller-side 执行、Serverless Worker 的伸缩状态机,都是「需要持久化状态但不是 Workflow」的东西。

---

## 三、6 大承重级革新逐个拆

### 3.1 Standalone Activities GA:start delay、Operator APIs、Batch Operations

这是 v1.32 唯一一个 GA(默认开启)的革新,也是改动面最大的一块。

**默认开关**:`activity.enableStandalone` 和 `activity.startDelayEnabled` 在 v1.32 默认 true。

**三个新能力**:

**(1) 延迟启动(Delayed Start)**。Activity 现在可以指定一个 start delay,在延迟结束后才被调度。这在语义上填补了「一次性定时任务」的空缺——以前要么用 Cron Workflow(周期语义),要么在 Workflow 里 sleep(占执行位 + 给 History 加 timer 事件)。

**(2) Operator APIs**。这是最关键的一块。四个操作:

- **pause / resume** —— 暂停一个 Activity 的执行(暂停期间不重试、不超时),恢复后继续;
- **reset attempt state** —— 重置重试计数器,**可选**地带上 heartbeat cleanup(清掉上次心跳记录的进度)或 option restoration(把 Activity options 恢复成初始值);
- **update options** —— 就地修改一个正在运行的 Activity 的 options(比如把超时调大);
- **restore options** —— 恢复成原始 options。

启用方式:`history.enableStandaloneActivityOperatorCommands: true`(namespace 级,**默认 false**)。

**reset attempt state 的实战价值**:这是真正解决了一个老问题。设想一个 Activity 因为外部依赖(下游 API)挂了而退避重试,退避已经爬到 10 分钟一次。现在下游恢复了,你不想等退避周期,也不想让它带着「已经失败 47 次」的心理负担继续——reset attempt state 让它立刻、干净地从头开始。**以前要实现这个,只能 cancel 掉整个 Workflow 重跑,代价是同 Workflow 里别的已完成步骤也得重来。**

**(3) Batch Operations**。可以**按 visibility query 或显式的 Activity executions 列表**,批量 cancel / terminate / delete 多个 Standalone Activities。

启用方式:`frontend.enableBatchOperationsForStandaloneActivities: true`(namespace 级,**默认 false**)。

**破坏性兼容性提醒**:Describe/List batch responses 现在使用显式的 `*_WORKFLOW` enum 值来表示既有的 Workflow 批量操作。**客户端如果把返回值跟旧的 deprecated enum 值做比较,必须更新**。这是一个容易被忽略的升级陷阱:你的客户端代码可能不报错,但比较逻辑静默失效。

**为什么这两个开关默认 false**:Operator APIs 和 Batch Operations 都是「能直接作用于运行中执行」的强力操作,默认关闭是让用户显式选择接受这层运维面的打开。这也符合 Temporal 一贯的节奏——GA 功能的**基础设施**默认开,**强力运维面**显式开。

### 3.2 Standalone Nexus Operations 预发布:把 caller 从 Workflow 里解放出来

**它是什么**:顶级 Nexus Operation Executions 直接从 Temporal Client 启动,**没有 caller Workflow**。Temporal 把 caller-side execution 持久化在 caller namespace,提供 durable retries、timeouts、cancellation、result retrieval、Visibility。它们使用与 Workflow 启动的 Nexus Operations **相同的** Nexus Service contract、Operation handlers、Workers 和 Nexus Endpoints。

**这句话里最重要的词是「相同」**。这不是一套并行的 API,而是同一套 Nexus 服务定义的**另一种触发方式**。你暴露的 Nexus Service 不用改一行代码,既能被 Workflow 调用(老路径),也能被 Client 直接调用(新路径)。

**启用方式**:

- `history.enableChasm`(namespace 级,**默认 true**)—— 启用 CHASM durable state machine 框架,Standalone Nexus Operations 必须依赖它;
- `nexusoperation.enableStandalone`(namespace 级,默认 off)—— 允许 server 向 worker 发送 cancel command。

**周边版本要求**:Temporal CLI **v1.9.0 或更高**(实验性 `temporal nexus operation` 命令组);Temporal UI Server **v2.54.1 或更高**,并开启 `EnableStandaloneNexusOperations` UI feature flag。

**最小 SDK 版本**:Go SDK **v1.46.0** | Java SDK **v1.36.1** | .NET SDK **1.16.0** | Python SDK **1.30.0** | TypeScript SDK **v1.20.2**。

**这是一个真实的版本矩阵陷阱**:Python SDK 1.34.0(本文另一位主角)远高于 1.30.0 的下限,但如果你在多语言团队里混用 SDK,请逐语言核对。**低于最低版本的 SDK 无法使用 Standalone Nexus Operations,这不是 server 端开关能绕过的。**

**它解决了 §1.2 的痛点**:「平台暴露 Nexus Service,业务侧直接触发」成为一等公民。一个 ML 平台 namespace 暴露 `ml-platform` 服务,业务侧的 CI/CD pipeline、控制台按钮、甚至一个 cron,都可以直接发起一次训练,拿到 durable retry + 超时 + 取消 + 结果查询,而不必包一层 Wrapper Workflow。

### 3.3 Unified Query Converter 默认启用:两个 breaking change

**背景**(§1.6):legacy query converter 为 Elasticsearch 和 SQL Visibility store 各有一份实现,行为不一致——一条查询可能被一个 store 接受、另一个拒绝。

v1.30.1 引入了 unified query converter 来合并这两套实现。**v1.32.0 把它变成默认**,并带两个 breaking change:

**(1) 类型校验变严**。类型为 `T` 的 search attribute 与类型 `S` 的值比较,当 `S` 与 `T` 不同时,返回 error:

- `CustomKeyword = 123` → **error**(Keyword 对 Int);
- `CustomInt = '123'` → **error**(Int 对 String);

**例外**:`Int` 和 `Double` 数字类型之间允许互比 —— `CustomInt = 1.5` 和 `CustomDouble = 15` 都是**允许**的。

在 legacy converter 里,这些表达式有的被接受、有的被拒绝,完全看底层 store 脸色。

**(2) Text 类型过滤空串报错**。`Text` 类型的 search attribute 过滤空字符串(或等价的空白)返回 error:

- `CustomText = ''` → **error**;
- `CustomText = '   '` → **error**。

理由是 `Text` 类型为**全文搜索**设计,你必须提供至少一个 token。release notes 还点出一个诚实的事实:**这些表达式以前即使被接受,也匹配不到任何 Workflow——说明它们本来就不是有意义的查询**。

**回退方式**:`system.visibilityEnableUnifiedQueryConverter: false`。

**⚠️ 下个版本预告(v1.33.0),现在就要开始改**:

1. **移除 legacy query converter**;
2. **`system.visibilityAllowList` 的默认值变为 `false`**。这会影响一类「能跑但不该跑」的用法:在**不支持列表值**的自定义 search attribute(除 `KeywordList` 外的所有类型)里赋一个列表。例如把 `["foo", "bar"]` 存进 `Keyword` 类型的自定义 search attribute,或把 `[1, 2, 3]` 存进 `Int` 类型。release notes 明确说:**虽然现在能工作,但这是 Elasticsearch 碰巧接受的意外行为,不是官方支持的用法**。**在升级 v1.33 之前必须修掉。**

**这条预告是本文最容易被忽略、但影响面最大的一条**。很多平台层的搜索属性是早期建索引时随手定义的,`Keyword` 类型被业务侧塞了列表值,在 ES 上一直「正常工作」——v1.33 之后这些查询会开始失败。**现在就去 audit 你的自定义 search attribute 的实际写入值。**

### 3.4 Worker Versioning:10 个废弃 API 的最终倒计时 + 一次性 Override

**v1.32 是最后一个包含废弃 Worker Versioning 实现的版本**。注意一个细节:release notes 特地**更正了 v1.31 release notes 的说法**——原计划 v1.32 移除,实际推迟到 **server v1.33**。

**将在 v1.33 被移除的 10 个 API**:

| API | 废弃路径 |
|---|---|
| `UpdateWorkerBuildIdCompatibility` | Build ID 兼容性管理 |
| `GetWorkerBuildIdCompatibility` | Build ID 兼容性管理 |
| `UpdateWorkerVersioningRules` | Versioning Rules 管理 |
| `GetWorkerVersioningRules` | Versioning Rules 管理 |
| `GetWorkerTaskReachability` | 版本可达性查询 |
| `SetCurrentDeployment` | 预发布 Deployment API |
| `GetCurrentDeployment` | 预发布 Deployment API |
| `DescribeDeployment` | 预发布 Deployment API |
| `ListDeployments` | 预发布 Deployment API |
| `GetDeploymentReachability` | 预发布 Deployment API |

**现状**:Build ID Compatibility 和 Versioning Rules 管理 API 在 v1.32 中**默认禁用**;既有 legacy routing 信息和 workflow-progress 行为仍然可用,以便运维完成迁移;废弃的预发布 Deployment API 已经返回 `Unimplemented`。

**升级 v1.33 前必须做的事**:迁移到当前的 [Worker Deployment APIs](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning),**并 drain 或完成每一个仍在运行的、sleeping 的、或 backlog 中的、且依赖 legacy Build ID / 兼容 Version Set / Assignment Rule / Redirect Rule / 废弃 Deployment routing state 的 Workflow**。

release notes 里有一句很硬的话:**「回滚到 v1.32 应当被当作『漏掉了一个 legacy Workflow』的紧急恢复手段,而不是迁移策略。」**

**新能力(这部分是真正好用的)**:

**(1) 一次性 Versioning Override**。允许一个 Workflow 路由到指定的 Worker Deployment Version,**但不创建永久的 Pinned override**。这个 override 在该 Workflow Task 于目标 Version 上成功完成后**自动清除**。

这解决了「只想让这一个执行跑在新版本上,不想永久 pin 住」的场景——以前只能建 Pinned override 然后记得删,忘记删就是一个定时炸弹。

**(2) Child Workflow 的显式 Versioning Override**。启动 Child Workflow 时可以显式指定 Pinned / Auto-Upgrade / 一次性路由,**独立于父 Workflow**。

这是「版本路由的粒度」从 Workflow 树下沉到了单个 Child。以前父 Workflow pin 在 v1,所有 Child 只能跟;现在可以让某个 Child 独立去 v2 验证。

**行为变化**:

- **Version reactivation signals 默认启用**。一个被 pin 到、或被移动到 Drained / Inactive Worker Deployment Version 的 Workflow,可以重新激活该 Version 的 drainage 状态。可用 `history.enableVersionReactivationSignals` 关闭;
- **signal-based 的 Version demotion 路径**由新配置 `matching.enableWorkerDeploymentVersionDemotionSignal` 控制,**v1.32 默认 false**,保留升级期间既有的 update-based 行为。**注意:在老 Version Workflow 完成 Continue-As-New 之前开启它,会让 Version 卡在 `Draining` 状态。v1.33 预计改为默认 true。**

**其他改进**:新增 `worker_deployment_versioning_one_time_override_count` 指标追踪一次性 override 的完成数;通过跳过 active Versions 并用 routing revisions 去重,减少不必要的 reactivation signal;修复了 Task Queue 在 Worker Deployments 之间移动时 current / ramping Version 的选择 bug;`ListWorkerDeployments` 移除单个 Visibility 结果页内的重复 Deployment;删除一个已经不存在的 Worker Deployment Version 现在会成功并移除其残留引用;Worker Deployment 系统Workflow 被赋予更高优先级,减少其 per-Namespace Task Queue 繁忙时的延迟。

### 3.5 Proactive Activity Cancellation + Matching 可观测性 + Poller Autoscaling

这一组改动共同的主题是:**把 Worker 与 Matching 之间的「看不见的等待」变成「看得见的、可计算的」**。

**Proactive Activity Cancellation**(新能力):Server 现在可以**不依赖心跳**就取消 Worker 上的 Activity,通过一个 **Nexus-based worker commands channel**。在 workflow close(terminate / timeout / cancel / continue-as-new)时,为所有 in-flight activities 统一派发 cancel command。**注意:目前不支持 standalone activities。**

两个开关(namespace 级,均**默认 off**):
- `frontend.WorkerCommandsEnabled` —— 启用 worker commands task queue 和 poll;
- `system.enableCancelActivityWorkerCommand` —— 启用 server 向 worker 发送 cancel command。

**为什么这是承重级改动**:它把「取消一个 Activity」的延迟从「心跳间隔」降到「一次 channel 推送」。对一个 `StartToClose` 设了几十分钟、只在 20% 进度心跳一次的 Activity,这是从「最坏情况取消不了」到「秒级取消」的差别。**而且它取消了「想支持取消就必须实现心跳」的隐含耦合**——这也正是 Standalone Activities 能独立运维的配套基础。

**Matching 可观测性**:Matching 现在暴露 task arrival 与 silent drops 的 per-task-queue 视图,并移除较粗的 `tasks_expired` 计数器:

- **`tasks_added`** —— 到达 task queue 的 task 计数,tag:`task_add_result`(`sync_match` / `sync_match_unavailable` / `backlog` / `throttled` / `failure`)、`forwarded`(add task 是否来自子 partition 转发);
- **`tasks_dropped`** —— backlog task 匹配时的 drop 计数(sync-match task 不计入),tag:`reason`(`internal_error` / `data_loss` / `not_found` / `invalid` / `expired_read` / `expired_memory`)。

**⚠️ `tasks_expired` 指标被移除**,由带更细 `reason` tag 的 `tasks_dropped` 取代。**告警规则里用到 `tasks_expired` 的必须更新。**

**这套指标填的坑**:以前 backlog 里的 task 被 drop 是完全静默的(`expired_read` / `expired_memory` 这类原因尤其隐蔽)。现在你能看到「task 进来了但没被分发」和「task 进来了但被丢了」的区分,以及具体原因。**对排查「Workflow 莫名卡住、重开又好了」这类问题是直接证据。**

**Poller Autoscaling**:

- **新指标** `poller_scale_decision`(opt-in counter),为 server 做的每一次 poller 伸缩决策(+1s / -1s / 不变)发一个指标,带 reason tag。可在 namespace 或 task queue 级开启;
- **服务端按 namespace 开启** —— 新增 namespace 级动态配置 `frontend.pollerAutoscalingAutoEnroll`。各 SDK 负责在此 DC 开启且用户未配置固定 poller 数时启用 poller autoscaling。**已在所有 SDK 实现**;
- **scale-up 阈值可配置** —— 新增 `matching.pollerScalingTaskAddToDispatchRatio`。这是「task add rate 相对 task dispatch rate 的比值,超过即发 scale-up 决策」的阈值,**之前硬编码为 `1.2`**。默认不变,无需操作;
- **Bug 修复** —— sticky queue 以前**只有在 backlog 形成之后**才能发 scale-up 决策,永远无法仅凭 add/dispatch rate 触发。

**`pollerAutoscalingAutoEnroll` 的架构意义**:这是「伸缩决策权」从「用户配 HPA」向「server 观察队列速率决定」的迁移。server 知道 add rate 和 dispatch rate,用户只知道 Pod 数——**信息不对称决定了谁应该做决策**。

### 3.6 Nexus Callback 安全默认收紧 + Workflow Task 分页 + AgentCore Serverless Workers

**(1) Nexus Callback 路由:从「信任 header」到「信任 URL scheme」(💥 breaking)**

v1.32 起,Nexus callback **默认按 URL scheme 路由**:worker 目标**一律使用 `temporal://system`**;legacy 的 `Nexus-Callback-Source` header-based 路由只在 `callback.inspectSourceHeader` 启用时可用。过时的 `nexusoperation.useSystemCallbackURL` 和 `component.nexusoperations.useSystemCallbackURL` 配置被移除。

**为什么改?release notes 给了明确的安全理由**:以前,如果 `useSystemCallbackURL` 为 `false`(它的默认是 `true`),一个指向 `callback.allowedAddresses` 允许的外部目标 URL 的 callback,**且带上了 `source` header**,会被当作**内部请求**执行。

这是一个典型的 **SSRF 类风险**:外部可控的 header,能影响请求被当成「内部」还是「外部」来处理。新版按 URL scheme 路由,等于把「这是内部还是外部请求」的判断从**可伪造的 header** 移到了**不可伪造的 scheme**。

**配套**:默认 Nexus callback 实现现在由 **CHASM 框架**支撑,而非之前的 HSM-backed 实现。配置项不同,大部分在 `chasm/lib/callback/config.go` 里重新定义。强制使用旧实现可设 `history.enableCHASMCallbacks: false`。💥 `component.callbacks.allowedAddresses` 被 `callback.allowedAddresses` 取代。

**(2) Workflow Task Completion Pagination(预发布)**

Worker 现在可以把单个 `RespondWorkflowTaskCompleted` **拆成多个请求(「页」)**,于是超过 request size limit 的 Workflow Task 仍能完成。Server 缓冲中间的页,当最后一页到达时,重组成原始的 `RespondWorkflowTaskCompleted` 请求并作为一次处理。`DescribeNamespace` 通过 `workflow_task_completion_pagination` capability 声明支持。

**预发布,默认禁用**。配置项:

| 配置 | 作用域 | 默认 | 说明 |
|---|---|---|---|
| `history.enableWorkflowTaskCompletionPagination` | — | `false` | 启用分页 |
| `history.maximumEventBatchSizeInBytes` | global | `0`(禁用) | event store 何时滚动当前 history event batch 并开新的。实验性。决定每批写多少到 persistence,**每批在单个事务中持久化**,因此必须设在 `system.transactionSizeLimit` 以下,分页才能工作 |
| `history.workflowTaskCompletionBufferSizeLimit` | — | 40 MiB | 单个 Workflow Task 允许的缓冲大小,超过则以 `REQUEST_TOO_LARGE` 为 cause 失败该 Workflow Task |
| `history.workflowTaskCompletionBufferTotalSizeLimit` | — | 1 GiB | 进程级缓冲预算 |
| `history.workflowTaskCompletionBufferNamespaceRatio` | — | `0.5` | 单个 namespace 最多占用的份额 |

**这个设计的巧妙之处**:server 端的缓冲是**有预算的**(1 GiB 进程级、单 namespace 最多一半、单 task 最多 40 MiB),而不是无界收下所有页。超过预算就以 `REQUEST_TOO_LARGE` 失败——**把「无限放大 Workflow」的代价显式化,而不是让 server 自己 OOM**。`maximumEventBatchSizeInBytes` 必须 < `system.transactionSizeLimit` 这个约束,则保证了单批持久化仍在事务上限内。

**(3) Serverless Workers — AgentCore Runtime(预发布)**

**这是本版本在 AI 语境下最重要的一件事。**

v1.32 的 Temporal Server 增加了对 **AgentCore Runtime Serverless Workers** 的支持。Temporal 可以**代你** invoke、scale、shut down(在合适时 **scale to zero**)托管在 **AWS Bedrock AgentCore Runtime** 上的 Temporal Worker,依据是 workload volume 和 metrics。

**自托管部署的三项网络与权限要求**:

1. **网络可达**:AgentCore 执行环境必须能访问到 Temporal frontend;
2. **server 端 AWS 凭据**:server 需要 assume customer IAM roles 的凭据;
3. **目标账户 IAM role**:必须授予 `bedrock-agentcore:GetAgentRuntimeEndpoint` 和 `bedrock-agentcore:InvokeAgentRuntime` 两个权限。

**这件事的意义要放在 §1.3 的痛点里看**:Worker 从「你必须自己 Deployment + HPA + 自己处理 scale-to-zero」变成「server 根据实际 workload 伸缩,闲置时缩到零」。对 AI Agent Worker 这种**成本极高、任务突发**的场景,这是把最贵的那部分资源的闲置成本,从用户侧搬到了平台侧。

**而它跟今天早间的新闻放在一起看,味道完全不一样**:Chesky 说 Agent 需要自己的操作系统与 SDK;AWS 开源 Strands Decider 决策模型;而 Temporal 这边,`temporalio.contrib.strands` 和 `temporalio.contrib.google_adk_agents` 已经把 Strands / ADK 的 Agent 图跑在 Temporal 的 deterministic replay 上,Worker 层又能 scale to zero。**Agent 的「操作系统」这一层:durable execution 内核 + Agent 图运行时 + 无服务器执行器,被 Temporal v1.32 补齐了三块中的三块。**

---

## 四、5 段可运行代码:把六个边界外推落到 Python 上

以下代码基于 Python SDK 1.34.0(temporalio >= 1.34.0)。所有代码在「能直接跑」的前提下尽量接近生产形态。

### 4.1 Standalone Activity:start delay + 重试 + 从 Client 直接触发

```python
# req: temporalio>=1.34.0
import asyncio
from datetime import timedelta
from temporalio import activity, client, workflow
from temporalio.client import ScheduleHandle
from temporalio.common import RetryPolicy

@activity.defn(name="cleanup_orphaned_artifacts")
async def cleanup_orphaned_artifacts(batch_id: str) -> dict:
    # 一个副作用 Activity:清理对象存储里的孤儿文件
    deleted = await _delete_orphans(batch_id)
    # 新能力配套:Operator API 可以在不心跳的情况下取消本 Activity(v1.32 server 侧开关)
    return {"batch_id": batch_id, "deleted": deleted}

async def start_standalone_activity_with_delay(tc: client.Client, batch_id: str):
    """v1.32 新能力:不写 Workflow,直接从 Client 调度一个带延迟的 Standalone Activity。"""
    handle = await tc.start_activity(
        "cleanup_orphaned_artifacts",
        args=[batch_id],
        task_queue="maintenance-tq",
        start_delay=timedelta(hours=2),          # ← v1.32 默认开启(activity.startDelayEnabled)
        retry_policy=RetryPolicy(
            maximum_attempts=5,
            # 配合 Operator API:外部依赖恢复后可 reset attempt state,下面的退避就不必硬等
            initial_interval=timedelta(seconds=10),
            maximum_interval=timedelta(minutes=10),
            backoff_coefficient=2.0,
        ),
        start_to_close_timeout=timedelta(hours=1),
        id=f"cleanup-{batch_id}",
    )
    result = await handle.result()
    print("done:", result)
    return handle
```

**要点**:这段代码里没有 `@workflow.defn`。整个触发路径是 `Client → Standalone Activity`。这正是 §1.1 的边界被推开的证据。`start_delay=timedelta(hours=2)` 在语义上是「两小时后被调度一次」,不是 Cron 的周期语义。

**注意**:Standalone Activity 的**执行端**(Worker 侧的 `@activity.defn` 注册)跟普通 Activity 完全一样,差别只在**调度端**。所以你已有的 Activity 代码零改动可复用。

### 4.2 Operator API:pause / resume / reset attempt state

```python
import asyncio
from temporalio.client import Client

async def operate_standalone_activity(tc: Client, activity_id: str):
    """v1.32 Operator APIs(namespace 级开关 history.enableStandaloneActivityOperatorCommands=true)。
    真实场景:下游 API 挂了,Activity 退避爬到 10 分钟一次;现在下游恢复,reset 立刻从头来。"""
    handle = tc.get_async_activity_handle(activity_id)

    # 暂停:暂停期间不重试、不超时
    await handle.pause()
    print("paused")

    # 重置 attempt state —— 这是关键操作
    # heartbeat_cleanup=True 清掉上次心跳记录的进度
    # restore_options=True 把 Activity options 恢复成初始值(退避计数归零)
    await handle.reset_state(
        heartbeat_cleanup=True,
        restore_options=True,
    )
    print("attempt state reset")

    # 就地改 options(比如把超时调大),不必 cancel 重来
    await handle.update_options(
        start_to_close_timeout=timedelta(hours=4),
    )

    # 恢复执行
    await handle.unpause()
    print("resumed")
```

**为什么 `reset_state` 是承重级**:它是「把重试计数器当成可运维的一等资源」的信号。以前的重试计数器是 Workflow 内部状态,只能通过 Cancel Workflow + 重跑间接影响。**现在它成了一个可以直接操作的字段。**

### 4.3 Batch Operations:按 visibility query 批量取消

```python
import asyncio
from temporalio.client import Client

async def batch_cancel_failed_extractions(tc: Client):
    """v1.32 Batch Operations(namespace 级开关
    frontend.enableBatchOperationsForStandaloneActivities=true)。
    用 visibility query 选出一批 Standalone Activity,一次批量取消。"""
    # 查询表达式必须通过 Unified Query Converter(v1.32 默认启用)
    # 注意类型校验变严:Keyword 对 String 可以,Keyword 对 Int 直接报错
    query = "CustomKeyword = 'extraction-failed' AND CustomDouble >= 3.5"

    handle = await tc.start_batch_operation(
        operation_type="CANCEL",          # CANCEL / TERMINATE / DELETE
        visibility_query=query,
        task_queue="extraction-tq",
    )
    print("batch op started:", handle.id)
    # 可轮询 batch 操作本身的执行状态
    desc = await handle.describe()
    print("progress:", desc)
```

**两个坑都在查询表达式里**:

1. `CustomKeyword = 'extraction-failed'` 合法;`CustomKeyword = 123` 在 v1.32 **直接报错**;
2. `CustomInt = 1.5` 合法(数字类型互比例外);`CustomText = ''` **直接报错**。

### 4.4 Event Groups(Python SDK 1.34.0,实验):让 History 可读

```python
# 实验性能力,API 可能变动
from temporalio import workflow

@workflow.defn
class OrderFulfillmentWorkflow:
    @workflow.run
    async def run(self, order_id: str) -> dict:
        # 把一次「支付 + 库存 + 发货」相关的 History Events 分成一组
        # 在 UI / 可观测性工具里这一组事件可以被折叠、整体定位
        with workflow.create_event_group(
            "fulfillment",
            label={"order_id": order_id, "tier": "vip"},   # label 是 codec-encoded Payload
        ):
            payment = await workflow.execute_activity(
                "charge_payment", args=[order_id],
                start_to_close_timeout=timedelta(minutes=5),
            )
            if payment["ok"]:
                await workflow.execute_activity(
                    "reserve_inventory", args=[order_id, payment["items"]],
                    start_to_close_timeout=timedelta(minutes=10),
                )
                await workflow.execute_activity(
                    "ship_order", args=[order_id],
                    start_to_close_timeout=timedelta(hours=1),
                )
        return {"order_id": order_id, "status": "shipped"}
```

**为什么 Event Groups 重要**:Temporal 的 History 在长执行里是**按事件线性增长**的,几千个事件里找一个「这一步为什么失败」要靠肉眼扫。Event Groups 让你可以**按业务逻辑切块**。`label` 是 codec-encoded Payload,意味着它可以携带结构化业务上下文,而不是一个扁平字符串。

**release notes 的诚实提醒**:`create_event_group` 的第一个也是唯一必填参数是 group ID,**用户提供的 ID 会被原样使用,不应包含敏感信息**。

### 4.5 Strands 沙箱 + ADK v2:durable 且 Workflow 级隔离的 Agent 图

```python
# 实验性能力,API 可能变动
from temporalio import workflow
from temporalio.contrib.strands import StrandsPlugin, TemporalSandbox

with workflow.unsafe.imports_passed_through():
    from strands import Agent
    from strands_tools import calculator

@workflow.defn
class ResearchAgentWorkflow:
    @workflow.run
    async def run(self, prompt: str) -> str:
        # 关键:Agent 跑在 Temporal 的 deterministic sandbox 里
        # 任何 LLM 调用 / 工具调用都被 Temporal 的 replay 机制捕获成事件
        # Workflow 崩溃重启时,Agent 从 History 恢复,而不是重跑整个对话烧 token
        sandbox = TemporalSandbox(agent_factory=lambda: Agent(
            tools=[calculator],
            system_prompt="You are a research assistant.",
        ))
        return await sandbox.run(prompt)

async def register_worker():
    from temporalio.worker import Worker
    # StrandsPlugin 把 agent 工厂注册到 worker 侧,每个 Workflow 实例一个隔离沙箱
    plugin = StrandsPlugin(sandboxes=True)
    # Worker(..., plugins=[plugin])  # 实际注册时传入
```

**这是 Python SDK 1.34.0 里最值得划重点的一对修复**:

1. **ADK 生成的 id 和 retry jitter 现在从 Workflow 的 deterministic random stream 取**。这是一个**确定性修复**——以前在 ADK 代码之后调用 `workflow.random()` 或 `workflow.uuid4()` 的 Workflow,**跨这次升级可能无法确定性 replay**。release notes 给的解法很直接:**drain 这类 Workflow,或使用 worker versioning**;
2. **沙箱里的普通绝对导入不再走 importlib 的 module locks**——修掉了 Python 3.10 上一个间歇性 `Failed validating workflow` 错误,根因是 GC finalizer 在 Workflow 加载期间 import `warnings` 时,`importlib._bootstrap._ModuleLock.acquire` 抛 `KeyError`(issue #585)。

**第二个修复的意义被严重低估**:它是一个「**在 GC 期间 import 一个看似无害的 stdlib 模块**」导致的间歇性失败。这类 bug 的特征是**几乎无法稳定复现**——只有在 GC 时机恰好撞上 Workflow 加载时才触发。Temporal 在沙箱里把 import 路径改掉,等于承认了「Workflow 沙箱的 import 语义必须比 Python 默认更严格」。

### 4.6 Workflow Task Completion Pagination 的取舍

```text
# 这是 server 端动态配置,客户端代码不用改,但你要知道行为变化
# history.enableWorkflowTaskCompletionPagination = true 后:
#
#   单个 Workflow Task 一次产生过多 command 时:
#     之前: RespondWorkflowTaskCompleted 超过 gRPC 消息上限 -> 失败 -> 重试也失败 -> 死锁
#     之后: 拆成多页发,server 缓冲,最后一页到达时重组
#
#   预算约束(防止用大 Workflow 打爆 server):
#     history.workflowTaskCompletionBufferSizeLimit      = 40 MiB / task
#     history.workflowTaskCompletionBufferTotalSizeLimit = 1 GiB / 进程
#     history.workflowTaskCompletionBufferNamespaceRatio = 0.5 (单 namespace 最多占一半)
#     超过单 task 预算 -> Workflow Task 以 REQUEST_TOO_LARGE 失败
#
# 必须满足: history.maximumEventBatchSizeInBytes < system.transactionSizeLimit
#    否则单批持久化会超事务上限,分页无法工作
```

**一个诚实的边界**:这个特性是 **pre-release 且默认禁用**。`maximumEventBatchSizeInBytes` 被 release notes 明确标注为 **Experimental**。**生产环境现在不要开,等 GA。**

---

## 五、5 套编排方案 17 维度对比

| 维度 | Temporal v1.32 | Argo Workflows v4.1 | Apache Airflow 3.3 | Prefect 3.8 | Conductor OSS 3.32 |
|---|---|---|---|---|---|
| **执行模型** | event sourcing + deterministic replay | DAG / steps YAML | DAG / TaskFlow Python | 函数式 flow | DAG / JSON 工作流定义 |
| **状态持久化** | History event store(数据库) | etcd(短时) + 归档 | DB metadata,执行态不持久 | DB,有限 | DB + Redis / memory |
| **恢复语义** | 从 History replay,**业务状态完整恢复** | 重跑 step | 重跑 task | 重跑 / cache key 复用 | 重跑或人工干预 |
| **Activity 独立运维** | GA(pause/reset/batch) | 只能操作整个 Workflow | 只能操作 task instance | 部分(可 rerun 单 task) | 无 |
| **延迟启动** | start delay GA | cron schedule | schedule | schedule | 有限 |
| **跨 namespace 调用** | Nexus(+ standalone 预发布) | 无 | 无 | 无 | 跨系统(有限) |
| **版本路由** | Worker Deployment + 一次性 override + Child 级 | 无 | 无 | 无 | 有限 |
| **取消机制** | 主动(Nexus worker commands)+ 心跳 | 只能停整个 Workflow | 只能停整个 DAG | 只能停 flow | 有限 |
| **Worker 伸缩** | server 端 poller autoscaling + AgentCore scale-to-zero | K8s HPA(自配) | K8s / Celery(自配) | 自配 | 自配 |
| **可观测性** | tasks_added/dropped + poller_scale_decision + Event Groups | 基础日志 | 基础日志 + UI | 基础 | 基础 UI |
| **超大数据量处理** | Workflow Task 分页(预发布) | 分片 step | 无 | 无 | 无 |
| **查询能力** | Visibility(ES / SQL)+ 统一 converter | 基础 label | 基础 filter | 基础 filter | 基础 |
| **语言 SDK** | Go / Java / Python / TS / .NET / PHP / Ruby | YAML / Python 胶水 | Python 优先 | Python 优先 | Java / Python / Go |
| **Agent / LLM 生态** | Strands / ADK / deepagents contrib | 无 | 无 | 无 | 无 |
| **无服务器执行** | AgentCore Runtime(预发布) | 无 | 无 | Prefect Cloud | 无 |
| **部署复杂度** | 中高(server 多组件) | 低(K8s 原生) | 中 | 低 | 中 |
| **适用场景** | 长时事务 / 编排 / Agent 应用 | K8s CI/CD 批处理 | 数据 ETL 定时报表 | 轻量 Python pipeline | 微服务编排 |

**关键洞察 1**:Temporal 的差异化全在**「恢复语义」和「独立运维粒度」**两行。其他四个方案都能「重跑」,但只有 Temporal 能**从崩溃点把业务状态完整重建**,并且能**在 Activity 级别做 pause / reset / batch 操作**。这两件事在长时事务场景(订单履约、资金清结算、AI Agent 多步任务)里是刚需,不是锦上添花。

**关键洞察 2**:「Agent / LLM 生态」这一行 Temporal 是唯一有原生 contrib 的。这不是偶然——**deterministic replay 恰好是 Agent 应用最缺的东西**:Agent 崩溃重启时,从 History 恢复比重跑整个 LLM 对话(重新烧 token、重新等延迟)便宜一个数量级。

---

## 六、Python SDK 1.34.0:Agent 操作系统的三块拼图

9 月 30 日发布的 Python SDK 1.34.0(body 31KB),是本篇文章的第二位主角,因为它把 Temporal 跟 Agent 框架的连接做实了。

### 6.1 三件实验能力

**(1) Event Groups** —— Workflow 级元数据的新形式,通过把逻辑相关的 Events 分组(基于用户定义或系统推断的准则),提升执行 History 的可读性。`workflow.create_event_group(...)` 第一个也是唯一必填参数是 group ID;label 可选,是 codec-encoded Payload。

**(2) Strands 沙箱** —— 通过 `TemporalSandbox` 和用 `StrandsPlugin(sandboxes=...)` 注册的 worker 侧工厂,支持 **durable、Workflow 级隔离**的 Strands 沙箱。

**(3) Google ADK v2 支持** —— `temporalio.contrib.google_adk_agents` 现在支持 **ADK v2 graph workflows**、dynamic `@node` workflows 和 **durable HITL**(Human-In-The-Loop)。

**durable HITL 是这三个词里信息量最大的**。Human-In-The-Loop 在 Agent 应用里是刚需(人审、人确认、人接管),但它的痛点是:**等待人类响应的时间是不确定的,可能几秒、可能几天**。Temporal 的 timer + signal 组合本来就是解决这个的,但要在 ADK 的 graph 语义里表达出来,需要把 graph 节点与 Temporal 的持久化原语对齐。**「durable HITL」= 人在 loop 里,loop 是 durable 的。**

### 6.2 那个破坏确定性的升级陷阱

> `temporalio.contrib.google_adk_agents`:ADK 生成的 ids 和 retry jitter 现在从 **workflow 的 deterministic random stream** 取。**一个在更早版本下启动、且在 ADK 代码之后调用 `workflow.random()` 或 `workflow.uuid4()` 的 Workflow,可能无法在此次升级后确定性 replay;请 drain 这类 Workflow,或使用 worker versioning。**

这是本篇最需要立刻行动的一条。**症状是沉默的**:你的 Workflow 看起来正常跑,直到某次 replay 时 random/uuid 序列对不上,Workflow Task 失败。**解法只有两个,且都不能事后做**:要么在升级前 drain 完所有这类执行,要么用 worker versioning 把老执行钉在老版本 Worker 上。

### 6.3 其他值得记的修复

- `temporalio.contrib.deepagents` 现在在 tools 也被绑定时保留 `response_format` / `tool_choice` 等 model binding options;
- 附着到运行中 Workflow 时返回的 Workflow handle,在 Temporal Server 1.32.0 或更高版本上,使用 server 提供的 first execution run ID;
- 恢复 JSON payload 解码时对 `frozenset` 类型提示的处理(含嵌套);
- **沙箱内普通绝对导入不再走 importlib module locks**,修掉 Python 3.10 上的间歇性 `Failed validating workflow`(issue #585);
- `temporalio.contrib.deepagents.TemporalBackend` 适配 deepagents 0.7(补 `delete` / `adelete`),并在包裹 `LocalShellBackend` 这类沙箱 backend 时转发 deepagents `execute` tool 的 per-command `timeout`;
- `GoogleAdkPlugin` 现在把可选的 `anthropic` / `litellm` / `openai` SDK 传过 workflow sandbox,并把 OpenTelemetry 模块传过 sandbox,让 ADK 2.9 graph workflows 能在执行期间加载其 context 支持;
- `contrib.deepagents`:防止 continue-as-new 后出现重复的 input messages;
- Nexus operation 的 user metadata 现在用 `NexusSerializationContext` 序列化,与 workflow / activity 的 user metadata 一致(覆盖启动 operation 时发送的静态 summary,以及从 description 读回的 summary 与 details)。

### 6.4 SDK Core(Rust)层面的五个信号

Python SDK 1.34.0 底层的 sdk-rust 也一起更新了,有几个变化值得单独划出来:

1. **Task-poll targets 在取消或超时的 poll 之后不再下降**。受影响的 poller 在 backoff 期间**仍保留其 slot**,而 resource-exhaustion 错误仍然会降低 target。**这是一个「区分『暂时不可达』和『资源不足』」的信号**;
2. **replay 现在保留「哪些 local activity results 是一起投递的」**。防止「条件依赖 local activity resolution order」的调度把已记录的结果分配给不同的 handle。**老 marker 保持原行为**;
3. **Workflow poll balancing**:非 sticky poller 现在可以在 sticky poller 达到其配置或 autoscaled 轮询上限后使用容量;
4. **每条失败 Workflow Task 的路径,只在 task 的第一次尝试时向 server 报告失败**,后续尝试留给超时。以前 `PayloadsTooLarge` 失败和 history fetch 失败在每次尝试都重报;
5. **`workflow_task_execution_failed` 指标现在为每次失败的 Workflow Task 尝试记录**,其 `failure_reason` tag 在所有路径上区分 `GrpcMessageTooLarge` / `PayloadsTooLarge` / `RequestTooLarge`。

**第 5 条直接对应 §3.6 的分页特性**:分页解决的是 `GrpcMessageTooLarge`/`RequestTooLarge` 这类失败,而第 4 条「只在第一次尝试上报失败、后续留给超时」则是**避免无限重试消耗 server 资源**的配套治理。**两个改动方向一致:把「大 Workflow Task 失败」从「无限重试的死亡螺旋」变成「有预算、有原因码、可终止的失败」。**

---

## 七、6 条 6-12 个月可验证硬指标

这些指标今天就能用代码或配置复现,不需要等未来。

**1. Unified Query Converter 拒绝率**。升级 v1.32 后,对同一批既有 Visibility 查询,统计被新 converter 拒绝的比例。
   - 复现:遍历你的查询集合,在 ES store 和 SQL store 各跑一遍;
   - 预期:跨 store 行为一致(这是改动的目的),类型不匹配的查询开始报错;
   - 告警阈值:任何 > 0 的拒绝率都需要人工确认查询是否写错。

**2. `system.visibilityAllowList` 预 audit**。在升级 **v1.33** 之前,扫描自定义 search attribute 的实际写入值。
   - 复现:查询你的 Visibility store,找出 `Keyword`(非 `KeywordList`)类型字段被写入列表值、`Int` 类型字段被写入列表值的记录;
   - 预期:**这类记录现在在 ES 上「能工作」,v1.33 默认 `false` 后会失败**;
   - 行动:要么改类型为 `KeywordList`,要么在 v1.33 前修掉写入逻辑。

**3. Poller autoscaling 决策可见性**。开启 `poller_scale_decision` 指标后,观察 24 小时的伸缩决策序列。
   - 复现:namespace 或 task queue 级 opt-in 该 counter;
   - 预期:每个决策带 `+1s` / `-1s` / 无变化 + reason tag;
   - 关键验证:**sticky queue 现在应该能在 backlog 形成之前,仅凭 add/dispatch rate 触发 scale-up**(这是 v1.32 修的 bug)。

**4. `tasks_dropped` 的 reason 分布**。Matching 新指标上线后,建立 baseline。
   - 复现:按 `reason` tag 聚合 `tasks_dropped`;
   - 预期:正常情况接近 0;`expired_read` / `expired_memory` > 0 说明 backlog 消费不及时;
   - 注意:**`tasks_expired` 已被移除,旧告警规则会失效**——这本身是一个可验证的「指标缺失」信号。

**5. Standalone Activity reset 后的重试延迟曲线**。对一个正在退避的 Activity 执行 `reset_state(restore_options=True)`,记录下一次重试的时间间隔。
   - 复现:`history.enableStandaloneActivityOperatorCommands=true`,调用 Operator API;
   - 预期:重试从 `initial_interval` 重新开始,而不是接着退避后的长间隔;
   - 这是「重试计数器可运维」的直接证据。

**6. Workflow Task 分页的预算消耗(仅 staging)**。在 staging 开启分页,跑一个会一次产生大量 command 的 Workflow。
   - 复现:`history.enableWorkflowTaskCompletionPagination=true` + `history.maximumEventBatchSizeInBytes` 设为 `system.transactionSizeLimit` 以下;
   - 预期:之前直接 `REQUEST_TOO_LARGE` 死锁的 Workflow 现在能完成;缓冲占用在 40 MiB / task、1 GiB / 进程预算内;
   - 注意:**该特性 pre-release + `maximumEventBatchSizeInBytes` 被标注 Experimental,生产环境不要开**。

---

## 八、6 条 6-12 个月可观察未来信号

这些是行业与项目路线图层面的信号,用来判断本文的判断是否成立。

**1. v1.33.0 移除 legacy query converter + `visibilityAllowList` 默认改 false**。这是 v1.32 release notes 明确预告的。**如果届时大量依赖「ES 碰巧接受列表值」的部署开始报错,说明这一类「能跑但不该跑」的隐性约定在生态里普遍存在**,Temporal 会加速把这类约定显式化。

**2. 10 个废弃 Worker Versioning API 的实际移除**。v1.32 是最终版,v1.33 移除。**观察点不是「移除了没有」,而是「有多少用户卡在 Draining 状态」**——`enableWorkerDeploymentVersionDemotionSignal` 在 v1.32 默认 false、v1.33 预计改 true,说明 Temporal 自己也预期这个迁移会出现卡点。

**3. CHASM 框架的扩散速度**。v1.32 里 CHASM 已经是 Standalone Nexus Operations 和 Nexus callback 默认实现的底座。**如果后续版本里 CHASM 开始承载更多「不是 Workflow 但需要持久化状态机」的组件,就印证了 §2 的判断**——Temporal 在把 Workflow 专属的状态机能力平台化。

**4. Serverless Workers 从 AgentCore 扩展到其他 runtime**。v1.32 只支持 AWS Bedrock AgentCore Runtime。**如果 6-12 个月内出现第二个 runtime(Cloud Run / Lambda / 其他),说明「server 代你伸缩 Worker」被验证为通用模式**,而不是单云集成。

**5. `temporalio.contrib.strands` / `google_adk_agents` 从实验转稳定**。这两个 contrib 目前是 Experimental。**转稳定的时间点,就是「Agent 的 durable 执行层」被正式承认的时刻**。同时观察 ADK / Strands 侧是否反向增加 Temporal 适配。

**6. Event Groups 被可观测性工具消费**。目前 Event Groups 是写入端能力。**如果 Temporal UI / 第三方 tracing 工具开始按 group 折叠 History,说明「按业务逻辑读执行历史」成为标配**——这对长执行调试是质变。

---

## 九、总结与最佳实践

### 9.1 这个版本到底改了什么

一句话:**v1.32 把 durable execution 的六条死边界,全部从「架构限制」变成了「配置项」**。

| 边界 | v1.31 之前 | v1.32 |
|---|---|---|
| Activity 必须挂 Workflow 上下文 | 架构限制 | `activity.enableStandalone` 默认开 |
| Nexus Operation 必须有 caller Workflow | 架构限制 | Standalone Nexus(预发布,DC 开关) |
| Worker 必须常驻 | 架构限制 | AgentCore Serverless(预发布) |
| 取消只能靠心跳 | 架构限制 | Proactive Cancellation(DC 开关) |
| 超大 Workflow Task 死锁 | 架构限制 | Pagination(预发布,有预算) |
| 查询行为依赖 store | 历史分裂 | Unified Converter 默认 |

**注意这个规律**:三个 GA / 默认开启,三个预发布 / 默认关闭。**Temporal 的边界外推策略是「基础设施默认化、强力能力显式化、激进特性预发布」**。这不是保守,这是把「改变默认行为」的决策权留给用户。

### 9.2 ✅ 该用

- **长时事务编排** —— 订单履约、资金清结算、多步骤业务流程,Temporal 的 replay 恢复是唯一能保证「业务状态完整重建」的方案;
- **AI Agent 多步任务** —— 把 Agent 图跑在 `TemporalSandbox` 里,崩溃重启从 History 恢复,不重烧 token;
- **平台 + 业务架构** —— 用 Standalone Nexus Operations 让业务侧直接触发平台服务,durable retry 不用包 Wrapper Workflow;
- **需要独立运维的副作用任务** —— 清理、对账、重算,用 Standalone Activity + start delay + Operator API;
- **按 query 批量治理异常执行** —— Batch Operations + visibility query,替代逐个 Signal/Cancel 的脚本;
- **突发型高成本 Worker** —— Agent 场景的 GPU Worker,用 Serverless Workers scale to zero。

### 9.3 ❌ 千万别用

- **❌ 不要在生产开 `enableWorkflowTaskCompletionPagination`** —— pre-release,`maximumEventBatchSizeInBytes` 明确标注 Experimental;
- **❌ 不要等 v1.33 发布才处理 `visibilityAllowList` 的列表值问题** —— 届时默认改 false,ES 上「碰巧能工作」的查询会直接失败;
- **❌ 不要把 10 个废弃 Worker Versioning API 的移除当成「还能用一年」** —— v1.32 是最终版,**现在就规划迁移,并 drain 所有依赖 legacy routing 的执行**;
- **❌ 不要在老 Version Workflow 完成 Continue-As-New 之前开 `enableWorkerDeploymentVersionDemotionSignal`** —— 会让 Version 卡在 `Draining`;
- **❌ 不要在升级 Python SDK 到 1.34.0 时忽略 ADK 的确定性陷阱** —— 在 ADK 代码后调用 `workflow.random()` / `workflow.uuid4()` 的 Workflow **可能无法 replay**,必须先 drain 或用 worker versioning;
- **❌ 不要在告警里继续依赖 `tasks_expired` 指标** —— 已移除,改用带 reason tag 的 `tasks_dropped`;
- **❌ 不要用 `Nexus-Callback-Source` header 做内部/外部判断** —— 默认已改按 URL scheme 路由,继续依赖 header 是安全风险(且需显式开 `callback.inspectSourceHeader`)。

### 9.4 5 步生产升级 checklist

**Step 1:升级前 audit(不改任何代码)**

- 检查所有 Visibility 查询中的类型用法:Keyword 对 Int、Int 对 String、Text 过滤空串;
- 扫描自定义 search attribute 的**实际写入值**,找出非 `KeywordList` 类型被写入列表值的记录(为 v1.33 的 `visibilityAllowList` 默认变 false 做准备);
- 检查告警规则里是否用到 `tasks_expired`(已移除);
- 检查客户端是否对 batch operation 的 enum 返回值做过比较(`*_WORKFLOW` 显式值)。

**Step 2:Worker Versioning 迁移**

- 确认没有任何代码调用 10 个废弃 API;
- 识别所有依赖 legacy Build ID / Version Set / Assignment Rule / Redirect Rule / 废弃 Deployment routing 的**运行中、sleeping、backlog** Workflow;
- **drain 或完成它们**;
- 规划一次性 Versioning Override 的用法(它会在目标 Version 成功完成一次 Workflow Task 后自动清除,不用手动删)。

**Step 3:SDK 版本核对**

- Server v1.32 + Standalone Nexus Operations 的最小 SDK:Go v1.46.0 / Java v1.36.1 / .NET 1.16.0 / **Python 1.30.0** / TS v1.20.2;
- Python SDK 升到 1.34.0 前:**先 drain 所有在 ADK 代码后调用 `workflow.random()` / `workflow.uuid4()` 的 Workflow**,或用 worker versioning 钉住;
- Temporal CLI 升到 v1.9.0+(Standalone Nexus 命令组);UI Server 升到 v2.54.1+ 并开 `EnableStandaloneNexusOperations` flag。

**Step 4:灰度启用新能力**

- 先在非生产 namespace 开 `history.enableStandaloneActivityOperatorCommands` 验证 Operator API;
- 再开 `frontend.enableBatchOperationsForStandaloneActivities` 验证批量操作;
- Matching / Poller 指标先观察一周,建立 `tasks_added` / `tasks_dropped` / `poller_scale_decision` 的 baseline;
- Proactive Cancellation 的两个开关最后开,验证取消延迟是否从「心跳间隔」降到秒级;
- **Standalone Nexus Operations 与 AgentCore Serverless Workers 留到正式 GA 后再上生产**。

**Step 5:回退预案**

- 回退到 v1.31 可用(数据兼容);
- **但 release notes 明确:回滚到 v1.32 应当被当作「漏掉了一个 legacy Workflow」的紧急恢复手段,而不是迁移策略**;
- Unified Query Converter 可用 `system.visibilityEnableUnifiedQueryConverter: false` 单独回退;
- CHASM-backed Nexus callback 可用 `history.enableCHASMCallbacks: false` 回退到 HSM 实现;
- `enableWorkflowTaskCompletionPagination` 与 `maximumEventBatchSizeInBytes` 回退到默认即可(未开启则无状态可回退)。

### 9.5 5 条 best practice

1. **把「能跑但不该跑」的用法当技术债立刻还** —— `Keyword` 存列表值、Text 过滤空串、依赖 `tasks_expired` 指标,这三件事现在都能工作,但**下一个版本会让它们失效**;
2. **强力运维能力默认关闭是设计而非缺陷** —— Operator API 和 Batch Operations 默认 false,是因为它们能直接作用于运行中执行。**开启前先想清楚谁能调用、审计在哪**;
3. **新功能的「最小 SDK 版本矩阵」要逐语言核对** —— 多语言团队里 Python 达标不代表 Go / Java 达标,server 端开关绕不过 SDK 下限;
4. **确定性比正确性更脆弱** —— ADK 的 random stream 修复说明:一个「看起来更正确」的改动(让 id 从确定性流取)本身**就能破坏既有执行的 replay**。升级 Agent Workflow 前,drain 或 versioning,二选一;
5. **给「超大」设预算,而不是给「超大」开绿灯** —— Workflow Task 分页的 40 MiB / 1 GiB / 0.5 ratio 三层预算,是「允许你变大,但代价显式化」的设计范例。**你自己的系统里如果有「无限缓冲」的地方,照这个模式加预算。**

---

## 写在最后

v1.32 的 release notes 里有一处很容易被忽略的**自我更正**:它明确写了「更正 v1.31 release notes 的说法:v1.32 才是最终版本,移除推迟到 server v1.33」。这是一份 release notes 在公开承认上一版的时间表说错了。

这个小细节其实很能说明 Temporal 的工程文化:**他们把「计划」和「实际」分开陈述,并且会在下一个版本里公开修正**。release notes 里类似的设计还有很多——比如明确说 Proactive Cancellation「目前不支持 standalone activities」、说 `maximumEventBatchSizeInBytes` 是 Experimental、说回退到 v1.32 只能当紧急恢复而不是迁移策略。**每一处都是「这条能力现在不能干什么」的诚实声明。**

把它跟今天早间的新闻放在一起,格局就清楚了。Chesky 说 Agent 需要自己的操作系统与 SDK;AWS 开源 Strands Decider 决策模型;NVIDIA 把 Agent 安全层搬到 BlueField-4 DPU 上做毫秒隔离;Shopify 要求 Agent 走 WebMCP 结构化协议而不是抓人类页面。**整个行业在 2026 年下半年做的同一件事,是给 Agent 划边界**——安全边界、协议边界、治理边界。

Temporal v1.32 在这个叙事里的位置是**最底层的那个边界**:**Agent 执行的可靠性边界**。一个 Agent 跑了 47 步、调了 3 个外部工具、等了 2 次人类确认,然后进程崩了——它从哪一步恢复?在 v1.32 之前,答案是「取决于你的 Agent 框架自己实现了多少状态持久化」。在 v1.32 之后,如果它跑在 Temporal 上,答案是「从 History 的最后一个事件恢复」。

**Agent 不需要一个新的操作系统。Agent 需要的是一个能把它每一步都记账、崩了能从账本接着算的内核。** Temporal 用九年把「记账 + 重放」做透了,v1.32 只是把这层能力的边界,从 Workflow 进程内,推到了整个平台。

---

**数据来源**:
- Temporal Server v1.32.0 release notes(2026-09-11,github.com/temporalio/temporal/releases/tag/v1.32.0);
- Temporal Python SDK 1.34.0 release notes(2026-09-30,github.com/temporalio/sdk-python/releases/tag/1.34.0);
- Temporal Serverless Workers / AgentCore 文档(docs.temporal.io/production-deployment/worker-deployments/serverless-workers/agentcore);
- Worker Deployment APIs 文档(docs.temporal.io/production-deployment/worker-deployments/worker-versioning);
- Temporal UI Server v2.54.1 release notes;
- Argo Workflows v4.1.4、Apache Airflow 3.3.2、Prefect 3.8.7、Conductor OSS v3.32.5 release notes(对比维度);
- 早间 AI 日报 2026-10-02「五维接入战」(AWS Strands Decider 开源、Chesky 关于 Agent 操作系统的表态)。
