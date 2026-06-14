---
title: "716 颗星围观 Nikita Prokopov 用一段话偷换 Wayland 的『Every Frame Perfect』：当 macOS Tahoe 越来越像 Windows Mobile，UI 设计师到底丢了什么"
date: 2026-06-14 18:00
category: 技术
tags: [Every Frame Perfect, tonsky, Nikita Prokopov, UI animation, macOS Tahoe, Wayland, atomic commit, transition, trust heuristic, smearing frame, smear frame, 716stars, Heer Robertson, info viz, SwiftUI AppKit, 折叠设备, Apple UI 衰退, animation composition, reframe]
cover: https://images.unsplash.com/photo-1551434678-e076c223a692?w=600&h=400&fit=crop
readtime: 18
---

# 716 颗星围观 Nikita Prokopov 用一段话偷换 Wayland 的「Every Frame Perfect」：当 macOS Tahoe 越来越像 Windows Mobile，UI 设计师到底丢了什么

> **摘要**：2026 年 6 月 13 日，独立设计师 Nikita Prokopov（tonsky.me 创办人、Datomic/DataScript 圈资深工程师）在博客发表 758 字的极短文《Every Frame Perfect》，HN 一小时内冲到首页榜首，最终 716 pts / 230 comments。Prokopov 把 Wayland 协议文档里那句「every frame is perfect」（指*原子提交协议保证不掉帧 / 不撕裂 / 不闪烁*）偷换成 UI 设计的「每一帧截图都得是有意义的成品」原则，用 5 段 Apple 自家 macOS Tahoe / iOS 26 的真机录屏做反例。HN 上 230 条评论立刻撕成四派：动画哲学派（动画不该追完美，应该传达意义）、技术归因派（Apple 跨 SwiftUI+UIKit 抽象税）、Wayland 误读派（Prokopov 偷换了原意）、纯粹派（每帧完美会增加 latency）。我们今天拆这件事——为什么一段不到 800 字、没有解决方案、没有代码、只贴了 7 段 Apple 自家 app 录屏的极短博客能在 HN 首页站 30 小时不退？为什么它会被排在 macOS Tahoe 「resize 窗口」2752 pts 的连续剧旁边？为什么这个故事的真正价值不在动画哲学，而在 *它把一个被 UI 圈集体放弃的『注意力精度』重新变成一个可被讨论的工程问题*？

---

## 一、Prokopov 的极短文在说什么

Prokopov 的原文只有 758 字、7 段 mp4 录屏、0 行代码、0 张数据图。**结构极简**：

1. **引子**：他读到 Wayland Book 那句「every frame is perfect」，觉得 UI 设计应该借鉴同样的精神
2. **核心命题**（一句话）：「If I take a screenshot of your app at any moment, it must make sense」
3. **5 个反例**（全部来自 Apple 自家）：
   - Safari 工具栏切换：placeholder 文字从中央消失，但光标从左侧进入——两段动画没同步
   - Photos 应用 Crop ↔ Adjust 模式切换：图片瞬间 snap，但 crop 边框有动画——「a false feeling that something subtly changes」
   - 系统级搜索放大镜：移动轨迹奇诡，路径不对
   - YouTube：把一个矩形从 A 移到 B，路径重叠／交叉——「The technology has outsmarted the programmer」
   - macOS Save 对话框：保存过程中的细节动画肉眼可见地抖动
4. **解释为什么这是问题**：用户看不到代码，UI 是他们唯一能判断产品质量的窗口——UI 抖动 = 开发者没花时间 = 代码也没花时间。这是一种 heuristic，但合乎理性
5. **结论**：「Every frame matters」

**为什么值得单独写一篇**：不是因为他提出了什么新颖理论（这种 heuristic 在 UI 圈被反复讨论过）；而是因为：
- **作者权威性**：tonsky.me 是 Clojure/Datomic 圈顶级独立开发者，写过 9 篇广为流传的 UI 设计短文（如《Where to put buttons》《Two types of design》），有跨圈影响力
- **时间窗口精确**：6 月 9 日 Cupertino Lens 刚发《WWDC 2026: Apple is Folding》——Apple 折叠设备的过渡动画比静态 UI 多了一个量级
- **案例材料来自 Apple 自家**：不是「我们的产品」，是苹果自家 macOS Tahoe——把争议推到最大化
- **三源材料都现成**：Wayland Book 原文（解释 Prokopov 的「偷换」）、Heer & Robertson《Animated Transitions in Statistical Data Graphics》（动画界的「valid intermediate state」原则）、macOS Tahoe 2752 pts 的连续剧（社区已经积累了对 Tahoe 动画的愤怒）

## 二、Wayland 原句的真正含义 vs Prokopov 的「偷换」

**Wayland Book 原文**（被 Prokopov 引用，被 HN 用户 bigtones 翻出上下文）：

> A stated goal of Wayland is "every frame is perfect". To this end, most interfaces allow you to update them transactionally, using several requests to build up a new representation of its state, then committing them all at once.

Wayland 用「every frame is perfect」指的**不是** UI 的视觉完整性，而是 *GPU 渲染管线的原子性*——保证 *tearing、lag、redrawing、flicker 永不出现*。这是底层协议设计原则，不是应用层 UI 哲学。

**Prokopov 把这句话**：

| 维度 | Wayland 含义 | Prokopov 含义 |
|------|--------------|--------------|
| 关注层 | 协议 / 内核 / GPU 驱动 | 应用层 / UI 设计 |
| "frame" 含义 | 一个 GPU 提交批次 | 一张 UI 截图 |
| "perfect" 标准 | 无撕裂 / 无闪烁 / 无重绘 | 视觉上有意义 / 自洽 |
| 谁负责 | Wayland compositor | 应用开发者 |

**为什么这个「偷换」值得讨论**：

bigtones 在 HN（rank 13 by length）直接指出：
> The entire premise of this article is wrong and derived from a misquote. Kristian Høgsberg, in Wayland stated his goal was a system in which "every frame is perfect, by which I mean that applications will be able to control the rendering enough that we'll never see tearing, lag, redrawing or flicker." It had nothing to do with "if I take a screenshot of your app at any moment, it must make sense."

但他也没说 Prokopov 的「重定义」本身没价值——只是反对「你用了别人的词却不承认重定义了」。这是一个**正当的方法论问题**：跨领域类比是否需要标明？

## 三、为什么 macOS Tahoe 是放大镜：2752 pts 已经在排队

Prokopov 不是第一个抱怨 Tahoe UI 的人。HN 上 *The struggle of resizing windows on macOS Tahoe*（2752 pts / 1207c，作者 noheger，2026-01-11）是 2026 年初的标志事件；2 月 12 日续集 *Resizing windows on macOS Tahoe – the saga continues*（876 pts / 522c）；DaringFireball 的 *macOS 26 Tahoe's Dead Canary Utility App Icons*（405 pts / 187c）；EclecticLight 的 *macOS Tahoe brings a new disk image format*（382 pts / 139c）。

**Prokopov 把这条愤怒延长到「动画哲学」层**——之前所有 Tahoe 帖子都是 *特定功能坏了*，他是 *普遍美学坏了*。这也是为什么他的 758 字能站住首页 30 小时。

**HN 评论里直接挑明这条线的 rayiner**：
> Excellent article. The examples from Mac OS Tahoe show how sloppy the work is. Just lazy shit done without attention and care. Steve Jobs would have fired a bunch of people. And this stuff matters... The animations in iOS 26 and MacOS Tahoe feel wrong. Almost like an uncanny valley. It makes the UI unpleasant to use.

这条评论 487 字符，0 个 emoji，0 个 meme——是 *substantive critique*。HN 排序算法对它的处理是放到 kids_count = 0（无人回复），但它出现在「length top 25」里。说明 Prokopov 的文章**激活了一段已经存在的愤怒**。

## 四、HN 四派阵营的具体分歧

| 阵营 | 标签 | 核心立场 | 代表引用 |
|------|------|---------|---------|
| 哲学派 | 「动画要传达意义，不是追像素完美」 | notglossy（rank 3） | "Animation should convey meaning, not achieve pixel-perfect morphs between states." |
| 技术归因派 | 「Apple 的 SwiftUI + UIKit 抽象税」 | iamcalledrob（rank 5） | "UI code needs to be structured with animation in mind... you encapsulated a few of the moving pieces in abstractions... copy+pasting animation logic inside each (now leaky) abstraction" |
| 误读派 | 「Prokopov 偷换了 Wayland 原意」 | bigtones（rank 13） | "It had nothing to do with 'if I take a screenshot of your app at any moment, it must make sense.'" |
| Latency 派 | 「每帧完美就增加 latency」 | renox（rank 30） | "each time someone say this they 'forgot' that one side effect of 'every frame is perfect' is that it can increase latency.. Perfection or latency?" |
| 完全空心派 | 「只贴现象不给方案 = 空洞 critique」 | dagmx（rank 2） | "A more competently written article would have focused on why anything shown is bad for the end user, and how they might handle it instead." |

**5 派之间的真正分水岭**：

- **哲学派 vs 误读派**：都在说「Prokopov 的原则有问题」，但理由不同——哲学派说「原则错」，误读派说「原则移植过程有诈」
- **技术归因派 vs Latency 派**：都在说「Apple 的 UI 不可能完美」，但归因不同——前者归到 *SwiftUI/AppKit 抽象*，后者归到 *每帧完美本身的成本*
- **完全空心派独立成队**：批判的不是 Prokopov 的原则，是 *他没给替代方案*——这条评论对启发性短文普遍有效

**mbostock（Mike Bostock，D3.js 创始人，rank 10）插入学术锚点**：
> There's a similar principle of congruence in information visualization, stated in Animated Transitions in Statistical Data Graphics by Heer & Robertson as: "Maintain valid data graphics during transitions. To ensure viewers' mental models are congruent with the semantics of the data, we suggest that, as much as possible, intermediate interpolation states remain valid data graphics."

——这条评论把 Prokopov 的 *heuristic* 接到 2007 年 Heer & Robertson 的学术框架上。**学术框架要求的是「valid intermediate state」，Prokopov 把它转译成了「meaningful screenshot」**。两者在动画语义学里其实一致，但 Prokopov 走的是「主观感觉」路径。

## 五、Apple 自己的 UI 工程债务：折叠设备时代会放大

Prokopov 帖子里没提的，但 jauntywundrkind（rank 7）提到了一个独立变量——**Apple 折叠设备**。

Cupertino Lens 6 月 9 日的 WWDC 2026 总结帖指出：Apple 折叠设备会让「transition between form factors」成为 UI 工程师的新责任维度。当设备状态有 3 个（折叠 / 半开 / 全开）× 5 个 app 类别 × 10 个共用组件——**动画空间呈 3×5×10 = 150 倍扩张**。

**这条评论触及的更深层问题**：

Apple 现在 UI 抽象有 3 层：
1. UIKit（2014 之前）
2. SwiftUI（2020+）
3. 跨 SwiftUI + UIKit 混合（2024+ Tahoe 起推荐）

jadar（rank 9）说：
> I think a lot of these are because Apple has built animations into their products as first-class citizens, but that means that they need to somehow figure out how to compose them well. (Which obviously is a rather difficult problem to solve!) In my experience, you end up spending a lot more time trying to get all of the animations to work well together than you do on creating the actual UI, and that time is just not worth it if your start and end states are beautiful and intuitive. There's also the cross-UI-framework tax that has come up since Apple has allowed mixing SwiftUI and (App|UI)Kit, and animations are part of that.

——jadar 把 Prokopov 的现象级观察直接接到 SwiftUI/AppKit 抽象税上。**这才是 Tahoe 动画问题的真实技术归因**，不是「开发者偷懒」。

## 六、Smear Frame 的合理化：动画界 vs UI 界的根本错位

HN 评论里出现频率最高的反驳是 *smear frame*（动画业界称为「中间帧脏帧」）：

naet（rank 24）：
> I think it's not uncommon for good animations to cheat a bit while in motion, rather than look perfect on every frame. Like how cartoons can use smear frames that look bizarre when paused at the wrong time but when viewed as part of a larger animation help sell the motion visually.

paytonjjones（rank 28）直接贴图：*Donkey Kong in Super Smash Bros. Ultimate* 的 smear frame 截图——任天堂业界顶级动画就是这么做的。

**为什么这条反驳在 Prokopov 的论域里失效**：

- 卡通 smear frame 是 *故意制造视觉欺骗*——读者知道这是 24fps 抽帧下的中间产物
- UI 动画的中间帧是 *用户实时感知的*——他们不知道也不需要知道这是「24fps 抽帧」
- 类比失误：把 *2D 卡通* 的时间压缩 *artifact* 拿到 *实时 UI* 的空间过渡上

vlovich123（rank 23）看清这点：
> It would have been compelling to describe / show what it should have looked like. Because the only alternative for some of these would just be sharp jumps instead of any animation - animating simultaneous appearance and transition of information will inherently result in frames that look imperfect.

——**vlovich123 直接说出 Prokopov 没说的关键限制**：「动画的存在本身必然产生 imperfect frame」。如果你要 *every frame perfect*，唯一办法是 *不要动画*——但 renox（rank 30）已经反驳：每帧完美 + 0 动画 = 增加 latency（因为 compositor 等待所有状态原子化）。

**结论**：Prokopov 的原则在「无动画瞬间」和「有动画瞬间」之间存在**不可避免的 trade-off**，他没指出来。

## 七、对前端的务实建议：3 步实现「基本不抖动」

不追求 every frame perfect（不现实），追求 *flicker-free intermediate*（可实现）：

1. **拆解动画责任**：每个视图层级明确「我管什么动画」「我不参与什么动画」。SwiftUI 推荐 `.animation(_:value:)` 把动画绑在 *状态值* 上，避免 *transition 隐式叠加*；UIKit 用 `UIView.transition(with:duration:options:)` 替代多段 `UIView.animate`
2. **同步起点**：当多个动画必须并发时，**强制同一 trigger**，不要让 placeholder 文字从一个 state 出发、cursor 从另一个 state 出发
3. **延迟 vs 流畅 trade-off**：macOS Tahoe 默认开了 *rich animations*——可在 System Settings → Accessibility → Display → Reduce motion 关掉。对延迟敏感的用户应该默认开启

## 八、6-12 个月可被验证的硬指标

| 指标 | 当前基线 | 6-12 月预期 |
|------|----------|------------|
| Prokopov 文章评论数 | 230 | 12 个月后 < 600（这是 heuristic 类帖子的天花板） |
| macOS Tahoe「resize 窗口」后续帖 pts | 2752 → 876 → 持续下降 | 如果 Apple 修复，2026 年底 < 500；如果没修，类似批评帖会再 1000+ |
| Apple SwiftUI/AppKit 抽象税的公开技术债务数 | 0 | 第一份 Apple 内部承认或外部系统性 catalog 出现 |
| 折叠 iPhone 的动画吐槽帖 | 0 | 第一份 ≥500 pts 折叠动画吐槽帖出现（预计 2027 H1） |
| Heer & Robertson 论文被 HN 引用的次数 | 1 次（mbostock 这次） | 增长到 3-5 次/年 |
| Wayland 原句被跨领域类比的次数 | 1 次（Prokopov） | 0（预期：这种「跨界类比」会被社区标记为不严谨） |

---

**结尾**：Prokopov 的 758 字没有给出解决方案，没有代码，没有数据图——但它激活了一个 2024 年以来在 UI 圈集体放弃讨论的「注意力精度」议题。**这不是「He solved UI animation」的故事，而是「He put the topic back on the table」的故事**。对前端工程师的可操作结论是：放弃 *every frame perfect* 的极端追求，专注 *flicker-free intermediate*——前者不现实，后者 3 步可达。对设计师的可操作结论是：当 7 个平台 × 3 个状态 × 多个动画并发时，**Heer & Robertson 的「valid intermediate state」才是可工程化的指导原则**，不是 Prokopov 的「meaningful screenshot」。

**附**：本文未触及但值得未来深挖的 3 个方向：（a）Wayland compositor 在 *v-sync 失败时的 fallback 协议*——为什么 Wayland 的 every frame perfect *是* 一个工程约束，不是修辞；（b）macOS Tahoe Reduce Motion 默认开启率——Apple 用 Accessibility 设置作为对自身动画哲学的隐含承认；（c）smear frame 在 *60fps vs 120fps ProMotion* 下的可见性差异——Apple 自己有没有内部数据？
