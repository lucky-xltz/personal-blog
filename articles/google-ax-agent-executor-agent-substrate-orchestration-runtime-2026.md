---
title: "Google AX 深度拆解:Agent Executor + Agent Substrate —— 当 Agent 成为一种新 Workload,K8s 之上长出的「编排运行时层」+ 5 大承重级革新 + 5 段实战代码 + 5 套编排方案 17 维度对比"
slug: "google-ax-agent-executor-agent-substrate-orchestration-runtime-2026"
date: 2026-09-21
category: 技术
tags:
  - Google AX
  - Agent Executor
  - Agent Substrate
  - AI Agent
  - Agent 编排
  - Kubernetes
  - K8s 控制面
  - Redis Streams
  - etcd
  - 沙箱
  - gVisor
  - microVM
  - Actor 模型
  - suspend
  - resume
  - 快照
  - 多路复用
  - egress allowlist
  - 网络隔离
  - MCP
  - Skills
  - 声明式
  - gRPC
  - h2c
  - 工作负载
  - 编排运行时
  - 云原生
  - 2026
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1639762681485-784b1b0eb351?w=600&h=440&fit=crop
excerpt: "2026 年 9 月,Google 把内部跑「数十亿 autonomous agent workload」的编排器开源了:AX(Agent Executor,仓库 google/ax,Go + Apache-2.0,3541 stars)。它的 README 第一句就点破了 2026 年基础设施层最本质的变化 ——「Agents are a new kind of workload. They are neither stateless microservices nor run-to-completion batch jobs. They accumulate state, need strict isolation, call out to model APIs and tool servers, and can burn money in a loop if nobody is watching.」本文从「把一个 agent 部署到 K8s 上,到底哪里不对」讲起,逐层拆解 5 大承重级革新:① 4 个声明式原语(Task / Workspace / Gateway / Model)把 agent 的「隔离 / 预热 / 网络边界 / 模型凭证」从胶水代码变成 ax apply 一次过;② 状态绕过 etcd 存 Redis + Redis Streams XREADGROUP 做工作队列,直击「百万级短时 task 存 CRD 把 etcd 逼到单数位 GB 上限」的控制面瓶颈;③ Agent Substrate 的 actor/worker 多路复用 —— 250 个有状态 actor 压在 8 个物理 Pod 上(30x+ 超额订阅),sub-500ms 恢复、500+ 次/秒挂起恢复,全状态快照(volatile RAM + 文件系统)跨 hibernation 保留;④ Gateway 把网络边界做成一等资源,请求经单 header ate-target-actor 路由,egress 默认锁定显式 allowlist,直击提示注入外泄攻击面;⑤ Runner 契约 —— 容器永远以固定 /usr/local/bin/ax-task-runner 启动,spec 经 AX_TASK_YAML 环境变量注入,workspace 只准备一次,命令退出后 PID 1 必须继续活着。给出 5 段可直接跑的实战代码(完整 4 资源 manifest + 生命周期命令 / Go 嵌入 runner 包 / Python agent 自描述与优雅关闭 / gRPC header 路由 / 生产级 egress 收紧)和 5 套编排方案 17 维度对比(AX vs K8s Job vs Argo Workflows vs Temporal vs kagent)。核心结论:Agent 编排运行时层正在 K8s 之上成型,而它的第一性原理不是「更强的调度器」,而是「承认 agent 是有状态、会空闲、能烧钱、需隔离的新 workload 类」——还在用 Deployment + 手写胶水脚本跑 agent 集群的团队,是时候重画架构图了。"
---

# Google AX:当 Agent 成为一种新 Workload

## 0. 本文的范围与数据来源

2026 年 9 月,Hacker News 首页出现一条「AX – Google's Open Agentic Orchestrator」(297 points),指向仓库 [google/ax](https://github.com/google/ax)。这不是又一个 Agent 框架 —— 它的定位是**编排器(orchestrator)**,README 的第一句话是:

> **Declare an agentic task with workspaces and gateway specifications. AX sandboxes it, wires up its workspace, fences its network, and helps running it at scale.**

本文所有技术细节来自一手资料(截至 2026-09-21 抓取):

| 资料 | 内容 |
|------|------|
| `google/ax` README | 4 原语设计动机 + Quick start |
| `google/ax` DESIGN.md | 控制面架构(Redis + Streams)+ gRPC API 清单 |
| `google/ax` docs/concepts.md | Task 生命周期 + Conditions 语义 |
| `google/ax` docs/manifests.md | 4 资源完整字段 |
| `google/ax` docs/networking.md | atenet-router header 路由 |
| `google/ax` docs/sandbox.md | 元数据服务器 + guest services |
| `google/ax` docs/runner.md | Runner 契约(可替换 PID 1) |
| `agent-substrate/substrate` README | actor/worker 多路复用硬指标 |

**仓库元数据**:Go 语言 / Apache-2.0 / 创建于 2026-03-30 / 3541 stars / 168 forks / 默认分支 main。**状态警示**:README 顶部明确标注「We are still actively refining our core concepts, protocols, and specifications. We will likely to introduce major breaking changes prior to a stable release.」—— API 版本是 `ax.io/v1alpha1`,本文所述**任何字段都可能在稳定版前变更**。这是本文与「已 GA 的 K8s 生态组件」对比时必须诚实标注的前提。

---

## 1. 问题的源头:把一个 Agent 部署到 K8s 上,到底哪里不对?

理解 AX 的唯一正确起点,不是它的 YAML 语法,而是一个架构判断:**Agent 是一种 Kubernetes 从未设计过的 workload 类。**

K8s 的世界里只有两种东西跑在 Pod 里:

- **无状态微服务**:Deployment 管副本数,HPA 管扩缩容,请求经 Service/Ingress 负载均衡,任何一个 Pod 挂了流量切走,用户无感。
- **运行到完成的批处理作业**:Job/CronJob 管重试次数和并行度,`restartPolicy` 管 OnFailure/OnFailure,跑完退出,退出码就是终态。

Agent 哪一条都不属于。README 里那段话值得逐句拆开:

> **They accumulate state** — agent 在对话/任务过程中积累上下文、中间产物、已克隆的仓库、已安装的工具链。它不是无状态的;把它像 Deployment Pod 一样随便重调度,一天的工作成果就没了。
>
> **need strict isolation** — agent 执行的是**不受信任的代码与工具输出**。它读 LLM 返回的指令,调 MCP server,在文件系统里写文件。一次提示注入就可能让它把环境打穿。
>
> **call out to model APIs and tool servers** — 它的网络访问模式不是「任意服务间调用」,而是**极少数外部端点 + 严格可控的出站白名单**。给它一个全通的 NetworkPolicy 等于给它一张无限额度的信用卡和一个外发通道。
>
> **can burn money in a loop if nobody is watching** — 这是所有问题里最被低估的一条。一个 while(True) 调 LLM 的 agent,没人盯着,一晚上能烧掉五位数美元。K8s 的 resources.limits 管 CPU/内存,**没有任何原语管「token 预算」**。

把这四条加在一起,你会发现在原生 K8s 上跑一个生产级 agent 集群,需要自己写多少胶水:

| Agent 的真实需求 | 原生 K8s 提供的 | 缺口 |
|---|---|---|
| 隔离的不受信任代码执行 | Pod(共享内核) | 需自己套 gVisor / Kata / microVM |
| 每次启动前预热环境(克隆仓库、装工具链、拉 MCP 配置) | initContainer(但每次重启都重跑) | 需自己写「只跑一次」的 marker 逻辑 |
| 出站流量锁定到显式白名单 | NetworkPolicy(粗粒度,默认通常全通) | 需自己设计 per-task 策略 |
| 模型 API Key 轮换 / 版本钉死 | Secret(裸 KV) | 需自己包一层「命名模型配置」 |
| 闲置时暂停、按需恢复(省钱) | scale-to-zero(但状态全丢) | 需自己做快照 + 恢复 |
| 请求路由到「那个」有状态的 agent 实例 | Service(负载均衡到任意副本) | 需自己写粘性路由 |
| Token 预算 / 烧钱熔断 | resources.limits(只管 CPU/内存) | 完全没有 |

AX 的全部设计,就是把这张表右列的 7 个缺口,变成 **4 个声明式资源 + 2 个 CLI 动作**。

**关键洞察 1:**AX 的第一性原理不是「更强的调度器」,而是**承认 agent 是一类新 workload,然后给它专门的声明式原语**。K8s 当年把「无状态服务」抽象成 Deployment + Service,终结了手写 supervisor 脚本的时代;AX 想做同一件事,只是这次的对象是 agent。

---

## 2. 三层架构:控制面 / 沙箱编排面 / 沙箱内运行时

AX 的完整请求路径可以拆成 7 层。理解这 7 层,比记住任何一条 YAML 字段都重要,因为**每一层的边界都是一个可替换点**。

```
┌─────────────────────────────────────────────────────────────────────┐
│ Layer 7  应用层                                                      │
│   spec.command(python agent.py)+ MCP servers + Skills + Git 仓库     │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 6  沙箱内运行时(ax-task-runner,PID 1)                         │
│   元数据服务器(:80,HTTP/1.1 + h2c)+ guest services(debug 时)       │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 5  沙箱编排层(Agent Substrate)                                │
│   Atespace 供给 / Actor 创建与激活 / Worker 分配 / Egress 策略过滤    │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 4  调和层(ax-controller,水平扩展的 workers)                   │
│   消费 Redis Stream → 驱动 task 走向期望状态                          │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 3  状态层(Redis)                                              │
│   Task Hashes + Event Streams + PubSub                               │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 2  API 层(ax-server,无状态 gRPC :8080)                        │
│   校验 manifest → 存 Redis → 发事件                                   │
├─────────────────────────────────────────────────────────────────────┤
│ Layer 1  声明式入口(ax CLI + ax.io/v1alpha1 manifests)              │
│   ax apply -f task.yaml                                              │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 控制面:为什么是 Redis 而不是 etcd

DESIGN.md 里有一段值得整篇文章三分之一的篇幅:

> Storing millions of short-lived tasks as Kubernetes CRDs pushes etcd past its comfort zone (single-digit GB storage limits, write-rate bottlenecks, control plane degradation). AX keeps its state in Redis and uses Redis Streams as the work queue between the API server and a horizontally scaled pool of controllers.

这是对 K8s「一切皆 CRD」默认做法的一次公开换存储手术。etcd 的物理约束是硬的:

- **存储上限**:单数位 GB(默认 2GB,生产实践通常不超 8GB)。每个 CRD 对象的 key 加上 revision/lease 元数据,一个 Task 对象占几 KB;百万级 task 就是 GB 级,而且**已完成的 task 不删就一直占着**。
- **写速率瓶颈**:etcd 是 Raft 强一致存储,所有写都要落多数派磁盘。K8s 控制面出现 `etcdserver: request timed out` 的经典根因之一就是 CRD 写入速率打满。
- **控制面降级**:list 全量 CRD 会把 API server 打到 OOM,这是 K8s 运维里反复出现的场景。

AX 的替换方案:

| 组件 | 替换为 | 作用 |
|------|--------|------|
| Task 状态存储 | Redis Hashes | O(1) 读写单 task,不占 etcd |
| 工作队列 | Redis Streams | `XREADGROUP` 分摊给多个 controller |
| 事件广播 | Redis PubSub | `ax watch` 的实时状态推送 |

架构图(来自 DESIGN.md):

```
                      ax apply -f task.yaml
                                │
                                ▼
                            ax-server
                      (gRPC API + /healthz)
                                │
                     store & publish event
                                │
                                ▼
                              Redis
               (Task Hashes + Event Streams + PubSub)
                                │
                      XREADGROUP (Streams)
                                │
                                ▼
                          ax-controller
                   (Horizontally Scaled Workers)
                                │
                        gRPC (Control API)
                                │
                                ▼
                         Agent Substrate
                ┌───────────────────────────────┐
                │ • Atespace Provisioning       │
                │ • Actor Creation & Activation │
                │ • Worker Assignment           │
                │ • Egress Policy Filtering     │
                └───────────────────────────────┘
```

**关键洞察 2:**注意 `ax-server` 是**无状态**的。这意味着水平扩展 API 层不需要任何会话保持,所有状态在 Redis。而 controller 的水平扩展靠 Redis Streams 的**消费组语义** —— 加副本就是加 consumer,XREADGROUP 自动分摊。这是把「K8s 的 etcd 强一致 + informer 缓存」模型,换成「Redis 最终一致 + 流式分摊」模型。代价是丢掉了 etcd 的强一致 WATCH 语义,收益是写吞吐和存储量都解绑于 etcd 的物理上限。

### 2.2 沙箱编排面:Agent Substrate 的 actor/worker 多路复用

AX 不直接管容器,它跑在 [Agent Substrate](https://github.com/agent-substrate/substrate) 之上。Substrate 的核心抽象是 **actor / worker 二分**:

> Agent Substrate maps a larger set of "actors" (applications such as agents) onto a smaller set of ready "workers", relying on the fact that **agent-like applications tend to be idle most of the time** to achieve heavy multiplexing.

这个假设是整套系统能省钱的根基。一个 agent 一天里真正在调 LLM 做事的时间可能只有 5%,剩下 95% 在等用户、等审批、等定时触发。如果每个 agent 都独占一个 Pod,集群利用率会惨不忍睹。

Substrate 的做法是把 actor(逻辑 agent)**动态映射**到少量常驻 worker(物理 Pod)上:

- 空闲 actor 被**挂起(suspend)**,资源让给别的 actor
- 有请求来时**先恢复(resume)**再代理,用户几乎无感
- 全状态快照(volatile RAM + 文件系统)在 hibernation 周期间完整保留

官方 demo 的硬指标:

| 指标 | 数值 |
|------|------|
| demo 规模 | ~250 个有状态 actor 压在 **8 个物理 Pod** 上 |
| 超额订阅 | **30x+** |
| 恢复延迟 | **sub-500ms** |
| 挂起/恢复激活速率 | **500+ 次/秒** |
| 沙箱密度 | 比标准容器运行时高 **10x** |
| 沙箱技术 | gVisor(内核级 OCI)、microVM,多后端共存 |
| 隔离模型 | 原生 zero-trust 内核 + 网络隔离 |

**关键洞察 3:**这是 serverless 的 scale-to-zero 思路被搬到**有状态** workload 上。普通 serverless 缩容到 0 时状态全丢,下次冷启动要重建;Substrate 的 suspend 保留完整内存 + 文件系统快照,resume 时恢复到新容器的**是新进程树、旧文件**。`ax suspend` / `ax resume` 因此能作为省钱的一等操作 —— 闲置 agent 挂起,资源让出去,需要时 500ms 内拉回来。

### 2.3 沙箱内运行时:Runner 契约

这是 AX 最精巧、也最少被注意到的一层。**控制面不直接跑 `spec.command`**。它永远以固定命令启动容器:

| 控制面设置 | 值 |
|---|---|
| 容器镜像 | `spec.image`,未设则用默认 `ax-task-runner` 镜像 |
| 容器 command | **`/usr/local/bin/ax-task-runner`,永远固定** |
| `AX_TASK_YAML` | 完整 Task 资源 YAML(含 status) |
| `AX_WORKSPACES_YAML` | 所有绑定 Workspace 的多文档 YAML 流,按绑定顺序 |
| `spec.env` | 逐条写入容器环境 |
| `GEMINI_API_KEY` | atespace 配了 Gemini 凭证时写入 |
| Volume | `/workspace` 挂载持久目录 |
| 就绪探针 | `GET /readyz` 端口 80 |

两个直接后果:

1. **你的镜像里必须有 `/usr/local/bin/ax-task-runner` 这个可执行文件**(可以是符号链接或 shell 包装)。
2. **`spec.command` 只通过 `AX_TASK_YAML` 传给 runner**,由 runner 解析并启动。

这不是过度设计。把「启动什么」从容器镜像的 entrypoint 里解耦出来,控制面才能在**不改镜像**的前提下改 task spec;而且它让 runner **可替换** —— 任何满足契约的二进制都能当 PID 1。

Runner 必须履行的 7 条契约(docs/runner.md 的 checklist):

1. `/usr/local/bin/ax-task-runner` 可执行文件存在
2. 读 `AX_TASK_YAML` 和 `AX_WORKSPACES_YAML`
3. 80 端口伺候 `/healthz` 和 `/readyz`,后者在所有 workspace 就绪前返 **503**
4. **每个 workspace 只准备一次**(跨重启和 resume),各就各位在自己的路径
5. 在第一个 workspace 启动 `spec.command`,注入 `AX_METADATA_URL` + `spec.env`
6. **命令退出后继续运行**
7. `SIGTERM` 转发给命令的进程组,宽限期后退出

第 4、6 条是全篇最反直觉的两条,值得单独展开。

**第 4 条「只准备一次」**:resume 会重启容器。如果 runner 傻乎乎地把 git 仓库重新 clone 到已恢复的 workspace 里,就会**摧毁 agent 上次积累的状态**(本地修改、未提交的分支、装好的工具链)。默认 runner 在 `/ax` 下按 workspace 路径写 marker 文件,后续启动检查到 marker 就跳过。

**第 6 条「命令退出后继续运行」**:runner 是 PID 1,容器随它而活。命令退出时 runner 也退出,元数据服务器跟着没,`ax ssh` 立刻失效 —— 你再也进不去那个沙箱看执行结果。所以默认 runner 的行为是:**记录退出码,继续伺候服务,直到被要求停止**。注意:目前控制面**不回读**容器里命令的退出码,exit 状态只落在日志里。

---

## 3. 5 大承重级革新

按「承重级架构革新」标准(改默认行为 / 解决历史遗留难题 / 引入新接口或协议 / 性能提升 ≥ 2x / 推动整个生态跟进,至少满足 3 项)逐一拆解。

### 革新 1:4 个声明式原语,把 agent 的 7 个胶水点变成 1 条命令

AX 只给你 4 个资源,每个解决一张表里的一行缺口:

| 你想…… | AX 给你 | 对应资源 |
|---|---|---|
| 在隔离沙箱里跑不受信任的 agent 代码,带 CPU/内存限制 | `Task` | 隔离执行 |
| 预置 Git 仓库、MCP server、Skills 包,让每个 agent「热启动」 | `Workspace` | 环境预热 |
| 把出站流量锁到显式 host 白名单 | `Gateway` | 网络边界 |
| 配置平台自身用哪个 LLM,凭证来自 K8s Secret | `Model` | 模型凭证 |
| 暂停闲置 agent,从断点继续 | `ax suspend` / `ax resume` | 状态保持 |
| 进运行中的 agent 沙箱里看它在干嘛 | `ax ssh` | 可观测 |

**Task 的设计哲学**(docs/concepts.md)是全篇最值得反复读的一段:

> The unit is deliberately small. An agent is not one process that runs to completion; over its lifetime it plans, delegates, retries, and fans work out. AX does not try to model that shape. It gives you one primitive that is cheap to create, isolate, suspend, and throw away, and lets the agent compose as many of them as its work demands.

翻译成架构决策:**AX 拒绝建模 agent 的执行形状**。它不提供「agent DAG」「步骤编排」「条件分支」这些抽象 —— 那些是 Agent 框架(LangGraph / Claude Agent SDK)的活。AX 只提供**一个便宜的、可隔离、可挂起、可丢弃的执行单元**,agent 自己决定要扇出多少个 task。一个 task 可以是整个工作,也可以是一棵 task 树的根;每个节点拿到同样的沙箱、同样的生命周期、同样的工具链。

**Workspace 的「goal」机制**:一个 Workspace 绑定可以带一段自然语言 `goal`。首次启动时,runner 把这段 goal 交给一个 **Antigravity agent** 完成环境装配(装工具链、装依赖),然后 task 自己的命令才在一个「就绪」的环境里启动。默认超时 10 分钟,可用 `AX_BOOTSTRAP_TIMEOUT` 调整。这本质上是**用一个 agent 来配置另一个 agent 的运行环境** —— 「agent 的 initContainer,但会说话」。

**Model 不是模型,是命名模型配置**:

> A `Model` is not a model. It is a named model configuration: which provider to call, which model identifier to use, provider-specific generation parameters such as temperature, and a reference to the Kubernetes secret holding the API key.

这一条解决了多团队协作里最痛的事:**轮换 API Key、钉死模型版本、收紧 temperature 参数,是一次 `ax apply`,而不是去翻每个 agent 的环境变量**。AX 自己的组件(比如按 goal 规划 workspace 的 agent)也读它 —— 平台和业务共用同一套模型配置。

### 革新 2:状态绕过 etcd,Redis Streams 做控制面工作队列

(机制见 §2.1,这里讲为什么这是承重级的。)

这是 5 大革新里**唯一在架构层面对 K8s 既有共识提出替代方案**的一条。2024-2026 年,K8s 生态几乎形成了「新 workload 类型 = 新 CRD + 新 controller」的肌肉记忆。AX 的 DESIGN.md 明确指出这条路上 agent workload 会撞墙:

- task 的**生命周期极短**(分钟到小时级),但**数量极大**(设计目标 billions per cluster)
- 每个 task 都是一个**带 status 的对象**,controller 每次状态翻转都是一次 etcd 写
- informer 缓存会把全量对象加载进 controller 内存

换 Redis 的代价是**放弃 etcd 的强一致 watch 语义**,换来:

| 维度 | etcd / CRD 方案 | Redis 方案 |
|------|-----------------|------------|
| 存储上限 | 单数位 GB(默认 2GB) | Redis 可 TB 级,可集群分片 |
| 写吞吐 | Raft 多数派落盘,数千 ops/s | 单实例 10 万+ ops/s |
| 工作队列 | 无原生(靠 informer + 退避重试) | Streams `XREADGROUP` 原生消费组 |
| 水平扩展 controller | 加副本(但 informer 各自全量缓存) | 加 consumer,自动分摊 |
| 事件流 | watch(强一致) | PubSub(最终一致) |
| 运维复杂度 | 已有(K8s 自带) | 多一套 Redis 依赖 |

**关键洞察 4:**这不是「Redis 比 etcd 好」,而是**「短时高并发 task 的数量级与 etcd 的物理约束不匹配」**。AX 把强一致性的需求压缩到 actor 状态机本身(Substrate 保证 resume 的一致性),控制面只做最终一致的调和。**未来一年,如果「agent 控制面绕开 etcd」成为社区共识,AX 的这段 DESIGN.md 会是引得最多的一处。**

### 革新 3:Agent Substrate —— 有状态 workload 的 scale-to-zero

(机制见 §2.2。)作为承重级革新的判定:

- ✅ **解决历史遗留难题**:有状态 agent 的闲置成本。在此之前,「省钱」和「保状态」在有状态 workload 上是对立的。
- ✅ **性能提升 ≥ 2x**:比标准容器运行时高 **10x 密度**;30x+ 超额订阅。
- ✅ **引入新接口**:`suspend` / `resume` 作为生命周期一等操作,带全状态快照(volatile RAM + 文件系统)。

补充一个容易被忽略的设计:**Substrate 是低主张(low-opinion)系统**。它不管你跑的是不是真 AI agent —— 任何「大部分时间空闲 + 需要状态保持 + 需要隔离」的 workload 都适用。它也不是构建 agent 的 SDK,而是**运行它们的系统**。官方明确支持的框架:Agent Development Kit (ADK)、LangChain、Claude Code / Codex / Antigravity、MCP server 作为 actor 部署。

生态里已有两个上层:

- **[kagent](https://github.com/kagent-dev/kagent)**:CNCF Sandbox 项目,K8s 原生 agent 框架,用 Substrate 跑沙箱化有状态 agent
- **AX(Agent Executor)**:Google 出的分布式 agent 运行时,演示如何在 Substrate 上构建安全、超大规模的 agent harness

**分层已经显现**:`应用框架(kagent / LangGraph)→ 编排运行时(AX)→ 沙箱编排(Substrate)→ 沙箱技术(gVisor / microVM)`。这与 09-19 那篇《AI Agent 沙箱隔离运行时层》正好互补:那篇讲的是**最底层的沙箱技术选型**(Firecracker / Kata / gVisor / Hyperlight 的隔离原理),本文讲的是**在沙箱之上做编排和多路复用**。

### 革新 4:Gateway —— 网络边界作为一等资源,header 路由替代 Service

AX 的网络模型完全抛弃了 K8s 的 Service/Ingress:

> Tasks do not get a Kubernetes Service or Ingress of their own. Every request to a task goes through Agent Substrate's **atenet router**, the `atenet-router` Service in the `ate-system` namespace.

工作原理:

1. 请求带一个 header:`ate-target-actor: <atespace>/<task>`,值就是 `default/task123`
2. router 解析 header → 找到 actor 所在的 worker
3. **如果 actor 被挂起了,先 resume 它**
4. 把请求代理过去;`Host` 和 `:authority` 原封不动留给应用

```bash
# 集群内访问(controller 的就绪探针就是这么干的)
curl -H "ate-target-actor: default/task123" \
  http://atenet-router.ate-system.svc.cluster.local/metadata/v1alpha1/ax/task

# 本机访问:先 port-forward
kubectl -n ate-system port-forward svc/atenet-router 8001:80
curl -H "ate-target-actor: default/task123" http://localhost:8001/readyz
```

gRPC 场景把 header 塞进 outgoing metadata:

```go
ctx = metadata.AppendToOutgoingContext(ctx, "ate-target-actor", "default/task123")
resp, err := client.SomeMethod(ctx, req)
```

**为什么这是承重级的**:这是**有状态粘性路由的协议化**。K8s 的 Service 默认是负载均衡到任意就绪端点 —— 对无状态服务正确,对有状态 agent 是灾难(请求落到另一个 actor 的沙箱里)。`ate-target-actor` header 用**一个显式字段**表达了「这个请求必须发给那个 agent」,并且**把 resume 做进了路由路径** —— 闲置 agent 被挂起期间,第一个请求自动触发 500ms 级恢复,调用方无感。

另一侧,**egress 默认收紧**:

```yaml
spec:
  egress:
    allowlist:
      hosts:
        - host: "*"      # 允许 443 上的一切;生产环境务必收紧
          port: 443
```

注释那句「tighten this in production」是安全团队最想看到的话。把 agent 的出站锁到「LLM provider + Git host + 内部 MCP server」三个 host,一次提示注入即使成功,也**外发不出去**。这条与 09-21 早间 AI 日报的几条安全事件(OpenAI 六起安全事件披露、Anthropic 代理越权指标)形成直接呼应:**2026 年 agent 安全的攻防主战场,已经从「模型层对齐」移到「运行时层的网络边界 + 沙箱隔离」**。

### 革新 5:Runner 契约 —— 可替换的 PID 1 与 h2c 元数据服务器

(契约见 §2.3。)承重级判定:

- ✅ **引入新接口**:Runner 契约本身。3 级定制路径让企业不必 fork 整个项目。
- ✅ **推动生态跟进**:任何语言都能写 runner;`runner` Go 包可直接嵌入。
- ✅ **解决历史难题**:「agent 框架自带进程监控」与「平台生命周期管理」的冲突。

**沙箱内的 HTTP 表面**(`AX_METADATA_URL` 指向):

| 端点 | 方法 | 返回 | 说明 |
|------|------|------|------|
| `/healthz` | `GET` | `text/plain` | 存活探针,恒 200 |
| `/readyz` | `GET` | `text/plain` | **workspace 初始化期间 503**,克隆/MCP 配置/Skills 就位后 200 |
| `/metadata/v1alpha1/ax/task` | `GET` | `application/yaml` | 当前 Task 的完整 spec + status |
| `/metadata/v1alpha1/ax/workspaces` | `GET` | `application/yaml` | 所有绑定 Workspace,多文档流,按绑定顺序 |

**没有任何 SDK 依赖** —— agent 在容器里 `curl $AX_METADATA_URL/metadata/v1alpha1/ax/task` 就能读到自己的完整规格。这是「自描述 workload」的极简实现:agent 知道自己被分配了多少 CPU/内存、挂了哪些 workspace、走哪个 Gateway,就能做自适应(比如按 limits 决定并发数)。

**h2c 的妙用**:元数据服务器在同一端口 80 上同时伺候 HTTP/1.1 和 h2c(cleartext HTTP/2)。`spec.debug: true` 时,guest services(gRPC)也复用这个端口。**一个端口、三种协议语义**,省掉了端口规划和 TLS 证书管理的全部复杂度。

**Guest services 的安全权衡**:

> When a task sets `spec.debug: true`, the same port also serves the Agent Substrate guest services over gRPC... They are off by default because **they allow arbitrary process execution and file access inside the sandbox**, and `ax ssh` refuses to connect to a task that has not enabled them.

两个 service:**Process service**(启动/检查/流式输出/杀进程,`ax ssh` 的底座)和 **File system service**(workspace 内流式读写文件)。默认关闭 + `ax ssh` 拒绝连接到没开启的 task —— 这是**安全默认项(secured by default)**,而不是「功能默认开着,出事了再关」。

**默认 runner 镜像**的构成也透露了设计取向:Python 3.12 + `git` + `curl` + `openssh-client` + Antigravity agent。为什么是 Python?因为 goal-based 的 workspace bootstrap 把环境装配工作交给 Antigravity agent 执行,需要一个能跑 agent 的运行时。

---

## 4. 实战代码:5 段可直接跑的示例

> 所有代码基于 `ax.io/v1alpha1` 当前 schema(截至 2026-09-21 的 main 分支)。**稳定版前字段可能变动**,升级前请核对官方 docs。

### 4.1 完整 4 资源 manifest + 全生命周期命令

把 4 个资源放一个多文档 YAML 里(完整可跑版本见 `examples/task.yaml`):

```yaml
apiVersion: ax.io/v1alpha1
kind: Task
metadata:
  name: task123
  atespace: default          # 所有资源都在 atespace 里,默认 "default"
spec:
  image: "ghcr.io/my-org/my-agent-image"
  command: ["python", "agent.py"]
  env:
    - name: ENVIRONMENT
      value: "production"

  resources:                 # CPU/内存仍是 K8s 语义
    requests: { cpu: "500m", memory: "1Gi" }
    limits:   { cpu: "2",    memory: "4Gi" }

  workspaces:
    - name: default-workspace
      path: "/workspace"
      goal: "Install dependencies and run the test suite"  # 首次启动由 Antigravity 装配

  gateway:
    name: default-gateway

  debug: true                # 开 guest services 才能 ax ssh;默认 false
---
apiVersion: ax.io/v1alpha1
kind: Workspace
metadata: { name: default-workspace, atespace: default }
spec:
  git:
    - { name: origin, repo: "https://github.com/chalk/chalk.git", branch: "main" }
  mcp:
    registries:
      - { provider: google, query: "mcp.tags:build" }      # 从注册表按 tag 发现 MCP server
    servers:
      - { name: git-tools, endpoint: "http://git-mcp.default.svc.cluster.local:8080" }
  skills:
    registries:
      - { provider: google, query: "skills.tags:nodejs" }
    path: "/.agents/skills"
---
apiVersion: ax.io/v1alpha1
kind: Gateway
metadata: { name: default-gateway, atespace: default }
spec:
  listeners:
    - { name: grpc, port: 8494, protocol: gRPC }
    - { name: http, port: 8080, protocol: HTTP }
  egress:
    allowlist:
      hosts:
        - { host: "*", port: 443 }    # 生产环境必须收紧,见 §4.5
---
apiVersion: ax.io/v1alpha1
kind: Model
metadata: { name: default-model, atespace: default }
spec:
  provider: google
  model: gemini-3.8-flash
  secretKey: { name: gemini-api-secret, key: GEMINI_API_KEY }
  parameters: { temperature: 0.9 }
```

生命周期:

```bash
# 装机(Go 工具链)
go install github.com/google/ax/cmd/ax@latest

# 部署控制面:需要 K8s 集群 + ko + 可达的镜像仓库 + Agent Substrate Control API
# (集群内默认 api.ate-system.svc.cluster.local:443)
make deploy AX_IMAGE_REPO=<your-registry>     # 部署 Redis + 控制面,落在 ax-system 命名空间

# 一次完整生命周期
ax apply -f task.yaml
ax get tasks
# NAME      ATESPACE   PHASE     ACTOR           WORKER-IP    AGE
# task123   default    Running   task123         10.20.3.67   1m

ax watch task task123                # 实时流式看 phase + condition 变化
ax ssh task123 -- ls -al /workspace  # 进沙箱(需要 spec.debug: true)
ax suspend task task123              # 快照并暂停,资源让出去
ax resume task task123               # 从断点恢复:新进程树,旧文件
ax delete task task123               # Terminating → 记录删除,阻塞到完成

./demo.sh                            # 一键跑完整 lifecycle 端到端 demo
```

**Task 的 Conditions 语义**(排障第一现场):

| Condition | 何时为 True |
|-----------|-------------|
| `WorkspaceReady` | 所有 workspace 装配完成,之后一直 True |
| `GatewayReady` | Gateway 的网络策略已应用到沙箱 |
| `Ready` | task 在跑**且** `WorkspaceReady` 为 True —— **这是要 wait 的那一条** |

两个关键状态翻转:挂起时 `Ready` 变 False、reason `TaskSuspended`;恢复时转回 True。删除时先进 `Terminating`,controller 拆完沙箱后记录整体移除,`ax delete` 阻塞到完成。

### 4.2 Go:嵌入 runner 包,写一个带退出钩子的自定义 runner

三级定制里最平衡的一级:要标准生命周期,但想在命令退出时插入逻辑(上传产物、通知 webhook、记录 token 消耗):

```go
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/google/ax/pkg/apis/v1alpha1"
	"github.com/google/ax/runner"
	"gopkg.in/yaml.v3"
)

func main() {
	// 控制面把整个 Task 塞进环境变量,而不是当成容器参数
	var task v1alpha1.Task
	_ = yaml.Unmarshal([]byte(os.Getenv("AX_TASK_YAML")), &task)

	// AX_WORKSPACES_YAML 是多文档流,一个 Workspace 一个 document,按绑定顺序
	var workspaces []*v1alpha1.Workspace
	dec := yaml.NewDecoder(strings.NewReader(os.Getenv("AX_WORKSPACES_YAML")))
	for {
		var ws v1alpha1.Workspace
		if err := dec.Decode(&ws); err != nil {
			break // io.EOF 或解析错误都停在这里
		}
		workspaces = append(workspaces, &ws)
	}

	// SIGTERM 是唯一会被控制面送达的停止信号(stop 和 suspend 都走它)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	err := runner.Run(ctx, runner.Config{
		Task:       &task,
		Workspaces: workspaces,
		OnCommandExit: func(exit runner.CommandExit) {
			slog.Info("agent finished", "exitCode", exit.ExitCode)
			// 上传产物 / 通知 webhook / 记录 token 消耗到成本平台
		},
	})
	if err != nil {
		slog.Error("runner failed", "error", err)
		os.Exit(1)
	}
}
```

编译并打进镜像:

```bash
CGO_ENABLED=0 go build -o ax-task-runner .          # 交叉编译 linux/amd64
# Dockerfile 里 COPY 到固定路径 /usr/local/bin/ax-task-runner
```

**注意**:`OnCommandExit` 是你拿到「agent 命令退出码」的**唯一结构化入口** —— §2.3 说过,控制面目前不回读容器里的退出码。要做成本归因 / 产物归档,必须在这里做,别指望 task status 里有 exit code 字段。

### 4.3 Python:agent 进程内的自描述、就绪上报与优雅关闭

agent 侧不需要任何 AX SDK,读环境变量 + curl 元数据服务器即可。这段代码演示三个生产级实践:**自描述(按 limits 自适应并发)**、**优雅关闭(SIGTERM 时刷盘)**、**就绪门控(不抢 Ready 之前的流量)**:

```python
import os, sys, time, json, signal, urllib.request, threading

META = os.environ["AX_METADATA_URL"]          # runner 注入,例如 http://127.0.0.1:80

# --- 1. 自描述:agent 读回自己的规格,按 limits 决定并发 -----------
def load_self():
    with urllib.request.urlopen(f"{META}/metadata/v1alpha1/ax/task", timeout=5) as r:
        # 返回 application/yaml;生产里用 yaml.safe_load,这里用最小解析
        import yaml
        return yaml.safe_load(r)

task = load_self()
limits = task["spec"].get("resources", {}).get("limits", {})
cpu_limit = float(limits.get("cpu", "2"))
# 经验值:每 1 CPU ~ 6 个并发 LLM 调用(IO 密集型 workload)
CONCURRENCY = max(1, int(cpu_limit * 6))
print(f"[agent] cpu_limit={cpu_limit} -> concurrency={CONCURRENCY}", flush=True)

# --- 2. 就绪门控:WorkspaceReady 之前不要开始接活 ------------------
def workspace_ready():
    try:
        with urllib.request.urlopen(f"{META}/readyz", timeout=5) as r:
            return r.status == 200
    except urllib.error.HTTPError as e:
        return e.code == 200   # 503 = 还在初始化
    except Exception:
        return False

while not workspace_ready():
    print("[agent] waiting for WorkspaceReady (readyz 503)...", flush=True)
    time.sleep(2)

# --- 3. 优雅关闭:SIGTERM 到了先刷盘再退 ----------------------------
_flushing = False
def on_sigterm(signum, frame):
    global _flushing
    _flushing = True
    print("[agent] SIGTERM received: flushing agent state to /workspace", flush=True)
    with open("/workspace/.agent-state.json", "w") as f:
        json.dump({"concurrency": CONCURRENCY, "phase": "suspended-clean"}, f)
    print("[agent] flush done, exiting 0", flush=True)
    sys.exit(0)

signal.signal(signal.SIGTERM, on_sigterm)

# --- 主循环:带 token 预算的防烧钱闸 --------------------------------
BUDGET_TOKENS = int(os.environ.get("AGENT_TOKEN_BUDGET", "200000"))
used = 0
def call_llm(prompt):
    global used
    if used > BUDGET_TOKENS:
        print("[agent] budget exhausted, refusing to call LLM", flush=True)
        raise RuntimeError("token budget exceeded")
    # ... 你的 LLM 调用 ...
    used += 1500   # 占位:真实场景从 response.usage 读

while not _flushing:
    try:
        call_llm("summarize next chunk")
    except RuntimeError:
        break
    time.sleep(1)
```

**为什么这段代码重要**:`AGENT_TOKEN_BUDGET` 那几行是本文 §1 那张表里最后一行「K8s 完全没有的原语」的**应用层兜底**。AX 的 `Model` 资源解决了「凭证和参数集中管理」,但**token 预算熔断仍需应用层自己做** —— 这是当前版本 AX 明确没覆盖的缺口,也是我给生产部署的第一条告警。

### 4.4 路由:从集群内外访问一个有状态 task

展示 `ate-target-actor` header 路由的三种姿势,以及它如何**透明地跨 suspend/resume**:

```bash
# 姿势 1:集群内直连(AX controller 的就绪探针就是这么实现的)
curl -sS -H "ate-target-actor: default/task123" \
  http://atenet-router.ate-system.svc.cluster.local/metadata/v1alpha1/ax/task

# 姿势 2:本机调试,先 port-forward
kubectl -n ate-system port-forward svc/atenet-router 8001:80
curl -sS -H "ate-target-actor: default/task123" http://localhost:8001/readyz

# 姿势 3:验证「挂起的 task 也能被唤醒」
ax suspend task task123
time curl -sS -o /dev/null -w "%{http_code} %{time_total}s\n" \
  -H "ate-target-actor: default/task123" http://localhost:8001/readyz
# 期望:200 + sub-second(首次请求含 resume,sub-500ms 是 Substrate 的官方指标)
ax resume task task123
```

Go 客户端(也就是 `ax ssh` 内部用的方式):

```go
ctx = metadata.AppendToOutgoingContext(ctx, "ate-target-actor", "default/task123")
resp, err := client.SomeMethod(ctx, req)
```

**设计要点**:`Host` 和 `:authority` header 原封不动留给应用。路由选择**只**由 `ate-target-actor` 决定。这意味着你的 agent 应用可以用任何域名/虚拟主机语义,路由层完全不干涉 —— **关注点分离做到了 header 级别**。

### 4.5 生产级 egress 收紧 + 扩展默认镜像

两段合起来构成「上线前必做」:

```yaml
# 生产 Gateway:从 host: "*" 收紧到显式三白名单
apiVersion: ax.io/v1alpha1
kind: Gateway
metadata: { name: prod-gateway, atespace: default }
spec:
  listeners:
    - { name: http, port: 8080, protocol: HTTP }
  egress:
    allowlist:
      hosts:
        - { host: "api.anthropic.com", port: 443 }   # LLM provider
        - { host: "generativelanguage.googleapis.com", port: 443 }
        - { host: "github.com",        port: 443 }   # Git host
        - { host: "raw.githubusercontent.com", port: 443 }
        - { host: "git-mcp.default.svc.cluster.local", port: 8080 }  # 内部 MCP
```

```dockerfile
# 定制 runner 镜像:扩展默认镜像,保留 entrypoint 契约
# 钉死 digest,保证 runner 行为可复现
FROM gcr.io/ax-substrate/ate-images/ax-task-runner@sha256:69b764607ec7f1e433d83d2eca17dccfa04f663b43f071fd376e2dd716a57f8c

RUN apt-get update && apt-get install -y --no-install-recommends nodejs npm \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g my-agent
# runner 二进制留在 /usr/local/bin/ax-task-runner,其余什么都不用改
```

从零写 runner 的最小骨架(任意语言,满足 §2.3 的 7 条契约):

```python
#!/usr/bin/env python3
# 存为 /usr/local/bin/ax-task-runner —— 语言不限,满足契约即可
import os, sys, signal, subprocess, http.server, yaml, threading

AX = "/ax"  # 默认 runner 的 marker 目录;自己写也要有等价物

class Runner(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/healthz":
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
        elif self.path == "/readyz":
            # 契约第 3 条:workspace 未就绪前必须 503,controller 据此设 WorkspaceReady
            if all(os.path.exists(f"{AX}/{p}.done") for p in WS_PATHS):
                self.send_response(200); self.end_headers(); self.wfile.write(b"ready")
            else:
                self.send_response(503); self.end_headers(); self.wfile.write(b"initializing")
        elif self.path == "/metadata/v1alpha1/ax/task":
            self.send_response(200)
            self.send_header("Content-Type", "application/yaml"); self.end_headers()
            self.wfile.write(open(os.environ["AX_TASK_YAML"], "rb").read() if os.environ.get("AX_TASK_YAML","").startswith("/") else os.environ["AX_TASK_YAML"].encode())
        else:
            self.send_response(404); self.end_headers()
    protocol_version = "HTTP/1.1"

def prepare_once(name, spec):
    """契约第 4 条:只准备一次。resume 后重克隆会摧毁 agent 状态。"""
    marker = f"{AX}/{name}.done"
    if os.path.exists(marker):
        return
    # ... clone git / 写 MCP 配置 / materialize skills ...
    os.makedirs(AX, exist_ok=True)
    open(marker, "w").write("done")

task = yaml.safe_load(os.environ["AX_TASK_YAML"])
WS = [yaml.safe_load(d) for d in (os.environ["AX_WORKSPACES_YAML"].split("---\n")[1:])]  # 简化
WS_PATHS = []
for binding in task["spec"]["workspaces"]:
    path = binding.get("path") or f"/workspace/{binding['name']}"
    WS_PATHS.append(path); prepare_once(binding["name"], binding)

cmd = task["spec"]["command"]
os.chdir(WS_PATHS[0])                       # 第一个 workspace 是工作目录
env = dict(os.environ); env["AX_METADATA_URL"] = "http://127.0.0.1:80"
for e in task["spec"].get("env", []):
    env[e["name"]] = e["value"]

proc = subprocess.Popen(cmd, env=env, start_new_session=True)  # 独立进程组,契约第 5 条

def shutdown(signum, frame):
    # 契约第 7 条:SIGTERM → 转发进程组 → 宽限 → SIGKILL 残留
    try: proc.terminate()
    except Exception: pass
    try: proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        try: proc.kill()
        except Exception: pass
    sys.exit(0)
signal.signal(signal.SIGTERM, shutdown)
# 契约第 6 条:命令退出后 runner 继续活着,否则 ax ssh / 元数据服务全失效
threading.Thread(target=http.server.HTTPServer(("0.0.0.0", 80), Runner).serve_forever).start()
proc.wait()
print(f"[runner] command exited code={proc.returncode}, staying up as PID 1", flush=True)
signal.pause()  # 一直活着,等 SIGTERM
```

---

## 5. 5 套编排方案 17 维度对比

| 维度 | **Google AX** | **K8s Job/CronJob** | **Argo Workflows** | **Temporal** | **kagent** |
|---|---|---|---|---|---|
| **1. 定位** | agent workload 的声明式编排运行时 | 运行到完成的批处理 | DAG 流水线编排 | durable execution 工作流引擎 | K8s 原生 agent 框架(CNCF Sandbox) |
| **2. 编程模型** | 声明式 YAML(`ax.io/v1alpha1`) | 声明式 YAML | 声明式 YAML + 模板 | **代码优先**(Go/Java/TS/Python SDK) | 声明式 + Python SDK |
| **3. 状态存储** | **Redis**(绕开 etcd) | etcd(CRD) | etcd(CRD) | 自有存储(Postgres/MySQL/Cassandra/ES) | etcd(CRD) |
| **4. 工作队列** | Redis Streams `XREADGROUP` | informer + 退避重试 | informer + 队列 Pod | 内部 task queue + sticky queue | informer |
| **5. 沙箱隔离** | Agent Substrate(gVisor/microVM,zero-trust) | Pod 共享内核,需自套 | Pod,需自套 | 无(纯工作流,不跑隔离代码) | Agent Substrate |
| **6. 有状态挂起/恢复** | **`ax suspend/resume`,全状态快照(RAM+FS)** | 无(scale-to-zero 丢状态) | 无(步骤重试) | workflow state 持久化,但**不含沙箱运行时状态** | 依赖 Substrate |
| **7. 闲置 agent 成本** | **30x+ 超额订阅,sub-500ms 唤醒** | 每个 Job 独占 Pod | 每个 Pod 独占 | worker 池复用,但无沙箱级多路复用 | 依赖 Substrate |
| **8. 网络隔离** | **Gateway 资源,egress 显式 allowlist,默认收紧** | NetworkPolicy(粗粒度) | NetworkPolicy | N/A | Substrate 策略 |
| **9. 请求路由** | `ate-target-actor` header,自动唤醒 | Service 负载均衡 | N/A(主动拉取) | worker 轮询拉任务 | Service |
| **10. MCP / Skills** | **Workspace 一等字段(registries + servers)** | 无 | 无 | 无(需应用层) | 有(agent 协议层) |
| **11. LLM 凭证管理** | **`Model` 资源,引用 K8s Secret** | Secret 裸挂 | Secret 裸挂 | 应用层 | 应用层 |
| **12. 水平扩展** | controller 加副本即加 consumer | 加副本 | 加 replica | 加 worker(自动) | 加副本 |
| **13. 可观测性** | `ax watch` 流式 conditions + 沙箱内 HTTP 元数据 | kubectl logs/events | 完整 UI + 归档 | **最强**:完整 workflow 可视化 + 查询 | UI + trace |
| **14. 成熟度 / 许可** | **v1alpha1,明确警告稳定版前有破坏性变更** | GA,K8s 核心 | CNCF Graduated | GA,BSD | CNCF Sandbox |
| **15. 最小依赖** | K8s + Redis + Agent Substrate + ko | K8s | K8s | 数据库 + worker | K8s + Substrate |
| **16. 最适合** | 大规模有状态 agent 集群 + 严格出站管控 | 一次性/定时批处理 | CI/CD、数据流水线、多步骤 DAG | 需要强一致重试与人工干预的长流程业务编排 | 团队级 agent 部署,想要 K8s 原生体验 |
| **17. 不适合** | 需要 DAG/条件分支语义的场景(交给上层框架) | 长时、需保状态的 agent | 运行时交互式 agent | 需要沙箱隔离与多路复用的密集 agent 计算 | 需要绕开 K8s 的场景 |

**选型一句话**:你的 agent 集群如果有 **1000+ 并发 agent + 严格出站合规 + 闲置比 > 50%**,AX/Substrate 这一层开始值得认真评估;如果是 **10 个 agent 的内部工具**,K8s Deployment + 手写胶水更快;如果核心痛点是**业务流程的一致性重试与人工审批**,Temporal 的 durable execution 是更对口的抽象;**kagent** 适合想要「K8s 原生 + Python SDK + 不想自己拼编排」的中间档。

---

## 6. 6 条 6-12 个月可验证硬指标

每条都能在本地/测试集群里直接跑出来复现。

| # | 硬指标 | 验证方式 | 期望结果 |
|---|--------|----------|----------|
| 1 | **首次 task 起飞时间** | `go install github.com/google/ax/cmd/ax@latest` → `make deploy` → `ax apply -f examples/task.yaml` → `ax watch task task123` | `Ready` 在合理时间内置 True(clone chalk 仓库的时间另计);`ax get tasks` 显示 `Running` |
| 2 | **`ax ssh` 的安全门控** | 对 `spec.debug: false` 的 task 执行 `ax ssh task123 -- ls` | **必须被拒绝**。只有 `debug: true` 才 serve guest services;这是 secured-by-default 的可验证证据 |
| 3 | **就绪探针双态** | task 内部 `curl -s -o /dev/null -w "%{http_code}" $AX_METADATA_URL/readyz` | workspace 初始化期 **503**,克隆/MCP 配置/Skills 就位后 **200**。controller 据此翻 `WorkspaceReady` |
| 4 | **suspend/resume 的状态一致性** | `ax ssh task123 -- sha256sum /workspace/...` → `ax suspend` → `ax resume` → 再次 `ax ssh` 比对 | **文件内容 hash 一致**;`ps` 显示**全新进程树**(Substrate 快照恢复到新容器:新进程、旧文件) |
| 5 | **egress 白名单的实际拦截力** | Gateway 从 `host: "*"` 收紧到 §4.5 的 5 条 → task 内 `curl https://<非白名单 host>` | **被过滤/超时**;白名单内 host 正常 200。这是「提示注入后外发不出去」的实测验证 |
| 6 | **controller 水平扩展线性度** | `make deploy` 后把 `ax-controller` 副本数从 1 → 4,用脚本并发 `ax apply` 创建 N 个 task | 创建吞吐随副本数近似线性上升(Redis Streams `XREADGROUP` 消费组分摊,无重复消费) |

**一个诚实的注脚**:以上 6 条里,**第 4 条的 sub-500ms 唤醒**依赖 Agent Substrate 的部署质量(worker 数量、快照存储 IOPS)。官方 demo 数据(250 actors / 8 pods / 30x+ 超额订阅)是在其参考部署下测得的;你的集群里复现率取决于 gVisor 后端的启动开销和快照存储延迟。**不要把官方数字当成 SLA 承诺。**

---

## 7. 6 条 6-12 个月可观察的未来信号

| # | 信号 | 判定标准 |
|---|------|----------|
| 1 | **v1alpha1 → 稳定版的 schema 冻结** | README 的 WARNING 段落移除,或出现 `ax.io/v1`。这是 AX 从「演示架构」走向「可生产依赖」的分水岭 |
| 2 | **「agent 控制面绕开 etcd」是否成为社区共识** | 观察是否有其他 agent 平台跟进 Redis/流式控制面;K8s SIG 是否推出针对短时高并发 workload 的存储分级方案 |
| 3 | **Substrate 沙箱后端扩张** | 是否从 gVisor / microVM 扩展到更多后端(对标 09-19 沙箱文章的 Firecracker / Kata / Hyperlight 竞争格局) |
| 4 | **编排层分层稳定** | `应用框架(LangGraph/ADK)→ 编排(AX)→ 沙箱编排(Substrate)→ 沙箱技术` 这四层是否被 kagent 等 CNCF 项目事实采纳为标准分层 |
| 5 | **`ate-target-actor` 路由模式是否被标准化** | 有状态粘性路由是否从「AX 内部约定」变成跨项目协议(对标 MCP 之于工具调用) |
| 6 | **「agent 大部分时间空闲」假设的实测检验** | 30x+ 超额订阅在真实 RL rollout / 高频客服场景下是否复现 —— 高负载场景下多路复用收益会显著下降 |

---

## 8. 总结:该怎么用、千万别怎么用

### ✅ 该用

1. **大规模有状态 agent 集群**:数百到数千 agent,闲置比高,出站合规要求严格。AX 的 4 原语 + Substrate 多路复用正好打在痛点上。
2. **需要 per-agent 严格出站管控的场景**:金融、医疗、法务。Gateway 的显式 allowlist + 默认收紧,是合规审计可以直接指向的配置项。
3. **频繁轮换 LLM 凭证 / 钉死模型版本**:`Model` 资源一次 `ax apply` 全集群生效,告别「改 200 个 deployment 的环境变量」。
4. **想给 agent 做 scale-to-zero 但不能丢状态**:`ax suspend/resume` + 全状态快照是目前最完整的答案。
5. **需要沙箱内可观测性**:`ax ssh` + 元数据服务器让「进运行中的 agent 看它在干嘛」成为一等操作,排障不用靠日志猜。

### ❌ 千万别用

1. **别把 AX 当 Agent 框架用**。它没有 DAG、没有条件分支、没有记忆抽象。那是 LangGraph / Claude Agent SDK 的活。AX 明确说过「does not try to model that shape」。
2. **别在生产上跑 `v1alpha1` 而不做抽象层**。README 白纸黑字写了稳定版前会有重大破坏性变更。在 manifest 与业务代码之间放一层转换。
3. **别在生产开 `spec.debug: true`**。guest services 允许**沙箱内任意进程执行与文件访问**。排障时开,平时关。
4. **别指望 AX 管 token 预算**。`Model` 管凭证和参数,**烧钱熔断必须应用层自己做**(见 §4.3 的 `AGENT_TOKEN_BUDGET`)。这是当前版本最大的安全/成本缺口。
5. **别让 runner 在命令退出时跟着退**。PID 1 一退,元数据服务器和 `ax ssh` 全没。契约第 6 条。
6. **别在 resume 后重新准备 workspace**。重克隆会摧毁 agent 积累的本地状态。marker 文件机制是刚需,自己写 runner 也要实现。
7. **别把 Gateway 留在 `host: "*"`**。注释那句「tighten this in production」不是建议,是告警。

### 5 步生产部署 checklist

1. **[沙箱]** 确认 Agent Substrate 后端选型(gVisor vs microVM),验证 zero-trust 内核隔离在多租户下满足你的合规要求
2. **[网络]** Gateway egress 收紧到显式 5 条白名单(LLM provider × 2 + Git host × 2 + 内部 MCP),并在 CI 里加一条 lint 阻止 `host: "*"` 合并
3. **[凭证]** 所有 LLM Key 走 `Model` 资源 + K8s Secret,应用代码里**不准出现明文 Key**;设置 90 天轮换日历
4. **[成本]** 应用层实现 token 预算熔断(§4.3);对闲置 agent 配 `ax suspend` 定时策略;用 `ax watch` 的 condition 流做异常 loop 检测
5. **[可观测]** `spec.debug: true` 只在排障时开;接 `ax watch` 的 condition 转换到现有告警平台;把 `/readyz` 的 503→200 翻转做成部署看板的核心指标

### 5 条最佳实践

1. **Workspace 复用**:一个 `Workspace` 声明一次,被 N 个 task 绑定。团队级工具链(workspace + MCP + skills)抽成一个 Workspace 资源,所有 agent 共享。
2. **goal 机制克制用**:Antigravity 装配默认 10 分钟(`AX_BOOTSTRAP_TIMEOUT`)。确定性需求写进镜像,只把真正动态的装配交给 goal agent。
3. **Task 保持小**:AX 的哲学是「一个便宜、可丢弃的单元 + agent 自己扇出」。别设计成一个巨型 task 干完所有事。
4. **镜像钉 digest**:`FROM gcr.io/.../ax-task-runner@sha256:<digest>`,保证 runner 行为可复现(§4.5 的 Dockerfile 已示范)。
5. **优先「扩展默认镜像」那一档**:3 级定制里,只有需要插退出钩子(成本归因/产物归档)时才上「嵌入 runner 包」,能不「从零写」就不写 —— 契约里 7 条细节(marker、进程组、SIGTERM 宽限、命令退出后存活)自己实现容易漏。

---

## 写在最后:Agent 编排运行时层,2026 年 K8s 生态最大的新赛道

把 AX 放回这一周的语境里。2026-09-19 我们拆了「AI Agent 沙箱隔离运行时层」(Firecracker / Kata / gVisor / Hyperlight),那是**防御视角**:怎么把不受信任的 agent 代码关起来;2026-09-21 这篇是**编排视角**:承认了 agent 是新 workload 之后,基础设施该怎么组织它。

两条线在 2026 年合流了:**Agent 的安全与效率,不再是对立的两端,而是同一个抽象栈的两面** —— Substrate 用 gVisor/microVM 做内核级 zero-trust 隔离(安全),用 actor/worker 多路复用做 30x+ 密度(效率),而 Gateway 的 egress allowlist 把网络边界变成一行可审计的声明(安全),`ax suspend/resume` 让闲置 agent 让出资源(效率)。**隔离做得越干净,多路复用才敢做得越激进。**

三个长期判断:

1. **Agent 编排运行时层会在 2026 H2 - 2027 H1 完成分层定型**:`应用框架(LangGraph / Claude Agent SDK / ADK)→ 编排运行时(AX 类)→ 沙箱编排(Substrate 类)→ 沙箱技术(gVisor / Firecracker / Kata / Hyperlight)`。每一层都会有事实标准,跨层耦合的方案会被淘汰。判断依据:Substrate 的 README 已经明确把自己定位为「framework and agent harness agnostic」的底座,而 kagent(CNCF Sandbox)作为上层框架已经接入 —— 分层在 2026 年 9 月已经初具形态。

2. **「绕开 etcd」会成为 agent 控制面的标准操作**。不是 Redis 更好,而是**短时高并发 task 的数量级与 etcd 的物理约束结构性冲突**。设计目标是 billions of tasks per cluster 的系统,不可能把状态放在单数位 GB 的强一致存储上。K8s 生态「一切皆 CRD」的肌肉记忆,会在 agent workload 这个品类上第一次被公开打破 —— DESIGN.md 里那段话,我认为是 AX 这个项目最值得被反复引用的一段。

3. **有状态 workload 的 scale-to-zero 会成为基础设施刚需**。serverless 教会了无状态服务「缩到 0」,但 agent 不能丢状态。Substrate 的 suspend/resume(全状态快照:volatile RAM + 文件系统,sub-500ms 恢复)把「省钱」和「保状态」第一次同时做到。这个能力不只能用于 AI agent —— 任何「空闲比高 + 要状态 + 要隔离」的 workload(IDE 后端、交互式 notebook、RL rollout worker)都是同构问题。**「agent 大部分时间在空闲」这个事实,是 2026 年基础设施层最值钱的一个观察。**

最后一句实话:AX 今天还是 `v1alpha1`,README 顶着 WARNING,自己说了「not eligible for production」。现在不是把它拍进核心生产链路的时机 —— **但它是今年最值得读源码、最值得在测试集群里跑通的项目之一**。因为它解决的那 7 个缺口,每一个都在真实地折磨着今天在 K8s 上硬跑 agent 集群的团队。**你今天要不要用 AX 不重要;理解它为什么这样设计,能帮你重新画自己的 agent 基础设施架构图。**

---

### 数据来源

- [google/ax](https://github.com/google/ax) — README、DESIGN.md、docs/(concepts / manifests / networking / sandbox / runner)、examples/task.yaml(截至 2026-09-21)
- [agent-substrate/substrate](https://github.com/agent-substrate/substrate) — README(actor/worker 多路复用、sub-500ms resume、500+ activations/sec、10x 密度、30x+ 超额订阅 demo 数据)
- [Hacker News](https://news.ycombinator.com/) — 「AX – Google's Open Agentic Orchestrator」(297 points / 113 comments,2026-09-21 前后首页)
- 仓库元数据:Go / Apache-2.0 / 创建 2026-03-30 / 3541 stars / 168 forks / 最后推送 2026-09-20(2026-09-21 抓取)
- 相关阅读:[kagent](https://github.com/kagent-dev/kagent)(CNCF Sandbox,K8s 原生 agent 框架,基于 Agent Substrate)
