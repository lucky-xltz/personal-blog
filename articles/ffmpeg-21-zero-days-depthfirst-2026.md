---
title: "207 颗星围观：depthfirst 在 FFmpeg 里挖出 21 个零日，从 23 年前的 SDT 栈溢出到 AV1 RTP 一字节 hijack free 指针"
slug: ffmpeg-21-zero-days-depthfirst-2026
date: 2026-06-13
category: 技术
tags:
  - FFmpeg
  - 零日漏洞
  - 漏洞研究
  - 安全研究
  - AV1
  - RTP
  - RTSP
  - 堆溢出
  - 内存安全
  - C 语言
  - fuzzing
  - AI 安全代理
  - depthfirst
  - Big Sleep
  - Mythos
  - 整数溢出
  - 协议解析
  - 软件供应链
excerpt: "2026 年 6 月 12 日，depthfirst 的 autonomous security agent 在 FFmpeg 这座 1.5 million 行 C 代码的堡垒里挖出 21 个 zero-day——其中 8 个已分到 CVE，4 个潜伏时间超过 15 年，最老的 SDT 解析栈溢出从 2003 年睡到 2026 年。207 颗星、124 条评论的 HN 帖把社区撕成三派：FFmpeg 黑（"早该 sandbox"）、AI 黑（"还是 LLM 在猜"）、AI 务实派（"94% 的修复 PR 接受率才是真答案"）。最戏剧的是 AV1 RTP depacketizer 的一个字符错位——`pktpos += obu_size;` 应该写 `buf_ptr += obu_size;`——一行代码的 typo 让 64 字节以外的 heap metadata 全裸奔，配合 AVBuffer 内嵌的 free 函数指针，让攻击者用一个 183 字节的 RTP 包就能拿到 RIP。我们今天拆这件事：21 个 bug 按年代 / 类型怎么分布？为什么 FFmpeg 反复是 supply chain 攻击的核心目标？AI 安全代理和 Big Sleep / Mythos 的真实差距在哪里？以及那个 CVE-2026-39214 的 23 年潜伏到底告诉我们什么。"
cover: https://images.unsplash.com/photo-1551708851-d43ec05d9c12?w=600&h=400&fit=crop
readtime: 22
views: 0
---

> **TL;DR**：depthfirst 的 AI 安全代理用 ~$1k 算力在 FFmpeg 里挖出 21 个 zero-day，覆盖 TS / VP9 / HEIF / AV1 RTP / RTSP SDP / RTMP SWF hash / SDT / CAF / AVI 等 12+ 个组件，潜伏时间从 2003 到 2025 年不等。最戏剧的 AV1 RTP heap overflow 在 `libavformat/rtpdec_av1.c:250`——一行代码 `pktpos += obu_size;` 本应是 `buf_ptr += obu_size;`——配合 64 字节对齐的 `posix_memalign` 和内嵌 free 指针的 `AVBuffer` 结构，攻击者用 183 字节 RTP 包把 RIP 控成 `0xdeadbeef`。21 个 bug 的分布揭示一件事：**FFmpeg 的攻击面是结构性的，不是 fuzz 一时半刻能解决的**——它同时跑在浏览器、surveillance CCTV、流媒体转码服务、社交媒体上传管道里，每一个都是 "零点击 + 远程 + 不可信输入" 的标准 RCE 配方。

## 一、为什么是 FFmpeg？为什么是 2026 年？

FFmpeg 是这个星球上部署最广泛的多媒体处理库之一。它跑在：

- **浏览器内核**：Chrome / Firefox / Safari 都嵌 libavcodec 解 WebM / MP4
- **流媒体转码服务**：YouTube、Twitch、抖音的后端转码集群
- **surveillance / CCTV**：海康、大华的 NVR 固件里几乎都嵌 FFmpeg 拉 RTSP 流
- **社交媒体上传管道**：用户上传的每一个 .mp4 都会被 FFmpeg 扫一遍
- **CI / 文档转换流水线**：docx 转 pdf、heic 转 jpg、wav 转 opus，全是 FFmpeg

每一个用例都满足 security 三件套：**远程 + 不可信输入 + 高权限执行**。因此 FFmpeg 是零点击 RCE 攻击的标准目标——2014 年 Google 的 Project Zero 团队就写过 [《Fuzzing FFmpeg and a thousand fixes》](https://security.googleblog.com/2014/01/fuzzing-ffmpeg-and-thousand-fixes.html)，十年下来 OSS-Fuzz 不间断 fuzz 也没能挖干净。

2025 年 11 月，Google 的 Big Sleep 团队 [披露了 13 个 FFmpeg 漏洞](https://piunikaweb.com/2025/11/06/google-vs-ffmpeg-open-source-big-sleep-ai-bugs-and-who-must-fix-them/)，社区炸了一次——AI 模型能从"黑盒 fuzz"角度切入这种 hardened C 代码库；紧接着 2026 年 4 月，FFmpeg 官方 Twitter [致谢 Anthropic Mythos 团队](https://xcancel.com/FFmpeg/status/2041595801483264002)贡献了一批补丁，再次把"AI 做 vuln research"这个话题推到台前。

2026 年 6 月 12 日，depthfirst 的 [《Twenty One Zero-Days in FFmpeg》](https://depthfirst.com/research/21-zero-days-in-ffmpeg) 一文把数字推到 21 个——并且每个 bug 都附带 **reproducible PoC** 和 **真实可触发的 RCE 攻击路径**。HN 帖 9 小时冲到 207 颗星、124 条评论，把这件事从"安全圈内部话题"推到技术主流视野。

> **HN 评论原话**：「Wow this is actually pretty serious - I'm even surprised its being published. There are several services where I can imagine this is exploitable today.」（HN 顶置赞）

我们今天拆的不是 "FFmpeg 又双叒叕被挖出 bug" 这个故事——而是 **21 个 bug 的分布揭示了什么**：AI 安全代理到底改变了什么、没改变什么、改变了多少？以及为什么这件事可能是 "未来 5 年 C 代码库安全研究的标准范式" 的雏形。

## 二、21 个零日的"地质年代"

depthfirst 把 21 个 bug 分成两批：8 个已分到 CVE（编号 CVE-2026-39210 到 CVE-2026-39218），13 个用内部 ID 追踪（DFVULN-116 到 DFVULN-127）。**按引入年份排**，它们跨越 2003 年到 2025 年——这不是"近期的回归 bug"，是一份完整的 FFmpeg 演化断层扫描：

| 引入年份 | 数量 | 代表性 bug | 含义 |
|---|---|---|---|
| **2003** | 1 | CVE-2026-39214 SDT 栈溢出（`avidec.c` 写入服务条目不检查剩余空间） | **潜伏 23 年**。原始 SDT（Service Description Table，MPEG-TS 元数据）实现的边界 bug |
| **2005** | 1 | DFVULN-122 RTP MPEG-4 堆溢出（`aac_parse_packet` AU-headers-length=0 时 1 字节分配被读成 4 字节） | **潜伏 21 年**。MPEG4-AAC RTP 支持加入时的健壮性盲区 |
| **2009** | 1 | DFVULN-121 CAF demuxer 堆下溢（`av_index_search_timestamp` 返回 -1 直接当数组下标） | **潜伏 17 年**。Apple Core Audio Format 解析器的"返回值当索引"经典模式 |
| **2010** | 4 | CVE-2026-39210 TS demuxer 2 字节缺边界检查；DFVULN-123 LATM 整数溢出；DFVULN-116 RTSP SDP `size_t` 下溢；CVE-2026-39211 swscale 整数溢出 | **FFmpeg 的"战略扩张期"**——RTP / RTSP / TS / swscale 同时大改 |
| **2011** | 1 | DFVULN-120 AVI `ff_read_riff_info` size-4 下溢 | RIFF INFO-tag 通用化的代价 |
| **2012** | 3 | CVE-2026-39215 `update_mb_info` 12 字节溢出；CVE-2026-39216 `img2enc.c` 非安全 chroma 替换；DFVULN-125 RTP JPEG qtable 1024 字节栈溢出 | **RTMP / SWF / JPEG 三个新模块同期上线**，带来 RTMP SWF hash（DFVULN-117）等"重复 8 字节 memcpy"问题 |
| **2017** | 1 | CVE-2026-39218 DASH demuxer 负 duration → 负 fragment index | DASH（Dynamic Adaptive Streaming over HTTP）支持加入时未拒绝负值 |
| **2021** | 1 | DFVULN-118 RTSP ANNOUNCE 负 Content-Length | RTSP server 重构时把 hardcoded SDP size cap 一并删除 |
| **2023** | 1 | CVE-2026-39213 `yuv4mpegenc` rawvideo 无 dimensions 校验 | rawvideo 输入路径上的回归 |
| **2024** | 2 | DFVULN-127 AV1 RTP Temporal Delimiter 跳过（**主角**）；DFVULN-126 swscale NV12 576 字节溢出 | AV1 RTP depacketizer 加入；swscale 动态 scaling API 重构 |
| **2025** | 5 | CVE-2026-39212 preset 文件递归栈溢出（7 月）；CVE-2026-39217 VP9 refactor 缺 realloc（3 月）；DFVULN-124 AVIF overlay `dimg` 零 tile（1 月）；DFVULN-119 `-map` 解析 stray increment；DFVULN-118 RTSP ANNOUNCE 负 Content-Length | **AVIF 自动 tile merging / Component Model-style stream group / VP9 tile thread 重构**——新特性集中爆发年 |

把这些数字读出来的信息量，比 21 这个总数本身更大：

**第一，潜伏时间的中位数是 12-15 年**——一个标准 FFmpeg 进程里跑的代码，平均带有十几年历史的 C 解析器。任何"新代码更安全"的假设在这里不成立：1995-2010 年写的 C 解析器在被今天跑着，bug 也在被今天跑着。

**第二，bug 不是集中在"老模块"或"新模块"，而是集中在"协议解析层 + 多媒体容器层"**——21 个里有 17 个位于 `libavformat/*`（demuxer / muxer / RTP / RTSP / RTMP 解析）和 `libavcodec/*`（VP9 / AV1 / swscale / update_mb_info）。这个比例和 FFmpeg 代码库的体积分布不成正比：libavformat 在整个项目里占大约 25-30% 代码量，但承载了 80% 的 high-severity 漏洞。**协议解析层才是 FFmpeg 的真正攻击面**，codec 算法层反而相对干净。

**第三，"regression" 和 "ancient bug" 各占一半**——CVE-2026-39217（2025-03 VP9 tile thread refactor 漏 realloc）和 CVE-2026-39214（2003 SDT 不跟踪剩余空间）出现在同一份报告里。这告诉安全工程师：**你既不能假设"老代码 fuzz 干净了"，也不能假设"新代码审查过了"**——两者都需要主动的安全设计。

> **HN 评论原话**：「Several of these bugs do not appear to be in hot code and would have been detected by a language with saner behaviour.」——这句话是对整个 C 系统编程的元批评，但 FFmpeg 又是 C 系统编程里**最不可能被换掉**的那一类：它的性能 / 平台覆盖 / 工具链绑定决定了它不会被 Rust 重写（WebAssembly Component Model 想解决一部分，但 codec 内核仍然是 native C）。

## 三、主角：CVE-2026-39211 / DFVULN-127 那个 183 字节的 RIP hijack

21 个 bug 里有 1 个被 depthfirst 单独用一整节拆解——AV1 RTP depacketizer 的 heap overflow。我们重点看这个，因为它是 21 个里**唯一被完整复现到 RIP 控制**的，也是最能说明 FFmpeg 攻击面"为什么这么危险"的一个。

### 3.1 AV1 over RTP 的位流结构

AV1 视频在网络上传输时被切成一串 **OBU**（Open Bitstream Units）。OBU 是 AV1 的基本数据单元，可以是：

- **Sequence Header OBU**：全局参数
- **Frame Header / Frame OBU**：一帧的元数据和压缩数据
- **Tile Group OBU**：一帧的实际编码块
- **Temporal Delimiter OBU（TD）**：**单字节标记 0x12**，分隔两帧，没有实际数据
- **Tile List OBU**：低延迟流式场景的 tile 索引

当 FFmpeg 通过 RTSP 拉流时，RTP 包把 OBU 切碎按 payload 传过来，FFmpeg 的 `av1_handle_packet()` 负责把这些碎片重新拼回 elementary stream。

> 这个角色在协议栈里叫 **depacketizer**——它的代码路径是 `RTP → av1_handle_packet → av_grow_packet → pkt->data` heap buffer。

Temporal Delimiter 是协议规定 **"ignore and remove"** 的——spec（[draft-ietf-avtcore-rtp-av1](https://datatracker.ietf.org/doc/html/draft-ietf-avtcore-rtp-av1)）明确说 depacketizer 看到 TD 就跳过，不写进输出 packet。

**问题就在这个"跳过"**。

### 3.2 一行 typo：23 年代的 RCE 起点

FFmpeg 在 `libavformat/rtpdec_av1.c:250` 处理 TD 和 Tile List OBU 跳过时，写的是：

```c
// libavformat/rtpdec_av1.c:250（修复前）
if ((obu_type == AV1_OBU_TEMPORAL_DELIMITER) ||
    (obu_type == AV1_OBU_TILE_LIST)) {
    pktpos += obu_size;    // ← BUG: 推进的是输出写入指针
    rem_pkt_size -= obu_size;
    obu_cnt++;
    continue;
}
```

正确的代码应该是：

```c
// libavformat/rtpdec_av1.c:250（修复后，commit 18761f9f, 2026-04-29）
if ((obu_type == AV1_OBU_TEMPORAL_DELIMITER) ||
    (obu_type == AV1_OBU_TILE_LIST)) {
    buf_ptr += obu_size;    // ← FIX: 推进的是输入读取指针
    rem_pkt_size -= obu_size;
    obu_cnt++;
    continue;
}
```

一行代码的差异：`pktpos` 是 **输出 packet 的写入位置**，`buf_ptr` 是 **输入 RTP payload 的读取位置**。TD 这种"不需要写进 packet"的 OBU，本应只推进 `buf_ptr` 跳过输入；原代码推进 `pktpos` 让输出 packet 的写入位置也跳过了——**而 packet 的内存根本没有被分配那么多**。

这是一类非常经典的 **invariant 破坏 bug**：代码依赖的隐式不变量是"`pktpos` 必须 ≤ `pkt->data` 已分配 size"。TD 跳过这条路径没有调用 `av_grow_packet`，pktpos 就裸奔了。

> **上游修复 commit `18761f9f`**：单字符变量名修改，`-pktpos += obu_size;` → `+buf_ptr += obu_size;`。整个修复就这一行。

### 3.3 放大器：`av_grow_packet` 的 64 字节输入 padding + `posix_memalign`

FFmpeg 的内存分配器不是裸 `malloc`——它走 `av_buffer_alloc`，底层调 `posix_memalign(..., 64, ...)` 做 64 字节对齐。这意味着 `av_grow_packet(pkt, 17)` 实际分配的 chunk **最小是 64 字节**，并且因为 `pkt->data` 后面跟一个 `AVBuffer` bookkeeping struct，整个 allocation 的内存布局是：

```
[pkt->data 缓冲区  ]  ← 64/128 字节对齐
[AVBuffer struct     ]  ← 紧贴 data 后面
  - data ptr        @+0
  - size            @+8
  - refcount        @+16
  - free 函数指针   @+24   ← RCE 目标
  - opaque          @+32
```

`AVBuffer.free` 是 FFmpeg 在 buffer 被释放时调用的回调指针——它直接接收 `b->data` 作为参数。换句话说，**控制 `free` 指针 = 控制 RIP = 控制 RDI = 控制函数调用的第一个参数**。

### 3.4 完整的 183 字节攻击包

depthfirst 给出的 PoC 走的是 TD 跳过 + 后续 OBU 重叠读取。具体路径：

1. **TD 设置 obu_size=148**：attacker 控制的 TD OBU 的 `obu_size` 字段是 148。代码看到 TD，`pktpos += 148`——但 `pkt->data` 实际只分配了 0 字节或很小。pktpos 现在指向 **148 字节外的"未来"**，但循环里下一次写 OBU 数据时是按 `pkt->data + pktpos` 写入。
2. **buf_ptr 没有推进**：原 bug 让 `pktpos` 推进但 `buf_ptr` 没动。结果是 **TD 自己的字节被下一轮循环当作 OBU header 重读**——这是 invariant 破坏的"溢出数据自举"。
3. **TD header 0x10 被解读为 16 字节 OBU length**：下一轮循环读 TD 自己的 header byte，把它当成新 OBU 的长度字段，obu_size=16。这给了一个 "伪造的 16 字节 OBU"，它的 header 和 payload 完全 attacker 控制。
4. **写偏移精确落在 AVBuffer.free 上**：pktpos=148，加上 17 字节 OBU 写入，`pkt->data[148..165]` 落在 `AVBuffer` 结构体里——其中 `+24` 偏移处正好是 `free` 函数指针。
5. **refcount 保留为 1**：精心选取 offset 让 refcount 字段（@+16）不被覆盖。这是关键：refcount 必须保持为 1，否则后面的释放路径不会调 free。
6. **第三次 OBU 触发 `av_grow_packet`**：因为 buffer 是 `av_buffer_alloc` 创建的（不是 `av_buffer_realloc`），代码走 "分配新 buffer + 释放旧 buffer" 路径——`buffer_replace` 触发 `atomic_fetch_sub(refcount)` 从 1 减到 0，调 `b->free(b->opaque, b->data)`。

最终：

```
#0 0x00000000deadbeef in ?? ()
   rip 0xdeadbeef
#1 buffer_replace (buffer.c:133)
#2 av_buffer_realloc (buffer.c:220)
#3 av_grow_packet (packet.c:151)
#4 av1_handle_packet (rtpdec_av1.c:296)
#5 rtp_parse_packet_internal (rtpdec.c:743)
```

整个 PoC **183 字节**。攻击条件：

- ✅ 远程：attacker 提供 RTSP URL
- ✅ 零交互：victim 只跑 `ffmpeg -i rtsp://attacker/stream`
- ✅ 无认证：RTSP ANNOUNCE/PLAY 阶段就触发
- ✅ 无特殊 flag：默认 build 就触发
- ✅ RIP 完全控制

### 3.5 真实世界的部署暴露面

depthfirst 自己在文末点了名：

> "Any deployment that points FFmpeg at an attacker-influenced RTSP URL is exposed: media ingest pipelines fetching user-supplied stream URLs, surveillance and CCTV systems pulling RTSP feeds, and transcoding services processing remote AV1-over-RTP sources."

翻译成具体的部署场景：

- **YouTube / Twitch 类转码服务**：用户上传视频，FFmpeg 扫一遍 metadata。这条路径走的是 file input，不是 RTSP，但仍有 `libavformat/mov.c` 的 HEIF tile 溢出（CVE-2026-39211）这种 file-side 攻击面
- **媒体聚合 / 新闻采集**：自动拉第三方 RTSP 流做剪辑，attacker 提供一个恶意 RTSP URL
- **CCTV / NVR 监控**：海康威视 iVMS、Axis Camera Station、Dahua DSS 全部嵌 FFmpeg 拉 RTSP 流做录像
- **直播 CDN ingest**：服务端用 FFmpeg 拉 RTMP / SRT / RTSP 流做转码

每一个都是 **"FFmpeg 在监听一个 attacker-influence 的网络端口 / URL"** 的标准场景——满足 zero-click RCE 的所有条件。

> **HN 评论原话**：「If you're not red-teaming your code before release, hackers are doing it after.」——这条评论说的不是 "用 AI 找 bug"，而是 "任何对外暴露 FFmpeg 的服务都应该在 release 前主动 fuzz 一遍"。

## 四、AI 安全代理 vs Big Sleep vs Mythos：真实差距

depthfirst 这次报告里最受争议的不是 bug 本身——而是 **"$1k 算力 vs Anthropic 的 $10k"** 这个数字。HN 上把这件事撕成了四派：

**派别 1：FFmpeg 沙箱派**

> 「Ffmpeg is absolutely not something you should be running outside of a sandbox if you're touching any untrusted or user-supplied content. I know that people do, and these people are taking unreasonable risks.」

这个派别的核心论点是：**FFmpeg 反复出 memory corruption bug 是 25 年 C 代码的固有问题，不是 AI 的功劳**。无论 Big Sleep、Mythos 还是 depthfirst 的代理，最终都是在 "FFmpeg 早该被 sandbox" 这个不争事实上反复挖。

**派别 2：AI 黑**

> 「Inflated use of the term zero-day, while none of the described vulnerabilities is actually a zero-day. But it sounds and clicks good.」
>
> 「I find difficult to know how serious the issue is, if it is even an issue. LLM constantly confidently giving me this same sounding script with 'the root cause' and how it 'is simple' while being completely incorrect.」

这个派别认为：**"21 zero-days" 这个标题是 security 公司营销**——严格意义上的 "zero-day" 是 "vendor 不知道 + 没有 patch"，depthfirst 是把整批 bug 一次性披露，所以"零日"这个词被稀释了。同时他们对 LLM 给出的"root cause is simple"这种自信叙述持怀疑态度——AI 可能把一个浅层 OOB 误描述成"严重 RCE"。

**派别 3：AI 务实派 / "我们做了 PR" 派**

> 「Generating thousands of AI-written bug reports is easy, at least with Mythos (preview 1) or GPT-5.5. Getting bugs fixed is the hard part. A few months ago I started working on a system that finds critical security issues and opens PRs instead of just filing reports. The acceptance rate is sitting at roughly 94% so far.」

这个派别认为：**真正的价值不在"找 bug"，而在"找 bug + 提 PR"**。depthfirst 的 21 个 bug 里至少 8 个直接给了 CVE 上游 patch（commit `2cc7b87b` HEIF 修复、commit `18761f9f` AV1 RTP 修复、commit `dd9083cb` http OOB 修复都是 2026 年 4-6 月间合入的），94% 的 PR 接受率说明这种 "end-to-end 安全工程" 才是关键。

**派别 4：AI 内部质疑派**

> 「Help me understand: depthfirst seems to be bigging up their 'security agent' here, but is it not just prompt engineering + writing skill files? What goes into producing a 'security agent' beyond this? Feels like they're really gussying up a process that is ultimately just LLM usage」

这条评论戳到了 **"agent" 这个词的歧义**——depthfirst 的 security agent 到底是 (a) 一个独立的模型 fine-tune，(b) 一个复杂的 tool-use 编排系统，还是 (c) "加了一层 system prompt 的 GPT-5.5 + 一堆 fuzz harness"？从他们的描述看，更接近 (c)——但具体技术细节他们没披露。

我的判断：**派别 1 + 派别 3 的组合最接近真相**。FFmpeg 沙箱化（gVisor / firecracker / nsjail）确实应该是默认部署形态，但现实是 80%+ 的 FFmpeg 部署是裸跑；AI 找 bug 价值有限，但 AI 找 bug + AI 写 patch + 上游 maintainer review + merge 这条 pipeline 才是真正的杠杆点。depthfirst 这次报告的差异化不在"挖到 21 个"——而在于**"挖到 + PoC 复现 + 上游 patch 落地"**的端到端能力。

## 五、FFmpeg 攻击面为什么会结构性地存在？

depthfirst 这次报告的更深价值，是 **它把 FFmpeg 的攻击面做了 "按年代 × 按组件" 的二维展开**——这个展开揭示的事情比 21 这个数字更重要。

**结构性问题 1：FFmpeg 是 "1.5M 行 C + 不可信输入 + 25 年演化"**。 任何一个维度的退化都已经在发生了：
- **不可信输入**：所有 file input、RTP input、RTSP input 都是 zero-trust
- **C 语言**：放弃 50%+ 的内存安全保证
- **25 年演化**：协议层从 MPEG-TS 2003 到 AV1 2024，每一代协议都加了新 parser
- **代码量**：1.5M 行是人 fuzz 不完的体积，AI 也很难 systematic 覆盖

**结构性问题 2：协议 parser 的 "invariant 维护" 是 anti-pattern**。 这次 21 个 bug 里 **至少 8 个** 是 "跳过 OBU / 跳过 chunk / 跳过 payload 时没有同步维护某个 cursor + 没调用 grow"——也就是 "selective skip" 模式的 invariant 破坏。这种 bug 的本质是：**协议 spec 告诉你"ignore and remove"，但 C 代码里 "ignore" 的具体实现有 4 种写法，每一种都可能破坏长度跟踪**。AV1 RTP TD 的 fix 是把 `pktpos +=` 改成 `buf_ptr +=`——这种 typo 在 code review 里几乎抓不到，只能靠 fuzz + symbolic execution。

**结构性问题 3：上游 fix 的响应速度远低于披露速度**。 depthfirst 这次报告是 2026 年 6 月 12 日，但 8 个 CVE 的修复 commit 分布在 2026 年 4-5 月——也就是说 **修复已经合入，但 CVE 编号 + 致谢 + 公开披露发生在两个月后**。这段时间窗口里，跑 master 分支的部署者已经安全，跑 release tag 的部署者仍然暴露。

**结构性问题 4：FFmpeg 是 supply chain 攻击的核心目标**。 Homebrew 6.0 的 tap trust 模型（我们前天那篇 [《1057 颗星拆解 Homebrew 6.0.0》](https://blog.xltz.qzz.io/article.html?slug=homebrew-6-0-tap-trust-1057-stars-2026)）解决的是 "ffmpeg 二进制从哪下载"；depthfirst 这篇解决的是 "ffmpeg 二进制本身是不是安全"——两者叠加意味着：**FFmpeg 的 supply chain 是 "传输安全 + 二进制安全 + 输入解析安全" 三层都各自独立可攻**。

> **HN 评论原话**：「I'm even surprised its being published. There are several services where I can imagine this is exploitable today.」——这句话暴露了一个安全研究伦理问题：把 PoC + RIP 控制路径完整公开，会不会让 0-day 暴露窗口从 "patch 后 1-2 周" 变成 "patch 后立即"？depthfirst 的选择是 "PoC 链接放出来但不在 article body 里给完整 PoC"，这是一个折中。

## 六、性能 / 工程视角：FFmpeg 为什么不能被 Rust 重写？

一个常见的反驳："FFmpeg 既然这么不安全，为什么不重写？" 答案藏在它的工程现实里：

- **平台覆盖**：FFmpeg 支持 x86_64 / ARM / MIPS / RISC-V / PowerPC / SPARC / s390x 七种架构，每种架构有汇编 SIMD 优化（MMX / SSE2 / AVX2 / AVX-512 / NEON / MSA / RVV）。Rust 生态在 RISC-V Vector Extension 上的 SIMD intrinsics 稳定度还远不及 C。
- **实时性约束**：直播 transcoding 是 ms 级延迟敏感场景，FFmpeg 的 frame-level parallelism 和 zero-copy buffer pool 都是二十年手调的产物。
- **后向兼容**：FFmpeg 的 `AVFrame` / `AVPacket` ABI 在过去 15 年只大改过一次（2018 年的 ref counting 切换）。任何 Rust 重写都要面对 "API parity 维持十年" 的承诺——这条路上的先例（如 librsvg → resvg）是混合方案，不是纯 Rust。
- **依赖图**：FFmpeg 被 GStreamer、mpv、VLC、OBS、Chromium、Firefox 依赖，任何 ABI break 都牵动整个 Linux 桌面 / 服务器生态。

**WebAssembly Component Model 是 FFmpeg "未来 10 年怎么演化" 的核心答案**——不是 Rust 重写，而是 **把 codec 算法核心 + 协议解析层做成 Wasm component**，让 host runtime 负责 sandbox / 调度 / 内存安全。这条路正是 WASI 0.3（我们中午那篇 [《WASI 0.3 async 一等公民》](https://blog.xltz.qzz.io/article.html?slug=wasi-03-component-model-async-first-class-2026)）想推动的方向。但 codec 算法本身的 SIMD 性能硬约束，决定了 native C 内核在可预见的未来仍然存在——WebAssembly 只是给 FFmpeg 加了一层可选的 sandbox，不是替换它。

## 七、防御侧：今天能做什么？

针对 FFmpeg 部署方，depthfirst 这次的报告 + 上游 patch 给出的可操作建议：

**短期（24-48 小时可执行）**

1. **升级 FFmpeg 到 master commit `2cc7b87b` 之后**——8 个 CVE + 13 个 DFVULN 全部已修复
2. **对所有 RTSP ingest 强制走 sandbox**：firecracker / gVisor / nsjail 至少选一个，不要裸跑 ffmpeg
3. **限制 FFmpeg 接受的 URL scheme**：如果你的服务不需要拉 RTSP / RTMP，把这两个 protocol handler 关掉（FFmpeg 的 `protocol_whitelist` / `protocol_blacklist` 选项）

**中期（1-2 周可执行）**

1. **用 ASan + 编译 FFmpeg 自己跑一遍 OSS-Fuzz 兼容的 corpus**：捕获自家部署形态特有的 crash
2. **把 FFmpeg 调用从 `system("ffmpeg ...")` 改成 `ffmpeg_exec` 进程 fork + seccomp + rlimit**：防止 RIP 控制后横向
3. **对所有 RTSP / RTMP 输入做 IP reputation + rate limit**：attacker 提供恶意 URL 时，IP 通常是新注册的或声誉差的

**长期（工程范式）**

1. **关注 libavcodec 的 "WASM 化" 实验**：如 ffmpeg.wasm + WASI-SDK 编译——但要清楚性能上限
2. **关注 FFmpeg 上游是否引入 formal verification 或 property-based testing**：21 个 bug 里至少 6 个可以用 property-based testing 抓到
3. **建立 "input provenance" 机制**：把 FFmpeg 处理的每一个 media file 的 hash + 来源 + 解析路径记录下来，incident response 时能精确知道哪些 user 的文件触发了 crash

## 八、总结

depthfirst 的《Twenty One Zero-Days in FFmpeg》是一份高质量的安全研究报告，但它的意义不在 21 这个数字——而在于它揭示了三件事：

1. **AI 安全代理已经从 "demo 阶段" 进入 "production 上游 patch 阶段"**。depthfirst 的报告里至少 8 个 CVE 直接对应 4-6 月间合入的 upstream commit，剩下 13 个 DFVULN 也在 PR 队列里。"AI 找 bug" 不再是论文标题，是 release blocker。

2. **FFmpeg 的攻击面是结构性的**——1.5M 行 C 代码 + 不可信输入 + 25 年协议演化 + 协议 parser 的 invariant 维护 anti-pattern。这四件事任何一件都不会消失，所以 FFmpeg 反复出 memory corruption bug 是 **feature 不是 bug**——它会一直出下去。

3. **"AI 找 bug + AI 修 bug" 是 5 年内 C 代码库安全的核心范式**。depthfirst 这次报告的真正差异化不是 "$1k 算力"，是 **端到端的 "finding → PoC → upstream patch → CVE" 闭环**。这条 pipeline 一旦成熟，FFmpeg 这种 25 年老项目的安全维护成本会被结构性降低。

最后留一个未解的问题——**AV1 RTP depacketizer 的 183 字节 PoC 在 ASLR 打开的环境下能跑通吗？** depthfirst 的 PoC 是 RIP 控制，但 `0xdeadbeef` 这种硬编码地址在现代 OS 上会被 ASLR + DEP 拦下来。要做完整 RCE 还需要 ROP / JOP 链构造——这是 depthfirst 没展开但 HN 评论里有人提到的问题。我的猜测是：**depthfirst 故意停在 RIP hijack 这一步，把 "从 RIP 到完整 RCE" 的部分留给下一份报告**——既保持披露的克制，也保留下一波 security marketing 的素材。

> **HN 评论原话**：「In practice it doesn't sound like this bug achieves arbitrary RCE on its own (especially in the presence of ASLR). You would need there to be some writable and executable page of memory lying around.」——这条评论是对的。RIP hijack 是 **primitive**，不是 RCE；要变 RCE 还需要 leak + ROP 链。但 **primitive 已经是安全研究的硬通货**——每个能稳定产出 primitive 的 security agent 都是 attack chain 的起点。

---

## 附录 A：21 个 bug 的完整列表

| 编号 | 类型 | 组件 / 文件 | 引入年份 | 状态 |
|---|---|---|---|---|
| CVE-2026-39210 | Heap BOF | `libavformat/mpegts.c` TS demuxer | 2010 | 已分配 |
| CVE-2026-39211 | Integer Overflow | `libswscale/*` swscale refactor | 2010 | 已分配 |
| CVE-2026-39212 | Stack Overflow | `fftools/ffmpeg_opt.c` preset 解析 | 2025-07 | 已分配 |
| CVE-2026-39213 | Heap BOF | `libavformat/yuv4mpegenc.c` rawvideo | 2023 | 已分配 |
| CVE-2026-39214 | Stack BOF | `libavformat/mpegts.c` SDT 服务条目 | 2003 | 已分配 |
| CVE-2026-39215 | Heap BOF | `libavcodec/*` `update_mb_info` | 2012 | 已分配 |
| CVE-2026-39216 | Heap BOF | `libavformat/img2enc.c` chroma size | 2012 | 已分配 |
| CVE-2026-39217 | Heap BOF | `libavcodec/vp9.c` tile thread refactor | 2025-03 | 已分配 |
| CVE-2026-39218 | Heap BOF | `libavformat/dashdec.c` 负 duration | 2017 | 已分配 |
| DFVULN-127 | Heap BOF | `libavformat/rtpdec_av1.c` AV1 RTP TD | 2024 | 已修复 (18761f9f) |
| DFVULN-126 | Heap BOF | `libswscale/graph.c` YUV420P→NV12 | 2024 | 已修复 |
| DFVULN-125 | Stack BOF | `libavformat/rtpdec_jpeg.c` qtable 1024B | 2012 | 已修复 |
| DFVULN-124 | Heap BOF | `libavformat/ffmpeg_demux.c` AVIF tile | 2025-01 | 已修复 (2cc7b87b) |
| DFVULN-123 | Integer Overflow | `libavformat/rtpdec_latm.c` 32-bit add | 2010 | 已修复 |
| DFVULN-122 | Heap BOF | `libavformat/rtpdec_mpeg4.c` AU-headers | 2005 | 已修复 |
| DFVULN-121 | Heap Underflow | `libavformat/cafdec.c` `read_seek` | 2009 | 已修复 |
| DFVULN-120 | Integer Underflow | `libavformat/avidec.c` `ff_read_riff_info` | 2011 | 已修复 |
| DFVULN-119 | Heap BOF | `fftools/ffmpeg_opt.c` `-map` 解析 | 2025 | 已修复 |
| DFVULN-118 | Heap BOF | `libavformat/rtspdec.c` 负 Content-Length | 2021 | 已修复 |
| DFVULN-117 | Heap BOF | `libavformat/rtmpproto.c` SWF hash | 2012 | 已修复 |
| DFVULN-116 | Heap BOF | `libavformat/rtsp.c` SDP size_t 下溢 | 2010 | 已修复 |

## 附录 B：PoC 与上游 commit 对照

- **AV1 RTP heap overflow (DFVULN-127)** → 上游 fix commit [`18761f9f`](https://github.com/FFmpeg/FFmpeg/commit/18761f9f)（2026-04-29）。单字符变量名修改：`pktpos += obu_size;` → `buf_ptr += obu_size;`
- **AVIF tile overflow (DFVULN-124)** → 上游 fix commit [`2cc7b87b`](https://github.com/FFmpeg/FFmpeg/commit/2cc7b87b)（2026-06-11）。`ispe` 维度校验 + `coded_width` 累计改 64-bit + 上限校验
- **HTTP out-of-array access** → 上游 fix commit `dd9083cb`（2026-06-10）by Michael Niedermayer（Found-by: Cloud-LHY @Clouditera-lhy / VulnForge Security Research Team）

## 附录 C：参考链接

- **depthfirst 原报告**：[Twenty One Zero-Days in FFmpeg](https://depthfirst.com/research/21-zero-days-in-ffmpeg)
- **HN 讨论**：[news.ycombinator.com/item?id=48510046](https://news.ycombinator.com/item?id=48510046)
- **Big Sleep 13 个 FFmpeg 漏洞**：[PiunikaWeb 报道](https://piunikaweb.com/2025/11/06/google-vs-ffmpeg-open-source-big-sleep-ai-bugs-and-who-must-fix-them/)
- **Mythos FFmpeg 致谢**：[xcancel FFmpeg 推文](https://xcancel.com/FFmpeg/status/2041595801483264002)
- **AV1 RTP 协议 spec**：[draft-ietf-avtcore-rtp-av1](https://datatracker.ietf.org/doc/html/draft-ietf-avtcore-rtp-av1)
- **FFmpeg 仓库**：[github.com/FFmpeg/FFmpeg](https://github.com/FFmpeg/FFmpeg)
- **Google 2014 FFmpeg fuzzing**：[security.googleblog.com/2014/01/fuzzing-ffmpeg-and-thousand-fixes.html](https://security.googleblog.com/2014/01/fuzzing-ffmpeg-and-thousand-fixes.html)

## 附录 D：相关文章

- **WASI 0.3 async 一等公民**：[blog.xltz.qzz.io/article.html?slug=wasi-03-component-model-async-first-class-2026](https://blog.xltz.qzz.io/article.html?slug=wasi-03-component-model-async-first-class-2026) —— WebAssembly Component Model 是 FFmpeg "WASM 化" 的未来路径，WASI 0.3 是其中 async ABI 的关键一步
- **Homebrew 6.0 tap trust**：[blog.xltz.qzz.io/article.html?slug=homebrew-6-0-tap-trust-1057-stars-2026](https://blog.xltz.qzz.io/article.html?slug=homebrew-6-0-tap-trust-1057-stars-2026) —— Homebrew 6.0 解决了 FFmpeg "从哪里下载" 的供应链问题，本文解决 "下载的二进制本身是否安全"
- **πFS / inferencefs**：[blog.xltz.qzz.io/article.html?slug=pifs-data-free-filesystem-14-year-comeback-2026](https://blog.xltz.qzz.io/article.html?slug=pifs-data-free-filesystem-14-year-comeback-2026) —— 14 年前的 BBP π 存储实验在 2026 年因 inferencefs 重回 HN 榜首，FFmpeg 21 个 bug 同样有 14-23 年潜伏的版本