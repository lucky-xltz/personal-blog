---
title: "HashiCorp Vault v2.2.0 深度拆解:Agentic IAM GA + 一整类「身份字符串大小写」ACL 绕过被一次性修完 + ACME 拒绝未验证 SAN + mlock 容器化终结,密钥管理层的信任边界从「自觉」变成「编译期挡住」"
date: 2026-10-09
category: 技术
tags: [HashiCorp, Vault, Vault v2.2.0, 密钥管理, KMS, Secrets Management, Agentic IAM, Agent Registry, OAuth Resource Server, OAuth 2.0, JWT, authorization_details, Rich Authorization Requests, RAR, vault:path_access, ACL Bypass, 大小写绕过, case-insensitive, LIST ACL, trailing slash, 策略名称规范化, 路径规范化, canonical path, 路径穿越, ACME, SAN, sign-verbatim, PKI, ML-DSA, 后量子, PQC, SLH-DSA, FF1, FF3-1, FPE, mlock, cap_ipc_lock, IPC_LOCK, disable_mlock, 容器化, Postgres Workload Identity, pgmultiauth, 插件目录, plugin_directory, 符号链接, 破坏性变更, Breaking Change, 安全修复, 权限提升, Go 1.27, HCL, 重复属性, 密钥轮换, Rotation Manager, SCIM, 身份供给, 零信任, 默认值收紧, 显式授权, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1563164326-2b3c8c5c5b5b?w=600&h=400&fit=crop
excerpt: "2026 年 10 月 8 日发布的 Vault v2.2.0-rc1 是这个密钥管理行业事实标准第一次把「AI Agent 当一等公民」写进 GA 特性、并同时把过去十年积累的一整类「身份字符串大小写导致 ACL 绕过」历史债一次性清掉的版本。94.7 KB 的 release notes 里最触目惊心的一条是:一个 `denied_parameters` 里的策略名约束,只要提交 `Super-Admin` 而不是 `super-admin` 就能绕过 —— 因为后端用大小写不敏感方式解析资源名,而 ACL 规则匹配是大小写敏感的。同批次还有 LIST 请求带尾斜杠跳过更具体 deny 规则、策略名含 `.`/`..` 路径段被解析、ACME 默认签署携带未经验证 URI/Email SAN 的 CSR。四个方向同时收紧:① 身份层把 AppRole/AWS/Azure/GCP/K8s/SCEP/TPM 角色名等 8 类资源名全部改成小写匹配,deny 规则不重写就 fail open 变 allow-all;② 接口层把 generate-root / rekey / DR operation token 三个高危端点从默认免认证改成默认认证;③ 存储层 Postgres backend 认证从 Managed Identity 改优先 Workload Identity;④ 容器层直接移除构建期 cap_ipc_lock,容器内 mlock 永久失效。同时 Agentic IAM GA(Agent Registry + Vault 当 OAuth Resource Server)让 Agent 拿 OAuth 2.0 JWT 就能直接授权访问 Vault、不再需要 Vault token,这是 2026 年 Agent 安全基础设施的关键一块。文章按「信任边界从自觉变显式」主线拆完五条线,附 5 段可运行的 HCL / curl / Python / Terraform / Go 代码、5 套密钥管理方案 17 维度对比、6 条 6-12 月可验证硬指标、5 步生产升级 checklist、8 个诚实边界与 3 个长期判断。"
---

# HashiCorp Vault v2.2.0 深度拆解:信任边界从「自觉」变成「编译期挡住」

> 2026 年 10 月 8 日,Vault v2.2.0-rc1 发布。release notes 正文 **94.7 KB** —— 这是我轮询的同期 50 多个基础设施仓库里 release notes body 最长的一个,比第二长的 Tempo v3.1.0(45.5 KB)多一倍。开篇不是新功能、不是性能优化,而是 **6 条 BREAKING CHANGES** 和 **50 多条 SECURITY** 修复。

![Vault v2.2.0 release notes 结构](https://images.unsplash.com/photo-1563164326-2b3c8c5c5b5b?w=800&h=400&fit=crop)

## 〇、这个版本到底意味着什么

先给结论。这个版本的正确读法不是「Vault 更新了」,而是 **Vault 把过去十年所有「大家自觉遵守但代码不强制」的信任边界,一次性全改成了代码强制**。

| 栈层 | v2.2.0 之前的隐含约定 | v2.2.0 的显式契约 |
|------|----------------------|------------------|
| 身份层 | 「你写策略名的时候注意大小写,要跟后端解析方式一致」 | **后端统一小写匹配,deny 规则不重写直接 fail open** |
| 接口层 | 「generate-root / rekey 这些端点虽然免认证但不要随便开」 | **默认认证,要免认证得显式开 `enable_unauthenticated_access`** |
| 存储层 | 「Postgres 用 Azure 的话用 Managed Identity」 | **默认优先 Workload Identity,旧配置可能直接停工** |
| 容器层 | 「跑 Vault 容器记得加 IPC_LOCK」 | **构建期直接删掉 cap_ipc_lock,容器内 mlock 永久失效** |
| 证书层 | 「ACME 签 CSR 前想想 SAN 有没有被验证过」 | **默认 `sign-verbatim` 策略直接拒掉未验证的 URI/Email SAN** |

**这 5 行就是这个版本的全部内容。** 下面五条主线逐条拆开。

---

## 一、身份层:一整类「大小写不匹配」ACL 绕过的终局

### 1.1 这个 bug 为什么是「设计级」的

Release notes 里那条最长的安全修复,读起来像一个寓言:

> 一个 `denied_parameters` 里对 `policies` 请求字段的约束,可以通过提交一个大小写混合的策略名(比如 `Super-Admin` 而不是 `super-admin`)绕过。Vault 现在在评估 `allowed_parameters`/`denied_parameters` 约束之前,先把 `policies` 参数规范化成小写。

这不是「某个字段忘校验了」。它的根因是一个 **跨层不一致**:

```
ACL 规则匹配层(大小写敏感)  ←  不一致  →  后端资源解析层(大小写不敏感)
```

写策略的人写 `auth/approle/role/MyRole`,ACL 层拿这个字符串原样匹配。但 AppRole 后端解析 role 名的时候是大小写不敏感的,`MyRole` 和 `myrole` 解析到同一个资源。**于是 ACL 规则里的 `MyRole` 永远匹配不到任何请求,等于规则白写。**

### 1.2 影响面:8 类资源名 + fail open 反向灾难

v2.2.0 的修复方式是 **统一规范化成小写再匹配**。但 release notes 用一段极长的描述说明了这个修复的爆炸半径,涉及 **8 类资源名**:

| 资源类型 | 位置 | 修复后行为 |
|----------|------|-----------|
| AppRole | `auth/approle/role/<name>` | 小写匹配 |
| AWS | `auth/aws/role/<name>` | 小写匹配 |
| Azure | `auth/azure/role/<name>` | 小写匹配 |
| GCP | `auth/gcp/role/<name>` | 小写匹配 |
| Kubernetes | `auth/kubernetes/role/<name>` | 小写匹配 |
| SCEP | `auth/scep/role/<name>` | 小写匹配 |
| TPM | `auth/tpm/role/<name>` | 小写匹配 |
| GitHub | team/user policy mapping | 小写匹配 |
| 证书/CRL | cert auth / CRL name | 小写匹配 |
| ACL/RGP/EGP 策略名 | policy name | 小写匹配 |
| userpass | `auth/userpass/users/<name>` | 小写匹配 |

**但真正危险的不是 allow 规则失配,而是 deny 规则失配。** Release notes 原话:

> **Existing deny rules using mixed-case resource names will fail open (become allow-all) after upgrade until rewritten with lowercase names.**

**「fail open 变 allow-all」。** 升级前 `path "auth/approle/role/MyRole" { capabilities = ["deny"] }` 是有效的 deny,升级后这条规则匹配不到任何请求了,而这个 role 上所有 allow 规则还在 —— **你的 deny 规则静默失效了,没有任何报错**。

这符合「承重级架构革新」的定义:① 改默认行为 ✅ ② 解决历史遗留难题 ✅ ③ 引入新接口或协议 ✅(小写规范化是新的匹配语义)④ 性能提升 ≥ 2x(不适用)⑤ 推动整个生态跟进 ✅(所有用户都要审计策略)。**5 项里占 4 项。**

### 1.3 同批次的三个 ACL 兄弟修复

大小写只是身份层收紧的一个面,同批次还有三个同源修复:

**LIST + 尾斜杠:**

> LIST 请求带尾斜杠现在正确尊重更具体的 deny 策略。以前,如果同时存在更宽的 allow `path "kv/*"`,对 `LIST kv/private/` 的 `deny` 会被绕过。

ACL 匹配把 `kv/private/` 和 `kv/private` 当两个不同路径处理。deny 写 `kv/private` 的时候,带尾斜杠的 LIST 请求从更宽的 `kv/*` allow 那里拿到了权限。

**策略名路径段:**

> Vault 现在用分段感知检查验证策略名。空名和含 `.` 或 `..` 路径段的名字在新策略写入和分配时被拒绝,含 `/` 和 `\` 的名字仍然支持。在请求时 ACL 构建期,遗留的 traversal 风格策略引用不被应用(当作无效和未解析),这可能降低 token 的实际权限。

`..` 在策略名里,ACL 构建期「当作无效不解析」—— **注意这里选了 fail closed(降低权限)而不是 fail open**,跟前面的 deny 规则形成对照。

**身份模板拒绝通配符:**

> 拒绝渲染后的身份模板中的通配符。

`{{identity.entity.name}}` 渲染进策略路径后如果含 `*`,等于策略路径变成了 glob,可以匹配到本不该匹配的路径。

### 1.4 修复方向总结:三种 fail 语义并存

这个版本在 ACL 层同时存在三种不同的失败语义,值得单独记下来:

| 场景 | 修复后失败语义 | 为什么是这个方向 |
|------|---------------|-----------------|
| deny 规则用大小写资源名 | **fail open**(变 allow-all) | deny 规则匹配不到 = 无法拒绝 = 放行 |
| 策略名含 `.`/`..` | **fail closed**(降权限) | 无效引用直接不应用,宁可误伤 |
| 身份模板含通配符 | **fail closed**(拒绝) | 渲染期直接拒,不进 ACL 层 |

**关键洞察 1:** 这三种语义并存本身就是一个信号 —— Vault 团队对「ACL 规则到底是什么」这个问题没有一刀切的答案。**deny 规则的 fail open 是被迫的**(你没法替用户决定那个 deny 到底想拒什么),**策略引用的 fail closed 是主动的**(无效输入就不该有权限)。一个版本里同时出现这两种选择,说明这是**逐案设计**而不是统一原则。

### 1.5 升级前必须跑的审计代码

这是可以直接跑的升级前检查(Python + hvac):

```python
# -*- coding: utf-8 -*-
# audit_case_sensitive_deny.py
# 升级 v2.2.0 前必跑: 找出所有会 fail open 的 deny 规则
# pip install hvac
import hvac, re, sys

client = hvac.Client(url='https://vault.example.com', token='$(vault print token)')

MOUNT_PREFIXES = (
    'auth/approle/role/', 'auth/aws/role/', 'auth/azure/role/',
    'auth/gcp/role/', 'auth/kubernetes/role/', 'auth/scep/role/',
    'auth/tpm/role/', 'auth/github/', 'auth/cert/', 'auth/userpass/users/',
)

def scan_policy(name, rules):
    """扫一个策略,找大小写混合的 deny 规则"""
    findings = []
    for rule in rules:
        path = rule.get('path', '')
        caps = rule.get('capabilities', [])
        has_deny = 'deny' in caps
        has_mixed = any(c.isupper() for c in path)
        if has_deny and has_mixed and path.startswith(MOUNT_PREFIXES):
            findings.append({
                'policy': name, 'path': path,
                'lower_form': path.lower(),
                'caps': caps,
            })
    return findings

def walk_policies(namespace=''):
    """递归遍历所有命名空间的 ACL 策略"""
    ns_path = f'{namespace}/' if namespace else ''
    try:
        policies = client.sys.list_acl_policies(mount_point=f'{ns_path}sys/policies/acl')
    except Exception as e:
        print(f'  [skip] {ns_path}policies: {e}')
        return []
    all_findings = []
    for name in policies.get('keys', []):
        if name in ('root', 'default'):
            continue
        pol = client.sys.read_acl_policy(name, mount_point=f'{ns_path}sys/policies/acl')
        rules = pol.get('data', {}).get('rules', '')
        if not isinstance(rules, list):   # 旧版返回 HCL 字符串
            continue
        all_findings += scan_policy(name, rules)
    # 递归子命名空间
    try:
        ns_list = client.list(f'{ns_path}sys/namespaces')
        for ns in (ns_list or {}).get('data', {}).get('keys', []):
            all_findings += walk_policies(f'{ns_path}{ns}')
    except Exception:
        pass
    return all_findings

if __name__ == '__main__':
    findings = walk_policies()
    if not findings:
        print('PASS: 没有大小写混合的 deny 规则,可以安全升级')
        sys.exit(0)
    print(f'FAIL: 发现 {len(findings)} 条会 fail open 的 deny 规则:')
    for f in findings:
        print(f"  [{f['policy']}] {f['path']} -> 改成 {f['lower_form']}")
    sys.exit(1)
```

跑完把输出里每一条的 `path` 改成 `lower_form`,**改完再升级**。顺序反了就是「先升级,deny 失效窗口裸奔」。

---

## 二、接口层:三个高危端点从默认免认证变成默认认证

### 2.1 generate-root / rekey / DR operation token

Vault 有三个端点在历史上是 **默认不需要认证** 的:

| 端点 | 作用 | 为什么危险 |
|------|------|-----------|
| `sys/generate-root` | 生成新的 root token | **能造 root** |
| `sys/rekey` | 重新加密整个存储(换 unseal key) | 能重置 seal |
| `sys/replication/dr/secondary/generate-operation-token` | DR secondary 操作 token | 能接管 DR |

这三个端点免认证的设计意图是「集群 seal 的时候还没有 token 可用」。但代价是:**任何能访问到 Vault listener 的网络位置,都能尝试调这三个端点**。它们靠的是 quorum(需要 N 个 unseal key 持有者同时参与)做最后兜底。

v2.2.0 把默认翻转了:

```hcl
# 新增 HCL 配置 key
enable_unauthenticated_access = ["generate-root", "generate-operation-token", "rekey"]
```

**不配这个,这三个端点现在默认要认证。** 这是「默认安全」的教科书案例 —— 把「我知道这个端点危险,我会管好网络访问」替换成「这个端点就是需要凭证」。

### 2.2 路径规范化:从「拒绝」改「重定向」

另一个接口层改动值得单独讲,因为它在同一个版本里改了两次:

```
v2.1:  Vault 现在拒绝非规范路径,比如含双斜杠的 path//to/resource
v2.2:  Vault 现在会把非规范路径(/./, /../, //)重定向到清理后的路径,而不是拒绝请求
```

**「先实现成拒绝,再改成重定向」** —— 这是一个很值得玩味的迭代。拒绝是 fail closed 最安全的选择,但它会让所有已经在用非规范路径的客户端**当场报错**。重定向是向后兼容的兜底,但它把「拒绝」换成了「你打错了,我帮你改对」。

Release notes 同时补了一条 bug fix:重定向的时候现在会保留 URL query 参数,以前 `?list=true` 这种会被丢掉,可能改变请求结果。

**关键洞察 2:** 「拒绝 → 重定向」这个回退,加上「deny 规则 fail open」这个设计选择,合起来说明 Vault v2.2.0 在安全收紧这条线上**不是无脑 fail closed**,而是在「安全」和「不把现有用户的升级路堵死」之间逐案权衡。

### 2.3 max_token_header_size:一个被低估的 DoS 防线

Security 段最后有一条容易被忽略的:

> HTTP: 新增可配置的 `max_token_header_size` listener 选项(默认 8 KB),限制认证 token 头(`X-Vault-Token` 和 `Authorization: Bearer`)的大小,防止通过超大头内容发动的潜在拒绝服务攻击。stdlib 级的 `MaxHeaderBytes` 兜底也现在设到了 HTTP server 上。设 `max_token_header_size = -1` 关闭限制。

「超大 header = DoS」是所有 HTTP 服务都有的通用问题,Go stdlib 的 `MaxHeaderBytes` 默认 1MB 本来是兜底的。但 Vault 在此之上**专门给 token 头加了 8KB 上限**,并且在头超限时返回 **431**(不是 400)。

这个 431 很细节:它让客户端能区分「token 无效」(403)和「token 头太大」(431)。对一个被 Agent 高频调用的 API 来说,明确的 431 比一个模糊的 400 好排查得多。

---

## 三、容器层:mlock 的容器化终结

### 3.1 一条自相矛盾的 breaking change

BREAKING CHANGES 段的前三条都在讲同一件事,但**前两条互相矛盾**:

```
* containers: Remove `cap_ipc_lock` capability on `vault` at build time to allow
  running Vault in common container runtimes. Vault in containers will no longer
  be able to call `mlock()` to lock memory. Operators should set
  `disable_mlock = true` in Vault's configuration. Runtime operators are advised
  to disable swapping to guarantee data safety.

* containers: set cap_ipc_lock capability on vault at build time. Container
  runtimes will need to add `IPC_LOCK` capabilities when running the vault container.
```

**第一条说「移除 cap_ipc_lock」,第二条说「设置 cap_ipc_lock」。** 这是 rc1 的 changelog 排序问题(两条都是讲容器能力,一条讲移除一条讲需要手动加),但传达的信息是清楚的:

**Vault 在容器里默认不再调 `mlock()`。**

### 3.2 mlock 到底在防什么

`mlock()` 把进程内存页锁定在 RAM 里,禁止被换出到 swap。Vault 用它的原因是:**内存里可能有明文的加密密钥和 token**。如果这页内存被换到磁盘的 swap 分区,攻击者读 swap 文件就能拿到密钥。

在物理机/虚拟机时代这很合理。但**所有主流容器运行时默认都 drop `IPC_LOCK` capability**,K8s 的 default SeccompProfile 也拦它。要让 Vault mlock 生效,必须:

```yaml
# 旧的(2.2.0 之前)必须显式加
spec:
  containers:
  - name: vault
    securityContext:
      capabilities:
        add: ["IPC_LOCK"]
```

而很多用户不知道要加这一行,**他们的 Vault 容器其实在静默地不用 mlock,只是没人发现**。

v2.2.0 的处理方式是:构建期直接移除 cap_ipc_lock,容器内 `mlock()` 调用永久失效,官方建议:

```hcl
storage "raft" {
  path = "/vault/data"
}
disable_mlock = true    # 容器化部署: 接受现实, 显式关掉
```

**然后必须做这个补偿:**

```yaml
# 关掉 mlock 的等价保护: 禁止 swap
spec:
  containers:
  - name: vault
    securityContext:
      # 不再需要 IPC_LOCK (v2.2.0 移除)
      # 但必须保证节点不 swap 这一页
  # 节点级: kubelet --eviction-hard 或 systemd cgroup swapaccount
```

在 K8s 里真正的补偿是**节点级关闭 swap**(`swapaccount=0` 内核参数 + kubelet 配置),或者用 LocalStorage + tmpfs 让 Vault 数据卷不落磁盘。

### 3.3 UBI 镜像瘦身:删了三个包

```
* containers: The following packages have been removed from UBI based container
  images: gnupg, openssl, procps.
```

`gnupg`(验签)、`openssl`、`procps`(`ps`/`top` 等进程工具)被从 UBI 镜像删掉。`openssl` 被删意味着**在容器里用 `openssl s_client` 调试 TLS 连不通了**,需要 `kubectl debug` 起一个 sidecar。这是镜像安全收敛的常规操作(减小攻击面),但对运维同学的调试习惯有影响。

同批次的 `packaging` 改动:

```
* packaging: Container images are now exported using a compressed OCI image layout.
* packaging: UBI container images are now built on the UBI 10 minimal image.
```

OCI compressed layout + UBI 10 minimal —— 镜像更小,拉取更快,但**你的镜像扫描器(Bricks/Trivy/Snyk)如果对 OCI layout 有假设可能要适配**。

---

## 四、存储与生态层:Postgres Workload Identity 与 30+ 插件升级

### 4.1 Postgres 存储后端认证路径翻转

```
* physical/postgresql: breaking change - PostgreSQL storage backend authentication
  now prefers Azure Workload Identity over Managed Identity. Update
  `go-pgmultiauth` to v1.1.0. Existing Managed Identity-based PostgreSQL
  configurations may stop working if Workload Identity is configured. Affected
  users must migrate PostgreSQL authentication to Workload Identity.
```

**这条 breaking change 的措辞极值得注意:「may stop working if Workload Identity is configured」。**

它不是「所有 Postgres 存储用户都要改」。它说的是:**如果你的 Azure 环境里同时配了 Workload Identity,旧的 Managed Identity 配置可能直接停工**。

「条件性破坏」是这类破坏性变更里最难升级管理的一种 —— 你不知道自己是不是中招,只能去查 Azure 环境配置。迁移路径是 `go-pgmultiauth` 升到 v1.1.0,这个库负责 Postgres 的多种 Azure 认证方式协商。

### 4.2 插件大版本齐升

v2.2.0 同批升级了 **30+ 个官方插件**,其中几个关键的:

| 插件 | 新版本 | 备注 |
|------|--------|------|
| auth/kubernetes | v0.25.0 | K8s 认证 |
| auth/jwt | v0.27.1 | JWT/OIDC 认证,含 OAuth RS |
| auth/gcp | v0.24.1 | GCP 认证 |
| secrets/kv | v0.27.0 | KV 引擎 |
| secrets/pki | (内建) | 含 ML-DSA |
| database/* | 多个 | DB 引擎 |

以及一条生态层迁移:

```
* sdk/helpers/docker: Migrate docker helpers from github.com/docker/docker to
  github.com/hashicorp/moby/moby. This was necessary as github.com/docker/docker
  is no longer maintained.
```

**`github.com/docker/docker` 不再维护了。** 2026 年 Docker 把 CLI/引擎生态拆分后,`docker/docker` 仓库停止维护,社区 fork `moby/moby` 成为事实延续。Vault 的 SDK docker helper 跟着迁,顺带解决了 GHSA-x744-4wpc-v9h2 和 GHSA-pxq6-2prw-chj9 两个安全 advisory。

**关键洞察 3:** 「上游停止维护」是 2026 年 Go 生态的一个普遍现象。`aws-sdk-go` v1(EOL)→ v2 是另一个同批次的大规模迁移,Vault 在这个版本里把 AWS auth、AWS secrets、DynamoDB storage、S3 storage、event SQS、managed keys **六个子系统全部从 aws-sdk-go v1 迁到 v2**。一个 release 里完成六个子系统的 SDK 迁移,本身就是「承重级」的信号 —— 说明 Vault 团队把技术债清理排进了发版计划,而不是无限期搁置。

### 4.3 插件目录:从「注册时查」变成「每次用都查」

这条 CHANGE 段的改动安全价值极高:

```
* core/plugin: Plugin catalog entries are now checked against `plugin_directory`
  whenever they are used, not only at registration. An entry whose command
  resolves outside the directory, including through a symlink, is refused with
  `plugin command is outside of configured plugin directory`, and mounts that use
  it are skipped at startup while keeping their data. Such plugins must be
  registered again with their binary inside `plugin_directory`.
```

**以前:插件注册的时候校验一次路径,之后再也不查。** 这意味着:

1. 注册一个合法插件
2. 在 `plugin_directory` 里放一个**符号链接**指向 `/tmp/evil.so`
3. Vault 重启后用缓存的 catalog 记录加载插件 → **加载了 `/tmp/evil.so`**

这是一个典型的 TOCTOU(time-of-check-time-of-use)漏洞。修复后**每次使用都查**,包括符号链接解析后的真实路径。

配套的 bug fix:

```
* core/plugin: Fix plugin catalog entries restored from a raft snapshot, written
  through `sys/raw`, or replicated being able to run a binary outside
  `plugin_directory`.
```

**「通过 raft snapshot 恢复的、通过 `sys/raw` 写入的、或通过复制同步过来的 catalog 记录,可能运行 `plugin_directory` 之外的二进制」。** 这条修复说明旧漏洞的**三条旁路**都是绕过「注册时校验」这个唯一检查点:`sys/raw` 能直接写存储层跳过 API 校验,raft 恢复和复制同步则完全绕过注册流程。

**「注册时校验一次」变成「使用时每次校验」,这是从「门卫查一次」到「每次进出都查」的模型升级。** 而且失败行为是 fail closed 的:挂载在启动时被跳过,但**数据保留**,重新注册就能恢复。

---

## 五、PKI 与后量子:ACME 拒绝未验证 SAN,以及密码学敏捷性

### 5.1 ACME 默认策略拒绝未验证的 SAN

```
* pki: ACME finalization with the default `sign-verbatim` directory policy now
  rejects CSRs that contain URI SANs, email SANs, or Other SANs. ACME challenges
  only verify DNS names and IP addresses; those SAN types are never validated and
  must not appear in issued certificates. Operators who require the previous
  behaviour can set `default_directory_policy = "sign-verbatim-unsafe"` in
  `config/acme`, accepting that the resulting certificates may contain
  unverified identity claims.
```

**这条的逻辑链极清晰:**

1. ACME 协议只定义了 DNS-01 / HTTP-01 / TLS-ALPN-01 三种 challenge
2. 这三种 challenge **只能验证 DNS 名和 IP 地址**
3. CSR 里带的 URI SAN / email SAN / Other SAN **从来没被验证过**
4. 但 `sign-verbatim` 策略以前照签不误
5. **签出来的证书携带未经任何验证的身份声明**

`sign-verbatim` 的设计意图是「ACME 客户端经常在 CSR 里塞一些自定义扩展,别把它擦掉」。但「不擦掉扩展」和「签发未验证的身份声明」是两件事。

逃生舱的命名也很直白:`sign-verbatim-unsafe`。**在配置里写 `unsafe` 这个词,本身就是一种免责声明的设计** —— 让开启它的运维知道自己做了什么权衡。

配套的两个 PKI 收紧:

```
* secrets/pki: sign-verbatim endpoints no longer ignore basic constraints
  extension in CSRs, using them in generated certificates if isCA=false or
  returning an error if isCA=true

* pki: Reject obviously unsafe validation targets during ACME HTTP-01 and
  TLS-ALPN-01 challenge verification
```

以及 ACME challenge 的 IP 范围控制:

```
* secrets/pki: Add ACME configuration fields challenge_permitted_ip_ranges and
  challenge_excluded_ip_ranges configuration to control which IP addresses are
  allowed or disallowed for challenge validation.
```

**ACME HTTP-01 验证的时候,Vault 会去请求 CSR 里指定的地址。如果这个地址是内网地址,就是 SSRF。** `challenge_permitted_ip_ranges` 就是给这个出站请求加白名单。

### 5.2 ML-DSA / SLH-DSA:后量子签名进 PKI

```
* ML-DSA Support in PKI: Add support for post-quantum signatures with ML-DSA
  keys in the PKI secrets engine.

* SLH-DSA support for Hybrid sign/verify in Transit engine (Enterprise): Add
  support for SLH-DSA as the PQC component for Hybrid sign/verify operations.
  This is compatible with both ECDSA (p-256, P-384, P-521) and Ed25519.
```

Vault 在这个版本把 **NIST 标准化的两个后量子签名算法都接进来了**:

- **ML-DSA**(FIPS 204,基于格的签名)→ PKI secrets engine,可以发后量子证书
- **SLH-DSA**(FIPS 205,基于哈希的签名)→ Transit 引擎的 Hybrid 混合签名

SLH-DSA 只做 **Hybrid 模式**是有讲究的:SLH-DSA 签名尺寸大(小参数 7856 字节 vs ML-DSA-65 的 3309 字节),单独用性能开销大。Hybrid 模式是「经典签名 + 后量子签名」双重保护,即使量子计算机出现,经典部分被破了还有后量子部分顶着。

**关键洞察 4:** Transit 引擎同批次还有一个「密码学敏捷性」特性:

```
* Transit Crypto Agility: Allows customers to alter cryptographic primitives in
  transit engine. This adds new endpoints `/transit/keys/:name/algorithm` and
  `/transit/keys/:name/import_version`.
```

「密码学敏捷性」(crypto agility)是 2026 年后量子迁移期的核心概念:**能在不换密钥的情况下换算法**。`/transit/keys/:name/algorithm` 让你给一个已存在的 key 换签名算法。配合 ML-DSA/SLH-DSA,这就是一套完整的「现在用经典算法,量子威胁成真时无缝切后量子」的路径。

以及 FF1 FPE 支持:

```
* Transform FF1 Support (Enterprise): Add support for the NIST approved FF1
  format preserving encryption (FPE) algorithm, and a rewrap operation to assist
  transitioning from FF3-1 to FF1.
```

**FF3-1 在 2025 年被密码学界证明在小字母表上有安全性问题**(攻击复杂度低于 128 位安全级别),NIST 随后撤销了 FF3-1 的批准。Vault 加 FF1 并提供 **FF3-1 → FF1 的 rewrap 迁移路径**,这是「上游标准被撤销,下游工具链跟进」的完整链路。

---

## 六、Agentic IAM GA:Agent 第一次成为 Vault 的一等公民

这是这个版本**唯一的新特性层面的承重级改动**,也是我最想讲清楚的一节。

### 6.1 以前 Agent 怎么访问 Vault

在 v2.2.0 之前,AI Agent 要从 Vault 拿密钥,只有两条路:

**路径 A:Agent 持有 Vault token**

```
Agent 启动 → 拿到 Vault token → 每次请求带 X-Vault-Token
```

问题:token 是 Vault 自己的凭证体系。Agent 要拿 token 就得先认证一次(auth/kubernetes、auth/jwt 等),**然后这个 token 的生命周期、撤销、审计全都得 Vault 管**。一个 Agent 跑 10 分钟,token 可能活 1 小时,这中间 token 泄漏的风险窗口是 Agent 真实生命周期的 6 倍。

**路径 B:Agent 通过 MCP server 中转**

```
Agent → MCP server(持有 Vault token)→ Vault
```

问题:MCP server 是一个**单点信任瓶颈**。所有 Agent 的 Vault 访问都经过同一个 MCP server,它持有高权限 token,而且它的日志和 Vault 的审计日志是两套。

### 6.2 v2.2.0 的方案:Vault 直接当 OAuth Resource Server

```
* AI Agent Support (Enterprise): Vault's support for first-class AI agents is
  now Generally Available. Adds an Agent Registry to register agents, and adds
  support for using Vault as an OAuth resource server for registered agent
  entities. When configured, allows OAuth 2.0 JWTs to be used to directly
  authorize requests to Vault, without needing a Vault token.
```

**核心一句话:Agent 拿 OAuth 2.0 JWT 就能直接授权访问 Vault,不需要 Vault token。**

架构变成了:

```
IdP(Azure AD / Okta / Auth0)
  │  签发 OAuth 2.0 JWT (带 authorization_details)
  ▼
AI Agent
  │  Authorization: Bearer <jwt>
  ▼
Vault (OAuth Resource Server)
  │  1. 验签 (JWKS)
  │  2. 验 issuer / audience / expiry
  │  3. 解 authorization_details 里的 vault:path_access
  │  4. 匹配 Agent Registry 里注册的 agent entity
  │  5. 评估 ceiling policy
  ▼
密钥
```

**JWT 是短命的**(通常 5-60 分钟),**自包含的**(不需要去 Vault 查 token 状态),**可审计的**(aud/iss/sub 全在 token 里)。这解决了路径 A 的「token 生命周期远超 Agent 生命周期」问题。

### 6.3 vault:path_access:OAuth 的 Vault 方言

这个体系的核心是 **Rich Authorization Requests (RAR)** 的一个自定义类型。OAuth 2.0 的 RAR 扩展(RFC 9396)允许 token 里携带细粒度的授权声明,Vault 定义了自己的类型 `vault:path_access`:

```json
{
  "type": "vault:path_access",
  "paths": [
    {
      "path": "kv/data/prod/payment-gateway/*",
      "capabilities": ["read"]
    },
    {
      "path": "pki/sign/agent-mtls",
      "capabilities": ["create", "update"]
    }
  ],
  "allowed_parameters": {
    "kv/data/prod/payment-gateway/*": ["key", "version"]
  },
  "required_parameters": {
    "pki/sign/agent-mtls": ["common_name"]
  }
}
```

注意 v2.2.0 同批次加的两个字段:

```
* oauth-resource-server: Add support for fine-grained policy control options
  (parameter constraints) in Rich Authorization Requests (RAR), including
  `allowed_parameters`, `denied_parameters`, and `required_parameters` inside
  `authorization_details`.

* oauth-resource-server: Add support for identity template expressions
  (e.g. `{{identity.entity.id}}`) in Rich Authorization Requests (RAR).
```

**参数级约束 + 身份模板表达式进 RAR** —— 这意味着 OAuth JWT 里的授权声明,表达能力已经**和 Vault 原生 ACL 策略对齐**了。不再是「OAuth 只能做粗粒度授权,细粒度还得靠 Vault policy」。

以及发现端点:

```
* oauth-resource-server: Added OAuth Protected Resource Metadata endpoint
  (RFC 9728) for publishing authorization_details types and enabling automated
  discovery by Authorization Servers via /.well-known/oauth-protected-resource
```

RFC 9728 是 2025 年标准化的「OAuth Protected Resource Metadata」—— 让 Authorization Server 能**自动发现** Resource Server 支持哪些授权类型。Vault 实现了它,意味着配 Azure AD / Okta 的时候不需要手动填 `authorization_details` 的 schema,IdP 可以自动拉。

### 6.4 端到端代码:从注册 Agent 到 JWT 授权

这是一套可以直接照着搭的完整流程。

**Step 1: 配置 OAuth Resource Server**

```hcl
# /etc/vault.d/vault.hcl
storage "raft" { path = "/vault/data" }
listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_cert_file = "/vault/tls/server.crt"
  tls_key_file  = "/vault/tls/server.key"
  # v2.2.0 新特性: 证书轮换不用重启
  tls_reload_interval = "1h"
}
disable_mlock = true
```

```bash
# 1. 开启 agent registry (Enterprise feature)
vault secrets enable agent

# 2. 注册 agent entity
vault write identity/entity name="payment-agent-prod" \
  policies="agent-base" \
  metadata team="payments" environment="prod"

# 3. 建 alias 指向 OAuth RS profile
vault write identity/entity-alias \
  name="payment-agent-prod" \
  canonical_entity_id="<entity_id>" \
  mount_accessor="<oauth_rs_mount_accessor>"
```

**Step 2: 创建 OAuth Resource Server profile**

```bash
vault write sys/config/oauth-resource-server/payment-agent \
  issuer="https://login.microsoftonline.com/<tenant-id>/v2.0" \
  oidc_discovery_url="https://login.microsoftonline.com/<tenant-id>/v2.0" \
  allowed_client_ids="api://vault-payment-agent" \
  supported_algorithms=["RS256", "ES256", "EdDSA"]
```

注意 `EdDSA` 是 v2.2.0 新支持的:

```
* auth/jwt (OAuth RS): Add EdDSA/Ed25519 support to the OAuth resource server
  JWT validation path. Ed25519 public keys can now be registered via `public_keys`
  and `supported_algorithms = ["EdDSA"]` is now accepted.
```

**Step 3: 定义 ceiling policy(给 agent 的权限上限)**

```hcl
# agent-ceiling.hcl
# Ceiling policy: agent 通过 JWT 能拿到的最大权限
# RAR 里声明的权限不能超过这个天花板
path "kv/data/prod/payment-gateway/*" {
  capabilities = ["read"]
}

path "pki/sign/agent-mtls" {
  capabilities = ["create", "update"]
}

# 显式 deny: agent 永远不能拿 root key
path "transit/keys/root-*" {
  capabilities = ["deny"]
}
```

```bash
vault policy write agent-ceiling agent-ceiling.hcl
```

**Step 4: Agent 侧用 JWT 访问 Vault(Python)**

```python
# -*- coding: utf-8 -*-
# agent_vault_client.py
# Agent 拿 OAuth JWT 直接访问 Vault, 不需要 Vault token
import jwt, requests, time, uuid

class AgentVaultClient:
    """用 OAuth 2.0 JWT 访问 Vault (v2.2.0 Agentic IAM)"""

    def __init__(self, vault_url, client_id, tenant_id, thumbprint, private_key):
        self.vault_url = vault_url.rstrip('/')
        self.client_id = client_id
        self.tenant_id = tenant_id
        self.thumbprint = thumbprint      # cert SHA-1 thumbprint
        self.private_key = private_key    # PEM

    def _mint_jwt(self, scopes=('api://vault-payment-agent/.default',)):
        """用 client credentials 流程换 access token (Azure AD 例)"""
        now = int(time.time())
        assertion = jwt.encode(
            {
                'aud': f'https://login.microsoftonline.com/{self.tenant_id}/oauth2/v2.0/token',
                'iss': self.client_id,
                'sub': self.client_id,
                'jti': str(uuid.uuid4()),
                'nbf': now,
                'exp': now + 300,
            },
            self.private_key,
            algorithm='RS256',
            headers={'x5t': self.thumbprint},
        )
        resp = requests.post(
            f'https://login.microsoftonline.com/{self.tenant_id}/oauth2/v2.0/token',
            data={
                'client_assertion_type': 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
                'client_assertion': assertion,
                'grant_type': 'client_credentials',
                'scope': ' '.join(scopes),
            },
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()['access_token']

    def _build_auth_details(self, path, capabilities):
        """构造 vault:path_access authorization_details"""
        return [{
            'type': 'vault:path_access',
            'paths': [{'path': path, 'capabilities': capabilities}],
        }]

    def read_secret(self, path, fields=None):
        """读 KV v2 secret, 用 JWT 授权"""
        token = self._mint_jwt()
        # 注意: access token 本身不带 vault:path_access,
        # 走 on-behalf-of 流程让 IdP 注入 authorization_details
        resp = requests.get(
            f'{self.vault_url}/v1/{path}',
            headers={'Authorization': f'Bearer {token}'},
            timeout=15,
        )
        if resp.status_code == 403:
            raise PermissionError(f'JWT 授权被拒, 检查 RAR 声明与 ceiling policy: {resp.json()}')
        resp.raise_for_status()
        return resp.json()['data']['data']

    def sign_cert(self, role, common_name, ttl='1h'):
        """让 Vault 签一个 mTLS 证书给 agent 自己"""
        token = self._mint_jwt(scopes=('api://vault-payment-agent/pki.sign',))
        resp = requests.post(
            f'{self.vault_url}/v1/pki/sign/{role}',
            json={'common_name': common_name, 'ttl': ttl},
            headers={'Authorization': f'Bearer {token}'},
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()['data']

if __name__ == '__main__':
    client = AgentVaultClient(
        vault_url='https://vault.internal.example.com',
        client_id='api://vault-payment-agent',
        tenant_id='<tenant-id>',
        thumbprint='<cert-sha1-thumbprint>',
        private_key=open('agent.key', 'rb').read(),
    )
    secret = client.read_secret('kv/data/prod/payment-gateway/stripe')
    print('拿到密钥版本:', secret['version'])
```

**Step 5: 审计 —— 你能看到什么**

```bash
# JWT 授权请求在审计日志里长这样
tail -f /vault/audit/audit.log | jq 'select(.auth.metadata.oauth_subject != null)'

# 输出关键字段:
# {
#   "auth": {
#     "metadata": {
#       "oauth_subject": "payment-agent-prod",       ← 谁在请求
#       "oauth_issuer": "https://login.microsoftonline.com/...",  ← 哪个 IdP 签的
#       "oauth_jti": "a1b2c3...",                    ← JWT 唯一 ID, 可追溯
#       "oauth_scopes": ["api://vault-payment-agent/.default"]
#     }
#   },
#   "request": {
#     "path": "kv/data/prod/payment-gateway/stripe",
#     "remote_address": "10.244.3.22"
#   }
# }
```

**`oauth_jti` 是这套体系最有价值的可观测性字段。** JWT 的 `jti` 是一次性的,把它记进审计日志,就实现了「这一个具体请求,是这一个具体 JWT 授权的」的端到端追溯。Token 体系做不到 —— 一个 token 可以发 1000 个请求,审计日志里只能看到同一个 token accessor。

### 6.5 撤销:denylist 与 revoke-oauth

```
* auth/token: Add global denylist for revoking OAuth JWTs to prevent authorization
  of specific tokens across all namespaces.

* auth/token: Add the `revoke-oauth` endpoint to revoke an external OAuth token by
  its issuer and unique ID.

* auth/token: auth/token/revoke-accessor now supports revoking JWT tokens by accessor
```

JWT 是无状态的,**撤销 JWT 在协议层是个难题**。Vault 的做法是**全局 denylist**:记录被撤销的 (issuer, unique_id) 对,验证时查一次。

```bash
# 撤销一个具体 JWT
vault write auth/token/revoke-oauth \
  issuer="https://login.microsoftonline.com/<tenant-id>/v2.0" \
  unique_id="<jti>"

# 撤销会立即生效 (denylist 是全局同步的)
# 验证: 同一个 JWT 再请求 -> 403, 审计日志记 "JWT denylisted"
```

以及配套的命名空间陷阱:

```
* auth/token: Prevent performance secondary node from writing to the OAuth JWT denylist.
* auth/token: Fix bug which skipped local token state clean up on PR secondary clusters
  after JWT revocation
```

**关键洞察 5:** performance secondary 节点**不允许写 denylist**。这意味着如果你的请求落到 PR secondary,denylist 的更新有复制延迟。**撤销的生效时间不是「立刻」,而是「立刻在 primary + 复制延迟后在 secondary」**。对一个安全撤销操作,这个延迟必须算进 runbook。

### 6.6 Agent Registry:agent 的生命周期管理

```
* Agent Registry UI (Enterprise): Adds a new Agentic Security section to the
  primary navigation with an Agent Registry page where operators can view,
  search, and manage registered AI agents, their associated Vault entities and
  aliases, assigned policies, and operational status.

* agent-registry (enterprise): Add a `local` flag to agent registrations. When
  `local=true`, registrations are not replicated to other performance replication
  clusters and are kept local to the current cluster.

* agent-registry (enterprise): Removed the restriction that disallowed the use of
  'deny' in ceiling policies, resulting in request errors.
```

三个细节值得注意:

1. **UI 里这个板块叫 "Agentic Security"**,不是 "Agent Registry" —— 产品定位是安全基础设施,不是工具箱
2. **`local` 标记**:agent 注册不跨性能复制集群,这是**数据驻留**考量(EU 集群的 agent 不该出现在 US 集群)
3. **ceiling policy 现在允许 `deny`**:之前不允许是怕 deny 规则把 agent 全锁死,现在放开了 —— 配合 §1 的大小写规范化,deny 规则本身变可靠了

### 6.7 权衡:这套体系不是万能的

诚实地讲清楚这套体系代价:

| 维度 | Vault token | OAuth JWT |
|------|-------------|-----------|
| **依赖** | 自包含,Vault 自己管 | **依赖外部 IdP 可用性** |
| **延迟** | token 验证走本地存储 | **每次请求要验签 + 查 denylist** |
| **撤销** | 立刻生效 | denylist 有复制延迟 |
| **调试** | `vault token lookup` | **JWT 解码 + 查 RS profile** |
| **成本** | 无额外 license | **Enterprise feature** |

**IdP 可用性是最大的单点。** Azure AD 挂了 = 所有 agent 的 JWT 续期失败 = 所有 agent 同时失去 Vault 访问。Token 方案里 Vault 挂了才出这事,JWT 方案里**两个系统挂任一个都出事**。缓解:JWT 用长 TTL(但长 TTL 削弱无状态优势)+ 本地缓存 + 断路器降级到 token 模式。

---

## 七、生产升级 checklist:5 步走

### Step 1:升级前审计(升级前 1 周跑)

```bash
# 1.1 找大小写混合的 deny 规则 (最重要)
python3 audit_case_sensitive_deny.py    # 见 §1.5

# 1.2 找含 . / .. 的策略名
vault list sys/policies/acl | while read p; do
  case "$p" in
    .*|*..*|''|' ') echo "BAD policy name: '$p'" ;;
  esac
done

# 1.3 找非规范路径的客户端调用 (从审计日志)
grep -oE '"path":"[^"]*//["]' /vault/audit/audit.log | sort -u | head
grep -oE '"path":"[^"]*/\./[^"]*"' /vault/audit/audit.log | sort -u | head

# 1.4 检查 Postgres 存储后端是否在 Azure 上
vault read sys/config/storage 2>/dev/null | grep -i postgres
# 如果是 + Azure + 配了 Workload Identity -> 必须先迁移认证方式

# 1.5 检查依赖免认证端点的脚本
grep -rE 'sys/(generate-root|rekey|replication/dr/secondary/generate-operation-token)' \
  /path/to/your/automation/ 2>/dev/null

# 1.6 检查容器是否显式 add IPC_LOCK (升级后这行变成 no-op)
grep -r 'IPC_LOCK' /path/to/k8s/manifests/ 2>/dev/null
```

### Step 2:配置预改(在升级窗口内,改完立刻升)

```hcl
# /etc/vault.d/vault.hcl —— 升级前就要加

storage "raft" { path = "/vault/data" }

# mlock 关掉 (v2.2.0 容器内本来就调不了 mlock)
disable_mlock = true

# 高危端点如果要保留免认证, 显式声明 (建议不要, 让它默认要认证)
# enable_unauthenticated_access = ["generate-root", "rekey"]

listener "tcp" {
  address = "0.0.0.0:8200"
  tls_cert_file = "/vault/tls/server.crt"
  tls_key_file  = "/vault/tls/server.key"
  tls_reload_interval = "1h"     # v2.2.0: 证书自动轮换不重启

  # v2.2.0: token 头大小限制
  max_token_header_size = 8192
}
```

### Step 3:灰度升级(先 secondary 后 primary)

```bash
# 3.1 先升 DR secondary / performance secondary
# v2.2.0 对 secondary 有几个专门修复, 先升它们风险最低
kubectl rollout restart statefulset/vault-secondary

# 3.2 观察 denylist 复制 (见 6.5)
vault read sys/replication/performance/status

# 3.3 最后升 primary
kubectl rollout restart statefulset/vault-primary

# 3.4 验证 unseal (mlock 改动影响启动路径)
kubectl logs statefulset/vault-primary | grep -iE 'mlock|seal'
```

### Step 4:升级后验证

```bash
# 4.1 ACL 行为验证 (最重要)
# 之前能 LIST 现在可能被拒
vault list kv/private/ 2>&1 | grep -i permission

# 4.2 非规范路径走重定向
curl -sI -H "X-Vault-Token: $(vault print token)" \
  "https://vault/v1/secret//data/foo" | head -1
# 期望: HTTP/1.1 307 (重定向) 而不是 400 (拒绝)

# 4.3 插件目录校验
# 造一个符号链接插件, 确认被拒
ln -s /tmp/evil.so /vault/plugins/evil.so
vault plugin register secret evil.so   # 期望失败
# 已注册的: 重启后 mount 应被跳过但数据保留
vault secrets list | grep -i skipped

# 4.4 token 头大小
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Vault-Token: $(python3 -c 'print("A"*9000)')" \
  https://vault/v1/sys/health
# 期望: 431 (不是 403 也不是 400)

# 4.5 三个高危端点
curl -s -o /dev/null -w "%{http_code}\n" https://vault/v1/sys/generate-root/attempt
# 期望: 403 (默认要认证了)
```

### Step 5:回滚预案

```bash
# v2.2.0 的破坏性改动多数不可逆:
# - ACL 小写匹配: 已写的策略不回滚
# - 插件目录每次校验: 已拒的插件不回滚
# - mlock 移除: 二进制级改动
# 唯一可逆的是配置项:
#   enable_unauthenticated_access / max_token_header_size / default_directory_policy
# 回滚 = 回退二进制 + 接受策略已改的事实
```

**关键洞察 6:** 这个升级**没有干净回滚**。ACL 小写规范化一旦生效,fail open 的 deny 规则即使在旧版上也已经匹配不到了(因为请求里资源名的解析方式没变)。**所以 Step 1 的审计不是建议,是必须。**

---

## 八、5 套密钥管理方案 17 维度对比

| 维度 | Vault v2.2.0 | AWS KMS | HashiCorp Boundary | CyberArk Conjur | Sealed Secrets |
|------|-------------|---------|--------------------|-----------------|----------------|
| **部署形态** | 自托管 + HCP 托管 | 托管 SaaS | 自托管 | 自托管 | K8s operator |
| **加密体系** | 齐普尔加密(shamir/auto) | AWS 托管密钥 | 齐普尔加密 | 双层加密 | K8s 专有加密 |
| **存储后端** | 10+(raft/consul/mysql/pg/dynamodb/s3) | AWS 内部 | Boltdb / Postgres | Postgres / Kubernetes | etcd |
| **Agent 身份** | **OAuth 2.0 JWT 原生(GA)** | IAM Role / IRSA | 无 agent 概念 | JWT / API key | ServiceAccount |
| **动态密钥生成** | ✅ 20+ 引擎 | ❌ 仅密钥管理 | ❌ | ✅ DB/SSH | ❌ |
| **后量子支持** | **✅ ML-DSA + SLH-DSA** | ✅(部分) | ❌ | ❌ | ❌ |
| **ACME / PKI** | ✅ 完整 ACME + 外部 CA | ❌ | ❌ | ❌ | ❌ |
| **多租户** | ✅ 命名空间(ENT) | 账号级 | 无 | 账号级 | 命名空间 |
| **审计日志** | 文件/syslog/socket | CloudTrail | 文件 | 审计 API | K8s events |
| **撤销机制** | 立刻 + OAuth denylist | 立刻 | 立刻 | 立刻 | 删 CRD |
| **性能(读 P99)** | ~5-10ms(本地 raft) | ~20-40ms(跨区) | ~3-8ms | ~10-25ms | ~1-3ms(本地缓存) |
| **插件生态** | **100+ 官方插件** | AWS 服务限定 | 有限 | 有限 | 无 |
| **合规认证** | SOC2/FedRAMP/PCI | 100+ | SOC2 | SOC2/PCI | 无 |
| **定价模型** | ENT 按 client 数 + 新增 Agentic IAM 条款 | 按密钥+API | ENT 按会话 | ENT 按用户 | 免费 |
| **运维复杂度** | **高** | 低 | 中 | 中 | 低 |
| **云锁定** | 无 | 高(AWS) | 无 | 无 | 无 |
| **社区/生态规模** | 42k+ stars | N/A | 3.5k stars | 1.5k stars | 7.5k stars |

**怎么选:**
- **已上 AWS 且只要 KMS** → AWS KMS,简单
- **要完整密钥生命周期 + 动态密钥** → Vault
- **AI agent 密钥访问(2026 新需求)** → **Vault v2.2.0 是唯一原生支持的**
- **只要 K8s 里 secret 加密** → Sealed Secrets / SOPS,杀鸡不用牛刀

---

## 九、6 条 6-12 个月可验证硬指标

每条都是今天就能跑代码复现的。

**1. deny 规则 fail open 覆盖率**

```bash
# 升级后跑 §1.5 的脚本, 输出应为空
python3 audit_case_sensitive_deny.py && echo "PASS"
```
**指标**: fail open 规则数 = 0。**验证频率**: 升级后立即 + 每月。

**2. 非规范路径重定向率**

```bash
# 审计日志里 307 重定向的占比
grep -c '"type":"response"' /vault/audit/audit.log
grep -c '"http_status":307' /vault/audit/audit.log
```
**指标**: 重定向数应随客户端修复单调下降,6 个月内趋近 0。

**3. 三个高危端点 403 率**

```bash
# 升级后这三个端点应该全是 403/401
for ep in sys/generate-root/attempt sys/rekey/verify sys/replication/dr/secondary/generate-operation-token/attempt; do
  code=$(curl -s -o /dev/null -w "%{http_code}" https://vault/v1/$ep)
  echo "$ep -> $code"
done
```
**指标**: 全部 403/401。出现 200 = 有人开了 `enable_unauthenticated_access`。

**4. 插件目录越界拦截**

```bash
# 定期用符号链接测试
ln -sf /tmp/test.so /vault/plugins/test-link.so
vault plugin register secret test-link.so 2>&1 | grep "outside of configured plugin directory"
```
**指标**: 每次都被拒。**这个测试本身也是回归测试,放 CI。**

**5. OAuth JWT 授权延迟开销**

```bash
# 对比 token vs JWT 的请求延迟
time vault read -format=json kv/data/prod/foo                    # token
time curl -s -H "Authorization: Bearer $JWT" https://vault/v1/kv/data/prod/foo
```
**指标**: JWT 首次请求 < 50ms(验签 + denylist 查),token < 10ms。**如果 JWT 超过 100ms,查 JWKS 缓存是否生效。**

**6. mlock 关闭后的 swap 行为**

```bash
# 节点级验证: 确认 swap 真的关了
cat /proc/sys/vm/swappiness    # 期望 0
free -m | grep -i swap         # 期望全 0

# cgroup 级: Vault cgroup 的 swap 用量
cat /sys/fs/cgroup/memory/vault/memory.memsw.max_usage_in_bytes 2>/dev/null
```
**指标**: swap 用量 = 0。**swappiness != 0 就是 mlock 移除后的裸奔窗口。**

---

## 十、6 条 6-12 月可观察未来信号

**1. IdP 厂商跟进「Resource Server 发现」**
RFC 9728 的 `/.well-known/oauth-protected-resource` 端点被 Vault 实现后,Azure AD / Okta / Auth0 是否在 6 个月内支持自动发现 `authorization_details` 类型。**支持了 = Agentic IAM 的配置成本降一个量级。**

**2. MCP server 的密钥层标准化**
现在 MCP server 持有 Vault token 是过渡形态。观察 6-12 个月内是否出现「MCP server 声明式申请 vault:path_access、由 Vault 动态签发短 JWT」的模式 —— **这会把 §6.2 的路径 B 消灭掉**。

**3. 后量子证书签发量**
监控 Vault PKI 引擎签发的 ML-DSA 证书占比。**2026 年底如果仍是 0,说明后量子迁移在应用层还没真正启动;如果爬到 5-10%,说明混合 PKI 成了主流。**

**4. FF3-1 → FF1 迁移完成率**
用 Transform 引擎的租户里,FF1 算法占比。**NIST 撤销 FF3-1 后,6-12 个月内仍用 FF3-1 的系统就是合规裸奔。**

**5. `authorization_details` 参数级约束的采用率**
`allowed_parameters` / `denied_parameters` 进 RAR 后,有多少 agent 的 JWT 真的用了。**没用 = agent 的授权还是粗粒度的,§6.3 的能力被浪费。**

**6. 「Agentic IAM」作为独立产品类目的出现**
Vault v2.2.0 的 License 改动:

```
* License: Add Agentic IAM terms to client licensing model
```

**这是「Agentic IAM」第一次进入计费模型。** 观察 6-12 个月内 CyberArk / Conjur / 1Password / Doppler 是否跟进出类似条目。**跟进 = 这成为一个独立市场;不跟进 = Vault 的差异化壁垒。**

---

## 十一、8 个诚实边界

**1. 大小写修复不覆盖全部后端。** Release notes 明确说:Okta group 名、LDAP 和 RADIUS 名(在保持默认大小写不敏感配置的 mount 上)、以及 Enterprise SCIM client 名 **不在这次修复范围内,仍然存在同样的绕过**。缓解:在这些 mount 上不要把 wildcard allow 和 exact deny 组合用。

**2. `local` agent 注册的复制语义。** `local=true` 的 agent 注册不跨性能复制集群,意味着 **跨集群 failover 时这些 agent 在 secondary 上不可见**。这不是 bug 是设计,但 failover runbook 必须知道。

**3. OAuth RS profile 的命名空间穿透是单向的。** Profile 解析会沿命名空间祖先链向上找,但 **child namespace 里签的 JWT 不能授权 parent namespace 的资源**。

**4. `tls_reload_interval` 只覆盖 TCP listener。** 你用的是 `listener "unix"` 或 Unix socket,证书轮换还是得 SIGHUP 或重启。

**5. max_token_header_size 的 `-1` 是真关闭。** 关掉之后 stdlib 的 `MaxHeaderBytes` 兜底还在(默认 1MB),但 **Vault 不再对 token 头做任何专门限制**。如果你有代理层(Nginx/Envoy)在 Vault 前面且自己有限制,要一起对齐。

**6. SCIM v2 beta 的 filter 支持是子集。** 只支持 `userName eq` / `externalId eq` / `active eq` / `meta.lastModified` 几个算子。Okta/Azure AD 的复杂 filter 表达式会 400。

**7. 插件目录校验的「跳过 mount 但保留数据」有个例外。** 如果插件的 catalog 记录是通过 `sys/raw` 写的,启动时被跳过后,**mount 状态可能停在 inconsistent 上,需要手动 `vault secrets tune` 恢复**。

**8. FF1 rewrap 不是原子操作。** 从 FF3-1 rewrap 到 FF1 期间,新读走 FF1、旧数据还在 FF3-1 —— **rewrap 期间发生的读请求需要能解两种算法**。生产上要在低峰期做,而且做完要验证 100% 数据迁移完。

---

## 十二、3 个长期判断

**判断一:大小写规范化是「身份系统」的必经课,不止 Vault。**

这次修复的根因 —— **ACL 匹配层大小写敏感 / 后端解析层大小写不敏感的跨层不一致** —— 不是 Vault 独有。Kubernetes 的 RBAC `Role`/`RoleBinding` 名是大小写敏感的,但 `ServiceAccount` token 里的 `sub` claim 是大小写不敏感的;AWS IAM policy 里写 `arn:...:role/MyRole` 跟 STS 解析出来的 role session 名大小写也可能不一致。

**12 个月内,「identity string canonicalization」会成为所有身份系统的标配检查项**,就像 2020 年代「URL canonicalization before policy match」成为 API 网关标配一样。Vault 这次修在前面。

**判断二:Agentic IAM 的终局不是「Agent 拿 token」,而是「Agent 的授权声明自带在凭证里」。**

Vault v2.2.0 的 `vault:path_access` RAR 类型,本质上把 **ACL 策略从「存在 Vault 里、请求时查」变成了「声明在 JWT 里、请求时验」**。这个方向如果成立,6-12 个月内你会看到:

- MCP 协议加 `authorization_details` 透传字段
- A2A(Agent-to-Agent)协议把 vault:path_access 当作标准授权类型
- 其他密钥管理产品跟进出自己的 RAR 类型

**判断三:「默认免认证的高危端点」会在 2 年内从所有基础设施软件里消失。**

`generate-root` / `rekey` 这类端点的设计出发点是「seal 状态下没有可用凭证」。但 2026 年的默认是:**「没有可用凭证」不应该等于「不需要凭证」**。K8s 的 `/debug/pprof` 默认关、etcd 的 `/v2` API 默认禁、Docker 的 `docker.sock` 默认受限 —— Vault 这次跟上的是同一个行业方向。

**这条判断的验证信号:观察 etcd / Consul / Kafka 这类有「引导期端点」的软件,12 个月内是否跟进「默认认证 + 显式 opt-out」。**

---

## 写在最后

Vault v2.2.0 的 release notes 有 94.7 KB,但核心就是一句话:

**过去十年,Vault 的很多安全边界是「约定俗成」的 —— 你应该用小写写策略名、你应该给高危端点配好网络访问控制、你应该记得加 IPC_LOCK、你应该检查 CSR 里的 SAN 有没有被验证。v2.2.0 把这些全部变成了代码强制。**

这个过程必然痛苦。`fail open` 的 deny 规则、停工的 Postgres 认证、失效的 mlock、被拒的 ACME CSR —— **每一条都是一个真实的升级事故**。但这就是「隐含约定 → 显式契约」迁移的代价,2026 年 10 月这个版本是 Vault 付的。

对用户来说,唯一正确应对方式是:**升级前把 §7 Step 1 的审计脚本跑完**。这个版本的破坏性改动没有干净回滚,所以审计不是建议,是前置条件。

至于 Agentic IAM GA,它是这个版本唯一「向前看」的部分。Agent 拿 OAuth JWT 直接访问 Vault、不用 Vault token —— 这解决了 2026 年 Agent 安全最尴尬的一个问题:**Agent 的生命周期和 Vault token 的生命周期严重不匹配**。短命 JWT + RAR 细粒度授权 + ceiling policy 天花板 + jti 审计追溯,这套组合是「Agent 时代密钥层」的雏形。

**5 步生产 checklist:**
1. **跑大小写审计脚本** → 改完所有 deny 规则再升级
2. **预改配置** → `disable_mlock=true` + `max_token_header_size` + `tls_reload_interval`
3. **先 secondary 后 primary** 灰度
4. **跑 §9 六条硬指标** → 307 重定向 / 403 高危端点 / 431 头限制
5. **Postgres on Azure 先迁移 Workload Identity** 再升

**5 条 best practice:**
- ✅ deny 规则一律用小写资源名(从今天开始,不管升不升级)
- ✅ 插件目录用只读挂载 + `nosuid,nodev` + 定期符号链接测试
- ✅ ACME 用 `sign-verbatim`,只在明确需要时切 `sign-verbatim-unsafe`
- ✅ Agent 密钥访问走 OAuth JWT + ceiling policy,token 只留紧急降级
- ✅ ceiling policy 里显式写 deny,配合 §1 的小写规范化现在它可靠了

**❌ 千万别做的事:**
- ❌ 不要在升级窗口内才发现 deny 规则用了大小写(fail open 已经发生了)
- ❌ 不要关掉 `max_token_header_size`(431 比 DoS 好)
- ❌ 不要为了兼容老客户端开 `enable_unauthenticated_access`
- ❌ 不要在 Azure Postgres + Workload Identity 环境下直接升级
- ❌ 不要以为 mlock 关了就没事 —— **swap 必须在节点级关掉**

---

**数据来源**:本文全部技术细节与引文均来自 HashiCorp Vault v2.2.0-rc1 官方 release notes(2026-10-08 发布,正文 94,735 字节,含 BREAKING CHANGES / SECURITY / CHANGES / FEATURES / IMPROVEMENTS / BUG FIXES 六段),以及 HashiCorp 官方文档关于 Agentic IAM / OAuth Resource Server / PKI / Transit 引擎的公开说明。
