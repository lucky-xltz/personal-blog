---
title: "Skip List 深度解析：从理论到 Skiptree 的工程实践"
date: 2026-04-19
category: 技术
tags: [数据结构, Skip List, 算法, 数据库, 系统设计]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1509228468518-180dd4864904?w=600&h=400&fit=crop
---

# Skip List 深度解析：从理论到 Skiptree 的工程实践

在数据结构的版图中，Skip List（跳跃表）是一个特殊的存在——它不像红黑树那样被写进教科书的前几章，也不像哈希表那样无处不在，但它拥有一群忠实的拥趸。Redis 用它实现有序集合，LevelDB 用它组织内存中的键值对，而最近 Antithesis 团队更是将 Skip List 的思想推广到了树结构，创造了 "Skiptree" 这一创新概念。

今天让我们从 Skip List 的基础原理出发，通过 Python 和 Go 的实现代码，一直到 Antithesis 在分析数据库中遇到的真实工程问题，全面理解这个被低估的数据结构。

## 什么是 Skip List

Skip List 由 William Pugh 在 1990 年发表的论文中提出，核心思想极其优雅：**在有序链表的基础上，增加多层"快车道"索引**。

### 核心结构

想象一条高速公路系统：

- **底层（Level 0）**：一条包含所有元素的有序链表，就像城市道路，每个路口都要停
- **上层索引**：每一层是下一层的"子集"，节点越往上越稀疏，就像高速公路的匝道——你可以在高架上快速行驶，然后在需要的时候降下来

关键的随机化策略：每个节点被"晋升"到上一层的概率是 **50%**。这意味着：

- Level 0：n 个节点
- Level 1：约 n/2 个节点
- Level 2：约 n/4 个节点
- Level k：约 n/2^k 个节点

总层数约为 log₂(n)，这也是 Skip List 能实现 O(log n) 查找的根本原因。

### 搜索过程

查找值 38 的过程如下：

1. 从最高层的头节点出发
2. 向右移动：如果下一个节点的值 ≤ 目标值，继续向右
3. 如果下一个节点的值 > 目标值，或者已经到达该层末尾，向下移动一层
4. 重复步骤 2-3，直到在底层找到目标节点或确认不存在

每次向下移动都会跳过大约一半的候选节点，这就是对数时间复杂度的来源。

## Python 实现

让我们从零实现一个完整的 Skip List，理解每一个细节：

```python
import random
from typing import Optional, List, Tuple


class SkipListNode:
    """Skip List 节点"""
    def __init__(self, key, value, level: int):
        self.key = key
        self.value = value
        # 每一层的前向指针
        self.forward: List[Optional['SkipListNode']] = [None] * (level + 1)


class SkipList:
    """
    Skip List 实现
    支持：插入、删除、查找、范围查询
    时间复杂度：O(log n) 期望
    空间复杂度：O(n) 期望
    """
    MAX_LEVEL = 16  # 最大层数，支持 2^16 = 65536 个节点
    P = 0.5         # 晋升概率

    def __init__(self):
        self.header = SkipListNode(None, None, self.MAX_LEVEL)
        self.level = 0  # 当前最高层
        self.size = 0

    def _random_level(self) -> int:
        """随机生成节点的层级"""
        lvl = 0
        while random.random() < self.P and lvl < self.MAX_LEVEL:
            lvl += 1
        return lvl

    def search(self, key) -> Optional[any]:
        """查找操作 - O(log n)"""
        current = self.header
        # 从最高层开始向下搜索
        for i in range(self.level, -1, -1):
            while current.forward[i] and current.forward[i].key < key:
                current = current.forward[i]
        # 现在 current 是底层中最后一个 < key 的节点
        current = current.forward[0]
        if current and current.key == key:
            return current.value
        return None

    def insert(self, key, value) -> bool:
        """插入操作 - O(log n)"""
        update = [None] * (self.MAX_LEVEL + 1)
        current = self.header

        # 找到每一层需要更新的节点
        for i in range(self.level, -1, -1):
            while current.forward[i] and current.forward[i].key < key:
                current = current.forward[i]
            update[i] = current

        current = current.forward[0]

        # 如果 key 已存在，更新值
        if current and current.key == key:
            current.value = value
            return False

        # 生成随机层级
        new_level = self._random_level()

        # 如果新层级超过当前最高层级，更新 header 的指针
        if new_level > self.level:
            for i in range(self.level + 1, new_level + 1):
                update[i] = self.header
            self.level = new_level

        # 创建新节点
        new_node = SkipListNode(key, value, new_level)

        # 重新调整指针
        for i in range(new_level + 1):
            new_node.forward[i] = update[i].forward[i]
            update[i].forward[i] = new_node

        self.size += 1
        return True

    def delete(self, key) -> bool:
        """删除操作 - O(log n)"""
        update = [None] * (self.MAX_LEVEL + 1)
        current = self.header

        for i in range(self.level, -1, -1):
            while current.forward[i] and current.forward[i].key < key:
                current = current.forward[i]
            update[i] = current

        current = current.forward[0]

        if not current or current.key != key:
            return False

        # 调整指针，跳过要删除的节点
        for i in range(self.level + 1):
            if update[i].forward[i] != current:
                break
            update[i].forward[i] = current.forward[i]

        # 如果删除的是最高层的节点，降低层级
        while self.level > 0 and self.header.forward[self.level] is None:
            self.level -= 1

        self.size -= 1
        return True

    def range_query(self, start_key, end_key) -> List[Tuple]:
        """范围查询 - O(log n + k)，k 为结果数量"""
        results = []
        current = self.header

        # 先定位到 start_key 附近
        for i in range(self.level, -1, -1):
            while current.forward[i] and current.forward[i].key < start_key:
                current = current.forward[i]

        current = current.forward[0]

        # 顺序遍历直到超过 end_key
        while current and current.key <= end_key:
            results.append((current.key, current.value))
            current = current.forward[0]

        return results

    def display(self):
        """打印 Skip List 结构（调试用）"""
        for lvl in range(self.level, -1, -1):
            node = self.header.forward[lvl]
            keys = []
            while node:
                keys.append(str(node.key))
                node = node.forward[lvl]
            print(f"Level {lvl}: {' -> '.join(keys) if keys else '(empty)'}")


# 使用示例
if __name__ == "__main__":
    sl = SkipList()

    # 插入数据
    data = [(3, "three"), (6, "six"), (7, "seven"), (9, "nine"),
            (12, "twelve"), (19, "nineteen"), (17, "seventeen"),
            (26, "twenty-six"), (21, "twenty-one"), (25, "twenty-five")]
    for k, v in data:
        sl.insert(k, v)

    print("=== Skip List 结构 ===")
    sl.display()

    print(f"\n=== 查找 key=19 ===")
    result = sl.search(19)
    print(f"结果: {result}")

    print(f"\n=== 范围查询 [7, 21] ===")
    for k, v in sl.range_query(7, 21):
        print(f"  {k}: {v}")
```

## Go 实现：并发安全版本

Skip List 最大的工程优势之一是**天然适合并发场景**。相比红黑树需要复杂的旋转操作，Skip List 的插入和删除只需要修改相邻节点的指针，这使得无锁（lock-free）实现成为可能。

```go
package skiplist

import (
	"math/rand"
	"sync"
	"sync/atomic"
)

const maxLevel = 32

type Node struct {
	key     int
	value   interface{}
	forward []*atomic.Pointer[Node]
	marked  atomic.Bool  // 是否已标记删除
	deleted atomic.Bool
	mu      sync.Mutex
}

type SkipList struct {
	head  *Node
	level int
	mu    sync.RWMutex
}

func NewSkipList() *SkipList {
	head := &Node{
		forward: make([]*atomic.Pointer[Node], maxLevel),
	}
	for i := range head.forward {
		head.forward[i] = &atomic.Pointer[Node]{}
	}
	return &SkipList{
		head:  head,
		level: 0,
	}
}

func randomLevel() int {
	level := 0
	for rand.Float64() < 0.5 && level < maxLevel-1 {
		level++
	}
	return level
}

// Search 无锁查找
func (sl *SkipList) Search(key int) (interface{}, bool) {
	x := sl.head
	for i := sl.level - 1; i >= 0; i-- {
		for {
			next := x.forward[i].Load()
			if next == nil || next.key >= key {
				break
			}
			x = next
		}
	}
	x = x.forward[0].Load()
	if x != nil && x.key == key && !x.marked.Load() {
		return x.value, true
	}
	return nil, false
}

// Insert 使用 CAS 的无锁插入
func (sl *SkipList) Insert(key int, value interface{}) bool {
	pred := [maxLevel]*Node{}
	succ := [maxLevel]*Node{}

retry:
	x := sl.head
	for i := sl.level - 1; i >= 0; i-- {
		for {
			next := x.forward[i].Load()
			for next != nil && (next.marked.Load() || next.key < key) {
				next = next.forward[i].Load()
			}
			if next != nil && next.key == key && !next.marked.Load() {
				// Key 已存在，更新值
				next.value = value
				return false
			}
			pred[i] = x
			succ[i] = next
			if next == nil || next.key >= key {
				break
			}
			x = next
		}
	}

	newLevel := randomLevel() + 1

	newNode := &Node{
		key:     key,
		value:   value,
		forward: make([]*atomic.Pointer[Node], newLevel),
	}
	for i := range newNode.forward {
		newNode.forward[i] = &atomic.Pointer[Node]{}
		newNode.forward[i].Store(succ[i])
	}

	// CAS 插入第 0 层
	if !pred[0].forward[0].CompareAndSwap(succ[0], newNode) {
		goto retry
	}

	// 插入其余层
	for i := 1; i < newLevel; i++ {
		for {
			if pred[i].forward[i].CompareAndSwap(succ[i], newNode) {
				break
			}
			// 重新定位 pred
			x = sl.head
			for j := sl.level - 1; j >= i; j-- {
				for next := x.forward[j].Load(); next != nil && next.key < key; {
					x = next
					next = x.forward[j].Load()
				}
				pred[j] = x
			}
		}
	}
	return true
}
```

Go 实现中的关键设计点：

1. **`atomic.Pointer[Node]`**：利用 Go 1.19+ 的泛型原子指针，避免 `unsafe.Pointer` 转换
2. **CAS 重试**：当 CAS 失败时（说明有并发修改），跳转到 `retry` 标签重新定位
3. **标记删除**：`marked` 原子布尔值实现逻辑删除，物理删除留给 GC

## Skip List vs 红黑树 vs 哈希表

在工程实践中选择数据结构时，需要从多个维度权衡：

| 维度 | Skip List | 红黑树 | 哈希表 |
|------|-----------|--------|--------|
| 查找 | O(log n) | O(log n) | O(1) 平均 |
| 插入 | O(log n) | O(log n) | O(1) 平均 |
| 删除 | O(log n) | O(log n) | O(1) 平均 |
| 范围查询 | O(log n + k) ✅ | O(log n + k) ✅ | O(n) ❌ |
| 有序遍历 | O(n) ✅ | O(n) ✅ | O(n log n) ❌ |
| 并发实现 | 简单 ✅ | 复杂 ❌ | 中等 |
| 内存局部性 | 差（链表） | 好（数组） | 好 |
| 实现复杂度 | 低 ✅ | 高 ❌ | 低 |

**Redis 选择 Skip List 的原因**：Redis 的 `zset`（有序集合）需要支持范围查询（`ZRANGEBYSCORE`）和排名查询（`ZRANK`），Skip List 在这两方面表现优秀，且实现比红黑树简洁得多。Redis 作者 Antirez 曾表示："Skip List 更容易实现、调试，而且在实践中性能并不逊色。"

## 从 Skip List 到 Skiptree

Antithesis 团队最近在博客中分享了一个精彩的工程案例，将 Skip List 的思想推广到了树结构——这就是 **Skiptree**。

### 问题背景

Antithesis 的核心业务是通过模糊测试（fuzzing）来找软件 bug。每次测试运行中，fuzzer 做出不同的随机决策，产生不同的执行路径。所有这些路径形成一棵分支树——从根到叶的每条路径代表一次独特的测试运行。

他们需要对这棵庞大的树做大量查询：给定某个日志消息，找出导致它的完整事件历史。这本质上是一个**从叶节点沿 parent 指针向上遍历到根**的操作。

数据存储在 Google BigQuery 中——一个为大规模扫描优化的分析数据库。问题是：

- BigQuery 擅长大规模聚合扫描
- 但 parent 指针查找需要的是**点查询**（point lookup）
- 每次点查询都会触发全表扫描
- 一次 O(depth) 的树遍历 = depth 次全表扫描

### Skiptree 的创新

Skiptree 的核心思想：**用 Skip List 的分层索引思想来加速树遍历**。

具体做法：

1. 在原始树（Level 0）之上，构建一层"高层树"（Level 1），每个节点保留概率 50%
2. 在 Level 1 之上再构建 Level 2，以此类推
3. 遍历时，先在高层树中快速跳跃到目标区域附近，再逐层下降

关键洞察：从根到任何叶节点的路径上，各层树中该路径上的节点构成一个 Skip List！所以 Skiptree 实际上是一组共享结构的 Skip List，每条根到叶的路径对应一个。

### SQL 实现

```sql
-- Level 0: 完整树
CREATE TABLE tree0 AS
SELECT id, parent_id, data FROM raw_events;

-- Level 1: 保留约 50% 的节点
CREATE TABLE tree1 AS
SELECT id, parent_id, data
FROM tree0
WHERE MOD(ABS(FARM_FINGERPRINT(CAST(id AS STRING))), 100) < 50;

-- Level 2: 保留约 25% 的节点
CREATE TABLE tree2 AS
SELECT id, parent_id, data
FROM tree1
WHERE MOD(ABS(FARM_FINGERPRINT(CAST(id AS STRING))), 100) < 50;

-- 分层遍历查询
WITH RECURSIVE
-- 先在最高层快速跳跃
top_level AS (
  SELECT id, parent_id, 2 as level
  FROM tree2
  WHERE id = @target_id
  UNION ALL
  SELECT t.id, t.parent_id, 2
  FROM tree2 t
  JOIN top_level c ON t.id = c.parent_id
),
-- 然后在 Level 1 补充细节
mid_level AS (
  SELECT id, parent_id, 1 as level
  FROM tree1
  WHERE id IN (SELECT parent_id FROM top_level)
  UNION ALL
  SELECT t.id, t.parent_id, 1
  FROM tree1 t
  JOIN mid_level c ON t.id = c.parent_id
)
SELECT * FROM mid_level
UNION ALL SELECT * FROM top_level;
```

### 性能提升

Antithesis 报告的性能数据：

| 操作 | 原始方案 | Skiptree 方案 | 提升 |
|------|----------|--------------|------|
| 单次树遍历 | O(depth) 全表扫描 | O(log depth) 全表扫描 | ~10x |
| 100 万次遍历 | 约 4 小时 | 约 25 分钟 | ~10x |
| 存储开销 | 1x | ~2x | 可接受 |

## 实际应用场景

### 场景一：Redis 有序集合

Redis 的 `ZADD`、`ZRANGE`、`ZRANGEBYSCORE` 命令底层就是 Skip List + 哈希表的组合：

```bash
# 这些命令底层都用到了 Skip List
ZADD leaderboard 100 "player1"
ZADD leaderboard 200 "player2"
ZRANGEBYSCORE leaderboard 100 200  # 范围查询 → Skip List 遍历
ZREVRANK leaderboard "player1"     # 排名查询 → Skip List 计数
```

### 场景二：LevelDB/RocksDB 的 MemTable

LSM-Tree 架构的数据库将近期写入缓存在内存中（MemTable），Skip List 是最常见的实现：

```cpp
// LevelDB 源码片段
class MemTable {
  SkipList<const char*, KeyComparator> table_;
  // 写入 → Skip List insert
  // 读取 → Skip List search
  // Compaction → 顺序遍历 Skip List
};
```

为什么不用红黑树？因为 MemTable 在 Compaction 时需要**顺序扫描所有数据**，Skip List 的链表结构使得这个操作极其高效——只需要沿着底层链表线性前进。

### 场景三：并发有序映射

在多线程环境下需要有序集合时，Skip List 是首选：

```java
// Java ConcurrentSkipListMap - JDK 内置实现
ConcurrentSkipListMap<Integer, String> map = new ConcurrentSkipListMap<>();
map.put(1, "one");
map.put(2, "two");
// 无锁读取
String val = map.get(1);
// 并发安全的范围视图
NavigableMap<Integer, String> sub = map.subMap(1, true, 2, true);
```

## 调试技巧

### 问题一：层级分布异常

Skip List 的性能依赖于层级的合理分布。如果层级太少或太多都会影响性能：

```python
def analyze_levels(skip_list):
    """分析 Skip List 的层级分布"""
    level_counts = {}
    for lvl in range(skip_list.level + 1):
        count = 0
        node = skip_list.header.forward[lvl]
        while node:
            count += 1
            node = node.forward[lvl]
        level_counts[lvl] = count

    n = skip_list.size
    for lvl in sorted(level_counts.keys()):
        expected = n / (2 ** lvl)
        actual = level_counts[lvl]
        ratio = actual / expected if expected > 0 else 0
        print(f"Level {lvl}: {actual} 节点, "
              f"期望 ~{expected:.0f}, 比率 {ratio:.2f}")

    # 正常情况下，每层的节点数约为下层的一半
    # 比率偏离 0.5-2.0 范围说明随机数生成器有问题
```

### 问题二：并发死锁

在并发 Skip List 中，最常见的错误是**层间指针不一致**：

```go
// 错误示例：从上层到下层的指针可能指向已删除的节点
func (sl *SkipList) unsafeSearch(key int) {
    x := sl.head
    for i := sl.level - 1; i >= 0; i-- {
        for {
            next := x.forward[i].Load()
            // 问题：next 可能已被标记删除但尚未物理移除
            if next == nil || next.key >= key {
                break
            }
            x = next
        }
    }
}

// 正确做法：检查 marked 标志
func (sl *SkipList) safeSearch(key int) {
    x := sl.head
    for i := sl.level - 1; i >= 0; i-- {
        for {
            next := x.forward[i].Load()
            // 关键：跳过已标记删除的节点
            for next != nil && next.marked.Load() {
                next = next.forward[i].Load()
            }
            if next == nil || next.key >= key {
                break
            }
            x = next
        }
    }
}
```

### 问题三：晋升概率选择

默认的 50% 晋升概率在大多数场景下是合理的，但有些特殊场景需要调整：

- **内存紧张**：降低到 25%（减少索引层节点数）
- **查询密集**：提高到 75%（增加索引密度，减少遍历深度）
- **超大规模数据**：使用 `P = 1/e ≈ 36.8%`（理论最优）

## 性能优化建议

1. **缓存行对齐**：节点大小尽量对齐到 64 字节（CPU 缓存行），减少缓存未命中
2. **内存池分配**：使用 arena 或 slab allocator 分配节点，避免频繁 malloc
3. **批量插入**：对于已排序的数据，批量构建 Skip List 比逐条插入更高效
4. **层级上限**：设置合理的 `MAX_LEVEL`，对于 n 个节点，`⌈log₂(n)⌉ + 1` 足够

## 总结与最佳实践

Skip List 是一个**被低估的实用数据结构**。它的核心优势不在于理论性能（和红黑树一样都是 O(log n)），而在于：

1. **实现简单**：几十行代码就能写出正确版本，而红黑树的旋转逻辑极其复杂
2. **并发友好**：无锁实现天然适合多线程环境
3. **范围查询高效**：底层就是有序链表，范围扫描零额外开销
4. **可扩展性强**：Skiptree 的案例证明，分层索引思想可以推广到更复杂的结构

**最佳实践**：
- 需要有序集合 + 范围查询 → 优先考虑 Skip List
- 高并发读写场景 → 使用成熟的实现（Redis、ConcurrentSkipListMap）
- 分析数据库中的树遍历 → 考虑 Skiptree 模式
- 内存受限 → 降低晋升概率，减少索引层数

下次当你面对一个需要"有序 + 快速查找 + 范围查询"的需求时，不妨给 Skip List 一个机会。它可能没有红黑树那么"学术正统"，但在实际工程中，简单往往意味着更少的 bug。

---

*相关阅读：*

- [What are skiplists good for? - Antithesis Blog](https://antithesis.com/blog/2026/skiptrees/)
- [The Ubiquitous Skiplist - arXiv](https://arxiv.org/pdf/2403.04582)
- [Redis 内部数据结构详解](https://redis.io/docs/data-types/)
