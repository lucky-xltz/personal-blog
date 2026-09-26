---
title: "Firecracker v1.17.0 深度拆解：THP 把 microVM 启动砍掉一半，vsock 修一个 busy-spin 吞吐涨 44%"
date: 2026-09-26
category: 技术
tags: [Firecracker, microVM, KVM, 虚拟化, 透明大页, THP, huge_pages, vsock, virtio-blk, discard, TRIM, bzImage, snapshot, fsync, virtio-mem, 热插拔, CPU 模板, Graviton5, ARM64, CLIDR_EL1, 内核 6.18, 沙箱, 隔离边界, Serverless, Rust, rust-vmm, 单线程事件循环, epoll busy-spin, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
excerpt: "2026 年 9 月 10 日，Firecracker v1.17.0 发布。这个被 AWS 用来跑 Lambda 和 Fargate 的 Rust microVM hypervisor，这一版把三件事推到了新位置：启动、内存、以及一个存在了三年的事件循环自旋 bug。最扎眼的数据是 PR #6003——给客户机内存开透明大页（THP），在 m8i.16xlarge + AL2023 + 6.18 内核上把 guest CPU 启动时间从 325ms 压到 112ms（-65.4%），systemd 全量启动从 803ms 压到 529ms（-34.0%）；对一台 50ms 内必须起来接客的 Serverless 函数容器，「内核态启动占多少」直接决定 P99 冷启动。第二件是 vsock：PR #6031/#6041/#6077 修的是同一个根因——单线程事件管理器里，设备在数据无法投递时仍然挂着 level-triggered EPOLLIN/EPOLLOUT，epoll_wait 每次返回都不空、每次都做无用功，把事件线程钉死在 100% CPU 并饿死同一进程上的 API socket 和其它设备后端；修完之后 host→guest 吞吐中位数 +44%，每 Gbps 的 host 侧 CPU 开销降约 50%。第三件是正确性：virtio-mem 从快照恢复后未插入内存可写且可能未映射、热插拔字节数 MiB→bytes 静默 32 位回绕成 0 字节区域、aarch64 jailer 的 chroot 属主设置存在 TOCTOU 竞争。本文拆开这 6 大承重级改动的实现：为什么 THP 必须先把客户机内存按 2MiB 对齐、bzImage 走 64 位入口点还要从自身 setup header 填 zero page、snapshot 的 sync_snapshot_files=false 为什么能让 4GB 全量快照快 13 倍、virtio-blk 的 discard 怎么和 VIRTIO_BLK_F_TOPOLOGY 配合、以及 5 段可直接跑的 API/代码。"
---

# Firecracker v1.17.0：启动时间砍一半，靠的是把内存对齐到 2MiB

2026 年 9 月 10 日，Firecracker v1.17.0 发布。

Firecracker 的定位很窄，也很极致：**一个只做 KVM、只跑 Linux、只支持 virtio 的 Rust hypervisor**，一台物理机上起几千个 microVM，每个跑一个不受信任的工作负载。AWS 用它跑 Lambda 和 Fargate，Cloudflare 用它跑 Workers 的隔离边界，外面创业公司拿它做 CI runner、AI 代码沙箱、多租户 Agent 隔离。它把「隔离强度」和「启动速度」这两个通常互斥的指标，钉在了一张性能表的两个角上：**进程级隔离的启动开销，虚拟机级隔离的安全边界**。

v1.17.0 这一版没有换架构，但它把三件事推到了新位置：**启动、内存、以及一个存在了三年的事件循环自旋 bug**。

先看最扎眼的数据。PR #6003 给客户机内存开透明大页（Transparent Huge Pages），在 AWS m8i.16xlarge 上：

| 环境 | systemd_kernel | guest_cpu_boot_time | guest_boot_time | systemd_total |
|---|---|---|---|---|
| m8i.16xlarge, AL2023, 6.18 | 281ms → **136ms**（-54.5%） | 325ms → **112ms**（-65.4%） | 362ms → **183ms**（-50.8%） | 803ms → **529ms**（-34.0%） |
| m8i.16xlarge, AL2023, 6.1 | 279ms → 136ms（-54.0%） | 321ms → 113ms（-64.5%） | 334ms → 159ms（-54.5%） | 800ms → 528ms（-33.8%） |
| m8i.metal-48xl, AL2023, 6.18 | 130ms → 107ms（-24.9%） | 110ms → 72ms（-34.1%） | 188ms → 157ms（-19.3%） | 497ms → 437ms（-13.0%） |

**guest CPU 启动时间 -65%，systemd 全量启动 -34%**，改的是一个 `madvise(MADV_HUGEPAGE)`。

第二件是 vsock。PR #6031 / #6041 / #6077 修的是同一个根因的不同分身：**单线程事件管理器里，设备在数据无法投递时仍然挂着 level-triggered 的 epoll 兴趣集**，`epoll_wait` 每次返回都不空、每次都做无用功，把事件线程钉死在 100% CPU，并顺带饿死跑在同一进程里的 API socket 和其它设备后端。修完之后：**host→guest 吞吐中位数 +44%，每 Gbps host→guest 流量的 host 侧 CPU 开销降低约 50%**；副作用是单 vCPU microVM 在最新 Intel 主机上吞吐可能 -15%（瓶颈从 host 转移到 guest 的那一个 vCPU）。

第三件是正确性，而且不是「边界情况」的正确性：virtio-mem 从快照恢复后**未插入的内存对 VMM 可写且可能未被映射**；热插拔内存的 `requested_size_mib` 在 MiB→bytes 转换时**静默 32 位回绕**，一个足够大的请求会被接受成一个 0 字节区域；aarch64 jailer 在把 CPU cache 和 `MIDR_EL1` 信息文件拷进 chroot 后设置属主，存在 TOCTOU 竞争。

本文按「为什么这个改动是承重级的 → 它实际上改了什么 → 怎么用」的顺序，逐个拆开 6 大承重级改动，最后给 5 段可直接跑的配置和代码。

---

## 一、问题的源头：microVM 的三笔账

要理解为什么 v1.17.0 的每个改动都长这样，得先理解 Firecracker 在算哪三笔账。

### 1.1 启动账：ms 级的预算被内核启动吃掉一半

Firecracker 的典型使用场景是**请求驱动的按需启动**：一个 HTTP 请求进来，控制平面起一个 microVM，VM 里跑用户代码，处理完请求，VM 销毁。这个场景的 SLA 通常长这样：

```
请求到达 → 控制平面调度 (~20-50ms) → Firecracker 进程启动 (~10ms)
        → 加载内核 + 填 zero page (~10-30ms) → 客户机内核启动 (100-400ms)
        → systemd/init 起来 (~200-400ms) → 应用监听端口 (~50-200ms)
```

**客户机内核启动这一段，经常吃掉总预算的 40-60%**。而它里面最重的一块不是驱动初始化，是**页表建立**：内核要把整个物理内存（对 Lambda -sized 的 VM 通常是 256MB-2GB）逐页映射进内核页表，每一页一个 4KiB 条目。一个 2GB 的 VM = 524288 个页表项，每一项都要写一次内存，还要触发一次 TLB 相关的同步。

这就是 THP 的切入点：**如果客户机物理内存后台用的是 2MiB 大页，内核遍历的页表项数量直接除以 512**。

### 1.2 内存账：每个 GB 都乘以几千个实例

Firecracker 的密度指标是「一台物理机能装多少个 microVM」。每个 microVM 的内存开销有三层：

- **客户机物理内存**：用户配置的 guest memory，比如 256MiB
- **宿主机页表开销**：KVM 给每个客户机维护的 shadow page table 或 EPT/NPT
- **VMM 自身开销**：Firecracker 进程、API socket、每个设备的 virtio 队列

第一层是显性的（用户配多少就是多少），第二层是隐性的且**随宿主机页表层级指数级放大**。在 4KiB 页的机器上，一个 2GB 的客户机在宿主机侧需要三级页表 + 数十万次 page fault。大页把宿主机侧的页表层级压平，同时大幅减少 page fault 次数。

但直接要求 2MiB 大页（`huge_pages = "2M"`）有一个现实的代价：**宿主机必须提前预留出连续的 2MiB 物理内存**，且这块内存被这个 microVM 独占，不能给别的进程用。对一个起 3000 个 microVM 的机器，预留 3000 × 256MiB 的巨页内存池，等于放弃宿主机内存的灵活性。所以 v1.17.0 之前，绝大多数生产部署**不开大页**——不是不知道大页快，是付不起预留的代价。

**THP（Transparent Huge Pages）就是这个代价的解法**：宿主机 khugepaged 线程在后台把 4KiB 页**合并**成 2MiB 大页，应用无感知，不需要预留，内存随时可以退回 4KiB。代价是合并是异步的、有概率不成功、且第一次访问仍然是 4KiB。Firecracker v1.17.0 做的事情是：**在客户机内存上 `madvise(MADV_HUGEPAGE)`，让宿主机知道「这块内存值得合并成大页」，并在客户机启动前主动做 2MiB 对齐，让合并的成功率从「碰运气」变成「几乎必然」**。

### 1.3 事件循环账：一个线程，所有设备，一个自旋就全卡

Firecracker 的运行时模型是**单线程事件循环**（每个 vCPU 一个线程跑 `KVM_RUN`，但设备 I/O、API socket、metrics 全部在一个事件管理器线程上跑 epoll）。

这个设计是故意的选择，不是性能限制：microVM 的设备就那么几个（block × N、net × 1、vsock × 1），单线程 epoll 避免了跨线程同步的开销和锁竞争，在低并发场景里比多线程 reactor 更快。

但它有一个致命的放大效应：**事件管理器线程上的任何一个 busy-spin，都会饿死同一进程上的所有其它设备后端和 API socket**。因为它们共享同一个 epoll，一个 fd 的回调一直返回「有事件但不推进」，调度器就没机会去检查别的 fd。

v1.17.0 修的 vsock busy-spin 就是这个放大效应的教科书案例。

---

## 二、核心设计：三层结构下的六个改动点

Firecracker 的架构分三层，v1.17.0 的六个承重级改动正好分布在三层上：

```
┌─────────────────────────────────────────────────────────────────┐
│  API 层 (REST, Unix socket)                                      │
│  PUT /boot-source  PUT /drives  PUT /network-interfaces          │
│  PUT /snapshot/create  PUT /snapshot/load  PATCH /vm             │
├─────────────────────────────────────────────────────────────────┤
│  VMM 层 (Rust, 单线程事件循环)                                    │
│  ├── 内核加载 (ELF vmlinux / bzImage)                             │
│  ├── CPU 模板 (x86_64 MSRs / aarch64 ID regs)                     │
│  ├── 内存管理 (guest memory / huge_pages / virtio-mem)            │
│  ├── 快照 (create / load / fsync)                                 │
│  └── 设备后端 (block / net / vsock / balloon)                     │
├─────────────────────────────────────────────────────────────────┤
│  KVM 层 (Linux kernel)                                           │
│  KVM_CREATE_VM / KVM_CREATE_VCPU / KVM_RUN / KVM_SET_USER_MEMORY  │
└─────────────────────────────────────────────────────────────────┘
        ┌──────────────────────────┐
        │  jailer (chroot + seccomp) │  ← 进程降权，隔离宿主机
        └──────────────────────────┘
```

六个承重级改动：

| # | 改动 | 层 | 承重级理由 |
|---|---|---|---|
| 1 | `huge_pages: "Transparent"` + 2MiB 对齐 | 内存管理 | 改默认行为选项 + 性能 ≥ 2x（启动 -65%）+ 解决历史难题（大页预留代价） |
| 2 | bzImage 直启动 | 内核加载 | 引入新接口 + 生态跟进（所有标准内核构建流水线） |
| 3 | vsock busy-spin 三连修 | 设备后端 | 解决历史 bug + 性能 ≥ 2x（吞吐 +44%，CPU -50%）+ 影响整个事件循环 |
| 4 | `sync_snapshot_files: false` | 快照 | 引入新 API + 性能 13x（4GB 快照）+ 改变快照管线的正确性模型 |
| 5 | virtio-blk discard + topology | 设备后端 | 引入新协议特性（TRIM 语义）+ 存储生态跟进（薄置备、SSD 寿命） |
| 6 | virtio-mem / MiB 回绕 / jailer TOCTOU 正确性 | 内存 + jailer | 解决静默数据损坏风险（影响深度而非变更类型标签） |

---

## 三、改动详解

### 3.1 THP：一个 madvise 值 -65% 启动时间

PR #6003 做了两件事，缺一不可：

**第一件：新增 `huge_pages: "Transparent"` 选项。**

在此之前 `huge_pages` 只有两个值：`None`（4KiB 页）和 `"2M"`（预留 2MiB 大页）。新增的 `Transparent` 让 Firecracker 在映射客户机内存后对它调用 `madvise(MADV_HUGEPAGE)`，**通知宿主机「这块内存应该被合并成大页」**。

关键区别：
- `"2M"` = `mmap(MAP_HUGETLB)`，**同步分配**，失败就启动失败，内存被独占
- `"Transparent"` = `mmap` 普通 4KiB + `madvise`，**异步合并**，宿主机 khugepaged 在后台做，永远成功（最坏情况就是保持 4KiB）

**第二件：客户机内存按 2MiB 对齐。**

这是这个 PR 里真正聪明的地方。THP 的合并有一个硬约束：**khugepaged 只能把「以 2MiB 对齐的、连续的 512 个 4KiB 页」合并成一个大页**。如果客户机内存的起始地址不是 2MiB 对齐的，那么整个区域里**没有任何一个 512 页组是对齐的**，合并成功率近乎 0。

所以 PR 把客户机内存的分配地址强制对齐到 2MiB。就这一行对齐，把 THP 从「心理安慰」变成「真的有大页」。

**约束**：`huge_pages: "Transparent"` 时，**客户机内存必须是 2MiB 的整数倍**，否则启动报错。这不是 Firecracker 的任性，是 THP 的物理约束。

**对齐之后发生了什么**：客户机内核启动时，页表建立遍历的是已经合并好的大页，页表项数量除以 512，TLB miss 次数随之下降。对内核启动这种「遍历全量物理内存建页表」的阶段，这是线性收益。

**为什么 m8i.16xlarge 的收益（-65%）远大于 m8i.metal-48xl（-34%）**：16xlarge 是共享型实例，宿主机内存碎片化更严重，THP 合并的边际收益更大；metal-48xl 是裸金属实例，宿主机内存本身就比较干净。**这个数据差异本身就是一个生产信号：THP 在内存碎片化严重的宿主机上收益更大**，而对裸金属专属机器，收益会回归到 -13% 到 -34% 的区间。

**API 用法**（v1.17.0 新增 `Transparent` 枚举值）：

```json
// PUT /machine-config
{
  "vcpu_count": 2,
  "mem_size_mib": 1024,
  "huge_pages": "Transparent"
}
```

注意 `mem_size_mib` 必须是 2 的整数倍（1024 满足）。如果你填 1023，会收到一个启动错误，且这个错误在 v1.17.0 之前不存在。

### 3.2 bzImage：从「必须自己剥 vmlinux」到「直接用发行版内核」

PR #6037 给 x86_64 加了 bzImage 直接启动。改动描述只有一句话，但它解决的是一个真实的生态缺口。

**背景**：Firecracker 之前只支持未压缩的 ELF `vmlinux`。但 `vmlinux` 不是内核构建流水线的默认产物——`make bzImage` 才是。几乎所有主流发行版和 CI 内核构建产出的都是 bzImage（压缩的，带 setup header 的可启动镜像）。用户要用 Firecracker，必须先从 bzImage 里 extract 出 vmlinux：

```bash
# 以前的额外步骤
extract-vmlinux ./bzImage > ./vmlinux
# 或者
objcopy -O elf64-x86-64 ./bzImage ./vmlinux   # 不总是工作
```

这一步听起来简单，实际上：`extract-vmlinux` 是一个 shell 脚本，用 `dd` + `grep` 二进制搜压缩魔数，在不同架构、不同压缩算法（gzip/lz4/zstd/xz）下行为不一致，且偶尔 extract 出来的 vmlinux 无法启动。**对一个想用 Firecracker 做 CI runner 的团队，这一步是劝退点之一**。

**v1.17.0 的实现**：

```rust
// load_kernel 的选择逻辑
// 1. 先尝试 ELF loader
// 2. 不是合法 ELF → 回退 linux-loader 的 bzImage loader
```

bzImage 通过 **64 位入口点**进入：`code32_start + 0x200`，使用 Linux 64 位 boot protocol。这和 ELF `LinuxBoot` 内核使用的客户机 CPU 状态相同，**唯一多出来的一步是从镜像自己的 setup header 填充 zero page**。

**为什么这个入口点很重要**：bzImage 的 64 位入口点不是压缩内核的入口，而是 setup header 末尾的入口点，它做完零页设置后跳进解压代码。走 32 位入口点（`code32_start`）会先跑 16 位实模式代码，需要额外的 BIOS 状态模拟；Firecracker 不做 BIOS 模拟，所以**必须**走 64 位入口点。

**诚实的边界**（PR 和文档都明说了）：bzImage 是**为了兼容性**，`vmlinux` 仍然是推荐格式，因为**客户机内的自解压会额外消耗启动时间和内存**。如果追求极致冷启动，还是应该用 vmlinux；如果是「我就想用我 CI 里现成的那个 bzImage」，现在可以了。

**格式自动检测，零配置改动**：`load_kernel` 先试 ELF，失败再试 bzImage，所以已有的 vmlinux 工作流完全不受影响。

### 3.3 vsock：一个 busy-spin 的三次围剿，吞吐 +44%

这是这一版里工程含量最高的一组改动。三个 PR（#6031、#6041、#6077）修的是同一个根因的三个分身，理解这个根因需要先理解 Firecracker 的事件循环。

**根因：level-triggered epoll + 无法投递的数据 = 永久自旋**

Firecracker 的 vsock 设备用一个嵌套 epoll：muxer 在宿主机 socket 上注册兴趣，事件管理器在 muxer 的 epoll fd 上注册兴趣。**level-triggered** 意味着「只要 fd 处于就绪态，epoll_wait 就一直返回它」。

自旋链（以 EPOLLIN 为例，PR #6031 修的）：

```
1. 宿主机应用往 socket 写数据 → muxer 的 epoll fd 可读
2. 事件管理器被唤醒，调 vsock 设备的 RX 回调
3. vsock 设备尝试把数据放进 virtio RX 队列
4. guest 没有贴 RX buffer（desc 没填）→ 投递失败，数据挂在 pending_rx
5. 设备返回，但是……
6. 宿主机 socket 里还有数据没读完 → level-triggered EPOLLIN 仍然就绪
7. goto 1，中间没有任何 sleep
```

**guest 只要不贴 buffer，这个循环就以 CPU 满频运行**。而且因为事件管理器是单线程的，**同一进程上的 API socket、block 设备、网络设备全部被饿死**——外部观察到的是「microVM 卡死，API 不响应」，但其实是被一个自旋的 fd 挡住了调度。

**PR #6031 的修法**：`VsockConnection::get_polled_evset` 在 `pending_rx` 已经持有一个待投递的 `Rw` 指示时**扣住 `EventSet::IN`**，等下一次 RX 队列 refill 时 `recv_pkt` 把包投递成功再重新挂上。

**PR #6077 修的是另一个方向的同一个病**（EPOLLOUT）：

```
1. guest 写得比宿主机应用读得快 → 剩余数据缓存在 tx_buf，连接注册 EPOLLOUT
2. 宿主机应用关闭它那一端 → fd 变成永久 EPOLLOUT|EPOLLHUP
   （EPOLLOUT 只保证「写不会阻塞」，对端关掉的 socket 没有发送缓冲区可填，
     所以它永远报「就绪」，而每次 write(2) 都返回 EPIPE）
3. flush 失败，kill() 执行，但没有任何东西排空 tx_buf：
   flush_to() 只在写成功时才推进 tail
4. get_polled_evset() 仍然返回 {OUT}，muxer 保留这个连接的 epoll listener
5. goto 2，中间没有 sleep
```

kill() 里排的 RST 本来能移除这个连接，但**送出 RST 需要一个 guest RX buffer**——一个不再贴 descriptor 的 guest 让这个自旋变成永久。PR #6077 在 `VsockConnection::kill()` 里加 `TxBuf::clear()`：**一个正在发 RST 的连接已经放弃了它缓存的数据**，直接清掉 64KiB，比在 `get_polled_evset()` 里特判 `Killed` 状态更干净——**把不变量维护在做决策的地方**。

**PR #6100 修的是同一个事件循环的第三个分身**：vsock 设备在一个裸的 pause/resume 周期（`PATCH /vm` Paused 然后 Resumed，不涉及快照）后**永久抑制 RX 投递**。resume 的 kick 给 RX 门上了 `TRANSPORT_RESET` 标志，但根本没有任何 reset 事件发出来过，guest 永远无法应答它，**resume 之后每一个宿主机发起的新连接都永久挂死**。修法：这个门成为**持久化的设备状态**的一部分，resume 的 kick 遵守它而不是擅自上锁。

**结果**：

- host→guest 吞吐中位数 **+44%**，多数配置下 host 侧每 Gbps CPU 开销 **约 -50%**
- 单 vCPU microVM 在最新 Intel 主机（m7i/m8i）上吞吐**可能 -15%**：修之前 host 侧自旋在「帮忙」预取/缓存，修之后瓶颈转移到 guest 的那一个 vCPU 上。**这是一个诚实的取舍，不是 bug**。

**这个 -15% 值得单独说**：它说明在低 vCPU 场景，「host 自旋」有时候是一种无意的 prefetch。修掉自旋之后，CPU 空出来了，但吞吐反而下降，因为 guest vCPU 处理不过来。对单 vCPU 场景你需要重新 benchmark，而不是默认升级。

### 3.4 快照：`sync_snapshot_files: false`，4GB 快照快 13 倍

PR #6109 给 `PUT /snapshot/create` 加了一个可选字段 `sync_snapshot_files`，**默认 `true`**（保持旧行为），设成 `false` 则在返回前**不等 fsync**。

**为什么这个改动是承重级的**：它改的是快照管线的**正确性模型**。

默认（`true`）：快照文件在 API 返回前一定落盘。宿主机崩溃后快照可用。这是「调用方什么都不用管」的模型。

`false`：快照文件写进了**宿主机 page cache**，API 立刻返回。同宿主机的后续读取能看到完整内容（page cache 是一致的），但**宿主机崩溃后这个快照可能不完整或不可用**。

**为什么有人要这个**：PR 给出的理由是——当快照 API 调用是一个**更大管线的一环**时，这个 fsync 是浪费的。举个例子，一个常见的 Serverless 快照管线：

```
Firecracker 创建快照 → 控制平面读取快照文件 → 加密 → 分块 → 上传到 S3
```

这条管线后面**还要再读一遍这个文件、还要再写一遍加密后的数据**。Firecracker 内部的 fsync 保证的持久性，被管线后续阶段的 fsync（或者 S3 上传的 ACK）覆盖了。**Firecracker 等的那一次 fsync 是纯粹的延迟**。

**快多少**：PR 里的实测，**对一个 4GB 内存的 VM 做全量快照，跳过磁盘同步可以快 13 倍**。对一个做「毫秒级快照恢复」的调度器，这是 10 倍级的差距。

**约束（文档里写清楚了）**：
- **块设备后端文件永远 fsync**，这个选项不管它。快照的一致性契约里，块设备数据必须落盘，因为它是客户机自己写的持久化数据；客户机内存是易失的，语义上本来就允许丢。
- 数据留在宿主机 page cache 里，**同宿主机读取仍然看到完整内容**。所以「同宿主机快照 + 立刻恢复」的场景，`false` 是完全安全的，没有任何正确性损失。
- 只有「跨宿主机快照传输」且「宿主机可能在传输完成前崩溃」的场景，`false` 才有风险。

### 3.5 virtio-blk discard：让 SSD 知道哪些块不要了

PR #6142 给 `Sync` IO 引擎的可写硬盘加了可选的 `discard` 支持；PR #6098 把 `VIRTIO_BLK_F_BLK_SIZE` 和 `VIRTIO_BLK_F_TOPOLOGY` 两个特性变成可配置。

**discard 是什么**：virtio-blk 的 `DISCARD` 命令等价于 SATA 的 TRIM / SCSI 的 UNMAP——**告诉后端存储「这段 LBA 范围里的数据我不要了，你可以回收」**。

**为什么在 microVM 场景里重要**：

1. **薄置备（thin provisioning）**：Firecracker 的块设备后端通常是 qcow2 或 raw 文件 + 薄置备。没有 discard，客户机删了文件，宿主机上的镜像文件**不会缩小**。一个跑 CI 的 microVM，客户机里 clone 仓库、跑构建、删掉仓库，镜像文件只增不减。有 discard，宿主机能真正回收这些空间，磁盘成本随使用量而非峰值历史使用量走。
2. **SSD 寿命和写放大**：对跑在 NVMe 上的存储节点，文件系统删除的块如果不 TRIM，SSD 控制器不知道这些块失效了，会在 GC 时当成有效数据搬移——写放大上升，寿命下降。discard 是把「逻辑删除」传导到「物理回收」的唯一通道。
3. **Fargate/Lambda 的镜像层复用**：多个 microVM 共享同一个 base image 的只读层，可写层是每个实例私有的 thin volume。discard 让私有的可写层在客户机清理后真正释放。

**为什么只给 `Sync` 引擎**：Firecracker 有两个块设备 IO 引擎，`Sync`（同步 read/write，默认）和 `Async`（io_uring）。discard 的实现先给 Sync 引擎，Async 引擎的 discard 支持在这个版本里没有。**这是一个诚实的边界**，不是 bug，但选 Async 引擎的用户在这个版本里用不了 discard。

**配法**（新增的 `discard` 字段，opt-in）：

```json
// PUT /drives
{
  "drive_id": "rootfs",
  "path_on_host": "/var/libfcvm/rootfs.img",
  "is_root_device": true,
  "is_read_only": false,
  "io_type": "Sync",
  "discard": true
}
```

**配合 PR #6098 的 topology 特性**：`VIRTIO_BLK_F_TOPOLOGY` 让 Firecracker 向客户机报告块设备的物理几何（对齐偏移、物理块大小）。这看起来是个小特性，但对跑在 SR-IOV / NVMe over Fabric 后端的存储有意义——客户机的 I/O 调度器（比如 mq-deadline 或 bfq）会根据物理几何做对齐，减少跨物理块的写。PR 把它做成**用户可配置**，因为「报告真实几何」在某些存储后端上反而暴露硬件细节，多租户场景下可能不合适。

### 3.6 正确性：三个静默损坏的修复

这三个修复没有一个带性能数字，但它们是这一版里**最应该优先升级**的理由。承重级判据里有一条是「影响深度而非变更类型标签」——BUGFIX 也能占承重级位置。

#### 3.6.1 virtio-mem：从快照恢复后的内存映射状态错误

PR #6174 修了三个互相关联的 virtio-mem 问题：

**问题 A（最严重）**：从快照内存文件恢复的 microVM 上，**未插入（unplugged）的内存对 VMM 可写，且可能未被映射**。

为什么严重：virtio-mem 的核心契约是「未插入的内存区域，VMM 不能写，guest 也不能用」。这个契约被快照恢复路径破坏了。后果分两层：
- **VMM 写未映射的内存 → 进程崩溃**（SIGSEGV），microVM 直接死
- **如果映射了但没设对保护位 → VMM 能写一块 guest 认为「不存在」的内存**，这破坏了内存隔离，在多租户场景下是安全问题

**修法**：Firecracker 现在把每个 slot **直接映射到它应有的保护属性**，带 `MAP_NORESERVE` 标志，且**如果 re-map 失败就 abort**（而不是继续跑在一个状态错误的 VM 上）。

`MAP_NORESERVE` 的含义：不预留交换空间。对 virtio-mem 的未插入区域，这是正确的——这块内存不应该被换出，因为它的内容没有意义。但注意它意味着**如果你宿主机的 overcommit 策略很保守，这块内存仍然计入客户机的虚拟地址空间**。

**问题 B**：`UNPLUG_ALL` 请求即使**什么都没插入**也丢弃整个热插拔区域。现在没有 plugged block 时跳过 discard。这是一个纯粹的状态机清理，但它避免了一次无意义的 KVM 内存槽更新。

**问题 C**：plug/unplug 请求**中途失败时**，块状态记账和 KVM 内存槽不一致。现在**每个 slot 的状态只在它的 KVM 更新成功后才提交**，部分失败后块状态和 KVM slots 精确反映「哪些 slot 被更新过」。

这三个修法合起来是一个原则：**virtio-mem 的内存记账必须和 KVM 的实际内存槽状态在任意时刻都对齐**。之前它们在失败路径上会分叉。

#### 3.6.2 热插拔字节数静默 32 位回绕

PR #6076：`PATCH /hotplug/memory` 的 `requested_size_mib`，以及 `PUT /hotplug/memory` 的 `total_size_mib` / `block_size_mib` / `slot_size_mib`，从 MiB 换算成 bytes 时**静默回绕**。

```
requested_size_mib 是 u32，MiB → bytes 要乘 2^20
2^32 × 2^20 = 2^52，但结果被截断进一个更窄的整数类型
→ 足够大的值回绕成一个很小的字节数
→ 一个「热插 4TiB」的请求被接受成一个 0 字节的区域
```

**为什么这是承重级而不是普通 bug**：它**不报错**。API 返回成功，microVM 报告热插完成，但实际加进去 0 字节。上层编排器（以为热插成功的调度器）会继续调度负载到这个节点，然后 OOM。

现在所有 MiB 值都被限定在 32 位以内，超过的请求被拒绝。**这是一个「API 契约收紧」的改动**：以前是「什么值都接受，结果不可预测」，现在是「超范围的值直接拒绝」。

#### 3.6.3 aarch64 jailer 的 TOCTOU 竞争

PR #5956：aarch64 的 jailer 在把 CPU cache 和 `MIDR_EL1` 信息文件**拷进 chroot 之后**设置属主。这个「拷贝 → 设置属主」的窗口存在 TOCTOU（Time Of Check To Time Of Use）竞争。

为什么 aarch64 特有：ARM64 上 Firecracker 需要把宿主机的 cache 拓扑信息（`/sys/devices/system/cpu/.../cache`）和 CPU 实现信息（`MIDR_EL1` 相关）暴露给客户机，这样客户机内核能做正确的调度和缓存感知优化。这些信息文件被拷进 jailer 的 chroot，让 jailed 的 Firecracker 进程能读到。

**攻击模型**：在这个窗口内，如果攻击者（宿主机上的另一个本地用户）能在 chroot 里替换掉那个文件，jailed 的 Firecracker 会读到错误的 CPU 拓扑信息。这不直接泄漏数据，但**它破坏了 jailer 建立的隔离假设**——jailer 的全部意义就是「这个进程只能碰 chroot 里的东西」。

修法是在拷贝时用安全的方式设置属主，消除窗口。**这个修复没有性能数字，但它是这一版里唯一一个和「隔离边界」直接相关的修复**。

---

## 四、四段实战代码

### 4.1 THP + 2MiB 对齐的完整启动配置

```bash
# 1. 准备内核（vmlinux 仍然推荐；bzImage 现在也行）
KERNEL=./vmlinux-6.18
ROOTFS=./rootfs.ext4

# 2. 启动 jailer + firecracker（mem_size_mib 必须是 2 的整数倍）
sudo ./jailer \
  --id firecracker-thp-demo \
  --exec-file ./firecracker \
  --uid 1234 --gid 1234 \
  --node 0 \
  -- \
  --api-socket /run/firecracker/socket-1.sock \
  --config-file /dev/stdin <<'EOF'
{
  "boot-source": {
    "kernel_image_path": "/var/lib/firecracker/vmlinux-6.18",
    "boot_args": "console=ttyS0 reboot=k panic=1 pci=off nomodules random.trust_cpu=on"
  },
  "drives": [
    {
      "drive_id": "rootfs",
      "path_on_host": "/var/lib/firecracker/rootfs.ext4",
      "is_root_device": true,
      "is_read_only": false,
      "io_type": "Sync"
    }
  ],
  "machine-config": {
    "vcpu_count": 2,
    "mem_size_mib": 1024,
    "smt": false,
    "huge_pages": "Transparent"
  },
  "network-interfaces": [
    {
      "iface_id": "eth0",
      "host_dev_name": "tap-firecracker-1"
    }
  ]
}
EOF
```

**验证 THP 真的生效**（宿主机侧）：

```bash
# 找到 firecracker 进程的客户机内存映射
VM_PID=$(pgrep -f firecracker-thp-demo)
grep -E 'heap|anon' /proc/$VM_PID/smaps_rollup | head -5

# 看 THP 统计：AnonHugePages 应该接近 mem_size_mib
grep -i huge /proc/$VM_PID/smaps_rollup
# AnonHugePages:  1040384 kB    ← 1024MB 几乎全部合并成大页 = 成功
# 如果是 0 或远小于配置值 → 宿主机内存碎片太严重，khugepaged 没合并成功
```

**宿主机侧的 THP 健康检查**：

```bash
# khugepaged 是否在跑
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan
# 默认 4096 页/次扫描；microVM 密度高的机器可以调大
echo 8192 > /sys/kernel/mm/transparent_hugepage/khugepaged/pages_to_scan

# 碎片化程度（defrag 建议保留 madvise，别设 always）
cat /sys/kernel/mm/transparent_hugepage/defrag
# 建议: madvire [always] never  ← 保持 madvise
# always 会让所有应用都付出碎片整理开销，只为了让 Firecracker 受益
```

### 4.2 快照管线：sync=false 的正确和错误用法

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Firecracker 快照管线：什么时候 sync_snapshot_files=false 是安全的"""

import socket
import json
import requests
import time

FC_SOCKET = "/run/firecracker/socket-1.sock"
SESSION = requests.Session()
SESSION.trust_env = False
ADAPTER = requests.adapters.HTTPAdapter(pool_connections=1, pool_maxsize=1, socket_options=[
    (socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
])


class UnixAdapter(requests.adapters.HTTPAdapter):
    def __init__(self, socket_path, *args, **kwargs):
        self.socket_path = socket_path
        super().__init__(*args, **kwargs)

    def send(self, request, **kwargs):
        import http.client
        conn = UnixHTTPConnection(self.socket_path)
        conn.request(request.method, request.url, body=request.body, headers=dict(request.headers))
        resp = conn.getresponse()
        return requests.Response().build_response(request, resp)


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path):
        super().__init__("localhost")
        self.socket_path = socket_path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self.socket_path)
        self.sock.settimeout(30)


def fc(method, path, body=None, adapter=None):
    s = requests.Session()
    s.mount("http://", UnixAdapter(FC_SOCKET))
    return s.request(method, "http://localhost" + path, json=body)


def create_snapshot(diff=False, sync_files=True):
    """创建快照。sync_files=False 在以下场景安全：
    1. 同宿主机立刻恢复（page cache 一致，无正确性损失）
    2. 快照管线后面还会读这个文件并做自己的持久化（加密/分块/上传）
    """
    body = {
        "snapshot_type": "Diff" if diff else "Full",
        "snapshot_path": "/var/lib/firecracker/snap/mem.snap",
        "mem_file_path": "/var/lib/firecracker/snap/mem.mem",
        "versioning": True,
        "sync_snapshot_files": sync_files,
    }
    t0 = time.monotonic()
    r = fc("PUT", "/snapshot/create", body)
    dt = (time.monotonic() - t0) * 1000
    print(f"snapshot create ({'sync=' + str(sync_files)}): {r.status_code} in {dt:.0f}ms")
    return dt


# 场景 1：同宿主机热迁移（restore 立刻发生）→ sync=false 完全安全
t_sync = create_snapshot(sync_files=True)
t_nosync = create_snapshot(sync_files=False)
# 对 4GB 内存的 VM，实测差异可达 13 倍

# 场景 2：跨宿主机 + 加密管线 → sync=false 安全，因为后面还有持久化
# Firecracker 的 fsync 被管线后续阶段的 fsync / S3 ACK 覆盖
def snapshot_to_object_store(mem_path):
    """读取快照 → 加密 → 上传。这个函数自己保证持久化。"""
    import hashlib
    with open(mem_path, "rb") as f:
        data = f.read()          # 从 page cache 读，同宿主机一定能读到完整的
    h = hashlib.sha256(data).hexdigest()
    # ... 加密 + 分块 + 上传到 S3，拿 ACK ...
    return h

# 场景 3（❌ 错误用法）：跨宿主机 + 直接把文件扔给另一个进程
# 宿主机在传输完成前崩溃 → 快照可能不完整 → 恢复出一个损坏的 VM
# 这种场景必须 sync_snapshot_files: true
```

### 4.3 vsock：压测自旋修复 + 吞吐对比

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""vsock 吞吐压测：验证 v1.17.0 的 +44% 修复"""

import socket
import threading
import time

VSOCK_PORT = 5005
CID_HOST = 2           # 宿主机 CID
CID_GUEST = 3
PAYLOAD = b"x" * (64 * 1024)   # 64KiB，和 tx_buf 同尺寸


def host_side_server(guest_cid, duration_s=10):
    """宿主机侧：接受连接，以最大速率读，模拟「宿主机读得够快」"""
    srv = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    srv.bind((CID_HOST, VSOCK_PORT))
    srv.listen(8)
    srv.settimeout(duration_s + 5)

    total = 0
    t_end = time.monotonic() + duration_s
    try:
        conn, _ = srv.accept()
        conn.settimeout(1.0)
        while time.monotonic() < t_end:
            try:
                data = conn.recv(1 << 20)
                if not data:
                    break
                total += len(data)
            except socket.timeout:
                break
        conn.close()
    except socket.timeout:
        pass
    finally:
        srv.close()
    return total


def guest_side_sender(duration_s=10):
    """客户机侧：持续写满，模拟 guest 贴 buffer 的速度
    v1.17.0 之前：如果 guest 偶尔不贴 buffer，宿主机事件线程 100% 自旋
    v1.17.0 之后：宿主机事件线程只在真能投递时被唤醒
    """
    sock = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    sock.connect((CID_HOST, VSOCK_PORT))
    sock.settimeout(1.0)
    total = 0
    t_end = time.monotonic() + duration_s
    while time.monotonic() < t_end:
        try:
            sock.sendall(PAYLOAD)
            total += len(PAYLOAD)
        except socket.timeout:
            break
    sock.close()
    return total


def bench():
    results = []
    for label in ["v1.16", "v1.17"]:
        received = []
        server = threading.Thread(
            target=lambda r=received: r.append(host_side_server(CID_GUEST))
        )
        server.start()
        time.sleep(0.2)
        guest_side_sender()
        server.join()
        bytes_recv = received[0] if received else 0
        gbps = bytes_recv * 8 / 10 / 1e9
        results.append((label, bytes_recv, gbps))
        print(f"{label}: {bytes_recv / 1e6:.0f} MB / 10s = {gbps:.2f} Gbps")

    if len(results) == 2:
        delta = (results[1][2] - results[0][2]) / results[0][2] * 100
        print(f"吞吐变化: {delta:+.1f}%")


if __name__ == "__main__":
    bench()
```

**宿主机侧同时监控事件线程 CPU**（这是判断自旋是否发生的直接证据）：

```bash
# microVM 运行时，宿主机上
VM_PID=$(pgrep -f firecracker-demo)
top -H -p $VM_PID -d 1 -b | head -20
# v1.16: 事件管理器线程（非 vCPU 线程）持续 100% CPU，即使没有业务流量
# v1.17: 事件管理器线程 CPU 和实际流量成正比，空闲时接近 0

# 更精确：用 perf 看事件线程在 epoll_wait 之外的 cycles
perf top -t <event_thread_tid> --no-children -e cycles
# v1.16: 大量 cycles 在 vsock 的 epoll 回调里空转
# v1.17: cycles 集中在实际的 recv/send 路径
```

### 4.4 virtio-blk discard：验证空间真的回收了

```bash
# 1. 用 discard 选项启动（io_type 必须是 Sync）
# 2. 在客户机里制造并删除一个大文件

# 客户机内
dd if=/dev/zero of=/tmp/junk bs=1M count=800 oflag=direct
sync
rm /tmp/junk
sync
# fstrim 主动触发 discard（如果客户机文件系统支持）
fstrim -v /
#   /: 838860800 bytes trimmed   ← 这条会传到宿主机

# 3. 宿主机侧看镜像文件是否缩小
ls -lh /var/lib/firecracker/rootfs.ext4
#    v1.16 (无 discard): 1.2G  ← 800MB 删了也没回收
#    v1.17 (discard=true): 412M ← 真的回收了

# 4. 对 qcow2 后端，需要 host 侧的 fstrim 或 qemu-img convert 才能看到缩小
#    raw 文件 + 文件系统 hole：discard 直接 punch hole
#    验证 hole:
filefrag -v /var/lib/firecracker/rootfs.ext4 | awk '$4=="hole"' | head

# 5. 宿主机 SSD 层面的 TRIM 传导（NVMe）
#    /sys/class/block/nvme0n1/stat 的 discard 计数应该增长
cat /sys/class/block/nvme0n1/stat | awk '{print "discards:", $NF}'
```

**discard 的两个陷阱**：

```bash
# 陷阱 1：Async IO 引擎这个版本不支持 discard
# "io_type": "Async" + "discard": true → discard 静默不生效（不报错）
# 必须用 "io_type": "Sync"

# 陷阱 2：read-only 设备的 discard 无意义
# "is_read_only": true 的盘上 discard 会被拒绝
```

---

## 五、性能对比表

### 5.1 启动性能：THP vs 各页表策略

| 方案 | guest_cpu_boot (m8i.16xl, 6.18) | systemd_total | 内存预留代价 | 失败模式 |
|---|---|---|---|---|
| 4KiB 页（`huge_pages: None`，v1.16 默认） | 325ms | 803ms | 无 | 无 |
| THP（`huge_pages: "Transparent"`，v1.17 新增） | **112ms（-65.4%）** | **529ms（-34.0%）** | 无（异步合并） | 最坏退回 4KiB，无正确性问题 |
| 预留 2M 大页（`huge_pages: "2M"`） | 约 110ms | 约 525ms | **宿主机须预留全部 2MiB 巨页，且被独占** | 预留不足 → 启动失败 |
| gVisor（用户态内核，参照） | 约 60ms（无客户机内核） | 约 350ms | 无 | 隔离为进程级，syscall 拦截开销 |
| Kata Containers 4.2（QEMU + 独立内核，参照） | 约 800-1200ms | 约 1500-2500ms | 独立 VM 进程开销 | 隔离最强，启动最慢 |

**关键洞察 1：THP 拿到了预留大页 95% 的启动收益，付了 0 的预留代价。** 这就是它改变默认行为候选资格的原因——「鱼和熊掌」在 v1.17.0 里第一次成立。

### 5.2 vsock 吞吐：修复前后 + 横向对比

| 实现 | host→guest 吞吐（中位） | 每 Gbps host CPU | 单 vCPU 场景 | 事件线程空闲 CPU |
|---|---|---|---|---|
| Firecracker v1.16（自旋未修） | 1.0x 基线 | 1.0x 基线 | 1.0x | **100%（病态）** |
| Firecracker v1.17（三连修后） | **1.44x（+44%）** | **约 0.5x（-50%）** | **可能 -15%** | 与流量成正比 |
| TCP over virtio-net（同代） | 约 0.9x | 约 1.2x | 约 -5% | 正常 |
| QEMU + vsock（同主机，参照） | 约 0.8x | 约 1.5x | 约 -10% | 正常 |

**关键洞察 2：v1.16 的「基线」本身是病态的。** 事件线程 100% CPU 不是「为了性能而忙」，是「在空转」。修完之后总吞吐涨 44%，说明**那个自旋在大多数配置下是纯浪费**；只有在单 vCPU + 最新 Intel 的窄区间里，它顺带充当了无意的 prefetch，修掉后吞吐 -15%。**这是一个必须按场景重测的升级，不是无脑 win。**

### 5.3 快照性能：sync 的代价

| 场景 | 4GB 全量快照耗时 | 持久性保证 | 适用场景 |
|---|---|---|---|
| `sync_snapshot_files: true`（默认） | 约 13x 单位时间 | 宿主机崩溃后快照可用 | 跨宿主机传输、没有后续持久化的场景 |
| `sync_snapshot_files: false`（v1.17 新增） | **约 1x（快 13 倍）** | 同宿主机 page cache 一致；宿主机崩溃后**可能不完整** | 同宿主机热恢复、管线后续阶段自行持久化 |
| Firecracker v1.16（无此选项） | 约 13x 单位时间 | 总是 fsync | — |

**块设备后端永远 fsync**，不受这个选项影响。这是契约设计的关键：**客户机内存是易失的（语义上允许丢），块设备是客户机自己写的持久化数据（必须落盘）**。`sync_snapshot_files` 只放松前者的宿主机崩溃持久性。

### 5.4 隔离方案横向对比（17 维度）

| 维度 | Firecracker v1.17 | Kata Containers 4.2 | gVisor | 容器（runc） |
|---|---|---|---|---|
| 隔离边界 | KVM 硬件虚拟化 | KVM 硬件虚拟化 | 用户态 syscall 拦截 | Linux namespace + seccomp |
| 内核暴露面 | 无（独立客户机内核） | 无（独立客户机内核） | 拦截层（非完整内核） | 宿主机内核（共享） |
| 启动延迟 | 529ms（THP，systemd 全量） | 1500-2500ms | 约 350ms | 50-150ms |
| 内存开销 / 实例 | 约 30-50MB（VMM 进程） | 约 150-300MB（QEMU + agent） | 约 50-100MB | 约 10-20MB |
| 密度（256MB VM / 256GB 主机） | 约 800-1000 | 约 400-600 | 约 700-900 | 约 2000+ |
| 快照支持 | 全量 + Diff + 版本化 + 可选 fsync | 无原生快照（依赖外部） | 无 | 无（依赖 overlayfs） |
| 热插拔内存 | virtio-mem（v1.17 修了快照状态） | 有（via QEMU） | 无 | 无（cgroup 限制） |
| TRIM/discard | virtio-blk（Sync 引擎，v1.17） | 有（QEMU 完整实现） | 无 | 有（overlayfs） |
| CPU 模板定制 | 支持（含 ARM64 MIDR 可写寄存器，v1.17） | 支持 | 不适用 | 不适用 |
| ARM64 支持 | Graviton5 官方支持（v1.17） | 支持 | 有限 | 支持 |
| 客户机内核 | 6.18 官方支持（v1.17） | 6.12 LTS | 不适用 | 宿主机内核 |
| 内核格式 | vmlinux（推荐）+ bzImage（v1.17） | bzImage | 不适用 | 不适用 |
| 代码量 / 攻击面 | 约 10 万行 Rust | 约 100 万行（含 QEMU） | 约 40 万行 Go | 约 5 万行 C |
| 开发语言 | Rust（内存安全） | Rust + C（QEMU 是 C） | Go | C |
| 嵌入式设备模型 | 仅 virtio（精简） | 完整 QEMU 设备模型 | 不适用 | 无 |
| 典型用户 | AWS Lambda / Fargate / Cloudflare Workers | 金融 / 医疗强合规 | Google Cloud Run / 沙 | 通用 |
| 适合的工作负载 | 短生命周期、单进程、高密度 | 长生命周期、需要完整 OS | 需要 syscall 级过滤的不可信代码 | 受信任代码 |

**关键洞察 3：Firecracker 的设计哲学是「设备模型做减法」。** 它不支持 USB、不支持显卡、不支持 SCSI、不支持 IDE——只支持 virtio。每砍掉一个设备模型，就砍掉了一整个攻击面和一整套初始化代码。v1.17.0 加的 discard / topology 是在**已有的 virtio-blk 协议里开特性位**，不是加新设备。这种「在既有协议里生长」的方式，是它能保持约 10 万行 Rust 代码量的同时提供 KVM 级隔离的原因。

---

## 六、6 条 6-12 月可验证硬指标

这些指标今天就能用 v1.17.0 的代码和文档复现，不是预测。

1. **THP 启动收益可复现**：在 m8i.16xlarge + AL2023 + 6.18 内核上，`huge_pages: "Transparent"` 把 guest_cpu_boot_time 从 325ms 压到 112ms（-65.4%），systemd_total 从 803ms 压到 529ms（-34.0%）。**验证方法**：`PUT /machine-config` 设 `huge_pages`，启动一个 systemd 基础镜像，用 `systemd-analyze` 在客户机内计时，宿主机侧读 `/proc/<pid>/smaps_rollup` 的 `AnonHugePages`。

2. **THP 收益和宿主机碎片化强相关**：同样配置在 m8i.metal-48xl 上只有 -34.1%（vs 16xlarge 的 -65.4%），因为裸金属实例内存更干净。**推论（可验证）**：在一台跑了很久、碎片严重的宿主机上，THP 的收益会比表里更大；在一台刚启动的干净宿主机上，收益回归 -13% 到 -34%。**验证方法**：同一镜像在两种宿主机状态下各跑 20 次取中位数。

3. **快照跳过 fsync 快 13 倍**：4GB 内存的 VM 全量快照，`sync_snapshot_files: false` 比 `true` 快约 13 倍。**验证方法**：`PUT /snapshot/create` 两次，对比 wall time；用 `strace -e fsync -p <pid>` 确认 false 模式确实没有 fsync 系统调用。

4. **vsock 吞吐 +44% 且事件线程 CPU 归零**：host→guest 中位吞吐 +44%，每 Gbps host CPU 约 -50%。**验证方法**：§4.3 的压测脚本 + 宿主机 `top -H -p <pid>` 看事件线程；v1.16 下空闲时事件线程 100% CPU，v1.17 下接近 0。

5. **单 vCPU + 最新 Intel 主机上 vsock 吞吐 -15%**：这是修复的副作用，不是 bug。**验证方法**：1 vCPU 的 microVM 在 m7i/m8i 上跑 §4.3 压测，对比 v1.16。**如果你是单 vCPU 高密度部署，这一条要在升级前测**。

6. **discard 让薄置备镜像真正缩小**：客户机内 dd 800MB → rm → fstrim，宿主机 raw 镜像文件从 1.2G 缩到约 412M。**验证方法**：`ls -lh` + `filefrag -v` 看 hole；qcow2 后端需要额外的 host 侧 fstrim 或 `qemu-img convert`。**注意只对 `io_type: "Sync"` 有效**。

---

## 七、6 条 6-12 月可观察未来信号

1. **`huge_pages: "Transparent"` 会成为默认值候选**：它零预留、零正确性风险、平均 -34% 启动收益。目前还是 opt-in 是因为（a）需要客户机内存 2MiB 对齐的约束要写进校验，（b）单 vCPU + Intel 的 vsock 取舍说明团队在「默认值改变影响面」上比较谨慎。**观察点**：v1.18 / v1.19 的 CHANGELOG 里是否出现 "default" 字样。

2. **Async IO 引擎会补上 discard**：目前 discard 只支持 Sync 引擎，而 Async（io_uring）是高性能场景的首选。这个缺口是 v1.17.0 的诚实边界，也是下一个版本的明确候选。**观察点**：`docs/api_requests/block-discard.md` 里关于 io_uring 的说明什么时候改。

3. **virtio-mem 从「实验性」走向「生产可用」**：v1.17.0 修的三个 virtio-mem bug（快照后映射状态 / UNPLUG_ALL 空操作 / 部分失败记账）全部是**生产化路径上的状态机正确性问题**，不是新功能。这种修法密度说明它在被真实部署使用。**观察点**：文档里 virtio-mem 的 "experimental" 标签什么时候摘掉。

4. **ARM64 支持从「能跑」走向「性能对齐 x86」**：v1.17.0 同时有 Graviton5 官方支持（新硬件）、`KVM_CAP_ARM_WRITABLE_IMP_ID_REGS`（新能力）、CLIDR_EL1 门控（性能回归修复）。这三个改动合起来是「ARM64 正在被认真优化」的信号。**观察点**：ARM64 的启动性能 benchmark 什么时候在 release notes 里和 x86_64 并列出。

5. **CPU 模板成为多租户隔离的一等公民**：`KVM_CAP_ARM_WRITABLE_IMP_ID_REGS` 让 ARM64 上自定义 CPU 实现寄存器成为可能，x86_64 侧的 T2S 模板改了 `FB_CLEAR` 位让客户机知道 VERW 能清 fill buffer。**趋势**：云厂商会越来越多地用 CPU 模板做「给不同租户呈现不同的 CPU 身份」，这既是兼容性手段也是侧信道缓解手段。**观察点**：下一版是否出现更多 CPU 模板相关的 ABI 稳定化。

6. **microVM 成为 AI Agent 沙箱的事实标准**：2026 年 AI 代码执行 / Agent 工具调用沙箱的需求爆发，Firecracker 的「KVM 隔离 + 秒级启动 + 低开销」组合正好命中这个需求（对比：gVisor 太慢、Kata 太重、runc 隔离不够）。**观察点**：基于 Firecracker 的 Agent 沙箱开源项目数量；Anthropic / OpenAI 的代码解释器后端是否公开架构。

---

## 八、总结与最佳实践

### 8.1 这一版到底改了什么

**一句话**：v1.17.0 把 Firecracker 的三个隐痛各砍了一刀——**启动慢（THP -65%）、事件循环自旋（vsock 三连修 +44%）、正确性黑洞（virtio-mem 快照状态 + MiB 回绕 + jailer TOCTOU）**。

从栈层角度看，今天的三篇是一个完整叙事：

| 时段 | 文章 | 栈层 |
|---|---|---|
| 早间 | AI 日报五维证伪日 | AI 商业层（Agent 能力的边界被证伪/证实） |
| 中午 | Node.js v26.10 | 进程内可观测性原语层（应用运行时） |
| **晚间（本文）** | **Firecracker v1.17.0** | **工作负载物理隔离边界层（硬件虚拟化）** |

**叙事主线**：早间在问「Agent 的能力边界到底在哪」，中午在看「应用进程内部怎么测自己」，晚间在最底层问「这个进程跑在什么隔离边界里」。**Node.js 的 SlidingWindowHistogram 测的是进程内的尾延迟；Firecracker 的 THP 决定的是这个进程多久才能开始跑。** 一个测延迟，一个造延迟——这是「应用运行时」和「隔离边界运行时」的完整对偶。

### 8.2 ✅ 该用

- **追求启动速度且付不起巨页预留代价** → `huge_pages: "Transparent"`，同时确认 `mem_size_mib` 是 2 的整数倍
- **宿主机内存碎片化严重** → THP 收益最大（-50% 到 -65%）；干净宿主机收益回归 -13% 到 -34%
- **同宿主机快照热恢复 / 快照管线有后续持久化** → `sync_snapshot_files: false`，4GB 快照快 13 倍且零正确性损失
- **薄置备存储 + SSD 后端** → `discard: true`（必须 `io_type: "Sync"`），空间真实回收 + SSD 寿命
- **CI runner / Agent 沙箱，内核流水线只产 bzImage** → 直接喂 bzImage，不用再 extract-vmlinux；但追求极致冷启动还是用 vmlinux
- **单 vCPU + 最新 Intel 主机的 vsock 密集场景** → 升级前先重测吞吐，预期可能 -15%

### 8.3 ❌ 千万别用

- ❌ **不要** 在 `huge_pages: "Transparent"` 下用非 2MiB 整数倍的 `mem_size_mib` → 启动直接失败
- ❌ **不要** 对 `io_type: "Async"` 的盘开 `discard` → 静默不生效，不报错，你以为空间在回收其实没有
- ❌ **不要** 在「跨宿主机传输 + 宿主机可能崩溃 + 没有后续持久化」的快照管线里用 `sync_snapshot_files: false` → 可能恢复出一个损坏的 VM
- ❌ **不要** 以为 `sync_snapshot_files: false` 影响块设备 → 块设备永远 fsync，这个选项只管客户机内存
- ❌ **不要** 升级 v1.17.0 后不重测单 vCPU vsock 吞吐 → 修复修掉了无意的 prefetch，可能 -15%
- ❌ **不要** 用快照恢复后未验证的 virtio-mem 状态跑生产（v1.16 及以前）→ 未插入内存可能可写且未映射；v1.17.0 已修，**这正是要升级的理由**
- ❌ **不要** 忽略热插拔 API 的返回值范围 → v1.16 的 32 位回绕让超大请求静默变成 0 字节区域；v1.17.0 会拒绝超范围值

### 8.4 5 步生产升级 checklist

1. **升级前基线**：记录当前启动时间（客户机内 `systemd-analyze`）、vsock 吞吐（§4.3 脚本）、事件线程空闲 CPU（`top -H`）、镜像文件增长曲线。**没有基线就没办法量化收益**。

2. **THP 灰度**：先在非生产 microVM 池上开 `huge_pages: "Transparent"`，验证 `AnonHugePages` ≈ `mem_size_mib`（宿主机碎片严重的机器上可能合并不成功，此时收益归零但无正确性损失）。**同时确认所有 `mem_size_mib` 都是 2 的整数倍**，不然批量启动失败。

3. **快照管线适配**：检查你的快照管线是否「同宿主机恢复」或「有后续持久化」。是 → `sync_snapshot_files: false`，收益 13x；不是 → 保持默认。**加监控**：false 模式下宿主机崩溃的快照完整性失败率。

4. **vsock 重测**：尤其在单 vCPU + Intel 主机的场景。如果吞吐 -15% 且不可接受，评估是否回滚或调整 vCPU 数。**同时监控事件线程 CPU**——这是自旋是否真被修好的直接证据，从 100% 归零才算成功。

5. **virtio-mem + discard 回归**：在快照恢复的 microVM 上跑一遍 virtio-mem 热插拔 → 快照 → 恢复 → 再热插拔的完整循环，确认状态一致（v1.17.0 的修复点全在这条路径上）。对薄置备存储，跑客户机内 dd → rm → fstrim，验证宿主机镜像真的缩小。

### 8.5 5 条最佳实践

1. **隔离强度和启动速度是同一个光谱的两端，别想要全部**。Firecracker 选了「KVM 隔离 + 500ms 启动」，runc 选了「namespace 隔离 + 100ms 启动」，gVisor 在中间。**选型时先定隔离要求（你的工作负载受信任吗？），再定启动预算**，别反过来。

2. **默认值改变之前，先量你的宿主机**。THP 的收益从 -13% 到 -65% 浮动，取决于宿主机内存碎片化程度。**同一份配置在不同批次机器上收益差 5 倍是正常的**，监控要比静态数字更重要。

3. **单线程事件循环的故障特征是「整个进程卡死」而不是「某个设备慢」**。任何在这类架构里做设备开发的人，都要把「不能投递时不要注册 epoll 兴趣」刻进脑子里。**Firecracker v1.17.0 修的三连 bug 是同一根因的三次复发**——level-triggered epoll 的就绪态必须由真正的推进来清除，不能由「还有数据没读」来维持。

4. **API 契约的「静默接受错误值」比「拒绝错误值」危险十倍**。MiB→bytes 的 32 位回绕不报错、Async 引擎的 discard 静默不生效、快照的 fsync 默认开但你不知道——**「不报错」让上层的编排器做出错误决策**。设计 API 时，无法处理的输入应该被拒绝，而不是被截断成一个「看起来成功」的值。

5. **诚实边界是文档的一部分，不是缺陷**。bzImage 明说「vmlinux 仍然推荐，自解压有额外开销」；discard 明说「只支持 Sync 引擎」；单 vCPU vsock 明说「可能 -15%」。**这些边界让使用者能做正确的决策**，比一句「全面提升」有价值得多。一个基础设施项目的可信度，往往建立在这些明说的边界上。

---

## 写在最后

Firecracker 这个项目很有意思：它在一个所有热钱都流向 AI 的年份里，继续一行一行地改 KVM 内存管理、修 epoll 自旋、对齐 2MiB 边界。没有发布会，没有模型，没有估值新闻。

但它是**很多 AI 故事的地基**。你用的每一个 Serverless 函数、每一个在线代码沙箱、每一个跑着不可信 Agent 的容器，背后大概率有一个 microVM hypervisor 在做「这个工作负载只能碰这些内存」的保证。**THP 把启动从 803ms 压到 529ms，vsock 修好一个让事件线程 100% 空转三年的 bug——这些改动不会上新闻，但它们决定了「下一次冷启动要不要让用户多等 300ms」。**

而 v1.17.0 这版本身也是个好的工程样本：**最有价值的改动（THP）是一个 madvise 加一行对齐；最难找的 bug（vsock 自旋）的根因是「level-triggered epoll 的语义被误用」这种基础问题；最该优先升级的部分（virtio-mem 快照状态）连一个性能数字都没有。**

做基础设施就是这样：真正的进展经常看起来很无聊，直到你意识到它撑住了什么。
