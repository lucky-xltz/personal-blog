---
title: "WebGPU：浏览器终于拿到了显卡的钥匙"
date: 2026-05-23
category: 技术
tags: [WebGPU, GPU, 浏览器, 前端开发, WGSL, 计算着色器, 性能优化]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1587202372775-e229f172b9d7?w=600&h=400&fit=crop
---

# WebGPU：浏览器终于拿到了显卡的钥匙

过去十年，浏览器里跑 GPU 代码只有一条路——WebGL。这条基于 OpenGL ES 2.0 的老路，让前端开发者在做数据可视化时受尽了限制：一个绘制调用只能处理几千个数据点，百万级散点图想跑到 60fps 简直是痴人说梦。

2023 年，W3C 正式发布了 WebGPU 规范。2024 年 Chrome 率先全面支持。到 2026 年初，Firefox 也在 Windows 上正式 ship 了 WebGPU。一个新纪元正在悄然成型：浏览器不仅能渲染 3D 场景，还能把 GPU 当成通用计算引擎来用——在网页里跑机器学习推理、做视频编辑、渲染百万级图表，全部在客户端完成。

## 从 WebGL 到 WebGPU：不只是 API 升级

WebGL 的底层模型是 OpenGL——一个 1990 年代设计的图形 API。它的核心问题不是"功能不够"，而是"思维方式过时"：

**WebGL 的痛点：**

- **全局状态机**：设置一个绘制状态会影响后续所有操作，开发者必须手动管理状态栈，调试噩梦
- **单线程模型**：所有 GPU 命令通过单一上下文提交，无法并行构建命令缓冲区
- **Shader 语言老旧**：GLSL ES 没有现代语言特性，缺乏结构体继承、模板等能力
- **计算能力为零**：WebGL 2.0 没有 compute shader，想做 GPGPU 计算只能用 hack 手段（比如把数据塞进纹理，在 fragment shader 里算）

WebGPU 彻底抛弃了 OpenGL 的心智模型，转而采用 Vulkan/Metal/DX12 的现代 GPU 编程范式：

```javascript
// WebGL 的方式：全局状态 + 隐式同步
gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
gl.bindBuffer(gl.ARRAY_BUFFER, null);

// WebGPU 的方式：显式管线 + 命令编码器
const encoder = device.createCommandEncoder();
const pass = encoder.beginComputePass();
pass.setPipeline(computePipeline);
pass.setBindGroup(0, bindGroup);
pass.dispatchWorkgroups(Math.ceil(dataSize / 256));
pass.end();
device.queue.submit([encoder.finish()]);
```

区别一目了然：WebGL 是"设状态、画"的命令式风格；WebGPU 是"建管线、绑资源、编码命令、提交"的显式流程。后者更啰嗦，但给了开发者对 GPU 执行流程的完全控制权。

## WGSL：专为 GPU 设计的新语言

WebGPU 用 WGSL（WebGPU Shading Language）取代了 GLSL。WGSL 由 W3C GPU for the Web 工作组从零设计，目标是：

1. **安全**：所有内存访问都是有界的，不存在未定义行为
2. **可分析**：编译器可以静态验证着色器的正确性
3. **表达力强**：支持结构体、数组、枚举、函数重载等现代语言特性

```wgsl
// WGSL 计算着色器示例：向量加法
@group(0) @binding(0) var<storage, read> a: array<f32>;
@group(0) @binding(1) var<storage, read> b: array<f32>;
@group(0) @binding(2) var<storage, read_write> result: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
    let i = id.x;
    if (i < arrayLength(&a)) {
        result[i] = a[i] + b[i];
    }
}
```

WGSL 的设计决策很务实。它不用花括号而是用 `fn`、`let`、`var` 关键字；类型系统强制显式标注；内存模型分 `uniform`、`storage`、`private`、`workgroup` 四层，每层的读写语义明确。这种"不够灵活但绝对不会出错"的设计哲学，恰好适合浏览器这种不能信任代码来源的环境。

## 计算着色器：WebGPU 的杀手锏

WebGPU 最大的突破不是渲染能力的提升，而是 **compute shader 的加入**。这意味着 GPU 不再只是"画图的"，而是一个通用的并行计算引擎，可以通过浏览器 JavaScript 访问。

### 浏览器里的百万级数据可视化

ChartGPU 是一个用 WebGPU 构建的图表库，它的性能指标让人瞠目：

| 场景 | Canvas 2D | WebGL | ChartGPU (WebGPU) |
|------|-----------|-------|-------------------|
| 10 万散点 | 15 fps | 45 fps | **60 fps** |
| 100 万散点 | 不可用 | 8 fps | **60 fps** |
| K线图（1万根） | 12 fps | 35 fps | **60 fps** |
| 内存占用 | 高 | 中 | **低** |

ChartGPU 的核心思路是用 compute shader 做数据预处理——坐标变换、裁剪、聚类全部在 GPU 上完成，只把最终需要渲染的顶点传给渲染管线。这种"GPU-first"的设计，在数据量大时展现出碾压级优势。

### 浏览器里的机器学习推理

更激进的应用是在浏览器里跑 LLM。通过 WebGPU 的 compute shader，可以实现：

- 模型权重存储在 GPU buffer 中
- 矩阵乘法用 compute shader 并行计算
- 推理结果直接在浏览器中显示，无需服务器往返

这意味着敏感数据（比如医疗记录、法律文档）可以在用户的浏览器里被 AI 处理，数据完全不出设备。对于隐私敏感场景，这是一个杀手级特性。

### 浏览器里的视频编辑

tooscut.app 证明了 WebGPU + WASM 的组合可以让专业级视频编辑在浏览器中运行：

- 解码：WASM 跑 FFmpeg 解码器
- 特效：WebGPU compute shader 做像素级处理（滤镜、转场、调色）
- 合成：GPU 做多轨混合
- 编码：WASM 跑编码器

整条流水线都在客户端完成，不需要把视频上传到云端。对于短视频创作者来说，打开浏览器就能剪辑，不需要下载 2GB 的桌面软件。

## 实战：用 WebGPU 写一个粒子系统

让我们用代码走一遍 WebGPU 的核心流程。下面是一个完整的粒子系统初始化示例：

```javascript
async function initWebGPU() {
  // 1. 获取 GPU 适配器和设备
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();

  // 2. 创建计算管线
  const computeModule = device.createShaderModule({
    code: `
      struct Particle {
        position: vec2<f32>,
        velocity: vec2<f32>,
      }
      @group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
      @group(0) @binding(1) var<uniform> dt: f32;

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) id: vec3<u32>) {
        let i = id.x;
        if (i >= arrayLength(&particles)) { return; }
        particles[i].position += particles[i].velocity * dt;
        // 简单边界反弹
        if (abs(particles[i].position.x) > 1.0) {
          particles[i].velocity.x *= -1.0;
        }
        if (abs(particles[i].position.y) > 1.0) {
          particles[i].velocity.y *= -1.0;
        }
      }
    `
  });

  const computePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module: computeModule, entryPoint: 'main' }
  });

  // 3. 创建粒子数据 buffer
  const PARTICLE_COUNT = 100000;
  const particleData = new Float32Array(PARTICLE_COUNT * 4); // pos.x, pos.y, vel.x, vel.y
  for (let i = 0; i < PARTICLE_COUNT * 4; i += 4) {
    particleData[i] = (Math.random() - 0.5) * 2;     // position.x
    particleData[i + 1] = (Math.random() - 0.5) * 2; // position.y
    particleData[i + 2] = (Math.random() - 0.5) * 0.01; // velocity.x
    particleData[i + 3] = (Math.random() - 0.5) * 0.01; // velocity.y
  }

  const particleBuffer = device.createBuffer({
    size: particleData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Float32Array(particleBuffer.getMappedRange()).set(particleData);
  particleBuffer.unmap();

  // 4. 每帧调度计算
  function frame() {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(computePipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(PARTICLE_COUNT / 64));
    pass.end();
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  }
  frame();
}
```

10 万个粒子每帧更新位置和速度，每帧只需一次 `dispatchWorkgroups` 调用。GPU 的大规模并行能力让这完全不是问题——如果你用 JavaScript 在 CPU 上做同样的计算，帧率会掉到个位数。

## 浏览器兼容性现状（2026 年 5 月）

WebGPU 的生态正在快速成熟，但支持度还有差距：

| 浏览器 | Windows | macOS | Linux | Android |
|--------|---------|-------|-------|---------|
| Chrome 113+ | ✅ | ✅ | ✅ | ✅ |
| Firefox 141+ | ✅ | 实验性 | ❌ | ❌ |
| Safari | 实验性 | 实验性 | — | ❌ |
| Edge | ✅（Chromium） | ✅ | ✅ | ✅ |

关键观察：

- **Chrome 是先行者**，功能最完整，社区工具最多
- **Firefox 在追赶**，2025 年 7 月在 Windows 上正式发布，macOS 和 Linux 还在后面
- **Safari 最慢**，WebKit 团队资源有限，WebGPU 还在实验阶段
- **Android Chrome 已支持**，这意味着移动端也能用 WebGPU

对于生产环境，目前的策略是 **WebGPU 优先，WebGL 兜底**：

```javascript
async function initGraphics() {
  if (navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return await initWebGPU(adapter);
    } catch (e) {
      console.warn('WebGPU init failed, falling back to WebGL');
    }
  }
  return initWebGL(); // 降级到 WebGL
}
```

## WebGPU vs WebAssembly：互补而非竞争

今天的浏览器有两个"高性能"武器：WebAssembly 和 WebGPU。它们解决不同的问题：

- **WebAssembly**：让 CPU 密集型代码在浏览器里跑得更快（编解码、加密、解析）
- **WebGPU**：让 GPU 密集型任务在浏览器里跑得起来（渲染、并行计算、矩阵运算）

最好的应用往往是两者结合。以浏览器视频编辑器为例：

```
WASM (CPU)                    WebGPU (GPU)
┌─────────────┐              ┌─────────────┐
│ FFmpeg 解码  │  ──纹理──→  │ 滤镜/转场    │
│ 音频处理     │              │ 色彩校正    │
│ 编码器       │  ←─像素──   │ 多轨合成    │
└─────────────┘              └─────────────┘
```

这种分工模式正在成为高性能 Web 应用的标准架构。

## 性能优化实战技巧

### 1. 合理设置 workgroup size

```wgsl
// ❌ 太小：GPU 利用率低
@compute @workgroup_size(1) fn main(...) { ... }

// ❌ 太大：某些硬件不支持
@compute @workgroup_size(1024) fn main(...) { ... }

// ✅ 推荐：256 是安全的默认值
@compute @workgroup_size(256) fn main(...) { ... }
```

`workgroup_size` 决定了一个工作组里有多少个线程。256 是一个在大多数 GPU 上都能高效运行的值。太小会导致 GPU 的 SIMD 单元闲置，太大会超出硬件限制。

### 2. 减少 GPU-CPU 同步

```javascript
// ❌ 每帧都 read back：强制 GPU-CPU 同步
async function bad() {
  device.queue.submit([encoder.finish()]);
  const data = await buffer.mapAsync(GPUMapMode.READ); // 阻塞！
  processOnCPU(data);
}

// ✅ 双缓冲：当前帧渲染，下一帧读取上一帧结果
function good() {
  device.queue.submit([encoder.finish()]);
  // 用上一帧的结果，不等当前帧
  if (previousResult) processOnCPU(previousResult);
  previousResult = buffer.mapAsync(GPUMapMode.READ);
}
```

GPU 和 CPU 是异步执行的。`mapAsync` 会强制同步，等待所有已提交的 GPU 工作完成。在实时应用中，这种同步是帧率杀手。解决方案是流水线化：当前帧渲染的同时，处理上一帧的回读结果。

### 3. Buffer 复用和子分配

```javascript
// ❌ 每帧创建新 buffer：GC 压力大
function bad() {
  const buf = device.createBuffer({ size: 1024, usage: GPUBufferUsage.STORAGE });
  // ... 使用 buf ...
  buf.destroy();
}

// ✅ 预分配大 buffer，按需切片
class BufferAllocator {
  constructor(device, size) {
    this.buffer = device.createBuffer({
      size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.UNIFORM,
    });
    this.offset = 0;
  }
  allocate(size) {
    const offset = this.offset;
    this.offset += Math.ceil(size / 256) * 256; // 256 字节对齐
    return { buffer: this.buffer, offset, size };
  }
}
```

WebGPU 的 buffer 创建是有开销的。在每帧都要更新数据的场景下，预分配一个大 buffer 并在里面做子分配，比反复创建销毁小 buffer 高效得多。

## 未来展望

WebGPU 的发展路径清晰可见：

**短期（2026-2027）：**
- Firefox 和 Safari 完成全平台支持
- WebGPU compute shader 的工具链成熟（调试器、性能分析器）
- 更多框架内置 WebGPU 后端（Three.js、Babylon.js 已支持，D3/Plotly 跟进）

**中期（2027-2028）：**
- 浏览器端 AI 推理成为标配（WebGPU + ONNX Runtime Web / Transformers.js）
- WebGPU 加速的实时协作工具（在线设计、视频会议特效）
- 游戏引擎的 WebGPU 原生导出

**长期：**
- WebGPU 可能成为"通用 GPU 计算"的浏览器标准，取代 WebGL
- 与 Web Neural Network API（WebNN）协同，形成完整的浏览器端 AI 推理栈

## 总结

WebGPU 不是 WebGL 的简单升级，而是浏览器 GPU 编程范式的根本性变革。它带来的核心能力是 **compute shader**——让 GPU 从"画图工具"变成了"通用并行计算引擎"。

对于前端开发者来说，WebGPU 意味着：

1. **数据可视化**：百万级数据点的实时渲染不再是 native 应用的专利
2. **AI 推理**：隐私敏感场景下，模型可以在用户浏览器里跑
3. **创意工具**：视频编辑、3D 建模、音频处理可以完全在浏览器中完成
4. **科学计算**：物理模拟、分子动力学可以在 Web 上交互式展示

浏览器正在从"文档查看器"变成"应用运行时"，WebGPU 是这个转变中最重要的拼图之一。

---

*相关阅读：*

- [WebAssembly 组件模型：从二等公民到 Web 一等公民的进化之路](/article/webassembly-component-model-2026)
- [Node.js 26 正式发布：Temporal API 终结 JavaScript 日期处理的二十年之痛](/article/nodejs-26-temporal-api-2026)
