---
title: "Keycloak 26.8.0 深度拆解:Agent 委托的 act 声明 + OID4VCI 数字钱包 + SCIM GA + stateless 多集群,身份主权层第一次原生支持机器代表人类行动"
date: 2026-10-07
category: 技术
tags: [Keycloak, Keycloak 26.8, 身份认证, OAuth2, OIDC, TokenExchange, 委托, Delegation, act声明, FGAP, 细粒度权限, 代理身份, Agent身份, AI代理, 自动化, 数字钱包, OID4VCI, OID4VP, 可验证凭证, VerifiableCredential, SD-JWT, mdoc, HAIP, SCIM, 身份供给, Stateless, 多集群, Infinispan, Quarkus, Vert.x, HTTP客户端, Kamel, 登录失败, 暴力破解, 数据库索引, 异步提交, ClientSecretRotation, 密钥轮换, Impersonation, 模拟登录, 审计链路, SSRF, 节点注册, FullScopeAllowed, 最小权限, BreakingChange, 默认值收紧, 身份主权, IAM, 安全, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1633265486064-84dc4dd94f76?w=600&h=400&fit=crop
excerpt: "2026 年 10 月 1 日发布的 Keycloak 26.8.0 是这个 IAM 老兵近两年结构最完整的一个版本:它第一次把「机器代表人类行动」写进了令牌语义和权限模型。核心是 token exchange delegation 进入 preview——AI agent 通过 OAuth consent 拿到带 act 声明的访问令牌,FGAP V2 的 delegate / delegate-members scope 成为唯一授权路径,泄漏的委托令牌无法升级成 Admin API,标准 token exchange 会拒绝带委托声明的 subject token 防绕过,管理员还能用新 client policy executor 按 client 限制 may_act。配套的身份主权三件套同时就位:OID4VCI 从 experimental 升 preview 并补齐撤销与 attestation,OID4VP 验证器支持跨设备出示与 direct_post.jwt 加密响应,SSF 共享信号框架补上 RISC 账号启用/禁用事件;SCIM API 与 Client Secret Rotation 双双升 supported 并默认开启,跨身份系统的用户供给和零停机密钥轮换变成开箱即用;stateless 特性升 supported,multi-cluster v2 把会话存数据库、干掉外部 Infinispan 集群,v1 (multi-site) 直接 deprecated。性能侧同样动得深:登录失败计数从内存 Infinispan 搬进数据库、跨重启不再解锁;大表索引在 PostgreSQL / Oracle / MySQL / SQL Server 上用非阻塞方式启动后自动建;异步提交从 PostgreSQL 扩到 SQL Server 和 Oracle;OFFLINE_USER_SESSION 加 LAST_SESSION_REFRESH_COARSE 列和会话桶把索引竞争压下去;出站 HTTP 栈从 Apache HttpClient 换成 Vert.x/Netty 的实验实现。代价是一长串「静默放行 → 显式拒绝」的 breaking change:view-clients 不再能读 client secret、IdP mapper 默认不再授予 admin 角色、disabled client 不再进 token audience、Authorization Services 的 URI 匹配开始做归一化、bare group name 只解析顶层组、X509 认证强制要求 CA Subject DN、 initiating_idp 登出参数默认忽略。本文按「身份主权」主线拆完 6 大承重级改动,附 5 段可运行的 kcadm / curl / Python / YAML、5 套 IAM 方案 17 维度对比、6 条 6-12 月硬指标、5 步生产升级 checklist、8 个诚实边界与 3 个长期判断。"
---

# Keycloak 26.8.0 深度拆解:Agent 委托的 `act` 声明、数字钱包凭证、SCIM GA 与 stateless 多集群

> 2026 年 10 月 1 日,Keycloak 26.8.0 发布。release notes 正文 90 KB,upgrading guide 单开一整章「Migrating to 26.8.0」,其中 breaking changes 一口气列了 14 条。这是 26.x 系列里 breaking change 密度最高的一个 minor。
>
> 但密度不是重点。重点是这些改动**指向同一个方向**:在这个版本里,Keycloak 第一次原生回答了「机器凭什么代表人类行动」这个问题。

## §0 一个版本的主线:身份主权

先说清楚 26.8.0 到底在干什么。把 release notes 的 Highlights 五条和 upgrading guide 的 14 条 breaking change 并排放出来,会看到一个高度一致的模式:

| 维度 | 26.8.0 之前 | 26.8.0 |
|------|-------------|---------|
| Agent / 自动化代表用户 | 要么给 service account 塞 admin 权限,要么走模拟登录(impersonation),两者都过度授权 | consent + `delegation:client:<id>` 参数化 scope,令牌带 `act`,FGAP V2 独立授权,泄漏不可升级 |
| 数字钱包凭证 | OID4VCI experimental,无撤销、无 attestation 校验 | preview,撤销随 refresh token 一起撤销,AIA 让用户在会话内主动申请,x5c 按 HAIP profile 硬化 |
| 跨系统用户供给 | SCIM preview,大用户量性能差 | supported 且默认开启,补多值属性 / FGAP 过滤 / 查询性能 |
| 多集群部署 | multi-cluster v1 需要外部 Infinispan 集群做跨站复制 | multi-cluster v2 (stateless) supported,会话进数据库,架构简化 |
| 「配了但没生效」的放行 | view-clients 能读 client secret、IdP mapper 能授 admin 角色、bare group name 跨层级匹配 | 14 条 breaking change 全部从「静默放行」翻成「显式拒绝或显式授权」 |

**右边那一列,就是本文的主线:身份主权(identity sovereignty)。**

这个词不是营销话术。它是一个非常具体的技术判断:当一个 AI agent 要替用户去调一个下游 API,系统必须能同时回答四个问题——**谁批准的**(consent)、**令牌里写了谁在动**(`act` 声明)、**谁能批准**(FGAP V2 的 delegate scope)、**出了事能追到谁**(审计事件带 client identity)。26.8.0 之前,OAuth 2.0 的令牌语义只能回答第一个;后面三个要么靠管理员手工约定,要么干脆没有。

这跟最近一周技术圈的整体转向完全同频。从 10-01 的「关门日」、10-02 的「接入战」、10-03 的「定价战」、10-04 的「责任日」、10-05 的「反噬日」、10-06 的「溯源日」到 10-07 早间的「主权日」,行业情绪的曲线一路走到「谁能自己造、自己审、自己付钱、自己信、自己跑」。Keycloak 26.8.0 是这条曲线在基础设施层的对应物:**不是让 agent 更强,而是让「agent 代表我」这件事第一次有了可验证的语义。**

---

## §1 委托(token exchange delegation):一个 `act` 声明值多少

### 1.1 问题到底卡在哪

先看 26.8.0 release notes 里那段开门见山的描述,这是整个版本信息密度最高的一段话:

> Applications such as AI agents and automation tools need limited, consent-based access to act on behalf of a user without requiring administrator privileges or exposing sensitive credentials.

这句话点出了过去三年所有做 agent 工程的团队都撞过的同一堵墙。在 26.8.0 之前,让一个 agent 替用户调下游 API,工程上只有三条路,每条都有硬伤:

**路径一:给 agent 的 service account 直接授权。** 令牌里只有 client 自己,没有「用户」这个概念。下游 API 没法区分「agent 自己要读数据」和「agent 替张三读数据」,只能把权限开到 agent 可能需要的最大集合。这是 OAuth 2.0 里典型的 over-privileged service account,一旦令牌泄漏,爆炸半径等于 agent 的全部权限。

**路径二:让 agent 拿用户的用户名密码做 Resource Owner Password Credentials。** 这条路 2026 年还在被广泛使用,但它把「用户的长期凭证」交给了 agent 进程,而且完全绕过 consent。OAuth 2.1 已经把 ROPC 移出核心规范,OAuth 2.0 Security BCP 明确写它「不应被使用」。

**路径三:admin 模拟登录(impersonation)。** 这是 26.8.0 之前 Keycloak 里唯一能产出「代表用户」语义令牌的官方机制。但它有两个致命问题。第一,它需要 `impersonation` 角色,这是 realm-management client 上的管理角色,拿着它等于拿着「变成任何用户」的能力。第二,模拟登录产出的令牌在下游看起来跟用户自己登录的一模一样——没有 `act` 声明,下游资源服务器**无法区分**这是用户本人还是一个管理员在冒充。这个问题在 26.8.0 里被单独修了(见 §1.4),因为它本身就是「委托」这件事过去不可用的根因之一。

### 1.2 26.8.0 的答案:参数化 scope + consent + `act`

26.8.0 的 token exchange delegation 做法拆开是六件事,缺一不可:

**① 参数化 scope 作为委托入口。** 用户(client 应用)通过标准 OAuth consent 流程,请求一个新的参数化 scope:`delegation:client:<client-id>`。注意这里的语法结构——scope 名字本身就携带了「委托给谁」的信息。这是 26.8.0 里 Parameterized Scopes(原 dynamic scopes,本版本从 experimental 升 preview)第一个内建的生产级用例。参数化 scope 解决了一个长期痛点:在此之前,如果要表达「委托给 client A」和「委托给 client B」,必须预先定义两个独立的 client scope;当被委托方是动态的(比如多租户 SaaS 里的不同集成),scope 数量会爆炸。参数化写法让 `project:12345` 这种结构天然成立。

**② 令牌里写 `act` 声明。** 拿到的访问令牌包含 `act` claim,标识这个 client 是 actor。这是 RFC 8693 Token Exchange 第 4.1 节定义的标准字段,不是 Keycloak 私货。一个典型的载荷长这样:

```json
{
  "iss": "https://idp.example.com/realms/myrealm",
  "sub": "f:8a1b2c3d-aaaa-bbbb-cccc-1234567890ab:zhangsan",
  "aud": "downstream-api",
  "exp": 1762377600,
  "iat": 1762291200,
  "acr": "urn:ietf:params:oauth:2.0:loa:1",
  "resource": "https://downstream.example.com/invoices",
  "act": {
    "sub": "f:8a1b2c3d-aaaa-bbbb-cccc-1234567890ab:expense-agent",
    "client_id": "expense-agent"
  }
}
```

下游资源服务器拿到令牌后,**`sub` 是「为谁做事」,`act.sub` 是「谁在做」**。这一个字段的差别,让「agent 替用户调 API」从「没法表达」变成「令牌自证」。而且它是 RFC 标准字段,任何遵循 RFC 8693 的资源服务器(包括所有主流 API gateway 的 JWT 校验逻辑)都能直接读到,不需要 Keycloak 私有扩展。

**③ FGAP V2 成为唯一授权路径。** 这是最容易被忽略、但架构上最重要的一条。release notes 原文:

> delegation authorization is controlled exclusively through Fine-Grained Admin Permissions V2 using the delegate and delegate-members scopes

`exclusively` 这个词是关键。26.8.0 之前(实验阶段)委托用的是 realm-management client 上的 `impersonation` 角色;26.8.0 开始,这个角色被彻底旁路,授权只认 FGAP V2 的两个新 scope:`Users` 资源类型上的 `delegate`,以及 `Groups` 资源类型上的 `delegate-members`。upgrading guide 里这一条被列为 breaking change,因为这意味着:**升级之后,原来靠 impersonation 角色跑通的委托会直接失败**,必须显式建 FGAP V2 权限。FGAP V1 不支持委托权限。

**④ 泄漏的委托令牌不能升级权限。** release notes 里这句值得逐字记住:

> Unlike admin-user delegation, client delegation does not grant Admin API access even if the client holds service account credentials, ensuring that a leaked delegation token cannot escalate privileges.

这是整个设计里最克制的一处。一个 client 可能同时有 service account credentials(能以自己身份调 Admin API)和委托令牌(以用户身份调业务 API)。26.8.0 明确:委托令牌即使泄漏,攻击者也拿它换不到 Admin API 的访问权。这把「委托」的爆炸半径从「整个 realm」压缩到「该用户在该 client 上的权限」。

**⑤ 标准 token exchange 拒绝带委托声明的 subject token。** 这是一条反绕过设计。如果没有它,攻击者(或一个写错的 agent)可以拿一个委托令牌去做标准 token exchange,把 `act` 洗掉,换成一个干净的「用户身份」令牌。26.8.0 让标准交换路径直接拒绝携带委托声明的 subject token。**委托只能通过委托路径产出,不能被 launder。**

**⑥ client policy executor 限制 `may_act`。** 管理员可以用一个新的 client policy executor,按 client 限制访问令牌里的 `may_act` claim——精确控制「哪些 client 可以参与委托」。这是 per-client 的开关,不是全 realm 的一刀切。

### 1.3 一个完整的委托流程,可跑

下面这段是端到端可执行的流程。前置:Keycloak 26.8.0 已起,realm 开了 FGAP V2,建了用户 `zhangsan`、机密 client `expense-agent`(service account enabled)和被委托的 client `downstream-api`。

**第一步,管理员建 FGAP V2 委托权限(只需做一次):**

```bash
# 开启 FGAP V2 (Admin Permissions)
kcadm.sh update realms/myrealm \
  -s adminPermissionsEnabled=true

# 给 expense-agent 的 service account 授 delegate scope on Users 资源
# 先取 expense-agent 的 service account user id
AGENT_SA=$(kcadm.sh get \
  realms/myrealm/clients?clientId=expense-agent \
  | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['serviceAccounts'][0]['id'])")

# 取 Users 赨源类型的 resource id
USERS_RES=$(kcadm.sh get \
  realms/myrealm/admin-permissions/v2/resources?name=Users \
  | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")

# 取 delegate scope id
DELEGATE_SCOPE=$(kcadm.sh get \
  realms/myrealm/admin-permissions/v2/scopes?name=delegate \
  | python3 -c "import json,sys; print(json.load(sys.stdin)[0]['id'])")

# 建一条 permission: 允许 expense-agent 的 service account 委托
PERM=$(kcadm.sh create realms/myrealm/admin-permissions/v2/permissions \
  -s name="agent-delegate" \
  -s resourceType="Users" \
  -s "scopes=[\"$DELEGATE_SCOPE\"]" \
  -s "policies=[]" \
  -s "associatedResources=[\"$USERS_RES\"]")
```

**第二步,agent 发起委托(用户在浏览器里同意):**

```bash
# 浏览器打开,用户登录 zhangsan 并看到 consent 页
open "https://idp.example.com/realms/myrealm/protocol/openid-connect/auth?\
client_id=expense-agent&\
redirect_uri=https://agent.example.com/callback&\
response_type=code&\
scope=openid%20delegation:client:expense-agent&\
state=$(uuidgen)"
```

用户在 consent 页看到的是「expense-agent 请求作为你行事」,而不是「expense-agent 读取你的资料」——consent 文案跟着 scope 走,这是把「代表」这件事变成用户可见、可批准的关键。

**第三步,换 token,看 `act`:**

```bash
curl -s -X POST "https://idp.example.com/realms/myrealm/protocol/openid-connect/token" \
  -d "grant_type=authorization_code" \
  -d "client_id=expense-agent" \
  -d "client_secret=$AGENT_SECRET" \
  -d "code=$CODE" \
  -d "redirect_uri=https://agent.example.com/callback" \
| python3 -c "
import json,sys,base64
t = json.load(sys.stdin)['access_token']
p = t.split('.')[1]
p += '=' * (-len(p) % 4)
claims = json.loads(base64.urlsafe_b64decode(p))
print('sub  (为谁做事):', claims.get('sub'))
print('act  (谁在做) :', json.dumps(claims.get('act'), ensure_ascii=False))
print('scope         :', claims.get('scope'))
print('azp           :', claims.get('azp'))
"
```

输出里 `act.sub` 会是 expense-agent 的 subject。这就是整件事的产物。

**第四步,下游 API 校验 `act` 并做授权决策:**

```python
# 下游资源服务器的校验逻辑:不仅要验签,还要按 act 做授权
from jwt import PyJWKClient, decode
import os, httpx

jwks = PyJWKClient(f"{os.environ['KEYCLOAK_URL']}/realms/myrealm/protocol/openid-connect/certs")

def authorize(authz_header, required_scope):
    token = authz_header.removeprefix("Bearer ")
    claims = decode(
        token, key=jwks.get_signing_key_from_jwt(token).key,
        audience="downstream-api", algorithms=["RS256"],
    )

    scopes = set(claims.get("scope", "").split())
    if required_scope not in scopes:
        raise PermissionError(f"missing scope {required_scope}")

    act = claims.get("act")
    if act:
        # 这是一条「代表」请求:为 sub 做事,由 act.sub 执行
        return {
            "on_behalf_of": claims["sub"],
            "actor": act["sub"],
            "actor_client_id": act.get("client_id"),
            "delegated": True,
        }
    # 无 act = 用户本人直接调用
    return {"on_behalf_of": claims["sub"], "actor": claims["sub"], "delegated": False}
```

这段代码的授权分叉,在 26.8.0 之前是写不出来的——因为旧令牌里根本没有 `act`。有了它,下游可以做很多过去做不到的策略:agent 发起的写操作要求额外的 step-up 认证、agent 发起的高危操作走人工复核、agent 的调用单独计费和限流、审计日志里把「谁」和「谁在做」分开记。

### 1.4 模拟登录的补丁:`act` 变成强制存在

委托这件事过去不可用的另一个根因,是模拟登录产出的令牌「太干净」。26.8.0 连这个一起修了:

> Tokens issued from impersonation sessions now include the `act` (actor) claim (RFC 8693 Section 4.1) in both access tokens and ID tokens, allowing downstream resource servers to identify the impersonator. The claim is always present and cannot be disabled.

注意最后一句:**`act` 声明永远存在,无法禁用**。这是 Keycloak 里少见的「不可关闭」设计。理由很清楚:这个 claim 存在的唯一目的就是让下游能区分,允许管理员关掉它等于允许管理员把审计链路打断。配套地,token 生命周期事件(`CODE_TO_TOKEN`、`REFRESH_TOKEN` 等)现在都带上了 `impersonator` 和 `impersonator_id` 详情。

同一批改动里还有一处细节:token introspection 端点的 `act.sub` 原来放的是 impersonator 的**用户名**,现在改成**用户 ID**,跟 JWT 里的 `act` 对齐;需要用户名的消费者改读 `act.preferred_username`。这是一个典型的不显眼但会打断下游解析的 breaking change。

---

## §2 数字钱包凭证:OID4VCI / OID4VP 与共享信号

如果 §1 解决的是「机器代表人类」,§2 解决的是「人类证明自己」——而且是不依赖 Keycloak 这个发行方的证明。

### 2.1 从 experimental 到 preview,补上了什么

26.8.0 把 OpenID for Verifiable Credential Issuance (OID4VCI) 从 experimental 升到 preview,可以 `--features=preview` 或 `--features=oid4vc-vci` 启用。但升降级本身不重要,重要的是这一跳补上了什么:

**撤销随 refresh token 一起撤销。** 这是凭证生命周期里最关键的一块。在这之前,一个已签发的可验证凭证没有可靠的撤销路径——你可以吊销 refresh token,但凭证本身还能用。26.8.0 让两者绑定:refresh token 被吊销时,对应凭证一并吊销。这把「凭证撤销」这个 verifier 侧最难处理的问题,变成了 token 生命周期的自然延伸。

**Application Initiated Action (AIA) 让用户在会话内主动申请。** 过去申请凭证只能走管理员触发的流程;现在用户在一个已认证会话里就能发起凭证签发请求。这是把「发行」变成用户自服务能力的第一步。

**Key attestation 按 HAIP profile 硬化。** 钱包证明(proof)里的 key attestation 现在在 admin console 可配,并按 HAIP (Holder Authentication / Issuer Protocol) profile 做硬化校验。配套的安全修复链非常密集(见 §2.3)。

**实验性 mdoc 格式支持。** 由新的 experimental feature `oid4vc-mdoc` 提供。mdoc 是 ISO 18013 系列的移动驾驶执照格式,这是第一次 Keycloak 能签发非 JSON 格式的凭证。同时 SD-JWT 的签名密钥设置、凭证管理、撤销都有了正式文档,并给出了 Lissi 和 Valera 两个钱包的集成指南。

### 2.2 OID4VP:验证器侧与跨设备出示

签发侧之外,验证侧(Verifier)在本版本也有了实质进展:

- **跨设备出示流程(cross-device presentation)**:用户在手机钱包里点「出示」,二维码给另一个设备上的 verifier 扫——这是数字凭证最主流的交互形态,26.8.0 之前不支持。
- **`direct_post.jwt` 加密响应模式**:verifier 收到的授权响应是加密的,而不是明文 JWT。这在跨设备场景里尤其重要,因为响应可能经过不可信的中转。
- **信任材料可委托给外部 IdP**:verifier 校验凭证所需的信任材料(issuer 的公钥/元数据)可以通过 alias 委托给一个外部身份提供者,而不是必须全量内置。
- **SD-JWT User Attribute / Session mappers**:从出示的凭证里抽取 claims。

### 2.3 OID4VCI 的安全修复密度,是本版本最值得看的信号

把 release notes 里标为 `oid4vc` 的条目单独摘出来,会看到一个惊人的密度:

| 编号 | 问题 |
|------|------|
| #50368 | Account API 删除已签发凭证的端点缺少所有权校验 |
| #50517 | `key_attestations_required` 在 proof JWT 缺少 key attestation header 时不强制 |
| #50518 | key attestation 的 x5c 链拿系统 cacerts 校验,**无 EKU、无吊销检查** |
| #50520 | `/create-credential-offer` 的 `expire` 参数无上界,允许无限期的预授权码 |
| #50521 | `getAttestationRequirements()` 把 proof type 硬编码成 jwt |
| #50523 | LD-VC signer **用明文 HTTP 拉远程 `@context` URL,无 allowlist、无缓存** |
| #50524 | 用户可编辑的 `did` 属性被当作凭证 subject,且只有 realm 内唯一性 |
| #50749 | OID4VC JWT proof 的 JWK claim 类型混淆,导致 proof 校验崩溃 |
| #50934 | 凭证请求解密对 RSA-OAEP-256 密钥接受 RSA1_5 算法 |
| #50965 | URI client-policy executor 漏掉 OIDC front-channel logout URI |
| #52013 | **未认证的 RSA1_5 padding oracle**(列为 CVE 级) |
| #52058 | 动态 URL 的 hostname pollution 风险 |
| #52105 | 已签发凭证的删除不限定到 path user 或 realm |
| #52665 | 同名 client role 通过角色命名混淆授权 victim-targeted 的 credential offer |
| #52666 | 旋转后的 OID4VCI refresh token 可重复使用,反复重新签发凭证 |
| #52667 | 用户可编辑的映射属性可把 SD-JWT 凭证有效期延长到发行方配置之外 |
| #52669 | 未认证的凭证请求在 bearer 认证之前就触发私钥 JWE 解密 |
| #52670 | 刷新被盗的 targeted offer 可让其他用户绕过 offer-required 签发 |
| #52671 | SD-JWT 签发让数组 claim 变成 all-or-nothing 披露 |
| #52919 | 内存泄漏 + 解压缩无上限 |
| #52732 | OID4VCI access token 只能用于 credential endpoint |

**这个清单本身就是一篇安全研究。** 而且它揭示了一个结构性事实:**OID4VCI 之所以修复密度这么高,是因为它把「身份」从「域内断言」变成了「跨域携带的载荷」。**

在传统 OIDC 里,令牌是 Keycloak 自己签、Keycloak 自己验,trust boundary 就是 realm 边界。可验证凭证不一样:它被用户钱包拿着,跨 issuer、跨 verifier、跨设备流动。上面这些 bug 里最典型的两条——#50523 用明文 HTTP 拉远程 `@context`、#50518 的 x5c 链不校验 EKU 和吊销——**都是「把跨域载荷当成域内数据」造成的**。前者假设 URL 可信(跨域不可信),后者假设系统 cacerts 够用(跨域的 issuer 证书不在里面)。

这是一个值得记住的判断:**一个身份原语从「域内」走向「跨域」,它的攻击面不是线性增长,而是维度增长。** 传统 OIDC 的威胁建模里「签发者=验证者」这个隐含前提一旦失效,所有基于这个前提省略掉的校验全都变成漏洞。26.8.0 这 21 条修复,本质上是把 OID4VCI 从「能 demo」补到「能跨域」。

### 2.4 Shared Signals Framework:账号状态变成可订阅事件

与凭证签发配套的是共享信号框架(SSF, Shared Signals Framework)。26.8.0 之前它只发 CAEP 的 session 和 credential 事件;现在补上了 **RISC 的 `account-disabled` 和 `account-enabled` 事件类型**——用户被启用/禁用时,所有订阅方都会收到信号。

这件事的价值在凭证场景里特别明显:一个用户的账号在 issuer 侧被禁用了,verifier 侧不可能立刻知道(凭证是用户自己拿着的)。有了 RISC 事件,verifier 可以在收到 `account-disabled` 后拒绝该用户的凭证出示。**这是可验证凭证「撤销问题」在协议层的解法**,而不是靠 issuer 维护一个 CRL 端点等 verifier 来轮询。

同一批改动里还有一处容易被忽略但很重要的安全收紧:

> the admin event store no longer receives unvalidated payloads to prevent PII leakage

SSF 事件之前会把未校验的 payload 原样写进 admin event store,这会导致 PII 泄漏。这是「事件总线」类设计里很典型的问题:事件生产者以为下游会校验,下游以为上游已校验,结果是没人校验。

---

## §3 SCIM API:从 preview 到 supported 且默认开启

### 3.1 SCIM 解决的是身份主权里「供给」这一层

SCIM (System for Cross-domain Identity Management, RFC 7643/7644) 提供了一套标准接口,在 realm 内管理用户和组,让 Keycloak 能被任何支持 SCIM 的身份管理系统当作供给目标(或来源)。26.8.0 把 SCIM API 从 preview 升 supported 并**默认开启**。

这一层为什么重要?因为它和 §1 的委托是互补的两面。委托回答「这个 agent 现在能不能代表张三」;SCIM 回答「张三这个人,在所有系统里是不是同一个人、状态是不是一致」。一个 agent 拿着委托令牌去调 5 个下游 SaaS,如果其中 3 个系统里的张三已经离职但没被同步,委托令牌就会作用在「不存在的身份」上。**SCIM 是委托语义能成立的数据基座。**

### 3.2 性能问题:SCIM 在大用户量下为什么慢

本版本对 SCIM 的改进里,最有信息量的是三条性能修复,因为它们揭示了一个共同的反模式:

**#51400 — SCIM 用户序列化产生约 200 倍不必要的 UserProfile 实例。** 序列化一个用户时,UserProfile 被反复构造。原文措辞是 "~200x more UserProfile instances than necessary"。这是典型的「N+1 in disguise」:看起来没有 N+1 查询,但对象构造的次数是 O(N) 而本该是 O(1)。

**#51402 — 每次 SCIM search/list 请求都执行无条件 `COUNT(*)` 查询。** 分页需要总数,但总数可以被缓存或用 `startIndex`/`itemsPerPage` 语义避免。每次请求一次全表 `COUNT(*)` 在百万级用户表上是灾难。

**#51403 — SCIM filter 字符串每次请求被 ANTLR4 grammar 解析两次。** 同一个过滤器,进来解析一次,执行时又解析一次。

**这三条加起来说明一件事:SCIM 实现过去是「功能正确但从未被 profile 过」。** 200x 对象构造、无条件 COUNT、重复解析——这三处都是 profile 一眼就能看到的 hot spot,但它们在 preview 阶段被「能跑就行」掩盖了。从 preview 升到 supported 之前把它们修掉,说明 Keycloak 团队把「supported」理解为「能扛生产负载」,而不只是「API 稳定」。这是一个版本成熟度信号,值得在别的项目上复用:**一个 feature 从 preview 到 supported 之间,真正发生的事情往往不是 API 变化,而是性能基线被建立。**

性能之外,SCIM 在本版本还补上了多值用户属性支持、User Profile 权限集成、搜索过滤器里支持 Fine-Grained Admin Permissions。

### 3.3 SCIM 的安全修复清单

与 OID4VCI 类似,SCIM 在本版本也有一串安全修复,同样指向「跨域」这个主题:

| 编号 | 问题 |
|------|------|
| #50471 | list 操作的 `count` 参数缺少下界校验 |
| #50473 | Groups 端点的 members 操作不强制 `isAdminUser` 检查 |
| #50475 | PATCH 操作的 list **没有大小限制**,缺少 `maxOperations` 强制 |
| #50985 | Users filter 在 FGAP 下泄漏隐藏的组成员关系 |
| #50986 | Groups filter 在 FGAP 下泄漏隐藏的成员关系 |
| #50987 | SCIM 读取和过滤绕过映射属性的 user-profile view 权限 |
| #50991 | SCIM 用户写操作绕过自定义属性的 user-profile edit 权限 |
| #52207 | User Profile 允许把多个属性映射到同一个 SCIM 属性 |
| #52208 | 通过 SCIM API 建用户不强制核心属性的 required 校验 |
| #52598 | SCIM 成员关系 PATCH 事件在审计链路里漏掉被改变的关系 |
| #52599 | FGAP 禁用时 SCIM legacy query 推断跨资源成员关系 |
| #52642 | SCIM 用户删除跳过 security-state 清理 |

注意 #50985/#50986/#50987/#50991 这一组:**它们全部是「FGAP 权限被绕过」。** SCIM 端点和 Admin REST API 操作同样的用户数据,但走的是不同的权限检查路径。Keycloak 在 Admin REST API 上做了 FGAP 集成,SCIM 端点却有自己的鉴权实现,于是出现了一个系统性缺口:**SCIM 成了 FGAP 的旁路通道**。本版本一次性补上。

**这里有一个可复用的架构判断:任何「同一份数据的第二个 API 入口」都必须共享权限检查,否则它必然成为权限模型的绕过通道。** Admin REST API 和 SCIM API 是同一 user 表的两个入口;未来任何项目加「兼容 API」「legacy API」「导入 API」时,这条都适用。

---

## §4 stateless:多集群从「外部 Infinispan」到「会话进数据库」

### 4.1 架构变化

26.8.0 把 stateless 特性从 preview 升 supported,同时把 multi-cluster v1 (multi-site feature) 标 deprecated。这是本版本唯一一条架构层面的重大变更,值得画清楚前后差异。

**v1 (multi-site) 架构:**

```
Keycloak 集群 A  ──┐
                   ├──►  外部 Infinispan 集群(跨站复制)
Keycloak 集群 B  ──┘          │
                             └──► 数据库
```

**v2 (stateless) 架构:**

```
Keycloak 集群 A  ──►  数据库(会话)  ◄──  Keycloak 集群 B
     │                                    │
     └── 内嵌 Infinispan(仅本地缓存) ────┘
```

差异看起来只是「把 Infinispan 从外部挪到内嵌」,但运维复杂度的差别是数量级的。v1 需要运维一个独立的 Infinispan 集群、配置跨站复制、处理 fencing 自动化(跨站脑裂时谁来 fence)。v2 把会话写进数据库,内嵌 Infinispan 只当缓存用,跨集群的缓存失效由数据库层面保证。

release notes 对 v1 的判决写得很直接:

> multi-cluster v1 ... is deprecated and will be removed in a future major release. Multi-cluster v2, which uses the stateless feature, is the recommended replacement. It simplifies the deployment architecture by eliminating the need for an external Infinispan cluster, its cross-site replication, and the associated fencing automation.

### 4.2 stateless 的三个硬约束

但 stateless 不是免费的。upgrading guide 里三条约束是真正会在生产里咬人的:

**① 必须显式设 cluster name,且不能是默认值 `ISPN`。** Keycloak 在 stateless + cluster name 缺失或仍是 `ISPN` 时**拒绝启动**。两个共享同一数据库的部署必须用不同 cluster name,否则跨集群缓存失效不工作。

**② MySQL / MariaDB 事务隔离被设成 READ COMMITTED。** 这是为了防止并发登录下的死锁。代价是:如果启用了 binlog 且 `binlog_format = STATEMENT`,写操作会失败。Keycloak 启动时检测到这个不兼容配置会报错。这是一个典型「正确性优先于兼容性」的选择——宁可启动失败,也不在不一致的状态下跑起来。

**③ 蓝绿部署的重叠窗口要重新设计。** stateless 引入了一个 jdbc-ping 层面的校验:用 jdbc-ping 发现的节点会周期性检查「是否有另一个 cluster name 不同的 Keycloak 部署连着同一个数据库」。如果检测到且没开 stateless,节点会报错并通过 health endpoint 报告不健康。

upgrading guide 对此给出了四种场景的明确判断,这段内容本身就是一份很好的部署设计文档:

- **单集群**:不受影响。
- **蓝绿,同一时刻只有一个集群活着**:不受影响,因为两个 cluster name 不会同时出现。
- **蓝绿,有重叠窗口且用了不同 cluster name 但没开 stateless**:重叠期间两个部署都报错并标记不健康——**这是 by design 的**。因为没开 stateless 时跨部署缓存失效不工作,两个部署同时服务流量是 unsafe 的。
- **多个独立部署共享同一数据库**:必须开 stateless 并给每个部署唯一 cluster name。

**这个设计体现了一个明确的取舍:把「unsafe 配置」从「静默运行」变成「大声报错」。** 跟 §5 的 14 条 breaking change 是同一个哲学。

### 4.3 会话存储优化:stateless 能成立的技术前提

stateless 之所以能从 preview 升 supported,依赖的是同版本里几条会话存储优化,否则会话进数据库会成为性能瓶颈:

**异步提交(async commit)扩展到 SQL Server 和 Oracle。** 之前只有 PostgreSQL 有。规则是:只更新临时表(persisted user sessions、client sessions、login failures、events)的事务用延迟/异步提交,提高吞吐;登出仍然强制同步提交。MS SQL Server 需要 DBA 先开 delayed durability(`ALTER DATABASE ... SET DELAYED_DURABILITY = ALLOWED`),Oracle 不需要额外配置。用 XA datasource 时这个优化自动禁用。可以 `--spi-connections-jpa--quarkus--async-commit=false` 关掉。

**`OFFLINE_USER_SESSION` 加 `LAST_SESSION_REFRESH_COARSE` 列。** 原来每次 token refresh 都会更新 `IDX_USER_SESSION_EXPIRATION_LAST_REFRESH` 索引上的高基列,造成热点块竞争。新列是粗粒度时间戳,把更新频率压下来;同时引入会话桶(session bucket)进一步降低索引竞争。代价是超过 30 万行的表,索引创建会在启动后被跳过并打印 SQL 供手动执行(见 §4.4)。

**可以彻底关掉持久会话的缓存。** `--spi-user-sessions--infinispan--use-caches=false`。因为数据库层已经足够快(async commit + 更好的索引 + 更便宜的 refresh 日期更新),不缓存成为可行选项,能降低内存和节点间网络流量,滚动更新更平滑。代价是重度使用 token introspection / token exchange 的部署会看到数据库连接数和 CPU 上升。

### 4.4 大表索引:从「启动时跳过」到「启动后自动建」

这是一个小但精的改动,解决的是所有 IAM 系统都有的升级痛点。

**问题:** Keycloak 升级时做 schema 迁移,大表的索引创建会跳过,避免阻塞启动。运维得手动建索引。这是长期被吐槽的点——升级看似成功,其实数据库处于次优状态,某天某个查询突然慢了才发现索引没建。

**26.8.0 的解法:** 启动时跳过的索引,现在会在启动后用**非阻塞**方式自动创建:

| 数据库 | 非阻塞创建方式 |
|--------|-----------------|
| PostgreSQL | `CREATE INDEX CONCURRENTLY` |
| Oracle | `CREATE INDEX ... ONLINE` |
| MySQL / MariaDB | online DDL(默认) |
| SQL Server Enterprise / Developer / Azure SQL | `CREATE INDEX ... WITH (ONLINE = ON)` |

而且 PostgreSQL 上如果存在之前一次失败的 `CREATE INDEX CONCURRENTLY` 留下的 invalid index,Keycloak 会检测到、删掉、重建。不支持非阻塞创建的数据库(或迁移策略设为 manual / validate),仍然只打印 SQL 供手动执行。

**一个具体的影响面:** `OFFLINE_USER_SESSION` 表在 26.8.0 有新列 `LAST_SESSION_REFRESH_COARSE` 和重建的索引 `IDX_USER_SESSION_EXPIRATION_CREATED` / `IDX_USER_SESSION_EXPIRATION_LAST_REFRESH`;PostgreSQL 和 SQL Server 上 `IDX_OFFLINE_USS_BY_BROKER_SESSION_ID` 也会重建为 filtered index。**超过 30 万行的表,这些索引在自动 schema 迁移时默认跳过。** 这就是新机制发挥作用的地方——启动后自动补上。

---

## §5 十四条 breaking change:从「静默放行」到「显式拒绝」

这是本版本最值得逐条读的部分。upgrading guide 的「Migrating to 26.8.0 → Breaking changes」一节列了 14 条,它们的共同模式是:**过去某个不安全的配置会静默放行,现在要么要求显式授权,要么直接拒绝。**

### 5.1 读权限与敏感数据

**`view-clients` 不再返回 client secret。**
`GET /admin/realms/{realm}/clients` 和 `GET /admin/realms/{realm}/clients/{id}` 在调用者只有 `view-clients` 权限时,不再在响应里带 client secret。要看 secret 必须有 `manage-clients`。升级后只读管理员会看到 masked placeholder。这条 breaking change 的杀伤面是自动化:任何用只读账号轮询 client 配置的 CI/CD 或 inventory 系统,拿到的 secret 会变成占位符。**一个只读 API 返回写密钥,本来就是权限模型的 bug,只是这次被修了。**

**Client session 列表按用户可见性过滤。**
`GET .../clients/{id}/user-sessions` 和 `.../offline-sessions` 现在过滤掉调用者无权查看的用户的会话。之前任何 `view-clients` 角色持有者能看到该 client 的全部用户会话——对没有 `view-users` 权限的运维来说,这是一条用户身份泄漏通道。

**`kcadm` / `kcreg` 强制 owner-only 权限。**
CLI 工具现在每次写凭证都把配置文件设成 `0600`。之前只有首次创建时才设;如果文件已存在且是 `0644`,token 就会被其他用户读到。**这是「process state(文件权限)也要算攻击面」的典型例子**——凭证不在内存里泄漏,而是在磁盘权限上泄漏。

**`show-config` 现在遮蔽所有 SPI option 值。**
因为该命令无法知道某个属性是否被标为 `isSecret`,所以一律遮蔽。这是「不确定是否敏感就当敏感处理」。

### 5.2 权限提升路径

**IdP mapper 默认不再授予 admin 角色(CVE-2026-12388)。**
这是本版本最严重的 CVE,也是最典型的一条。原来,只持有 `manage-identity-providers` 权限的管理员,可以配置一个 IdP mapper,给 brokered 用户授予管理角色或加入带管理角色的组——**权限越权**。`manage-identity-providers` 的语义是「配联邦」,不是「授权管理员」。

26.8.0 给 IdP 加了 `allowAdminRoleMapping` 设置,默认 `false`,**包括升级时已存在的 IdP**。只有持 `manage-realm` 权限的管理员能打开。这个「默认 false 且对历史配置也生效」的选择很关键——CVE 修复如果只对新配置生效,等于不修。

注意 upgrading guide 的一句话:**这个改动不会移除已有的角色/组授予**。如果历史上有 IdP mapper 授过管理角色,需要显式清理。

**Group policy 对 bare group name 只解析顶层组(CVE-2026-19608)。**
Authorization Services 的 group-based policy 用 token 里的 `groups` claim 作第一来源。当 claim 里的组名是 bare name(不是完整路径)时,现在**只解析顶层 realm group**。之前 `Admins` 这个 bare name 会匹配层级里任何叫 `Admins` 的组——一个用户可以满足指向另一个同名组的策略。

upgrading guide 给出的迁移路径:如果你用 Group Membership protocol mapper 且关了 Full group path,并且依赖 group policy 指向嵌套组,**必须开启 Full group path**,让令牌带 `/Organization/Admins` 而不是 `Admins`。

**Disabled clients 不再进 token audience(CVE-2026-93999)。**
被禁用或删除的 client 永远不会出现在 token 的 `aud` claim 里,它的 client roles 也不会出现在 `resource_access`。令牌照发,只是不带这个 client。**这个设计很克制:登录和刷新继续成功,下游不会被 401 打断,但权限被悄悄收紧。**

**「能 map role 的人也能 view role」。**
允许给用户映射角色的管理员,现在也被允许查看该角色。这是一个「权限补齐」而非收紧:之前 `GET .../users/{id}/role-mappings` 会因为缺 view 权限返回 403,现在返回能 map 的角色列表。client 级端点在没有 view 权限时返回空列表而不是 403。

### 5.3 协议层行为变更

**Authorization Services 的 URI 匹配做归一化。**
这是 14 条里工程上最复杂的一条。匹配请求 URI 与配置的 resource URI 时,现在先归一化:

- Matrix 参数(如 `;jsessionid=...`),包括 percent-encoded 的 `%3B`,被剥离
- Dot segments(如 `/foo/../admin`、`/./admin`),包括 `%2E%2E`、`%2e.`,被解析
- Percent-encoded 斜杠 `%2F` 被解码,产生的重复斜杠被合并
- 尾部斜杠被剥离
- query string 和 fragment 在匹配前被丢弃

**目的:** 防止受保护资源 URI 的「变体」绕过它的策略,落到更宽松的资源(比如 catch-all `/*` resource)上。

**这条 breaking change 的杀伤面是「你的授权配置恰好靠 URI 变体区分资源」。** 如果你配置了两个资源,一个 `/api/admin` 一个 `/api/admin/`,或者靠 query string 区分,升级后它们会被当成同一个。

**`initiating_idp` 登出参数默认忽略。**
RP-initiated logout 端点上的 `initiating_idp` 参数现在默认被忽略。这个参数原本会**抑制**上游 IdP 的登出。升级后 Keycloak 在浏览器登出时**总是**执行上游 IdP 登出。要恢复旧行为需开启 `allow-initiating-idp-logout-param` server option(deprecated)。

**这条的方向值得注意:它删掉了一个「跳过上游登出」的能力。** 单点登出链路上,「跳过某一环」本身就是安全削弱,而它之前是默认允许的。

**X509 用户认证强制要求 CA Subject DN。**
X509 client authenticator 之前已改,本版本用户侧也跟上:必须配置 Certificate Authority 的 subject DN(多值,标识可信锚 CA)。该选项在 admin console 里现在是必填。`Revalidate Client Certificate` 选项被废弃且不再在 console 显示。**注意 Keycloak 的 trust store 是跨所有 realm 共享的**,新配置让你能为用户证书指定正确的 CA,避免与无关 CA 干扰。

**Email 不再被其他流程标记为已验证。**
之前一些流程会把用户 email 标成 verified,尽管它们的目的不是 email 验证。这会让「由另一方注册的账号」看起来可信。现在 email 只有用户完成 email 验证才标记为 verified。影响的行为:IdP 按邮箱做账号关联、不含 Verify Email 的管理员发起 action 邮件、OID4VCI 的 credential offer 邮件。IdP 和 LDAP 联邦的 Trust Email 设置不受影响——那是管理员的显式决策。

### 5.4 部署与配置

**Operator 的 OIDC Client CR 引用 Secret 需要标签。**
`KeycloakOIDCClient` CR 里 `spec.client.auth.secretRef` 引用的 Kubernetes Secret 现在必须带标签 `operator.keycloak.org/kind: KeycloakOIDCClient`。没有标签,operator 会当作 Secret 不存在并在 CR 上报 `HasErrors` 状态。**这防止 operator 读取命名空间里的任意 Secret。**

**stateless 升 supported,`--features=preview` 不再激活它。**
之前靠 `--features=preview` 开 stateless 的部署,必须显式 `--features=stateless`。

**Client Secret Rotation 和 SCIM API 默认开启。**
从 preview 升 supported 并默认 on。之前显式 `--features=client-secret-rotation` 或 `--features=scim-api` 的配置不再需要。**默认开启 = 声明这是生产级能力。**

### 5.5 弃用清单:值得单独一提的三条

**`Full Scope Allowed` 开关被弃用。**
这是 26.8.0 里最有长期影响的一条弃用。开着它(新建 client 的默认值),client 收到的 access token 包含用户在**所有 client 和 realm** 上的全部角色。Keycloak 的措辞很直白:"a single compromised token grants access to every resource the user can reach."

从本版本起,每个仍开着 Full Scope Allowed 的 client 在签发令牌时都会打一条 WARN 日志(内建 admin clients `security-admin-console` 和 `admin-cli` 被豁免)。upgrading guide 明确给出迁移路径:用 `full-scope-disabled` client policy executor 强制新建/更新的 client 关掉它。**这是把「开发期便利」变成「生产期默认错误」的标准操作。**

**Keycloak Realm Operator EOL。**
仓库将被 archive。`KeycloakRealm` / `KeycloakClient` CR 被 `KeycloakRealmImport`、`KeycloakOIDCClient`、`KeycloakSAMLClient` 取代。

**Kerberos credential delegation 被弃用。**
`gss delegation credential` protocol mapper 因安全原因被弃用。

---

## §6 出站 HTTP 客栈换血 + 运行时升级

### 6.1 Vert.x HTTP Client(实验)

Keycloak 的出站连接(到外部 IdP、OCSP responder、backchannel logout 端点)一直用 Apache HTTP Client。但 Keycloak 的入站流量早跑在 Vert.x/Netty 上了。**一个进程里两套 HTTP 栈,是复杂度和依赖开销的来源。**

26.8.0 提供实验性的 Vert.x HTTP client,用 `--features=http-client:v2` 开启,启用后**所有**出站 HTTP 流量走 Vert.x client。

扩展兼容性处理得很克制:`getHttpClient()` 返回一个 compatibility bridge,把 Apache API 调用内部翻译成 Vert.x 调用,现有扩展不用改。但官方明确推荐迁移到两套 client 上行为一致的 API:`SimpleHttp.create(session)`,或 `HttpClientProvider` 上的 provider-neutral 方法 `getString(uri)` / `getInputStream(uri)` / `postText(uri, text)`。

**这是一个标准的「先桥接、再迁移」策略,而且把「迁移目标 API」直接写进了 release notes。**

### 6.2 Quarkus 3.33 → 3.40

跨了 7 个 Quarkus minor。upgrading guide 的表述是:"no user-facing configuration changes are required, custom extensions or providers that depend on Quarkus-internal APIs should be retested"。release notes 里的升级轨迹是 3.37.4 → 3.38 → 3.38.1 → 3.39.0.CR1 → 3.39.1 → 3.39.2 → 3.40.0.CR1 → 3.40。依赖 Quarkus 内部 API 的自定义 provider 是唯一需要动手的地方。

### 6.3 登录失败计数从内存搬到数据库

这条看起来是细节,实际影响很大。

**之前:** 暴力破解检测的登录失败数据只存在内嵌 Infinispan 的 `loginFailures` cache 里。**重启就丢**——被临时锁定的用户,集群重启后就能重新登录。这是一个「正确性被可用性妥协」的经典案例:内存计数快,但它不是状态,是缓存。

**26.8.0:** 登录失败数据默认存数据库(`login-failures:v2`)。被锁定的用户跨重启保持锁定,同时降低累积登录失败条目的内存消耗。旧行为用 `--features=login-failures:v1` 恢复(deprecated)。

**三个代价:**
1. 数据库连接使用增加、数据库 CPU 上升
2. `spi-brute-force-protector-default-brute-force-detector-allow-concurrent-requests` 选项在 v2 下**失效且无效果**——同一用户的并发登录在每个节点上串行执行
3. `login-failures:v1` 与 stateless 特性**不兼容**

**注意第三条:** v1 存内存、stateless 把会话存数据库,两者对「状态在哪里」的假设冲突。这是版本内部的一致性约束,不是 bug。

### 6.4 组织(organizations):IdP 多对多关联

身份提供者与组织的关系从多对一变成多对多。一个 IdP 现在可以关联多个组织,每个关联有独立的 auto-membership 和 membership type 配置。**域路由(domain routing)从 IdP 挪到 domain 实体**,每个 domain 独立指定哪个 IdP 处理认证、是否自动重定向。

**domain gate 保证跨组织隔离:** 只有用户邮箱域名被某个组织 claim 时,才会被自动加入该组织——即使多个组织共用同一个 IdP。迁移后新建的 IdP link 默认 `Unmanaged`,已有的迁移成 `Managed` 保旧行为。

迁移涉及的 schema 变动不小:新建 `ORG_IDENTITY_PROVIDER` join 表、`ORGANIZATION_ID` 列从 `IDENTITY_PROVIDER` 表移除、`ORG_DOMAIN` 表加 `REALM_ID` / `IDP_ID` / `AUTO_REDIRECT` 列。三个 IdP 配置项被迁移后删除:`kc.org.domain` → `ORG_DOMAIN.IDP_ID`;`kc.org.broker.redirect.mode.email-matches` → `ORG_DOMAIN.AUTO_REDIRECT`;`kc.org.excluded.domains` → 以 `IDP_ID=NULL` 迁移(该域名用户看到标准登录表单而不是被重定向)。

**「域名排除」这个概念被删掉了**,取而代之的是每个 domain 自己的路由配置——要排除一个 domain,就把它的 Identity provider 字段留空。这是从「黑名单语义」到「每实体显式配置」的迁移,跟 §5 的整体方向一致。

### 6.5 三个小而实在的改进

**加密 PEM 私钥支持。** 以前用加密私钥要转成非加密格式或用 keystore。现在直接支持 PKCS#8 加密 PEM,用新选项 `--https-certificate-key-file-password` 提供解密密码;management interface 用 `--https-management-certificate-key-file-password`。

**稳定节点名。** `--cache-embedded-cluster-name` 和 `--cache-embedded-node-name` 成为一等 CLI 选项。之前节点名每次启动随机生成,metrics / logs / JGroups 诊断跨重启无法关联。用 Operator 部署时节点名自动设成 Pod 名(如 `keycloak-0`);非 Operator 的 K8s 部署用 downward API 注入 `metadata.name`。**这是一个纯粹的可用性改进,但价值在事故排查时才显现。**

**Client Secret Rotation supported。** 通过 client policies 轮换机密 client 的 secret,保持最多两个并发活跃 secret,实现零停机轮换。管理员可以规划轮换时间表。这条从 preview 升 supported。

---

## §7 横向对比:5 套身份方案 17 维度

| 维度 | Keycloak 26.8 | Auth0 (Okta) | PingFederate 12 | ZITADEL | Ory Kratos + Keto |
|------|---------------|---------------|------------------|---------|------------------|
| 部署模型 | 自托管 / Operator / Helm | 托管 SaaS | 自托管 / 虚拟设备 | 自托管 / 云 | 自托管 / Helm |
| Agent 委托语义 | ✅ `act` + FGAP V2 delegate scope + consent | 暂无原生委托 claim | 有 token exchange 但无 `act` 语义 | 有 token exchange,无 `act` | 无(需自行组合) |
| 可验证凭证签发 | ✅ OID4VCI preview + OID4VP + mdoc exp | 有(Okta Verified) | 无 | 无 | 无 |
| 跨身份系统供给 | ✅ SCIM 2.0 GA 默认开 | ✅ SCIM GA | ✅ SCIM GA | 部分 | 需自建 |
| 多集群无外部缓存 | ✅ stateless(会话进 DB) | N/A(托管) | ❌ 依赖外部集群 | 支持 | 状态本就在 DB |
| 细粒度权限 | ✅ FGAP V2 / V1 | ✅ RBAC + ABAC | ✅ 极完整(传统) | ✅ | 需 Keto 单独部署 |
| 密钥轮换零停机 | ✅ client-secret-rotation 默认开 | ✅ 托管自动 | ✅ | ✅ | ❌ 需手工 |
| 暴力破解状态持久 | ✅ DB 默认 + 跨重启保持 | ✅ 托管 | ✅ | ✅ | ✅ |
| Token exchange 标准 | ✅ RFC 8693 + 委托防绕过 | 部分 | ✅ | ✅ | ❌ |
| 组织 / 多租户 | ✅ IdP 多对多 + domain gate | ✅ Organizations | ✅(传统模型) | ✅ Instances | ❌ 需自建 |
| AuthZEN 端点 | ✅ 实验,需 confidential client token | ❌ | ❌ | ❌ | ❌ |
| 共享信号(SSF/CAEP/RISC) | ✅ 实验,RISC account 事件 | ✅ 托管 | ❌ | ❌ | ❌ |
| 后量子 / mTLS 硬化 | mTLS 支持完整,X509 强制 CA DN | 托管管理 | ✅ 传统强 | 部分 | 部分 |
| 出站 HTTP 栈 | Vert.x/Netty(实验,可切) | N/A | Apache HttpClient | Go net/http | Go net/http |
| 协议覆盖 | OIDC / SAML / OAuth2 / WS-Fed | OIDC / SAML | OIDC / SAML / WS-Fed(最全) | OIDC / SAML | OIDC(SAML 弱) |
| JVM / 运行时 | Quarkus 3.40 / Vert.x | N/A | Java | Go(单二进制) | Go(单二进制) |
| 学习曲线 | 高(概念多,文档全) | 低(托管 + 文档好) | 高(传统企业向) | 中 | 中(组件分散) |

**怎么选:** 需要本地化部署 + 完整协议覆盖 + 委托语义 + 可验证凭证 → Keycloak 26.8;要最短的上线时间、不想运维 IAM → Auth0;传统企业、要 WS-Fed 和成熟 FAPI → PingFederate;要单二进制、云原生、CIAM 味道 → ZITADEL;要极细粒度组合、愿意自己拼 → Ory。

---

## §8 6 条 6-12 月可验证硬指标

每一条都是今天就能跑、6-12 个月内能反复复现的。

**指标 1:委托令牌的 `act` 声明存在且正确**
升级后对委托 scope 发起的令牌做一次解码,断言 `act.sub` 存在且等于被委托 client 的 subject;同时对标准 token exchange 发起一个带委托声明的 subject token,断言返回错误而非成功令牌。
```bash
python3 -c "
import json,base64,os,urllib.request,urllib.parse
tok=os.environ['DELEGATED_TOKEN']
p=tok.split('.')[1]; p+='='*(-len(p)%4)
c=json.loads(base64.urlsafe_b64decode(p))
assert 'act' in c and 'sub' in c['act'], 'act.sub missing'
assert c['act'].get('client_id')=='expense-agent'
print('PASS act =', c['act'])
"
```

**指标 2:`view-clients` 读不到 client secret**
用一个只有 `view-clients` 的账号调 `GET /admin/realms/{realm}/clients/{id}`,断言 `secret` 字段是 masked placeholder 而非真实值。这条 5 分钟就能验证,但能直接暴露所有依赖只读账号拿 secret 的自动化。

**指标 3:IdP mapper 无法授予 admin 角色(CVE-2026-12388)**
升级后断言所有 IdP 的 `allowAdminRoleMapping` 为 `false`(包括升级前已存在的)。然后以 `manage-identity-providers` 权限的管理员尝试创建一个授予 realm-admin 的 mapper,断言被拒绝。
```bash
kcadm.sh get realms/myrealm/identity-provider/instances \
| python3 -c "import json,sys; [print(i['alias'], i.get('allowAdminRoleMapping')) for i in json.load(sys.stdin)]"
```

**指标 4:登录失败跨重启持久**
开暴力破解保护,故意触发锁定,重启一个 Keycloak 节点,断言该用户仍处于锁定状态(`login-failures:v2`)。用 `--features=login-failures:v1` 时这条必然失败——这正是它被 deprecated 的原因。

**指标 5:大表索引启动后自动建**
在一个 `OFFLINE_USER_SESSION` 超过 30 万行的库上升级到 26.8.0,记录启动时被跳过的索引 SQL,然后断言启动后这些索引以非阻塞方式被创建(PG 上可用 `SELECT * FROM pg_stat_all_indexes WHERE indexrelid::regclass::text LIKE 'idx_user_session_expiration%';` 观察到 `idx_scan` 之外的创建记录,或直接 `pg_index` 查 `indisvalid`)。

**指标 6:SCIM 端点在 FGAP 下不泄漏隐藏成员关系**
建一个 FGAP V2 策略让用户 A 看不到组 G,通过 SCIM `GET /scim/v2/Groups?filter=...` 断言返回结果里不含 G 的成员关系(#50985/#50986 的回归测试)。

---

## §9 5 步生产升级 checklist

**第 1 步:升级前审计(不断服,可提前做)**

```bash
# 1.1 找出所有 IdP mapper 授予管理角色或管理组的配置(升级后默认被阻断)
kcadm.sh get realms/myrealm/identity-provider/instances
# 对每个 IdP 检查 mapper 是否授予 realm/admin 开头的角色,或加入 admin 组

# 1.2 找出依赖 view-clients 读 secret 的自动化(升级后拿到占位符)
grep -rn "client.*secret\|secret" .github/workflows/ inventory/ scripts/ 2>/dev/null

# 1.3 检查 Authorization Services 是否靠 URI 变体区分资源
# matrix 参数 / 尾斜杠 / query string / %2F 现在全部归一化
kcadm.sh get realms/myrealm/clients/{id}/authz/resource-server/resources

# 1.4 检查 Full Scope Allowed 状态(升级后开始打 WARN)
kcadm.sh get realms/myrealm/clients \
| python3 -c "import json,sys; [print(c['clientId'], c.get('fullScopeAllowed')) for c in json.load(sys.stdin)]"

# 1.5 检查 group membership mapper 是否关了 Full group path
# 如果关了且依赖嵌套组 policy,必须先打开
```

**第 2 步:stateless / cluster name 决策**

```bash
# 2.1 如果用 multi-site (multi-cluster v1),规划迁到 stateless
#     v1 已 deprecated,未来 major 版移除
# 2.2 stateless 必须显式设 cluster name 且不能是 ISPN,否则拒绝启动
#     共享同一 DB 的两个部署必须不同 cluster name
--features=stateless --cache-embedded-cluster-name=prod-a

# 2.3 MySQL/MariaDB + stateless: 检查 binlog_format
SHOW VARIABLES LIKE 'binlog_format';
# 必须不是 STATEMENT,否则写操作失败(隔离被设成 READ COMMITTED)

# 2.4 蓝绿部署: 评估是否有重叠窗口
#     没开 stateless + 重叠窗口 + 不同 cluster name = 重叠期双双不健康(by design)
```

**第 3 步:数据库准备**

```bash
# 3.1 OFFLINE_USER_SESSION > 30万行: 索引启动时会被跳过
SELECT COUNT(*) FROM OFFLINE_USER_SESSION;
# 26.8.0 启动后会用非阻塞方式自动建(PG: CREATE INDEX CONCURRENTLY)
# 老版本升级前可以预建,减少启动后窗口

# 3.2 MS SQL Server 用 async commit 需要先开 delayed durability
ALTER DATABASE [keycloak] SET DELAYED_DURABILITY = ALLOWED;
# Oracle 不需要额外配置;XA datasource 下自动禁用此优化

# 3.3 Galera 不在支持配置内;wsrep_sync_wait=0 会启动报错
```

**第 4 步:灰度升级 + 验证**

```bash
# 4.1 备份 realm 导出
kcadm.sh export --realm myrealm --dir /tmp/realm-backup

# 4.2 升级第一个节点,优先验证登录主链路
#     特别检查: 自定义登录主题(social-providers.ftl / IdP 图标 CSS 可能错位)

# 4.3 跑 §8 的 6 条硬指标

# 4.4 验证委托链路(如果用了 token exchange delegation)
#     scope 从 delegation:<admin> 改成 delegation:user:<admin>(重命名 breaking change)
#     确认 FGAP V2 的 delegate permission 已建好
```

**第 5 步:升级后清理**

```bash
# 5.1 清理历史 IdP mapper 授予的管理角色(CVE 修复不会自动移除已有授予)
# 5.2 给 OIDC Client CR 引用的 Secret 加标签
kubectl label secret <name> operator.keycloak.org/kind=KeycloakOIDCClient

# 5.3 Realm Operator 用户:迁到 KeycloakRealmImport / KeycloakOIDCClient(Realm Operator EOL)
# 5.4 关掉 sticky session route 注入(已 deprecated):
#     spi-sticky-session-encoder--infinispan--should-attach-route=false
#     spi-sticky-session-encoder--remote--should-attach-route=false
# 5.5 自定义扩展:如果用了 getHttpClient(),迁到 SimpleHttp 或 HttpClientProvider 方法
#     (Apache / Vert.x 两套 client 上行为一致)
# 5.6 旧的 delegation client scope 可以在迁移后删除(已被 delegation:user 取代)
```

---

## §10 8 个诚实边界

写文章最怕把 release notes 吹成万能药。这 8 条是我在拆完 26.8.0 之后认为**必须说明但 release notes 不会强调**的限制。

**1. Token exchange delegation 仍是 preview,不是 supported。**
这是本版本「最像 GA 但其实不是」的特性。它跟 SCIM / Client Secret Rotation 一起出现在 Highlights 里,但后两者升了 supported,委托没有。用 preview 特性上生产要做好「下个版本语义可能变」的准备。**而且它上一版是 experimental——从 experimental 到 preview 到 supported 通常还要至少一个版本。**

**2. OID4VCI 是 preview,OID4VP 的 mdoc 支持是 experimental。**
release notes 自己也说了 example applications 是 "for illustration, not officially supported"。数字钱包凭证这条链路目前在生产里只能做有限场景试点。

**3. 委托 breaking change 会直接打断现有自动化。**
`delegation` scope 重命名为 `delegation:user`,完整格式从 `delegation:admin1` 变成 `delegation:user:admin1`;授权从 impersonation 角色迁到 FGAP V2。**这两条是 breaking change,不是「升级后自动适配」。** 用了实验性委托的部署升级后必须改代码。

**4. 登录失败进数据库,代价是数据库连接数和 CPU 上升。**
这不是免费的正确性。在高登录量 + 小数据库规格的部署上,`login-failures:v2` 会让 DB 压力可见地上升。官方明确承认了这个 trade-off。

**5. `login-failures:v1` 与 stateless 不兼容。**
想要「登录失败存内存」就不能开 stateless,两者对状态位置的假设冲突。这不是 bug 但会在混合配置时困惑人。

**6. secure-client-node-hostname executor 是 opt-in,升级后默认不生效。**
SSRF 防护(§5)不会自动开启。用了 legacy adapter 节点注册的部署必须显式加 executor + 配置允许的 hostname pattern。**而且升级前必须先清理 `registeredNodes` 里带端口后缀的旧条目**——不删掉直接开 policy,旧条目仍然留在 map 里被用于管理回调,绕过新策略。

**7. Vert.x HTTP client 是 experimental,且现有扩展会被桥接而非自动迁移。**
桥接层保证兼容性,但性能优势只在迁移到 `SimpleHttp` / `HttpClientProvider` 之后才完全兑现。第三方扩展的作者需要动一次手。

**8. 本版本的安全修复清单说明 OID4VCI 的攻击面还没收敛。**
§2.3 那 21 条修复是「这一版修了」,不是「没有问题了」。一个 preview 特性在一个版本里修 21 个安全问题(其中一条是未认证的 RSA1_5 padding oracle),说明它还在快速硬化中。**把它当生产级能力用,要先评估自己的威胁模型是否接受「凭证格式本身还在大改」。**

---

## §11 3 个长期判断

**判断 1:`act` 声明会成为 Agent 时代令牌的默认组成部分,而不仅是 Keycloak 的功能。**

这不是 Keycloak 的创新。RFC 8693 第 4.1 节定义 `act` 已经很多年了,只是从来没有人用——因为机器代表人类的场景不存在。2026 年 agent 工程普及之后,这个字段的利用率会快速上升。判断依据是三件事同时发生:① Keycloak 把它写成「强制存在、无法禁用」(§1.4);② 下游 API gateway 和资源服务器开始按 `act` 做策略分叉;③ 各国监管(欧盟 AI Act、加州 SB1246、白宫自我监管协议)都在要求「自动化行动可审计」。

**更具体的预测:6-12 个月内,主流 API gateway(Caddy / Envoy / NGINX)的 JWT 校验插件会内置 `act` 的策略 hook。** 因为一旦发行侧(如 Keycloak)稳定产出这个字段,消费侧的精细化授权就是刚需。谁先支持,谁就能在 agent 流量治理上占位。

**判断 2:「同一份数据的第二个 API 入口」是权限模型的系统性绕过通道,这个教训会从 Keycloak 扩散到整个生态。**

§3.3 那 4 条 SCIM 绕过 FGAP 的修复,和 §5.1「view-clients 能读 secret」的修复,本质是同一类问题:**Admin REST API 做了 FGAP 集成,SCIM 端点自己实现鉴权,于是 SCIM 成了旁路。** 同样的事情在每个有「兼容 API / legacy API / 导入 API / SCIM / Admin API」多个入口的系统上都会发生。

**判断标准很简单:数一下你的系统里有多少个入口操作同一份核心数据。** 超过一个,就要问它们的权限检查是否共享同一份代码路径。这个检查今天就能做,而且通常会立刻发现一到两个缺口。

**判断 3:身份层正在从「认证服务」变成「主权边界」,2026 H2 这是选 topic 的新地图。**

把 26.8.0 的五条 Highlights 放在一起看:委托(机器代表我)、可验证凭证(我自己携带的身份)、SCIM(我的身份跨系统一致)、stateless(我的部署不依赖外部组件)、Organization 多租户(我的组织边界)——**五条全部是「主权」的某个侧面。**

这跟一周来技术圈的整体转向完全同频:从「关门日」到「主权日」,行业情绪从「AI 能不能更强」走到「谁能自己造、自己审、自己付钱、自己信、自己跑」。Keycloak 26.8.0 是这条曲线在身份基础设施层的对应物。

**相邻的可选主题(给未来选 topic 用):** 与 Keycloak 同层的 IAM 项目(ZITADEL / Ory / Authentik / Casdoor)、凭证钱包侧(Spruce ID / Animo /Sphereon)、SSF/CAEP 实现侧、以及消费侧——**API gateway 对 `act` claim 的策略支持**目前是空白,这是我认为 6-12 个月内最可能出现新项目或新特性的位置。

---

## §12 写在最后

Keycloak 26.8.0 不是一个性能版本,也不是一个功能版本。它是一个**语义版本**。

过去三年所有做 agent 工程的团队都在同一个问题上碰壁:令牌里没有「谁在替谁做事」这个字段。于是大家各自发明:有的给 service account 塞最大权限,有的让 agent 拿用户密码,有的用 admin 模拟登录然后祈祷不出事。三条路都过度授权,三条路都留不下审计链路。

26.8.0 用一个 RFC 标准字段、一个参数化 scope、一个 FGAP 权限、一条反洗钱规则,把这件事变成了令牌自证的语义。**不是让 agent 更强,是让「agent 代表我」第一次可验证。**

这个版本里另外一条暗线同样值得记住:**14 条 breaking change,全部方向一致——从静默放行到显式拒绝。** IdP mapper 默认不再授 admin 角色、view-clients 读不到 secret、disabled client 不进 audience、bare group name 只匹配顶层、URI 匹配做归一化、email 只能由验证流程标记、X509 强制 CA DN。一个版本里这么多 breaking change 朝同一个方向,在 Keycloak 的历史上不常见。

把它和这一周的行业情绪放在一起:10-01 关门日、10-02 接入战、10-03 定价战、10-04 责任日、10-05 反噬日、10-06 溯源日、10-07 主权日。从「关上默认开放的门」到「让每一次授权可被审查」,技术基础设施层的动作和商业层的情绪是同步的。

**最佳实践一句话总结:在这个版本里,Keycloak 把「谁批准的、谁在动、谁能批准、能追到谁」这四个问题,第一次全部写进了令牌和权限模型。** 你的 agent 架构如果还没有回答这四个问题,26.8.0 提供了现成的答案;如果已经用别的方式回答了,这四个问题本身值得作为架构 review 的 checklist。

> 数据来源:Keycloak 26.8.0 GitHub Release notes(release body 90,499 字节)与 Keycloak 官方 Upgrading Guide「Migrating to 26.8.0」章节(Notable changes / Breaking changes / Deprecated features)。版本发布于 2026-10-01。
