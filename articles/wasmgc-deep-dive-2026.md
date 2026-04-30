---
title: "WebAssembly GC 深度解析：告别自带垃圾回收器的时代"
date: 2026-04-30
category: 技术
tags: [WebAssembly, WasmGC, 前端, 性能优化, 编译器]
author: 林小白
readtime: 15
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# WebAssembly GC 深度解析：告别自带垃圾回收器的时代

WebAssembly（Wasm）自诞生以来，一直以"编译目标"的角色服务于 C/C++ 和 Rust 等手动内存管理语言。但对于 Kotlin、Dart、Java、C# 等依赖垃圾回收（GC）的语言来说，想要编译到 Wasm，就必须把整个 GC 运行时打包进二进制文件——这导致产物臃肿、性能低下、与浏览器运行时割裂。

**WasmGC（WebAssembly Garbage Collection proposal）** 彻底改变了这一局面。作为 Wasm 的第四大标准化提案（继 MVP、SIMD、线程之后），它为 Wasm 带来了原生的垃圾回收类型系统，让托管语言终于能以"一等公民"的身份运行在浏览器中。

## 为什么需要 WasmGC？

### 旧方案的困境

在 WasmGC 之前，Kotlin/Wasm、Dart/Flutter Web、Java (TeaVM) 等项目的编译路径是这样的：

```
源代码 → 编译器 → Wasm 二进制 + 内嵌 GC 运行时
```

这意味着：

| 问题 | 影响 |
|------|------|
| **二进制膨胀** | GC 运行时本身就需要 1-3 MB，加上应用代码轻松超过 5 MB |
| **GC 不互通** | 每种语言自带的 GC 无法与浏览器的 GC 协调，可能导致双重 GC 压力 |
| **无法操作 DOM** | 没有类型化的引用，Wasm 线性内存中的对象无法直接指向 JS 堆 |
| **启动慢** | 大量二进制需要下载和编译，冷启动体验差 |

### WasmGC 的解决方案

WasmGC 在 Wasm 层面引入了**托管类型（managed types）**——结构体（struct）、数组（array）和引用类型（ref）。这些类型由浏览器引擎的 GC 统一管理，不再需要语言自带运行时：

```
源代码 → 编译器 → WasmGC 二进制（纯业务逻辑）
                   ↓
            浏览器引擎 GC 统一管理内存
```

## 核心类型系统

WasmGC 引入了一套完整的结构化类型系统。理解这些类型是掌握 WasmGC 的关键。

### Struct 类型

Struct 是 WasmGC 的基础复合类型，类似于 C 的结构体或 Java 的类：

```wasm
;; 定义一个 Point 类型
(type $Point (struct
  (field $x f64)
  (field $y f64)
))

;; 创建实例
(struct.new $Point
  (f64.const 1.0)   ;; x
  (f64.const 2.0)   ;; y
)

;; 读取字段
(struct.get $Point $x (local.get $point))
```

### Array 类型

Array 是长度可变的同构容器：

```wasm
;; 定义 f64 数组类型
(type $f64array (array (mut f64)))

;; 创建长度为 10 的数组，初始值为 0.0
(array.new $f64array
  (f64.const 0.0)
  (i32.const 10)
)

;; 读写元素
(array.get $f64array (local.get $arr) (i32.const 3))
(array.set $f64array (local.get $arr) (i32.const 3) (f64.const 42.0))
```

### 引用类型

WasmGC 的引用类型体系比线性内存的指针丰富得多：

```wasm
;; 各种引用类型
(ref null $Point)      ;; 可空的结构体引用
(ref $Point)           ;; 非空的结构体引用
i31ref                 ;; 压缩的 31 位整数引用（无需装箱）
anyref                 ;; 任意引用的顶层类型
eqref                  ;; 可比较相等性的引用
```

`i31ref` 是一个精巧的设计——它把 31 位整数直接编码进引用指针中，避免了小整数的装箱开销：

```wasm
;; 将 i32 压缩为 i31ref
(i31.new (i32.const 42))

;; 从 i31ref 提取值
(i31.get_s (local.get $ref))  ;; 有符号
(i31.get_u (local.get $ref))  ;; 无符号
```

### 类型层次与子类型

WasmGC 支持结构化子类型，这是面向对象语言编译的基础：

```wasm
;; 定义 Animal 基类型
(type $Animal (struct
  (field $name (ref extern))
))

;; Dog 继承 Animal，添加 breed 字段
(type $Dog (struct
  (field $name (ref extern))    ;; 继承自 Animal
  (field $breed (ref extern))   ;; Dog 自己的字段
))

;; 类型声明中的子类型关系
(type $Dog_subtype $Animal)
```

## 与线性内存方案的对比

让我们用一个具体的例子来说明差异。假设有一个 Kotlin 类：

```kotlin
data class User(
    val name: String,
    val age: Int,
    val scores: List<Int>
)
```

### 线性内存方案（旧）

```
+-------------------------------------+
| Wasm 线性内存                        |
|                                     |
|  +--------------+                   |
|  | GC 运行时     | (1-3 MB)          |
|  | +-- 分配器    |                   |
|  | +-- 标记清除  |                   |
|  | \-- 类型信息  |                   |
|  +--------------+                   |
|                                     |
|  +--------------+                   |
|  | User 对象     | <- 线性内存中的     |
|  | +-- name ptr  |   手动布局        |
|  | +-- age: 25   |                   |
|  | \-- scores ptr|                   |
|  +--------------+                   |
|                                     |
|  所有对象都是线性内存中的字节偏移      |
|  无法与 JS 堆直接交互                |
+-------------------------------------+
```

### WasmGC 方案（新）

```
+-------------------------------------+
| Wasm 模块                            |
|                                     |
|  (type $User (struct               |
|    (field $name (ref extern))      |
|    (field $age i32)                |
|    (field $scores (ref $i32array)) |
|  ))                                |
|                                     |
|  纯粹的类型定义，无 GC 代码           |
+-------------------------------------+
         ↓ 引用
+-------------------------------------+
| 浏览器 GC 堆                        |
|                                     |
|  WasmGC 对象与 JS 对象共享同一个堆    |
|  浏览器引擎统一管理回收               |
|  可以直接持有 JS 对象的引用            |
+-------------------------------------+
```

### 性能对比数据

根据 Google 的基准测试和 Kotlin/Wasm 的官方数据：

| 指标 | 线性内存方案 | WasmGC | 改善 |
|------|-------------|--------|------|
| 二进制大小 | 4-8 MB | 0.5-2 MB | **75-80% ↓** |
| 冷启动时间 | 2-5 秒 | 0.5-1.5 秒 | **70% ↓** |
| 内存占用 | 高（双重 GC） | 低（统一 GC） | **40-60% ↓** |
| GC 暂停 | 不可控 | 与浏览器协调 | **更平滑** |

## 浏览器支持现状

截至 2026 年 4 月，WasmGC 的支持情况：

| 浏览器 | 支持版本 | 发布时间 |
|--------|---------|---------|
| Chrome / Edge | 119+ | 2023 年 11 月 |
| Firefox | 120+ | 2023 年 11 月 |
| Safari | 18.2+ | 2024 年 12 月 |
| Node.js | 22+ | 2024 年 4 月 |

**注意**：Safari 的支持来得较晚，但在 2024 年底已经跟进。这意味着 WasmGC 在主流浏览器中的覆盖率已经超过 **95%**。

可以通过特性检测来判断运行环境是否支持 WasmGC：

```javascript
function hasWasmGC() {
  try {
    // 尝试编译一个包含 struct 类型的 Wasm 模块
    const bytes = new Uint8Array([
      0x00, 0x61, 0x73, 0x6d, // magic
      0x01, 0x00, 0x00, 0x00, // version
      0x01,                   // type section
      0x05,                   // section size
      0x01,                   // 1 type
      0x5f,                   // struct type opcode
      0x01,                   // 1 field
      0x7f,                   // i32
      0x00                    // immutable
    ]);
    new WebAssembly.Module(bytes);
    return true;
  } catch {
    return false;
  }
}
```

## 语言支持与实战

### Kotlin/Wasm

Kotlin 是 WasmGC 最积极的采用者。Kotlin 2.0+ 已将 WasmGC 作为正式编译目标：

```kotlin
// build.gradle.kts
kotlin {
    wasmJs {
        browser()
    }
}

// common code - 在所有平台共享
class TodoApp {
    private val items = mutableListOf<TodoItem>()

    fun addItem(text: String) {
        items.add(TodoItem(text, done = false))
    }

    fun toggleItem(index: Int) {
        items[index] = items[index].copy(done = !items[index].done)
    }

    fun getActiveCount(): Int = items.count { !it.done }
}
```

Kotlin/Wasm 编译出的二进制比 Kotlin/JS 小约 **50%**，启动快约 **2-3 倍**。

### Dart/Flutter Web

Dart 从 3.3 开始支持 WasmGC 编译。Flutter Web 应用可以通过 WasmGC 获得显著的性能提升：

```dart
// Flutter Web + WasmGC
// 编译命令: flutter build web --wasm

class CanvasPainter extends CustomPainter {
  final List<Offset> points;

  CanvasPainter(this.points);

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.blue
      ..strokeWidth = 2.0;

    for (int i = 1; i < points.length; i++) {
      canvas.drawLine(points[i - 1], points[i], paint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => true;
}
```

使用 `flutter build web --wasm` 编译后，渲染性能提升约 **2 倍**，首屏加载快 **40%**。

### AssemblyScript

AssemblyScript 是 TypeScript 的子集，专为 Wasm 设计。它的 WasmGC 支持使得 TS 开发者也能利用 GC 类型：

```typescript
// AssemblyScript 编译到 WasmGC
// asc program.ts --target wasm-gc

class Vector3 {
  constructor(
    public x: f64,
    public y: f64,
    public z: f64
  ) {}

  normalize(): Vector3 {
    const len = Math.sqrt(
      this.x * this.x + this.y * this.y + this.z * this.z
    );
    return new Vector3(
      this.x / len,
      this.y / len,
      this.z / len
    );
  }

  dot(other: Vector3): f64 {
    return this.x * other.x + this.y * other.y + this.z * other.z;
  }
}

// 这些对象由浏览器 GC 管理，无需手动释放
export function computeNormals(vertices: Vector3[]): Vector3[] {
  const normals = new Array<Vector3>(vertices.length);
  for (let i = 0; i < vertices.length; i++) {
    normals[i] = vertices[i].normalize();
  }
  return normals;
}
```

## 高级特性：WasmGC 与 JS 互操作

WasmGC 引入了 `extern.convert_any` 和 `any.convert_extern` 等指令，用于在 WasmGC 引用和外部（JS）引用之间转换。这使得 WasmGC 对象可以与 JavaScript 互操作：

```javascript
// JavaScript 端与 WasmGC 互操作
const wasm = await WebAssembly.instantiateStreaming(fetch('app.wasm'), {
  env: {
    // JS 函数可以接收 WasmGC 对象
    logUser(user) {
      // user 是 WasmGC struct 的包装
      console.log(`Name: ${user.name}, Age: ${user.age}`);
    },

    // WasmGC 对象可以传递给 JS DOM API
    setElementText(element, text) {
      element.textContent = text;
    }
  }
});

// 调用 Wasm 导出函数
const greet = wasm.instance.exports.greet;
greet("World");
```

## 实践建议与陷阱

### 1. 渐进式迁移策略

不要试图一次性将整个项目迁移到 WasmGC。推荐渐进式策略：

```
Phase 1: 核心计算模块 -> WasmGC（性能敏感部分）
Phase 2: 数据层 -> WasmGC（大量对象创建/销毁）
Phase 3: UI 层 -> 保持 JS/TS（DOM 操作仍然更快）
```

### 2. 避免过度细粒度的对象

虽然 WasmGC 让创建对象变得廉价，但过度使用小对象仍然有开销：

```wasm
;; 不好 - 太多小对象
(type $Vec2 (struct (field $x f32) (field $y f32)))
;; 每个粒子一个 struct，10 万个粒子 = 10 万个 GC 对象

;; 好 - 使用数组存储批量数据
(type $ParticleSoA (struct
  (field $xs (array (mut f32)))
  (field $ys (array (mut f32)))
  (field $count i32)
))
;; 10 万个粒子 = 2 个大数组
```

### 3. 类型定义要精确

WasmGC 的类型系统是结构化的，精确的类型定义能让引擎做更多优化：

```wasm
;; 弱类型 - 引擎无法优化
(type $Container (struct (field $data (ref null any))))

;; 强类型 - 引擎可以内联和去虚拟化
(type $IntContainer (struct (field $data (ref $i32array))))
```

### 4. 与 JS 的边界调用最小化

跨越 Wasm-JS 边界仍然有开销。批量处理数据后再传递：

```javascript
// 每次迭代都跨越边界 - 慢
for (const item of items) {
  wasm.exports.processItem(item);
}

// 批量传递 - 快
const buffer = wasm.exports.allocBuffer(items.length);
items.forEach((item, i) => wasm.exports.setBufferItem(buffer, i, item));
wasm.exports.processBuffer(buffer, items.length);
```

### 5. 调试工具链

Chrome DevTools 已经支持 WasmGC 的调试：

- **Memory 面板**：可以看到 WasmGC 对象在堆中的分布
- **Performance 面板**：GC 暂停事件可视化
- **Console**：WasmGC 对象可以像 JS 对象一样展开查看

## 未来展望

WasmGC 还在持续演进。值得关注的方向：

- **Wasm 层面的 GC 调优提示**：允许开发者向引擎传递 GC 策略偏好（如 "这批对象生命周期短"）
- **更好的 JS 互操作**：减少 Wasm-JS 边界的开销，让 WasmGC 对象更自然地暴露给 JS
- **更多语言支持**：Python (PyScript)、Ruby、Lua 等脚本语言的 WasmGC 编译器正在开发中
- **服务端 WasmGC**：Wasmtime、WasmEdge 等运行时也在实现 WasmGC，服务端场景同样受益
- **Component Model 集成**：WasmGC 类型将成为 Component Model 的一部分，实现跨模块的类型安全互操作

## 总结

WasmGC 是 WebAssembly 自 MVP 以来最重要的特性升级。它让 Kotlin、Dart、Java 等托管语言终于能够以接近原生的性能运行在浏览器中，同时大幅减小二进制体积和内存占用。

对于前端开发者来说，WasmGC 的意义在于：

1. **更多语言选择**：不必局限于 JavaScript/TypeScript
2. **更好的性能**：计算密集型任务有了更高效的执行方式
3. **更小的包体积**：不需要在每个应用中打包 GC 运行时
4. **更好的互操作**：WasmGC 对象可以与 JS/DOM 自然交互

如果你的项目涉及大量计算、复杂数据结构或多语言编译需求，现在正是开始探索 WasmGC 的好时机。

---

*相关阅读：*

- [深入解析 Cloudflare 可观测性平台：ClickHouse、Kafka 与 AI 驱动的错误分析](/article/cloudflare-observability-platform-deep-dive)
- [动态语言解释器优化：从 AST 慢跑者到性能怪兽的 16x 加速之旅](/article/dynamic-language-interpreter-optimization)
- [用 Rust 重写 PostgreSQL 扩展：pgrx 框架深度实战与性能剖析](/article/pgrx-rust-postgres-extensions)
