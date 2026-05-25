---
title: "io_uring：Linux I/O 的范式革命——从系统调用地狱到零拷贝的进化之路"
date: 2026-05-25
category: 技术
tags: [io_uring, Linux, 系统编程, 性能优化, 内核, Rust, 网络编程]
author: 林小白
readtime: 15
cover: https://images.unsplash.com/photo-1629654297299-c8506221ca97?w=600&h=400&fit=crop
---

# io_uring：Linux I/O 的范式革命

> 每一次系统调用都是一次用户态到内核态的上下文切换。当你的服务器每秒处理 100 万个请求时，这 100 万次切换本身就是巨大的开销。io_uring 的出现，不是优化了这个过程——而是从根本上消除了它。

2019 年，Jens Axboe 在 Linux 5.1 中合入了一个看似不起眼的补丁。七年后，io_uring 已经从一个实验性接口成长为 Linux 高性能 I/O 的事实标准。从数据库到 Web 服务器，从存储引擎到网络代理，几乎所有追求极致吞吐的系统都在向它靠拢。

但 io_uring 的故事不只是"更快"那么简单。它代表了一种设计哲学的根本转变：**与其优化系统调用的路径，不如消灭系统调用本身**。

## 传统 I/O 模型的三重困境

要理解 io_uring 为什么是革命性的，先得看清传统模型的天花板。

### 第一代：阻塞 I/O

最原始的模型——`read()` 和 `write()`。调用时线程阻塞，直到数据就绪。

```c
// 朴素但致命：一个连接占一个线程
char buf[4096];
int n = read(fd, buf, sizeof(buf));  // 线程在此挂起
process(buf, n);
write(fd, response, resp_len);       // 再次挂起
```

问题显而易见：C10K 问题——10000 个连接需要 10000 个线程。每个线程的栈空间、上下文切换成本让服务器在连接数增长时急剧恶化。

### 第二代：事件驱动（epoll）

`epoll` 的出现让一个线程可以管理成千上万的连接：

```c
int epfd = epoll_create1(0);
struct epoll_event ev = { .events = EPOLLIN, .data.fd = client_fd };
epoll_ctl(epfd, EPOLL_CTL_ADD, client_fd, &ev);

// 一个线程处理所有连接
struct epoll_event events[MAX_EVENTS];
while (1) {
    int n = epoll_wait(epfd, events, MAX_EVENTS, -1);
    for (int i = 0; i < n; i++) {
        handle(events[i].data.fd);  // 仍需 read/write 系统调用
    }
}
```

进步明显：一个线程管理数万连接。但每个就绪事件仍需要至少一次 `read()` + 一次 `write()` 系统调用。百万 QPS 场景下，每秒 200 万次系统调用的开销依然是瓶颈。

更关键的是，epoll 本质上是"通知机制"——它告诉你"有数据了"，但实际的 I/O 操作（`read`/`write`）仍然是一次完整的系统调用。

### 第三代：异步 I/O（Linux AIO）

Linux 原生的 AIO 尝试解决这个问题：

```c
struct iocb cb = {
    .aio_fildes = fd,
    .aio_lio_opcode = IOCB_CMD_PREAD,
    .aio_buf = (uint64_t)buf,
    .aio_nbytes = 4096,
    .aio_offset = 0
};
io_submit(ctx, 1, &cb);    // 提交请求
io_getevents(ctx, 1, 1, ...);  // 等待完成
```

看起来不错？问题是 Linux AIO 的设计初衷是为 O_DIRECT 模式的块设备 I/O 优化的。对于网络 I/O、缓冲 I/O、甚至文件元数据操作，它要么不支持，要么退化为同步行为。更糟糕的是，它的接口设计复杂且不统一，`io_submit` 和 `io_getevents` 都是系统调用。

**三代 I/O 模型的共同困境：只要用户态和内核态之间存在边界，每次数据交互都是一次系统调用的代价。**

## io_uring 的核心设计：共享内存环形缓冲区

io_uring 的核心洞察极其简洁：**如果用户态和内核态共享同一块内存，那么数据交换就不需要系统调用了。**

它用两个环形缓冲区（ring buffer）实现这个想法：

```
┌─────────────────────────────────────────────────┐
│                   用户态进程                      │
│                                                   │
│  ┌─────────────┐         ┌─────────────┐         │
│  │ 提交队列 SQ  │ ──────> │ 完成队列 CQ  │         │
│  │ (Submission) │         │ (Completion) │         │
│  └──────┬──────┘         └──────▲──────┘         │
│         │                       │                 │
└─────────┼───────────────────────┼─────────────────┘
          │  共享内存 (mmap)       │
┌─────────┼───────────────────────┼─────────────────┐
│         ▼                       │    内核态        │
│  ┌─────────────┐         ┌─────┴───────┐         │
│  │  SQ 处理器   │ ──────> │  I/O 引擎    │         │
│  └─────────────┘         └─────────────┘         │
│                                                   │
└───────────────────────────────────────────────────┘
```

**提交队列（SQ, Submission Queue）**：用户态将 I/O 请求（读、写、accept、connect 等）写入 SQ。这是个环形缓冲区，用户态只需要往里写数据，不需要系统调用。

**完成队列（CQ, Completion Queue）**：内核完成 I/O 后，将结果写入 CQ。同样是环形缓冲区，用户态只需要从中读取结果。

关键机制：用户态通过 `io_uring_enter()` 系统调用通知内核"SQ 里有新请求了"。但这个调用可以**批量提交**——一次系统调用通知内核处理 N 个请求。

```c
// 提交 100 个 I/O 请求，只需 1 次系统调用
for (int i = 0; i < 100; i++) {
    struct io_uring_sqe *sqe = io_uring_get_sqe(&ring);
    io_uring_prep_read(sqe, fds[i], bufs[i], 4096, 0);
}
io_uring_submit(&ring);  // 1 次系统调用提交 100 个请求
```

## SQE 与 CQE：I/O 操作的最小单元

每个提交的 I/O 请求封装在一个 **SQE（Submission Queue Entry）** 中：

```c
struct io_uring_sqe {
    __u8  opcode;      // 操作类型：IORING_OP_READ, IORING_OP_WRITE, ...
    __u8  flags;       // 标志位
    __u16 ioprio;      // I/O 优先级
    __s32 fd;          // 文件描述符
    __u64 off;         // 偏移量
    __u64 addr;        // 缓冲区地址
    __u32 len;         // 数据长度
    __u64 user_data;   // 用户自定义数据（用于关联请求和响应）
    // ... 更多字段
};
```

内核完成 I/O 后，在 CQ 中放置一个 **CQE（Completion Queue Entry）**：

```c
struct io_uring_cqe {
    __u64 user_data;   // 对应 SQE 的 user_data
    __s32 res;         // 结果（成功时为字节数，失败时为 -errno）
    __u32 flags;       // 完成标志
};
```

注意 `user_data` 字段——它是用户态和内核态之间的"票据"。你可以在 SQE 中设置任意 64 位值，内核会在对应的 CQE 中原样返回。这让你可以轻松关联请求和响应，无需维护额外的映射表。

## 为什么快：性能优势的三个来源

### 1. 批量提交：1 次系统调用替代 N 次

这是最直观的优势。epoll 模型下，每个 I/O 操作至少需要一次系统调用：

```
epoll 模型（100 个请求）:
  epoll_wait()     × 1  = 1 次系统调用
  read()           × 100 = 100 次
  write()          × 100 = 100 次
  总计：201 次系统调用

io_uring 模型（100 个请求）:
  io_uring_enter() × 1  = 1 次系统调用（提交 100 个 SQE）
  用户态轮询 CQ     × 0  = 0 次系统调用（直接读共享内存）
  总计：1 次系统调用
```

每次系统调用的开销约 100-200 纳秒（包括上下文切换、寄存器保存/恢复、内核路径执行）。在百万 QPS 场景下，这个差异是数量级的。

### 2. 用户态轮询（SQPOLL）：彻底消灭系统调用

io_uring 支持一种更激进的模式——**SQPOLL**：

```c
struct io_uring_params params = {
    .flags = IORING_SETUP_SQPOLL,
    .sq_thread_idle = 2000  // 空闲 2 秒后内核线程休眠
};
io_uring_queue_init_params(depth, &ring, &params);
```

在这种模式下，内核会创建一个专用的轮询线程，持续检查 SQ 中是否有新请求。用户态只需要往 SQ 里写数据，连 `io_uring_enter()` 都不需要调用。

**代价**：一个 CPU 核心被内核轮询线程持续占用。但在高吞吐场景下（数据库、存储引擎），用一个核心换来零系统调用的延迟，通常是值得的。

### 3. 注册缓冲区：减少页面映射开销

io_uring 支持预先注册 I/O 缓冲区：

```c
struct iovec iovecs[NUM_BUFFERS];
for (int i = 0; i < NUM_BUFFERS; i++) {
    iovecs[i].iov_base = aligned_alloc(4096, BUFFER_SIZE);
    iovecs[i].iov_len = BUFFER_SIZE;
}
io_uring_register_buffers(&ring, iovecs, NUM_BUFFERS);
```

注册后，内核预先完成这些缓冲区的页面映射。后续 I/O 操作使用注册缓冲区时，内核无需重复执行 `get_user_pages()` —— 这在高频 I/O 场景下节省了大量页表操作。

## 实战：io_uring + kTLS + Rust = 零系统调用 HTTPS 服务器

2025 年，一位开发者用 Rust 构建了一个实验性的 HTTPS 服务器，实现了几乎零系统调用的数据路径。这个项目展示了 io_uring 的终极形态。

### kTLS：内核态 TLS 终止

TLS 加密/解密通常在用户态完成（如 OpenSSL）。但 Linux 4.13 引入了 **kTLS**——将 TLS 记录层的处理移入内核：

```c
// 设置 kTLS
struct tls12_crypto_info_aes_gcm_128 crypto_info = {
    .info.version = TLS_1_2_VERSION,
    .info.cipher_type = TLS_CIPHER_AES_GCM_128,
};
memcpy(crypto_info.key, derived_key, TLS_CIPHER_AES_GCM_128_KEY_SIZE);
setsockopt(fd, SOL_TCP, TCP_ULP, "tls", sizeof("tls"));
setsockopt(fd, SOL_TLS, TLS_TX, &crypto_info, sizeof(crypto_info));
```

一旦 kTLS 启用，`sendfile()` 可以直接将文件数据通过 TLS 加密后发送到 socket——数据从磁盘到网卡，**全程不经过用户态**。

### 终极组合：io_uring + kTLS

当 io_uring 遇上 kTLS，魔法发生了：

1. 用户态将 HTTP 响应数据写入预注册的缓冲区
2. 通过 io_uring SQ 提交 `IORING_OP_SEND` 请求
3. 内核直接从缓冲区读取数据，通过 kTLS 加密，发送到 socket
4. CQE 通知用户态完成

整个过程不需要用户态进行 TLS 加密、不需要 `send()` 系统调用、不需要数据在用户态和内核态之间复制。

### Rust 中的挑战

用 Rust 封装 io_uring 并不容易。io_uring 的生命周期管理与 Rust 的借用检查器存在根本冲突：

```rust
// 提交写操作时，缓冲区必须在内核完成前保持有效
let buf = vec![0u8; 4096];
fill_data(&mut buf);
let sqe = ring.get_sqe();
sqe.prep_write(fd, &buf, 0);
ring.submit();

// 危险：buf 可能在内核使用时被 drop！
// Rust 的借用检查器无法追踪这种跨用户态/内核态的生命周期
// drop(buf);  // 如果这里 drop，内核会写入已释放的内存
```

`io_uring` crate 的作者 Alice Ryhl（Tokio 团队成员）曾指出，构建一个既安全又高效的 Rust io_uring 封装是一个"未解决的研究问题"。当前的解决方案要么放弃部分安全性保证，要么引入运行时检查的开销。

## io_uring vs mmap：数据说话

2025 年，Bitflux 的一篇基准测试文章颠覆了一个长期假设：**从 NVMe SSD 直接读取数据，可能比从内存缓存读取更快**。

测试配置：
- CPU：AMD EPYC 7551P（DDR4 2133 MHz，单线程内存带宽 ~13 GB/s）
- 存储：2 × Samsung PM983a NVMe SSD RAID0（带宽 ~6.2 GB/s）
- 数据集：50 GB（超过物理内存）

测试任务：从数据中统计特定值的出现次数（计算密集型 + 数据密集型）。

结果：

```
方法                          吞吐量        说明
─────────────────────────────────────────────────
mmap (缓存在内存中)            ~12 GB/s      接近内存带宽上限
io_uring 直接读 SSD            ~5.8 GB/s     接近 SSD 带宽上限
普通 read()                    ~3.2 GB/s     系统调用开销显著
```

关键发现：当数据集超过内存容量时，mmap 的页面换入换出（page fault + swap）会导致性能急剧下降。而 io_uring 的直接 I/O 模式绕过了页面缓存，性能更可预测。

这打破了"内存总是比磁盘快"的教条。在 NVMe SSD 带宽逼近 DDR4 延迟的时代，I/O 模型的选择比以往更加复杂。

## 安全阴影：ZCRX 漏洞的启示

2026 年 5 月，安全研究员 ze3tar 披露了一个 io_uring ZCRX（Zero-Copy Receive）接口的本地提权漏洞。攻击者只需控制一个 `u32` 类型的值，就能获得 root 权限。

漏洞的核心在于 io_uring 的零拷贝接收功能中的 freelist 管理缺陷。ZCRX 允许网络数据包直接 DMA 到用户态注册的缓冲区，绕过内核的网络栈。但 freelist 的索引验证不充分，导致攻击者可以构造恶意的索引值，将数据写入任意内核内存。

```
攻击路径简述：
1. 注册 ZCRX 缓冲区池
2. 发送精心构造的网络包
3. 利用 freelist 索引越界写入内核内存
4. 覆盖关键数据结构获得 root
```

这个漏洞是 io_uring 历史上一系列安全问题的延续。自 2021 年以来，io_uring 已经被发现超过 20 个安全漏洞，Google 甚至在 Android 和 ChromeOS 中禁用了 io_uring。

**教训**：io_uring 的性能优势来自于它将大量内核功能暴露给用户态。但这种暴露也扩大了攻击面。在安全性要求高的场景中，需要仔细评估是否使用 io_uring 的高级特性（如 ZCRX、SQPOLL）。

## 生态现状与选择指南

### 主流语言支持

| 语言 | 库 | 成熟度 | 特点 |
|------|-----|--------|------|
| C | liburing | ★★★★★ | 官方库，Jens Axboe 维护 |
| Rust | tokio-uring | ★★★☆☆ | Tokio 生态，生命周期管理复杂 |
| Rust | io-uring crate | ★★★★☆ | 底层封装，API 忠实还原 |
| Go | go-io_uring | ★★☆☆☆ | 社区维护，功能有限 |
| Zig | std.Io (io_uring) | ★★★★☆ | 2026年2月合入标准库 |

Zig 在 2026 年 2 月将 io_uring 和 macOS 的 Grand Central Dispatch 实现合入了标准库的 `std.Io` 接口，成为第一个在标准库层面统一异步 I/O 后端的系统语言。

### 何时使用 io_uring

**适合的场景**：
- 高吞吐网络服务器（>100K QPS）
- 数据库引擎（存储层 I/O）
- 文件服务器（静态文件服务、CDN 边缘节点）
- 消息队列代理（Kafka 类系统）

**不适合的场景**：
- 低流量 Web 应用（系统调用开销可以忽略）
- 需要跨平台支持（io_uring 是 Linux 专属）
- 安全敏感且无法承受内核攻击面扩大
- 内核版本低于 5.1 的系统

### 渐进式采用路径

```
Level 0: 同步 read/write（最简单，适合原型）
   ↓
Level 1: epoll + 非阻塞 I/O（C10K 标准方案）
   ↓
Level 2: io_uring 基础模式（批量提交，兼容性好）
   ↓
Level 3: io_uring SQPOLL（零系统调用，需专用核心）
   ↓
Level 4: io_uring + kTLS + 注册缓冲区（终极形态）
```

大多数场景下，Level 2（基础 io_uring 批量提交）就能带来显著收益。只有在 Level 2 的性能仍不满足需求时，才考虑 SQPOLL 和 kTLS 等高级特性。

## 总结

io_uring 不仅仅是又一个 I/O 接口。它代表了操作系统设计的一个根本转变：**从"内核替你做 I/O"到"内核和你一起做 I/O"**。

共享内存环形缓冲区的设计消除了系统调用的必要性；批量提交机制将 N 次系统调用压缩为 1 次；SQPOLL 模式甚至让这 1 次都消失了。结合 kTLS 的内核态加密和 NVMe SSD 的高带宽，io_uring 正在重新定义"高性能 I/O"的含义。

但高收益伴随着高风险。ZCRX 漏洞提醒我们，将内核能力暴露给用户态是一把双刃剑。在享受性能红利的同时，安全性、可移植性和复杂性都是需要权衡的因素。

对于追求极致吞吐的系统工程师来说，io_uring 已经不是"要不要用"的问题，而是"怎么用好"的问题。

---

*相关阅读：*

- [Rust重写成TypeScript反而快了3倍：WASM边界税与重写幻觉的深度剖析](/article/rust-to-typescript-wasm-boundary-tax)
- [WebGPU：浏览器终于拿到了显卡的钥匙](/article/webgpu-browser-gpu-revolution-2026)
- [WebAssembly 组件模型：从二等公民到 Web 一等公民的进化之路](/article/webassembly-component-model-first-class-web)
