---
AIGC:
    ContentProducer: Minimax Agent AI
    ContentPropagator: Minimax Agent AI
    Label: AIGC
    ProduceID: "00000000000000000000000000000000"
    PropagateID: "00000000000000000000000000000000"
    ReservedCode1: 3045022100d171aef9f6bbae6e2c8c160d6ed87f5a05bc927bdc2bf684f4d2d7501300122502204b74fc5f31043055e8a33500f52f3d2f2656754b13f1ac05bdd154c338b92362
    ReservedCode2: 304502207cfd01a180c794b622d16921478b6c25f61ceb4477edeb79eb10162a34de3ae3022100f2b7cc7e0af24650411cd673e8ad1d3f084904ec0df34ace6bee88c043589045
---

# 个人Blog网站设计规范

## 1. Concept & Vision 概念与愿景

一个充满活力与温度的个人博客，摒弃传统博客的刻板布局，采用"流体艺术"设计语言。整体感觉像是一幅流动的抽象画，元素仿佛在页面中轻轻漂浮、呼吸。圆润的形态传递友好与包容，渐进式的动画引导用户探索，每个滚动都是一次视觉惊喜。

## 2. Design Language 设计语言

### 美学方向
**"Liquid Glassmorphism" 液态玻璃态** - 融合玻璃拟态与流体艺术，创造既有质感又有动感的视觉体验。所有元素都采用大圆角，呈现柔和、友好、现代的特质。

### 色彩系统
```
Primary:     #6366F1 (靛蓝紫)
Secondary:   #EC4899 (玫瑰粉)
Accent:      #14B8A6 (青绿色)
Background:  #0F172A (深空蓝)
Surface:     #1E293B (柔和灰蓝)
Text:        #F8FAFC (月光白)
Text-muted:  #94A3B8 (银灰)
```

### 渐变配色
- **主渐变**: linear-gradient(135deg, #6366F1 0%, #EC4899 100%)
- **背景渐变**: radial-gradient(ellipse at 20% 20%, rgba(99,102,241,0.15) 0%, transparent 50%)
- **玻璃渐变**: linear-gradient(135deg, rgba(255,255,255,0.1) 0%, rgba(255,255,255,0.05) 100%)

### 字体系统
- **标题**: "Outfit", sans-serif (现代几何感)
- **正文**: "Inter", sans-serif (高可读性)
- **代码**: "JetBrains Mono", monospace

### 空间系统
- 基础单位: 8px
- 圆角半径: 24px (卡片), 16px (按钮), 9999px (胶囊)
- 间距节奏: 8, 16, 24, 32, 48, 64, 96px

### 动效哲学
- **入场动画**: 元素从下方 fade + slide 进入，错开 100ms
- **悬停反馈**: scale(1.02) + 阴影加深，200ms ease-out
- **背景动画**: 缓慢漂浮的渐变blob，营造活力感
- **滚动视差**: 背景层以不同速度移动，增加层次

## 3. Layout & Structure 布局与结构

### 页面架构
```
[导航栏] - 玻璃态固定顶部，毛玻璃效果
[Hero区域] - 全屏高度，居中大标题+简介+CTA，背景漂浮blob
[精选文章] - 非对称卡片网格，交错排列（点击跳转详情页）
[关于我] - 左侧大头像+右侧自我介绍，侧边装饰元素
[标签云] - 随机角度标签，悬浮效果
[订阅区] - 邮件订阅表单
[底部] - 简洁footer+社交链接

[文章详情页] - 独立页面，支持Markdown渲染
├── 导航栏 - 返回首页按钮
├── 文章头部 - 标题、分类、日期、作者、阅读时间
├── 封面图 - 全宽渐变遮罩
├── 文章正文 - Markdown渲染+语法高亮
├── 标签区 - 文章标签链接
└── 底部 - 社交链接
```

### 视觉节奏
- Hero区域: 呼吸感，元素间距大
- 文章区域: 紧凑但不拥挤，信息密度适中
- 关于区域: 留白多，强调个人特质
- 底部: 极简，回收感

### 响应式策略
- Desktop (>1024px): 完整布局，3列文章网格
- Tablet (768-1024px): 2列布局，保持核心视觉
- Mobile (<768px): 单列堆叠，优化触摸交互

## 4. Features & Interactions 功能与交互

### 核心功能
1. **导航系统**
   - 固定顶部，滚动时添加背景模糊
   - Logo点击返回顶部
   - 平滑滚动到各区块

2. **Hero区域**
   - 打字机效果显示标语
   - CTA按钮脉冲动画吸引点击
   - 背景blob持续漂浮动画

3. **文章卡片**
   - 悬停时整体上浮+阴影加深
   - 标签颜色映射
   - 阅读量/日期显示
   - 点击进入文章（示意）

4. **标签云**
   - 随机旋转角度(-15°到15°)
   - 悬停放大+颜色变化
   - 尺寸与文章数量相关

5. **社交链接**
   - 圆形图标按钮
   - 悬停时填充渐变色
   - 点击涟漪效果

### 交互细节
- 所有可点击元素: cursor: pointer
- 过渡时间: 200ms ease-out (快速) / 400ms ease-out (强调)
- 点击反馈: 短暂 scale(0.98) 压缩

## 5. Component Inventory 组件清单

### 导航栏 NavBar
- 默认: 透明背景，高度80px
- 滚动后: 玻璃背景 (backdrop-filter: blur(20px))
- Logo: 渐变文字，hover时发光

### 按钮 Button
- Primary: 渐变背景，白色文字，圆角胶囊
- Secondary: 透明背景，渐变边框
- Ghost: 无边框，hover显示背景
- 状态: hover放大+阴影，点击压缩

### 卡片 Card
- 玻璃态背景 (rgba(255,255,255,0.05))
- 大圆角 (24px)
- hover: 边框渐变发光，上浮8px
- 内部: 标题+摘要+标签+元信息

### 标签 Tag
- 小圆角 (8px)
- 背景色根据类别变化
- hover时放大

### 头像 Avatar
- 大圆角方形 (24px)
- 双层渐变边框
- hover时旋转

### 输入框 Input
- 玻璃态背景
- focus时边框发光
- placeholder渐变文字

## 6. Technical Approach 技术方案

### 技术栈
- 纯HTML5 + CSS3
- Vanilla JavaScript (无框架依赖)
- Google Fonts CDN
- Marked.js (Markdown渲染)
- 内联SVG图标

### 关键实现
- CSS Grid + Flexbox 混合布局
- CSS Custom Properties 管理主题
- Intersection Observer 实现滚动动画
- CSS @keyframes 实现所有动画
- 响应式媒体查询断点
- URL参数传递文章slug

### 文章系统实现
1. **文章存储**: Markdown文件存放在 `articles/` 目录
2. **文章索引**: `articles.json` 配置所有文章元数据
3. **Front Matter**: 文章头部YAML格式元数据
4. **Markdown渲染**: 使用Marked.js实时解析
5. **URL路由**: `article.html?slug=xxx` 访问详情

### 性能优化
- 延迟加载非首屏内容
- 使用 transform/opacity 实现动画
- 避免布局抖动
- 异步加载Marked.js库
