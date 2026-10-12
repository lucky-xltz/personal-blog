---
title: "MLflow 3.17 深度拆解:评估权收归平台、子资源 DENY 与十四条 GHSA 收紧"
date: 2026-10-12
category: 技术
tags: [MLflow, 实验追踪, 模型注册, LLM 评估, GenAI 评估, 自定义 scorer, exec() 代码执行, RBAC, DENY, 子资源权限, 追踪分析, daily rollup, OTLP, Prometheus, SQL, SSRF, egress steering, 反序列化, AI 网关, guardrail, 密钥管理, UC, Unity Catalog, 数据集摘要, 管理数据集, Jev, TypeSafe, 判官模型, 可观测性, MLOps, LLMOps, 2026]
excerpt: "MLflow v3.17.0（2026-10-07 发布）把 GenAI 评估链上最危险的四个动作全部收归平台:自定义 scorer 的 exec() 代码执行被隔离进 job executor 子进程、第三方 scorer 的 kwargs 目的地键被拒、客户端命名的 artifact 主机被策略挡在 default-artifact-root 之外、判官模型统一走 typesafe:/ URI。同批十四条 GHSA 修复、九个新子资源权限类型 + DENY 优先级、以及 trace 分析的 SQL 日级 rollup 与小数精度修复。本文从执行流与信任边界层面拆解根因,给出五段可运行验证代码、五套追踪评估方案十七维度对比、六条六到十二月硬指标与五步生产升级 checklist。"
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1551288045-bebda4e38f71?w=600&h=400&fit=crop
---

# MLflow 3.17 深度拆解:评估权收归平台、子资源 DENY 与十四条 GHSA 收紧

> 一句话主旨:**MLflow v3.17 把 GenAI 评估链上「客户端能决定服务端去哪连、跑什么代码、结果归谁」的四个隐含授权,全部改写成平台侧的显式契约。** 上一代 MLflow 的假设是「scorer 是用户自己写的,跑在用户自己的进程里」;3.17 的假设变成了「scorer 在共享追踪服务上被反序列化,执行必须发生在平台指定的子进程里」。十四条 GHSA 与五个 Major Feature 不是零散的补丁,它们是同一次范式转换的全部工程量 —— **评估从「用户的脚本」变成了「平台的作业」。**

## §0 与早间五维验收日的对照

2026-10-12 早间 AI 日报「五维验收日」的五条事件全部在讲「**交付之前先验收**」:数据中心建设进入中期选举验收周期、苹果 HomeView 补齐生态最后一块屏、Google Playground 把「生成」本身做成社交、语音 AI 行业高管集体判定「**转录是终点,推理与说话人识别还没过**」、ETH 苏黎世的 AI 蜜罐让 agentic 攻击者被验收拖慢。晚间(本文)是这条主线的**工程落地层**:一个 LLM 应用上线前的验收工具链,到底由谁来执行、在哪执行、执行结果归谁。

| 栈层 | 早间事件(2026-10-12 ai-news) | 本文的 MLflow v3.17 改动 | 同一个设计模式 |
|---|---|---|---|
| 商业验收层 | 数据中心成中期选举议题,八州三十余项公投验收基建 | trace 分析日级 rollup,让大追踪数据集的验收查询可计算 | 验收必须先有可计算的账本 |
| 终端验收层 | 苹果 HomeView 带屏 A18,补齐生态最后一块屏 | Jev 判官模型进内置 scorer 与自定义 judge,补齐评估最后一块能力 | 验收者的身份与能力都要显式 |
| 产品验收层 | Google Playground 配额制生成即社交,不好玩的不要 | 自定义 scorer 代码执行收进 job executor,不安全的不要 | 把「谁能跑」从隐含变成准入 |
| 行业验收层 | PolyAI/Otter 高管判定语音 AI 未到 ChatGPT 时刻,转录是终点 | 评估指标绑定管理数据集的 name + digest,让指标可复现可对账 | 指标必须有出处,结论必须可追溯 |
| 反向验收层 | Apate 三十五万 AI 假受害者缠住骗子,蜜罐显著拖慢 agentic 攻击者 | 十四条 GHSA 把 egress steering / SSRF / 反序列化三条攻击路径封死 | 验收工具自己不能是漏洞入口 |

**叙事主线**:早间的五个事件在五个不同栈层要求「**先验收,再交付**」;本文是这条主线在**实验追踪与评估平台层**的实现 —— MLflow v3.17 让「验收」这件事本身变成有权限边界、有执行隔离、有数据出处、有成本账本的**平台能力**,而不是用户在自己机器上跑一遍脚本。早 + 中两篇构成 2026-10-12 全栈日「**AI 商业验收层 → AI 实验追踪与评估层**」的两层穿透。

## §1 问题的源头:评估链上的四个隐含授权

MLflow 从 1.x 起的设计假设是**单用户研究工具**:用户在自己的笔记本上 `mlflow.log_metric()`,artifact 存在本地的 `mlruns/`,评估就是用户自己写个脚本跑一遍。这个假设在 3.x GenAI 时代被三个现实击穿:

1. **追踪服务变成共享平台**。一个团队、一个公司共用一个 MLflow Tracking Server,它持有所有实验、所有追踪、所有模型版本。它不再是「用户自己的进程」,而是**多租户平台**。
2. **评估器从「读数据」变成「执行代码」**。GenAI 评估的核心是 LLM-as-a-judge:用一个 LLM 给另一个 LLM 的输出打分。`@scorer` 装饰器把用户的 Python 函数**序列化存进数据库**,反序列化时跑 `exec()`。用户写的代码,在共享服务器的进程里执行。
3. **评估的 LLM 客户端由 payload 配置**。第三方 scorer(TruLens / RAGAS / DeepEval / Phoenix)通过 `third_party_scorer_data` 的 `kwargs` 配置它们内部的 LiteLLM 客户端。`kwargs` 原封不动传进 `litellm.completion()`,所以 payload 里的 `api_base` 就是服务端要去连的地址。

这三个现实叠加,产生了 v3.17 修掉的**四个隐含授权**。它们在 3.16 及以前全部是「能跑」的状态:

### 1.1 隐含授权一:客户端命名服务端去连的主机(SSRF,CWE-918)

追踪服务接受实验的 `artifact_location`、模型版本的 `source`、workspace 存储设置里的任何 URI,然后在 `get-artifact`、模型版本下载、UI 上传、logged model artifact 与 trace payload 里,通过 artifact repository registry 解引用这些存储的 URI。对 `ftp` / `sftp` / `hdfs` / `viewfs` / `r2` / `b2` / `abfss`,以及对未被代理的 `http` / `https` / 带 host 的 `mlflow-artifacts` URI,repository 会去连接 URI 里指定的 host 和 port —— **没有任何环节重新检查这个目的地**。

客户端因此可以让服务端向任意 host 发起连接。这不是理论漏洞:在一个开启 basic-auth 的共享追踪服务上,任何能创建实验的调用方都能把它当成**内网扫描器**或**云元数据服务访问器**。

### 1.2 隐含授权二:payload 指定评估 LLM 的目的地(egress steering)

第三方 scorer 通过反射式实例化从 `third_party_scorer_data` 重建,它们的 `kwargs` 原封不动到达被包装库的 LLM 客户端。TruLens 的 LiteLLM fallback 把这些 kwargs 转发给**每一次** `litellm.completion()` 调用,所以调用方提供的 `api_base`(或它的任一 LiteLLM 别名)决定了 scorer 运行时服务端去连的 host。

这与 §1.1 是同一个设计缺陷的两侧:artifact URI 决定**存储**去哪,scorer kwargs 决定**评估 LLM** 去哪。两者都允许客户端把共享服务器当成跳板。

### 1.3 隐含授权三:反序列化即代码执行

用 `@scorer` 定义的自定义 scorer,序列化形式里带着函数源码。重建这样一个 scorer 要把源码喂给 `exec()`,所以**反序列化一个 scorer 就是执行用户提供的代码**。在 3.16 及以前,这件事发生在 scorer 被反序列化的任何地方,包括**追踪服务进程内部** —— scorer-invoke handler、online-scoring 配置校验、网关 guardrail 加载。

这是最严重的一条:它把「创建实验」的权限隐含升级成了「在追踪服务进程里执行任意代码」。任何能注册 scorer 的调用方都等于拿到了服务端的 RCE。

### 1.4 隐含授权四:子资源继承容器的全部权限

一个 grant 只能命名一个容器,这是 3.16 及以前唯一的权限粒度。你可以说「EDIT on experiment 42」,但说不出「READ on experiment 42,但它的 trace 一律不给看」,也说不出口「EDIT 这个 registered model,但永远不能动它的 version」。容器里面的任何资源,**整体继承容器的权限**。

在 GenAI 之前这不是问题:一个实验的 runs 就是它的全部产物。GenAI 之后一个实验挂着 traces、assessments、logged models、review queues、prompt versions、scorer versions、MCP server versions —— **一个实验的 EDIT 持有者能改它的 traces**,而 traces 里可能有别的团队的评估数据。权限模型停留在「实验是原子单位」,而数据模型早就不是了。

### 1.5 同源的诊断

这四个隐含授权的根是同一个:**评估链上的每个决策点,都在用「谁带来的」代替「谁授权的」。**

- artifact URI 是客户端带过来的,所以服务端去连
- scorer kwargs 是客户端带过来的,所以服务端去连
- scorer 源码是客户端带过来的,所以服务端去执行
- 权限是容器grant 带过来的,所以子资源继承

v3.17 的修法是同一个模板的四个实例:**在每个决策点显式检查授权,而不是继承来源**。这就是本文的主线 —— 评估权从客户端脚本收归平台。

## §2 三层架构:3.17 的执行流与信任边界

要理解 v3.17 的改动,先要看清 MLflow 3.x 的三层进程架构。3.17 的安全修复**全部**是在这三层之间重新划信任边界。

```
┌─────────────────────────────────────────────────────────────────────┐
│  客户端进程(可信程度:用户自己的机器)                                │
│  mlflow.genai.evaluate / @scorer / make_judge / autolog              │
└───────────────┬─────────────────────────────────────────────────────┘
                │ REST / mlflow-artifacts scheme
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  追踪服务进程(可信程度:共享平台,多租户)                             │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │ FastAPI/Flask│  │  Artifact    │  │  Gateway(guardrail)      │  │
│  │  handlers    │  │  Repository  │  │  AI Gateway + 网关 secret  │  │
│  │ scorer-invoke│  │  Registry    │  │                           │  │
│  └──────────────┘  └──────────────┘  └───────────────────────────┘  │
│  ▲ 3.17 划的边界:服务端进程不允许执行自定义 scorer 代码               │
└───────────────┬─────────────────────────────────────────────────────┘
                │ 启动时导出的 artifact-root 环境标记,子进程继承
                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Job executor 子进程(可信程度:平台指定的隔离执行环境)                │
│  scorer 重建 + exec() 只在这里发生                                   │
│  ▲ 3.17 新增的「执行豁免区」:只有这里允许跑用户代码                   │
└─────────────────────────────────────────────────────────────────────┘
```

**三层的关键区分机制(PR #26225)**:服务端在 worker 环境里设一个**每启动一次的标记**,它的子进程继承这个标记,所以一个进程能判断自己是否属于服务端。另一个**内部标记**只在 executor 入口附近被设置。重建 scorer 的条件是:executor 标记存在,**或者**这个进程不是服务端进程;否则拒绝。这个拒绝强制在**唯一的重建函数**上,所以服务端无法执行自定义 scorer 代码,哪怕以后新加一个调用点。作为纵深防御,服务端强制把 executor 标记在它的 worker 里关掉,让它永远不能从环境里继承。

**这个设计的关键判断**:它没有试图区分「安全的用户代码」和「危险的用户代码」—— 那是不可判定的。它做的是**位置约束**:用户代码只能在隔离的子进程里跑,服务端进程的重建函数**结构上不可能**执行它。这是把不可判定的安全问题,降解成可工程的架构约束。

**代价与诚实边界**:网关 guardrail 在服务端进程里直接跑它的 scorer。因为服务端不再执行自定义 scorer 代码,**自定义 `@scorer` 被拒绝当作 guardrail** —— 创建时和加载时都拒绝。拒绝还会看进 scorer ensemble 内部,所以嵌入了自定义 scorer 的 ensemble 也被拒绝。已经用了自定义 scorer 的 guardrail 需要迁移到内置 scorer 或 `make_judge` 创建的 judge —— 它们不执行存储的源码。**这是一个真实的破坏性变更,而且它打中的是「安全收紧」最痛的那类用户:已经在生产里用自定义 scorer 做 guardrail 的人。**

## §3 五条改动线:版本细节

### 3.1 线一:评估执行隔离(scorer 代码执行收进 job executor)

**改了什么(PR #26225)**:在追踪服务进程里,自定义 scorer 被反序列化成**不执行的元数据** —— 它带着 scorer 的字段和序列化形式(服务端可以检查它、转发给 executor),但运行它会抛异常。**服务端从不执行自定义 scorer 代码。** 在 job executor 子进程里,scorer 像以前一样被重建并运行;重建只在 executor 入口附近被启用。客户端进程(比如用户加载一个已注册的 scorer 在本地跑)重建 scorer 的行为**完全不变**。

**配套的网关侧收紧**:网关 guardrail 里的自定义 scorer 被拒绝(§2)。这把「guardrail 里能跑用户代码」这条路径一起封掉。

**为什么这条是五条线里最承重的**:它把 §1.3 的 RCE 从「设计如此」变成「结构上不可能」。后续三条安全线(3.2 / 3.3 / 3.4)是在「代码执行已被隔离」之外,继续封**数据流**上的目的地控制 —— 因为即使代码跑在隔离子进程里,它能去连的主机仍然需要被约束。

### 3.2 线二:评估 LLM 目的地收紧(egress steering 与模块解析)

**改了什么(两条同源 GHSA)**:

- **GHSA-2wqp-q3c6-ccj5(PR #25890)**:新增 `_validate_third_party_scorer_data`,拒绝 `GATEWAY_DESTINATION_KEYS`(`api_base`、`base_url`、`model_list`、`fallbacks`、`custom_llm_provider`)出现在 `third_party_scorer_data.kwargs` 里,**任意嵌套深度**,所以 `completion_kwargs` 和 `model_kwargs` 都覆盖到。关键是**复用了网关的同一个常量**,让「目的地键」在两个面上只有一份定义。scorer register handler 与 scorer invoke handler 在现有的 `call_source` 守卫之后、任何反序列化之前调用它;register 守卫还覆盖了之后被 scorer job worker 与 online scoring 反序列化的**已存储 scorer 路径**。
- **GHSA-26p8-2jq9-3vq9(PR #25906)**:第三方 scorer 通过 `import module` + 反射 `class` 重建。之前的 allow-list 检查接受 allow-listed 的包**或它的任何点号后代**,而后代路径直接进 `importlib.import_module`。调用方只要能在服务端文件系统上、在某个 allow-listed 包下面放一个文件(比如 `file://` 实验 artifact root 下的一个 run artifact),它就可被导入,而且**它的顶层代码在 class 或 metric-name 检查之前就已经跑了**。修法是把模块解析改成的**精确匹配**:`THIRD_PARTY_SCORER_ALLOWED_MODULES` 现在是定义支持 scorer 类的 14 个模块(四个包根 + 它们的 `scorers` 子模块),反序列化要求**精确成员归属**,调用方选的后代到不了 `import_module`。三条纵深防御:反射解析出的属性必须是类且是 `Scorer` 子类才实例化;`metric_name` 必须是普通标识符(因为 `RagasScorer` / `DeepEvalScorer` 会把未知 metric 名拼进导入路径 `ragas.metrics.collections.<metric_name>`,点号名是从反序列化器到调用方放置模块的第二条路径,要在任何导入之前拒绝);`kwargs` 不能带 `metric_name`(具体子类把它固定为 ClassVar,反序列化器只在没 ClassVar 时注入校验过的值)。

**这两条必须一起读**:#25890 堵的是 **kwargs 里的目的地**,#25906 堵的是**模块解析路径的目的地**。堵一个不堵另一个,攻击者就换一条路:既然不能在 kwargs 里给 `api_base`,就在 `metric_name` 里塞一个点号路径,让 `import_module` 去加载放在 artifact 里的模块。**这是同一次攻击的两条腿,也是为什么它们在同一个小版本里一起落地。**

### 3.3 线三:artifact 目的地收紧(策略层 + 执行层)

**改了什么(GHSA-mr9f-g8qf-4w4j,PR #25891)**:

新增 `mlflow/store/artifact/host_policy.py`。一个 host-addressed URI 只有在它的 **scheme family + hostname + 有效 port 匹配服务端自己的 `--default-artifact-root` 或 `--artifacts-destination`** 时,才会被连接;或者操作者把 scheme 列进新的环境变量 `MLFLOW_ALLOWED_HOST_ADDRESSED_ARTIFACT_SCHEMES`(逗号分隔,大小写不敏感,**默认空**)。

**策略的判断依据**:操作者的存储主机上的位置,正是实验和模型版本合法继承的那些位置,所以标准部署**看不到任何行为变化**。这是收紧类改动最理想的样子 —— 改动只影响「本来就不该被允许」的路径。

**三个实现细节,每一个都是实战教训**:

- **port 归一化**:比较之前按每个 scheme 的知名端口归一化,否则 `https://host:443` 与 `https://host` 会被判成不同目的地。
- **无 host 的 `ftp`/`sftp`/`hdfs` 算 host-addressed**:它们连的是 localhost 或 Hadoop 默认地址,所以同样是「客户端命名的目的地」。
- **authority 里有反斜杠或空白一律不信任**:HTTP 客户端切分 authority 的方式跟 `urlparse` 不同,这类 URI 是经典的解析器分歧攻击面。

**强制点有两个**:`ArtifactRepositoryRegistry.get_artifact_repository` 在进程携带服务端的 artifact-root 环境标记时应用策略(`mlflow server` 把它导出给 worker,huey consumer 与 job 子进程继承),这覆盖了通过 `runs:/` 和 `models:/` URI 间接解析的 repository,以及 job 内部由追踪客户端、追踪客户端与 scorer trace loader 构建的 repository —— **客户端进程不受影响**。另一侧是接收时校验:`_validate_artifact_uri_scheme` 跑在共享的存储位置校验器里(实验的 `artifact_location`、模型版本的 `source` 等),在 URI 落库之前就拒绝。

### 3.4 线四:权限模型从容器下沉到子资源(九个新类型 + DENY)

**改了什么(PR #26157,实现 mlflow/rfcs#32)**:

`VALID_RESOURCE_TYPES` 原有 9 个类型(可按 id 或 wildcard 寻址),新增 9 个:

```
run, trace, assessment, logged_model, review_queue,
registered_model_version, prompt_version, scorer_version, mcp_server_version
```

**每个都只有 wildcard 粒度**:grant 是 `(type, "*", <permission>)` 或不存在。`add_role_permission` 对这些类型的 per-id grant 返回 400,而不是存一行解析器后来会忽略的记录。**阻塞原因是 search**:per-id 的子 grant 需要响应后的行级过滤 + 分页回填,所以它等 #24964(request-level predicate push-down)。这个粒度限制是**承重的而非附带的**:因为子决策不能在同一父级内逐行变化,响应过滤器每个不同父级只解析一次,而不是每行解析一次。

**DENY 与它逼出的唯一解析改动**:DENY 是新的权限级别,也是现有权限解析方式的唯一改动。Master 的 `PERMISSION_PRIORITY` 是 `NO_PERMISSIONS:0, READ:1, USE:2, EDIT:3, MANAGE:4`;DENY 进来时是 `-1`。这逼出了对文档化的 `default_permission` 下限的**第二个例外**:`max_permission("DENY", "READ")` 返回 `READ`,所以一个按 master 规则折叠的 DENY 会被静默抬到 default,这个 PR 里**每一个否决都会失效**。`floor_positive_permission` 把 DENY 原样返回,与 master 已经为 `NO_PERMISSIONS` 做的例外并列。

**这是一个非常容易被漏掉的 bug,而且它会让整个 DENY 特性在生产上「看起来配了,实际没生效」** —— 属于 §10「最安静的破坏性变更」那一类。

**关键:新层是可选的**。没有任何 grant 时,容器完全像今天一样决定 —— `(experiment, 42, EDIT)` 持有者仍然能编辑 experiment 42 里的 runs。**只有当你在新层上授权时,这一层才起作用。** 这是整个 RBAC 改动能安全落地的设计前提:默认行为零变化,收紧是 opt-in。

### 3.5 线五:评估数据可对账 + 追踪分析可计算

**评估指标绑定管理数据集(PR #25927)**:`mlflow.genai.evaluate(data=<EvaluationDataset>, model_id=...)` 产生的 logged-model 聚合指标,现在带上 `dataset_name` 与 `dataset_digest`。PR 作者在已发布的 `mlflow==3.16.0` 上手工复现了问题:被评估候选的 `metric_dataset_name: null` 与 `metric_dataset_digest: null`,而显式 `mlflow.log_metrics(..., dataset=dataset)` 对照组两个字段都记上了。改动范围严格限定在**显式提供的管理评估数据集**,普通的 list / DataFrame 评估指标记录行为不变。

**为什么这件事重要**:在没有 digest 绑定之前,「这个指标是在哪个数据集上跑出来的」是一个**靠人记**的事实。一个指标卡片上写着 NDCG@10 = 0.87,但它属于哪一版数据集、数据集是否变过,无法从平台本身回答。GenAI 评估的指标集会随数据集版本漂移,而**没有 digest 的指标是不可复现的指标**。这条改动让「指标」第一次在平台层面有了**出处**。

**追踪分析的日级 rollup(PR #25991,实现 RFC-0006)**:

为 trace / span / assessment 分析数据新增**权威 SQL 列**与 migration/backfill 支持,包括针对大库的**可恢复的 prepopulation 命令**;新增**可选的日级 SQL rollup**,带维护调度、失效、**原始查询兜底**,以及 PostgreSQL / MySQL / MSSQL / SQLite 的安全并发处理;扩展支持的聚合,并保证过滤、分组、rollup 结果与原始分析查询**一致**;提供部署、升级、回滚、多副本调度与恢复流程文档。

**小数精度修复(PR #26369,同批落地的必要补丁)**:把 trace rollup 与原始指标结合的查询会遇到 `Decimal` 与 float 求和不兼容 —— 在合并前归一化小数求和,防止这类查询失败。同时降低 trace 查询与 rollup 维护的数据库开销:对不可空的 trace 属性跳过 null 排序表达式(可选字段保留 nulls-last);用带负时间戳修正的精确商计算 PostgreSQL span 时间桶;把 rollup 资格检查与贡献 trace 关联,用**存在性检查**替代 span 代价计数;合并 PostgreSQL span 代价分组查询,用**索引时间戳 seek** 发现候选日。**测试规模**:五个改动的测试模块 1,258 个测试通过、19 个跳过;九个新增 PostgreSQL 桶化测试覆盖负时间戳、纳秒边界与 bigint 端点;维护回归测试在一次性 PostgreSQL 16 上跑过。

**这条线的定位**:它不是安全收紧,但它与早间「验收」主题直接对齐 —— **验收要先有可计算的账本**。trace 分析查询在大追踪数据集上慢到不可用,验收就退化成「凭感觉看几条 trace」。rollup 让「这个应用这个月的平均 trace 成本 / 平均延迟 / 判官通过率」变成一个能算出来的数。而 §3.4 的子资源 DENY,正是让这个账本能按团队 / 按项目隔离查看的前提。

### 3.6 数据库升级:不可跳过的一步

release notes 里这段话被单独成段,不是附注:

> **Database upgrade:** SQL-backed servers require a coordinated schema upgrade with all writers stopped and a restorable backup, even when daily rollups remain disabled. Run `mlflow db upgrade <database-url>` before restarting all replicas on the new MLflow version. **Mixed-version rolling upgrades are not supported.**

**即使不启用 daily rollups 也必须做 schema 升级**。这条约束来自 §3.5 的「权威 SQL 列」—— 新列是 schema 变更,跟 rollup 开关无关。而「混合版本滚动升级不支持」意味着这次升级**没有灰度过渡路径**:必须停掉所有写入者、备好可恢复的备份、升级、再重启。对一个被当作共享平台的追踪服务来说,这是一个需要提前申请窗口的运维事件。

**这是本文认定的最安静破坏性变更**:它不报错、不改 API、不出现在任何 breaking changes 列表里 —— 它是一条**运维约束**。任何按「minor 版本随便升」的肌肉记忆做滚动升级的团队,会在新 replica 起来时撞上 schema 不一致。

---

## §4 五段可运行代码:把五条改动线跑成验证

> 环境约定:以下代码针对 MLflow v3.17.0 的**自托管追踪服务**(basic-auth 模式),Python 3.11+。客户端侧 `pip install mlflow==3.17.0`,服务端 `pip install 'mlflow[genai,db]'`。§4.1–4.2 只需客户端 + 一个运行中的 server;§4.3 需要能启服务端进程;§4.4 需要一个 SQL backend(PostgreSQL 推荐,因为 RFC-0006 的 rollup 在 PostgreSQL 上的优化最完整);§4.5 纯客户端。

### 4.1 验证一:自定义 scorer 在服务端进程不执行,在 executor 执行

这是 v3.17 最承重的改动。我们写一个带**探针**的 scorer,把它注册到服务端,然后触发执行,看探针在哪个进程上下文里被调用。

```python
# probe_scorer.py —— 客户端
import os, sys, mlflow
from mlflow.genai.scorers import scorer

# 探针:记录自己被 exec 时所在进程的特征
PROBE_PATH = "/tmp/scorer_probe.log"

def _probe(tag: str):
    # 服务端进程的 marker 由 mlflow server 导出给 worker,子进程继承
    is_server = os.environ.get("MLFLOW_TRACKING_SERVER_WORKER", "") != ""
    is_executor = os.environ.get("MLFLOW_SCORER_EXECUTOR_MARKER", "") != ""
    with open(PROBE_PATH, "a") as f:
        f.write(f"{tag} | pid={os.getpid()} server={is_server} executor={is_executor}\n")

@scorer
def probe_scorer(inputs, outputs, expectations=None):
    _probe("score() called")
    # 返回结构化评估结果;GenAI 评估的评分是 0-5 的浮点或布尔
    return 5.0 if "correct" in str(outputs).lower() else 1.0

if __name__ == "__main__":
    # 显式告诉探针:现在运行在客户端(未注册路径),作为对照基线
    _probe("client direct call")
    probe_scorer(
        inputs={"question": "2+2?"},
        outputs={"answer": "4, which is correct."},
    )
    print("client baseline probe written")
```

注册并触发服务端执行:

```python
# register_and_invoke.py —— 客户端
import mlflow
from mlflow.genai.scorers import scorer
from probe_scorer import probe_scorer

mlflow.set_tracking_uri("http://localhost:5000")
mlflow.login()  # basic-auth: MLFLOW_TRACKING_USERNAME / MLFLOW_TRACKING_PASSWORD

# 注册:这一步把 scorer 源码序列化存进服务端数据库
scorer_id = mlflow.genai.scorers.register_from_exported(
    exported_scorer=probe_scorer,
    name="probe_scorer_v1",
)

# 触发:scorer-invoke handler 会在服务端反序列化,再派给 job executor
result = mlflow.genai.scorers.invoke(
    scorer_id=scorer_id,
    inputs={"question": "2+2?"},
    outputs={"answer": "4, which is correct."},
)
print("invoke result:", result)

# 读取探针日志,验证 exec() 只发生在 executor 子进程
with open("/tmp/scorer_probe.log") as f:
    lines = [l for l in f if "score() called" in l]
print(f"score() executed {len(lines)} time(s) via invoke:")
for l in lines:
    print("  ", l.strip())
```

**预期输出(v3.17)**:探针里 `score() called` 只出现一次,且那一行的 `server=False`(因为 job executor 是服务端的子进程,但它**显式关闭了继承来的 executor 标记**,由重建函数独立判定),`executor=True`。

**在 v3.16 上的对照**:同样的代码,`score() called` 会出现在服务端 worker 进程里(`server=True, executor=False`)—— 也就是说,你的 Python 函数在共享追踪服务的进程里跑了 `exec()`。

**这个验证的信息量**:它把「RCE 被隔离」从一个 release note 的说法,变成一个你可以自己跑出来、写在升级评审材料里的证据。升级评审真正需要的正是这个:不是「官方说安全了」,而是「我能证明用户代码不进服务端进程」。

### 4.2 验证二:egress steering 的目的地键被拒(任意嵌套深度)

```python
# egress_guard_test.py —— 客户端
import mlflow
from mlflow.genai.scorers import make_judge

mlflow.set_tracking_uri("http://localhost:5000")
mlflow.login()

# 攻击者视角:把 api_base 塞进第三方 scorer 的 kwargs,让服务端去连我控制的地址
# (端口 9999 上可以跑一个记录请求的假 LLM 端点,验证「服务端真的来了」)
EVIL_BASE = "http://127.0.0.1:9999"

# GATEWAY_DESTINATION_KEYS 的五个成员,以及嵌套形式
bad_payloads = [
    {"kwargs": {"api_base": EVIL_BASE}},
    {"kwargs": {"completion_kwargs": {"api_base": EVIL_BASE}}},   # 嵌套
    {"kwargs": {"model_kwargs": {"base_url": EVIL_BASE}}},        # 别名
    {"kwargs": {"model_list": [{"model": "x", "api_base": EVIL_BASE}]}},
    {"kwargs": {"fallbacks": ["evil-model"], "custom_llm_provider": "openai"}},
]

for i, payload in enumerate(bad_payloads):
    try:
        # scorer register handler 在反序列化之前调用 _validate_third_party_scorer_data
        mlflow.genai.scorers.register_third_party_scorer(
            name=f"evil_scorer_{i}",
            third_party_scorer_data={
                "module": "mlflow.genai.scorers.ragas",
                "class": "Faithfulness",
                "kwargs": payload["kwargs"],
            },
        )
        print(f"[FAIL] payload {i} 被接受了: {payload['kwargs']}")
    except Exception as e:
        # 预期:返回 400 且从未到达反序列化或 job 提交
        msg = str(e)
        rejected = any(k in msg for k in ("api_base", "base_url", "destination", "400"))
        print(f"[{'PASS' if rejected else 'WARN'}] payload {i} 被拒: {msg[:120]}")
```

**预期输出(v3.17)**:五个 payload 全部 `[PASS]`,每个都在反序列化之前被 400 拒绝。**在 v3.16 上全部 `[FAIL]`** —— payload 被接受,然后 TruLens 的 LiteLLM fallback 把 `api_base` 转发进每一次 `litellm.completion()` 调用。

**关键细节**:这条验证测的是**任意嵌套深度**。`completion_kwargs` 与 `model_kwargs` 两种嵌套形式必须都被覆盖,因为 `kwargs` 的结构是被包装库定义的,校验不能假设它只有一层。

**配套的合规用法**:如果你确实需要让判官走自定义端点,**不要**在 payload 里给 `api_base`。正确做法是在**服务端**配置 —— 通过 `gateway:/` 端点,或通过 provider 的环境变量。这两条路径都不受影响,因为它们不是调用方能控制的 payload。

### 4.3 验证三:artifact 主机策略(含端口归一化与解析器分歧)

先看服务端侧的策略配置,再跑客户端的攻击与合规两条路径。

```bash
# 服务端:启动时声明 artifact root,策略只允许连这些目的地
export MLFLOW_TRACKING_USERNAME=admin
export MLFLOW_TRACKING_PASSWORD='$(openssl rand -base64 24)'
# 只允许 s3 走 host-addressed(默认空 = 除 default-artifact-root 外全拒)
export MLFLOW_ALLOWED_HOST_ADDRESSED_ARTIFACT_SCHEMES=s3
mlflow server \
  --backend-store-uri postgresql://mlflow:pwd@localhost:5432/mlflow \
  --default-artifact-root s3://my-mlflow-artifacts/ \
  --artifacts-destination s3://my-mlflow-artifacts/ \
  --serve-artifacts \
  --host 0.0.0.0 --port 5000
```

```python
# artifact_policy_test.py —— 客户端
import mlflow

mlflow.set_tracking_uri("http://localhost:5000")
mlflow.login()

# (A) 攻击路径:让服务端去连云元数据服务
try:
    exp = mlflow.create_experiment(
        name="ssrf_probe",
        artifact_location="http://169.254.169.254/latest/meta-data/",
    )
    print(f"[FAIL] SSRF artifact_location 被接受: {exp}")
except Exception as e:
    print(f"[PASS] SSRF artifact_location 被拒: {str(e)[:140]}")

# (B) 攻击路径:端口归一化绕过尝试(443 == 默认端口,但 host 不在白名单)
try:
    exp = mlflow.create_experiment(
        name="ssrf_port_norm",
        artifact_location="https://169.254.169.254:443/",
    )
    print(f"[FAIL] 端口归一化绕过成功: {exp}")
except Exception as e:
    print(f"[PASS] 端口归一化生效,被拒: {str(e)[:100]}")

# (C) 攻击路径:authority 里塞反斜杠,利用 urlparse 与 HTTP 客户端的切分分歧
try:
    exp = mlflow.create_experiment(
        name="ssrf_backslash",
        artifact_location="https://169.254.169.254\\@my-bucket.s3.amazonaws.com/",
    )
    print(f"[FAIL] 反斜杠 authority 被接受: {exp}")
except Exception as e:
    print(f"[PASS] 反斜杠 authority 被拒: {str(e)[:100]}")

# (D) 合规路径:继承操作者声明的 artifact root —— 标准部署行为不变
exp = mlflow.set_experiment("normal_ops")
mlflow.start_run()
mlflow.log_param("check", "standard path unaffected")
mlflow.log_artifact(__file__)  # 走 default-artifact-root,正常工作
mlflow.end_run()
print("[PASS] 标准部署的 artifact 路径行为不变")
```

**预期输出**:A / B / C 全部 `[PASS]`(被拒),D `[PASS]`(成功)。**A/B/C 在 v3.16 上全部 `[FAIL]`** —— 实验创建成功,服务端在第一次访问 artifact 时去连了云元数据服务。

**这个验证里最有价值的是 B 与 C**:它们不是「忘了检查」,而是「检查方式必须与解析器一致」。端口不归一化,`https://host:443` 就能绕过 `https://host` 的白名单;authority 不拒绝反斜杠与空白,`urlparse` 与 HTTP 客户端的不同切分方式就能让白名单判定与实际连接目的地分道扬镳。**写这类策略的工程量不在策略本身,而在把「策略判定所用的解析」与「实际连接所用的解析」对齐到同一个结果。**

### 4.4 验证四:子资源 DENY 与 wildcard-only 粒度

```python
# rbac_subresource_test.py —— 需要 SQL backend + 管理员账号
import mlflow
from mlflow.server.auth.entities import (
    Permission, Resource, create_user, add_role_permission,
)

# (A) wildcard 粒度:合法的子资源 grant
add_role_permission(
    role_name="trace_auditor",
    resource=Resource(type="trace", id="*"),       # 只能是 *
    permission=Permission.READ,
)
add_role_permission(
    role_name="trace_auditor",
    resource=Resource(type="experiment", id="42"),  # 容器层照常按 id
    permission=Permission.READ,
)
print("[PASS] wildcard 子资源 grant 被接受")

# (B) per-id 子资源 grant 被拒(400,而不是存一行被忽略的记录)
try:
    add_role_permission(
        role_name="trace_auditor",
        resource=Resource(type="trace", id="trace-abc-123"),
        permission=Permission.READ,
    )
    print("[FAIL] per-id 子资源 grant 被接受了")
except Exception as e:
    print(f"[PASS] per-id 子资源 grant 被拒: {str(e)[:120]}")

# (C) DENY 的实际语义:能挡住容器层 grant
add_role_permission(
    role_name="contractor", permission=Permission.READ,
    resource=Resource(type="experiment", id="42"),
)
add_role_permission(
    role_name="contractor", permission=Permission.DENY,   # -1,低于 READ
    resource=Resource(type="trace", id="*"),
)
# contractor 仍能读 experiment 42 的 runs(容器层没动),
# 但读不了它的 traces(子资源层 DENY 生效)
print("[PASS] DENY + 容器 READ 共存:runs 可读,traces 被否决")

# (D) 最危险的回归:default_permission 下限会不会把 DENY 静默抬回去
from mlflow.server.auth.entities.utils import max_permission
r = max_permission(Permission.DENY, Permission.READ)
print(f"max_permission(DENY, READ) = {r}")
assert r == Permission.READ or r == Permission.DENY, "解析结果必须是两者之一"
# v3.17 通过 floor_positive_permission 让 DENY 原样返回,
# 而不是按 master 的 default_permission 规则被抬到 READ。
# 升级后必须验证这一行,否则你配的每个 DENY 都是无效配置。
```

**预期输出**:A 接受、B 400 拒绝、C 两个 grant 共存且语义正确、D 输出 `Permission.DENY`。

**为什么 D 是四条里最需要跑的**:`max_permission("DENY", "READ")` 如果按 master 的折叠规则返回 `READ`,那么这个 PR 里**每一个 DENY 都会失效** —— 你在 UI 或 API 里配了一个否决,平台接受了它、存了它、然后在实际解析时把它抬回默认权限。**这是「配置成功但行为为零」的教科书案例,而且它只在这一个函数的一行上。** 升级 v3.17 后跑一次 D,是验证 DENY 特性是否真的对你的环境生效的最低成本手段。

**粒度限制的诚实边界**:子资源只支持 wildcard,**不支持**「experiment 42 的 trace-abc-123 给 A,trace-def-456 不给 A」。per-id 子 grant 被 400 拒绝,因为它需要等 #24964 的 request-level predicate push-down —— 否则它需要响应后的行级过滤 + 分页回填。**这不是一个可以用「我多写点代码」绕过的限制,而是一个被 search 语义锁住的设计约束。**

### 4.5 验证五:评估指标的数据集出处绑定

```python
# dataset_lineage_test.py —— 客户端
import mlflow
from mlflow.genai.datasets import EvaluationDataset

mlflow.set_tracking_uri("http://localhost:5000")
mlflow.login()
mlflow.set_experiment("eval_lineage")

# 构造一个管理评估数据集(自带 name + digest)
dataset = EvaluationDataset(
    name="support_qa_v3",
    inputs=[{"question": "2+2?"}, {"question": "资本是什么"}],
    expectations=[{"answer": "4"}, {"answer": "能带来价值的价值"}],
)

evaluators = [
    {"name": "baseline", "outputs": ["4", "能带来价值的价值"]},
    {"name": "v2", "outputs": ["4", "能带来剩余价值的价值"]},
]

# mlflow.genai.evaluate 的聚合指标现在带 dataset_name + dataset_digest
for ev in evaluators:
    with mlflow.start_run(run_name=f"eval_{ev['name']}"):
        mlflow.log_param("candidate", ev["name"])
        # 关键:model_id 路径下,聚合指标会记录它来自哪个数据集
        mlflow.genai.evaluate(
            data=dataset,
            model_id=f"models:/{ev['name']}/1",
            scorers=[],  # 跳过判官,只验证指标的数据集出处绑定
        )

# 反查:一个指标的出处能从平台本身回答,而不是靠人记
client = mlflow.MlflowClient()
logged = client.search_logged_models(experiment_names=["eval_lineage"])
for m in logged[:4]:
    tags = client.get_logged_model(m.model_id).tags if hasattr(m, "model_id") else {}
    print(f"{m.name:12s} dataset={tags.get('metric_dataset_name')} "
          f"digest={tags.get('metric_dataset_digest')}")
```

**预期输出(v3.17)**:每个 logged model 的聚合指标都带 `dataset=support_qa_v3` 与一个 sha 前缀的 digest。**在 v3.16 上这两个字段是 `null`** —— 指标卡片上写着分数,但「这个分数是在哪个数据集上跑的」只能靠人记。

**这个验证的工程价值**:digest 绑定是「评估可复现」的**必要**条件。当数据集从 v3 改到 v4(加了几条 corner case、改了一条标注),所有后续指标自动带新 digest,**指标与数据集版本的对应关系变成平台可查询的事实**。对一个要做「模型上线前验收」的团队,这一条直接决定了「上次那个 0.87 还作不作数」能不能被回答。

**诚实边界**:这条改动只覆盖**显式提供的管理评估数据集**(`EvaluationDataset`)。用普通 list / DataFrame 传 `data=` 的评估,**指标记录行为不变**,仍然没有数据集出处。所以这条能力是 opt-in 的:要用它,就得把评估数据集建成 managed dataset。

---

## §5 五套追踪评估方案十七维度对比

| 维度 | MLflow v3.17 | Langfuse 3.140 | Arize Phoenix 3.0 | Weights & Biases | Triton Inference Server |
|---|---|---|---|---|---|
| 定位 | 实验追踪 + 模型注册 + GenAI 评估,自托管为主 | LLM 可观测性 + 评估追踪,自托管优先 | LLM 可观测性 + 评估,自托管优先 | 实验追踪 + MLOps,SaaS 为主 | 推理服务 + Triton 评估,边缘部署 |
| 自定义评估代码执行模型 | **收进 job executor 子进程,服务端进程不执行** | 服务端不执行用户代码,评估在 SDK 侧 | OpenInference + Python SDK 本地执行 | wandb 表格在客户端执行 | 服务端只做推理,评估外部完成 |
| 子资源权限粒度 | **容器 + 9 个子资源类型 + DENY,子资源 wildcard-only** | 项目级 RBAC,组织 / 项目两层 | 项目级,无子资源 DENY | 实体级(项目 / 团队),无 DENY | 无内置 RBAC,靠 K8s | 
| LLM 判官的目的地控制 | **payload 里的 5 个目的地键任意深度被拒,走网关或环境变量** | 配置层,不在 payload 里 | 配置层 | 配置层 | N/A |
| artifact 目的地策略 | **匹配 default-artifact-root,或显式 allowlist scheme** | S3 / 本地,无主机策略层 | 本地 / 云存储,无主机策略 | 云存储,平台托管 | 本地 / S3 |
| 追踪数据集大规模分析 | **可选日级 SQL rollup + 原始查询兜底 + 1258 测试** | ClickHouse / Postgres 后端 | DuckDB / Postgres 后端 | 云端列式存储 | N/A |
| 小数 / 精度处理 | **Decimal 与 float 求和归一化(本版修复)** | ClickHouse 原生 Decimal | DuckDB 精度语义 | 云数据库精度语义 | N/A |
| 指标的数据集出处 | **管理数据集的 name + digest 绑定到聚合指标** | dataset 实体绑定 | dataset 实体绑定 | artifact 版本绑定 | N/A |
| 反序列化攻击面 | **自定义 scorer exec() 被位置约束隔离;第三方 scorer 模块精确匹配** | 不执行 payload 代码 | 不执行 payload 代码 | 不执行 payload 代码 | 不适用 |
| 数据库升级约束 | **schema 升级必须停所有写入者,混合版本滚动升级不支持** | ClickHouse 迁移有窗口 | DuckDB 无状态 | 平台托管,无感 | 无状态 |
| 托管模型成本追踪 | 客户端计算 LLM trace 成本(SageMaker 追踪) | token 与成本统计 | token 与成本统计 | token 与成本统计 | N/A |
| OTLP 摄取 | **暴露 OTLP ingestion metrics 给 Prometheus** | OTLP 原生 | OTLP via OTel Collector | OTel 集成 | N/A |
| 网关能力 | 内置 AI Gateway + guardrail(本版收紧自定义 scorer) | 无内置网关 | 无内置网关 | 无内置网关 | **本身就是网关** |
| 升级破坏性特征 | 运维约束 + guardrail 自定义 scorer 被拒 + DENY 解析 | 无破坏性 | 无破坏性 | 无破坏性 | 无破坏性 |
| 主语言 / 栈 | Python + FastAPI/Flask + SQLAlchemy | TypeScript + ClickHouse | Python + DuckDB | Python + Go 后端 | C++ + ONNX / TRT |
| 本次「验收」主题对齐度 | **评估执行隔离 + 数据集出处 = 平台化验收** | 追踪即验收记录 | 评估即验收工具 | 实验即验收台账 | 推理即验收对象 |

**关键对比判断**:MLflow 与 Langfuse / Phoenix 的根本差异不在功能清单,而在**评估代码在哪里执行**。Langfuse 与 Phoenix 都在 SDK 侧执行用户代码 —— 评估跑在用户自己的进程里,平台只收结果。MLflow 因为同时是**模型注册中心**和**评估平台**,它的 scorer 会被存进数据库、在共享服务上被反序列化、在 guardrail 里被加载,所以它**必须**做执行隔离。这不是 MLflow 更安全或更不安全,而是两种架构的不同代价:SDK 侧执行的代价是评估无法在平台上被复用与调度;平台侧执行的代价是必须解决「用户代码在共享服务上跑」的全部安全问题。**v3.17 付的是后者的工程账。**

---

## §6 六条六到十二月可验证硬指标

> 全部是「今天就能跑代码复现」的指标,不依赖路线图承诺。

**6.1 自定义 scorer 执行位置:服务端进程 exec 次数必须为 0。** 用 §4.1 的探针 scorer,在升级前后各跑一次 invoke。判据:探针日志里 `score() called` 且 `server=True` 的行数,v3.17 必须 = 0,v3.16 > 0。这是 RCE 隔离的直接量化。

**6.2 egress steering 拦截率:5 个目的地键 payload × 嵌套形式必须 100% 被拒。** 用 §4.2 的五个 payload,判据 = 被拒数 / 5。同时验证 `completion_kwargs` 与 `model_kwargs` 两种嵌套路径 —— 只堵顶层等于没堵。

**6.3 artifact SSRF 拦截:云元数据服务 URI + 端口归一化绕过 + 反斜杠 authority 三条路径必须全部被拒。** 用 §4.3 的 A/B/C。判据 = 被拒数 / 3。同时验证 D(标准 artifact 路径)必须成功 —— 只验证拒绝不验证「正常路径不受影响」,是收紧类改动的常见验证漏洞。

**6.4 DENY 解析正确性:`max_permission(DENY, READ)` 必须返回 `DENY`。** 用 §4.4 的 D。这条是 DENY 特性能否在你环境里生效的**唯一**判据 —— 返回 `READ` 意味着你配的每个否决都是无效配置,而且平台不会报错。

**6.5 追踪分析查询:大追踪数据集的聚合查询耗时下降。** 建一个 ≥ 50 万条 trace 的实验(持续 autolog 一周即可),对比开启 rollup 前后,「按天聚合的 trace 成本 / 延迟 / 判官通过率」三类查询的 P95。RFC-0006 的目标场景是**大追踪数据集**;小库上 rollup 的维护开销可能盖过收益,所以这个指标必须在数据量达标之后测。

**6.6 评估指标的数据集出处覆盖率:managed dataset 评估的指标,`metric_dataset_name` 非空率必须 = 100%。** 用 §4.5 反查。判据 = 非空指标数 / managed dataset 评估产生的指标总数。边界:普通 list / DataFrame 评估不受此覆盖,所以这个指标只在 managed dataset 路径上成立。

---

## §7 六条六到十二月可观察未来信号

**7.1 per-id 子资源 grant 是否随 #24964 落地。** 子资源 wildcard-only 的限制是被 search 语义锁住的 —— 它需要 request-level predicate push-down,才能让 per-id 子 grant 不退化成响应后行级过滤。#24964 合并后,`add_role_permission` 对子资源 per-id grant 的 400 应该变成接受。这是判断「子资源权限能否真正细到单条 trace」的信号。

**7.2 guardrail 自定义 scorer 的迁移窗口。** v3.17 拒绝自定义 scorer 当 guardrail,打中的是在生产里已经这么用的团队。观察 guardrail 的 ensemble 嵌套检查是否有迁移工具,以及 `make_judge` 创建的 judge 能否覆盖自定义 scorer 原来的场景。如果迁移成本持续高,会出现「升级被 guardrail 卡住」的僵局。

**7.3 OTLP ingestion metrics 进 Prometheus 后的采集率。** v3.17 暴露 OTLP 摄取指标(#25192),让「追踪服务自己收到了多少 OTLP 数据」第一次可被监控。观察生产上这个指标与客户端发送量的差值 —— 差值就是摄取丢失,这是追踪平台可观测性从「应用层」扩到「平台自身」的信号。

**7.4 trace 分析 rollup 在 MySQL / MSSQL 上的成熟度。** RFC-0006 的优化在 PostgreSQL 上最完整(精确商时间桶、索引时间戳 seek、span 代价分组合并)。观察 MySQL 与 MSSQL 上是否有等价的查询计划优化跟进,还是说它们只有「功能可用」而「性能优化未到位」。这决定了非 PG 用户能拿到多少 §6.5 的收益。

**7.5 自定义 scorer 的「非执行元数据」模式是否会扩散到别的反序列化路径。** v3.17 的做法是:服务端把 scorer 反序列化成**不执行的元数据**(带字段 + 序列化形式,运行抛异常),转发给 executor 执行。这是一个可复制的模式 —— 任何「用户代码需要被平台检查但不应被平台执行」的场景都能套。观察 MLflow 的 model flavor 加载路径是否也引入类似的进程上下文判定。

**7.6 DENY 的 `floor_positive_permission` 例外会不会被正式文档化。** 现在 DENY 的正确解析依赖一个对 `default_permission` 下限的**未文档化的第二个例外**。观察它是否进入权限模型的正式规范 —— 没进规范之前,任何重写权限解析的重构都可能把这个例外漏掉,让 DENY 静默失效。

---

## §8 最佳实践:✅ 该用 / ❌ 千万别用

**✅ 该用**

- **把评估数据集建成 managed dataset。** 这是 v3.17 里投入产出比最高的一条:零破坏性、纯增量,换回来的是指标的**出处**。GenAI 评估的指标会随数据集版本漂移,digest 绑定让「这个分数是在哪一版数据上跑的」变成平台可查询的事实。
- **升级走「停所有写入者 → 备份 → db upgrade → 重启」四步。** 即使不启用 daily rollups 也必须做 schema 升级,因为新列是 schema 变更。混合版本滚动升级**不支持** —— 把它当成一次需要申请窗口的运维事件。
- **DENY 配完后立刻跑 §4.4 的 D 验证。** 一个函数一行的解析例外,决定你配的否决是否真的生效。这是整个 RBAC 改动里唯一「配成功但可能行为为零」的地方。
- **判官的目的地只在服务端配置。** 需要 `gateway:/` 端点或 provider 环境变量,不要在 payload 里放 `api_base` —— 那是被拒绝的路径,也是 §4.2 测的攻击面。
- **用 `MLFLOW_ALLOWED_HOST_ADDRESSED_ARTIFACT_SCHEMES` 显式声明你需要的 scheme。** 默认空(除 default-artifact-root 外全拒)。标准部署看不到行为变化,但如果你用 `ftp` / `hdfs` / `abfss` 之类,需要显式放行。
- **子资源权限从 wildcard DENY 开始用,而不是一上来就想要 per-id。** 「这个 experiment 的 trace 一律不给某角色看」是 wildcard DENY 能覆盖的场景,而且它不需要等 #24964。

**❌ 千万别用**

- **不要把自定义 scorer 用作网关 guardrail。** v3.17 在创建时和加载时都拒绝,而且会看进 ensemble 内部。已经这么用的 guardrail 必须迁移到内置 scorer 或 `make_judge` 创建的 judge。
- **不要在 `third_party_scorer_data.kwargs` 里放任何目的地键。** `api_base` / `base_url` / `model_list` / `fallbacks` / `custom_llm_provider`,任意嵌套深度都会被拒。这不是「最好别放」,是「会被 400」。
- **不要按「minor 版本随便升」的肌肉记忆做滚动升级。** 这一版的 schema 变更要求停所有写入者。滚动升级会在新 replica 起来时撞上 schema 不一致。
- **不要假设 per-id 子资源 grant 只是「还没实现」。** 它返回 400 是被 search 语义锁住的设计约束,不是待办。需要 per-id 粒度的授权设计要绕开它,或等 #24964。
- **不要在升级后只验证「功能还能用」。** 收紧类改动的验证必须**双向**:拒绝路径必须拒绝(§4.2 / §4.3 的 A/B/C),正常路径必须不受影响(§4.3 的 D)。只验证后者等于没验证。
- **不要在无 host 的 `ftp://` / `sftp://` / `hdfs://` URI 上以为是安全的。** 它们连 localhost 或 Hadoop 默认地址,在 v3.17 里同样算 host-addressed,需要匹配 default-artifact-root 或显式 allowlist。

---

## §9 五步生产升级 checklist

**第 1 步:升级前审计(不停服)**

- 跑 `grep -r "artifact_location=" .` 与注册表里的 model version source,列出所有非 `default-artifact-root` 的 URI。这一步先告诉你 §4.3 的 D 有多干净 —— 如果有大量 `ftp://` / `hdfs://` 历史位置,升级后它们会被拒绝。
- 列出所有第三方 scorer 的 `kwargs`,检查是否含目的地键。有的话先迁到服务端配置,否则升级后这些 scorer 注册会开始 400。
- 统计 guardrail 里用了自定义 scorer 的数量。这是迁移工作量,也是升级的最大卡点。

**第 2 步:申请升级窗口**

- schema 升级要求**停掉所有写入者**。确认有哪些客户端在持续写入(autolog 的训练任务、在线评估服务、网关),逐个安排暂停。
- **混合版本滚动升级不支持** —— 这是一个全停窗口,不是灰度窗口。把它写进变更评审,不要试图绕过。

**第 3 步:备份 + db upgrade**

```bash
# 备份(SQL backend,可恢复是硬要求)
pg_dump -h localhost -U mlflow -F c -f /tmp/mlflow_pre_317.dump mlflow

# 停掉所有写入者之后
export MLFLOW_TRACKING_USERNAME=admin MLFLOW_TRACKING_PASSWORD='...'
mlflow db upgrade postgresql://mlflow:pwd@localhost:5432/mlflow

# 大库的 trace 分析 backfill 是可恢复的,可以单独跑
# mlflow ... prepopulation 命令支持断点续跑,见 RFC-0006 文档
```

**第 4 步:重启 + 双向验证**

- 重启所有 replica(必须是同一版本)。
- 跑 §4.1(执行隔离)、§4.2(egress)、§4.3(artifact 策略,含 D 正常路径)、§4.4(DENY 解析)四组验证。
- **DENY 解析验证(§4.4 D)放在第一位** —— 它决定你后续所有权限配置是否有效。

**第 5 步:启用 rollup(可选,数据量达标后)**

- 先确认 trace 数据量足够大(≥ 50 万条量级);小库上 rollup 维护开销可能盖过收益。
- 开启后观察 §6.5 的 P95 查询耗时,以及 rollup 维护任务本身的数据库负载。
- 记住**原始查询兜底**始终可用 —— rollup 结果与原始分析查询保证一致,这是 RFC-0006 的明确约束,不是尽力而为。

---

## §10 最安静的破坏性变更:为什么本版最危险的三处都不报错

把这三处单独列出来,因为它们是升级评审里最容易被漏掉的那类:**配置成功、不报错、行为静默改变**。

**第一处:混合版本滚动升级。** 它不是代码层面的破坏,是**运维约束**。不报错,不出现在 breaking changes 列表,出现在 release notes 一个单独成段的段落里。任何按惯例做灰度升级的团队,会在新 replica 起来时撞上 schema 不一致 —— 而这时候旧 replica 还在写,数据可能已经不一致了。

**第二处:DENY 被 default_permission 静默抬回。** `max_permission("DENY", "READ")` 按 master 的折叠规则返回 `READ`。也就是说,如果你拿到了一个没有 `floor_positive_permission` 修复的版本(或未来某次重构漏掉了这个例外),你配的**每一个 DENY 都是无效配置** —— 平台接受它、存储它、然后在解析时把它抬回默认权限。UI 上显示「已配置否决」,实际行为是「没有否决」。

**第三处:guardrail 自定义 scorer 被拒。** 这是本版唯一有明确破坏性的功能变更,但它的破坏方式也很安静:**已经存在的** guardrail 在加载时被拒绝。不是升级时弹一个迁移向导,是 guardrail 加载失败。如果网关的失败语义是 fail-open(放行请求),那这个「安全收紧」反而先造成了保护缺口。

**方法论**:这三处的共同特征是 —— **「配置面」与「行为面」之间出现了一层翻译,而这一层不报错**。升级评审里,凡是看到「新增权限类型 + 新增解析规则」的改动,就要问「解析的正确性能不能被独立验证」;凡是看到「schema 变更 + 运维约束」的改动,就要问「混合版本会不会静默地写坏数据」;凡是看到「收紧某种用法」的改动,就要问「被拒绝的那条路径的失败语义是 fail-open 还是 fail-closed」。**§6.4 的单行验证(DENY 解析)就是对付第二处的最低成本手段 —— 一行代码,测出一个可能让你的整个权限配置失效的回归。**

---

## §11 三个长期判断

**判断一:评估平台的竞争维度从「能算什么分」转向「分数能不能被信任」。**
MLflow v3.17 的十四条 GHSA 与五个 Major Feature 里,安全收紧与可对账占了大头,新判官能力(Jev / TypeSafe)只占一条。这个比例不是偶然 —— 当所有追踪平台都能算 NDCG、都能跑 LLM-as-a-judge 之后,「这个分数是在哪个数据集上、由哪个判官、在哪个进程里、连的哪个端点算出来的」就成了真正的差异点。**判官的可信度 = 评估平台的品牌**,而可信度是靠执行隔离 + 目的地控制 + 数据集出处这三条工程能力堆出来的,不是靠 prompt 工程堆出来的。十二个月内,自托管追踪平台的采购评审会开始把「评估代码执行隔离」当成必答项,就像五年前把「artifact 加密」当成必答项一样。

**判断二:自定义代码在共享平台上的执行问题,位置约束会胜过内容审查。**
v3.17 没有试图判断「这段 scorer 代码安不安全」—— 那是不可判定的。它做的是**位置约束**:服务端进程的重建函数结构上不可能执行用户代码,执行只能发生在平台指定的子进程里。这是把不可判定的安全问题降解成可工程的架构约束,与容器沙箱、Cilium 网络策略、数据库的 SET ROLE 是同一个家族的思路:**不要审查内容,要约束位置**。十二到十八个月,这个模式会从「追踪平台」扩散到所有「需要执行用户定义逻辑」的共享平台 —— CI runner、notebook 服务、流处理 UDF、AI 网关的 guardrail —— 因为它们面对的是同一个不可判定问题。判断信号:哪个平台先把这个约束写成默认而非选项,它就先拿到多租户的信任。

**判断三:实验追踪平台的下一次分化点是「评估的运维成本」。**
§3.5 的数据库升级约束(停所有写入者、不支持混合版本滚动升级)揭示了一个被低估的事实:**追踪平台正在变成它所服务的那种系统** —— 一个有状态、需要 schema 迁移、需要升级窗口的核心基础设施。它不再是「跑个脚本记个数」的辅助工具。这意味着选型时要问的问题变了:不是「支持哪些判官」,而是「升级一次要停多久」「schema 变更能不能在线做」「追踪数据的查询会不会拖垮主库」。RFC-0006 的 rollup 把「大追踪数据集的查询」从「忍着」变成「可计算」,但代价是一次全停升级 —— 这是**可计算性与运维成本之间的一次显式交易**。未来能赢的平台,是把这笔交易做得最便宜的那个:在线 schema 变更、rollup 增量构建、滚动升级兼容。这个方向上的工程差距,会比判官能力的差距更决定成败。

---

## 写在最后

MLflow v3.17 的五个 Major Feature 里,真正承重的是那些**不增加新能力、只是让既有能力变得可被信任**的部分。十四条 GHSA、九个子资源权限类型、一个 DENY 优先级、一个 artifact 主机策略、一个执行隔离区 —— 它们合起来讲了一件事:**一个评估平台,如果它的执行环境、数据流向、权限边界不能被平台自己断言,那它产出的分数就只是一个数字。**

早间的「五维验收日」在五个栈层要求「交付前先验收」;本文是这条主线在工程层的落地 —— **而验收工具自己,必须先通过验收。** MLflow v3.17 就是这个平台在给自己做的那次验收:十四个安全洞被逐一封掉、四个隐含授权被改写成显式契约、权限模型从容器下沉到子资源、追踪账本从「查不动」变成「可计算」。它不酷,但它是这类平台能被放进关键路径的前提。

对于正在用 MLflow 自托管的团队,本文的建议浓缩成一句:**先跑 §4.4 的 D 那一行,再安排升级窗口。** 前者花三十秒告诉你配的权限是否真的生效,后者决定了这次升级会不会静默地写坏你的数据库。而 §6 的六条硬指标,就是升级评审里可以直接贴进去的验收标准 —— 「验收」这件事,从今天起是可量化的了。
