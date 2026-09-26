---
title: "Node.js 26.10 深度拆解：perf_hooks 把可观测性变成标准库原语，util.throttle/debounce 终结 lodash 依赖"
date: 2026-09-26
category: 技术
tags: [Node.js, Node 26, perf_hooks, SlidingWindowHistogram, QRDE, Harrell-Davis, HDR Histogram, util.throttle, util.debounce, 限流, 防抖, 节流, crypto.parsePKCS12, PKCS12, node:ffi, VFS, SEA, BoundSocket, worker_threads, 可观测性, 延迟分析, 尾延迟, 标准库, 平台运行时, JavaScript 运行时, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
excerpt: "2026 年 9 月 22 日，Node.js v26.10.0 发布，9 个 SEMVER-MINOR 全部是新增语，没有一个是「把某 API 标记为废弃」的清理工作。这是 Node 史上罕见的一版：perf_hooks 一次性补齐 SlidingWindowHistogram（分块环形 + 懒旋转 + 快照物化）和 QRDE（Harrell-Davis 分位数密度估计，比 Rscript 快 150-325 倍），把「测尾延迟」从装一个 APM Agent 变成 require('node:perf_hooks')；util.throttle / util.debounce 带着 AbortSignal、overflow: 'drop'、strict 滚动窗口、pendingCount/activeCount 可观测性一等公民进入标准库，直接清掉 lodash.debounce / p-limit / bottleneck 三类依赖；crypto.parsePKCS12 补上 mTLS 身份文件加载的最后一块缺口；node:ffi 支持从 VFS 加载动态库，打通 SEA 单文件部署原生扩展的最后一公里；net.BoundSocket 可跨 worker_threads / child_process 传递，让端口预留不再有线程间竞争。本文逐个拆开 6 大承重级革新的实现细节：分块环形缓冲为什么是 O(1) 摊销、QRDE 为什么必须在线程池算、为什么 throttle 的 ERR_THROTTLED 拒绝会被 markPromiseAsHandled 静默、以及 5 段可直接跑的生产级代码。"
---

# Node.js 26.10：当可观测性、流控、原生互操作全部变成标准库原语

2026 年 9 月 22 日，Node.js v26.10.0 发布。看 release notes 的 Notable Changes 列表会注意到一件反常的事：**9 个 SEMVER-MINOR，全部是新增 API，没有一个是 deprecation**。

这不是一个「清理债务」的版本，而是一个「平台层扩张」的版本。而且扩张的方向非常一致——**把过去十年里 JS 生态反复在 userland 重写、每个生产项目都要装一遍的东西，一次性收进标准库**：

- 测尾延迟 → 以前装 APM Agent 或自己攒 HDR Histogram，现在 `perf_hooks.createSlidingWindowHistogram()`
- 看延迟分布形状 → 以前导出到 R/Python 算密度估计，现在 `histogram.qrde()`，而且比 Rscript 快 150-325 倍
- 防抖节流 → 以前 `npm i lodash.debounce` / `p-limit` / `bottleneck`，现在 `util.debounce()` / `util.throttle()`
- 加载 mTLS 身份文件 → 以前 shell out 到 `openssl pkcs12` 或引 node-forge，现在 `crypto.parsePKCS12()`
- SEA 单文件部署里调原生库 → 以前直接报错 `dl.open failed`，现在 `ffi.dlopen()` 透明走 VFS
- 多线程/多进程预占端口 → 以前得靠 SO_REUSEPORT 或自己造竞争，现在 `net.BoundSocket` 可直接 transfer

一个版本里同时补齐「可观测性 + 流控 + 加密互操作 + 原生互操作 + 多线程网络」五条线，这在 Node 的 release 历史上不常见。本文挑出其中工程价值最高的 6 个改动，从**它解决了什么历史约束**讲起，一直拆到 C++ 层的环形缓冲实现和 JS 层的语义边界。

**适用读者**：写 Node 服务 3 年以上、经历过「装了 5 个依赖只为做一个限流器」「查 p99 还得去 Grafana 翻面板」「SEA 打包后在客户机器上调不动 .so」的人。

---

## 1. perf_hooks 的历史欠账：Node 有「计时器」但没有「延迟窗口」

要理解 SlidingWindowHistogram 为什么承重，得先看 Node 在「应用层延迟测量」上欠了多久。

Node 一直有 `performance.now()` 和 `performance.mark()/measure()`——但这是**单次计时**，测的是「这一段代码跑了多久」。而生产服务关心的是**分布**：同一个 handler 跑 10 万次，p50 / p95 / p99 / p99.9 各是多少。单次计时给不出分布，你得自己把每次结果收集起来、排序、算分位数。

于是在 Node 侧，生态自己长出了三层：

| 层 | 方案 | 问题 |
|---|---|---|
| 1. userland 数组 | 每次请求 push 一个耗时，定时排序算 p99 | 10 万样本的数组 + 排序，GC 压力和 CPU 都爆 |
| 2. APM Agent | Datadog / New Relic / OpenTelemetry SDK | 引入一个 Agent，每个请求多一次序列化开销，p99 本身被测量影响 |
| 3. HDR Histogram 库 | `hdr-histogram-js` 等社区实现 | 又一个依赖，且跟 Node 内部的 perf_hooks Histogram 是两套数据结构 |

Node 在 v16 引入 `perf_hooks.createHistogram()` / `monitorEventLoopDelay()`，算是把 HDR Histogram 的**单实例**搬进了标准库：固定桶、O(1) 记录、`percentile()` 直接查。但这只解决了「分布」的一半——**它是一个从进程启动起无限累积的单调直方图**。

累积直方图在生产环境有一个致命问题：**你的 p99 是开机以来 30 天的 p99，不是最近 5 分钟的 p99**。而排障时你只想看「出问题那个窗口」的分布。社区的做法是定时 `histogram.reset()`——但 reset 是一个**全有全无**的操作：清空那一刻起新数据从零开始，而你在 reset 前后两次查询之间的样本就落在缝隙里；更糟的是 reset 本身要清整个桶数组，跟你正在 record 的请求在热路径上竞争。

另一个常见做法是开 N 个 Histogram 轮换着用——但这个「轮换」逻辑每个人都得自己写一遍：什么时候切？切的时候旧块怎么办？查询的时候怎么合并？这些问题的正确答案不是显然的（本文第 2 节会看到几个容易写错的点）。

**这就是 Node 26.10 补的东西**：`createSlidingWindowHistogram()` 把「N 个分块、按时间或按计数轮换、查询时物化合并」做成了一个**语义明确的原语**，而且轮换是懒的、O(1) 的、不在热路径分配内存的。

### 1.1 与 OpenTelemetry / Prometheus 的位置关系

一个自然会问的问题：这东西跟 OTel 的 Histogram、跟 Prometheus 的 `histogram_quantile` 是竞争关系吗？

不是。它是**更底层的原语**：

- **OTel / Prometheus 是导出协议**：它们定义「直方图的数据如何被采集、传输、查询」，底下的存储通常是累积的（Prometheus 的 counter 语义）或固定桶（OTel 的 explicit bucket boundaries）。
- **SlidingWindowHistogram 是进程内的窗口管理**：它不关心你用什么协议导出，它只保证「你此刻 `snapshot()` 拿到的 Histogram，恰好覆盖最近 N 个分块」。

所以在一个真实架构里，正确的用法是：`SlidingWindowHistogram` 在进程内维护短窗口分布用于**本地实时告警和自适应限流**（微秒级查询，不离开进程）；OTel / Prometheus 负责把**累积**的指标导出去给中心化看板。两者是**短窗口本地决策 + 长窗口全局观测**的分层关系，不是替代关系。

**关键洞察 1：** 累积直方图回答「这个服务总体怎么样」，滑动窗口直方图回答「此时此刻这一分钟它在不在抖」。Node 之前只有前者，所以所有「最近 1 分钟 p99 突增」的自适应逻辑（限流、熔断、自动扩容）在 Node 里都得自己造轮子，造出来的大多还是错的（第 2.2 节给出错误示例）。

---

## 2. SlidingWindowHistogram：分块环形 + 懒旋转 + 快照物化

### 2.1 API 全貌

```js
const { createSlidingWindowHistogram } = require('node:perf_hooks');

// 按时间轮换：保留最近 6 个 10 秒分块 = 60 秒窗口
const window = createSlidingWindowHistogram({
  chunks: 6,
  chunkDuration: 10_000,   // 毫秒
  // 可选，跟普通 Histogram 一样
  lowest: 1,
  highest: Number.MAX_SAFE_INTEGER,
  figures: 3,
});

window.record(20_000_000);  // 记录一次 20ms 的耗时（纳秒）

// 把当前窗口物化成一个独立 Histogram
const snapshot = window.snapshot();
console.log(snapshot.percentile(99));  // p99
console.log(snapshot.count);
console.log(snapshot.mean);

window.reset();  // 作废所有分块，重新开始
```

`chunks` 和 `chunkDuration`（或 `recordsPerChunk`）的组合决定了窗口的**边界精度**。官方文档里有一句容易被忽略的话：

> The window boundary has chunk-level precision.

意思是：你想要「最近 60 秒」，得到的是「最近 6 个 10 秒分块」，**不是**精确到当前毫秒的 60 秒。边界最多会差一个 `chunkDuration`。这不是 bug，这是分块设计的必然代价——换来的是 record 的 O(1) 和内存的常数界。**如果你需要毫秒级精确的滑动窗口，分块方案全都是错的**，只能上更重的方案（比如按时间戳的滑动窗口聚合），Node 没有提供这个，也不该提供。

### 2.2 语义边界：几个容易写错的地方

**（a）`snapshot()` 返回的是一个新 Histogram，不是视图**

文档明确：

> Materializes the current window as a new, independent `Histogram`. Values recorded or expired after this method returns do not change the returned histogram.

所以 `snapshot()` 不是免费的：它要 `Histogram::Create()` 一个新直方图，然后把保留的每个分块 `Add` 进去。分块数 N 越大，snapshot 越贵。**别在每次请求里调 snapshot()**——它属于「每秒/每 10 秒读一次做决策」的调用，不是热路径调用。

**（b）count-based 窗口里，「record 调用」本身就消费配额**

> For a count-based window, every call that reaches the native histogram counts toward rotation, including values which exceed the configured `highest` value.

注意「reaches the native histogram」这个措辞——它暗示存在「到不了 native histogram」的 record 调用。实际上确实有：`Histogram.record()` 对非法值（负数、非整数）会 throw，throw 之前不会走到 native 层，所以不消费计数。这是一个微妙但重要的一致性保证：**计数旋转只数真正记进去的样本**。

**（c）不能 clone、不能 transfer**

> `SlidingWindowHistogram` instances cannot be cloned or transferred through a `MessagePort`.

这条限制是刻意的。实现上 `SlidingWindowHistogram` 是一个 `BaseObject`（不是 `HistogramBase`），而 BaseObject 默认禁止 clone/transfer。原因是环形状态绑在所属 `Environment` 的线程上——`origin_` 是 `uv_hrtime()` 打的时间桩，分块的 `generation` 全部相对于这个桩计算。跨线程 transfer 一个这样的对象，等于把一个依赖原线程时钟单调性的状态搬到另一个线程，语义无法保持。**想要跨线程看延迟分布？在 worker 里各测各的，然后把 snapshot（一个纯数据 Histogram）传出来，而不是传 SlidingWindowHistogram 本身。**

**（d）一个典型的错误实现长什么样**

自己造轮子时最容易写成这样：

```js
// ❌ 错误示范：定时器驱动的轮换
class NaiveSlidingWindow {
  constructor(windowMs) {
    this.current = createHistogram();
    this.previous = null;
    this.windowMs = windowMs;
    this.timer = setInterval(() => {
      this.previous = this.current;
      this.current = createHistogram();
    }, windowMs);
    this.timer.unref();
  }
  record(v) { this.current.record(v); }
  percentile(p) {
    // 窗口边界抖动 + 分配抖动
    return this.previous ? merge(this.previous, this.current).percentile(p)
                         : this.current.percentile(p);
  }
}
```

它有三个问题：① `setInterval` 触发时刻受事件循环阻塞影响，`windowMs` 漂移可达几十 ms；② 每次轮换 `createHistogram()` 在热路径之外但仍在事件循环上，且 merge 要分配 + 拷贝两个直方图；③「当前窗口」的真实跨度是 `(windowMs - 距上次轮换时间)` 到 `windowMs`，边界不确定，重复查询结果不一致。

SlidingWindowHistogram 用「懒旋转」把 ① 和 ② 一次性消灭：**没有定时器**，轮换只在 `record()` 或 `snapshot()` 被调用时按 `uv_hrtime()` 推算，既精确到纳秒又不占事件循环 tick。

### 2.3 C++ 实现拆解：generation ring

核心数据结构是一个 `std::vector<std::shared_ptr<Histogram>> chunks_` 加一个同样长度的 `generations_` 数组：

```cpp
class SlidingWindowHistogram final : public BaseObject {
 private:
  static constexpr uint64_t kNoGeneration =
      std::numeric_limits<uint64_t>::max();  // 0xFFFF...FFFF，表示该槽位空闲

  const Histogram::Options options_;
  std::vector<std::shared_ptr<Histogram>> chunks_;
  std::vector<uint64_t> generations_;        // 每个槽位当前属于哪一代
  std::shared_ptr<Histogram> spare_;         // 预分配的一个备用块
  const bool time_based_;
  const uint64_t rotate_at_;                 // 纳秒（时间）或样本数（计数）
  const uint64_t origin_;                    // 构造时的 uv_hrtime() 时间桩
  // ...
};
```

**generation 的含义**：当前时间相对 `origin_` 过了多少个 `rotate_at_` 周期。

```cpp
uint64_t SlidingWindowHistogram::CurrentTimeGeneration() const {
  const uint64_t now = uv_hrtime();
  CHECK_GE(now, origin_);
  return (now - origin_) / rotate_at_;
}
```

一个 1024 槽的环，generation 单调递增，槽号 = `generation % chunks_.size()`。**这里有一个必须处理的情况**：如果应用闲置了一段时间（比如 60 秒窗口、30 秒没请求），generation 跳了 3 代，环里可能还有 2 代前的旧数据没被覆盖。所以 `snapshot()` 合并时必须校验每个分块的「新鲜度」：

```cpp
std::shared_ptr<Histogram> SlidingWindowHistogram::CreateSnapshot() const {
  std::shared_ptr<Histogram> snapshot = Histogram::Create(options_);
  if (!snapshot) return {};

  uint64_t current_generation;
  if (time_based_) {
    current_generation = CurrentTimeGeneration();
  } else {
    if (!has_count_records_) return snapshot;   // 从没 record 过 → 空快照
    current_generation = current_generation_;
  }

  for (size_t i = 0; i < chunks_.size(); i++) {
    const uint64_t generation = generations_[i];
    // 三重过滤：空闲槽 / 未来代 / 超出窗口的陈旧代
    if (generation == kNoGeneration || generation > current_generation ||
        current_generation - generation >= chunks_.size()) {
      continue;
    }
    CHECK(chunks_[i]);
    CHECK_EQ(snapshot->Add(*chunks_[i]), 0);    // Add 返回 0 表示成功
  }
  return snapshot;
}
```

注意 `current_generation - generation >= chunks_.size()` 这个条件——**不是 `>`**。因为环的大小就是 `chunks_`，任何 `generation` 距离当前超过等于环长就必然已被覆盖（或即将被覆盖），此时它的数据是不可信的。这是一个典型的「环形缓冲必须做的边界判断」，漏掉 `=` 就会把刚被新数据覆盖一半的块算进快照。

**懒分配与 spare 块**：

```cpp
Histogram* SlidingWindowHistogram::GetChunk(uint64_t generation) {
  const size_t index = generation % chunks_.size();
  if (generations_[index] == generation) {
    CHECK(chunks_[index]);
    return chunks_[index].get();          // 命中当前代，零分配
  }

  if (chunks_[index]) {
    chunks_[index]->Reset();              // 复用已分配的块，只清数据
  } else if (spare_) {
    chunks_[index] = std::move(spare_);   // 用预分配的备用块
  } else {
    chunks_[index] = Histogram::Create(options_);  // 最后才真正分配
    if (!chunks_[index]) return nullptr;
    const size_t size = chunks_[index]->GetMemorySize();
    external_memory_ += size;
    env()->external_memory_accounter()->Increase(env->isolate(), size);
  }

  generations_[index] = generation;
  return chunks_[index].get();
}
```

三层分配策略，稳态下（所有槽位都已暖）`record()` 的额外开销是**一次 `Reset()`**，不分配堆内存。构造时只分配一个块（`spare_`），其余块在第一次轮换到时才 lazy 分配。并且每次分配都通过 `env->external_memory_accounter()->Increase()` 报给 V8——**这一点很重要**：这些直方图块是 native 内存，V8 默认看不到，如果不记账，V8 的 heap statistics 会低估进程 RSS，导致基于 `process.memoryUsage().rss` 或 V8 `GetHeapStatistics` 做的容量规划失真，GC 也不会因为这些外部分配而更积极。析构时对应 `Decrease`，配平。

**`record()` 用了 V8 Fast API Call**：

```cpp
void SlidingWindowHistogram::FastRecord(Local<Value> receiver,
                                        int64_t value,
                                        FastApiCallbackOptions& options) {
  CHECK_GE(value, 1);
  TRACK_V8_FAST_API_CALL("histogram.slidingWindow.record");
  SlidingWindowHistogram* histogram;
  ASSIGN_OR_RETURN_UNWRAP(&histogram, receiver);
  if (!histogram->RecordValue(value)) {
    HandleScope scope(options.isolate);
    THROW_ERR_MEMORY_ALLOCATION_FAILED(histogram->env());
  }
}
```

`SetFastMethod` 注册的 `FastRecord` 是一个**不进入 V8 参数转换、不创建 HandleScope**（除非出错）的快路径。`record()` 在稳定状态下不会触发任何 V8 对象分配——这正是它能被放进每请求热路径的原因。对比之下，userland 的 `histogram.record(v)` 要经过一次 JS→native 的完整 marshalling。

**计数旋转的实现**（注意它没有时间戳，完全由 record 次数驱动）：

```cpp
bool SlidingWindowHistogram::RecordValue(int64_t value) {
  uint64_t generation;
  if (time_based_) {
    generation = CurrentTimeGeneration();
  } else if (records_in_current_chunk_ == rotate_at_) {
    CHECK_LT(current_generation_, kNoGeneration - 1);
    generation = current_generation_ + 1;      // 满了，进下一代
  } else {
    generation = current_generation_;
  }

  Histogram* chunk = GetChunk(generation);
  if (chunk == nullptr) return false;

  chunk->Record(value);
  if (!time_based_) {
    if (generation != current_generation_) {
      current_generation_ = generation;
      records_in_current_chunk_ = 0;
    }
    records_in_current_chunk_++;
    has_count_records_ = true;    // 区分「空」和「第 0 代」，见下
  }
  return true;
}
```

注意 `has_count_records_` 这个标志。计数模式下，`current_generation_` 初始是 0，generation 也从 0 开始——如果没有任何 record，`CreateSnapshot()` 里的 `current_generation_` 仍然是 0，会把一个空但「有效」的第 0 代块算进快照。`has_count_records_` 就是为了区分「第 0 代有数据」和「第 0 代从未被写过」这两种情况。**这是那种看起来多余、删掉就会出一个隐蔽 bug 的字段**。

**边界常量**（JS 侧）：

```js
const kMaxSlidingWindowHistogramChunks = 1024;
const kMaxChunkDuration = 18_446_744_073_709;   // 毫秒
```

1024 个分块上限，`chunkDuration` 上限约 58494 天（`uint64_t` 纳秒上限换算成毫秒）。1024 这个上限是防呆的：有人想要「1 毫秒精度 + 24 小时窗口」= 8640 万个块，内存直接爆炸。有了硬上限，`validateInteger` 会直接 throw `ERR_OUT_OF_RANGE` 而不是让进程 OOM。**设计上这是一个「宁可得罪用户也不给枪」的决定**——分块直方图的内存是 `chunks × figures` 指数级增长的（见 2.4 节的表）。

### 2.4 内存账：figures 每加 1，内存 ×8

`figures`（有效数字位数，1-5）是 HDR Histogram 最容易被忽视的成本开关。Node 26 文档里第一次给出了明确的内存表（`lowest: 1`、`highest: Number.MAX_SAFE_INTEGER`，不含分配器和 JS 对象开销）：

| `figures` | Histogram | 最大展开快照 | 峰值 cache-miss QRDE |
| --------- | --------: | ----------: | -------------------: |
| 1         |   6.3 KiB |       25 KiB |               31 KiB |
| 2         |    47 KiB |      188 KiB |              235 KiB |
| 3         |   352 KiB |      1.4 MiB |              1.7 MiB |
| 4         |   5.0 MiB |       20 MiB |               25 MiB |
| 5         |    37 MiB |      148 MiB |              185 MiB |

每加一个 figure，桶数 ×8（因为 2^3 = 8，一位十进制有效数字对应 3 bit 的子桶精度）。默认 `figures: 3`，单个 Histogram 352 KiB。

对一个 SlidingWindowHistogram，**总内存 ≈ chunks × 单块**。6 个块 × 352 KiB ≈ 2.1 MiB，完全可接受。但如果有人想要 `figures: 5` + `chunks: 1024`：37 MiB × 1024 ≈ **37 GiB**。这就是为什么 `chunks` 上限是 1024 而不是更高——它跟 `figures` 相乘，是指数项。

**最佳实践**：`figures` 从默认 3 开始，只有在明确需要亚毫秒级精度区分时才考虑 4。`highest` 尽量压小（比如你的 API 耗时不会超过 10 秒，就设 `highest: 10_000_000_000` 而不是 `MAX_SAFE_INTEGER`），因为桶数是 `log(highest/lowest) × figures` 决定的。

---

## 3. QRDE：把 R 语言的质量密度估计做进 C++ 线程池

### 3.1 为什么「分位数」不够，还需要「密度」

有了 `percentile(99)` 你知道 p99 是 240ms。但你不知道：

- 延迟分布在 200-280ms 之间是**平坦**的（正常的长尾），还是有一个**尖峰**在 250ms（某个下游超时重试）？
- p99.9 和 p99.99 之间还有多少概率质量？

分位数是点估计，密度是形状。**排障时形状比点更有信息量**——一个双峰分布几乎一定意味着「两条不同的代码路径」，一个尾部尖峰几乎一定意味着「某个具体的同步瓶颈」。

但直方图（尤其 HDR）不能直接拿来画密度，因为它的桶是**指数间隔**的，而且同一个桶里的值会塌缩成一个点。直接按桶计数画出来，得到的是锯齿状的、尺度被扭曲的图。

QRDE（Quantile-Respectful Density Estimate，分位数尊重密度估计）的思路是：**不按 x 轴分箱，按概率质量分箱**。把 [0, 1] 概率区间均分成 N 份，算出每份对应的分位数边界，再用「概率质量 / (分位数差)」得到该区间的密度。因为每个区间含等量概率质量，密度就直接反映了「这段值域里样本有多密」。

Node 用的是 **Harrell-Davis 分位数估计器**——一个基于 Beta 分布权重的分位数估计，比朴素的「排序取第 k 个」在中小样本下更稳定（无偏性更好，对尾部更敏感）。它的代价是计算重：每个分位数都要算一次 Beta 分布的累积权重。

### 3.2 API 与性能

```js
const { createHistogram } = require('node:perf_hooks');
const h = createHistogram();

// ... 记录大量样本 ...

const result = await h.qrde({
  bins: 100,                       // 等概率分箱数，1-1000
  // 或自定义概率边界（跟 bins 互斥）：
  // probabilities: [0, 0.9, 0.99, 0.999, 0.9999, 1],
  dequantize: 'hdr',               // 'none' | 'hdr' | 'all'，默认 'hdr'
  cache: false,                    // 缓存展开快照
});

// result:
// {
//   probabilities: Float64Array,   // 概率边界
//   quantiles: Float64Array,       // 对应的分位数
//   densities: Float64Array,       // 每个区间的密度
//   count: bigint,                 // 快照中的样本数
//   bucketCount: number,           // 有数据的 HDR 桶数
//   corrections: number,           // 被钳位的非单调浮点结果数
//   dequantize: 'hdr',
// }
```

关键性能数据（来自 PR #65806 作者实测）：**在 100 万样本、1000 个分箱的工作负载下，Node 内置实现比在 R 里做等价计算（Rscript）快 150-325 倍**。

为什么能快这么多？三个原因：

1. **不用序列化**。Rscript 路线是「Node 里导出 CSV → 启动 R 进程 → 读数据 → 算 → 输出」。光进程启动 + IO 就够把 150 倍吃掉了。
2. **在 libuv 线程池里跑**。文档原文：

   > Snapshot expansion and the estimate are calculated in the libuv thread pool.

   所以 `qrde()` 返回 Promise——它不阻塞主线程的事件循环。Harrell-Davis 的 Beta 权重计算是 CPU 密集的（O(n_bins × 精度迭代)），放主线程会直接造成一次「用 p99 分析工具把 p99 拉高」的尴尬。
3. **大样本下的二阶渐近近似**：

   > Highly concentrated beta weights use a second-order asymptotic approximation to avoid numerical convergence loss at large sample counts.

   Harrell-Davis 在样本数很大时，Beta 分布权重会高度集中在个别点上，直接做数值积分会丢精度（收敛慢 + 累积误差）。用渐近展开既快又更准。这是一个「工程上必须做、论文里不会写」的细节。

### 3.3 `dequantize` 三档：一个被低估的选项

这是 QRDE 里设计得最细的地方。HDR Histogram 把值压进桶，一个桶内所有值都记录为同一个数。做密度估计时，如果一个宽桶里有 1000 个样本，朴素的「桶中点」算法会画出一个 **Dirac delta（一个无穷窄的尖峰）**，密度图上就是一根刺。

三档策略：

| 模式 | 行为 | 适用 |
|---|---|---|
| `'none'` | 直接用桶中点算 grouped Harrell-Davis | 桶很窄（`figures` 高）时才用 |
| `'hdr'`（默认） | **只**把「比一个单位宽的桶」里的重复值展开成桶内均匀分布；单位精度的重复值仍保留为点质量 | 通用推荐 |
| `'all'` | 连单位精度的重复值也展开 | 想要完全平滑的曲线 |

**`'hdr'` 作为默认值是一个深思熟虑的折折**。真实的延迟数据里，大量样本落在「整数毫秒」这种单位精度上（因为很多操作本身就是整毫秒对齐的，比如 `setTimeout`）。如果把这些也展开成均匀分布，真实的**离散性**就被抹掉了——你会看到一条平滑曲线，而真实情况是一把梳子。`'hdr'` 保留梳子（点质量），只抹平 HDR 桶量化的方波。

反过来，`'none'` 会制造方波：文档里明确指出「A non-dequantized interval whose quantile boundaries are equal has an infinite density」——两个分位数边界相等（因为数据被压进同一个桶），密度 = 概率质量 / 0 = ∞。**这不是 bug 提示，是物理事实**：数据分辨率不够时，密度估计在那一格就是奇异的。`dequantize` 存在的全部意义就是把这种奇异点打散。

### 3.4 `cache: true` 的正确用法

```js
await h.qrde({ bins: 20, cache: true });    // 这次展开快照 + 缓存
await h.qrde({ bins: 50, cache: true });    // 复用同一份展开快照
await h.qrde({ probabilities: [0,.9,.99,1], cache: true }); // 也复用
h.record(v);                                 // ⚠️ 缓存失效
await h.qrde({ cache: true });               // 重新展开 + 重新缓存
```

缓存的语义是「展开的快照」（32 bytes/occupied bucket），在 histogram **下次被修改时**自动失效。它对「同一份数据我要画好几种密度的图」这个场景很有用——但**一旦中间 record 了一条新数据，缓存就废了**。

一个高频误用：在请求处理路径里 `record()` 之后立刻 `qrde({cache:true})`，然后下一次请求又 record 又 qrde——每次都 cache miss，每次都额外分配「一个 HDR count array + 每 occupied bucket 32 bytes」的临时内存。这种用法下 `cache: true` 纯粹是浪费。**cache 只适合「批量分析完不再变」的离线式调用。**

内存代价表（来自文档）：

| 操作 | 临时开销 |
|---|---|
| 单次 QRDE（cache miss） | 约 1 个 HDR count array + 32 B/occupied bucket |
| `cache: true` 保留 | 32 B/occupied bucket 常驻，直到下次修改 |

并且文档有一句警告值得记住：

> Concurrent calls that miss the cache each require their own temporary copy and expanded snapshot.

`qrde()` 是并行的（多个 Promise 可以同时在 libuv 池里跑），但**每个并发调用各自一份临时内存**。所以不要想着「同时发 100 个 qrde 请求做并行分析」，那是 100 份临时拷贝。

---

## 4. `util.throttle` / `util.debounce`：流控原语进标准库

### 4.1 为什么值得收进核心

这两个函数是 JS 生态里被重写次数最多的工具之一（lodash.debounce 每周下载量 4000 万级）。但「大家都用 lodash 的实现」恰恰掩盖了一个问题：**在服务端场景，lodash.debounce 的语义是不够的**。

lodash.debounce 是为前端设计的——它默认假设：调用是可丢弃的、没有返回值需要等待、不需要限流（只防抖）、不需要取消。而服务端场景几乎完全相反：

- 调用上游 API，**必须**拿到结果（Promise）
- 不只是防抖，还要**限流**（每秒最多 N 次）
- 超时要能取消、过载要能拒绝
- 需要知道「现在排了几个、跑着几个」来做背压决策

Node 26 的实现把这四点全做成了**一等公民**。

### 4.2 `util.throttle` 完整语义

```js
const util = require('node:util');

const fetchWithLimit = util.throttle(
  async (url) => (await fetch(url)).json(),
  10,          // limit：每个 interval 最多调用 10 次
  1000,        // interval：1000ms
  {
    concurrency: 5,        // 同时未结算的调用最多 5 个
    overflow: 'queue',     // 'queue'（默认）| 'drop'
    maxPending: 100,       // queue 模式下最多排 100 个
    strict: false,         // 滚动窗口严格模式
    signal: abortController.signal,
  }
);
```

**（a）容量消费时机**：

> An invocation starts only when both rate and concurrency capacity are available. Rate capacity is consumed when `fn` starts, not when a call enters the queue. Concurrency capacity is released when the value returned by `fn` settles.

这个区别极其重要。如果「进入队列」就消费 rate 配额，那么 `maxPending: 100` 的队列会把未来 10 个窗口的配额全部预支掉，真正的执行时刻完全失控。**rate 配额在 `fn` 实际被调起时才扣减**，保证「队列里排着」不等于「额度被占」。

**（b）`overflow: 'drop'` 与 `ERR_THROTTLED`**：

```js
const t = util.throttle(fn, 1, 1000, { overflow: 'drop' });
const p1 = t();   // 立即执行
const p2 = t();   // 立即 reject，不会排队
await p2.catch(e => console.log(e.code));  // 'ERR_THROTTLED'
```

`ERR_THROTTLED` 是这一版新加的错误码。它最值得说的设计是：

> The rejected promise is marked as handled, so ignoring it does not emit an `'unhandledRejection'` event. Awaiting or explicitly handling the promise still observes the rejection.

**限流拒绝默认不产生 unhandledRejection**。这是一个为「丢弃式限流」专门做的决定：`overflow: 'drop'` 的语义就是「这些调用本来就不打算被处理」，如果每个被丢弃的调用都冒一个 unhandledRejection，`process.on('unhandledRejection')` 的监控会被刷爆，而且全是噪声。但**如果你真的 await 了它，错误还是能被看到**——它只是不「大喊大叫」。

这是这一版里另一个新 API `util.markPromiseAsHandled()` 的实际用武之地。这个 API 就是为了解决「我想让一个 promise 默认不触发 unhandledRejection，但保留它被显式处理的能力」——throttle 内部就是用它实现 drop 语义的。

**（c）`strict: true` 与窗口边界**：

默认（`strict: false`）是**窗口制**：

> By default, the interval begins when the first call in a new window invokes `fn`. Up to `limit` calls can invoke `fn` during that window. Queued calls are processed in groups of up to `limit` as each subsequent window begins. This windowed behavior can result in calls occurring close together at a window boundary.

这句话的后半段是重点：**窗口制允许「突发」**。第一个窗口的 10 次可以在第 1ms 全部发出，第二个窗口的 10 次在第 1001ms 全部发出——任意 1 秒内的实际峰值是 20 次。

如果你的下游对「任意 1 秒内最多 10 次」这个约束是严格的（很多 API 的 rate limit 就是这么算的），`strict: true` 把它变成**滚动窗口**：

> When `options.strict` is `true`, invocation times are tracked individually. This ensures that no more than `limit` calls begin during any rolling interval, at the cost of additional bookkeeping.

代价是「additional bookkeeping」——每次调用的时间戳要单独追踪。对高 QPS 场景这个开销是实在的（每个调用一个时间戳 + 检查时的遍历或二分），**但它买到的是「下游不会被窗口边界的双倍突发打挂」**。

**（d）可观测性属性**：

返回的函数带这些属性，全都可以在运行时读：

```js
t.pendingCount    // 排队等执行的调用数
t.activeCount     // 已调起但还没结算的调用数
t.pending         // 最近一个排队调用返回的 Promise（或 null）
t.hasImmediateCapacity()  // 现在调用能立即执行吗（不预约额度）
t.cancel([reason])        // 取消全部排队，已开始的不管
t.ref() / t.unref()       // 定时器是否阻止进程退出
```

`hasImmediateCapacity()` 的文档特意说明了一个用法：

> Callers can avoid creating a timeout by only calling the throttled function when this method returns `true`.

也就是说：**在消息队列消费者这类场景里，你可以先 `hasImmediateCapacity()` 探一下，没额度就先不消费，而不是消费了再被 reject**。这对背压传导很有用——把限流状态暴露给上游的消费决策，而不是事后丢弃。

`unref()` 也值得注意：throttle 的排队是靠 `setTimeout` 实现的，默认会阻止 Node 进程退出（保持事件循环）。在 CLI 工具或 serverless 函数里，你大概率想 `unref()`，否则「队列里还有一个排队的请求」就能让你的 Lambda 挂到超时。

### 4.3 `util.debounce`：Promise 化的防抖

```js
const fn = util.debounce(async (q) => await search(q), 300, {
  leading: false,     // 窗口开始时是否立即调用一次
  signal: ac.signal,  // abort 时所有 pending reject
});
```

与 throttle 对称的属性集：`cancel([reason])` / `flush()` / `pending` / `pendingCount` / `ref()` / `unref()`。

`flush()` 是 debounce 特有的、也是服务端最有用的一个：

> `flush()` cancels the delay and invokes `fn` immediately. It has no effect if there is no pending window.

**典型用法**：HTTP 服务在收到请求时 debounce 聚合，但在响应必须发出的时刻 `flush()` 保证不丢最后一次更新。或者在 `process.on('beforeExit')` 里 flush 掉还没发的日志/指标。

`leading: true` 的语义也定义得比 lodash 更精确：

> When `options.leading` is `true`, the first call in a debounce window invokes `fn` immediately. Calls made during that window are delayed until `wait` milliseconds have elapsed since the most recent call. A trailing invocation only occurs if the debounced function was called again during the window.

即 leading + trailing 会**同时**生效，且 trailing 只在「窗口内确实有新调用」时才触发——不会出现「leading 调了一次、窗口结束又空转一次」的重复。

### 4.4 一个完整的自适应限流器

把 SlidingWindowHistogram 和 util.throttle 放一起，就是一个完整的「按实时延迟自适应」的限流器——**不需要任何外部依赖**：

```js
const { createSlidingWindowHistogram } = require('node:perf_hooks');
const util = require('node:util');

// ============ 1. 延迟窗口：最近 6 × 1s = 6 秒 ============
const latency = createSlidingWindowHistogram({
  chunks: 6,
  chunkDuration: 1_000,
  lowest: 1,
  highest: 60_000_000_000,   // 60s 上限，压低 figures 带来的桶数
  figures: 3,
});

// ============ 2. 被限流的真实调用 ============
async function callDownstream(payload) {
  const t0 = process.hrtime.bigint();
  try {
    const res = await fetch('https://api.internal/process', {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'content-type': 'application/json' },
    });
    return await res.json();
  } finally {
    const ns = Number(process.hrtime.bigint() - t0);
    latency.record(ns);   // ⚠️ record 纳秒，不是毫秒
  }
}

// ============ 3. 限流器：初始 20 QPS，溢出丢弃 ============
let currentLimit = 20;
const ac = new AbortController();
const throttled = util.throttle(
  callDownstream,
  currentLimit,     // limit
  1_000,            // interval
  {
    concurrency: 8,
    overflow: 'drop',       // 过载直接拒绝，不排队（避免雪崩）
    maxPending: 50,
    signal: ac.signal,
  }
);

// ============ 4. 每 2 秒根据 p99 自适应调整额度 ============
setInterval(() => {
  const snap = latency.snapshot();           // 物化最近 6 秒
  if (snap.count < 20) return;               // 样本太少，不动

  const p99ns = snap.percentile(99);
  const p50ns = snap.percentile(50);
  const p99 = p99ns / 1e6;                   // 转毫秒

  if (p99 > 800) {
    currentLimit = Math.max(2, Math.floor(currentLimit * 0.6));
    console.log(`p99=${p99.toFixed(0)}ms → 降级到 ${currentLimit} QPS`);
  } else if (p99 < 250 && p50ns / 1e6 < 80) {
    currentLimit = Math.min(200, Math.floor(currentLimit * 1.2));
    console.log(`p99=${p99.toFixed(0)}ms → 提速到 ${currentLimit} QPS`);
  }

  // util.throttle 的 limit 是构造时固定的，需要重建限流器
  // （26.10 没有提供动态修改 limit 的接口，这是当前的一个限制）
}, 2_000).unref();

// ============ 5. 请求入口 ============
async function handler(payload) {
  const p = throttled(payload);
  const result = await p.catch((err) => {
    if (err.code === 'ERR_THROTTLED') {
      return { status: 429, retryAfter: 1 };   // 过载，直接告诉客户端
    }
    throw err;
  });
  return result;
}
```

**这段代码里值得注意的四个点**：

1. **`record()` 的是纳秒**。Node 的 perf_hooks 一律用纳秒。混用毫秒会让 p99 差 6 个数量级，而且不会报错——HDR Histogram 会开开心心把 20ms 记成「20 纳秒」并给你一个 p99 = 0.00002ms 的漂亮数字。
2. **`overflow: 'drop'` 而不是 `'queue'`**。对下游过载场景，排队是错的——排队只会让超时传播给客户端，还会放大内存压力。直接拒绝 + 返回 429 是更诚实的做法。而 `ERR_THROTTLED` 的「markPromiseAsHandled」设计让这件事不会污染你的 unhandledRejection 监控。
3. **`latency.snapshot()` 在非热路径调用**。每 2 秒一次，每次物化 6 个分块的合并，成本在微秒级，不在请求路径上。
4. **`unref()`**。这个 setInterval 不会阻止进程优雅退出。

**关键洞察 2：** 注意第 4 步的注释——`util.throttle` 目前**不能动态改 limit**，要改额度必须重建限流器（旧实例上排队的调用仍按旧额度走完）。这是一个真实的产品限制：自适应限流要么接受「额度切换有滞后」，要么自己在外层加一层「当前有效额度」的动态路由。`hasImmediateCapacity()` + `overflow: 'drop'` 的组合可以在不重建的情况下做粗粒度的动态控制（超额时入口直接 429），但精确的「改 limit」这一版做不到。

---

## 5. crypto.parsePKCS12：mTLS 身份文件加载的最后一块缺口

### 5.1 之前的痛

云上跑服务，跟内部下游或支付网关通信，身份证书通常不是「公钥 + 私钥两个 PEM」，而是一个 **PKCS#12 bundle**（`.p12` / `.pfx`）——私钥 + 端实体证书 + 中间证书链打包加密在一起。

Node 的 `tls` / `https` API 只接受分开的 `key` / `cert` / `ca`。于是每份部署文档都长这样：

```bash
# 先把 .pfx 拆开
openssl pkcs12 -in identity.pfx -nocerts -out key.pem -nodes
openssl pkcs12 -in identity.pfx -clcerts -nokeys -out cert.pem
openssl pkcs12 -in identity.pfx -cacerts -nokeys -out chain.pem
```

这在 CI/CD 里意味着：**构建产物里必须存在解密后的明文私钥文件**，私钥落盘。合规审计（PCI-DSS、等保）会直接扣分。

另一个路子是引 `node-forge` 这类纯 JS 实现——但 forge 的 PKCS#12 解析在遇到现代加密算法（PBES2 + AES-256-GCM）时支持不全，而且纯 JS 的解密比 OpenSSL 的 C 实现慢一个数量级。

**PR #65627 的作者在描述里写了一句很关键的话**：

> Reading a `.p12` / `.pfx` bundle from JavaScript today means shelling out to the `openssl pkcs12` CLI or taking a userland dependency such as node-forge. In talking to a colleague about this unfortunate missing method in core, I (with Claude) noticed **Node.js already parses this internally**.

Node 内部本来就有一个解析 PKCS#12 的实现——在 `crypto.createPrivateKey()` / `X509Certificate` 的内部路径里被用到。它只是没被暴露成公开 API。这个 PR 做的事情本质上是**把已有的内部能力开个口子**，而不是新写一个解析器。这也是为什么它只有 +643 行（其中一半是文档和测试）。

### 5.2 API

```js
const { parsePKCS12 } = require('node:crypto');
const { readFileSync } = require('node:fs');

const {
  privateKey,              // KeyObject | null —— bundle 里的第一个私钥
  certificate,             // X509Certificate | null —— 匹配 privateKey 的端实体证书
  additionalCertificates,  // X509Certificate[] —— 其余的中间/根证书
} = parsePKCS12(readFileSync('identity.p12'), { passphrase: 'secret' });
```

返回值是**强类型对象**（`KeyObject` / `X509Certificate`），不是裸 Buffer。这意味着可以直接喂给 `tls.connect`：

```js
const { parsePKCS12 } = require('node:crypto');
const { readFileSync } = require('node:fs');
const https = require('node:https');

const { privateKey, certificate, additionalCertificates } =
  parsePKCS12(readFileSync('client.p12'), { passphrase: process.env.P12_PASS });

const agent = new https.Agent({
  key: privateKey,
  cert: certificate,
  ca: additionalCertificates,   // 中间链直接从 bundle 里来，不用单独管
});

const res = await fetch('https://internal-api.example.com/health', { agent });
```

**私钥全程不落盘，也不经过 JS 字符串**——它在 OpenSSL 内部被解析成一个 `EVP_PKEY`，包成 `KeyObject` 直接递给 TLS 层。这是这个 API 最大的安全价值。

### 5.3 三个实现细节

**（a）passphrase 的 NUL 语义**。源码注释：

```js
// `undefined` means no passphrase, '' a zero-length one. OpenSSL accepts
```

`undefined`（不给）和 `''`（空字符串）是**两种不同的东西**：前者表示「这个 bundle 没有加密」，后者表示「用空密码解密」。OpenSSL 的 C API 用 NUL 结尾字符串收密码，所以 JS 层还要额外检查「密码里不能含 NUL 字节」——否则密码会被截断，然后用截断后的前半段去解密，可能解出一个**错误但合法**的结果。这是一个真实的注入类风险点。

**（b）错误码的归一化**。源码里有一段：

```cpp
// the wrong passphrase is reported as PKCS8_R_INCORRECT_PASSWORD instead --
```

OpenSSL 不同版本、不同 provider 对「密码错误」会抛不同的错误码。Node 把它们归一成一个稳定的 `ERR_CRYPTO_UNKNOWN_DH_GROUP` 之类的 JS 错误（具体码见文档），**让你的 catch 分支不用判断 OpenSSL 内部错误字符串**。

**（c）legacy provider**。注释提到：

```cpp
// OpenSSL 3 reports algorithms that moved to the legacy provider as a
```

用旧算法（RC2/RC4/3DES，老 .pfx 常用）加密的 bundle，在 OpenSSL 3 默认配置下可能报「algorithm not found」，因为它们被移到了 `legacy` provider。Node 内部已经处理了 provider 的加载，但**如果你的 .pfx 是 2015 年前生成的，仍然可能需要确认 Node 构建里有没有编入 legacy provider**（官方构建有，某些最小化发行版的 Node 可能没有）。

**关键洞察 3：** `parsePKCS12` 不是一个「功能新增」，而是一个**安全边界修正**——它把「私钥必然落盘」这个 CI/CD 时代的隐含约束消掉了。而且它的实现路径（暴露已有内部能力）说明：**很多「Node 缺这个 API」的抱怨，解法不是写新代码，而是把 internal/ 的东西搬到 lib/ 的导出表里**。这一点对所有做平台运行时的人都适用。

---

## 6. node:ffi 从 VFS 加载动态库：SEA 部署的最后一公里

### 6.1 问题：动态加载器看不见虚拟文件系统

Node 的 **SEA（Single Executable Application）** 把 JS + 资源打进一个二进制，配合 VFS（`useVfs`）可以让 `require()` 加载嵌在二进制里的原生 addon——addon 的字节被读出来，喂给 `process.dlopen()`，后者从一个**私有、自清理的内存镜像**（Linux 上是 anonymous memfd）加载。

但 `node:ffi`（Node 25+ 稳定的外部函数接口）一直没跟上：

```js
const ffi = require('node:ffi');
// .so 文件嵌在 SEA 的 VFS 里
ffi.dlopen('/snapshot/lib/vendor.so', { ... });
// ❌ Error: dlopen failed: /snapshot/lib/vendor.so: cannot open shared object file
```

原因是**操作系统的动态加载器（ld.so / dyld）不认识 VFS**。VFS 的挂载路径在真实文件系统里没有 inode，ld.so 调 `open()` 直接返回 ENOENT。这导致一个尴尬的二分：**用 SEA 做单文件分发，就不能用 ffi 调原生库；用 ffi，就得把 .so 铺到磁盘上，破坏单文件性**。

对需要调用 vendor SDK（加密机驱动、GPU 库、行业 SDK）的桌面/边缘应用，这是一个真实的部署阻塞点——打包一个 .app / .exe，结果用户机器上缺 Visual C++ 运行时或 .so 路径不对，程序起不来。

### 6.2 PR #65909 的做法

让 `ffi.dlopen()` 走上 `require()` 早就走的那条路：

> The operating system's dynamic loader cannot open a library that lives in a mounted virtual file system: the reserved mount path has no real inode. Native addons already handle this in `require()`: the loader hands their bytes to `process.dlopen()`, which loads them from a private, self-cleaning image — an anonymous in-memory memfd on Linux. This makes `ffi.dlopen()` and `new ffi.DynamicLibrary()` do the same, transparently.

架构上是一个很干净的「seam」（接缝）设计。新增的 `lib/internal/ffi/vfs.js` 模块的注释说明了自己为什么不引入循环依赖：

```js
// from the VFS and handed to the native constructor, which loads them from
// a private, self-cleaning image - the same way require() handles a native
// addon in a VFS. The reader is installed by the VFS while it is mounted
// (see internal/ffi/vfs), so no VFS code is ever loaded from here.
```

关键在最后一句「no VFS code is ever loaded from here」。如果 ffi 模块直接 `require('internal/vfs')`，那么**加载 VFS 的过程可能需要 ffi，而 ffi 又依赖 VFS**——循环。解法是 invert 依赖：VFS 挂载时主动「安装一个 reader 函数」到 ffi 模块的插槽里，ffi 只调用这个插槽（`getVfsLibraryReader()`），不知道 VFS 的任何实现细节。**插槽模式（hook installer）是运行时层解循环依赖的标准武器**。

### 6.3 语义边界：`lib.path` 还是虚拟路径

```js
const ffi = require('node:ffi');
const { lib, functions } = ffi.dlopen('/snapshot/lib/vendor.so', {
  vendor_compute: { args: ['int'], result: 'int' },
});
```

成功后，`lib.path` **仍然报告 VFS 路径**（`/snapshot/lib/vendor.so`），而不是真实的 memfd 路径。这是一个刻意的设计：用户代码里对 `lib.path` 的判断逻辑（比如「这是不是我预期的那个库」）在 VFS 和非 VFS 环境下保持一致。真实的内存镜像路径是实现细节，暴露出来反而有害（每次启动路径不同，而且无法用于任何有意义的文件操作）。

**适用边界**：这个特性只在**VFS 已挂载**时生效。普通的 `ffi.dlopen('/usr/lib/libfoo.so')` 走的还是操作系统的 dlopen——真实文件系统路径，不受影响。两种路径在 API 层完全透明，只在「文件存在但加载不了」这个特定情况下行为不同。

---

## 7. net.BoundSocket 跨线程/跨进程传递

### 7.1 「bind 竞争」是什么问题

一个常见的多 worker 架构：主进程占用 80 端口，把已接受的连接分发给 workers。Node 早就支持把 `net.Server` 发给子进程（`subprocess.send(..., server)`）。

但这里有一个一直存在的**时序漏洞**：如果每个 worker 自己 `listen(port)`，第一个 bind 成功，其余的 `EADDRINUSE`。要避免，只能让「bind」这个动作集中在一处做。

Node 26 之前，`net.BoundSocket`（v23 引入：同步预占一个端口但不 listen）**只能在创建它的线程/进程里用**。现在它变成了可传递对象：

> A `BoundSocket` reserves a port synchronously at construction time. Making it transferable means a port can be reserved on one thread or process and the bound handle handed off to another to listen or connect on, **without racing on the bind**.

### 7.2 两种传递方式

```js
// 方式 A：worker_threads（transfer list）
const { Worker } = require('node:worker_threads');
const { BoundSocket } = require('node:net');

const bound = new BoundSocket({ port: 8080 });   // 主线程同步占住 8080
const worker = new Worker('./worker.js');
worker.postMessage({ ready: true }, [bound]);     // ⚠️ 必须放在 transfer list

// 方式 B：child_process（sendHandle）
const { spawn } = require('node:child_process');
const child = spawn('node', ['child.js'], { stdio: ['inherit', 'inherit', 'inherit', 'ipc'] });
child.send({ port: 8080 }, bound);                // 第二参数 = sendHandle
```

**转移后的语义**（文档原文）：

> After the transfer, the source `BoundSocket` behaves as if it had been adopted: `address()`, `fd()` and ...

源对象进入 adopted 状态——端口已经不归它管了，但 `address()` 仍能返回之前绑的地址（这是一个「只读记忆」语义，用于日志和诊断）。

**限制**：

> Pipe binds cannot be sent over the IPC channel.
> Pipe binds are not transferable.

只有 **TCP** 的 BoundSocket 能传，Unix domain socket（pipe bind）不能。原因是 pipe 的句柄语义在进程间转移时的所有权模型跟 TCP 不同（命名实体 vs 匿名 fd）。

### 7.3 这个能力买到什么

一个具体的场景：**零停机重启 + 精确端口分配**。主进程预占一个端口段（比如 8000-8009），把不同的 BoundSocket 分发给 N 个 worker，每个 worker 独立 listen 自己那个端口，前面挂一个负载均衡。因为 bind 是主进程在**启动时同步串行**做的，**不存在任何 EADDRINUSE 的可能**，也不需要 SO_REUSEPORT 的内核分发（SO_REUSEPORT 的连接分布不均匀是已知问题）。

对 AI Agent 这类「一个进程要开 N 个子进程各自监听本地端口做 RPC」的场景，这个模式比「子进程自己抢端口 + 重试」干净一个量级。

---

## 8. 其余值得记住的改动

### 8.1 `sqlite: bind undefined to NULL`

```js
const stmt = db.prepare('INSERT INTO t(k, v) VALUES (?, ?)');
stmt.run({ k: 1 });               // v 省略 → 绑定 NULL（一直如此）
stmt.run({ k: 2, v: undefined }); // ❌ 之前：ERR_INVALID_ARG_TYPE
                               // ✅ 26.10：也绑 NULL
```

修复的是一个**自相矛盾**：省略参数和显式传 `undefined` 在语义上应该是同一件事，但之前一个绑 NULL 一个报错。这个不一致会让「从对象动态构造参数」的代码在遇到 `undefined` 值时随机崩溃。

值得注意的是这个修复的来源——PR 描述里写：

> This PR re-implements #62008 by @mike-git374. The one-line behavior change is theirs; this PR adds the documentation and the remaining test coverage.

**一行行为改动 + 一堆文档和测试**。这是开源协作里最被低估的价值类型：原始作者贡献了洞察，后续贡献者把它补成生产可用的东西。

### 8.2 `fs.openAsBlobSync`

`fs.openAsBlob()` 的同步版本。把文件直接映射成 `Blob`，不经 Buffer 中转——对「读一个大文件直接喂给 `fetch` body」这类场景省一次拷贝。

### 8.3 `crypto`：RSA-PSS 与 provider 对齐

一批让 crypto 走 OpenSSL 3 provider 抽象的改动（从 provider 读 RSA-PSS 限制、用 provider 的 EC group 名、PKCS#1 走 provider 解码、密钥派生走 EVP_KDF）。**用户不可见，但它是 Node 能跟上 OpenSSL 4.x 的前置条件**——provider 化之后，算法实现在 OpenSSL 侧的迁移（比如默认 provider 策略变化）就不会再让 Node 的行为出现意外断裂。

### 8.4 benchmark 工具链

`--csv` 选项加到 `compare.js`（配合 `--analyze`）。Node 自己的基准对比终于能直接导 CSV 进外部工具分析了——对做性能回归监控的人是个实用改进。

---

## 9. 5 套延迟分析方案 17 维度对比

| 维度 | SlidingWindowHistogram | OTel Histogram | Prometheus | R/Python 离线 | APM Agent (Datadog) |
|---|---|---|---|---|---|
| 1. 部署形态 | 进程内标准库 | SDK + Collector | Client lib + Server | 外部进程 | 常驻 Agent |
| 2. 额外依赖 | 0 | otel SDK | prom-client | R / pandas | dd-trace |
| 3. 窗口语义 | 分块滑动 | 累积 / 可配 | 累积（counter） | 看你导什么 | 可配 |
| 4. 桶模型 | HDR（figures 1-5） | explicit buckets | explicit buckets | 原始样本或桶 | HDR |
| 5. record 热路径开销 | O(1)，Fast API Call | 序列化开销 | 序列化开销 | 0（导出时才算） | 每请求 hook |
| 6. 查询延迟（本地 p99） | 微秒级（snapshot） | 需导出后查 | 需 PromQL 查询 | 分钟级（进程启动+IO） | 秒级（网络往返） |
| 7. 密度估计（形状分析） | 内置 QRDE 150-325x | 无 | `histogram_quantile` 点估计 | 完整支持 | 有限 |
| 8. 尾部精度 (p99.9+) | figures 可到 5 位 | 桶边界固定 | 桶边界固定 | 取决于样本 | figures 可配 |
| 9. 内存可控性 | chunks×figures 精确界 | SDK 决定 | | 样本数组 | Agent 决定 |
| 10. 是否离开进程 | 否 | 是 | 是 | 是 | 是 |
| 11. 长期存储 | 无（自管理） | 有 | 有 | 有 | 有 |
| 12. 多语言一致 | 仅 Node | 11+ 语言 | 任意 | 任意 | 任意 |
| 13. 采样支持 | 无（全量） | 有 | 无 | | 有 |
| 14. 自适应限流可用性 | 极高（微秒级本地查询） | 中（需导出链路） | 低（查询延迟高） | 不可用 | 中 |
| 15. 学习成本 | 低（单 API） | 中（语义约定多） | 中（PromQL） | 高 | 低 |
| 16. 锁/竞争 | 无（单线程环） | | | | Agent 自身开销 |
| 17. 版本要求 | Node ≥ 26.10 | 任意 Node | 任意 | 任意 | 任意 |

**选型结论**：
- 需要**本地实时决策**（限流、熔断、自适应并发）→ SlidingWindowHistogram，没有替代品，别的方案查询延迟都太高
- 需要**跨服务全局观测** → OTel，标准化的语义约定让多语言聚合有意义
- 需要**长留存 + 历史对比** → Prometheus
- 需要**深度形状分析 / 画图给老板看** → QRDE（在进程内就能出密度数组，比导出去再算快两个数量级），或导出原始样本给离线工具
- **不要**为了「能查 p99」就引一个常驻 APM Agent——它的每请求 hook 开销本身会移动你要测的那个分布

---

## 10. 6 条 6-12 个月可验证硬指标

这些是今天就能跑代码复现的、有明确数字的判断：

1. **`SlidingWindowHistogram.record()` 的摊销开销**：在 10^7 次 record 下，`chunks: 6` 时间窗口的 record 总时间应比同等样本量的 userland「数组 push + 定时排序」方案低 **2 个数量级以上**（数组方案在 10^7 样本时排序是瓶颈）。验证方式：`benchmark/perf_hooks/histogram-sliding-window-snapshot.js` 已在 Node 仓库内，直接 `node --run benchmark` 可跑。

2. **`snapshot()` 成本线性于 chunks**：`chunks: 2` vs `chunks: 1024`，在相同样本量下 snapshot 时间应近似线性增长（每次 Add 一个分块）。**若出现超线性，说明合并路径有 bug**——这是一个值得长期盯的回归点。

3. **QRDE 相对 Rscript 的 150-325x**：PR 作者给的基线是 100 万样本 / 1000 bins。用 `histogram.qrde({ bins: 1000 })` 对同样数据，把 histogram 的 `export()` 结果导成 CSV 给 R 脚本（仓库里的 `test/fixtures/qrde-r-oracle.R` 就是干这个的，且被用来做**结果对齐测试**——Node 的 QRDE 输出跟 R 的 `hdquantile` 结果在容差内一致）。这是「快 150 倍且结果一样」的双向验证。

4. **QRDE 临时内存峰值**：`figures: 3`、全桶占用时峰值约 1.7 MiB；`figures: 5` 时约 185 MiB。**在容器内存限制 512 MiB 的环境里，`figures: 5` 的 QRDE 有 OOM 风险**——这是一个可以直接复现的容量约束。

5. **util.throttle 严格模式开销**：`strict: true` 在 10^5 次/秒调用率下，额外 bookkeeping 应使单次调用开销增加可测量的百分比（具体数取决于平台，但应远小于 fn 本身的耗时）。若你的 fn 本身是微秒级的纯计算，throttle 的开销才可能成为瓶颈——**对任何 I/O 调用，throttle 开销可忽略**。

6. **`ERR_THROTTLED` 不触发 unhandledRejection**：`overflow: 'drop'` 下创建一个被拒绝的 promise 但不 catch，监听 `process.on('unhandledRejection')` 应**零触发**；对同一个 promise 调 `.catch()` 应能读到 `code === 'ERR_THROTTLED'`。这是一个可以写进单元测试的断言。

---

## 11. 6 条 6-12 个月可观察的未来信号

这些是趋势判断，看接下来半年行业是否朝这个方向走：

1. **`util.throttle` / `util.debounce` 落地后，lodash 的这两个函数在新项目里的引用率会明显下降**。但**不会快速消失**——存量代码的迁移是十年为单位的事。真正的信号是：新项目的 `package.json` 里 `lodash.debounce` 出现频率。

2. **perf_hooks 会继续补统计原语**。QRDE 之后，大概率会出现「cohort 分析」「百分位漂移检测」「SLO burn rate」这类更高阶的内置计算。James M Snell 在这一版一个人推了 4 个 perf_hooks 相关 PR（QRDE、SlidingWindow、markPromiseAsHandled、benchmark 工具），**这是一个明确的个人方向信号**。

3. **标准库「收编 userland」会加速，且目标会指向 AI 场景**。这一版收编的是流控和统计，下一批最可能被收编的是：**AI 调用的重试/超时/成本预算控制**（现在每个项目都用 LangChain / AI SDK 的 wrapper 自己写一遍）。`util.throttle` 的 `signal` + `pendingCount` + `overflow: 'drop'` 已经具备了「token 预算限流」所需的所有原语。

4. **`node:ffi` + SEA + VFS 会成为桌面/边缘 AI 应用的标配打包方式**。本地推理需要调 ONNX Runtime / CoreML / CUDA 的原生库，而 SEA 单文件分发要求所有东西都在二进制里。这条路径在 26.10 才第一次完整。

5. **QRDE 这类「把分析能力做进运行时」的模式会被其他运行时模仿**。Deno 和 Bun 在「标准库覆盖度」上一直跟 Node 竞争。Node 把统计原语做深，Deno/Bun 大概率会在接下来半年补类似的东西（或者直接说明「用 OTel」）。

6. **`util.markPromiseAsHandled` 会被框架广泛采用**。任何做「丢弃式限流」「事件去重」「可选 await」的框架都需要它。注意它的反面：**滥用它会让真正的未处理拒绝被静默吞掉**——这本身会成为一个新的可观测性陷阱。

---

## 12. 5 步生产落地 checklist

### ✅ 该做

1. **先用 `createSlidingWindowHistogram` 替换自研的延迟窗口**。从 `chunks: 6, chunkDuration: 1000`（6 秒窗口）开始，`figures: 3`（默认）别动。snapshot 只在**非请求路径**（定时器、指标端点）调用。这一步零风险，且立刻能拿到「最近 6 秒 p99」做自适应决策。

2. **QRDE 用于排障，不用用于监控**。出问题时，把最近 1 分钟的 histogram `qrde({ bins: 50, dequantize: 'hdr' })` 拿出来看密度形状找双峰和尾部尖峰。日常监控继续用点估计（p50/p95/p99）——密度图对告警系统不友好，但对人眼友好。

3. **`util.throttle` 用 `overflow: 'drop'` + `ERR_THROTTLED` 判断做背压**。入口处 `if (!t.hasImmediateCapacity()) return 429` 比让请求排队更诚实，且不会把超时传播给客户端。

4. **`crypto.parsePKCS12` 一上线就先过一遍 passphrase 的 NUL 检查**。虽然 Node 内部已经挡了，但你的代码如果从环境变量读密码，最好自己确认没有截断风险——**这是密码学代码里唯一「多检查一遍不亏」的地方**。

5. **SEA + ffi 的迁移先在内部工具上试**。VFS 路径的 `dlopen` 行为跟磁盘路径不同（错误信息、`lib.path` 语义），先用不关键的 CLI 工具跑通，再上核心产品。

### ❌ 千万别做

1. **不要在每请求里调 `snapshot()` 或 `qrde()`**。snapshot 物化 N 个直方图，qrde 跑线程池任务 + 分配临时内存。它们属于「秒级 / 分钟级」调用频率。

2. **不要把 `figures` 调到 5 换「精度」**。内存 ×8（352 KiB → 37 MiB 单块），且 QRDE 峰值内存到 185 MiB。99.9% 的场景 `figures: 3`（3 位有效数字，微秒级区分度）足够。

3. **不要假设 sliding window 的边界是精确的**。它是 chunk 级精度。如果你在写一个依赖「恰好 60.000 秒窗口」的一致性校验逻辑，它一定会偶发失败。

4. **不要给 `util.throttle` 的排队 promise 不加超时就无限等**。`overflow: 'queue'` + `maxPending: Infinity` 是默认配置，这意味着过载时请求会无限堆积直到内存爆。**一定要设 `maxPending`**，并且配合外层 `AbortSignal.timeout()`。

5. **不要跨线程传 SlidingWindowHistogram 本身**（会 throw）。要跨线程，传 `snapshot()` 返回的**普通 Histogram** 的 `export()` 结果（一个纯 JSON SerializableRecord），在另一侧 `perf_hooks.importHistogram()` 重建。

### 5 条最佳实践

| # | 实践 | 原因 |
|---|---|---|
| 1 | record 纳秒，展示再除 1e6 | perf_hooks 全栈纳秒；混用毫秒会让数字差 6 个数量级且不报错 |
| 2 | `lowest`/`highest` 压到业务真实范围 | 桶数 = log 范围 × figures，压缩范围直接降内存 |
| 3 | throttle 的 timer 记得 `unref()` | 否则一个排队请求就能让进程/Lambda 不退出 |
| 4 | `ERR_THROTTLED` 的 catch 里返回 429 + Retry-After | 客户端可以退避；静默重试只会放大过载 |
| 5 | QRDE 的 `corrections` 字段大于 0 时警惕 | 它计数被钳位的非单调浮点结果；持续 >0 说明数值精度在退化 |

---

## 13. 写在最后：平台运行时的「收编阶段」

把 Node 26.10 的 9 个 SEMVER-MINOR 摊开看，会发现一个共同形状：**它们全都不是「新能力」，而是「把生态已经证明需要的通用能力，从 userland 搬进运行时」**。

- lodash.debounce / p-limit / bottleneck → `util.debounce` / `util.throttle`
- hdr-histogram-js + 自研轮换 → `SlidingWindowHistogram`
- R / Python 的密度估计 → `qrde()`
- node-forge / openssl CLI → `crypto.parsePKCS12`
- 手动拆 .so 部署 → `ffi.dlopen` VFS 透明加载
- SO_REUSEPORT 或端口竞争 → `BoundSocket` transfer

这个模式有一个名字，叫**平台成熟期的「收编阶段」**。一个运行时的生命周期大致是：**能力爆发期（什么都在 userland 长出来）→ 沉淀期（通用模式被识别）→ 收编期（进标准库）→ 平台期（标准库即最佳实践）**。Node 在 v24-v26 这三年明显进入了第三阶段。

对工程师个人的含义很具体：**你的「精通 lodash」不再是资产，你的「知道哪些 userland 方案该被标准库替换」才是**。每一次运行时收编，都把一类「会用某个库」的竞争力，贬值成「会读文档」。

但对系统整体，这是好事。当防抖、限流、尾延迟测量、身份加载都变成 `require('node:...')` 就能拿到的东西时，**「可观测性」和「健壮性」从「这个团队有没有钱买 APM / 有没有人懂」变成了「这段代码写得好不好」**。Node 26.10 让一个只有三个人的创业团队，也能拥有 10 万 QPS 服务该有的延迟自省能力——不用装 Agent，不用引依赖，不用学 PromQL。

这是我对这一版最高的一条评价：**它降低的不是技术门槛，是「体面」的门槛。**

至于风险，只有一个值得记住的：`util.markPromiseAsHandled` 这类「静默化」API 是有代价的——**它让「被丢弃的请求」不再大喊大叫**。设计上它是对的（否则监控会被刷爆），但它把「过载」这个信号从「显式错误」变成了「需要你主动去查 `pendingCount` 和 `activeCount`」。**限流做得越优雅，越要记得配一个主动的过载指标采集**，不然你会得到一个 p99 完美、吞吐量却悄悄掉了一半的系统，而你还查不出为什么。
