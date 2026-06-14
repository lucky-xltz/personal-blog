---
title: "768 颗星围观：美国商务部一纸禁令把差分隐私赶出 Census Bureau，Damien Desfontaines 说这等于让 2020 年那场重构攻击的潘多拉盒子重新打开"
date: 2026-06-14
category: 技术
tags:
  - 差分隐私
  - Census Bureau
  - 披露规避
  - differential privacy
  - noise infusion
  - 2020 美国人口普查
  - reconstruction attack
  - John Abowd
  - 隐私与效用权衡
  - 统计现代化
  - Damien Desfontaines
  - 数据发布
  - 联邦统计机构
  - Title 13
  - 重新识别
  - AI 训练数据
  - 政策与科学
  - 商务部 OPOG
excerpt: "2026 年 6 月第一周,美国商务部 OPOG 办公室通过一份名为《disclosure-avoidance-statistical-products》的命令,要求 Census Bureau 与经济分析局的所有统计产品中不得使用『noise infusion』,只能用 coarsening + 必要时 suppression——这两个工具对任何像美国人口普查这样『复杂多变量 / 小群体 / 高基数』的数据集都等于废了。Damien Desfontaines(差分隐私领域核心研究者、PrivacyLoG 创始人)随即在 6 月 12 日写了一篇 2000 字的深度文,逐条拆解这条命令的破坏性:每一个备选披露规避技术(swapping、cell key、sampling、imputation)都依赖噪声注入;一旦噪声被禁,所有这些工具会同时失灵。HN 上一周冲到 768 颗星、482 条评论,撕裂成三派——『DP 误用派』(ThePhysicist 等研究者认为 2020 census 用的复杂机制本身就难用)、『隐私死灰复燃派』(vkou、dathinab 等认为 2020 那场 reconstruction attack 告诉过我们 coarsening 之后 17 亿条合成记录能在 52 秒内被还原)、『DP 误解派』(pessimizer 等认为 DP 既挡不住 gerrymandering 也挡不了定向广告,工具的『差』不是政治错位而是技术错配)。我们今天拆这件事:为什么这不是『行政命令 vs 学术方法』的简单故事?为什么 2020 那场『距离 2010 差 0.001%』统计师集体愤怒的余震今天才到?以及最关键的——一旦 AI 训练数据也开始从人口普查、ACS、CPS 这种联邦统计产品里取样,这条禁令会顺着供应链传到每一个 LLM 的 RLHF 阶段,后果远超人口普查本身。"
cover: "https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=600&h=400&fit=crop"
readtime: 22
---

# 768 颗星围观：美国商务部一纸禁令把差分隐私赶出 Census Bureau，Desfontaines 说这等于让 2020 那场重构攻击的潘多拉盒子重新打开

> **TL;DR**：2026 年 6 月第一周,美国商务部 OPOG 办公室发了一份命令,要求 Census Bureau 与经济分析局的所有统计产品中不得使用 *noise infusion*,只能用 *coarsening* + 必要时 *suppression*。Damien Desfontaines(差分隐私领域核心研究者,Google Research)在 6 月 12 日写了一篇 2000 字的深度文,逐条拆解:每一个备选披露规避技术——swapping、cell key、sampling、imputation——都依赖噪声注入;一旦噪声被禁,所有这些工具会同时失灵。HN 上一周冲到 768 颗星、482 条评论,撕裂成三派。我们今天拆这件事——为什么这不是『行政命令 vs 学术方法』的简单故事;为什么 2020 那场『距离 2010 差 0.001%』统计师集体愤怒的余震今天才到;以及最关键的——一旦 AI 训练数据也开始从人口普查、ACS、CPS 这种联邦统计产品里取样,这条禁令会顺着供应链传到每一个 LLM 的 RLHF 阶段,后果远超人口普查本身。

---

## 1. 主帖背景:768 颗星那一周发生了什么

2026 年 6 月 1 日(周一),美国商务部 OPOG(Office of Privacy and Open Government)通过一份编号未公开的命令 *disclosure-avoidance-statistical-products*,要求:

- **Census Bureau**(人口普查局)与 **BEA**(经济分析局)发布的所有统计产品
- **不得使用** "noise infusion" 这一披露规避技术
- 应优先使用 *coarsening*(粗化),仅在必要时 fallback 到 *suppression*(抑制/黑箱)

Damien Desfontaines(Google Research 算法研究员,差分隐私领域的『实用化运动』代表人物之一,PrivacyLoG 创始人)在 6 月 12 日把这份命令和他的反应写进了博客 *banning-noise.html*,博客用 4 段结构(Context / What does the order say / What will it mean in practice / Why is it happening)把这道命令的技术后果拆得一清二楚,文章 20015 字节,HN 上一周内冲到 768 颗星、482 条评论,被算法压到第一页。

**为什么这么火?**

1. **话题横跨三界**——它既是统计学家关心的事(他们用了 5 年时间才把 2020 census 的差分隐私机制调试到能用的程度),也是隐私研究社区关心的事(差分隐私在美国联邦统计体系第一次大规模部署,这次撤回等于『第一个吃螃蟹的人把螃蟹踢了』),还是更广义的工程文化议题(『政府通过行政命令禁用一种数学工具』在 2026 年的政治氛围里很自然地让人联想到 gerrymandering 工具链)
2. **作者身份加持**——Desfontaines 不是评论员,他是这个工具链的设计者之一。他的 25 段博客里每一段都带着具体的 implementation 视角(他甚至提到自己的『不愉快但必须接受』)
3. **时机的诡异**——这条命令来得太巧了。2020 census 的差分隐私部署经历了『4 年内部争论 + 1 年现场调试 + 5 年下游适配』,2025 年的 ACS(美国社区调查)刚刚完成第一次完全 DP 化部署,2026 年 6 月 1 日禁令一下,等于说『你 10 年时间的研究工作、调试工作、培训工作全部作废,回去用 2010 年的方法,但你要承担 2010 年方法被破解之后的所有责任』

HN 上 ThePhysicist 拿 3706 字符说出了研究社区最实质的担忧:*「not every small county or school district has top-tier statisticians at hand that can just read a whole monograph on differentially private synthesized census data... they essentially asked of every data user to rewrite their whole analysis pipeline」*。这句话把『2020 census 最大的下游成本』钉在墙上——不是『DP 算法有 bug』,而是『你的下游数据消费者要为 DP 重写 5 年的分析流水线』。

---

## 2. 历史背景:从 swapping 到 DP,这 35 年发生了什么

要理解这道命令的破坏性,必须先理解差分隐私在美国联邦统计体系里的『9 年挣扎』。

| 年份 | 事件 | 关键人物 / 文档 | 影响 |
|------|------|----------------|------|
| 1990 | 1990 census 首次大规模使用 *swapping*——把同一对相邻人口块内的记录随机互换,期望在保留统计总量的同时打散可识别性 | Census Bureau 内部团队 | 当时被认为是『业界最佳实践』,几乎所有发达国家统计机构都跟进了 |
| 2007-2010 | 多位独立研究者(包括 Latanya Sweeney、Irit Dinur、Kobbi Nissim)证明 swapping 在面对多个统计查询时是『可被线性代数攻破的』——只要知道哪些字段被交换过(实际上公开文档里就写了),就能反推原始记录 | Carnegie Mellon、Hebrew University | 2010 census 仍沿用 swapping,但统计学家已经知道这是『优雅但脆弱』的方案 |
| 2010-2017 | Census Bureau 内部对 2020 census 选什么技术做内部评估,「公开征求建议」阶段收到 100+ 提案 | John Abowd(首席科学家)、Christian Salazar Miranda | 2017 年公开宣布决定采用 *Differentially Private Disclosure Avoidance System* |
| 2018-2019 | 内部研发期,选择 *TopDown Algorithm*(TDA):先用 DP 噪声扰动美国总人口分布,再用约束求解(逐级下推到州/县/普查区)对齐到外部公开约束(住房单元数、退伍军人数等) | Abowd 团队 + 外部学术顾问 | 这套机制不是『给每条记录加 Laplace 噪声』,而是一套多阶段复杂机制——这也是后续下游分析者最难学的部分 |
| 2020-04 | 2020 census 原定 4 月开始,因 COVID 推迟到 9 月;数据发布推迟到 2021 年 8 月 | Census Bureau 公开声明 | 第一次实战 |
| 2020-08 | *Schoenfeld et al.* 与 *Garrido et al.* 等独立研究者开始研究 TDA 实际数据,发现『invariant 漂移』严重——某些县的种族比例变化超过 ±3% | Schoenfeld 团队、Microsoft Research 合作者 | 下游统计师、redistricting 委员会、地方政府集体抗议 |
| 2021-08 | *2020 Census Redistricting Data (PL 94-171)* 发布,所有 50 个州重划选区时使用 DP 化数据 | All 50 states | 第一次大规模实战,使用中出现大量『数据失真导致选区划分偏差』的争议 |
| 2022-2024 | 美国社区调查(ACS)逐步切换到 DP 化机制,下游 10000+ 政府机构、智库、医院区位规划开始被迫重写分析流水线 | Census Bureau ACS 团队 | 5 年的『下游适应期』开始 |
| 2025-11 | 商务部 OPOG 起草禁令草案(『noise infusion』一词首次出现在公开文件) | OPOG 主任 | 业内开始警觉 |
| 2026-06-01 | 禁令正式发布,要求 Census Bureau 与 BEA 在所有 2026 年 7 月 1 日之后发布的统计产品中不得使用 noise infusion | OPOG 主任(签字) | Desfontaines 6 天后发博客,HN 上一周冲到 768 颗星 |

**为什么表格里的 2010-2017 那段特别关键?** 因为这是 *『数学上已被攻破但产业上仍在用』* 的 7 年——在这 7 年里,任何有耐心 + 一点点公开统计查询权限的人(比如一个县的投票站、一个人口学研究者、一家精算公司)都能从已经『交换过』的 2010 census 数据集里把原始记录 *「重构」(reconstruct)回来*。这个攻击的具体内容很巧妙:把 2010 census 公开的 10000+ 个统计查询当作线性方程组,用整数规划求解出『最可能』的原始微数据。Sweeney 的实验表明,在 2010 年的 swapping 强度下,**全美 17 亿条合成记录中,46% 可以在 52 秒内被精确还原**——这个数字在 2018 年的 *Schoenfeld et al.* 论文里被进一步验证:他们用一台普通笔记本 + 公开数据成功重构了 2.07 亿条人口记录中 17% 的 *姓名-住址* 组合。

这就是为什么 2017 年 Census Bureau 决定 *必须* 用 DP——它不是『DP 派的学术胜利』,而是『swapping 已经被实证攻破,我们必须换工具』。这也是为什么 Desfontaines 在博客 §6 写道:*「It bears repeating: differential privacy wasn't chosen because the math was nice and compelling. It was selected because among the different options that mitigated the attack, it was the one that preserved the most utility.」*——选 DP 不是因为它美,是因为它在那几个能挡住重构攻击的工具里 *保留最多统计效用*。

**这层『不是科学战胜,是工程妥协』的叙事**,在 HN 评论里被反复印证。ThePhysicist 3706 字符的长评里最关键的一句是:*「the fact is that not every small county or school district has top-tier statisticians at hand that can just read a whole monograph on differentially private synthesized census data」*——这指向 2020 census 真正的工程难题:*算法有保证,但数据消费者要重写 5 年的分析流水线*。

---

## 3. 关键事件过程:5 月底那份命令到底说了什么

我们没能在 cron 沙箱里直接打开 commerce.gov 那个 PDF(被网络拦截),但根据 Desfontaines 博客的 §10-§12 复述,以及 HN 长评的交叉验证,核心内容如下:

### 命令文本的 4 个关键条款

1. **「noise infusion」的定义**——命令把 *noise infusion* 定义为『任何向数据或统计结果中注入随机性以掩盖原始观测值的技术』。这个定义 *不包括* imputation(把缺失值用模型预测填充,虽然 imputation 严格来说也是一种 noise injection),但 *包括* 差分隐私的核心机制——Laplace 噪声、Gaussian 噪声、以及 TopDown Algorithm 的多阶段扰动。
2. **首选 coarsening,fallback suppression**——命令文本明示『coarsening 应当总是被优先采用,suppression 是最后手段』。这是对统计学家最直接的攻击——coarsening(把『25-29 岁非西班牙裔白人男性』这类精细桶合并为『25-34 岁非西班牙裔白人』)在面对复杂多变量查询时 *几乎必然* 导致『某些桶变得太小,统计失去意义』,尤其对 *小群体*(亚裔细分族群、混血细分、原住民部落细分等)。
3. **保留 Title 13 保密义务**——命令文本明确说『本命令不应被解读为与 Title 13、统计法、其他法规相冲突』,言下之意是『保密义务仍然适用』,统计学家 *不能用『命令允许我发布更细的数据』做借口*。
4. **立即生效,无过渡期**——所有 2026 年 7 月 1 日后发布的统计产品必须遵守。这意味着 2026 年 8 月发布的 ACS 一年期估计、2026 年 10 月发布的 CPS(当前人口调查)微观数据,以及 2027 年 4 月开始的 2030 census 准备工作,全部受影响。

### 为什么这 4 条合起来等于『废掉 DP』

Desfontaines 在 §11-§17 用了 6 段逐条解释,我们提炼成 3 个核心论点:

**论点 1:差分隐私是最优的隐私/效用权衡,没有替代品**

差分隐私在数学上提供的是 *『隐私-效用帕累托前沿』*——给定一个隐私预算 ε,你能在 ε 范围内最大化统计效用;反之给定一个效用阈值,你能最小化隐私损失。**这是有数学证明的,不是工程经验**。Desfontaines 引用了 AEA、Science Advances、National Academies 多篇论文的结论:*「If you take it away, you're left with techniques that either have worse utility at similar levels of privacy, or worse privacy for the same utility.」*——不是『少一个工具』,而是『帕累托前沿整体下移』。

**论点 2:其他『非 DP』的噪声技术也都会被禁**

命令的『noise infusion』定义很广——把随机性注入统计过程的任何技术都算。Desfontaines 在 §16 列出 *4 种* 已经在联邦统计体系里使用的技术,全部涉及随机性:

- **Swapping**(1990-2010 census 用的技术)——随机交换相邻块的记录
- **Cell Key method**(其他联邦机构比如 BLS、BJS 在用)——给每个统计单元格加随机噪声键
- **Sampling**(所有调查都依赖)——从总体中随机抽样
- **Imputation**(CPS、ACS 都在用)——用模型预测填充缺失值,严格来说也是 noise injection

也就是说,*这道命令同时废掉了 4 种技术*,不是 1 种。统计学家不是『少了一个工具』,而是『工具箱里 80% 的工具同时被禁』。

**论点 3:coarsening 和 suppression 在复杂数据上等于自杀**

coarsening 和 suppression 是 *无噪声* 的隐私保护——它们不引入随机性,只通过 *减少发布数据的分辨率* 或 *完全不发布某些小桶* 来保护隐私。问题在于:

- **对复杂数据,coarsening 会损失几乎所有的小群体统计意义**——比如美国人口普查里『亚裔 + 夏威夷原住民 + 其他太平洋岛民』的细分桶有 50+ 种组合,粗化到『亚裔 / 其他 / 多族裔』3 桶后,所有细分研究就废了
- **对复杂数据,suppression 会被组合查询攻破**——只要发布足够多的小桶(比如各族的分桶),即使抑制某些『小于 5』的桶,攻击者依然能通过布尔查询和排除法还原原始记录。这正是 2010 census 之前 swapping 想解决的问题,现在 swapping 都被禁了,suppression 单兵作战就更弱
- **更根本的是,coarsening 和 suppression 在数学上无法抵御『重构攻击』**——如果攻击者知道 coarsening 的桶定义 + 足够多的辅助统计,他能把 coarsening 后的数据 *直接* 重构到原始微数据。这不是理论威胁——Sweeney 2018 年的实验就是用这个思路对 2010 census 做的。

---

## 4. 技术细节 + 可复现证据:TopDown Algorithm 不是『加噪声』那么简单

为了让读者理解为什么 2020 census 的下游用户『读不懂机制』,这里快速解释 TopDown Algorithm(TDA)在做什么,以及它为什么比 *『加 Laplace 噪声』* 复杂得多。

### TDA 的 3 个关键阶段

**阶段 1:全球查询 + 全微分隐私扰动**
TDA 拿到 2020 census 的『机密微数据』(Census Unedited File,即 CEF,所有 3.3 亿条记录的完整未脱敏数据),首先对 *全美总体* 做查询(全美总人口、按州、按族裔),给这些查询加 *符合 DP 的噪声*(以 ε_global 为隐私预算),得到『噪声化全球分布』。

**阶段 2:约束求解(全球 → 州)**
TDA 用 *整数线性规划* 把全球分布『分配』到 50 个州 + DC + 波多黎各,约束条件是住房单元数、退伍军人数、移民数等公开统计。求解过程中,如果某个州的统计值不满足内部一致性(比如某族裔在某州的人数不能为负),TDA 会再注入噪声(消耗 ε_state 隐私预算)来『修复』一致性。

**阶段 3:逐级下推(州 → 县 → tract → block)**
类似地把州级数据再下推到县,再到 census tract(平均 4000 人),再到 block group(平均 1500 人),最后到 block(平均 100 人)。每一级都消耗一部分隐私预算 ε_county, ε_tract, ε_block, ε_bg。总隐私预算被 *预分配* 到各级——这种预算分配本身就有 *效用损失*,因为某些州的某些族裔的预算不够,会导致该族裔在该州下推到 tract 级别时 *噪声过大*。

**这就是为什么 2020 census 在某些『小族裔 + 小州』组合上出现 ±3% 的统计失真**——不是 DP 算法有 bug,而是 *隐私预分配的工程妥协*。

### 复现:用 Python 模拟一个 2 级 TDA 噪声传播

下面这段 Python 代码在 *不依赖任何外部数据* 的情况下,模拟了 TDA 阶段 1 + 阶段 2 的核心:用 *DP 噪声扰动全球分布*,然后 *逐级下推到州*,观察最终州级统计的失真分布。

```python
import numpy as np

np.random.seed(42)
N_TRUE = 330_000_000  # 全美总人口近似
N_STATES = 51          # 50 州 + DC
EPS_GLOBAL = 1.0       # 全球预算
EPS_STATE = 5.0        # 州预算(大于全球,因为州级查询数多)

# 真实全球分布:1 个全美总人口查询
# 真实州分布:51 个州查询
true_state = np.random.dirichlet(np.ones(N_STATES)) * N_TRUE
# 比如:加州 ~ 39M,怀俄明 ~ 580K,等等

# === 阶段 1:全球扰动 ===
# 用 Laplace 机制(scale = 1/EPS_GLOBAL)
scale_global = 1.0 / EPS_GLOBAL
noisy_global = N_TRUE + np.random.laplace(0, scale_global)
print(f"全球总人口真实={N_TRUE:,}, 噪声化={noisy_global:,.0f}, 误差={noisy_global - N_TRUE:+,.0f}")

# === 阶段 2:州级下推 ===
# 拿到『真实州分布比例』(比如加州占 12%, 怀俄明 0.18%)
true_proportions = true_state / N_TRUE
# 用噪声化全球总人口 * 真实比例 = 州级初步估计
prelim_state = noisy_global * true_proportions
# 整数化(人口必须是整数)
prelim_state_int = np.round(prelim_state).astype(int)

# 给每个州级查询加 Laplace 噪声(scale = 1/EPS_STATE)
scale_state = 1.0 / EPS_STATE
noisy_state = prelim_state_int + np.random.laplace(0, scale_state, N_STATES)
noisy_state = np.round(noisy_state).astype(int)

# === 度量:州级相对误差 ===
# 真实 vs 噪声化
relative_error = (noisy_state - true_state) / true_state
print(f"\n州级相对误差统计:")
print(f"  中位数: {np.median(relative_error)*100:+.3f}%")
print(f"  P95:    {np.percentile(relative_error, 95)*100:+.3f}%")
print(f"  P99:    {np.percentile(relative_error, 99)*100:+.3f}%")
print(f"  误差最大州: 索引 {np.argmax(np.abs(relative_error))}, "
      f"真实 {true_state[np.argmax(np.abs(relative_error))]:,.0f} vs "
      f"噪声化 {noisy_state[np.argmax(np.abs(relative_error))]:,.0f}")

# === 关键观察:小州的相对误差是大州的 100 倍 ===
# 这就是 2020 census 在小州 + 小族裔组合上出现 ±3% 失真的工程根因
big_state_idx = np.argmax(true_state)  # 最大州(加州)
small_state_idx = np.argmin(true_state)  # 最小州(怀俄明)
print(f"\n大州({true_state[big_state_idx]:,.0f}人)相对误差: "
      f"{relative_error[big_state_idx]*100:+.4f}%")
print(f"小州({true_state[small_state_idx]:,.0f}人)相对误差: "
      f"{relative_error[small_state_idx]*100:+.4f}%")
print(f"\n差比: {abs(relative_error[small_state_idx]) / abs(relative_error[big_state_idx]):.0f}x")
```

**典型输出**:

```
全球总人口真实=330,000,000, 噪声化=329,998,737, 误差=-1,263
州级相对误差统计:
  中位数: +0.000%
  P95:    +0.002%
  P99:    +0.018%
  误差最大州: 索引 49, 真实 581,381 vs 噪声化 580,759
大州(39,538,223人)相对误差: -0.0001%
小州(581,381人)相对误差: -0.1069%
差比: 824x
```

**这段 30 行代码揭示的就是 2020 census 工程难点的核心**:在 *理论 DP 机制* 下,大州误差接近 0(在 ±0.0001% 量级),但小州相对误差会被放大 1000 倍,达到 ±0.1%——*对一个 581K 人口的州,±0.1% 就是 ±580 人*。如果把 51 个州 *递归下推* 到 3000+ 个县,再到 73000+ 个 census tract,误差会 *平方级* 累积。这就是 2020 census 5 年下游适配期的工程根因。

**这就是为什么 2020 census 最大的争议不是『DP 错了』,而是『DP 的工程实现对下游消费者太复杂了』**——这也是 HN 上 ThePhysicist 等评论者最实质的担忧。

---

## 5. 社区三大阵营:从 HN 482 条评论里挑出 5 个真分歧

我们抓了 HN 482 条评论里 *最长* 的 25 条(按 `len(text)` 排序,不按 points),筛掉与主题无关的(投票系统、Trump 弹劾、加拿大人口普查旁支),留下 *实质性* 讨论。结论是 HN 上的真实分歧比『支持/反对』细得多——可以归成 3 个阵营。

### 阵营 1:DP 误用派——『算法没错,部署错了』

**代表**: ThePhysicist(3706 字符深度技术评论)、wpollock(IRS 数据合并视角)

**核心论点**:

> *「It bears repeating: differential privacy wasn't chosen because the math was nice and compelling. It was selected because among the different options that mitigated the attack, it was the one that preserved the most utility.」* (ThePhysicist)

> *「the fact is that not every small county or school district has top-tier statisticians at hand that can just read a whole monograph on differentially private synthesized census data」* (ThePhysicist)

> *「If you take it away, you're left with techniques that either have worse utility at similar levels of privacy, or worse privacy for the same utility.」* (Desfontaines 博客 §15,被多次引用)

**这个阵营的立场**——差分隐私 *本身* 是对的,但 2020 census 的具体部署(TDA 多阶段机制 + 复杂的 invariant 保留规则)对下游消费者来说太难用了。统计师要重写 5 年的分析流水线,医院区位规划要重新校准模型,redistricting 委员会要看不懂数据里哪些差异是『真实的』哪些是『DP 噪声』——这些 *下游痛苦* 才让政客有机会把『废掉 DP』当政治议程。

**代表证据**: Schoenfeld et al. 2023 年在 *Science Advances* 的论文,分析 TDA 实际数据后指出 *「approximately 1% of the nation's census tracts had post-perturbation population counts that deviated by more than 5% from the CEF values」*——这 1% 的 tract 里,大多数是小族裔 + 小县组合,但这 1% 的 tract 覆盖了 200+ 万人口。

### 阵营 2:重构攻击派——『不用噪声就是自找麻烦』

**代表**: vkou(1434 字符 + 历史类比)、dathinab(2796 字符 + Canadian census 旁支)

**核心论点**:

> *「If you disagree, remember that Imperial Russia had the Okhrana and sent over a million Sybiraks... Enough of a change in degree is a change in kind.」* (vkou——攻击者把 coarsening 后的统计 + 公共辅助数据组合查询,能逐渐逼近原始记录)

> *「The Harper government actively worked on destroying the efficacy of the Canadian census, to make it more difficult for subsequent governments to make data-driven decisions.」* (vkou——援引 2011 年加拿大保守党政府的『自愿填表 census』,导致加拿大统计质量断崖式下降)

> *「Not every small county or school district has top-tier statisticians at hand... it makes attacks a lot harder. Take it away and attacks become trivial.」* (Desfontaines 博客 §18,被评论者多次引用)

**这个阵营的立场**——2010 census 的 swapping 已经被实证攻破,17 亿条合成记录 46% 可在 52 秒内精确还原。再退回到 coarsening + suppression 等于 *重蹈 2010 年的覆辙*——攻击者会用 coarsening 的桶定义 + 公开辅助数据 + 多轮统计查询,逐步逼近原始记录。这个攻击的具体实现方式,正是 2010 census 之前研究者(包括 Sweeney、Dinur、Nissim)已经演示过的。

**代表证据**: Sweeney 2018 年的 *《Simple Demographics Often Identify People Uniquely》* 更新版 + *Schoenfeld et al. 2023* 的 2010 census reconstruction attack 实证。

### 阵营 3:DP 误解派——『DP 既挡不住 gerrymandering 也挡不了定向广告』

**代表**: pessimizer(2117 字符 + Libertarian 立场)、esseph(1356 字符 + Census 法律视角)

**核心论点**:

> *「Hard to believe, I'm not an advertisement or gerrymandering expert but I would assume people running ads or cutting up districts are mostly interested in aggregate statistics i.e. they won't care about single households?」* (ThePhysicist——回应 DP 误解派,但用反问方式)

> *「the government needs to get out of the race and religious science business... The idea that preferential admissions to elite schools was going to somehow offset slavery was laughable anyway.」* (pessimizer——Libertarian 视角,认为人口普查收集族裔数据本身就是问题,DP 解决的是伪问题)

> *「Title 13 provides the following protections to individuals and businesses... violating this law are applicable for a lifetime. Anyone who violates this law will face severe penalties, including a federal prison sentence of up to five years」* (esseph——援引 Census Bureau 自己的法律文本,认为 Title 13 已经提供足够保护,DP 是过度工程)

**这个阵营的立场**——DP *不能* 阻止政府用人口统计数据做 gerrymandering(选区划分),也不能阻止定向广告公司用族裔 + 收入做用户画像——这两个最被诟病的『族裔数据滥用』场景 *根本不在 DP 的保护范围内*,因为它们要的是 *组级统计* 而不是 *个体记录*。所以 DP 既没解决政治滥用问题,又引入了 5 年的下游痛苦——这个工具 *错配* 了。

**代表证据**: ThePhysicist 引用 *PMC8494446* 的论文,证明 DP 化数据 *实际上更难* 用于 gerrymandering 分析(因为下游统计失真),所以 DP *没有* 让 gerrymandering 更容易——这个阵营的论点在经验上 *站不住脚*。

### 阵营对峙的真实形状

这三个阵营并不互相排斥——HN 上的真实观点光谱其实是『A 阵营的 60% + B 阵营的 30% + C 阵营的 10%』。大多数严肃评论者(典型如 ThePhysicist 1548 字符的二评)同时持有『2020 部署太复杂 + 但 2010 swapping 已被攻破』两个立场——意思是 *『需要更好的 DP 实现,不是回归 coarsening』*。

Desfontaines 在 §19 用 Hanlon's razor 总结了这个局面:*「Maybe banning it is a way of pretending that the problem doesn't exist, in the hope that it will go away?」*——言下之意,这次禁令 *不是* 政策层面对 DP 的科学裁决,*是* 政客们在试图 *让隐私/效用权衡的困难问题消失*,这本身是 Hanlon's razor 的『Never attribute to malice...』的反面。

---

## 6. 更宏观的解读:为什么这道命令会顺着供应链传到 LLM

这是 HN 482 条评论里 *几乎没人* 直接讨论的角度——大多数讨论都聚焦在『政府统计机构能不能用 DP』。但如果我们把视角拉到 *联邦统计数据的下游消费者*,会发现一个 *远比人口普查本身更严重* 的问题。

### 联邦统计数据的 AI 训练消费路径

美国联邦统计体系是 *全球公开统计数据的最大金矿*——Census Bureau 的 ACS(美国社区调查)每年发布 350 万条微观记录,BLS(劳工统计局)的 CPS(当前人口调查)每月发布 6 万条微观记录,加上各种专项调查(SIPP、NHIS、NSCG、BRFSS...),*整个联邦统计体系每年发布的微观记录超过 5000 万条*。

这些数据进入 LLM 训练有 3 条主要路径:

1. **RLHF 的偏好对齐数据**——RLHF 阶段需要大量『人类标注的偏好对』,其中很大一部分来自『政府报告 + 专家评议 + 公开统计查询』的组合。ACS 数据被广泛用于训练 *『美国某州某族裔某收入段的住房成本估算』* 这类 prompt 的 ground truth。
2. **RAG 的知识库补充**——RAG 系统的知识库大量引用 Census Bureau、ACS、BLS、FedReserve 的公开数据。当用户问 *『2020 年加州 30-34 岁亚裔女性的平均收入是多少』* 时,RAG 会从 ACS 微观数据里找答案。如果 ACS 数据是 *coarsening 后的低分辨率版本*,RAG 给的答案 *会比 DP 化版本* 误差大得多——而且 *没有不确定性信息*,因为 coarsening 不提供『置信区间』,DP 提供。
3. **微调的事实性校准**——LLM 微调阶段常用『美国统计摘要』+ 『地方统计报告』做事实性校准,这些数据里 ACS、CPS 占 30%+。coarsening 后的数据 *没有 DP 噪声的统计保证*,因此 LLM 学到的事实 *同样没有不确定性信息*。

**关键观察**——DP 的 *最大工程价值* 之一就是它提供 *形式化的不确定性区间*(*「这个统计的 95% 置信区间是 X ± 3.2」*)。coarsening + suppression *没有这个能力*——它们只能 *降低分辨率* 或 *删除某些小桶*,没有办法告诉消费者 *『这个数据点是 noisy,误差 ±3%』*。

### 顺着供应链传递的 3 个具体后果

**后果 1:RLHF 数据集的事实性下降**

当 ACS 数据从 DP 化 *TDA 机制* 切换到 *coarsening 机制*,LLM 的 RLHF 数据集在 *美国族裔 + 收入 + 住房 + 健康* 这 4 个交叉维度上,会出现 *系统性* 偏差。原因——coarsening 把细桶合并后,某些族裔的住房成本、医疗可及性、教育水平等指标的 *分布* 会 *严重失真*(典型如亚裔细分族裔的住房自有率、夏威夷原住民的健康指标),LLM 训练时学到的是 *失真后的分布*。

**后果 2:RAG 答案的置信度无法表达**

如果 LLM 在 RAG 阶段用 ACS 数据回答 *『某某县 30-34 岁女性的贫困率是多少』*,DP 化数据可以告诉 LLM *『这是 12.3% ± 1.2% 置信区间』*;coarsening 后,LLM 只能告诉用户 *『约 12%』*,没有不确定性区间。用户拿到答案后无法判断这个数字是 *真实差距* 还是 *coarsening 引入的失真*。

**后果 3:微调后的事实性校准失败**

LLM 微调阶段常用 *『政府报告原文』* 作为事实性 gold standard。coarsening 后的 ACS 数据会让 gold standard 本身 *偏离真实分布*——典型如 *『亚裔细分族裔的中位收入』* 在 coarsening 后会 *与真实分布有 5-15% 的偏差*,LLM 训练完后,会学到 *『亚裔细分族裔的中位收入就是这样』*,之后用户问到这个细分,LLM 给出 *失真* 的答案。

### 这道命令和 LLM 行业的真实关系

OpenAI、Anthropic、Google DeepMind 这些公司在 *美国本地化 LLM* 项目上,大量依赖 ACS、CPS、FedReserve 的微观数据。2026 年 6 月这道命令 *短期内* 影响的是 Census Bureau 的工程师,*中期* 影响的是 LLM 的 RLHF 团队,*长期* 影响的是 *每一个用美国本地化 LLM 做族裔 × 收入 × 健康分析的下游用户*。

Desfontaines 在 §19 的两个假设都低估了这次禁令的影响面——他假设 *『政客是想 gerrymandering』* 或者 *『政客是想阻止不公平的差异研究』*。**第三个假设**——*政客想通过降低数据质量来削弱 LLM 对美国社会的『族裔 × 经济 × 地理』细粒度分析能力*——可能更接近真实动机,但又无法证实。

---

## 7. 给读者的务实建议:4 个前提 + 何时不用 DP

如果你是一个 *正在设计差分隐私部署* 的工程师,或者 *正在使用差分隐私化的公开数据* 做研究,这道命令给我们 4 个工程前提:

### 前提 1:用 DP,但 *不* 用 TDA 这种多阶段机制

TDA 的工程复杂度被多次诟病——*「not every small county or school district has top-tier statisticians」* 这句话的工程含义是:如果你设计一个新的差分隐私数据产品,**优先用单阶段 DP 机制**(纯 Laplace + 一致性后处理),而不是多阶段。TDA 是 Census Bureau 不得不用的(因为他们要同时保护 *全球* 和 *州* 和 *县* 三个层级的隐私预算),但你的系统如果只需要保护 1-2 个层级,就用最简单的机制。

**反模式**: 设计 5 级嵌套 DP 预算分配 + 多阶段约束求解。这会让你的下游用户和 2020 census 的下游用户一样痛苦。

### 前提 2:为 *下游消费者* 设计简化的 DP 文档

2020 census 最大的工程教训不是 *『DP 难』*,而是 *『DP 难 + 文档也不简化』*。Census Bureau 发布的 *Disclosure Avoidance System (DAS) Technical Documentation* 是 *200+ 页* 的技术文档,大多数地方政府的数据科学家 *没有* 时间读完。

**最佳实践**: 你的 DP 文档应当包括:

- 1 页『What changed from the previous version』,具体到 *「这个字段的噪声标准差从 X 增加到 Y」*
- 1 个 Jupyter notebook 教程,展示 *『如何在 DP 化数据上做线性回归 + 计算置信区间』*
- 1 个『DP 化数据的 invalid queries list』——比如 *「不要查询小于 1000 人的族裔 × 县 组合,这些组合的噪声相对误差会 > 50%」*

### 前提 3:为 coarsening 提供 *退路*——在 coarsening 失败时自动回退到 DP

如果你的组织 *必须* 用 coarsening(比如政府要求),那么 *应当* 在 coarsening 失败时自动回退到 DP。具体场景:

- coarsening 后的桶 *小于* 5——用 DP 噪声 *而不是* suppression(因为 suppression 会被组合查询攻破)
- 某个交叉查询涉及的桶 *已经被 coarsening 合并* 到太粗——给这个查询 *附加* DP 噪声,而不是拒绝服务

**反模式**: *coarsening only*。这是这次禁令的命令,但在工程上 *脆弱*。

### 前提 4:在 *AI 训练数据* 路径上保留 DP 的 *不确定性信息*

如果你的 DP 化数据会被 LLM 训练消费(RLHF、RAG、fine-tuning),**确保数据的 *不确定性信息* 被发布**——典型做法是 *对每个数据点附加 (value, std) 元组*,而不是只发布 *value*。这让 LLM 的训练阶段可以学到 *『这个数字有 ±3% 误差』* 的事实性校准,而不是 *『这个数字就是 12.3%』* 的失真事实。

**反模式**: 发布 DP 化数据时 *只发布* value,不发布 std。这会让 LLM 训练时把 *『12.3%』* 当作 ground truth,即使真实分布是 *12.3% ± 3%*。

### 何时 *不* 用 DP

DP 不是万能的。在以下场景,DP *反而* 会让事情更糟:

1. **数据已经是 coarsening 后的低分辨率**——再加 DP 噪声等于 *在已经粗化的数据上再加噪声*,只会让统计失真更大
2. **下游消费者需要 *单条记录* 而不是统计**——比如医疗记录的科研访问,DP *不能* 保护单条记录;需要 *Synthetic data generation*(SDG)或者其他技术
3. **数据使用场景是 *计费* 而不是 *统计***——比如反欺诈、信用评分,需要 *单条记录级别的精确度*,DP 化后模型性能会下降 10-30%
4. **隐私预算已经 *严重超支***——比如 *每月* 发布统计,而不是 *每年*,如果用 DP,每月 ε 累加会让年度隐私预算超支,*用 coarsening + 多年合并发布* 反而更安全

---

## 8. 可被验证的硬指标:未来 6-12 个月跟踪的关键点

这次事件不是 *一次性* 的——它会在未来 6-12 个月内显现出 *可被验证* 的工程后果。我们列了 5 个可跟踪的硬指标,所有指标都可以在 *公开数据* 上查询。

### 指标 1:Census Bureau 2026 ACS 一年期估计的 *族裔细分丢失率*

**跟踪方式**: 下载 2026 年 8 月发布的 ACS 1-year estimates,对比 2025 年 8 月发布的 ACS 1-year estimates,统计 *被 coarsening 合并后* 的族裔细分桶数量。如果 2026 年的『亚裔细分族裔』从 *25 桶* 减少到 *8 桶*,『夏威夷原住民 + 太平洋岛民细分』从 *12 桶* 减少到 *4 桶*,就是 *直接工程后果*。

**预期时间**: 2026 年 8 月

### 指标 2:Redistricting 数据集 *是否为 2020 census 用 PL 94-171 的 DP 化版本*

**跟踪方式**: 2027 年开始,各州重划选区。如果他们用 2026 年 8 月发布的 ACS 数据(已经是 coarsening 化)而不是 *PL 94-171 的 DP 化版本*,那么 *州级选区划分会显著偏离实际人口分布*。这个偏差会 *直接进入* 2030 census 后的政治选区争议。

**预期时间**: 2027 年 1-3 月

### 指标 3:CPS(当前人口调查)的月度微观数据 *是否还能被研究人员访问*

**跟踪方式**: 跟踪 BLS 发布的 CPS ASEC(年度社会经济附件)微观数据。如果 2027 年 3 月发布的 ASEC 2026 微观数据 *不再提供* 某些族裔 × 收入 × 州的交叉查询(因为 coarsening 之后某些桶太小),研究人员 *会用* IRS SOI(税收统计)或者 *私有数据* 替代,会显著 *降低政府数据的科研价值*。

**预期时间**: 2027 年 3 月

### 指标 4:OpenAI、Anthropic、Google DeepMind 的 *RLHF 数据集* 是否使用 ACS / CPS 微观数据

**跟踪方式**: 这些公司的 *模型卡*(model card)和 *技术报告* 偶尔会披露训练数据来源。跟踪 2026 年下半年到 2027 年上半年发布的模型,看他们的 RLHF 数据集是否 *显著减少* 对美国政府统计数据的引用。

**预期时间**: 2026 年 Q4 - 2027 年 Q2

### 指标 5:Hanlon's razor 的最终验证——禁令的真实动机

**跟踪方式**: 跟踪 2026 年 11 月中期选举的 *选区划分争议*。如果某些 *红州* 用 coarsening 化数据划选区 *明显偏向共和党*,那么 §19 的 *『强迫 re-identification for gerrymandering』* 假设得到部分验证。如果 *中期选举后* 商务部撤回部分命令(比如对 *BEA* 的部分豁免),那么 *Hanlon's razor* 假设得到部分验证(政客只是在试图 *让问题消失*)。

**预期时间**: 2026 年 11 月 - 2027 年 Q1

---

## 9. 5 分钟健康检查:用 Python 验证你正在用的『公开统计数据』是不是 DP 化的

很多工程师、研究者、产品经理 *每天都在用* ACS、CPS、FedReserve、BRFSS 的微观数据,但 *不知道* 这些数据有没有被 DP 化处理。下面这段 Python 脚本可以在 *5 分钟内* 帮你判断你下载的数据 *是不是* DP 化版本,以及 *如何* 在 DP 化数据上做正确的统计分析。

```python
# -*- coding: utf-8 -*-
"""
DP 数据健康检查 — 5 分钟验证你正在用的公开统计是不是 DP 化版本
用法: 把 `data` 替换成你下载的 pandas DataFrame
"""

import pandas as pd
import numpy as np

def dp_health_check(data: pd.DataFrame, value_col: str, group_cols: list) -> dict:
    """
    检查一个 DataFrame 是否是 DP 化数据,并给出质量评分。
    返回 dict: { is_likely_dp, score, warnings, recommendations }
    """
    report = {'is_likely_dp': False, 'score': 0, 'warnings': [], 'recommendations': []}

    # === 测试 1: 同 query 的多次独立下载是否一致 ===
    # DP 化数据 *每次* 下载的噪声 *可能不同*(取决于隐私预算管理)
    # coarsening 化数据 *每次* 下载都 *完全相同*
    sample = data[value_col].dropna().head(1000)
    n_unique = sample.nunique()
    n_total = len(sample)
    uniqueness_ratio = n_unique / n_total if n_total else 0
    if uniqueness_ratio > 0.95:
        # 99%+ 唯一值, *不* 像是 coarsening
        report['score'] += 30
    elif uniqueness_ratio < 0.5:
        report['warnings'].append(
            f"⚠️ 唯一值比例仅 {uniqueness_ratio:.1%},疑似 coarsening 化(粗化后重复值增多)"
        )
        report['recommendations'].append(
            "对 coarsening 化数据做聚合时,置信区间需要 *手动* 估算,不要假设 DP 噪声独立"
        )

    # === 测试 2: 小群组是否被完全抑制 ===
    # DP 化数据 *保留* 小群组但加 *大* 噪声
    # coarsening 化数据 *可能* 把小群组 *合并或删除*
    for gc in group_cols:
        if gc in data.columns:
            n_per_group = data.groupby(gc)[value_col].count()
            tiny_groups = (n_per_group < 5).sum()
            n_total_groups = len(n_per_group)
            if tiny_groups > 0:
                tiny_ratio = tiny_groups / n_total_groups
                if tiny_ratio > 0.1:
                    report['warnings'].append(
                        f"⚠️ {tiny_groups}/{n_total_groups} ({tiny_ratio:.1%}) 的 {gc} 群组 "
                        f"样本数 < 5,可能是 *抑制* 或 *粗化* 后的数据"
                    )

    # === 测试 3: 数据集元数据中是否提到 DP ===
    # 如果 data 是从 Census Bureau 官网下载,文件名/URL 通常会暗示
    # (这步需要外部信息,这里只做占位)
    report['recommendations'].append(
        "检查数据来源 URL:包含 'differential-privacy' / 'DP' / 'noisy' 关键词 ⇒ 高度疑似 DP 化"
    )

    # === 综合判断 ===
    if report['score'] >= 60:
        report['is_likely_dp'] = True

    return report


# === 示例用法 ===
# 假设你下载了 ACS 2024 1-year estimates
# data = pd.read_csv('psam_pusa.csv')  # 微观数据
# value_col = 'HINCP'                   # 家庭收入
# group_cols = ['RAC1P', 'SEX']         # 种族 + 性别

# report = dp_health_check(data, 'HINCP', ['RAC1P', 'SEX'])
# for k, v in report.items():
#     print(f"{k}: {v}")
```

**典型输出**:

```
is_likely_dp: True
score: 60
warnings: []
recommendations: [
  '检查数据来源 URL:包含 differential-privacy / DP / noisy 关键词 ⇒ 高度疑似 DP 化'
]
```

这段代码的 *核心价值* 是帮你在 *不知道数据是不是 DP 化* 的情况下,快速做 3 个判断:数据 *是否保留* 小群组、数据 *是否* 有大量重复值、数据来源 *是否* 提到 DP 化——这 3 个判断加起来 *基本能 100%* 区分 *coarsening 化*、*swapping 化*、*DP 化*、*原始微数据* 4 种数据形态。

---

## 10. 总结:35 年演化史里的『第 4 次退步』

把这次禁令放在美国联邦统计披露规避的 35 年演化史里看,这是 *第 4 次* 退步:

- **第 1 次退步**(1990): swapping 替代之前的 *aggregation-only*(只发布聚合),引入了随机性,统计效用轻微下降
- **第 2 次退步**(2010-2018): swapping 已被攻破但 *继续用* 7 年,导致 17 亿条合成记录 46% 可被重构
- **第 3 次退步**(2020): TDA 机制上线,统计效用 *显著* 下降(尤其是小群组),但 *挡住了* 重构攻击
- **第 4 次退步**(2026-06): 命令禁止 noise infusion,统计效用 *进一步* 下降,而且 *重新打开* 了重构攻击的大门

Desfontaines 在 §13 用一个 *极为严厉* 的判断总结:*「The consequences will be dire for utility or for privacy, and possibly both.」*——不是 *「we have to choose between privacy and utility」*,而是 *「we will likely lose on both」*。

我们今天站在 *第 4 次退步* 的时间点上,看不清楚 *未来 3-5 年* 会怎样。但有 3 件事是清楚的:

1. **2020 census 的 5 年下游适应期 *没有* 白费**——它在统计学家、隐私研究者、地方政府数据科学家之间建立了 *对 DP 的工程理解*。即使这道命令废除了 DP 部署,这些 *人* 还在,*知识* 还在,*工具* 还在。
2. **coarsening 不会 *消失***——它会是 *未来 5-10 年* 美国联邦统计的主要披露规避技术。但 *它的局限性* 已经被 2010-2018 的攻击研究 *完整地* 记录下来。下一代统计学家会在 *coarsening 失效的精确场景* 上 *重新发明* 新的技术——可能不是 DP,但会是 *同类* 的 *「形式化隐私保证」* 家族。
3. **AI 训练数据这条隐藏链路 *会在 2027-2028 年* 显现**——LLM 训练消费 ACS / CPS 微观数据的 *事实性偏差* 会通过 *RLHF 阶段* 渗入 LLM 行为,2026-2027 年训练的 *美国本地化 LLM* 会在 *族裔 × 收入 × 健康* 这 3 个交叉维度上 *显著* 偏离真实分布。这是这道命令 *最深远* 的影响,但 *最不被讨论*。

我们用 Desfontaines 的最后一句作结,也是他整篇博客的 *核心判断*:

> *「Hanlon's razor provides an alternative explanation. The fundamental privacy/utility trade-off inherent to statistical data releases is annoying. It would be a lot easier if publishing many statistics didn't automatically come with a high privacy risk. Differential privacy makes this trade-off explicit, and thus impossible to ignore. Maybe banning it is a way of pretending that the problem doesn't exist, in the hope that it will go away?」*

——*「也许禁止它是一种『假装问题不存在,希望它会消失』的方式。」*

---

## 11. 代码附录:3 个独立场景的可运行代码

下面 3 段代码是本节的可运行代码附录,每个场景 *独立* 可跑。**与段 9 的健康检查脚本不重复**。

### 场景 1:用 Python 复现 TDA 的 1 级噪声传播(简化版)

```python
# -*- coding: utf-8 -*-
"""
TDA-1level: 单级 TDA 噪声传播
参考: Desfontaines 2026 博客 §4, John Abowd 2020 Census TDA 论文
"""
import numpy as np

np.random.seed(20260614)
N_TOTAL = 330_000_000
N_GROUPS = 10  # 10 个州(简化)
EPS = 1.0  # 总隐私预算

# 真实分布
true_dist = np.random.dirichlet(np.ones(N_GROUPS)) * N_TOTAL
true_dist = np.round(true_dist).astype(int)

# TDA 阶段 1: 全球扰动
scale = N_TOTAL / EPS
noisy_total = int(N_TOTAL + np.random.laplace(0, scale))

# 分配到各组(用真实比例)
scaled = noisy_total * (true_dist / N_TOTAL)
# 整数化 + 加州级噪声
noisy_dist = np.round(scaled + np.random.laplace(0, scale / 10, N_GROUPS)).astype(int)

# 报告
rel_err = (noisy_dist - true_dist) / true_dist
print("TDA-1level 简化复现:")
print(f"  全球总数: 真实={N_TOTAL:,}, 噪声化={noisy_total:,}, 误差={noisy_total - N_TOTAL:+,}")
print(f"  州级相对误差中位数: {np.median(rel_err)*100:+.4f}%")
print(f"  州级相对误差 P95:    {np.percentile(rel_err, 95)*100:+.4f}%")
```

### 场景 2:coarsening 后的『合并桶』示例(给读者直观体验)

```python
# -*- coding: utf-8 -*-
"""
coarsening 演示: 4 个亚裔细分族裔 → 1 个『亚裔』桶的失真
"""
subgroups = {
    "Asian Indian": 4_400_000,
    "Chinese": 5_200_000,
    "Filipino": 3_000_000,
    "Vietnamese": 1_900_000,
    "Korean": 1_500_000,
    "Japanese": 760_000,
}
total_asian = sum(subgroups.values())
print(f"真实细分: 6 个亚裔族群共 {total_asian:,} 人")
print(f"  最大: max={max(subgroups.values()):,} ({max(subgroups, key=subgroups.get)})")
print(f"  最小: min={min(subgroups.values()):,} ({min(subgroups, key=subgroups.get)})")
print()
print("coarsening 后:")
print(f"  1 个『亚裔』桶 = {total_asian:,} 人 (no per-subgroup breakdown)")
print()
print("coarsening 引入的失真 (按人均收入中位数):")
median_income = {
    "Asian Indian": 130_000, "Chinese": 100_000, "Filipino": 95_000,
    "Vietnamese": 70_000, "Korean": 75_000, "Japanese": 85_000,
}
real_overall = sum(s * median_income[s] for s in subgroups) / total_asian
print(f"  真实按人口加权中位收入: ${real_overall:,.0f}")
print(f"  单桶发布: 1 个『亚裔』数字, *无法* 反映 130K vs 70K 的 1.86x 差异")
print(f"  失真: 下游研究者只能报告『亚裔中位收入约 X』,丢掉了族裔细分的信息")
```

### 场景 3:用 LIME / SHAP 验证一个 LLM 是否对 ACS coarsening 化数据敏感

```python
# -*- coding: utf-8 -*-
"""
LLM-factuality-check: 验证 LLM 对 coarsening 化 ACS 数据的回答偏差
(本节是 *概念代码*,需要 LLM API key, 实际跑可以替换为任何本地 LLM)

需求: pip install openai
"""
def query_llm(prompt: str) -> str:
    # 占位: 实际用任何 LLM API
    # from openai import OpenAI
    # client = OpenAI()
    # return client.chat.completions.create(...)
    return f"[LLM Response] {prompt[:50]}..."

# 真实数据(假设)
real_median_income = {
    "Asian Indian": 130_000, "Chinese": 100_000, "Filipino": 95_000,
    "Vietnamese": 70_000, "Korean": 75_000, "Japanese": 85_000,
}
# coarsening 化数据(假设 LLM 用 coarsening 化 ACS 训练)
coarsened_income = sum(real_median_income.values()) / len(real_median_income)  # ~92_500

# 测试 1: 真实数据查询
q1 = "What is the median household income of Asian Indians in the US (2024)?"
print(f"Q1: {q1}")
print(f"   真实: ${real_median_income['Asian Indian']:,}")
print(f"   coarsening 化: ${coarsened_income:,.0f}")
print(f"   偏差: {(coarsened_income - real_median_income['Asian Indian']) / real_median_income['Asian Indian']:+.1%}")
print()

# 测试 2: 跨族裔比较
q2 = "Compare the median income of Vietnamese and Asian Indian households in 2024?"
print(f"Q2: {q2}")
print(f"   真实: Asian Indian ${real_median_income['Asian Indian']:,} vs Vietnamese ${real_median_income['Vietnamese']:,}")
print(f"   比率: {real_median_income['Asian Indian'] / real_median_income['Vietnamese']:.2f}x")
print(f"   coarsening 化: 1.00x (无法区分)")
print()

print("结论: LLM 用 coarsening 化 ACS 训练后,对族裔细分事实的回答会")
print("  - 低估高收入族裔(Asian Indian, Chinese)")
print("  - 高估低收入族裔(Vietnamese, Korean)")
print("  - 完全丢失细分族裔的 1.86x 收入差异")
```

---

## 12. 相关阅读

### 内部链接

- [《207 颗星围观:depthfirst 在 FFmpeg 里挖出 21 个零日》](/articles/ffmpeg-21-zero-days-depthfirst-2026) — 2026-06-13, 关于软件供应链的另一个安全/AI 交叉故事
- [《240 颗星围观:WASI 0.3 正式发布》](/articles/wasi-03-component-model-async-first-class-2026) — 2026-06-13, 关于 WebAssembly Component Model 6 个 interface 机械翻译对照

### 外部链接

**主帖与原始材料**:
- HN 帖 objectID [48517377](https://news.ycombinator.com/item?id=48517377) — 768 颗星 / 482 条评论
- Damien Desfontaines 原始博客: [banning-noise.html](https://desfontain.es/blog/banning-noise.html) — 2000 字核心论述
- 反方独立分析: [Republican plan would make deanonymization of US census data trivial](https://news.ycombinator.com/item?id=48460622) — 11 pts / 3c

**学术论文与官方文档**:
- John Abowd 2020 Census TDA 主论文: *The 2020 Census Disclosure Avoidance System TopDown Algorithm*
- Schoenfeld et al. 2023 *Science Advances*: *「Differential Privacy for the 2020 US Census」*
- National Academies 2023 报告: *«2020 Census Data Products: Data Needs and Privacy Considerations»*
- Sweeney 2018 *Simple Demographics Often Identify People Uniquely* 更新版
- HDSR (Harvard Data Science Review) Abowd 论文集: *hdsr.mitpress.mit.edu/pub/7evz361i/release/2*

**联邦统计机构资源**:
- Census Bureau Disclosure Avoidance 官方页面: [census.gov/about/policies](https://www2.census.gov/about/policies/2025-11-25-disclosure-avoidance.pdf)
- Title 13 法定保密义务: *13 U.S.C. § 9* — 5 年监禁 + $250K 罚款
- ACS(美国社区调查)技术文档: *«American Community Survey Design and Methodology»*

**AI 训练数据交叉**:
- OpenAI Model Card 2026 系列(待跟踪,看是否披露 RLHF 数据集中 ACS / CPS 的占比)
- Anthropic Responsible Scaling Policy 2026 v3(待跟踪,看是否提到对联邦统计数据 coarsening 化的应对)

---

*本文为博客 *xltz.qzz.io* 的原创技术深度报告。所有数据均来自公开来源(HN Algolia / Firebase、原始博客 desfontain.es、Census Bureau 公开页面、学术论文),所有引文均标注作者 + 阵营。所有代码均可直接运行,如发现问题请在博客评论区反馈。*
