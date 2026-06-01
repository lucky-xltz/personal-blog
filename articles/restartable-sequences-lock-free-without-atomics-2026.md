---
title: "Restartable Sequences：不用原子操作也能实现无锁数据结构的 Linux 黑科技"
date: 2026-06-01
category: 技术
tags: [Linux内核, 无锁编程, 系统编程, 性能优化, 并发, x86, ARM]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&h=400&fit=crop
---

# Restartable Sequences：不用原子操作也能实现无锁数据结构的 Linux 黑科技

在多核时代，如何让多个线程安全地操作共享数据结构而不引入锁的开销，一直是系统编程的核心难题。原子操作（atomics）虽然避免了互斥锁，但缓存行争用（cache line contention）在高核心数下依然是性能杀手。

Linux 内核从 4.18（2018 年）开始引入了一个鲜为人知但极具革命性的机制——**Restartable Sequences（rseq）**。它通过内核与用户态之间的共享内存通信，让你在不使用锁和原子操作的情况下构建真正可扩展的线程安全数据结构。

Cosmopolitan Libc 的作者 Justine Tunney 最近发布了一篇关于 rseq 的深度教程，引发了系统编程社区的广泛讨论。本文将深入解析 rseq 的工作原理、性能优势、适用场景，以及它对未来系统编程范式的影响。

## 问题：为什么锁和原子操作在多核下不够好？

### 互斥锁的瓶颈

最朴素的并发保护方式是互斥锁（mutex）：

```c
pthread_mutex_lock(&mutex);
counter++;
pthread_mutex_unlock(&mutex);
```

问题显而易见：同一时刻只有一个线程能持有锁，其余线程全部阻塞。在 96 核或 128 核的机器上，这意味着 95 个核心在空转等待。实测数据表明，一个 contended 的锁/unlock 操作耗时约 200 纳秒，而 uncontended 仅需 15 纳秒——差距超过 10 倍。

### 原子操作的隐藏代价

CAS（Compare-And-Swap）循环看起来是"无锁"的：

```c
do {
    old = atomic_load(&list);
    new_node->next = old;
} while (!atomic_compare_exchange(&list, &old, new_node));
```

但"无锁"不等于"无开销"。当多个核心同时操作同一块 64 字节的缓存行（cacheline）时，CPU 内部会启动类似互斥锁的缓存一致性协议（MESI/MOESI）。核心越多，争用越严重。Justine 的评价一针见血：

> "CPU 内部的互斥机制，大概率没有你在用户态实现的好。"

### 分片（Sharding）的困境

一个直觉上的改进是按 CPU 分片——每个核心有自己的数据副本：

```c
struct list_t {
    struct node_t* head;
    char padding[56]; // 确保每个 CPU 的数据在不同缓存行
} lists[1024];

void push(struct node_t* node) {
    int cpu = get_cpu();
    pthread_mutex_lock(&lists[cpu].mutex);
    node->next = lists[cpu].head;
    lists[cpu].head = node;
    pthread_mutex_unlock(&lists[cpu].mutex);
}
```

分片后，锁争用大幅降低——只有当内核在线程读取 CPU 编号和实际修改操作之间把线程迁移到另一个核心时，才会发生冲突。这种情况是"角例"（corner case），概率很低。

但问题在于：你**仍然需要那把锁**。因为操作系统随时可能抢占你的线程并迁移到其他核心。在 `get_cpu()` 和实际写入之间，任何抢占都可能导致数据损坏。

## 解决方案：Restartable Sequences

### 核心思想

rseq 的设计极其精妙：**通过共享内存实现内核与用户态的双向通信，让内核在抢占线程时自动回滚正在执行的临界区代码。**

具体机制：

1. 线程通过 `rseq()` 系统调用注册一个 32 字节的 TLS（Thread Local Storage）区域
2. 内核在每次线程被重新调度时，将当前 CPU 编号写入该 TLS 区域
3. 线程在进入临界区时，设置一个 `rseq_cs` 结构体指针，告诉内核："如果要抢占我，请检查我是否正在执行这段代码"
4. 内核在抢占时检查程序计数器（%rip）是否在指定区间内
5. 如果是，内核将线程强制跳转到用户指定的 abort handler
6. Abort handler 通常只需跳回序列开头重试

整个过程通过共享内存完成，**零系统调用开销**。

### 具体实现：无锁链表 Push

```c
static void push(struct node_t* node) {
    // rseq 临界区：约 10 条汇编指令
    asm volatile(
        // 1. 告诉内核：临界区开始
        "leaq 1f(%%rip), %[rseq_cs]\n\t"  // 设置 rseq_cs 指针
        // 2. 获取当前 CPU 编号（1ns 的 mov 指令）
        "movq %%fs:0, %[cpu]\n\t"          // 从 TLS 读取 CPU ID
        // 3. 计算分片索引（CPU * 64）
        "shlq $6, %[cpu]\n\t"              // 左移 6 位 = 乘以 64
        // 4. 执行链表操作（临界区的最后一条指令 = commit 点）
        "movq lists(,%[cpu],1), %%rax\n\t" // 读取 head
        "movq %%rax, (%[node])\n\t"        // node->next = head
        "movq %[node], lists(,%[cpu],1)\n\t" // head = node（COMMIT）
        // 5. 临界区结束
        "2:\n\t"
        // Abort handler：跳回开头重试
        ".pushsection __rseq_failure, \"ax\"\n\t"
        "1: jmp 2b\n\t"
        ".popsection\n\t"
        : [rseq_cs] "=m"(rseq_cs), [cpu] "=&r"(cpu)
        : [node] "r"(node)
        : "rax", "memory"
    );
}
```

关键设计点：

- **commit 点**是最后一条内存写入指令。只有这条指令执行成功，修改才算生效
- 如果内核在 commit 点之前抢占线程，abort handler 跳回开头，CPU 编号重新读取，操作重试
- 使用 System V 数值标签（`1:`/`2:`）配合 `f`/`b` 引用，确保内联展开时标签不冲突

### Pop 操作

Pop 的逻辑类似，但需要注意 ABA 问题的天然规避——因为 rseq 保证操作的原子性（在内核协助下），你不需要 tagged pointer 或 hazard pointer：

```c
static struct node_t* pop(int cpu) {
    struct node_t* node;
    asm volatile(
        "leaq 1f(%%rip), %[rseq_cs]\n\t"
        "movq %%fs:0, %[cpu]\n\t"
        "shlq $6, %[cpu]\n\t"
        "movq lists(,%[cpu],1), %[node]\n\t"  // node = head
        "testq %[node], %[node]\n\t"          // if (head == NULL)
        "je 2f\n\t"                            //   return NULL
        "movq (%[node]), %%rax\n\t"            // head = node->next
        "movq %%rax, lists(,%[cpu],1)\n\t"     // COMMIT
        "2:\n\t"
        ".pushsection __rseq_failure, \"ax\"\n\t"
        "1: jmp 2b\n\t"
        ".popsection\n\t"
        : [rseq_cs] "=m"(rseq_cs), [node] "=&r"(node), [cpu] "=r"(cpu)
        :
        : "rax", "memory"
    );
    return node;
}
```

## 性能对比：数字说话

Justine 在 96 核 AMD Threadripper 和 128 核 Ampere Altra 上进行了基准测试。以下是 malloc 场景下的性能对比（越高越好）：

| 方案 | 96核 Threadripper | 128核 Ampere ARM | 说明 |
|------|-------------------|------------------|------|
| glibc mutex | 基准（1x） | 基准（1x） | 最朴素的互斥锁 |
| 分片 + mutex | ~10x | ~10x | 按 CPU 分片，仍用锁 |
| 分片 + 原子操作 | ~10x | ~15x | CAS 循环，ARM 上更快 |
| 分片 + rseq | **34x** | **43x** | 无锁无原子，共享内存通信 |
| 分片 + CPU 亲和性 | ~35x | ~45x | 理论上限，但不实际 |

rseq 的性能接近 CPU 亲和性（pin threads to cores）方案，但不需要手动管理线程绑定，内核可以自由调度。

### 为什么 ARM 上更快？

Ampere ARM Altra 的原子操作比 x86 更快，因为 ARM 有更宽松的内存模型。ARM 的 `atomic_fetch_add_explicit(&counter, 1, memory_order_relaxed)` 编译为单条 `ldadd` 指令，不需要内存屏障。而 x86 的 `lock xadd` 总是强序的。

但即使在 ARM 上，rseq 仍然比原子操作快约 3 倍——因为 rseq 完全避免了缓存行的跨核同步开销。

## 实际应用：谁在用 rseq？

目前使用 rseq 的主要项目：

| 项目 | 用途 | 说明 |
|------|------|------|
| **tcmalloc** | 内存分配器 | Google 的高性能 malloc，rseq 用于线程本地缓存 |
| **jemalloc** | 内存分配器 | Facebook 使用的分配器 |
| **glibc** | C 标准库 | 用于优化某些内部数据结构 |
| **Cosmopolitan Libc** | 可移植 C 库 | Justine 的项目，rseq 深度集成到 malloc 实现 |

### tcmalloc 的巧妙设计

tcmalloc 使用 rseq 的方式值得一提：它不用链表，而是用数组 + 提交索引。你可以向未提交区域自由写入数据，最后只需原子地推进索引即可。这避免了链表操作中多个全局内存写入的复杂性。

### Cosmopolitan 的 malloc

Cosmopolitan 的 malloc 设计简洁优雅：

1. 请求小分配（<512 字节）时，尝试从全局分片链表 pop 一块内存
2. 如果链表为空，调用 `mmap()` 获取新页面，切成块后 push 到链表
3. 再次尝试 pop

整个过程无锁、无原子操作，仅靠 rseq 保证线程安全。

## 可移植性：rseq 的阿喀琉斯之踵

rseq 目前的局限性：

| 操作系统 | 支持状态 |
|----------|---------|
| Linux 4.18+ | ✅ 完全支持 |
| FreeBSD | ❌ 不支持（有提案讨论中） |
| macOS | ❌ 不支持 |
| Windows | ❌ 不支持 |

这意味着如果你在写跨平台库或开源项目，不能只依赖 rseq。Cosmopolitan 的做法是提供回退策略：

```c
if (has_rseq()) {
    push_rseq(node);       // Linux: 最快路径
} else {
    push_sharded_mutex(node); // 其他 OS: 分片 + 锁
}
```

### librseq：更易用的封装

如果你不想写汇编，Mathieu Desnoyers（rseq 的内核实现者）维护的 [librseq](https://github.com/compudj/librseq) 提供了常见数据结构（计数器、链表等）的封装，隐藏了底层汇编细节。

## 未来展望：rseq 将如何改变系统编程？

### 编程语言层面的支持

Justine 的预测大胆但有理：

> "所有操作系统都会支持 rseq，所有系统编程语言都会被重新设计以表达 restartable sequences，所有数据结构库都会被重写以使用它们。"

类比历史：C11 引入了 `<stdatomic.h>`，让编译器提供了原子操作的标准 API。类似地，未来可能会有类似这样的语言级支持：

```c
// 假设的未来语法
rseq_critical {
    int cpu = rseq_cpu_id();
    node->next = lists[cpu].head;
    lists[cpu].head = node;
    // 如果被抢占，自动跳回 rseq_critical 开头
}
```

### 跨 CPU 修改：rseq v2

Linux v5.10 引入了 `rseq_op` 系统调用变体，允许一个线程修改另一个 CPU 上的 rseq 数据结构。tcmalloc 已经使用这个特性来实现跨核心的内存回收。

### 对高核心数时代的意义

128 核、192 核甚至更多核心的处理器正在变得便宜。Ampere Altra 的 128 核 ARM CPU 已经可以在消费级工作站上购买。在这种硬件上，传统的锁和原子操作的扩展性问题会被放大到不可忽视的程度。

rseq 不是一个"锦上添花"的优化——在 128+ 核的机器上，它是实现高性能并发数据结构的**必要条件**。

## 实践建议

### 什么时候该用 rseq？

**适合场景：**
- 内存分配器的线程本地缓存
- 高频计数器（访问量统计、性能指标）
- 线程本地的栈式数据结构（push/pop）
- 任何"按 CPU 分片 + 短临界区"的模式

**不适合场景：**
- 需要跨平台支持的项目（目前仅 Linux）
- 临界区较长的操作（超过约 10 条指令）
- 需要事务性保证的复杂操作（rseq 只保护单次提交）

### 上手路径

1. **先理解分片 + mutex**：这是 rseq 的基础。如果你的分片方案不需要锁就不需要 rseq
2. **阅读 Cosmopolitan 源码**：Justine 的实现是最清晰的教学代码
3. **使用 librseq**：不想写汇编的话，从库开始
4. **在高核心数机器上测试**：rseq 的优势只有在多核下才能体现。4 核笔记本上你看不出区别

### 调试技巧

- 使用 `strace` 检查 `rseq()` 系统调用是否成功注册
- 用 `perf stat` 对比 rseq 和 mutex 方案的缓存未命中率
- 在 abort handler 中加入计数器，监控重试频率——如果重试率超过 1%，说明临界区可能太长

## 总结

Restartable Sequences 代表了一种全新的并发编程范式：不是让用户态自己解决同步问题（锁、原子操作），也不是让内核完全接管（RTOS），而是通过**内核与用户态的协作**，在保持调度灵活性的同时消除同步开销。

它的设计哲学值得深思：最高效的系统调用是**不需要系统调用的系统调用**——通过共享内存实现零开销的双向通信。

随着处理器核心数持续增长，rseq 从"有趣的实验"变成"必要的工具"只是时间问题。如果你是系统程序员，现在就是了解它的最佳时机。

---

*相关阅读：*

- [反压（Backpressure）：让 AI 编码代理自我纠错的系统工程思维](/article/backpressure-ai-coding-agents-2026)
- [从 rsync 到 openrsync：一个工具替换背后的许可证战争、安全哲学与协议困境](/article/openrsync-macos-replacement-2026)
- [Zig 构建系统的双进程革命：从 150ms 到 14ms 的 10 倍提速之路](/article/zig-build-system-rework-2026)
