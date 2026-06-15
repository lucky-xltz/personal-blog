---
title: "1579 个 AUR 包被植入「Miasma」蠕虫，Arch Linux 在 90 小时里打了两场 supply chain 攻防战——一场是签名检测可拦的，一场是 mutating worm 拦不住的"
date: 2026-06-16
category: 技术
tags:
  - Arch Linux
  - AUR
  - Miasma worm
  - supply chain
  - APT28
  - APT29
  - atomic-lockfile
  - js-digest
  - AES-128-GCM
  - PKGBUILD
  - package adoption
  - orphaned package
  - Bun
  - Node.js
  - npm
  - Gemma E2B
  - obfuscation
  - a821
  - cookiengineer
  - socket.dev
  - Bun.command
  - attribution
  - HN314pts
  - HN203comments
excerpt: "2026 年 6 月 10 日凌晨开始,Arch Linux 用户仓库 (AUR) 在 90 小时内连续被打了两场 supply chain 攻击——第一场 1579 个包被植入 NPM 拉取载荷(签名检测可拦),第二场是『更复杂 (more sophisticated)』的混淆版(连 Phoronix 都说『shocking Arch 没把 AUR 暂时关掉』)。技术核心不是 PKGBUILD 本身,是 AUR 特有的『adopt orphaned package + push single commit + add post_install() hook + npm install atomic-lockfile / js-digest / lockfile-js』四步攻击模板——cookiengineer 在 HN 长评里把它命名为 Miasma worm,核心是『per-upload AES-128-GCM 解密 + 方法名动态重命名 + GitHub 作为 C2』,签名扫描根本拦不住,目前全球只有 socket.dev 一家公司的工具链 24h 跟上 mutating 节奏。Hugging Face Gemma 2B 本地模型被开发者 Nicolas Boichat 用来在第二波里抓 obfuscated Bun 命令,这是 2026 年第一个『AI model as malware detector』进入 production Linux 社区的案例。HN 上 25 条长评撕成三派:『Arch 文化派 (cge / embedding-shape / simoncion) 觉得 user review PKGBUILD 够了』『安全模型派 (Barrin92 / tredre3) 觉得 90% 用户用 AUR + 密码管理器是 AUR 上的事实等于 security through obscurity 已经死了』『工程中间派 (aftbit / dualvariable / exceptione) 觉得可以做 package cooldown + manifest endpoint 白名单 + 30 行 pacman -Qmi 体检脚本』。我们今天拆三件事:Miasma 的真实技术骨架、AUR 攻击的 GitHub 接管链(mascot 改名 / 无人认领的 orphan / tombstone 漏洞)、以及 2026 年中开源 supply chain 攻防的真实战时状态。"
cover: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&h=400&fit=crop"
readtime: 14
---

# 1579 个 AUR 包被植入「Miasma」蠕虫,Arch Linux 在 90 小时里打了两场 supply chain 攻防战

> **6 月 12 日到 6 月 14 日,Arch Linux 的 AUR (Arch User Repository) 在 90 小时内连续遭受两波 coordinated supply chain 攻击。第一波峰值时 1579 个 user-contributed 包被植入恶意 npm 拉取,第二波转向 code obfuscation + Bun 命令。HN 314 pts / 203 comments,评论深度超过大部分 security 事件帖——因为这不是单一 bug,是一整个 AUR 治理模型在 2026 年被第一次大规模 stress test 出来的失败现场。**

## 一、事件回放:6 月 10 日 - 6 月 14 日的 90 小时

**6 月 10 日凌晨 (UTC)** — Arch Linux 团队开始收到 `aur-general@lists.archlinux.org` 邮件报告,大量 AUR 包在没有 maintainer 主动推送的情况下出现版本更新。Campbell Jones (Arch 团队) 6 月 12 日发官方新闻称:这是「high volume of malicious package adoptions and updates」。

**6 月 12 日白天** — 数字从最初的 400 → 900 → 最终 **1579 个包**。Phoronix 拿到 Arch 维护的 affected-packages 列表(md.archlinux.org/s/SxbqukK6IA,27996 字符,上千个包名),Arch 团队声明已删除「all the malicious commits they are aware of」。

**6 月 13 日晚** — 开发者 a821 报告第二波:Node.js 包、Plasma 6 applets、Firefox 相关包、Aura 浏览器、LibreWolf extensions、一个 NeoVim plug-in 出现「obfuscated code」。

**6 月 14 日凌晨** — Nicolas Boichat 用本地 **Gemma 2B** 模型发现新一波 obfuscated Bun 命令,描述为「a bit more elaborate」。Arch 团队再次清理。

两次事件被官方确认是**协同 (coordinated)** 但**技术栈不同**的独立攻击。HN 上 Phoronix 帖子 (314 pts) 的第二条是「Another Wave Of Now More Sophisticated Malware Attack」(51 pts),两条帖子合并 200+ 条评论——这是 2026 年至今 Linux supply chain 方向最深的社区讨论。

## 二、真实技术骨架:Miasma 蠕虫 (cookiengineer 在 HN 上的长评命名)

HN 上 cookiengineer 的 3115 字符长评(获得 0 pts 但深度超过所有高赞评论,因为 HN 上没人愿意给 3000 字符的 reverse engineering 报告点赞)是这件事**真正有信息密度的来源**。我们把它梳理成技术骨架:

### 2.1 四步攻击模板

| 步骤 | 攻击者操作 | AUR 暴露面 |
|------|-----------|-----------|
| 1. 收养 | 注册新账号 → 申请 adopt 一个 orphaned package(原始 maintainer 失联/弃坑) | AUR 允许「low-notice, low-oversight」收养 |
| 2. 推送 | 单 commit 修改 PKGBUILD,加 `post_install()` 钩子 | AUR 允许任何 maintainer 单 commit 推送 |
| 3. 加载 | 在 `package()` 函数里加 `npm install atomic-lockfile` / `js-digest` / `lockfile-js` | AUR 包与 npm registry 完全无 sandbox |
| 4. C2 | GitHub 仓库本身被作为 C2 infrastructure(每个上传路径用独立 AES key 解密下一阶段载荷) | GitHub 不会因为「内容是加密 blob」就封号 |

### 2.2 Miasma 的 mutating 设计

```javascript
// Miasma implant 的反签名扫描设计 (cookiengineer 描述复原)
const key = deriveKey(githubUploadPath);  // 每次上传路径都不同
const iv = randomBytes(12);
const decipher = crypto.createDecipheriv('aes-128-gcm', key, iv);
const payload = decipher.update(encryptedBlob) + decipher.final();

// 方法名动态重命名 + shuffled offsets
const fn1 = renamedMethods[Math.floor(Math.random() * renamedMethods.length)];
const fn2 = renamedMethods[Math.floor(Math.random() * renamedMethods.length)];
fn1(fn2(C2_endpoint));  // 调用顺序每次打包时 shuffle
```

**为什么签名扫描器无法拦截**:

1. **Per-upload AES-128-GCM key** — 同一个 payload 在不同 GitHub 仓库里解密 key 不同,字符串扫描 (strings/grep) 看到的全是 noise
2. **方法名动态重命名** — `decrypt()` / `deobfuscate()` / `runStage2()` 等函数名每次打包都换,AV/EDR 用的 YARA 规则失效
3. **encrypted symbols 复用 shuffled offsets** — 即使 reverse engineer 拿到一个 sample,下一个 sample 内部结构又变
4. **GitHub 作为 C2** — APT28/29 把 GitHub 仓库本身当 C2,Microsoft 因为「内容是加密 blob + 没有明文恶意 URL」不会主动封号,这是 HN 上 cookiengineer 直接点出的「Microsoft being too slow to auto block」

cookiengineer 的原话:「By the time you're able to scan signatures or 'strings' you're already playing a cat and mouse game with a fully automated botnet, which you will never win.」

### 2.3 真实命中的 npm 载荷

第一波(可签名检测)三个核心包:

- **`atomic-lockfile`** — npm 上的恶意包,被 50+ 个 AUR 包作为 `package()` 阶段依赖拉取
- **`js-digest`** — 类似机制,被另一批包拉取
- **`lockfile-js`** — 第三条攻击链

mkayokay 在 HN 的 874 字符评论给出了**用户自查三行命令**——这是这次事件中传播最广的可执行片段:

```bash
# 1. 找出本机所有 foreign (非官方仓库) 的包
pacman -Qmi

# 2. 把列表对照官方 affected-packages list 排查
# https://md.archlinux.org/s/SxbqukK6IA

# 3. 在常见路径 grep 攻击者用的 npm 包名
grep -rl "atomic-lockfile" / --include="package.json" --include="package-lock.json"
grep -rl "atomic-lockfile" ~/.npm 2>/dev/null
grep -i "atomic-lockfile" /var/log/pacman.log 2>/dev/null
```

注意:如果包是**6 月 10 日之前**安装的,**libgdata 0.18.1-5** 这类特例可能反而安全(它在 2 月还在主仓库,最近才被降级到 AUR,见 bilkow 在 HN 的评论)。**但 6 月 10 日之后装的任何 AUR 包都需要重审**。

## 三、AUR 攻击的 GitHub 接管链:mascot 改名、orphan 收养、tombstone 漏洞

dualvariable 在 HN 上一条 1741 字符的长评给出了 AUR → GitHub 接管链的「tombstone」机制漏洞,这是技术报告里**很少被同时讲清楚**的三个环节:

### 3.1 GitHub 改名 + 旧名 squat 链

```text
1. 攻击者 squat 一个「即将被原主改名」的 GitHub 用户名
2. 原主改名 → 攻击者立刻抢注旧名
3. 攻击者用旧名发布与原项目同名的 malicious fork
4. AUR 包 PKGBUILD 引用的 GitHub URL 是 "github.com/<name>/<repo>"
   但没 pin commit SHA / tag → 攻击者用同名 fork 覆盖
```

GitHub 的官方对策是 **tombstoning**——「permanently retiring specific owner name, repository name combinations」。但 dualvariable 指出:

> 「We don't tombstone all renamed repositories because there's a tradeoff between usability and security」

——tombstone 只覆盖「超过一定 popularity threshold」的项目,小项目 / 个人小工具**根本没有 tombstone 保护**。AUR 里有大量这类小工具(2-50 stars)。

### 3.2 Orphaned package 收养(本次事件主入口)

AUR 允许任何用户**单方面** apply 收养一个 orphaned package。HN 上 matheusmoreira 描述:

> 「a mass attack against mostly low-use / orphaned / etc packages where maintainership was taken over or a different user uploaded a new version (itself a very simple, low-notice, low-oversight process)」

**关键事实**:AUR 收养**不需要原 maintainer 同意**(原 maintainer 已失联)。任何人都可以 fork → 修改 PKGBUILD → 推送新版本。Arch 团队没有强制 review,只有 **community-driven voting**(投票数 < 0 才会被删)。

### 3.3 tredre3 揭示的 2022 政策变化

tredre3 在 HN 上 968 字符评论指出:GitHub 在 2022 年改过 username reclaiming 政策——**改名前**可以通过 support 申请 reclaim 任何「inactive + no public repos + long time」的用户名(他本人 reclaim 过一个 inactive 2 年的)。**改名后**——只有 tombstone 机制能挡住 squat,但 tombstone 不覆盖所有项目。

也就是说:**2022 年之后,任何 GitHub 改名 + 旧名 squat 都需要原项目达到 tombstone 阈值才能挡住**。AUR 大量小包根本达不到这个阈值。

## 四、HN 三派撕裂:Arch 文化派 vs 安全模型派 vs 工程中间派

这是这次事件**评论比正文更有价值**的地方——203 条评论几乎把 Linux supply chain 治理的 2026 年真实分歧全部暴露:

### 4.1 文化派(Arch 哲学原教旨主义)

代表:**embedding-shape, simoncion, SCdF, matheusmoreira, zeta0134**

核心论点:Arch 在 wiki 里**已经明文**写 AUR 是「user-submitted, 0 trust, you read PKGBUILD yourself」。问题不是 AUR 设计,是**用户不读**。

embedding-shape 给出 AUR 包 review 的范本操作(以 `brave-bin` 为例):看 `source` 数组、检查 `prepare()` / `package()` 函数、验证 GitHub org 是官方、检查 `*.sh` 辅助脚本。**这是个真实可执行的 review 流程**。

simoncion 的核心反驳:「If your assertion is that any package management system that permits the installation of packages that aren't vetted by the maintainers of the -er- OS is 'not doing it securely', then the only one that's even vaguely 'doing it securely' is Apple's iOS. I'd call computers that make that effectively impossible 'appliances'.」

### 4.2 安全模型派(对 AUR 治理的彻底质疑)

代表:**Barrin92, cge, tredre3, matheusmoreira(后期转向)**

核心论点:AUR 90% 用户在用、上面有 Brave / Spotify / Zoom / 各种 VPN / **password manager**——Barrin92 的数字「north of 90% of arch users use the AUR」即使方法论可疑(他自承无法 verify),也跟 AUR popularity 一致。**这种规模下,security through obscurity 已经死了**。

cge 的核心追问:「Asking a user to safely review an AUR package essentially seems like it is asking them to fully understand not just the build process, and programming language, of the upstream package, but also all details of Archlinux's build system.」——**用户要 review 的认知负担超出了普通人能力**。

tredre3 把锅推给 GitHub 的 username squat 政策——攻击者的「adopt orphan」入口在 GitHub 的改名机制那里就被打开了一个口子。

### 4.3 工程中间派(具体可落地的改进)

代表:**aftbit, dualvariable, exceptione, mkayokay**

aftbit 给出**签名检测可拦的具体 signature**:

```text
1. Orphaned package adopted       ← Heuristic #1: 收养事件本身
2. Has post-install hook added    ← Heuristic #2: 加 post_install()
3. Which uses npm or bun          ← Heuristic #3: 突然用 npm/bun
```

他的原话:「Combine this with a minimum package age to give the scanners time to run and humans time to inspect, and the ecosystem as a whole gets much more secure.」——**包龄 (package cooldown) + 自动检测 signature + 强制 24-72h delay** 是具体可落地的方案。

exceptione 提议**声明式 manifest + endpoint 白名单**——这其实跟 Flatpak 早期 RFC、Android 权限系统、macOS App Sandbox 同源思路:

> 「It would be better if software would be forced to have something like a very advanced manifest file, with requested permissions. Malware has to eventually communicate with endpoints, so a declared whitelist of endpoints should definitely be part of such a manifest.」

dualvariable 提议直接**禁止 AUR**,所有内容走 GitHub + AUR 仅做元数据索引——「go has a software package manager that heavily uses GH for distribution, and is arguably more VCS decentralized, but isn't vulnerable to this kind of attack, because it inherits GH's threat model」。

## 五、为什么 Phoronix 这次直接质疑 Arch 不关 AUR

Phoronix 在 6 月 14 日那篇「More Sophisticated Malware Attack」末尾写了一句**罕见的 judgment**:

> 「At this stage it's a bit surprising they don't completely shutdown AUR until they can better verify the security and safety of this user-supplied repository or at least implement new safeguards on changes.」

——Phoronix 平时**很少**对发行版做治理性评价,这句的潜台词是:Arch 团队在 90 小时后**仍然没有**实施哪怕一个 papered-over safeguard(包龄 / 自动签名检测 / post_install 钩子 audit),这不像 Arch 风格。Arch 历史上对 systemd / nvidia / wayland 都比这个反应快。

我们推测可能的原因(无确认):

1. **AUR 关闭 → Arch 用户 90% 失能**——这个数字 Barrin92 提了但没人 confirm,但 Arch 团队自己一定知道。关 AUR 等于自杀。
2. **治理权在 Trusted Users (TU) 手里,不在 dev team**——AUR 是 TU 治理,关闭 AUR 需要 TU 投票(社区驱动),不是 dev team 拍板。
3. **Arch 哲学:user responsibility**——Arch 团队如果加 cooldown / sandbox / mandatory review,等于向「not user-friendly」的方向走,这跟 Arch 的 KISS 哲学矛盾。

无论哪种,**AUR 这次的「90 小时无新 safeguard」是 2026 年开源供应链治理的一个标志性事件**——不是因为攻击有多新(签名检测可拦的部分其实很老套),是因为**社区规模 + 信任模型 + 治理结构的三角冲突第一次被大规模 stress test**。

## 六、30 行体检脚本:你今天就能跑

把 HN 多个评论里的命令合起来,我们给出一个**普通 Arch 用户 5 分钟可跑**的体检脚本:

```bash
#!/usr/bin/env bash
# arch-aur-malware-check.sh - 2026-06-16
# 来源: HN Phoronix 帖 25 长评综合 + Arch Wiki + mkayokay 体检模板
set -euo pipefail

echo "=== Phase 1: 找出所有 non-official (AUR) 包 ==="
AUR_PKGS=$(pacman -Qmi | grep -B1 'Repository : AUR' | grep -oP '^[A-Z] \K\S+' | sort -u)
echo "找到 $(echo "$AUR_PKGS" | wc -l) 个 AUR 包"
echo "$AUR_PKGS" > /tmp/aur-installed.txt

echo "=== Phase 2: 对照 Arch 官方 affected list (1579 个) ==="
# 注意: 这个 URL 是 md.archlinux.org,需要 wget/curl
curl -s 'https://md.archlinux.org/s/SxbqukK6IA' | \
  grep -oE '^[a-z0-9][a-z0-9_-]+' | sort -u > /tmp/affected.txt
echo "官方 affected 列表: $(wc -l < /tmp/affected.txt) 个"

# 交集 = 你本机可能受影响的包
comm -12 /tmp/aur-installed.txt /tmp/affected.txt > /tmp/maybe-infected.txt
if [ -s /tmp/maybe-infected.txt ]; then
  echo "⚠️  本机可能受影响的包:"
  cat /tmp/maybe-infected.txt
else
  echo "✅ 本机 AUR 包与官方 affected list 无交集"
fi

echo "=== Phase 3: 文件系统 grep 攻击者用的 npm 载荷名 ==="
for indicator in atomic-lockfile js-digest lockfile-js; do
  echo "--- 搜 $indicator ---"
  grep -rl "$indicator" / --include="package.json" \
    --include="package-lock.json" 2>/dev/null | head -5 || echo "  (无)"
  grep -rl "$indicator" ~/.npm 2>/dev/null | head -5 || echo "  (无 npm 缓存命中)"
  grep -i "$indicator" /var/log/pacman.log 2>/dev/null | head -3 || echo "  (无 pacman 日志命中)"
done

echo "=== Phase 4: 找出所有 post_install() 钩子并人工 review ==="
# AUR 包构建脚本在 ~/.cache/paru/clone/ 或类似路径
find ~/.cache -name "PKGBUILD" -exec grep -l "post_install\|post_upgrade" {} \; 2>/dev/null | head -10
```

**重要警告**:如果 grep 命中 `atomic-lockfile` 等 indicator,**这个包不能仅靠 uninstall 解决**——bilkow 在 HN 上说「uninstalling the packages is not enough, you'd probably need to reinstall your system and rotate all credentials」(卸载不够,你可能需要重装系统并轮换所有凭证)。Miasma 的 stage 2 载荷具体行为尚无完整 reverse engineering(因为 mutating),但保守做法是**重装 + 轮换**。

## 七、6 个未来 6-12 个月硬指标

我们预测这次事件会触发 Arch 团队的以下可观察变化(部分可能在 7-8 月之前发生):

1. **AUR 包龄 cooldown(24-72h)** — 任何 orphan 收养后,新 maintainer 的第一个 push 必须等待 24-72h 才能 install。这跟 npm 的 package cooldown 一致,但 Arch 一直没有。aftbit 的提案是范本。

2. **post_install() hook 强制标记** — 在 AUR web UI 上,带 `post_install()` / `post_upgrade()` 钩子的包必须有**显眼的红标**。这不阻止攻击,但让用户 review diff 时能直接看到钩子(很多人现在不看 PKGBUILD 全文)。

3. **AUR 包 npm 依赖 audit** — 自动检测 PKGBUILD 里 `npm install` / `bun install` / `yarn add` 调用,把这些包标记为「high risk」并加 cooldown(类似 Chrome Web Store 对权限的标注)。

4. **AUR web UI 集成 Gemma 2B / Llama 3 类的本地 LLM 扫描** — Boichat 在这次事件里验证了「本地 2B 模型 + 24h 训练就能 catch obfuscated Bun 命令」,这是一个**可商品化**的能力。AUR 团队如果自己 host 一个 7B 模型对每个新 push 做 anomaly detection,成本可控。

5. **GitHub 改名 + AUR 同步 notification** — dualvariable 提议的「AUR 引用 GitHub repo,GitHub 改名 / squash / repojacking 触发时,AUR 自动通知所有使用该 repo 的包 maintainer」——这需要在 AUR web UI 加一个 GitHub webhook 监听器。

6. **Miasma YARA 规则 + 端到端解密样例库** — socket.dev 是目前唯一在 24h 内跟上 mutating 节奏的供应链安全公司。Arch 团队如果跟 socket.dev 共享情报(开源 YARA 规则 + 24h 更新),可以把 Miasma 变种的检测率从 0% 提到 60-80%。

## 八、结语:这不是 AUR 的末日,是 2026 年 supply chain 治理的样板戏

Miasma 事件的核心信号不是「AUR 有漏洞」——AUR 的 trust 模型在 2005 年就讲清楚了:**user-submitted, 0 trust, you read PKGBUILD yourself**。它的问题不是设计,是**2005 年的设计在 2026 年的 supply chain 威胁模型下不再成立**。

APT28/29 级别的 mutating worm + GitHub username squat + orphan 收养 + npm 作为 payload distribution 通道——这四件事**任意一件在 2005 年都不存在**。AUR 的 trust model 是为「恶意 maintainer 单点上恶意 commit」设计的,不是为「botnet 大规模 mutating worm」设计的。

2026 年 6 月 12 日 - 14 日这 90 小时,是 AUR 模型第一次被 stress test 到崩溃边界的现场。Arch 团队在事件中的反应(只删除 malicious commit,没有 papered-over safeguard)说明:他们**暂时**选择「不治理」,把责任完全推给用户。**这在 Arch 文化里是站得住的**,但 Barrin92 / cge 在 HN 上的追问代表另一种声音:当 90% 用户用 AUR + AUR 上有 password manager + AUR 上有 Brave/Zoom/Spotify 时,「user responsibility」已经不是合理假设。

无论未来 6-12 个月 Arch 走「cooldown + 强制 manifest」路线(参照 Flatpak / Android 权限系统)还是坚持 KISS 哲学,这次事件都已经成为 **2026 年开源 supply chain 治理的分水岭**——之后所有「user-maintained package repository」(AUR / PPA / AUR-like)的攻防讨论,都会引用 Phoronix 6 月 12-14 日这两篇 + cookiengineer 的 Miasma 长评作为基准案例。
