---
title: "MCP：统一 AI 工具集成的开放协议，让大模型连接万物"
date: 2026-05-04
category: 技术
tags: [MCP, AI, 大模型, 工具集成, 协议设计]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
---

# MCP：统一 AI 工具集成的开放协议，让大模型连接万物

如果你用过 Claude Desktop 操控本地文件，或者在 Cursor 中让 AI 自动查询数据库，你已经在使用 MCP 了。Model Context Protocol（MCP）是 Anthropic 于 2024 年底发布的开放协议，旨在为 AI 应用与外部系统之间建立标准化的连接方式。

在过去，每个 AI 应用都需要为每个外部工具编写定制的集成代码——O(M \u00d7 N) 的复杂度让开发者苦不堪言。MCP 的出现将其简化为 O(M + N)：工具提供方只需实现一次 MCP Server，所有支持 MCP 的 AI 应用都能直接调用。

本文将深入剖析 MCP 的协议架构、核心概念，并手把手带你用 Python 构建一个自定义 MCP Server。

## 为什么需要 MCP？

### 集成的困境

在 MCP 出现之前，AI 工具集成面临三大痛点：

**1. 碎片化集成**：每个 AI 平台（ChatGPT、Claude、Copilot）都有自己的插件/工具协议，开发者需要为每个平台单独适配。

**2. 缺乏标准化**：工具的定义方式、参数传递、错误处理各不相同，没有统一规范。

**3. 安全与权限**：不同平台对工具调用的权限管理、沙箱隔离策略差异巨大，增加了安全审计的复杂度。

### MCP 的解决思路

MCP 用一个简洁的类比来解释自己：**它是 AI 应用的 USB-C 接口**。就像 USB-C 让任何设备都能通过同一根线连接显示器、硬盘或充电器，MCP 让任何 AI 应用都能通过同一协议连接数据库、文件系统、API 或硬件设备。

这种标准化带来了显著的收益：

- **开发者**：构建一次 MCP Server，所有客户端自动兼容
- **AI 应用**：接入一个 MCP Server，即获得该工具的全部能力
- **用户**：在任何支持 MCP 的应用中使用相同的工具集

## 协议架构深度解析

MCP 采用客户端-服务器架构，核心参与者有三个：

### 三个核心角色

```
+----------------------------------------------+
|              MCP Host\uff08\u5bbf\u4e3b\uff09               |
|         如 Claude Desktop / Cursor           |
|                                              |
|   +------------+  +------------+            |
|   | MCP Client |  | MCP Client |  ...       |
|   +-----+------+  +-----+------+            |
+---------+---------------+--------------------+
          |               |
   +------v------+  +-----v-------+
   | MCP Server  |  | MCP Server  |
   |  \u6587\u4ef6\u7cfb\u7edf    |  |  \u6570\u636e\u5e93      |
   +-------------+  +-------------+
```

- **MCP Host\uff08\u5bbf\u4e3b\uff09**：AI 应用本身，负责协调和管理多个 MCP Client
- **MCP Client\uff08\u5ba2\u6237\u7aef\uff09**：宿主为每个 Server 创建的连接实例，维持一对一的通信
- **MCP Server\uff08\u670d\u52a1\u7aef\uff09**：提供具体工具能力的程序，可以是本地进程或远程服务

### 两层协议设计

MCP 的协议分为两层：

**数据层\uff08Data Layer\uff09**：基于 JSON-RPC 2.0 的消息协议，定义了生命周期管理和核心原语（Tools、Resources、Prompts）。

**传输层\uff08Transport Layer\uff09**：定义通信通道，支持两种模式：

| 传输方式 | 适用场景 | 连接特点 |
|---------|---------|---------|
| STDIO | 本地进程 | Host 启动 Server 子进程，通过 stdin/stdout 通信 |
| Streamable HTTP | 远程服务 | HTTP POST + SSE 流式响应，支持认证和多租户 |

### 协议生命周期

一次完整的 MCP 会话包含三个阶段：

```
1. 初始化\uff08Initialize\uff09
   Client \u2192 Server: initialize\uff08\u534f\u8bae\u7248\u672c\u3001\u80fd\u529b\u58f0\u660e\uff09
   Server \u2192 Client: initialize \u7ed3\u679c
   Client \u2192 Server: initialized \u901a\u77e5

2. 正常通信
   Client \u2194 Server: \u5de5\u5177\u8c03\u7528\u3001\u8d44\u6e90\u8bfb\u53d6\u3001\u63d0\u793a\u83b7\u53d6

3. 关闭
   \u4efb\u4e00\u65b9\u53d1\u9001 close\uff0c\u65ad\u5f00\u8fde\u63a5
```

## 核心原语：Tools、Resources、Prompts

MCP 定义了三个核心原语，构成了 AI 工具集成的基础：

### Tools\uff08\u5de5\u5177\uff09

工具是最常用的原语，允许 AI 模型执行操作。每个工具包含：

```json
{
  "name": "query_database",
  "description": "\u6267\u884c SQL \u67e5\u8be2\u5e76\u8fd4\u56de\u7ed3\u679c",
  "inputSchema": {
    "type": "object",
    "properties": {
      "sql": {
        "type": "string",
        "description": "\u8981\u6267\u884c\u7684 SQL \u8bed\u53e5"
      },
      "database": {
        "type": "string",
        "description": "\u6570\u636e\u5e93\u540d\u79f0",
        "default": "main"
      }
    },
    "required": ["sql"]
  }
}
```

关键特点：
- 工具由**模型端发起调用**（model-controlled），AI 决定何时调用
- 支持 JSON Schema 定义输入参数，确保类型安全
- 返回结构化结果，包含文本、图片、资源引用等多种内容类型

### Resources\uff08\u8d44\u6e90\uff09

资源提供只读的数据访问，类似于 REST API 的 GET 端点：

```json
{
  "uri": "file:///home/user/project/README.md",
  "name": "\u9879\u76ee README",
  "mimeType": "text/markdown",
  "description": "\u9879\u76ee\u7684\u8bf4\u660e\u6587\u6863"
}
```

关键特点：
- 由**应用端发起读取**（application-controlled），UI 或应用逻辑决定何时获取
- 使用 URI 标识，支持文件、数据库记录、API 响应等多种数据源
- 支持订阅机制，数据变化时自动通知

### Prompts\uff08\u63d0\u793a\u6a21\u677f\uff09

提示模板是可复用的交互模式，为特定任务预定义好的 prompt 结构：

```json
{
  "name": "code_review",
  "description": "\u4ee3\u7801\u5ba1\u67e5\u63d0\u793a\u6a21\u677f",
  "arguments": [
    {
      "name": "language",
      "description": "\u7f16\u7a0b\u8bed\u8a00",
      "required": true
    },
    {
      "name": "code",
      "description": "\u5f85\u5ba1\u67e5\u7684\u4ee3\u7801",
      "required": true
    }
  ]
}
```

关键特点：
- 由**用户端发起选择**（user-controlled），通常在 UI 中呈现为可选操作
- 返回结构化的 messages 数组，包含 role 和 content
- 类似于"快捷指令"，封装了复杂的 prompt 工程

## 实战：用 Python 构建 MCP Server

理论讲够了，让我们动手构建一个实用的 MCP Server。我们将创建一个**系统监控 Server**，提供 CPU、内存、磁盘等系统信息查询。

### 环境准备

```bash
# 安装 MCP Python SDK
pip install mcp psutil

# 或使用 uv\uff08推荐\uff09
uv add mcp psutil
```

### 完整代码实现

```python
#!/usr/bin/env python3
"""\u7cfb\u7edf\u76d1\u63a7 MCP Server \u2014 \u63d0\u4f9b\u7cfb\u7edf\u8d44\u6e90\u67e5\u8be2\u5de5\u5177\u548c\u63d0\u793a\u6a21\u677f\u3002"""

import asyncio
import json
import platform
import shutil
from datetime import datetime

import psutil
from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import (
    TextContent,
    Tool,
    Prompt,
    PromptArgument,
    GetPromptResult,
    PromptMessage,
)

# \u521b\u5efa Server \u5b9e\u4f8b
app = Server("system-monitor")


# ============================================================
# 1. \u5b9a\u4e49 Tools\uff08\u5de5\u5177\uff09
# ============================================================
@app.list_tools()
async def list_tools():
    """\u58f0\u660e\u6240\u6709\u53ef\u7528\u5de5\u5177\u3002"""
    return [
        Tool(
            name="get_cpu_info",
            description="\u83b7\u53d6 CPU \u4f7f\u7528\u7387\u548c\u8be6\u7ec6\u4fe1\u606f\u3002\u8fd4\u56de\u6bcf\u4e2a\u6838\u5fc3\u7684\u4f7f\u7528\u7387\u3001\u603b\u4f53\u4f7f\u7528\u7387\u548c\u9891\u7387\u3002",
            inputSchema={
                "type": "object",
                "properties": {
                    "per_cpu": {
                        "type": "boolean",
                        "description": "\u662f\u5426\u8fd4\u56de\u6bcf\u4e2a\u6838\u5fc3\u7684\u8be6\u7ec6\u4f7f\u7528\u7387",
                        "default": True,
                    }
                },
            },
        ),
        Tool(
            name="get_memory_info",
            description="\u83b7\u53d6\u7cfb\u7edf\u5185\u5b58\u4f7f\u7528\u60c5\u51b5\uff0c\u5305\u62ec\u7269\u7406\u5185\u5b58\u548c\u4ea4\u6362\u5206\u533a\u3002",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="get_disk_info",
            description="\u83b7\u53d6\u78c1\u76d8\u4f7f\u7528\u60c5\u51b5\uff0c\u5305\u62ec\u6bcf\u4e2a\u6302\u8f7d\u70b9\u7684\u5bb9\u91cf\u548c\u4f7f\u7528\u7387\u3002",
            inputSchema={"type": "object", "properties": {}},
        ),
        Tool(
            name="get_top_processes",
            description="\u83b7\u53d6\u7cfb\u7edf\u4e2d\u5360\u7528\u8d44\u6e90\u6700\u591a\u7684\u8fdb\u7a0b\u5217\u8868\u3002",
            inputSchema={
                "type": "object",
                "properties": {
                    "count": {
                        "type": "integer",
                        "description": "\u8fd4\u56de\u7684\u8fdb\u7a0b\u6570\u91cf",
                        "default": 10,
                    },
                    "sort_by": {
                        "type": "string",
                        "enum": ["cpu", "memory"],
                        "description": "\u6392\u5e8f\u65b9\u5f0f\uff1a\u6309 CPU \u6216\u5185\u5b58\u4f7f\u7528\u7387",
                        "default": "cpu",
                    },
                },
            },
        ),
        Tool(
            name="get_network_info",
            description="\u83b7\u53d6\u7f51\u7edc\u63a5\u53e3\u7684\u6d41\u91cf\u7edf\u8ba1\u4fe1\u606f\u3002",
            inputSchema={"type": "object", "properties": {}},
        ),
    ]


# ============================================================
# 2. \u5b9e\u73b0 Tool \u5904\u7406\u903b\u8f91
# ============================================================
@app.call_tool()
async def call_tool(name: str, arguments: dict):
    """\u5904\u7406\u5de5\u5177\u8c03\u7528\u8bf7\u6c42\u3002"""

    if name == "get_cpu_info":
        per_cpu = arguments.get("per_cpu", True)
        cpu_percent = psutil.cpu_percent(interval=1, percpu=per_cpu)
        cpu_freq = psutil.cpu_freq()
        cpu_count = psutil.cpu_count()

        result = {
            "total_percent": cpu_percent if not per_cpu else sum(cpu_percent) / len(cpu_percent),
            "cpu_count": cpu_count,
            "frequency_mhz": cpu_freq.current if cpu_freq else None,
        }
        if per_cpu:
            result["per_cpu_percent"] = cpu_percent

        return [TextContent(type="text", text=json.dumps(result, indent=2))]

    elif name == "get_memory_info":
        mem = psutil.virtual_memory()
        swap = psutil.swap_memory()

        result = {
            "physical": {
                "total_gb": round(mem.total / (1024**3), 2),
                "used_gb": round(mem.used / (1024**3), 2),
                "available_gb": round(mem.available / (1024**3), 2),
                "percent": mem.percent,
            },
            "swap": {
                "total_gb": round(swap.total / (1024**3), 2),
                "used_gb": round(swap.used / (1024**3), 2),
                "percent": swap.percent,
            },
        }
        return [TextContent(type="text", text=json.dumps(result, indent=2))]

    elif name == "get_disk_info":
        partitions = psutil.disk_partitions()
        disks = []
        for p in partitions:
            try:
                usage = psutil.disk_usage(p.mountpoint)
                disks.append({
                    "device": p.device,
                    "mountpoint": p.mountpoint,
                    "fstype": p.fstype,
                    "total_gb": round(usage.total / (1024**3), 2),
                    "used_gb": round(usage.used / (1024**3), 2),
                    "free_gb": round(usage.free / (1024**3), 2),
                    "percent": usage.percent,
                })
            except PermissionError:
                continue
        return [TextContent(type="text", text=json.dumps(disks, indent=2))]

    elif name == "get_top_processes":
        count = arguments.get("count", 10)
        sort_by = arguments.get("sort_by", "cpu")

        processes = []
        for proc in psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent"]):
            try:
                info = proc.info
                processes.append(info)
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue

        key = "cpu_percent" if sort_by == "cpu" else "memory_percent"
        processes.sort(key=lambda x: x.get(key, 0) or 0, reverse=True)

        top = [
            {
                "pid": p["pid"],
                "name": p["name"],
                "cpu_percent": p.get("cpu_percent", 0),
                "memory_percent": round(p.get("memory_percent", 0), 2),
            }
            for p in processes[:count]
        ]
        return [TextContent(type="text", text=json.dumps(top, indent=2))]

    elif name == "get_network_info":
        counters = psutil.net_io_counters(pernic=True)
        network = {}
        for iface, stats in counters.items():
            network[iface] = {
                "bytes_sent_mb": round(stats.bytes_sent / (1024**2), 2),
                "bytes_recv_mb": round(stats.bytes_recv / (1024**2), 2),
                "packets_sent": stats.packets_sent,
                "packets_recv": stats.packets_recv,
                "errors_in": stats.errin,
                "errors_out": stats.errout,
            }
        return [TextContent(type="text", text=json.dumps(network, indent=2))]

    else:
        return [TextContent(type="text", text=f"\u672a\u77e5\u5de5\u5177: {name}")]


# ============================================================
# 3. \u5b9a\u4e49 Prompts\uff08\u63d0\u793a\u6a21\u677f\uff09
# ============================================================
@app.list_prompts()
async def list_prompts():
    """\u58f0\u660e\u53ef\u7528\u7684\u63d0\u793a\u6a21\u677f\u3002"""
    return [
        Prompt(
            name="system_health_check",
            description="\u6267\u884c\u5168\u9762\u7684\u7cfb\u7edf\u5065\u5eb7\u68c0\u67e5\u5e76\u751f\u6210\u62a5\u544a",
            arguments=[
                PromptArgument(
                    name="focus_area",
                    description="\u91cd\u70b9\u5173\u6ce8\u7684\u9886\u57df\uff1acpu/memory/disk/all",
                    required=False,
                )
            ],
        ),
        Prompt(
            name="troubleshoot_slow",
            description="\u7cfb\u7edf\u53d8\u6162\u65f6\u7684\u6392\u67e5\u6307\u5357\uff0c\u81ea\u52a8\u6536\u96c6\u8bca\u65ad\u4fe1\u606f",
            arguments=[],
        ),
    ]


@app.get_prompt()
async def get_prompt(name: str, arguments: dict):
    """\u8fd4\u56de\u63d0\u793a\u6a21\u677f\u7684\u7ed3\u6784\u5316\u6d88\u606f\u3002"""

    if name == "system_health_check":
        focus = arguments.get("focus_area", "all")
        return GetPromptResult(
            messages=[
                PromptMessage(
                    role="user",
                    content=TextContent(
                        type="text",
                        text=f"\u8bf7\u5bf9\u5f53\u524d\u7cfb\u7edf\u8fdb\u884c\u5168\u9762\u5065\u5eb7\u68c0\u67e5\u3002\n\n1. \u4f7f\u7528 get_cpu_info \u83b7\u53d6 CPU \u72b6\u6001\n2. \u4f7f\u7528 get_memory_info \u83b7\u53d6\u5185\u5b58\u72b6\u6001\n3. \u4f7f\u7528 get_disk_info \u83b7\u53d6\u78c1\u76d8\u72b6\u6001\n4. \u5982\u679c CPU \u6216\u5185\u5b58\u4f7f\u7528\u7387\u8d85\u8fc7 80%\uff0c\u4f7f\u7528 get_top_processes \u627e\u51fa\u5360\u7528\u8d44\u6e90\u6700\u591a\u7684\u8fdb\u7a0b\n\n\u91cd\u70b9\u5173\u6ce8\u9886\u57df\uff1a{focus}",
                    ),
                )
            ]
        )

    elif name == "troubleshoot_slow":
        return GetPromptResult(
            messages=[
                PromptMessage(
                    role="user",
                    content=TextContent(
                        type="text",
                        text="\u7cfb\u7edf\u611f\u89c9\u53d8\u6162\u4e86\uff0c\u8bf7\u5e2e\u6211\u6392\u67e5\u539f\u56e0\u3002\n\n1. \u83b7\u53d6 CPU \u4fe1\u606f\uff0c\u68c0\u67e5\u662f\u5426\u6709\u5f02\u5e38\u9ad8\u7684 CPU \u4f7f\u7528\u7387\n2. \u83b7\u53d6\u5185\u5b58\u4fe1\u606f\uff0c\u68c0\u67e5\u662f\u5426\u5185\u5b58\u4e0d\u8db3\u5bfc\u81f4\u9891\u7e41\u4ea4\u6362\n3. \u83b7\u53d6\u78c1\u76d8\u4fe1\u606f\uff0c\u68c0\u67e5\u662f\u5426\u78c1\u76d8\u7a7a\u95f4\u4e0d\u8db3\n4. \u83b7\u53d6\u5360\u7528\u8d44\u6e90\u6700\u591a\u7684\u524d 10 \u4e2a\u8fdb\u7a0b\n5. \u83b7\u53d6\u7f51\u7edc\u4fe1\u606f\uff0c\u68c0\u67e5\u662f\u5426\u6709\u5f02\u5e38\u6d41\u91cf\n\n\u57fa\u4e8e\u6536\u96c6\u5230\u7684\u6570\u636e\uff0c\u5206\u6790\u53ef\u80fd\u7684\u74f6\u9888\u5e76\u7ed9\u51fa\u5177\u4f53\u7684\u89e3\u51b3\u5efa\u8bae\u3002",
                    ),
                )
            ]
        )


# ============================================================
# 4. \u542f\u52a8 Server
# ============================================================
async def main():
    """\u901a\u8fc7 STDIO \u542f\u52a8 MCP Server\u3002"""
    async with stdio_server() as (read_stream, write_stream):
        await app.run(read_stream, write_stream, app.create_initialization_options())


if __name__ == "__main__":
    asyncio.run(main())
