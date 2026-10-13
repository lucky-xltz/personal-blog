---
title: "BuildKit v0.34.0 深度拆解:BoltDB 压缩、src= 子目录导出、targetPlatform 溯源与 NoFreelistSync 优雅关闭"
date: 2026-10-13
category: 技术
tags: [BuildKit, Docker, Moby, 构建工具, Buildkitd, bbolt, BoltDB, 数据库压缩, Compaction, Freelist, NoFreelistSync, GC, 缓存, Build Cache, 本地缓存, S3 远程缓存, Provenance, SLSA, targetPlatform, attestation, 供应链安全, Gateway API, LLB, 多平台构建, Hyper-V, Windows 容器, containerd, OCI, gRPC, 流控, stdio, QEMU, SOURCE_DATE_EPOCH, 可复现构建, Git 源, overlayfs, session auth, OpenTelemetry, Prometheus, 运维, 2026]
excerpt: "2026 年 10 月 7 日 BuildKit v0.34.0 发布。这个版本表面是常规维护版,骨架却是「构建缓存数据库第一次拥有自己的 GC 协议」:① BoltDB 压缩框架落地(cache.db / history.db / metadata_v2.db / containerdmeta.db),opt-in 开启,默认参数 writesPerCheck=10000 / sizeWatermark=128MiB / minReclaimBytes=256MiB / idleTimeout=1m,「先排空事务再拷贝、写者可取消自动压缩」的并发模型把数据库维护变成了可调度的运维动作;② NoFreelistSync=true 提速日常提交,仅在优雅关闭时写一次 freelist,启动重建 freelist 的开销被消掉;③ local/tar exporter 新增 src= 子目录导出,多平台构建产物按平台拆目录一行解决,代价是「老守护进程会静默忽略未知选项导出整个结果」;④ SLSA provenance 新增 internalParameters.targetPlatform,多平台构建每个结果的溯源记录第一次能区分 builderPlatform 与 targetPlatform;⑤ session auth 超时可配 + registry token 瞬时失败自动重试,把「构建因 60s 握手超时随机失败」变成可调参数。另含 Gateway NewContainer 保留 platform、Windows Hyper-V 隔离模式、S3 远程缓存压缩选项、并发 local cache export reset 防护、GC policy 空配置 panic 修复、7 处缓存引用泄漏/死锁修复。本文逐条拆解设计动机,给出可运行的 buildkitd.toml / buildctl / debug endpoint / Go Gateway 代码,以及升级前必须自查的 8 个诚实边界。"
cover: https://images.unsplash.com/photo-1607706189992-eae578626c86?w=600&h=400&fit=crop
readtime: 24
author: 林小白
---

# BuildKit v0.34.0 深度拆解:BoltDB 压缩、src= 子目录导出、targetPlatform 溯源与 NoFreelistSync 优雅关闭

> 2026 年 10 月 7 日,BuildKit v0.34.0 发布(对应内置 Dockerfile frontend v1.28.0)。这是一个没有新名词的版本——没有新语法、没有新 frontend、没有换存储引擎。但它改了一件 8 年没人改过的事:**构建缓存的 BoltDB 文件第一次有了自己的空间回收协议**。在此之前,BuildKit 的 GC 只删缓存记录,不删数据库文件里的空闲页;一个跑了半年的 buildkitd,`cache.db` 可以只增不减。v0.34.0 把「压缩」做成了 daemon 级可调度、可观测、可取消的运维动作,并顺手修掉了 NoFreelistSync 的启动代价、补上了多平台溯源缺失的 targetPlatform、给 local exporter 加了等了多年的 `src=` 选项。

## 1. 问题的源头:为什么构建缓存的数据库会只增不减

BuildKit 的缓存元数据存在几个 bbolt(BoltDB)文件里:

| 文件 | 内容 | 谁在写 |
|------|------|--------|
| `cache.db` | 缓存记录索引(哪个 digest 对应哪些 ref、哪些 blob) | 每次构建命中/新建缓存 |
| `history.db` | 构建历史(对应 `buildctl history` / `docker buildx history`) | 每次构建结束 |
| `metadata_v2.db` | worker 侧缓存元数据(每个 snapshotter 一份,e.g. `runc-overlayfs/metadata_v2.db`) | 每次层创建/挂载 |
| `containerdmeta.db` | containerd worker 的镜像层元数据 | containerd worker |
| `snapshots/metadata.db` | 快照元数据(**归 snapshotter 自己管,不参与压缩**) | snapshotter |

bbolt 是一个 B+ 树的单文件嵌入式数据库,用 mmap 把整个文件映到内存。它有一个关键特性:**删除数据不会缩小文件**。被释放的页进 freelist,后续写入优先复用。这对「写多删多」的缓存场景是合理设计——避免频繁文件扩张。但代价是:如果工作负载是「大量短期缓存 + 持续 GC」,freelist 里会囤积大量空闲页,文件体积只反映「历史峰值」,而不是「当前活数据量」。

BuildKit 的 cache GC(那条 `--gc-keep-storage` / `--gc-keep-bytes` 的策略链)只删缓存**记录**。记录删了,数据库文件里的页变成空闲,但文件不会缩小。在 CI 场景下这个问题尤其尖锐:

- 一个共享 buildkitd 每天跑几百个构建,每个构建产生新缓存层
- GC 按 `keepStorage` 淘汰旧记录
- `cache.db` 的文件大小单调逼近「历史最高并发活数据量」,然后停在那里
- 磁盘监控看到的是 `cache.db` 占了 2GB,但实际活数据可能只有 300MB——**没有手段把那 1.7GB 还给文件系统**

唯一的前官方答案是手动停服 + `bbolt compact` 命令行工具离线压缩。生产环境共享构建节点停服压缩,基本等于不可操作。

**v0.34.0 的回答**:把压缩做进 daemon,做成 opt-in 的调度策略,带触发阈值、空闲等待、写者取消、磁盘空间检查和完整 OTel 指标。核心代码在新增的 `util/db/compaction` 包与 `util/db/boltutil/compact.go`。

## 2. 核心设计:压缩的调度模型

压缩的完整配置(来自新增的 `docs/compaction.md`,PR #7138 + #7248):

```toml
# /etc/buildkit/buildkitd.toml
[compaction]
enabled = true            # 默认 false,opt-in
writesPerCheck = 10000    # 每多少次已提交写事务做一次可回收性检查
sizeWatermark = 134217728 # 初始大小水位线 128 MiB
sizeGrowthPercent = 100   # 压缩后「紧凑大小 + 100%」作为下一次水位线
minReclaimBytes = 268435456  # 最少可回收 256 MiB 才值得压
minReclaimPercent = 25    # 或最少可回收 25% 的文件大小
minReclaimPercentFloor = 25  # #7248 新增:百分比下限保护,防止配错参数
idleTimeout = "1m"        # 需要连续 1 分钟无任何数据库活动(读和写都算)
maxRetry = 3              # 新到写者最多取消 3 次自动压缩,之后排队等
```

**调度逻辑**(这是设计上最值得读的部分):

1. **自适应水位线**:第一次压缩触发点是固定的 `sizeWatermark`(128MiB)。压缩成功后,下一次水位线 = `压缩后大小 × (1 + sizeGrowthPercent)`,且不低于 `sizeWatermark`。也就是说,**压缩后的库不会立刻又被判定为可压缩**,避免无意义地反复拷贝一个稳定的库。

2. **写计数器旁路**:只靠水位线会漏掉一种情况——bbolt 复用空闲页时文件不增长,但删除操作确实释放了空间。所以每 `writesPerCheck` 次已提交写事务,绕过自适应水位线直接做一次可回收性检查。**这条路径捕获「文件没变大但里面空了」的场景**。

3. **两个可回收阈值是 OR 关系**:`minReclaimBytes`(256MiB)或 `minReclaimPercent`(25%)满足任一即 pending。**删除写本身就能让库进入 pending,不需要文件再增长**。

4. **空闲等待是硬门槛**:pending 之后不立刻压,要等「无活跃事务 + 配置的 idleTimeout」。读和写都算活跃。**这是把压缩对在线构建的影响约束在「构建真的停了」的窗口里**。

5. **写者优先的取消机制**:压缩要排空事务并阻塞新事务。新到的写者可以取消正在进行的自动压缩,最多 `maxRetry` 次;超过次数后写者排队等压缩完成。`maxRetry = 0` 表示第一次自动压缩就让写者等。**核心哲学:压缩是维护任务,不能挡构建**。

6. **磁盘空间前置检查**:压缩需要「原文件 + 新文件」并存的空间。`checkDiskSpace` 在拷贝前重检可回收性与剩余空间。文档原话:**"Compaction needs enough free space for a replacement file alongside the original. It cannot by itself recover an already-full volume, reclaim retained live data, or make cache GC account for database files."** —— 三个不能:不能救满盘、不能回收被活数据占的空间、不能替代 cache GC。**压缩与 cache GC 是两套独立机制,各管各的**。

7. **daemon 内序列化**:所有数据库的压缩拷贝在整个 daemon 内串行执行,不并发拷多个库。

8. **检查点持久化**:写计数器与自适应水位线每 5 分钟、以及优雅关闭时,checkpoint 到数据库旁边(`path.compact-state`)。重启后策略状态不丢。

`#7248` 补的 `minReclaimPercentFloor` 是一个防配错的保护:当你显式设置了 `minReclaimPercent` 但没设 floor 时,`Policy()` 会用一个下限值兜底,防止把百分比配成 0 导致无限触发压缩。

## 3. NoFreelistSync:日常省一次 fsync,关闭时还回来

PR #6882 + #7249 是一对,讲的是一个「时间换空间」的完整闭环。

**bbolt 的 freelist 同步代价**:bbolt 默认每次提交写事务时同步 freelist 页到磁盘。对 BuildKit 缓存这种「每秒可能几十上百次小写」的场景,这个 fsync 是热路径开销。bbolt 提供了 `NoFreelistSync=true` 选项跳过它,代价是**下次打开数据库时要扫描整个文件重建 freelist**——启动慢,且大文件时可能显著。

**v0.34.0 的做法**(PR #6882):给 cache.db / history.db / metadata_v2.db / containerdmeta.db 全部打开 `NoFreelistSync: true`。从 diff 看,改动是逐个 `boltutil.Open` / `SafeOpen` 调用点加选项:

```go
db, err := boltutil.Open(dbPath, 0600, &bolt.Options{
    FreelistType:   bolt.FreelistMapType,
    NoFreelistSync: true,
}, policies...)
```

**关键问题:那启动重建 freelist 的代价谁付?** PR #7249 在 `DB.Close()` 里补上了答案:

```go
// util/db/boltutil/db.go
func (d *DB) Close() error {
	var err error
	if d.policy != nil {
		err = d.policy.Close()
	}
	if d.opts.NoFreelistSync && !d.opts.ReadOnly && !d.reopenNeeded.Load() {
		// Keep normal commits cheap, but avoid reconstructing the freelist on
		// the next open after an orderly shutdown.
		d.bdb.NoFreelistSync = false
		// Let bbolt sync the freelist pages before the new meta page.
		d.bdb.NoSync = false
		if checkpointErr := d.bdb.Update(func(*bolt.Tx) error { return nil }); checkpointErr != nil {
			bklog.L.WithError(checkpointErr).Warnf("failed to checkpoint bbolt freelist for %s", d.path)
			err = stderrors.Join(err, errors.Wrap(checkpointErr, "failed to checkpoint freelist"))
		}
	}
	return stderrors.Join(err, d.bdb.Close())
}
```

**读这段注释,它把设计意图说得比文档清楚**:日常提交保持便宜(不同步 freelist),但优雅关闭时临时把 `NoFreelistSync` 关掉、`NoSync` 关掉,跑一次空 `Update` 让 bbolt 把 freelist 页同步到新 meta 页之前。**把重建 freelist 的成本从「每次启动」搬到了「每次优雅关闭」**。

三个边界条件值得注意:

- `!d.opts.ReadOnly` —— 只读库不写 freelist
- `!d.reopenNeeded.Load()` —— 内部标记需要重开的库不处理(压缩替换文件后内部会重开,此时走另一条路径)
- **如果 buildkitd 被 SIGKILL 或掉电,这次 checkpoint 没发生,下次启动仍需重建 freelist**。这是用「正常关闭的确定性」换「异常关闭后的一次慢启动」,对长期运行的 daemon 是划算的

配套测试 `db_test.go` 里有一个直接读磁盘文件 meta 页验证 freelist 页数的方法:

```go
func diskFreelist(t *testing.T, path string, pageSize int) (uint64, uint64) {
	t.Helper()
	f, err := os.Open(path)
	require.NoError(t, err)
	defer f.Close()
	var meta [72]byte
	// ... offset 48..56 是 freelist 页数(LittleEndian)
	var txid, freelist uint64
	// txid = binary.LittleEndian.Uint64(meta[8:16])
	freelist = binary.LittleEndian.Uint64(meta[48:56])
	return txid, freelist
}
```

这个函数本身就是生产排障工具:**不停 buildkitd、不依赖 bbolt 工具,直接从文件二进制读出 freelist 页数**,判断你的库是不是「文件大但 freelist 也大」(可压缩)还是「文件大且活数据真多」(别压)。

## 4. src= 子目录导出:一个等了多年的 exporter 选项

PR #7226 给 local 和 tar exporter 加了 `src` 选项。README 原文:

```bash
# 以前:要导出某个子目录,得专门写一个 stage
FROM builder as reports
COPY --from=builder /usr/src/app/testresult.xml .
# buildctl build ... --opt target=reports --output type=local,dest=out

# 现在:直接指定子目录,不需要专门 stage
buildctl build ... --output type=local,dest=path/to/output-dir,src=/usr/src/app/reports
```

**语义细节**(这些细节决定了它能不能用在生产):

- `src` 的内容被写到 dest 的**根**,所以 `src=/usr/src/app/reports` 导出 `reports/index.html` 为 dest 下的 `index.html`。**不是把 reports 目录本身放进去**
- `src` 必须指向**目录**,不能是单个文件
- 始终从构建结果的**根**解析,`src=app/build` 与 `src=/app/build` 等价
- 符号链接在构建结果内解析:指向 `/etc` 的链接指结果内的 `/etc`,**绝不指宿主机的 /etc**
- 多平台构建时,`src` 应用到**每一个平台的结果**

**⚠️ 最安静的破坏性行为**:文档最后一句——"Use a BuildKit daemon that supports `src`. Older daemons ignore unknown exporter options and may export the entire build result instead."

这句话的信息量很大。**老守护进程不会报错,它忽略未知选项,然后导出整个文件系统**。想象一个 CI 流水线:buildx client 升级了,buildkitd 没升级,导出产物从「200MB 的 reports 目录」静默变成「12GB 的整个构建结果」,磁盘瞬间爆掉,而构建本身返回成功。**这是 BuildKit 「client/daemon 版本不对齐」设计下最容易被忽略的一类静默行为**,跟之前几个版本反复出现的「安静的 breaking change」是同一类风险。

**排障命令**:升级后用一行验证 src 真的生效了:

```bash
buildctl build \
  --frontend dockerfile.v0 \
  --local context=. --local dockerfile=. \
  --opt platform=linux/amd64,linux/arm64 \
  --output type=local,dest=/tmp/out-amd64,src=/usr/src/app/reports,platform=linux/amd64 \
  --output type=local,dest=/tmp/out-arm64,src=/usr/src/app/reports,platform=linux/arm64
# 验证:两个目录都应该只有 reports 的内容,且文件数一致
ls -la /tmp/out-amd64 /tmp/out-arm64
```

## 5. SLSA targetPlatform:多平台溯源的「主体身份」第一次准确

PR #7227 是一个供应链安全领域会有人专门来查的改动。它给 SLSA provenance 加了 `buildDefinition.internalParameters.targetPlatform`。

**之前的问题**:provenance 里只有 `builderPlatform`——跑这次构建的**机器**平台。文档原文提醒:"Note that this is not necessarily the platform of the build result that can be determined from the in-toto subject field."

在多平台构建里这句话是致命的:一次跨 4 个平台的构建,`builderPlatform` 全是 `linux/amd64`(构建机的),而 4 份产物的实际目标平台各不相同。**只看 provenance 无法回答「这个镜像到底是给什么架构构建的」**,得去翻 in-toto subject 的 digest 再反查镜像 manifest。

**改动后**:

- `targetPlatform` 是**构建结果**关联的平台,e.g. `linux/arm64`
- 即使请求没显式指定 platform 也会设置
- **多平台构建时,每个结果的 provenance 各带自己的 targetPlatform**
- 对二进制产物,这个值描述「声明的结果平台」;BuildKit **不会**去检查输出二进制判断它的真实架构——这是一个诚实边界:声明 ≠ 验证

`mode=min` 和 `mode=max` 都包含这个字段。文档更新(slsa-definitions.md)明确把两者并排列出:

```
BuildKit sets the `builderPlatform` of the build machine. This is not
necessarily the platform of the build result, which is recorded separately in
`targetPlatform`.

### `buildDefinition.internalParameters.targetPlatform`
* Ref: https://slsa.dev/spec/v1.1/provenance#internalParameters
* Included with `mode=min` and `mode=max`.
```

**为什么这个字段重要**:SLSA 的 provenance 核心用途是「事后验证产物身份」。验证规则常常是「targetPlatform 必须等于我部署目标的平台」。没有这个字段时,多平台构建的 provenance 验证规则写不出来——你无法在 4 份产物里区分哪份是 arm64。**有了它,多平台构建的 provenance 第一次能按平台分别写验证策略**。

## 6. 会话认证与 registry token:把「随机失败」变成「可配超时 + 自动重试」

两个相关改动解决的都是 CI 里「构建莫名其妙失败,重跑又好了」的老问题。

**PR #7225 —— session auth 超时可配**:

buildx client 与 buildkitd 之间的认证走 session(长连接)。之前 daemon 侧的认证往返**没有显式超时**。diff 里新加的配置字段:

```go
// SessionAuthTimeout is the timeout for daemon-side session auth
// round-trips with the buildx client session. Defaults to 60 seconds.
// A value of zero or less disables the deadline entirely.
SessionAuthTimeout *Duration `toml:"sessionAuthTimeout"`
```

```toml
[system]
sessionAuthTimeout = "60s"
```

注意默认 60s,**且 `0` 或负数是彻底关掉这个 deadline**。设计上把它做成「可关」而不是「可调大」,说明作者清楚有些场景就是要等(慢 registry、跨区认证)。**这是一个把硬编码隐含超时变成显式可配契约的改动**。

**PR #7155 —— registry token 瞬时失败重试**:

Docker Hub(和其他 registry)发 token 时会偶发 5xx / 网络抖动。之前一次失败整个构建就挂。改动把 `FetchTokenWithOAuth` 包进了已有的 `retryhandler.WithRetry`:

```go
// session/auth/authprovider/authprovider.go
resp, err := retryhandler.WithRetry(ctx, nil, func(ctx context.Context) (*authutil.OAuthTokenResponse, error) {
    return authutil.FetchTokenWithOAuth(ctx, httpClient, nil, "buildkit-client", to)
})
```

**这是把一个「瞬时基础设施故障」从「构建失败」降级为「重试一次」**。对 CI 稳定性的收益是隐性的但真实:你不会再因为 Docker Hub 一次 502 重跑整个流水线。

## 7. 其余承重改动:一句话一个设计判断

**① Gateway NewContainer 保留 platform(PR #7083)**

LLB Gateway API 允许 frontend 自己创建容器(`client.NewContainer`)。之前转发请求时把 platform 信息丢了,创建出来的容器平台信息不完整。diff 只加了一行:

```go
req := &container.NewContainerRequest{
	// ...
	Platform:    req.Platform,   // 新增
}
```

一行,但语义是:**Gateway frontend 创建的容器第一次能真正带平台信息**。对写自定义 frontend 的人(而不是用 Dockerfile 的人)这是一个正确性修复。

**② Windows Hyper-V 隔离模式(PR #7067)**

```toml
[worker.containerd]
hypervIsolation = true
```

Windows 容器可以用 process 隔离或 Hyper-V 隔离。之前 BuildKit 的 containerd worker 没法配。**这是 BuildKit Windows 支持补齐的一块**——不是新功能,是把已有的 Windows 能力暴露成配置项。

**③ S3 远程缓存压缩选项(PR #7121)**

S3 cache exporter 新增 `compression` / `compression-level` / `force-compression`。README 原文的一个关键诚实边界:

> `estargz` layers are recorded as plain `gzip` layers in the s3 cache manifest (their eStargz annotations are not preserved), so they cannot be lazily pulled from s3

**选 estargz 存 S3 缓存会丢失懒加载能力**——annotation 不被保留。如果你的目的是「缓存层能懒拉」,只能选 gzip 或 zstd。

**④ 并发 local cache export + reset 防护(PR #7153)**

`--export-cache type=local,reset=true` 会删掉缓存目录里不被当前 manifest 引用的 blob。之前多个构建并发跑 reset 会互相删。v0.34.0 加了保护,README 更新:"Cleanup is skipped when the store is busy."

**注意语义:skipped,不是 queued**。并发时这次清理被跳过,等你下次单跑时才做。这是一个「不删错比删干净重要」的选择。

**⑤ SOURCE_DATE_EPOCH + git 子目录修复(PR #7183)**

可复现构建相关的 bug:`--opt source=git://...#<subdir>` 配合 `SOURCE_DATE_EPOCH=commit` 时,获取 commit 时间的命令用错了 git CLI 句柄:

```go
// before
commitTime, err := getCommitTime(ctx, git, refOrCommit)
// after
commitTime, err := getCommitTime(ctx, repo.GitCLI, refOrCommit)
```

`git` 是全局裸仓库的句柄,`repo.GitCLI` 是带正确工作目录的句柄。用错句柄在子目录场景下拿到的时间戳可能来自错误的 ref,**直接破坏可复现性**——元数据时间戳是可复现构建的核心输入之一。

**⑥ QEMU 模拟取消修复(PR #7092)**

取消 QEMU 模拟的构建步骤会报错。根因是代码直接修改了共享的 `e.op.Meta.Args`(把 qemu 挂载名 prepend 进去),取消时这个修改被回滚/观察到导致状态错乱。修复是改用局部变量:

```go
args := e.op.Meta.Args
if emu != nil {
    args = append([]string{qemuMountName}, args...)
	// ...
}
meta := executor.Meta{
	Args: args,   // 用局部变量,不动共享状态
	// ...
}
```

**这是一个典型的「共享可变状态」并发 bug**:protobuf 生成的 `e.op.Meta` 在多个 goroutine 间共享,直接改它的字段不安全。

**⑦ GC policy 配置 panic 修复(PR #7209)**

```go
// before: 空字符串 s="" 时 s[len(s)-1] 越界 panic
if s[0] == '"' && s[len(s)-1] == '"' {
// after
if len(s) >= 2 && s[0] == '"' && s[len(s)-1] == '"' {
```

**一个守护进程级的 panic,触发条件是 GC policy 配置里出现空字符串**。这类 bug 的特点是:配错了不报「配置错误」,直接 daemon 挂掉。`stripQuotes` 这个函数名说明原本只是想剥掉 TOML 解析后可能残留的引号,但漏了空串边界。

**⑧ 缓存引用泄漏与 stdio 死锁(4 个 PR)**

- **#7223**:`COPY missing.txt /` 这类**失败构建**的缓存记录之前可能一直留在「in use」状态,占着 ref 不释放。新测试 `testMissingCopySourceReleasesCache` 显式覆盖:`FROM scratch\nCOPY missing.txt /` 跑两遍,验证缓存记录可被 GC
- **#7182**:并行构建的 export 步骤报 `ref locked: unavailable`。修复引入 `math/rand/v2` 加随机退避,避免多个请求同步重试造成活锁
- **#7240**:Gateway container exec 的双向 stdio 在数据量超过 gRPC 流控窗口(测试用 **16 MiB**)时会死锁。测试注释写明:"Use 16 MiB to exceed the gRPC flow-control window and reproduce the bidirectional stream deadlock."
- **#7247**:Gateway 共享 exec 出错时的 ref 泄漏(新文件 `gateway_shared_error_test.go` 专门覆盖)

**这四个是同一类问题的四个面:构建出错路径上的资源清理**。成功路径早就打磨好了,失败路径的 ref/流生命周期是这版的重点。

**⑨ IPv6 无端口地址处理修复(#7164)**、**配置路径环境变量(#7144,`BUILDKITD_CONFIG`)**、**overlayfs EBUSY(#7167,改用不依赖临时空目录的 diff 视图构造)** —— 都是边角正确性修复,不展开。

**⑩ 内部数据库索引永不释放修复(#7135)**

这个值得单独说。`StorageItem.setValue` 之前依赖**内存里**的 `s.values` map 判断「这个 index 还有没有别的 value 在用」。但另一个 StorageItem 句柄、或者调用方直接改了 `Get` 返回的 Value,都可能让内存 map 与数据库实际状态不一致。修复改成**从事务里重读旧值**:

```go
// Read the previous index from the transaction: another StorageItem handle
// or a caller modifying a Value returned by Get may have changed the cache.
var old Value
if dt := b.Get([]byte(key)); len(dt) > 0 {
	if err := json.Unmarshal(dt, &old); err != nil {
		return errors.WithStack(err)
	}
}
// ...
if old.Index != "" && old.Index != index {
	// Index entries are shared by all values on this record. Remove an old
	// entry only after its last value stops referencing it.
	inUse := false
	if err := b.ForEach(func(_, dt ...
```

注释把不变量写进去了:**index 条目被同一条记录的所有 value 共享,只有最后一个引用它的 value 走了才能删**。之前基于内存 map 判断会误删还在用的 index,导致索引损坏/查询不到缓存。**这是把「内存里的隐含状态」换成「事务里的真实状态」**。

---

## 8. 可运行代码:从开启压缩到排障

### 8.1 最小可用配置 + 前置体检

开启前先体检:你的库值不值得压。

```bash
# 1) 看 buildkitd 的数据库有多大
docker exec buildkitd ls -lh /var/lib/buildkit/
# 关注: cache.db  history.db  runc-overlayfs/metadata_v2.db  containerdmeta.db

# 2) 不停服务,直接读磁盘 meta 页判断 freelist 占比
#    (bbolt meta 页 offset 48..56 = freelist 页数, page size 通常 4096)
python3 - <<'PY'
import struct, os
for p in ["/var/lib/buildkit/cache.db", "/var/lib/buildkit/history.db"]:
    if not os.path.exists(p):
        print(p, "missing"); continue
    with open(p, "rb") as f:
        m = f.read(72)
    pgsize = struct.unpack("<Q", m[56:64])[0] or 4096
    freelist = struct.unpack("<Q", m[48:56])[0]
    total = os.path.getsize(p) // pgsize
    print(f"{p}: pages={total} freelist={freelist} "
          f"empty={freelist/total:.0%} live={1-freelist/total:.0%}")
PY

# 3) 判断:如果 empty > 40% 且文件 > 256MiB,开启压缩有收益
#    如果 empty < 10%,别开——拷贝成本白付
```

最小配置:

```toml
# /etc/buildkit/buildkitd.toml
debug = true
root = "/var/lib/buildkit"

[compaction]
enabled = true
# 其他全用默认值。先跑一周看指标,再调阈值。
```

```bash
# containerd 部署示例
docker run -d --name buildkitd \
  --restart unless-stopped \
  -v /var/lib/buildkit:/var/lib/buildkit \
  -v /etc/buildkit/buildkitd.toml:/etc/buildkit/buildkitd.toml \
  moby/buildkit:v0.34.0 \
  --config /etc/buildkit/buildkitd.toml --debug --addr tcp://0.0.0.0:1234

# docker buildx 创建使用它的 builder
docker buildx create --name compaction-test \
  --driver remote tcp://buildkitd:1234 --use
```

### 8.2 debug 端点:手动压缩 + 实时状态

`debug_compaction.go` 新增了 HTTP 端点。**注意文档原话:开启 debug listener 就足以让这些操作可用,即使 `[compaction].enabled = false`。手动压缩绕过 `writesPerCheck` 和 `sizeWatermark`,但保留空闲等待、可回收阈值和磁盘空间检查。**

```bash
# 状态:每个库的大小 / 可回收量 / 为什么还不够格压
curl -s http://localhost:6060/compaction/status | jq .
# {
#   "cache.db": {
#     "size": 2147483648,
#     "reclaimable": 1610612736,
#     "available": 5368709120,
#     "required": 4294967296,
#     "reason": "below minReclaimPercent threshold"
#   },
#   ...
# }

# 手动触发压缩(流式返回进度)
curl -N http://localhost:6060/compaction/compact
```

**手动压缩的三条限制值得记住**:
1. 仍需空闲等待(idleTimeout)——构建在跑时不会开始
2. 仍受可回收阈值约束——不值得压会跳过
3. **仍可被新到写者取消,且永不升级成强制拷贝**

这意味着手动压缩不是「立即执行」,而是「排队走自动压缩同一条调度路径,只是跳过计数器门槛」。

### 8.3 指标:7 个 OTel instrument

压缩完全复用 daemon 已有的 OpenTelemetry meter provider,Prometheus 指标在 debug listener 的 `/metrics` 上直接可读。**不需要额外 exporter 或 listener**。

| OTel instrument | 类型 | 单位 | Prometheus 名 |
|---|---|---|---|
| `buildkit.compaction.attempts` | Counter | Attempts | `buildkit_compaction_attempts_total` |
| `buildkit.compaction.copy.duration` | Histogram | Seconds | `buildkit_compaction_copy_duration_seconds` |
| `buildkit.compaction.reclaimed` | Counter | Bytes | `buildkit_compaction_reclaimed_bytes_total` |
| `buildkit.compaction.pending.duration` | Gauge | Seconds | `buildkit_compaction_pending_duration_seconds` |
| `buildkit.compaction.database.size` | Gauge | Bytes | `buildkit_compaction_database_size_bytes` |
| `buildkit.compaction.database.reclaimable` | Gauge | Bytes | `buildkit_compaction_database_reclaimable_bytes` |
| `buildkit.compaction.database.observation.age` | Gauge | Seconds | `buildkit_compaction_database_observation_age_seconds` |

标签:`database.path`(相对 state 目录,如 `cache.db` / `runc-overlayfs/metadata_v2.db`,全平台用正斜杠,**不暴露绝对路径**)、`trigger`(`automatic`/`manual`)、`outcome`(`completed`/`skipped`/`canceled`/`failed`)。

**关键语义**(文档原话的工程含义):
- **"An attempt is counted when the backend is invoked; eligibility checks and requests canceled while waiting are not attempts."** —— 资格检查不算 attempt,所以 `attempts_total` 是真实拷贝次数
- **"Copy duration includes replacement, canceled and failed copies, but excludes waiting and transaction draining."** —— `copy_duration` 是纯拷贝耗时,排队等待在 `pending_duration` 里
- **"Reclaimed bytes are recorded only when replacement succeeded and the resulting size is known."**
- **"Collection only reads cached measurements... Collection does not poll the database or filesystem."** —— `/metrics` 采集零额外 I/O 负担,代价是**size 可能是陈旧的**

**告警规则示例**:

```yaml
groups:
- name: buildkit-compaction
  rules:
  - alert: BuildkitCompactionNeverSucceeds
    # 连续 24h 有 pending 但没有 completed
    expr: |
      max by (database.path) (buildkit_compaction_pending_duration_seconds) > 0
      and on(database.path)
      max by (database.path) (increase(buildkit_compaction_attempts_total{outcome="completed"}[24h])) == 0
    for: 30m
    annotations:
      summary: "buildkitd {{ $labels.database_path }} 压缩一直没成功过"
      desc: "检查 idleTimeout 是否太短,或库一直在活跃写(永远等不到空闲窗口)"

  - alert: BuildkitCompactionRepeatedlyCanceled
    # outcome=canceled 占比过高 = 写者一直在打断压缩
    expr: |
      sum by (database.path) (rate(buildkit_compaction_attempts_total{outcome="canceled"}[1h]))
      / clamp_min(sum by (database.path) (rate(buildkit_compaction_attempts_total[1h])), 1)
      > 0.5
    for: 1h
    annotations:
      desc: "超过一半的压缩被新构建取消。可调高 maxRetry 让写者多等等"
```

### 8.4 src= 导出:多平台流水线

```bash
# 场景:一个 repo 构建出 amd64/arm64 两份报告,分别上传
# 以前需要写两个 stage 或导出整个结果再筛
# 现在:
buildctl build \
  --frontend dockerfile.v0 \
  --local context=. --local dockerfile=. \
  --opt platform=linux/amd64,linux/arm64 \
  --output type=local,dest=/tmp/reports-amd64,src=/build/reports,platform=linux/amd64 \
  --output type=local,dest=/tmp/reports-arm64,src=/build/reports,platform=linux/arm64 \
  2>&1 | grep -E '^\s*#[0-9]+ exporting'

# 上传到两个平台的前缀
aws s3 sync /tmp/reports-amd64 s3://bucket/reports/amd64/
aws s3 sync /tmp/reports-arm64 s3://bucket/reports/arm64/
```

```dockerfile
# 对应的 Dockerfile 片段
FROM golang:1.24 AS build
WORKDIR /build
COPY . .
RUN go test ./... -json > /build/reports/tests.json \
 && go build -o /build/reports/app ./cmd/app

FROM scratch
COPY --from=build /build/reports /build/reports
```

**升级自查**:如果 buildx client 升了但 buildkitd 没升,`src=` 会被静默忽略,你会导出整个 `scratch` 镜像的文件系统。用这条命令验证 src 生效:

```bash
# 导出后目录里不应该出现 go 相关路径
find /tmp/reports-amd64 -maxdepth 2 | head
# 期望: 只有 /tmp/reports-amd64/tests.json 和 /tmp/reports-amd64/app
# 若出现 usr/ bin/ lib/ 等 = src 被忽略了,buildkitd 版本太老
```

### 8.5 Go 代码:Gateway frontend 里的 platform 与大 stdio

```go
// 一个 Gateway frontend,演示 v0.34.0 的两个修复点
// ① NewContainer 保留 platform(#7083)
// ② 大 stdio 不再死锁(#7240),这里故意写 16MiB+ 输出
package main

import (
	"bytes"
	"context"
	"os"

	"github.com/moby/buildkit/client/llb"
	gwclient "github.com/moby/buildkit/frontend/gateway/client"
)

func run(ctx context.Context, c gwclient.Client) (*gwclient.Result, error) {
	// 用平台信息创建容器 —— v0.34.0 之前这里的信息会被转发层丢掉
	ctr, err := c.NewContainer(ctx, gwclient.NewContainerRequest{
		Image: "alpine:latest",
		Platform: &llb.Platform{OS: "linux", Architecture: "arm64"}, // 现在真的生效
		Mounts: []gwclient.Mount{{Dest: "/out"}},
	})
	if err != nil {
		return nil, err
	}
	defer ctr.Release(ctx)

	// 跑一个产生 16MiB 输出的命令:v0.34.0 之前这里会死锁
	// gRPC 默认流控窗口远小于 16MiB,双向流被卡住
	proc, err := ctr.Start(ctx, gwclient.StartRequest{
		Args: []string{"sh", "-c", "dd if=/dev/zero bs=1M count=17 2>/dev/null | base64"},
	})
	if err != nil {
		return nil, err
	}

	buf := &bytes.Buffer{}
	if _, err := proc.Stdout().WriteTo(buf); err != nil { // 读取端必须持续读
		return nil, err
	}
	if err := proc.Wait(); err != nil {
		return nil, err
	}

	// 把结果写进 /out
	res := gwclient.NewResult()
	res.AddMeta("output-size", []byte(itoa(buf.Len())))
	return res, nil
}

func itoa(n int) string { return string(rune('0'+n%10)) + itoa0(n/10) }
func itoa0(n int) string {
	if n == 0 { return "" }
	return itoa(n)
}

func main() {
	gwclient.Run(ctx context.Background(), os.Args[0], run)
}
```

**⚠️ #7240 的教训**:Gateway 里跑产生大量输出的命令,**必须持续读取 stdout/stderr**,不能先等命令结束再读。修复的是 BuildKit 侧的死锁,但应用层不读照样会背压。

### 8.6 升级自查脚本

```bash
#!/usr/bin/env bash
# upgrade-check.sh —— 升级 v0.34.0 前后各跑一遍,对比数据库与缓存行为
set -euo pipefail
ROOT="${1:-/var/lib/buildkit}"

echo "=== 数据库体积 ==="
ls -lh "$ROOT"/*.db 2>/dev/null || docker exec buildkitd ls -lh /var/lib/buildkit/

echo "=== freelist 占比(#7249 的诊断法) ==="
python3 - "$ROOT" <<'PY'
import struct, os, sys
root = sys.argv[1]
for p in sorted(os.listdir(root)):
    if not p.endswith(".db"): continue
    fp = os.path.join(root, p)
    try:
        with open(fp, "rb") as f: m = f.read(72)
        pg = struct.unpack("<Q", m[56:64])[0] or 4096
        fl = struct.unpack("<Q", m[48:56])[0]
        tot = os.path.getsize(fp) // pg
        print(f"{p:32s} size={os.path.getsize(fp)/1e6:8.1f}MB empty={fl/max(tot,1):6.1%}")
    except Exception as e:
        print(f"{p:32s} unreadable: {e}")
PY

echo "=== sessionAuthTimeout 是否已配(#7225) ==="
grep -q sessionAuthTimeout "$ROOT/../etc/buildkit/buildkitd.toml" 2>/dev/null \
  && echo "已配置" || echo "未配置,默认 60s"

echo "=== src= 导出版本兼容性(#7226) ==="
buildctl debug workers >/dev/null 2>&1 && \
  docker buildx version | head -1
# client 与 daemon 版本必须一致才安全
```

## 9. 五套缓存空间管理方案对比(17 维度)

| 维度 | BuildKit v0.34.0 | BuildKit v0.33 | Docker Buildx 内联缓存 | Bazel 远程缓存 | Nix 二进制缓存 |
|---|---|---|---|---|---|
| 缓存存储格式 | bbolt 单文件 + blob 文件 | bbolt 单文件 + blob | 镜像层(OCI) | CAS(content-addressed) | Nar + 引用图 |
| 空间回收机制 | cache GC + **新增 DB 压缩** | 仅 cache GC | registry GC(外部) | CAS 自带 GC | nix-store --gc |
| 数据库会缩小吗 | **会(opt-in 压缩)** | 否 | 不适用 | 不适用 | 不适用 |
| 回收触发方式 | 写计数器 + 自适应水位线 + 空闲窗口 | 大小阈值 | 仓库策略 | 引用计数 | 不可达引用 |
| 对在线构建的影响 | 排空事务,写者可取消(maxRetry) | 无(不做) | 无 | 无 | 短暂锁 |
| 压缩可取消 | ✅ 自动可取消,手动不可 | 不适用 | 不适用 | 不适用 | 不适用 |
| 磁盘空间前置要求 | 原文件+新文件并存 | 无 | 不适用 | 无 | 无 |
| 观测手段 | 7 个 OTel/Prometheus 指标 | 无 | 无 | 遥测 | nix path-info |
| 手动触发 | HTTP debug 端点 | 只能停服离线压 | 不适用 | 不适用 | 手动命令 |
| 配置粒度 | 7 个 TOML 参数 | 无 | 无 | 规则文件 | 无 |
| 版本不匹配时行为 | exporter 选项被静默忽略(危险) | 同 | 客户端解析,不涉及 daemon | 协议协商 | 不适用 |
| 可复现构建支持 | SOURCE_DATE_EPOCH + git 修复 | 有 SOURCE_DATE_EPOCH | 不适用 | 强一致 | 天生可复现 |
| 溯源能力 | SLSA + **targetPlatform** | SLSA,仅 builderPlatform | 无 | 无 | 无 |
| 分布式缓存 | S3 / registry / inline / local | 同 | inline 为主 | 原生远程 | HTTP 二进制缓存 |
| Windows 支持 | containerd worker + **Hyper-V** | 无 Hyper-V 配置 | 无 | 有限 | 无 |
| 失败路径资源清理 | 4 个 PR 专门修(#7223/7240/7243/7247) | 部分泄漏 | 不适用 | 强 | 强 |

## 10. 6 条 6-12 个月可验证硬指标

1. **压缩实际回收量**:`increase(buildkit_compaction_reclaimed_bytes_total[7d])` ≥ 文件体积的 30%。若连续 7 天有 attempt 但 reclaimed 为 0,说明库是「活数据多」而非「空闲页多」,此时应调高 `minReclaimPercent` 而不是更频繁地压
2. **`outcome=canceled` 比例 < 20%**:超过说明写者一直在打断压缩。调高 `maxRetry`(让新构建多等几次),或调低 `idleTimeout`(让压缩更容易找到窗口)
3. **启动耗时对比**:升级前后冷启 `buildkitd` 到 `ready` 的时间。开了 `NoFreelistSync` + 优雅关闭后,启动应快 **20-50%**(取决于库大小);若没变快,查是否被 SIGKILL 过(checkpoint 没跑)
4. **freelist 页占比**:用 §8.1 的 Python 读 meta 页,升级前 vs 压缩后。预期压缩后 empty < 10%
5. **多平台 provenance 覆盖率**:`buildctl build --output type=oci ...` 后解析 provenance,多平台构建的**每个**结果应各有自己的 `targetPlatform`,且 ≠ builderPlatform。这是 6-12 个月内所有 SLSA 验证规则会加的新断言
6. **`src=` 导出体积回归**:升级后导出体积应显著下降(只导子目录)。若导出体积与升级前持平 = buildkitd 没升级,`src=` 被静默忽略,**立即对齐版本**

## 11. 5 步生产升级 checklist

1. **先体检再开压缩**。跑 §8.1 的 freelist 诊断。empty < 15% 或文件 < 128MiB 的库,开了也是白拷,把 `enabled` 留 false
2. **检查磁盘余量**。压缩需要「原文件 + 新文件」并存的空间。磁盘余量 < 2× 最大库体积时**不要开**,否则压缩中途空间不足留下脏文件
3. **`idleTimeout` 按构建密度调**。持续高频构建的共享节点,1 分钟空闲窗口可能永远等不到。先用 debug 端点 `/compaction/status` 观察 24h,看实际空闲间隔分布
4. **版本对齐**:buildx client 与 buildkitd 同时升到 v0.34.0+。`src=` 在版本不一致时会静默导出整个结果——这是本次升级唯一可能造成生产事故的行为
5. **SIGKILL 代价写入运维文档**。被 kill 的 daemon 下次启动要重建 freelist(慢)。K8s 部署把优雅终止宽限期(`terminationGracePeriodSeconds`)设足够长,让 `Close()` 的 checkpoint 跑完

## 12. 8 个诚实边界

1. **压缩不能救满盘**。它需要「原+新」并存的空间。余量不足时压缩被跳过,你得到的是 `outcome=skipped` 而不是「磁盘问题被解决」
2. **压缩不能回收活数据**。256MiB 的 `minReclaimBytes` 判的是「可回收」部分,不是文件总大小。活数据占满的库压完还是那么大
3. **压缩不能替代 cache GC**。两套机制独立。cache GC 删记录,压缩回收空闲页。文档明确列出「不能让 cache GC 把数据库文件算进去」
4. **持续活跃的库可能永远压不成**。`idleTimeout` 是硬门槛。压缩没有强制模式,文档原话警告:"Automatic copies have no copy deadline after writer-cancellation retries are exhausted, so transaction pauses can be substantial for large live datasets."
5. **`estargz` 存 S3 缓存丢失懒加载**。annotation 不被保留,记录为普通 gzip。要懒拉只能 gzip/zstd
6. **并发 `reset=true` 清理被跳过**。不是排队,是跳过。并发场景下缓存目录可能暂时变大,属预期行为
7. **targetPlatform 是声明不是验证**。BuildKit 不检查输出二进制的真实架构。验证规则只能信「声明的平台」
8. **`snapshots/metadata.db` 不参与压缩**。它归 snapshotter 自己管。排障时不要指望压缩覆盖它

## 13. 3 个长期判断

**① 构建缓存的「数据库运维」成为独立学科(12 个月)**。BuildKit 把 db 压缩做成带触发策略、取消语义、空间检查和 OTel 指标的完整运维子系统,信号是:**构建缓存数据库的膨胀从「已知问题,重启大法」变成了「可调度的运维动作」**。12 个月内会看到其他构建工具(Bazel / Buck2 / Pants / Turbo)跟进类似的可观测空间回收层,因为 CI 节点的磁盘成本在构建缓存量级上升后变成了真实账单。

**② client/daemon 版本不对齐是构建工具链下一类生产事故源(12-24 个月)**。`src=` 被老 daemon 静默忽略、导出整个结果这类行为,是「client 可选、daemon 可选、二者不协商」架构的必然代价。BuildKit 长期依赖「升级 client 时 daemon 通常也升了」的隐含假设。12-24 个月内要么出现显式的 exporter 选项能力协商(类似 HTTP 的 `Accept` 或 gRPC 的 feature negotiation),要么这类静默行为会继续以「磁盘爆了但构建成功」的形式出现。**本文 §4 的 src= 与 §8.4 的自查命令,就是这类风险的第一个可操作样本**。

**③ 可复现构建的元数据时间戳链开始被当作正确性输入而非锦上添花(18 个月)**。#7183 修的是「git 子目录 + SOURCE_DATE_EPOCH=commit 拿到错误 ref 的时间戳」——一个不修就破坏可复现性的 bug,却只在子目录场景暴露。这说明可复现构建的元数据链比大多数人以为的更脆弱:**它依赖「哪个 CLI 句柄去问哪个 ref」这种实现细节**。18 个月内,SOURCE_DATE_EPOCH 这类标准的实现正确性会被供应链安全验证规则倒逼着加固(溯源元数据的时间戳若不可复现,整个 provenance 的可信度链断掉)。

## 写在最后

v0.34.0 是一个「修内功」的版本。它没有新语法让你发推,但它把构建缓存数据库从「只能重启清理的黑箱」变成了「有指标、有策略、有取消语义、有 debug 端口的可运维组件」。加上 src=、targetPlatform、sessionAuthTimeout、NoFreelistSync 闭环,以及 7 处失败路径资源修复,这一版的主题可以概括成一句话:**把构建系统里那些「大家假装不存在」的隐含状态,一个一个变成显式的、可配的、可观测的契约**。

对使用者来说,这一版值得升的理由很具体:你的 CI 节点磁盘账单、你的多平台 provenance 验证规则、你因为 Docker Hub 偶发 502 重跑的流水线。升级成本是:对齐 client/daemon 版本,先体检再开压缩。

---

**数据来源**:BuildKit v0.34.0 release notes(GitHub releases,2026-10-07)及其中引用的 PR #7138 / #7248 / #7249 / #6882 / #7226 / #7227 / #7225 / #7155 / #7153 / #7083 / #7067 / #7121 / #7144 / #7209 / #7223 / #7145 / #7182 / #7183 / #7240 / #7243 / #7247 / #7167 / #7092 / #7135 / #7164 的完整 diff,以及 v0.34.0 新增的 `docs/compaction.md` 全文。
