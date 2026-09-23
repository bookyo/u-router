'use strict';
/**
 * 赏金任务完整执行链（xiezixing3，12 巫师轮换）
 * ============================================================
 * 每角色循环：回赏金NPC → 提交已完成任务 → 按 寻找>挖宝>送信 优先级接取 →
 *   导航（飞艇 / 卷轴洞穴定向）→ 目标点找 NPC 对话完成 → 飞回赏金 NPC → 提交 …
 * 直到无可接任务 → RESTART 切下一角色。全程绝不点"刷新个人任务"。
 * 记录：data/bounty-run.json + 面板 :3211
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));
const { BUILD } = require(path.join(__dirname, 'roclient/lib/protocol'));
const { approachSpots, receiveMuleTrade, retryMuleExchange, settleMuleDelivery } = require('./trade-flow');
const { createTurnInTracker, createInitialBountyCheck } = require('./bounty-flow');
const { parseDeliveryDestination, navigateDestination } = require('./bounty-destinations');

// ---------- 持身任务持久化（断点恢复用：重启后直接路由到持任务角色继续/放弃，防卡账号任务槽） ----------
const HELD_FILE = path.join(__dirname, 'data', 'bounty-held.json');
function heldSave(slot, name, task) {
  try { fs.mkdirSync(path.dirname(HELD_FILE), { recursive: true });
    fs.writeFileSync(HELD_FILE, JSON.stringify({ account: OPT.account, slot, name, task, at: new Date().toISOString() })); } catch (_) {}
}
function heldLoad() {
  try { const h = JSON.parse(fs.readFileSync(HELD_FILE, 'utf8')); return h.account === OPT.account ? h : null; } catch (_) { return null; }
}
function heldClear() { try { fs.unlinkSync(HELD_FILE); } catch (_) {} }

const OPT = {
  account: process.env.RO_USER || 'xiezixing6',
  password: process.env.RO_PASS || '',
  line: process.env.RO_LINE || 'eden',
  homeMap: 'morocc', homeX: 166, homeY: 98,   // 赏金 NPC 旁
  out: process.env.RO_OUT || path.join(__dirname, 'data', 'bounty-run.json'),  // 工作台并发时每 worker 独立
  port: (process.env.RO_DASH_PORT || '3211') === 'off' ? 0 : parseInt(process.env.RO_DASH_PORT || '3211', 10),
  maxTasksPerChar: parseInt(process.env.RO_MAX_TASKS || '6', 10),
  switchGapMs: parseInt(process.env.RO_SWITCH_GAP || '8000', 10), // 切角间隔：20 分钟内跑完 12 角色
  charBudgetMs: parseInt(process.env.RO_CHAR_BUDGET || '0', 10), // 单角色时限：默认 0=已取消（2026-09-19 实测坑：买完宝石没来得及回去交差就被切角色，任务悬挂；如需恢复设秒数
  deadlineMin: parseInt(process.env.RO_DEADLINE_MIN || '25', 10), // 总时限：到点优雅收官（RESTART→关连接）
  taskCap: parseInt(process.env.RO_TASK_CAP || '10', 10), // 账号任务上限（2026-09-21 服务器规则：6小时内最多完成10个）：计数判定用
  muleUrl: process.env.RO_MULE_URL || 'http://127.0.0.1:8790',   // 常驻商人控制口
  muleKey: process.env.RO_MULE_KEY || '',                         // 商人 KEY：带 KEY 下单=免费取采集物品
  forceCollect: process.env.RO_FORCE_COLLECT === '1',             // 测试用：只接采集类任务
};

// 工作台事件流（RO_EVENTS=1 时输出 @@{json}，与 leveler 同协议）
const EVENTS = process.env.RO_EVENTS === '1';
const ev = (obj) => { if (EVENTS) { try { console.log('@@' + JSON.stringify(obj)); } catch (_) {} } };

// ---------- 任务数据库 ----------
// 寻找类（用户坐标表；alt=找不到 NPC 时的备选地图；cave=需传送卷轴）
const FIND = [
  { name: /美人鱼/, map: 'comodo', x: 87, y: 242 },
  { name: /大嘴鸟/, map: 'geffen', x: 116, y: 201 },
  { name: /老母鸡/, map: 'morocc', x: 29, y: 158 },
  { name: /波利/, map: 'prontera', x: 155, y: 284 },
  { name: /黑[喵猫]/, map: 'izlude', x: 134, y: 102 },
  { name: /老奶奶/, map: 'payon', x: 171, y: 134 },
  { name: /女朋友/, map: 'izlu2dun', x: 103, y: 115, alt: ['alb2trea'] },
  { name: /花斑[猫喵]/, map: 'alberta', x: 114, y: 222 },
  { name: /冒险家|探险家/, map: 'moc_pryd01', x: 90, y: 112, alt: ['moc_pryd1', 'moc_prydb1'], cave: true },
  { name: /帅小伙/, map: 'xmas', x: 148, y: 307 },
];
// 挖宝提交点
const DIG = { map: 'pay_fild11', x: 115, y: 173, npc: /寻宝者/ };
const CAVE_MAPS = new Set(['moc_pryd01', 'moc_pryd1', 'moc_prydb1', 'gef_dun00', 'in_sphinx1', 'mjo_dun01', 'prt_sewb1', 'pay_dun00', 'treasure01', 'iz_dun00']);
// 洞穴物理入口（无需卷轴）：先飞入口图踩传送格
const CAVE_ENTRIES = {
  iz_dun00: { map: 'izlu2dun', x: 108, y: 83 },   // 海底洞窟1层 ← 柏伊亚岚岛中央传送格（实测 09:11）
};
const SCROLL_ID = 14527;         // V6 定制苍蝇翅膀（飞艇洞穴传送消耗品，5000z）
const SCROLL_PRICE = 5000;

// ---------- 采集任务（2026-09-16 实探价格 data/collect-shops.json） ----------
// 宝石 → moc_ruins 珠宝商人(109,105)；娃娃 → prontera 玩偶商人(247,153)。
// 两商人均为「接触直弹 0x00C4」型（无对话菜单）。规则：有钱按 单价×数量 买入提交，没钱放弃。
const COLLECT_ITEMS = {   // 名称 → { ITID, shop }（价格 data/collect-shops.json，probe-shops.js 实探）
  '红宝石': { ITID: 723, shop: 'gem' }, '蓝宝石': { ITID: 726, shop: 'gem' },
  '黄宝石': { ITID: 728, shop: 'gem' }, '青绿宝石': { ITID: 729, shop: 'gem' },
  '紫宝石': { ITID: 719, shop: 'gem' }, '天蓝宝石': { ITID: 720, shop: 'gem' },
  '绿宝石': { ITID: 721, shop: 'gem' }, '珍珠': { ITID: 722, shop: 'gem' },
  '1克拉钻石': { ITID: 730, shop: 'gem' },
  '疯兔娃娃': { ITID: 740, shop: 'doll' }, '波利娃娃': { ITID: 741, shop: 'doll' },
  '苍蝇娃娃': { ITID: 742, shop: 'doll' },
  '空瓶': { ITID: 713, shop: 'scroll' },   // 道具商人（买传送卷轴那家）400z（2026-09-17 实探）
};
const COLLECT_RE = new RegExp(Object.keys(COLLECT_ITEMS).join('|'));
const COLLECT_SHOPS = {
  gem: { map: 'moc_ruins', x: 109, y: 105, npc: /珠宝/ },
  doll: { map: 'prontera', x: 247, y: 153, npc: /玩偶|娃娃/ },
  scroll: { map: 'morocc', x: 146, y: 103, npc: /道具商人/ },   // 菜单型商店（对话→购买）
};
// 价格表（探针 probe-shops.js 生成；运行中开商店时自刷新）
const COLLECT_PRICES = (() => {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'collect-shops.json'), 'utf8'));
    return { gem: d.gem || {}, doll: d.doll || {}, scroll: d.scroll || {} };
  } catch (_) { return { gem: {}, doll: {} }; }
})();
// 采集类任务（含无法购买的：大红宝石等打怪掉落物）——用于接取过滤与执行失败判定
const isCollectLike = (t) => /收集|采集/.test(String(t || ''));
// 解析采集任务文本 → { name, ITID, shop, qty }
// qtySource=任务描述行（数量权威来源，优先于菜单文本）；数量形态 ×5/x5/* 5/5个（全角归一化，难度★不误匹配）
// 前缀字守卫（2026-09-20 坑）："大红宝石".includes("红宝石")=true 会误判——
// 匹配位置前若紧贴汉字（更长的物品名），该候选必须拒绝，否则拿错物品去提交
function parseCollect(text, qtySource) {
  const norm = (v) => String(v || '')
    .replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)))
    .replace(/ｘ/g, 'x').replace(/＊/g, '*');
  const t = norm(text).replace(/收集|采集|缴纳/g, ' ');   // 动词词头换哨兵，防"集"字误伤前缀守卫
  const name = Object.keys(COLLECT_ITEMS).sort((a, b) => b.length - a.length).find((n) => {
    const idx = t.indexOf(n);
    if (idx < 0) return false;
    if (idx > 0 && /[一-龥]/.test(t[idx - 1])) return false;   // 前贴汉字 = 是别的物品名的子串
    return true;
  });
  if (!name) return null;
  let qty = null;
  for (const src of [qtySource, text]) {   // 描述行优先；菜单文本兜底
    const qm = norm(src).match(/[×xX*]\s*(\d+)|(\d+)\s*(?:个|颗|枚|块)/);
    if (qm) { qty = parseInt(qm[1] || qm[2], 10); break; }
  }
  return { name, ...COLLECT_ITEMS[name], qty: qty || 5 };
}

// ---------- 任务解析 / 资源判定 ----------
// 挖宝规则（用户确认）：所有挖宝/宝藏任务统一到 pay_fild11 寻宝者处完成，
// 任务描述里的坐标（如"西边兽人村落的寻宝者(152,124)"）不是行动目标。
// 分类必须先于送信："寻找西边兽人村落的宝藏"含"兽人村落"送信关键词，不含连续"寻宝"字样。
function parseDest(taskText) {
  const f = FIND.find((q) => q.name.test(taskText));
  if (f) return { map: f.map, x: f.x, y: f.y, alt: f.alt, cave: !!f.cave, kind: '寻找' };
  if (/挖宝|寻宝|宝藏/.test(taskText)) return { map: DIG.map, x: DIG.x, y: DIG.y, npcRe: DIG.npc, kind: '挖宝' };
  return parseDeliveryDestination(taskText);
}
const scrollCount = () => (c.inventory || []).filter((it) => it.ITID === SCROLL_ID).reduce((a, b) => a + (b.count || 1), 0);
const canAffordCave = () => scrollCount() >= 1 || (c.zeny || 0) >= SCROLL_PRICE;
// 洞穴补给（2026-09-21 用户规则，防洞穴死亡）：红色药水(#501，约10z/瓶) 补到 20 瓶；出发前 HP≥60% 再飞
const POTION_ID = 501, POTION_TARGET = 20;
const potionCount = () => (c.inventory || []).filter((it) => it.ITID === POTION_ID).reduce((a, b) => a + (b.count || 1), 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

// ---------- 面板 ----------
const events = [];
function ui(msg, tag = '') {
  events.push({ t: ts(), tag, msg });
  if (events.length > 50) events.splice(0, events.length - 50);
  console.log(`[${ts()}]${tag ? ' ' + tag : ''} ${msg}`);
}
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>赏金执行链面板</title>
<style>body{background:#111;color:#ddd;font:13px/1.5 Menlo,monospace;padding:12px}
.e{padding:2px 6px;border-bottom:1px solid #222}.t{color:#888;margin-right:8px}
.fly{color:#6cf}.walk{color:#9c9}.npc{color:#fc6}.ok{color:#6f6}.warn{color:#f96}.quest{color:#c9f}
h3{color:#fff;margin:0 0 8px}</style></head><body>
<h3>💰 赏金任务执行链 · 实时（最近 50 条）</h3><div id="l"></div>
<script>async function tick(){try{const r=await fetch('/log.json');const es=await r.json();
document.getElementById('l').innerHTML=es.map(e=>'<div class="e"><span class="t">'+e.t+'</span><span class="'+(e.tag||'')+'">'+e.msg+'</span></div>').join('');}catch(_){}}
setInterval(tick,1000);tick();</script></body></html>`;
if (OPT.port > 0) {
  http.createServer((req, res) => {
    if (req.url.startsWith('/log.json')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(events)); }
    else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); }
  }).listen(OPT.port, () => ui(`面板: http://localhost:${OPT.port}`, 'ok'));
}
// ---------- 客户端 ----------
const c = new ROClient({ line: OPT.line, account: OPT.account, password: OPT.password });
const bot = new Bot(c);
const records = [];
let cur = null, rotating = false, loginSeq = 0, loginTimer = null, accountDone = 0;
const initialBountyCheck = createInitialBountyCheck(); // 每个 worker/账号只检查首次有效的赏金 NPC 对话
// 账号级任务上限（2026-09-21 服务器新规则：NPC say「6小时内最多完成10个任务。」）：
// 命中 → 本账号直接收官下线；按账号记冷却到 RO_OUT JSON，冷却期内启动=免登录直接退出
// （工作台 DB 冷却已覆盖账号池，这里补手动账号+工作台重启后内存冷却丢失的洞）
let limitInfo = null;   // { hours, max } 本次运行检测到的限制
const limitMap = (() => { try { return (JSON.parse(fs.readFileSync(OPT.out, 'utf8')) || {}).limits || {}; } catch (_) { return {}; } })();   // { 账号: 截止毫秒 }
// 服务器波次真值（用户 2026-09-21）：一天 4 波，北京时间 0/6/12/18 整点刷新任务上限——
// 冷却对齐下一波+偏移分钟（默认 15），而非 now+6h（滚动 6h 会漂移，实测能浪费近一整波）
const WAVE_HOURS = (process.env.WB_BOUNTY_WAVES || '0,6,12,18').split(',').map((x) => parseInt(x, 10)).filter((x) => !isNaN(x)).sort((a, b) => a - b);
const WAVE_OFFSET_MIN = parseInt(process.env.WB_BOUNTY_WAVE_OFFSET_MIN || '15', 10);
// 波次按 UTC+8 显式换算（北京时间恒定无夏令时），不依赖服务器/进程时区
const BJ_OFFSET = 8 * 3600000;
const bjClock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
const bjFull = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
const nextWaveAt = (from = Date.now()) => {
  if (!WAVE_HOURS.length) return from + 6 * 3600 * 1000;   // 未配置波次 → 旧的 6h 行为
  const bj = new Date(from + BJ_OFFSET);
  const bjMidnightUTC = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  for (let day = 0; day < 2; day++) for (const h of WAVE_HOURS) {
    const t = bjMidnightUTC + day * 86400000 + h * 3600000 - BJ_OFFSET;
    if (t > from) return t + WAVE_OFFSET_MIN * 60000;
  }
  return from + 6 * 3600 * 1000;
};
// 刷新个人任务（2026-09-19 实测对话流）：全员收官且完成数<5 → 回第一个角色点「刷新个人任务」
// 成功=直接返回全新任务列表（无确认）；今天已刷=say「只能刷新 1 次。」
let refreshTried = false, refreshUsed = false, pendingRefresh = false, refreshOnlySlot = null;
// 对话冻结自愈（2026-09-21 完美和尚6 实录：侧步 3 次纹丝不动 + NPC 对话 3 次无响应 = 实体冻结/半死会话，
// 旧逻辑误判「无可接任务」白跳角色）：三次对话超时 → 回选角页强制重进同一角色，最多 2 次
let reentrySlot = null;        // 回选角后 char_list 强制选中该 slot
const reentryFails = {};       // slot → 已重进次数
const deadlineAt = Date.now() + OPT.deadlineMin * 60 * 1000;  // 账号级完成任务数（NPC 口中'完成任务次数'）

function scheduleRelogin(ms, reason) {
  const seq = ++loginSeq;
  ui(`${reason}，${Math.round(ms / 1000)}s 后重试`, 'warn');
  setTimeout(() => { if (seq === loginSeq) startLogin(); }, ms);
}
function startLogin() {
  clearTimeout(loginTimer);
  loginTimer = setTimeout(() => {
    ui('45s 无响应（会话残留/占用），长退避', 'warn');
    try { c.closeAllSockets(); } catch (_) {}
    scheduleRelogin(5 * 60 * 1000, '登录挂起');
  }, 45000);
  c.login().catch((e) => { clearTimeout(loginTimer); scheduleRelogin(15000, '登录异常 ' + e.message); });
}
c.on('login_ok', (p) => {
  loginSeq = 0; srvDownCount = 0; clearTimeout(loginTimer);
  const srv = p.ServerList[0];
  if (!srv) { ui('无角色服务器'); process.exit(1); }
  ui(`登录成功 AID=${p.AID}`, 'ok');
  ev({ t: 'account', account: OPT.account, password: OPT.password, mode: 'bounty' });
  c.connectChar(srv.ipStr, srv.port).catch(() => scheduleRelogin(90000, '连角色服失败'));
  const clTimer = setTimeout(() => {
    if (c.state === 'char') { ui('30s 未收到角色列表（账号会话残留）', 'warn'); try { c.closeAllSockets(); } catch (_) {} scheduleRelogin(5 * 60 * 1000, '角色列表超时'); }
  }, 30000);
  c.once('char_list', () => clearTimeout(clTimer));
});
let srvDownCount = 0;
c.on('login_refuse', (p) => {
  clearTimeout(loginTimer);
  // code=1 疑似服务器宕机：两次后 10 分钟间隔循环探测（宕机期频繁重登有风险）
  if (p.ErrorCode === 1 || p.ErrorCode === 3) {
    srvDownCount++;
    if (srvDownCount >= 2) return scheduleRelogin(10 * 60 * 1000, `☢ code=${p.ErrorCode} ×${srvDownCount} 疑似宕机，10 分钟探测`);
  }
  // code=8（挤号中）/code=2：10s 一次连续挤号；code=0（进场锁/残留会话）：长退避
  const ms = (p.ErrorCode === 8 || p.ErrorCode === 2) ? 10000 : (p.ErrorCode === 0 ? 5 * 60 * 1000 : 15000);
  scheduleRelogin(ms, `被拒 code=${p.ErrorCode}`);
});
c.on('banned', (p) => {
  if (cur && !rotating) {
    entryFails[cur.slot] = (entryFails[cur.slot] || 0) + 1;
    ui(`slot${cur.slot} ${cur.name} 进图失败×${entryFails[cur.slot]}${entryFails[cur.slot] >= 3 ? '（跳过该角色）' : ''}`, 'warn');
    cur = null;
  }
  if (rotating) return;
  const ms = p.code === 8 ? 10000 : p.code === 2 ? 30000 : p.code === 0 ? 5 * 60 * 1000 : 60000;
  scheduleRelogin(ms, `被踢 code=${p.code}${p.code === 0 ? '（进场锁，长退避）' : p.code === 8 ? '（挤号，10s 连续）' : ''}`);
});
c.on('disconnect', () => { if (!rotating) scheduleRelogin(30000, '连接断开（30s 重进）'); });
c.on('charserver_fail', () => { if (!rotating) scheduleRelogin(20000, '重连角色服连续失败'); });   // 切角重连 3 次失败 → 完整重登
// 角色服列表看门狗：连上 45s 无角色列表 → 完整重登（防切角后列表不来挂死）
// 2026-09-21 修正：不再要求 state==='char'——角色服 socket 死掉后 state='closed'，旧守卫会静默跳过
// （xiezixing11 同款挂死路径；rotating 中也不拦：切角本身就是该看门狗要兜的场景）
let clw = null;
c.on('char_connect', () => {
  clearTimeout(clw);
  clw = setTimeout(() => {
    if (c.state === 'login') return;   // 已有完整重登在进行
    scheduleRelogin(15000, `角色列表超时看门狗（state=${c.state}）`);
  }, 45 * 1000);
});
c.on('char_list', () => clearTimeout(clw));
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => scheduleRelogin(10000, '连图失败')));
c.on('char_refuse', () => scheduleRelogin(20000, '选角被拒'));
c.on('map_enter', (p) => {
  if (!cur) return;
  ui(`${cur.name} 进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]})`, 'walk');
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  setTimeout(() => {
    if (pendingRefresh) {
      pendingRefresh = false;
      doRefresh().catch((e) => { ui('刷新流程异常: ' + e.message, 'warn'); summary(); });
      return;
    }
    charLoop().catch((e) => {
    ui('charLoop 异常: ' + e.message, 'warn');
    if (e.message === 'NO_NPC') { scheduleRelogin(30000, '服务器抽风，30s 后重进'); return; }
    nextChar('异常');
    });
  }, 0);
});
c.on('warp_map', (p) => {
  bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos);
  ui(`已传送 ${p.mapName} @(${p.xPos},${p.yPos})`, 'fly');
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500);
});
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));

const entryFails = {};
c.on('char_list', (p) => {
  const chars = p.chars || [];
  if (!chars.length) { ui('无角色'); process.exit(1); }
  const done = new Set(records.map((r) => r.slot));
  const skip = new Set((process.env.RO_SKIP_SLOTS || '').split(',').filter((x) => x !== '').map((x) => parseInt(x, 10)));
  const onlySlot = process.env.RO_ONLY_SLOT == null ? null : Number(process.env.RO_ONLY_SLOT);
  const allowed = (slot) => !skip.has(slot) && (onlySlot == null || slot === onlySlot);
  const minLv = parseInt(process.env.RO_MIN_LEVEL || '30', 10);   // 赏金任务需 30 级（用户实测 Lv1 接不了）
  const held = heldLoad();
  // 对话冻结自愈：强制重进同一角色（不计 done、不换角色——该角色任务状态原样重来）
  if (reentrySlot != null) {
    const rc = chars.find((ch) => ch.CharNum === reentrySlot && allowed(ch.CharNum));
    reentrySlot = null;
    if (rc) {
      cur = { slot: rc.CharNum, name: rc.name, level: rc.level, accepted: [], completed: [], failed: [], banned: new Set(), tasks: 0 };
      entryFails[rc.CharNum] = 0;
      ui(`🔄 重进 ${rc.name}(slot${rc.CharNum})（对话冻结自愈）`, 'npc');
      c.session.charName = rc.name;
      c.zeny = rc.money != null ? rc.money : c.zeny;
      ev({ t: 'char', name: rc.name, slot: rc.CharNum, level: rc.level, done: 0, total: chars.filter((ch) => ch.level >= 30).length });
      c.selectChar(rc.CharNum, rc.money);
      return;
    }
    ui(`重进 slot${rc ? rc.CharNum : '?'} 角色不在列表 → 按正常顺序选角`, 'warn');
  }
  const next = chars.filter((ch) => !done.has(ch.CharNum) && allowed(ch.CharNum) && ch.level >= minLv &&
      (refreshOnlySlot == null || ch.CharNum === refreshOnlySlot) &&   // 刷新二轮：只有点刷新的角色有新任务（实测刷新仅重置当前角色列表）
      (entryFails[ch.CharNum] || 0) < 3)
    .sort((a, b) => a.CharNum - b.CharNum)[0]
    || (held && !pendingRefresh && !done.has(held.slot) && allowed(held.slot) && (entryFails[held.slot] || 0) < 3
      ? chars.find((ch) => ch.CharNum === held.slot) : null);   // 已收官的角色绝不重选（防死循环）
  if (next && held && next.CharNum === held.slot && !done.has(held.slot))
    ui(`📌 恢复：${held.name}(slot${held.slot}) 身上有未完成任务「${(held.task || '?').slice(0, 24)}」→ 优先处理`, 'warn');
  if (!next) {
    const lowLv = chars.filter((ch) => ch.level < minLv).map((ch) => `${ch.name}(Lv${ch.level})`);
    // 全员收官但完成数 < 5（NPC：完成5次任务额外报酬）→ 回第一个角色刷新任务，成功则全员重接
    const firstEligible = chars.filter((ch) => allowed(ch.CharNum) && ch.level >= minLv && (entryFails[ch.CharNum] || 0) < 3)
      .sort((a, b) => a.CharNum - b.CharNum)[0];
    if (process.env.RO_NO_REFRESH !== '1' && accountDone < 5 && !refreshTried && firstEligible && Date.now() < deadlineAt - 6 * 60 * 1000) {
      refreshTried = true;
      pendingRefresh = true;
      ui(`完成数 ${accountDone}/5 不足 → 回 [slot${firstEligible.CharNum}] ${firstEligible.name} 刷新个人任务`, 'npc');
      cur = { slot: firstEligible.CharNum, name: firstEligible.name, level: firstEligible.level, accepted: [], completed: [], failed: [], banned: new Set(), tasks: 0 };
      c.session.charName = firstEligible.name;
      c.zeny = firstEligible.money != null ? firstEligible.money : c.zeny;
      c.selectChar(firstEligible.CharNum, firstEligible.money);
      return;
    }
    if (refreshUsed) ui('今天已刷新过（只能刷新 1 次），完成数不足 5 也收官', 'warn');
    if (lowLv.length) ui(`低等级角色跳过（<Lv${minLv} 接不了任务）: ${lowLv.join(' ')}`, 'warn');
    return summary(chars);
  }
  cur = { slot: next.CharNum, name: next.name, level: next.level, accepted: [], completed: [], failed: [], banned: new Set(), tasks: 0 };
  entryFails[next.CharNum] = 0;
  ui(`[${records.length + 1}/${chars.length}] ${next.name} (slot${next.CharNum} Lv${next.level})`, 'npc');
  c.session.charName = next.name;
  c.zeny = next.money != null ? next.money : c.zeny;   // 初始 zeny：选角块 money（0x00B1 负责后续变更）
  ev({ t: 'char', name: next.name, slot: next.CharNum, level: next.level, done: 0, total: chars.filter((ch) => ch.level >= 30).length });
  c.selectChar(next.CharNum, next.money);
});

// ---------- 常驻商人供给（未知采集物的免费取货路线，2026-09-21 用户规则）----------
// 适用范围：parseCollect 认不出的采集物（如商人自囤的香菇芽孢）——空瓶/玩偶/宝石三类固定 NPC 购买不变；
// 接取门槛：商人已上架（/stock 有价）且有货（数量够任务）才接；取货时数量不够/失败 → 直接放弃任务，不回退 NPC
const MULE_SPOT = [181, 85];                        // 商人摊位（morocc）
const muleStock = { at: 0, items: new Map(), online: false };   // /stock 缓存（picker 同步读）
async function refreshMuleStock() {
  if (!OPT.muleKey) return;
  const st = await httpJson('GET', `${OPT.muleUrl}/stock`);
  if (!st) return;
  muleStock.at = Date.now(); muleStock.online = !!st.online;
  muleStock.items = new Map((st.items || []).map((i) => [i.ITID, { count: i.count, name: i.name }]));
}
function muleHas(ITID, qty) {
  if (!OPT.muleKey || !muleStock.online) return false;
  if (Date.now() - muleStock.at > 3 * 60 * 1000) { refreshMuleStock(); return false; }   // 缓存过期：后台刷新，本轮按无货处理
  return (muleStock.items.get(ITID) || { count: 0 }).count >= qty;
}
// 未知采集物 × 商人目录匹配：任务文本含商人上架物品名（前缀守卫防子串误配）→ { name, ITID, shop:'mule', qty }
// qty 优先从描述行（"收集脑管 * 2"，选单文本无数字）——曾默认 5 导致真实需求 2 却交易 5 个（2026-09-21 用户实测）
function muleMatchTask(text, qtySource) {
  if (!OPT.muleKey || !muleStock.online) return null;
  const norm = (v) => String(v || '').replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d))).replace(/ｘ/g, 'x').replace(/＊/g, '*');
  const t = norm(text).replace(/收集|采集|缴纳/g, ' ');
  for (const [ITID, ent] of muleStock.items) {
    const nm = ent.name;
    if (!nm) continue;
    const idx = t.indexOf(nm);
    if (idx < 0) continue;
    if (idx > 0 && /[一-龥]/.test(t[idx - 1])) continue;   // 前贴汉字 = 是别的物品名的子串
    let qty = null;
    for (const src of [qtySource, text]) {
      const qm = norm(src).match(/[×xX*]\s*(\d+)|(\d+)\s*(?:个|颗|枚|块)/);
      if (qm) { qty = parseInt(qm[1] || qm[2], 10); break; }
    }
    return { name: nm, ITID, shop: 'mule', qty: qty || 5 };
  }
  return null;
}
// 向常驻商人免费取采集物品：① /stock 复核上架+有货 ② 走到摊位（商人视野内）③ /trade 下单（X-Api-Key→免费）
// ④ 商人主动发起交易 → 我方接受 → 对方放货 → 我方锁定 → 对方锁定执行 → ⑤ 校验背包到账
async function muleFetch(col, need) {
  try {
    await refreshMuleStock();
    if (!muleStock.online) { ui('商人不在线 → 商店购买', 'warn'); return false; }
    const cnt = (muleStock.items.get(col.ITID) || { count: 0 }).count;
    if (cnt < need) { ui(`商人 ${col.name} 货不足（有×${cnt}/需×${need}）→ 商店购买`, 'warn'); return false; }
    if (!(await gotoMap('morocc', MULE_SPOT[0], MULE_SPOT[1]))) return false;
    const headers = { 'X-Api-Key': OPT.muleKey };
    const current = await httpJson('GET', `${OPT.muleUrl}/status`, null, headers);
    const stand = current && current.online && String(current.map || '').startsWith('morocc') && Array.isArray(current.pos)
      ? current.pos : MULE_SPOT;
    const spots = approachSpots(stand, (x, y) => !bot.gat || bot.gat.walkable(x, y)).slice(0, 4);
    if (!spots.length) { ui('商人周围没有可走格，放弃取货', 'warn'); return false; }
    const before = (c.inventory || []).filter((it) => it.ITID === col.ITID).reduce((sum, it) => sum + (it.count || 1), 0);
    const outcome = await retryMuleExchange({
      center: stand, spots,
      position: () => c.position || bot.pos || [0, 0],
      walk: async (spot, attempt, total) => {
        ui(`↔ 商人交易第 ${attempt + 1}/${total} 次：走到 (${spot[0]},${spot[1]})`, 'walk');
        await walkTo(spot[0], spot[1], 30000);
        await sleep(500);
      },
      onFailure: (result) => ui(`商人交易失败: ${result.reason || '未知原因'}`, 'warn'),
      slotIsFree: async () => {
        for (let i = 0; i < 16; i++) {
          const state = await httpJson('GET', `${OPT.muleUrl}/status`, null, headers);
          if (!state || state.order) return false;
          if (state.state === 'idle') return true;
          await sleep(250);
        }
        return false;
      },
      // 先安装交易事件监听，再 POST /trade；商人可能在 HTTP 响应到达前发游戏交易请求。
      exchange: () => receiveMuleTrade({
        client: c, ITID: col.ITID, qty: need, timeoutMs: 40000, pollMs: 500,
        send: (packet) => c.send(packet), build: BUILD,
        requestOrder: () => httpJson('POST', `${OPT.muleUrl}/trade`, {
          buyer: c.session.charName, name: col.name, ITID: col.ITID, qty: need,
          aid: c.session.AID, gid: c.session.GID, buyerGID: c.session.GID, buyerAID: c.session.AID,
        }, headers, 15000),
        readStatus: () => httpJson('GET', `${OPT.muleUrl}/status`, null, headers),
        cancelOrder: async (id) => {
          const canceled = await httpJson('POST', `${OPT.muleUrl}/cancel`, { id }, headers);
          if (!canceled || !canceled.ok) throw new Error('商人订单取消未确认');
        },
        log: (message) => ui(message, 'npc'),
      }),
    });
    if (!outcome.ok) { ui(`商人取货结束: ${outcome.reason || '交易失败'}`, 'warn'); return false; }
    // receiveMuleTrade 已核实本单放货、双方锁定及买家 result=0；缺少新背包索引只影响本地缓存。
    // 不虚构索引，也不把已成交订单重试/放弃；回 NPC 让服务器核验真实背包并交任务。
    const delivery = settleMuleDelivery(c.inventory || (c.inventory = []), col.ITID, before, need, outcome);
    if (!delivery.delivered) return false;
    if (!delivery.locallyTracked) ui('⚠ 成交成功但新物品索引未同步；不改本地背包，回赏金 NPC 由服务器核验并提交', 'warn');
    ui(`✅ 商人交易完成: ${col.name}×${need} → 回赏金 NPC`, 'ok');
    return true;
  } catch (e) { ui(`商人取货异常: ${e.message}`, 'warn'); return false; }
}
// ---------- 工具 ----------
function httpJson(method, url, body, headers, timeoutMs = 4000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const hdr = { ...(headers || {}) };
      let payload = null;
      if (body != null) { payload = JSON.stringify(body); hdr['Content-Type'] = 'application/json'; hdr['Content-Length'] = Buffer.byteLength(payload); }
      const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: hdr, timeout: timeoutMs }, (r) => {
        let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve(null); } });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      if (payload != null) req.write(payload);
      req.end();
    } catch (_) { resolve(null); }
  });
}
const waitMap = async (m, ms = 15000) => {
  for (let i = 0; i < ms / 500; i++) { await sleep(500); if ((c.mapName || '').includes(m)) return true; }
  return false;
};
// ---------- 死亡自愈（2026-09-21 pay_dun00 实录）----------
// 死亡语义：可对话、不可移动、不可登艇——表象=落地后巡路/侧步纹丝不动 50s + NPC 对话正常完成 +
// 飞艇 20s×2 无响应（此前只能靠完全重登自愈）。判定=hp 0 且 maxhp>0（hunter.js 同款）
const isDead = () => { const S = c.stats || {}; return S.maxhp > 0 && S.hp === 0; };
// CZ.RESTART type=0 = 回存档点复活；复活传送会触发 warp_map → bot 地图缓存自动刷新
async function reviveAtSave(reason) {
  ui(`💀 角色死亡（${reason}）→ 返回出生点复活`, 'warn');
  ev({ t: 'phase', msg: '角色死亡，回出生点复活' });
  try {
    const w = new (require(path.join(__dirname, 'roclient/lib/binary')).BinaryWriter)(3);
    w.writeShort(0x00B2); w.writeUChar(0);
    c.send(w.buffer);
  } catch (e) { ui('复活包发送失败: ' + e.message, 'warn'); return false; }
  const before = c.mapName || '';
  for (let i = 0; i < 20 && (c.mapName || '') === before; i++) await sleep(1000);   // 等复活传送（最多 20s）
  await sleep(2000);
  bot.updatePos(c.position[0], c.position[1]);
  ui(`复活于 ${c.mapName} @(${(c.position || []).slice(0, 2)})`, 'ok');
  return true;
}
// 走两步探活（用户建议 2026-09-21）：站位/半死状态可能卡飞艇——走动后位置有变化再重飞
async function stepProbe() {
  try {
    const [px, py] = c.position || [0, 0];
    const dx = Math.random() < 0.5 ? 2 : -2;
    try { c.send(BUILD.requestMove(px + dx, py)); } catch (_) {}
    await sleep(1600);
    try { c.send(BUILD.requestMove(px, py)); } catch (_) {}
    await sleep(1600);
    const [nx, ny] = c.position || [0, 0];
    bot.updatePos(nx, ny);
    ui(`探活走步 (${px},${py})→(${nx},${ny})${nx === px && ny === py ? '（未移动）' : ''}`, 'walk');
    return nx !== px || ny !== py;
  } catch (_) { return false; }
}
// 飞艇 + 等到达：20s 判定窗口；未确认先查死亡（死亡不能登艇→复活后重飞），再走两步探活后重发
// 血量整备（2026-09-21 用户规则）：飞洞穴前 HP 至少 60%——一瓶瓶喝到位再出发；无药水则带伤出发（有死亡自愈兜底）
async function ensureHp(minPct = 0.6) {
  for (let i = 0; i < 15; i++) {
    const S = c.stats || {};
    if (!S.maxhp || S.hp / S.maxhp >= minPct) return true;
    const pot = (c.inventory || []).find((x) => x.ITID === POTION_ID);
    if (!pot) { ui(`⚠ HP ${S.hp}/${S.maxhp} 低于${Math.round(minPct * 100)}% 且无红色药水 → 带伤出发`, 'warn'); return false; }
    try { c.send(BUILD.useItem(pot.index, c.session.AID)); ui(`🧪 HP ${S.hp}/${S.maxhp} → 喝红色药水`, ''); } catch (_) {}
    await sleep(2200);   // 药效间隔
  }
  const S = c.stats || {};
  ui(`⚠ 喝药 15 次仍 ${S.hp}/${S.maxhp} → 带伤出发`, 'warn');
  return false;
}
async function flyAndWait(map, x, y, ms = 20000) {
  for (let i = 0; i < 2; i++) {
    try { c.airshipTeleport(map, x, y); } catch (e) { ui('飞艇发送失败', 'warn'); return false; }
    if (await waitMap(map, ms)) return true;
    if (isDead()) { if (!(await reviveAtSave(`飞艇到 ${map} 未确认`))) return false; continue; }   // 复活后用下一轮重飞
    ui(i === 0 ? `到 ${map} 未确认（20s）→ 走两步探活后重发飞艇` : `到 ${map} 失败`, 'warn');
    await stepProbe();
    await sleep(2000);
  }
  return false;
}
async function gotoMap(map, x, y, cave) {
  if ((c.mapName || '').replace(/\.gat$/i, '') === map) { ui(`已在 ${map}`, 'walk'); return true; }
  if (cave) {
    // 首选：卷轴+飞艇直传（落点=目标坐标，避免洞内长距离寻路——iz_dun00 实测 A* 失败）；
    // 没卷轴先找道具商人买（zeny 不够才走物理入口兜底）
    if (await ensureScroll(1)) {
      await ensureHp(0.6);   // 用户规则（2026-09-21）：进洞前 HP 至少 60%，防落地被围殴致死
      ui(`飞艇 → ${map} (${x},${y})（洞穴卷轴直传）`, 'fly');
      if (await flyAndWait(map, x, y)) { await sleep(2200); bot.updatePos(c.position[0], c.position[1]); return true; }
      ui('卷轴直传未到达，试物理入口', 'warn');
    }
    const entry = CAVE_ENTRIES[map];
    if (!entry) { ui(`洞穴 ${map} 无卷轴且无物理入口，放弃`, 'warn'); return false; }
    ui(`飞艇 → ${entry.map} (${entry.x},${entry.y}) 踩入口格`, 'fly');
    try { c.airshipTeleport(entry.map, entry.x, entry.y); } catch (e) { return false; }
    if (!(await waitMap(map, 12000))) { if (!(await waitMap(entry.map, 6000))) return false; ui('入口未触发，回退卷轴', 'warn'); return (await gotoMap(map, x, y, false)); }
    await sleep(3000);
    bot.updatePos(c.position[0], c.position[1]);
    return true;
  }
  ui(`飞艇 → ${map} (${x},${y})`, 'fly');
  if (!(await flyAndWait(map, x, y))) {
    // 2026-09-21 修复：飞艇失败说明会话状态异常（可能被传到未知图/半死状态）
    // 直接切角会触发 code=0 锁号 → 必须完全重登恢复
    ui('❌ 飞艇失败 → 会话异常，完全重登自愈（不切角！）', 'warn');
    throw new Error('NAV_FAIL');
  }
  await sleep(2200);
  bot.updatePos(c.position[0], c.position[1]);
  return true;
}
async function walkTo(x, y, t = 45000) {
  ui(`巡路 → (${x},${y})`, 'walk');
  await new Promise((res) => {
    let done = false, reviving = false, poll = null, guard = null;
    const finish = () => { if (!done) { done = true; if (poll) clearInterval(poll); if (guard) clearTimeout(guard); res(); } };
    bot.walkSmart(x, y, finish, t);
    // 死亡巡检（3s 一次）：死亡时巡路永不完成（侧步都发不动），干等超时白烧 45-60s——检测到立即复活终止本段
    poll = setInterval(async () => {
      if (reviving || !isDead()) return;
      reviving = true;
      ui(`💀 巡路中死亡 → 放弃本段寻路 (${x},${y})，先复活`, 'warn');
      await reviveAtSave('巡路中');
      finish();
    }, 3000);
    guard = setTimeout(finish, t + 500);   // 双保险清理（walkSmart 回调通常先到）
  });
  await sleep(300);
}
async function scanNpc(re, rounds = 3) {
  for (let i = 0; i < rounds; i++) {
    const hit = [...c.entities.values()].find((e) => e.kind === 'npc' && re.test(e.name || ''));
    if (hit) return hit;
    const unnamed = [...c.entities.values()].filter((n) => n.kind === 'npc' && !n.name);
    if (unnamed.length) unnamed.forEach((n) => c.reqName(n.GID));
    await sleep(1000);
  }
  return [...c.entities.values()].find((e) => e.kind === 'npc' && re.test(e.name || ''));
}

// ---------- 对话状态机 ----------
// picker(sayText, options) → 数字(1起) 或 0(不选) ；返回 -1 结束
// 状态机修复（2026-09-16 16:40 竞态实锤）：服务器会一口气发 say→wait→menu，
// 定时 nextDialog 若落在 menu 状态会打断对话 → 后续 chooseMenu 被无声忽略。
// 规则：菜单到达即取消未发的 next；next 只在仍处 wait 态时发送。
function talkFlow(npcGID, picker, timeoutSec = 25, onSayCb = null, openSec = 0) {
  return new Promise((resolve) => {
    let resolved = false, timedOut = false, lastSay = '', lastEventAt = Date.now(), opened = false;
    let menuRetry = null, pendingNext = null, dstate = 'idle';
    const done = () => {
      if (resolved) return; resolved = true;
      if (menuRetry) clearTimeout(menuRetry);
      if (pendingNext) clearTimeout(pendingNext);
      cleanup(); setTimeout(() => resolve({ timeout: timedOut }), 500);
    };
    const clearNext = () => { if (pendingNext) { clearTimeout(pendingNext); pendingNext = null; } };
    const markEvent = (why) => {
      opened = true;
      lastEventAt = Date.now();
      if (menuRetry) { ui(`⏲ 看门狗取消(${why})`, ''); clearTimeout(menuRetry); menuRetry = null; }
    };
    const sendChoice = (gid, num) => { clearNext(); try { c.chooseMenu(gid, num); } catch (_) {} };
    const onSay = (p) => {
      markEvent("say"); dstate = 'say';
      const clean = (p.msg || '').replace(/\^([0-9a-fA-F]{6})/g, '').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      lastSay = clean;
      ui(`💬 ${clean.slice(0, 110)}`, 'npc');
      if (onSayCb) try { onSayCb(clean); } catch (_) {}
    };
    const onMenu = (p) => {
      markEvent("menu"); dstate = 'menu'; clearNext();   // ★ 菜单到达，取消一切未发的 next
      const choice = picker(lastSay, p.options, p.gid);
      if (choice === -1) {
        ui(`📋 ${p.options.join(' | ').slice(0, 130)} → 无可选项，关闭`, 'npc');
        setTimeout(() => { try { c.closeDialog(p.gid); } catch (_) {} }, 300);
        setTimeout(() => { if (!resolved) { ui('⏲ close 无应答，强制结束对话', ''); done(); } }, 2800);
        return;
      }
      if (choice > 0) {
        ui(`📋 ${p.options.join(' | ').slice(0, 120)} → [${choice}]${p.options[choice - 1] ? ' ' + p.options[choice - 1] : ''}`, 'npc');
        setTimeout(() => {
          sendChoice(p.gid, choice);
          ui(`⏲ 已发选择[${choice}]，布防看门狗 4.5s`, '');
          menuRetry = setTimeout(() => {
            menuRetry = null;
            if (resolved) return;
            if (Date.now() - lastEventAt >= 4400) {
              ui('⚠ 选择无响应，重发菜单选择', 'warn');
              sendChoice(p.gid, choice);
            }
          }, 4500);
        }, 500);
      } else {
        ui(`📋 ${p.options.join(' | ').slice(0, 120)} → 关闭`, 'npc');
        setTimeout(() => { try { c.closeDialog(p.gid); } catch (_) {} }, 300);
      }
    };
    const onWait = (p) => {
      markEvent("wait");
      if (dstate === 'menu') return;          // 菜单态收到 wait：串扰，忽略
      dstate = 'wait';
      clearNext();
      pendingNext = setTimeout(() => {
        pendingNext = null;
        if (dstate === 'wait' && !resolved) { try { c.nextDialog(p.gid); } catch (_) {} }   // 仍在等待态才翻页
      }, 1200);
    };
    const onClose = () => { markEvent("close"); dstate = 'closed'; done(); };
    // 原始封包探针：对话期间记录所有收包（诊断用）
    const probe = (p) => ui(`[包] 0x${p.pid.toString(16).padStart(4, '0')} ${p.pkt.length}B ${p.pkt.slice(0, 20).toString('hex')}`, '');
    let cleanup = () => {
      c.removeListener('dialog_say', onSay); c.removeListener('dialog_menu', onMenu);
      c.removeListener('dialog_wait', onWait); c.removeListener('dialog_close', onClose);
      c.removeListener('packet', probe);
    };
    c.on('dialog_say', onSay); c.on('dialog_menu', onMenu);
    c.on('dialog_wait', onWait); c.on('dialog_close', onClose);
    c.on('packet', probe);
    setTimeout(() => { timedOut = true; done(); }, timeoutSec * 1000);
    // 开窗判定（2026-09-22 落地直聊用）：openSec 内无任何对话事件 = 对话根本没开（距离不足/实体未同步）
    // ——快速失败返回 timeout:true 交回巡路，不等满全程超时
    if (openSec > 0) setTimeout(() => { if (!resolved && !opened) { timedOut = true; done(); } }, openSec * 1000);
    try { bot.talkTo(npcGID); } catch (_) { timedOut = true; done(); }
  });
}

// 菜单通用拾取：patterns 依次找，avoid 排除
function pickBy(options, patterns, avoid = /取消|返回|关闭|结束|离开|谢谢|再见|刷新个人任务|放弃/) {
  for (const re of patterns) {
    const i = options.findIndex((o) => re.test(o) && !avoid.test(o));
    if (i >= 0) return i + 1;
  }
  return 0;
}

// ---------- 卷轴 ----------
let scrollITID = null;
async function ensureScroll(n = 1) {
  const potNeed = Math.max(0, POTION_TARGET - potionCount());
  if (scrollCount() >= n && potNeed === 0) return true;     // 卷轴+药水都足才免跑商（药水不足也顺路补）
  if ((c.zeny || 0) < SCROLL_PRICE * n) {                   // 没钱买卷轴 → 快速失败不走路
    ui(`zeny=${c.zeny || 0} 不够买 ${n} 张卷轴`, 'warn');
    return false;
  }
  return await buyScrolls(n, potNeed);
}
async function buyScrolls(n = 2, potNeed = 0) {
  ui(`🏪 购买传送卷轴 ×${n}${potNeed > 0 ? ` + 红色药水补货 ×${potNeed}（补到 ${POTION_TARGET}）` : ''}`, 'npc');
  // 道具商人固定 (146,103)，真值接触格 (148,104)=商人+(2,+1)（2026-09-16 实测）
  if (!(await gotoMap('morocc', 166, 98))) return false;
  await walkTo(150, 104, 45000);          // 先走过头 2 格（保证有真实移动）
  await walkTo(148, 104, 30000);          // 真值接触格 = 商人(146,103)+(2,+1)
  await sleep(2500);
  // 对商人点附近无名 NPC 请求名字
  const near = [...c.entities.values()].filter((e) => e.kind === 'npc' && e.pos &&
    Math.abs(e.pos[0] - 146) <= 5 && Math.abs(e.pos[1] - 103) <= 5);
  near.forEach((x) => { if (!x.name) c.reqName(x.GID); });
  await sleep(2000);
  const shop = [...c.entities.values()].find((e) => e.kind === 'npc' && /道具商人/.test(e.name || ''));
  if (!shop) {
    ui('商人点无道具商人: ' + near.map((e) => `${e.name || '#' + e.GID}@(${e.pos[0]},${e.pos[1]})`).join(' ').slice(0, 150), 'warn');
    return false;
  }
  ui(`🏪 ${shop.name} @(${shop.pos[0]},${shop.pos[1]}) GID=${shop.GID}`, 'npc');
  // 真值：走到 shop+(2,+1) → 立刻 talkTo，不加多余步骤
  await new Promise((res) => bot.walkSmart(shop.pos[0] + 2, shop.pos[1] + 1, () => res(), 30000));
  await sleep(400);
  let bought = false, sawMenu = false;
  // 直弹型（2026-09-19 实测：道具商人改为接触直接回 0x00C4，不再走对话菜单）
  const onShopMenu = (p) => {
    sawMenu = true;
    ui('   🏪 直弹商店菜单 → 选购买', 'npc');
    setTimeout(() => { try { c.send(BUILD.ackSelectDealtype(p.gid, 0)); } catch (_) {} }, 400);
  };
  const onMenu = (p) => {
    sawMenu = true;
    ui(`   📋(商店菜单) ${(p.options || []).join(' | ').slice(0, 100)}`, 'npc');
    if (/(商店|购买|买|道具)/.test((p.options || []).join())) setTimeout(() => { try { c.send(BUILD.ackSelectDealtype(p.gid, 0)); } catch (_) {} }, 500);
    else setTimeout(() => { try { c.closeDialog(p.gid); } catch (_) {} }, 300);
  };
  const onItems = (p) => {
    const items = p.items || [];
    let scroll = items.find((it) => (it.discount || it.price) === 5000);
    if (!scroll && scrollITID) scroll = items.find((it) => it.ITID === scrollITID);
    if (!scroll) { ui(`商品${items.length}件无5000z卷轴`, 'warn'); return; }
    scrollITID = scroll.ITID;
    if (scrollITID !== 14527) ui(`⚠ 卷轴ITID=${scrollITID}≠14527（飞艇可能仍判定无卷轴）`, 'warn');
    const list = [{ ITID: scroll.ITID, amount: n }];
    ui(`选定卷轴 #${scroll.ITID} ${(scroll.discount || scroll.price)}z`, 'ok');
    if (potNeed > 0) {
      const pot = items.find((it) => it.ITID === POTION_ID);
      if (pot) { list.push({ ITID: POTION_ID, amount: potNeed }); ui(`+ 红色药水 #${POTION_ID} ×${potNeed}（${pot.discount || pot.price}z/瓶）`, 'ok'); }
      else ui(`⚠ 商品${items.length}件无红色药水#${POTION_ID} → 本次只买卷轴`, 'warn');
    }
    setTimeout(() => { try { c.send(BUILD.marketPurchase(list)); } catch (_) {} }, 700);
  };
  const onBuy = (p) => {
    if (p.rs === 0 || p.items.length) bought = true;
    setTimeout(() => { try { c.send(BUILD.marketClose()); } catch (_) {} }, 600);
  };
  c.on('shop_menu', onShopMenu); c.on('dialog_menu', onMenu); c.on('shop_items', onItems); c.on('purchase_result', onBuy);
  bot.talkTo(shop.GID);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    if (bought) break;
    if (i === 19 && !sawMenu) ui('   ⚠ 接触商人 10s 无任何菜单（下次重试走开再回来）', 'warn');
  }
  c.removeListener('shop_menu', onShopMenu); c.removeListener('dialog_menu', onMenu); c.removeListener('shop_items', onItems); c.removeListener('purchase_result', onBuy);
  ui(bought ? `卷轴到手 ×${n}` : `购买未确认（菜单${sawMenu ? '已到但无回执' : '无响应'}）`, bought ? 'ok' : 'warn');
  return bought;
}

// ---------- 赏金 NPC 流程 ----------
async function gotoBounty() {
  if (!(await gotoMap(OPT.homeMap, OPT.homeX, OPT.homeY))) return null;
  await sleep(1000);
  let npc = await scanNpc(/赏金/, 2);
  if (!npc) npc = [...c.entities.values()].find((e) => e.kind === 'npc' && e.pos &&
    Math.abs(e.pos[0] - 165) <= 3 && Math.abs(e.pos[1] - 97) <= 3);
  if (!npc) {
    // 存档点可能落在别处（如商人点）：先走回赏金NPC区再扫
    ui('视野内无赏金NPC，巡路回 (166,98) 再扫', 'walk');
    await walkTo(166, 98, 60000);
    await sleep(1500);
    npc = await scanNpc(/赏金/, 4);
    if (!npc) npc = [...c.entities.values()].find((e) => e.kind === 'npc' && e.pos &&
      Math.abs(e.pos[0] - 165) <= 3 && Math.abs(e.pos[1] - 97) <= 3);
  }
  if (!npc) { ui('未找到赏金NPC（服务器抽风/实体未同步）→ 重进会话', 'warn'); throw new Error('NO_NPC'); }
  // 接触落定（2026-09-16 实测接触格 = NPC+(2,+1)）；卡住三层降级（2026-09-20 用户建议）：
  // ① 正常走 ② 卡住但已在 NPC 3 格内 → 直接对话（对话状态机保证完整性） ③ 仍远 → 首都弹跳重置再走
  const ax = npc.pos[0] + 2, ay = npc.pos[1] + 1;
  if (Math.abs(bot.pos[0] - ax) + Math.abs(bot.pos[1] - ay) <= 2) {
    // 已在接触格附近：先随机走动再回（用户算法 2026-09-21：NPC 坐标 x±2/y±2 各随机一点，
    // 每次重试落点都不同——破除"每次都卡同一个定位格/实体未同步"的定点冻结）
    const rx = npc.pos[0] + Math.floor(Math.random() * 5) - 2;
    const ry = npc.pos[1] + Math.floor(Math.random() * 5) - 2;
    if (rx !== ax || ry !== ay) await walkTo(rx, ry, 15000);
  }
  await walkTo(ax, ay, 30000);
  const dn = Math.max(Math.abs((bot.pos || [9, 9])[0] - npc.pos[0]), Math.abs((bot.pos || [9, 9])[1] - npc.pos[1]));
  if (dn > 3) {
    ui(`巡路卡住（距NPC ${dn} 格）→ 首都弹跳重置`, 'warn');
    try { c.airshipTeleport('prontera', 156, 191); } catch (_) {}
    if (await waitMap('prontera', 10000)) {
      await sleep(2000);
      try { c.airshipTeleport(OPT.homeMap, OPT.homeX, OPT.homeY); } catch (_) {}
      if (await waitMap(OPT.homeMap, 10000)) {
        await sleep(2000);
        bot.updatePos(c.position[0], c.position[1]);
        await walkTo(ax, ay, 25000);
      }
    }
  }
  await sleep(400);
  return npc;   // 3 格内（或弹跳后再试过）：直接对话，位置不阻塞 talkTo
}

// 与赏金NPC对话：返回 { turnedIn, accepted }（accepted=任务选项文本或 null）
async function bountyDialog() {
  const npc = await gotoBounty();
  if (!npc) return { turnedIn: 0, accepted: null };
  cur.held = null;   // 清残留：上一轮的"身上任务"已处理，被拒时会在下方重新写入
  const turnIn = createTurnInTracker();
  let accepted = null, depth = 0, activeTask = null, refused = false, doneCount = null, descLine = '';
  const tf = await talkFlow(npc.GID, (say, options) => {
    // 账号任务上限已宣告 → 不再选任何菜单，立即关闭（后续由 charLoop 账号级收官）
    if (limitInfo) return -1;
    if (initialBountyCheck.shouldCloseMenu() && process.env.RO_ALLOW_EXISTING_PROGRESS !== '1') return -1; // 自动领号首次进场已见非零完成数，不接新任务
    // （activeTask 提取在 onSayCb 中）
    // 接取被拒（持有已完成任务未提交）：作废 accepted，避免误记
    if (accepted && /当前任务已完成|无法接取|已有任务/.test(say || '')) {
      ui(`接取被拒: ${accepted}（身上有任务待处理）`, 'warn');
      cur.held = accepted; accepted = null; refused = true;
    }
    const am = say && (say.match(/任务描述[：:]\s*([^，。\s]{2,24})/) || say.match(/任务[：:]\s*([^，。\s]{4,24})/));
    if (am && !/已完成/.test(say)) activeTask = am[1];
    const dm = say && say.match(/完成任务次数[：:]\s*(\d+)\s*次/);
    if (dm) doneCount = parseInt(dm[1], 10);
    depth++;
    if (depth > 12) return -1;
    // 提交已完成任务
    const ti = pickBy(options, [/提交|交付|完成任务|领取奖励/]);
    // 自动交回（2026-09-22 鞋子商人7 实录：物品在手时重开对话 NPC 直发「任务完成，这是你的押金和报酬。」，
    // 无「任务已完成」字样也无提交选单 → 旧逻辑不计数、heldClear 不触发、bounty-held.json 残留已交任务）
    turnIn.onMenu(say, !!ti);
    if (/任务完成.*押金和报酬/.test(say || '')) return ti || -1;
    if (/当前任务已完成|任务已完成/.test(say) && ti) return ti;
    // 顶层菜单 → 个人任务
    const pi = options.findIndex((o) => /^个人任务$/.test(o.trim()));
    if (pi >= 0) return pi + 1;
    // 已被拒（有任务在手）：直接关闭换角色处理
    if (refused) return -1;
    // 任务列表：优先级 寻找>挖宝>送信；跳过已失败黑名单与"没钱没卷轴"的洞穴任务
    const banned = (cur && cur.banned) || new Set();
    const caveable = canAffordCave();
    let best = -1, bestScore = -1;
    options.forEach((o, i) => {
      if (/（√|\(√/.test(o)) return;   // (√)=已完成/进行中：跳过；活任务由持身任务记录（bounty-held.json）的恢复路径处理——
                                        // 该路径开 NPC 对话会正常下发"任务描述：xxx * N"（数量在描述行里），无需选单介入
      if (banned.has(o)) { ui(`跳过（本轮已失败拉黑）: ${o}`, 'warn'); return; }
      if (OPT.forceCollect && !isCollectLike(o)) return;   // 测试模式（RO_FORCE_COLLECT=1）：只接采集类
      let score = -1;
      if (/(走失的|迷路的)/.test(o)) score = 4;          // 寻找
      else if (/挖宝|寻宝|宝藏/.test(o)) score = 3;       // 挖宝（任务名形如"寻找西边兽人村落的宝藏"）
      else if (isCollectLike(o)) {                        // 采集（宝石/娃娃/空瓶 → NPC 买入；未知物 → 商人供给）
        const col = parseCollect(o);
        if (col) {
          if (OPT.forceCollect) { ui(`测试模式跳过NPC供给采集: ${o}`, 'warn'); return; }   // 测试（RO_FORCE_COLLECT=1）：只跑商人路线
          // 接取前钱货检查：单价都付不起且身上无货 → 直接不接（避免"接了→没钱→回NPC放弃"白烧任务位）
          const price = COLLECT_PRICES[col.shop][col.ITID];
          const have = (c.inventory || []).filter((i) => i.ITID === col.ITID).reduce((a, b) => a + (b.count || 1), 0);
          if (price != null && (c.zeny || 0) < price && have === 0) {
            ui(`跳过采集（没钱且身上无货）: ${o}（需${price}z，zeny=${c.zeny || 0}）`, 'warn');
            return;
          }
        } else {
          // 未知采集物 × 商人目录：已上架且有货才接（免费取货路线；选单无数量信息，门槛按有货≥1 放行，
          // 实际数量在任务描述行解析，取货时不足 → 放弃）
          const m = muleMatchTask(o);
          if (!m) { ui(`跳过未支持的采集物品: ${o}`, 'warn'); return; }
          if (!muleHas(m.ITID, 1)) { ui(`跳过采集（商人未上架/无货）: ${o}`, 'warn'); return; }
        }
        score = 2;
      }
      else if (/\[送货\]|送信|送货/.test(o)) score = 1;    // 送信
      if (score < 0) return;
      const d = parseDest(o);
      if (d && d.cave && !CAVE_ENTRIES[d.map] && !caveable) {
        ui(`跳过（洞穴且没钱没卷轴）: ${o}`, 'warn');
        return;
      }
      if (score > bestScore) { bestScore = score; best = i; }
    });
    if (best >= 0) { accepted = options[best]; return best + 1; }
    // 确认接取
    const ci = pickBy(options, [/确定|接受|接取|是$/, /继续/]);
    if (ci && /接取|接受|确定/.test(options[ci - 1] || '')) return ci;
    // 没有可做的：关闭
    return -1;
  }, 25, (clean) => {
    turnIn.onSay(clean); // 自动交回时 NPC 可能只说完成话术就关窗，不再下发菜单。
    // 账号级任务上限话术（实测：「6小时内最多完成10个任务。」→ 通用化匹配 N小时/M个）
    const lm = clean.match(/(\d+)\s*小时内最多完成\s*(\d+)\s*个任务/);
    if (lm && !limitInfo) {
      limitInfo = { hours: +lm[1], max: +lm[2] };
      ui(`🛑 服务器账号任务上限：${lm[1]}小时内最多完成${lm[2]}个任务`, 'warn');
    }
    // 任务描述整行留存（挖宝坐标在其中："找到位于西边兽人村落的寻宝者(152,124)"；
    // 采集描述行含 " * N" 数量也整行留存——2026-09-22 脑管实录：只留挖宝 → r.desc 空 → 持任记录丢数量后缀）
    if (/找到位于|寻宝者|有效时间|任务描述[：:]/.test(clean)) descLine = clean;
    // 整行截取：描述含"物品 * N"数量，截到空格会丢（收集天蓝宝石 * 1 实拍）
    const am = clean.match(/任务描述[：:]\s*(.{2,40}?)\s*$/) || clean.match(/任务[：:]\s*([^，。\s]{4,24})/);
    if (am && !/已完成/.test(clean)) activeTask = am[1].trim();
    const dm = clean.match(/完成任务次数[：:]\s*(\d+)\s*次/);
    if (dm) {
      doneCount = parseInt(dm[1], 10);
      accountDone = Math.max(accountDone, doneCount);
      initialBountyCheck.observe(doneCount);
    }
  });
  // 对话超时/无响应 → 不可信（"个人任务"点击被网络吞掉时，别误判"无可接任务"跳角色）
  return { turnedIn: turnIn.count(), accepted, activeTask, desc: descLine, doneCount, held: cur.held,
    inconclusive: !initialBountyCheck.shouldCloseMenu() && turnIn.inconclusive(tf && tf.timeout), limit: limitInfo };
}

// ---------- 执行任务 ----------
async function executeTask(taskText, descHint) {
  ui(`执行任务: ${taskText}`, 'quest');
  // 采集任务：宝石/娃娃/空瓶 → NPC 商人买入（有钱买，没钱放弃）；未知采集物 → 商人免费取（上架有货才接）
  const col = parseCollect(taskText, descHint);
  if (col) return executeCollect(col);
  const mCol = muleMatchTask(taskText, descHint);
  if (mCol) return executeCollect(mCol);
  // 采集类但解析不出可买物品（大红宝石等掉落物）→ 明确失败走放弃，绝不拿近似物品充数
  if (isCollectLike(taskText)) { ui(`未支持的采集物品（无法购买，需打怪掉落）→ 放弃: ${taskText}`, 'warn'); return false; }
  let dest = parseDest(taskText);
  if (!dest) { ui('无法解析任务目标', 'warn'); return false; }
  if (dest.areaUnknown) { ui(`区域 ${dest.map} 的喵喵坐标未登记 → 跳过（测到坐标后补 AREA_SPOTS 表）`, 'warn'); return false; }
  // 洞穴任务预检：没卷轴也没钱 → 快速失败（不浪费走路/飞艇时间）
  if (dest.cave && !CAVE_ENTRIES[dest.map] && !canAffordCave()) {
    ui(`洞穴任务但没钱没卷轴（zeny=${c.zeny || 0} 卷轴=${scrollCount()}）→ 放弃该任务`, 'warn');
    return false;
  }

  // 到图：部分洞穴的 NPC 格不可作为飞艇落点，飞行坐标与目标 NPC 坐标必须分开。
  const navigation = await navigateDestination(dest, {
    gotoMap,
    isOnMap: (map) => (c.mapName || '').includes(map),
    onAlternative: (map) => ui(`备选地图 ${map}`, 'warn'),
  });
  if (!navigation.ok) return false;
  dest.map = navigation.map;
  dest.x = navigation.targetX;
  dest.y = navigation.targetY;
  // 落地直聊（2026-09-22 用户规则）：巡路暴露是洞穴死亡主因（pay_dun00 实录：卡格→被围殴→
  // 死亡后飞不动走不动）——落地先试直接对话，2.5s 开不了窗（距离/实体未同步）再巡路兜底
  await sleep(1000);
  const npcRe2 = dest.npcRe || /走失|迷路|美人鱼|大嘴鸟|老母鸡|波利|黑[喵猫]|老奶奶|女朋友|花斑[猫喵]|冒险家|帅小伙/;
  {
    let early = await scanNpc(npcRe2, 2);
    if (!early) early = [...c.entities.values()].filter((e) => e.kind === 'npc' && e.pos &&
      Math.abs(e.pos[0] - dest.x) <= 7 && Math.abs(e.pos[1] - dest.y) <= 7)[0];
    if (early) {
      ui(`目标NPC: ${early.name || '#' + early.GID} @(${early.pos[0]},${early.pos[1]}) → 落地直聊`, 'npc');
      const r = await talkFlow(early.GID, (say, options) => pickBy(options, [/接受|领取|继续|是$|确定|交|完成|帮助|带路|对话/, /.*/]), 18, null, 2.5);
      if (!r.timeout) {
        ui(`对话完成（落地直聊，免巡路）: ${taskText}`, 'ok');
        heldClear();   // 寻找/挖宝/送信在野外NPC即终局（押金报酬当场发）→ 持任记录立清
        return true;
      }
      ui('落地直聊未开窗（距离/实体未同步）→ 巡路到任务点', 'walk');
    }
  }
  // 到点（巡路兜底）
  await walkTo(dest.x, dest.y, 60000);
  await sleep(1000);
  // 找目标 NPC（按名字或坐标±7）
  let npc = await scanNpc(npcRe2, 3);
  if (!npc) {
    npc = [...c.entities.values()].filter((e) => e.kind === 'npc' && e.pos &&
      Math.abs(e.pos[0] - dest.x) <= 7 && Math.abs(e.pos[1] - dest.y) <= 7)[0];
    if (npc && !npc.name) { c.reqName(npc.GID); await sleep(1200); }
  }
  if (!npc) { ui(`目标点无NPC（坐标需修正?）`, 'warn'); return false; }
  ui(`目标NPC: ${npc.name || '#' + npc.GID} @(${npc.pos[0]},${npc.pos[1]})`, 'npc');
  // 接触落定（与赏金NPC同理：保证对话前有真实移动）
  const ax = npc.pos[0] + 2, ay = npc.pos[1] + 1;
  if (bot.pos[0] === ax && bot.pos[1] === ay) await walkTo(ax + 2, ay, 15000);
  await walkTo(ax, ay, 30000);
  await sleep(300);
  // 对话完成（接受/继续/是/完成 类选项）
  await talkFlow(npc.GID, (say, options) => pickBy(options, [/接受|领取|继续|是$|确定|交|完成|帮助|带路|对话/, /.*/]), 18);
  ui(`对话完成: ${taskText}`, 'ok');
  heldClear();   // 寻找/挖宝/送信在野外NPC即终局（押金报酬当场发）→ 持任记录立清
  return true;
}

async function abandonTask() {
  const npc = await gotoBounty();
  if (!npc) return;
  await talkFlow(npc.GID, (say, options) => {
    const pi = options.findIndex((o) => /^个人任务$/.test(o.trim()));
    if (pi >= 0) return pi + 1;
    const ai = options.findIndex((o) => /放弃/.test(o));
    if (ai >= 0) { ui(`放弃任务: ${options[ai]}`, 'warn'); return ai + 1; }
    const ci = pickBy(options, [/\u786e\u5b9a|\u662f$/]);
    if (ci) return ci;
    return -1;
  });
}

// ---------- 采集任务：买入提交 ----------
// 钱 = 单价×数量 够 → 去商人买（数量相乘）；不够 → 返回 false（上层拉黑+放弃，符合"没钱放弃"）
async function executeCollect(col) {
  const shop = COLLECT_SHOPS[col.shop] || null;   // 'mule' 类无 NPC 商店
  const price = shop ? COLLECT_PRICES[col.shop][col.ITID] : null;
  // 身上已有的不打怪重复买（空瓶等打怪会掉）：只买差额
  const have = (c.inventory || []).filter((it) => it.ITID === col.ITID).reduce((a, b) => a + (b.count || 1), 0);
  const need = Math.max(0, col.qty - have);
  const total = price ? price * need : null;
  ui(`采集: ${col.name}×${col.qty}${have ? `（身上已有×${have}）` : ''}${need === 0 ? ' → 已够数，直接提交' : price ? `，买×${need}（${price}z×${need}=${total}z）` : '（价格未知，到店看价）'}`, 'quest');
  if (need === 0) return true;
  // 商人供给类（未知采集物）：只走商人，数量不够/失败 → 放弃任务（用户规则 2026-09-21，不回退 NPC）
  if (col.shop === 'mule') return await muleFetch(col, need);
  if (total != null && (c.zeny || 0) < total) {
    ui(`zeny=${c.zeny || 0} < ${total}z（${col.name} ${price}z×${need}）→ 放弃该任务`, 'warn');
    return false;
  }
  // 到商人（gotoMap 只管跨图；同图时距离远必须走过去，2026-09-20 坑：原地扫描必失败）
  if (!(await gotoMap(shop.map, shop.x, shop.y))) return false;
  const dshop = Math.max(Math.abs((bot.pos || [0, 0])[0] - shop.x), Math.abs((bot.pos || [0, 0])[1] - shop.y));
  if (dshop > 12) { await walkTo(shop.x + 2, shop.y + 1, 45000); await sleep(800); }
  let npc = await scanNpc(shop.npc, 4);
  if (!npc) npc = [...c.entities.values()].filter((e) => e.kind === 'npc' && e.pos &&
    Math.abs(e.pos[0] - shop.x) <= 7 && Math.abs(e.pos[1] - shop.y) <= 7)[0];
  if (!npc) { ui('未找到采集商人', 'warn'); return false; }
  // 接触落定：找商人 8 邻域最近可走格（+(2,+1) 对这两商人均不可走，贴墙实测）
  let spot = null;
  for (let r = 1; r <= 2 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
      if (!dx && !dy) continue;
      if (bot.gat && bot.gat.walkable(npc.pos[0] + dx, npc.pos[1] + dy)) spot = [npc.pos[0] + dx, npc.pos[1] + dy];
    }
  }
  if (!spot) { ui('商人周围无可走格', 'warn'); return false; }
  if (bot.pos[0] === spot[0] && bot.pos[1] === spot[1]) await walkTo(spot[0] + 2, spot[1], 12000);  // 走开再回来（真实位移）
  await walkTo(spot[0], spot[1], 30000);
  await sleep(400);
  // 开商店买入（直弹 0x00C4 型；兼容菜单型兜底）
  return await new Promise((resolve) => {
    let done = false, opened = false;
    const finish = (ok, why) => {
      if (done) return; done = true; cleanup();
      ui(ok ? `✅ 已购 ${col.name}×${need}` : `购买失败: ${why}`, ok ? 'ok' : 'warn');
      setTimeout(() => resolve(ok), 400);
    };
    const buy = (items) => {
      const it = (items || []).find((x) => x.ITID === col.ITID);
      if (!it) { try { c.send(BUILD.marketClose()); } catch (_) {} return finish(false, `商品无 ${col.name}`); }
      const p = it.discount || it.price;
      COLLECT_PRICES[col.shop][col.ITID] = p;   // 运行时自刷新价格表
      if ((c.zeny || 0) < p * need) { try { c.send(BUILD.marketClose()); } catch (_) {} return finish(false, `zeny=${c.zeny} < ${p}×${need}`); }
      ui(`商店价 ${col.name}=${p}z ×${need}=${p * need}z → 购买`, 'npc');
      setTimeout(() => { try { c.send(BUILD.marketPurchase([{ ITID: col.ITID, amount: need }])); } catch (e) { finish(false, e.message); } }, 500);
    };
    const onShopMenu = (p) => { opened = true; setTimeout(() => { try { c.send(BUILD.ackSelectDealtype(p.gid, 0)); } catch (_) {} }, 400); };
    const onMenu = (p) => {
      opened = true;
      if (/(商店|购买|道具)/.test((p.options || []).join())) setTimeout(() => { try { c.send(BUILD.ackSelectDealtype(p.gid, 0)); } catch (_) {} }, 400);
    };
    const onItems = (p) => buy(p.items);
    const onBuy = (p) => {
      if (p.rs === 0 || p.items.length) {
        try { c.send(BUILD.marketClose()); } catch (_) {}
        try { fs.writeFileSync(path.join(__dirname, 'data', 'collect-shops.json'), JSON.stringify({ ...COLLECT_PRICES, updatedAt: new Date().toISOString() }, null, 2)); } catch (_) {}
        finish(true);
      } else { try { c.send(BUILD.marketClose()); } catch (_) {} finish(false, `rs=${p.rs}`); }
    };
    const cleanup = () => {
      c.removeListener('shop_menu', onShopMenu); c.removeListener('dialog_menu', onMenu);
      c.removeListener('shop_items', onItems); c.removeListener('purchase_result', onBuy);
    };
    c.on('shop_menu', onShopMenu); c.on('dialog_menu', onMenu);
    c.on('shop_items', onItems); c.on('purchase_result', onBuy);
    bot.talkTo(npc.GID);
    setTimeout(() => finish(false, opened ? '商店无响应' : '接触无响应'), 15000);
  });
}

// ---------- 刷新个人任务（实测对话流 2026-09-19）----------
// 个人任务 → 子菜单最后一项「刷新个人任务」→ 成功：直接回全新任务列表；今天已刷：say「只能刷新 1 次。」
async function doRefresh() {
  await sleep(2000);
  const npc = await gotoBounty();
  if (!npc) { ui('刷新流程找不到赏金NPC'); return summary(); }
  let clicked = false, sawReject = false, sawNewMenu = false;
  await talkFlow(npc.GID, (say, options) => {
    if (/只能刷新/.test(say || '')) { sawReject = true; return -1; }   // 今天已刷过
    if (clicked && options.some((o) => /刷新个人任务/.test(o))) { sawNewMenu = true; return -1; }   // 刷新后的新列表
    const j = options.findIndex((o) => /刷新个人任务/.test(o));
    if (j >= 0) { clicked = true; return j + 1; }
    const p = options.findIndex((o) => /^个人任务$/.test(o.trim()));
    if (p >= 0) return p + 1;
    return -1;
  }, 30);
  if (sawNewMenu && !sawReject) {
    // 实测：刷新仅重置当前角色列表 → 二轮只重跑该角色，其余照旧跳过。
    // 2026-09-23 空指针实录：nextChar('刷新成功') 内部会置 cur=null（刷新交接切角），
    // 之后再读 cur.name 必崩 → doRefresh.catch 里 summary() 把整轮提前收官，二轮永远不执行
    // （表象：刷新成功了却没接任务直接退出）
    const rn = cur.name;
    refreshOnlySlot = cur.slot;
    nextChar('刷新成功');
    save();
    ui(`✅ 刷新成功 → 仅 [${rn}] 重跑新任务列表`, 'ok');
    return;
  }
  refreshUsed = true;
  ui(sawReject ? '今天已刷新过（只能刷新 1 次）→ 收官' : '刷新未确认 → 收官', 'warn');
  return summary();
}

// ---------- 单角色主循环 ----------
async function charLoop() {
  await sleep(2000);
  bot.updatePos(c.position[0], c.position[1]);
  refreshMuleStock();   // 商人库存缓存预热（选单接取门槛要用；fire-and-forget）
  const charStart = Date.now();
  for (let round = 0; round < OPT.maxTasksPerChar * 2; round++) {
    if (OPT.charBudgetMs > 0 && Date.now() - charStart > OPT.charBudgetMs) { ui(`${cur.name} 单角色时限到`, 'warn'); return nextChar('单角色时限'); }   // 默认关闭：买到任务物品必须走完提交再切角色
    // 1) 回赏金 NPC 对话（提交+接取）
    let r;
    try {
      r = await bountyDialog();
      for (let retry = 0; retry < 2 && r && r.inconclusive; retry++) {
        ui(`⚠ 对话超时无响应（网络抖动?），第 ${retry + 2}/3 次重新对话`, 'warn');
        await sleep(2000);
        r = await bountyDialog();
      }
    } catch (e) {
      if (e.message === 'NAV_FAIL') {
        ui('🛑 导航失败 → 断开全部连接 + 30s 后完全重登（恢复会话状态）', 'warn');
        try { c.closeAllSockets(); } catch (_) {}
        scheduleRelogin(30000, '导航失败自愈');
        return;   // 不切角！等重登后重新进同一角色
      }
      throw e;
    }
    const initial = initialBountyCheck.finishDialogue(r && r.inconclusive);
    if (initial && initial.skip && process.env.RO_ALLOW_EXISTING_PROGRESS !== '1') {
      limitMap[OPT.account] = nextWaveAt();
      ui(`⏭ 首个角色对话发现服务器已完成 ${initial.count} 次任务 → 本波不再接任务，换下一个账号`, 'warn');
      ev({ t: 'phase', msg: `服务器本波已有 ${initial.count} 次完成记录，跳过本账号` });
      save();
      return summary(initial.tasksToRecord); // 已有完成次数不属于本次 worker，工作台不得重复计入任务数
    }
    // 账号级任务上限·双重判定（2026-09-21 服务器规则：6小时内最多完成10个任务）：
    // ① NPC 话术「N小时内最多完成M个任务」（实测 00:43，仅在尝试接取时出现）
    // ② 账号完成数兜底：对话报出的「完成任务次数」（实测为账号级窗口计数，跨角色保持、非历史累计）≥ 上限时，
    //    即使话术没出现（撞上限后列表常剩垃圾任务→不接取→话术不再触发）也直接收官
    // 任一命中 → 本账号所有角色都不再做，收官下线（工作台收到 exit 0 记 6h 冷却并领下一个账号）
    const lim = r.limit || (accountDone >= OPT.taskCap ? { hours: 6, max: OPT.taskCap, byCount: true } : null);
    if (lim) {
      limitMap[OPT.account] = nextWaveAt();   // 冷却到下一波+偏移（服务器整点刷新，非滚动 6h）
      ui(`🛑 账号任务上限${lim.byCount ? `（计数判定：完成任务次数 ${accountDone} ≥ ${lim.max}）` : `（${lim.max}个/${lim.hours}小时）`} → 记冷却至 北京时间 ${bjFull(limitMap[OPT.account])}（下一波），账号收官下线`, 'warn');
      ev({ t: 'phase', msg: `账号任务上限 ${lim.byCount ? accountDone + '/' + lim.max + '（计数）' : lim.max + '个/' + lim.hours + 'h'}，直接下线` });
      if (cur) { records.push(cur); cur = null; }
      save();
      return summary();
    }
    // 三次对话全部无响应（侧步发不动 + NPC 不应答 = 实体冻结/半死会话，非网络抖动）——
    // 用户规则：回选角页重进同一角色重试（最多 2 次），绝不误判「无可接任务」白跳角色
    if (r && r.inconclusive) {
      const rf = (reentryFails[cur.slot] = (reentryFails[cur.slot] || 0) + 1);
      if (rf <= 2 && Date.now() < deadlineAt - 3 * 60 * 1000) {
        ui(`⚠ 3 次对话无响应（会话冻结）→ 回选角重进 ${cur.name}（第 ${rf}/2 次）`, 'warn');
        ev({ t: 'phase', msg: `${cur.name} 对话冻结，重进自愈 ×${rf}` });
        reentrySlot = cur.slot;
        cur = null;   // 不计入 records：重进后该角色从头再来
        rotating = true; c.rotating = true;
        setTimeout(() => {
          try { c.restartToCharSelect(); } catch (e) { scheduleRelogin(30000, '回选角失败'); }
          setTimeout(() => { rotating = false; }, 3000);
        }, OPT.switchGapMs);
        return;
      }
      ui(`⚠ ${cur.name} 对话无响应且重进额度用尽 → 记失败收官，切下一角色`, 'warn');
      return nextChar('对话冻结');
    }
    const { turnedIn, accepted } = r;
    if (turnedIn) { cur.completed.push(...Array(turnedIn).fill('提交')); heldClear(); ui(`提交 ${turnedIn} 个任务`, 'ok'); }   // 提交成功=任务槽已清
    // 从"完成任务次数: N 次"提取真实完成数
    if (r.doneCount != null) cur.doneCount = r.doneCount;
    if (!accepted) {
      // 刚提交过任务 → NPC 会直接关对话不再给列表；且押金+报酬回账后洞穴任务可能又够钱接 → 必须重开一轮
      if (turnedIn) { ui('本轮已提交，重开对话检查新任务列表（钱已回账）', 'npc'); continue; }
      const heldTask = r.activeTask || r.held;
      if (heldTask && !cur.banned.has(heldTask)) {
        ui(`身上有任务: ${heldTask} → 先完成它`, 'quest');
        const ok2 = await executeTask(heldTask, heldTask);
        if (!ok2) {
          cur.banned.add(heldTask); cur.failed.push(heldTask);
          ui(`身上任务失败 → 放弃: ${heldTask}`, 'warn');
          await abandonTask(); heldClear();
        }
        continue;   // 完成后回来提交
      }
      ui(`${cur.name} 无可接任务，下一角色`, 'ok');
      return nextChar('无可接任务');
    }
    cur.accepted.push(accepted); cur.tasks++;
    // 持久化（含数量）：把描述行的 " * N" 拼进任务文本——恢复/重进路径的选单与对话都不再下发数量
    // （2026-09-22 黄色药草实录：选 (√) 活任务只回"当前任务已完成。"，数量 30 丢失 → 默认 5 → 交易 5 个）
    {
      const qm = (r.desc || '').match(/[×xX*]\s*(\d+)/);
      heldSave(cur.slot, cur.name, qm ? `${accepted} * ${qm[1]}` : accepted);
    }
    ev({ t: 'task', name: accepted, char: cur.name });
    if (cur.tasks > OPT.maxTasksPerChar) { ui('达单角色上限', 'warn'); return nextChar('上限'); }
    // 2) 执行（失败拉黑防重复接取；黑名单后回 NPC 放弃，防止卡住全账号）
    let ok = await executeTask(accepted, r.activeTask);
    if (!ok) { await sleep(1500); ok = await executeTask(accepted, r.activeTask); }   // 重试 1
    if (!ok) { await sleep(2000); ok = await executeTask(accepted, r.activeTask); }   // 重试 2（网络抖动）
    if (!ok) {
      cur.banned.add(accepted);
      cur.failed.push(accepted);
      ui(`任务失败 → 回赏金NPC 放弃: ${accepted}`, 'warn');
      await abandonTask(); heldClear();
    }
    // 3) 回赏金 NPC 提交（下一轮循环开头处理）
  }
  return nextChar('轮次上限');
}

function nextChar(reason) {
  if (!cur) return;
  // 2026-09-21 安全检查：地图未知/为空时绝不切角（RESTART 会触发 code=0 锁号）
  const curMap = (c.mapName || '').replace(/\.gat$/i, '');
  if (!curMap || curMap.length < 3) {
    ui(`🛑 地图未知(${c.mapName || '空'})，拒绝切角 → 完全重登`, 'warn');
    try { c.closeAllSockets(); } catch (_) {}
    scheduleRelogin(30000, '地图未知自愈');
    return;
  }
  // 刷新交接（2026-09-20 坑）：刷新成功后的切角是「同一角色重进二轮」——
  // 必须保留 refreshOnlySlot 锁、不把角色记入 done（否则二轮被自己的收官逻辑杀死，新列表永远没人消费）
  const isRefreshHandoff = reason === '刷新成功' && refreshOnlySlot === cur.slot;
  if (isRefreshHandoff) {
    const i = records.findIndex((r) => r.slot === cur.slot);
    if (i >= 0) records.splice(i, 1);   // 移出 pass1 记录：二轮按 refreshOnlySlot 重选该角色
  } else {
    if (refreshOnlySlot != null && cur.slot === refreshOnlySlot) refreshOnlySlot = null;   // 二轮做完 → 解除锁定（其余角色已 pass1 记录跳过）
    records.push(cur);
  }
  save();
  ui(`${cur.name} ${isRefreshHandoff ? '刷新成功，带新列表重进二轮' : `收官（${reason}）：接${cur.accepted.length} 成${cur.completed.length} 败${cur.failed.length}`} → 切角`, 'ok');
  if (!isRefreshHandoff) ev({ t: 'phase', msg: `${cur.name} 收官：成${cur.completed.length} 败${cur.failed.length}` });
  cur = null;
  rotating = true; c.rotating = true;
  setTimeout(() => {
    try { c.restartToCharSelect(); } catch (e) { scheduleRelogin(30000, '回选角失败'); }
    setTimeout(() => { rotating = false; }, 3000);
  }, OPT.switchGapMs);   // 切角间隔（默认 8s）：优雅 RESTART 回选角页，绝不直接断连
}

function save() {
  try { fs.mkdirSync(path.dirname(OPT.out), { recursive: true }); fs.writeFileSync(OPT.out, JSON.stringify({ account: OPT.account, at: new Date().toISOString(), limits: limitMap, records }, null, 2)); } catch (_) {}
}

function summary(tasksOverride = null) {
  const totalDone = Number.isInteger(tasksOverride) ? tasksOverride
    : accountDone || records.reduce((a, r) => a + (r.doneCount != null ? r.doneCount : r.completed.length), 0);
  ui('══════════ 赏金执行链汇总 ════════', 'ok');
  for (const r of records) {
    ui(`${r.name.padEnd(10)} 接${r.accepted.length} 完成${r.doneCount != null ? r.doneCount : r.completed.length} 败${r.failed.length}${r.failed.length ? ' 败:' + r.failed.join('/') : ''}`);
  }
  ui(`${OPT.account} 完成任务数：${totalDone}`, 'ok');
  ev({ t: 'done', tasks: totalDone });
  save();
  c.quitClean().finally(() => process.exit(0));
}

process.on('SIGINT', () => { save(); ui('中断退出', 'warn'); process.exit(0); });
// 总时限：到点优雅收官——先 RESTART 回选角页释放角色，再关 socket（绝不硬断）
setTimeout(() => { ui(`⏱ 总时限 ${OPT.deadlineMin} 分钟到，优雅收官`, 'warn'); summary(); }, deadlineAt - Date.now());
process.on('uncaughtException', (e) => {
  ui('未捕获异常（多为服务器抖动断socket）: ' + e.message + ' → 保存后重登', 'warn');
  save();
  try { c.closeAllSockets(); } catch (_) {}
  rotating = false;
  scheduleRelogin(45000, '异常重登');
});
process.on('SIGTERM', () => { save(); ui('SIGTERM 优雅退出', 'warn'); rotating = true; c.rotating = true; c.quitClean().finally(() => process.exit(0)); });

ui(`=== 赏金任务执行链 === ${OPT.account}@${OPT.line} 面板:${OPT.port}`, 'ok');
// 账号任务上限冷却：本账号还在「N小时内最多完成M个任务」窗口内 → 免登录直接退出（不挤号）
{
  const until = limitMap[OPT.account] || 0;
  if (until > Date.now()) {
    ui(`⏳ 账号任务上限冷却中（至 北京时间 ${bjFull(until)}）→ 免登录直接退出`, 'warn');
    ev({ t: 'phase', msg: '任务上限冷却中，免登录退出' });
    process.exit(0);
  }
}
startLogin();
