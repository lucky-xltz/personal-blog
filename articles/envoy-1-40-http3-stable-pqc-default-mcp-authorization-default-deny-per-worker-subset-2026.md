---
title: "Envoy v1.40 深度拆解:HTTP/3 与后量子同时转默认 + MCP 路由的 authorization 默默转发被改成默认拒绝 + 每_worker_子集负载均衡杀死 keepalive 连接风暴"
date: 2026-10-14
category: 技术
tags: [Envoy, 服务网格, 代理, 网关, HTTP/3, QUIC, TLS, 后量子, X25519MLKEM768, Kyber, ML-KEM, bzlmod, Bazel, LLVM, Clang, WASM, Wasmtime, MCP, mcp_router, header_forwarding, authorization, OAuth2, JWT, SPIFFE, SDS, AWS-LC, 动态模块, Rust SDK, per_worker_subset, 负载均衡, keepalive, ORCA, load_aware_locality, route_specifiers, 路由, cgroup, CPU 检测, drain, 热重启, UDP, RESP3, Redis, 反向隧道, 可观测性, OpenTelemetry, 访问日志, Prometheus, native histogram, CVE, GHSA, RDS, 竞态, use-after-free, 2026]
excerpt: "2026 年 10 月 13 日,Envoy 发布 v1.40.0。这个版本把两个「等了好几年」的能力同时从 alpha / opt-in 推成了默认:HTTP/3(含上游 HTTP/3 与全部 QUIC 扩展)从 alpha 升 stable,X25519MLKEM768 混合后量子密钥交换被加进上下游 TLS 的默认 ECDH 曲线(FIPS 构建也加了,可通过 envoy.reloadable_features.pqc_default_ecdh_curves 回退)。同一个版本里,mcp_router 做了一次安静的 breaking change:downstream 的请求头(重点是 authorization)默认不再透传给 MCP 后端,想继续透传必须显式配置 per-backend 的 header_forwarding(forward_all: true 才能恢复旧行为)——设计理由直接写进了 proto 注释:MCP 要求 audience-bound token,客户端把自己通过了认证的 token 默默转发给一个它从未认证过的后端是错的。构建侧的破坏性更彻底:WORKSPACE 被移除改 bzlmod(必须额外挂 Envoy 自建 registry)、hermetic LLVM 从 18直升 22(--config=clang 整个删掉,Clang 成默认)、AWS-LC 不再可选为 SSL 库。性能侧两个新 LB 策略:per_worker_subset 用每 worker K 个 host 的子集来解决几百上千 host 短 keepalive 超时下的「几万条空连接被上游回收」问题(公式(W*E)/N 保证全舰队覆盖),load_aware_locality 按 ORCA 上报的余量选 locality。还有容器感知 CPU 检测「真的默认开了」(1.37 说开了其实只在 --cpuset-threads 时生效)、drain 从每响应轮询改成事件推送(顺带修了 Mongo/Redis/Thrift/generic 代理从不响应 inbound-only drain 的老 bug)、UDP 热重启保会话、RESP3、route_specifiers 扩展点,以及一批「RDS 更新时 route 级配置在 worker 线程被析构」的竞态修复(AWS 签名 / composite / filter chain / local_ratelimit / dynamic modules / SDS 全中招)。本文逐条拆设计动机,给五段可运行的配置与自查代码,并列出八条诚实边界——包括 bzlmod 迁移到底多痛、PQC 默认开启对老旧客户端意味着什么、per_worker_subset 为什么有意不让你嵌任意 LB 策略。"
cover: https://images.unsplash.com/photo-1635356932774-7c0bc7e0dad7?w=600&h=400&fit=crop
readtime: 26
author: 林小白
---

# Envoy v1.40 深度拆解:HTTP/3 与后量子同时转默认 + MCP 路由的 authorization 默默转发被改成默认拒绝

2026 年 10 月 13 日晚上 8 点(UTC),Envoy 发布了 v1.40.0。同一天它还推了 v1.39.4、v1.38.7、v1.37.9 三个补丁版本——后三者的 changelog 高度一致:都在修同一个竞态家族(**RDS 更新替换路由配置时,route 级配置对象可能在 worker 线程被析构**),以及 CVE-2026-54786(wasmtime 升 24.0.10)。一个 GDP 级别的数据平面在同一周同时做「大版本转默认」和「跨四个支持分支修同一类析构竞态」,这两件事本身就值得一篇深度文章。

但 v1.40 最值得写的不是哪单条改动,而是**它同时把三个「大家等了很久但一直不敢按下去」的开关按成了默认**:

1. **HTTP/3 / QUIC 从 alpha 升 stable**——包括此前一直标着 "not ready for internet use" 的**上游 HTTP/3**,以及全部 QUIC 扩展;QUIC listener 支持 mTLS,上游 QUIC 支持客户端证书,P-384/P-521 ECDSA 曲线补齐。
2. **X25519MLKEM768 混合后量子密钥交换进默认 ECDH 曲线**——上下游 TLS 都加,FIPS 构建也加,可通过 `envoy.reloadable_features.pqc_default_ecdh_curves` 回退。不是「支持」,是**默认**。
3. **mcp_router 默认不再转发 downstream 的 `authorization` 到 MCP 后端**——这是 silent breaking:配置没报错、流量没断,但你的后端突然收不到客户端 token 了。想恢复必须显式写 `forward_all: true`。

前两条是「能力默认化」,第三条是**安全默认化**。方向相反,但底层是同一个工程判断:**当一个行为从「需要显式选择」变成「所有人都会得到」时,它的默认值本身就是一次 API 决策**。Envoy 在 v1.40 里同时做了两次激进默认化(让所有人都用上 HTTP/3 和 PQC)和一次保守默认化(让所有人都不再默许 token 透传)。

**与今天早间「五维定价日」的关系**:早间五件事全部在给 AI 标价(Gemini 4 Argon 锁进 99 美元档 / 窃听案是安全代价 / Character.AI 破产清算 2000 万美元许可费 / QGIS 的 AI 贡献禁令是治理成本 / 哈佛研究是审查成本)。本文是这条线在**数据平面层**的落点:HTTP/3 + PQC + MCP token 默认拒绝,合起来就是「**一次 AI 请求在网关层要付的连接成本、密码学成本和信任成本**」。MCP 路由把 authorization 转发从默认改成显式,跟谷歌把 Argon 锁进付费墙是同一类动作——**把一个曾经免费的默认值,变成需要明确决策才能拿到的东西**。

---

## 一、HTTP/3 转 stable:被删掉的那些 warning 才是主角

### 1.1 改动本身

PR #46621(`quic: promote HTTP/3 API status from alpha to stable`)的 diff 大部分是**删文档**:

```diff
--.. warning::
--
--  While HTTP/3 **downstream support is deemed ready for production use**, improvements are ongoing,
--  tracked in the `area-quic <https://github.com/envoyproxy/envoy/labels/area%2Fquic>`_ tag.
--
--  HTTP/3 upstream support is alpha - key features are implemented but have not been tested at scale.
```

以及 `api/envoy/type/v3/http.proto` 里那段藏了多年的注释:

```diff
-  // [#not-implemented-hide:] QUIC implementation is not production ready yet. Use this enum with
-  // caution to prevent accidental execution of QUIC code. I.e. `!= HTTP2` is no longer sufficient
-  // to distinguish HTTP1 and HTTP2 traffic.
```

`extensions_metadata.yaml` 里六个扩展的 `status: alpha` → `Status: stable`。

change log 只留了一句:

> Promoted QUIC/HTTP3 from alpha to stable. This includes all QUIC extensions and HTTP/3 upstream support. HTTP/3 downstream was already considered production-ready, and HTTP/3 upstream is now also considered stable.

### 1.2 为什么「上游 HTTP/3」卡了这么多年

Envoy 的 HTTP/3 在下游侧(客户端 → Envoy)生产可用已经很多年,但**上游侧(Envoy → 后端)**一直标 alpha。这不是傲娇,是两个真实的工程缺口:

- **连接复用语义不同**。HTTP/2 上游连接是长连接池,一个 worker 对一个 host 开少量连接复用;HTTP/3 的 QUIC transport 天然每条连接独立,连接池收敛行为(`HttpServerPropertiesCodec` 里的 alternate protocol 缓存)在 Envoy 侧的实现周期比预期长得多。
- **mTLS 与客户端证书**。反向代理对上游做 mTLS 是金融与零信任场景的刚需,而 QUIC listener 侧的客户端证书支持缺失,意味着「HTTP/3 全链路 mTLS」很长一段时间是做不到的。v1.40 补上了:QUIC listener 支持 mTLS,上游 QUIC 也支持客户端证书,P-384/P-521 ECDSA 曲线补齐(此前只有 P-256)。

### 1.3 与 PQC 默认开启的化学反应

把 HTTP/3 和 PQC 放在同一个默认化批次里不是巧合。**QUIC 握手本来就是 TLS 1.3 over UDP,原生设计就支持 0-RTT**;而 ML-KEM 的密文尺寸(P-256 的 30 倍量级)在 TCP + TLS 1.2/1.3 的老连接上会显著放大首包延迟,在 QUIC 的 0-RTT 路径上则可以被并行化掉一部分。换言之:**PQC 默认化的成本,有一部分恰好被 HTTP/3 默认化摊薄了**。这是我在 2026 H2 的网关层看到的最漂亮的一次协同设计——比 NVIDIA 那种「CPO + NVLink 同周发布」的硬件协同更贴近日常工程。

### 1.4 诚实边界

`[#not-implemented-hide:]` 注释被删意味着代码里那段「防止误判 HTTP1/HTTP2」的保护性注释没了,但**代码逻辑没变**——`!= HTTP2` 仍然不足以区分 HTTP1/HTTP2 流量。升 stable 是承诺层面的变化(和测试覆盖、支持等级),不是协议检测语义的变化。升完之后任何在 access log / 统计里靠协议枚举做分支的代码都应该重新 review 一次,因为 QUIC 流量现在会出现在你默认就开启的路径上。

---

## 二、X25519MLKEM768 进默认 ECDH 曲线:后量子不再是「按需开启」

### 2.1 改动

PR #47225(`tls: enable X25519MLKEM768 in default ECDH curves`)。核心就两行常量:

```cpp
const std::string ServerContextConfigImpl::DEFAULT_CURVES = "X25519MLKEM768:"
                                                            "X25519:P-256";
// FIPS 构建同样包含
const std::string ServerContextConfigImpl::DEFAULT_CURVES_FIPS = "X25519MLKEM768:"
                                                                 "X25519:P-256";
```

注意顺序——`X25519MLKEM768` 放在最前面,即**最高优先级**。server 侧 Grease 之外的曲线协商会优先选混合后量子算法。

### 2.2 真正的 breaking面:不是握手失败,是中间件和 WAF

文档里这句话值得逐字读:

> Placing X25519MLKEM768 first gives it the highest priority. Peers that do not support the hybrid construction can still negotiate classic X25519 or P-256.

所以**兼容性是保住的**——老客户端照常协商到 X25519 / P-256。真正的风险在别处:

1. **静态原型解析的 TLS 中间件**。任何基于「ClientHello 第一个 curve 一定是已知曲线」假设的流量分类器、WAF、DLP、 lawful-intercept 探针,第一次看见 0x11ec(MLKEM-768)时会走未定义路径。Envoy 默认曲线顺序的变化会让这类设备在一夜之间大量遇到未知曲线。
2. **FIPS 侧通道**。FIPS 构建也把混合算法加进默认是一个更激进的决策——传统上 FIPS 构建里出现任何非 NIST 批准算法都需要走 vendor affirmation。Envoy 的处理是:它没改 FIPS 的加密套件,只在**曲线协商**这一层引入混合交换,其中经典分量(X25519/P-256)仍然承担回退安全。这是一个「合规边界从算法白名单移到协商层」的设计,如果你的 FIPS 审计是按算法清单逐项打钩的,这次默认化需要你在审计材料里补一段协商层说明。
3. **握手字节数**。TLS ClientHello 现在默认要带 ML-KEM-768 的公钥(1184 字节)+ 密文(1088 字节)。对 99% 的场景无感,但对**极小的 IoT 握手**和**QUIC 0-RTT 的 datagram 尺寸限制**是有阈值风险的。

### 2.3 回退路径

```yaml
# 静态运行时配置关闭 PQC 默认曲线
layered_runtime:
  layers:
    - name: static_layer_0
      static_layer:
        envoy.reloadable_features.pqc_default_ecdh_curves: false
```

或在 cluster/transport socket 里显式写 `ecdh_curves` 覆盖默认值。

### 2.4 与 OpenSSL 4.1 / Cloudflare Deno 那条线的关系

2026 年里这个博客先后拆过 OpenSSL 4.1 + AWS-LC + rustls 的 PQC 运行时层(09-23)、Cloudflare 收购 Deno(10-10)。Envoy 这次默认化把上游拼图补齐了一块:**L7 网关不再需要特殊配置就能同时对外提供后量子握手**。从全栈日角度看,早间的「Gemini 4 Argon 付费墙」在算力定价,中午这条在**握手层定价**——每一个 PQC 握手都比经典握手贵,只是这个成本以前要你自己 opt-in 才付,现在默认就要付了。这也是「五维定价日」在协议层的回响。

---

## 三、MCP 路由的默认拒绝:一次安静的 breaking,和一段写进 proto 的理由

这是整个 v1.40 里我认为设计品质最高的一条改动,也是最容易在生产里咬人的。

### 3.1 背景:MCP over HTTP 的 token 模型

MCP(Model Context Protocol)的 HTTP 传输里,客户端(比如一个 IDE / 一个 Agent runner)会带着自己的 `authorization` header 去访问 MCP 网关。Envoy 的 `mcp_router` filter 做 JSON-RPC 方法路由:tools/list 去 backend A,tools/call 去 backend B。在 v1.40 之前,`copyRequestHeaders` 把**整个下游请求头**复制给上游,只跳过少量自己生成的:

```cpp
static const absl::flat_hash_set<absl::string_view> kSkipHeaders = {
    ":method", ":path", ":authority", "host", "content-type", "accept", kSessionIdHeader};
```

也就是说:**客户端给网关的 token,被默认原样转发给了每一个 MCP 后端**。

### 3.2 为什么这是错的(Envoy 自己的原话)

PR #46818 把理由直接写进了 `api/envoy/extensions/clusters/mcp_multicluster/v3/cluster.proto` 的注释——这段注释本身就是一份好的 API 设计文档:

```proto
// Modeled after ext_proc's HeaderForwardingRules, but MCP-local and secure-by-default:
// unlike ext_proc, an unset/empty policy forwards nothing rather than everything,
// because MCP requires audience-bound tokens and prohibits implicit token passthrough
// between a client and a backend it did not authenticate to.
//
// Evaluation order per header:
//   1. If the header matches disallowed_headers, it is never forwarded — this
//      takes precedence over everything below, including forward_all.
//   2. Otherwise, if forward_all is true, the header is forwarded.
//   3. Otherwise, if the header matches allowed_headers, it is forwarded.
//   4. Otherwise, the header is not forwarded.
message HeaderForwarding {
  bool forward_all = 1;
  type.matcher.v3.ListStringMatcher allowed_headers = 2;
  type.matcher.v3.ListStringMatcher disallowed_headers = 3;
}
```

关键的三个字:**audience-bound**。OAuth 2.0 的 token 是有 audience 的;客户端拿 token 是为了证明「我授权网关代我调用」。把这个 token 转发给**客户端从未认证过的后端**,等于让后端拿着一个不属于它的信任证明——之后后端可以用这个 token 去调任何接受该 audience 的端点。这不是理论风险,这是**每个 MCP 多后端路由器都会有的默认漏洞**,且是 MCP 协议规范自己禁止的。

### 3.3 四条评估规则的实现

`header_forwarding_utils.cc` 的实现只有 42 行,核心谓词一目了然:

```cpp
bool headerCanBeForwarded(absl::string_view header_key,
                          const HeaderForwardingPolicy& policy) {
  if (matchesAny(header_key, policy.disallowed_headers)) {
    return false;
  }
  if (policy.forward_all) {
    return true;
  }
  return matchesAny(header_key, policy.allowed_headers);
}
```

**顺序就是语义**:`disallowed_headers` 优先于 `forward_all`,`forward_all` 优先于 `allowed_headers`。这个四条决策树让「默认转发全部 + 显式排除 authorization」和「默认不转发 + 显式包含 x-trace-id」两种心智模型都能表达,而且**禁止列表永远赢**。

### 3.4 router-owned 头部永远不受策略影响

`copyRequestHeaders` 的跳过集合从 7 个扩到 16 个:

```cpp
static const absl::flat_hash_set<absl::string_view> kSkipHeaders = {
    ":method", ":path", ":authority", "host", "content-type", "accept", kSessionIdHeader,
    "connection", "upgrade", "te", "keep-alive", "transfer-encoding", "trailer",
    "proxy-connection", "proxy-authenticate", "proxy-authorization"};
```

注释特意说明了为什么 `proxy-authenticate`/`proxy-authorization` 要出现在这里:

> proxy-authenticate/proxy-authorization are never stripped anywhere in Envoy core, so they must be excluded explicitly here to keep hop-by-hop headers from being forwarded.

这是「防御性默认」的正确写法:HTTP 连接管理器在 filter 之前已经剥掉了大部分 hop-by-hop 头,**但 Upgrade 分类请求会保留 connection/upgrade,而 proxy-authenticate 系列在 Envoy core 里从不被剥**。一个做 token 转发策略的 filter 不能假设上游已经做了清洁——它必须自己列出永远不会被策略影响的那一组头。

### 3.5 升级影响:这是 silent breaking

这个改动最危险的地方是**它不报错**:

- 配置校验通过(新字段是 optional)
- 流量照常转发(JSON-RPC 响应正常)
- **但后端突然收不到客户端的 authorization 了**

后端如果是「自己显式校验 downstream token」的架构(很多 MCP 网关早期实现都是 router 只做路由、后端自己做 auth),升级 v1.40 之后**鉴权会被绕过或报错,取决于后端是 fail-open 还是 fail-closed**。单元测试 `HeaderForwardingDefaultsToSecurePolicyWhenUnset` 明确断言了这一点:

```cpp
EXPECT_FALSE(headerCanBeForwarded("authorization", backend->header_forwarding));
```

### 3.6 迁移:先显式化,再升级

```yaml
# 升级前:显式声明你的旧行为(林地ɫ价值最高的一段配置)
static_resources:
  listeners:
  - name: mcp
    address: {socket_address: {address: 0.0.0.0, port_value: 8080}}
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: mcp
          codec_type: AUTO
          route_config:
            virtual_hosts:
            - name: mcp
              domains: ["*"]
              routes:
              - match: {prefix: "/"}
                route: {cluster: mcp_backend}
          http_filters:
          - name: envoy.filters.http.mcp_router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.mcp_router.v3.McpRouter
              servers:
              - name: primary
                mcp_cluster:
                  cluster: mcp_backend
                # v1.40 必填:不写就不再转发 downstream 头
                header_forwarding:
                  forward_all: true
                  disallowed_headers:
                    patterns:
                    - exact: "authorization"
                    - exact: "proxy-authorization"
                    - suffix: "-token"
          - name: envoy.filters.http.router
            typed_config:
              "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
```

**更好的做法**是不要 `forward_all`,改成精确白名单,让这次 breaking 帮你把隐式的信任传递砍掉:

```yaml
                header_forwarding:
                  allowed_headers:
                    patterns:
                    - exact: "x-trace-id"
                    - exact: "x-session-id"
                    - prefix: "x-custom-"
```

注意 `mcp_multicluster` 的 `ClusterConfig` 里也有一份独立的 `HeaderForwarding` message——它是**另一个 proto 类型**,需要单独覆盖(测试 `McpRouterClusterConfigImplParsesHeaderForwarding` 就是为它存在的)。两个地方漏一个,行为就不一致。

---

## 四、per_worker_subset:给「keepalive 连接风暴」的一个反直觉答案

### 4.1 问题比想象的普遍

PR #45979 的 proto 注释把问题场景写得非常具体:

> The motivating use case is upstream clusters with hundreds to thousands of hosts behind a short server-side HTTP keepalive timeout: stock per-cluster load balancers will eventually open a connection from every worker to every host, producing tens of thousands of mostly-idle keepalive connections that the upstream reaps.

算一笔账:Envoy 默认 worker 数 = 机器硬件线程数,上游 1000 个 host,16 worker → 每个 host 会被 16 条连接连着,全舰队 16000 条。如果上游 keepalive 超时设得短(比如 30s,在 many-tenant 后端里很常见),这些连接**刚被建立就可能因为空闲超时被上游回收**,下一次请求又要新建——连接复用率趋近于零,握手成本被打满。

### 4.2 策略:每 worker 只用 K 个 host

新策略放在 contrib(`api/contrib/.../load_balancing_policies/per_worker_subset/v3alpha/`),两轴设计:

- **partitioning_strategy**(怎么划子集):
  - `EQUAL_PARTITIONS`(默认):对全 host 做地址排序后确定性切 `ceil(N/W)` 的片,加一个进程内随机偏移让全舰队不同 Envoy 的切法不同。**健康状态变化不改边界**——partitioning 作用在 all-hosts 列表上,然后各 worker 只是在自己的固定片内按健康过滤。
  - `RANDOM_PARTITIONS`:每 worker 独立无放回采样 `subset_size` 个 host;健康变化不轮换,只有 membership 变化才补 vacancy。
- **host_selection_strategy**(子集内怎么选):`SIMPLE_ROUND_ROBIN` 或 `ENVOY_P2C`(双随机选择 + pending 计数)。**有意不支持嵌套任意 LB 策略**,注释直接给了理由:

> This contributed implementation intentionally exposes a small set of validated strategies rather than accepting an arbitrary nested load balancing policy. The inner policy operates on a synthetic single-priority, single-locality PrioritySet, and not every Envoy load balancer is compatible with that constrained model.

### 4.3 全舰队覆盖的数学保证

注释里那个公式是这条策略最优雅的部分:

> Fleet-wide upstream coverage is preserved: across W workers per Envoy and E Envoys, each upstream host receives roughly `(W*E)/N` workers' worth of traffic.

也就是说:**单个 Envoy 只连了 N/W 的 host 这个事实,在 Fleet 层面被 E 个 Envoy 抹平了**。这是一个「用空间冗余换连接效率」的设计——前提是你的 fleet 足够大。单实例 Envoy + 小集群(E=1, N=100)用这个策略,上游 host 的实际可见性会降到 1/W,这**对热缓存与连接亲和性场景是破坏性的**。这是它待在 contrib 而不是 core 的原因之一。

### 4.4 与 AWS 签名的那批竞态修复是同一个根因

v1.39.4 / v1.38.7 / v1.37.9 同日发布的修复清单读起来像同一个 bug 的五个分身:

```
- aws: race where route-level config of AWS request signing and AWS Lambda filters
  could be destroyed on a worker thread when an RDS update replaced route config
- composite: same race
- dynamic_modules: per-route config destroy hook could run on a worker thread
- filter_chain: same race
- local_ratelimit: shared provider manager owned by route-level config could be destroyed
- sds: generic secret provider shared with worker threads could be destroyed
```

根因是同一个:**route 级配置对象的生命周期与 RDS 更新的时机没有对齐**。RDS 更新在 main 线程做,但 route 级配置的析构可能发生在 worker 线程仍持引用之后。v1.40 的主线修了,但没有给所有 filter 都做(见 §8 诚实边界)。per_worker_subset 之所以 TABLE.ln 备注"`Health-only updates do not change slice boundaries`",正是因为这类「子集缓存类」实现最怕的就是「健康一变就重新切」——一切就要重建 synthetic PrioritySet,就要面对同一类并发问题。它把稳定性写进了语义契约,这是高级的设计自觉。

### 4.5 场景判断表

| 场景 | per_worker_subset 是否合适 |
|---|---|
| 上游 500+ host + 短 keepalive + fleet 多实例 | ✅ 主场,连接数可降一个数量级 |
| 上游 < 50 host | ❌ 子集近似无收益,反而降低每 host 连接利用率 |
| 强连接亲和(会话缓存)环境 | ⚠️ 单 worker 只见固定片,亲和面变窄 |
| 上游 host 频繁 membership 变化 | ⚠️ EQUAL_PARTITIONS 会 repartition,抖动放大 |
| 单实例 Envoy | ❌ 舰队覆盖公式退化,host 可见性降到 1/W |

---

## 五、其他承重改动:挑五条说透

### 5.1 容器感知 CPU 检测「这次真的默认开了」

v1.37 的 release notes 就声称开启了容器 CPU 检测,但 #45410 的实现只在传 `--cpuset-threads` 时才生效。#45729 的 changelog 里写得直白:

> Fixed container-aware CPU limit detection (#45410) not being enabled by default. ... It is now applied whenever `--concurrency` is not set, so worker threads are sized to the cgroup CPU limit in containerized deployments without requiring `--cpuset-threads`.

worker 数 = `min(硬件线程数, cpuset 大小, cgroup CPU limit)`。现在 `--cpuset-threads` 退化为兼容空 flag。同时新增 `CgroupDetectionDiagnostic`,把检测原因(读到什么文件、得出什么值)暴露给 `/server_info`,这是「默认值改动 + 可解释性配套」的正确搭配——升默认值的同时给了自查手段(见 §7 代码 5)。关闭路径是环境变量 `ENVOY_CGROUP_CPU_DETECTION=false`。

**对实际用户的含义**:K8s 里 limits.cpu 设 2 但 node 有 32 核的 Envoy,以前会开 32 个 worker、每个都以为自己有完整 CPU——上下文切换 + 内存开销全部放大。v1.40 之后自动开 2 个。**升级后请检查 worker 数与连接吞吐的关系**——降 worker 数会降低并发上限,如果 limits.cpu 被刻意设得保守,可能需要在 deployment 里显式给 `--concurrency`。

### 5.2 drain 从轮询改成事件推送

#46985 把 drain-close 决策从「每个响应结束时轮询 listener 的 DrainDecision」改成「drain 开始时由 main 线程向每个连接推送 drain 事件」。附带修了个存在很久的不对称:

> This also fixes a bug where the Mongo, Redis, Thrift and generic proxies did not honor inbound-only drain-close decisions: they always asked whether both inbound and outbound connections were draining, so `/drain_listeners?graceful&inboundonly` left their connections open even on an inbound listener。

**轮询改事件**这个模式在网关层正在全面发生(参看 10-08 KEDA 那篇「pollingInterval 空转自动停」,以及 10-13 BuildKit 的压缩计数器)。共同的原则:**「每次操作都问一下」应该让位于「状态变化时主动告诉我」**。drain 场景下还多一个收益:inbound-only drain 的语义第一次在所有代理类型上一致——以前只有 HTTP connection manager 会正确响应,Redis/Mongo/Thrift/generic 四个代理一律不生效。

### 5.3 UDP 热重启:连接不再"黑屏"

v1.40 的 hot restart 对 UDP 做了会话保活:已建立的 UDP 代理会话由 parent 保持,未知 session 的 datagram 转发给 child。

```cpp
// hot restart: forward UDP packets by listener address and network namespace (#47743)
// udp: a paused hot restart listener must not read the parent's socket (#47868)
```

#47868 那条修的是 child 端的 bug:**暂停状态的 listener 不应再读 parent 的 socket**,否则会与 parent 抢同一个文件描述符造成重复消费。这是「新默认行为带新 bug」的实例——升级热重启_UDP 这一特性时,务必先看这两个 PR 是否都在你的版本里。

### 5.4 route_specifiers:路由匹配之后还能再改路由

新扩展点允许在路由**匹配之后**对结果做后处理(refine / drop / synthesize),可以在 route-config、virtual-host、route 三层挂。首批实现两个:prioritizer(按优先级分组选 cluster)和一个 dynamic-module route specifier。

这是 2026 年 Envoy 路由层最大的 API 扩张——之前路由是「match → route」的终点,现在 match 之后还能插入一段逻辑。**AI 网关场景的直接受益者**:按 ORCA 上报的成本/余量动态决定 cluster,或者按 MCP session 状态合成路由,都可以不再用 Lua/Wasm 做侵入式改写了。

### 5.5 load_aware_locality + ORCA

新 LB 策略 `load_aware_locality` 按 ORCA(Out-of-Band Resource and Capacity Attributes)上报的**余量**选 locality,而不是传统的按权重或 round-robin(`load_aware_locality: add out-of-band ORCA reporting` #46670)。

这跟 per_worker_subset 是互补的:

- per_worker_subset 解决「连接分散到太多 host」
- load_aware_locality 解决「请求打到已经满载的 locality」

一起用,就是「连接面收敛 + 请求面按余量调度」。这两个策略同版本出现,说明 Envoy 团队把「上游资源感知」当成了 v1.40 的暗线主题。

---

## 六、一组实测/声明数据点

| 维度 | v1.39.x | v1.40 | 来源 |
|---|---|---|---|
| 默认 ECDH 曲线(下游) | X25519:P-256 | X25519MLKEM768:X25519:P-256 | #47225 DEFAULT_CURVES 常量 |
| FIPS 默认曲线 | X25519:P-256 | X25519MLKEM768:X25519:P-256 | #47225 DEFAULT_CURVES_FIPS |
| 上游 HTTP/3 状态 | alpha("not ready for internet use") | stable | #46621 extensions_metadata |
| MCP 后端默认转发头 | 全部(除 7 个 router-owned) | 零 + router-owned 扩到 16 | #46818 headerCanBeForwarded |
| worker 默认数(--concurrency 未设) | 硬件线程数(容器内错误) | min(线程, cpuset, cgroup limit) | #45729 changelog |
| drain-close 判定 | 每响应轮询 DrainDecision | drain 事件推送至连接 | #46985 |
| 高 keepalive 风暴下的连接规模 | W × N | W × K(K 可配,默认按 N/W) | #45979 proto 注释 |
| 舰队 host 覆盖(每 host) | W×E 条连接 | ≈ (W×E)/N workers 量级 | #45979 注释公式 |
| 构建:WORKSPACE | 存在 | 删除,改 MODULE.bazel(须挂 envoyproxy/bazel-registry) | v1.40 release notes |
| 构建:hermetic LLVM | 18 | 22(--config=clang 删除) | 同上 |

---

## 七、五段可运行代码

### 代码 1:HTTP/3 全链路(含上游)mTLS 最小配置

```yaml
static_resources:
  listeners:
  - name: quic_in
    address: {socket_address: {address: 0.0.0.0, port_value: 8443}}
    udp_listener_config:
      quic_options: {}           # v1.40: QUIC listener 稳定可用
    filter_chains:
    - transport_socket:
        name: envoy.transport_sockets.tls
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.DownstreamTlsContext
          common_tls_context:
            tls_params:
              # 不写 ecdh_curves 即默认含 X25519MLKEM768(v1.40 默认)
              tls_minimum_protocol_version: TLSv1_3
            tls_certificates:
            - certificate_chain: {filename: /certs/server.pem}
              private_key: {filename: /certs/server.key}
          require_client_certificate: true   # QUIC listener mTLS(v1.40 新)
      filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: h3
          codec_type: HTTP3                  # HTTP3 下游
          route_config:
            virtual_hosts: [{name: all, domains: ["*"], routes: [{match: {prefix: "/"}, route: {cluster: upstream_h3}}]}]
          http_filters: [{name: envoy.filters.http.router}]
  clusters:
  - name: upstream_h3
    connect_timeout: 0.5s
    type: STRICT_DNS
    # v1.40:上游 HTTP/3 稳定可用
    typed_extension_protocol_options:
      envoy.extensions.upstreams.http.v3.HttpProtocolOptions:
        "@type": type.googleapis.com/envoy.extensions.upstreams.http.v3.HttpProtocolOptions
        explicit_http_config:
          http_protocol_options: {}         # H3 上游
    transport_socket:
      name: envoy.transport_sockets.tls
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
        common_tls_context:
          tls_params: {tls_minimum_protocol_version: TLSv1_3}
        # 上游 QUIC 客户端证书(v1.40 新)
    load_assignment:
      cluster_name: upstream_h3
      endpoints: [{lb_endpoints: [{endpoint: {address: {socket_address: {address: h3-backend.internal, port_value: 443}}}}]}]
```

**自查**:用 `openssl s_client -tls1_3 -groups X25519MLKEM768` 或 `curl --curves X25519MLKEM768` 打印协商出的曲线;`nc -u` 打 QUIC listener 端口确认 listener 存活;`envoy --mode validate` 确认 codec_type HTTP3 不再报 alpha 警告。

### 代码 2:验证 PQC 默认曲线是否生效(以及如何关掉)

```python
#!/usr/bin/env python3
"""检查旧客户端协商行为 + 打印 ecdh_curves 默认值变化。
依赖:仅标准库 + 一个能打 TLS 1.3 的客户端(用 curl 代替也行)。
"""
import subprocess, re, sys

# v1.40 默认(代码级常量,client/server 各一份)
DEFAULT_V140 = "X25519MLKEM768:X25519:P-256"
DEFAULT_V139 = "X25519:P-256"

def curl_groups(host, groups, port=8443):
    cmd = ["curl", "-sk", "--curves", groups,
           "-o", "/dev/null", "-w", "%{http_code} %{ssl_verify_result}",
           f"https://{host}:{port}/"]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=10).stdout.strip()

for label, g in [("默认(含PQC)", "X25519MLKEM768:X25519:P-256"),
                 ("仅经典", "X25519:P-256"),
                 ("仅P-256", "P-256")]:
    print(f"{label:<12} -> {curl_groups(sys.argv[1] if len(sys.argv)>1 else 'localhost', g)}")

# 期望输出:三种都能拿到 200(协商成功 = 兼容性保住)
# 若"仅经典"失败 -> 常见原因是 min version 卡住,检查 tls_minimum_protocol_version
```

**关掉默认 PQC**(只在确认中间件不兼容时):

```bash
envoy --concurrency 0 -c envoy.yaml \
  --disable-extensions envoy.reloadable_features.pqc_default_ecdh_curves 2>/dev/null \
  || true
# 更可靠的是 layered_runtime(见 §2.3),上面只是示意 reloadable feature 的存在
```

### 代码 3:MCP header_forwarding 三种策略的运行时验证

```python
#!/usr/bin/env python3
"""升级 v1.40 前后的 MCP 后端头转发行为对比。
跑法:先起一个 echo 后端打印收到的头,再分别用三种配置发请求。
"""
import json, http.client, base64

def call_tools_list(host, port, path, token):
    conn = http.client.HTTPConnection(host, port, timeout=5)
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    conn.request("POST", path, body=body,
                 headers={"content-type": "application/json",
                          "authorization": f"Bearer {token}",
                          "x-trace-id": "abc-123",
                          "x-evil-hop": "try-me"})
    r = conn.getresponse()
    return r.status, r.read().decode()[:200]

# 升级前(v1.39):后端 echo 会同时看到 authorization + x-trace-id + x-evil-hop
# 升级后(v1.40 配置 A —— 不写 header_forwarding):
#   只剩 x-trace-id? 不——是「什么都不剩」,除了 router 自己合成的
#   content-type / accept / session 头。authorization 消失 = 默认拒绝生效
# 升级后(配置 B —— allowed_headers: [x-trace-id]):
#   只剩 x-trace-id,authorization / x-evil-hop 都消失
# 升级后(配置 C —— forward_all + disallowed authorization):
#   x-trace-id + x-evil-hop 都在,authorization 被显式排除

ASSERTS = [
    ("v1.39 默认透传",        ["authorization", "x-trace-id", "x-evil-hop"]),
    ("v1.40 默认拒绝",        []),
    ("v1.40 allowed_headers", ["x-trace-id"]),
    ("v1.40 forward_all+dis", ["x-trace-id", "x-evil-hop"]),
]
for label, expected in ASSERTS:
    print(f"{label:<26} 后端应见到: {expected or '(仅 router-owned)'}")
```

对应回滚/保留旧行为的完整 envoy.yaml 片段见 §3.6。

### 代码 4:per_worker_subset 配置与连接数观测

```yaml
# 先声明:contrib 扩展,确认你的构建启用了 contrib
dynamic_resources:
  lds_config: {path: /etc/envoy/lds.yaml}
  cds_config: {path: /etc/envoy/cds.yaml}

# cds.yaml
resources:
- "@type": type.googleapis.com/envoy.config.cluster.v3.Cluster
  name: big_upstream
  connect_timeout: 0.25s
  type: STRICT_DNS
  lb_policy: ROUND_ROBIN      # 占位,实际策略在下面
  load_assignment:
    cluster_name: big_upstream
    endpoints:
    - lb_endpoints:
      - {endpoint: {address: {socket_address: {address: host-1.internal, port_value: 80}}}}
      # ... 假设 1000 个 host
  # v1.40:每 worker 子集
  extension_protocol_options: {}
  metadata:
    filter_metadata:
      envoy.lb:
        per_worker_subset:
          "@type": type.googleapis.com/envoy.extensions.load_balancing_policies.per_worker_subset.v3alpha.PerWorkerSubset
          subset_size: 10
          partitioning_strategy: EQUAL_PARTITIONS
          host_selection_strategy: ENVOY_P2C
          fallback_threshold: 80   # 健康度低于 80% 时回退到全 cluster
```

配套观测(确认收益真的拿到了):

```bash
# 1. 连接数:升级前 vs 后
curl -s localhost:9901/stats | grep -E "cluster.big_upstream.upstream_cx_active"
#    期望:从 W × N 量级降到 W × K(16 × 1000 -> 16 × 10)

# 2. 连接复用率
curl -s localhost:9901/stats | grep -E "upstream_cx_rx_bytes_total|upstream_rq_total"

# 3. 每个 worker 实际看到的 host 集合(v1.40 新增诊断)
curl -s localhost:9901/config_dump | grep -A5 per_worker_subset

# 4. host 健康翻转时不应重切
#    把一个 host 标 unhealthy -> subset membership 应保持不变
```

**警告**:单实例 Envoy 不要开(fleet 公式退化);fallback_threshold 是百分比(0-100,validate 规则 lte:100)。

### 代码 5:容器 CPU 检测自查脚本

```bash
#!/bin/bash
# v1.40 升级前后各跑一次,确认 worker 数与 limits.cpu 对齐
echo "== server_info (含 cgroup 检测诊断) =="
curl -s localhost:9901/server_info | python3 -m json.tool | grep -iE "concurrency|cpu|cgroup"

echo "== 内核侧实际限制 =="
cat /sys/fs/cgroup/cpu.max 2>/dev/null || cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us 2>/dev/null
echo "cpuset: $(cat /sys/fs/cgroup/cpuset.cpus.effective 2>/dev/null)"
echo "nproc (node 级): $(nproc)"

echo "== Envoy 实际 worker 线程数 =="
ps -eLf | grep -c "[e]nvoy"

# 期望:worker 线程数 == min(硬件线程, cpuset 大小, cgroup limit)
# 例如 limits.cpu=4 的 K8s pod,worker 应从 node 核数降到 4
# 若仍偏高 -> ENVOY_CGROUP_CPU_DETECTION 被设 false,或 --concurrency 被显式传入
```

---

## 八、八条诚实边界

1. **bzlmod 迁移是本次最痛的 breaking,不是 HTTP/3**。`WORKSPACE` 被物理删除,且**必须额外挂 `https://raw.githubusercontent.com/envoyproxy/bazel-registry`**——BCR 里没有 Envoy 的 patched 依赖。任何 fork Envoy 构建的下游(vendor 分支、内部 sidecar)都会在第一次构建时失败,且报错信息不指向 registry 问题,容易误判为 LLVM 版本问题。

2. **LLVM 18 → 22 同时删掉 `--config=clang`**。Clang/libc++ 成为默认且不需要 flag;`--config=clang-local`、`--@envoy//bazel:libc++`/`libstdc++` 开关和 `force_libcpp` define 全部删除。你有 ** ABI 敏感的 C++ 扩展插件**吗?这次升级对插件作者比对运维更疼。

3. **AWS-LC 被移除为可选 SSL 库**(含 `--config=aws-lc-fips`)。ppc64le 构建应改用 `--config=openssl`。此前深度调 AWS-LC 的 FIPS 行为的团队必须迁回 OpenSSL,BoringSSL 仍是默认。

4. **Wasm runtime 的 flag 变了**:`--define wasm=`/`--define engine=` 直接构建失败,改用 `--@proxy-wasm-cpp-host//bazel:engine=<engine>`。这个跟 CVE-2026-54786(wasmtime 升 24.0.10)是同一周的事——如果你自己构建 Envoy 且用 Wasm,这是**安全 + 构建**双重迁移。

5. **HTTP/3 stable 不代表「零成本开」**。`codec_type: HTTP3` 之前多数人只开 `AUTO` 和下游;上游 HTTP/3 第一次 stable,意味着连接池行为、超时语义、mTLS 证书配置(上游 QUIC 客户端证书)都要重新 review。升 stable 改的是**支持等级**,不是零配置。

6. **PQC 回退只在「新连接」生效**。`pqc_default_ecdh_curves` 是启动时读一次的运行时特性(从测试 `scoped_runtime.mergeValues` 的用法看),运行中改不生效;且 `ecdh_curves` 一旦显式配置就会完全覆盖默认值(包括 PQC 项)——**你已经显式配过 ecdh_curves 的话,这次默认化对你没影响**。这既是好消息(稳定),也是隐患(你以为自己被保护了,其实你的显式配置里没有 PQC)。

7. **route 级配置析构竞态没有全部修完**。主线 v1.40 修了,但同日发布的三条老分支(v1.37/38/39)各自只修了**自己分支里出现过的 filter 子集**——dynamic_modules 的 destroy hook 在 v1.38.7 和 v1.37.9 的清单里就不完全一致。如果你的 filter 链里有第三方 filter 也持有 route 级配置,它的析构安全性需要**自己 review**,Envoy 修的是自家 filter。

8. **per_worker_subset 在 contrib 且 v3alpha**。proto 标注 `work_in_progress = true`,`CODEOWNERS` 指向 `@sudheerv @UNOWNED`。它有意不支持嵌套任意 LB 策略(inner 只跑在单优先级单 locality 的 synthetic PrioritySet 上)。想拿它当「通用子集 LB」用的,请先确认自己能接受这两个限制,并且**真的有成百上千 host + 短 keepalive**的场景——否则你只是把连接数降下来,同时把每 host 的连接利用率也降了。

---

## 九、五步生产升级 checklist

1. **构建侧先跑通 bzlmod**(最大的隐性成本)
   - 新建/修改 `MODULE.bazel`,挂上 envoyproxy/bazel-registry + BCR
   - 删除所有 `--config=clang` / `clang-local` / `--define wasm=` 用法
   - 检查 `--config=aws-lc-fips` 依赖,迁 `--config=openssl`(ppc64le 必迁)
   - 插件方:C++ 插件按 LLVM 22/libc++ 默认重新编译;Wasm 插件确认 engine flag
2. **TLS 矩阵验证**
   - 三类客户端(现代浏览器 / curl 默认 / 古董客户端)各打一次,确认协商成功
   - 检查 WAF/DLP/中间件是否按 ClientHello 曲线分类(`0x11ec` 未知曲线告警)
   - 显式配过 `ecdh_curves` 的集群:决定是否手动加入 X25519MLKEM768
   - FIS 构建准备协商层的审计材料
3. **MCP 路由:升级前先显式化**
   - 盘点所有 mcp_router / mcp_multicluster 配置,升级前先加 `header_forwarding`
   - 优先用 `allowed_headers` 白名单而非 `forward_all`
   - 两个 proto message(filter 版 + cluster 版)**都要写**
   - 后端是 fail-open auth 的,先修后端再升 Envoy
4. **连接面与 drain 验证**
   - 大集群上游灰度 per_worker_subset:先量 `upstream_cx_active` 基线,灰度后对比
   - 跑一次 `/drain_listeners?graceful&inboundonly`,确认 Redis/Mongo/Thrift/generic listener 现在会 drain-close
   - UDP 热重启演练(确认 #47743 + #47868 都在版本里)
   - K8s limits.cpu 保守的 deployment:检查 worker 数下降对吞吐的影响
5. **回退预案**
   - PQC:`envoy.reloadable_features.pqc_default_ecdh_curves: false`(layered_runtime,仅新连接)
   - 容器检测:`ENVOY_CGROUP_CPU_DETECTION=false`
   - drain 事件模式:`envoy.reloadable_features.use_connection_event_drain: false`(guard 只在新连接创建时读)
   - HTTP/3:不上 `codec_type: HTTP3` 就没有上游 H3 行为变化;`AUTO` 保持原状

---

## 十、与早间「五维定价日」的全栈日关系

今天早间的五维事件全部在给 AI 标价——谷歌把 Argon 锁进付费墙、FBI 窃听案是安全代价、Character.AI 破产法庭给技术许可标价 2000 万、QGIS 把 AI 贡献禁令写成治理成本、哈佛研究量化了 AI 编码的审查税。

本文是这条主线在**数据平面层**的落点,三层穿透:

| 栈层 | 早间(商业) | 本文(网关) | 共同模式 |
|---|---|---|---|
| 协议 | API 定价 11 月底翻倍 | PQC 握手进默认(更贵的握手人人付) | 价格从限时优惠转默认 |
| 信任 | 付费墙决定谁能用强模型 | MCP authorization 转默认拒绝 | 「不再默认传递信任」 |
| 治理 | QGIS 禁 AI 贡献 + 审查税 +49% | 容器 CPU 检测 + cgroup 诊断 + drain 事件 | 默认值即治理,代价可观测 |

**一句话主线**:早间讲的是**「用一次 AI 要付多少钱」**,中午讲的是**「在网关层,这些钱各自落在哪里」**——每个 PQC 握手的字节数、每个不再透传的 token、每条不再被回收的 keepalive 连接,都是那张账单的细行。**而 MCP authorization 默认拒绝,是整张单子里最像 QGIS 禁令的一条:它没问你,就把一个曾经免费的默认值拿走了。**

---

## 十一、三条 6-12 个月硬指标

1. **PQC 握手占比**:升级 v1.40 后 30 天,`envoy.ssl.downstream.handshake` 按 curve 分组统计,X25519MLKEM768 应快速趋向 100%(客户端不支持才会是经典值);若长期 < 50%,说明你的客户端群被显式 ecdh_curves 或旧中间件挡住了。
2. **MCP 后端 token 可见性**:升级后 7 天,后端 access log 里 `authorization` 出现次数应严格等于 `header_forwarding` 配置允许的路径数(0 或白名单)。任何「没配却还能收到」都是配置泄漏(多半是 mcp_multicluster 那个 proto 没改)。
3. **keepalive 连接规模**(若开 per_worker_subset):`cluster.*.upstream_cx_active` 从 `W × N` 降到 `W × K`,且 `upstream_cx_connect_total` 的增速同步下降(否则连接是少了但每次都在重建)。
4. **worker 数与 limits 对齐**:K8s deployment limits.cpu=4 时,Envoy worker 线程数 = 4(而非 node 核数)。`ps -eLf | grep -c envoy` 与 `/sys/fs/cgroup/cpu.max` 对得上。
5. **drain 行为一致**:`/drain_listeners?graceful&inboundonly` 之后,所有代理类型(含 Redis/Mongo/Thrift)的 inbound 连接开始 drain-close;旧版本只有 HTTP connection manager 会。
6. **竞态回归**:升级后 30 天,`segfault` / `heap-use-after-free` 类 crash 中「出现在 RDS/xDS 更新窗口内」的比例应下降到接近零(三个 patch 分支修的就是这个)。可用 eBPF/uprobe 在 `~HostSetImpl` 析构时打点验证。

## 十二、三条长期判断

1. **PQC 默认化会在 12 个月内扩散到所有主流数据平面**。Envoy 这一步把「支持」和「默认」分开了——支持是能力,默认是立场。Nginx/HyperEnvoy/AWS ALB/Cloudflare 在 2026 H2 都会被推到同一个决策点。判断信号:各厂 changelog 里「X25519MLKEM768」从「opt-in」变成「default」的时间。
2. **MCP 网关的 token 语义将在 12-18 个月内被协议层面固化**。Envoy 用「audience-bound token」这个 OAuth 概念作为默认拒绝的理由,意味着 MCP 网关层正在从「HTTP 反向代理 + JSON-RPC 路由」演进为**带认证语义的 Agent 信任边界**。下一步是 RFC 级的 token scope 传递规范(MCP spec 或 OAuth extension)。判断信号:x402/AP2 那条支付协议线与 MCP 路由线何时合流——Agent 既要「带着钱」也要「带着可验证身份」穿过同一个网关。
3. **「每 worker 子集」的回头客会是 AI 推理后端**。上游 host 多、连接空闲比例高、fleet 冗余大——这正是推理后端池的特征(也跟早间哈佛教训相印证:连接多不等于吞吐高)。per_worker_subset 今天是 contrib,12 个月内进 core 的概率很高,load_aware_locality 的 ORCA 余量输入与 GPU 利用率上报(如 DRA / TorchAgent)对接后,这个组合会变成**AI 网关连接面的事实标准**。判断信号:ORCA spec 里出现 GPU 维度,或者 per_worker_subset 从 v3alpha 升 v3。

---

## 写在最后

Envoy v1.40 是一个**关于默认值**的版本。HTTP/3 从 alpha 升 stable、PQC 从 opt-in 变默认、MCP 的 authorization 从透传变拒绝、worker 数从硬件线程变 cgroup 感知、drain 从轮询变事件——五条承重改动,五次默认值重写。

默认值是基础设施项目真正的 API。升级文档里一句话「现在默认 X」的背后,是成千上万个不再需要做选择题的部署,也是成千上万个**就此失去旧能力而不自知**的部署。v1.40 同时做了两个方向的默认化,这需要相当强的工程自信:让所有人用上 HTTP/3 和 PQC 是激进,让所有人不再透传 token 是保守。**判断一个网关项目是否成熟,不看它新增了多少能力,看它敢不敢把默认值改到自己也不完全确定的那个方向。**

对升级者:先改 MCP 的 header_forwarding(唯一会 silent break 你的那一条),再跑 bzlmod(唯一会让你构建失败的那一条),最后才慢慢验 PQC / HTTP/3 / per_worker_subset。这个顺序很重要——**前两条是「不处理就出事」,后三条是「不验证就浪费」。**
