---
title: "containerd 2.4 深度拆解:EROFS 预热缓存、klauspost gzip 解压、CRI 挂载管理器与 GC 前向引用"
date: 2026-09-24
category: 技术
tags: [containerd, Kubernetes, CRI, EROFS, 快照, 镜像分发, warm cache, 预热, klauspost, gzip, 解压, mount manager, CDI, GC, 前向引用, NRI, UpdateSandbox, OTel, 敏感头, OCI, gVisor, Kata, 冷启动, AI 镜像, 2026]
excerpt: "containerd 2.4.0 (2026-09-16) 是继 2.3 LTS 之后第一个「清账型」版本:它一次性处理了四个在 2.x 时代积累了三年的结构性痛点 —— 冷启动预热与 EROFS 嵌套 overlay 的死局、gzip 层解压的 CPU 与分配开销、非 runc 运行时在 CRI 里的二等公民待遇、以及 GC 引用图只能反向枚举的内存放大。本文拆解 5 大承重级革新:EROFS layer_content_cache 把「预热缓存」从烤镜像流水线解耦成运营商拥有的只读目录;klauspost/compress 把 gzip 解压提速 1.4-1.5 倍并把分配抖动从 305MiB/191 万次 malloc 压到 0.18MiB/1948 次;CRI 挂载管理器 + CDI 强制启用 + 非 runc 运行时特性内省三件套把 gVisor/Kata 抬成一等公民;GC 前向引用让遍历器按需发射边而不是常驻整张引用图;敏感头剥离与 HTTP 299 warning 传播补齐跨源信任边界。每项都附可运行配置、Go 代码与性能数据。"
cover: https://images.unsplash.com/photo-1605348598389-8b40d4a64afc?w=600&h=400&fit=crop
readtime: 26
author: 林小白
---

# containerd 2.4 深度拆解:EROFS 预热缓存、klauspost gzip 解压、CRI 挂载管理器与 GC 前向引用

> 2026 年 9 月 16 日,containerd 2.4.0 与 API v1.12.0 同日发布。这是一个**regular(非 LTS)版本**,支持窗口比 LTS 短,定位是「想更快吃到新特性的用户」。但它的 release notes 有 125KB、658 个 commit —— 这个体积本身就说明了一件事:**这是 2.3 LTS 之后,清账力度最大的一个版本。**

containerd 的版本节奏值得先说清楚,因为它直接决定了你该不该装。当前的并行线是:

| 分支 | 定位 | 最新 |
|------|------|------|
| v2.4.x | regular,新特性优先,支持窗口短 | 2.4.0 (2026-09-16) |
| v2.3.x | **LTS**,长支持,稳定优先 | 2.3.5 (2026-09-04) |
| v2.2.x | 旧 LTS,维护中 | 2.2.8 (2026-09-04) |
| v2.0.x / v1.7.x | 老线安全维护 | 2.0.12 / 1.7.35 |

2.4 的特殊之处在于:**它是 2.3 LTS 之后的第一个版本,按 containerd 的发布约定,这正是「此前 deprecated 的特性可以被移除」的时间点**。所以 2.4 不是一个「修 bug + 加小特性」的常规迭代 —— 它带着一组 breaking change,把过去三年里所有标记为 deprecated 的配置项一次性清掉了。官方 release notes 自己也在最前面提醒:**升级前先把你当前版本的 deprecation warning 清干净**。

本文不讲怎么装。本文讲的是:这 658 个 commit 里,真正改变容器运行时**架构形状**的五件事,以及它们为什么现在发生。

## 0. 一句话总结

**containerd 2.4 把「镜像」从一个「拉取即完成」的动作,重新拆解成一条可以被独立预热、独立校验、独立计费的流水线。**

EROFS 预热缓存让「冷启动慢」第一次可以**不通过重新烤 OS 镜像**来解决;klauspost gzip 解压让 AI 大镜像(3-7 GiB 解压后)的拉取时间回到可预测区间;CRI 挂载管理器 + 非 runc 运行时内省让沙箱类运行时(gVisor / Kata)不再是「能用但处处受限」的二等公民;GC 前向引用让内容存储的引用图遍历不再为边集常驻内存;而敏感头剥离 + HTTP 299 warning 传播,补上的是 OCI 分发生态过去一直缺的**跨源信任边界**和**注册表可观测性**。

这五件事放在一起,指向同一个方向:**镜像层正在变成一种需要被主动运维的存储基础设施,而不是一次性的部署产物。**

---

## 1. 问题的源头:为什么 2026 年的镜像层成了瓶颈

要理解 2.4 改了什么,得先理解 2.4 之前,镜像层在架构上的四个结构性痛点。它们不是同一个问题,但被同一个版本同时处理了。

### 1.1 冷启动:「预热」和「烤镜像」被错误地耦合在一起

过去三年,所有云厂商都给出了同一个解法来解决 Pod 冷启动慢:**把镜像内容预先拉到节点上**。AWS 的 EKS 建议预热镜像,Google 的 Artifact Registry 提供镜像预热,Oracle 建议把镜像内容预置到节点存储。containerd 2.4 的 EROFS 预热缓存 PR(#13813)在正文里把这些做法逐条列了出来,然后指出:这批方案在 EROFS 上**全都行不通**。

原因是一个具体的、内核层面的约束:**EROFS 不能嵌套在 overlay 之下**。

节点上「保留可写层」的常规做法是 overlay:下层只读缓存,上层可写,写时重定向到别处。但 EROFS 的挂载模型不允许:

- EROFS 不能直接挂载位于 overlay 之下的 blob,每个层都会**回退到 loop 设备**;
- 容器自己的可写 overlay **不能叠在另一个 overlay 之上**,两者会冲突。

于是只剩两条难走的路:要么用可写缓存挂载 —— 但那样就没法在节点间**只读共享**;要么把缓存垫在 overlay 下面 —— 但 EROFS 挡住了这条路径。这不是配置问题,是文件系统叠加规则问题。

另一个常见做法是「烤进 OS 镜像」:在 OS 镜像构建时把内容灌进 containerd 的 content store。它能工作,但代价是**烤镜像流水线被耦合到了容器镜像上**:预热的镜像集合一变,OS 镜像就得重烤。对一个每天推几十个新镜像的 AI 平台来说,这个耦合是不可接受的。

### 1.2 gzip 解压:被 stdlib 限制住的拉取性能

OCI 镜像层的默认压缩格式仍然是 gzip。过去三年,containerd 用 stdlib 的 `compress/gzip` 解压这些层,而同生态的其他工具(CRI-O、Podman、Buildah、Skopeo)全部通过 `containers/image` 共享 **klauspost 的 inflate 实现**。containerd 是最后一个还在用 stdlib 的。

这不是品味问题。PR #13560 的作者在 NVIDIA Grace(arm64)上实测了两个典型 AI 镜像的最大层:

| 镜像 | 压缩 → 解压 | stdlib | klauspost | 提速 |
|------|------------|-------:|----------:|-----:|
| `nvcr.io/nvidia/cuda:13.1.2-devel-ubi9` | 1.8 → 3.4 GiB | 13.6s | 9.1s | **~1.5×** |
| `docker.io/pytorch/pytorch:latest` | 3.4 → 7.0 GiB | 41.7s | 28.8s | **~1.4×** |

(均值 n=6,相对标准差 < 1.5%,Go 1.26.3)

更值得注意的是分配抖动 —— 对一个每分钟拉几百个层的节点来说,这比墙钟时间更重要:

| 指标 | stdlib | klauspost |
|------|-------:|----------:|
| 内存分配(cuda 镜像) | 305 MiB | **0.18 MiB** |
| malloc 次数 | 1,910,000 | **1,948** |

305 MiB → 0.18 MiB 不是优化,是**三个数量级的量级差**。GC 压力、节点上的内存碎片、与业务 Pod 的内存竞争,全部随之消失。

### 1.3 非 runc 运行时:被一段防御性判断挡住的内省

CRI 有个机制:运行时可以声明自己支持哪些特性(只读挂载、用户命名空间等),kubelet 拿到这些声明后决定调度。在 2.4 之前,这个内省逻辑里有一段判断:

```go
if r.Type != RuntimeRuncV2 {
    return nil  // 非 runc,不查
}
```

这段代码的原始动机是规避一个 nil options 的序列化 panic,但后来那个 panic 已经被 `if options != nil` 兜住了,这段判断变成了**纯历史包袱**。它的实际后果是:gVisor 的 `runsc` 实现了 `-info`、会返回 `specutils.Features()`,但 containerd **拒绝调用它**。

用户看到的现象是这样的:用 `runtimeClassName: gvisor` + `hostUsers: false` 提交 Pod,kubelet 直接拒绝:

```
RuntimeClass handler "runsc" does not support user namespaces
```

`crictl info` 里 runc 有 `features.user_namespaces: true`,而 `runsc` 的 features 字段是空的 —— **不是因为它不支持,是因为 containerd 从来没问过它**。

### 1.4 GC 引用图:反向枚举的内存代价

containerd 的内容存储(content store)是一个以 blob 为节点的 DAG,GC 沿着引用边遍历,标记存活节点。2.4 之前,引用只有一种方向:**反向引用(back-reference)**。

反向引用的问题是,一个 collector 必须**在遍历开始前就把所有边枚举出来**,塞进 `gcContext` 的 `backRefs` map 里,整个收集周期内**一直持有**。对一个内容存储里动辄几十万个 blob、扇出极大的层(一个镜像 manifest 被几百个 index 引用)来说,这张 map 本身就是内存放大源。

**关键洞察 1:这四个痛点看起来毫无关联(预热 / 解压 / 运行时特性 / GC / 头部安全),但它们共享同一个根源 —— 镜像层过去是被当作「一次性的部署产物」设计的,而 2026 年的 AI 工作负载把它用成了「高频流动的存储对象」。** 大镜像(7 GiB 解压后)、高周转(每天数十个新镜像)、多运行时(沙箱化要求 gVisor/Kata 与 runc 并存)、强审计(合规要求每层可验证)—— 这四件事同时发生,才让这四个「陈年技术债」同时变成瓶颈。

---

## 2. 五层架构:镜像从注册表到容器进程的完整路径

在讲改动之前,先把 containerd 处理镜像的五层架构画清楚。2.4 的五个革新恰好**每层一个**,这不是巧合 —— 它说明这一版是按层做的系统性清理,而不是头痛医头。

```
┌─────────────────────────────────────────────────────────────┐
│  Layer 1  镜像分发 (Image Distribution)                      │
│  docker fetcher / descriptor.urls / hosts.toml              │
│  → 2.4: 敏感头剥离 + HTTP 299 warning 传播                   │
├─────────────────────────────────────────────────────────────┤
│  Layer 2  内容存储 (Content Store)                           │
│  blob DAG / GC 引用图 / digest 索引                          │
│  → 2.4: GC 前向引用 (forward References)                     │
├─────────────────────────────────────────────────────────────┤
│  Layer 3  快照 (Snapshotters)                                │
│  overlayfs / erofs / blockfile / devmapper / zfs            │
│  → 2.4: EROFS layer_content_cache 预热 + Prometheus 指标     │
├─────────────────────────────────────────────────────────────┤
│  Layer 4  挂载与设备 (Mounts & CDI)                          │
│  mount manager / CDI 设备注入 / idmap / RRO                  │
│  → 2.4: CRI 挂载管理器 + CDI 强制启用 + 快照 max-size 标签   │
├─────────────────────────────────────────────────────────────┤
│  Layer 5  运行时 (Runtime & Shim)                            │
│  runc / runsc / crun / kata / sandbox controller / NRI       │
│  → 2.4: 非 runc 特性内省 + UpdateSandbox RPC + OTel 透传     │
└─────────────────────────────────────────────────────────────┘
```

一个镜像从注册表到容器进程,走完这五层。**2.4 之前,这五层里每一层都有一个「能跑但别扭」的点**:分发层会泄露敏感头,内容存储层为引用图常驻内存,快照层不能预热,挂载层对镜像卷的处理不够干净,运行时层只认 runc。2.4 一层一个,全部点掉了。

这个观察本身值得记住:**好的「清账版本」不是堆 feature,而是把每一层里那个「能跑但别扭」的点逐层消掉。** 658 个 commit 里,真正改变架构形状的只有这五个;剩下的是把已有机制的边界条件补齐。

---

## 3. 版本细节:5 大承重级革新

### 3.1 EROFS `layer_content_cache`:预热缓存与镜像流水线的解耦

这是本版**含金量最高**的改动,因为它解决的是一个「所有云厂商都尝试过、所有人都绕开了、没人正面解决」的问题。

方案的核心是给 EROFS snapshotter 加一个 `layer_content_cache` 配置项:一个**指向已转换、以 diffID 为键的 EROFS layer blob 目录**的路径,目录布局严格规定为 `<dir>/<algorithm>/<hex>.erofs`。

三个设计决策决定了它为什么能成:

**① 目录是运营商拥有的,containerd 从不写它。** 这个目录以只读方式从外部存储挂载进来。containerd 在缓存命中时**只做一个 symlink 动作**,然后返回 `ErrAlreadyExists`。这意味着:

- 缓存可以被任意数量的节点**只读共享**( NFS、分布式块存储、CSI 卷都行);
- 缓存的生命周期完全在 containerd 之外,镜像版本更新只需要更新外部存储;
- **烤 OS 镜像的流水线与容器镜像彻底解耦** —— 这是最关键的一条。

**② 它绕开了 EROFS 的嵌套 overlay 限制,而不是违反它。** 之前说过,EROFS 不能垫在 overlay 下面。这个方案不试图垫 —— 它直接让 EROFS blob 本身成为缓存的载体,挂载时走 EROFS 的 file-backed 路径(Linux 6.12+ 原生支持,不需要 loop 设备)。可写层照旧是容器自己的 overlay,与缓存层不叠加。

**③ 缓存未命中时是优雅降级,不是失败。** 未命中时 snapshotter 现场转换层并落盘,下次就能命中。迁移路径是:先开配置(空目录也不报错),预热存储逐步填充,命中率自然爬升。

配套还加了 Prometheus 指标(#13941),因为「不开指标就没法运维」:

- 缓存查找速率
- 纯缓存命中数 / 从缓存服务的层字节数
- 缓存未命中时花在转换层上的时间

以及一个 `max size` 快照标签(#13520),让快照可以声明尺寸上限 —— 对 EROFS 的 block 模式(给定大小的虚拟块作为 overlayfs 上层,用于磁盘配额)是必需的元数据。

**一个必须澄清的边界**:这个方案**只对 EROFS snapshotter 有效**。你的节点如果还在用 overlayfs snapshotter,`layer_content_cache` 配置项不存在。EROFS snapshotter 本身是从 containerd 2.x 早期就存在的(由 EROFS 内核维护者实现),但它过去是「小众高性能选项」;2.4 把它补齐成了**唯一能做只读共享预热的 snapshotter**。这是一个重要的生态位变化。

### 3.2 klauspost/compress:gzip 解压的 1.5 倍提速与三个数量级的分配削减

containerd 2.4 把 `gzipDecompress` 的实现从 stdlib 换成了 klauspost 的 inflate 代码。这个改动**只影响 gzip OCI 层的解压**,不碰 zstd —— 因为 zstd 之前就已经用 klauspost 了。

所以实际的依赖变化只是:`klauspost/compress` 从 v1.18.5 升到 v1.20.0,而这个库**本来就是 containerd 的依赖**。这是一次零新依赖的性能修复。

性能数据在 §1.2 已经给过:1.4-1.5 倍墙钟提速,305 MiB → 0.18 MiB 分配,191 万 → 1948 次 malloc。

**为什么这件事对 AI 工作负载尤其重要**:AI 镜像的层结构与大小区间,恰好落在 stdlib 实现的最差区间。一个 CUDA 开发镜像解压后 3.4 GiB,一个 PyTorch 镜像解压后 7.0 GiB —— 这些层的解压在节点上是**串行的、CPU 密集的、在 Pod 调度关键路径上的**。41.7 秒 → 28.8 秒,对一个要拉起 1000 个 GPU Pod 的推理集群来说,是 1000 × 13 秒 = 3.6 小时的节点 CPU 时间。

**关键洞察 2:klauspost 的 PR 正文特意提到,这个 inflate 实现已经被暴露给不可信输入(VictoriaMetrics 等项目),有成熟的安全审计历史。** 对 containerd 来说这不是「引入新风险」,而是「与生态对齐」—— CRI-O / Podman / Buildah / Skopeo 全部已经在用同一个 inflate 核心。containerd 补齐的是一致性,不是新奇性。

### 3.3 CRI 挂载管理器 + CDI 强制启用 + 非 runc 内省:沙箱运行时的一等公民化

这三件事必须一起讲,因为它们共同构成一个主题:**让 gVisor / Kata / 其他非 runc 运行时在 CRI 里不再有功能缺口。**

**① CRI 挂载管理器(#13542)。** 之前 CRI 对镜像卷(image volumes)的挂载处理是「失败就全部卸载」。2.4 改成**挂载管理器**模式:只在真正失败的那一步做清理(#14143: only unmount image volumes when mounting fails)。这减少了一类常见的「整卷因单个子挂载失败而不可用」的故障。

**② CDI 强制启用。** 2.4 移除了 CRI 运行时配置里的 `enable_cdi` 选项 —— **CDI(容器设备接口)现在永远启用,不可关闭**。对 GPU/AI 工作负载,CDI 是设备注入的标准路径;对沙箱运行时,CDI 的设备透传语义(而非挂载 `/dev` 的老办法)更安全、更可审计。把它变成不可选,意味着所有运行时共享同一套设备语义,沙箱运行时不再需要自己实现一套。

**③ 非 runc 运行时特性内省(#13504)。** 移除 `r.Type != RuntimeRuncV2` 的守卫后:

| 运行时 | 2.4 的变化 |
|--------|-----------|
| `runc` | 不变 |
| `runsc` / `crun` / `kata` / ... | shim 的 `-info` 特性被上报到 `RuntimeHandlerFeatures`(RRO 挂载、用户命名空间等) |
| 没有 `-info` 的 shim | 内省失败,debug 级日志,不上报特性 —— 与之前非 runc 的行为一致 |

**必须诚实说明的局限**:这只解决了 containerd 的一半。gVisor 那边还需要自己的 shim 改动 —— `supportsCRIUserns` 同时要求用户命名空间 **和** idmap 挂载(`MountExtensions.IDMap.Enabled`),而 runsc 目前只上报前者。所以 2.4 发布时,`runsc` 的用户命名空间**仍然不会**被上报为可用。这是一个「使能项(enabler)」,不是「已完成项」。已经同时具备两项特性的运行时立刻受益。

**④ 默认开启用户命名空间的 hostNetwork 特性(#13162)。** `runtimeFeatures.UserNamespacesHostNetwork` 默认置 true。这个值会被 kubelet 的 NodeDeclaredFeatures 机制读取 —— **这也是为什么它必须精确地在某个 containerd 版本里被打开**:kubelet 需要知道「哪个版本提供了这个能力」。这是一个版本契约,不是配置偏好。

### 3.4 GC 前向引用:引用图从「预枚举」变成「按需发射」

这是一个**纯架构改动**,而且作者在 PR 里明确说:它**当前不接入任何 collector**,是一个有意为之的接口预留。

改动给 GC 框架加了一个可选接口:

```go
References(ctx context.Context, node gc.Node, fn func(gc.Node))
```

一个 `CollectionContext` 可以选择实现这个接口(通过 `collectionWithReferences`)。当 GC 遍历到一个由外部 collector 注册的资源类型的节点时,`gcContext.references` 会在处理完内置核心资源类型之后,调用该类型的 `References` 实现。

**与反向引用的关键区别**:

| 维度 | 反向引用 (collectionWithBackRefs) | 前向引用 (collectionWithReferences) |
|------|----------------------------------|------------------------------------|
| 枚举时机 | 遍历**开始前**全部枚举 | 遍历到节点时**按需发射** |
| 内存占用 | `backRefs` map **整个收集周期常驻** | 只发射当前节点的边,**不保留** |
| 适用形状 | 边数少、可穷举 | **扇出极大**的 collector |

**关键洞察 3:为什么一个「当前没人用的接口」值得占一个承重级革新的位置?** 因为它是**接口级的解耦**:有了前向引用,扇出极大的 collector(比如镜像 manifest 被 index 引用的关系、NRI 插件注册的外部资源)就可以在不修改 GC 核心的情况下接入。作者把它隔离成独立 PR 的理由写得很明白 —— 「让依赖这个接口的并发开发工作可以独立地在 upstream 提议和 review」。**在基础设施项目里,「先定接口后接实现」是降低后续协作冲突的标准做法。** 评判这类改动不要看它今天做了什么,要看它让什么「变得可能」。

### 3.5 分发层硬化:跨源信任边界与注册表可观测性

这一组改动都不大,但它们补的是**OCI 分发生态的协议级缺口**。

**① 敏感头剥离(#12889)。** containerd 支持从 `descriptor.urls`(OCI descriptor 的 URL 字段)抓取内容。之前这条路径会**复用 resolver/全局的请求头**(CRI 的 `registry.headers` / hosts 配置的头)。当 `desc.urls` 指向一个**非注册表来源**时,把 `Authorization`、`Proxy-Authorization`、`Cookie`、`Cookie2` 这些头转发过去,就是一个跨源信任边界的漏洞 —— 接收方可以读到本该只给注册表的凭证。

2.4 的改法很克制:**保留 operator 的控制权和现有行为,只在 desc.urls 驱动的请求上剥离这一小批 well-known 敏感头**,非敏感的自定义头照常流转。这个行为**与 Go 标准库处理重定向时的策略一致**(敏感头不跨源转发)。范围严格限定在 `core/remotes/docker`。

**② HTTP 299 warning 传播(#12698)。** OCI Distribution Spec 规定,注册表可以在 HTTP Warning 头里返回信息性警告(RFC 7234 §5.5,warn-code 299)。2.4 之前 containerd **默默丢弃这些头**。

改动新增了 `WarningHandler`,挂在 `ResolverOptions` 上,调用方可以接收并处理注册表发来的 299 警告。这件事的意义在于:**它让注册表的运维信号第一次能到达容器运行时**。注册表可以预告「此镜像即将弃用」「此层的存储策略将变更」「限速即将触发」,而容器运行时可以记录、告警、甚至据此调整拉取策略。

**③ sysfs 信息遮蔽(#14090)。** Linux 容器默认遮蔽 `/proc/interrupts` 和 CPU 热节流相关的 sysfs 路径。这是**侧信道加固**:中断计数与热节流统计可以用于跨容器的时序推断攻击。默认遮蔽意味着新部署不再需要手动配 maskedPaths。

**④ 追踪配置标准化(#14166 的一部分)。** 2.4 移除了一组 containerd 私有的追踪配置:

- OTLP processor 的 `endpoint` / `protocol` / `insecure` → 改用标准 OTLP 环境变量
- 内部追踪的 `service_name` / `sampling_ratio` → 改用标准 OpenTelemetry 环境变量

**这是本版最重要的 breaking change 之一**,因为它把可观测性配置从「containerd 私有方言」迁到了「OTel 标准」。升级前必须改配置,否则追踪会静默失效。

**⑤ 敏感头 + warning + OTel 三件套合起来看,是一个完整的「分发层可观测与可信」拼图:凭证不外泄(安全)、注册表声音能听见(可观测)、追踪配置标准化(可维护)。** 过去这三件事各自是「能跑但别扭」。

### 3.6 附带清单:那些小但关键的修复

除了五个承重级,这版还有一批值得单独点名的改动:

| 改动 | PR | 为什么重要 |
|------|----|-----------|
| `restart=always` 显式停止后不再立即重启 | #13993 | 之前 `nerdctl stop` 后容器仍会在几秒后重启,与 Docker 行为不一致。对 CI/CD 的停止-清理流程是真实困扰 |
| `UpdateSandbox` RPC 打通到 shim | #14105 | `UpdateSandboxRequest/Response` 自 Sandbox API 引入就存在但从未被使用,`controllerLocal.Update` 是空实现。**shim 现在第一次能知道自己的 sandbox 元数据变了**;老字段 `resources`/`annotations` 标记 deprecated |
| `unpack.WithFetchAllContent` | #14126 | **保留的快照可能比层 blob 活得久**(GC 删了 blob,快照还在)。此时 pull+unpack 会跳过下载,导致镜像**无法 save/export/push**。新选项在快照已存在时也强制拉取所有层 |
| 符号链接的 `/etc/passwd` 解析 | #13818 | NixOS 等用绝对符号链接指向 `/nix/store`。之前只处理末段符号链接,现在逐段解析(最多 40 跳,与 Linux path_resolution 一致)。注意:**不用 `os.Root`,因为它拒绝绝对符号链接**(Go issue #67002) |
| Windows shim named-pipe | #13948 | `pkg/shim` 之前在 Windows 上所有平台钩子是 `ErrNotImplemented`。现在 ttrpc 走 named pipe,日志流走可重连 named pipe(containerd 重启后自动重接受读端) |
| runc checkpoint `--parent-path` | #13699 | 支持 CRIU 的增量检查点特性 |
| NRI 暴露镜像元数据 | #13960 | NRI 插件现在能拿到镜像引用、解析到的 digest(image index 或 manifest)和 config digest |
| shim → runc/hooks 透传 tracing context | #14036 | 追踪 span 终于能跨 shim 边界 |

**关键洞察 4:`unpack.WithFetchAllContent` 修的是一个非常隐蔽但后果严重的 bug —— 「镜像拉取成功了但导不出来」。** 它的根因是「快照」和「内容」的生命周期被 GC 解耦了,但 pull 逻辑没跟上。这类 bug 的特征是:**在 CI 里永远复现不了**(CI 每次干净环境),只在长期运行的节点上、在 GC 跑过之后、在你需要 `ctr image export` 的那个紧急时刻出现。它值得单独记一笔:快照是视图,内容是事实,两者可以独立消亡。

---

## 4. 代码:五段可运行的实战示例

### 4.1 启用 EROFS snapshotter 并配置预热缓存

先确认环境:EROFS 内核模块(Linux 5.4+,文件挂载需 6.12+)与 erofs-utils 1.7+(推荐 1.8.2+):

```bash
modprobe erofs
apt install erofs-utils   # Debian/Ubuntu
# dnf install erofs-utils # Fedora

# 确认 snapshotter 和 differ 都在
ctr plugins ls | grep erofs
# io.containerd.snapshotter.v1  erofs   linux/amd64  ok
# io.containerd.differ.v1       erofs   linux/amd64  ok
```

`config.toml` 关键段:

```toml
[plugins."io.containerd.snapshotter.v1.erofs"]
  enable_fsverity = true
  # 2.4 新增:预热缓存目录。运营商拥有,只读挂载,containerd 从不写它。
  # 目录布局必须是 <dir>/<algorithm>/<hex>.erofs
  layer_content_cache = "/mnt/erofs-warm-cache"
  # 可选:给快照声明尺寸上限(供 block 模式做磁盘配额)
  default_size = "20GiB"

[plugins."io.containerd.differ.v1.erofs"]
  # erofs-utils >= 1.8:可复现构建
  # erofs-utils >= 1.8.2:跳过 tar 重排,提升转换性能
  mkfs_options = ["-T0", "--mkfs-time", "--sort=none"]

[plugins."io.containerd.service.v1.diff-service"]
  default = ["erofs", "walking"]
```

用预热缓存跑容器:

```bash
ctr image pull docker.io/library/busybox:latest
# 显式指定 snapshotter
ctr run --rm -t --snapshotter erofs docker.io/library/busybox:latest hello sh
```

**缓存填充策略**(独立于 containerd 运行):预热任务从注册表拉镜像、用 erofs differ 转换每个层、按 `<algorithm>/<hex>.erofs` 布局写入 `/mnt/erofs-warm-cache`。这个任务可以用任何工具实现(Airflow、cron、Prow job),因为它只需要产出符合目录布局的文件。**这就是解耦的价值:预热流水线不再需要碰 containerd 的内部状态。**

### 4.2 观测预热缓存的健康度(2.4 新增的 Prometheus 指标)

```yaml
# prometheus.yml
scrape_configs:
  - job_name: containerd
    static_configs:
      - targets: ["localhost:6080"]  # containerd metrics endpoint
```

PromQL 示例 —— 缓存命中率(2.4 暴露的指标用于回答:预热到底省了多少转换时间):

```promql
# 缓存查找速率:节点冷启动压力的直接信号
rate(erofs_snapshotter_cache_lookups_total[5m])

# 纯缓存命中提供的层字节数 vs 未命中现场转换的字节数
sum(rate(erofs_snapshotter_layer_bytes_total{source="hit"}[1h]))
/
sum(rate(erofs_snapshotter_layer_bytes_total{source="miss"}[1h]))

# 缓存未命中时花在现场转换上的时间 —— 预热任务的容量规划依据
histogram_quantile(
  0.95,
  rate(erofs_snapshotter_convert_duration_seconds_bucket[5m])
)
```

**告警建议**:当未命中转换的 P95 超过 30 秒,说明预热覆盖不足 —— 该扩充缓存目录的镜像集合了。

### 4.3 拿到非 runc 运行时的特性(并理解为什么 gVisor 还不行)

```bash
# 2.4 之后,crictl info 会列出所有 shim 上报的特性
crictl info | python3 -c "
import json,sys
d = json.load(sys.stdin)
for name, h in d['status']['conditions'] and d['runtimeHandlers'].items() if 'runtimeHandlers' in d else []:
    pass
print(json.dumps(d.get('runtimeHandlers', {}), indent=2))
"
```

一个自定义 shim 只需实现 `-info` 并返回 OCI runtime features,就能被 CRI 上报。Go 骨架:

```go
// cmd/containerd-shim-myrt-v1/main.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/containerd/containerd/v2/cmd/containerd-shim-shim-v1/manager" // 按实际包路径
)

// features 结构与 runc 的 specutils.Features() 对齐
type Features struct {
	Linux           *LinuxFeatures `json:"linux,omitempty"`
	Annotations     map[string]string `json:"annotations,omitempty"`
}
type LinuxFeatures struct {
	// 要让 CRI 上报 UserNamespaces: true,必须同时具备 user namespace 与 idmap 挂载
	UserNamespaces bool `json:"user_namespaces"`
	MountExtensions struct {
		IDMap struct{ Enabled bool } `json:"idmap"`
	} `json:"mount_extensions"`
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "-info" {
		f := Features{
			Linux: &LinuxFeatures{
				UserNamespaces: true,
				MountExtensions: struct {
					IDMap struct{ Enabled bool } `json:"idmap"`
				}{IDMap: struct{ Enabled bool }{Enabled: true}},
			},
		}
		b, _ := json.Marshal(f)
		fmt.Println(string(b))
		return
	}
	// 正常 shim 服务路径 ...
	_ = context.Background
}
```

**踩坑提醒(来自 PR #13504 的明确说明)**:`supportsCRIUserns` 要求 user namespace **和** `MountExtensions.IDMap.Enabled` **同时为真**。只上报 user_namespaces 不会让 CRI 把你标成支持用户命名空间 —— kubelet 那边依然会拒绝。gVisor 的 `runsc` 目前就卡在这一步:它上报 user namespace 但没有 idmap。

### 4.4 GC 前向引用:为外部 collector 预留的接口

这是接口定义(在 containerd 源码里),展示它的形状:

```go
// gc/gc.go —— 2.4 新增的可选接口
package gc

import "context"

// Node 是 GC 图中的一个节点
type Node struct {
	// 资源类型 / 关系 / 值
}

// CollectionContext 可以选择实现 collectionWithReferences。
// 与 collectionWithBackRefs 相反:边在遍历时按需发射,不在收集开始前枚举。
type collectionWithReferences interface {
	// References 为给定节点发射它的前向引用。
	// fn 对每条边调用一次。实现不应持有这些边 —— 它们应当在调用后即可丢弃。
	References(ctx context.Context, node Node, fn func(Node))
}
```

一个扇出极大的外部 collector 接入骨架:

```go
package mycollector

import (
	"context"

	"github.com/containerd/containerd/v2/core/gc"
)

// ManifestIndexCollector: 一个 manifest 被几百个 index 引用。
// 反向引用需要在收集开始前枚举出全部边并常驻;
// 前向引用让我们在遍历到 manifest 时再发射它的引用者。
type ManifestIndexCollector struct {
	store ManifestStore // 假设能按 digest 查引用者
}

var _ gc.CollectionContext = (*ManifestIndexCollector)(nil)

// 实现 collectionWithReferences(可选,通过接口断言被 GC 框架发现)
func (c *ManifestIndexCollector) References(
	ctx context.Context,
	node gc.Node,
	fn func(gc.Node),
) {
	// 只为 manifest 类型的节点发射
	if !isManifest(node) {
		return
	}
	// 流式发射,不在内存里累积整张边集
	for _, indexDigest := range c.store.Referencers(ctx, node.Value) {
		select {
		case <-ctx.Done():
			return
		default:
		}
		fn(gc.Node{
			// 目标节点:index digest
		})
	}
}
```

**再次强调**:截至 2.4.0,**没有任何 collector 注册使用这个接口**。上面这段代码演示的是「接口的形状」,不是「2.4 里已经能跑的东西」。它的价值在于:扇出极大的 collector 现在有了接入路径,而这个路径不需要再改 GC 核心。

### 4.5 追踪配置迁移(升级到 2.4 必须做的 breaking change)

**升级前(2.3 及以前)**:

```toml
[plugins."io.containerd.tracing.processor.v1.otlp"]
  endpoint = "otel-collector.observability.svc:4317"
  protocol = "grpc"
  insecure = true

[plugins."io.containerd.tracing.v1.otlp"]
  service_name = "containerd"
  sampling_ratio = 0.01
```

**升级后(2.4)** —— 全部改用标准 OTLP 环境变量:

```bash
# /etc/systemd/system/containerd.service.d/override.conf
[Service]
Environment=OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector.observability.svc:4317
Environment=OTEL_EXPORTER_OTLP_PROTOCOL=grpc
Environment=OTEL_EXPORTER_OTLP_INSECURE=true
Environment=OTEL_SERVICE_NAME=containerd
Environment=OTEL_TRACES_SAMPLER=parentbased_traceidratio
Environment=OTEL_TRACES_SAMPLER_ARG=0.01
```

同时被移除的 CRI 配置:

```toml
# 2.3: 可选
[plugins."io.containerd.cri.v1.runtime"]
  enable_cdi = true          # 2.4: 移除,CDI 现在永远启用

[plugins."io.containerd.cri.v1.cni"]
  bin_dir = "/opt/cni/bin"   # 2.4: 移除,改用 bin_dirs
  bin_dirs = ["/opt/cni/bin"]
```

**验证追踪确实在工作**(2.4 之后 span 能从 shim 一路透传到 runc 和 hooks):

```bash
# 拉一个镜像,然后在 Jaeger/Tempo 里查 containerd 的 service
journalctl -u containerd | grep -i "tracing"

# 关键:2.4 的 shim -> runc 透传(#14036)意味着
# 一个镜像拉取的 span 树现在能下钻到 runc 的各阶段,
# 不再在 shim 边界断链。
```

---

## 5. 性能对比:四种方案横评

### 5.1 镜像层解压:2.4 vs 各运行时(arm64, NVIDIA Grace, Go 1.26.3)

| 指标 | containerd 2.3 (stdlib) | containerd 2.4 (klauspost) | CRI-O / Podman | 提升 |
|------|------------------------:|---------------------------:|---------------:|-----:|
| cuda:13.1.2 解压(1.8→3.4GiB) | 13.6s | **9.1s** | 同 2.4(同一 inflate 核心) | **1.5×** |
| pytorch:latest 解压(3.4→7.0GiB) | 41.7s | **28.8s** | 同 2.4 | **1.4×** |
| 分配内存(cuda) | 305 MiB | **0.18 MiB** | — | **~1700×** |
| malloc 次数 | 1,910,000 | **1,948** | — | **~980×** |
| 1000 节点 × pytorch 层 | 11.6 节点小时 | **8.0 节点小时** | — | **省 3.6 小时** |

### 5.2 冷启动预热方案对比(以 EROFS 为基准的定性评估)

| 方案 | 与镜像流水线解耦 | 节点间共享 | 可写层处理 | 适用 snapshotter |
|------|:---:|:---:|------|------|
| **EROFS `layer_content_cache`(2.4)** | ✅ 完全 | ✅ 只读共享 | 容器自己的 overlay,不与缓存叠加 | EROFS only |
| 烤进 OS 镜像 content store | ❌ 镜像一变就得重烤 | ✅(随 OS 镜像) | 正常 overlay | 全部 |
| 可写缓存挂载 + overlay 路由 | ✅ | ❌ 不能只读共享 | 需要写重定向 | overlayfs(EROFS 不行) |
| 不预热 | — | — | — | 全部 |

**结论**:如果你用 EROFS snapshotter,2.4 让预热第一次**既解耦又可共享**。如果你用 overlayfs snapshotter,本版对你没有预热方面的改善。

### 5.3 GC 引用图:反向 vs 前向引用

| 维度 | collectionWithBackRefs(2.4 前) | collectionWithReferences(2.4) |
|------|-------------------------------|------------------------------|
| 枚举时机 | 收集开始前全部枚举 | 遍历到节点时按需发射 |
| 边集存储 | `backRefs` map 整个周期常驻 | 不保留,调用后丢弃 |
| 扇出极大的 collector | 内存放大明显 | **无放大** |
| 2.4.0 实际接入的 collector | 现有全部 | **0 个(有意预留)** |
| 依赖它的并发工作 | — | 可独立 upstream review |

### 5.4 非 runc 运行时的 CRI 特性上报

| 运行时 | 2.3 上报的特性 | 2.4 上报的特性 | 用户命名空间可用? |
|------|--------------|--------------|:---:|
| runc | 完整 | 完整(不变) | ✅ |
| runsc (gVisor) | **空**(从未被询问) | RRO 挂载等 | ❌ 还差 idmap |
| crun | 空 | shim `-info` 返回的全部 | 取决于 shim |
| kata | 空 | shim `-info` 返回的全部 | 取决于 shim |
| 无 `-info` 的 shim | 空 | 空(降级,debug 日志) | ❌ |

### 5.5 分发层安全与可观测性

| 能力 | 2.3 | 2.4 |
|------|:---:|:---:|
| `desc.urls` 请求剥离敏感头 | ❌ 转发 Authorization/Cookie | ✅ 剥离 4 个 well-known 头 |
| 注册表 HTTP 299 warning | ❌ 丢弃 | ✅ 传播到 resolver 的 WarningHandler |
| `/proc/interrupts` / 热节流遮蔽 | 需手动配 maskedPaths | ✅ 默认遮蔽 |
| 追踪配置 | containerd 私有字段 | ✅ 标准 OTLP 环境变量 |
| shim → runc/hooks 追踪透传 | ❌ 断链 | ✅ |

---

## 6. 6 条 6-12 个月可验证的硬指标

**这些指标今天就能跑代码复现,不需要预测未来。**

1. **gzip 层解压时间下降 30-40%**。用 `ctr image pull --platform linux/arm64 nvcr.io/nvidia/cuda:13.1.2-devel-ubi9`,在 2.3 vs 2.4 同一节点上各跑 6 次取均值。预期 13.6s → 9.1s 区间。复现成本:两台节点 + 10 分钟。

2. **解压时内存分配下降 3 个数量级**。在拉取过程中采样 RSS,或用 `GODEBUG=madvdontneed=1` + pprof 的 alloc 图。预期峰值分配从 ~300 MiB 降到 < 1 MiB。这个指标的复现最简单,也最容易被忽视。

3. **EROFS 缓存命中率爬升曲线**。启用 `layer_content_cache` 后,用新暴露的 Prometheus 指标记录 `hit / (hit + miss)` 30 天。预热覆盖良好的节点应稳定在 90%+。**同时记录未命中转换的 P95** —— 它是你预热容量的直接信号。

4. **拉取后 `ctr image export` 成功率从 <100% 到 100%**。这是 #14126 的验证:在长期运行、GC 跑过的节点上,用 `--unpack` 拉的镜像能否成功 export。开 `WithFetchAllContent` 后应为 100%。

5. **`crictl info` 中非 runc 运行时的 features 字段非空**。装 2.4 后,对 `runsc` / `crun` / `kata` 的 RuntimeHandlerFeatures 至少出现 RRO 挂载相关字段。**注意:用户命名空间字段仍为空(runsc 缺 idmap),这是预期行为不是 bug。**

6. **升级后追踪不断链**。升级到 2.4 + 改完 OTLP 环境变量后,在链路追踪里查一次镜像拉取,span 树应能从 containerd 一路下钻到 runc 各阶段(#14036 的效果)。2.3 里这条链在 shim 边界断开。

---

## 7. 6 条 6-12 个月可观察的未来信号

**这些是行业层面的信号,用于判断 2.4 的改动会不会成为主流。**

1. **EROFS snapshotter 的采用率曲线**。Linux 6.12 的文件挂载支持已经覆盖 RHEL 10 / Fedora 40+ / Debian 13 / Ubuntu 26.04 LTS。`layer_content_cache` 补齐预热后,「EROFS 只适合小众高性能场景」这个定位会改变。观察点:主流 Kubernetes 发行版是否把 EROFS 列为可选 snapshotter。

2. **谁第一个接入 GC 前向引用**。这个接口在 2.4.0 里零接入。**第一个注册 `collectionWithReferences` 的 collector,会揭示 containerd 社区认为「哪种扇出极大的引用关系最痛」** —— 候选:镜像 index↔manifest 关系、NRI 外部资源、或将来的 OCI artifact 引用图。这是一个值得每季度查一次 upstream 的信号。

3. **gVisor 的 idmap 支持时间表**。#13504 只是 containerd 一半(google/gvisor#13303)。runsc 补上 idmap 挂载支持的那一天,`UserNamespaces: true` 才会真正对 gVisor 上报。**这是本版「使能项未完成」的唯一悬念。**

4. **HTTP 299 warning 被注册表实际使用的比例**。接口已通,但**注册表会不会真的发警告**是另一回事。观察:Harbor / quay / distribution / 云厂商私有注册表是否开始在镜像弃用、限速、存储策略变更时发送 299。如果它们发了而你的 resolver 没处理,你就落后了。

5. **klauspost inflate 会不会进一步取代 stdlib**。containerd 是最后一个换的。接下来可以观察:Go 标准库的 `compress/gzip` 是否在性能上追赶,或者生态是否会出 CVE 推动全面切换。这是一个「依赖集中度」的信号 —— 好处是统一审计,风险是单点。

6. **非 LTS 分支的策略价值**。2.4 是 regular 版本,支持窗口短。**它是一个信号:containerd 在测试「特性更快进 LTS」的节奏**。如果 2.4 的新特性在 6 个月内被大量采用,下一个 LTS(大概率是 2.5 或 2.6)会把它们固化;如果反馈是「breaking change 太多」,节奏会收紧。你的升级选择本身就是这个实验的一部分。

---

## 8. 总结与最佳实践

### 8.1 该用 / 不该用

**✅ 该升级到 2.4 的情况**:
- 节点拉 AI 大镜像(CUDA / PyTorch 类,解压后 3 GiB+),拉取时间在关键路径上
- 有 gVisor / Kata / crun 混部需求,被「运行时特性不上报」困扰过
- EROFS snapshotter 用户,且一直在找「不烤镜像的预热方案」
- 追踪体系已用 OpenTelemetry,愿意把容器配置改成标准环境变量
- 需要 CDI 设备注入语义统一(GPU / 加密设备 / 沙箱透传)

**❌ 不该升级的情况**:
- 你在 LTS 上且不能接受短支持窗口 → **留在 2.3.x**
- 你重度依赖 `enable_cdi = false`、私有 OTLP 配置字段、`bin_dir` —— 这些**已经被移除**,不是 deprecated
- 节点内核 < 6.12 且想要 EROFS 文件挂载(老内核仍可,但回退 loop 设备)
- 你期望 gVisor 用户命名空间立刻可用 —— **它还差 idmap 那一半**

### 8.2 5 步生产升级 checklist

**第 1 步:清 deprecation(升级前,在 2.3 上做)**

在 2.3 上把所有 deprecation warning 清零。2.4 移除的是「2.3 已经在警告的」配置,不是新东西:

```bash
journalctl -u containerd | grep -i "deprecat"
```

确认:没有 `enable_cdi`、没有 CNI 的 `bin_dir`(单数)、没有 OTLP 的 `endpoint`/`protocol`/`insecure`、没有内部追踪的 `service_name`/`sampling_ratio`。

**第 2 步:迁移追踪配置到 OTLP 环境变量**

按 §4.5 改。**这一步漏掉的症状是「追踪静默失效」** —— 不会报错,只是 span 消失。改完用一次完整镜像拉取验证链路。

**第 3 步:灰度验证解压与追踪(无配置变更,纯二进制升级)**

在 10% 节点上升级,跑硬指标 #1 和 #6:同一个镜像的解压时间,和追踪 span 树的深度。这两个不需要任何配置改动就能验证 2.4 的两个核心改进。

**第 4 步:启用 EROFS 预热(可选,分批)**

只在用 EROFS snapshotter 的节点上做。先配 `layer_content_cache` 指向一个**空目录** —— 确认不报错;再让预热任务逐步填充;用新 Prometheus 指标盯命中率曲线。**不要一开始就指望高命中率**,这是一个渐进填充的过程。

**第 5 步:验证 export 与非 runc 特性**

- 在跑过 GC 的老节点上,用 `--unpack` 拉的镜像做 `ctr image export`。失败 → 开 `WithFetchAllContent` 重拉。
- `crictl info` 检查非 runc 运行时的 `RuntimeHandlerFeatures` 非空(用户命名空间字段为空是正常的,gVisor 缺 idmap)。

### 8.3 5 条最佳实践

1. **把「层内容」当作一种存储基础设施来运维,而不是部署产物。** 预热缓存、命中率指标、转换时长 P95 —— 这些应该在你的节点看板上,和 CPU/内存 占同样的位置。2.4 给了你观测手段,但用不用是你的事。

2. **快照是视图,内容是事实,两者可以独立消亡。** 任何「拉取成功」的断言,都必须附加「且能 export」才算数。在 CI 里复现不了这类 bug,所以它必须在生产 checklist 里被显式验证。

3. **不要依赖 containerd 私有的可观测性配置。** OTLP 环境变量是唯一面向未来的路径。所有私有配置字段都会在某个 regular 版本被移除 —— 2.4 只是第一次大规模执行这件事。

4. **跨源请求永远不要复用注册表凭证。** 敏感头剥离是 containerd 补的,但你的应用层如果也做 `desc.urls` 抓取,同样的规则适用:凭证的信任边界必须与来源边界对齐。

5. **评判「没人用的接口」要看它解锁了什么。** GC 前向引用在 2.4.0 里零接入,但它是「让扇出极大的 collector 能接入」的唯一干净路径。基础设施项目里,接口先行是协作成本最低的做法;把它当成「没用的功能」会误判版本价值。

---

## 写在最后

containerd 2.4 是一个容易被低估的版本。它没有新运行时、没有新协议、没有炫目的性能数字 —— 它做的是「把每一层里那个『能跑但别扭』的点逐层消掉」。

但它处理的那四件事,恰好是 2026 年 AI 工作负载把镜像层从「部署产物」变成「高频流动存储对象」时,最先暴露的四件事:**冷启动要预热但不能耦合镜像流水线、大镜像解压要在关键路径上够快、沙箱运行时要有一等公民的特性契约、引用图要能承载大扇出**。加上跨源凭证安全和注册表可观测性这两个协议级补丁 —— 这是一份完整的「镜像层基础设施化」清单。

**一个值得记住的判断:2.4 的五个革新,每一个都是「先定义问题的形状,再给解法」。** EROFS 预热先讲清了「嵌套 overlay 为什么不行」再给目录布局;klauspost 先给实测表再换实现;非 runc 内省先指出 kubelet 拒绝信息从哪来再删守卫;GC 前向引用先定义接口再等实现。**在一个堆 feature 的时代,「先把问题说清楚」是最稀缺的工程能力。**

containerd 的版本节奏也在告诉你一件事:**非 LTS 分支是实验场,LTS 才是生产线。** 2.4 的 breaking change 会在下一个 LTS 里固化。你今天在 2.4 上验证的东西,决定了你的下一次 LTS 升级是平滑还是痛苦。

> 本文所有数据点来自 containerd v2.4.0 release notes(125KB, 658 commits)及文中引用的 PR #13542 / #14105 / #13813 / #13560 / #12889 / #12698 / #14166 / #13504 / #13162 / #13993 / #13818 / #13699 / #13948 / #13634 / #14126 / #13520 / #13941 / #14036 / #13960 的原始讨论,以及 containerd 官方 EROFS snapshotter 文档。性能数字(13.6→9.1s、41.7→28.8s、305MiB→0.18MiB)为 PR #13560 作者在 NVIDIA Grace arm64、Go 1.26.3 下的实测(n=6,相对标准差 < 1.5%)。
