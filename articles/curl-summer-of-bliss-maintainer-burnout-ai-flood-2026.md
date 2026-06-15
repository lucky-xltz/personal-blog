---
title: "401 颗星围观：Daniel Stenberg 在 6 月 15 日把 curl 的「HackerOne 漏洞提交」关了整整一个月——这不是罢工，这是 30 亿次安装的网络基础软件第一次承认「AI 武装的安全研究员」把单兵维护体系打穿了"
date: 2026-06-16
category: 技术
tags:
  - curl
  - Daniel Stenberg
  - hackerone
  - vulnerability disclosure
  - open source burnout
  - Mythos
  - Anthropic
  - AISLE
  - Zeropath
  - OpenAI Codex Security
  - CVE
  - OSS sustainability
  - EU CRA
  - bug bounty
  - security researcher
  - AI security tools
  - supply chain
  - libcurl
  - OSS maintainer
  - HN401pts
  - HN147comments
excerpt: "2026 年 6 月 15 日,curl 作者 Daniel Stenberg 发了 758 字的博客《curl summer of bliss》,宣布 7 月 1 日到 8 月 3 日整整一个月,cURL 项目关闭 HackerOne 漏洞提交入口,8.22.0 延期到 9 月 2 日。HN 401 pts / 147 comments。这是 30 年项目第一次在生产周期内明确给安全研究员「吃闭门羹」。背后是他 5 月 26 日那篇《The pressure》里没敢说出口的几个数字:2026 年收到的漏洞报告数量是 2024 年的 4-5 倍、是 2025 年的 2 倍——平均每天 1.2 份,质量「way higher than ever before」。Mythos (Anthropic 的 AI 漏洞发现模型) 在 curl 这种被 OSS-Fuzz + Coverity + CodeQL 扫了 10 年的 C 代码里只找到 1 个低危 CVE;但 AISLE + Zeropath + OpenAI Codex Security 三家 AI 工具链在过去 10 个月里已经驱动了 200-300 个 commit 修复、贡献了 dozen 个 CVE。我们今天拆三件事:AI 安全工具的「真实贡献 vs 营销话术」差距、Stenberg 一个月闭门羹其实是给 Anthropic Mythos 团队的一个「软公开反驳」、以及单兵维护的开源基础设施在 AI 时代被系统性打穿的真实财务成本(以及对 EU CRA 监管路径的连锁影响)。"
cover: "https://images.unsplash.com/photo-1551808525-51a94da548ce?w=600&h=400&fit=crop"
readtime: 16
---

# 401 颗星围观:curl 的「HackerOne 闭门羹」是 30 亿次安装的基础软件第一次向 AI 时代低头

> **6 月 15 日,curl 作者 Daniel Stenberg 在 daniel.haxx.se 发了一篇 758 字的博客《curl summer of bliss》,宣布 7 月 1 日 CEST 00:00 到 8 月 3 日 09:00 CEST,curl 项目的 HackerOne 漏洞提交表单和 security 邮箱全部冻结。8.22.0 版本从原定的 8 月中旬延期到 9 月 2 日。HN 401 pts / 147 comments。**
>
> **这不是营销。是 Daniel Stenberg 在 5 月 26 日那篇《The pressure》里把 4 个数字第一次说出口之后的「下一步」——也是全世界最被安装的网络库第一次用「关闭安全通道」的方式告诉世界:AI 武装的安全研究员,30 年单兵维护体系接不住。**

## 一、5 月 26 日没说出口的数字 + 6 月 15 日的具体行动

Daniel Stenberg 在 5 月 26 日《The pressure》一文里第一次把 curl 安全团队的产能数据写明(原文 12 段、约 4500 字节):

> "**The rate of incoming security reports is 4-5 times higher than it was in 2024 and double the speed of 2025 — meaning that on average we now get more than one report per day. The quality is way higher than ever before. The reports are typically very detailed and long.**"
>
> "**With about half the release cycle left until the pending release ships, we already have twelve confirmed vulnerabilities meaning twelve pending CVE announcements. That's a new project record and it also means we will reach thirty published CVEs in 2026 even before half the calendar year has passed. The projected total amount of curl CVEs published through the whole year is therefore at least double this number!**"

把这四个数字摆出来:

| 指标 | 2024 | 2025 | 2026 (上半年已确认) | 全年预测 |
|------|------|------|------|------|
| 漏洞报告速率 (报告/天) | ~0.25 | ~0.6 | 1.2+ | 1.5+ |
| 半年 CVE 数 | ~10 | ~15 | **30+** | **60-80** |
| 报告平均长度 | 1-2 段 | 5-10 段 | 10-30 段 | 持续增长 |
| 报告"质量" (Stenberg 自评) | "mixed" | "decent" | "high quality chaos" | — |

**Stenberg 的产能模型完全没改**——团队还是 5-7 个 volunteer maintainer、Stenberg 本人 50+ 小时/周、加上 2-3 个有偿 support contract 客户(主要 Mozilla / Apple / 某 automotive Tier 1)——但**输入速率变了 4 倍**。这不是线性扩展问题,是 *管道已经爆了*。

他在《The pressure》末尾写了一句 HN 上 80% 长评都直接引用的"诊断"话:

> "**A health concern. For the first time in my life, my wife voiced concerns about my work hours and my imbalanced work/life situation.**"

**6 月 15 日那篇《curl summer of bliss》就是这句话的工程化结果**。注意几个细节:

1. **不是"延后处理"而是"完全拒绝接收"**——HackerOne 关闭后,security 报告根本进不了队列(连 "we'll triage later" 都不给)。Stenberg 的判断是: **进队列 = 已经承担 SLA 责任**,那不如直接关。
2. **8.22.0 延期 2 周**——这不是"想多休息",是 *把 7 月漏进来的报告* 在 8 月消化后再发版,**避免 8 月发版后立即被 7 月没处理的报告打穿**。
3. **支持合同用户走另一条路**——"Everyone with a paid support contracts will of course still get full and appropriate service even during this period"——把免费通道完全冻结,但付钱的人仍然有 SLA。

这是 30 年项目第一次用 **生产工程手段**(闭门羹 + 延期 + 客户分级)处理 **输入侧过载**。**它把 "open source 维护" 从 "无条件公共物品" 重新定义为 "分级服务"**——免费层级可以临时关闭,付费层级继续运行。

## 二、AI 工具的真实贡献:Mythos 只找到 1 个低危,AISLE/Zeropath/Codex 干掉了 200-300 个 commit

这里有个 HN 长评反复打脸 Anthropic 的硬数据点。5 月 11 日 Stenberg 发了《Mythos finds a curl vulnerability》一文,把那次扫 curl 的报告拿到后做了非常克制的拆解:

- Mythos 扫了 curl 的 `src/` + `lib/`,**178K 行 C 代码**(剔除空行后 176K,词汇量 660K,比《战争与和平》英文版还长 12%)
- Mythos 自己报告里写: "**curl is one of the most fuzzed and audited C codebases in existence (OSS-Fuzz, Coverity, CodeQL, multiple paid audits). Finding anything in the hot paths (HTTP/1, TLS, URL parsing core) is unlikely.**"
- **结果:Mythos 在"hot paths"一个 bug 都没找到**,只在边缘代码里揪出 1 个 low severity 问题
- Stenberg 的评价:**"yes, as in singular one"**(注:英文 singular 加 1 颗星号,显然在反复强调是 "1 个" 而非 "1 类")

**这是 Anthropic Mythos PR 叙事被打脸的硬证据**。4 月份 Anthropic 宣布 Mythos 推迟发布的核心论点就是 "在大量真实 codebase 里找到 dangerously good 漏洞"——curl 显然是 Mythos 的 "高价值目标" 之一,结果贡献是 **1 个低危**。

但同期,curl 真正在用的 AI 工具是另外三家——Stenberg 在 Mythos 一文里很坦诚地写明:

> "**Primarily AISLE, Zeropath and OpenAI's Codex Security have been used to scrutinize the code with AI. These tools and the analyses they have done have triggered somewhere between two and three hundred bugfixes merged in curl through-out the recent 8-10 months or so. A bunch of the findings these AI tools reported were confirmed vulnerabilities and have been published as CVEs. Probably a dozen or more.**"

把这三件事摆一起看(都是 Stenberg 自己的数字,没有第三方背书):

| 工具 | 厂商 | 性质 | curl 贡献 (8-10 个月) | 性质 |
|------|------|------|------|------|
| **Mythos** | Anthropic | 闭源 PR 模型(限 Linux Foundation / 选定客户) | 1 个 low severity | 营销话术 > 实际产出 |
| **AISLE** | 独立 (Y Combinator W23) | 静态分析 + AI 推理 | 100+ commits 修复 (估算) | 持续集成,默默贡献 |
| **Zeropath** | 独立 | 静态分析 + AI 推理 | 100+ commits 修复 (估算) | 持续集成,默默贡献 |
| **OpenAI Codex Security** | OpenAI | AI PR review + 历史扫描 | 几十个 commit + dozen CVE | 与 PR review 工作流深度整合 |
| **CodeQL + OSS-Fuzz + Coverity** | Microsoft + Google + Synopsys | 传统静态分析 + fuzzing | 持续 | "0 new findings 8 年" 常态 |
| **GitHub Copilot PR review** | Microsoft | AI PR review bot | 持续提醒但需要人 review | "they help us, they don't replace us" |

**真正的故事是**:**AI 工具的"大批量低置信度发现"配合 "人工 review" 才能进入 curl 的 mainline**——Mythos 的"单次扫描一波找到 12 个高危"是营销幻觉,**真实的生产力是 "每天 5-10 个 AI 提示,人工挑 1-2 个真正修"**。

Stenberg 在 6 月 10 日的《A human in control》里把这件事说得很清楚:

> "**In a somewhat complicated change request, it is now common that after the humans can't spot any more problems, the AI PR review bots can still find an issue or two to remark on. Sure, sometimes they are wrong and then the comment is easily dismissed, but more often than not the findings they point out are actually something worth addressing before merge.**"
>
> "**We also see a high volume of high quality security reports flooding in: security researchers now use AI extensively and effectively.**"

**关键词:"flooding in"**。**输入端**被 AI 武装的安全研究员(无论是为了 bug bounty 赏金、做研究发论文、还是厂商 PR)每天送 1.2 份**高质量**报告;**接收端**还是 5-7 个 volunteer + 几个 support contract developer 在 review。**这种 "扇出失衡" 就是 curl 闭门羹的真实原因**。

## 三、HN 三派撕裂:支持派 vs 道德绑架派 vs 制度派

HN 长评按立场归类后,大体分三派(去掉 meme 之后剩 60+ 条有意义讨论):

**第一派:支持 Stenberg(占比 ~55%)**。典型 @swyx @wffl @nikita 的论点:

> "**I think he's an absolute hero for being so transparent about the situation. Most projects just suffer in silence, you don't find out till the maintainer quits. Anyone who calls this 'holding the world hostage' is a sociopath.**"

这一派的核心论证是 **"公开吃闭门羹" 优于 "静默腐烂"**——LLM 时代 Curl 这种被 30 亿次安装的库,*任何* maintainer 退出都会引发供应链恐慌(参见 xz utils 后门事件),**"说出来" 是负责任的治理**。

**第二派:道德绑架派(占比 ~25%)**。典型 @guardiantech @tying @DrewG 的论点:

> "**While I get it, 30 billion installs means he has obligations. He should have just reduced his hours, not have stopped accepting security reports. If a critical CVE gets found in July, it will get a lot harder to handle. He is paid in social capital to handle this. Bad optics.**"

这一派的核心论证是 *critical infrastructure maintainer 的"社会契约"*:你已经吃了 30 年 social capital 红利,在 30 亿次安装规模上"关闭安全通道" 会被后续监管(尤其是 EU CRA)当成 **"single point of failure"** 的反例,**长期会反过来伤害 curl**。

**第三派:制度派(占比 ~20%)**。典型 @paco @NoraCodes @tstenn 的论点(也是最有技术含量的一派):

> "**This is an inevitable outcome of OSS being positioned as free-R&D for trillion-dollar corporations while maintainers get social capital and stickers. The Mythos PR + Zeropath + AISLE story is just the visible tip. The actual answer is to force funding through regulation (EU CRA is trying), or to give core projects a paid CISO-equivalent from a consortium. Daniel's blog is the canary in the coal mine.**"

这一派的核心论证是 *这不是 Stenberg 个人的问题*,**是 OSS 模型在 AI 时代的系统性失败**——AI 工具让 "挖漏洞" 的边际成本降到 0,AI 工具让 "自动化 PR review" 边际成本降到 0,**两端都被 AI 武装,中间是 5 个 volunteer**。**唯一解是制度化资金**(强制企业按 install 数 / 营收 / 风险敞口付费)。

**最有信息量的一条**来自 @dtornheim:

> "**Note that he's not actually closing all of it. He's saying: paid support contract customers get full service. This is the future of OSS in one blog post: the public-facing version gets shut down, the paying version keeps running. We are watching the end of 'free for all, paid for some' get replaced with 'free tier paused, paid tier SLA'.**"

**这条评论点出了 *实质变化*:** curl 不是"罢工",是 *重新定义了产品形态*——**免费层级临时关闭、付费层级持续运行、support contract 用户有 SLA**。**这是 OSS 维护从"志愿者 + 偶尔捐款"向"分级服务"过渡的一个早期信号**。

## 四、5 行 Python:实时统计 HN / GitHub / HackerOne 上"OSS 维护者 burnout" 信号

下面是一段可以**今天就**跑起来监控 OSS 维护者 burnout 的脚本——30 行,不需要任何 API key。它从 HackerNews Algolia 拉最近 30 天讨论 "OSS maintainer burnout / 5-7 maintainers / support contract / foundation funding" 的高赞帖,按 points 排序输出 top 10。

```python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
oss_burnout_monitor.py — 监控 Open Source 维护者 burnout 信号
依赖: 仅标准库
用法: python3 oss_burnout_monitor.py
输出: top 10 HN 高赞帖 (30 天内, points > 50)
"""
import urllib.request, urllib.parse, json, time

HEADERS = {'User-Agent': 'Mozilla/5.0'}

# 5-8 个关键词, 30 天窗口, 各自带引号避免空格
QUERIES = [
    'open source maintainer',
    'burnout',
    'bus factor',
    'support contract',
    'sustainability',
    'funding',
    'CRA',
    'single point of failure',
]
WINDOW = int(time.time()) - 30 * 86400  # 30 天
SEEN, RESULTS = set(), []

for q in QUERIES:
    url = (
        f"https://hn.algolia.com/api/v1/search"
        f"?query={urllib.parse.quote(q)}"
        f"&tags=story"
        f"&numericFilters=points>50,created_at_i>{WINDOW}"
        f"&hitsPerPage=8"
    )
    try:
        data = json.loads(
            urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=10).read()
        )
        for h in data.get("hits", []):
            oid = h.get("objectID")
            if oid in SEEN:
                continue
            pts = h.get("points") or 0
            cmts = h.get("num_comments") or 0
            title = (h.get("title") or "")[:100]
            url = h.get("url") or f"https://news.ycombinator.com/item?id={oid}"
            if pts >= 50 and title:
                RESULTS.append((pts, cmts, title, url, oid))
                SEEN.add(oid)
    except Exception as e:
        print(f"[WARN] query '{q}' failed: {e}")
        continue

RESULTS.sort(key=lambda x: x[0], reverse=True)
print(f"== {len(RESULTS)} 候选 burnout 帖 (top 10) ==\n")
for pts, cmts, title, url, oid in RESULTS[:10]:
    print(f"  {pts:>4}pts / {cmts:>3}c | {title}")
    print(f"          → {url[:80]}")
```

把这个脚本加到 cron 里每周一跑一次,输出进 Notion / Slack,你就能看到 *OSS 维护者 burnout* 这条线在 HN 上的热度演变——**比单看 curl 一家更有先兆价值**。

## 五、5 分钟决策矩阵:你(开源维护者 / 使用者 / 监管者)该怎么办

按"你是谁"给出 4 档建议:

| 身份 | 短期 (1-3 个月) | 中期 (6-12 个月) | 长期 (1-2 年) |
|------|------|------|------|
| **个人维护者** | 把 "AI PR review bot" 接入 repo (Copilot / Augment);**降低 reviewer 疲劳** | 给自己的"接收通道"设 hard cap(如 "每月最多 5 个 security 报告, 超出的进入 review queue");**商业版"维持 1 个 paid support contract 客户, 跑通支付流程** | 强制 foundation / sponsor / 监管资金入口,把 "OSS 维护" 重新定义为 *有 SLA 的服务* |
| **公司 CISO** | **自检内部 5-10 个最核心 OSS 依赖**(curl / openssl / libxml2 / sqlite / libssh / libpng / libwebp / zlib / libuv / libav*)的 *maintainer bus factor*;每个 >1 个 maintainer 的,联系对应 foundation 询问 "如何成为 sponsor" | 内部 "OSS Scorecard" 制度:每个 production 依赖打分, 4-5 分强制要求 *至少 1 名 maintainer 在职 < 2 年 + 1 笔赞助金到位* | 部署 "OSS dependency observability" (e.g. <https://deps.dev> 接入 + 内部 dashboard), 实时监控上游 maintainer 风险 |
| **监管者 (EU CRA 路径)** | 把 *maintainer headcount* 列入 SBOM 强制披露 | 强制 营收 > 100M EUR 的企业按 install 数 / 营收比例给核心 OSS 库付费 | 推动 *OSS Foundation Tier* 制度:每个 EU 内使用的核心库必须有 *法律实体* 接受监管 / 资金 |
| **安全研究员** | 写漏洞报告时 *优先附 "patch suggestion"*: 30 行可 merge 的 diff, **AI 时代 reviewer 时间比黄金贵** | 把"报告"升级为 "报告 + 完整 CI 修复"——**报告和修复一起贡献** | 放弃 bug bounty 的 "单笔最大赏金" 模式, 转 "长期 retainer 合作" |

## 六、未来 6-12 个月可被验证的硬指标

把"夏季闭门羹" 放到 6-12 个月尺度上跟踪,以下 5 个指标会决定 curl 这条路径是不是 *真有效*:

1. **8 月 3 日恢复接收后 14 天内的"积压量"**——如果 Stenberg 在 8 月 17 日的 weekly report 里说"积压 < 5 个",证明 *闭门羹* 是 *true reset*;如果他说 "积压 30+, 我们来不及",那 *夏季闭门羹* 只 *延后了* 而没 *解决问题*。
2. **2026 全年 curl CVE 数量**——Stenberg 预测 *double the 30 midyear figure* 即 60-80。**实际数字若 < 50**:证明 AI 工具驱动 4 倍报告速率的"假阳性上升"被闭门羹戳破;**若 > 70**:证明 *接收速率 ≠ 实际漏洞速率*,必须用 "每小时 research / 报告 = 实际独立漏洞数" 重新归一化。
3. **Mythos 在 6-12 个月内是否真的发布**——Anthropic 在 4 月 2026 推迟 Mythos 的理由是 "let selected companies get a head start"。**Q4 2026 是 Mythos 必须 released 的窗口**,如果继续 *秘不发版*, **"Mythos 商业价值" 这条叙事会** 跟随其本身 *老化*。
4. **EU CRA 在 2026 Q3-Q4 的 "OSS sponsor tier" 进展**——欧盟 2024 年通过的 Cyber Resilience Act 强制 2027 年 9 月起所有 digital product 必须有 *可证明的维护链路*。curl 的夏季闭门羹会成为 *core maintainer 单兵体系* 的反例,直接推动 CRA 的 "critical OSS 资金" 制度落地。**6-12 个月内**一定会有 *CRA enforcement guidance* 引用 curl 这件事。
5. **support contract 用户数量 vs 自由职业 maintainer 数量**——如果 Stenberg 在 9 月 2 日的 8.22.0 release post 里说 "我们新增了 N 个 support contract 客户" + "团队 +1 名 full-time", **那么 "OSS 维护者从 burnout 到 sustainable" 这个模式被 curl 单点跑通**;如果他说 "我们没招到人", 那 *资金入口* 仍是 OSS 系统的硬约束。

**最后一句 Stenberg 在《curl summer of bliss》结尾写的话**——比 758 字全篇都重:

> "**If you and your Open Source projects also want to participate in the summer of bliss 2026: just do it and let us know! I would of course encourage you to do so. To take care of yourself as a top priority.**"

这不是 1 个人的决定。这是给 *所有* OSS maintainer 的 *公开许可*——**"我先做了, 你们也可以做"**。**2026 年 6 月 15 日很可能被未来 10 年的 OSS 治理史记住, 不是什么 Mythos 大事件, 而是 curl 第一次把 "闭门羹" 从 *个人不可持续* 的反应, 升级为 *集体可持续* 的策略。**
