# PM2 部署指南（猫队工具链）

> 适用：把工作台部署到云服务器（或本地长期挂机），进程守护 + 崩溃自动拉起 + 开机自启。

## 一、架构与进程关系（先读这个）

```
pm2
 └── workbench (server.js, :8787)        ← 唯一需要 PM2 守护的进程
      ├── 赏金 worker (bounty-run.js)     ┐
      ├── 练级 worker (leveler.js ×3)     │ 工作台按需 spawn 的子进程，
      ├── 爬店 worker (market-scan.js)    │ 不进 PM2、由标签启停管理
      └── 常驻商人 (mule.js, :8790)      ┘
```

- **只 `pm2 start` workbench 一个应用**，worker 由工作台标签按需拉起。
- 工作台重启/崩溃 → 启动清扫自动击杀孤儿 worker（防止脱管挤号）、重置卡死状态（`bounty_running`→ready、练级 running→pending 自动续练）。
- `mule` 独立常驻模式默认**关闭**（`ecosystem.config.js` 里 `ENABLE_MULE=false`）：与工作台的「常驻商人」标签二选一，同时跑会抢 8790 端口 + 同账号双登互踢。

## 二、安装与首次启动

```bash
npm install -g pm2
cd ro-analysis

# 1) 编辑 ecosystem.config.js，按需填写：
#    WB_APIKEY   —— 云部署必填（工作台登录门禁）
#    RO_MULE_KEY —— 8790 公网开放时必填（商人管理门禁 + 赏金免费下单）
# 2) 启动
pm2 start ecosystem.config.js
pm2 save                     # 保存进程列表（开机自启用）

# 验证
pm2 list
curl http://127.0.0.1:8787/api/state    # 未设 WB_APIKEY 时直接出 JSON；设了则返回登录页/401
```

## 三、开机自启

```bash
pm2 startup        # 按提示复制执行它输出的那条 sudo 命令（注册 systemd 服务）
pm2 save           # 再次保存，重启后自动恢复进程列表
```

## 四、常用命令

| 命令 | 作用 |
|---|---|
| `pm2 list` | 进程状态一览 |
| `pm2 logs workbench --lines 200` | 看工作台日志（worker 输出也汇总在这里，带标签前缀） |
| `pm2 logs workbench --err` | 只看错误流 |
| `pm2 restart workbench` | 重启工作台（见「重启时机」） |
| `pm2 stop workbench` / `pm2 start workbench` | 停 / 起 |
| `pm2 monit` | 实时 CPU/内存面板 |
| `pm2 delete workbench` | 从 PM2 移除 |
| `pm2 start ecosystem.config.js --update-env` | 改了 env 后带新环境变量重启 |

## 五、环境变量一览

| 变量 | 默认 | 说明 |
|---|---|---|
| `WB_PORT` | 8787 | 工作台端口 |
| `WB_APIKEY` | 空 | 登录 KEY。留空=公开访问；设置后所有页面/API 需登录（`/search` 公开搜索页与 `/api/market/search|stats` 除外） |
| `RO_MULE_KEY` | 空 | 商人 8790 管理 KEY。设置后 `/price /pull /status /inventory /cancel` 等必须携带（头 `X-Api-Key` 或 `?key=`）；`/stock`（商品目录）与 `/order /trade`（购买）保持公开——**无 KEY=按价目表收费+验钱，带 KEY=免费**。赏金脚本下单时带上 KEY 即免费取货 |
| `RO_FAKE_IP` | 空 | `auto`=按账号哈希固定伪装出口 IP（绕 mg/check 的终端限制） |
| `WB_BOUNTY_WAVES` | `0,6,12,18` | 赏金波次（**北京时间**整点，逗号分隔小时）。留空退回旧的"跑完+6h"冷却 |
| `WB_BOUNTY_WAVE_OFFSET_MIN` | 15 | 波次后偏移分钟（等服务器刷新稳定再开跑） |
| `WB_LVL_MAX` | 3 | 老号练级中心并发数 |
| `WB_NO_SWEEP` | 空 | 仅调试：跳过启动清扫（不杀孤儿 worker/不重置状态）。**正式环境勿开** |
| `TZ` | 系统 | 已配 `Asia/Shanghai`；波次计算本身按 UTC+8 显式换算，换时区的服务器上结果不变 |

## 六、时区说明

- 波次时刻（0/6/12/18 + 15 分）在代码里按 **UTC+8 显式换算**（北京时间无夏令时），**不依赖服务器时区**——美国服务器上算出的仍是北京整点（已在上海/洛杉矶双时区实测一致）。
- `TZ=Asia/Shanghai` 只影响日志/提示的时间**显示**，让云端日志和本地看到的一样。

## 七、云部署安全检查单

1. `WB_APIKEY` 已设 → 未登录访问所有管理页面/API 一律 401/登录页。
2. 商人 8790 需公网可达（网友插件要连）：设 `RO_MULE_KEY`，且**只有** `/stock /order /trade` 对外。管理操作走工作台代理 `/api/mule/*`（浏览器带登录 Cookie → 代理自动附 KEY → 商人验证），不需要暴露管理口。
3. 公开搜索页 `/search` 免登录（设计如此），只有查询没有写操作。
4. 防火墙建议：8787 可公网（有登录门禁）或仅 VPN；8790 公网（插件用）；其余端口不开。
5. 已知待办：网友浏览器插件目前写死 `http://127.0.0.1:8790`，上云后需给插件加"服务器地址"配置项（未实现）。

## 八、重启时机建议

工作台重启会**杀掉全部在跑的 worker**（启动清扫设计如此）：

- **赏金**：波次间隙最安全——每波 xx:15 开跑、约 1.5 小时跑完全部号，即每波次的 **整点前后（上一波跑完、下一波未开）** 是天然窗口。被杀的当前轮进度丢失，账号回池下一波重跑。
- **练级**：重启后自动重置为 pending 并续练（3 秒），基本无感。
- **商人**：走优雅下号（RESTART 释放角色，不进离线模式），重启工作台后到商人标签重新点开启。

## 九、日志与磁盘

```bash
pm2 install pm2-logrotate   # 建议装：日志轮转，防止写爆磁盘
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 7
```

## 十、数据与备份

| 路径 | 内容 |
|---|---|
| `roclient/workbench/workbench.db` | SQLite：账号池、练级队列、赏金轮次历史、市场商品库（爬店结果） |
| `roclient/workbench/accounts/` | 练级账号存档（断点续练）、赏金 worker 输出（含波次冷却 limits） |
| `data/` | 商人价目表、持身任务、授权名单、采集价格表等 |

备份 = 定期拷贝以上三处即可（停机备份最稳；热备 sqlite 建议 `.backup` 命令）。

## 十一、故障速查

| 现象 | 处理 |
|---|---|
| `pm2 list` 显示 workbench 反复重启 | `pm2 logs workbench --err` 看启动报错；常见：端口被占（旧的裸 node 进程没杀干净 → `lsof -i:8787`） |
| worker 全部没起来 | 检查是否误设了 `WB_NO_SWEEP=1`；或看标签页日志 |
| 商人起不来 | 工作台商人标签显示"密码已保存"了吗（配置被清空会拒绝启动）；账号是否被其他系统占用（`/api/state` 的 busy 列表） |
| 云端波次时间不对 | 不该发生（UTC+8 显式换算）；若见异常检查 `WB_BOUNTY_WAVES` 格式（逗号分隔小时数字） |
