---
title: "mimalloc：微软研究院的内存分配器如何重新定义高性能并发"
date: 2026-05-16
category: 技术
tags: [内存管理, 性能优化, 并发编程, C语言, 系统编程, 微软研究]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&h=400&fit=crop
---

# mimalloc：微软研究院的内存分配器如何重新定义高性能并发

每个 C/C++ 程序员都写过无数次 `malloc` 和 `free`，但很少有人真正思考过这两个调用背后的代价。当你的服务在高并发场景下出现莫名其妙的性能瓶颈，当你发现多线程程序的 CPU 利用率上不去，当你困惑于为什么"优化了算法"却没换来预期的提速——问题很可能出在那个你从未关注过的内存分配器上。

微软研究院的 Daan Leijen 开发的 mimalloc（发音 "me-malloc"），用不到 12K 行 C 代码，重新定义了现代内存分配器的设计哲学。它不仅在基准测试中全面超越 jemalloc、tcmalloc 等老牌选手，更以其简洁优雅的内部结构，证明了一个深刻的工程真理：**简单往往是复杂问题的最优解**。

## 内存分配：被忽视的性能杀手

### 为什么分配器很重要

在典型的服务器程序中，内存分配操作可能占到总执行时间的 10%-30%。这个数字看起来不大，但它是一个**全局开销**——几乎每个函数调用、每个数据结构的创建都涉及内存分配。更重要的是，在多线程环境下，分配器的效率直接影响程序的可扩展性。

传统的内存分配器（如 glibc 的 ptmalloc2）在高并发场景下表现糟糕。原因很简单：它们使用全局锁来保护共享的空闲列表。当 100 个线程同时请求内存时，它们必须排队等待同一把锁。这就像一个只有一台收银机的超市——无论有多少顾客，吞吐量都被那台收银机限制。

### "内存膨胀"问题

除了锁竞争，传统分配器还面临一个更隐蔽的问题：**blowup（内存膨胀）**。某些分配器在特定工作负载下，已分配但未使用的内存可能膨胀到实际使用量的数倍甚至数十倍。对于运行在内存受限环境中的服务来说，这是一个致命问题。

mimalloc 的设计目标之一就是提供**有界的最坏情况分配时间**和**有界的空间开销**——这意味着它不会在任何情况下出现内存膨胀。

## mimalloc 的核心设计

### 线程本地堆（Thread-Local Heap）

mimalloc 的第一个核心设计原则是：**每个线程拥有自己的堆**。

```
┌─────────────────────────────────────────────┐
│                  mimalloc                     │
│                                               │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Thread 1 │  │ Thread 2 │  │ Thread 3 │   │
│  │  theap   │  │  theap   │  │  theap   │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │         │
│  ┌────▼─────┐  ┌────▼─────┐  ┌────▼─────┐   │
│  │  Pages   │  │  Pages   │  │  Pages   │   │
│  │ (64 KiB) │  │ (64 KiB) │  │ (64 KiB) │   │
│  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────┘
```

每个线程的堆（theap）拥有一组 mimalloc **页面**，每个页面通常为 64 KiB。每个页面包含固定大小的内存块。这种设计的关键优势是：**同一页面内的分配不需要任何锁操作**，因为只有拥有该页面的线程才能从中分配。

### 快速路径：15 条指令的奇迹

mimalloc 的分配函数在最佳情况下只需要约 15 条 x86-64 汇编指令：

```c
void* mi_malloc(size_t size) {
    mi_theap_t* const theap = mi_get_thread_local_theap();
    if (size > MI_MAX_SMALL_SIZE)
        return mi_malloc_generic(theap, size);  // 慢速路径

    const size_t index = (size + sizeof(void*)) / sizeof(void*);
    mi_page_t* const page = theap->pages[index];
    if (page->local_free != NULL) {
        // 快速路径：直接从本地空闲列表分配
        mi_block_t* const block = page->local_free;
        page->local_free = block->next;
        return block;
    }
    return mi_malloc_generic(theap, size);
}
```

对应的汇编代码简洁到令人惊讶：

```asm
mi_malloc:
  movq %rdi, %rsi             ; rsi = size
  movq _mi_theap_default@GOTTPOFF(%rip), %rax
  movq %fs:(%rax), %rdi       ; rdi = 线程本地 theap
  cmpq $1024, %rsi            ; size > MI_MAX_SMALL_SIZE?
  ja .LBB0_generic            ; 跳转到慢速路径

  leaq 7(%rsi), %rax          ; 对齐到 sizeof(void*)
  andq $-8, %rax
  ; ... 继续从空闲列表分配
```

没有函数调用开销，没有锁操作，没有复杂的条件判断——这就是 mimalloc 快的原因。

### 三重空闲列表：精巧的并发设计

每个 mimalloc 页面维护三个独立的空闲列表：

```
┌─────────────────────────────────────┐
│           mimalloc Page (64 KiB)    │
│                                     │
│  ┌──────────────────────────────┐   │
│  │  local_free (本地空闲列表)    │   │  ← 当前线程的快速分配源
│  └──────────────────────────────┘   │
│  ┌──────────────────────────────┐   │
│  │  free (主空闲列表)           │   │  ← 本地释放后的缓冲区
│  └──────────────────────────────┘   │
│  ┌──────────────────────────────┐   │
│  │  thread_free (原子空闲列表)  │   │  ← 其他线程释放的块
│  └──────────────────────────────┘   │
│                                     │
│  ┌────┐ ┌────┐ ┌────┐ ┌────┐       │
│  │block│ │block│ │block│ │block│      │
│  └────┘ └────┘ └────┘ └────┘       │
└─────────────────────────────────────┘
```

**local_free**：当前线程的快速分配源。分配时直接从中取块，释放时如果是当前线程的页面也放回这里。这是最快的路径，完全不需要任何同步操作。

**free**：当 local_free 用尽时，程序会从 free 列表补充。free 列表中的块来自当前线程的释放操作。这种"批量补充"策略减少了频繁切换的开销。

**thread_free**：这是跨线程释放的关键。当线程 A 释放一个属于线程 B 的页面的块时，这个块会被推入 thread_free 列表。这个列表使用**原子 compare-and-swap（CAS）**操作来维护，不需要传统的锁。

### 跨线程释放的优雅处理

```c
void mi_free_cross_thread(mi_page_t* page, mi_block_t* block) {
    mi_block_t* tfree = mi_atomic_load(&page->thread_free);
    do {
        block->next = tfree;  // 将块推入链表头部
    } while (!mi_atomic_compare_and_swap(&page->thread_free,
                                         tfree, block));
}
```

这个设计的精妙之处在于：由于每个页面有独立的 thread_free 列表，而系统中可能有数千个页面，两个线程同时向同一个页面释放块的概率非常低。因此，大多数 CAS 操作都是**无竞争的**——这比使用全局锁高效得多。

## 随机化与缓存局部性

### 随机化的智慧

mimalloc 从随机化算法中汲取了设计灵感。传统的内存分配器试图通过精巧的平衡策略来管理内存，但这些策略往往很复杂且难以维护。mimalloc 采用了更简单的方法：

> 当我们有许多小的、独立的结构时，随机选择通常已经足够平衡。

因为系统中有数千个空闲列表（每个页面一个），随机的概率分布天然地提供了良好的负载均衡。这就像抛硬币——抛一次结果不可预测，但抛一万次正反面几乎各占一半。

### 缓存局部性的胜利

传统分配器的一个常见问题是**缓存行伪共享（false sharing）**。当两个线程分配的对象恰好在同一个缓存行中（通常 64 字节），即使它们操作的是完全不相关的数据，CPU 也必须不断地在核心之间同步缓存行，导致严重的性能下降。

mimalloc 通过以下设计避免了这个问题：

1. **页面隔离**：每个线程的分配集中在自己的页面集合中
2. **64 KiB 页面大小**：远大于缓存行，减少了跨线程的缓存行竞争
3. **per-page 空闲列表**：分配和释放操作都在页面内部完成

在 Emery Berger 的 `cache-scratch` 基准测试中，这个设计的优势得到了充分体现。该测试专门测量分配器诱导的缓存行伪共享，mimalloc 的表现远超大多数竞品。

## 安全特性：不只是快

mimalloc 不仅追求性能，还内置了多层安全防护：

### 加密空闲列表

在安全模式下，mimalloc 会对空闲列表中的指针进行编码，攻击者无法通过堆溢出等漏洞来伪造或篡改空闲列表。

### 守护页（Guard Pages）

mimalloc 支持在对象后面放置操作系统守护页，当发生缓冲区溢出时会立即触发段错误，而不是默默地破坏相邻内存。

### 双重释放检测

内置的双重释放检测机制可以在运行时捕获 `free(ptr); free(ptr);` 这类常见错误。

这些安全特性的性能开销通常只有约 10%——用 10% 的性能换取显著的安全提升，在安全敏感的应用中是非常划算的。

## 实际应用与基准测试

### 谁在用 mimalloc

mimalloc 已经被众多大型项目和服务采用：

- **Bing 搜索引擎**：显著改善了响应时间
- **Azure Cosmos DB**：大规模数据库服务的核心组件
- **CPython**：Python 的默认分配器（通过 Sam Gross 的贡献集成）
- **Unreal Engine**：Epic Games 的游戏引擎
- **Lean 4**：下一代定理证明器
- **Koka**：微软研究院的函数式编程语言

值得注意的是，mimalloc 的 Rust 封装每天有超过 10 万次下载——这说明 Rust 社区也在积极采用它来替代默认的系统分配器。

### 基准测试结果

在微软的基准测试中，mimalloc 在以下场景表现突出：

**xmalloc-test**：模拟真实服务器工作负载的多线程分配测试。mimalloc 的吞吐量是 glibc 的 2-4 倍，同时内存使用量更低。

**larsonN**：模拟服务器处理请求的场景，线程交替进行分配、释放和短暂阻塞。mimalloc 在这种"真实世界"的工作负载中表现尤为出色。

**cache-scratch**：专门测试缓存行伪共享的基准。mimalloc 与 tbb、rpmalloc 并列最优。

**mstressN**：高压力多线程分配测试。mimalloc 保持了稳定的性能，而某些分配器在这种极端场景下会出现显著的性能下降。

## 如何使用 mimalloc

### 作为系统分配器的替代品（零代码修改）

最简单的使用方式是通过 `LD_PRELOAD` 动态替换系统分配器：

```bash
# Linux
LD_PRELOAD=/usr/lib/libmimalloc.so ./your_program

# 或者设置环境变量
export LD_PRELOAD=/usr/lib/libmimalloc.so
```

### 编译时集成

```bash
# 从源码构建
git clone https://github.com/microsoft/mimalloc.git
cd mimalloc
mkdir build && cd build
cmake ..
make
sudo make install

# 在你的项目中链接
gcc -o myapp myapp.c -lmimalloc
```

### CMake 集成

```cmake
# CMakeLists.txt
include(FetchContent)
FetchContent_Declare(
    mimalloc
    GIT_REPOSITORY https://github.com/microsoft/mimalloc.git
    GIT_TAG v3.3.2
)
FetchContent_MakeAvailable(mimalloc)

target_link_libraries(myapp mimalloc)
```

### Rust 项目

```toml
# Cargo.toml
[dependencies]
mimalloc = "0.1"
```

```rust
use mimalloc::MiMalloc;

#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

fn main() {
    // 你的程序，自动使用 mimalloc
}
```

### v3 的新特性：真正的第一类堆

mimalloc v3 引入了**真正的第一类堆**，允许从任何线程在堆中分配。这对于需要按区域管理内存的应用非常有用：

```c
// 创建一个独立的堆
mi_heap_t* heap = mi_heap_new();

// 从任何线程在这个堆中分配
void* p = mi_heap_malloc(heap, size);

// 一次性销毁整个堆（比逐个释放更高效）
mi_heap_destroy(heap);
```

这种模式在解析器、编译器等需要频繁创建和销毁大量临时对象的场景中特别有价值。

## 调试技巧

### 运行时统计

mimalloc 提供了丰富的运行时统计信息：

```bash
# 启用详细统计输出
MIMALLOC_VERBOSE=1 ./your_program

# 显示选项摘要
MIMALLOC_SHOW_STATS=1 ./your_program
```

### 与调试工具的兼容性

mimalloc 完全支持 Valgrind 和 AddressSanitizer（ASAN）：

```bash
# 使用 Valgrind 检测内存泄漏
valgrind --leak-check=full ./your_program

# 使用 ASAN 检测内存错误
gcc -fsanitize=address -o myapp myapp.c -lmimalloc
```

## 最佳实践

1. **先测量，再替换**：虽然 mimalloc 在大多数场景下表现更好，但你的特定工作负载可能有特殊情况。用基准测试验证效果。

2. **选择正确的版本**：
   - **v3**（推荐）：最新的设计，改进了线程间的内存共享
   - **v2**：稳定版本，使用线程本地段减少碎片
   - **v1**：遗留版本，仅维护安全和 bug 修复

3. **考虑安全需求**：如果你的服务处理不可信输入，启用安全模式（加密空闲列表 + 守护页）。

4. **注意内存归还**：mimalloc 默认会将不再使用的内存归还给操作系统。在某些场景下，你可能需要调整 `MIMALLOC_PURGE_DELAY` 选项来平衡性能和内存使用。

5. **测试跨线程模式**：如果你的程序有复杂的线程交互模式（如线程池），确保测试 mimalloc 在这些场景下的表现。

## 总结

mimalloc 的成功证明了一个重要的工程原则：**最好的设计往往是最简洁的设计**。它没有使用复杂的并发数据结构，而是通过精巧的分层设计（线程本地堆 → 页面 → 三重空闲列表）来避免竞争。它没有追求理论上的最优，而是用随机化的简单策略在实践中取得了优异的结果。

对于大多数 C/C++ 项目来说，mimalloc 是一个值得认真考虑的升级。它不需要修改任何代码，只需要在链接时替换分配器，就能带来显著的性能提升——这可能是你能做的投入产出比最高的优化之一。

在 AI 时代，当我们的代码越来越多地由 LLM 生成时，底层运行时的效率变得更加重要。mimalloc 这样的基础设施优化，为上层应用提供了更高的性能天花板。

---

*相关阅读：*

- [当 WebAssembly 吞下整条后端：Python、Node.js 和边缘计算的三重奏](/article/wasm-edge-sandbox-python-nodejs-2026)
- [当编译器开始思考：Rust 项目如何为 LLM 立规矩](/article/rust-compiler-llm-policy-2026)
