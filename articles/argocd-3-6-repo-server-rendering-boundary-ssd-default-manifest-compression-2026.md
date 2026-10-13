---
title: "Argo CD v3.6 深度拆解:三个 CRITICAL 把 repo-server 渲染引擎的执行边界从默契改写成契约 + SSD 默认化终结 SMD + manifest 压缩热重载 + 同日四条 patch 分支"
date: 2026-10-13
category: 技术
tags: [Argo CD, ArgoCD, GitOps, 持续交付, CD 控制平面, repo-server, Kustomize, Jsonnet, Helm, OCI, ApplicationSet, AppProject, PreDelete hook, 安全边界, 命令注入, CVE, GHSA, Server-Side Diff, SSD, SMD, Structured Merge Diff, manifest 压缩, gzip-bestspeed, msgpack, hydrator, GPG 签名, SyncWindow, OCI Generator, progressive sync, RBAC, 供应链安全, cosign, SLSA, Kubernetes, 控制器, informer, DeepCopy, 字段投影, React Compiler, 2026]
excerpt: "2026 年 10 月 12 日,Argo CD 一口气发了四个版本:v3.6.0-rc2、v3.5.5、v3.4.11、v3.3.16。rc2 的 changelog 里塞进了三个 CRITICAL 和一个 CRITICAL 级 CVE,全部指向同一个问题——repo-server 的渲染引擎边界之前是「能跑 Kustomize 就等于能跑 shell」的默契:① Kustomize remote ref 可以在 repo-server 里执行命令(GHSA-9v9p-x54c-58gc);② Kustomize 的 Helm config home 目录同样能执行命令(GHSA-fw5c-w8rc-j7fx),修复方式是直接 breaking 掉 helmGlobals.configHome;③ Jsonnet 的 import 能读 repo-server 上的任意文件(GHSA-m3vr-7329-44ww);④ PreDelete/PostDelete resource hook 可以绕过 AppProject 的命名空间与集群约束(CVE-2026-77459)。配套四个 HIGH/MODERATE:登录失败限流可被并发请求绕过、SSH 仓库代理 URL 命令注入、extension proxy 的 RBAC 忽略 application namespace、超大 OCI manifest 耗尽 repo-server 内存(修复方式是 4MiB 以上一律拒绝)。性能线同样承重:#29103 把 Structured Merge Diff 彻底移除、Server-Side Diff 变默认且三个开启入口归一成一个 shouldUseServerSideDiff;#29581 让不需要刷新的队列项不再付 DeepCopy 代价、normalizeApplication 的 patch 只用 spec 构造不再序列化整个 status;#29378 用 kubemeta.KubeJson 做部分反序列化;#28600 给集群缓存加了 manifest 压缩(gzip-bestspeed / s2 / msgpack),argocd-cm 热重载、缓存自动失效重同步。另有 SyncWindow 类型重命名为 InlineSyncWindow、ApplicationSet OCI generator、hydrator 提交 GPG 签名(Alpha)、ignore-differences 注解、resource.additionalExclusions 追加键。本文逐条拆设计动机,给五段可运行复现与自查代码,并说清七条诚实边界——包括为什么同日三条老分支拿不到渲染层修复。"
cover: https://images.unsplash.com/photo-1635356932774-7c0bc7e0dad7?w=600&h=400&fit=crop
readtime: 24
author: 林小白
---

# Argo CD v3.6 深度拆解:三个 CRITICAL 把 repo-server 渲染引擎的执行边界从默契改写成契约

> 2026 年 10 月 12 日,Argo CD 的 release 页面一次出现四个 tag:`v3.6.0-rc2`、`v3.5.5`、`v3.4.11`、`v3.3.16`。这种排布本身是信息:一个 rc 跟三个 patch 同一天落地,通常意味着安全修复已经等不到下一个常规窗口。rc2 的 changelog 印证了这一点——Security fixes 段落里躺着三个 CRITICAL、一个带 CVE 编号的 CRITICAL、两个 HIGH、两个 MODERATE。

但真正值得拆的不是「又补了几个洞」,而是这八个安全项**指向的是同一个结构问题**:Argo CD 的 repo-server 之前从来没有一条明确的「渲染引擎可以做什么」的契约。Kustomize 能跑、Jsonnet 能跑、Helm 能跑——这三个渲染器各自都有从磁盘读文件、从远程取数据、执行插件的能力。它们跑在 repo-server 里,而 repo-server 拿着 Git 仓库的读权限、集群的凭证,还是整个流水线里唯一一个「把不可信 YAML 变成可执行清单」的组件。之前「渲染器不应该执行任意命令」这件事,**是靠所有人都不去碰那几个开关维持的默契**。v3.6 把它改写成了编译期/启动期就拒绝的显式契约。

性能线上同样有一个等价的「契约改写」:#29103 把 Structured Merge Diff(SMD)整个移除,Server-Side Diff(SSD)变成默认且唯一的三方合并路径,三个开启入口被收进一个 `shouldUseServerSideDiff` 函数;#29581 让 refresh 队列里不需要刷新的项直接返回,不再付 `DeepCopy` 的代价;#28600 给集群缓存加了可热重载的 manifest 压缩。这三件事的共同点是:它们都在把「控制器在每次 reconcile 里隐含做的序列化、拷贝、反序列化工作」变成**显式、可配、可度量**的运维参数。

## 〇、与早间的互补:接管日 × 控制平面上锁

今天早间的日报主题是「五维接管日」——AI 从能力竞赛进入接管竞赛,五个事件分别在模型层、监管层、创意产业、实体自动化、治理层发生。晚间这篇是同一个母题在基础设施层的投影,但方向相反:

| 栈层 | 早间事件(AI 接管) | 晚间事件(控制平面上锁) | 同一个设计问题 |
|------|--------------------|--------------------------|----------------|
| 模型层 | Meta Muse Wonder 用 active memory 跨周月记住用户 | Kustomize/Jsonnet 渲染器在 repo-server 里执行任意命令 | 「替你执行的东西,边界写在哪」 |
| 监管层 | 微软总裁称自愿承诺不够,只有坏公司才不守规矩 | AppProject 的命名空间/集群约束被 PreDelete hook 绕过 | 「自己说自己守规矩」不够,必须有强制点 |
| 创意产业 | Epic 转 AI-first,不再有手写代码 | helmGlobals.configHome 被 breaking 掉,依赖该目录的 Helm 插件失效 | 「默认开放」的成本第一次被显式定价 |
| 实体自动化 | 亚马逊百万机器人贴着工人定节拍 | 登录失败限流被并发请求绕过 | 高频自动化把原来够用的速率假设打穿 |
| 治理层 | CHT 裁掉政策研究与诉讼线 | extension proxy 的 RBAC 忽略 application namespace | 「站在旁边提醒的人」变少时,检查必须前移到代码里 |

早间五维全部在讲「执行权交出去了,收敛机制刚开始建」。晚间这篇给出的是收敛机制的一种具体形态:**不是加一层审批,而是把「谁有权在你的执行环境里执行什么」从运行时的默契变成渲染期/启动期的拒绝**。

---

## 一、问题的源头:repo-server 为什么是 Argo CD 最值钱的攻击面

要理解这三个 CRITICAL 为什么重要,先得看清 Argo CD 的信任模型。

```
Git 仓库(不可信输入)
    ↓
repo-server: 渲染 Kustomize / Helm / Jsonnet / Plugin → 完整 manifest 列表
    ↓
application-controller: 对比 live state,发起 server-side apply
    ↓
目标集群(高价值资产)
```

这个模型里,repo-server 是唯一一个**同时**握着两样东西的组件:

1. **不可信输入的解析权**——任何能 push 到目标分支的人,都能决定 Kustomize 的 `resources` 列表、Helm 的 `values.yaml`、Jsonnet 的 `import` 路径。
2. **接近集群的执行环境**——repo-server 运行在 argocd 命名空间里,和 application-controller、redis 共享网络,持有目标集群的凭证(做 server-side dry run diff 时需要),并且它的文件系统里有整个仓库的克隆。

Argo CD 对这个风险的传统防御是** RBAC + 项目隔离**:AppProject 限定某个应用只能同步到哪些命名空间、哪些集群、能用哪些仓库。这套机制一直在工作。但它防的是「渲染结果往哪发」,不防「渲染过程本身干了什么」。

而渲染过程本身就是个执行环境。三个渲染器各自的原始设计都假设计算机在开发者本机:

- **Kustomize** 有 `remote` 引用,支持从任意 URL 拉取别的 kustomization;它的 plugin 机制允许加载并执行本地目录里的二进制和脚本。
- **Helm** 有 `helm plugin` 机制,插件从 `helm config home` 目录加载,`helm template` 会执行插件的任意代码;Helm chart 里的 `post-render` 脚本更是直接执行 shell。
- **Jsonnet** 的 `import` 和 `importstr` 原生就读本地文件。

这三个能力在本机都是 feature——开发者本来就能在本机执行任意代码。但搬进 repo-server 之后,它们变成了「任何能 push 的人都能在 repo-server 里执行任意代码」。这不是新问题:社区从 2023 年起就有相关 issue,也做过 `--kustomize-enable-plugins`、CMP(config management plugin)sidecar 模式、禁止 `post-render` 等局部加固。v3.6 做的是**收口**:不再是「某些开关默认关、某些文档建议你别开」,而是渲染路径上这几个能执行/能读文件的具体入口,直接在代码层面拒绝。

为什么是现在?两个直接诱因。第一,过去一年 Argo CD 被大量接入「平台工程」场景,一个 Argo 实例管几十个团队、几百个仓库变成常态,repo-server 从「可信开发机代理」变成了「多租户共享执行环境」。多租户场景里,「谁能 push」不再等于「谁能执行」。第二,8 月份两个独立的高优先 issue(#27577 的 progressive sync 死循环、#29063 的 UI operation Unknown)暴露了同一个更深的模式:**Argo CD 在多处把「性能优化」或者「便利性」做成了「隐式地信任某个字段/某个路径」**。修复它们的过程里,维护者把这类隐式信任逐个显式化了。

## 二、三个 CRITICAL:渲染引擎的执行边界

### 2.1 Kustomize remote ref:远程引用能在 repo-server 里执行命令

**GHSA-9v9p-x54c-58gc**,CRITICAL。

Kustomize 从 3.x 起支持在 `kustomization.yaml` 里直接引用远程资源:

```yaml
# kustomization.yaml —— 修复前可复现
resources:
  - https://github.com/argoproj/argocd-example-apps/manifests/guestbook
```

这个能力的设计意图是「组合多个仓库的基础设施定义」。问题在于 Kustomize 处理某些远程引用类型时,会调用本地工具去拉取/转换内容,而这个工具调用链可以被构造到执行任意命令。攻击模型很直接:一个能往目标分支 push 的开发者(或者攻破了这个开发者账号的人),在 `kustomization.yaml` 里放一个构造好的远程引用,push 之后 Argo CD 自动渲染,repo-server 就执行了这条命令。命令的输出可以写回 manifest,也可以直接外带数据。

这件事之前很难防住,因为「禁止远程引用」这个约束只能通过 AppProject 的 `sourceRepositories` 限制**仓库 URL**——但远程引用写在 kustomization 内部,AppProject 的仓库白名单根本看不到它。这就是「RBAC 防的是发往哪,不防渲染过程干了什么」的具体表现。

### 2.2 Kustomize 的 Helm config home:同一个执行入口的第二条路

**GHSA-fw5c-w8rc-j7fx**,CRITICAL。这一个的修复方式是**破坏性变更**,因此值得单独看。

Kustomize 内置了渲染 Helm chart 的能力(`helmCharts`)。渲染时它需要知道 Helm 的配置目录在哪,默认通过 `helmGlobals.configHome` 指定:

```yaml
# kustomization.yaml —— v3.6 起这段不再生效
helmGlobals:
  configHome: /home/argocd/.config/helm
```

Helm 的插件机制会从 config home 下的 `plugins/` 目录加载并执行插件。所以这个路径同时是「配置目录」和「代码执行目录」。`configHome` 之前可以被 kustomization 文件覆盖,也就是说——**任何能 push 的人,可以指定 repo-server 上的任意目录为 Helm 插件目录,然后让 Kustomize 执行里面的东西**。如果那个目录里恰好有攻击者能写到的文件(临时解压目录、缓存目录、或者通过别的 kustomize 能力放进去的文件),就是一次完整的任意命令执行。

v3.6 的修法很硬:**Kustomize 渲染 Helm chart 时不再 honor `helmGlobals.configHome`**。Release notes 的原话是:

> Kustomize builds that render Helm charts no longer honor `helmGlobals.configHome`. Ordinary `http`, `https`, and `oci` chart repositories still work. Builds that depended on a Helm plugin registered from that directory will not.

注意这句的后半段——它把破坏面说得非常清楚:普通的 http/https/oci chart 仓库**不受影响**;受影响的只有「依赖从该目录注册的 Helm 插件的构建」。这是一个被精确限定范围的破坏性变更:它打掉的是「通过 kustomization 文件控制 Helm 插件加载路径」这条路径,代价是真正在用 Helm 插件的 Kustomize 构建会失效。

### 2.3 Jsonnet import:读文件

**GHSA-m3vr-7329-44ww**,CRITICAL。

Jsonnet 的 `import` / `importstr` 从设计上就读本地文件。在 repo-server 里,这意味着 manifest 可以读到 repo-server 容器文件系统上的任意文件——包括 Argo CD 自己的配置、Git 凭证的缓存、以及同一进程生命周期内被别的仓库克隆下来的其他文件。读出来的内容可以直接渲染进 ConfigMap 或者 annotation,从而被攻击者取回。

前两个洞是「执行」,这一个是「读取」。合起来看,三个 CRITICAL 覆盖了「读 + 执行」两条完整的数据外带链路。

### 2.4 同一个版本里的第四个 CRITICAL:AppProject 约束被删除钩子绕过

**GHSA-fmxq-cgp8-87wp / CVE-2026-77459**,CRITICAL。严格说这不是渲染引擎的洞,但它和前三个同源。

Argo CD 的 resource hook(`PreSync` / `PostSync` / `PreDelete` / `PostDelete`)是 manifest 的一部分,在同步/删除流程的特定阶段执行。AppProject 的作用是限制应用「能操作哪些命名空间和集群」——这个限制之前应用在**同步**路径上。删除路径走的是另一套逻辑,`PreDelete` / `PostDelete` hook 的执行**在项目约束检查之前**。

后果:一个受限于 `destinations: [namespace: dev-only]` 的应用,可以在 manifest 里放一个 `hook-delete-policy: BeforeHookCreation` 的 `PostDelete` hook,这个 hook 指向别的命名空间或者别的集群的资源。删除应用时,hook 先跑,项目约束还没来得及拦。

这是「RBAC 防的是发往哪」的第二个具体表现:删除路径漏掉了和同步路径同源的检查。

## 三、配套的四个 HIGH / MODERATE:自动化把速率假设打穿

| 编号 | 级别 | 内容 | 为什么是现在 |
|------|------|------|--------------|
| GHSA-4439-h7jw-5cjj / CVE-2025-61560 | HIGH | 登录失败速率限制可被并发请求绕过 | 限流之前是「每个请求检查一次计数器」,没有原子性保证;并发请求同时到达时计数器还没递增,全部通过 |
| GHSA-j6cw-g6p4-7hch / CVE-2026-55797 | HIGH | SSH Git 仓库的代理 URL 可注入命令 | `argocd repo add` 支持 `--proxy-url` 用于出站代理;SSH 传输路径对 URL 的转义不完整,构造的 URL 能让 ssh 执行额外参数 |
| GHSA-w996-f2wq-x9c6 | MODERATE | 超大 OCI manifest 耗尽 repo-server 内存 | OCI 仓库作为 Helm chart / Artifact 源之后,单 manifest 可以塞进远超预期的内容;修复是 **4 MiB 以上的 OCI manifest 一律拒绝** |
| GHSA-g3ff-q88g-chrj | MODERATE | extension proxy 的 RBAC 忽略 application namespace | 在启用 `applications-in-any-namespace` 时,extension proxy 的权限校验只看资源类型不看命名空间,导致跨命名空间访问 |

这四个里有两个值得单独说。

**登录限流的并发绕过**,是典型的「单线程时代的假设被自动化打穿」。速率限制的正确实现需要「检查并递增」是原子的。在并发场景下,如果实现是「读计数器 → 判断 → 写计数器」,N 个并发请求会同时读到同一个旧值,全部通过判断。CVE-2025-61560 的编号年份是 2025,说明这个洞被报告过、修过一次,这次是二次修复——第一次的修复可能只补了单实例内的竞态,没覆盖到多副本 server 的场景,或者没覆盖某个特定的登录端点。早间的第五维是「CHT 裁掉政策研究与诉讼线」——「站在旁边提醒的人变少」;这里是一样的道理:**当外部检查变弱时,速率限制这类「自己拦自己」的机制必须做到数学上正确,不能靠「反正没人会并发登录」**。

**OCI manifest 4MiB 上限**则是一个「防御措施本身变成契约」的例子。OCI 规范本身不限制 manifest 大小,所以这个上限是 Argo CD 自己加的自保措施。它被归到 MODERATE 而不是 HIGH,因为触发它需要能 push 到被 Argo CD 消费的 OCI 仓库——但这恰恰是平台工程场景里越来越常见的权限分布。

---

## 四、性能线:把控制器隐含的序列化工作变成显式参数

安全线之外,v3.6 的另一条主线是**性能契约的显式化**。五个最承重的改动:

### 4.1 #29103:SSD 默认化,SMD 正式退役

这是 v3.6 唯一带「Default」字样的 feature:`Default to SSD with SSA and remove SMD`。

之前的架构里,Argo CD 有两种三方合并策略:

- **Structured Merge Diff(SMD)**:Argo 自己实现的字段级三方合并,需要 OpenAPI schema 把字段分成「runtime 管的」和「Argo 管的」两组。
- **Server-Side Diff(SSD)**:把 desired manifest 发给集群的 dry-run 端点,让 apiserver 用 server-side apply 的 fieldOwnership 逻辑算出 diff。

两种策略并存,开启方式散落在三个地方:控制器级开关、应用的 `compare-options` 注解(`ServerSideDiff=true/false`)、以及 `SyncOptions` 里的 `ServerSideApply=true`。后两个之间的优先级关系是隐式的:代码里先读控制器级,再被 `ServerSideDiff=true` 注解覆盖,再被 `ServerSideDiff=false` 注解覆盖,然后**又**被 `ServerSideApply=true` 单独触发一次 SMD。`shouldUseServerSideDiff` 把这三条路径收成一个函数,规则写进注释:

```go
// shouldUseServerSideDiff returns whether Server-Side Diff should be used for
// the given application. It is enabled by the controller-level flag, the
// `ServerSideDiff=true` compare-option annotation, or the `ServerSideApply=true`
// sync option (which supersedes the discontinued Structured-Merge Diff strategy).
// An explicit `ServerSideDiff=false` annotation always disables it.
func shouldUseServerSideDiff(app *v1alpha1.Application, controllerLevelSSD bool) bool {
	if resourceutil.HasAnnotationOption(app, common.AnnotationCompareOptions, "ServerSideDiff=false") {
		return false
	}
	return controllerLevelSSD ||
		resourceutil.HasAnnotationOption(app, common.AnnotationCompareOptions, "ServerSideDiff=true") ||
		(app.Spec.SyncPolicy != nil && app.Spec.SyncPolicy.SyncOptions.HasOption("ServerSideApply=true"))
}
```

同时被移除的是这段老逻辑:

```go
// 修复前:ServerSideApply=true 会单独触发一次 SMD
if app.Spec.SyncPolicy != nil && app.Spec.SyncPolicy.SyncOptions.HasOption("ServerSideApply=true") {
    diffConfigBuilder.WithStructuredMergeDiff(true)
}
```

注意优先级的**语义变化**:`ServerSideDiff=false` 注解之前会被 `ServerSideApply=true` 覆盖(因为后者在代码顺序上更靠后),现在变成了**显式的最高优先级拒绝**。这是一个安全方向正确的改写——「显式说不」必须赢。

### 4.2 #29581:refresh 队列里不刷新的项不再付拷贝代价

`processAppRefreshQueueItem` 之前对每个出队的应用先做一次 `origApp.DeepCopy()`:

```go
// 修复前
origApp = origApp.DeepCopy()
needRefresh, refreshType, comparisonLevel := ctrl.needRefreshAppStatus(origApp, ...)
if !needRefresh {
    return processNext
}
app := origApp.DeepCopy()
```

修复后的顺序是:

```go
// needRefreshAppStatus only reads the application, so the informer's copy
// answers it and the queue items that need no refresh never pay for a copy.
needRefresh, refreshType, comparisonLevel := ctrl.needRefreshAppStatus(origApp, ...)
if !needRefresh {
    return processNext
}
origApp = origApp.DeepCopy()
app := origApp.DeepCopy()
```

思路很清楚:`needRefreshAppStatus` 是只读的,可以直接用 informer 缓存里的对象,不需要拷贝;只有真的要刷新的项才付两次拷贝的代价。一个管理 2000 个应用的控制器,如果只有 5% 的应用在某个 reconcile 周期内需要刷新,这个改动把 95% 的序列化成本消掉了。

同一 PR 里还有一处等价的「缩小序列化范围」修复,`normalizeApplication`:

```go
// 修复前:整个 Application 做 patch,每次刷新都把 status.resources 和
// status.history 序列化两遍
orig := app.DeepCopy()
app.Spec = *argo.NormalizeApplicationSpec(&app.Spec)
patch, modified, err := diff.CreateTwoWayMergePatch(orig, app, appv1.Application{})

// 修复后:只有 spec 可能变,patch 只用 spec 构造
origSpec := app.Spec.DeepCopy()
app.Spec = *argo.NormalizeApplicationSpec(&app.Spec)
// Only the spec can differ, so the patch is built from the spec alone rather
// than from the whole application. status.resources and status.history would
// otherwise be marshaled twice on every refresh.
patch, modified, err := diff.CreateTwoWayMergePatch(
    appv1.Application{Spec: *origSpec},
    appv1.Application{Spec: app.Spec},
    appv1.Application{})
```

这两个修复同属一个观察:**informer 缓存里的对象是共享的,任何「以防万一先拷一份」的代码在每秒处理几十个对象的循环里都是实打实的 CPU 和 GC 压力**。正确的做法是把「只读路径」和「写入路径」分开标定,只读路径直接用缓存对象。

### 4.3 #29378:部分反序列化

`getResourceTree` 之前对每个受管资源做完整 JSON 反序列化:

```go
// 修复前
live := &unstructured.Unstructured{}
err := json.Unmarshal([]byte(managedResource.LiveState), &live)
```

v3.6 换成了 gitops-engine 里新增的 `kubemeta.KubeJson`:

```go
// 修复后
live, err := kubemeta.NewKubeJson([]byte(managedResource.LiveState))
...
if live.IsEmpty() {
    target, err := kubemeta.NewKubeJson([]byte(managedResource.TargetState))
```

`KubeJson` 的作用是**延迟解析**:它保存原始字节,只在真正需要某个字段时才反序列化对应部分。资源树构建只需要 GVK 和少数元数据字段,不需要完整的 spec。对于管理几百个资源的应用,一次 reconcile 里「把每个资源的完整 manifest 反序列化进来再只用 GVK」是纯浪费。

### 4.4 #28600:集群缓存的 manifest 压缩,热重载

这是性能线里改动面最大的一项(16 个文件)。Argo CD 的应用控制器在内存里缓存每个被管理集群的完整资源清单。集群越大,这个缓存越贵。v3.6 给了两个新的 argocd-cm 键:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argocd-cm
  namespace: argocd
data:
  # 默认 false,manifest 以原始 in-memory 对象存储
  resource.manifest.compression.enabled: "true"
  # 序列化格式:json(默认)/ msgpack
  resource.manifest.storage: "msgpack"
  # 压缩算法:gzip-bestspeed(默认)/ gzip-default /
  # s2-encode / s2-encodebetter / zlib / none
  resource.manifest.compression: "gzip-bestspeed"
```

设计上有三个细节值得注意:

1. **默认关闭(opt-in)**。这是正确的做法——压缩带来 CPU 开销换内存收益,Trade-off 由集群规模决定。
2. **热重载**。文档原文:「This setting supports hot-reload and changes take effect without restarting the controller. The cluster cache is automatically invalidated and re-synced with the new storage mode.」改配置不需要重启控制器,缓存自动失效重同步。
3. **六个压缩选项 + 两个序列化格式 = 七种组合**。`gzip-bestspeed` 作为默认值说明设计目标是「别让压缩成为热路径瓶颈」而不是「压到最小」;`s2-encode` / `s2-encodebetter` 来自 klauspost/compress 的 s2 库,在 Go 生态里正在成为压缩的事实标准;`none` 存在的意义是「只换序列化格式不压缩」,比如纯 msgpack 已经够省。

实现层面,压缩开关被加进了 `cacheSettings` 结构体,在 `loadCacheSettings` 里读取,通过 `SetManifestCompressionEnabled` / `SetManifestStorageType` / `SetManifestCompressionType` 三个 functional option 传给 `NewClusterCache`。`Invalidate` 路径也同步传了这三个选项,保证「热重载 → 失效 → 重建」的链路完整。

### 4.5 #29152:SyncWindow 类型重命名

`SyncWindow` 被重命名为 `InlineSyncWindow`。从 diff 看,这是 OpenAPI definition 名和 Go 类型的重命名(311KB 的 diff 大部分是生成的代码和测试),**CLI/API 字段名 `syncWindows` 没有变**。重命名的动机从新名字能读出来:`InlineSyncWindow contains the kind, time, duration and attributes that are used to assign the syncWindows to apps`——强调这是「内联在 AppProject 里的窗口定义」,为将来可能出现的「非内联」窗口(比如引用一个独立的 SyncWindow CRD)留命名空间。这是一个纯重构,但它的价值在于:**在一个核心 API 类型上改名,本身就是「把隐含语义写进类型名」的契约化动作**。

## 五、五条功能线:渲染、删除、签名的边界各自往前一步

除了安全和性能,v3.6 还有几条承重的功能改动。

### 5.1 ApplicationSet 的 OCI generator(#26121)

ApplicationSet 之前支持 git / cluster / list / matrix / merge / pull request / scm provider 等 generator。v3.6 加了 OCI:

```yaml
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
metadata:
  name: platform-apps
spec:
  generators:
    - oci:
        repoURL: oci://ghcr.io/example/manifests
        revision: v1.2.3
        directories:
          - path: clusters/*
        files:
          - path: cluster-config/production/config.json
```

从 diff 看,`OciGenerator` 实现了两个接口断言:

```go
var (
	_ Generator  = (*OciGenerator)(nil)
	_ repoSource = (*OciGenerator)(nil)
)
```

`repoSource` 是内部接口,让 OCI generator 复用 git generator 已有的目录/文件遍历逻辑(`generateRepoSourceParams`)——同一个遍历框架,两种后端。requeue 默认 3 分钟。

**这里有一个必须说清的诚实边界**:OCI generator 的 `resolveSourceIntegrity` 直接返回 nil,源码里留着 TODO:

```go
// resolveSourceIntegrity returns nil because OCI signature verification
// is not yet supported.
// TODO(oci-signing): Add cosign/sigstore verification support.
func (o *OciGenerator) resolveSourceIntegrity(...) (*argoprojiov1alpha1.SourceIntegrity, error) {
	return nil, nil
}
```

也就是说,**OCI generator 目前不做来源完整性校验**。对一个新增的「从注册表拉清单」的入口,这正好是 §二 里那个信任模型的新缺口:git 路径有 commit 级别的可追溯性,OCI 路径目前没有签名校验。在 §二 讲的渲染层安全收口的同一个版本里,新增的 OCI 入口本身不带签名校验——这不是矛盾(新功能分期落地是正常的),但它意味着**用 OCI generator 的人必须自己在注册表层做准入控制**,不能假设 Argo CD 帮你验过来源。

### 5.2 hydrator 提交签名(Alpha)(#28239 / #28271)

Hydrator 是 Argo CD 的「把 dry 源渲染成 wet 源提交回仓库」的组件。v3.6 给 commit-server 加了 GPG 签名能力。设计上有一个值得单独拎出来的决定:

```go
// A configured signing key path is what enables signing: there is
// no separate on/off toggle. Inferring intent from the key path
// avoids contradictory states (enabled-but-no-key, key-but-disabled).
var signingConfig *gpgsign.Config
if signingKeyPath != "" {
    cfg, err := setupSigningKey(signingKeyPath, signingKeyPassphraseFile)
    errors.CheckError(err)
    signingConfig = cfg
    log.WithFields(log.Fields{
        "keyID":       cfg.KeyID,
        "fingerprint": cfg.Fingerprint,
        "gnupgHome":   common.GetGnuPGHomePath(),
    }).Info("Hydrated commit signing enabled")
}
```

**「配置了 key 就等于开启了签名,没有单独的开关」**——作者把理由写在了注释里:避免 `enabled-but-no-key`(开了但没 key)和 `key-but-disabled`(有 key 但没开)这两种自相矛盾的状态。这是本文「从默契到契约」主线的又一个实例:与其提供两个开关让用户可能配成矛盾状态,不如让配置本身只有一种解释。

启动时还有前置校验:`validateSigningFlags` 在 key 路径设了但 passphrase 文件没有(或反之)时直接启动失败。这是「启动期拒绝」而不是「运行时降级」。

### 5.3 ignore-differences 注解(#29616)

之前忽略差异规则只能配在 argocd-cm 的 `resource.customizations.ignoreDifferences` 里,全局生效。v3.6 让它可以直接写在资源上:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  annotations:
    argocd.argoproj.io/ignore-differences: |-
      jsonPointers:
      - /spec/replicas
```

common.go 里的注释写明当前只支持 `jsonPointers`:

```go
// AnnotationKeyIgnoreDifferences allows resources to specify ignore-differences rules as inline YAML.
// The value must be a YAML list, currently only supports jsonPointers key listing RFC6901 JSON Pointer paths.
```

这是把「全局配置」下沉到「资源级声明」——和 §四 的方向一致:把「什么该被忽略」这个决策从平台级默认变成资源级显式声明。

### 5.4 resource.additionalExclusions(#29416)

同样是为了「不改默认值只追加」。之前 `resource.exclusions` 是整体覆盖式的——Helm chart 或者官方 manifest 更新了默认 exclusions,你的自定义值就把默认值冲掉了。新键是追加:

```yaml
data:
  # Append extra exclusions to the current resource.exclusions value (optional).
  # This preserves defaults supplied in the installed argocd-cm.
  resource.additionalExclusions: |
    - apiGroups:
      - my.custom.io
      kinds:
      - "*"
```

文档明确说了边界:「If the installation removes or replaces `resource.exclusions`, `resource.additionalExclusions` does not restore those defaults.」——追加的是「当前值」,不是「原始默认值」。

### 5.5 同日三条 patch 分支:谁拿到了什么

同一天发布的 v3.5.5 / v3.4.11 / v3.3.16 的 changelog 值得对照看:

| 修复 | v3.6.0-rc2 | v3.5.5 | v3.4.11 | v3.3.16 |
|------|:---:|:---:|:---:|:---:|
| 三个 CRITICAL 渲染层(Kustomize remote ref / configHome / Jsonnet) | 有 | 无 | 无 | 无 |
| PreDelete hook 绕过 AppProject | 有 | 无 | 无 | 无 |
| 登录限流并发绕过 | 有 | 无 | 无 | 无 |
| SSH 代理命令注入 | 有 | 无 | 无 | 无 |
| extension proxy RBAC | 有 | 无 | 无 | 无 |
| OCI manifest 4MiB 拒绝 | 有 | 无 | 无 | 无 |
| hydrator notes push 重试 | 有 | 有 | 有 | 有 |
| OCI tag list 缓存 | 有(v3.5 路径) | 有 | 有 | 无 |
| repo(creds) 端点 URL 路由修复 | 无 | 有 | 无 | 有 |
| untar 符号链接检查 | 无 | 有 | 有 | 有 |
| CronWorkflow scheduled-time 格式 | 有 | 有 | 有 | 有 |
| go-git 依赖升级 | 有 | 有 | 有 | 有 |
| Log capturer 线程安全 | 无 | 有 | 有 | 有 |

**这张表本身就是最重要的升级建议**:三个 CRITICAL 的渲染层修复只出现在 3.6 分支上(截至 rc2 发布时)。停在 3.3 / 3.4 的用户拿到了同日 patch,但**没有拿到渲染层收口**。这不是 Argo CD 的疏漏——三个 CRITICAL 的修复涉及破坏性变更(干掉了 `helmGlobals.configHome`),往老分支 cherry-pick 会破坏既有用户;安全修复的回填策略本身就是「大版本收口,小版本维持兼容」。但对运行多租户 Argo 实例的团队,这个事实直接决定了升级优先级。

---

## 六、五段可运行代码

### 6.1 复现 Kustomize configHome 的执行路径(升级前自查)

升级前先查仓库里有没有用到这两个即将失效的能力:

```bash
# 1) 检查所有 kustomization 是否引用了远程资源
#    (remote ref 在 v3.6 被收紧,configHome 被直接 breaking)
grep -rn --include='kustomization.yaml' \
  -e '^resources:' -e 'helmGlobals:' -e 'configHome:' ./

# 2) 只列出真正引用了远程 URL 的 resources 段
grep -rn --include='kustomization.yaml' -A 20 '^resources:' ./ \
  | grep -E 'https?://|git::|github.com/'

# 3) 检查是否有人在用 Helm 插件(会随 configHome breaking 一起失效)
grep -rn --include='*.yaml' 'helmCharts:' ./
# 然后看这些 helmCharts 是否依赖本地插件目录:
# helm plugin list 的输出在 v3.6 之后对 Kustomize 渲染不再可见

# 4) Jsonnet 的 import 读文件能力 —— 检查是否有绝对路径 import
grep -rn --include='*.jsonnet' --include='*.libsonnet' \
  -E "importstr?\(['\"]/(etc|var|home|root|proc)" ./
```

升级到 v3.6 后,如果 Kustomize 构建依赖了 `helmGlobals.configHome` 下的插件,渲染会失败并报错;如果用了远程引用,取决于具体类型,会被拒绝。**建议在升级前先在 staging 跑一遍全量渲染**:

```bash
# 用 v3.6 的 argocd-repo-server 镜像在 staging 做干跑
argocd-repo-server --help 2>/dev/null
# 或者直接用 CLI 本地渲染对比
argocd app manifests <app-name> --revision HEAD > /tmp/v36.yaml
git stash && git checkout v3.5.5-branch
argocd app manifests <app-name> --revision HEAD > /tmp/v35.yaml
diff /tmp/v35.yaml /tmp/v36.yaml && echo "渲染结果一致"
```

### 6.2 AppProject 删除路径的约束检查

修复后,删除路径补上了和同步路径同源的项目约束检查。自定义检查脚本:

```bash
# 列出所有带 PreDelete/PostDelete hook 的应用,并检查它们的
# 目标命名空间是否在 AppProject 的 destinations 内
kubectl get apps -A -o json | python3 -c "
import json, sys
apps = json.load(sys.stdin)['items']
for a in apps:
    proj = a['spec']['project']
    ns = a['spec'].get('destination', {}).get('namespace', '')
    hooks = [
        r for r in a.get('status', {}).get('resources', [])
        if 'hook' in str(r)
    ]
    if hooks:
        print(f'{a[\"metadata\"][\"name\"]} (proj={proj} ns={ns}) has {len(hooks)} hook resources')
"

# 拿到 AppProject 的允许目的地,逐项比对
kubectl get appproject <proj> -o jsonpath='{.spec.destinations}' | python3 -m json.tool

# 修复后:删除应用时 PreDelete hook 的目标命名空间
# 必须在 AppProject destinations 内,否则整个删除被拒绝
```

### 6.3 manifest 压缩:开启、热重载与验证

```bash
# 1) 开启压缩(默认 gzip-bestspeed + json),不需要重启控制器
kubectl patch configmap argocd-cm -n argocd --type merge \
  -p '{"data":{"resource.manifest.compression.enabled":"true"}}'

# 2) 验证 setting 被读到了:看控制器的日志里有没有 cache invalidation
kubectl logs -n argocd -l app.kubernetes.io/name=argocd-application-controller \
  --tail=50 | grep -i "live state cache invalidated"

# 3) 压缩换内存:开之前先记录基线,开之后观察 15 分钟
kubectl get --raw /metrics | grep -E 'go_memstats_heap_inuse_bytes' \
  | head -1  # 记下基线
# ... 15 分钟后 ...
kubectl get --raw /metrics | grep -E 'go_memstats_heap_inuse_bytes' \
  | head -1  # 对比

# 4) 换 msgpack(序列化更快,压缩比略低)
kubectl patch configmap argocd-cm -n argocd --type merge \
  -p '{"data":{"resource.manifest.storage":"msgpack"}}'

# 5) 关掉(回退也是热重载,缓存自动重建)
kubectl patch configmap argocd-cm -n argocd --type merge \
  -p '{"data":{"resource.manifest.compression.enabled":"false"}}'

# 注意:开启/关闭/换算法都会触发整个集群缓存的失效重同步,
# 大集群上这个重同步期间 reconcile 会变慢,不要在高峰期操作。
```

### 6.4 SSD 优先级变更的验证

`ServerSideDiff=false` 现在是最高优先级拒绝。验证你的应用行为没变:

```bash
# 应用 A:控制器级 SSD 关,应用级显式关
kubectl annotate app <app-a> \
  argocd.argoproj.io/compare-options='ServerSideDiff=false'

# 应用 B:SSA 同步 + 应用级显式关 SSD
# v3.5: ServerSideApply=true 会重新触发 SMD -> SMD 生效
# v3.6: ServerSideDiff=false 赢 -> SSD 关闭,用客户端 diff
kubectl annotate app <app-b> \
  argocd.argoproj.io/compare-options='ServerSideDiff=false'
kubectl patch app <app-b> --type merge \
  -p '{"spec":{"syncPolicy":{"syncOptions":["ServerSideApply=true"]}}}'

# 对比两个版本的 diff 结果
argocd app diff <app-b> --server-side-generate=false  # v3.6 的客户端 diff
argocd app diff <app-b>                               # SSD 关时应当一致

# 观察:SSA 应用 + ServerSideDiff=false 的组合在 v3.6 下
# 会用客户端 diff,fieldOwnership 的信息不再出现在 diff 里。
# 如果你的告警依赖 fieldOwnership 输出,这是一个会变的点。
```

### 6.5 登录限流并发绕过的验证

```bash
# 1) 确认你的 argocd-server 副本数 —— 多副本时限流计数器的
#    共享方式决定了修复是否完整
kubectl get deploy -n argocd argocd-server -o jsonpath='{.spec.replicas}'
# 多副本场景下,确认升级后限流是全局的还是每实例的:
for i in $(seq 1 30); do
  curl -s -o /dev/null -w '%{http_code} ' \
    -u 'wronguser:wrongpass' \
    https://argocd.example.com/api/v1/session
done; echo

# 2) 并发登录尝试(修复后应当被限流挡住)
seq 1 50 | xargs -P 20 -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  -u 'wronguser:wrongpass' \
  https://argocd.example.com/api/v1/session \
  | sort | uniq -c
# 期望: 大部分返回 401, 达到阈值后返回 429
# 修复前: 全部返回 401 (计数器被并发绕过, 从不触发 429)

# 3) 限流恢复后正常登录应当可用
argocd login argocd.example.com --username <user> --password <pass>
```

---

## 七、五套 GitOps / 持续交付方案 17 维度对比

| 维度 | Argo CD v3.6 | Flux v2.9.6 | Argo Rollouts(配合 Argo CD) | Helmfile | Rancher Fleet |
|------|:---:|:---:|:---:|:---:|:---:|
| 渲染引擎边界 | 渲染期拒绝远程引用/configHome/Jsonnet 绝对路径 | 无 Kustomize 插件执行能力,渲染器只读 | 继承 Argo CD | 纯 Helm,无插件执行 | Kustomize + Helm,无插件执行 |
| 项目级隔离 | AppProject(命名空间/集群/仓库/clusterResourceWhitelist) | 无内建项目概念,靠 namespace + RBAC | 继承 Argo CD | 无 | Fleet bundle + clusterGroup |
| 删除路径约束 | v3.6 起 PreDelete/PostDelete hook 受 AppProject 约束 | 删除由 finalizer 驱动,无 hook 执行 | 继承 Argo CD | 无删除编排 | 有删除策略但无 hook |
| hook 机制 | Sync/Delete 全阶段 hook | 无原生 hook(需 Notification + 外部 Job) | 分析策略 hook | 无 | 无 |
| diff 引擎 | SSD 默认(apiserver fieldOwnership),SMD 移除 | 客户端 diff + server-side apply dry-run | 继承 Argo CD | 无 diff | 客户端 diff |
| 集群缓存压缩 | gzip/s2/zlib × json/msgpack,热重载 | informer 原生,无压缩选项 | 继承 Argo CD | 无集群缓存 | informer 原生 |
| OCI 作为清单源 | ApplicationSet OCI generator(**签名校验未实现**) | OCIRepository CRD(cosign 校验已支持) | 继承 Argo CD | 原生 OCI chart 支持 | 支持 OCI |
| 提交签名 | hydrator GPG 签名(Alpha) | 无 hydrator 概念 | 继承 Argo CD | 无 | 无 |
| UI | 完整(列表字段投影修复 + React Compiler) | 无 UI(纯 GitOps 声明式) | 独立渐进发布 UI | 无 | Rancher 内嵌 |
| 多租户成熟度 | 高(AppProject + 命名空间隔离 + extension RBAC) | 中(靠 K8s RBAC + namespace) | 继承 Argo CD | 低 | 中 |
| 渐进发布 | 需配合 Rollouts | 内置 Canary/BlueGreen via Flagger 或 Rollouts | 原生(Canary/BlueGreen/Experiment) | 无 | 无 |
| 安全响应速度 | 同日 4 条分支,渲染层收口只在 3.6 | 滚动发布,无 LTS 分支 | 跟随 Argo CD 节奏 | 社区维护较慢 | 跟随 Rancher 节奏 |
| 供应链签名验证 | 镜像 cosign + SLSA L3 provenance,OCI generator 未覆盖 | OCIRepository 支持 cosign | 继承 Argo CD | 无 | 无 |
| 学习曲线 | 中(概念多但文档全) | 低(少而精的 CRD) | 中 | 低(只解决 Helm) | 中 |
| 生态集成 | 丰富(Notification/Workflows/Events/CD Extensions) | 精选(Notification/Flagger/Terraform Controller) | 与 Argo 生态深度绑定 | Helm 生态 | Rancher 生态 |
| 升级破坏面 | v3.6 有 1 个明确 breaking(configHome)+ 1 个隐式(SSD 优先级) | 小版本通常无 breaking | 跟随 Argo CD | 无 | 小 |
| 适用规模 | 中到超大(单实例管数千应用) | 中到超大(控制器轻量) | 任意 | 小到中 | 中到大 |

**一句话选型**:Argo CD 的定位是「功能最全的控制平面」,代价是概念多、攻击面大、安全修复必须自己追;Flux 的定位是「把控制平面做小到几乎没有」,渲染器没有插件执行能力这件事不是 Flux 更安全的设计,是它一开始就没做这个功能;Fleet 绑定 Rancher 生态。真正在多租户场景里需要做的选择是「要一个功能全但需要追安全补丁的控制平面,还是一个功能少但没有这些洞的控制平面」。

---

## 八、六条 6-12 月可验证硬指标

1. **升级到 v3.6.0 正式版后 24 小时内**,对全量应用跑一遍渲染,统计渲染失败数。受影响的应用应当**全部**是「用了 `helmGlobals.configHome` 指向 Helm 插件目录」或「引用了被拒绝的远程引用类型」的。把这两个数字记下来——这是升级前自查脚本的基线。

2. **登录限流的 429 触发率**:升级后用 §6.5 的并发脚本验证,期望在阈值内的请求返回 401、超过阈值后返回 429。如果升级后**仍然全部返回 401**,说明你的 argocd-server 是多副本且限流计数器不是全局共享的——这是一个需要单独跟进的配置问题,不是修复本身的问题。

3. **集群缓存的堆内存变化**:开启 `resource.manifest.compression.enabled: "true"` 后,对管理 500+ 资源的集群,记录 `go_memstats_heap_inuse_bytes` 在 15 分钟窗口内的 P95。同时记录控制器的 CPU 使用率——压缩的 Trade-off 就是这两个数,你需要知道自己买到的是内存还是 CPU。

4. **SSD 命中率**:升级后统计带 `ServerSideApply=true` 且带 `ServerSideDiff=false` 注解的应用数。这个组合在 v3.5 会用 SMD,在 v3.6 会用客户端 diff(因为显式拒绝优先)。如果这个数不是 0,你的 diff 告警输出会变——这是**必定会变**的,不是回归。

5. **AppProject 删除路径的拦截次数**:升级后 30 天内,统计「删除应用时因 PreDelete/PostDelete hook 目标不在 AppProject destinations 内而被拒绝」的事件数。这个数大于 0 说明你之前确实存在越权删除路径,且这个路径在被利用前被堵上了。

6. **OCI generator 的准入覆盖率**:如果你开始用 ApplicationSet OCI generator,在注册表层统计「未通过签名校验但仍被 Argo CD 拉取成功」的清单数。当前这个数字**无法是 0 之外的值**——因为 OCI generator 不做校验。把它记下来的意义是:直到 cosign/sigstore 校验落地(源码里的 `TODO(oci-signing)`)之前,这个缺口必须由注册表层的准入控制补上。

## 九、六条 6-12 月可观察未来信号

1. **渲染引擎沙箱化**。三个 CRITICAL 之后,「渲染器在 repo-server 里能执行什么」这件事已经从「默认允许 + 文档建议」变成了「默认拒绝 + 显式开启」。下一个合理的演进是渲染过程本身跑在沙箱里(gVisor / Firecracker microVM / WASM),而不是继续一个个堵入口。观察 Argo 的 proposal 仓库里有没有 sandbox-related 的 design doc。

2. **OCI generator 补签名校验**。`TODO(oci-signing)` 是一个明确的承诺。Flux 的 OCIRepository 已经支持 cosign 校验,这是 Argo 必须补上的对等能力。补上的时间点会决定 OCI generator 能不能进生产。

3. **hydrator 签名从 Alpha 到 GA**。一旦 GA,「wet 源提交有签名」会成为 GitOps 可追溯性的新基线——配合 §五 的 OCI 签名缺口,这两件事合起来是「整条交付链路的来源完整性」。

4. **SyncWindow → InlineSyncWindow 的命名空间被用上**。重命名留出了「非内联 SyncWindow」的命名空间。如果 3.7/3.8 出现独立的 SyncWindow CRD(可以跨项目共享、可以单独管理窗口),说明这次重命名是设计先行。

5. **manifest 压缩的默认值翻转**。当前默认关闭,七个算法选项 + 两个序列化格式。如果在大规模用户的数据出来后(官方或社区的 benchmark)显示 `s2-encode` 或 `msgpack` 组合在典型负载下全面优于 `gzip-bestspeed + json`,默认值会翻转。这个翻转本身会是热重载的——这也是为什么热重载被设计进来。

6. **字段投影类回归成为独立测试门禁**。#29063 的根因是 PR #25451 为了减少列表页 payload 从 `APP_FIELDS` 里删掉了一个字段,而前端的 `getOperationType()` 依赖它的真值。删除字段的人在服务端测试里看不到任何失败,因为服务端返回的是「语义上错误的字段但恰好 truthy」。这类「投影字段 × 前端真值判断」的耦合会越来越多,值得观察 Argo 是否引入「字段投影变更必须跑前端契约测试」的 CI 门禁。

---

## 十、总结与最佳实践

### ✅ 该做

1. **把 3.6 升级排进本周**。三个 CRITICAL 渲染层修复只在 3.6 分支,同日的 v3.5.5 / v3.4.11 / v3.3.16 拿不到。多租户实例优先级最高。
2. **升级前跑 §6.1 的自查脚本**,确认没有 kustomization 依赖 `helmGlobals.configHome` 下的 Helm 插件。
3. **开 manifest 压缩前先量基线**,选 `gzip-bestspeed` 默认值,在非高峰期热重载,观察 15 分钟堆内存和 CPU。
4. **审计所有 PreDelete/PostDelete hook 的目标命名空间**,在升级前就比对 AppProject destinations——升级后这些路径会被拒绝,提前发现比升级当天发现好。
5. **给 OCI generator 配注册表层准入控制**,在 cosign 校验落地之前这是唯一能补来源完整性的位置。

### ❌ 千万别做

1. **不要**为了「保留 Helm 插件能力」而停留在 3.5/3.4。你拿不到渲染层收口,而且 `helmGlobals.configHome` 这条路本来就应该用 CMP sidecar 模式替代。
2. **不要**在高峰期切 manifest 压缩算法。每一次切换都触发整个集群缓存的失效重同步。
3. **不要**假设 `ServerSideApply=true` 会像 v3.5 那样覆盖 `ServerSideDiff=false`。显式拒绝现在优先,这是设计变更不是 bug。
4. **不要**把 OCI generator 当成「和 git 等价但更快」的清单源。它目前没有签名校验,信任边界和 git 不一样。
5. **不要**用「并发请求绕过登录限流」去测试生产环境的 argocd-server。用 staging 实例。

### 五步生产升级 checklist

- [ ] **第 1 步(升级前 1 天)**:跑 §6.1 自查脚本,记录 `helmGlobals.configHome` / 远程引用 / Jsonnet 绝对路径 import 的命中数。命中数 > 0 的应用单独标记。
- [ ] **第 2 步(升级当天 staging)**:部署 v3.6 到 staging,对全量应用干跑渲染,对比 v3.5 的渲染输出。任何差异都要能归因到 §二 的四个修复之一。
- [ ] **第 3 步(升级当天 staging)**:跑 §6.5 的并发登录测试,确认 429 能被触发。多副本 server 需要额外确认限流是否全局。
- [ ] **第 4 步(生产灰度)**:先升一个非核心项目的 argocd 实例,观察 24 小时。重点看 `argocd_app_info` 的 operation phase 指标是否正常(#29063 修的是 UI 投影,CLI 和 CRD 一直是对的,但顺手确认指标)。
- [ ] **第 5 步(升级后 1 周)**:审计 PreDelete/PostDelete hook 的拦截事件;对 500+ 资源的集群试开 manifest 压缩并记录堆内存/CPU 变化。

### 五条最佳实践

1. **渲染器是执行环境,不是模板引擎**。任何把 Kustomize / Helm / Jsonnet 放进服务端渲染的架构,都必须假设「能 push 的人能执行代码」,然后按这个假设做隔离。Argo CD 的 CMP sidecar 模式是这个思路的正面例子。
2. **显式拒绝必须优先于隐式开启**。`shouldUseServerSideDiff` 的优先级设计(`ServerSideDiff=false` 永远赢)是所有配置系统的正确默认。「允许覆盖」应该需要明确声明,而不是排在代码顺序后面。
3. **只读路径不要拷贝**。informer 缓存里的对象在只读路径上可以直接用,#29581 的两个修复展示了「分清只读和写入」在热路径上的价值。
4. **配置项不要做成两个可能矛盾的开关**。hydrator 签名用「有 key 就开」而不是「enable + key 两个开关」,这个设计值得所有做配置系统的团队学。
5. **安全修复的回填策略本身是信息**。「大版本收口、小版本维持兼容」意味着老分支的安全债是结构性的。选择停留在哪个分支,就是选择了承担哪些已知漏洞。

---

## 写在最后

2026 年 10 月 12 日这四个同时落地的 tag,表面是「安全补丁日」,内核是一次**边界契约的重写**。

Argo CD 用了三年时间成为 Kubernetes 持续交付的事实标准,代价是它把「渲染引擎」「项目隔离」「差异计算」「集群缓存」这四件事全做在了一个进程里。每一件事单独看都是合理的功能组合,合起来就形成了一个特殊的组件:它同时握着不可信输入的解析权和接近集群的执行环境,而中间没有一层显式的「渲染过程可以做什么」的约束。

v3.6 补的就是这一层。补的方式不是加审批流,不是加一层网关,而是**把那几个能执行/能读文件的入口,在渲染期和启动期直接拒绝**。`helmGlobals.configHome` 被整个 breaking 掉,是为了换掉「配置目录」和「代码执行目录」这两个身份的重合;`shouldUseServerSideDiff` 把三条开启路径收成一个函数并让显式拒绝优先,是为了换掉「配置项之间的优先级靠代码顺序决定」;commit-server 的签名用「有 key 就开」而不是两个开关,是为了换掉「enabled-but-no-key」这种自相矛盾的状态。

性能线的三件事是同一个动作的另一半:把控制器在每次 reconcile 里隐含做的序列化、拷贝、反序列化工作,变成**显式、可配、可观测**的运维参数。压缩是 opt-in 的、热重载的、有七个选项的——因为它是一个 Trade-off,而 Trade-off 应该由看得见监控的人做决定,不是由默认值替你做决定。

与早间「五维接管日」对照着看,这一天的完整图景是:AI 在五个栈层接管执行权的同时,基础设施层正在经历一次反向的、安静的重写——把那些「默认开放、靠默契维持」的入口一个个上锁。这两件事不是对立的,它们是同一件事的两面:**执行权越大,边界就必须写得越显式。**

而在所有这些修复里,最值得记住的一个细节是 OCI generator 源码里的那行 TODO:`resolveSourceIntegrity returns nil because OCI signature verification is not yet supported`。在一个把渲染层执行边界彻底上锁的版本里,新增的 OCI 入口自己还没有签名校验。作者把它写进了注释,没有藏起来。这是契约化该有的样子:边界写在明处,没写完的部分也写在明处。
