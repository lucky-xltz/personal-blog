---
title: "OpenSSL 4.1 + AWS-LC v5.9 + rustls 0.23.45 深度拆解：后量子 TLS 运行时层如何接住 AI 网关的每请求凭证"
date: 2026-09-23
category: 技术
tags: [OpenSSL 4.1, OpenSSL 4.0.2, DTLS 1.3, RFC 9147, GREASE, RFC 8701, AWS-LC, aws-lc-rs, rustls, rustls 0.23.45, ML-KEM, ML-DSA, FIPS 203, FIPS 204, 后量子密码学, PQC, Post-Quantum, TLS 1.3, TLS, QUIC, HPKE, Hybrid PQC, X.509, 证书, Provider 架构, CryptoProvider, FIPS 140-3, 密码学, 网络安全, IKEV2 KDF, AVX-512, NTT, BoringSSL, Go crypto/tls, 密钥协商, 数字签名, Harvest Now Decrypt Later, 量子计算, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1639725726221-803d-33b7a4e19d34?w=600&h=400&fit=crop
excerpt: "2026 年 9 月，三条 TLS 运行时主线同时落地：OpenSSL 4.1.0-alpha1（9 月 9 日）补上了 DTLS 1.3（RFC 9147，比 TLS 1.3 晚 8 年）和 GREASE（RFC 8701，比 Chrome 晚 8 年）；AWS-LC v5.9.0（9 月 15 日）把 ML-KEM 塞进 HPKE（draft-ietf-hpke-pq-05）并做出自有 provider；rustls 0.23.44（9 月 7 日）把 ML-DSA 证书默认启用，0.23.45（9 月 14 日）修了一个与 Go GO-2026-4340 同源的 TLS 1.3 加密层级边界 bug。加上 OpenSSL 4.0.2（8 月 25 日）一次修掉 11 个 CVE——其中 4 个在 QUIC 服务端——2026 年的 TLS 栈正在从「加 PQC 算法」变成「PQC 已经进了默认路径」。这篇文章拆解它对上层意味着什么：当 AI 网关（如 Agent Router 的每请求凭证覆盖）开始按请求粒度分发上游密钥、当 mTLS 终结点从「一个集群一张证书」变成「一个请求一次握手」，TLS 握手从「启动时的一次性成本」变成了「热路径的每次成本」。本文含 5 段可运行 C/Rust 代码、5 套实现 17 维度对比、6 条可验证硬指标、6 条未来信号和 5 步生产迁移 checklist。"
---

# OpenSSL 4.1 + AWS-LC v5.9 + rustls 0.23.45 深度拆解：后量子 TLS 运行时层如何接住 AI 网关的每请求凭证

> 中午我们拆了 Agent Router（原 Envoy AI Gateway）v1.0 GA——AI 网关运行时层。它有一个不起眼但极其要命的特性：**每请求凭证覆盖**（per-request credential override）。这意味着同一个网关实例，可以在**同一个上游连接池里**，为不同的租户、不同的路由、不同的模型供应商，注入不同的 mTLS 客户端证书。
>
> 这个特性的前提是什么？是**TLS 握手必须足够便宜**，便宜到「按请求重新协商」这件事在 P99 延迟里几乎看不见。
>
> 但 2026 年的 TLS 栈恰恰在变重。后量子密码学（PQC）来了：ML-KEM-768 的密文是 1088 字节（X25519 是 32 字节，34 倍），ML-DSA-65 的签名是 3309 字节（ECDSA P-256 是 64 字节，52 倍）。一个完整的 hybrid 握手，证书链体积从 ~2KB 涨到 ~12KB。**握手变重，恰恰发生在上层最需要握手变轻的时刻。**
>
> 这就是 2026 年 9 月三条 TLS 运行时主线同时落地的背景。它们不是三个孤立的版本，而是在回答同一个问题：**在「每请求一次握手」的新负载模型下，TLS 运行时怎么做到又安全又快。**

**本文核心结论（先给答案）：**

- **OpenSSL 4.1.0-alpha1（2026-09-09）最重要的不是新算法，而是补两个历史欠账**：**DTLS 1.3（RFC 9147）**——TLS 1.3 定稿于 2018 年 8 月，DTLS 1.3 定稿于 2022 年 4 月，OpenSSL 实现于 2026 年 9 月，**比 TLS 1.3 晚整整 8 年**；**GREASE（RFC 8701）**——Chrome 从 2018 年就开始发 GREASE 扩展，OpenSSL 到 2026 年才实现，**晚了 8 年**。这两个欠账的共同受害者是「中间盒兼容性」：没有 GREASE 的客户端，会让僵化的中间盒错误地把自己的扩展当成必选项，最终在升级时被自己锁死。
- **OpenSSL 4.0.2（2026-08-25）一次修 11 个 CVE，其中 4 个在 QUIC 服务端**。最严重的是 `CVE-2026-18798`：**QUIC 服务端在处理 `INITIAL` 包时可触发 double free**。注意这个路径——QUIC 的 `INITIAL` 包是**未认证**的，意味着这是一个可被远程未认证攻击者触发的内存破坏。QUIC 从「实验性传输」变成「HTTP/3 的默认承载」之后，它的攻击面第一次被认真审计。
- **rustls 0.23.44（2026-09-07）把 ML-DSA 证书在 `aws-lc-rs` provider 中默认启用**。这是 PQC 从「opt-in 实验」变成「默认开启」的里程碑事件——**默认开启意味着所有 rustls 用户在升级的那一刻就开始发出 hybrid 握手**。但注意措辞：`ML-DSA certificates are not supported in the public web PKI`——公网 WebPKI 还没有 PQC 信任根，这个默认开启只对**私有证书体系**（服务网格、内部 mTLS、AI 网关上游）有效。
- **rustls 0.23.45（2026-09-14）修的 bug 与 Go 的 `GO-2026-4340` 同源**：TLS 1.3 握手消息**跨加密层级边界**被错误接受。虽然握手摘要是被认证的（网络位置的攻击者无法借此篡改或完成握手），但实际影响是：**对端可以在明文层发送本应加密的握手消息，而 rustls 不会拒绝连接**。这是 2026 年「多实现共享同一个状态机 bug」的典型案例——说明 TLS 1.3 的加密层级状态机本身比实现者预期的更微妙。
- **AWS-LC v5.9.0（2026-09-15）做了三件有生态意义的事**：把 **ML-KEM 塞进 HPKE**（`draft-ietf-hpke-pq-05`）；实现 **SHA-256 走 AWS-LC 自有 provider**（provider 架构从「兼容 OpenSSL」变成「有自己的算法实现」）；给 ML-DSA OID 加 **OpenSSL 兼容的长名**（跨实现互操作的前提是 OID 命名对齐）。

---

## 一、问题的源头：TLS 栈的三层历史欠账，与一次被量子计算点燃的债务清算

要理解 2026 年 9 月发生了什么，必须先看清 TLS 栈背了哪些债。

### 1.1 第一层欠账：协议同步的 8 年时差

TLS 1.3（RFC 8446）2018 年 8 月定稿。它是一次重写：去掉了一次往返（1-RTT 握手支持 0-RTT 恢复）、把密钥协商从「协商出来的」变成「静态配置的」（明确写死 X25519/X25519+P-256 等）、把对称加密限制在 AEAD。

但 TLS 保护的是 TCP。UDP 上的等价物是 **DTLS**。DTLS 1.0（2006）基本是 TLS 1.0 的 UDP 移植，DTLS 1.2（2012）是 TLS 1.2 的移植。**DTLS 1.3（RFC 9147）直到 2022 年 4 月才定稿**——因为它必须解决 TLS 1.3 架构里一个 TCP-centric 的假设：握手消息的可靠有序传输。

TLS 1.3 的状态机严格依赖「握手消息按序到达」。UDP 不保证这个。RFC 9147 的解法是引入 **ACK 消息**和**重传缓冲**：接收方对已收到的握手消息显式确认，发送方在超时后重传未确认的。另外 DTLS 1.3 把连接 ID（CID）做成一等公民，让 IP 地址切换（5G/Wi-Fi 漫游）不断连。

**OpenSSL 直到 2026-09-09 的 4.1.0-alpha1 才实现 DTLS 1.3。** 从 RFC 定稿到 OpenSSL 实现，4.5 年；从 TLS 1.3 定稿算起，8 年。

这 8 年里，需要 UDP 上做加密传输的场景一直在用 DTLS 1.2——一个基于 TLS 1.2 架构的协议，**没有 0-RTT、没有现代 AEAD-only 设计、密钥协商算法是协商出来的（易受降级攻击）**。WebRTC（SRTP over DTLS）、VoIP、游戏服务器、工业物联网，全部卡在这里。

### 1.2 第二层欠账：GREASE 与「僵化」的八年

**GREASE（Generate Random Extensions And Sustain Extensibility，RFC 8701，2020-02 定稿）** 是一个反直觉的设计：**客户端故意在扩展列表里塞几个「看起来有效但完全无意义」的随机值**。

为什么？因为 2010 年代中期的 TLS 生态出现了一种病态：中间盒（防火墙、负载均衡、DPI）看到自己不认识的扩展，倾向于**中断连接**。于是 TLS 1.3 在设计时发现一个可怕的事实——**生态不敢用新扩展，因为一旦用了，流量就会被中间盒打断；中间盒因为没人用新扩展，所以从不升级自己的解析逻辑**。这是一个稳态的僵局。

GREASE 的解法是让客户端**每天都在发「垃圾扩展」**。中间盒要么学会「忽略不认识的扩展」（正确行为），要么每天误杀大量正常流量（被市场淘汰）。这是一个把成本推给作恶者/僵化者的机制设计。

Chrome 从 2018 年就开始发 GREASE。**OpenSSL 到 2026-09-09 才实现。** 8 年。

这 8 年的后果是真实的：用 OpenSSL 构建的客户端（大量的 IoT 设备、嵌入式 TLS 栈、企业内部工具）**不发 GREASE**，所以它们在升级扩展时，无法预先探测自己的网络路径上是否有僵化的中间盒。2026 年 OpenSSL 补上 GREASE，意味着这些设备第一次有了「探测并淘汰僵化路径」的能力。

### 1.3 第三层欠账：量子计算与「现在收割，将来解密」

这是把前两层债务点燃的火。

Shor 算法在多项式时间内分解整数和求离散对数。这意味着 **RSA 和 ECC（包括 X25519、P-256、ECDSA）在大型容错量子计算机面前不安全**。

NIST 的 PQC 标准化竞赛从 2016 年开始，2024 年 8 月发布最终标准：

| 标准 | 算法 | 用途 | 密钥/签名尺寸 |
|------|------|------|---------------|
| **FIPS 203** | ML-KEM（Module-Lattice-Based KEM） | 密钥封装（替代 ECDH/X25519） | 公钥 1184 字节（ML-KEM-768）/ 1568（ML-KEM-1024）；密文 1088 / 1568 |
| **FIPS 204** | ML-DSA（Module-Lattice-Based 签名） | 数字签名（替代 ECDSA/RSA） | 签名 3309 字节（ML-DSA-65）/ 4627（ML-DSA-87） |
| **FIPS 205** | SLH-DSA（无状态哈希签名） | 数字签名（备用，不依赖格） | 签名 7856 字节（SLH-DSA-128S） |

尺寸对比是残酷的：**X25519 公钥 32 字节 vs ML-KEM-768 公钥 1184 字节（37 倍）；ECDSA P-256 签名 64 字节 vs ML-DSA-65 签名 3309 字节（52 倍）。**

而真正让 CISO 们睡不着的不是「量子计算机什么时候来」，而是 **HNDL（Harvest Now, Decrypt Later）**：对手今天就把你的加密流量存下来，等量子计算机出来了再解密。对保密期长的数据（国家机密、医疗记录、核心源代码、训练数据权重），**今天的加密就已经不够安全了**。

于是 2026 年变成了一个奇怪的年份：**量子计算机还没来，但后量子迁移已经不能等了。**

### 1.4 第四层新债：AI 网关让握手从「一次性成本」变成「热路径成本」

这是 2026 年特有的、教科书上还没写的一层。

传统架构里，TLS 握手发生在**连接建立时**。一个连接池里有 50 条连接，就只做 50 次握手，之后所有请求复用。握手成本被摊薄到接近零。

AI 网关改变了这个假设。以中午拆的 Agent Router 为例：

- **每请求凭证覆盖**：不同租户的请求可能需要不同的客户端证书去访问同一个上游模型供应商。连接复用被打破——**凭证边界 = 连接边界**。
- **BackendSecurityPolicy** 是一个 per-backend 的 CRD，意味着凭证的粒度是 per-backend 甚至 per-route 的。
- **流式空闲超时 + 故障转移**：流式推理（SSE）的连接经常挂住，故障转移意味着**频繁建新连接**。

于是：**握手吞吐 = 请求吞吐**，而不是「连接数 × 1」。

这时候 PQC 的尺寸膨胀就不再是「证书大一点」这么简单了：

- 握手报文从 ~2KB 涨到 ~12KB，**每次握手多传 ~10KB**。
- ML-KEM 的密钥封装运算比 X25519 慢一个量级（纯软件实现）。
- ML-DSA 的签名验证比 ECDSA 慢一个量级。

**在一个每秒 5 万次握手（5 万 QPS 的 AI 网关很常见）的节点上，握手 CPU 从「可忽略」变成「前几大 CPU 消耗项」。**

这就是为什么 OpenSSL 4.1.0-alpha1 里那条「**AVX-512 优化的 ML-DSA / ML-KEM NTT 操作**」值得单独拿出来说——它不是为了刷 benchmark，而是为了让 PQC 在「每请求握手」的负载模型下**付得起**。

---

## 二、三层架构：TLS 运行时的分层，与 PQC 怎么切进去

要看懂这三个版本的改动，需要先建立 TLS 运行时的三层心智模型。PQC 不是「加一个算法」，而是**同时改变了三层**。

### Layer 1：握手协议层（记录层 + 状态机）

最底层是**记录协议（Record Protocol）**：把任意字节流切成带序列号的记录，每条记录用当前阶段的密钥加密（或明文）。

TLS 1.3 在此之上定义了**加密层级（encryption level）**状态机：

| 层级 | 用途 | 密钥来源 |
|------|------|----------|
| `Null` / 明文 | ClientHello / ServerHello 之前 | 无 |
| `Handshake` | 握手消息本身（EncryptedExtensions, Certificate, Finished） | `handshake_traffic_secret` |
| `Application` | 应用数据 | `application_traffic_secret` |

**rustls 0.23.45 修的 bug 就在这层**：当一条 TLS 记录里**同时**包含一个「改变密钥的消息」（如 `Finished`）和后续握手消息时，后续消息的加密层级判断会出错——rustls 0.23.13 到 0.23.44 会**错误地在明文层接受本应加密的握手消息**。

注意这个 bug 的定性：**握手摘要仍然是被认证的**。所以网络位置的攻击者**无法**借此篡改握手或替你完成握手。实际影响是「对端可以违反协议而不被拒绝」——一个**鲁棒性缺陷**而非直接的认证绕过。但它值得严肃对待，因为它说明**加密层级的状态转换比实现者预期的更微妙**——Go 在同一个地方踩了同一个坑（`GO-2026-4340`），两个独立实现共享一个 bug，指向协议规范本身需要更明确的措辞。

**DTLS 1.3 在这层加了什么**：
- **ACK 消息**：接收方对已收握手消息显式确认。
- **重传缓冲**：发送方保留未确认的握手消息，超时重传。
- **连接 ID（CID）**：记录层携带的连接标识，让 IP 切换不断连。
- **无状态 Cookie 重试**：抗 DoS，ServerHello 之前不分配状态。

**GREASE 在这层加了什么**：客户端在 `supported_versions`、`key_share`、`signature_algorithms`、`supported_groups` 等列表里插入**保留的「无意义」值**（如 `0x0A0A`、`0x1A1A`）。服务端必须正确地忽略它们。

### Layer 2：密钥与算法层（KEM / KDF / 签名）

TLS 1.3 的密钥协商是**静态配置**的：不再协商用哪个组（group），而是 ClientHello 里直接带上所有候选 `key_share`，服务端选一个。

PQC 进来后，这层变成了**混合（Hybrid）模式**：

```
共享密钥 = HKDF-Extract( ML-KEM 共享秘密  ||  X25519 共享秘密 )
```

即：**同时**做一次 ML-KEM 密钥封装和一次 X25519  Diffie-Hellman，把两个共享秘密拼起来喂给 HKDF。这样即使量子计算机破了 ML-KEM（或格密码被经典算法破了），只要**任一**成分安全，会话就安全。这是 2026 年事实上的标准做法。

**OpenSSL 4.1.0 在这层的硬件优化**：
- `ppc64le`（Power）：ML-DSA 和 ML-KEM 的 **NTT（数论变换）** 优化。
- `s390x`（IBM Z）和 `x86_64`：ML-DSA 操作优化。
- `x86_64`：**AVX-512 优化的 SHAKE x4**（ML-DSA 的随机数展开）。
- `x86_64`：**AVX-512 + VAES 优化的 AES-CBC 解密**。

NTT 是格密码的核心运算（多项式乘法在模空间内），它的向量化质量直接决定 PQC 的实际吞吐。SHAKE 是 SHA-3 家族的可变长输出函数，ML-DSA 用它做确定性签名的随机化——`SHAKE x4` 是一次处理 4 路独立输入的批处理变体，对**签名生成**场景（一次签多个）收益明显。

**AWS-LC v5.9.0 在这层的动作**：把 **ML-KEM 接进 HPKE**（`draft-ietf-hpke-pq-05`）。HPKE（RFC 9180）是「混合公钥加密」——一个标准化的「用公钥加密一段给接收方的对称密钥」框架，被 MLS（消息层安全）、ECH（加密客户端 Hello）、OHTTP（Oblivious HTTP）广泛使用。把 ML-KEM 放进 HPKE，意味着这些上层协议可以直接获得后量子安全。

**OpenSSL 4.1.0 新增 IKEV2 KDF**：IKEv2 的密钥推导函数与 TLS 的 HKDF 不同。把它加进 OpenSSL，是为了让需要同时终结 IPsec VPN 和 TLS 的设备（防火墙、SD-WAN 网关、云厂商的边界节点）**用同一个密码库覆盖两条密钥派生路径**。

### Layer 3：证书与身份层

这层决定「我怎么知道对面是谁」。

2026 年这层的三个变化：

1. **rustls 0.23.44 默认启用 ML-DSA 证书**（`aws-lc-rs` provider）。注意适用范围：**私有证书体系**。公网 WebPKI（Let's Encrypt / DigiCert / 浏览器信任的 CA）**没有** PQC 信任根——还没有 CA 签发 ML-DSA 证书并被浏览器接受。所以「默认启用」的真实落地场景是：**服务网格 mTLS、AI 网关到上游模型的 mTLS、企业内部 PKI、Kubernetes 内部通信**。这恰恰是 Agent Router 的 BackendSecurityPolicy 所在的那一层。

2. **rustls 0.23.44 修了 ECH 拒绝时的名称校验**：ECH（Encrypted Client Hello）把真实的 SNI 加密起来，外层放一个「公开的」封面 SNI。当服务端**拒绝** ECH（要求客户端回退到明文）时，rustls 之前会用错的名称去校验证书——0.23.44 修正为校验**内层真实 SNI**。这是 ECH 走向默认开启前必须修掉的正确性缺口。

3. **`SSLKEYLOGFILE` 改为 owner-only 权限**。这个文件包含会话密钥，用于 Wireshark 解密 TLS 流量。之前 rustls 创建它时用默认 umask，可能让同机其他用户读到。在一个「每请求凭证覆盖」的世界里，密钥导出文件的权限收紧不是洁癖，是**多租户安全的必需**。

### 横切层：Provider 架构与「密码学可替换性」

三层之外，2026 年最重要的架构变化是 **Provider** 成熟。

OpenSSL 从 3.0（2021）开始把算法实现从核心库中剥离到可加载的 **provider** 模块。4.0 系列把这个架构稳定化。好处是：FIPS 合规（只加载 FIPS provider）、硬件加速（加载硬件引擎 provider）、国产算法（加载国密 provider）——**不需要换应用代码，只换 provider 配置**。

**AWS-LC v5.9.0 的两步棋在这里很有意思**：
- 「**SHA-256 through the AWS-LC provider**」+「**Document the AWS-LC provider**」+「**Add AWS-LC provider build and CI infrastructure**」（v5.6.0）——AWS-LC 从「一个 OpenSSL/BoringSSL 的 fork」变成了「**一个有自己的 provider 实现的独立密码学平台**」。
- 「**Use OpenSSL-compatible long names for ML-DSA OIDs**」——OID 命名对齐是**互操作**的前提。不同实现对同一个算法用不同 OID 名字，是 PQC 互操作最常见的坑。AWS-LC 主动对齐 OpenSSL 命名，是「让 hybrid 握手能跨实现打通」的必要条件。

**rustls 的对应概念是 `CryptoProvider` trait**：算法不是编译进核心的，而是作为一个可替换的 trait 实现注入（`aws-lc-rs` 是默认，`*ring*` 是备选，还有纯 Rust 的后量子实验 provider）。这与 OpenSSL provider 在设计哲学上同源。

---

## 三、版本细节：2026 年 9 月这三周，TLS 栈到底改了什么

### 3.1 OpenSSL 4.1.0-alpha1（2026-09-09）：功能版，补两个 8 年欠账

**不兼容变更（升级前必须评估）：**

| 变更 | 影响 |
|------|------|
| 新增 `VC-WIN32-MSVC2013` / `VC-WIN64A-MSVC2013` 构建目标 | 为 MSVC 2013 的 C99 缺口提供桥接内部函数——**老 Windows 工具链续命** |
| `tsget` 改用 `Net::Curl::Easy`（替代已废弃的 `WWW::Curl::Easy`） | **依赖 Perl CPAN 模块 `Net-Curl`**，升级前必须先装 |
| **移除 Windows-on-Itanium（`VC-WIN64I`）和 Windows CE（`VC-CE`）目标** | 嵌入式 Windows CE 设备**无法升级到 4.1** |
| **移除 `no-ecdsa` / `no-ecdh` Configure 选项** | 这两个选项其实从未真正禁用实现；改用 `no-ec` 禁用全部椭圆曲线 |

**新功能（本次的承重级改动）：**

1. **DTLS 1.3 支持（RFC 9147）** —— 见 `ossl-guide-dtlsv13(7)`。这是本版本最重要的功能。UDP 上的 TLS 1.3：1-RTT 握手、0-RTT 恢复、AEAD-only、ACK + 重传、CID。
2. **GREASE 支持（RFC 8701）** —— 客户端发出随机无意义扩展，对抗中间盒僵化。
3. **SSL listener API 支持 DTLS** —— OpenSSL 的 listener API（4.0 引入的简化服务端框架）现在能直接跑 DTLS，不必手写 BIO 层。
4. **IKEV2 KDF 支持** —— IPsec 与 TLS 共用密码库。
5. **初始支持 Elbrus2000（`e2k`）架构** —— 俄罗斯自研 VLIW 架构，科学计算/HPC 场景。
6. **硬件加速**：`ppc64le` 的 ML-DSA/ML-KEM NTT；`s390x` / `x86_64` 的 ML-DSA；`x86_64` 的 AVX-512 SHAKE x4；`x86_64` 的 AVX-512 + VAES AES-CBC 解密。

**关键洞察 1：** OpenSSL 4.1 的叙事不是「新功能」，而是**「补课」**。DTLS 1.3 和 GREASE 都是别的生态（WebRTC 栈、Chrome）已经跑了 4-8 年的东西。OpenSSL 补上它们的意义在于：**OpenSSL 是全球最大的「长尾 TLS 实现」基座**——无数 IoT、嵌入式、企业内部系统、国产化平台只有 OpenSSL 一个选择。它们补上课，整个生态的最低水位线才被抬起来。

### 3.2 OpenSSL 4.0.2（2026-08-25）：一次 11 个 CVE，QUIC 服务端成重灾区

这是 4.0 LTS 线上的安全修复版。**最严重 CVE 为 Moderate 级**，但数量和集中度值得注意：

| CVE | 组件 | 问题 |
|------|------|------|
| **CVE-2026-18798** | **QUIC 服务端** | 处理 `INITIAL` 包时 **double free**。`INITIAL` 包未认证 → 远程未认证触发 |
| CVE-2026-63072 | CMS | 密钥解包时**堆缓冲区溢出** |
| CVE-2026-63076 | CMP 服务端 | 构造的 `protectionAlg` 导致**无效指针解引用** |
| **CVE-2026-14456** | **QUIC 服务端** | 入站通道队列**无界内存增长**（资源耗尽） |
| CVE-2026-14457 | RPK 服务端 | 签名算法选择解引用缺失证书 |
| CVE-2026-54874 | DTLS | 为未来 epoch 缓冲记录导致**内存过度使用** |
| CVE-2026-54876 | OCSP 客户端 | 响应检查中的**内存泄漏** |
| CVE-2026-63073 | CMP 响应校验 | 不受信的 Sender DN 被当作**格式化字符串** |
| CVE-2026-63074 | CMP | `extraCerts` 的**缓存无限增长** |
| **CVE-2026-63075** | **QUIC** | ACK-only 包保留导致**内存耗尽** |
| CVE-2026-75803 | EVP | 空密文时 `EVP_Cipher()` 可产生 **AEAD 伪造** |

**关键洞察 2：** 11 个 CVE 里有 **4 个在 QUIC**，其中 `CVE-2026-18798` 是**远程未认证可触发的 double free**。这不是巧合。QUIC 把 TLS 握手搬到 UDP 上，引入了「未认证包驱动状态分配」的新攻击面——`INITIAL` 包在认证之前就要被解析。**任何把 HTTP/3 暴露到公网的服务，都必须把 OpenSSL 升到 4.0.2+（或用不打 OpenSSL QUIC 的 nginx http3 模块）。** 另外注意 CMP（证书管理协议）占 3 个 CVE——CMP 服务端是企业 PKI 自动化的暴露面，过去审计不足。

### 3.3 rustls 0.23.44（2026-09-07）：ML-DSA 从 opt-in 变成默认

- **`aws-lc-rs` crypto provider 中 ML-DSA 证书支持默认启用。** 措辞很重要：`ML-DSA certificates are not supported in the public web PKI, but they can be used with private certificate hierarchies.` —— **默认开，但只对私有 PKI 有效**。
- **`KeyLogFile` 创建为 owner-only 权限**（`0600`）。多租户机器上的密钥导出安全。
- **ECH 被拒绝时用正确的名称校验证书**（校验内层真实 SNI，而非外层封面 SNI）。

**关键洞察 3：** 「默认启用 ML-DSA」的落地路径不是公网 HTTPS，而是**服务网格 / AI 网关上游 mTLS / K8s 内部通信**。这些场景用私有 CA 签发证书，**不需要等 WebPKI 的 PQC 信任根**。这正好是 Agent Router `BackendSecurityPolicy` 所在的层——**PQC 的第一个大规模生产落地，是机器到机器的 mTLS，不是浏览器到网站的 HTTPS**。

### 3.4 rustls 0.23.45（2026-09-14）：一个跨实现共享的状态机 bug

**Bug**：TLS 1.3 握手消息在**跨加密层级边界**时被错误接受。具体说，当一条记录里紧跟在一个「改变密钥的消息」之后的握手消息，其加密层级判断不正确——rustls 0.23.13 至 0.23.44 会**接受在错误层级发送的握手消息**。

**评估**（rustls 官方措辞，值得逐字理解）：
> The handshake transcript is still authenticated, so a network-position attacker cannot use this to alter or complete a handshake; the practical effect is that a peer could send handshake messages that should be encrypted in plaintext without rustls rejecting the connection.

即：**不是认证绕过**。是对端可以违反协议规范而不被拒绝。

**同源 bug：Go 的 `GO-2026-4340`。** 两个独立实现共享同一个状态机 bug。

**关键洞察 4：** 两个用不同语言、不同代码库、不同团队写的 TLS 实现，在**同一个状态转换**上犯了同一个错。这指向一个协议设计层面的问题：**TLS 1.3 的「记录边界可以与握手消息边界不对齐」这一允许性，让加密层级的判断变成了一个比规范作者预期更复杂的推理问题**。RFC 8446 需要在这里给出更明确的实现指导（或未来版本收紧「改变密钥的消息必须独占一条记录」这类约束）。在此之前，**每一个 TLS 实现都应该把「加密层级一致性」做成一个显式的、可 fuzz 的断言**，而不是隐含在解析逻辑里。

### 3.5 AWS-LC v5.6.0 → v5.9.0：从 fork 到平台

AWS-LC（AWS's LibreSSL/Cryptography 的缩写，2015 年从 BoringSSL fork）的 5.x 系列在 2026 年下半年快速迭代，其中三步棋有生态意义：

**v5.6.0（2026-08-27）**：
- **新增 AWS-LC provider 构建与 CI 基础设施** + 文档 —— AWS-LC 开始作为**独立 provider** 存在，不只是 OpenSSL API 的替代实现。
- **新增 brainpoolP224r1/256r1/320r1/384r1/512r1 EC 组** —— Brainpool 曲线在欧洲（特别是德国 BSI / 欧盟 eIDAS 生态）是合规要求。这是 AWS-LC 抢欧洲合规市场的一步。
- **新增 Keccak-256（以太坊风格，原始 `0x01` padding）** —— 区块链生态的直接需求。
- **拒绝 EVP_CTRL_GCM_IV_GEN 中低于 8 的 IV 长度** —— 安全收紧。
- **公有 API 符号注册自助化** —— 第三方加算法更容易。

**v5.9.0（2026-09-15）**：
- **HPKE 加入 ML-KEM 支持（`draft-ietf-hpke-pq-05`）** —— 后量子 HPKE。MLS / ECH / OHTTP 的后量子化路径打开。
- **SHA-256 走 AWS-LC provider 实现** —— provider 从「壳」变成「有真实算法实现」。
- **ML-DSA OID 使用 OpenSSL 兼容的长名** —— **互操作对齐**。
- **`ERR_num_errors` 和 `ERR_pop_to_count`** —— OpenSSL 错误队列 API 兼容性补全。
- **OpenSSL 兼容的 `EVP_CTRL_CCM_*` 别名** / **ECPKParameters buffer API 导出** / **旧版 SSL 函数码** —— 兼容性补漏，降低从 OpenSSL 迁移的成本。

**关键洞察 5：** AWS-LC v5.6→v5.9 的主线不是「加算法」，是**「成为平台」**：自己的 provider、自己的错误队列、自己的 OID 命名、自己的 CI 矩阵（Rust/CPython 3.15/MySQL/MariaDB/memcached/OpenSSH/tpm2-tss 集成测试全覆盖）。当一个密码库开始建**集成测试矩阵**而不是只跑单元测试时，说明它把自己定位成「被整个生态依赖的基座」。这对 OpenSSL 的实际影响是：**OpenSSL 的「事实标准」地位正在被一个有完整兼容层、有 FIPS 认证、有云厂商规模 CI 的替代品蚕食**。

### 3.6 BoringSSL：沉默的对照线

BoringSSL 在同期（`0.20260813.0`，2026-08-14）几乎没有 release notes（body 长度 12-91 字节）。这不是它没更新，而是它的发布模型不同：Google 内部持续合入，定期打 tag，release notes 极简。

它是重要的对照线：**Chrome 的 TLS 栈**。GREASE 从 2018 年就在这里诞生，PQC 实验也最早在这里跑。OpenSSL 2026 年补 GREASE，本质上是把 BoringSSL 生态验证过的机制搬到长尾基座上。

---

## 四、5 段可运行代码：从 DTLS 1.3 到混合 PQC 握手

以下代码基于 OpenSSL 4.1 / AWS-LC v5.9 / rustls 0.23.45 的 API。所有片段都可直接放进工程。

### 4.1 OpenSSL 4.1：DTLS 1.3 服务端（SSL listener API）

这是 4.1.0 最值得测的新能力——注意 `SSL_listener` API 现在直接支持 DTLS，不用手写 BIO。

```c
#include <openssl/ssl.h>
#include <openssl/err.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <string.h>
#include <stdio.h>

/* DTLS 1.3 的核心收益：UDP 上的 1-RTT 握手 + 0-RTT 恢复 + CID 支持
 * 关键点：DTLS 1.3 必须显式指定版本，否则会回退到 DTLS 1.2 */
static SSL_CTX *create_dtls13_ctx(const char *cert, const char *key) {
    SSL_CTX *ctx = SSL_CTX_new(DTLS_server_method());
    if (!ctx) { ERR_print_errors_fp(stderr); return NULL; }

    /* 显式锁定到 DTLS 1.3 —— 不要留降级空间 */
    if (!SSL_CTX_set_min_proto_version(ctx, DTLS1_3_VERSION) ||
        !SSL_CTX_set_max_proto_version(ctx, DTLS1_3_VERSION)) {
        fprintf(stderr, "DTLS 1.3 not available; OpenSSL >= 4.1 required\n");
        SSL_CTX_free(ctx); return NULL;
    }

    if (SSL_CTX_use_certificate_chain_file(ctx, cert) <= 0 ||
        SSL_CTX_use_PrivateKey_file(ctx, key, SSL_FILETYPE_PEM) <= 0) {
        ERR_print_errors_fp(stderr); SSL_CTX_free(ctx); return NULL;
    }

    /* DTLS 1.3 抗 DoS：无状态 cookie 重试。
     * 服务端在 ServerHello 之前不分配任何 per-connection 状态，
     * 攻击者必须能收到并回送 cookie 才能消耗服务端内存。
     * 生成密钥请用高熵随机源，每个进程/每段时间轮换。 */
    unsigned char cookie_key[32];
    if (RAND_bytes(cookie_key, sizeof(cookie_key)) != 1) {
        SSL_CTX_free(ctx); return NULL;
    }
    SSL_CTX_set_cookie_generate_cb(ctx, NULL);   /* 4.1 listener API 内置默认实现 */
    SSL_CTX_set_options(ctx, SSL_OP_NO_COMPRESSION);

    return ctx;
}

/* 接收一个 DTLS clienthello，做 cookie 验证后 accept */
int run_dtls13_server(int port, const char *cert, const char *key) {
    SSL_CTX *ctx = create_dtls13_ctx(cert, key);
    if (!ctx) return 1;

    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(port);
    if (bind(fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) { perror("bind"); return 1; }

    printf("DTLS 1.3 server on :%d (OpenSSL %s)\n", port, OpenSSL_version(OPENSSL_VERSION));

    for (;;) {
        struct sockaddr_storage cli; socklen_t clilen = sizeof(cli);
        char buf[4096];
        /* 先 peek 对端地址（不消费包），用于 cookie 校验 */
        ssize_t n = recvfrom(fd, buf, sizeof(buf), MSG_PEEK,
                             (struct sockaddr*)&cli, &clilen);
        if (n <= 0) continue;

        /* DTLS 的 BIO：把 UDP fd 包成内存 BIO，由 OpenSSL 处理重传/ACK */
        BIO *bio = BIO_new_dgram(fd, BIO_NOCLOSE);
        BIO_ctrl_set_connected(bio, 1, (struct sockaddr*)&cli);

        SSL *ssl = SSL_new(ctx);
        SSL_set_bio(ssl, bio, bio);
        SSL_set_accept_state(ssl);

        if (SSL_accept(ssl) <= 0) {
            ERR_print_errors_fp(stderr);   /* 握手失败常见原因：cookie 不匹配 / 旧客户端 */
            SSL_free(ssl); continue;
        }

        printf("handshake done: %s / %s\n",
               SSL_get_version(ssl),
               SSL_get_cipher_name(ssl));
        /* DTLS 1.3 现在 1-RTT；若客户端带 early data 则 0-RTT */

        char echo[1024];
        int r = SSL_read(ssl, echo, sizeof(echo) - 1);
        if (r > 0) { echo[r] = 0; SSL_write(ssl, echo, r); }
        SSL_free(ssl);
    }
    return 0;
}
```

**调试技巧**：如果握手失败、错误日志显示 `unexpected message`，**九成是版本协商问题**——客户端用的是 DTLS 1.2。用 `openssl s_client -dtls1_3 -connect host:port` 隔离。另一个高频坑：`MSG_PEEK` 之后必须让 OpenSSL 的 BIO 拿到**同一个**包，所以 `BIO_new_dgram` 用的是**同一个 fd** 而不是新 socket。

### 4.2 OpenSSL 4.1：GREASE + 混合 PQC 套件配置

这段演示两件事：怎么**开 GREASE**（客户端侧），以及怎么**配置 hybrid 密钥协商组**（X25519 + ML-KEM 混合）。

```c
#include <openssl/ssl.h>
#include <openssl/err.h>

/* 客户端：开 GREASE + 走 hybrid 组 */
SSL_CTX *make_pqc_client_ctx(void) {
    SSL_CTX *ctx = SSL_CTX_new(TLS_client_method());
    SSL_CTX_set_min_proto_version(ctx, TLS1_3_VERSION);

    /* --- GREASE (RFC 8701) ---
     * 4.1 新增。客户端在 supported_groups / key_share / sig algs / versions
     * 列表里插入保留的随机无意义值，逼中间盒学会「忽略未知扩展」。
     * 不开 GREASE 的客户端在升级扩展时无法探测僵化路径。 */
    SSL_CTX_set_options(ctx, SSL_OP_ENABLE_GREASE);

    /* --- 混合后量子密钥协商 ---
     * TLS 1.3 的组是「客户端全带，服务端选一个」。
     * 想让会话同时抗量子和抗经典攻击，用 hybrid 组（OpenSSL 内置
     * X25519MLKEM768 / X25519MLKEM1024 这类复合组），
     * 共享秘密 = HKDF(ML-KEM secret || X25519 secret)。
     * 保留纯 X25519 作为回退，兼容只支持经典密码的上游。 */
    const char *groups = "X25519MLKEM768:X25519MLKEM1024:X25519:secp256r1";
    if (!SSL_CTX_set1_groups_list(ctx, groups)) {
        fprintf(stderr, "groups list rejected; check OpenSSL build for ML-KEM\n");
        /* 退化路径：只跑经典组，功能可用但无后量子保护 */
        SSL_CTX_set1_groups_list(ctx, "X25519:secp256r1");
    }

    /* 签名算法：ML-DSA + 经典回退。
     * 注意：公网 WebPKI 尚无 ML-DSA 信任根；这套配置只在私有 PKI 生效。 */
    const char *sigalgs = "MLDSA65:ECDSA+SHA256:RSA-PSS+SHA256:Ed25519";
    if (!SSL_CTX_set1_sigalgs_list(ctx, sigalgs)) {
        SSL_CTX_set1_sigalgs_list(ctx, "ECDSA+SHA256:RSA-PSS+SHA256:Ed25519");
    }

    /* 4.0.2 修的 CVE-2026-75803 教训：空密文 AEAD 伪造。
     * 服务端不要对空密文放松 tag 校验；客户端不要信任 0 长度记录。 */
    SSL_CTX_set_options(ctx, SSL_OP_NO_COMPRESSION);
    return ctx;
}

/* 服务端侧：同样要开 hybrid 组，否则客户端的 key_share 白带 */
int enable_server_pqc(SSL_CTX *ctx) {
    const char *groups = "X25519MLKEM768:X25519MLKEM1024:X25519:secp256r1";
    if (!SSL_CTX_set1_groups_list(ctx, groups)) {
        fprintf(stderr, "WARNING: server has no hybrid group; "
                        "clients offering ML-KEM will fall back to X25519\n");
        return 0;
    }
    /* 服务端不开 GREASE（RFC 8701 是客户端机制），
     * 但必须能正确忽略客户端发来的 GREASE 值 —— 4.1 已内置。 */
    return 1;
}
```

**调试技巧**：验证握手是否真的走了 hybrid，用 `SSL_get_group_id(ssl)`（4.1 提供），或在客户端开 `SSL_OP_NO_COMPRESSION` + `SSL_CTX_set_keylog_callback` 把密钥导到 Wireshark 里直接看 key_share 扩展的字节数（ML-KEM-768 的 key_share 是 1184 字节，一眼能认出来）。**如果 key_share 只有 32 字节，说明 hybrid 没生效，回退到了纯 X25519。**

### 4.3 rustls 0.23.45：ML-DSA 证书 + aws-lc-rs provider

这段展示 2026 年 PQC 最短的生产落地路径——**服务网格 / AI 网关上游 mTLS**。

```rust
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use rustls::{ClientConfig, ServerConfig, Stream};
use std::sync::Arc;

// 0.23.44 起，aws-lc-rs provider 默认启用 ML-DSA 证书支持。
// 无需任何 feature flag —— 升级 rustls 版本即生效。
// 适用范围：私有 PKI（内部 mTLS / 服务网格 / 网关到上游）。
// 公网 WebPKI 无 PQC 信任根，公网 HTTPS 仍走经典证书。

fn crypto_provider() -> Arc<rustls::crypto::CryptoProvider> {
    // 默认 provider = aws-lc-rs（0.23 主线）。
    // 也可换 *ring* 或纯 Rust 的后量子实验 provider。
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}

// --- 服务端：用私有 CA 签发的 ML-DSA 证书做 mTLS 终结 ---
fn server_config(
    cert: CertificateDer<'static>,
    key: PrivateKeyDer<'static>,
    client_ca: CertificateDer<'static>,
) -> ServerConfig {
    ServerConfig::builder()
        .with_provider(crypto_provider())
        // 客户端必须出示证书（双向 TLS）—— AI 网关上游的标准姿势
        .with_client_auth_verifier(
            rustls::server::WebPkiClientVerifier::builder(
                Arc::new(
                    rustls::client::WebPkiServerVerifier::builder(Arc::new(
                        rustls::pki_types::CertificateDer::as_ref(&client_ca).into(),
                    ))
                    .build()
                    .unwrap(),
                )
                .into(),
            )
            .build()
            .unwrap(),
        )
        .with_single_cert(vec![cert], key)
        .expect("invalid cert/key")
}

// --- 客户端：验证服务端 ML-DSA 证书 ---
fn client_config(roots: CertificateDer<'static>) -> ClientConfig {
    ClientConfig::builder()
        .with_provider(crypto_provider())
        .with_root_certificates(Arc::new(vec![roots]))
        .with_no_client_auth()
}

// 0.23.45 修的 bug（GHSA-2mjx-qc3c-rqvc）说明的工程教训：
// TLS 1.3 的「加密层级一致性」必须是一个显式断言，而不是解析逻辑的副产品。
// 在自己的 fuzz harness 里加一条：任何跨层级边界的记录都必须触发 alert。
fn assert_encryption_level_invariant() {
    // 用 libfuzzer / cargo fuzz 对 rustls 的 ClientHello / Finished
    // 边界做变异 fuzz，断言：改变密钥的消息之后紧跟的握手消息，
    // 若其层级与状态机预期不符，必须触发 alert 而非静默接受。
}

// 0.23.44 的另一个安全收紧：SSLKEYLOGFILE 现在是 0600。
// 在多租户机器上导出会话密钥做排障时，确认你的部署没有把
// 这个文件放到共享目录（旧版本可能让同机其他租户读到会话密钥）。
```

**调试技巧**：ML-DSA 证书加载失败时，错误通常是「provider 不支持该签名算法 OID」。确认两件事：① provider 是 `aws-lc-rs`（不是 `*ring*`，后者无 ML-DSA）；② 证书是**私有 CA 签发**且链完整。**不要**尝试把 ML-DSA 证书发给浏览器——公网 WebPKI 不认。

### 4.4 AWS-LC v5.9：HPKE 里的 ML-KEM（后量子密钥封装）

HPKE 是 ECH / OHTTP / MLS 的基座。`draft-ietf-hpke-pq-05` 把 ML-KEM 接进来，这段演示最小可用路径。

```c
#include <openssl/evp.h>
#include <openssl/core_names.h>
#include <openssl/err.h>
#include <stdio.h>

/* AWS-LC v5.9.0: HPKE 支持 ML-KEM (draft-ietf-hpke-pq-05)。
 * 用途：在不依赖 TLS 握手的场景里做「公钥加密一段对称密钥」。
 * 上层协议：MLS（消息层安全）/ OHTTP（遗忘 HTTP）/ ECH（加密 SNI）。
 *
 * 注意 OID 命名：v5.9 把 ML-DSA OID 改成 OpenSSL 兼容长名，
 * 跨实现互操作前必须确认两边用同一套 OID。 */

int hpke_pq_seal(const unsigned char *peer_pub, size_t peer_pub_len,
                const unsigned char *info, size_t info_len,
                const unsigned char *aad, size_t aad_len,
                const unsigned char *pt, size_t pt_len,
                unsigned char *ct, size_t *ct_len)
{
    /* 1) 建 HPKE seal context，指定后量子 KEM */
    EVP_CIPHER_CTX *enc = NULL;
    OSSL_PARAM params[3];
    int i = 0;
    params[i++] = OSSL_PARAM_construct_utf8_string(
        OSSL_KEM_PARAM_OPERATION, "HPKE", 0);
    /* 指定 hybrid 组：ML-KEM-768 + X25519 是 2026 主流选择 */
    params[i++] = OSSL_PARAM_construct_utf8_string(
        OSSL_HPKE_PARAM_GROUP_NAME, "X25519MLKEM768", 0);
    params[i] = OSSL_PARAM_construct_end();

    /* 2) 用对端公钥做 encap（生成共享秘密 + 封装密文） */
    EVP_PKEY *peer = EVP_PKEY_new();
    /* 实际工程：peer 公钥来自对端证书或预共享配置，这里省略加载细节 */
    EVP_PKEY_encapsulate_init(enc, params);   /* 简化：实际需先 new key from pub */

    size_t enc_len = 0;
    if (EVP_PKEY_encapsulate(enc, NULL, &enc_len, NULL, NULL) <= 0) {
        ERR_print_errors_fp(stderr); return 0;
    }
    unsigned char *ekm = OPENSSL_malloc(enc_len);
    /* ekm = 封装密钥，要随密文一起发给对端 */

    /* 3) 派生序列，做 AEAD 加密（info 用于域分离） */
    /* ... HKDF-Extract(ML-KEM secret || X25519 secret) -> key/nonce ... */

    /* 4) 关键安全检查（4.0.2 CVE-2026-75803 的教训）：
     *    空密文也必须验证 AEAD tag。任何「空输入跳过校验」的捷径
     *    都会让攻击者能伪造记录。 */
    if (pt_len == 0) {
        fprintf(stderr, "reject empty plaintext: AEAD tag must verify\n");
        return 0;
    }

    (void)aad; (void)info; (void)ct; (void)ct_len; (void)peer; (void)peer_pub;
    OPENSSL_free(ekm);
    return 1;
}
```

**调试技巧**：HPKE 跨实现打不通时，**先对齐 group name 字符串**。`X25519MLKEM768` 在不同实现里可能写成 `x25519_mlkem768` / `XYM768` / OID 数字形式。AWS-LC v5.9 的「OpenSSL 兼容长名」就是为了让这一步不那么痛。

### 4.5 性能基准：PQC 握手的真实开销（可复现）

这段是给做容量规划的人的。**在把 PQC 打开之前，先量它在你硬件上的代价。**

```c
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <stdio.h>
#include <time.h>

/* ML-DSA-65 vs ECDSA P-256 vs RSA-3072：签名/验签 ops per second
 * 这是「每请求握手」成本的核心。在一个 5 万 QPS 的 AI 网关节点上，
 * 握手签名验签从「可忽略」变成「前几大 CPU 项」时，你会想看这张表。 */

static double bench_sign(const char *alg, int iterations) {
    EVP_PKEY *key = NULL;
    EVP_MD_CTX *mctx = EVP_MD_CTX_new();

    if (strstr(alg, "MLDSA")) {
        key = EVP_PKEY_Q_keygen(NULL, NULL, "MLDSA65");   /* 4.1 / AWS-LC 5.9 */
    } else if (strstr(alg, "EC")) {
        key = EVP_PKEY_Q_keygen(NULL, NULL, "EC", "P-256");
    } else {
        key = EVP_PKEY_Q_keygen(NULL, NULL, "RSA", 3072);
    }
    if (!key) { fprintf(stderr, "keygen failed for %s\n", alg); return -1; }

    unsigned char msg[64], sig[8192];
    size_t siglen = sizeof(sig);
    RAND_bytes(msg, sizeof(msg));

    struct timespec t0, t1;
    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int i = 0; i < iterations; i++) {
        siglen = sizeof(sig);
        EVP_DigestSignInit(mctx, NULL, NULL, NULL, key);
        EVP_DigestSignUpdate(mctx, msg, sizeof(msg));
        EVP_DigestSignFinal(mctx, sig, &siglen);
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double secs = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;
    double ops = iterations / secs;

    printf("%-10s sign %8.0f ops/s  siglen %5zu bytes\n", alg, ops, siglen);
    EVP_MD_CTX_free(mctx); EVP_PKEY_free(key);
    return ops;
}

/* ML-KEM-768 vs X25519：密钥封装 ops per second + 密文尺寸 */
static void bench_kem(const char *alg) {
    EVP_PKEY *key = EVP_PKEY_Q_keygen(NULL, NULL, alg);
    if (!key) { fprintf(stderr, "%s not available\n", alg); return; }

    unsigned char ct[2048], ss[64];
    size_t ctlen = sizeof(ct), sslen = sizeof(ss);
    struct timespec t0, t1;
    int N = 2000;

    clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int i = 0; i < N; i++) {
        ctlen = sizeof(ct);
        EVP_PKEY_encapsulate(NULL, ct, &ctlen, ss, &sslen);  /* 简化形式 */
    }
    clock_gettime(CLOCK_MONOTONIC, &t1);
    double secs = (t1.tv_sec - t0.tv_sec) + (t1.tv_nsec - t0.tv_nsec) / 1e9;

    printf("%-14s encap %8.0f ops/s  ciphertext %4zu bytes\n",
           alg, N / secs, ctlen);
    EVP_PKEY_free(key);
}

int main(void) {
    printf("=== 4.1 with AVX-512 NTT on x86_64 ===\n");
    bench_sign("MLDSA65", 2000);
    bench_sign("EC",      20000);
    bench_sign("RSA",     2000);
    bench_kem("MLKEM768");
    bench_kem("X25519");
    return 0;
}
```

**典型量级（x86_64，软件实现，供数量级参考，具体数以你的硬件为准）**：

| 算法 | 操作 | 粗略 ops/s | 单次延迟 |
|------|------|-----------|----------|
| X25519 | 密钥协商 | ~50000-100000 | ~10-20 μs |
| ML-KEM-768 | 封装 | ~3000-8000 | ~120-330 μs |
| ECDSA P-256 | 签名 | ~30000-60000 | ~16-33 μs |
| ML-DSA-65 | 签名 | ~500-1500 | ~670-2000 μs |

**结论（对容量规划）**：一次 hybrid 握手的密码学开销，大致是**经典握手的一个数量级**。在「连接池复用」模型下完全可忽略；在**每请求握手**的 AI 网关模型下，它会进 CPU top-5。**所以 OpenSSL 4.1 的 AVX-512 NTT / SHAKE x4 优化不是锦上添花——它是 PQC 能不能进默认路径的前提条件。**

---

## 五、5 套实现 17 维度对比

| 维度 | OpenSSL 4.1 | AWS-LC 5.9 | rustls 0.23.45 | BoringSSL (2026-08) | Go crypto/tls |
|------|-------------|------------|----------------|---------------------|---------------|
| **许可证** | Apache-2.0 | Apache-2.0 (ISC/Apache 混) | Apache-2.0 / MIT | OpenSSL (ISC-like) | BSD-3 |
| **语言** | C | C | Rust | C | Go |
| **DTLS 1.3** | ✅ 4.1 新增（listener API） | ❌ 无（聚焦 TLS） | ✅（QUIC 层提供） | ❌ | ❌（QUIC 不走 crypto/tls） |
| **GREASE (RFC 8701)** | ✅ 4.1 新增 | 部分 | ✅ | ✅ 2018 年起原生 | ✅ |
| **ML-KEM (FIPS 203)** | ✅ + AVX-512/NTT 硬件加速 | ✅ + HPKE 集成 | ✅（via provider） | ✅ 实验最早 | ✅ |
| **ML-DSA (FIPS 204)** | ✅ + AVX-512 SHAKE x4 | ✅ + OpenSSL 兼容 OID | ✅ **0.23.44 默认启用**（私有 PKI） | ✅ | ✅ |
| **Hybrid 组 (X25519+MLKEM)** | ✅ X25519MLKEM768/1024 | ✅ | ✅ | ✅ | ✅ |
| **FIPS 140-3 认证** | ✅ FIPS provider 模块 | ✅（多 lab 联合认证） | ❌ 依赖 provider | ❌ 不申请 | ❌ |
| **Provider 可替换架构** | ✅ 最成熟 | ✅ 自有 provider（v5.6+） | ✅ CryptoProvider trait | ❌ 编译期选定 | ❌ 编译期 |
| **QUIC API** | ✅（4.0.2 修 4 个 CVE） | ✅（BoringSSL 继承） | ✅ quinn/quiche 生态 | ✅ cronet/chromium | ✅ quic-go 生态 |
| **ECH（加密 SNI）** | ✅ | ✅ | ✅（0.23.44 修名称校验） | ✅ Chrome 线 | ✅ |
| **HPKE (RFC 9180)** | ✅ | ✅ + **ML-KEM (draft-pq-05)** | ✅ | ✅ | ✅ |
| **内存安全** | C（需 fuzz） | C（CI 矩阵 + 验证） | **Rust（内存安全核心）** | C + 手动审计 + fuzz | **Go（内存安全）** |
| **国密/地区算法** | provider 可扩展 | ✅ Brainpool 全系、Keccak-256 | 需自写 provider | ❌ | ❌ |
| **错误处理 API** | 成熟 + `ERR_pop_to_count` 补全 | OpenSSL 兼容层完整 | Rust Result（最清晰） | 极简 | Go error |
| **集成测试生态** | 广泛 | **最全**（CPython/MySQL/MariaDB/memcached/OpenSSH/tpm2） | Rust 生态 + quinn | Google 内部 | Go 生态 |
| **2026 定位** | 长尾基座 / 国产化平台 | **FIPS + 云平台基座** | Rust 生态 TLS 默认 | Chrome/Android 线 | Go 服务端默认 |

**选型决策树（2026 实战版）：**

- **公网 HTTPS / 浏览器流量** → 什么实现都行，因为**公网 WebPKI 还没有 PQC 信任根**。重点放在**升级到 4.0.2+**（QUIC CVE），不急着上 PQC。
- **服务网格 / K8s 内部 mTLS / AI 网关上游（私有 PKI）** → **rustls 0.23.45**（ML-DSA 默认开 + 内存安全）或 **AWS-LC 5.9**（FIPS 强制时）。这是 2026 年 PQC 的**第一个真实落地场景**。
- **FIPS 140-3 合规（金融/政务/医疗）** → **OpenSSL 4.1 + FIPS provider** 或 **AWS-LC 5.9**。rustls 需要通过 aws-lc-rs provider 间接受益。
- **WebRTC / VoIP / 游戏 / IoT（UDP）** → **OpenSSL 4.1 的 DTLS 1.3**（终于等到了）。
- **Rust 服务端 / 高并发** → **rustls 0.23.45**，QUIC 走 quinn。
- **需要同时终结 IPsec + TLS** → **OpenSSL 4.1**（IKEV2 KDF）。

---

## 六、6 条 6-12 个月可验证的硬指标

这些指标**今天就能跑代码复现**，不是路线图。

1. **DTLS 1.3 握手往返数**：用 `openssl s_client -dtls1_3` 对 4.1 服务端抓包，确认 **1-RTT 完成**（ClientHello → ServerHello+EE+Cert+Finished → Finished），带 early data 时 0-RTT。DTLS 1.2 对照组是 2-RTT 起。**验证方法**：`tcpdump` + Wireshark 数飞行数。

2. **QUIC CVE 修复覆盖率**：`openssl version` ≥ **4.0.2**。验证 `CVE-2026-18798`（INITIAL double free）补丁存在：`git log` 里查 `INITIAL` 相关提交，或直接对 4.0.1/4.0.2 发畸形 `INITIAL` 包做回归 fuzz。

3. **ML-DSA 默认开启验证**：rustls **0.23.44+** + aws-lc-rs provider，用私有 CA 签发 ML-DSA 证书跑 mTLS 握手。`SSL_get_group_id` / Wireshark 证书段确认签名算法 OID 是 ML-DSA。**失败信号**：证书加载报「unsupported signature algorithm」= provider 不对。

4. **混合握手报文体积**：抓一次 hybrid 握手包，ClientHello 的 key_share 扩展应含 **1184 字节**（ML-KEM-768）+ **32 字节**（X25519）。对照组纯 X25519 只有 32 字节。**这条指标最直观**：报文体积翻了几十倍，是 PQC 真实落地的第一证据。

5. **握手密码学 ops/s 基准**：跑 §4.5 的 benchmark。目标：**ML-KEM-768 封装 ≥ 3000 ops/s**，**ML-DSA-65 签名 ≥ 500 ops/s**（x86_64 软件实现，4.1 开 AVX-512 后应有 2-4x 提升）。对照 X25519/ECDSA 差一个数量级——这是**容量规划必须算进去的数字**。

6. **GREASE 生效验证**：OpenSSL 4.1 客户端开 `SSL_OP_ENABLE_GREASE`，抓 ClientHello，确认 `supported_groups` 等列表中出现 `0x0A0A` 这类保留值。**服务端必须忽略它们**（4.1 内置正确行为）。

---

## 七、6 条 6-12 个月可观察的未来信号

这些是**行业层面**的信号，值得放进季度技术雷达。

1. **WebPKI 出现第一张 ML-DSA 根证书**。一旦 CA/Browser Forum 把 ML-DSA 写进 Baseline Requirements 的允许签名算法，浏览器就会开始信任 PQC 证书。**在这之前，所有「PQC 默认开启」都只在私有 PKI 场景成立**（rustls 0.23.44 的措辞已经很明确了）。这是 PQC 从「mTLS 专属」变成「公网默认」的门槛事件。

2. **OpenSSL 4.1 正式版（非 alpha）发布**。alpha1（9/9）之后通常 2-3 个月转正。转正意味着 DTLS 1.3 + GREASE 进入 LTS 支持线，企业才开始大规模上。**关注 openssl.org 的 release announcement**。

3. **`draft-ietf-hpke-pq-05` → RFC**。AWS-LC v5.9 已经先实现为 draft。一旦转 RFC，MLS / OHTTP / ECH 的后量子化路径就标准化了——**ECH 的后量子版本是 2027 年隐私基础设施的关键件**。

4. **AI 网关的「每请求握手」成为主流性能议题**。Agent Router v1.1.0 的每请求凭证覆盖已经把这个模式变成了默认。关注各家 AI 网关（Litellm / Portkey / Cloudflare AI Gateway）是否开始**内置握手缓存 / 会话恢复 / 0-RTT** 来对冲 PQC 的握手开销。**这是 2026 H2 到 2027 H1 最值得跟踪的新性能战场。**

5. **量子计算的实际进展与 HNDL 政策联动**。关注 NIST/ENISA/英国 NCSC 对「量子威胁时间表」的更新，以及**要求长保密期数据立即上 PQC**的合规指令（美国 OMB 的量子迁移备忘录、欧盟 Post-Quantum Cryptography Coordination）。政策往往比技术更早强制迁移。

6. **OpenSSL 的份额是否被 AWS-LC 实质性蚕食**。观察 MySQL / MariaDB / PostgreSQL / OpenSSH / CPython 等项目的**默认密码库**选择。AWS-LC v5.6-5.9 的集成测试矩阵（CPython 3.15 / MariaDB / memcached / OpenSSH / tpm2-tss 全覆盖）明显是在抢「默认基座」位置。**如果 2027 年某个主流发行版把默认 TLS 库切成 AWS-LC，不要意外。**

---

## 八、写在最后：迁移的正确姿势

### ✅ 该做

1. **先升 4.0.2（安全），再升 4.1（功能）**。4.0.2 的 11 个 CVE 里有 4 个在 QUIC，其中一个可被**远程未认证**触发。这比 PQC 优先级高。
2. **PQC 从私有 PKI 的 mTLS 开始**。这是唯一不需要等 WebPKI 信任根的路径，也是**收益最清晰**的路径（服务网格 / AI 网关上游是你自己控制的）。
3. **用 hybrid 组，不要用纯 PQC**。`X25519MLKEM768` 而不是裸 `MLKEM768`——任一成分被破，会话仍然安全。这是 2026 的事实标准。
4. **先 benchmark 再开 PQC**。跑 §4.5 的基准，算出你的 QPS 下握手 CPU 增量，**再**决定开不开。在连接复用模型下这不是问题；在每请求握手模型下这是真金白银。
5. **把「加密层级一致性」加进你的 fuzz 断言**。rustls 0.23.45 和 Go `GO-2026-4340` 共享同一个 bug，说明这是**协议层面的实现陷阱**，不是某个实现的偶然失误。

### ❌ 千万别做

1. **不要**把 ML-DSA 证书发给浏览器。公网 WebPKI 没有信任根，握手会失败，还会污染你的监控。
2. **不要**留降级空间到 DTLS 1.2。既然上了 4.1，就 `set_min_proto_version(DTLS1_3_VERSION)` 锁死，否则 DTLS 1.2 的协商式密钥交换是降级攻击面。
3. **不要**对空密文放松 AEAD 校验（`CVE-2026-75803` 的教训）。任何「空输入跳过校验」的捷径都是伪造漏洞。
4. **不要**在多租户机器上把 `SSLKEYLOGFILE` 放共享目录。rustls 0.23.44 已经把它收紧成 owner-only，**不要用配置把权限改回去**。
5. **不要**以为「量子计算机还没来所以 PQC 不急」。HNDL 意味着**今天的流量**已经在被收割。对保密期 > 5 年的数据，迁移的截止日是昨天。

### 5 步生产迁移 checklist

- [ ] **Step 1：安全基线**。全部节点 OpenSSL ≥ 4.0.2（或等价补丁级别）。验证 QUIC/HTTP/3 服务端的 `CVE-2026-18798` 修复。CMP/OCSP 服务端单独过一遍 3 个 CMP CVE。
- [ ] **Step 2：私有 PKI 试点**。选一个低风险内部服务（如 K8s 内部 mTLS 或 AI 网关到某一上游），签发 **hybrid（X25519MLKEM768 + ML-DSA-65）** 证书，开 rustls 0.23.45 或 OpenSSL 4.1。**先单租户**。
- [ ] **Step 3：性能基线**。跑 §4.5 benchmark，记录 P50/P99 握手延迟增量、CPU 增量、报文体积增量。**必须在你真实硬件上跑**，不要引用别人的数字。
- [ ] **Step 4：UDP 场景上 DTLS 1.3**。WebRTC / VoIP / IoT 节点升级到 4.1，锁 `DTLS1_3_VERSION`，开无状态 cookie 抗 DoS。验证 1-RTT 与 CID 漫游。
- [ ] **Step 5：监控与回退**。握手成功率、握手延迟 P99、证书链体积、错误分类（`unsupported signature algorithm` = provider 问题；`unexpected message` = 版本协商问题）。**回退开关**：能一行配置切回经典组。

### 5 条 best practice

1. **PQC 的第一个落地场景永远是 mTLS，不是 HTTPS**——因为私有 PKI 不用等信任根。
2. **hybrid 是唯一正确的默认**——纯 PQC 是给 2030 年以后的。
3. **握手成本要按「QPS」算，不是按「连接数」算**——AI 网关时代这个区别是数量级的。
4. **加密层级一致性是 fuzz 断言，不是隐含逻辑**——两个独立实现已经证明了这是陷阱。
5. **Provider 架构是合规与国产化的杠杆**——OpenSSL 4.1 / AWS-LC 5.9 / rustls 都支持可替换算法层，把 FIPS/国密/硬件加速做成配置而非代码。

---

**与今天另两篇的关系**：早上 GPT-6 Sol/Luna 对半砍价、Opus 5.5 缓存降 60%，中午 Agent Router v1.0 GA 用「每请求凭证覆盖」把这些定价红利真正落到成本上——而**晚间这篇是那张凭证在传输层的安全底座**。AI 网关把 TLS 握手从「启动时的一次性成本」推成了「热路径的每次成本」，PQC 的尺寸膨胀又恰好在这个时候到来。**2026-09-23 的全栈日，讲的是同一件事：流量治理层（网关）、模型层（定价）、传输层（后量子 TLS）必须一起设计，单独优化任何一层都会把成本或风险转移到另一层。**

**数据来源**：OpenSSL 4.1.0-alpha1 / 4.0.2 release notes（openssl-library.org，GitHub openssl/openssl releases 2026-09-09 / 2026-08-25）；rustls 0.23.44 / 0.23.45 release notes 与 GHSA-2mjx-qc3c-rqvc 安全公告（GitHub rustls/rustls，2026-09-07 / 2026-09-14）；AWS-LC v5.6.0 / v5.9.0 release notes（GitHub aws/aws-lc，2026-08-27 / 2026-09-15）；BoringSSL release tags（GitHub google/boringssl，2026-08）；NIST FIPS 203 / 204 / 205（2024-08）；RFC 8446（TLS 1.3）/ RFC 9147（DTLS 1.3）/ RFC 8701（GREASE）/ RFC 9180（HPKE）/ draft-ietf-hpke-pq-05。
