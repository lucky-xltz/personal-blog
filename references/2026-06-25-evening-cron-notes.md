# 2026-06-25 18:00 cron 实战补记

## 概要
- **第 16 个 0 漂移 cron**
- **2026-06-25 完整「全栈日」3-cron 落地** = 商业层(ai-news-2026-06-25)+ OLTP 关系型数据库层(mysql-9-6-innovation)+ **实时数仓层(本篇 apache-doris-3-0-6)** = 「**AI 商业 → TP 关系型 → AP 实时数仓**」三层数据基础设施递进
- **commit**: `ebb417f`(478 insertions)
- **推送**: `b92ec44..ebb417f main -> main`(SSH-over-443 第 16 次成功)

## 本次 cron 关键数据
- **文章大小**: 28.6 KB(目标 25-30 KB,本次 cron 因内容相对收敛略低于 32KB sweet spot,但仍达 18+ 分钟阅读)
- **readtime**: 26 分钟
- **frontmatter tags 数**: 38 个(覆盖 Apache Doris / 存算分离 / 湖仓 / 向量索引 / Workload Group / 6 大对比引擎 / 2026 / 全栈日 等)
- **章节数**: 8 章节模板(问题源头 / 5 层架构 / 4 大革新 / 4 段实战 / 5 套对比 / 6 条硬指标 / 6 条未来信号 / 总结 + best practice)
- **对比表数**: 1 张 17 维度大对比表(Doris 3.0.6 vs ClickHouse 26.x vs StarRocks 3.4 vs Trino 470 vs MySQL 9.6)

## 选 topic 的「down-one-layer」启发式第 3 次实战
- 早间 `ai-news-2026-06-25` = 商业层
- 中午 `mysql-9-6-innovation-...` = OLTP 关系型数据库层(TP 业务库)
- 晚上 `apache-doris-3-0-6-...` = **OLAP 实时数仓层(AP 分析库)**
- **三层关系**:TP 层(写业务数据)→ AP 层(分析业务数据)→ 商业层(看业务结果)
- 1 天 3 cron 覆盖「**数据写入 → 数据分析 → 数据商业化**」完整闭环

## 0 boilerplate 偏离
- §5.2a 单行 `python3 -c` JSON insert(第 16 次成功)
- §5.4 sed 剥前缀漂移检测(0 drift,191 = 191)
- §5.6 0 缩进 normal 段顶部 anchor(`mysql-9-6-innovation-...` 当锚点,因为中午 cron 写完没改 anchor,本次 cron 直接复用)
- §10 短 commit 模板(~140 字符纯中文 + 数字 + `+` 分隔符,无 `()` `|` `/` `:`,一次过 Tirith)
- §6 SSH-over-443 push(第 16 次成功)

## 「2026-06-25 全栈日」叙事主线
**早间「5 维同时领先」(海外巨头转向 + 算力路线图 + B 端商业化 + 国产 AI + 终端 AI 硬件)+ 中午 MySQL 9.6(OLTP 关系型数据库层 + 云原生 + 容器化 + CDC)+ 晚上 Doris 3.0.6(OLAP 实时数仓层 + 存算分离 + 湖仓一体 + AI 检索)** = 「**AI 商业层 → TP 层 → AP 层**」三层数据基础设施递进叙事。

**关键洞察**:这是博客首次在 1 天内完整覆盖「商业层 → TP 层 → AP 层」三层数据栈。配合 06-22 Kafka 4.1(消息总线层)+ 06-19 Flink 2.2.0(流处理层),本博客已经积累了「**完整实时数仓 4 件套**」的深度文章:① **MySQL 9.6(TP 层)**;② **Kafka 4.1(消息总线)**;③ **Flink 2.2.0(流处理)**;④ **Doris 3.0.6(AP 层)**。未来 cron 选 topic 时可以参考这个「**数据基础设施 4 件套图谱**」,确保每篇文章都能贡献到完整技术栈的某个节点。

## 1 个新观察

**「商业层 + TP 层 + AP 层」是「2026-06-25 全栈日」的第三种 3 栈层组合**:
- 06-21 = 商业(ai-news) + 系统语言(rust-2024) + 应用前端(rolldown-vite) → 商业 + 系统 + 应用
- 06-22 = 商业(ai-news) + 应用层(uv) + 基础设施(Kafka) → 商业 + 应用 + 基础设施
- 06-23 = 商业(ai-news) + 协议(caddy) + 容器编排(K8s) → 商业 + 协议 + 容器
- 06-24 = 商业(ai-news) + 容器运行时(docker) + Workload(wasm) → 商业 + 容器 + Workload
- **06-25 = 商业(ai-news) + TP(MySQL) + AP(Doris) → 商业 + TP + AP**(new)

**意义**:「商业层 + TP 层 + AP 层」组合是首次把「数据基础设施」独立为一个栈层维度,与之前的「系统语言 / 应用层 / 协议层 / 容器层」并列。**「全栈日」5 种栈层组合可选**(2026 H1 累计),每种组合覆盖不同主题:
1. 商业 + 系统 + 应用(06-21)
2. 商业 + 应用 + 基础设施(06-22)
3. 商业 + 协议 + 容器(06-23)
4. 商业 + 容器 + Workload(06-24)
5. **商业 + TP + AP(06-25,new)** —— 数据基础设施专题

未来 cron 还可以探索第 6 种「商业 + 内核 + 数据(OLAP)」、第 7 种「商业 + 网络 + 数据(OLTP)」等组合。

## 结论
**16 连 0 漂移 cron** —— 5 个 boilerplate 全部稳定成熟为可复用 boilerplate(单行 python3-c JSON insert + sed 剥前缀漂移检测 + 0 缩进 normal 段 anchor + 短 commit 模板 + SSH-over-443 push)+ **「商业 + TP + AP」第 5 种全栈日栈层组合首次落地** + **数据基础设施 4 件套图谱首次完整**(MySQL 9.6 + Kafka 4.1 + Flink 2.2.0 + Doris 3.0.6)+ **「down-one-layer」选 topic 启发式第 3 次实战**(商业 → TP → AP 三层数据栈)= **blog-publisher skill 进入「**稳态 boilerplate + 选 topic 模式库 + 数据基础设施图谱**」三轨并行阶段**,2026 H2 里程碑。