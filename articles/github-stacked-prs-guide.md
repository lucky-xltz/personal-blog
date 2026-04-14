---
title: "GitHub Stacked PRs 完全指南：告别大型 PR，拥抱分层代码审查"
date: 2026-04-14
category: 技术
tags: [GitHub, Git, 代码审查, 工作流, DevOps]
author: 林小白
readtime: 12
cover: https://images.unsplash.com/photo-1556075798-4825dfaaf498?w=600&h=400&fit=crop
---

# GitHub Stacked PRs 完全指南：告别大型 PR，拥抱分层代码审查

大型 Pull Request 是每个开发团队的噩梦——上千行代码变更，审查者迷失在海量 diff 中，反馈质量直线下降，合并冲突此起彼伏。GitHub 最新推出的 **Stacked PRs（堆叠 PR）** 功能，正是为解决这一痛点而生。本文将深入解析 Stacked PRs 的核心概念、工作流程和最佳实践，帮助你的团队彻底告别"巨型 PR"时代。

## 什么是 Stacked PRs？

Stacked PRs（堆叠式 Pull Request）是一种将大型代码变更拆分为一系列小型、有序的 PR 的工作流方法。每个 PR 只关注一个逻辑层，但它们之间形成依赖链——第二个 PR 基于第一个 PR 的分支，第三个基于第二个，以此类推。

### 核心概念

想象你要实现一个完整的用户认证系统，传统方式是一个包含所有改动的巨型 PR。使用 Stacked PRs，你可以将其拆分为：

- **PR #1**（`auth-layer`）：核心认证逻辑和数据模型
- **PR #2**（`api-endpoints`）：基于 PR #1 的 REST API 端点
- **PR #3**（`frontend`）：基于 PR #2 的前端登录界面

每个 PR 都很小、很聚焦，审查者可以逐层审查，理解每一层的职责和变更。

### 与传统方式的对比

| 维度 | 传统大型 PR | Stacked PRs |
|------|------------|-------------|
| 代码审查 | 一次性审查上千行 | 分层审查，每层专注一个逻辑 |
| 反馈质量 | 容易遗漏细节 | 每层可获得高质量反馈 |
| 合并风险 | 一个冲突影响全部 | 冲突范围小，解决快 |
| CI 运行 | 长时间等待 | 并行运行，快速反馈 |
| 回滚难度 | 需要整体回滚 | 可精确回滚某一层 |

## GitHub Stacked PRs 的核心功能

### 1. 原生 GitHub UI 支持

GitHub 为 Stacked PRs 提供了原生的 UI 支持：

- **Stack Map（堆叠地图）**：在 PR 详情页顶部显示当前 PR 在堆叠中的位置，审查者可以快速跳转到其他层
- **Focused Diff（聚焦差异）**：每个 PR 只显示相对于其 base 分支的变更，避免看到上游 PR 的重复内容
- **Rules Enforcement（规则执行）**：分支保护规则基于最终目标分支执行，而非直接的 base 分支

### 2. `gh stack` CLI 工具

GitHub 提供了专门的 CLI 扩展来管理堆叠 PR：

```bash
# 安装 gh-stack 扩展
gh extension install github/gh-stack

# 设置别名（可选，将 gh stack 简化为 gs）
gh stack alias
```

核心命令速查：

```bash
# 初始化堆叠（创建第一个分支）
gs init auth-layer

# 添加新层（在当前堆叠基础上创建新分支）
gs add api-routes

# 推送所有分支到远程
gs push

# 创建所有 PR
gs submit

# 在堆叠层之间导航
gs up      # 切换到上一层
gs down    # 切换到下一层
```

### 3. 级联 Rebase

当堆叠底部的 PR 被合并后，上面的 PR 需要自动 rebase 到新的 base。`gh stack` 处理了这个复杂的操作：

```bash
# 对整个堆叠执行级联 rebase
gs rebase

# 或者在合并后自动触发
# GitHub 会自动 rebase 剩余的 PR
```

## 实战：从零开始使用 Stacked PRs

### 场景：实现一个博客系统的评论功能

假设你需要为博客系统添加评论功能，包含数据库模型、API 层和前端展示。

#### Step 1: 初始化堆叠

```bash
# 确保你在最新的 main 分支上
git checkout main
git pull origin main

# 初始化堆叠，创建第一层
gs init comment-model
```

#### Step 2: 实现数据模型层

```python
# models/comment.py
from datetime import datetime
from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.orm import relationship

class Comment(Base):
    __tablename__ = 'comments'

    id = Column(Integer, primary_key=True)
    content = Column(Text, nullable=False)
    author_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    article_id = Column(Integer, ForeignKey('articles.id'), nullable=False)
    parent_id = Column(Integer, ForeignKey('comments.id'), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    # 关系
    author = relationship('User', back_populates='comments')
    article = relationship('Article', back_populates='comments')
    replies = relationship('Comment', backref='parent', remote_side=[id])

    def to_dict(self):
        return {
            'id': self.id,
            'content': self.content,
            'author': self.author.to_dict(),
            'created_at': self.created_at.isoformat(),
            'reply_count': len(self.replies)
        }
```

提交并准备下一层：

```bash
git add .
git commit -m "feat: add Comment model with SQLAlchemy"

# 添加第二层
gs add comment-api
```

#### Step 3: 实现 API 层

```python
# api/comments.py
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from models.comment import Comment
from schemas.comment import CommentCreate, CommentResponse
from dependencies import get_db, get_current_user

router = APIRouter(prefix="/api/comments", tags=["comments"])

@router.post("/", response_model=CommentResponse)
def create_comment(
    comment: CommentCreate,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    # 创建新评论
    db_comment = Comment(
        content=comment.content,
        author_id=current_user.id,
        article_id=comment.article_id,
        parent_id=comment.parent_id
    )
    db.add(db_comment)
    db.commit()
    db.refresh(db_comment)
    return db_comment

@router.get("/article/{article_id}", response_model=list[CommentResponse])
def get_article_comments(
    article_id: int,
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    # 获取文章的评论列表
    comments = db.query(Comment) \
        .filter(Comment.article_id == article_id, Comment.parent_id.is_(None)) \
        .order_by(Comment.created_at.desc()) \
        .offset(skip) \
        .limit(limit) \
        .all()
    return comments
```

```bash
git add .
git commit -m "feat: add comment API endpoints"

# 添加第三层
gs add comment-frontend
```

#### Step 4: 实现前端组件

```jsx
// components/CommentSection.jsx
import { useState, useEffect } from 'react';

export function CommentSection({ articleId }) {
    const [comments, setComments] = useState([]);
    const [newComment, setNewComment] = useState('');
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchComments();
    }, [articleId]);

    const fetchComments = async () => {
        try {
            const response = await fetch(`/api/comments/article/${articleId}`);
            const data = await response.json();
            setComments(data);
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!newComment.trim()) return;

        const response = await fetch('/api/comments/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: newComment,
                article_id: articleId
            })
        });

        if (response.ok) {
            const comment = await response.json();
            setComments([comment, ...comments]);
            setNewComment('');
        }
    };

    return (
        <div className="comment-section">
            <h3>评论 ({comments.length})</h3>
            <form onSubmit={handleSubmit} className="comment-form">
                <textarea
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    placeholder="写下你的评论..."
                    rows={3}
                />
                <button type="submit">发表评论</button>
            </form>
            {loading ? (
                <p>加载中...</p>
            ) : (
                <div className="comment-list">
                    {comments.map(comment => (
                        <CommentCard key={comment.id} comment={comment} />
                    ))}
                </div>
            )}
        </div>
    );
}
```

#### Step 5: 推送并创建 PR

```bash
# 推送所有分支
gs push

# 创建所有 PR
gs submit
```

现在你会在 GitHub 上看到三个相互关联的 PR，每个都有清晰的职责边界。

## 最佳实践与注意事项

### 1. 保持每层聚焦

每个 PR 应该只做一件事。如果你发现一个 PR 包含了多个不相关的变更，说明需要进一步拆分。

**好例子：**
- PR #1：添加数据库迁移
- PR #2：实现业务逻辑
- PR #3：添加 API 端点
- PR #4：前端 UI 组件

**坏例子：**
- PR #1：添加数据库迁移 + 实现部分业务逻辑 + 修复一个无关的 bug

### 2. 编写清晰的 PR 描述

每个 PR 的描述应该说明：
- 这一层做了什么
- 依赖哪些上游层
- 如何测试这一层

### 3. 合理控制堆叠深度

虽然 Stacked PRs 支持任意深度的堆叠，但建议：
- **日常开发**：2-4 层
- **大型重构**：不超过 6-8 层
- **超过 8 层**：考虑是否需要调整拆分策略

### 4. 处理合并冲突

当堆叠中出现冲突时：

```bash
# 1. 导航到出现冲突的层
gs up  # 或 gs down

# 2. 解决冲突
git mergetool

# 3. 继续 rebase
git rebase --continue

# 4. 级联更新后续层
gs rebase
```

### 5. 与 CI/CD 集成

GitHub 会为堆叠中的每个 PR 独立运行 CI，但需要注意：
- CI 应该能够处理基于非 main 分支的 PR
- 考虑设置 CI 依赖：只有底层 PR 通过后才运行上层的完整测试
- 使用 GitHub Actions 的 `needs` 关键字实现依赖链

## 与其他工具的比较

### Stacked PRs vs Git Stacking（传统方法）

传统方法需要手动管理分支关系，容易出错。Stacked PRs 自动化了这些繁琐的步骤。

### Stacked PRs vs Graphite

Graphite 是第三方工具，提供类似功能：
- **Stacked PRs**：GitHub 原生，无需额外工具
- **Graphite**：功能更丰富，但需要额外安装和学习

### Stacked PRs vs Squash Merge

Squash Merge 将所有提交合并为一个，但失去了细粒度的提交历史和分层回滚能力。

## 常见问题解答

**Q: 我需要为每个堆叠创建新的仓库吗？**

不需要。Stacked PRs 在同一个仓库内工作，每个层是一个独立的分支。

**Q: 如果堆叠中间的 PR 被拒绝怎么办？**

你可以选择修改该层的代码后重新提交，或将该层的改动合并到下一层，跳过这一层。

**Q: Stacked PRs 适合什么规模的团队？**

小团队（2-5人）非常有用，中型团队（5-20人）几乎是必需的，大型团队建议作为标准工作流。

**Q: 如何处理堆叠中的 hotfix？**

从 main 创建 hotfix 分支，修复后合并到 main，然后对整个堆叠执行 `gs rebase`。

## 总结

GitHub Stacked PRs 代表了代码协作工作流的重大进步。它将大型变更分解为易于审查的小块，同时保持变更之间的逻辑关系。

**核心优势回顾：**
- 提升代码审查质量和速度
- 降低合并冲突风险
- 支持精确的分层回滚
- 原生 GitHub 集成，无需第三方工具

**适用场景：**
- 任何超过 200 行代码变更的功能开发
- 涉及多个层次的大型功能
- 需要多人协作审查的复杂变更

Stacked PRs 目前处于 Private Preview 阶段，你可以访问 [gh.io/stacksbeta](https://gh.io/stacksbeta) 注册加入等待列表。

---

*相关阅读：*

- [GitHub 官方文档：Stacked PRs](https://github.github.com/gh-stack/)
- [Google 工程实践：代码审查指南](https://google.github.io/eng-practices/review/)
- [Trunk Based Development 最佳实践](https://trunkbaseddevelopment.com/)
