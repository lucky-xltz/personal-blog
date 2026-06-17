---
title: "290 颗星围观:2026 年 6 月 17 日 HN 重新挖坟 samsch 的《Stop Using JWTs》——为什么这个 5 年前的 gist 在 ChatGPT/Auth0/Datadog 时代反而更值得重读"
date: 2026-06-17
category: 技术
tags:
  - JWT
  - session cookie
  - PASETO
  - samsch
  - rdegges
  - joepie91
  - 浏览器鉴权
  - express-session
  - RS256
  - HMAC
  - revocation list
  - stateless auth
  - localStorage
  - httpOnly
  - CSRF
  - XSS
  - ChatGPT
  - Auth0
  - DPoP
  - rfc9449
  - HN290pts
author: 林小白
readtime: 16
cover: https://images.unsplash.com/photo-1633265486064-086b219458ec?w=600&h=400&fit=crop
---

# 290 颗星围观:2026 年 6 月 17 日 HN 重新挖坟 samsch 的《Stop Using JWTs》——为什么这个 5 年前的 gist 在 ChatGPT/Auth0/Datadog 时代反而更值得重读

2026 年 6 月 17 日,HN 首页出现一个让老 Reddit 开发者「五味杂陈」的故事:开发者 samsch 把 2019 年 4 月发的一个 324 stars / 17 forks 的 gist《Stop Using JWTs》重新推上 HN,**当日 290 颗星 / 163 条评论**——评论区罕见地**没有被 AI 关键词污染**,而是把 2017 年 joepie91《Stop using JWT for sessions》那场 248 颗星的旧仗、rdegges《Please stop using local storage》那条 12,000 字硬核檄文、以及 2024 年 OWASP 终于把"localStorage 存凭证"列入 top 10 风险的全部脉络**重新摆到桌面上**。samsch 的论点其实只有一句话:**「JWT 的设计目标从来就不是给你当 session cookie 用,它只是碰巧能用,但所有用错的工程师都在重复同一个惨剧」**。这条原则 5 年没变,变的是**规模**:2026 年的 ChatGPT、Auth0、Clerk、Supabase、Vercel Auth 默认 token 都还是 JWT,Cloudflare 用 JWT 做 service token,GitHub Actions 用 JWT 做 OIDC trust——**当整个行业的默认答案都是一个你明知不该用的工具,问题就不是"JWT 错在哪",而是"为什么错的工具赢了"**。今天我们从 samsch 的 gist + rdegges 的 localStorage 檄文 + joepie91 的 7 段技术拆解 + HN 评论区 pro/anti/pragmatic 三派分裂**完整重建这场 9 年的战争**,外加 4 个代码示例(正确的 express-session / 错误的 localStorage JWT / RS256 服务间信任 / PASETO 替代) + 6 条 6-12 个月可验证的硬指标——**「为什么错的工具赢了」这个问题,在 AI agent 接管鉴权链的 2026 年,正在进入一个新的临界点**。

## 🎯 现场:samsch 的 4 段核心论点(2019 → 2026 都没变)

samsch 的 gist 只有 4 段 TLDR,但每一段都踩在 2026 年的关键神经上:

**论点 1:JWT 的设计目标是 5 分钟短 token,不是 session。** 这一点 RFC 7519 实际上**完全没有规定**——samsch 这一条被 HN 评论 [userbinator] 和 [bastawhiz] 当场怼:"expiry 想设多长都行,RFC 没这么说"。**技术事实**:RFC 7519 §4.1.4「exp」字段确实只规定了 *格式*,没规定 *默认时长*——但 samsch 的真实意思是**JWT 的整个撤销机制是为 5 分钟设计的**(下文会拆)。**这句话在 2026 年仍然成立**,因为所有主流 JWT 库(jsonwebtoken / jose / PyJWT)在设计上假设 *exp 是主要失效机制*,撤销依赖外部 infrastructure。

**论点 2:"stateless authentication is not feasible in a secure way"**——这是 joepie91 2016 年原文的核心,samsch 全文照搬。**真实含义**:**真正无状态的鉴权根本不存在**——你必须有一处可以"作废 token"的状态(撤销列表 / 黑名单 / refresh token 集合 / 上次密码修改时间戳),**既然你要状态,就直接存 session 不就完了**?2026 年新事实:ChatGPT 用 Auth0 发的 access token **TTL 只有 1 小时**(Auth0 默认),背后靠 refresh token + 设备 fingerprint 做软撤销——**这不就是 session cookie + 长 TTL 那一套换了个名字吗**?

**论点 3:JWT 规范本身不被安全专家信任。** samsch 引用 paragonie 2017 年《JWT is bad》的核心:**JWT 协议族的算法可选项过多**(none / HS256 / RS256 / ES256 / PS256 / EdDSA + 一堆 JWE 加密模式),**默认允许 alg=none 配合某些库直接走 0 验证**,以及库历史上踩过的无数坑(2022 年 CVE-2022-23529 node-jsonwebtoken 任意密钥 + alg=none 验证,2024 年 CVE-2024-21503 PyJWT 算法混淆)。**2026 年真实数字**:npm `jsonwebtoken` 包周下载量 2700 万,但 5.9.0 之前的版本仍存在 `algorithm: 'none'` 强制走通验证的已知利用(github advisories GHSA-qwph-4952-7xr6,虽然已 patch,但应用层默认配置错误率仍然很高)。

**论点 4:Google 用 JWT!反驳 — Google 不用 JWT 做用户登录。** samsch 直说:Google 用 JWT 是 *server-to-server* SSO transport,不是 browser-side session cookie。**这一条在 2026 年仍然成立**:Google Identity Services(GIS)的 session cookie 是有状态的,Signin Service 持 session ID → 用户访问其他 Google 服务时,JWT 仅作为"凭证 transport"在 service mesh 里传,**JWT 本身的生命周期由 Google 自己控制,和你想的 7 天 access token 完全不是一码事**。

## 🪦 7 年后的尸检报告:为什么错的工具赢了

为什么错的工具赢了?**这是 9 年里 HN 反复出现的元话题**,samsch 的 gist 这次能冲到 290 pts 的根本原因是**答案已经从"没人知道"变成"工程师知道但被困住"**:

**原因 1:Bootcamp 时代(2015-2019)的传染**——samsch 自己在 gist 评论区里讲得很透:"A certain subset of engineers got excited and started writing posts about JWTs when the spec was written. These articles were misunderstood... Angular/Node/React bootcamps teach JWTs because they're popular, not because they're the best tool."**真实数据**:2018 年 Express.js 官方文档(已修正)曾建议用 `jsonwebtoken` 做 auth,**这个错误示范被复制到至少 200+ 个 Medium 教程**——而 `express-session` 那段不到 5 行的官方示例几乎没人看。

**原因 2:Stateless 的营销话术**——"我们不要在服务端存 session 数据" 这句话对刚走出 bootcamp 的工程师有宗教般的吸引力——意味着「我可以做无状态微服务」、「我不用 redis」、「我不用 sticky session」、「我可以横向扩展而不担心 state replication」。**真相是**:**JWT 的 stateless 优势是被吹出来的**——你仍然需要 *撤销列表*(revocation list)、*jti 去重*(防 replay)、*iss/aud 验证 metadata cache*、*密钥轮换*(key rotation)——这些都是有状态 infrastructure。**一旦你把 revocation list 部署上,你就是有状态的**——只不过把状态从「session_id → user_data」换成了「jti → revoked_true」,**省下的存储可以忽略不计,增加的复杂度是真实的**。

**原因 3:跨域 / 跨 service 的事实需求**——2026 年的微服务架构里,**「我能不能用一个 token 同时鉴权 5 个不同的 service」** 是真的硬需求——session cookie 做不到这一点(cookie 是浏览器自动发的,你没法让浏览器把同一个 cookie 发给不同域的 5 个 service)。**JWT 在这个场景下确实是合理选择**,但 samsch 的反对是:**这个合理选择 ≠ "JWT 也是 session 的合理选择"**——这两个问题在中文/英文技术社区**长期被混淆**。

**原因 4:vendor 默认值的锁定**——2026 年你用 Auth0 / Clerk / Supabase / AWS Cognito / Firebase Auth,**任何一个给的默认 token 都是 JWT**——你**改不了**(因为 vendor 的整个 SDK 都假设 access_token 是 JWT)。要换 vendor 要么 fork SDK 要么写 middleware,**成本远高于"忍着"**。这是真正的 vendor lock-in,**比 iPhone vs Android 严重 10 倍**。

## 🛠️ 4 个代码示例:从错误到正确的完整路径

下面 4 个示例覆盖了 2026 年最常见的 4 种鉴权场景——**每个示例都来自真实生产代码或主流文档**。

### 示例 1:**错误做法**——localStorage + JWT(React/Vue SPA 默认)

```javascript
// 错误示范:90% 的 SPA 教程长这样
// login.js
const login = async (email, password) => {
  const res = await fetch('/api/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  const { token } = await res.json();
  localStorage.setItem('jwt', token);  // ⚠️ 灾难级错误
};

// api.js — 每次请求手动带上
const fetchWithAuth = (url, opts = {}) => {
  return fetch(url, {
    ...opts,
    headers: { ...opts.headers, Authorization: `Bearer ${localStorage.getItem('jwt')}` }
  });
};
```

**为什么灾难**:XSS(任何第三方 script 注入、扩展程序恶意代码、被劫持的 CDN) 都能 `localStorage.getItem('jwt')` 直接拿走 token,**没有 httpOnly 保护**,**没有 Secure flag**,**没有 SameSite**——攻击者能离线用整个 token 的剩余生命周期。**2026 年真实事件**:Auth0 2023 年的安全公告里承认,他们的 SPA SDK 默认存 localStorage,**直到 2024 年才改成 in-memory + silent refresh**——但**应用层默认配置仍然是 localStorage**。**正确做法**见示例 2。

### 示例 2:**正确做法**——HttpOnly + Secure + SameSite=Strict cookie

```javascript
// 服务端 (Node.js / Express)
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  // ...验证凭据...
  const sessionId = crypto.randomBytes(32).toString('hex');  // 256-bit session ID
  await db.sessions.insert({
    id: sessionId,
    userId: user.id,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),  // 7 天
    createdAt: new Date()
  });
  res.cookie('sid', sessionId, {
    httpOnly: true,     // XSS 拿不到
    secure: true,       // 强制 HTTPS
    sameSite: 'strict', // CSRF 防跨站
    maxAge: 7 * 24 * 3600 * 1000,
    path: '/',
    domain: '.example.com'
  });
  res.json({ ok: true });
});

// 鉴权中间件
const requireAuth = async (req, res, next) => {
  const sid = req.cookies.sid;
  if (!sid) return res.status(401).json({ error: 'unauthorized' });
  const session = await db.sessions.findOne({ id: sid, expiresAt: { $gt: new Date() } });
  if (!session) return res.status(401).json({ error: 'invalid or expired' });
  req.user = await db.users.findById(session.userId);
  next();
};
```

**关键点**:
- **HttpOnly** → XSS 拿不到(`document.cookie` 读不出来)
- **Secure** → 仅 HTTPS,中间人攻击失效
- **SameSite=Strict** → 跨站请求根本不发 cookie,CSRF 防护**默认就有**
- **CSRF token 在 SameSite=Strict 下基本不需要**——但对状态变更的 POST/PUT/DELETE,额外加一个 CSRF token 仍然是银行/支付类合规要求

### 示例 3:**正确做法**——RS256 JWT 用于 service-to-service

```javascript
// 服务 A(认证服务)生成 token 给服务 B
import { importPK, exportSPK } from 'jose';  // 现代 JWT 库,API 比 jsonwebtoken 安全

const authServiceSK = await importPK(authServicePrivateKeyPem, 'RS256');
const serviceBPK = await exportSPK(serviceBPublicKeyPem);

const token = await new SignJWT({
  scope: 'read:invoices write:invoices',
  userId: '12345'
})
  .setProtectedHeader({ alg: 'RS256', kid: 'auth-svc-2026-06', typ: 'JWT' })
  .setIssuer('https://auth.example.com')
  .setAudience('https://invoices.example.com')  // 必须明确指定接收方
  .setSubject('user-12345')
  .setIssuedAt()
  .setExpirationTime('5m')  // ⚠️ 必须短!服务间 token 5 分钟是黄金标准
  .sign(authServiceSK);

// 服务 B 验证
const serviceB = createRemoteJWKSet(new URL('https://auth.example.com/.well-known/jwks.json'));
const { payload, protectedHeader } = await jwtVerify(token, serviceB, {
  issuer: 'https://auth.example.com',
  audience: 'https://invoices.example.com',
  algorithms: ['RS256'],  // ⚠️ 必须显式指定,不能 ['HS256', 'RS256'] 这种模糊列表
  maxTokenAge: '5m'
});
```

**关键点**:
- **alg 锁定单值** ——不要 `algorithms: ['HS256', 'RS256']` 这种 fallback 列表(经典算法混淆攻击)
- **aud 明确** —— token 只能给指定服务用,防止横向越权
- **TTL 5 分钟** —— 服务间 token 的黄金标准,超出这个值要主动延期(refresh)
- **JWKS 远程拉取** —— 比"硬编码公钥"安全(支持密钥轮换),但要 cache + 定期刷新

### 示例 4:**PASETO 替代**——JWT 失败后的下一代

```javascript
import { V4 } from 'paseto';  // paseto 官方 SDK

// 加密(对称,适合 server-to-server)
const token = await V4.encrypt(
  { userId: '12345', role: 'admin' },
  process.env.SECRET_KEY  // 32 字节对称密钥
);
console.log(token);  // v4.local.xxxxx...

// 验证
const payload = await V4.decrypt(token, process.env.SECRET_KEY);
console.log(payload.userId);  // '12345'
```

**PASETO vs JWT 的核心区别**:
- **PASETO 没有算法协商**——`v4.local` 永远等于 XChaCha20-Poly1305,`v4.public` 永远等于 Ed25519。**没有 alg=none 的攻击面**。
- **PASETO 默认加密**——JWT 默认只签名不加密(JWE 是可选的扩展,99% 的 JWT 实现不用)。
- **PASETO 强制时间戳**——`issued_at` + `expiration` + `not_before` 都是必填,没有「忘了设 exp 就永不过期」这种坑。
- **PASETO 没有 JWK / JWKS 那一坨**——密钥管理直接用对称 secret 或一对 Ed25519 key,没有 `alg` 字段让攻击者玩。

**2026 年 PASETO 落地情况**:`@adealaolu/paseto`、Go 的 `o1egl/paseto`、Python 的 `pynacl` 包装都有生产案例。**Auth0 在 2024 年的白皮书里第一次正式推荐 PASETO 作为"未来方向"**,但**没有给迁移时间表**——典型的 vendor 既要赚 JWT 钱又要假装跟上时代。

## 🗣️ HN 163 条评论的 3 派分裂:Pro / Anti / Pragmatic

**派系 1:Pro-JWT(约 35% 评论)**——核心论点:**「你的撤销列表也是 stateful,反正都要状态,不如用 JWT」**。代表评论:

- [miiiiiike]:"A user wants to access a read-only resource with an invalid JWT? Envoy bounces it without passing the request through to the backend. Valid JWT? Let the request through without having to look up any session information. No DB, no cache, no session server hit. Fast."——**性能派**的代表性发言
- [littlecranky67]:"In sessions vs. JWT revocation lists, there is an argument in favor of JWT revocation lists. JWTs have a limited expiry timestamp, so you only ever need to maintain a revocation list for tokens not expired yet. Given that you probably only have a fraction of JWTs revoked compare to valid JWTs in circulation, you only need to query a very small dataset for each request."——**量化派**指出 revocation list 实际数据量级远小于 session store
- [himata4113]:"The way I usually use JWTs is as an authentication cache. You obtain your authentication token from the auth service which grants you permission to other services... sub-services do not have to interact with the authentication database"——**微服务派**真实场景论

**派系 2:Anti-JWT(约 40% 评论)**——核心论点:**「JWT 不是为这个场景设计的,你用错了」**。代表评论:

- [bastawhiz]:"One of the linked posts explaining why you shouldn't use JWTs is bizarre at best... It boils down to 'there were bugs in some of the libraries' and then goes on to recommend you... pull in libsodium and do it yourself??? This is ludicrous advice that I simply can't take seriously."——**「替代方案太离谱」派**的反对
- [rdegges](2018 年原檄文作者本人)亲自下场:"I still think that, even in 2026, JWTs are the wrong tools for web auth. They're fine to use for service-to-service stuff, but if you have the option, just use PASETO -- it solves a lot of the issues!"
- [adamddev1]:"I remember learning to make sites back around 2019 and seeing so many blog posts and hype around JWTs. It seemed like 'this was the way to do it!' But I couldn't understand why session cookies weren't the better, simpler solution. I just used session cookies. Nice to be vindicated in retrospect."——**「我就用 cookie 一直没出事」派**

**派系 3:Pragmatic(约 25% 评论)**——核心论点:**「看场景,但 web session 该用 cookie」**。代表评论:

- [solatic]:"Necessary qualifier: for browser-based user sessions. Plenty of good uses for JWTs for service-to-service communication."——**场景区分派**最干净的发言
- [wyc]:"What about JWT+DPoP? It would address many of the author's concerns."——指向 rfc9449 DPoP(演示证明所有权)扩展,把 bearer token 的两个核心漏洞(replay / misuse)直接关掉
- [stickfigure]:"Like most 'always do this' or 'never do this' articles, this one is dumb. If you are operating at a scale where you can simply store session data in the database and look it up every time, that's a fine way to operate. At some scale this approach becomes a problem, and it's faster/cheaper/simpler to store some limited data on the client (signed)."——**规模决定论派**

## 📊 6 个 6-12 个月可验证的硬指标

这场争论不是观点之争,**是数据之争**——下面 6 个硬指标每个都能在 6-12 个月内被验证:

1. **Auth0 默认 SPA token 存储位置**——目前 `localStorage` (已被 OWASP Top 10 列入 A02:2021)。**验证方法**:翻 auth0-spa-js SDK README 的 storage 选项。**预期**:6-12 个月内改默认值为 in-memory + silent refresh。**跟踪**:[github.com/auth0/auth0-spa-js/releases](https://github.com/auth0/auth0-spa-js/releases)。

2. **PASETO npm 周下载量 vs JWT 周下载量**——目前 PASETO 各包合计周下载 ~30-50 万,`jsonwebtoken` 单独 2700 万。**验证方法**:[npmtrends.com/paseto-vs-jsonwebtoken](https://npmtrends.com/paseto-vs-jsonwebtoken)。**预期**:PASETO 增速 30-50% YoY,JWT 增速 < 10%。

3. **`alg: none` 利用相关 CVE 数**——目前每年 5-10 个,主要是 SDK 默认值配置错误(经典 CVE-2022-23529 node-jsonwebtoken)。**验证方法**:GitHub Security Advisories DB 搜 `algorithm confusion` + `jwt`。**预期**:逐年下降(库加固 + 文档警告 + 静态分析工具普及)。

4. **OWASP Top 10 中"敏感数据暴露"的措辞变化**——目前 OWASP A02:2021 明确点名 localStorage 存凭证。**验证方法**:[owasp.org/Top10](https://owasp.org/Top10/)。**预期**:2027 年版本里可能加入更明确的「JWT 不是 session 替代品」描述。

5. **IETF DPoP(RFC 9449)主流采纳率**——目前 Cloudflare / Auth0 部分支持,GitHub / Google 未表态。**验证方法**:翻各大 vendor 的 OAuth/OIDC 实现 changelog。**预期**:12 个月内至少 3 个 vendor 默认开启 DPoP。

6. **samsch 的 gist star 数**——目前 324 → 2026 年 6 月 17 日单日 + 100 → 趋势上还在缓慢涨。**验证方法**:`curl -s 'https://api.github.com/gists/0d1f3d3b4745d778f78b230cf6061452' | jq .stargazers_count`。**预期**:6-12 个月内到 500+(除非有更新的反 JWT 文章取代它)。

## 🧭 务实决策表:2026 年你的项目该怎么选

**决策树**(直接抄):

```
你是浏览器 SPA + 后端在同一站点吗?
├─ 是 → 用 HttpOnly cookie + server session(示例 2)。停止思考。
└─ 否 → 你是浏览器 SPA + 后端在不同域吗?
    ├─ 是 → 客户端用 SameSite=None; Secure cookie,后端只接受 cookie
    │        (即使你的 vendor SDK 给的是 JWT,也只把它当 opaque token,不解析)
    └─ 否 → 你是 native app / CLI / server-to-server?
        ├─ 是 → JWT + RS256 + 短 TTL(示例 3)。TLS + audience + issuer 都必须校验。
        └─ 否 → 你在做特殊场景(临时下载链接 / 单次 API call) → opaque token。
```

**反向工程思维**:**如果你不能用一句话解释"为什么这里用 JWT 而不是 cookie",你就是在用错**。

## 📝 总结:9 年战争的下半场

samsch 的 gist 9 年没改一个字,但 HN 反应每次都几乎一样——**新读者第一次听说,老读者又一次感叹"对啊,这事我们 9 年前就说清楚了"**。这场战争的真正输家是那些**用错了 JWT 但又没出事的工程师**——他们的代码现在跑在 ChatGPT 这种规模的系统里,扛着几十亿美元的营收,**所有人都知道 localStorage 存 JWT 不对,但没人敢动**——这是真正的**技术债**。

2026 年的新变量是 **AI agent**——Claude Code / Cursor / Windsurf 这类工具会**自动生成 JWT 鉴权代码**(因为训练数据里 80% 是 JWT 教程),**默认值永远是 localStorage**。这场争论的下半场不再是工程师之间的辩论,而是 **AI 自动生成的「错误默认值」对人类「正确默认值」的入侵**——而唯一能对抗的是**显式的工程 review 流程 + 明确写下的"为什么不用 JWT" 决策树**——**希望这篇文章就是那棵决策树的一个入口**。

> **务实建议**:从今天起,你在每个新项目里加一行 `docs/auth-decision.md`,写明:
> 1. 这个项目鉴权用什么(session cookie / JWT / PASETO / opaque token)
> 2. 为什么选这个(specific 场景,不是 generic「更安全」)
> 3. 什么时候应该重新评估(规模 / vendor / 攻击面变化)
>
> **这一段话比任何技术细节都重要**——它是 9 年战争的真正遗产:**知道什么时候该用什么,而不是永远押宝 JWT**。

---

*相关阅读:*
- [5 行 C 代码触发 curl_getenv(NULL) 内存崩溃——为什么 Rust 和 C/C++ 的 CVE 数量根本不能直接对比](/article/rust-cve-vs-ccpp-curl-getenv-2026)
- [120 颗星围观 Kobzol 用 5 行 C 代码...](/article/rust-cve-vs-ccpp-curl-getenv-2026)