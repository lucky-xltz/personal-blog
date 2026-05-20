---
title: "NTSYNC 与 Linux 内核的 Windows 化：当操作系统开始模仿它的对手"
date: 2026-05-20
category: 技术
tags: [Linux, NTSYNC, 内核, 游戏, Wine, 操作系统, 同步原语]
author: 林小白
readtime: 12
cover: https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=600&h=400&fit=crop
---

# NTSYNC 与 Linux 内核的 Windows 化：当操作系统开始模仿它的对手

2026 年 3 月，Linux 在 Steam 平台的用户占比首次突破 5%。这个数字背后，是一个操作系统花了二十年从"游戏界的笑话"走到"Steam Deck 的默认系统"的故事。而推动这一切的核心力量，不仅仅是 Valve 的硬件和 Proton 的兼容层——更是一系列直接写入 Linux 内核的 Windows API 实现。

NTSYNC，这个在 Linux 6.x 内核中合入的小型驱动程序，是这场变革的最新注脚。它不仅仅是一个性能优化补丁，更是一个信号：Linux 内核正在系统性地吸收 Windows 的同步原语设计，而这种趋势正在改变我们对操作系统抽象层的理解。

## 问题的根源：两种完全不同的同步哲学

要理解 NTSYNC 的价值，首先要理解 Windows 和 Linux 在线程同步上的根本差异。

### Windows 的同步模型：内核对象即一切

Windows NT 内核从诞生之初就采用了"万物皆内核对象"的设计哲学。Mutex、Semaphore、Event、CriticalSection——这些同步原语在 Windows 中都是一等公民的内核对象。每个对象都有一个内核句柄（HANDLE），进程通过句柄来操作它们。

```c
// Windows 同步：创建一个 Event 对象
HANDLE hEvent = CreateEventW(NULL, TRUE, FALSE, L"MyEvent");

// 等待多个对象——这是 Windows 的核心能力
HANDLE handles[3] = {hEvent, hMutex, hSemaphore};
DWORD result = WaitForMultipleObjects(3, handles, FALSE, INFINITE);
```

`WaitForMultipleObjects` 是 Windows 同步模型的核心能力。它允许一个线程同时等待多个内核对象中的任意一个（或全部）变为有信号状态。这个能力在游戏引擎中至关重要——渲染线程需要同时等待物理引擎完成、资源加载就绪、音频缓冲区准备好等多个条件。

### Linux 的同步模型：进程间一切皆文件

Linux 采用了截然不同的设计哲学。传统的 `pthread_mutex`、`pthread_cond` 是用户空间的抽象，基于 futex（Fast Userspace muTEX）实现。futex 的精妙之处在于，在无竞争的情况下完全不需要进入内核——这是 Linux 同步的性能优势。

但 futex 的设计目标是解决同一个进程内或通过共享内存通信的线程间的同步问题。当 Wine 需要模拟 Windows 的内核同步对象时，问题就来了：

```c
// Linux 传统方式：用 futex 实现条件等待
// 只能等待一个 futex 地址
int futex(int *uaddr, int futex_op, int val, ...);
```

Linux 的 `futex` 只能等待单个地址，而 Windows 的 `WaitForMultipleObjects` 需要同时等待多个对象。这个功能缺口成了 Wine 十几年来最大的技术债。

## 从用户空间打补丁：esync 和 fsync 的尝试

在 NTSYNC 之前，Wine 社区尝试了两种用户空间的解决方案。

### esync：Eventfd 的巧妙应用（2018）

esync（Eventfd Synchronization）利用 Linux 的 eventfd 机制来模拟 Windows 的 Event 对象。Eventfd 是 Linux 提供的一种轻量级事件通知机制，可以通过 `read`/`write` 系统调用来触发和等待事件。

```c
// esync 的核心思路：用 eventfd 模拟 Windows Event
int event_fd = eventfd(0, EFD_NONBLOCK | EFD_SEMAPHORE);

// 触发事件
uint64_t val = 1;
write(event_fd, &val, sizeof(val));

// 等待事件——用 epoll 实现多对象等待
struct epoll_event ev;
epoll_ctl(epoll_fd, EPOLL_CTL_ADD, event_fd, &ev);
epoll_wait(epoll_fd, events, max_events, timeout);
```

esync 的思路是：用一个 eventfd 对应一个 Windows Event 对象，然后用 `epoll` 来模拟 `WaitForMultipleObjects`。这个方案在很多游戏上工作得很好，但 `epoll` 的语义和 `WaitForMultipleObjects` 并不完全一致——特别是"等待任意一个"和"等待全部"的语义差异，以及超时处理的边界情况。

### fsync：Futex 的进化（2020）

fsync（Futex Synchronization）更进一步，直接利用 Linux 的 futex 机制来实现 Windows 同步原语。fsync 的作者 Elizabeth Figura（CodeWeavers 的核心开发者，后来也是 NTSYNC 的作者）发现，通过在共享内存中维护状态字（status word），可以用 futex 的等待/唤醒机制来实现更精确的语义。

```c
// fsync 的状态字设计
struct fsync {
    int status;  // 原子状态字
    // ...
};

// 等待操作：检查状态字，如果不满足条件则 futex 等待
while (__atomic_load_n(&obj->status, __ATOMIC_ACQUIRE) != expected) {
    futex(&obj->status, FUTEX_WAIT, expected, NULL, NULL, 0);
}

// 唤醒操作：更新状态字，唤醒等待者
__atomic_store_n(&obj->status, new_value, __ATOMIC_RELEASE);
futex(&obj->status, FUTEX_WAKE, 1, NULL, NULL, 0);
```

fsync 成为了 Proton 和 Steam Deck 的默认同步实现，在大多数游戏上表现良好。但它仍然是用户空间的模拟——状态字的维护、竞态条件的处理、以及 `WaitForMultipleObjects` 的模拟，都需要精心的锁设计和大量的边界情况处理。

## NTSYNC：把 Windows 同步直接编译进内核

NTSYNC 的核心思想简单而激进：既然用户空间模拟总有不精确的地方，为什么不直接在 Linux 内核中实现 Windows 的同步原语？

### 内核层面的实现

NTSYNC 在 Linux 内核中注册了一组字符设备（`/dev/ntsync`），提供以下系统调用：

```c
// NTSYNC 提供的 ioctl 操作
NTSYNC_IOC_CREATE_EVENT      // 创建 Event 对象
NTSYNC_IOC_CREATE_MUTEX       // 创建 Mutex 对象
NTSYNC_IOC_CREATE_SEMAPHORE   // 创建 Semaphore 对象
NTSYNC_IOC_WAIT_ANY           // 等待任意一个对象（对应 WaitForSingleObject）
NTSYNC_IOC_WAIT_ALL           // 等待所有对象（对应 WaitForMultipleObjects all）
NTSYNC_IOC_SIGNAL             // 信号一个对象
NTSYNC_IOC_RESET              // 重置一个对象
```

关键的 `WAIT_ANY` 和 `WAIT_ALL` 操作在内核中直接实现了 Windows 的语义：

```c
// 内核中的等待实现（简化伪代码）
static int ntsync_wait_any(struct ntsync_obj **objs, int count, 
                           ktime_t *timeout) {
    struct ntsync_wait_entry entry;
    int ret;
    
    // 注册等待条目到每个对象
    for (int i = 0; i < count; i++) {
        entry.task = current;
        list_add(&entry.node, &objs[i]->wait_list);
    }
    
    // 检查是否已有对象就绪
    for (int i = 0; i < count; i++) {
        if (ntsync_check_signaled(objs[i])) {
            ret = i;
            goto out;
        }
    }
    
    // 内核空间的等待——直接调度，无需用户空间切换
    ret = wait_event_interruptible_timeout(entry.wait_queue, 
                                           entry.signaled, *timeout);
out:
    // 清理等待条目
    for (int i = 0; i < count; i++) {
        list_del(&entry.node);
    }
    return ret;
}
```

### 为什么内核实现更好？

用户空间的 esync/fsync 方案需要通过系统调用来模拟多对象等待，每次等待都涉及上下文切换和用户空间/内核空间之间的状态同步。而 NTSYNC 的内核实现有几个根本性优势：

**1. 原子性的多对象等待**

在内核中，`WAIT_ALL` 可以在一个原子操作中检查所有对象的状态，无需用户空间的复杂锁协议：

```c
// fsync 的 WAIT_ALL 模拟（用户空间，需要多步操作）
for (int i = 0; i < count; i++) {
    lock(objs[i]);           // 逐步加锁
    if (!signaled(objs[i])) {
        // 复杂的回退逻辑...
    }
}

// NTSYNC 的 WAIT_ALL（内核空间，单次系统调用）
ioctl(fd, NTSYNC_IOC_WAIT_ALL, &wait_args);
// 内核内部使用自旋锁保护所有对象的原子检查
```

**2. 消除用户空间的状态字竞态**

fsync 使用共享内存中的状态字来跟踪同步对象的状态，这引入了一个根本性的竞态窗口：线程 A 可能在检查状态字和调用 futex 等待之间被线程 B 修改了状态。虽然 fsync 通过精心设计的锁协议来处理这些情况，但边界情况的复杂度随着游戏的复杂性指数增长。

NTSYNC 将所有状态管理放在内核中，消除了这个竞态窗口。

**3. 更精确的超时处理**

Windows 的 `WaitForMultipleObjects` 支持精确的超时语义——超时是针对整个等待操作的，而不是单个对象。在用户空间模拟这种语义需要额外的定时器和信号处理，而内核可以直接使用高精度的内核定时器。

### 性能数据：实际提升有多大？

NTSYNC 的原始基准测试显示了 40% 到 200% 的帧率提升，但这个数字需要正确解读。这些测试是对比原版 Wine（没有任何同步优化）的结果。

实际的性能对比更诚实：

| 测试场景 | fsync → NTSYNC | 说明 |
|---------|---------------|------|
| CPU 密集型游戏 | 2-5% | 微小提升，主要来自减少的系统调用开销 |
| 多线程渲染管线 | 5-15% | 受益于原生多对象等待 |
| 曾经卡顿的游戏 | 显著改善 | 不是帧率提升，而是消除卡顿和死锁 |
| 大多数游戏 | 接近持平 | fsync 已经足够好 |

真正的价值不在于帧率数字，而在于**行为的正确性**。fsync 模拟的边缘情况可能导致：

- 偶发的帧时间尖峰（hitch）
- 特定游戏中的死锁
- 难以复现的崩溃
- 多线程资源加载时的竞争条件

NTSYNC 从根源上消除了这些问题，因为它精确匹配了 Windows 的行为——没有近似值，没有边界情况的 hack。

## 更大的图景：Linux 内核的 Windows API 化

NTSYNC 不是孤立事件。回顾过去几年的 Linux 内核变更，一个清晰的趋势正在浮现：

### 已进入内核的 Windows 概念

| 功能 | 内核版本 | 说明 |
|------|---------|------|
| Eventfd 多对象等待 | 5.x | `io_uring` 提供了类似 `WaitForMultipleObjects` 的能力 |
| NTSYNC | 6.x | 完整的 Windows 同步原语实现 |
| NTFS3 驱动 | 5.15 | Paragon 贡献的原生 NTFS 读写支持 |
| exFAT 支持 | 5.4 | Samsung 贡献的 exFAT 文件系统驱动 |

### 正在讨论中的功能

- **NT 内核的其他同步原语**：如 Alertable Waits、APC（异步过程调用）
- **Win32 子系统概念**：有开发者提议将更多 Windows 子系统的概念引入 Linux
- **DirectX 内核支持**：虽然目前通过 Mesa/Vulkan 翻译层实现，但有讨论是否需要更底层的支持

一位 HN 用户的评论颇为精辟："我预测 ntsync 最终会演变成完整的 ntoskrnl.ko，调用 Windows API 将几乎没有开销。你几乎可以称之为 Windows 的 Linux 子系统。"

### 开发者的顾虑

这种趋势也引发了社区的担忧：

**"与 Windows 战斗的人要小心，别让自己变成 Windows。当你长久凝视 ntoskrnl 时，ntoskrnl 也在凝视你。"**

这种哲学层面的争论并非没有道理。Linux 内核的传统设计哲学是提供通用的、正交的原语（如 `epoll`、`io_uring`），让上层软件组合使用。而直接在内核中实现特定操作系统的 API，是一种"特化"而非"泛化"的设计路径。

但从务实的角度看，这种特化正在为 Linux 带来数以千万计的用户和开发者。2026 年 3 月 Steam 上 5% 的 Linux 用户份额，很大程度上归功于这些"特化"的内核功能。

## 对开发者的实际意义

### 如果你是游戏开发者

NTSYNC 的存在意味着你可以更自信地支持 Linux 平台。Proton 的兼容性正在从"大部分游戏能跑"进化到"行为上等价于 Windows"。这降低了跨平台测试的成本。

```cmake
# CMakeLists.txt - 现代游戏引擎的 Linux 支持
if(UNIX AND NOT APPLE)
    # Proton/Wine 环境下的同步原语会自动使用 NTSYNC
    # 如果需要原生 Linux 构建，使用标准 pthread
    find_package(Threads REQUIRED)
    target_link_libraries(game_engine PRIVATE Threads::Threads)
endif()
```

### 如果你是系统开发者

NTSYNC 的内核实现代码是一个学习内核同步机制的绝佳案例。它展示了如何在内核中实现复杂的等待/唤醒语义、如何处理超时、以及如何设计安全的用户空间接口。

```bash
# 查看 NTSYNC 内核代码
git clone https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git
cd linux
git log --oneline --all -- drivers/misc/ntsync.c
```

### 如果你是普通用户

如果你在使用 Steam Deck 或任何基于 Proton 的 Linux 游戏体验，NTSYNC 意味着更稳定的游戏表现和更少的"明明配置够但就是卡"的问题。大多数主流发行版（Fedora、Ubuntu 24.04+、Arch Linux）已经包含了支持 NTSYNC 的内核版本。

```bash
# 检查你的内核是否支持 NTSYNC
cat /proc/version
# 需要 Linux 6.x 或更新版本

# 检查 NTSYNC 设备是否存在
ls -la /dev/ntsync
```

## 未来展望：操作系统边界的消融

NTSYNC 的故事揭示了一个更大的趋势：操作系统的边界正在变得模糊。

- **WSL2** 让 Windows 内部运行了一个完整的 Linux 内核
- **Proton/Wine** 让 Linux 运行 Windows 应用
- **NTSYNC** 让 Linux 内核实现了 Windows 的同步 API
- **macOS 的 Game Porting Toolkit** 基于 Wine/CrossOver 技术

我们正在见证的不是某个操作系统的胜利，而是**抽象层的重新划分**。未来的"操作系统"可能不再是一个单一的内核，而是一组可组合的兼容层——你可以在任何硬件上运行任何软件，代价只是一层薄薄的翻译。

NTSYNC 是这个未来的一块拼图。它很小，但它代表的方向很明确：Linux 内核不再只是"Linux 的内核"，它正在成为一个能够原生理解多种操作系统语义的通用平台。

而这个过程的推动力，既不是学术研究，也不是企业战略——而是数百万玩家想要在 Linux 上玩 Windows 游戏的朴素愿望。有时候，最深刻的技术变革来自最平凡的需求。

---

*相关阅读：*

- [Bun 从 Zig 到 Rust 的百万行重写：AI 驱动的运行时迁移意味着什么？](/article/bun-zig-to-rust-rewrite-2026)
- [PostgreSQL 非常规优化：三个被忽视的性能提升技巧](/article/postgresql-unconventional-optimizations-)
