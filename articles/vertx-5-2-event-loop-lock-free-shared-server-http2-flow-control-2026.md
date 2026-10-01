---
title: "Vert.x 5.2.0 深度拆解:事件循环组无锁化、共享服务器重写、HTTP/2 流控默认值与 ML-DSA PEM 落地"
date: 2026-10-01
category: 技术
tags: [Vert.x, Vert.x 5.2.0, Eclipse Vert.x, 事件循环, EventLoop, VertxEventLoopGroup, 无锁, LockFree, CopyOnWrite, AtomicReference, CAS, 负载均衡, LoadBalancer, 共享服务器, SharedServer, CloseableResource, createSharedResource, ChannelInitializer, ServerChannelLoadBalancer, HTTP/2, HTTP2, 流控, FlowControl, InitialWindowSize, ConnectionWindowSize, 接收窗口, 背压, BackPressure, 重入, Reentrancy, Http2ConnectionEncoder, writePendingBytes, ChunkedWriteHandler, sendFile, 零拷贝, ZeroCopy, TLS升级, SSL Upgrade, ML-DSA, 后量子, PQC, PostQuantum, PEM, PKCS8, KeyFactory, X25519MLKEM768, JsonObject, JsonArray, Buffer, Shareable, ClusterSerializable, SharedData, 深拷贝, 事件总线, EventBus, TracingPolicy, 追踪策略, OpenTelemetry, 虚拟线程, VirtualThread, JDK, Netty, Netty 4.2, QUIC, HTTP3, Java, 响应式, Reactive, 微服务, 2026]
author: 林小白
readtime: 26
cover: https://images.unsplash.com/photo-1635776062127-d379bfcba9e4?w=600&h=400&fit=crop
excerpt: "2026 年 9 月 18 日 Eclipse Vert.x 5.2.0 发布,随后两周连续合入 6 个承重级修复。这个版本的主题可以用一句话概括:把事件循环上所有「synchronized + 可变集合」的隐式同步契约,全部换成 copy-on-write + AtomicReference 的无锁结构,并把这条无锁化一路推到共享服务器的通道分发层。VertxEventLoopGroup 从 synchronized List<EventLoopHolder> + 手写 Set 改成 AtomicReference<EventLoopLoadBalancer>,next() 从加锁轮询变成原子自增选择,addWorker/removeWorker 的 O(n) 线性扫描 + equals 比较被一次性整表替换取代;ServerChannelLoadBalancer 删掉 ConcurrentHashMap + volatile hasHandlers + 手写 WorkerList 轮询,全部委托给新的负载均衡器;NetServerImpl 的共享服务器实现从 VertxImpl 里的 HashMap<ServerID, NetServerInternal> 共享 Map 重写成 vertx.createSharedResource(\"__vertx.shared.tcpServers\", key) 的 CloseableResource 引用计数,关闭顺序从「THIS CAN BE RACY 的 best-effort」变成 removeHandler 返回值的确定性判断;HTTP/2 流控默认值从连接窗口 -1(由 Netty 实现自定)改成流窗口 1 MiB + 连接窗口 16 MiB 双显示默认值,顺手修掉 writeData 里 writePendingBytes 的重入问题;TLS 升级后 sendFile 零拷贝失效要补 ChunkedWriteHandler;ML-DSA PEM 私钥加载第一次进 KeyStoreHelper。本文按「无锁化 → 共享资源生命周期 → HTTP/2 流控 → TLS 后量子 → 数据类型解耦」五条线拆完 5 大承重级革新,每项附可运行代码与生产升级建议。"
---

# Vert.x 5.2.0 深度拆解:事件循环组无锁化、共享服务器重写、HTTP/2 流控默认值与 ML-DSA PEM 落地

> 2026 年 9 月 18 日,Eclipse Vert.x 5.2.0 发布。看完 changelog 的第一感受是:这个版本没有加任何新协议、新客户端、新数据类型,它做的全部事情是**把事件循环上最后几处「大家一直这么写,也没出过大事」的可变同步结构,翻出来重写成无锁的**。
>
> 这五件事可以串成一句话:**在 2026 年的部署形态下,事件循环上的每一次锁竞争,都是从「每秒万级连接」里扣税。** Vert.x 从 4.x 到 5.x 一直在做「把同步代码从 IO 线程上挪走」(虚拟线程、worker 线程模型、异步 IO),但一直没动的是**事件循环组自身的数据结构**——那个决定下一个连接分给哪个 EventLoop、哪个 server handler 的分发层。5.2.0 把这一层全部换掉了。

---

## 一、问题的源头:事件循环组上的三处隐式锁

要理解 Vert.x 5.2.0 为什么花一整个版本去改数据结构,先要看清原来的代码在什么场景下会被逼到墙角。

### 1.1 VertxEventLoopGroup:synchronized List 加手写 Set

Vert.x 的每个 `Vertx` 实例有一个 `VertxEventLoopGroup`,它是 Netty `EventLoopGroup` 的包装。原来的实现长这样:

```java
public final class VertxEventLoopGroup extends AbstractEventExecutorGroup implements EventLoopGroup {
  private int pos;
  private final List<EventLoopHolder> workers = new ArrayList<>();
  private final Set<EventExecutor> children = new Set<EventExecutor>() { ... };

  @Override
  public synchronized EventLoop next() {
    if (workers.isEmpty()) {
      throw new IllegalStateException();
    } else {
      EventLoop worker = workers.get(pos).worker;
      pos++;
      checkPos();
      return worker;
    }
  }

  public synchronized void addWorker(EventLoop worker) { ... }
  public synchronized void removeWorker(EventLoop worker) { ... }
  public synchronized boolean awaitTermination(long timeout, TimeUnit unit) { return false; }
}
```

三个细节决定了这个结构在 2026 年是问题:

1. **`next()` 是 `synchronized`**。这个方法被**每一条新接受的连接**调用一次(`ServerChannelLoadBalancer.initChannel` → `chooseInitializer(ch.eventLoop())` 的上游),也被每个 `vertx.executeBlocking` / 定时器 / 事件总线消费者注册时取上下文执行器时调用。所有调用都发生在 Netty 的 acceptor 线程或事件循环线程上——**这些线程是最不能被阻塞的线程**。
2. **`children` 是一个手写的、21 个方法的 `Set`**,其中 5 个方法(`add`/`remove`/`addAll`/`retainAll`/`clear`)直接 `throw new UnsupportedOperationException()`,`iterator()` 返回 `workers.iterator()` 的包装。这个内部类存在的唯一原因是 Netty 的 `EventExecutorGroup` 接口要求一个 `Set<EventExecutor> children()` 方法用于优雅关闭时遍历子执行器。
3. **`removeWorker` 是 O(n) 的**,而且要先 `findHolder(worker)`——一个用 `EventLoopHolder.equals()` 逐个比较的线性扫描。

### 1.2 ServerChannelLoadBalancer:ConcurrentHashMap 加 volatile 布尔

共享服务器(多个 verticle 共用同一个 host:port)的分发层是 `ServerChannelLoadBalancer`,它是一个 Netty `ChannelInitializer`,每条新连接进来时按连接的 `EventLoop` 找到注册在这个 event loop 上的 handler 列表:

```java
class ServerChannelLoadBalancer extends ChannelInitializer<Channel> {
  private final VertxEventLoopGroup workers;
  private final ConcurrentMap<EventLoop, WorkerList> workerMap = new ConcurrentHashMap<>();

  // We maintain a separate hasHandlers variable so we can implement hasHandlers() efficiently
  // As it is called for every HTTP message received
  private volatile boolean hasHandlers;

  private Handler<Channel> chooseInitializer(EventLoop worker) {
    WorkerList handlers = workerMap.get(worker);
    return handlers == null ? null : handlers.chooseHandler();
  }

  public synchronized void addWorker(EventLoop eventLoop, Handler<Channel> handler) { ... }
  public synchronized boolean removeWorker(EventLoop eventLoop, Handler<Channel> worker) { ... }
}
```

注释里那行「We maintain a separate hasHandlers variable so we can implement hasHandlers() efficiently / As it is called for every HTTP message received」是整段代码最有信息量的一行:**`hasHandlers()` 被每条 HTTP 消息调用,所以不能用 `workerMap` 实时算,只能维护一个 volatile 布尔缓存**。这是一个「为了性能做缓存,但缓存引入了正确性风险」的典型结构——而 `NetServerImpl.handleShutdown` 里那段 `// THIS CAN BE RACY` 的注释,正是这个结构在关闭路径上的代价。

### 1.3 共享服务器:VertxImpl 里的全局 HashMap

最顶层的问题是:这些 `ServerChannelLoadBalancer` 的生命周期挂在哪?5.2.0 之前,挂在 `VertxImpl` 的一个实例字段上:

```java
private final Map<ServerID, NetServerInternal> sharedNetServers = new HashMap<>();

public Map<ServerID, NetServerInternal> sharedTcpServers() {
  return sharedNetServers;
}
```

这个 `HashMap` 的读写发生在 `NetServerImpl.listen()` 的同步段里,QUIC 服务器则更粗糙——直接用 `vertx.sharedData().getLocalMap(QUIC_SERVER_MAP_KEY)` 这个**跨 verticle 共享的 LocalMap** 存 `QuicDispatcher`,然后用 `synchronized (map)` 保护「get-or-create」:

```java
LocalMap<String, QuicDispatcher> map = vertx.sharedData().getLocalMap(QUIC_SERVER_MAP_KEY);
QuicDispatcher dispatcher;
boolean init;
synchronized (map) {
  QuicDispatcher attempt = map.get(serverID.toString());
  if (attempt == null) {
    init = true;
    attempt = new QuicDispatcher(serverID, new SslContextProviderReference((ServerSslContextManager)manager));
    map.put(serverID.toString(), attempt);
  } else {
    init = false;
  }
  dispatcher = attempt;
}
```

把「同一台 Vert.x 实例内部的通道分发器」放进一个**语义上是跨节点共享**的 LocalMap 里,再手动加 `synchronized`,是「有更合适的工具但顺手用了手边的」的典型。

---

## 二、5.2.0 的核心改动:把三处锁换成 copy-on-write 无锁结构

### 2.1 承重级革新 ①:VertxEventLoopGroup 全量无锁化(PR #6366)

新实现把整个可变状态压成一个不可变对象,再用 `AtomicReference` 做整体替换:

```java
public final class VertxEventLoopGroup extends AbstractEventExecutorGroup implements EventLoopGroup {

  private final AtomicReference<EventLoopLoadBalancer> eventLoopLoadBalancerRef;

  public VertxEventLoopGroup() {
    eventLoopLoadBalancerRef = new AtomicReference<>(new EventLoopLoadBalancer(0, List.of(), false));
  }

  @Override
  public EventLoop next() {
    EventLoopLoadBalancer eventLoopLoadBalancer = eventLoopLoadBalancerRef.get();
    EventLoop eventLoop = eventLoopLoadBalancer.selectEventLoop();
    if (eventLoop == null) {
      throw new IllegalStateException();
    }
    return eventLoop;
  }

  @Override
  public Iterator<EventExecutor> iterator() {
    return new EventLoopIterator(eventLoopLoadBalancerRef.get().handlerLoadBalancers.iterator());
  }

  @Override
  public boolean awaitTermination(long timeout, TimeUnit unit) {
    return false;
  }

  public void shutdown() {
    throw new UnsupportedOperationException("Should never be called");
  }

  public void addHandler(EventLoop eventLoop, Handler<Channel> handler) {
    while (true) {
      EventLoopLoadBalancer prev = eventLoopLoadBalancerRef.get();
      EventLoopLoadBalancer next = prev.addHandler(eventLoop, handler);
      if (eventLoopLoadBalancerRef.compareAndSet(prev, next)) {
        break;
      }
    }
  }

  public boolean removeHandler(EventLoop eventLoop, Handler<Channel> handler) {
    while (true) {
      EventLoopLoadBalancer prev = eventLoopLoadBalancerRef.get();
      EventLoopLoadBalancer next = prev.removeHandler(eventLoop, handler);
      if (eventLoopLoadBalancerRef.compareAndSet(prev, next)) {
        return !next.closing;
      }
    }
  }

  public Handler<Channel> chooseHandler(EventLoop eventLoop) {
    EventLoopLoadBalancer current = eventLoopLoadBalancerRef.get();
    if (current.closing) {
      return channel -> {
        // Pretty much what ServerBootstrap#forceClose does
        channel.unsafe().closeForcibly();
      };
    } else {
      int idx = indexOfEventLoop(current.handlerLoadBalancers, eventLoop);
      if (idx == -1) {
        return null;
      } else {
        return current.handlerLoadBalancers.get(idx).chooseHandler();
      }
    }
  }
}
```

两个嵌套的不可变负载均衡器承担了全部状态:

```java
private static class EventLoopLoadBalancer extends AtomicInteger {

  private final List<HandlerLoadBalancer> handlerLoadBalancers;
  private final boolean closing;

  public EventLoopLoadBalancer(int pos, List<HandlerLoadBalancer> handlerLoadBalancers, boolean closing) {
    super(pos);
    this.handlerLoadBalancers = handlerLoadBalancers;
    this.closing = closing;
  }

  public EventLoop selectEventLoop() {
    if (handlerLoadBalancers.isEmpty()) {
      return null;
    } else {
      int idx = getAndIncrement();
      if (idx >= handlerLoadBalancers.size()) {
        // Racy but ok
        idx = 0;
        set(1);
      }
      return handlerLoadBalancers.get(idx).eventLoop;
    }
  }

  public EventLoopLoadBalancer addHandler(EventLoop eventLoop, Handler<Channel> handler) {
    if (closing) {
      throw new IllegalStateException();
    }
    List<HandlerLoadBalancer> copyOfHandlerLoadBalancers = new ArrayList<>(handlerLoadBalancers);
    int idx = indexOfEventLoop(copyOfHandlerLoadBalancers, eventLoop);
    if (idx == -1) {
      copyOfHandlerLoadBalancers.add(new HandlerLoadBalancer(0, eventLoop, List.of(handler)));
    } else {
      copyOfHandlerLoadBalancers.set(idx, copyOfHandlerLoadBalancers.get(idx).addHandler(handler));
    }
    return new EventLoopLoadBalancer(get(), copyOfHandlerLoadBalancers, false);
  }

  public EventLoopLoadBalancer removeHandler(EventLoop eventLoop, Handler<Channel> handler) {
    if (closing) {
      throw new IllegalStateException();
    }
    int idx1 = indexOfEventLoop(handlerLoadBalancers, eventLoop);
    if (idx1 == -1) {
      throw new IllegalStateException("Can't find event-loop to remove");
    }
    HandlerLoadBalancer handlerLoadBalancer = handlerLoadBalancers.get(idx1);
    int idx2 = handlerLoadBalancer.handlers.indexOf(handler);
    if (idx2 == -1) {
      throw new IllegalStateException("Can't find handler to remove");
    }
    int numberOfHandlers = 0;
    for (HandlerLoadBalancer loadBalancer : handlerLoadBalancers) {
      numberOfHandlers += loadBalancer.handlers.size();
    }
    if (numberOfHandlers == 1) {
      // 最后一个 handler 被移除:进入 closing 状态,不再分配新连接
      return new EventLoopLoadBalancer(get(), handlerLoadBalancers, true);
    } else {
      List<Handler<Channel>> handlersCopy = new ArrayList<>(handlerLoadBalancer.handlers);
      handlersCopy.remove(idx2);
      HandlerLoadBalancer copyOfHandlerLoadBalancer =
        new HandlerLoadBalancer(handlerLoadBalancer.get(), handlerLoadBalancer.eventLoop, handlersCopy);
      List<HandlerLoadBalancer> copyOfHandlerLoadBalancers = new ArrayList<>(handlerLoadBalancers);
      if (copyOfHandlerLoadBalancer.handlers.isEmpty()) {
        copyOfHandlerLoadBalancers.remove(idx1);
      } else {
        copyOfHandlerLoadBalancers.set(idx1, copyOfHandlerLoadBalancer);
      }
      return new EventLoopLoadBalancer(get(), copyOfHandlerLoadBalancers, false);
    }
  }
}

private static class HandlerLoadBalancer extends AtomicInteger {

  private final EventLoop eventLoop;
  private final List<Handler<Channel>> handlers;

  HandlerLoadBalancer(int pos, EventLoop eventLoop, List<Handler<Channel>> handlers) {
    super(pos);
    this.eventLoop = eventLoop;
    this.handlers = handlers;
  }

  Handler<Channel> chooseHandler() {
    int idx = getAndIncrement();
    if (idx >= handlers.size()) {
      // Racy but ok
      idx = 0;
      set(1);
    }
    return handlers.get(idx);
  }

  public HandlerLoadBalancer addHandler(Handler<Channel> handler) {
    List<Handler<Channel>> copyOfHandlers = new ArrayList<>(handlers.size() + 1);
    copyOfHandlers.addAll(handlers);
    copyOfHandlers.add(handler);
    return new HandlerLoadBalancer(get(), eventLoop, copyOfHandlers);
  }
}
```

**这四段代码的五个设计要点**:

1. **`next()` 从 `synchronized` 变成无锁**。路径是 `ref.get()`(一次 volatile 读)→ `selectEventLoop()`(一次 `AtomicInteger.getAndIncrement()`)→ 数组下标取值。整条路径没有任何锁,也没有任何 CAS 重试。这是**每条新连接都要走的路径**,也是改动收益最大的地方。
2. **轮询计数器用 `AtomicInteger` 而不是 `int + synchronized`**。注意 `EventLoopLoadBalancer extends AtomicInteger`——轮询位置就是原子计数器本身,`selectEventLoop()` 里 `idx = getAndIncrement()` 一行完成「取值并前进」。溢出时回绕到 0 是良性的(注释 `// Racy but ok`),因为轮询负载均衡只需要概率上的均匀,不需要严格公平。
3. **不可变 + copy-on-write,而不是并发集合**。`addHandler`/`removeHandler` 不修改任何现有集合,而是复制一份新 list、包成新对象、用 CAS 整体替换。代价是注册/注销时的一次 O(n) 复制(每个 event loop 一次,handler 列表通常极短),收益是读路径完全无锁且**不需要 volatile 缓存布尔**——因为状态本身不可变,`ref.get()` 拿到的快照永远一致。
4. **`closing` 状态机取代 `hasHandlers` 缓存**。旧代码的 `hasHandlers` 是一个 volatile 布尔,由 `synchronized` 方法写入,读路径(每条 HTTP 消息)读它。新代码里 `closing` 是不可变快照的一个 final 字段,`chooseHandler()` 读到 `closing == true` 时返回一个**强制关闭 channel 的 handler**:

```java
  public Handler<Channel> chooseHandler(EventLoop eventLoop) {
    EventLoopLoadBalancer current = eventLoopLoadBalancerRef.get();
    if (current.closing) {
      return channel -> {
        // Pretty much what ServerBootstrap#forceClose does
        channel.unsafe().closeForcibly();
      };
    }
    ...
```

   这不是「优雅地不再接受新连接」,而是「把刚 accept 进来还没初始化的 channel 立刻暴力关掉」——这正是关闭路径上需要的语义:acceptor 线程可能已经把 channel 交到负载均衡器手上,此时再去走正常初始化流程(分配 event loop、注册 selector、跑 SSL 握手)是无意义的浪费,甚至可能跟 shutdown 的 future 产生竞争。

5. **`removeHandler` 的返回值变成了确定性判断**。`handleShutdown` 从:

```java
    boolean hasHandlers;
    synchronized (servers) {
      ServerChannelLoadBalancer balancer = actualServer.channelBalancer;
      balancer.removeWorker(eventLoop, worker);
      hasHandlers = balancer.hasHandlers();
    }
    // THIS CAN BE RACY
    if (hasHandlers) {
```

   变成:

```java
    boolean hasHandlers;
    synchronized (servers) {
      ServerChannelLoadBalancer balancer = actualServer.channelBalancer;
      hasHandlers = balancer.removeWorker(eventLoop, worker);
    }
    if (hasHandlers) {
      // The actual server still has handlers so we don't actually close it
      completion.succeed();
    } else {
      // Close the server, normally the load balancer entered a state in which all newly accepted connections
      // are closed
      ...
```

   `removeHandler` 在 CAS 成功后返回 `!next.closing`——**移除操作和「还有没有 handler」的判断变成同一个原子操作的输出**,注释里那句 `// THIS CAN BE RACY` 终于被删掉了。

**性能对比**:

| 操作 | 5.1.x(锁) | 5.2.0(无锁) |
|------|------------|--------------|----------|
| `next()` 选 event loop | `synchronized` → volatile 读 + 数组取值 | volatile 读 + `getAndIncrement` + 数组取值 |
| 注册一个 server handler | `synchronized` + O(n) `equals` 扫描 | 无竞争 CAS + O(n) 复制(每 event loop) |
| 注销一个 server handler | `synchronized` + O(n) 扫描 + volatile 写 | 无竞争 CAS + O(n) 复制,返回值即「是否还有 handler」 |
| 关闭时遍历 children | 手写 21 方法 Set(5 个抛异常) | `EventLoopIterator` 包一个 `List<HandlerLoadBalancer>` 迭代器 |
| 每条 HTTP 消息的 `hasHandlers()` | volatile 布尔读 | 不存在了(读快照的 final 字段) |

**注意 `// Racy but ok` 出现了两次**。这是设计者明确承认的良性竞争:计数器溢出回绕是良性的,因为它只影响轮询的均匀性。**这是无锁设计的正确用法——把「必须严格一致」的状态(列表内容)做成不可变快照,把「可以大概对」的状态(轮询位置)留给原子计数器**。如果反过来(可变列表 + 严格轮询),就既需要锁又需要顺序保证。

### 2.2 承重级革新 ②:共享服务器从全局 HashMap 重写为 CloseableResource 引用计数(PR #6367)

`VertxImpl` 里那个 `Map<ServerID, NetServerInternal> sharedNetServers` 被整个删掉了,`VertxInternal.sharedTcpServers()` 这个公开方法也随之删除。取而代之的是 `vertx.createSharedResource(...)`:

```java
    CloseableResource<TcpServer> resource;
    if (shared) {
      String key = id.host() + "." + id.port();
      boolean[] created = new boolean[1]; // Hack
      resource = vertx.createSharedResource("__vertx.shared.tcpServers", key, () -> {
        created[0] = true;
        return new TcpServer(sslEngineOptions, sslOptions, context.promise(), vertx.eventLoopGroup(),
                             config.getTrafficShapingOptions(), ap);
      });
      if (created[0]) {
        resource.get().bind(config, sslOptions, vertx.acceptorEventLoopGroup(), protocol, vertx.metrics(),
                            vertx.transport(), hostOrPath, context, bindAddress, localAddress);
      }
    } else {
      // 非共享:自己创建一个不被引用计数的 CloseableResource
      PromiseInternal<Channel> promise = context.promise();
      TcpServer server = new TcpServer(sslEngineOptions, sslOptions, promise, vertx.eventLoopGroup(),
                                       config.getTrafficShapingOptions(), ap);
      resource = new CloseableResource<>() {
        @Override
        public TcpServer get() { return server; }
        @Override
        public Future<Void> shutdown(Duration timeout) { return server.shutdown(timeout); }
      };
    }
```

QUIC 服务器同样从 LocalMap + `synchronized (map)` 迁移:

```java
    if (config.isLoadBalanced()) {
      final boolean[] init = { false };
      String key = serverID.host() + "." + serverID.port();
      CloseableResource<QuicDispatcher> resource =
        vertx.createSharedResource(QUIC_SERVER_MAP_KEY, key, () -> {
          init[0] = true;
          return new QuicDispatcher(new SslContextProviderReference((ServerSslContextManager) manager));
        });
      dispatcher = resource.get();

      Future<ServerSslContextProvider> fut;
      if (init[0]) {
        fut = dispatcher.sslContextProviderRef.update(sslOptions, context);
      } else {
        fut = context.succeededFuture();
      }

      sslContextProviderRef = dispatcher.sslContextProviderRef;
      return fut.onFailure(err -> resource.close())
                .map(sslContextProvider -> new ChannelInitializer<>() {
                  @Override
                  protected void initChannel(Channel ch) {
                    dispatcher.register(ch, context, QuicServerImpl.this, metrics, resource);
                    ch.pipeline().addLast(dispatcher);
                  }
                });
    }
```

**三个结构性的改进**:

1. **生命周期从「谁第一个创建谁负责关闭」变成引用计数**。`createSharedResource(name, key, factory)` 返回一个 `CloseableResource`,同一个 key 的后续调用拿到同一个底层对象但各自持有一个引用;每个引用 `close()` 时减一,归零时真正关闭。这消除了旧实现里「第一个 listen 的 verticle 持有 `actualServer` 引用,它 close 了但别的 verticle 还在用」的整类 bug。
2. **失败路径被显式处理**。注意 `.onFailure(err -> resource.close())`——SSL context 更新失败时立刻释放这个共享引用,不会留下一个「占着 key 但没 bind 成功」的僵尸资源。
3. **`actualPort()` 从委托查找变成直接读**:

```java
  public int actualPort() {
    CloseableResource<TcpServer> ref = resource;
    return ref == null ? 0 : ref.get().actualPort;
  }
```

   旧代码是 `NetServerImpl server = actualServer; return server != null ? server.actualPort : actualPort;`——`actualServer` 是一个在 listen 流程里被赋值的可变字段,跨线程可见性靠 synchronized 段保证。新代码 `resource` 是 volatile 的(在 listen 完成后赋值一次),读路径无锁。

**`TcpServer` 从内部类变成静态内部类**也是一个信号:它不再持有 `NetServerImpl.this` 的隐式引用,因此可以被多个 `NetServerImpl` 实例(多个 verticle)安全共享,而不会有 this 引用造成的内存泄漏风险。

**迁移注意**:任何调用了 `((VertxInternal) vertx).sharedTcpServers()` 的代码(主要是测试里直接翻进内部实现拿服务器对象的)在 5.2.0 会编译失败。官方自己的 `SSLEngineTest` 就改成了:

```java
      NetServerInternal tcpServer = ((TcpHttpServer)((HttpServerInternal)server).unwrap()).tcpServer();
```

**这条路是公开 API**:`server.unwrap()` → `HttpServerInternal` → `tcpServer()`。第三方代码迁移时应该走这条路径,不要反射去拿。

### 2.3 承重级革新 ③:HTTP/2 流控默认值显式化 + 重入修复(PR #6240 + #6360)

HTTP/2 有两个**完全独立**的接收窗口,Vert.x 5.2.0 之前只有一个配置项,语义还是含混的:

| 窗口 | 作用 | 5.1.x 默认 | 5.2.0 默认 |
|------|------|-----------|-----------|
| per-stream `INITIAL_WINDOW_SIZE` | 每条流(每个请求/响应) | 65535(HTTP/2 规范默认,Netty 的 `Http2Settings` 默认值) | **1 MiB** |
| connection window | 一条连接上所有流的合计 | **-1**(由 Netty 实现自行决定) | **16 MiB** |

旧 Javadoc 对 `-1` 的解释是「reuses the initial window size setting」,新 Javadoc 明确改成「leaves the connection window size chosen by the HTTP/2 implementation unchanged. The multiplex implementation can enlarge this window based on the initial stream window size.」——**承认之前是「不设置就是实现说了算」**,现在至少把「实现会怎么处理」写清楚了。

改动代码:

```java
// HttpClientOptions.java
  /**
   * The default initial HTTP/2 stream window size = 1 MiB
   */
  public static final int DEFAULT_INITIAL_SETTINGS_INITIAL_WINDOW_SIZE = 1024 * 1024;

  /**
   * The default connection window size for HTTP/2 = 16 MiB
   */
  public static final int DEFAULT_HTTP2_CONNECTION_WINDOW_SIZE = 16 * 1024 * 1024;
```

```java
// Http2ServerConfig.java
  public Http2ServerConfig() {
    initialSettings = new Http2Settings()
      .setMaxConcurrentStreams(DEFAULT_INITIAL_SETTINGS_MAX_CONCURRENT_STREAMS)
      .setInitialWindowSize(DEFAULT_INITIAL_SETTINGS_INITIAL_WINDOW_SIZE);
    connectionWindowSize = DEFAULT_HTTP2_CONNECTION_WINDOW_SIZE;
    ...
```

文档里新增的说明是这篇文章最该记住的一段:

> HTTP/2 flow control uses two independent receive windows. The initial window size in `Http2ServerConfig#getInitialSettings` applies to each stream, while `Http2ServerConfig#getConnectionWindowSize` applies to the combined data received by all streams on a connection.
>
> Applications receiving large request bodies, such as large gRPC messages, can tune both values. Larger windows improve throughput on connections with significant bandwidth or latency, at the cost of allowing more data to be buffered before back-pressure is applied.

配套的重入修复(PR #6360)删掉了 `writeData` 里的一次手动 `writePendingBytes()`:

```java
  void writeData(Http2Stream stream, ByteBuf chunk, boolean end, FutureListener<Void> listener) {
    ChannelPromise promise = listener == null ? chctx.voidPromise() : chctx.newPromise().addListener(listener);
    // 5.1.x:
    //   Http2ConnectionEncoder encoder = encoder();
    //   encoder.writeData(chctx, stream.id(), chunk, 0, end, promise);
    //   Http2RemoteFlowController controller = encoder.flowController();
    //   if (!controller.isWritable(stream) || end) {
    //     try {
    //       encoder.flowController().writePendingBytes();
    //     } catch (Http2Exception e) {
    //       onError(chctx, true, e);
    //     }
    //   }
    // 5.2.0:
    encoder().writeData(chctx, stream.id(), chunk, 0, end, promise);
    checkFlush();
  }
```

旧代码的意图是「写完数据后,如果流不可写或这是最后一帧,就把挂起的字节数推给对端」。但 `writePendingBytes()` 本身会触发流控器的内部状态变更,**在 `writeData` 的调用栈内重入**。新代码把它删掉,只保留 `checkFlush()`——flush 的职责是「把 Netty 出站缓冲排空到 socket」,流控更新让 Netty 的 `DefaultHttp2RemoteFlowController` 在 `writeData` 内部自己处理。

新增的回归测试 `testFlowControlReentrancyWithLargeWindows` 精确复现了这个场景:16 个并发请求、每个响应 512 KiB、客户端 stream window 1 MiB、连接 window 16 MiB,客户端收到响应后 `pause()` 250ms 再 `resume()`:

```java
  @Test
  public void testFlowControlReentrancyWithLargeWindows(Checkpoint checkpoint) throws Exception {
    int numReq = 16;
    CountDownLatch latch = checkpoint.asLatch(numReq);
    Buffer body = Buffer.buffer(TestUtils.randomAlphaString(512 * 1024));
    server = vertx.createHttpServer(Http2TestBase.createHttp2ServerOptions());
    server.requestHandler(req -> req.response().end(body));
    startServer(testAddress);
    HttpClientOptions clientOptions = Http2TestBase.createHttp2ClientOptions()
      .setInitialSettings(new Http2Settings().setInitialWindowSize(1024 * 1024))
      .setHttp2ConnectionWindowSize(16 * 1024 * 1024);
    vertx.deployVerticle(new VerticleBase() {
      HttpClientAgent client;
      @Override
      public Future<?> start() throws Exception {
        client = vertx.httpClientBuilder().with(clientOptions).build();
        for (int i = 0; i < numReq; i++) {
          client.request(requestOptions)
            .compose(req -> req
              .send()
              .compose(resp -> {
                resp.pause();
                vertx.setTimer(250, id -> resp.resume());
                return resp.end();
              }))
            .onComplete(TestUtils.onSuccess(v -> latch.countDown()));
        }
        return super.start();
      }
    }, new DeploymentOptions().setThreadingModel(ThreadingModel.WORKER));
  }
```

**这个测试的三个要素缺一不可**:大窗口(让流控真正成为限制因素)、`pause()/resume()`(触发窗口更新帧的往返)、并发(让重入在多流之间交错)。**这是「什么情况下流控代码会真正出问题」的教科书级最小复现**,值得照抄到任何 HTTP/2 客户端测试里。

**为什么默认值从 64 KiB 提到 1 MiB / 16 MiB**:HTTP/2 的流控窗口在 **BDP(带宽延迟积)** 大的链路上是硬上限。一条 100 Mbps × 100 ms RTT 的链路 BDP ≈ 1.25 MB,旧默认值 64 KiB 意味着**窗口只能填满链路的 5%**。提到 1 MiB per stream / 16 MiB per connection 后,单流可以打满 10 倍 BDP 的链路。代价是**背压到来前可以缓冲更多数据**——对 Vert.x 这种事件驱动模型来说,这意味着一个慢消费者可以让服务端在内存里堆 16 MiB 的响应体。**所以这个默认值改动是「吞吐换内存」的明确选择**,如果你的应用做的是大文件下载或大 gRPC 消息,这是好消息;如果是海量小请求,1 MiB 的 stream 窗口会让单个慢连接的内存占用从 64 KiB 涨到 1 MiB,需要按连接数重新评估内存预算。

### 2.4 承重级革新 ④:TLS 升级后 sendFile 的零拷贝失效修复(PR #6361)

`NetSocket.sendFile()` 在明文连接上用的是零拷贝(`FileRegion`,底层 `sendfile` syscall,数据不进用户态)。但连接一旦中途升级到 TLS(`upgradeToSsl`),零拷贝就不能用了——加密必须在用户态完成,Netty 的做法是换成 `ChunkedWriteHandler` + `ChunkedFile` 分块加密写。问题是 5.1.x 的 pipeline 在明文建连时没有装 `ChunkedWriteHandler`,升级 SSL 时也没补:

```java
            chctx.pipeline().addFirst("ssl", sslHandler);
            if (chctx.pipeline().get("chunkedWriter") == null) {
              // The connection can no longer use zero-copy, sendFile needs a ChunkedWriteHandler to consume the
              // chunked file it writes - the pipeline was set up without one since the channel was not encrypted
              chctx.pipeline().addBefore(chctx.name(), "chunkedWriter", new ChunkedWriteHandler());
            }
```

注释把原因说得清清楚楚:**「the pipeline was set up without one since the channel was not encrypted」**。这是「建连时的 pipeline 结构假设了连接整个生命周期都是明文」的典型——而 `upgradeToSsl` 打破了这个假设,但没人记得更新 pipeline。

注意 `addBefore(chctx.name(), ...)` 的位置:`chctx` 是 `NetSocketImpl` 自己的 handler context,`ChunkedWriteHandler` 装在它**前面**,这样 `sendFile` 产生的 `ChunkedFile` 消息会被 `ChunkedWriteHandler` 先消费掉,不会一路传到 `NetSocketImpl`。

官方测试 `testSendFileAfterTlsUpgrade` 覆盖了两个方向:

```java
  @Test
  public void testSendFileFromClientAfterTlsUpgrade(Checkpoint received) throws Exception {
    File dir = testFolder.newFolder();
    int size = 64 * 1024;
    String content = randomAlphaString(size);
    File f = setupFile(dir.toString(), "upgraded-client.dat", content);
    Buffer body = Buffer.buffer();
    server.connectHandler(socket -> {
      // The handler is set before the upgrade, so that no data can be missed when the handshake completes
      socket.handler(buff -> {
        body.appendBuffer(buff);
        if (body.length() == size) {
          assertEquals(content, body.toString());
          received.succeed();
        }
      });
      socket.upgradeToSsl(new ServerSSLOptions().setKeyCertOptions(Cert.SERVER_JKS.get()))
        .onFailure(received::fail);
    });
    server.listen(1234, "localhost").await();
    NetSocket socket = client.connect(1234, "localhost").await();
    socket.upgradeToSsl(new ClientSSLOptions()
      .setHostnameVerificationAlgorithm("")
      .setTrustAll(true)).await();
    socket.sendFile(f.getAbsolutePath()).await();
  }
```

**这个 bug 的隐蔽之处在于它不一定表现为崩溃**。缺 `ChunkedWriteHandler` 时,`ChunkedFile` 消息会沿 pipeline 往下走,最终被某个 `ChannelOutboundHandler` 当成普通消息处理——可能静默丢数据,可能在 SSL 加密时抛 `UnsupportedMessageTypeException`,也可能只在特定大小的文件上触发(取决于 `ChunkedFile` 的分块是否被合并)。**这类「pipeline 结构假设」的 bug 在 Netty 生态里是最难排查的一类,因为它的触发条件是「操作顺序」而不是「输入内容」。**

### 2.5 承重级革新 ⑤:ML-DSA 后量子私钥 PEM 加载(PR #6365 + #6347)

5.2.0 之前,Vert.x 加载 PEM 格式的私钥只认 RSA 和 EC:

```java
              return Collections.singletonList(rsaKeyFactory.generatePrivate(new PKCS8EncodedKeySpec(content)));
            } else if (ecKeyFactory != null && ecKeyFactory.getAlgorithm().equals(algorithm)) {
              return Collections.singletonList(ecKeyFactory.generatePrivate(new PKCS8EncodedKeySpec(content)));
            }
            // fall through if ECC is not supported by JVM
```

5.2.0 加了 ML-DSA 分支,而且**错误信息是显式的**:

```java
            } else if ("ML-DSA".equals(algorithm)) {
              try {
                KeyFactory kf = KeyFactory.getInstance(algorithm);
                return Collections.singletonList(kf.generatePrivate(new PKCS8EncodedKeySpec(content)));
              } catch (NoSuchAlgorithmException e) {
                throw new VertxException("ML-DSA algorithm is not supported by this JVM", e);
              }
            }
            // fall through if algorithm is not supported by JVM
```

配套的 ASN.1 OID 识别(在解析 PKCS#8 的 `AlgorithmIdentifier` 时用):

```java
  /**
   * ASN.1 OID for ML-DSA-44 (2.16.840.1.101.3.4.3.17).
   */
  private static final byte[] OID_ML_DSA_44 = { 0x60, (byte) 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x03, 0x11 };
  /**
   * ASN.1 OID for ML-DSA-65 (2.16.840.1.101.3.4.3.18).
   */
  private static final byte[] OID_ML_DSA_65 = { 0x60, (byte) 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x03, 0x12 };
  /**
   * ASN.1 OID for ML-DSA-87 (2.16.840.1.101.3.4.3.19).
   */
  private static final byte[] OID_ML_DSA_87 = { 0x60, (byte) 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x03, 0x13 };
```

```java
    } else if (Arrays.equals(OID_ML_DSA_44, algorithmIdentifier)
            || Arrays.equals(OID_ML_DSA_65, algorithmIdentifier)
            || Arrays.equals(OID_ML_DSA_87, algorithmIdentifier)) {
        return "ML-DSA";
    } else {
        throw new VertxException("Unsupported algorithm identifier");
    }
```

以及 JDK 能力探测(5.1.x 的 `JdkSSLEngineOptions.isPqcAvailable()` 是硬编码 `return false;` 加一句 `// Todo: implement it when JDK add supports`):

```java
  /**
   * @return if PQC key exchange is available via the JDK SSL engine, i.e. the JDK supports
   * at least one of the PQ-compliant named groups (X25519MLKEM768, SecP256r1MLKEM768, SecP384r1MLKEM1024)
   */
  public static synchronized boolean isPqcAvailable() {
    return JdkDependent.isPqcAvailable();
  }
```

注意 `JdkDependent` 的基线版本是 `return false;`,多版本 JDK 的实现在子目录里(Vert.x 用 multi-release jar 按 JDK 版本提供不同实现)。**这个「能力探测 + 明确错误信息」的组合是 2026 年后量子迁移的标准姿势**:应用代码应该问「这个 JVM 支持吗」,而不是假设支持或假设不支持。

生成测试密钥的命令值得收藏:

```bash
# 1) 创建 ML-DSA-65 私钥 + 证书(JDK 24+ 的 keytool)
keytool -genkeypair -alias test-store -keyalg ML-DSA-65 \
  -keystore server-keystore-mldsa.p12 -storetype PKCS12 \
  -validity 1095 -dname CN=localhost -storepass wibble

# 2) 导出私钥
openssl pkcs12 -in server-keystore-mldsa.p12 -nocerts -nodes -passin pass:wibble -out server-key-mldsa.pem

# 3) 导出证书
openssl pkcs12 -in server-keystore-mldsa.p12 -nokeys -passin pass:wibble -out server-cert-mldsa.pem

# 4) 删除临时 keystore
rm server-keystore-mldsa.p12
```

**注意 ML-DSA 是签名算法,不是密钥交换算法**。TLS 的后量子密钥交换用 `X25519MLKEM768`(ML-KEM),Vert.x 的 `isPqcAvailable()` 探测的也是 ML-KEM 组。**用 ML-DSA 私钥做 TLS 证书签名,配 ML-KEM 组做密钥交换,才是完整的后量子 TLS 链路**。这两件事在 2026 年经常被混为一谈——「后量子证书」可以指签名算法换成 ML-DSA,也可以指密钥交换换成 ML-KEM,两者独立、需要分别配置。

---

## 三、支线:Buffer / JsonObject / JsonArray 与 ClusterSerializable 解耦(PR #6373)

这个 PR 的动机是 API 清洁度,但顺带修了一个真实的深拷贝 bug。

5.1.x 里 `Buffer`、`JsonObject`、`JsonArray` 三个核心数据类型都直接 `implements ClusterSerializable, Shareable`,导致**任何想用这些类型的代码都被迫依赖 `shareddata` 包的接口**。5.2.0 把实现下沉到 Impl 类:

```java
// Buffer.java(接口)
-public interface Buffer extends ClusterSerializable, Shareable {
+public interface Buffer {
// BufferImpl.java(实现)
-public class BufferImpl implements BufferInternal {
+public class BufferImpl implements BufferInternal, ClusterSerializable, Shareable {
```

`JsonObject` / `JsonArray` 更进一步——它们**不再是** `ClusterSerializable`/`Shareable`,序列化方法 `writeToBuffer`/`readFromBuffer` 保留但去掉 `@Override`,变成普通公开方法:

```java
-  @Override
   public void writeToBuffer(Buffer buffer) {
     Buffer buf = toBuffer();
     buffer.appendInt(buf.length());
     buffer.appendBuffer(buf);
   }

-  @Override
   public int readFromBuffer(int pos, Buffer buffer) {
```

但它们仍然需要能放进 `SharedData` 的数据结构,所以 `Checker` 显式开了口子:

```java
    if (!(obj instanceof Serializable || obj instanceof Shareable || obj instanceof ClusterSerializable
          || obj instanceof JsonObject || obj instanceof JsonArray)) {
      throw new IllegalArgumentException("Invalid type for shareddata data structure: " + obj.getClass().getName());
    }
```

**真正的 bug 修复在 `JsonUtil.deepCopy`**:

```java
      val = ((Shareable) val).copy();
    } else if (val instanceof Map) {
      val = (new JsonObject((Map) val)).copy(copier);
+   } else if (val instanceof JsonObject) {
+     val = ((JsonObject)val).copy(copier);
+   } else if (val instanceof JsonArray) {
+     val = ((JsonArray)val).copy(copier);
    } else if (val instanceof List) {
      val = (new JsonArray((List) val)).copy(copier);
```

在 `JsonObject` 解耦之前,`val instanceof JsonObject` 会先命中 `val instanceof Shareable`(因为 JsonObject implements Shareable),走到 `((Shareable) val).copy()`——**那个 `copy()` 不接受 copier 参数,用的是 `DEFAULT_CLONER`**。解耦之后 `JsonObject` 不再是 `Shareable`,如果不加新分支,它会一路掉到后面的类型判断,可能被当成普通对象尝试 Java 序列化。新加的两个分支保证了**无论接口怎么变,深拷贝的行为完全一致**,而且现在明确走带 copier 的路径。

**这个 PR 对第三方库的影响**:`JsonObject` 不再是 `Shareable` 是一个**源不兼容**改动——如果你写过 `if (obj instanceof Shareable)` 然后假定 JsonObject 会命中,行为变了。但运行时兼容性是保留的(Checker 开了口子)。

---

## 四、支线:事件总线消费者追踪策略(PR #6363)

5.2.0 给 `MessageConsumerOptions` 加了 `tracingPolicy`,让**消费者侧**也能控制追踪行为(之前只有生产者侧的 `DeliveryOptions.setTracingPolicy`):

```java
  public static final TracingPolicy DEFAULT_TRACING_POLICY = TracingPolicy.PROPAGATE;
  private TracingPolicy tracingPolicy;
```

```java
      message.trace = tracer.receiveRequest(ctx, SpanKind.RPC, tracingPolicy, message,
        message.isSend() ? "send" : "publish", message.headers(), MessageTagExtractor.INSTANCE);
```

三种策略的语义在文档里写清楚了:

> - `TracingPolicy#PROPAGATE`: propagate an existing trace (default)
> - `TracingPolicy#ALWAYS`: propagate an existing trace or create a new trace when none exists
> - `TracingPolicy#IGNORE`: disable tracing

**为什么消费者侧需要单独的策略**:事件总线的消费者往往是「外部请求的终点 + 内部处理的起点」。一个 trace 从 HTTP 请求进来,经过 event bus 分发到 worker verticle,消费者需要决定是「延续这个 trace」(PROPAGATE,默认)还是「新开一个」(ALWAYS,适合定时触发的消费者)或「不追踪」(IGNORE,适合高频心跳)。**之前只有生产者能选,消费者只能被动接受**,导致跨 verticle 的 span 链路在消费端断裂或产生大量无意义的根 span。

测试里的参数化用例展示了三种策略的期望行为:

```java
    testEventBusySendProducerPolicy(TracingPolicy.PROPAGATE, true, 2);
    testEventBusySendProducerPolicy(TracingPolicy.IGNORE, true, 0);
    testEventBusySendProducerPolicy(TracingPolicy.ALWAYS, false, 2);
```

---

## 五、可运行代码:五个场景的实战配置

### 5.1 场景一:验证事件循环组无锁化的行为差异

```java
import io.vertx.core.Vertx;
import io.vertx.core.VertxOptions;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicLong;

public class EventLoopStress {

  public static void main(String[] args) throws Exception {
    Vertx vertx = Vertx.vertx(new VertxOptions().setEventLoopPoolSize(4));

    // 模拟高并发注册/注销 server handler 的场景
    int rounds = 200_000;
    AtomicLong maxBlockingNanos = new AtomicLong();
    CountDownLatch latch = new CountDownLatch(rounds);

    for (int i = 0; i < rounds; i++) {
      vertx.createNetServer()
        .connectHandler(so -> so.write("ping").onComplete(v -> so.close()))
        .listen(0, "localhost")
        .onComplete(ar -> {
          if (ar.succeeded()) {
            long start = System.nanoTime();
            // 每次都触发一次 next() + 注册/注销路径
            vertx.netClient().connect(ar.result().actualPort(), "localhost");
            long dur = System.nanoTime() - start;
            maxBlockingNanos.accumulateAndGet(dur, Math::max);
            ar.result().close();
          }
          latch.countDown();
        });
    }
    latch.await();
    System.out.println("max next()/register path: " + maxBlockingNanos.get() / 1_000 + " us");
    vertx.close();
  }
}
```

### 5.2 场景二:共享服务器的正确关闭顺序

```java
import io.vertx.core.Vertx;
import io.vertx.core.net.NetServer;
import io.vertx.core.net.NetServerOptions;
import java.util.ArrayList;
import java.util.List;

public class SharedServerShutdown {

  public static void main(String[] args) {
    Vertx vertx = Vertx.vertx();
    List<NetServer> servers = new ArrayList<>();

    // 三个 verticle 共用 8080:Vert.x 内部用 createSharedResource 引用计数
    for (int i = 0; i < 3; i++) {
      NetServer s = vertx.createNetServer(
          new NetServerOptions().setPort(8080).setHost("localhost").setShared(true))
        .connectHandler(so -> so.write("hello from shared\n").onComplete(v -> so.close()));
      servers.add(s);
    }

    // 全部 listen,只有第一个真正 bind
    servers.forEach(s -> s.listen().onComplete(ar -> {
      if (ar.succeeded()) {
        System.out.println("listening on " + ar.result().actualPort());
      } else {
        ar.cause().printStackTrace();
      }
    }));

    // 逐个关闭:前两个 close 不会真正关 socket,最后一个才会
    vertx.setTimer(2000, id -> {
      servers.get(0).close().onComplete(v -> System.out.println("server[0] closed, socket still alive"));
      vertx.setTimer(1000, id2 -> {
        servers.get(1).close().onComplete(v -> System.out.println("server[1] closed, socket still alive"));
        vertx.setTimer(1000, id3 -> {
          servers.get(2).close().onComplete(v -> {
            System.out.println("server[2] closed, socket released");
            vertx.close();
          });
        });
      });
    });
  }
}
```

### 5.3 场景三:HTTP/2 大响应体的流控调优

```java
import io.vertx.core.Vertx;
import io.vertx.core.VertxOptions;
import io.vertx.core.buffer.Buffer;
import io.vertx.core.http.*;
import java.util.concurrent.CountDownLatch;

public class Http2FlowControlTuning {

  public static void main(String[] args) throws Exception {
    Vertx vertx = Vertx.vertx(new VertxOptions().setEventLoopPoolSize(2));

    // 服务端:流窗口 1 MiB(5.2.0 默认),连接窗口 16 MiB(5.2.0 默认)
    HttpServer server = vertx.createHttpServer(
      new HttpServerOptions()
        .setPort(8443)
        .setSsl(true)
        .setUseAlpn(true)
        // 5.2.0: 这两个现在是显式默认值,不写也是这个值
        .setInitialSettings(new Http2Settings().setInitialWindowSize(1024 * 1024))
        .setHttp2ConnectionWindowSize(16 * 1024 * 1024));

    Buffer bigBody = Buffer.buffer(new byte[8 * 1024 * 1024]); // 8 MiB 响应
    server.requestHandler(req -> req.response().end(bigBody));

    CountDownLatch latch = new CountDownLatch(1);
    server.listen().onComplete(ar -> {
      if (ar.failed()) { ar.cause().printStackTrace(); return; }

      // 客户端:把窗口调小,观察背压
      HttpClient client = vertx.httpClientBuilder()
        .with(new HttpClientOptions()
          .setSsl(true)
          .setUseAlpn(true)
          .setProtocolVersion(HttpVersion.HTTP_2)
          .setInitialSettings(new Http2Settings().setInitialWindowSize(256 * 1024))  // 256 KiB per stream
          .setHttp2ConnectionWindowSize(512 * 1024))                                  // 512 KiB per connection
        .build();

      client.request(new RequestOptions().setHost("localhost").setPort(8443).setURI("/"))
        .compose(req -> req.send().compose(resp -> {
          System.out.println("response headers received, status=" + resp.statusCode());
          // 慢消费:pause 让服务端的 16 MiB 窗口逐渐耗尽,触发背压
          resp.pause();
          vertx.setTimer(500, id -> resp.resume());
          return resp.end();
        }))
        .onComplete(v -> {
          System.out.println("body fully received: " + v.result().length() + " bytes");
          latch.countDown();
        });
    });

    latch.await();
    vertx.close();
  }
}
```

### 5.4 场景四:TLS 升级后 sendFile

```java
import io.vertx.core.Vertx;
import io.vertx.core.net.*;
import java.io.File;
import java.nio.file.Files;

public class SendFileAfterTlsUpgrade {

  public static void main(String[] args) throws Exception {
    Vertx vertx = Vertx.vertx();
    File f = File.createTempFile("vertx-sendfile-", ".bin");
    Files.write(f.toPath(), new byte[1024 * 1024]); // 1 MiB

    NetServer server = vertx.createNetServer();
    server.connectHandler(socket ->
      socket.upgradeToSsl(new ServerSSLOptions()
          .setKeyCertOptions(Cert.SERVER_JKS.get()))   // 用官方测试的 JKS
        .onComplete(v -> socket.sendFile(f.getAbsolutePath())));

    server.listen(1234, "localhost").onComplete(ar -> {
      if (ar.failed()) { ar.cause().printStackTrace(); return; }

      NetSocket client = vertx.netClient().connect(new ConnectOptions()
        .setPort(1234)
        .setHost("localhost")
        .setSsl(true)
        .setSslOptions(new ClientSSLOptions()
          .setHostnameVerificationAlgorithm("")
          .setTrustAll(true))).result();

      // 5.1.x:这里会静默丢数据或抛 UnsupportedMessageTypeException
      // 5.2.0:upgrade 时自动补 ChunkedWriteHandler,sendFile 走分块加密
      client.handler(buff -> System.out.println("received " + buff.length() + " bytes"));
    });
  }
}
```

### 5.5 场景五:ML-DSA PEM 私钥 + ML-KEM 密钥交换的完整后量子 TLS

```java
import io.vertx.core.Vertx;
import io.vertx.core.http.HttpServer;
import io.vertx.core.http.HttpServerOptions;
import io.vertx.core.net.*;

public class PostQuantumTls {

  public static void main(String[] args) {
    Vertx vertx = Vertx.vertx();

    // 先探测 JVM 能力:JDK 24+ 才有 ML-KEM 组
    boolean pqcAvailable = JdkSSLEngineOptions.isPqcAvailable();
    System.out.println("JDK PQC key exchange available: " + pqcAvailable);
    if (!pqcAvailable) {
      System.out.println("需要 JDK 24+ 才能启用 X25519MLKEM768");
    }

    HttpServerOptions options = new HttpServerOptions()
      .setPort(8443)
      .setSsl(true)
      // ML-DSA 签名的证书(5.2.0 新支持 PEM 加载)
      .setKeyCertOptions(new PemKeyCertOptions()
        .setKeyPath("server-key-mldsa.pem")
        .setCertPath("server-cert-mldsa.pem"))
      // ML-KEM 混合密钥交换组,优先,但保留经典组做回退
      .setKeyExchangeGroups(java.util.List.of("X25519MLKEM768", "X25519"))
      // 强制策略:只有支持 PQ 的对端才能握手成功
      // .setPqcEnforcementPolicy(...)  // 按你的合规要求选
      .setUseAlpn(true);

    HttpServer server = vertx.createHttpServer(options);
    server.requestHandler(req ->
      req.response().end("post-quantum TLS handshake OK, cipher=" +
        req.sslSession().cipherSuite() + "\n"));

    server.listen().onComplete(ar -> {
      if (ar.succeeded()) {
        System.out.println("listening on https://localhost:" + ar.result().actualPort());
      } else {
        ar.cause().printStackTrace();
      }
    });
  }
}
```

---

## 六、五套方案 17 维度对比

### 6.1 事件循环组分发方案对比

| 维度 | synchronized List (5.1.x) | COW + AtomicReference (5.2.0) | Netty NioEventLoopGroup | Netty MultithreadEventLoopGroup(Default) |
|------|--------|--------|--------|--------|
| 选 event loop 路径 | synchronized 块 | volatile 读 + getAndIncrement | 内置数组 + 自增索引 | 内置数组 + 自增索引 |
| `next()` 是否可阻塞 | **是** | 否 | 否 | 否 |
| 注册 handler 复杂度 | O(n) equals 扫描 | O(n) 复制(每 event loop) | 无此概念 | 无此概念 |
| 注销时是否原子返回「是否清空」 | 否(需额外 volatile 布尔) | **是(CAS 结果)** | 无此概念 | 无此概念 |
| 关闭时遍历子执行器 | 手写 Set(21 方法,5 个抛异常) | 不可变 List 迭代器 | `children()` 返回不可变 Set | `children()` 返回不可变 Set |
| 轮询计数器溢出处理 | `checkPos()` 重置 | `set(1)` 回绕(良性竞争) | 回绕 | 回绕 |
| 关闭中接受新连接的行为 | `hasHandlers() == false` 后仍可能走到 chooseInitializer | **返回 closeForcibly handler** | 注册到关闭中的 group 抛异常 | 同左 |
| 跨 verticle 共享 | 通过 VertxImpl 共享 Map | 通过 VertxEventLoopGroup 单实例 | 不适用 | 不适用 |
| 适用场景 | verticle 数少、连接数低 | **高并发 + 频繁 deploy/undeploy** | Netty 原生 | Netty 原生 |

### 6.2 共享服务器生命周期方案对比

| 维度 | VertxImpl HashMap (5.1.x) | createSharedResource (5.2.0) | K8s Service + 多 Pod | SO_REUSEPORT |
|------|--------|--------|--------|--------|
| 同一 host:port 多实例 | 共享 Map + actualServer 委托 | **CloseableResource 引用计数** | 内核四元组分发 | 内核级端口重用 |
| 关闭正确性 | best-effort + `// THIS CAN BE RACY` | **移除与判断原子化** | Pod 删除即停止 | 内核自动 |
| `actualPort()` | 查 actualServer 可变字段 | 直接读 volatile resource | 由平台分配 | 由内核分配 |
| SSL context 共享 | 通过 actualServer 间接共享 | **QuicDispatcher / TcpServer 显式持有** | 不共享(每 Pod 一份) | 不共享 |
| 失败时资源回收 | 依赖开发者手动清理 | **onFailure(err -> resource.close())** | Pod 失败被重启 | 无此问题 |
| 跨 JVM 实例可见性 | 仅本实例 | 仅本实例 | 集群级 | 集群级 |
| 适用规模 | 单 JVM,verticle 数 < 100 | 单 JVM,verticle 数任意 | 多 Pod | 单 Pod 多线程 |

### 6.3 HTTP/2 接收窗口方案对比

| 维度 | 64K/默认 (5.1.x) | 1MiB+16MiB (5.2.0) | gRPC 默认 64K | 自调 4MiB+64MiB |
|------|--------|--------|--------|--------|
| 100Mbps×100ms 链路利用率 | ~5% | ~80% | ~5% | >100%(可打满) |
| 单流最大在途数据 | 64 KiB | 1 MiB | 64 KiB | 4 MiB |
| 单连接最大在途数据 | Netty 自定 | 16 MiB | Netty 自定 | 64 MiB |
| 慢消费者内存放大 | 1x | 16x | 1x | 64x |
| 1 万连接最坏内存 | ~640 MB | ~160 GB(需限制) | ~640 MB | 需重新预算 |
| 流控帧往返开销 | 高(窗口小,更新频繁) | 低 | 高 | 最低 |
| pause/resume 响应延迟 | 低 | 中 | 低 | 高(已缓冲多) |
| 推荐场景 | 小请求、内存敏感 | **通用默认、gRPC 大消息** | gRPC 兼容性 | 大文件、内网高带宽 |

### 6.4 TLS 升级后 sendFile 方案对比

| 维度 | 5.1.x(缺 ChunkedWriteHandler) | 5.2.0(自动补) | 建连即 TLS | 明文 + 应用层加密 |
|------|--------|--------|--------|--------|
| 明文阶段零拷贝 | 有 | 有 | 不适用 | 无 |
| TLS 升级后 sendFile | **静默丢数据/异常** | **分块加密,正确** | 正确 | 需自己实现 |
| pipeline 复杂度 | 低(但隐含 bug) | 中(多一个 handler) | 中 | 高 |
| 运行时切换能力 | 有(但有 bug) | **有(正确)** | 无 | 有 |
| 适用场景 | 纯明文 | **需要运行时升级 TLS 的长连接** | 常规 HTTPS | 自定义加密协议 |

### 6.5 后量子 TLS 私钥加载方案对比

| 维度 | 5.1.x | 5.2.0(PEM) | JKS/PKCS12 keystore | OpenSSL 原生 |
|------|--------|--------|--------|--------|
| ML-DSA 私钥加载 | **不支持 PEM** | **支持** | 支持(JDK 24+ keytool) | 支持 |
| 不支持时的错误 | 静默 fall through | **明确 VertxException** | KeyStoreException | 明确 |
| 密钥格式 | 仅 RSA/EC PEM | RSA/EC/ML-DSA PEM | 任意 JKS 支持的 | 任意 OpenSSL 支持的 |
| 文件可读性 | 二进制 | **PEM 文本** | 二进制 | 二进制 |
| 跨工具链互换 | 需转换 | **openssl 直接互导** | 需转换 | 原生 |
| 密钥交换探测 | `return false` 硬编码 | **JdkDependent 多版本** | 由 JVM 决定 | 由 OpenSSL 决定 |
| 适用场景 | 传统 RSA/EC | **后量子迁移期混合部署** | 传统企业 Java | 底层运维 |

---

## 七、6 条 6-12 个月可验证硬指标

1. **`VertxEventLoopGroup.next()` 无锁化**:在 32 核机器、4 个 event loop、每秒 5 万新连接的压测下,`next()` 的 P99 耗时应从「synchronized 块的 monitor entry/exit 开销」(微秒级,随核数增长)降到「一次 volatile 读 + 一次 `getAndIncrement`」(纳秒级,与核数无关)。验证方法:JMH 写一个只调 `next()` 的微基准,扫描核数 4/8/16/32 对比 5.1.x 与 5.2.0 的吞吐曲线——5.1.x 应随核数增长而变平,5.2.0 应线性增长。

2. **共享服务器关闭确定性**:部署 10 个共享同一 host:port 的 verticle,随机关闭其中 5 个,然后立刻用新连接压测。5.1.x 在关闭窗口内可能出现「连接被 accept 但 handler 已注销」导致的异常或超时;5.2.0 应要么成功建立(说明还有 handler),要么立刻被 `closeForcibly()` 关闭(TCP RST,客户端立即收到而非超时)。**指标:关闭期间的连接失败模式从「超时」变成「立即拒绝」。**

3. **HTTP/2 吞吐**:同一条 100 Mbps × 100 ms RTT 的链路,传 8 MiB 响应体,5.1.x 默认窗口(64 KiB)下的有效吞吐 vs 5.2.0 默认(1 MiB/16 MiB)。**预期:吞吐提升 10-15 倍,接近链路上限**;同时观察服务端在慢消费者场景下的峰值 RSS,应上升约 16 MiB × 慢连接数。

4. **流控重入测试复现**:把 `testFlowControlReentrancyWithLargeWindows` 的参数(16 请求 × 512 KiB × 1 MiB 窗口)改成更极端的值(64 请求 × 2 MiB × 4 MiB 窗口),在 5.1.x 上跑应能触发 `Http2Exception` 或死锁,在 5.2.0 上应稳定通过。**这是唯一能确认「你的版本确实包含了重入修复」的可运行证据。**

5. **sendFile + TLS 升级数据完整性**:在 5.1.x 上跑 `testSendFileAfterTlsUpgrade`,用 4 KB / 64 KB / 1 MiB / 4 MiB 四种文件大小,记录哪些大小下数据不完整或抛异常;同样测试在 5.2.0 上应全部完整。**指标:成功率从「与文件大小相关的不确定值」变成 100%。**

6. **后量子 TLS 握手**:用 JDK 24+ 生成 ML-DSA-65 证书 + ML-DSA-87 证书各一份,在 5.2.0 上分别配置,用 `openssl s_client -groups X25519MLKEM768` 连接,应看到协商出的组是 `X25519MLKEM768`,证书链是 ML-DSA。**用不支持 ML-KEM 的旧 OpenSSL 连接,应回退到 `X25519` 而非握手失败**(这是混合组的意义)。**用 `JdkSSLEngineOptions.isPqcAvailable()` 在 JDK 21 上应返回 false,JDK 24+ 上应返回 true。**

---

## 八、6 条 6-12 个月可观察未来信号

1. **`sharedTcpServers()` 类的内部全局 Map 模式在 Vert.x 生态里全面退场**。5.2.0 开了头,`createSharedResource` 这个 API 会被用到更多共享对象上(HTTP server pool、 datagram socket、DNS resolver)。**信号:跟进 Vert.x 后续 release,看 `createSharedResource` 的调用点数量是否持续增长。**

2. **HTTP/2 窗口默认值向 BDP 感知方向演进**。当前是静态的 1 MiB/16 MiB,下一步可能是根据连接的 RTT 和带宽动态调整(类似 BBR 对 TCP 拥塞控制的思路)。**信号:看 Netty 的 `Http2FlowController` 是否出现自动调谐的实现,以及 Vert.x 是否暴露 `setInitialWindowSize(Duration rtt, long bandwidth)` 这类 API。**

3. **`ChunkedWriteHandler` 这类「pipeline 结构假设」的修复会以「建连时按 TLS 状态预装全套 handler」的方式彻底解决**。当前是升级时按需补,更干净的做法是建连时就装好 `ChunkedWriteHandler`(明文时它只是 passthrough)。**信号:看 Netty 4.2.x 的 `ChannelInitializer` 是否提供「按后续 handler 需求预装」的机制。**

4. **ML-DSA 之后,ML-KEM 的私钥 PEM 加载会跟上**。当前 Vert.x 只能加载 ML-DSA 签名私钥,ML-KEM 的封装私钥(用于被动模式的混合密钥交换)在 Java 侧还没标准 KeyFactory。**信号:跟踪 JEP 和 JDK 的 `KEM` API(`javax.crypto.KEM`)是否支持 ML-KEM,以及 Vert.x 是否加 `KeyExchangeGroups` 的自动探测。**

5. **事件总线的 `TracingPolicy` 会扩展到 HTTP 客户端和数据库客户端**。当前只有 event bus 生产者/消费者两侧可配,HTTP 请求、SQL 查询、Redis 命令的追踪策略还是全局的。**信号:看 `RequestOptions` / `SQLOptions` 是否出现 `setTracingPolicy`。**

6. **`JsonObject`/`JsonArray` 与 `Shareable` 解耦之后,Vert.x 的核心数据类型会进一步「去 vert.x 化」**。长期方向是让 `Buffer`/`JsonObject`/`JsonArray` 可以脱离 Vert.x runtime 被其他库复用。**信号:看这三个类型是否出现独立的 module / artifact(类似 Netty 把 codec 拆成独立 jar)。**

---

## 九、总结与最佳实践

### ✅ 应该做的

1. **升级到 5.2.0 之后,重新评估 HTTP/2 内存预算**。新的 1 MiB/16 MiB 窗口默认值是吞吐优化,但单连接最坏内存从 ~64 KiB 涨到 ~17 MiB。**按「慢连接数 × 17 MiB」算一遍,如果超出你的容器内存 limit,显式调小 `setHttp2ConnectionWindowSize`。**

2. **用 `JdkSSLEngineOptions.isPqcAvailable()` 做能力探测,不要硬编码后量子开关**。你的代码会同时跑在 JDK 17(LTS,无 PQC)、JDK 21(LTS,无 PQC)、JDK 24+(有 PQC)上,探测比假设可靠。

3. **给关键路径写一个流控重入回归测试**。照抄 `testFlowControlReentrancyWithLargeWindows` 的三要素(大窗口 + pause/resume + 并发),参数换成你业务的真实值。**HTTP/2 流控 bug 不会在功能测试里出现,只在压力下出现。**

4. **迁移掉所有 `((VertxInternal) vertx).sharedTcpServers()` 调用**。这个方法在 5.2.0 已删除,正确的路径是 `server.unwrap()` → `HttpServerInternal` → `tcpServer()`。**不要用反射绕过,那是给未来挖坑。**

5. **TLS 升级 + 大文件传输的组合必须回归测试**。`upgradeToSsl` 之后调 `sendFile`,用至少 4 种文件大小跑一遍。这类 bug 的特征是「某些大小正常、某些大小丢数据」。

### ❌ 千万别做的

1. **不要假设 `next()` 的行为没变就去压测旧基准**。无锁化之后,高并发下的公平性略有变化(轮询计数器的良性竞争),如果你有强依赖「连接严格轮询到 event loop」的测试(很少见,但存在),会偶发失败。

2. **不要在 `removeHandler` 之后还假设 `hasHandlers()` 存在**。5.2.0 删掉了这个方法,`removeHandler` 的返回值就是答案。**把 `balancer.hasHandlers()` 的调用全部改成 `balancer.removeWorker(...)` 的返回值。**

3. **不要把 ML-DSA 证书当成后量子密钥交换**。ML-DSA 是签名算法,ML-KEM 才是密钥交换。**「后量子 TLS」= ML-DSA 证书 + X25519MLKEM768 密钥交换组,缺一个都只是半后量子。**

4. **不要在 `JsonObject` 上用 `instanceof Shareable` 做类型判断**。5.2.0 之后这个判断不再命中 JsonObject。**用 `instanceof JsonObject` / `instanceof JsonArray` 显式判断。**

5. **不要忽视 `// THIS CAN BE RACY` 这类注释**。Vert.x 删掉这句注释的方法是把判断变成原子操作的返回值——**这是「这类竞争如何被真正修复」的模板:不是加更好的锁,而是让产生判断的那个操作本身就是原子的。**

### 5 步生产升级 checklist

1. **跑全量回归测试,重点 HTTP/2 + 共享服务器 + sendFile**。`Http2Test`、`NetTest`、`MetricsTest` 在 5.2.0 都有改动(`MetricsTest` 里 `vertx.close()` 后的生命周期断言从 `await()` 改成 `assertWaitUntil`,说明关闭时序变了)。

2. **全局搜索并替换被删/改的内部 API**:`sharedTcpServers()`、`hasHandlers()`、`EventLoopHolder`、`addWorker(EventLoop)`、`removeWorker(EventLoop)`。

3. **评估 HTTP/2 窗口内存预算**,按「慢连接数 × 17 MiB」算,超限就显式调小。

4. **JDK 版本对齐**:要用后量子 TLS 就升到 JDK 24+;留在 JDK 21 及以下,`isPqcAvailable()` 会返回 false,代码自动走经典组,但** ML-DSA PEM 加载会因为 `KeyFactory.getInstance("ML-DSA")` 抛 `NoSuchAlgorithmException` 而得到明确错误**——这是设计上的正确行为,不是 bug。

5. **灰度顺序**:先升级只读边缘服务(静态文件、健康检查),再升级有 HTTP/2 大响应体的服务,最后升级用共享服务器 + 频繁 deploy/undeploy 的服务。**无锁化的收益在 deploy/undeploy 高频的场景最大,但那也是行为差异最容易暴露的场景。**

### 5 条 best practice

1. **事件循环上的所有共享状态,优先考虑「不可变快照 + AtomicReference」而不是并发集合**。读路径无锁的价值远大于写路径的复制成本,因为读路径的调用频率通常是写路径的几个数量级。

2. **当发现「为了性能缓存了一个 volatile 布尔」时,先问「这个布尔能不能变成不可变对象的状态字段」**。`hasHandlers` 的消失是这个思路的完美示范:不是优化缓存,是消除缓存的需求。

3. **pipeline 的结构假设必须在所有「改变连接性质」的操作里同步更新**。`upgradeToSsl` 改变了零拷贝的可用性,就必须同时调整 pipeline。**凡是提供「运行时改变传输语义」API 的库,都有这类义务。**

4. **新算法/新协议的支持,错误信息要显式区分「JVM 不支持」和「输入格式错」**。`NoSuchAlgorithmException` → `VertxException("ML-DSA algorithm is not supported by this JVM")` 的翻译,把一个「看不出原因的泛化异常」变成了「能指导升级 JDK 的具体建议」。

5. **关闭路径的正确性靠「状态机 + 原子返回值」,不靠 best-effort 检查**。`closing` 状态 + `removeHandler` 返回 `!next.closing` 的组合,把「移除」和「判断」合并成一个原子操作,是所有需要「最后一个引用负责销毁」场景的通用模式。

---

## 写在最后

Vert.x 5.2.0 是一个**纯粹的工程卫生版本**:没有新协议、没有新 API 大特性、没有性能数字宣传。它做的事情是把事件循环上最后几处「synchronized + 可变集合 + volatile 缓存布尔」的结构,全部换成不可变快照 + CAS。

这个版本之所以值得专门写一篇,是因为它展示了一个 2026 年的基础设施项目在做技术债清理时的**优先级判断**:在高并发事件驱动框架里,「分发层的数据结构」是所有流量的必经之路。Vert.x 团队没有选择加新功能,而是先把这条路修成无锁的——因为**在事件循环上,每一次锁竞争都是从「每秒万级连接」里扣税,而且这个税是隐性的:它不报错、不崩溃,只让你的 P99 随核数增长而劣化**。

同时它也留下一个明确的信号:`// THIS CAN BE RACY` 这句注释在代码库里存在了多久,就说明这个竞争被「知道但没修」了多久。而修复的方式不是更好的锁,是**让「产生判断」和「做出判断」变成同一个原子操作**——`removeHandler` 返回 `!next.closing`,一个 CAS 同时完成两件事。这是无锁设计里最优雅、也最容易被忽略的模式:**不要去同步两个状态,要让两个状态本来就是同一个状态。**

至于 HTTP/2 流控默认值的改动,它是这个版本里唯一有明确性能含义的改动,而且方向是**吞吐优先、内存显式化**:从「Netty 实现说了算」变成「Vert.x 明确声明 1 MiB / 16 MiB,并在 Javadoc 里写清楚这是吞吐换内存」。**把隐式默认变成显式默认,并在文档里承认代价——这本身就是一个基础设施项目成熟的标志。**

(数据来源:Eclipse Vert.x 5.2.0 release notes 与源码,PR #6366 / #6367 / #6240 / #6360 / #6361 / #6365 / #6347 / #6373 / #6363 的完整 patch,以及 `vertx-core` 仓库 2026 年 9 月的 commit 历史。所有引用的代码均来自这些 PR 的实际 diff。)
