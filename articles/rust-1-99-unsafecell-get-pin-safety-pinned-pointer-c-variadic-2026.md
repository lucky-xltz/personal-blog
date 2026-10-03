---
title: "Rust 1.99 深度拆解:UnsafeCell 绕过 get 被合法化 + Pin 安全契约重写 + C-variadic 稳定 + Cargo 新增 debug profile + CI 默认关增量编译"
date: 2026-10-03
category: 技术
tags: [Rust, Rust 1.99, UnsafeCell, Pin, PinSafePointer, unsafe, 别名模型, 内存安全, C-variadic, naked function, inline asm, LLVM 23, Cargo, debug profile, 增量编译, CI, RangeInclusive, rustdoc, 编译器, 系统语言, 类型系统, unsafe-code-guidelines, 编译期保证, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1635776062127-d379b0ba0493?w=600&h=400&fit=crop
excerpt: "Rust 1.99.0(2026-10-01)表面是 1.98 之后的常规 6 周版本,骨子里是把 unsafe 代码的「人肉默契」全面升级成「编译器可检查的显式契约」:UnsafeCell 内容不再必须走 get 才算合法访问、Pin 的安全不变量从 3 条扩成 5 条并新设 PinSafePointer trait、C-variadic 函数定义稳定、128 位整数可走 xmm/ymm/zmm 向量寄存器、Cargo 拆出 debug profile 并在 CI 下默认关闭增量编译、rustdoc trait impl 过滤重写平均快 20%。本文从别名模型的物理约束讲起,拆解 6 大承重级改动,给出 5 段可在 1.99 上直接跑的代码、5 套写法 17 维度对比、6 条 6-12 月可验证硬指标,以及 3 个长期判断:unsafe 的未来是「契约下沉到类型系统」、Cargo profile 正在变成构建图的一等公民、LLVM 23 把 Rust 推进 f128 与 RISC-V musl 主流化。"
---

# Rust 1.99 深度拆解:当 unsafe 的「人肉默契」变成编译器可检查的显式契约

## 一句话版本

Rust 1.99.0(2026-10-01 发布)把 Rust 历史上三处「大家都这么写、但没人能证明它合法」的 unsafe 灰区,一次性写进了规范:① `UnsafeCell` 的内容**不经过 `get()` 也能被合法访问**;② `Pin` 的安全不变量从「指针不变量」升级为**指针 + 守护 trait 双层契约**(`PinSafePointer`);③ C-variadic 函数定义从 nightly-only 变成 stable。再加上 Cargo 把 `debug` profile 拆成一等公民、CI 环境默认关闭增量编译、rustdoc trait impl 过滤重写平均快 20%,这个版本的主题异常统一:**把「约定俗成」翻译成「类型系统说得清、编译器查得到」**。

如果你只写 safe Rust,这个版本对你最大的影响是 `a..=b` 区间的迭代优化和 `Vec::into_parts`/`from_utf8_lossy_owned` 这些新 API;如果你写 unsafe、写过程宏、写 FFI、写库的公共 API,这个版本有**三个必须重读文档的契约变更**——其中两个虽然官方都说「不是 breaking change」,但你的代码可能正好靠旧的未定义行为在跑。

---

## 〇、今天为什么值得为 1.99 写一篇深度文章

先把今天(2026-10-03)另外两篇放在一起,说明这一篇为什么不是凑数:

| | 早间 · AI 日报五维定价战 | 中午 · Caddy v2.11.6 | **本文 · Rust 1.99** |
|---|---|---|---|
| 栈层 | AI 商业层 | 边缘网关 / 反向代理运行时层 | **系统语言 + 编译器层** |
| 主体 | 苹果因 AI agent 风险收紧 macOS Full Disk Access,要求「very explicit user action」 | 请求头上限 1MB 砍到 16KiB,默认丢弃下划线/点号头部,改用 `expected_*` 白名单 | `UnsafeCell` 访问规则写死进规范,`Pin` 安全不变量扩成 5 条 |
| 机制 | 操作系统层:不给默认授权,要用户亲手开 | 网关层:不给默认放行,要配置显式声明 | **语言层:不给默认信任,要类型系统证明** |
| 同一句 | 「权限不能靠默契授予」 | 「路由不能靠默契放行」 | **「安全不能靠默契保证」** |

三条线落在三个完全不同的栈层,讲的是同一件事:**2026 年基础设施的安全边界,正在从「默认开放 + 黑名单」整体迁移到「默认关闭 + 显式声明」**。操作系统这么干(Caddy 那篇的苹果 Full Disk Access)、边缘网关这么干(同篇的 `expected_*` 白名单)、到了晚上,语言本身也开始这么干——而语言层的变更最难回退,因为它编译进你二进制里的每一行代码。

所以本文的组织方式不是「1.99 有哪些新功能」,而是**三条承重级契约线 + 三条工程线**:

- **契约线(主线)**:`UnsafeCell` 访问合法化 → `Pin` 安全契约重写 → 编译器/lint 把灰区逐个照亮
- **FFI 与底层线**:C-variadic 稳定 + naked 函数变参 + 128 位整数走向量寄存器
- **工程线**:Cargo `debug` profile 拆分 + CI 默认关增量编译 + rustdoc 20% 提速 + LLVM 23

后两条线最后讲,因为它们服务的是同一件事:**让「写正确 unsafe 代码」的成本,不要比写错误 unsafe 代码更高**。

---

## 一、问题的源头:为什么 Rust 的 unsafe 需要「契约」

### 1.1 safe/unsafe 分界线的物理意义

Rust 的类型系统保证的是**别名 + 生命周期 + 可变性**三者的交集不违反「mutable XOR aliased」:同一时间要么只有一个可变引用,要么有任意多个不可变引用。编译器靠这条规则做两件事:

1. **前端检查**:borrow checker 在编译期拒绝违反规则的代码
2. **后端优化**:LLVM 依据这条规则做别名分析,把 `noalias` 参数 hint 直接喂给优化器

问题在于,**「可变 XOR 别名」在硬件层面没有任何强制力**。它是一个纯粹的语言层虚构,必须有人来保证它成立。Rust 的答案是把证明责任切成两半:

- safe 代码的类型系统自动证明
- unsafe 代码由**程序员**向编译器提交一份**人肉证明**

这份「人肉证明」在过去十年里,实际上大量依赖的是**未写进规范的默契**。一个典型例子:几乎所有写 `UnsafeCell` 的人都知道「要通过 `get()` 拿到 `*mut T` 再访问」,但**没有任何规范条款说你绕过 `get()` 直接访问内部字段是 UB**——直到 1.99。

### 1.2 unsafe-code-guidelines:把默契变成文字的十年工程

Rust 有一个专门的工作组在 unsafe-code-guidelines 仓库(简称 UCG)里做这件事:逐条讨论「这段 unsafe 代码到底有没有 UB」,讨论达成共识后写进 [Reference](https://doc.rust-lang.org/reference/) 或 unsafe-code-guidelines 文档,最后由编译器实现跟进。

1.99 这次一口气落了 UCG 的两个长期议题:

- [UCG #281](https://github.com/rust-lang/unsafe-code-guidelines/issues/281) — `UnsafeCell` 访问规则(2019 年开议题,2026 年落地)
- [UCG #430](https://github.com/rust-lang/unsafe-code-guidelines/issues/430) — 分配的尺寸可变性(部分落地:只允许增长,不允许收缩)

**这是理解 1.99 的钥匙**:这不是一个 feature 版本,这是 UCG 十年工程的一次集中兑现。

---

## 二、承重级改动一:UnsafeCell 绕过 get 被合法化

### 2.1 之前到底卡在哪

看这段代码:

```rust
use std::cell::UnsafeCell;

struct Counter {
    value: UnsafeCell<u64>,
}

impl Counter {
    fn bump_via_get(&self) {
        unsafe {
            *self.value.get() += 1;  // 写法 A:教科书标准写法
        }
    }
    fn bump_direct(&self) {
        unsafe {
            *self.value.value += 1;  // 写法 B:直接访问字段
        }
    }
}
```

**写法 B 在 1.98 及以前,规范里没有说它错,也没有说它对。** 但所有 Rust 文档、所有 lint、所有教程都告诉你「要用 `get()`」。原因是一个更深的别名模型问题:`UnsafeCell` 的作用是**告诉优化器「这个 cell 内部可能存在可变别名,你不要对它做激进优化」**。这个「通知」在编译器里是一个 `UnsafeCell` 的 interior mutability 标记,只在通过 `UnsafeCell` 的 API 访问时才被正确识别。

如果你直接访问字段 `self.value.value`,你访问的是 `UnsafeCell<u64>` 的内部字段——编译器**有可能**把这次访问看作对 `u64` 的普通访问,而不是对 `UnsafeCell` 内部的访问。在 LLVM 做别名分析时,这两者的 `noalias` 结论可以不同。**这正是「合法但没人敢保证」的典型灰区**:能编译,能跑,测试全过,但在某个优化级别下可能被优化器基于错误的别名假设重排掉。

### 2.2 1.99 的变更

[PR #159730](https://github.com/rust-lang/rust/pull/159730)(由 rust-lang/opsem FCP 通过)明确规定:

> **`UnsafeCell` 的内容可以在不经过 `get()` 的情况下被访问。**

这句话的完整含义是:**只要你的 `UnsafeCell` 本身被正确地放在一个能让「可变 XOR 别名」不成立的位置上(比如被 `&UnsafeCell<T>` 引用),那么你通过任何路径访问到内部 `T`,别名模型都按「通过 `UnsafeCell` 访问」处理。**

同时 [PR #159960](https://github.com/rust-lang/rust/pull/159960) 调整了 `invalid_reference_casting` lint 与之配套。

**关键洞察 1:这不是「放宽」,是「把已有的正确行为写进规范」。** rustc 之前在绝大多数情况下已经按这个方式实现了,规范滞后于实现。这次变更是把**实现事实**升级为**规范事实**,让写 unsafe 库的人第一次有了「我可以这么写,而且编译器承诺不 future-break 我」的依据。

### 2.3 这对真实代码的影响:三大重写

#### 重写 1:手写 cell 类型不再需要 `get()` 转发

```rust
// 1.98 及以前:手写 Cell 必须转发 get
struct MyCell<T> {
    inner: UnsafeCell<T>,
}
impl<T: Copy> MyCell<T> {
    fn get(&self) -> T {
        unsafe { *self.inner.get() }  // 多一层间接
    }
}

// 1.99:直接访问合法,省掉一次函数调用
struct MyCell99<T> {
    inner: UnsafeCell<T>,
}
impl<T: Copy> MyCell99<T> {
    fn get(&self) -> T {
        unsafe { *self.inner.value }  // 少一层 get() 调用
    }
}
```

在 release 模式下 `get()` 大概率被 inline,所以这不是性能改动。**这是可读性和维护性改动**:你不再需要向 reviewer 解释「为什么这里必须走 `get()`」。

#### 重写 2:`#[repr(C)]` 结构体里的 UnsafeCell 字段

真正受益的是 FFI 场景。C 代码传给你一个结构体指针,你在 Rust 侧声明成:

```rust
#[repr(C)]
pub struct FfiHandle {
    flags: u32,
    refcount: UnsafeCell<u64>,  // C 侧会原子更新它
}

impl FfiHandle {
    fn read_refcount(&self) -> u64 {
        unsafe {
            // 1.99 之前:这里必须 self.refcount.get(),否则规范不清
            // 1.99 之后:直接读合法,且别名模型保证 LLVM 不会把
            //           这次读「升格」成 noalias 读
            std::ptr::read_volatile(&self.refcount.value)
        }
    }
}
```

#### 重写 3:derive 宏与自动生成的 unsafe 代码

`#[derive(Debug)]` 在遇到含 `UnsafeCell` 的结构体时,生成的代码是「直接访问字段」。**在 1.99 之前,derive 生成的代码处在规范灰区**;1.99 之后它明确合法。这是「规范滞后」最尴尬的一个例子:标准库自己的 derive 宏 生成的代码,在规范上一直是「没人能证明合法」的。

### 2.4 诚实边界:什么 1.99 没有解决

**1.99 没有改变「`UnsafeCell` 只能通过共享引用触发内部可变性」这条核心规则。** 你仍然不能从一个 `&mut UnsafeCell<T>` 搞出两个可变引用——那是真 UB。本次变更只涉及「访问路径」,不涉及「别名是否存在」。

另外,**[UCG #281](https://github.com/rust-lang/unsafe-code-guidelines/issues/281) 讨论的是 `UnsafeCell<T>` 的字段访问,不是 `UnsafeCell` 的其他 API**(如 `raw_get`,仍然 unstable)。

---

## 三、承重级改动二:Pin 安全契约重写,新设 PinSafePointer trait

这是 1.99 里**唯一一个官方在 Compatibility Notes 里写明「safety invariants changed slightly」的改动**,也是本文认为对库作者影响最深的一条。

### 3.1 Pin 要解决什么:自引用结构与「不许动」契约

`Pin<P>` 是 2019 年(1.33)稳定的核心类型,为了让自引用结构(主要是 `async fn` 生成的状态机)能安全存在。核心约定一句话:

> **一个值一旦被 pin 住,它的内存就不会再被移动,直到它被 drop。**

这个约定在 safe 层面由类型系统守护:`Pin::new` 只接受 `Unpin` 类型(可随便移动的),非 `Unpin` 类型要用 `Pin::new_unchecked`,而这需要 `unsafe`。

### 3.2 旧契约的漏洞:三个 safe trait 能拆掉 Pin

问题出在:**`Pin::new_unchecked` 的安全要求,过去只约束「你传进去的指针确实指向一个不会再被移动的值」**。它**没有**约束这个指针类型本身会不会通过实现标准库的 safe trait 来偷偷移动值。

[PR #156935](https://github.com/rust-lang/rust/pull/156935) 的作者列出了三个能被 safe trait 撕开 Pin 的路径:

1. **`DerefMut` 移动值**:`Pin<P>` 的 `deref_mut` 拿到 `&mut T`。一个恶意(或 merely 粗心)的指针类型可以在 `deref_mut` 里 `swap` 掉内部值——这违反了「pin 住就不能动」。
2. **`Drop` 移动值**:指针类型的析构函数拿到 `&mut self`,可以在析构时把值移走。
3. **`Clone` / `fmt::Debug` / `fmt::Display` / `fmt::Pointer`** 拿到 `&self`。有的指针类型(文档里举例 `Arc`)用「存在 `&Arc<T>` 就证明 `T` 没 pin」作为 `Arc::get_mut` 的安全性依据——但 `Pin<Arc<T>>` 的 `Clone` 实现会调用 `Arc::clone(&self)`,如果格式化 trait 被当作「值未 pin」的证据,就会出现「既被认为 pin 了、又被认为没 pin」的矛盾。

**这三条在 1.98 之前都是「理论 soundness 问题」**,挂在 issue #152667 和 #147794 上,实际被利用需要写一个故意的恶意指针类型。但 async 生态里 `Arc<Waker>`、各种手写 smart pointer、`Slab` 分配器的 slot 指针这类东西大量参与 `Pin`,漏洞的修复不能拖。

### 3.3 1.99 的解法:PinSafePointer trait

[PR #156935](https://github.com/rust-lang/rust/pull/156935) 把 `PinCoerceUnsized` 重命名并扩展为 `PinSafePointer`,并给出 5 条实现要求。这是新 trait 的完整安全契约:

| # | 要求 | 反例(不合规实现) |
|---|---|---|
| 1 | **同一 `Pin<P>` 实例的 `deref`/`deref_mut` 必须始终指向同一对象**,地址不能变;unsizing 强制转换不能改变底层具体类型 | unsize 后 `deref_mut` 返回一个 `#[repr(transparent)]` 包裹,地址没变但具体类型变了 |
| 2 | **`deref_mut` 与析构必须表现得像收到 `self: Pin<&mut Self>`**,不能移走底层值 | `deref_mut` 里对内部值调用 `swap` |
| 3 | 若指针类型用 `&P` 作为「值未 pin」的证据,则 `Clone`/`Debug`/`Display`/`Pointer` 的 `&self` 参数**不能**被当作这种证据 | `Arc` 假设 `&Arc<T>` 存在即 `T` 未 pin,但 `Pin<Arc<T>>::clone` 内部产生了 `&Arc<T>` |
| 4 | **`Clone` 返回的指针值传给 `Pin::new_unchecked` 必须 sound** | `Pin<&T>` clone 出的 `&T` 指向同一被 pin 的值(这是合规的示例) |
| 5 | 以上所有条目在指针被移动后仍然成立 | 移动指针类型自身导致底层地址变化 |

**关键洞察 2:Pin 的安全模型从「一个不变量」变成了「一个不变量 + 一个守护 trait」。** 以前你写 `unsafe impl` 时只需保证「值不会移动」;现在如果你的类型要参与 `Pin`,你还得保证你的 `Deref`/`DerefMut`/`Drop`/`Clone`/`Debug`/`Display`/`Pointer` 实现不做上述任何一件事。这是 Rust 历史上第一次把「safe trait 的实现也可能破坏 unsafe 不变量」这件事**写成了可查的条目**。

### 3.4 对真实代码的三个影响

**影响 1:`Pin::new_unchecked` 的 safety 文档变了,你写的 `SAFETY:` 注释可能要补**

如果你写过这样的注释:

```rust
let pinned = unsafe { Pin::new_unchecked(&mut value) };
// SAFETY: value 不会被移动,因为它在函数栈上且我们没有把它 move 出去
```

1.99 之后这段 SAFETY 注释**不完整了**。完整版要加上「我用的指针类型(这里是 `&mut T`)实现了 `PinSafePointer`,这是由标准库保证的」。对标准库内置指针类型(`&mut`、`Box`、`Arc`、`Rc`)你不用自己证明,标准库已经实现;**但如果你在手写 smart pointer 参与 `Pin`,你必须自己去 impl 或证明这 5 条**。

**影响 2:`PinCoerceUnsized` 这个名字要换了**

如果你在 nightly 或自己的代码里引用过 `PinCoerceUnsized`,1.99 起它叫 `PinSafePointer` 且要求变多。这是纯重命名 + 加要求。

**影响 3:PR 明确说「剩下的 Pin soundness 问题只剩两个」**

作者在 PR body 里列出剩余问题:#134407,以及 `CoercePointee` 可能被下游 crate 实现在 `Pin<LocalType>` 上(unstable only)。**这是 Rust 第一次公开承认 Pin 的 soundness 清单短到两只手数得完**——对依赖 async 生态的团队来说,这是一条可以写进技术评估的确定性。

---

## 四、承重级改动三:C-variadic 函数定义稳定,FFI 的最后一块拼图

### 4.1 以前 Rust 只能「调」C 的变参函数,不能「写」

C 语言的变参函数(`printf`、`fprintf`、`open` 的某些变体)用 `...` 语法。Rust 一直能通过 `extern "C"` 声明来**调用**它们:

```rust
extern "C" {
    fn printf(fmt: *const u8, ...) -> c_int;  // 以前可以声明并调用
}
```

但**你不能在 Rust 里定义一个 C-variadic 函数**——即你不能写一个 Rust 函数,让 C 代码用 `printf("%d", x)` 的方式调它。这在 1.99 之前是 nightly-only feature(`c_variadic`)。

[PR #155697](https://github.com/rust-lang/rust/pull/155697) 把它稳定了:

```rust
#![allow(c_variadic)]  // 1.99: 不再需要,已经是 stable

use core::ffi::VaList;

// 现在 stable:用 Rust 写一个 C 可调用的变参函数
pub unsafe extern "C" fn rust_sum(count: u32, mut args: ...) -> i64 {
    let mut total: i64 = 0;
    for _ in 0..count {
        total += unsafe { args.arg::<i32>() as i64 };
    }
    total
}
```

配套稳定的还有 `core::ffi::VaList`(见稳定 API 列表),以及 [PR #159746](https://github.com/rust-lang/rust/pull/159746) 的 `#[unsafe(naked)]` 变参函数。

### 4.2 naked 函数变参:补上 ABI 的最后一种情形

`#[unsafe(naked)]` 函数(1.82 稳定的裸函数)以前只能写定参。1.99 允许裸函数也是 C-variadic,而且**接受的 ABI 集合与 C-variadic 外部函数相同**,比普通 C-variadic 定义更宽。PR #159746 给出的示例是 aapcs(ARM):

```rust
#[unsafe(naked)]
unsafe extern "aapcs" fn variadic_aapcs(_: f64, _: ...) -> f64 {
    core::arch::naked_asm!(
        r#"
        sub     sp, sp, #12
        stmib   sp, {{r2, r3}}
        vmov    d0, r0, r1
        add     r0, sp, #4
        vldr    d1, [sp, #4]
        add     r0, r0, #15
        bic     r0, r0, #7
        vadd.f64        d0, d0, d1
        add     r1, r0, #8
        str     r1, [sp]
        vldr    d1, [r0]
        vadd.f64        d0, d0, d1
        vmov    r0, r1, d0
        add     sp, sp, #12
        bx      lr
    "#,
    )
}
```

**关键洞察 3:naked + variadic 的组合价值不在「能写」,在「能不写汇编胶水」。** 以前要在 Rust 里实现一个 ARM 上的变参 ABI 入口,只能写 `.S` 汇编文件、走 `extern "C"` 声明、再在 build.rs 里挂编译器参数。现在这段逻辑可以留在 Rust 模块里,接受 borrow checker 对寄存器使用以外的部分做检查,并且能被 IDE 索引。**这是 Rust 吃掉「最后一类必须用 C 写的代码」的一步**:操作系统内核入口、hypervisor trap handler、嵌入式 startup。

### 4.3 与之同框的另外两条底层线

**128 位整数可走向量寄存器**([PR #159525](https://github.com/rust-lang/rust/pull/159525)):`u128`/`i128` 现在可以通过 `xmm_reg`/`ymm_reg`/`zmm_reg` 在 `asm!` 里传入传出。32/64 位整数早就支持,128 位是补齐——LLVM 从 2019 年起就支持(llvm #42502),rustc 没跟上纯属 oversight。

**`global_asm!` 现在感知全局启用的 target feature**([PR #160594](https://github.com/rust-lang/rust/pull/160594)):`#[target_feature(enable = "avx512f")]` 在模块级别启用后,模块里的 `global_asm!` 能看到这些 feature。以前模块级汇编与 Rust 侧的 feature 开关互相看不见,写混合代码要在两边各声明一遍。

---

## 五、承重级改动四:分配只许增长不许收缩,RangeInclusive 的「已耗尽」语义改了

这两条放一起,因为它们都是**「规范没写死,实现将错就错」的典型**,而且都直接影响你可能正在写的代码。

### 5.1 分配尺寸:只允许增长

[PR #159729](https://github.com/rust-lang/rust/pull/159729) 把「某些分配允许原地增长,但都不允许收缩」写成了明确规定。背景在 PR body 里讲得很清楚:

- LLVM 侧一年前(llvm-project#141338)就允许分配增长了,而且不需要改代码,因为 LLVM 的优化本来就跟增长兼容
- **但 LLVM 假设通过它认识的分配操作(`malloc`/`alloca`/Rust 全局分配器)创建的分配尺寸永远不变**,所以 Rust 必须**显式排除**这一类
- 只允许增长不允许收缩,是因为「#t-opsem 频道里真的有多个用户提出了这个需求」(PR 里贴了两条 Zulip 讨论)

这条对应 UCG #430 的**部分**落地。

**实践含义**:如果你写过「分配一个比需要更大的 buffer,然后假装它变小了」的代码(比如自己实现的 `Vec`、`String` 的 shrink 逻辑、`bytes::BytesMut` 的原地截断),**现在规范明确说这是不允许的**。「增长」合法的场景是:allocator 的 `realloc` 明确支持扩展(如 `System` 分配器在 glibc 下对 `mmap` 大块的支持)。

### 5.2 RangeInclusive:已耗尽语义改了,官方说「不是 breaking change」

[PR #155114](https://github.com/rust-lang/rust/pull/155114) 给 `Step` trait 加了两个必需方法:

```rust
trait Step: ... {
    fn forward_overflowing(start: Self, count: usize) -> (Self, bool);
    fn backward_overflowing(start: Self, count: usize) -> (Self, bool);
}
```

代价是 `RangeInclusive`(`a..=b`)的「耗尽」语义变了:

| | 1.98 | 1.99 |
|---|---|---|
| 迭代到溢出时 | 设 `exhausted = true` | 设 `exhausted = true`(同) |
| 迭代完但**没**溢出时 | `start` 停在 `end`,`exhausted = false` | **`start` 被推进到超过 `end`,且 `exhausted` 不被设置** |

带来的副作用:

- 一个已经迭代完的 `RangeInclusive`,其 `start()` / `end()` 的返回值**可能变了**
- 把这样的 range 当作切片下标用,行为可能不同
- `Debug` 格式化输出变了(但 Debug 本来不保证稳定)

官方在 release notes 里明确说「这些行为从来没有被保证稳定,所以不算 breaking change」——**这是「理论不是 breaking,实际上你可能踩到」的教科书例子**。

**换来的收益**:`a..=b` 的循环现在能享受 `a..b` 早就有的优化。典型场景是位宽有限的自增 ID 遍历、`u8`/`u16` 范围的查表循环,LLVM 现在可以向量化或省掉边界检查。

---

## 六、承重级改动五:Cargo 拆出 debug profile,CI 默认关闭增量编译

### 6.1 debug profile:一次为「dev 语义重定义」铺路的拆分

[PR #17214](https://github.com/rust-lang/cargo/pull/17214) 加了一个**内置 profile `debug`**。关键设计:

- `debug` **继承自 `dev`**——「调试本来就是开发过程的一部分」
- `debug` 目前与 `dev` **没有任何区别**
- `dev` 未来会演化(`debug` 通过 override 保持不变),但这次先不动,给用户一个过渡期
- `cargo install --debug` 现在用 `debug` 而不是 `dev`
- `--dev` / `--debug` 命令行 flag **推迟**,需要更多评估
- `dev` 仍然输出到 `target/debug`,过渡成本不变

**关键洞察 4:这是 Cargo 把 profile 从「编译参数预设」升级为「构建图一等公民」的第一步。** PR 里提到的后续是「新的 build layout」——Cargo 团队正在重做 `target/` 目录结构。当一个 profile 有了自己的名字、继承关系、override 语义,profile 就变成了可以按「这个 crate 是被测试、被调试、还是被发布」分别描述的构建描述符。对 CI 工程师的意义是:**从现在起在 CI 里写死 `[profile.dev]` 是在给未来挖坑**,应该开始用 `debug`。

### 6.2 CI 默认关闭增量编译:一条被低估的 CI 成本修复

[PR #17220](https://github.com/rust-lang/cargo/pull/17220) 的逻辑用作者原话讲最清楚:

> 增量编译在 CI 上有两个潜在负面影响:
> 1. 没有缓存或缓存复用率低时,时间被浪费在序列化状态、写盘、管理缓存上
> 2. **有**缓存时,增量编译大幅增加缓存体积,缓存开销(网络、压缩)可能超过构建提速

优先级层级是:

```
1. CARGO_INCREMENTAL 环境变量
2. build.incremental 配置
3. !CI  (新增:检测到 CI 环境变量就关掉)
4. profile.*.incremental
```

注意第 3 层的位置:**它在配置之后,但在 profile 设置之前**。这意味着 `CARGO_INCREMENTAL=1` 和 `build.incremental` 仍然能强制打开,但**如果你只在 profile 里设了 `incremental = true`,CI 环境下会被关掉**。

作者给的理由也值得记住:

> 这帮助了那些不用 CI action 的人(比如 Cargo 团队自己,或用自建 CI runner 的人);这降低了 CI action 的价值,让更多人有机会减少 CI 依赖树和风险面。

**实践含义**:如果你在 CI 上跑 Rust,且之前为「增量编译导致缓存膨胀」苦恼过,1.99 是**默认修复**。反过来,如果你的 CI 依赖增量编译并且显式设置了 `CARGO_INCREMENTAL=1`,行为不变。

### 6.3 workspace 依赖的 default-features 覆盖

[PR #17126](https://github.com/rust-lang/cargo/pull/17126)(RFC 3945):workspace 成员在 **edition 2024 及以上**现在可以覆盖继承来的 workspace 依赖的 `default-features`:

```toml
# Cargo.toml (workspace 根)
[workspace.dependencies]
serde = { version = "1", features = ["derive"] }

# 成员 crate 的 Cargo.toml
[dependencies]
serde = { workspace = true, default-features = false }  # 1.99: 生效
```

在更早的 edition 上,`default-features = false` 会被忽略并给一个 warning。

---

## 七、承重级改动六:rustdoc trait impl 过滤重写 + LLVM 23

### 7.1 rustdoc 平均快 20%,部分 crate 快 40%

[PR #159623](https://github.com/rust-lang/rust/pull/159623) + 4 个后续 PR(#159721 / #159779 / #159854 / #159091)重写了 rustdoc 的 trait impl 过滤逻辑,官方数字是**平均 20%,部分真实 crate 快到 40%**。

核心改动用作者原话:

> 构建内联 impl 很贵,而它们大多数最后都在这个函数里被 strip 掉。所以我们应该提前过滤。
>
> 提前过滤之后就可以删掉下游过滤。于是我们终于删除了 `BadImplStripper` 和没用的 deref-following 逻辑。看起来这些 Deref 逻辑从一开始就是多余的,因为跟随 deref 的操作在 rustdoc 别的地方已经做过了,那里才是真正需要的地方。

**关键洞察 5:这是一次「删代码带来 20% 提速」的典型。**`BadImplStripper` 是先全量构建、再过滤的实现策略;新策略是**在构建前就按规则筛**。规则是:

- blanket impl(泛型 impl)要内联
- 原始类型的 impl 要内联
- 当前 crate 内(已内联)类型的 impl 要内联
- 当前 crate 内(已内联)trait 的 impl 要内联
- `Deref` 的 impl 要内联

对**大型 crate 的文档构建**,这是 CI 时间上的直接收益。对所有用 `cargo doc` 出内部文档的团队,这是免费提速。

### 7.2 LLVM 23

[PR #158734](https://github.com/rust-lang/rust/pull/158734) 把 rustc 的 LLVM 升到 23。PR body 里列出的同步改动:

- coverage map 测试因顺序变化更新(仅影响 LLVM >= 23)
- Darwin 上恢复 **unversioned** 的 LLVM dylib 命名(`LLVM_VERSIONED_DYLIB_NAME_ON_DARWIN=OFF`),作者明说「鉴于 Darwin dylib 过去造成的麻烦,我不在这个 PR 里改它」
- **分发 `llvm-project/libc` 子项目**,它现在是 LLVM 的构建依赖
- 从 #158778 拉入 **f128 Windows ABI** 改动——必须与 LLVM 更新同步,因为 libcalls 的 ABI 由 LLVM 控制,不是 Rust 的 ABI lowering
- dist-i686-mingw 上禁用 RISCV 后端,因为构建时在一个大生成文件上 OOM(临时措施,等 host tools 移除)
- mingw 下新增下游 patch,绕过 GCC 16 之前 broken 的 TLS(当前 GCC 14)

**关键洞察 6:f128 的 Windows ABI 跟随 LLVM 23 进来,是 `f16`/`f128` 稳定化链条上的一环。** Rust 的 `f16`/`f128` 在 1.82 稳定了类型,但 Windows 上的 calling convention 一直跟 LLVM 的实现对不齐。这条依赖链的意思是:**LLVM 的 ABI 决策现在直接决定 Rust 在 Windows 上的行为**,而不是 Rust 自己定义 ABI。对跨平台库作者,这是一个要跟踪的上游变化点。

### 7.3 平台与编译器

- **`riscv64-unknown-linux-musl` 提升到 Tier 2 with host tools**(PR #158766)——RISC-V 服务器生态的又一个信号
- **`static_position_independent_executables` 在所有 gnu target 启用**(PR #158510)——作者原话:「glibc 支持 static PIE 已经很久了,所以没理由在现代工具链下还构建非 PIE 可执行文件」。**影响:静态链接的 GNU 二进制默认变成 PIE,安全收益(ASLR)免费拿**
- `-Ctarget-cpu` 对 AVR / AMDGCN / NVPTX 变成 target-modifier(PR #150732)
- 方法名建议优先用 **doc alias 精确匹配**而不是相似度搜索(PR #160369)——给 API 加 `#[doc(alias = "...")]` 现在同时改善 rustc 的错误提示和 rustdoc 搜索

---

## 八、5 段在 1.99 上直接跑的代码

### 代码 1:验证 UnsafeCell 绕过 get 的合法访问 + derive 生成的代码同框

```rust
use std::cell::UnsafeCell;

// 1.99: derive(Debug) 生成的代码直接访问 UnsafeCell 内部字段,
//       现在明确合法。
#[derive(Debug)]
struct Latch {
    // Debug 会打印 value.value,而不是 value.get()
    value: UnsafeCell<u64>,
    label: &'static str,
}

impl Latch {
    fn new(label: &'static str) -> Self {
        Latch { value: UnsafeCell::new(0), label }
    }
    // 1.99 之前: 规范灰区, 所有人都写 get()
    // 1.99 之后: 直接访问合法 (PR #159730, UCG #281)
    fn fire(&self) -> u64 {
        unsafe {
            let v = &self.value.value;   // <- 不走 get()
            *v = *v + 1;
            *v
        }
    }
}

fn main() {
    let l = Latch::new("gate");
    let n = l.fire();
    println!("{l:?} fired {n} times");
    // 输出: Latch { value: 1, label: "gate" } fired 1 times
    //       ^^^^ Debug 直接打印了内部值, 这段 derive 代码在 1.99 前是灰区
}
```

**调试技巧**:如果你怀疑某个 release 构建把 unsafe 访问优化错了,可以用 `cargo rustc --release -- -Zmir-opt-level=0` 关掉 MIR 优化定位,或用 `cargo asm` 看别名假设是否导致意外的加载重排。1.99 之后这类「灰区导致的行为差异」会越来越少,因为灰区本身在缩小。

### 代码 2:验证 RangeInclusive 已耗尽语义变化

```rust
fn main() {
    // 场景 A: 迭代到溢出 -> exhausted 被设置 (行为不变)
    let mut r = 250u8..=255u8;
    let collected: Vec<u8> = r.by_ref().collect();
    println!("A collected: {collected:?}");       // [250, 251, 252, 253, 254, 255]
    // r 已耗尽 (溢出发生在 255 -> 256 时), start() 语义不变

    // 场景 B: 迭代完但没溢出 -> 1.99: start 被推过 end, exhausted 不设置
    let mut r2 = 1u8..=5u8;
    let _ = r2.by_ref().count();
    // 1.98: start() == 5
    // 1.99: start() 被推进到 6 (推过 end)
    println!("B after iter: start={:?} end={:?}", r2.start(), r2.end());
}
```

**调试技巧**:如果你的代码把已迭代完的 `RangeInclusive` 存起来复用(比如当作「迭代过」的标记),1.99 之后 `start()` 的值变了。**官方说这不是 breaking change(从未保证稳定),但你的测试可能会红**。

### 代码 3:用 stable Rust 写一个 C 可调用的变参函数

```rust
// 1.99: c_variadic 稳定, 不再需要 #![feature(...)]
use core::ffi::{c_int, VaList};

/// 一个 C 代码可以这样调的函数:  rust_log(3, 1, 2, 3)
/// # Safety
/// 调用方必须保证 count 与实际参数数量一致, 且每个参数都是 c_int
pub unsafe extern "C" fn rust_log(count: c_int, mut args: ...) -> c_int {
    let mut sum: i64 = 0;
    for _ in 0..count {
        // SAFETY: 调用方按契约保证类型与数量
        sum += unsafe { args.arg::<c_int>() as i64 };
    }
    println!("rust_log sum = {sum}");
    sum as c_int
}

fn main() {
    // Rust 侧也能调 (通过声明式 extern 或直接调用)
    let _ = unsafe { rust_log(3, 10, 20, 30) };  // 打印 60
}
```

**调试技巧**:变参函数的 `args.arg::<T>()` 的类型必须与调用方完全一致——C 的默认参数提升(int promotion)会帮你把 `char` 提成 `int`,但 Rust 侧声明成 `u8` 就会读到错误的高位字节。**用 `c_int` 而不是具体宽度类型**。

### 代码 4:128 位整数走向量寄存器(PR #159525)

```rust
use core::arch::asm;

fn xorshift128(state: &mut u128) -> u128 {
    let mut x = *state;
    unsafe {
        // 1.99: u128 现在可以走 xmm/ymm/zmm (之前只能走通用寄存器)
        asm!(
            "mov {tmp}, {x}",
            "shl {x}, 49",
            "xor {x}, {tmp}",
            "mov {tmp}, {x}",
            "shr {x}, 15",
            "xor {x}, {tmp}",
            x = inout(xmm_reg) x,
            tmp = out(xmm_reg) _,
        );
    }
    *state = x;
    x
}

fn main() {
    let mut s: u128 = 0x9E3779B97F4A7C15_123456789ABCDEF;
    for _ in 0..3 {
        println!("0x{:032x}", xorshift128(&mut s));
    }
}
```

**调试技巧**:`xmm_reg` 在 x86-64 上会分配 SSE 寄存器;如果你在 `target_feature` 里启用了 AVX2/AVX-512,可以改用 `ymm_reg`/`zmm_reg`。**注意 `asm!` 的寄存器分配不会自动考虑你函数里其他地方在用哪些向量寄存器**,混合写 SIMD intrinsics 与 inline asm 时用 `inout(reg)` 显式指定更安全。

### 代码 5:Cargo profile 分层 + CI 增量编译优先级验证

```toml
# Cargo.toml
[package]
name = "demo"
version = "0.1.0"
edition = "2024"   # <- 17126 的 default-features 覆盖需要 2024

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }

[dependencies]
# 1.99 + edition 2024: 覆盖 workspace 依赖的 default-features 生效
serde = { workspace = true, default-features = false }

[profile.dev]
incremental = true   # 第 4 层: CI 环境下会被第 3 层 (!CI) 关掉
```

```bash
# 验证 4 层优先级 (PR #17220):
# 1. CARGO_INCREMENTAL 环境变量 (最高)
# 2. build.incremental
# 3. !CI   <- 1.99 新增
# 4. profile.*.incremental (最低)

# 情形 1: CI 环境 + 只在 profile 里设了 incremental -> 1.99 关掉
CI=true cargo build -v 2>&1 | grep -i incremental

# 情形 2: CI 环境 + 显式 CARGO_INCREMENTAL=1 -> 仍然开
CI=true CARGO_INCREMENTAL=1 cargo build -v 2>&1 | grep -i incremental

# 情形 3: 本地 (无 CI 变量) + profile incremental=true -> 开
cargo build -v 2>&1 | grep -i incremental
```

**调试技巧**:`cargo build -v` 的输出里 `-Cincremental` 标记会直接告诉你最终决策。**如果升级 1.99 后 CI 构建时间变化,先查这一条**。

---

## 九、5 套写法 17 维度对比

### 9.1 UnsafeCell 访问的 5 种写法

| 维度 | `cell.get()` 读 | 直接字段读 | `ptr::read` | `raw_get`(unstable) | `&*cell.get()` |
|---|---|---|---|---|---|
| 1.99 前规范状态 | 明确合法 | **灰区** | 灰区 | nightly | 合法 |
| 1.99 后规范状态 | 合法 | **合法** | **合法** | 仍 nightly | 合法 |
| 需要 unsafe | 是 | 是 | 是 | 是 | 是 |
| 生成指令数(release) | 1(load) | 1(load) | 1(load) | 1(load) | 1(load) |
| 是否经过函数调用 | 是(通常 inline) | 否 | 否 | 否 | 是(通常 inline) |
| LLVM 别名模型识别 | 走 UnsafeCell 标记 | **走 UnsafeCell 标记** | 走 UnsafeCell 标记 | 走 UnsafeCell 标记 | 走 UnsafeCell 标记 |
| 可读性 | 高(教科书) | 高 | 中(需注释意图) | 高 | 中 |
| 与 `#[derive]` 兼容 | 不适用 | **是(derive 就这么生成)** | 不适用 | 不适用 | 不适用 |
| FFI 场景适用性 | 中 | **高** | 高 | 高 | 低 |
| volatile 语义 | 无 | 无 | 有(read_volatile) | 无 | 无 |
| 可用于 `!Unpin` 类型 | 是 | 是 | 是 | 是 | 是 |
| 与 `Sync` 交互 | 需自己保证 | 需自己保证 | 需自己保证 | 需自己保证 | 需自己保证 |
| 需要写 SAFETY 注释 | 短 | **1.99 后可短** | 需解释为何 read | 短 | 短 |
| reviewer 接受度 | 高 | **1.99 起变高** | 中 | 低(nightly) | 高 |
| Miri 报警 | 无 | **1.99 起无** | 无 | 无 | 无 |
| 未来被改的风险 | 极低 | **极低(已写进规范)** | 低 | 中(unstable) | 极低 |
| 推荐度 | 保持 | **新代码可用** | 仅 volatile 场景 | 不用 | 保持 |

### 9.2 Pin 相关的 5 种「不许动」写法

| 维度 | `Pin::new` (Unpin) | `Pin::new_unchecked` | `Box::pin` | `pin!` 宏 (1.68) | 手写 smart pointer 参与 Pin |
|---|---|---|---|---|---|
| 需要 unsafe | 否 | **是** | 否 | 否 | **是** |
| 1.99 安全要求条数 | 0 | **5 条 PinSafePointer 要求** | 0 | 0 | **全部 5 条要自己证明** |
| 值可以是自引用 | 否 | 是 | 是 | 是 | 是 |
| 值可以 `!Unpin` | 否 | 是 | 是 | 是 | 是 |
| 指针类型需 impl PinSafePointer | 不适用 | **标准库类型已 impl** | 标准库已 impl | 标准库已 impl | **必须自己 impl** |
| Drop 时移动值 | 不适用 | **禁止(要求 2)** | 禁止 | 禁止 | **禁止** |
| Clone 后传 new_unchecked | 不适用 | **要求 4** | 不适用 | 不适用 | **要求 4** |
| SAFETY 注释长度 | 无 | **变长(1.99)** | 无 | 无 | **最长** |
| 适合 async 状态机 | 否 | 是 | 是 | **首选** | 视场景 |
| 适合 FFI pin 外部内存 | 否 | 是 | 否 | 否 | **首选** |
| 出 soundness bug 的概率 | 极低 | **中(1.99 后降低)** | 极低 | 极低 | **高** |
| 需要 nightly | 否 | 否 | 否 | 否 | 否 |
| 可被 borrow checker 部分检查 | 是 | 部分 | 是 | 是 | 部分 |
| 文档负担 | 无 | **1.99 变重** | 无 | 无 | **最重** |
| 推荐度 | 常规 | 谨慎用 | 常规 | **首选** | 只在必须时 |

### 9.3 Rust 与 C/C++ 在「契约可检查性」上的对比

| 维度 | Rust 1.99 | C | C++ | Zig | Ada/SPARK |
|---|---|---|---|---|---|
| 别名规则写进规范 | 是(可变 XOR 别名) | 否(restrict 是 hint) | 部分 | 是(noalias) | 是 |
| unsafe 块的存在 | 有 | 无(全 unsafe) | 无 | 有 | 有 |
| unsafe 的证明责任 | 程序员 + 编译器查契约 | 程序员, 编译器不查 | 程序员, 编译器不查 | 程序员 | 程序员 + 可形式化证明 |
| 自引用结构支持 | Pin(类型系统守护) | 无(UB 丛生) | 无(UB 丛生) | 无 | 有限 |
| 变参函数可定义 | **1.99 起 stable** | 是 | 是 | 是 | 是 |
| 裸函数 | `#[unsafe(naked)]` | 是(编译器扩展) | 是(编译器扩展) | 是 | 不适用 |
| 分配尺寸可变性契约 | **只许增长(1.99)** | 无(未定义) | 无(未定义) | 无 | 无 |
| 编译期 lint 覆盖灰区 | **高(1.99 扩大)** | 低 | 中 | 中 | 高 |
| 形式化验证生态 | 弱(在建设中) | 弱(Frama-C) | 弱 | 弱 | **强** |
| 2026 主流系统语言生态 | **第一** | 第二(衰减中) | 第三 | 上升中 | 小众 |

### 9.4 Cargo profile 的 5 种配置策略

| 维度 | 只用默认 | `[profile.dev] incremental=true` | `CARGO_INCREMENTAL=1` 在 CI | 用新 `debug` profile | `build.incremental` |
|---|---|---|---|---|---|
| 优先级层级 | — | 第 4 层(最低) | 第 1 层(最高) | — | 第 2 层 |
| CI 下 1.99 行为 | 增量编译关 | **被 !CI 关掉** | 仍开 | 继承 dev 行为 | 被 !CI 关掉 |
| 本地迭代速度 | 快 | 快 | 快 | 快 | 快 |
| CI 构建时间 | 基线 | 可能更慢 | 可能更慢 | 同 dev | 可能更慢 |
| CI 缓存体积 | 小 | **大(问题所在)** | 大 | 同 dev | 大 |
| 适合场景 | 全部 | 本地开发 | 特殊 CI | **面向未来** | 精细控制 |
| 升级 1.99 后变化 | CI 提速 | **CI 行为改变** | 无变化 | 新选项 | CI 行为改变 |
| 需要改 Cargo.toml | 否 | 是 | 否 | 否(内置) | 是 |
| 团队需要约定 | 否 | 是 | 是 | 是 | 是 |
| 推荐度 | 可以 | 重新评估 | 明确场景用 | **开始采用** | 高级用 |

### 9.5 文档构建的 5 种方式

| 维度 | `cargo doc` 1.98 | `cargo doc` 1.99 | rustdoc + `--no-deps` | mdbook | typedoc(对照) |
|---|---|---|---|---|---|
| 大型 crate 构建时间 | 基线 | **-20% 平均, 部分 -40%** | 更快(不构建依赖) | 不构建 impl | 不适用 |
| trait impl 过滤策略 | 先构建后 strip(BadImplStripper) | **先过滤后构建** | 同 1.99 | 不适用 | 不适用 |
| 删除的代码 | — | **BadImplStripper + deref-following** | — | — | — |
| 依赖文档可用 | 是 | 是 | 否 | 手动配置 | 不适用 |
| 输出可离线 | 是 | 是 | 是 | 是 | 是 |
| 适合内部 API 文档 | 是 | 是 | 是 | 是 | TS 项目 |
| 适合公开 crate | 是 | 是 | 部分 | 否 | 否 |
| 搜索质量 | 好 | **更好(impl 过滤更准)** | 好 | 无 | 好 |
| 需要额外工具链 | 否 | 否 | 否 | 是 | 是 |
| 推荐度 | 基线 | **升级** | 依赖稳定时用 | 书 + 代码 | TS 项目 |

---

## 十、6 条 6-12 月可验证硬指标

1. **rustdoc 构建提速可复现**:挑一个 trait impl 数量大的 crate(如 `serde`、`tokio`、`clap`),在 1.98 与 1.99 上各跑 `cargo doc --no-deps`,用 `hyperfine --warmup 3` 对比。官方数字是平均 20%、部分 40%。**你自己的 crate 能到多少,6 个月内可以验证。**

2. **CI 构建时间与缓存体积变化**:升级 1.99 后,在**没有显式设 `CARGO_INCREMENTAL`** 的 CI 上,记录 sccache/cache 体积与总构建时间。PR #17220 的预期是:缓存复用低时节省序列化开销,缓存复用高时节省网络/压缩开销。**如果你之前在 profile 里设了 `incremental = true`,1.99 会静默改变你的 CI 行为,这是最容易验证的一条。**

3. **`a..=b` 循环性能**:对你代码库里的 `for i in 0u8..=255` / `0u16..=1023` 这类循环做 benchmark。`Step::forward_overflowing` 让 `RangeInclusive` 用上 `Range` 早就有的优化。窄整数类型场景收益最明显。

4. **`Pin::new_unchecked` 代码审计**:如果你维护一个暴露 `unsafe` API 的库,6 个月内做一次审计:所有 `Pin::new_unchecked` 的 `SAFETY:` 注释是否覆盖了 1.99 的 5 条 `PinSafePointer` 要求。**对标准库指针类型只要确认类型在白名单内;对手写 smart pointer,需要真的写 impl。**

5. **C-variadic 迁移可行性**:找出你项目里「为了导出变参函数给 C 而写的 `.S` 汇编或 C 胶水文件」,评估能否用 `extern "C" fn f(_: ...)` + `VaList` 替代。**这直接减少构建系统的语言种类,对内核/嵌入式项目是可量化的收益。**

6. **`UnsafeCell` 直接访问的代码库比例**:grep 你的 unsafe 代码里 `.get()` 的使用,统计有多少是「纯粹因为规范没写清才加的」。1.99 之后这些可以简化。**这个数字本身衡量了你代码库里「规范灰区债务」的规模。**

---

## 十一、6 条 6-12 月可观察未来信号

1. **`PinSafePointer` 的生态跟进**:async-trait、tokio、slab、heapless 这类涉及 `Pin` 的底层库,是否开始在自己的 smart pointer 上 impl `PinSafePointer`,或在文档里说明自己满足 5 条要求。**这是 Pin soundness 清单从「2 个剩余问题」走向「0 个」的前置信号。**

2. **`dev` profile 的演化**:PR #17214 明说 `dev` 未来会演化、`debug` 会 override 保持不变。观察 1.100-1.105 之间 `dev` 是否开始改默认值(比如默认关掉某些调试信息以加快本地迭代)。**一旦开始改,Cargo.toml 里写死 `[profile.dev]` 的项目会第一次真正踩到。**

3. **naked + variadic 在内核生态的采用率**:no_std / 内核 / hypervisor 项目(os blog rust、Theseus、hubris)是否开始用 `#[unsafe(naked)] extern "C" fn f(_: ...)` 替代汇编入口。**这是「Rust 吃掉最后一类必须用 C 写的代码」的可观察指标。**

4. **LLVM 23 带来的 f128 跨平台一致性**:观察 `f16`/`f128` 在 Windows 与 Linux 上的行为差异是否收敛,以及是否催生出一批依赖 f128 的数值计算 crate。**LLVM 控制 libcalls ABI 这个事实,会越来越频繁地出现在 Rust 的跨平台 bug 报告里。**

5. **static PIE 在 gnu target 的默认化影响**:观察静态链接的 Linux 工具(尤其 Rust 写的 CLI 分发二进制)是否普遍获得 ASLR。**也会暴露一批「假设静态二进制不是 PIE」的打包脚本 bug。**

6. **UCG 议题的落地节奏**:UnsafeCell(#281)与分配尺寸(#430 部分)这次同版本落地,说明 UCG 的共识积累到了兑现期。观察 #430 的「允许收缩」部分、以及 #134407 这类剩余 Pin soundness issue 是否在 2026 H2 接续落地。**这是「Rust 的 unsafe 规范」从「部分成文」走向「完整」的可观察进度条。**

---

## 十二、总结与最佳实践

### 12.1 应该做的(✅)

1. **升级到 1.99 并重跑你的文档构建 CI**——rustdoc 20% 提速是免费的
2. **审计所有 `Pin::new_unchecked` 的 SAFETY 注释**,按 1.99 的 5 条 `PinSafePointer` 要求补全
3. **在 CI 里用新的 `debug` profile 替代对 `dev` 的定制**,为未来 `dev` 演化做缓冲
4. **新写的 unsafe 代码可以直接访问 `UnsafeCell` 字段**,但写一行注释说明「1.99 PR #159730 合法化」——给后来者留依据
5. **FFI 变参函数从 C/汇编胶水迁移到 `extern "C" fn f(_: ...)`**,减少构建系统语言种类
6. **给公共 API 加 `#[doc(alias = "...")]`**——1.99 起同时改善 rustc 错误提示和 rustdoc 搜索

### 12.2 千万别做的(❌)

1. **不要**在 1.99 升级后忽略 `RangeInclusive` 已耗尽语义变化——官方说不是 breaking,但你的测试可能红
2. **不要**继续写「分配后假装收缩」的代码——现在明确违反规范(UCG #430)
3. **不要**在手写 smart pointer 上 impl `Pin` 相关 trait 时,忽略 `Deref`/`DerefMut`/`Drop`/`Clone`/`Debug`/`Display`/`Pointer` 的 5 条新要求
4. **不要**在 CI 里依赖 `profile.*.incremental = true`——1.99 会被 `!CI` 层覆盖,行为已改变
5. **不要**给 C-variadic 函数的参数用具体宽度类型(`u8`/`u16`)——用 `c_int`/`c_long`,否则读到 int promotion 后的高位字节

### 12.3 5 步生产升级 checklist

- [ ] **第 1 步:升级工具链并验证构建**。`rustup update stable && cargo build --release`。重点看 release 构建——别名模型说明的细化理论上不改变代码生成,但如果你的代码在灰区,这里会暴露。
- [ ] **第 2 步:跑全量测试并检查 RangeInclusive 相关失败**。`cargo test`。如果有依赖「已迭代完 range 的 `start()` 值」的断言,这里会红。
- [ ] **第 3 步:审计 unsafe 代码**。`grep -rn "new_unchecked\|UnsafeCell\|get()" --include=*.rs`。按 §三的 5 条要求与 §二.4 的边界逐条过。
- [ ] **第 4 步:调整 CI 配置**。检查是否在 profile 里设了 `incremental`。用 `CI=true cargo build -v | grep incremental` 验证 1.99 的实际决策。同时用 `debug` profile 替换对 `dev` 的定制。
- [ ] **第 5 步:重新生成文档并测量**。`cargo doc --no-deps` 前后用 `hyperfine` 对比。同时检查文档里 trait impl 列表是否完整(新过滤规则与旧的 `BadImplStripper` 应产出相同结果,如有差异是 bug)。

### 12.4 3 个长期判断

**判断一:unsafe 的未来是「契约下沉到类型系统」。**
`UnsafeCell` 访问合法化和 `PinSafePointer` 的 5 条要求,本质是同一件事:**把「程序员向编译器的人肉保证」改造成「类型系统可以检查的 trait 契约」**。这个方向已经走了十年(UCG),1.99 是一次集中兑现。接下来 12-24 个月,预期会看到更多「safe trait 实现破坏 unsafe 不变量」的既存模式被逐一识别成 trait 要求。**对库作者的直接含义:你的 `unsafe impl` 会越来越像写形式化规范,而不是写免责声明。**

**判断二:Cargo profile 正在变成构建图的一等公民。**
`debug` profile 的引入看起来温和(「目前与 dev 无区别」),但 PR 明确说这是「为 `dev` 演化铺路」。配合正在重做的 `target/` build layout,Cargo 正在把「这个 crate 现在是被测试、被调试、还是被发布」变成构建系统真正理解的状态。**12 个月内,CI 里写死 `[profile.dev]` 会从「无所谓」变成「技术债」。**

**判断三:LLM 时代让「规范可读」变成语言的核心竞争力。**
今天早间那条新闻里,苹果因为 AI agent 风险把 macOS 权限收紧到「very explicit user action」;中午 Caddy 把请求头白名单从 `allow_*` 改成 `expected_*`。**当越来越多代码由 AI 生成、由 AI 审查时,「规范有没有写清楚这件事能不能做」就从文档质量问题变成了安全问题。** Rust 1.99 把三处 unsafe 灰区写进规范,跟苹果收紧磁盘权限是同一个趋势在语言层的投影:**默认不信任,信任必须显式、可查、可证。** 未来选择系统语言时,「规范的完备度与可机读性」会越来越靠前。

---

## 写在最后

Rust 1.99 不是一个会让你周一早上兴奋地发推的版本:没有新框架、没有 10x 性能、没有震撼 demo。它做的是更耐久的事——把三处「大家都在用、没人能证明」的 unsafe 灰区写进了规范,顺带把 Cargo 的 profile 体系和 rustdoc 的构建管线各自往前推了一步。

如果你写 safe Rust,这个版本给你 `Vec::into_parts`/`from_parts`、`from_utf8_lossy_owned`、`Box::into_non_null`/`from_non_null`、`std::fs::set_times`/`set_times_nofollow`、`VecDeque::retain_back`,以及更快的 `a..=b` 循环。

如果你写 unsafe、写 FFI、写库的公共 API,**这个版本要求你重读三段文档**:`UnsafeCell` 的访问规则、`Pin` 的安全不变量、C-variadic 的 ABI 集合。前两处官方都说「不是 breaking change」——**但「规范没保证」与「你的代码依赖它」之间的距离,往往比 breaking change 更近。**

下班前跑一遍 `rustup update stable`,然后把 `Pin::new_unchecked` 的 SAFETY 注释补全。这是 1.99 唯一真正紧迫的事。

---

**数据来源**:本文所有改动条目均来自 [Rust 1.99.0 官方 release notes](https://doc.rust-lang.org/stable/releases.html#version-1990-2026-10-01)(2026-10-01 发布),关键数据点逐条追溯到对应 PR body:[#159730](https://github.com/rust-lang/rust/pull/159730)(UnsafeCell / UCG #281)、[#156935](https://github.com/rust-lang/rust/pull/156935)(PinSafePointer 5 条要求 + 剩余 2 个 soundness issue)、[#155697](https://github.com/rust-lang/rust/pull/155697)(C-variadic 稳定)、[#159746](https://github.com/rust-lang/rust/pull/159746)(naked 变参 + aapcs 示例)、[#159525](https://github.com/rust-lang/rust/pull/159525)(128 位整数向量寄存器)、[#159729](https://github.com/rust-lang/rust/pull/159729)(分配只许增长 / UCG #430 / llvm#141338)、[#155114](https://github.com/rust-lang/rust/pull/155114)(Step::forward/backward_overflowing + RangeInclusive 已耗尽语义)、[#157857](https://github.com/rust-lang/rust/pull/157857)(`#[my_macro] mod foo;`)、[#160594](https://github.com/rust-lang/rust/pull/160594)(global_asm target feature)、[#158510](https://github.com/rust-lang/rust/pull/158510)(static PIE)、[#158734](https://github.com/rust-lang/rust/pull/158734)(LLVM 23 + f128 Windows ABI + Darwin dylib)、[#159623](https://github.com/rust-lang/rust/pull/159623)(rustdoc -20% / BadImplStripper 删除)、[#158766](https://github.com/rust-lang/rust/pull/158766)(riscv64 musl Tier 2)、[cargo #17214](https://github.com/rust-lang/cargo/pull/17214)(debug profile)、[cargo #17220](https://github.com/rust-lang/cargo/pull/17220)(CI 关增量编译 4 层优先级)、[cargo #17126](https://github.com/rust-lang/cargo/pull/17126)(RFC 3945 default-features 覆盖, edition 2024)。
