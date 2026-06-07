---
title: "Zeroserve 架构深度解析：当 io_uring、eBPF 与 Tarball 打包相遇，一个 1.2MB/实例的零配置 Web 服务器是怎么炼成的"
date: 2026-06-07
category: 技术
tags: [Zeroserve, io_uring, eBPF, Rust, Web服务器, Tarball, Landlock, ECH, 系统编程]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
---

# Zeroserve 架构深度解析：当 io_uring、eBPF 与 Tarball 打包相遇，一个 1.2MB/实例的零配置 Web 服务器是怎么炼成的

2026 年 6 月 6 日，HN 上一条只有 204 分（52 条评论）的小型 Show HN，让整个 web server 圈安静了一阵：[Zeroserve: A zero-config web server you can script with eBPF](https://news.ycombinator.com/item?id=48425723)。它的标语极其朴素——*"A zero-config, fast `io_uring`-based HTTPS server."*——但读完它的源码目录（`src/server.rs` 84KB，`src/boringtls.rs` 46KB）和 [memory benchmark](https://github.com/losfair/zeroserve/blob/main/benchmark/memory/memory_benchmark.md)，你就会发现：这台服务器的"零配置"不是营销词，而是一整套**架构选择**——每一条都对应着 nginx、Caddy、Go `http.ServeMux` 上某个你习以为常但其实**可以完全删掉**的复杂性。

核心数据：1000 个并发实例、每个挂载 100MB tarball、跑着 eBPF 中间件——**总 PSS 内存 1.16 GB（每实例 1.2 MB）**。比 nginx 部署节省的不是 10%、不是 50%，而是数量级。

本文做一次逐层解构。

## 一、为什么是 Tarball？——一个反 CDN 时代的打包哲学

打开 `src/pack.rs`，第一个让人愣住的常量：

```rust
pub const ZEROSERVE_H: &[u8] = include_bytes!("../sdk/zeroserve.h");
```

整个 C 语言的 SDK 头文件（19KB）被 `include_bytes!` 直接编译进二进制。然后 `pack_site` 做一件极简的事情：

1. 递归读取目录
2. 凡是 `.zeroserve/scripts/*.c` 的文件，调用 `clang -O2 -target bpf -emit-llvm` + `llc -march=bpf -mcpu=v3 -filetype=obj` 编译成 `.o`
3. 把所有文件（**除 `.c` 源码外**）以 tar 格式写到 stdout

产物就是一个 `site.tar`——既包含 HTML/CSS/JS，也包含已经编译好的 eBPF 字节码。

```bash
# 一行命令，把目录打成可服务的 tarball
zeroserve --pack ./public > site.tar
zeroserve --addr 0.0.0.0:8080 site.tar
```

这背后是几个工程决断：

**1. 静态文件从不被解压到磁盘。** 服务器只把 tar 的 index 加载到内存——`(path, byte_offset, size, etag, mtime)`，约 100 字节每文件。100MB 的 tarball 在内存里大约 1MB 元数据。**实际文件内容只有在被请求时才被 `read_at(offset)` 流式读取**（默认 64KB chunk）。

**2. 没有"解压阶段"。** Caddy 需要 `extract`、nginx 需要 `root`/`alias` 解析、Go embed 需要 `//go:embed`——Zeroserve 没有这一步。tar 就是文件系统。这是为什么 **1,000 个实例**不会把磁盘填满（每个进程持有独立的 `Arc<Site>`，但底层 inode 通过 page cache 共享，PSS 而不是 RSS 计算只有 1.2MB/实例）。

**3. 热重载是 `SIGHUP` + 内存指针替换。** `Arc<Site>` 通过 `arc-swap` 库做无锁 swap。新 tarball 加载到 `Arc<Site>`, `swap()` 一行完成。正在处理的请求持有旧 `Arc`，新请求立即看到新内容——**没有 reload 信号、没有 worker 重新 fork、没有 socket 关闭**。

```rust
// 简化自 src/reload.rs 的热重载循环
loop {
    sighup.recv().await?;
    let new_site = Site::load(&tar_path, max_buckets)?;
    SITE.swap(Arc::new(new_site));  // arc-swap 库，单行无锁 swap
    eprintln!("reloaded: {} entries", new_site.total_entries);
}
```

**对比 nginx 的 reload 流程**：`nginx -s reload` → master 进程 fork 新 worker → 老 worker 处理完现有请求退出 → 期间需要重新打开所有 cache、共享内存、配置解析——这是**数十毫秒到秒级**的窗口，期间可能有 502。Zeroserve 是 0 窗口。

## 二、io_uring 不仅是"更快的 epoll"

我们 [5 月 25 日的文章](https://blog.xltz.qzz.io/article/io-uring-linux-io-revolution-2026)讲过 io_uring 的 submission/completion queue 模型。Zeroserve 用的是 **ByteDance 的 monoio**——一个纯 `io_uring` 的 async runtime（不是 tokio 兼容层），`Cargo.toml` 里的 `iouring` feature 决定整个执行器是 io_uring-only：

```toml
monoio = { version = "0.2", default-features = false,
           features = ["iouring", "poll-io", "macros"] }
io-uring = "0.6"
```

这意味着**没有 epoll fallback，没有 poll syscalls**——启动时如果内核不支持 io_uring 直接 panic。`setup_single_issuer()`（io_uring 5.18+ 引入的 per-task SQ entry 分配）让多线程提交者不再抢同一个 SQ slot：

```rust
let mut urb = io_uring::IoUring::builder();
urb.setup_single_issuer();
if let Some(ms) = config.sqpoll_idle_ms {
    urb.setup_sqpoll(ms);  // kernel 线程轮询 SQ，免去每次 io_uring_enter()
}
```

**sqpoll 模式**（kernel 2.5ms idle 后自动退出）消除了 syscall 开销——对 64KB chunk 静态文件这种小 I/O 收益巨大：每个 read/write 之前不再有 `io_uring_enter()` 的 ring doorbell。

但真正让 Zeroserve 区别于普通 io_uring 项目的，是 `Arc<site>` 共享方式：**每个线程持有 tar 文件的独立 fd 缓存**——`thread-local cloned file descriptor, enabling concurrent reads without contention`。也就是说，1000 个实例的 fd 不共享，每个实例的每个 thread 自己 open，独立 read at offset。代价是 1000× 文件描述符（默认 ulimit 调到了 1048576）：

```rust
let fdlimit =
    rlimit::increase_nofile_limit(1048576).with_context(|| "failed to raise fd limit")?;
eprintln!("fd limit {}", fdlimit);
```

## 三、eBPF 不是内核挂钩——这里它是脚本沙箱

[4 月 30 日的文章](https://blog.xltz.qzz.io/article/ebpf-linux-kernel-programmability-2026)讲过 eBPF 的 verifier 安全性。Zeroserve 的 eBPF 故事**几乎不是关于内核的**——它把 eBPF 当作**便携的字节码沙箱**：

```toml
async-ebpf = "0.2.2"  # userspace eBPF VM
```

`async-ebpf` 是一个纯 Rust 写的 userspace eBPF 解释器——**没有内核加载、不需要 CAP_BPF、不依赖 kernel version**。脚本编译产物（`.o` 文件）可以在任何 Linux 上运行，甚至理论上 macOS/Windows（如果实现 eBPF 指令集）。

运行模型在 `benchmark/memory/memory_benchmark.md` 里描述得很精确：

> Each request receives a dedicated `ScriptExecutionContext` with:
> - Per-request metadata map shared across script chain
> - External object registry (max 32 handles for JSON objects, etc.)
> - Memory footprint tracking with configurable limits (default 256 KB)
> - Lazy body loading
>
> The runtime enforces timeslicing (yields after 1ms, throttles after 20ms) to prevent scripts from blocking the async executor.

几个关键点：

**1. 32 个 JSON handle 表。** `zs_json_parse` 返回一个 handle（数字索引），你必须 `zs_object_free` 释放。脚本里漏掉 free，32 个 slot 满了之后第 33 个 JSON 操作返回 -1。这是显式的、故意的"资源约束"——比 Go GC 干净，比 Rust borrow checker 在动态语言里学得会。

**2. 1ms yield / 20ms throttle。** 这是协程式抢占：脚本执行 1ms 后强制让出执行权给其他协程（避免一个慢脚本饿死整条 monoio 线程）。连续运行 20ms 则直接 throttle（事件循环降级）。这模拟了内核 eBPF 的 1000 万指令上限的精神，但用更软的方式实现。

**3. 256KB 外部内存。** 整个请求生命周期内，脚本可以分配的 buffer 总量上限。`--max-request-external-memory-footprint-kb` 可调。

**4. BPF stack 4096 bytes。** `llc -march=bpf -bpf-stack-size=4096 -mcpu=v3`。所以脚本里不能写大数组、所有 buffer 必须 `zs_*` 显式分配。

来看个实际例子——一个 JWT 校验脚本（来自 `examples/` + SKILL.md）：

```c
#include <zeroserve.h>

static zs_u64 clamp_len(zs_s64 len, zs_u64 cap) {
  if (len <= 0 || cap == 0) return 0;
  if ((zs_u64)len >= cap) return cap - 1;
  return (zs_u64)len;
}

ZS_ENTRY
zs_u64 entry(void) {
  char auth[512];
  zs_s64 n = zs_req_header("authorization", 13, auth, sizeof(auth));
  if (n < 7 || auth[0] != 'B' || auth[6] != ' ') return 0;  // 非 Bearer 不处理
  // 解析 token 的 header.payload.signature
  // 拿 secret 做 HMAC-SHA256 验证签名
  // ...
  return 0;
}
```

注意几个**脚本约束**：
- `clamp_len` 是 SDK 不帮你做的事——你拿到 `zs_s64` 长度后必须 clamp 到 buffer 大小。
- `ZS_ENTRY` 宏把函数放到 `zeroserve.request` section——runtime 按 sorted path 顺序加载所有 `.o`，每个请求顺序执行。
- 如果脚本调 `zs_respond` 或 `zs_reverse_proxy`，**后面的脚本全部跳过**——这是显式的 short-circuit。

**对比 nginx `auth_request` 模块**：你需要写 C、写 nginx.conf、build module、reload nginx。Zeroserve 是 `cp auth.c .zeroserve/scripts/` + `killall -SIGHUP zeroserve`。**两秒迭代**。

## 四、双层沙箱：Landlock + Linux Namespaces

光有 eBPF 脚本沙箱不够——如果 server binary 本身被攻破呢？`src/main.rs` 启动流程里有这么一段（直接读自源码）：

```rust
if !config.disable_ns_isolation {
    setup_ns_isolation(&config).with_context(
        || "failed to set up namespace isolation (set --disable-ns-isolation to disable)",
    )?;
    // ...
    nix::mount::mount(
        None::<&str>,
        "/etc",
        Some("tmpfs"),
        MsFlags::empty(),
        None::<&str>,
    ).with_context(|| "failed to mount virtual /etc")?;

    if let Some(x) = &resolv_conf {
        std::fs::write("/etc/resolv.conf", x)?;
    }

    drop_all_capabilities().with_context(|| "failed to drop capabilities")?;

    if let Err(err) = rlimit::Resource::NPROC.set(1024, 1024) {
        eprintln!("failed to restrict nproc: {:?}", err);
    }
    // ...
}

setup_landlock(&config).with_context(|| "failed to setup landlock")?;
```

三层防御：

**1. Linux namespace 隔离（可选 `--enable-netns-isolation`）**。把 `/etc` 整个 mount 成 tmpfs（`mount` syscall + `MsFlags::empty()` = empty tmpfs），只把启动前读到的 `/etc/resolv.conf` 重新写回去。这意味着攻击者即使拿到 root 也**看不到服务器上其他配置**（除了解析器配置）。

**2. 能力丢弃（`drop_all_capabilities`）**。`CAP_NET_RAW`、`CAP_SYS_ADMIN`、`CAP_DAC_OVERRIDE`——绝大多数 web server 不需要的能力，全部清零。`--disable-ns-isolation` 标志可以让老内核/容器环境跳过这一步（但仍然 Landlock）。

**3. Landlock 文件系统访问控制**。Landlock 是 Linux 5.13+ 的 unprivileged sandboxing——比 seccomp 简单（只控制文件路径），比 SELinux 简单（不需要 LSM）。Zeroserve 启动时枚举所有需要的文件路径，**只允许这些路径**：

```rust
use landlock::{Access, AccessFs, PathBeneath, PathFd, Ruleset, RulesetAttr, RulesetCreatedAttr};

let mut ruleset = Ruleset::new()
    .handle_access(AccessFs::from_all())?
    .create()?
    .add_rule(PathBeneath::new(PathFd::open(tar_path)?, Access::from_all()))?
    .add_rule(PathBeneath::new(PathFd::open(cert_dir)?, Access::from_all()))?
    // ... 只添加白名单路径
    .restrict_self()?;
```

**关键点**：所有 setup 在 `setup_landlock` 里完成**之后**才 spawn worker 线程。Landlock 的 `restrict_self()` 只影响当前进程及其未来子进程——**已经创建的文件描述符不受影响**（所以 socket、tar fd 在 restrict 之前 open 完）。

**对比 nginx + Docker**：要实现相同保护你需要 (a) `cap_drop: ALL` (b) `read_only: true` (c) `tmpfs` mounts (d) `security_opt: no-new-privileges` (e) `seccomp` profile。Zeroserve 把这些都内化到 single binary 了。

## 五、Tarball 字节流：HTTP 头里的 file 路径

来看一个标准静态文件请求在 `src/server.rs` 里的实际执行：

```rust
// 简化自 server.rs
async fn serve_static(
    site: Arc<Site>,
    req_path: &str,
    chunk_size: usize,
) -> Result<StaticResponse, HttpError> {
    let entry = site.lookup(req_path).await?;  // 从 tar index 查 (offset, size)
    let etag = entry.etag.clone();

    Ok(StaticResponse {
        status: StatusCode::OK,
        headers: {
            let mut h = HeaderMap::new();
            h.insert("etag", etag.parse()?);
            h.insert("content-type", guess_mime(req_path).parse()?);
            h
        },
        body: StaticBody::File(entry),  // 只持 Arc<TarEntry>，不持有 bytes
        head_only: req.method == Method::HEAD,
        site,
    })
}

// 然后在 io_uring write loop 里：
fn stream_tar_entry(site: &Site, entry: &TarEntry, mut writer: impl AsyncWriteRent) {
    let fd = site.tfd_pool.acquire();  // thread-local fd
    let mut offset = entry.byte_offset;
    let mut remaining = entry.size;
    while remaining > 0 {
        let to_read = remaining.min(CHUNK_SIZE);
        let buf = fd.pread(offset, to_read)?;  // io_uring pread
        writer.write_all(&buf).await?;
        offset += to_read as u64;
        remaining -= to_read;
    }
}
```

**关键工程取舍**：

- **thread-local fd pool**：避免 1000 个实例的 fd 在 epoll 里打架。每个 thread 自己 `pread`，kernel 调度器把不同 thread 的 pread 分发到不同 io_uring sq。
- **`read_at` 永远不 seek back**：tar 是顺序格式，但 1000 个并发请求乱序访问不同文件——这就要求**`pread` 而不是 `read`**，kernel 内部维护 file position。
- **HEAD 请求在 `head_only: true` 时不发 body**：只生成 headers，省掉 `pread` 整个过程。
- **ETag 是文件 inode + mtime + size 的 blake3 hash**：可重现、anti-collision（128-bit）。

## 六、加密：TLS 1.3、HTTP/2、ECH、JA4

TLS 是 Zeroserve 的另一处"反基础设施"——它直接用 **BoringSSL via `boring` crate**（不通过 OpenSSL/openssl crate 抽象），并在 Cargo.toml 里 patch monoio 用了特定 commit：

```toml
[patch.crates-io]
monoio = { git = "https://github.com/bytedance/monoio", rev = "212fde1..." }
```

为什么不直接用 rustls？答案在 `src/boringtls.rs` 顶部（46KB 全是这个模块）：

```rust
// 简化：boringtls.rs 包装 BoringSSL，提供 BoringStream 给 monoio
pub enum AcceptOutcome {
    Success(BoringStream),
    WouldBlock,  // io_uring EAGAIN
    AlertReceived(Alert),
}

pub async fn accept(ssl_acceptor: &Arc<SslAcceptor>, raw_fd: RawFd) -> Result<AcceptOutcome, io::Error> {
    // ...
}
```

**BoringSSL 是 Chrome/Cloudflare 用的 TLS 库**——它有 OpenSSL 没有的几个关键能力：

**1. 原生 ECH（Encrypted Client Hello）**。BoringSSL 是少数实现 `draft-ietf-tls-esni-19` 的 TLS 库。`--gen-ech-key --ech-public-name www.example.com` 生成 `ECH PRIVATE KEY` + `ECH CONFIG` PEM 块，配套打印 base64 ECHConfigList 让你塞进 DNS HTTPS 记录。`--ech-key` 支持单文件或目录模式：

```bash
zeroserve --gen-ech-key --ech-public-name www.example.com > keys/01.pem
killall -SIGHUP zeroserve  # 启动后让 server 加载新 ECH key
```

SIGHUP 触发**无密钥轮换**——新旧 key 同时存在，老的解密旧的 ECHConfigList 流量，新的解密新的。`config_id` 冲突被拒绝，files 以 `.` 开头被忽略，sort 加载。

**2. JA4 指纹识别**。`src/ja4.rs` 13KB——JA4 是 FoxIO 提出的下一代 TLS 客户端指纹（替代 JA3）。zeroserve 把 TLS 握手的 `ClientHello` 解析成 `_a_b_c_d_e` 格式的 hash 字符串，写入每个请求的 `ConnectionInfo` JSON 句柄。脚本里：

```c
zs_s64 info = zs_connection_info();
zs_json_respond(200, (zs_u64)info);  // 客户端可以查自己的 JA4
```

**3. H2 multiplexing + h2c detection**。`server.rs` 顶部有个常量 `H2_PREFACE = b"PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n"`，accept 协程一看到这 24 字节就切到 h2 解码路径。

## 七、AWS SigV4、OIDC、strongSwan——SDSL 工具集

最有意思的是 `src/helpers/` 目录——Zeroserve 不只是"反向代理到 S3"，它**自己实现 AWS SigV4 签名**（17KB `aws_sign.rs`），脚本里可以直接给响应加签名：

```c
struct zs_aws_v4_sign_params params = {
    .access_key = access_key,
    .access_key_len = strlen(access_key),
    .secret_key = secret_key,
    .secret_key_len = strlen(secret_key),
    .region = "us-east-1", .region_len = 9,
    .service = "s3", .service_len = 2,
    .method = "GET", .method_len = 3,
    .uri = "/", .uri_len = 1,
    .headers_json = headers_handle,
    .body_hash = "UNSIGNED-PAYLOAD", .body_hash_len = 15,
    .timestamp_ms = zs_now_ms(),
    .out = out_buf, .out_len = sizeof(out_buf),
};
zs_aws_v4_authorization_header(&params, sizeof(params));
```

这意味着 Zeroserve 脚本可以**直接代理到 S3**而不需要 nginx `nginx-s3-gateway` 这种第三方 module。`presigned_url()` 还能生成**客户端直接上传 S3 的预签名 URL**——上传流量绕过 zeroserve 全部走 S3 端点。

类似的还有：
- **`oidc.rs` 25KB**——完整的 OAuth2 Authorization Code + PKCE 流程。脚本里 `zs_oidc_login()` 发起 redirect，callback URL 接收 ID token。
- **`vici/mod.rs` 11KB**——strongSwan 的 VICI 协议客户端。Zeroserve 可以跟 strongSwan 通信获取 IPsec SA 状态——在 VPN 内部署静态网站做认证。
- **`crypto.rs` 1.6KB**——统一包装 `zs_sha256`/`zs_hmac_sha256`/`zs_base64_encode`/`zs_hex_encode`，所有 helpers 在 BPF 字节码里可调用。

## 八、性能：1000 实例 1.16 GB PSS 的工程秘密

回到 benchmark 的数据：

| Metric                | Total      | Per-instance |
|-----------------------|------------|--------------|
| **PSS (correct)**     | **1.16 GB**| **1.2 MB**   |
| RSS (inflated)        | 5.50 GB    | 5.6 MB       |
| 4.74x shared savings  |            |              |

1.2 MB / instance 的秘密（直接来自 `benchmark/memory/memory_benchmark.md`）：

> 1. **Shared binary mappings**: The zeroserve executable and linked libraries are shared across all instances via the OS page cache
> 2. **Metadata-only indexing**: Only tarball metadata is held in memory (~100 bytes per file: path, byte offset, size, ETag, mtime). The 100 MB tarball's file content is never loaded into memory.
> 3. **Streaming with positional reads**: File content is served on-demand via `read_at()` at the entry's byte offset, streamed in configurable chunks (default 64 KB) directly to the socket
> 4. **Thread-local file handle cache**: Each thread maintains its own cloned file descriptor
> 5. **Compact script runtime**: The userspace eBPF VM (`async-ebpf`) has minimal overhead; compiled scripts are small (the test script is 1,824 bytes) and per-request context is bounded

**100MB tarball × 1000 实例 = 100 GB 文件内容**，在传统部署里要 100 GB 磁盘 + 解压 + 缓存。这里**只占内存 1.16 GB（OS page cache）+ 1MB 元数据 × 1000 = ~1 GB**。4.74× 的 PSS/RSS 比说明 OS 页面缓存的高效——所有 1000 个进程的 tar 文件 inode 是同一个。

**1.2 MB / instance 的物理意义**：

- Rust 二进制 ~8 MB（shared across 1000 instances via page cache）
- 100MB tarball index in `Arc<Site>` = 1 MB / instance
- 每个 thread 的 fd pool = ~50 KB
- monoio 运行时 / eBPF VM = ~50 KB
- 1000 instances × 1.2 MB = 1.2 GB

**对比**：
- nginx (100 instances) ≈ 1 GB RSS = **10 MB / instance**
- Caddy (100 instances) ≈ 800 MB RSS = **8 MB / instance**
- Go net/http (100 instances) ≈ 2 GB RSS = **20 MB / instance**（GC overhead）
- **Zeroserve (1000 instances) = 1.2 MB / instance**

数量级优势来自一个核心设计：**没有进程级 HTTP 框架**。没有 worker 池、没有 connection pool manager、没有 routing trie、没有 router state——Zeroserve 是 `TcpListener::accept()` + `match (h2_preface, request_path) { ... }` 加几层 `Arc<Site>::lookup()`。

## 九、没解决的几个问题

公平起见——**这不是一个 production-ready 的"nginx 替代品"**：

**1. HTTP/1.1 + HTTP/2，不支持 HTTP/3。** QUIC 的 io_uring 集成仍在实验阶段（`monoio` 没有 QUIC driver），所以 HTTP/3 短期内不会来。

**2. 脚本语言是 C 写的 eBPF。** 没错——你要写 web 应用，要写 C。K8s 的 Lua/Wasm 脚本生态在这里都不适用。HMTT/Bun 的 JS 集成？不存在的。

**3. 没有 webSocket。** HTTP upgrade 在 server.rs 里没有实现路径（虽然技术上 monoio 支持）。

**4. 反向代理到 HTTPS 后端依赖系统的 CA 证书。** 注意源码里的注释：
> Build the reverse-proxy TLS client now, before namespace isolation turns `/etc` into an empty tmpfs — the CA bundle must be read while it's still on disk.

**`/etc` 在 namespace 隔离时被替换成空 tmpfs**——如果反代目标是 HTTPS，CA bundle 必须在那一行**之前** read。一旦进 namespace，从 /etc 读不到任何东西。

**5. 单线程 io_uring。** monoio 当前是 per-thread runtime，**不是 multi-threaded work-stealing**。要看 `setup_single_issuer()` 注释——这是一个 io_uring 5.18+ 才有的特性，允许多线程同时提交 SQ entry 但保证公平。Zeroserve 还没用满。

## 十、当我们说"零配置"，我们到底在说什么

回头看，`zeroserve --pack ./public > site.tar` 一行命令做了 nginx 几十行 config 的事：tldextract、gzip 配置、MIME type 映射、access log、error log、path 解析、try_files fallback、index 自动补齐。

但 Zeroserve 不是"配置更好"——它是**用架构选择消灭了配置**：
- tar 直接当 filesystem → 没有 root/alias
- byte offset 直接当 Range → 没有 Range header parser
- `lookup().etag` → 没有 etag on/off 配置
- 256KB 外部内存默认 → 没有 client_max_body_size

`--try-html`、`--enable-proxy-protocol`、`--validate-hostnames`——这些**仅有的 8 个 flag**几乎涵盖了所有配置决策。

对比 nginx 的 ~150 个 directive。Zeroserve 选了**减少表面面积**——它的整个 `src/cli.rs` 是 6.2KB。

## 总结：什么时候该选 Zeroserve，什么时候不该

**该选**：
- 静态站点 + 几个动态 endpoint（OIDC 登录、rate limit、ECH）
- 多租户 SaaS 想要 single-binary 部署（每个租户独立进程，1.2 MB / 租户）
- 边缘节点需要 hot-reload（1000 实例 + SIGHUP < 50ms）

**不该选**：
- 需要 HTTP/3 / WebSocket / Server-Sent Events
- 应用逻辑复杂到要写 100 个 eBPF 脚本（不如用 Go）
- 团队没人懂 C（写 middleware script 不是普通后端技能）

最后，Zeroserve 的 README 一句话足够说明它的设计哲学：

> `zeroserve` serves a website packaged as a tarball, and handles hot-reload via SIGHUP.

"网站是一个 tarball，配置是一个 SIGHUP。"——这是 web server 的另一种可能。

---

*相关阅读：*

- [《io_uring：Linux I/O 的下半场革命》](/article/io-uring-linux-io-revolution-2026) — io_uring 的 submission/completion queue 基础
- [《eBPF：Linux 内核可编程性的 12 年演化》](/article/ebpf-linux-kernel-programmability-2026) — 从 BPF 到 eBPF 的 verifier 模型
- [《Nginx 实战命令大全》](/article/nginx-commands-guide) — 对比传统 web server 配置哲学
- [《TLS 1.3 与后量子密码学：Merkle Tree 证书如何重塑 CA 体系》](/article/post-quantum-tls-merkle-tree-certificates-2026) — ECH 背后的密码学

---

**参考链接：**
- [Zeroserve GitHub 仓库](https://github.com/losfair/zeroserve)
- [User Manual (30KB)](https://github.com/losfair/zeroserve/blob/main/docs/user_manual.md)
- [Memory Benchmark Report](https://github.com/losfair/zeroserve/blob/main/benchmark/memory/memory_benchmark.md)
- [Zeroserve SDK API](https://github.com/losfair/zeroserve/blob/main/sdk/zeroserve.h)
- [HN Discussion](https://news.ycombinator.com/item?id=48425723)
- [作者博客 su3.io](https://su3.io/posts/introducing-zeroserve)
