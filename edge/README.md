# u-router edge — 边缘节点

Express + better-sqlite3。负责文件托管、HMAC 签名下载、分钟级统计、健康上报。可水平部署多台，每台独立存储。

## 启动

```bash
cp .env.example .env    # 重点设置 TOKEN_SECRET（与总控注册时的 token_secret 一致）
npm install
npm start
```

## API

`/api/health` 始终开放（总控探活用）；设置 `EDGE_API_KEY` 后其余 `/api/*` 需携带 `x-api-key`（总控拉统计时也会带）。下载走签名 token，不需要 key。

### 上传文件

```bash
# multipart（推荐）
curl -F "file=@software.zip" http://127.0.0.1:7100/api/files

# 或裸流
curl -X POST --data-binary @software.zip \
  "http://127.0.0.1:7100/api/files?filename=software.zip"
```

```json
{
  "file_id": "f_ab12cd34ef56",
  "filename": "software.zip",
  "size": 1048576,
  "sha256": "5780cc…",
  "download_url": "http://localhost:7100/d/eyJ….D0-f…",
  "expire": "2026-09-09T09:00:00Z"
}
```

边写边算 sha256，超 `MAX_UPLOAD_BYTES`（默认 10GB）会中断并清理半成品。`file_id` 需要回填到总控的文件映射里。

### 下载

```http
GET /d/:token
```

- token = `base64url({f, exp})` + `.` + HMAC-SHA256 签名，过期返回 410、篡改 403
- 支持 `Range`（206 断点续传 / 416 非法区间）、`HEAD`
- 不暴露真实存储路径；文件名通过 `Content-Disposition` 返回

### 管理 / 统计 / 拉取

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/files?limit=1000` | 本地文件列表（limit 1~10000） |
| DELETE | `/api/files/:fileId` | 删除（含磁盘文件） |
| GET | `/api/stats?since=<ISO 或分钟数>` | 分钟统计桶（请求时先 flush 内存计数） |
| GET | `/api/health` | 磁盘/负载/内存/文件数（总控探活） |
| POST | `/api/pulls` | 创建后台拉取任务（总控分发编排用），返回 202 + pull_id |
| GET | `/api/pulls` / `/api/pulls/:id` | 拉取任务列表 / 状态（bytes_downloaded 进度） |

`POST /api/pulls` 请求体：

```json
{ "source_url": "https://edge-a.example.com/d/<token>", "filename": "app.pkg",
  "expected_sha256": "…", "expected_size": 20971520 }
```

拉取在后台执行：断线用 Range 从偏移量续传（续传前把已下载字节喂回哈希）；完成后 sha256/大小校验，通过才注册进 files 表并回报 file_id，失败自动重试（默认 3 次）后标记 failed 且不留残留文件。进程重启会自动恢复未完成任务。

**拉取安全默认值**：拒绝私网/回环/链路本地源（含域名解析到私网）、不跟随重定向；每次尝试有整体超时（`PULL_TIMEOUT_MS`，默认 30 分钟）、单任务字节上限（`PULL_MAX_BYTES`，默认 10GB，含 Content-Length 预检）和并发槽位（`PULL_MAX_CONCURRENT`，默认 2，超出的排队）。Edge 之间走**内网**分发需显式 `PULL_ALLOW_PRIVATE_NET=true`。

`EDGE_API_KEY` 未设置时上传/删除/统计/拉取接口完全开放（启动时有醒目警告），生产环境必须设置。上传中断（客户端断开）会自动清理半成品文件；multipart 请求限制字段数量与大小。

`/api/stats` 返回：

```json
{
  "edge_id": "edge-01",
  "since": "2026-09-08T09:30:00.000Z",
  "rows": [
    { "minute": "2026-09-08T09:34:00.000Z", "file_id": "f_ab12…", "requests": 823,
      "downloads_started": 800, "downloads_completed": 780, "bytes_sent": 34800000000,
      "s2xx": 800, "s4xx": 20, "s5xx": 3 }
  ]
}
```

统计实现：内存计数器 → 每秒 flush 到 SQLite 分钟桶（`ON CONFLICT DO UPDATE` 累加），总控每分钟拉取。每次下载不产生任何对总控的请求。计数规则：校验失败记 4xx、成功请求记 2xx（HEAD 只记请求不记 `downloads_started`，Range 非法返回 416 时不会同时计入成功）。

## 生产部署（前置反向代理）

### Caddy（推荐）

```caddyfile
dl.example.com {
    reverse_proxy 127.0.0.1:7100
}
```

就这么简单：Caddy 的 `reverse_proxy` 对请求和响应都是**流式透传**（不缓冲整个 body），大文件上传、下载、断点续传开箱即用；默认不限制请求体大小；HTTPS 证书自动签发。保持 `ENABLE_X_ACCEL=false`（X-Accel-Redirect 是 Nginx 专属机制，Caddy 没有对应物，由 Node 流式发送即可，Range/206 完整支持）。

Edge 监听端口已禁用 Node 默认的 5 分钟请求超时（`server.requestTimeout = 0`），慢速大上传不会被掐断。

### Nginx（可选，X-Accel 模式）

```ini
# edge .env
ENABLE_X_ACCEL=true
X_ACCEL_PREFIX=/internal
```

```nginx
location / {
    proxy_pass http://127.0.0.1:7100;
    proxy_request_buffering off;   # 上传流式透传，不在 Nginx 侧落盘缓冲
    client_max_body_size 0;        # 不限制上传大小
}

location /internal/ {
    internal;                              # 只允许内部重定向
    alias /srv/u-router/edge/data/files/;  # 与 STORAGE_DIR 对应
}
```

此模式下 Node 只做验签和计数（`X-Accel-Redirect` 交给 Nginx 发送）；`bytes_sent` / `downloads_completed` 无法精确统计，以 `downloads_started` 为准。直连/Caddy 模式所有指标精确。

## 存储

- 文件：`STORAGE_DIR`（默认 `./data/files`），文件名即 file_id，无扩展名依赖
- 统计：`DB_PATH`（默认 `./data/edge.db`，SQLite WAL 模式）

## 测试

```bash
npm test   # token 签名/验签、分钟桶累加与查询
```
