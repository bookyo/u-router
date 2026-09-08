# u-router master — 总控（Control Plane）

Express + Mongoose（MongoDB）。负责 Edge 注册、文件链接池、加权分发、主动/被动健康检测、统计汇总。

## 启动

```bash
cp .env.example .env    # 按需修改
npm install
npm start               # 或 npm run dev（文件变更自动重启）
```

> macOS 注意：AirPlay Receiver 默认占用 5000/7000 端口，`PORT=7000` 起不来时请换端口或关闭 AirPlay。

## 数据模型（MongoDB）

| 集合 | 说明 |
| --- | --- |
| `edges` | Edge 节点：base_url、权重、状态、token_secret、探活计数与最近载荷 |
| `files` | 下载项：download_id + `edges[]`（edge_id ↔ edge 本地 file_id 映射、权重、paused） |
| `dispatchlogs` | 总控分配量分钟桶（内存聚合，每 5s 批量 `$inc` 落库） |
| `edgemetrics` | Edge 上报的分钟统计桶（拉取时 `$set` 覆盖，幂等） |

## API

所有 `/api/*` 在设置 `MASTER_API_KEY` 后需携带 `x-api-key` 请求头。`/api/v1/health` 例外（给监控用）。

**安全基线**：生产环境务必设置 `MASTER_API_KEY`，并建议开启 `LINKS_RATE_LIMIT_PER_MIN`（分发接口每 IP 限流）——不设限流时，恶意刷 links 接口会虚增分配量、把 delivery_ratio 压到阈值以下，导致被动健康引擎误摘所有 Edge。未设置 KEY 时启动日志会给出醒目警告。`NODE_ENV=production` 时 500 错误不再回传内部细节。

### 分发（核心）

```http
GET /api/v1/downloads/:downloadId/links?count=10&ttl=86400
```

```json
{
  "download_id": "software",
  "filename": "software.zip",
  "count": 10,
  "links": [
    { "url": "https://us1.example.com/d/eyJ…", "edge_id": "edge-us-01", "file_id": "f_ab12…", "expire": "2026-09-09T09:00:00Z" }
  ]
}
```

- 加权随机挑选：`文件边权重 × Edge权重 × 状态倍率`（healthy 1 / degraded 0.2 / 其它 0）
- `count` 1~50（默认 1），`ttl` 60s~7d（默认 1 天）
- 无可用节点返回 503；每次分发计入分配量

### Edges

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/edges` | 注册（`base_url` 必填；`token_secret` 不传自动生成并在本响应返回一次；注册后立即首次探活） |
| GET | `/api/v1/edges` | 列表（**不含密钥字段**；含 5m/1h/24h 三窗口 delivery 数据） |
| GET | `/api/v1/edges/:edgeId` | 详情（不含密钥） |
| PATCH | `/api/v1/edges/:edgeId` | 更新 weight/base_url/api_key/token_secret/enabled/status（响应不含密钥） |
| POST | `/api/v1/edges/:edgeId/probe` | 手动触发一次探活 |
| DELETE | `/api/v1/edges/:edgeId` | 删除（同步清理文件映射与被动引擎残留） |

> 密钥（`token_secret`/`api_key`）只在创建响应中返回一次；需要核对时请查数据库或轮换。

### Files

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/files` | 创建下载项（`edges[]` 必填，会校验 edge_id 已注册） |
| GET | `/api/v1/files` | 列表（附带各 edge 实时状态） |
| GET | `/api/v1/files/:downloadId` | 详情 |
| PATCH | `/api/v1/files/:downloadId` | 更新（`edges` 传数组则整组替换） |
| POST | `/api/v1/files/:downloadId/edges` | 追加一条 Edge 映射 |
| DELETE | `/api/v1/files/:downloadId/edges/:edgeId` | 移除一条映射 |
| DELETE | `/api/v1/files/:downloadId` | 删除 |

### 文件分发（PULL 模式，大文件铺开）

上传一台 Edge 后，一键把文件铺到其它 Edge——总控只下发指令和签名 URL，**文件字节直接在 Edge 之间传输**（走 `/d/:token`，天然支持 Range 断点续传），完成后 sha256 校验并自动登记映射：

```bash
curl -X POST $M/api/v1/files/software/distribute \
  -H 'content-type: application/json' \
  -d '{"targets": ["edge-jp-01", "edge-eu-01"], "source_edge_id": "edge-us-01"}'
```

- `source_edge_id` 可省略（默认用首个映射）；sha256/size 不传时自动从源 Edge 发现
- 目标列表轮询：`GET /api/v1/distributions/:taskId`；失败目标可 `POST …/retry {"edge_ids":[…]}`
- 每个目标 Edge 内部重试 3 次（含断点续传），总控层面再重试 3 轮；已有映射的目标自动 skipped

### 指标

```http
GET /api/v1/metrics/edges?window=5m      # 各 edge：dispatch / requests / ratio / 探活延迟
GET /api/v1/metrics/files/:downloadId    # 单个下载项各 edge 的交付明细
```

`window` 可选 `5m`（默认）/`1h`/`24h`。

## 后台引擎

| 引擎 | 默认频率 | 逻辑 |
| --- | --- | --- |
| 主动探活 | 15s | `GET {base_url}/api/health`；连续 3 次失败 → unhealthy，10 次 → offline；恢复需连续 3 次成功 → 先进 degraded。计数用 `$inc` 原子更新，并发探活（循环/手动 probe/注册首探）不丢数 |
| 被动比率 | 30s | `delivery_ratio = edge 请求 / 总控分配`（5m 窗口，分配量 ≥30 才判定）；<0.7 摘除、<0.9 降级、连续 2 轮 ≥0.9 才恢复 healthy |
| 统计拉取 | 60s | 从该 Edge 已存的最后一个分钟桶续拉（幂等覆盖）。总控重启/停机不丢统计；offline 的 Edge 跳过拉取 |
| 分发编排 | 10s | 跟进 PULL 分发任务：派发拉取指令（签名源 URL）→ 跟进度 → 完成自动登记 File.edges，失败重试至上限 |

两个引擎共同作用：进程挂了由探活发现；进程活着但下载全失败（磁盘满、带宽打满、文件损坏）由比率发现。恢复路径带滞后，避免抖动。

## 测试

```bash
npm test   # 调度分布 / token 签名与篡改 / 健康状态机全部迁移路径
```
