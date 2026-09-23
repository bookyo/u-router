#!/usr/bin/env node
// 买方 v2：与 ro-mule-shop-extension 插件逐包同构的自动交易实测
// 流程：登录 → 飞到商人旁 → POST /trade（商人主动发起）→ 收 0x01F4 验名 → 0x00E6 接受
//       → 0x00E8(0,总价) 放钱一次 → 0x00EB 锁定 → 见 0x00EC(who=0) 后 0x00EF 执行 → 0x00F0 判定
// 用法：RO_USER=xiezixing9 ITEM=香菇芽孢 QTY=5 [WRONG=1] node mule-buyer-v2.js
const path = require('path');
const base = __dirname;
const { ROClient } = require(path.join(base, 'roclient/lib/client'));
const { Bot } = require(path.join(base, 'roclient/lib/bot'));
const { BUILD } = require(path.join(base, 'roclient/lib/protocol'));
const { LoginSession, sleep } = require(path.join(base, 'roclient/lib/modules'));
const http = require('http');
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);

const ACCT = process.env.RO_USER || 'xiezixing9';
const PASS = process.env.RO_PASS || '';
const ITEM = process.env.ITEM || '香菇芽孢';
const QTY = parseInt(process.env.QTY || '5', 10);
const WRONG = process.env.WRONG === '1';
const MULE = 'http://127.0.0.1:8790';

const c = new ROClient({ line: 'eden', account: ACCT, password: PASS });
const bot = new Bot(c);
const login = new LoginSession(c, { account: ACCT, password: PASS, line: 'eden',
  backoff: { refuse8: 12000, refuse2: 12000, disconnect: 12000, hang: 30000, banned: 30000 } }, log);

let armed = false, muleLocked = false, done = null, cancelled = false, placed = false, accepted = false;
const t0 = () => Date.now();
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); });
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('banned', (p) => { if ([8, 2, 15].includes(p.code)) { try { c.closeAllSockets(); } catch (_) {} login.relogin(12000, '挤号'); } else process.exit(2); });
c.on('char_list', (p) => { const ch = p.chars.find((x) => x.level >= 30) || p.chars[0]; c.session.charName = ch.name; log(`🎭 选角: ${ch.name} (Lv${ch.level})`); c.selectChar(ch.CharNum); });
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
let entryCount = 0;
c.on('map_enter', () => {
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  entryCount++;
  if (entryCount === 1) {
    // 刷新式登录：lvl 队列出身的角色首次进图必须 RESTART 回选角重进，清除离线机器人态（否则实体单向不可见、交易进不来）
    log('♻ 刷新式登录：回选角清除离线态，2s 后重进');
    c.rotating = true;
    try { c.restartToCharSelect(); } catch (_) {}
    setTimeout(() => { c.rotating = false; }, 4000);
    return;
  }
  setTimeout(() => run().catch((e) => { log('异常: ' + e.message); process.exit(1); }), 3500);
});

// —— 插件同构交易状态机（买家主动发起变体：时序挂在发起回执上） ——
c.on('trade_ack', (p) => {
  if (p.result !== 0 && p.result !== 3) { log(`⚠ 发起被拒 code=${p.result}`); return; }
  if (accepted || !armed) return;
  accepted = true;
  log('✅ 商人接受，交易窗开');
  const pay = armed.pay;
  setTimeout(() => {
    if (pay > 0) { c.send(BUILD.addExchange(0, pay)); placed = true; log(`💰 放钱 ${pay}z（0x00E8(0,${pay})，只放一次）`); }
  }, 400);
  setTimeout(() => { c.send(BUILD.concludeExchange()); log('🔒 已锁定，等商人验钱…'); }, 900);
});
c.on('trade_conclude', (p) => { if (p.who) { muleLocked = true; log('🔓 商人已锁定（验钱通过）→ 执行'); setTimeout(() => c.send(BUILD.execExchange()), 400); } });
c.on('trade_done', (p) => { done = p.result; });
c.on('trade_cancel', () => { cancelled = true; });

const req = (url, obj) => new Promise((resolve) => {
  const rq = http.request(url, { method: obj ? 'POST' : 'GET', headers: obj ? { 'Content-Type': 'application/json' } : {} }, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve({}); } }); });
  rq.on('error', () => resolve({}));
  rq.end(obj ? JSON.stringify(obj) : undefined);   // GET 也必须 end()，否则请求根本不发出
});

async function run() {
  await sleep(2500);
  const stock = await req(MULE + '/stock');
  const item = (stock.items || []).find((i) => i.name === ITEM);
  const unit = item ? item.price : 0;
  const total = unit * QTY;
  log(`📋 ${ITEM} 库存×${item ? item.count : '?'} 单价 ${unit}z → 应付 ${total}z${WRONG ? '（故意少 1z）' : ''}`);
  // 飞到商人旁
  for (let att = 0; att < 2; att++) {
    c.send(BUILD.airshipRequest('morocc', 183, 87, 1, 14527));
    await sleep(3000);
    const [px, py] = c.position || [0, 0];
    if (Math.abs(px - 183) <= 4 && Math.abs(py - 87) <= 4) break;
    log(`落点 (${px},${py}) 偏离，重飞`);
  }
  await bot.updateMap('morocc');
  await new Promise((r) => bot.walkSmart(182, 86, () => r(), 45000));
  await sleep(1500);
  log(`🧍 就位 @${(c.position || []).join(',')}`);
  // 下单：被动武装（不带 buyerGID → 商人等买家发起；node 客户端角色对商人单向不可见，/trade 主动发起路径只适用于真实网页端买家）
  const od = await req(MULE + '/order', { buyer: c.session.charName, name: ITEM, qty: QTY, forcePaid: true });
  log(`📨 /order 回执: ${JSON.stringify(od)}`);
  if (!od.ok) { await c.quitClean(); return process.exit(1); }
  armed = { pay: WRONG ? Math.max(0, od.price - 1) : od.price, at: t0() };
  log(`⚔ 挂单武装：${ITEM}×${QTY} = ${armed.pay}z，买家主动发起交易…`);
  // 找商人实体并发起（买家侧可见性正常）
  let target = null;
  for (let i = 0; i < 12 && !target; i++) {
    target = [...c.entities.values()].find((e) => e.kind === 'pc' && /蝎子商人/.test(e.name || ''));
    if (!target) { [...c.entities.values()].filter((e) => e.kind === 'pc' && !e.name).forEach((e) => c.reqName(e.GID)); await sleep(1200); }
  }
  if (!target) { log('❌ 找不到蝎子商人实体'); await c.quitClean(); return process.exit(1); }
  log(`🎯 商人 GID=${target.GID} → 0x00E4 发起`);
  c.send(BUILD.requestExchange(target.GID));
  for (let i = 0; i < 40 && accepted === false && !cancelled; i++) await sleep(500);
  if (!accepted) { log('❌ 45s 未完成接受握手'); await c.quitClean(); return process.exit(1); }
  for (let i = 0; i < 60 && done === null && !cancelled; i++) await sleep(500);
  if (done === 0) {
    const inv = (c.inventory || []).filter((i) => i.ITID === 921).reduce((a, b) => a + (b.count || 1), 0);
    log(`🎉 成交！背包香菇芽孢现有 ${inv} 个（清点库存变化请对照下单前）`);
  } else if (cancelled) log('❌ 交易被取消（钱不符 → 符合预期）');
  else log(`⚠ 结束态 done=${done} cancelled=${cancelled}`);
  await sleep(1200);
  await c.quitClean();
  process.exit(done === 0 ? 0 : cancelled ? 3 : 1);
}
login.login();
setTimeout(async () => { log('总超时'); await c.quitClean(); process.exit(3); }, 300000);
