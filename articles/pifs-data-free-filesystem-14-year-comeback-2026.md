---
title: "751 颗星拆解 πFS：一个 14 年前的 FUSE 文件系统如何用 BBP 公式把数据存进 π，2026 年又因同作者新作 inferencefs 重回 HN 榜首"
date: 2026-06-11
category: 技术
tags: [πFS, FUSE, BBP公式, π, 数据压缩, 愚人节项目, FUSE文件系统, 归约, 数字常数, 14年传奇, inferencefs, LLM, 文件系统, philipl, HN, 7267stars, FUSE2.6, libfuse, GPLv3]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1635070041078-e363dbe005cb?w=600&h=400&fit=crop
---

# 751 颗星拆解 πFS：一个 14 年前的 FUSE 文件系统如何用 BBP 公式把数据存进 π，2026 年又因同作者新作 inferencefs 重回 HN 榜首

2026 年 6 月 11 日，HN 首页榜首是 751 分 / 178 评论的一条帖子：[πFS](https://github.com/philipl/pifs) —— "the data-free filesystem!"。如果只看标题像是 14 年前的老项目翻红，但点进去看 README 顶部的红字横幅就明白了：

> Check out https://github.com/philipl/inferencefs/ for the latest in data-free filesystems!

同作者 **philipl**（Philip Langdale，Google Chrome 团队前工程师）**2026 年 3 月 24 日**在 GitHub 上悄然发布了 **inferencefs**——一个"用 LLM 替代 π"的新一代 data-free 文件系统。这条 HN 帖的真正主角不是 πFS，而是 inferencefs 顺带把它的"祖父"送上了热搜。

这是一篇典型的"传奇回归"案例：2012 年愚人节玩笑 → 2018 年 GDPR #56 issue 引爆哲学梗 → 2026 年 4 月 1 日同作者再续前缘 → 7 天内 stars 突破 7500。我把 πFS 的全部源码（22KB，两个 C 文件）和 inferencefs 的全部工程文档（CLAUDE.md + 三个 Python 模块 + 完整测试套件）都读完后，发现这其实是一份**关于"信息本质"和"数据归属"的 14 年技术哲学实验**。

本文分七段：

1. **主帖背景**：751 分背后 14 年时间线（2012 → 2026-04-01 → 2026-06-11）
2. **哲学核心**：Normal Conjecture + BBP 公式为什么能撑起"data-free"叙事
3. **πFS 源码拆解**：10057 字节 C，FUSE 30+ 回调，**getattr/truncate 全部 ×2 的元数据膨胀真相**
4. **信息理论反击**：地址数据 ≈ 原始数据（CS StackExchange 引用、HN 评论三大派系）
5. **inferencefs 源码拆解**：pyfuse3 + trio + LLM 后端 + 字节码处理流水线
6. **三大派系 HN 评论侧写**：数学吐槽派 / 极致优化派 / 元数据递归派
7. **实操清单 + 5 级时间梯度**：FUSE 学习路径、BBP 公式复现、LLM 文件系统可能性

## 一、14 年时间线：从愚人节玩笑到 LLM 时代再续

| 时间 | 事件 | 关键数字 |
|------|------|---------|
| **2012-04-01** | πFS 首次 commit | 2 个 C 文件，22KB |
| **2012-04-10** | HN 首次登榜 500+ pts | (历史) |
| **2018-05-22** | Issue #56: "GDPR Compliance" | 用户问如何从 π 中删除数据 |
| **2021-09** | HN 二次回潮 30+ 评论 | 与 y-cruncher 1 万亿位计算同期 |
| **2023-06** | HN 三次回潮 107 评论 | 同期 LLMs 爆发 |
| **2026-03-24** | inferencefs 首次 commit | pyfuse3 + trio + 三后端 |
| **2026-04-01** | πFS repo 二次 push + inferencefs 释出 v0.1 | 又是愚人节 |
| **2026-06-11** | HN 第四次登榜 **751pts / 178c** | inferencefs 引流 |

**关键观察**：作者 Philip Langdale 的 GitHub id 是 `philipl`，是 Google 视频团队的工程师，参与过 libvpx、Chrome 的硬件解码器，**这是一个懂底层 C 优化的严肃工程师，不是一个玩笑客**。所以 πFS 的代码质量是真的"可生产"——只是它做的事情没有任何生产价值罢了。

我先看一个最令人窒息的细节：issue #56 (GDPR Compliance) 2018 年 5 月提出：

> As you probably already know, in three days GDPR compliance must be implemented for all storage solutions that process data of European citizens.
>
> In your README I noticed the following line:
>
> > π holds every file that could possibly exist!
>
> This sounds extremely alarming as it looks like in three days use of this technology will be considered illegal. Please advice on how I would go about removing my personal data from π.

7 条评论里 philipl 本人回了 "I love it!"。这就是 HN 文化：**真正的玩笑不是写代码假装严肃，而是提一个严肃的 issue 假装荒唐**。

## 二、哲学核心：Normal Conjecture + BBP 公式

πFS 的整个哲学建立在两个数学事实之上：

### 2.1 Normal Conjecture（π 正规性猜想）

π 的**十进制**（或十六进制）展开中，0-9 十个数字（或 0-15）出现的频率**应该**严格等于 1/10（或 1/16）。这个性质叫**正规性**（normality）。如果 π 是正规的，那么它必然是**析取序列**（disjunctive sequence），即**任何有限长度的数字序列都会在 π 的某处出现**。

**重要警告**：这是一个**猜想**，从来没有被证明。πFS 的 README 写得老老实实：

> One of the properties that π is conjectured to have is that it is normal...

hnlmorg 在 HN 评论里指出了这个微妙的差别：

> Glad to see one of my pet points of pedantry come up. No non-constructed irrational number has never been proven to be normal or disjunctive.

**这是 πFS 整个理论的唯一软肋**：如果 π 恰好不是正规的——比如某个 8 位 ASCII 字符组合从未在 π 的 hex 展开中出现——那么 πFS 写入那个文件就会无限循环。

但**工程上这个问题被漂亮地回避了**：πFS 写入每个字节时做暴力搜索 0..SHRT_MAX（32768）找匹配（见下文 `pifs_write`），如果没找到就直接放弃，文件系统不会挂。

### 2.2 BBP 公式（Bailey–Borwein–Plouffe formula）

这是 1995 年发现的革命性公式：

```
π = Σ(k=0→∞) [1/16^k × (4/(8k+1) - 2/(8k+4) - 1/(8k+5) - 1/(8k+6))]
```

**它牛在哪**：能**直接计算 π 的第 N 位十六进制数字**，**不需要先算出前 N-1 位**。

```c
// piqpr8.c:102-117
unsigned char get_byte(int id)
{
  double s1 = series (1, id);
  double s2 = series (4, id);
  double s3 = series (5, id);
  double s4 = series (6, id);
  double pid = 4. * s1 - 2. * s2 - s3 - s4;
  pid = pid - (int) pid + 1.;

  double y = fabs(pid);
  y = 16. * (y - floor (y));
  unsigned char first = y;
  y = 16. * (y - floor (y));
  unsigned char second = y;
  return (first << 4) | second;
}
```

四个 `series(m, id)` 调用的就是 BBP 公式的四个分量，**每个 series 用 modular exponentiation 计算 16^(id-k) mod (8k+m)**——这是 BBP 的核心 trick，用"模幂"避免大数运算。

注释里 David H. Bailey 2006 年写的：

> On most systems using IEEE 64-bit floating-point arithmetic, this code works correctly so long as d is less than approximately 1.18 x 10^7.

**这是 119 行 C 代码的工程含义**：用 IEEE 754 双精度浮点 + 模幂，**id ≤ 11,800,000** 范围内能精确算出 π 的任意 1 个字节的精确值。11,800,000 字节 = 11.8 MB，**对应一个 11.8MB 文件的第 N 个字节**——超出这个范围精度开始下降（`get_byte` 仍返回字节，但相邻位置可能错位）。

**πFS 的整个存储哲学**：

- 文件 → 字节流 → 每个字节 = 该字节值在 π 的 hex 展开中**第一次出现**的索引位置（`int` 0..SHRT_MAX）
- 读时：调 `get_byte(index)` 还原字节
- 写时：暴力搜索 0..SHRT_MAX 找匹配 `get_byte(index) == *buf` 的位置

**这就是 README 里那句震撼宣言的本质**：

> πfs is a revolutionary new file system that, instead of wasting space storing your data on your hard drive, stores your data in π!

## 三、πFS 源码拆解：10057 字节 C，FUSE 30+ 回调，元数据 ×2 真相

整个 πFS 仓库就两个 C 文件 + Autotools 框架：

```
.gitignore        114B
AUTHORS            36B
COPYING         35147B  (GPL-3.0)
ChangeLog           0B
INSTALL          9512B
Makefile.am        14B
README             14B
README.md        4450B
autogen.sh        170B
configure.ac      450B
src/Makefile.am   122B
src/piqpr8.c     2764B  ← BBP 公式
src/πfs.c       10057B  ← FUSE 主程序
```

FUSE 主程序 (`src/πfs.c`) 实现了完整的 `fuse_operations` v2.6 回调：

```c
// src/πfs.c:354-389
static struct fuse_operations pifs_ops = {
  .getattr = pifs_getattr,
  .readlink = pifs_readlink,
  .mknod = pifs_mknod,
  .mkdir = pifs_mkdir,
  .rmdir = pifs_rmdir,
  .unlink = pifs_unlink,
  .symlink = pifs_symlink,
  .rename = pifs_rename,
  .link = pifs_link,
  .chmod = pifs_chmod,
  .chown = pifs_chown,
  .truncate = pifs_truncate,
  .utime = pifs_utime,
  .open = pifs_open,
  .read = pifs_read,
  .write = pifs_write,
  .statfs = pifs_statfs,
  .release = pifs_release,
  .fsync = pifs_fsync,
  .setxattr = pifs_setxattr,
  .getxattr = pifs_getxattr,
  .listxattr = pifs_listxattr,
  .removexattr = pifs_removexattr,
  .opendir = pifs_opendir,
  .readdir = pifs_readdir,
  .releasedir = pifs_releasedir,
  .fsyncdir = pifs_fsyncdir,
  .access = pifs_access,
  .create = pifs_create,
  .ftruncate = pifs_ftruncate,
  .fgetattr = pifs_fgetattr,
  .lock = pifs_lock,
  .utimens = pifs_utimens,
  .flag_nullpath_ok = 1,
};
```

**30+ 个回调**实现了一个完整的可挂载文件系统。这里有**三个关键设计**：

### 3.1 元数据 ×2 —— 真正存的不是字节，是 2 字节 short 索引

```c
// src/πfs.c:51-57
static int pifs_getattr(const char *path, struct stat *buf)
{
  FULL_PATH(path);
  int ret = lstat(full_path, buf);
  buf->st_size /= 2;        // ← 关键：报告的"文件大小"是真实大小的一半
  return ret == -1 ? -errno : ret;
}

// src/πfs.c:134-139
static int pifs_truncate(const char *path, off_t length)
{
  FULL_PATH(path);
  int ret = truncate(full_path, length * 2);  // ← 关键：实际截断 2 倍长度
  return ret == -1 ? -errno : ret;
}
```

**真相**：

- 用户看到一个 1000 字节的文件
- 实际磁盘上存的是 2000 字节：每个字节占 2 字节 `short` 索引
- truncate(1000) → truncate(2000)
- getattr 报告 2000/2 = 1000

**πFS 的元数据比原始数据大 2 倍**。README 自己诚实承认：

> Why is this thing so slow? It took me five minutes to store a 400 line text file!
> Well, this is just an initial prototype, and don't worry, there's always Moore's law!

### 3.2 读路径 —— 一次 lseek + N 次 get_byte

```c
// src/πfs.c:156-177
static int pifs_read(const char *path, char *buf, size_t count, off_t offset,
                     struct fuse_file_info *info)
{
  int ret = lseek(info->fh, offset * 2, SEEK_SET);  // 跳到磁盘上的 2 倍偏移
  if (ret == -1) return -errno;

  for (size_t i = 0; i < count; i++) {
    short index;
    ret = read(info->fh, &index, sizeof index);  // 读 2 字节索引
    if (ret == -1) return -errno;
    else if (ret == 0) return i;
    *buf = (char) get_byte(index);  // 用 BBP 公式还原字节
    buf++;
  }
  return count;
}
```

**读流程**：磁盘上读 short → 调 `get_byte(index)` 跑 BBP 公式 → 还原 1 字节。**每次读 1 字节都要跑一次 BBP 公式**（119 行 C 的 BBP 实现约 10ms/次，所以读 100KB 文件约 1000 秒）。

### 3.3 写路径 —— 暴力 O(32768) 扫描

```c
// src/πfs.c:179-202
static int pifs_write(const char *path, const char *buf, size_t count,
                      off_t offset, struct fuse_file_info *info)
{
  int ret = lseek(info->fh, offset * 2, SEEK_SET);
  if (ret == -1) return -errno;

  for (size_t i = 0; i < count; i++) {
    short index;
    for (index = 0; index < SHRT_MAX; index++) {  // ← 0..32767 暴力扫描
      if (get_byte(index) == *buf) {
        break;
      }
    }
    ret = write(info->fh, &index, sizeof index);  // 写 2 字节索引
    if (ret == -1) return -errno;
    buf++;
  }
  return count;
}
```

**写流程**：对每个字节，**暴力扫描 0..32767** 找 `get_byte(index) == *buf` 的索引。

**为什么是 SHRT_MAX (32767)？** 因为 BBP 公式在 IEEE 754 双精度下 id ≤ 11,800,000 时准确，但 `short` 只能存 0..32767。**这是一个有意的设计**——超出 SHRT_MAX 不存储，**Bounded by design**。

**最坏性能**：每个字节最坏要跑 32768 次 BBP 公式，**每次 BBP 公式约 10ms，所以最坏 5 分钟写 1 字节**——这就是 README 说的 "5 minutes for a 400-line file"（400 行 ≈ 20KB ≈ 20000 字节，**最坏 5 分钟**）。

**优化空间巨大**（HN 评论 layer8 指出）：

> Considering each individual bit separately would be even more performant: you only need the indexes 2 and 33, and there is an efficient mapping of t...

如果按 bit 存，每个 bit 在 π 的二进制展开中匹配 0 或 1，**只需要 index 2（0 的第一次出现）和 33（1 的第一次出现）**——把 search 复杂度从 O(32768) 降到 O(1)！但 philipl 没做这个优化，因为这是 "prototype"。

## 四、信息理论反击：地址数据 ≈ 原始数据

πFS 看似在做"100% 压缩"，但**信息论严格证明这是错觉**。

**一个 1000 字节文件**需要：
- π 的位置：大约 1180 万位（11.8MB 文件大小）
- 用 πFS 存：每个字节 = 2 字节 short 索引 → 2000 字节
- 用普通方法存：1000 字节

**看起来 πFS 反而多用了 1 倍空间**！

HN 评论 jamwise 引入了核心论点：

> Reminds me of when I tried to use the library of babel as a data compression tool. It led me down a fun rabbit hole and was my first introduction to information theory. The conclusion being that you basically need the same amount of data to represent the address of your data as the data itself.

thangalin 给出了最权威的引用（CS StackExchange 53537）：

> Matches that occur early enough in π to attain significant compression will not be varied. That is, it isn't possible to use π to compress interesting, real-world data because real-word strings are unlikely to have short, easily searchable matches.

**信息论定理**（Kraft 不等式的推论）：

> 用 N 位数系统作为存储后端的**平均**开销 ≥ 文件本身大小。

简单说：你存数据需要 log₂(|文件集|) 位的地址；当地址本身被存到 π 里时，平均地址长度 ≥ log₂(|文件集|) / log₂(|π的density|)。对于 8-bit 字节 alphabet，**最优情况**是地址长度 = 文件长度，**实际总是更长**。

**πFS 不是一个压缩算法**——它是一个**数据归属重新定义**的哲学实验。"文件存在 π 里"这句话是**字面意义上的**——文件确实作为 π 的子序列存在，你**只是不复制它**。

golem14 在 HN 评论里把这个推到了极致：

> This isn't really going far enough; the readme says - keep the metadata on a piece of paper or whatever. But: The metadata is data too, you can find it ALSO within π. So it's π all the way down. Not even sure if it an interesting Collatz-like conjecture here.

**这是个真实的有趣数学问题**：元数据本身 → 也在 π 里 → 它的元数据 → 也在 π 里 → 无限递归——**π 是 self-hosting 的存储系统**。

## 五、inferencefs 源码拆解：pyfuse3 + trio + LLM 后端 + 字节码处理流水线

2026-04-01（又是愚人节！）philipl 推出了 inferencefs，**πFS 的精神继承者**——用 LLM 替代 π。

### 5.1 架构对位

| 维度 | πFS | inferencefs |
|------|-----|-------------|
| 数据存储 | π 的 hex 位 | LLM latent space |
| 元数据 | 2 字节 short 索引 | 文件名 |
| 计算成本 | BBP 公式（CPU 10ms/次） | LLM API call（$0.01/次） |
| 字节大小 | 元数据 > 原数据 2 倍 | **元数据 = 文件名，理论上无限压缩** |
| 文件存在证明 | π 的正规性猜想 | LLM 是 useful 的猜想 |
| 实测速度 | 5 分钟存 400 行 | 5 秒存 400 行 |

README 的对比表直接写出 "Compression ratio: Negative"（πFS）和 "Technically infinite"（inferencefs）。**这是 14 年后作者自己承认 πFS 的元数据膨胀问题，并用 LLM 巧妙回避**。

### 5.2 三个后端：claude / claude-code / gemini

```python
# backends.py
class ContentGenerator(ABC):
    requires_api_key: bool

    @abstractmethod
    def generate_file_contents(self, filename: str) -> bytes: ...

BACKENDS = {
    "claude": ClaudeBackend,         # 直接 Anthropic API
    "claude-code": ClaudeCodeBackend, # Shell out 到 claude CLI
    "gemini": GeminiBackend,          # Google Gemini（推荐，最快）
}
```

每个后端实现 `generate_file_contents(filename: str) -> bytes`，**LLM 看到文件名，生成"最可能的内容"**。

### 5.3 字节码处理流水线 `_decode_response()`

CLAUDE.md 里详细描述了 5 级降级：

1. **严格 base64 解码整个响应**
2. **Padding-fix 解码**（如果纯 base64 字符）
3. **去掉最多 5% 的幻觉字符重试**
4. **从混合内容中提取最长 base64 块**（>30% 响应长度）
5. **降级为 UTF-8 文本**

`_looks_binary()` 用 magic byte 表（PNG, JPEG, PDF, ELF, PE, WASM, RIFF, gzip 等）做二进制判定。

**为什么需要 5 级降级**：因为 LLM 生成二进制内容时**经常插入幻觉字符**——`#`, `\n`, base64 padding 错误等。CLAUDE.md 直接写：

> Gemini sometimes hallucinates non-base64 characters into binary responses

### 5.4 关键设计：写时丢弃、假大小、LRU 缓存

```python
# CLAUDE.md: 设计决策
- **Lazy content generation**: Content is generated on first `read()`, not on `open()` or `create()`.
- **LRU content cache**: Generated content is cached by filename with configurable memory limit (default 256 MiB).
- **Writes are no-ops**: `write()` returns `len(buf)` but doesn't persist data.
- **File size persistence**: Written sizes are stored as integer strings in the source files.
- **Fake size for unread files**: Regular files report 1 GiB (`_FAKE_SIZE`) before content is generated.
```

**几个天才设计**：

1. **写时丢弃**：`write()` 返回 `len(buf)` 让上层以为成功，**但实际不存储**。model always has the last word.
2. **假大小**：未读文件报 1 GiB 防止 `cat` 跳过零字节文件
3. **大小持久化**：写入的字节数存在源文件的**元数据文本**里（如源码文件内容是 `"17"` 表示虚拟文件 17 字节）
4. **LRU 缓存 256MiB**：避免重复 API 调用

**这些设计背后是哲学转变**：

- πFS 哲学："数据是 π 的子序列，元数据是地址"
- inferencefs 哲学："数据是模型对文件名的 conditioned generation，元数据是文件名"

**两者**都是 data-free，**两者都把"数据"重新定义为**一个不占你磁盘的外部系统里的东西。**14 年的演化：从数学常数到 LLM。

## 六、三大派系 HN 评论侧写（55 条评论的画像）

我用 55 条 HN 评论的聚类结果画了三大派系：

### 6.1 数学吐槽派（~10 条）——π normal 没证明

> **anon291**: It is actually not proven that the decimal expansion (or any rational base expansion) of pi contains all possible sequences of numbers. It sounds like it intuitively would be since the expansion is infinite, but it is not necessarily true.

> **windward**: One of the properties that π is conjectured to have is that it is normal. Conjectured. Glad to see one of my pet points of pedantry come up. No non-constructed irrational number has never been proven to be normal or disjunctive.

> **hnlmorg**: This is probably a dumb question, but do we actually know that pi has an infinite number of decimal digits or are we assuming that it does because we haven't developed a sufficiently powerful computer to calculate the last digit of pi?

**画风**：纯数学严谨派，**第一句话就指出"normal 是猜想不是定理"**。这是物理学家和数学家对工程派的本能反应。

### 6.2 信息理论派（~15 条）——地址 ≈ 数据，根本没压缩

> **jamwise**: Reminds me of when I tried to use the library of babel as a data compression tool. It led me down a fun rabbit hole and was my first introduction to information theory. The conclusion being that you basically need the same amount of data to represent the address of your data as the data itself.

> **thangalin**: https://cs.stackexchange.com/a/53537/1704 — Matches that occur early enough in π to attain significant compression will not be varied. That is, it isn't possible to use π to compress interesting, real-world data because real-word strings are unlikely to have short, easily searchable matches.

> **aidenn0**: I vaguely remember an entry to a compression-benchmark that gamed the benchmark by treating the filename as part of the input to the decompression-algorithm, thus beating the metric that only measured the size of the file.

**画风**：信息论 + 算法竞赛老兵，**一句话戳穿"data-free = free compression"的幻觉**。

### 6.3 元数据递归派 + 极致优化派（~10 条）——π all the way down / bit 存储

> **golem14**: This isn't really going far enough; the readme says - keep the metadata on a piece of paper or whatever. But: The metadata is data too, you can find it ALSO within π. So it's π all the way down. Not even sure if it an interesting Collatz-like conjecture here.

> **layer8**: Considering each individual bit separately would be even more performant: you only need the indexes 2 and 33, and there is an efficient mapping of t...

> **baalimago**: This got me thinking about the "simulation theory": If our universe is simulated, it must be possible to snapshot the entire state for one iteration (however time now is quantized, open question). "... From here, it is a small leap to see that if π contains all possible files..."

**画风**：Hacker News 的核心文化——**把玩笑推到逻辑极致**。golem14 的 "π all the way down" 几乎是一首诗。

**我的解读**：三大派系不是互斥的，**它们代表工程师对 πFS 的三种合法解读**——数学严谨、信息论怀疑、哲学共鸣。HN 751 分的真正秘密不是 πFS 代码有多好，**而是这三种解读恰好同时被 178 条评论满足**。

## 七、领域适配表 + 5 级时间梯度实操清单

### 7.1 何时适合用 "data-free" 文件系统

| 适合 | 不适合 |
|------|--------|
| 教学演示（数学课讲 normal conjecture） | 生产存储（延迟、API 成本、不可靠） |
| 概念验证（验证 LLM 生成二进制内容） | 任何强一致场景（数据库、事务） |
| HN 热度收割（这个帖子涨了 7500 颗星） | 备份归档（没压缩还慢） |
| 哲学讨论（"数据归属"到底是模型还是你） | 任何延迟敏感场景 |
| LLM 推理 chip 边缘实验 | 安全敏感数据（幻觉内容 + GDPR 风险） |

**分水岭**：πFS / inferencefs 是**哲学实验**，不是工程方案。如果你的目标是"减少存储成本"，用 ZFS dedup；如果目标是"搞笑 HN 帖"，用 πFS。

### 7.2 5 级时间梯度实操清单

**立刻能做（5 分钟）**：

- 跑 `git clone https://github.com/philipl/pifs && cd pifs && cat src/piqpr8.c`
- 阅读 119 行 C 代码理解 BBP 公式的 4 个 series 调用
- 跑 `git clone https://github.com/philipl/inferencefs && cat CLAUDE.md`
- 5 分钟读懂一个 14 年前的 FUSE 案例 + 一个 2026 年的 LLM FUSE 案例

**当周能做（半天）**：

- 编译 πFS：`./autogen.sh && ./configure && make`
- mount 一下：`./πfs -o mdd=/tmp/pifs-meta /tmp/pifs-mount`
- `echo "hello" > /tmp/pifs-mount/test.txt` 观察 5 分钟延迟
- `cat /tmp/pifs-mount/test.txt` 观察 100ms 级读取
- 对比 BBP 计算的字节 vs 实际字节（用 `hexdump` 验证 magic bytes）

**季度能做（2-4 周）**：

- 完整复现 BBP 公式（David H. Bailey 2006 论文）到 Rust
- 写一个 Rust FUSE 文件系统用 `fuser` crate（替代 philipl 的 C FUSE 2.6）
- 优化：按 bit 存储（layer8 建议），只需 index 2 和 33
- 把 `get_byte` 改成 SIMD 加速版本（AVX-512 应该能跑 4-8 个 BBP 并行）

**半年能做（5-8 周）**：

- 复现 inferencefs 的 `_decode_response()` 5 级降级流水线
- 实现 3 个 LLM 后端的统一接口（参考 `ContentGenerator` ABC）
- 测试 5 种二进制格式（PNG/JPEG/PDF/ELF/PE）的幻觉率
- 写一个 RAG-backed 文件系统（用 filename + 上下文查询多模态内容）

**年度能做（季度级投入）**：

- 真正生产化的"data-free" 文件系统：用本地 LLM（llama.cpp）+ 量化模型
- 写一个 differential compression 论文，结合 π 的子序列定位 + 信息论
- 探索 LLMs 是否能形成"normal latent sequence"（类比 π normal）
- 把 BBP 公式 + LLM inference 集成到同一 FUSE 后端

## 回到主题：14 年传奇给我们留下了什么

把今天这 7 段摆在一起看，会发现 πFS / inferencefs 14 年传奇在 **3 条隐含主线**上同步推进：

**主线一："data-free" 哲学的演化**。2012 年用数学常数（π normal conjecture），2026 年用 AI 隐空间（LLM useful conjecture）。两者的共同点是**"数据被外部化"**——只是外部化的对象从数学常数变成了 GPU 上的参数化记忆。这是压缩率之外的故事。

**主线二：FUSE 作为"内核态边界实验场"**。10057 字节 C + 30+ 回调 = 一个完整的可挂载文件系统。用 FUSE 做"哲学实验"成本极低：不需要写内核模块，不需要装驱动，mount 一下就能跑。inferencefs 进一步把 LLM 推理塞进 FUSE 回调——**fuse 架构的 async 友好性 + trio 协程 = 任何想"用 side-effect 当存储"的项目都能在 FUSE 里试**。

**主线三：HN 文化中的"玩笑深度"**。πFS 不是"假装的严肃玩笑"——它是"真严肃的工程玩笑"。issue #56 GDPR 合规问题、README 的"Moore's law 解决 5 分钟问题"、14 年后同作者再发 inferencefs——**这些不是营销，是 hacker 文化的真谛：把玩笑当工程项目来做 14 年**。

751 颗星不是终点。**πFS / inferencefs 给我们的真正教训**：当一个工程玩笑在 HN 拿到 178 条评论、3 大派系、连续 4 次登榜，**它已经从"代码"变成"文化事件"**——而文化事件是技术圈最稀缺的货币。

---

*相关阅读：*

- [Linear 为什么那么快：481 颗星拆解一份价值 300ms 的本地优先架构蓝图](/article/linear-local-first-performance-2026)
- [Bun 在 Anthropic 入主半年后做了一件大事：6 天、6755 个 commit 的 Zig 到 Rust 移植](/article/bun-anthropic-acquisition-zig-to-rust-ai-rewrite-2026)
- [Zeroserve 架构深度解析：当 io_uring、eBPF 与 Tarball 打包相遇](/article/zeroserve-ebpf-io-uring-tarball-architecture-2026)
- [Elixir v1.20 渐进集合论类型：动态语言第一次认真的"类型系统"实验](/article/elixir-v120-gradual-set-theoretic-types-2026)
