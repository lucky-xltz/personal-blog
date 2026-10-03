---
title: "Caddy v2.11.6 深度拆解：一个 patch release 把 12 个默认行为改成「严厉」——WHATWG URLPattern 路由、Slowloris idle deadline、头部别名硬化与 forward_auth 竞争修复"
slug: caddy-2-11-6-url-pattern-slowloris-idle-deadline-header-hardening-forward-auth-2026
date: 2026-10-03
category: 技术
tags: [Caddy, 反向代理, Web服务器, URLPattern, WHATWG, 路由匹配, Slowloris, 慢速攻击, idle timeout, deadline, min-rate, HTTPoxy, FastCGI, 头部注入, 头部别名, 16KiB, max_header_size, forward_auth, 竞争条件, 数据竞争, GHSA, 安全, 健康检查, random_choose, 蓄水池采样, power-of-two-choices, 负载均衡, SSE, server-sent-events, encode, zstd, 优雅关闭, graceful shutdown, Go1.26, Admin API, 配置验证, 幂等, TLS, mTLS, client_auth, 通配符, QUIC, HTTP3, Tailscale, MTU, 性能, 分配优化, GC, 延迟, 运维, 边缘计算, 2026]
author: 林小白
readtime: 24
cover: https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&h=400&fit=crop
excerpt: "2026 年 10 月 1 日发布的 Caddy v2.11.6 是一个「patch release」，但 release notes 有 27 KB、107 个 PR、40 位新贡献者，更重要的是它一口气改掉了至少 12 个默认行为——全部朝「更严厉」的方向。四条主线：① 路由表层引入 WHATWG URLPattern 标准的 url_pattern 匹配器（命名分组变占位符 {http.url_pattern.<component>.<group>}），并在同一个版本内修掉了它自己的编码斜杠绕过（GHSA-m8m5-v4jf-3wcm，匹配器读原始 URI 而处理器读解码后的 Path，/public/..%2fadmin/secret 能穿过 /public/* 白名单）；② 连接层引入 idle read/write deadline 对抗 Slowloris（默认 1 分钟，每次成功读/写重置，慢但前进的连接不杀，另加 min-rate 语义和 64 KiB MaxChunk 防止大 sendfile 被单个 deadline 截断）；③ 头部层把请求头上限从 Go 默认 1 MB 砍到 16 KiB、继续丢弃下划线头部并新增丢弃点号头部（PHP 把 . 折叠成 _ 可冒充合法头部）、新增 expected_underscore_headers / expected_dot_headers 白名单；④ 反向代理核心修掉 forward_auth 与 reverse_proxy 共用时的上游连接错配数据竞争（GHSA-6365-7ppr-5r92，把 dial info 从包级变量移进 context key）、健康检查状态按检查配置指纹隔离、random_choose 的蓄水池采样重写（修复前 100k 次模拟 50.2% 请求落在饱和后端）、SSE 在 encode 下立即刷出而非缓冲。外加优雅关闭跨 config 等待、Go 1.26 最低版本、Admin API /load 返回 400 + warnings 的合法 JSON。本文给 5 段可运行代码、5 套反向代理 17 维度对比、6 条可复现硬指标、5 步生产升级 checklist，以及 3 个长期判断。"
---

# Caddy v2.11.6：一个 patch release，把 12 个默认行为改成「严厉」

## 〇、为什么一个 patch release 值得拆三天

2026 年 10 月 1 日，Caddy 发布了 **v2.11.6**。按语义化版本，它是一个 patch release——不应该有破坏性变更。但它的 release notes 有 **27 KB**，合 **107 个 PR**、**40 位新贡献者**，结尾写着一句警告：

> ⚠️ **Please read the breaking changes below before upgrading.** Most of them come from security hardening, and most configs won't notice.

这句话是理解整个版本的钥匙。**Caddy 2.11.6 的核心主题不是「新功能」，而是「默认值重定价」**——把过去十年 Web 服务器领域 inherited（继承）自 1990 年代 CGI 时代的宽容默认值，逐项改成严厉默认值。

这不是 Caddy 一家的动作。早上 9:30 那篇 AI 日报里，苹果把 macOS Full Disk Access 从「装了就能用」改成「必须非常显式的用户操作」，理由是「日益自主的 AI agent 使风险等级显著上升」。**同一天，Web 服务器层在干同一件事**：把「默认宽容」改成「默认严厉」，把「出了事再配」改成「默认就挡」。

两个动作的结构完全同构：

| 维度 | macOS Full Disk Access（10-03 早上） | Caddy v2.11.6（本文） |
|------|--------------------------------------|----------------------|
| 被收紧的默认 | app 装了就能读全部文件 | 请求头默认 1 MB 上限、不丢任何头部 |
| 收紧后的默认 | 需要「very explicit user action」 | 16 KiB 上限、下划线/点号头部默认丢弃 |
| 理由 | AI agent 自主性上升 | AI agent 让「头部别名冒充」「慢速攻击」「配置错误」的成本上升 |
| 谁受影响 | 桌面 agent 厂商（ChatGPT / Muse / Dot） | 所有把 Caddy 当前置网关的团队 |
| 逃生舱 | 用户显式授权 | `expected_underscore_headers` / `expected_dot_headers` 白名单、`max_header_size` 调高 |

release notes 里还有一句只有这个版本才有的自嘲，值得原味引用：

> Thank you to everyone who contributed or spent their LLM tokens responsibly to help with this release! We have much more in the pipeline still, as AI has made contributions of all quality levels cheap and easy.

以及 v2.11.4 里那句更狠的：**「We have had to reject more than 75% of "security" reports because they were AI slop spam」**。这个版本本身就是「AI 时代的开源项目治理」样本——107 个 PR 里大量 PR 的 Assistance Disclosure 写着「CodeBuddy (Deepseek-V4-Pro) 生成测试」「Codex 生成实现，我审查」「Claude 生成测试」。**本文最后一节会讲：当贡献者流水线变成 LLM 时，「默认值严厉化」是唯一可持续的安全策略。**

全文 changelog 范围是 `v2.11.4...v2.11.6`（中间没有 v2.11.5 的 tag），下面把 12 个默认行为变更归到 **4 条主线 + 1 条治理线** 里逐个拆。

---

## 一、路由表层：把「正则」换成「标准」，并在同一个版本里修掉它自己的绕过

### 1.1 url_pattern：第一次让路由语法跟浏览器对齐

**承重级革新 #1**：新增 [`url_pattern` 请求匹配器](https://caddyserver.com/docs/caddyfile/matchers#url-pattern)，实现 [WHATWG URLPattern](https://urlpattern.spec.whatwg.org/) 标准（PR #7787，Kévin Dunglas，+581/-3）。

这看起来只是「多一个匹配器」，但它解决的是 Caddy 路由层一个十几年的结构性问题：**Caddyfile 的路由匹配语法，跟前端、跟其他后端框架，从来不是同一套。**

在 v2.11.6 之前，Caddy 的路径匹配有三套互相不重叠的语义：

```caddyfile
# 1. path 匹配器：前缀/精确/通配，语义是 Go 的 path.Clean 后比较
@assets path /assets/* /img/*

# 2. path_regexp 匹配器：Go RE2 正则
@api path_regexp ^/api/(v[0-9]+)/.*

# 3. 表达式（CEL）：可以在 matcher 里写任意表达式
@admin expression `{http.request.uri.path}.startsWith("/admin")`
```

三套各自的「路径」定义都不一样：`path` 先 clean 再比较，`path_regexp` 匹配的是原始路径还是解码后路径取决于你怎么取变量，CEL 里你写的是字符串方法调用。**一个团队里前端写 `/users/:id`，后端写 `path_regexp ^/users/([0-9]+)`，网关写 `path /users/*`，三处对「同一个 URL 是不是匹配」的判断可以给出三个不同答案。** 这不是理论问题——下一小节就是一个真实的、由两套路径模型不一致直接导致的安全绕过。

`url_pattern` 把这套东西统一到 WHATWG URLPattern——**这是浏览器 JS 里 `new URLPattern()` 的同一套规范，也是 Ruby on Rails / Express / FastAPI 路由语法的共同祖先**：

```caddyfile
# v2.11.6 新语法
@api {
    url_pattern /api/v{version}/*/{id}
    reverse_proxy backend:8080
}

# 命名分组自动变成占位符，可以在后续指令里直接引用
respond /api/v{version}/*/{id} "version={http.url_pattern.pathname.version} id={http.url_pattern.pathname.id}"
```

捕获分组通过 `{http.url_pattern.<component>.<group>}` 占位符暴露——`<component>` 是 URLPattern 的 pathname / search / hash 等组件，`<group>` 是你命名的分组名。这跟 JS 侧 `pattern.exec(url).pathname.groups.version` 是一一对应的。

三个设计细节值得注意：

1. **相对模式匹配任意 origin，绝对模式或 `base_url` 才限定 scheme + host**。这意味着 `url_pattern /api/*` 只看 path+search，而 `url_pattern https://api.example.com/*` 会同时校验协议和主机名——后者在多租户网关里很有用，因为一个 Caddy 实例可能同时 serve 几十个域名。
2. **同时提供 CEL 函数 `url_pattern(...)`**，所以你可以在 `expression` 里把它跟其他条件组合，而不是被迫在「整段路由用 CEL」和「用 matcher」之间二选一。
3. **正则组件仍然支持**（`{version:v[0-9]+}` 形式），所以它不是「正则的替代品」，而是「正则的上层语法糖 + 标准化语义」。

**关键洞察 1：`url_pattern` 的价值不在语法好看，在于「路由语义」第一次在浏览器、应用框架、网关三层是同一个对象。** 这直接减少了「ACL 在网关层写的规则跟应用层的路由不是同一个意思」这类漏洞的表面积——而这正是下一小节的漏洞。

### 1.2 同一个版本内修掉它自己的绕过（GHSA-m8m5-v4jf-3wcm）

`url_pattern` 在 #7787 合进 master，**还没来得及进任何 tag，就带着一个授权绕过被 #7941 修掉了**。这个 bug 的结构极其经典，值得完整复述。

PR #7941 的 advisory 明确写着「**No released version is affected**」——bug 只存在于 master。但它的原理对所有写网关 ACL 的人都是教训：

**问题根因**：`MatchURLPattern.Match()` 求值的是**原始的、百分号编码的 URI**（`r.URL.RequestURI()`），而**所有消费路径的 handler 求值的是解码后、clean 后的 `r.URL.Path`**。

于是构造请求 `/public/..%2fadmin/secret`：

- `URLPattern` 解析器看的是 `/public/..%2fadmin/secret`。对它来说 `..%2f` 是**一个不透明的路径段**（percent-encoded slash 在 URLPattern 的解析里不充当分隔符），所以整体是 3 个段：`public`、`..%2fadmin`、`secret`。
- 你的白名单模式 `/public/*` **匹配成功**。
- 然后 handler（`file_server` / `reverse_proxy` / `php_fastcgi` / 内部路由）拿到请求，Go 的 `http.ServeMux` 生态会把 `%2f` 解码成 `/`，再 clean，实际路由到 `/admin/secret`。

**匹配器和处理器在同一个请求上跑了两套路径模型。** 任何用 `url_pattern` 建的 ACL 都能被一个未认证请求用编码斜杠绕过。修复（+86/-4）让 matcher 在解码后的 `r.URL.Path` 上求值。

**关键洞察 2：这是「两层路径模型」灾难的最小可复现样本。** 而它不是 Caddy 独有的病：

- nginx 的 `location ~ ^/public/` 用的是**未解码** URI，`proxy_pass` 到后端时默认**不解码**，但 `merge_slashes on` 又会先压斜杠——三层三种语义。
- Envoy 的 `path_matcher` 有 `path_normalization` 选项（normalize_path / merge_slashes / path_with_escaped_slashes），三个开关的默认值在不同 listener type 上不同，是 Envoy 上当已久的 ACL 绕过高发地。
- Traefik 的 `PathPrefix` 匹配器在 3.x 里默认不做 URL decode，但 `Path` matcher 做，两个挨着的路由规则语义相反。

v2.11.6 里 Caddy 顺手把 `path_regexp` 的 Windows 反斜杠归一化（#7858，CVE-2026-52844 的补完）、`handle_path` / `uri strip_prefix` 结果归一化（防止绕过基于路径的授权）、以及 `path` matcher 对转义路径的过度匹配修复（#7828）**全部放进同一个 release**。这批改动合起来看是一件事：**把「路径」在整个请求处理管线里变成一个唯一确定的对象。**

**给你的直接建议**：如果你在网关层写任何 path-based ACL，今天就去跑一遍这个命令：

```bash
# 用编码斜杠打你自己的 ACL，看返回的是 401 还是 200
for path in "/public/..%2fadmin/secret" "/public/..%2f%2fadmin" "/public/%2e%2e/admin" \
            "/public/..\\admin" "/public/./admin" "/public//admin"; do
  printf '%-40s -> %s\n' "$path" "$(curl -s -o /dev/null -w '%{http_code}' "https://你的域名${path}")"
done
# 任何一个返回 200 而不是 403/404，你的 ACL 就是两套路径模型
```

---

## 二、连接层：把「慢」变成可观测、可定价的超时

### 2.1 idle deadline：Slowloris 的正确解法

**承重级革新 #2**：PR #7913（Dunglas，+1053/-59）引入 `ReadIdleTimeout` / `WriteIdleTimeout`，Caddyfile 里是 `read_body_idle` / `write_idle`，默认 **1 分钟**。

Slowloris 类攻击的原理是：打开大量连接，每个连接都以极慢的速度发送数据（比如每 100 秒发 1 字节），让服务器的并发连接槽被占满。**传统的 `ReadTimeout` 对此是错误的工具**——它是一个覆盖**整个传输**的硬截止时间，所以会误杀所有合法的长传：上传一个 2 GB 的备份文件，或者一个 30 分钟的 SSE 流，只要总时长超过 `ReadTimeout` 就被砍。

Caddy 之前的行为：`ReadTimeout` / `WriteTimeout` 默认 **0（无限）**，因为「设了就会误杀长传」。**结果是十年间 Slowloris 在默认配置下一直没被防御。**

新机制（直接读 v2.11.6 的 `modules/caddyhttp/idletimeout.go`）：

```go
// IdleDeadline computes the next read/write deadline for the idle-reset
// mechanism shared by IdleTimeoutReader and IdleTimeoutWriter.
type IdleDeadline struct {
	Start        time.Time
	Timeout      time.Duration
	MinRate      int64
	HardDeadline time.Time
	transferred  int64
}

func (d *IdleDeadline) next() (deadline time.Time) {
	if d.MinRate > 0 {
		credit := time.Duration(d.transferred) * time.Second / time.Duration(d.MinRate)
		deadline = d.Start.Add(d.Timeout + credit)
	} else {
		deadline = time.Now().Add(d.Timeout)
	}
	if !d.HardDeadline.IsZero() && deadline.After(d.HardDeadline) {
		deadline = d.HardDeadline
	}
	return
}
```

语义逐行解释：

- **`MinRate == 0`（默认）**：每次 `Read`/`Write` 之前把 deadline 推到 `now + Timeout`。**stall 的连接被杀，慢但在前进的连接永不被杀。** 这正是 nginx 的 `client_body_timeout` / `send_timeout` 的语义——PR body 明确说「matching nginx's semantics」。
- **`MinRate > 0`**：允许的截止时间从固定的 `Start` 起算，按已传输字节数增长（每字节 1/MinRate 秒），**对齐 Apache `mod_reqtimeout` 的 `MinRate`**。这一支是为了堵住「涓流攻击」：攻击者每 59 秒发 1 字节，在纯 idle 模式下永远不会触发超时。有了 min rate，一个维持不住 MinRate bytes/sec 的传输会**落后于真实时间**并被切断，即使没有任何一次单独的读停顿过。
- **`HardDeadline`**：如果配置了老的 `ReadTimeout`/`WriteTimeout`，idle-reset 出来的 deadline **不能超过它**。这是关键的安全设计——不然一个 1 分钟 idle + 每分钟 1 字节的连接在理论上可以永生。

实现走的是 Go 1.20+ 的 `http.ResponseController`（`SetReadDeadline` / `SetWriteDeadline`），所以它能穿透 `hijack`、`Flusher`、`ReadFrom` 等被包装的 ResponseWriter；如果底层连接不支持（返回错误），就打一条 debug 日志并**永久降级为不设 deadline**，而不是让请求失败。

### 2.2 MaxChunk：为什么大 sendfile 需要分块

读源码还发现一个 PR body 没强调、但极其重要的设计。`IdleTimeoutWriter` 里有一个 `MaxChunk` 字段，默认 `DefaultMaxWriteChunk = 64 * 1024`：

```go
// MaxChunk bounds how much a single underlying Write/ReadFrom call is
// allowed to cover; zero uses DefaultMaxWriteChunk. SetWriteDeadline
// bounds the whole call it precedes, not just a stall within it:
// net.Conn.Write loops internally until the entire buffer is sent
// (unlike Read, which returns after one syscall), and
// ResponseWriter.ReadFrom hands the entire remaining source to the
// connection in one call, be it via sendfile or an internal buffered
// copy loop. Without chunking, a single large Write or a large body
// copied via io.Copy would have its whole transfer bounded by one
// deadline, silently truncating a slow-but-healthy transfer exactly
// like a hard WriteTimeout would.
```

**这是整个新机制里最容易踩的坑，值得单独讲。** `SetWriteDeadline` 在 Go 里设定的是**「下一次 Write 调用的截止时间」**，而不是「下一次 stall 的截止时间」。而 `net.Conn.Write` 内部会循环直到整个 buffer 发完（跟 `Read` 返回一次 syscall 就返回不同），`ResponseWriter.ReadFrom` 更是把整个剩余 body 一次性交给连接（走 sendfile 或内部 copy 循环）。

**结果**：如果不分块，一次 100 MB 的 `io.Copy` 会被**一个** deadline 管住——一个慢但健康的 100 MB 传输会被当成 stall 直接截断，退化成跟老 `WriteTimeout` 一模一样的误杀。分块到 64 KiB 后，每个 chunk 有自己的 deadline，慢传输仍然安全；而 Go 的 `net/sendfile.go` 特判了 `*io.LimitedReader`，**每个 chunk 仍然走 sendfile 快路径**，所以性能损失几乎为零。源码注释还专门指出 nginx 的 `sendfile_max_chunk` 默认 2 MiB 且可调，是出于同样的原因。

### 2.3 新的 `timeouts` 指令：全局 + 每路由

新出了一个 [`timeouts` handler 指令](https://caddyserver.com/docs/caddyfile/directives/timeouts)，可以在单条路由里覆盖全局设置：

```caddyfile
{
	# 全局默认：idle 超时 1 分钟（v2.11.6 新默认）
	servers {
		timeouts {
			read_body_idle 60s
			write_idle      60s
		}
	}
}

example.com {
	# 大文件上传端点：放宽到 10 分钟，并要求至少 100 KB/s
	@upload path /upload/*
	handle @upload {
		timeouts {
			read_body_idle 600s 100
		}
		reverse_proxy uploader:9000
	}

	# SSE 端点：写 idle 拉长，因为客户端就是安静地听
	@events path /events
	handle @events {
		timeouts {
			write_idle 300s
		}
		reverse_proxy sse-backend:8080
	}
}
```

注意 `read_body_idle 600s 100` 的第二个参数就是 min rate（字节/秒），**不是独立的指令**——PR 作者解释这是刻意的设计选择，避免新增一个指令。

**关键洞察 3：release notes 明确说「Pauses *between* writes, like with SSE, don't count」。** 这句话是 v2.11.6 升级的最大行为变化：SSE / 长轮询 / chunked 上传在**默认配置下不受影响**，被影响的只有「客户端在 body 中途安静下去」的流。但反过来——**你的某个端点如果真的依赖「客户端可以中途发呆 10 分钟」，升级后会被 431 之外的方式断连，且只在生产环境才暴露**。这就是为什么 `timeouts` 指令必须存在。

---

## 三、头部层：从「别名冒充」到「显式白名单」

### 3.1 16 KiB 请求头上限：从 Go 默认的 1 MB 砍 64 倍

**承重级革新 #3**（breaking change）：请求头默认上限从 Go 的 **1 MB** 降到 **16 KiB**。超出的请求收到 `431 Request Header Fields Too Large`。调整用 `max_header_size` server option。

1 MB 是 Go `net/http` 的默认值，而 Go 的这个值是照搬 RFC 7230 的宽松解读。**16 KiB 这个数字是对 2026 年现实的回应**：现代 Web 应用请求头膨胀的两个来源是巨大的 JWT / OAuth token（几 KB）和巨大的 cookie（分析 SDK + A/B 测试 + feature flag 会轻易堆到 10 KB+）。**但 16 KiB 同样是 DoS 防线**：一个连接只需发 16 KB 就能让服务器分配解析结构，而 1 MB 意味着每个慢速连接可以廉价地占住 1 MB 内存——配合上一节的 Slowloris，1 MB 上限是把「慢速攻击」的内存放大了 64 倍。

### 3.2 头部别名：PHP 的折叠规则成了攻击面

v2.11.4 开始丢弃带下划线的请求头。**v2.11.6 把这条规则扩展到带点号（`.`）的头**（breaking change），并给出 escape hatch：

- **为什么要点号**：PHP 把 `.` 在 cookie/header 名里折叠成 `_`。所以 `X.Foo` 和 `X_Foo` 在 PHP 后端是**同一个变量**。攻击者发 `X.Forwarded.For: 1.2.3.4`，PHP 侧读到的就是 `HTTP_X_FORWARDED_FOR`——可以冒充任何你的应用信任的头部（最典型的是 `Forwarded` / `X-Real-IP` 链）。
- **下划线同理**：这是 v2.11.4 的变更，因为 CGI/FastCGI 规范把头转成环境变量时 `X-Foo` 变 `HTTP_X_FOO`，而 `X_Foo` 直接变 `HTTP_X_FOO`——**冒充成本是零**。
- **逃生舱（两次同框出现）**：[`expected_underscore_in_headers`](https://caddyserver.com/docs/caddyfile/options#expected-underscore-in-headers)（#7809 恢复了被删掉的 opt-in 开关）和新的 [`expected_dot_headers`](https://caddyserver.com/docs/caddyfile/options#expected-dot-headers)（#7859 之外的 #7809 配对）。**注意名字：不是 allow_*，是 expected_*——语义是「我声明我的应用确实用这些头」**，而不是「我允许任意下划线头」。

```caddyfile
{
	servers {
		# 显式声明：我的后端确实用这些下划线/点号头
		expected_underscore_headers X_Device_Id X_Trace_Id
		expected_dot_headers         X.Region X.Tenant
	}
}
```

**关键洞察 4：`expected_*` 而不是 `allow_*`，这个命名是整个头部硬化的灵魂。** 它把「头部命名空间」从「默认开放 + 黑名单」翻转为「默认关闭 + 显式声明」——跟 macOS 的「very explicit user action」是同一个设计模式。代价是 PR #7809 的作者在 body 里写下的真实痛点：**immutable client（已部署的移动 app）发下划线头时，这个 breaking change 没有迁移路径**——你不能给已经装在用户手机上的 app 推一个新 header 名。所以升级前必须先看自己的 access log 里有没有下划线头。

### 3.3 HTTPoxy：一个 2016 年的漏洞，FastCGI 到 2026 年才堵

#7934（+57/-0）修复 FastCGI 传输的 **HTTPoxy** 漏洞：FastCGI transport 把**所有** HTTP 头传给后端当环境变量，包括客户端可控的 `Proxy` 头，于是攻击者可以设置后端的 `HTTP_PROXY` 环境变量，劫持后端应用发出的所有出站 HTTP 请求。

HTTPoxy 是 2016 年被公开的（CVE-2016-5385 等），影响所有把请求头原样转成环境变量的 CGI/FastCGI 实现。**Caddy 的 FastCGI 传输十年后才堵上它**——这说明两件事：① 「反代到 PHP」这条路径在过去十年里一直是一条默认不安全的数据通道；② 这类「老而未被注意」的漏洞正是 AI 辅助审计开始系统性扫出来的那一批（PR 的 Assistance Disclosure 写着 CodeBuddy / Deepseek-V4-Pro 生成测试）。

### 3.4 同批的其他头部/路径硬化

| PR | 改动 | 为什么是安全问题 |
|----|------|-----------------|
| #7952 | Windows 8.3 短名在**每个**路径组件里被拒绝（之前只查最后一段） | `PROGRA~1` 绕过基于长名的路径黑白名单；之前只查末段，`C:\PROGRA~1\app\secret` 能过 |
| #7858 | `path_regexp` 的 Windows 反斜杠归一化（CVE-2026-52844 补完） | `/public/..\admin` 在 Windows 上等价于 `/public/../admin`，正则不归一化就绕过 |
| — | `handle_path` / `uri strip_prefix` 结果归一化 | rewrite 后的路径不归一化 = 绕过基于路径的授权 |
| — | file server ETag 碰撞修复 | 不同 mtime/size 的文件算出相同 ETag → 缓存投毒 |
| — | sticky session cookie hash 常数时间比较（#7853） | 时序侧信道可恢复 session cookie 的哈希前缀 |
| — | 多个 `authentication` provider 响应不再互相 clobber（#7904） | 一个 provider 的 401 被另一个 provider 的 200 覆盖 = 静默放行 |

---

## 四、反向代理核心：一个数据竞争、一个共享状态、一个坏掉的采样器

### 4.1 forward_auth + reverse_proxy：上游连接错配（GHSA-6365-7ppr-5r92）

**承重级革新 #4**，也是本版本唯一的 GHSA 级 bug：当一条路由**同时**用 [`forward_auth`](https://caddyserver.com/docs/caddyfile/directives/forward_auth) 和 [`reverse_proxy`](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) 时，请求可能被送到**错误的上游连接**上。报告者 @carlt，修复 @WeidiDeng（#7859，+13/-14）。

修复方式极其小巧——把 dial info 从**包级变量**移进 **context key**：

```go
// before: 包级变量被并发请求共享
// after (#7859):
// reverseproxy: save dial info in a context key instead of a variable
//                key to avoid race conditions when forward_auth is used
```

**这个 bug 为什么危险**：`forward_auth` 的工作流是「先打 auth 后端，通过了再打业务后端」。两阶段都用 `reverse_proxy` 的上游连接池。当 dial info 存在包级变量里时，**同一时刻处理多个请求的 goroutine 会互相覆盖对方的 dial info**——请求 A（已认证，目标是 `backend-A`）可能拿着请求 B（未认证，目标是 `backend-B`）刚写进去的 dial info，把请求送到 B 的上游。

后果链条：**认证通过了，但请求被发往另一个租户的后端**。在多租户网关里这是数据泄露；在单租户里这可能导致请求落到下线的灰度后端。**而且它是数据竞争，表现是「偶发、不可复现、只在生产高峰期出现」**——这是最难查的那类 bug。

13 行修复。**关键洞察 5：这是「包级变量当请求级状态」这一反模式的教科书案例，也是 AI 辅助代码生成最容易犯的错**——LLM 写 Go 时极爱用包级变量做「缓存」，因为它的训练语料里包级 `var` + `sync.Mutex` 的模式远多于 context 传值。这类 bug 会越来越多。

### 4.2 健康检查状态：一个上游被一个 handler 的探针拖垮（#7916）

**承重级革新 #5**：多个 `reverse_proxy` handler 用**不同的** active health check 配置（不同 `health_uri` / `health_headers`）探**同一个** dial address 时，它们共享全局连接池里的**同一个** `Host` 条目——**一个 handler 的探针失败会把该地址标记为不健康，所有 handler 都跟着失败**。

修复（SillyZir，+187/-27）：连接池的 key 从「dial address」改成「dial address + 健康检查配置的稳定指纹」。三个设计细节让这个改动没有被做成「破坏可观测性」的：

- Prometheus `upstreams_healthy` 指标的 label **不变**（仍然是纯 dial address），所以你的 Grafana 面板和告警规则不需要改。
- `/reverse_proxy/upstreams` admin endpoint 在输出时**剥离指纹**（`hostKeyAddress`），所以 API 返回仍然是纯 dial address。
- **明确的作用域声明**：dynamic upstreams **故意不被覆盖**——它们走独立的 per-lookup `dynamicHosts` 路径，生命周期语义不同，作者选择留给后续 follow-up 而不是「修一半」。回归测试 `TestActiveHealthChecksSameAddressDifferentChecksAreIndependent` 起两个 handler 探同一地址的不同 `health_uri`，断言 vhost B 的健康状态保持独立。

**为什么这算承重级**：它改变了「健康」这个概念在多 handler 场景下的语义。以前 `upstreams_healthy` 是「这个地址健康吗」，现在是「**这个地址在这次检查配置下健康吗**」——**健康从全局布尔变成每配置的视图**。对 A/B 测试、灰度发布、金丝雀路由（同一后端用不同探针判断「灰度健康」还是「全量健康」）这是直接的生产能力。

### 4.3 random_choose：一个从来没正确的蓄水池采样（#7873）

`random_choose` 策略本意是实现 **power-of-d-choices**：随机采样 d 个可用上游，选其中负载最低的。修复前的采样循环**不是**正确的蓄水池采样（Algorithm R）：它没有无条件填满前 k 个槽位，而是把每个候选写到随机槽 `j = rand(i+1)`——**可以驱逐掉更早的候选而留下另一个 nil 槽**；而且 `j` 是从上游的**连接池索引**推出的，而不是从「已见到的可用上游数量」推出的，所以每当 down 的上游排在 up 的前面，样本就产生偏斜。

实际后果，PR 作者做了 100k 次模拟：

> Most visibly, with two upstreams and `random_choose 2` (the canonical power-of-two-choices setup), **half of all requests go to the more-loaded upstream even when it is saturated and the other idle** — measurably identical to plain `random` (simulated over 100k selections: 50.2% to a backend with 100 in-flight requests vs. an idle one). With 3 upstreams and one down, 33% of requests go to the saturated backend.

**这是本版本最容易被低估的修复。** power-of-two-choices 是过去十年负载均衡领域最重要的理论成果之一（Mitzenmacher 的经典结果：在 supermarket model 下，用两个随机选择的最小负载队列，排队延迟从 O(log n) 降到 O(log log n)）。它的全部价值都依赖「均匀采样 2 个」这一前提。**Caddy 的实现从来没做到均匀采样**，所以所有配了 `random_choose 2` 的用户，拿到的就是 plain random 的效果，却以为自己在用 power-of-two-choices。

**关键洞察 6：这是「性能 bug 不报警、只表现为 P99 尾延迟略高」的典型。** 你的监控系统会显示「流量按预期分布」，因为 50/50 看起来很均匀——**均匀不是问题，问题是「均匀地忽略了负载」**。修完后 high-load backend 的 50.2% 才会掉到 power-of-choices 应有的水平。

### 4.4 reverse_proxy 其余改动

| PR | 改动 | 场景 |
|----|------|------|
| #7849 (+113/-0) | 部分响应正确 flush 给客户端 | chunked / 分块生成的响应以前被缓冲，客户端看到卡住 |
| #8027 | 升级后的流（WebSocket）传播 TCP half-close | 客户端关了写端，后端不知道，连接泄漏到超时 |
| #8042 | `versions 3` 上游遵守 `tls_trust_pool` | 之前静默忽略并验证系统根证书 = mTLS 到上游被绕过 |
| #7873 之外 | active health check body 只替换已知占位符 | 未知占位符原样出现在探针 body 里，探针发垃圾 |
| #7922 | network_proxy 拒绝解析到「无 host 只有端口」的代理 URL | 配置笔误导致静默走直连 |

**`#8042` 值得单独点出**：`versions 3` 是 Caddy 新的上游 API 版本。静默忽略 `tls_trust_pool` 意味着你以为上游连了 mTLS，**实际在用系统 CA 池验证**——任何持有公共可信证书的中间人都能解密。这是「配置写了但没生效」类故障里最危险的一种，因为它不报错、不告警、只在安全审计时才被发现。

---

## 五、流式响应：encode 不再缓冲 SSE

**承重级革新 #6**：#7905（SillyZir，+249/-2）修复 #6293——当 `encode`（gzip/zstd）包住一个 serve `text/event-stream` 的 handler（典型是 `reverse_proxy` 到 SSE 后端）时，**Server-Sent Events 被缓冲，客户端收不到事件流**。

根因在 `encode` 的 ResponseWriter：它**扣住响应头直到第一次 body 写入**，为的是嗅探 content type 并应用 `minimum_length` 阈值后再决定要不要压缩。但 SSE 后端的典型行为是**先写 header 并 flush 来建立事件流，此时还没有任何事件 body**——于是被扣住的 header 永远到不了客户端，同样的缓冲也延迟了后续的每个事件。

修复：在 `WriteHeader` 里，当响应的 `Content-Type` 是 `text/event-stream` 时，**立即初始化编码并把 header 透写到底层 writer**。强制把 header 送出去同时标记响应已开始，后续事件写就绕过 `minimum_length` 缓冲，逐个流到客户端。

**在 2026 年这个修复的分量比表面重得多**：SSE 是当前 AI streaming 事实上的标准传输层（OpenAI / Anthropic / 所有主流 LLM gateway 的流式接口都是 SSE）。**而 Caddy 的 `encode` 是几乎所有 Caddy 部署默认开启的响应压缩指令**——这意味着一个「默认开启的指令」跟「2026 年最热的流量类型」是不兼容的，而且表现是「LLM 回答看起来卡住但实际上在正常生成」——**这是最难排查的故障形态：不报错、不超时、看起来像模型慢**。

测试 `sse_test.go` 的两个断言值得照抄到你自己的网关测试里：

1. 一个先写 header + flush 再写 body 的 SSE handler：header 必须已经到达客户端（master 上失败，修复后通过）。
2. 一个非 SSE 的小响应：header 仍然允许缓冲——**确认绕过只对 SSE 生效**，不是把所有 `minimum_length` 阈值都废掉。

---

## 六、生命周期与配置面

### 6.1 优雅关闭跨 config 等待（#8009）

**承重级革新 #7**：配置 reload 后，一个长生命周期响应可能还在**旧的** HTTP server 上跑。随后的进程终止只等**当前** HTTP app 的 server，所以 Caddy 可能在那个旧响应中途退出。

这个 bug 是在 review [dunglas/mercure#1365](https://github.com/dunglas/mercure/pull/1365)（Mercure 是一个 SSE hub）时浮出水面的，且**不改 Mercure 也能复现**。修复（Dunglas，+157/-3）跨 HTTP app 实例跟踪 pending 的 server shutdown，在终止时等待它们，受终止配置的 grace period 约束。**reload 本身仍然不等待活动响应**（否则 reload 会卡住）。

验证质量是这个版本里最好的之一，值得原味引用：

> Rebuilt Mercure against this patch, opened 20 SSE connections, reloaded, then sent SIGTERM without opening connections on the new configuration. **All 20 streams reached clean EOF** across their write-deadline window. The unpatched Caddy ended all 20 with truncated resp[onses].

**关键洞察 7：SSE 长连接 + 高频 reload 是 2026 年网关的新常态。** Caddy 的核心卖点之一是「改 Caddyfile → POST /load → 零停机生效」，这个工作流在 AI streaming 时代每天会被触发几十次（灰度切换、证书轮换、限流规则调整）。**每一次 reload 都在制造「旧 server 上的活连接」**，而旧版本在 SIGTERM 时会砍掉它们。这直接对应「用户看到 LLM 输出到一半被切断」这个现象。

### 6.2 配置验证：从「静默接受」到「报错」

**承重级革新 #8**（breaking changes 组）：一批过去被静默接受（且大概率不按你想的工作）的配置现在变成 error：

- 重复的 `named_routes`（#7800）
- 重复的 `forward_auth` `uri`（#7814）
- 无效的 `weighted_round_robin` 权重（#7807）
- 非整数的 `browse` `file_limit`（#7988）
- 重复或歧义的 `map` 输入（#8067）
- 格式错误的 `map` 目标占位符（#8074）
- 模块路径里有歧义的 `@` 版本分隔符（#7974）

**每一个都是「静默错误」**：配置加载成功，Caddy 正常运行，然后在某个边界条件下行为跟你预期的完全不同。**`named_routes` 的例子最典型**（#7800 的 issue #7798）：重复定义时，**后定义的静默覆盖先定义的**——你的 `import` 顺序决定了哪条路由生效，而 Caddy 不告诉你。

### 6.3 Admin API `/load`：返回合法 JSON（#7267）

`POST /load` 在配置无效时**返回 200**，body 里是**两个拼接的 JSON 对象**（warnings + error）——**这是非法 JSON**。根因是 warnings 先写进了 `http.ResponseWriter`，于是默认了 200 状态码。

修复（+41/-25）后：无效配置正确返回 **400**，warnings 是 JSON 结构里的一等字段。**这对所有自动化 Caddy 的工具是刚需**：K8s operator、CI 部署脚本、`caddy reload` 的自动化包装——**它们全都 `json.loads()` 响应，而拼接 JSON 会让解析直接失败，且 200 状态码让重试逻辑以为成功了**。

### 6.4 其他面

| 改动 | 内容 |
|----|------|
| **Go 1.26 最低版本**（#8056，breaking） | 构建 Caddy 和插件现在需要 Go 1.26；插件作者被明确告知**只在插件用到导出 API 变更时**才升级依赖，因为升级现在也要求 Go 1.26 |
| `tls_automate_names` 全局选项（#8015） | 为不在 site block 里 serve 的域名管理证书——把「证书管理」从「站点托管」里解耦 |
| wildcard `client_auth` 不再继承（#7920，breaking） | `*.example.com` 的 mTLS 不再作用于有独立 site block 的更具体主机名。**注意作者的作用域选择**：只对 client auth 触发 shield，证书选择**保留继承**（因为覆盖主机名通常*想要*继承通配符证书），且显式保留了 `tls_automation_wildcard_shadowing` 行为 |
| HTTP/3 over Tailscale（#7886） | quic-go 的 `InitialPacketSize` 从 1280 降到 **1200**。Tailscale MTU 是 1280（IPv6 最小），1280 的 QUIC 包加 IP 头超 MTU 被丢——**HTTP/3 在 Tailscale 上以前根本连不上**。连接建立后 quic-go 会做 MTU discovery，所以吞吐损失是短暂的 |
| `method` matcher 归一化大写（#7832） | `method get post` 以前**永远匹配不到**任何请求（RFC 7230 要求方法名大写）。**一个让路由静默失效十年的拼写 bug** |
| `import` 进 named routes（#7986） | 之前不能在命名路由里 import 片段，破坏了 Caddyfile 的可组合性 |
| `set_cookie` 日志过滤器（#7888） | access log 里单独处理 `Set-Cookie`，不污染其他字段 |
| `roll_interval` 支持 `d`（#7900） | 日志滚动现在可以按天 |
| panic 记录为 ERROR（#7924） | 之前 recovered handler 的 panic 记录级别不对，告警规则抓不到 |
| 写超时错误进 access log（#7945） | 之前超时只记在 stderr，access log 里是「请求成功」 |

---

## 七、性能：每请求少一次分配，就是少一次 GC

v2.11.6 有一批「small but on the hot path」的优化。**单独看每个都小，合起来是「per-request 分配」这个指标的系统性下降**：

| PR | 优化 | benchmark |
|----|------|-----------|
| #7847 | `AcceptedEncodings` 用 `strings.Cut`（零分配）替代 per-token `strings.Split`，prefs slice 按逗号数预分配 | **1158.5n → 771.8n (−33.4%)**，408 → 216 B/op (−47.1%)，**9 → 3 allocs/op (−66.7%)** |
| #7936 | `{http.request.uuid}` 占位符的 `*requestID` **惰性分配**——以前每个请求在 replacer setup 时就分配，即使从没人读这个占位符 | 每请求少一次 16 字节分配（352 → 336 B/op，9 → 8 allocs/op）；**GC 压力收益而非延迟收益** |
| #7925 / #7926 | reverse_proxy 请求热路径减少分配，上游 slice 用已知大小预分配 | — |
| #7911 | 用 canonical header key casing 避免重复归一化 | — |
| #7903 | 大目录的 directory browsing 加速 | — |

**关键洞察 8：#7847 和 #7936 代表的是 2026 年 Go 性能优化的主流形态——不是「让某个函数快 3 倍」，而是「让每请求少分配」**。

为什么？因为在这个规模下，**单次函数的 ns/op 已经不是瓶颈，GC 频率才是**。`AcceptedEncodings` 在**每个启用压缩的请求**上都跑；`addHTTPVarsToReplacer` 在**每个请求**上都跑。作者自己说得很清楚：

> Fewer allocations means less work for the garbage collector, which at high request rates translates into **lower GC frequency and steadier tail latency**, not just faster execution of this one function in isolation.

**「更稳的尾延迟」而不是「更低的平均延迟」**——这是 P99 SLO 时代唯一值得追的指标。而 `allocs/op` 从 9 降到 3，意味着同样硬件下 GC 触发频率降低到约 1/3。注意 #7936 的 benchmark：**ns/op 几乎没变（~700 → ~690）**——如果你只看延迟，你会觉得这个优化「没用」。

---

## 八、5 段可运行代码

### 代码 1：url_pattern 路由 + 编码斜杠绕过自测

```caddyfile
# /etc/caddy/Caddyfile.caddy2116-demo
{
	servers {
		# v2.11.6 新默认值，显式写出来方便 diff
		max_header_size 16KB
		timeouts {
			read_body_idle 60s
			write_idle      60s
		}
	}
}

demo.example.com {
	# 公开区：url_pattern 白名单（v2.11.6 新匹配器）
	@public url_pattern /public/{asset}/*
	handle @public {
		respond "PUBLIC asset={http.url_pattern.pathname.asset} rest={http.url_pattern.pathname.0}"
	}

	# 管理区：显式 path 匹配器做交叉对照
	@admin path /admin/*
	handle @admin {
		respond "ADMIN" 200
	}

	# 兜底：任何未命中的路径都当作「未授权」
	respond "denied" 403
}
```

```bash
# 升级到 v2.11.6 后跑这组测试。/admin/* 应该永远返回 403
# （因为 /public/..%2fadmin/secret 在 v2.11.6 里由 #7941 修好）
for p in "/public/img/x"                    \
         "/public/..%2fadmin/secret"        \
         "/public/..%2f%2fadmin/secret"     \
         "/public/%2e%2e/admin/secret"      \
         "/public/..\\admin/secret"         \
         "/admin/secret"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://demo.example.com${p}")
  printf '%-38s -> %s\n' "$p" "$code"
done

# 期望输出（v2.11.6）：
# /public/img/x                        -> 200
# /public/..%2fadmin/secret            -> 403
# /public/..%2f%2fadmin/secret         -> 403
# /public/%2e%2e/admin/secret          -> 403
# /public/..\admin/secret              -> 403
# /admin/secret                        -> 200   <- 这个本就该是 200
#
# 如果任何一行不是这个结果，说明你的 ACL 有两层路径模型。
# 在 v2.11.5 及之前（或 url_pattern 未修复的 master），第 2-5 行会是 200 = 绕过。
```

**怎么验证占位符真的拿到了分组**：`curl -s "http://demo.example.com/public/img/a/b/c"` 应该返回 `PUBLIC asset=img rest=`——注意 `rest` 因为模式里只声明了 `{asset}` 一个命名分组，`{...pathname.0}` 这种数字索引在 url_pattern 里不自动生成（未命名分组在 WHATWG URLPattern 里只有命名分组会出现在 groups 里），**这是 url_pattern 跟 `path_regexp` 的一个语义差异：后者用 `$1` `$2` 数字引用，前者只有命名分组**。

### 代码 2：Slowloris 防护 + 大上传不误杀

```caddyfile
{
	servers {
		timeouts {
			# 全局默认 = v2.11.6 的新默认值
			read_body_idle 60s
			write_idle      60s
		}
	}
}

edge.example.com {
	# --- 慢速攻击的实际场景 ---
	# 全局 60s idle 足以杀死 Slowloris：攻击者必须每 59 秒发一次数据，
	# 而它占住的连接槽成本比合法客户端高。

	# --- 例外 1：大文件上传 ---
	# 用 min-rate 而不是拉长 idle：要求至少 100 KB/s，
	# 这样既允许慢上传（idle 每次成功读都重置），
	# 又能杀死「每 59 秒发 1 字节」的涓流攻击。
	@upload path /upload/*
	handle @upload {
		timeouts {
			read_body_idle 600s 100
		}
		reverse_proxy uploader:9000
	}

	# --- 例外 2：SSE ---
	# 关键：write_idle 管的是「一次写卡住多久」，不是「两次写间隔多久」。
	# SSE 客户端安静听 30 分钟，每次事件写出都会重置 write_idle，所以默认 60s 就够。
	# 只有当你的 SSE 后端自己会卡住（不产生事件也不关闭）时才需要调大。
	@events path /events/*
	handle @events {
		reverse_proxy sse-backend:8080
	}

	# --- 例外 3：确有必要的硬上限 ---
	# 老的 ReadTimeout/WriteTimeout 语义没变，且作为 HardDeadline 兜住 idle-reset
	@report path /report/*
	handle @report {
		timeouts {
			read_body   300s   # 整个 body 传输的硬上限
			read_body_idle 120s
		}
		reverse_proxy reporter:8000
	}
}
```

```bash
# 用 curl 复现 Slowloris，验证 idle deadline 生效
# 每次只发 1 字节然后 sleep 70 秒（超过默认 60s idle）
(echo -n "POST /upload/big HTTP/1.1\r\nHost: edge.example.com\r\n"; \
 echo -n "Content-Length: 100\r\n\r\n"; \
 for i in $(seq 1 100); do echo -n "x"; sleep 70; done) \
  | timeout 90 nc edge.example.com 80

# v2.11.5：连接被占住 7000 秒（每个 Slowloris 连接占 1 个槽）
# v2.11.6：约 60 秒后连接被 abort，服务器日志出现写超时错误（且进入 access log）
#
# 对照：合法的慢上传（持续 50KB/s）不会被杀，因为每次成功读都重置 deadline
# —— 老的 ReadTimeout=60s 会误杀它，这就是为什么 Caddy 十年来默认 ReadTimeout=0
```

### 代码 3：头部硬化白名单（升级前必做的 access log 审计）

```bash
# 第 0 步（升级前）：确认你的流量里有没有下划线/点号头
# 这一步决定你升级后会不会断掉已部署的移动 app
tail -n 100000 /var/log/caddy/access.log \
  | grep -oE '"[A-Za-z0-9_.-]*_[A-Za-z0-9_.-]*"' | sort | uniq -c | sort -rn | head
tail -n 100000 /var/log/caddy/access.log \
  | grep -oE '"[A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]*"' | sort | uniq -c | sort -rn | head
# 输出里的每个头名，都是升级后会被丢弃的。列出来交给后端团队确认。
```

```caddyfile
{
	servers {
		max_header_size 16KB

		# 审计后确认「确实在用」的头才进来
		# 名字是 expected_* 不是 allow_*：这是声明，不是放行
		expected_underscore_headers X_Device_Id X_Trace_Id X_Request_Context
		expected_dot_headers         X.Region X.Tenant.Id
	}
}

app.example.com {
	# 后端是 PHP：必须开（点号折叠成下划线 = 冒充风险）
	# 后端是 Bun/Deno/Node/Go net/http：可以选择关掉这两个白名单
	php_fastcgi php:9000
}

api.example.com {
	# 纯 JSON API + Go 后端，没有 CGI/FastCGI 歧义
	# 这里就不用声明任何 expected_* 头
	reverse_proxy api:8080
}
```

```bash
# 验证白名单行为
curl -s -o /dev/null -w '%{http_code}\n' \
     -H "X_Device_Id: abc123" -H "X.Trace.Id: t-1" \
     -H "X.Evil_Header: yes" -H "X.Evil.Dot: yes" \
     https://app.example.com/
# X_Device_Id / X.Trace.Id：通过（在 expected_underscore_headers 里）
# X_Trace_Id：通过（在 expected_underscore_headers 里）
# X_Evil_Header：被丢弃（不在白名单）
# X.Evil.Dot：被丢弃（不在 expected_dot_headers 里）

# 验证 16 KiB 头上限
python3 -c "print('Cookie: ' + 'A'*20000)" > /tmp/big_header.txt
curl -s -o /dev/null -w '%{http_code}\n' \
     -H "$(cat /tmp/big_header.txt)" https://app.example.com/
# -> 431   （v2.11.6）
# -> 200   （v2.11.5 及之前，Go 默认 1MB 上限）
```

### 代码 4：健康检查隔离 + 负载均衡策略回归测试

```caddyfile
api.example.com {
	# v2.11.6 前：两个 handler 探同一地址，一个失败全完蛋
	# v2.11.6 后：health-check 配置指纹隔离，各自独立

	handle /canary/* {
		reverse_proxy {
			# 灰度探针：只查 /health/canary，阈值更严
			to lb:8080
			health_uri      /health/canary
			health_interval 5s
			health_timeout  2s
			# random_choose 修复后才是真正的 power-of-two-choices
			lb_policy random_choose 2
		}
	}

	handle {
		reverse_proxy {
			to lb:8080 lb2:8080
			# 全量探针：查 /health，阈值宽松
			health_uri      /health
			health_interval 10s
			lb_policy weighted_round_robin 1 3
		}
	}
}
```

```bash
# 复现 #7916 修复的场景（v2.11.5 会失败，v2.11.6 通过）
# 两个 handler、同一后端、不同 health_uri
# 让 /health/canary 返回 500，/health 返回 200
#
# v2.11.5：/health/canary 的失败把整个 lb:8080 标记为不健康
#          -> 主路由（用 /health 探针、本来健康）也开始 503
# v2.11.6：各自独立 -> 只有 /canary/* 路由 503，主路由正常

# 查 admin endpoint（指纹被剥离，输出仍是纯 dial address）
curl -s --unix-socket /run/caddy/admin.sock http://localhost/config/ \
  | python3 -m json.tool | grep -A3 '"upstreams"'
# 确认输出里是 "lb:8080" 而不是 "lb:8080|<指纹>"

# random_choose 的自测：灌 10 万个请求看分布
# 修复前：约 50% 落在饱和后端（跟 plain random 无区别）
# 修复后：饱和后端的份额显著下降（power-of-two-choices 生效）
for i in $(seq 1 10000); do curl -s -o /dev/null http://api.example.com/; done &
# 同时在两个后端上 watch 访问计数，比较份额
```

### 代码 5：Admin API 自动化（合法 JSON + SSE reload 安全）

```bash
# ---- 1. Admin API 现在返回合法 JSON（#7267 修复）----
# v2.11.5：返回 200 + 两个拼接的 JSON 对象 = json.loads 直接炸
# v2.11.6：返回 400 + 一个合法 JSON，warnings 是一等字段
curl -s -w '\nHTTP %{http_code}\n' \
     --unix-socket /run/caddy/admin.sock \
     -H "Content-Type: text/caddyfile" \
     --data-binary @Caddyfile.broken \
     http://localhost/load
# ->
# {"result":{},"warnings":[...],"error":"..."}
# HTTP 400

# 自动化部署脚本现在可以这么写（之前不行，因为 200 + 非法 JSON）
python3 - <<'PY'
import json, urllib.request, sys
class UDSHTTP(urllib.request.HTTPSHandler): pass
req = urllib.request.Request("http://localhost/load", data=open("Caddyfile","rb").read(),
                             headers={"Content-Type": "text/caddyfile"})
# （省略 unix socket transport，生产用 requests-unixsocket）
try:
    resp = urllib.request.urlopen(req, timeout=10)
    print("config applied, warnings:", json.load(resp).get("warnings"))
except urllib.error.HTTPError as e:
    body = json.load(e)                       # v2.11.6：不会抛 JSONDecodeError
    print("REJECTED:", body["error"])
    for w in body.get("warnings", []):
        print("  warn:", w)
    sys.exit(1)
PY

# ---- 2. SSE 长连接 + reload 的优雅关闭验证（#8009 修复）----
# 开 20 个 SSE 连接，reload，再 SIGTERM
for i in $(seq 1 20); do
  curl -sN https://hub.example.com/events > /tmp/sse_$i.log &
done
sleep 2

# reload（零停机，新 config 生效）
curl -s --unix-socket /run/caddy/admin.sock \
     -H "Content-Type: text/caddyfile" --data-binary @Caddyfile.new \
     http://localhost/load

# 立刻 SIGTERM（模拟 K8s rolling update 的 kill）
sleep 1; pkill -TERM -f 'caddy run'

# v2.11.5：旧 server 上的 SSE 流被截断 -> 20 个日志文件末尾是残缺的 JSON 事件
# v2.11.6：所有 20 个流在 grace period 内走到 clean EOF
for f in /tmp/sse_*.log; do
  if tail -c 1 "$f" | od -An -c | grep -q '\\n'; then echo "$f OK"; else echo "$f TRUNCATED"; fi
done
```

---

## 九、5 套反向代理 17 维度对比（v2.11.6 时代的选型表）

对比对象：**Caddy v2.11.6** / **nginx 1.31** / **Envoy 1.39** / **Traefik v3.7** / **HAProxy 3.x**

| 维度 | Caddy 2.11.6 | nginx 1.31 | Envoy 1.39 | Traefik v3.7 | HAProxy 3.x |
|------|--------------|------------|------------|--------------|-------------|
| 1. 默认请求头上限 | **16 KiB**（v2.11.6 新） | 8 KB（`large_client_header_buffers` 4 8k） | 60 KB（`max_request_headers_kb`） | 无显式上限（Go 默认 10 MB） | 16 KB（`tune.bufsize`） |
| 2. Slowloris 防护默认 | **开（60s idle）** | 开（`client_body_timeout` 60s） | 开（`stream_idle_timeout` 5min） | **无**（靠 Go 默认） | 开（`timeout client` 50s） |
| 3. idle vs 硬超时分离 | **是（MinRate + HardDeadline 两层）** | 部分（idle 语义，无 min-rate 组合） | 是（HTTP/2 stream 级） | 否 | 部分 |
| 4. min-rate（涓流防护） | **有**（对齐 Apache mod_reqtimeout） | 无 | 无 | 无 | 无（只有 rate limit） |
| 5. 标准化路由语法 | **WHATWG URLPattern**（浏览器同源） | 正则 + 前缀（自有语义） | CEL + 正则 + matcher tree | Go matcher + 正则 | 无路由（纯代理） |
| 6. 路径归一化防绕过 | **默认全管线一致**（#7941/7858/7828） | `merge_slashes on` 但与 `proxy_pass` 解码语义分离 | `path_normalization` 三开关需手配 | PathPrefix 默认不 decode | N/A |
| 7. 头部别名硬化 | **默认丢 `_` 和 `.`，expected_* 白名单** | `ignore_invalid_headers on`（默认丢） | 无默认丢弃 | 无 | `option dontlog-normal` |
| 8. mTLS wildcard 继承语义 | **显式 shield，只对 client_auth** | server 级配置无继承歧义 | listener 级，无 wildcard SNI 继承 | `tls.options` 手动 | 无 |
| 9. 健康检查状态隔离粒度 | **per check-config 指纹**（v2.11.6 新） | per location | per cluster + per outlier detection | per service | per server/backend |
| 10. 负载均衡算法 | RR / weighted RR / IP-hash / least_conn / **random_choose（修复后真 power-of-2-choices）** | RR / least_conn / ip_hash / hash | 多种 + outlier detection + subset LB | WRR / mirror / plugin | 丰富（八种以上，含 `random` + `leastconn`） |
| 11. SSE / streaming | **encode 不再缓冲（v2.11.6 修复）** | 需 `proxy_buffering off` | 默认不缓冲 | 默认不缓冲 | 默认不缓冲 |
| 12. reload 对长连接 | **跨 config 等待 + grace period** | 热升级需 binary swap（老 worker 优雅退） | 热重启（drain listeners） | Let's Encrypt + ACME 零停 | 热升级（seamless reload） |
| 13. 配置即代码 | Caddyfile / JSON / CEL / **url_pattern** | conf 文件 + Lua（OpenResty） | YAML + CEL / WASM | YAML / TOML / CRD（K8s） | conf 文件 + Lua |
| 14. 动态配置 API | Admin API（unix socket，**现在返回合法 JSON**） | 无（需 reload） | xDS（gRPC，事实标准） | HTTP API + CRD | Runtime API（部分） |
| 15. ACME / 证书自动化 | **一等公民，默认 on**（+ `tls_automate_names`） | 需 certbot / acme.sh 外挂 | 需 SDS / 外挂 | 一等公民 | 需 certbot 外挂 |
| 16. HTTP/3 / QUIC | 支持（**v2.11.6 修了 Tailscale 低 MTU**） | 支持（需自行编译 quic 分支） | 支持 | 支持 | 支持（较新） |
| 17. 生态 / 插件 | Go 模块（**40 位新贡献者本版本**） | 巨量模块 + OpenResty 生态 | 云原生事实标准 + WASM | K8s 原生 + Docker label | 极致性能 + 硬件卸载 |

**怎么读这张表**：

- **Caddy 2.11.6 在维度 1/2/4/6/7/9 上是 5 个里最严的**——这是这个版本的主线：**默认值严厉化**。
- **Envoy 在维度 10/13/14 上仍然最强**——它不是「默认严厉」而是「可配置到极端」，代价是配置复杂度（一个 listener 的 YAML 可以到 200 行）。
- **nginx 在维度 13/14 上最弱**——没有动态 API，但生态最厚；如果你已经在用 OpenResty，没有理由换。
- **Traefik 在维度 2/6/7 上最松**——默认不防 Slowloris、不归一化路径、不丢别名头部。**K8s Ingress 用户要注意**：Traefik 的 IngressRoute 默认配置在这些维度上是暴露的。
- **HAProxy 在维度 5/13 上不是「网关」**——它是四层/七层负载均衡器的天花板，路由能力弱是设计选择。

**选型结论**：如果你的场景是「边缘 + 自动证书 + 中小规模 + 想要默认安全」，Caddy 2.11.6 是 2026 年唯一在默认配置下就挡住 Slowloris + 头部别名 + 编码斜杠的选择。如果你需要 xDS 动态下发、多团队共享控制面，Envoy 仍然不可替代。

---

## 十、6 条 6-12 个月可验证的硬指标（今天就能跑）

| # | 指标 | 怎么测 | 2026 Q4-Q2 判定线 |
|---|------|--------|------------------|
| 1 | **请求头大小分布的 P99.9** | 在网关 access log 记录 `req_header_bytes`，跑 7 天 | P99.9 < 8 KiB → 直接升级无风险；> 16 KiB → 必须先调 `max_header_size`，否则升级后 431 |
| 2 | **慢速连接占比** | `ss -tn` 采样 + 连接 age，或 Caddy metrics 找 `read_body_idle` / `write_idle` 触发计数 | 升级后每分钟被 idle deadline 杀死的连接 > 10 → 说明你有合法长传没被 `timeouts` 指令覆盖，或者你正在被慢速攻击 |
| 3 | **`random_choose` 后端份额** | 在两个后端分别统计 QPS，灌固定流量 10 分钟 | 修复前饱和后端份额 ≈ 50%（2 上游）；升级后饱和后端份额应显著 < 40%（power-of-two-choices 生效）。**如果还是 50%，说明你配的是 `random` 而不是 `random_choose 2`** |
| 4 | **每请求 allocs/op** | Caddy 编译时 `-ldflags` 带 benchmark，或 `go test -bench=BenchmarkAddHTTPVarsToReplacer -benchmem` 跑 2.11.5 vs 2.11.6 对比 | `AcceptedEncodings` 9 → 3 allocs/op（官方 benchmark），`addHTTPVarsToReplacer` 9 → 8。GC 频率应下降约 10-30%（取决于压缩命中率） |
| 5 | **reload 后 SSE 连接完整率** | 「代码 5」的 20 连接 reload+SIGTERM 测试，连续跑 7 天每日 20 次 | v2.11.6 应 100% clean EOF。任何一次 truncated → 说明 grace period 短于你的最长 SSE 流，需调 `grace_period` |
| 6 | **Admin API 自动化成功率** | CI 里统计 `POST /load` 的成功率 + 非 2xx 时的 JSON 解析成功率 | v2.11.6 后 400 响应必须 100% 可 `json.load`。**如果 CI 出现 JSONDecodeError，说明你还跑在 2.11.5 上** |

---

## 十一、5 步生产升级 checklist

### 第 0 步：升级前审计（30 分钟，跳过会断产）

```bash
# 0.1 有没有下划线/点号请求头（决定要不要 expected_* 白名单）
tail -n 500000 /var/log/caddy/access.log \
  | grep -oE '[A-Za-z0-9-]*[_\.][A-Za-z0-9-]*:' | sort | uniq -c | sort -rn | head -20

# 0.2 有没有 > 16 KiB 请求头的客户端（决定要不要调 max_header_size）
# 在前端 nginx 或 CDN 侧先开一段时间的大小日志
# 0.3 有没有「客户端 body 中途安静」的长传（决定 timeouts 例外）
#    典型：分块上传 SDK、某些 webhook 重试、老旧移动客户端
# 0.4 Go 版本：构建 Caddy / 插件的机器必须 Go >= 1.26（#8056）
go version   # 必须 >= 1.26

# 0.5 插件清单：只有插件用到的导出 API 变了才需要重新编译
#    release notes 明确警告 Dependabot 会报安全漏洞催你升级 go.mod
#    但「只升级 caddy 依赖」现在也要求 Go 1.26
```

### 第 1 步：灰度

```caddyfile
# 灰度 Caddyfile：所有新默认值显式写出，方便 diff 和回滚
{
	servers {
		max_header_size 16KB
		timeouts {
			read_body_idle 60s
			write_idle      60s
		}
		# 先不要全局开 expected_*，灰度期观察日志
	}
}
```

灰度顺序（实测安全）：① 非生产环境 24h → ② 低流量生产域名 48h（盯着 431 和 idle 断连指标）→ ③ 全量。**每一步都比对 access log 的 4xx 状态码分布**——431 的出现是头部超限，`write_idle` 断连会在 access log 里表现为 499/连接重置。

### 第 2 步：路由层回归（url_pattern 与路径归一化）

```bash
# 2.1 跑「代码 1」的编码斜杠测试组，全部应返回预期状态码
# 2.2 用 caddy adapt 验证配置（现在会报更多错，这是好事）
caddy adapt --config Caddyfile --adapter caddyfile 2>&1 | grep -E 'error|Error'
# 2.3 wildcard client_auth 场景：如果你有 *.example.com 的 mTLS
#     检查有独立 site block 的子域名是否还继承（v2.11.6 起不再继承）
# 2.4 method matcher 大小写：搜 Caddyfile 里所有小写 method
grep -nE 'method\s+[a-z]' Caddyfile*
#     v2.11.6 起归一化大写，所以老的 `method get` 现在能工作了
#     —— 但你该把它改成大写，因为它过去十年是静默失效的
```

### 第 3 步：反向代理层回归

```bash
# 3.1 forward_auth + reverse_proxy 组合（#7859 修复）
#     压测时开 race detector 编译的 caddy 跑 1 小时高并发
#     v2.11.5 会偶发「请求送到错误上游」，v2.11.6 不会
# 3.2 健康检查隔离（#7916）：跑「代码 4」的复现场景
# 3.3 random_choose 分布：跑「代码 4」的份额对比
# 3.4 versions 3 上游 + tls_trust_pool（#8042）：验证 mTLS 到上游真的生效
#     抓包确认客户端证书被发送（之前静默用系统根证书）
# 3.5 SSE 后端（#7905）：确认 encode 开启时事件即时到达
curl -sN https://app.example.com/events | head -3   # 应立即看到事件，不是卡住
```

### 第 4 步：生命周期与自动化

```bash
# 4.1 Admin API 脚本（#7267）：确认 400 响应是合法 JSON
# 4.2 reload + SIGTERM 的 SSE 完整率（#8009）：跑「代码 5」
# 4.3 日志：检查 set_cookie 过滤器、roll_interval 的 d 单位、
#     panic 的 ERROR 级别、写超时进 access log
# 4.4 tls_automate_names（#8015）：如果你有「只管证书不 serve 的域名」
#     从 site block 迁到这个全局选项
# 4.5 HTTP/3 over Tailscale（#7886）：如果你用 Tailscale，HTTP/3 现在能连了
curl -sI --http3 https://internal.example.com/   # 之前会超时
```

### 第 5 步：监控与回滚

```bash
# 必须加的 3 条告警
# 1. 431 状态码速率（头部上限）
# 2. idle deadline 触发计数（慢速攻击 or 误杀长传）
# 3. upstreams_healthy 各 label 翻转频率（#7916 后健康状态是 per-config 的，
#    翻转频率上升是正常的，但要确认你的告警阈值不会误报）

# 回滚：因为 Caddy 是单二进制，回滚 = 换回 2.11.5 二进制
#      Caddyfile 兼容（所有新选项都是新增，2.11.5 只会忽略它们）
#      ⚠️ 但 2.11.6 的 adapt 报错（重复 named_routes 等）在 2.11.5 是 warning
#         所以回滚后那些「静默覆盖」行为会回来，要记得改配置
```

---

## 十二、8 条关键洞察

**关键洞察 1**：`url_pattern` 的价值不在语法好看，在于**「路由语义」第一次在浏览器、应用框架、网关三层是同一个对象**——直接缩小了「网关 ACL 跟应用路由不是同一个意思」这类漏洞的表面积。

**关键洞察 2**：GHSA-m8m5-v4jf-3wcm 是「两层路径模型」灾难的最小可复现样本，而且**它是在同一天被引入又在同一天被修复的**——新的抽象如果没有跟下游消费者对齐，它的第一个生产故障就是授权绕过。nginx / Envoy / Traefik 各有各版本的同一种病。

**关键洞察 3**：idle deadline 的 `MaxChunk = 64 KiB` 是整个新机制里最容易被忽略的设计。**没有它，idle-reset 会在大 sendfile 上退化成硬超时，重新开始误杀慢传输**——「修复 Slowloris」和「不误杀大文件」这两件事在同一个机制里是冲突的，分块是唯一的解。

**关键洞察 4**：`expected_*` 而不是 `allow_*` 的命名是整个头部硬化的灵魂——**把头部命名空间从「默认开放 + 黑名单」翻转为「默认关闭 + 显式声明」**。代价是 immutable client（已部署移动 app）没有迁移路径，这是 breaking change 里最痛的一种。

**关键洞察 5**：`forward_auth` 的 13 行修复是「包级变量当请求级状态」反模式的教科书案例。**当贡献者流水线变成 LLM 时，这类 bug 会越来越多**——LLM 写 Go 时极爱用包级变量做「缓存」。

**关键洞察 6**：`random_choose` 从来没正确实现过 power-of-two-choices，**而它的表现是「监控系统显示流量按预期分布」**——50/50 看起来很均匀，问题是「均匀地忽略了负载」。**这是「性能 bug 不报警、只表现为 P99 尾延迟略高」的典型**，升级 checklist 里必须靠份额对比才能抓到。

**关键洞察 7**：SSE 长连接 + 高频 reload 是 2026 年网关的新常态。**Caddy 的「改 Caddyfile → POST /load → 零停机生效」工作流，在 AI streaming 时代每天会被触发几十次**，每一次 reload 都在制造「旧 server 上的活连接」。#8009 修复的正是「用户看到 LLM 输出到一半被切断」这个现象。

**关键洞察 8**：`encode` 缓冲 SSE 的故障形态是最难排查的一种——**不报错、不超时、看起来像模型慢**。而 `encode` 是几乎所有 Caddy 部署默认开启的压缩指令。**「默认开启的指令」跟「2026 年最热的流量类型」不兼容**，这个组合在升级前没人会主动去测。

---

## 十三、3 个长期判断

### 判断 1：「默认值严厉化」是 2026-2027 年所有基础设施项目的共同路线

Caddy 2.11.6 在一个 patch release 里改了 12 个默认行为，**全部朝严厉方向**。这不是孤立事件——同一天早上，苹果把 macOS Full Disk Access 改成需要「very explicit user action」。更早一点，PostgreSQL 18 把 `debug_prewarm` 类参数的默认值收紧、Node 26 把 `util.throttle` 默认拒绝、Docker Engine 29 把 containerd image store 变成默认。

**背后的共同驱动力是同一个**：**AI agent 正在把「人类不会做的事」自动化地做**。一个人类用户不会发 200 KB 的 cookie，但一个 agent 会把整个上下文序列化进 header；一个人类不会每 59 秒发 1 字节，但一个被限流绕过的爬虫会；一个人类不会配出 `method get` 然后困惑为什么路由不生效，但一个生成 Caddyfile 的 LLM 会。

**当使用者的「行为分布」被 agent 拉宽到长尾，宽容的默认值就从「便利」变成「负债」。** 预测：2026 Q4 到 2027 H1，你会看到 nginx / Envoy / HAProxy / Traefik 跟进同一批默认值收紧（尤其是请求头上限和 idle timeout），以及一批「AI agent 友好」的中间件出现（显式的 agent rate limit、明确的 429 语义、声明式的头部命名空间）。

### 判断 2：URLPattern 会成为「配置即代码」时代的路由标准，三年内吃掉 path_regexp 的一半场景

这不是因为 URLPattern 语法更好，而是因为**它是唯一一个在浏览器、服务器、框架三层有同一份实现的规范**。

2026 年的状态：前端用 `URLPattern`（Chrome/Safari/Firefox 已实现），后端框架用它（Rails / Express / FastAPI / Remix 路由语法的共同祖先），现在网关也开始用它。**当三层用同一个对象描述路由时，「网关 ACL 跟应用路由不一致」这类漏洞就从「设计上不可避免」变成「可以完全消除」。**

而替代的代价极低：命名分组直接变占位符，正则组件仍然支持，CEL 函数仍然可用。**预测**：12 个月内 Caddy 生态里过半的 `path_regexp` 会被 `url_pattern` 替代；24 个月内会出现跨网关的 URLPattern 配置 lint 工具（类似今天的 markdown linter 之于文档）；36 个月内 WHATWG URLPattern 会进入至少一个 K8s Ingress controller 的 CRD 作为一等路由类型。

### 判断 3：这个版本本身是「AI 时代开源治理」的分水岭样本

107 个 PR，40 位新贡献者，大量 PR 的 Assistance Disclosure 写着 LLM 辅助（CodeBuddy / Codex / Claude 生成测试或实现，人类审查）。**而项目的回应是「默认值严厉化」**——因为当贡献的边际成本趋近于零时，**唯一可持续的安全策略就是让「错误的配置」在默认情况下不工作**。

release notes 里有两句互相照应的话，值得所有开源维护者品：

- v2.11.6：「as AI has made contributions of all quality levels cheap and easy」
- v2.11.4：「We have had to reject more than 75% of "security" reports because they were AI slop spam」

**这是一个新的均衡**：LLM 把「贡献」和「安全报告」的量级同时放大了一个数量级，维护成本也随之上升。**项目的应对只能是结构性而非个体性的**：把验证负担从「维护者审查每个 PR」转移到「默认配置在数学上不容易被配错」。Caddy 2.11.6 把「重复的 named_routes」「歧义的 map 输入」「非整数的 file_limit」全从 warning 升成 error，就是这个策略的直接执行。

**预测**：2026 H2 到 2027 年，「AI slop 报告」会成为每个热门开源项目的固定成本项，会出现第一批**专门为「AI 辅助贡献」设计的 CI 门禁**（强制 Assistance Disclosure 字段、LLM 报告的自动分诊、贡献者信誉衰减），以及一批**因为维护成本失控而 archive 的中等项目**。**而「默认值严厉化」+「把静默错误变成编译期错误」会成为新的项目质量标杆**——就像十年前「CI 绿了才能合并」成为标杆一样。

---

## 写在最后

Caddy v2.11.6 是一个奇怪的版本：**它没有任何一个「让你想升级」的功能，但有一堆「不升级就会出事」的修复**。

12 个默认行为变更，全部朝严厉方向；1 个 GHSA 级数据竞争（认证通过但请求发给错的上游）；1 个从未正确的负载均衡采样器（你以为的 power-of-two-choices 是 plain random）；1 个「默认开启指令 × 2026 最热流量类型」的不兼容（encode × SSE）；1 个修了 Windows 上十年拼写 bug 的 matcher（`method get`）；以及 1 个让 Admin API 终于返回合法 JSON 的 13 行修复。

**它同时是「AI 时代开源项目治理」的样本**：107 个 PR 里大量是 LLM 辅助的，维护者拒绝 75% 的安全报告是 slop，而项目的结构性回应是——**把默认值改严，把静默错误变成报错，让错误的配置在默认情况下不工作**。

这个思路值得每个写基础设施的人抄一遍。因为接下来两年，**「使用者行为分布被 agent 拉宽」这件事会发生在每一个系统上**，不只是 Web 服务器。

（本文所有数据点来自 Caddy v2.11.6 release notes（27 KB，107 PR）、以及 #7913 / #7787 / #7941 / #7859 / #7916 / #7873 / #7905 / #8009 / #8056 / #7809 / #7934 / #7952 / #7267 / #7847 / #7936 / #7886 / #7920 / #7832 的 PR body 与 v2.11.6 源码 `modules/caddyhttp/idletimeout.go` / `urlpatternmatcher.go`。17 维度对比表中 nginx / Envoy / Traefik / HAProxy 的默认值为官方文档公开值，未逐项跑实验，升级前请按第十节的 6 条硬指标自行复现。）

---
