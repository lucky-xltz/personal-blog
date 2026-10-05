---
title: "Longhorn v1.13.0 深度拆解：V2 SPDK 数据引擎热升级 + 完全中断模式把空转 CPU 从 100% 压到 1% + longhorn-global-manager 把集群级 Pod informer 从 O(节点数) 收成 3 副本 + volumeTopology 拓扑约束 + scheduler extender 抢 kube-scheduler 决策权 + 卷组快照与年龄保留 + 默认 NetworkPolicy 拆了三个洞"
date: 2026-10-05
category: 技术
tags: [Longhorn, Longhorn v1.13.0, Kubernetes, CSI, 块存储, 分布式存储, SPDK, V2 Data Engine, 用户态存储, NVMe-oF, NVMe-TCP, UBLK, 热升级, LiveUpgrade, 中断模式, InterruptMode, 轮询, Polling, CPU 隔离, CPUIsolation, RPS, longhorn-global-manager, DaemonSet, Deployment, Informer, 扇出, LeaderElection, Lease, 卷组快照, VolumeGroupSnapshot, 一致性, 快照, 年龄保留, AgeBasedRetention, RecurringJob, 备份, 拓扑, volumeTopology, zonal, regional, 故障域, 调度, SchedulerExtender, kube-scheduler, CSIStorageCapacity, 数据本地性, NetworkPolicy, Cilium, mTLS, gRPC, 服务账户, 最小权限, LinkedClone, 快克隆, 数据损坏, 静默错误, ErasureCoding, 分片, Rancher, Harvester, Talos, 默认值收紧, 显式声明, 存储安全, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=600&h=400&fit=crop
excerpt: "2026 年 9 月 29 日，Longhorn 发了 v1.13.0，release notes 44 KB。这是 V2 数据引擎在 v1.12.0 达到 GA 之后的第一个 feature release，表面看是一组零散改进，串起来是一条同本周完全同向的主线：把「我猜这没问题」从隐含约定变成显式声明。升级：V2 instance manager 现在可以滚动替换而卷不 detach，但只支持从 v1.12.2 上来，从 v1.12.0/1.12.1 升必须先把所有 V2 卷拆掉；空转：SPDK reactor 从固定间隔轮询改成纯事件驱动，0 卷时 reactor_0 从 100% CPU 掉到 1% 以下（SPDK v25.01 的 NVMe PCIe 中断模式），代价是高吞吐下延迟略高，所以轮询仍是默认；控制平面：新增 longhorn-global-manager Deployment 扛走唯一两个需要集群级 Pod 可见性的控制器，DaemonSet 的 Pod informer 收缩到 longhorn-system 命名空间，集群级 watch 从「每节点一个」变成「3 个常数副本」；调度：volumeTopology StorageClass 参数让副本在 provision、重建、扩副本数时都留在 provision 时的故障域里，scheduler extender 让 kube-scheduler 在调度时读真实磁盘容量并把重启的 Pod 放到持有全部副本的节点，代价是托管 K8s（GKE/EKS）用不了；数据保护：卷组快照能一次请求快照一组卷，但每个成员独立快照、不是单一时间点，应用级一致性是未来工作（issue #2128）；安全：v1.12.1 默认开的 NetworkPolicy 拒绝了四个外部 CSI sidecar 与宿主机发起的合法调用，attach/detach 全集群失败，v1.12.2 拆了三个 Helm 口子补上，v1.13.0 又把 CSI sidecar 挪到专用服务账号。本文按「V2 数据引擎从能用到敢用在生产」这条主线拆完七条承重级改动，附 5 段可直接跑的 Shell / YAML / kubectl、5 套云原生存储方案 17 维度对比、6 条 6-12 月可验证硬指标、5 步生产升级 checklist、8 个诚实边界与 3 个长期判断。"
---

# Longhorn v1.13.0 深度拆解：V2 SPDK 数据引擎热升级 + 完全中断模式 + `longhorn-global-manager` + 拓扑约束 + scheduler extender + 默认 NetworkPolicy 拆了三个洞

> 2026 年 9 月 29 日，Longhorn 发了 **v1.13.0**。release notes 44 KB，184 个 issue。这是 **V2 数据引擎在 v1.12.0 达到 GA 之后的第一个 feature release**，也是 Longhorn 历史上第一次：**升级一个生产存储集群，可以不拆任何卷。**

## 〇、同一天的三层，讲的是同一件事

今天早间的 AI 日报关键词是「反噬」：Google 因为自动提交里绝大多数无效而把开源漏洞悬赏（OSS VRP）暂停到 2027 年 Q1——AI slop 第一次精确击穿了安全研究的基础设施，索取方开始付出代价。中午的 Helm v4.3.0 讲的是「删除之前先证明你是所有者」：uninstall 在删任何资源前先检查 Helm 标签与注解，不属于自己的资源只警告不删。

晚上这篇 Longhorn，表面上离前两篇十万八千里——一个是 AI 政策，一个是包管理器，一个是块存储。但三者落在同一条线上：

| 栈层 | 早间（商业层） | 中午（包管理与发布层） | 本文（块存储数据层） |
|------|----------------|------------------------|------------------------|
| 事件 | Google 暂停 OSS VRP，因为自动提交绝大多数无效 | Helm uninstall 删资源前先校验 Helm 标签与注解 | Longhorn 默认 NetworkPolicy 拒绝合法 CSI sidecar；volumeTopology 让跨区放副本从默认行为变成必须显式声明；CSI sidecar 从共享 SA 挪到专用 SA |
| 隐含约定 | 「安全研究员会无偿兜底」 | 「我猜这个 HPA 是我这个 release 的」 | 「我猜副本放别的区也没事」「我猜这个 gRPC 调用者是合法的」「我猜这个服务账号只需要读 Secrets」 |
| 显式化后的契约 | 暂停悬赏池，索取方付出代价 | 不属于你的资源只警告不删 | attach/detach 全集群失败（#13802）→ 三个 Helm 口子显式放行；拓扑约束从默认跨区变成 `volumeTopology: zonal` 才跨区；凭证从「共享 SA + 集群级读所有 Secret」变成专用 SA + `csi.allowControllerSecretAccess` 可关 |

**「隐含约定显式化」是 2026 年 10 月第一周的设计主题。** 在存储层，这个主题的代价特别具体：一个隐含假设错了，丢的是数据。

---

## 一、问题的源头：V2 数据引擎进了生产，剩下四道障碍

Longhorn 的 V2 数据引擎在 v1.12.0 达到 GA。它把整个数据通路从内核态搬到用户态：**SPDK（Storage Performance Development Kit）** 取代了 V1 的 iSCSI + ext4 稀疏文件架构，副本之间走 **NVMe-oF TCP** 而不是 iSCSI，前端用宿主机内核的 NVMe-TCP initiator（UBLK 前端仍是实验性）对接 Pod。

这个架构换来的是性能与可预测性，代价是四道生产障碍，v1.13.0 一个一个去堵：

**障碍一：升级必须停卷。** V2 的引擎与副本都跑在节点的 `longhorn-instance-manager` 进程里（一个 SPDK target）。升级 Longhorn 要换这个进程，换进程就要重启 SPDK，重启 SPDK 就要所有卷 detach。对一个声称 GA 的存储引擎，「升级窗口=应用停机窗口」是硬伤。

**障碍二：空转烧 CPU。** SPDK 的 reactor 默认是轮询模型——为了把 I/O 延迟压到微秒级，每个 reactor 线程 100% 占满一个 CPU 核，即使节点上一个卷都没有。issue #9834 的实测：`aio` bdev + `nvmf_tgt`，**0 卷时 `reactor_0` 消耗 ~100% CPU**。v1.10.0 引入过一个「混合中断模式」，用一个固定轮询间隔把 I/O 从 SPDK 内部队列搬到 OS TCP 栈，但那不是完整的中断模式，队列空闲时仍然有恒定 CPU 开销。对一个每节点只跑几个卷的边缘集群，这个成本不可接受。

**障碍三：控制平面扇出 O(节点数)。** `longhorn-manager` 是 DaemonSet，每个 pod 都跑了全部 reconciler，其中 `KubernetesPodController` 和 `KubernetesPVController` 需要集群级 Pod 可见性——它们要跨所有命名空间追踪工作负载 Pod，用来管理 PV↔工作负载绑定、节点宕机处理、RWX 重挂载、CSI plugin Pod 故障恢复。结果是：**每个节点都开一个集群级 Pod watch**。集群里每次 Pod 变化，kube-apiserver 都要分发给每个 manager pod；每个 manager pod 的 RSS 随集群 Pod 总数增长，而不是随节点上的 Pod 数增长。加节点线性增加 apiserver 负载，即使 Longhorn 卷数量一个没变。

**障碍四：副本可以越过故障域。** PV 侧已经被约束了——CSI accessible topology 会推导出 `nodeAffinity`，工作负载被钉在一个故障域里。但副本侧没有对应约束：zone label 只用来做反亲和散布，从来不当 placement 约束。重建、改副本数随时可以把数据搬到另一个区，于是在卷的整个生命周期里，数据路径上永久存在跨区 I/O。多区部署通常要避免这个东西，因为延迟和流量成本都会乘上去。**没有任何办法告诉 Longhorn「把这个卷的副本留在 provision 时的那个故障域里」。**

**关键洞察 1：** v1.13.0 的七条承重级改动，全部在堵这四道障碍，加上一条横切的安全线（默认 NetworkPolicy 的三个洞）。这不是「加了一堆 feature」，是「V2 数据引擎第一次具备替换 V1 的生产条件」。

---

## 二、三层架构：V1 与 V2 数据通路的根本差别

要理解 v1.13.0 的每处改动，得先看清 V1 与 V2 的数据通路差在哪。

### V1 数据引擎（iSCSI + ext4 稀疏文件）

```
Pod ──块设备──> 内核 iSCSI initiator
                    │ (TCP, 同节点或跨节点)
                    v
              longhorn-engine 进程 (iSCSI target)
                    │  引擎内同步写复制
                    ├──> Replica-1 (ext4 稀疏文件)  ──> 磁盘
                    ├──> Replica-2 (ext4 稀疏文件)  ──> 磁盘
                    └──> Replica-3 (ext4 稀疏文件)  ──> 磁盘
```

V1 的引擎与副本都是独立进程，引擎对外提供 iSCSI target，对内把写操作同步复制到若干副本的 ext4 稀疏文件。快照是文件系统的写时复制层级结构。整个数据通路两次穿过内核网络栈（前端 iSCSI + 后端 iSCSI）。

### V2 数据引擎（SPDK 用户态 + NVMe-oF TCP）

```
Pod ──块设备──> 内核 NVMe-TCP initiator (或 UBLK, 实验性)
                    │ (NVMe-oF TCP)
                    v
        longhorn-instance-manager 进程内的 SPDK target (前端)
                    │  engine = 一个 lvol bdev
                    ├──(bdev_nvme_attach_controller, NVMe-oF TCP)──> Replica-1 subsystem ──> AIO/NVMe bdev ──> 磁盘
                    ├──(NVMe-oF TCP)──────────────────────────────> Replica-2 subsystem ──> 磁盘
                    └──(NVMe-oF TCP)──────────────────────────────> Replica-3 subsystem ──> 磁盘
```

V2 里，**每个节点一个 `longhorn-instance-manager` 进程**，里面跑一个 SPDK 应用（`nvmf_tgt` + `aio`/`nvme` bdev 模块）。引擎与副本都是这个 SPDK 应用内部的对象：副本是暴露为 NVMe-oF TCP subsystem 的存储后端，引擎是一个 lvol bdev，通过 `bdev_nvme_attach_controller` 经 TCP 连到各副本 subsystem，前端再把引擎的 lvol 作为 NVMe-oF subsystem 暴露给宿主机内核 initiator。

数据通路里只有前端一跳经过内核；引擎到副本这一跳完全在用户态 SPDK 里。issue #9834 的排障记录直接印证了这个结构：调试者用 `go-spdk-helper bdev get` 看到 `block-disk`（AIO，指向 `/host/dev/nvme1n1`）、`block-disk/v2-r-23310c64`（Logical Volume，即引擎 lvol），以及 SPDK poller 表里 `nvmf_tgt_poll_group_000` 上的 `nvmf_poll_group_poll`、`nvmf_tcp_accept`、`bdev_nvme_poll`。

另一个能侧面印证架构的 bug 是 #13651：**宿主机操作系统的 `nvmf-autoconnect` 会把内核 initiator 自动连到 V2 副本的 subsystem 上**，导致卷 attach/detach 卡住好几分钟——本该只连引擎 subsystem 的内核侧，看到了副本的 subsystem。

### 两种架构的工程后果

| 维度 | V1（iSCSI + ext4） | V2（SPDK + NVMe-oF） |
|------|---------------------|----------------------|
| 内核依赖 | 两次内核网络栈穿越 | 仅前端一跳；后端纯用户态 |
| CPU 模型 | 进程调度，空闲时几乎不耗 CPU | reactor 轮询钉核，空闲时也 100% 占核（v1.13.0 前） |
| 升级模型 | 换引擎/副本进程，卷 detach | 换 instance-manager，卷必须 detach（v1.13.0 前） |
| 前端 | iSCSI（内核内置） | NVMe-TCP（内核 initiator）或 UBLK（实验，kernel 6.17 会 panic） |
| 快照 | ext4 写时复制层级 | SPDK lvol 快照 |
| 快克隆 | 全量复制 | linked-clone，共享数据块（v1.12.1 起） |
| 控制平面 | DaemonSet 全量控制器 | 同（v1.13.0 起拆出 global-manager） |

**关键洞察 2：** V1 与 V2 不是「新旧版本」关系，是**两种不同的工程权衡**。V1 的隐含约定是「内核网络栈与文件系统是可靠的，我用它」；V2 的隐含约定是「用户态轮询换性能，我接受 CPU 成本」。v1.13.0 干的事，是把 V2 的隐含约定逐条显式化：CPU 成本可以关掉（中断模式）、升级成本可以去掉（热升级）、控制平面成本可以收缩（global-manager）、副本位置成本可以声明（拓扑约束）。

---

## 三、热升级：instance manager 滚动替换，卷不 detach

**改动**：v1.13.0 支持 V2 卷的热升级——升级 V2 instance manager 时卷可以保持 attached，前提是集群满足[热升级前置条件](https://longhorn.io/docs/1.13.0/deploy/upgrade/v2-instance-upgrade/#prerequisites)。

这是四道障碍里最重的一道。它把「升级 Longhorn」从一个需要应用配合的停机操作，变成了一个纯控制平面操作。

### 但升级路径只有一条

release notes 里用 `> [!IMPORTANT]` 框出来的话：

> **Upgrade path:** V2 live upgrade to v1.13.0 is supported only from Longhorn v1.12.2. When upgrading from v1.12.0 or v1.12.1, or when the prerequisites are not met, detach all V2 volumes and ensure their replicas are stopped before upgrading.

这句话的信息量比「支持热升级」本身大得多：

- **热升级的协议是 v1.12.2 引入的**，不是 v1.13.0。v1.12.2 已经在 instance manager 里埋好了滚动替换的握手逻辑（SPDK 的 gRPC 服务现在全量 mTLS 也是同一时期铺的路，见 §8.3）。v1.13.0 是第一个能用它的 feature release。
- **从 v1.12.0 或 v1.12.1 升级，必须拆掉所有 V2 卷并确保副本停止。** 这不是「推荐做法」，是「唯一不丢数据的做法」。
- **前置条件不满足时，同样必须拆卷。** 前置条件里最容易被忽略的一条是：升级前必须确认至少一个 `longhorn-global-manager` 的 pod 能被调度（见 §五）——这是 v1.13.0 升级路径上新增的硬依赖。

### 同期的 linked-clone 恢复 bug：隐含约定错了会丢数据

热升级之外，v1.13.0 修了一个能让人心跳骤停的静默正确性 bug（#13714）：

> When backing up a V2 linked clone volume, the linked clone info will be not recorded. Then, when restoring the backup, Longhorn will not verify that the restore volume should have a corresponding src volume entrypoint snapshot. **This will make the restored volume data corrupted.**

V2 的快克隆是 linked-clone 架构：克隆卷与源卷**共享数据块**而不是复制，一个源卷可以背多个 linked clone（v1.12.1 起，v1.13.0 起支持 restore）。linked clone 的数据完整性依赖一个隐含约定：**源卷与其入口快照必须存在**。

v1.12.1 的备份没记录 linked clone 信息，恢复时也不校验源是否存在。于是：**备份成功、恢复成功、md5 校验可能都对，但数据是坏的**——因为恢复出来的「克隆卷」指向的共享块已经不存在了。触发条件恰好是热升级与备份的交叉场景：源卷或源快照在升级/删除流程中被清掉。

修复做了三件事，全部是「隐含约定显式化」的标准动作：
1. 备份时记录 linked clone 信息（源卷名 + 入口快照）；
2. 恢复时允许用户显式输入源卷名与入口快照，不输入就用记录的默认值；
3. **源卷或入口快照缺失时，恢复直接报错，不产出坏卷。**

同批还有一个 #12792：带 `dataLocality: strict-local` 的卷做 CSI 克隆会以 `hard affinity cannot be satisfied` 失败，因为克隆没尊重 `nodeSelector` / `diskSelector`——同样是「克隆的地方假设错了」类问题。

**关键洞察 3：** linked-clone 是 V2 最有吸引力的能力之一（克隆一个 1TB 数据库卷不复制一个字节），但它的正确性依赖一个跨对象的生命周期约定。**跨对象生命周期约定是分布式存储里最容易出静默损坏的地方**：单个对象自己的状态都是对的，对象之间的关系错了，而校验只在恢复时才发生。v1.13.0 把这个约定写进了备份元数据——这是「显式化」在数据层的具体形态。

---

## 四、完全中断模式 + CPU 隔离：把 100% 空转 CPU 压掉

### 4.1 完全中断模式（#11662）

**改动**：v1.13.0 的中断模式变成**完全事件驱动**——SPDK reactor 等待 I/O 事件而不是持续轮询，只剩低频的后台检查，显著降低空闲与低 I/O 负载下的 CPU 占用。这改进了 v1.10.0 引入的混合实现，后者在卷空闲时仍然有最小恒定 CPU 负载。和之前一样，持续高吞吐负载下中断模式的 I/O 延迟可能略高于轮询模式。

**轮询仍是默认值。** 切换方式：

```yaml
data-engine-interrupt-mode-enabled: '{"v2":"true"}'
```

**且必须在没有任何 V2 卷 attached 时切换。**

这个改动的技术前提值得单独说。issue #9834 的讨论记录了完整的定位过程：调试者先抓到 `aio` bdev + `nvmf_tgt` 在 0 卷时 `reactor_0` 100% CPU，然后发现 SPDK poller 表里有一堆 `Timed` 类型 poller（`bdev_nvme_poll` 周期 100µs、`bdev_nvme_poll_adminq` 10000µs、`nvmf_ctrlr_keep_alive_poll` 10000000µs），derekbit 指出 **SPDK 从 `v25.01-rc1`（commit `b8c65ccf`）起支持 NVMe PCIe 中断模式**（通过 `bdev_nvme_attach_controller` 连本地 PCIe 盘时），所以 `nvmf_tgt` 配 `nvme` bdev 模块在 0 卷时不再吃 100% CPU；但 **NVMe bdev 的 TCP transport 当时还不支持中断模式**。c3y1huang 随后确认升级到 SPDK `v25.01-rc1` 后 `reactor_0` 从 100% 降到 0.997%。

也就是说：**这个能力的根在 SPDK 上游一个版本的中断模式支持，Longhorn 做的是把它接到 V2 数据引擎的 I/O 通路上，并去掉固定轮询间隔。**

### 4.2 CPU 隔离默认开启（#13724）

**改动**：v1.13.0 对**新安装**把 `data-engine-cpu-isolation-enabled` 默认设成 `{"v2":"true"}`。从 v1.12.x 升级上来的集群保留原值，需要手动设 `{"v2":"true"}` 才开启。

CPU 隔离把中断与其他内核后台工作挡在 V2 数据引擎使用的 CPU 核之外。**它只在轮询模式下生效；开启中断模式时 Longhorn 会自动跳过它**（#13973）——这是一个自洽的组合：你选了中断模式，就不再需要把核隔离出来给轮询线程。

同一批还有两个配套的「把 CPU 留给 SPDK」改动：
- **#13483：把宿主机的 RPS（Receive Packet Steering）从 SPDK reactor 核上疏导开。** 这是反向操作——不只是隔离 SPDK 核，还主动把内核的软中断分发调度到别的核。
- **#13248：支持 Kubernetes CPU Manager 为 V2 instance-manager 的 SPDK CPU 分配做规划。** 这让 SPDK 的核分配能进 K8s 的 CPU 管理器视图，节点上的 CPU 拓扑与 SPDK 的 reactor 绑核第一次能对齐。

### 4.3 三档 CPU 模型的决策

v1.13.0 之后，V2 数据引擎实际上有三档 CPU 模型，选哪档取决于工作负载：

| 模型 | CPU 特征 | 延迟特征 | 适用场景 |
|------|----------|----------|----------|
| 轮询 + CPU 隔离（新安装默认） | reactor 钉核 100%，隔离挡住内核中断 | 最低、最可预测 | 数据库、高 IOPS 持续负载 |
| 轮询 + 不隔离（旧集群升级默认） | reactor 钉核 100%，与内核后台工作共享核 | 略受干扰 | 已有集群未改配置 |
| 完全中断模式（需显式开启） | 空闲近 0，事件驱动 | 高吞吐下略高 | 边缘/开发/低 I/O 密集集群 |

**关键洞察 4：** 「轮询 vs 中断」在 SPDK 生态里是一个被反复争论的取舍，Longhorn 的答案是**不做选择，把两档都做成一等公民，用默认值表达推荐**（新安装 = 轮询 + 隔离），用配置项把决定权交给运维（`data-engine-interrupt-mode-enabled` + `data-engine-cpu-isolation-enabled` 两个 JSON 值的 setting）。这是存储引擎里少见的「把性能模型做成可配置项」的做法——大多数存储系统只有一种性能模型，你只能靠加资源解决。

### 4.4 空闲 CPU 的诚实边界

中断模式不是银弹。同批 issue 里有一个 #12066：**中断模式下工作负载完成后 CPU 仍然卡在高处下不来**——这个 bug 在 v1.13.0 的修复列表里。任何「按事件唤醒」的循环，只要有一条路径忘了回到等待状态，就会退化成轮询。引入完全中断模式的同时把它列进修复项，是诚实的。

---

## 五、`longhorn-global-manager`：控制平面扇出从 O(节点数) 到常数

这是 v1.13.0 里架构上最大的一刀。

**改动**：新增 `longhorn-global-manager` Deployment，把需要集群级 Pod 可见性的控制器（`KubernetesPodController` 与 `KubernetesPVController`）从 DaemonSet 搬过去。DaemonSet 的 Pod informer 收缩到 `longhorn-system` 命名空间。安装与升级时默认创建 3 个副本。

### 5.1 问题的量级

设计文档（enhancement `20260506-global-longhorn-manager.md`）把问题写成两行：

- **kube-apiserver watch 扇出**：集群里每次 Pod 变化都被 apiserver 分发给每个 manager pod，watch 流量与 apiserver 服务它的工作量随「集群 Pod 数 × 节点数」增长；
- **每 pod 的 informer 缓存内存**：每个 manager pod 缓存它 informer watch 的所有对象，Pod 缓存大小由**集群** Pod 数决定，不是节点的，所以加节点会把同样大的 Pod 缓存乘以 N 份。

文档里的运维画像很具体：「100+ 节点的 Longhorn 集群，一次重启全部 `longhorn-manager` pod 会让 kube-apiserver 短时间收到几百个并发的 list-pods 请求」。这两项成本随集群增长，而 **reconcile 本来就是按卷所有权或节点身份分布的**——每个 daemon pod 都背着集群级 Pod watch 与缓存，纯属浪费。

### 5.2 拆法：哪些控制器能搬，哪些不能

设计文档把 Longhorn 控制器分成三类，这张表本身就是一份架构资产：

| 类别 | 例子 | 能搬到 global-manager 吗 |
|------|------|--------------------------|
| **节点本地**——碰 host path、经 localhost 调 IM gRPC、或 CR 所有权以 `Spec.NodeID` 为键 | `Replica`、`Engine`、`InstanceManager`、`BackingImageManager`、`BackingImageDataSource`、`Orphan`、`Node`（磁盘监控）、`MetricsCollector` | 不能——必须留在 DaemonSet |
| **全局范围**——跨集群 owner 选举，无节点本地依赖 | `Volume` 与卷工作流控制器、`Snapshot`、Backup 全家、`BackingImage`、`EngineImage`、`RecurringJob`、`ShareManager`、`SystemBackup`、`SystemRestore`、`SupportBundle`、`Setting`、`KubernetesPV`、`KubernetesPod`、`KubernetesConfigMap`、`KubernetesSecret`、`KubernetesPDB`、`KubernetesEndpoint` | 有正当理由时可以 |
| **与进程内 REST API 服务器耦合** | `WebsocketController` | 不能——路由原因留在 DaemonSet |

**这次只搬了两个**：`KubernetesPVController` 与 `KubernetesPodController`。它们是唯一需要集群级 Pod 可见性的控制器——跨所有命名空间追踪工作负载 Pod，管理 PV↔工作负载绑定、节点宕机处理、RWX 重挂载、CSI plugin Pod 故障恢复。DaemonSet 里其余约 6 个 Pod informer 消费者本来就只用命名空间范围视图（`longhorn-system`），通过 event-handler predicate 限制，所以命名空间级 informer 对它们完全够用且无行为变化。

### 5.3 为什么是独立 Deployment 而不是「DaemonSet 里选主」

设计文档明确讨论并否决了一个看起来更省事的替代方案：**只在选出的 leader 上、在 DaemonSet 内部跑集群级 informer**。

否决理由是进程模型耦合：每个 DaemonSet pod 无条件跑节点本地控制器（它们依赖 host path，无论是否是 leader 都要在每个节点上跑），如果只把集群级 informer 与两个控制器挂在 leader 身份上，每次 leader 变更都要**在一个长生命周期的、privileged 的、挂了 host mount 的混合用途进程内部**启停那个 informer。而独立的 leader-gated Deployment 把 informer 与控制器的生命周期干净地隔离出来（控制器执行由 Lease 门控），且不需要 `privileged` 或 host mount。

### 5.4 热备与接管

global-manager 用 `coordination.k8s.io/v1` 的 `Lease`（`longhorn-system` 命名空间，名字 `longhorn-global-manager`）做 leader 选举。**每个副本都启动 informer 并保持缓存同步，Lease 只决定哪个副本跑 reconcile 循环。leader 是唯一写入者。** 因为 stand-by 保持着热缓存，leader 变更时新 leader 的控制器面对的是一个已同步的缓存，不需要重新做一次集群级 LIST。接管仍然依赖 Lease 的释放或过期与获取。

注意搬过去的两个控制器**不拥有任何 Longhorn CR**——它们读 PV/Pod（kube 原生对象）然后更新 `Volume.Status.KubernetesStatus`，`Volume` CR 的 owner 仍是 DaemonSet 里的 `VolumeController`。搬过去后唯一的逻辑变化是**删掉了之前防止一个 DaemonSet pod（按节点身份选出）与其他 pod 在同一写上竞争的 per-node sharding guards**——单 leader 模式下这些保护不需要了。

### 5.5 同批的一组 informer 优化

v1.13.0 的 improvement 列表里有三条显然是同一批规模化工作的一部分，值得一起看，因为它们是「 apiserver 压力」这个问题的另外三个切面：

- **#13782：每个 longhorn-manager pod 重复构建两次 DataStore 与 informer 缓存。** 字面意义上的双倍内存。
- **#13786：longhorn-manager 集群级 watch Leases，但只读 Longhorn 命名空间里的那些。** watch 范围远大于实际读取范围。
- **#13726：longhorn-manager 为了 watch 一个 Secret 而缓存集群里每一个 Secret。** 这条尤其值得注意——它是「最小权限」原则在 informer 层面的反面教材，也是 §8.4 CSI 服务账号那条改动的同源问题：**权限与缓存范围都按「最省事」的方式给了集群级，而不是按「刚好够用」的方式收敛。**

**关键洞察 5：** 这五条改动（global-manager + 三条 informer 优化 + 前面 #13782）合起来是一条清晰的规模化纪律：**控制平面的成本必须随「管理对象数量」增长，不能随「节点数量」增长。** DaemonSet 模型天然是 O(节点数) 的，Longhorn 用「把全局控制器抽出来 + 每节点只看自己命名空间」把它拆成 O(卷) + O(节点本地) + O(1)。任何以 DaemonSet 为控制平面载体的存储/网络项目（CNI、CSI、设备插件）迟早都要走这一步。

---

## 六、调度层：把副本留在故障域里，把调度决策权抢回来

### 6.1 volumeTopology：副本的拓扑约束（#13493）

**改动**：新增 `volumeTopology` StorageClass 参数（`any` / `zonal` / `regional`），让卷的副本留在 provision 时的区或域里——**包括重建与改副本数的时候**。

这个问题被提出来时的描述恰好点出了隐含约定：

> In a multi-zone cluster, replica scheduling is not zone/region aware — the scheduler uses zone only for anti-affinity spreading, never as a placement constraint. ... The result is permanent cross-zone IO on the data path, which multi-zone deployments usually need to avoid for latency and traffic cost reasons.

注意「permanent」这个词。跨区 I/O 不是偶发开销，是**数据路径上的永久开销**，因为一旦副本被放到别的区，后续每次读写都要跨区。而 Pod 侧早就被约束了（CSI accessible topology → PV `nodeAffinity`），只有副本侧是自由的。

三个值的语义：

- `any`（默认 / 不设）：当前行为，完全不变；
- `zonal`：卷在 provision 时钉到单个区（配 `WaitForFirstConsumer` 时就是 Pod 落地的那个区）。PV node affinity 与**每一个**副本调度决策——初始放置、重建、副本数变更——都留在那个区内；
- `regional`：同上，粒度是域，副本在域内自由。

设计里还有一个诚实的失败语义：**如果被钉的故障域没有容量了**（原文 "If the pinned domain has no capac..."），卷会调度失败而不是退回到跨区放置。这是「显式约束」的必然代价——约束一旦生效，违反约束时必须失败，不能静默降级。

### 6.2 scheduler extender：让 kube-scheduler 读真实磁盘容量（#12591）

**改动**：让 kube-scheduler 能查询 Longhorn 的**真实磁盘容量**，并在可能时把重启的 pod 调度到**已经持有它全部副本的节点**上。这避免了 pod 创建爆发时基于过时 `CSIStorageCapacity` 数据做调度决策，并改善数据本地性（尤其 `best-effort` 本地性）。extender 跑在 longhorn-manager 内部，**需要改 kube-scheduler 配置，因此在托管 Kubernetes 服务（GKE、EKS）上不可用**。

这个改动的动机写得极清楚，三条都是 CSI 存储容量追踪的固有缺陷：

1. **kube-scheduler 与 csi-provisioner 的竞态**：kube-scheduler 用 `CSIStorageCapacity` 对象过滤容量不足的节点，但这些对象可能不是最新值（由 csi-provisioner 更新），于是 kube-scheduler 可能把 pod 调度到它以为容量够、实际不够的节点上。**多 pod 同时创建时这个情况很常见。**
2. **不支持多 PVC 的 pod**：存储容量追踪不支持使用多个 PVC 的 pod（kubernetes/kubernetes#111755）。kube-scheduler 逐个评估每个 PVC，不考虑一个节点可能有多块盘。`CSIStorageCapacity` 的关键局限是它把每个节点建模成**单一存储池**——无法表达「每节点多块盘」。实现 #10685 时，要么报所有盘容量之和、要么报最大盘容量，选了后者（问题更小），但仍然无法告诉 kube-scheduler「这个节点其实有好几块盘」。
3. **本地性**：重启的 pod 应该落回持有它全部副本的节点。

**关键洞察 6：** 这两个调度改动是同一种思路在两个层面的应用。volumeTopology 是**约束数据落点**（副本不准跨区）；scheduler extender 是**让调度器看见数据落点**（pod 应该回到副本所在的节点）。一个是「我要控制数据在哪」，一个是「调度器你要根据数据在哪做决策」。中间被绕过的是 `CSIStorageCapacity` 这个**抽象层**——它把「每节点多块盘、每块盘有独立容量与标签」这个真实结构，压成了一个标量，于是所有基于它的调度决策都是近似的。Longhorn 的解法不是修这个抽象，而是让 kube-scheduler 直接问自己。代价是：你得能改 kube-scheduler 配置，托管集群做不到。

---

## 七、数据保护：卷组快照（不一致）、年龄保留、静默损坏修复

### 7.1 卷组快照（#13349）

**改动**：可以从 Longhorn UI、kubectl 或 Kubernetes `VolumeGroupSnapshot` 对象（经 CSI）**用单一请求快照一组相关的卷**。CSI 路径默认关闭，且支持组备份。

但 release notes 里紧跟了一段 `> [!NOTE]`，这段话的重要性超过 feature 本身：

> **Snapshot Consistency:** Each member volume is snapshotted independently, so the group is **not** captured at a single point in time. Application-level consistency across the group is future work ([Issue #2128](https://github.com/longhorn/longhorn/issues/2128))。

**这是一个「协调的多卷快照」，不是一个「一致点多卷快照」。** 区别是致命的：对一个跨卷的数据库事务，两个卷的快照时间点不同，恢复出来就是一个事务的一半在一半卷上、另一半在另一个快照里。**它不能用来做跨卷事务的一致备份**，只能用来减少「对一组彼此独立的卷分别做快照」的操作开销。

`VolumeGroupSnapshot` 这个 CRD 名字会让人产生它是协调快照的错觉。Longhorn 明确说了不是，并且把应用级一致性列成未完成的 future work（#2128 是个老 issue）。**读 release notes 时，`> [!NOTE]` 框里的内容经常比 feature 标题更值得写进生产文档。**

### 7.2 基于年龄的保留（#12060）

**改动**：为快照、备份、系统备份的 recurring job 新增 `age-based` 保留策略，按数据的年龄而不是条目数量保留。设置 `retentionPolicy: age-based` 与 `retainAge: 720h`，每次运行删掉超过指定年龄的快照或备份。`count-based` 仍是默认值，升级后已有的 recurring job 不变。

这条改动解决的是备份策略里一个经典的表达力缺口：**「保留最近 30 份备份」与「保留最近 30 天的备份」是两个完全不同的策略**，前者在负载稀疏时会保留太久、在负载密集时会保留太短。按数量保留是默认值，因为它对「不知道该保留多久」的场景是安全的；按年龄保留才是符合合规与 RPO 语义的。

测试清单里同时验证了升级路径：从 v1.12.x 升级到 v1.13.x 后，已有 RecurringJob 的 `spec.retentionPolicy` 必须仍然是 `count-based` 且继续正常工作。**「新默认值只对新对象生效」是基础设施升级的基本纪律。**

同批还有一个相关的保留策略 bug 值得记一笔：**#13203——System Backup 的 RecurringJob 保留逻辑会删掉最新的 CR**，因为它按 `Status.CreatedAt` 排序，而 Error 状态或竞争中的 CR 这个字段是零值。一个新的 SystemBackup 可能因为排序被当成最老的删掉。这是「按数量保留」类逻辑的典型陷阱：**排序键在异常状态下是零值，零值会排到最前面被当成最老的。**

### 7.3 同批的静默正确性修复

v1.13.0 的修复列表里有若干条都属于「不报错但数据或状态是错的」，值得逐条收藏，因为它们是判断一个存储系统成熟度的最好证据：

| issue | 症状 | 为什么是静默的 |
|-------|------|----------------|
| #13714 | linked-clone 备份恢复后卷数据损坏（源卷/源快照不存在） | 备份成功、恢复成功，校验可能都对，关系已断 |
| #13203 | SystemBackup 保留删掉最新的 CR | 排序键 `Status.CreatedAt` 在 Error/竞争 CR 上为零值 |
| #13379 | V2 扩容报告成功，引擎仍是旧大小 | 状态上报与实际尺寸脱节 |
| #13331 | V2 备份/快照留下残留的 NVMe/TCP frontend 或 dm 设备，导致已挂载卷 EIO | 前端设备清理与快照生命周期不同步 |
| #13673 | V2 副本重建目标失败，故障扩散到整个引擎 | 单副本失败被升级为引擎级故障 |
| #13541 | 一次瞬时的 SPDK lvol 元数据失败，永久故障掉一个健康的 V2 副本 | 瞬时错误被持久化 |
| #13526 | 前一个备份损坏时，无法从完整备份恢复 V2 卷 | 恢复链路上的依赖未校验 |
| #13309 | V2 迁移中移除副本时写 I/O 卡顿约 10 秒 | 有边界但没报错 |
| #13687 | V1 引擎永不启动：一个过期的 `stopped` 进程记录让 `createInstance` 变成静默空操作，卷永远卡在 `attaching` | 「状态记录」与「实际进程」脱节，且无校验 |
| #13703 | V1 副本重建在丢失一次 gRPC TCP keepalive 后失败 | 网络瞬断被当成永久故障 |
| #13957 | V2 instance-manager liveness probe 报 `'test: -eq: unary operator expected'` 后自杀，重建负载下故障掉节点上全部副本 | **探针脚本的 shell 引号 bug**，一个 shell 层面的空变量比较错误级联成节点级数据故障 |
| #13790 | S3 上 `volume.cfg` 缺失时 instance manager panic，把节点上所有卷带下线 | 单个元数据文件缺失 = 节点级故障 |
| #14017 | V2 备份读取与快照清理竞争，panic 掉 instance manager | 读路径与清理路径未协调 |

**#13957 值得单独说一句**：一个 liveness probe 的 shell 脚本因为 `-eq` 的右操作数为空而报 `unary operator expected`，被 probe 失败处理逻辑解读为「不健康」→ 自杀 → 节点上所有副本在重建负载下故障。**「健康检查自身的 bug 会变成故障源」是分布式系统里最反直觉的一类失败模式**：你加探针是为了更快发现问题，探针自己的 bug 制造了问题。#13680（Longhorn UI 不是以 PID 1 运行）是同类问题的另一个切面——进程模型与容器预期不符。

**关键洞察 7：** 把这一整张表放在一起看，会发现 Longhorn 的 bug 分布有一个清晰模式：**绝大多数「硬故障」都是「状态记录与实际状态脱节」**。过期的 `stopped` 记录、零值的 `CreatedAt`、缺失的 `volume.cfg`、未记录的 linked clone 信息、报告成功但没生效的扩容。**存储引擎的核心复杂度不在 I/O 路径，在「哪些状态必须被记录、记录的状态必须被谁校验、校验失败时必须让谁失败」。** v1.13.0 的修复方向高度一致：**让校验在更早的地方发生，让失败是显式的。**

---

## 八、安全线：默认 NetworkPolicy 拆了三个洞，CSI 拿到专用服务账号

这条线与 §一的四道障碍无关，但它把今天早间与中午的「隐含约定显式化」主题在存储层推到了最深处。

### 8.1 三个洞（#13802、#13438、#13740、#13802 的三个 Helm 口子）

**背景**：v1.12.1 起，Longhorn 默认为内部组件创建 ingress `NetworkPolicy`。这些策略**只在 CNI 插件实际强制 `NetworkPolicy` 时生效**。

**#13802 的故障报告是本版本最有教育意义的一份生产事故记录。** 报告者从 v1.12.0 升级到 v1.12.1 后，**集群范围内卷 attach/detach 开始失败**（`FailedAttachVolume`，引擎卡在 `starting`），而 `longhorn-manager` pod 全部 `Running`/`Ready`、内部健康。他们通过 Cilium 的 policy verdict log 定位到两个独立的缺口：

**缺口一：外部 CSI sidecar 不在 `longhorn-manager` 的放行名单里。** v1.12.1 的 ingress `from` 列表只包含：

```yaml
- podSelector: {matchLabels: {app: longhorn-manager}}
- podSelector: {matchLabels: {app: longhorn-ui}}
- podSelector: {matchLabels: {app: longhorn-csi-plugin}}
- podSelector:
    matchExpressions: [{key: recurring-job.longhorn.io, operator: Exists}]
    matchLabels: {longhorn.io/managed-by: longhorn-manager}
- podSelector: {matchExpressions: [{key: longhorn.io/job-task, operator: Exists}]}
- podSelector: {matchLabels: {app: longhorn-driver-deployer}}
```

**这里没有外部 CSI sidecar Deployment——`csi-attacher`、`csi-provisioner`、`csi-resizer`、`csi-snapshotter`**，它们与 `longhorn-csi-plugin` 是**不同的 Deployment**，在 attach/detach 编排时直接调 manager 的 REST API（9500 端口）。在任何 NetworkPolicy provider 真正强制这个名单的环境里，这些 sidecar 到不了 manager，它们中介的卷操作全部静默失败。

**缺口二：非 pod 标签来源与宿主机发起的调用者。** 同一份报告指出，v1.12.1 的默认策略还漏掉了不带这些 pod label 的合法调用者与从宿主机发起的调用。

**v1.12.2 的修法是三个 Helm 值**（v1.13.0 继承）：

- `networkPolicies.v1DataEngineInitiatorSourceCIDRs` —— 放行 v1.12.1 策略拦截的 V1 引擎 initiator 流量；
- `networkPolicies.recoveryBackendAdditionalIngressPorts` —— 恢复后端的额外端口；
- `networkPolicies.metricsScrapeSources` —— 让 Prometheus 与其他采集器能到 longhorn-manager 的 9500 端口。

**第三个值是为 #13740 准备的。** #13740 是一个「补丁升级引发监控黑屏」的事故：**v1.12.1 的 chart 把 `networkPolicies.restrictInternalTraffic` 默认开启，静默打断了 Prometheus 对 longhorn-manager 的采集**，指标与告警在 patch 升级后整体消失。一个「收紧默认值」的安全改动，因为没把合法监控流量算进放行名单，变成了监控黑屏。

**这三条修法的形态完全一致：不是「把策略放松」，而是「给每个合法的调用者一个显式的入口」。**

### 8.2 CSI 专用服务账号（#14020）

**改动**：v1.13.0 让 CSI controller sidecar 跑在专用的 `longhorn-csi-service-account` 下，而不是共享的 `longhorn-service-account`。

**但注意那个诚实的尾巴**：为了兼容已有的 Secret 引用，新服务账号**默认仍然有集群级 `get` Secrets 的权限**。你可以用 `csi.allowControllerSecretAccess` Helm 值关掉它，**但必须先把 Longhorn StorageClass 里的 `csi.storage.k8s.io/provisioner-secret-*` 参数删掉**。

这是「最小权限迁移」的标准两难：你可以把服务账号拆开，但拆开的瞬间不能破坏正在运行的卷，所以新账号先继承旧权限，再提供一个显式的收敛开关与收敛前置条件。**「默认保留兼容性 + 提供显式收紧路径 + 收紧有前置条件」是这类安全改动的安全节奏。**

同一批还有两条同源的网络/认证改动：
- **#13653：chart 的 NetworkPolicy 不认 RKE2 新的 `rke2-traefik` ingress controller**——又一个「放行名单没跟上生态变化」的例子；
- **#13613：CSI 方法级请求日志绕过了 secret 脱敏**——日志层的最小权限反面。

### 8.3 instance manager gRPC 的 mTLS 全覆盖（#7787、#13212）

**改动**：v1.12.1 之前，配置了 `longhorn-grpc-tls` secret 时，mTLS 只覆盖 instance manager 的 instance 与 proxy gRPC 服务，**disk 与 SPDK 服务仍然接受明文连接**。v1.12.1 起，mTLS 覆盖 instance manager 的**全部** gRPC 服务，配置了 secret 时每个 gRPC 端口都要求有效客户端证书。

这条改动在时间上与 §三的热升级协议是同一批——**这几乎不是巧合**：热升级要滚动替换 instance manager，替换过程中 manager 与 SPDK 之间会有新的连接建立，如果一半 gRPC 服务是明文、一半是 mTLS，滚动升级的握手逻辑就要处理两种认证状态。**先把认证铺平，再做热升级**，是正确的依赖顺序。

### 8.4 其他值得记的改动

- **#13756：`ignoreSigningHeaders` 变成可配置**——SigV4 的 `Accept-Encoding` 会打断**每一个** S3 备份目标后面跟一个改写头部的代理**，不只是 GCS**。这是一个「为某个云厂商修的 bug，其实影响所有同类代理」的典型例子。
- **#13479：运行时容器镜像包含开发（`-devel`）包**——攻击面与镜像体积同时收敛。
- **#13864：backing image 副本之前总是走 IPv4 传输**，在 IPv6 单栈与 IPv6 优先的双栈集群上，backing image 永远只有一份。现在按集群的 IP family 与存储网络传输。
- **#12976：允许配置 Gateway API 过滤器**（顺带修了 #13340 ArgoCD 的 OutOfSync 问题）。
- **#13491 / #13474 / #13557 / #13893**：一组 V2 块磁盘识别的边界修复，包括 BDF 路径、`createDefaultDiskLabeledNodes` 与 BDF 不工作、`/dev/disk/by-id/scsi-*` 路径加 V2 磁盘失败，以及 **NVMe 设备绑到 `vfio-pci` 时块磁盘一直 `Ready=False` 且 `Schedulable=False`**——后者是 DPDK/SR-IOV 与 SPDK 抢设备的典型症状。
- **#12709 / #12159**：SPDK 在 Talos OS 上 `nsenter: operation not permitted` 初始化失败，以及配置错误或已删除的 Talos 节点导致 Driver Deployer 不断重启。**Talos 这类不可变 OS 是 V2 用户态存储的高风险区域**——它对 `nsenter`/host mount 的限制正好打在 SPDK 需要的地方。
- **#13322 / #13674：SPDK iobuf 大/小池大小可配置**。池在 SPDK 启动时定尺寸，改任一设置会**重建没有运行引擎或副本的 V2 instance manager pod**。这是「改配置 = 重建进程」的典型 SPDK 限制。
- **#13706：可配置 NVMe-TCP initiator 的 I/O 队列数（`nr-io-queues`）**。
- **#13636：帮助满盘上的大副本回收空间，把数据全部压进 heads**——这是空间碎片治理的入口。

---

## 九、五段可直接运行的代码

### 9.1 新集群：V2 数据引擎 + 中断模式 + CPU 隔离的 Helm values

```yaml
# longhorn-values.yaml
# v1.13.0 新安装默认已开启 CPU 隔离；这里显式写出便于审计
longhornManager:
  # 轮询 + CPU 隔离：默认。最低延迟，每 reactor 钉一个核
  dataEngineCpuIsolationEnabled: '{"v2":"true"}'

  # 完全中断模式：必须在没有 V2 卷 attached 时设置
  # 空闲 CPU 从 ~100%/核 降到近 0，高吞吐下延迟略高
  dataEngineInterruptModeEnabled: '{"v2":"true"}'

  # SPDK iobuf 池（池在 SPDK 启动时定尺寸，改了会重建空闲的 IM pod）
  dataEngineIobufLargePoolSize: '{"v2":"64"}'
  dataEngineIobufSmallPoolSize: '{"v2":"32"}'

# v1.13.0 新增：扛走集群级 Pod/PV 控制器的 Deployment
longhornGlobalManager:
  replicas: 3            # 1 个 leader + 2 个热备（缓存同步，接管不需重新 LIST）
  # priorityClass / affinity / resources / tolerations / nodeSelector 均可配

networkPolicies:
  # v1.12.2 起的三个显式放行口子（默认 NetworkPolicy 的补丁）
  v1DataEngineInitiatorSourceCIDRs: []
  recoveryBackendAdditionalIngressPorts: []
  metricsScrapeSources:
    - 10.0.0.0/8         # Prometheus 所在网段；不填 = 指标与告警黑屏 (#13740)

csi:
  # v1.13.0：CSI sidecar 用专用 SA；收敛前必须先删 StorageClass 里的
  # csi.storage.k8s.io/provisioner-secret-* 参数
  allowControllerSecretAccess: false
```

安装前先确认 Kubernetes 版本：

```bash
# v1.13.0 硬性前置条件：CSI external-provisioner 升到 v6.3.0，要求 K8s >= v1.34
kubectl version --output=json | jq -r '.serverVersion.gitVersion'
# 低于 v1.34 不要装，升级路径见下文
```

### 9.2 热升级前的 preflight 检查

```bash
#!/usr/bin/env bash
# v2-live-upgrade-preflight.sh —— 任何一步失败都不要继续升级
set -euo pipefail

echo "== 1. 当前 Longhorn 版本（热升级只支持 v1.12.2 -> v1.13.0) =="
LH_VER=$(kubectl -n longhorn-system get deploy longhorn-manager \
  -o jsonpath='{.spec.template.spec.containers[0].image}' | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+')
echo "longhorn-manager image: $LH_VER"
[ "$LH_VER" = "v1.12.2" ] || {
  echo "!! 不是 v1.12.2。从 v1.12.0/v1.12.1 升级必须 detach 所有 V2 卷并停止副本"; exit 1; }

echo "== 2. Kubernetes >= v1.34 (CSI external-provisioner v6.3.0) =="
KV=$(kubectl version --output=json | jq -r '.serverVersion | .major + "." + .minor')
echo "k8s: $KV"

echo "== 3. longhorn-global-manager 至少一个 pod 可调度（v1.13.0 新依赖） =="
kubectl -n longhorn-system get deploy longhorn-global-manager || \
  echo "!! 升级到 v1.13.0 才会创建这个 Deployment，升级时必须保证它能调度"

echo "== 4. 所有 V2 卷的引擎镜像版本一致（混合版本不可热升级） =="
kubectl -n longhorn-system get engines.longhorn.io \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.currentImage}{"\n"}{end}' | sort -k2 | uniq -c -f1

echo "== 5. 没有正在进行的重建（重建中升级 = 风险窗口） =="
kubectl -n longhorn-system get replicas.longhorn.io \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.currentState}{"\n"}{end}' \
  | awk '$2 != "running" {print "!! 非运行中副本:", $0}'

echo "== 6. 先升级一次 dry-run，看 CRD / webhook 是否报错 =="
helm upgrade longhorn longhorn/longhorn -n longhorn-system \
  -f longhorn-values.yaml --dry-run >/tmp/lh-dryrun.txt && echo "dry-run OK"
```

### 9.3 卷组快照（含一致性边界）与年龄保留 RecurringJob

```yaml
# 卷组快照：一次请求快照一组卷。
# !! 注意：每个成员卷独立快照，组不是一个单一时间点。
# !! 跨卷事务不要用它做一致备份（应用级一致性是 issue #2128 的未完成工作）。
apiVersion: groupsnapshot.storage.k8s.io/v1beta1
kind: VolumeGroupSnapshot
metadata:
  name: app-stack-group-snap
spec:
  source:
    persistentVolumeClaims:
      - app-db-pvc
      - app-cache-pvc      # 与 db 无跨卷事务时才可同组
  volumeSnapshotClassName: longhorn-snapshot

---
# 基于年龄的保留：符合 RPO/合规语义，比「保留 N 份」更准
apiVersion: longhorn.io/v1beta2
kind: RecurringJob
metadata:
  name: backup-age-based
  namespace: longhorn-system
spec:
  cron: "0 */6 * * *"
  task: backup
  retentionPolicy: age-based     # count-based 仍是默认；升级后已有 job 不变
  retainAge: "720h"              # 30 天；每次运行删掉超过该年龄的快照/备份
  concurrency: 2
  # v1.13.0 修了 #13623：之前任一卷副本在重建，整次快照清理 run 会被中止
```

### 9.4 拓扑约束 StorageClass + scheduler extender 的 kube-scheduler 配置

```yaml
# 拓扑约束：把副本钉在 provision 时的故障域里（含重建与改副本数）
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-v2-zonal
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Delete
volumeBindingMode: WaitForFirstConsumer   # 卷跟着 Pod 落地的区走
parameters:
  dataEngine: "v2"
  volumeTopology: "zonal"                  # any(默认) | zonal | regional
  # 被钉的域没容量时 -> 调度失败，不会静默退回跨区放置
  numberOfReplicas: "3"
---
# regional：副本在域内自由，跨区但不出域
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-v2-regional
provisioner: driver.longhorn.io
volumeBindingMode: WaitForFirstConsumer
parameters:
  dataEngine: "v2"
  volumeTopology: "regional"
  numberOfReplicas: "3"
```

scheduler extender 需要改 kube-scheduler 配置（**GKE/EKS 上做不到**，因为改不了 kube-scheduler 的 config）：

```yaml
# kube-scheduler 的 KubeSchedulerConfiguration patch
apiVersion: kubescheduler.config.k8s.io/v1
kind: KubeSchedulerConfiguration
profiles:
  - schedulerName: default-scheduler
    pluginConfig:
      - name: Extender
        args:
          httpTimeout: 30s
          enableHTTPS: false
          extenders:
            - urlPrefix: "http://longhorn-backend.longhorn-system.svc:9500"
              # extender 跑在 longhorn-manager 内部
              filterVerb: "scheduler/filter"
              prioritizeVerb: "scheduler/prioritize"
              bindVerb: ""                       # 不接管 bind
              weight: 1
              managedResources:
                - name: "longhorn.io/volume"     # 只对带 Longhorn PVC 的 pod 生效
              ignorable: true                    # extender 不可达时不阻塞调度
```

`ignorable: true` 是关键：**存储系统的调度建议不应该有能力让整个集群的调度停摆**。

### 9.5 排障：验证默认 NetworkPolicy 是否在拦截 CSI sidecar

```bash
#!/usr/bin/env bash
# 排障脚本：attach/detach 全集群失败但 longhorn-manager 全部 Ready 时优先跑这个
# 场景：升级到 v1.12.1+ 后 FailedAttachVolume，引擎卡 starting（issue #13802）

echo "== 1. 确认 CNI 是否真的强制 NetworkPolicy（不强制则策略无效） =="
kubectl -n kube-system get ds | grep -iE 'cilium|calico|antrea' || echo "!! 无已知 NetworkPolicy provider"

echo "== 2. 默认 NetworkPolicy 是否拒绝了 CSI sidecar 的来源 =="
# #13802 的根因：ingress from 列表没有 csi-attacher/provisioner/resizer/snapshotter
for d in csi-attacher csi-provisioner csi-resizer csi-snapshotter; do
  echo "--- $d"
  kubectl -n longhorn-system get deploy "$d" -o jsonpath='{.spec.selector}' 2>/dev/null || echo "   (该 sidecar 不存在)"
done

echo "== 3. 若 CNI 是 Cilium：用 policy verdict log 看实际判决（#13802 的定位手段） =="
cat <<'EOF'
kubectl -n kube-system exec ds/cilium -- cilium policy trace \
  --src-identity <csi-attacher-identity> \
  --dst-identity <longhorn-manager-identity> \
  --dport 9500/tcp
# 输出 "Verdict: DENIED" 即策略拦截；"ALLOWED" 则问题在别处
EOF

echo "== 4. v1.12.2+ 的三个放行口子（metrics 黑屏看第三个） =="
helm get values longhorn -n longhorn-system -o json | jq '.networkPolicies'

echo "== 5. CSI sidecar 用的服务账号（v1.13.0 起应为专用 SA） =="
kubectl -n longhorn-system get deploy csi-provisioner \
  -o jsonpath='{.spec.template.spec.serviceAccountName}' ; echo
# 收敛路径：先删 StorageClass 的 csi.storage.k8s.io/provisioner-secret-*，
# 再设 csi.allowControllerSecretAccess=false

echo "== 6. V1 引擎卡 attaching 永不恢复：查过期的 stopped 进程记录 (#13687) =="
kubectl -n longhorn-system get engines.longhorn.io \
  -o jsonpath='{range .items[?(@.status.currentState=="starting")]}{.metadata.name}{"\n"}{end}'
```

---

## 十、五套云原生存储方案 17 维度对比

| 维度 | Longhorn V1 (v1.13) | Longhorn V2 (v1.13) | Ceph-CSI RBD | OpenEBS Mayastor | TopoLVM |
|------|---------------------|---------------------|---------------|-------------------|---------|
| 数据通路 | iSCSI 前端+后端，两次穿内核 | SPDK 用户态，仅前端一跳穿内核 | 内核 RBD，Ceph 集群网络 | SPDK 用户态 NVMe-oF | LVM 卷组，节点本地 |
| 复制位置 | 引擎进程内同步复制 | SPDK 内 NVMe-oF TCP 到副本 subsystem | RADOS（Ceph 后端） | NVMe-oF TCP | 不复制（靠 LVM 镜像或上层） |
| CPU 模型 | 进程调度，空闲近 0 | 三档可配：轮询+隔离 / 轮询 / 完全中断（v1.13 新） | 内核态，空闲近 0 | SPDK 轮询钉核 | 内核态 |
| 升级是否需停卷 | 需 detach | **不需（v1.13 热升级，仅 v1.12.2 路径）** | 依 Ceph 升级策略 | 需 detach | 不适用（节点本地） |
| 故障域约束 | zone 反亲和散布 | **`volumeTopology: zonal/regional` 显式约束（v1.13 新）** | CRUSH 规则 | 副本拓扑参数 | 不适用 |
| 调度集成 | CSIStorageCapacity | **+ scheduler extender 读真实磁盘容量（v1.13 新）** | CSIStorageCapacity | CSIStorageCapacity | CSIStorageCapacity + 节点容量 |
| 快照 | ext4 写时复制 | SPDK lvol 快照 + 卷组快照（非一致点） | Ceph 快照 + group snapshot | SPDK 快照 | LVM 快照 |
| 快克隆 | 全量复制 | **linked-clone 零拷贝（共享块，v1.12.1 起）** | clone（依赖池） | linked clone | LVM thin pool |
| 备份目标 | S3/NFS，含 SigV4 头部问题（v1.13 修） | 同（v1.13 修 linked-clone 备份损坏） | 依赖上层（Velero 等） | 依赖上层 | 依赖上层 |
| RWX | ShareManager NFS | ShareManager NFS（双栈兼容 v1.13 修） | CephFS | NFS（较新） | 不支持 |
| 网络隔离 | 手工 | **默认 NetworkPolicy + 三个显式放行口子** | 依赖 Ceph 网络平面 | 手工 | 不适用 |
| 控制平面 | DaemonSet 全量 | **DaemonSet + global-manager（O(1) 集群级 watch）** | Ceph mgr/mon 集群 | DaemonSet | DaemonSet |
| 内核依赖 | iSCSI（通用） | NVMe-TCP / UBLK（UBLK 在 6.17 会 panic） | RBD（通用） | NVMe-oF（较新） | LVM（通用） |
| 托管 K8s 可用性 | 好 | 好（scheduler extender 例外） | 好 | 一般 | 好 |
| 加密 | 节点级 | V2 卷加密（v1.13 修了若干边界） | Ceph 加密 | 节点级 | 节点级 |
| 生态/许可 | Apache 2.0，Rancher/Harvester 一等 | 同 | LGPL，独立集群 | Apache 2.0 | Apache 2.0 |
| 成熟度 | 多年生产 | **v1.12.0 GA，v1.13 补齐生产条件** | 成熟 | 相对年轻 | 成熟（但场景窄） |

**选型结论**：
- **已有 Longhorn V1 生产集群**：v1.13.0 是评估迁移的第一个合理节点——热升级 + 拓扑约束 + global-manager 三件事把迁移的停机成本与规模化风险降下来了，但**先在非生产环境跑 v1.12.2 → v1.13.0 热升级路径**；
- **新集群、数据库与高 IOPS**：V2 轮询 + CPU 隔离；
- **新集群、边缘或稀疏负载**：V2 完全中断模式，代价是高吞吐下的延迟；
- **已有 Ceph 且运维能力强**：Ceph RBD 在故障域控制（CRUSH）与一致性上仍然更强；
- **纯节点本地临时卷**：TopoLVM 比 Longhorn 轻得多。

---

## 十一、6 条 6-12 个月可验证硬指标

1. **空转 CPU**：V2 集群，0 卷 attached，`top -p $(pgrep -f reactor_0)` 看 `%CPU`。轮询模式 ~100%/reactor 核；开完全中断模式后应降到 1% 量级（参照 #9834 里 SPDK v25.01 的 0.997% 数据）。**这个数字是「是否该开中断模式」的决策依据，不用猜。**
2. **apiserver watch 压力**：升级到 v1.13.0 后，`kubectl get --raw /metrics/apiserver | grep watch_events` 看 Pod watch 的分发量；理论上从 O(节点数) 降到 O(3 个 global-manager 副本)。同时看 `longhorn-manager` pod 的 RSS——DaemonSet 的 pod RSS 应该不再随集群 Pod 总数增长。
3. **热升级停机时间**：v1.12.2 → v1.13.0，记录升级期间 V2 卷的 I/O 中断时间（应用侧的 `iostat`/应用超时计数）。目标：0 次 detach。**如果你在升级窗口里看到任何卷 detach，说明前置条件没满足，停下来排查。**
4. **跨区流量**：开了 `volumeTopology: zonal` 的卷，用节点/网络层面的监控统计跨可用区流量。对比开之前：数据路径上的永久跨区 I/O 应当消失。这个指标直接体现在云账单的跨区数据传输费上。
5. **调度准确率**：开 scheduler extender 前，统计「pod 被调度到磁盘容量不足节点」导致的 `ProvisioningFailed` / 重新调度次数；开之后应显著下降。同时统计重启 pod 落回「持有全部副本节点」的比例（`best-effort` 本地性的核心收益）。
6. **默认 NetworkPolicy 放行完备性**：在强制 NetworkPolicy 的 CNI（Cilium/Calico）上，升级到 v1.13.0 后跑一次完整的 attach/detach + 备份 + Prometheus 采集回归。三个口子漏任何一个都会在这一次回归里暴露（#13802 的 attach/detach、#13740 的指标黑屏）。

## 十二、6 条 6-12 个月可观察未来信号

1. **#13241（V2 卷 attach 延迟随已挂载卷数增长）的根因定位**。release notes 把它放在 `> [!IMPORTANT]` 里并写明「根因仍在调查」。定位结果是 SPDK 用户态还是 Linux 内核的 NVMe-TCP 连接处理，会决定 V2 在「每节点几十上百个卷」场景下的可用性上限。**这是 v1.13.0 最大的已知性能未知项。**
2. **#2128（卷组快照的应用级一致性）**。当前每个成员独立快照；如果 Longhorn 把它做成真正的一致点快照（需要某种协调协议或存储侧一致性原语），`VolumeGroupSnapshot` 的语义会从「批量操作」变成「跨卷一致备份」，这会改变它在备份方案里的地位。
3. **存储分片 + EC（#1061）走出实验阶段**。当前不支持 backup/restore、克隆、backing image、DR 卷、live migration，明确「仅供评估与测试，不推荐生产」。它一旦 GA，Longhorn 的存储效率模型就从「每副本一份全量」变成「数据+校验分片散布」，成本结构会变。
4. **longhorn-global-manager 承载更多控制器**。设计文档明确说「这次只搬两个，其他按需 case-by-case」。下一次有具体规模化压力时（比如 Backup 控制器或 SystemBackup 在大集群上的性能），会再搬一批。**这个 Deployment 会逐渐变成 Longhorn 的「集群级控制平面」，DaemonSet 退回成纯节点代理。**
5. **SPDK 上游的中断模式覆盖面**。目前 NVMe bdev 的 **TCP transport** 尚不支持中断模式（见 #9834 中 derekbit 的说明），只有 NVMe PCIe 支持。SPDK 何时把 TCP transport 的中断模式做出来，决定了「完全中断模式」在 NVMe-oF TCP 后端上是否完整——目前它是前端侧的事件驱动，后端 poller 仍在工作。
6. **K8s 侧多 PVC / 多盘调度能力的进展**（kubernetes/kubernetes#111755）。Longhorn 用 scheduler extender 绕过了 `CSIStorageCapacity` 的单池建模缺陷；如果上游把「每节点多盘」做进 CSIStorageCapacity 或调度框架，extender 的存在理由会减弱——但「托管 K8s 改不了 kube-scheduler 配置」这个约束不会消失，所以 extender 在 GKE/EKS 上始终是残缺的。

---

## 十三、5 步生产升级 checklist + 最佳实践

### 升级 checklist（从 v1.12.x 到 v1.13.0）

- [ ] **第 0 步（最容易死的一步）：确认 K8s >= v1.34。** CSI external-provisioner 升到 v6.3.0，所有集群必须先满足这个。**这个版本要求是硬性的，不是「建议」。**
- [ ] **第 1 步：确认升级路径。** 只有 v1.12.2 能走热升级。v1.12.0 / v1.12.1 升级，或前置条件不满足：**detach 所有 V2 卷 + 确保副本停止**，没有例外。
- [ ] **第 2 步：确认 `longhorn-global-manager` 至少一个 pod 可调度。** 它是 v1.13.0 升级路径上的新硬依赖，默认 3 副本。忘了这一步，升级会卡在控制器无处运行。
- [ ] **第 3 步：跑 preflight（§9.2）**，确认没有正在进行的重建、所有引擎镜像版本一致。**重建中升级是最高风险窗口**（#13673：副本重建目标失败会故障扩散到整个引擎）。
- [ ] **第 4 步：升级后立刻验证 NetworkPolicy 放行**（§9.5 第 3/4/5 步）。在强制 NetworkPolicy 的 CNI 上，这一步漏掉会变成 `FailedAttachVolume` 全集群失败。
- [ ] **第 5 步：回归备份链路。** 特别注意 V2 linked-clone 卷——v1.12.x 的旧备份可能缺 linked clone 信息，恢复前确认源卷与入口快照存在（#13714 的修复只保护新备份）。
- [ ] **升级后（可选但推荐）：** 从 v1.12.x 升上来的集群，手动把 `data-engine-cpu-isolation-enabled` 设成 `{"v2":"true"}`（新安装默认开，升级保留旧值）；低 I/O 集群评估完全中断模式。

### 5 条最佳实践

1. **把「默认 NetworkPolicy」当成生产配置而不是安全装饰。** 它是默认开启的，因此在强制 NetworkPolicy 的 CNI 上它会**主动改变你的集群行为**。升级到 v1.12.1+ 之前，先填好 `metricsScrapeSources` 与两个 initiator/recovery 口子。#13740 是教训：一个 patch 升级让监控整体黑屏。
2. **不要在没读 `> [!IMPORTANT]` / `> [!NOTE]` 框的情况下升级。** v1.13.0 的 release notes 里这三个框分别管：升级路径（只支持 v1.12.2）、K8s 最低版本（v1.34）、卷组快照一致性（不是单一时间点）。**它们是 release notes 里信息密度最高的部分。**
3. **热升级路径只有一条，保护好它。** 任何让 V2 instance manager 无法滚动替换的因素（混合引擎镜像版本、重建中的副本、Talos OS 的 `nsenter` 限制）都会把「热升级」降级回「停卷升级」。在非生产环境先跑一遍完整路径。
4. **linked-clone 的源卷是生产依赖。** 克隆零拷贝的代价是源卷必须活着。删除任何「被 linked clone 引用的源卷或源快照」之前，先确认引用关系；v1.13.0 的恢复路径会在源缺失时报错，但**旧版本的备份没有这个保护**。
5. **中断模式与轮询模式按负载选，不要全局一刀切。** 数据库类持续高 IOPS 用轮询 + CPU 隔离；开发/边缘/稀疏负载用完全中断模式。切换必须在**没有 V2 卷 attached** 时做，且开了中断模式后 CPU 隔离会自动跳过——两者是互斥的，别同时期待两个收益。

### ❌ 千万别做

- ❌ 从 v1.12.0 或 v1.12.1 直接热升级到 v1.13.0。**这条路径没有热升级支持，会损坏数据。**
- ❌ 在 kernel 6.17 上用 UBLK 前端。**会导致内核 panic**（#13509）。UBLK 仍然是实验性前端。
- ❌ 在 ARM64 上给 SPDK 配 2 个以上 CPU 核并用 NVMe 驱动的节点磁盘。**V2 卷可能卡 I/O**（#13243），用 AIO 磁盘作替代。
- ❌ 把卷组快照当跨卷一致备份用。每个成员独立快照，跨卷事务恢复出来是撕裂的。
- ❌ 用分片/EC 卷跑生产。明确「仅供评估与测试」，且不支持 backup/restore、克隆、backing image、DR、live migration。
- ❌ 在 Talos OS 上直接上 V2 而不先验证 SPDK 初始化。`nsenter: operation permitted` 这类报错（#12709）是 V2 在不可变 OS 上的高风险信号。
- ❌ 升级到 v1.13.0 后继续用共享 `longhorn-service-account` 跑 CSI controller。用专用 SA + `csi.allowControllerSecretAccess: false`，但**先删 StorageClass 里的 secret 参数**。

---

## 十四、3 个长期判断

**判断一：用户态存储进入 K8s 生产，卡点已经从「性能」变成「运维语义」。** SPDK 的性能优势多年前就清楚了；真正阻止它替换内核态 iSCSI 的是「升级要不要停卷」「空闲 CPU 怎么办」「控制平面怎么扩展」「副本能不能留在故障域里」这四个运维语义问题。v1.13.0 逐个给了答案。**未来 12-24 个月，用户态存储竞争的核心不是 benchmark，是「升级窗口、CPU 成本、故障域控制、调度集成」这四个语义的完整度。** 谁先把这四个都做齐，谁就拿到替换内核态存储的入场券。

**判断二：DaemonSet 控制平面会普遍走向「节点代理 + 集群级 Deployment」的双层结构。** Longhorn 的 `longhorn-global-manager` 不是孤例，它是一个可以被任何 DaemonSet 控制平面复用的模式：把「需要集群级可见性的少数控制器」抽到 leader-elected Deployment，把节点本地的东西留在 DaemonSet，让每节点的 watch 与缓存收缩到命名空间范围。**凡是控制平面成本随节点数线性增长的项目（CSI driver、CNI agent、设备插件、存储/网络 operator）都会走这一步**，因为客户的集群节点数增长速度远快于他们能接受的 apiserver 压力增长速度。同批的 #13782（重复构建两次 informer 缓存）、#13786（集群级 watch Leases 只读命名空间）、#13726（为 watch 一个 Secret 缓存全部 Secret）是同一个问题在代码层面的三个切面，它们会一起被这类重构消化掉。

**判断三：存储系统的静默损坏风险，正在从「单对象状态错误」转移到「跨对象生命周期约定错误」。** 看看 v1.13.0 修的这一批：linked-clone 备份恢复损坏（源卷关系未记录）、SystemBackup 保留删掉最新 CR（排序键零值）、扩容报告成功但引擎旧尺寸、V1 引擎因过期 `stopped` 记录永不启动。**没有一个 bug 是「单个对象的状态算错了」，全部是「对象 A 记录的状态与对象 B 的实际状态脱节」。** 这说明存储引擎的复杂度重心已经迁移：I/O 路径的正确性被测试覆盖得越来越好，**对象间关系（克隆↔源、备份↔快照↔卷、引擎↔进程记录、CR↔实际资源）成了新的故障主战场**。对使用者来说，这意味着两件事：**备份恢复必须做实际的数据校验，不能只看操作成功**；**监控要监控「关系」而不是只监控「状态」**——比如「存在 linked clone 但源卷缺失」这类关系级断言，应当是一条告警规则，而不是一次恢复失败后的排障。

---

## 写在最后

v1.13.0 的 release notes 有 44 KB，184 个 issue。读完最大的感受不是「加了很多功能」，而是**一个存储系统在 GA 之后真正开始偿付生产债**。

V2 数据引擎在 v1.12.0 宣布 GA，GA 的意思是「我们承诺它的数据通路是可靠的」。v1.13.0 做的是兑现这个承诺周围的四件事：**升级不用停你的应用、空闲不烧你的 CPU、扩节点不压你的 apiserver、副本不越过你的故障域**。这四件事没有一件是性能 feature，全部是运维契约。

而这一整周的脉络放在一起看，其实只有一句话：**2026 年的基础设施软件，正在把过去十年所有「大家都心照不宣」的隐含约定，一条一条写成显式声明。** Helm 删资源前先证明所有权，Longhorn 副本跨区前先要你声明 `zonal`，NetworkPolicy 默认拒绝后给每个合法调用者一个显式入口，CSI 凭证收敛到专用服务账号，连 linked clone 的源卷关系都写进了备份元数据。

隐含约定的代价是「出事时你不知道为什么」。显式声明的代价是「配起来更烦」。2026 年 10 月，基础设施生态整体选了后者。

---

**数据来源**：[Longhorn v1.13.0 Release Notes](https://github.com/longhorn/longhorn/releases/tag/v1.13.0)（44 KB，2026-09-29 发布）；issue #9834 的 SPDK CPU 排障记录与 SPDK `v25.01-rc1` commit `b8c65ccf` 的 NVMe PCIe 中断模式支持；issue #13802 的 Cilium policy verdict 排障报告；enhancement `20260506-global-longhorn-manager.md`（global-manager 设计文档）；issue #13493 / #12591 / #11662 / #9104 / #13714 / #13241 / #2128 的原始描述；[Longhorn v1.13.0 官方文档](https://longhorn.io/docs/1.13.0/)。
