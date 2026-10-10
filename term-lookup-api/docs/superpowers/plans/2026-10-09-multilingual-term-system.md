# Multilingual Term System Implementation Plan

**Goal:** 在现有服务补齐已确认的多类型多语言词条能力。

**Architecture:** SQLite schema v5 存储名称数组、内容、类型和分类关系；repository 管理事务和层级，validation 管理输入，HTTP 路由保留 v1 并提供 v2。Markdown 渲染与 HTML 清洗独立。

**Tech Stack:** Node.js >=25、node:sqlite、node:test、markdown-it、sanitize-html。

**Spec:** ../specs/2026-10-09-multilingual-term-system-design.md

**Execution:** 用户“开始实施”授权当前任务连续实施；原地执行，保留用户文件，仅变更 term-lookup-api，完成后交付可审阅 diff，不自动发布。

## Global Constraints

- 保留 v1 单字符串输出和原有请求大小上限；v2 使用名称数组和 PATCH 保留省略字段。
- v2 请求体最多 2 MiB，正文每语言最多 512 KiB。
- 名称、内容、语言数、来源、标签、分类、URL 和 slug 上限按 spec。
- 多词条同名允许；v1 歧义返回 409；事务失败回滚。
- 富文本禁用原始 HTML，清洗渲染结果；不主动获取用户 URL。

## Review Focus

- v1 写入不得丢失 v2 内容、别名和元数据，冲突不能部分修改。
- 迁移损坏 JSON、循环或孤儿父级时失败回滚，未来版本拒绝启动。
- 危险链接、原始 HTML、事件属性不能进入可执行渲染结果。
- PATCH 语言合并不允许 prototype pollution，必需语言不能被移除。
- 同名查询分页、children 直接父级筛选和分类引用删除保护。

## Task 1: RED regression coverage

Files: test/v2.test.js, test/migration.test.js, test/api.test.js。

- [x] 测试创建持久化、详情/摘要、PATCH、别名追加删除、同名筛选、层级路径、分类/类型/标签 CRUD、v1 兼容、渲染安全、非法输入和权限。
- [x] 用旧代码运行 npm test，确认新增 21 项因 404/缺失迁移失败，原有 17 项保持通过。

## Task 2: Schema, validation and repositories

Files: src/schema.js, src/validation.js, src/errors.js, src/term-repository.js, src/taxonomy-repository.js。

- [x] 在事务中迁移 v0–v4 到 v5，保留 IDs、时间戳、父级；名称按语言规范化。
- [x] 实现词条 CRUD、别名、关系、分页候选列表与兼容 upsert。
- [x] 实现 taxonomy CRUD、分类祖先/循环检测、删除引用保护。
- [x] 测试确认迁移与 repository 行为。

Interfaces: repository.create(payload), get(id), patch(id,payload), list(filters), remove(id), changeName(id,payload,remove), ancestors(id), upsert(translations,parentId), find({value,from})；taxonomy.list(kind,filters), create(kind,payload), patch(kind,id,payload), remove(kind,id)。

## Task 3: HTTP and rich text

Files: src/app.js, src/v2-routes.js, src/content.js, package.json, package-lock.json。

- [x] v1/v2 使用一致鉴权和稳定错误格式；限制请求体，严格校验分页。
- [x] 实现 spec 所有 v2 接口，读取缺失词条先返回 404。
- [x] 加入 Markdown 解析与 HTML 白名单清洗，HTTP/HTTPS 链接和图片仅引用。
- [x] npm test 全量通过；新增风险测试先 RED 再修复。

## Task 4: Review and handoff

Files: README.md, docs/examples/character.json, 此计划。

- [x] 更新完整调用示例、字段、返回值、错误、分页和迁移说明。
- [x] 运行全量模块测试、语法检查、npm audit、git diff --check。
- [x] 实际 server 启动冒烟，重启后核验持久化与 v1/v2 查询。
- [x] 报告结果与 Git 状态。

## 实施记录

- 首轮 RED：21 个新增失败，17 个既有通过；修正迁移孤儿数据 fixture 的外键设置后全部失败原因正确。
- schema 与兼容层阶段：21 项通过；首轮全实现：38 项通过。
- 二轮 RED：ASCII 正文超限状态、累计 PATCH 预算、默认类型保护、旧主名称保留，共4项失败后修复。
- 独立只读审核的2个兼容问题先 RED 后修复：历史合法名称/标签不能阻断迁移；未修改的共享别名不能挡住唯一主名称更新。
- 追加历史别名操作 RED 后修复，保证历史长名称可继续编辑；添加 v4 名称数组及循环迁移测试。
- 实际入口冒烟以临时数据库运行并重启 src/server.js，验证文档示例、鉴权、分类/标签、富文本、别名和父级持久化。
- 最终 npm test：50/50（原有17 + 新增33）；npm audit --omit=dev：0 vulnerabilities；全部 JS node --check 与 git diff --check 通过。
- Ruling: 默认 term 类型保留 slug/删除保护，避免破坏默认创建和 v1；其它类型 slug 允许修改，稳定 ID 保留引用。
- Ruling: 合并后词条可写内容也限制2 MiB，防止分次 PATCH 绕过请求上限。
- Ruling: 历史数据迁移/v1 使用历史校验，v2 新写名称仍严格限制；移除名称允许历史长度，未修改的旧字段保留。
- 未部署、未改写现有实际数据库、未自动提交；变更限于 term-lookup-api。

## 后续需求：匿名读取限流（2026-10-09）

- 用户要求读取/搜索可选 Key，匿名同 IP 每分钟20次，有效 Key 不限流。
- 使用滚动60秒窗口，全 v1/v2 GET 共享 IP 额度；写入仍需 Key，错误 Key 返回401，health 排除限流。
- 默认连接 IP；TRUST_PROXY_IPS 显式配置代理，右向左解析 X-Forwarded-For，统一 IPv4/映射 IPv6 和 IPv6 表示。
- 先新增6个 HTTP 回归测试，旧代码全部因匿名401失败；实现后通过。补充 IP 规范化、错误请求计数、代理失败回退和内存上限测试。
- 实际启动入口冒烟增加代理环境配置、20次允许/第21次429、其它IP独立额度和有效Key免限流验证。
- 限流为单进程内存，重启重置；文档与 .env.example 已同步。
