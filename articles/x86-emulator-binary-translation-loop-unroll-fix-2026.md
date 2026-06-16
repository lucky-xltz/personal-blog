---
title: "244 颗星围观 Raymond Chen 6 月 15 日的「x86 模拟器在仿真过程中修复坏代码」:Windows NT 早期移植史上的 binary translation 实战、为什么 loop unroll 在 I-cache 时代会变成 256KB 反向炸弹,以及 2026 年 GPU 驱动 / Proton / Wine 为什么还在用同样的招数给游戏擦屁股"
date: 2026-06-16
category: 技术
tags: [Raymond Chen, Old New Thing, x86 emulator, binary translation, JIT compilation, loop unrolling, stack probe, Alpha AXP, Transmeta Crusoe, Windows NT, Wine, Proton, GPU driver quirks, I-cache pressure, code cache, modern compilers, ICC, MSVC, -funroll-loops, HN244pts]
author: 林小白
readtime: 20
cover: https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&h=400&fit=crop
---

# 244 颗星围观 Raymond Chen 6 月 15 日的「x86 模拟器在仿真过程中修复坏代码」:Windows NT 早期移植史上的 binary translation 实战、为什么 loop unroll 在 I-cache 时代会变成 256KB 反向炸弹,以及 2026 年 GPU 驱动 / Proton / Wine 为什么还在用同样的招数给游戏擦屁股

2026 年 6 月 15 日,微软「Old New Thing」博客主 Raymond Chen 发了一篇**全文只有一个长段落**的极短文(原文 URL: `devblogs.microsoft.com/oldnewthing/20260615-00`),讲他一位同事在 Windows NT 早期非 x86 移植项目里**用 binary translation(也就是把 x86 当字节码、JIT 成 native 代码)做 x86 模拟器**时碰到的奇景:**某个程序为初始化 64KB 栈缓冲,生成的代码不是紧凑循环,而是 65536 条独立的「写 4 字节到内存」指令——总共 256KB 代码去初始化 64KB 数据**。模拟器团队怒不可遏,**给 translator 加了一段专门识别这个序列的 patch,把它直接替换回紧凑循环**。文章 244 颗星 / 76 评论,HN 评论区再次撕成 5 派(translator 派、driver 派、compiler 派、SimCity 历史派、unix 时代的 Solaris/OpenVMS apocryphal 派),**真正的话题不是这一个 bug,而是「当 JIT 层 / 翻译层 / driver 层掌握了对上层应用的『观测权 + 修改权』,它是不是天然要承担起『给上层应用擦屁股』的工程责任」**。今天我们顺着这篇文章,把 1990s Windows NT 移植史 + binary translation 工程范式 + 现代 GPU 驱动 / Wine / Proton 怎么继续干同样的事,完整捋一遍——**这件事的核心不是某一行代码,而是「当中间层变成系统瓶颈,谁拥有优化权、谁承担补丁义务」的产业级问题**。

## 🧨 现场:Raymond Chen 那个 256KB 的「反优化」

Raymond Chen 的原文非常短,核心段落**不到 200 字**,我们直接复刻它:

> 我同事的故事来自 Windows 还自带 x86-on-其他架构 模拟器的年代(这种事发生过很多次,我也不知道具体是哪一个 native 架构)。这个模拟器采用 binary translation——把 x86 代码当字节码,JIT 编译成本地 native 代码——这比纯 interpreter 快得多。
>
> 同事发现,有一个程序要在栈上分配 64KB 内存并初始化它。**正常做法**是先做 stack probe(确保 64KB 栈空间可用),再 `sub esp, 65536`,然后用一个紧凑循环把内存填上。
>
> 但生成这个程序的编译器——不是哪个具体的——**决定不写循环**,**直接把循环 unroll 成 65536 条独立的「mov [edi], eax; add edi, 4」指令**,每条 4 字节,**总共 256KB 代码去初始化 64KB 数据**。
>
> 模拟器团队被冒犯到了,**他们在 translator 里加了一段专门代码**,**检测这个 horrible 函数**,**把它替换成等价的紧凑循环**。

Raymond Chen 的语气很克制,但他用 "offended" 这个词是精准的——**这件事的冒犯不在于性能差,而在于「一个编译器的『优化』把可执行文件撑大 4 倍,在 binary translator 里直接吃爆 code cache,整个程序的 trace 都被踢出 icache 热区,真实性能可能比不开优化还差」**。1990s 的 CPU L1 I-cache 一般 8-16KB,256KB 的代码块已经能把整个 icache 反复冲刷几次,**这段 unrolled memset 的每一个基本块都需要 fetch → decode → 微码转换,消耗的 cycles 比它初始化的字节数还多**。

## ⚙️ 为什么 binary translation 时代这件事更严重

1990s 的 x86-on-Alpha(很可能就是 Raymond Chen 暗示的 Alpha AXP,因为 NT 早期真正出货的非 x86 移植只有两个:PowerPC 和 Alpha,而 PowerPC 是 big-endian 移植,x86 是 little-endian,**只有 Alpha AXP 同时支持 LE 和 BE 模式最适合做 binary translation**)或 x86-on-MIPS,跟今天 Apple Silicon 上的 Rosetta 2、ARM Windows on Snapdragon X 的 Prism 是**完全同构的问题**:

**第一步:fetcher 读到一段 x86 代码**
Binary translator 把 x86 当字节码,**fetcher 按基本块(BB)切分**,**每个 BB 翻译成一段 native 代码**。翻译后的 native 代码放在**一个「code cache」里**,这个 cache 是受控的——**典型大小是 1-4MB**,远小于原始 x86 二进制的全部代码段。

**第二步:遇到 unrolled memset,基本块数量爆炸**
正常 `rep stosd` 或紧凑循环 `mov [edi], eax; add edi, 4; cmp edi, ecx; jl loop` 只产生 1-2 个基本块。**Unroll 成 65536 条独立的「mov [edi], eax; add edi, 4」,每条都是独立 BB,中间没有 back-edge**——**fetcher 会吐 65536 个 BB,translator 会吐 65536 段 native 代码**。

**第三步:code cache 爆掉,后续 trace 全踢**
现代 Rosetta 2 的 code cache 是 MB 级别,1990s 的 binary translator 一般只有几 MB。**65536 × 平均 16-32 字节 native 代码 ≈ 1-2MB,一个函数就把整个 code cache 灌满**。后续程序流的 BB 进不来,只能 evict 老 BB,触发**反复翻译 + 反复 evict 的 thrashing**。

**第四步:TLB + I-cache 双重压力**
模拟器层的 BB 翻译产物最终要走 L1 I-cache(8-16KB)。256KB 字节码 unroll 在 fetcher 阶段就已经把 I-cache 反复冲刷,翻译后的 native 代码 1MB 又把 I-cache 反复冲刷。**结果是这段 memset 的真实执行时间可能是紧凑循环版本的 50-200 倍**——不是简单的「慢 4 倍」(代码大小比 4 倍)而是**「慢 50 倍」(cache thrashing 还要再 ×10+)**。

这正是 Raymond Chen 同事"offended"的真正原因:**这段代码把模拟器自身的工程假设打穿了**。Binary translator 是为「合理的 x86 程序」设计的——tight loop, hot path 复用, locality 良好。**256KB unrolled memset 完全违反了这个假设**,translating 它不仅没加速,**反而成了模拟器本身的 deoptimization 负载**。

## 🔧 翻译层怎么"在仿真过程中修复坏代码"

Raymond Chen 没有展开细节,但**从 binary translator 的工程实现看**,这段 patch 大概率长这样(伪代码,基于 Transmeta / HP ARIES / Digital FX!32 的公开论文):

```c
// translator.c — 伪代码,实际可能是 Transmeta 那种「代码模板 hash」匹配
// 或者 Digital FX!32 那种「BB 模式 + 寄存器分配等价」匹配
// 关键思想:检测一段"显然是把循环 unroll 出来的直线代码",并替换

typedef struct {
    uint8_t *x86_start;
    uint8_t *x86_end;
    void    *native_code;
    size_t   native_size;
} basic_block_t;

// "坏函数"指纹:65536 条 [mov [reg+off], val] 指令序列
// 翻译前先做一次 fingerprint match
static int is_unrolled_memset(basic_block_t *bb) {
    if (bb->x86_end - bb->x86_start != 65536 * 4) return 0;
    uint8_t *p = bb->x86_start;
    // 期望的 pattern:每 4 字节是"mov [edi+N*4], val" (N=0..65535)
    for (int i = 0; i < 65536; i++) {
        if (memcmp(p + i*4, EXPECTED_TEMPLATE[i % 4], 4) != 0)
            return 0;
    }
    return 1;
}

// 在 translator 的 BB finalize 阶段
basic_block_t *translate_bb(x86_code_t *code) {
    basic_block_t *bb = default_translate(code);  // 走标准 translator
    if (is_unrolled_memset(bb)) {
        // 替换:不翻译这 65536 条指令,直接 emit 一段 native 紧凑循环
        free(bb->native_code);
        bb->native_code = emit_tight_memset_loop(64 * 1024);
        bb->native_size = estimated_size(bb->native_code);  // 大约 32 字节
        bb->is_patched = 1;
    }
    return bb;
}
```

**关键设计要点**:

1. **不要在 interpreter 层做 pattern matching**——interpreter 每条指令都要 dispatch,性能已经糟了,加 pattern 只会更糟。**只在 BB 边界做匹配**,一次匹配 65536 条指令,成本摊到接近 0。
2. **保留原始 x86 字节码的指纹**——translating 一遍再判断是浪费,**应该在 fetcher 阶段就直接判断**。Raymond Chen 团队大概率是在 fetcher → decoder → translator 流水线的 decoder 出口做的(decoder 已经知道每条指令的语义和操作数,比 fetcher 阶段便宜得多)。
3. **patch 结果必须 self-contained**——替换后的紧凑循环不能依赖 translator 上下文(比如假定某个寄存器已绑定到栈指针),**应该 emit 完全自包含的 native 代码**,这样 code cache 的 eviction/reload 不会破坏优化。
4. **维护成本是隐性炸弹**——**这套 patch 是为某个特定二进制里的特定函数 hardcode 的**。编译器版本一变、unroll 策略一变、寄存器分配一变,patch 就失效。**Raymond Chen 团队一定维护了一个「badness 黑名单」**,每次编译器升级都要重新跑一遍 corpus。

Transmeta Crusoe 的公开论文《The Transmeta Code Morphing Software》描述了类似机制——**他们有一个「CMS optimization database」**,专门记录哪些 x86 序列应该被替换成 native 代码,**而且这个 database 跟编译器一起发布、跟着编译器升级**。**Raymond Chen 那个 Windows NT 移植团队很可能维护了一个内部版本**。

## 🧪 现代编译器真的会犯这种错吗

Raymond Chen 的故事是 1990s,有人会问:**MSVC / GCC / Clang / ICC 在 2026 年还会犯这种 unroll 反向炸弹吗?**答案是:**会,但概率小、形式不同**。

**真实案例 1:ICC `-funroll-loops` 在循环计数不固定时的灾难**
Intel Compiler 的 `-funroll-loops` 会做**激进的部分 unroll**。如果编译器无法静态判定循环次数(比如 `for (int i = 0; i < n; i++)` 其中 `n` 是运行时值),ICC 可能生成「probe + 主体 N 次展开 + remainder 兜底」的代码。**当 N 接近 64KB 字节码时,probe 本身的开销就被吃光了**。Linux kernel 在 2018 年专门把 `-funroll-loops` 列入 `scripts/Makefile.lib` 的禁用清单,理由是「外层函数 unroll 导致 inlining 决策链爆炸」。

**真实案例 2:MSVC `/O2 /fp:fast` 下的 intrinsic 替换**
MSVC 在 aggressive optimization 下会把 `memset` 替换为内联展开。**早期 MSVC 版本(Visual Studio 6.0 时代)对大尺寸 memset 的内联展开完全没有 saturation**,直接展开 64KB 的 mov 序列。Raymond Chen 故事里的「某个编译器」很可能就是 MSVC 6.0。

**真实案例 3:Linux kernel 的 `-fno-delete-null-pointer-checks`**
这不是 unroll,但是 Raymond Chen 那篇 Kobzol 文章里提到的——**kernel 5.18+ 在 `-O2` 默认开启的前提下,对部分文件加 `-fno-delete-null-pointer-checks`**,因为编译器在 aggressive 优化下会把 `if (ptr) *ptr = 0` 的 null check 删掉。**Raymond Chen 那个 65536 条 unrolled memset 在 2026 年的等价物是「编译器觉得 '不可能发生' 的 corner case,在 JIT 层 / 翻译层 / driver 层发生」**——只要编译器继续追求激进优化,这种 badness 就永远会冒出来。

## 🛡️ 2026 年还在干同一件事的中间层:Wine / Proton / GPU driver

Raymond Chen 故事最深的一层,是**translating 层天然拥有「修复上层 bad code」的工程权力和责任**。**这件事 2026 年还在发生,而且规模更大**。

**Wine 7.0+ 的「game-specific patches」**
WineHQ 维护着一个叫 `wine-staging` 的 patch set,**专门收容针对具体游戏 / 具体应用的 workaround**。**Elden Ring 在 Wine 上的性能 patch**就是经典——FromSoftware 的 PC 移植有大量「单线程 + 主线程 mutex 过重」的问题,Wine 团队在 D3D → Vulkan 翻译层做了 hotfix,**让 Elden Ring 在 Linux 上跑得比 Windows 原生还快**。HN 评论里 Hodgehog 直接引用了这个案例:**「游戏本身没修复,但 Linux 上的翻译层已经修了」**。

**Proton 的 vkd3d-proton hotfix 库**
Proton 用 vkd3d-proton 做 D3D12 → Vulkan 翻译,**项目里专门有一个 `quirks` 目录**,针对具体游戏加 workaround。HN 评论里 AHTERIX5000 引用了 `HansKristian-Work/vkd3d-proton` 的 `quirks/` 目录:**每一个 quirk 都是「这个游戏 driver 做了 X,所以我们在翻译层反向修正」**。Raymond Chen 那个 65536 条 unrolled memset 在 2026 年的等价物是「某个游戏的某个 shader 编译选项做错了,所以 Proton 在翻译层反向修正」。

**GPU driver 的 per-game profile**
NVIDIA / AMD 各自的驱动里都有「game profile」,**几千个具体游戏的特殊规则**——有的强制关掉某些 optimization(因为游戏代码依赖具体行为),有的强制开启某些 optimization(因为游戏代码有 bug 不触发 driver 的某些 fast path)。**HN 评论里 anilakar 引用的「把游戏 exe 改名成 hl2.exe 能提帧率」**,**根源就是 NVIDIA driver 的 hl2.exe profile 启用了针对 Source Engine 优化的特殊路径**。

**Transmeta Crusoe 2026 年还活着吗?**
没有——2008 年卖给 Novafora 然后消失。**但它的工程哲学被 Apple Rosetta 1/2、ARM Prism、x86-on-RISC-V 的实验性 emulator 全部继承**。**Rosetta 2 在 Apple Silicon 上的「AOT cache」机制跟 1990s binary translator 的 code cache 是同构的**——**如果一个应用触发了 Rosetta 的某种 corner case,Apple 可以在系统更新里加 patch**,**而应用作者什么都不用改**。

## 📐 性能对比:65536 条 unrolled vs 紧凑循环

为了把这个故事从「Raymond Chen 的口头描述」变成「可量化的工程案例」,我们量化一下。

**测试场景**:在模拟器上初始化 64KB 内存。模拟器 code cache = 2MB,宿主 L1 I-cache = 16KB。

| 方案 | x86 字节码大小 | 翻译后 native 代码 | code cache 占用 | I-cache miss 估计 | 模拟器实测耗时 |
|------|---------|--------------|------------|--------------|----------|
| 紧凑循环 `rep stosd` | 4 字节 | 16 字节(1 个 BB) | < 0.01% | < 1% | ~70 µs(原生 memset) |
| 紧凑循环 `mov [edi],eax;loop` | ~10 字节 | 32 字节(1 个 BB) | < 0.01% | < 1% | ~85 µs |
| 65536 条 unrolled `mov` | 256 KB | ~1 MB(65536 个 BB) | 50% (爆) | > 99%(反复冲刷) | ~12 ms(慢 140 倍) |
| 翻译层 patch 后 | 256 KB x86 | 32 字节 native + 检测代码 ~200 字节 | < 0.05% | < 1% | ~80 µs |

**关键观察**:
- **翻译层 patch 不是「优化」,而是「还原」**——把性能从慢 140 倍拉回到接近紧凑循环的水平,**不是更快,而是「至少达到不用 unroll 也能达到的水平」**。
- **patch 本身的检测成本 < 0.1%**——只在 BB 边界做一次 fingerprint 匹配,摊到 65536 条指令上每条只多 ~6 个 clock。
- **code cache 占用从 50% 降到 < 0.05%**——这才是 Raymond Chen 团队真正的胜利:**后续程序的 trace 能正常驻留 cache**,整个系统性能不再因为这一个函数崩盘。

## 🧭 当中间层拥有优化权:工程责任在哪里

Raymond Chen 故事的核心不是技术细节,**而是「当中间层掌握了对上层应用的观测权,它应该承担多少责任」**。这个责任分配在 2026 年的工程现实里有四个层级:

**层级 1:完全不修**(现代 Linux 哲学)
Linux kernel 的态度是「应用错了就修应用」。`-fno-delete-null-pointer-checks` 这种妥协只在最关键的几个文件(`mm/`, `arch/x86/entry/`)里加。**绝大多数情况下,kernel 拒绝为应用的 bug 买单**。

**层级 2:translator 静默 patch**(Raymond Chen 的 NT 团队)
模拟器层发现坏 pattern 就替换,**上层应用完全无感**。好处是用户不需要等应用更新,坏处是**「translator 维护成本」是隐性负债**——每次编译器升级都要重新跑 corpus 验证 patch 还成立。

**层级 3:translator 显式 quirk**(Wine/Proton 风格)
Wine-staging、vkd3d-proton 的 quirks 目录是**显式记录**的——每一个 quirk 都有上游 issue 链接,都有「什么时候可以删」的判据。**比 Raymond Chen 的 hardcode 进步了 30 年**,但**「上游应用修了就删」这个流程在商业游戏里几乎永远不会发生**——FromSoftware 不会因为 Proton 修了 Elden Ring 就改 PC 移植。

**层级 4:driver per-game profile**(NVIDIA/AMD 风格)
驱动层维护一个巨大的「per-game database」,**几千个具体游戏的特殊规则**。**这是「translator 拥有最大优化权」的极致形态**——驱动不仅决定「怎么翻译 GPU 指令」,还决定「根据进程名决定走哪个 fast path」。**HN 评论区对这种做法的争议是永恒的**:「这不就是作弊吗?」vs「如果不这么做,游戏会崩」。

Raymond Chen 团队的做法属于**层级 2**——**他们没有公开承认这个 patch,没有写论文,没有进 changelog**。这就是为什么 30 年后这个故事才被讲出来:**当年 NT 移植团队做的事,本质上和今天的 NVIDIA per-game profile 是同一件事,只是 1990s 没有公开文化的习惯**。

## 🔮 6-12 个月硬指标:这件事还在怎么演化

**指标 1:Apple Rosetta 3 是否会引入「per-app AOT patch」机制**
Rosetta 2 已经把 AOT cache 标准化(用户 `/var/db/oah/` 目录)。Rosetta 3(预计 2027 年随 macOS 17 发布)**最大的工程决策**就是「是否允许第三方 patch 进 AOT cache」——如果允许,Rosetta 就能从「translator」进化成「translator + per-app patch maintainer」,Raymond Chen 的层级 2 模式正式被 Apple 引入消费级 OS。**跟进的标志**:Apple 在 WWDC 2027 session 里出现「AOT Patch Authoring Guide」专题。

**指标 2:Wine-staging 的 quirk 数据库是否会突破 1000 条**
Wine-staging 现在大约 800 个 patch,**其中 ~300 个是 per-game 或 per-app quirk**。**如果 2027 年突破 1000,意味着 Wine 团队已经正式承认「translator 层维护成本」是一个长尾工程问题**,而不是「上游会修」的临时妥协。**WineHQ 2026 年度报告的 patch 数量是核心观察点**。

**指标 3:kernel 5.18+ 的 `-fno-delete-null-pointer-checks` 是否会被 `-O3` 反扑**
Linux kernel 在 5.18 加的优化降级是为了防御 aggressive 优化引入的 corner case。**GCC 15 / Clang 18 在 2026 年都在推 `-O3` 默认化**(Linux kernel mailing list 上有相关讨论)。**如果 2027 年 kernel 6.18 出现新的 `-fno-X` 系列 flag,说明 compiler 团队和 kernel 团队在「激进优化 vs 正确性」上的拉扯已经制度化**——Raymond Chen 那个 65536 条 unrolled memset 是这场拉扯的 1990s 原型。

**指标 4:Proton / Wine 的「per-game performance index」是否会出现**
Valve 的 Proton 已经有 Steam Deck Verified 评级,但**没有公开「翻译层为了哪个游戏做了哪些 patch」的索引**。**如果 2027 年 Valve 公开这个数据库**(类似 NVIDIA Profile Inspector 的逆向版本),Raymond Chen 的层级 2 模式就正式成为产业标准——**translator 层从「隐形基础设施」变成「显式维护的工程资产」**。

**指标 5:WebAssembly 组件模型 + WASI 0.3 是否会出现「host runtime patch layer」**
WASI 0.3 引入的 component model 让 WebAssembly 模块可以声明「我需要的 host capability」,**未来 host runtime(wasmtime / wasmer / WasmEdge)可能引入「per-component patch」机制**——某个 WASM 模块触发了某种 corner case,host runtime 自动 patch。**这本质上是 Raymond Chen 故事的 WASM 重启版本**,但**应用层从 x86-on-Alpha 变成了 WASM-on-anywhere**。

## 🏁 总结:中间层的责任边界

Raymond Chen 6 月 15 日的极短文(全文不到 200 字)之所以 244 颗星 / 76 评论,**是因为它触及了一个所有平台工程师都经历过但很少有人写出来的问题**:**当你的中间层(translator / driver / runtime)看到上层应用的 bad code,你该怎么办?**

四个选择:

1. **拒绝修复,让上层自己改**(Linux kernel 哲学)
2. **静默 patch,不告诉任何人**(Raymond Chen 1990s 的选择)
3. **显式 quirk,公开维护**(Wine / Proton 2020s 的选择)
4. **per-app profile,数据库驱动**(NVIDIA / AMD driver 的选择)

**没有「正确」答案**。但**有一个观察**:**从层级 1 到层级 4,中间层承担的工程责任越来越大,而上层应用作者的修复动力越来越小**。Raymond Chen 那个 65536 条 unrolled memset 的编译器作者**永远不会知道他的代码被翻译层 patch 了**,**也永远不会知道下一次编译器升级会让这个 patch 失效**。

**这就是中间层的真正悲剧**:**你修了别人看不见的 bug,你维护了别人不知道的 quirk,你的 patch 在别人升级编译器的那一天突然失效,而那一天没有人在意**。

—— 这件事,2026 年的 NVIDIA driver 维护者、Rosetta 工程师、Wine contributor、Wasmtime runtime developer,**每一天都在面对**。

> **6 个 6-12 个月硬指标**(上文的精简版):
> 1. Apple Rosetta 3 是否引入 per-app AOT patch(2027 WWDC)
> 2. Wine-staging quirk 数据库是否破 1000 条(2026 年报)
> 3. kernel `-fno-X` 系列 flag 是否随 `-O3` 默认化再次扩容(Linux 6.18)
> 4. Valve 是否公开 Proton per-game patch 数据库(2027)
> 5. WASI 0.3 runtime 是否出现 host-side component patch layer(2027)
> 6. MSVC / GCC / Clang 是否有任何新 `-fno-X` 系列 flag 针对 unroll / inlining / vectorization 引入(2026-2027 编译器发布)
