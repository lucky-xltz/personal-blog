---
title: "Azure Linux 4.0：微软首个通用 Linux 发行版的 4 年演化与 declarative overlay 工程革命"
date: 2026-06-06
category: 技术
tags: [Azure Linux, Linux, Fedora, 操作系统, 供应链安全, Microsoft, CBL-Mariner, declarative overlay]
author: 林小白
readtime: 13
cover: https://images.unsplash.com/photo-1629654297299-c8506221ca97?w=600&h=400&fit=crop
---

# Azure Linux 4.0：微软首个通用 Linux 发行版的 4 年演化与 declarative overlay 工程革命

2026 年 5 月底的 Open Source Summit North America 现场，Kubernetes 联合创始人、如今微软 Azure Cloud Native 平台 CVP 的 Brendan Burns 平静地说了一句话：「我们做 Azure Linux 4.0 了」。台下 Linux 基金会 CEO Jim Zemlin 把他叫回台上确认：「你刚才是不是真的宣布了一个微软的 Linux 发行版？」Burns 答：「是的。」全场沉默。

这不是又一个厂商定制版——它是微软第一个**通用**（general-purpose）Linux 发行版，第一次能跑在**任意** Azure VM 上（不再只服务于 AKS），并即将登陆 WSL。从内部基础设施到对外产品，从 Debian 到 RPM 再到 Fedora 上游，从手写 spec 文件到 declarative overlay 声明式定义——Azure Linux 4.0 背后藏着的是一场为期 4 年、跨越三种技术路线的操作系统工程演化。

## 一、从 CBL-Delridge 到 Azure Linux 4.0：4 年三次重构

### 1.1 起点：CBL-Mariner（2019–2022）

Azure Linux 4.0 的故事要从 2020 年 11 月说起——当时微软在 GitHub 公开了一个叫做 `CBL-Mariner` 的仓库。CBL 是 Common Base Linux 的缩写，是一个以**西雅图地名**命名的 Linux 家族：Delridge（Debian 系，给 Azure Cloud Shell 用）、Mariner（RPM 系，给 Azure 内部服务用）。其中 Mariner 是唯一活下来的那个。

Mariner 不是从零写的——它的 spec 文件借鉴了 VMware Photon OS、Fedora、Linux From Scratch。2022 年 4 月发布 2.0，2023 年成为 AKS 节点的容器宿主 OS，2024 年 3 月正式改名 **Azure Linux 3.0**。

这条线的核心特征是**逐个 spec file 维护**：每个 RPM 包的构建脚本都是手写的、对上游做精确的偏置（patch）然后编译。这套模式让微软对每一个二进制有完全的可见性和控制力，但代价是巨大的维护成本——上游 Fedora 一旦有 5000 个包更新，Azure Linux 团队也得跟上。

### 1.2 转折点：选 Fedora 43 作为上游（2026）

Azure Linux 4.0 最大的工程决策不是「变成通用 Linux」，而是**放弃逐 spec 维护模式，改用 declarative overlay 跟踪 Fedora 上游**。这意味着：

- **上游策略**：从 Fedora 43 快照拉取，再叠加「声明式 overlay」
- **overlay 是什么**：每个对上游的偏离（patch、新增文件、移除文件、构建参数修改）都写成一个结构化声明，附带 `description` 字段解释「为什么要改」
- **不再 fork**：overlay 是「相对上游的差量」，不是「重写后的副本」。这跟传统 `.patch` 文件 + fork 模式完全不同
- **可审计**：所有 overlay 都和组件定义放在一起，方便审计「Azure Linux 跟 Fedora 到底差在哪」

这个转型的本质是把「同步上游」的工程问题从「手动同步 5000 个 spec 文件」简化成「重新渲染一遍」——上游升级变成一次机械化的批处理。

### 1.3 改名背后：营销与工程的统一

2024 年 3 月改名 Azure Linux 3.0 时，Mariner 内部代号被废弃；2026 年 4.0 进一步剥离了「Azure-only」的隐含语义——明确表示这不再只是 AKS 内部 OS，而是可以独立部署的发行版。

## 二、declarative overlay：定义一个现代 Linux 发行版的新范式

### 2.1 仓库结构：TOML 驱动的发行版声明

Azure Linux 4.0 仓库的根目录不是一堆手写的 spec 文件，而是一个 TOML 配置树：

```text
azldev.toml        # 顶层入口
├── distro/        # 发行版级配置（源、mock 配置）
└── base/          # "base" 项目：组件、镜像、测试
    └── comps/     # 组件定义（每个源包一个）
    └── images/    # 基础镜像定义
```

`azldev` 是微软为此专门开发的开源工具链——它的职责很简单：**把 TOML 配置应用到 Fedora 上游的 spec 源文件，渲染出最终的 .spec 文件**。渲染结果会被 `git commit` 进来用于审计（[`specs/`](https://github.com/microsoft/azurelinux/tree/4.0/specs) 目录），但**不能手动编辑**——它们是「derived output」。

### 2.2 overlay 的三种类型

overlay 是在组件定义中描述的对上游 spec 的一组结构化修改，**永远带 `description` 字段**说明修改动机：

```toml
# base/comps/kernel/example-overlay.toml
[overlay]
description = "Azure Linux 需要启用 Hyper-V 优化和 ASLR 全开"

# 1. patch：上游 patch 文件
patches = [
    "0001-azure-tuned-cgroup-v2-mount-options.patch",
    "0002-enable-full-aslr-on-boot.patch",
]

# 2. 移除：不要的子包
[overlay.removes]
subpackages = ["kernel-debug", "kernel-tools-libs"]

# 3. 构建参数：覆盖上游默认值
[overlay.build]
configure_flags = ["--with-extra-version=-azl", "--enable-kvmi"]
```

相比传统 `sed -i` 修改 spec 文件，这种声明式定义的优势在于：

| 维度 | 传统 spec fork | declarative overlay |
|------|---------------|---------------------|
| 上游升级 | 手动 rebase，冲突要解 | 重新跑 azldev，冲突结构化 |
| 审计 | 翻 commit history 找 sed | 看 overlay.toml 的 description |
| 上游贡献 | 复杂的 patch 拆分 | overlay 内的 patch 可独立推上游 |
| 维护成本 | O(包数) | O(overlay 数) ≈ 几百 |

### 2.3 镜像构建：KIWI NG 取代手写 systemd

Azure Linux 4.0 的镜像定义（VM、container、WSL distro）都交给 [KIWI NG](https://osinside.github.io/kiwi/) 处理——这是 openSUSE 出品的镜像构建框架。KIWI 用 XML/YAML 描述镜像布局，然后执行构建：

```xml
<!-- base/images/azure-linux-vm/image.xml -->
<image schemaversion="7.5" name="azure-linux-vm">
  <description type="system">
    <author>Azure Linux Team</author>
    <contact>azurelinux@microsoft.com</contact>
  </description>
  
  <preferences>
    <type image="vm" filesystem="ext4" boot="grub2"/>
    <version>4.0.0</version>
    <packagemanager>dnf5</packagemanager>
  </preferences>
  
  <repository type="rpm-5">
    <source path="https://aka.ms/azurelinux-4.0-repo"/>
  </repository>
  
  <packages type="image">
    <package name="kernel"/>
    <package name="systemd"/>
    <package name="azurelinux-release"/>
    <package name="cloud-init"/>
  </packages>
  
  <packages type="image" patternType="plusRecommended">
    <namedPattern name="pattern:azure-linux-base"/>
  </packages>
</image>
```

`azldev` + KIWI 的组合让 Azure Linux 团队可以**用同一份 TOML 配置同时产出 VM 镜像、container base、WSL tarball**——一源多产物。

## 三、4.0 的安全加固：SELinux + ASLR + seccomp + SBOM 四件套

Azure Linux 4.0 在安全上的工程投入是**「默认开启」**哲学的典型——你不需要懂 SELinux 就能用，但所有关键安全特性都开箱即用。

### 3.1 4 层防御深度

| 防护层 | 配置位置 | 状态 |
|--------|---------|------|
| **SELinux** | 每个 image 默认 enforcing | 开 |
| **ASLR（地址空间布局随机化）** | kernel cmdline `randomize_va_space=2` | 开 |
| **栈保护** | 编译期 `-fstack-protector-strong` | 开 |
| **seccomp** | systemd 服务默认 sandbox | 开 |
| **systemd service sandboxing** | unit 文件 `ProtectSystem=strict` 等 | 开 |

代码示例：一个典型的 systemd 服务在 Azure Linux 4.0 上被 sandbox 限制成什么样子：

```ini
# /etc/systemd/system/myapp.service
[Service]
ExecStart=/usr/bin/myapp
# 微软基线：默认给所有服务加上这些
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=yes
RestrictRealtime=yes
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallErrorNumber=EPERM
```

这套 sandboxing 不是 Azure Linux 4.0 独创——systemd 早就有——但**默认**给所有 systemd unit 加上是新的工程决策。

### 3.2 供应链安全：SBOM + 签名仓库

Azure Linux 4.0 对供应链的投入体现在三件事：

1. **签名仓库**：所有 RPM 包和仓库元数据都用 Microsoft 的 GPG 签名
2. **SBOM（Software Bill of Materials）公开**：每个镜像的 SBOM 都会发布，企业客户可以做合规审计
3. **Cryptographically verified install media**：ISO 下载提供签名校验文档（[verify-iso-signature-and-checksum.md](https://github.com/microsoft/azurelinux/blob/4.0/docs/verify-iso-signature-and-checksum.md)）

SBOM 是企业场景的硬需求——金融、政府、医疗客户需要能证明「这 1000 个包都是谁构建的、用了什么版本的上游、打了什么 patch」。Fedora 本身有 SBOM 但不一定对每包都暴露；Azure Linux 4.0 承诺「针对自己的 overlay 额外公开 SBOM 增项」。

### 3.3 月度补丁 + 自动升级

微软的 SLA 是「**月度安全补丁** + 严重 CVE 即时热修复镜像」：

```bash
# 在 Azure Linux 4.0 上启用自动安全升级
sudo tdnf install dnf-automatic
sudo systemctl enable --now dnf-automatic.timer

# 查看下次升级时间
sudo systemctl list-timers dnf-automatic*

# 查看最近一次安全更新日志
sudo tdnf updateinfo summary
```

注意这里用的还是 `tdnf`（Tiny DNF，Azure Linux 3.0 的默认包管理器），4.0 在迁移到 `dnf5` 但**当前默认仍是 tdnf**——这是个有趣的工程取舍：dnf5 功能更强但依赖更重，而 Azure Linux 容器镜像是按 MB 算成本的。

## 四、规模生产验证：Databricks 10 万 VM、LinkedIn 全量迁移

Azure Linux 不是新项目。2026 年 4.0 之所以敢叫「通用」，是因为它已经**跑了 5 年生产负载**：

- **Databricks**：10 万+ VM、100 万+ CPU cores 从某 Linux 切到 Azure Linux
- **LinkedIn**：基础设施全量迁移
- **Azure SQL、Cosmos DB**：后端 OS 都是 Azure Linux
- **AKS**：自 2023 年起所有 AKS 节点都是 Azure Linux
- **WSLg（Windows Subsystem for Linux GUI）**：宿主系统 distro
- **GitHub、Microsoft 365、OpenAI ChatGPT 后端**：微软自己在「Linux 之上」跑这些服务

Burns 在 OSSNA 上的原话是：「**ChatGPT 全球 1000 万+ 计算核心、日均 10 亿次查询，能跑起来靠的就是 Linux 和 Kubernetes。**」

这是 Azure Linux 4.0 与 Amazon Linux（2011）、Google Container-Optimized OS（2014）不同的关键点：它**不是从云厂商内部基础设施新造的轮子**，而是把已经在跑 AKS/SQL/Cosmos 的同一套 OS **外延给客户**。

## 五、对比分析：Azure Linux 4.0 vs Amazon Linux 2023 vs Ubuntu LTS

| 维度 | Azure Linux 4.0 | Amazon Linux 2023 | Ubuntu 24.04 LTS |
|------|----------------|-------------------|------------------|
| 上游 | Fedora 43 | Fedora 37（修改） | Debian unstable → stable |
| 包管理器 | dnf5 / tdnf | dnf5 | apt |
| 安全基线 | SELinux enforcing, ASLR, seccomp | SELinux 可选 | AppArmor 默认 |
| SBOM | 公开 | 公开 | 公开（SPDX 格式） |
| Immutable variant | Azure Container Linux | Bottlerocket | Ubuntu Core |
| WSL 集成 | 即将推出 | 不适用 | 已有 |
| 更新策略 | 月度+自动可选项 | 2 年 LTS | 5 年 LTS（标准）/10 年（ESM） |
| 包数 | ~5000 RPM | ~3500 RPM | ~59000 deb |

**Azure Linux 4.0 的独特价值**不在于「比 Ubuntu 多什么」，而在于**「与 Azure 平台的零摩擦集成」**：

- 镜像市场一键部署
- Azure Update Manager 原生支持
- 与 Azure Boost（智能网卡卸载）、Azure Attestation（远程证明）原生对接
- WSL 系统 distro 即将支持（开发体验提升）

但**短期内它不替代 Ubuntu/RHEL**——Azure 的官方表态是「如果你想跑 Red Hat，继续跑 Red Hat；如果你想跑 Ubuntu，继续跑 Ubuntu。Azure Linux 是新选项，不是替换」。

## 六、开发者上手路径

### 6.1 三种使用方式

```bash
# 1. Azure VM 市场镜像（最快）
az vm create \
  --resource-group myResourceGroup \
  --name myAzureLinux \
  --image AzureLinux:AzureLinux:azure-linux-4:latest \
  --size Standard_D2s_v5 \
  --admin-username azureuser \
  --generate-ssh-keys

# 2. Container base（最轻量）
docker run -it mcr.microsoft.com/azurelinux-beta/base/core:4.0 /bin/bash

# 3. 本地 ISO（需要 Hyper-V / QEMU/KVM）
wget https://aka.ms/azurelinux-4.0-x86_64.iso
wget https://aka.ms/azurelinux-4.0-x86_64.iso.sig
gpg --verify azurelinux-4.0-x86_64.iso.sig azurelinux-4.0-x86_64.iso
# 用 Anaconda 安装器（社区支持）
```

### 6.2 容器化开发的实战

Azure Linux container image 是个**极简的 container host**——没有 systemd、没有 init、没有 login shell，只有包管理器和基础工具链。这对 Kubernetes pod 非常合适：

```dockerfile
# 基于 Azure Linux 4.0 base image 构建应用
FROM mcr.microsoft.com/azurelinux-beta/base/core:4.0

# 安装运行时依赖（用 tdnf，不是 dnf）
RUN tdnf install -y nodejs-18 npm-10 \
    && tdnf clean all

# 添加应用
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
```

构建出来的镜像通常比 `node:18` 官方镜像**小 60–70%**——因为没有 curl/wget/openssl/一堆 shell utility，只有 app 真正需要的。

### 6.3 调试：从 Azure Linux 容器反查源包

```bash
# 容器内查询文件属于哪个包
tdnf provides /usr/bin/python3.11

# 查 overlay（开发场景）
git clone https://github.com/microsoft/azurelinux -b 4.0
cd azurelinux
# 渲染某个组件的实际 spec
azldev render base/comps/python/python311
# 输出在 specs/python311/python311.spec
cat specs/python311/python311.spec
```

## 七、争议与现实考量

Azure Linux 4.0 在 HN 引发了显著争议（**197 分、200+ 评论**），主要集中在：

### 7.1 「这是真正的通用 Linux 吗？」

**质疑**（[HN 评论 froh, codycharris]）：「一个 general-purpose OS 不是应该跑在任意硬件、获得硬件厂商认证吗？Azure Linux 离开 Azure 栈还有何意义？」

**回应**：Azure Linux 4.0 提供的 ISO 是**真的可以本地装**（x86_64 + ARM64），但 ISO 是「community-based support」——没有商业 SLA。商业支持只在 Azure 平台内。这是「云原生时代的发行版」的现实选择：**优先优化平台体验，本地可用但非主打**。

### 7.2 「这是 Embrace, Extend, Extinguish 吗？」

**质疑**（[HN 评论 egorfine]）：「微软把 Fedora 43 重新打包叫'通用'，但其实是个高度专门化的 Azure 优化版本。这是 Embrace, Extend, Extinguish 的新时代版本。」

**回应**：Azure Linux 团队明确表态「所有 overlay 都以 PR 形式回推 Fedora 上游」——从工程实践看，到目前为止确实有相当比例的改进（如 cgroup v2 优化、systemd 沙箱默认值）已经合并回 Fedora。这与 Google 在 Android 上对 Linux 内核做的「贡献回上游」类似，但需要长期观察兑现度。

### 7.3 「Fedora 43 本身是 bleeding-edge，合适做通用 OS 吗？」

**质疑**（[HN 评论 bananaquant]）：「快照 bleeding-edge Fedora 叫'通用'很误导人。Fedora/RHEL 的分流就是因为前者不支持生产负载。」

**回应**：Azure Linux 不是「Fedora 43 + overlay」直接当通用 OS 用——**它锁定特定 kernel 版本，提供 2 年支持窗口**。这是「**Fedora 上游 + LTS 风格支持**」的混合模型，类似 AWS 在 Amazon Linux 2023 上的策略。微软对此的承诺是「在 2 年支持窗口内保持 kernel 选择稳定」。

### 7.4 ChatGPT 时代的「Linux 公司」叙事

Burns 在 OSSNA 上最后一句话是「微软已经是家 Linux 公司了」。**这不只是宣传**——根据微软自己的数据，Azure 上**三分之二的客户核心跑在 Linux 上**，Microsoft 365、GitHub、OpenAI ChatGPT 全部基于 Linux。

但这句话的反面是：「**微软把通用 Linux 发给客户，本质上是想让客户更依赖 Azure 来跑 Linux**」。这与 Red Hat 跟 IBM 的关系类似、与 AWS 用 Amazon Linux 锁定 EC2 类似。**没有免费的午餐**——你选择发行版的每一步，都是在为某个生态投票。

## 八、未来展望

Azure Linux 4.0 只是开始。展望接下来的 12–24 个月：

1. **WSL 系统 distro 上线**：把 WSL 的内核、用户空间、WSLg 统一到同一套 Azure Linux——这是开发者体验的关键升级
2. **Azure Container Linux（不可变变体）**：4.0 当前仍是 mutable 模型，未来 immutable 变体会成为 AKS node OS 的默认
3. **Azure Sphere（IoT）集成**：与 Azure Sphere 3.0（基于 Linux）共享更多组件
4. **与 Azure Boost 深度集成**：把智能网卡、加密加速、DPDK 卸载做成「开箱即用」的 OS-level 特性
5. **第三方生态扩展**：KubeVirt、Harbor、Argo CD 等云原生工具链提供 Azure Linux 原生安装包

更长远看，**declarative overlay 模式可能被其他发行版借鉴**。Fedora 的 Kinoite（KDE Plasma 不可变）已经在尝试类似思路；openSUSE 的 MicroOS、SUSE Linux Enterprise 的 ALP 也在做类似的事情。**「发行版即声明」的范式正在被 Azure Linux 4.0 推进到主流视野**。

## 总结

Azure Linux 4.0 不是一个新故事——它是一个 4 年演化故事的**外延**。从 CBL-Delridge（2022 年无人知晓的 Debian 衍生品）到 Azure Linux 4.0（Fedora 上游 + 通用 + WSL 即将支持 + 200 万核生产验证），微软完成了一次**操作系统工程能力的对外展示**。

对开发者来说，**Azure Linux 4.0 不是一个「该不该换掉 Ubuntu」的问题**——它是个「如果你已经在 Azure 上跑 Linux 容器，是否值得在镜像市场里多选一项」的增量选择。

对操作系统工程师来说，**declarative overlay 模式才是 4.0 真正的技术遗产**——它把「跟踪上游 5000 个包」从手动劳动变成声明式配置，为未来 Fedora 升级、SUSE 升级、Debian 升级都提供了新范式。

**云原生时代的 Linux 发行版，正在从「手工艺术品」变成「声明式工程产物」**——这才是 Azure Linux 4.0 给整个行业留下的真正信号。

---

*相关阅读：*

- [把显卡显存当内存用：NBD-VRAM 的 Linux 内存分层实战与技术深潜](/article/gpu-vram-as-linux-swap-deep-dive-2026)
- [io_uring：Linux I/O 的革命与异步编程新范式](/article/io-uring-linux-io-revolution-2026)
- [eBPF：Linux 内核可编程性的终极武器](/article/ebpf-linux-kernel-programmability-2026)
- [PostgreSQL 中的工作流：durable execution 的工程实践](/article/postgres-durable-workflows-2026)

**参考资料：**

1. [Azure Linux 4.0 is Microsoft's first general-purpose Linux — boxofcables.dev](https://www.boxofcables.dev/azure-linux-4-0-is-microsofts-first-general-purpose-linux/)
2. [Microsoft surprises with its first server Linux distribution: Azure Linux 4.0 — ZDNet](https://www.zdnet.com/article/microsoft-releases-its-first-server-linux-distribution-azure-linux-4-0/)
3. [microsoft/azurelinux GitHub (4.0 branch)](https://github.com/microsoft/azurelinux/tree/4.0)
4. [Azure Linux on Hacker News (197pts)](https://news.ycombinator.com/item?id=48407499)
5. [KIWI NG image builder](https://osinside.github.io/kiwi/)
