---
title: "TypeScript Sound Mode：当类型检查器决定不再「睁一只眼闭一只眼」"
date: 2026-05-15
category: 技术
tags: [TypeScript, 类型系统, tsz, Rust, 静态分析, 编程语言]
author: 林小白
readtime: 12
cover: https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&h=400&fit=crop
---

# TypeScript Sound Mode：当类型检查器决定不再「睁一只眼闭一只眼」

TypeScript 之所以成功，很大程度上是因为它的「务实」——不追求理论上的完美，而是选择与庞大的 JavaScript 生态共存。但这种务实也留下了缝隙，Bug 就藏在这些缝隙里。最近，一个用 Rust 编写的 TypeScript 编译器 tsz 推出了 **Sound Mode** 实验，试图探索：如果类型检查器愿意更严格一些，能抓住多少隐藏的错误？

## TypeScript 的「不健全」问题

在编程语言理论中，一个类型系统被称为「健全」（sound）意味着：如果程序通过了类型检查，那么运行时就不会出现类型错误。TypeScript 从设计之初就不是健全的——这是一个有意的选择。

考虑这个经典的例子：

```typescript
interface Point2D {
  x: number;
  y: number;
}

const point: Point2D = {
  x: 1,
  y: 2,
  z: 3,  // ✅ TypeScript 会报错：对象字面量中不能有额外属性
};
```

当对象字面量直接赋值时，TypeScript 会保持对象的「新鲜度」（freshness），拒绝额外属性。但一旦给对象起个名字，新鲜感就消失了：

```typescript
const myPoint = {
  x: 1,
  y: 2,
  z: 3,  // 这里不会报错
};

const point: Point2D = myPoint;  // ✅ 通过！z 属性被悄悄忽略了
```

这种行为在实际开发中会导致拼写错误被忽略、接口变更后的残留字段无人发现。TypeScript 的设计哲学是「信任程序员」，但程序员有时候并不值得信任。

## tsz 与 Sound Mode 是什么

**tsz** 是一个用 Rust 编写的 TypeScript 类型检查器、编译器和语言服务。它的主要目标是与 tsc 兼容并提供更好的性能。而 **Sound Mode** 是 tsz 的一个实验性功能，旨在探索更严格的类型检查能走多远。

Sound Mode 的核心理念可以用一句话概括：**在不破坏现有代码模式的前提下，抓住那些「技术上合法但实际危险」的代码**。

值得注意的是，这里的「sound」并不是数学意义上严格的类型健全性证明，而是一种更务实的严格——识别出那些经验丰富的 TypeScript 开发者也会皱眉的代码模式。

## 三个已实现的严格检查

### 1. 粘性新鲜度（Sticky Freshness）

这是 Sound Mode 目前最直观的改进。普通 TypeScript 中，对象字面量的新鲜度在赋值给变量后就消失了。Sound Mode 保持这个新鲜度信号足够长，让多余的属性拼写错误不会因为对象有了名字就溜走。

```typescript
interface Config {
  host: string;
  port: number;
}

// 普通 TypeScript：这里不会报错
const serverConfig = {
  host: "localhost",
  port: 3000,
  prot: 8080,  // 拼写错误！但不会被发现
};

const config: Config = serverConfig;  // 通过检查
// config.port 是 3000，但开发者可能以为是 8080
```

Sound Mode 会标记这种情况，让 `prot` 的拼写错误在编译期就被发现，而不是等到生产环境出现诡异的端口配置问题。

### 2. 方法双变性收紧（Method Bivariance Tightening）

TypeScript 对方法参数使用双变性规则——这是为了让常见的 JavaScript 模式（如事件处理器）能顺利通过类型检查。但这也意味着一些本不该通过的赋值能蒙混过关：

```typescript
interface AnimalHandler {
  handle(animal: Animal): void;
}

// 普通 TypeScript 允许这种赋值
const dogHandler: AnimalHandler = {
  handle(dog: Dog) {  // 只处理 Dog，但声明能处理所有 Animal
    dog.bark();
  }
};

// 如果传入一个 Cat，运行时就会崩溃
```

Sound Mode 将方法参数视为协变的，让这类「看似安全实则危险」的赋值暴露出来。

### 3. 嵌套 any 追踪

`any` 是 TypeScript 的逃生舱口，但它的危险往往被低估。Sound Mode 追踪 `any` 值如何嵌套流动到更精确的类型中：

```typescript
const data: any = JSON.parse(untrustedInput);
const user = data.user;  // any
const name = user.name;  // any

// 这行代码看起来类型安全，但 name 可能是任何东西
console.log(name.toUpperCase());  // 运行时可能崩溃
```

Sound Mode 不是简单地禁止 `any`，而是让 `any` 的「污染」路径更加可见，迫使开发者在边界处做出明确的类型断言。

## 计划中的严格检查

Sound Mode 的路线图上还有几个重要的检查项：

### 可变数组协变（Mutable Array Covariance）

这是 TypeScript 最古老的锋利边缘之一：

```typescript
class Animal {}
class Dog extends Animal {
  bark() { console.log("Woof!"); }
}
class Cat extends Animal {
  meow() { console.log("Meow!"); }
}

const dogs: Dog[] = [new Dog()];
const animals: Animal[] = dogs;  // ✅ 类型检查通过

animals.push(new Cat());  // ✅ 类型检查通过
dogs[1].bark();  // 💥 运行时崩溃：Cat 没有 bark 方法
```

问题在于 `Dog[]` 被赋值给 `Animal[]` 后，可以通过 `Animal[]` 的引用往里推入 `Cat`，然后通过 `Dog[]` 的引用调用 `bark()`。Sound Mode 应该让这种可变数组的不安全赋值可见。

### 未检查的索引访问（Unchecked Indexed Access）

```typescript
const names: string[] = [];
const firstName = names[0];  // TypeScript 认为这是 string
firstName.toUpperCase();  // 💥 运行时崩溃：firstName 是 undefined
```

数组索引访问在运行时可能返回 `undefined`，但 TypeScript 的默认行为是假设值一定存在。Sound Mode 应该强制处理这种可能性。

### 不安全的类型断言（Unsafe Assertions）

```typescript
type Profile = { name: string };

const profile = JSON.parse('{"name":42}') as Profile;
profile.name.toUpperCase();  // 💥 name 实际上是 number
```

断言是有用的，但也是逃生舱口。Sound Mode 应该区分「帮助检查器的良性断言」和「丢弃信息的危险断言」。

### 空数组 reduce 陷阱

```typescript
const amounts: number[] = [];
const total = amounts.reduce((sum, amount) => sum + amount);
// 💥 运行时崩溃：空数组调用 reduce 且没有初始值
```

类型系统让这个操作看起来安全，但运行时依赖于数组非空的假设。

## AI 时代的严格类型

Sound Mode 最引人深思的观点是：**更严格的类型检查在 AI 时代变得更可行了**。

传统的顾虑是——更严格的检查意味着更多错误，更多错误意味着开发者要花更多时间修复。这个成本在人工编写代码时是实实在在的。但当代码越来越多地由 AI 生成和修改时，情况变了：

- AI 可以在更紧的反馈循环中与类型检查器交互
- AI 可以快速重写代码以满足更精确的类型约束
- AI 不会因为「又一个类型错误」而感到沮丧

这意味着，那些过去因为「对人类太严格」而被放弃的类型检查规则，在 AI 辅助编程的背景下可能变得合理。Sound Mode 正是在这个时机窗口中进行探索。

## 如何尝试 Sound Mode

目前最简单的方式是通过 tsz 的在线 Playground，在页面上勾选 Sound Mode 复选框即可体验。

如果你更喜欢命令行，有一个隐藏的 CLI 标志：

```bash
tsz check --sound src/
```

需要强调的是，这还不是一个稳定的功能——没有 `tsconfig.json` 配置项，也没有正式的编译器选项。当前的形态只是为了验证想法。

## 边界在哪里

Sound Mode 面临的核心挑战是：**在哪里画线**。

一个可能的方向是区分用户代码和库代码——在自己写的代码中严格限制 `any`，但允许依赖库内部使用 `any`。这需要 tsz 能可靠地区分代码来源。

更激进的想法是让库的声明自动变得更安全——把 `any` 重的声明投影为使用 `unknown` 的更安全边界。这样应用代码可以获得更严格的检查，而不需要每个依赖都重写类型声明。

但这些转换不能一刀切。有些 `any` 的使用是有意的，有些库声明依赖宽松行为是有道理的。Sound Mode 需要用精确度来赢得信任。

## 对日常开发的启示

即使你暂时不会使用 tsz，Sound Mode 提出的问题也值得每个 TypeScript 开发者思考：

1. **启用 `strict` 模式**：如果你还没有开启 TypeScript 的严格模式，现在是个好时机。`strictNullChecks`、`noImplicitAny` 等选项已经在做 Sound Mode 想做的事的一部分。

2. **减少 `any` 的使用**：用 `unknown` 替代 `any`，在边界处做显式类型检查。这不会增加太多工作量，但能显著提升类型安全。

3. **警惕数组和对象赋值**：记住 `Dog[]` 赋值给 `Animal[]` 的陷阱，考虑使用 `readonly` 数组来防止意外修改。

4. **为 AI 生成的代码设置更高的类型门槛**：既然 AI 不介意多修几个类型错误，为什么不给它更严格的约束呢？

## 总结

TypeScript Sound Mode 不是要推翻 TypeScript 的务实哲学，而是在 AI 辅助编程的新时代，重新审视那些过去被认为「太严格」的检查规则。当修复类型错误的成本大幅下降时，更高的类型安全标准就变得值得追求了。

这个项目还处于早期阶段，但它提出的方向很有价值：**类型检查器不应该只是代码的装饰品，而应该是真正的安全网**。在 AI 能快速迭代代码的今天，我们终于有条件让这张网织得更密一些。

---

*相关阅读：*

- [77万行代码一夜之间换了语言：Bun 的 Rust 重写被合并了，然后呢？](/article/bun-rust-rewrite-merged-2026)
- [AI 日报：2026年5月15日 | Cerebras 上市暴涨108%，AI 编程工具驶入移动端](/article/ai-news-2026-05-15)
