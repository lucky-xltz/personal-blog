---
title: "当空闲不是空闲：一个Linux内核优化如何让QUIC陷入拥塞死亡螺旋"
date: 2026-05-13
category: 技术
tags: [QUIC, 拥塞控制, CUBIC, Linux内核, 网络协议, Cloudflare, 性能优化]
author: 林小白
readtime: 15
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
---

# 当空闲不是空闲：一个Linux内核优化如何让QUIC陷入拥塞死亡螺旋

网络协议栈中，拥塞控制算法（CCA）是最关键的组件之一——它决定了数据在网络中流动的速率，直接影响吞吐量和延迟。CUBIC 作为 Linux 内核的默认拥塞控制器，标准化于 RFC 9438，管理着互联网上绝大多数 TCP 和 QUIC 连接。

最近，Cloudflare 的工程师在他们的开源 QUIC 实现 quiche 中发现了一个令人着迷的 bug：**CUBIC 的拥塞窗口（cwnd）被永久锁定在最小值，永远无法从拥塞崩溃中恢复**。这个 bug 的根源可以追溯到 2017 年 Linux 内核的一个"正确"优化——当这个优化被移植到用户空间的 QUIC 实现时，引发了一场意想不到的"死亡螺旋"。

本文将深入分析这个 bug 的完整故事：从拥塞控制的基础原理，到内核优化的移植陷阱，再到那个优雅的近单行修复。

## 拥塞控制基础：两个踏板的博弈

在深入 bug 之前，有必要回顾拥塞控制的核心概念。

### 什么是拥塞窗口（cwnd）

拥塞窗口是发送端对"在途字节数"（bytes in flight，已发送但未确认的数据量）的上限。一个更大的 cwnd 允许发送端在每个往返时间（RTT）内注入更多数据；更小的 cwnd 则限制发送速率。

```
发送端                           接收端
  │                                │
  │── 数据包 1,2,3 ──────────────▶│
  │                                │
  │◀────────────── ACK 1,2,3 ─────│
  │                                │
  │── 数据包 4,5,6 ──────────────▶│  ← cwnd 决定每轮能发多少
  │                                │
```

### 损失型算法的两个踏板

所有基于丢包的拥塞控制算法（包括 CUBIC 和 Reno）都遵循一个基本逻辑：

1. **油门（没有丢包 → 增速）**：如果网络看起来健康（没有丢包），就增加发送速率，提高带宽利用率
2. **刹车（检测到丢包 → 减速）**：如果发生丢包，说明网络容量已超限，发送端必须退让

CUBIC 相比 Reno 的改进在于它的增长曲线是一个三次函数（cubic function），而非线性增长。这使得 CUBIC 在高带宽-高延迟（BDP）网络中能更快地探测到可用带宽：

```rust
// CUBIC 的核心增长函数（简化）
// W_cubic(t) = C * (t - K)^3 + W_max
// 其中：
//   t = 当前时间 - epoch_start（自上次丢包以来的时间）
//   K = 三次函数的拐点 = cbrt(W_max * beta / C)
//   W_max = 丢包前的最大窗口
//   C = 缩放常数（默认 0.4）
//   beta = 乘法减少因子（默认 0.7）
```

### epoch：CUBIC 的时间锚点

CUBIC 的增长函数 `W_cubic(Δt)` 依赖于时间差 `Δt = now - epoch_start`。epoch 是 CUBIC 用来锚定其增长曲线的参考时间戳——每当发生丢包事件并减小 cwnd 时，epoch 会被重置。

```
cwnd
 ▲
 │        丢包！        丢包！
 │         │             │
 │    ╱╲   │       ╱╲    │
 │   ╱  ╲  │      ╱  ╲   │
 │  ╱    ╲ │     ╱    ╲  │
 │ ╱      ╲│    ╱      ╲ │
 │╱        ╲   ╱        ╲│
 ├──────────────────────────▶ 时间
    epoch₁     epoch₂
```

## 问题的起源：空闲期优化

### 2017 年的内核问题

2017 年，Linux 内核社区发现了一个问题：当应用进入空闲状态（停止发送数据）一段时间后恢复时，CUBIC 的增长函数会计算出一个巨大的 `Δt`。

这是因为 epoch 在空闲期间没有被更新。当应用恢复发送时，`Δt = now - epoch_start` 可能是一个非常大的值，导致 `W_cubic(Δt)` 计算出一个不合理的巨大目标窗口——CUBIC 会试图立即将 cwnd 膨胀到一个荒谬的值。

commit 消息解释道：

> The epoch is only updated/reset initially and when experiencing losses. The delta "t" of now - epoch_start can be arbitrary large after app idle as well as the bic_target. Consequentially the slope (inverse of ca->cnt) would be really large...

### 最初的修复尝试

Jana Iyengar 提出了一个看似合理的修复：当应用恢复发送时重置 `epoch_start`。但 Neal Cardwell 指出了这个方案的缺陷：

> ...it would ask the CUBIC algorithm to recalculate the curve so that we again start growing steeply upward from where cwnd is now (as CUBIC does just after a loss). Ideally we'd want the cwnd growth curve to be the same shape, just shifted later in time by the amount of the idle period.

### 优雅的解决方案

Eric Dumazet、Yuchung Cheng 和 Neal Cardwell 提出了一个优雅的方案：**不重置 epoch，而是将其向前平移空闲时长**。这保持了 CUBIC 增长曲线的形状，只是在时间轴上滑动，让算法从上次中断的地方继续：

```c
// Linux 内核中的实现（简化）
// 在 CA_EVENT_TX_START 回调中
delta = now - last_sent_time;
epoch_start += delta;  // 向前平移，而非重置
```

这个修复是正确的——至少在 TCP 的内核实现中是这样。

## QUIC 的移植陷阱

### TCP 与 QUIC 的关键差异

当 CUBIC 被移植到 quiche（Cloudflare 的用户空间 QUIC 实现）时，这个空闲期优化也被移植了过去。但这里存在一个关键的架构差异：

| 特性 | TCP | QUIC (quiche) |
|------|-----|---------------|
| 运行位置 | 内核空间 | 用户空间 |
| 空闲检测回调 | `CA_EVENT_TX_START` | 在 `on_packet_sent()` 中检查 |
| 时间测量精度 | 内核调度器级别 | 用户空间定时器 |

TCP 在内核中有专门的 `CA_EVENT_TX_START` 回调，可以精确地在应用恢复发送时触发。而 QUIC 在用户空间运行，没有这样的内核级回调。quiche 的实现是在 `on_packet_sent()` 中检查 `bytes_in_flight == 0` 来判断连接是否"空闲"：

```rust
// quiche 的 cubic.rs — on_packet_sent()（简化）
fn on_packet_sent(&mut self, bytes_in_flight: usize, now: Instant) {
    // 如果发送突发重新开始（即 bytes_in_flight 在此发送前为零），
    // 调整拥塞恢复开始时间以考虑发送间隙。
    if bytes_in_flight == 0 {
        let delta = now - self.last_sent_time;
        self.congestion_recovery_start_time += delta;
    }
    self.last_sent_time = now;
}
```

### 隐藏的 bug

问题在于，这个移植遗漏了内核后续的一个修复。内核的第二次修复（在首次修复后约一周）指出：

> tcp_cubic: do not set epoch_start in the future
> Tracking idle time in bictcp_cwnd_event() is imprecise, as epoch_start is normally set at ACK processing time, not at send time.

关键洞察：**`epoch_start` 是在 ACK 处理时设置的，而空闲期的调整是基于发送时间计算的**。这种时间基准的不匹配可以将 `recovery_start_time` 推到未来。

## 死亡螺旋：当优化变成诅咒

### 测试场景

Cloudflare 的测试设置如下：

```
客户端 ←── quiche HTTP/3 ──→ 服务器（localhost）
RTT = 10ms
下载 10MB 文件
前 2 秒注入 30% 随机丢包
2 秒后丢包完全停止
超时：10 秒
```

预期行为：CUBIC 在丢包阶段受挫，减小 cwnd；丢包停止后，稳定地恢复并在超时前完成下载。

实际结果：**约 60% 的测试在 10 秒超时内未能完成下载**。

### 振荡现象

通过 qlog 输出和可视化分析，工程师们观察到一个惊人的现象：

```
cwnd
 ▲
 │  正常增长
 │  ╱╲
 │ ╱  ╲
 │╱    ╲
 ├────────────────────────────────▶ 时间
 │        │                    │
 │    丢包开始              丢包停止
 │        │                    │
 │        ▼                    │
 │    ┌────────────────────────┐
 │    │ cwnd 锁定在最小值 2700B │ ← 死亡螺旋
 │    │ 每 ~14ms 振荡一次      │
 │    └────────────────────────┘
```

在丢包停止后的整个期间（约 6.7 秒），CUBIC 在恢复状态和拥塞避免状态之间进行了 **999 次转换**——每 ~14ms 一次，恰好匹配连接的 RTT（10ms）。cwnd 被锁定在最小值：2700 字节，即两个满载数据包。

### 死亡螺旋的机制

这个 bug 在最小 cwnd 下形成了一个**自我强化的循环陷阱**：

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│  1. 发送：发送端发出整个两包窗口                      │
│     │                                               │
│     ▼                                               │
│  2. 接收 ACK：~14ms 后两个包被确认                    │
│     bytes_in_flight 降至 0                           │
│     │                                               │
│     ▼                                               │
│  3. 错误的空闲检测：发送下一批数据时                   │
│     on_packet_sent() 看到 bytes_in_flight == 0       │
│     误判连接处于"空闲"状态                            │
│     │                                               │
│     ▼                                               │
│  4. 膨胀的 delta：delta = now - last_sent_time       │
│     ≈ 14ms（整个 RTT），而非真正的空闲时间（≈0）       │
│     │                                               │
│     ▼                                               │
│  5. recovery_start_time 被推到未来                   │
│     │                                               │
│     ▼                                               │
│  6. 每个 ACK 都被认为处于"恢复期"                     │
│     CUBIC 跳过 cwnd 增长                             │
│     │                                               │
│     ▼                                               │
│  7. cwnd 维持在最小值 ──────────────────┐            │
│     │                                  │            │
│     └──────────────────────────────────┘            │
│                    循环重复                          │
└─────────────────────────────────────────────────────┘
```

### 为什么连接启动时不会触发？

你可能会问：如果 `bytes_in_flight == 0` 在连接启动时也为真，为什么那时候不会触发这个 bug？

答案是：在慢启动阶段（slow start），`congestion_recovery_start_time` 尚未被设置——因为还没有发生过丢包事件。只有当连接退出慢启动并进入拥塞避免阶段后，这个陷阱才会被激活。触发需要三个条件同时满足：

1. **真实的丢包事件**设置了恢复边界
2. **拥塞避免阶段**正在运行（而非慢启动）
3. **cwnd 崩溃到最小值**（两包），使得每个 ACK 周期都清空 `bytes_in_flight`

### 为什么 Reno 不受影响？

为了验证这是 CUBIC 特有的问题，工程师们用 Reno（另一种损失型算法，但有不同的增长策略）运行了相同的测试。结果：**100% 通过率**，Reno 在丢包阶段结束后干净地恢复了。

这是因为 Reno 使用线性增长（每个 RTT 增加一个 MSS），而 CUBIC 的三次函数增长对 `epoch_start` 的时间偏移极其敏感。当 `recovery_start_time` 被推到未来时，CUBIC 的 `in_congestion_recovery()` 检查会持续返回 true，阻止任何窗口增长。

## 修复：测量正确的空闲起点

### 核心洞察

修复的关键在于**从正确的起点测量空闲时长**。原来使用 `last_sent_time`（上次发送时间），但正确的起点应该是 `last_ack_time`（上次收到 ACK 的时间），因为这才是 `bytes_in_flight` 真正变为零的时刻。

### 代码修复

```rust
// cubic.rs — on_packet_sent()（修复后）
fn on_packet_sent(&mut self, bytes_in_flight: usize, now: Instant) {
    if bytes_in_flight == 0 {
        if let Some(recovery_start_time) = self.congestion_recovery_start_time {
            // 从最近的活动时间测量空闲：使用 last_ack_time
            // （近似 bytes_in_flight 变为零的时刻）和 last_sent_time
            // 中的较大者。仅使用 last_sent_time 会在 cwnd 较小
            // 且 bytes_in_flight 在 ACK 和发送之间短暂归零时
            // 将 delta 膨胀一个完整的 RTT。
            let idle_start = cmp::max(self.last_ack_time, self.last_sent_time);

            if let Some(idle_start) = idle_start {
                if idle_start < now {
                    let delta = now - idle_start;
                    self.congestion_recovery_start_time =
                        Some(recovery_start_time + delta);
                }
            }
        }
    }
    self.last_sent_time = now;
}
```

### 修复效果

修复前后的行为对比：

```
修复前：recovery_start_time 每个 RTT 周期前进 ~14ms
        → 永远追上或超过下一个发送时间
        → cwnd 永久锁定

修复后：recovery_start_time 几乎不动
        → 下一个发送时间超过它
        → cwnd 正常增长
```

对于真正空闲的连接，`last_ack_time` 和 `last_sent_time` 的差异可以忽略不计，所以这个修复不会影响正常场景。

## 技术启示

### 1. 内核代码到用户空间的移植陷阱

这个 bug 最深刻的教训是：**将内核代码移植到用户空间时，不能假设两者有相同的事件时序模型**。TCP 在内核中有精确的事件回调（`CA_EVENT_TX_START`、`CA_EVENT_TX_RESTART` 等），而用户空间的 QUIC 实现只能通过状态检查来推断这些事件。

### 2. 时间基准的一致性

拥塞控制算法中，不同变量的时间基准（发送时间 vs ACK 时间 vs 事件时间）必须保持一致。混合使用不同的时间基准会导致微妙的计算错误，在特定条件下被放大。

### 3. 边界条件的测试价值

大多数拥塞控制测试覆盖的是稳态和增长阶段。很少有测试专门驱动 CCA 进入最小 cwnd 状态并观察其恢复能力。这正是 bug 藏身之处。**恢复能力测试应该成为 CCA 测试套件的标准组成部分**。

### 4. 规范与实现的鸿沟

RFC 9438 §4.2-12 描述了 app-limited 排除行为，但规范无法涵盖所有实现细节。将规范行为移植到不同的运行时环境时，必须重新审视所有隐含的假设。

## 对你的网络应用意味着什么

如果你在使用基于 QUIC 的服务（HTTP/3），这个 bug 的影响范围取决于：

1. **你的 QUIC 实现**：使用 quiche 的服务（如 Cloudflare CDN）可能受到影响。其他实现（如 quic-go、msquic）可能有不同的行为
2. **网络条件**：只有在高丢包场景下才会触发——这是 CDN 在边缘网络经常遇到的情况
3. **修复状态**：Cloudflare 已在 quiche 中修复此问题

对于大多数开发者来说，这个故事的价值不在于直接的行动建议，而在于它揭示的**系统思维**：

- 即使是"正确"的优化，在不同的上下文中也可能变成 bug
- 协议栈的每一层都有隐含的时序假设
- 边界条件（最小窗口、最大 RTT、空闲连接）是最容易出问题的地方

## 总结

这个 bug 的故事展示了一个经典的工程困境：一个在原始上下文中完全正确的优化（Linux 内核的 CUBIC 空闲期处理），被移植到新的上下文（用户空间 QUIC）后，因为隐含的时序假设不再成立，而产生了灾难性的后果。

最终的修复几乎是单行代码的改动——但它背后需要对拥塞控制算法、内核与用户空间的事件模型差异、以及 QUIC 协议的状态机有深入的理解。这正是系统编程的魅力所在：**最小的改动，最深的理解**。

---

*相关阅读：*

- [WebGPU：下一代浏览器图形与计算](/article/webgpu-next-gen-web-graphics-compute-2026)
- [AI 漏洞挖掘的现实：从 Mythos 到 curl 与 Firefox](/article/ai-vulnerability-hunting-mythos-curl-firefox-2026)
- [Bun 的 Zig 到 Rust 迁移之路](/article/bun-zig-to-rust-porting-2026)
