---
title: 'WebAssembly 终于要变“一等公民”了：Component Model 如何终结 9 年的 JS 胶水代码尴尬'
date: 2026-06-05
category: 技术
tags: [WebAssembly, Component Model, 浏览器, 编译原理, WIT, 字节码联盟, 编程语言, 性能优化]
author: 林小白
readtime: 12
cover: https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&h=400&fit=crop
---

# WebAssembly 终于要变"一等公民"了：Component Model 如何终结 9 年的 JS 胶水代码尴尬

> 本文同步发布于 [个人博客](https://blog.xltz.qzz.io)，与午间的《TypeScript 7 即将到来》形成"编译生态"双视角：午间讲**编译器用什么语言写**（TS→Go），本文讲**编译输出在浏览器里怎么跑**（Wasm 怎么摆脱 JS 胶水）。

## 一个被引用了 664 次的"委屈"

2026 年 2 月，Mozilla 工程师 [Lin Clark 在 Wasm CG 慕尼黑会议](https://hacks.mozilla.org/2026/02/making-webassembly-a-first-class-language-on-the-web/) 上做了一次主题演讲，原话只有一句却刺痛了所有 Wasm 开发者：

> "WebAssembly 在浏览器里，仍然是**二等公民**。"

这篇文章在 Hacker News 上拿到了 **664 分、598 条评论**——是 2026 年 Web 基础设施领域讨论度最高的文章之一。但点进去读完，你会发现它不是新功能介绍，也不是性能基准。它在回答一个更根本的问题：

> **为什么 2017 年发布的 Wasm，9 年后连"在浏览器里打印一行 hello world"都还是这么痛苦？**

我读完这篇文章，加上 HN 评论区里几位 Wasm 编译器作者（Filippo（flohofwoe）、eqrion、pizlonator 等）的争论，又翻了 Component Model 仓库的设计目标文档和 jco 工具链的源码。**这件事比表面上看起来重要得多**——它关乎未来 5 年 Web 应用的形态。

今天这篇文章，我想把这件事讲透。

---

## 一、把"加载 Wasm"这件事写出来，你就懂了

我们先来一次最直观的对比。**一段"在浏览器里打印 hello world"的代码，在 JavaScript 和 WebAssembly 中分别是什么样？**

### JavaScript 版本（初学者第一天就能写）

```html
<script src="script.js"></script>
```

```javascript
console.log("hello, world");
```

就两行。完事。

### WebAssembly 版本（即使你已经是 Wasm 老手）

要把这行 `console.log` 编译成 Wasm，你至少需要这些代码：

**1) Rust 源代码（这部分还很"正常"）：**

```rust
extern "C" {
    fn console_log(msg_ptr: *const u8, msg_len: usize);
}

#[no_mangle]
pub fn run() {
    let msg = b"hello, world";
    unsafe { console_log(msg.as_ptr(), msg.len()) }
}
```

**2) 手写的 JavaScript 胶水文件**（这是关键步骤，必须写）：

```javascript
// 第一步：手动分配一块 Wasm 可见的内存
let memory = new WebAssembly.Memory({ initial: 1, maximum: 10 });

// 第二步：把字符串写入 Wasm 内存（UTF-8 编码 + 写入字节）
function writeStringToMemory(str, mem, ptr) {
    const bytes = new TextEncoder().encode(str + "\0");
    const view = new Uint8Array(mem.buffer);
    view.set(bytes, ptr);
}

// 第三步：包装一个 consoleLog 函数作为 import
function consoleLog(messageStartIndex, messageLength) {
    const bytes = new Uint8Array(
        memory.buffer, messageStartIndex, messageLength
    );
    const text = new TextDecoder().decode(bytes);
    console.log(text);
}

// 第四步：把 import 注入到 Wasm 模块
const imports = {
    env: {
        memory,
        consoleLog,
    },
};

// 第五步：手动 fetch + instantiate
const response = await fetch("module.wasm");
const bytes = await response.arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes, imports);

// 第六步：调用入口函数
instance.exports.run();
```

**3) 编译命令**也不是 `rustc --target=wasm32` 就能搞定的，至少需要 `wasm-bindgen` 或 `wasm-pack` 之类的工具链：

```bash
wasm-pack build --target web
# 然后它才会帮你把上面那些胶水代码自动生成出来
```

**为什么不能像 JS 那样 `<script src="module.wasm">` 直接跑？** 因为 Wasm 至今**不支持** `script` 标签加载、**不能直接访问 DOM**、**不能直接调用 Web API**。任何要用 Wasm 的人，都必须先成为半个 JavaScript 专家。

这就是 Lin Clark 说的"二等公民"——不是 Wasm 性能差，而是**它不能独立存在**。

---

## 二、9 年里 WebAssembly 加了多少东西，但依然没人用

你可能想：Wasm 不是有 GC、SIMD、异常处理、tail call、64-bit 内存了吗？这些不是 9 年的进步吗？

没错。WebAssembly Community Group 9 年来引入了大量新能力（[lin clark 的原话](https://hacks.mozilla.org/2026/02/making-webassembly-a-first-class-language-on-the-web/)）：

| 时间 | 能力 | 主要受益者 |
|------|------|-----------|
| 2017 | Wasm 1.0（基础 MVP） | C/C++ 编译到 Web |
| 2019 | Threads & Atomics | 多线程应用 |
| 2020 | Reference Types | 宿主引用 |
| 2021 | SIMD | 计算密集场景 |
| 2022 | Exception Handling | 异常传递 |
| 2022 | Tail Calls | 函数式语言 |
| 2023 | Memory64 | 大内存应用 |
| 2024 | GC（结构体/数组） | 托管语言（Java/Kotlin/Swift） |
| 2026 | Component Model 推进中 | 所有语言的 Web 集成 |

**但是，WebAssembly 在 Web 上的采用率，9 年来**几乎没什么实质性变化**。** 现在的 Wasm 主要是 Figma、Photoshop Web、Google Earth 这类"原本就是 C++ 写的应用，被搬到 Web"——它们是**反向适配** Web。

而开发者主动选择"用 Rust/Go 写前端"？几乎没有。这就是 Lin Clark 文章的痛点：

> "WebAssembly has dramatically expanded the core capabilities of the language... **Yet, it still feels like something is missing that's holding WebAssembly back from wider adoption on the Web.**"

---

## 三、那"missing thing"到底是什么？—— 把这个量化的数据请出来

Mozilla 在 2020 年做过一个**非常巧妙的实验**（[Dodrio 框架基准](https://hacks.mozilla.org/2020/01/using-cargo-cult-science-to-evaluate-webassembly-fallacies/)）：

> 在 Rust 的 Dodrio 框架中实现经典 TodoMVC，**计算 DOM 修改**的部分和**实际应用修改**的部分是分离的。
> 这意味着你可以替换"应用 DOM 修改"那一个函数为不同实现，**精确测量 JS 胶水代码的开销**。

实验结果：

> **移除 JS 胶水代码后，DOM 修改的耗时下降 45%。**

45%。这意味着 Wasm 用户在 Web 上**为了用 DOM，要付出一倍的性能税**。对计算密集的 workload 这无所谓（Figma 主要在 GPU 上画），但对**任何需要读写 DOM 的应用**（绝大多数 Web 应用），这个开销就无法忽视。

更糟的是，**这段胶水代码的维护成本**：

- 每个语言都要重写一次（C++ 用 embind、Rust 用 wasm-bindgen、Go 用 syscall/js、AssemblyScript 用 asbind……）
- 上游编译器（Clang/LLVM）不愿意也不应该知道 JS/Web 的存在
- 生成的胶水代码要做字符串重编码、结构体反序列化、JS 对象 GC——全是损耗
- 如果用户用了第三方库，库作者还得确保自己的 Wasm 工具链能跟上 Web 平台的更新节奏

---

## 四、社区分裂：pizlonator vs flohofwoe 之争

HN 评论区里，这场争论几乎**两极分化**。我摘录两条代表性观点：

**pizlonator（JavaScriptCore 引擎贡献者，Filament 渲染引擎作者）**说：

> "It's simple.
> **JavaScript is the right abstraction for running untrusted apps in a browser.**
> WebAssembly is the wrong abstraction for running untrusted apps in a browser.
> Browser engines evolve independently of one another, and the same web app must be able to run in many versions of the same browser and also in different browsers. **Dynamic typing is ideal for this.**"

他的核心论点：
- Web 的核心抽象是**对象图 + GC + 动态类型**
- Wasm 的线性内存模型和这个抽象**根本冲突**
- 任何把 Wasm 提升到"一等公民"的尝试，**都不会比让 JS 写 Web 更成功**
- 现实证据：禁用 Wasm 引擎后，**大部分 Web 用户感知不到任何差别**

**flohofwoe（tiny8bit、sokol-wgpu、doom-sokol 等多个 Wasm 项目的作者）**反驳：

> "I created and maintain a couple of WASM projects and have not experienced the problems you describe...
> https://floooh.github.io/tiny8bit/
> https://floooh.github.io/sokol-webgpu/
> All those projects also compile into native Windows/Linux/Mac binaries and run at about the same performance (give or take 5..10% depending on CPU type) in WASM versus their natively compiled counterparts."

他的反驳：
- Wasm 的"性能问题"早就解决了
- Component Model 的**2x 字符串编组性能**只是附加好处
- 真正的问题是**开发体验**——而 Component Model 正是为这个来的

我看完整个 thread 后的判断是：**他们都对，但说的是不同维度的问题**。pizlonator 站在"Web 平台演进"角度，flohofwoe 站在"开发者工具链"角度。Wasm 在 Web 上**已经能跑得很快**（flohofwoe 没错），但**"普通开发者根本不会选择用 Wasm 写 Web"**（pizlonator 也没错）。

而 Lin Clark 那篇 Mozilla 文章要解决的，**是 flohofwoe 这一侧的问题**。

---

## 五、Component Model 登场：把 Wasm 从"模块"升级成"组件"

2026 年 WebAssembly Community Group 在慕尼黑会议上推进的解决方案叫做 **Component Model**（[规范仓库](https://github.com/WebAssembly/component-model)），从 2021 年开发至今。

它的核心思想是：

> **让 Wasm 不再是"一堆字节码"，而是一个自带类型签名、自带依赖描述、自带 Web API 绑定的"组件"。**

### 5.1 旧模型：Wasm 模块 + 胶水 JS

```
┌──────────────────┐         ┌──────────────────┐
│  module.wasm     │         │  glue.js         │
│  (字节码)        │  ←───   │  (手写/生成)     │
│  无类型签名      │  配合   │  负责所有 I/O    │
│  无 API 描述     │         │  字符串编组      │
│  无 Web API 知识 │         │  DOM 调用转发    │
└──────────────────┘         └──────────────────┘
```

### 5.2 新模型：Component 自给自足

```
┌──────────────────────────────────────────────┐
│  component.wasm                             │
│  ┌──────────────┐   ┌───────────────────┐  │
│  │ 核心 Wasm    │   │ WIT 接口描述      │  │
│  │ 模块（多个） │   │ (WebIDL 子集)     │  │
│  └──────────────┘   └───────────────────┘  │
│  浏览器自动识别类型、自动绑定 Web API        │
└──────────────────────────────────────────────┘
```

**WIT（WebAssembly Interface Types）** 是 Component Model 用来描述组件接口的 IDL。Lin Clark 给出了一个假设性示例（虽然 `std:web/console` 接口今天还不存在）：

**WIT 文件**（描述组件需要哪些 Web API）：

```wit
package std:web;

interface console {
    log: func(msg: string);
}
```

**Rust 源代码**（开发者只需关心业务逻辑）：

```rust
use std::web::console;

fn main() {
    console::log("hello, world");
}
```

**加载方式**（未来的浏览器原生支持）：

```html
<script type="module" src="component.wasm"></script>
```

**就这样**。不需要手写 JS 胶水、不需要 wasm-bindgen、不需要 import 声明。浏览器解析 WIT、自动把 Web API 绑定到组件的 imports。

### 5.3 跨语言互操作：一个图像解码器

Lin Clark 给出了另一个示例：**用 Rust 写一个图像解码器，让 JS 像调用本地模块一样调用它**。

**WIT 定义**：

```wit
package my:image;

interface image-lib {
    record pixel {
        r: u8, g: u8, b: u8, a: u8,
    }
    
    resource image {
        from-stream: static async func(bytes: stream<u8>) -> result<image>;
        get: func(x: u32, y: u32) -> pixel;
    }
}

component my:image {
    export image-lib;
}
```

**JavaScript 调用**（用 ES Module 语法）：

```javascript
import { Image } from "image-lib.wasm";

let byteStream = (await fetch("/image.file")).body;
let image = await Image.fromStream(byteStream);

let pixel = image.get(0, 0);
console.log(pixel);  // { r: 255, g: 255, b: 0, a: 255 }
```

**重点**：`image-lib.wasm` 是 Rust 写的，但 JS 调用它的方式**和调用任何 JS 模块没有任何区别**。这就是 Component Model 想实现的目标——**"Wasm 组件对 Web 来说就是 JS 模块，反之亦然"**。

---

## 六、Component Model 的"三件套"

要把上面的设想变成现实，需要三件事配套推进：

### 6.1 ESM-integration（已部分实现）

让 Wasm 组件能像 ES Module 一样被 `import` 或通过 `<script type="module">` 加载。Firefox 已经在实验性支持，主流打包器（Vite、Rollup、Webpack）也已经通过插件支持 Wasm 的 import 语法。

**这一层解决的是加载问题。**

### 6.2 Component Model（开发中，2021 至今）

把多个 Wasm 核心模块打包成一个组件，带有 WIT 接口描述、自带 ABI 规范。

**这一层解决的是类型和接口问题。**

### 6.3 WASI Preview 2（已发布）/ Preview 3（开发中）

WASI（WebAssembly System Interface）是 Component Model 的**第一个落地场景**——服务器端的 Wasm 组件用同一套 WIT 接口描述系统调用。

- **Preview 2**（2024）：定义了核心 WASI 接口（http、filesystem、cli、randomness 等）
- **Preview 3**（2026 在做）：加入 async、threading、组件间共享资源等

**这一层解决的是"非 Web 场景"的可移植性问题。**

字节码联盟（Bytecode Alliance）下的 jco 工具（[GitHub](https://github.com/bytecodealliance/jco)）已经能在 Node.js 和浏览器中**转译 Wasm 组件为 ES Module**——意味着你可以今天就开始写 Component Model 风格的 Wasm 应用，只是浏览器原生 `<script type="module" src="component.wasm">` 还要等。

---

## 七、为什么这件事比"性能优化"重要

看完上面的内容，你会发现 Component Model 其实**不是一个性能优化**——它解决的是**开发者生态位**的问题。

让我换一个角度说：如果 Wasm 始终需要 JS 胶水，那么 Web 平台**永远只有一个真正的"一等公民"——JavaScript**。其他所有语言都只是"客人"，必须用主人家（JS）的方式说话。

**Component Model 要做的就是：把客厅扩建成开放厨房，让别的语言也能直接做菜。**

这件事的战略意义有几层：

1. **对 Rust 生态**：Dioxus、Yew 等 Rust 前端框架的最大障碍不是性能（Rust 早就解决了），是开发者要写大量 wasm-bindgen 胶水。Component Model 让 Rust 写前端变得"正常"。
2. **对 Python/JVM 系**：Django、Spring 应用搬到浏览器？以前要写 JS-FFI 胶水，未来可以直接编译成 Wasm 组件。Google 的 Java → Wasm-GC 编译已经拿到显著的内存/速度改善（HN 评论里 eqrion 提到的）。
3. **对原生应用替代**：很多政府/银行应用**只**做 Web，因为 App Store 审核太麻烦。Wasm 组件如果成熟，这些应用就能有**接近原生**的体验，绕开 Apple/Google 的平台税（HN 评论区 glenstein 提到的论点）。
4. **对 AI Agent 时代**：Agent 生成代码运行时需要安全沙箱——Wasm 的沙箱设计天然适合。**少了 JS 胶水，Wasm 在 Agent 生态中才有竞争力。**

---

## 八、一些诚实的疑虑

但我必须说，**这件事没那么乐观**。

**1) 性能是优势但也只是部分优势**

flohofwoe 自己承认："我做的 8-bit 模拟器在 Wasm 和原生之间只差 5-10%。"——这说明 Wasm **作为编译目标**已经够好。但 45% 的 DOM 胶水开销是在"用 Web API"的场景。**如果 Component Model 没把"直接调用 Web API"这件事做对，开发者还是不会主动选 Wasm 写 Web 前端。**

**2) Component Model 自身有复杂度**

HN 评论区里多位资深 Wasm 开发者（bvisness、davexunit、bloppe）都指出 Component Model 的**shared-nothing 架构**有缺陷——它不允许跨组件共享 GC 对象。这意味着如果你把一个 React-like 组件系统用 Component Model 写，**状态共享会变得非常痛苦**。对比之下，Wasm GC 内部能共享引用，Component Model 却不行。

**3) 浏览器厂商的优先级**

Apple 在 W3C 中**长期**对"让 Wasm 更强大"持消极态度（HN 评论 leptons、lyu07282 提到）。理由是 Apple 不想让 Web 应用**威胁** App Store 的收入——Web 应用越强大，用户装原生 App 的意愿就越低。**没有 Apple 的全力支持，Component Model 的浏览器实现永远是瘸腿的。**

**4) 工具链尚未稳定**

eqrion（Mozilla 工程师，Component Model 设计者之一）在回复中承认："There has also been a lot of churn as the wasm component spec has changed."——也就是说规范本身**还在剧烈变化**。这种状态下生产环境使用风险很大。

---

## 九、给不同角色的一些建议

**如果你在做语言/编译器（Rust、Go、Python、Java）**：
- 2026 年内跟踪 Component Model 进展，但**不要**急着集成到生产工具链
- 等 WASI Preview 3（2026 下半年预计）落地后，工具链会趋于稳定
- WIT 接口对编译器后端来说是新的代码生成目标——值得提前做技术储备

**如果你是前端/全栈工程师**：
- 学习 Wasm 的核心概念（线性内存、ABI、import/export）仍然有价值
- 但**别急着把"用 Rust 写前端"作为技能方向**——Component Model 成熟前，JS 工具链的 ROI 仍远高于 Wasm
- 关注 Figma、Photoshop Web、Autodesk、Figma Slides 这类**高负载应用**的演进——它们是 Wasm 在 Web 上最有说服力的用例

**如果你是 Web 平台/浏览器厂商**：
- Component Model 不是"可选优化"——它决定了 Web 平台未来 10 年的开发者构成
- Apple 当前的消极态度会拖整个生态的后腿
- 字节码联盟（Bytecode Alliance）已经给出了参考实现，浏览器只需要跟进

**如果你是做 AI Agent / 边缘计算**：
- Wasm 的沙箱 + 跨语言 + 跨平台特性是**最契合 Agent 时代的运行时**
- 提前布局 Wasm 组件化 = 提前占据下一代"应用分发格式"的位置
- Cloudflare Workers、Vercel Edge、Fastly Compute 都已经在生产用 Wasm 了

---

## 十、写在最后

WebAssembly 走到 2026 年这个节点，**真正缺的从来不是性能**（早就够了），**也不是新指令**（SIMD、GC、Threads 也都加了），**而是和 Web 平台的关系**。

Component Model + ESM-integration + WIT 这一套三件套，是 9 年来**第一次**认真地回答这个问题：

> "**Wasm 凭什么在 Web 平台上是个一等公民？**"

答案不是"Wasm 比 JS 更快"，而是"**Wasm 组件可以像 JS 模块一样被加载、调用、组合**"。

这件事短期内（1-2 年）不会有爆炸性影响——大多数 Web 应用仍会继续用 JS 写。但 5 年后回头看，2026 年可能就是**Web 平台从"JavaScript 唯一"转向"多语言共存"**的转折点。

午间 TypeScript 7 告诉我们"**写编译器的语言可以变**"，晚间 Component Model 告诉我们"**编译目标平台也可以升级**"。

编译生态的演化方向，从来不只是性能数字。

---

## 相关阅读

- [Making WebAssembly a first-class language on the Web (Mozilla Hacks)](https://hacks.mozilla.org/2026/02/making-webassembly-a-first-class-language-on-the-web/)
- [Component Model Documentation](https://component-model.bytecodealliance.org/)
- [Component Model GitHub 仓库](https://github.com/WebAssembly/component-model)
- [jco — JavaScript tooling for WebAssembly Components](https://github.com/bytecodealliance/jco)
- [Hacker News 讨论（598 条评论）](https://news.ycombinator.com/item?id=47331811)
- [Dodrio 实验：JS 胶水代码的开销测量](https://hacks.mozilla.org/2020/01/using-cargo-cult-science-to-evaluate-webassembly-fallacies/)
- [午间文章：TypeScript 7 即将到来——微软把编译器从 TypeScript 移植到 Go 的 10 倍性能革命](/article/typescript-7-go-port-2026)
