---
title: "240 颗星围观：WASI 0.3 正式发布，async 终于成了 WebAssembly Component Model 的“一等公民”"
slug: wasi-03-component-model-async-first-class-2026
date: 2026-06-13
category: 技术
tags:
  - WASI
  - WebAssembly
  - Component Model
  - async
  - Bytecode Alliance
  - Wasmtime
  - WASI 0.3
  - Canonical ABI
  - stream
  - future
  - io_uring
  - 完成式异步
  - microservice chaining
  - 跨语言互操作
  - Rust WASM
  - Go goroutines
  - 开发语言绑定
  - 字节码联盟
excerpt: "2026 年 6 月 11 日，Bytecode Alliance 把 WASI 0.3.0 推上了 tag——这是 2024 年 1 月 WASI 0.2（aka WASIp2）落地两年后，WASI Subgroup 投票通过的第一份“正式”release。HN 帖一小时内冲到 240 颗星、89 条评论，评论区撕成三个阵营：一派说 async native 终于把 wasi:io 那套 pollable 三板斧打进历史垃圾堆；一派说 Component Model 的“componization”正在把 WASI 拖离“简单稳定 Unix-like API”的初心；一派干脆不认这是浏览器侧的 Wasm 演进——只承认它是“server-side 的小圈子玩具”。核心变化一句话：WASI 0.2 把 async 包成 resource（pollable / input-stream / output-stream）塞进 wasi:io package；WASI 0.3 把 async 直接做进了 Component Model 的 Canonical ABI，stream<T>、future<T>、async func 三个一等公民跨 ABI 边界。host runtime 统一管调度，guest 端不再需要各自实现事件循环——更接近 Linux io_uring / Windows IOCP 的完成式（completion-based）模型，而不是 epoll/kqueue 的就绪式（readiness-based）。配合 wasi:http/service + wasi:http/middleware 两套 world，微服务之间的本地链式调用理论上能从“毫秒级”压到“纳秒级”——6 个数量级。Wasmtime 46 会默认开启 Component Model Async，jco 紧随其后；Rust/Go/Python/C#/JS 工具链在 WASI 0.3 下的绑定生成还在路上。"
cover: https://images.unsplash.com/photo-1629654297299-c8506221f9f3?w=600&h=400&fit=crop
readtime: 18
views: 0
---

# WASI 0.3 正式发布：async 终于成了 WebAssembly Component Model 的"一等公民"

> **2026-06-11 17:06:50 UTC** — Bytecode Alliance 在 GitHub 上给 [WebAssembly/WASI](https://github.com/WebAssembly/WASI/releases/tag/v0.3.0) 仓库贴上 `v0.3.0` tag，同时把 [WASI 0.3 announcement](https://bytecodealliance.org/articles/WASI-0.3) 发到官方博客。14 小时后，[HN 帖](https://news.ycombinator.com/item?id=48504063) 冲到 240 颗星、89 条评论——这是 2026 年至今 WebAssembly 方向得分最高的非 AI 技术帖。

这是 WASI 0.2（2024-01-25 落地，aka WASIp2）两年之后的第一份"正式"release。两份官方材料讲的是同一件事的两个角度：

- **GitHub Release Notes**（7816 字节）—— 逐 interface 的机械对照表 + 迁移指南，代码级别硬核
- **官方博客 announcement**（9742 字节）—— 讲清楚"为什么 0.3 几乎只是机械翻译"，附带 Rust/Go/Python 绑定例子

字节码联盟的官方表述很克制："Most of the changes from WASI 0.2 to 0.3 are entirely mechanical and significantly simplify the signatures we had before."

但 HN 评论区的画风截然相反。

---

## 一、WASI 0.3 到底改了什么——一句话版本

WASI 0.2 把"异步"塞进了一个叫 `wasi:io` 的 package，用三种 resource 模拟异步：**`pollable`**（一个可以 `.subscribe()` 然后被 `poll([...])` 唤醒的句柄）、**`input-stream`**（只读）、**`output-stream`**（只写）。所有"启动一个操作"都得拆成 `start-foo()` + `finish-foo()` 两步——`finish-bind()`、`finish-connect()`、`subscribe-instant()`，再让 `poll(list<pollable>)` 帮你在多个句柄之间轮流等待。

这套设计让 WASI 0.2 第一次能跑出像样的 HTTP server，但它有三个先天毛病：

1. **每个组件（component）得自带事件循环**——host runtime 没办法跨组件协调
2. **流式 API + 异常诊断的二选一难题**——`read-via-stream` 在流关闭和异常关闭时返回的是同一个"end-of-stream"信号，调用方要读完才知道是不是出错了
3. **微服务不能直接复用**——一个微服务想调用另一个微服务，必须穿越 network boundary，毫秒级延迟

WASI 0.3 的解决思路很硬：把 async 直接做进 Component Model 的 Canonical ABI——`stream<T>`、`future<T>`、`async func` 全部成为一等公民。host runtime 现在是唯一的"调度员"，所有组件共享同一个事件循环；调用 `connect(...)` 不再需要 `start-connect` + `finish-connect` + 等待一个 `pollable`——直接 `connect: async func(...)`，编译器/绑定生成器会在 ABI 边界替你把同步世界翻译成异步世界。

异步模型从**就绪式（readiness-based）**换成了**完成式（completion-based）**——**和 Linux io_uring、Windows IOCP/IoRing 一脉相承**。博客原话："This is similar to the ultra-efficient Linux io_uring and Windows' IOCP/IoRing APIs."

---

## 二、6 个 interface 的"机械翻译"对照表

官方把"哪些是机械翻译、哪些是真的重设计"列得明明白白：

### 2.1 wasi:cli —— stdio 的方向反转

```wit
// WASI 0.2
interface stdin {
  use wasi:io/streams.{input-stream};
  get-stdin: func() -> input-stream;
}
interface stdout {
  use wasi:io/streams.{output-stream};
  get-stdout: func() -> output-stream;
}

// WASI 0.3
interface stdin {
  use types.{error-code};
  read-via-stream: func() -> tuple<stream<u8>, future<result<_, error-code>>>;
}
interface stdout {
  use types.{error-code};
  write-via-stream: func(data: stream<u8>) -> future<result<_, error-code>>;
}
```

注意 stdout 的方向**反过来了**——0.2 是"你拿到一个 `output-stream` 然后 `write()`"；0.3 是"你传一个 `stream<u8>` 进去，host 写完后给你一个 `future<result<...>>`"。这是完成式 vs 就绪式的根本差异：0.2 是"我准备好写了，host 你看着办"，0.3 是"我已经把数据塞进 stream 了，写完告诉我"。

同时 `error-code` 被抽到 `wasi:cli/types` 这个共享 package：`io`、`illegal-byte-sequence`、`pipe` 三个 variant，所有 cli 相关接口复用。

### 2.2 wasi:sockets —— `network` resource 整体消失

这是 0.3 里**最激进**的一处改动：

```wit
// WASI 0.2
start-bind:     func(network: borrow<network>, local: ip-socket-address)
                 -> result<_, error-code>;
finish-bind:    func() -> result<_, error-code>;
start-connect:  func(network: borrow<network>, remote: ip-socket-address)
                 -> result<_, error-code>;
finish-connect: func()
                 -> result<tuple<input-stream, output-stream>, error-code>;

// WASI 0.3
bind:    async func(local-address: ip-socket-address)  -> result<_, error-code>;
connect: async func(remote-address: ip-socket-address) -> result<_, error-code>;
listen:  async func()                                  -> result<_, error-code>;
accept:  async func()
  -> result<tuple<tcp-socket, ip-socket-address>, error-code>;
```

`network` 这个 capability resource 在 0.2 里要**作为参数穿过每一个 bind/connect/lookup 调用**——典型的 capability-passing 风格。0.3 把网络访问整体移到 **world imports**——你在 WIT 里声明"这个世界能联网"，host runtime 给你权限就行，函数签名不再夹带 `network` 参数。

更彻底的：`bind-in-progress` / `connect-in-progress` / `listen-in-progress` 这一组"中间状态"resource **整体删除**。原本"开始一个 bind → 拿到一个 in-progress 句柄 → 在某个 pollable 上等待 → 调用 finish-bind"的三步舞，现在是一个 `bind: async func(...)` 完事。

UDP 同样：进出 datagram 的 stream resource 没了，换成 `async send` / `async receive` 两个方法。TCP/UDP/name-lookup 三个接口的 error-code 被**统一**成一个 variant——加了 `connection-broken` 新 case，外加一个开放式的 `other(option<string>)` 尾巴。

### 2.3 wasi:http —— 两套 world + 服务链式调用

这是 0.3 里**真正重新设计**的一个，不是机械翻译：

```wit
interface client { /* ... */ }
interface handler { /* ... */ }

world service {
  import client;   // 让组件能发出 HTTP 请求
  export handler;  // 让组件能处理 HTTP 请求
}

world middleware {
  include service;  // 继承 service 的全部能力
  import handler;   // 还能把请求转给另一个 handler
}
```

`service` 对应 0.2 的标准"既能发也能收"，`middleware` 是 0.2 的 `proxy` world 的进化版——专门给"我想转发请求到下一个 handler"的场景。

这里的关键叙事叫 **service chaining**：一个微服务要调另一个微服务，**不需要走 network**——runtime 可以直接把两个 component 拼在一起，在同一个进程里函数调用。这个优化对绝大多数微服务的意义是：**"调用其他微服务的时间从毫秒级压到纳秒级——6 个数量级"**（官方原话）。

### 2.4 wasi:filesystem —— 目录迭代从 resource 变 stream

```wit
// WASI 0.2
read-directory: func() -> result<directory-entry-stream, error-code>;
// 配上一个 resource directory-entry-stream { read-directory-entry: func() -> ... }

// WASI 0.3
read-directory: func()
  -> tuple<stream<directory-entry>, future<result<_, error-code>>>;
```

streaming read/write 也从 `(offset, result<input-stream>)` 变成 `(offset, tuple<stream, future>)`。整套 wasi:filesystem 的模式从"resource + poll"统一成"stream + future"。

### 2.5 wasi:clocks —— 几乎只是重命名，但语义变化不小

`wall-clock` → `system-clock`，`datetime` → `instant`——和 POSIX、 Rust `std::time`、其它系统对齐。这两个名字是 WASI-isms，迁就主流。

`monotonic-clock` 把 `subscribe-instant` / `subscribe-duration` 这两个返回 `pollable` 的函数删了，调用方直接 `await` 一个 host 提供的 timer future。`wasi:filesystem` 的 timestamp 跟着重命名。

下游影响"主要是机械的 find-and-replace"——[wasi-testsuite@f13976f](https://github.com/WebAssembly/wasi-testsuite/commit/f13976fec4d8ba72340c646383f76cb6cb257c93) 是一个代表性 diff。

### 2.6 wasi:io —— 整个 package 消亡

最大的机械变化：`wasi:io` 整个 package 在 0.3 里**没了**。`pollable`、`input-stream`、`output-stream` 这些 resource 全部被 `future<T>` / `stream<T>` 替代，`poll(list<pollable>)` / `subscribe()` / `start-foo` / `finish-foo` 这些 API 全部消失。

| WASI 0.2 (`wasi:io`) | WASI 0.3 (Component Model) |
|---|---|
| `resource pollable` | `future<T>` |
| `resource input-stream` | `stream<u8>` |
| `resource output-stream` | `stream<u8>` (written-to 方向) |
| `poll(list<pollable>)` | `await` on a future (runtime-handled) |
| `subscribe()` on resource | return a `future<...>` from the call |
| `start-foo` / `finish-foo` | `foo: async func(...)` |

---

## 三、绑定生成器真正的工作量

WASI 0.3 的真正故事不在 spec 上——在 **guest binding generator**（给各编程语言生成"看起来像原生"的绑定）上。Component Model 的核心承诺就是跨语言互操作，async native 之后这个承诺才真正能兑现。

### 3.1 Rust：用 `wit-bindgen` 拿到 `async fn`

```rust
use wasi::http::types::{ErrorCode, Request, Response};

impl Guest for Component {
    async fn handle(request: Request) -> Result<Response, ErrorCode> {
        // ...
    }
}
```

`wit-bindgen` 把 `wasi:http/handler.handle: async func(...)` 直接映射成 Rust trait 的 `async fn handle`。stackless coroutine 友好——编译器原生支持 `async`。

### 3.2 Go：goroutine 在 ABI 边界被 park

Go 是 stackful coroutine（goroutine 是真正的协程，不是编译器的协程变换）。Component Model async ABI **从设计的第一天**就考虑到了 stackful 和 stackless 的混用。用 `componentize-go` 写 HTTP server：

```go
package export_wasi_http_handler

import (
    . "wit_component/wasi_http_types"
    . "go.bytecodealliance.org/pkg/wit/types"
)

func Handle(request *Request) Result[*Response, ErrorCode] {
    tx, rx := MakeStreamU8() // 1. 创建 channel pair
    go func() { // 2. spawn virtual thread
        defer tx.Drop()
        tx.WriteAll([]uint8("Hello, world!")) // 3. 写入 channel
    }()

    response, send := ResponseNew( // 4. 创建 HTTP response
        FieldsFromList([]Tuple2[string, []byte]{
            {F0: "content-type", F1: []byte("text/plain")},
        }).Ok(),
        Some(rx), // 5. 把 receiver 当 HTTP body
        trailersFuture(),
    )
    send.Drop()

    return Ok[*Response, ErrorCode](response) // 6. 返回 HTTP response
}
```

runtime 在 ABI 边界把同步的 goroutine **park** 住——等到 stream ready 再 resume，**整个程序的其它 goroutine 不阻塞**。这是 Go 写 server-side Wasm 一直以来的痛点，WASI 0.3 + componentize-go 直接填了这个洞。

### 3.3 Python / JavaScript / C# / C

这些 stackless coroutine 语言的绑定生成"进行中"。Python 的 `asyncio`、JS 的 `async/await`、C# 的 `Task`、C 的 `_Noreturn`/libuv 风格——都在向 Component Model 的 async ABI 收敛。

官方原话："Async support for guest binding generators is also in-progress for many languages including Python, JavaScript, C#, and C."

---

## 四、HN 三大阵营——240 颗星背后的真争议

评论区撕得比 spec 本身精彩。13 条主要评论里，**有 6 条长度超过 200 字符**，按观点归类：

### 4.1 速度派：async native 是 wasm 唯一的活路

代表：`b33j0r`（751 字符，**最长的一条**）：

> "Love/hate with this one. How was I supposed to follow this? I tried, and few things were publicly visible for nearly two years. I last checked in march and it looked like no progress had been made. That makes me very suspicious of wasiv3. Funny enough, I already implemented a bunch of the promises (pun not intended) and think that freestanding wasm with custom integrations is the more likely future. The promise of wasi components has not been fulfilled. The market wants to hotload and load modules, not generate them. **Just like Web 1.0/2.0/3.0, eventually components will be widely adopted, but it will be due to big companies with huge engineering teams building internal tools.**"

——态度是"欢迎发布，但过去两年的'暗箱制定'让人怀疑，最终的胜利者是企业内部的 freestanding wasm，不是 wasi components"。

### 4.2 复杂度派：Component Model 把 WASI 拖离 Unix-like 初心

代表：`garganzol`（742 字符）：

> "Wrong direction. WASI should be simple and stable. Initially, it was revolving around a simple Unix-like API model and it was close to perfect. Now, there is an opinionated component model which is an unneeded overcomplication that should have never been considered as part of WebAssembly spec IMHO. A real component model is a separate development and cannot be blindly tied to a particular ecosystem. Otherwise, its main purpose of providing easy interoperability between different ecosystems is defeated from the start."

——这是**纯粹的"spec 已经过度设计"派**。认为 Component Model 应该和 WASI 解耦，让 WASI 回到"POSIX 风格简单 API"的初心。

### 4.3 WASIX 派：现有 C/C++ 代码的兼容性不在 spec 路径上

代表：`syrusakbary`（691 字符，**Wasmer 创始人**）：

> "Congrats on the release to the WASI team. **TL;DR: WASI 0.3.0 is the Component Model-based WASI proposal. It adds async/await-style capabilities such as actors and streams, and today is runnable in only one server-side Wasm runtime (it is not supported natively by browsers). Unfortunately it still breaks compatibility with the original WASI proposal and runtimes that supported it.** If your goal is to compile existing, unmodified C/C++ programs and libraries to WebAssembly, WASIX may be the right choice for you."

——这是**Wasmer 的商业立场**：WASI 0.3 在 server-side 的 wasm 圈子里跑得通，**但浏览器原生不支持**——和"WebAssembly"这个名字的初衷越来越远；同时它和原有的 WASI 提案不再兼容。如果你只想把现有的 C/C++ 程序跑起来，WASIX（Wasmer 的扩展）仍然是更顺滑的路径。

### 4.4 主流共识：spec 是好的，落地节奏是问题

代表：`_jsdw`（461 字符）：

> "This is funny timing to me, because just the other week I did a dive into WebAssembly and WASI 0.2 ([jsdw.me/posts/wasm-components/](https://jsdw.me/posts/wasm-components/)) and assumed that 0.3 would be a while yet as there was no obvious (to me) sign it would come for a while! Once the tooling is there and Rust has a wasi 0.3 target I'll give it more of a look at :)"

代表：`simonw`（352 字符，Simon Willison 本人）：

> "If you don't want to download the .tar.gz I think you can browse the content for this release (.wit interface files) here on GitHub: [WebAssembly/WASI/tree/v0.3.0/proposals](https://github.com/WebAssembly/WASI/tree/v0.3.0/proposals)"

——这两人代表"hobbyist 开发者"立场：spec 看起来对，但等 Rust 工具链原生支持 0.3 之前不会真正上手。

### 4.5 异见：异步的 stack-switching 实现不成熟

代表：`hmry`（256 字符）：

> "Does the stackfull async implementation use the stack-switching proposal? I was under the impression that it's not implemented in most runtimes (very difficult to retrofit into existing implementations), and only available on x86_64 Linux in wasmtime."

——这是**技术派里最尖锐的质疑**。stack-switching proposal 是 Component Model async 在 stackful 语言（Go 协程、C# async state machine）下能工作的关键，但目前只有 wasmtime 的 x86_64 Linux 实现了，其它架构（arm64、RISC-V、Windows、macOS）都还没跟上。这意味着 Go 在 wasm32 上跑跨架构的"实战可用"还要再等。

---

## 五、落地状态——今天能用什么、还要等什么

官方公告的"已经能用了"清单：

| 组件 | 状态 | 时间表 |
|---|---|---|
| **WASI 0.3 spec** | ✅ 已投票通过，稳定 release | 已发布（2026-06-11） |
| **Wasmtime 45** | ⚠️ 跑 RC，async 默认关 | 当前可用 |
| **Wasmtime 46** | 🚧 默认开启 Component Model Async | 下一个 release |
| **jco** (JavaScript Component Model) | ⚠️ 支持 0.3，但默认关闭 | 近期 release |
| **wit-bindgen** (Rust) | ⚠️ 部分支持 | "in progress" |
| **componentize-go** | ⚠️ 部分支持 | "in progress" |
| **Python / JavaScript / C# / C** | 🚧 在路上 | 几周到几月内陆续 |
| **浏览器原生 WASI 0.3** | ❌ 不支持 | 未公布时间表 |

GitHub [WebAssembly/WASI](https://github.com/WebAssembly/WASI) 仓库当前 **5676 颗星、324 fork、249 open issues**（API 拉取于 2026-06-13 06:27 UTC）。[bytecodealliance/wasmtime](https://github.com/bytecodealliance/wasmtime) 当前 **18176 颗星、1736 fork、838 open issues**——和 Bun（96931）、PiFS（3129）这些同期新闻的 star 量级比，wasm 生态的"旗舰项目"规模其实**并不大**。

---

## 六、WASI 0.3 真正的工程意义

把 spec 翻译成"对你意味着什么"：

### 6.1 对 server-side Wasm 工程师：组件终于能"自然地"跨语言

WASI 0.2 已经能做到"用 Rust 写 component、用 Go 写 component，两者互相 import"——但每个 component 得有自己的事件循环，跨组件的 async 调用需要手动 pollable 协调。WASI 0.3 + Component Model native async 让这件事变成**编译器/绑定生成器自动做**的事。

实际场景：用 Rust 写一个 HTTP server component（用了 tokio），用 Python 写一个图像处理 component——两者在同一个 process 里跑，Rust 的 tokio future 和 Python 的 asyncio future 通过 Component Model 的 future<T> ABI 互通，host runtime（Wasmtime 46）做调度。**跨语言 async 调用不再需要手动翻译"哪个 runtime 接管事件循环"。**

### 6.2 对微服务架构：6 个数量级的本地调用延迟

服务链式调用（service chaining）的实际收益：

- **传统的 service-to-service call**：HTTP/gRPC 协议栈 + serialization + 网络往返——典型延迟 **0.5-5 ms**
- **WASI 0.3 component composition**：同进程内的 host function call——典型延迟 **50-500 ns**

Bytecode Alliance 官方博客原话："For most microservices this will reduce the time for calling other microservices from milliseconds to nanoseconds: six orders of magnitude."

对**调用链很长**的微服务（比如 service mesh 里 5-10 个 hop 的 request），整体延迟可能从"几十毫秒"压到"几微秒"。但前提是你的 runtime 真的做了 component composition 而不是 fallback 到 network。

### 6.3 对浏览器侧 Wasm：0.3 短期内和你无关

`syrusakbory` 的提醒值得反复看："today is runnable in only one server-side Wasm runtime (it is not supported natively by browsers)"。

Chrome / Firefox / Safari 的 Wasm VM（V8 / SpiderMonkey / JavaScriptCore）目前**不支持** Component Model 的 stack-switching async。这意味着：

- 你在浏览器里跑 WASI 0.3 的 component，async API 不会真的异步执行
- 浏览器侧的 Wasm 生态（e.g. Cloudflare Workers、Fastly Compute、Shopify Functions）还需要等浏览器跟进
- 当下，如果你做的是**浏览器侧 wasm**（WASI 0.2 的命令式 API 路径），WASI 0.3 暂时帮不上忙

### 6.4 对 spec 追踪者：下一站是 Component Model 1.0

官方公告最后一句："If you're wondering what's next for WebAssembly Components and WASI, see [The Road to Component Model 1.0](https://bytecodealliance.org/articles/...)"——HN 帖同一天的另一篇（95 颗星）就在讲这条路（HN id 48448083）。

Component Model 1.0 要解决什么？根据 WASI 0.3 的 release notes 透露的几点：
- 把 component 跨 runtime 互操作**完全确定下来**——目前各家 runtime 在 ABI 边界行为上有微妙差异
- 让"长时间运行的 service"（server-side daemon）成为一等公民
- 解决"组件热更新 / component instance migration"

---

## 七、未来 6-12 个月可被验证的硬指标

结尾不给情绪，给"可被验证的"硬指标——6-12 个月后回来查：

1. **Wasmtime 46 release date + 是否默认开启 Component Model Async**——验证官方公告的承诺
2. **Rust stable 工具链支持 `cargo build --target wasm32-wasip3`**——这是 Rust 程序员"上手 0.3"的真正门槛
3. **stack-switching proposal 在 wasmtime arm64 / macOS / Windows 的实现状态**——决定 Go 和 C# 能不能真的"实战"
4. **componentize-go 是否被 Wasmer 之外的 runtime 采纳**——决定 Component Model async 是"一家之言"还是"行业共识"
5. **WASI 0.3 浏览器侧实现的首个 GA 落地**——V8 / SpiderMonkey / JavaScriptCore 哪家先动
6. **wasi-testsuite 在 0.3 下的 coverage**——决定"宣称稳定"和"实测稳定"的差距
7. **`wasi:io` package 的 deprecation timeline**——0.2 用户真正迁移的窗口
8. **service chaining 在 production microservice 框架里的实测延迟**——验证"6 个数量级"的真实数据

---

## 八、给读者的一句话总结

WASI 0.3 不是"WebAssembly 浏览器侧的进化"——它是**server-side Wasm runtime 圈的 spec 升级**，把 async 从"每个组件自带事件循环"统一到"host runtime 单一调度"，并用 stream<T> / future<T> / async func 三个原生概念替代了 wasi:io 的 resource-pollable 三板斧。

**如果你做的是 server-side Wasm**：Wasmtime 46 + Rust/Go 工具链跟上后，WASI 0.3 是你新的"默认 target"——跨语言 async interop 和 service chaining 是真实的生产力提升。

**如果你做的是浏览器侧 Wasm**：WASI 0.3 暂时和你无关。等浏览器跟进 stack-switching proposal。

**如果你在选型**：spec 已稳定，但**生态还差最后一公里**。Rust stable target、Go 跨架构 stack-switching、浏览器原生支持——这三个里只要有一个延迟超过 12 个月，WASI 0.3 在你公司的"下一年度技术雷达"上仍会停在"评估"而不是"采纳"。

---

## 参考资料

1. [WASI 0.3 announcement — bytecodealliance.org](https://bytecodealliance.org/articles/WASI-0.3)
2. [WASI 0.3.0 release notes — GitHub](https://github.com/WebAssembly/WASI/releases/tag/v0.3.0)
3. [WASI 0.2 launch post — bytecodealliance.org](https://bytecodealliance.org/articles/WASI-0.2)
4. [HN thread: WASI 0.3 (240 pts, 89 comments)](https://news.ycombinator.com/item?id=48504063)
5. [WebAssembly/WASI v0.3.0 .wit interface files](https://github.com/WebAssembly/WASI/tree/v0.3.0/proposals)
6. [The Road to the WASM Component Model 1.0 — bytecodealliance.org (HN 95pts)](https://news.ycombinator.com/item?id=48448083)
7. [WebAssembly Component Model book](https://component-model.bytecodealliance.org/)
8. [Wasmtime 18,176 stars / 838 open issues — GitHub](https://github.com/bytecodealliance/wasmtime)
9. [WASI 5,676 stars / 249 open issues — GitHub](https://github.com/WebAssembly/WASI)
10. [How Wasm Components Enable Pluggable Middleware — bytecodealliance.org](https://bytecodealliance.org/articles/how-wasm-components-enable-pluggable-middleware)
11. [wasi-testsuite commit f13976f (representative 0.2 → 0.3 migration diff)](https://github.com/WebAssembly/wasi-testsuite/commit/f13976fec4d8ba72340c646383f76cb6cb257c93)
12. [componentize-go — GitHub](https://github.com/bytecodealliance/componentize-go)
13. [wit-bindgen — GitHub](https://github.com/bytecodealliance/wit-bindgen)
14. [jsdw.me — A dive into WebAssembly and WASI 0.2](https://jsdw.me/posts/wasm-components/)
15. [WASI#79 — Avoid nonstandard use of names for types](https://github.com/WebAssembly/WASI/pull/79)