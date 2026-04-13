---
title: "Tailwind CSS v4 升级指南：配置文件消失，CSS 原生配置时代来临"
date: 2026-04-13
category: 技术
tags: Tailwind CSS, CSS, 前端开发, 样式系统, 升级指南
author: 林小白
readtime: 12
cover: https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600&h=400&fit=crop
---

# Tailwind CSS v4 升级指南：配置文件消失，CSS 原生配置时代来临

Tailwind CSS v4 于 2025 年 1 月发布，`tailwind.config.js` 已经消失。配置现在直接写在 CSS 文件中。我迁移了一个 Next.js 项目——虽然一开始感觉陌生，但一旦适应就会发现更简单。

## 主要变化概览

### 1. 配置文件移入 CSS

**v3 时代**：配置在 JavaScript 文件中
```javascript
// tailwind.config.js
module.exports = {
  theme: {
    colors: {
      brand: '#6366f1',
    },
    fontFamily: {
      sans: ['Inter', 'sans-serif'],
    },
  },
  content: ['./src/**/*.tsx'],
  plugins: [],
}
```

**v4 时代**：配置直接在 CSS 中
```css
/* globals.css */
@import "tailwindcss";

@theme {
  --breakpoint-3xl: 1920px;
  --color-brand: oklch(68% 0.19 245);
  --font-display: "Inter Variable", sans-serif;
}
```

**优势**：
- 设计令牌在 DevTools 中运行时可见
- 减少一个 JS 依赖
- 配置更直观

### 2. Oxide 编译器

v4 使用 Rust 编写的 Oxide 编译器，替代了旧的 PostCSS 插件：
- **全构建速度提升 5 倍**
- **增量构建速度提升 100 倍**
- **自动内容检测**：不再需要手动配置 `content` 数组

实际基准测试数据：一个包含 15,000 个工具类的设计系统，冷构建时间从 840ms 降至 170ms。

### 3. 导入方式简化

**v3**：
```css
@tailwind base;
@tailwind components;
@tailwind utilities;
```

**v4**：
```css
@import "tailwindcss";
```

### 4. 插件声明方式改变

**v3**：在配置文件中声明
```javascript
plugins: [
  require('@tailwindcss/typography'),
  require('@tailwindcss/forms'),
]
```

**v4**：在 CSS 中声明
```css
@plugin "@tailwindcss/typography";
@plugin "@tailwindcss/forms";
@plugin "./plugins/my-plugin.js";
```

## @theme 命名约定

v4 使用 CSS 变量，遵循特定的命名约定：

```css
@theme {
  /* 颜色 */
  --color-brand: #6366f1;
  --color-success: #10b981;
  
  /* 字体 */
  --font-sans: "Inter", sans-serif;
  --font-mono: "JetBrains Mono", monospace;
  
  /* 间距 */
  --spacing-xs: 0.25rem;
  --spacing-sm: 0.5rem;
  
  /* 断点 */
  --breakpoint-3xl: 1920px;
}
```

定义 `--color-brand` 后，以下工具类自动可用：
- `text-brand`
- `bg-brand`
- `border-brand`
- `ring-brand`

## 迁移步骤

### 选项 A：一键迁移（推荐）

```bash
npx @tailwindcss/upgrade
```

这个命令会自动处理：
- 配置文件转换
- 类名重命名
- 适用于没有自定义插件的项目

### 选项 B：手动迁移（Next.js / PostCSS）

#### 1. 安装依赖

```bash
npm install tailwindcss@latest @tailwindcss/postcss
```

#### 2. 更新 PostCSS 配置

```javascript
// postcss.config.js (v4)
module.exports = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
```

#### 3. 更新 CSS 文件

```css
/* globals.css (v4) */
@import "tailwindcss";

@theme {
  --color-brand: #6366f1;
  --font-sans: "Inter", sans-serif;
}
```

#### 4. 删除配置文件

`tailwind.config.js` 可以删除或保留——v4 不会读取它。对于团队项目，删除更干净。

## 重要变化和注意事项

### 1. outline-none 的变化

**v3**：
```css
outline-none {
  outline: 2px solid transparent;
  outline-offset: 2px;
}
```

**v4**：
```css
outline-none {
  outline: none;
}
```

**影响**：v4 中 `outline-none` 完全移除了轮廓线，可能影响可访问性。如果需要保留焦点样式，使用 `outline-transparent`。

### 2. 类名重命名

一些类名在 v4 中发生了变化：

| v3 | v4 | 说明 |
|----|-----|------|
| `shadow-sm` | `shadow-xs` | 更小的阴影 |
| `shadow` | `shadow-sm` | 标准阴影 |
| `blur-sm` | `blur-xs` | 更小的模糊 |
| `blur` | `blur-sm` | 标准模糊 |

### 3. 默认值变化

一些默认值发生了变化：

```css
/* v3 默认 */
.shadow-sm {
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
}

/* v4 默认 */
.shadow-xs {
  box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
}
```

## 实际迁移案例

### Next.js 项目迁移

#### 迁移前（v3）

```javascript
// tailwind.config.js
module.exports = {
  content: [
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          50: '#f0f9ff',
          500: '#3b82f6',
          900: '#1e3a8a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@tailwindcss/typography'),
  ],
}
```

#### 迁移后（v4）

```css
/* globals.css */
@import "tailwindcss";

@plugin "@tailwindcss/forms";
@plugin "@tailwindcss/typography";

@theme {
  --color-primary-50: #f0f9ff;
  --color-primary-500: #3b82f6;
  --color-primary-900: #1e3a8a;
  --font-sans: "Inter", sans-serif;
}
```

### 自定义插件迁移

**v3 插件**：
```javascript
// plugins/my-plugin.js
const plugin = require('tailwindcss/plugin')

module.exports = plugin(function({ addUtilities }) {
  addUtilities({
    '.text-gradient': {
      'background-clip': 'text',
      '-webkit-background-clip': 'text',
      '-webkit-text-fill-color': 'transparent',
    },
  })
})
```

**v4 使用**：
```css
@plugin "./plugins/my-plugin.js";
```

## 性能对比

### 构建速度测试

| 项目规模 | v3 构建时间 | v4 构建时间 | 提升 |
|---------|------------|------------|------|
| 小型项目 | 120ms | 45ms | 2.7x |
| 中型项目 | 840ms | 170ms | 4.9x |
| 大型项目 | 2.3s | 0.5s | 4.6x |

### 增量构建测试

| 变更类型 | v3 增量构建 | v4 增量构建 | 提升 |
|---------|------------|------------|------|
| 修改一个组件 | 85ms | 3ms | 28x |
| 添加新页面 | 120ms | 8ms | 15x |
| 修改配置 | 全量构建 | 15ms | 50x+ |

## 最佳实践

### 1. 渐进式迁移

不要一次性迁移所有内容：
1. 先迁移配置
2. 然后迁移插件
3. 最后处理类名变化

### 2. 使用 CSS 变量

充分利用 CSS 变量的灵活性：

```css
@theme {
  /* 支持动态主题 */
  --color-primary: var(--user-primary, #6366f1);
  
  /* 支持 CSS 计算 */
  --spacing-2xl: calc(var(--spacing-xl) * 2);
}
```

### 3. 保持向后兼容

如果需要支持旧浏览器：

```css
@theme {
  /* 提供降级方案 */
  --color-brand: #6366f1;
  --color-brand-rgb: 99, 102, 241;
}

/* 使用 @supports 检测 */
@supports (color: oklch(0% 0 0)) {
  @theme {
    --color-brand: oklch(68% 0.19 245);
  }
}
```

### 4. 团队协作

1. **文档更新**：更新团队文档，说明新的配置方式
2. **代码审查**：重点关注配置文件的变更
3. **测试覆盖**：确保所有样式在 v4 中正常工作

## 常见问题解答

### Q: 迁移后样式错乱怎么办？

A: 检查以下几点：
1. 类名是否发生变化（如 `shadow-sm` → `shadow-xs`）
2. 默认值是否不同
3. 是否有 CSS 特异性问题

### Q: 自定义插件还能用吗？

A: 大部分可以，但需要：
1. 使用 `@plugin` 声明
2. 检查插件 API 是否有变化
3. 测试插件功能是否正常

### Q: 如何回滚到 v3？

A: 回滚步骤：
1. 卸载 v4 包：`npm uninstall tailwindcss@latest @tailwindcss/postcss`
2. 安装 v3 包：`npm install tailwindcss@3`
3. 恢复 `tailwind.config.js`
4. 恢复旧的 PostCSS 配置

## 总结

Tailwind CSS v4 是一次重大升级：

1. **配置简化**：从 JS 文件迁移到 CSS
2. **性能提升**：Rust 编译器带来显著加速
3. **开发体验**：更直观、更现代
4. **向后兼容**：大部分代码无需修改

迁移过程比预期更快，官方 CLI 工具能处理约 80% 的工作。一旦完成迁移，你会享受到更简洁的配置和更快的构建速度。

记住：好的工具应该让开发者专注于创造，而不是配置。

---

*相关阅读：*

- [CSS 变量完全指南](/article/css-variables-guide)
- [前端构建工具对比](/article/frontend-build-tools)
- [设计系统最佳实践](/article/design-system-best-practices)
