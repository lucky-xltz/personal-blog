---
title: "Bun 从 Zig 迁移到 Rust：一个大型运行时项目跨语言重写的深度解析"
date: 2026-05-05
category: 技术
tags: [Bun, Rust, Zig, JavaScript运行时, 跨语言迁移, 系统编程]
author: 林小白
readtime: 15
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# Bun 从 Zig 迁移到 Rust：一个大型运行时项目跨语言重写的深度解析

2026年5月5日，Bun 创始人 Jarred Sumner 提交了一个震动前端工程圈的 commit：`docs: add Phase-A porting guide`——一份长达 576 行的 Zig-to-Rust 迁移指南。这意味着 Bun，这个拥有 89,600+ GitHub Star 的 JavaScript 运行时，正式开始了从 Zig 到 Rust 的大规模重写。

本文将深入分析这份迁移指南的技术细节、架构设计决策，以及它对系统编程社区的启示。

## 背景：为什么 Bun 要换语言？

Bun 最初选择 Zig 是有充分理由的：

- **极致的控制力**：Zig 给予开发者接近 C 级别的内存控制，没有隐藏的分配
- **C 互操作性**：Zig 可以直接编译 C 代码，Bun 依赖的 JavaScriptCore (JSC) 引擎是 C++ 写的
- **编译速度快**：Zig 的编译速度远快于 Rust，迭代体验更好

但 Zig 的生态不成熟带来了持续的痛点：

1. **编译器 Bug 频发**：开发团队多次被 Zig 编译器的 bug 阻塞
2. **工具链不稳定**：Zig 的包管理器、LSP、调试工具都不够成熟
3. **人才池太小**：相比 Rust，Zig 开发者数量少了一个数量级
4. **AI 辅助编码**：Rust 在 AI 编码助手（如 Claude、Copilot）中的训练数据远多于 Zig

尤其最后一点——在 AI 辅助编程日益普及的今天，语言生态中的 AI 工具支持能力已经成为重要的技术选型因素。

## Phase-A 策略：先写对，再跑通

迁移指南最引人注目的设计是**两阶段策略**：

### Phase A：草稿阶段（不需要编译）

> 目标：在 .zig 文件旁边创建一个 .rs 文件，忠实捕获逻辑——不需要能编译。

这听起来反直觉，但非常务实。对于一个拥有数百万行 Zig 代码的项目来说，"先让所有代码存在于 Rust 中"比"先让一小部分能编译并运行"更有价值。原因：

- **全局视角**：Phase A 完成后，团队可以全面审视整个 Rust 代码库的结构
- **并行推进**：多个模块可以同时进行翻译，不需要等待依赖关系
- **降低风险**：草稿阶段不涉及实际运行，避免了增量迁移中"部分 Zig + 部分 Rust"的调试噩梦

### Phase B：逐 crate 编译

Phase A 完成后，Phase B 逐个 crate 地修复编译错误、添加生命周期注释、优化性能。

## 文件命名规则：保持目录结构一致

迁移指南规定了一个精妙的命名规则：

```
Zig 文件路径：src/<area>/.../<Name>.zig
Rust 文件路径：src/<area>/.../mod.rs 或 lib.rs
```

具体规则：

- 如果 `.zig` 的 basename 与其**直接父目录**同名，命名为 `mod.rs`
- 如果 basename 与**顶层 `<area>`** 同名，命名为 `lib.rs`
- 否则，命名为 `<basename>.rs`

示例：

```
src/bake/DevServer/HmrSocket.zig → src/bake/DevServer/HmrSocket.rs
src/bake/DevServer/DevServer.zig → src/bake/DevServer/mod.rs
src/http/http.zig                → src/http/lib.rs
```

这种设计让 Rust 的模块系统与 Zig 的目录结构保持一致，reviewer 可以方便地进行 `.zig` 与 `.rs` 的逐行对比。

## Crate 映射：Bun 的 Rust 架构蓝图

迁移指南中最令人印象深刻的是它的 **crate 映射表**。Bun 将其庞大的代码库拆分为约 20 个 Rust crate：

```rust
// crate 映射（节选）
bun::String, bun::strings, ZigString  → bun_str
bun::sys, bun::FD, Maybe(T)           → bun_sys
bun::jsc, JSValue, JSGlobalObject     → bun_jsc
bun::uws, us_socket_t                 → bun_uws_sys / bun_uws
bun::http                             → bun_http
bun::bake                             → bun_bake
bun::install                          → bun_install
bun::shell                            → bun_shell
bun::bundle_v2, Transpiler            → bun_bundler
```

这意味着 Bun 的 Rust 版本将是一个**高度模块化**的项目，每个 crate 负责一个明确的功能域。这是典型的 Rust 大项目架构模式——与 Servo、rustc 本身的设计哲学一致。

## 最有趣的禁止列表

迁移指南中有一段堪称"禁令清单"的内容，揭示了 Bun 的架构哲学：

```text
禁止使用：
- tokio, rayon, hyper, async-trait, futures
- std::fs, std::net, std::process
- async fn
```

### 为什么禁止 `async fn`？

这可能是最反直觉的决定。但 Bun 拥有自己的事件循环（基于 libuv 的自研版本），所有的 I/O 操作都通过回调 + 状态机完成。在 Zig 中，这种模式是自然的；而在 Rust 中，`async/await` 看起来更优雅，但会引入 `tokio` 等运行时依赖，与 Bun 的事件循环产生冲突。

```zig
// Zig 原始代码（回调模式）
fn onData(socket: *Socket, data: []const u8) void {
    // 处理数据...
    socket.send(response) catch {};
}
```

```rust
// Rust 翻译（保持回调模式，不使用 async）
fn on_data(socket: &mut Socket, data: &[u8]) {
    // 处理数据...
    if let Err(e) = socket.send(response) {
        // 错误处理...
    }
}
```

### 为什么禁止 `std::fs`？

Bun 的所有系统调用都是直接的——它不使用标准库的文件系统抽象，而是直接调用 `openat`、`read`、`write` 等系统调用。这在 Rust 中对应的是 `bun_sys` crate 中的封装：

```rust
// 不要这样写：
let content = std::fs::read_to_string("file.txt")?;

// 而是这样写（与 Zig 行为一致）：
let fd = bun_sys::openat(dirfd, path, O_RDONLY, 0)?;
let n = bun_sys::read(fd, &mut buf)?;
```

## 类型映射：Zig 到 Rust 的对应关系

迁移指南提供了一套详尽的类型映射表，以下是几个关键映射：

### 字符串处理

Zig 的 `[]const u8` 在不同上下文中映射为不同的 Rust 类型：

```rust
// 函数参数/返回值 -> &[u8]
fn process(data: &[u8]) -> &[u8] { ... }

// 结构体字段 -> 取决于生命周期
struct Foo {
    // 如果 deinit 中调用了 allocator.free(self.name)
    name: Box<[u8]>,          // 所有权语义

    // 如果从不释放，只赋值字面量
    name: &'static [u8],      // 静态生命周期

    // CSS/解析器中的 arena 分配
    name: *const [u8],        // 原始指针，arena 管理
}
```

### 指针类型

```rust
// Zig 的引用计数指针
bun.ptr.Shared(T)  -> Arc<T>    // 线程安全引用计数
bun.ptr.Owned(T)   -> Box<T>    // 独占所有权
bun.ptr.WeakPtr(T) -> Weak<T>   // 弱引用

// Zig 的原子指针
bun.ptr.AtomicShared(T) -> Arc<T>  // Arc 本身就是原子的
```

### 错误处理

Zig 的错误联合 `!T` 映射为 Rust 的 `Result<T, E>`，但有一个重要的例外——out-param 构造函数：

```zig
// Zig 中的 out-param 模式
pub fn init(this: *@This()) !void {
    this.* = .{
        .field1 = try computeValue(),
        .field2 = defaultValue,
    };
}
```

```rust
// Rust 中转换为 Result 返回
pub fn init() -> Result<Self, Error> {
    Ok(Self {
        field1: compute_value()?,
        field2: default_value,
    })
}
```

迁移指南解释了原因：Zig 使用 out-param 是因为它没有保证的 NRVO（命名返回值优化）用于错误联合；而 Rust 没有这个问题。

## Borrow Checker 策略

迁移指南对 Rust 借用检查器给出了实用的指导：

> 当匹配 Zig 的控制流产生重叠的 &mut 时：
> 1. 捕获需要的标量值（.len()、index）到局部变量
> 2. 释放借用
> 3. 重新借用
>
> 不要为了满足 borrowck 而使用原始指针。
> 留下 `// PORT NOTE: reshaped for borrowck` 注释。

示例：

```rust
// 错误的做法：用原始指针绕过 borrowck
let ptr = vec.as_mut_ptr();
unsafe { (*ptr).push(item); }

// 正确的做法：先保存长度，释放借用，再操作
let len = vec.len();
vec.reserve(1);
// PORT NOTE: reshaped for borrowck
vec[len] = item;
```

## 性能标记系统

迁移指南设计了一个巧妙的性能标记系统：

```rust
// 标记需要在 Phase B 优化的代码
// PERF(port): appendAssumeCapacity - profile in Phase B
vec.push(item);  // Phase A 用普通 push

// Phase B 会 grep 所有 PERF(port) 注释，逐个 benchmark
```

这确保了 Phase A 专注于正确性，Phase B 专注于性能——而不是同时追求两个目标导致两者都做不好。

## AI 辅助迁移：新范式的诞生

这份迁移指南的另一个亮点是它**明确为 AI 编码助手设计**。指南的开头就是：

> "You are translating one Zig file to Rust."

它假定读者是一个 AI agent（或者被 AI 辅助的人类开发者），并提供了精确的、可执行的指令。配合 `scripts/port-batch.ts` 脚本，Bun 可以批量地将 Zig 文件交给 AI 进行翻译。

这代表了软件工程的一个新范式：**AI 驱动的大规模代码迁移**。过去需要数百人年才能完成的跨语言重写，现在可能在几个月内由 AI 完成初稿，人类工程师专注于 review 和优化。

## 对开发者的启示

### 1. 语言选型要考虑生态成熟度

Zig 是一门优秀的语言，但生态的不成熟最终迫使 Bun 迁移。在选择系统编程语言时，除了语言本身的特性，还需要考虑：

- 工具链的稳定性
- 社区规模和活跃度
- AI 编码工具的支持程度
- 长期维护的人才可获得性

### 2. 大规模迁移需要分阶段策略

Bun 的 Phase-A / Phase-B 策略值得所有面临类似迁移的团队学习：

- **Phase A** 解决"所有代码存在于新语言中"的问题
- **Phase B** 解决"代码能编译运行"的问题
- 两个阶段分离，降低了复杂度

### 3. 代码迁移应该保持结构一致性

迁移指南反复强调"保持相同的函数名、字段顺序、控制流"。这对于代码 review 至关重要——reviewer 可以逐行对比 `.zig` 和 `.rs`，而不是试图理解两个完全不同的实现。

### 4. 为 AI 编码助手设计文档

Bun 的迁移指南可能是第一份**明确为 AI agent 编写**的大型工程文档。它包含：

- 精确的规则（没有歧义）
- 映射表（可查表执行）
- 禁止列表（明确的边界）
- 标记系统（可追踪的 TODO）

## 总结与展望

Bun 从 Zig 到 Rust 的迁移是 2026 年最值得关注的工程事件之一。它不仅影响 Bun 自身的发展方向，也将成为 AI 驱动代码迁移的标杆案例。

几个值得持续关注的问题：

1. **迁移进度**：Phase A 预计多久完成？Phase B 的编译成功率如何？
2. **性能变化**：Rust 版本的 Bun 能否保持甚至超越 Zig 版本的性能？
3. **社区反应**：这会加速 Rust 在 JavaScript 工具链中的渗透吗？
4. **AI 工具验证**：AI 生成的 Rust 代码质量如何？需要多少人工修正？

无论最终结果如何，Bun 的这次迁移都为大型开源项目的跨语言重写提供了宝贵的经验和参考。

---

*相关阅读：*

- [WebGPU 深度实战：浏览器中的下一代图形与计算引擎](/article/webgpu-next-gen-web-graphics-compute-2026)
- [MCP：统一 AI 工具集成的开放协议](/article/mcp-unified-tool-integration-for-ai)
