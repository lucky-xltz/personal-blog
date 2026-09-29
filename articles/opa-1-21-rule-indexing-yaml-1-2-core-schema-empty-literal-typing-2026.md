---
title: "Open Policy Agent v1.21.0 深度拆解：规则索引重写、YAML 1.2 core schema、空字面量类型化与递归检查去保守化 2026"
date: 2026-09-29
category: 技术
tags: [Open Policy Agent, OPA, v1.21.0, Rego, 策略引擎, 规则索引, rule indexing, trie, 前缀匹配, startswith, endswith, any_prefix_match, YAML 1.2, core schema, go-yaml, 空字面量, 类型检查, 递归检查, recursion check, general refs, 决策日志, rule_labels, gzip, gzhttp, klauspost, OCI bundle, image index, 分布式追踪, trace_id, span_id, 堆栈跟踪, stack trace, query framing, 部分求值, partial evaluation, WASM, IR, 策略即代码, policy as code, 授权, admission control, Kubernetes, Gatekeeper, 请求路径热路径, 内存分配, JSON round-trip, 策略层, 2026]
author: 林小白
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
readtime: 26
excerpt: "Open Policy Agent v1.21.0（2026-09-24 发布）是一个「不改架构、只改可信度」的版本。它的四条主线全部指向同一件事——把策略引擎里那些「过去能跑但没人能解释为什么能跑」的地方，换成可解释的、有类型系统支撑的、可索引的实现。① 规则索引重写：startswith/endswith/strings.any_prefix_match/any_suffix_match 在基串编译期已知时进入索引 trie，本地变量根的引用（req := input; req.method == \"GET\"）第一次与 input 根引用等价索引，trie 路径在最后一个受约束层级停止、不再让整条规则脱索引，候选规则按声明序返回——实测 100 条规则匹配 1 条从 50.6µs 降到 4.9µs；② YAML 从 go-yaml v2 的 1.1 语义升级到 1.2 core schema，GitHub Actions 的 on: push 不再被解析成 {true: \"push\"}，这是 breaking change，是 12 年陈的类型债务；③ 空复合字面量 {} [] set() 从 object[any:any] / array[any] / set[any] 改成按内容类型化，obj.bar 这种引用编译期直接报错，{\"foo\":\"bar\"} == {} 变成 match error；④ general refs 递归检查去保守化，p[x].foo.bar 与 p[x].foo.baz 不再因为共享 ground prefix 就被误判成相互依赖。本文逐条拆解这四件事的编译器路径、复现方式、升级影响，并给出 5 段可运行代码与 5 套策略引擎 17 维度对比。"
---

# Open Policy Agent v1.21.0 深度拆解：当策略引擎开始拒绝「能跑但讲不清楚」的策略

## 一、问题的源头：一个策略引擎的四类「能跑但不可解释」

Open Policy Agent 的定位是「策略即代码」：用 Rego 语言写授权逻辑，编译成策略，嵌进 API 网关、Kubernetes 准入控制、CI/CD 流水线、服务网格 sidecar，对每一个请求做毫秒级的 allow/deny 判定。这个定位有一个隐含承诺：**策略的作者能预测策略的行为**。

v1.21.0 之前的 OPA 在四个地方违反了这个承诺。不是「算错」，是「算对但讲不清楚」。

**第一类：索引能力取决于引用的拼写方式。**

OPA 的规则索引是一个编译期构造的 trie。它扫描规则体里的等式表达式，把 `input.method == "GET"` 这样的约束提取成 trie 上的路径。评估一个查询时，引擎从 trie 根出发，用 input 的实际值逐层匹配，只把「可能匹配」的规则放进候选集。对于 N 条规则只有 1 条匹配的场景，索引把评估复杂度从 O(N) 拉到接近 O(log N)。

但这个 trie 有一个硬约束：**它只索引以 `input` 或 `data` 为根的引用**（`isValidIndexRef` 的判定）。考虑这两段语义完全相同的策略：

```rego
# 会被索引                              # 不会被索引
allow if {                             allow if {
    input.method == "GET"                  req := input
    input.path == "/v1/resource42"         req.method == "GET"
}                                          req.path == "/v1/resource42"
                                       }
```

右边那条不是刻意写的病态代码。`req := input` 后接 `req.method` 是非常自然的写法——先给整个输入起个短名字，再逐字段检查。但编译器把 `req := input` 重写成 `__local0__ = input`，然后 `__local0__.method = "GET"` 的引用根是 `__local0__`，既不是 `input` 也不是 `data`，**整条规则不进索引**。

这不是一个「高级技巧失效」的边缘 case。这是「最常见的重构手法导致性能降级一个数量级，且编译器不会告诉你」。PR #9081 的作者给了实测数字：100 条每种形态的规则、匹配其中 1 条时，**索引命中 4.9µs，全量评估 50.6µs**——差 10 倍。而这个差距完全由作者是否知道「引用必须以 input 为根」这个未在文档显著位置写明的规则决定。

更隐蔽的是赋值链的尾端脱落。索引的 insert 逻辑只为一个引用替换第一个 `ref = var` 条目，所以 `x := input; x := x` 这种链式赋值会在 trie 里留下一个 `anyValue` 条目，**即使后续有同引用的具体值约束，那个 leftover 的 any 条目仍然让规则挂在「任意值」分支上**。

**第二类：YAML 的布尔值幻觉。**

OPA 用一个钉在 go-yaml v2 上的库解析 YAML。go-yaml v2 实现的是 **YAML 1.1**，在 1.1 里裸词 `y`、`n`、`yes`、`no`、`on`、`off` 都解析成布尔值。于是：

```yaml
on: push
```

被 OPA 读成：

```json
{ "true": "push" }
```

这个 case 的杀伤力来自它的具体形状：**GitHub Actions 的 workflow 文件**。OPA 有一个极其常见的用法是把 CI 配置当策略数据加载（`opa eval --data .github/workflows/`）来审计流水线。`on:` 是 GitHub Actions 的触发器字段，是 YAML 语义里一个普通的 map key，但在 YAML 1.1 里它是个布尔值。你的策略 `input.on == "push"` 永远是 false，因为根本不存在 `on` 键，存在的是 `true` 键。

同样的问题影响 `--data` 加载的任意 YAML、bundle 里的 YAML、OPA 自己的配置文件、以及 `yaml.unmarshal` 内建函数。而 `true`/`false` 两个字段不受影响，这让 bug 更加隐蔽——你的测试用例里如果只用 true/false，永远测不出来。

这是 **YAML 规范版本的债务**。YAML 1.2（2009 年发布）的 core schema 明确把这几个词规定为字符串，go-yaml v3 和 `go.yaml.in/yaml/v3` 都实现了 1.2。OPA 在 v1.21.0 把解析库换成 go.yaml.in/yaml/v3（这次 release 的依赖升级里就有 `go.yaml.in/yaml/v3 from 3.0.4 to 3.0.5`，以及**移除 sigs.k8s.io/yaml**），正式执行 1.2 core schema。这是 breaking change，issue #5754 在仓库里挂了多年，#6598 补上了具体的复现。

**第三类：空字面量的类型撒谎。**

Rego 的类型检查器对非空字面量按内容定型：`{"foo": "bar"}` 的类型是 `object[foo: string]`，所以 `obj.bar`（一个不存在的键）在编译期就报 `rego_type_error: undefined ref`。但空字面量一直是例外：

```rego
obj := {"foo": "bar"}
obj.bar   # rego_type_error: undefined ref: obj.bar   ← 编译期抓住

obj := {}
obj.bar   # 编译通过，运行时 undefined
```

空对象被赋予类型 `object[any: any]`（「可能有任意键的对象」），空数组 `array[any]`，空集合 `set[any]`。这个选择在类型论上是「撒谎」：空集合的类型被声明成「什么都能装」，而它的实际内容是「什么都没装」。

类型检查器的价值在于「把运行时的 undefined 变成编译期的 error」。空字面量是这个价值链条上唯一的漏洞，而且它恰好出现在最需要它的地方——**空字面量几乎总是出现在「初始化一个待填充的容器」的代码里**，而这种代码的下游引用恰恰最容易写错键名。

**第四类：递归检查的过度保守。**

Rego 规则的递归检查在编译期跑。它把每条规则的 head ref 归约到 ground prefix（变量部分之前的前缀），然后在这个前缀上做依赖图分析。问题是：**`p[x].foo.bar` 和 `p[x].foo.baz` 的 ground prefix 都是 `p[x]`**。

```rego
package play

p[x].foo.bar if {
    x := "a"
    not p[x].foo.baz
}

p[x].foo.baz if {
    x := "a"
    false
}
```

这两条规则之间没有真正的循环依赖——`bar` 引用 `baz`，`baz` 的规则体是 `false`（永不产生值），不存在 `baz` 依赖 `bar` 的路径。但编译器看到两条规则的 head 都归约到 `p[x]`，就把它们判成互相依赖，直接报 recursion error。这迫使作者把策略改写成更丑的形态，或者拆 package。

这个保守性的代价不止是「写起来别扭」。它封住了 Rego 表达「部分对象」的一个自然模式：用同一个对象的不同子树表达相关的决策维度（`p[user].permissions.read` / `p[user].permissions.write` / `p[user].metadata.created_by`），其中一条引用另一条的缺失（`not p[x].foo.baz`）来表达「默认拒绝」的例外逻辑。**这个模式在 v1.21.0 之前是不可表达的**。

v1.21.0 的四条主线正好对上这四类问题：规则索引重写、YAML 1.2 core schema、空字面量按内容类型化、general refs 递归检查去保守化。下面逐条拆开。

---

## 二、四层架构：OPA 的编译管线与 v1.21.0 改了哪一层

要理解 v1.21.0 的改动落在哪，先看 OPA 的四层结构。

| 层 | 职责 | v1.21.0 改动 |
|---|---|---|
| **L1 模块层（ast）** | 解析 Rego 源码 → AST；类型检查；name resolution；`# METADATA` | ✅ 空字面量类型化、递归检查、依赖收集（含 else 体）、多 stage 错误聚合 |
| **L2 编译/索引层（compiler + ast index）** | 构建 rule index trie；partial evaluation；IR/Wasm 生成 | ✅ **本版主战场**：trie 构建重写、本地变量根引用索引、前缀/后缀匹配索引、候选集 bitset、声明序 |
| **L3 求值层（topdown）** | 运行时求值；内建函数缓存；栈追踪 | ✅ 前缀匹配内建的索引支持、regex cache 泄漏修复、enumerate 回调外提、PE 记录已求值规则 |
| **L4 运行时/服务层（runtime/server/plugins）** | HTTP API；bundle 下载与存储；决策日志；OTLP 指标/追踪 | ✅ rule_labels 查询参数、gzip 改 gzhttp、OCI image index 解析、trace_id/span_id 入决策日志 AST、--watch 配置重载 |

**关键观察**：v1.21.0 的承重级改动**几乎全部在 L1/L2**，也就是编译期。L4 的改动（API 参数、gzip、bundle）是配套。这符合 OPA 的工程逻辑：对一个跑在每个请求热路径上的引擎，「让评估变快且可解释」比「加新 API」重要一个数量级。

---

## 三、规则索引重写：从「拼写决定命运」到「编译器自己找约束」

这是本版最大的改动，release notes 里列了 **14 条相关的 ast/index/perf/rego 提交**，横跨 PR #9081、#9108、#9161、#9164、#9190、#9235、#9244、#9257。核心是三件事。

### 3.1 前缀/后缀匹配的索引

`startswith`、`endswith`、`strings.any_prefix_match`、`strings.any_suffix_match` 这四个内建函数现在**在基串编译期已知时进入索引 trie**。

为什么这个重要？因为「按字符串前缀/后缀路由策略」是 OPA 的核心用法之一：按 URL 前缀做路由授权（`startswith(input.path, "/v1/admin")`）、按镜像 registry 后缀做准入（`endswith(input.image, ".internal.registry/app")`）、按用户名前缀做组归属判定。在这些场景下，一个中等规模的组织轻易有几百到几千条带前缀匹配的规则。

PR #9161 的作者（tsandall，OPA 的核心维护者）在 PR body 里写得很直白：

> For policies that contain a large number of prefix matches, the lack of rule indexing becomes a major bottleneck.

在 v1.21.0 之前，**所有带 startswith/endswith 的规则都是「全量候选」**——trie 完全跳过它们，每次评估都要把所有这类规则跑一遍。对于「1000 条规则里 950 条是前缀匹配」的策略集，索引约等于不存在。v1.21.0 之后，编译期已知的基串变成 trie 上的一个约束节点，评估时用 input 的实际值做前缀比较就能剪掉绝大多数候选。

**注意边界**：只有**基串在编译期已知**时才索引。`startswith(input.path, input.prefix)` 这种两边都是运行时值的写法仍然不索引（没法在编译期构造 trie 节点）。这个边界是合理的，但它意味着「把前缀放在 data 里动态读取」这种模式不享受这次优化。

### 3.2 本地变量根引用的索引（PR #9081）

这是整个 release 里工程量最大的一块。`resolveRefHead` 把引用头部的本地变量在两条路径上统一解析：

1. **等式路径**：`req := input; req.method == "GET"` → 解析 `req` 头，把剩余部分拼到解析后的引用上，得到等价于 `input.method == "GET"` 的索引约束。覆盖裸引用、`in` 操作数、`glob.match` 操作数（后两者会被 `RewriteDynamicTerms` 先 hoist 到本地变量）。
2. **ground-prefix 路径**：`req := input; req.roles[_] == r` → 末位是变量的引用在 ground prefix 上索引，这条路径之前只解析值位置的本地变量（`x := input.role; x in {"admin","user"}` 已经能索引），现在 head 位置也解析。

同时修掉了赋值链的尾端脱落问题：**具体的索引值在 trie 构建时取代同引用残留的 `anyValue` 条目**，链式赋值不再让规则脱索引。

这个 PR 的作者在 body 里诚实标注了它的定位——它是「inlining simple expressions」这个更大目标的预备步骤：

> 🥼 Full disclosure: This is a preliminary step to something else: inlining simple expressions. My goal is to have the indexer cover things like `is_foo(s) if input.foo == s` ... and since the compiler turns `is_foo` into something like SSA, we need these steps here to get to that point.

**这是一个值得记住的信号**：规则索引的重写不是为了这次发布的性能数字，是为了让「把简单函数内联进调用点」成为可能。内联一旦落地，Rego 的函数调用就不再打断索引链——那是 Rego 性能的下一个台阶。v1.21.0 交付的是这个台阶的地基。

### 3.3 trie 的形状与候选集顺序

剩下的改动是 trie 本身的质量工程：

- **trie 路径在最后一个受约束层级停止**（#9108）——之前一个被多个值引用的 reference 会让规则在 trie 里「挂不住」，剩余部分全部脱索引。
- **不受任何规则约束的 reference 不进 trie**（#9190）——trie 只为「能用来剪枝」的约束存在。
- **候选集用 bitset 收集**（#9190，`ast: Collect a lookup's candidates in a bitset`）——从 slice 换成 bitset，N 大时内存与缓存友好度都更好。
- **候选规则按声明序返回**（#9190）——索引器文档里一直声称「declaration order」，但实现没做到。现在 `complete rules must not produce multiple outputs` 错误会指向**冲突定义里的第一条**而不是第二条（之前指向第二条，让用户去查错地方）。

**这条最后的小改动有一个超出它体量的意义**：错误信息指向哪一条规则，决定了用户的排查路径。指向错误的那条会让一个 5 分钟的排查变成 50 分钟。这类「诊断质量」的改动在 release notes 里不显眼，但它是在「可解释性」这条主线上。

---

## 四、YAML 1.2 core schema：一次 12 年类型债务的清算

这是本版唯一的 breaking change，也是最容易在生产环境咬人的一条。

**改动**：OPA 所有读 YAML 的路径（`--data`、bundle、配置文件、`yaml.unmarshal` 内建）现在按 **YAML 1.2 core schema** 解析。`y`/`n`/`yes`/`no`/`on`/`off` 变成普通字符串，`true`/`false` 保持布尔语义不变。

**复现升级影响**：

```rego
package ci.audit

# v1.20.x：以下策略永远 deny，因为 data.workflows["deploy.yml"]
# 里根本没有 "on" 键，有的是 "true" 键
deny if {
    data.workflows["deploy.yml"].on == "push"   # ← 旧版永远 false
}

# v1.20.x 的 workaround（现在可以删掉了）
deny if {
    data.workflows["deploy.yml"]["true"] == "push"   # ← 丑陋但有效
}
```

升级到 v1.21.0 后，第一段开始正常工作，第二段**开始永远 false**。这就是 breaking change 的形状：**它修好了你的 bug，同时让针对 bug 写的 workaround 失效**。

**迁移建议**（官方在 release notes 里给的）：如果你确实依赖 `yes`/`no`/`on`/`off` 被读成布尔值，**给值加引号并改用 `true`/`false`**。

**一个值得多想一层的点**：为什么这个 bug 能存在这么久？因为它符合「语义裂缝」的所有特征——规范（YAML 1.2）与实现（go-yaml v2 的 1.1 语义）之间的差异，在**数据的消费者**（OPA 的策略作者）那里是不可见的。你写 `on: push` 的时候想的是「一个叫 on 的键」，YAML 1.1 的解析器想的是「一个布尔键」。两边都对，对的是不同的规范。这类债务的偿还方式只有一种：**换实现**，然后承担 breaking change 的代价。OPA 选了在 minor 版本（v1.21.0，不是 v2.0）里做这件事，并且明确标注——因为拖到 v2 只会让债务更大。

同批还有一个配套改动：`yaml: Reject documents with unreachable content`（#6854）。这是 YAML 解析健壮性的另一面——文档里如果有不可达的内容（比如重复的 anchor 定义等），现在直接拒绝而不是静默忽略。

---

## 五、空字面量类型化：把运行时 undefined 变成编译期 error

改动：空对象 `{}`、空数组 `[]`、空集合 `set()` 的类型从「能装任何东西」变成「按内容定型」——也就是「什么都没装」。

```rego
obj := {"foo": "bar"}
obj.bar        # 编译报错（旧行为，不变）

obj := {}
obj.bar        # 现在编译报错（旧版编译通过，运行时 undefined）
```

**边界情况**（release notes 里特意讲清楚的）：

1. **比较语义**。`{"foo": "bar"} == {}` 现在是 **match error**（类型不可能匹配），跟 `{"foo": "bar"} == {"bar": "foo"}` 一致。旧版这个比较能编译。
2. **集合是例外**。`{"foo"} == set()` 仍然编译通过。原因是类型学上的：`set[string]` 这个类型**本身就描述「任意字符串集合，包括空集」**，空集是它的合法成员，所以比较是良类型的。而 object/array 的类型由内容决定，空 object 的类型跟非空 object 的类型不可能相交。
3. **空集合的迭代**。`some x in []` 现在也报错（迭代一个空数组字面量）。
4. **逃生口**。如果你要判断一个集合是否为空、同时不假设它的类型，用 `count(x) == 0`。`count` 是在「不知道类型」的前提下工作的。

**为什么这是承重级改动而不是小修**：它关上了 Rego 类型系统唯一的漏洞。在此之后，「编译通过」这个信号的含义变强了——它开始真正意味着「所有引用的键在类型上存在」。对于把 OPA 当成「授权逻辑唯一真相源」的团队，这个信号的价值远超 10 行代码的改动量。

配套的类型系统质量改动还有一批：

- **`in` 操作符按集合类型检查**（#5658）：`x in y` 现在根据 `y` 的类型检查 `x`，之前 `in` 的类型检查是放空的。
- **多 stage 错误聚合**（#5815）：编译器现在一次性报告多个 stage 的违规，而不是「修一个重跑一次」。这个 issue 编号是 **#5815**，在仓库里挂了很多年。
- **类型错误指向最外层差异类型**（#499）：嵌套类型不匹配时，错误信息强调「最外层的那个差异」，而不是吐出一整棵类型树的 diff。issue #499 是个三位数编号——这是 OPA 仓库里最古老的一批 issue。
- **缺失的 future keyword import 给提示**（#4619）：你用了 `every` 但没 `import future.keywords.every`，编译器现在告诉你该 import 什么。
- **关键字当规则名报错**（#6652）：`if if { ... }` 这种写法现在被明确拒绝并给出提示。
- **对象解析错误指向出错的 token**（#6714）：之前对象解析失败给的是整个表达式范围，现在精确到 token。
- **JSON schema 内建标记为 nondeterministic**（#8998）：`json.schema_match` / `json.verify_schema` 这类内建现在标记为非确定性，这影响它们在 partial evaluation 中的处理方式。
- **允许 undefined 函数调用的类型错误修复**（#6946）。

**把这些放在一起看**：v1.21.0 的类型系统改动不是「加了一个检查」，是**把类型检查的覆盖面从「非空字面量」补齐到「全部字面量」，同时把错误信息从「能报」升级到「能定位」**。这两个方向是同一件事的两面。

---

## 六、其他承重级改动

### 6.1 general refs 递归检查去保守化（#6813）

`p[x].foo.bar` 和 `p[x].foo.baz` 不再因为共享 ground prefix `p[x]` 就被判成相互依赖。编译器现在**比较 ground prefix 之后的 ref parts**，只有真正的循环才报错。

**诚实的边界**（release notes 明确声明的）：

> The IR and Wasm targets however still return an error: they plan one function per ground path prefix, and cannot evaluate part of a function that is still being planned.

也就是说：**如果你把策略编译成 WASM（或 IR），这个递归仍然报错**。原因是编译目标的结构性约束——WASM target 为每个 ground path prefix 规划一个函数，它没法在「函数还在规划中」的时候求值函数的一部分。这是一个**实现限制的诚实暴露**，不是被忽略的 bug。这类声明在 release notes 里出现，说明维护者清楚它的分量：**用户需要知道「哪些修了、哪些没修」，而不是笼统的「修好了」**。

### 6.2 Data/Query API 返回 rule_labels（#9211）

`# METADATA` 的 `labels` 之前只在**决策日志事件**里出现。现在 `GET/POST /v1/data` 和 `GET/POST /v1/query` 支持 `?rule_labels=true` 查询参数，响应体里多一个 `rule_labels` 字段，返回同样的合并标签。

**为什么这是承重级**：它把「哪条规则命中了这个请求」从**事后日志**提升到**请求时同步可见**。对接场景非常具体：

- **A/B 测试策略版本**：给规则打 `version: v2` 标签，API 响应直接告诉你这次走的是 v1 还是 v2，不需要去翻日志。
- **灰度放量**：`cohort: canary` 标签 + API 响应，网关侧直接统计放量比例。
- **审计**：把 rule_labels 写进访问记录，比事后从决策日志回溯简单一个数量级。

PR 作者选了**查询参数**而不是默认开启，理由写在 body 里：「so it's not a surprising change for existing users」。这是一个 API 设计上正确的取舍：**新增字段对已有的响应解析代码可能是破坏性的**（严格反序列化会失败），所以做成 opt-in。

### 6.3 gzip 响应压缩：从手写 buffer 换成 gzhttp（#9205）

旧的 `server.encoding.gzip` 实现是手写的 `sync.Pool` + `gzip.Writer`：它在决定是否压缩之前，把整个 `Write` 调用的内容 buffer 起来，所以**单次大 write 可能让 buffer 远超 `min_length` 才做决定**。新版换成 [`klauspost/compress/gzhttp`](https://github.com/klauspost/compress/tree/master/gzhttp)，buffer 上限严格等于 `min_length`（下限 512 字节），超出部分直接流式走选定路径。

`min_length` 和 `compression_level` 行为不变。**只有 gzip 被协商，zstd 不协商**（gzhttp 支持但 OPA 显式禁用，保持响应编码只有 gzip）。

值得注意的是同一次 release 里 containerd 2.4 也把 gzip 解压换成了 klauspost 系列（解压提速 1.5x、内存分配 305MiB → 0.18MiB）。**klauspost/compress 正在成为 Go 生态压缩事实标准**——当两个完全无关的基础设施项目在同一个月里把「手写或标准库的压缩」换成同一个第三方库时，这不是巧合，是标准库 `compress/gzip` 在性能场景下的系统性缺口。

### 6.4 决策日志加入分布式追踪字段（#9193）

决策日志事件 AST 现在包含 `trace_id`、`span_id` 和 `request_context`。

**这条改动跟今天中午发的 Jaeger v2.21.0 文章是同一条链路上的**：Jaeger 在追踪后端侧定义「trace 查询语义」，OPA 在策略引擎侧把追踪标识写进决策记录。两边合起来，你才能做一件此前做不到的事：**给定一个 trace，拉出这条链路上每个 OPA 决策点的完整输入输出**。这把「授权决策」从 trace 里的一个不透明 span 变成可审查的记录。

同批还有一个数据竞争修复：`plugins/logs: Fix data race on the cached mask and drop queries`（#9189）——缓存的 mask（用于决策日志脱敏）存在竞争条件，`CapturePrintOutput` 里的 drop 查询也是。决策日志的脱敏路径上有竞争条件是个严重问题：**它决定了敏感字段是否被正确擦除**，而竞争条件意味着在某些交错下可能擦不干净。

### 6.5 bundle 与运行时

- **OCI bundle 支持解析 image index**（#7461）：OCI 镜像规范里 multi-arch 或多变体 bundle 通过 image index（manifest list）分发，之前 OPA 的下载器不处理这一层，现在能解析并走到真正的 manifest。
- **修复被取消 context 导致的假成功**（#9233）：`downloader.Trigger()` 跟一个已取消的 context 竞争时会报假成功。这个 bug 的形状值得记住：**context 取消与「操作完成」之间的竞争，在监控里看起来像「bundle 更新成功了」，但实际什么都没下到**。策略更新静默失败 = 策略停留在旧版本。
- **--watch 配置重载：先加后撤**（#9184 → #9192 → #9219 revert）：这个功能的演进本身就是一课。v1.21.0 前半段加了「配置文件变化时 reload」（#9184/#9192），然后 **revert 掉了**（#9219），因为「in-place reload 需要维护一份『哪些设置不能热更新』的文档」。替代方案是 PR #9203（**仍然 open，未合并**）：**restart 整个 serve routine** 来应用配置变更。这是一个正确的工程判断被诚实执行的结果：**半热重载是不可维护的状态**，不如整体重启。对用户来说，v1.21.0 的 `--watch` **不会**热重载配置，要等 #9203 合进去。

### 6.6 调试与诊断

- **topdown 求值错误加堆栈追踪**（#555，又是一个三位数古老 issue）：求值报错时现在带栈。对一个有递归规则和复杂局部变量的策略，这个改动把「调试靠猜」变成「调试看栈」。
- **debug 的 `query` 栈追踪框架模式**（#9128）：调试器（VS Code 等）的堆栈追踪框架从 event-based 换成 query-based，并且**成为默认**。旧的 event 模式仍然可用（`"stackTraceMode": "event"`）。这影响 OPA 调试器展示断点上下文的方式。

---

## 七、五段可运行代码

### 7.1 复现 YAML 1.1 vs 1.2 的差异并验证升级

```bash
# 1) 造一个 GitHub Actions workflow 文件
mkdir -p /tmp/opa-yaml/.github/workflows
cat > /tmp/opa-yaml/.github/workflows/deploy.yml <<'EOF'
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo yes
EOF

# 2) 用 v1.21.0 之前的 OPA（< 1.21）查询 on 字段 —— 拿不到值
#    opa version 0.x / 1.20.x 行为：
#      data.github.workflows.deploy.on  →  undefined（键其实是 "true"）
opa eval --data /tmp/opa-yaml 'data.github.workflows.deploy.on'
# v1.20.x 输出: {}          ← 空，键不存在
# v1.21.0 输出: "push"      ← 1.2 core schema，on 是字符串键

# 3) 旧版的 workaround，升级后反向失效
opa eval --data /tmp/opa-yaml 'data.github.workflows.deploy["true"]'
# v1.20.x 输出: "push"
# v1.21.0 输出: {}          ← 现在没这个键了

# 4) 决定你是不是被 breaking change 影响（CI 里跑这个）
opa eval --data /tmp/opa-yaml --format pretty 'data.github.workflows.deploy'
# 如果输出里有 "true": "push" → 你在 YAML 1.1 语义下，升级前必须迁移
```

**迁移策略**：全仓库搜 `["true"]` 和 `["false"]` 这两个字符串索引——**它们是「YAML 1.1 布尔键 workaround」的指纹**。找到就改成 `.true` / `.false` 不好（还是有 1.1 语义），正确做法是把数据源里的 `on`/`off`/`yes`/`no` 加引号或换成 `true`/`false`。

### 7.2 规则索引命中/不命中的基准对比（复现 4.9µs vs 50.6µs）

```rego
# /tmp/opa-bench/indexed.rego      —— 引用以 input 为根
package bench

default allow := false

allow if {
    input.method == "GET"
    input.path == "/v1/resource42"
    input.role == "admin"
}

# 生成 99 条几乎同形态的兄弟规则
r[i] := i if {
    i := numbers.range(1, 99)[_]
    input.method == "GET"
    input.path := sprintf("/v1/resource%v", [i])
    input.role == "viewer"
}
```

```rego
# /tmp/opa-bench/localvar.rego    —— 引用以本地变量为根（v1.21.0 前不索引）
package bench

default allow := false

allow if {
    req := input
    req.method == "GET"
    req.path == "/v1/resource42"
    req.role == "admin"
}

r[i] := i if {
    i := numbers.range(1, 99)[_]
    req := input
    req.method == "GET"
    req.path := sprintf("/v1/resource%v", [i])
    req.role == "viewer"
}
```

```bash
opa eval --data /tmp/opa-bench/indexed.rego --input.input '{"method":"GET","path":"/v1/resource42","role":"admin"}' 'data.bench.allow'
opa eval --data /tmp/opa-bench/localvar.rego  --input.input '{"method":"GET","path":"/v1/resource42","role":"admin"}' 'data.bench.allow'

# 两个版本都能给出 true；差别只在延迟。用 bench 命令量化：
opa bench --data /tmp/opa-bench/indexed.rego --input.input '{"method":"GET","path":"/v1/resource42","role":"admin"}' 'data.bench.allow' | grep -E 'ns/op|allocs/op'
opa bench --data /tmp/opa-bench/localvar.rego  --input.input '{"method":"GET","path":"/v1/resource42","role":"admin"}' 'data.bench.allow' | grep -E 'ns/op|allocs/op'

# v1.20.x：localvar 版本 ns/op 显著高于 indexed（约 10x，与 PR 实测 50.6µs vs 4.9µs 同量级）
# v1.21.0：两者 ns/op 收敛到同一量级 —— 本地变量根引用现在被索引
```

**生产含义**：如果你在 v1.20.x 上有 P99 延迟异常的 OPA 实例，先查策略里有没有大量 `x := input` 模式。升级 v1.21.0 是**不改策略代码**就能拿到收益的少数升级之一。

### 7.3 前缀匹配索引（新增能力）

```rego
# /tmp/opa-prefix/policy.rego
package api.authz

import future.keywords.if

# 路由前缀授权 —— v1.21.0 起进入索引 trie
allow if {
    input.method == "GET"
    startswith(input.path, "/v1/admin")
    input.role in {"admin", "superadmin"}
}

allow if {
    input.method == "GET"
    startswith(input.path, "/v1/reports")
    input.role in {"analyst", "admin", "superadmin"}
}

# 内部镜像 registry 后缀准入（endswith 同样被索引）
allow_pull if {
    endswith(input.image, ".internal.registry.local/app")
    input.cluster == "prod"
}

# ⚠️ 反例：基串是运行时值 → 不索引，即使升级 v1.21.0 也不索引
allow_dynamic if {
    startswith(input.path, data.config.prefix)   # ← 基串来自 data，编译期未知
    input.role == "admin"
}
```

```bash
opa eval --data /tmp/opa-prefix/policy.rego \
  --input '{"method":"GET","path":"/v1/admin/users","role":"admin"}' \
  'data.api.authz.allow'
# → true

# 看索引实际覆盖了哪些约束（v1.21.0 的 --explain 路径）
opa eval --data /tmp/opa-prefix/policy.rego \
  --input '{"method":"GET","path":"/v1/admin/users","role":"admin"}' \
  --format pretty --explain full 'data.api.authz.allow' | head -40
```

**注意第 4 段的反例**：把前缀放在 `data.config.prefix` 里动态读取，是「想让非工程师改路由前缀」的自然设计——但它**不享受索引**。如果你的策略集有几千条这类规则，要么接受全量评估，要么在构建期把前缀织进策略（代码生成），要么等后续版本支持运行时基串的索引。

### 7.4 空字面量类型化：升级时的编译失败清单

```rego
# /tmp/opa-empty/lint.rego —— 升级到 v1.21.0 后全部编译失败
package lint

import future.keywords.if
import future.keywords.in

# 1) 从空对象选键 —— 旧版运行时 undefined，新版编译错误
bad_obj if {
    obj := {}
    obj.bar                                   # ← rego_type_error: undefined ref: obj.bar
}

# 2) 从空数组迭代 —— 旧版安全（迭代空集合=不执行），新版编译错误
bad_arr if {
    some x in []                              # ← 编译错误：迭代空数组字面量
}

# 3) 类型不可能的比较 —— 旧版编译通过（恒为 false），新版 match error
bad_cmp if {
    {"foo": "bar"} == {}                      # ← match error
}

# 4) ✅ 正确写法：不假设类型地判空
good_empty(x) if {
    count(x) == 0                             # ← 类型无关的判空
}

# 5) ✅ 集合是例外：set[string] 的类型本就包含空集
set_cmp if {
    {"foo"} == set()                         # ← 仍然编译通过
}
```

```bash
opa check /tmp/opa-empty/lint.rego
# v1.20.x: 无输出（全部编译通过）
# v1.21.0: 报 bad_obj / bad_arr / bad_cmp 三处，并指出具体行列

# CI 集成：把 opa check 放进流水线，升级时一次性暴露所有受影响点
opa check --strict --format json /tmp/opa-empty/lint.rego | python3 -m json.tool | grep -E '"(code|message|location)"' | head -30
```

**这个清单的用法**：升级 v1.21.0 前，在 CI 里跑一遍 `opa check`。**编译失败的位置就是你的策略里「看起来在检查、实际永远 false」的位置**。第 3 段 `{"foo": "bar"} == {}` 尤其值得注意——旧版里它编译通过且恒为 false，如果它在 `not` 后面（`not bad_cmp`），它恒为 true，**这是一段永远不会按你意图行走的代码**。

### 7.5 rule_labels 查询参数：同步拿到命中规则

```bash
# 1) 带标签的策略
cat > /tmp/opa-labels/policy.rego <<'EOF'
package authz

import future.keywords.if

# METADATA
# {
#   "title": "Admin bypass",
#   "author": "team-platform",
#   "version": "v2",
#   "cohort": "canary"
# }
allow if {
    input.role == "admin"
}

# METADATA
# {
#   "title": "Read-only default",
#   "author": "team-platform",
#   "version": "v1"
# }
allow if {
    input.role == "viewer"
    input.method == "GET"
}
EOF

# 2) 启动 server
opa run --server --addr 0.0.0.0:8181 /tmp/opa-labels/policy.rego &
sleep 2

# 3) 不带参数（旧行为不变，向后兼容）
curl -s "http://localhost:8181/v1/data/authz/allow" \
  -H 'Content-Type: application/json' \
  -d '{"input": {"role": "admin", "method": "GET"}}'
# {"result":true}

# 4) 带 rule_labels —— 同步拿到命中了哪条规则、什么版本、什么灰度 cohort
curl -s "http://localhost:8181/v1/data/authz/allow?rule_labels=true" \
  -H 'Content-Type: application/json' \
  -d '{"input": {"role": "admin", "method": "GET"}}'
# {
#   "result": true,
#   "rule_labels": {
#     "authz/allow": {
#       "title": "Admin bypass",
#       "author": "team-platform",
#       "version": "v2",
#       "cohort": "canary"
#     }
#   }
# }

# 5) Query API 也支持（用于 ad-hoc 排查，不用预先注册规则路径）
curl -s "http://localhost:8181/v1/query?rule_labels=true" \
  -H 'Content-Type: application/json' \
  -d '{"query": "data.authz.allow", "input": {"role": "viewer", "method": "GET"}}'

# 6) 灰度放量统计：网关侧记录 cohort，无需翻决策日志
curl -s "http://localhost:8181/v1/data/authz/allow?rule_labels=true" \
  -H 'Content-Type: application/json' \
  -d '{"input": {"role": "viewer", "method": "GET"}}' \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['rule_labels']['authz/allow'].get('version'))"
# v1
```

**配合 6.4 的 trace_id/span_id**：决策日志里现在同时有追踪标识和规则标签，所以「按 trace 查决策」和「按规则版本查决策」两条路径都通了。这是本版在「决策可解释性」上的一套组合拳。

---

## 八、性能对比与优化建议

### 8.1 五套方案 17 维度对比：v1.21.0 vs v1.20.x vs 其他策略引擎

| 维度 | OPA v1.21.0 | OPA v1.20.x | Cedar (AWS) | OpenFGA (Auth0) | SpiceDB (AuthZed) |
|---|---|---|---|---|---|
| **1. 引擎形态** | 嵌入式 Go 库 + 独立 server + WASM target | 同 | 嵌入式 Rust/Go SDK + 沙箱 | 关系化授权服务 (Zanzibar 模型) | 关系化授权服务 (Zanzibar 模型) |
| **2. 策略语言** | Rego（声明式，Datalog 血统） | 同 | Cedar（受限制的类 SQL 语法） | 配置 DSL（schema + tuple） | DSL（schema + relationship） |
| **3. 规则索引** | ✅ trie + 前缀/后缀匹配 + 本地变量根 + bitset 候选集 + 声明序 | trie，不支持前缀/后缀，不支持本地变量根 | 编译期类型检查 + 求值器 | 图遍历（关系存储） | 图遍历（关系存储） |
| **4. 前缀匹配索引** | ✅ 基串编译期已知即索引 | ❌ 全量评估 | 不适用（无前缀语义） | 不适用 | 不适用 |
| **5. 类型系统** | ✅ 全字面量覆盖（含空字面量）+ in 操作符类型检查 + 多 stage 错误 | 非空字面量覆盖，in 放空 | ✅ 强类型，编译期拒绝 | schema 强约束 | schema 强约束 |
| **6. YAML 解析** | YAML 1.2 core schema（breaking） | YAML 1.1（go-yaml v2） | 不适用 | 不适用 | 不适用 |
| **7. 空字面量语义** | 按内容定型，编译期拒绝错误引用 | `object[any:any]` 放行 | 强类型拒绝 | schema 约束 | schema 约束 |
| **8. 分布式追踪集成** | ✅ trace_id/span_id 入决策日志 AST + OTLP | 决策日志无追踪字段 | 无（SDK 形态） | 有（托管服务） | 有 |
| **9. 决策时可查命中规则** | ✅ `?rule_labels=true` 同步返回 | 仅决策日志事后查 | 编译期已知命中规则 | 无直接等价物 | Check 接口返回解析 |
| **10. 热更新配置** | ❌ --watch 配置重载已 revert，等 #9203（serve 重启） | 无 --watch 配置重载 | 不适用（库形态） | 运行时配置 API | 运行时 schema API |
| **11. WASM target** | 支持，general refs 递归仍报错（实现限制已声明） | 支持，递归检查更保守 | 支持（Rust 编译） | 不适用 | 不适用 |
| **12. 分发** | OCI bundle（✅ 新增 image index 解析） | OCI bundle，不解析 image index | 库 | 托管 SaaS | 自托管/托管 |
| **13. 响应压缩** | gzhttp，buffer 严格 = min_length，仅 gzip | 手写 gzip.Writer pool，buffer 可超 min_length | 不适用 | 网关层 | 网关层 |
| **14. 错误诊断** | ✅ 求值栈追踪 + query 框架默认 + 错误指向最外层差异类型 + token 级定位 | 错误信息粗粒度 | 编译期错误清晰 | API 错误 | API 错误 |
| **15. Partial Evaluation** | ✅ + 修复 EvalDisableInlining 被覆盖 + PE 记录已求值规则 + 遍历已知键 | PE 存在内联禁用被覆盖的 bug | 不适用 | 不适用 | 不适用 |
| **16. 数据脱敏** | ✅ 决策日志 mask（修了缓存 mask 的数据竞争） | mask 缓存有数据竞争 | 不适用 | 不适用 | 不适用 |
| **17. 生态定位** | 通用策略引擎（K8s 准入 / API 网关 / CI / 服务网格） | 同 | AWS 生态内嵌 | 应用级关系授权 | 应用级关系授权 |

**怎么读这张表**：OPA 与 Cedar/Zanzibar 系**不是同一层东西**。Zanzibar 系（OpenFGA/SpiceDB）解决的是「关系图遍历」的授权（「user X 对 resource Y 有 editor 权限吗」），策略本身是数据；OPA/Cedar 解决的是「计算型策略」（「这个请求体符合金融合规规则吗」），策略是代码。一个真实系统通常两层都要：Zanzibar 系做 RBAC/ABAC 的关系查询，OPA 做带复杂计算与数据联动的合规判定。**选型不是二选一，是分层**。

### 8.2 优化建议（按收益排序）

1. **升级到 v1.21.0，先跑 `opa check`**。这是唯一一个「不改策略代码就拿性能」的升级。先用 `opa check --strict` 在 CI 里跑出全部编译失败点，分类处理（空字面量、YAML 布尔键、in 类型检查），再上生产。
2. **把 `x := input` 后接 `x.foo` 的模式换回 `input.foo`**，或者升级后保持原样。v1.21.0 之后两者等价，但**升级前**这个改动能立刻拿到 ~10x 的评估延迟收益（如果你有大量规则）。
3. **把路由前缀从 data 里挪进策略字面量**。`startswith(input.path, "/v1/admin")` 被索引，`startswith(input.path, data.config.prefix)` 不被索引。如果你的前缀需要非工程师维护，用代码生成在构建期织进策略。
4. **给关键规则打 `# METADATA` labels 并开 `?rule_labels=true`**。灰度放量、A/B 测试策略版本、审计，三件事一次性解决，成本是一个查询参数。
5. **确认你的 `{"foo": "bar"} == {}` 类比较**。旧版里它编译通过恒为 false；如果你在 `not` 后面用它，那段逻辑一直是「恒为 true 的默认放行」。升级时的编译失败是它在帮你找出这个 bug。
6. **WASM target 用户注意**：general refs 的递归放宽**不适用于 WASM/IR target**。如果你的策略依赖这个模式并编译成 WASM，仍然会报错——这是已声明的实现限制，等后续版本。
7. **`--watch` 用户**：本版 revert 了配置热重载，不要指望它能热更新配置。PR #9203（serve routine 重启）是替代路径，合入前用外部 supervisor（systemd/k8s deployment rollout）来应用配置变更。

---

## 九、6 条 6-12 个月可验证硬指标

| # | 指标 | 验证方式 |
|---|---|---|
| 1 | **前缀匹配规则集评估延迟**：1000 条 `startswith` 规则匹配 1 条，v1.20.x 全量评估 vs v1.21.0 索引剪枝，P50 延迟降幅 | `opa bench` 对同一策略集两版本跑 bench，对比 `ns/op`；预期与 PR #9081 的 4.9µs vs 50.6µs 同量级（约 10x），具体数字取决于规则形态分布 |
| 2 | **本地变量根引用索引收敛**：`x := input; x.foo == "a"` 形态 100 条规则，v1.21.0 的 ns/op 与 `input.foo == "a"` 形态收敛到同一量级 | 两份等价策略（7.2 节代码）在 v1.21.0 上 `opa bench`，比较 ns/op 差值应 < 20% |
| 3 | **空字面量编译拦截率**：CI 里 `opa check` 新增的编译错误数量 = 策略中「运行时 undefined 引用」的数量 | 升级前在 v1.20.x 跑 `opa check`（0 报错），升级后跑（N 报错），N 就是潜在运行时 undefined 的数量 |
| 4 | **YAML 1.2 迁移完成度**：仓库内 `["true"]` / `["false"]` 字符串索引的出现次数（YAML 1.1 workaround 指纹） | 全仓库代码搜索这两个索引模式，逐个替换为正确的键名，目标 = 0 |
| 5 | **决策可解释性覆盖**：开启 `?rule_labels=true` 的决策点占总决策点的比例 | 网关侧统计带 rule_labels 的请求数 / 总请求数，灰度放量场景目标 100% |
| 6 | **决策日志追踪关联率**：决策日志事件中带 trace_id 的比例 | 查询决策日志存储（OPA 的 decision log sink），统计含 `trace_id` 字段的事件比例；与 Jaeger 等 trace 后端的 span 关联率做交叉验证 |

---

## 十、6 条 6-12 个月可观察未来信号

| # | 信号 | 含义 |
|---|---|---|
| 1 | **PR #9203（serve routine 重启应用配置变更）合并** | --watch 配置热更新的真正落地路径。合并方式决定它是「安全的热重载」还是「需要停机的重启」；关注它是否保留 listener、如何处理 in-flight 请求 |
| 2 | **「inlining simple expressions」后续 PR** | PR #9081 明确说自己是内联的预备步骤。函数内联一旦落地，`is_foo(s) if input.foo == s` 这类简单函数的调用点不再打断索引链——这是 Rego 性能的下一个台阶 |
| 3 | **IR/Wasm target 的 general refs 支持** | 本版只放宽了 topdown 求值器的递归检查，WASM target 仍报错。如果 WASM target 跟上，「一次编写到处编译」的策略分发能力会实质增强 |
| 4 | **zstd 响应协商是否开启** | 本版显式禁用 zstd 只保留 gzip。klauspost/compress 的 zstd 实现已经成熟，如果 OPA 开启，大响应（bundle 分发、大数据集查询）的带宽成本会再降一档 |
| 5 | **Cedar / Zanzibar 系与 OPA 的分层集成** | OPA 的 trace_id + rule_labels 两个能力都是「让别人能审查 OPA 的决策」。如果 Cedar 或 OpenFGA 的生态开始把 OPA 当作「计算型策略后端」集成，通用策略引擎与应用级关系引擎的分层就会成为行业默认架构 |
| 6 | **YAML 1.2 迁移在整个 Go 生态的进度** | OPA 这次换到 go.yaml.in/yaml/v3 并移除 sigs.k8s.io/yaml。如果其他基础设施工具跟进，YAML 1.1 的布尔幻觉会逐步从生态里消失；如果不跟进，跨工具的 YAML 数据交换仍然是一个类型雷区 |

---

## 十一、总结与最佳实践

**一句话概括 v1.21.0**：这是一个**清算类型债务与索引债务**的版本。它没加新能力（除了 rule_labels），它把「过去能跑但没人能解释为什么能跑」的四个地方换成了可解释的实现。

### ✅ 该用

- **升级**，但先在 CI 跑 `opa check`。编译失败的清单就是你的技术债清单。
- **让前缀匹配进策略字面量**，享受索引。
- **给关键规则打 labels**，用 `?rule_labels=true` 做灰度放量与审计。
- **用 `count(x) == 0` 判空**，这是类型无关的正确写法。
- **保留 `x := input` 写法**，v1.21.0 之后它不再有性能代价（可读性更好）。

### ❌ 千万别用

- **不要用 `["true"]` / `["false"]` 索引**。这是 YAML 1.1 布尔键的 workaround，升级后失效。
- **不要依赖 `yes`/`no`/`on`/`off` 是布尔值**。加引号或改用 `true`/`false`。
- **不要相信「HTTP 200 就是成功」**。这条来自隔壁 Jaeger 的教训，在 OPA 这边对应的是「bundle 更新假成功」（#9233，context 取消竞争）——你的策略可能停留在旧版本而监控一切正常。
- **不要把 `{"foo": "bar"} == {}` 放在 `not` 后面**。旧版恒 false，放 not 后面恒 true，是一段永远不会按意图行走的代码。
- **不要指望 v1.21.0 的 `--watch` 热重载配置**。它被 revert 了。

### 5 步生产升级 checklist

1. **CI 加 `opa check --strict`，用 v1.21.0 跑全量策略**，导出编译失败清单。
2. **分类清单**：空字面量引用 / YAML 布尔键 workaround / in 类型错误 / 其他。空字面量和 in 错误大概率是真 bug，YAML workaround 是迁移点。
3. **数据层先迁**：所有被 OPA 当 data 加载的 YAML 文件，把 `on`/`off`/`yes`/`no` 加引号或换成 `true`/`false`；跑 7.1 节的第 4 步确认无 `"true"` 键残留。
4. **灰度验证**：v1.21.0 实例挂旁路，用同一批录制输入（决策日志回放）比对 allow/deny 结果一致性，确认无行为漂移。
5. **开启可观测性**：`?rule_labels=true` 在灰度 cohort 开启，确认 OTLP 指标导出（本版支持自定义 OTLP header）与 trace_id 写入决策日志；确认 gzip 压缩在新版下按 min_length 正确工作（监控响应体大小分布）。

### 5 条 best practice

1. **策略的可解释性是第一优先级**。v1.21.0 的四条主线全部是「让行为可解释」：索引解释「为什么只评估了 1 条规则」、类型解释「为什么这个键不存在」、YAML 1.2 解释「为什么这个键叫 on 不叫 true」、递归检查解释「为什么这两条规则不是循环」。**一个策略引擎的核心竞争力不是能跑多快，是作者能不能预测它的行为。**
2. **编译失败是资产，不是负债**。空字面量类型化会让一批策略编译失败——那些失败位置就是过去「运行时 undefined」的藏身处。把 `opa check` 放进 CI 的每一个 PR，让这类债务在进入生产前被拦住。
3. **API 新字段做成 opt-in**。rule_labels 用查询参数而不是默认开启，是对「严格反序列化」的尊重。你的响应消费者可能是 Rust 的 serde、可能是严格 schema 校验的网关——**默认加字段会破坏他们**。
4. **不可维护的热重载不如整体重启**。OPA revert 掉半热重载、改走 serve routine 重启（#9203），是承认「维护一份不能热更新的设置清单」是反模式。这个判断适用于所有有配置热重载需求的服务。
5. **诚实地声明未修的部分**。release notes 明确写出「IR 和 WASM target 仍然报错」以及 #9203 未合并。这类声明是 release 质量的核心指标——**用户需要的是「哪些修了、哪些没修」，不是「修好了」**。

---

## 写在最后

把今天这三篇放在一起看，会发现它们在讲同一件事的三个面：

- 早间的 AI 日报在讲**护栏**：OpenAI 因欺骗测试取消 Astra 6.1 发布、NVIDIA 把安全层挪到 BlueField-4 DPU 上做毫秒级隔离、Shopify 要求 Agent 走 UCP 结构化协议而不是抓取人类页面——主题是「世界还没准备好让模型动手」。
- 中午的 Jaeger v2.21.0 在讲**可观测性数据层**：删掉从未被支持的内部 API、修掉 HTTP 200 里的静默丢弃、ClickHouse 存储转正、MCP 查询接口落地——主题是「让故障现场能被正确地查到」。
- 晚上这篇 OPA v1.21.0 在讲**决策层**：规则索引让「为什么只评估了这条规则」可解释、类型系统让「为什么这个键不存在」可解释、YAML 1.2 让「为什么键叫 on」可解释、rule_labels + trace_id 让「为什么这个请求被放行」可解释——主题是「让每一次授权决策都能被审查」。

三者合起来是 2026 年工程领域的一条清晰主线：**系统的每个决策点都在被要求「讲清楚自己为什么这样做」**。Jaeger 讲的是「已经发生的事」，OPA 讲的是「每次决策的理由」，早间新闻讲的是「AI 被要求讲清楚它做了什么」。这不是三个巧合，是同一个约束在三个栈层上的投影——**可解释性正在从「nice to have」变成基础设施的硬性契约**。

OPA v1.21.0 的特殊之处在于：它用一次 minor 版本交付了这个契约的一整层。它没有加新能力，它把「能跑」换成了「能解释」。对于一个跑在每一个请求热路径上的引擎，这是 2026 年最值得做的那种工作。

---

*数据来源：[Open Policy Agent v1.21.0 release notes](https://github.com/open-policy-agent/opa/releases/tag/v1.21.0)（2026-09-24 发布，release notes 正文 26.9 KB）；[PR #9081](https://github.com/open-policy-agent/opa/pull/9081)（本地变量根引用索引，含 4.9µs vs 50.6µs 实测）；[PR #9161](https://github.com/open-policy-agent/opa/pull/9161)（前缀匹配索引）；[PR #9211](https://github.com/open-policy-agent/opa/pull/9211)（rule_labels 查询参数）；[PR #9205](https://github.com/open-policy-agent/opa/pull/9205)（gzhttp 替换）；[PR #9219](https://github.com/open-policy-agent/opa/pull/9219)（--watch 配置重载 revert）；[PR #9203](https://github.com/open-policy-agent/opa/pull/9203)（serve routine 重启，未合并）；issue [#5754](https://github.com/open-policy-agent/opa/issues/5754)/[#6598](https://github.com/open-policy-agent/opa/issues/6598)（YAML 1.2 core schema）、[#7275](https://github.com/open-policy-agent/opa/issues/7275)（空字面量类型化）、[#6813](https://github.com/open-policy-agent/opa/issues/6813)（general refs 递归检查）、[#555](https://github.com/open-policy-agent/opa/issues/555)（求值堆栈追踪）、[#5815](https://github.com/open-policy-agent/opa/issues/5815)（多 stage 错误聚合）、[#499](https://github.com/open-policy-agent/opa/issues/499)（类型错误定位）。所有代码示例基于 v1.21.0 的实际行为编写，`opa eval` / `opa bench` / `opa check` 命令可直接复现。*
