---
title: "Vitess v24.0.4 深度拆解:CRL 从静默忽略变成启动期拒绝 + table ACL 不可判定表集合 fail-closed + vtctld /api/ 整块删除 + 定向 SET 只求值一次"
date: 2026-10-04
category: 技术
tags: [Vitess, Vitess v24.0.4, MySQL, 数据库中间件, 分库分表, VTGate, VTTablet, vtctld, Keyspace, Shard, TableACL, 权限, FailClosed, CRL, 证书吊销, TLS, mTLS, GHSA, 安全, LZ4, 备份, 压缩, OptionalTLS, gRPC, Set语句, sql_mode, ReservedConnection, 查询路由, 查询计划, PlanBuilder, 权限推导, 存储过程, LOADDATA, EXPLAIN, DUAL, VTAdmin, 滚动升级, 兼容性, BreakingChange, 默认值收紧, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1605733513597-a8f8341084e6?w=600&h=400&fit=crop
excerpt: "2026 年 10 月 1 日 Vitess 同时发布 v24.0.4 与 v23.0.7,两个版本只做一件事:把「配了但没生效」的安全配置全部变成「配了就启动期拒绝」。CRL 检查从 preferred/required 模式下静默忽略、服务端无证书时照常明文启动,变成 12 类配置在启动期直接 os.Exit(1),另加 8 类吊销检查收紧;table ACL 针对 DO/CALL/REPAIR/OPTIMIZE/LOAD DATA 五类「解析器丢弃表名」的语句从「无权限可推导 = 跳过检查」变成 fail-closed 拒绝,并补上 CREATE TABLE AS SELECT / EXPLAIN / SHOW WHERE / SET 子查询 / dual 子查询五类「计划器能解析但从不检查」的嵌入读;vtctld 的 /api/ HTTP 接口因是 VTAdmin v16 已替换的死代码、暴露未认证的拓扑与 vtctl 命令面被整块删除 562 行;定向 SET 从「表达式原样存储、每次预留连接重算」变成「在目标分片求值一次」,代价是多一跳往返和滚动升级期 targeted SET 子查询被反复拒绝;lz4 备份引擎从 pierrec/lz4 v2 换 v4 修 amd64 块解码损坏,帧格式不变老备份仍能恢复。本文按「不可判定就拒绝」主线拆完 6 大承重级改动,附 5 段可运行 Go/SQL 配置、5 套权限与吊销方案 17 维度对比、6 条 6-12 月硬指标、5 步生产升级 checklist、3 个诚实边界与 3 个长期判断。"
---

# Vitess v24.0.4 深度拆解:CRL 从静默忽略变成启动期拒绝 + table ACL 不可判定表集合 fail-closed + vtctld `/api/` 整块删除 + 定向 SET 只求值一次

> 2026 年 10 月 1 日,Vitess 同时发了 v24.0.4 和 v23.0.7。两个版本的 release notes 各 19.7 KB,合起来讲的只有一件事:**那些「配了但没生效」的安全配置,现在一律变成「配了就启动期拒绝」。**

## 〇、同一天的三个栈层在收紧同一件事

今天早间的五维责任日和中午的 AgentGateway v1.6.0 已经各自收紧了一轮。把三条并排看:

| 栈层 | 事件 | 改动 | 同一个设计模式 |
|---|---|---|---|
| 操作系统层 | 苹果收紧 macOS Full Disk Access | 因 AI agent 风险,要求「非常显式的用户操作」 | 默认开放 → 默认关闭 + 显式声明 |
| AI 网关层 | AgentGateway v1.6.0 | 4 条 breaking change,其中 3 条是删便利性:standalone LLM 路径收紧精确匹配、`llm.pathPrefix` 单前缀、base URL 无路径一律补斜杠 | 默认开放 → 默认关闭 + 显式声明 |
| 数据库代理层 | **本文:Vitess v24.0.4** | CRL 静默忽略 → 12 类配置启动期 `os.Exit(1)`;table ACL 不可判定 → fail-closed;`/api/` 死代码 → 整块删除 | 默认开放 → 默认关闭 + 显式声明 |

这是本周第四次出现同向收紧。Vitess 这一篇比前两篇更极端的地方在于:它不只是「默认关闭」,它把**「配置语义不自洽」本身变成了启动错误**——你的 vtgate 会因为一个 CRL 文件缺少 `X509 CRL` 块而拒绝启动,你的 vttablet 会因为一条 `DO` 语句而拒绝一个本来有 `READER` 权限的调用者。

**承重级革新判定:6 个改动里 5 个满足「改默认行为 + 解决历史遗留难题 + 引入新接口」三项以上**,是 2026 下半年「补安全债」类版本的标准样本。

---

## 一、问题的源头:为什么「配了等于没配」能存在十年

要理解 v24.0.4 为什么这么狠,得先看 Vitess 的权限模型是怎么被「沉默地」绕过的。

### 1.1 三层架构与权限落点

Vitess 的经典三组件:

```
应用 → vtgate (MySQL 协议入口, 查询路由)
         ↓ gRPC (VSCursor)
      vttablet (每台 MySQL 一个代理, 查询计划 + 权限检查 + 事务)
         ↓ 原生 MySQL 协议
      mysqld
```

权限检查发生在 **vttablet**,不是 vtgate。vtgate 负责把 SQL 解析成逻辑计划、路由到正确的 shard;vttablet 拿到路由后的语句,用 `planbuilder` 生成执行计划,再由 `QueryExecutor.checkPermissions()` 逐表校验调用者的 ACL。

这里有一个**根本性的信任假设**:vttablet 相信自己能从语句里推出它碰了哪些表。推不出来 → 无法检查。而 MySQL 的语法里,恰恰有一堆「解析器主动丢弃表信息」的语句。

### 1.2 `BuildPermissions` 的 switch:一个必须穷举所有语句类型的地方

核心函数在 `go/vt/vttablet/tabletserver/planbuilder/permission.go`。改动前它的签名是:

```go
// BuildPermissions builds the list of required permissions for all the
// tables referenced in a query.
func BuildPermissions(stmt sqlparser.Statement) []Permission {
	var permissions []Permission
	switch node := stmt.(type) {
	case *sqlparser.Select:
		// ... 遍历 FROM / 子查询 / CTE, 收集 READER
	case *sqlparser.Insert, *sqlparser.Update, *sqlparser.Delete:
		// ... 收集 WRITER
	case *sqlparser.Analyze:
		permissions = buildTableNamePermissions(node.Table, tableacl.WRITER, nil, permissions)
	case *sqlparser.OtherAdmin, *sqlparser.CallProc, *sqlparser.Begin, *sqlparser.Commit, *sqlparser.Rollback,
		*sqlparser.Load, *sqlparser.Savepoint, *sqlparser.Release, *sqlparser.SRollback, *sqlparser.Set, *sqlparser.Show, sqlparser.Explain,
		*sqlparser.UnlockTables:
		// no op
	default:
		panic(fmt.Errorf("BUG: unexpected statement type: %T", node))
	}
	return permissions
}
```

注意 `default` 分支是 `panic`。这不是疏忽,是**设计契约**:这个 switch 必须覆盖 sqlparser 能产出的每一种 Statement,加新语句类型时必须来这里登记。问题在 `no op` 那一行——它把两类完全不同的语句混在了一起:

- **真的什么都不碰**:`Begin` / `Commit` / `Rollback` / `Savepoint` / `Release` / `SRollback` / `UnlockTables`。这些是事务控制,确实没有表。
- **解析器丢弃了表信息**:`OtherAdmin`(涵盖 `DO` / `REPAIR` / `OPTIMIZE`)、`CallProc`(`CALL 存储过程`)、`Load`(`LOAD DATA`)。这些**实际上会讀写表**,只是 sqlparser 把它们解析成不携带表名的节点 —— `DO` 只保留表达式列表,`CALL` 只保留过程名,过程体里的 SQL 在 Vitess 看来是完全不透明的文本。

结果是:`permissions` 返回空切片 → `checkPermissions` 的 for 循环没东西可迭代 → 检查被跳过 → **任何通过认证的调用者都能用这五类语句讀写他没有权限的表**,而且用的是 vttablet 自己连 MySQL 的特权账号。

这就是 GHSA-w6mx-2f8x-pqf4 的核心。`DO (SELECT * FROM secret_table)`、`CALL read_proc()`、服务器端 `LOAD DATA INFILE` 直接写表,全部绕过 table ACL。

### 1.3 同样沉默的 TLS 侧

table ACL 是「推不出表名 → 跳过」,TLS 侧是「配不全 → 忽略」。典型路径:

- 运维给 vtgate 配了 `--mysql-server-ssl-crl=/etc/ssl/revoked.pem`(吊销列表),但**没配** `--mysql-server-ssl-cert/--mysql-server-ssl-key`。
- 旧代码:`if mysqlSslCert != "" && mysqlSslKey != ""` 为假 → 服务器根本不启用 TLS,但 CRL 标志无人检查 → **MySQL 端口跑在明文上,而运维以为他配了吊销保护**。
- 更隐蔽的一层:即使 TLS 启用了,在 `preferred` / `required` 这两个 SSL 模式下,客户端配了 CRL 却不验证服务器证书链 —— CRL 检查**挂在空中的链**上,啥也没查。

`preferred` 模式的语义是「能 TLS 就 TLS,不能就算」,`required` 是「必须 TLS 但不校验链」。这两个模式下 CRL 被静默忽略,是 Go 标准库 `crypto/x509` 的默认行为遇到了 Vitess 没有显式覆盖的空白。

**关键洞察 1:v24.0.4 修的不是两个漏洞,是同一个反模式 ——「配置已声明、语义不完整、系统选择降级运行而不是报错」。** table ACL 和 CRL 相隔几千行代码,但犯的是同一个错:把「无法处理」当成「无需处理」。

---

## 二、6 大承重级改动逐个拆

### 2.1 CRL fail-closed:12 类配置启动期拒绝 + 8 类吊销检查收紧

**GHSA-fxqj-c35w-x6rq**。这是改动量最大的一块,分两个层面。

#### 启动期拒绝(12 类)

`ServerTLSEnabled` 是新加的守门函数,只有 14 行,但它是整个改动的枢纽:

```go
// ServerTLSEnabled reports whether a server is configured for TLS,
// that is, whether both its certificate and its key are set. A CRL
// set without them is refused: it could not apply to a server that
// does not do TLS, and would otherwise be silently ignored, leaving
// the server in plaintext while the operator configured revocation.
func ServerTLSEnabled(cert, key, crl string) (bool, error) {
	if cert != "" && key != "" {
		return true, nil
	}
	if crl != "" {
		return false, vterrors.Errorf(vtrpc.Code_INVALID_ARGUMENT,
			"a CRL is configured without a certificate and a key: "+
				"the server is not configured for TLS, so the CRL could not apply")
	}
	return false, nil
}
```

在 `grpc_server.go` 和 `plugin_mysql_server.go` 里,它替换掉了原来的 `if gRPCCert != "" && gRPCKey != ""`,并且错误路径直接 `os.Exit(1)`:

```go
tlsEnabled, err := vttls.ServerTLSEnabled(gRPCCert, gRPCKey, gRPCCRL)
if err != nil {
	log.Error("Failed to configure gRPC TLS", slog.Any("error", err))
	os.Exit(1)
}
```

被拒绝的 12 类配置(全部来自 release notes 逐条列举):

| # | 配置 | 为什么拒绝 | 修法 |
|---|---|---|---|
| 1 | 服务端 CRL 无匹配 CA | 无 CA → 不请求客户端证书 → CRL 无对象 | 配 CA,或删 CRL |
| 2 | 服务端 CRL 无证书+私钥 | 服务器根本没 TLS,gRPC 曾明文启动 | 配 cert+key,或删 CRL |
| 3 | CRL 文件里没有 CRL 块 | 指了个空 PEM | 指向含至少一个 `X509 CRL` 块的文件 |
| 4 | CRL 签名无法被 CA 证书验证 | 签名对不上 / CA 缺 `cRLSign` key usage | 重签 CRL,或重签带 `cRLSign` 的 CA |
| 5 | CRL 的 AKI 指向另一个 key | re-key 过的 CA 前任 CRL | 用 CA 的 SKI 作 AKI 重签 |
| 6 | CRL 用了不支持的签名算法 | — | 换算法 |
| 7 | CRL issuer 名与 CA subject 字节级不同 | 跨工具生成时编码差异 | 用 CA subject 作 issuer 重签 |
| 8 | delta CRL / indirect CRL | 只支持完整 CRL | 提供完整 CRL |
| 9 | CRL 带非 IDP 的 critical extension | 列表级或条目级都算 | 重签 |
| 10 | CRL 的 `thisUpdate` 在未来 5 分钟后 | 提前暂存的新 CRL 不能覆盖当前 CRL | 给当前 CRL,查时钟 |
| 11 | 上一条的同源变体:同一 issuer 多个完整 CRL | 只应用最新的,旧的不再合并 | 保持只放最新 |
| 12 | CA 用同名独立证书签 CRL | 不支持 | 用 CA 自己签 |

**关键洞察 2:第 10 条是这份列表里最有意思的一条。** 大多数 CRL 实现只校验「没过期」,Vitess 额外校验「不能来自未来」。原因是运营场景:为了零停机换 CRL,运维会提前把新 CRL 放到路径上,但 `thisUpdate` 在未来意味着它还没生效,如果直接应用就会让本该被吊销的证书「复活」5 分钟。Vitess 选了拒绝,而不是「宽容地」接受。

#### 运行期拒绝(3 类连接)

启动通过后,还有三种连接以前能连上、现在被拒:

1. `required` 模式 + 有 CRL + 无 CA + 服务器证书是私有 CA 签的 → 现在构建链并拒绝。
2. 有 CRL + 配了根 CA + 服务器没出示中间 CA → 链建不起来 → 拒绝。
3. 有 CRL + 服务器证书过期或不含 serverAuth EKU → 拒绝(这两个原本在无 CRL 时被 `required` 模式接受)。

以及一个行为反转:gRPC 客户端配了 `--tablet-grpc-crl` 但既无客户端证书也无 CA,**以前用明文连且 CRL 被忽略,现在用 TLS 连并对系统根证书校验服务器**。这是「降级运行」被彻底关闭的信号。

### 2.2 Table ACL fail-closed:不可判定表集合

对应 **GHSA-w6mx-2f8x-pqf4** 上半部分,PR #21053。

#### API 改动:故意 breaking

```go
// BuildPermissions builds the list of required permissions for all the
// tables referenced in a query. tablesUndetermined reports a statement whose
// tables the parser discards, so that no permission could be derived for it;
// the executor fails closed on such a statement under strict table ACL.
func BuildPermissions(stmt sqlparser.Statement) (permissions []Permission, tablesUndetermined bool) {
	switch node := stmt.(type) {
	// ... Select/Insert/... 不变
	case *sqlparser.OtherAdmin, *sqlparser.CallProc, *sqlparser.Load:
		// The parser discards the tables these statements touch: DO's
		// expressions and the tables REPAIR and OPTIMIZE name (OtherAdmin), a
		// procedure body (CALL), and LOAD DATA's target table (a write, with
		// vt_app holding the FILE privilege by default). No permission can be
		// derived, so the statement is flagged and the executor denies it
		// under strict table ACL rather than skip the check. A new statement
		// type the parser leaves opaque belongs here, not in the arm below.
		tablesUndetermined = true
	case *sqlparser.Begin, *sqlparser.Commit, *sqlparser.Rollback,
		*sqlparser.Savepoint, *sqlparser.Release, *sqlparser.SRollback, *sqlparser.Set, *sqlparser.Show, sqlparser.Explain,
		*sqlparser.UnlockTables:
		// no op
	default:
		panic(fmt.Errorf("BUG: unexpected statement type: %T", node))
	}
	return permissions, tablesUndetermined
}
```

注意注释那句 **"A new statement type the parser leaves opaque belongs here, not in the arm below"**。这是把契约写进了代码:以后 sqlparser 新增不透明语句类型,默认就是 fail-closed,不是 no-op。

返回值从 1 个变 2 个,**且 release notes 明确说这是故意的**:

> The exported `planbuilder.BuildPermissions` now returns a second result, `tablesUndetermined bool`, alongside the permissions. **This breaks any out-of-tree caller on purpose**: a one-result compatibility wrapper would keep returning "no permissions" for exactly these statements with no way to learn the table set was undetermined, so a caller left on it would silently keep the behavior this fix closes.

这是我今年读过的最清晰的 breaking-change 理由:**兼容包装会让调用者无法区分「没有权限」和「不知道有哪些表」,而这两者在语义上完全不同**。

#### 执行器改动

`query_executor.go` 的 `checkPermissions()`:

```go
// Fail closed for a statement whose table set the planner could not
// determine (DO, CALL, REPAIR, OPTIMIZE, LOAD DATA). It is forwarded to
// MySQL as opaque text and can still read or modify tables, but no
// permission could be derived for it, so the per-table loop below has
// nothing to iterate and would let any authenticated caller run it under
// strict table ACL.
if qre.plan.TablesUndetermined {
	return qre.checkUndeterminedTableAccess(callerID)
}
```

新函数镜像了普通检查的 dry-run 和统计行为,但**无条件拒绝**:

```go
func (qre *QueryExecutor) checkUndeterminedTableAccess(callerID *querypb.VTGateCallerID) error {
	var aclState acl.ACLState
	defer func() {
		// There is no table to name; label the denial so operators can tell
		// it apart from a per-table one in the TableACL* counters. The label
		// carries hyphens so that no unquoted table name can share the series.
		statsKey := qre.generateACLStatsKey("undetermined-table-set", &tableacl.ACLResult{}, callerID)
		qre.recordACLStats(statsKey, aclState)
	}()

	if qre.tsv.qe.enableTableACLDryRun {
		aclState = acl.ACLPseudoDenied
		return nil
	}
	if !qre.tsv.qe.strictTableACL {
		return nil
	}
	aclState = acl.ACLDenied
	errStr := fmt.Sprintf("%s command denied to user '%s'%s for a table set that cannot be determined (ACL check error)",
		qre.plan.PlanID.String(), callerID.Username, aclGroupsSuffix(callerID))
	qre.tsv.qe.accessCheckerLogger.Infof("%s", errStr)
	return vterrors.Errorf(vtrpcpb.Code_PERMISSION_DENIED, "%s", errStr)
}
```

三个细节值得抄:

1. **标签 `undetermined-table-set` 带连字符**。注释说得很直白:MySQL 表名不能含连字符,所以这个 label 永远不会和任何真实表名的监控序列撞车。这是把「不可判定」这件事**可观测化**的关键一步——升级后运维会在 `TableACLDenied` 里看到一个全新的序列,而不是去猜哪个表被拒了。
2. **dry-run 优先于 strict**。dry-run 模式下拒绝只记录不生效,这让运维能先跑一遍量出影响面再开 strict。
3. **strict 关闭时直接返回 nil**。非 strict 模式行为完全不变 —— 这不是默认值翻转,是给已有的安全开关补上漏洞。

#### 影响面

`--queryserver-config-strict-table-acl` 打开时,`DO` / `CALL` / `REPAIR` / `OPTIMIZE` / `LOAD DATA` 对**所有非豁免 ACL 的调用者**被拒绝,**包括那些本来有足够表权限的调用者** —— 因为 vttablet 无法确认这些语句碰了哪些表。需要它们的运维必须用豁免 ACL(`--queryserver-config-acl-exempt-acl`)的调用者身份执行。

### 2.3 Table ACL 补嵌入选:五条以前从不检查的读路径

PR #21139,GHSA 的下半部分。上一条修的是「解析器丢弃表名」,这一条修的是「计划器能解析但从不检查」:

| 语句 | 旧行为 | 新行为 |
|---|---|---|
| `CREATE TABLE t AS SELECT ...` | 只查 `ADMIN` on `t` | 额外要求 `READER` on 所有被 SELECT 的表(含 CTE / JOIN / UNION) |
| `CREATE VIEW / ALTER VIEW AS SELECT` | 不查 | 定义时要求 `READER` on 源表 |
| `EXPLAIN` / `DESCRIBE <stmt>` | 不查 | 要求被解释语句的完整权限,DML 的目标表要 `WRITER` |
| `SHOW ... WHERE <expr>` | 不查 | 要求过滤子查询读到的表 `READER` |
| `SET ... = (subquery)` | 不查 | 要求 `READER` on 子查询的表 |
| `SELECT ... FROM dual` | 整条免检 | 只有纯 dual 查询免检,子查询照查 |

**为什么 `EXPLAIN` 要查权限**这一条写得非常清楚:

> MySQL reads single-row tables and evaluates uncorrelated subqueries while it optimizes, and the plan shows the outcome (`Impossible WHERE`), so an `EXPLAIN` answers a yes/no question about the data.

`EXPLAIN` 不是只读的元信息查询 —— 它在优化器里真的会读数据。一个 `EXPLAIN SELECT ... WHERE secret = guess` 能泄露「有没有这行」。同理 `EXPLAIN ANALYZE` 直接执行语句。

**`CREATE VIEW` 的检查时机**是个有意思的取舍:view 定义时它什么都不读,但被查询时它以 vttablet 的 MySQL 用户身份读源表,而那时 ACL 只能看到 view 的名字。所以 Vitess 选了**在定义时检查源表权限**——跟 MySQL 自己要求 `SELECT` on source 的语义对齐。

还有一个边界:vttablet 解析器无法完整解析的 `CREATE TABLE` 会以客户端原文转发给 MySQL,计划器只知道 `CREATE TABLE <name>` 前缀。像 `CREATE TABLE t (SELECT ...)` / `CREATE TABLE t AS TABLE src` / 带 `EXCEPT`/`INTERSECT` 源的语句,计划器无法把它们和「Vitess 缺少语法的有效语句」区分开。处理方式:**一律按不可判定拒绝**,只让豁免 ACL 执行。

### 2.4 vtctld `/api/` 整块删除:562 行死代码 + 未认证攻击面

PR #21171。这是改动最「物理」的一条:`go/vt/vtctld/api.go` 整文件删除(562 行),连带 `explorer.go` / `tablet_data.go` / `action_repository.go` 大幅瘦身。

被删的 13 个端点:`cells` / `keyspaces` / `keyspace` / `shards` / `srv_keyspace` / `tablets` / `tablet_statuses` / `tablet_health` / `topology_info` / `topodata` / `vtctl` / `schema/apply` / `features`,以及它们背后的 keyspace / shard / tablet action 端点。

删除理由有四层:

1. **它是死代码**。为 vtctld 的 web UI 构建,而 VTAdmin 在 **v16** 就替换了那个 UI。此后没有任何东西 serve 或 call 它,VTAdmin 走 gRPC 调 `VtctldServer`。
2. **它是未认证的 HTTP 面**。直接暴露拓扑数据、tablet 健康、**任意 vtctl 命令**、schema 变更、keyspace 和 shard 校验。
3. **`--security-policy` 覆盖率不均**。一个端点一个样,没法整体论证安全性。
4. **删比补强安全**。release notes 原话:

> Removing it removes that surface, rather than patching it endpoint by endpoint.

这是整篇 release notes 里最「激进」的决定,也是最对的一个。给 13 个端点逐个加认证,要写 13 套测试、维护 13 个策略、面对 13 次未来的回归;删掉是 0 维护成本。四个相关 flag(`--cell` / `--proxy-tablets` / `--action-timeout` / `--tablet-health-keep-alive`)变成 deprecated no-op —— 进程仍能启动,只打一条警告 —— 将在 v26 移除。

**关键洞察 3:这是「攻击面收敛」的正确姿势 —— 不是给老接口加锁,是删掉没人用的门。** 大多数安全补丁的惯性是「加保护」,但一个没有调用者的接口,加保护的成本收益比是负的:保护可能写错、可能被绕过、一定需要维护。删除是唯一零未来成本的修复。

### 2.5 定向 SET 求值一次:修好一个副作用,代价是多一跳

PR #21139 的另一半,改的是 `go/vt/vtgate/engine/set.go`。

**旧逻辑**:一个 target 到 shard 的 session(`use ks:-80`)执行 `SET @@var = (expr)` 时,vtgate 把**表达式原文**存进 session,然后在**每次预留连接**上重新求值。三个后果:

- `SELECT @@var` 拿到的是存储的文本,求值失败 → 报错。
- `SET` 失败了,值还留在 session 里。
- 最严重的是:**子查询表达式在每次预留连接上重算,而预留连接的设置不做 table ACL 检查** → 绕过 §2.2/§2.3 的新检查。

**新逻辑**:`evaluateOnShard` 在目标分片上求值一次,session 存结果。对 `sql_mode` 仍走原来的 judgment query;其他变量走 `select <expr> from dual`。

```go
wasReserved := vcursor.Session().InReservedConn()
vcursor.Session().NeedsReservedConn()
value, err := svs.evaluateOnShard(ctx, vcursor, env, rss[0])
if err != nil {
	if !wasReserved && len(vcursor.Session().ShardSession()) == 0 {
		vcursor.Session().ResetReservedConn()
	}
	return err
}
var buf strings.Builder
value.EncodeSQL(&buf)
storedValue := buf.String()
```

注意求值**在预留连接之后**执行 —— 注释解释了为什么:表达式可能依赖连接状态,而且 tablet 拒绝在非预留连接里执行 `get_lock()` 这类锁函数。失败时还要小心处理「session 是否已经被标记为 reserved」的状态回退。

**代价写在 release notes 里,很诚实**:

> Each targeted `SET` costs one additional round trip to the shard.

以及一个**滚动升级期的兼容性陷阱**:升级顺序通常是「vttablet 先,vtgate 后」。在新 vttablet + 旧 vtgate 的窗口里,旧 vtgate 仍存表达式原文,于是每次后续查询都会被新 vttablet 的 strict table ACL 拒绝,直到客户端重连。官方给了两个解法:**升级期间别在定向 session 用子查询 SET**,或者**先升 vtgate**。

### 2.6 lz4 备份引擎换库:一个真正的兼容性陷阱

PR #20778。`go.mod` 里 `github.com/pierrec/lz4 v2.6.1+incompatible` → `github.com/pierrec/lz4/v4 v4.1.27`。

**为什么换**:v2 库在 amd64 上的块解码是坏的。

**兼容性保证**:帧格式没变 → 旧版本写的备份仍能恢复,这个版本写的备份旧版本也能恢复。这是最重要的承诺 —— 备份格式的兼容性是**恢复路径的生命线**,换压缩库最怕就是升级后老备份读不出来。

**但 `--compression-level` 的语义变了**,这是本条真正的陷阱:

| 值 | 旧语义 | 新语义 |
|---|---|---|
| `0` | hash-chain 深度 0 | fast compressor |
| `1`(默认) | hash-chain 深度 1 | fast compressor |
| `2`-`9` | 直接当 hash-chain 搜索深度 | 命名级别 `Level2`-`Level9` |
| 负数 / `>9` | 无限搜索 | `Level9` |

**关键洞察 4:这是全篇唯一一个「改默认值但不是为了安全」的改动,也是最容易被漏掉的一个。** 一个 `--compression-level=3` 的备份策略,升级后压缩率会变(大概率变好,但 CPU 也变高)。它不报错、不告警、不破坏备份 —— 只是静默地改变了你的备份性能特征。其他压缩引擎不受影响。

---

## 三、5 段可运行代码

### 3.1 复现「不可判定表集合」的拒绝(Strict ACL)

```bash
# 1. 启动 vttablet 时打开 strict table ACL 与 dry-run,先量影响面
vttablet \
  --queryserver-config-strict-table-acl \
  --queryserver-config-enable-table-acl-dry-run \
  --table-acl-config /etc/vitess/acl.json \
  --queryserver-config-acl-exempt-acl vt_dba

# /etc/vitess/acl.json:testuser 只有 orders 表的 READER
# {"rules": {"orders": {"read":  ["testuser"], "write": ["testuser"]}}}
```

```sql
-- 通过 vtgate 以 testuser 连接,走一个 vttablet 能解析的普通查询:正常
SELECT * FROM orders WHERE id = 1;

-- 走「解析器丢弃表名」的语句:dry-run 下只记录,不拦截
-- 打开 strict(关掉 dry-run)后:PERMISSION_DENIED
DO (SELECT secret_col FROM restricted_table);

-- 存储过程:过程体对 Vitess 完全不透明
CALL read_restricted_proc();

-- 服务器端文件导入:vt_app 默认持有 FILE 权限
LOAD DATA INFILE '/var/lib/mysql-files/dump.csv' INTO TABLE restricted_table;

-- 走「计划器能解析但从不检查」的嵌入读:
CREATE TABLE scratch AS SELECT * FROM restricted_table;
EXPLAIN SELECT * FROM restricted_table WHERE secret = 'guess';
SHOW COLUMNS FROM orders WHERE (SELECT COUNT(*) FROM restricted_table) > 0;
SET @x = (SELECT secret_col FROM restricted_table);
SELECT (SELECT secret_col FROM restricted_table) FROM dual;
```

### 3.2 监控新出现的 `undetermined-table-set` 序列

```go
// 升级后,dry-run 下每条带 caller id 的非豁免 DO/CALL/REPAIR/OPTIMIZE/LOAD DATA
// 都会让 TableACLPseudoDenied 多一个新序列,无论 strict 是否打开。
// 用它量出开 strict 之前的影响面:
package main

import (
	"fmt"
	"time"

	"vitess.io/vitess/go/stats"
)

func main() {
	// 单标签计数器,标签 = transport / table 名 / 这里是 "undetermined-table-set"
	c := stats.NewCountersWithSingleLabel("TableACLPseudoDenied",
		"Statements the table ACL would deny, by table or undetermined-table-set",
		"TableName", "undetermined-table-set")
	for range time.Tick(time.Minute) {
		fmt.Println("pseudo-denied undetermined:", c.Get("undetermined-table-set"))
	}
}
```

### 3.3 触发并诊断 12 类启动期 CRL 拒绝

```bash
# A. 最常见的一类:配了 CRL 没配 cert/key —— 启动直接退出
vtgate \
  --mysql-server-ssl-crl /etc/ssl/revoked.crl \
  --mysql-server-ssl-ca  /etc/ssl/ca.pem
# ! 不是 "cert/key 未配置所以跳过 TLS",而是:
# FATAL: a CRL is configured without a certificate and a key:
#        the server is not configured for TLS, so the CRL could not apply

# B. 正确姿势:CRL 必须与 cert/key/CA 成套出现
vtgate \
  --mysql-server-ssl-cert /etc/ssl/vtgate.crt \
  --mysql-server-ssl-key  /etc/ssl/vtgate.key \
  --mysql-server-ssl-ca   /etc/ssl/ca.pem \
  --mysql-server-ssl-crl  /etc/ssl/revoked.crl

# C. 诊断「CRL 文件里没有 CRL 块」这一类
# 一个只含 CERTIFICATE 块的 PEM 会被拒;至少要有一个 X509 CRL 块
grep -c 'X509 CRL' /etc/ssl/revoked.crl   # 期望 >= 1

# D. 诊断「thisUpdate 在未来」:提前暂存的新 CRL 会被拒
# 检查 CRL 的 thisUpdate 与本机时钟(集群内时钟漂移会直接变成启动失败)
openssl crl -in /etc/ssl/revoked.crl -noout -text | grep -E 'Last Update|Next Update'
date -u
```

### 3.4 Optional TLS 连接计数:决定什么时候能关掉这个口子

```go
// PR #21162:可选 TLS 的明文连接第一次可数。
// grpcoptionaltls 包在 handshake 时用 sync.Once 保证 Close 只减一次 gauge。
package main

import (
	"fmt"

	"vitess.io/vitess/go/vt/grpcoptionaltls"
)

func main() {
	// 迁移客户端到 TLS 期间,这是唯一的判断依据
	open := grpcoptionaltls.OpenConnections.Get("plaintext")
	total := grpcoptionaltls.ConnectionCounts.Get("plaintext")
	fmt.Printf("plaintext open=%d ever-connected=%d\n", open, total)

	// 决策规则(release notes 原话的工程化):
	//   open==0        -> 此刻没有明文客户端连着(gRPC 连接长生命,老连接不会重新握手)
	//   total 停止增长 -> 最近没有新的明文连接
	//   两者都不能证明「没有偶尔才连的客户端」—— 它们支持决策,不构成证明
	if open == 0 {
		fmt.Println("可以考虑移除 --grpc-enable-optional-tls,但先观察一个业务周期")
	}
}
```

### 3.5 vtctld `/api/` 删除的迁移与探测

```bash
# 升级前:先确认确实没有调用者。/api/ 已删,所有请求返回 404
for ep in cells keyspaces shards tablets tablet_health topodata vtctl schema/apply features; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://vtctld:15000/api/${ep}")
  echo "/api/${ep} -> ${code}"   # 期望全部 404
done

# 迁移:脚本改用 vtctldclient(背后是 VtctldServer gRPC 服务)
vtctldclient --server vtctld:15999 GetKeyspaces
vtctldclient --server vtctld:15999 GetTablets --keyspace commerce

# 这些 flag 现在是 no-op,只打 deprecation 警告,进程仍启动;v26 移除
# --cell / --proxy-tablets / --action-timeout / --tablet-health-keep-alive
# 从 vtctld / vtcombo 的启动参数里删掉它们

# VTAdmin 用户:走 gRPC,本次删除对你无影响
# Go 包构建者:vtctld.InitVtctld / ActionRepository / ActionResult / TabletWithURL 已删除
```

---

## 四、5 套方案 17 维度对比

### 4.1 不可判定语句的 5 种处理策略

| 维度 | Vitess v24.0.4 (fail-closed) | Vitess 旧版 (skip) | PostgreSQL RLS | MySQL 企业防火墙 | ProxySQL |
|---|---|---|---|---|---|
| 不可判定语句处理 | 拒绝,豁免 ACL 例外 | 放行 | 依赖策略函数显式判断 | 规则不匹配时按默认动作 | 路由层不检查权限 |
| 检查层级 | vttablet(计划层) | vttablet(计划层) | 存储引擎内部 | MySQL 服务器插件 | 代理层 |
| 存储过程体可见性 | 不可见(不解析) | 不可见 | 可见(PL/pgSQL 可审计) | 可见 | 不可见 |
| dry-run 支持 | 有,独立开关 | 无 | 无 | 有(告警模式) | 无 |
| 拒绝标签可观测 | `undetermined-table-set` 专属序列 | 无 | pg_stat_statements | 审计日志 | 无 |
| 权限模型 | 表级 READER/WRITER/ADMIN | 同左 | 行级 + 表级 | 语句级规则 | 无(只路由) |
| 绕过风险 | 剩存储函数表达式内联调用 | DO/CALL/LOAD DATA 全绕 | 需策略函数自己覆盖 | 规则覆盖面 | 不适用 |
| 升级路径 | strict 开关已存在,补漏洞 | — | — | — | — |

### 4.2 证书吊销的 5 种实现

| 维度 | Vitess v24.0.4 CRL | Vitess 旧 CRL | OCSP stapling | SPIFFE/SVID 短期证书 | mTLS + 证书钉扎 |
|---|---|---|---|---|---|
| 吊销生效延迟 | 下次握手即生效 | 不生效(被忽略) | 立即 | 证书 TTL 到期 | 依赖钉扎轮换 |
| 配置不自洽时 | **启动期拒绝** | 静默降级明文 | 依赖 responder | 自动轮换 | 依赖部署 |
| `thisUpdate` 在未来 | 拒绝(5 分钟容差) | 不检查 | OCSP 时间窗 | 不适用 | 不检查 |
| delta/indirect CRL | 明确拒绝 | 不适用 | 不适用 | 不适用 | 不适用 |
| 运维心智负担 | 高(12 类拒绝条件) | 低(但等于没配) | 中 | 低(自动化) | 中 |
| 适合场景 | 已有 PKI 的私有云 | 不推荐 | 公网 CA | 云原生服务网格 | 固定拓扑 |

### 4.3 备份压缩引擎对比

| 维度 | lz4 v4 (新) | lz4 v2 (旧) | zstd | pargzip | 无压缩 |
|---|---|---|---|---|---|
| amd64 块解码 | 正确 | **损坏** | 正确 | 正确 | 不适用 |
| 帧格式兼容性 | 与 v2 互通 | — | 独立 | 独立 | — |
| `--compression-level` 语义 | 命名级别 0-9 | 原始搜索深度 | 1-22 | 并行度 | 不适用 |
| 默认值(1)含义 | fast compressor | 深度 1 | — | — | — |
| 压缩率 | 中 | 低 | 高 | 低 | 无 |
| 备份恢复兼容 | 新旧互通 | — | — | — | — |

### 4.4 定向 SET 求值策略

| 维度 | v24.0.4 (求值一次) | 旧版 (每次重算) | untargeted session | 直连 MySQL |
|---|---|---|---|---|
| 表达式存储 | 求值后的常量 | 表达式原文 | 求值后的常量 | 不适用 |
| 每次预留连接开销 | 0 | 每次重算 | 0 | 不适用 |
| 额外往返 | 1 次(SET 时) | 0 | 0 | 0 |
| 子查询表 ACL | 在分片上检查 | **绕过** | 检查 | 不适用 |
| `SELECT @@var` 结果 | 正确值 | 求值失败 | 正确值 | 正确值 |
| SET 失败后 session | 干净 | **残留脏值** | 干净 | 干净 |
| 滚动升级风险 | 旧 vtgate + 新 vttablet 被反复拒 | 无 | 无 | 无 |

### 4.5 死接口处理的 5 种姿势

| 维度 | Vitess(整块删除) | 保留 + 加认证 | 保留 + 网络隔离 | 标记 deprecated 仅告警 | 保留 + 审计日志 |
|---|---|---|---|---|---|
| 未来维护成本 | 0 | 高(13 端点 × N 年) | 中 | 低 | 中 |
| 攻击面 | 消失 | 缩小但仍在 | 隔离但仍在 | 完全保留 | 完全保留 |
| 需要先确认无调用者 | 是(否则是 breaking) | 否 | 否 | 否 | 否 |
| 策略可论证性 | 高(代码不存在) | 低(逐端点覆盖不均) | 中 | 低 | 低 |
| 回滚难度 | 高(需 revert 版本) | 低 | 低 | 低 | 低 |

---

## 五、6 条 6-12 个月可验证硬指标

1. **启动失败率**:升级到 v24.0.4 后 24 小时内,`vtgate`/`vttablet` 因 CRL 配置不自洽而 `os.Exit(1)` 的实例数。预期:首次升级的非零集群里,至少有一台会撞上第 2 类(CRL 无 cert/key)或第 3 类(CRL 文件无 CRL 块)。**这条指标必须升级前先跑 §3.3 的 A 组合预检**,否则会在升级窗口里变成生产事故。
2. **`TableACLPseudoDenied{TableName="undetermined-table-set"}` 增量**:dry-run 开 7 天,统计非豁免调用者的 `DO`/`CALL`/`REPAIR`/`OPTIMIZE`/`LOAD DATA` 条数。这是开 strict 之前唯一的影响面量化手段,数字如果大于预期,说明有业务在用存储过程做数据访问,需要先迁到显式 SQL。
3. **`TableACLDenied` 增量**:开 strict 后按 TableName 拆分的拒绝数。预期 `undetermined-table-set` 序列从 0 变为非零;若真实表名序列也暴涨,说明 §2.3 的嵌入读检查命中了既有业务(EXPLAIN / CREATE TABLE AS SELECT 是最可能的)。
4. **`GrpcOptionalTlsOpenConnections{Transport="plaintext"}`**:升级后读一次基线,然后每 24 小时读一次。预期单调下降。**降到 0 不代表可以立刻关 flag** —— release notes 明确说「支持决策,不构成证明」,因为偶尔才连的客户端看不到。至少观察一个完整的业务周期(月结、季结)再动手。
5. **备份 CPU / 压缩比 / 时长**:lz4 引擎升级前后各跑 3 次同库全量备份,对比 `--compression-level` 不变时的 wall time、CPU 秒、产物字节数。预期:默认值 1 行为基本不变(新旧都是 fast 路径),但显式配了 2-9 的策略会变 —— 这条必须在升级 release notes 里同步给备份团队。
6. **`/api/` 404 计数**:升级前一周统计 vtctld HTTP 端口上 `/api/` 路径的请求量。非零就必须先迁调用者(改用 `vtctldclient`),否则升级即 breaking。**这条应该在升级前 4 周就跑**,因为它决定本版本是否可以直接上。

---

## 六、6 条 6-12 个月可观察未来信号

1. **v26 移除 4 个 deprecated flag**:`--cell` / `--proxy-tablets` / `--action-timeout` / `--tablet-health-keep-alive` 已是 no-op(只打告警),issue #21170 跟踪 v26 的移除。任何还在传这些 flag 的部署脚本会硬失败 —— 现在就清掉。
2. **`BuildPermissions` 双返回值的外部依赖迁移**:任何 fork Vitess planbuilder 或调用 `BuildPermissions` 的外部项目必须改签名。PR 注释明确说「故意 breaking」,所以不要等兼容包装。
3. **存储函数漏洞 #21134 的后续**:表达式内联调用的存储函数(`SELECT f()`)仍以 vttablet 特权执行函数体,因为 Vitess 不解析 `CREATE FUNCTION`。这是 §2.2 留下的明确边界,issue 已经开着,跟踪它会不会在 v25变成第二个 fail-closed 改动。
4. **部分解析的 `CREATE TABLE` #21138**:`CREATE TABLE t (SELECT ...)` / `AS TABLE src` / `EXCEPT`/`INTERSECT` 源目前一律按不可判定拒绝。issue 跟踪解析这些语法的工作 —— 补上之后这部分语句就能走正常权限检查,不必走豁免 ACL。
5. **CRL 语义化成为常态**:v24.0.4 的 12 类启动期拒绝本质上是把「CRL 的 X.509 语义」完整实现了。Go 标准库的 `crypto/x509` 不做这些检查(它只检查过期和签名),Vitess 是在应用层补上了 PKI 的完整语义。未来 6-12 个月,在 Go 生态里做私有 PKI 的项目会越来越多地复制这套「拒绝优先于降级」的策略。
6. **「删死代码改安全债」模式扩散**:vtctld `/api/` 的删除理由(死代码 + 未认证 + 策略覆盖不均)在大量中间件项目里成立。这类「删比补便宜」的决策会成为安全修复的主流姿势之一,取代「给老接口加锁」。

---

## 七、总结与最佳实践

### ✅ 该用

- **已经在用 `--queryserver-config-strict-table-acl` 的集群**:直接升级,这是必上安全修复。先开 dry-run 量 `undetermined-table-set` 序列 7 天,再决定是否调整业务。
- **有私有 PKI 且配了 CRL 的集群**:升级前跑 §3.3 预检,把 12 类配置对一遍。升级后启动期拒绝会替你找出所有配得不完整的实例。
- **用 VTAdmin 的集群**:`/api/` 删除对你无影响,直接升。
- **备份用 lz4 且显式配了 `--compression-level` 2-9**:升级前后各跑 3 次基准,把压缩比和 CPU 的变化同步给备份团队。

### ❌ 千万别用

- **升级期间在定向 session 里用子查询 SET**:旧 vtgate 存表达式原文,新 vttablet 的 strict table ACL 会**在每次后续查询上**拒绝,直到客户端重连。要么先升 vtgate,要么升级窗口内禁掉这种写法。
- **看到 `GrpcOptionalTlsOpenConnections{plaintext}=0` 就立刻关 `--grpc-enable-optional-tls`**:它支持决策,不构成证明。偶尔才上线的客户端看不到。
- **把 `--compression-level` 的语义升级当成 no-op**:它不报错、不破坏备份,只静默改变压缩特征。显式配了 2-9 的策略必须重新基准。
- **开 strict table ACL 但不给豁免 ACL 留业务出口**:`DO`/`CALL`/`REPAIR`/`OPTIMIZE`/`LOAD DATA` 会被无差别拒绝,包括本来有权限的调用者。先确认业务没有用存储过程做数据访问。
- **试图给 vtctld `/api/` 加认证而不是删除它**:它没有调用者,加保护的成本收益比是负的。

### 5 步生产升级 checklist

1. **升级前 4 周**:统计 vtctld `/api/` 的请求量(预期为 0);非零则先迁调用者到 `vtctldclient`。清掉 4 个 deprecated flag。
2. **升级前 2 周**:用 §3.3 的组合在预发环境逐条验证 12 类 CRL 启动期拒绝,把生产实例的 TLS flag 组合对一遍清单。
3. **升级前 1 周**:开 `--queryserver-config-enable-table-acl-dry-run`,收 7 天 `TableACLPseudoDenied{undetermined-table-set}` 数据,量出 strict 的影响面。
4. **升级窗口**:按 vttablet → vtgate 顺序滚动;期间禁止定向 session 的子查询 SET;升级后立刻验证备份的一次全量恢复(新老 lz4 帧格式互通)。
5. **升级后**:读 `GrpcOptionalTls*` 基线并开始每日采样;确认 `undetermined-table-set` 序列已出现在监控里;把 CRL 的 12 类拒绝条件写进运维手册的「启动失败排查」章节。

### 3 个诚实边界

1. **存储函数表达式内联调用仍未覆盖**:`SELECT f()` 里的 `f` 不是 `CALL`,函数体仍以 vttablet 的 MySQL 用户特权执行,ACL 只查语句自己命名的表。Vitess 不解析 `CREATE FUNCTION`,所以这只影响直接在 MySQL 里定义的函数。issue #21134 开着。
2. **部分解析的 CREATE TABLE 一律拒绝**:vttablet 无法把「Vitess 缺少语法的有效语句」和「真的在拷贝表的语句」区分开,所以 `CREATE TABLE t (SELECT ...)` / `AS TABLE src` / `EXCEPT`/`INTERSECT` 源全部按不可判定拒绝,只能由豁免 ACL 执行。issue #21138 跟踪补语法。
3. **定向 SET 多一跳往返不是免费的**:release notes 明确写了 "Each targeted `SET` costs one additional round trip to the shard"。在每次连接都做 session 初始化的高频短连接场景,这个代价是可测的。

### 3 个长期判断

1. **「配置已声明但语义不完整 → 启动期拒绝」会成为基础设施的默认契约**。CRL 的 12 类拒绝和 table ACL 的 fail-closed 是同一个反模式的两面,这个反模式在中间件里普遍存在(任何有「可选依赖」的配置都可能被配半截)。未来一年,我们会看到更多项目把「配置自洽性检查」做成启动期的硬门禁,而不是运行期的静默降级。判据很简单:**如果你的某个配置在缺少另一个配置时被忽略而不是报错,它就是下一个待修的 CRL。**
2. **「不可判定」正在变成一类需要专属可观测性的状态**。`undetermined-table-set` 这个监控标签是本版本最容易被低估的创新:它把「我们不知道这条语句碰了哪些表」从一个**沉默的跳过**变成了一个**可计量的拒绝**。任何做权限检查的中间件都会需要这一层 —— 因为解析器永远有覆盖不到的语法,关键是覆盖不到时系统选择「放行」「拒绝」还是「可观测地拒绝」。
3. **攻击面收敛从「加保护」转向「删死代码」**。vtctld `/api/` 的删除是 562 行代码 + 13 个端点 + 不均匀的 `--security-policy` 一次清零,维护成本归零。当安全债的载体是「没人调用但还在运行」的接口时,删除是唯一零未来成本的修复。这会改变安全补丁的默认动作:先问「它还有调用者吗」,再问「怎么加锁」。

---

## 写在最后

Vitess v24.0.4 / v23.0.7 是 2026 年「补安全债」类版本的教科书样本:没有新功能,没有性能数字,只有 6 个改动把「配了等于没配」和「推不出来就跳过」两个十年反模式一次性关掉。

它做得最对的三件事都不是技术难度,而是判断力:**把兼容包装的可能性主动掐死并写明理由**(**"This breaks any out-of-tree caller on purpose"**)、**把不可判定变成一个带专属标签的监控序列而不是静默放行**、**把 13 个没人调用的未认证端点整块删除而不是逐个加锁**。

而它最诚实的地方是明写了代价:定向 SET 多一跳往返,滚动升级窗口里旧 vtgate 会反复被拒,备份的 `--compression-level` 语义静默改变。**一个把 breaking change 和它的代价一起写进 release notes 的版本,比一个号称无痛升级的版本值得信任得多。**

> 数据来源:Vitess v24.0.4 / v23.0.7 release notes(2026-10-01,各 19.7 KB),GHSA-fxqj-c35w-x6rq / GHSA-w6mx-2f8x-pqf4,PR #20778 / #21053 / #21139 / #21153 / #21162 / #21171,issue #21134 / #21138 / #21170,以及各 PR 的完整 diff。
