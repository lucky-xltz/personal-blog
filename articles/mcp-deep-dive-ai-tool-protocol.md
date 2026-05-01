---
title: "深入理解 Model Context Protocol：AI 工具调用的统一标准"
date: 2026-05-01
category: 技术
tags: [MCP, AI工具调用, 协议设计, LLM, 分布式系统, 互操作性]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1677442136019-21780ecad995?w=600&h=400&fit=crop
---

# 深入理解 Model Context Protocol：AI 工具调用的统一标准

当大语言模型从"聊天机器人"进化为"智能代理"，一个根本性问题浮出水面：**如何让 AI 安全、高效、标准化地连接外部世界？** 每个 AI 应用各自为政地对接各种工具和数据源，导致了 N\u00d7M 的集成噩梦。

2024 年底，Anthropic 推出了 **Model Context Protocol（MCP）**——一个开源的、基于 JSON-RPC 2.0 的标准协议，旨在成为 AI 工具调用的"USB-C 接口"。到 2025 年底，MCP 已经被 Claude、ChatGPT、VS Code、Cursor 等主流产品采纳，并被纳入 Linux Foundation 治理。

本文将从协议设计哲学出发，深入剖析 MCP 的架构、传输层、核心原语、安全模型，以及如何从零构建一个 MCP Server。

## 为什么需要 MCP？

在 MCP 出现之前，AI 工具集成面临的核心问题是 **N\u00d7M 复杂度**：

- **N 个 AI 应用**（Claude、ChatGPT、Copilot、Cursor......）
- **M 个外部系统**（GitHub、Slack、数据库、文件系统、API......）

每个 AI 应用需要为每个外部系统编写定制集成代码。这意味着 N\u00d7M 个适配器。当一方更新接口，所有对应适配器都需要同步修改。

MCP 将这个问题简化为 **N+M**：每个 AI 应用实现一次 MCP Client，每个外部系统实现一次 MCP Server，协议层负责互操作。

这与 **Language Server Protocol（LSP）** 的设计哲学完全一致。在 LSP 之前，每个编辑器需要为每种编程语言实现代码补全、跳转定义、错误检查等功能——同样是 N\u00d7M 问题。LSP 将语言智能抽离为独立的 Language Server，编辑器只需实现一次 LSP Client。MCP 将同样的思路应用到了 AI 工具调用领域。

## 架构设计

### 三个核心角色

MCP 定义了三个关键参与者：

- **MCP Host**：AI 应用本身，负责协调和管理多个 MCP Client。例如 Claude Desktop、VS Code
- **MCP Client**：Host 内部的组件，每个 Client 维护与一个 MCP Server 的 1:1 连接
- **MCP Server**：提供上下文（工具、资源、提示词模板）的外部程序

关键设计原则：**每个 Client 只连接一个 Server**。这种 1:1 映射避免了多路复用带来的复杂性，让每个连接都是独立的、可隔离的。

Local servers（通过 stdio）通常服务单个 client；Remote servers（通过 Streamable HTTP）可以同时服务多个 client。

### 双层架构

MCP 由两个概念层组成：

| 层级 | 职责 | 关键要素 |
|------|------|----------|
| **数据层（Data Layer）** | 定义 JSON-RPC 消息格式、语义、生命周期 | 消息类型、能力协商、原语 |
| **传输层（Transport Layer）** | 定义连接机制、消息帧、授权 | stdio、Streamable HTTP |

两层分离意味着同一套 JSON-RPC 消息可以跑在不同传输上——本地进程用 stdio，远程服务用 HTTP，甚至可以用 WebSocket 或自定义通道。

## 协议细节

### JSON-RPC 2.0 基础

MCP 完全基于 JSON-RPC 2.0，使用三种消息类型：

**Request**（有 id，期待响应）：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "read_file",
    "arguments": { "path": "/etc/hosts" }
  }
}
```

**Response**（有 id，无 method）：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "127.0.0.1 localhost" }]
  }
}
```

**Notification**（无 id，不期待响应）：

```json
{
  "jsonrpc": "2.0",
  "method": "notifications/tools/list_changed"
}
```

所有消息必须是 **UTF-8 编码**，每条消息占一行（换行符分隔），消息内部不得包含嵌入换行符。

### 生命周期管理

MCP 连接有三个阶段：

**1. 初始化（Initialization）**

连接建立后，双方进行能力协商。Client 发送 `initialize` 请求，包含 `protocolVersion`、`capabilities` 和 `clientInfo`。Server 回复自己的版本信息、能力集和 `serverInfo`。最后 Client 发送 `notifications/initialized` 确认就绪。

版本号采用 **日期格式**（`YYYY-MM-DD`），当前最新版本是 `2025-11-25`。如果版本不兼容，Client 应主动断开连接。

**2. 正常运行（Operation）**

双方按照协商好的能力集进行通信。能力之外的请求应被拒绝。

**3. 关闭（Shutdown）**

- stdio 传输：关闭 stdin \u2192 等待 \u2192 SIGTERM \u2192 SIGKILL
- HTTP 传输：关闭 HTTP 连接

### 能力协商

初始化时双方声明各自支持的能力：

| 方向 | 能力 | 说明 |
|------|------|------|
| Client \u2192 Server | `roots` | 文件系统根目录 |
| Client \u2192 Server | `sampling` | 支持 LLM 采样请求 |
| Client \u2192 Server | `elicitation` | 支持用户输入请求 |
| Server \u2192 Client | `tools` | 提供可调用工具 |
| Server \u2192 Client | `resources` | 提供可读资源 |
| Server \u2192 Client | `prompts` | 提供提示词模板 |
| Server \u2192 Client | `completions` | 参数自动补全 |
| Server \u2192 Client | `logging` | 结构化日志 |

子能力包括 `listChanged`（列表变更通知）和 `subscribe`（资源级订阅）。

## 传输层

### stdio：本地进程通信

最简单也最高效的传输方式。Client 启动 Server 作为子进程，Server 从 stdin 读取 JSON-RPC 消息，向 stdout 写入响应，stderr 用于日志。

**优点：** 零网络开销，延迟极低；无需端口管理、无需 TLS；进程级隔离，安全性好。

**适用场景：** 本地工具（文件系统操作、代码分析、Git 操作）。

### Streamable HTTP：远程服务通信

这是 MCP 的远程传输方案（取代了早期的 HTTP+SSE）：

- **单一端点**：所有通信通过一个 URL（如 `https://api.example.com/mcp`）
- **POST 发送**：Client 通过 POST 发送 JSON-RPC 消息，Accept 头设为 `application/json, text/event-stream`
- **灵活响应**：Server 可以返回单条 JSON（`application/json`）或 SSE 流（`text/event-stream`）
- **主动推送**：Client 通过 GET 请求打开 SSE 流，接收 Server 主动推送的消息
- **会话管理**：可选的 `Mcp-Session-Id` 头维护状态
- **可恢复性**：SSE event ID + `Last-Event-ID` 头支持断线重连
- **版本头**：所有 HTTP 请求必须包含 `MCP-Protocol-Version` 头

**安全要求：** Server 必须验证 `Origin` 头（防止 DNS 重绑定攻击）；本地 Server 应仅绑定 `127.0.0.1`；应实现标准 HTTP 认证（Bearer Token、API Key、OAuth）。

### 自定义传输

协议是传输无关的。任何双向通道都可以作为 MCP 传输——只需保留 JSON-RPC 格式和生命周期要求。

## 四大核心原语

MCP 定义了四种核心原语，分为 Server 端和 Client 端。

### 1. Tools（模型控制）

工具是 AI 可以调用的可执行函数——文件操作、API 调用、数据库查询等。

- **模型控制**：LLM 自主发现和调用工具
- 每个工具有 `name`、`title`、`description`、`inputSchema`（JSON Schema）
- 可选的 `outputSchema` 和 `annotations`（安全提示：`readOnlyHint`、`destructiveHint` 等）
- 通过 `tools/list` 发现（支持分页），通过 `tools/call` 执行
- 错误处理：协议错误用 JSON-RPC error；执行错误用 `isError: true` 返回

### 2. Resources（应用控制）

资源是提供上下文信息的数据源——文件内容、数据库 Schema、API 响应等。

- **应用控制**：Host 决定如何使用资源内容
- 通过 **URI** 标识（`file://`、`https://`、`git://` 或自定义 scheme）
- 通过 `resources/list` 发现，通过 `resources/read` 读取
- 支持 **订阅**（`resources/subscribe`）和变更通知
- 内容可以是文本或 base64 编码的二进制
- 注解支持 `audience`（可见对象）和 `priority`（优先级）

### 3. Prompts（用户控制）

提示词是可复用的交互模板——系统提示、Few-shot 示例等。

- **用户控制**：在 UI 中呈现供用户选择
- 通过 `prompts/list` 发现，通过 `prompts/get` 获取（支持参数化）
- 消息可以包含文本、图片、音频、嵌入资源

### 4. Sampling（服务端请求客户端 LLM）

这是一个独特的设计——允许 MCP Server 反向请求 Client 的 LLM 进行推理：

- **无需 API Key**：Server 借用 Client 的 LLM 访问权限
- **Client 保持控制**：用户必须显式批准采样请求
- **模型偏好**：Server 可通过 `modelPreferences` 建议（但不强制）特定模型
- 协议有意限制了 Server 对 prompt 的可见性

### 5. Elicitation（服务端请求用户输入）

2025 年新增的能力——Server 可以请求用户提供额外信息或确认。例如，删除文件前请求用户确认。

## 从零构建一个 MCP Server

### TypeScript 实现

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs/promises";

const server = new McpServer({
  name: "filesystem-readonly",
  version: "1.0.0",
});

// 注册工具：读取文件
server.tool(
  "read_file",
  "读取指定路径的文件内容",
  { path: z.string().describe("文件的绝对路径") },
  async ({ path }) => {
    try {
      const content = await fs.readFile(path, "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error: ${error.message}` }],
      };
    }
  }
);

// 注册工具：列出目录
server.tool(
  "list_directory",
  "列出目录中的文件和子目录",
  { path: z.string().describe("目录路径") },
  async ({ path }) => {
    const entries = await fs.readdir(path, { withFileTypes: true });
    const listing = entries.map(
      (e) => `${e.isDirectory() ? "[DIR]" : "[FILE]"} ${e.name}`
    );
    return { content: [{ type: "text", text: listing.join("\n") }] };
  }
);

// 启动
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Python 实现

```python
from mcp.server.fastmcp import FastMCP
import os

mcp = FastMCP("filesystem-readonly")

@mcp.tool()
def read_file(path: str) -> str:
    """读取指定路径的文件内容"""
    with open(path, "r") as f:
        return f.read()

@mcp.tool()
def list_directory(path: str) -> str:
    """列出目录中的文件和子目录"""
    entries = os.listdir(path)
    result = []
    for entry in entries:
        full = os.path.join(path, entry)
        prefix = "[DIR]" if os.path.isdir(full) else "[FILE]"
        result.append(f"{prefix} {entry}")
    return "\n".join(result)

if __name__ == "__main__":
    mcp.run(transport="stdio")
```

### 配置客户端连接

在 Claude Desktop 中配置（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "node",
      "args": ["path/to/server.js"],
      "env": { "ALLOWED_PATHS": "/home/user/projects" }
    }
  }
}
```

## 安全模型

MCP 的安全设计建立在四个核心原则之上：

### 1. 用户同意与控制

所有数据访问和操作必须获得用户**显式同意**。用户保留对数据共享范围和操作执行的**完全控制权**。Host 必须提供清晰的 UI 用于审查和授权。

### 2. 数据隐私

Host 必须在向 Server 暴露数据前获得用户同意。未经用户许可，不得将资源数据传输到其他地方。

### 3. 工具安全

工具代表**任意代码执行**——必须谨慎对待。工具的注解和描述来自 Server，**不可信**（除非 Server 可信）。调用任何工具前必须获得用户同意。建议始终保留 Human-in-the-loop（人类在环）。

### 4. 采样控制

用户必须显式批准采样请求。用户控制：是否执行采样、实际 prompt 内容、Server 能看到的结果。

### 实施指南

- Server 端：验证所有输入、实现访问控制、速率限制、输出净化
- Client 端：敏感操作确认提示、结果验证、超时设置、审计日志

## 生态系统现状

截至 2026 年初，MCP 生态已相当成熟：

### 主要客户端

| 客户端 | 类型 | MCP 支持 |
|--------|------|----------|
| Claude Desktop | AI 助手 | 原生支持 |
| ChatGPT | AI 助手 | 原生支持 |
| VS Code | IDE | 内置支持 |
| Cursor | AI IDE | 内置支持 |

### SDK 矩阵

| 语言 | SDK | 成熟度 |
|------|-----|--------|
| TypeScript | `@modelcontextprotocol/sdk` | 生产就绪 |
| Python | `mcp` | 生产就绪 |
| Java/Kotlin | `io.modelcontextprotocol:sdk` | 稳定 |
| C# | `ModelContextProtocol` | 稳定 |
| Swift | `mcp-swift-sdk` | 稳定 |

### 版本演进

MCP 采用日期版本号，当前最新版本是 `2025-11-25`。版本向后兼容的变更不会递增版本号，只有破坏性变更才会发布新版本。MCP 已被纳入 Linux Foundation 治理。

## 最佳实践与常见陷阱

### 应该做的

1. **能力最小化**：Server 只声明实际支持的能力，Client 只请求需要的能力
2. **输入验证**：Server 必须验证所有输入参数，使用 JSON Schema 严格约束
3. **错误处理**：区分协议错误（JSON-RPC error）和业务错误（`isError: true`）
4. **幂等性**：关键操作应设计为幂等的，防止重试导致副作用
5. **超时控制**：Client 应设置合理的请求超时，避免无限等待
6. **日志审计**：利用 `logging` 能力记录所有操作，便于事后审计

### 常见陷阱

1. **信任 Server 描述**：工具的 `description` 和 `annotations` 可能被恶意 Server 操纵
2. **忽略版本协商**：不检查 `protocolVersion` 会导致静默的协议不兼容
3. **在工具中硬编码敏感信息**：API Key 等应通过环境变量注入
4. **过度暴露能力**：Server 不应暴露它不应有的权限
5. **忽略 HTTP 安全要求**：不验证 `Origin` 头可能导致 DNS 重绑定攻击

## 与其他方案的对比

| 维度 | MCP | Function Calling | LangChain Tools | OpenAPI/Swagger |
|------|-----|-----------------|-----------------|-----------------|
| 标准化 | 开放标准（LF 治理） | 厂商私有 | 框架特定 | API 文档标准 |
| 双向通信 | 支持 | 不支持 | 不支持 | 不支持 |
| 原语类型 | 工具+资源+提示词 | 仅工具 | 仅工具 | 仅 API 定义 |
| 传输灵活性 | 多种传输 | 绑定 API | 绑定框架 | HTTP |
| 生态互操作 | 跨 AI 平台 | 绑定特定模型 | 绑定 Python | 通用 |
| 状态管理 | 有状态连接 | 无状态 | 无状态 | 无状态 |

MCP 的核心优势在于：它不仅仅是一个工具调用协议，而是一个完整的**上下文交换协议**——涵盖工具、数据资源、提示词模板和双向通信。

## 总结

MCP 代表了 AI 工具调用从"各自为政"走向"标准化互操作"的关键一步。它的设计哲学——借鉴 LSP 的成功经验，通过客户端-服务器架构实现 N\u00d7M 到 N+M 的简化——已经被实践证明是正确的。

对开发者而言，MCP 提供了一个清晰的投资方向：实现一次 MCP Server，就能被所有支持 MCP 的 AI 应用使用；实现一次 MCP Client，就能接入所有 MCP Server 生态。这种互操作性的价值，随着 AI 应用的普及只会越来越大。

如果你正在构建 AI 代理、IDE 插件或任何需要与外部系统交互的 AI 应用，现在就是深入了解和采用 MCP 的最佳时机。

---

*相关阅读：*

- [eBPF 深度实战：Linux 内核可编程革命的原理、工具与生产实践](/article/ebpf-deep-dive-linux-kernel-revolution)
- [深入解析 Cloudflare 可观测性平台：ClickHouse、Kafka 与 AI 驱动的错误分析](/article/cloudflare-observability-deep-dive)
- [WebAssembly GC 深度解析：告别自带垃圾回收器的时代](/article/webassembly-gc-deep-dive)
