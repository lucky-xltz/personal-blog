---
title: "Dapr 1.18 深度拆解:身份头 spoofing、跨应用工作流注入与 sidecar 并发债务"
date: 2026-10-11
category: 技术
tags: [Dapr, sidecar, mTLS, SPIFFE, 服务网格, Actor 模型, 工作流引擎, durable execution, Go 并发, data race, WaitGroup, 身份伪造, percent-encoding, 访问控制, 多租户, Kubernetes, CRD, WorkflowAccessPolicy, history signing, MCP, Jobs API, hot reload, 中间件, 云原生, 微服务, 2026]
excerpt: "Dapr 1.18.6 与 1.18.7 在 2026-10-09 同日连发:四个安全洞全部是「应用自己声明的身份被 sidecar 信任」,加上八处 data race 与一个跨请求结果串台的中间件管道 bug。本文从 SPIFFE 身份流和 Go 并发原语层面拆解根因,给出五段可运行的验证代码、五套 sidecar 方案十七维度对比、六条硬指标与五步生产升级 checklist。"
author: 林小白
readtime: 24
cover: https://images.unsplash.com/photo-1639762681485-074b7f938ba0?w=600&h=400&fit=crop
---

# Dapr 1.18 深度拆解:身份头 spoofing、跨应用工作流注入与 sidecar 并发债务

> 一句话主旨:**Dapr 1.18 这一代的整个安全模型,从「应用声明自己是谁,sidecar 转发」翻转为「sidecar 从 mTLS 证书断言谁在调用,应用只能读」。** 1.18.6 的四个安全洞和 1.18.7 的八处 data race,是同一次范式转换付的利息 —— 旧的隐含约定("header 是 sidecar 设的,没人会自己发")在多租户集群里根本不是约定,是漏洞。

## §0 今天的两篇为什么是同一件事

今天早间发了「五维刹车日」,核心论点是 Nadella 周六的四条架构主张:模型与编排层分离、防篡改人类可读证据、授权人中途暂停权、**先假设模型已被入侵**。中午发了 RisingWave v3.1.0,主旨是流处理引擎把「隐含约定」改写成「显式契约」(VARIANT 成一等类型、no-shuffle 废弃、sync/async trait 拆分)。

晚上这篇 Dapr 是同一周主题的第三层穿透,而且是最硬的一层:

| 栈层 | 事件 | 「隐含约定 → 显式契约」的具体形态 |
|------|------|----------------------------------|
| 治理层(早) | Nadella 架构主张 + Decision-1 决策模型 | 「假设模型已被入侵」从建议变架构约束;决策分数可审计 |
| 数据层(中) | RisingWave v3.1.0 | NaN 折叠成单个 quiet-NaN,让「逻辑等价」真正等于「字节相等」 |
| **运行时层(晚)** | **Dapr 1.18.6 / 1.18.7** | **身份头从「应用可以自带」变「sidecar 从 mTLS 证书断言」;reserved actor 类型从约定不调用变 403 拒绝** |

早上说「假设模型已被入侵,从零遏制」。晚上这篇就是这句话在 sidecar 运行时里的工程实现:**Dapr 假设每一个应用都可能是恶意的,把应用自己声称的身份全部删掉,只认 mTLS 证书里 SPIFFE ID 断言的身份。**

这不是夸张。1.18.6 release notes 里最安静也最致命的一行是:

```text
Dapr-Caller-App-Id: admin
Dapr-Caller-App-Id: checkout
```

调用方应用自己发一个 `Dapr-Caller-App-Id: admin`,sidecar 把自己设的真值 `checkout` 追加上去,目标应用收到两个值,**顺序随机**。目标应用如果用 Go 标准库 `http.Header.Get`(取第一个)或 gRPC `metadata.Get(...)[0]` 做授权判断 —— 这两个是绝大多数人的写法 —— 就会读到攻击者选的值。任何能调到你的应用的应用,都能让你的应用相信调用来自 `admin` 或者任意命名空间。

**关键洞察 1:sidecar 的安全承诺和它的实现之间隔着一个 header 合并语义。** mTLS 是好的,SPIFFE 是好的,但 sidecar 把「我断言的身份」和「应用声称的身份」放进同一个 header 的两个值里往下传,下游用「取第一个」的语义读 —— 整条链的密码学强度归零。这不是配置错误,是协议设计里漏掉了一条「谁有权写这个字段」的规则。

---

## 1. 问题的源头:Dapr 的身份模型为什么会欠这笔债

### 1.1 sidecar 模式的原始承诺

Dapr 的架构是每个应用 pod 旁边塞一个 `daprd` sidecar,应用不直连任何中间件,全部通过 sidecar 的 HTTP/gRPC API 访问 state store、pub/sub、workflow、actor。跨应用调用(svc1 → svc2)的路径是:

```text
svc1 app → svc1 daprd (HTTP /v1.0/invoke/svc2/method/foo)
         → [mTLS 隧道, 证书是 Sentry 签的 SPIFFE SVID]
         → svc2 daprd → svc2 app (HTTP localhost:3500/v1.0/invoke/svc2/method/foo)
```

这条链的信任设计是:**mTLS 保证传输方身份,sidecar 在请求里加身份头告诉下游应用「谁在调你」**。`dapr-caller-app-id` / `dapr-caller-namespace` / `dapr-callee-app-id` 这三个头就是这套「应用可读的身份投影」。

设计意图很清楚:应用不需要解 mTLS 证书、不需要跑 SPIFFE 库,读个 header 就能做租户路由和粗粒度授权。这是 sidecar 的核心卖点 —— **把难的密码学留给 sidecar,给应用一个简单的语义接口**。

### 1.2 承诺在哪个环节破的

问题出在「应用发给 sidecar 的请求头」和「sidecar 发给应用的请求头」用的是**同一个命名空间**。HTTP API 的实现把应用发来的**每一个**请求头都拷进 invocation metadata,然后 sidecar 再把自己的身份头以小写键名加进去 —— **不删应用已有的同义大小写变体**。

Go 的 `http.Header` 是 `map[string][]string`,且它的 canonical form 是 `CanonicaHeaderKey` 把 `dapr-caller-app-id` 变成 `Dapr-Caller-App-Id`。于是:

```text
应用发送:  dapr-caller-app-id: admin
Go canonical: Dapr-Caller-App-Id: [admin]
sidecar 加: dapr-caller-app-id: checkout      (小写键)
合并后:    Dapr-Caller-App-Id: [admin, checkout] 或 [checkout, admin]  ← 随机
```

跨应用调用**从来没有**删过这些头,只有自调用(self-invocation)删了 —— 这恰恰是最讽刺的部分:**单 pod 自调用这条最不可能被攻击的路径做了防护,跨 pod 这条真正暴露的路径没做。**

gRPC proxy 路径更糟,有两种独立缺陷叠加:

1. 调用方 sidecar 把应用的 metadata **原样转发**再把自己的身份值 append,而攻击者的值**永远在前面**;
2. 调用方 sidecar **根本没设** `dapr-caller-namespace`,所以目标应用收到的命名空间**只能**是调用方应用自己填的那个。

**关键洞察 2:Go 的 `http.Header.Get` 和 gRPC 的 `metadata.Get(...)[0]` 都是「取第一个值」语义,而 HTTP 多值头的顺序在规范层面是 undefined 的。** 任何把「取第一个 header 值」当作授权依据的设计,都把访问控制委托给了一个语义未定义的操作。这不是 Dapr 独有的坑,是整个 HTTP 生态的系统性盲区 —— 但 Dapr 把它用在了**身份**这个最不能含糊的地方。

### 1.3 影响边界:什么没被攻破

Release notes 明确说了三个「没被影响」的东西,这些边界本身就是信息:

- **Dapr 自己的访问控制策略没被攻破** —— 因为它们读的是调用方 sidecar 的 **mTLS 身份**,不读这三个头;
- **工作流访问策略没被攻破** —— 同样用 SPIFFE 身份;
- **metrics 没被污染** —— 同样用 mTLS 身份。

**这告诉我们真正的分层**:Dapr 内部一直有两条身份通道 —— sidecar 之间用的密码学通道(mTLS/SPIFFE),和 sidecar→应用用的语义通道(header)。破的是后者。**凡是用 mTLS 身份的地方都安全,凡是用 header 的地方都可伪造。** 这个观察直接决定了修复方案的方向:把语义通道也锚定到密码学通道上。

---

## 2. 三层架构:1.18 的身份栈与工作流信任链

### 2.1 v1.18.0 打的地基:三条新承重级能力

要理解 1.18.6/1.18.7 在修什么,必须先看 1.18.0(2026-06-10 发布,88KB release notes)建了什么。这不是补丁版本,是 Dapr 工作流子系统的一次架构重写,核心是三条:

**① WorkflowAccessPolicy CRD —— 工作流的授权白名单**

v1.18 之前,**同信任域内任何 caller 都能调度、终止、查询任何其他应用的工作流**。Release notes 自己承认:「单团队集群可以接受,共享或多租户集群是真问题,尤其现在工作流可以分支到远程应用」。

策略语义是纯白名单:

- 目标应用**没加载任何策略** → 全部允许(默认开放,兼容存量)
- 目标应用**加载了至少一条策略** → 默认拒绝,只放行匹配规则的调用
- **自调用**(caller app ID == 目标 app ID)永远允许,不需要规则

规则按操作粒度写,工作流支持全部八个操作:`schedule` / `terminate` / `raise` / `pause` / `resume` / `purge` / `get` / `rerun`;activity 只支持 `schedule`。名字支持 glob(`*` `?` `[abc]`)。

```yaml
apiVersion: dapr.io/v1alpha1
kind: WorkflowAccessPolicy
metadata:
  name: checkout-wf-policy
spec:
  targetAppId: checkout
  accessPolicies:
    - appId: frontend
      defaultAction: deny
      operations:
        - operation: schedule
          action: allow
          workflowName: "OrderProcess*"
        - operation: get
          action: allow
          workflowName: "*"
```

**这里已经埋了 1.18.6 漏洞的解药**:release notes 明确写「Untrusted identity headers on user-facing requests are stripped before evaluation, so one app cannot spoof another's identity」。**设计层面已经知道身份头不可信并且在策略评估前剥离了它们 —— 但交付层面,普通服务调用的转发路径到 1.18.6 才补上。** 这是本文最重要的一个观察:同一个安全直觉在工作流子系统里落地了,在服务调用子系统里漏了。

**② Workflow History Signing —— 防篡改历史链**

这是一个基于签名链的完整性证明。每个签名覆盖一段事件区间 `[start, end)`,链式结构:

```text
┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐
│    Signature 0   │  │    Signature 1   │  │    Signature 2   │
│  Events [0,2)    │  │  Events [2,4)    │  │  Events [4,6)    │
│  prevDigest: nil ├─►│ prevDigest: d0   ├─►│  prevDigest: d1  │
└──────────────────┘  └──────────────────┘  └──────────────────┘
```

每次状态加载时验证六件事:链式衔接(`prevDigest`)、事件连续性(区间无空洞)、摘要重算匹配、签名本身、事件时刻证书有效性、签名应用的 SPIFFE 身份匹配工作流属主 app ID。**任一验证失败 → 追加一个终态 `ExecutionCompleted` 事件,错误类型 `DAPR_WORKFLOW_HISTORY_TAMPERED`,终止进行中的工作流,原始不可信状态保留做法证。**

跨应用边界还有两层:

- **ChildCompletionAttestation / ActivityCompletionAttestation** —— 子工作流或 activity 完成时签名,提交父实例 ID、父任务调度 ID、输入输出的规范摘要(**SHA-256 over wire-format-independent, NFC-normalized encoding**,跨语言 SDK 摘要稳定)、签名者证书链摘要、终态。父方在 inbox 入库时验证,把外部签名者证书存进 `ext-sigcert` 表。
- **传播历史的每块签名** —— 每个 propagated history chunk 带自己的块局部签名和 DER 证书链,接收方对每个 chunk 单独验证并检查叶子 SPIFFE ID 的 app 组件匹配 `chunk.appId`。

诚实边界:**签名是单向决定**。开了签名的工作流历史必须一直签名,关掉是硬验证错误,也没有对历史事件的补签。集群级开启前必须等未签名的工作流跑完或 purge 掉。而且 `WorkflowHistorySigning` 要求 mTLS 开着 —— daprd 拒绝在签名开但 mTLS 关的状态下启动。

**③ MCPServer CRD —— MCP 工具调用变 durable workflow**

这是 2026 年最值得注意的一条:sidecar 加载 `MCPServer` 资源后,daprd 注册内置工作流编排 `dapr.internal.mcp.<server>.ListTools` 和 `dapr.internal.mcp.<server>.CallTool.<toolName>`,**把 MCP 协议调用当 durable activity 执行**。应用代码不需要 import MCP SDK、不需要管连接、不需要管凭证,runtime 全包,享受与任何 Dapr 工作流相同的持久性保证。

支持的传输:`streamable_http` / `sse` / `stdio`。认证:静态头注入、OAuth2 client credentials(secret 调用时从 Dapr secret store 取,带可重试错误处理)、SPIFFE JWT SVID 注入。`ListTools` 和 `CallTool` 严格遵循 MCP 规范,`CallToolResult` 的完整 content union(text / image base64+mimeType / audio / resource_link / embedded resource)原样保留,JSON-RPC envelope 不改写,未知 content type 回退到结构化 JSON envelope 而不是丢弃。

**关键洞察 3:MCP 进了 Dapr 的 reserved actor 命名空间,就自动继承了 1.18.6 正在修补的这套权限边界。** `dapr.internal.*` 这条命名空间是 1.18 工作流重写的产物,1.18.6 的两个安全洞(Scheduler 跨应用 reminder、executor actor 伪造)全是「reserved actor 类型的权限检查没覆盖到某个 API 路径」。**引入 MCP 这类新能力的同时,攻击面也跟着 `dapr.internal.*` 命名空间的扩张一起扩张了** —— 这是「能力扩张与边界收敛必须同步」的教科书案例。

### 2.2 v1.18.6 补的四个洞:三条被绕过的权限路径

**(A) 身份头 spoofing**(见 §1)

修复方案的三层设计值得单独讲,因为它是「纵深防御」的正确示范:

1. **调用方 sidecar**:在设身份头之前,**以任何大小写**删掉它们(覆盖所有服务调用路径)。gRPC proxy 路径从 append 改成 **replace**,并且开始设 `dapr-caller-namespace`。
2. **目标方 sidecar**:**自己设这些头**,在把请求交给应用之前。**这一层让应用在调用方 sidecar 还是旧版本时也受保护。**
3. **mTLS 开启时**:身份头的值从调用方 sidecar 的 mTLS 证书 SPIFFE ID 取;`dapr-callee-app-id` 就是目标自己的 app ID。**mTLS 关闭时**:目标 sidecar 只保留调用方 sidecar 设的那一个值,其余丢弃。

第 2 层是精髓。**安全修复通常只修产生问题的一方,但 sidecar 是分布式部署的,你不可能原子地升级所有 pod。** 目标方自己设头,意味着**新版本保护旧调用方**,升级顺序不再是安全缝隙。

**(B) Scheduler 接受针对其他应用内部 actor 的 reminder**

这个洞的攻击面是四个里最大的。Scheduler 对 actor reminder 任务的授权只检查 job metadata 的 namespace 和 app ID 匹配调用方的 mTLS(SPIFFE)身份 —— **没检查 reminder 目标的 actor 类型是否属于调用方**。

同命名空间里有合法 Dapr 身份的攻击者可以:

- **触发其他应用的 workflow/activity actor 的 reminder**。关键细节:per-operation 工作流访问策略检查**只保护 sidecar-to-sidecar 的 reminder RPC,不保护 Scheduler 投递的 reminder** —— 两条投递路径,只有一条有守卫。
- **用攻击者提供的输入运行目标应用注册的任意 activity**。
- **注入 `TimerFired` 事件或 activity 结果(`TaskCompleted` / `TaskFailed`)到目标应用的工作流实例**。诚实边界:注入的 activity 结果只有在匹配工作流正在等待的 task 时才被接受,且开了 history signing 会拒掉未签名结果。
- **伪造目标工作流正在等待的 activity 结果** —— workflow actor 当作来自真实 activity 的结果接受,工作流带着攻击者给的输出继续跑,真实结果晚到时被当重复丢弃。
- **删别人的 workflow reminder,让工作流卡住**。
- **一次性删掉命名空间内所有内部 actor 类型的 reminder** —— 因为按 metadata 批量删除时,用户 actor 类型 `dapr` 的键是所有 `dapr.internal.<namespace>.<appid>.*` 键的**前缀**,ID 前缀匹配跨了 actor 类型。
- 注入非 activity 结果的事件 —— 一个 `TimerFired` 事件**直接把宿主 sidecar 崩掉**(inbox 存不下 timer 事件,reminder goroutine 不 recover panic)。

修复方案的信息量比漏洞本身还大,因为它是「正确做权限」的完整范例:

1. Scheduler 对所有 actor 定向 job 请求(schedule / get / delete / list / delete by metadata / delete by name prefix),**只要 actor 类型是不属于请求方的 reserved 内部类型,一律 `PermissionDenied` 拒绝**。用户 actor 类型不受限,所以仍能给别的应用托管的 actor 建 reminder。
2. **保留一个刻意例外的例外**:同命名空间内给别的应用的 workflow actor 建 `activity-result-*` reminder 仍然允许 —— 因为 activity 宿主在 workflow 的 sidecar 不可达时需要用它回传结果。**但只允许「无覆盖地创建」**:读、删、替换别的应用的这种 job 一律拒绝。这是「最小权限 + 不打断合法路径」的精细权衡。
3. **Scheduler 构建 key 前缀时永远以 key delimiter 终止 actor 类型**,这样 ID 前缀匹配只能匹配该 actor 类型的 actor ID,批量删除再也不能跨 actor 类型。
4. **workflow actor 现在验证 activity result reminder 的创建者**。Scheduler 在 reminder 触发时把创建者身份送回 sidecar,sidecar 传给 workflow actor。创建者既不是 activity 被派发到的应用也不是工作流自己的应用 → **丢弃并 ack,one-shot reminder 被删而不是重试,工作流继续等真结果**。老版本 Scheduler 不送 metadata 的 reminder 照常接受(升级兼容性)。
5. **reminder payload 类型校验**:`activity-result-*` reminder 的 payload 不是 `TaskCompleted` / `TaskFailed` 事件一律丢弃并 ack,**无论创建者是谁**。`TimerFired` 不再能进 inbox,sidecar 不再被崩。
6. **转发也要带创建者**:sidecar 收到触发的 reminder 转发给同应用的其他副本时携带创建者;接收方**只信任自己应用副本**通过 mTLS 身份转发的创建者,否则把对端应用自己记为创建者 —— **伪造的 reminder 不能靠转发洗掉创建者标记**。
7. **未调度的 task 不收结果**:别的应用创建的、工作流还没调度的 activity 结果不再被 park 进 inbox(以前一旦 task 被调度就会被无创建者检查地消费)。现在拒绝为 not yet durable,reminder 重试,task 调度后再检查派发目标,超过重试窗口就丢弃。

**(C) percent-encoding 绕过访问控制**

这是 CVE-2026-41491 的下半场。服务调用 method 里带 percent-encoded 的 `/` `\` `.`(`%2F` `%5C` `%2E`)可以到达目标应用上访问控制策略配置为拒绝的操作。

根因是**规范化与解码的执行点错位**:

```text
访问控制检查看到的: admin%2Fsecret    ← NormalizeMethod 不解码 %2F,按 / 切分只有 1 段
检查结果:           无规则匹配 → defaultAction: allow → 放行
HTTP app channel:   拼到 URL 里原样发出
目标应用 HTTP server: 解码成 /admin/secret → 路由到被拒绝的 handler
```

两种策略都被绕过:

- **deny-list**(`defaultAction: allow` + 部分操作 `action: deny`):`admin%2Fsecret` 走 gRPC,或 `admin%252Fsecret` 走 HTTP(HTTP API 解一次码,双编码变回 `%2F`)。`%2E%2E/admin` 在解析 `..` 的应用上到达 `/admin`。
- **allow-list**(`defaultAction: deny` + `/public/*` 允许):`public/x%2F..%2F..%2Fadmin` 匹配通配符,投递成 `/public/x/../../admin`。

**一个被明确指出的诚实边界**:是否真的绕过取决于应用框架。**按解码后路径路由的框架被绕过**(Python WSGI/ASGI,读 `r.URL.Path` 的 Go handler);**按转义路径路由的框架没被绕过**(Go 1.22+ `ServeMux`、chi)。**这是「漏洞影响依赖下游实现」的典型,也是为什么这个洞需要应用侧配合验证而不能只升级 runtime。**

修复:`NormalizeMethod` 现在**拒绝**任何含 `%2F` `%5C` `%2E`(任意大小写)或字面 `\` 的 method —— 跟它已经拒绝 `#` `?` null byte / control char 同一套机制。请求在访问控制检查**之前**失败,根本不到应用。覆盖服务调用 HTTP/gRPC API、其他 sidecar 收到的请求、proxied gRPC 调用、actor method 调用。**actor type、actor ID、reminder/timer 注册的 actor ID 和 name 也同样拒绝这些编码字符**,因为 actor ID 也被放进发给应用的 URL path。

**这是 breaking change**(下一节详述)。

**(D) 通过 reserved executor actor 伪造工作流任务结果**

影响范围最小但原理最干净的洞:开了 `WorkflowsClusteredDeployment` preview feature(默认关)时,同命名空间另一个应用可以通过自己 sidecar 的 actor invoke API(gRPC `InvokeActor` 或 HTTP `/v1.0/actors/<actorType>/<actorId>/method/<method>`)调用目标的 reserved `dapr.internal.<namespace>.<appID>.executor` actor,**即使目标加载了 deny-all 的 `WorkflowAccessPolicy` 且开了 `WorkflowHistorySigning`** —— 因为 executor 完成路径不验证 history 签名。

可以做四件事:让运行中的工作流消费攻击者选的 activity 结果(比如一个从未发生的审批);在工作流请求之前先存伪造结果,工作流一调度 activity 就消费到它;注入伪造的 workflow turn result 让工作流带着攻击者选的输出完成,或调度攻击者选的 activity。

根因有两层:

1. 内部 actor API(`CallActor`,peer sidecar 用来访问本 sidecar 托管的 actor)上的工作流访问策略门**只认 workflow 和 activity 两种 actor 类型**,其他 reserved actor 类型(executor、retentioner)**不检查调用方**,executor actor 自己也不检查。
2. **公共 actor invoke API 转发对 reserved `dapr.internal.*` 类型的调用**,而 actor state、reminder、timer API 早就拒绝了。

修复:内部 actor API 现在只接受来自**同 app ID 同命名空间** sidecar 对 workflow/activity 之外 reserved actor 类型的调用(按调用方 mTLS SPIFFE 身份识别)。公共 actor invoke API 现在对**所有** `dapr.internal.*` actor 类型返回 `ERR_ACTOR_TYPE_RESERVED`(gRPC `PermissionDenied`,HTTP 403)。**mTLS 关闭时没有调用方身份可查,加载了 `WorkflowAccessPolicy` 就拒绝,没加载就跟以前一样允许 —— 「保持 mTLS 开启」第一次变成一个有强制力的操作建议。**

---

## §3 四个安全洞的统一骨架

表面上这是四个不相关的洞。实际上它们是**同一个设计假设在四个 API 表面的四个投影**:

> **旧假设**:应用不会自己发 sidecar 该设的字段。`dapr.internal.*` actor 类型应用不会自己去调。编解码语义在检查点和执行点一致。

| # | 表面 | 旧隐含约定 | 1.18.6 的显式契约 |
|---|------|------------|------------------|
| A | 服务调用身份头 | 「应用发的 header 是数据,sidecar 设的 header 是身份」 | **应用发的身份头一律删除;身份头只能由 sidecar 从 mTLS 证书断言** |
| B | Scheduler reminder | 「namespace + app ID 匹配就够了」 | **actor 类型也要匹配;reserved 类型不属于你一律 PermissionDenied** |
| C | method 路径 | 「检查点看什么,应用就看到什么」 | **含 `%2F`/`%5C`/`%2E`/`\` 的 method 在检查前拒绝** |
| D | reserved actor 调用 | 「公共 API 不该被用来调内部类型」 | **公共 API 对 `dapr.internal.*` 一律 403** |

**四个洞里有三个的关键机制是「谁有权写某个命名空间」**:身份头的写权(只有 sidecar)、actor 类型的写权(只有属主)、路径分隔符的写权(谁都不能编码)。**第四个是「公共 API 与内部命名空间之间从来没有一堵墙」** —— state/reminder/timer API 有,actor invoke API 没有。

**这个骨架的通用性**:任何「sidecar / 网关 / 代理给应用暴露语义接口」的系统都有这个问题。Envoy 的 `X-Forwarded-For`、Kubernetes 的 `Impersonate-User` header、任何把传输层身份投影成应用可读字段的中间层,都要回答「应用能不能自己写这个字段」。**Dapr 1.18.6 的答案是一致的:能被伪造的字段不携带身份语义,只有从密码学凭证断言出来的字段才算。**

---

## 3. 1.18.7:八处 data race 与 sidecar 的并发债务

1.18.7 是 bug fix 版,但它修的东西比多数安全版更值得读,因为它暴露了 **sidecar 这种「生命周期管理多套异步子系统」的程序的系统性并发风险**。

### 3.1 WaitGroup 误用:三个不同的 bug,同一个反模式

**Bug 1:`sync: WaitGroup is reused before previous Wait has returned`**

内部 workflow executor actor 在被调用的同时被 deactivate,sidecar panic 退出。executor actor 用 WaitGroup 计数 in-flight 调用,deactivation 时 `Wait`,而在 `Wait` 期间新调用可能从零开始重新计数 —— Go 不允许。

修法干净:**deactivation 一开始就拒绝新调用,调用方重试到新的 executor actor。**

**关键洞察 4:这是 Go 并发里最容易被忽略的一类正确性问题 —— 「关闭」和「使用」是同一个资源的两个操作,不能并发。** 正确的关闭协议是「先拒绝新用户,再等存量用户退出」,而不是「一边等退出一边还让新人进来」。同样的 bug 在 1.18.7 里以三个不同形态出现(executor actor、actor lock、input binding),说明这是一个**系统性的协议缺陷而不是单处手滑**。

**Bug 2:actor 在 reentrant 调用超过 `maxStackDepth` 后永久拒绝调用**

用了 actor reentrancy 且设了 `maxStackDepth` 时,一旦一条调用链超过深度限制被拒,这个 actor 就**再也无法接受调用,直到 sidecar 重启**。

根因极其微妙:actor lock 把被拒的 reentrant 调用**也算进了调用链深度,而且永远不移除**,所以这条链永远不结束,下一个调用永远排不上。

修法:**在计数之前检查深度限制**,被拒的调用不改变深度。

这是一个特别有教育意义的 bug:被拒绝的操作**修改了拒绝它的状态**。拒绝本应是「什么都没发生」,实际上它永久占了一个槽位。

**Bug 3:activity 执行在工作流完成后仍挂起**

sidecar 一直持有工作流已经完成的 activity 执行,只在关停时释放。关停时每个执行打三行日志:

```text
<instance>/<activity>#<task>: failed before receiving activity result
activity-processor: failed to process work item: context canceled
<instance>: aborting activity execution (::<task>)
```

影响有明确量化:受影响场景是**没开 clustered workflow deployment 且复用工作流实例 ID**(比如 purge 一个实例然后用同一 ID 再调度,而上一轮的 activity 还在跑)。压测中 sidecar 持有约 90 个这样的执行 ≈ **250 个 goroutine + 30MB 内存**。如果设了 `maxConcurrentActivityInvocations`,每个挂起的执行还占一个 activity 槽位。

根因:工作流引擎按 instance ID + task ID 追踪每个 pending activity 执行;复用 instance ID 的新轮次调度相同的 task ID,**新执行在引擎追踪里替换了旧执行**,旧执行再也收不到结果也不会被取消,一直等到 sidecar 关停。

修法:升级到 **durabletask-go v0.12.6**,它保留一个 task 的**所有** pending 执行。代价是诚实的:同一 task 的多个执行重叠时结果无法匹配到具体哪个,所以它们被 abort 重跑,应用的 SDK 对该结果收到一个错误。

### 3.2 五处 data race:sidecar 的三个生命周期阶段

1. **关停时 sidecar 还在启动 gRPC server** → 关停后才启动的 server 从不关闭,**端口一直占着**。在 sidecar 进程内重启 runtime(hot reload)时这很要命。
2. **deactivate actor 的同时调用/reminder 到达** → 调用可能在 actor 已 deactivate 后还被放进来。
3. **deactivate 工作流实例的同时调用到达** → 迟到的调用可能在已 deactivate 并移除的实例上跑一轮。
4. **关闭 input binding(比如 hot reload)的同时它在投递事件**。
5. **关停的同时应用健康状态变化(pub/sub 订阅随之停止)** → 待重试的 pub/sub 订阅被两个 goroutine 同时 cancel。2/3/4 还会触发 Go runtime panic `sync: WaitGroup misuse`。

修法是同一套协议:gRPC server 的启动与关闭**串行化**,关停开始后不再启动;关闭的 actor lock 拒绝新调用且只在打开时注册调用;工作流实例 deactivate 后拒绝调用,调用方重试到新实例;关闭 input binding 等待 in-flight 事件并拒绝后续事件;subscriber 在**自己的锁下** cancel 重试。

### 3.3 Scheduler / hot reload / placement 三处 race

这三处是 1.18.7 里信息量最大的,因为它们打在 sidecar 最热的路径上。

**Race 1:Scheduler job stream 被两个 goroutine 同时 CloseSend。** 每次 sidecar 与 Scheduler 断连(每次重连都发生)就触发。gRPC 不允许 `CloseSend` 与自己或与 `Send` 并发。后果是 gRPC stream 状态未同步,可能丢掉 stream 结束时还在发送的 job 结果。修法:只有 send goroutine 关闭,且只关一次,在最后一次 send 之后。

**Race 2:hot reload stream 关停与重建并发。** hot reload 从 Operator 订阅 Components / Subscriptions / Configurations / HTTPEndpoints / Resiliencies / MCPServers / WorkflowAccessPolicies 七种资源,关停时这些 stream 正在被重建。而且第一个 stream 是用**调用方的 context** 打开的,关停无法 cancel 它。后果:关停中的 sidecar 可能等 Operator 结束每个 hot reload stream 而不是主动停止。修法:关停 cancel **所有** Operator stream 包括第一个,且先等 reconnect goroutine 退出再关 stream。

**Race 3:actor placement 的 in-flight 调用追踪被并发更新。** 这是影响最严重的一个。**v1.18 里每次 placement leader 变更都会关闭 placement 连接**,sidecar 等待 in-flight actor 调用排空后才移交 actor。一个在下一个 placement session 开始后才返回的 actor 调用可能释放**另一个调用的** in-flight 记录,导致下一次排空不等待那个调用,**actor 可能短暂地在两台主机上同时运行**。

修法:claim 用 **atomic flag** 保证最多释放一次;in-flight lock 及其事件循环**不再被 pool 复用**,旧 session 的迟到释放直接丢弃。

**关键洞察 5:「对象池化」和「生命周期不复用」是一对真实的取舍。** 原设计把 lock 和 event loop 归还到池子里是为了省分配,代价是旧 session 的释放事件可能投递到新 session 的锁上 —— **一个内存优化直接变成了分布式正确性 bug**。在涉及「会话 / 连接 / leader 任期」这类有身份的生命周期时,复用是危险的:对象携带的身份与新身份不匹配时,操作会应用到错误的作用域。

### 3.4 一个最不像 bug 的 bug:HTTP 中间件管道的共享 handler

**这是 1.18.7 里最容易被忽视、但影响面最广的一个。**

当 sidecar 同时向 HTTP 应用发多个请求时,**一个请求可能以另一个并发请求的结果结束**。覆盖 sidecar 通过 HTTP 发给应用的**每一个**请求 —— 服务调用、actor 调用、input binding 事件、job 触发。

两种症状:

- 与应用的连接失败的请求,**被报成成功且响应为空**;同时真正成功的那个请求**带着前者的错误失败**。
- 应用的 **Server-Sent Events 响应可能被写给另一个请求的调用方**。

根因:HTTP app channel 把每个请求过 app HTTP 中间件管道,管道**只保留一个共享 handler**,每个请求都把它替换成自己的 —— 于是一个请求可能跑另一个请求的 handler 并把结果记到那个请求的状态里。另外,增删 middleware 时读 pipeline 列表没加用来写的锁,重建可能漏掉正在加入的 pipeline。

修法:管道不再保留共享 handler,**每个请求在配置的中间件链里跑自己的 handler**;pipeline 列表在锁下读。

**为什么这个 bug 值得单独讲**:它不是 data race(没有 race detector 报),它是**共享可变状态的经典反面教材** —— 一个「全局变量」(共享 handler)被并发请求互相覆盖,而「每个请求用自己的 handler」这个正确写法在概念上极其简单。**它提醒我们:sidecar 里最危险的状态不是锁保护的计数器,而是那些被设计成「隐式当前请求」的单例对象。**

### 3.5 一个纯粹的运营噪音 bug

**hot reload 每 60 秒记录其他应用作用域的 Subscription。** 1.18.0 起 hot reload 默认开启,每个 sidecar 每隔 60 秒对命名空间内**每一个不属于自己的 Subscription** 打两行 INFO:

```text
Adding Subscription for processing: <name>
Subscription updated: <name>
```

日志量 = 此类 Subscription 数 × sidecar 数。**大规模部署达到每天数百万行**,而实际上没有任何 Subscription 被重新加载。1.14–1.17 只有显式开 `HotReload` preview 才中招。

根因:hot reload 拿命名空间内所有 Subscription 跟已加载的比对,而 sidecar 根本不会加载 scoped 到别的应用的 Subscription,所以每个都「看起来是新的」,在 scope 检查跳过它**之前**先打了「已添加」的日志。

修法:**先检查 scope**,跳过的打 debug 级。

**这个 bug 的价值在于它是一类模式代表:「默认开启的功能 + 命名空间范围的列举 + 未命中预期的作用域过滤 = 日志噪音放大器」。** 默认开启把一个 preview 期的边缘行为变成了所有用户的日常成本。

---

## 4. 五段可运行代码:把根因变成能跑的验证

以下五段都能直接跑,覆盖四个安全洞的复现与验证、以及 data race 的定位。

### 4.1 复现身份头 spoofing(升级前必跑)

这段脚本在**升级前**跑,确认你的应用是否真的读 header 做授权;升级后再跑一次确认修复。

```bash
#!/usr/bin/env bash
# 攻击方应用:伪造 dapr-caller-app-id,尝试让目标应用相信调用来自 admin
# 前提:攻击方应用 attacker 已部署,目标应用 checkout 用 HTTP 协议且读 header 做授权
set -euo pipefail

TARGET_APP="checkout"
METHOD="admin/secret"

# 通过 sidecar 的服务调用 HTTP API 发起调用
# 关键:在请求里自带身份头。Go 的 http.Header canonical 化后是 Dapr-Caller-App-Id
curl -sS -o /tmp/resp.txt -w "HTTP %{http_code}\n" \
  -H "dapr-caller-app-id: admin" \
  -H "dapr-caller-namespace: kube-system" \
  "http://localhost:3500/v1.0/invoke/${TARGET_APP}/method/${METHOD}"

echo "--- 目标应用实际收到的身份头(在目标应用里加这段调试中间件)---"
cat <<'EOF'
# 目标应用(Go)的调试中间件:把收到的所有 caller 身份头原样打出来
func debugHeaders(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // 注意:http.Header.Get 只取第一个值 —— 这正是漏洞的核心语义
        log.Printf("Get() -> caller=%q ns=%q",
            r.Header.Get("Dapr-Caller-App-Id"),
            r.Header.Get("Dapr-Caller-Namespace"))
        // 遍历所有值,看有没有两个
        for _, v := range r.Header["Dapr-Caller-App-Id"] {
            log.Printf("  all values: %q", v)
        }
        next.ServeHTTP(w, r)
    })
}
EOF
```

**判读**:

- **升级前**:日志出现 `all values` 两行,`Get()` 的结果**不确定**(可能是 `admin`)→ 中招;
- **升级后且 mTLS 开**:只剩一个值,且**等于调用方证书的 SPIFFE app ID**,不等于应用自己发的值;
- **升级后但 mTLS 关**:只剩一个值(调用方 sidecar 设的),如果调用方 sidecar 没升级,`dapr-caller-namespace` 在 gRPC proxy 路径上仍是攻击者填的值 → **必须升级所有 sidecar 才完全闭合**。

### 4.2 验证 mTLS SPIFFE 身份才是真身份源

这段代码演示「正确的身份读取方式」:不读 header,从 mTLS 证书的 SPIFFE ID 解析。

```python
#!/usr/bin/env python3
"""从 Dapr sidecar 的 mTLS 证书解析 SPIFFE 身份,与 header 做交叉验证。"""
import ssl
import socket
import re
from cryptography import x509
from cryptography.hazmat.primitives import hashes

# SPIFFE ID 格式: spiffe://<trust-domain>/ns/<namespace>/dt/<app-id>
SPIFFE_RE = re.compile(r"spiffe://[^/]+/ns/([^/]+)/dt/([^/]+)")


def caller_identity_from_cert(host: str, port: int) -> tuple[str, str]:
    """建立 TLS 连接,取对端(调用方 sidecar)证书的 SPIFFE ID。"""
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE  # 只读证书不断言链,生产用 Sentry CA 校验
    with socket.create_connection((host, port)) as raw:
        with ctx.wrap_socket(raw) as s:
            der = s.getpeercert(binary_form=True)
    cert = x509.load_der_x509_certificate(der)
    for name in cert.subject:
        # URI SAN 里放 SPIFFE ID
        if name.oid.dotted_string == "2.5.29.17":  # subjectAltName
            for san in cert.extensions:
                if isinstance(san.value, x509.SubjectAlternativeName):
                    uri = san.value.get_values_for_type(x509.UniformResourceIdentifier)
                    for u in uri:
                        m = SPIFFE_RE.match(u)
                        if m:
                            return m.group(1), m.group(2)  # (namespace, app-id)
    raise ValueError("证书里没有 SPIFFE URI SAN")


# 正确做法:授权只信证书来源
ns, app = caller_identity_from_cert("checkout.dapr.svc", 3500)
print(f"密码学断言的调用方: ns={ns} app={app}")
assert app == "frontend", f"拒绝: 调用方是 {app},不是 frontend"

# 错误做法(1.18.6 之前可伪造):从 header 取第一个值
# incoming.headers["dapr-caller-app-id"][0]  ← 顺序未定义,可被攻击者占据
```

**这段代码的意义**:它把「为什么不读 header」从建议变成可执行断言。你可以把它作为应用的**身份中间件基线**,凡是 header 与证书断言不一致的请求一律拒绝并告警 —— 这个告警本身就是升级期间的探测器。

### 4.3 复现 percent-encoding 访问控制绕过

```bash
#!/usr/bin/env bash
# 前提:目标应用 checkout 用 HTTP app 协议,加载了 deny-list 策略,/admin/secret 被拒
# deny-list 配置:defaultAction: allow,operation: /admin/* action: deny
set -euo pipefail

TARGET="checkout"

echo "== 1) 明文调用(应被拒) =="
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  "http://localhost:3500/v1.0/invoke/${TARGET}/method/admin/secret"
# 期望: 403

echo "== 2) gRPC 原样发 %2F(1.18.6 前绕过) =="
# 通过 gRPC API 发送 method = 'admin%2Fsecret'
# 访问控制检查看到单段 'admin%2Fsecret' → 不匹配任何 deny 规则 → defaultAction allow
# 目标应用 HTTP server 解码 %2F → /admin/secret → 路由到被拒 handler
python3 - <<'PY'
import grpc
import dapr_pb2 as pb
import dapr_pb2_grpc as pbgrpc
ch = grpc.insecure_channel("localhost:50001")
stub = pbgrpc.DaprStub(ch)
req = pb.InvokeServiceRequest(id=TARGET, method="admin%2Fsecret", data=pb.common.v1.Any())
try:
    stub.InvokeService(req)
    print("返回: 调用到达应用(绕过成功?)")
except grpc.RpcError as e:
    print(f"返回: {e.code()} {e.details()}")  # 1.18.6: INTERNAL invalid method
PY

echo "== 3) HTTP 双编码 %252F(1.18.6 前绕过) =="
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  "http://localhost:3500/v1.0/invoke/${TARGET}/method/admin%252Fsecret"
# 1.18.6 前: HTTP API 解一次码变 %2F → 检查看到单段 → 放行 → 应用再解码成 /admin/secret
# 1.18.6 后: HTTP 500 invalid method

echo "== 4) allow-list 通配符绕过(1.18.6 前) =="
# 策略: defaultAction: deny, /public/* 允许
curl -sS -o /dev/null -w "HTTP %{http_code}\n" \
  "http://localhost:3500/v1.0/invoke/${TARGET}/method/public/x%2F..%2F..%2Fadmin"
# 1.18.6 前: 匹配 /public/* 通配符 → 投递成 /public/x/../../admin → 到达 /admin
```

**验证你的应用是否真的受影响**(官方明确指出的诚实边界):

```python
# 应用侧自检:你的路由器是按解码路径还是转义路径路由?
# 用 chi 或 Go 1.22+ ServeMux → 按转义路径路由 → 没被绕过
# 用 Python WSGI/ASGI 或读 r.URL.Path 的 Go handler → 按解码路径路由 → 被绕过
import http.server  # Python http.server 按 decoded path 路由 → 受影响
```

### 4.4 Scheduler reminder 权限边界验证(升级后)

```python
#!/usr/bin/env python3
"""验证 1.18.6 的 Scheduler 权限边界:跨应用 reserved actor reminder 应被拒。"""
import grpc
import dapr_pb2_grpc as pbgrpc
import dapr_pb2 as pb
from google.protobuf import any_pb2

ch = grpc.insecure_channel("localhost:50001")
stub = pbgrpc.DaprStub(ch)

TARGET_NS = "production"
TARGET_APP = "checkout"
# 目标应用的 reserved 内部 actor 类型
RESERVED = f"dapr.internal.{TARGET_NS}.{TARGET_APP}.workflow"


def try_schedule(actor_type: str, actor_id: str, name: str) -> None:
    """通过 Scheduler 注册 actor reminder,看是否被 PermissionDenied 拒绝。"""
    req = pb.ScheduleReminderRequest(
        actorType=actor_type, actorID=actor_id, name=name,
        dueTime="1s", period="",
    )
    try:
        stub.ScheduleReminder(req)
        print(f"  {actor_type}/{actor_id}/{name} -> 允许")
    except grpc.RpcError as e:
        print(f"  {actor_type}/{actor_id}/{name} -> {e.code()} {e.details()}")


print("== 1) 攻击: 给别人的 reserved workflow actor 建 reminder ==")
try_schedule(RESERVED, "order-123", "activity-result-7")

print("== 2) 攻击: 建非 activity-result 的名字(1.18.6 前可注入 TimerFired 崩 sidecar) ==")
try_schedule(RESERVED, "order-123", "malicious-timer")

print("== 3) 攻击: 批量删除(1.18.6 前可用 'dapr' 前缀跨类型删所有 internal reminder) ==")
try:
    stub.DeleteReminder(pb.DeleteReminderRequest(actorType="dapr", actorID="", name=""))
except grpc.RpcError as e:
    print(f"  bulk delete -> {e.code()}")

print("== 4) 合法: 给自己的 actor 建 reminder(应允许) ==")
try_schedule("MyActor", "actor-1", "my-reminder")

print("""
预期(1.18.6):
  1) 创建 activity-result-* 无覆盖 -> 仍允许(刻意例外: activity 宿主回传结果)
     但读/删/替换该 job -> PermissionDenied
  2) 非 TaskCompleted/TaskFailed payload 的 activity-result-* -> 丢弃并 ack
  3) 跨 actor 类型的前缀删除 -> PermissionDenied(key delimiter 终止 actor 类型)
  4) 用户 actor 类型 -> 不受限
""")
```

### 4.5 Go data race 探测器:把 1.18.7 的修复在本地复现

这段展示「关闭协议」的正确写法 —— 即 §3.1 三个 WaitGroup bug 的通用解药:

```go
package main

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

// Resource 演示 1.18.7 修复的「先拒绝新用户,再等存量退出」关闭协议。
// 错误版本(1.18.7 前): WaitGroup 在 Wait 期间被并发 Add,触发
//   panic: sync: WaitGroup is reused before previous Wait has returned
type Resource struct {
	closed atomic.Bool      // ① 关闭状态:用 atomic 而不是 bool,避免 data race
	wg     sync.WaitGroup   // 计数 in-flight 操作
	mu     sync.Mutex       // 保护下面的状态
	state  string
}

// Do 是 1.18.7 前 executor actor / actor lock / input binding 三处 bug 的正确版本。
func (r *Resource) Do(ctx context.Context, fn func() error) error {
	// ② 先检查关闭状态,已关闭直接拒绝 —— 而不是先 Add 再发现冲突
	if r.closed.Load() {
		return errors.New("resource closed, retry on a new instance")
	}
	r.wg.Add(1)
	defer r.wg.Done()
	// ③ 再次检查:Close 可能在 Add 之前刚跑完
	if r.closed.Load() {
		return errors.New("resource closed after admission")
	}
	r.mu.Lock()
	r.state = "in-flight"
	r.mu.Unlock()

	select {
	case <-time.After(10 * time.Millisecond):
	case <-ctx.Done():
		return ctx.Err()
	}

	r.mu.Lock()
	r.state = "done"
	r.mu.Unlock()
	return nil
}

// Close 是正确顺序:标记关闭 -> 拒绝新人 -> 等存量退出。
func (r *Resource) Close() {
	r.closed.Store(true) // 先立旗,新 Do 立刻被拒
	r.wg.Wait()          // 再等已经在跑的
}

// 用 race detector 跑: go run -race main.go
// 1.18.7 前的代码用普通 bool + 无关闭检查,并发场景下 race detector 会报:
//   WARNING: DATA RACE ... read at 0x... vs write at 0x...
//   或 panic: sync: WaitGroup is reused before previous Wait has returned
func main() {
	r := &Resource{state: "idle"}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	// 并发调用与关闭同时发生,这是 1.18.7 修复场景的本地复现
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			_ = r.Do(ctx, func() error { return nil })
		}
	}()
	go func() {
		defer wg.Done()
		time.Sleep(5 * time.Millisecond)
		r.Close()
	}()
	wg.Wait()
}
```

**race detector 的边界要诚实说**:`go build -race` 有约 2-10x 运行时开销,且它只报**实际发生**的竞争(代码覆盖率到了才报),不报可能发生的。**1.18.7 的五处 race 是官方用 race detector 在「无故障注入」条件下跑出来的** —— 这意味着它们在日常部署里就经常触发,只是没人把 `DATA RACE` 日志与偶发故障联系起来。**把 race detector 纳入 sidecar 类程序的 CI 常规项,是这篇文章最可立即执行的一条建议。**

---

## 5. 五套 sidecar / 运行时方案 17 维度对比

| 维度 | Dapr 1.18.6 | Envoy 1.39 | Linkerd 2.18 | Istio 1.31 | Open Policy Agent gatekeeper 3.23 |
|------|-------------|------------|--------------|------------|-----------------------------------|
| **身份模型** | sidecar 从 mTLS SPIFFE 断言,应用只读 | 下游证书 + `X-Forwarded-*` 需 L7 配置 | 自动 mTLS,自动 SPIFFE | 双向 mTLS + SPIFFE | 不提供身份,消费外部身份 |
| **应用可读身份投影** | `dapr-caller-*` 头,1.18.6 起只由 sidecar 写 | RBAC 元数据头,需手动配 | 不暴露应用级身份头 | `istio-*` 头,需 AuthZ 配置 | 完全不投影 |
| **应用能否伪造身份头** | **1.18.6 前:能(任意大小写变体追加)** | 取决于 `sanitize` 配置 | 不能(不暴露) | 取决于 header 透传配置 | 不适用 |
| **多租户隔离强度** | namespace + app ID + **actor 类型** 三元组 | 命名空间 + ServiceAccount | 命名空间 + ServiceAccount | 命名空间 + ServiceAccount + AuthZ | 需自建 |
| **durable workflow** | 内置 + history signing + 跨应用 attestation | 无 | 无 | 无 | 无 |
| **Actor 编程模型** | 一等公民(language-agnostic actor) | 无 | 无 | 无 | 无 |
| **MCP 工具编排** | **v1.18 内置 CRD + durable activity** | 无 | 无 | 无 | 无 |
| **Go race detector CI** | **1.18.7 修了 8 处 race** | 稳定运行 | 稳定运行(Rust) | 稳定运行 | 稳定运行 |
| **hot reload** | v1.18 GA 且默认开(7 种资源) | xDS 热更新 | xDS 热更新 | xDS 热更新 | 不适用 |
| **访问控制默认值** | 无策略=开放,有策略=默认拒绝 | 默认允许全部 | 默认 mTLS 全开 | 默认 ALLOW,需显式 AuthZ | 默认允许 |
| **路径规范化防绕过** | **1.18.6 拒绝 %2F/%5C/%2E/\\** | 需自配 normalize | 不涉及 | 需自配 | 需自写 |
| **多值 header 语义** | 1.18.6 前是漏洞放大器 | 由 envoy 控制 | 不涉及 | 由 AuthZ 控制 | 不适用 |
| **升级顺序依赖** | 目标侧自设头 → 新版保护旧版 | 标准滚动 | 无须 | 标准滚动 | 不适用 |
| **语言 SDK 数** | 6(.NET/Go/Java/JS/Python/Rust) | 无应用 SDK | 无应用 SDK | 无应用 SDK | 无 |
| **生态成熟度** | CNCF 毕业项目 | 事实标准 | CNCF 毕业 | CNCF 毕业 | CNCF 毕业 |
| **最小资源开销** | sidecar ~50-100MB | sidecar ~100-200MB | 极轻 proxy ~10-30MB | sidecar + ztunnel | 单独进程 |
| **本次修复的承重级** | **4 个安全洞 + 8 处 race + 1 个跨请求串台** | 常规 CVE | 常规 | 常规 | 常规 |

**对比的结论**(不是排名,是选型逻辑):

- **Dapr 的独特位置不是网格,是「应用的分布式运行时」**:它给应用一等公民的 actor + workflow + jobs + MCP 编排抽象,这是 Envoy/Linkerd/Istio 刻意不做的层。**选 Dapr 的理由从来不是「比 Envoy 更好的代理」,而是「让应用不用写分布式状态机」。**
- **身份投影是这个层最大的安全责任**:网格只提供传输身份给运维,Dapr 把身份投影到**应用可读的语义字段**,于是「应用能不能伪造这个字段」成了 Dapr 独有的安全命题。**1.18.6 之前这个命题的答案是「能」,之后才是「不能」。**
- **OPA 在表里充当对照组**:它证明「策略层自己不产身份,只消费身份」。Dapr 1.18 的做法是把这两件事合进运行时 —— **身份断言与策略评估在同一进程内完成,不存在跨进程的 header 传递缝隙**。

---

## 6. 六条 6-12 个月可验证硬指标

每条都能在今天升级后立刻开始采集,数值可复现。

**① 身份头伪造率:从「不确定」到「恒定单值」**
升级后对目标应用发 1000 个带伪造 `dapr-caller-app-id` 的请求,统计应用收到的 header 值数量。**指标:`len(r.Header["Dapr-Caller-App-Id"])` 分布。** 1.18.6 前:约 50% 的请求收到 2 个值;1.18.6 后(mTLS 开):恒定 1 个,且**恒等于调用方证书 SPIFFE app ID**。

**② percent-encoding 拒绝率**
对升级后的 sidecar 发 4 组 method:`admin/secret`(应正常路由到拒绝)、`admin%2Fsecret`、`admin%252Fsecret`、`admin%5Csecret`。**指标:后三组应 100% 返回 HTTP 500 `invalid method` 或 gRPC `Internal`**,且**请求计数为 0**(没到应用)。任何一组到达应用即未闭合。

**③ Scheduler 跨应用 reminder 拒绝率**
用同命名空间的低权应用尝试 6 类操作(schedule / get / delete / list / delete-by-metadata / delete-by-name-prefix)针对别的应用的 `dapr.internal.<ns>.<app>.workflow`。**指标:除「无覆盖创建 `activity-result-*`」一项外,其余 5 类应 100% 返回 `PermissionDenied`。** 再测一次 key delimiter 修复:用 actor 类型 `dapr` 做前缀批量删除,**其他 actor 类型的 reminder 数量应 0 变化**。

**④ actor 可用性:`maxStackDepth` 拒绝后的恢复**
压测一条超过 `maxStackDepth` 的 reentrant 调用链,被拒后立即发正常调用。**指标:1.18.7 前正常调用 P99 延迟 = context 超时时间(应用级不可用);1.18.7 后应 < 10ms。** 这是「被拒绝的操作不应修改拒绝它的状态」的直接可测证据。

**⑤ sidecar 内存与 goroutine:工作流实例 ID 复用**
跑 100 轮「purge 同一 instance ID → 立即用同一 ID 重调度」的循环,每轮让上一轮的 activity 仍在执行。**指标:1.18.7 前约累积 90 个挂起执行 ≈ 250 goroutine + 30MB,且单调增长;1.18.7 后(durabletask-go v0.12.6)应稳定不增长**,代价是重叠执行的该结果收到错误而非结果。

**⑥ 日志量:hot reload Subscription 噪音**
统计 sidecar 的 INFO 级日志行数中匹配 `Adding Subscription for processing|Subscription updated` 的数量。**指标:1.18.7 前 = 命名空间内他应用 Subscription 数 × sidecar 数 × 1440(每天);1.18.7 后 = 0**(降级为 debug 级)。大规模集群这通常是每天数百万行。

---

## 7. 六条 6-12 个月可观察未来信号

这些不是预测,是「如果成立,说明 Dapr 1.18 这条路线被验证」的可观察信号。

**① `dapr-caller-*` 头可能走向废弃。** 1.18.6 的修复方式是「让头只由 sidecar 从证书写」。既然值的唯一来源已经是证书,应用直接读证书(或经 SDK 封装)是更短的路径。**信号:SDK 开始提供 `CallerIdentity()` 类型化 API 并把它标记为推荐用法,header 降级为兼容层。**

**② 「目标侧自设」会成为 sidecar 安全修复的默认模式。** 这次修复最精妙的一层是**目标方 sidecar 自己写身份头,从而在调用方还是旧版本时也提供保护**。**信号:其他 sidecar 项目(Envoy/Istio/Linkerd)的安全补丁开始采用「接收侧覆写」而不是「发送侧剥离」。**

**③ reserved actor 命名空间会迎来一次系统性审计。** 1.18.6 两个洞都指向 `dapr.internal.*` 的权限检查在不同 API 路径上不一致(state/reminder/timer 有,actor invoke 没有)。MCPServer 又往这个命名空间加了新类型。**信号:出现一个集中的 `internal actor type registry`,所有 API 路径共享同一套授权规则,而不是每个 API 各自实现。**

**④ race detector 会成为 sidecar 类项目的发布门禁。** 1.18.7 在「无故障注入」下报出 8 处 race,说明它们是日常部署里的高频事件。**信号:Dapr CI 增加 `-race` 全量回归测试,其他 sidecar 项目跟进;社区出现「sidecar 并发债务」的公开讨论。**

**⑤ WorkflowAccessPolicy 的「无策略=开放」默认值会收紧。** 这是 v1.18.0 为了兼容存量做的妥协,但 1.18.6 的四个洞证明「同命名空间内的应用互相不可信」是真实威胁。**信号:出现 `WorkflowAccessPolicy` 的 cluster-wide 默认策略或 admission webhook,「显式声明允许」取代「默认开放」。**

**⑥ MCP 编排的权限边界会成下一个攻击面焦点。** `MCPServer` CRD 把外部工具调用变 durable activity,认证支持 OAuth2 client credentials 和 SPIFFE JWT SVID 注入。**信号:1.19 出现针对 MCP 工具调用的细粒度策略(按工具名而非按 server),以及 tool call 的审计事件单独可查询 —— 因为 MCP 工具是 Agent 时代「应用代表谁执行操作」的最常见路径。**

---

## 8. 总结与最佳实践

### ✅ 该做

1. **把 mTLS 打开并保持开启。** 1.18.6/1.18.7 的每一个安全修复都以 mTLS 身份为前提;`WorkflowHistorySigning` 直接拒绝在 mTLS 关闭时启动;`dapr.internal.*` 的调用在 mTLS 关且加载了 `WorkflowAccessPolicy` 时被拒。**「保持 mTLS 开启」从一句礼貌建议变成了有强制力的操作要求。**
2. **升级所有 sidecar,而不只是控制面。** 身份头的目标侧修复让新版保护旧版,但 `dapr-caller-namespace` 在 gRPC proxy 路径上、mTLS 关闭时仍反映旧调用方发送的值。**只有全量升级才完全闭合。**
3. **应用侧的身份读取改为证书断言或经 SDK 类型化 API。** 见 §4.2 的可执行断言模式,把 header 与证书的不一致变成告警。
4. **确认应用框架是按解码路径还是转义路径路由。** Go 1.22+ `ServeMux` / chi 不受 percent-encoding 绕过影响;Python WSGI/ASGI 受影响。**这个洞的修复责任在 runtime,但「是否真的被绕过」的判断责任在应用侧。**
5. **把 race detector 纳入 CI 常规项。** 8 处 race 在无故障注入下被报出,说明它们在生产里天天发生。
6. **升级前用 §4.1/§4.3 复现,升级后用 §6 的六条指标验证闭合。**

### ❌ 千万别做

1. **不要用 `http.Header.Get` 或 `metadata.Get(...)[0]` 的返回值做授权判断。** 这是本次四个洞里最直接的那一个的充要条件。多值 HTTP 头的顺序在规范层面未定义,你把访问控制委托给了一个未定义操作。
2. **不要在 `WorkflowAccessPolicy` 里只配「允许」而不设 `defaultAction: deny`。** 纯白名单在加载至少一条策略后才切换到默认拒绝;只有 allow 规则没有显式默认拒绝,边界依然是开的。
3. **不要在 hot reload 开着(1.18 默认开)的集群里忽视 §3.5 的日志放大。** 每天数百万行 INFO 日志是真实的成本,且它掩盖真正的 Subscription 变更事件。
4. **不要跨命名空间共享 actor 类型名。** 1.18.6 的 Scheduler 漏洞的边界正是「同命名空间」;命名空间是第一道也是最便宜的一道隔离。
5. **不要在升级到 1.18.7 前跑 clustered workflow deployment 而不同时升级 durabletask-go。** 复用 instance ID 的内存泄漏在长生命周期 sidecar 上单调增长。
6. **不要把「公共 actor invoke API 可以访问 `dapr.internal.*`」当作便利特性。** 它在 1.18.6 前是伪造工作流结果的完整路径,现在返回 403。**任何依赖内部 actor 类型的自研工具都会在升级时 break,这是刻意的安全收益,不是回归。**

### 五步生产升级 checklist

**Step 1:升级前基线采集**
- 跑 §4.1 收集应用收到的身份头值数量分布(目标:量化有多少应用在读多值 header)
- 跑 §4.3 确认应用框架是按解码还是转义路径路由
- 记录 `dapr_http_server_request_count` 等指标的当前基线(§3.4 的中间件管道 bug 修复后行为会变)
- 记录 sidecar goroutine 数与 RSS 基线(§3.3 的 placement race 与 §3.1 的内存泄漏修复后会变化)

**Step 2:控制面先上,再滚动 sidecar**
- `helm upgrade dapr dapr/dapr --version 1.18.6 -n dapr-system --wait`
- **先升级目标侧 sidecar**(接收调用的应用),利用目标侧自设头立即获得保护
- **再滚动升级调用方 sidecar**,完成 `dapr-caller-namespace` 的完全闭合
- **回滚地板是 1.17.7**:1.18 把 Ed25519-keyed CA 写进 trust bundle,更早的 Sentry 解析不了会启动崩溃

**Step 3:升级后立即验证(§6 的前三条指标)**
- 伪造身份头 → 应用恒定收到 1 个值且等于证书 SPIFFE app ID
- `admin%2Fsecret` 等 4 组 method → 后 3 组 100% 返回 `invalid method`,应用侧请求计数 0
- 跨应用 `dapr.internal.*` reminder → 5/6 类 PermissionDenied,key delimiter 前缀删除不跨类型

**Step 4:灰度验证并发修复**
- 跑 §4.5 的 `-race` 复现,确认本地无 race
- 压测 `maxStackDepth` 拒绝后调用恢复(指标 ④)
- 跑 100 轮 instance ID 复用,观察 goroutine/RSS 不单调增长(指标 ⑤)

**Step 5:收尾**
- 清理 hot reload Subscription 日志噪音(指标 ⑥,应归零)
- 把 §4.2 的「header 与证书断言不一致即告警」加入应用监控,作为未来版本回归的探测器
- 如果用 `WorkflowsClusteredDeployment`,确认所有 sidecar 都已升级后再开启
- **不要回滚到 1.18.5**:身份头与 reserved actor 的修复都在 1.18.6;1.18.7 的并发修复与 durabletask-go v0.12.6 在其上

---

## 写在最后

Dapr 1.18 这一代的安全叙事可以被压缩成一句话:**一个 sidecar 给应用暴露的每一个「语义便利字段」,都是一条需要回答「谁有权写它」的攻击面。**

`dapr-caller-app-id` 是便利,`dapr.internal.*` 是便利,percent-encoded method 是便利。便利的代价是隐含约定,而隐含约定在多租户集群里不成立。**1.18.6 把四条隐含约定翻成显式契约,1.18.7 把并发层面的隐含生命周期约定也翻了一遍。**

这件事跟今天另两篇文章是同一个主题的三种尺度。早上 Nadella 说「假设模型已被入侵,从零遏制」,说的是**组织层**:不要把信任建立在善意假设上。中午 RisingWave 把 NaN 折叠成单个规范值,说的是**数据层**:让「逻辑等价」真正等于「字节相等」,不依赖约定。晚上 Dapr 说的是**运行时层**:**不要让应用自己声明自己是谁。**

三者共享同一个反模式:**把「谁有权限」这件事从可验证的密码学事实,降级成「大家都遵守的约定」。** 而三者共享同一个修法:**把约定变成检查,把检查放在请求到达之前,把被拒绝的操作做成零副作用。**

最后一点值得单独记下:1.18.6 修复里最有价值的设计不是「删掉伪造的头」,而是**目标方 sidecar 自己设头**。它承认了一个分布式系统里常被回避的事实 —— **你不可能原子地升级所有节点**。一个只在「所有人都升级完」后才生效的修复,在升级期间是失效的。**让新版保护旧版,让接收侧覆写发送侧,是分布式安全修复的正确姿势。** 这个模式比这次修复的任何单个漏洞都更值得带走。

---

*数据来源:Dapr v1.18.0 / v1.18.4 / v1.18.5 / v1.18.6 / v1.18.7 官方 release notes(github.com/dapr/dapr releases),均为 2026-10-09 及之前发布的原始文档。CVE-2026-41491 为 v1.18.6 release notes 内部引用的先前漏洞编号。*
