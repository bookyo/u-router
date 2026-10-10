# 多类型多语言词条 API

支持术语、人物、角色、作品、地点、组织、物品和自定义类型。词条包括多语言名称及别名、摘要、详细描述、Markdown 富文本、封面、来源、父级、完整祖先路径、标签和分类。

服务端 API 使用 Node.js >=25、SQLite 和单进程 PM2；默认监听 `127.0.0.1:4444`。本模块提供内容存储与安全 HTML 输出，不包含前端编辑器或文件上传。封面与来源使用 URL 引用，服务不会下载或抓取这些 URL。

## 运行

```sh
cd term-lookup-api
npm ci
cp .env.example .env
# 替换 .env 中 API_KEY 为随机密钥
npm test
npm start
```

数据库默认 `data/terms.sqlite`。可以用 `DATABASE_PATH`、`HOST`、`PORT` 配置；通过反向代理公开服务时保留默认回环监听。PM2：`pm2 start ecosystem.config.cjs`，随后 `pm2 save`。

搜索与读取（GET）可不带 API Key：同一 IP 在滚动 60 秒内最多 20 次，所有 v1/v2 读取接口共享额度。有效 `X-API-Key: <key>` 或 `Authorization: Bearer <key>` 的读取请求不限流，也不消耗匿名额度。提供错误 Key 返回 401。

创建、修改、删除（POST/PATCH/DELETE）始终要求有效 Key。`GET /health` 不需要 Key，也不限流。服务仍需要配置 API_KEY，用于写入鉴权和读取免限流。下文 `API_KEY` 指部署密钥，命令在模块目录运行。

匿名响应包含 `RateLimit-Limit: 20` 和 `RateLimit-Remaining`；超限返回 `429 {"error":"rate_limited"}`，`Retry-After` 表示需等待的秒数。失败的匿名读取请求也计入额度。当前限流在单进程内存中维护，重启会重置；PM2 配置保持单实例。

默认按真实连接 IP 计数，不信任 `X-Forwarded-For` 或 `X-Real-IP`。使用反向代理时，在 `.env` 显式设置代理的连接 IP，例如同机代理 `TRUST_PROXY_IPS=127.0.0.1,::1`；代理应设置/追加真实客户端地址到 X-Forwarded-For。服务从右向左跳过可信代理，取首个非可信 IP，避免客户端伪造最左侧地址。未配置时代理下的请求会共享代理 IP 的额度；非法代理 IP 配置拒绝启动。

## v2 词条模型

完整可执行请求体见 [docs/examples/character.json](docs/examples/character.json)。

```json
{
  "type": "character",
  "translations": {
    "en": ["Raiden Shogun", "Ei"],
    "zh-Hans": ["雷电将军", "雷电影"],
    "ja": ["雷電将軍"]
  },
  "details": {
    "zh-Hans": {
      "summary": "角色简介",
      "description": "用于纯文本展示的详细描述。",
      "body": "## 介绍\n\n**加粗**、列表、表格、链接及代码块。",
      "format": "markdown"
    }
  },
  "cover": {"url": "https://example.com/cover.jpg", "alt": {"zh-Hans": "角色封面"}},
  "sources": [{"url": "https://example.com/source", "title": "资料来源", "language": "zh-Hans"}],
  "parentId": null,
  "tagIds": [],
  "categoryIds": []
}
```

| 字段 | 含义 |
| --- | --- |
| `type` | 类型 slug，默认 `term`，必须是已存在类型 |
| `translations` | 语言标签 → 名称数组；英文 `en` 和简中 `zh-Hans` 必须存在 |
| `details` | 语言标签 → `summary`、`description`、`body`、`format`；各字段可省略 |
| `cover` | 图片 URL 与可选多语言 alt；默认 null |
| `sources` | 来源数组，每条包含 URL、title 和可选 language |
| `parentId` | 直接父词条 ID，null 为根词条，允许跨类型归属 |
| `tagIds` / `categoryIds` | 已存在标签/分类 ID 列表，去重，默认空数组 |

名称数组第一项是首选展示名，其余是别名/同义词，均可检索。语言标签按 BCP 47 格式规范化，例如 `EN` → `en`、`zh-hans` → `zh-Hans`。同一字段不接受规范化后重复的语言键。

检索对名称执行 NFKC、首尾空白清理与现有英文小写化规则；保存名称保留大小写。未实现完整 Unicode case folding 或模糊搜索。不同词条可以同名；同一词条同语言内不能有规范化后重复名称。

详情响应还包含 `id`、`createdAt`、`updatedAt`、`tags`、`categories`、`parent`、`ancestors`。祖先数组按根到直接父级排序，不包含当前词条。父级/祖先摘要包含 `id`、`type`、`translations`、`parentId`；顶级词条 `parent: null`、`ancestors: []`。

## 创建、查询和更新

```sh
curl -sS http://127.0.0.1:4444/v2/terms \
  -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' \
  --data @docs/examples/character.json

# 任意别名精确检索；返回候选列表与目标语言名称数组
curl -sS 'http://127.0.0.1:4444/v2/terms?q=Ei&from=en&to=zh-Hans&type=character' \
  -H "X-API-Key: $API_KEY"

# 完整详情（将 1 替换成创建响应中的 id）
curl -sS http://127.0.0.1:4444/v2/terms/1 -H "X-API-Key: $API_KEY"

# 只改摘要；其它语言、正文、名称与父级均保留
curl -sS -X PATCH http://127.0.0.1:4444/v2/terms/1 \
  -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' \
  --data '{"details":{"zh-Hans":{"summary":"新的摘要"}}}'

# 追加别名；同一词条的同名请求幂等
curl -sS http://127.0.0.1:4444/v2/terms/1/names \
  -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' \
  --data '{"language":"en","value":"Raiden Ei"}'
```

`POST /v2/terms` 仅创建，返回 201；名称相同也不会覆盖其它词条。`PATCH` 返回 200，省略字段保持不变：

- `details` 按语言合并，各语言内按字段合并；语言值设 null 删除该语言内容，字段设空字符串清空该字段。
- `parentId: null` 脱离父级；`cover: null` 清除封面。
- 提供 `translations` 替换完整名称集合，必须包含 en 和 zh-Hans；旧检索索引同步移除。
- 提供 `sources`、`tagIds`、`categoryIds` 替换对应完整集合，空数组清空。

所有写入都是事务：引用不存在、循环、校验失败或存储异常时不会部分修改。父词条必须存在；自关联或多级循环返回 `400 parent_cycle`。

## 接口一览

| 接口 | 说明 |
| --- | --- |
| `POST /v2/terms` | 创建词条 |
| `GET /v2/terms` | 分页列表、精确检索与组合筛选 |
| `GET /v2/terms/:id` | 完整详情 |
| `PATCH /v2/terms/:id` | 部分更新 |
| `DELETE /v2/terms/:id` | 删除；有子词条时返回 409 |
| `POST /v2/terms/:id/names` | 追加别名：`{language,value}` |
| `DELETE /v2/terms/:id/names` | 用相同 JSON 形状删除名称；必填语言最后一个名称不能删除 |
| `GET /v2/terms/:id/children` | 直接子词条分页，支持筛选，不允许再传 parentId |
| `GET /v2/terms/:id/ancestors` | `{items:[...]}` 完整祖先路径 |
| `GET /v2/terms/:id/content?language=zh-Hans` | 原始内容及安全 HTML，语言未维护返回 404 |
| `GET/POST /v2/types` | 列出/创建类型 |
| `GET/PATCH/DELETE /v2/types/:id` | 类型详情/修改/删除 |
| `GET/POST /v2/tags` | 列出/创建标签 |
| `GET/PATCH/DELETE /v2/tags/:id` | 标签详情/修改/删除 |
| `GET/POST /v2/categories` | 列出/创建分类 |
| `GET/PATCH/DELETE /v2/categories/:id` | 分类详情/修改/删除 |

列表返回 `{items,total,limit,offset}`，按 ID 升序，默认 `limit=20&offset=0`，limit 最大 100。词条列表和 children 只返回内容摘要，不返回详细描述或正文。

词条列表支持 `q + from`（必须一起传）、可选 `to`、`type`、`parentId`、`tagId`、`categoryId`，筛选条件按 AND 组合。`parentId=null` 筛选顶级词条。没有目标语言时 `translation: null`；有目标语言时是完整名称数组。没有 q 时可以列出全部词条。

所有 taxonomy 列表支持 limit/offset，分类额外支持 parentId（含 null）。未知或重复查询参数、非法 ID 与分页数值返回 400。

## 类型、标签和分类

三者用稳定 ID 关联、唯一 slug 和多语言名称。taxonomy 的 translations 是单字符串映射（展示名称），词条的 translations 才是名称数组。

```sh
curl -sS http://127.0.0.1:4444/v2/types \
  -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' \
  --data '{"slug":"skill","translations":{"en":"Skill","zh-Hans":"技能"}}'

curl -sS http://127.0.0.1:4444/v2/tags \
  -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' \
  --data '{"slug":"electro","translations":{"en":"Electro","zh-Hans":"雷元素"}}'

curl -sS http://127.0.0.1:4444/v2/categories \
  -H "X-API-Key: $API_KEY" -H 'Content-Type: application/json' \
  --data '{"slug":"games","parentId":null,"translations":{"en":"Games","zh-Hans":"游戏"}}'
```

内置类型：`term`、`person`、`character`、`work`、`place`、`organization`、`item`。默认 `term` 不能删除或更改 slug；可以修改多语言展示名。其它类型被词条引用时禁止删除。更新其它类型 slug 不改变 ID，词条读取随之返回新 slug。

标签没有层级；删除标签自动解除词条关联。分类支持单父级和循环检测，响应包含 parentId/ancestors。存在子分类或词条引用时禁止删除分类，需要先迁移引用。词条父级表示内容归属，分类层级表示主题组织，两者相互独立。

## 富文本

`details.<language>.body` 保存 Markdown 源文；format 仅支持 `markdown`，可以省略。内容接口返回 `{id,language,summary?,description?,body?,format,html}`。

HTML 支持标题、强调、列表、引用、表格、代码、链接与图片。原始 HTML 被转义，解析结果再做白名单清洗。仅允许 HTTP/HTTPS 绝对链接和图片 URL，禁止 javascript/data/file、协议相对地址和可执行事件属性。summary/description 是纯文本，前端应按文本展示；body 源文不应直接当 HTML 注入页面。

渲染依赖：[markdown-it](https://github.com/markdown-it/markdown-it)、[sanitize-html](https://github.com/apostrophecms/sanitize-html)。

## 兼容 v1 与数据库升级

原有接口仍可使用：

```text
POST /v1/terms                       {translations:{en:"...","zh-Hans":"..."},parentId?:number|null}
GET  /v1/terms?q=...&from=en&to=zh-Hans
GET  /health
```

v1 输出每个语言的首选名字符串（包含父级摘要），也能用别名查询。多词条同名时返回 `409 ambiguous_term`，不再随意取第一条。v1 创建仍保证各语言名称不与其它词条冲突；upsert 仅能更新唯一匹配且类型为 term 的词条。不会覆盖 v2 的正文、封面、来源、标签或分类，并保留已有别名与未传入语言。通过别名更新时，旧首选名称保留为别名。

v1 的 parentId 省略或 null 仍清空父级；内容管理请使用 v2 PATCH。v1 的单字符串契约没有改成数组。

启动时事务迁移旧 schema v0–v4 到 v5：保留 ID、时间戳和父级，将旧单字符串名称转成单元素数组。历史版本允许的长名称和特殊语言标签会保留，大小写语言键合并为别名；不能按新写入限制将这些历史数据判为损坏。仍可用 v1 查询历史语言标签，添加合法别名或删除历史长名称时不要求先清理整条数据。v2 整体替换 translations 时执行新规则。

迁移遇到损坏 JSON、非字符串/空名称、孤儿父级或循环会失败并回滚；未来未知 schema 版本拒绝启动。老旧 v0/v1 数据库中的歧义翻译仍会被拒绝。迁移前建议备份数据库，运行中的数据库应使用 SQLite backup 工具生成一致备份；升级后回退旧代码需要恢复迁移前的备份。

## 限制与错误

- v1 请求最多 64 KiB；v2 请求与合并后词条可写内容最多 2 MiB。
- 每语言正文按 UTF-8 最多 512 KiB；摘要最多 2,000 字符，详细描述最多 20,000 字符。
- v2 新写入：每语言 1–50 个名称，每名称最多 256 字符；每个语言映射最多 50 个语言。历史名称与 v1 保留原有规则及请求体上限。
- 每词条最多 100 个来源、100 个标签、100 个分类；URL 最多 2,048 字符。
- slug 为 1–64 个小写字母、数字或连字符，以字母/数字开头。

错误是 JSON：`{error:"code",message?:"..."}`。400 为校验/引用/循环问题，401 为鉴权失败，404 为词条/名称/内容不存在，409 为歧义/slug 冲突/删除约束，413 为大小超限，429 为匿名读取限流，500 为存储异常。存储错误不返回 SQL、数据库内容或密钥。

## 验证

```sh
npm test
npm audit --omit=dev
```

测试使用临时 SQLite 数据库与真实 HTTP 服务，覆盖旧接口、多语言内容、别名和同名消歧、PATCH 合并、迁移回滚、层级、taxonomy、分页、富文本清洗、鉴权及资源限制。
