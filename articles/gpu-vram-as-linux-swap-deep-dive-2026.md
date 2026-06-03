---
title: "把显卡显存当内存用：NBD-VRAM 的 Linux 内存分层实战与技术深潜"
date: 2026-06-03
category: 技术
tags: [Linux, NVIDIA, 内存管理, 系统编程, CUDA, NBD, swap, 性能优化]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1591799264318-7e6ef8ddb7ea?w=600&h=400&fit=crop
---

# 把显卡显存当内存用：NBD-VRAM 的 Linux 内存分层实战与技术深潜

## 一个"疯狂"的想法

你有一台笔记本，内存焊死无法升级，16GB 内存日常捉襟见肘。但你的 RTX 3070 有 8GB 显存，平时除了跑个桌面合成器，大部分时间都在闲置。

能不能把这块闲置的显存拿来当 swap 用？

这不是异想天开。2026 年 5 月底，一个叫 [nbd-vram](https://github.com/c0dejedi/nbd-vram) 的开源项目在 Hacker News 上引发了热烈讨论（307 赞，84 评论）。它用一种巧妙的架构绕过了 NVIDIA 驱动的重重限制，让消费级显卡的显存变成了 Linux 内核的高速 swap 设备。

本文将深入剖析这个项目的技术原理，从 NVIDIA 驱动的 BAR1 内存映射机制讲起，经过 Linux NBD 协议的巧妙运用，最终构建出一条从内核 swap 子系统到 GPU 显存的完整数据通路。

## 技术背景：为什么这不容易？

### PCIe BAR 与显存映射

要理解这个项目，首先需要理解 CPU 如何访问 GPU 显存。

现代 GPU 通过 PCIe 总线连接到 CPU。PCIe 设备通过 **BAR（Base Address Register）** 向系统暴露自己的内存空间。对于显卡来说，BAR1 通常映射了显存的一部分，让 CPU 可以通过 MMIO（Memory-Mapped I/O）直接读写显存。

但这里有个关键限制：**消费级 NVIDIA 显卡的 BAR1 只映射了很小一部分显存**。一块 8GB 显存的 RTX 3070，BAR1 通常只映射约 256MB。剩余的显存只能通过 NVIDIA 驱动的专有 API 访问。

```
CPU 视角的内存空间：
┌─────────────────────────────────────────────┐
│ 系统 RAM (16GB)                              │  ← 正常内存
├─────────────────────────────────────────────┤
│ PCIe MMIO 区域                               │
│  └─ GPU BAR1 (256MB)  ← 仅这一小块可见       │
│     ┌──────────┬─────────────────────────┐  │
│     │ 帧缓冲区  │  不可见的显存 (7.75GB)    │  │
│     └──────────┴─────────────────────────┘  │
└─────────────────────────────────────────────┘
```

### NVIDIA P2P API 的"铁幕"

最直觉的方案是使用 NVIDIA 的 `nvidia_p2p_get_pages_persistent` API，它可以将显存页面固定到 BAR1 中，然后用 `ioremap_wc` 让 CPU 直接映射访问。理论上这是零拷贝的极致方案。

但现实很残酷：**这个 API 在消费级 GeForce 显卡上被锁死了**。无论驱动版本如何，无论怎么调参数，NVIDIA 驱动在 RM（Resource Manager）层面拒绝了所有 GeForce 卡的请求，只允许 Quadro 和数据中心级别的 GPU 使用。这是纯粹的产品分级策略，不是技术限制。

```
尝试 P2P API 的结果：
nvidia_p2p_get_pages_persistent(...) → EINVAL  (GeForce)
                                     → SUCCESS (Quadro/A100)
```

绕过 P2P API，直接用 `ioremap_wc` 映射 BAR1 的物理地址呢？也不行。GPU 内部的页表只映射了约 16MB 的 BAR1 空间（刚好够显示帧缓冲区），对剩余地址的读取全部返回零。`mkswap` 看起来成功了，但 `swapon` 会失败——因为 swap header 根本没有被真正写入。

### NBD：一条"旁路"

nbd-vram 的作者找到了第三条路：**不直接映射显存，而是通过 CUDA 驱动 API 和 Linux NBD 协议搭一座桥**。

NBD（Network Block Device）是 Linux 内核自带的块设备协议，最早在 1997 年引入。它允许内核通过网络 socket 与用户态程序通信，将远程存储暴露为本地块设备（`/dev/nbdX`）。虽然名字里有 "Network"，但它完全可以通过 Unix domain socket 在本地运行，零网络开销。

nbd-vram 的核心思路是：

1. **用户态守护进程**通过 CUDA API 分配显存
2. 守护进程作为 NBD server，通过 Unix socket 提供块设备服务
3. 内核的 `nbd` 驱动连接到这个 socket，将 `/dev/nbdX` 暴露为标准块设备
4. 将 `/dev/nbdX` 格式化为 swap 并激活

```
数据通路（完整链路）：

内核 swap 子系统
    ↓
/dev/nbd0 (块设备)
    ↓
nbd 内核驱动
    ↓
Unix socket (/var/run/nbd-vram.sock)
    ↓
nbd-vram 守护进程 (用户态)
    ↓
cuMemcpyHtoD / cuMemcpyDtoH (CUDA API)
    ↓
GPU VRAM (物理显存)
```

这条通路看起来很"绕"，但它有一个巨大的优势：**不需要任何内核模块，不需要 NVIDIA 内核符号，完全在用户态运行**。内核更新、驱动更新都不会破坏它。

## 性能分析：它到底有多快？

### 理论带宽计算

数据要经过这么多层，性能能行吗？让我们算一算每一跳的带宽：

| 数据通路段 | 接口 | 理论带宽 |
|-----------|------|---------|
| GPU 显存 ↔ GPU 内部 | GDDR6 总线 | ~448 GB/s |
| GPU ↔ CPU | PCIe 4.0 x16 | ~32 GB/s（双向各 16） |
| CUDA memcpy | cuMemcpyHtoD/DtoH | 受 PCIe 带宽限制 |
| Unix socket | 本地 IPC | ~50-80 GB/s（受内核缓冲限制） |
| nbd 驱动 | 内核态 | 取决于实现 |

理论瓶颈在 PCIe 带宽。PCIe 4.0 x16 的单向有效带宽约 16 GB/s，对于 swap 场景来说相当充裕——毕竟 NVMe SSD 通常只有 3-7 GB/s。

### 实测数据

nbd-vram 的 README 提供了实测数据：

- **测试环境**：RTX 3070 Laptop（GA104M），PCIe 4.0 x16
- **顺序吞吐量**：~1.3 GB/s
- **对比 NVMe SSD**：NVMe 顺序写入约 3 GB/s，但随机访问延迟更高

等等，1.3 GB/s 远低于 PCIe 4.0 的 16 GB/s 理论值？这引起了 HN 社区的广泛讨论。

### 性能瓶颈分析

实际吞吐量只有理论值的 ~8%，原因在于**数据通路中的每一跳都引入了额外开销**：

**1. CUDA memcpy 的固定开销**

`cuMemcpyHtoD` 和 `cuMemcpyDtoH` 不是简单的 DMA 操作。每次调用都要经过 CUDA 驱动的状态机、命令队列和同步机制。对于小块数据（4KB 页面），这些固定开销占据了大部分时间。

```c
// 每次 swap 页面操作（4KB）的开销分解：
// cuMemcpyHtoD 启动开销:  ~2-5 μs
// PCIe 传输 4KB:           ~0.25 μs（理论值）
// 实际单页延迟:            ~5-10 μs

// 对比 NVMe 4KB 随机写:
// NVMe 延迟:               ~10-50 μs（含闪存写入）
```

**2. 用户态-内核态切换**

每个 NBD 请求都要经历：内核 nbd 驱动 → Unix socket → 用户态守护进程 → CUDA API → 内核驱动。这条链路涉及多次上下文切换和数据拷贝。

**3. NBD 协议本身的开销**

NBD 协议设计用于网络传输，每个请求都有协议头（magic number、offset、length），对于本地场景来说是纯浪费。但对于 4KB 页面操作来说，这个开销可以忽略。

### 真正的价值：延迟而非带宽

虽然顺序吞吐量不如 NVMe SSD，但 **VRAM swap 的延迟特性完全不同**。PCIe 的延迟在微秒级（1-10 μs），而 NVMe SSD 的延迟在毫秒级（10-100 μs）。对于 swap 场景来说，**低延迟比高带宽更重要**——因为 swap 的典型访问模式是小块随机 I/O（4KB 页面换入换出），而不是顺序大块传输。

这就是为什么 nbd-vram 设置了 **1500 的高 swap 优先级**（默认 SSD swap 通常是 -1 到 100）。内核的 swap 分配器会优先使用高优先级的 swap 设备，让 VRAM swap 成为 RAM 之后的第一道缓冲，而不是与 SSD swap 竞争。

## 内存分层架构：四层缓冲

nbd-vram 真正的价值在于它为 Linux 内存管理增加了一个新的层次。原生的 Linux 内存分层是：

```
传统三层模型：
┌─────────────────────────┐
│  RAM（物理内存）          │  ← 速度：~50 GB/s，延迟：~100 ns
├─────────────────────────┤
│  zram（压缩内存 swap）    │  ← 速度：~10 GB/s，延迟：~1-5 μs
├─────────────────────────┤
│  SSD swap（磁盘 swap）   │  ← 速度：~3 GB/s，延迟：~50 μs
└─────────────────────────┘
```

加入 VRAM swap 后，变成了四层：

```
四层内存模型：
┌─────────────────────────┐
│  RAM（物理内存）          │  ← 速度：~50 GB/s，延迟：~100 ns
├─────────────────────────┤
│  VRAM swap（显存 swap）  │  ← 速度：~1.3 GB/s，延迟：~5-10 μs  ← 新增
├─────────────────────────┤
│  zram（压缩内存 swap）    │  ← 速度：~10 GB/s，延迟：~1-5 μs
├─────────────────────────┤
│  SSD swap（磁盘 swap）   │  ← 速度：~3 GB/s，延迟：~50 μs
└─────────────────────────┘
```

注意 VRAM swap 和 zram 的定位很微妙：zram 的带宽更高（压缩/解压由 CPU 完成），但 VRAM swap 不消耗 CPU 资源。在 CPU 负载高的场景下（编译、AI 推理），VRAM swap 可以避免 zram 压缩带来的 CPU 竞争。

### 溢出顺序

nbd-vram 的设计中，内存溢出的顺序是：

1. **RAM 填满** → 正常的内存压力触发
2. **VRAM swap 吸收溢出**（通过 PCIe）→ 高优先级 swap
3. **zram 压缩剩余页面**（消耗 CPU）→ 中优先级
4. **SSD swap 作为最后防线** → 低优先级

这种分层策略在 README 的测试环境中实现了 **~46GB 总可寻址内存**（从原始 16GB 三倍扩展）。

## 实现细节：巧妙的工程设计

### 自动退避分配

nbd-vram 的守护进程不会一次性要求全部显存。它从用户配置的大小开始，如果 CUDA 分配失败（显存不足），会以 512MB 为步长逐步减少，直到找到可分配的最大值。

```c
// 伪代码：退避分配逻辑
size_t requested = config.size_mb * 1024 * 1024;
size_t allocated = 0;

while (requested > 0) {
    if (cudaMalloc(&ptr, requested) == CUDA_SUCCESS) {
        allocated = requested;
        break;
    }
    requested -= 512 * 1024 * 1024;  // 退避 512MB
}
```

这个设计很聪明：桌面合成器、浏览器 GPU 加速等都会占用部分显存，剩余显存大小是动态变化的。退避机制确保了在任何显存使用情况下都能获取最大可用空间。

### 电源管理

对于笔记本用户，nbd-vram 实现了电源感知管理：

- **拔掉电源** → 自动停止 VRAM swap（避免电池快速耗尽）
- **电池低于阈值** → 自动停止
- **接回电源** → 自动恢复
- **手动 systemctl stop** → 尊重用户操作，不会被自动恢复覆盖

这通过 D-Bus 监听 UPower 电源事件实现。

### swap 优先级策略

```ini
# /etc/systemd/system/vram-swap-nbd.service
Environment=VRAM_SWAP_PRIORITY=1500
```

优先级 1500 远高于默认 SSD swap（通常 -2 到 10）。内核的 swap 分配器按优先级从高到低使用 swap 设备，确保 VRAM swap 在 SSD swap 之前被使用。这个高优先级是有道理的——VRAM swap 的延迟远低于 SSD。

## 实际应用场景

### 1. 焊死内存的笔记本

这是 nbd-vram 的首要场景。MacBook、Surface Laptop、很多轻薄本的内存都是焊死的，无法升级。如果你有一台带独显的笔记本（尤其是 NVIDIA + 集显双显卡方案），闲置的独显显存就是白白浪费的资源。

实测：16GB RAM + 8GB VRAM → 通过 nbd-vram（7GB swap）+ zram → 约 46GB 可寻址内存。对于日常开发（IDE + Docker + 浏览器 + 终端）来说，这意味着不再需要频繁关闭标签页或重启 Docker 容器。

### 2. AI 推理时的内存压力缓冲

当你在本地跑 LLM 推理时，模型权重占据了大部分显存。但推理结束后，显存就空闲了。nbd-vram 可以在推理间隙将系统 swap 数据迁移到 VRAM，为下一次推理释放系统内存。

更有趣的是 HN 用户 [dragontamer] 提出的思路：既然数据已经在 VRAM 里了，GPU 可以直接对这些数据做排序、查找等操作。这暗示了一种 **"GPU 加速 swap"** 的可能性——不仅是存储，还能利用 GPU 的并行计算能力。

### 3. 开发机的内存扩展

HN 用户 [xfalcox] 的场景很典型：

> "我的开发机有 32GB 内存和 32GB 显存，显存在不跑 AI 模型时基本闲置，这个想法其实不差。"

对于跑多个 Docker 容器、Kubernetes 集群、大型 monorepo 的开发者来说，32GB 内存经常不够用。如果显卡有 16-24GB 显存（RTX 4090 有 24GB），划出一部分做 swap 可以显著缓解内存压力。

## 技术限制与风险

### 1. 吞吐量瓶颈

如前所述，1.3 GB/s 的顺序吞吐量是硬伤。如果你的工作负载涉及大量顺序内存操作（视频编辑、大型数据集处理），VRAM swap 可能反而比 SSD swap 更慢。

### 2. VRAM 争用

最大的风险是 **GPU 工作负载突然需要显存时的争用**。HN 用户 [drdaeman] 指出了 Wayland 下的问题：

> "Wayland 的显存分配比 X11 更动态，显存不足时可能直接崩溃整个桌面。我用 Hyprland + llama-server 时就遇到过这个问题。"

nbd-vram 的退避分配机制在启动时有效，但运行中如果其他进程突然申请大量显存（如启动一个 AI 模型），守护进程持有的显存不会自动释放。这可能导致 GPU OOM。

### 3. PCIe 带宽竞争

当 GPU 同时进行图形渲染和 swap I/O 时，PCIe 带宽会被两者竞争。在高帧率游戏或 GPU 密集计算场景下，swap I/O 可能影响 GPU 性能。

### 4. 非标准用法

这不是 NVIDIA 官方支持的用法。虽然使用的 CUDA API（`cuMemcpyHtoD`/`cuMemcpyDtoH`）是公开稳定的，但这种将显存当块设备用的方式超出了设计意图。未来驱动更新理论上可能改变行为，尽管概率很低。

## 与历史方案的对比

这不是第一次有人尝试用显存当 swap。[Arch Linux Wiki](https://wiki.archlinux.org/title/swap_on_video_RAM) 上有一个古老的方法，使用 Linux 内核的 MTD（Memory Technology Device）子系统直接映射显存：

```
历史方案（MTD/phram）：
CPU → ioremap_wc → 物理显存地址 → 直接读写

现代方案（NBD-VRAM）：
CPU → NBD 协议 → 用户态 → CUDA API → GPU 显存
```

MTD 方案更直接、开销更低，但它依赖于能够直接映射显存物理地址——这在现代 NVIDIA 驱动下已经不可行（BAR1 映射范围太小）。nbd-vram 的 NBD 方案虽然多了几跳，但它是目前**唯一能在消费级 NVIDIA 显卡上工作的方案**。

## 最佳实践与建议

如果你决定尝试 nbd-vram，以下是一些建议：

**1. 显存分配不要贪心**

留足显存给桌面合成器和浏览器 GPU 加速。RTX 3070 有 8GB 显存，分配 5-6GB 做 swap 比较安全。笔记本用户尤其要注意，集显可能依赖独显的部分显存。

**2. 配合 zram 使用**

VRAM swap + zram 是最佳组合。VRAM swap 提供低延迟的第一次缓冲，zram 提供高吞吐的第二次缓冲（压缩比通常 2:1 到 3:1），只有在两者都满了之后才落盘到 SSD。

**3. 监控 swap 使用情况**

```bash
# 查看 swap 设备和优先级
swapon --show

# 实时监控 swap 使用
vmstat 1  # 观察 si/so（swap in/out）列

# 查看 nbd-vram 服务状态
systemctl status vram-swap-nbd
```

**4. 服务器场景谨慎使用**

服务器通常不需要 swap（内存应该够用），而且 GPU 可能正在跑推理/训练任务。VRAM swap 主要面向**内存紧张的桌面/笔记本**场景。

**5. 关注内核 nbd 驱动的稳定性**

nbd 驱动是 Linux 内核的成熟组件，但它设计用于网络存储，长时间高负载的本地 swap 使用模式可能触发不常见的 bug。建议先用 `test-nbd.sh` 做冒烟测试。

## 总结

nbd-vram 是一个精彩的系统工程案例。它没有尝试突破 NVIDIA 驱动的限制（P2P API），而是找到了一条完全在用户态运行的"旁路"。虽然性能不及直接映射，但它的实用价值在于：

- **零内核模块**：不需要维护自定义内核模块，不受内核/驱动更新影响
- **即插即用**：systemd 服务，开机自动启动
- **电源感知**：笔记本用户的贴心设计
- **安全退避**：显存不足时自动减少分配

1.3 GB/s 的顺序吞吐量确实不高，但对于 swap 的典型访问模式（小块随机 I/O、低延迟需求）来说，它比 SSD swap 的延迟低一个数量级。在内存紧张的笔记本场景下，这 7GB 的额外"内存"可能意味着流畅运行和频繁卡顿之间的差别。

这让我们思考一个问题：在 AI 时代，GPU 的显存越来越大（RTX 5090 有 32GB，数据中心 GPU 有 80-192GB），但很多时间这些显存都在闲置。能不能把这些"沉默的算力"和"沉默的存储"更好地利用起来？nbd-vram 给出了一个有趣的方向。

---

*相关阅读：*

- [从 rsync 到 openrsync：一个工具替换背后的许可证战争、安全哲学与协议困境](/article/openrsync-macos-replacement-2026)
- [Zig 构建系统的双进程革命：从 150ms 到 14ms 的 10 倍提速之路](/article/zig-build-system-rework-2026)
- [Restartable Sequences：不用原子操作也能实现无锁数据结构的 Linux 黑科技](/article/restartable-sequences-lock-free-without-atomics-2026)
