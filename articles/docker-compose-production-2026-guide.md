---
title: "Docker Compose 生产环境实战指南（2026）"
date: 2026-05-18
category: 技术
tags: [Docker, DevOps, 容器化, 部署, 运维, Docker Compose]
author: 林小白
readtime: 14
cover: https://images.unsplash.com/photo-1605745341112-85968b19335b?w=600&h=400&fit=crop
---

# Docker Compose 生产环境实战指南（2026）

Docker Compose 长期以来被视为"开发环境工具"，但在 2026 年，越来越多的团队发现：对于中小规模的 Web 应用，Docker Compose 配合少量运维脚本，完全可以胜任生产环境部署。最近 Hacker News 上一篇《Should I run plain Docker Compose in production in 2026?》引发了 413 分、298 条评论的热烈讨论。

本文将从实际运维角度出发，系统梳理 Docker Compose 在生产环境中的关键配置、常见陷阱和最佳实践。

## 为什么选择 Docker Compose？

在讨论"怎么做"之前，先回答"为什么"：

**适合的场景**：
- 单机或少量服务器的 Web 应用（个人项目、创业公司 MVP）
- 团队规模小，没有专职 SRE
- 服务数量在 5-15 个容器以内
- 不需要自动扩缩容和跨节点调度

**不适合的场景**：
- 需要多节点集群调度 → 用 Kubernetes
- 需要自动扩缩容 → 用 Kubernetes 或 Nomad
- 需要复杂的金丝雀发布 → 用 Kubernetes + Istio

正如 HN 用户 `nickjj` 所说："Docker Compose 在 2015 年就已可用于生产环境，今天依然如此。我用它部署过的项目数不胜数，包括价值 5 亿美元的公司。"

## 基础架构：生产级 compose.yaml

以下是一个生产就绪的 `compose.yaml` 模板：

```yaml
services:
  app:
    image: myapp:1.2.3  # 镜像标签必须固定版本
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"  # 只绑定 localhost
    environment:
      - DATABASE_URL_FILE=/run/secrets/db_url
    secrets:
      - db_url
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    deploy:
      resources:
        limits:
          cpus: '2.0'
          memory: 1G
        reservations:
          memory: 256M
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"
    networks:
      - backend

  db:
    image: postgres:17.4
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      - POSTGRES_PASSWORD_FILE=/run/secrets/db_password
    secrets:
      - db_password
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - backend

  redis:
    image: redis:7.4-alpine
    restart: unless-stopped
    command: redis-server --maxmemory 256mb --maxmemory-policy allkeys-lru
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 3
    networks:
      - backend

volumes:
  pgdata:
    driver: local

secrets:
  db_url:
    file: ./secrets/db_url.txt
  db_password:
    file: ./secrets/db_password.txt

networks:
  backend:
    driver: bridge
```

这个模板涵盖了生产环境的所有核心要素。下面逐一拆解每个关键配置。

## 关键配置详解

### 1. 镜像标签：永远不要用 `latest`

```yaml
# ❌ 危险：下次部署可能拉到不兼容的版本
image: myapp:latest

# ✅ 安全：锁定具体版本
image: myapp:1.2.3

# ✅ 也可以用 SHA256 摘要（最精确）
image: myapp@sha256:a1b2c3d4...
```

`latest` 标签的隐患在于：两次部署之间，基础镜像可能发生不兼容变更。用具体版本号或 SHA256 摘要可以确保可重现的部署。

### 2. 重启策略：`unless-stopped` vs `always`

```yaml
# unless-stopped：容器崩溃自动重启，但手动 docker compose stop 后不会重启
restart: unless-stopped

# always：包括手动停止后也会在 docker daemon 重启时拉起
restart: always
```

**推荐 `unless-stopped`**：它在大多数场景下行为更可预期。`always` 会在你不希望的时候（如调试期间 docker daemon 重启）自动拉起服务。

### 3. 端口绑定：不要暴露到公网

```yaml
# ❌ 暴露到所有网络接口
ports:
  - "8080:8080"

# ✅ 只绑定 localhost，由 Nginx/Caddy 反向代理
ports:
  - "127.0.0.1:8080:8080"
```

HN 用户 `__jonas` 特别提醒："端口发布的工作方式（忽略防火墙）仍然会让不了解的人踩坑。"Docker 直接操作 iptables/nftables，绑定 `0.0.0.0` 的端口会绕过你的防火墙规则。

### 4. 健康检查：自动化运维的基石

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
  interval: 30s      # 每 30 秒检查一次
  timeout: 10s       # 超时时间
  retries: 3         # 连续 3 次失败标记为 unhealthy
  start_period: 40s  # 启动宽限期
```

健康检查是自动化恢复的前提。没有健康检查，Docker 无法知道你的应用是否真的在工作——进程还在运行不代表服务可用。

**自定义健康端点**的最佳实践：

```python
# FastAPI 示例
@app.get("/health")
async def health():
    checks = {}
    try:
        await database.execute("SELECT 1")
        checks["database"] = "ok"
    except Exception:
        checks["database"] = "error"
        raise HTTPException(503, "Database unhealthy")
    
    try:
        await redis.ping()
        checks["redis"] = "ok"
    except Exception:
        checks["redis"] = "error"
        raise HTTPException(503, "Redis unhealthy")
    
    return {"status": "healthy", "checks": checks}
```

### 5. 资源限制：防止一个容器拖垮整台机器

```yaml
deploy:
  resources:
    limits:
      cpus: '2.0'
      memory: 1G
    reservations:
      memory: 256M
```

**没有资源限制的后果**：一个内存泄漏的容器可以吃掉所有可用内存，触发 OOM Killer 杀掉其他容器甚至关键系统进程。在单机生产环境中，这可能导致整台服务器不可用。

### 6. 日志管理：防止磁盘被撑爆

```yaml
logging:
  driver: json-file
  options:
    max-size: "10m"   # 单个日志文件最大 10MB
    max-file: "3"     # 最多保留 3 个文件（总共 30MB）
```

Docker 默认的 `json-file` 日志驱动没有大小限制。一个高频输出的容器可以在几天内吃掉几十 GB 磁盘空间。这是生产环境中最常见的"静默故障"之一。

### 7. Secrets：不要把密码写在 compose 文件里

```yaml
secrets:
  db_password:
    file: ./secrets/db_password.txt

services:
  db:
    environment:
      - POSTGRES_PASSWORD_FILE=/run/secrets/db_password
    secrets:
      - db_password
```

Compose secrets 以文件形式挂载到容器的 `/run/secrets/` 目录。这比环境变量更安全——环境变量可以通过 `docker inspect` 明文查看，而 secrets 文件只有容器内的进程可以读取。

### 8. 网络隔离：最小权限原则

```yaml
networks:
  frontend:
    driver: bridge
  backend:
    driver: bridge

services:
  nginx:
    networks:
      - frontend
      - backend  # 需要同时访问前端和后端
  app:
    networks:
      - backend  # 不需要暴露到前端网络
  db:
    networks:
      - backend  # 只在后端网络
```

将不需要互相通信的服务放在不同网络中，即使容器被攻破，攻击者也无法直接访问数据库。

## 运维脚本：补齐 Compose 的短板

Docker Compose 的设计哲学是"声明式编排"，不包含自动恢复、滚动更新等运维功能。我们需要用脚本补齐这些短板。

### 部署脚本

```bash
#!/bin/bash
set -euo pipefail

COMPOSE_FILE="compose.yaml"
SERVICE="app"
NEW_IMAGE="myapp:1.2.4"

echo "=== 开始部署 ${SERVICE} ==="

# 1. 拉取新镜像
echo "[1/4] 拉取镜像 ${NEW_IMAGE}..."
docker compose -f ${COMPOSE_FILE} pull ${SERVICE}

# 2. 健康检查等待函数
wait_healthy() {
    local container=$1
    local max_wait=120
    local waited=0
    
    echo "[等待] ${container} 变为 healthy..."
    while [ $waited -lt $max_wait ]; do
        local health=$(docker inspect --format='{{.State.Health.Status}}' $container 2>/dev/null || echo "missing")
        if [ "$health" = "healthy" ]; then
            echo "[OK] ${container} 已就绪"
            return 0
        fi
        sleep 5
        waited=$((waited + 5))
        echo "  ...等待 ${waited}s (状态: ${health})"
    done
    
    echo "[FAIL] ${container} 在 ${max_wait}s 内未变为 healthy"
    return 1
}

# 3. 滚动更新
echo "[2/4] 停止旧容器..."
docker compose -f ${COMPOSE_FILE} up -d --no-deps --force-recreate ${SERVICE}

# 4. 等待健康检查通过
echo "[3/4] 等待服务就绪..."
CONTAINER=$(docker compose -f ${COMPOSE_FILE} ps -q ${SERVICE})
if ! wait_healthy ${CONTAINER}; then
    echo "[ROLLBACK] 服务不健康，回滚..."
    docker compose -f ${COMPOSE_FILE} logs --tail=50 ${SERVICE}
    exit 1
fi

# 5. 清理旧镜像
echo "[4/4] 清理悬空镜像..."
docker image prune -f

echo "=== 部署完成 ==="
```

### 定期健康监控

```bash
#!/bin/bash
# 放入 crontab: */5 * * * * /opt/scripts/compose-healthcheck.sh

COMPOSE_FILE="/opt/myapp/compose.yaml"
ALERT_WEBHOOK="https://hooks.slack.com/services/xxx"

check_services() {
    local unhealthy=""
    
    for service in $(docker compose -f ${COMPOSE_FILE} config --services); do
        local container=$(docker compose -f ${COMPOSE_FILE} ps -q ${service} 2>/dev/null)
        if [ -z "$container" ]; then
            unhealthy="${unhealthy} ${service}(missing)"
            continue
        fi
        
        local status=$(docker inspect --format='{{.State.Status}}' $container)
        local health=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' $container)
        
        if [ "$status" != "running" ] || [ "$health" = "unhealthy" ]; then
            unhealthy="${unhealthy} ${service}(${status}/${health})"
        fi
    done
    
    if [ -n "$unhealthy" ]; then
        curl -s -X POST ${ALERT_WEBHOOK} \
            -H 'Content-Type: application/json' \
            -d "{\"text\": \"⚠️ Docker 服务异常:${unhealthy}\"}"
        
        # 尝试自动恢复
        docker compose -f ${COMPOSE_FILE} up -d
    fi
}

check_services
```

### 日志轮转备份

```bash
#!/bin/bash
# 每天凌晨 3 点执行
# crontab: 0 3 * * * /opt/scripts/log-rotate.sh

BACKUP_DIR="/var/backups/docker-logs"
DATE=$(date +%Y%m%d)

for container in $(docker ps --format '{{.Names}}'); do
    docker logs ${container} > ${BACKUP_DIR}/${container}-${DATE}.log 2>&1
done

# 保留最近 7 天的日志
find ${BACKUP_DIR} -name "*.log" -mtime +7 -delete
```

## 数据持久化与备份

### Volume 管理

```yaml
volumes:
  pgdata:
    driver: local
    driver_opts:
      type: none
      o: bind
      device: /data/postgres  # 明确指定宿主机路径
```

**重要**：不要使用 Docker 的默认 volume 路径（`/var/lib/docker/volumes/`）。当 Docker 需要重新安装或迁移时，默认路径的数据可能丢失。明确指定宿主机路径，方便备份和迁移。

### 数据库备份脚本

```bash
#!/bin/bash
# PostgreSQL 备份
BACKUP_DIR="/var/backups/postgres"
DATE=$(date +%Y%m%d_%H%M%S)
CONTAINER="myapp-db-1"

docker exec ${CONTAINER} pg_dumpall -U postgres | gzip > ${BACKUP_DIR}/pg_${DATE}.sql.gz

# 保留最近 30 天的备份
find ${BACKUP_DIR} -name "pg_*.sql.gz" -mtime +30 -delete

echo "备份完成: pg_${DATE}.sql.gz ($(du -h ${BACKUP_DIR}/pg_${DATE}.sql.gz | cut -f1))"
```

## 安全加固

### 1. 只读文件系统

```yaml
services:
  app:
    read_only: true
    tmpfs:
      - /tmp
      - /var/run
```

将容器的文件系统设为只读，防止攻击者写入恶意文件。需要写入的目录用 `tmpfs` 挂载。

### 2. 非 root 用户

```dockerfile
# Dockerfile
FROM node:22-alpine
RUN addgroup -g 1001 app && adduser -u 1001 -G app -s /bin/sh -D app
USER app
```

### 3. Docker Socket 安全

HN 讨论中多位用户提到 Docker socket 的安全问题。如果容器需要访问 Docker API（如 Portainer），务必：

```yaml
# ❌ 危险：直接挂载 socket
volumes:
  - /var/run/docker.sock:/var/run/docker.sock

# ✅ 更安全：使用 Docker Socket Proxy
services:
  docker-socket-proxy:
    image: tecnativa/docker-socket-proxy
    environment:
      CONTAINERS: 1
      IMAGES: 1
      INFO: 0  # 禁用不需要的 API
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
```

### 4. 防火墙注意事项

HN 用户 `merpkz` 提到了一个常见痛点：Docker 会直接操作 iptables/nftables，重启防火墙规则可能导致容器网络中断。解决方案：

```bash
# 在 nftables 中添加 Docker 链的持久化规则
# 或者使用 DOCKER-USER 链控制入站流量
iptables -I DOCKER-USER -i eth0 -j DROP
iptables -I DOCKER-USER -i eth0 -p tcp --dport 443 -j ACCEPT
```

## 何时该升级到 Kubernetes？

Docker Compose 不是万能的。当你遇到以下信号时，说明该考虑迁移了：

| 信号 | 说明 |
|------|------|
| 需要跨节点调度 | 一台机器不够，需要多台服务器协同 |
| 流量波动大 | 需要自动扩缩容（HPA） |
| 服务数量超过 20 | Compose 文件变得难以维护 |
| 需要复杂的发布策略 | 金丝雀发布、蓝绿部署、A/B 测试 |
| 团队有专职 SRE | 有人专门维护 Kubernetes 集群 |

HN 用户 `Havoc` 提供了一个优雅的过渡思路："我很喜欢用 Compose 开发，因为它轻量，但如果需要迁移到 K8s，这个转换过程的摩擦力非常小。"

迁移路径：Compose → `kompose convert` → Kubernetes manifests → Helm Chart。

## 总结

Docker Compose 在 2026 年依然是中小规模生产环境的可靠选择。关键在于补齐它的运维短板：

1. **健康检查**：所有服务必须配置，这是自动恢复的前提
2. **资源限制**：防止单个容器拖垮整台机器
3. **日志轮转**：防止磁盘空间被无声耗尽
4. **镜像版本锁定**：确保部署的可重现性
5. **安全加固**：网络隔离、只读文件系统、非 root 用户
6. **备份策略**：数据卷定期备份，日志定期归档

不需要 Kubernetes 也能跑好生产环境——关键是把基础设施当作代码来管理，把运维流程自动化。当你的项目增长到需要 Kubernetes 时，这些经验同样适用，因为核心原则是一样的。

---

*相关阅读：*

- [mimalloc：微软的高性能内存分配器深入解析](/article/mimalloc-memory-allocator-deep-dive-2026)
- [WebAssembly 边缘沙箱：用 WASIX 运行 Python 和 Node.js](/article/wasm-edge-sandbox-python-nodejs-2026)
