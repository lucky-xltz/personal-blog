---
title: 'DuckDB 出 Quack 了：把进程内数据库塞进客户端-服务器模型的工程革命'
date: 2026-06-06
category: 技术
tags: [DuckDB, Quack, 数据库, OLAP, 协议设计, HTTP, 数据架构, 性能优化]
author: 林小白
readtime: 13
cover: https://images.unsplash.com/photo-1544383835-bda2bc66a55d?w=600&h=400&fit=crop
---

# DuckDB 出 Quack 了：把进程内数据库塞进客户端-服务器模型的工程革命

DuckDB 团队在 2026 年 5 月 12 日悄悄扔出了一颗深水炸弹——**Quack 协议**，一个让多个 DuckDB 实例互相"嘎嘎叫"（quack）的客户端-服务器通信协议。387 个 HN 点赞、83 条评论，全部围绕一个核心问题展开：**一个原本是"嵌入式"、"进程内"标杆的 OLAP 引擎，为什么要做客户端-服务器？**

这听起来像是背叛。DuckDB 自 2019 年发布以来，"进程内"一直是它和 PostgreSQL/Snowflake 这些"远程数据库"最大的差异化武器。数据科学家在 Jupyter Notebook 里 `import duckdb`，直接对 Parquet 跑 SQL——没有客户端，没有协议，没有序列化开销，整个数据库在 Python 进程里就是几个 C++ 对象。

那 Quack 是什么？为什么 DuckDB 团队要花两年时间开发一个"对手"才需要的东西？答案藏在 HN 评论里一位 C++ 开发者的话里：

> "Everything is in memory during execution. Saved to disk between session as XML. Works great, except that that it is strictly single user..."

——单用户限制。这是进程内数据库的致命伤。

## 一、为什么"进程内"是蜜糖也是砒霜

### 1.1 SQLite 和 DuckDB 的反主流传统

数据库架构史的前 30 年只有一种模式：客户端-服务器。1980 年代 Sybase 把"数据库服务器"概念商业化后，所有数据库都默认带一个网络协议——客户端发 SQL、服务器解析执行、结果流回来。PostgreSQL 用自己的 wire protocol，MySQL 有 MySQL protocol，Oracle 有 TNS。

这种模式的优势显而易见：**单一可变状态**。所有写入都过服务器，服务器用锁和 MVCC 维护一致性，客户端只管发请求。代价是延迟——每一次查询都要走网络层、协议层、序列化层。

2000 年 SQLite 反其道而行：**整个数据库作为库链接到应用中**。没有服务器，没有协议，C 函数调用就是 API。这适合"应用内嵌数据库"的场景——手机 APP、浏览器、嵌入式系统。

DuckDB 在 2019 年把同样的哲学搬到了 OLAP 领域。传统 OLAP 引擎（Hive、Presto、ClickHouse）都跑在独立集群里，分析师通过 JDBC 提交查询；DuckDB 让你**在 Python 进程里直接对 100GB Parquet 跑 GROUP BY**——向量化执行引擎把 CPU 流水线打满，查询跑完数据科学家就拿到结果。

这就是"嵌入式 OLAP"的故事。

### 1.2 但"嵌入式"在某些场景下彻底失败

DuckDB 团队在 Quack 公告里承认了一件事：**当多个进程需要同时修改同一个数据库文件时，进程内架构搞不定**。

具体技术原因有两个：

1. **状态在内存里**：DuckDB 的查询优化器、buffer pool、catalog 缓存都驻留在进程内存。如果进程 A 插入一行，进程 B 不知道——必须重新打开文件、重读 catalog、刷新所有缓存。这种"重启-重读"在交互式分析里可以接受，在持续写入场景下完全不可行。

2. **写者必须互斥**：DuckDB 文件格式对并发写入不友好（不像 PostgreSQL 有 WAL 和 MVCC）。两个进程同时写会直接破坏文件。

现实里这些场景太常见了：

- 多个传感器采集进程同时往中心数据库写数据
- Web 后端的多个 worker 进程需要往同一张表插日志
- 一个 ETL 管道跑着，后台还有分析师在跑临时查询

DuckDB 团队原本的态度是"用 PostgreSQL 干这些事"，但用户硬是搞出了一堆 workaround：

- 自己写 RPC 包装 DuckDB
- 退到 Arrow Flight SQL（让 GizmoSQL 之类做服务器）
- 退到 MotherDuck（云服务，自有协议）
- 最极端的——**"EleDucken"**：在 PostgreSQL 里跑 DuckDB 扩展（pg_duckdb）

HN 上 rglover 总结得很到位：

> "This is rad. I've been eyeballing using DuckDB in my firm's internal app framework and this just solved the 'but how do I horizontally scale this' problem."

——Quack 解决了"横向扩展"这个老问题。

## 二、Quack 协议的核心设计

### 2.1 为什么选 HTTP

Quack 协议最反直觉的设计决策是：**基于 HTTP**。

> "It would be rather misguided not to build a database protocol on top of HTTP in 2026."

——DuckDB 团队在公告里这么说。

这条推文/评论下面的争议最大。批评者（如 HN 用户 ozgrakkurt）说：

> "HTTP is bad for transferring large amount of data and it is also bad for doing streaming. It is bad for large amount of data because you have timeout issues on some clients, you hit request/response size limits etc."

这个批评有道理——HTTP 在大文件传输和流式场景下确实不是最优解。但 DuckDB 团队的逻辑也站得住脚：

1. **HTTP 生态成熟到可怕**：负载均衡器、防火墙、入侵检测、身份验证网关、CDN——所有企业级基础设施都对 HTTP 友好。把 DuckDB 协议塞进 HTTP，企业网络能直接放行。
2. **DuckDB-Wasm 复用**：DuckDB 在浏览器里跑（用 WebAssembly），通过 HTTP 调远端 DuckDB 实例是天然的——跨域、跨协议、跨平台全打通。
3. **开销其实没那么大**：HTTP/2 和 HTTP/3 优化得很彻底，TLS 终止交给 nginx，业务层只管 SQL。
4. **延迟优化做得很深**：Quack 在已连接状态下，**单次查询只需要一次往返**——这是关键创新。传统数据库协议（如 PostgreSQL wire protocol）要解析、绑定参数、执行、获取结果，多次往返，延迟敏感场景吃亏。

Quack 用一个新的 MIME 类型 `application/duckdb` 编码消息，复用了 DuckDB WAL 文件里经过多年实战考验的序列化原语。如果明天 DuckDB 要加一个新数据类型或协议消息，**今天就能上线**——这是用 Arrow Flight SQL 时做不到的（Arrow 是外部标准，DuckDB 受制于人）。

### 2.2 鉴权与授权的极简设计

Quack 在鉴权上做了一个 DuckDB 风格的设计：**可插拔回调**。

服务器启动时自动生成一个随机 token，客户端连接时提供这个 token。服务器端的鉴权回调默认就是比较 token，但可以替换——你可以让它查 LDAP、读本地文件、甚至"掷骰子"：

```sql
-- 鉴权回调可以是 SQL 宏
CREATE MACRO check_auth(token) AS
  token IN (SELECT token FROM allowed_clients);
```

授权更简单。默认是"是"，你可以写一个函数检查每条 SQL 决定是否放行。这种"什么都靠回调"的哲学贯穿了 Quack 的设计——**不做大一统的鉴权框架，只给最小可用基线**。

> "We are likely unable to capture everyone's use case, certainly not in a first release. The smart thing is therefore not to try."

——不试图讨好所有人，让用户自己扩展。

### 2.3 默认端口 9494

1994 年 Netscape Navigator 发布——这就是 Quack 的默认端口。DuckDB 团队的命名品味从协议名（Quack）到端口号（9494）一脉相承：工程严谨 + 工程师幽默。

## 三、性能基准：5 秒传完 60 万行，8 线程 5,500 TPS

### 3.1 大批量数据传输

DuckDB 团队在 AWS `m8g.2xlarge`（8 vCPU、32 GB RAM、15 Gbps 网络、Arm 架构 Ubuntu）上做了两个基准测试。客户端和服务器在同一个可用区，ping 延迟 0.280 ms——典型的数据中心内通信。

**大批量读取**：传输 TPC-H lineitem 表的不同行数，比较 Quack、Arrow Flight SQL（用 GizmoSQL 实现）、PostgreSQL 协议的吞吐量。

| 行数 | DuckDB Quack | Arrow Flight | PostgreSQL |
|------|-------------|-------------|-----------|
| 100k | 0.07s | 0.07s | 0.20s |
| 1M | 0.24s | 0.38s | 2.20s |
| 10M | 0.89s | 2.90s | 25.64s |
| 60M | **4.94s** | 17.40s | 158.37s |

**60M 行传输，Quack 用 4.94 秒，PostgreSQL 要 158 秒**——32 倍差距。Arrow Flight SQL（为批量传输而生）也比 Quack 慢 3.5 倍。

DuckDB 团队解释了 PostgreSQL 落后的原因：标准 PostgreSQL 客户端**不并行化多线程读取**，而 Quack 和 Arrow 都可以。"无耻插播"：DuckDB 的 PostgreSQL 客户端在某些场景下也能并行化。

### 3.2 小事务写入

第二个基准测试小事务吞吐量——把 N 个线程同时往同一张表里插行，每个 INSERT 一个事务，跑 5 秒测每秒事务数。

| 线程 | DuckDB Quack | Arrow Flight | PostgreSQL |
|------|-------------|-------------|-----------|
| 1 | 1,038 tx/s | 469 tx/s | 839 tx/s |
| 2 | 1,956 tx/s | 799 tx/s | 1,094 tx/s |
| 4 | 3,504 tx/s | 1,224 tx/s | 2,180 tx/s |
| 8 | **5,434 tx/s** | 1,358 tx/s | 4,320 tx/s |

**这个结果很反常**。PostgreSQL 是事务型数据库，理论上应该碾压批量优化的 Arrow Flight——结果 Arrow Flight 确实被碾压了，但 Quack 反过来**比 PostgreSQL 还快**（1-8 线程全部领先）。8 线程时 Quack 跑 5,434 tx/s，PostgreSQL 是 4,320 tx/s。

但 PostgreSQL 超过 8 线程后继续线性扩展，Quack 在 8 线程后撞到 DuckDB 自身的并发插入瓶颈。DuckDB 团队承认这是未来要解决的核心问题——

> "PostgreSQL scales better here, which is something to look into for us in the near future."

公平地说，PostgreSQL 在高并发事务上经过 30 年调优，DuckDB 想正面硬刚还早。但 1-8 线程范围内 Quack 领先这个事实本身已经够震撼了——一个 OLAP 引擎的写入性能反超 OLTP 之王。

## 四、5 分钟上手：Quack 三步部署

让我们跑一个真实的 Quack 实例。

### 4.1 启动 Quack 服务器

DuckDB v1.5.2 已经在 `core_nightly` 仓库里发布了 Quack 扩展。先安装并启动服务：

```sql
-- 在 DuckDB #1 (服务器) 里
INSTALL quack;
LOAD quack;

CALL quack_serve(
    'quack:localhost',
    token = 'super_secret'
);
```

就这么简单。Quack 默认绑 localhost（更安全），随机 token 写日志。`quack_serve()` 是 DuckDB 风格——**协议也是 SQL 函数**。

### 4.2 客户端连接

在另一个 DuckDB 实例（不同进程、不同机器、不同终端都行）里创建 secret 并 ATTACH：

```sql
-- 在 DuckDB #2 (客户端) 里
INSTALL quack;
LOAD quack;

CREATE SECRET (
    TYPE quack,
    TOKEN 'super_secret'
);

ATTACH 'quack:localhost' AS remote;
```

`ATTACH` 把远程 DuckDB 实例挂载成一个 schema——这是 PostgreSQL 早就在用的模式。`remote` schema 下的所有表都是真实的远端表。

### 4.3 查询和写入

读取：

```sql
-- DuckDB #1 插入测试数据
CREATE TABLE hello AS
    FROM VALUES ('world') v(s);

-- DuckDB #2 远程查询
FROM remote.hello;
-- 输出: world
```

写入（自动复制到远程）：

```sql
-- DuckDB #2
CREATE TABLE remote.hello2 AS
    FROM VALUES ('world2') v(s);

-- DuckDB #1
FROM hello2;
-- 输出: world2
```

或者用 `query()` 函数直接把整段 SQL 推给远程执行（适合复杂查询、避免拉大量中间结果）：

```sql
-- DuckDB #2
FROM remote.query('SELECT s FROM hello WHERE s LIKE ''w%''');
```

**注意：客户端和服务器都是 DuckDB**。这意味着你可以在一个统一的环境里混用本地和远程表，SQL 解析器自动决定哪些计算本地做、哪些推到远程。这是 Quack 和"普通数据库客户端库"最大的区别——它不是 CLI 工具，是 SQL 一等公民。

## 五、为什么不是 Arrow Flight SQL？

DuckDB 团队在附录里专门回答了这个问题。Arrow Flight SQL 是 Apache Arrow 社区的官方协议，**有现成实现、有用户、有生态**——Quack 团队为什么还要造轮子？

三个原因：

1. **格式控制权**：Arrow 是外部标准，DuckDB 团队认为这是创新枷锁。"In order to be able to keep innovating in data systems, we cannot allow ourselves to be restricted by formats that are controlled externally."

2. **新数据类型的灵活度**：DuckDB 想加新类型（结构体、数组、map、union），用自家序列化"明天就能上线"，用 Arrow 要走社区 RFC。

3. **往返次数**：Arrow Flight SQL 的"致命设计决策"是**每个查询至少需要两次往返**——`CommandStatementQuery` + `DoGet`。这对小事务（如日志插入）是灾难。Quack 设计成"单次往返完成查询和结果拉取"。

> "Deep down, there is also one fateful design decision in Arrow Flight SQL: every single query requires at least two protocol round trips."

这不是说 Arrow Flight SQL 差——它在跨系统数据交换（ODBC/JDBC 的现代版）场景里很合适。Quack 是"为 DuckDB 量身定制"的协议，和通用的 Arrow 是两个不同的问题域。

## 六、Quack 在数据架构里的位置

### 6.1 与 DuckLake 的集成

DuckDB v1.5.2 同时发布了 **DuckLake v1.0 lakehouse 格式**——一个开放的数据湖格式。Quack 接下来会和 DuckLake 深度整合：**用远程 Quack 服务器作为 DuckLake 的 catalog server**。

这个组合拳解决了"数据湖的元数据放哪"的经典问题。传统方案是把 catalog 塞进 Hive Metastore 或 AWS Glue（重、慢、难调试），现在用 DuckDB 自身做 catalog 远程服务——轻、SQL 接口、嵌入式。

### 6.2 与"EleDucken"的关系

"EleDucken"是个社区梗：在 PostgreSQL 里用 pg_duckdb 扩展跑 DuckDB，享受"既有 PostgreSQL 的并发事务，又有 DuckDB 的 OLAP 加速"。Quack 发布后，社区立刻开始讨论：到底是 EleDucken 好，还是 Quack 单独部署好？

Quack 团队的判断很清楚——**两者解决不同问题**：

- EleDucken：想要一个数据库，SQL 接口既支持并发事务又支持 OLAP
- Quack：想要多个 DuckDB 实例互相通信，中心化状态管理

如果你的工作流里没有"必须用 PostgreSQL 兼容接口"的强约束，Quack 直接搞定。如果已经在 PostgreSQL 上有大量应用代码，EleDucken 是迁移成本更低的过渡方案。

### 6.3 边缘场景的胜利

Quack 真正闪耀的是"小团队内部工具"场景——HN 用户 NortySpock 的总结：

> "Sounds useful for small-ball internal analytics datasets you want to place on shared team server. I can definitely see exploring this for some homelab use."

以前 5 人数据团队的"内部分析数据库"选择是：

- 装个 PostgreSQL（重、需要 DBA）
- 共享一个 SQLite 文件（不行，会锁）
- 上 MotherDuck（云服务、收费、数据出境）

现在可以**在一台树莓派上跑 Quack 服务器，5 个分析师的工作站做客户端**。成本为零、延迟亚毫秒、数据不出内网。这是 Quack 真正的杀手锏——**它把"内嵌式 OLAP"的成本结构和"客户端-服务器"的协作能力结合在了一起**。

## 七、生产部署清单

Quack 还不是生产级（首个生产版本计划在 DuckDB v2.0，2026 年秋季），但可以在受控环境里用。部署时必须做以下事情：

### 7.1 永远不要直接暴露在公网

Quack 默认绑 localhost，**默认不启用 SSL**。这是有意的——本地通信加 SSL 是"纯粹为了仪式感"，但代价是一堆 OpenSSL 依赖。

如果必须暴露在公网（或跨公网），**用 nginx 做反向代理**：

```nginx
server {
    listen 443 ssl;
    server_name duckdb.example.com;
    
    ssl_certificate /etc/letsencrypt/live/duckdb.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/duckdb.example.com/privkey.pem;
    
    location / {
        proxy_pass http://127.0.0.1:9494;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        
        # 限制请求体大小（防止恶意大请求撑爆服务器）
        client_max_body_size 100m;
        
        # WebSocket 支持（Quack 流式结果）
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```

Quack 客户端默认对非本地连接启用 SSL，但可以在 secret 里关掉。**不要关**——除非你确定链路是隔离的。

### 7.2 Token 管理

默认的随机 token 在生产环境是不够的。建议：

```sql
-- 替换鉴权回调为从数据库读
CREATE MACRO quack_auth_check(token STRING) AS
  token IN (SELECT token_hash FROM quack_clients 
            WHERE expires_at > now() AND revoked = false);

-- 在启动时设置
CALL quack_serve(
    'quack:0.0.0.0:9494',
    auth_callback = 'quack_auth_check'
);
```

或者用一个**短期 JWT**——签发后 1 小时过期，载荷里带 client_id，服务器端用公钥验签。Quack 的回调机制让你可以塞进任何你喜欢的鉴权策略。

### 7.3 监控

Quack 是 HTTP，**Prometheus + Grafana 抓 nginx 的访问日志就行**。需要监控的指标：

- 活跃连接数（nginx `connections`）
- 请求延迟（按 endpoint 分组）
- 错误率（4xx/5xx 比例）
- 出入流量（避免压满网卡）

如果想监控 DuckDB 层的状态，**开个 `duckdb -ui` 端口**——DuckDB v1.5 自带 Web UI（926 个 HN 点赞的功能），可以看到当前查询、内存使用、catalog 状态。

## 八、Quack 的局限与未来

### 8.1 当前限制

- **8 线程后并发写入撞墙**：DuckDB 单表并发插入的物理极限，1-8 线程范围内 Quack 5,400 tx/s 已经很猛，但超过 8 线程就上不去了。Quack 团队明确说这是"未来要解决的核心问题"。
- **跨 DuckDB 版本的兼容性**：Quack 协议本身可能有版本演进，不同版本混用需要明确。DuckDB 团队计划在 v2.0 之后做正式语义版本控制。
- **没有内建复制**：现在 Quack 是单服务器模式，没有原生主从复制。HN 用户 `timsuchanek` 的评论是"now we just need this for Postgres as well"——他们已经在想 Quack for Postgres 的扩展。
- **鉴权是回调，不是一等公民**：生产级数据库通常需要细粒度权限（按表、按列、按行）。Quack 的回调机制给你自由度，但你自己要写代码。

### 8.2 路线图

DuckDB 团队在公告结尾透露了几个明确方向：

1. **DuckLake catalog server 集成**（2026 年夏季）
2. **Quack v1.0 随 DuckDB v2.0 发布**（2026 年秋季）
3. **扩展协议**：允许 DuckDB 扩展添加新的协议消息（这才是 Quack 真正的可扩展点）
4. **复制协议**：在 Quack 之上构建主从复制、读副本集群
5. **提升单表并发写入**：8 线程瓶颈

2026 年 6 月 24 日的 DuckCon #7 会有"State of the Duck"主题演讲，Quack 的初期采用案例会公布——值得一追。

## 九、给开发者的实操建议

### 9.1 不要立即替换 PostgreSQL

如果你现在的 PostgreSQL 跑得好好的，**不要因为 Quack 而迁移**。Quack 的优势场景是"内嵌 OLAP + 轻量中心化"，不是"替代 OLTP 主数据库"。

合理的使用模式：

- **观测数据汇聚**：多个进程往中心 Quack 写 metrics/traces/logs
- **内部团队分析**：5-20 人的数据团队共享一个分析数据库
- **ETL 中间层**：从 PostgreSQL 抽数据到 Quack 做分析，写回结果
- **边缘/IoT**：树莓派集群每台跑 Quack 客户端，中心节点做汇总
- **浏览器-服务器**：DuckDB-Wasm 通过 Quack 直接连远端，零配置

### 9.2 关注 DuckLake 而非 Quack

DuckDB 团队自己说，Quack 让他们"鸭生了新层次的使用场景"，但真正改变游戏的是 **DuckLake + Quack 的组合**。DuckLake 是开放 lakehouse 格式（类似 Iceberg 但更简单），Quack 是它的元数据服务。两者结合等于"开源 Snowflake 替代品"——这个故事比 Quack 单独看大得多。

### 9.3 学习成本接近零

如果你已经会 DuckDB 的 SQL 和 Python API，Quack 的学习曲线是：

- 读 5 分钟公告：理解协议
- 跑 5 分钟例子：两个终端各开 DuckDB
- 写 10 行配置：起 Quack 服务器

实际生产部署（鉴权、nginx 代理、监控）再加 1-2 小时。**这是 2026 年最容易"搞出新东西"的数据库协议**。

## 十、总结

Quack 协议的本质不是技术突破，而是**承认了一个事实**：进程内数据库和客户端-服务器数据库不是非此即彼——它们是同一个连续光谱上的两个端点。DuckDB 在 2019 年选了"进程内"那一端，2026 年用 Quack 把自己推向了光谱中央。

60M 行 4.94 秒、8 线程 5,400 tx/s、单次往返完成查询、HTTP 兼容、自动鉴权回调——这些不是"足够好"，是"比现有的都好"。

更重要的是哲学：**不做大一统，不限制用户**。Quack 的鉴权可以挂任何东西，它的扩展可以加任何东西，它的数据格式是自家的、不受外部标准约束。这种"工程上严格，架构上开放"的态度，是 DuckDB 过去 7 年成功的原因，也是 Quack 未来成功的原因。

如果你今天在考虑"我们的内部数据基础设施该往哪走"，Quack + DuckLake 是 2026 年最值得花 4 小时研究的组合。

---

*相关阅读：*

- [TypeScript 7 即将到来：微软把编译器从 TypeScript 移植到 Go 的 10 倍性能革命](/article/typescript-7-go-port-10x-compiler-2026) — 另一个"用正确语言重写"的工程故事
- [WebAssembly 终于要变"一等公民"了：Component Model 如何终结 9 年的 JS 胶水代码尴尬](/article/webassembly-first-class-component-model-2026) — 浏览器端的 DuckDB-Wasm 即将借助 Component Model 发挥威力
- [NBD-VRAM 的 Linux 内存分层实战](/article/nbd-vram-linux-memory-tiering) — 同样是"让进程内访问远端资源"的工程哲学
