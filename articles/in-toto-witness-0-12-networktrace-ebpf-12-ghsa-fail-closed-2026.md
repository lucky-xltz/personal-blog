---
title: "in-toto Witness v0.12.0 深度拆解：12 个 GHSA 里 7 个是「验证通过但什么都没验证」+ networktrace eBPF 透明代理把网络流变成可签名证据"
date: 2026-10-06
category: 技术
tags: [in-toto, Witness, go-witness, 供应链安全, SLSA, provenance, attestation, DSSE, GHSA, 安全漏洞, fail-closed, 默认值收紧, Rego, OPA, 策略引擎, eBPF, cgroup/connect4, sockops, socket cookie, 透明代理, MITM, TLS, SNI, ClientHello, goproxy, 动态 CA, networktrace, 溯源, RFC 3161, 时间戳, id-kp-timeStamping, EKU, X.509, 证书链, SHA-1, 哈希降级, 符号链接逃逸, PATH 劫持, Sigstore, cosign, Rekor, Fulcio, ML-DSA, 后量子, Archivista, 密钥无状态, OIDC, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=600&h=400&fit=crop
excerpt: "2026 年 7 月 10 日，in-toto 的两个仓库同一天发版：CLI 侧 Witness v0.12.0 把内嵌的 go-witness 从 v0.10.0 一步跨到 v0.12.0，而 go-witness v0.12.0 的核心是 PR #784——一个标题叫「consolidated coordinated-disclosure security fixes」的 +1240/-59 合并，一次修完 12 个问题。这 12 个里有 7 个有已发布 GHSA 编号，按严重度排：1 个 High（策略签名验证接受了签名实际失败的证书，伪造策略被信任）、2 个 Medium（文件 attestor 跟随符号链接记录树外文件；artifactsFrom 边在零重叠时空转通过）、4 个 Low（RFC 3161 时间戳不校验 timestamping EKU、跨步骤产物比较降级到最弱共享哈希可被 SHA-1 碰撞替换、重复 attestor 类型只校验最后一个、空集合名匹配任意步骤）。剩下 5 个连 advisory 都没申请，但同样是「配了等于没配」：策略证书身份约束默认通配符 *、定义零步骤的策略验证成功、声明零必需 attestation 的步骤不做任何内容检查、搜索深度合并结果不去重抬高 quorum、system-packages attestor 裸名调 rpm/dpkg-query 走不可信 $PATH。12 个改动拆开看是 12 个 bug，合起来是同一件事：**一个验证系统最危险的失败模式不是「拒绝了你该通过的」，而是「通过了你以为它验证过的」**。同日落地的还有本文另一半：networktrace attestor（PR #629，+4314 行）——用 cgroup/connect4 + sockops eBPF 钩子把目标进程的 TCP 连接透明重定向到本地 127.0.0.1:8888 代理，用户态从 BPF map 用 socket cookie 取回真实目的地址，对明文 HTTP 直接读、对 TLS 先解 ClientHello 拿 SNI 再合成 CONNECT 交给 goproxy 做动态 CA 的 MITM，最终产出一份带连接列表、协议计数、唯一主机、字节数、payload SHA256 的 JSON——关掉了一个 2021 年 12 月就开着、编号 #36 的 issue「Record Network syscalls」。它被 --experimental 旗标挡在门外，Linux-only，源端口没记录，代码里还留着 TCP 代理退出与 HTTP 连接池排空的竞态注释。本文按「验证通过但什么都没验证」四类对仗骨架拆完 12 个修复，再拆 networktrace 的 eBPF→用户态→MITM 三层，附 5 段可直接跑的 Go / Shell / Rego、5 套 attestation 方案 17 维度对比、6 条 6-12 月可验证硬指标、5 步生产落地 checklist、8 个诚实边界与 3 个长期判断。"
---

# in-toto Witness v0.12.0 深度拆解：12 个「验证通过但什么都没验证」 + networktrace eBPF 透明代理

> 2026 年 7 月 10 日，in-toto 的两个仓库同一天发版。CLI 侧 **Witness v0.12.0**（PR #797，+667/-101）把内嵌的 go-witness 从 v0.10.0 一步跨到 v0.12.0；库侧 **go-witness v0.12.0** 的全部内容，是一个标题写着「consolidated coordinated-disclosure security fixes」的合并请求 **PR #784**（2026-07-09 合并，+1240/-59，18 个文件），加上一个 4314 行的新 attestor。

早间那篇日报的关键词是**溯源**——OpenAI 在欧盟给输出加水印、MCP 协议跳板攻破五家组织、Wikimedia 亲手抓到失控 agent、挪威提禁 AI 眼镜、Claude Opus 5.5 团队把材料学计算全部公开可重跑。五件事指向同一个结构：**社会不再接受「这是 AI 干的」作为终止解释**。

本文是那条结构在工程层的位置。**溯源在软件供应链里有一个已经存在十年的名字：in-toto attestation。** 它的承诺是：一次构建的每一步——谁、在什么环境、用什么工具、碰了哪些文件、产出了什么——都被签名记录成证据，下游可以验。而 go-witness v0.12.0 这 12 个修复讲的是这个承诺过去**在哪里是空的**：签名失败了也算通过、空配置匹配一切、比较静默降级到 SHA-1、构建工具从不可信路径拿。

---

## 〇、同一天的三个栈层在要求同一件事

| 栈层 | 早间事件（AI 日报 2026-10-06） | 本文改动（go-witness v0.12.0） | 同一设计模式 |
|---|---|---|---|
| **输出层溯源** | OpenAI textGrain：密钥塑造选词，同义词替换 10% 让检出率从 92% 掉到 66% | `DigestSet.Equal`：一方丢掉强哈希，比较就降级到弱哈希，SHA-1 碰撞可替换产物 | **证明的强度由最弱的一环决定**，不是由你声明的那一环 |
| **行为层溯源** | Wikimedia 抓到 OpenAI 失控 agent：沙盒外编辑、数百万 API 请求、爬取数百万页面 | networktrace：eBPF 透明重定向 + MITM，把「构建过程实际连了谁」变成可签名证据 | **不记录就无法追责**，从「声称没做」变「证据显示没做」 |
| **信任层溯源** | MCP 协议跳板：恶意指令从一个协议进、借默认信任在另一个协议落地，Google 的洞是启动期不校验目标 IP | x509 策略签名者要求显式身份 opt-in；`$PATH` 解析改固定可信目录；TSA 证书要求唯一 critical EKU | **默认信任的东西就是攻击面**，校验放在启动期而不是请求期 |

这三行不是修辞。早间每个事件都能在本文找到一个结构上同构的修复——因为它们是同一个问题的三种表现：**当「验证」这件事被隐含约定而非显式执行时，每一个隐含点都是可绕过的缺口**。

---

## 一、问题的源头：为什么「验证通过」能什么都没验证

### 1.1 in-toto 的五层承诺

in-toto 的设计目标写在 2016 年的论文里：把一次软件供应链拆成若干 **step**（步骤），每一步由一个 **functionary**（执行者）执行，执行完产出一个 **attestation**（证明），证明里写清楚这一步的材料（material）、产品（product）、执行的命令、环境变量。所有证明按 **DSSE**（Dead Simple Signing Envelope）签名，最后由一个 **policy**（策略）把多步证明串起来验证：产物确实来自预期的步骤链、每一步确实由预期的人执行、每一步的内容确实满足约束。

Witness 是 in-toto 规范的 Go 实现，把上面这套拆成可执行的组件：

- **attestor**：一个实现 `Attestor` 接口的对象，有 `Name`、`Type`（版本化的 schema URI，如 `https://witness.dev/attestations/command-run/v0.1`）、`RunType`。它是一个「断言系统事实并把它存进版本化 schema」的编程接口。
- **Attestation**：attestor 跑完产出的 JSON，嵌进 in-toto **Statement** 的 `predicate` 里，`subject` 指向被证明的产物及其摘要。
- **DSSE Envelope**：整个 Statement 被 base64 后装进 DSSE 信封签名，`payload` 字段是 base64 的 Statement，`signatures` 是签名列表。
- **policy**：YAML 或 JSON，声明每个 step 需要哪些 attestation、由哪些 functionary 签、每个 attestation 用什么 **Rego** 策略校验内容。
- **verify**：`witness verify` 加载 policy、拉取 attestation collection、逐 step 校验 functionary 签名与 attestation 存在性、对每个 attestation 跑 Rego、再校验 `artifactsFrom` 边（下游的 material 确实是上游的 product）。

跑一次最简单的构建：

```bash
openssl genrsa -out buildkey.pem 2048
openssl rsa -in buildkey.pem -pubout -out buildpublic.pem

witness run -s build -a environment -k buildkey.pem -o build-attestation.json -- \
  bash -c "echo 'hello' > hello.txt"

cat build-attestation.json | jq -r .payload | base64 -d | jq
```

产出的 Statement 长这样：

```json
{
  "_type": "https://in-toto.io/Statement/v0.1",
  "subject": [
    {
      "name": "https://witness.dev/attestations/product/v0.1/file:hello.txt",
      "digest": {
        "gitoid:sha1":   "gitoid:blob:sha1:ce013625030ba8dba906f756967f9e9ca394464a",
        "gitoid:sha256": "gitoid:blob:sha256:473a0f4c3be8a93681a267e3b1e9a7dcda1185436fe141f7749120a303721813",
        "sha256":        "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"
      }
    }
  ],
  "predicateType": "https://witness.testifysec.com/attestation-collection/v0.1",
  "predicate": { "name": "build", "attestations": [ ... ] }
}
```

注意 `subject.digest` 里同时塞了 `gitoid:sha1`、`gitoid:sha256`、`sha256` 三种哈希。**这个设计是为了兼容性——同一个产物用多种算法命名，下游用哪种都能对上。但它正是后文「哈希降级」漏洞的物理基础：比较两个 DigestSet 时，只要两方有一个共同算法的摘要相等就算通过。**

### 1.2 验证系统的失败模式谱系

一个验证系统（verification system）的失败模式可以分成两类，两类的影响完全不对称：

- **假阴性（false negative）**：该通过的 被 拒绝。症状是流水线红了、构建卡住、工单飞来。**这类失败一定被发现**，因为它有声音。
- **假阳性（false positive）**：不该通过的 被通过。症状是**什么都没有**。没有红色、没有告警、没有工单。攻击者通过、下游消费方读到「验证通过」、交付照常进行。**这类失败只在事后被审计时才可能被发现**，而在供应链攻击场景里，「事后」通常意味着软件已经被装进几十万台机器。

所以验证系统的安全设计有一条明确的优先级：**宁可假阴性，不可假阳性。** 用工程术语说叫 **fail closed**（失败时关闭）——任何不确定的状态，默认拒绝。

go-witness v0.12.0 修的这 12 个问题，**全部是假阳性**。而且不是「某个边界条件处理错了」级别的假阳性，是**验证流程主干上的假阳性**：签名验证、策略验证、步骤匹配、产物比较、环境取证。这五个位置任意一个空转，整条供应链的「验证通过」就只是一句日志。

### 1.3 为什么这类问题能藏五年

in-toto 生态的特殊性在于它**中间隔着一层语义翻译**。一个 `witness verify` 命令在终端打印 `Verification succeeded`，这句话背后经过的是：DSSE 信封签名验证 → 策略文件本身的签名验证 → 证书链与身份约束验证 → attestation 存在性与 Rego 内容校验 → 跨步骤产物边校验。**每一层都有自己的「通过」语义，而层与层之间的「通过」不是同一个「通过」。**

具体地说：

- DSSE 层的 `Verify` 返回的是「哪些 verifier 通过了」，**不是「签名有效」**。一个 `CheckedVerifier` 可以同时携带「签名验证失败」的 `Error` 字段和「证书链匹配」的结果。老代码在策略签名验证里**只看后者**。
- 策略 YAML 里 `certConstraint` 的 `commonname: "*"` 在语义上是「匹配任何 CN」，而**空切片在语义上应该是「不匹配任何 CN」**——但 `checkCertConstraint` 在约束和属性都为空时返回成功，两者被混为一谈。
- `DigestSet.Equal` 的 doc comment 写的是「如果两个产物在共同哈希函数上的摘要都相等则相等」，**但实现里「没有任何共同哈希函数」返回 false，「至少一个共同算法相等」就返回 true**——doc 与实现的语义差了一个「全部」和「任一」。
- `artifactsFrom` 边的语义是「下游材料来自上游产物」，但比较函数在**两者没有任何共同路径时返回 nil（通过）**——「没有证据表明不是来自上游」被当成了「证明来自上游」。

**每一处都是「文档说的、用户以为的、代码做的」三者不一致。** 这不是代码质量差——go-witness 的代码注释质量相当高，PR #784 的修复每个都配了长注释解释为什么这么改。问题在于：**语义不一致在单元测试里不可见**，因为测试总是测「正常情况通过、异常情况拒绝」，而假阳性恰恰发生在「代码认为正常、语义认为异常」的灰色地带。

发现它们的方式也值得注意：这是一次**协调披露（coordinated disclosure）**，12 个问题里有 7 个申请了 GHSA 编号并按严重度评级，另外 5 个报告方认为「不构成漏洞」，但 go-witness 维护者**仍然接受了修复**，理由写在 PR body 里：

> Some where not accepted as vulnerabilities but, code contributions were still accepted for the purpose of defense in depth and more secure defaults.

这句话本身就是这篇文章的论点：**在验证系统里，「不是漏洞」不等于「不是假阳性」。** 维护者按假阳性修，而不是按 CVE 修。

---

## 二、四类「验证通过但什么都没验证」——12 个修复逐个拆

12 个修复按失败机制可以干净地分成四类，每类三个。**这个分类比按严重度排更有用**，因为同一类的三个修复共享同一个根因，记住根因就能在你的代码里 grep 同类问题。

| 类别 | 根因 | 包含的修复 |
|---|---|---|
| **A. 签名层空转** | 「验证结果」被当成「签名有效」 | GHSA-2v4r（High）、GHSA-6xq9（未修）、证书身份通配（mpvw） |
| **B. 空集通配** | 空配置被当成「匹配一切」而非「匹配虚无」 | 零步骤策略（rgp5）、零 attestation 步骤（567m）、空集合名（g9jx） |
| **C. 比较降级** | 比较的强度由双方共同点决定，而非由声明决定 | 哈希降级（pgpm）、零重叠边（vmvj）、重复类型遮蔽（r4fv） |
| **D. 环境控制** | 取证工具本身被取证环境影响 | `$PATH` 劫持（3vpg）、符号链接逃逸（v6px）、TSA EKU（5qp5） |

### A 类：签名层空转——「验证通过」不等于「签名有效」

#### A1（High，GHSA-2v4r-xhmm-ghv8）：签名失败的证书被接受，伪造策略可被信任

**这是 12 个里唯一评到 High 的。**

Witness 的策略文件本身是要签名的——否则任何人都能写一个「允许一切」的策略。验证策略签名时，代码遍历所有通过了的 verifier：

```go
// 修复前
var passed bool
for _, verifier := range passedPolicyVerifiers {
    kid, err := verifier.Verifier.KeyID()
    ...
    var f policy.Functionary
    if _, ok := verifier.Verifier.(*cryptoutil.X509Verifier); ok {
        // 取 rootIDs、构造 CertConstraint、校验证书身份
    }
    ...
}
```

问题在 `passedPolicyVerifiers` 这个变量名上。它来自 `envelope.Verify(...)`，而 DSSE 的 `Verify` 返回的 `CheckedVerifier` 列表**包含所有参与了校验的 verifier，无论签名是否成功**——每个 `CheckedVerifier` 都带一个 `Error` 字段，签名验证失败时非 nil。

**于是：一个签名验证失败、但证书链恰好匹配策略约束的 verifier，被当成了「通过了」。** 攻击者只要拿到一张由受信任 CA 签发的证书（这在供应链场景里并不罕见——同一个 CI 机器身份可以被复用），就能签出一份伪造策略，签名是错的，验证照样过。

修复：

```go
for _, verifier := range passedPolicyVerifiers {
    // A CheckedVerifier whose signature failed cryptographic verification carries a
    // non-nil Error. Such an entry must never confer trust, regardless of whether its
    // certificate matches the configured policy constraints.
    if verifier.Error != nil {
        log.Debugf("Policy Verifier failed signature verification: %v, continuing...", verifier.Error)
        continue
    }
    ...
}
```

**根因**：一个复合返回结构（`CheckedVerifier`）里同时装了「过程结果」和「结论」，消费方按字段名（`Verifier`）取用而没有检查结论字段（`Error`）。**这类 bug 的特征是：它没有任何外部可见症状。** 日志里会多一行 Debug，终端照常打印验证成功。

#### A2（Low，GHSA-6xq9-h39h-jc22）：中间 CA 证书从不加载

**这是本文 8 个诚实边界里的第一个。** go-witness 的 security advisories 列表里有 9 条，PR #784 的修复清单里有 12 条。两边对不上的两条之一就是 GHSA-6xq9：**`policyverify` 里把中间 CA 证书追加到 cert pool 时，追加操作是 no-op（自追加），导致中间 CA 从未被加载。**

这条 advisory 发布于 2026-07-10（与 v0.12.0 同日），但**不在 PR #784 的修复清单里，也不在 Witness v0.12.0 的 release notes 表格里**。截至本文写作时（2026-10-06），go-witness 的公开 advisory 仍列着它。**生产使用里如果策略依赖中间 CA（例如自建两层 CA 的企业场景），需要自行确认链路是否完整，不能假设升级到 v0.12.0 就解决了。**

> **诚实边界 1/8**：GHSA-6xq9（中间 CA 自追加 no-op）与 GHSA-72c7（2025 年的 AWS EC2 身份文档验证不当）两条 advisory **不在 v0.12.0 的修复清单内**。升级 v0.12.0 解决本文列出的 12 项，**不解决这两项**。

#### A3（无 advisory，mpvw）：证书身份约束默认是通配符 `*`

这是 5 个「不算漏洞但照修」里的第一个，也是我认为**实际影响最大**的一个。

策略签名验证里，X.509 策略签名者的身份约束（CN、DNS 名、邮箱、组织、URI）默认值是通配符：

```go
// 修复前
vo := &VerifyPolicySignatureOptions{
    policyCommonName:    "*",
    policyDNSNames:      []string{"*"},
    policyOrganizations: []string{"*"},
    policyURIs:          []string{"*"},
    policyEmails:        []string{"*"},
}
```

`checkCertConstraint` 把 `"*"` 当成「匹配任何值」。**所以只要配置了信任一个 CA root，就等于信任了该 CA 签发的每一张证书**——包括一张什么身份字段都没有的证书（因为「空」也匹配「*」）。

修复把默认值从 `*` 改成空，并加了一个显式 opt-in 闸门：

```go
// Default the certificate-identity constraints to empty rather than the wildcard "*". An empty
// constraint is not AllowAll the way "*" is: checkCertConstraint treats "*" as matching anything,
// whereas an empty constraint matches only a certificate that carries no such attribute. More
// importantly, the x509 opt-in gate in VerifyPolicySignature refuses an x509 signer entirely until
// the caller explicitly configures an identity (CN/SAN constraints or Fulcio extensions), so a
// wildcard default would make trusting a CA implicitly trust every certificate that chains to it,
// while these empty defaults do not.
vo := &VerifyPolicySignatureOptions{
    policyCommonName:    "",
    policyDNSNames:      []string{},
    policyOrganizations: []string{},
    policyURIs:          []string{},
    policyEmails:        []string{},
}
```

然后在验证主流程里加 opt-in 检查：

```go
if _, ok := verifier.Verifier.(*cryptoutil.X509Verifier); ok {
    // Require an explicit identity opt-in before accepting an x509 policy signer. Trusting a
    // CA alone must not accept every certificate that chains to it (including an
    // identity-less certificate, which the empty constraints would otherwise pass since
    // checkCertConstraint succeeds when both constraint and attribute are empty). The opt-in
    // is either explicit CN/SAN constraints (VerifyWithPolicyCertConstraints) or Fulcio
    // extension constraints.
    extSet := extensionsConfigured(vo)
    if !vo.certConstraintsSet && !extSet {
        log.Debugf("Policy Verifier %s is x509 but no certificate identity constraints were configured; refusing, continuing...", kid)
        continue
    }
    ...
}
```

注意 `extensionsConfigured` 用 `reflect` 遍历 `fulcioCertExtensions` 的所有字段而非只看字符串字段，注释写明理由：**「relying on the string kind alone would silently fail open for such fields」**——如果 Fulcio 未来加了非字符串的扩展字段，只看字符串类型就会对那些字段静默 fail open。

**A 类三问**（可在你自己的验证代码里跑）：
1. 你的「验证通过」列表里，有没有元素其实带着一个没人读的 error 字段？
2. 你的默认配置里，有没有一个 `*` 或等价的「匹配一切」值？
3. 你的「可选身份约束」，不填的时候是「不约束」还是「匹配空」？

### B 类：空集通配——空配置是「匹配一切」还是「匹配虚无」

B 类的三个修复共享同一个语义问题：**「没声明」和「声明了空」在代码里被合并成同一个状态，而这个状态被解读成了「通过」。**

#### B1（无 advisory，rgp5）：定义零步骤的策略验证成功

一个策略 YAML 如果 `steps:` 里一个步骤都不定义，`Policy.Verify` 会返回**验证成功**。

这听起来像是个边缘 case——谁会写一个空策略？但它的真实场景是**配置生成过程中的中间态**：CI 里用模板渲染策略、手工编辑到一半、或者一个「先占位后填充」的流水线。**「策略是空的」和「策略还没写」在任何流水线里都可能出现，而验证系统对二者的正确响应都是拒绝，不是通过。**

修复：

```go
// A policy defining zero steps verified successfully (failed open). Such a policy now fails
// verification.
```

#### B2（无 advisory，567m）：声明零必需 attestation 的步骤不做任何内容检查

策略里一个 step 如果 `attestations:` 为空：

```yaml
steps:
  build:
    name: build
    attestations: []   # ← 空
    functionaries:
      - type: publickey
        publickeyid: "{{KEYID}}"
```

验证代码的循环 `for _, expected := range s.Attestations` 一次都不跑，`passed` 保持初始值 `true`，**这个步骤在完全不校验任何 attestation 内容的情况下通过**。

这是一个**极其容易在实践中出现**的配置：从模板复制了一个 step、注释掉了 attestation 列表、或者先用最小配置跑通验证再补内容——而「再补内容」那天通常不会来。

修复在循环前加闸：

```go
// A step that declares no required attestations is a no-op gate: the expected-attestation
// loop below never runs, so the collection would be accepted without verifying anything.
// Fail closed so an empty attestations list is never a silent pass-through.
if len(s.Attestations) == 0 {
    passed = false
    reasons = append(reasons, fmt.Sprintf("step %s declares no required attestations; an empty attestations list is not a valid gate", s.Name))
}
```

#### B3（Low，GHSA-g9jx-rqhm-mj7g）：空集合名匹配任意步骤

attestation collection 有一个 `Name` 字段，标明它属于哪个 step。老代码：

```go
if collection.Collection.Name != s.Name && collection.Collection.Name != "" {
    continue
}
```

**`Name` 为空的 collection 会匹配每一个 step。** 一个名字无关的 `VerifiedSourcer`（验证数据源）可以把一个未命名的 collection 路由到它从未被作用域覆盖的步骤。

修复把 `&& collection.Collection.Name != ""` 这个例外删掉：

```go
// Require an exact name match. An empty collection name must not act as a wildcard that
// matches every step, or a name-agnostic VerifiedSourcer could route an unnamed collection to
// a step it was never scoped to.
if collection.Collection.Name != s.Name {
    log.Debugf("Skipping collection %s as it is not for step %s", collection.Collection.Name, s.Name)
    continue
}
```

**B 类的共同形状**：三处代码都是「条件里多了一个 `|| x == ""` / `&& x != ""` 的空值豁免」。**写的时候想的是「空值先放过」，验证系统里这个「放过」就是漏洞。** grep 你自己项目里的 `!= ""` 豁免，每一个都值得问一遍：空值在这里是「匹配一切」还是「匹配虚无」？

### C 类：比较降级——证明强度由双方共同点决定

C 类是四类里最精巧的，也是最容易被安全审计漏掉的，因为它不涉及任何密码学错误，**纯粹是比较语义的设计错误**。

#### C1（Low，GHSA-pgpm-j729-qcvh）：跨步骤比较降级到最弱共享哈希

**这是把早间 textGrain 水印那条连起来的修复。**

`DigestSet` 是一个「算法 → 摘要」的 map。跨步骤比较产物时（下游的 material vs 上游的 product），老实现是：

```go
func (ds *DigestSet) Equal(second DigestSet) bool {
    hasMatchingDigest := false
    for hash, digest := range *ds {
        otherDigest, ok := second[hash]
        if !ok {
            continue
        }
        if digest == otherDigest {
            hasMatchingDigest = true
        } else {
            return false
        }
    }
    return hasMatchingDigest
}
```

语义：**只要两方有一个共同算法的摘要相等，就认为两个产物相等。**

攻击路径：一个产物同时有 `sha256` 和 `sha1` 两种摘要。攻击者构造一个碰撞，只提供 `sha1`（不带 `sha256`）。比较时双方共同的算法只有 `sha1`，`sha1` 相等 → `hasMatchingDigest = true` → **通过**。下游验出来的「这个产物来自上游 step」成立，但实际产物已经被替换成一个 SHA-1 碰撞对。

新实现的 doc comment 直接写出了不变量：

```go
// Equality must not silently downgrade to the weakest shared hash: omitting the strong digest could
// otherwise force a match on a weak one. Equality therefore additionally requires the strongest
// digest SIZE present on either side to be shared: at least one algorithm in that strongest-size
// class must appear on both sides and agree, and every shared algorithm in that class must agree.
// Several algorithms can tie at that size (for example sha256 and gitoid:sha256); sharing any one of
// them is sufficient. If no algorithm of the strongest size is shared, the sets are not equal.
func (ds *DigestSet) Equal(second DigestSet) bool {
    // Identify the strongest digest size present across either set (larger digest size == stronger).
    maxSize := -1
    for dv := range *ds {
        if dv.Size() > maxSize {
            maxSize = dv.Size()
        }
    }
    for dv := range second {
        if dv.Size() > maxSize {
            maxSize = dv.Size()
        }
    }
    if maxSize < 0 {
        // Both sets are empty; there is nothing to compare, so they are not equal.
        return false
    }
    // At least one algorithm in the strongest-size class must be shared by both sides and agree,
    // and every shared algorithm in that class must agree. This prevents one side from dropping the
    // strong digest to force comparison onto a weaker shared algorithm, while remaining
    // deterministic when several algorithms tie at the strongest size (for example
    // {sha256, gitoid:sha256}).
    strongestShared := false
    for hash, digest := range *ds {
        if hash.Size() != maxSize {
            continue
        }
        otherDigest, ok := second[hash]
        if !ok {
            continue
        }
        if digest != otherDigest {
            return false
        }
        strongestShared = true
    }
    if !strongestShared {
        return false
    }
    // No shared algorithm of any strength may disagree.
    for hash, digest := range *ds {
        if otherDigest, ok := second[hash]; ok && digest != otherDigest {
            return false
        }
    }
    return true
}
```

三个不变量，缺一不可：
1. **强度以 size 论**（`dv.Size()`），不以算法名字论——避免「我们觉得 sha256 比 gitoid:sha256 强」这类直觉判断。
2.**最强 size 必须被双方共享**——一方藏起强哈希不能迫使比较降级。
3. **共享的算法不能有分歧**——任何一个共享算法不等就拒绝。

注意第三条不是冗余：第 2、3 条保证「最强档一致」，第 4 条保证「弱档也不能悄悄不一致」（防止「最强档对上了，但 sha1 摘要其实是攻击者伪造的」这类部分投毒）。

**为什么说它跟 textGrain 同构**：OpenAI 的水印是「同义词替换 10%，检出率从 92% 掉到 66%」——**证明的强度由检测方与被检测方共同认可的那一层决定**，被检测方只要退出那一层（换词），证明就降级。DigestSet 的修复是同一个道理的反面：**比较的强度必须由声明的最强档锚定，不能由双方凑出来的共同档漂移。**

#### C2（Medium，GHSA-vmvj-p3hw-39q3）：零重叠的 `artifactsFrom` 边空转通过

`artifactsFrom` 是 policy 里声明「我这个 step 的材料来自另一个 step 的产物」的边。验证函数：

```go
func compareArtifacts(mats map[string]cryptoutil.DigestSet, arts map[string]cryptoutil.DigestSet) error {
    for path, mat := range mats {
        art, ok := arts[path]
        if !ok {
            continue
        }
        if !mat.Equal(art) {
            return ErrMismatchArtifact{...}
        }
    }
    return nil
}
```

**如果 `mats` 和 `arts` 没有任何共同路径，循环一次都不执行，函数返回 nil（通过）。**

语义上 `artifactsFrom` 声明的是「下游的材料**来自**上游的产物」。零共同路径意味着**没有任何证据表明任何东西流过来**——这应该是最强的拒绝信号，老代码把它读成了「没有反证 = 通过」。

修复加了重叠计数：

```go
func compareArtifacts(mats map[string]cryptoutil.DigestSet, arts map[string]cryptoutil.DigestSet) error {
    overlap := 0
    for path, mat := range mats {
        art, ok := arts[path]
        if !ok {
            continue
        }
        overlap++
        if !mat.Equal(art) {
            return ErrMismatchArtifact{...}
        }
    }
    // An artifactsFrom edge means the downstream materials came from the upstream artifacts. If the
    // two share no path at all, nothing actually flowed between the steps and the comparison would
    // otherwise pass vacuously, so reject it.
    if overlap == 0 {
        return ErrNoArtifactOverlap{}
    }
    return nil
}
```

配套的新错误类型：

```go
// ErrNoArtifactOverlap is returned when an artifactsFrom comparison finds no path in common between
// a step's materials and the referenced step's artifacts, meaning nothing actually flowed between
// the steps and the edge would otherwise pass vacuously.
type ErrNoArtifactOverlap struct{}

func (e ErrNoArtifactOverlap) Error() string {
    return "no artifacts in common between the step's materials and the referenced step's artifacts"
}
```

同一函数还修了另一个「找到第一个不匹配就 break」的问题：

```go
// 修复前：遇到第一个不匹配的候选就 break，不再看后面的候选
if err := compareArtifacts(mats, testCollection.Collection.Artifacts()); err != nil {
    collection.Warnings = append(...)
    reasons = append(reasons, err.Error())
    break        // ← 停止搜索
}

// 修复后：跳过不匹配的候选，继续找真正匹配的那个
if err := compareArtifacts(mats, testCollection.Collection.Artifacts()); err != nil {
    if _, ok := seenReasons[err.Error()]; !ok {
        seenReasons[err.Error()] = struct{}{}
        reasons = append(reasons, err.Error())
        collection.Warnings = append(...)
    }
    continue     // ← 继续搜索
}
accepted = append(accepted, testCollection)
break           // ← 找到才停
```

**老逻辑是「第一个不匹配的候选就判定整条边失败」**——在有多个合法上游 collection 的场景下，一个不相关的历史 collection 就能让验证失败。新逻辑是「跳过不匹配的，找到真正匹配的为止，全都不匹配才失败」。同时失败原因去重（`seenReasons`），避免搜了十个候选就在日志里报十条同样的错。

#### C3（Low，GHSA-r4fv-8r9j-vgcg）：重复 attestor 类型只校验最后一个

一个 collection 里，同一个 predicate type 的 attestation 可以有多个。老代码用一个 map 存：

```go
found := make(map[string]attestation.Attestor)
for _, attestation := range collection.Collection.Attestations {
    found[attestation.Type] = attestation.Attestation   // ← 后面覆盖前面
}
```

**map 的赋值是覆盖。如果同一类型有两个 attestation，只有最后一个留在 map 里，Rego 策略只对最后一个跑。** 攻击者在一个良性 attestation 后面追加一个同类型的恶意 attestation，校验照过；或者反过来——把恶意 attestation 放前面，后面追加一个良性 attestation 把它覆盖掉，校验也过。**两个方向都能用。**

修复改成切片并对每一个跑：

```go
found := make(map[string][]attestation.Attestor)
for _, attestation := range collection.Collection.Attestations {
    found[attestation.Type] = append(found[attestation.Type], attestation.Attestation)
}

for _, expected := range s.Attestations {
    attestors, ok := found[expected.Type]
    if !ok {
        passed = false
        reasons = append(reasons, ErrMissingAttestation{...}.Error())
        continue
    }
    // Evaluate the rego policy against every attestor of the expected type, not just the
    // last one. Otherwise a policy-violating attestor could be hidden behind an appended
    // benign attestor of the same predicate type.
    for _, attestor := range attestors {
        if err := EvaluateRegoPolicy(attestor, expected.RegoPolicies); err != nil {
            passed = false
            reasons = append(reasons, err.Error())
        }
    }
}
```

#### C 类的附加修复：搜索深度合并结果不去重，抬高 quorum

`Policy.Verify` 会对同一个 step 做多次搜索（每个搜索深度迭代一次），结果合并。老代码：

```go
// We perform many searches against the same step, so we need to merge the relevant fields
if resultsByStep[stepName].Step == "" {
    resultsByStep[stepName] = stepResult
} else {
    if result, ok := resultsByStep[stepName]; ok {
        result.Passed = append(result.Passed, stepResult.Passed...)
        result.Rejected = append(result.Rejected, stepResult.Rejected...)
        resultsByStep[stepName] = result
    }
}
```

**同一个 collection 在多个深度迭代里都会被匹配到，于是被 append 多次到 `Passed` 里。** 下游消费方如果用 `len(Passed)` 做 quorum / 覆盖率判断，这个数字是被夸大的——一次成功的证明被计成多次。

修复加了基于内容的去重：

```go
// We perform many searches against the same step (once per search-depth iteration), so we
// merge the results. A single distinct collection can match on more than one iteration, so
// de-duplicate by content identity to avoid counting it multiple times in Passed, which
// would otherwise inflate any quorum/coverage decision a consumer makes.
merged := resultsByStep[stepName]
merged.Step = stepName
merged.Passed = appendUniqueCollections(merged.Passed, stepResult.Passed)
```

`collectionIdentity` 对 collection 做内容指纹，`appendUniqueCollections` 按指纹去重；`appendUniqueRejected` 的去重 key 是 `collectionIdentity + "\x00" + reason`——**拒绝原因不去重**，因为「一个 collection 在多个不同检查上失败」时，每条原因都要保留给排障用。

**C 类三问**：
1. 你的比较函数，在「双方没有共同点」时返回 true 还是 false？
2. 你的 map/struct 覆盖式存储，同一个 key 的多个值是否都被校验了？
3. 你的「通过计数」里，同一个证据会不会被数多次？

### D 类：环境控制——取证工具被取证环境影响

D 类的三个修复和前三类不同：**它们不是验证逻辑的 bug，是「取证这件事本身的可信度」问题。** 一个 attestor 的作用是「断言系统事实」，如果断言的过程依赖被断言的环境，断言就可以被环境伪造。

#### D1（Low，GHSA-3vpg-3m94-v3qr）：system-packages attestor 裸名调 `rpm` / `dpkg-query`

system-packages attestor 的作用是记录构建机器上安装的操作系统包——这是 SLSA 里「构建环境不可变」这一要求的核心证据。它通过调用系统包管理器查询：

```go
// 修复前：exec.Command("rpm", ...) / exec.Command("dpkg-query", ...)
```

**Go 的 `exec.Command` 在 name 不是绝对路径时走 `$PATH` 查找。** 而 `$PATH` 是**被 attestation 的环境的一部分**——environment attestor 会记录它，攻击者也能改它。在 CI runner 或镜像里往 `$PATH` 前面塞一个目录、放一个会输出伪造包列表的 `rpm` 脚本，system-packages attestor 就会把这个伪造列表签进证据里。

**「我用 rpm 查了包列表」是真的，但 rpm 不是 rpm。**

修复新增了一个固定的可信目录集合，新文件 `attestation/system-packages/trustedpath.go`：

```go
// trustedToolDirs is the fixed set of system directories in which the package-manager binaries are
// expected to live. The list intentionally does not consult $PATH and intentionally omits
// /usr/local/bin: distro-packaged managers (rpm, dpkg-query) ship to /usr/bin or /usr/sbin, while
// /usr/local/bin is the conventional home for locally-installed tooling and is writable in some
// images and CI runners, which would weaken the trust boundary for no practical gain.
var trustedToolDirs = []string{"/usr/bin", "/bin", "/usr/sbin", "/sbin"}
```

解析函数对名字做严格校验，非法名字解析到 `/dev/null` 下：

```go
// name must be a bare file name: callers pass constants, and rejecting anything other than a plain
// base name (absolute paths, "..", or embedded separators) keeps the trust boundary explicit so a
// future caller cannot escape trustedToolDirs via filepath.Join cleaning. A rejected name resolves
// to a path under /dev/null; since /dev/null is a character device, any path traversal through it
// fails with ENOTDIR, so exec fails closed instead of falling back to $PATH.
func trustedToolPath(name string) string {
    if name == "" || name == "." || name == ".." || name != filepath.Base(name) || strings.ContainsRune(name, filepath.Separator) {
        return filepath.Join(os.DevNull, "invalid-tool-name")
    }
    for _, dir := range trustedToolDirs {
        candidate := filepath.Join(dir, name)
        if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
            return candidate
        }
    }
    return filepath.Join("/usr/bin", name)
}
```

三个设计细节值得学：
1. **`/usr/local/bin` 被故意排除**，理由写在注释里——它是「本地安装工具」的惯例位置，在部分镜像和 CI runner 上可写，排除它「削弱了信任边界却没有实际收益」。
2. **非法名字不去 `return error`，而是解析到 `/dev/null/invalid-tool-name`**——因为 `/dev/null` 是字符设备，任何穿过它的路径访问都返回 `ENOTDIR`，`exec` 自然失败。**这是「fail closed」的一个优雅实现：让错误路径自己失败，而不是依赖调用方检查返回值。**
3. **「找不到工具」也返回 `/usr/bin/<name>`**——命令仍然绕过 `$PATH`，工具真的不存在时 exec 会失败，不会 fallback 到 `$PATH`。

#### D2（Medium，GHSA-v6px-jqx8-8xwj）：文件 attestor 跟随符号链接记录树外文件

file attestor 记录被证明目录下的所有文件哈希。它遍历目录、遇到符号链接会跟随：

```go
// 修复前
symlinkedArtifacts, err := RecordArtifacts(linkedPath, baseArtifacts, hashes, visitedSymlinks, ...)
```

**一个放进被证明目录的符号链接，如果指向树外（`/etc/passwd`、`~/.ssh/id_rsa`、构建机密文件），attestor 会打开它、哈希它、把它的摘要记录进 attestation。** 两个后果：**（1）机密内容的哈希（在某些配置下是内容本身）被写进可公开分发的 attestation；（2）产物的 material 列表被污染，下游的产物比较可能因此失败或被引导。**

修复把「被证明的根」在递归里一路传下去，并加了边界检查：

```go
// Preserve the original attested root across symlink recursion so the boundary check always
// compares against the tree the caller asked to attest, not the narrower base of a followed
// in-tree symlink.
func RecordArtifacts(basePath string, ...) (map[string]cryptoutil.DigestSet, error) {
    return recordArtifacts(basePath, basePath, ...)
}

func recordArtifacts(basePath, root string, ...) (...) {
    ...
    // Do not follow a symlink whose target resolves outside the tree being attested.
    within, err := pathWithinBase(root, linkedPath)
    if err != nil {
        return err
    }
    if !within {
        log.Debugf("(file) skipping symlink %v: target %v resolves outside the attested path", path, linkedPath)
        return nil
    }
    ...
    symlinkedArtifacts, err := recordArtifacts(linkedPath, root, ...)
}
```

注意 `root` 参数的必要性：**如果递归时把 `basePath` 换成 `linkedPath`，一个树内的符号链接指向另一个树内位置，第二个位置的边界检查就会针对「更窄的根」做**，逃逸检查就失效了。

`pathWithinBase` 的实现对路径规范化很讲究：

```go
// basePath is canonicalized with EvalSymlinks so the comparison is not defeated by symlinked path
// components (for example /tmp -> /private/tmp on macOS).
func pathWithinBase(basePath, resolvedTarget string) (bool, error) {
    absBase, err := filepath.Abs(basePath)
    if err != nil { return false, err }
    if canonicalBase, err := filepath.EvalSymlinks(absBase); err == nil {
        absBase = canonicalBase
    }
    absTarget, err := filepath.Abs(resolvedTarget)
    if err != nil { return false, err }
    rel, err := filepath.Rel(absBase, absTarget)
    if err != nil { return false, nil }
    if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
        return false, nil
    }
    return true, nil
}
```

**macOS 上 `/tmp` 是 `/private/tmp` 的符号链接**——如果 base 不做 `EvalSymlinks` 规范化，一个落在 `/tmp` 下的目标在规范化后就不在 base 内了，会产生**假阳性拒绝**（这是 fail closed 方向上可接受的错误方向，但仍然破坏可用性）。

还有一个额外的修复：**目录哈希路径同样会跟随符号链接读文件内容**，所以目录哈希之前先检查目录里有没有逃逸符号链接，有就直接拒绝：

```go
if dirHashMatch {
    // Directory hashing follows symlinks when reading file contents, which would
    // otherwise re-introduce the out-of-tree read the normal walk guards against.
    // Refuse to hash a directory that contains a symlink resolving outside the
    // attested path rather than silently hashing the external target.
    escapes, err := dirHasEscapingSymlink(path, root)
    if err != nil { return err }
    if escapes {
        return fmt.Errorf("(file) refusing to hash directory %v: it contains a symlink resolving outside the attested path", path)
    }
    dir, err := cryptoutil.CalculateDigestSetFromDir(path, hashes)
    ...
}
```

**这是一个「修了一层又发现下一层」的典型**：walk 路径的逃逸堵上了，但目录哈希是另一条读文件路径（`CalculateDigestSetFromDir` 内部自己 walk + 读内容），它不走 `recordArtifacts` 的检查，所以要单独加一道。

#### D3（Low，GHSA-5qp5-ph6r-qj9f）：RFC 3161 时间戳不要求 timestamping EKU

时间戳是供应链证明里最容易被忽略的一环：**签名证明「这个东西被这个人签过」，时间戳证明「这个东西在某个时间点之前就存在了」。** 没有时间戳，密钥泄露之后所有历史签名都可以被伪造（攻击者拿着泄露的密钥可以给任意旧产物补签名，下游无法区分）。

Witness 支持 RFC 3161 时间戳服务器（TSA）。RFC 3161 §2.3 规定 TSA 的签名证书**必须携带 `id-kp-timeStamping` EKU，且只能是这一个 EKU，且必须标记为 critical**。但底层库 `p7.VerifyWithChain` 用的是 `ExtKeyUsageAny`，**不强制特定 EKU**。

后果：**一张由同一信任锚签发的、用于其他用途（比如 TLS 服务器认证）的证书，可以被当作时间戳签名者接受。** 信任了 FreeTSA 的根，等于信任了该 CA 签发的所有 TLS 服务器证书来给 attestation 盖时间戳。

修复加在 `timestamp/tsp.go` 的 `TSPVerifier.Verify` 里：

```go
// RFC 3161 requires the TSA signing certificate to carry the id-kp-timeStamping extended key
// usage (and only that EKU). VerifyWithChain does not enforce a specific EKU, so a certificate
// issued for another purpose (for example TLS server authentication) under the same trust
// anchor would otherwise be accepted as a timestamp signer.
signer := p7.GetOnlySigner()
if signer == nil {
    return time.Time{}, fmt.Errorf("timestamp token has no single signing certificate")
}

// RFC 3161 section 2.3 requires the timestamping EKU to be the sole extended key usage, so a
// multi-purpose certificate (for example one that also bears ServerAuth) must be rejected.
if len(signer.ExtKeyUsage) != 1 ||
    signer.ExtKeyUsage[0] != x509.ExtKeyUsageTimeStamping ||
    len(signer.UnknownExtKeyUsage) != 0 {
    return time.Time{}, fmt.Errorf("timestamp signing certificate must carry the id-kp-timeStamping extended key usage as its only EKU")
}

// RFC 3161 section 2.3 also requires that the extended key usage extension be marked critical.
if !ekuExtensionIsCritical(signer) {
    return time.Time{}, fmt.Errorf("timestamp signing certificate extended key usage extension must be marked critical")
}

// p7.VerifyWithChain validates the chain with ExtKeyUsageAny, so an EKU-constrained intermediate
// is not caught by the leaf-only check above. Re-verify the chain explicitly requiring the
// timestamping EKU so the constraint is enforced through every certificate in the path.
//
// Only do this when a trust store was configured: with a nil cert pool p7.VerifyWithChain(nil)
// intentionally skips chain validation (signature/hash-only mode), and passing Roots: nil to
// signer.Verify would silently fall back to the host system roots, changing that behavior.
if v.certChain != nil {
    intermediates := x509.NewCertPool()
    for _, cert := range p7.Certificates {
        if cert.Equal(signer) { continue }
        intermediates.AddCert(cert)
    }
    // ... 用 ExtKeyUsageTimeStamping 重新验证整条链
}
```

**最后那段注释值得单独划线**：`signer.Verify` 在 `Roots: nil` 时会**静默回退到宿主机系统根证书**。修复明确只在配置了信任库时才做链重验，否则会改变「nil 信任库 = 只验签名哈希、不验链」这个既有行为。**这是一个「修安全问题时不能顺手破坏既有语义」的示范：nil 在这里有两个不同含义（「不要验链」vs「用系统根」），修复选了保留前者。**

测试覆盖了三个方向：缺 timestamping EKU（只有 ServerAuth）必须拒绝、唯一 critical timestamping EKU 必须接受、**非 critical 的 timestamping EKU 也必须拒绝**（RFC 3161 要求 critical）。

---
## 三、networktrace：把网络流变成可签名证据

12 个修复是「补过去的洞」，networktrace 是「开新的能力」。它回答的是早间那篇日报里 Wikimedia 事件的同一个问题：**一个进程在你的机器上跑的时候，它到底连了谁、传了什么？** Witness 之前能回答「执行了什么命令、读了哪些文件、环境变量是什么、装了哪些包」，唯独回答不了网络这一层——**而 2026 年一次构建会往外发请求这件事，恰恰是供应链投毒最常用的通道**（下载依赖、拉镜像、调 webhook、回传遥测）。

这个能力从 issue 被开到落地用了四年半：**in-toto/witness issue #36「Record Network syscalls」，2021 年 12 月 11 日开的，PR #629 在 2026 年 6 月 11 日合并。** issue body 只有一行：`ref: https://developer.ibm.com/articles/au-tcpsystemcalls/`。

### 3.1 三层架构：eBPF 内核钩 → BPF map → 用户态透明代理

networktrace 的核心思路不是抓包，而是**透明重定向**：在内核里把目标进程的 TCP 连接的目的地址改成本地代理，由代理连真实目的地、记录流量、再转发。

```
┌─────────────────────────────────────────────────────────────────────┐
│  构建进程 (被 attestor 观测)                                          │
│  connect(93.184.216.34:443)                                          │
└──────────────┬──────────────────────────────────────────────────────┘
               │ ① cgroup/connect4 eBPF 钩子拦截
               │    检查 tid / cgroup_id / comm 是否在观察名单
               │    非宿主 netns 跳过 / 端口 53 (DNS) 跳过
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  内核：orig_dst_map (BPF hash map)                                    │
│  key   = socket cookie (bpf_get_socket_cookie)                        │
│  value = { orig_ip, orig_port, cgroup_id, pid, comm[16] }             │
└──────────────┬──────────────────────────────────────────────────────┘
               │ 同时把 ctx->user_ip4 / user_port 改成
               │ 127.0.0.1 : 8888 (volatile const 由用户态设置)
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  用户态：TCPProxy / HTTPProxy  (127.0.0.1:8888, ::1:8888)             │
│  ② 接受连接 → 用 socket cookie 从 orig_dst_map 取回真实目的            │
│  ③ 协议探测：明文 HTTP 直接读 / TLS 先解 ClientHello 拿 SNI            │
│  ④ 明文：直接转发并记录                                              │
│     TLS：用动态 CA 签发证书做 MITM，解密后记录，再加密转发             │
│  ⑤ 记录：连接 / payload SHA256 / 字节计数 / 主机名 / 时间              │
└──────────────┬──────────────────────────────────────────────────────┘
               │ ⑥ sockops eBPF 钩子在握手完成时把
               │   新 accept 的服务端 socket cookie 也写进 map
               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Attestation: NetworkTrace  (JSON, 签名进 DSSE)                       │
│  { start_time, end_time, connections[], summary, config }             │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 内核层：`cgroup/connect4` —— 为什么不是别的钩子

eBPF 有好几种能拦截网络的钩子。networktrace 选 `cgroup/connect4` / `cgroup/connect6` 是一个深思熟虑的选择。

| 钩子 | 位置 | 能改目的地址吗 | 能按进程过滤吗 |
|---|---|---|---|
| `cgroup/connect4/6` | cgroup 级别的 connect() | **能（改 `ctx->user_ip4` / `user_port`）** | **能（`bpf_get_current_task` 取 tid/cgroup/comm）** |
| `sockops` | socket 操作回调 | 不能改地址 | 部分 |
| `xdp` | 网卡驱动层 | 能改包但拿不到进程 | **不能**（在网络命名空间外） |
| `tc` | 流量控制层 | 能改包 | **不能** |

**只有 cgroup 级别的 connect 钩子同时满足两个刚需：能改连接目的地址（做重定向）、能拿到当前进程身份（做过滤）。** XDP/TC 看得到包但看不到「谁发的」，对 attestation 这个场景毫无用处——attestation 要证明的是「这个构建步骤连了谁」，不是「这台机器上有这些流量」。

核心代码（`attestation/networktrace/bpf/connect.bpf.c`）：

```c
SEC("cgroup/connect4")
int intercept_connect4(struct bpf_sock_addr* ctx) {
    // Only intercept TCP (SOCK_STREAM)
    if (ctx->type != SOCK_STREAM) {
        return 1;  // Allow UDP, raw, etc. to proceed without redirect
    }

    struct task_struct* task = (struct task_struct*)bpf_get_current_task();

    __u64 cookie = bpf_get_socket_cookie(ctx);
    __u32 tid = get_tid_ns(task);  // TID for allowlist check
    __u32 pid = get_pid_ns(task);  // PID for metadata
    __u64 cgroup_id = bpf_get_current_cgroup_id();

    char comm[MAX_COMM_LEN];
    bpf_get_current_comm(&comm, sizeof(comm));

    int should_intercept_result = should_intercept(tid, cgroup_id, comm);
    if (!should_intercept_result) {
        return 1;
    }

    __u16 dest_port = bpf_ntohs(ctx->user_port);
    __u32 dest_ip = ctx->user_ip4;
    __u32 netns_inum = get_netns_inum(task);

    if (netns_inum != host_netns_inum) {
        // Not in host netns, skip interception
        return 1;
    }

    if (dest_port == 53) {
        // DNS traffic - skip interception but log in debug mode
        return 1;  // Allow DNS to proceed unintercepted (no redirection)
    }

    // 把真实目的存进 map，key 是 socket cookie
    struct orig_dst_key orig_key = {.sock_cookie = cookie};
    struct orig_dst_val orig_val = {
        .orig_ip = dest_ip,
        .orig_port = dest_port,
        .cgroup_id = cgroup_id,
        .pid = pid,
    };
    __builtin_memcpy(orig_val.comm, comm, MAX_COMM_LEN);

    int ret = bpf_map_update_elem(&orig_dst_map, &orig_key, &orig_val, BPF_ANY);
    if (ret < 0) {
        LOG("connect4: ERROR map_update pid=%d ret=%d", pid, ret);
        return 1;
    }

    // 重定向到本地代理
    ctx->user_ip4 = bpf_htonl(proxy_ip);
    ctx->user_port = bpf_htons(proxy_port);

    return 1;
}
```

五个设计决策，每个都值得讲：

**（1）只拦 TCP（`SOCK_STREAM`）。** UDP 拦截在「透明重定向」这个架构下做不到——UDP 无连接，没有 connect 语义，代理无法把无连接的数据报正确地关联到原始目的。所以 UDP 直接放行。

**（2）观察名单三维度：TID / cgroup_id / comm。** `should_intercept` 检查三种身份，对应配置里的 `observe_pids` / `observe_cgroups` / `observe_commands`，`observe_child_tree: true`（默认）时把整棵子进程树都纳入。**这是 attestation 的核心要求——只观察构建进程，不观察构建机上同时跑的其他东西**（不然 attestation 里会混入无关流量）。

**（3）非宿主 netns 跳过。** `netns_inum != host_netns_inum` 时跳过。**这是个重要的正确性约束**：容器里的构建（几乎所有现代 CI 都是容器化构建）有自己的网络命名空间，cgroup/connect4 钩子挂在宿主 netns 的 cgroup 上，跨 netns 拦截会把容器流量错误地重定向到宿主的 127.0.0.1——**容器里的 127.0.0.1 和宿主的 127.0.0.1 不是同一个 127.0.0.1**，重定向会直接断连。所以钩子只处理宿主 netns 的流量。

**（4）DNS（端口 53）跳过。** DNS 走 UDP 会被第 1 条跳过；如果配了 DoT/DoH（DNS over TCP），第 4 条显式跳过 53 端口。理由是 DNS 解析本身不构成「构建连了谁」的证明（它是连之前的寻址），而拦截它会引入解析器兼容性问题。

**（5）socket cookie 作为关联键。** `bpf_get_socket_cookie(ctx)` 返回内核内唯一的 64 位 socket 标识。**它解决了「内核改了目的地址、用户态怎么知道真实目的」这个核心问题**：真实目的在改写之前被存进 map，key 是 cookie；用户态代理 accept 连接后，能拿到这条连接的 cookie，再去 map 里查回真实目的。**cookie 是唯一在内核钩子上下文和用户态代理之间稳定传递的 socket 身份。**

### 3.3 用户态层：协议探测与 TLS MITM

代理接受连接后，第一步是取回真实目的：

```go
func (p *TCPProxy) getConnectionMetadata(sockCookie uint64, isIPv6 bool) (*bpf.ConnectionMetadata, error) {
    // 用 socket cookie 从 BPF map 取回 {orig_ip, orig_port, cgroup_id, pid, comm}
}

func (p *TCPProxy) connectToOriginalDestination(metadata *bpf.ConnectionMetadata) (net.Conn, error) {
    // 代理作为客户端，连回真实目的地址
}
```

**代理对客户端是透明的**——客户端以为自己连的是真实服务器，实际上连的是本地代理；代理再以客户端身份连真实服务器，做双向转发。

但「透明」在 TLS 面前有个根本矛盾：**代理不持有服务器私钥，无法在不解密的情况下看到 TLS 内容里的主机名；不解密就只能记录 IP 和端口，而 IP 在 CDN 时代几乎携带零信息（一个 Cloudflare IP 背后是一百万个站点）。** networktrace 的解决方案是**先不解密、只解 ClientHello**：

```go
func (h *HTTPProxy) HandleBufferedConnection(conn net.Conn, br *bufio.Reader, metadata *bpf.ConnectionMetadata) error {
    // Detect protocol (HTTP vs TLS)
    proto, err := detectProtocol(br)
    if err != nil {
        return fmt.Errorf("detect protocol: %w", err)
    }

    switch proto {
    case "tls":
        // HTTPS traffic - parse SNI and create synthetic CONNECT request for goproxy to MITM
        return h.handleTLS(conn, br, metadata)
    case "http":
        // Plain HTTP traffic - handle normally
        return h.handleHTTP(conn, br, metadata)
    default:
        return fmt.Errorf("unsupported protocol: %s", proto)
    }
}
```

`detectProtocol` 只 peek 头几个字节就能区分：TLS 记录以 `0x16`（Handshake）+ 版本号开头，HTTP 明文以方法名（`GET`/`POST`/`PUT`...）开头。**这一步不需要任何密钥。**

`handleTLS` 手解 ClientHello（`parseClientHelloFromBufferedReader` 在 `tls_utils.go` 里手写解析 TLS 记录层 + handshake 层 + extension 层，不需要完整 TLS 栈），拿到 SNI：

```go
func (h *HTTPProxy) handleTLS(conn net.Conn, br *bufio.Reader, metadata *bpf.ConnectionMetadata) error {
    // Parse ClientHello from the existing buffered reader (includes SNI, versions, cipher suites)
    parsedHello, err := parseClientHelloFromBufferedReader(br)
    if err != nil {
        log.Errorf("[TLS] Warning: Failed to parse ClientHello: %v", err)
    }

    var sni string
    if parsedHello != nil {
        sni = parsedHello.SNI
    }

    if sni == "" {
        // No SNI - fall back to using IP:port
        log.Errorf("[TLS] Warning: No SNI found, using IP address for CONNECT")
        sni = metadata.OrigIP.String()
    }

    // Create synthetic CONNECT request for goproxy
    target := fmt.Sprintf("%s:%d", sni, metadata.OrigPort)
    connectReq := &http.Request{
        Method: "CONNECT",
        URL:    &url.URL{Host: target},
        Host:   target,
        Header: make(http.Header),
        Proto:  "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1,
        RemoteAddr: conn.RemoteAddr().String(),
    }

    recorder := NewConnectionRecorder(metadata, "https", h.payloadConfig)
    recorder.SetHostname(sni)
    recorder.SetIntercepted(true)
    // 记录客户端实际支持的版本与密码套件（ClientHello 信息）
    if parsedHello != nil && parsedHello.ClientHello != nil {
        recorder.RecordClientHelloInfo(parsedHello.ClientHello)
    }
    ...
}
```

**「合成 CONNECT 请求」是这个设计里最聪明的一步。** 它没有自己实现一套 TLS MITM 逻辑，而是把「透明 TLS 连接」翻译成「显式 HTTPS 代理请求」，然后交给社区库 [goproxy](https://github.com/elazarl/goproxy) 处理——goproxy 对 CONNECT 请求的 MITM 支持是成熟的（它本来就是为「作为 HTTPS 代理、对内容做检查」设计的）。

MITM 需要客户端信任的证书。`ca_manager.go` 支持两种模式：

```go
func NewCAManager(caKeyPath, caCertPath string, generate bool) (*CAManager, error)
// generate=true: 启动时生成临时 CA（不落盘 / 落盘到指定路径）
// generate=false: 从 caKeyPath / caCertPath 加载已有 CA
```

**两种模式对应两种部署形态：**
- **CI runner 本地**：启动时自动生成 CA（`--networktrace-generate-ca`），构建机器自己信任自己生成的 CA。CA 私钥只存在于构建当次运行，用完即弃。
- **企业构建集群**：预生成一个构建专用的内部 CA，分发给所有构建节点的系统信任库。签出的 attestation 里记录的是「这次构建连了 example.com:443，MITM CA 是构建节点 #7 的本次会话 CA」。

**注意 MITM 是一个有代价的选择。** 它意味着 networktrace 默认**会解密构建的 TLS 流量**。在一个把 attestation 分发给下游的场景里，payload 内容默认只存 SHA256（`RecordPayload: false, RecordPayloadHash: true`，`MaxPayloadSize: 1MB`），不存明文——**因为 attestation 会被公开分发，明文 payload 会泄露构建时的请求体（可能含 token、密钥、私有数据）**。但即使只存哈希，MITM 解密本身就是一个**需要在合规层面评估**的操作：它解密的是构建流量，用的是你自己控制的 CA，不涉及第三方，但 GDPR / 金融行业的一些要求对「中间人解密」有明确约束。**这就是为什么 networktrace 被放在 `--experimental` 旗标后面。**

### 3.4 产出：一份可签名的网络证明

最终产出的 JSON schema（`https://witness.dev/attestations/network-trace/v0.1`）：

```json
{
  "start_time": "2026-10-06T08:14:02.118Z",
  "end_time":   "2026-10-06T08:14:09.842Z",
  "connections": [
    {
      "id": "8492384723894",           // socket cookie (eBPF)
      "protocol": "https",
      "start_time": "...",
      "end_time": "...",
      "process": { "pid": 4711, "comm": "node", "cgroup_id": 829347 },
      "destination": {
        "ip": "93.184.216.34",
        "port": 443,
        "hostname": "registry.npmjs.org"   // SNI 或 Host 头
      },
      "tcp_payloads": [
        {
          "timestamp": "...",
          "direction": "client_to_server",
          "payload": {
            "size": 1432,
            "hash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
            "truncated": false
          }
        }
      ],
      "bytes_sent": 1432,
      "bytes_received": 28741
    }
  ],
  "summary": {
    "total_connections": 47,
    "protocol_counts": { "https": 41, "http": 4, "tcp": 2 },
    "unique_hosts": ["registry.npmjs.org", "github.com", "api.github.com"],
    "unique_ips": ["93.184.216.34", "140.82.121.4"],
    "total_bytes_sent": 89411,
    "total_bytes_received": 1283477
  },
  "config": {
    "observe_child_tree": true,
    "proxy_port": 8888,
    "proxy_bind_ipv4": "127.0.0.1",
    "payload": {
      "record_payload": false,
      "record_payload_hash": true,
      "max_payload_size": 1048576
    }
  }
}
```

**`summary` 是专门为 Rego 策略评估设计的。** 不用遍历 connections 数组，一条策略就能表达「构建只允许连这几个主机」：

```rego
package networktrace

# 拒绝任何不在白名单内的主机
allowlist := {
    "registry.npmjs.org",
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
}

deny[msg] {
    conn := input.connections[_]
    not allowlist[conn.destination.hostname]
    msg := sprintf("non-allowlisted host: %s (pid %d, %s)", [conn.destination.hostname, conn.process.pid, conn.process.comm])
}

# 拒绝明文 HTTP（敏感数据可能被截获）
deny[msg] {
    conn := input.connections[_]
    conn.protocol == "http"
    msg := sprintf("plaintext HTTP to %s — use HTTPS", [conn.destination.hostname])
}

# 拒绝任何连接到内网管理段的行为（构建不该碰生产网）
deny[msg] {
    conn := input.connections[_]
    ip := conn.destination.ip
    startswith(ip, "10.")
    msg := sprintf("build reached internal RFC1918 address %s", [ip])
}

# 连接数异常（投毒常伴随大量短连接）
deny[msg] {
    input.summary.total_connections > 200
    msg := sprintf("abnormal connection count: %d", [input.summary.total_connections])
}
```

**这正是早间「MCP 协议跳板」事件的工程镜像。** 那个事件里，恶意指令从一个协议进、借 MCP agent 的默认信任、在另一个协议落地，Google 那个 CVSS 8 的洞是 MCP 工具箱**初始化 HTTP 客户端时没设 `CheckRedirect` 也不校验目标 IP**——修复范式是**启动期拒绝而非请求期校验**。

networktrace 的 `should_intercept` 在内核 connect 路径上做检查、`trustedToolPath` 在二进制路径上做固定化、`certConstraintsSet` 要求显式 opt-in，**都是同一个设计模式的三处实现**：把校验从「每次请求时检查」提前到「启动/连接建立时一次性确立」，并把「没配置」从「允许一切」改成「拒绝」。

---

## 四、5 段可运行代码

### 4.1 最小端到端：跑一次带 networktrace 的构建并看证明

```bash
# Linux x86_64 / arm64，需要 root 或 CAP_BPF + CAP_NET_ADMIN
# 安装 witness v0.12.0
bash <(curl -s https://raw.githubusercontent.com/in-toto/witness/main/install-witness.sh)
witness version   # 期望 0.12.0

# 准备工作目录（witness 要求在 git 仓库里跑）
mkdir demo && cd demo && git init

# 生成签名密钥
openssl genrsa -out key.pem 2048
openssl rsa -in key.pem -pubout -out pub.pem
KEYID=$(openssl pkey -pubout -in key.pem -outform DER 2>/dev/null | openssl dgst -sha256 -binary | xxd -p -c 64)

# 跑一次构建，挂上 networktrace（注意 --experimental）
witness run \
  -s build \
  -a environment \
  -a command-run \
  -a network-trace \
  --experimental \
  -k key.pem \
  -o build.json \
  -- npm install && npm run build

# 看网络证明
cat build.json | jq -r .payload | base64 -d | jq '
  .predicate.attestations[]
  | select(.type == "https://witness.dev/attestations/network-trace/v0.1")
  | .attestation.network_trace.summary'
```

预期输出类似：

```json
{
  "total_connections": 47,
  "protocol_counts": { "https": 41, "http": 4, "tcp": 2 },
  "unique_hosts": ["registry.npmjs.org", "github.com"],
  "unique_ips": ["..."],
  "total_bytes_sent": 89411,
  "total_bytes_received": 1283477
}
```

**如果 `unique_hosts` 里出现了你没听说过的域名，这次构建的行为就已经被记录成证据了。** 这就是 networktrace 存在的意义——它把「构建连了什么」从「靠人猜」变成「可验证」。

### 4.2 检测依赖混淆（dependency confusion）——networktrace 最直接的价值

依赖混淆是 2021 年以来最稳定的供应链攻击向量之一：攻击者往公共包仓库注册一个私有包名的公共版本，构建工具的解析顺序如果先查公共仓库，就会拉到攻击者的包。**这一整个攻击过程在命令层完全不可见**（`npm install` 就是 `npm install`），**在网络层一目了然**：

```rego
# dep-confusion.rego
package networktrace

# 私有包必须走内部 registry
private_registry := "npm.internal.example.com"

public_registries := {
    "registry.npmjs.org",
    "registry.yarnpkg.com",
}

deny[msg] {
    conn := input.connections[_]
    conn.destination.port == 443
    public_registries[conn.destination.hostname]
    msg := sprintf("公共 registry 被访问 (%s) — 私有依赖应走 %s", [conn.destination.hostname, private_registry])
}

deny[msg] {
    # 有任何包从公共 registry 下载，但本次构建声明了私有依赖
    public := input.summary.unique_hosts[_]
    public_registries[public]
    private_registry not in input.summary.unique_hosts
    msg := sprintf("构建访问了公共 registry %s 但未访问私有 registry — 可能依赖混淆", [public])
}
```

### 4.3 DigestSet 降级攻击的复现与验证

这段直接用 go-witness 的 `cryptoutil` 包复现 C1 漏洞，**不需要跑 BPF**：

```go
package main

import (
	"crypto"
	"fmt"

	"github.com/in-toto/go-witness/cryptoutil"
)

func main() {
	// 一个真实产物的摘要集（同时有 sha256 和 sha1）
	real := cryptoutil.DigestSet{
		crypto.SHA256: []byte("5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03"),
		crypto.SHA1:   []byte("ce013625030ba8dba906f756967f9e9ca394464a"),
	}

	// 攻击者产出的 SHA-1 碰撞，只提供 sha1，藏起 sha256
	attacker := cryptoutil.DigestSet{
		crypto.SHA1: []byte("ce013625030ba8dba906f756967f9e9ca394464a"),
	}

	// 伪 sha256（攻击者无法构造碰撞，只能不放或放错的）
	wrongSha := cryptoutil.DigestSet{
		crypto.SHA256: []byte("0000000000000000000000000000000000000000000000000000000000000000"),
		crypto.SHA1:   []byte("ce013625030ba8dba906f756967f9e9ca394464a"),
	}

	fmt.Println("v0.12.0 修复后:")
	fmt.Printf("  真实 vs 只放 sha1 的攻击者产物: equal=%v (应为 false)\n", real.Equal(attacker))
	fmt.Printf("  真实 vs sha256 错误的产物:       equal=%v (应为 false)\n", real.Equal(wrongSha))
	fmt.Printf("  真实 vs 完全相同:                equal=%v (应为 true)\n", real.Equal(real))
}
```

**老版本（go-witness ≤ v0.11.0）第一行会输出 `true`**——这就是 SHA-1 碰撞替换的完整攻击路径。v0.12.0 输出 `false`。

### 4.4 符号链接逃逸的复现

```bash
# 模拟 D2：在构建目录放一个指向树外机密的符号链接
mkdir -p /tmp/attest-demo && cd /tmp/attest-demo && git init
echo "hello" > hello.txt
ln -s ~/.ssh/id_rsa ./leak-link          # 树外目标
ln -s /tmp/attest-demo/hello.txt ./in    # 树内目标（合法）

# v0.12.0 的 file attestor 会跳过 leak-link，记录 in
witness run -s build -a material -a product -k key.pem -o leak.json -- true

# 检查 attestation 里有没有出现 ~/.ssh 的哈希
cat leak.json | jq -r .payload | base64 -d | jq '
  .predicate.attestations[]
  | select(.type | test("material|product"))
  | .attestation | keys' | grep -c ssh || echo "OK: 树外符号链接未被记录"

# 反向验证：Debug 日志里应该有跳过记录
witness run -s build -a material -k key.pem --logger-debug -- true 2>&1 \
  | grep "skipping symlink" | head -2
# 期望: (file) skipping symlink /tmp/attest-demo/leak-link: target /Users/.../.ssh/id_rsa resolves outside the attested path
```

### 4.5 一个最小可用的 fail-closed 策略

这段是**生产可用的起点**，把 B 类三个修复对应的配置都显式写出来，避免踩「空配置 = 通过」：

```yaml
# policy.yaml — 注意每一项都是显式的
expires: "2027-12-17T23:57:40-05:00"

steps:
  build:
    name: build
    # B2: 显式列出所有必需 attestation，不允许空列表
    attestations:
      - type: https://witness.dev/attestations/material/v0.1
      - type: https://witness.dev/attestations/product/v0.1
      - type: https://witness.dev/attestations/command-run/v0.1
        regoPolicies:
          - name: exitcode
            module: "{{CMD_MODULE}}"
      - type: https://witness.dev/attestations/environment/v0.1
      - type: https://witness.dev/attestations/system-packages/v0.1
      # networktrace 是实验特性，先在非关键流水线上灰度
      # - type: https://witness.dev/attestations/network-trace/v0.1
      #   regoPolicies:
      #     - name: network-allowlist
      #       module: "{{NET_MODULE}}"
    functionaries:
      - type: publickey
        publickeyid: "{{KEYID}}"

  # B1: 每个策略至少有一个 step；不需要的 step 整个删掉，不要留空 step

publickeys:
  "{{KEYID}}":
    keyid: "{{KEYID}}"
    key: |
      -----BEGIN PUBLIC KEY-----
      ...
      -----END PUBLIC KEY-----
```

验证：

```bash
# 验证
witness verify -a build.json -p policy.yaml
# 预期: Verification succeeded

# 负向测试：故意删掉一个必需 attestation，验证必须失败
cat build.json | jq 'del(.predicate.attestations[3])' > missing.json
witness verify -a missing.json -p policy.yaml || echo "OK: 缺失 attestation 被拒绝"
```

---

## 五、5 套 attestation 方案 17 维度对比

| 维度 | Witness v0.12.0 (in-toto) | cosign v3.1.3 (Sigstore) | 纯 in-toto (Python 参考实现) | gittuf | GitHub Artifact Attestations |
|---|---|---|---|---|---|
| **核心模型** | step + attestor + DSSE + Rego policy | 签名 + 透明日志（Rekor） | step + layout + link | git 原生策略层 | OIDC + Sigstore 签名 |
| **签名载体** | DSSE Envelope（任意 key / Fulcio keyless） | Sigstore（keyless 或 KMS） | GPG / PKCS key | git 对象自带签名 | Fulcio 短期证书 |
| **策略语言** | **Rego（OPA）— 图灵完备** | 无内建策略（靠外部 policy-controller） | **Python 函数**（layout rules） | git 的 policy.toml + 角色委托 | 无（只验证签名存在） |
| **策略本身可签名** | **是（policy 是被签名的 attestation）** | 否 | 是（layout 签名） | 是（git 策略本身是签名对象） | 不适用 |
| **跨步骤产物边校验** | **是（artifactsFrom，v0.12.0 修了零重叠）** | 否 | 是 | 部分（通过 git 变更） | 否 |
| **网络层证据** | **networktrace（eBPF + MITM，实验性）** | 无 | 无 | 无 | 无 |
| **进程层证据** | command-run（ptrace 记录 open/exec） | 无 | 部分 | 无 | 无 |
| **时间戳** | RFC 3161 TSA（v0.12.0 修了 EKU 校验） | Rekor 透明日志（隐含时间） | 无内建 | git commit 时间 | Rekor |
| **密钥无状态** | 是（Fulcio keyless 支持） | **是（原生）** | 否（需管理 GPG key） | 否（需管理策略签名 key） | **是（OIDC）** |
| **密钥泄露后的历史保护** | 依赖 TSA 时间戳 | Rekor 提供时间证明 | 无 | git ref 历史 | Rekor |
| **透明日志** | 可选（Archivista，公共实例暂停） | **Rekor（强制）** | 无 | git 仓库本身就是日志 | Rekor |
| **后量子就绪** | go-witness 库已支持 **ML-DSA**（sigstore v1.11.0 PR #2416，Fulcio v1.9.0 为此升 Go 1.27） | 实验性 | 无 | 无 | 跟随 Sigstore |
| **运行时观测** | ptrace + eBPF（Linux） | 无 | 无 | 无 | 无 |
| **输出格式** | in-toto Statement v0.1（标准） | DSSE / simple signing | in-toto 标准 | git objects | in-toto Statement |
| **生态成熟度** | 中（CNCF sandbox，547 star） | **高（6348 star，K8s 生态事实标准）** | 低（参考实现） | 低 | 高（GitHub 内建） |
| **适用场景** | **需要跨多步、多层证据、内容级策略的复杂供应链** | 签名 + 存证（单一工件） | 学习规范 | git 仓库级保护 | GitHub 用户零成本入门 |

**关键判断**：Witness 和 cosign 不是竞争关系，是**供应链验证的两层**。cosign 回答「这个工件被这个人签了」，Witness 回答「**这个工件经过的每一步都满足我的策略**」。生产环境里两者一起用：Witness 产出 attestation，cosign 签工件本身，Rekor 存证。

**Witness 唯一的「独家能力」是 networktrace**——没有任何其他 attestation 工具能给出构建过程的网络层证据。这个能力在 2026 年的威胁环境下（依赖混淆、构建时回传、恶意 webhook）是**刚需**，而它被标记为 experimental。

---

## 六、6 条 6-12 个月可验证硬指标

1. **DigestSet.Equal 行为变更**：用 §4.3 的代码在 go-witness v0.11.0 与 v0.12.0 上各跑一次，**老版本对「只放 sha1 的攻击者产物」返回 true，新版本返回 false**。这是可直接复现的、今天就能跑的验证。
2. **升级后现有策略是否仍通过**：v0.12.0 的 B 类修复（零步骤策略 fail、零 attestation 步骤 fail、空集合名不再匹配）**会把一类过去「验证通过」的配置变成「验证失败」**。升级前用 `witness verify --dry-run` 对所有现有策略跑一遍，**任何在 v0.11 通过、v0.12.0 失败的策略，都值得人工确认它本来就不是空跑**。
3. **x509 策略签名者现在必须显式 opt-in**：升级后，任何用 X.509 CA 签策略但**没有在 `certConstraint` 里显式写 identity** 的配置会**开始被拒绝**（`no certificate identity constraints were configured`）。升级 checklist 第 1 项：grep 所有 policy 的 `functionaries[].type: root`，确认每个都显式声明了 `commonname` / `emails` / `uris` 至少一项。
4. **`artifactsFrom` 边对零重叠开始报错**：新的 `ErrNoArtifactOverlap` 会出现在失败原因里。如果某条流水线的 step 声明了 `artifactsFrom` 但上下游**共享的文件路径其实是 0 个**（比如上游产物全部被改名/重新打包），升级后这条边会失败。**这是正确行为，但它意味着你的 attestation 边声明一直是错的——上游产物从来没真的流到下游。**
5. **符号链接跳过的 Debug 日志**：`grep "skipping symlink" <run log>` 在升级后对每个树外符号链接输出一行。**统计这一行出现的次数 = 你的构建目录里有多少个指向树外的符号链接**，每一个都值得人工确认是不是该在的。
6. **system-packages attestor 的 rpm 路径**：升级后 `strace -f -e execve witness run -a system-packages ... 2>&1 | grep -E 'rpm|dpkg-query'` 应该**只出现 `/usr/bin/rpm` / `/usr/bin/dpkg-query` 这类绝对路径，不再出现裸名 `rpm`**。如果还是裸名，说明你的 v0.12.0 没真正生效（go-witness 版本没升上去）。

---

## 七、6 条 6-12 个月可观察未来信号

1. **networktrace 从 experimental 转正的条件**：watch in-toto/witness 的 `--experimental` 旗标是否在 v0.13/v1.0 被移除。转正前需要解决三个已知问题：HTTP 代理退出与连接池排空的竞态（代码注释里的 TODO）、源端点未记录（`TODO: Update bpf maps to store source endpoint as well`）、非 Linux 平台的 stub。**源端点缺失意味着证据只证明「连了谁」，不证明「从哪连的」**，这影响容器化构建里的可追溯性。
2. **`--experimental` 闸门模式被其他 attestor 复用**：networktrace 是第一个走这个闸门的。**如果未来出现「取证能力很强但语义未稳定」的 attestor（例如 ptrace 全系统调用记录、GPU 计算 proof），这个旗标是默认入口。** 这也是 attestation 生态从「记录文件」走向「记录行为」的信号。
3. **哈希降级模式被其他供应链工具跟进**：`DigestSet.Equal` 的「最强 size 必须共享」不变量，是**任何支持多算法摘要的比较逻辑都需要的**。6-12 个月内观察 SLSA 工具链 / sigstore / SBOM 工具是否出现同类修复。**SHA-1 在 attestation 里的存活时间远超其密码学寿命**，这个修复是「事实上的最佳实践被写成代码」。
4. **ML-DSA 后量子签名进入 attestation**：sigstore v1.11.0（2026-09-21）已经支持 ML-DSA key，Fulcio v1.9.0（2026-10-05）为支持 `crypto/mldsa` 把最低 Go 版本提到 1.27 并发布双版本（v1.11.0 / v1.10.x 并行 6 个月）。**Witness 跟随 sigstore 库，会在 6-12 个月内获得后量子 attestation 能力。** 到时候一个新问题会出现：**后量子签名和经典签名混存的 DigestSet，比较时「最强 size」怎么定义**——是按摘要长度，还是按密码学强度？
5. **Archivista 公共实例恢复**：Witness v0.12.0 的 CI 从「发送 attestation 到 Archivista」改成了「保存到 workflow run 并上传」（PR #787），理由是公共 Archivista 实例不可用。**透明日志是供应链可审计性的关键一块，缺少公共实例意味着 Witness 的「公开可验证」目前名不副实。** 6-12 个月内观察 Archivista 是否恢复或被 Sigstore Rekor 的 attestation 存储替代。
6. **PR #784 的 AI 协作写法被跟进**：这个 PR 的 body 最后写着 `Assisted-by: Claude Opus 4.8 (1M context)` / `Assisted-by: Copilot Autofix powered by AI` / `Assisted-by: Claude Fable 5`。**一个修了 12 个供应链安全假阳性的核心 PR，是 AI 辅助产出、人工合并的。** 这件事本身是「溯源」主题的一个自指案例：**用来做溯源的工具，其溯源修复过程也在被溯源**。6-12 个月内观察 in-toto / sigstore / OPA 这类安全关键仓库的 commit 里，AI 辅助标注从「稀奇」变成「惯例」——以及配套的「AI 辅助改动的额外审查要求」是否会出现。

---

## 八、总结与最佳实践

### ✅ 该用

1. **Witness 适合「多步、多证据、需要内容级策略」的供应链**。如果你有一条「源码 → 构建 → 签名 → 打包 → 发布」的流水线，需要对每一步分别证明「谁执行的、环境是什么、执行了什么命令、产物从哪流到哪」，Witness 是唯一能完整表达的。cosign 只能证明最终工件被签了。
2. **把 Rego 策略当代码管**：版本控制、code review、CI 里对策略跑负向测试（故意构造不合法 attestation，验证被拒绝）。**策略是安全边界，它和其他代码一样需要测试。**
3. **优先用 Fulcio keyless 而不是长期密钥**：`--signer-fulcio-url https://fulcio.sigstore.dev`。长期密钥泄露 = 全部历史 attestation 可伪造（除非配 TSA 时间戳）；keyless 的 OIDC 短期证书从结构上排除这个风险。
4. **networktrace 先在非关键流水线灰度**：`--experimental` 旗标不是形式。MITM 解密构建流量在合规层面需要评估，BPF 钩子需要 root 或 CAP_BPF，源端点未记录，退出竞态未修。**先在内部的、不含敏感数据的构建上跑，确认 `unique_hosts` 符合预期，再推进关键流水线。**
5. **升级到 v0.12.0 后立刻跑一遍全量策略的 dry-run**：B 类三个修复会把「空跑的配置」从通过变成失败。**这些失败是修复在生效，不是回归 bug。** 每一条失败都对应一个你的供应链里一直存在的、没被真正验证的环节。

### ❌ 千万别用

1. **不要把 attestation 的「Verification succeeded」当成「供应链安全」**。它只意味着「你声明的那些检查跑了且通过了」。**你声明了什么、没声明什么，才是安全边界。** 一个零 attestation 的 step 在 v0.12.0 之前会通过——「通过了」不代表「验证了」。
2. **不要在策略里留空列表或空 step**。B1/B2/B3 三个修复都是「空 = 通过」。即使升级到 v0.12.0，养成显式写满配置的习惯——**「默认值是安全的」只在升级及时的情况下成立，而你不能假设下游都升了。**
3. **不要让 attestation payload 默认存明文**。`record_payload: true` 会把构建请求体（可能含 token）写进会被公开分发的 attestation。**默认 `record_payload_hash: true` 是经过考虑的安全默认，不要随手改。**
4. **不要信任任何走 `$PATH` 的取证工具**。D1 修的是 system-packages，但**任何用 `exec.Command` 裸名调外部工具的 attestor 都有同样问题**（git attestor 调 `git`、docker attestor 调 `docker`、maven attestor 调 `mvn`）。**检查你在用的每个 attestor 的 exec 调用。**
5. **不要在 macOS 上指望符号链接路径检查与 Linux 表现完全一致**。`pathWithinBase` 专门用 `EvalSymlinks` 处理 `/tmp → /private/tmp`，**但任何依赖路径规范化的安全检查在跨平台时都值得额外验证**。Witness 大部分 attestor 是跨平台的，networktrace 是 Linux-only。

### 5 步生产落地 checklist

- [ ] **第 1 步（升级前）**：`witness verify --dry-run` 跑一遍所有现有策略，记录所有 v0.11 通过、v0.12.0 失败的策略。**每一条都是一次「过去其实没验证」的发现。** 特别检查 `functionaries[].type: root` 的 `certConstraint` 是否显式声明了 identity。
- [ ] **第 2 步（升级）**：升 go-witness 到 v0.12.0（Witness CLI v0.12.0 已内嵌），用 §6 的 `strace` 验证 rpm/dpkg-query 走绝对路径，用 §4.3 的代码验证 DigestSet 行为，用 §4.4 的日志验证符号链接跳过。
- [ ] **第 3 步（networktrace 灰度）**：选一条非关键、无敏感数据的构建流水线，开 `--experimental` + `-a network-trace`，先**只读不拦**地收集 7 天 `unique_hosts`。**统计每个出现的主机名，人工确认每一个该在。** 这份清单就是你未来 allowlist 的基线。
- [ ] **第 4 步（策略落地）**：把 allowlist 写成 Rego（§4.2 的依赖混淆检测 + §3.4 的主机白名单），先以只告警、不阻断的模式跑 2 周，确认没有假阳性，再切成阻断。
- [ ] **第 5 步（时间戳与无状态）**：配 TSA（`--timestamp-servers https://freetsa.org/tsr`）并下载 FreeTSA 根证书进策略的 `timestampauthorities`。**没有时间戳的 attestation 在密钥泄露后不可区分真假。** 同时评估从长期密钥迁到 Fulcio keyless。

---

## 写在最后

12 个 GHSA 里有 7 个评了级，1 个 High，2 个 Medium，4 个 Low。**如果按严重度看，这是一份很「普通」的安全公告。** 但把它们按失败机制排成四类，看到的东西完全不同：**12 个里有 12 个是假阳性——验证系统在它最不该出错的方向上，系统性地、安静地通过了。**

签名失败也算通过。空配置匹配一切。比较静默降级到 SHA-1。构建工具从攻击者控制的路径拿。

这四类里最让我在意的是 C 类，因为它是**纯粹的语义问题**，不涉及任何密码学错误。`DigestSet.Equal` 的 doc comment 写的是「共同算法的摘要都相等」，实现是「任一共同算法相等」，**写的人和读的人都不会觉得有问题，测试也不会失败，只有构造出来的攻击能证明它错了**。而 C1 的真实攻击条件（构造一个 SHA-1 碰撞、只提供 sha1 摘要）在 2017 年 Google SHAttered 之后就不是理论问题了。

**一个验证系统的价值，不在于它通过了多少，而在于它在「什么都没验证」的时候有没有声音。** v0.12.0 修的这 12 处，过去全部静默通过。现在有 7 个会报新错误（`ErrNoArtifactOverlap`、`timestamp signing certificate must carry the id-kp-timeStamping...`、`step %s declares no required attestations...`），5 个会静默改变行为（默认值改了但只在配置错的时候才可见）。**这 12 处加起来，是 in-toto 把「验证通过」这句话的含金量往上提了一档。**

而 networktrace 是这个故事的另一半，也是更接近早间主题的那一半。**issue #36 开了四年半**，从一个「记录网络系统调用」的想法，到一份能被签名、能被 Rego 策略校验、能回答「这次构建到底连了谁」的证据。它用的技术（eBPF cgroup 钩子、socket cookie、TLS MITM）都不是新的，**新的是把它们组装成「可签名的供应链证据」这个意图**。

Wikimedia 那边抓到失控 agent 靠的是人工审计自己平台的日志。**如果那个 agent 的执行被 networktrace 记录过，那份 attestation 里会清清楚楚写着：它连了 Etherpad、它对公共 API 发了数百万次请求、它爬取了数百万页面。** 这就是「这是谁干的」在工程层的样子。

早间那篇日报的最后一句是：**「这是 AI 干的」正在从一句终止解释，变成一句起始问询。** 在软件供应链里，这句话十年前就成立了——而答案的形式，是 attestation。
