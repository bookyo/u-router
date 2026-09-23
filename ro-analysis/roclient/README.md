# RO V6 离线任务测试客户端

针对 `post.lastro.cn`（仙境的传说 V6，roBrowser 魔改版）的协议级离线客户端。
不经浏览器，直接通过 WebSocket 网关与游戏服务器通信，可编程完成登录、巡路、NPC 对话、商店交互、卡普拉传送。

## 端到端实测记录（2026-09-11）

- **免费飞艇传送**：morocc ⇄ prontera 双向实测，`PRIVATE_AIRSHIP_REQUEST` 一发直达指定坐标（0 格偏差），免钱免对话 ✅
- **卡普拉传送链路**：A* 巡路找卡普拉 → 对话菜单"使用传送服务" → 选"梦罗克 1200z" → 付费传送 → 换图重发 ACTORINIT → A* 精确到达 (140,90) ✅

## 🚌 免费传送（私人飞艇，V6 定制）

世界地图一键传送 = 苍蝇翅膀(V6 定制 itemid=14527)定位瞬移，同一协议：

```
CZ.PRIVATE_AIRSHIP_REQUEST (0x0A49, 34B):
  mapname(16B) + x(u32) + y(u32) + type=1 + itemid=14527
→ 免费飞到任意支持传送的地图指定坐标（洞穴等不支持）
响应 0x0A4A: 2=背包无传送卷轴/会员卡  3=该图不支持(洞穴)  4=当前图禁用
```

客户端调用：`c.airshipTeleport('morocc', 140, 90)`（无需打开 UI，直接发包）

## 🎯 赏金任务系统（Eden 线，实测 2026-09-11）

**赏金猎人 NPC**：`赏金猎人#mor @ morocc (165,97)`，GID=110014325（梦罗克中心喷泉东侧）

### 完整任务链实测（全通）

```
[1] 飞艇 → morocc 赏金NPC旁 (166,98)                    ✅
[2] 道具商店买传送卷轴（药剂商人#moc2 @170,84，
    商品列表末位 #11624 = 7000z）→ NPC_MARKET_PURCHASE   ✅ "支付了 7000z"
[3] 飞艇进洞穴: 金字塔一层 moc_prydb1 (90,112)           ✅ 精确落点
[4] 点击洞内 NPC mocp12-1 @(87,115)                      ⚠ 点击有效但无对话文本（疑需任务状态）
[5] 洞穴内飞艇直接回赏金NPC旁 (166,98)                    ✅
```

**关键能力**：飞艇**可进洞穴**（目标为洞穴时消耗传送卷轴）、**可从洞穴内飞出**（免费）。
商店购买封包：`CZ.NPC_MARKET_PURCHASE (0x09D6): N×{ITID i32+amount i32}`，结果 `0x0B4E`。
支付确认走 `ZC.NPC_CHAT (0x02C1)`；完整物品栏在购买/NPC 交互时经 `0x0B08+0x0B09`(34B/项) 同步。

任务菜单完整可编程读取（60+ 项），格式：`[类型] - 任务名 + 难度星级 + (√已完成)`
类型：狩猎 / 收集 / 采集 / 送货 / 挖宝 / 中级狩猎 / 高级狩猎（难度 ★~★★★★★）

## 🌀 瞬间移动技能（蝴蝶卡片衍生，实测结论）

Eden 线蝎子星（猎人）技能表确认 `SKID=26 AL_TELEPORT Lv1`（蝴蝶卡片赋予）：

| 测试 | 结果 |
|------|------|
| `USE_SKILL(26, 1, self)` | ✅ **同图随机瞬移**（立即生效，如 (203,254)→(170,271)） |
| `USE_SKILL(26, 2, self)` | ✅ 同样随机瞬移（无官方选图界面，服务器不回 WARPLIST） |
| `USE_SKILL_TOGROUND(26,1,x,y)` | ❌ 无效 |
| `SELECT_WARPPOINT(26, 图名)` | ❌ 无效 |
| 同图 AIRSHIP（type 0/2/3） | ❌ 被静默忽略 |

**结论**：技能/苍蝇翅膀本身只有**随机瞬移**；玩家体验到的"定位瞬移"来自**跟随系统**
（密语 `NPC:setfollow` / `NOTIFY_UPDATEINFO id=37`，服务端把跟随者瞬移到队长所在位置，需要组队）。

## 🔑 V6 密语命令通道（解包发现）

V6 把管理命令做成了**密语接收者命名空间**（CZ.WHISPER 0x00D9）：

```
receiver = "NPC:setfollow"     msg="0"/"1"  跟随模式（瞬移到队长）
receiver = "NPC:setautoattack"               自动战斗
receiver = "NPC:setautopick"                 自动拾取
receiver = "NPC:setautoeat"                  自动进食
receiver = "NPC:setoffline"                  离线挂机
receiver = "NPC:setItem" / "NPC:setSkill"    uid 配置
receiver = ""  msg="@kick 名字"              踢人
```
另一分支用 `NOTIFY_UPDATEINFO(0x0AFE)`：id 34=自动攻击 35=拾取 36=进食 **37=跟随**。
普通聊天发 @命令无效（命令只走密语通道），且命令集封闭（@warp/@jump 等均被忽略）。

## 已验证能力

| 能力 | 状态 | 说明 |
|------|------|------|
| **飞艇免费传送** | ✅ | 0x0A49(type=1, itemid=14527) 任意图任意坐标，实测 morocc⇄prontera 双向 0 偏差 |
| 登录（双线路） | ✅ | Eden=密钥B、Online=密钥A；两线账号数据独立 |
| 角色列表/选角 | ✅ | 选角前关登录 socket + 0x0187 心跳 |
| 进地图 | ✅ | CZ.ENTER 0x0436（AID@2 GID@6 Auth@10 Time=0 Sex=0） |
| 二级校验 | ✅ | 0x0AD5(seed) → 0x0AFA；PIN=AID后4位经seed打乱映射 |
| **A* 自动巡路** | ✅ | gat 可走性 + RO 8向规则 + **拐点直线分段**（服务器只走直线！）+ 实体阻挡 + 卡住侧步/重规划；实测横穿普隆德拉 126 格 23 段（130 次服务器移动确认） |
| NPC 对话 | ✅ | CONTACTNPC → SAY/WAIT/MENU 全流程；菜单策略可定制 |
| 商店交互 | ✅ | 0x00C4 → ACK → 0x0B77 Market 商品列表 |
| 卡普拉传送 | ✅ | izlude 卡普拉：服务菜单 → 城市列表（含 梦罗克→1200z）→ 正确选择；仅受游戏内资金限制 |
| 聊天命令 | ✅ | 0x00F3 须带 "角色名 : " 前缀；@warp 对普通账号未开放 |

## 服务器行为要点（实测归纳）

1. **走路规则**：服务器只接受**直线可达**的移动目标（自身不寻路），且单段建议 ≤12 格；
   撞建筑/穿 NPC 的目标会被静默忽略，反复重发触发反作弊 code=15
2. **两线加密方案不同**：
   - Eden（V6 定制服）：前 3 个封包按流式掩码（mask1-3），之后服务器用**收敛不动点掩码**（密钥B→0x5945）解密——客户端需在 CHECK_BIN 后把流快进到不动点
   - Online（标准 rAthena）：全程逐包流式掩码（密钥A），不能收敛
3. **morocc 地图**：仅 Online 线存在（Eden 是新服无此图——Eden 角色列表里 lastMap=morocc 的角色进图会被拒 code=0）；
   从 izlude 卡普拉传送 梦罗克 需 1200z
4. 角色可能跨会话保持"坐下"状态：走路前必须发 REQUEST_ACT(action=3) 站起
5. **换图（0x0091 传送）后必须重发 ACTORINIT**（地图加载完成），否则服务器忽略新图上的所有动作

## 🛒 露天商店 / 聊天室 / 自动应答模块（2026-09-12，浏览器真包校准）

基于 PC 端（api.html → Online.js）真实抓包完成移植与校准，离线单测 `npm test`（10/10，含真实封包回放）。

### 模块

| 模块 | 移植自 | 能力 |
|------|--------|------|
| `lib/vending.js` | OpenKore Vending.pm / vender_items_list | 店铺注册表(0x0131/0x0132)、商品列表获取(0x0130→0x0133/0x0800/0x0B3D)、关键词/ITID 检索+最低价、巡走扫描、快照持久化 |
| `lib/chatroom.js` | OpenKore chat_room 系 | 建房(0x00D5, limit=2 即只进一人)/改房/踢人/授权/退出，成员事件(0x00DC/0x00DD/0x00E1)，房内消息(0x008E "名字 : 内容") |
| `lib/autochat.js` | OpenKore ChatQueue.pm | 规则匹配(exact/includes/prefix/regex)+冷却+人类节奏排队发送，reply 支持异步函数 |
| `lib/itemdb.js` | — | 物品 ID↔名称表（CDN idnum2itemdisplaynametable.txt，CP949；可加 data/itemnames-zh.json 中文覆盖） |

### 关键实测结论（普隆德拉市场，账号 xiezixing3/巫师）

1. **商品列表封包 0x0B3D**（0x0800 同构）：头 12B（id+len+AID+UniqueID），条目 64B；
   条目内 price@0(i32) qty@4(i16) index@6(i16) type@8(u8) **ITID@9(u32)**——6 家真店 6/6 解析通过
2. **点击节奏**：0x7s 间隔连点 6 家店全部正常返回商品列表，无反挂
3. **⚠ SSI 商品检索（0x0835）= 立即踢线**（0x0081 code=4），模块默认禁用（`{allowSSI:true}` 显式开启）
4. **聊天室可用**：/chat 命令即 0x00D5（实测 result=0 成功）；房主只收 0x00D6 回执
   （0x00D7 只广播给旁人）；退出 0x00E3 → 0x00DD type=0
5. **加密**：密钥组按 `ClientVer==3 → A 组，否则 B 组`（Online.js init 源码实证），
   纯逐包流式推进、无收敛；浏览器注入接口须按发送序号重放密钥流
6. **登录验证**（2026-09-06 公告起）：服务器检测到脚本固定频率登录后开启登录验证，
   协议直连登录一律 code=0（0x083E）拒绝；浏览器页面登录正常——网页端配置经
   api.html 的 postMessage(ROConfig) 注入（application:'Online', ClientVer=nid, version 69.77）
7. **市场位置**：普隆德拉中央 (156,117) 一屏 300+ 家店；站桩即可被动收集 0x0131 店名

### 测试与数据

```bash
cd roclient && npm test          # 离线单测（真实抓包回放：data/wslog-pc*.json）
```

抓包数据：`../data/wslog-pc{,2,3}.json`（登录链/商品列表/聊天室），分析器 `../analyze-wslog.js`。

## 使用

```bash
cd roclient && npm install
# 完整场景：进图 → 找卡普拉 → 传送 → A* 巡路到目标
RO_LINE=online RO_CHAR=0 RO_CRYPT=A node index.js
# 自定义巡路目标
RO_TX=140 RO_TY=90 RO_LINE=online RO_CHAR=0 RO_CRYPT=A node index.js
RO_TRACE=1 node index.js          # 显示移动确认
RO_VERBOSE=1 node index.js        # 原始封包 dump
node probe.js                     # 最小探针（进图+单步走路验证）
```

## 🖥 猫队练级工作台（workbench/，多账号并行 + 账号池 + 自动赏金）

网页版多开控制台：**每个标签页 = 一个账号 worker**（独立子进程），SSE 实时推送
行动日志与结构化状态。练级与赏金两个阶段通过 **SQLite 账号池** 无缝衔接。

```bash
node workbench/server.js        # http://127.0.0.1:8787 （WB_PORT 改端口）
```

- **新号标签**：自动 `_M` 注册新账号练满 12 只猫；可选「练满后自动开下一个新号」循环
- **旧号标签**：填账号（本地存档有记录则免输密码），不足 30 级的角色按相同方案练满，缺的角色补建
- **💰 赏金标签**：从账号池自动领练满的号跑 `../bounty-run.js`（寻找>挖宝>采集>送信 优先级，
  25 分钟/轮优雅收官）；可指定账号或自动领号，也可**手动添加任意账号**（本地存档有记录免输密码）；
  **6h 任务刷新冷却**：跑完的号冷却期内不再领（循环标签自动等最早到期再继续，池空则停止；
  手动停止的号立即回池可领）。**同账号同时只允许一个 worker**（第二个标签启动即报 ACCOUNT_CLASH，
  防互踢死循环）。洞穴送货：**卷轴+飞艇直传优先**（卷轴不够自动去 morocc 道具商人买 5000z），
  物理入口仅兜底。
- **采集任务**（2026-09-16/17 实探）：宝石/娃娃/空瓶类直接买入提交——珠宝商人 `moc_ruins(109,105)`
  （红/蓝/黄/青绿/**绿**宝石 4500z，紫/天蓝宝石·珍珠 6000z，1克拉钻石 7500z）、玩偶商人
  `prontera(247,153)`（疯兔娃娃 1000z、波利娃娃 1800z、苍蝇娃娃 3000z，均直弹 0x00C4 型）、
  道具商人 `morocc(146,103)`（**空瓶 400z**，菜单型商店，兼卖传送卷轴 5000z）；
  规则：`单价×数量` 有 zeny 就买、没钱放弃；**身上已有的只买差额**（空瓶打怪会掉）；
  价格表 `data/collect-shops.json`（probe-shops.js 探针生成，运行中自动刷新）。
  数量从任务描述"物品×N/* N/N个"提取（全角归一化，缺省 5）
- **账号池（💾 SQLite `workbench/workbench.db`）**：练满 12 只 30 级猫的账号自动入库
  （扫主存档 + tab 存档，30s 周期 + 练满即时），记录赏金次数/累计任务/状态；右上角「账号池」按钮查看
- 状态卡：练级标签显示账号/角色/等级/进度/六维；赏金标签显示当前账号/角色/本轮任务数
- 行动日志：升级/战斗/物品获取/技能/任务/警告按颜色分类，**自动滚动 + 自动清理**（前端保留 500 行）
- 每标签独立账号存档 `workbench/accounts/tab-*.json`，多 worker 并发写不冲突；启动自带 0-12s 错峰
- **标签持久化**：`workbench/tabs.json`（3s 周期落盘），服务重启自动恢复为停止态
- **多标签账号冲突防护**：一个账号同一时刻只允许一个 worker（覆盖 赏金×练级 任意组合、
  冷却等待中的赏金标签也算占用）；冲突标签报 ACCOUNT_CLASH，循环标签 30s 自动重试
  （练级 worker 退出瞬间的误占用可自愈）。自动领号的赏金标签之间互斥领号，不会拿到同一个号

### 已完成：仓库存取模块（lib/storage.js，2026-09-17 实测）

- 卡普拉职员 @ **morocc (156,97)**，对话「使用仓库」自动扣 60z（无确认弹窗）
- 协议（20211103 新库存协议，OpenKore 模板对照）：开仓 `0x0B08(type2)` + 堆叠列表 `0x0B09(type2,34B/项)`
  + 装备列表 `0x0B39(type2,68B/项)` + 容量 `0x00F2`；存入 `CZ 0x0364`(背包idx+数量)→回执 `0x0B44`；
  取出 `CZ 0x0365`(仓库idx+数量)→回执 `0x00F6`；关闭 `0x00F7`→`0x00F8`
- **仓库状态跨会话保持**（未关仓下线，重登自动重推列表）；0x0B09/0x0B39 按窗口 type 分流，仓库列表不污染背包
- 实测往返：存苍蝇翅膀×1（回执 index=1）→ 取回同位 ×1（回执 ✓）→ 关仓 ✓
- 用法：`Storage.openViaKafra(gid, talk)` / `depositByITID` / `withdrawByITID` / `close()`；
  后续可接赏金：任务物品从仓库拿取、奖励入库（bounty-run 暂未接，需要时一行调用）

worker 支持的环境变量（工作台自动注入，也可手动跑用）：
leveler：`RO_NEW=1` 强制开新号 · `RO_ACCT_FILE` 独立存档 · `RO_EVENTS=1` 输出 `@@{json}` 事件流 ·
`RO_START_DELAY` 错峰秒数 · `RO_STAY=1` 全程在线（hunter 智能走位）
bounty-run：`RO_USER/RO_PASS` 账号 · `RO_OUT` 独立输出文件 · `RO_DASH_PORT=off` 关面板 · `RO_DEADLINE_MIN` 轮时限

### 巡访节奏（按实测标定）

用户实测（10str/10agi/其余dex 出生，首都南门离线挂机）：7 分钟 17 级 → 15 分钟 24 级 →
飞斐扬 20-28 分钟 30 级。巡访间隔按阶段自动调整：**<24 级每 100~150s**（高频补点保输出），
**24 级后每 210~270s**（少打扰离线挂机）。升级加点：Dex→18 → Str→29 → 全 Agi。

## 🐱 猫队练级器 v2（leveler.js，模块化）

每账号练 12 只召唤师（猫，job=4218）到 30 级。流程：

1. 出生加点 Str→10 / Agi→10 / Dex→8（`lib/statplan.js`）
2. 飞艇 `prt_fild08 (208,235)`，开内挂（0x0AFE 34/36/57 真值序列）+ hunter 走位
3. 升级加点 Dex→19 → Str→29 → 全 Agi
4. **24 级**飞艇 `pay_fild08 (213,323)`，内挂定向 [1014 魔菇, 1025 青蛇]
5. **30 级**收尾：技能「新基础技能」+1（`lib/skillplan.js`，SKID 5018 = `SU_BASIC_SKILL`，
   0x0112 加点 + 0x010E 回执确认，probe-skill.js 2026-09-16 实测）→ 回角色选择 → 下一只
6. 12 只全部 30 级 → 账号标记 done → **默认停止**（测试用；`RO_MAX_ACCOUNTS=0` 恢复无限开号）

```bash
node leveler.js                          # 练满 1 个号(12只猫)就停 —— 当前测试模式
RO_MAX_ACCOUNTS=0 node leveler.js        # 无限练
RO_ACCOUNT=auit63e4 node leveler.js      # 指定存档内账号，把 <30 级角色补到 30
RO_ACCOUNT=myacct:mypass node leveler.js # 指定存档外账号（必须带密码）
RO_LV_DONE=30 RO_CHARS=12 RO_LV_MOVE=24  # 等级/数量/换图等级覆盖
RO_PRT="208,235" RO_PAY="213,323"        # 传送坐标覆盖（默认已内置）
RO_SKILLS="新基础技能:1"                  # 收尾技能覆盖（纯数字按 SKID，如 "5018:2"）
```

账号选择策略（`lib/accounts.js`）：指定账号 > 续练同 `plan` 标记的 pending 账号（崩溃恢复，
老存档不混入）> 新建 `_M` 自动注册账号。存档 `accounts.json` 记录每只角色等级进度。

### 模块清单（练级器相关）

| 模块 | 职责 |
|------|------|
| `lib/accounts.js` | 账号生成/_M 注册、进度记账、RO_ACCOUNT 指定、plan 隔离、maxAccounts 停止 |
| `lib/statplan.js` | 分阶段属性加点（防抖 + 无回执乐观回填 + 80 次/轮防刷上限） |
| `lib/skillplan.js` | 收尾技能加点（SKID/别名定位 → 0x0112 → 0x010E 确认，不乐观加级） |
| `lib/hunter.js` | 自研猎怪/走位（combo 模式下内挂打怪 + 本模块走位） |


## 关键协议发现（逆向 Online_mn.js + 浏览器抓包对照）

1. **网关**：`wss://port.lastro.cn/<ip>:<port>`，路径即目标；V6-Eden 登录服 `45.248.8.68:26569`，角色/地图服回 `127.0.0.1:24322/24323`
2. **封包版本**：20211103，但登录/选角走老式封包（0x0064/0x0065/0x0066），混合协议
3. **加密**：仅发往地图服的封包前 2 字节做流式 XOR，密钥 `[1205481659, 453065404, 592073252]`（B 组）
4. **字符集**：GBK（langtype 3）
5. **V6 定制**：
   - 角色/地图服连接后先回 4 字节 AID/GID 回声（0x0283+AID）
   - 0x082D 角色列表头 29 字节 + 0x006B 才是角色数据
   - 0x0600（4字节）未知定制包需跳过
   - 方向封包用老式 0x009B/0x009C（新式 0x0361 会断线！）
   - 商店走 NPC Market（0x0B77）而非旧版 0x00C6
6. **反作弊**：
   - 坐着走路被静默忽略，反复重发触发 code=15 踢线 → 必须先站起
   - 不回 0x0AD5 二级校验 → 动作被拒
   - 服务器会跟踪会话，非正常退出后幽灵角色占用认证位（code=1/8），需 75 秒以上冷却或优雅退出（0x018A）
   - 选角前登录 socket 必须关闭，否则地图认证失败

## 文件结构

- `lib/protocol.js` — 封包构造（登录/移动/对话/商店/加点 0x00BB/技能加点 0x0112，含字段偏移注释）
- `lib/client.js` — 状态机：网关连接、封包解析分发、二级校验、会话管理
- `lib/bot.js` — 巡路（站起+重发控制）与对话自动机
- `lib/accounts.js` — 练级器账号存档（生成/记账/选择策略）
- `lib/statplan.js` — 练级器属性加点模块
- `lib/skillplan.js` — 练级器收尾技能加点模块（新基础技能 5018）
- `lib/hunter.js` — 练级器猎怪/走位模块
- `lib/binary.js` — 二进制读写（RO 12bit 坐标编解码，逐字节对照 roBrowser）
- `lib/crypt.js` — 地图服方向封包 ID 混淆（Math.imul 语义）
- `packet_sizes.json` — 690+ 封包 ID→长度表（含 V6 定制修正）
- `../packets_20211103.json` — 版本化封包定义（ID/尺寸/字段偏移）
- `../packet_register.json` — 完整 ID→结构名映射

## 扩展任务自动化

- 对话自动机已支持自定义菜单选择策略（`bot.handleDialog({ onMenu })`）
- 服务器内置自动开关：`client.send(BUILD.notifyUpdateinfo(34|35|36, 1))`（自动攻击/拾取/进食）
- 攻击：`BUILD.requestAct(targetGID, 0)`；聊天：`BUILD.requestChat(...)`
- 地图数据：`https://post.lastro.cn/ro/client_re/data/<map>.gat`（GRAT 格式，type 0=可走）
