---
title: "Bun 从 Zig 到 Rust 的百万行重写：AI 驱动的运行时迁移意味着什么？"
date: 2026-05-19
category: 技术
tags: [Bun, Rust, Zig, JavaScript运行时, AI编程, 代码迁移, 系统编程]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# Bun 从 Zig 到 Rust 的百万行重写：AI 驱动的运行时迁移意味着什么？

2026 年 5 月，JavaScript 运行时 Bun 的创始人 Jarred Sumner 在 GitHub 上提交了一个 PR：`Rewrite Bun in Rust`。这个 PR 包含 **1,009,257 行新增代码**、**4,024 行删除**、**6,755 个 commits**、**2,188 个文件变更**——而且它被合并了。

更令人震惊的是，这次迁移的主要执行者不是一支工程师团队，而是 **Claude**——Anthropic 的 AI 助手。整个过程从实验到合并，仅用了不到两周。

这件事在技术社区引发了剧烈争议。有人称之为"软件工程史上最大的错误"，也有人认为这是"编程范式的转折点"。真相可能介于两者之间。

## Bun 的前世今生：为什么选择 Zig，又为什么离开？

### Zig 的吸引力

Bun 诞生于 2022 年，目标是成为 Node.js 和 Deno 的高性能替代品。Jarred Sumner 选择 Zig 作为实现语言，理由很充分：

- **极致的性能控制**：Zig 提供了接近 C 的底层控制能力，但语法更现代
- **编译时内存安全**：虽然不如 Rust 的 borrow checker 严格，但比裸 C 好得多
- **简单直接的编译模型**：没有隐藏的控制流、没有隐藏的内存分配
- **与 C 的完美互操作**：可以直接调用 C 库，无需 FFI 开销

Bun 用 Zig 实现了令人印象深刻的性能：启动速度比 Node.js 快 4 倍，npm 安装速度提升 25 倍，HTTP 请求吞吐量提升 3.5 倍。

### Zig 的痛点

然而，随着 Bun 的代码库增长到数十万行，Zig 的问题逐渐暴露：

**1. 编译器不够成熟**。Zig 仍处于 0.x 阶段，编译器 bug 频繁出现。Bun 甚至不得不维护一个自己的 Zig 分支来规避这些问题。

**2. 内存安全问题依旧存在**。虽然 Zig 比 C 好，但它没有 Rust 那样的编译期所有权系统。Bun 团队在调试内存 bug 上花费了大量时间——use-after-free、double-free、buffer overflow 等问题反复出现。

**3. 生态系统薄弱**。Zig 的包管理器和第三方库远不如 Rust 的 crates.io 丰富。很多功能需要自己从头实现。

**4. 社区规模小**。招一个会 Zig 的工程师比招一个会 Rust 的工程师难得多。

正如一位 Bun 核心贡献者所说：

> Bun has had an extremely high amount of crashes/memory bugs due to them using Zig, unlike Deno which is Rust.

## 重写的技术细节：如何把百万行 Zig 变成 Rust？

### 整体策略

这次重写采用了几个关键策略：

**保持架构不变**。PR 描述明确指出："The codebase is otherwise largely the same. The same architecture, the same data structures." Bun 的整体架构——事件循环、模块解析、JavaScript 引擎绑定——都没有改变。改变的是实现这些架构的语言。

**不使用 async Rust**。这是一个大胆的选择。Rust 的 async 生态（tokio、async-std）非常成熟，但 Bun 选择不使用它们。原因可能是：

- Bun 已经有自己的事件循环实现（基于 libuv/io_uring）
- async Rust 会引入额外的复杂性（Pin、Future、生命周期标注）
- 直接使用系统调用可能更高效

**通过现有测试套件验证**。这是最关键的一点。Bun 之前积累了大量的测试用例，这些测试用例成为了重写的"安全网"。最终结果：**Linux x64 glibc 平台通过 99.8% 的测试**。

### 二进制体积优化

一个意外的收获是二进制体积缩小了 **3MB 到 8MB**。这主要是因为：

- Rust 的标准库比 Zig 的更紧凑
- Rust 的零成本抽象减少了冗余代码
- LLVM 对 Rust 代码的优化更成熟

### 性能表现

PR 描述中提到 "the benchmarks are between neutral and faster"。这意味着在大多数场景下，Rust 版本的性能与 Zig 版本持平，某些场景甚至更快。

这并不令人意外。Rust 和 Zig 都是系统级语言，都能生成高效的机器码。性能差异主要取决于具体的实现细节，而非语言本身。

## AI 在这次重写中的角色：工具还是主导者？

### Claude 的工作方式

从 PR 的 commit 历史可以看出，这次重写主要由 Claude 完成。一个令人印象深刻的细节是：Bun 的 CI 系统自动将 Zig 源文件的提交标记为 "ai slop"（AI 生成的低质量代码），这引发了一轮热议。

Claude 在这次重写中的工作模式大致是：

1. **逐文件翻译**：将 Zig 源文件翻译成等价的 Rust 代码
2. **处理类型系统差异**：Zig 的 comptime 和 Rust 的泛型系统有本质区别
3. **管理内存模型**：Zig 的手动内存管理 vs Rust 的所有权系统
4. **修复测试失败**：当测试不通过时，调整代码（有时也调整测试）

### 社区的担忧

社区对 AI 驱动的重写提出了多个尖锐问题：

**代码质量**。"If this goes wrong even in the slightest, the ridicule about a drug dealer getting high on their own supply will be neverending." 这条评论一针见血——Anthropic 是 Claude 的创造者，而 Bun 是 Claude Code 的运行时。如果这次重写出问题，Anthropic 的产品可信度将受到严重打击。

**维护性**。"How they gonna do refactoring, bugfix or other maintenance on generated code? Ask LLM?" 这是一个根本性的问题。AI 可以生成代码，但理解和维护这些代码仍然需要人类工程师。

**测试覆盖度**。"I just want to comment that I think it's a good change if we look past the AI involvement... the first thing it makes me wonder is how comprehensive/high quality the test suite is to begin with." 99.8% 的测试通过率听起来很高，但如果测试本身覆盖不全，通过率高也不代表质量高。

**unsafe 的使用**。"Why didn't they ask Claude to remove all of the `unsafe` at the same time??" Rust 的 `unsafe` 关键字允许绕过借用检查器。如果大量使用 `unsafe`，Rust 的内存安全优势将大打折扣。

## Rust 不是银弹：从 uutils 的 44 个 CVE 说起

就在 Bun 重写消息传出的同一时期，另一个 Rust 项目也在经历阵痛。

2026 年 4 月，Canonical 披露了 **uutils**（Rust 重写的 GNU coreutils）的 **44 个 CVE**。这些漏洞全部通过了 Rust 的借用检查器、clippy lint 和 cargo audit 的检测——也就是说，Rust 的编译期安全保证完全没有捕获它们。

### TOCTOU：文件系统操作的定时炸弹

最常见的漏洞类型是 **TOCTOU（Time Of Check To Time Of Use）**。以下是简化版的漏洞代码：

```rust
// 步骤 1：检查目标文件
fs::remove_file(to)?;

// ... 某些操作 ...

// 步骤 2：创建新文件
// 危险！路径可能已被替换为符号链接！
let mut dest = File::create(to)?;
copy(from, &mut dest)?;
```

在步骤 1 和步骤 2 之间，攻击者可以将 `to` 替换为指向 `/etc/shadow` 的符号链接。`File::create` 会跟随符号链接，导致特权进程覆盖任意文件。

修复方案是使用 `create_new`：

```rust
let mut dest = OpenOptions::new()
    .write(true)
    .create_new(true)  // 如果路径已存在（包括符号链接），则失败
    .open(to)?;
```

### Rust 的安全边界

这些 bug 揭示了一个重要事实：**Rust 的安全保证是有限的**。它能防止内存安全问题（use-after-free、数据竞争），但无法防止：

- **逻辑错误**：算法实现不正确
- **TOCTOU 竞态**：文件系统操作的时序问题
- **语义错误**：不理解 API 的正确用法
- **编码问题**：路径处理、字符串编码的边界情况

正如文章作者所说：

> If you write systems code in Rust, this is the most concentrated look at where Rust's safety ends that you'll likely find anywhere right now.

## 行业趋势：Rust 的全面崛起

Bun 的重写并非孤例。2026 年，Rust 正在经历前所未有的采用浪潮：

### Linux 内核

**"Rust in the kernel is no longer experimental"**——这个 HN 帖子获得了 962 个赞。Linux 内核中的 Rust 支持已经从实验性功能升级为正式支持的特性。多个驱动程序已经用 Rust 重写。

### Ladybird 浏览器

另一个引发关注的项目是 **Ladybird**（一个独立的浏览器引擎），它宣布采用 Rust，并且在 AI 的帮助下完成了迁移。这获得了 1274 个赞。

### 系统工具

除了 uutils，还有大量系统工具正在迁移到 Rust：

- **ripgrep**：比 grep 快 10 倍的搜索工具
- **fd**：比 find 更友好的文件查找工具
- **bat**：带语法高亮的 cat 替代品
- **delta**：更好的 git diff 查看器
- **zoxide**：智能的 cd 替代品

### 商业公司

越来越多的商业公司也在采用 Rust：

- **Cloudflare**：用 Rust 重写了部分网络基础设施
- **Discord**：用 Rust 重写了消息缓存服务
- **AWS**：Firecracker 虚拟化平台用 Rust 编写
- **Microsoft**：正在用 Rust 重写 Windows 核心组件

## 对开发者的启示

### 1. 测试是重写的安全网

Bun 的成功迁移很大程度上归功于其全面的测试套件。如果你正在考虑重写某个项目，第一件事不是写新代码，而是确保现有测试覆盖足够全面。

### 2. AI 是工具，不是替代品

Claude 在这次重写中扮演了重要角色，但人类的监督和决策仍然至关重要。AI 可以生成代码，但理解业务逻辑、设计架构、做出权衡——这些仍然是人类的工作。

### 3. 语言选择不是永久的

Bun 从 Zig 迁移到 Rust，说明技术选择不是永久的。好的架构设计应该让语言迁移成为可能——保持模块化、接口清晰、依赖可替换。

### 4. 性能不是唯一的考量

Bun 选择 Zig 最初是因为性能，但最终转向 Rust 是因为内存安全和生态系统。在实际项目中，可维护性、安全性、团队熟悉度往往比极致性能更重要。

### 5. 理解工具的局限性

Rust 的借用检查器是强大的安全工具，但它不是万能的。理解工具的边界，知道什么问题需要额外的防护措施（如测试、代码审查、fuzzing），比盲目信任工具更重要。

## 未来展望

Bun 的 Rust 重写仍在进行中。PR 描述中提到还有优化工作和清理工作需要完成。但这次迁移已经给行业带来了几个重要信号：

1. **AI 驱动的大规模代码迁移已经成为现实**。之前被认为"不可能完成"的重写任务，现在可以在两周内完成。
2. **Rust 正在成为系统编程的默认选择**。从操作系统到浏览器引擎，从数据库到运行时，Rust 的采用率正在快速增长。
3. **测试基础设施的价值被重新认识**。没有全面的测试套件，任何重写都是在赌博。

对于开发者来说，这是一个既令人兴奋又令人不安的时刻。兴奋的是，我们拥有了前所未有的工具来加速开发。不安的是，这些工具的可靠性和长期影响仍然未知。

但有一点是确定的：**技术的演进不会等待任何人**。无论你对 AI 编程持何种态度，了解这些工具的能力和局限性，都是这个时代开发者的必修课。

---

*相关阅读：*

- [AI Agent 的阿喀琉斯之踵：MCP 漏洞与数据投毒如何威胁你的整个技术栈](/article/ai-security-mcp-poisoning-2026)
- [PostgreSQL 非常规优化：三个被忽视的性能提升技巧](/article/postgresql-unconventional-optimizations-2026)
- [Docker Compose 生产环境实战指南（2026）](/article/docker-compose-production-2026-guide)
