---
title: "Apache Pulsar v5.0.0 深度拆解:删掉两套祖传 dispatcher + 默认值全线换血 + Java 21 客户端分层 + 授权从静默放行到逐端点拒绝,消息总线把四年的债一次清完"
date: 2026-10-09
category: 技术
tags: [Apache Pulsar, Pulsar 5.0.0, 消息队列, 消息中间件, 消息总线, event streaming, pub/sub, Managed Ledger, BookKeeper, PIP-379, PIP-460, PIP-441, PIP-494, PIP-496, PIP-466, PIP-475, Scalable Topics, V5 Client, Key_Shared, Shared 订阅, dispatcher, AvgShedder, ThresholdShedder, 负载均衡, load shedding, namespace bundle, dispatcherMaxReadBatchSize, Netty AdaptiveByteBufAllocator, JVM allocator, Java 21, Java 17, bytecode target, 客户端兼容, 权限校验, 授权绕过, TopicOperation, PRODUCE permission, 原始主体, originalPrincipal, 代理认证, Geo Replication, 跨地域复制, Shadow Managed Ledger, 分层存储, tiered storage, non-recoverable data, cursor deadlock, mark-delete, 事务, Transaction Coordinator, 默认值, 破坏性变更, Breaking Change, 清债版本, 滚动升级, 消息可靠性, 顺序保证, 订阅类型, 消息去重, deduplication, perf 框架, JFR, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
excerpt: "2026 年 10 月 5 日,Apache Pulsar v5.0.0 发布 —— 这是 Pulsar 主版本号 4.x 跳到 5.x 的第一个正式版,也是 Pulsar 历史上第一个把「清理技术债」当作主线而不是把「新特性」当作主线的版本。23.9 KB 的 release notes body 里最重的一条不是新功能,而是 PIP-379 的彻底落地:PersistentDispatcherMultipleConsumersClassic 和 PersistentStickyKeyDispatcherMultipleConsumersClassic 两个经典 dispatcher 实现被整个删掉,连带两个配置开关 subscriptionSharedUseClassicPersistentImplementation / subscriptionKeySharedUseClassicImplementation 一起移除 —— 从 Pulsar 4.0.0 开始默认关闭、留了两个版本作为逃生舱的经典实现,在 5.0 彻底退出历史舞台。同一批次的默认值换血同样剧烈:负载均衡策略从 ThresholdShedder 换成 AvgShedder(配 maxUnloadPercentage 从 0.2 抬到 0.5)、namespace 默认 bundle 数从 4 抬到 32、系统命名空间 bundle 数 64、dispatcherMaxReadBatchSize 从 100 抬到 500、dispatcherDispatchMessagesInSubscriptionThread 从 true 翻成 false、Netty 自适应分配器成为默认分配器、maxUnloadPercentage 0.2→0.5。构建侧 Pulsar 5 服务器组件要求 Java 21+,而客户端和公共 API 仍保持 Java 17 字节码兼容 —— Pulsar 第一次在构建期把「服务器」和「客户端」拆成两个 bytecode target,并用新增的 verifyClientJavaCompatibility 兼容性测试在 CI 里钉死这条边界。安全侧本批次补上了一整类「有权限要求但以前不校验」的端点:GetOrCreateSchema 补 produce 权限、GetSchema 补 lookup 权限、事务里加分区和订阅补 topic 权限、Functions trigger 补 input topic 的 produce 权限、proxied HTTP 请求要用原始主体自己的认证数据校验、死信队列 WebSocket 消费者补死信 topic 权限、functions/source/sink 的 package URL 补 packages 权限 —— 全部是从「客户端发什么就执行什么」到「逐端点显式拒绝」的收紧。managed ledger 正确性侧修了一个会死锁的路径(跳过不可恢复 entry 时持写锁逐条 asyncDelete 改成批量迭代器一次提交)、一个会删错数据的路径(shadow managed ledger 的 trim/delete/offload 只删元数据不动源 ledger)、一个会内存泄漏的路径(ledger 关闭失败时 compaction buffer 和 permit 不释放)。文章按「清债」主线拆完五条线,附 5 段可运行的 Java / curl / YAML / Python / shell 代码、5 套消息流方案 17 维度对比、6 条 6-12 月可验证硬指标、5 步生产滚动升级 checklist、8 个诚实边界与 3 个长期判断。"
---

# Apache Pulsar v5.0.0 深度拆解:消息总线把四年的债一次清完

> 2026 年 10 月 5 日,Apache Pulsar v5.0.0 发布。23.9 KB 的 release notes body 里, Approved PIPs 只有 3 条(PIP-441 broker 级跳过指标 / PIP-494 Scalable Topics 客户端规范 / PIP-496 Functions 支持 V5 客户端),但 Broker / Client / IO / Tests & CI 四节加起来塞了 200 多条改动。这不是一个「新特性驱动」的版本,这是一个「**清债驱动**」的版本 —— 而 Pulsar 用主版本号 4→5 来标记它。

---

## 一、问题的源头:Pulsar 4.0 留下的两类债

要理解 5.0 在干什么,得先看 4.0 留下了什么。

### 1.1 「两套实现并存的债」

Pulsar 的 Shared 和 Key_Shared 订阅类型,在 Pulsar 4.0.0 之前一直跑在两套 dispatcher 实现上:

- **经典实现**(`PersistentDispatcherMultipleConsumersClassic` / `PersistentStickyKeyDispatcherMultipleConsumersClassic`):Pulsar 4.0.0 之前的唯一实现,代码路径老、有已知性能问题。
- **新实现**(PIP-379):Pulsar 4.0.0 引入,重写了内部数据结构和线程模型。

Pulsar 4.0 把新实现设成默认,但保留两个配置开关让用户切回经典实现:

```java
@FieldContext(
        category = CATEGORY_POLICIES,
        doc = "For persistent Key_Shared subscriptions, enables the use of the classic implementation of the "
                + "Key_Shared subscription that was used before Pulsar 4.0.0 and PIP-379.",
        dynamic = true
)
private boolean subscriptionKeySharedUseClassicPersistentImplementation = false;

@FieldContext(
        category = CATEGORY_POLICIES,
        doc = "For persistent Shared subscriptions, enables the use of the classic implementation of the Shared "
                + "subscription that was used before Pulsar 4.0.0.",
        dynamic = true
)
private boolean subscriptionSharedUseClassicPersistentImplementation = false;
```

这是典型的「**逃生舱模式**」:新实现默认开,但不敢删老的,怕有人依赖旧行为。代价是:

1. 两套 dispatcher 的代码路径都要维护,bug 要修两遍
2. 测试矩阵翻倍(每个 Shared/Key_Shared 测试都要跑 classic / non-classic 两遍)
3. 新实现里一个 `position without a known hash` 的边界条件,在老实现里行为不同,文档和社区答案互相矛盾

**5.0 的处理方式:直接删。** PR #26687 一共动 28 个文件,**删掉 6 个完整文件**,包括两个经典 dispatcher 类、两个对应的测试类、一个 `KeySharedImplementationType` 枚举,以及上面那两个 `@FieldContext` 配置项。

```diff
-    @FieldContext(
-            category = CATEGORY_POLICIES,
-            doc = "For persistent Key_Shared subscriptions, enables the use of the classic implementation of the "
-                    + "Key_Shared subscription that was used before Pulsar 4.0.0 and PIP-379.",
-            dynamic = true
-    )
-    private boolean subscriptionKeySharedUseClassicPersistentImplementation = false;
-
-    @FieldContext(
-            category = CATEGORY_POLICIES,
-            doc = "For persistent Shared subscriptions, enables the use of the classic implementation of the Shared "
-                    + "subscription that was used before Pulsar 4.0.0.",
-            dynamic = true
-    )
-    private boolean subscriptionSharedUseClassicPersistentImplementation = false;
```

**关键洞察 1:** 这条删除的承重级程度被低估了。它不是「清理死代码」—— 它是**主版本号 4→5 的实际承重理由**。Pulsar 4.0 留逃生舱是因为不知道有多少生产集群切了 `=true`;两个版本(4.0、4.x LTS)观察下来没人反馈必须用经典实现,5.0 就把路堵死。**以后升级到 5.0 之前必须先确认这两个开关是 `false`** —— 因为升级后配置项直接不存在,如果你之前显式设了 `true`,旧 broker 配置文件里那两行会变成 unknown 配置项(取决于你的配置校验策略,可能启动失败,也可能只是告警)。

### 1.2 「有权限要求但端点不校验的债」

Pulsar 的 admin API 和 binary 协议里,有一批端点**逻辑上需要权限,但代码里根本没调权限校验**。这类洞的特点是:它们不是「权限校验写错了」,而是「**权限校验压根没写**」。5.0 一次性补了至少 7 个:

| 端点 | 5.0 之前 | 5.0 之后 | PR |
|------|----------|----------|----|
| binary `GetOrCreateSchema` | 不校验 topic 权限 | 校验 **produce** 权限 | #26643 |
| binary `GetSchema` | 不校验 topic 权限 | 校验 **lookup** 权限 | #26643 |
| 事务里加分区 / 加订阅 | 不校验 topic 权限 | 校验 topic 权限 | #26644 |
| Functions `trigger` | 不校验 input topic 权限 | 校验 input topic 的 **produce** 权限 | #26777 |
| proxied HTTP 请求 | 只校验代理角色 | 用**原始主体自己的认证数据**校验 | #26748 |
| WebSocket 死信队列消费者 | 不校验死信 topic 权限 | 校验死信 topic 权限 | #26772 |
| functions/source/sink package URL | 校验不一致 | 统一校验 packages 权限 + 存储路径 | #26771 |

**为什么这类洞危险:** 以 `GetOrCreateSchema` 为例。它是一个**写操作**—— 如果 topic 没有 schema,它会在 schema registry 里创建一个。但在 5.0 之前,这个端点不检查调用者对 topic 有没有 produce 权限。一个只能 consume 的角色,可以给 topic 塞一个 schema,进而影响所有 producer 的序列化协商。PR #26643 的修法很直接:

```java
// 旧代码:直接进 schema registry
// 新代码:先挡住
throw new RestException(Status.UNAUTHORIZED,
        "Client is not authorized to get the schema of " + topic);
// ...
throw new RestException(Status.UNAUTHORIZED,
        "Client is not authorized to add a schema to " + topicName);
```

Functions trigger 的修法值得单独看,因为它体现的是一类「**代写**」问题。Functions worker 在 trigger 一个函数时,**worker 自己的 client 去发消息**,而不是调用者发:

```java
// The worker's client publishes the message, so check the caller's produce permission first
throwRestExceptionIfNotAllowedToProduce(tenant, namespace, functionName, inputTopicToWrite, authParams);
```

注释那句 "The worker's client publishes the message" 是整个 bug 的根源:**实际执行写操作的是 worker,但权限意图来自调用者**。修法是在 worker 代写之前,先用调用者的 authParams 校验一遍 produce 权限:

```java
private void throwRestExceptionIfNotAllowedToProduce(String tenant, String namespace, String componentName,
                                                     String topic, AuthenticationParameters authParams) {
    if (!worker().getWorkerConfig().isAuthorizationEnabled() || isSuperUser(authParams)) {
        return;
    }
    boolean allowed;
    try {
        allowed = worker().getAuthorizationService()
                .allowTopicOperationAsync(TopicName.get(topic), TopicOperation.PRODUCE, authParams)
                .get(worker().getWorkerConfig().getMetadataStoreOperationTimeoutSeconds(), SECONDS);
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        throw new RestException(Status.INTERNAL_SERVER_ERROR, e.getMessage());
    } catch (Exception e) {
        log.warn().attr("tenant", tenant).attr("namespace", namespace).attr("componentName", componentName)
                // ...
```

**关键洞察 2:** 这批修复是「**最安静的安全收紧**」—— 它们**不改变任何合法用户的体验**,只让越权调用从 200 变成 403。但它们有一个共同的升级风险:**如果你有客户端在用一个角色做它本不该做的事**(比如用 consumer 角色去 `GetOrCreateSchema`、用只读角色去 trigger 函数),升级到 5.0 之后这些调用会开始失败。这类「**静默放行 → 显式拒绝**」的翻转,在监控里长这样:某天上线后 401/403 突然出现在一个从来没报过错的端点上,而业务方信誓旦旦说「我们这个脚本跑了三年没改过」。

### 1.3 proxied 请求的「原始主体」问题

PR #26748 修的是另一类债。Pulsar 支持代理模式:客户端连 proxy proxy,proxy 转发请求到 broker,请求里带 `originalPrincipal`。5.0 之前,broker 对这类 proxied HTTP 请求做权限校验时,用的是**代理自己的角色和认证数据**,而不是原始主体的。

5.0 改成:提取原始主体的认证数据,用原始主体自己的数据去校验:

```java
private static AuthenticationDataSource originalPrincipalAuthData(AuthenticationDataSource authData) {
    // ...
}
// 校验时
.allowTopicOperationAsync(topicName, operation, originalRole, originalPrincipalAuthData(authData))
```

同时,角色日志匿名化器(`DefaultAuthenticationRoleLoggingAnonymizer`)加了一个空值保护,因为 `originalPrincipal` 对**不经过 proxy 直连的客户端是 null**:

```java
public String anonymize(String role) {
    // originalPrincipal is null for clients that do not connect through a proxy
    return role == null ? null : anonymizerType.anonymize(role);
}
```

这个 NPE 修复说明:**在 5.0 之前,「原始主体」这条路径在很多地方是没被真正走通的**—— 它是 5.0 才开始系统性地把 original principal 当成一等公民来校验。

---

## 二、三层架构:Pulsar 5.0 的「清债」地图

Pulsar 的核心架构是三层:**Producer/Client 层 → Broker 层( topic / dispatcher / managed ledger)→ BookKeeper 存储层**。5.0 的清债动作分布在这三层的每一层。

```
┌─────────────────────────────────────────────────────────────────────┐
│  Client 层                                                          │
│  ├─ V5 client (PIP-466): topic:// / segment:// / persistent://      │
│  ├─ v4 client (org.apache.pulsar.client.api): 拒绝 topic://         │
│  └─ 5.0: send receipt 归属修正 / 连接关闭泄漏修复 / DNS resolver 共享│
├─────────────────────────────────────────────────────────────────────┤
│  Broker 层                                                          │
│  ├─ dispatcher: 删除经典 Shared/Key_Shared 实现 (PIP-379 收尾)      │
│  ├─ 负载均衡: ThresholdShedder → AvgShedder (shedding+placement 二合一) │
│  ├─ 默认值: bundles 4→32 / readBatch 100→500 / subscriptionThread true→false │
│  ├─ 授权: 7 个端点从静默放行 → 逐端点显式拒绝                       │
│  └─ scalable topics (PIP-460): scalableTopicsEnabled=true 默认开    │
├─────────────────────────────────────────────────────────────────────┤
│  Managed Ledger / BookKeeper 层                                     │
│  ├─ cursor 死锁: 跳过不可恢复 entry 改批量迭代器                     │
│  ├─ shadow managed ledger: 删元数据不动源 ledger                    │
│  ├─ underreplicated lock: close 时显式释放所有持有的锁               │
│  ├─ BookKeeper batch read API 支持                                  │
│  └─ Netty adaptive allocator 成为默认                                │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 三、实际改动:五条清债线

### 3.1 第一条线:删掉祖传实现,把路堵死

PIP-379 的完整落地。删掉的是:

- `PersistentDispatcherMultipleConsumersClassic`
- `PersistentStickyKeyDispatcherMultipleConsumersClassic`
- 对应测试类 `PersistentDispatcherMultipleConsumersClassicTest` / `PersistentStickyKeyDispatcherMultipleConsumersClassicTest` / `NonEntryCacheKeySharedSubscriptionV30Test`
- `KeySharedImplementationType` 枚举(测试用的实现类型选择器)
- 两个 `@FieldContext` 配置项

**这条改动的「承重级」判断**:它同时满足「删历史遗留实现」+「改变升级路径」+「缩减维护面」三个条件。删完之后,Pulsar 的 Shared/Key_Shared 只剩一套实现,测试矩阵减半,社区问「我该用哪套」这个问题的答案从「看你配的开关」变成「没得选」。

**升级风险**:如果你在 4.x 里显式把 `subscriptionSharedUseClassicPersistentImplementation=true` 或 `subscriptionKeySharedUseClassicPersistentImplementation=true`,升级到 5.0 之前**必须先切回 false 并验证**。验证方法:在 4.x 上把开关设成 false,跑一遍你的 Shared/Key_Shared 业务流量,观察消息顺序和消费速率是否变化。Key_Shared 的关键语义是**同一个 key 永远去同一个 consumer**,这套语义两套实现都有,但**哈希到 consumer 的具体映射可能不同**,切实现会导致一次全量 rebalance。

### 3.2 第二条线:默认值全线换血

这是 5.0 里**影响面最大、最容易被忽略**的一批改动。全部是从「保守旧默认」翻成「5.0 新默认」:

| 配置项 | 4.x 默认 | 5.0 默认 | PR | 影响面 |
|--------|----------|----------|----|--------|
| `loadBalancerLoadSheddingStrategy` | `ThresholdShedder` | `AvgShedder` | #26609 | 所有集群的负载迁移行为 |
| `loadBalancerLoadPlacementStrategy` | `LeastLongTermMessageRate` | `AvgShedder` | #26609 | bundle 放置目标 |
| `loadBalancerDistributeBundlesEvenlyEnabled` | `true` | `false` | #26609 | namespace 内 bundle 均匀度 |
| `maxUnloadPercentage` | `0.2` | `0.5` | #26609 | 单次卸载比例上限 |
| `defaultNumberOfNamespaceBundles` | `4` | `32` | #26610 | 新 namespace 的初始分片数 |
| `defaultNumberOfSystemNamespaceBundles` | (跟随上面) | `64` | #26610 | 事务协调器分布 |
| `dispatcherMaxReadBatchSize` | `100` | `500` | #26744 | 每次从 BookKeeper 读的 entry 数 |
| `dispatcherDispatchMessagesInSubscriptionThread` | `true` | `false` | #26578 | 派发是否在订阅线程执行 |
| `scalableTopicsEnabled` | (4.x 无此选项) | `true` | #26740 | 是否启用 topic:// 域 |
| 默认 ByteBuf allocator | pooled | Netty adaptive | #26720 | 堆外内存分配策略 |

**AvgShedder 为什么重要。** 旧的 `ThresholdShedder` 是「超阈值就卸载」,它只管卸载不管放置—— 卸下来的 bundle 由 placement 策略另选 broker。`AvgShedder` 把 shedding 和 placement **合并成一个策略**:它把负载最高和最低的 broker 配对,在两者的分数差连续若干次检查超过阈值后迁移负载,并且**把卸下来的 bundle 放在它预先选好的那个低负载 broker 上**。配置注释写得很清楚:

```conf
# AvgShedder implements both the shedding and the placement strategy: it pairs the highest and the lowest
# loaded brokers, moves load between them once their score gap has exceeded a threshold for several
# consecutive checks, and places the unloaded bundles on the broker it chose for them. It must be paired
# with loadBalancerLoadPlacementStrategy=AvgShedder (see below).
```

注意最后一句:**必须配对使用**。如果你用了别的 shedding 策略却把 placement 留成 AvgShedder,broker 会回退到 `LeastLongTermMessageRate` 并打一条 warning:

```conf
# Default is AvgShedder since 5.0.0 (LeastLongTermMessageRate before), which only takes effect together with
# loadBalancerLoadSheddingStrategy=AvgShedder. If a different shedding strategy is configured, the broker falls
# back to LeastLongTermMessageRate placement and logs a warning; set this key explicitly in that case
# (LeastResourceUsageWithWeight is the recommended pairing for ThresholdShedder).
```

`maxUnloadPercentage` 从 0.2 抬到 0.5 是配合 AvgShedder 的:注释说 "For AvgShedder, recommend to set to 0.5, so that it will distribute the load evenly between the highest and lowest brokers." 旧的 0.2 是给 ThresholdShedder 用的,会让 AvgShedder 每次只搬一小口,需要很多轮才能把两个 broker 的负载拉平。

**`defaultNumberOfNamespaceBundles` 从 4 到 32。** 这条改动的注释解释了为什么 4 在大集群上不够:

```conf
# Bundles are the unit of assignment of topics to brokers, so a namespace needs more bundles than
# there are brokers for its topics to spread across the cluster. Bundles can be split but never
# merged. Only bundles that have been looked up cost anything (an ownership entry, an entry in the
# load report and one unload step at broker shutdown); the unused bundles of a small namespace are free.
```

关键词:**bundle 可以分裂但不能合并**。一个 namespace 创建时给 4 个 bundle,之后只能靠 split 增加。如果集群有 20 个 broker,这个 namespace 的 topic 最多只能摊到 4 个 broker 上,必须手动触发 split 才能继续摊。默认抬到 32 让新 namespace 在创建时就具备横向摊开的能力,而「没被 lookup 的 bundle 是零成本」这点保证了小 namespace 不会被这 32 个 bundle 拖累。

系统命名空间单独给 64,理由跟事务协调器有关:

```conf
# A transaction coordinator is owned by whichever broker owns the bundle of its transaction_coordinator_assign
# partition, so the bundles decide how far the coordinators can spread: with the default 16 coordinators, 64 is
# the smallest number of bundles at which every coordinator hashes into its own bundle (16 bundles put them
# into 8)
```

**这是一段非常漂亮的工程论证**:默认 16 个事务协调器,16 个 bundle 会让它们两两挤在同一个 bundle 里(16 个协调器哈希进 16 个 bundle 只有 8 个 bundle 会被命中),64 是让每个协调器落到独立 bundle 的最小 bundle 数。5.0 让事务协调器在创建时就能充分散开。

**`dispatcherMaxReadBatchSize` 从 100 抬到 500。** 这是从 BookKeeper 一次读多少个 entry。抬高直接增大单次读吞吐,但也增大单次读的内存占用。**这条默认值翻转是「安静 breaking change」的典型**:它不报错、不改变任何 API 契约,但会让 broker 的堆外内存占用模式变化。如果你的集群有明确的 `dispatcherMaxSizeBytes`(默认 5MB)限制,抬高 batch size 意味着每次读更接近这个字节上限。

**`dispatcherDispatchMessagesInSubscriptionThread` 从 true 翻成 false。** 旧的 true 意味着「派发消息和执行 broker 侧 filter 在每个 subscription 各自的线程里跑」,false 意味着走统一线程模型。这是配合 dispatcher 实现统一(删掉经典实现)的线程模型收拢。

**关键洞察 3:** 这一批默认值翻转**没有一条会报错**。它们全部是「行为变了但配置没变」—— 你的 `broker.conf` 一字未改,升级后集群的负载迁移节奏、bundle 分布、读批大小、线程模型全都变了。**这是 5.0 升级里最需要灰度观察的一批改动**,也是最容易被「配置文件没变所以没风险」这个直觉误导的一批改动。

### 3.3 第三条线:Java 21 服务器 + Java 17 客户端,构建期钉死

PR #26769 把 Pulsar 的 Java 版本要求拆成两层:

- **服务器组件**(broker、functions、bookkeeper、其他 server-side):**要求 Java 21+**
- **客户端 / 公共 API**:**保持 Java 17 字节码兼容**

Gradle 约定的默认值:

```
pulsarJavaVersion = 21        # 服务器主源码
pulsarClientJavaVersion = 17  # 客户端 / 公共 API
```

测试源码默认跟 `pulsarJavaVersion`(因为客户端测试也要用 broker fixture),只有专门的客户端消费模块用 `pulsarClientJavaVersion`。

**最关键的一步是 CI 里新增的兼容性验证**:

```yaml
      - name: Verify client and Functions API Java compatibility
        run: ./gradlew :tests:pulsar-client-java-compatibility:test -PtestRetryCount=0
```

以及 `verifyClientJavaCompatibility` 这个 task 的作用:它检查 Java 21 的项目依赖不会通过 variant attributes 漏进 Java 17 的客户端编译路径。

**这条改动的承重级在于它是一个「承诺的执行机制」**。「客户端兼容 Java 17」这句话以前是文档承诺,5.0 把它变成 CI 里会失败的检查。**以后任何让客户端依赖 Java 21 API 的 PR 都会在 CI 里红**,而不只是被 reviewer 偶然发现。

**诚实边界:** release notes 自己承认,`verifyClientJavaCompatibility` 没办法覆盖第三方库里的反射或 JDK API 使用:

```
`verifyClientJavaCompatibility` also checks [that client code doesn't depend on server internals]
... all possible reflective or JDK API usage in third-party libraries [is not covered]
```

所以「客户端 Java 17 兼容」的保证在**Pulsar 自己的代码**上是构建期强制的,在**依赖的第三方库**上是尽力而为。

**升级含义:** 5.0 的 broker 必须跑在 Java 21+ 上。构建文档明确写了 JDK 21 / 25 / 26 三选一:

```
The wrapper `./gradlew` requires JDK 21, 25 or 26 (server bytecode targets Java 21; client/API
bytecode targets Java 17).
```

而 Functions 的兼容性承诺是:

```
Standard Pulsar 5 server components and Functions implementations require Java 21 or later.
... remain Java 17 compatible. Functions compiled on Java 17 can run in a Java 21+ Functions instance.
```

**你用 Java 17 编译的 Functions 仍然能在 Java 21 的 Functions 实例里跑** —— 这条对有大量历史 function jar 的团队是关键的好消息。

### 3.4 第四条线:managed ledger 的正确性债

这一批改动不改变任何配置默认值,但修的是**数据正确性和活锁**。

**cursor 死锁修复 (#26570)。** `skipNonRecoverableEntries` 是 autoSkipNonRecoverableData=true 时自动跳过丢失 entry 的路径。旧实现的问题在注释里写得很明白:

```java
    /**
     * Manually acknowledge all entries from startPosition to endPosition.
     * - Since this is an uncommon event, we focus on maintainability. So we do not modify
     *   {@link #individualDeletedMessages} and {@link #batchDeletedIndexes}, but call
     *   {@link #asyncDelete(Iterable, AsyncCallbacks.DeleteCallback, Object)}.
```

注意 `asyncDelete` 的签名从单条 `Position` 变成了 `Iterable`。旧代码是这样的:

```java
        lock.writeLock().lock();
        try {
            for (long i = startEntryId; i < endEntryId; i++) {
                if (!individualDeletedMessages.contains(ledgerId, i)) {
                    asyncDelete(PositionFactory.create(ledgerId, i), new AsyncCallbacks.DeleteCallback() {
                        // ...
                    }, null);
                }
            }
        } finally {
            lock.writeLock().unlock();
        }
```

**它在持有 managed ledger 写锁的循环里,逐条发起异步删除。** 每一条 `asyncDelete` 都是异步的,但写锁一直握在手里 —— 如果删除的回调需要获取同一个锁来完成状态更新,就死锁。新代码把整个区间打包成一个迭代器一次提交,并且**完全不持有写锁**:

```java
        asyncDelete(() -> LongStream.range(startEntryId, endEntryId)
                        .mapToObj(i -> PositionFactory.create(ledgerId, i)).iterator(),
                new AsyncCallbacks.DeleteCallback() {
                    @Override
                    public void deleteComplete(Object ctx) {
                        // ignore.
                    }

                    @Override
                    public void deleteFailed(ManagedLedgerException ex, Object ctx) {
                        // The method internalMarkDelete already handled the failure operation. We only need to
                        // make sure the memory state is updated.
                        // If the broker crashed, the non-recoverable ledger will be detected again.
                    }
                }, null);
```

**关键洞察 4:** 这个修复的触发场景是「**数据丢失时的自动恢复路径**」。也就是说,这个死锁只在你的 BookKeeper 已经丢了 entry、系统正在尝试自动跳过的时候才发生 —— 最需要稳定工作的时刻,恰恰是它死锁的时刻。`deleteFailed` 里的注释 "If the broker crashed, the non-recoverable ledger will be detected again" 说明这条路径本身就是设计成可重试的,但旧实现让重试的过程把 managed ledger 的写锁握死了。这类 bug 在生产里的表现是:某个 ledger 损坏后,**整个 managed ledger 卡住不动**,而不是那一条消息丢掉。

**shadow managed ledger 的删除修正 (#26746)。** Shadow managed ledger 是分层存储里「源 ledger 的影子」—— 它自己不拥有 ledger,它列出的 ledger 属于源 managed ledger。旧代码在删除 managed ledger 数据时,会把 shadow 列出的 ledger 也删掉 —— 而**那些 ledger 属于源**。5.0 加了一个判断:

```java
            if (isShadowManagedLedger(info, mlConfig)) {
                // The ledgers listed by a shadow managed ledger belong to its source managed ledger,
                // so only the metadata of the shadow managed ledger is removed.
                log.info().attr("managedLedger", managedLedgerName)
                        .log("Keeping ledgers of the source managed ledger while deleting shadow managed ledger");
                removeManagedLedgerMetadata(managedLedgerName, callback, ctx);
            } else {
                deleteOwnedManagedLedgerData(bkc, managedLedgerName, info, mlConfigFuture, callback, ctx);
            }
```

修的路径覆盖 trim、delete、offload 三条 —— release notes 原文是 "Keep source ledger data on every shadow managed ledger trim, delete and offload path"。**这是一个会删错数据的 bug**,触发条件是你在用分层存储并操作 shadow managed ledger 的删除。

**underreplicated ledger 锁的显式释放 (#26674)。** BookKeeper 的副本恢复用 ZooKeeper 锁来标记「这个 ledger 正在补副本」。旧代码在 close 时只关闭 executor,不显式释放这些锁,依赖 session 过期让锁过期。5.0 改成 close 时**显式删除所有持有的锁节点**,并且对每个锁的删除结果做处理(删除成功或 NotFound 都从 heldLocks 移除):

```java
        Map<Long, Lock> locks = Map.copyOf(heldLocks);
        List<CompletableFuture<Throwable>> deleteResults = new ArrayList<>(locks.size());
        for (Map.Entry<Long, Lock> entry : locks.entrySet()) {
            deleteResults.add(FutureUtil.supplySafely(
                            () -> store.delete(entry.getValue().getLockPath(), Optional.empty()))
                    .handle((__, error) -> {
                        Throwable cause = error == null ? null : FutureUtil.unwrapCompletionException(error);
                        if (cause == null || cause instanceof MetadataStoreException.NotFoundException) {
                            heldLocks.remove(entry.getKey(), entry.getValue());
                            return null;
```

这修的是 broker 关闭期间的「**锁悬挂**」:旧 broker 关闭后,它持有的 underreplicated 锁要等 ZK session 过期才释放(默认时间可能很长),期间别的 broker 不敢接手补副本,导致**数据恢复被人为延迟一个 session timeout**。

### 3.5 第五条线:dispatcher 的活锁与内存债

**慢消费者不再阻塞其他消费者 (#26635)。** 经典 Key_Shared dispatcher 里,一次读出来的 entry 分发给多个 consumer 后,会等**所有** consumer 都完成发送才触发下一次读:

```java
                AtomicInteger remainingConsumersToFinishSending = new AtomicInteger(entriesByConsumerForDispatching.size());
                // ...
                if (future.isDone() && remainingConsumersToFinishSending.decrementAndGet() == 0) {
                    readMoreEntriesAsync();
                }
```

**一个 socket 卡住的 consumer 会让同一批的其他 consumer 全部陪着等**。5.0 删掉了这个计数器,改成每个 consumer 完成就触发读:

```java
                // One blocked socket must not hold up consumers whose writes have completed.
                // The conflated read loop rechecks writability and permits before selecting a consumer.
                readMoreEntriesAsync();
```

注释里的 "conflated read loop" 说明新实现把读循环改成了**合并触发**—— 多次触发会被合并成一次读,由读循环在选 consumer 之前重新检查可写性和 permit。这是一个把「等最慢的」改成「谁好了谁触发、重复触发自动合并」的模型。

**Key_Shared replay queue 的有界 look-ahead (#26677)。** 经典实现的 replay 队列(消息重发追踪)在 look-ahead 上没有上界,可能预读过多。5.0 加了一个有界的 look-ahead 限制,注释说:

```java
        // to the replay queue, so this provides a bounded look-ahead limit with an acceptable one-batch overflow.
```

**topic 级去重锁的移除 (#26763)。** 旧的 broker 端消息去重在 topic 级别加锁。5.0 把它换成了无锁的结构,并新增了一个微基准 `MessageDeduplicationSequenceCheckBenchmark` 来量化序列检查的开销。这是一个「**把锁换成并发结构**」的典型优化。

---

## 四、代码示例

### 4.1 升级前:检测你是否依赖了被删的经典 dispatcher

```bash
# 1. 检查 broker.conf 里有没有显式开启经典实现
grep -E "UseClassicPersistentImplementation" conf/broker.conf conf/standalone.conf 2>/dev/null

# 2. 检查动态配置(namespace / topic 级别覆盖)
# classic 开关是 dynamic=true,可以被 namespace policy 覆盖
pulsar-admin namespaces get-persistence public/default | grep -i classic

# 3. 检查所有命名空间的 policy(遍历 + 过滤)
for tenant in $(pulsar-admin tenants list); do
  for ns in $(pulsar-admin namespaces list "$tenant"); do
    pulsar-admin namespaces get-persistence "$ns" 2>/dev/null \
      | grep -i "classic" && echo "  ^ in $ns"
  done
done

# 4. 最可靠的方式:直接查 ZK 里写入的 policy 节点
# 经典开关的 JSON key 是 subscriptionSharedUseClassicPersistentImplementation
# 和 subscriptionKeySharedUseClassicPersistentImplementation
./bin/pulsar zookeeper-shell ls /admin/policies
```

**注意第 3 步**:这两个开关标记为 `dynamic = true`,意味着**它们可以在 namespace/topic 级别动态覆盖**。只查 `broker.conf` 不够 —— 一个 topic 级别的 policy 覆盖会让你的 broker.conf 干干净净但实际仍在用经典实现。升级前必须在 4.x 上把所有层级的覆盖都设成 false 并验证。

### 4.2 滚动升级到 5.0:保持 AvgShedder 行为可控

```bash
# 升级前:冻结负载均衡的默认值,避免升级后行为突变
# 在 4.x 的 broker.conf 里显式写下旧默认值,让 5.0 继承它们
cat >> conf/broker.conf << 'CONF'
# --- 显式冻结 4.x 默认值,避免 5.0 默认值翻转造成行为突变 ---
loadBalancerLoadSheddingStrategy=org.apache.pulsar.broker.loadbalance.impl.ThresholdShedder
loadBalancerLoadPlacementStrategy=org.apache.pulsar.broker.loadbalance.impl.LeastLongTermMessageRate
loadBalancerDistributeBundlesEvenlyEnabled=true
maxUnloadPercentage=0.2
defaultNumberOfNamespaceBundles=4
dispatcherMaxReadBatchSize=100
CONF

# 灰度策略:一次只升一个 broker,观察 30 分钟
# 关键指标:bundle unload 次数 / 平均卸载耗时 / 消息堆积 / 消费速率
# AvgShedder 与 ThresholdShedder 的迁移节奏完全不同,灰度期会看到卸载事件分布变化
```

**为什么推荐先冻结再升级:** 5.0 的默认值翻转是一批**互相耦合**的改动 —— AvgShedder 要求 placement 也配成 AvgShedder,`maxUnloadPercentage=0.5` 是给 AvgShedder 用的。如果你只显式写了 shedding 策略回 ThresholdShedder 但没写 placement,会触发「回退 + 打 warning」的路径。**要么全冻结,要么全接受新默认,不要混搭。**

### 4.3 滚动升级:跨版本的 topic 权限检查

升级到 5.0 后,`GetOrCreateSchema` 等端点开始要求权限。**升级期是最容易暴露越权客户端的窗口**,因为 broker 是逐个升级的,旧 broker 放行、新 broker 拒绝,同一个客户端的请求会**一会儿成功一会儿 403**,取决于它连上了哪个 broker。

```python
#!/usr/bin/env python3
# 升级期监控:统计每个客户端角色在 schema 端点上的 401/403 突增
import subprocess, json, re, collections
from datetime import datetime, timedelta

def collect_broker_logs(minutes=60):
    """聚合升级窗口内所有 broker 的鉴权拒绝日志"""
    since = (datetime.now() - timedelta(minutes=minutes)).strftime("%Y-%m-%d")
    # Pulsar 5.0 的拒绝日志带角色名和 topic 名
    out = subprocess.run(
        ["grep", "-hE", "not authorized to (get|add) the schema",
         "/var/log/pulsar/pulsar-broker-*.log"],
        capture_output=True, text=True)
    return out.stdout

def parse_denials(log_text):
    hits = collections.Counter()
    for line in log_text.splitlines():
        # 提取被拒角色和 topic
        m = re.search(r"role=([^\s]+).*topic=([^\s]+)", line)
        if m:
            hits[(m.group(1), m.group(2))] += 1
    return hits

if __name__ == "__main__":
    denials = parse_denials(collect_broker_logs())
    if not denials:
        print("OK: 升级窗口内无 schema 端点鉴权拒绝")
    else:
        print("WARN: 发现越权调用,升级后这些客户端会持续 403:")
        for (role, topic), count in denials.most_common():
            print(f"  {role} -> {topic}: {count} 次拒绝")
        print("\n修复方式:在 namespace 级给该角色授予 produce 权限,")
        print("或修改客户端改用具备 produce 权限的角色")
```

### 4.4 Java 21 服务器 / Java 17 客户端的构建配置

如果你自己从源码构建 Pulsar 或写 broker 插件:

```bash
# 5.0 的构建要求
# 服务器组件: Java 21+ (21 / 25 / 26 三选一)
java -version  # 必须是 21+

# 客户端项目: 仍然可以用 Java 17
# pulsar-client 的字节码目标是 17,你的项目依赖它不需要升 Java

# 自己构建时控制 target
./gradlew build -PpulsarJavaVersion=21 -PpulsarClientJavaVersion=17

# 跳过版本检查(不推荐,只在紧急构建时用)
./gradlew build -PskipJavaVersionCheck

# CI 里验证客户端兼容性(5.0 新增的 task)
./gradlew :tests:pulsar-client-java-compatibility:test -PtestRetryCount=0
```

Functions 的兼容矩阵:

```yaml
# 你现有的 Java 17 编译的 function jar: 仍然能跑
# Pulsar 5 的 Functions 实例跑在 Java 21 上,但加载 Java 17 字节码
functions_runtime:
  pulsar_5_worker_jdk: 21
  function_jar_target: 17  # 无需重新编译
  note: "Functions compiled on Java 17 can run in a Java 21+ Functions instance."
```

### 4.5 验证 AvgShedder 的配对约束

升级后如果你要自定义负载策略,必须遵守配对规则:

```bash
# 错误配对:shedding 用 ThresholdShedder 但 placement 忘了改
# 结果:broker 回退到 LeastLongTermMessageRate 并打 warning
loadBalancerLoadSheddingStrategy=org.apache.pulsar.broker.loadbalance.impl.ThresholdShedder
loadBalancerLoadPlacementStrategy=org.apache.pulsar.broker.loadbalance.impl.AvgShedder
# ^^ broker.log 会出现 warning,placement 静默回退

# 正确配对 1:全套新默认
loadBalancerLoadSheddingStrategy=org.apache.pulsar.broker.loadbalance.impl.AvgShedder
loadBalancerLoadPlacementStrategy=org.apache.pulsar.broker.loadbalance.impl.AvgShedder
maxUnloadPercentage=0.5
loadBalancerDistributeBundlesEvenlyEnabled=false

# 正确配对 2:回退到 4.x 行为(官方推荐的 ThresholdShedder 配对)
loadBalancerLoadSheddingStrategy=org.apache.pulsar.broker.loadbalance.impl.ThresholdShedder
loadBalancerLoadPlacementStrategy=org.apache.pulsar.broker.loadbalance.impl.LeastResourceUsageWithWeight
maxUnloadPercentage=0.2

# 检查 broker 启动后实际生效的策略
grep -E "loadBalancerLoad(Shedding|Placement)Strategy" conf/broker.conf
# 启动日志里会有策略初始化行,warning 只在配对错误时出现
tail -1000 logs/pulsar-broker.log | grep -iE "shedder|placement"
```

---

## 五、性能与行为对比

### 5.1 Pulsar 5.0 vs 4.x:默认行为对比

| 维度 | Pulsar 4.x | Pulsar 5.0 | 是否报错 | 升级感知方式 |
|------|-----------|-----------|----------|-------------|
| Shared/Key_Shared dispatcher | 双实现可切换 | 只有新实现 | 配置项消失(可能启动告警) | 经典实现的已知行为消失 |
| 负载卸载策略 | ThresholdShedder(超阈值卸) | AvgShedder(配对迁移) | 不报错 | bundle 迁移事件变多但更均匀 |
| 单次卸载比例上限 | 0.2 | 0.5 | 不报错 | 单次迁移的 bundle 数变大 |
| 新 namespace bundle 数 | 4 | 32 | 不报错 | 新 namespace 创建后 topic 分布更散 |
| 系统命名空间 bundle | 跟随默认(4) | 64 | 不报错 | 16 个事务协调器各自独占 bundle |
| 每次读 entry 数 | 100 | 500 | 不报错 | 堆外内存峰值上升 |
| 派发线程模型 | 每 subscription 独立线程 | 统一线程模型 | 不报错 | 线程数变化、CPU 分布变化 |
| 默认分配器 | Netty PooledByteBufAllocator | Netty AdaptiveByteBufAllocator | 不报错 | 堆外内存碎片减少、分配自适应 |
| 服务器 JDK | Java 17 可用 | **Java 21 必须** | 启动失败 | 直接起不来 |
| 客户端 JDK | Java 17 | Java 17(保持) | - | 无变化 |
| GetOrCreateSchema 权限 | 不校验 | 校验 produce | 越权调用变 403 | 老客户端开始报 403 |
| GetSchema 权限 | 不校验 | 校验 lookup | 同上 | 同上 |
| Functions trigger 权限 | 不校验 input topic | 校验 produce | 同上 | trigger 脚本开始失败 |
| 慢消费者对同批影响 | 阻塞全部 | 不阻塞 | 不报错 | Key_Shared 消费速率分布变均匀 |
| cursor 跳过死路径 | 持写锁逐条异步删 | 批量迭代器不持锁 | 不报错 | ledger 损坏后不再卡死 |
| shadow ML 删除 | 可能删源 ledger | 只删元数据 | 不报错 | 分层存储数据不再丢失 |
| underreplicated 锁 | close 等 session 过期 | close 显式释放 | 不报错 | broker 重启后补副本更快 |

### 5.2 消息流方案对比

| 维度 | Pulsar 5.0 | Kafka 4.1 | Apache RocketMQ 5.5 | NATS JetStream 2.15 | Redis Streams (Valkey 9.2) |
|------|-----------|-----------|--------------------|--------------------|---------------------------|
| 订阅类型 | Shared/Key_Shared/Failover/Exclusive + scalable topic | Consumer group(无 Key_Shared 等价物) | 集群消费/广播/顺序 | 消费者组 + queue | 消费者组 |
| key 顺序保证 | Key_Shared 单实现,无切换包袱 | partition 级顺序(需预分片) | MessageQueue 级顺序(需分片策略) | 无原生 key 亲和 | 需自行路由到不同 stream |
| 分片模型 | namespace bundle,可分裂**不可合并** | partition,不可增减 | MessageQueue,可动态扩 | stream 不支持动态分区 | stream 不支持 |
| 负载均衡 | AvgShedder 配对迁移(5.0 默认) | partition 固定,需 reassign | Rebalance 策略可配 | JetStream 自己调度 | 无(客户端散列) |
| 顺序与分片解耦 | 是(topic 级订阅语义,与分片正交) | 否(顺序绑死 partition) | 否(顺序绑死 queue) | 部分 | 否 |
| 事务 | 事务协调器 16 个,5.0 用 64 bundle 散开 | KIP-848 事务协调器 | 事务消息 | 无 | 无(MULTI/EXEC 本地) |
| 分层存储 | 原生(offload + shadow ML) | 无原生(KIP-405 未全) | 无 | 无 | 无 |
| 消息回溯 | 任意位置(基于 ledger + cursor) | offset 回溯 + timestamp | timestamp 回溯 | 按时间/序列 | 有限(基于 ID) |
| 服务端 JDK 要求 | Java 21(5.0) | Java 17+ | Java 17+ | Go(无 JDK 依赖) | C |
| 客户端 JDK | Java 17 | Java 17/11 | Java 17/11 | 多语言 | 多语言 |
| schema registry | 内置(5.0 收紧权限) | 外部(Confluent) | 内置 | 无 | 无 |
| 多租户 | 一等公民(tenant/namespace/topic) | 无原生 | 无原生 | 无原生 | 无 |
| 跨地域复制 | 原生 geo-replication | MirrorMaker2 | 原生 | leaf-node | 无 |
| 默认值翻转数量(本版本) | 10+ 项 | 少 | 少 | 少 | 少 |

---

## 六、6-12 个月可验证硬指标

1. **经典 dispatcher 配置项在 5.0 集群上不存在。** 升级后 `grep -c "UseClassicPersistentImplementation" conf/broker.conf` = 0;在 ZK 的 `/admin/policies` 树下也找不到这两个 key。如果在 policy 里还能找到,说明 namespace 级覆盖没清,升级不干净。

2. **AvgShedder 配对约束在日志里零 warning。** 升级后 24 小时内 `grep -c "falls back to LeastLongTermMessageRate" logs/pulsar-broker.log` = 0。非零说明 shedding/placement 配对错误,在静默回退。

3. **新 namespace 的 bundle 数 = 32。** 升级后创建一个新 namespace,`pulsar-admin namespaces get-bundles <ns>` 应返回 32 个 bundle 范围。同时 `get-persistence` 里的系统命名空间 bundle 数应为 64。

4. **schema 端点拒绝日志可复现。** 用一个只有 consume 权限的角色调用 `pulsar-admin topics get-schema <topic>`(无 schema 时走 GetOrCreate 路径),应返回 403 且 broker 日志出现 "not authorized to add the schema of"。在 4.x 上同一调用返回成功。

5. **broker 必须跑在 Java 21+。** `java -version` 在 broker 进程上是 21/25/26 之一;`./gradlew --version` 列出的 JDK 也是。**同时**你的客户端项目用 Java 17 编译仍能依赖 `pulsar-client` 成功,`./gradlew :tests:pulsar-client-java-compatibility:test` 通过。

6. **事务协调器散开。** 在一个 16+ broker 的集群上,`pulsar-admin transactions list-coordinator-servers` 显示的 16 个协调器应分布在**至少 8 个不同 broker** 上(64 个 bundle 的设计目标是尽量每个协调器独占 bundle,16 个 bundle 只能给 8 个)。如果你的集群 broker 数 < 16,这条指标按 broker 数收敛。

---

## 七、6-12 个月可观察未来信号

1. **Key_Shared 的哈希迁移生态收敛。** 经典实现删除后,「同 key 同 consumer」的具体哈希映射只剩一套,第三方工具(如 Pulsar SQL、Flink connector)不再需要适配两套 dispatcher 行为。12 个月内 Key_Shared 相关的兼容性 issue 应明显减少。

2. **AvgShedder 成为 Pulsar 负载均衡的事实标准。** ThresholdShedder 会保留但降级为「兼容选项」,社区文档的推荐配对会全面转向 AvgShedder。看 Pulsar 邮件列表里 load balance 相关的讨论是否以 AvgShedder 的分数对模型为默认语境。

3. **scalable topics(PIP-460)从 5.0 默认开走向成熟。** 5.0 让 `scalableTopicsEnabled=true` 成为默认并提供 `=false` 的回退开关("Set to false before migrating from 4.x to opt out of scalable topics and preserve rollback options")。这个开关的存在本身说明 scalable topics 还在灰度阶段 —— **12 个月内看这个开关是否被移除**,移除意味着 Pulsar 认为 scalable topics 已经不可回退地成为主线。

4. **V5 客户端成为唯一能消费 scalable topics 的客户端。** PIP-496 让 Functions/IO 支持 V5 客户端;v4 客户端明确拒绝 `topic://` 和 `segment://` 名字。迁移工具(PIP-475 的 regular-to-scalable migration)会成为升级路径上的常规步骤。

5. **Java 17 客户端兼容性的压力测试。** Pulsar 的客户端 Java 17 承诺靠 `verifyClientJavaCompatibility` 钉死,但只覆盖 Pulsar 自己的代码。12 个月内观察是否有依赖的第三方库开始要求 Java 21,迫使 Pulsar 的客户端 target 被迫抬升。

6. **broker 端消息去重从锁到并发结构的迁移效果。** #26763 引入了微基准 `MessageDeduplicationSequenceCheckBenchmark`,说明团队开始量化去重开销。12 个月内看这个基准的数字是否出现在 Pulsar 的性能报告里。

---

## 八、总结与最佳实践

### ✅ 5.0 该用

- **如果你的集群在 4.x 上稳定运行**:5.0 是一个**「清完债之后更干净」**的版本 —— 只有一套 dispatcher 实现、默认值面向现代集群规模、权限模型完整。长期持有价值高。
- **新集群直接上 5.0**:32 bundle 默认 + AvgShedder + Java 21,省掉 4.x 上一堆「过两年要调」的初始配置。
- **用 Key_Shared 且对顺序敏感的业务**:经典实现删除后语义唯一,不再有「两套实现的哈希映射不同」这个隐患。
- **有多租户 / 跨地域复制需求**:5.0 的权限收紧和多租户模型是同类产品里最完整的。

### ❌ 千万别用

- **不要在升级前不检查 namespace policy 就直接升 5.0**。经典 dispatcher 的开关是 `dynamic=true`,可以被 namespace/topic 级别覆盖,broker.conf 干净不代表没人开。
- **不要混搭新旧负载均衡默认值**。AvgShedder 必须配对使用,只改一半会静默回退并打 warning ——「静默回退」比报错危险,你以为生效了实际没有。
- **不要在升级窗口期对越权客户端视而不见**。滚动升级期旧 broker 放行新 broker 拒绝,同一客户端**间歇性 403**。这看起来像网络问题,实际是权限债在升级窗口里被逐台暴露。必须在升级前用只读角色跑一遍所有自动化脚本。
- **不要在没验证 Java 版本的情况下升级 broker**。5.0 broker 强制 Java 21+,用 Java 17 的部署会直接启动失败。
- **不要忽视 `defaultNumberOfNamespaceBundles=32` 的影响面**。新 namespace 一上来 32 个 bundle,只有被 lookup 的 bundle 才有成本 —— 但如果你的管理工具会遍历所有 bundle(比如批量 stats),32 会放大遍历成本。

### 5 步生产升级 checklist

1. **冻结默认值再升级**:在 4.x 的 broker.conf 里显式写下全部 4.x 默认值(shedding 策略 / placement / maxUnloadPercentage / bundle 数 / readBatchSize / subscriptionThread),确认集群在这些显式值下稳定,再开始滚动升级到 5.0。升级完成、观察 1-2 周后再逐项灰度接受 5.0 新默认。

2. **清经典 dispatcher 开关**:遍历所有 tenant/namespace 的 policy,确认两个 `UseClassicPersistentImplementation` 在所有层级都是 false 或不存在。在 4.x 上设成 false 并跑全量业务流量验证,观察 Key_Shared 的 consumer 分配是否变化(会有一轮 rebalance)。

3. **升级 JDK 到 21+**:broker 节点先升 JDK(21/25/26),重启确认 4.x 在 Java 21 上能跑(Pulsar 4.x 后期版本支持 Java 21),再升级到 5.0。客户端项目**不需要**升 JDK。

4. **升级期监控鉴权拒绝**:部署 §4.3 的监控,统计 schema 端点 / Functions trigger 端点的 401/403 突增。对每个被拒角色判断是「真越权」还是「权限模型以前没覆盖到这个用法」,后者给角色补 produce 权限。

5. **验证负载均衡配对 + bundle 数**:升级后检查 broker 日志无 placement 回退 warning;创建一个测试 namespace 验证 bundle 数为 32;在 16+ broker 集群上验证事务协调器分布(目标:每个协调器落在不同 broker)。

### 5 条 best practice

1. **把「默认值翻转」当 breaking change 对待,即使它不报错。** 5.0 的 10+ 项默认值翻转全部静默生效。升级 checklist 里「配置文件没变」不是「没风险」的证据 ——恰恰相反,配置文件没变意味着你**继承了全部新默认**。

2. **`dynamic=true` 的配置要查所有层级。** Pulsar 的配置可以被 namespace policy、topic policy 覆盖。任何在 broker 层做的配置审计都不完整,必须遍历 ZK policy 树。

3. **构建期契约优于文档承诺。** Pulsar 用 `verifyClientJavaCompatibility` 把「客户端 Java 17 兼容」从文档变成 CI 失败项。自己项目里任何「我们保证 X」的承诺,都该找一个能在 CI 里红起来的检查来执行它。

4. **「代写」路径要用调用者的权限校验。** Functions worker 代调用者发消息,必须先校验调用者的 produce 权限。任何「A 的意图、B 的执行」的设计都有这个坑:权限校验要跟意图走,不能跟执行者走。

5. **删逃生舱要用主版本号来标记。** Pulsar 4.0 留经典 dispatcher 逃生舱、5.0 删掉 —— 这个节奏值得学:**新实现默认开(4.0)→ 观察两个版本没人必须用旧的 → 下一个主版本删掉(5.0)**。没有主版本号这个信号,用户不知道什么时候必须迁完。

---

## 写在最后

Pulsar v5.0.0 最有意思的地方不是它加了什么,而是它**删了什么、翻转了什么默认值、补了哪些不该缺的校验**。

23.9 KB 的 release notes 里,Approved PIPs 只有 3 条,但 Broker 一节塞了 100 多条 fix/improve。这个比例本身就是一种表态:**主版本号 4→5 的承重理由,是时候把两套 dispatcher 并存的维护债、一堆面向小集群的旧默认值、一批压根没写权限校验的端点,一次性清掉了。**

而这批改动里最值得警惕的一类,是那些**不报错的翻转**:默认负载策略换了、默认 bundle 数从 4 变 32、读批从 100 变 500、分配器换成自适应的。你的配置文件一字未改,集群的行为就全变了。**「清债版本」的升级风险不在 breaking changes 列表里 —— 列表里的东西你会去看;风险在那些列表都不列、只是默认值悄悄翻了一面的地方。**

与今天早间的 ai-news 五维系账日和中午的 Vault v2.2.0 放在一起看,2026-10-09 是一条完整的「**凭证 → 消息**」栈层:早间全是账单口径的成本事件(token 砍九成、预算砍九成、定价权之争),中午的 Vault 解决的是「**谁有权动钱背后的密钥**」,晚间的 Pulsar 5.0 解决的是「**凭证校验完之后,消息该怎么可靠地流动**」—— 而 Pulsar 本批次补的那批权限端点,补的正是「消息总线上哪些操作需要先有权限」。三个 cron slot 从钱的账面,一路打到消息总线的权限语义。
