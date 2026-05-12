---
title: "TanStack 供应链攻击深度复盘：GitHub Actions 的三重漏洞链与 npm 生存指南"
date: 2026-05-12
category: 技术
tags: [供应链安全, npm, GitHub Actions, 开源安全, CI/CD, DevSecOps]
author: 林小白
readtime: 15
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# TanStack 供应链攻击深度复盘：GitHub Actions 的三重漏洞链与 npm 生存指南

2026 年 5 月 11 日，前端生态最流行的开源库之一 TanStack（React Query、React Table、TanStack Router 等的母公司）遭遇了一次精心策划的供应链攻击。攻击者在 6 分钟内发布了 42 个包的 84 个恶意版本，波及数以万计的下游项目。

这不是又一个"误装了恶意包"的故事——而是一次**三重漏洞链**的精密组合攻击，每一环都利用了现代 CI/CD 基础设施中被广泛忽视的设计缺陷。本文将从攻击原理、防御策略、到 npm 生态的系统性风险，做一次完整的深度剖析。

## 攻击时间线：6 分钟的闪电战

| 时间 (UTC) | 事件 |
|-----------|------|
| 19:20 | 攻击者触发恶意 workflow，开始发布 |
| 19:26 | 42 个包的 84 个恶意版本全部发布完成 |
| ~19:40 | 安全研究员 ashishkurmi（StepSecurity）公开报告 |
| ~19:45 | TanStack 维护者 Tanner Linsley 启动应急响应 |
| 数小时内 | npm security 介入，拉取恶意 tarball |

从攻击发起到被发现，只用了约 20 分钟。但就是这 20 分钟，足以让所有在当天执行了 `npm install` 的开发环境面临凭证泄露风险。

## 三重漏洞链：每一环都不致命，组合起来足以致命

这次攻击的精妙之处在于，它单独利用了三个已知的、但各自被认为"风险可控"的设计缺陷，将它们串联成一条完整的攻击链。

### 第一环：pull_request_target 的"Pwn Request"

```yaml
# TanStack 的 bundle-size.yml（简化版）
on:
  pull_request_target:
    paths: ['packages/**', 'benchmarks/**']

jobs:
  benchmark-pr:
    steps:
      - uses: actions/checkout@v6.0.2
        with:
          ref: refs/pull/${{ github.event.pull_request.number }}/merge
      - run: pnpm nx run @benchmarks/bundle-size:build
```

**问题**：`pull_request_target` 会在**目标仓库**（base repo）的上下文中运行，但检出的代码却来自**fork 仓库**。这意味着 fork 的 PR 代码可以访问 base repo 的 secrets、GITHUB_TOKEN、以及——关键的——Actions 缓存。

维护者确实做了信任拆分（comment-pr 和 benchmark-pr 分开），但遗漏了一个事实：benchmark-pr 虽然没有写权限，却能向共享缓存中写入数据。

### 第二环：跨 fork-base 的缓存投毒

攻击者的恶意代码 `vite_setup.mjs` 精确计算了 `release.yml` 工作流会查找的缓存键：

```
Linux-pnpm-store-${hashFiles('**/pnpm-lock.yaml')}
```

当 benchmark-pr 任务结束时，`actions/cache@v5` 的 post-step 自动将被投毒的 pnpm store 保存到这个精确的缓存键。下次 `release.yml` 在 main 分支的 push 上运行时，它会**自动恢复**这个被投毒的缓存条目——完全按照 GitHub Actions 的设计工作。

这不是 TanStack 的 bug，而是 GitHub Actions 缓存机制的**已知设计问题**。安全研究员 Adnan Khan 在 2024 年就公开记录了这种攻击模式。

### 第三环：OIDC Token 内存提取

`release.yml` 声明了 `id-token: write`，这是 npm OIDC 可信发布所必需的。当被投毒的 pnpm store 被恢复到 runner 上时，攻击者控制的二进制文件在构建步骤中被执行，它们：

1. 扫描 GitHub Actions runner 进程的内存
2. 提取 OIDC token（用于 npm 发布的身份验证）
3. 将 token 发送到攻击者的命令控制服务器
4. 攻击者使用该 token 以 TanStack 的名义发布恶意包

这个内存提取技术与 2025 年 3 月 tj-actions/changed-files 事件中使用的完全相同——攻击者甚至保留了原脚本的归属注释，说明他们直接复用了公开的研究成果。

### 链式效应

```
Fork PR 代码 ──(pull_request_target)──> Base Repo 缓存
                                            │
                                    (actions/cache)
                                            │
                                            ▼
Base Repo 缓存 ──(恢复投毒缓存)──> Release Workflow 运行时
                                            │
                                    (内存提取 OIDC)
                                            │
                                            ▼
Release Workflow ──(npm publish)──> 42 个恶意版本上线
```

每一环都假设其他环节提供了信任边界，但当三个漏洞串联时，这些假设全部失效。

## 恶意载荷：你安装了什么？

受影响版本的 `package.json` 包含一个隐蔽的 `optionalDependencies`：

```json
{
  "optionalDependencies": {
    "@tanstack/setup": "github:tanstack/router#79ac49e..."
  }
}
```

当开发者执行 `npm install` 时，npm 会：

1. 解析这个 GitHub 引用，从 fork 网络中获取孤立的恶意 commit
2. 执行其 `prepare` 生命周期脚本
3. 运行一个 ~2.3MB 的混淆文件 `router_init.js`

这个脚本会：
- **窃取云凭证**：AWS、GCP、Azure 的 CLI 配置和 token
- **窃取 SSH 密钥**：`~/.ssh/` 下的所有私钥
- **窃取 .env 文件**：数据库密码、API 密钥、第三方服务凭证
- **建立持久化**：植入定时任务，维持远程访问
- **横向扩散**：尝试访问 CI/CD 环境中的其他凭证

**关键**：由于载荷在 `npm install` 的生命周期中执行，任何在 2026-05-11 安装了受影响版本的机器都应被视为**潜在被入侵**。

## 为什么 20 分钟就发现了？

这次攻击有一个讽刺的"幸运"：攻击者的载荷**破坏了测试**，导致发布步骤（会产生更干净的 tarball）被跳过。这使得攻击足够"吵闹"，外部研究员能在 20 分钟内发现。

如果一个更谨慎的攻击者没有破坏测试，恶意版本可能在数小时内不被发现地安静发布。TanStack 自己也承认："We got lucky."

## 防御策略：从个人到企业

### 开发者层面

**1. 锁定依赖版本**

```json
// ❌ 危险：自动更新
"@tanstack/react-query": "^5.0.0"

// ✅ 安全：精确版本
"@tanstack/react-query": "5.61.3"
```

**2. 使用 lockfile 并验证完整性**

```bash
# 使用 npm ci 而非 npm install
npm ci

# 验证包完整性
npm audit signatures
```

**3. 安装后检查异常行为**

```bash
# 检查是否有异常的 postinstall 脚本
npm ls --all | grep "prepare\|preinstall\|postinstall"

# 检查网络连接
netstat -an | grep ESTABLISHED
```

**4. 使用 Socket.dev 等工具**

```bash
# Socket CLI 可以检测包的异常行为
npx socket create .socket.socketrc
npx socket lint
```

### 维护者层面

**1. 审计 pull_request_target workflow**

```yaml
# ❌ 危险：检出 fork 代码
- uses: actions/checkout@v6
  with:
    ref: refs/pull/${{ github.event.pull_request.number }}/merge

# ✅ 安全：只运行可信代码
- uses: actions/checkout@v6
  with:
    ref: main  # 只检出 base repo 的代码
```

**2. 隔离缓存作用域**

```yaml
# 为 fork PR 使用不同的缓存键前缀
- uses: actions/cache@v4
  with:
    key: ${{ github.event.pull_request.head.repo.fork && 'fork' || 'base' }}-pnpm-${{ hashFiles('**/pnpm-lock.yaml') }}
```

**3. 监控 npm 发布**

```bash
# 设置 npm 发布通知
npm owner ls @tanstack/react-query

# 使用 npm webhooks 或 Socket.dev 监控新版本
```

**4. 最小化 OIDC token 暴露**

```yaml
# 只在需要的 job 中声明 id-token: write
jobs:
  publish:
    permissions:
      id-token: write  # 只有发布 job 需要
  build:
    permissions:
      contents: read   # 构建 job 不需要
```

### 企业层面

**1. 内部 npm registry 镜像**

```bash
# 使用 Verdaccio 或 Nexus 搭建内部镜像
# 只允许从内部镜像安装
npm config set registry https://npm.internal.company.com
```

**2. 运行时行为监控**

```bash
# 使用 Falco 监控容器内异常行为
falco -r npm_supply_chain.yaml

# 使用 eBPF 监控系统调用
```

**3. 凭证轮换策略**

一旦发现供应链事件，立即轮换：
- AWS/GCP/Azure CLI 凭证
- SSH 密钥
- .env 中的所有密钥
- GitHub Personal Access Token
- npm token

## npm 生态的系统性风险

这次事件暴露了 npm 生态的几个深层问题：

### 1. "无法取消发布"的困境

npm 的策略是：如果有其他包依赖某个版本，就不能取消发布。这意味着一旦恶意版本上线，只能依赖 npm security 手动拉取 tarball，这个过程需要数小时。

### 2. 7 人维护者 = 7 个攻击面

TanStack 的 npm scope 有 7 个维护者，每个维护者的凭证被盗都可能导致同样的后果。维护者越多，攻击面越大。

### 3. OIDC 没有逐次审核

一旦配置了 OIDC 可信发布，workflow 中的任何代码路径都可以铸造发布 token。没有机制可以在每次发布前进行人工审核。

### 4. 浮动引用的风险

```yaml
# ❌ 危险：浮动引用，随时可能被投毒
- uses: actions/cache@v5
- uses: TanStack/config/.github/setup@main

# ✅ 安全：固定到 commit SHA
- uses: actions/cache@a50...abc
- uses: TanStack/config/.github/setup@a50...abc
```

## 最佳实践清单

| 优先级 | 措施 | 适用对象 |
|-------|------|---------|
| 🔴 紧急 | 审计所有 `pull_request_target` workflow | 维护者 |
| 🔴 紧急 | 固定第三方 action 到 commit SHA | 维护者 |
| 🔴 紧急 | 使用 `npm ci` 而非 `npm install` | 所有开发者 |
| 🟡 重要 | 隔离 fork PR 的缓存作用域 | 维护者 |
| 🟡 重要 | 启用 npm provenance 验证 | 维护者 |
| 🟡 重要 | 使用 Socket.dev 监控依赖行为 | 所有开发者 |
| 🟢 建议 | 搭建内部 npm registry 镜像 | 企业 |
| 🟢 建议 | 实施运行时行为监控 | 企业 |
| 🟢 建议 | 定期轮换 CI/CD 凭证 | 所有团队 |

## 总结

TanStack 供应链攻击不是一次偶然事件，而是 npm 生态系统性风险的必然产物。三个已知的设计缺陷——`pull_request_target` 的信任边界模糊、Actions 缓存的跨 fork 共享、OIDC token 的无审核铸造——单独来看都"风险可控"，但组合在一起就构成了一条完整的攻击链。

对于开发者来说，最基本的防御是：**锁定版本、使用 lockfile、验证完整性**。对于维护者来说，**审计 workflow、隔离缓存、监控发布**是当务之急。对于企业来说，**内部镜像、运行时监控、凭证轮换**是必要的安全投资。

这次事件的幸运之处在于攻击者不够谨慎，但下一次可能不会这么幸运。安全不是一次性工作，而是持续的实践。

---

*相关阅读：*

- [AI 漏洞猎人：当 Mythos 遇上 curl 和 Firefox](/article/ai-vulnerability-hunter-mythos-curl-firefox)
- [AI 编码的「上帝对象」陷阱](/article/ai-coding-god-object-trap)
