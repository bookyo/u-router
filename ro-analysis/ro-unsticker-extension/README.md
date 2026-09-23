# RO 启动器解卡器（浏览器扩展）

针对 `post.lastro.cn` / `game.lastro.cn` 的 roBrowser 启动页 `ro/api.html?69.77` 的
**“正在初始化程序....”永久卡死**问题。

## v1.1.0：消息守卫（重要）

api.html 的一次性监听会被**第一条**消息消费。钱包类扩展（MetaMask 等）会向页面
postMessage 垃圾数据 → 页面加载 `undefined.js` 404 永久卡死（控制台可见
`GET /ro/undefined.js 404`）。v1.1.0 新增 `content-guard.js`：document_start 时
以最先注册的 window message 监听拦截垃圾消息、只放行合法 ROConfig；注入后持续
校验 Online.js 是否开始加载，未加载自动重发配置，`undefined.js` 出现时自动重载
一次自愈。

## 原理

`api.html` 内联脚本只注册**一次性** `message` 监听，等待 opener（新闻页 `pc-api.js`）
每 100ms 轮询投递 `ROConfig`，收到后移除监听并按 `event.data.application` 加载
`Online.js`。以下情况握手丢失 → 永久卡死：

- 直接打开 `/ro/api.html`（无 opener）
- 启动后刷新（F5）页面（opener 只对新弹窗投递）
- 启动器弹窗被拦截后手动进入

本扩展在页面空闲时通过 `window.postMessage` 补发与 `pc-api.js` 完全同构的配置
（`application:'Online'`、`remoteClient:'/ro/client_re/'`、`ClientVer`、`version`
取自 URL 查询参数等），页面随即正常加载 3.2MB 的 `Online.js` 进入登录界面。

同时自动挂载 WebSocket 封包监听（与手工调试验证过的版本一致）：

- `window.__wsLog` — 全部收发帧（base64）
- `window.__wsSock` — 当前 socket
- `window.__sendGame(bytes)` — 向地图服注入封包（自动按帧序重放流式掩码，
  ClientVer=3 用密钥组 A，其余用密钥组 B）

## 安装

1. Chrome/Edge 打开 `chrome://extensions`（Edge: `edge://extensions`）
2. 开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本目录

## 使用

- **日常无需操作**：打开/刷新 api.html 时自动注入（默认 ClientVer=5，V6-Eden N 进阶二转）。
- 点扩展图标可切换线路（5=Eden N / 3=Online 三转 / 4=电信 29569）：
  - 「保存默认 + 重载当前标签」：换线路用（页面只收一次配置，换 ClientVer 必须重载）。
  - 「仅注入当前标签」：对已卡住但本扩展尚未接管（如安装扩展前就打开的页面，
    需先 F5 一次让内容脚本生效）的标签补一发配置。

## 文件

- `manifest.json` — MV3；两条内容脚本：`content-bridge.js`（ISOLATED，读设置）+
  `content-main.js`（MAIN 世界，注入配置/挂钩）
- 两世界 JS 隔离，通过 `__roReady` / `__roCv` CustomEvent 协商 ClientVer
