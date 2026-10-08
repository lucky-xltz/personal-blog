---
title: "Kueue v0.20.0 深度拆解:v1beta1 删除 + 配额记账锚点上移 + DRA 设备可行性 + TAS 节点级可行性,GPU 配额调度层从「尽力而为」变成「记账准确」"
date: 2026-10-08
category: 技术
tags: [Kueue, Kubernetes, 批处理调度, GPU调度, 配额管理, ClusterQueue, LocalQueue, Cohort, 公平共享, AdmissionFairSharing, AFS, 记账锚点, quota reservation, DRA, DynamicResourceAllocation, ResourceClaim, DeviceClass, DeviceTaint, TAS, TopologyAwareScheduling, 拓扑感知调度, 节点可行性, rack, LeaderWorkerSet, StatefulSet, RollingUpdate, maxSurge, SparkApplication, RayService, MultiKueue, 工作负载弹性, WorkloadSlices, ProvisioningRequest, scale-from-zero, 数值溢出, int64, resource.Quantity, 饱和算术, kueuectl, KueueViz, RBAC, SubjectAccessReview, UnadmittedWorkloadsObservability, 可观测性, 默认值收紧, BreakingChange, K8s, AI训练调度, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1633265486064-84dc4dd94f76?w=600&h=400&fit=crop
excerpt: "2026 年 9 月 30 日发布的 Kueue v0.20.0 是这个 Kubernetes 批处理调度器历史上记账准确度最高、默认值最严厉的一个版本。80.6 KB 的 release notes 里「Actions Required Before Upgrading」单独开了一章,15 条升级前必读里有 6 条是「升级后 controller manager 拒绝启动 / workload 永久 pending」级别。核心是四条主线:① API 层 v1beta1 正式删除,所有对象必须先跑迁移脚本改写存储版本;② 公平共享的记账锚点从「admitted」上移到「quota reservation」,一个卡在 AdmissionCheck 上的 workload 再也不能一边占着 GPU 配额一边让系统觉得它没在用;③ DRA 设备从「quota 层自说自话」变成「先查节点上设备真的可用再记账」,DeviceTaintRule 进可行性检查,ResourceSlice 的 taint 也算;④ TAS 拓扑感知调度补上节点级可行性——之前一个 rack 级 Topology 只看机柜总容量,8 卡机柜里 4 张卡被 tainted 的 workload 照样被 admit,然后 kube-scheduler 放不下。配套的数值正确性修复密度是全文最高:int64 溢出后取负被 floor 成 0 导致 workload 对着空气记账、sub-milli 资源消耗被截断成 0 导致公平共享永久失效、parallelism 大于 completions 的 Job 提前释放还在跑的 Pod 的配额、LeaderWorkerSet 百分比 maxSurge 被读成 0 导致滚动更新删掉正在跑的 surge 组。文章按「记账准确」主线拆完 6 大承重级改动,附 5 段可运行的 YAML / kubectl / kueuectl / Python 代码、5 套批处理调度方案 17 维度对比、6 条 6-12 月可验证硬指标、5 步生产升级 checklist、8 个诚实边界与 3 个长期判断。"
---

# Kueue v0.20.0 深度拆解:配额记账从「尽力而为」到「算得准」

> 2026 年 9 月 30 日,Kueue v0.20.0 发布。release notes 正文 **80.6 KB**,是近期基础设施项目里少见的体量。但真正值得注意的不是体积,而是结构——「Actions Required Before Upgrading」这一章的标题后面跟着一句括号:**(No, really, you MUST read this before you upgrade)**。15 条升级前必读里,6 条的直接后果是「kueue-controller-manager 启动失败」或「Workload 永久 pending」。

Kueue 是 Kubernetes SIG Autoscaling 的批处理调度器,核心抽象是 ClusterQueue(配额池)→ Cohort(配额借用层级)→ LocalQueue(命名空间内提交点)。它不替代 kube-scheduler,而是在 kube-scheduler 之上做一层**配额准入控制**:Job 先被 Kueue suspend 住,轮到它且配额够时才 ungate 让 kube-scheduler 去放置。

这个定位决定了它的核心责任:**Kueue 记的账必须和集群里真实发生的事一致**。kube-scheduler 放不下的 Pod,Kueue 不应该已经把它的配额扣掉;kube-scheduler 能放下的 Pod,Kueue 不应该因为记账误差而不让它跑。

v0.20.0 之前的 Kueue 在这件事上有四类系统性裂缝:

1. **公平共享的记账锚点在 admitted**,但一个 Workload 在 admitted 之前就可能已经**占住了配额**(AdmissionCheck / ProvisioningRequest 阶段)。于是出现一种搭便车姿势:让 AdmissionCheck 慢慢跑,配额握在手里,公平共享却觉得这个 LocalQueue 没在用。
2. **DRA 设备只在 quota 层做映射**,不检查节点上设备是否真的可用。一个 Workload 被 admit 了,kube-scheduler 去找 DeviceClass 对应的 ResourceClaim,发现节点上的设备都被占了或者被 taint 了,放不下,Workload 就卡在 QuotaReserved 状态。
3. **TAS 拓扑感知调度只做 domain 级可行性**。Topology 的最低层如果不是 `kubernetes.io/hostname`(比如最低层是 rack),一个 rack domain 的容量是里面所有节点之和,但 taint / nodeSelector / nodeAffinity 都是节点级的。于是「机柜总量够但没有任何单个节点够」的 Workload 被 admit,然后永远放不下。
4. **数值处理没有边界**。resource.Quantity 是 int64 尾数的三位小数,两个大数相加溢出回绕成负数再被 floor 成 0,Workload 的配额就「归零」了;小于 1 milli-unit 的消耗被截断成 0,在 168 小时的半衰期下永远累加不起来。

v0.20.0 一个版本把四条裂缝全补了。本文按这四条主线 + 两条工程线(RBAC 收紧、可观测性默认化)拆完整个版本。

---

## §0 一个版本的主线:从「尽力而为」到「算得准」

把 v0.20.0 的 80 KB release notes 按「改动针对的是记账链路的哪一段」分类,会得到一张很清楚的图:

```
Workload 提交
   ↓
LocalQueue 排队
   ↓
[§1 锚点] QuotaReserved(配额预扣)  ← v0.20: 公平共享记账从这里开始
   ↓
AdmissionCheck(ProvisioningRequest 等)
   ↓
Admitted(kube-scheduler 可以放置)
   ↓
[§2 设备] DRA ResourceClaim 申请     ← v0.20: 先查节点设备可行性
   ↓
[§3 拓扑] TAS TopologyAssignment     ← v0.20: 节点级可行性,不再只看 domain
   ↓
Pods Ready / 运行
   ↓
[§4 数值] 配额释放与回收              ← v0.20: 饱和算术 + sub-milli 保留
```

**关键洞察 1:v0.20.0 的 80 KB 里,绝大多数 bug fix 的本质是同一件事——Kueue 内部维护的一份「资源账本」和集群真实状态脱节。**修法不是加功能,而是把账本的记账时点、记账粒度、数值范围对齐到真实世界。

**关键洞察 2:四条主线的修法是同一个设计哲学——把「事后发现放不下」变成「事前就不让进」。**DRA 设备可行性、TAS 节点可行性、LWS group size 不可变、Spark 真实资源预留,全都是「在 admit 之前就把信息算对」,而不是「admit 之后放不下再重排」。这是调度器成熟度的分水岭。

**关键洞察 3:这个版本的「严厉」是被迫的。**15 条 Actions Required 里 6 条是启动失败或永久 pending——这些不是新加的限制,是修 bug 修出来的。之前的「能跑」是因为 bug 让错误配置静默通过了。

---

## §1 记账锚点:公平共享从「admitted」上移到「quota reservation」

### 1.1 问题到底卡在哪

Kueue 的 Admission Fair Sharing(AFS)给每个 LocalQueue 维护一个**衰减后的资源使用量** `consumedResources`,用来在多个 LocalQueue 之间决定谁先被 admit。计算公式是指数衰减:

```
decayed_usage = prev_decayed * exp(-elapsed / halfLife) + current_usage_sample
```

这个 `current_usage_sample` 从哪里取?v0.19 及之前:**从 admitted 的 Workload 取**。

但 Kueue 的配额扣减不是在 admitted 发生的。一个 Workload 的生命周期是:

```
Pending → QuotaReserved → (AdmissionChecks) → Admitted → Running
```

**`QuotaReserved` 这个状态就已经把配额扣掉了。** 如果 ClusterQueue 配了 AdmissionCheck(比如向 Cluster Autoscaler 发 ProvisioningRequest 申请一台新机器),Workload 会停在 `QuotaReserved` 等检查通过,这段时间它**一直占着配额**。

于是:

```
真实状态:  Workload 占着 8 张 GPU,已经占了 20 分钟
AFS 账本:  这个 LocalQueue 的 consumedResources = 0(因为还没 admitted)
```

这不是理论问题。PR #15000 的作者在 issue 里写得很直白:

> A Workload waiting on AdmissionChecks can already hold quota, but AFS does not count that reserved usage today. Until admission, only its entry penalty contributes to fair-sharing usage.

**一个能控制自己 AdmissionCheck 耗时的租户,可以系统性地让自己的公平共享使用量被低估。** 上面引用的 PR 描述里还有一句:

> a tenant able to lengthen its own checks, with a slow ProvisioningRequest for instance, can keep its usage understated.

**多算自己的使用量是自纠错的(自己的排序变低);少算不是。** 这是这个 bug 最危险的地方——它只奖励搭便车者,不惩罚诚实配置的人。

### 1.2 v0.20.0 的答案:锚点上移

`AdmissionFairSharingAnchorAtQuotaReservation` feature gate,**Beta,默认开启**。

从此 `consumedResources` 的采样点从 Admitted 移到 QuotaReserved。PR 文档里把这个改动的不变量写得很清楚:

| 状态转移 | 锚点上的行为 |
|---------|-------------|
| `Pending → QuotaReserved`(active) | 结算 pending 的 entry penalty(当 CQ 按 usage admit 时) |
| `Pending → Admitted`(active) | 同一次 update 里结算;没有 AdmissionChecks 时预留与 admit 同时发生 |
| `QuotaReserved → Admitted` | 无额外结算 |
| `QuotaReserved → Pending` | 保留已结算成本在衰减历史里。之后再次预留会结算一次新的 entry penalty |
| Deactivated 时仍持有配额(未结算) | 保留 pending penalty。如果带着预留重新激活,那时结算 |
| Workload 再也到不了锚点(删除 / 完成 / 换 LocalQueue / 不活跃且无预留) | 丢弃 pending penalty 而不是结算它 |

作者显式声明了这个改动的三个性质,值得逐条看:

**「采样跟随结算移动」(Sampling moves with settlement)。** `current_usage` 变成预留时刻的 usage。之前结算点在 admit、采样点在预留(或反过来)都会撕裂——一个 Workload 可以一边占着配额一边让系统觉得它的使用量在衰减。

**「采样在突发时会滞后」(Sampling can lag during bursts)。** 如果一个 LocalQueue 获取预留的速度快于 `usageSamplingInterval`(默认 5 分钟),它发布的 `consumedResources` 和由此推导的调度顺序会滞后到突发暂停。作者特意注明:**这不是锚点改动特有的,旧的 `Admitted` 锚点在突发时行为相同。** 这是诚实边界,不是新引入的问题。

**「重复预留重复计费」(Repeated reservations are charged repeatedly)。** 锚点计费的对象是「预留」这个动作,不是「一个 Workload 跑了一次」。设计意图是让预留抖动不要免费,但作者承认不是每次重试都是租户驱动的——一个 AdmissionCheck 超时导致的重排也会产生新预留。

**升级注意(这条是真的会咬人)**:

> If you explicitly disable AdmissionFairSharing, also disable AdmissionFairSharingAnchorAtQuotaReservation before upgrading to v0.20, or Kueue will reject the configuration at startup.

**配了 AFS 关闭但没关锚点 gate 的集群,升级后 controller manager 直接拒绝启动。** 回滚前也必须先从配置里删掉这个 gate(旧版本不认识这个 key)。

### 1.3 配置与验证,可跑

```yaml
apiVersion: kueue.x-k8s.io/v1beta2
kind: KueueConfiguration
share:
  admissionFairSharing:
    enable: true
  fairSharing:
    enable: true
---
apiVersion: kueue.x-k8s.io/v1beta2
kind: ClusterQueue
metadata:
  name: gpu-team-a
spec:
  namespaceSelector: {}
  queueingStrategy: BestEffortFIFO
  admissionChecksStrategy:
    admissionChecks:
      - name: prov-req        # 指向一个 ProvisioningRequest AdmissionCheck
        onFlavors: [gpu-a100]
  resourceGroups:
    - coveredResources: ["nvidia.com/gpu", "cpu", "memory"]
      flavors:
        - name: gpu-a100
          resources:
            - name: nvidia.com/gpu
              nominalQuota: 8
```

部署后,验证锚点是否真的在工作。AFS 的 usage 通过 metric 暴露:

```bash
# 看一个 LocalQueue 的衰减后使用量
kubectl get localqueue team-a-queue -o jsonpath='{.status}'
kubectl -n kueue-system port-forward svc/kueue-controller-manager-metrics-service 8080:8443

# 公平共享使用量(v0.20 起采样点 = QuotaReserved)
curl -sk https://localhost:8080/metrics | grep -E \
  "kueue_local_queue_admission_fair_sharing_usage"

# 一个 Workload 停在 QuotaReserved 时,usage 应该已经开始累加
kubectl get workload -A -o custom-columns=\
NAME:.metadata.name,\
LQ:.metadata.labels.kueue\.x-k8s\.io/queue-name,\
QR:.status.conditions[?(@.type=="QuotaReserved")].status,\
ADM:.status.conditions[?(@.type=="Admitted")].status
```

**验证锚点改动的关键观测**:构造一个带慢 AdmissionCheck 的 Workload,在它停在 `QuotaReserved=True / Admitted=False` 的那几分钟里,`kueue_local_queue_admission_fair_sharing_usage` 应该在增长。v0.19 里这个值是 0。

### 1.4 锚点改动牵出的 8 个 AFS 修复

锚点不是孤立改动,它把 AFS 的一堆历史 bug 一起暴露了。release notes 的 Bug or Regression 段落里 AFS 相关修复有 **12 条**,密度全版本最高:

| PR | 修复内容 | 为什么危险 |
|----|---------|-----------|
| #13621 | 小于 1 milli-unit 的资源消耗被截断成 0 | 配长 `usageHalfLifeTime` 时 CPU 和 GPU 的 `consumedResources` **永久保持 0**,公平共享完全失效 |
| #13180 | 计算 AFS usage 时可能**修改缓存的 Workload 数据** | 产生不一致的调度快照 |
| #13481 | `fairSharing.weight: 0` 的 LocalQueue 反而被优先 admit | 权重为 0 意思是「不想被公平共享排序」,结果适得其反 |
| #13570 | heap comparator 里 LocalQueue 查询的**瞬时错误翻转调度顺序** | 公平共享与优先级之间随机切换 |
| #12786 | 经 AdmissionChecks admit 的 Workload **永久保留 entry penalty** | 抬高 LocalQueue 使用量,压制后续所有 Workload |
| #14153 | entry penalty 的记账泄漏(re-admit / 提前退出时) | 同上,使用量虚高 |
| #13844 | entry penalty 被加到**非 usage-based 的 ClusterQueue** 上 | 静默错误配置 |
| #16241 | Workload 可能按**优先级顺序**而不是公平共享顺序调度 | 与 #13570 不同实现路径的同类问题 |
| #14547 | 同名 LocalQueue 跨命名空间时的抢占排序**不看 LocalQueue usage** | 抢占选错对象 |
| #13433 | 查询失败时快照混合两种排序,产生**非传递的 comparator** | 排序不自洽,结果不可预测。修复:查询失败时整个快照回退到基础排序 |
| #14128 | 抢占候选漏选(需开 alpha `FairSharingReevaluatePreemptionCandidates`) | 作者注明开启可能加剧 #14543 抢占循环问题 |
| #14490 | 抢占方的 dominant resource share 为 +Inf 时**跳过整个锦标赛** | 避免无意义的逐候选评估和 V(4) 日志量 |

**关键洞察 4:#13621 这个 bug 的杀伤力被严重低估。** 截断成 0 不是「少算一点」——`consumedResources` 永远是 0 意味着公平共享排序完全退化为优先级排序,而集群管理员**在 metric 上看不出任何异常**(值一直是 0,看起来像「没人用」)。这类 bug 的特征是:**监控指标正常,调度行为错误。**

---

## §2 DRA:从「quota 层自说自话」到「先查节点设备再记账」

### 2.1 问题的形状

Kueue 对 DRA(Dynamic Resource Allocation)的支持是通过 `deviceClassMappings` 把 DeviceClass 映射成一个逻辑配额键:

```yaml
apiVersion: kueue.x-k8s.io/v1beta2
kind: KueueConfiguration
dra:
  deviceClassMappings:
    - coveredResources: ["gpu-claims"]
      kind: DeviceClass
      name: nvidia-gpu
```

一个 Pod 用 `resourceClaims` 引用 DeviceClass,Kueue 就在 `gpu-claims` 这个逻辑键上扣配额。**但 Kueue 从来不看节点上设备的状态。**于是:

- 节点上的设备被别的 Pod 占满了,Kueue 不知道,照常 admit,Workload 卡在 QuotaReserved
- 设备被 taint 了(节点维护 / 设备级 taint),Kueue 不知道,照常 admit
- 一个 DeviceClass 被多个 extended resource 名字共享,Kueue 可能扣到调度器根本不会用的那个 DeviceClass 头上

v0.20.0 之前 Kueue 已经能管理 DRA 配额,但**「配额够」和「设备真的能分到」是两件事**。Kueue 只管前者。

### 2.2 v0.20.0 的三件套

**第一件:`KueueDRADeviceFeasibility`(alpha,默认关)**

> Kueue checks device availability per node before admitting a Workload that uses ResourceClaimTemplates or DRA-backed extended resources, so quota is not reserved for a Workload kube-scheduler cannot place.

一句话:**在 admit 之前,先确认节点上设备真的可用。**

这个改动直接把 Kueue 的角色从「配额记账」扩展到「准调度可行性」。配额不再是唯一门槛,物理可用性也成了门槛。

**第二件:`DeviceTaintRule` 支持(#16081,Beta gate `KueueDRAIntegrationDeviceTaints`)**

> Kueue no longer admits Workloads onto tainted devices.

不止节点 taint,**ResourceSlice 里声明的设备 taint 和 DeviceTaintRule 里的 taint 都参与可行性检查**。Workload 的设备请求必须 tolerate 这些 taint。

这两件事需要两个 feature gate 同时开(`KueueDRAIntegrationDeviceTaints` + `KueueDRADeviceFeasibility`)。

**第三件:可行性拒绝后能重排(#16098)**

之前被设备可行性拒绝的 Workload 就死了。现在:

> Added requeueing of Workloads rejected by KueueDRADeviceFeasibility, allowing them to be admitted once a ResourceSlice, DeviceClass, ResourceClaim or DeviceTaintRule change makes the devices available.

**Node 变化时只重新排队使用受影响 TAS flavor 的 ClusterQueue**——这个收窄很重要,不然一次节点抖动会全集群重排。

配套还有 `KueueDRAIntegrationPrioritizedList`(alpha):DRA 的 `firstAvailable` 请求如果所有备选都要同样的设备数且映射到同一个逻辑资源,只扣一次;备选设备数或逻辑资源不同、或用了 counter/capacity 映射的,直接拒绝。作者明确说明:**Kueue 不检查任何备选是否可满足,MultiKueue 不支持 `firstAvailable`。**

### 2.3 DRA 记账的 9 个数值正确性修复

这是全版本最硬核的一段。DRA 配额记账要处理「extended resource 名字 → DeviceClass → 逻辑配额键」的多对多映射,每个环节都能错:

| PR | 修复 | 后果 |
|----|------|------|
| #14154 | 扣除 extended resource 时只扣**容器自己的请求**,不删整个名字键 | pod overhead 和 transformation output 之前跟着名字一起被删掉,设备费用替它们顶了 |
| #13989 | **拒绝用 `pods` 作为 DRA 逻辑资源名** | 之前静默丢弃或让 Workload 永久 pending。升级后 controller manager 启动失败 |
| #14200 | 同一 PodSet 里不同容器请求两个映射到同一 DeviceClass 的 extended resource 时**配额漏扣** | 少扣配额 |
| #14044 | 配额可能扣到**调度器不会分配的 DeviceClass** 上(多个 DeviceClass 共享同一 `extendedResourceName`) | 扣错账本 |
| #14367 | **负数** extended resource 请求被合并成**负的 DRA 配额费用**,静默抵消同一逻辑资源上的合法费用 | 一个负费用可以抵掉别人的正费用。只在关掉 `WorkloadValidateResourcesAreNonNegative` 时可达 |
| #13967 | backoff 后重排的 Workload 丢失 DRA 预处理结果 | 队列回退到原始 pod-spec 请求,记账口径不一致 |
| #15095 | deactivating 一个 pending Workload 会把 Kueue 的**内部调整写回用户的 Workload spec** | 污染用户对象(RuntimeClass overhead / LimitRange 默认值 / limits 推导的请求) |
| #14951 | config 静默接受**含多个斜杠的 capacity 名** | 产生永远匹配不到任何设备的映射 |
| #13629 | ResourceSlice API(`resource.k8s.io/v1`)不可用时开启 DRA gate 会**启动崩溃** | 老集群升级直接挂 |

### 2.4 #14154:一个值得单独讲的记账修复

这个 PR 的标题是 "Take back only what the extended-resource charge replaces",+537/-64,修的是 #14004。

**之前的做法**:一个 DRA-backed extended resource 被替换时,Kueue **把这个资源名字从 PodSet 的 requests 里整个删掉**。问题是这个名字下可能还挂着别的东西:

- **pod overhead**(节点级开销)
- **resource transformation 的 output**

这两个跟着名字一起被删掉,然后重建的设备费用一个人顶了全部。

**新做法**:只扣除**容器自己的请求**,而且这个扣除量从 PodSet spec 现算(不含 overhead),不是预处理时算好存起来。PR 描述里点明了设计原则:

> The subtracted amount is derived where it is used, from the same PodSet spec the accounting already reads, rather than being resolved during preprocessing and carried around.

**扣除口径和记账口径必须读同一份 spec。** 这是防止漂移的正确工程姿势。

这个 PR 还顺手修了第二个问题:之前解析器对 init container 取 max、再跟 regular container 的 sum 取 max。**restartable init container(Sidecar)被 max 掉而不是加进去。**新做法按 Pod 自己的聚合方式聚合(`resourcehelpers.PodRequests`:overhead 不算,sidecar 加到 app container 总量上,不像普通 init 那样取 max)。PR 给了三个失败 case,全都是修复前算错的形状:

1. 一个容器 + pod overhead 用同一个名字 → overhead 之前跟着键一起消失
2. 一个容器 + transformation output 用同一个名字 → 同上
3. 一个 restartable init container 配一个 regular container → 之前算一次,现在算两次

**关键洞察 5:#14154 折射出所有「记账中间层」的通病——转换层一旦缓存了中间结果,上游口径变了下游不知道。** Kueue 的 DRA 映射、Spark 的资源换算、TAS 的拓扑树,全都有这个问题。v0.20.0 的修法高度一致:**不要缓存转换结果,在用到的地方从源 spec 现算。**

### 2.5 升级前必须改的两个配置

```yaml
# 错误:v0.20 会让 controller manager 启动失败
apiVersion: kueue.x-k8s.io/v1beta2
kind: KueueConfiguration
dra:
  deviceClassMappings:
    - coveredResources: ["pods"]     # ← 保留资源名,禁止
      kind: DeviceClass
      name: my-device
```

```bash
# 排查:列出所有用了保留名的映射
kubectl get kueueconfiguration -o yaml | grep -A3 deviceClassMappings

# 修复后必须同步改 ClusterQueue 的 nominalQuota
# PR #13989 明确:重命名 mapping name 或 outputs key 时,
# 必须在同一个变更里更新匹配的 ClusterQueue nominalQuota 条目
```

---

## §3 TAS:拓扑可行性从 domain 级下沉到 node 级

### 3.1 问题的形状

TAS(Topology Aware Scheduling)让 Workload 可以要求「我的 Pod 要在同一个 rack / zone」。Topology CRD 声明层级:

```yaml
apiVersion: kueue.x-k8s.io/v1beta2
kind: Topology
metadata:
  name: rack-topo
spec:
  levels:
    - name: kubernetes.io/hostname
    - name: topology.kubernetes.io/zone
    - name: example.com/rack
```

**v0.20 之前:Kueue 在 Topology 声明的最低层做容量与可行性检查。** 如果最低层不是 `kubernetes.io/hostname`(比如最低层是 `example.com/rack`),一个 domain 覆盖多个节点,检查回答的是**关于 domain 的问题**而不是关于任何具体节点的问题。

PR #14191 的文档把后果写得很清楚:

> Workload fitting a rack's total capacity was admitted even when no single node could fit it.

具体一点:一个 rack 里 2 个节点各 4 张 GPU,rack 总容量 8。一个 Workload 要 6 张 GPU 且要求同 rack。**domain 级检查:8 ≥ 6,通过。** 但没有任何单个节点有 6 张。admit 之后 kube-scheduler 放不下,Workload 永远卡住。

同样,节点 taint / nodeSelector / nodeAffinity 都是**节点级**的,domain 级检查完全看不见:

> so node taints, node selectors and node affinity exclude individual nodes inside a domain

### 3.2 v0.20.0 的答案:内部注入一个 hostname 层

`TASNodeFeasibilityForAllLevels` feature gate,**Beta,默认开启**。

做法很优雅:**Kueue 在内部给这类 Topology 追加一个 `kubernetes.io/hostname` 层。**这样每个叶子恰好是一个节点,节点容量 / taint / nodeSelector / nodeAffinity 全部参与可行性检查。

实现上有三个细节值得看:

1. **追加的层是内部的。** 叶子用**节点名**做 key 而不是 hostname label——作者注明 hostname label **既不唯一也不不可变**。
2. **序列化时剥掉这一层**,所以 `TopologyAssignment` 还是只声明 Topology 实际声明的层级。读序列化层级的检查(失败节点替换、hostname 前缀编码)不受影响。
3. **usage 仍然记录在 TopologyAssignment 声明的层级上**,因为 Pod 落在 domain 里哪个节点是 kube-scheduler ungate 之后选的,Kueue 从不回报。叶子按节点容量评估,domain 自身的容量统计保持现状(仍然是近似,但可行性变精确了)。

作者在文档里明确了「显式声明 hostname 仍然决定四件事」:

- 是否要求严格单节点放置
- `podset-required-topology: kubernetes.io/hostname` 只在声明了该层的 Topology 上是合法请求
- usage 归因是精确的,没有 domain 级近似

**诚实边界(作者自己列的)**:

> attribute a domain's usage to the node holding each Pod on topologies without `kubernetes.io/hostname` in the lowest level, which needs Pod location tracking

**在没有显式 hostname 层的 Topology 上把 domain usage 归因到具体节点,需要 Pod 位置追踪,v0.20 不做。** 所以 domain 级 usage 仍然是近似值。这不是缺陷,是 Kueue 架构的固有限制——它不接管调度,只是 gate。

### 3.3 同批落地的 TAS 改动

| PR | gate | 改动 |
|----|------|------|
| #14191 | `TASNodeFeasibilityForAllLevels` Beta 默认开 | 节点级可行性 |
| #14820 | `TASTopologySpreading` | Workload(如 LeaderWorkerSet group)可以**跨 rack/zone 分散,同时保持每组 Pod 在一起**。用 `kueue.x-k8s.io/podset-topology-spreading` |
| #15111 | `TASGroupedPodSetSlicing` Beta 默认开 | PodSet **slicing** 与 grouping 并存,LeaderWorkerSet 的 leader PodSet(grouped)可以和 worker PodSet(sliced)协同放置 |
| #13819 | `TASCacheTopologyTree` Beta 默认开 | **复用缓存的拓扑树**,调度相关 Node 数据没变就不重建。降低快照创建的 CPU 与内存分配 |
| #12344 | `TASReplaceMultipleFailedNodes` alpha | 多节点失败时**增量替换节点**而不是直接 evict,Workload 保持 admitted |
| #13910 / #13738 / #13622 | — | `Topology.spec.levels`(hostname 仍是最低层时)、ResourceFlavor 的 `nodeLabels`、`tolerations` **现在可以原地更新**;已 admit 的保留配额与拓扑分配,pending 的按新节点集重排 |
| #13555 | `SchedulerLibraryIntegration` | hostPort 冲突检测纳入节点可行性 |
| #12728 | — | Workload slice size 必须为正,`podSetSliceRequiredTopology` 与 `podSetSliceSize` 必须成对设置。**禁 gate 只关 webhook 检查,CRD 最小值校验仍生效** |

**关键洞察 6:#13819(TASCacheTopologyTree)这种「纯性能」改动在这个版本里承担的结构角色被低估了。** 节点级可行性(#14191)把检查粒度从 domain 细化到 node,拓扑树的节点数可能翻几倍。如果每次快照都重建,调度延迟会显著上升。**先做缓存复用再做粒度细化,顺序不是巧合。**

### 3.4 TAS 相关的失败修复

- **#14099**:TASFailedNodeReplacementFailFast 关闭时,节点变不健康后替换 Pod 被 ungate 到**同一个不健康节点**上,立即终止,把 Pod 重建预算耗尽,而不是等替换 domain。修复:不要把 Pod ungate 到一个等待替换的节点上(+554/-48)
- **#14237**:`TASRecomputeAssignmentWithinSchedulingCycle` 现在依赖 `TopologyAwareScheduling`。**关 TAS 时必须同时把这个 gate 设 false,否则升级后行为不一致**
- **#13108**:负数 `subGroupCount` 之前只给 deprecation warning,现在直接 reject

---

## §4 数值正确性:溢出、截断与过早释放

这一节单列,因为 v0.20.0 的数值修复**每一个都能让配额账本静默失效**,而且没有一个会报错。

### 4.1 int64 溢出回绕成负数,再被 floor 成 0

**PR #14042**(+91/-4),标题 "Clamp the resource conversion for every resource, not only cpu":

> A quantity larger than int64 on a resource other than cpu being converted to a number of another magnitude, or of another sign... A large enough resource transformation product could arrive negative and then be floored to zero, so the Workload was admitted against no quota at all.

**resource transformation 的乘积大到溢出 int64,回绕成负数,floor 到 0,Workload 对着「零配额」被 admit。**

注意这里最微妙的一点:**只有 cpu 之前做了 clamp,其他资源没有。** 一个修了一半的边界条件比完全没修更危险,因为它让人觉得「这个问题处理过了」。

**PR #14100**(+119/-17),标题 "Saturate Add and Sub in both Requests implementations":

> Fixed resource totals wrapping to a negative number when two contributions to the same resource sum past the int64 range. Both Requests implementations now saturate in Add and Sub, as they already did in Mul.

**Mul 早就饱和了,Add 和 Sub 没有。** 这是非常典型的「同一个类型的三种运算,两种有边界一种没有」。

**为什么这类 bug 特别难抓**:Go 的 int64 溢出**不 panic**,回绕成「另一个数量级、另一个符号」的值继续跑。测试要用极端值才覆盖得到,而生产环境里一个配错的小数点或者一个 transformation 系数就能触发。

### 4.2 sub-milli 截断:公平共享的隐形失效

**PR #13621**(+232/-10)。AFS 的 `consumedResources` 用 `resource.Quantity`,它内部是 int64 尾数三位小数。**小于 1 milli-unit 的贡献被截断成 0。**

配合默认配置:

```go
UsageSamplingInterval: metav1.Duration{Duration: 5 * time.Minute},
UsageHalfLifeTime:     metav1.Duration{Duration: 168 * time.Hour},   // 7 天
```

半衰期 168 小时,每次采样的增量极小。**CPU 和 extended resource(包括 GPU)的 `consumedResources` 永远停在 0,公平共享排序完全失效。**

这个 bug 的测试名直接点题:`TestCalculateDecayedConsumedAccumulatesSubMilli`。修复里还有一条不变量:

> Decayed usage must approach current usage on the half-life curve, and must never exceed it: accumulated rounding that drifted upwards would inflate a LocalQueue's [usage]

**只修「向下截断」不够,还得保证不向上漂移。** 向上漂移会虚增使用量,压低租户优先级。

### 4.3 配额过早释放:还在跑的 Pod 被记账成可回收

**PR #16111**(+89/-4),Job 集成:

> Fixed a bug where a Job with `parallelism` greater than `completions` could release the quota of its still-running Pods once some Pods succeeded, allowing the ClusterQueue to admit Workloads beyond its quota.

修复代码就几行,但语义很关键:

```go
// 之前:count := parallelism
count := j.podsCount()   // PodSet 数量,而不是 parallelism
if count > 1 && terminalCount > 0 {
    if remaining := max(completions-terminalCount, 0); remaining < count {
        reclaimable = count - remaining
    }
}
```

注释点明了为什么用 podsCount:

> does one whose remaining work still needs every Pod in the PodSet. Measure against the PodSet count rather than parallelism, which can exceed it.

**parallelism 可以大于 completions。** 一个 `parallelism=8, completions=4` 的 Job,跑完 1 个就有 7 个 Pod 在跑,但只剩 3 个单位工作。之前按 parallelism 算回收,提前把还在跑的 Pod 的配额放回池子,**ClusterQueue 可以超配 admit**。

**PR #13486**(+189/-47),Indexed Job 的镜像问题:

> Fixed a bug where failed indexes of Indexed Jobs using "backoffLimitPerIndex" continued to hold quota after being recorded in "status.failedIndexes".

**永久失败的 index 记进 `status.failedIndexes` 后还继续占配额。** 修复把它们算作可回收 Pod。

**PR #14578**(+387/-31):

> Fixed a bug where evicted Workloads with no remaining Pods kept their quota reserved. Kueue now releases that quota.

**Pod 全没了的 evicted Workload 还留着配额预留。**

**这三个 bug 的共同特征:状态已经推进了(成功 / 失败 / 驱逐),账本还停在旧状态。** 与 §1 的锚点问题是同一类病,只是分布在生命周期的另一头。

### 4.4 LeaderWorkerSet / StatefulSet 的滚动更新四修

LeaderWorkerSet 是 v0.20 承重明显加大的集成(配 Kueue 做 leader-worker 模式的 AI 训练任务),滚动更新这一块一口气修了四个:

| PR | 修复 |
|----|------|
| **#14405** | 百分比 `maxSurge`(如 `50%`)被**读成 0**,surge 组的 Workload 在还在跑时就被删除 |
| **#16329** | 滚动更新时**当前 revision 的 Pod 在 Workload admit 之前就被 ungate**,可以无配额运行;重建的 StatefulSet Pod 可能**永久 gated** |
| **#14143** | 已有 Workload 的 queue name 和 LWS 的 `admission-gated-by` annotation 在同一次 reconcile 里变更时的竞态——现在**原子化持久化**,防止 Workload 在没有 admission gate 的情况下进队列 |
| **#14138** | 从没盖过 `queue-name` label 的 LWS 重建出的 Pod **永久 scheduling-gated**,最终 deactivate Workload。修复:回填 queue-name |

**#14405 只有 +153/-9,但它能让一次正常的滚动更新删掉正在跑的训练任务。** 这是「小 PR 大杀伤」的典型。

### 4.5 JobFramework 的两个安全修复

**PR #13573**(+550/-13),这条必须单独说:

> FindMatchingWorkloads now only considers Workloads controlled by the reconciled job. Workloads with non-controller ownerReferences to a served job previously caused a permanent reconcile error-loop for that job, and **Workloads controlled by other objects could be deleted or have their spec overwritten by kueue**.

**Kueue 之前能删除或改写它不该管的 Workload。** 一个非 controller 的 ownerReference 就能触发。这是越权,不只是 bug。

**PR #13802**(+131/-9):

> Previously an object whose ownerReference named a Kueue-managed ancestor with a **stale or mismatched UID** was treated as managed by that ancestor and was skipped by Kueue (not suspended/gated and no Workload created).

**ownerReference 指向一个 UID 已过期的祖先对象,会被当成「被管理」而跳过。** 修复:校验每个 controller ownerReference 的 UID 与引用对象一致。

**关键洞察 7:#13573 和 #13802 是一对。** 前者是「管了不该管的」(能删别人 Workload),后者是「该管的没管」(stale UID 导致绕过 suspend/gate)。**UID 校验缺失是所有基于 ownerReference 的控制器都会踩的坑**,v0.20.0 把两个方向都补上了。

---

## §5 v1beta1 删除:一个 API 版本退役的完整工程

**PR #14558**,+42/-**9114**:

> API: Kueue no longer serves kueue.x-k8s.io/v1beta1. Update manifests and API clients to v1beta2 before upgrading. Run the migration script before upgrading to rewrite existing objects in v1beta2 storage.

这是本版本唯一一个「删 9000 行」的 PR。一个 API 版本从 served 到 unserved 到删除,Kueue 的做法值得当作模板看:

1. **先 unserved,再删除**。PR 标题就是 "set unserved for v1beta1 types and resources"——先让 API server 不再提供这个版本,但存储版本还在
2. **提供迁移脚本**:`hack/migrate-to-v1beta2.sh`,升级前必须跑,把已存在的对象改写成 v1beta2 存储
3. **在 release notes 的 Actions Required 里单独列一条**,写清楚「升级前跑脚本」

**这个 PR 只有 42 行新增代码,但它删掉了 9114 行。** 一个 API 版本的退役,工程量不在写代码,在于迁移路径的设计与文档。

升级检查:

```bash
# 1. 升级前:列出所有还是 v1beta1 存储的对象
kubectl get clusterqueues,localqueues,topologies,resourceflavors,workloads -A \
  -o jsonpath='{range .items[*]}{.apiVersion}{"\n"}{end}' | sort | uniq -c

# 2. 跑迁移脚本(在升级到 v0.20 之前!)
curl -sO https://raw.githubusercontent.com/kubernetes-sigs/kueue/main/hack/migrate-to-v1beta2.sh
chmod +x migrate-to-v1beta2.sh
./migrate-to-v1beta2.sh --kubeconfig=$KUBECONFIG

# 3. 升级后确认没有 v1beta1 残留
kubectl api-resources --api-group=kueue.x-k8s.io
# 应该只看到 v1beta2
```

**如果跳过迁移脚本直接升级**:已存在的对象存储版本还是 v1beta1,API server 不再提供 v1beta1,Kueue 读不到它们,**所有现有队列配置和排队中的 Workload 对 Kueue 变成「不存在」**。

---

## §6 默认值收紧与可观测性:从「静默放行」到「启动期拒绝」

### 6.1 新增的启动期拒绝

v0.20.0 的一个明显模式:**无效配置以前静默生效,现在让 controller manager 启动失败。**

| 配置 | v0.19 行为 | v0.20 行为 |
|------|-----------|-----------|
| 开 `AdmissionFairSharing` 但没关 `AdmissionFairSharingAnchorAtQuotaReservation` | (gate 不存在) | **启动拒绝** |
| DRA mapping 用保留资源名 `pods` | 静默丢弃 / Workload 永久 pending | **启动拒绝** |
| `metrics.localQueueMetrics.localQueueSelector` 无效 | enabled 的 LocalQueue metrics **包含所有队列** | **启动拒绝** |
| 关 TAS 但没关 `TASRecomputeAssignmentWithinSchedulingCycle` | 行为不一致 | **依赖关系强制** |
| `leaderWorkerTemplate.size` 在 Kueue 管理时修改 | 静默绕过配额 | **webhook 拒绝**(`LWSImmutableGroupSize` Beta 默认开) |

**关键洞察 8:这个模式的代价是升级变难,收益是「配了但没生效」这个反模式被消灭。** 之前最坑的一类生产事故就是「配置写了,YAML 校验过了,监控正常,但行为是默认值」——因为旧值静默吃掉了新配置。启动期拒绝把这类问题从「上线后某个深夜发现」提前到「升级时立刻发现」。

### 6.2 `LWSImmutableGroupSize`:一个 quota bypass 的正确修法

**PR #13279**(+251/-0):

> Fixed a quota bypass where raising `spec.leaderWorkerTemplate.size` on an already-admitted, Kueue-managed LeaderWorkerSet ran more pods per group than the reserved quota covered.

**已 admit 的 LWS,改大 `leaderWorkerTemplate.size`,跑的 Pod 数超过预留配额覆盖的范围。**

修法值得注意:**不是去追踪 size 变更并重新算配额,而是直接让这个字段不可变。**

```go
if features.Enabled(features.LWSImmutableGroupSize) {
    // Immutable while managed: Workload updates never recompute PodSets,
    // so growing Size would ungate extra pods without accounting for quota.
    allErrs = append(allErrs, apivalidation.ValidateImmutableField(
        ptr.Deref(newLeaderWorkerSet.Spec.LeaderWorkerTemplate.Size, defaultLeaderWorkerSetSize),
        ptr.Deref(oldLeaderWorkerSet.Spec.LeaderWorkerTemplate.Size, defaultLeaderWorkerSetSize),
        leaderWorkerTemplateSizePath,
    )...)
}
```

注释把为什么讲得很清楚:**Workload update 不重算 PodSet,所以增大 Size 会 ungate 多余的 Pod 而不算配额。** 修「重算」是一个大改动(涉及已 admit Workload 的配额重估),修「不可变」是一行 webhook。`spec.replicas` 保持可变。

**这是基础设施里「修不动的问题就关掉它」的正确范例。** 作者在 release notes 里还留了逃生舱:关掉 gate 可以恢复旧行为——**但同时恢复了 quota bypass**。

### 6.3 SparkApplication:一个少算了半年的资源记账

**PR #15833**(+923/-43):

> The SparkApplication integration only read `coreRequest` and `memory` when building the driver and executor PodSet templates, so `cores` and `memoryOverhead` were ignored.

Spark 设 Pod CPU request 时用 `request.cores`,回退到 `cores`(默认 1);memory request 用 `memory + memoryOverhead`,overhead 默认 `max(memoryOverheadFactor * memory, 384MiB)`。

**用 `cores` 的 SparkApplication 之前预留 0 CPU,每个 Pod 预留的内存都比 Spark 实际请求的少。**

这个 PR **完整复现了 Spark 的计算**(`BasicDriverFeatureStep` / `BasicExecutorFeatureStep` / `ResourceProfile.getResourcesForClusterManager`),并让 e2e 测试直接对比 Workload PodSet requests 与真实 Spark Pod 的 requests。

代价(release notes 明确写了):

> Memory values must use the Java format accepted by Spark (for example `512m` or `2g`); Kubernetes-style values such as `512Mi` are rejected.
> ACTION REQUIRED: If SparkApplications rely on `cores` or on the default memory overhead, raise the ClusterQueue quotas accordingly: each Pod now reserves its `cores` as CPU and at least 384Mi of additional memory.

**升级后 Spark 任务的配额需求会上升。** 这不是 bug,是之前少算了。**升级前必须先抬配额,否则所有 Spark 任务卡 pending。**

### 6.4 KueueViz 的安全升级

**PR #13810**(+1228/-182):

> Added Kubernetes RBAC checks through SubjectAccessReview for API and WebSocket requests when authentication is enabled.

**KueueViz 后端之前不做 Kubernetes RBAC 检查。** 现在每个 API 和 WebSocket 请求都过 `SubjectAccessReview`。

代价:非 Helm / 自定义 RBAC 安装必须确保后端 ServiceAccount 能在 `authorization.k8s.io` API group 下 create subjectaccessreviews。Helm chart 已自带。

**一个配额调度器的 dashboard 之前不看 RBAC,意味着任何能访问后端的人能看到全集群的队列与配额状态。**

同批还有一个 KueueViz 修复值得注意:**#13175,只有 +3/-1**:

> fix(kueueviz): Fix Client-Side DoS via Infinite Toast Rendering

**一个 Workload 被抢占时,dashboard 渲染数千条重复错误通知。** 客户端 DoS,3 行修复。

### 6.5 可观测性:从「查不到原因」到「原因直接写进 condition」

`UnadmittedWorkloadsObservability` 在 v0.20 **默认开启**(#13063,+93/-77):

> reporting granular reasons (e.g., WaitingForQuota, ExceedsMaxQuota, WaitingForPodsReady, Misconfigured, or Suspended) in the QuotaReserved status condition and metrics for unadmitted workloads.

**之前一个 Workload 卡在 pending,只能去翻 controller 日志。现在原因直接写在 condition 里。**

同批新增的可观测性(挑重要的):

| PR | 指标 |
|----|------|
| #13420 | `kueue_execution_time_seconds` / `kueue_local_queue_execution_time_seconds`:Workload 完成时记录**跨所有 admit 的总执行时间**(含驱逐后重新 admit) |
| #14766 | `kueue_workload_recovery_wait_time_seconds` / `kueue_local_queue_workload_recovery_wait_time_seconds` |
| #12520 | `kueue_pending_scheduling_hashes`:每个 ClusterQueue pending Workload 的调度等价 hash 数,按 `active`/`inadmissible` 分 |
| #14494 | `kueue_preemption_target_recomputations_total`:调度周期内重叠抢占目标重算的结果 |
| #15201 | `kueue_cluster_queue_info` / `kueue_cohort_info` 加 `dynamic_quota_orchestrator` 标签 |
| #13775 | 引用了不存在的 WorkloadPriorityClass 时**发 Warning event** |
| #16123 | DRA 资源未解析的 Workload 报 `DRAResourcesUnresolved` |

外加 `CustomMetricLabels` feature gate(#13635 / #13469 / #14167):pending 与 admitted workload metrics 支持 Workload 自定义 label。

**关键洞察 9:`UnadmittedWorkloadsObservability` 默认开启,可能是这个版本对日常运维影响最大的单个改动。** 之前 debug 一个卡住的 Workload 是个探险:看 condition 只有一个 `Admitted=False`,然后翻日志、看 ClusterQueue、猜原因。现在 `kubectl get workload -o yaml` 直接告诉你 `WaitingForQuota` 还是 `Misconfigured`。

---

## §7 完整可跑:从 0 搭一个 GPU 配额队列 + 弹性 Ray

把前面几节的能力串成一个可部署的整体。以下 YAML 在 Kueue v0.20.0 + Kubernetes 1.37 + 启用 DRA 的集群上可直接 apply。

### 7.1 基础设施:Topology + ResourceFlavor + AdmissionCheck

```yaml
---
# 节点级可行性的前提:Topology 显式声明 hostname 层
# v0.20 起对最低层非 hostname 的 Topology,Kueue 内部注入 hostname 层
apiVersion: kueue.x-k8s.io/v1beta2
kind: Topology
metadata:
  name: rack-topology
spec:
  levels:
    - name: kubernetes.io/hostname      # 显式声明:usage 归因精确
    - name: example.com/rack
---
# ResourceFlavor 绑定拓扑与节点标签
# v0.20:nodeLabels / tolerations 现在可以原地更新
apiVersion: kueue.x-k8s.io/v1beta2
kind: ResourceFlavor
metadata:
  name: gpu-h100
spec:
  nodeLabels:
    accelerator: h100
  tolerations:
    - key: "nvidia.com/gpu"
      operator: "Equal"
      value: "true"
      effect: "NoSchedule"
  topologyName: rack-topology          # 绑定后 TAS 生效
---
# ProvisioningRequest AdmissionCheck:这是触发「占配额但没 admit」的场景
# §1 的锚点改动正是为它设计的
apiVersion: kueue.x-k8s.io/v1beta2
kind: ProvisioningRequestConfig
metadata:
  name: prov-h100
spec:
  provisionerClassName: cluster-autoscaler.k8s.io   # 或 in-tree provisioner
  parameters:
    onDemandCapacityReservationPreference: open
---
apiVersion: kueue.x-k8s.io/v1beta2
kind: AdmissionCheck
metadata:
  name: prov-check
spec:
  controllerName: kueue.x-k8s.io/provisioning-request
  parameters:
    apiGroup: kueue.x-k8s.io
    kind: ProvisioningRequestConfig
    name: prov-h100
```

### 7.2 配额层级:Cohort + 两个 ClusterQueue

```yaml
---
apiVersion: kueue.x-k8s.io/v1beta2
kind: Cohort
metadata:
  name: ai-platform
spec:
  fairSharing:
    weight: 1
---
# 训练队列:重配额 + 借出
apiVersion: kueue.x-k8s.io/v1beta2
kind: ClusterQueue
metadata:
  name: training
spec:
  namespaceSelector:
    matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: In
        values: [training, ml-jobs]
  cohort: ai-platform
  queueingStrategy: BestEffortFIFO
  admissionChecksStrategy:
    admissionChecks:
      - name: prov-check
        onFlavors: [gpu-h100]
  resourceGroups:
    - coveredResources: ["nvidia.com/gpu", "cpu", "memory"]
      flavors:
        - name: gpu-h100
          resources:
            - {name: nvidia.com/gpu, nominalQuota: 16, borrowingLimit: 8, lendingLimit: 4}
            - {name: cpu,         nominalQuota: 200}
            - {name: memory,      nominalQuota: 800Gi}
---
# 推理队列:轻配额,可以从 Cohort 借
apiVersion: kueue.x-k8s.io/v1beta2
kind: ClusterQueue
metadata:
  name: inference
spec:
  namespaceSelector:
    matchExpressions:
      - key: kubernetes.io/metadata.name
        operator: In
        values: [serving]
  cohort: ai-platform
  queueingStrategy: StrictFIFO
  resourceGroups:
    - coveredResources: ["nvidia.com/gpu", "cpu", "memory"]
      flavors:
        - name: gpu-h100
          resources:
            - {name: nvidia.com/gpu, nominalQuota: 4, borrowingLimit: 12}
            - {name: cpu,         nominalQuota: 64}
            - {name: memory,      nominalQuota: 256Gi}
```

### 7.3 LocalQueue + 一个弹性 Ray 任务

```yaml
---
apiVersion: kueue.x-k8s.io/v1beta2
kind: LocalQueue
metadata:
  namespace: training
  name: gpu-queue
spec:
  clusterQueue: training
---
# v0.20 的 RayService 零停机升级要求:
# 必须开 ElasticJobsViaWorkloadSlices + 打 elastic-job annotation
apiVersion: ray.io/v1
kind: RayService
metadata:
  namespace: training
  name: llm-serving
  annotations:
    kueue.x-k8s.io/queue-name: gpu-queue
    kueue.x-k8s.io/elastic-job: "true"      # RayServiceValidateUpgradeStrategy 默认开时必需
spec:
  upgradeStrategy:
    type: ZeroDowntime                       # 不想要零停机就显式设 None
  serveConfigV2: |
    applications:
      - name: app
        import_path: main:app
        route_prefix: /
        runtime_env:
          env_vars: {MODEL_ID: "meta-llama/Llama-3.1-70B"}
        deployments:
          - name: serve-deployment
            num_replicas: 4
            ray_actor_options:
              num_gpus: 1
  rayClusterConfig:
    workerGroupSpecs:
      - replicas: 4
        minReplicas: 0
        maxReplicas: 16
        groupName: gpu-workers
        template:
          spec:
            containers:
              - name: ray-worker
                image: rayproject/ray:2.45-py311-gpu
                resources:
                  limits:
                    nvidia.com/gpu: 1
                    cpu: 8
                    memory: 64Gi
                volumeMounts:
                  - name: dshm
                    mountPath: /dev/shm
            volumes:
              - name: dshm
                emptyDir:
                  medium: Memory
                  sizeLimit: 8Gi
```

### 7.4 验证 v0.20 的四个关键行为

```bash
# 1. 看 unadmitted 原因(UnadmittedWorkloadsObservability 默认开)
kubectl get workload -n training -o custom-columns=\
  NAME:.metadata.name,\
  QR:.status.conditions[?(@.type=="QuotaReserved")].status,\
  QR-REASON:.status.conditions[?(@.type=="QuotaReserved")].reason,\
  ADMITTED:.status.conditions[?(@.type=="Admitted")].status

# 期望输出示例:
# NAME            QR    QR-REASON                ADMITTED
# llm-serving-x1  True  ProvisionRequestCreated False
# train-job-42    False WaitingForQuota          False
# bad-spark       False Misconfigured             False

# 2. 看 AFS 锚点是否生效(Workload 停在 QuotaReserved 时 usage 就该涨)
kubectl -n kueue-system port-forward svc/kueue-controller-manager-metrics-service 8443:8443
curl -sk https://localhost:8443/metrics | grep -E \
  "kueue_local_queue_admission_fair_sharing_usage\{"

# 3. 看 DRA 设备未解析的原因(v0.20 新增)
kubectl get workload -n training -o jsonpath='{range .items[*]}\
  {.metadata.name}{"\t"}{.status.conditions[?(@.reason=="DRAResourcesUnresolved")].message}{"\n"}{end}'

# 4. kueuectl: v0.20 新增 ACTIVE 列 + --active 过滤
kubectl kueuectl list localqueue -n training -o wide
kubectl kueuectl list localqueue -n training --active=true
kubectl kueuectl list clusterqueue -o wide      # ACTIVE + REASON 列

# 5. 查看抢占目标重算指标(诊断抢占循环)
curl -sk https://localhost:8443/metrics | grep preemption_target_recomputations
```

### 7.5 Python:批量检查所有 Workload 的卡住原因

```python
#!/usr/bin/env python3
"""v0.20 的 UnadmittedWorkloadsObservability 让批量诊断变成一次 API 调用。"""
import subprocess, json, collections, sys

def workload_reasons(namespace: str = "") -> dict[str, str]:
    cmd = ["kubectl", "get", "workload", "-A" if not namespace else "-n", namespace,
           "-o", "json"]
    out = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout
    items = json.loads(out)["items"]
    reasons = collections.Counter()
    stuck = []
    for it in items:
        conds = {c["type"]: c for c in it["status"].get("conditions", [])}
        adm = conds.get("Admitted", {})
        if adm.get("status") == "True":
            continue
        qr = conds.get("QuotaReserved", {})
        reason = qr.get("reason") or adm.get("reason") or "Unknown"
        reasons[reason] += 1
        if reason in {"WaitingForQuota", "ExceedsMaxQuota", "Misconfigured",
                      "DRAResourcesUnresolved", "Pending"}:
            stuck.append((it["metadata"]["namespace"], it["metadata"]["name"], reason))
    return {"by_reason": dict(reasons), "stuck": stuck}

if __name__ == "__main__":
    ns = sys.argv[1] if len(sys.argv) > 1 else ""
    r = workload_reasons(ns)
    print(json.dumps(r["by_reason"], indent=2, ensure_ascii=False))
    print(f"\n需要人工介入的 Workload: {len(r['stuck'])}")
    for ns_, name, reason in r["stuck"][:20]:
        print(f"  {ns_}/{name}: {reason}")
```

**这个脚本能跑起来本身就是 v0.20 最大的运维改进**——v0.19 里 `reason` 字段不存在,同样的脚本只能输出一堆 `Unknown`。

---

## §8 横向对比:5 套批处理 / GPU 调度方案 17 维度

| 维度 | Kueue v0.20 | YuniKorn 1.7 | Volcano 1.12 | K8s Scheduler + priority | Run:AI(商业) |
|------|-------------|-------------|-------------|--------------------------|--------------|
| 定位 | 配额准入层,叠在 kube-scheduler 之上 | 替代型调度器 | 替代型调度器 | 原生 | 商业 GPU 平台 |
| 是否替换 scheduler | 否(只 gate) | 是 | 是 | — | 部分 |
| 配额层级 | ClusterQueue → Cohort → LocalQueue,层级式借用 | queue → user → group 层级 | queue + hierarchy | ResourceQuota(命名空间级,无层级) | project / team / user |
| 公平共享算法 | DRS + AFS,衰减窗口可配(默认 168h 半衰期) | DRF | DRF / fair-share 插件 | 无(只有 priority) | 基于 credit |
| **记账锚点** | **QuotaReserved(v0.20 起),含 AdmissionCheck 占用** | 分配时 | 分配时 | N/A | 分配时 |
| GPU 支持 | extended resource + DRA + DeviceTaint 可行性 | extended resource | extended resource | extended resource | extended resource + 分片 |
| DRA 支持 | **有,含节点设备可行性 + taint** | 部分 | 无 | 有(1.34+) | 有 |
| 拓扑感知(TAS) | **有,domain + 节点级可行性(v0.20)** | 有 | 有 | 无 | 有 |
| 任务类型 | Job / MPIJob / RayJob / RayService / Spark / JAX / TrainJob / LWS / AppWrapper / Pod group | Pod / Job / Spark / Flink | 几乎所有 training CRD | 全部 | 全部 |
|gang 调度 | 通过 PodSet / LWS group | 原生 | 原生(核心卖点) | 无 | 有 |
| 弹性(scale-from-zero) | **ElasticJobsViaWorkloadSlices + ProvisioningRequest** | 有 | 有 | 无 | 有 |
| 多集群 | **MultiKueue(管理集群 + worker 集群)** | 无(单集群) | 无 | 无 | 有 |
| 抢占 | 有,可配置策略 + v0.20 可自定义额外抢占目标 | 有 | 有 | 有(优先级) | 有 |
| 可观测性 | **UnadmittedWorkloadsObservability 默认开,reason 进 condition** | metrics + UI | metrics | 有限 | 完整 UI |
| 社区 | Kubernetes SIG Autoscaling(官方) | Apache | CNCF | Kubernetes 核心 | 商业 |
| 侵入性 | 低(webhook + gate,不接管调度) | 高(替换调度器) | 高(替换调度器) | 无 | 中 |
| 升级风险 | v0.20 高(6 条启动失败级 Actions Required) | 中 | 中 | 低 | 由厂商承担 |

**选型的一句话**:

- **已经在用 K8s 原生调度器,只想加配额管理 + 公平共享** → Kueue。不替换 scheduler,侵入性最低,MultiKueue 是唯一选项里多集群做得认真的
- **需要 gang 调度做分布式训练,且想要一个完整的调度器** → Volcano。gang scheduling 是它的核心卖点,生态最全
- **YARN 存量迁移 / 需要细粒度层级队列** → YuniKorn
- **只是想要「不同团队别互相抢资源」** → ResourceQuota + LimitRange + priority class 够了,别上调度器

---

## §9 6 条 6-12 月可验证硬指标

每条都能在今天用 v0.20.0 的集群 + 已有工具复现。

**1. AFS 锚点:QuotaReserved 阶段 usage 累加**

构造一个带 ProvisioningRequest AdmissionCheck 的 Workload,在它 `QuotaReserved=True / Admitted=False` 期间,`kueue_local_queue_admission_fair_sharing_usage` 必须非零且在增长。v0.19 同期该指标为 0。

**2. sub-milli 累加:长半衰期下 usage 不再恒为 0**

配 `usageHalfLifeTime: 168h`,跑一个持续请求 100m CPU 的 workload 6 小时,`consumedResources` 的 cpu 字段必须大于 0。v0.19 在此配置下**永久为 0**,公平共享退化为优先级排序。

**3. DRA 设备可行性:配额够但设备不可用时拒绝 admit**

在一个节点上用 DeviceTaintRule taint 掉所有 GPU,提交一个请求 GPU 的 DRA Workload。v0.20 必须报 `DRAResourcesUnresolved` / 可行性拒绝,而不是 QuotaReserved 后永久卡住。移除 taint 后必须自动 requeue 并 admit(#16098)。

**4. TAS 节点级可行性:domain 够但单节点不够时拒绝**

Topology 最低层设为 `example.com/rack`,一个 rack 内两个节点各 4 GPU。提交要 6 GPU 且要求同 rack 的 Workload。v0.20 必须拒绝(因为没有任何单节点有 6 GPU);把 Topology 最低层改成 `kubernetes.io/hostname` 后行为应保持一致(显式声明时 usage 归因精确)。

**5. 数值饱和:超大 transformation 系数不回绕**

配一个 resource transformation,让乘积超过 int64 上限。v0.20 必须饱和到 int64 max 而不是回绕成负数再被 floor 成 0。可用 `kubectl apply -f` 一个极端系数的 ClusterQueue 后检查 Workload 的 `status.assignedFlavors` 是否记账非零。

**6. LWS 不可变性:改 size 被 webhook 拒绝**

apply 一个 Kueue 管理的 LeaderWorkerSet,size=2,等 admit 后尝试 patch size=10。v0.20 必须被 validating webhook 拒绝(`LWSImmutableGroupSize` Beta 默认开),报 `spec.leaderWorkerTemplate.size: Invalid value`。关掉 gate 后同样的 patch 会成功——**但恢复了 quota bypass,不要在生产关**。

---

## §10 5 步生产升级 checklist

**Step 1:升级前 24 小时,只读**

```bash
# 确认当前 Kueue 版本与 API 版本分布
kubectl get pods -n kueue-system -o jsonpath='{.items[0].spec.containers[0].image}'
kubectl get clusterqueues,localqueues,topologies,resourceflavors,workloads -A \
  -o jsonpath='{range .items[*]}{.apiVersion}{"\n"}{end}' | sort | uniq -c

# 如果有任何 v1beta1 行:Step 2 必须做
```

**Step 2:跑 v1beta1 → v1beta2 迁移脚本(不可跳过)**

```bash
# 在升级到 v0.20 之前跑
curl -sO https://raw.githubusercontent.com/kubernetes-sigs/kueue/main/hack/migrate-to-v1beta2.sh
chmod +x migrate-to-v1beta2.sh
# 先 dry-run 看会改什么
./migrate-to-v1beta2.sh --dry-run
./migrate-to-v1beta2.sh
```

**跳过的后果**:已存在对象的存储版本仍是 v1beta1,API server 不再提供 v1beta1,Kueue 读不到它们,所有现有队列配置和排队 Workload 对 Kueue 变成「不存在」。

**Step 3:预先抬配额 + 改配置**

```bash
# Spark 用户:cores 与默认 memory overhead 现在计入配额
# 每个 Pod 现在预留 cores 作为 CPU + 至少 384Mi 额外内存
# 先抬配额再升级,否则所有 Spark 任务卡 pending

# 检查 DRA mapping 有没有用保留资源名
kubectl get kueueconfiguration -o yaml | grep -B2 -A2 '"pods"'

# 检查 metrics selector 是否有效
kubectl get kueueconfiguration -o yaml | grep -A5 localQueueMetrics

# 检查 feature gate 组合(关 AFS 时必须同时关锚点 gate)
kubectl get kueueconfiguration -o jsonpath='{.featureGates}'
```

**Step 4:金丝雀升级 + 验证不回归**

```bash
# 拉新镜像(确认 Helm chart 版本与 Kueue 版本对齐)
helm upgrade kueue kueue/kueue --namespace kueue-system \
  --set manager.image.tag=v0.20.0 --wait

# 验证 controller manager 起来了
kubectl get pods -n kueue-system
kubectl logs -n kueue-system -l app.kubernetes.io/component=controller -f | head -50

# 验证升级前后 pending workload 数量没突变
kubectl get workload -A -o jsonpath='{.items[?(@.status.conditions[?(@.type=="Admitted")].status!="True")]}' | jq length
```

**Step 5:逐项开新能力**

```yaml
# 开 DRA 设备可行性(先在测试集群)
apiVersion: kueue.x-k8s.io/v1beta2
kind: KueueConfiguration
featureGates:
  - name: KueueDRADeviceFeasibility
    enabled: true
  - name: KueueDRAIntegrationDeviceTaints
    enabled: true
  # TASNodeFeasibilityForAllLevels / TASCacheTopologyTree / LWSImmutableGroupSize
  # / UnadmittedWorkloadsObservability / WorkloadPriorityClassDefaulting
  # / AdmissionFairSharingAnchorAtQuotaReservation 已默认开启,不用配
```

**回滚注意**:回滚到不认识 `AdmissionFairSharingAnchorAtQuotaReservation` 的版本前,**必须先从配置里删掉这个 gate**,否则旧版本启动失败。

---

## §11 8 个诚实边界

写深度文章不夸大比写亮点难。以下是 v0.20.0 里我确认存在、但不能当卖点讲的的东西:

**1. `TASNodeFeasibilityForAllLevels` 不解决 usage 归因。** 在最低层非 hostname 的 Topology 上,把 domain usage 归因到具体 Pod 所在节点需要 **Pod 位置追踪**,v0.20 不做。domain 级 usage 仍是近似值。可行性精确了,记账精度没变。

**2. `KueueDRADeviceFeasibility` 是 alpha,默认关。** 生产用必须显式开,且要配 `KueueDRAIntegrationDeviceTaints` 才有 taint 检查。DRA 本身在 K8s 里也还在演进。

**3. `KueueDRAIntegrationPrioritizedList` 不检查备选可满足性。** 作者明说 "Kueue does not check that any alternative is satisfiable",且 **MultiKueue 不支持 `firstAvailable` 请求**。

**4. `FairSharingRefill` 是 alpha 且有已知风险。** 开 `FairSharingReevaluatePreemptionCandidates` 可能加剧 issue #14543 的抢占循环问题。release notes 里作者自己标注了这个权衡。

**5. `ElasticJobsViaWorkloadSlicesForProvisioningRequests` 是 alpha 默认关。** 弹性任务 + ProvisioningRequest 的组合目前是 alpha 级。

**6. MultiKueue 的 Ray 零停机升级只同步 `serveConfigV2`。** `rayClusterConfig` / `upgradeStrategy` 的变更**尚未传播**(#14036 明确)。

**7. `TASReplaceMultipleFailedNodes` 是 alpha 默认关。** 多节点失败增量替换目前不是默认行为。

**8. Spark 内存值必须用 Java 格式。** `512Mi` 这类 Kubernetes 风格值被 reject,只能用 `512m` / `2g`。这是一个真实的迁移摩擦点,不是 bug 但会咬人。

**外加一条已知的未修问题**:`kueue.x-k8s.io/podset-topology-spreading` 的 subGroupCount 负数校验刚从 warning 升级到 reject(#13108),但**旧的 Topology 对象里已存在的负值不会自动修正**,需要手动检查。

---

## §12 3 个长期判断

**判断一:配额记账的「精确化」会成为所有调度器的竞争维度。**

v0.20.0 里最有信息量的不是任何单个 feature,而是**这一整批修复的共同方向**:记账锚点上移、设备可行性前置、节点级可行性、饱和算术、sub-milli 保留。这些改动没有一个会让 benchmark 变好看,但每一个都在回答同一个问题:**「我扣的配额,和集群里真实发生的事,是不是一致?」**

2025-2026 年这波 AI 基础设施浪潮里,「能调度 GPU」已经不是差异化——Volcano、YuniKorn、Run:AI 都能。差异化变成**「配额账本可信度」**:一个多租户共享集群,如果租户能通过慢 AdmissionCheck 搭便车、能通过数值边界让配额归零、能通过改 LWS size 绕过配额,这个集群的公平共享承诺就是一句空话。**Kueue v0.20.0 的 80 KB release notes,本质是在把「公平共享」从「一个排序算法」升级为「一份可审计的账本」。**

**判断二:「启动期拒绝」会成为 K8s 控制器的默认契约。**

v0.20.0 有 5 处新增的启动期拒绝。这个模式的代价是升级变难(升级前必须改配置),收益是消灭「配了但没生效」这个反模式。

这与 2026 年这一波基础设施 release 的整体方向完全一致:Caddy v2.11.6 把默认值全部朝严厉方向改、Rust 1.99 把UnsafeCell 访问规则写进规范、Vitess v24 让 CRL 缺失在启动期就 os.Exit、Keycloak 26.8 把 14 条 breaking change 从静默放行改成显式拒绝。**「让错误配置尽早爆炸」正在取代「尽量兼容」成为默认设计哲学**,因为「静默错误配置」在 AI 算力这种昂贵资源上,代价是真实的钱。

**判断三:MultiKueue + WorkloadSlices 是 Kueue 对 AI 训练工作负载的真正押注。**

看 PR 体量分布:v0.20 里最大的几个 PR 是 Ray 集成(#14670,+15737/-0)、WorkloadSlices 弹性(#15503 +1392、#15402 +1235、#15434 +1274)、TAS Topology Spreading(#14820 +4585)、TAS 节点可行性(#14191 +1858)、DRA 设备可行性(#15577 +2585)。

**这不是巧合。** AI 训练工作负载的三个特征——**长时间占用 GPU(需要公平共享记账准确)、拓扑敏感(需要 TAS)、弹性伸缩(需要 WorkloadSlices + ProvisioningRequest)**——恰好是这一版承重级改动的三个方向。加上 MultiKueue 在 v0.20 补齐的 worker 端 Ray in-tree autoscaling、serveConfigV2 同步、orchestrated preemption,多集群 GPU 池化的能力第一次完整起来。

**Kueue 的定位一直很清楚:不替换 kube-scheduler,做调度器之上的配额准入层。** 这个定位在 AI 算力时代有结构性优势——集群的调度能力(kube-scheduler / Volcano / YuniKorn)与配额治理(Kueue)可以正交演进。v0.20.0 把「配额治理」这一层做厚了一截。

---

## 写在最后

Kueue v0.20.0 的 80 KB release notes 里,最值得记住的不是任何一个 feature,而是**一个调度器从「尽力而为」走向「算得准」的样子**。

公平共享的记账锚点、DRA 设备的可行性前置、TAS 的节点级可行性、饱和算术与 sub-milli 保留——这四件事各自的体量都不算大,但它们共同改变了一件事:**Kueue 的配额账本第一次值得被信任。**

而代价写在 「Actions Required Before Upgrading」那一章里,标题后面跟着一句括号:**(No, really, you MUST read this before you upgrade)**。15 条里 6 条是启动失败或永久 pending。

这不是粗暴。这是**一个基础设施项目把「静默错误」变成「显式失败」必须付出的迁移成本**,而它选择让用户在升级时一次性付清,而不是让某个租户在生产环境的某个深夜发现配额账本一直是错的。

**升级前请跑迁移脚本。**

---

**数据来源**:Kueue v0.20.0 release notes(80,597 字符,github.com/kubernetes-sigs/kueue/releases/tag/v0.20.0,发布于 2026-09-30);PR #14558 / #15000 / #14154 / #13279 / #14191 / #15833 / #13621 / #13573 / #13802 / #14042 / #14100 / #16111 / #14405 / #16329 / #14143 / #13810 / #13175 / #13375 / #13063 的 PR body 与 patch diff(patch-diff.githubusercontent.com);Kueue KEP 2941(DRA)文档。
