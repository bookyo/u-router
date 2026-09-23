#!/usr/bin/env node
'use strict';
/**
 * 猫队全自动练级器 v2（V6-Eden 线路，模块化重构）
 * ============================================================
 * 流程（全部离线走 WebSocket 网关，不开浏览器）：
 *   1. 新账号(8位+_M，_M 后缀登录即自动注册) + 随机 7 位密码(大小写+数字)，记录到 accounts.json
 *      或 RO_ACCOUNT=name[:password] 指定已有账号（等级不足 30 的角色按相同逻辑补练）
 *   2. 登录 → 建猫角色（CH.MAKE_CHAR3 0x0A39 job=4218 召唤师）→ 进图
 *   3. 出生加点：Str→10、Agi→10、Dex→8（lib/statplan.js）
 *   4. 飞艇免费传送 prt_fild08 (208,235) 新手区
 *   5. 开内挂自动战斗（0x0AFE 真值序列）+ hunter 走位（combo 模式）
 *   6. 监听升级：Dex→19 → Str→29 → 剩余全 Agi
 *   7. 24 级：飞艇 pay_fild08 (213,323)，定向 [1014 魔菇, 1025 青蛇]
 *   8. 30 级收尾：先加技能「新基础技能」1 点（lib/skillplan.js，0x0112+0x010E 回执确认）
 *      → RESTART(0x00B2) 回角色选择 → 下一只猫
 *   9. 12 只全部 30 级 → 账号标记 done；默认 RO_MAX_ACCOUNTS=1，做完一个号就停（测试用）
 *
 * 用法：node leveler.js                     # 练满 1 个账号(12只猫到30级)后停止
 *       RO_MAX_ACCOUNTS=0 node leveler.js   # 无限练下去
 *       RO_ACCOUNT=auit63e4 node leveler.js # 指定存档内账号补练
 *       RO_ACCOUNT=myacct:mypass node leveler.js  # 指定存档外账号(带密码)
 *       RO_LINE=online node leveler.js      # 换 V6-Online 线路
 *       RO_JOB=0 node leveler.js            # 建人类初学者（调试用）
 */
const path = require('path');
const crypto = require('crypto');
const { ROClient } = require('./lib/client');
const { BUILD, LINES } = require('./lib/protocol');
const { AccountStore, randChars } = require('./lib/accounts');
const { StatAllocator } = require('./lib/statplan');
const { SkillAllocator } = require('./lib/skillplan');
const { Hunter } = require('./lib/hunter');
const { SmartHunter } = require('./lib/smart-hunter');

// ---------------- 配置 ----------------
const LINE = process.env.RO_LINE || 'eden';
const LV_MOVE = parseInt(process.env.RO_LV_MOVE || '24', 10);   // 换图等级
const LV_DONE = parseInt(process.env.RO_LV_DONE || '30', 10);
const CHARS_PER_ACCT = parseInt(process.env.RO_CHARS || '12', 10);
// 0=无限；默认 1：做完一个号的 12 角色就停（测试效果）
const MAX_ACCOUNTS = parseInt(process.env.RO_MAX_ACCOUNTS || '1', 10);
const SPECIFIED = process.env.RO_ACCOUNT || '';
// 账号存档文件（工作台每个标签独立一份，避免并发写冲突）
const ACCT_FILE = process.env.RO_ACCT_FILE || path.join(__dirname, 'accounts.json');
const FORCE_NEW = process.env.RO_NEW === '1';   // 强制开新号（不续练 pending）
const ACCT_PLAN = 'cat30-v2';                 // 方案标记：只续练同方案账号，老存档不混入

// 建角职业：4218=召唤师(猫，默认)；0=人类初学者（RO_JOB=0 调试）
// 猫配置真值（xiezixing2 正常猫）：job=4218 head=1 headPal=0 sex=1
const CHAR_JOB = parseInt(process.env.RO_JOB || '4218', 10);

// 传送坐标（用户校准：地图中部刷怪区）；RO_PRT="x,y" / RO_PAY="x,y" 可覆盖
const parseXY = (s, fb) => {
  const m = /^(\d+)\s*,\s*(\d+)$/.exec(String(s || ''));
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : fb;
};
const PRT = { map: 'prt_fild08', x: 208, y: 235 };
[PRT.x, PRT.y] = parseXY(process.env.RO_PRT, [PRT.x, PRT.y]);
const PAY = { map: 'pay_fild08', x: 213, y: 323 };
[PAY.x, PAY.y] = parseXY(process.env.RO_PAY, [PAY.x, PAY.y]);

// 加点计划：出生阶段 → 升级阶段（数组顺序即优先级，见 lib/statplan.js）
// 用户实测节奏（10str/10agi/其余 dex 出生，首都南门离线挂机）：7 分钟 17 级、15 分钟 24 级、
// 飞斐扬后 20-28 分钟到 30 级 → 巡访节奏按阶段自动调整（见 visitGapMs）
const PHASE1 = [['str', 10], ['agi', 10], ['dex', 8]];   // 出生 48 点：18+16+14 恰好用完（其余全 dex）
const PHASE2 = [['dex', 18], ['str', 29], ['agi', 99]];  // 升级：dex→18 → str→29 → 全 agi
// 30 级收尾技能（2026-09-16 probe-skill.js 实测：新基础技能 = SU_BASIC_SKILL SKID 5018，
// Lv0 未学时也在技能列表里，upgradable=1）。RO_SKILLS="新基础技能:1,5018:2" 可覆盖（纯数字按 SKID）
const parseSkillSpec = (s) => {
  const [key, lv] = s.split(':');
  const level = parseInt((lv || '1').trim(), 10) || 1;
  return /^\d+$/.test(key.trim())
    ? { name: `SKID ${key.trim()}`, SKID: parseInt(key.trim(), 10), level }
    : { name: key.trim(), level };
};
const FINISH_SKILLS = [{ name: '新基础技能', aliases: ['SU_BASIC_SKILL'], SKID: 5018, level: 1 }];
if (process.env.RO_SKILLS) {
  const custom = process.env.RO_SKILLS.split(',').filter(Boolean).map(parseSkillSpec);
  if (custom.length) FINISH_SKILLS.splice(0, FINISH_SKILLS.length, ...custom);
}

const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (msg) => console.log(`[${ts()}] ${msg}`);

// 工作台事件流：RO_EVENTS=1 时输出 @@{json} 行（server 解析后驱动网页状态卡）
const EVENTS = process.env.RO_EVENTS === '1';
const ev = (obj) => { if (EVENTS) { try { console.log('@@' + JSON.stringify(obj)); } catch (_) {} } };

// ---------------- 模块组装 ----------------
const c = new ROClient({ line: LINE, verbosity: 0 });
const store = new AccountStore(ACCT_FILE, { log: (m) => log(m) });
const stats = new StatAllocator(c, {
  phases: [PHASE1, PHASE2], log,
  onRound: (S) => ev({ t: 'stats', level: S.level || cur?.level, points: S.points, str: S.str, agi: S.agi, vit: S.vit, int: S.int, dex: S.dex, luk: S.luk }),
});
const skills = new SkillAllocator(c, { skills: FINISH_SKILLS, log });

// 战斗模式：默认「离线挂机+周期巡访」（V6 本线路支持离线战斗，实测断线后服务器自己练级，
// 客户端只做短访：读等级/补点/换图/定位，然后 RESTART 干净退出）；RO_STAY=1 保持全程在线模式
const RO_MODE = (process.env.RO_MODE || 'botonly').toLowerCase();   // 默认内挂（botonly）；smart=SmartHunter 在线（手动测试用）
const SUPERVISION = process.env.RO_STAY !== '1' && RO_MODE !== 'smart';   // smart 模式永远在线
// 目标怪（worldData 实刷）：prt_fild08 全部新手怪；pay_fild08 定向魔菇(1014)+青蛇(1025)
const PRT_MOBS = (process.env.RO_TARGETS || '1002,1007,1008,1063,2398,2770').split(',').map(Number);
const PAY_MOBS = (process.env.RO_TARGETS2 || '1014,1025').split(',').map(Number);
const hunter = new Hunter(c, { targets: PRT_MOBS, hpPct: parseFloat(process.env.RO_HP_PCT || '0.5'), scanRange: parseInt(process.env.RO_SCAN || '20', 10), log: (m) => log(m) });
// SmartHunter：自研全在线战斗（复刻 OpenKore AI），内挂只管拾取+吃药
const smartHunter = new SmartHunter(c, {
  targets: PRT_MOBS, skills: [], scanRange: parseInt(process.env.RO_SCAN || '15', 10),
  center: [PRT.x, PRT.y], giveupSec: 20, hpPct: 0.4, log: (m) => log(m),
});

// ---------------- 运行态 ----------------
let acct = null;              // 当前账号
let cur = null;               // 当前角色运行态
let loginRetry = 0;
let botKeepTimer = null;

function resetCharState(ch) {
  cur = {
    name: ch.name, slot: ch.CharNum, level: ch.level || 1,
    moved: false,             // 换图等级后标记
    finishing: false,         // 30 级收尾中
    botOn: false,
    selected: false,
    lastLevelUp: Date.now(),
    enteredAt: Date.now(),
  };
  // 用角色块初始化六维/等级/zeny（进图后 0x00BD/0x0ACB/0x00B1 会刷新校准）
  c.stats = { level: ch.level || 1, points: 0, str: ch.Str || 1, agi: ch.Agi || 1, vit: ch.Vit || 1, int: ch.Int || 1, dex: ch.Dex || 1, luk: ch.Luk || 1 };
  c.zeny = ch.money != null ? ch.money : c.zeny;
  c.skills = null;            // 技能列表等新图 0x010F 下发，防止读到上一只的
}

// ---------- 内挂开启（真值序列） ----------
// 内挂开启真值序列（2026-09-12 autobattle-report.md，PC 端抓包）：
//   0x0AFE(34,1) 自动攻击 → 0x0AFE(36,1)×2 自动进食 → 0x0AFE(57,1) 疑似总开关
//   之后每 ~90 秒重发 0x0AFE(34,1) 保活；心跳严格 15 秒
function enableBot() {
  if (!cur || cur.botOn) return;
  try {
    c.send(BUILD.notifyUpdateinfo(34, 1));            // 自动攻击
    c.send(BUILD.notifyUpdateinfo(36, 1));            // 自动进食（开关型，只发一次）
    c.send(BUILD.notifyUpdateinfo(57, 1));            // 总开关（新发现）
    cur.botOn = true;
    log('🤖 内挂已开启（34攻击+36吃粮+57总开关，真值序列）');
    clearInterval(botKeepTimer);
    botKeepTimer = setInterval(() => {
      if (!c.ws || c.state !== 'zone' || !cur || cur.finishing) return;
      try { c.send(BUILD.actorInit()); } catch (_) {}   // 真值：每 25s ACTORINIT 刷新实体+防空闲踢
    }, 25 * 1000);
  } catch (e) { log('🤖 内挂发送失败: ' + e.message); }
}

let lastExpAt = Date.now();   // 最近一次经验入账时间（换点判据）
// 经验入账/升级都算"活着"（换点判据）
c.on('npc_chat', (p) => { if (/基础经验/.test(p.msg || '')) lastExpAt = Date.now(); });
c.on('server_msg', (p) => { if (/基础经验/.test(p.msg || '')) lastExpAt = Date.now(); });

// ---------- 战斗模式：内挂(默认 combo) / 自研猎怪(RO_MODE=hunter) ----------
function engageHunter() {
  const lv = (c.stats && c.stats.level) || (cur && cur.level) || 1;
  const dest = lv >= LV_MOVE ? PAY : PRT;
  const mobs = lv >= LV_MOVE ? PAY_MOBS : PRT_MOBS;
  if (RO_MODE === 'smart') {
    // SmartHunter 全在线：自研战斗 + 内挂拾取/吃药 → 不裸断线，账号永不卡死
    smartHunter.setTargets(mobs);
    smartHunter.setMap(dest.map, [dest.x, dest.y]);
    // 技能槽：从角色技能表自动生成（法师/盗贼等通用映射）
    const SKILL_RANGES = { 19:9,14:9,20:9,13:9,11:9,84:9,85:9,83:9,90:9,12:9,15:9, 48:1,49:9, 5:1,7:1, 46:9,47:9, 38:1, 157:9,158:9 };
    const slots = (c.skills || []).filter((s) => s.level > 0 && SKILL_RANGES[s.SKID])
      .sort((a, b) => (b.level || 0) - (a.level || 0))
      .map((s) => ({ SKID: s.SKID, level: Math.min(s.level, 10), range: SKILL_RANGES[s.SKID], spCost: 5 }));
    smartHunter.setSkills(slots);
    smartHunter.start();
    // 内挂只管拾取+吃药（不开战斗）
    c.send(BUILD.notifyUpdateinfo(34, 0));
    c.send(BUILD.notifyUpdateinfo(35, 1));   // 拾取
    c.send(BUILD.notifyUpdateinfo(20, 50));   // 概率50%
    c.send(BUILD.notifyUpdateinfo(36, 1));   // 吃药
    c.send(BUILD.notifyUpdateinfo(21, 60));  // HP<60%
    log(`🧝 SmartHunter 启动 @${dest.map} 目标${mobs.length}种 技能${slots.length}个`);
    return;
  }
  hunter.setTargets(mobs);
  hunter.setMap(dest.map, [dest.x, dest.y]).catch(() => {});
  if (RO_MODE === 'botonly') {
    // 全交内挂：不启 hunter，服务器自己选目标/巡路/打怪（客户端只发配置+ACTORINIT 保活）
    enableBot();
    return;
  }
  if (RO_MODE === 'bot') {
    // combo：内挂打 + hunter 只走位（walkOnly）
    hunter.walkOnly = true;
    hunter.start();
    enableBot();
    return;
  }
  hunter.walkOnly = false;
  hunter.start();
}

// ---------- 地图路由 ----------
function routeByLevel() {
  if (!cur) return;
  const lv = (c.stats && c.stats.level) || cur.level;
  const dest = lv >= LV_MOVE ? PAY : PRT;
  const here = (c.mapName || '').replace(/\.gat$/, '');
  if (here !== dest.map) {
    log(`🚌 飞艇 ${here || '?'} → ${dest.map} (${dest.x},${dest.y})`);
    try { c.airshipTeleport(dest.map, dest.x, dest.y); } catch (e) { log('飞艇失败: ' + e.message); }
  } else {
    engageHunter();
  }
}

// ---------- 离线挂机巡访（SUPERVISION 模式核心） ----------
// 实测（2026-09-16）：断线后服务器离线挂机自动练级（35 分钟 +5 级），
// 且会话内 0x0ACB 升级事件不可靠 → 等级以每次巡访的角色列表为准。
// 每次巡访：进图 → 补点 → （换图/定位）→ 开内挂 → 15s 后 RESTART 干净退出 → 隔回访
// 节奏按用户实测标定：<24 级升级快（7 分钟 17 级、15 分钟 24 级）→ 高频补点保输出；
// 24+ 在斐扬约 3.5-4.5 分钟/级 → 降频少打扰离线挂机
const VISIT_BASE_MS = parseInt(process.env.RO_VISIT || '100', 10) * 1000; // 低阶段巡访基数
let visitTimer = null;
function visitGapMs() {
  // 2026-09-21 用户要求：加大间隔让裸断线更像真人关浏览器
  const lv = (c.stats && c.stats.level) || (cur && cur.level) || 1;
  return lv >= LV_MOVE
    ? (480 + crypto.randomInt(0, 420)) * 1000    // 24+ 斐扬：8~15 分钟
    : (300 + crypto.randomInt(0, 300)) * 1000;  // 新手阶段：5~10 分钟
}
function scheduleSupervisionQuit() {
  if (!SUPERVISION) return;
  clearTimeout(visitTimer);
  // 2026-09-21 反检测改进：
  //   ① 驻留时间随机化（10-30s，不是固定 15s）
  //   ② 断线前静默期（停心跳 3-8s，让最后发出的包是心跳而非 bot 配置）
  //   ③ 断线后的重访间隔已加大（5-15 分钟）
  const stayMs = (10 + crypto.randomInt(0, 20)) * 1000;       // 驻留 10-30s
  const quietMs = (3 + crypto.randomInt(0, 5)) * 1000;         // 静默 3-8s
  visitTimer = setTimeout(async () => {
    if (!cur || cur.finishing || !c.ws || c.state !== 'zone') return;
    // 静默期：停心跳、停一切游戏包（模拟用户"放下手机/走开"）
    clearInterval(c.keepAliveTimer);
    c.keepAliveTimer = null;
    log(`🤫 静默 ${quietMs / 1000}s（停心跳，模拟用户离开）`);
    await new Promise((r) => setTimeout(r, quietMs));
    const gap = visitGapMs();
    log(`🛌 静默期结束，断线转服务器内挂（${Math.round(gap / 1000)}s 后回访）`);
    // V6 内挂触发条件：直接掉线才转离线挂机；RESTART=主动回选角不触发（2026-09-17 实证）
    c.dropping = true;
    try { c.hardClose(); } catch (_) {}
    scheduleRelogin(gap, '巡访周期');
    setTimeout(() => { c.dropping = false; }, 5000);
  }, stayMs);
}
// 卡住检测：连续 3 次巡访等级无变化 → 重新空投到校准刷怪点（离线挂机可能蹲进稀怪区）
function trackVisitProgress() {
  if (!cur) return 0;
  if (cur.lastVisitLevel === cur.level) cur.stuckVisits = (cur.stuckVisits || 0) + 1;
  else { cur.stuckVisits = 0; cur.lastVisitLevel = cur.level; }
  return cur.stuckVisits;
}

// ---------- 30 级收尾：技能加点 → 回选角 ----------
async function finishChar() {
  if (!cur || cur.finishing) return;
  cur.finishing = true;
  hunter.stop(); smartHunter.stop();
  stats.enabled = () => false;      // 收尾中停属性加点
  const lv = (c.stats && c.stats.level) || LV_DONE;
  store.recordChar(acct, cur.name, cur.slot, lv, LV_DONE);
  const chars = (store.find(acct.account) || {}).chars || [];
  const done = chars.filter((ch) => ch.level >= LV_DONE).length;
  log(`🏁 ${cur.name} 达到 ${LV_DONE} 级（账号进度 ${done}/${CHARS_PER_ACCT}）`);
  ev({ t: 'phase', msg: `${cur.name} 达到 ${LV_DONE} 级（${done}/${CHARS_PER_ACCT}）` });
  // 技能收尾：新基础技能+1（等技能列表 → 0x0112 → 0x010E 确认）
  if (FINISH_SKILLS.length) {
    log(`🎓 技能收尾: ${FINISH_SKILLS.map((s) => `${s.name}+${s.level}`).join(', ')}`);
    const r = await skills.ensureAll({ timeoutMs: 20000 });
    r.applied.forEach((s) => { log(`   ✅ ${s.name} → Lv${s.level}`); ev({ t: 'skill', name: s.name, level: s.level, ok: true }); skillPending.delete(cur.name); });
    r.skipped.forEach((s) => log(`   ⏭ ${s.name} 已 Lv${s.level}，跳过`));
    r.failed.forEach((s) => {
      log(`   ❌ ${s.name}: ${s.reason}（角色仍切换）`);
      ev({ t: 'skill', name: s.name, ok: false, reason: s.reason });
      skillRetries[cur.name] = (skillRetries[cur.name] || 0) + 1;
      if (skillRetries[cur.name] < 3) {
        skillPending.add(cur.name);
        log(`   🔁 ${cur.name} 技能失败第 ${skillRetries[cur.name]} 次，稍后回头重试`);
      } else {
        log(`   ⚠ ${cur.name} 技能重试 3 轮仍失败，放弃（不影响其他角色）`);
        skillPending.delete(cur.name);
      }
    });
  }
  log('↩ 回角色选择');
  c.rotating = true;          // restartToCharSelect 的 proceed 门闩
  try { c.restartToCharSelect(); } catch (e) { log('回选角失败: ' + e.message); }
}

// ---------- 角色选择/建角决策 ----------
let createRetry = 0;
// 技能补做：30 级收尾时加点失败的字符记入 skillPending，练满后回头重试（每字符最多 3 轮，
// 仍失败就放弃切下一个——绝不挂住流程；2026-09-19 xiezixing11 实测服务器卡时不回 0x010E）
const skillPending = new Set();
const skillRetries = {};

// 续练统一入口：保留巡访状态（卡住计数/换图标记），否则每次重进都会清零
function resumeChar(ch, reason) {
  const prev = cur && !cur.finishing
    ? { lastVisitLevel: cur.lastVisitLevel, stuckVisits: cur.stuckVisits, moved: cur.moved }
    : null;
  log(`${reason} ${ch.name} [slot ${ch.CharNum}] Lv${ch.level}`);
  if (cur && ch.level > cur.level) ev({ t: 'level', name: ch.name, level: ch.level });
  const a = store.find(acct.account);
  const charsDone = ((a && a.chars) || []).filter((x) => x.level >= LV_DONE).length;
  ev({ t: 'char', name: ch.name, slot: ch.CharNum, level: ch.level, done: charsDone, total: CHARS_PER_ACCT });
  c.session.charName = ch.name;
  resetCharState(ch);
  if (prev) Object.assign(cur, prev);
  store.recordChar(acct, ch.name, ch.CharNum, ch.level, LV_DONE);
  c.selectChar(ch.CharNum);
}
function decideOnCharList(chars) {
  // 1) 中断续练：上一只在练 → 直接重进该角色（巡访周期/挤号恢复场景）
  if (cur && !cur.finishing) {
    const mine = chars.find((ch) => ch.name === cur.name && ch.CharNum === cur.slot);
    if (mine && mine.level < LV_DONE) {
      resumeChar(mine, '🔁 续练');
      return;
    }
    if (mine && mine.level >= LV_DONE) {
      // 离线挂机期间冲到 30 → 进图走收尾（技能+切角色）
      resumeChar(mine, `🏁 已达 ${LV_DONE} 级（离线期间升级），进图收尾 →`);
      return;
    }
  }
  // 2) 已在选角流程（建角后的列表刷新等，且该角色未满级）→ 不重复决策
  if (cur && cur.selected && !cur.finishing
    && chars.some((ch) => ch.name === cur.name && ch.CharNum === cur.slot && ch.level < LV_DONE)) return;
  // 3) 有未满 30 的角色 → 优先续练 slot 最小者（指定账号补练/中断恢复的关键路径，
  //    槽位未满也不建新角，避免旧角色被遗弃）
  const pending = chars.filter((ch) => ch.level < LV_DONE).sort((a, b) => a.CharNum - b.CharNum);
  if (pending.length) {
    resumeChar(pending[0], `👤 续练角色 (${(pending[0].lastMap || '').replace(/\0/g, '')}) →`);
    return;
  }
  // 技能补做：还有 30 级角色等着补技能 → 回头重进（比账号 done 优先）
  const sk = skillPending.size ? chars.find((ch) => skillPending.has(ch.name) && ch.level >= LV_DONE) : null;
  if (sk) {
    skillPending.delete(sk.name);   // 本轮取出；再失败会重新加入（受 3 轮上限约束）
    resumeChar(sk, '🎓 技能补做');
    return;
  }
  if (chars.length >= CHARS_PER_ACCT) {
    log(`✅ 账号 ${acct.account} 全部 ${CHARS_PER_ACCT} 只角色已 ${LV_DONE} 级！`);
    store.update(acct, { status: 'done' });
    ev({ t: 'account_done', account: acct.account });
    nextAccount();
    return;
  }
  const used = new Set(chars.map((ch) => ch.CharNum));
  let slot = 0; while (used.has(slot)) slot++;   // 最小空闲槽
  createCat(slot);
}
function createCat(slot) {
  createRetry++;
  if (createRetry > 4) {
    log('❌ 建角连续失败，跳过该账号');
    store.update(acct, { status: 'failed', failReason: 'create_char' });
    nextAccount();
    return;
  }
  const name = (CHAR_JOB === 4218 ? 'Mao' : 'Ro') + randChars(6, 'abcdefghijkmnpqrstuvwxyz23456789');
  log(`${CHAR_JOB === 4218 ? '🐱 创建猫角色' : '🧑 创建人类初学者'}: ${name} (slot ${slot}, job=${CHAR_JOB})`);
  cur = { name, slot, level: 1, moved: false, finishing: false, botOn: false, selected: false, lastLevelUp: Date.now(), enteredAt: Date.now(), creating: true };
  try { c.send(BUILD.makeChar3(name, slot, CHAR_JOB, 0, 1, 1)); } catch (e) { log('建角发送失败: ' + e.message); }
}

// ---------- 账号/会话循环 ----------
let loginSeq = 0;             // 重登防并发：只允许最新一次登录流程继续
let entryFail = 0;            // 进图连续失败计数（code=0 退避用）
let dropStreak = 0;           // 连续快速掉线计数（互踢退避用）
function scheduleRelogin(delayMs, reason) {
  hunter.stop(); smartHunter.stop();                 // 旧会话猎怪停止
  clearInterval(botKeepTimer);   // 旧会话内挂保活停止
  const seq = ++loginSeq;
  log(`🔄 ${reason}，${Math.round(delayMs / 1000)} 秒后挤号重进`);
  setTimeout(() => { if (seq === loginSeq) startLogin(); }, delayMs);
}
function nextAccount() {
  cur = null;
  createRetry = 0;
  loginRetry = 0;
  loginSeq = 0;
  if (SPECIFIED) {
    // 指定账号模式：账号完成即收工
    const a = store.find(SPECIFIED.split(':')[0]);
    if (a && a.status === 'done') {
      log(`🎉 指定账号 ${a.account} 已全部 ${LV_DONE} 级，收工。账号清单见 ${ACCT_FILE}`);
      process.exit(0);
    }
  }
  acct = store.pick({ specified: SPECIFIED, plan: ACCT_PLAN, maxAccounts: MAX_ACCOUNTS, forceNew: FORCE_NEW });
  if (!acct) {
    log(`🎉 达到账号上限（${MAX_ACCOUNTS} 个已完成），任务完成。账号清单见 ${ACCT_FILE}`);
    ev({ t: 'done', reason: 'max_accounts' });
    process.exit(0);
  }
  log(`▶ 开始账号 ${acct.account}（已有角色 ${(acct.chars || []).length}）`);
  ev({ t: 'account', account: acct.account, password: acct.password, loginName: acct.loginName || '', mode: SPECIFIED ? 'old' : 'new' });
  startLogin();
}
function startLogin() {
  loginSeq++;
  loginRetry++;
  if (loginRetry > 12) {
    log('❌ 登录重试过多，标记账号失败');
    if (!SPECIFIED) store.update(acct, { status: 'failed', failReason: 'login' });
    nextAccount();
    return;
  }
  // rAthena _M 注册会把后缀去掉存储；若上次运行已注册但未记录 loginName，重试时切换去后缀名
  let loginName = acct.loginName;
  if (!loginName) loginName = acct.account.endsWith('_M') && loginRetry > 1 ? acct.account.slice(0, -2) : acct.account;
  // 登录超时保护：20 秒无响应（网关挂起/频率限制）则关连接重试
  const to = setTimeout(() => {
    log('⚠ 登录 20 秒无响应（频率限制/网关挂起），30 秒后重试');
    try { c.closeAllSockets(); } catch (_) {}
    scheduleRelogin(30000, '登录超时');
  }, 20000);
  c.once('login_ok', () => clearTimeout(to));
  c.once('login_refuse', () => clearTimeout(to));
  c.login(loginName, acct.password, LINE).catch((e) => {
    clearTimeout(to);
    log('登录异常: ' + e.message + '，15 秒后重试');
    scheduleRelogin(15000, '登录异常');
  });
}

// ---------- 事件接线 ----------
c.on('login_ok', (p) => {
  srvDown1 = 0;
  loginRetry = 0;
  loginSeq = 0;
  if (!acct.loginName && acct.account.endsWith('_M')) {
    acct.loginName = acct.account.slice(0, -2);   // 首登成功：固化去 _M 的真实登录名
    store.update(acct, { loginName: acct.loginName });
    log(`📝 _M 注册成功，真实登录名固化为 ${acct.loginName}`);
  }
  const s = p.ServerList[0] || {};
  log(`🔑 登录成功 AID=${p.AID} → 角色服 ${s.name || ''} ${s.ipStr || ''}:${s.port}`);
  c.connectChar(s.ipStr, s.port).catch((e) => { log('连角色服失败: ' + e.message); scheduleRelogin(10000, '连角色服失败'); });
});

let srvDown1 = 0;
c.on('login_refuse', (p) => {
  const code = p.ErrorCode;
  log(`⚠ 登录被拒 code=${code}（0=账号未注册 1/3=疑似宕机 8=重复登录）`);
  if ((code === 1 || code === 3) && ++srvDown1 >= 2) return scheduleRelogin(10 * 60 * 1000, `☢ code=${code} ×${srvDown1} 疑似服务器宕机，10 分钟探测`);
  if (code === 0 && !SPECIFIED && acct.account.endsWith('_M')) {
    store.update(acct, { status: 'failed', failReason: '_M 注册被拒(code=0)' });
    log('该账号 _M 自动注册失败，换下一个账号');
    nextAccount();
  } else if (code === 0 && SPECIFIED) {
    // 指定账号在服务器端不存在（本地记录但从未注册成功）：直接报错退出，避免无限重试
    log(`❌ 指定账号 ${acct.account} 未注册（code=0），退出`);
    ev({ t: 'phase', msg: `指定账号 ${acct.account} 未注册（code=0）` });
    process.exit(1);
  } else {
    scheduleRelogin(code === 8 || code === 2 ? 30000 : 12000, `登录被拒 code=${code}`);
  }
});

c.on('char_list', (p) => {
  const chars = p.chars || [];
  log(`📋 角色列表: ${chars.length} 个${chars.length ? ' — ' + chars.map((ch) => `${ch.name}(Lv${ch.level})`).join(' ') : '（空，将建猫）'}`);
  if (cur && cur.creating && chars.some((ch) => ch.name === cur.name)) {
    // 建角后列表刷新：直接进新角
    const ch = chars.find((x) => x.name === cur.name);
    createRetry = 0;
    cur.creating = false;
    if (cur.selected) return;                 // 0x006D 已触发过选角
    cur.selected = true;
    c.session.charName = ch.name;
    resetCharState(ch);
    store.recordChar(acct, ch.name, ch.CharNum, ch.level, LV_DONE);
    try { c.selectChar(ch.CharNum); }
    catch (e) {   // 断连竞态（2026-09-21）：socket 已关时选角抛错 → 挤号重进，不能让 worker 崩掉
      log(`⚠ 选角时断连（${e.message}）→ 15 秒挤号重进`);
      scheduleRelogin(15000, '选角断连');
    }
    return;
  }
  try { decideOnCharList(chars); }
  catch (e) { log(`⚠ 角色决策异常（${e.message}）→ 15 秒挤号重进`); scheduleRelogin(15000, '决策断连'); }
});

c.on('char_created', (p) => {
  const ch = p.char;
  if (!ch || !cur) return;
  createRetry = 0;
  log(`🐣 建角成功 ${ch.name}，1.5 秒后进入`);
  if (cur.selected) return;
  cur.selected = true;
  c.session.charName = ch.name;
  resetCharState(ch);
  store.recordChar(acct, ch.name, ch.CharNum, ch.level, LV_DONE);
  setTimeout(() => { try { c.selectChar(ch.CharNum); } catch (_) {} }, 1500);
});

c.on('char_refuse_create', (p) => {
  log(`⚠ 建角被拒 code=${p.code}，换名字重试`);
  const slot = cur ? cur.slot : 0;
  cur = null;
  setTimeout(() => createCat(slot), 1500);
});

c.on('char_refuse', () => {
  scheduleRelogin(8000, '选角被拒（角色下线中）');
});

c.on('zone_info', (p) => {
  log(`🗺 地图服 ${p.mapName} @ ${p.ipStr}:${p.port}`);
  c.connectZone(p.ipStr, p.port).catch((e) => { log('连地图服失败: ' + e.message); scheduleRelogin(10000, '连地图服失败'); });
});

c.on('map_enter', (p) => {
  if (!cur || cur.creating) return;
  entryFail = 0;              // 进图成功，清空退避计数
  dropStreak = 0;             // 会话稳定，掉线连击清零
  c.rotating = false;        // 清掉回选角门闩，下一次 30 级重启可用
  cur.enteredAt = Date.now();
  stats.enabled = () => !cur.finishing;   // 新角色开始正常加点
  if (!c.stats || c.stats.level == null) c.stats = { level: cur.level, points: 0, str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 };
  const stuck = trackVisitProgress();
  log(`🏠 ${cur.name} 进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]}) Lv${cur.level}${stuck ? `（${stuck} 次巡访未升级）` : ''}`);
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  setTimeout(async () => {
    await stats.allocate();  // 补属性点（离线期间攒的点）
    if (cur.level >= LV_DONE) { finishChar(); return; }   // 离线挂机期间到 30 → 收尾技能+切角色
    if (stuck >= 3) {
      // 卡住重定位：空投回校准刷怪点（同图也重发，重置到密怪区）
      const dest = cur.level >= LV_MOVE ? PAY : PRT;
      cur.stuckVisits = 0;
      log(`📍 卡住重定位 → 飞艇 ${dest.map} (${dest.x},${dest.y})`);
      try { c.airshipTeleport(dest.map, dest.x, dest.y); } catch (_) {}
      scheduleSupervisionQuit();
      return;
    }
    routeByLevel();          // 换图（如需）+ 开内挂
    scheduleSupervisionQuit();
  }, 2500);
});

c.on('warp_map', (p) => {
  log(`⚡ 已传送 ${p.mapName} @(${p.xPos},${p.yPos})`);
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500);
  const here = (p.mapName || '').replace(/\.gat$/, '');
  if (here === PAY.map || here === PRT.map) {
    setTimeout(() => { engageHunter(); scheduleSupervisionQuit(); }, 2500);
  }
});

c.on('warp_server', (p) => {
  log(`🌐 跨服传送 → ${p.mapName} @ ${p.ipStr}:${p.port}`);
  c.connectZone(p.ipStr, p.port).catch((e) => log('跨服连图失败: ' + e.message));
});

c.on('stat_update', (p) => {
  if (p.key === 'level' && cur && !cur.creating) {
    if (p.value > cur.level) {
      log(`⬆ 升级！ Lv${p.value}（${cur.name}）`);
      ev({ t: 'level', name: cur.name, level: p.value });
      cur.lastLevelUp = Date.now();
      store.recordChar(acct, cur.name, cur.slot, p.value, LV_DONE);
      if (p.value >= LV_DONE) { finishChar(); return; }
      if (p.value >= LV_MOVE && !cur.moved) {
        cur.moved = true;
        hunter.stop(); smartHunter.stop();
        log(`📍 到达 ${LV_MOVE} 级 → 换图 ${PAY.map} (${PAY.x},${PAY.y}) 定向魔菇/青蛇`);
        ev({ t: 'phase', msg: `${LV_MOVE} 级换图 ${PAY.map}` });
        try { c.airshipTeleport(PAY.map, PAY.x, PAY.y); } catch (_) {}
        setTimeout(() => { engageHunter(); }, 6000);   // 换图后重新启动战斗
        return;
      }
    }
    cur.level = p.value;
  }
  if (['points', 'str', 'agi', 'vit', 'int', 'dex', 'luk'].includes(p.key)) stats.allocate();
});

c.on('status_full', () => stats.allocate());
c.on('stat_changed', () => stats.allocate());
c.on('skill_list', (list) => {
  if (process.env.RO_TRACE) log(`📖 技能列表: ${list.map((s) => `${s.name}#${s.SKID} Lv${s.level}`).join(' ')}`);
});

c.on('airship_response', (p) => {
  if (p.code !== 0 && p.code !== 1) log(`⚠ 飞艇被拒 code=${p.code}，10 秒后重试`);
});

c.on('charserver_fail', () => {
  // 重连角色服 3 次均失败（网关抖动/服务器维护）→ 走完整重登恢复
  scheduleRelogin(15000, '重连角色服连续失败');
});

// 角色服列表看门狗：连上角色服 45s 还没收到角色列表（2026-09-19 xiezixing11 实测：
// 技能收尾失败 → RESTART → 连上角色服 → 列表迟迟不来 → 无任何事件 → 挂死 12 分钟）→ 完整重登
// 2026-09-21 修正：不再要求 state==='char'——角色服 socket 在列表前死掉时 state='closed'（xiezixing11
// 二次实录：回选角→连角色服→8s 后 socket 死→disconnect 被"属预期"吞→看门狗守卫失效→永久挂死）
let charListWatch = null;
c.on('char_connect', () => {
  clearTimeout(charListWatch);
  charListWatch = setTimeout(() => {
    if (c.state === 'login') return;   // 已有完整重登在进行
    log(`⚠ 连角色服 45 秒无角色列表（state=${c.state}）→ 完整重登恢复`);
    scheduleRelogin(8000, '角色列表超时看门狗');
  }, 45 * 1000);
});
c.on('char_list', () => clearTimeout(charListWatch));

c.on('disconnect', () => {
  hunter.stop(); smartHunter.stop();
  if (c.dropping) return;   // 巡访主动断线（转服务器内挂），回访已另行安排
  if (!cur || cur.finishing) { if (cur && cur.finishing) log('   (回选角过程中的断开，属预期)'); return; }
  // 连续快速掉线（离线挂机会话互踢）按 15s→30s→60s 递增退避，避免高频登录触发风控
  dropStreak = (dropStreak || 0) + 1;
  const backoff = dropStreak >= 3 ? 60000 : dropStreak === 2 ? 30000 : 15000;
  scheduleRelogin(backoff, `连接断开（第${dropStreak}连掉）`);
});

c.on('banned', (p) => {
  // 挤号类 code 不受收尾状态影响（2026-09-20 坑：finishing 时 code=8 被静默吞掉 → 永久卡死）
  if (p.code === 8 || p.code === 2 || p.code === 5) {
    scheduleRelogin(30000, `被踢 code=${p.code}（重复登录/离线残留${cur && cur.finishing ? '，收尾中' : ''}）`);
  } else if (cur && cur.finishing) {
    return;
  } else {
    // code=0 多为账号幽灵会话（硬杀后离线挂机残留）：连击会让服务器一直不释放，指数退避静置；
    // 退避 6 轮（约 8 分钟）仍进不了图 → 标记 cooldown 换号，不无限空转
    entryFail = (entryFail || 0) + 1;
    if (entryFail >= 4 && process.env.RO_GIVEUP === '1') {   // 批量练级模式：4 次即停此号（manager 取下一个 pending）
      log(`⚠ 连续 ${entryFail} 次进图被拒 code=0（幽灵会话毒化）→ 停止此号，交还调度`);
      try { store.update(acct, { status: 'cooldown', failReason: `进图连续code=0×${entryFail}` }); } catch (_) {}
      process.exit(4);
    }
    if (entryFail >= 4 && !SPECIFIED) {   // 单号巡练模式：换下一个号
      log(`⚠ 连续 ${entryFail} 次进图被拒 code=0，账号疑被幽灵会话毒化 → 标记 cooldown 换号（恢复后可改回 pending 续练）`);
      store.update(acct, { status: 'cooldown', failReason: `进图连续code=0×${entryFail}(离线残留毒化)` });
      cur = null;
      entryFail = 0;
      nextAccount();
      return;
    }
    const quiet = Math.min(30000 * Math.pow(2, Math.max(0, entryFail - 3)), 5 * 60 * 1000);
    scheduleRelogin(entryFail >= 3 ? quiet : 15000, `被踢 code=${p.code}（第${entryFail}次）`);
  }
});

// ---------- 物品获取日志（背包 diff：巡访/进图时 0x02E8/0x0B09 同步，对比上一次） ----------
const ITEM_NAMES = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'itemnames-zh.json'), 'utf8')); }
  catch (_) { return {}; }
})();
const itemName = (id) => ITEM_NAMES[String(id)] || `#${id}`;
let lastInv = new Map();   // ITID -> count
function diffInventory(items) {
  const now = new Map();
  for (const it of items) now.set(it.ITID, (now.get(it.ITID) || 0) + (it.count == null ? 1 : it.count));
  for (const [id, cnt] of now) {
    const prev = lastInv.get(id);
    if (prev == null) { if (lastInv.size) log(`🎁 获得 ${itemName(id)} ×${cnt || 1}`); }   // 首次同步不报（初始装备）
    else if (cnt > prev) log(`🎁 获得 ${itemName(id)} ×${cnt - prev}`);
  }
  lastInv = now;
}
c.on('inventory', diffInventory);

// ---------- 计算题防挂机弹窗：自动作答 + 封包记录 ----------
const fs = require('fs');
const CAPTCHA_LOG = path.join(__dirname, 'captcha.log');
// 从题面提取算式并求值：支持 + - * / × ÷ x X 及多段（从左到右）
function solveMath(text) {
  const norm = String(text || '')
    .replace(/×|x|X|＊/g, '*').replace(/÷|／/g, '/')
    .replace(/[０-９]/g, (d) => String('０１２３４５６７８９'.indexOf(d)))
    .replace(/＋/g, '+').replace(/－/g, '-');
  const m = norm.match(/(-?\d+(?:\.\d+)?)(?:\s*([-+*/])\s*(-?\d+(?:\.\d+)?))+/);
  if (!m) return null;
  try {
    const expr = m[0];
    const tokens = expr.match(/\d+(?:\.\d+)?|[-+*/]/g) || [];
    let acc = parseFloat(tokens[0]);
    for (let i = 1; i < tokens.length; i += 2) {
      const op = tokens[i], v = parseFloat(tokens[i + 1]);
      if (op === '+') acc += v; else if (op === '-') acc -= v;
      else if (op === '*') acc *= v; else if (v === 0) return null; else acc /= v;
    }
    return { expr, answer: Math.round(acc) };
  } catch (_) { return null; }
}
function recordCaptcha(line) {
  try { fs.appendFileSync(CAPTCHA_LOG, `[${new Date().toISOString()}] ${line}\n`); } catch (_) {}
}
c.on('input_dialog', (p) => {
  const line = `input_dialog kind=${p.kind} NAID=${p.NAID} 题面=${JSON.stringify(p.question || '')}`;
  log(`🔢 [防挂机] ${line}`);
  recordCaptcha(line);
  if (p.kind !== 'number') return;
  const solved = solveMath(p.question);
  if (!solved) {
    log('   ⚠ 未能解析算式，已记录题面（captcha.log）');
    recordCaptcha('  → 解析失败');
    return;
  }
  recordCaptcha(`  → 算式 ${solved.expr} = ${solved.answer}，延迟 1.2s 作答 0x0143`);
  log(`   🧮 ${solved.expr} = ${solved.answer} → 作答`);
  setTimeout(() => {
    try { c.send(BUILD.inputEditdlg(p.NAID, solved.answer)); } catch (e) { log('作答发送失败: ' + e.message); }
  }, 1200);
});
// 服务器反馈（答对/答错通常有系统消息）
c.on('server_msg', (p) => {
  if (/计算|验证|答|挂机|验证码/.test(p.msg || '')) recordCaptcha(`server_msg: ${p.msg}`);
});

// ---------- 看门狗：升级停滞检测（仅 RO_STAY=1 全程在线模式；巡访模式由 trackVisitProgress 兜底） ----------
setInterval(() => {
  if (SUPERVISION) return;
  if (!cur || cur.finishing || cur.creating) return;
  if (!c.ws || c.state !== 'zone') return;
  const idleMin = Math.round((Date.now() - cur.lastLevelUp) / 60000);
  if (idleMin > 0 && idleMin % 10 === 0) {
    const S = c.stats || {};
    log(`⏱ [心跳] ${cur.name} Lv${S.level || cur.level} @${(c.mapName || '').replace('.gat', '')} 无升级 ${idleMin} 分钟`);
  }
  if (Date.now() - cur.lastLevelUp > 25 * 60 * 1000) {
    log('⚠ 25 分钟未升级，重进会话刷新内挂');
    cur.lastLevelUp = Date.now();
    scheduleRelogin(1000, '升级停滞看门狗');
  }
}, 60 * 1000);

// ---------- 优雅退出：Ctrl-C / kill 时按真值序列（0x00B2→0x00B3→关socket）下线，不毒化账号 ----------
function gracefulExit() {
  if (gracefulExit.done) return;
  gracefulExit.done = true;
  console.log('\n👋 收到退出信号：RESTART 握手下线中…');
  loginSeq++;                 // 阻止所有挂起的重登定时器
  clearTimeout(visitTimer);
  hunter.stop(); smartHunter.stop();
  clearInterval(botKeepTimer);
  c.quitClean().finally(() => process.exit(0));
}
process.on('SIGINT', gracefulExit);
process.on('SIGTERM', gracefulExit);

// ---------- 启动 ----------
// 错峰启动（工作台并发多个 worker 时用，避免同时登录触发频率限制）
const START_DELAY = parseInt(process.env.RO_START_DELAY || '0', 10);
setTimeout(() => {
console.log('════════════════════════════════════════════════');
console.log(`🐱 猫队练级器 v2 启动  线路=${LINE}(${LINES[LINE].address}:${LINES[LINE].port})`);
console.log(`   目标: 每账号 ${CHARS_PER_ACCT} 只猫 → ${LV_DONE} 级；${LV_MOVE} 级换 ${PAY.map}(${PAY.x},${PAY.y}) 打魔菇/青蛇`);
console.log(`   出生: ${PRT.map}(${PRT.x},${PRT.y})；加点: Str10/Agi10/Dex8 → Dex19/Str29/全Agi`);
console.log(`   收尾技能: ${FINISH_SKILLS.map((s) => `${s.name}+${s.level}`).join(', ')}`);
console.log(`   模式: ${SUPERVISION ? '离线挂机+巡访（<24级每100~150s回访补点，24+每210~270s；RO_STAY=1 切全程在线）' : '全程在线'}`);
console.log(`   账号上限: ${MAX_ACCOUNTS || '无限'}${SPECIFIED ? `；指定账号: ${SPECIFIED.split(':')[0]}` : ''}${FORCE_NEW ? '；强制新号' : ''}`);
console.log(`   账号存档: ${ACCT_FILE}`);
console.log('════════════════════════════════════════════════');
nextAccount();
}, START_DELAY * 1000);
