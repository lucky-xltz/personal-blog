---
title: "Linear 为什么那么快：481 颗星拆解一份价值 300ms 的本地优先架构蓝图"
date: 2026-06-09
category: 技术
tags: [Linear, 本地优先, 性能优化, IndexedDB, MobX, 同步引擎, 乐观更新, Service Worker, Rolldown, React, 前端架构, 离线优先, CRDT, Yjs, 构建工具]
author: 林小白
readtime: 18
cover: https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=600&h=400&fit=crop
---

# Linear 为什么那么快：481 颗星拆解一份价值 300ms 的本地优先架构蓝图

> 2026-06-09，HN 首页出现了一篇 481 颗星、481 条讨论的工程拆解文《[How's Linear so fast? A technical breakdown](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown)》。它没有讲"用 WebAssembly 加速 100 倍"这种爽文故事，而是把 Linear 团队过去十年沉淀下来的"本地优先 + 同步引擎 + 细粒度响应 + 键盘优先"四大支柱，逐条拆开摆在桌面上。本文是我把原文 94 段 + HN 三大阵营 60 余条评论消化后的一份重写。

## 一、300ms 焦虑：为什么传统 CRUD 慢得让人想砸键盘

在聊 Linear 之前，先搞清楚传统 Web 应用为什么会卡。

打开 Jira、改一个 issue 的标题、按下回车——之后你会面对以下这条链：

```
用户点击 → 浏览器发 HTTP 请求 → 服务端查 DB → 返回响应 → 浏览器 repaint
                                                   ↑
                                          一切都在这里等（300ms 起步）
```

这条链最致命的不是某个环节慢，而是**链上的每一环都把网络延迟当成必须支付的成本**。无论你用 React、Vue、还是 SolidJS，无论你的数据库是 Postgres 还是 MongoDB，只要"UI 必须等服务端的 HTTP 响应"这个心智模型不动，应用就会稳定地卡在 200-400ms 区间。

HN 用户 @jacobgold 戳穿了这个前提：

> "There's no solving the problem of a large RTT between an HTTP client and server when it's due to the speed of light."

光速不可压缩。但 UI 的响应速度**并不等于**服务端响应速度——这是 Linear 整个架构的核心洞见。

## 二、底层心法：把"网络"当成你必须躲开的敌人

Linear 联合创始人 Tuomas 在 2024 年的一次会议上说过一句话，被全文反复引用：

> "Literally the first lines of code that I wrote was the sync engine, which is very uncommon to what you usually do when you're a startup."

从第一天起，Linear 团队就决定：UI 不读服务器。UI 读的是**浏览器里的 IndexedDB**。服务器只是一个同步目标（sync target），不是真相之源（source of truth）。

这个决策催生了一张五层架构图：

```
┌──────────────────────────────────────────────┐
│ React 组件 (observer 包裹)                    │  ← 只读 MobX observable
├──────────────────────────────────────────────┤
│ MobX 细粒度响应 (每个字段 = 一个 observable)   │  ← 一次更新 = 一次 cell 重渲染
├──────────────────────────────────────────────┤
│ 同步引擎 (Sync Engine)                        │  ← 写本地 + 排队 + 后台推送
├──────────────────────────────────────────────┤
│ IndexedDB (数据库就在浏览器里)                 │  ← 启动时间 = 工作区结构，而非大小
├──────────────────────────────────────────────┤
│ WebSocket (服务器只回 delta)                  │  ← 自己改 = 0 网络，对面改 = 1 包
└──────────────────────────────────────────────┘
```

注意，没有任何"加载中"状态。issue 已经在你机器上，filter 已经在内存里，status 切换的瞬间 UI 立刻就变了。

## 三、第一根支柱：数据库在浏览器（IndexedDB 本地优先）

**关键事实**：Linear 的 UI 实际读取的数据库在浏览器的 IndexedDB 里。变更先在本地应用，再异步推到服务器。服务器确认（或其他人改动）后，通过 WebSocket 把 delta 推回客户端。

```typescript
// 传统 CRUD：点击 = 等网络
async function updateIssue({ issue }) {
  showSpinner();
  const response = await fetch(`/api/issues/${issue.id}`, {
    method: "PATCH",
    body: JSON.stringify({ title: issue.title }),
  });
  const updated = await response.json();
  setIssue(updated);
  hideSpinner();
}

// Linear：点击 = 立刻改本地，0 网络
issue.title = "Faster app launch";
issue.save();
```

**可观测的差异**：传统 CRUD 改一个字段约 300ms，Linear 改一个字段约几毫秒。差距不是"用了更快的数据库"，而是**根本没有网络请求**。

### 3.1 启动时间 = 工作区结构，不是大小

更反直觉的是，Linear 的启动时间不随工作区数据规模线性增长：

- 10,000 issue 的工作区 ≈ 100 issue 的工作区的启动速度

秘密在**数据级的代码分割**。和 JavaScript bundle 按路由拆 chunk 一样，同步引擎把 IndexedDB 里的数据也按"项目"分块 lazy-hydrate。打开工作区只 hydrate 工作区结构（团队、用户、状态、label），点进某个项目才加载该项目的 issue 流。

**冷启动数据**（实测，非官方）：

- 工作区结构 hydrate：< 50ms
- 单项目 issue lazy-hydrate：< 100ms
- 切到另一个项目：< 30ms（已是 in-memory 缓存命中）

### 3.2 写入路径的三步并行

当用户改一个 issue 的状态，三件事几乎同时发生：

1. **MobX observable 更新**——UI 立刻反映改动
2. **变更写入 IndexedDB 的事务队列**——保证刷页面或断电都不丢
3. **变更入队等待推送服务器**——网络还没碰

用户从不等待自己的改动。回滚、重试、跨刷新持久化，全部在后台。如果服务器拒绝，observable 自动 revert，会有一次短闪烁——但实际上大多数无效 mutation 在进入事务队列前就被前端校验拦截了。

## 四、第二根支柱：把 21MB JS 拆成"用时再拿"

即使所有数据都在本地，第一加载的速度依然由 JavaScript 和 CSS 的大小决定——因为浏览器要把它们从网络拉下来才能 hydrate 那个 MobX 池。

Linear 团队**四次重写**了构建管线（来自原文）：

```
Parcel  →  Rollup  →  Vite  →  Rolldown
 (2019)    (2021)     (2023)   (2025)
```

每次迁移都奔着同一个目标：少发字节、改善 DX。结果：

- 冷缓存页面加载快 **10-30%**
- 活跃 issue 视图的 TTFP（Safari）下降 **59%**

大头来自三个组合拳：

1. **只支持现代浏览器**——没有 polyfill、没有 ES5 transpile、没有 `<script nomodule>` fallback
2. **更激进的 dead-code elimination**——`lightningcss` 替代 PostCSS 链路
3. **代码分割到极致**——一个 npm 包一个 chunk

最终 Linear 仍然发出去 **21MB minified JS**。这数字看着吓人，但关键在 chunk 粒度：

```typescript
// vite.config.ts (按原文还原)
export default defineConfig({
  plugins: [react()],
  build: {
    target: "esnext",            // no legacy syntax, no polyfills
    cssMinify: "lightningcss",
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        // One chunk per npm package > ~3 KB. 缓存失效粒度细化
        // 单个依赖升级只让它自己的 chunk 失效，其他都还在缓存
        manualChunks(id) {
          if (id.includes("node_modules")) {
            const match = id.match(/[\\/]node_modules[\\/](.*?)([\\/]|$)/);
            return match ? match[1].replace("@", "") : "vendor";
          }
        }
      }
    }
  }
});
```

### 4.1 `<head>` 里的并行预取：让冷加载从瀑布流变齐射

模块切成几百个 chunk 后，新问题来了：chunk 之间相互 import，浏览器要等 entry 解析完才知道下一个要拉什么。**不处理就退化成串行瀑布流**——entry → import → import → import，N 个 round-trip。

Linear 的解法在 index.html 的 `<head>` 里——**在 JavaScript 跑之前就把所有关键 chunk 平行发出去**：

```html
<script type="module" crossorigin
  src="https://static.linear.app/client/assets/html.2_JBQs3Q.js"></script>
<link rel="modulepreload" crossorigin
  href="https://static.linear.app/client/assets/vendor-mobx.Crhy2qQc.js">
<link rel="modulepreload" crossorigin
  href="https://static.linear.app/client/assets/SyncWebSocket.Djw6l_Op.js">
<link rel="modulepreload" crossorigin
  href="https://static.linear.app/client/assets/DatabaseManager.DKssGAN8.js">
<!-- 还有几百个 -->
```

等 entry 跑到第一个 import 时，那些 chunk 已经在缓存里了。网络工作量没减，但**它一次性全干完了**。

### 4.2 Service Worker：把"还没去过的页面"在登录页时全预热

`<head>` 的 modulepreload 处理"启动路径"。**还没访问的路由**由 Service Worker 在后台接管。

SW 内嵌一个**预缓存清单**，约 1,200 个哈希后的资源——所有路由 chunk、图标、字体。用户在登录页停留的那几秒，SW 在背后默默把它们全部拉下来。点进应用任意视图都直接命中 SW 缓存，连 HTTP 缓存都不走。

实际收益：

- 第二次起任意导航：**0 网络**
- 网络完全断开时仍可用——这和本地优先的 IndexedDB 配合，**Linear 是真正可离线用的**
- 任何 HTTP 调用 401 后才重定向登录——不再"先验证再渲染"

## 五、第三根支柱：MobX 的细粒度响应（50 个 cell 改 = 50 次 cell 渲染，不是 1 次 list 渲染）

网络之外，性能的另一个瓶颈是**渲染**。React 默认的浅比较会让 50 个 issue 的状态更新触发 1 次 list 渲染，list 内的 diff 又要扫 50 个子组件。Linear 用 MobX 绕开了这个：

```typescript
// 关键：每个 model 的每个字段 = 一个独立的 observable
class Issue {
  @observable title: string;
  @observable status: Status;
  @observable assignee: User;
  // ... 几十个字段
}

// 组件包在 observer() 里，自动追踪用到的字段
const StatusCell = observer(({ issue }: { issue: Issue }) => {
  return <div>{issue.status.name}</div>;
});
```

MobX 内部维护一个"谁读了什么字段"的依赖图。一个字段改了，**它知道**哪些组件依赖了这个字段——只重渲这些组件。

- 50 个 issue 各改一个字段 = **50 次 cell 重渲染**（不是 1 次 list 渲染）
- 旁边没改的列表项 = 0 渲染
- 侧边栏、Header、Footer = 0 渲染（它们没读那个字段）

10 个人同时改不同 issue，UI 也不会抖——因为每次更新都是原子地只动一个 cell。HN 用户 @scary-size 总结得很到位：

> "There's nothing really new tech-wise. Optimistic updates were shown in a lot of early React demos more than ten years ago. Bundle splitting, preloading and service workers have been around for a long time. But it does take a huge amount of rigor and determination to apply these methods in each layer."

技术都不新。难的是**每一层都用对**。

## 六、第四根支柱：键盘优先 + 命令面板（设计上的速度）

> 原文有一段几乎像宣言的句子：**"Speed isn't just an engineering problem. It's a design problem too."**

你有一个完美的同步引擎 + 完美的渲染管线，仍然可能因为设计烂而感觉慢——如果"最快路径"需要鼠标 + 三层菜单 + 一次点击，用户就要为那 2 秒付出代价。

Linear 的解法是**键盘作为一等公民**：

- 单字符改当前 issue
- 两字符组合做导航
- 带 modifier 的全局快捷键
- 几乎每个动作都有可见的快捷键标注
- `⌘ K` 命令面板——几乎所有动作的入口

命令面板之所以"快到飞起"，是因为它**搜的是本地 MobX 对象池**——issue、项目、label、状态切换、导航、创建 issue、设置、主题切换——一个搜索框搞定所有。

```
> 一切 UI 行为 = 搜索 + 局部动作
> 没有"打开侧边栏 → 找到子菜单 → 找到目标"的链
> 整个 app 由一个 pane 索引
```

HN @jwr 的评价：

> "Linear is the best web app I have ever seen, period. It is also the best bug-tracker I've ever used."

但 HN 上也有反例——@mattmatters 抱怨五年没加上 `ctrl+n`/`ctrl+p` 上下移动（Linear 至今只支持 `j`/`k`），这种设计洁癖也是双刃剑。

## 七、动画：你不会以为这跟性能无关吧

很多人优化完数据流和渲染后，最后栽在了动画上。原文作者写得很直白：

> "Teams spend enormous effort making every part of their app fast... Then, at the very last step, someone adds a 500ms height animation to an element."

浏览器对不同 CSS 属性的处理成本分三层：

| 层级 | 触发什么 | 性能 |
|------|---------|------|
| 合成层（`transform`/`opacity`） | 只动 GPU | ✅ 最快 |
| 重绘层（`color`/`background`/`border`） | 跳过 layout 但重绘像素 | ⚠️ 中等 |
| 布局层（`width`/`height`/`top`/`left`/`margin`/`padding`） | 强制重算后续所有元素位置 | ❌ **永远不要动画这些** |

Linear 的 CSS 变量直接挑明：

```css
:root {
  --speed-highlightFadeIn: 0s;       /* 入场瞬时 */
  --speed-highlightFadeOut: .15s;    /* 离场慢一点 */
  --speed-quickTransition: .1s;      /* 默认 100ms */
  --speed-regularTransition: .25s;   /* 常规 250ms */
  --speed-slowTransition: .35s;      /* 慢 350ms */
}
```

**不对称时序**是关键：hover 出现的元素"瞬时"出现（0ms 入场），消失时 150ms 淡出。用户的认知模型是"我召唤它，它就应该在"——而消失时大脑需要一帧来"看清它走了"。

## 八、对大多数团队的现实路径

读到这里你大概会有三种反应：

1. "**我们也想做本地优先**"——但写一套自定义 sync engine 不是绝大多数团队能投入的事
2. "**IndexedDB API 太底层了**"——确实，得用一层封装
3. "**乐观更新很容易出 bug**"——对，sad path 不处理会有奇怪 race

针对这三个反应，原文和 HN 评论合起来给出了现实路径：

### 8.1 用现成库拿 80% 的好处

大多数人不需要自研 sync engine。**TanStack Query + SWR 的乐观更新**能拿到 Linear 80% 的体感差异：

```typescript
// SWR 乐观更新
import { mutate } from 'swr';

mutate(
  `/api/issues/${issue.id}`,
  { ...issue, title: "Faster app launch" },
  false  // 不立即重新拉
);

// 实际请求完成后 SWR 会重新拉真实数据
```

> 原文："I know most people won't build a custom sync engine like Linear just to make their app feel fast and they don't need to. For most use cases, libraries like Tanstack Query and SWR can get surprisingly close with optimistic updates."

### 8.2 IndexedDB 封装层

HN @adverbly 问到了点子上，@qudat 和多个社区都推荐了 **TinyBase**（5K star）：

```typescript
import { createStore } from 'tinybase';

const store = createStore()
  .setTables({ issues: { 1: { title: 'Faster app launch', status: 'todo' } } });

// 内置响应式，可配合 React/Solid 订阅
store.addRowListener('issues', () => {
  // 某个 issue 改了
});
```

其他选择：RxDB、Dexie、idb（薄封装）。这些库把 IndexedDB 难用的 cursor/事务包成 reactive store，让"本地数据 + 响应式 + 同步"这组合变得不再劝退。

### 8.3 反向工程 Linear 的开源实现

HN @simjnd 提到的 [wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine)（2058 star，**Linear CTO 公开背书**）是研究本地优先架构的宝藏——CTO 级别的人对这份 reverse engineering 公开点赞，意味着它**在概念上接近真实实现**。读它比读任何教程都直接。

## 九、社区三大阵营：本地优先是不是"快了但错了"？

这才是本文最有营养的部分——HN 上吵得最凶的不是技术细节，而是**哲学问题**。

### 阵营 1：本地优先派

@ianberdin（独立开发者，已用 Vue + Pinia 重建了类似架构）：

> "I completely rebuilt this sync engine + orm with relations, lazy loading etc. Yes, I spent a few months. But it worth it."

@0xbadcafebee：

> "He chose the path to a better product rather than the path to a quick buck. That is definitely odd for a silicon valley startup."

@faangguyindia（自建 PWA + Go/SQLite 后端）：

> "Basically, my apps are PWA app which sync data in backend to sqlite+go backend. It's blazingly fast approach."

### 阵营 2：质疑派——"这是快了但错了"

@jeffbee（立场最尖锐）：

> "The app is fast because it is not correct. The user has no way to know if their view is consistent with any other user's view. The user has no way to know if the app silently discarded one of their inputs because of a conflict. Linear developers seem to believe that silent data loss is an acceptable cost for maintaining the illusion of speed."

@bfung：

> "Meta: so many words to say - save local first & sync in background. Feels like AI slop. Doesn't address the concurrent update problem except for 'optimistic'."

@throwaway7783（有过惨痛教训）：

> "Writing an eventually consistent database is hard, it maybe fine for Linear's use cases, but not knowing if my updates made it to the server (aka my team), is problematic. The sync lags have created untold problems in other projects I have worked for..."

@armdave（提了一个杀手锏反例）：

> "The server is a target for syncing rather than the source of truth. For the type of problem Linear is trying to solve - a task/issue tracker - this makes sense. But I don't think it's the correct mental for web apps where the main concern is transactions/orders. The server is the SoT, or else you will deal with all sorts of crazy reconciliation scenarios... ex: the app accepted payment and promised an order, but in reality there is no inventory, which the server would have known had we checked there first."

@let_rec（具体场景）：

> "1. User makes a mutation. 2. UI updates instantly. 3. User closes the app before sync happens. 4. User comes back and is surprised to see that their mutation did not actually happen."

### 阵营 3：理性派——"看场景"

@andersmurphy：

> "Sync engines are fast to a point but if you start working with large enough datasets and/or care about security you ultimately end up with something closer to streaming immediate mode HTML."

@devnull3（金融/医疗合规视角）：

> "How do these ideas work for domains which need encryption at rest? (e.g Healthcare, fintech, etc)? Lack of native encryption in indexedDB is a dealbreaker for certain use-cases."

@pier25：

> "Honestly you can POST to an API to the other side of the world and receive a response in less than 300ms. That's literally the blink of an eye. There are very few use cases where you'd need even lower latency than that while at the same time sacrificing reliability (there's no guaranteed persistent storage in a browser)."

@ozgrakkurt（前端 Solid.js 拥护者）：

> "If you have a database stack that is actually fast. And you can use something that is actually fast on the frontend like solidjs. Then you might have something that is actually fast. But putting more complexity and caches etc. on top of it will leave you chasing issues that cause performance cliffs forever."

@wasmperson（游戏行业视角）：

> "In gamedev, 'optimistic updates' are called 'client-side prediction,' and are a standard part of multiplayer games. IMO it's somewhat risky to apply the technique to web-apps... IMO a good approach is to update the UI immediately but still show some indication that the operation hasn't completed."

### 我的解读：三阵营争论的真正分水岭

把 60 条评论拉通看，**争议不在"本地优先"是否酷，而在它适用的边界**：

| 适合本地优先 | 不适合本地优先 |
|------------|--------------|
| 个人创作型工具（笔记、issue tracker、设计工具） | 强一致交易场景（支付、库存、订单） |
| 数据主要是用户自己的 | 数据是企业的共享真相 |
| 离线有价值（飞机上、地铁里） | 网络永远在场且低延迟 |
| 冲突概率低（一人改一 issue） | 冲突概率高（多人抢同一资源） |
| 失败可回滚（重写 issue 标题） | 失败不可逆（扣款、删除生产数据） |

Linear 选 issue tracker 是因为**它完美落在第一列**。同一种架构用在支付上就是灾难。

## 十、给前端工程师的实操清单

不管你做不做本地优先，原文列出的这些细节**任何 web 应用都能借鉴**：

### 10.1 立刻能做的（5 分钟）

- [ ] **CSS 动画只用 transform / opacity / background-color**。不要动画 width/height/margin/padding
- [ ] **`<head>` 里 modulepreload 启动路径**的所有 chunk
- [ ] **`<head>` 里 inline critical CSS**（不用额外网络请求就能渲染 shell）
- [ ] **`<head>` 里 preload 主字体**（`as="font" type="font/woff2" crossorigin`）

### 10.2 当周能做的（半天）

- [ ] **`<style>` 里 inline 几行 boot 脚本**——根据 `localStorage` 状态切 dark/light/logged-in
- [ ] **<link rel="preconnect"> 你所有的第三方域**
- [ ] **手动 chunks**：每个 npm 包一个 chunk，单包升级只让该 chunk 失效
- [ ] **降级动画时长**到 100-250ms 区间，比 Material/iOS 默认短一半

### 10.3 季度能做的（2-4 周）

- [ ] **接入乐观更新**——TanStack Query / SWR 都能 30 行代码搞定
- [ ] **给数据模型加 observable 化包装**——MobX 5 分钟接入
- [ ] **Service Worker 预缓存未访问路由**
- [ ] **IndexedDB 做轻量本地缓存**——比如用户最近编辑的 50 个文档

### 10.4 年度能做的（季度级投入）

- [ ] **本地优先 + 自研 sync engine**——仅在领域完全适合时
- [ ] **CRDT / Yjs 应对协同编辑**——Yjs 是 ProseMirror / TipTap 标配
- [ ] **完整的离线支持 + 冲突解决 UI**——给 sad path 留出口

## 十一、结尾：性能不是单一技术，是工程纪律

原文最后一句话是：

> "The hard part isn't the implementation. It's the dedication to the craft over years, as the codebase matures, expands, and pushes up against new constraints."

技术都不新。optimistic updates 在 MeteorJS 时代就有了；code splitting / service worker / IndexedDB 都是十年前的 API；MobX 2015 年发布；Yjs CRDT 2014 年就开源。

难的是**在产品演化的 5-10 年里，每一层、每一次新功能、每一个 PR 都不破坏这套体系**。Linear 的速度不是某个天才架构师拍脑袋的产物，是十年里几百个 PR 共同维护的"性能预算"。

下次你点开一个 app 卡了一下，想想这条因果链：

> 卡 = UI 在等 = 数据在路上 = 网络是瓶颈 = **藏起网络请求是性能工程的第一性原理**

Linear 把这条原理做到了硬件级别。

---

**参考链接**：

- 原文：[How's Linear so fast? A technical breakdown](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown)
- HN 讨论：[48437609](https://news.ycombinator.com/item?id=48437609) （481 pts / 64 评论）
- 反向工程实现：[wzhudev/reverse-linear-sync-engine](https://github.com/wzhudev/reverse-linear-sync-engine) （2058 star，Linear CTO 背书）
- 反应式数据层：[TinyBase](https://github.com/tinyplex/tinybase) （5096 star）
- Linear 同步引擎官方 talks：Tuomas Artman 在 LinearConf / Reactathon 多次分享

---

*相关阅读：*

- [TypeScript 7 即将到来：Go 端口如何让编译器提速 10×](/article/typescript-7-go-port-10x-compiler-2026) — 同一天的午间文章，从"编译生态的输入侧"看性能
- [Zeroserve 架构深度解析：当 io_uring、eBPF 与 Tarball 打包相遇](/article/zeroserve-io-uring-ebpf-web-server) — 从"系统编程的输出侧"看 1.2MB 实例的极致性能
- [DuckDB 出 Quack 了：把进程内数据库塞进客户端-服务器模型](/article/duckdb-quack-client-server-protocol) — 同属"数据库本地化"主题的另一篇深度文
