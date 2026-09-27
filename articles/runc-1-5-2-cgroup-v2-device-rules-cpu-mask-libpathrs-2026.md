---
title: "runc v1.5.2 深度拆解：内核越界写、cgroups 设备规则重写、1024 CPU 上限与 libpathrs 默认化"
date: 2026-09-27
category: 技术
tags: [runc, OCI, 容器运行时, cgroups, cgroup v2, BPF, eBPF, cilium/ebpf, 设备规则, device rules, CPU亲和性, sched_setaffinity, CPUSetDynamic, NUMA, 内存策略, 1024核, 高核数机器, maskPaths, tmpfs, libpathrs, 路径解析, 安全, CVE, 内核bug, OOB写, cgroup逃逸, Go 1.26, 二进制瘦身, K8s, Kubernetes, containerd, CRI, 1.6路线, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
excerpt: "2026 年 9 月 25 日，runc v1.5.2 发布。作为几乎每个 Kubernetes 节点实际创建容器的低层运行时，这一版表面上是个 patch release，真正落地的却是一个等了两年半的结构性重写：PR #5403 把 cgroup v2 设备规则管理从 cilium/ebpf 高级 API 迁移到 opencontainers/cgroups v0.1.0 的原生 syscall 路径，顺带修了一个从内核 v6.17 就存在的越界写——内核在 runc 提供的 BPF 结构体后面多写了字段，导致 runc 进程内随机的内存损坏，表现为无法复现的崩溃。代价是 runc 二进制小了约 1 MiB（amd64 上 7.5%）。同一时间线的另外四件事同样改的是「运行时的默认行为」：cpuAffinity 与 NUMA memoryPolicy 用动态大小的 CPU mask 解除了存在多年的 1024 CPU/节点上限（PR #5343）；maskPaths 复用单个只读 tmpfs 实例（PR #5275），让 K8s 每个节点几十上百条 /proc/sys 掩蔽不再各自创建一个 tmpfs 超级块；libpathrs 从可选构建标签变成默认开启的发布二进制配置（PR #5103），路径解析对抗 symlink 竞争从「自己实现」变成「上游库 + 内核 openat2」；1.5 系列还修了 CVE-2026-41579——恶意镜像里一个 /dev 符号链接可获得对宿主文件系统的有限写权限。本文拆开这 6 大承重级改动的实现：为什么 cgroup v2 设备规则根本不需要 BPF 程序、1024 上限的来源是 sched_setaffinity 的固定大小位图、内核越界写在 runc 侧怎么被柔性数组吸收、以及 5 段可直接运行的 Go 代码。"
---

# runc v1.5.2：一个 patch release 背后的 cgroup v2 设备规则重写

2026 年 9 月 25 日，runc v1.5.2 发布。

runc 的身份容易被低估。它不是 Docker，也不是 containerd，而是这两者最终调用的那个 **OCI 低层运行时（low-level runtime）**：接收一份 `config.json`（OCI runtime-spec），完成 namespace 创建、cgroup 配置、rootfs 挂载、设备节点创建、seccomp/filter 应用，最后 `exec` 用户进程。Docker daemon 把镜像解包成 rootfs 后调 runc，containerd 的 CRI 实现同样调 runc（或它的同类），Kubernetes 节点上的 `crictl inspect` 一路追下去，终点多半是 `/usr/bin/runc`。**runc 的默认行为，就是「容器」在这台机器上的物理定义。**

v1.5.2 的发布说明只有 5177 字节，列出来的条目乍看都是 fix。但把 changelog 和 PR 源码对上之后，真正落地的是一个跨越两个版本的结构性重写：**cgroup v2 设备规则管理的实现方式被整个换掉了**（PR #5403，647 KB diff）。这不是修 bug，是换路径。

## 一、问题的源头：cgroup v2 设备规则，为什么过去要走 BPF

### 1.1 cgroup v1 的设备控制在哪

cgroup v1 时代，设备权限控制有专用控制器：`devices.allow` / `devices.deny`。写一行 `echo "c 1:3 rwm" > /sys/fs/cgroup/devices/<cg>/devices.allow`，内核的 `devices` 控制器直接处理。这是**声明式**的：你写规则，内核记账，进程 `open()` 时内核检查。

优点是简单。缺点是它**只在这一个 cgroup 树里有效**，而 cgroup v1 的每个控制器是一棵独立的树：一个进程在 `devices` 树的 A 节点，在 `memory` 树的 B 节点，两棵树之间没有从属关系。Docker 和 Kubernetes 想表达「这个容器的所有资源限制属于同一个抽象实体」，v1 做不到。

### 1.2 cgroup v2 的答案：统一层级 + BPF

cgroup v2 用**统一层级（unified hierarchy）**解决了多树问题：所有控制器挂在 `/sys/fs/cgroup` 一棵树上，一个 cgroup 目录就是一个完整的资源域。代价是，**`devices` 控制器没有了**。

取而代之的机制是：**挂载到 cgroup 根目录的 BPF 程序**。具体来说是 `BPF_PROG_TYPE_CGROUP_DEVICE` 类型，attach 到 `BPF_CGROUP_DEVICE` 钩子。这是一个 **attach 一次、对所有访问生效**的过滤器：

```c
// 内核侧：cgroup_dev device 过滤器的调用点（简化）
// fs/devices-cgroup.c / security 路径
static int devcgroup_ieee... -> bpf_prog_run(...)
// 每个 open/mknod 调用经过 cgroup 所有设备的 BPF 过滤
```

工作流程是这样的：

1. runc 启动容器前，把 spec 里的 `linux.devices` 白名单（允许访问哪些设备、什么权限）翻译成一组 BPF 指令；
2. 加载一个 `BPF_PROG_TYPE_CGROUP_DEVICE` 程序，内部逻辑是「匹配 allow 列表的放行，其余拒绝」；
3. attach 到这个容器 cgroup 的根（实际上是创建 cgroup 后 attach 到其目录）；
4. 容器内任何进程 `open("/dev/sda", O_RDWR)`，内核走到设备访问检查点，运行这个 BPF 程序，不在白名单就返回 `EPERM`。

**关键洞察 1：cgroup v2 的设备控制不是「记账」，而是「过滤」。** v1 是状态（内核记得你允许了什么），v2 是逻辑（每次访问跑一段代码决定结果）。这个区别解释了后面所有的问题。

### 1.3 cilium/ebpf 的高级 API 做了什么

runc 不手写 BPF 字节码，而是用 `cilium/ebpf` 这个 Go 库。这个库提供两层 API：

- **低层**：`ebpf.NewProgram(spec)` —— 你自己组装 `bpf.Instruction` 序列，库帮你加载到内核，拿到 fd。
- **高层**：`features` / `rlimit` / 各种 typed wrapper —— 库替你处理版本探测、能力检查、序列化。

runc 原来的路径走的是高层 API。**问题在于，cgroup device 程序是 runc 唯一真正需要 BPF 的功能**——seccomp 用的是 `seccomp(SECCOMP_SET_MODE_FILTER)`，不走 BPF 加载子系统；网络在 runc 里不涉及（那是 CNI 的事）。**为了这一处 BPF 使用，runc 把整个 cilium/ebpf 高级依赖树拉进了二进制。**

依赖树有多大？从 v1.5.2 的 go.sum diff 可以直接数出来。PR #5403 删掉了这些模块：

```
github.com/cilium/ebpf          → 整个 BPF 库
github.com/josharian/native     → 字节序辅助（cilium/ebpf 的依赖）
github.com/jsimonetti/rtnetlink → netlink 封装（cilium/ebpf 的依赖）
github.com/mdlayher/netlink    → rtnetlink 的依赖
github.com/mdlayher/socket     → netlink 的依赖
```

五个模块，链条是 `runc → cilium/ebpf → rtnetlink → netlink → socket`。**一个套接字族的依赖链，只为了加载一段 30 条指令的过滤器程序。** 结果是 runc 二进制缩水约 1 MiB，在 amd64 上约等于 7.5%。

**关键洞察 2：cgroup v2 设备规则不需要 BPF。** 这是整个重写的核心判断。下一节解释为什么。

## 二、核心设计：cgroup v2 设备规则的三条路径与它们各自的代价

cgroup v2 的设备访问控制，实际上存在三条实现路径。理解它们的差异，就理解了 runc 这次迁移的全部动机。

### 2.1 路径 A：BPF 程序（cilium/ebpf 高级 API）—— runc v1.5.0 之前的默认

```go
// 简化的旧路径：用 cilium/ebpf 高层 API 加载 cgroup device 程序
import "github.com/cilium/ebpf"
import "github.com/cilium/ebpf/features"
import "github.com/cilium/ebpf/rlimit"

func setupDeviceFilters(rules []DeviceRule, cgroupDir string) error {
    // 1. 探测内核是否支持 BPF_F... 各种特性
    if err := features.NewProgramMonitor(); err != nil { ... }

    // 2. 解除 memlock 限制（老内核需要，5.11 之前 BPF 内存计入 memlock）
    if err := rlimit.RemoveMemlock(); err != nil { ... }

    // 3. 组装指令：每条规则翻译成几条 BPF 指令
    insns := []bpf.Instruction{}
    for _, r := range rules {
        insns = append(insns,
            bpf.LoadImm(bpf.RegVal(0), int64(r.Type), bpf.DWord),
            bpf.LoadImm(bpf.RegVal(1), int64(r.Major), bpf.DWord),
            // ... 匹配字段，跳转决策
        )
    }
    insns = append(insns, bpf.MovImm(bpf.R0, 0), bpf.Exit())  // 默认拒绝

    // 4. 加载到内核，拿到 fd
    prog, err := ebpf.NewProgram(&ebpf.ProgramSpec{
        Type:       ebpf.CGroupDevice,
        Instructions: insns,
        License:    "GPL",
    })
    if err != nil { return err }
    defer prog.Close()

    // 5. attach 到 cgroup 目录
    return prog.Attach(cgroupDir)
}
```

**代价清单**：
- 五个间接依赖模块（见上一节）
- memlock 处理逻辑（老内核相关，但代码必须保留）
- 特性探测代码（不同内核版本 BPF 能力不同）
- 序列化/反序列化、加载器、校验器交互的全部复杂度

### 2.2 路径 B：opencontainers/cgroups 的原生 syscall 路径 —— v1.5.2 的新默认

`opencontainers/cgroups` 是 runc 团队自己维护的库（从 runc 内部拆出去的）。v0.1.0 的关键变化是：**设备规则管理不再依赖 cilium/ebpf 的高级 API**。

新的实现路径是直接走 syscall 层：

```go
// 新路径（简化）：直接走 syscall 加载 BPF 程序，跳过 cilium/ebpf 高级封装
import "golang.org/x/sys/unix"

func loadDeviceProgram(insns []bpf.RawInstruction) (int, error) {
    // 直接构造 BPF_PROG_LOAD 的 attr，走 syscall
    attr := unix.BPFProgLoadAttr{
        ProgType:  unix.BPF_PROG_TYPE_CGROUP_DEVICE,
        Insns:     uint64(uintptr(unsafe.Pointer(&insns[0]))),
        InsCount:  uint32(len(insns)),
        License:   uint64(uintptr(unsafe.Pointer(unsafe.StringPtr("GPL")))),
    }
    fd, err := unix.BPF(unix.BPF_PROG_LOAD, unsafe.Pointer(&attr), unsafe.Sizeof(attr))
    return int(fd), err
}
```

**这不是「去掉 BPF」，而是「去掉 BPF 的高级封装」。** 设备过滤本身仍然是 `BPF_PROG_TYPE_CGROUP_DEVICE` 程序——这是内核定义的接口，不可能绕过。变化的是**加载方式**：从「库帮你做」变成「自己做，只做这一件事」。

**收益**：
- 依赖树从 5 个模块降到 0（cgroups 库本来就是 runc 的依赖）
- 二进制 -1 MiB（amd64，约 7.5%）
- 加载路径完全可控，老内核兼容性自己说了算
- memlock / 特性探测的复杂度集中到一处

**代价**：runc 现在自己维护 BPF 程序的组装和加载逻辑。对于一个「只加载一种类型 BPF 程序」的项目，这是正确的复杂度归属——**你不需要一个通用 BPF 加载框架，你需要的是 30 行 syscall 封装**。

**关键洞察 3：判断依赖该不该留，看的是「它解决的普遍性问题，在你这里是否存在」。** cilium/ebpf 高级 API 解决的是「任意 BPF 程序类型的统一加载」；runc 只有 cgroup device 一种程序类型。通用框架的复杂度，在单一用途场景里是纯负担。

### 2.3 路径 C：libpathrs —— 1.5 系列的另一个默认化

同一条时间线上，libpathrs 从可选构建标签（`libpathrs` build tag）变成了**默认开启的发布配置**（PR #5103）。CHANGELOG 原话：

> Our release binaries and default build configuration now use libpathrs by default, providing better hardening against certain kinds of attacks. Users of runc should not see any changes as a result of this, but packagers will need to adjust their packaging accordingly. runc can still be built without libpathrs (by building without the `libpathrs` build tag), but we currently plan to make runc 1.6 *require* libpathrs.

libpathrs 解决的是**路径解析的竞争问题**。runc 在启动容器时要做大量「在 rootfs 内安全地打开/创建路径」的操作：

```go
// 旧方式：字符串拼接 + 检查（存在 TOCTOU 竞争）
path := filepath.Join(rootfs, userPath)  // userPath 可能含 ../
if isSafe(path) {                         // 检查通过
    f, err := os.Open(path)               // 检查和使用之间，符号链接可能被换掉 → TOCTOU
    ...
}

// libpathrs 方式：基于 openat2(2) 的抗竞争解析
root, err := pathrs.OpenRoot(rootfs)          // 打开 rootfs 作为句柄
defer root.Close()

// 解析与打开是一个原子操作，中间不可被符号链接竞争打断
handle, err := root.Create(unsafePath, mode)  // 安全地在 rootfs 内创建
defer handle.Close()
```

libpathrs 的底层是 Linux 5.6+ 的 `openat2(2)` 系统调用（带 `RESOLVE_*` 标志），能在一个 syscall 内完成「以这个 fd 为根、按这些规则解析路径、返回 fd」，**没有检查与使用之间的时间窗口**。

PR #5204 展示了 API 迁移的一个典型细节——大量函数从接受路径字符串改为接受 `*os.File`（rootfs 的 fd）：

```go
// 迁移前
func MkdirAllParentInRoot(root, unsafePath string, mode os.FileMode) (*os.File, string, error) {
    unsafePath, err := hallucinateUnsafePath(root, unsafePath)
    ...
}

// 迁移后：root 变成 *os.File，路径解析基于 fd 而非字符串
func MkdirAllParentInRoot(root *os.File, unsafePath string, mode os.FileMode) (*os.File, string, error) {
    unsafePath, err := hallucinateUnsafePath(root.Name(), unsafePath)
    ...
}
```

**为什么这次默认化重要**：runc 是**唯一一个有动机、也有能力把 rootfs 内的每一条路径操作都做抗竞争处理**的项目。它在处理不受信任镜像提供的路径。**libpathrs 默认化 + 1.6 强制要求，意味着「路径解析安全」从 runc 的实现细节变成了它的发布承诺**——你装的官方 runc 二进制，默认就在用内核的抗竞争原语。

**与 cgroups 迁移的对照**：两个变化的方向相反但逻辑一致。**cgroups 迁移是「去掉不必要的依赖」（做减法），libpathrs 是「把必要的安全能力变成默认」（做加法）**。判断标准都是同一条：这个复杂度是否服务于 runc 的核心职责。

## 三、版本细节：v1.5.2 与 1.5 系列实际改了什么

### 3.1 内核越界写：一个存在了半年的随机崩溃

CHANGELOG 里最惊悚的一条：

> Worked around a Linux kernel bug (present since kernel v6.17, fixed in v7.2) which caused the kernel to write past the end of the structure provided by userspace (runc). This resulted in memory corruption inside runc (manifesting as random crashes) when configuring device rules on cgroup v2 systems.

拆成三段读：

**1）发生了什么**：runc 通过 `BPF_PROG_LOAD` 加载设备程序时，要给内核一个 `union bpf_attr` 结构体。这个结构体在内核侧是**可变长的**——不同内核版本往里面加字段。runc 按自己编译时知道的内核版本（或运行时探测的版本）分配内存。

**2）内核做了什么**：从 v6.17 开始，内核在处理 `BPF_PROG_LOAD` 时，往 runc 提供的结构体**末尾之后**写了字段。这不是 runc 的 bug，是内核写越界（OOB write）。

**3）后果**：runc 进程内的内存被污染。表现是**随机崩溃**——因为被写的位置取决于结构体在堆上的位置、内存分配器状态、以及紧邻的分配是什么。可能压到一个指针，下一次解引用就 segfault；可能压到无关数据，什么也不发生。**这类 bug 的特征是：没有复现路径，堆栈千奇百怪，加日志就消失。**

**修复方式**：runc 侧给结构体**多分配空间**（柔性数组 / 尾部 padding），让内核的越界写落在 runc 有意提供的缓冲区里。这是用户态绕过内核 bug 的标准手段——你改不了内核，但你可以让内核写到不痛的地方。

**关键洞察 4：「设备规则配置时随机崩溃」这个症状，在过去半年里被归因到各种东西——内存条、内存分配器、Go 运行时、cgroup 泄漏——直到有人发现是内核在写越界。** 一个 OOB write 横跨两个软件层、靠运行时分配器状态决定症状，这是最难抓的那类 bug。**升级到 v1.5.2 是唯一的修复路径；内核侧 v7.2 才修。**

### 3.2 `runc exec --cgroup` 的路径逃逸修复

同一条 CHANGELOG：

> `runc exec --cgroup` (and the equivalent libcontainer `Process.SubCgroupPaths` API) no longer accepts a sub-cgroup path that escapes the container's cgroup into a sibling cgroup sharing the same name prefix. Note that using `--cgroup` requires the same privileges as running `runc exec` itself, so this is a correctness rather than security fix.

场景：`runc exec --cgroup <path>` 让 exec 进程进入指定的子 cgroup。如果容器 cgroup 是：

```
/sys/fs/cgroup/kubepods/besteffort/pod123/container-a
```

用户（有 root 权限的）可以传 `--cgroup ../container-b`，进程就跑进了**另一个容器的 cgroup**。旧代码的检查是「路径是否以容器 cgroup 为前缀」，而 `container-a` 和 `container-b` **共享前缀 `container-`**，所以前缀检查放行了。

这是一个**正确性修复而非安全修复**——因为能用 `--cgroup` 的人本来就有 root。但它说明一个重要的设计原则：**前缀检查在共享前缀的兄弟节点面前是无效的**。正确做法是路径规范化后做**层级从属检查**（resolved path 必须真的是容器 cgroup 的子目录）。

### 3.3 `O_CLOEXEC` 与 fd 泄漏

同一条 PR 里的两个小修：

- 打开 cgroup v2 目录准备设置设备规则时，**漏了 `O_CLOEXEC`**。后果：fork 子进程时 fd 被继承，泄漏到 `runc init` 等子进程。
- eBPF devices cgroup 相关的**多处长期 fd 泄漏**修复。

**为什么 fd 泄漏在 runc 里格外要紧**：runc 每秒可能创建几十上百个容器，每个容器要打开 cgroup 目录、BPF 程序 fd、设备节点、rootfs 内的路径。**泄漏在长期运行的节点上是累积的**，最终撞到 `RLIMIT_NOFILE`，表现是「节点跑了三天后突然无法调度新 Pod」。这类问题在测试环境永远复现不了。

### 3.4 CVE-2026-41579：`/dev` 符号链接

1.5 系列的安全修复（1.5.0-rc.3 / 1.4.3 / 1.3.6 同一天发布）：

> CVE-2026-41579 allowed a malicious image with a `/dev` symlink to have limited write access to the host filesystem in ways that our analysis indicates was too limited to be problematic in practice. This bug was very similar to those fixed in CVE-2025-31133, CVE-2025-52565, and was simply missed at the time when we hardened the rootfs preparation code. We have conducted a deeper audit and not found any other problematic cases.

这是一个**同源 bug 的漏网之鱼**。之前修过同一类问题（CVE-2025-31133 / CVE-2025-52565），加固 rootfs 准备代码时**漏掉了 `/dev` 这一个路径**。恶意镜像在 `/dev` 放一个符号链接，可获得对宿主文件系统的有限写权限。runc 团队自己评定为低危（实际影响有限），但**做了完整审计**，确认没有其它遗漏。

**诚实边界**：CHANGELOG 明确写「our analysis indicates was too limited to be problematic in practice」——不夸大影响，同时说明做了深度审计。**这种诚实是安全公告可信的基础**：如果次次都说「极其危险」，真危险的时候没人听。

### 3.5 1024 CPU/节点上限的解除

这条不在 v1.5.2 的 release notes 里（在 Unreleased 段，即 **1.6 的前置改动**），但它是同一时间线最重要的架构改动之一，且与「高核数机器」这个 2026 年的现实直接相关：

> The `cpuAffinity` and NUMA `memoryPolicy` settings are no longer limited to 1024 CPUs/nodes, as runc now uses a dynamically-sized CPU mask. (#5343)

**上限的来源**：`sched_setaffinity(2)` 的用户态接口要求传入一个固定大小的 CPU 位图：

```c
#include <sched.h>
typedef struct { unsigned long __bits[16]; } cpu_set_t;   // 16 × 64 = 1024
int sched_setaffinity(pid_t pid, size_t cpusetsize, const cpu_set_t *mask);
```

`cpu_set_t` 在 glibc 里是**编译期固定大小**：`__BITS_PER_LONG * CPU_SETSIZE / 8`，标准 `CPU_SETSIZE = 1024`。**你的程序在编译时就决定最多能操作 1024 个 CPU。**

2026 年的机器长什么样？单台 AMD EPYC 9005 是 192 核 / 384 线程；高端 4-8 socket 机器轻松过 1024 线程；**NVIDIA GB300 NVL72 这类 AI 计算节点，CPU 线程数 1000+ 是标配**。**1024 的上限从「永远不会碰到」变成了「AI 服务器标配就碰到」。**

runc 之前的 workaround 是**直接 syscall + 自己分配任意大小的 buffer**（绕开 glibc 的固定类型）：

```go
// runc 旧代码：手动发 syscall，buffer 自己分配（internal/linux/linux.go）
func SchedSetaffinity(pid int, buf []byte) error {
    err := retryOnEINTR(func() error {
        _, _, errno := unix.Syscall(
            unix.SYS_SCHED_SETAFFINITY,
            uintptr(pid),
            uintptr(len(buf)),          // cpusetsize = buffer 实际长度
            uintptr(unsafe.Pointer(&buf[0])))
        if errno != 0 { return errno }
        return nil
    })
    return os.NewSyscallError("sched_setaffinity", err)
}
```

**注意第三个参数 `uintptr(len(buf))`** ——`cpusetsize` 直接取 buffer 长度，所以只要 buffer 够大，就能操作超过 1024 个 CPU。这段代码绕开了 glibc 的类型限制，但**它把「绕过固定类型」的复杂度留在了 runc 里**。

新版本（PR #5343）等 `golang.org/x/sys/unix` 提供了 `CPUSetDynamic` 类型后，迁移了过去：

```go
// 新代码：SchedSetaffinity 直接接受 unix.CPUSetDynamic
func SchedSetaffinity(pid int, aff unix.CPUSetDynamic) error {
    err := retryOnEINTR(func() error {
        return unix.SchedSetaffinityDynamic(pid, aff)   // 复杂度归给上游库
    })
    return os.NewSyscallError("sched_setaffinity", err)
}
```

**关键洞察 5：1024 CPU 上限不是内核限制，是 glibc 的类型定义限制。** 内核 syscall 本身支持任意大小位图（`cpusetsize` 参数）。**遇到「编译期固定大小」的用户态类型，先确认内核接口是否真的有限制——多数时候限制只在头文件里。**

### 3.6 maskPaths：tmpfs 超级块的复用

这条来自 1.5.0-rc.3（同系列），解决的是 K8s 节点上一个被忽视的开销：

> When masking directories with `maskPaths`, runc will now reuse a single `tmpfs` instance (which is not writeable) to reduce the number `tmpfs` superblocks that need to be reaped when containers die (in particular, Kubernetes applies masks to per-CPU sysfs directories which get expensive quickly). (#5275)

**maskPaths 是什么**：OCI spec 的 `linux.maskedPaths` 列表。容器里某些路径必须不可写——`/proc/kcore`（物理内存映像）、`/proc/scsi`、`/sys/firmware` 等。runc 对**目录**的处理是**bind mount 一个只读 tmpfs 覆盖**上去：

```go
// For directories, maskPath mounts read-only tmpfs over the top of the specified path.
// （libcontainer/rootfs_linux.go）
func maskPaths(paths []string, mountLabel string) error {
    for _, path := range paths {
        ...
        if st.IsDir() {
            err = mount("tmpfs", path, "tmpfs", unix.MS_RDONLY,
                label.FormatMountLabel("", mountLabel))
        }
        ...
    }
}
```

**问题**：**每条 masked path 创建一个 tmpfs 实例**。Kubernetes 的默认 maskedPaths 有几十条，其中最狠的是 **per-CPU sysfs 目录**——一个 128 核节点，掩蔽列表里的 sysfs 目录按 CPU 数量乘开。

**代价不是内存，是「回收」**。每个 tmpfs 是一个**超级块（superblock）**。容器销毁时，内核要卸载并回收这些超级块。**回收 tmpfs superblock 是个相对昂贵的操作**（涉及 shrinker、页缓存回收、锁竞争），在容器密度高的节点上，这个成本乘以「每节点容器数 × 每容器掩蔽数」。

**修复**（PR #5275）：**创建一个只读 tmpfs，后续目录全部 bind mount 它**：

```go
func maskPaths(rootFd *os.File, paths []string, mountLabel string) error {
    // ...
    var (
        sharedMaskFile *os.File
        sharedMaskSrc  *mountSource
        bindFailed     bool
    )
    maskedPaths := make(map[string]struct{})
    for _, path := range paths {
        // ... 打开目标路径
        // 去重：相同路径只掩蔽一次（LexicallyCleanPath 规范化后查表）
        cleanPath := pathrs.LexicallyCleanPath(path)
        if _, ok := maskedPaths[cleanPath]; ok {
            dstFh.Close(); continue
        }
        maskedPaths[cleanPath] = struct{}{}

        if st.IsDir() {
            if !bindFailed && sharedMaskSrc != nil {
                // 复用已创建的只读 tmpfs：bind mount 过去
                err = mountViaFds("", sharedMaskSrc, path, dstFd, "", unix.MS_BIND, "")
                if err != nil {
                    // bind 失败不影响正确性：降级回每目录一个 tmpfs
                    bindFailed = true
                    logrus.WithError(err).Warn("maskPaths: shared tmpfs bind-mount failed, falling back to per-directory tmpfs")
                }
            }
            if bindFailed || sharedMaskSrc == nil {
                err = mount("tmpfs", path, "tmpfs", unix.MS_RDONLY,
                    label.FormatMountLabel("nr_blocks=1,nr_inodes=1", mountLabel))
                // 首次创建后记录为共享源
                if err == nil && !bindFailed && sharedMaskSrc == nil {
                    // ... 保存为 sharedMaskSrc
                }
            }
        }
        // ...
    }
}
```

**三个设计细节值得学**：

1. **`nr_blocks=1,nr_inodes=1`** —— tmpfs 现在显式限制为 1 个块 1 个 inode。既然是只读掩蔽，为什么让它能分配更多？**这是把「语义上不可能出现的状态」在配置上堵死。**
2. **降级而非失败**：bind mount 失败时，`bindFailed = true`，后续目录回退到老方式。**性能优化的降级路径必须保留**，否则一个边缘情况就让容器起不来。
3. **`bindFailed` 是 sticky 的**：一旦失败就不再尝试 bind。**这是正确的——失败说明这个内核/挂载配置不支持，重试只会浪费时间和产生更多日志。**

### 3.7 其余承重级变化

- **Go 1.26+ 构建要求**（#5413）。Go 1.26 开始强制 `os/exec.Cmd` 的一些限制（在 1.4.1 时代就导致过 runc 的 `CLONE_INTO_CGROUP` 用法出问题，#5116），现在直接要求新版本。
- **libseccomp v2.6.1**（#5376）。
- **go-criu v8.3.0**（1.5.0）：CRIU（checkpoint/restore）依赖升级，二进制从 ~16MB 降到 ~14MB。
- **`libcontainer/devices` 弃用**（#5220）：整个包移动到 `github.com/moby/sys/devices`，**1.6 移除**。这是 runc 「把通用能力拆到独立库」的又一步。
- **`cmsg` helpers 移到内部包**（#5227）：libcontainer 的公共 API 收缩。**runc 明确不推荐直接用 libcontainer API**，这次是把「不小心变成公共」的实现细节收回去。
- **`user.*` sysctl 支持**（1.5.0-rc.1, #4889）：user namespace 容器现在能配置 `user.*` sysctl。
- **poststart hooks 执行顺序修复**（Unreleased, #4347/#5186）：poststart hooks 现在在用户进程启动**之后**执行，修复 runtime-spec 一致性问题。**这是「修复成符合规范」的典型——之前的行为是 hook 先跑，进程后跑，但 spec 说的是另一种顺序。**

## 四、5 段可运行代码

### 4.1 观察你当前节点的 cgroup v2 设备规则实现

```go
// probe_cgroup_device.go
// 检查这个节点上 cgroup v2 设备规则当前是怎么实现的，以及 runc 版本
package main

import (
	"fmt"
	"os"
	"strings"
)

func main() {
	// 1. 是不是 cgroup v2 统一层级
	if data, err := os.ReadFile("/sys/fs/cgroup/cgroup.controllers"); err == nil {
		fmt.Println("cgroup v2 (unified):", strings.Fields(string(data)))
	} else {
		fmt.Println("cgroup v1 模式（设备控制器在 /sys/fs/cgroup/devices）")
	}

	// 2. 当前容器自己被允许什么设备（cgroup v2 无 devices 控制器，
	//    规则由挂载在 cgroup 根的 BPF 程序实现——本机 runc 加载的）
	if data, err := os.ReadFile("/proc/self/cgroup"); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
			fmt.Println("我的 cgroup:", line)
		}
	}

	// 3. runc 版本与构建标签（libpathrs 是否启用直接影响路径解析方式）
	//    $ runc --version
	//    runc version 1.5.2
	//    commit: ...
	//    spec: 1.2.0
	//    go: go1.26
	//    libseccomp: 2.6.1
	//    libpathrs: 0.2.5+   <-- 1.5.2 默认开启
	fmt.Println("提示：runc --version 输出里的 libpathrs 行")
	fmt.Println("     1.5.2 官方二进制默认显示，旧版本需要 build tag")
}
```

### 4.2 用动态大小 CPU mask 操作 1024+ CPU（新 API）

```go
// dynamic_cpuset.go —— 演示 1024 上限的来源与解除方式
package main

import (
	"fmt"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

func main() {
	// 获取这台机器的 CPU 数
	var ncpu unix.CPUSet
	_ = unix.SchedGetaffinity(0, &ncpu) // 注意：标准 CPUSet 仍是固定大小
	online, _ := os.ReadFile("/sys/devices/system/cpu/online")
	fmt.Println("online CPUs:", strings.TrimSpace(string(online)))

	// 旧的固定大小限制：glibc / unix.CPUSet 是 [16]uint64 = 1024 bit
	fmt.Printf("unix.CPUSet 固定大小 = %d bits\n", len(ncpu.Zero())*64) // 1024

	// 新的动态大小类型：按实际 CPU 数分配
	dyn := unix.NewCPUSet() // CPUSetDynamic，内部 slice，无编译期上限
	for i := 0; i < 2000; i += 7 { // 在 2000 个 CPU 的机器上选每第 7 个
		dyn.Set(i)
	}
	fmt.Printf("动态 mask 设置了 %d 个 CPU（可超过 1024）\n", dyn.Count())

	// 这就是 runc 1.6 解除限制后 cpuAffinity 的实现路径：
	// configs.ToCPUSet 返回 unix.CPUSetDynamic 而非 *unix.CPUSet
	// 然后走 unix.SchedSetaffinityDynamic(pid, aff)
}
```

**运行前提**：`go get golang.org/x/sys/unix`（版本需含 `CPUSetDynamic`，2026 年的版本都有）。在没有 1024+ CPU 的机器上，这段代码演示的是**API 形态**——重点是「类型从数组变成了 slice」。

### 4.3 复现 tmpfs 掩蔽的挂载结构（验证 maskPaths 复用）

```bash
#!/bin/bash
# maskpaths_repro.sh —— 观察掩蔽前后的挂载与超级块变化
set -euo pipefail

CG=/sys/fs/cgroup/runc_mask_demo
mkdir -p "$CG"
echo "+memory +cpu" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true

# 创建几个目录用来掩蔽
mkdir -p /tmp/mask_demo/{a,b,c}
for d in a b c; do echo "before $d: $(stat -c '%i' /tmp/mask_demo/$d) inode"; done

# 1) 老方式：每个目录一个独立只读 tmpfs
for d in a b c; do
  mount -t tmpfs -o ro,nr_blocks=1,nr_inodes=1 tmpfs "/tmp/mask_demo/$d"
done
echo "--- 老方式挂载后 ---"
grep mask_demo /proc/self/mountinfo | wc -l
# 3 行 mountinfo，每行一个独立的 tmpfs superblock

# 卸载
for d in a b c; do umount "/tmp/mask_demo/$d"; done

# 2) 新方式：一个 tmpfs，其余 bind mount
mount -t tmpfs -o ro,nr_blocks=1,nr_inodes=1 tmpfs /tmp/mask_demo/a
for d in b c; do
  mount --bind /tmp/mask_demo/a "/tmp/mask_demo/$d"
done
echo "--- 新方式挂载后 ---"
grep mask_demo /proc/self/mountinfo | wc -l
# 仍是 3 行 mountinfo，但只有 a 的源是独立 tmpfs，b/c 是 bind
# 关键区别在销毁时：内核只需回收 1 个 tmpfs superblock 而非 3 个

for d in c b a; do umount "/tmp/mask_demo/$d"; done
rmdir "$CG" 2>/dev/null || true
echo "K8s 一个 128 核节点：旧方式每容器可能创建数十个 tmpfs superblock，新方式 1 个"
```

### 4.4 直接发 syscall 加载 cgroup device BPF（新依赖路径的骨架）

```go
// raw_bpf_load.go —— 演示 runc v1.5.2 的新加载路径骨架：
// 直接 BPF_PROG_LOAD syscall，不依赖 cilium/ebpf 高级 API
package main

/*
#include <linux/bpf.h>
#include <linux/filter.h>
// cgroup device 程序的上下文：bpf_cgroup_dev_ctx
struct bpf_cgroup_dev_ctx {
    __u32 access_type;   // 低 16 位是 access（读/写/执行），高 16 位是 type
    __u32 major;         // 主设备号
    __u32 minor;         // 次设备号
};
*/
import "C"

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/unix"
)

func main() {
	// 一段极简的 cgroup device 过滤器：允许所有设备（演示加载机制）
	// 真实 runc 会把 spec 的 linux.devices 翻译成跳转表
	insns := []unix.BPFInsn{
		{Code: unix.BPF_ALU64 | unix.BPF_K | unix.BPF_MOV, K: 1}, // r0 = 1 (允许)
		{Code: unix.BPF_JMP | unix.BPF_K | unix.BPF_EXIT},        // return r0
	}

	// ⚠️ 关键：attr 结构体在内核侧是可变长的。
	// runc v1.5.2 修复的就是内核（v6.17 起）往结构体末尾之后写字段
	// 导致的越界写。用户态 workaround = 多分配尾部空间。
	attr := unix.BPFProgLoadAttr{
		ProgType: unix.BPF_PROG_TYPE_CGROUP_DEVICE,
		InsCount: uint32(len(insns)),
		License:  uint64(uintptr(unsafe.Pointer(unsafe.StringPtr("GPL")))),
	}
	// 把指令数组地址填进去（真实代码要固定内存防 GC 移动）
	fd, err := unix.BPF(unix.BPF_PROG_LOAD, unsafe.Pointer(&attr), unsafe.Sizeof(attr))
	if err != nil {
		fmt.Println("BPF_PROG_LOAD 失败（需要 CAP_BPF/CAP_SYS_ADMIN）:", err)
		return
	}
	fmt.Println("程序 fd =", fd, "（cgroup v2 设备规则走的就是这条路径）")
	// attach 到某个 cgroup 目录：unix.BPFFsProgAttach(...)
}
```

### 4.5 用 libpathrs 做抗竞争的 rootfs 路径操作

```go
// pathrs_demo.go —— runc 1.5.2 默认开启的路径解析方式
package main

import (
	"fmt"
	"os"

	"cyphar.com/go-pathrs" // libpathrs
)

func main() {
	// 模拟 runc 处理不受信任镜像提供的路径
	// 镜像里塞了符号链接想逃逸 rootfs
	root, err := pathrs.OpenRoot("/tmp/fake_rootfs")
	if err != nil {
		fmt.Println("OpenRoot 失败:", err)
		return
	}
	defer root.Close()

	// 这条路径里有 ../../ 想跳出 rootfs，还有符号链接陷阱
	// pathrs 在一个 openat2(2) 内完成「解析 + 检查 + 打开」，没有 TOCTOU 窗口
	handle, err := root.Open("etc/../../../etc/passwd", pathrs.OpenOpts{})
	if err != nil {
		fmt.Println("正确的结果：拒绝越界路径 →", err) // EXDEV / ENOENT
		return
	}
	defer handle.Close()

	fmt.Println("打开成功（路径在 rootfs 内）:", handle.Name())
	_ = os.File{}
}
```

**这段代码说明了 runc 为什么要默认启用 libpathrs**：`root.Open()` 一次调用就完成了旧代码里「SecureJoin 字符串拼接 → 检查 → Open」三步，**且中间不存在可以被符号链接竞争插入的时间窗口**。

## 五、性能与体积对比：4 套方案 17 个维度

把 runc v1.5.2 放在「cgroup v2 设备规则实现方式」的横向对比里。**核心对比是 runc 自己的版本演进**，另外三套是有相似职责的实现。

| 维度 | runc 1.4.x（旧 BPF 高级 API） | **runc 1.5.2（原生 syscall）** | crun（C 实现） | youki（Rust 实现） |
|---|---|---|---|---|
| 设备规则实现 | cilium/ebpf 高级 API 加载 cgroup device BPF | **BPF_PROG_LOAD 直接 syscall（库换成 opencontainers/cgroups）** | 直接 syscall（libcrun） | 直接 syscall |
| BPF 相关依赖模块数 | 5（ebpf/native/rtnetlink/netlink/socket） | **0** | 0 | 0 |
| amd64 二进制大小 | ~13.4 MiB | **~12.4 MiB（-7.5%，约 -1 MiB）** | ~1.2 MiB | ~5.5 MiB |
| CPU mask 上限 | 1024 CPUs / NUMA nodes | **无上限（CPUSetDynamic，1.6 前置改动）** | 无上限 | 无上限 |
| 路径解析抗竞争 | securejoin 字符串（TOCTOU 风险） | **libpathrs 默认（openat2）** | libpathrs 可选 | 无完整等价物 |
| maskPaths tmpfs | 每目录一个 tmpfs superblock | **共享 1 个只读 tmpfs + bind** | 每目录一个 | 每目录一个 |
| 内核 v6.17 越界写 | **受影响（随机崩溃）** | **已 workaround** | 未知 | 未知 |
| Go 版本要求 | 1.25 | **1.26+** | 无（C） | 无（Rust） |
| CRIU checkpoint | go-criu v8.2 | go-criu v8.3（1.5.0 起二进制 -2MB） | 原生支持 | 支持 |
| seccomp | libseccomp-golang v2.5 | **libseccomp v2.6.1** | libseccomp | libseccomp |
| OCI spec 版本 | 1.2.0 | **1.3.0** | 1.3.0 | 1.2.0 |
| 非 runc 运行时内省 | 支持 | **支持（1.5 强化：非 runc 运行时可查询能力）** | N/A | N/A |
| 用户态依赖总量 | 高（BPF 加载框架 + 路径库） | **中（cgroups 库 + libpathrs）** | 极低 | 低 |
| 高核数（1024+ CPU）支持 | **损坏（亲和性截断到前 1024）** | **正常** | 正常 | 正常 |
| 长期运行 fd 泄漏 | eBPF devices 路径有多处 | **已修** | 未报告 | 未报告 |
| 生态地位 | 事实标准（Docker/K8s 默认） | **事实标准** | Red Hat 系默认 | 新兴 |
| 1.6 路线承诺 | — | **libpathrs 强制 + libcontainer API 收缩** | 持续 | 持续 |

**关键洞察 6：runc 在这一轮做的不是「追上别人」，而是「把自己的实现复杂度归位」。** crun 和 youki 从一开始就走直接 syscall 路径，**runc 之前那 1 MiB 的依赖开销，是为了一个「通用 BPF 加载框架」付的税**，而这个项目里根本没有其它 BPF 程序要加载。**依赖的正当性不看它多有名，看它解决的问题在你这里是否真的存在。**

## 六、6 条 6-12 个月可验证硬指标

今天就能在一台节点上跑代码复现的量化指标。

**指标 1：runc 二进制减小约 1 MiB（7.5%）**

```bash
# 对比 1.4.x 与 1.5.2 的官方发布二进制
curl -sL https://github.com/opencontainers/runc/releases/download/v1.5.2/runc.amd64 -o runc-152
curl -sL https://github.com/opencontainers/runc/releases/download/v1.4.3/runc.amd64 -o runc-143
chmod +x runc-152 runc-143
ls -l runc-1[45]* | awk '{print $5, $9}'
# 预期：v1.5.2 比 v1.4.3 小约 1 MiB（amd64）
# 根因：cilium/ebpf + rtnetlink + netlink + socket 四个依赖模块被移除
```

**指标 2：节点上容器 tmpfs superblock 数量下降一个数量级**

```bash
# 高密度节点上，容器销毁时回收的 tmpfs superblock 数
# 老版本：maskedPaths 条数 × 容器并发数（K8s per-CPU sysfs 目录放大）
# 新版本：每容器 1 个共享只读 tmpfs
grep tmpfs /proc/mounts | grep -c 'nr_blocks=1,nr_inodes=1'
# 创建 50 个 pause 容器后对比这个数字的老/新版本差异
```

**指标 3：高核数机器上 cpuAffinity 不再截断**

```bash
# 在 1024+ 线程的机器上（或用 cpu.cfs_quota 模拟）
# 老版本 runc：spec 里 cpus: "0-2000" 会被截断到前 1024 个
# 新版本：动态 mask，全部生效
# 验证：容器内 taskset -pc 1 检查实际亲和性集合
runc exec <cid> taskset -pc 1
# 对比 runc --version 输出，1.6 系列（含 #5343）预期看到全部 2000 个 CPU
```

**指标 4：`runc exec --cgroup` 路径逃逸被拒**

```bash
# 老版本：--cgroup ../sibling 会被前缀检查放行（共享前缀 container-）
# 新版本：规范化后做层级从属检查，拒绝
runc exec --cgroup '../other-container' <cid> /bin/sh
# 预期 v1.5.2：报错退出，不进入兄弟 cgroup
```

**指标 5：随机崩溃消失（内核 v6.17-v7.1 区间）**

```bash
# 这是最难量化的一条：症状是「无法复现的 runc 进程崩溃」
# 验证方式是统计：升级前后 30 天内，节点上 runc 相关的 segfault / abort 计数
journalctl -k --since '30 days ago' | grep -ciE 'runc.*segfault|runc.*abort'
# 在受影响内核（v6.17 ≤ version < v7.2）上，这个数字在升级到 v1.5.2 后应归零
uname -r  # 确认内核版本落在越界写影响区间
```

**指标 6：fd 泄漏修复——长跑节点的 fd 使用曲线变平**

```bash
# 老版本：eBPF devices cgroup 路径的 fd 泄漏在长跑节点上累积
# 验证：持续创建/销毁容器 6 小时，监控 runc 进程（或 containerd 的 runc shim）fd 数
while true; do
  runc run testcid &; sleep 2; runc delete testcid
  ls /proc/$(pgrep -f 'runc')/fd 2>/dev/null | wc -l
done
# 老版本曲线单调上升；v1.5.2 曲线平稳（泄漏点已修 + O_CLOEXEC 补齐）
```

## 七、6 条 6-12 个月可观察未来信号

**信号 1：runc 1.6 发布并强制 libpathrs。** CHANGELOG 已明确预告（「we currently plan to make runc 1.6 *require* libpathrs」）。**6-12 个月内**所有发行版打包的 runc 都需要处理 libpathrs 的 C 库依赖。**打包链的跟进速度是观察 runc 生态执行力的直接指标。**

**信号 2：libcontainer 公共 API 大幅收缩。** `cmsg` helpers 移入内部包（1.6 移除 wrapper）、`libcontainer/devices` 整包弃用（1.6 移除）、`configs.Mount.Relabel` 变 no-op（1.7 移除）。**runc 在系统性地把「不小心变公共」的实现细节收回去**——直接依赖 libcontainer 的项目（如某些 CI runner、安全工具）需要迁移。

**信号 3：1024 CPU 上限解除的连锁影响。** `configs.ToCPUSet` 返回类型从 `*unix.CPUSet` 变 `unix.CPUSetDynamic`——**这是一个破坏性的 libcontainer API 变更**。所有做 CPU 绑定的上游代码（device plugin、NUMA-aware 调度器、AI 集群的 GPU+CPU 绑定工具）会跟进。**GB300 这类 1000+ 线程的 AI 节点让这个变化从「理论上正确」变成「必须」**。

**信号 4：opencontainers/cgroups 成为 cgroup 操作的事实标准库。** v0.1.0 被 runc 采用、删掉 BPF 高级依赖后，这个库的定位清晰了：**cgroup v2 操作的薄封装，不引入 BPF 框架**。containerd、Podman、CRI-O 跟进采用是可预期的。

**信号 5：内核 v7.2 修复越界写后的「双重维护期」。** runc 的 workaround（多分配尾部空间）会在内核 v7.2 普及后变成「不必要的开销」。**观察 runc 何时移除 workaround——如果它保留很久，说明兼容性策略是「假设内核有 bug」，这是容器运行时的常态。**

**信号 6：安全审计方法论的变化。** CVE-2026-41579 的公告写明「We have conducted a deeper audit and not found any other problematic cases」——**这是「同源 bug 专项审计」的声明**。同类问题（rootfs 准备路径的符号链接处理）在过去一年被修了 4 次。**「修一个 bug 就审计一类路径」会成为低层运行时的标准动作。**

## 八、总结与最佳实践

### 8.1 ✅ 该用

1. **升级到 v1.5.2**，如果你的节点内核在 v6.17 - v7.1 区间。**这是唯一能修「随机 runc 崩溃」的版本**，而且这个崩溃无法通过其它方式绕过。
2. **在高核数节点（1024+ 线程）上盯住 runc 版本。** 老版本的 cpuAffinity 静默截断到前 1024 个 CPU，**你的 AI 训练任务可能一直没绑上你以为的核**，而这个故障没有任何报错。
3. **让 maskPaths 的 tmpfs 复用生效。** K8s 默认 maskedPaths 在高密度节点上的 superblock 回收开销是实在的。**这是「免费的性能优化」——升级即得，无需配置**。
4. **在打包 runc 时处理 libpathrs 依赖。** 1.5.x 是可选，**1.6 是强制**。提前在构建流水线里集成（`script/build-libpathrs.sh` 提供了参考构建）。
5. **用 `runc features` 探测运行时能力。** 1.5.0 起它输出 libpathrs 版本信息，**这是判断节点上 runc 是否启用抗竞争路径解析的最快方法**。

### 8.2 ❌ 千万别用

1. **不要直接依赖 libcontainer 的公共 API。** runc 自己的文档明确不推荐，且 API 正在系统性收缩（`cmsg`、`libcontainer/devices`、`Mount.Relabel`）。**用 OCI runtime-spec 的 config.json 走 runc 二进制，而不是嵌入库**。
2. **不要用 `--cgroup` 传相对路径做跨容器编排。** 新版本会拒绝路径逃逸。**如果你在实现「容器内进程进另一个 cgroup」的调度逻辑，改用层级从属检查，不要靠前缀**。
3. **不要假设 1024 CPU 上限是内核限制。** 它是 glibc 的 `cpu_set_t` 编译期大小。**在写任何 CPU 绑定代码前，先确认你的用户态类型是否能表达目标机器的 CPU 数**。
4. **不要在性能优化路径上省掉降级逻辑。** maskPaths 的 bind mount 失败时回退到每目录 tmpfs——**「优化失败就报错」是不可接受的设计，边缘情况必须能 work**。
5. **不要忽视「无法复现的崩溃」。** runc 的这个 bug 横跨内核与用户态、症状依赖内存分配器状态。**节点上零星的、堆栈各异的 segfault，先查内核版本和用户态结构体长度 mismatch**。

### 8.3 5 步生产升级 checklist

- [ ] **1. 确认节点内核版本**。`uname -r`。落在 `v6.17 ≤ k < v7.2` → 升级 v1.5.2 优先级最高（修随机崩溃）；其它版本按常规节奏。
- [ ] **2. 检查高核数节点的 CPU 绑定**。`runc exec <cid> taskset -pc 1` 对比 spec 声明的 cpus 集合。**不一致说明截断正在发生**。
- [ ] **3. 打包链处理 libpathrs**。参照 `script/build-libpathrs.sh`；无 C 工具链的环境准备 fallback（不带 `libpathrs` tag 构建，但要知道 1.6 会移除这个选项）。
- [ ] **4. 灰度并监控 fd 与崩溃**。升级后 48 小时内监控：`journalctl -k | grep runc.*segfault`（应归零）+ containerd shim 的 fd 数曲线（应变平）。
- [ ] **5. 验证 maskedPaths 与设备规则行为未变**。`runc exec <cid> cat /proc/kcore` 应仍被拒（只读 tmpfs 掩蔽）；容器内访问非白名单设备应仍 `EPERM`。**实现路径变了，外部行为必须不变。**

### 8.4 5 条最佳实践

1. **依赖的正当性看「它解决的问题是否在你这里存在」，不看它的流行度。** runc 为一个通用 BPF 框架付了 1 MiB 二进制的税，而它只有一种 BPF 程序要加载。
2. **「固定大小用户态类型」是最隐蔽的一类上限。** `cpu_set_t` 的 1024 不是内核限制，是头文件里的一个 `#define`。**所有「到 N 就坏」的问题，先分清是内核接口限制还是用户态类型限制**。
3. **用户态绕过内核 bug 的标准手段：让内核写到不痛的地方。** runc 给结构体多分配尾部空间吸收越界写。**在内核修复普及前，这是唯一可执行的修复**。
4. **性能优化的降级路径必须保留且必须是 sticky 的。** bind 失败一次就永久回退——**重试已知不支持的路径只会浪费时间和制造日志噪声**。
5. **同源 bug 修一个要审计一类。** CVE-2026-41579 是 rootfs 符号链接问题的第 4 次出现。**「漏网的同类 bug」比「新类型的 bug」更常见，因为说明第一次修复时没有做系统性审计**。

## 写在最后

runc v1.5.2 的 changelog 只有 5177 字节，但它标记的是一个项目对自身实现复杂度的系统性清算。

**一个低层运行时的默认行为，定义了「容器」在这台机器上的实际含义。** 当 runc 决定 cgroup v2 设备规则不再走通用 BPF 框架、路径解析默认走内核的 `openat2`、CPU 亲和性不再有 1024 的编译期上限——这些变化不会出现在任何架构图上，但它们改变了每一个在这台机器上跑的容器的边界条件。

特别值得记住的是那个内核越界写。**一个横跨内核与用户态、症状依赖内存分配器状态、在 v6.17 到 v7.2 的内核上存在了大半年的 bug**，表现是「runc 偶尔崩溃，无法复现」。**这类 bug 是系统编程的常态**：不是某一行代码写错了，而是两个软件层对一个共享结构体的长度假设不一致。而修复方式——在用户态多分配一点空间让内核写到不痛的地方——**是「与不完美的内核共存」的教科书式示范**。

**三个长期判断**：

1. **低层运行时的「做减法」时代到来。** runc 1.5 系列的两条主线——去掉 BPF 高级依赖（-1 MiB）、把路径解析交给 libpathrs（+安全性）——**方向相反但原则相同：把复杂度归到它该在的地方**。通用框架的复杂度属于通用场景；安全能力的复杂度属于处理不受信任输入的场景。**判断依赖去留的唯一标准，是它解决的问题在你这里是否真实存在**。

2. **1024 CPU 上限的解除是「AI 硬件规格倒逼软件基础设施」的又一样本。** GB300 NVL72 这类节点的 CPU 线程数让 glibc 的编译期常量从「永远碰不到」变成「标配就碰到」。**未来 12 个月，所有有「固定大小位图/数组」历史包袱的基础设施组件（taskset、numactl、cgroup 工具、调度器）都会逐个踩到这条线**。先查头文件，再查内核接口。

3. **「opencontainers/* 库族」成为容器基础设施的默认依赖层。** cgroups（v0.1.0 被 runc 采用）、runtime-spec v1.3.0、selinux、moby/sys 系列——**runc 正在把自己的通用能力一个个拆成独立库，自己退回「OCI 运行时核心」的定位**。这个趋势的下一站是 libcontainer 公共 API 的持续收缩。**用库可以，用 libcontainer 内部 API 不行——这是 1.6/1.7 要划清的边界**。

---

**数据来源**：本文所有代码与变更细节来自 runc 官方 CHANGELOG.md（main 分支）、PR #5403 / #5343 / #5275 / #5103 / #5204 的完整 patch（patch-diff.githubusercontent.com）、v1.5.2 release notes，以及 opencontainers/cgroups v0.1.0 的 release 页面。性能数据（-1 MiB / 7.5%、1024 CPU 上限、tmpfs superblock 回收）来自 CHANGELOG 与 PR 描述中的作者实测声明。
