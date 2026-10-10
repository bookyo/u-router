# 词条随行 · Term Pocket

独立的 Chrome / Edge Manifest V3 扩展，无需构建、无运行时依赖。普通网页右侧中间有「词」按钮，点击展开搜索 / 添加表单；通过当前仓库的 `term-lookup-api` v2 接口读写词条。

最低 Chromium 108；面板采用 [Chrome 108 支持的动态视口单位](https://developer.chrome.com/blog/new-in-chrome-108)，建议使用最新稳定版 Chrome / Edge。实际浏览器回归使用 Chromium，未单独运行 Edge。

## 安装

1. Chrome 打开 `chrome://extensions`，或 Edge 打开 `edge://extensions`。
2. 开启「开发者模式」，选择「加载已解压的扩展」，选本文件夹 `term-browser-extension`（不是仓库根目录）。
3. 打开扩展的「详细信息 → 扩展选项」，填写 API 服务根地址，默认 `http://127.0.0.1:4444`。保存时按需授权该 API 主机的访问权限。
4. 搜索可以不填 Key；添加必须填写服务端 `API_KEY` 对应的 Key。保存后刷新已打开的普通网页，点击右侧「词」使用。

扩展默认不启动服务器。启动接口的方法见 [词条 API 文档](../term-lookup-api/README.md)。远程 API 建议使用 HTTPS；服务端须自行部署公网 HTTPS / 反向代理。

## 使用

- 搜索：输入完整词语并指定输入语言，支持首选名称和同义词 / 译名，不是模糊全文搜索。结果展示全部语言和词条 ID，每次最多 20 项，可加载更多。
- 添加：英文 `en` 与简体中文 `zh-Hans` 必填，每行一个译名。点击「添加更多语言」填写 `ja`、`zh-Hant`、`fr` 等 BCP 47 语言代码与对应译名；额外语言可以移除。
- 同一语言的重复译名会按 NFKC / 大小写去重；每个译名最多 256 字符、每种语言最多 50 个译名、最多 50 种语言。
- 关闭：点击右上角 × 或按 Esc。浏览器工具栏按钮也可独立打开面板。
- 无 Key 搜索由服务端按 IP 共享 20 次 / 分钟限额；有效 Key 不限流，错误 Key 会返回 401。429 时显示等待秒数，不会自动重试消耗限额。
- 创建失败保留输入，不自动重试。当前 v2 创建总是新增，即使文本完全相同也可能创建重复词条。遇到超时先搜索确认，再决定是否重新提交。

最小请求：

```json
{
  "translations": {
    "en": ["Example"],
    "zh-Hans": ["示例"]
  }
}
```

## 范围与隐私

支持普通 HTTP / HTTPS 页面，默认仅主框架显示一个按钮。[浏览器内部页面、Chrome Web Store 等受限制页面不能注入内容脚本](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)，工具栏面板仍可使用。隐身及文件 URL 权限不默认开启；PDF 阅读器等浏览器接管页面不保证侧边按钮可用。

面板是扩展源 iframe，样式隔离在封闭 Shadow DOM 内。API Key 只存当前浏览器扩展的本地存储，不同步；通过 `TRUSTED_CONTEXTS` 禁止内容脚本读取。网页不接收 Key，API 请求只由后台发出，拒绝重定向、不附带网页 Cookie。无统计追踪、不读取网页正文或选区、不自动发起搜索；只发送用户主动提交的词语与译名到配置的 API。

默认拥有 localhost / 127.0.0.1 的 API 网络权限；其它 API 主机保存设置时申请。所有网页的内容脚本权限用于显示按钮，不代表自动上传网页内容。更换 API 后旧主机授权不会自动撤销，可在浏览器扩展管理中调整。浏览器自身及本机用户仍可以检查扩展本地存储，这不是系统级密钥保险箱。

## 测试

```sh
cd term-browser-extension
npm test
```

浏览器集成测试需 Node ≥25（启动当前词条 API 的 SQLite 数据库）以及 Playwright / Chromium：

```sh
npm install --no-save playwright
npx playwright install chromium
npm run test:browser
```

可以通过 `PLAYWRIGHT_MODULE` 指定 Playwright 模块路径，通过 `CHROMIUM_EXECUTABLE` 指定 Chromium 可执行文件。测试启动临时数据库与隔离浏览器配置，结束自动清理；截图写入被 Git 忽略的 `test-artifacts/`。涵盖实际加载扩展、按钮位置、恶意网页样式与严格 CSP、匿名搜索、Key 创建、第三语言和同义词、手选语言不被自动检测覆盖、21 条结果分页、内容脚本读取密钥被拒绝、窄窗口、Esc 与真实 429。封闭 Shadow DOM 内的操作使用真实键盘事件验证，工具栏面板另以鼠标点击验证。

## 文件结构

- `manifest.json`：权限、后台、内容脚本和工具栏入口。
- `content.js`：侧边按钮、封闭 Shadow DOM 与面板 iframe。
- `panel.html/js/css`：搜索、添加界面。
- `options.html/js/css`：服务地址和 Key 配置。
- `background.js`：可信扩展页面消息、权限检查和请求转发。
- `core.js`：语言 / 译名校验与 API 客户端。
- `test/`：单元测试与真实浏览器集成测试。

不包含编辑 / 删除词条、富文本详情编辑、Firefox 适配或商店发布；这些不在本次最小版本范围。
