---
AIGC:
    ContentProducer: Minimax Agent AI
    ContentPropagator: Minimax Agent AI
    Label: AIGC
    ProduceID: "00000000000000000000000000000000"
    PropagateID: "00000000000000000000000000000000"
    ReservedCode1: 3045022068492379e829b54086a8df33865882c6aef2d53874a4ee5aa81853d840ea7af0022100a6e3bc895e5ce949bc3b964987fa6c10e8b1ef1d953bfd95b7db967d14bf931f
    ReservedCode2: 3045022006e5906822f74995ab0a69d6b5a2ca3c91f50ea007dd399520618b450878f50d022100edaba2552889adbfdf5d01e034881f56cd01f8f0e43e0ebf1ca3658c24d99541
author: 林小白
category: 技术
cover: https://images.unsplash.com/photo-1504639725590-34d0984388bd?w=1200&h=600&fit=crop
date: 2024-02-08T00:00:00Z
readtime: 14
tags: 算法,图论,数据结构,JavaScript
title: 算法工程师的数学基础：图论入门实战
---

# 算法工程师的数学基础：图论入门实战

图论是计算机科学中非常重要的数学分支，它在社交网络、路线规划、任务调度等场景中有着广泛的应用。本文将从实际问题出发，带你入门图论的核心概念和算法。

## 什么是图

图（Graph）是由顶点（Vertex）和边（Edge）组成的数据结构：

```
    A --- B
   /|     |\
  / |     | \
 C  |     |  D
 |  |     |  |
 |  |     |  /
   \-------/
```

### 图的基本术语

- **顶点（Vertex）**: 图中的节点
- **边（Edge）**: 连接两个顶点的线
- **度（Degree）**: 顶点相连的边的数量
- **路径（Path）**: 顶点序列
- **环（Cycle）**: 起点和终点相同的路径

### 图的分类

```typescript
// 无向图 vs 有向图
interface UndirectedGraph {
  vertices: string[];
  edges: [string, string][];
}

interface DirectedGraph {
  vertices: string[];
  edges: [string, string][]; // [from, to]
}

// 加权图
interface WeightedGraph {
  vertices: string[];
  edges: [string, string, number][]; // [from, to, weight]
}
```

## 图的表示方法

### 1. 邻接矩阵

```javascript
// 无向图的邻接矩阵
const graph = [
  [0, 1, 1, 0],  // A: 连接 B, C
  [1, 0, 0, 1],  // B: 连接 A, D
  [1, 0, 0, 1],  // C: 连接 A, D
  [0, 1, 1, 0],  // D: 连接 B, C
];

// 有向图的邻接矩阵
const directedGraph = [
  [0, 1, 1, 0],  // A: → B, → C
  [0, 0, 0, 1],  // B: → D
  [0, 0, 0, 1],  // C: → D
  [0, 0, 0, 0],  // D: 无出边
];
```

### 2. 邻接表

```javascript
// 邻接表表示
const adjacencyList = {
  'A': ['B', 'C'],
  'B': ['A', 'D'],
  'C': ['A', 'D'],
  'D': ['B', 'C'],
};

// 有向图的邻接表
const directedAdjacencyList = {
  'A': ['B', 'C'],
  'B': ['D'],
  'C': ['D'],
  'D': [],
};
```

### 3. 边的列表

```javascript
// 边列表表示
const edgeList = [
  { from: 'A', to: 'B', weight: 4 },
  { from: 'A', to: 'C', weight: 2 },
  { from: 'B', to: 'D', weight: 5 },
  { from: 'C', to: 'D', weight: 1 },
];
```

## 经典算法

### 1. 深度优先搜索（DFS）

```javascript
function dfs(graph, start, visited = new Set()) {
  visited.add(start);
  console.log(`访问: ${start}`);

  for (const neighbor of graph[start] || []) {
    if (!visited.has(neighbor)) {
      dfs(graph, neighbor, visited);
    }
  }

  return visited;
}

// 使用示例
const graph = {
  'A': ['B', 'C'],
  'B': ['D', 'E'],
  'C': ['F'],
  'D': [],
  'E': ['F'],
  'F': [],
};

dfs(graph, 'A');
// 输出: A -> B -> D -> E -> F -> C
```

### 2. 广度优先搜索（BFS）

```javascript
function bfs(graph, start) {
  const visited = new Set([start]);
  const queue = [start];
  const result = [];

  while (queue.length > 0) {
    const vertex = queue.shift();
    result.push(vertex);

    for (const neighbor of graph[vertex] || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return result;
}

// BFS 找最短路径
function bfsShortestPath(graph, start, end) {
  const visited = new Set([start]);
  const queue = [[start, [start]]];

  while (queue.length > 0) {
    const [vertex, path] = queue.shift();

    if (vertex === end) {
      return path;
    }

    for (const neighbor of graph[vertex] || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push([neighbor, [...path, neighbor]]);
      }
    }
  }

  return null; // 没有路径
}
```

### 3. 最短路径算法

#### Dijkstra 算法

```javascript
function dijkstra(graph, start) {
  const distances = {};
  const previous = {};
  const unvisited = new Set();

  // 初始化
  for (const vertex in graph) {
    distances[vertex] = Infinity;
    previous[vertex] = null;
    unvisited.add(vertex);
  }
  distances[start] = 0;

  while (unvisited.size > 0) {
    // 找到距离最小的顶点
    let minVertex = null;
    for (const vertex of unvisited) {
      if (minVertex === null || distances[vertex] < distances[minVertex]) {
        minVertex = vertex;
      }
    }

    if (distances[minVertex] === Infinity) break;
    unvisited.delete(minVertex);

    // 更新邻居距离
    for (const [neighbor, weight] of graph[minVertex]) {
      const newDist = distances[minVertex] + weight;
      if (newDist < distances[neighbor]) {
        distances[neighbor] = newDist;
        previous[neighbor] = minVertex;
      }
    }
  }

  return { distances, previous };
}

// 还原路径
function getPath(previous, end) {
  const path = [];
  let current = end;
  while (current !== null) {
    path.unshift(current);
    current = previous[current];
  }
  return path;
}
```

### 4. 拓扑排序

```javascript
function topologicalSort(graph) {
  const inDegree = {};
  const result = [];
  const queue = [];

  // 计算入度
  for (const vertex in graph) {
    inDegree[vertex] = 0;
  }
  for (const vertex in graph) {
    for (const neighbor of graph[vertex]) {
      inDegree[neighbor]++;
    }
  }

  // 入度为0的顶点入队
  for (const vertex in inDegree) {
    if (inDegree[vertex] === 0) {
      queue.push(vertex);
    }
  }

  while (queue.length > 0) {
    const vertex = queue.shift();
    result.push(vertex);

    for (const neighbor of graph[vertex]) {
      inDegree[neighbor]--;
      if (inDegree[neighbor] === 0) {
        queue.push(neighbor);
      }
    }
  }

  return result;
}

// 应用：任务调度
const tasks = {
  '准备食材': ['烹饪'],
  '烹饪': ['装盘'],
  '装盘': [],
  '布置餐桌': [],
  '开吃': ['准备食材', '烹饪', '装盘', '布置餐桌']
};

console.log(topologicalSort(tasks));
// 输出任务执行顺序
```

## 实际应用场景

### 1. 社交网络分析

```javascript
// 找到共同好友
function findCommonFriends(graph, user1, user2) {
  const friends1 = new Set(graph[user1] || []);
  const friends2 = new Set(graph[user2] || []);
  return [...friends1].filter(friend => friends2.has(friend));
}

// 找到可能认识的人（朋友的朋友）
function suggestFriends(graph, user) {
  const friends = new Set(graph[user] || []);
  const suggestions = new Set();

  for (const friend of friends) {
    for (const friendOfFriend of graph[friend] || []) {
      if (!friends.has(friendOfFriend) && friendOfFriend !== user) {
        suggestions.add(friendOfFriend);
      }
    }
  }

  return [...suggestions];
}
```

### 2. 城市路线规划

```javascript
// 构建城市地图
const cityMap = {
  '北京': [['天津', 120], ['石家庄', 280]],
  '天津': [['北京', 120], ['唐山', 120]],
  '石家庄': [['北京', 280], ['郑州', 350]],
  '郑州': [['石家庄', 350], ['武汉', 530]],
  '武汉': [['郑州', 530], ['长沙', 350]],
};

// 计算最短距离
const { distances, previous } = dijkstra(cityMap, '北京');
console.log(distances['武汉']); // 输出: 1220
console.log(getPath(previous, '武汉')); // ['北京', '石家庄', '郑州', '武汉']
```

## 算法复杂度分析

| 算法 | 时间复杂度 | 空间复杂度 | 适用场景 |
|------|------------|------------|----------|
| DFS | O(V + E) | O(V) | 连通性检测 |
| BFS | O(V + E) | O(V) | 最短路径 |
| Dijkstra | O(V²) 或 O(E log V) | O(V) | 加权最短路径 |
| 拓扑排序 | O(V + E) | O(V) | 任务调度 |

> V = 顶点数，E = 边数

## 总结

图论是解决复杂关系问题的强大工具。本文我们学习了：

1. **图的基本概念**: 顶点、边、有向/无向、加权
2. **图的表示方法**: 邻接矩阵、邻接表、边列表
3. **核心算法**: DFS、BFS、Dijkstra、拓扑排序
4. **实际应用**: 社交网络、路线规划、任务调度

希望这篇图论入门指南对你有所帮助！

---

*延伸阅读：*

- [TypeScript 高级技巧：类型系统深度探索](/article/typescript-advanced)
- [从零构建现代化前端工作流：Vite + Vue 3 实战指南](/article/vite-vue3-guide)
