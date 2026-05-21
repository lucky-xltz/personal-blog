---
title: "Node.js 26 正式发布：Temporal API 终结 JavaScript 日期处理的二十年之痛"
date: 2026-05-21
category: 技术
tags: [Node.js, Temporal, JavaScript, TypeScript, 前端开发, 后端架构]
author: 林小白
readtime: 12
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# Node.js 26 正式发布：Temporal API 终结 JavaScript 日期处理的二十年之痛

2026 年 4 月 29 日，Node.js 26.0.0 正式发布。这个版本最大的亮点不是 V8 引擎升级到 14.6，也不是 Undici 更新到 8.0，而是一个等待了近十年的 TC39 提案终于落地——**Temporal API 正式默认启用**。

对于每一个曾经在 `Date` 对象的时区陷阱、夏令时 bug 和月份索引地狱中挣扎过的 JavaScript 开发者来说，这是一个里程碑式的时刻。

## 一、`Date` 对象：一个二十年的技术债

JavaScript 的 `Date` 对象诞生于 1995 年，参考了 Java 1.0 的 `java.util.Date` 设计。讽刺的是，Java 自己早就废弃了这个设计，先后推出了 `Calendar`、`java.time`（JSR-310），而 JavaScript 却被这个 1995 年的设计锁死了整整 31 年。

### `Date` 的核心问题

**可变性（Mutability）**：`Date` 对象是可变的，这意味着你传递给函数的日期可能被意外修改。

```javascript
const birthday = new Date('2026-01-15');
someFunction(birthday);
console.log(birthday); // 可能已经被修改了！
```

**零索引月份**：月份从 0 开始计数，这是 JavaScript 最著名的"设计失误"之一。

```javascript
new Date(2026, 0, 15)  // 2026年1月15日，不是0月！
new Date(2026, 11, 25) // 2026年12月25日
```

**时区处理混乱**：`Date` 内部始终以 UTC 存储，但几乎所有方法都依赖本地时区，导致时区相关的 bug 层出不穷。

```javascript
// 在 UTC+8 时区
const d = new Date('2026-06-15T00:00:00Z');
d.getDate();      // 15 还是 16？取决于你的时区！
d.getUTCDate();   // 15，但你必须记得用 getUTC* 版本
```

**无法表示"没有时间的日期"**：你无法创建一个纯粹的"日期"值，它总是带着时间信息。当你想表示"2026年5月21日"这个概念时，`Date` 会强制附加一个时间，而这个时间在不同时区的解读完全不同。

**解析不一致**：不同浏览器对日期字符串的解析行为不一致，这是无数跨浏览器 bug 的根源。

```javascript
new Date('2026-05-21')      // UTC 时间 00:00:00
new Date('2026/05/21')      // 本地时间 00:00:00
new Date('May 21, 2026')    // 本地时间 00:00:00
// 三种写法，三种行为！
```

## 二、Temporal API：从头设计的现代日期时间方案

Temporal 是 TC39 委员会历经近十年打磨的 Stage 4 提案（已正式纳入 ECMA-262 标准）。它的设计目标非常明确：**提供一套不可变、时区感知、类型安全的日期时间 API，彻底替代 `Date` 对象**。

### 核心设计原则

1. **所有 Temporal 对象都是不可变的**——创建后不能修改，所有操作返回新对象
2. **明确区分"有时间的日期"和"没有时间的日期"**——通过不同的类型表达不同的精度
3. **一等公民时区支持**——时区不是事后补丁，而是 API 的核心部分
4. **日历系统无关**——支持非公历日历（如伊斯兰历、希伯来历等）

### Temporal 的类型体系

Temporal 提供了 6 个核心类型，每个类型精确对应一种日期时间语义：

| 类型 | 语义 | 示例 |
|------|------|------|
| `Temporal.Instant` | UTC 时间线上的精确时刻 | `2026-05-21T12:00:00Z` |
| `Temporal.ZonedDateTime` | 带时区的日期时间 | `2026-05-21T20:00:00+08:00[Asia/Shanghai]` |
| `Temporal.PlainDate` | 纯日期（无时间、无时区） | `2026-05-21` |
| `Temporal.PlainTime` | 纯时间（无日期、无时区） | `14:30:00` |
| `Temporal.PlainDateTime` | 日期+时间（无时区） | `2026-05-21T14:30:00` |
| `Temporal.PlainYearMonth` | 年月 | `2026-05` |
| `Temporal.PlainMonthDay` | 月日 | `05-21` |

## 三、实战指南：用 Temporal 重写常见日期操作

### 3.1 创建日期时间

```javascript
// 创建一个精确时刻（UTC）
const now = Temporal.Now.instant();
console.log(now.toString()); // 2026-05-21T04:00:00.123456789Z

// 创建带时区的当前时间
const zoned = Temporal.Now.zonedDateTimeISO();
console.log(zoned.toString()); // 2026-05-21T12:00:00+08:00[Asia/Shanghai]

// 创建纯日期
const date = new Temporal.PlainDate(2026, 5, 21);
console.log(date.toString()); // 2026-05-21

// 从字符串解析
const parsed = Temporal.PlainDate.from('2026-05-21');
const zonedParsed = Temporal.ZonedDateTime.from(
  '2026-05-21T12:00:00+08:00[Asia/Shanghai]'
);
```

### 3.2 日期运算——告别手动计算

Temporal 的所有运算都返回新对象，原对象不变：

```javascript
const today = Temporal.Now.plainDateISO();

// 3 天后
const threeDaysLater = today.add({ days: 3 });

// 2 个月前
const twoMonthsAgo = today.subtract({ months: 2 });

// 复合运算
const future = today.add({ months: 3, weeks: 2, days: 1 });

// 跨越夏令时的日期运算——自动处理！
const winter = new Temporal.PlainDate(2026, 11, 1);
const summer = winter.add({ months: 6});
// 不会因为夏令时而出现 off-by-one 错误
```

### 3.3 时区转换——一行代码搞定

```javascript
// 创建一个 UTC 时刻
const utc = Temporal.Instant.from('2026-05-21T12:00:00Z');

// 转换到各个时区
const tokyo = utc.toZonedDateTimeISO('Asia/Tokyo');
const nyc = utc.toZonedDateTimeISO('America/New_York');
const shanghai = utc.toZonedDateTimeISO('Asia/Shanghai');

console.log(tokyo.hour);     // 21
console.log(nyc.hour);       // 8
console.log(shanghai.hour);  // 20

// ZonedDateTime 之间也可以直接转换
const tokyoTime = shanghai.withTimeZone('Asia/Tokyo');
```

### 3.4 计算两个日期之间的差异

```javascript
const start = new Temporal.PlainDate(2026, 1, 1);
const end = new Temporal.PlainDate(2026, 5, 21);

// 精确差异
const diff = start.until(end);
console.log(diff.toString()); // P140D（140天）

// 按指定单位返回
console.log(start.until(end, { largestUnit: 'months' }).toString());
// P4M20D（4个月20天）

// 计算年龄
const birthday = new Temporal.PlainDate(1995, 6, 15);
const today = Temporal.Now.plainDateISO();
const age = birthday.until(today, { largestUnit: 'years' });
console.log(`年龄：${age.years} 岁`); // 年龄：30 岁
```

### 3.5 日历和本地化

```javascript
// 使用伊斯兰历
const islamicDate = new Temporal.PlainDate(
  1447, 11, 22, 'islamic-umalqura'
);
console.log(islamicDate.toString()); // 1447-11-22[u-ca=islamic-umalqura]
console.log(islamicDate.toLocaleString('zh-CN'));
// 2026年5月21日（公历对应日期）

// 使用日本历
const jpDate = new Temporal.PlainDate(2026, 5, 21, 'japanese');
console.log(jpDate.era); // reiwa
console.log(jpDate.year); // 8（令和8年）
```

## 四、Node.js 26 的其他重要更新

### 4.1 V8 引擎升级到 14.6

V8 14.6 带来了两个新的 TC39 提案支持：

**Upsert 操作**：`Map.prototype.getOrInsert()` 和 `Map.prototype.getOrInsertComputed()`，终于可以在一次操作中完成"获取或插入"：

```javascript
const cache = new Map();

// 之前
if (!cache.has(key)) {
  cache.set(key, expensiveComputation(key));
}
const value = cache.get(key);

// 现在
const value = cache.getOrInsert(key, expensiveComputation(key));
```

**Iterator.concat()**：将多个迭代器串联成一个：

```javascript
const combined = Iterator.concat(
  [1, 2, 3].values(),
  [4, 5].values(),
  [6, 7, 8].values()
);
console.log([...combined]); // [1, 2, 3, 4, 5, 6, 7, 8]
```

### 4.2 Undici 8.0

Node.js 的 HTTP 客户端 Undici 升级到 8.0，带来了更好的 HTTP/2 支持和性能改进。

### 4.3 stream.compose 稳定

`stream.compose` 正式标记为稳定 API，用于组合流（Streams）变得更加可靠。

### 4.4 移除的特性

- `--experimental-transform-types` 被移除——TypeScript 类型转换不再内置，需要使用 `tsx` 或 `tsc`
- `module.register()` 被标记为运行时废弃
- 旧的 `_stream_*` 内部模块完全移除
- `http.Server.prototype.writeHeader()` 完全移除（使用 `writeHead()` 替代）

## 五、迁移指南：从 Date 到 Temporal

### 5.1 渐进式迁移策略

Temporal 和 `Date` 可以共存。推荐的迁移路径：

1. **新代码全面使用 Temporal**——所有新的日期时间操作都用 Temporal
2. **库作者优先迁移**——如果你维护 npm 包，优先提供 Temporal 支持
3. **逐步替换 `Date`**——按模块逐步将 `Date` 替换为 Temporal 类型

### 5.2 与 Date 互转

```javascript
// Date → Temporal
const legacyDate = new Date();
const instant = legacyDate.toTemporalInstant();

// Temporal → Date
const temporalInstant = Temporal.Now.instant();
const jsDate = new Date(temporalInstant.epochMilliseconds);
```

### 5.3 与第三方库配合

目前主流日期库的状态：

| 库 | 建议 |
|------|------|
| Moment.js | 已于 2020 年停止维护，趁此机会迁移到 Temporal |
| date-fns | 可继续使用，逐步引入 Temporal |
| Luxon | 作者建议新项目直接用 Temporal |
| Day.js | 轻量场景可继续使用，复杂场景迁移到 Temporal |

## 六、浏览器支持现状

Temporal 的浏览器支持正在快速推进：

- ✅ **Chrome 144**（2026年1月）——已支持
- ✅ **Firefox 139**（2025年5月）——已支持
- ⏳ **Safari**——尚未支持，这是目前 Web 端采用的最大障碍
- ✅ **Node.js 26**（2026年5月）——已支持
- ✅ **Deno**——已支持（基于 V8）

对于需要支持 Safari 的项目，可以使用 `@js-temporal/polyfill` 作为过渡方案：

```bash
npm install @js-temporal/polyfill
```

```javascript
import { Temporal } from '@js-temporal/polyfill';
// 代码无需修改
```

## 七、性能考量

Temporal 对象的创建和操作比 `Date` 稍慢，因为：

1. 不可变性意味着每次操作都创建新对象
2. 时区计算需要查表和计算
3. 类型系统更复杂

但在实际应用中，这些性能差异几乎可以忽略。日期操作很少成为性能瓶颈，而 Temporal 带来的正确性和可维护性收益远超微小的性能开销。

如果你确实需要高性能的日期运算（如批量处理百万条日志的时间戳），可以考虑：
- 使用 `Temporal.Instant` 而非 `Temporal.ZonedDateTime`（避免时区计算）
- 缓存时区对象的创建
- 在极端场景下，`Date` 的 epoch 毫秒数运算仍然是最快的

## 八、总结

Node.js 26 的发布标志着 JavaScript 日期处理进入了一个新时代。Temporal API 不仅仅是一个新 API，它是对过去 30 年日期处理痛点的系统性回应。

**对开发者的意义**：
- 不再需要 Moment.js、Luxon 等第三方日期库
- 时区相关的 bug 将大幅减少
- 代码的可读性和可维护性显著提升
- 不可变性避免了意外的副作用

**行动建议**：
1. 立即升级到 Node.js 26，开始在新项目中使用 Temporal
2. 在现有项目中逐步引入 Temporal，替代 `Date` 的使用
3. 关注 Safari 的支持进度，准备好 polyfill 方案
4. 库作者应开始提供 Temporal 原生支持

`Date` 对象的黄昏已经到来，Temporal 的黎明正在破晓。三十年的技术债，终于有了偿还的希望。

---

*相关阅读：*

- [Node.js 26.0.0 官方发布公告](https://nodejs.org/en/blog/release/v26.0.0)
- [TC39 Temporal 提案文档](https://tc39.es/proposal-temporal/docs/)
- [Temporal API Cookbook](https://tc39.es/proposal-temporal/docs/cookbook.html)
