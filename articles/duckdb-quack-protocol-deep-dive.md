---
title: "DuckDB Quack协议深度解读：嵌入式数据库如何优雅地走向分布式"
date: 2026-05-13
category: 技术
tags: [DuckDB, 数据库, 分布式系统, Quack协议, HTTP, 性能优化, 数据工程]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1544383835-bda2bc66a55d?w=600&h=400&fit=crop
---

# DuckDB Quack协议深度解读：嵌入式数据库如何优雅地走向分布式

2026年5月12日，DuckDB团队发布了一个令数据工程圈震动的消息——他们正式推出了Quack协议，一个让DuckDB实例之间可以互相通信的客户端-服务器协议。这意味着，曾经只能作为"嵌入式数据库"运行的DuckDB，现在可以像PostgreSQL那样以客户端-服务器模式工作了。

这个消息之所以重要，是因为DuckDB一直在嵌入式数据库领域做得风生水起，但"单进程独占"的架构限制了它的应用场景。Quack协议的出现，标志着DuckDB从"分析师的笔记本工具"正式迈入"现代数据架构的核心组件"。

## 从嵌入式到分布式：为什么DuckDB需要一个协议？

### 嵌入式架构的辉煌与局限

DuckDB自2019年发布以来，一直以"进程内数据库"（In-Process Database）自居。这种架构与SQLite类似——数据库引擎直接运行在应用程序进程中，通过函数调用而非网络协议来访问数据。这种设计带来了极低的延迟和极简的部署方式，特别适合数据科学场景中的交互式分析。

但问题也随之而来。当多个进程需要同时修改同一个数据库文件时，嵌入式架构就力不从心了。DuckDB在主内存中维护着大量状态——包括事务管理、缓存、查询执行的中间结果等。如果多个进程同时写入，这些内存状态就需要复杂的同步机制，这在技术上很难实现且性能代价高昂。

### 用户的"曲线救国"

面对这个限制，用户社区想出了各种各样的解决方案：

- **自建RPC服务**：在DuckDB实例前放一个代理进程，通过自定义的远程过程调用接口对外提供服务
- **Arrow Flight SQL**：使用Apache Arrow的Flight SQL协议为DuckDB加上网络访问能力
- **MotherDuck协议**：MotherDuck为自己的云服务开发了专属的客户端-服务器协议
- **EleDucken方案**：将DuckDB作为PostgreSQL的扩展运行（如pg_duckdb），借用PostgreSQL的网络栈

这些方案虽然各有所长，但都存在一个共同问题——它们是在DuckDB外部"打补丁"，而不是原生的解决方案。DuckDB团队观察到大量用户都在尝试为DuckDB加上客户端-服务器能力，这说明市场确实有这个需求。

## Quack协议设计哲学

### HTTP作为传输层

Quack协议最令人意外的设计决策之一，是选择HTTP作为传输层协议。在2026年的今天，这个选择看似保守，实则深思熟虑。

DuckDB团队认为，HTTP经过几十年的发展，整个网络基础设施栈都已经为它进行了深度优化。从负载均衡器到防火墙，从身份认证到入侵检测，所有中间件都原生支持HTTP。在此基础上构建数据库协议，可以"免费"获得这些能力。

更重要的是，HTTP允许DuckDB-Wasm（浏览器版本）原生支持Quack协议。这意味着运行在浏览器中的DuckDB实例可以直接连接到远程服务器上的DuckDB实例，这为Web应用开辟了全新的可能性。

### 自有的序列化格式

虽然Arrow Flight SQL已经是一个成熟的数据库协议，但DuckDB团队选择不使用它，而是开发自己的序列化格式。这个决定背后有深层的技术考量。

DuckDB内部使用自己的数据表示方式，虽然与Arrow在某些方面相似，但在其他方面有显著差异。如果采用Arrow作为协议格式，就意味着DuckDB的内部创新要受到外部格式规范的约束。DuckDB团队希望保持对数据类型和协议消息的完全控制权，以便快速迭代和实验新功能。

Quack使用MIME类型`application/duckdb`来编码消息，这个编码方式复用了DuckDB内部的高效序列化原语，这些原语已经在WAL（Write-Ahead Log）文件中经过多年的实战检验。

### 单轮往返查询执行

Arrow Flight SQL的一个设计缺陷是，每个查询至少需要两次协议往返（CommandStatementQuery和DoGet）。对于延迟敏感的小查询场景，这个开销是不可接受的。

Quack协议对此进行了专门优化——对于小查询，整个执行和结果返回可以在一次往返中完成。这个优化在高频小事务场景下带来了显著的性能提升。

## 安全模型：默认安全，可扩展认证

### 默认安全配置

DuckDB团队对安全问题保持了高度警惕。他们深知将数据库直接暴露在互联网上的危险性，因此Quack在默认配置下采取了多重防护：

1. **随机认证令牌**：服务器启动时自动生成随机token，客户端必须提供此token才能连接
2. **仅监听本地**：默认只绑定到localhost，不对外暴露
3. **非SSL默认**：因为默认是本地通信，不引入SSL的额外依赖
4. **客户端SSL检测**：对于非本地连接，客户端会自动假设需要SSL

对于需要对外暴露的场景，DuckDB团队强烈建议使用nginx等反向代理来终止SSL，而不是让DuckDB直接处理HTTPS。

### 可扩展的认证和授权

Quack的认证和授权系统设计得非常灵活。默认情况下：

- **认证回调**：比较客户端提供的token与服务器启动时生成的随机token
- **授权回调**：对所有查询请求都返回"允许"

但这两个回调都可以通过配置替换。你可以实现自定义的认证逻辑，比如查询LDAP目录、读取配置文件，甚至是纯SQL宏。授权回调可以检查每个查询的内容，根据认证信息决定是否允许执行。

这种设计体现了DuckDB一贯的"可扩展优先"哲学——提供合理的默认值，同时允许用户根据自己的需求进行定制。

## 性能基准测试

DuckDB团队在AWS的m8g.2xlarge实例（8 vCPU、32 GB RAM、最高15 Gbps网络带宽）上进行了两组基准测试，对比了Quack、PostgreSQL协议和Arrow Flight SQL。

### 批量传输性能

第一组测试是批量数据传输——将TPC-H lineitem表的不同行数从服务器传输到客户端。这个测试衡量的是协议在大数据量场景下的吞吐能力。

结果令人印象深刻：

- **6000万行数据**：Quack在不到5秒内完成传输
- **Arrow Flight SQL**：稍慢于Quack
- **PostgreSQL协议**：表现最差，因为其行级传输协议不适合批量场景

Quack能够实现如此高的吞吐量，得益于其并行传输能力——客户端可以从多个线程同时获取结果集的不同部分。

### 小事务吞吐量

第二组测试是高频小事务——每行数据单独INSERT，测试协议在延迟敏感场景下的表现。

这个测试中，Quack再次展现了令人惊讶的结果：

- **8线程并发**：Quack达到约5,500 TPS，超过了PostgreSQL
- **更高并发**：当线程数超过8时，DuckDB自身的并发写入限制成为瓶颈
- **Arrow Flight SQL**：表现最差，大约只有PostgreSQL的一半

Quack在小事务场景下超越PostgreSQL的关键在于单轮往返设计——每个INSERT只需要一次网络往返，而PostgreSQL的协议需要多次交互。

## 实际使用示例

### 基本的客户端-服务器设置

使用Quack协议的体验非常简洁。首先在服务器端启动Quack服务：

```sql
-- 服务器端 DuckDB 实例
INSTALL quack FROM core_nightly;
LOAD quack;

-- 启动Quack服务，默认端口9494
CALL quack_serve(
    'quack:localhost',
    token = 'my_secret_token'
);

-- 创建测试数据
CREATE TABLE users AS
    SELECT * FROM range(1000000) AS t(id);
```

然后在客户端连接：

```sql
-- 客户端 DuckDB 实例
INSTALL quack FROM core_nightly;
LOAD quack;

-- 配置认证
CREATE SECRET (
    TYPE quack,
    TOKEN 'my_secret_token'
);

-- 连接到远程服务器
ATTACH 'quack:localhost' AS remote;

-- 查询远程表
SELECT count(*) FROM remote.users;

-- 将远程数据复制到本地
CREATE TABLE local_users AS
    SELECT * FROM remote.users WHERE id < 1000;
```

### 浏览器到服务器的连接

由于Quack基于HTTP，DuckDB-Wasm可以直接连接到远程DuckDB服务器：

```javascript
// 在浏览器中使用DuckDB-Wasm
const db = await duckdb.createDuckDB();
await db.instantiate();

// 通过Quack连接到远程DuckDB
await db.query(`
    INSTALL quack;
    LOAD quack;
    CREATE SECRET (TYPE quack, TOKEN 'my_secret_token');
    ATTACH 'quack:my-server.example.com' AS remote;
    SELECT * FROM remote.analytics LIMIT 10;
`);
```

这种架构为数据密集型Web应用打开了新的大门——前端可以直接查询后端的DuckDB实例，无需额外的API层。

## 与其他方案的对比

### vs. PostgreSQL

PostgreSQL是最常用的客户端-服务器数据库。Quack在延迟和批量吞吐方面都有优势，但PostgreSQL在高并发写入场景下的扩展性更好。DuckDB团队也承认这是他们需要改进的方向。

对于已经使用PostgreSQL的团队，Quack提供了一个有趣的替代方案——如果你的工作负载更偏向分析查询而非事务处理，DuckDB+Quack可能是更好的选择。

### vs. Arrow Flight SQL

Arrow Flight SQL是一个通用的数据库协议标准，但DuckDB选择自建协议的原因在于：

1. **格式控制权**：DuckDB希望保持对内部数据表示的完全控制
2. **往返次数**：Arrow Flight SQL需要至少两次往返，Quack只需一次
3. **性能**：在基准测试中，Quack在两个场景下都优于Arrow Flight SQL

### vs. MotherDuck

MotherDuck是DuckDB的云服务版本，有自己的协议。Quack的优势在于它是开源的、标准化的，可以用于任何DuckDB部署场景，而不仅限于特定云服务。

## 未来展望

DuckDB团队对Quack的未来规划包括：

1. **DuckLake集成**：将Quack集成到DuckLake中，使DuckDB可以作为远程Catalog服务器
2. **DuckDB v2.0正式版**：计划在2026年秋季发布时，Quack将成为正式功能
3. **自动安装和加载**：改进用户体验，让Quack扩展在需要时自动安装
4. **协议扩展**：允许第三方扩展为Quack添加新的协议消息
5. **复制协议**：在Quack基础上构建数据复制功能，支持读副本集群

## 总结与最佳实践

Quack协议的发布标志着DuckDB进入了一个新的发展阶段。从"嵌入式分析工具"到"分布式数据基础设施组件"，DuckDB正在证明自己可以适应更广泛的应用场景。

对于技术团队，以下是一些使用Quack的最佳实践：

**适用场景**：
- 需要多个进程同时写入同一数据库的场景
- 数据密集型Web应用（通过DuckDB-Wasm）
- 需要集中化可观测性数据的场景
- 分析型工作负载需要网络访问的场景

**注意事项**：
- 不要将DuckDB Quack端点直接暴露在互联网上，使用反向代理
- 对于高并发写入场景，目前DuckDB自身还有瓶颈，需要关注后续版本的改进
- 选择合适的认证机制，不要使用默认的随机token在生产环境中

**性能调优**：
- 利用Quack的并行传输能力来加速大批量数据传输
- 对于小查询，确保使用默认的单轮往返模式
- 监控网络延迟，Quack的单轮往返设计对延迟敏感

DuckDB的创始人说过，他们将DuckDB视为"数据界的瑞士军刀"。Quack协议的出现，让这把军刀不仅能切菜，还能远程遥控厨房里的其他工具。在数据架构日益复杂的今天，这种灵活性和适应性正是开发者所需要的。

---

*相关阅读：*

- [DuckDB官方Quack协议文档](https://duckdb.org/2026/05/12/quack-remote-protocol)
- [DuckDB为什么选择In-Process架构](https://duckdb.org/why_duckdb)
- [Arrow Flight SQL规范](https://arrow.apache.org/docs/format/FlightSql.html)
