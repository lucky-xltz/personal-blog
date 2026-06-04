---
title: "Elixir v1.20：集合论类型系统的渐进式革命——不写类型注解也能抓 Bug"
date: 2026-06-04
category: 技术
tags: [Elixir, 类型系统, 函数式编程, BEAM, 编程语言, 静态分析]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# Elixir v1.20：集合论类型系统的渐进式革命

> 一门动态语言花了四年时间，从一篇获奖论文走到生产可用的类型检查器，不是为了让你写更多类型注解，而是为了在你一行注解都不写的情况下，免费帮你找到那些「只要执行到就必定崩溃」的 Bug。

2026 年 6 月 3 日，Elixir v1.20 正式发布。这个版本的意义远超一次常规迭代——它标志着 Elixir 正式迈入「渐进类型化语言」的行列，成为继 TypeScript、Python（mypy）、Ruby（Sorbet）之后，又一个在动态语言基础上引入类型系统的重量级选手。

但 Elixir 的做法与前辈们截然不同。

## 一、四年磨一剑：从论文到生产

故事要从 2022 年说起。那一年，Elixir 核心团队宣布启动集合论类型系统（Set-Theoretic Types）的研究工作。2023 年 6 月，他们发表了一篇获奖论文，阐述了 Elixir 类型系统的设计理念，随后从研究阶段转入开发。

这个时间线本身就值得玩味。大多数语言的类型系统要么从一开始就内置（Rust、Go、Haskell），要么通过外部工具渐进添加（TypeScript 之于 JavaScript，mypy 之于 Python）。Elixir 选择了一条更谨慎的路：先做研究，发表论文，获得学术界的认可，再用四年时间将理论落地。

v1.20 是第一个开发里程碑。它的核心目标很明确：**在不引入类型注解的前提下，对每个 Elixir 程序执行类型推断和渐进类型检查**。

这意味着什么？你现有的 Elixir 代码，不需要改一行，升级到 v1.20 后编译器就会自动开始发现死代码和已验证 Bug（Verified Bugs）——那些只要执行到就必然在运行时崩溃的代码路径。

## 二、`dynamic()` 不是 `any()`：Elixir 的渐进类型哲学

要理解 Elixir 类型系统的精妙之处，首先要搞清楚 `dynamic()` 到底是什么。

大多数渐进类型系统有一个 `any()` 类型，意思是「什么都可以」，类型检查器对它完全放行。TypeScript 的 `any` 就是典型——一旦变量被标记为 `any`，所有类型检查都被跳过。

Elixir 的 `dynamic()` 完全不同。它有两个关键属性：

### 2.1 兼容性（Compatibility）

```elixir
def percentage_or_error(value) when is_integer(value) do
  value_or_error =
    if value > 1 do
      value
    else
      "not well"
    end

  if value > 1 do
    value_or_error / 100
  else
    String.upcase(value_or_error)
  end
end
```

在上面的代码中，`value_or_error` 的类型是 `integer() 或 binary()`。`/` 运算符只接受数字，`String.upcase` 只接受字符串。一个严格的静态类型系统会报告两个类型违规。

但这段代码在运行时完全没问题——当 `value > 1` 时走 `/` 路径（此时 `value_or_error` 是整数），否则走 `String.upcase` 路径（此时是字符串）。

Elixir 的处理方式是将 `value_or_error` 标记为 `dynamic(integer() 或 binary())`。当用 `dynamic()` 类型调用函数时，**只有当接受类型和供给类型完全不相交时，才会报告类型违规**。因为 `dynamic(integer() 或 binary())` 可能是整数，而 `/` 接受数字，两者有交集，所以不报错。

但如果你写成：

```elixir
Map.fetch!(value_or_error, :some_key)
```

`Map.fetch!` 期望 map 类型，而 `value_or_error` 只可能是整数或字符串——两者完全不相交，这就是一个**已验证 Bug**，编译器会立即报告。

### 2.2 收窄（Narrowing）

这是 Elixir 类型系统最精妙的设计。`dynamic()` 不是一个静态的「我不知道」标记，而是一个可以随着代码执行不断收窄的范围。

```elixir
def add_a_and_b(data) do
  data.a + data.b
end
```

`data` 初始类型是 `dynamic()`。当代码使用 `data.a` 和 `data.b` 并将它们传给 `+` 运算符时，Elixir 会将 `data` 收窄为 `%{..., a: number(), b: number()}`——一个至少包含 `a` 和 `b` 两个数值字段的 map。

如果你漏写了 `.b`：

```elixir
def add_a_and_b(data) do
  data.a + data
end
```

`data` 先被收窄为 `%{..., a: number()}`，然后试图被当作 `number()` 使用——类型违规，编译器报告错误。

用 Elixir 团队的话说：**`dynamic()` 类型本质上是一个范围，随着程序的使用不断收窄，当类型检查落在范围之外时就报告违规**。这与其他渐进类型系统用 `dynamic` 丢弃所有类型信息的做法形成鲜明对比。

## 三、不只是理论：12/13 项基准测试通过

理论很美，但实际效果如何？Elixir 团队引用了 "If T: Benchmark for Type Narrowing" 基准测试——这是一个专门评估类型系统收窄能力的学术基准。

**Elixir 通过了 13 个类别中的 12 个**，表明它能够从普通的 Elixir 代码中恢复精确的类型信息。这不是一个玩具实现，而是一个在类型收窄能力上达到业界领先水平的类型系统。

在 HN 评论区，一位开发者问到渐进类型系统是否会改变程序的渐进复杂度（这是 Racket 等系统的已知问题）。Elixir 团队成员回应：Elixir 的类型系统**不会改变程序的渐进复杂度**，因为它的设计明确排除了导致其他系统性能下降的机制——在静态/动态边界插入运行时类型转换（runtime casts）。

这意味着你享受类型检查的安全性，但不需要付出运行时性能的代价。

## 四、Guard、Clause 和模式匹配的类型推断

v1.20 的类型推断覆盖了 Elixir 的核心语法结构：

### Guard 推断

```elixir
# 推断 x 是 list，y 是 integer
def example(x, y) when is_list(x) and is_integer(y)

# 推断 x 是 binary 或 integer，y 是 {:ok, binary | integer}
def example({:ok, x} = y) when is_binary(x) or is_integer(x)

# 推断 x 是包含 :foo 键的 map
def example(x) when is_map_key(x, :foo)

# 推断 x 是不包含 :foo 键的 map
def example(x) when not is_map_key(x, :foo)
# 此时 x.foo 会在函数体内触发类型违规
```

注意最后这个例子——Elixir 能够从 `not is_map_key(x, :foo)` 推断出 `x` 的类型是 `%{..., foo: not_set()}`，这意味着在函数体内访问 `x.foo` 必然会失败。

### Clause 收窄

```elixir
case System.get_env("SOME_VAR") do
  nil -> :not_found
  value -> {:ok, String.upcase(value)}
end
```

`System.get_env/1` 返回 `nil | binary()`。第一个 clause 匹配了 `nil`，类型系统知道 `value` 不再可能是 `nil`，因此必须是 `binary()`——`String.upcase` 的类型检查通过。这种跨 clause 的收窄也帮助类型系统找到冗余的 clause 和死代码。

### 数据结构大小断言

```elixir
def example(x) when tuple_size(x) < 3
# 类型系统追踪到 x 最多两个元素
# elem(x, 3) 会触发类型违规
```

## 五、与 TypeScript 的对比：殊途同归还是分道扬镳？

HN 评论区的一个高频讨论是：这和 TypeScript 有什么区别？

表面上看，两者都是在动态语言上加类型。但实现路径完全不同：

| 维度 | TypeScript | Elixir v1.20 |
|------|-----------|-------------|
| 类型注解 | 必须手写才有效果 | 完全不需要，自动推断 |
| 类型系统 | 结构化类型（Structural） | 集合论类型（Set-Theoretic） |
| `any`/`dynamic` | `any` 放弃所有检查 | `dynamic()` 仍做收窄和检查 |
| 运行时影响 | 编译后移除，零运行时开销 | 同样零运行时开销 |
| 发现的错误 | 类型不匹配 | 已验证 Bug（执行必崩） |
| 渐进迁移 | 需要逐步加 `// @ts-check` | 升级编译器即可 |

一位 HN 用户的评论很精辟：TypeScript 是我最喜欢的类型系统，因为它必须支持人们在无类型语言中做的那些疯狂事情。Elixir 走了一条更学术的路——集合论类型系统基于并集、交集和否定运算，理论上更优雅，但能否在实际工程中达到 TypeScript 的易用性，还需要时间验证。

## 六、Elixir vs Gleam：类型化 BEAM 的两条路

另一个热议话题是：Elixir 加了类型系统后，还有必要用 Gleam 吗？

Gleam 是一个从零开始设计的类型化 BEAM 语言，语法类似 Rust，编译到 Erlang 和 JavaScript。它的类型系统是完全静态的，没有 `dynamic()` 的概念。

但 Gleam 的生态系统远不如 Elixir 成熟。Phoenix 框架、LiveView、Ecto（数据库层）——这些 Elixir 生态的核心组件在 Gleam 中要么不存在，要么体验不佳。

正如一位用户所说：你写 Gleam 的感觉像写 Rust，写 Elixir 的感觉像写 Erlang。如果你只关心类型，用 Gleam。但为什么不直接用 Rust 呢？

v1.20 让 Elixir 在「保持生态优势」和「获得类型安全」之间找到了平衡。你不需要放弃 Phoenix 和 LiveView，就能获得渐进的类型检查。

## 七、编译速度：BEAM 生态最快

除了类型系统，v1.20 还带来了一个容易被忽视的改进：**编译速度再次提升**，特别是在多核机器上。Elixir 团队声称，他们的合成基准测试现在将 Elixir 的构建工具定位为 BEAM 生态中最快的。

此外，v1.20 引入了一个新的编译器选项 `:module_definition`，可以设置为 `:interpreted` 以进一步提升大项目的编译时间。这个选项不影响写入磁盘的 `.beam` 文件，只影响 `defmodule` 内部内容的执行方式。

## 八、未来路线图

v1.20 只是第一个里程碑。Elixir 团队明确表示，他们**不会**在以下问题解决之前引入类型签名：

1. 集合论类型系统在大型代码库中的扩展性
2. 错误消息的质量和可理解性
3. 与现有 Elixir 生态的兼容性

只有这些问题被解决后，才会开始探索类型化结构体定义（typed struct definitions），最终才是类型签名。

这个节奏让人想起 Elixir 一贯的风格——不急于求成，宁可慢一点也要做对。正如一位十年 Elixir 开发者在 HN 评论中所说：我很好奇这在我的十年老代码库中会发现什么。另一位用户回复：更新 Elixir，没有 breaking changes，编译器免费帮你找 Bug——我被惯坏了。

## 九、如何开始

升级到 v1.20 非常简单：

```bash
# 使用 asdf
asdf install elixir 1.20.0
asdf global elixir 1.20.0

# 编译你的项目
mix compile
```

编译器会自动报告它发现的类型违规。不需要修改任何代码，不需要添加任何注解。

如果你想更深入了解类型系统的设计，推荐阅读 Elixir 官方博客的完整公告，以及背后的集合论类型论文。这些文档不仅对 Elixir 开发者有价值，对任何对编程语言设计感兴趣的人来说都是难得的深度资料。

## 总结

Elixir v1.20 的类型系统代表了一种有趣的设计哲学：**不强迫开发者改变习惯，而是在现有代码上静默地工作，只报告那些真正的、可验证的 Bug**。这种「免费的类型安全」模式可能会成为未来动态语言类型系统的参考范式。

四年前的一篇论文，今天变成了生产可用的编译器特性。这本身就是软件工程中「耐心做对事」的最佳注脚。

---

*相关阅读：*

- [TUI 复兴：为什么终端界面成了 AI 时代最有前途的开发平台](/article/tui-renaissance-bonsai-term-ai-agents-2026)
