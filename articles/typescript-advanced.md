---
AIGC:
    ContentProducer: Minimax Agent AI
    ContentPropagator: Minimax Agent AI
    Label: AIGC
    ProduceID: "00000000000000000000000000000000"
    PropagateID: "00000000000000000000000000000000"
    ReservedCode1: 3044022004e59bb6a5410f1a309cb9a630f44eb536218a52d9ee7c5bf2d1b31c6623384b02206c5e506b5a6814782cd82e44337bedaf3f9f5523e22a4cd4355c0285e101fc21
    ReservedCode2: 3046022100a6b149ccaafdafaf9220678a929efa96667f529e401158952cec2ef7af4e0ad3022100ecc6492d200109289cc5755dbe07310def533d17c7c19c78727d140108f12f81
author: 林小白
category: 技术
cover: https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=1200&h=600&fit=crop
date: 2024-03-01T00:00:00Z
readtime: 18
tags: TypeScript,类型系统,JavaScript,前端开发
title: TypeScript 高级技巧：类型系统深度探索
---

# TypeScript 高级技巧：类型系统深度探索

TypeScript 的类型系统是其最强大的特性之一。掌握高级类型技巧不仅能提升代码的类型安全性，还能让代码更加优雅和易维护。本文将深入探讨 TypeScript 类型系统的高级特性。

## 条件类型

条件类型是 TypeScript 2.8 引入的强大特性，它允许我们根据输入类型来决定输出类型。

### 基本语法

```typescript
type ExtractType<T, U> = T extends U ? T : never;

// 提取字符串类型
type Strings = ExtractType<string | number | boolean, string>;
// 结果: string

// 提取函数参数类型
type Parameters<T extends (...args: any) => any> =
  T extends (...args: infer P) => any ? P : never;
```

### 实际应用场景

```typescript
// 获取数组元素类型
type ArrayElement<T> = T extends (infer E)[] ? E : never;

type NumberElement = ArrayElement<number[]>; // number
type StringElement = ArrayElement<string[]>; // string

// 获取Promiseresolve的类型
type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

type ResolvedString = UnwrapPromise<Promise<string>>; // string
type ResolvedNumber = UnwrapPromise<number>; // number
```

## 映射类型

映射类型允许我们从已有类型创建新类型，是构建工具类型的基础。

### 基础映射类型

```typescript
type Readonly<T> = {
  readonly [P in keyof T]: T[P];
};

type Partial<T> = {
  [P in keyof T]?: T[P];
};

type Required<T> = {
  [P in keyof T]-?: T[P];
};

type Pick<T, K extends keyof T> = {
  [P in K]: T[P];
};

type Omit<T, K extends keyof T> = {
  [P in Exclude<keyof T, K>]: T[P];
};
```

### 带修饰符的映射

```typescript
// 添加可选修饰符
type Optional<T> = {
  [P in keyof T]+?: T[P];
};

// 添加只读修饰符
type Frozen<T> = {
  +readonly [P in keyof T]: T[P];
};

// 移除只读修饰符
type Mutable<T> = {
  -readonly [P in keyof T]: T[P];
};
```

## 模板字面量类型

TypeScript 4.1 引入了模板字面量类型，让我们可以操作字符串类型。

### 基本用法

```typescript
type EventName = `on${Capitalize<string>}`;

type ButtonEvents = {
  onClick: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
};

// 提取事件名
type ExtractEventName<T> = {
  [K in keyof T]: K extends `on${infer E}` ? E : never;
}[keyof T];

type Events = ExtractEventName<ButtonEvents>;
// "Click" | "MouseEnter" | "MouseLeave"
```

### 实际应用：CSS 类型

```typescript
type CSSUnit = 'px' | 'em' | 'rem' | 'vw' | 'vh' | '%';
type CSSProperty = 'margin' | 'padding' | 'top' | 'left' | 'right' | 'bottom';
type Direction = 'top' | 'right' | 'bottom' | 'left';

type CSSValue = `${number}${CSSUnit}`;
type DirectionalCSS = `${CSSProperty}-${Direction}`;

type Spacing = Record<DirectionalCSS, CSSValue>;
```

## 递归类型

TypeScript 支持递归类型定义，这在处理嵌套数据结构时非常有用。

### 深度只读

```typescript
type DeepReadonly<T> = T extends (infer U)[]
  ? DeepReadonly<U>[]
  : T extends object
  ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
  : T;

interface NestedConfig {
  database: {
    host: string;
    credentials: {
      username: string;
      password: string;
    };
  };
}

type Config = DeepReadonly<NestedConfig>;
// 所有嵌套属性都变为只读
```

### JSON 类型

```typescript
type JsonPrimitive = string | number | boolean | null;
type JsonObject = { [key: string]: Json };
type JsonArray = Json[];
type Json = JsonPrimitive | JsonObject | JsonArray;

function parseJson(str: string): Json {
  return JSON.parse(str);
}

const data = parseJson('{"name": "林小白", "age": 18}');
// data 的类型是 Json
```

## 类型守卫与类型断言

### 自定义类型守卫

```typescript
interface Cat {
  meow(): void;
}

interface Dog {
  bark(): void;
}

function isCat(animal: Cat | Dog): animal is Cat {
  return (animal as Cat).meow !== undefined;
}

function makeSound(animal: Cat | Dog) {
  if (isCat(animal)) {
    animal.meow();
  } else {
    animal.bark();
  }
}
```

### 断言函数

```typescript
function assertIsDefined<T>(
  val: T,
  msg: string
): asserts val is NonNullable<T> {
  if (val === undefined || val === null) {
    throw new Error(msg);
  }
}

function processValue(value: string | undefined) {
  assertIsDefined(value, 'Value must be defined');
  // 这里的 value 类型是 string
  console.log(value.toUpperCase());
}
```

## 工具类型进阶

### 分布式条件类型

```typescript
type ToArray<T> = T extends any ? T[] : never;

type StringArray = ToArray<string>; // string[]
type UnionArray = ToArray<string | number>; // string[] | number[]

// 如果不想分布式
type ToArrayNonDist<T> = [T] extends [any] ? T[] : never;
type BothArrays = ToArrayNonDist<string | number>; // (string | number)[]
```

### 组合使用

```typescript
// 创建一个只读的去掉了某个属性的类型
type ImmutableOmit<T, K extends keyof T> = DeepReadonly<Omit<T, K>>;

// 创建一个函数类型，保留参数名和返回类型
type Promisify<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<R>
    : T[K];
};

interface UserService {
  getUser(id: string): User;
  createUser(data: CreateUserDto): User;
  deleteUser(id: string): void;
}

type AsyncUserService = Promisify<UserService>;
// 所有方法都返回 Promise
```

## 实战技巧

### 类型安全的 EventEmitter

```typescript
type EventMap = Record<string, any>;

class TypedEventEmitter<T extends EventMap> {
  private listeners: {
    [K in keyof T]?: Set<T[K]>;
  } = {};

  on<K extends keyof T>(event: K, listener: T[K]): this {
    if (!this.listeners[event]) {
      this.listeners[event] = new Set();
    }
    this.listeners[event]!.add(listener);
    return this;
  }

  emit<K extends keyof T>(event: K, ...args: Parameters<T[K]>): void {
    this.listeners[event]?.forEach(listener => listener(...args));
  }
}

// 使用示例
interface Events {
  userJoined: (user: User) => void;
  messageSent: (message: string, user: User) => void;
}

const emitter = new TypedEventEmitter<Events>();

emitter.on('userJoined', (user) => {
  console.log(`${user.name} joined`);
});

emitter.emit('userJoined', { name: '林小白', id: '1' });
```

## 性能注意事项

### 类型推断优化

```typescript
// 避免过度复杂的类型计算
type ComplexType<T> = /* ... */;

// 使用类型别名缓存计算结果
type CachedType = ComplexType<MyInput>;
const value: CachedType = getValue();
```

## 总结

TypeScript 的类型系统是一个极其强大的工具，掌握这些高级技巧可以让我们：

1. **提升代码质量**: 编译时捕获更多错误
2. **改善开发体验**: 更好的IDE智能提示
3. **构建更安全的API**: 精确的类型定义
4. **减少运行时错误**: 类型即文档

希望这篇深度探索能帮助你更好地掌握 TypeScript 的类型系统！

---

*推荐阅读：*

- [从零构建现代化前端工作流：Vite + Vue 3 实战指南](/article/vite-vue3-guide)
- [算法工程师的数学基础：图论入门实战](/article/graph-theory)
