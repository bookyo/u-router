'use strict';
/**
 * 赏金任务链路测试 v2（xiezixing3，12+1 角色轮换）
 * 链路：登录(code=8 自动挤号) → 在梦罗克? 巡路到赏金NPC : 飞艇定位飞 → 对话
 * 规则：只记录任务菜单 + 只【接取寻找类】（走失的/迷路的）；绝不点"刷新个人任务"
 *       （每号每天 1 次）——仅当 12 号统计 寻找+挖宝 < 5 时，在最后一号点一次刷新。
 * 实时面板：http://localhost:3210 （滚动 50 条行动日志）
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));

const OPT = {
  account: process.env.RO_USER || 'xiezixing3',
  password: process.env.RO_PASS || '',
  line: process.env.RO_LINE || 'eden',
  npcMap: 'morocc',
  npcX: 165, npcY: 97,
  bountyGID: 110014325,
  out: path.join(__dirname, 'data', 'bounty-accept.json'),
  port: parseInt(process.env.RO_DASH_PORT || '3210', 10),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });

// ---------------- 实时面板（最近 50 条） ----------------
const events = [];
function ui(msg, tag = '') {
  events.push({ t: ts(), tag, msg });
  if (events.length > 50) events.splice(0, events.length - 50);
  console.log(`[${ts()}]${tag ? ' ' + tag : ''} ${msg}`);
}
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>赏金链路实时面板</title>
<style>body{background:#111;color:#ddd;font:13px/1.5 Menlo,monospace;padding:12px}
.e{padding:2px 6px;border-bottom:1px solid #222}.t{color:#888;margin-right:8px}
.fly{color:#6cf}.walk{color:#9c9}.npc{color:#fc6}.ok{color:#6f6}.warn{color:#f96}
h3{color:#fff;margin:0 0 8px}</style></head><body>
<h3>🧭 赏金任务链路 · 实时行动（最近 50 条）</h3><div id="l"></div>
<script>async function tick(){try{const r=await fetch('/log.json');const es=await r.json();
document.getElementById('l').innerHTML=es.map(e=>'<div class="e"><span class="t">'+e.t+'</span><span class="'+(e.tag||'')+'">'+e.msg+'</span></div>').join('');}catch(_){}}
setInterval(tick,1000);tick();</script></body></html>`;
http.createServer((req, res) => {
  if (req.url.startsWith('/log.json')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events));
  } else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); }
}).listen(OPT.port, () => ui(`实时面板: http://localhost:${OPT.port}`, 'ok'));

// ---------------- 客户端与轮换 ----------------
const c = new ROClient({ line: OPT.line, account: OPT.account, password: OPT.password });
const bot = new Bot(c);
const records = [];
const entryFails = {};                  // slot -> 进图失败次数（≥2 跳过该角色）
let cur = null, rotating = false, loginSeq = 0, refreshUsed = false;

function scheduleRelogin(ms, reason) {
  const seq = ++loginSeq;
  ui(`${reason}，${Math.round(ms / 1000)}s 后重试`, 'warn');
  setTimeout(() => { if (seq === loginSeq) startLogin(); }, ms);
}
let loginTimer = null;
function startLogin() {
  clearTimeout(loginTimer);
  const to = loginTimer = setTimeout(() => {
    ui('12s 无响应，快速重试', 'warn');
    try { c.closeAllSockets(); } catch (_) {}
    scheduleRelogin(8000, '登录挂起');
  }, 12000);
  c.login().catch((e) => { clearTimeout(loginTimer); scheduleRelogin(15000, '登录异常 ' + e.message); });
}
c.on('login_ok', (p) => {
  loginSeq = 0; clearTimeout(loginTimer);
  const srv = p.ServerList[0];
  if (!srv) { ui('无角色服务器'); process.exit(1); }
  ui(`登录成功 AID=${p.AID}`, 'ok');
  c.connectChar(srv.ipStr, srv.port).catch(() => scheduleRelogin(10000, '连角色服失败'));
});
c.on('login_refuse', (p) => { clearTimeout(loginTimer); scheduleRelogin(p.ErrorCode === 8 || p.ErrorCode === 2 ? 45000 : 15000, `被拒 code=${p.ErrorCode}`); });
c.on('banned', (p) => {
  if (cur && !rotating) {
    entryFails[cur.slot] = (entryFails[cur.slot] || 0) + 1;
    ui(`slot${cur.slot} ${cur.name} 进图失败×${entryFails[cur.slot]}${entryFails[cur.slot] >= 2 ? '（跳过）' : ''}`, 'warn');
    cur = null;
  }
  if (!rotating) scheduleRelogin(5 * 60 * 1000, `被踢 code=${p.code}（离线锁退避 5 分钟）`);
});
c.on('disconnect', () => { if (!rotating) scheduleRelogin(25000, '连接断开'); });
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => scheduleRelogin(10000, '连图失败')));
c.on('char_refuse', () => scheduleRelogin(8000, '选角被拒'));
c.on('map_enter', (p) => {
  if (!cur) return;
  entryFails[cur.slot] = 0;
  ui(`${cur.name} 进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]})`, 'walk');
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  setTimeout(() => doBounty().catch((e) => { ui('异常: ' + e.message, 'warn'); nextChar('异常'); }), 0);
});
c.on('warp_map', (p) => {
  bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos);
  ui(`已传送 ${p.mapName} @(${p.xPos},${p.yPos})`, 'fly');
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500);
});
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));

function onCharList(p) {
  const chars = p.chars || [];
  if (!chars.length) { ui('无角色'); process.exit(1); }
  const done = new Set(records.map((r) => r.slot));
  const skip = new Set((process.env.RO_SKIP_SLOTS || '0').split(',').map((x) => parseInt(x, 10)));
  const next = chars.filter((ch) => !done.has(ch.CharNum) && !skip.has(ch.CharNum) && (entryFails[ch.CharNum] || 0) < 3)
    .sort((a, b) => a.CharNum - b.CharNum)[0];
  if (!next) return maybeRefreshThenSummary(chars);
  cur = { slot: next.CharNum, name: next.name, level: next.level, quests: [], accepted: null, held: [], offers: [], menus: 0 };
  ui(`[${records.length + 1}/${chars.length}] ${next.name} (slot${next.CharNum} Lv${next.level}) 选角`, 'npc');
  c.session.charName = next.name;
  c.selectChar(next.CharNum);
}
c.on('char_list', onCharList);

// ---------------- 单角色赏金流程 ----------------
async function doBounty() {
  await sleep(2500);
  const here = (c.mapName || '').replace(/\.gat$/i, '');
  if (here !== OPT.npcMap) {
    ui(`不在 ${OPT.npcMap}，飞艇定位飞 → (${OPT.npcX + 1},${OPT.npcY + 1})`, 'fly');
    c.airshipTeleport(OPT.npcMap, OPT.npcX + 1, OPT.npcY + 1);
    for (let i = 0; i < 30; i++) { await sleep(500); if ((c.mapName || '').includes(OPT.npcMap)) break; }
    if (!(c.mapName || '').includes(OPT.npcMap)) { ui('飞艇失败', 'warn'); return nextChar('飞艇失败'); }
    await sleep(3500);
  } else ui(`已在 ${OPT.npcMap}，巡路去赏金 NPC`, 'walk');
  bot.updatePos(c.position[0], c.position[1]);

  await sleep(1200);
  const npcs = () => [...c.entities.values()].filter((e) => e.kind === 'npc');
  npcs().filter((n) => !n.name).forEach((n) => c.reqName(n.GID));
  await sleep(2000);
  const npc = npcs().find((e) => /赏金/.test(e.name || '')) || npcs().find((e) => e.GID === OPT.bountyGID);
  if (!npc) { ui('未找到赏金 NPC', 'warn'); return nextChar('未找到NPC'); }
  ui(`赏金NPC @(${npc.pos[0]},${npc.pos[1]})`, 'npc');

  const d = Math.max(Math.abs(bot.pos[0] - npc.pos[0]), Math.abs(bot.pos[1] - npc.pos[1]));
  if (d > 2) {
    ui(`巡路 ${d} 格 → NPC 旁`, 'walk');
    await new Promise((res) => bot.walkSmart(npc.pos[0] + 1, npc.pos[1] + 1, () => res(), 30000));
    await sleep(800);
  }
  await talkBounty(npc);
  nextChar('done');
}

function talkBounty(npc) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = () => { if (resolved) return; resolved = true; cleanup(); setTimeout(resolve, 600); };
    const onSay = (p) => {
      const clean = (p.msg || '').replace(/\^([0-9a-fA-F]{6})/g, '').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      ui(`💬 ${clean.slice(0, 100)}`, 'npc');
      cur.held.push(clean.slice(0, 160));
      if (/已接受|接取了/.test(clean)) cur.accepted = clean.slice(0, 80);
      if (/当前任务|已有任务|尚未完成/.test(clean)) cur.state = clean.slice(0, 60);
    };
    const onMenu = (p) => {
      cur.menus++;
      ui(`📋 ${p.options.join(' | ').slice(0, 140)}`, 'npc');
      cur.quests.push(p.options.slice());
      for (const o of p.options) {
        const m = o.match(/\[([^\]]+)\]\s*-\s*([^★]+)/);
        if (m) cur.offers.push(`[${m[1].trim()}] ${m[2].trim()}`);
      }
      // 顶层菜单导航：先选"个人任务"进任务列表
      const pi = p.options.findIndex((o) => /^个人任务$/.test(o.trim()));
      if (pi >= 0) {
        ui('进入【个人任务】子菜单', 'npc');
        setTimeout(() => { try { c.chooseMenu(p.gid, pi + 1); } catch (_) {} }, 500);
        return;
      }
      const findOpt = p.options.findIndex((o) => /(走失的|迷路的)/.test(o));
      if (findOpt >= 0) {
        ui(`接取寻找任务: ${p.options[findOpt]}`, 'ok');
        cur.accepted = cur.accepted || p.options[findOpt];
        setTimeout(() => { try { c.chooseMenu(p.gid, findOpt + 1); } catch (_) {} }, 500);
        return;
      }
      if (cur.allowRefresh && !refreshUsed) {
        const ri = p.options.findIndex((o) => /刷新个人任务/.test(o));
        if (ri >= 0) {
          refreshUsed = true;
          ui('点击一次『刷新个人任务』（全局授权）', 'warn');
          setTimeout(() => { try { c.chooseMenu(p.gid, ri + 1); } catch (_) {} }, 500);
          return;
        }
      }
      setTimeout(() => { try { c.closeDialog(p.gid); } catch (_) {} }, 400); // 不乱接不刷新
    };
    const onWait = (p) => setTimeout(() => { try { c.nextDialog(p.gid); } catch (_) {} }, 400);
    const onClose = () => done();
    const cleanup = () => {
      c.removeListener('dialog_say', onSay); c.removeListener('dialog_menu', onMenu);
      c.removeListener('dialog_wait', onWait); c.removeListener('dialog_close', onClose);
    };
    c.on('dialog_say', onSay); c.on('dialog_menu', onMenu);
    c.on('dialog_wait', onWait); c.on('dialog_close', onClose);
    setTimeout(done, 20000);
    try { bot.talkTo(npc.GID); } catch (_) { done(); }
  });
}

function nextChar(reason) {
  if (!cur) return;
  cur.reason = reason;
  records.push(cur);
  save();
  ui(`${cur.name} 完成（${reason}）→ 回选角`, 'ok');
  cur = null;
  rotating = true; c.rotating = true;
  try { c.restartToCharSelect(); } catch (e) { scheduleRelogin(5000, '回选角失败'); }
  setTimeout(() => { rotating = false; }, 3000);
}

function save() {
  try { fs.mkdirSync(path.dirname(OPT.out), { recursive: true }); fs.writeFileSync(OPT.out, JSON.stringify({ account: OPT.account, at: new Date().toISOString(), records }, null, 2)); } catch (_) {}
}

function classify() {
  const all = [];
  for (const r of records) for (const o of (r.offers || [])) all.push({ char: r.name, task: o });
  return {
    all,
    find: all.filter((x) => /走失的|迷路的/.test(x.task)),
    dig: all.filter((x) => /挖宝|寻宝/.test(x.task)),
  };
}

function maybeRefreshThenSummary(chars) {
  const { find, dig } = classify();
  ui(`首轮完成：寻找类 ${find.length}、挖宝类 ${dig.length}`, 'ok');
  if (find.length + dig.length < 5 && !refreshUsed) {
    const last = chars.slice().sort((a, b) => b.CharNum - a.CharNum)[0];
    const rec = records.find((r) => r.slot === last.CharNum);
    if (rec) { rec.allowRefresh = true; records.splice(records.indexOf(rec), 1); cur = rec; }
    ui(`寻找+挖宝 < 5 → 回最后一号 ${last.name} 点击一次刷新`, 'warn');
    c.session.charName = last.name;
    setTimeout(() => c.selectChar(last.CharNum), 800);
    return;
  }
  summary();
}

function summary() {
  const { find, dig } = classify();
  ui('══════════ 任务记录汇总 ════════', 'ok');
  for (const r of records.sort((a, b) => a.slot - b.slot)) {
    ui(`slot${String(r.slot).padStart(2)} ${r.name.padEnd(10)} Lv${String(r.level).padStart(3)} 菜单${r.menus}次 接取:${r.accepted || '-'}${r.state ? ' 状态:' + r.state : ''}`);
    for (const o of [...new Set(r.offers || [])]) ui(`     · ${o}`);
  }
  ui(`—— 类型统计：寻找类 ${find.length}、挖宝类 ${dig.length}（阈值 5）——`, find.length + dig.length >= 5 ? 'ok' : 'warn');
  save();
  c.quitClean().finally(() => process.exit(0));
}

process.on('SIGINT', () => { save(); ui('中断退出', 'warn'); process.exit(0); });
ui(`=== 赏金任务链路测试 === ${OPT.account}@${OPT.line}，面板 :${OPT.port}`, 'ok');
startLogin();
