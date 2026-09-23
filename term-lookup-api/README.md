# Term Lookup API

一个轻量的专业名词多语言查询服务。每条术语必须包含简体中文
(`zh-Hans`) 和英文 (`en`)，其余语言使用 BCP 47 标签扩展，例如
`zh-Hant`、`ja`、`ko`。

## 本地运行

需要 Node.js 25 或更高版本。复制配置并替换 API Key：

```sh
cp .env.example .env
npm test
npm start
```

服务默认监听 `http://127.0.0.1:4444`，SQLite 数据库默认位于
`data/terms.sqlite`。如需由反向代理以外的主机直接访问，可在 `.env` 设置
`HOST=0.0.0.0`；请同时用防火墙限制 4444 端口。

## API

除健康检查外，所有接口都需要传 `X-API-Key`，也支持
`Authorization: Bearer <API_KEY>`。

```sh
curl -X POST http://127.0.0.1:4444/v1/terms \
  -H 'X-API-Key: your-api-key' \
  -H 'Content-Type: application/json' \
  --data '{
    "translations": {
      "en": "container orchestration",
      "zh-Hans": "容器编排",
      "zh-Hant": "容器編排",
      "ja": "コンテナオーケストレーション"
    }
  }'

curl 'http://127.0.0.1:4444/v1/terms?q=container%20orchestration&from=en&to=zh-Hans' \
  -H 'X-API-Key: your-api-key'

curl http://127.0.0.1:4444/health
```

`POST /v1/terms` 首次创建返回 `201`；相同英文术语（忽略大小写与全半角）
再次提交会更新整条翻译记录并返回 `200`。`GET /v1/terms` 使用精确匹配；若
源术语存在但目标语言暂未维护，响应中的 `translation` 为 `null`。为使查询结果
唯一，同一语言下规范化后相同的术语文本不能属于两个不同术语，冲突会返回 `409`。
英文主键采用 NFKC、首尾空白清理和英文小写化；并未实现完整 Unicode case folding。

## 词条层级

每个词条可选关联一个上级词条。先创建上级词条，再将其 `id` 作为子词条的
`parentId`：

```json
{
  "parentId": 1,
  "translations": {
    "en": "Raiden Shogun",
    "zh-Hans": "雷电将军"
  }
}
```

创建与查询响应都会包含 `parentId`，并在存在上级时返回
`parent: { id, translations }`。父词条必须存在；自关联或任何循环层级返回 `400`
（`parent_cycle`）。更新请求中省略 `parentId` 或传 `null` 会把词条设为顶级词条。
当前 API 不提供删除父词条的接口，因此不会生成孤儿子词条。

## PM2 部署

在服务器上将 `.env` 放在本目录，并设置强随机 `API_KEY`。随后运行：

```sh
pm2 start ecosystem.config.cjs
pm2 save
```

PM2 配置固定单进程 fork 模式，并默认使用端口 `4444`；密钥只从 `.env` 或
部署环境变量读取，不写入 `ecosystem.config.cjs`。
