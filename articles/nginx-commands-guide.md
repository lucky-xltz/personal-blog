---
title: "Nginx 常用命令大全：从入门到精通"
date: 2026-04-13
category: 技术
tags: Nginx, 服务器, 运维, Web服务器, 命令行
author: 林小白
readtime: 12
cover: https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=600&h=400&fit=crop
---

# Nginx 常用命令大全：从入门到精通

Nginx 是一个高性能的 HTTP 和反向代理服务器，也是 IMAP/POP3/SMTP 代理服务器。本文整理了 Nginx 的常用命令，帮助您快速管理和配置 Nginx 服务。

## 1. 服务管理命令

### 1.1 启动 Nginx

```bash
# 基本启动
sudo nginx

# 指定配置文件启动
sudo nginx -c /etc/nginx/nginx.conf

# 指定配置目录启动
sudo nginx -p /etc/nginx/

# 检查配置文件语法
sudo nginx -t

# 检查配置文件语法并显示完整配置
sudo nginx -T
```

### 1.2 停止 Nginx

```bash
# 快速停止（立即停止）
sudo nginx -s stop

# 优雅停止（等待请求处理完成）
sudo nginx -s quit

# 使用 systemctl 停止
sudo systemctl stop nginx

# 使用 kill 命令停止
sudo kill -QUIT $(cat /var/run/nginx.pid)
```

### 1.3 重启 Nginx

```bash
# 重新加载配置（不中断服务）
sudo nginx -s reload

# 使用 systemctl 重启
sudo systemctl restart nginx

# 优雅重启（等待当前请求完成）
sudo kill -HUP $(cat /var/run/nginx.pid)
```

### 1.4 查看 Nginx 状态

```bash
# 查看 Nginx 进程
ps aux | grep nginx

# 查看 Nginx 版本
nginx -v

# 查看详细版本信息
nginx -V

# 查看配置文件路径
nginx -t

# 查看编译参数
nginx -V 2>&1 | grep "configure arguments"

# 使用 systemctl 查看状态
sudo systemctl status nginx

# 查看 Nginx 是否在运行
sudo systemctl is-active nginx
```

## 2. 配置文件管理

### 2.1 配置文件结构

```nginx
# 主配置文件位置
/etc/nginx/nginx.conf

# 站点配置目录
/etc/nginx/sites-available/
/etc/nginx/sites-enabled/

# 配置片段目录
/etc/nginx/conf.d/
/etc/nginx/snippets/
```

### 2.2 配置文件语法检查

```bash
# 检查主配置文件
sudo nginx -t

# 检查指定配置文件
sudo nginx -t -c /path/to/nginx.conf

# 检查并显示完整配置
sudo nginx -T

# 检查配置文件语法错误
sudo nginx -t 2>&1 | grep "error"
```

### 2.3 配置文件备份与恢复

```bash
# 备份配置文件
sudo cp /etc/nginx/nginx.conf /etc/nginx/nginx.conf.backup

# 备份整个配置目录
sudo tar -czvf nginx-config-backup.tar.gz /etc/nginx/

# 恢复配置文件
sudo cp /etc/nginx/nginx.conf.backup /etc/nginx/nginx.conf

# 恢复整个配置目录
sudo tar -xzvf nginx-config-backup.tar.gz -C /
```

## 3. 虚拟主机管理

### 3.1 创建虚拟主机

```bash
# 创建站点配置文件
sudo nano /etc/nginx/sites-available/example.com

# 创建软链接启用站点
sudo ln -s /etc/nginx/sites-available/example.com /etc/nginx/sites-enabled/

# 创建站点目录
sudo mkdir -p /var/www/example.com/html

# 设置目录权限
sudo chown -R www-data:www-data /var/www/example.com
sudo chmod -R 755 /var/www/example.com
```

### 3.2 虚拟主机配置示例

```nginx
# /etc/nginx/sites-available/example.com
server {
    listen 80;
    listen [::]:80;
    
    server_name example.com www.example.com;
    root /var/www/example.com/html;
    index index.html index.htm index.nginx-debian.html;
    
    location / {
        try_files $uri $uri/ =404;
    }
    
    # 静态文件缓存
    location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
    
    # 日志配置
    access_log /var/log/nginx/example.com.access.log;
    error_log /var/log/nginx/example.com.error.log;
}
```

### 3.3 启用和禁用站点

```bash
# 启用站点
sudo ln -s /etc/nginx/sites-available/example.com /etc/nginx/sites-enabled/

# 禁用站点
sudo rm /etc/nginx/sites-enabled/example.com

# 列出所有可用站点
ls -la /etc/nginx/sites-available/

# 列出所有启用站点
ls -la /etc/nginx/sites-enabled/
```

## 4. SSL/TLS 配置

### 4.1 Let's Encrypt SSL 证书

```bash
# 安装 Certbot
sudo apt install certbot python3-certbot-nginx

# 获取 SSL 证书
sudo certbot --nginx -d example.com -d www.example.com

# 自动续订证书
sudo certbot renew --dry-run

# 查看证书信息
sudo certbot certificates

# 撤销证书
sudo certbot revoke --cert-name example.com
```

### 4.2 SSL 配置示例

```nginx
# /etc/nginx/sites-available/example.com
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    
    server_name example.com www.example.com;
    
    # SSL 证书配置
    ssl_certificate /etc/letsencrypt/live/example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;
    
    # SSL 安全配置
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES256-GCM-SHA512:DHE-RSA-AES256-GCM-SHA512;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    
    # HSTS（HTTP Strict Transport Security）
    add_header Strict-Transport-Security "max-age=31536000" always;
    
    # OCSP Stapling
    ssl_stapling on;
    ssl_stapling_verify on;
    resolver 8.8.8.8 8.8.4.4 valid=300s;
    resolver_timeout 5s;
    
    # 其他配置...
}

# HTTP 重定向到 HTTPS
server {
    listen 80;
    listen [::]:80;
    
    server_name example.com www.example.com;
    
    return 301 https://$server_name$request_uri;
}
```

## 5. 性能优化

### 5.1 基础优化配置

```nginx
# /etc/nginx/nginx.conf
user www-data;
worker_processes auto;
pid /run/nginx.pid;

events {
    worker_connections 1024;
    multi_accept on;
    use epoll;
}

http {
    # 基础设置
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    server_tokens off;
    
    # 缓冲区设置
    client_body_buffer_size 128k;
    client_max_body_size 10m;
    client_header_buffer_size 1k;
    large_client_header_buffers 4 4k;
    output_buffers 1 32k;
    postpone_output 1460;
    
    # 超时设置
    client_header_timeout 3m;
    client_body_timeout 3m;
    send_timeout 3m;
    reset_timedout_connection on;
    
    # Gzip 压缩
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;
    
    # 文件缓存
    open_file_cache max=1000 inactive=20s;
    open_file_cache_valid 30s;
    open_file_cache_min_uses 2;
    open_file_cache_errors on;
    
    # 其他配置...
}
```

### 5.2 静态文件优化

```nginx
# 静态文件缓存配置
location ~* \.(jpg|jpeg|png|gif|ico|css|js|pdf|txt)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
    access_log off;
    log_not_found off;
}

# 字体文件配置
location ~* \.(woff|woff2|ttf|otf|eot)$ {
    expires 1y;
    add_header Cache-Control "public";
    add_header Access-Control-Allow-Origin "*";
}

# 图片优化
location ~* \.(jpg|jpeg|png|gif)$ {
    expires 1y;
    add_header Cache-Control "public";
    try_files $uri $uri/ /index.html;
}
```

## 6. 反向代理配置

### 6.1 基础反向代理

```nginx
# 反向代理到本地应用
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
}

# 反向代理到远程服务器
location /api/ {
    proxy_pass https://api.example.com/;
    proxy_ssl_verify off;
    proxy_set_header Host api.example.com;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### 6.2 WebSocket 代理

```nginx
# WebSocket 代理配置
location /ws/ {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 86400;
}
```

## 7. 负载均衡

### 7.1 负载均衡配置

```nginx
# 定义上游服务器组
upstream backend {
    # 轮询（默认）
    server backend1.example.com;
    server backend2.example.com;
    server backend3.example.com;
    
    # 加权轮询
    server backend1.example.com weight=3;
    server backend2.example.com weight=2;
    server backend3.example.com weight=1;
    
    # IP Hash（会话保持）
    ip_hash;
    
    # 最少连接
    least_conn;
    
    # 健康检查
    server backend1.example.com max_fails=3 fail_timeout=30s;
    server backend2.example.com max_fails=3 fail_timeout=30s;
}

# 使用负载均衡
location / {
    proxy_pass http://backend;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## 8. 安全配置

### 8.1 基础安全配置

```nginx
# 隐藏版本号
server_tokens off;

# 限制请求方法
if ($request_method !~ ^(GET|HEAD|POST)$) {
    return 444;
}

# 限制请求大小
client_max_body_size 10m;

# 防止点击劫持
add_header X-Frame-Options "SAMEORIGIN" always;

# 防止 MIME 类型嗅探
add_header X-Content-Type-Options "nosniff" always;

# 启用 XSS 保护
add_header X-XSS-Protection "1; mode=block" always;

# 内容安全策略
add_header Content-Security-Policy "default-src 'self' http: https: data: blob: 'unsafe-inline'" always;
```

### 8.2 访问控制

```nginx
# 限制访问 IP
allow 192.168.1.0/24;
allow 10.0.0.0/8;
deny all;

# 限制访问特定目录
location /admin/ {
    allow 192.168.1.0/24;
    deny all;
    
    auth_basic "Restricted Access";
    auth_basic_user_file /etc/nginx/.htpasswd;
}

# 限制访问频率
limit_req_zone $binary_remote_addr zone=one:10m rate=1r/s;

location /api/ {
    limit_req zone=one burst=5 nodelay;
}
```

## 9. 日志管理

### 9.1 日志配置

```nginx
# 自定义日志格式
log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                '$status $body_bytes_sent "$http_referer" '
                '"$http_user_agent" "$http_x_forwarded_for"';

# 访问日志
access_log /var/log/nginx/access.log main;

# 错误日志
error_log /var/log/nginx/error.log warn;

# 禁用日志
access_log off;

# 条件日志
map $status $loggable {
    ~^[23]  0;
    default 1;
}

access_log /var/log/nginx/access.log main if=$loggable;
```

### 9.2 日志轮转

```bash
# 创建日志轮转配置
sudo nano /etc/logrotate.d/nginx

# 配置内容
/var/log/nginx/*.log {
    daily
    missingok
    rotate 52
    compress
    delaycompress
    notifempty
    create 640 nginx adm
    sharedscripts
    postrotate
        if [ -f /var/run/nginx.pid ]; then
            kill -USR1 `cat /var/run/nginx.pid`
        fi
    endscript
}

# 手动执行日志轮转
sudo logrotate -f /etc/logrotate.d/nginx
```

## 10. 故障排查

### 10.1 常见问题解决

```bash
# 检查配置文件语法
sudo nginx -t

# 查看错误日志
sudo tail -f /var/log/nginx/error.log

# 查看访问日志
sudo tail -f /var/log/nginx/access.log

# 检查端口占用
sudo netstat -tulpn | grep nginx

# 检查进程状态
sudo ps aux | grep nginx

# 检查磁盘空间
df -h

# 检查内存使用
free -h

# 检查文件权限
ls -la /etc/nginx/
ls -la /var/www/
```

### 10.2 性能监控

```bash
# 实时监控 Nginx 状态
sudo apt install nginx-module-njs
sudo nginx -T | grep "stub_status"

# 配置状态页面
location /nginx_status {
    stub_status on;
    allow 127.0.0.1;
    deny all;
}

# 监控工具
sudo apt install atop htop iotop

# 查看连接数
sudo netstat -an | grep :80 | wc -l

# 查看并发连接
sudo netstat -n | grep :80 | wc -l
```

## 11. 实用脚本

### 11.1 自动化脚本

```bash
#!/bin/bash
# nginx-manager.sh - Nginx 管理脚本

case "$1" in
    start)
        sudo nginx
        echo "Nginx started"
        ;;
    stop)
        sudo nginx -s stop
        echo "Nginx stopped"
        ;;
    reload)
        sudo nginx -s reload
        echo "Nginx reloaded"
        ;;
    restart)
        sudo nginx -s stop
        sleep 1
        sudo nginx
        echo "Nginx restarted"
        ;;
    status)
        sudo systemctl status nginx
        ;;
    test)
        sudo nginx -t
        ;;
    logs)
        sudo tail -f /var/log/nginx/error.log
        ;;
    *)
        echo "Usage: $0 {start|stop|reload|restart|status|test|logs}"
        exit 1
        ;;
esac
```

### 11.2 批量配置脚本

```bash
#!/bin/bash
# batch-ssl.sh - 批量配置 SSL

domains=(
    "example1.com"
    "example2.com"
    "example3.com"
)

for domain in "${domains[@]}"; do
    echo "Configuring SSL for $domain..."
    sudo certbot --nginx -d "$domain" -d "www.$domain" --non-interactive --agree-tos
    echo "SSL configured for $domain"
done

echo "All domains configured!"
```

## 总结

Nginx 是一个功能强大的 Web 服务器，掌握这些常用命令可以帮助您：

1. **高效管理**：快速启动、停止、重启服务
2. **灵活配置**：轻松配置虚拟主机和 SSL
3. **性能优化**：提升网站访问速度
4. **安全保障**：增强服务器安全性
5. **故障排查**：快速定位和解决问题

记住：好的运维工具应该让工作更简单，而不是更复杂。

---

*相关阅读：*

- [Linux 常用命令大全](/article/linux-commands)
- [Docker 容器化部署指南](/article/docker-deployment)
- [Web 性能优化最佳实践](/article/web-performance)
