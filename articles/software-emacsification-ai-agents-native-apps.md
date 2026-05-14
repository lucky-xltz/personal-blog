---
title: "软件的Emacs化：当AI代理让每个人都能写原生应用"
date: 2026-05-14
category: 技术
tags: [AI编程, 原生开发, Emacs, Electron, SwiftUI, 软件工程, AI代理]
author: 林小白
readtime: 12
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# 软件的Emacs化：当AI代理让每个人都能写原生应用

> "你想要的不是一个好的Markdown查看器——你想要的是一个完全为你定制的工具。"

安全研究员 Thomas Ptacek 在2026年5月发表了一篇引发热议的文章，提出了一个精妙的概念：**软件正在经历"Emacs化"（Emacsification）**。这个观察不仅准确描述了AI时代软件开发的范式转变，更揭示了一个深刻的趋势——**个人原生软件正在复兴**。

让我们深入探讨这个概念的技术内涵，以及它对我们每个开发者意味着什么。

## 什么是Emacs化？

### Emacs文化的核心

要理解"Emacs化"，首先要理解Emacs社区独特的文化基因。

Emacs不仅仅是一个文本编辑器——它是一个**可编程平台**。Emacs用户（尤其是深度用户）有一种独特的习惯：他们会用Emacs Lisp（elisp）编写大量个人工具。这些工具通常从解决一个具体的文本编辑痛点开始，然后不断膨胀，突破文本编辑器应有的边界。

打开任何一个Emacs用户的配置文件（`.emacs`或`init.el`），你会发现里面充满了各种自制的"应用"：

- 邮件客户端（mu4e、notmuch）
- 日程管理（org-mode）
- Git界面（Magit——可能是最好的Git客户端）
- RSS阅读器（elfeed）
- 甚至有人在里面跑数据库查询

Emacs社区的文化是：**0% Product Hunt，100% show-and-tell**。人们不是在发布产品，而是在展示自己定制的工具。代码本身不重要，重要的是**想法**——"是的，你可以这样做，而且效果很好"。

### AI代理如何"压裂"了这种文化

Ptacek用了一个绝妙的比喻：AI代理"压裂"（frack）了Emacs文化，让它从封闭的elisp世界泄漏到了更广泛的软件开发领域。

**核心洞察**：AI代理让原生UI开发变得像写elisp一样随意。

过去，构建一个原生macOS应用需要：
- 掌握Swift/SwiftUI
- 理解AppKit的生命周期
- 处理签名、沙盒、公证
- 投入大量时间在UI细节上

现在，你只需要描述你想要什么，AI代理就能生成一个可工作的原生应用。Ptacek用Claude在30分钟内构建了一个比App Store上所有同类产品都好的Markdown查看器（MDV.app）。

## 为什么这很重要？

### Electron的困境

我们来谈谈房间里的大象——Electron。

Electron的核心承诺是：用Web技术构建跨平台桌面应用。这个承诺在过去10年里确实"够用了"。但代价是巨大的：

```
一个典型的Electron应用：
├── 完整的Chromium浏览器引擎（~150MB）
├── Node.js运行时（~50MB）
├── 你的应用代码（~5MB）
└── 内存占用：300-800MB

一个等效的原生应用：
├── 应用代码（~5MB）
├── 系统框架（已安装）
└── 内存占用：30-80MB
```

更糟糕的是性能问题。Ptacek描述了一个令人印象深刻的症状：每次有人给他发Signal消息，他的屏幕就会闪烁——因为Signal是Electron应用，每个实例都携带一个独立的Chromium渲染引擎。

**Electron不是好的，但它一直"够用"**。直到现在。

### 原生开发的人才瓶颈

为什么Electron能统治桌面应用开发？不仅仅是因为"一次编写，到处运行"。更根本的原因是：**原生UI开发者太稀缺了**。

以macOS为例：
- 能熟练使用SwiftUI的开发者数量有限
- 理解AppKit深层机制的人更少
- 同时具备设计感和工程能力的人更是凤毛麟角

这意味着，即使你有构建原生应用的需求，你也很难找到合适的人来实现它。

**AI代理彻底改变了这个等式。**

## 技术实现：AI代理如何构建原生应用

### 一个实际的例子

让我们看一个具体的例子。假设你想构建一个简单的系统监控工具，用SwiftUI实现：

```swift
import SwiftUI

struct SystemMonitorView: View {
    @State private var cpuUsage: Double = 0.0
    @State private var memoryUsage: Double = 0.0
    @State private var diskUsage: Double = 0.0
    @State private var refreshTimer: Timer?
    
    var body: some View {
        VStack(spacing: 16) {
            // 标题
            HStack {
                Image(systemName: "cpu")
                    .font(.title2)
                    .foregroundColor(.accentColor)
                Text("System Monitor")
                    .font(.headline)
                Spacer()
            }
            
            // CPU 使用率
            UsageCard(
                title: "CPU",
                icon: "cpu",
                value: cpuUsage,
                color: cpuUsage > 80 ? .red : .green
            )
            
            // 内存使用率
            UsageCard(
                title: "Memory",
                icon: "memorychip",
                value: memoryUsage,
                color: memoryUsage > 80 ? .red : .blue
            )
            
            // 磁盘使用率
            UsageCard(
                title: "Disk",
                icon: "internaldrive",
                value: diskUsage,
                color: diskUsage > 90 ? .red : .orange
            )
        }
        .padding(20)
        .frame(width: 300)
        .onAppear {
            startMonitoring()
        }
        .onDisappear {
            refreshTimer?.invalidate()
        }
    }
    
    private func startMonitoring() {
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { _ in
            updateMetrics()
        }
    }
    
    private func updateMetrics() {
        // 通过系统命令获取指标
        cpuUsage = getCPUUsage()
        memoryUsage = getMemoryUsage()
        diskUsage = getDiskUsage()
    }
}

struct UsageCard: View {
    let title: String
    let icon: String
    let value: Double
    let color: Color
    
    var body: some View {
        HStack {
            Image(systemName: icon)
                .font(.title3)
                .foregroundColor(color)
                .frame(width: 30)
            
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                
                ProgressView(value: value / 100)
                    .progressViewStyle(LinearProgressViewStyle(tint: color))
            }
            
            Text(String(format: "%.1f%%", value))
                .font(.system(.body, design: .monospaced))
                .foregroundColor(color)
                .frame(width: 60, alignment: .trailing)
        }
        .padding(12)
        .background(Color(.controlBackgroundColor))
        .cornerRadius(8)
    }
}

// 系统指标获取函数
func getCPUUsage() -> Double {
    let task = Process()
    task.launchPath = "/usr/bin/top"
    task.arguments = ["-l", "1", "-n", "0"]
    
    let pipe = Pipe()
    task.standardOutput = pipe
    task.launch()
    
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    let output = String(data: data, encoding: .utf8) ?? ""
    
    // 解析CPU使用率
    if let range = output.range(of: "CPU usage:") {
        let substring = output[range.upperBound...]
        if let endRange = substring.range(of: "user") {
            let usageStr = substring[..<endRange.lowerBound]
                .trimmingCharacters(in: .whitespaces)
            return Double(usageStr.replacingOccurrences(of: "%", with: "")) ?? 0
        }
    }
    return 0
}
```

这段代码展示了SwiftUI的声明式UI范式。AI代理能够：
1. 理解你的需求描述
2. 生成符合平台规范的代码
3. 处理系统API的复杂性
4. 自动处理错误情况

### 与传统开发流程的对比

| 维度 | 传统原生开发 | AI代理辅助开发 |
|------|------------|--------------|
| 学习曲线 | 陡峭（Swift/AppKit） | 平缓（自然语言描述） |
| 开发时间 | 数天到数周 | 数小时 |
| 代码质量 | 依赖开发者水平 | 通常达到专业水准 |
| 可维护性 | 高 | 需要审查和调整 |
| 定制化程度 | 完全可控 | 需要精确描述 |

## 架构层面的思考

### 个人软件的架构模式

Emacs化带来的不仅是开发方式的变化，更是架构思维的转变。

**传统软件架构**关注：
- 可扩展性（Scalability）
- 可维护性（Maintainability）
- 团队协作（Collaboration）
- 用户多样性（User Diversity）

**个人软件架构**关注：
- 即时满足（Instant Gratification）
- 精确适配（Precise Fit）
- 快速迭代（Rapid Iteration）
- 个人偏好（Personal Preference）

这意味着我们可以采用更激进的架构决策：

```python
# 个人软件的架构示例：一个定制的日志分析器

class PersonalLogAnalyzer:
    """
    这不是给团队用的，这是给我自己用的。
    没有配置文件，没有插件系统，没有向后兼容性。
    如果需要改，我直接让AI改代码。
    """
    
    def __init__(self):
        # 硬编码我的日志路径，因为只有我用
        self.log_paths = [
            "/var/log/nginx/access.log",
            "/var/log/nginx/error.log",
            "~/.local/share/app/app.log",
        ]
        
        # 硬编码我关心的模式
        self.patterns = {
            "error": r"ERROR|FATAL|Exception",
            "slow_query": r"query took (\d+)ms",
            "memory_warning": r"memory pressure|OOM",
        }
        
        # 硬编码我想要的输出格式
        self.output_format = "markdown"  # 因为我用Obsidian看
    
    def analyze(self):
        """分析日志，给我看我关心的东西"""
        results = []
        
        for path in self.log_paths:
            with open(path, 'r') as f:
                content = f.read()
            
            for name, pattern in self.patterns.items():
                matches = re.findall(pattern, content)
                if matches:
                    results.append({
                        "file": path,
                        "pattern": name,
                        "count": len(matches),
                        "samples": matches[:5]  # 只看前5个
                    })
        
        return self.format_output(results)
    
    def format_output(self, results):
        """格式化为Markdown，因为我喜欢"""
        lines = ["# Log Analysis Report\n"]
        
        for r in results:
            lines.append(f"## {r['pattern']} in {r['file']}")
            lines.append(f"- Found: {r['count']} occurrences")
            lines.append("- Samples:")
            for s in r['samples']:
                lines.append(f"  - `{s}`")
            lines.append("")
        
        return "\n".join(lines)
```

这段代码在"传统"标准下是"错误"的：硬编码路径、没有配置、没有错误处理。但对于个人软件来说，这是**完美的**——因为它精确地解决了我的问题，而且当需求变化时，我可以让AI直接修改它。

### 模块化的新含义

在Emacs化范式下，"模块化"有了新的含义：

**传统模块化**：将系统分解为可复用的组件，通过接口通信。

**Emacs化模块化**：每个工具都是独立的、完整的、为特定任务定制的。它们不需要"复用"，因为创建新工具的成本已经足够低。

```
传统思维：
┌─────────────┐
│   通用框架    │
├─────────────┤
│  插件系统     │
├─────────────┤
│  用户配置     │
└─────────────┘

Emacs化思维：
┌──────┐ ┌──────┐ ┌──────┐
│工具 A │ │工具 B │ │工具 C │  ← 每个都是完整的
└──────┘ └──────┘ └──────┘
   │         │         │
   └─────────┼─────────┘
             ↓
        你的工作流
```

## 实践指南：如何拥抱Emacs化

### 第一步：识别你的痛点

Emacs化的核心是**解决个人痛点**。问自己：

1. 你每天重复做哪些事情？
2. 哪些现有工具"够用但不爽"？
3. 你希望工具怎样工作？

例如：
- "我希望有一个命令行工具，能用自然语言查询我的笔记"
- "我希望有一个小窗口，实时显示我的服务器状态"
- "我希望有一个工具，能自动整理我的下载文件夹"

### 第二步：选择正确的技术栈

根据目标平台选择技术：

| 平台 | 推荐技术栈 | AI代理友好度 |
|------|-----------|------------|
| macOS桌面 | SwiftUI + AppKit | ⭐⭐⭐⭐⭐ |
| Windows桌面 | WPF / WinUI 3 | ⭐⭐⭐⭐ |
| Linux桌面 | GTK4 + Python | ⭐⭐⭐⭐ |
| 命令行 | Python / Rust | ⭐⭐⭐⭐⭐ |
| Web工具 | HTML + JS（单文件） | ⭐⭐⭐⭐⭐ |
| 移动端 | SwiftUI / Jetpack Compose | ⭐⭐⭐ |

### 第三步：与AI代理协作

有效的AI代理协作不是"帮我写个应用"，而是：

**不好的提示**：
> "帮我写一个系统监控工具"

**好的提示**：
> "帮我用SwiftUI写一个macOS菜单栏应用，要求：
> 1. 显示CPU、内存、磁盘使用率
> 2. 每2秒刷新一次
> 3. 使用SF Symbols图标
> 4. 颜色随使用率变化（绿→黄→红）
> 5. 点击显示详细信息弹窗
> 6. 使用macOS的系统指标API"

关键在于**具体的约束条件**，而不是模糊的描述。

### 第四步：快速迭代

Emacs化的核心优势是**快速迭代**：

```
第一轮：基本功能
        ↓ 测试，发现问题
第二轮：修复问题，添加功能
        ↓ 使用一周，收集反馈
第三轮：优化体验，调整细节
        ↓ 满意？发布或继续
```

每一轮迭代的成本都很低（因为AI代理做大部分工作），所以你可以快速尝试不同的设计方案。

## 对软件行业的影响

### Electron会消亡吗？

短期内不会。Electron的跨平台优势仍然存在，而且庞大的生态系统不会一夜消失。

但长期来看，原生应用会重新获得竞争力：
- AI代理降低了原生开发的门槛
- 用户对性能和体验的要求越来越高
- 操作系统提供的原生能力越来越强

### "开发者"的定义在扩展

过去，"开发者"意味着掌握编程语言、框架、工具链。

现在，"开发者"越来越多地意味着：
- 能清晰地描述需求
- 能评估AI生成的代码质量
- 能进行有效的迭代

这是一个**民主化**的过程——更多人能够创建自己的工具。

### 开源的新形态

Emacs化可能催生开源的新形态：

**传统开源**：发布源代码，社区贡献。
**Emacs化开源**：发布提示词和设计思路，社区用AI重新实现。

```markdown
# README.md

## 如何使用

1. 安装 Claude Desktop
2. 复制下面的提示词
3. 根据你的需求调整参数
4. 运行，获得你自己的版本

## 提示词

> 创建一个macOS菜单栏应用，用于监控...
> [完整的提示词]
```

## 总结与展望

软件的Emacs化不是一个遥远的趋势——它**正在发生**。

Ptacek的观察揭示了一个深刻的转变：AI代理不仅改变了我们编写软件的方式，更改变了我们与软件的关系。当创建一个原生应用的成本从"数周"降到"30分钟"，软件就不再是"发布的产品"，而是"个人的工具"。

这呼应了Emacs文化的核心精神：**软件应该是可塑的，应该服从于你的意志，而不是反过来**。

对于开发者来说，这意味着：
1. 不要再忍受"够用但不爽"的工具
2. 学习如何有效地与AI代理协作
3. 拥抱个人软件的理念
4. 分享你的提示词和设计思路

对于行业来说，这意味着：
1. 原生开发将重新获得竞争力
2. "开发者"的定义将继续扩展
3. 开源文化将演化出新的形态

最后，用Ptacek的话来总结：

> "构建原生UI现在很有趣——比构建Web界面有趣得多。试试看，做一些完全针对你自己问题的愚蠢定制工具，享受一段时间，然后分享出去。或者更好的是，只分享你用来构建它的提示词。"

**软件的未来不是更大的框架，而是更小的、更个人的、更精确的工具。**

---

*相关阅读：*

- [AI 编码的「上帝对象」陷阱：为什么无约束的 Vibe Coding 会产出不可维护的代码](/article?slug=ai-coding-god-object-trap)
- [Agent Skills：给 AI 编码代理装上「高级工程师骨架」](/article?slug=agent-skills-ai-coding)
- [AI 漏洞猎人：当 Mythos 遇上 curl 和 Firefox](/article?slug=ai-vulnerability-hunter-mythos)

---

*参考来源：*
- [The Emacsification of Software](https://sockpuppet.org/blog/2026/05/12/emacsification/) - Thomas Ptacek
