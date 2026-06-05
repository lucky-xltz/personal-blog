---
title: "TypeScript 7 即将到来：微软把编译器从 TypeScript 移植到 Go 的 10 倍性能革命"
date: 2026-06-05
category: 技术
tags: [TypeScript, Go, Rust, 编译器, 性能优化, Node.js, 前端开发, 编程语言]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# TypeScript 7 即将到来：微软把编译器从 TypeScript 移植到 Go 的 10 倍性能革命

2025 年 3 月，微软 TypeScript 团队在开发者博客上扔下了一颗炸弹：他们正在把 TypeScript 编译器从 **TypeScript** 移植到 **Go**，代号 **Corsa**。这条新闻在 Hacker News 上拿下了 1827 分、908 条评论，成为当月最受关注的编程语言新闻。

更让人意外的是，移植的不是 Rust（虽然社区呼声很高），而是 Go。这背后有工程上的深思熟虑，也有一场关于"用什么语言写编译器"的思想碰撞。

距离公告已经过去一年多，TypeScript 6.0 RC 已经发布，TypeScript 7.0 正在路上。本文带你深入这场性能革命的核心：为什么是 Go 不是 Rust？10 倍速度提升从哪里来？Node.js 的 TypeScript 原生支持如何改变前端开发？以及更重要的——这对你和你的项目意味着什么？

## 一、问题的根源：JS 写的 TypeScript 编译器

要理解这次重写，得先理解 TypeScript 编译器（`tsc`）的"原罪"：**它本身是用 TypeScript 写的**。

这个设计在 2012 年 TypeScript 发布时是合理的——通过"自举"（self-hosting）来证明语言的成熟。但 13 年后，JavaScript 的执行性能成了瓶颈：

```javascript
// 这是真实的 TypeScript 编译器内部：JS 对象遍布
const node = {
    kind: SyntaxKind.FunctionDeclaration,
    name: identifier,
    typeParameters: typeParams,
    parameters: params,
    type: returnType,
    // ... 上百个属性
};
```

**TypeScript 编译器是一个高度抽象的、深度对象嵌套的系统。** 它的优势是开发效率，劣势是 V8 引擎的 JIT 优化在面对这种大规模对象操作时力不从心。

具体的性能问题体现在三个层面：

1. **冷启动慢**：打开一个大型项目（如 VSCode 自身），TypeScript 语言服务需要 5-10 秒才能就绪
2. **类型检查慢**：在百万行代码的项目上运行 `tsc --noEmit` 可能需要 30 秒以上
3. **内存占用高**：一个大型项目的类型信息可能占用 1-2 GB 内存

微软内部测试的 Visual Studio Code 就是一个典型案例。在不优化的情况下，VSCode 启动时 TypeScript 语言服务的加载时间是 **9.6 秒**。

## 二、性能数字：10 倍提速的具体含义

移植到 Go 之后，TypeScript 团队公布了一组惊人的基准测试数据。下面是他们在 GitHub README 中公布的部分数字：

| 项目规模 | JS 版 `tsc` | Go 版 `tsc` | 加速比 |
|---------|------------|------------|--------|
| 小型项目（如 tsc 自身） | 10.1s | 1.0s | 10.1× |
| 中型项目（如 VSCode） | 77.8s | 7.5s | 10.4× |
| 大型项目（如 TypeORM） | 120.5s | 11.8s | 10.2× |

> 备注：以上数据为官方公告时的早期基准，在后续优化中部分场景加速比有所变化，但整体量级稳定。

**编辑器场景的提升更显著**——VSCode 项目的语言服务加载时间从 9.6 秒降到 1.2 秒，提升 8 倍。内存占用降低约 50%。

这个 10 倍提速是怎么做到的？官方解释是"一半来自原生代码，一半来自并发"。让我们拆解一下。

### 2.1 原生代码的胜利

JavaScript 的执行模型有根本性的限制：每次调用函数都要经过 V8 引擎的优化层，包括内联缓存、隐藏类、去优化等机制。对于一个高度抽象的编译器（TypeScript 编译器有大量的小函数、频繁的属性访问、深度的对象树），这些机制往往失效。

Go（以及任何 AOT 编译的原生语言）不存在这个问题。Go 编译器把代码直接编译成机器码，类型信息在编译时确定，函数调用是直接的跳转，没有运行时的"去优化"风险。

```go
// 同样的逻辑，Go 实现可以利用结构体内存布局
type FunctionDeclaration struct {
    Kind             SyntaxKind
    Name             *Identifier
    TypeParameters   []*TypeParameterDeclaration
    Parameters       []*ParameterDeclaration
    Type             *TypeNode
    // ... 字段访问是 O(1) 的内存偏移
}
```

这是结构体 vs 动态对象的本质差异。在 V8 上，`node.typeParameters` 需要查隐藏类、算偏移、可能触发 IC 失效；而在 Go 里，这就是 `struct + offset` 的单条指令。

### 2.2 共享内存并发的威力

TypeScript 编译器的传统实现是单线程的——这是 JavaScript 事件循环的天然限制。但 TypeScript 编译过程中**有大量可以并行的部分**：

- 每个文件的扫描（scan）独立
- 类型检查可以按文件分片
- 模块解析可以并行查询

Go 的 goroutine 模型特别适合这种"海量小任务"的并行场景：

```go
// 伪代码：并行处理所有源文件
func (c *Checker) CheckFiles(files []*SourceFile) {
    var wg sync.WaitGroup
    sem := make(chan struct{}, runtime.NumCPU())
    
    for _, file := range files {
        wg.Add(1)
        sem <- struct{}{}
        go func(f *SourceFile) {
            defer wg.Done()
            defer func() { <-sem }()
            c.checkFile(f)
        }(file)
    }
    wg.Wait()
}
```

Go 的并发原语（goroutine + channel）比 JavaScript 的 Worker Threads 轻量得多。在 16 核机器上，Go 版本可以同时检查 16 个文件，而 JS 版本本质上还是串行的。

## 三、为什么是 Go，不是 Rust？

这是 HN 上争议最激烈的话题。社区的 Rust 倾向非常明显——JavaScript 工具链的现代标准（Vite、SWC、Turbopack、Bun、Deno）几乎都用 Rust 写。但 TypeScript 团队选择了 Go。

这个决定背后有四个关键原因：

### 3.1 移植而非重写

最核心的考量：**TypeScript 团队选择的是"移植"（port），不是"重写"（rewrite）**。

他们的策略是**逐文件**把 TypeScript 源文件翻译成 Go，保持相同的架构和 API。这意味着：

- 行为完全一致——没有"重写导致的行为差异"风险
- 可以逐步发布——每天都有新文件完成
- 测试套件可以共享——同一个测试在 JS 版和 Go 版上跑，结果应该一致

但这个策略**严重限制了语言选择**。TypeScript 编译器使用了一些在 Go 里没有直接对应的特性：

- **判别联合类型**（discriminated unions）—— Go 用 interface + type switch
- **类型映射**（mapped types）—— Go 用代码生成
- **条件类型**（conditional types）—— Go 需要手写递归

这些都能用 Go 模拟，但**需要大量的工程工作**。如果用 Rust，类型系统更强大，但**所有权（ownership）和借用（borrowing）会彻底改变代码结构**——你不能简单地"翻译"代码，必须重新设计。

**Go 是语法上离 TypeScript 最近的静态类型语言**。一个无脑的机械翻译器就能把大部分代码转过去，剩下的是手工调整。Rust 做不到这一点。

### 3.2 编译时间的工程考量

TypeScript 团队还需要考虑**编译新编译器的体验**。Go 编译速度极快（百万行代码通常几十秒），Rust 编译时间经常成为痛点。对于一个"用新编译器加速开发"的工具，**新编译器自身不能太慢**。

### 3.3 LSP 集成和工具生态

TypeScript 7 将原生支持 Language Server Protocol（LSP），这意味着它能直接对接所有 LSP 兼容的编辑器（Neovim、Emacs、Helix、Sublime Text 等）。Go 生态的 `gopls` 是 LSP 实现的标杆，团队可以借鉴大量经验。

### 3.4 团队技能栈

这是一个常被忽视但很现实的因素。TypeScript 团队成员都是 TypeScript/JavaScript 专家，学习 Go 的曲线比学习 Rust 平稳得多。Rust 的学习曲线陡峭，且编译器中大量使用生命周期标注对团队生产力是负担。

> HN 用户 `dimitropoulos`（就是用 TypeScript 类型系统实现 DOOM 那个项目的作者）总结得很好："Rust would be great for a rewrite, but Go makes way more sense for a port. After the dust settles, I hope people focus on the outcomes, not the language choice."

## 四、TypeScript 6.0：最后的 JS 版本

TypeScript 6.0 是一个特殊的版本——**它是基于 JavaScript 的最后一个大版本**。从 7.0 开始，编译器核心就是 Go 写的了。

6.0 引入了一些破坏性变更，主要目的是**让 JS 版和 Go 版的行为对齐**：

```typescript
// 6.0 中：更严格的泛型函数表达式推断
declare function callIt<T>(obj: {
    produce: (x: number) => T,
    consume: (y: T) => void,
}): void;

// 这个调用以前能工作，6.0 中会报错
callIt({
    consume: y => y.toFixed(),   // 错误：'y' is of type 'unknown'
    produce: (x: number) => x * 2,
});
```

原因：在 Go 版的检查器中，参数处理顺序是确定的（按声明顺序），而 JS 版的顺序更灵活。6.0 强制对齐到这个新行为。

其他 6.0 的重要变化包括：

- **废弃 `import ... assert {...}`**——连同 `import(..., { assert: {...} })` 一起废弃
- **DOM 类型更新到最新 Web 标准**——Temporal API 等
- **更严格的类型推断**——为 7.0 铺路

```bash
# 安装 TypeScript 6.0 RC
npm install -D typescript@rc
```

## 五、Node.js 原生 TypeScript 支持：生态的另一场革命

如果说 TypeScript 7 是"类型检查"的 10 倍提速，那么 Node.js 22.18+ 的原生 TypeScript 支持就是**运行时执行**的简化。

从 Node.js 22.18.0 开始（2025 年 7 月），你**不需要任何转译器**就可以直接运行 TypeScript 文件：

```bash
# 以前：需要 tsx、ts-node、esbuild、swc 之一
npx tsx app.ts
node --loader ts-node/esm app.ts

# 现在：直接运行
node app.ts
```

Node.js 用 **type stripping** 实现这个特性——它直接擦除所有类型注解，保留运行时 JavaScript：

```typescript
// 你的 app.ts
interface User {
    name: string;
    age: number;
}

const greet = (user: User): string => {
    return `Hello, ${user.name}!`;
};

console.log(greet({ name: "林小白", age: 30 }));
```

Node.js 看到的（经过 type stripping 后）：
```javascript
const greet = (user) => {
    return `Hello, ${user.name}!`;
};

console.log(greet({ name: "林小白", age: 30 }));
```

### 5.1 重要的约束

type stripping 不是万能的，它**只处理"可擦除"的类型语法**：

| 语法 | type stripping 支持 | 备注 |
|------|-------------------|------|
| 类型注解 `let x: number` | ✅ | 擦除 |
| 接口 `interface Foo {}` | ✅ | 擦除 |
| 类型别名 `type Bar = string` | ✅ | 擦除 |
| `import type` | ✅ | 擦除 |
| `enum` | ❌ | 需要代码生成 |
| 参数属性 `constructor(private x: number)` | ❌ | 类字段语法 |
| 带运行时代码的 namespace | ❌ | 有实际 JS 输出 |

如果你用了这些"非擦除"语法，需要用 `tsx`、`ts-node` 或类似工具做完整转译。

### 5.2 类型检查是另一回事

**Node.js 的 type stripping 不做类型检查**。它只擦除类型注解，不验证类型是否正确。类型检查仍需单独运行：

```bash
# 运行时：直接执行
node app.ts

# 类型检查：单独跑 tsc
npx tsc --noEmit
```

这种设计是合理的——运行时不应该为类型检查付出开销。开发时你可以用 IDE 的实时类型检查，CI/CD 时单独跑 `tsc --noEmit`。

### 5.3 配置文件：不再需要

Node.js 的 TypeScript 加载器（代号 **Amaro**）**不需要也不使用** `tsconfig.json`。它有自己的一套简单的转换规则，避免了和 `tsc` 配置的复杂交互。

这对于简单的 Node.js 项目是个福音——以前为了跑一个 `.ts` 文件你得折腾一堆 loader 配置，现在 `node app.ts` 就完事。

## 六、给你的项目带来的变化

### 6.1 短期（现在）：升级工具链

**Node.js 项目**：
- 升级到 Node.js 22.18+，启用原生 TypeScript 支持
- 移除 `tsx` / `ts-node` 等转译器（如果只用基础语法）
- 保留 `tsc --noEmit` 作为类型检查步骤

**编辑器**：
- VSCode 用户：安装 [TypeScript Native Preview](https://marketplace.visualstudio.com/items?itemName=TypeScriptTeam.native-preview) 扩展
- 在设置中开启实验性支持：
  ```json
  {
      "js/ts.experimental.useTsgo": true
  }
  ```
- 体验到 5-10 倍的加载速度提升

**包管理**：
```bash
# 安装 tsgo CLI（npx 也能直接用）
npm install -D @typescript/native-preview
npx tsgo
```

### 6.2 中期（6-12 个月）：准备 TypeScript 7 升级

TypeScript 7.0 将在 2026 年底到 2027 年初发布（基于 6.0 RC 的发布节奏推断）。升级前需要做这些准备：

**配置审计**：
- 检查 `tsconfig.json` 中是否有已废弃的选项
- 移除对内部 API 的依赖（如 `typescript` 包的私有导出）

**依赖审计**：
- 某些工具（如 `ts-node`、`ts-jest`）可能需要更新
- 监视你使用的框架的 TypeScript 7 兼容性

**类型定义审计**：
- 6.0 引入了更严格的类型推断，可能暴露代码中的隐藏 bug
- 在 6.0 上跑一遍 `tsc --strict`，提前发现潜在问题

### 6.3 长期：编译器的语言选择之争

TypeScript 7 的发布可能引发连锁反应。如果 Go 版的 TypeScript 编译器表现出色，可能会鼓励其他"语言 N 写语言 N 编译器"的项目考虑用 Go 或 Rust 重写：

- **Babel**：现在用 JS 写，转译速度也是痛点
- **ESLint**：用 JS 写，大型项目 lint 慢
- **Prettier**：用 JS 写，大型项目格式化慢

这些工具的重写可能比 TypeScript 容易（因为没有类型系统，逻辑相对简单），未来 2-3 年可能看到一波 JavaScript 工具链的"原生化"潮流。

## 七、性能之外：TypeScript 7 带来的新能力

10 倍速度提升不仅仅是"以前 10 秒现在 1 秒"的体验改进——它**解锁了以前不可行的功能**。

### 7.1 实时跨项目类型检查

以前受限于性能，TypeScript 只能在当前项目内做完整类型检查。**整个 monorepo 的跨项目类型检查**通常要数分钟，未来可能秒级返回。这意味着：

- 重构时跨包的影响分析可以实时显示
- 公共 API 变更的破坏性检查可以在编辑器内即时反馈

### 7.2 更智能的重构工具

一些"理论上可行但计算太贵"的功能在 TypeScript 7 中可能成为现实：

- **全局重命名**——考虑类型流而不是简单的文本替换
- **跨文件代码移动**——自动更新所有 import 路径
- **类型驱动的代码补全**——不只是 API 补全，还有"满足该接口的类"补全

### 7.3 为 AI 工具铺路

微软在公告中明确提到 TypeScript 7 将"启用下一代 AI 工具"。10 倍速度意味着：

- AI 代理可以快速分析整个代码库
- 大规模代码搜索（"找出所有满足 X 接口的函数"）成为可能
- 实时的代码质量反馈

这与最近 LLM 编码工具（Sonnet、Cursor、Continue）的崛起形成正向循环——更快的工具让 AI 编码更高效，AI 编码的普及又推动对更快工具的需求。

## 八、社区反应：赞誉与质疑

TypeScript 7 的公告引发了 HN 上 900+ 条评论，主要分三类反应：

### 8.1 积极派

> "Fast dev tools are awesome and I am glad the TS team is thinking deeply about dev experience, as always!" — HN 用户 `bcherny`

> "This is the greatest news. Let's Go" — HN 用户 `John Yepthomi`

> "I can't wait to try it with 100% native functionality. Microsoft, I'm going to take my hat off to them, they've hit the nail on the head." — HN 用户 `Eduardo Pérez Hunich`

### 8.2 担忧派

> "One trade off is if the code for TS is no longer written in TS, that means the core team won't be dogfooding TS day in and day out anymore, which might hurt devx in the long term. This is one of the failure modes that hurt Flow (written in OCaml)" — HN 用户 `bcherny`（TypeScript 团队成员）

这是来自 Facebook/Meta 的 Flow 团队的前车之鉴——Flow 用 OCaml 写，结果 OCaml 专家和 Flow 用户的需求逐渐脱节，最终 Flow 停止维护。TypeScript 团队**用 Go 写 TypeScript 编译器**是否会重蹈覆辙？这是个开放问题。

### 8.3 质疑"为什么不是 Rust"

> "Also, Rust seems to be the go-to language for JavaScript tooling now. So, picking Go just seems badly out of touch with the current ecosystem." — HN 用户

> "The guy who wrote SWC did try to write a TSC in Rust, and then abandoned it. TypeScript is an engineering monster if you know TypeScript good enough, as is any complex-typed compiler." — HN 用户 `Zhang Harry`

SWC（Rust 写的 TypeScript 转译器）已经在转译速度上击败了 tsc，但 SWC 不做类型检查。**完整的 TypeScript 类型检查器在 Rust 里**被认为工程上过于复杂。

## 九、动手试试：10 分钟体验 tsgo

如果你想现在就开始体验 TypeScript 7 的预览版，按以下步骤操作：

### 9.1 安装 CLI

```bash
mkdir tsgo-demo && cd tsgo-demo
npm init -y
npm install -D @typescript/native-preview typescript
```

### 9.2 创建一个大型项目测试性能

```bash
# 克隆一个有几千个 TS 文件的项目
git clone https://github.com/typeorm/typeorm.git
cd typeorm

# 用官方 tsc 跑一次
npx tsc --noEmit
# 记下时间：T1

# 用 tsgo 跑一次
npx tsgo
# 记下时间：T2

# 计算加速比
echo "scale=2; $T1 / $T2" | bc
# 输出类似 10.23
```

### 9.3 在 VSCode 中体验

```bash
# 安装扩展
code --install-extension TypeScriptTeam.native-preview
```

在 `settings.json` 中添加：
```json
{
    "js/ts.experimental.useTsgo": true
}
```

重启 VSCode，打开一个大型项目（如上面的 typeorm），观察：
- 启动速度
- 补全响应时间
- "Go to Definition" 速度
- 内存占用

### 9.4 体验 Node.js 原生 TypeScript

```bash
# 确认 Node.js 版本
node --version
# 应该 >= v22.18.0

# 创建一个简单项目
mkdir node-ts-demo && cd node-ts-demo
echo 'const greet = (name: string): string => `Hello, ${name}!`;
console.log(greet("TypeScript 7"));' > app.ts

# 直接运行
node app.ts
# 输出: Hello, TypeScript 7!
```

## 十、总结：一场静悄悄的革命

TypeScript 7 不是一个新功能，而是一个**基础架构升级**。它不会改变你写 TypeScript 代码的方式，但会改变你使用 TypeScript 的体验：

- **构建速度**：从分钟级到秒级
- **编辑器响应**：从卡顿到流畅
- **大项目可用性**：从"勉强能用"到"丝滑体验"

这场革命的影响远超 TypeScript 本身：

1. **Node.js 生态的简化**——原生 TypeScript 支持让入门门槛降低
2. **前端工具链的连锁反应**——可能引发 Babel、ESLint 等工具的原生化
3. **AI 编码的加速**——更快的工具让 AI 代理更高效
4. **编程语言选择的反思**——"用什么语言写编译器"有了新的答案

对于普通开发者，这意味着：

- **现在**：升级 Node.js 到 22.18+，体验原生 TypeScript
- **6 个月内**：在大型项目上试用 `tsgo`，感受 10 倍提速
- **1 年内**：准备升级到 TypeScript 7.0
- **长期**：享受更快、更智能的开发工具带来的生产力提升

TypeScript 团队用 Go 写 TypeScript 编译器，看似"背叛"了自举原则，实际上是对**工程实用性**的深刻理解。在编程语言的世界里，**最好的语言不一定是最适合写编译器的语言**。这次的 Go 选择，可能会成为未来编译器实现的范本。

## 参考资料

1. [A 10x Faster TypeScript - Microsoft Dev Blogs](https://devblogs.microsoft.com/typescript/typescript-native-port/) — 官方公告
2. [microsoft/typescript-go - GitHub](https://github.com/microsoft/typescript-go) — 25,600+ stars 的移植仓库
3. [Announcing TypeScript 6.0 RC - Microsoft Dev Blogs](https://devblogs.microsoft.com/typescript/announcing-typescript-6-0-rc/) — 6.0 发布说明
4. [Running TypeScript Natively in Node.js](https://nodejs.org/en/learn/typescript/run-natively) — Node.js 官方文档
5. [HN 讨论：A 10x Faster TypeScript](https://news.ycombinator.com/item?id=43332830) — 908 条评论

---

*相关阅读：*

- [Elixir v1.20：集合论类型系统的渐进式革命](/article/elixir-v120-gradual-set-theoretic-types-2026) — 类型系统演进的另一条路径
- [反压（Backpressure）：让 AI 编码代理自我纠错的系统工程思维](/article/backpressure-ai-coding-agents-2026) — AI 编码时代的工具思维
- [Zig 构建系统的双进程革命：从 150ms 到 14ms 的 10 倍提速之路](/article/zig-build-system-rework-2026) — 编译器工具链的另一个提速故事
- [TUI 复兴：为什么终端界面成了 AI 时代最有前途的开发平台](/article/tui-renaissance-bonsai-term-ai-agents-2026) — 开发者工具的演进方向
