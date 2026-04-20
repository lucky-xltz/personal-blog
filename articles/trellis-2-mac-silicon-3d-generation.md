---
title: "TRELLIS.2 让 Mac 跑起图片转 3D：无需 NVIDIA GPU 的 AI 3D 生成实战"
date: 2026-04-20
category: 技术
tags: [3D生成, Apple Silicon, PyTorch, MPS, TRELLIS]
author: 林小白
readtime: 15
cover: https://images.unsplash.com/photo-1633356122544-f134324a6cee?w=600&h=400&fit=crop
---

# TRELLIS.2 让 Mac 跑起图片转 3D：无需 NVIDIA GPU 的 AI 3D 生成实战

长期以来，AI 3D 内容生成领域几乎被 NVIDIA CUDA 生态垄断——从训练到推理，几乎所有前沿模型都深度绑定 NVIDIA GPU。今天，一个名为 `trellis-mac` 的开源项目打破了这一局面：它将微软研究院的 TRELLIS.2（目前最先进的图片转 3D 模型）从 CUDA-only 移植到了 Apple Silicon，让 Mac 用户无需任何 NVIDIA 硬件就能从一张照片生成高质量的 3D 模型。

本文将深入解析这项移植背后的技术原理、性能表现、实际使用方法，以及它对 AI 3D 生成领域的深远影响。

## 问题背景：AI 3D 生成的 CUDA 困境

过去两年，AI 3D 生成领域发展迅猛。从 DreamFusion 到 Magic3D，从 Instant3D 到 TRELLIS.2，模型能力不断提升，但始终有一个核心问题：**这些模型几乎全部依赖 NVIDIA GPU 和 CUDA 生态**。

这种依赖体现在三个层面：

- **专用 CUDA 内核**：大量模型使用 `flex_gemm`、`flash_attn` 等高度优化的 CUDA 算子
- **硬编码设备调用**：代码中散布着 `.cuda()` 调用，绑定 NVIDIA 硬件
- **第三方 CUDA 库**：如 `nvdiffrast`（可微光栅化）、`cumesh`（网格处理）等

这导致即使 PyTorch 已经支持 Apple Silicon 的 MPS 后端，绝大多数 3D AI 模型依然无法在 Mac 上运行。`trellis-mac` 项目的目标正是打破这一壁垒。

## TRELLIS.2：微软的图片转 3D 王牌

在介绍移植方案之前，先了解一下 TRELLIS.2 本身。这是微软研究院在 2025 年底发布的图片转 3D 生成模型，采用了创新的 **Structured Latent（SLat）** 架构：

### 核心架构

```
输入图片 → DINOv3 特征提取 → RMBG-2.0 背景移除
    → 稀疏体素 Transformer → SLat 潜空间表示
    → 稀疏结构采样 → 形状 SLat → 纹理 SLat
    → 网格解码 → 输出 OBJ/GLB（含 PBR 材质）
```

关键特点：

1. **稀疏 3D 表示**：使用稀疏体素（Sparse Voxel）而非密集网格，大幅降低内存占用
2. **双阶段采样**：先生成稀疏结构（骨架），再填充形状和纹理细节
3. **高质量输出**：支持 400K+ 顶点的高质量网格，附带 PBR 材质贴图
4. **4B 参数量**：模型体量巨大，对显存要求极高

## 移植方案：CUDA → PyTorch MPS 的五项替换

`trellis-mac` 的核心工作是将五个 CUDA-only 组件替换为纯 PyTorch / 纯 Python 实现：

### 1. 稀疏 3D 卷积：`flex_gemm` → `conv_none.py`

**原始方案**：`flex_gemm` 是一个高度优化的 CUDA 内核，实现子流形稀疏卷积（Submanifold Sparse Convolution）——只在有体素的位置执行卷积计算。

**移植方案**：使用 Gather-Scatter 策略实现：

```python
# 核心思路：构建空间哈希 → 邻域特征收集 → 矩阵乘法 → 分散写回

class SparseConv3d:
    def forward(self, features, coords):
        # 1. 构建坐标到索引的哈希表
        coord_hash = build_spatial_hash(coords)
        
        # 2. 对每个卷积核位置，收集邻域特征
        for kernel_offset in self.kernel_offsets:
            neighbor_coords = coords + kernel_offset
            neighbor_indices = lookup_hash(coord_hash, neighbor_coords)
            gathered_features = features[neighbor_indices]  # Gather
        
        # 3. 矩阵乘法应用权重
        output = gathered_features @ self.weight
        
        # 4. Scatter-Add 写回结果
        result = scatter_add(output, indices)
        
        return result
```

**性能代价**：纯 PyTorch 的稀疏卷积比 CUDA `flex_gemm` 慢约 **10 倍**，这是整个移植的主要瓶颈。

### 2. 网格提取：`o_voxel._C` 哈希映射 → `mesh_extract.py`

**原始方案**：使用 CUDA 自定义哈希映射操作，从双体素网格（Dual Voxel Grid）中提取三角网格。

**移植方案**：纯 Python 字典替换 CUDA 哈希映射：

```python
def flexible_dual_grid_to_mesh(voxel_coords, voxel_features):
    # 构建坐标到索引的查找表
    coord_to_idx = {}
    for i, coord in enumerate(voxel_coords):
        coord_to_idx[tuple(coord)] = i
    
    # 对每条边，找到连接的体素
    edges = []
    for coord in voxel_coords:
        for axis in range(3):
            neighbor = tuple(coord + edge_offset[axis])
            if neighbor in coord_to_idx:
                edges.append((coord_to_idx[tuple(coord)], 
                             coord_to_idx[neighbor]))
    
    # 法线对齐启发式：将四边形三角化
    triangles = triangulate_quads(edges, normal_alignment)
    
    return triangles
```

### 3. 注意力机制：`flash_attn` → PyTorch SDPA

**原始方案**：使用 FlashAttention 2，针对 NVIDIA Tensor Core 深度优化。

**移植方案**：使用 PyTorch 原生的 Scaled Dot-Product Attention（SDPA）：

```python
# 稀疏注意力的 SDPA 实现
def sparse_attention_sdpa(q, k, v, variable_lengths):
    # 将变长序列填充为批次
    max_len = max(variable_lengths)
    padded_q = pad_sequences(q, max_len)
    padded_k = pad_sequences(k, max_len)
    padded_v = pad_sequences(v, max_len)
    
    # 使用 PyTorch 内置 SDPA
    attn_output = F.scaled_dot_product_attention(
        padded_q, padded_k, padded_v,
        attn_mask=create_padding_mask(variable_lengths, max_len)
    )
    
    # 去除填充
    return unpad_sequences(attn_output, variable_lengths)
```

### 4. 网格处理：`cumesh` → 优雅跳过

`cumesh` 用于网格补洞和简化。由于该功能不影响核心生成流程，移植方案选择优雅跳过：

```python
try:
    import cumesh
    cumesh.fill_holes(mesh)
except ImportError:
    # macOS MPS 后端：跳过补洞，网格可能有小孔洞
    pass
```

### 5. 可微光栅化：`nvdiffrast` → 存根

`nvdiffrast` 用于纹理烘焙导出。由于深度依赖 CUDA，当前版本仅导出顶点颜色：

```python
# 纹理导出暂不支持（需要 nvdiffrast CUDA 内核）
# 输出网格附带顶点颜色，可在 Blender 等软件中手动烘焙
export_obj_with_vertex_colors(mesh, output_path)
```

### 6. 全局设备替换

所有硬编码的 `.cuda()` 调用都被替换为动态设备检测：

```python
# 替换前
model = model.cuda()
tensor = tensor.cuda()

# 替换后
device = torch.device("mps" if torch.backends.mps.is_available() 
                      else "cpu")
model = model.to(device)
tensor = tensor.to(device)
```

## 性能实测：M4 Pro 的 3.5 分钟挑战

在 M4 Pro（24GB 统一内存）上的基准测试：

| 阶段 | 耗时 | 说明 |
|------|------|------|
| 模型加载 | ~45s | 加载 4B 参数模型权重 |
| 图片预处理 | ~5s | DINOv3 特征提取 + 背景移除 |
| 稀疏结构采样 | ~15s | 生成体素骨架 |
| 形状 SLat 采样 | ~90s | 生成形状细节（最耗时阶段） |
| 纹理 SLat 采样 | ~50s | 生成纹理信息 |
| 网格解码 | ~30s | 从隐空间到三角网格 |
| **总计** | **~3.5 分钟** | Pipeline type 512 |

**内存峰值**：约 18GB 统一内存。这意味着 16GB 的 Mac 可能会遇到内存压力，24GB 以上更稳定。

**对比 CUDA 方案**：在 NVIDIA RTX 4090 上，相同模型大约 30-60 秒完成。Mac 方案慢约 3-6 倍，但考虑到这是纯 PyTorch 实现（没有任何 Apple Metal 优化内核），这个性能已经相当可观。

## 快速上手

### 环境要求

- macOS + Apple Silicon（M1 或更新）
- Python 3.11+
- 24GB+ 统一内存（推荐）
- ~15GB 磁盘空间（模型权重）

### 安装步骤

```bash
# 1. 克隆仓库
git clone https://github.com/shivampkumar/trellis-mac.git
cd trellis-mac

# 2. 登录 HuggingFace（需要下载 gated 模型）
hf auth login

# 3. 请求 gated 模型访问权限（通常秒批）：
#    - https://huggingface.co/facebook/dinov3-vitl16-pretrain-lvd1689m
#    - https://huggingface.co/briaai/RMBG-2.0

# 4. 运行安装脚本（自动创建 venv、安装依赖、克隆并 patch TRELLIS.2）
bash setup.sh

# 5. 激活环境
source .venv/bin/activate
```

### 生成 3D 模型

```bash
# 基本用法
python generate.py path/to/your/photo.png

# 指定输出路径和随机种子
python generate.py photo.png --seed 123 --output my_model

# 使用更高分辨率 pipeline（更慢但更精细）
python generate.py photo.png --pipeline-type 1024
```

输出文件包括：
- `output_3d.obj` — 带顶点颜色的 OBJ 网格
- `output_3d.glb` — GLTF 二进制格式（适合 Web 展示）

### 在 Web 中展示生成的 3D 模型

```html
<!DOCTYPE html>
<html>
<head>
    <script type="module" src="https://unpkg.com/@google/model-viewer"></script>
</head>
<body>
    <model-viewer 
        src="output_3d.glb"
        alt="Generated 3D Model"
        auto-rotate
        camera-controls
        style="width: 100vw; height: 100vh;">
    </model-viewer>
</body>
</html>
```

## 当前限制与未来展望

### 现有限制

1. **无纹理导出**：需要 `nvdiffrast`（CUDA-only），当前仅支持顶点颜色
2. **网格补洞缺失**：`cumesh` 跳过可能导致小孔洞
3. **速度瓶颈**：稀疏卷积慢 10x，整体慢 3-6x
4. **仅推理**：不支持训练
5. **模型体积大**：需 15GB 磁盘 + 18GB 内存

### 未来可能的优化方向

- **Metal Performance Shaders（MPS）自定义内核**：用 Metal 编写稀疏卷积内核，有望缩小与 CUDA 的性能差距
- **Core ML 编译**：将模型编译为 Core ML 格式，利用 Apple Neural Engine
- **量化推理**：4-bit/8-bit 量化降低内存需求，让更多 Mac 受益
- **M3/M4 专项优化**：利用 Apple 芯片的硬件光线追踪加速网格渲染

## 总结

`trellis-mac` 证明了一个重要的观点：**AI 创新不必被单一硬件生态垄断**。虽然当前方案在性能上还有差距，但它首次让 Mac 用户能够使用最前沿的图片转 3D AI 模型，这对独立开发者、3D 艺术家和教育工作者来说意义重大。

从技术角度看，这项移植工作也是对 AI 模型可移植性的一次有益探索。五个 CUDA 组件的替换策略——从 Gather-Scatter 稀疏卷积到纯 Python 网格提取——展示了在保持模型功能完整性的前提下，如何优雅地脱离对特定硬件生态的依赖。

对于拥有 Apple Silicon Mac 的开发者和创作者来说，现在就可以试试这个项目。3.5 分钟的等待，换来一个可编辑的 3D 模型，这笔账很划算。

---

*相关阅读：*

- [TRELLIS.2 官方仓库](https://github.com/microsoft/TRELLIS) — 微软研究院的原始模型
- [trellis-mac 项目](https://github.com/shivampkumar/trellis-mac) — Apple Silicon 移植版
- [PyTorch MPS 后端文档](https://pytorch.org/docs/stable/notes/mps.html) — Apple Silicon 的 PyTorch 支持
