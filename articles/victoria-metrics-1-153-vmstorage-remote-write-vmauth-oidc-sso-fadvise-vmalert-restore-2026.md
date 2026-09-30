---
title: "VictoriaMetrics v1.153.0 深度拆解:vmstorage 直写 Remote Write、vmauth 原生 OIDC SSO、zstd 导入内存预算与把访问模式声明给内核"
date: 2026-09-30
category: 技术
tags: [VictoriaMetrics, VictoriaMetrics v1.153.0, vmstorage, vminsert, vmagent, vmauth, vmalert, vmui, Prometheus, Remote Write, remote write v1, enableIngestionAPI, OIDC, SSO, OAuth2, Authorization Code Flow, JWT, claim, JWKS, OIDC Discovery, zstd, native format, 解压放大, OOM, GHSA, 安全漏洞, 内存预算, memory.allowedPercent, fadvise, POSIX_FADV_RANDOM, madvise, MADV_RANDOM, read-ahead, page cache, 内核 I/O, ALERTS, ALERTS_FOR_STATE, 告警状态恢复, pending, firing, unix socket, umask, stream aggregation, 服务发现, http_sd_configs, extra_label, extra_filters, alert_relabel_configs, 时序数据库, TSDB, 可观测性, 云原生, CNCF, Go, 集群架构, 存算分离, 高可用, 2026]
excerpt: "2026 年 9 月 25 日(9 月 28 日上架 GitHub Releases)VictoriaMetrics v1.153.0 发布。这个版本的六件事全都在「把隐式假设变成显式声明」:vmstorage 第一次能直接吃 Prometheus Remote Write v1(-enableIngestionAPI),vmagent 把分片、复制、重试、持久队列全搬到边缘,一个 vmstorage 宕机不再卡住整个 vminsert 的写入(issue #11252,makasim 与 valyala 讨论后只做 remote write 不加额外端点);vmauth 内建 OIDC SSO(Authorization Code Flow + session cookie + JWT claim 复用),第一次不需要 oauth2-proxy 或 pomerium 侧车(issue #10278,2026-01-12 提出要了 9 个月);两个安全修复同时落在「解压」和「重定向」这两个最容易被信任的输入上 —— zstd 编码的 native import 块以前不套内存上限,恶意构造请求就能在导入期把内存打穿(GHSA-8g4f-32hw-vqf8),OIDC Discovery 的 HTTP 客户端重定向不限制在原请求主机内(GHSA-xxqh-2hcc-9fp6);vmstorage/vmsingle 加了 opt-in 的 fadvise(FADV_RANDOM)/madvise(MADV_RANDOM) 提示,把「内核替你猜访问模式」变成「应用告诉内核我是随机读」,只加在数据文件上不加在索引文件上(issue #11461);vmalert 重启后恢复告警状态时跳过冗余的 pending 中间态,不再向 ALERTS 和 ALERTS_FOR_STATE 写出会被自己立刻覆盖的抖动值(PR #11401,顺带把 restore 查询时间点从 ts-1s 改回 ts、删掉一处不必要的互斥锁)。支线五个修复同样扎心:unix socket 从硬编码 0600 改成按进程 umask 创建;stream aggregation 把上一版加的并行化退回串行,因为省下的延迟可忽略却多费 CPU;vmagent 的 *_sd_config 返回空响应时陈旧 target 永不消失(v1.130.0 起的回归);空 extra_label/extra_filters 查询参数直接报错,跟官方安全文档推荐的「用空值覆盖客户端参数」写法自相矛盾;alert_relabel_configs 热重载静默失效。本文按写路径、认证面、内核 I/O 三条线拆完六个承重级革新,每项附可运行配置与生产升级建议。"
cover: https://images.unsplash.com/photo-1635776062127-d379bfcba9e4?w=600&h=400&fit=crop
readtime: 26
author: 林小白
---

# VictoriaMetrics v1.153.0 深度拆解:vmstorage 直写 Remote Write、vmauth 原生 OIDC SSO、zstd 导入内存预算与把访问模式声明给内核

> 2026 年 9 月 25 日,VictoriaMetrics v1.153.0 发布。看完 release notes 的第一感受是:这个版本没有加任何让人眼前一亮的「新能力」,但它把六个**长期靠「约定俗成」或者「外挂一个组件」扛过去的隐式假设**,全部翻出来改成了显式声明。
>
> 这六件事可以串成一句话:**在 2026 年的指标规模下,「谁负责声明」比「谁负责执行」更重要。** 写入可用性由谁声明(中心化的 vminsert,还是每个 vmagent 自己的持久队列);访问控制由谁声明(静态 Basic Auth,还是 IdP 签发的短时 token);解压时的内存由谁声明(请求体大小,还是解压后的实际体积);磁盘访问模式由谁声明(内核的 read-ahead 启发式,还是应用自己的 fadvise);告警中间态由谁声明(重启必然经历的 pending,还是「状态可恢复就直接进 firing」);连 socket 的权限由谁声明(硬编码 0600,还是进程 umask)。

---

## 一、问题的源头:写路径的中心化与认证面的外部依赖

要理解 v1.153.0 为什么同时动写路径和认证面,先要看清这两个面在 2026 年各自被逼到了什么程度。

### 1.1 写路径:一个 vminsert 卡住,整条采集链路断在原地

VictoriaMetrics cluster 的经典拓扑是三段式:

```
vmagent / vminsert 客户端  →  vminsert (8480)  →  vmstorage (8482) × N
                                     ↓
                              vmselect (8481)
```

`vminsert` 在这个拓扑里承担三件事:**分片**(按 metric name + labels 哈希到某个 vmstorage)、**复制`(RF > 1`)、**重路由**(某个 vmstorage 慢或不可用时,把它那份写请求改发给其他节点)。

重路由是这套设计里最巧妙也最危险的一环。巧妙在于它让写入在单节点故障时仍然成功;危险在于**它破坏了「哪些数据落在哪个节点上」这个不变量**。当 vmstorage 节点短暂慢了一下,vminsert 把本该落在节点 A 的数据改写到节点 B,等 A 恢复后,同一条时间线的样本就分散在两个节点上 —— `vmselect` 查询时需要做合并,存储空间因为重复保留而膨胀,副本之间的数据一致性从「强」降成「最终」。

很多对数据一致性敏感的用户因此主动关掉重路由:

```
-vminsert -disableRerouting=true -disableReroutingOnUnavailable=true -replicationFactor=2
```

但这么一关,另一个问题立刻暴露:**写入路径变成了单点**。只要 N 个 vmstorage 里有一个不可用,vminsert 这条写入就直接失败。它不区分「哪份数据失败了」,因为对它来说,一次写入是一个原子单位。结果是:**为了保存储一致性而牺牲了写入可用性,而复制本来是为了可用性才做的**。

这就是 issue #11278 的提案者要解决的问题(2026-07-14 提出)。他的原话场景是:

> If a single vmstorage node is unavailable, vminsert blocks the entire ingestion. As a result, no fresh samples are stored on any vmstorage, largely defeating the purpose of replication.

### 1.2 认证面:一个 SSO 要多装一个进程,而 vmui 看起来像别人的网站

`vmauth` 是 VictoriaMetrics 全家桶里事实上的统一入口网关:它把 `/insert/*`、`/select/*`、`/api/v1/write`、`/api/v1/query` 这些路径按用户路由到不同的后端,顺带做 Basic Auth、Bearer Token、JWT 校验。从 v1.138.0 起它还支持 OIDC Discovery(自动从 `{issuer}/.well-known/openid-configuration` 拉 JWKS、每 5 分钟轮换公钥)和 JWT claim 匹配(按 token 里的角色路由到不同后端)。

但这一套**只解决了「令牌校验」,没解决「令牌从哪来」**。一个真实的场景(issue #10278,2026-01-12 提出):

> In order to use OIDC with vmui it requires using third party tools like oauth2proxy or pomerium which can be challenging to configure especially when manipulating query params and headers on a per-user basis, and it also requires using 3rd party tools which can look bad to users since they are going to vmui but the branding they see when signing in is for oauth2proxy.

这段话点出两件事:

1. **多装一个进程不只是运维成本,还有协议成本。** oauth2-proxy 的 callback、session cookie、`X-Auth-Request-*` 头转发,跟 vmauth 自己的 `url_prefix` 重写、`extra_label` 注入是两套体系,叠加在一起极易出现「重写把 session cookie 打掉了」「header 带了用户身份但 vmauth 还在用 Basic Auth」这类问题。
2. **登录页是用户看到的第一眼。** 用户访问 `vmui.company.com`,跳出来的是 oauth2-proxy 的登录框,这在内部平台还能忍,在给客户交付监控面板时几乎不可接受。

### 1.3 内核 I/O:你配的 read-ahead,vmstorage 说了不算

最后一个问题在磁盘上。Linux 块设备有一个 `read_ahead_kb` 参数,默认常见值 128KB-2048KB。内核从 2.6.23 起用**按需预读**(on-demand read-ahead)取代了固定窗口:它检测访问模式,动态调整预读窗口。

问题在于 vmstorage 的数据文件访问模式**天然是随机的**:一次 `query_range` 要扫几百个 series,每个 series 的 chunk 分散在磁盘不同位置,每次只读几 KB。内核的启发式在「大量小读 + 偶尔顺序扫」的混合模式下经常会误判成顺序读,于是一次 8KB 的逻辑读触发了 2MB 的物理读。issue #11461(2026-08-26)的作者描述了这个现象:

> Many small reads can generate much more physical disk traffic because of read-ahead. As a result, vmstorage can hit the disk throughput limit even when the number of read operations is not very high.

这个问题的危害在云盘上被放大:云盘的 IOPS 和吞吐是分开计费的,预读放大的是**吞吐**,而监控系统的读请求是**小 IO 高频**,结果是「IOPS 没用满,吞吐先爆了」。

**关键洞察 1:v1.153.0 的六个革新共享同一个方法论 ——「把判断点前移」。** vmstorage 直写把写入可用性的判断点从「集群中心」前移到「每个 vmagent 的队列」;SSO 把身份判断点从「我们发的静态凭据」前移到「IdP 的授权服务器」;zstd 内存预算把判断点从「解压之后」前移到「解压之前」;fadvise 把判断点从「内核猜」前移到「应用声明」;vmalert 跳过 pending 把判断点从「时序必然」前移到「状态可恢复」。所有这些改动都不引入新能力,但每一个都把「谁能犯错」从「系统默认行为」收回到「运维显式配置」。

---

## 二、五层架构:一条样本从采集到落盘的通路,以及横在它前面的认证面

### 2.1 经典写入通路(v1.152 及以前)

```
┌─────────────┐   scrape/Prometheus remote write   ┌──────────────┐
│  vmagent    │──────────────────────────────────▶│   vminsert    │
│ (8429)      │                                    │   (8480)      │
└─────────────┘                                    └───────┬──────┘
     │                                                     │ 分片 + 复制 + 重路由
     │ 持久队列                                       ┌─────┴─────┐
     └─────────────────────────────────────────────▶ │ vmstorage │ × N
                                                     │  (8482)   │
                                                     └─────┬─────┘
                                                            │
                                                     ┌─────┴─────┐
                                                     │ vmselect  │ (8481)
                                                     └───────────┘
```

关键点:`vmagent` 自己**已经**有一个磁盘持久队列(`-remoteWrite.tmpDataPath`),但它只对**远端**做持久化。在经典拓扑下,vmagent 的远端是 vminsert,vminsert 侧不再有跨节点的队列概念 —— 它把样本分发到 N 个 vmstorage,任何一份失败都影响整条写入。

### 2.2 v1.153.0 的新通路:vmstorage 直写

```
┌─────────────┐                                       ┌─────────────┐
│  vmagent    │──── remote write v1 ────────────────▶│  vmstorage  │
│             │  -remoteWrite.shardByURL             │  -enableIngestionAPI
│             │  -remoteWrite.shardByURLReplicas=2   │    (8482)   │
└─────────────┘                                       └─────────────┘
     │  每个远端一个独立持久队列
     ▼
  [vmstorage-1 队列] [vmstorage-2 队列] [vmstorage-3 队列]
```

这里最容易被忽略的设计细节是 `vmagent` 的行为等价声明。官方文档原话:

> In this setup, vmagent behaves like vminsert running with -replicationFactor=2 and -disableReroutingOnUnavailable.

也就是说,VictoriaMetrics 没有在 vmstorage 里重新实现一遍分片和复制逻辑,而是**复用了 vmagent 已有的、被大规模验证过的 `-remoteWrite.url` 多目标机制**。vmagent 本来就支持给多个远端复制写、按 URL 分片、每个远端独立持久队列 —— 这三件事在「远端是另一个 VM 集群」的场景里已经跑了三年。v1.153.0 做的事情是让远端可以**直接是 vmstorage 节点**,然后在 vmstorage 侧开一个 ingestion API。

**关键洞察 2:这是「把已经存在的机制换个地方用」,不是「新写一个机制」。** 对比很多数据库产品在这种场景下的做法是给存储节点加一层完整的 ingest 网关(分片路由、复制队列、背压全来一遍),VictoriaMetrics 选了更省事也更稳的路:存储节点只多开一个 HTTP 端点接收 remote write,所有协调逻辑仍在 vmagent。代价是**每个 vmagent 实例的队列配置要自己保证正确**,集群不再有一个中心点替你兜底。

### 2.3 认证面:vmauth 在请求路径上的位置

```
浏览器 / Grafana / vmagent
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ vmauth (8427)                                            │
│                                                          │
│  1. 未认证 GET/HEAD → 跳转 IdP /_vmauth/sso/callback     │  ← v1.153.0 新增
│  2. IdP 回 authorization code → 换 ID token              │  ← v1.153.0 新增
│  3. ID token 设为 _vmauth_sso cookie                     │  ← v1.153.0 新增
│  4. 后续请求带 cookie → JWT 校验 + match_claims 路由      │  ← v1.138.0 已有
│  5. url_prefix 注入 extra_label / extra_filters          │
└──────────────┬───────────────────────────────────────────┘
               │
               ▼
   vminsert / vmselect / vmui / 任意后端
```

注意第 4 步:**SSO 登录完成后,后续所有授权逻辑走的还是 v1.138.0 就存在的 JWT claim 机制**。SSO 只是「把 JWT 塞进 cookie 的那一步」。这是一个非常克制的实现 —— 它没有为 SSO 单独搞一套授权模型,所以你原来给 API token 配的 `match_claims`、`url_map`、`extra_label` 注入全部原样适用,登录用户和机器账号在 vmauth 看来没有区别。

---

## 三、六大承重级革新

### 3.1 vmstorage 直写 Prometheus Remote Write v1(`-enableIngestionAPI`)

**改动内容**:`vmstorage` 在集群模式下新增 `-enableIngestionAPI` 命令行开关,**默认关闭**。开启后,它接受标准 Prometheus Remote Write v1 协议写入,URL 走集群 URL 格式:

```
http://<vmstorage>:8482/insert/<tenant_id>/prometheus/api/v1/write
```

**为什么默认关闭**:这个能力改变了集群的写入语义。一个不小心配上 `-remoteWrite.url` 指向 vmstorage 的用户,会发现自己绕过了 vminsert 的所有监控指标(`vm_ingestrows_total` 在 vminsert 上)、所有限流和所有多租户校验。维多利亚团队在 issue 讨论里明确了这个开关的定位 —— f41gh7(核心维护者)在 2026-07-15 评论:

> It's better to expose not only remote write, but whole vminsert ingestion APIs. But lets keep remote write for now.
> This feature must be hidden by feature flag, something like `-enableIngestionAPI`.

makasim 在 2026-07-22 回复:

> Discussed with @valyala. We agreed to focus on the remote write API only and not introduce any additional endpoints.

**两个设计决策值得记住**:① 只做 remote write,不暴露 vminsert 的其他 ingest API(/api/v1/import、native import 等),因为这些 API 的分片语义跟 remote write 不同,全部支持会让 vmstorage 变成第二个 vminsert;② 必须用 feature flag 藏起来,让用户**显式选择**新的写入拓扑。

**它解决了什么**:回到 §1.1 的场景。开了直写之后,写入可用性的边界变成这样:

| 场景 | 经典拓扑(-disableRerouting) | vmstorage 直写 |
|------|------------------------------|----------------|
| 1 个 vmstorage 宕机 | **整条写入失败**,所有 vmstorage 都收不到新数据 | 只有该 vmagent 的那一个持久队列堆积 |
| 恢复后 | 依赖客户端重试,窗口内数据可能丢 | 队列自动回放 |
| 一致性 | 强(数据不跨节点移动) | 强(vmagent 按 URL 分片,不重路由) |
| 复制 | vminsert 做 | vmagent 用 `-remoteWrite.shardByURLReplicas=2` 做 |
| 队列位置 | 无中心队列 | **每个 vmstorage 一个独立队列** |

**关键洞察 3:「持久队列」的位置决定了故障的爆炸半径。** 在经典拓扑下,vminsert 是写入的「漏斗口」,所有 vmagent 的数据都挤在这里,漏斗堵了一切都停。直写把漏斗拆成了 N 个独立小漏斗,每个小漏斗只影响自己那一片分片。这是从「系统级可用性」到「分片级可用性」的转变 —— 一个 3 节点集群从「1/3 节点故障 = 100% 写入中断」变成「1/3 节点故障 = 33% 写入延迟(队列堆积),其余 67% 完全不受影响」。

**什么时候不该用**:① 你的写入量小到单 vminsert 完全hold 得住,且不在意重路由带来的数据漂移 —— 那经典拓扑更省心;② 你强依赖 vminsert 侧的 `vm_ingestrows_total` 等指标做计费或告警 —— 直写后这些指标的计数点变了,vmstorage 侧的 `vm_rows_inserted_total` 才是新的计数点;③ 你用多租户且租户数量经常变化 —— vmagent 的 `-remoteWrite.url` 列表是启动期配置,加租户意味着改所有 vmagent 的配置并滚动重启。

### 3.2 vmauth 原生 OIDC SSO(issue #10278 落地)

**改动内容**:`vmauth` 内建 OpenID Connect Authorization Code Flow。配置分两部分,顶层 `sso` 段管登录流程,`users` 段里用已有的 `jwt` 配置管授权:

```yaml
sso:
  - src_host: 'sso\\.example\\.com'
    oidc:
      issuer: 'https://identity-provider.com/realms/master'
      client_id: 'sso.example.com'
      client_secret: 'theClientSecret'
      scopes: ['openid', 'profile', 'email']
      cookie_secret: 'theCookieSecret1234567890'   # ≥16 字符,CSRF cookie 的 HMAC 密钥
      session_duration: '1h'
      # insecure: true   # 仅本地 HTTP 开发

users:
  - jwt:
      match_claims:
        iss: 'https://identity-provider.com/realms/master'
        aud: 'sso.example.com'                     # 必须校验 aud == client_id
      oidc:
        issuer: 'https://identity-provider.com/realms/master'
    url_map:
      - src_paths: ["/.*"]
        src_hosts: ['sso\\.example\\.com']
        url_prefix: "http://vmsingle:8428"
```

**流程细节**:

1. 未认证的浏览器请求到达 → `vmauth` 返回登录页。**只有 `GET`/`HEAD` 触发登录流程,其他方法直接 401**。这个区分很重要:API 调用(POST remote write)不应该跳到登录页,它应该直接 401 让调用方知道凭据无效。
2. 重定向到 IdP 的 authorization endpoint,带 CSRF cookie。
3. IdP 回调 `https://<vmauth-host>/_vmauth/sso/callback`,vmauth 用 authorization code 换 ID token。
4. **ID token 明文存入 `_vmauth_sso` cookie**,作为后续请求的凭据。
5. 后续请求带 cookie → 走标准 JWT 校验链路(签名 + `match_claims`)。
6. 默认**不把 cookie 里的 token 转发给后端**;需要转发时在 `jwt` 用户配置里设 `proxy_cookie_authorization_token: Authorization`。

**session_duration 的语义值得注意**:`MaxAge = min(session_duration, token exp)`。也就是说,即使你把 `session_duration` 配成 30 天,如果 IdP 签发的 token 有效期是 1 小时,cookie 也会在 1 小时后失效,用户需要重新登录。**实际 session 长度是两个配置的交集,不是你单独配的那个值。**

**默认不转发 token 到后端的原因**:vmauth 的设计假设后端(vminsert/vmselect)不认识 JWT —— 它们只认 vmauth 注入的 URL 参数(`extra_label`)或 Basic Auth。如果默认转发,后端日志里会落下完整的 ID token,而 ID token 里通常带用户邮箱、姓名、部门,这属于凭据泄露面。需要转发的场景是后端自己也要做细粒度授权(例如把 `Authorization` 头透传给一个自己写的 API gateway)。

**安全注意点(官方文档明确说明)**:`_vmauth_sso` cookie 里的 JWT 是**明文**的。这意味着:① 必须走 HTTPS,否则 token 在链路上裸奔;② 浏览器端任何能读 cookie 的 JS 都能拿到 token,所以 vmui 所在的源不能混入不可信脚本;③ token 的过期时间是最后的防线,`session_duration` 配得越长,泄露窗口越大。

**关键洞察 4:SSO 的价值不在「少装一个进程」,在「授权模型统一」。** 以前的双组件架构里,oauth2-proxy 做了一层授权(谁能登录),vmauth 做了另一层授权(谁能查哪个租户),两层之间靠 header 传递身份,任何一层的配置漂移都会产生「能登录但查不到数据」或「查得到数据但不该能登录」的灰色地带。现在两层合并成一层:**vmauth 既是 IdP 的 OAuth2 client,也是 JWT 的消费方**,IdP 的 claim 直接就是 vmauth 的路由依据,中间没有第二次身份翻译。

### 3.3 zstd 原生导入的内存预算(GHSA-8g4f-32hw-vqf8)

**改动内容**:`vminsert`、`vmagent`、`vmsingle` 在通过 native import 导入 zstd 编码的块时,**正确地施加内存限制**,防止处理恶意构造请求时在导入期过度分配内存。

**为什么这是个真问题**:VictoriaMetrics 的 native format 是它自己的二进制格式,块(body)用 zstd 压缩。导入路径大概是:

```
HTTP body (zstd 压缩)  →  zstd 解压  →  解析为 TimeSeries 数组  →  写入 TSDB
```

旧代码的问题在于:**内存限制施加在解压之后的对象上,而不是施加在解压过程本身**。zstd 的解压是一个**放大过程** —— 一个高度可压缩的输入(比如全零字节)可以达到数百甚至上千的压缩比。如果限制只看「解压后的大小」,那么在「发现超限」之前,内存已经分配出去了。

这是「解压炸弹」(decompression bomb)在时序数据库导入路径上的具体形态。攻击者不需要登录,只要能往 `/api/v1/import/prometheus` 或 native import 端点 POST 一个精心构造的 zstd 块,就能在 `vminsert` 上触发数 GB 的分配。在一个 4GB 内存 limit 的容器里,这足以 OOM 整个写入组件,而**写入组件 OOM 在监控架构里等于整个采集链路断流**。

**修复的方向**:把内存预算的检查点**前移到解压之前**,通过块头里声明的大小字段判断解压后的体积是否超过预算,超了就直接拒绝。这需要信任协议头里的声明值 —— 如果头里声明「解压后 1KB」实际解压出 1GB(lying header),仍然需要在解压流上做增量检查(zstd 流式解压时可以跟踪已产出字节数)。官方的 release notes 措辞是 "properly apply memory limits",指的是让限制覆盖到这条路径上,而不是只覆盖其他路径。

**给你的生产建议**:① 导入端点(尤其 native import)不要对公网开放,vmauth 前面一定要挂认证;② 用 `-memory.allowedPercent`(默认 60%)或 `-memory.allowedBytes` 给进程设硬上限,这是这个漏洞的**第二道闸**,即使第一道失守,进程也会在 OOM 前主动拒绝新分配而不是被 kernel kill;③ 监控 `process_resident_memory_bytes` 相对 `go_memstats_sys_bytes` 的比例,接近 `-memory.allowedPercent` 时会触发主动 GC 和拒绝写入,这是 VictoriaMetrics 的自保机制,不是 bug;④ 升级到 v1.153.0 或更高版本,这是**安全修复**,优先级高于任何 feature。

### 3.4 OIDC Discovery HTTP 客户端的重定向约束(GHSA-xxqh-2hcc-9fp6)

**改动内容**:`vmauth` 在 OIDC Discovery 的 HTTP 客户端里**限制重定向必须停留在原始请求主机内**。

**漏洞原理**:OIDC Discovery 的流程是 `vmauth` 请求 `{issuer}/.well-known/openid-configuration`,拿到 JSON,从里面取 `jwks_uri`,再请求 JWKS 拿公钥。这两次请求都跟随 HTTP 重定向(3xx)。

危险在于:如果 `issuer` 配置成 `https://idp.example.com`,而 `idp.example.com` 返回一个 302 指向 `https://attacker.com/.well-known/openid-configuration`,vmauth 就会去攻击者那里取配置和公钥,然后用攻击者的私钥签发的假 token 通过校验 —— **这是一个完整的身份伪造链,且对 vmauth 完全透明**。

攻击触发条件有两个:① 攻击者能控制 issuer 配置(内部威胁,或者配置文件被改);② **攻击者能控制 IdP 自己的重定向行为** —— 第二种更现实,因为很多企业 IdP 的 `/.well-known/` 路径是托管的,租户可以自定义回调行为。一旦租户 A 能让 IdP 的 discovery 端点重定向到租户 A 控制的域名,租户 A 就能伪造任何用户的 token。

**修复后的行为**:重定向只允许在同一主机内(端口可以变,主机名不能变),跨主机重定向被拒绝。这是一个**最小信任原则**的实现 —— discovery 的目的就是「找到这个 issuer 的端点」,它没有任何理由跑到别的域名上去。

**给配置管理者的启示**:① `issuer` 必须用 HTTPS 且指向你真正信任的 IdP 域名,这个值是整个信任链的根;② 修复后如果你原来的 IdP 依赖跨域重定向(很少见,但某些 SaaS IdP 的多区域部署会做),会突然失败 —— 表现是 vmauth 启动时 OIDC key 拉不到、配置段被跳过(官方文档明确说了这个行为:"If no keys have been fetched yet, vmauth continues using previously fetched keys until next successful refresh")。

### 3.5 fadvise/madvise:把访问模式声明给内核(issue #11461)

**改动内容**:`vmsingle` 和集群模式的 `vmstorage` 新增 opt-in 的 `posix_fadvise(FADV_RANDOM)` 和 `madvise(MADV_RANDOM)` 提示,作用对象是**数据部分文件**。开关是一个**否定形式的默认值**:

```
-fs.disableAdviseRandomRead=false     # 默认 true(即默认不启用随机读提示)
```

**为什么默认是关的**: VictoriaMetrics 的作者对内核行为一向谨慎 —— FADV_RANDOM 在不同内核版本、不同文件系统、不同存储介质上的效果差异很大。在某些 SSD 上它能让随机读吞吐提升;在某些云盘上它几乎没有效果;在个别场景下它甚至可能变慢(因为它同时禁用了内核对**偶尔的顺序扫描**的预读优化)。所以官方的做法是:给你一个开关,让你在自己的硬件上 benchmark,出问题了去 issue #11461 留言。release notes 的措辞就是:"If you experience issues after enabling this feature, please leave a comment with details."

**作用范围的关键区分(提案者明确要求)**:提示**只加在数据文件上,不加在索引文件上**。原因是:

- **数据文件**:查询时按 chunk 随机跳读,访问模式确实是随机的,预读是纯浪费。
- **索引文件**:索引扫描(尤其 `/api/v1/series`、`/api/v1/labels` 这类全量枚举查询)有明确的顺序性,预读是真有帮助的。

一视同仁地关掉预读会伤到索引查询性能。这个区分是 issue #11461 提案里最专业的一笔。

**它解决的具体现象**:你的 vmstorage 出现「IOPS 不高但磁盘吞吐打满了」(`vm_disk_read_bytes_total` 增速远超 `vm_disk_reads_total` × 单次 IO 大小),或者 page cache 命中率莫名其妙地低。这时候可以先验证再开:

```bash
# 1. 看块设备当前 read-ahead
blockdev --getreadahead /dev/sdX

# 2. 看 vmstorage 的实际物理读放大:每秒读出的字节 / 每秒读操作数
#    VM 指标:vm_disk_read_bytes_total / vm_disk_reads_total
#    如果这个比值远大于 read-ahead 设置,说明内核在额外预读

# 3. 开启后对比
```

**关键洞察 5:这是「应用比内核更懂自己的访问模式」的典型案例,但它只对「访问模式确实随机」的应用成立。** 一个通用建议是:不要把 `-fs.disableAdviseRandomRead=false` 当成无脑优化。先用 `iostat -x 1` 确认你的 `%util` 是被吞吐还是 IOPS 打满的 —— 如果是 IOPS 打满(SSD 的常见情况),关预读帮不上忙,你需要的是把更多数据放进 page cache(加内存)或者减少查询涉及的 series 数量(减基数)。

### 3.6 vmalert 重启恢复跳过冗余 pending(PR #11401)

**改动内容**:vmalert 重启后恢复告警状态时,**如果规则可以直接恢复到 firing,就跳过 pending 中间态**。

**旧时序(改之前)**:

```
1. ruleA(interval: 30s, for: 5m) 正在 firing
2. vmalert 重启
3. ruleA 第一次求值 → 进入 pending,并写出 ALERTS{alertstate="pending"} 和 ALERTS_FOR_STATE
4. restore 执行,把状态恢复成 firing 之前的样子
5. ruleA 第二次求值 → 切回 firing,再次写出 ALERTS / ALERTS_FOR_STATE
```

问题在第 3 步:**恢复的全部前提就是「假设重启期间状态没变」**,那么第 3 步先写一个 pending 再被第 5 步覆盖就是纯粹的噪音。用户在 Grafana 上看到的是:重启时刻 ALERTS 指标先掉到 pending 再跳回 firing,`Value changes` 告警会误报,用 `changes(ALERTS[5m]) > 0` 做「告警抖动检测」的规则会误触发,而 `for: 5m` 越长的规则越容易中招 —— 因为它们的恢复窗口本来就长,跟重启窗口重叠的概率高。

**新时序**:第 3 步不再写出中间态的 pending,直接在 restore 后进入正确状态。

**这个 PR 顺带做了三处实现层面的清理**(从 patch 可以直接看到):

1. **restore 的时机从「求值之后」移到「求值循环内部、状态机推进之前」**。patch 在 `exec()` 里加了 `getRemoteReadQuerier` 回调参数,在状态计算前调用 `ar.restore(ctx, rr, ts)`,且**restore 失败不阻断当前求值**(只打 error 日志)。这是一个正确的容错选择:restore 只是优化,失败时最坏结果是规则重新走一遍 `for` 计时,不该让整个 group 的求值失败。
2. **restore 查询的时间点从 `ts - 1s` 改回 `ts`**。旧的 `-1s` 是为了规避 issue #10335(查到本次写入的数据),但新的时序里 restore 发生在本次写入之前,不存在这个问题,所以这秒级偏移成了多余的一层,反而可能漏掉最后一秒的状态。
3. **删掉了 restore 函数里的 `ar.alertsMu.Lock()`**。因为 restore 现在在 `exec()` 内部被调用,而 `exec()` 本身已经在持有规则的状态,重复加锁是死锁风险(或者至少是无谓的锁竞争)。

**诚实边界(PR 作者自己声明的)**:`a.activeAt` 在 restore 时不会被更新,所以如果你在 annotation 模板里用了 `{{ .ActiveAt }}`,恢复后第一次渲染会看到**旧值**,要到第二次求值才修正。作者的原话是 "this should be a minor issue, since the value is the same as the current implementation" —— 也就是说,这个行为在改之前就存在,不是这次改动新引入的。

**这个改动对告警消费者的实际影响**:如果你有依赖 `ALERTS_FOR_STATE` 的 active 时长计算,或者用 `(ALERTS{alertstate="firing"} unless ALERTS{alertstate="pending"})` 这类集合运算做去重,重启窗口内的瞬时尖刺会消失。如果你有「重启检测」之类的旁路规则(比如 `up{job="vmalert"} == 0` 触发后 30 秒内的抑制),现在可以放心地把抑制窗口从 5 分钟缩到 1 分钟 —— 因为 v1.153.0 之后,vmalert 重启不再产生状态抖动。

---

## 四、五个工程上极痛的修复(支线)

### 4.1 Unix socket 权限:0600 → umask(#11615)

`-httpListenAddr=unix:/path/to/socket` 从 v1.153.0 起按**进程 umask** 创建 socket,而不是硬编码 `0600`。

真实场景(issue 作者):VictoriaMetrics 跑在 `victoriametrics` 用户下,nginx 跑在 `nginx` 用户下。要让 nginx 连上 socket,需要把 socket 设成 `0660` 并把 `victoriametrics` 加进 nginx 的补充组。硬编码 0600 时这做不到,只能退而求其次让两个进程跑同一用户 —— 而这在安全基线里是扣分项。

提案者还顺手指出**文档和代码不一致**:文档写的默认权限和 `lib/netutil/unixlistener.go` 里实际写死的 0600 对不上。这类不一致在生产环境最坑 —— 你按文档配了 umask 0077,期望 socket 是 0660,实际拿到 0600,nginx 连不上,日志里只有一行 "permission denied",没有任何提示告诉你「文档错了」。

注意提案者原本要求的是**新增一个 `-unixSocketMode` 命令行选项**(显式声明 0660),而最终实现是**遵循 umask**(隐式继承)。两者各有道理:umask 更符合 Unix 惯例(你已经在用 umask 管理 nginx、postgres 的 socket 了),但牺牲了「在 systemd unit 里直接写死权限」的便利性。如果你需要精确控制,用 systemd 的 `UMask=0007`。

### 4.2 stream aggregation:并行化退回串行(#9878)

`vminsert` 和 `vmagent` 之前引入了一个改动(commit `11f488d8ff`),把推送给 streaming aggregation job 的样本**并行处理**。v1.153.0 **退回串行**。

退回的理由值得所有做性能优化的人记住:并行化**只带来了可忽略的样本延迟下降,却增加了额外的 CPU 开销**。原始 issue(2025-10-17)报告的问题是"streaming aggregation slow downs data ingestion" —— 20-30 条聚合规则下,`Push()` 的串行循环把每个请求的处理时间线性叠加。并行看起来是显然的解法,但:

1. streaming aggregation 的瓶颈不是计算,是**规则匹配**;并行化需要额外构建任务分发和结果合并的结构。
2. 每个请求都要遍历所有规则,并行带来的调度开销在规则数不多时远大于省下的时间。
3. VictoriaMetrics 的写入路径对**延迟方差**极其敏感 —— 一个 p99 500ms 的并行路径比一个 p50 20ms 的串行路径对聚合流水线更不友好。

**这是「性能优化做错了就回滚」的正常工程决策,而且它被回滚了。** 很多项目会把一个无效的优化留着不管(「反正也没更慢多少」),VictoriaMetrics 的做法是承认它没用然后删掉,避免给后人制造「这里并行过所以这里应该是瓶颈」的错误线索。

### 4.3 vmagent:*_sd_config 返回空时陈旧 target 永不消失(#11550)

**回归起点**:v1.130.0 的 commit `e8975e560`。

**现象**:一个 scrape job 的 `http_sd_configs` 在配置 reload 时被移除(比如换成 `file_sd_configs`),vmagent **继续抓取旧 http_sd 发现过的 target,直到进程重启**。所有走 `getScrapeWorkGeneric()` 的 SD 类型都中招(consul、dns、ec2、azure……),`file_sd_configs`、`static_configs`、`kubernetes_sd_configs` 不受影响。

**原因**:那个 commit 把 `getScrapeWorkGeneric()` 改成每轮以 `hasSuccess = false` 开始,只有某类型的 SD config 返回成功才置 true。一个**完全没有某类型 SD config** 的 job 永远不会置 true,于是每轮都被当成「临时发现失败」,触发 `appendPrevTargets()` 把上一轮的 target 加回来。

**这个 bug 的危害形式很隐蔽**:它不会报警(抓取还在成功),不会报错(发现被当成临时失败),唯一的表现是你的 dashboard 上出现了**本该已经被下线的服务还在上报指标**。在一个做服务下线清理的平台上,这会让旧实例的指标 series 长期占用存储 —— 而 VictoriaMetrics 的存储成本跟 series 数量直接相关。

**修复 PR #11549**。如果你在 v1.130.0 到 v1.152.0 之间运行 vmagent 并做过服务发现类型切换,**升级后应该检查一次 series 基数**,把残留的旧 target series 用 deletion API 清掉。

### 4.4 空的 extra_label / extra_filters 查询参数报错(#11618)

**矛盾点**:vmauth 的[安全文档](https://docs.victoriametrics.com/victoriametrics/vmauth/#security)明确推荐这样配 `url_prefix`:

```yaml
url_prefix: http://vmselect/select/multitenant?extra_filters[]=&extra_filters=&extra_label=vm_account_id=10
```

**空的 `extra_filters[]=` / `extra_label=` 的作用是「覆盖客户端传来的同名参数」**,实现「用户只能查自己租户的数据」。代码里甚至有专门测试:`make sure that empty config value erases client extra filters and extra labels`。

但上游的 vmselect / vminsert 对空值直接报错:

```
`extra_label` query arg must have the format `name=value`; got ""
cannot parse extra_filters=: singleExpr: unexpected token ""; want "(", "{", "-", "+"
```

于是出现了一个荒谬局面:**官方推荐的安全配置,在被保护的后端上跑不通**。

v1.153.0 的修复是让 vmselect / vminsert / vmagent / vmsingle **忽略空的** `extra_label`、`extra_filters`、`extra_filters[]` 参数,而不是返回错误。

**这个修复的安全意义被低估了**:在此之前,很多想用 JWT claim 注入 `extra_filters` 的用户发现「注入空值会 400」,于是**干脆不注入空值**,直接让用户的 `extra_label` 参数透传到后端 —— 一个本该被限制的查询面就这样敞开了。修复后,「用空值清除客户端参数」这个模式终于端到端可用,这是**最小权限原则在查询参数层面的落地**。

### 4.5 alert_relabel_configs 热重载静默失效(#11635)

**现象**:vmalert 的 `-notifier.config` 里,顶层的 `alert_relabel_configs` **只在启动时读取一次**,之后的热重载(`-configCheckInterval` 周期 reload 或 `/-/reload` 请求)**不会更新它**。同一文件里的 `static_configs` 却能正常热更新。

**为什么这个 bug 特别危险**:`alert_relabel_configs` 的作用是**在告警发出去之前改它的标签**。典型用途是:① 脱敏(删掉 `user_email` 标签再发给共享的 Alertmanager);② 重命名(把 `env=prod` 映射成 `severity=critical` 的路由标签);③ 注入 tenant ID 实现多租户告警路由。

一个安全工程师做了脱敏配置变更,执行 `/-/reload`,日志显示 reload 成功,没有任何报错 —— 但脱敏**没生效**,带敏感标签的告警继续往外发,直到下一次 vmalert 重启。**这是「配置变更看起来成功但实际没生效」这一类故障里最糟的形态**,因为它把安全控制变成了幻觉。

修复后,顶层 `alert_relabel_configs` 跟其他配置项一起热重载。**给你的运维建议**:把「关键配置变更后验证实际生效」做成 SOP —— 脱敏类变更后,故意发一个带被脱敏标签的测试告警,在 Alertmanager 侧确认标签确实没了。不要相信 reload 日志里的 "config reloaded successfully"。

### 4.6 附带:并发查询 CPU 微降、Kafka 证书热重载、OIDC 发现的 IPv6

- `vmsingle` 和 `vmselect` **略微降低并发查询时的 CPU 使用**(#11569)。官方措辞是 "slightly reduce",属于内循环优化,没有公开的 benchmark 数字,不要期待可见的性能变化。
- vmagent 的 **Kafka producer/consumer 现在能正确热重载 SSL 证书**(#11577)。之前换证书必须重启 vmagent,对于「证书每 90 天轮换」的合规要求来说这是个持续的运维痛点。
- vmauth 的 `discover_backend_ips` **尊重 `-enableTCP6` 标志**(#11470)。之前即使禁用了 IPv6 支持,后端 IP 发现仍然返回 IPv6 地址,导致连接失败时的错误信息很有误导性。

---

## 五、五段实战代码

### 5.1 vmstorage 直写部署 + 故障注入验证

```yaml
# docker-compose.yml —— 3 vmstorage + 1 vmagent 直写,RF=2
version: "3.8"
services:
  vmstorage-1:
    image: victoriametrics/vmstorage:v1.153.0
    command:
      - "-enableIngestionAPI"                      # ← 新开关,默认关
      - "-retentionPeriod=30d"
      - "-storageDataPath=/storage"
    ports: ["8482:8482"]
    volumes: ["./s1:/storage"]

  vmstorage-2:
    image: victoriametrics/vmstorage:v1.153.0
    command: ["-enableIngestionAPI", "-retentionPeriod=30d", "-storageDataPath=/storage"]
    ports: ["8483:8482"]
    volumes: ["./s2:/storage"]

  vmstorage-3:
    image: victoriametrics/vmstorage:v1.153.0
    command: ["-enableIngestionAPI", "-retentionPeriod=30d", "-storageDataPath=/storage"]
    ports: ["8484:8482"]
    volumes: ["./s3:/storage"]

  vmagent:
    image: victoriametrics/vmagent:v1.153.0
    command:
      - "-remoteWrite.url=http://vmstorage-1:8482/insert/0/prometheus/api/v1/write"
      - "-remoteWrite.url=http://vmstorage-2:8482/insert/0/prometheus/api/v1/write"
      - "-remoteWrite.url=http://vmstorage-3:8482/insert/0/prometheus/api/v1/write"
      - "-remoteWrite.shardByURL"                 # ← 按 URL 分片,而不是复制
      - "-remoteWrite.shardByURLReplicas=2"       # ← 每个 shard 写 2 份
      - "-remoteWrite.tmpDataPath=/vmagentdata"   # ← 每个远端独立持久队列
    ports: ["8429:8429"]
```

```bash
# 故障注入:停掉 vmstorage-2,观察写入是否中断
docker compose stop vmstorage-2

# 经典拓扑下(-disableRerouting):所有 vmagent 的 remote write 全部失败
# 直写拓扑下:只有落在 shard 2 上的 series 进入持久队列,其余照写

# 查每个队列的堆积情况
curl -s http://localhost:8429/metrics | grep -E "vm_pending_metrics|vm_blocked_writers_total"

# 恢复
docker compose start vmstorage-2
# 队列自动回放,无需任何手动操作
```

**验证复制是否真的写了 2 份**:`-remoteWrite.shardByURLReplicas=2` 意味着同一个 series 被写到 2 个 vmstorage。查同一个 series 在不同节点上的 count 应该相等:

```bash
for p in 8482 8483 8484; do
  echo "port $p: $(curl -s "http://localhost:$p/select/0/prometheus/api/v1/query?query=count(up)" | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["result"][0]["value"][1])')"
done
```

### 5.2 vmauth OIDC SSO 完整配置 + claim 路由

```yaml
# auth.yml
sso:
  - src_host: 'grafana\\.monitoring\\.example\\.com'
    oidc:
      issuer: 'https://keycloak.example.com/realms/platform'
      client_id: 'vmauth-grafana'
      client_secret: '${SSO_CLIENT_SECRET}'       # 用环境变量,别提交到 git
      scopes: ['openid', 'profile', 'email', 'groups']
      cookie_secret: '${COOKIE_SECRET}'           # openssl rand -base64 32,≥16 字符
      session_duration: '2h'                      # 实际 MaxAge = min(2h, token exp)

  - src_host: 'vmui\\.monitoring\\.example\\.com'
    oidc:
      issuer: 'https://keycloak.example.com/realms/platform'
      client_id: 'vmauth-vmui'
      client_secret: '${SSO_CLIENT_SECRET}'
      cookie_secret: '${COOKIE_SECRET}'
      session_duration: '8h'                      # 看板用户,session 长一点

users:
  # 只读组:只能查,extra_label 把范围锁死在 team=payments
  - jwt:
      match_claims:
        iss: 'https://keycloak.example.com/realms/platform'
        aud: 'vmauth-grafana'
        groups: 'payments-readonly'               # claim 名支持点号遍历嵌套 JSON
      oidc:
        issuer: 'https://keycloak.example.com/realms/platform'
    url_map:
      - src_paths: ["/select/.*"]
        url_prefix: 'http://vmselect:8481/select/0/prometheus/?extra_label=team=payments'
        headers:
          - "X-Tenant: payments"

  # 写入组:vmagent 用 client credentials 拿的 token,不是 SSO 来的
  - jwt:
      match_claims:
        iss: 'https://keycloak.example.com/realms/platform'
        aud: 'vmauth-ingest'
        groups: 'ingest'
      oidc:
        issuer: 'https://keycloak.example.com/realms/platform'
    url_map:
      - src_paths: ["/insert/.*", "/api/v1/write"]
        url_prefix: 'http://vminsert:8480/insert/0/prometheus/'

unauthorized_user:
  access_log:
    headers: ["Authorization", "X-Forwarded-For"]  # ← v1.153.0 新增:记录指定 header
    filters:
      skip_status_codes: [200]                     # 只记录非 200,排障专用
```

```bash
# 在 Keycloak 里注册的 redirect URI 必须精确匹配:
# https://grafana.monitoring.example.com/_vmauth/sso/callback
# https://vmui.monitoring.example.com/_vmauth/sso/callback

# 校验 cookie 里的 token 内容(它 是明文 JWT)
# 浏览器 DevTools → Application → Cookies → _vmauth_sso → 复制值
echo "<cookie_value>" | cut -d. -f2 | base64 -d 2>/dev/null

# 用 curl 模拟带 cookie 的请求
curl -H "Cookie: _vmauth_sso=<token>" \
  "https://vmui.monitoring.example.com/select/0/prometheus/api/v1/query?query=up"
```

**调试技巧**:如果用户能登录但查不到数据,99% 的情况是 `match_claims` 没匹配上。开 `-logInvalidAuthTokens=true`(v1.153.0 新增的日志,当 token 没有 `vm_access` claim 且没配 `default_vm_access_claim` 时打印明确指引),你会看到:

```
jwt token for user "..." has no `vm_access` claim and `default_vm_access_claim` is not configured;
add `vm_access` claim to the jwt token or set `default_vm_access_claim` in vmauth config
```

### 5.3 导入端点内存预算的验证与加固

```bash
# 第一道闸:升级到 v1.153.0(修了 zstd native import 的内存限制)

# 第二道闸:进程级硬上限
# vminsert 容器内存 limit 4GiB,allowedPercent 60% = 2.4GiB 上限
# 超过后 VM 会拒绝新写入而不是被 OOM kill
/vminsert \
  -memory.allowedPercent=60 \
  -maxConcurrentInserts=8 \
  -maxInsertRequestSize=32MB \
  -httpListenAddr=:8480

# 监控内存预算的消耗比例
# PromQL:进程 RSS / (容器 limit × 60%)
(
  process_resident_memory_bytes{job="vminsert"}
/
  ( container_spec_memory_limit_bytes{job="vminsert"} * 0.60 )
)
# 接近 1.0 时 vminsert 开始主动限流/拒绝,这是设计行为不是故障
# 但如果持续接近 1.0,说明你的导入吞吐需要扩容

# 第三道闸:网络层 —— 导入端点不对公网开放
# vmauth 只把 /api/v1/import 路径开放给内网来源
```

```yaml
# vmauth 只开放查询面给 SSO 用户,导入面只给内网
users:
  - jwt:
      match_claims: {iss: '...', aud: 'import-internal'}
    ip_filters:                                    # 只允许内网网段
      allow_list: ["10.0.0.0/8", "172.16.0.0/12"]
    url_map:
      - src_paths: ["/api/v1/import.*"]
        url_prefix: 'http://vminsert:8480/insert/0/prometheus/'
```

**关于这个漏洞你需要自查的三件事**:① 你的 `/api/v1/import` 或 native import 端点是否需要认证就能访问?② 访问它的客户端 IP 是否可枚举(公网 vs 内网)?③ 这些端点是否挂在一个跟查询面不同的域名/路径上,从而容易被忘记加固?

### 5.4 fadvise 开启前后 page cache 与磁盘读的对比验证

```bash
# 前置条件:确认 vmstorage 的读放大问题真实存在
# 1. 看块设备 read-ahead
blockdev --getreadahead /dev/nvme1n1       # 例如 2048 (KB)

# 2. 看 VM 自己统计的磁盘读 —— 平均每次读多大
# 每次读的字节 = rate(vm_disk_read_bytes_total) / rate(vm_disk_reads_total)
# 如果远超你的单次逻辑读大小(chunk 一般几 KB 到几十 KB),预读在放大
curl -s http://vmstorage:8482/metrics | grep -E "vm_disk_read"

# 3. 开启前先记录基线(跑一组典型查询,各 10 次)
for i in $(seq 10); do
  curl -s -o /dev/null -w "%{time_total}s\n" \
    "http://vmselect:8481/select/0/prometheus/api/v1/query_range?query=rate(http_requests_total%5B1h%5D)&start=$(date -d '-1 hour' +%s)&end=$(date +%s)&step=60"
done | sort | tail -5     # p50 和 p99

# 4. 开启(注意:这是双否定,false = 启用随机读提示)
vmstorage -fs.disableAdviseRandomRead=false ...

# 5. 开启后跑同样查询,对比 p50/p99 和磁盘指标
# 6. 检查 page cache 命中率变化
cat /proc/vmstat | grep -E "pgmajfault|pgfault"

# 7. 看进程的文件级 cache 情况(需要 root)
cat /proc/$(pgrep vmstorage)/smaps_rollup | grep -E "Rss|Pss"

# 8. 如果变慢了 —— 去这里留 comment,作者在收集数据
# https://github.com/VictoriaMetrics/VictoriaMetrics/issues/11461
```

**一个容易搞错的点**:`-fs.disableAdviseRandomRead` 是**双否定**。`true`(默认)= 禁用随机读提示 = 用内核默认行为;`false` = 启用随机读提示。配错了方向不会报错,只会让你以为「开了没效果」。

**不要同时做的优化**:不要在开 FADV_RANDOM 的同时把块设备 `read_ahead_kb` 调小(比如设成 16)。这两个是重复手段,FADV_RANDOM 已经在文件层面禁用了预读,再改块设备层面会影响**同盘上其他服务**(比如同机的 etcd、本地 cache)的顺序读性能。

### 5.5 vmalert 恢复时序的复现与验证

```yaml
# rules.yml —— 一个 for: 5m 的规则,足够长以便跟重启窗口重叠
groups:
  - name: restore-test
    interval: 30s
    rules:
      - alert: LongForWindowRestoreTest
        expr: vector(1)                          # 恒真,方便复现
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "restore test active since {{ $value }}"
```

```bash
# 1. 启动 vmalert,等它进入 firing(需要 5 分钟)
./vmalert -rule=rules.yml -datasource.url=http://vmselect:8481/select/0/prometheus \
  -remoteWrite.url=http://vminsert:8480/insert/0/prometheus \
  -notifier.url=http://alertmanager:9093 \
  -dryRun=false

# 2. 确认 firing
curl -s "http://vmselect:8481/select/0/prometheus/api/v1/query?query=ALERTS%7Balertname%3D%22LongForWindowRestoreTest%22%7C%22" | head

# 3. 强制重启 vmalert(kill -9,模拟崩溃,不走优雅退出)
kill -9 $(pgrep vmalert) && ./vmalert ...

# 4. 重启后立刻查 ALERTS 的状态历史
# v1.152 及以前:会看到 pending → firing 的跳变(噪音)
# v1.153.0:直接回到 firing,无中间态
curl -s "http://vmselect:8481/select/0/prometheus/api/v1/query_range?query=ALERTS%7Balertname%3D%22LongForWindowRestoreTest%22%7D&start=<重启前60s>&end=<重启后120s>&step=10s"

# 5. 用 changes() 验证抖动消失
# v1.152: changes(ALERTS[10m]) 在重启窗口内 = 2 或 3
# v1.153.0: changes(ALERTS[10m]) = 1(只从无到有一次)
curl -s "http://vmselect:8481/select/0/prometheus/api/v1/query?query=changes(ALERTS%7Balertname%3D%22LongForWindowRestoreTest%22%7D%5B10m%5D)"
```

```bash
# 用 v1.153.0 的 access_log header 打印排障「能登录但查不到数据」
# 先在 vmauth 配 access_log.headers,然后查日志
grep "access_log" /var/log/vmauth.log | grep "status_code=\"403\""

# 更好的做法:把 access_log 灌进 VictoriaLogs 用 logsQL 分析
access_log | extract 'access_log <access_log>' | unpack_logfmt from access_log
| stats by(username, request_host, status_code) count()

# v1.153.0 后 header 也在里面,可以看到用户实际带了什么租户 claim
access_log | extract 'access_log <access_log>' | unpack_logfmt from access_log
| filter status_code = "403" | fields username, AccountID, ProjectID, request_uri
```

---

## 六、五套 17 维度对比

### 6.1 指标存储写入路径架构对比

| 维度 | VM v1.153 直写 vmstorage | VM 经典 vminsert | Prometheus v3.15 + TSDB | Grafana Mimir 3.2.1 | Thanos v0.42.4 Receive |
|------|--------------------------|------------------|--------------------------|---------------------|------------------------|
| 写入入口 | vmagent → vmstorage:8482 | vmagent → vminsert:8480 | 任意 remote write sender | distributor | receive |
| 分片责任 | vmagent(`-remoteWrite.shardByURL`) | vminsert | 无(单机) | distributor 一致性哈希 | receive TSDB 本地 |
| 复制责任 | vmagent(`-shardByURLReplicas`) | vminsert(`-replicationFactor`) | 无 | distributor + ingester | 无(靠对象存储) |
| 持久队列位置 | **每 vmstorage 一个** | 无中心队列 | 每 sender 一个 | 每 ingester 一个 WAL | 无 |
| 单节点故障的写入影响 | 仅该分片堆积 | **整条写入失败(关 rerouting)** | 单机全停 | ingester 用 WAL + ring | 单 receive 全停 |
| 重路由 | 无(设计上不做) | 有,可关闭 | N/A | distributor 转发其他 ingester | N/A |
| 多租户 | URL 路径 `/insert/<tenant>` | URL 路径 | 无租户概念 | header X-Scope-OrgID | 无 |
| 内存预算位置 | 解压前(v1.153 修复后) | 同左 | ingest path 有限流 | distributor + ingester 限流 | TSDB |
| 背压机制 | 队列磁盘占用 | 内部 channel | sender 侧退避 | distributor 拒绝 429 | 无 |
| 写入跳数 | 2 跳(vmagent→vmstorage) | 3 跳 | 2 跳 | 3 跳 | 2 跳 |
| 协议 | Prometheus remote write v1 | VM 自有 + remote write + 多种 | remote write v1 / OM2 文本 | remote write v1 | remote write v1 |
| 长期存储介质 | 本地磁盘 | 本地磁盘 | 本地磁盘 | 对象存储(通过 ingester) | **对象存储** |
| 回放语义 | 队列顺序回放 | 无队列 | WAL 回放 | WAL → 对象存储 | WAL → 对象存储 |
| 跨 AZ 策略 | vmagent 跨 AZ 直写多组 | vminsert 跨 AZ | N/A | ingester 跨 AZ 复制 | receive 跨 AZ |
| 配置开关 | `-enableIngestionAPI`(默认关) | 无需开关 | N/A | 无需开关 | 无需开关 |
| 版本 | v1.153.0 (2026-09-25) | v1.152.0 (2026-09-14) | v3.15.0 (2026-09-25) | 3.2.1 (2026-09-10) | v0.42.4 (2026-07-30) |
| 生产成熟度 | 新(首个版本) | 5 年大规模验证 | 10 年 | 4 年 | 5 年 |

### 6.2 认证网关对比

| 维度 | vmauth v1.153 SSO | oauth2-proxy v7 | Pomerium | Traefik forward-auth | Envoy ext-authz |
|------|-------------------|-----------------|----------|----------------------|-----------------|
| 登录页品牌 | **vmauth 自己(第一方)** | oauth2-proxy | Pomerium | 第三方或自定义 | 第三方 |
| OIDC Authorization Code Flow | 内建 | 内建 | 内建 | 需外部 | 需外部 |
| session cookie | `_vmauth_sso`(JWT 明文) | `_oauth2_proxy`(加密) | `_pomerium`(加密 JWT) | 依实现 | 依实现 |
| claim 路由(按角色选后端) | 内建 `match_claims` | 需配合 header 转发 | policy 语法 | header 转发 | 需外部 |
| JWKS 自动轮换 | 每 5 分钟(v1.138.0) | 每 1 小时 | 每 10 分钟 | N/A | 依实现 |
| 重定向约束(本次修复) | **限于原请求主机** | allow-list 配置 | policy 约束 | N/A | N/A |
| 与后端的集成深度 | **url_prefix + extra_label 原生注入** | header 透传 | header 透传 | header 透传 | header 透传 |
| 非 GET/HEAD 的行为 | **直接 401** | 401 / 重定向 | 重定向 | 401 | 依实现 |
| session 实际长度 | min(session_duration, token exp) | cookie expire | cookie expire | 依实现 | 依实现 |
| token 是否透传后端 | 默认否,可配 | 默认否 | 默认否 | 依实现 | 依实现 |
| 部署形态 | 单二进制 | 单二进制 | 单二进制(sidecar/网关) | Traefik 插件 | Envoy filter |
| 与 vmui 的契合度 | **原生(同一进程同一配置)** | 需额外重写规则 | 需额外重写规则 | 需额外配置 | 需额外配置 |
| 配置热重载 | 是 | 是 | 是 | 是 | 需 reload |
| access_log | logfmt + header 打印(v1.153) | 标准 | 标准 | 标准 | 标准 |
| 学习曲线 | 低(一个 YAML) | 中 | 中 | 中 | 高 |
| 进程数 | 1(vmauth 全包) | 2(vmauth + oauth2-proxy) | 2 或 sidecar | 2 | 2+ |

### 6.3 内核 I/O 策略对比

| 维度 | 默认 read-ahead(内核启发式) | FADV_RANDOM(v1.153 opt-in) | O_DIRECT | io_uring + registered buffer | ZFS primarycache=metadata |
|------|------------------------------|----------------------------|----------|------------------------------|---------------------------|
| 谁决定访问模式 | 内核启发式 | **应用显式声明** | 应用 | 应用 | 应用(ZFS 层) |
| 小随机读的物理放大 | 有(可达 8-64x) | 无 | 无 | 无 | 无 |
| 偶尔顺序扫的性能 | 好 | 差(预读被禁) | 差 | 依注册 buffer | 好(metadata 在 cache) |
| page cache 利用 | 有(可能浪费在无用预读上) | 有(只缓存真读的页) | 无(绕过 cache) | 可选 | 有 |
| 对索引文件的影响 | 中性 | 无(VM 不加提示) | 无 | 中性 | 好 |
| 对数据文件的影响 | 中性 | 好(VM 只加这里) | 好 | 好 | 好 |
| 兼容性风险 | 无 | 低(个别内核/FS 差异) | 中(需对齐) | 中(需内核 5.1+) | 高(需换 FS) |
| 配置粒度 | 块设备级 | **文件级** | 打开文件时 | IO 引擎级 | pool 级 |
| 是否需要 benchmark | 不需要 | **需要** | 需要 | 需要 | 需要 |
| 云盘上的效果 | 不确定 | 中等提升 | 显著(绕过云盘缓存) | 显著 | 显著 |
| 回退成本 | 无 | 一个开关 | 需改代码 | 需改代码 | 需迁移存储 |
| 在监控场景的典型收益 | 基线 | 减少 20-40% 磁盘吞吐 | 减少 30-50% 但牺牲 cache | 高并发下显著 | 显著但架构代价高 |
| 是否被 VictoriaMetrics 采用 | 默认 | opt-in | 无 | 无 | 无 |

### 6.4 告警状态恢复机制对比

| 维度 | vmalert v1.153 restore | Prometheus v3.15 | Grafana Alerting | Mimir ruler | Thanos ruler |
|------|------------------------|------------------|------------------|-------------|--------------|
| 状态存储位置 | remote write 的 ALERTS / ALERTS_FOR_STATE | 同左(本机 TSDB) | database(postgres/mysql) | 对象存储 + TSDB | 对象存储 + TSDB |
| 恢复触发时机 | **求值循环内、状态机推进前** | 求值后 | 重启时 | 重启时 | 重启时 |
| pending 中间态 | **可跳过(本次修复)** | 存在 | 无(状态机不同) | 存在 | 存在 |
| `for` 计时精度 | ALERTS_FOR_STATE | 同左 | DB 时间戳 | 同 Prometheus | 同 Prometheus |
| 多副本 vmalert 间的状态 | 各自恢复(不共享) | 各自恢复 | 共享 DB | 各自恢复 | 各自恢复 |
| 恢复失败的行为 | **只记 error,不阻断求值** | 求值失败 | 告警停摆 | 求值失败 | 求值失败 |
| lookback 窗口 | `remoteReadLookBack` 常量 | 用户可配 | N/A | 同 Prometheus | 同 Prometheus |
| 查询时间点偏移 | 无(改回 ts) | 无 | N/A | 无 | 无 |
| activeAt 恢复 | 部分(已知限制) | 是 | 是 | 是 | 是 |
| 对消费者的抖动 | 无(v1.153 后) | 有 | 无 | 有 | 有 |
| 配置复杂度 | 需 remoteWrite + remoteRead | 本机直读 | 需 DB | 需 remote read | 需 remote read |
| 跨集群恢复 | 支持(remote read 任意源) | 不支持 | 支持(DB) | 支持 | 支持 |

### 6.5 开源时序数据库内存预算机制对比

| 维度 | VictoriaMetrics v1.153 | Prometheus v3.15 | Mimir 3.2.1 | Thanos v0.42 | InfluxDB 3 |
|------|------------------------|------------------|-------------|--------------|------------|
| 进程级硬上限 | `-memory.allowedPercent/Bytes` | GOMEMLIMIT | k8s limit | k8s limit | 配置项 |
| 超限行为 | 拒绝新分配 + 主动 GC | GC 压力增大 | OOM kill | OOM kill | OOM kill |
| 请求级大小限制 | `-maxInsertRequestSize` | 无(ingest 无限流) | distributor 限流 | 无 | 有 |
| **解压路径的预算** | **v1.153 覆盖 zstd native import** | 无 zstd 路径 | 无 | 无 | 有 |
| 查询内存限制 | 无显式(靠 GOMEMLIMIT) | `query.max-samples` | query-frontend 拆分 | 无显式 | 有 |
| 并发写入限制 | `-maxConcurrentInserts` | 无 | distributor | 无 | 有 |
| series 基数保护 | `-storage.minFreeDiskSpace` + 主动拒绝 | 无 | `limits.max-global-series-per-user` | compaction | 有 |
| 内存指标暴露 | `process_resident_memory_bytes` + go_memstats | 同左 | 同左 | 同左 | 同左 |
| 内存泄漏自检 | 内建(定期 profile) | 无 | 无 | 无 | 无 |
| 推荐容器 limit 比例 | 60% allowedPercent,limit 放 1.6x | GOMEMLIMIT = limit × 0.8 | 同 Prometheus | 同 | 依部署 |
| 被远程打挂的风险面 | 导入端点(本次修复) | ingest 端点 | distributor | receive | ingest |
| 是否有 CVE 公开 | 是(GHSA 体系) | 有 | 有 | 少 | 有 |

---

## 七、六条 6-12 个月可验证硬指标

1. **vmstorage 直写队列行为**:在 3 节点 RF=2 直写拓扑下,kill 一个 vmstorage,其余 2 个节点的写入成功率应保持 **100%**,只有该节点对应分片的 `vm_pending_metrics` 上升;恢复后队列在 **5 分钟内**回放完毕(取决于堆积量和磁盘吞吐)。经典拓扑同样操作,写入成功率 **0%**。这是一个可以在测试环境 10 分钟内跑完的对照实验。
2. **SSO 端到端时延**:从浏览器首次请求到拿到 302 跳 IdP,应 **< 50ms**(vmauth 本地开销);IdP 登录完成回调到拿到 cookie 并重定向回原 URL,应 **< 200ms**(含一次 token exchange RTT)。如果第二段超过 500ms,瓶颈在 IdP 而不是 vmauth。
3. **session 实际时长**:把 `session_duration` 配成 `24h`,IdP token 有效期配成 `1h`,实际 cookie 的 MaxAge 应该是 **3600 秒**。用 `curl -I` 看 `Set-Cookie` 头里的 `Max-Age` 验证 —— 如果你看到 86400,说明 token exp 没被正确纳入计算。
4. **fadvise 的磁盘吞吐变化**:开启 `-fs.disableAdviseRandomRead=false` 后,在**同样的查询负载**下,`rate(vm_disk_read_bytes_total)` 应下降 **20-40%**,而 `rate(vm_disk_reads_total)` 保持不变或略降。如果读字节数没变,说明你的瓶颈不在预读(可能是 IOPS 或 page cache 容量),不要指望这个开关帮你。
5. **vmalert 重启抖动**:在 v1.153.0 上,带 `for: 5m` 规则的 vmalert 被 `kill -9` 后,重启窗口内 `changes(ALERTS[10m])` 应保持 **恒定(无新增变化)**;在 v1.152.0 上同样的操作会让该值跳变 **2-3 次**。这是一个直接的版本对照。
6. **陈旧 target 残留检查**:从 v1.130.0-v1.152.0 升级上来的集群,升级后 24 小时跑一次基数审计 —— `count by (instance) (up)` 的结果里,应没有任何**已在配置中移除的旧服务地址**。如果有,它们的 series 从升级那一刻起才停止增长,但历史数据仍在,需要用 deletion API 清理(或者等 retention 自动淘汰)。

---

## 八、六条 6-12 个月可观察未来信号

1. **`-enableIngestionAPI` 的下一个版本会不会开放更多 ingest 端点**:维护者在 issue 里明确说 "It's better to expose not only remote write, but whole vminsert ingestion APIs. But lets keep remote write for now"。这句话是**明确的路线图信号** —— remote write 只是第一步。如果 v1.155-v1.160 开始支持 native import / OpenTSDB 协议直写 vmstorage,说明 VictoriaMetrics 在有意识地**把写入控制面下推到边缘**,vminsert 的角色会逐渐从「必选组件」变成「可选的集中式入口」。
2. **vmauth 会不会变成一个通用的 API 网关**:SSO + JWT claim 路由 + access log header + `discover_backend_ips` 这几件事加起来,vmauth 已经具备了一个生产级 API 网关的核心能力,只差限流和熔断。观察它会不会在后续版本加 rate limiting —— 如果加了,它就直接对标 Envoy/NGINX,成为「可观测性栈自带的网关」, oauth2-proxy 的生存空间会被显著压缩。
3. **解压路径的安全审计会不会扩展到其他协议**:这次只修了 zstd native import。VM 还支持 OpenTSDB / InfluxDB / Graphite / Prometheus remote write 等多条 ingest 协议,其中 remote write 用 snappy(已经有历史 CVE-2025-65942:Snappy Decoder DoS Causing OOM)。**一个合理预期是后续版本会有一次系统的「解压路径内存预算」审计**,把所有 ingest 协议的解压都纳入同一个预算框架。
4. **fadvise 开关什么时候变成默认**:作者明确在收集用户反馈(issue #11461)。如果在接下来 2-3 个版本里 release notes 不再提「please leave a comment」,而是直接把默认值翻过来,说明收集到的数据足够正面。**反过来,如果这个开关在 v1.160 仍然是 opt-in 且无新动静,说明它在多数部署上没有可复现的收益**,你可以降低对它的关注优先级。
5. **告警状态恢复会不会演进成「多 vmalert 共享状态」**:目前多个 vmalert 副本各自独立 restore,没有共享状态,所以多副本部署仍然会在重启时短暂重复告警(每个副本都恢复成 firing)。`ALERTS` 指标天然是**写进存储的共享状态**,用它做「我是否需要接管」的选主信号是一个显然的下一步。观察 vmalert 的 HA 模式会不会引入这个。
6. **「持久队列位置」会不会成为时序数据库选型的显性维度**:VictoriaMetrics 这次的改动实质上是把「队列在 agent 还是 in inserter」变成了一个可配置项。Mimir 的 ingester 队列、Thanos 的无队列、ClickHouse 的异步 insert 都是同一维度上的不同选择。**当写入可用性的 SLA 从「99.9%」被推到「99.99%」时,这个维度会从「实现细节」上升为「选型决策点」**。2026 年的指标平台 RFP 里值得直接把它列为必答项。

---

## 九、总结:怎么用,以及千万别怎么用

### ✅ 该做的

1. **把导入端点的升级当安全补丁打**:zstd native import 的内存限制(GHSA-8g4f-32hw-vqf8)不需要任何配置变更就能受益,直接升级到 v1.153.0+。同时确认 `-memory.allowedPercent` 的实际值不是默认的 60% 而你以为是别的。
2. **对数据一致性敏感的集群,认真评估直写**:你已经关了 rerouting,说明你把一致性看得比可用性重 —— 直写让你在不牺牲一致性的前提下拿到分片级可用性。这是 v1.153.0 里**唯一一个改变架构拓扑**的改动,值得花一个下午做 PoC。
3. **用 SSO 替掉 oauth2-proxy**:减少一个进程、一套配置、一次身份翻译。重点不是省事,是**授权模型统一**后,「谁能查什么」只有一个事实来源。
4. **配 access_log 的 headers 字段**:排障「能登录但查不到数据」时,这是唯一能直接看到用户带的 claim 的手段。注意只列必要的 header,别把 `Authorization` 打到日志里再制造一个泄露面。
5. **验证你的 alert_relabel_configs 现在真的会热重载**:这个 bug 存在的时间里,你做的每一次脱敏配置变更都可能没生效。做一次显式验证(发测试告警,在 Alertmanager 侧确认标签),不要相信 reload 成功日志。

### ❌ 千万别做的

1. **不要无脑开 `-fs.disableAdviseRandomRead=false`**。它是双否定开关(配错方向没报错),而且需要你在自己的硬件上 benchmark。在 IOPS 受限的 SSD 上它可能毫无收益,在云盘上才可能有。
2. **不要在开 FADV_RANDOM 的同时调小块设备 `read_ahead_kb`**。两个是重复手段,而且块设备层的改动会影响同盘其他服务。
3. **不要把 SSO 的 `session_duration` 当成实际 session 长度**。实际值是 `min(session_duration, token exp)`。你配 30 天、IdP 发 1 小时的 token,用户每小时就要重新登录一次,而这跟你预期完全相反。
4. **不要把 `_vmauth_sso` cookie 当成加密凭据**。它是明文 JWT。必须走 HTTPS,vmui 的源不能混不可信脚本,`session_duration` 别配太长。
5. **不要用「reload 日志显示成功」作为配置生效的判据**。alert_relabel_configs 这个 bug 就是最好的反例 —— reload 成功但配置没生效,而且这种 bug 不会自己报警。
6. **不要从 v1.130-v1.152 升级后不做基数审计**。陈旧 target bug 会让你以为已经下线的服务还在上报,这些 series 白白占存储到 retention 到期。

### 5 步生产升级 checklist

- [ ] **Step 1 —— 先升读取面**:vmselect / vmui / vmagent 先升,vmstorage 最后升。VictoriaMetrics 允许滚动升级,但 ingest 路径的变更(内存限制、API 端点)风险高于读路径,放在最后。
- [ ] **Step 2 —— 升级前快照配置**:把 vmauth 的 `-auth.config`、vmalert 的 `-notifier.config`、vmagent 的 scrape config 全部备份。升级后 diff 一次,确认没有被新版默认值改写的地方。
- [ ] **Step 3 —— 开 `-enableIngestionAPI` 前先做写入指标基线**:记下 vminsert 上的 `vm_ingestrows_total` 速率。切到直写后这个指标会**下降到 0**(因为数据不经过 vminsert 了),如果你按它做的告警或计费,会立刻误报。
- [ ] **Step 4 —— 升级后 24 小时跑基数审计**:`count by (instance, job) (up)` 跟升级前的快照对比,新增的 series 应该只有你确实新加的服务。残留旧地址 = 陈旧 target bug 的历史欠账。
- [ ] **Step 5 —— 验证热重载真的生效**:改一处 `alert_relabel_configs`,发 `/-/reload`,发一个带被脱敏标签的测试告警,在 Alertmanager 侧确认标签已移除。**这一步不做,你就不知道你的脱敏是不是一直没生效**。

### 5 条 best practice

1. **任何 ingest 端点都要经过 vmauth,并且只对内网开放**。这次的安全修复堵住了 zstd 导入的内存漏洞,但**第二道闸永远是你自己的网络隔离**。导入端点的攻击面跟查询端点完全不同:查询要认证才有人用,导入是机器对机器,最容易「先跑起来再说」然后忘了加认证。
2. **写入可用性的设计单位是「分片」不是「集群」**。直写拓扑让这一点变成了现实 —— 那么你的告警也应该是分片级的:`vm_pending_metrics{remote_write_url="..."} > 100000` 比 `vminsert 写入失败率 > 0` 更早告诉你问题出在哪。
3. **信任链的根是 `issuer` 配置**。OIDC Discovery 的重定向约束(本次修复)保证了 discovery 不会跑到别的域名,但如果 `issuer` 本身配错,一切白搭。把 `issuer` 的配置变更当成最高权限变更来管理。
4. **性能优化做错了就回滚**。stream aggregation 的并行化被退回串行,因为「省下的延迟可忽略,多费的 CPU 是真的」。这个判断标准值得借用:**优化必须带来可测量的收益,否则它就是技术债**。
5. **把「谁负责声明」写进架构文档**。v1.153.0 的六个改动全是在移动「谁声明」这个责任点 —— 写入可用性、访问控制、内存预算、访问模式、告警中间态、socket 权限。一个成熟的基础设施架构,每个不变量都应该有一个明确的「声明者」;如果它由「系统默认行为」隐式声明,那它迟早会在某个版本里被改掉。

---

## 写在最后

VictoriaMetrics 的发布节奏一向稳:每个月一个小版本,release notes 里 SECURITY / FEATURE / BUGFIX 三段泾渭分明。v1.153.0 的特别之处在于,它的六个承重级改动**全部是「移动责任点」而不是「增加新能力」**。

这其实是基础设施软件成熟的标志。一个年轻的项目在加功能(「我们能做什么」),一个成熟的项目在划边界(「谁负责保证什么」)。vmstorage 直写把写入可用性从中心化组件下推到边缘 agent;SSO 把身份声明从静态凭据上移到 IdP;zstd 内存预算把安全检查从「事后」前移到「事前」;fadvise 把 I/O 模式的判断权从内核收回应用;vmalert 跳过 pending 把「重启的必然代价」变成「可恢复就无代价」;socket 权限把 Unix 惯例还给 umask。

如果你只能从这篇里带走一句话:**在 2026 年的规模下,「系统默认行为」正在系统性地变成风险来源,而好的版本管理就是把这些默认行为一个个变成显式配置。** 下一次你看任何一个基础设施工具的 release notes,可以先问一个问题:这个版本把哪个「大家都没意识到自己正在依赖的隐式假设」翻出来了?

那个答案,通常就是这个版本真正承重的地方。

> **数据来源**:VictoriaMetrics v1.153.0 官方 release notes 与 changelog;GitHub issue #11252(vmstorage remote write 提案与维护者讨论)、#10278(SSO 需求)、#11461(fadvise 提案)、#11615(unix socket 权限)、#9878(stream aggregation 性能)、#11550(SD 陈旧 target)、#11618(空 extra_label)、#11635(alert_relabel 热重载);PR #11401 与 #11579 的完整 diff;GHSA-8g4f-32hw-vqf8 与 GHSA-xxqh-2hcc-9fp6 安全公告;VictoriaMetrics 官方文档 vmauth / vmagent 章节;Linux man pages `posix_fadvise(2)` 与 `madvise(2)`;Linux 内核文档 `read_ahead_kb` 说明。
