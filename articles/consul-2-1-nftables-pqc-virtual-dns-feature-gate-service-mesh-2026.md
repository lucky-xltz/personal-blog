---
title: "Consul v2.1.0-rc1 深度拆解:nftables 原子化透明代理、X25519MLKEM768 后量子 mTLS、Sidecar 内虚拟 DNS 与 Raft 化 Feature Gate"
date: 2026-09-30
category: 技术
tags: [Consul, HashiCorp, IBM, 服务网格, Service Mesh, nftables, iptables, 透明代理, Transparent Proxy, 后量子, PQC, ML-KEM, X25519MLKEM768, NIST FIPS 203, TLS 1.3, Envoy, Sidecar, 虚拟 DNS, Feature Gate, Raft, API Gateway, gRPC, HTTP/2, 零接触 TLS, XFCC, RBAC, 意图, Intent, default_intention_policy, ACL, 反熵, Anti-Entropy, Federation, Inference Gateway, MCP, ai-agent, OAuth, OBO, Vault, BSL, 商业源码许可, Kubernetes, Gateway API, 服务发现, 2026]
excerpt: "2026 年 9 月 28 日(9 月 29 日 UTC 发布)Consul v2.1.0-rc1 发布,release notes 17.1KB、15 个 GitHub issue、其中 21 处标注 Enterprise only。本文拆解一条主线的四个开源可触面:① 透明代理流量重定向从 iptables/ip6tables 整体迁移到 nftables,单条 inet 规则集原子 apply,要求内核 5.2+,且不清理旧规则会造成 double NAT;② Consul Connect 侧车 mTLS 与 Agent RPC 首次支持后量子混合密钥交换 X25519MLKEM768,tls_min_version=TLSv1_3 时自动注入,旧版本 TLS 显式配置时安全跳过;③ Envoy 侧车内新增 127.0.0.1:8653 虚拟 DNS 与 :8654 递归转发,核心设计原则是「DNS 只广播 tproxy 拦截链真正会拦截的 VIP」;④ Raft 化动态 feature gate 框架 Phase 1,零值 Store fail-closed,operator CLI 带 CAS。另有一条只能讲不能摸的主线:inference-gateway + ai.role + OBO 令牌交换 + Vault 凭证注入,全部 Enterprise only,且 LICENSE 文件显示 Licensor 已是 IBM(BSL,Consul 1.17.0+,Change Date 四年后转 MPL 2.0)。每项附可运行代码、升级踩坑点与生产 checklist。"
cover: https://images.unsplash.com/photo-1635776062127-d379bfcba9e4?w=600&h=400&fit=crop
readtime: 26
author: 林小白
---

# Consul v2.1.0-rc1 深度拆解:nftables 原子化透明代理、X25519MLKEM768 后量子 mTLS、Sidecar 内虚拟 DNS 与 Raft 化 Feature Gate

> 2026 年 9 月 28 日,Consul v2.1.0-rc1 发布(GitHub releases 时间 2026-09-29T05:22:27Z)。这是 v2.0.0(2026-05-24)之后的第一个 minor,也是 IBM 完成 HashiCorp 收购后 Consul 的第二个小版本。Release notes 17.1KB,FEATURES 段 9.1KB,15 个 GitHub issue,其中 **21 处标注 `**(Enterprise only)**`**。

## 0. 一句话总结

v2.1.0-rc1 有两条主线。**明线**写在 FEATURES 段最前面:Consul 把 `inference-model` / `mcp-server` / `ai-agent` 变成服务网格的一等公民,加了一个 `inference-gateway` 网关种类,把模型能力发现、意图授权、PII 策略、OAuth On-Behalf-Of 令牌交换、Vault 凭证注入全收进 mesh。**暗线**是四个开源用户今天就能摸到的承重级改动:

| 革新 | 解决的物理/工程约束 | 一句话机制 |
|---|---|---|
| **nftables 迁移** | iptables 在现代发行版被弃用,IPv4/IPv6 两次 apply 中间窗口是部分生效故障源 | 全部规则累积成一条 nft 脚本,`nft -f -` 单次原子 apply,inet 地址族一份规则集覆盖双栈 |
| **PQC 混合密钥交换** | 抗量子计算破解的密钥交换,但手配曲线是高危操作 | `tls_min_version=TLSv1_3` 时自动注入 `X25519MLKEM768`+`X25519`,旧 TLS 版本显式配置时跳过避免握手挂死 |
| **Sidecar 虚拟 DNS(:8653/:8654)** | 透明代理模式下应用靠 DNS 解析 VIP,但 DNS 与拦截规则来自两个系统,会漂移 | xDS 直接在 Envoy 内渲染一个 UDP DNS 监听器,表只含「tproxy 拦截链确实有 filter chain 会拦」的 VIP |
| **Raft 化 Feature Gate** | 没有一等机制发布实验行为、灰度、全量升级后自动开启 | 定义进编译期注册表,策略与状态两条 Raft 记录,leader 10s 对账,agent 只认已提交快照,零值 fail-closed |

**关键洞察 1:** 这四件事不是四个独立 feature。它们是同一种工程品味的四个面:**把「靠操作者记得做对」的隐式契约,换成「系统不可能做错」的显式机制**。nftables 原子 apply 消灭的是「规则应用到一半」这个中间态;PQC 自动注入消灭的是「操作者忘记配后量子曲线」;虚拟 DNS 消灭的是「DNS 有记录但没人拦」;Raft feature gate 消灭的是「实验特性在混合版本集群里行为不确定」。Consul 在 v2.1 做的是**把可信度从文档搬到代码里**。

**关键洞察 2(诚实边界):** v2.1 的 AI 网格主线**全部 Enterprise only**——21 处标注里,inference-gateway、`ai` block、OBO 令牌交换、Vault 凭证注入、IBM Security Verify 动态客户端注册占了大半。更值得记录的是项目根目录的 LICENSE 文件:`Licensor: International Business Machines Corporation (IBM)`、`Licensed Work: Consul Version 1.17.0 or later`、Business Source License、Change Date 四年、Change License MPL 2.0。**Consul 从 1.17 起就是 BSL,IBM 收购后这条没变。** 所以本文的结构是:能跑的讲透(§3-§6),不能跑的讲清楚它的架构含义与许可边界(§2),不假装它是开源特性。

---

## 1. 背景:2026 年 Consul 的处境与这一版的位置

理解 v2.1 为什么长成这样,要先看四个背景事实。

### 1.1 版本时间线

| 版本 | 发布时间 | 定位 |
|---|---|---|
| v1.17.0 | 2023 | BSL 许可切换点(`Licensed Work: Consul Version 1.17.0 or later`) |
| v2.0.0 | 2026-05-24 | 大版本,Envoy 1.37.2、Go 1.26、HTTP server 默认超时从 30s 提到 15 分钟(阻塞查询不被打断)、api-gateway/terminating-gateway 强制路径规范化 |
| v2.0.2 / v2.0.3 / v2.0.4 | 2026-07-08 / 08-07 / 09-10 | 三个补丁版 |
| **v2.1.0-rc1** | **2026-09-29** | 本文主角,17.1KB release notes |

v2.0 到 v2.1 隔了四个月。这四个月里服务网格市场发生了几件事:Envoy Gateway v1.9 GA、Istio 1.31、Cilium 1.20 把 service mesh 能力继续往 eBPF 层压、以及所有 mesh 厂商都在问同一个问题——**LLM 推理流量要不要进 mesh**。Consul v2.1 的答案是「要,而且要 mesh 帮它做 identity + 能力发现 + 凭证」,但这个答案先给企业版。

### 1.2 许可结构:BSL + IBM + Additional Use Grant

LICENSE 文件的关键参数(原文照录):

```
Licensor:             International Business Machines Corporation (IBM)
Licensed Work:        Consul Version 1.17.0 or later. The Licensed Work is (c) 2024
                      IBM Corp.
Additional Use Grant: You may make production use of the Licensed Work, provided
                      Your use does not include offering the Licensed Work to third
                      parties on a hosted or embedded basis in order to compete with
                      IBM Corp's paid version(s) of the Licensed Work.
Change Date:          Four years from the date the Licensed Work is published.
Change License:       MPL 2.0
```

**实践含义**:内部生产使用是允许的(Additional Use Grant 明确),把它嵌入或托管成一个与 IBM 付费版本显著重叠的商业产品不行。Consul 1.17 之前的版本是 MPL 2.0,那些版本永久 MPL。**v2.1 的开源可触面(§3-§6)是真的能跑,但它们不是「Consul 开源版的新功能」——它们是 BSL 许可下的核心代码,在 Change Date 到达前不转 MPL。** 这件事很多团队的采购流程会问,先讲清楚。

### 1.3 为什么 nftables 迁移是 BREAKING 而不是 IMPROVEMENT

Release notes 里 §nftables 相关条目放在 **BREAKING CHANGES** 段第一位,不是 IMPROVEMENTS。理由很硬:

1. `consul connect redirect-traffic` 命令从调 `iptables`/`ip6tables` 改成调 `nft`,依赖从 `iptables` 二进制变成 `nft` 二进制;
2. 官方容器镜像把 `iptables` 包换成 `nftables` 包,**在镜像里写死调 iptables 的脚本会直接挂**;
3. 透明代理排他规则**校验前置**:user id 必须是数字,出站排除必须是 IP/CIDR。iptables 时代还接受用户名、UID 范围、主机名,现在一律拒绝;
4. **最危险的一条**:新命令**不会**删除旧版本创建的 iptables 规则。在已有主机/VM 上原地升级,两套规则同时在场,会出现 **double NAT 或流量重定向不一致**。

第 4 条是本次升级的头号事故源,§8 的 checklist 会给清理脚本思路。

### 1.4 一个被忽略的对照:Envoy 版本与 Go 曲线

v2.0 把 Envoy 升到 1.37.2,Go 升到 1.26。Go 1.26 的 `crypto/tls` 支持 `X25519MLKEM768`(NIST FIPS 203 ML-KEM 768 与 X25519 的混合),这是 v2.1 PQC 特性能落地的**上游前提**。PR #23884 明确写了「Curve strings are validated against supported Go runtime capabilities」——**Consul 不自己实现后量子,它只做配置面翻译与 xDS 透传**。这个判断很重要:它意味着 PQC 的正确性责任在 Go runtime 和 Envoy,Consul 的风险面只在「配置翻译有没有翻译错」。

---

## 2. 明线:AI 能力网格(Enterprise only,讲架构不讲操作)

这一节的所有内容在 release notes 里都带 `**(Enterprise only)**`。写它的目的不是让你跑,而是让你判断:**当服务网格开始承载 LLM 流量时,哪些层必须被 mesh 接管**。

### 2.1 ai block:把 AI 角色写进服务注册

```hcl
# 服务定义里声明 AI 角色(Enterprise only)
service {
  name = "billing-mcp"
  kind = "service"
  port = 8080
  ai {
    role = "mcp-server"   # inference-model | mcp-server | ai-agent
    # role 相关配置随角色不同而不同
  }
}
```

三个角色的含义:

| `ai.role` | 网格给它的东西 |
|---|---|
| `inference-model` | 被 inference-gateway 按 **capability** 发现与选择,跨 provider 按 priority 故障转移;外部模型经 terminating-gateway 代理时获得每模型独立 mTLS 传输套(每模型 SDS validation context + SNI/SAN 匹配) |
| `mcp-server` | 网格代管 OAuth 客户端生命周期:IBM Security Verify 动态客户端注册(DCR)、`private_key_jwt`、密钥轮换、JWKS 发布、SDS 投递 |
| `ai-agent` | 侧车获得 OAuth 客户端凭证(AES-256-GCM 信封,CEK 存 KV 经 `WorkloadKeyService.FetchKey` 取回),出站流量挂 `consul-obo-outbound` ext_proc 做 **On-Behalf-Of 令牌交换** |

**设计要点(不只为了功能列表):** 注意 `ai-agent` 的凭证投递用了 AES-256-GCM 信封 + KV 存 CEK + SDS 投递,而不是直接把 OAuth client_secret 塞进 xDS 资源。理由写在 release notes 里:`consul-obo-outbound` 要解密但**不能让它变成 SDS 客户端**。这是一个有意义的分层:**解密能力与配置分发能力分离**,避免一个处理流量的 sidecar 进程同时持有所有密钥材料。

### 2.2 inference-gateway:模型当一等网格公民

```hcl
# inference-gateway 配置项(Enterprise only)
kind = "inference-gateway"
name = "model-gw"
# 终止入站 mesh mTLS、执行 intentions、经 ext_proc 调同位 policy processor 做 PII 与路由策略
# 上游是 ai.role = "inference-model" 的服务,按 capability 选择、按 priority 跨 provider 故障转移
```

这个网关做四件事:终止入站 mesh mTLS、执行意图、经 ext_proc 过 PII 与路由策略、按能力选模型。**能力池里有个硬性拒绝条件值得单独记**:如果一个 capability pool 里的外部模型有两个渲染出**相同的 endpoint 地址**,或某个模型的权重无法精确表示,整个 pool 被拒绝,对应 capability route 返回 503。这是 fail-closed 设计——**在模型路由里,「两个模型指向同一个地址」是配置错误的强信号,而不是可以负载均衡的情况**。

### 2.3 terminating-gateway 的 Vault 凭证注入

```hcl
# terminating-gateway 出站凭证注入(Enterprise only)
kind = "terminating-gateway"
name = "egress-gw"
credential_injection {
  # ext_proc processor 的 UDS 路径与消息超时
}
# 关联服务声明凭证绑定:Mode = "inject",BindingID = <某个 Vault 绑定>
```

出站时 ext_proc 调同位 processor,把绑定的凭证(例如从 Vault 取的 provider API key)注入上游请求。**凭证从不存进 mesh 配置,客户端侧也看不到**。

**关键洞察 3:** §2 三件事合起来看,是 mesh 在争夺 AI 流量的三个控制点:**identity**(服务身份 + mTLS)、**credential**(短期凭证生命周期)、**policy**(意图 + PII + 路由)。这三点恰好是 AI 网关(如 09-23 那篇拆的 Agent Router / Envoy AI Gateway)也在做的事。区别是:AI 网关做在「流量入口」,Consul 做在「每一跳」。**2026 年 mesh 与 gateway 的边界正在因为 AI 流量重新谈判,这是 v2.1 的真实产业含义,而不是「Consul 也支持 AI 了」这个表面读法。**

---

## 3. nftables 迁移:一次做干净的 breaking change

### 3.1 旧的 iptables 执行器坏在哪

PR #23785 的描述很短但点到位。旧实现是**每条规则一次 `iptables` 调用**。这带来两个具体问题:

1. **IPv4 与 IPv6 分两次 apply**——IPv4 规则生效了、IPv6 还没生效的窗口内,双栈客户端的 IPv6 请求不被重定向;
2. **部分应用失败模式**——第 3 条规则 apply 失败时,前 2 条已经在内核里了。此时透明代理处于「拦了一半」的状态:部分出站流量被重定向到 sidecar,部分直发。**这是一个会产生静默错误连接的中间态,不是「全拦」或「全不拦」。**

### 3.2 新的 nftables 执行器

新包 `sdk/nftables` 保持 API 不变(`Config`、`Provider`、`Setup`、`SetupWithAdditionalRules` 全部签名兼容),换掉了实现:

| 旧(`sdk/iptables`) | 新(`sdk/nftables`) |
|---|---|
| 3 个文件,IPv4/IPv6 两个执行器 | 新原子执行器 + 非 Linux stub |
| 每规则一次 `iptables` 调用 | 规则累积成 nft 脚本,`nft -f -` 一次应用 |
| `iptables` + `ip6tables` 两次 pass | `inet` 地址族一条规则集覆盖双栈 |
| 支持用户名 / UID 范围 / 主机名做排他 | 只接受数字 UID 与 IP/CIDR |

**原子 apply 是这次迁移的实质收益**,不是「换了个语法」。`nft -f -` 把整个规则集作为一个事务提交,要么全在要么全不在,中间窗口被消除。

配套改动不止在 Consul 仓库:consul-k8s 控制面与 CNI(PRB #5554)、consul-dataplane(PR #1218)同步改。**容器镜像里 `iptables` 包被替换成 `nftables` 包**——这是 breaking 的第二个来源,因为任何在 Consul 官方镜像里写死 `iptables` 命令的自动化脚本会失效。

### 3.3 内核要求与无回退

Release notes 原文的技术约束:

> Traffic redirection now requires the `nft` binary and a Linux kernel with stateful NAT support in `nftables` `inet` family chains, available upstream starting with Linux kernel version 5.2 (some distributions backport this support onto an earlier nominal kernel version, for example RHEL 8+, kernel 4.18+, and its derivatives). **There is no automatic fallback to `iptables`/`ip6tables`**, so hosts without this kernel support will fail to set up transparent proxy redirection.

三个要点:上游内核 **5.2** 起 `inet` 族支持有状态 NAT;RHEL 8+ 名义 4.18 实际有回移植;**没有自动回退**。老内核主机不是「降级到 iptables」,而是**直接起不来透明代理**。

### 3.4 可运行代码:升级前检测与规则清理

```bash
#!/usr/bin/env bash
# upgrade-check.sh —— Consul v2.1 透明代理升级前检测
set -euo pipefail

echo "== 1. 检查 nft 二进制 =="
if ! command -v nft >/dev/null 2>&1; then
  echo "FATAL: nft 未安装。v2.1 不回退 iptables,必须先装 nftables 包"
  exit 1
fi

echo "== 2. 检查内核 inet 族有状态 NAT 支持 =="
KVER=$(uname -r | cut -d. -f1-2)
echo "kernel: $KVER  (上游 5.2+ 满足;RHEL 8+ 名义 4.18 有回移植,以实测为准)"
# 功能性验证:能否在 inet 族建一条带 NAT 的链
if nft add table inet consul_test 2>/dev/null; then
  nft delete table inet consul_test
  echo "OK: inet 表可创建"
else
  echo "FATAL: 无法创建 inet 表,nftables inet 族支持不可用"
  exit 1
fi

echo "== 3. 检查存量 iptables 规则(升级必须先清) =="
if iptables-save 2>/dev/null | grep -qi 'redirect-traffic\|CONSUL\|tproxy'; then
  echo "WARN: 检测到可能的 Consul 管控 iptables 规则"
  iptables-save | grep -i 'redirect-traffic\|CONSUL\|tproxy' || true
  echo ">> v2.1 的 redirect-traffic 不会删这些规则。两套规则同时在场"
  echo ">> 会导致 double NAT 或重定向不一致,必须先清理"
else
  echo "OK: 未发现 Consul 管控的 iptables 规则"
fi
```

```bash
#!/usr/bin/env bash
# clean-legacy-iptables.sh —— 清理旧版 Consul 透明代理规则(升级前执行)
set -euo pipefail

# v2.0 及更早的 redirect-traffic 用 iptables。升级到 v2.1 前必须移除,
# 否则新 nftables 规则与旧 iptables 规则同时在场。
# 下面是一个参考清理路径:按你实际部署的规则名调整 match 串。

TABLES="filter nat mangle raw"
for t in $TABLES; do
  # 列出所有链,清理含 CONSUL/redirect-traffic 标记的规则与自建链
  for chain in $(iptables -t "$t" -S 2>/dev/null | awk '/^:CONSUL|^:redirect/{print $2}'); do
    iptables -t "$t" -F "$chain" 2>/dev/null || true
    iptables -t "$t" -X "$chain" 2>/dev/null || true
  done
  iptables -t "$t" -S 2>/dev/null | grep -iE 'redirect-traffic|CONSUL' || true
done

# IPv6 同理
for t in $TABLES; do
  for chain in $(ip6tables -t "$t" -S 2>/dev/null | awk '/^:CONSUL|^:redirect/{print $2}'); do
    ip6tables -t "$t" -F "$chain" 2>/dev/null || true
    ip6tables -t "$t" -X "$chain" 2>/dev/null || true
  done
done

echo "== 清理后验证:不应再有 Consul 相关 iptables 规则 =="
iptables-save  | grep -iE 'redirect-traffic|CONSUL' && echo "STILL PRESENT" || echo "ipv4 clean"
ip6tables-save | grep -iE 'redirect-traffic|CONSUL' && echo "STILL PRESENT" || echo "ipv6 clean"
```

```bash
# 升级后的新流程:nftables 原子 apply
# v2.1 的 redirect-traffic 现在只接受数字 UID 与 IP/CIDR 做排他
consul connect redirect-traffic \
  -proxy-id="web-sidecar-proxy" \
  -proxy-uid="1234" \
  -exclude-outbound-port="8443" \
  -exclude-outbound-cidr="10.0.0.0/8"

# 校验变化:用户名、UID 范围(如 1000-2000)、主机名不再被接受
# 下面这种写法在 v2.1 会直接报错,而不是像 iptables 时代那样被接受
# consul connect redirect-traffic -proxy-uid="www-data"   # FAIL: 必须数字 UID

# 查看实际生效的 nft 规则集(单次 apply 的证据)
nft list ruleset | sed -n '/inet/,/^}/p' | head -40
```

**关键洞察 4:** 排他规则**校验前置**这件事值得单独强调。iptables 时代接受用户名、UID 范围、主机名,意味着规则在运行时还要做名字解析才能确定语义。nftables 版本要求**编译期就能确定语义**:数字 UID、IP/CIDR。这不是功能阉割,这是**把「运行时才能确定的策略」从安全关键路径上移出去**——一个需要解析主机名的防火墙规则,在 DNS 故障时的行为是不可预测的。

---

## 4. PQC 混合密钥交换:X25519MLKEM768 的自动注入语义

### 4.1 三个配置面

PR #23884 是 Part 1 of CSL-15591,覆盖 Consul Connect Envoy 侧车与 Consul Agent TLS。三处配置:

**(1) Agent HCL** —— 全局或按 TLS section:

| 字段 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `tls.defaults.tls_ecdh_curves` | 逗号分隔字符串 | `""`(TLSv1_3 时自动注入) | 所有 Agent TLS 监听与客户端拨号的曲线偏好 |
| `tls.internal_rpc.tls_ecdh_curves` | 同上 | 继承 defaults | 内部 RPC(server-server / client-server,8300) |
| `tls.grpc.tls_ecdh_curves` | 同上 | 继承 defaults | gRPC API 与 xDS server(8502/8503) |
| `tls.https.tls_ecdh_curves` | 同上 | 继承 defaults | HTTPS API 与 UI(8501) |

**(2) Mesh config entry** —— 按流量方向:

| 字段 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `tls.incoming.ecdh_curves` | 字符串列表 | `[]`(TLSv1_3 时自动注入) | 入站 Envoy 公共监听器 TLS 握手 |
| `tls.outgoing.ecdh_curves` | 字符串列表 | `[]`(TLSv1_3 时自动注入) | 出站 Envoy 上游集群拨号 |

**(3) Kubernetes CRD** —— 同语义的 K8s 表达。

**支持的曲线值(大小写不敏感)**:`X25519MLKEM768`、`X25519`、`P-256`、`P-384`、`P-521`。

### 4.2 自动注入与安全跳过

整个 PQC 特性最关键的设计不是「支持了新曲线」,而是**什么时候不该注入**:

```
当 tls_min_version >= TLSv1_3 且 tls_ecdh_curves 未配置
  → 自动注入 ["X25519MLKEM768", "X25519"]
当显式配置 TLSv1_2 / TLSv1_1 / TLSv1_0
  → 自动注入被安全跳过(旧 TLS 不支持混合密钥交换,注入会导致握手失败)
```

**这个「跳过」是能救命的。** 想象一个反面设计:无脑注入 `X25519MLKEM768` 到所有 `tls.Config.CurvePreferences`。任何还在跑 TLS 1.2 的存量服务(内网遗留系统、老设备)握手直接挂,而且报错信息只会说「no common curve」,排障极难。Consul 选了「显式旧版本 = 操作者知道自己在干嘛,不要打扰」。

Mesh config entry 侧的兼容矩阵略有不同:`ecdh_curves` 在 `tls_min_version` 为 `TLSv1_2`、`TLSv1_3`、`TLS_AUTO` 或未指定时被允许,在 `TLSv1_0` / `TLSv1_1` 时被拒绝。

### 4.3 可运行代码:配置与验证

```hcl
# agent.hcl —— Agent 侧后量子 TLS
tls {
  defaults {
    tls_min_version = "TLSv1_3"
    # 不写 tls_ecdh_curves,自动注入 X25519MLKEM768 + X25519
    # 显式写等价于:
    # tls_ecdh_curves = "X25519MLKEM768,X25519"
  }
  internal_rpc {
    verify_server_hostname = true
  }
  grpc {
    use_auto_cert = true
  }
  https {
    # section 覆盖:保留一条传统曲线做互操作兜底
    tls_ecdh_curves = "X25519MLKEM768,X25519,P-256"
  }
}
```

```hcl
# mesh.hcl —— Connect 侧车 mTLS 按方向配置
kind = "mesh"
type  = "service-mesh"

tls {
  incoming {
    tls_min_version = "TLSv1_3"
    tls_max_version = "TLSv1_3"
    ecdh_curves     = ["X25519MLKEM768", "X25519"]
  }
  outgoing {
    tls_min_version = "TLSv1_3"
    tls_max_version = "TLSv1_3"
    ecdh_curves     = ["X25519MLKEM768", "X25519"]
  }
}
```

```bash
# 验证侧车实际协商出的曲线(Envoy 公共监听器,通常 15000/8443 依部署)
# 用 openssl 1.1.1+ / 3.x 支持 X25519MLKEM768 的版本
openssl s_client -connect 127.0.0.1:8443 \
  -groups "X25519MLKEM768:X25519" \
  -tls1_3 2>/dev/null </dev/null \
  | grep -E 'Shared key exchange|Server Temp Key|Protocol|Ciphersuite'

# 期望看到 X25519MLKEM768 出现在协商结果里。
# 如果看到的是 X25519 而你配了 MLKEM,检查:
#   1) mesh config entry 的 tls_min_version 是不是 TLSv1_3
#   2) Envoy 版本是否支持(Go 1.26 编译的 Consul + 对应 Envoy)
#   3) xDS 里 listener/cluster 的 CurvePreferences 是否被正确翻译

# 对 Agent RPC(8300)做同样验证
openssl s_client -connect 127.0.0.1:8300 -groups "X25519MLKEM768:X25519" -tls1_3 \
  2>/dev/null </dev/null | grep -E 'Shared key exchange|Server Temp Key'
```

```python
#!/usr/bin/env python3
# check_pqc_config.py —— 自动注入语义的自检(不需要真起 Consul)
# 复刻 PR #23884 描述的注入规则,用于 CI 里校验你的 HCL 语义
from typing import List, Tuple

SUPPORTED = {"X25519MLKEM768", "X25519", "P-256", "P-384", "P-521"}
LEGACY = {"TLSv1_0", "TLSv1_1", "TLSv1_2"}


def resolve_curves(
    configured: List[str],
    min_version: str,
    auto_default: Tuple[str, ...] = ("X25519MLKEM768", "X25519"),
) -> Tuple[List[str], str]:
    """返回 (生效曲线列表, 决策理由)。复刻 v2.1 的注入语义。"""
    bad = [c for c in configured if c.upper() not in SUPPORTED]
    if bad:
        raise ValueError(f"不支持的曲线: {bad}; 支持值 = {sorted(SUPPORTED)}")

    if configured:
        return list(configured), "operator 显式配置,直接采用"

    # 未配置时的自动注入/跳过分支
    mv = (min_version or "").upper()
    if mv in ("", "TLS_AUTO", "TLSv1_3"):
        return list(auto_default), f"min_version={mv or '<未指定>'} -> 自动注入 PQC 混合"
    if mv in LEGACY:
        return ["X25519", "P-256"], f"min_version={mv} -> 旧 TLS,跳过 MLKEM 注入避免握手失败"
    raise ValueError(f"未知 tls_min_version: {min_version}")


if __name__ == "__main__":
    cases = [
        ([], "TLSv1_3"),          # 自动注入
        ([], "TLSv1_2"),          # 安全跳过
        (["P-384"], "TLSv1_3"),   # 显式覆盖
        ([], ""),                 # 未指定版本
    ]
    for cfg, mv in cases:
        curves, why = resolve_curves(cfg, mv)
        print(f"configured={cfg!s:18} min={mv or 'unset':10} -> {curves}  [{why}]")

    # mesh config entry 的兼容矩阵与 agent 不同:TLSv1_2 允许配 ecdh_curves
    # agent 侧则对旧版本直接跳过。两处差异在生产排障时容易混淆,值得写进 runbook。
    try:
        resolve_curves(["X25519MLKEM768"], "TLSv1_1")
    except ValueError as e:
        print("agent 侧旧版本约束:", e)
```

**关键洞察 5:** PQC 的正确性责任链是 **Go 1.26 `crypto/tls` / Envoy → Consul 配置翻译 → 操作者配 `tls_min_version`**。PR 原文写「Curve strings are validated against supported Go runtime capabilities」——**Consul 不实现后量子算法,它只验证并翻译**。这对升级风险评估很有用:你的 PQC 风险不在 Consul 的密码学实现,而在「Go/Envoy 版本是否支持」和「配置语义是否被正确翻译」。所以 §8 checklist 里这两条是必查项。

---

## 5. Sidecar 内虚拟 DNS:让 DNS 与拦截同源

### 5.1 问题:两个系统,一张会漂移的表

透明代理模式下,应用进程不知道 mesh 的存在。它发出一个 DNS 查询 `web.virtual.consul`,拿到 VIP,然后连这个 VIP——靠 tproxy 规则把它劫进 sidecar。问题在于:**DNS 记录来自 Consul server 的目录服务,而「哪些 VIP 会被拦截」来自 sidecar 的 xDS 快照(由意图、发现链、peering 状态共同决定)**。

这两张表来自不同系统,就会漂移:

- DNS 返回一个 VIP,但 tproxy 的 filter chain 里没有对应拦截链 → 流量直发,绕过 mesh;
- 发现链已经过期(意图刚被删,链还残留),DNS 还在返回 → 应用拿到一个「看似可用实则无授权」的地址;
- 跨分区服务配了 VIP,但本分区 tproxy 根本不拦 → DNS 给了假承诺。

### 5.2 v2.1 的解法:把 DNS 渲染进 xDS

PR #23698 直接在 xDS listener 生成里加了两个 UDP DNS 监听器:

| 监听器 | 地址 | 作用 |
|---|---|---|
| **virtual DNS(内联)** | `127.0.0.1:8653` | Envoy `dns_filter` 提供内存 FQDN→VIP 表,表来自 proxy snapshot |
| **egress DNS(可选)** | `127.0.0.1:8654` | 递归转发到 Agent 配置的 DNS recursors(用 c-ares),仅当配置了 recursors 时存在 |

**核心设计原则(直接译自 PR 描述):**

> The guiding rule: the DNS table advertises a VIP only if A's transparent-proxy listener has a filter chain that will actually intercept traffic to that VIP — so DNS and interception always stay in sync.

**DNS 只广播拦截链真正会拦截的 VIP。** 这一句是整个特性的灵魂:它把「DNS 与拦截一致性」从「两个系统尽量同步」变成「同一份 xDS 快照的两个投影」。

### 5.3 收录与排除规则(直接照录)

**收录的 FQDN(对服务 A 而言):**

- **显式上游** —— A 被直接配置去连的服务;
- **隐式 / 意图允许的上游** —— 透明代理模式下,A 经意图允许通过发现链到达的服务;
- **Peered 上游** —— 经 cluster peering 连接的服务(VIP 来自 peer 的 endpoints)。

对每一个收录项,VIP 的取法:

- 服务自身的自动分配与手动配置 VIP,**但仅当该服务与 A 同分区**;
- 上游服务本身的 VIP(发现链的主目标),不是链中其他 target 的地址。

**明确排除的:**

- 跨分区服务的自动/手动 VIP —— A 的 tproxy 不拦截它们;
- **过期/未授权的发现链** —— 例如意图被删后残留的链,或通配 watch 拉进来但实际不是上游的链(`GetUpstream` 返回 `skip=true`);
- 空 FQDN 或非 IP 的条目。

### 5.4 可运行代码

```hcl
# agent 侧需要配置 DNS recursors 才会启用 :8654 egress 转发
recursors = ["10.53.0.1", "10.53.0.2"]

# 透明代理模式注册:sidecar 才会获得 :8653 虚拟 DNS 监听器
service {
  name      = "payments"
  port      = 8080
  connect {
    sidecar_service {
      transparent_proxy = true
    }
  }
}
```

```bash
# 查询虚拟 DNS —— 注意端口是 8653,协议 UDP
dig @127.0.0.1 -p 8653 web.virtual.consul A +short

# 长名(含 datacenter / 分区)
dig @127.0.0.1 -p 8653 web.virtual.consul.dc1.consul A +short

# egress 递归转发(仅当 agent 配了 recursors,监听 :8654)
dig @127.0.0.1 -p 8654 corporate-legacy.internal A +short

# 验证「DNS 只广播会被拦截的 VIP」这条契约
# 在同一个 pod 里,先看 tproxy 实际拦截了哪些 VIP(从 xDS dump),
# 再看 DNS 表,两者必须一致
curl -s 127.0.0.1:19000/config_dump 2>/dev/null \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
# 找 dns_filter 的 inline DNS 表与 tproxy listener 的 filter chains
for c in d.get('configs', []):
    for l in c.get('dynamic_listeners', []) or c.get('static_config', {}).get('listeners', []) or []:
        n = l.get('name') or (l.get('active_state') or {}).get('listener', {}).get('name')
        if n and ('virtual_dns' in str(n) or '8653' in str(n) or 'tproxy' in str(n).lower()):
            print('LISTENER:', n)
"
```

```python
#!/usr/bin/env python3
# verify_dns_interception_invariant.py —— 校验 §5.3 的不变量
# 逻辑:DNS 表 ⊆ tproxy 拦截集合。违反 = 存在「DNS 承诺了但没拦」的假承诺。
from typing import Set


def check_invariant(
    dns_table: dict,            # FQDN -> [VIP]  (来自 :8653 dump)
    intercepted_vips: Set[str], # tproxy filter chain 会拦的 VIP 集合
    own_partition: str,
    peered_upstream_vips: Set[str],
) -> list:
    violations = []

    for fqdn, vips in dns_table.items():
        for vip in vips:
            # 规则 1: 跨分区配置 VIP 不应出现在 DNS 表里
            # (生产环境用分区标注函数判断,这里用调用方传入的集合做近似)
            if vip not in intercepted_vips and vip not in peered_upstream_vips:
                violations.append(
                    f"假承诺: {fqdn} -> {vip} 在 DNS 表里但 tproxy 不拦截"
                )

            # 规则 2: 空 FQDN / 非 IP 条目根本不该被收录
            if not fqdn or not vip:
                violations.append(f"空条目: fqdn={fqdn!r} vip={vip!r}")

    # 规则 3: peered 上游的 VIP 只能来自 peer endpoints,不能是本分区 VIP
    # (跨分区 VIP 本分区不拦截 -> DNS 承诺了假可达性)
    return violations


if __name__ == "__main__":
    intercepted = {"10.10.1.5", "10.10.1.6"}
    peered = {"10.99.2.4"}
    ok_table = {"web.virtual.consul": ["10.10.1.5"], "peer-svc.virtual.consul": ["10.99.2.4"]}
    bad_table = {"web.virtual.consul": ["10.10.1.5"], "cross-part.v.c": ["10.20.9.9"]}

    for name, tbl in [("健康表", ok_table), ("漂移表", bad_table)]:
        v = check_invariant(tbl, intercepted, "default", peered)
        print(f"{name}: {len(v)} 个违反" + ("" if not v else "\n  " + "\n  ".join(v)))
```

**关键洞察 6:** 把 DNS 塞进 sidecar 而不是继续依赖集群级 DNS,是一个**「正确性来源单一化」**的选择。代价是每个 pod 多两个 UDP 监听器、多一份内存表;收益是**「DNS 回答」与「流量是否进 mesh」这两件事再也不会给出互相矛盾的答案**。在 mesh 可观测性里最难排的一类故障——「DNS 解析正常但流量没走 sidecar」——被结构性消除。这是用一点资源换确定性。

---

## 6. Raft 化 Feature Gate:让实验特性可被运营

### 6.1 为什么要造这个轮子

PR #23791 的 Problem 段说得很直白:

> Consul has no first-class mechanism to ship experimental behavior in a release, let operators deliberately enable it after a controlled rollout, and automatically block it when the cluster has not yet fully upgraded.

**关键的一句是最后半句:automatically block it when the cluster has not yet fully upgraded。** 已有的 `experiments []string` 字段语义不同,且**背后没有持久化的集群状态**。这意味着:实验特性开关的值在不同 server 之间可能不一致(各自读本地配置),升级过程中的混合版本集群里,行为不可预测。

### 6.2 架构:五层

| 层 | 位置 | 职责 |
|---|---|---|
| **注册表与解析库** | `agent/featuregate/` | 编译期 `Definition` 记录(name / stage / min version / default / pre-min-version behavior / description / owner)。`Resolve()` 综合 定义 + 操作者/bootstrap 设置 + `ServersInDCMeetMinimumVersion` 两个布尔,产出唯一决策。**零值 `Store` fail-closed,所有特性在已提交快照到达前一律禁用** |
| **配置** | `agent/config/` | server-only HCL 块 `feature_gates { bootstrap = { "name" = "enabled"|"disabled" } }`。**仅在无策略时种子化 Raft 一次**;首次 commit 后本地配置被忽略,不一致打 warning 日志。Client agent 拒绝该块 |
| **Raft / FSM / 快照** | `agent/structs/`、`agent/consul/state/`、`agent/consul/fsm/` | 两条单例 Raft 记录:`FeatureGatePolicy`(操作者意图)+ `FeatureGateStatus`(leader 解析后的生效决策),分开存 memdb 表、独立 `ModifyIndex`。新 `MessageType` = `FeatureGateRequestType = 45`。原子 CAS:`SetPolicyAndStatusCAS`(bootstrap + operator 写)、`SetStatusCAS`(仅 reconciler) |
| **Leader 对账** | `agent/consul/leader_feature_gate.go` | 获得领导权时启动,**10 秒间隔**对账,失去领导权立即停。首次策略写在「框架版本地板」(`ServersInDCMeetMinimumVersion`)之后。**保留未知策略条目(滚动降级安全)**。陈旧对账写被 expected policy+status index fence,并发的 operator `set` 总是赢 |
| **Operator API / CLI** | `agent/consul/operator_feature_gate_endpoint.go` 等 | `consul operator feature list / get <name> / set <name> enabled\|disabled [-cas=<index>]`;HTTP `GET /v1/operator/features`、`GET /v1/operator/feature/:name`、`PUT /v1/operator/feature/:name`。读要 `operator:read`,写要 `operator:write`,**所有读支持 blocking query** |

### 6.3 一个 API 设计细节值得记

`set` 的响应**总是同时返回 desired 与 effective 状态**。所以操作者会立刻看到:

```
requested: enabled, effective: disabled, reason: below-min-version
```

而不是「设置成功」然后去别处排查为什么没生效。**这是把「灰度进行到哪一步了」变成 API 的一等返回值**,不是日志里的一句话。

### 6.4 第一个被 gate 的特性

`api-gateway-upstream-routing`(PR #23294)——API Gateway 的 HTTPRoute 与上游 service-resolver/service-router 组合能力。默认禁用,保留 legacy HTTPRoute-to-router 形状;全数据中心升级后操作者显式开启;开启后 service-router 规则与 HTTPRoute match 组合、resolver subset 定义保留、发现链 watch 用正确的 HTTP 协议覆盖;**无 agent 的 API Gateway proxy 状态在 gate 值变化时自动重建**。

### 6.5 可运行代码

```hcl
# server.hcl —— bootstrap 只在第一次种子化时生效
feature_gates {
  bootstrap = {
    "api-gateway-upstream-routing" = "disabled"
  }
}
# 注意:首次 commit 之后,这里的值会被忽略并打 warning。
# 之后改门禁只能用 consul operator feature set。
# client agent 写这个块会被拒绝。
```

```bash
# 列出所有门禁(读要 operator:read,支持 blocking query)
consul operator feature list

# 看单个门禁的 desired + effective
consul operator feature get api-gateway-upstream-routing

# 开启(CAS 安全,写要 operator:write)
consul operator feature set api-gateway-upstream-routing enabled -cas=42

# HTTP 等价形式
curl -s "http://127.0.0.1:8500/v1/operator/features?token=$CONSUL_TOKEN"
curl -s "http://127.0.0.1:8500/v1/operator/feature/api-gateway-upstream-routing?token=$CONSUL_TOKEN"
curl -X PUT "http://127.0.0.1:8500/v1/operator/feature/api-gateway-upstream-routing?token=$CONSUL_TOKEN" \
  -d '{"Enabled": true, "CAS": 42}'

# blocking query: 等 effective 状态变化(适合自动化灰度脚本)
curl -s "http://127.0.0.1:8500/v1/operator/features?index=$LAST_INDEX&wait=60s&token=$CONSUL_TOKEN"
```

```python
#!/usr/bin/env python3
# rollout.py —— 复刻 leader 对账的解析表,做灰度前预演
# 拿「多少比例 server 满足该特性的 MinVersion」直接预测 effective 状态
from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class Definition:
    name: str
    min_version: str
    default: Literal["enabled", "disabled"]
    pre_min_behavior: Literal["enabled", "disabled"]


def resolve(
    d: Definition,
    operator_request: str | None,
    servers_meet_min: bool,      # ServersInDCMeetMinimumVersion(按该特性 MinVersion 算)
) -> tuple[str, str]:
    """返回 (effective, reason)。复刻 v2.1 的决策表。"""
    desired = operator_request or d.default
    if not servers_meet_min:
        # 未达版本地板:走 pre-minimum-version 行为,不尊重 enable 请求
        return d.pre_min_behavior, f"below-min-version(min={d.min_version})"
    return desired, "operator-or-default"


if __name__ == "__main__":
    feat = Definition(
        name="api-gateway-upstream-routing",
        min_version="1.20.0",
        default="disabled",
        pre_min_behavior="disabled",   # 默认禁用 + 未升完也禁用 = 双保险
    )

    for req, upgraded in [(None, False), ("enabled", False), ("enabled", True), (None, True)]:
        eff, why = resolve(feat, req, upgraded)
        print(f"requested={str(req):10} all_upgraded={str(upgraded):6} -> effective={eff:9} [{why}]")

    # 一个反直觉但正确的点:即使 operator 已经 set enabled,
    # 只要还有一个 server 没升到 min_version,effective 依然是 disabled。
    # 这就是 "automatically block it when the cluster has not yet fully upgraded"。
```

**关键洞察 7:** 「保留未知策略条目」这条设计是**滚动降级安全**的关键。假设 v2.2 引入门禁 X,操作者在 v2.2 上 set 了 X=enabled,然后因为回归把集群降级回 v2.1。v2.1 不认识 X。如果 v2.1 把未知条目清掉,再升回 v2.2 时 X 就变回 default,操作者的显式决策被静默丢弃。**保留未知条目 = 降级不丢策略。** 这在「特性开关 + Raft 状态」的组合里是个容易漏的边界,Consul 明确处理了。

---

## 7. API Gateway 三连补齐与一个 403 回归 bug

### 7.1 HTTP/2 与 gRPC 监听器协议(PR #23784)

以前 API Gateway listener 只接受 `http` 和 `tcp`。gRPC 服务只能用 `http`,后果是上游连接被**静默降级到 HTTP/1.1**,流式 RPC 与 HTTP/2 特性全坏。v2.1 补齐:

| Listener 协议 | 下游 connection manager | 上游 cluster 协议 |
|---|---|---|
| `http` | HTTP/1.1 codec | HTTP/1.1 |
| `http2` | HTTP/2 codec | HTTP/2(`http2_protocol_options`) |
| `grpc` | HTTP/2 codec(传输层与 http2 相同) | HTTP/2(`http2_protocol_options`) |
| `tcp` | TCP proxy | TCP |

路由绑定上,`http-route` 可以绑 `http2` 或 `grpc` 任一监听器(两者互相兼容,因为都是 L7/HTTP-like);`tcp` 只能跟自己。

**此前还有两个具体毛病**:上游集群协议是 `http` 时 xDS cluster builder 不发 `typedExtensionProtocolOptions.http2_protocol_options`,强行 HTTP/1.1;路由绑定校验用严格协议相等,`http-route` 绑不到 `grpc` 监听器,产生**虚假的 `Conflicted` 状态**。

### 7.2 DNS 自动注册 + 零接触下游 TLS(PR #23647)

两件事打包:

1. **DNS 自动注册** —— API Gateway 挡着的服务自动可解析为 `<service>.api-gateway.<domain>`(以及 datacenter 作用域的 `<service>.api-gateway.<dc>.<domain>`),对齐 Ingress Gateway 的 `<svc>.ingress.consul`。除了写 gateway 与 route 配置项,**操作者无需任何动作**;
2. **零接触下游 TLS 终止** —— `api-gateway` 配置项设 `TLS { Enabled = true }` 但不挂任何 inline/文件系统/SDS 证书时,网关用自动签发的 Connect leaf 证书终止下游 HTTPS。leaf 证书带 `*.api-gateway.<domain>` 通配 DNS SAN,客户端可以直接对 Consul Connect CA 根验证,**零手工证书配置**。显式配置的证书仍然优先,作为 SNI 覆盖的独立 filter chain 与 leaf 默认链并存。

**版本安全设计(值得单独学):** 新写入**不能**在数据中心里每个 server 都理解这个特性之前 materialize `gateway-services` 行,否则混合版本 server 在 FSM 里分歧。所以有个 leader 例程 `runAPIGatewayDNSVersionCheck`。**特性受版本门控,且升级后自动回填存量 gateway**。

### 7.3 被动健康检查(PR #23783)

`PassiveHealthCheck` 加到 gateway 级默认上游限制与 route 级 service 限制覆盖里。被动健康检查就是 Envoy 的 outlier detection —— **网关层终于能配「上游连续 5xx 就先摘掉」这件事**,以前 API Gateway 缺这一块。

同时补的还有 `HTTPHeaderMatch` 的 `invert` 字段:可以写「header 不存在时路由」或「header 值不等于 X 时路由」,对齐 service-router 已有的 `Invert`。

### 7.4 XFCC 403 回归 bug(PR #23920)—— 一个新特性互相打架的案例

**这是本期最有教学价值的一条。**

#23647 给 API Gateway leaf 证书加了自动 DNS SAN。跨集群/peered 流量经 API Gateway 时,Envoy 填的 `x-forwarded-client-cert`(XFCC)头变成:

```text
By=spiffe://...;Hash=...;Subject="";URI=spiffe://<trust-domain>/ns/<ns>/dc/<dc>/svc/<svc>;DNS=gateway.default.svc;DNS=gateway.default.svc.cluster.local,By=...
```

而 `agent/xds/rbac.go:xfccPrincipal` 里校验调用方 SPIFFE ID 的正则是:

```regex
^[^,]+;URI=<idPattern>(?:,.*)?$
```

这个正则假设 `;URI=<idPattern>` 后面要么紧跟逗号(后续跳),要么到字符串结尾。**因为 #23647 在 `;URI=...` 后面紧跟了 `;DNS=...`,正则失配,目的服务的 Envoy RBAC filter 直接拒收:`rbac_access_denied_matched_policy[none]`。**

修复是一行,放宽后续分号字段:

```diff
- pattern := `^[^,]+;URI=` + idPattern + `(?:,.*)?$`
+ pattern := `^[^,]+;URI=` + idPattern + `(?:;[^,]*)?(?:,.*)?$`
```

**为什么值得记:** 两个单独看都正确的特性(自动 DNS SAN + XFCC 校验),在正则这个隐式接口上撞了。**正则把「SPIFFE ID 后面还能有什么」这个假设硬编码进了字符串,新特性加字段时没有任何编译期信号告诉你假设被违反了。** 测试侧补了 `TestXFCCPrincipal`,覆盖单跳/多跳、有/无 DNS SAN,以及三类**否定断言**:服务名前缀欺骗(`gateway2` 冒充 `gateway`)、身份不匹配、只出现在后续跳的身份。验收测试用双集群 KinD 现场复现 403,修完跑 `TestPeering_Gateway` 全套(337.67s)。

**关键洞察 8:** 这个 bug 的根因不是「谁写错了正则」,而是 **XFCC 头的解析与生成分散在两个 PR、两个子系统里,中间只有一个正则做契约**。任何「字符串拼出来的协议头解析」都有这个风险。对照 §5 的虚拟 DNS 把 DNS 与拦截收进同一份 xDS 快照、§6 的 feature gate 把策略与状态收进同一条 Raft 记录 —— **v2.1 整体在做的就是把「隐式跨子系统假设」换成「单一事实来源」**。这个 403 bug 恰好是没换掉的那一个。

---

## 8. 安全与正确性修复:一个静默授权分裂的修复

### 8.1 default_intention_policy 与 acl.default_policy 分裂(Bug Fix)

Consul servers 之前在**三个服务端面**上忽略配置的 `default_intention_policy`,退回 `acl.default_policy`:

1. 意图检查 API(`consul intention check`、`GET /v1/connect/intentions/check`);
2. 服务拓扑视图(`Internal.ServiceTopology`);
3. 透明代理上游发现(`Internal.IntentionUpstreams`)。

**影响范围有明确边界**:只有两者设成相反值时行为才变。两种具体错法:

- `default_intention_policy=deny` + `acl.default_policy=allow` → 检查 API 与拓扑视图**报告连接被允许,实际被拒绝**;
- `default_intention_policy=allow` + `acl.default_policy=deny` → 透明代理侧车**少配上游**,可能连不上它实际有权访问的服务。

**Envoy RBAC 强制执行不受影响,本来就正确 honor `default_intention_policy`。** 所以这是一个「观测面与执行面不一致」的 bug:你看拓扑视图觉得「通了」,执行层其实是 deny,或者反过来。这类 bug 在 mesh 里最难排,因为**每个单独的组件都按自己的配置正确执行**。

### 8.2 反熵同步 debounce(SECURITY 段)

`federationStateAntiEntropySync` 之前没有最小间隔。#23196 加 `FederationStateAntiEntropySyncInterval`(默认 5 秒),每次同步前检查距上次是否过了间隔;另外在 `DatacenterSupportsFederationStates()` 为 false 时**等间隔再重查**,堵住热循环。关联内部工单 SECVULN-36490。

**这是一个「贵操作没有限流」的典型**。反熵同步是全量对账,没有 debounce 时,集群状态抖动会直接变成同步风暴,吃 server CPU 与 RPC 带带。5 秒 debounce 把它从「事件驱动无上限」变成「有上限的速率」。

### 8.3 依赖 CVE

| 依赖 | 漏洞 | 性质 |
|---|---|---|
| `brace-expansion` | GHSA-rgw5-rvv9-x895 | 无界中间数组导致 DoS |
| `fast-uri` | GHSA-7p8r-x3mc-p8w7 | 反斜杠 authority introducer 造成 Host Confusion |
| `socket.io-parser` | CVE-2026-69185 | 零附件内存耗尽 |

三个都不是 Consul 协议本身的问题,是依赖链的。**注意 CVE-2026-69185 出现在服务端 UI/API 栈里**——mesh 控制面的依赖 CVE 值得单独跟,因为控制面被 DoS 会连带影响数据面配置下发。

### 8.4 其他正确性修复

- **跨集群/peered API Gateway 403**:见 §7.4;
- **`consul intention create` 走 config-entry API**:以前 CLI 用废弃的 legacy intention API,不支持非默认 admin partition(如 `-partition team-a`)。现在创建/替换走与 UI 相同的 config-entry API。`-meta` 仍走 legacy API 且**只在默认分区支持**,`-meta` 配非默认分区现在会给出清晰的报错而不是静默行为差异;
- **OBO 只挂 identity-plane 上游**:`consul-obo-outbound` 只给 `ai-agent` / `mcp-server` 身份面上游挂。显式 HTTP 上游到 inference-gateway / inference-model 目标**不再挂** consul-obo-outbound,fail-closed 报 `OBO audience not configured`(Enterprise);
- **UI 迁移 HashiCorp Design System(HDS)**:全局导航壳、面包屑、列表页(KV / peers / auth methods / services / service instances / nodes / intentions / linked services / upstreams / access control)与 access control / namespace / admin partition 表单,带一批 A11y 修复。

---

## 9. 五段可运行代码汇总

前文已给完整可跑的代码,这里做索引与「最小复现路径」:

| # | 代码 | 验证什么 | 依赖 |
|---|---|---|---|
| 1 | `upgrade-check.sh` + `clean-legacy-iptables.sh` | nft 二进制、inet 族 NAT 支持、存量 iptables 规则;升级前必须清旧规则否则 double NAT | `nft`、`iptables-save` |
| 2 | `redirect-traffic` 新调用 + `nft list ruleset` | 新的原子 apply 行为与「只收数字 UID / IP CIDR」的校验前置 | Consul v2.1 二进制 |
| 3 | agent.hcl + mesh.hcl PQC 配置 + `openssl s_client -groups` | 自动注入与旧版本安全跳过;实际协商曲线 | Consul v2.1、openssl 支持 X25519MLKEM768 |
| 4 | `check_pqc_config.py` | 不起 Consul 也能在 CI 里校验配置语义 | Python 3.9+ |
| 5 | `dig @127.0.0.1 -p 8653` + xDS config_dump 校验 | 虚拟 DNS 表 ⊆ tproxy 拦截集合的不变量 | `dig`、Envoy admin API |
| 6 | `verify_dns_interception_invariant.py` | §5.3 排除规则(跨分区 VIP / 空条目 / 过期发现链) | Python 3.9+ |
| 7 | `feature list/get/set` + HTTP + blocking query | Raft 门禁的 desired/effective 双返回与 CAS | `$CONSUL_TOKEN` 带 `operator:read/write` |
| 8 | `rollout.py` | 灰度预演:未达版本地板时 enable 请求被忽略 | Python 3.9+ |
| 9 | api-gateway http2/grpc + 零接触 TLS HCL | 端到端 HTTP/2、`<svc>.api-gateway.consul` 解析、leaf 证书通配 SAN | Consul v2.1 |
| 10 | XFCC 正则 diff 复现 | §7.4 的 403 回归根因 | 双集群 KinD(可选) |

**最小复现路径(想用一下新东西):** 起一个 `consul agent -dev`,注册一个带 `transparent_proxy = true` 的服务,`dig @127.0.0.1 -p 8653` 看虚拟 DNS 表,再 `consul operator feature list` 看 Raft 门禁。这两件事最能感知 v2.1 的架构变化,且都不需要 Enterprise 许可。

---

## 10. 五套对比表

### 10.1 服务网格对比(17 维度)

| 维度 | Consul v2.1 | Istio 1.31 | Linkerd 2.17 | Kuma 2.11 | Cilium Service Mesh(1.20) |
|---|---|---|---|---|---|
| 数据面 | Envoy 侧车 | Envoy 侧车 | 自研 Rust 侧车(linkerd2-proxy) | Envoy 侧车(DP) | eBPF + 可选 Envoy |
| 控制面存储 | Raft(内置) | istiod(Kubernetes CRD) | Kubernetes CRD | Postgres/Kubernetes | Kubernetes CRD + eBPF maps |
| 透明代理 | nftables(新,原子 apply) | iptables/IPTables CNI | linkerd-cni | iptables CNI | eBPF sock_ops / TPROUT |
| 透明代理排他规则 | 数字 UID / IP CIDR(严格) | IP CIDR | IP CIDR | IP CIDR | IP CIDR / pod label |
| mTLS 默认曲线 | X25519MLKEM768 自动注入(TLS1.3) | 需手动配 | Rust TLS,曲线固定 | 需手动配 | 需手动配 |
| 后量子支持 | X25519MLKEM768(自动) | 需 Envoy 显式配 | 无 | 需 Envoy 显式配 | 无 |
| Sidecar 内 DNS | :8653 内联 + :8654 递归 | 无(依赖 CoreDNS) | 无 | 无 | 无 |
| Feature gate 机制 | **Raft 化 + CAS + 版本地板** | Revision Tags / IstioOperator | 无 | Policy 继承 | 无 |
| API Gateway | 内置(api-gateway config entry) | Istio IngressGateway / Gateway API | 无内置 | 内置 gateway | Gateway API |
| HTTP/2 + gRPC 上游 | v2.1 补齐 | 原生支持 | 原生支持 | 原生支持 | 原生支持 |
| 零接触 TLS 终止 | leaf 证书 + 通配 SAN(新) | cert-manager 集成 | 不支持 | 需外部 | 需外部 |
| 被动健康检查 | v2.1 网关级补齐 | outlier detection 原生 | 原生 | 原生 | 原生 |
| 多集群 | cluster peering + federation | multi-cluster primary/remote | multi-cluster | multi-zone | 多集群 |
| 非 K8s 支持 | 原生(VM/裸机一等公民) | 弱 | 不支持 | 支持 | 不支持 |
| ACL 模型 | token + policy + identity | RBAC | RBAC | RBAC + MeshGateway | RBAC |
| 许可 | BSL(IBM,1.17+,4 年转 MPL) | Apache 2.0 | Apache 2.0 | Apache 2.0 | Apache 2.0 |
| AI 工作负载一等公民 | 是(Ent only:ai.role / inference-gateway) | 否(靠生态) | 否 | 否 | 否 |

**读表要点:** Consul 的差异化在**非 K8s 一等公民 + Raft 内置控制面 + 透明代理原子化 + Raft 化门禁**。Istio 的优势是生态与 Gateway API 成熟度。**许可这一行是很多团队做选型时最后才看的一行,但它决定了上面所有「Ent only」能力你能不能用。**

### 10.2 nftables vs iptables(迁移维度)

| 维度 | iptables(旧) | nftables(v2.1) |
|---|---|---|
| 应用模型 | 每规则一次调用 | 规则集脚本,`nft -f -` 单次事务 |
| IPv4/IPv6 | 两次 pass,中间有窗口 | inet 族一次,无窗口 |
| 部分失败 | 前 N 条已在内核 | 原子,全有或全无 |
| 用户态依赖 | `iptables` + `ip6tables` | `nft` |
| 内核要求 | 广泛 | 5.2+(RHEL 8+ 名义 4.18 有回移植) |
| 排他规则接受类型 | 用户名 / UID 范围 / 主机名 / IP CIDR | 数字 UID / IP CIDR |
| 语义确定时机 | 部分需运行时名字解析 | 编译期确定 |
| 回退 | — | **无自动回退** |
| 与旧规则共存 | — | **不会清理旧规则,double NAT 风险** |

### 10.3 后量子 mTLS 部署方案对比(17 维度)

| 维度 | Consul v2.1 自动注入 | Envoy 原生配置 | nginx | HAProxy | Go crypto/tls 直用 |
|---|---|---|---|---|---|
| 算法 | X25519MLKEM768 | X25519MLKEM768 | MLKEM(1.27+) | MLKEM(3.2+) | X25519MLKEM768 |
| 默认开启 | 是(TLS1.3 时) | 否,需显式 | 否 | 否 | 否 |
| 旧版本安全跳过 | 是(显式 TLS≤1.2 跳过) | 需手写条件 | 需手写 | 需手写 | 需手写 |
| 配置粒度 | 全局/section/入站/出站 | listener/cluster 级 | server 级 | bind/frontend 级 | `tls.Config` 级 |
| Mesh 感知 | 意图 + 发现链联动 | 无 | 无 | 无 | 无 |
| 版本地板 | Raft 门禁 + min_version | 无 | 无 | 无 | 无 |
| 策略持久化 | Raft(可审计) | 配置文件 | 配置文件 | 配置文件 | 代码 |
| 与 ACL 联动 | 是 | 否 | 否 | 否 | 否 |
| 互操作兜底 | 显式可加 P-256 | 显式可加 | 显式可加 | 显式可加 | 显式可加 |
| 证书体系 | Connect CA leaf | SDS / 文件 | 文件 | 文件 | 自管 |
| 升级风险 | 配置翻译错 | 直接配错 | 直接配错 | 直接配错 | 直接配错 |
| 算法实现责任 | Go runtime + Envoy | Envoy | OpenSSL/BoringSSL | OpenSSL | Go runtime |

### 10.4 DNS 解析方案对比(17 维度)

| 维度 | Consul sidecar :8653 | CoreDNS | NodeLocal DNSCache | Istio DNS proxy | K8s service DNS |
|---|---|---|---|---|---|
| 部署位置 | 每个 pod,Envoy 内联 | 集群级 DaemonSet | 每节点 | 每节点/侧车 | 集群级 |
| 数据来源 | proxy snapshot(xDS) | API server + 插件 | 上游 DNS | 集群状态 | API server |
| 与拦截一致性 | **同源(xDS 快照两投影)** | 无关 | 无关 | 一致但机制不同 | 无关 |
| 跨分区 VIP | 显式排除 | 无此概念 | 无此概念 | 无此概念 | 无此概念 |
| 过期发现链处理 | 显式排除 | 无 | 无 | 无 | 无 |
| 递归转发 | :8654(c-ares,可选) | 原生 | 原生 | 原生 | 原生 |
| 协议 | UDP | UDP/TCP | UDP/TCP | UDP/TCP | UDP/TCP |
| 网格感知 | 原生 | 需插件 | 无 | 原生 | 无 |
| 额外资源 | 每 pod 两 UDP 监听 + 内存表 | 集群级 | 每节点 | 每节点 | 无 |
| 单点风险 | 无(每 pod 独立) | 集群级 | 节点级 | 节点级 | 集群级 |

### 10.5 Feature gate / 实验特性机制对比(17 维度)

| 维度 | Consul Raft Feature Gate | Istio Revision Tags | Envoy Feature Flags | Kuma Policy 继承 | Kubernetes Feature Gates |
|---|---|---|---|---|---|
| 存储 | Raft(持久化集群状态) | CRD | 配置文件 | Postgres/CRD | API server 状态 |
| 默认禁用 | 是(零值 fail-closed) | 需显式 | 依配置 | 依策略 | 是 |
| 版本地板 | 内置(`ServersInDCMeetMinimumVersion`) | 依 revision | 无 | 无 | 依版本 |
| 滚动降级安全 | 保留未知策略条目 | revision 切回 | 配置回滚 | 策略回滚 | 依赖 API server |
| 操作接口 | CLI + HTTP + CAS | istioctl/CRD | 配置 | kumactl/CRD | `--feature-gate` |
| 审计 | Raft 日志 + blocking query | CRD 事件 | 配置 diff | 策略 diff | API server 审计 |
| desired/effective 双返回 | **是(API 一等返回)** | 否 | 否 | 否 | 否 |
| 非 K8s | 原生 | 不适用 | 原生 | 原生 | 不适用 |
| 灰度粒度 | 数据中心级 | revision 级 | 网格级 | mesh 级 | 集群级 |
| 对账周期 | 10s | 无 | 无 | 无 | 无 |

---

## 11. 六条 6-12 月可验证硬指标

1. **nftables 原子 apply 的中间态消除** —— `consul connect redirect-traffic` 在 v2.1 上执行后,`nft list ruleset` 输出应是一条完整的 inet 规则集;用 `nft -f -` 的原子语义可验证「不存在部分应用」状态。对比 iptables 时代 IPv4 已生效 IPv6 未生效的窗口(可抓包复现)。**今天就能验证:在有状态 NAT 支持的内核上跑一次,对比规则集与应用连接行为。**
2. **X25519MLKEM768 实际协商** —— `tls_min_version=TLSv1_3` 且不配 `tls_ecdh_curves` 的集群,`openssl s_client -groups "X25519MLKEM768:X25519"` 对 Agent RPC(8300)、HTTPS API(8501)、gRPC(8502/8503)与 sidecar 公共监听器的协商结果应包含 X25519MLKEM768。**显式配 TLSv1_2 的节点必须协商传统曲线,证明安全跳过生效。**
3. **虚拟 DNS 与拦截不变量** —— 同一 pod 内 `dig @127.0.0.1 -p 8653` 返回的每个 VIP,都必须能在 xDS config_dump 的 tproxy listener filter chain 里找到对应拦截链。跨分区 VIP **不应**出现在 :8653 表里。删除一个允许意图后,DNS 表里对应条目应随之消失(过期发现链被排除)。
4. **Feature gate 版本地板** —— 在混合版本集群(部分 server 未达特性 MinVersion)里 `consul operator feature set <name> enabled`,响应必须返回 `requested: enabled, effective: disabled, reason: below-min-version`。全部升级后,下一次 10 秒对账周期内 effective 应翻转为 enabled。**这条可以写成自动化灰度测试。**
5. **API Gateway HTTP/2 端到端** —— listener 协议设 `grpc` 后,上游 cluster 的 xDS dump 必须含 `typedExtensionProtocolOptions.http2_protocol_options`;gRPC 流式调用不再被降级成 HTTP/1.1 的短连接语义。`<svc>.api-gateway.consul` 应可直接解析。
6. **default_intention_policy 一致性** —— 设 `default_intention_policy=deny` + `acl.default_policy=allow`,`consul intention check` 与 `Internal.ServiceTopology` 应报告 deny(与 Envoy RBAC 一致);设成相反值时,透明代理侧车的上游配置应包含所有意图允许的上游。**升级前后各跑一次,确认三面一致。**

---

## 12. 六条 6-12 月可观察未来信号

1. **nftables 在 mesh 生态的扩散** —— istio-cni、Cilium、Kuma 的 CNI 是否跟进把透明代理规则改成 nftables 原子 apply。Consul 打了第一枪,「规则应用原子性」是可迁移的工程价值。
2. **X25519MLKEM768 成为 mesh 默认** —— 观察 Istio / Linkerd / Kuma 是否在下一个 minor 跟进「TLS1.3 自动注入 + 旧版本安全跳过」这个语义,而不只是「支持配置」。**自动注入与安全跳过是两个设计,后者更难抄。**
3. **sidecar 内 DNS 成为准标配** —— 「DNS 回答与拦截同源」这个不变量是否被其他 mesh 采用。若 Istio 跟进,说明这个模式被验证为正确性刚需而非 Consul 特有偏好。
4. **Raft 化门禁被模仿** —— 「desired/effective 双返回 + 版本地板 + 保留未知条目(降级安全)」这套组合是否出现在其他控制面。这是比 feature flag 更重的设计,只有 mesh 这类「混合版本集群普遍存在」的系统才值得。
5. **AI 工作负载进 mesh 的节奏** —— Consul 把 inference-gateway / ai.role / OBO 放进 Enterprise,观察这些能力何时下放到 BSL 核心,以及 Istio 生态是否出现等价方案(CNCF 侧已有 AI 网关项目)。**§2 的三个控制点(identity / credential / policy)会不会成为 AI 网格的事实标准分层。**
6. **BSL Change Date 的第一批到期** —— Consul 1.17 是 2023 年发布,Change Date 四年意味着 **2027 年前后开始有版本转 MPL 2.0**。观察 IBM 是否如期执行,以及届时是否会催生出一批 MPL 分叉。**这一条会实质影响 2027 年的服务网格选型。**

---

## 13. 五步生产升级 checklist

**Step 1 —— 升级前环境审计(必做)**

- [ ] 所有跑透明代理的节点:`command -v nft` 必须成功;`nft add table inet _t && nft delete table inet _t` 必须成功(验证 inet 族有状态 NAT)
- [ ] 内核版本记录:上游 < 5.2 的节点**必须先换内核或换机器**——v2.1 无 iptables 回退,这些节点升级后透明代理直接起不来
- [ ] 官方容器镜像里所有写死 `iptables`/`ip6tables` 的脚本与 entrypoint 全部改成 `nft`
- [ ] 透明代理排他规则审计:把所有用**用户名 / UID 范围 / 主机名**的排他配置改成数字 UID + IP/CIDR,否则升级后 `redirect-traffic` 直接报错

**Step 2 —— 清理存量 iptables 规则(最危险的一步)**

- [ ] 每台存量主机/VM 上跑清理脚本(§3.4),移除旧版 Consul 创建的 iptables/ip6tables 规则
- [ ] 清理后 `iptables-save | grep -iE 'redirect-traffic|CONSUL'` 与 ip6tables 同理,必须为空
- [ ] **不清就升级 = double NAT 或重定向不一致**。这是本期头号事故源,不要跳过

**Step 3 —— PQC 与 TLS 配置对齐**

- [ ] 确认 Go 版本(Consul v2.1 编译用的 Go 1.26 支持 X25519MLKEM768)与 Envoy 版本支持
- [ ] 检查所有 `tls_min_version` 配置:TLSv1_3 节点确认自动注入符合预期;显式 TLSv1_2/1.1/1.0 节点确认安全跳过(若这些节点被误注入 MLKEM 会握手失败)
- [ ] mesh config entry 的兼容矩阵与 agent 不同(`ecdh_curves` 在 TLSv1_2 也允许),两边分别验证
- [ ] 用 `openssl s_client -groups "X25519MLKEM768:X25519"` 在 8300/8501/8502/8503 与 sidecar 公共监听器各验一次

**Step 4 —— 滚动升级与门禁**

- [ ] server 先升,client 后升;升级过程中不要 `consul operator feature set` 任何东西
- [ ] 全数据中心升级完成后,`consul operator feature list` 确认 `api-gateway-upstream-routing` 的 `reason` 不再是 `below-min-version`
- [ ] 开门禁前先在测试环境跑 PR #23294 的组合场景(service-resolver subset + service-router 头部路由 + HTTPRoute)
- [ ] 验证 `default_intention_policy` 与 `acl.default_policy` 相反设置下的三面一致(§11 指标 6)

**Step 5 —— 升级后验证**

- [ ] `dig @127.0.0.1 -p 8653` 对每个透明代理服务返回 VIP,并与 xDS dump 的拦截链交叉校验
- [ ] peered 流量经 API Gateway 跨集群调用必须 200 而不是 403(§7.4 回归 bug 的回归测试)
- [ ] API Gateway `grpc` listener 的上游 cluster dump 含 `http2_protocol_options`
- [ ] `consul federation` 反熵同步的 CPU/RPC 带宽对比(5 秒 debounce 效果)
- [ ] `git log`/版本记录里记下本次升级的 LICENSE 提醒:**v2.1 的 §2 全部能力是 Enterprise only,BSL 边界在 1.17.0+**

---

## 14. 最佳实践与反模式

**✅ 该用**

- **存量主机原地升级前先清 iptables 规则。** 这是本期唯一可能造成生产事故的 breaking change,清理脚本进升级 runbook 第一步。
- **让 PQC 自动注入工作,不要手配曲线。** `tls_min_version=TLSv1_3` + 不写 `tls_ecdh_curves`,让 Consul 注入 `X25519MLKEM768,X25519`。只有在需要互操作兜底时才显式加 `P-256`。
- **显式配旧 TLS 版本时,主动确认自动注入被跳过。** 这不是「特性没生效」,是设计上的安全网。
- **用 feature gate 的 blocking query 做自动化灰度。** `?index=&wait=60s` 等 effective 翻转,比轮询日志可靠。
- **把「DNS 表 ⊆ 拦截集合」写成监控。** 这个不变量被破坏是 mesh 可达性故障的最早信号。
- **升级后跑一次 §11 的 6 条硬指标。** 每条都有明确的成功条件,不需要猜。

**❌ 千万别用**

- ❌ **不要在升级前不清理 iptables 规则。** 两套规则同时在场 = double NAT,排障极痛苦。
- ❌ **不要假设旧内核会回退 iptables。** v2.1 没有 fallback,不满足的内核直接失败。
- ❌ **不要在透明代理排他规则里继续用用户名/UID 范围/主机名。** 校验前置后这些直接报错;而且主机名排外在 DNS 故障时行为不可预测,本来就不该用。
- ❌ **不要在混合版本集群里 `feature set enabled` 然后以为生效了。** 版本地板会让 effective 保持 disabled。**看响应里的 `reason` 字段,不要只看 200。**
- ❌ **不要把 §2 的 AI 网格能力当成开源特性做技术选型。** 21 处 Enterprise only,LICENSE 是 BSL(IBM,1.17.0+)。选型时先过采购与许可。
- ❌ **不要用 `experiments []string` 做灰度了。** 它背后没有持久化集群状态,新版有 Raft 化门禁,语义完全不同。
- ❌ **不要在 `tls_min_version` 是 TLSv1_1/1.0 的地方配 `ecdh_curves` 含 MLKEM。** mesh config entry 会拒绝,agent 侧会跳过;两种行为不同,容易混淆。

---

## 15. 三个长期判断

**判断 1:nftables 原子 apply 会成为 mesh 透明代理的事实标准(12-24 月)**

「每规则一次 iptables 调用」这个模型在 IPv4/IPv6 双栈 + 部分失败场景下的中间态问题,不是 Consul 独有的。istio-cni、Cilium、Kuma 的 CNI 都在用类似的「分次 apply」模型。Consul v2.1 证明了 `nft -f -` 单次事务可以把这个中间态结构性消除,代价只是「要求内核 5.2+」——2026 年这个门槛在主流发行版上基本不存在了(连 RHEL 8 的名义 4.18 都有回移植)。**接下来 12-24 个月,预期看到其他 mesh 的 CNI 跟进。** 判据:看各项目 release notes 里是否出现「nftables migration」字样。

**判断 2:PQC 在 mesh 里的竞争点不是「支持」,是「默认语义」(6-12 月)**

X25519MLKEM768 已经在 Go 1.26、Envoy、OpenSSL 里可用。「支持」不值钱了。**值钱的是两件事:① TLS1.3 时自动注入(操作者不需要知道曲线名);② 旧 TLS 显式配置时安全跳过(不弄死存量握手)。** Consul v2.1 把这两个语义做进了 mesh 配置层。预期其他 mesh 在 6-12 个月内跟进同类「默认开启 + 向后兼容跳过」的语义;谁只做了 ① 没做 ②,会在存量集群升级时翻车。**判据:看竞品的 TLS 配置文档里是否出现「automatically injected / safely skipped」这两个词。**

**判断 3:AI 流量进 mesh 的真正承重层是 credential 与 identity,不是路由(12-24 月)**

§2 的三个控制点里,**路由(按 capability 选模型)是最容易被替代的**——任何 AI 网关都能做,而且做得更贴近模型语义。**真正难替代的是:OAuth 客户端生命周期代管(DCR + 密钥轮换 + JWKS 发布)、OBO 令牌交换、凭证不落配置只走 SDS/KV 信封**。这些是 mesh 作为「每跳 identity 层」的天然位置,也是 Consul v2.1 Enterprise 的真实护城河。**预期 12-24 个月内,AI 网关与 mesh 在「路由层」会融合、在「identity/credential 层」会分化。** 判据:看主流 AI 网关项目是否开始自己实现 OAuth client 生命周期,还是继续依赖外部 identity provider + mesh 组合。

---

## 写在最后

Consul v2.1.0-rc1 是一个**结构很清楚**的版本:明线是 AI 网格(Enterprise only,架构含义大于技术含义),暗线是四个把可信度从文档搬到代码里的改动——nftables 原子化、PQC 自动注入与安全跳过、sidecar 内虚拟 DNS、Raft 化 feature gate。加上 §7.4 那个由两个正确特性在隐式接口上撞出来的 403 回归 bug,这一版几乎可以当成一份**「隐式跨子系统假设」的案例集**:

- 想消灭「规则应用到一半」→ nftables 原子 apply;
- 想消灭「DNS 承诺了但没人拦」→ 虚拟 DNS 与拦截同源;
- 想消灭「实验特性在混合版本集群行为不确定」→ Raft 门禁 + 版本地板;
- 想消灭「操作者忘记配后量子曲线」→ 自动注入;
- 没消灭掉的那个 → XFCC 正则,于是有了 §7.4。

对要升级的团队,**最重要的一句话:升级前先清 iptables 规则,旧内核先换内核。** 其余四条承重级改动都是「配了就更安全」的类型,只有这一条是「不配就出事」。

对做技术选型的团队,先把 LICENSE 那一栏看完再决定。Consul 1.17 起是 BSL,Licensor 是 IBM,Change Date 四年转 MPL 2.0。**v2.1 的开源可触面是真的,§2 的 AI 网格能力是 Enterprise only 的,这两件事要分开评估。**

> **数据来源**:GitHub `hashicorp/consul` releases v2.1.0-rc1(2026-09-29T05:22:27Z,release notes 17,144 字符)、v2.0.0(2026-05-24);PR #23785 / #23884 / #23698 / #23791 / #23920 / #23647 / #23784 / #23294 / #23196 的 description 与 changes 段;仓库根 `LICENSE`(BSL,IBM,Consul 1.17.0+,Change License MPL 2.0)。本文所有代码示例基于这些一手描述编写,nftables 规则名与 iptables 清理脚本的 match 串需按实际部署调整。
