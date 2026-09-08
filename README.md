# u-router — 多节点下载分发系统（Download Traffic Director）

总控（Control Plane）负责 **链接池 + 加权调度 + 健康检测**，Edge 节点负责 **文件托管 + 签名下载 + 分钟级统计**，再通过"分配量 vs 实际请求量"的偏差（delivery_ratio）反推 Edge 健康状态。

```text
                          ┌────────────────────────┐
                          │   master/  总控        │
                          │   Express + Mongoose   │
Client/API ──────────────▶│  Download Dispatcher   │  GET /api/v1/downloads/:id/links?count=10
                          │  Edge Registry         │  Edge 注册 / 权重 / 状态
                          │  Weighted Scheduler    │  加权随机分发（非严格轮询）
                          │  Health Engine         │  主动探活 + 被动比率，带滞后
                          │  Metrics Aggregator    │  每分钟拉取 Edge 统计
                          └───────────┬────────────┘
                                      │  探活 / 拉统计 / 签发 token
             ┌────────────────────────┼────────────────────────┐
             ▼                        ▼                        ▼
      ┌─────────────┐          ┌─────────────┐          ┌─────────────┐
      │  edge/ 节点  │          │  edge/ 节点  │          │  edge/ 节点  │
      │ Express     │          │             │          │             │
      │ SQLite 统计  │          │  …          │          │  …          │
      │ 文件存储     │          │             │          │             │
      │ /d/:token   │◀─ 用户下载链接（HMAC 签名、带过期、支持 Range）
      └─────────────┘          └─────────────┘          └─────────────┘
```

## 核心机制

| 机制 | 说明 |
| --- | --- |
| 加权随机分发 | 文件边权重 × Edge 权重 × 状态倍率（healthy 100%、degraded 20%、其余 0%） |
| 双层统计 | 总控记 `dispatch_count`（分配量，内存聚合每 5s 落库）；Edge 记实际 `requests/bytes/2xx…`（SQLite 分钟桶，每秒 flush） |
| delivery_ratio | `edge 成功响应数(s2xx) / 总控分配`，失败请求与系统统计桶不计入分子；5m/1h/24h 多窗口；≥0.9 健康、0.7~0.9 降级、<0.7 摘除 |
| 主动探活 | 每 15s `GET {edge}/api/health`（磁盘/负载/版本），连续 3 次失败摘除、10 次标 offline；状态迁移为绑定探活计数版本的 CAS |
| 滞后恢复（hysteresis） | 恢复先入 degraded 观察期小流量验证，需连续 3 次探活成功 + 连续 2 轮比率良好才回 healthy，避免反复抖动 |
| 签名下载链接 | `GET /d/<token>`，HMAC-SHA256 + 过期时间，不暴露真实文件路径 |
| PULL 文件分发 | 上传一台 Edge 后一键铺开：总控只编排（指令+签名 URL），Edge 之间直拉（Range 断点续传 + sha256 校验），完成自动登记映射，总控永不中转文件字节 |
| 状态迁移 | 主动/被动引擎的状态写入均为 CAS（旧状态不匹配即放弃），不会覆盖并发摘除或人工 maintenance |
| 统计保留 | 分配量与 Edge 统计分钟桶 TTL 30 天（可 `collMod` 调整），长期运行库不膨胀 |
| 拉取安全 | 私网/回环源默认拒绝、不跟随重定向、整体超时 + 字节上限 + 并发排队、断点续传、重启自动恢复 |
| 前置反代 | Caddy：`reverse_proxy` 流式透传零配置；Nginx：可选 `X-Accel-Redirect` 交由反代发文件 |

## 快速开始

前置：Node ≥ 20、MongoDB（本机 27017 即可）。

```bash
# 1. 启动一个 Edge（终端 1）
cd edge
cp .env.example .env          # 本机/内网演示需 PULL_ALLOW_PRIVATE_NET=true（见下）
npm install
npm start                     # 默认 :7100

# 2. 启动总控（终端 2）
cd master
cp .env.example .env          # 本机/内网演示需 MASTER_ALLOW_PRIVATE_EDGE_URL=true（见下）
npm install
npm start                     # 默认 :7000（macOS 注意：AirPlay 占用 5000/7000，请改 PORT）
```

> **安全默认**：Edge 的 PULL 源与总控注册的 Edge `base_url` 默认只允许**公网**地址（含 IPv4-mapped IPv6 检测、连接时 DNS 校验），防止 SSRF 探测内网与云元数据。本机/内网部署显式设置：edge 侧 `PULL_ALLOW_PRIVATE_NET=true`，master 侧 `MASTER_ALLOW_PRIVATE_EDGE_URL=true`。

## 完整使用流程

```bash
M=http://127.0.0.1:7000        # 总控
E=http://127.0.0.1:7100        # Edge

# ① 上传文件到 Edge（multipart 或裸流），拿到 edge 本地 file_id
UP=$(curl -s -F "file=@software.zip" $E/api/files)
# => {"file_id":"f_ab12…","download_url":"http://…/d/eyJ…","sha256":"…"}

# ② 在总控注册 Edge（token_secret 必须与该 Edge 的 TOKEN_SECRET 一致，注册后立即首次探活）
curl -s -X POST $M/api/v1/edges -H 'content-type: application/json' -d '{
  "edge_id": "edge-us-01",
  "base_url": "https://us1.example.com",
  "token_secret": "<edge 的 TOKEN_SECRET>",
  "weight": 100
}'

# ③ 创建下载项：把 Edge 上的文件注册成 download_id
curl -s -X POST $M/api/v1/files -H 'content-type: application/json' -d '{
  "download_id": "software",
  "filename": "software.zip",
  "size": 1048576,
  "edges": [
    {"edge_id": "edge-us-01", "edge_file_id": "f_ab12…", "weight": 100}
  ]
}'

# ③' （可选）大文件铺开：PULL 模式分发到其它 Edge
#     总控只下发指令+签名 URL，文件字节直接在 Edge 之间传输（Range 断点续传），
#     完成后 sha256 校验并自动登记映射
curl -s -X POST $M/api/v1/files/software/distribute -H 'content-type: application/json' \
  -d '{"targets": ["edge-jp-01", "edge-eu-01"]}'
curl -s $M/api/v1/distributions/<task_id>     # 轮询进度

# ④ 业务方取链接（加权随机，count 上限 50，ttl 秒数可覆盖默认有效期）
curl -s "$M/api/v1/downloads/software/links?count=10"
# => {"links":[{"url":"https://us1.example.com/d/eyJ…","edge_id":"edge-us-01","expire":"…"}]}

# ⑤ 观察健康与交付比率
curl -s "$M/api/v1/metrics/edges?window=5m"
curl -s "$M/api/v1/metrics/files/software"
```

## 故障摘除与恢复（自动）

```text
连续探活失败 3 次 ────────▶ unhealthy（权重 0，摘除）
连续探活失败 10 次 ───────▶ offline
delivery_ratio < 0.7 ─────▶ unhealthy
delivery_ratio 0.7~0.9 ───▶ degraded（权重降至 20%）
恢复：探活连续成功 3 次 + 比率连续 2 轮 ≥ 0.9 ──▶ degraded 观察期 ──▶ healthy
```

窗口内分配量不足（默认 5 分钟 < 30 次）时不做比率判定——凌晨没流量不能说明节点坏了。

## 目录结构

```text
master/   总控：Express + Mongoose（MongoDB）
edge/     节点：Express + better-sqlite3，可水平部署多台
```

两个服务的详细 API、配置项、部署注意事项见各自 README。

## 测试

```bash
cd master && npm test    # 76 个用例：调度、token、健康状态机/计数绑定 CAS/并发、指标聚合
                         # （s2xx 分子、系统桶排除）、校验（含 base_url SSRF）、限流、游标、
                         # recorder 真实 Mongo 部分失败、配置清洗、密钥遮蔽、分发全链路
                         # （幂等键、stale 先查远端、queued 不续期）——连真实 MongoDB 与 Edge 进程
cd edge   && npm test    # 27 个用例：token、分钟桶、HTTP 集成（500 统计回归、上传中断/超限
                         # 清理）、Edge 互拉（哈希校验、SSRF 含 mapped-IPv6、字节上限、并发
                         # 排队、幂等键、重启恢复）
```
