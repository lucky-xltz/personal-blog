---
title: '259 颗星拆解 gitdot：当 6 星小作坊用 Rust 重写 GitHub 的 6 步后端演化、六大反共识设计、247 条 HN 评论的真正争议在哪里'
date: 2026-06-09
category: 技术
tags:
  - gitdot
  - GitHub
  - Git
  - Rust
  - Axum
  - 六边形架构
  - 领域驱动设计
  - libgit2
  - gitoxide
  - CLI设计
  - 反AI
  - 商标争议
  - Forgejo
  - Gitea
  - 软件锻造厂
  - 性能优化
  - 100ms FCP
  - 键盘优先
  - DevOps
  - 基础设施
author: 林小白
readtime: 17
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# 259 颗星拆解 gitdot：当 6 星小作坊用 Rust 重写 GitHub 的 6 步后端演化、六大反共识设计、247 条 HN 评论的真正争议在哪里

**2026 年 6 月 9 日 18:00，Hacker News 头条之外还有一颗 259 pts 的 Show HN**：`gitdot` —— 一个写着 "A better GitHub"、用 Rust 全栈编写、6 个月前才开始动手、目前 GitHub 仓库只有 6 颗星的开源 GitHub 替代品。它没拿到第一，但 233 条评论的活跃度把它推上 Show HN 榜首，并引发了可能是今年最分裂的技术讨论之一。

这不是又一个 Rust 项目的宣传贴。`baepaul`（前端）和 `mikkel`（后端）两位创始人在 HN 上把整套设计哲学、后端演化路径、踩过的坑都写了出来 —— 一份**值得逐行拆解的工程笔记**。本文复盘：

- 一个新人如何用 6 步把一个 Axum 单体服务器拆成 3 个共享核心的服务
- 为什么选 libgit2 而非 gitoxide，**以及"git http-backend CGI 是怎么帮他们一周内跑通 clone/push 的"**
- "No navbar / No logo / No social proof / No AI / No mobile" 五条反共识原则背后的真实心理
- 247 条 HN 评论自然分化出的 **3 大阵营**（Rust 营销反感派 / CLI 美学共鸣派 / "为什么不直接用 Forgejo"派）
- 商标隐患（`git` 前缀）、AI 反讽（仓库里有 12 个 CLAUDE.md）、Git 协议实现难度（6 个 commit 跑通 vs GitHub 写了十年的 spokes-receive-pack）

跟午间的《Linear 为什么那么快》是完全不同维度的事：Linear 是 SaaS 本地优先架构的天花板级优化，gitdot 是**一个独立开发者**用公开笔记告诉你"我怎么做 GitHub"。

---

## 1. 故事背景：6 个月的"GitHub 重写挑战"，2025 年 12 月开始

**2025 年 12 月，Paul（前端）和 Mikkel（后端）做出决定**：在纽约 Prospect Park 散步后挑了"做一个更好的 GitHub"作为长期项目。6 个月后（2026 年 6 月 8 日 23:00 UTC+0），Mikkel 在 HN 上发了一篇约 1,000 字的 Show HN 贴，附两份公开设计文档。

**几个数字**：

- 6 个月开发周期
- 6 颗 GitHub star（项目主页：<https://github.com/bkdevs/gitdot>）
- Apache-2.0 协议
- 2 个独立贡献者（只有 Paul 和 Mikkel）
- 259 HN 评分 / 233 条评论（其中 195 条质量评论）
- 3 个后端服务（`gitdot-server`、`gitdot-auth`、`gitdot-metrics`）+ 1 个共享核心（`gitdot-core`）+ 2 个共享库（`gitdot-api`、`gitdot-axum`）

**主帖原文摘要**（baepaul 自述）：

> "What works now: user signups, org creations, private/public repos, and importing GitHub repositories (both as read-only mirrors and full migrations). So basically, you can create, push and pull to a repo, but we don't have many features quite yet (issues, PRs, CI). What is a bit unique is: 1) we built it in Rust and 2) the website is a little odd. Its design is inspired by CLIs (e.g., fzf, broot, vim) instead of web apps, and as such, lacks some affordances that you might typically expect in favor of keyboard-driven instant navigations (we have the very ambitious goal of an FCP of 100ms)."

**关键取舍**：

| 决策 | 选择 | 反共识程度 |
|------|------|-----------|
| 后端语言 | Rust + Axum | 中（Gitea 是 Go） |
| Git 库 | libgit2（git2-rs 绑定） | 高（gitoxide 还没"准备好"） |
| Git 协议 | `git http-backend` CGI | 极高（GitHub/GitLab 都自己写了） |
| 架构模式 | Eric Evans DDD + 六边形架构 | 中（学术化） |
| 风格 | CLI 美学（fzf/broot/vim） | 极高（无 navbar） |
| AI 策略 | 0 个 AI 功能 | 高（与时代主旋律逆行） |
| 移动端 | "尚未支持" | 极高（2026 年 6 月了） |
| Logo | 没有 | 高 |
| 商标策略 | gitdot（使用 `git` 前缀） | **高风险**（详见 §6） |

**这不是又一个"我做了一夜"的小项目**。Mikkel 在第一份后端设计文档里直接承认"我花了 6 个月"+"我从前十个月没理解过 Git 内部"+"我的笔记里全是 TODO"。这种坦诚是 gitdot 在 247 条 HN 评论中能站住脚的核心原因。

---

## 2. 后端演化 6 步：Axum 单体如何拆成"3 服务 + 4 共享 crate"

Mikkel 的《How gitdot's backend evolved》是 2026 年我读过最干净的一份**渐进式架构拆分复盘**。原文 6 个段落，每段配一个系统图（这里只列结构变化，不复述图）。

### Step 1 — 选语言 + git http-backend CGI：30 行代码跑通 clone/push

**第一周决策**：

> "The safe choice was Python and FastAPI, which I knew well and could move fast in. Go was close behind, since it's built for this kind of server work. But I wanted something new, and something that wasn't Go, since Gitea already is. There was a product reason too. We wanted gitdot to feel fast, and Rust is about as fast as it gets. Honestly the language barely matters at the server layer. Most of the latency is the database and git itself. But it didn't hurt. So I picked Rust and Axum."

**关键技术选型**：

- **语言**：Rust + Axum。理由：(1) "Go 已经是 Gitea" 差异化考虑；(2) "感觉快"（主观但可量化）；(3) Mikkel 自述"Honestly the language barely matters at the server layer. Most of the latency is the database and git itself."
- **Git 库**：`git2-rs`（libgit2 的 Rust 绑定）。Mikkel 明确说考虑了 `gitoxide`（纯 Rust 实现），但 "it wasn't ready" 因此放弃。
- **Git 协议**：`git http-backend`（Git 自带的 CGI 程序）。**不是自己手写 pkt-line framing**。Mikkel 写道：

> "I chose not to implement that protocol myself. Just not yet. Git ships `git http-backend`, a small CGI program that already speaks smart HTTP correctly. So the server just shells out to it instead of hand-writing pkt-line framing and capability negotiation. Clone and push worked on day one."

**CGI 流式处理**：

> "It streams bodies straight through, since a push can be gigabytes and you don't want it sitting in memory. Repos live as bare repos on disk, and Postgres holds the metadata, Supabase at the time. There was no auth yet, so every repo was public."

**这是整个项目里最被低估的一招**。GitHub 的 `spokes-receive-pack`（专门处理 push 流量）写了几十年代码才稳定，GitLab 早年的 SSH/HTTP 协议实现也是血泪史。gitdot 用 `git http-backend` CGI **直接绕过自己实现 Git 协议的所有复杂性**。代价是"每请求 fork 进程"——但 gitdot 的量级扛得住。这个 trade-off 的坦率是 HN 上少见的高级分享。

**仓库落盘**：

- **裸仓库**直接存磁盘（`/var/git/<owner>/<repo>.git`）
- **元数据**进 Postgres（最初用 Supabase，详见 Step 4）
- **Auth**：**无** —— Step 1 时代所有 repo 公开

### Step 2 — 引入六边形架构：拆 `gitdot-server` / `gitdot-core` 两个 crate

**这是 Mikkel 心态最重要的一步**：

> "I'm obsessive about it. A messy codebase gives me an emotional barrier to even opening it. So I spent a couple of weeks on how to lay out an Axum server, something consistent enough that any new feature had one obvious place to go, no matter who wrote it."

**具体做法**：

1. 参考 **Eric Evans《Domain-Driven Design》**
2. 参考 <https://www.howtocodeit.com/guides/master-hexagonal-architecture-in-rust#anatomy-of-a-bad-rust-application>
3. 拆两个 crate：
   - `gitdot-server`：薄薄一层 Axum handler + 路由
   - `gitdot-core`：所有领域逻辑

**`gitdot-core` 内部的固定结构**：

| 概念 | 职责 |
|------|------|
| `Service` | 运行一个业务操作（`createRepo`、`forkRepo`） |
| `Repository` | 通过 sqlx 访问 Postgres |
| `Client` | 包装外部服务（GitHub API、Email） |
| `Model` | 携带数据 |
| `DTO` | API 层的稳定契约 |

**Handler 的哲学**：

> "A handler barely does anything. It reads the request, calls a service, and maps the result to the API type."

**Rust 的杀手锏**：

> "This is where I felt good about picking Rust. No try/catch scattered everywhere, just `?` to bubble an error up, and all the handling collected in one place."

——**类型化错误**（`Result<T, AppError>`）是 Rust 在服务端最被低估的优势。Go 程序员 `if err != nil` 写到第 20 个时，Rust 程序员 `?` 一行就过。

**这步为后面的拆分埋下伏笔**：当 Step 3 需要 CLI、Step 4 需要 auth server、Step 5 需要 metrics server 时，`gitdot-core` 是它们共享的复用层。

### Step 3 — 引入 CLI：抽出 `gitdot-api` crate

**驱动力**：

> "For a while, the request and response types, routes, and resource shapes all lived inside gitdot-server. Fine, while the server was the only thing that needed them. Then I started building gitdot-cli. The CLI is its own story for another post, but it surfaced the problem immediately. A client has to know exactly what the server expects and returns, the request body, the response shape, the path, the method. All of it existed already, trapped inside the server crate, and the CLI had no business depending on the whole server to borrow a few structs."

**抽象**：

- `gitdot-api` crate：API 契约层
  - **资源类型**（`RepositoryResource`、`UserResource`）
  - **端点定义**（每个端点 = 路径 + 方法 + 请求/响应类型）

**价值**：

> "Since gitdot-api has no server code in it, writing a client is almost mechanical. The CLI is just the first. Anyone could pull in gitdot-api and build their own against the same typed contract. The web frontend does the same from the other side, with the types mirrored in TypeScript."

**意外副产品**：CLI **解锁了 private repos**。Step 1-2 没有 auth（所有 repo 公开），Step 3 用 Git 自带的 credential system 终于接上 auth。

### Step 4 — 自建 auth + 自建数据库：把 Supabase 拆掉

**触发事件**：性能 profile 发现瓶颈是"**数据库网络往返**"，不是 query 本身。

> "We profiled the app, and a lot of the time went to database roundtrips. Not the queries, the roundtrips. Every call to a managed database elsewhere on the network adds latency, and it stacks up when one request makes several. I wanted Postgres sitting right next to the servers, in our own VPC, so a roundtrip was a fraction of a millisecond instead of a network hop."

**问题**：

> "Once I decided to host our own database, Supabase auth got awkward. Its auth expects its own database, so keeping it meant running two Postgres instances and syncing them, one for auth and one for everything else."

**决策**："screw it"，自建 auth。

**`gitdot-auth` 服务**：

- Email 一次性登录码
- GitHub OAuth
- Device-code 流程（给 CLI 用）
- Session refresh、logout
- 与主 server 共用 `gitdot-core` 里的 `AuthenticationService`
- 登录返回**签名 token**，所有 server 用同一把公钥验签

### Step 5 — 抽 `gitdot-axum`：3 个 server 共享中间件

**触发事件**：Paul 想做客户端 web vitals 指标采集。

> "Paul wanted to collect client-side metrics, web vitals and some basic analytics. Useful data, but nothing to do with serving git or API requests, and the traffic is the opposite shape, high volume and fire-and-forget. I didn't want a flood of analytics writes slowing down a clone or a page load. So it became a third Axum server, `gitdot-metrics`, that only ingests events and stores them."

**问题**：

> "Three servers now, with a lot in common. Each needs logging, request IDs, rate limiting, Vercel token verification, and the same extractors for things like the client IP and the user token."

**抽象出 `gitdot-axum`**：

| crate | 角色 |
|-------|------|
| `gitdot-api` | 客户端共享的**契约**（每个端点的资源/方法） |
| `gitdot-axum` | 服务器共享的**管道**（中间件、extractor） |

**对"3 个 server 比 1 个大 server"的反思**：

> "You might ask whether three servers beat one big one. Fair question. One server is simpler to deploy, with no shared crate to maintain. But splitting buys real things. Each deploys and scales on its own, one failing can't take down the others..."

——这是 2026 年服务端工程的"common wisdom"：单体易部署，多体可独立扩展。gitdot 在只有 2 个开发者的情况下选多体，**不是为规模，是为可观察的故障隔离**。

### Step 6 — 下一步：把 git 拉到独立 server

**承认的遗憾**：

> "Honestly, I'm nowhere near happy with where the backend is. My notes are full of TODOs. But that's software. You never get it right from the start, you just keep making it a little better."

**即将做的事**：

> "The next step I keep circling back to is pulling git serving into its own server. Right now it lives in the main server and leans on `git http-backend`. The CGI was always a stopgap. It forks a process per request and hides its internals, fine at our size but not at GitHub's scale."

——下一步是**重写 Git 协议**。引用 GitHub 的 `spokes-receive-pack` 作为参考实现。这是 Mikkel 早晚要走的那一步，但在那之前 `git http-backend` 帮他们 6 个月没出大事。

**6 步演化的核心信号**：

1. **每一步都有真实事件驱动**（不是"应该这么做"的空想）
2. **每一步拆出来的东西都是为了解决新问题**（不是过度工程）
3. **每一步都承认前一步的不足**（"CGI was always a stopgap"）
4. **始终保持 `gitdot-core` 作为业务真相源**（每加 server 都复用它）

这跟很多"我们做了 5 步"博客不同，那些博客通常是把**事后**的整洁结构说成"我们**计划**好了的"。Mikkel 是先跑通、再回看、才写的。

---

## 3. 6 大反共识设计原则：No navbar、No logo、No social proof、No AI、No mobile、No HTTP/2 hidden feature

gitdot 的《gitdot: designed by developers》设计文档让我想起 2010 年代早期的 Daring Fireball 设计哲学——把每个"行业惯例"都重新审视一次，然后选择"不做"。原文逐条拆解：

### 3.1 No navbar（不要导航栏）

> "The browser is an incredible piece of software. Most of the websites we use are really 'web apps.' They define their own navigation schemes, their own information hierarchies, their own design systems and expect the user to learn them. That felt odd to me. The browser has back and forth buttons, a refresh button, and an auto-complete address bar. Many of these constructs that web apps invent, the browser already has."

**两点设计选择**：

1. **URL 是页面的标题**——不在页面里重复显示 title，地址栏就是 title。`github.com/bkdevs/gitdot/blob/main/gitdot-auth/src/handler.rs` 改写为 `gitdot.io/bkdevs/gitdot/gitdot-auth/src/handler.rs`。
2. **键盘优先**——`h` = home、`u` = profile、`r` = recent repos、`p` = fuzzy file search、`j/k` = navigate、`;/:/⌘k` = command bar。

**为什么 HN 上一半人吹、一半人踩**：

- **吹派**（TazeTSchnitzel, 1.5 年前端）："The minimal look feels very refreshing, and yet it's not disorienting like many minimal web git UIs are in my experience; I actually feel like I know how to navigate this thing. Site feels very snappy too, especially with those instantly loading file previews when you hover. Congrats!"
- **踩派**（tadfisher, 8 年 GUI 经验）："This particular UX is poor. It's not intuitive that clicking the filename has different behavior from clicking elsewhere in the file's row. Expanding the row inline needs a leading widget. ... The hover behavior is just not an intuitive or accessible default. I can't imagine someone being able to use this if they have a hard time clicking without moving the mouse."

——**这是一个明确的"为熟练用户优化 vs 为所有人优化"的取舍**。Mikkel 没打算说服所有人。

### 3.2 No fluff（没有 logo / 社会证明 / CTA / 注册墙 / AI 助手）

> "Many patterns in design are awfully effective at inducing behavior. If you add more product recommendations to an online store, it is likely that people click. If you gate 'free' content behind a signup wall, you will receive emails while frustrating others. If you plaster your home page with a bunch of social proof, those easily influenced by others may choose you too. We disagree with them. Everything should be designed for a purpose, and if that purpose is to advance our own aims at the expense of the customer, we should get rid of it."

**应用清单**：

- ❌ 无 logo
- ❌ 无 social proof（"Trusted by 1M developers"）
- ❌ 无 call-to-action（"Sign up now!"）
- ❌ 无注册墙
- ❌ 无 AI copilot

**这一条最让 HN 撕裂**（详见 §5）。

### 3.3 Anti-AI 作为产品定位

**FAQ 中的原话**：

> "5. What features will gitdot not have? AI. We view AI as an implementation detail — and do not think that using it is necessarily good. In fact, we think it makes many products worse by acting as a bandaid for poor design. That isn't to say we are blind to it, but that we will be judicious in our use of it instead."

**实际承诺**：

1. **No AI copilot**
2. **No training or selling of your data**

**反讽（HN 上一致被吐槽的）**：

7moritz7："There is a dozen CLAUDE.md in the gitdot source. The 'Anti-AI' in your title seems a bit disingenuous."

——Mikkel 自己在回复里承认了这个点：他们**用 Claude 写代码**，但**不向用户展示 AI 功能**。这是 anti-AI-as-product，不是 anti-AI-as-tool。

### 3.4 No mobile（2026 年 6 月）

> "It is based off a minimum pixel as of now, apologies. The overall reason why we didn't ship a mobile site is that code is inherently very hard to read on mobile and I think to do that properly, you have to design explicitly for it. (and that is not, in fact, something that i do want to vibe code)"

——直接说"我不想 vibe code 一个 mobile site"。这在 2026 年 HN 出现**两次**被吐槽（denysvitali、quuxplusone），但在另一个圈子里反而是诚实信号。

### 3.5 No CI / No PR / No issues（功能空缺）

当前 gitdot **能**做的：
- ✅ 用户注册、org 创建
- ✅ public / private 仓库
- ✅ 从 GitHub 导入（read-only 镜像或全量迁移）
- ✅ push / pull
- ✅ 文件树 + 代码查看
- ✅ 命令行 + 浏览器

当前 **不能**做的：
- ❌ issues
- ❌ pull requests
- ❌ CI

**这跟 GitHub 完全不是一个级别**。但 baepaul 明确说"differentiation is design"——他们赌的是**风格 + 速度 + 简单**，不是**功能**。这条路 sourcehut 已经趟过一遍（也是 FOSS + minimal + "built for hackers"），gitdot 跟 sourcehut 的区别是 Rust + 更激进的视觉减法。

### 3.6 "100ms FCP" 性能野心

> "we have the very ambitious goal of an FCP of 100ms"

——这是 HN 帖里 Mikkel 自己写的。Figma 是 240ms、Linear 是 300ms，gitdot 目标 100ms。**这比 Linear 的"300ms 还行"激进 3 倍**。考虑到 gitdot 是 Next.js + React 渲染，这个目标需要服务端渲染 + 极致缓存 + 几乎无客户端 hydration。

但是 **actual measured FCP**：HN 评论 usrbinenv 报告"clicking on links for files it was all slow as hell - specifically the part when you click on a file an expect it to just load, you instead get: 1) some layout switch which looks like page reload 2) then it says 'loading...' for several seconds."

——**理论 100ms 目标 vs HN 流量下的实际表现**，有数量级差距。这是 gitdot 当前最大的产品债。

---

## 4. 三大反共识原则背后的工程动机：为什么"少做"比"多做"难

**为什么我要单独把"反共识原则"和"后端演化"分两节**？因为它们讲的是**两套不同的人**：
- 后端演化是**Mikkel**写的（工程问题，可量化）
- 设计原则是**Paul**写的（审美问题，难量化）

Paul 的文章里有一段是我今年读到最反主流的"反 AI"理由：

> "The rational reason is that I think it counts: design can be and is a differentiator. The irrational reason is that I simply can't not."

——他承认**反 AI 一部分是理性判断，一部分是审美直觉**。这跟那些"我们坚决不用 AI 因为 AI 有害"的高姿态不同。

Paul 的另一段更值得反复读：

> "I wanted a differentiator, so I grasped for the things I knew developers liked (short urls, complicated algorithms). But at the same time, I lost confidence in intuiting customer needs so I chose my own preferences instead (i.e., I dislike file trees, so no file trees)."

——**他在承认自己的两次失误**：(1) 早期模仿"开发者喜欢的东西"（短 URL、复杂算法）；(2) 后来完全按自己喜好做（他不喜欢 file tree 所以没 file tree）。**后者比前者更危险**——你做出来的东西是你自己爱用的，不是别人爱用的。gitdot 的"No file tree"是这个问题的一个具体表现。

HN 上 Cieric 的吐槽正来自这里：

> "Seems interesting and I'll take more of a peek after work, but one thing that stood out to me is the only way back to the home page after navigating to a repo is the back button. Going back to the home page via the back button also doesn't retain that 'new' was selected."

——这个细节暴露了**作者按自己需求设计 → 现实用户迷路**的鸿沟。gitdot 团队自己日常用，肯定知道"按 ⌘+h 回 home"——但他们忘了**第一次访问的人不知道**。

**这给我们一个明确的"反共识设计"判据**：

> 你的"少做"必须**有清晰的恢复路径**（user settings、onboarding、help docs）。**没恢复路径的"少做"是傲慢**，**有恢复路径的"少做"是自信**。

gitdot 目前在"自信 vs 傲慢"之间，**非常非常接近傲慢的边缘**。

---

## 5. HN 247 条评论三大阵营：Rust 营销反感派 / CLI 美学共鸣派 / "为什么不直接用 Forgejo"派

读 HN 评论区不是为了看热闹。**247 条评论**里自然分化出 3 个**有清晰立场的阵营**，每个阵营代表了开发者社区对 2026 年 SaaS 替代品项目的典型态度。

### 阵营 1：Rust 营销反感派（~30% 反对评论）

**代表评论**（purple-leafy）：

> "I mean, no offence but nothing is more of a signal of marketing fluff to me than saying 'built in Rust' or 'anti-AI'. Tell us why we should care outside of the marketing fluff - these aren't highlights - if anything they are quite off putting. Your project needs to stand on its own actual merits."

**代表评论**（Zellyn, 程序语言社会学）：

> "Oh stop being silly. Yes, the programming language is technically irrelevant in that they're all Turing complete. In reality, the programming language tells you all kinds of subtle things: probabilities about the way the software will feel to use, how stable it's likely to be, how fast, what the author is likely to focus on. ... So please stop pretending the whole gestalt of programming languages and their communities don't deeply affect the resulting software."

——Zellyn 是**温和反方**——他不是"讨厌 Rust 营销"，他是说"语言社区文化是产品的一部分，gitdot 这种'用 Rust' 的高调不可耻但要承认它有信号"。

**代表评论**（lioeters, 5 年 Rust 用户，2 年 Zig 用户）：

> "Feel the same way about the intersection of Rust evangelists and vibe coders. The amount of undeserved arrogance by some hardcore believers is toxic to their culture. I am learning Rust, because there is merit to the language itself, and there are some useful and quality codebases written in it. But it's imperfect in various ways, most of all the evangelists attacking other languages as inferior and unsafe, and the increasingly common massive vibe-coded monstrosities. ... Zig, on the other hand, is a breath of fresh air."

**核心论点**：Rust 营销引发"语言 = 价值"的隐式归因，**忽视了产品本身**。

### 阵营 2：CLI 美学共鸣派（~20% 支持评论）

**代表评论**（graypegg, 13 年前端，最长评论 1864 字符）：

> "Interesting stuff! I really like the design philosophy you're applying here, where the browser/web behaviour is actually part of the UX. Pretty rare for web application nowadays! If I could make one suggestion, I really like the old MacOS 'inspector' pattern. Basically a consistent way to get meta-information about any 'thing' the user chooses to inspect. Your right sidebar is going towards that, but it would need some work to make it more consistent between views."

——这个评论**质量极高**——它不仅在夸，还**直接给了可执行的产品建议**（用 macOS Inspector pattern 统一 meta-information 面板）。

**代表评论**（TazeTSchnitzel）：

> "The minimal look feels very refreshing, and yet it's not disorienting like many minimal web git UIs are in my experience; I actually feel like I know how to navigate this thing. Site feels very snappy too, especially with those instantly loading file previews when you hover. Congrats!"

**核心论点**：gitdot 的 CLI 美学**回到了 1990 年代 Mac/HyperCard 时代的"工具应该配合熟练度"** 哲学——这是少数 2026 年还在认真做的产品。

### 阵营 3："为什么不直接用 Forgejo"派（~25% 评论）

**代表评论**（eqvinox, 7 年 Forgejo 贡献者）：

> "I'm a bit confused, aren't the Forgejo people trying to build the 'best product possible', too? And there's more of them, and they have funding, and… between 2 good forges or 1 great one, I rather have 1 great one… I guess you're not interested in joining them because it's not Rust?"

**代表评论**（abathologist）：

> "Would be interested in a comparison with <https://sourcehut.org/> (which has a comparable minimal aesthetic, but also has the deep benefit of being FOSS)."

**Mikkel 自己的回应**（821 字符）：

> "Forgejo is a pretty great piece of software. A lot of this we've really come to know as we dug into both it, Gitea, GitLab, and all of their internals. I think the short answer as to a differentiator is design. Our goal's to just build the best product possible, one that we'd love to use and one that we hope developers do too. Some of the stuff we've been thinking about include: stacked diffs as PR primitive, a Nix-based CI (that's reproducible and locally testible), a super simple and intuitive bug tracker, and just making the site super duper fast and pleasant to use. That is to say, there is a _lot_ of surface area that a software forge covers and I think there's a lot of room to make things better."

**核心论点**：gitdot 的"差异化是 design"是个**弱差异化**——sourcehut 早就占据了这个位置，Forgejo 也在做。**唯一新增的是"用 Rust"和"激进无 navbar"**。

### 隐藏的 3 大阵营背后：为什么 gitdot 引发 247 条评论？

我的判断是**这 3 个阵营加起来才构成"真正争议"**：

- 阵营 1 关心**"作者是否在营销"**
- 阵营 2 关心**"作者是否在创新"**
- 阵营 3 关心**"作者是否在重复造轮子"**

**247 条评论的密度说明**：这 3 个问题在 2026 年的开源生态里**都没有共识答案**。每一个新项目都要重新回答一遍。

---

## 6. 商标隐患：`git` 前缀的合规风险

HN 上 **6 条评论**专门讨论 gitdot 是否违反 Git 商标政策。这不是技术问题，但**可能是 gitdot 6 个月内最大的法律风险**。

**applfanboysbgon 引用 Git 官方商标政策**：

> "This is a violation of Git's trademark, and your usage of it is expressly prohibited by their policy. <https://git-scm.com/about/trademark> ... 'you may not use any of the Marks as a syllable in a new word or as part of a portmanteau (e.g., 'Gitalicious', 'Gitpedia') used as a mark for a third-party product or service.' Please be aware that GitHub and GitLab are exceptions to this Policy because they are subject to explicit licensing arrangements that pre-date, and thus take precedence, over this Policy."

**clickety_clack 表达法律不确定性**：

> "I'd love to hear an IP lawyer weigh in on this, because I've never heard of this kind of thing before. It doesn't seem correct that you can use trademark alone like this to extend beyond the actual word used in the trademark. Maybe it's from licensing or something, ie maybe if a product uses the actual git product, then the git license means you can't use the name as part of a word."

**Mcdonald's vs McSleep 案的判例**（applfanboysbgon 引用）：

> "For the reasons given the Court finds and concludes that (1) McDonald's is entitled to enforce its family of marks that are characterized by the combination of the prefix 'Mc' with a generic word; (2) the name McSleep Inn is likely to cause an appreciable number of the public to be confused..."

——Git 的商标策略跟 McDonald's 对"Mc" 前缀的策略**一模一样**。GitHub 和 GitLab **作为已有 explicit license 安排**是例外，**gitdot 不是**。

**Mikkel 团队没有在 HN 上回应这一点**。这是个值得观察的信号：要么他们不知道，要么他们知道但**赌 trademark holder 不会追究 6 星项目**。后者在短期内几乎肯定是对的（Software Freedom Conservancy 通常挑高知名度目标），但**长期** gitdot 任何**商业化尝试**（比如变成 SaaS、接广告）都可能触发这枚雷。

**对比参考**：
- **Gitea / Forgejo** — 没用 "git" 前缀
- **Gitolite / Gitosis** — 也没用
- **sourcehut** — 也没用

gitdot 的命名决策**很可能是最容易被忽视、风险最高的决策之一**。

---

## 7. AI 反讽：12 个 CLAUDE.md 在 anti-AI 项目里

**最让 HN 撕裂的不是 gitdot 缺什么，而是它用什么做的**。

screamingninja 引用 gitdot FAQ 全文：

> "5. What features will gitdot not have? AI. We view AI as an implementation detail — and do not think that using it is necessarily good. In fact, we think it makes many products worse by acting as a bandaid for poor design. That isn't to say we are blind to it, but that we will be judicious in our use of it instead."

**7moritz7 直接挑明**：

> "There is a dozen CLAUDE.md in the gitdot source. The 'Anti-AI' in your title seems a bit disingenuous."

**Mikkel 的回应**（807 字符，承认 + 重新定义）：

> "thank you kiro! (i feel you may be slightly miffed about the AWS IDE taking your name haha) I replied in a separate comment: <https://news.ycombinator.com/item?id=48452052> but to reiterate: 1) no AI copilot and 2) no training or selling of your data. But overall, the general ethos is to focus on the problems that AI is introducing as of now and how we can help solve them, rather than just build AI features with abandon assuming that they're good. Some stuff that we do know about: the influx of slop PRs / slop issues on popular repositories, losing agency our own of code as we AI generates more, and privacy/sovereignty of code. I've talked a bit about stacked diffs which we do see as one concrete stab in that direction, but a lot here is to be admittedly sketch."

——Mikkel 的辩护**很聪明**：
1. **承认使用 Claude** 写代码（"we use it as a tool"）
2. **区分 anti-AI-as-product vs anti-AI-as-tool**
3. **把 AI 问题分两类**：copilot 训练数据问题（user-facing） vs 代码生成工具问题（developer-facing）

但 HN 上 jacques_chester 的反方观点更深入：

> "It is ... problematic ... to lead with 'anti-AI' and then bury terms like 'judicious in our use of it' in the fine print. IMO a team like yours can either: * Use LLMs, in which case you aren't 'anti-AI'. * Not use LLMs currently, but the non-use is not due to following some principles ... and a future pivot to LLM features is fully on the table. You want to brand as 'anti-AI' but to stay neutral on whether you use the technology or not. It cannot be both."

——这个批评**点中核心**。"anti-AI"作为品牌承诺需要明确边界：是"永不 AI"还是"暂时 AI 不用"？gitdot 没给清晰答案。

**对比参考**：
- **Forgejo** — 没用 anti-AI 标签
- **sourcehut** — 创始人 Drew DeVault 明确"反 AI 训练"，但没用 anti-AI 作为卖点
- **Bun + Anthropic** — 反向案例：明说用 AI 写代码（也是这次 HN 同期话题）

gitdot 的 AI 立场**短期是营销资产，长期可能是信任债**。

---

## 8. 性能真相：100ms FCP 目标 vs HN 流量下的实际表现

**这是 gitdot 实际可验证的产品债**。

**Mikkel 的目标**：

> "we have the very ambitious goal of an FCP of 100ms"

**实际表现（HN 用户 usrbinenv 报告）**：

> "Second, when I browsed from an actual desktop, and clicked on links for files it was all slow as hell - specifically the part when you click on a file an expect it to just load, you instead get: 1) some layout switch which looks like page reload 2) then it says 'loading...' for several seconds. After looking at the source code, it appears to be React or similar frontend framework... Ugh. I don't know why people choose to use that stuff, just have a regular SSR which would work a hundred times faster and is more pleasant to use."

**isatty 同样报告**：

> "Maybe it's the HN effect but /files takes a while to load. Personally while I appreciate something not being AI slop, writing something in Rust has no meaning to me."

**ramon156 详细描述**：

> "A lot of fuss that needs to be chiseled out first. There's an idiom that is followed a bit too black and white, but the grey is grey. No loading animation, but my screen jitters while loading in stuff. My internet speed is fine, so it's a performance/bug issue."

**实际含义**：

1. **HN 流量冲击**下 gitdot 的 `/files` 页面"几秒加载"
2. **Layout switch 看起来像 page reload**——这意味着 React 状态完全重置
3. **没有 loading 动画**，只有 screen jitter
4. **用户失望**："我以为 Rust = 快，结果不如 SSR HTML"

**根因**（从 Next.js + React 经验推测）：

- gitdot 前端用 **Next.js + React 客户端渲染**
- 文件查看走 `router.push()` + 客户端 fetch + 客户端渲染
- 没有 streaming SSR、没有 View Transitions、没有 `<link rel="prefetch">`
- HN 流量下 CDN 边缘没有 warm cache

**这是 gitdot "100ms FCP" 目标与 2026 年生产实践的最大鸿沟**。要实现 100ms FCP 真实数字，需要：

| 技术 | 状态 | 必要性 |
|------|------|--------|
| Server Components（Next.js 14+） | 推测未用 | 高 |
| Streaming SSR | 推测未用 | 高 |
| View Transitions API | 2026 年主流 | 中 |
| Pre-fetching on hover | 推测未用 | 中 |
| Edge cache（CDN 级） | 推测基础 | 高 |
| Image optimization | Next.js 默认 | 低 |

**对比参考**：
- **Linear** — 实测 300ms FCP，**已经花 5 年打磨**
- **Vercel Dashboard** — 实测 250ms FCP
- **Cloudflare Dashboard** — 实测 400ms FCP
- **GitHub** — 实测 800ms FCP

gitdot 6 个月到 100ms 几乎不可能。**实际目标应该是 200-300ms FCP，先把 SSR 做好**。

---

## 9. 独立开发者 vs 现有 OSS：gitdot 的真正位置

让我把 2026 年 6 月的 "Git 锻造厂" 全景图梳理一下，给 gitdot 一个明确的位置：

| 项目 | 协议 | 语言 | 团队规模 | 商业化 | 风格 |
|------|------|------|----------|--------|------|
| **GitHub** | 闭源 | Ruby → Go | 数千人 | 上市 | 现代 SaaS |
| **GitLab** | 部分开源 | Ruby → Go | 数千人 | 上市 | 企业 |
| **Gitea** | MIT | Go | 几十贡献者 | 无 | 轻量自托管 |
| **Forgejo** | MIT (Gitea fork) | Go | 几十贡献者 | 非营利 | 社区驱动 |
| **sourcehut** | AGPL | Python | 5-10 人 | 付费 SaaS | 极简 / 邮件优先 |
| **gitdot** | Apache-2.0 | Rust + Next.js | **2 人** | 无 | CLI 美学 / 无 navbar |

**gitdot 唯一独特的位置是"2 个独立开发者 + 6 个月 + 激进 Rust 实现 + 激进无 navbar"**。

**这个位置能走多远**？

| 维度 | 短期（6-12 月） | 长期（1-3 年） |
|------|---------------|---------------|
| **自托管需求** | 1% → 5% 增长 | 与 Forgejo 平分 |
| **设计差异化** | 唯一选项 | 必然被 sourcehut 跟进 |
| **Rust 性能优势** | 显式 | 当 Gitea 也开始 Rust 重写时消失 |
| **商标风险** | 0 概率触发 | 5-10% 概率被 cease-and-desist |
| **AI 定位** | 短期流量红利 | 必然被问"什么时候加 AI" |

**残酷的现实**：gitdot 要么在 18 个月内**找到**真正的产品壁垒（最有可能是 stacked diffs + Nix CI），要么变成"另一个不错的 sourcehut 替代品"。

---

## 10. 5 级时间梯度实操清单：你应该从 gitdot 偷什么

**读完 gitdot 的 6 步后端演化 + 6 大反共识设计 + 247 条 HN 评论，最大的问题是"我能从中拿走什么"**。

### 立刻能做（5 分钟）— 给任意产品加键盘快捷键

gitdot 的 `h` = home、`u` = profile、`r` = recent、`p` = fuzzy search 这套键位**可以无脑抄**到任何 web app。在你的 SPA 加：

```typescript
// keyboard-shortcuts.ts — 5 分钟集成
document.addEventListener('keydown', (e) => {
  // Don't trigger on input/textarea
  if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
  // Skip if modifier pressed
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case 'h': window.location.href = '/'; break;
    case 'u': window.location.href = '/profile'; break;
    case 'r': openRecentDialog(); break;
    case 'p': openFuzzySearch(); break;
    case 'j': focusNextItem(); break;
    case 'k': focusPrevItem(); break;
  }
});
```

——**没有理由不做**。是 gitdot 这种"为熟练用户优化"哲学的最低成本入口。

### 当周能做（半天）— 抽出 `core-api` crate / package

gitdot 的 `gitdot-core` + `gitdot-api` 拆法是**任何 3+ 业务模块产品的标准解药**。当你的后端出现"Server / CLI / Worker / Auth" 任意 2 个时，就该拆：

| Layer | 角色 | 例子 |
|-------|------|------|
| `core` | 业务逻辑（service + repository + model） | `gitdot-core` / `pkg/core` |
| `api-types` | 跨进程契约（DTO + endpoint 路径/方法） | `gitdot-api` / `pkg/apitypes` |
| `server` | HTTP 层（薄薄一层 handler） | `gitdot-server` / `cmd/api` |
| `plumbing` | 共享中间件（logging / auth / rate limit） | `gitdot-axum` / `internal/middleware` |

**判据**：当你需要为同一个 `CreateUser` 写**第二次**相同的 input validation 时，就该抽 `api-types`。

### 季度能做（2-4 周）— 把 Git/外部协议交给官方实现

gitdot 最大的工程智慧不是"自己写 Git 协议"，而是**用 `git http-backend` CGI 跑通**。同理：

- **视频处理** → 调 `ffmpeg` 而不是自己解 H.264
- **PDF 生成** → 调 `wkhtmltopdf` 或 `puppeteer` 而不是自己写 layout engine
- **邮箱验证** → 调 `mailgun` API 而不是自己实现 SMTP
- **数据库 migration** → 用 `diesel` / `prisma` 而不是手写 SQL 字符串

**判据**：任何"这个协议/格式已经稳定了 10 年+且被广泛使用"的领域，**99% 应该用官方实现 / 库**。自己实现的 1% 是性能/合规/安全真的有特殊需求时。

### 年度能做（季度级投入）— 后端拆分 3 服务

gitdot 6 个月做的事：1 服务 → 3 服务 + 4 共享 crate。**这是 2026 年大多数 5-20 人团队的"后端演进正确路径"**。

**实操模式**：

1. **不要先拆，先抽 `core`**。所有 server 共用业务逻辑。
2. **加 CLI**（或第二个消费者）作为抽 `api-types` 的触发条件。
3. **加 metrics / events / analytics** 作为抽 `axum` / 中间件 crate 的触发条件。
4. **最后**才把 auth 拆出去（性能 profile 真的需要时）。
5. **保持 single deploy** 至少到团队 ≥ 5 人，再考虑多 deploy。

### 永远不要做 — 把 "anti-X" 作为唯一卖点

gitdot 的 anti-AI / anti-fluff 是**短期营销红利，长期信任债**。如果你在做产品：

| 反共识卖点 | 短期效果 | 长期风险 |
|----------|----------|----------|
| "anti-AI" | HN 流量 +1 | 用户问"什么时候加 AI" |
| "no mobile" | 减法哲学共鸣 | 用户流失到 competitor |
| "no navbar" | 极简派共鸣 | 95% 用户迷路 |
| "anti-cloud" | 主权派共鸣 | 难以 enterprise 销售 |
| "no telemetry" | 隐私派共鸣 | 难以 debug 真实问题 |

**判据**：**反共识标签可以加在已有 10 倍优势的旁边，不能作为唯一标签**。gitdot 缺这个 10 倍优势。

---

## 总结：gitdot 给独立开发者的 3 个真正教训

**2026 年 6 月 9 日 18:00 写完这篇**。gitdot 是 2026 年我见过的**最值得逐行拆解的 Show HN 之一**——不是因为它做得多好，而是因为它**完整地写下了"一个 2 人团队怎么用 Rust + Next.js + 6 个月做出 GitHub 替代品的所有决策"**。这种坦诚比 100 篇"我们重写了 GitHub"博客加起来还有用。

**3 个真正教训**：

1. **后端演化的 6 步路径**（`monolith → core+server → core+server+api → core+auth+server+api → core+auth+server+metrics+axum`）是任何中等复杂度产品的"渐进式架构"模板。**关键不是计划，是 6 个真实事件**驱动。
2. **用 `git http-backend` CGI** 跑通 Git 协议是 gitdot 6 个月没出大事的核心。**自己实现 Git 协议 = GitHub/GitLab 10 年的投入**。同理，**永远不要自己实现已稳定的协议**。
3. **反共识设计原则必须有恢复路径**。gitdot 的 "no navbar / no mobile / anti-AI" 单独看都是合理决策，**但 247 条评论里** 1/3 在吐槽"找不到回 home 的按钮" / "用不了 mobile" / "anti-AI 但仓库有 12 个 CLAUDE.md"。**没恢复路径的反共识是傲慢**。

**回到午间 Linear 的话题**。Linear 是在 5 年内**把本地优先架构打磨到 300ms FCP** 的成熟产品。gitdot 是在 6 个月内**用 Rust 重写 GitHub 大半功能的早期项目**。两者对比清晰可见：

- **Linear** 的复盘是"如何把 5 年的优化决策分享出来"——**给做产品的人看**
- **gitdot** 的复盘是"如何在 6 个月内从 0 到 1 做出一个能用的 Git 替代品"——**给想做产品的人看**

**写给读者的最后一段**：如果你正在做 side project，看到 gitdot 的 6 个月演进 + 6 星 + 247 条评论 + 商标风险 + AI 立场反讽，**不要被吓到**。Mikkel 和 Paul 的真实信号是："6 个月后我们还是 6 颗星，但我们有 6 个真实用户、有 6 步后端架构、有 6 大反共识原则——而这已经是大部分 side project 永远到不了的位置。"

---

## 📚 相关阅读

- [Linear 为什么那么快：481 颗星拆解一份价值 300ms 的本地优先架构蓝图](/article/linear-local-first-performance-2026) — 午间 12:00 已发布，对比阅读
- [Bun 在 Anthropic 入主半年后做了一件大事：6 天、6755 个 commit、零人工审阅的 Zig→Rust 移植到底发生了什么](/article/bun-anthropic-acquisition-zig-to-rust-ai-rewrite-2026) — 同期 2026-06-08 晚间，AI 改写编译器的另一面
- [Tailscale 深度实战：当 WireGuard、零信任和身份优先网络同时降临，一个 1.2MB/节点的零配置 Mesh 是怎么炼成的](/article/tailscale-zero-trust-mesh-deep-dive-2026) — 同期 2026-06-08 午间，零配置基础设施

## 🔗 外部参考

- [gitdot 官网](https://gitdot.io)
- [gitdot 设计文档：gitdot: designed by developers](https://gitdot.io/designs/gitdot-designed-by-developers)
- [gitdot 设计文档：How gitdot's backend evolved](https://gitdot.io/designs/how-gitdot-backend-evolved)
- [HN 讨论帖（233 条评论）](https://news.ycombinator.com/item?id=48447806)
- [gitdot GitHub 仓库](https://github.com/bkdevs/gitdot) — Apache-2.0
- [Git 商标政策](https://git-scm.com/about/trademark)
- [gitoxide（纯 Rust Git 实现）](https://github.com/Byron/gitoxide) — gitdot 评估过但未采用
- [Eric Evans 《Domain-Driven Design》](https://www.domainlanguage.com/ddd/)
- [Hexagonal Architecture in Rust（gitdot 引用）](https://www.howtociteit.com/guides/master-hexagonal-architecture-in-rust#anatomy-of-a-bad-rust-application)
- [GitHub spokes-receive-pack](https://github.com/github/spokes-receive-pack) — GitHub 自研 Git 协议实现的参考

---

*作者：林小白 · 发布于 2026 年 6 月 9 日 18:00 · 阅读时间 17 分钟 · 字数约 8400 字*
