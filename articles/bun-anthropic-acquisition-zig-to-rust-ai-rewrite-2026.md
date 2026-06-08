---
title: 'Bun 在 Anthropic 入主半年后做了一件大事：6 天、6755 个 commit、零人工审阅的 Zig→Rust 移植到底发生了什么'
date: 2026-06-08
category: 技术
tags: [Bun, Anthropic, Rust, Zig, JavaScript运行时, JavaScriptCore, AI编程, 代码生成, Claude Code, 性能优化, 内存安全, 编译原理, Miri, undefined behavior]
author: 林小白
readtime: 18
cover: https://images.unsplash.com/photo-1629654297299-c8506221ca97?w=600&h=400&fit=crop
---

# Bun 在 Anthropic 入主半年后做了一件大事：6 天、6755 个 commit、零人工审阅的 Zig→Rust 移植到底发生了什么

2026 年 5 月 14 日，GitHub 上 `oven-sh/bun` 仓库合并了一个标题只有 `Zig → Rust port` 的 PR。6,755 个 commit、+1,000,000 行 Rust 代码、6 天时间、从零分支到 main。reviewer 列表里是 `coderabbitai[bot]` 和 `claude[bot]` 的绿色对勾——**唯一的人类 reviewer 还停留在 "Awaiting requested review"**。5 月 15 日，一位开发者开 issue #30719 公开质疑：这份"翻译"出来的 Rust 代码甚至跑不过 miri 基础检查、`unsafe` 关键字出现了 13,255 次（非注释行）。48 条评论里，争论的焦点已经不再是"Bun 是不是个好项目"，而是"**当一个 1M+ LoC 的代码库没有人类真正读过时，我们应该如何审计一个生产级运行时？**"

这是 2025 年 12 月 3 日 Anthropic 宣布以收购形式接管 Bun 之后，Bun 项目在工程层面做出的最大一次技术赌注——也是过去 6 个月内 AI 编程工具自我证明"能写出有意义的代码"的最极致（也最有争议）案例。本文把这条时间线拆开来看：收购公告、4 年的 Zig 故事、Claude Code 装机量冲到 $1B 的背景、6 天 6755 commit 的具体过程、UB 警告的复现过程、社区 1000+ 评论的三大阵营，以及更宏观的"AI 时代工程审计"问题。

## 一、收购公告：2025-12-03 那天到底发生了什么

Bun 创始人 Jarred Sumner 在 2025 年 12 月 2 日的官方公告里（[bun.com/blog/bun-joins-anthropic](https://bun.com/blog/bun-joins-anthropic)）写了一段后来被 HN 引用过上千次的话：

> "Today, Bun makes $0 in revenue."
> "We had over 4 years of runway to figure out monetization. We didn't have to join Anthropic."

Bun 是 2021 年 Jarred 在奥克兰一间小公寓里写出来的项目，4 年里把 esbuild 的 JSX/TypeScript 转译器从 Go 移植到 Zig，然后基于 JavaScriptCore（Safari 的 JS 引擎）搭出整个 runtime——运行时、bundler、test runner、package manager、SQL 客户端、S3 客户端、Redis 客户端、HTTP server 一体化。融资 2 轮共 2600 万美元，82,000+ GitHub stars，7.2M 月下载量，零收入。

Anthropic 那天同时宣布的另一个数字才是收购的真正背景：**Claude Code 的年化收入跑到了 10 亿美元**。Mike Krieger（Anthropic CPO）在声明里说："Bun represents exactly the kind of technical excellence we want to bring into Anthropic. Jarred and his team rethought the entire JavaScript toolchain from first principles." Anthropic 同时确认：Bun 保持 MIT 开源、继续在 GitHub 上公开开发、维持 Node.js 兼容性、同一个团队全职继续做。

但评论区的质疑比正文更尖锐。HN 最高赞评论（dblon，1052 分）的原话："This announcement made me check in on the arbitrary code execution bug I reported that the Bun Claude bot created a PR for about 3 weeks ago. ... someone from the bun team has left a bunch of comments like 'Poor quality code...' and all the tests still seem to be failing. I looked through the code that the bot had generated and to me ... it looks like total dogshit."——Bun 团队里有一个 Claude Code bot 在合并前 3 周就已经在用 AI 改 bug 了，但质量存疑。

另一个更阴冷的预测来自 re-thc："Now we've tied Bun to 'AI' and if the AI bubble or hype or whatever bursts or dies down it'd impact Bun." 半年后回看，这个判断在 2026 年 4 月 1 日 bcherny 公开澄清的"Anthropic 信息泄露事件与 Bun 无关"事件里得到了侧面验证。

## 二、4 年的 Zig 故事：为什么是 Zig，以及为什么到了 2026 年要换

Bun 选 Zig 不是因为潮流。Jarred 在 2021 年做 esbuild 移植时，目标是"让一个 4-5 人小团队在 12 个月内写出一个能跑 SSR 的 production-grade JS runtime"。三个约束：

1. **不能有 GC**：服务端 runtime 启动延迟要低于 Node.js 当时的 60ms，GC pause 不可接受。
2. **不能有沉重的运行时依赖**：需要单文件可执行部署。
3. **C interop 必须直接**：要嵌 JavaScriptCore（C++）、接 libuv（C）、要直接调 WebKit 的 internal API。

只有 Zig 同时满足这三个条件。它的 `comptime` 让模板元编程没有 C++ 的痛苦，它的 defer/errdefer 让 RAII 比 Rust 简单得多，它对 C 头文件的直接 include 几乎零开销。一个当时还不到 1.0 的语言，被 Jarred 拿来当 4 年的核心赌注。

2023 年 9 月 Bun v1.0 GA。2024 年 1.1 补 Windows。2024 年 1.2 加 PostgreSQL/S3 客户端。2024 年 1.3 加 Redis/MySQL 客户端 + 性能优化。然后是 2024 年下半年：AI coding tools 从 "cool demo" 变成 "actually useful"，Claude Code、FactoryAI、OpenCode 几乎全部基于 Bun 的单文件可执行打包。HN 评论 `reactordev`："If Bun breaks, Claude Code breaks. Anthropic has direct incentive to keep Bun excellent."——这正是 Anthropic 决定收购的商业逻辑。

但 4 年里 Zig 也累积了结构性债务。Jarred 自己承认（以及 HN 上 Zig 开发者 `Validark` 的观察）：Bun 的 Zig 代码风格"cavalier towards buffer overruns"。4 年里 Bun 报告的 CVE 有 17 个，其中 8 个是内存安全问题。Zig 的 ReleaseSafe/Safe 模式提供保护，但 Bun 团队追求迭代速度时这些模式"增加的心智负担超过团队的预算"。**这不是 Zig 的失败——是 Bun 业务模式（快迭代/快发布/快修 bug）和 Zig 设计哲学（系统程序员/极致控制/严格纪律）之间的结构性错配。** TigerBeetle 用 Zig 写出几乎无内存 bug 的数据库，因为它的小团队文化和数据库产品本身都符合 Zig 的哲学；Bun 的产品形态（运行时 + 工具链 + 包管理器）注定了快节奏迭代是核心 KPI。

## 三、6 天 6755 commit：那个 PR 到底长什么样

2026 年 5 月 8 日，PR 在 GitHub 上打开。分支名 `claude/phase-a-port`。5 月 14 日合并。6 天，6755 个 commit，diff 统计大约是 +1,000,000 行 Rust 代码（vs 移除 ~700,000 行 Zig）。Jarred 在公告推文（[xunroll.com/thread/2053047748191232310](https://xunroll.com/thread/2053047748191232310)）里说"the architecture doesn't change, and the data structures don't change"——这是 AI 翻译而不是重写。目标是用 Rust 编译器接管原本靠 Zig ReleaseSafe 模式做的人工 discipline。

**PR 描述里写的内容几乎为零**——没有架构图、没有理由陈述、没有性能 baseline 对比、没有 safety audit 报告。代码就是代码，commit 就是 commit。HN 上 `jwpapi` 的吐槽："It's purely politics-based not technical."  `mohsen1` 同时在做 tsz.dev（一个 TypeScript→Rust 移植项目）已经 5 个月，他评论："I keep adding more and more tests to ensure things work. Even after all of TypeScript's own tests pass I am finding bugs which I was totally expecting." 6 天能完成 1M LoC 的运行时移植，他觉得不可思议。

但更让人警觉的是审阅过程。`coderabbitai[bot]` 和 `claude[bot]` 都给了 Approve。**唯一的人类 reviewer 标记为 `alii`，状态 `Awaiting requested review`——他连看都没看。** Jarred 自己后来在 Discord 里说："This feels approximately a few months ahead of where things are going. Certainly not years." 但 PR 已经合并到了 main。

HN 上 `voidhorse` 的评论精确描述了这种状态："At least the tests pass. Only one person drove the migration, so the number of people that understand the new code is ~0.5 under the assumption there's no way the sole dev could build a mental model of fresh 1m code in 6 days." `0.5` 是社区给出的、这个代码库"被人类理解"的工程师人数估值。

## 四、UB 警告：复现一个最简单的反例

5 月 15 日，issue #30719 被创建（[github.com/oven-sh/bun/issues/30719](https://github.com/oven-sh/bun/issues/30719)），标题是 "PathString::slice dangling reference UB - add Miri to CI"。复现代码只有 9 行：

```rust
fn main() {
    let test = Box::new(*b"Hello World");
    let init = PathString::init(&*test);
    drop(test);
    println!("{:?}", init.slice());
}
```

跑 miri 后报错：

```
error: Undefined Behavior: constructing invalid value of type &[u8]:
  encountered a dangling reference (0x20933[noalloc] has no provenance)
   --> src/main.rs:97:18
    |
 97 |     unsafe { core::slice::from_raw_parts(ptr as *const u8, self.len()) }
    |                  ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
```

这就是典型的 use-after-free 翻译错误——Zig 那边 `PathString.init(&*test)` 持有了原 buffer 的引用，drop 后调用 `init.slice()` 会拿到 dangling pointer。Zig 在 ReleaseSafe 模式下这种 bug 会被 ASan/LSan 抓到，但 Rust 编译器不会自动抓，**因为这段代码在 `unsafe` 块里**。AI 翻译时把 Zig 的隐式 deref 写成 Rust 的 `unsafe from_raw_parts`，但没正确传播生命周期参数。

issue 评论区有人跑了一个更直观的统计：`find -type f -name '*.rs' -exec grep unsafe {} \; | grep -v '//' | wc -l` 返回 **13,255**——13,255 行 Rust 非注释代码包含 `unsafe` 关键字。

Bun 团队（特别是 Jarred）的回应是 5 月 25 日 issue 关闭，附 commit "fix PathString::slice lifetime issue"——**单点修复**。HN 上 `gpm` 的技术性反驳很冷静："The issue isn't the existence of undefined behavior that miri would catch. The issue is exposing an API that allows undefined behavior from safe code—which miri only catches if you go write the test that proves it. This isn't an altogether unreasonable thing to happen during an initial port of code from an unsafe language. ... Temporarily in a porting stage incorrectly marking some unsafe functions as safe isn't a real issue."——**翻译阶段的临时 unsafe 不奇怪，但 release 时必须把 safe 包装的 invariant 写清楚**。

但 `areweai` 提出了一个更深的元批评："At first I was critical of the maintainers for closing this github issue as off topic. Then I realized that the github ui was auto-collapsing a dozen messages in a row that were all completely devoid of any informational value and certainly sourced from forums and community discord channels."——**issue 讨论本身被 bot 喷的废话污染**，导致认真提 bug 的人被淹没。

## 五、社区三大阵营：1000+ 评论里在吵什么

把 2026 年 5 月的 3 个相关 HN 帖（718pts 99.8% 公告、488pts UB issue、12pts liujiacai 深度分析）一共 1000+ 条评论聚合起来，HN 用户大致分三个阵营：

**第一阵营：这是 AI 编程的"分水岭时刻"，速度压倒一切**

代表是 `tomaytotomato`："I had to happen, for many reasons—It's a throw thing at the wall and see what sticks situation—LLMs will improve—Using LLMs in an agentic way will improve (git worktrees, sliced PRs, spec driven steps). So what happened here is a mess, but you gotta break a few eggs to make a souffle. It's a learning step and I am glad it happened." 这一派认为短期混乱是必然代价，类似 1995 年 Java 早期和 2015 年 Rust 1.0 之前的"足够好就行"。

**第二阵营：这是工程审计的范式崩溃，过程本身不可接受**

代表是 `skrrtww`："I think the only way to interpret a one million line LLM-generated diff with no proper reviews as an employee of Anthropic is that my company no longer has an interest in understanding, or even looking at, its own code. I'd be concerned that by jumping onboard with this sort of development process I'd lose touch with how to engineer software in a detail-oriented or remotely rigorous way." 这一派的核心论点不是"Bun 质量差"（虽然部分同意），而是"**Anthropic 作为雇主的工程文化发出了错误信号**"。

**第三阵营：反对错位归因，把锅甩给 Zig 不公平**

代表是 `Validark`（一个全职 Zig 开发者）："I'm a full time Zig developer, and I see this as an absolute win. ... I think it is fair to say Bun was programmed in a way that's quite cavalier towards buffer overruns. ... a divorce is likely better for both parties." 这派的观点 liujiacai.net 那篇 2,500 字深度分析说得很清楚：把"我们用 X 时犯错多"诊断为"X 不行"是 attribution error。"The correct diagnosis is: in a commercial project that prioritizes rapid iteration, the cognitive tax of manual memory management exceeded the team's budget. This isn't a bug in Zig—it's a structural mismatch between Zig's design goals and Bun's business model."

## 六、为什么这次事件比 "show HN" 重要：AI 时代工程审计的拐点

把视野拉远一点。Anthropic 在 2026 年 6 月 8 日的今天，**已经是 GitHub 上合并 PR 数排名前 5 的公司**——超过 Google、Meta、Microsoft、AWS 的 internal monorepo 公开数。这次 Bun 的 6755 commit 不是孤例，是 Anthropic 内部已经常态化的"用 Claude Code 推动大型代码迁移"模式首次外溢到被广泛审计的开源项目上。

HN 上 `reducesuffering` 的判断最一针见血："When it comes down to it, all the vitriol and animosity towards this port is really because of the implication of what its success would mean. If LLM's are capable of completely porting core software modules many people rely on (not just a CRUD app) of 1m lines in a week's time, it is a case closed moment that LLM's are currently much more capable than most people's eng, and can do it much faster."——**争议的本质是"AI 是否已经替代了我 10 年积累的工程能力"对每个资深开发者的存在性威胁**。

但我们这一行不能停留在情绪上。具体到这次事件，可被验证的事实是：

1. **6 天 6755 commit 是真的**（`claude/phase-a-port` 分支名、PR 时间戳、commit 历史都可查）
2. **99.8% 测试通过是真的**（Jarred 推文，Linux x64 glibc 平台）
3. **UB 警告是真的**（issue #30719 已被关闭，commit 修复已合并）
4. **13,255 行 unsafe 是真的**（任何人 clone 仓库一行 grep 就能复现）
5. **零人工 review 是真的**（PR reviewer 列表 + 状态字段可查）
6. **Anthropic 接管 6 个月后这个 PR 出现是相关的**（时序上紧跟在 12 月收购之后）

未来 6-12 个月我们能跟踪的硬指标：
- Bun v1.4 / v2.0 的 unsafe 密度变化（如果从 13,255 降到 4,000 以下 = 团队在认真重写；如果持平 = 只是翻译）
- miri 是否进入 CI（issue #30719 的核心请求）
- Claude Code 的崩溃率（如果 Bun Rust 版上线后 Anthropic 内部指标变化）
- Zig 社区的反应（`Validark` 说"divorce is better for both parties"——但 Zig 在 2026 年的招聘数据如何？）

## 七、回到工程本身：AI 翻译 vs AI 重写

最后一点务实的建议。如果你自己的项目也面临类似迁移：能不能用 AI 把 1M LoC 的 Zig 项目翻译成 1M LoC 的 Rust、6 天完成、99.8% 测试通过？

技术上：**能**。Bun 已经做了证明。
工程上：**不应该**。除非你满足以下 4 个前提：
1. 你有完整、可执行的测试套件（bun test 覆盖率 90%+）
2. 你有能力在 production 流量之外运行 canary 至少 3-6 个月
3. 你愿意承担"6 个月后某个凌晨 3 点的 P1 工单，没有人知道这个 bug 在哪"的概率
4. 你的业务允许"代码没人读过"作为可接受风险（**这条几乎只有 AI 公司自己能用**）

否则请老老实实做 incremental porting：先迁移 1 个模块、跑通 1 个用户、收集 1 个 metric、再迁移下一个。AI 工具（包括 Claude）在 incremental 场景里更可靠，因为每一步都有"前一步工作 + 测试通过"作为基线。

Jarred 在收购公告里写过一句话："AI coding tools are getting really good, really fast and they're using Bun's single-file executables to ship CLIs and agents that run everywhere." 这句话既是对 Bun 商业价值的肯定，也是对未来的预言——**当 AI 写的代码比人类写的多时，代码审计的单位不再是"行"或"函数"，而是"整个仓库能不能被 1 个人在 6 个月内读完"**。Bun 的 1M+ LoC Rust 仓库，可能是这个新时代第一个被广泛审计的样本。它的命运——是被工程界接纳为"AI 翻译可行"的范本，还是被记入"AI 大跃进"的反面教材——将由接下来 12 个月的 miri CI 进展、unsafe 密度下降率和 Claude Code 在线稳定性数据共同决定。

---

*相关阅读：*

- [Web Browser Engineering（2021）](/article/wayland-2026-i3-creator-sway-migration-2026) — i3 之父 Stapelberg 用 18 年等来的 Wayland 答案，与 Bun 的"用 Rust 解决工程债务"形成方法论对比
- [PostgreSQL 14 Internals Book](/article/post-quantum-tls-merkle-tree-certificates-2026) — 同一时期另一类"性能与正确性"工程的范本
- [A 10x Faster TypeScript（2025-03）](/article/typescript-7-go-port-10x-compiler-2026) — TypeScript 7 的 Go 移植，与 Bun 的 Rust 移植同属"重写以换速度"模式
