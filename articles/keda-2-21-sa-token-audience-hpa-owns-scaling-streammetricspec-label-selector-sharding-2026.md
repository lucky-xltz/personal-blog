---
title: "KEDA v2.21.0 深度拆解:SA token audience 强制 + HPA 接管伸缩决策时停止轮询 + StreamMetricSpec 动态改 target + label selector 分片,事件驱动伸缩层从「默认信任」变成「显式授权」"
date: 2026-10-08
category: 技术
tags: [KEDA, Kubernetes, 事件驱动伸缩, HPA, ScaledObject, ScaledJob, TriggerAuthentication, ClusterTriggerAuthentication, SA token, audience, CVE-2026-77524, GHSA-637c-6jxx-4rwm, 权限提升, 多租户, controller sharding, label selector, WATCH_LABEL_SELECTOR, StreamMetricSpec, external scaler, gRPC, pollingInterval, idleReplicaCount, minReplicaCount, cached metrics, scaler 生命周期, context 传播, Kubernetes API 超时, metric cache, HPAActive condition, Azure Pipelines, scaleOnInFlight, Temporal scaler, Rules-Based Versioning, RabbitMQ, 空队列排空, Kafka lag, retention, Prometheus OAuth2, Kerberos credential cache, Cosmos DB Change Feed, ClickHouse, GCP Cloud Spanner, Metrics API scaler, fail-closed, 默认值收紧, BreakingChange, K8s, 弹性伸缩, 成本治理, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1640532432846-2e7c40b1c8ac?w=600&h=400&fit=crop
excerpt: "2026 年 9 月 23 日发布的 KEDA v2.21.0 是这个 CNCF 毕业级事件驱动伸缩项目历史上默认值收紧最彻底、多租户信任边界第一次被写成代码的一个版本。49.7 KB 的 release notes 开篇就是一条 CVSS 9.9 的 critical:CVE-2026-77524 —— 一个命名空间管理员在自己命名空间里建一个 TriggerAuthentication 加一个 ScaledObject,就能让 KEDA operator 把自己的 ServiceAccount token 发到租户指定的 URL 上。这个 token 持有全集群 get 所有 Secret、集群级创建 Job、改 validatingwebhookconfigurations、改 apiservices 的权限,等于 namespace admin 直接变 cluster admin。更值得注意的是它是 CVE-2025-68476 的「修复未完成」:上一版的内容过滤器只要求加载进来的文件是一个 subject 以 system:serviceaccount: 开头的 JWT,而 operator 自己的 projected token 天然就是这个形状,过滤器等于没拦。核心是五条主线:① 安全层 SA token audience 从「发出去就行」变成「必须显式声明发给谁」,三个 breaking change 里第一个就是它;② 伸缩决策权归属显式化 —— 当 minReplicaCount 大于 0、没开 idle、trigger 又不依赖缓存指标时,HPA 已经完全接管伸缩,KEDA 自己的 scale loop 对副本数没有任何贡献,pollingInterval 纯空转,2.21 让它自动停掉;③ StreamMetricSpec 让 external scaler 用 server-streaming RPC 动态改 HPA target,不用再改 ScaledObject;④ controller sharding by label selectors 让一个 operator 实例只管带特定标签的对象,API server 层就过滤掉;⑤ scaler 生命周期从「context 各建各的」变成 context 一路贯穿 factory / refresh / 关闭,外加 Kubernetes API 超时第一次进 scaling loop。文章按「伸缩决策权归谁 + 租户能信任到什么程度」主线拆完五条线,附 5 段可运行的 YAML / kubectl / Go proto / Python 代码、5 套伸缩方案 17 维度对比、6 条 6-12 月可验证硬指标、5 步生产升级 checklist、8 个诚实边界与 3 个长期判断。"
---

# KEDA v2.21.0 深度拆解:伸缩决策权归谁,租户能信任到什么程度

> 2026 年 9 月 23 日,KEDA v2.21.0 发布。release notes 正文 **49.7 KB**,开头不是新 scaler、不是性能优化,而是一条加粗的 `> [!IMPORTANT]`:**KEDA 2.21.0 contains three breaking changes.** 三条里第一条的标签是 **Security**,挂的是 CVE-2026-77524 / GHSA-637c-6jxx-4rwm,CVSS **9.9 critical**。

KEDA 是 CNCF 毕业级的事件驱动伸缩项目,干一件事:**让 Kubernetes workload 跟着外部事件量伸缩**。Kafka 队列堆积了就加 Pod,RabbitMQ 消息清零了就缩到 0,Prometheus 指标过阈值了就扩。它的位置很微妙——不替代 HPA,而是**站在 HPA 前面**:KEDA 负责「什么指标、什么触发条件、什么时候激活」,然后把外部指标喂给 HPA,HPA 算出副本数。ScaledJob 则连 HPA 都不要,自己算 Job 数。

这个位置决定了它天然是多租户的信任枢纽。KEDA operator 是**集群级**部署的:一个 operator 实例,管整个集群所有命名空间的 ScaledObject。每个命名空间的租户都能在自己命名空间里建 ScaledObject 和 TriggerAuthentication,告诉 operator「去查我这个 Kafka 的 lag」「用我这个 Vault 地址拿凭据」。operator 拿着自己的 ServiceAccount——一个持有集群级 `["*"]/["*"] get`、`batch/jobs` 集群级 create、`validatingwebhookconfigurations` update 的身份——去执行租户指定的动作。

**v2.21.0 的全部承重级改动,都在回答同一个问题:这个集群级身份,凭什么信租户指定的目标?**

---

## 〇、三层穿透:早间算账 → 中午配额 → 晚间弹性

| 栈层 | 2026-10-08 的文章 | 核心动作 | 同一个设计模式 |
|------|-------------------|----------|----------------|
| **AI 商业层**(早间) | AI 日报「五维算账日」 | Claude Haiku 5.5 十万 token 内砍九成、微软员工 AI 月预算从十万美元砍到一万美元、Meta Claude Code 用户六万砍到三万但账单没砍 | **成本成为第一约束**,能力不再免费 |
| **GPU 配额调度层**(中午) | Kueue v0.20.0 | 记账锚点从 admitted 上移到 quota reservation,卡在 AdmissionCheck 上的 workload 不能一边占 GPU 一边让系统觉得没在用 | **把「大概在用」变成「精确在用」**,记账锚点上移 |
| **事件驱动伸缩层**(晚间,本文) | KEDA v2.21.0 | SA token 必须声明 audience;HPA 接管决策时停止空轮询;metric cache 只在停止时删 | **把「默认信任」变成「显式授权」**,决策权归属写进代码 |

三层的叙事主线是一条:**成本砍下去之后,每一张卡、每一个副本、每一次 API 调用都得算清楚。** 早间是商业层的算账(价格砍九成,预算砍九成),中午是配额层的算账(Kueue 把 GPU 配额的记账锚点上移,让「占着不用」不再可能),晚间是弹性层的算账(KEDA 把伸缩决策权归谁、租户能信任到什么程度,从隐含约定写成显式契约)。

中午那篇 Kueue 的关键词是**记账锚点**:之前一个 workload 进了 admitted 状态就开始占配额,现在改成分配 quota reservation 时才占——卡在 AdmissionCheck 上的 workload 再也不能一边占着 GPU 一边让公平共享觉得它没在用。本文的关键词是**决策权归属**:之前 KEDA 的 scale loop 不管自己还有没有发言权,都按 pollingInterval 去查 trigger;现在它先问自己「我还能改变副本数吗」,不能就不查。中午治的是「配额空占」,本文治的是「轮询空转」。**两者都是把「隐含的默认行为」翻成「显式的语义」。**

这也是 2026 年下半年基础设施层的一致方向。10-03 那天 Rust 1.99 把 UnsafeCell 访问规则和 Pin 的五条要求写进规范,同一天 Caddy v2.11.6 把头部白名单从 `allow_*` 改成 `expected_*`,前一天苹果把 macOS Full Disk Access 改成要求「very explicit user action」。**信任边界正在从「默认开放 + 黑名单」全面转向「默认关闭 + 显式声明」。** KEDA v2.21.0 是这条线在伸缩层的落地。

---

## 一、问题的源头:一个集群级 operator 和无数个租户指定的目标

要理解 CVE-2026-77524 为什么是 critical,得先看清 KEDA 的信任模型长什么样。

### 1.1 operator 的权限有多大

KEDA 的默认部署给 operator 的 ClusterRole 大概长这样(节选自 `keda-2.20.0.yaml`):

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: keda-operator
rules:
- apiGroups: [""]
  resources: ["events", "secrets", "configmaps", "pods", "services", "namespaces"]
  verbs: ["get", "list", "watch"]
- apiGroups: ["apps"]
  resources: ["deployments", "statefulsets"]
  verbs: ["list", "watch", "update"]   # 缩放靠 update scale subresource
- apiGroups: ["batch"]
  resources: ["jobs"]
  verbs: ["list", "watch", "create", "delete"]
- apiGroups: ["autoscaling"]
  resources: ["horizontalpodautoscalers"]
  verbs: ["create", "list", "watch", "update", "patch", "delete"]
```

关键的几条:`secrets` 集群级 get(它要替租户从 Secret 里拿凭据),`jobs` 集群级 create(ScaledJob 要建 Job),`horizontalpodautoscalers` 集群级增删改(它替每个 ScaledObject 建一个 HPA)。advisory 里列得更直接:这个 token 持有 `["*\"]/["*"] get` 集群级、`batch/jobs` 集群级 create/delete、`*/scale` 任意 workload update、`validatingwebhookconfigurations` update、`apiservices` update。

最后两条是致命的:**能改 validatingwebhookconfigurations 就等于能重写或禁掉整个集群的准入控制;能改 apiservices 就等于能劫持聚合 API 路由。** 这已经不是「读点 Secret」的级别了。

### 1.2 租户能指挥 operator 干什么

KEDA 的租户工作流是文档化的:租户在自己命名空间建 ScaledObject(告诉它伸缩什么、触发条件是什么),需要凭据的 trigger 就建一个 TriggerAuthentication,指向 Secret、Azure Pod Identity、或者 HashiCorp Vault。

Vault 这条路径是问题所在。`spec.hashiCorpVault` 里有一个 `address` 字段,租户随便填;`authentication: kubernetes` 时 KEDA 用 Kubernetes auth 方式登录 Vault,默认拿 `credential.serviceAccount` 指定的 token——**如果不填,默认就是 operator pod 自己的 projected token**。

于是攻击链成立了:

```
租户建 TriggerAuthentication:
  spec.hashiCorpVault:
    address: http://fake-vault.tenant-a.svc:8200   ← 租户自己的 Service
    authentication: kubernetes
    mount: kubernetes
    role: poc
租户建 ScaledObject 引用它(cron trigger,什么 trigger 都行)
operator reconcile → 建 scaler → 解析 authenticationRef
  → 拿自己的 SA token
  → PUT 到 http://fake-vault.tenant-a.svc:8200/v1/auth/kubernetes/login
  → 请求体: {"jwt":"<operator 的 cluster-privileged token>","role":"poc"}
租户从 fake-vault 的日志里拿到 jwt
  → 用它当 kubeconfig
  → kubectl auth whoami → system:serviceaccount:keda:keda-operator
  → kubectl -n kube-system get secret <任意> ✅
  → kubectl -n kube-system create job pwn --image=busybox ✅
```

**整个链路里没有任何一步需要集群管理员权限。** 租户需要的只是:自己命名空间里 `triggerauthentications.keda.sh` 和 `scaledobjects.keda.sh` 的 create,加上内置的 `edit` ClusterRole——这是多租户集群里的标准配置。

### 1.3 为什么上一版的修复没修好

这不是 KEDA 第一次在这条路径上出事。2025 年的 **CVE-2025-68476 / GHSA-c4p6-qg4m-9jmr**(high)是**任意文件读**:`credential.serviceAccount` 可以填节点文件系统上的任意路径,KEDA 把文件内容读出来当 JWT 发给 Vault 地址,等于把节点上的 `/etc/passwd`、kubelet 凭据外带出去。

那一版的修复加了**内容过滤器**:读进来的文件必须是一个 JWT,且 subject 以 `system:serviceaccount:` 开头。思路是「我只接受长得像 SA token 的东西」。

advisory 对这个修复的评价就一句话:

> **its content filter only requires the loaded file to be a JWT whose subject begins with `system:serviceaccount:`, which the operator's own projected token satisfies by construction.**

operator 自己的 token **天然满足这个过滤器**。它就是一个 subject 为 `system:serviceaccount:keda:keda-operator` 的 JWT。过滤器防的是「读节点上的别的东西」,完全没防「读 operator 自己的 token」。而 destination 字段 `hashiCorpVault.address` **一直没做校验**。

这是一个特别值得记住的失败模式:**内容形状校验 ≠ 授权校验。** 「这东西长得像 token」跟「这个租户有权用这个 token」是两个问题,上一版修了前者,以为是后者。

finder 在 advisory 里注明了验证环境:kind v1.31.2,KEDA v2.20.0,从**未修改的官方 release manifest** 装的,默认设置。不是什么非默认配置下的边缘 case。advisory 的 **Workarounds** 字段写的是:**None。** 没有临时缓解,只能升级。

---

## 二、修复:SA token audience 从「发出去就行」变成「必须声明发给谁」

### 2.1 修法

v2.21.0 的修复思路不是继续加内容过滤,而是换了一个维度:**校验 audience(受众)**。

Kubernetes 的 projected ServiceAccount token 是支持 audience 的。一个 token 只能用于特定的受众(api 接收方),TokenRequest 时声明,API server 在认证时校验。KEDA 2.21 强制:用 `boundServiceAccountToken` 的 TriggerAuthentication,token 的 audience 必须显式声明,而且**必须是 KEDA 自己认可的 audience**。

breaking change 的描述是:

> **Security**: Enforce explicit service account token audiences to prevent TriggerAuthentication privilege escalation

影响面在 release notes 里写得很具体,四类配置全部命中:

- **Vault Kubernetes 认证**,包括用 operator token 的、用已有 projected token 的、用 `credential.serviceAccountName` 的;
- **任何使用 `boundServiceAccountToken` 的 TriggerAuthentication 或 ClusterTriggerAuthentication**;
- 因此受影响的集成:**Metrics API、Prometheus、Loki、Datadog Cluster Agent**,以及所有 token-authenticated receiver。

**不受影响的**:普通 Vault token 认证、API key、OAuth 凭据,以及任何不用 bound SA token 的认证方式。

迁移指南在 `https://keda.sh/docs/2.21/migration/#service-account-token-audiences`。

### 2.2 为什么 audience 是对的维度

内容过滤和 audience 校验的区别,本质是**「这是什么」和「这是给谁的」**的区别。

| 校验维度 | 问的问题 | 能拦住什么 | 拦不住什么 |
|----------|----------|------------|------------|
| 文件内容形状(上一版) | 这东西是 JWT 吗?subject 对吗? | 读节点上的非 token 文件 | operator 自己的 token 被外带 |
| destination 白名单(未做) | 这个地址允许吗? | 未知的 Vault 地址 | 合法地址上的恶意 listener |
| **audience(本版)** | **这个 token 是声明给这个接收方的吗?** | **token 被带到任意第三方** | —— |

audience 的优雅之处在于它是**密码学层面的绑定**,不是模式匹配。token 在签发时就声明了 audience,接收方在认证时由 Kubernetes API server 校验。租户就算拿到了 token,想把它送到别的地方,API server 那一关就过不去。

但要注意它不是银弹。advisory 的根因分析写得很清楚:

> A namespace tenant should not be able to make the operator authenticate to a tenant-controlled server using the operator's own cluster-privileged identity.

**根因是「operator 用自己的集群特权身份去租户指定的服务器认证」。** audience 校验解决的是「token 带出去也没用」,但「operator 的身份应不应该出现在租户的认证请求里」这个更 upstream 的问题,靠 audience 是堵不住的——它只是让这个身份的 token 在别处不可用。真正彻底的解法是 operator 不该默认用自己的 token 去做租户的 Vault 登录(`credential.serviceAccount` 的默认值本身就不该指向 operator 自己),这一步在 2.21 里通过强制显式化向前推了一大截,但默认值本身还需要后续版本继续收。

### 2.3 升级前必须做什么

```bash
# 1. 找出所有用 boundServiceAccountToken 的 TriggerAuthentication
kubectl get triggerauthentications.keda.sh -A -o json \
  | jq '.items[] | select(.spec.boundServiceAccountToken != null)
        | {ns: .metadata.namespace, name: .metadata.name, aud: .spec.boundServiceAccountToken.audience}'

# 2. 找出所有用 Vault Kubernetes 认证的(这一类强制受影响)
kubectl get triggerauthentications.keda.sh -A -o json \
  | jq '.items[] | select(.spec.hashiCorpVault.authentication == "kubernetes")
        | {ns: .metadata.namespace, name: .metadata.name, addr: .spec.hashiCorpVault.address}'

# 3. 找出引用它们的 ScaledObject / ScaledJob
kubectl get scaledobjects.keda.sh -A -o json \
  | jq '.items[] | select(.spec.triggers[].authenticationRef != null)
        | {ns: .metadata.namespace, name: .metadata.name}'
```

升级顺序很重要:**先改 TriggerAuthentication 加 audience,再升级 KEDA**,否则升级后 scaler 会因为 audience 校验失败而解析不了元数据,直接不工作。

---

## 三、伸缩决策权归属:HPA 接管时,轮询必须停

第二个承重级改动是整个版本里最有「架构感」的一条,因为它第一次显式地问了一个之前没人问的问题:**KEDA 的 scale loop,在什么情况下对副本数根本没有发言权?**

### 3.1 问题的形态

KEDA 的伸缩路径有两条:

- **ScaledObject**:KEDA 建一个 HPA,把 trigger 的外部指标通过 External Metrics API 喂给 HPA,**HPA 算副本数**。KEDA 的 scale loop 只负责「激活/去激活」(0 到 1 的开关)和给 HPA 供指标。
- **ScaledJob**:不要 HPA,KEDA 自己算 Job 数。

问题出在 ScaledObject 上。KEDA 的 scale loop 默认每 `pollingInterval`(默认 30 秒)跑一圈,去查所有 trigger 的指标,算出 `isActive` 和 metric 值。但在下面这个配置里:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-with-floors
  namespace: prod
spec:
  scaleTargetRef:
    name: worker
  minReplicaCount: 2      # ← 永远不会缩到 0
  maxReplicaCount: 20
  pollingInterval: 30
  triggers:
  - type: prometheus
    metadata:
      serverAddress: http://prometheus:9090
      query: http_requests_total
      threshold: "100"
    useCachedMetrics: false   # ← 不依赖 KEDA 缓存
```

这个 ScaledObject **不可能缩到 0**(minReplicaCount=2),也没开 idle mode。也就是说:

- **KEDA 的 scale loop 对副本数没有任何发言权**——它既不能把副本数从 2 拉到 0,也不能从 2 拉到别的数,那些全是 HPA 在算。
- **HPA 自己每个评估周期都会去查 External Metrics API**,查到的就是 KEDA 刚算好的同一个指标。

于是 `pollingInterval` 在这里**完全是空转**。operator 每 30 秒去 Prometheus 拉一次 query,算一遍,写进缓存,然后 HPA 再通过 External Metrics API 读一遍。**同一条 Prometheus query 被查了两次。** 一个集群几千个 ScaledObject,就是几千倍的重复外部请求。

之前没人处理这个,因为「轮询总是安全的嘛,大不了浪费点资源」。但 2026 年的语境变了——早间的日报在讲成本砍九成,中午的 Kueue 在讲配额记账,**每一倍的外部请求都是实打实的成本和压力**。Prometheus 的 query rate、Kafka broker 的 fetch 压力、云厂商 metric API 的账单,全部翻倍。

### 3.2 修法:两个新方法显式化决策权

PR #8031 给 ScaledObject 类型加了两个方法,把「谁能决定副本数」写成代码:

```go
// IsPollingIntervalRelevant reports whether KEDA's own scale loop still needs to poll the triggers.
// Polling is only relevant when the scale loop can move the workload outside the HPA-managed
// range (scale to zero when minReplicaCount is 0, or to the idle replica count when idle mode
// is enabled), or when a trigger relies on cached metrics that the loop must refresh for the HPA.
// Otherwise the HPA drives all scaling and the scale loop has nothing to contribute, so pollingInterval
// has no effect.
func (so *ScaledObject) IsPollingIntervalRelevant() bool {
	minReplicas := int32(0)
	if so.Spec.MinReplicaCount != nil {
		minReplicas = *so.Spec.MinReplicaCount
	}
	if minReplicas == 0 || so.Spec.IdleReplicaCount != nil {
		return true
	}
	for _, trigger := range so.Spec.Triggers {
		if trigger.UseCachedMetrics {
			return true
		}
	}
	return false
}

// UsesHPAObservations reports whether the state of the ScaledObject may be derived from the metric
// observations of the HPA-driven metrics path instead of querying the trigger sources on KEDA's own
// scale loop. This is only allowed when pollingInterval is not relevant (see
// IsPollingIntervalRelevant): the HPA then drives all scaling and already queries every external
// metric itself, so querying the trigger sources on the scale loop would only duplicate those
// queries. ScaledObjects using scaling modifiers are excluded because trigger activity is then
// derived from the composite formula over all metrics at once.
func (so *ScaledObject) UsesHPAObservations() bool {
	return !so.IsPollingIntervalRelevant() && !so.IsUsingModifiers()
}
```

注释本身就是文档,这是这段代码最值得学的地方。**两个方法的注释把「什么时候轮询有意义」的完整决策树写进去了**,不是扔一个 bool 让调用方自己猜。

逻辑很清楚,pollingInterval 相关(还要继续轮询)只有三种情况:

| 条件 | 为什么还要轮询 |
|------|----------------|
| `minReplicaCount == 0`(含 unset) | scale loop 要负责缩到 0,这是 KEDA 独有的能力,HPA 不会缩到 0 |
| `idleReplicaCount != nil` | idle mode 下要缩到 idle 副本数,同样超出 HPA 管辖范围 |
| 任一 trigger `useCachedMetrics: true` | HPA 要读缓存指标,得有人去刷新缓存 |

**三个条件全不满足时,`UsesHPAObservations()` 返回 true,scale loop 直接从 HPA 的指标观测推导状态,不再查 trigger 源。**

第三个条件值得单独说。`useCachedMetrics` 是个容易被忽略的 trigger 字段。有些 trigger(比如 external-push 类的)不是每次去查,而是接收推送、维护一个缓存指标。这时候即使 minReplicaCount>0,KEDA 的 loop 仍然要负责刷新缓存,否则 HPA 读到的是陈旧值。**这个条件把「我的 trigger 依赖缓存」显式地跟「我要不要轮询」绑在一起**,之前这两件事是脱节的。

### 3.3 这条改动为什么是承重级

按 skill 里的承重级判据(改默认行为 / 解决历史遗留难题 / 引入新接口 / 性能 ≥ 2x / 推动生态跟进):

- **改默认行为** ✅:之前轮询无条件执行,现在按条件自动停。对 minReplicaCount>0 的生产负载(这是绝大多数),这是默认行为的实质改变。
- **解决历史遗留难题** ✅:重复外部请求问题存在了很多版本,文档里从来没说「pollingInterval 在这些情况下无效」。现在它变成了一个**可推理的语义**,而不是一个陷阱。
- **引入新接口** ✅:`IsPollingIntervalRelevant()` / `UsesHPAObservations()` 是类型上的新方法,其他控制器和工具可以直接用它们判断伸缩语义。
- **性能** ✅:对外部系统的请求数直接减半(对 Prometheus / Kafka / 云 metric API)。

**这也是今天这条叙事链的关键一环**:中午 Kueue 把「配额记账锚点」上移,让配额空占不再可能;本文把「伸缩决策权归属」显式化,让轮询空转不再可能。**两者都是把「默认在做但没在做有用的事」翻成「先问自己有没有用」。**

---

## 四、StreamMetricSpec:external scaler 动态改 HPA target

第三个承重级改动改的是 KEDA 生态的一个长期别扭:**external scaler 想改 HPA 的 target 值,必须改 ScaledObject。**

### 4.1 之前的别扭

KEDA 的 external scaler 是一个 gRPC 服务,实现 `GetMetricSpec` 和 `GetMetrics`。`GetMetricSpec` 返回 metric 的 target(比如 `averageValue: 100`)。但这个 spec 只在 ScaledObject 被 reconcile 时读一次。scaler 想动态调整 target(比如「现在高峰期,我把阈值从 100 提到 200」),只能:

1. 修改自己的状态;
2. 等 KEDA 下次 reconcile(触发条件是 ScaledObject spec 变化,或者 scaler cache 被清);
3. 或者让用户改 ScaledObject 的 trigger metadata。

对一个推模式的 scaler(external-push)来说,这尤其别扭:它已经在主动推 metric 值了,却推不了自己的 target。

### 4.2 修法:server-streaming RPC

PR #7794 在 external scaler proto 里加了一个可选的 **server-streaming** RPC:

```protobuf
service ExternalScaler {
  rpc GetMetricSpec(GetMetricSpecRequest) returns (GetMetricSpecResponse) {}
  rpc GetMetrics(GetMetricsRequest) returns (GetMetricsResponse) {}
  // 新增
  rpc StreamMetricSpec(GetMetricSpecRequest) returns (stream GetMetricSpecResponse) {}
}
```

KEDA 侧的实现是让 controller 监听一个 channel:

```go
// controllers/keda/scaledobject_controller.go
func (r *ScaledObjectReconciler) SetupWithManager(mgr ctrl.Manager, options controlleroptions.Options) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&kedav1alpha1.ScaledObject{}, builder.WithPredicates(...)).
		// Reconcile when an external-push scaler streams updated metric specs
		// (StreamMetricSpec), so the HPA is rebuilt from the freshly cached specs.
		WatchesRawSource(source.Channel(r.ScaleHandler.MetricSpecReconcileChan(), &handler.EnqueueRequestForObject{}))).
		Complete(r)
}
```

注释里写清了语义:**流式 spec 更新会触发一次 reconcile,HPA 从刚缓存的 spec 重建。**

这条路径的关键在于它**没有引入新的 KEDA CRD 字段**,也没有改 ScaledObject 的 spec。target 的动态性完全在 scaler 和 KEDA 之间流动,用户无感。这是一个好的接口设计:**把动态性放在协议层,而不是放在声明式 API 层。** Kubernetes 的声明式模型对「周期性变化的阈值」本来就不友好(每次变都得写 etcd,触发 reconcile 风暴),stream 绕开了这一点。

配套的还有 **PR #8199:external scaler gRPC client metrics**。之前 KEDA 对 external scaler 的调用是完全黑箱的——scaler 慢了、错了、连不上了,只能在日志里找。现在加了 client 侧的 gRPC 指标,可以监控每个外部 scaler 的延迟和错误率。这条跟 StreamMetricSpec 是配套的:**你把更多职责交给了外部 scaler,就得有相应的可观测性。**

---

## 五、Controller sharding:label selector 分片

第四个承重级改动是多租户规模的解法。

### 5.1 为什么要分片

KEDA 是**单 operator 管全集群**。所有命名空间的 ScaledObject / ScaledJob / TriggerAuthentication / ClusterTriggerAuthentication 都被一个实例 reconcile。规模大了有三个问题:

1. **一个慢的 scaler 阻塞所有租户**(这个在 2.21 里被 #8174 单独修了,见下一节);
2. **informer 缓存所有对象**,几百个租户 × 几十个 ScaledObject,内存压力全在一个 operator 上;
3. **没有租户隔离的故障域**,一个租户的 ScaledObject 抖动,全集群的 reconcile 都抖。

2.21 之前唯一的纵向扩展手段是 leader election,那只是高可用,不是分片。

### 5.2 修法:两个环境变量,API server 层过滤

PR #7816 的实现很干净。两个新的环境变量:

- **`WATCH_LABEL_SELECTOR`** —— ScaledObject / ScaledJob / 依赖它的资源按标签过滤;
- **`WATCH_LABEL_SELECTOR_FOR_TRIGGERAUTH`** —— TriggerAuthentication / ClusterTriggerAuthentication 单独过滤(因为 auth 对象的标签策略通常跟 workload 不同)。

实现上有两层,这个区分很重要:

```go
// pkg/util/watch.go

// labelSelectorPredicate turns a parsed label selector into a controller-runtime
// predicate. A nil selector means "no filter" and is represented by the
// zero-value Funcs{}, which returns true for every event.
func labelSelectorPredicate(ls *metav1.LabelSelector) (predicate.Predicate, error) {
	if ls == nil {
		return predicate.Funcs{}, nil
	}
	return predicate.LabelSelectorPredicate(*ls)
}

// labelSelectorByObject builds cache.ByObject entries applying the given
// selector to each object type at the API server's list/watch level.
// Returns nil if the selector is nil (no filtering).
func labelSelectorByObject(ls *metav1.LabelSelector, envVar string, objs ...client.Object) (map[client.Object]cache.ByObject, error) {
	if ls == nil {
		return nil, nil
	}
	// ...
}
```

**两层过滤**:

| 层 | 手段 | 作用 |
|----|------|------|
| **API server 层** | `cache.ByObject` 的 label selector,**list/watch 请求就带 selector** | 不匹配的对象**根本不发给 operator**,不占带宽不占缓存 |
| **controller 层** | `predicate.LabelSelectorPredicate` | 双保险,即使缓存里有不匹配的对象也不触发 reconcile |

API server 层过滤是关键。如果只在 controller 层过滤,对象还是会被 list/watch 传过来、进 informer 缓存,内存和带宽一点没省。**在 list/watch 层就过滤掉,才是真正的分片。**

所有控制器都加上了,ScaledObject / ScaledJob / TriggerAuthentication / ClusterTriggerAuthentication 各自的 `SetupWithManager`:

```go
// WATCH_LABEL_SELECTOR scopes this operator to ScaledObjects matching the selector.
// Empty or unset means watch everything (backward compatible).
labelSelectorPredicate, err := util.WatchLabelSelectorPredicate()
if err != nil {
	return err
}
```

注释里的 **"Empty or unset means watch everything (backward compatible)"** 是承重级改动的标配:**默认值保持旧行为,激进能力需要显式开启。** 这跟 2.21 的整体哲学一致(显式授权),也跟 2026 下半年整个生态的方向一致。

部署模式变成:

```yaml
# operator 分片 A:管带 shard=a 的对象
apiVersion: apps/v1
kind: Deployment
metadata:
  name: keda-operator-shard-a
  namespace: keda
spec:
  template:
    spec:
      containers:
      - name: keda-operator
        image: ghcr.io/kedacore/keda:2.21.0
        env:
        - name: WATCH_LABEL_SELECTOR
          value: "shard=a"
        - name: WATCH_LABEL_SELECTOR_FOR_TRIGGERAUTH
          value: "shard=a"
---
# operator 分片 B:管带 shard=b 的
# (同样的 Deployment,name=keda-operator-shard-b,value="shard=b")
---
# 租户给对象打标签
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: tenant-worker
  namespace: tenant-a
  labels:
    shard: a            # ← 由分片 A 的 operator 管
spec:
  # ...
```

注意 **TriggerAuthentication 有独立的 selector**。这是有意的:auth 对象的归属策略通常跟 workload 不同(比如所有租户的 auth 想集中给一个安全的 operator 分片管,workload 分片按租户分),所以给了独立开关。**两个环境变量而不是一个**,这个设计细节是真正考虑过租户场景的。

---

## 六、Scaler 生命周期:从「context 各建各的」到一路贯穿

第五个承重级改动是这一版修复密度最高的地方,四个 PR 合起来重构了 scaler 的生命周期管理。它不是单一革新,而是**把一个长期「能跑但不可控」的子系统改成了确定性的**。

### 6.1 context 传播(#8195)

之前 scaler 的工厂函数签名是:

```go
type ScalerBuilder struct {
	Scaler        scalers.Scaler
	ScalerConfig  scalersconfig.ScalerConfig
	Factory       func() (scalers.Scaler, *scalersconfig.ScalerConfig, error)
	CachedMetricSpecs []v2.MetricSpec
}
```

注意 `Factory func()` —— **没有 context 参数**。

后果是 scaler 在 refresh 时用的是 `context.Background()`。也就是说,一个 ScaledObject 被删除、scale loop 被取消时,**正在 refresh 的 scaler 不会被取消**。它还在那查 Kafka、查 Prometheus、查数据库。慢 scaler 的连接就这么泄漏着。

2.21 把签名改了:

```go
type ScalerFactory func(ctx context.Context) (scalers.Scaler, *scalersconfig.ScalerConfig, error)

type ScalerBuilder struct {
	Scaler        scalers.Scaler
	ScalerConfig  scalersconfig.ScalerConfig
	Factory       ScalerFactory
	CachedMetricSpecs []v2.MetricSpec
}
```

refresh 时把调用方的 ctx 传进去:

```go
// pkg/scaling/cache/scalers_cache.go
func (c *ScalersCache) refreshScaler(ctx context.Context, index int) (scalers.Scaler, *scalersconfig.ScalerConfig, error) {
	oldSb := c.Scalers[index]
	newScaler, sConfig, err := oldSb.Factory(ctx)   // ← ctx 传进去了
	if err != nil {
		return nil, err
	}
	// ...
}
```

测试也很直白地验证了语义(`TestScalersCache_RefreshUsesCallerContext`):用一个带标记值的 ctx 调 `refreshScaler`,断言 factory 收到的就是那个 ctx。**不是传了个 context 就行,是验证了「调用方的 context 真的到达了 scaler」。**

### 6.2 Kubernetes API 超时第一次进 scaling loop(#8174)

这条是这一版里「为什么之前没有」系列最让人意外的一条。

KEDA 有一堆 scaler 内部要调 Kubernetes API(Vault scaler 拿 config、Metrics API scaler、各种需要 list 的)。这些调用用的 client,超时是 **KEDA 自己管外部 HTTP 调用的 `globalHTTPTimeout`**,而不是 Kubernetes client 的超时。

`globalHTTPTimeout` 默认是 10 秒,但它管的是**外部 HTTP**。对于 Kubernetes API 调用,这个超时语义就不对——而且关键是,**慢的 Kubernetes API 调用会卡住整个 scaling loop**。一个租户的 trigger 因为 API server 慢卡住,后面所有租户的伸缩决策全排队等。

2.21 加了 `KEDA_KUBERNETES_API_TIMEOUT` 环境变量,并把它一路传进 ScaleHandler:

```go
// cmd/operator/main.go
kubernetesAPITimeout, err := resolveKubernetesAPITimeout()
if err != nil {
	setupLog.Error(err, "invalid KEDA_KUBERNETES_API_TIMEOUT")
	os.Exit(1)
}
// ...
scaledHandler := scaling.NewScaleHandler(mgr.GetClient(), scaleClient, mgr.GetScheme(),
	globalHTTPTimeout, kubernetesAPITimeout, eventRecorder, authClientSet)   // ← 新参数
```

ScaledJobReconciler 也加了 `KubernetesAPITimeout` 字段。**这是 Kubernetes API 超时第一次成为 scaling loop 的一等公民。**

为什么这个重要:HPA 的评估周期默认 15 秒,KEDA 的 pollingInterval 默认 30 秒。**如果一次 Kubernetes API 调用能卡住整个 loop,那一个慢调用就能让伸缩决策延迟到分钟级。** 在成本敏感的语境下(早间日报的主题),伸缩延迟 = 副本数偏高 = 成本。把超时显式化,是把「伸缩的延迟预算」变成可配置的。

### 6.3 metric cache 的语义被重新定义(#8073)

这个修复的注释把之前的行为写得明明白白:

```go
// ClearScalersCache invalidates the scalers cache for the input scalableObject.
// Metric records are kept; they are only deleted when the scalable object is stopped.
func (h *scaleHandler) ClearScalersCache(ctx context.Context, scalableObject kedav1alpha1.ScalableObject) error {
```

**「Metric records are kept; they are only deleted when the scalable object is stopped.」**

之前的语义是混乱的:清 scaler 缓存时,metric 记录也被清了。这导致一个具体的故障形态——scaler 出错时,之前缓存的**健康 trigger** 的 metric 记录也被一起干掉,HPA 突然读不到指标,副本数行为变得不可预测。

新语义是三层分离:

| 操作 | scaler 缓存 | metric 记录 |
|------|-------------|-------------|
| `ClearScalersCache`(scaler 重建、配置变更) | 清 | **保留** |
| scale loop context 取消(对象停止) | 清 | **删** |
| scaler 出错 | —— | **保留健康 trigger 的记录** |

具体的代码变更:

```go
// pkg/scaling/scale_handler.go
func (h *scaleHandler) DeleteScalableObject(ctx context.Context, scalableObject kedav1alpha1.ScalableObject) {
	// ...
	h.scaleLoopContexts.Delete(key)
	h.scaledObjectsMetricCache.Delete(key)     // ← 停止时才删 metric 缓存
	// ...
}

func (h *scaleHandler) startScaleLoop(...) {
	// ...
	case <-ctx.Done():
		logger.V(1).Info("Context canceled")
		h.scaledObjectsMetricCache.Delete(withTriggers.GenerateIdentifier())   // ← 同上
	// ...
}
```

配套的 #8067 把缓存删除改成同步的,修了 `CachedMetrics` 的并发 bug(之前异步删除,跟并发读比赛跑)。#8125 修了 **stale scaler cache**——缓存里的 scaler 跟当前配置不一致,用的还是老的。

**这三个修复合起来讲了一件事:metric 缓存之前是「跟 scaler 缓存同生共死」的,现在它的生命周期独立了,绑定到「scalable object 是否还在运行」这个语义上。** 这是一次真正的语义修正,不是打补丁。

### 6.4 三个并发 bug 与一个健康信号

这一版的 Fixes 区里,并发类修复密度很高,值得逐个看,因为它们都是同一个病因(`pkg/fallback` 和共享缓存里的 map 操作)的不同症状:

| PR | 症状 | 病因 |
|----|------|------|
| #7843 | `pkg/fallback` 里 **concurrent map iteration and map write** | 遍历 map 的同时另一个 goroutine 写 |
| #7911 | 共享根 CA `CertPool` 的 **concurrent map writes panic** | 多个 scaler 共享一个 CA pool,加载时并发写 map |
| #8126 | Metrics Service 的 **CA cert pool data race + monotonic growth** | 同上,而且只增不减 |
| #8067 | `CachedMetrics` 并发 bug | 缓存删除异步,跟并发读比赛跑 |

#7911 和 #8126 是同一类:KEDA 有一个**共享的根 CA 证书池**,所有 scaler 共用。多个 scaler 并发加载 CA 时并发写底下的 map。修法都是加同步。#8126 的额外症状是「monotonic growth」——证书池只增不减,跑久了内存只上不下。

**这些都是「能跑但不可控」的典型**:单租户小规模下几乎不触发,多租户大规模下变成间歇性 panic。分片(#7816)让单实例的对象数下降,这几个并发修复让剩下的那些实例更稳。**两条改动是同一个目标的两个方向。**

健康信号方面,#7928 把 HPA 的健康状态从 `Ready` condition 里拆出来:

```go
// ConditionHPAActive mirrors the underlying HPA's ScalingActive condition.
// It is ScaledObject-specific (ScaledJob has no HPA), so it is intentionally NOT part of
// GetInitializedConditions/AreInitialized. It is set lazily by checkHPAHealth once an HPA
// exists for the ScaledObject.
ConditionHPAActive ConditionType = "HPAActive"
```

之前的痛点写在 CHANGELOG 里:

> so transient HPA metric gaps no longer flip the `Ready` condition to `False`

**HPA 的指标瞬时缺口,之前会把 KEDA 的 Ready 翻成 False。** 这是个很经典的告警疲劳来源:HPA 那边评估慢了一拍,KEDA 这边就告警「不健康」。现在 `Ready` 只反映 KEDA 自己的健康,`HPAActive` 单独反映 HPA 的。**一个 condition 只反映一个系统的健康**,这是可观测性的基本卫生。

---

## 七、三条 breaking change 与「最安静的那一条」

### 7.1 Azure Pipelines 的 `scaleOnInFlight`:不报错,只改变伸缩决策

这是三条 breaking change 里最值得单独说的一条,因为它**不报任何错,只是默默改变你的副本数**。

```go
// pkg/scalers/azure_pipelines_scaler.go
type azurePipelinesMetadata struct {
	// ...
	FetchUnfinishedJobsOnly              bool   `keda:"name=fetchUnfinishedJobsOnly, order=triggerMetadata, default=false"`
	ScaleOnInFlight                      bool   `keda:"name=scaleOnInFlight, order=triggerMetadata, default=true"`   // ← 新,默认 true
	// ...
}
```

之前队列长度的计算是「只算还没分配给 agent 的 job」。现在默认 `scaleOnInFlight: true`,**把已经分配给 agent 但还没跑完的 job 也算进队列长度**。

```go
var count int64
for _, job := range stripDeadJobs(jrs.Value, s.metadata.ScaleOnInFlight) {   // ← 参数透进去
    if s.metadata.Parent == "" && s.metadata.Demands == "" {
        count++
    }
    // ...
}
```

**为什么这是 breaking**:你的 ScaledObject 配置一个字都没改,升级之后 agent 数量就变了。如果你的 pipeline 有长跑 job,之前算 0,现在算进队列,触发扩容;之前算在队列里的,现在可能重复计算导致过度扩容。

这是 10-04 那篇 AgentGateway 分析里提到的**「最安静的 breaking change」**的同类:AgentGateway v1.6.0 的内建模型目录让 USD 预算升级后**静默开始扣费**,不报错只改变账单。KEDA 这条是**不报错只改变伸缩决策**。这两类是 breaking change 里最危险的一类——**配置不报错、日志不报错、告警不报错,只有行为变了,而行为变化只能从外部观测(账单 / 副本数)。**

迁移方式:

```yaml
# 想保留旧行为(只算未分配的)
triggers:
- type: azure-pipelines
  metadata:
    organizationURL: https://dev.azure.com/myorg
    personalAccessTokenFromEnv: AZP_TOKEN
    poolID: "1"
    scaleOnInFlight: "false"      # ← 显式退回旧行为
```

**对 ScaledJob 还有个额外的坑**:release notes 说 "for ScaledJobs, combine this with the accurate scaling strategy"。因为 ScaledJob 算的是 Job 数,in-flight 的 job 算进去之后,scaling strategy 的行为会不一样,需要显式配 `accurate` 策略。

### 7.2 Temporal scaler:删字段,直接解析失败

```yaml
# 这些字段 2.21 不再接受,解析会失败
triggers:
- type: temporal
  metadata:
    buildId: "my-build"           # ← 删除
    selectAllActive: "true"       # ← 删除
    selectUnversioned: "true"     # ← 删除
```

升级前必须改成:

```yaml
triggers:
- type: temporal
  metadata:
    workerDeploymentName: "my-worker-deployment"        # ← 新
    workerDeploymentBuildId: "my-build"                 # ← 新
```

这是 Rules-Based Versioning 的字段迁移。**失败方式是硬失败**——release notes 原话:"Existing ScaledObjects and ScaledJobs containing them will **fail scaler metadata parsing**." 不是降级,是解析失败。这个比 Azure Pipelines 那条厚道得多:**大声报错比安静改变好。**

同一 scaler 还加了两个新能力:#7460 的 **composite metric**(backlog + running workflow count 组合指标)和 #7854 的 `enableTLS` 参数(跟 API key 认证配合控制 TLS)。

### 7.3 三条 breaking change 的对比

| breaking change | 失败方式 | 能不能配回去 | 危险等级 |
|-----------------|----------|--------------|----------|
| SA token audience(CVE-2026-77524) | scaler 解析失败/认证失败 | 加 audience 字段 | 🔴 安全,必须先改 |
| Azure Pipelines `scaleOnInFlight` | **不报错,只改变副本数** | `scaleOnInFlight: "false"` | 🟠 最安静,最容易被忽略 |
| Temporal scaler 删字段 | scaler 元数据解析失败 | 迁移到 `workerDeploymentName` | 🟡 大声报错,好处理 |

**这个对比本身就是升级管理的教材:安全类的必须先改、硬失败的容易发现、静默改行为的必须写进升级 checklist 第一项。**

---

## 八、支线:三个新 scaler 与认证扩展

### 8.1 三个新 scaler

**Azure Cosmos DB Change Feed**(#7557):跟着 Cosmos DB 的 change feed 伸缩。Cosmos DB 的 change feed 是 append-only 的变更日志,这个 scaler 让任何消费 change feed 的工作负载(常见的是事件溯源 / CQRS 的读模型刷新)可以按积压量伸缩。

**ClickHouse**(#7850):这个值得注意。ClickHouse 在 2026 年是实时数仓的常见选择(09-25 那篇 vLLM 的 AI RCA 场景、10-02 那篇 Iceberg 的湖仓场景都涉及 OLAP 存储)。KEDA 之前没有 ClickHouse scaler,要伸缩 ClickHouse 消费者只能用外部 scaler 或者 cron。**这是 KEDA 第一次原生支持 OLAP 数据库作为伸缩源。**

**GCP Cloud Spanner**(#7844):Google 的分布式关系数据库。之前 GCP 系 scaler 缺这一块。

### 8.2 认证扩展:都是「把已有的信任路径补齐」

- **Prometheus OAuth2 client credentials**(#8064):之前 Prometheus scaler 要认证只能 basic auth 或 TLS,OAuth2 client credentials 是企业 Prometheus(尤其 SaaS 托管的)的标配。这个补齐了。
- **Kafka Kerberos credential cache**(#8069):Kafka 在企业环境大量用 Kerberos。之前 KEDA 的 Kafka scaler 支持 GSSAPI 但只能用 keytab,credential cache(`klist` 看到的那个)不支持。这条对用 Kerberos 的企业 Kafka 是刚需。
- **Azure Pipelines service principal**(#7931):用可复用的 Azure provider 做服务主体认证。

这三条放在一起看是个规律:**KEDA 2026 年在补「真实企业环境里已经在用的认证方式」,而不是加新花样。** 一个伸缩层的采纳瓶颈往往不是功能,是「我的认证方式你支持不支持」。

### 8.3 几个值得单说的正确性修复

**RabbitMQ 空队列快速排空**(#8033)——这个修复特别有画面感。看代码就懂:

```go
// pkg/scalers/rabbitmq_scaler.go
case rabbitModeExpectedQueueConsumptionTime:
    eta := float64(0)
    switch {
    case messages == 0:
        eta = 0                          // ← 新增:空队列 ETA 就是 0
    case deliverGetRate == 0:
        eta = float64(s.metadata.ActivationValue)    // ← 之前:空队列也走这里
    default:
        eta = ((publishRate - deliverGetRate) / deliverGetRate) + (float64(messages) / deliverGetRate)
    }
    metric = GenerateMetricInMili(metricName, eta)
    isActive = (eta > s.metadata.ActivationValue) || (deliverGetRate == 0 && messages > 0)   // ← 加了 messages > 0
```

**之前的 bug**:队列已经空了(`messages == 0`),但没人消费(`deliverGetRate == 0`),ETA 会被算成 `ActivationValue` 而不是 0,`isActive` 判定为 true —— **空队列被认为「活跃」,workload 缩不到 0。**

修复后:空队列 ETA=0,且 `isActive` 额外要求 `messages > 0`。**队列空了就该能缩到 0**,这是事件驱动伸缩的基本契约,这个 bug 等于让基本契约在特定模式下失效。测试注释也写得很直白:

```go
// empty idle queue: nothing to consume and nobody consuming - must be
// inactive with a zero metric so the workload can scale to zero
```

**Kafka lag 排除 retention 删除的消息**(#7937):Kafka 的消费者 lag 是「未消费的 offset 范围」,但如果消息被 retention 删了,offset 还在,lag 就包含了已经不存在的消息。这导致 lag 永远清不了,workload 永远不缩。修复:对 uncommitted offsets,排除被 retention 删除的。

**Metrics API scaler 拒绝不支持的 auth mode**(#8178):

```go
// Validate rejects auth modes this scaler does not apply to its requests.
func (m *metricsAPIScalerMetadata) Validate() error {
	return m.MetricsAPIAuth.ValidateAllowed(
		authentication.APIKeyAuthType,
		authentication.BasicAuthType,
		authentication.TLSAuthType,
		authentication.BearerAuthType,
	)
}
```

之前的行为:你配了一个 scaler 不支持的 auth mode(比如 custom header),它**静默忽略**,请求发出去认证失败,你以为是网络问题。现在是**启动期拒绝**。**又是「默认信任 → 显式校验」的同一条线。**

**Liiklus scaler 弃用**(#7938):原因很直接——upstream 项目没人维护了。计划后续版本移除。**这是项目卫生:不维护依赖的 scaler 就别留着骗人。**

---

## 九、5 段实战代码

### 9.1 升级前审计:一行找出所有受影响的对象

升级前必跑。这条命令把三类受影响对象一次性列全:

```bash
# 受影响的全景:bound SA token / Vault k8s auth / 引用它们的 ScaledObject
kubectl get triggerauthentications.keda.sh,clustertriggerauthentications.keda.sh -A -o json \
  | jq -r '.items[]
      | select(
          (.spec.boundServiceAccountToken != null)
          or (.spec.hashiCorpVault.authentication == "kubernetes")
        )
      | "\(.kind)/\(.metadata.namespace // "-")/\(.metadata.name) \( (.spec.boundServiceAccountToken.audience // "audience=UNSET") )"'

# 反查:这些 auth 被谁引用了
kubectl get scaledobjects.keda.sh,scaledjobs.keda.sh -A -o json \
  | jq -r '.items[]
      | . as $o
      | $o.spec.triggers[]
      | select(.authenticationRef.name != null)
      | "\($o.kind)/\($o.metadata.namespace)/\($o.metadata.name) -> \(.authenticationRef.name)"'
```

输出例:

```
TriggerAuthentication/tenant-a/vault-auth audience=UNSET
ClusterTriggerAuthentication/-/prometheus-auth audience=prometheus
ScaledObject/tenant-a/worker -> vault-auth
```

**`audience=UNSET` 的就是升级后会挂的。** 先补 audience,再升级。

### 9.2 分片部署:两个 operator 实例各管一部分

```yaml
---
# 分片 A:管租户组 alpha
apiVersion: apps/v1
kind: Deployment
metadata:
  name: keda-operator-alpha
  namespace: keda
  labels: {keda.sh/shard: alpha}
spec:
  replicas: 1
  selector: {matchLabels: {keda.sh/shard: alpha}}
  template:
    metadata: {labels: {keda.sh/shard: alpha}}
    spec:
      serviceAccountName: keda-operator
      containers:
      - name: keda-operator
        image: ghcr.io/kedacore/keda:2.21.0
        env:
        - {name: WATCH_LABEL_SELECTOR, value: "keda.sh/tenant-group=alpha"}
        - {name: WATCH_LABEL_SELECTOR_FOR_TRIGGERAUTH, value: "keda.sh/tenant-group=alpha"}
---
# 分片 B:管租户组 beta(同一 operator SA,标签不同)
apiVersion: apps/v1
kind: Deployment
metadata:
  name: keda-operator-beta
  namespace: keda
  labels: {keda.sh/shard: beta}
spec:
  replicas: 1
  selector: {matchLabels: {keda.sh/shard: beta}}
  template:
    metadata: {labels: {keda.sh/shard: beta}}
    spec:
      serviceAccountName: keda-operator
      containers:
      - name: keda-operator
        image: ghcr.io/kedacore/keda:2.21.0
        env:
        - {name: WATCH_LABEL_SELECTOR, value: "keda.sh/tenant-group=beta"}
        - {name: WATCH_LABEL_SELECTOR_FOR_TRIGGERAUTH, value: "keda.sh/tenant-group=beta"}
---
# 租户对象打标签
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: tenant-a-worker
  namespace: tenant-a
  labels: {keda.sh/tenant-group: alpha}   # ← 由分片 A 管
spec:
  scaleTargetRef: {name: worker}
  minReplicaCount: 2
  maxReplicaCount: 20
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka:9092
      consumerGroup: tenant-a
      topic: orders
```

**验证分片真的生效**(关键:API server 层过滤必须生效,不然只是 controller 层过滤,内存没省):

```bash
# 每个 operator 的 APIServer 请求计数:不同分片应该看到不同的 list 计数
kubectl -n keda exec deploy/keda-operator-alpha -- \
  curl -s localhost:7979/metrics \
  | grep apiserver_request_total | grep -E 'scaledobjects|scaledjobs'

# 验证对象确实没进缓存:每个 operator 的 informer 缓存项数
kubectl -n keda exec deploy/keda-operator-alpha -- \
  curl -s localhost:7979/metrics | grep workqueue_depth
```

**如果两个分片的工作队列深度差不多,说明 label selector 没生效**(API server 层过滤没起作用),先检查环境变量名拼对没有。

### 9.3 StreamMetricSpec:一个动态调 target 的 external scaler

```python
# scaler.py —— 一个会按高峰期动态调整 target 的 external scaler
# 关键:StreamMetricSpec 是 server-streaming,KEDA 调一次,服务端可以推多次
import grpc, time, threading
from concurrent import futures
import externalscaler_pb2 as pb
import externalscaler_pb2_grpc as pb_grpc

SPEC_LOCK = threading.Lock()
CURRENT_TARGET = 100   # 每请求平均数

class Scaler(pb_grpc.ExternalScalerServicer):
    def GetMetricSpec(self, request, context):
        # 旧的 unary RPC 仍然必须实现(兼容)
        with SPEC_LOCK:
            t = CURRENT_TARGET
        return pb.GetMetricSpecResponse(
            metricSpecs=[pb.MetricSpec(
                metricName="queue_depth",
                target=pb.MetricTarget(averageValue=t))])

    def GetMetrics(self, request, context):
        depth = read_queue_depth()   # 你的逻辑
        return pb.GetMetricsResponse(
            metrics=[pb.Metric(
                metricName="queue_depth",
                metricValue=str(depth))])

    def StreamMetricSpec(self, request, context):
        # 新增:推流式 spec 更新。KEDA 侧 WatchesRawSource 会触发 reconcile
        # 从 HPA 重建,用户不需要改 ScaledObject
        while context.is_active():
            t = decide_target()      # 高峰期 200,平时 100
            with SPEC_LOCK:
                if t != CURRENT_TARGET:
                    CURRENT_TARGET = t
            yield pb.GetMetricSpecResponse(
                metricSpecs=[pb.MetricSpec(
                    metricName="queue_depth",
                    target=pb.MetricTarget(averageValue=t))])
            time.sleep(60)

def decide_target():
    hour = time.localtime().tm_hour
    return 200 if 9 <= hour < 22 else 100   # 高峰期阈值翻倍

server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
pb_grpc.add_ExternalScalerServicer_to_server(Scaler(), server)
server.add_insecure_port('[::]:60051')
server.start(); server.wait_for_termination()
```

**注意**:这个特性的价值不在「能改 target」,而在**「不用写 etcd 就能改」**。对比传统做法:每次改阈值都要 `kubectl patch scaledobject`,写一次 etcd、触发一次全量 reconcile、可能触发 HPA 重建风暴。stream 把动态性放在协议层。代价是**target 的变化现在不在 Kubernetes 的声明式世界里**,审计和回滚要自己管。

### 9.4 判断你的 ScaledObject 是否还在空轮询

直接用 PR #8031 里那两个方法的逻辑,离线审计现有配置:

```python
#!/usr/bin/env python3
"""审计:哪些 ScaledObject 在 HPA 全权接管后仍在空转轮询"""
import json, subprocess, sys

def polling_interval_relevant(spec):
    """翻译 ScaledObject.IsPollingIntervalRelevant() 的逻辑"""
    min_r = spec.get("minReplicaCount") or 0
    if min_r == 0 or spec.get("idleReplicaCount") is not None:
        return True
    for t in spec.get("triggers", []):
        if t.get("useCachedMetrics"):
            return True
    return False

out = subprocess.run(
    ["kubectl", "get", "scaledobjects.keda.sh", "-A", "-o", "json"],
    capture_output=True, text=True, check=True)
items = json.loads(out.stdout)["items"]

wasting = []
for it in items:
    ns, name = it["metadata"]["namespace"], it["metadata"]["name"]
    spec = it["spec"]
    if not polling_interval_relevant(spec) and not spec.get("advanced", {}).get("scalingModifiers"):
        wasting.append((ns, name, spec.get("pollingInterval", 30)))

print(f"共 {len(items)} 个 ScaledObject,{len(wasting)} 个在空转轮询:")
for ns, name, pi in sorted(wasting):
    print(f"  {ns}/{name}  pollingInterval={pi}s  ← KEDA loop 对副本数无发言权")
```

输出例:

```
共 47 个 ScaledObject,31 个在空转轮询:
  prod/api-gateway     pollingInterval=10s  ← KEDA loop 对副本数无发言权
  prod/report-worker   pollingInterval=30s  ← KEDA loop 对副本数无发言权
```

**这就是升级 2.21 后对外部系统请求数减半的那批对象。** 对 Prometheus 来说,31 个 ScaledObject × 每 30 秒一次 query,直接少掉一半 QPS。

### 9.5 gRPC client 指标:定位慢 scaler

```bash
# #8199 新增的 external scaler gRPC client 指标
# 之前 external scaler 是完全黑箱,现在可以定位"哪个外部 scaler 慢"
kubectl -n keda exec deploy/keda-operator -- \
  curl -s localhost:7979/metrics \
  | grep -E 'grpc_client_handling_seconds|keda_scaler' \
  | grep -v '#' | awk '{
      if ($1 ~ /sum/) print $1, "total=" $2
  }'

# 按 scaler 名字聚合延迟:找出 P99 高的那一个
kubectl -n keda exec deploy/keda-operator -- \
  curl -s localhost:7979/metrics \
  | grep grpc_client_handling_seconds_bucket \
  | awk -F'grpc_method="' '{print $2}' | cut -d'"' -f1 \
  | sort | uniq -c | sort -rn
```

**用法**:发现某个 external scaler 的 P99 延迟异常高时,先确认它是用 `StreamMetricSpec` 还是 `GetMetrics`——前者是长连接,后者每次新建,慢的语义完全不同。这条指标是 #7794(StreamMetricSpec)的配套:**给了你动态调 target 的能力,也给了你观测它的工具。**

---

## 十、5 套伸缩方案 17 维度对比

| 维度 | KEDA 2.21 | Karpenter 1.x | Kueue 0.20 | Knative Serving 1.23 | HPA(原生) |
|------|-----------|---------------|------------|----------------------|------------|
| **定位** | 事件驱动伸缩 | 节点供给 | 批处理配额准入 | Serverless 应用 | 副本数计算 |
| **伸缩对象** | Deployment/Job/任何 scale target | Node | Job/Batch workload | Revision(Revision→Pod) | 任意 scale subresource |
| **伸缩轴** | 外部事件量 | Pod 调度失败/碎片 | 配额可用性 | 并发请求数 | CPU/内存/自定义指标 |
| **缩到 0** | ✅ 核心能力 | ❌(它造节点) | 部分(ungate) | ✅ 核心能力 | ❌(min 副本限制) |
| **指标来源** | 60+ 内建 scaler + external gRPC | 节点容量 | 配额池 | 请求数 | metrics-server / custom |
| **多租户** | namespace 级 + **label selector 分片** | 节点池隔离 | LocalQueue/Cohort | namespace 级 | 弱(共享 HPA) |
| **安全模型** | **SA token audience 强制 + 显式 auth** | 节点 IAM | RBAC + SubjectAccessReview | namespace 级 | 无 |
| **决策权归属** | **显式(KEDA vs HPA)** | kube-scheduler | Kueue(kube-scheduler 之上) | Knative controller | HPA controller |
| **API 层** | CRD(ScaledObject/ScaledJob) | CRD(NodePool/NodeClaim) | CRD(ClusterQueue/LocalQueue) | CRD(Revision/Route) | 内建 autoscaling/v2 |
| **job 支持** | ✅ ScaledJob(原生) | 部分 | ✅ 核心适配 | ❌ | ❌ |
| **热升级路径** | Helm/chart(先改 auth 再升) | NodeClaim 滚动 | **v1beta1 删除需迁移脚本** | Revision 滚动 | 无 |
| **默认值严厉度** | **高(3 breaking,1 安全)** | 中 | **高(15 条升级必读)** | 中 | 低 |
| **性能优化点** | 停止空转轮询 | bin-packing/整合 | 记账锚点上移 | 请求级缩放 | 算法(v2beta2) |
| **生态集成** | Argo Rollouts / Flux / Helm | 全 K8s | Spark/Ray/JobFramework | Istio/Contour | 全 K8s |
| **审计能力** | HPAActive condition + gRPC 指标 | 节点事件 | UnadmittedWorkloadsObservability | Revision 事件 | HPA events |
| **与本版主题关系** | 本文 | 节点层 | **同日中午** | 应用层 | KEDA 的下游 |
| **适用场景** | 消息/事件驱动的在线服务 | 节点成本/碎片治理 | GPU/批处理配额 | HTTP serverless | 简单 CPU/内存伸缩 |

**关键观察**:KEDA 和 Kueue 是**互补不是竞争**——Kueue 管「批处理 workload 能不能用配额」,KEDA 管「在线服务副本数该是多少」。**两者都是 SIG Autoscaling 出品**,设计哲学也一致:都在 2026 下半年把「隐含的默认行为」翻成「显式语义」(Kueue 的记账锚点 / KEDA 的决策权归属)。一个 GPU 训练集群用 Kueue,一个消息驱动服务集群用 KEDA,两者可以并存。

---

## 十一、6 条 6-12 月可验证硬指标

**1. 对外部系统的请求数减半**

升级后,对 `minReplicaCount > 0` 且无 idle 且无 cached metrics 的 ScaledObject,KEDA 不再轮询 trigger 源。
```bash
# 升级前/后对比 Prometheus 的查询速率(如果你的 trigger 是 Prometheus)
rate(prometheus_http_requests_total{handler="/api/v1/query"}[5m])
# 预期:这类 ScaledObject 占比越高,降幅越大。31/47 这批,理论降幅 ~50%。
```

**2. scaler 建立的 gRPC 连接数稳定**

#8193 在最后一个 scaler 关闭时释放连接池。
```bash
# 观察外部 scaler 的连接数,不再随 ScaledObject 增删单调增长
ss -tnp | grep :60051 | wc -l
# 对比:2.20 时这个数字随 scaler 数增长且不回落
```

**3. KEDA operator 内存随分片线性下降**

#7816 的 API server 层过滤。
```bash
# 分片前后对比 RSS
kubectl -n keda top pod -l keda.sh/shard
# 预期:2 个分片各约 40-50% 的单实例内存,而不是各 90%
```

**4. Azure Pipelines agent 数量在升级当天变化**

#7905 的 `scaleOnInFlight: true` 默认值翻转。
```bash
# 记录升级前 24h 与升级后 24h 的 agent 副本数分布
kubectl -n azp get deploy -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.replicas}{"\n"}{end}'
# 预期:有长跑 job 的 pool,agent 数上升(因为 in-flight job 算进队列长度)
```

**5. Ready condition 不再因 HPA 指标缺口翻转**

#7928 的 HPAActive condition。
```bash
# 升级前:统计 Ready 翻转次数
kubectl get scaledobjects -A -o json \
  | jq '[.items[] | select(.status.conditions[] | select(.type=="Ready" and .status=="False"))] | length'
# 升级后:这类告警应显著减少,HPA 的健康改看 HPAActive condition
```

**6. 升级后认证失败的 scaler 数 = 0**

#8178 让不支持的 auth mode 启动期失败。这个指标是**验证你升级前审计做对了**:
```bash
# 应该全部 Ready。如果有 False 且 message 含 auth,说明升级前没补 audience/auth mode
kubectl get scaledobjects,scaledjobs -A -o json \
  | jq -r '.items[] | .status.conditions[]
      | select(.status == "False") | "\(.type): \(.message)"' | sort | uniq -c
```

---

## 十二、5 步生产升级 checklist

**Step 1 —— 审计 SA token / Vault 配置(必须第一步)**

```bash
# 列出所有 boundServiceAccountToken + Vault k8s auth 的对象
kubectl get triggerauthentications.keda.sh,clustertriggerauthentications.keda.sh -A -o json \
  | jq -r '.items[] | select((.spec.boundServiceAccountToken) or (.spec.hashiCorpVault.authentication=="kubernetes"))
      | "\(.kind) \(.metadata.namespace // "-")/\(.metadata.name)"'
```
给每一个补上显式 audience。**这一步不做,升级后 scaler 直接不工作。**

**Step 2 —— 处理 Azure Pipelines 的静默行为变化**

确认所有 azure-pipelines trigger 是否需要保留旧行为。有长跑 job 的 pool 优先评估。
```yaml
metadata:
  scaleOnInFlight: "false"   # 显式退回,并且 ScaledJob 配 accurate 策略
```
**这一步不做,升级当天 agent 数量会变,且没有任何报错。**

**Step 3 —— 迁移 Temporal scaler 字段**

```bash
# 全局搜旧字段
kubectl get scaledobjects,scaledjobs -A -o yaml | grep -E 'buildId|selectAllActive|selectUnversioned'
```
改写为 `workerDeploymentName` + `workerDeploymentBuildId`。**这一步不做,scaler 元数据解析失败。**

**Step 4 —— 灰度升级 + 观察**

先升 Metrics API Server(独立的 Deployment),再升 operator。分批:
```bash
# 先在一个测试命名空间验证
helm upgrade keda kedacore/keda --version 2.21.0 \
  --set watchNamespace=staging --wait

# 观察 15 分钟:所有 ScaledObject 的 Ready 状态
kubectl get scaledobjects -n staging -w
```

**Step 5 —— 开启分片(可选,规模大才做)**

只有当单 operator 成为瓶颈(对象数 > 数百、或一个慢 scaler 影响全局)时才做。给对象打标签,部署多实例。**先验证 API server 层过滤真的生效(看 APIServer 请求计数),再扩大范围。**

---

## 十三、8 个诚实边界

**1. audience 校验不是完整的根因修复。** 根因是「operator 用自己的集群特权身份去租户指定的服务器认证」。audience 让这个 token 在别处不可用,但 `credential.serviceAccount` 默认指向 operator 自己这个更 upstream 的问题,2.21 收紧了显式化但没有改掉默认值本身。后续版本应该继续收。

**2. 停止轮询不适用于 scalingModifiers。** `UsesHPAObservations()` 显式排除了 `IsUsingModifiers()` 的对象——因为 modifier 的 trigger 活动来自「所有 metric 一次性组合公式」,HPA 的单指标观测推导不出。这类对象该轮询还是轮询,别误以为升级后全停了。

**3. `WATCH_LABEL_SELECTOR` 不做分片调度。** 它是**手工打标签 + 手工部署多实例**,KEDA 不会自动把对象路由到某个分片。标签漏了的对象会**没有任何 operator 管**(因为所有分片都过滤掉了),这是一个真实的静默故障风险。规模小别开。

**4. StreamMetricSpec 依赖外部 scaler 主动实现。** KEDA 侧只是监听 channel,scaler 不实现 `StreamMetricSpec` 这个 RPC 就没有任何效果。而且 target 的动态变化**不在 Kubernetes 声明式世界里**,审计和回滚要 scaler 自己负责。

**5. `KEDA_KUBERNETES_API_TIMEOUT` 只覆盖 scaling loop 里的 Kubernetes API 调用。** 它不管外部 HTTP(那是 `globalHTTPTimeout`),也不管 scaler 内部自己建的 client。超时语义是两套,别混。

**6. metric cache 的生命周期改了,但缓存本身不持久化。** operator 重启后所有 metric 缓存重建。新语义解决的是「清 scaler 缓存时别误删健康 trigger 的 metric」,不是「跨重启保持」。

**7. RabbitMQ 空队列修复只覆盖 `expectedQueueConsumptionTime` 模式。** RabbitMQ scaler 有多种 mode( QueueLength / MessageRate / ExpectedQueueConsumptionTime),这个 `messages == 0` 的判断只加在 consumption time 模式上。其他模式下的空队列行为本文未验证。

**8. 三个新 scaler 的成熟度不同。** Cosmos DB Change Feed(#7557)和 ClickHouse(#7850)、GCP Cloud Spanner(#7844)都是**本版本首次加入**。首次加入的 scaler 在生产用之前应该先在非关键链路验证, scaler 的错误处理和指标语义需要时间打磨。KEDA 对新 scaler 的政策没有 GA 标记,本文不对其生产就绪性背书。

---

## 十四、3 个长期判断

**判断一:伸缩层正在从「无脑轮询」变成「先问自己有没有用」。**

KEDA #8031 的 `IsPollingIntervalRelevant()` 是一个小方法,但它代表一个方向:**伸缩控制器开始显式地推理「我对副本数还有没有发言权」。** 这跟中午 Kueue 的记账锚点上移是同一个趋势在两个层的投影——Kueue 问「这个 workload 真的在用配额吗」,KEDA 问「我真的在影响副本数吗」。2026 下半年,成本压力会让所有基础设施控制器都被问这个问题。**预测:12 个月内,KEDA 会把这套「决策权归属」推理扩展到 ScaledJob,并且把推理结果作为 status 字段暴露出来,让用户能直接 `kubectl get so -o yaml` 看到自己的 pollingInterval 是不是在空转。**

**判断二:KEDA 的多租户信任边界会成为其它 operator 的模板。**

CVE-2026-77524 的修复路径——从「内容形状校验」升级到「audience 密码学绑定」——是所有**集群级 operator + 租户指定目标**架构的可复制解法。任何一个「operator 拿着集群特权身份去执行租户配置」的项目(Vault CSI provider、Argo Workflows、Tekton、Cert Manager 的部分 ACME 流程)都吃这一套。**预测:12 个月内,KEDA 这套 audience 强制 + destination 校验 + label selector 分片的三件套,会被至少两个其它 CNFC 项目照搬。** 而且这件事的教训——**「内容形状校验 ≠ 授权校验」**——值得每个写 operator 的人记一遍。

**判断三:StreamMetricSpec 是 KEDA 从「伸缩器」变成「伸缩平台」的第一步。**

之前 KEDA 的所有动态性都在 CRD 里,改一次写一次 etcd。StreamMetricSpec 第一次在**协议层**开了动态性的口子。这个方向一旦开了,接下来会是:stream 式的 metric 值(不只是 spec)、scaler 主动汇报健康、scaler 之间能协同。**KEDA 在变成一个「伸缩能力的运行时」,而不只是一个「伸缩配置的控制器」。** 风险也随之而来:动态性离开声明式世界,审计、回滚、权限模型全得重做。**预测:12 个月内,KEDA 会有一个「streaming scaler」的正式分类(区别于 polling / push),并给它配一套专门的 RBAC 边界——能推 spec 的 scaler,权限边界必须比能被查的 scaler 更严。**

---

## 十五、写在最后

KEDA v2.21.0 的结构很说明问题:**release notes 的第一个 section 不是 Highlights,是「Before upgrading」;Highlights 的第一条不是新功能,是「减少 HPA 已经接管时的冗余 scaler 请求」。**

一个事件驱动伸缩项目,最重要的改动变成了「**什么时候不该动**」。

这跟今天的三层叙事是同一条线:早间在讲成本(Claude token 砍九成、企业 AI 预算砍九成),中午在讲配额(Kueue 让 GPU 记账锚点上移,占着不用不再可能),晚间在讲弹性(KEDA 让轮询在没发言权时停下,让 token 只能去声明过的地方)。**当「加资源」便宜的时候,没人关心你多查了两次 Prometheus;当成本成为第一约束的时候,每一次空转都是钱,每一次越权都是事故。**

三个 breaking change 的分布也值得玩味:一条安全(必须先改)、一条删字段(大声报错)、一条改默认值(**安静地改变你的副本数**)。**「最安静的那一条最危险」**这个规律,从 10-04 的 AgentGateway(静默扣费)到今天这条(静默改伸缩),已经是连续第二次在 breaking change 分析里出现。下次升级任何基础设施,先找那条「不报错只改变行为」的。

最后一句给要升级的:**先跑 9.1 那条审计命令。** 30 秒的事,省你一个下午。

---

**数据来源**:KEDA v2.21.0 release notes(49.7 KB,2026-09-23 发布)、GHSA-637c-6jxx-4rwm / CVE-2026-77524 advisory 全文(CVSS 9.9)、CVE-2025-68476 / GHSA-c4p6-qg4m-9jmr advisory、KEDA v2.20.0 官方 release manifest RBAC、PR #8031 / #7816 / #7794 / #8174 / #8195 / #8073 / #8067 / #7928 / #7905 / #8178 / #8033 / #7937 的完整 diff、KEDA 官方迁移文档。
