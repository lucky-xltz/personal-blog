---
title: "Jujutsu (jj)：Git 的现代替代品，版本控制的工作流革命"
date: 2026-04-21
category: 技术
tags: [Jujutsu, Git, 版本控制, 开发工具, 工作流]
author: 林小白
readtime: 15
cover: https://images.unsplash.com/photo-1556075798-4825dfaaf498?w=600&h=400&fit=crop
---

# Jujutsu (jj)：Git 的现代替代品，版本控制的工作流革命

Git 统治版本控制领域已经 20 年了。在这 20 年里，我们忍受了 rebase 的交互式菜单、merge conflict 的噩梦、stash 的遗忘、以及 `git reflog` 救场的惊魂时刻。但 Git 的底层数据模型其实非常优秀——问题出在 CLI 的设计哲学上。

2026 年，一个名为 **Jujutsu**（简称 `jj`）的版本控制系统正在悄然改变这一切。它在 Hacker News 上频繁登上热榜，GitHub stars 已突破 28k，Google 内部多个团队已经在使用。Jujutsu 不是 Git 的分支——它是对 Git 底层能力的**重新想象**。

## 为什么需要一个新的 VCS？

先问一个根本问题：Git 的痛点到底在哪里？

**1. 工作副本状态管理的脆弱性**

Git 的 working directory 是一个"特殊状态"——你修改了文件但还没 `git add`，或者 `add` 了但还没 `commit`。这意味着你随时可能丢失工作（忘记 add、误操作 checkout、stash 覆盖）。

**2. 历史修改的认知负担**

`git rebase -i` 的交互式菜单让人头疼：pick、squash、fixup、reword、edit、drop。你需要记住 commit 的顺序是倒序排列的。一个操作失误就可能破坏整个分支。

**3. 冲突处理的暴力美学**

Git 将 merge conflict 视为异常情况——需要立即解决，否则仓库处于"半损坏"状态。你不能提交一个"带冲突的中间状态"，不能在冲突解决到一半时切换任务。

**4. 分支管理的心智负担**

在 Git 中，分支是"指针"，切换分支 = 切换工作上下文。你需要 `git stash` 当前工作、`git checkout` 到目标分支、做完事情再切回来、`git stash pop`。这种摩擦在需要频繁上下文切换的场景中极其痛苦。

Jujutsu 从根本上解决了这些问题。

## Jujutsu 的核心设计哲学

### 1. Working Copy 是一个普通的 Commit

这是 Jujutsu 最革命性的设计决策。在 Jujutsu 中，你的工作副本**就是一个 commit**（用 `@` 符号标识）。每次修改文件，系统自动创建一个新快照。没有 "staging area"，没有 "untracked files" 的概念。

```bash
# 传统 Git 工作流
vim main.go
git add main.go                    # 手动暂存
git commit -m "fix: handle error"  # 手动提交

# Jujutsu 工作流
vim main.go
# 就这样。jj 已经自动创建了快照。
jj describe -m "fix: handle error" # 只需添加描述
```

这意味着：
- **永远不会丢失工作**——每次修改都被自动保存
- **没有 stash**——工作副本就是 commit，可以随时用 `jj new` 创建新 commit 而不丢失当前修改
- **没有 staging area**——简化心智模型

### 2. Conflict 是一等公民

这是 Jujutsu 最有洞察力的设计。在 Git 中，conflict 是一个"坏状态"——你必须立即解决它。而在 Jujutsu 中，conflict 被记录为 commit 元数据的一部分。

```bash
# 假设 rebase 产生了冲突
jj rebase -d main

# Git 的反应：STOP！立即解决冲突！工作区坏了！
# Jujutsu 的反应：记录冲突，你可以稍后处理

# 继续做其他事情
jj new feature-b
vim other_file.go
jj describe -m "add new feature"

# 随时回来解决之前的冲突
jj edit <conflicted-commit>
# 解决冲突后
jj describe -m "resolved merge conflict"
```

这意味着：
- **冲突不会阻塞你的工作流**
- **可以推迟冲突解决到合适的时机**
- **冲突的解决方式也被记录在版本历史中**

### 3. 操作日志和无限撤销

Jujutsu 记录每一次操作（不仅仅是 commit），你可以随时回退到任意历史状态：

```bash
# 查看操作历史
jj op log

# 回退到某个操作之前的状态
jj op restore @-

# 或者撤销最近一次操作
jj op undo
```

这比 `git reflog` 强大得多——它覆盖所有操作，包括 rebase、describe、split 等。

### 4. 与 Git 完全兼容

Jujutsu 不是让你放弃 Git——它使用 Git 仓库作为后端存储。你可以：
- 克隆任何 Git 仓库
- 与使用 Git 的同事无缝协作
- 使用 GitHub/GitLab 等平台
- 随时回到 Git（数据格式完全兼容）

## 实战指南：从 Git 到 Jujutsu

### 安装

```bash
# macOS
brew install jj

# Linux (Cargo)
cargo install jj-cli

# 验证安装
jj version
# jujutsu 0.40.0
```

### 初始化和克隆

```bash
# 克隆 Git 仓库（自动创建 .jj 目录）
jj git clone https://github.com/user/repo.git
cd repo

# 在现有 Git 仓库中初始化 jj
cd existing-git-repo
jj git init --colocate
```

### 日常工作流

#### 修改和提交

```bash
# 修改文件后，不需要任何 git add
vim src/main.go

# 查看当前状态
jj status

# 添加描述（等同于 commit）
jj describe -m "feat: add user authentication"

# 查看日志（内置可视化）
jj log
# @  qpvuntm user@email.com 2026-04-21 12:00:00
# │  feat: add user authentication
# ○  rlvkpnr user@email.com 2026-04-21 11:30:00
# │  initial commit
# ◆  zzzzzzz root() 00000000
```

#### 分支和特性开发

```bash
# 创建新的 commit（在当前 commit 之上）
jj new -m "feat: add login form"

# 创建分支
jj branch create feature-auth -r @

# 切换到另一个 commit（没有 checkout！直接 edit）
jj edit <commit-id>

# 或者在某个 commit 之上创建新 commit
jj new <commit-id>
```

#### 重写历史

Jujutsu 的历史重写比 Git 简单得多：

```bash
# 修改最近 commit 的描述
jj describe -m "新的描述"

# 将当前 commit 的修改合并到父 commit
jj squash

# 交互式 squash（选择特定的修改）
jj squash --interactive

# 拆分一个 commit 为多个
jj split

# 重新排序 commits
jj rebase -r <commit> -d <new-parent>

# 移动特定 commit 到另一个位置
jj rebase -s <commit> -d <destination>
```

### Megamerge 工作流

这是 Jujutsu 社区中最受欢迎的高级工作流，特别适合同时处理多个特性分支的开发者：

```bash
# 同时开始多个特性开发
jj new main -m "start feature A"
# ... 写代码 ...
jj describe -m "feat: implement user auth"

jj new main -m "start feature B"
# ... 写代码 ...
jj describe -m "feat: add payment gateway"

jj new main -m "start bugfix"
# ... 写代码 ...
jj describe -m "fix: handle null pointer"

# 创建 megamerge：将所有工作合并到一个视角下
jj new feature-a feature-b bugfix -m "megamerge"

# 现在你的工作副本包含了所有三个分支的变更
# 你可以在这里做集成测试、检查兼容性

# 准备提交 feature-a 时，使用 squash 将修改推送到正确的 commit
jj squash --to feature-a --interactive
```

Megamerge 的优势：
- **始终在所有工作的"合集"上开发**——集成问题早发现
- **上下文切换零摩擦**——不用 stash/checkout
- **自动保持分支同步**——一次 rebase 更新所有分支

### 与 GitHub 协作

```bash
# 推送特定分支到 GitHub
jj git push --branch feature-auth

# 推送所有变更的分支
jj git push --all

# 创建 PR 后，从 GitHub 拉取更新
jj git fetch
jj rebase -d main  # 将本地工作 rebase 到最新的 main
```

## Jujutsu vs Git：核心对比

| 特性 | Git | Jujutsu |
|------|-----|---------|
| 工作副本管理 | 特殊状态（staging area） | 普通 commit（自动快照） |
| 冲突处理 | 必须立即解决 | 一等公民，可推迟 |
| 历史重写 | rebase -i（交互式菜单） | 直观的命令组合 |
| 撤销机制 | reflog（仅限 commit） | op log（所有操作） |
| 学习曲线 | 中等 | 低（如果没学过 Git）/ 中等（Git 用户迁移） |
| 兼容性 | 原生 | 完全兼容 Git 仓库 |
| 性能 | 极优（C 语言） | 良好（Rust 语言） |
| 生态系统 | 成熟 | 成长中（v0.40.0） |

## 迁移建议

Jujutsu 目前的版本是 v0.40.0，API 已经相对稳定，但仍在积极开发中。我的建议：

**适合现在迁移的场景：**
- 个人项目或小型团队
- 频繁需要 rebase/历史重写的工作流
- 需要同时处理多个分支的开发者
- 对 Git CLI 设计不满已久的高级用户

**建议观望的场景：**
- 大型企业团队（需要培训成本）
- 严重依赖 Git GUI 工具（如 SourceTree、GitKraken）
- 需要 Git hooks 深度集成的 CI/CD 流水线

## 总结

Jujutsu 不是要取代 Git——它是要**取代 Git 的 CLI**。底层仍然使用 Git 的数据格式，但上层提供了一个更直观、更安全、更强大的工作流。

如果你曾被 `git rebase -i` 的交互式菜单搞晕，曾在 merge conflict 中迷失方向，曾因忘记 stash 而丢失工作——那 Jujutsu 值得你花一个下午试试。

```bash
# 试试看？
brew install jj
jj git clone https://github.com/your-favorite/repo.git
# 感受一下不同
```

## 相关资源

- [Jujutsu 官方文档](https://docs.jj-vcs.dev/latest/)
- [GitHub 仓库](https://github.com/jj-vcs/jj)
- [Jujutsu Megamerge 工作流详解](https://isaaccorbrey.com/notes/jujutsu-megamerges-for-fun-and-profit)
- [从 Git 迁移到 Jujutsu 的完整指南](https://docs.jj-vcs.dev/latest/git-comparison/)

---

*相关阅读：*

- [GitHub Stacked PRs 完全指南](/article/github-stacked-prs-guide)
- [Nginx 常用命令大全](/article/nginx-commands-guide)
