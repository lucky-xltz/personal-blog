---
title: "Async Rust 的编译器困境：零成本抽象为何成了空头支票"
date: 2026-05-21
category: 技术
tags: [Rust, 异步编程, 编译器, 性能优化, 状态机, 嵌入式, 系统编程]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# Async Rust 的编译器困境：零成本抽象为何成了空头支票

Rust 的 async/await 语法承诺了"零成本抽象"——用高级语法写出并发代码，编译器帮你生成最优的状态机。然而在实际编译产物中，这个承诺远未兑现。一个简单的 `async { 5 }` 会生成 360 行 MIR 中间代码，而等价的手写 Future 只需 23 行。这种膨胀在服务器上可以忍受，但在嵌入式设备上，每一个字节都至关重要。

本文深入 Rust 编译器的 async 代码生成管线，揭示三个关键的优化缺失——冗余的 Returned/Panicked 状态、缺失的 Future 内联、以及重复状态的合并——并探讨这些改进将如何重塑 Rust 在嵌入式和 WebAssembly 领域的竞争力。

## 一、Async 的承诺与现实

Rust 的 async 设计哲学与其他语言截然不同。Go 有内置的 goroutine 调度器，JavaScript 有 V8 引擎的事件循环，而 Rust 选择了一条更激进的路线：**零运行时开销，完全由编译器负责将 async 代码转换为高效的状态机**。

这个设计目标非常诱人。理论上，你可以写出一段 async 代码，它在服务器上用 tokio 运行，在微控制器上用 embassy 运行，在浏览器里用 wasm-bindgen 运行——同一份代码，零额外开销。

但现实是，编译器生成的 async 状态机远非最优。让我们从一个最简单的例子开始：

```rust
fn foo() -> impl Future<Output = i32> {
    async { 5 }
}

fn bar() -> impl Future<Output = i32> {
    async {
        foo().await + foo().await
    }
}
```

`bar` 函数有两个 await 点，理论上状态机应该只需要两个状态。但编译器生成的 CoroutineLayout 是这样的：

```rust
variant_fields: {
    Unresumed(0): [],   // 初始状态
    Returned (1): [],   // 已完成
    Panicked (2): [],   // 已 panic
    Suspend0 (3): [_s1],     // 在第一个 await 点
    Suspend1 (4): [_s0, _s2], // 在第二个 await 点
}
```

5 个状态，其中 `Returned` 和 `Panicked` 是额外开销。这还只是冰山一角。

## 二、Returned 和 Panicked：被忽视的膨胀源

### Returned 状态的代价

`Future::poll` 是一个 safe 函数。这意味着即使 Future 已经完成，再次调用 `poll` 也不能引发未定义行为。编译器的解决方案是引入一个 `Returned` 状态：当 Future 返回 `Ready` 后，状态切换到 `Returned`；如果再次被 poll，直接 panic。

问题是，**panic 是有成本的**。它引入了一个带有副作用的代码路径，编译器很难将其优化掉。即使在绝大多数情况下，Future 只会被 poll 一次直到完成，这个 panic 路径仍然存在于二进制文件中。

一个更轻量的替代方案是：在 `Returned` 状态下再次 poll 时，简单地返回 `Pending`。这不违反 `Future` 的安全契约——我们只是告诉调用者"还没准备好"，而不是触发一个昂贵的 panic。

在编译器中实现这个改动后，嵌入式固件的二进制大小减少了 **2%-5%**。对于资源受限的设备来说，这已经是一个显著的改进。

### Panicked 状态的代价

`Panicked` 状态的存在是为了防止 catch-unwind 场景下的未定义行为。当一个 async 函数内部 panic 但被 `catch_unwind` 捕获后，这个 Future 不能再被 poll，否则可能处于不一致状态导致 UB。这和 mutex poisoning 是同样的设计思路。

但当使用 `panic = abort` 策略时（这在嵌入式场景中很常见），`catch_unwind` 根本不存在，`Panicked` 状态就变成了纯粹的浪费。理论上，编译器可以在 `panic = abort` 模式下完全移除这个状态。

### 优化建议

这两个问题可以通过编译器选项来控制，类似于现有的 `overflow-checks`：

```toml
[profile.release]
# 在 release 构建中禁用 Returned/Panicked 状态的 panic 行为
async-state-checks = false
```

在 debug 构建中保留 panic 行为以便调试，在 release 构建中用 `Pending` 替代 panic，或在 `panic = abort` 时完全移除 Panicked 状态。

## 三、Future 内联：被错过的最大优化

如果说 Returned/Panicked 是"小优化"，那么 **Future 内联**就是编译器目前缺失的最大性能杠杆。

考虑这个极其常见的模式：

```rust
async fn foo(blah: SomeType) -> OtherType {
    // ...
}

async fn bar(blah: SomeType) -> OtherType {
    foo(blah).await
}
```

在 trait 实现中，这种"将一个 async 函数的签名转换为另一个"的模式无处不在。当前编译器会为 `bar` 生成一个独立的状态机，然后在内部调用 `foo` 的状态机——这完全是浪费。

最优的做法是什么？**直接让 `bar` 返回 `foo` 的 Future**，不做任何包装。

```rust
// 编译器目前生成的（浪费）
enum BarFut {
    Unresumed { blah: SomeType },
    // ... 独立的状态机
}

// 应该生成的（最优）
// bar 的 Future 就是 foo 的 Future，零额外开销
```

当 `bar` 有前置或后置代码时，情况稍复杂但仍然可以优化：

```rust
async fn bar(input: u32) -> i32 {
    let blah = input > 10;  // 前置
    let result = foo(blah).await;
    result * 2  // 后置
}
```

这里 `bar` 不需要自己的 async 状态。它只需要一个 `Unresumed` 状态来存储 `input`，然后直接委托给 `foo` 的 Future：

```rust
enum BarFut {
    Unresumed { input: u32 },
    Inlined { foo: FooFut }
}

impl Future for BarFut {
    type Output = i32;
    
    fn poll(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        loop {
            match self {
                Unresumed { input } => {
                    let blah = input > 10;
                    *self = BarFut::Inlined { foo: foo(blah) };
                },
                Inlined { foo } => {
                    break foo.poll(cx).map(|result| result * 2);
                },
            }
        }
    }
}
```

这比编译器目前生成的版本紧凑得多，而且可以递归应用——如果 `foo` 又委托给了另一个 Future，整个链条可以被压缩。

### 为什么 LLVM 无法弥补？

一个自然的问题是：即使编译器生成了冗余代码，LLVM 的优化器难道不能帮忙清理吗？

答案是：**部分可以，但远远不够**。

LLVM 能在 `opt-level=3` 时优化掉一些简单的 case。但有两个根本性的限制：

1. **async 状态机的转换发生在 MIR 层面，而非 LLVM IR 层面**。async 是 MIR 的语言特性，到 LLVM IR 时已经变成了普通的枚举和 switch 语句。LLVM 需要"重新发现"这些代码实际上是一个状态机，这在复杂场景下几乎不可能。

2. **Future 从不被内联**。每个 async block 独立转换为状态机，然后 LLVM 和链接器才有机会做内联。但到那时，状态机的结构已经固定，内联的机会窗口已经关闭。

用 Godbolt 可以清楚地看到这个问题。即使是 `foo().await + foo().await` 这样简单的代码，LLVM 也无法将最终结果优化为常量 10——因为它无法完全证明 panic 路径不会被执行。

## 四、重复状态合并：一个被忽视的优化

在实际代码中，一个非常常见的模式是：

```rust
pub async fn process_command() {
    match get_command() {
        CommandId::A => send_response(123).await,
        CommandId::B => send_response(456).await,
    }
}
```

编译器为这个函数生成了两个**完全相同**的状态——`Suspend0` 和 `Suspend1`，都持有 `send_response` 的 Future。MIR 长度达到了 456 行，其中大量是重复的基本块。

手动重构为：

```rust
pub async fn process_command() {
    let response = match get_command() {
        CommandId::A => 123,
        CommandId::B => 456,
    };
    send_response(response).await;
}
```

MIR 从 456 行降到 302 行，状态从 2 个减到 1 个，没有任何重复。

这是一个**编译器可以自动完成的优化**：搜索结构相同的状态，将它们合并为一个。这个优化 pass 应该和内联 pass 配合使用，效果会更好。

## 五、嵌入式场景的特殊痛点

在服务器上，这些优化是"锦上添花"。但在嵌入式场景下，它们是"生死攸关"。

嵌入式开发者通常使用 `opt-level="z"` 或 `opt-level="s"` 来优化代码大小。这些优化级别下，LLVM 的优化能力大幅缩水——正好是 async 代码膨胀最严重的时候。

一位 Tweede golf 的嵌入式工程师在实际项目中测量发现，仅通过修改编译器的 Returned 状态行为（用 Pending 替代 panic），就获得了 2%-5% 的二进制大小缩减。对于一个 256KB Flash 的微控制器来说，这可能是"装得下"和"装不下"的区别。

更关键的是，嵌入式 async 生态（如 embassy）正在快速增长。如果编译器不能解决这些基础问题，整个生态的发展都会受到制约。

## 六、与其他语言的对比

### Go 的 goroutine

Go 选择了一条完全不同的路：内建运行时调度器，goroutine 的栈是动态增长的。优点是编程模型简单，缺点是每个 goroutine 有 2-8KB 的初始栈开销。对于高并发场景（百万连接），这个开销不可忽视。

Rust 的 async 状态机理论上是零额外栈开销——但如果我们把编译器生成的冗余状态也算上，"零成本"就打了折扣。

### Zig 的新 IO

Zig 在 async 设计上采取了另一种思路，避免了函数着色问题（function coloring）。Zig 的 async 函数和同步函数使用相同的调用约定，由调用者决定是否并发执行。这避免了 Rust 中"async 病毒传播"的问题——一旦底层库用了 async，所有调用者都被迫 async。

### Java 的虚拟线程

Java 21 引入的虚拟线程（Virtual Threads）又是另一种方案：JVM 自动将虚拟线程调度到平台线程上，程序员写同步代码即可获得并发能力。这本质上是 Go goroutine 模型在 JVM 上的实现。

每种方案都有自己的权衡。Rust 的 async 状态机方案在理论最优性和实际实现之间还有很大的差距需要弥合。

## 七、开发者今天能做什么

在编译器优化落地之前，开发者可以采取一些手动优化策略：

### 1. 减少嵌套的 await 点

```rust
// 差：两个独立的 await，生成两个状态
async fn fetch_and_process() {
    let data = fetch_data().await;
    let result = process(data).await;
}

// 好：如果可能，合并为一个 await
async fn fetch_and_process() {
    let result = fetch_and_process_combined().await;
}
```

### 2. 避免 match/switch 中的重复 await

```rust
// 差：每个分支一个 await，生成多个重复状态
async fn handle(cmd: Command) {
    match cmd {
        A => do_thing_a().await,
        B => do_thing_b().await,
    }
}

// 好：先计算，再统一 await
async fn handle(cmd: Command) {
    let fut = match cmd {
        A => do_thing_a(),
        B => do_thing_b(),
    };
    fut.await;
}
```

### 3. 使用 `#[inline]` 提示

虽然 async 函数的内联机制不完善，但在某些情况下，`#[inline]` 属性可以帮助编译器做出更好的决策。

### 4. 检查 MIR 输出

使用 `rustc -Z dump-mir=your_fn` 来查看编译器为你的 async 函数生成的状态机。如果看到过多的状态或重复的代码块，考虑手动重构。

## 八、编译器优化的未来路线

Rust 项目组已经将 async 状态机优化列为 2026 年的 Project Goal。预计的优化方向包括：

1. **Returned/Panicked 状态的条件生成**：在 `panic = abort` 模式下移除 Panicked 状态；在 release 构建中用 Pending 替代 panic
2. **Future 内联 pass**：在 MIR 层面实现 async 函数的内联，避免不必要的状态机包装
3. **重复状态合并**：搜索结构相同的状态并合并，减少 MIR 和最终二进制的大小
4. **常量 Future 传播**：如果一个 Future 在首次 poll 时总是返回 Ready，消除对应的 await 状态

这些优化需要资金支持。初步估算，约 3 万欧元可以完成大部分工作。对于依赖 Rust 嵌入式或 WebAssembly 的公司来说，这是一笔回报率极高的投资。

## 总结

Rust 的 async 设计在理念上是正确的——零运行时、编译时状态机、跨平台复用。但编译器的实现还停留在 MVP 阶段，距离"零成本抽象"的承诺还有明显的差距。

三个关键优化——返回状态的轻量化、Future 内联、重复状态合并——如果能够落地，将显著改善 async 代码的二进制大小和运行性能，特别是在嵌入式和 WebAssembly 这类资源受限的场景中。

对于今天的 Rust 开发者来说，理解编译器生成的 async 状态机结构是写出高效代码的前提。不要盲目信任"零成本抽象"的承诺——查看 MIR 输出，手动优化关键路径，在必要时回退到手写 Future。

async Rust 的未来是光明的，但它需要编译器团队和社区的共同努力来兑现最初的承诺。

---

*相关阅读：*

- [Bun 从 Zig 到 Rust 的百万行重写](/article/bun-zig-to-rust-rewrite-2026)
- [NTSYNC 与 Linux 内核的 Windows 化](/article/ntsync-linux-kernel-gaming-2026)
- [PostgreSQL 非常规优化：三个被忽视的性能提升技巧](/article/postgresql-unconventional-optimizations-2026)
