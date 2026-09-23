#!/usr/bin/env node
// 买方测试（带放钱）：登录 → 飞商人 → 下单（API）→ 接受交易 → 放钱 addExchange(0, amount) → 锁定 → 执行
// 用法：RO_USER=xiezixing8 [WRONG=1] node mule-buyer-test.js  （WRONG=1 放错钱测试取消分支）
const path = require('path');
const base = __dirname;
const { ROClient } = require(path.join(base, 'roclient/lib/client'));
const { Bot } = require(path.join(base, 'roclient/lib/bot'));
const { BUILD } = require(path.join(base, 'roclient/lib/protocol'));
const { LoginSession, sleep } = require(path.join(base, 'roclient/lib/modules'));
const http = require('http');
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);

const ACCT = process.env.RO_USER || 'xiezixing8';
const PASS = process.env.RO_PASS || '';
const WANT = { name: process.env.ITEM || '蜗牛壳', qty: parseInt(process.env.QTY || '5', 10) };
const WRONG = process.env.WRONG === '1';   // 故意放错钱（少 1z）测试商人取消
const PRICE_OVERRIDE = parseInt(process.env.PRICE || '0', 10);   // >0 时下单前设置单价

const c = new ROClient({ line: 'eden', account: ACCT, password: PASS });
const bot = new Bot(c);
const login = new LoginSession(c, { account: ACCT, password: PASS, line: 'eden', backoff: { refuse8: 12000, refuse2: 12000, disconnect: 12000, hang: 30000, banned: 30000 } }, log);
let acked = null, gotItem = null, done = false, cancelled = false, muleLocked = false, zenyAckSeen = false;
const botState = { attack: null, pick: null, eat: null };
let lastLockAt = 0;
c.on('server_msg', (p) => {
  const m = p.msg || '';
  if (/开启自动战斗/.test(m)) botState.attack = true;
  else if (/关闭自动战斗/.test(m)) botState.attack = false;
  else if (/锁定坐标/.test(m)) lastLockAt = Date.now();
});
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); });
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('trade_ack', (p) => { acked = p; });
c.on('trade_request', (p) => { log(`🤝 商人发起交易 → 接受`); try { c.send(BUILD.ackExchange(0)); } catch (_) {} });
c.on('trade_item', (p) => {
  if (p.who) { gotItem = p; log(`📦 商人放入 #${p.ITID} ×${p.count}`); }
  else if (p.ITID === 0 && p.count > 0) { zenyAckSeen = true; log(`💰 我方放钱回执 ${p.count}z`); }
});
c.on('trade_conclude', (p) => { if (p.who) { muleLocked = true; log('🔓 商人已锁定'); } });
c.on('trade_done', (p) => { done = true; log(`✅ 交易执行 result=${p.result}`); });
c.on('trade_cancel', () => { cancelled = true; log('❌ 交易被取消'); });
c.on('whisper_recv', (p) => log(`💬 商人: ${p.msg}`));
c.on('banned', (p) => { if ([8, 2, 15].includes(p.code)) { try { c.closeAllSockets(); } catch (_) {} login.relogin(12000, '挤号'); } else process.exit(2); });
c.on('char_list', (p) => { const ch = p.chars.find(x => x.level >= 30) || p.chars[0]; c.session.charName = ch.name; c.selectChar(ch.CharNum); });
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('map_enter', () => {
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  setTimeout(() => buy().catch(async (e) => { log('异常: ' + e.message); await c.quitClean(); process.exit(1); }), 3500);
});

const post = (url, obj) => new Promise((resolve) => {
  const rq = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve({ ok: false, raw: b.slice(0, 100) }); } }); });
  rq.on('error', () => resolve({ ok: false }));
  rq.end(JSON.stringify(obj));
});

async function buy() {
  await sleep(2500);
  await sleep(2500);   // 刷新式登录已自动关内挂（真值）——不发开关

  // 定价（测试用）：蜗牛壳 100z
  if (PRICE_OVERRIDE > 0) { await post('http://127.0.0.1:8790/price', { name: WANT.name, price: PRICE_OVERRIDE }); log(`🏷 定价 ${WANT.name}=${PRICE_OVERRIDE}z`); }
  const stock = await new Promise((res) => http.get('http://127.0.0.1:8790/stock', (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { res(JSON.parse(b)); } catch (_) { res({}); } }); }).on('error', () => res({})));
  const item = (stock.items || []).find((i) => i.name === WANT.name);
  const unit = PRICE_OVERRIDE || (item ? item.price : 0) || 0;
  const total = unit * WANT.qty;
  log(`📋 ${WANT.name} 库存×${item ? item.count : '?'} 单价 ${unit}z → 应付 ${total}z${WRONG ? `（故意付 ${total - 1}z 测试取消）` : ''}`);
  // 飞商人
  for (let att = 0; att < 2; att++) {
    c.send(BUILD.airshipRequest('morocc', 183, 87, 1, 14527));
    await sleep(2800);
    const [px, py] = c.position || [0, 0];
    if (Math.abs(px - 183) <= 3 && Math.abs(py - 87) <= 3) break;
    log(`落点 (${px},${py}) 偏离`);
  }
  let [bx, by] = c.position || [0, 0];
  if (Math.abs(bx - 183) > 3 || Math.abs(by - 87) > 3) {
    await bot.updateMap('morocc');
    log(`🚶 走到商人旁（当前 ${bx},${by}）`);
    await new Promise((r) => bot.walkSmart(183, 87, () => r(), 60000));
  }
  await sleep(2000);   // 刷新登录后内挂已自动关（用户真值）——绝不再发开关
  log(`🧍 就位 @(${(c.position || [0, 0])[0]},${(c.position || [0, 0])[1]})`);
  bot.updatePos(c.position[0], c.position[1]);
  await new Promise((r) => bot.walkSmart(183, 87, () => r(), 30000));
  await sleep(1200);
  let target = null;
  for (let i = 0; i < 15 && !target; i++) {
    target = [...c.entities.values()].find((e) => e.kind === 'pc' && /蝎子商人/.test(e.name || ''));
    if (!target) { [...c.entities.values()].filter((e) => e.kind === 'pc' && !e.name).forEach((e) => c.reqName(e.GID)); await sleep(1500); }
  }
  if (!target) { log('❌ 找不到蝎子商人'); await c.quitClean(); return process.exit(1); }
  log(`🎯 商人 GID=${target.GID}`);
  // 下单（带 buyerGID 让商人主动发起）
  const od = await post('http://127.0.0.1:8790/order', { buyer: c.session.charName, name: WANT.name, qty: WANT.qty, buyerGID: c.session.GID, buyerAID: c.session.AID, forcePaid: unit > 0 });
  log(`📨 下单回执: ${JSON.stringify(od)}`);
  if (!od.ok) { await c.quitClean(); return process.exit(1); }
  // 等交易窗（商人发起 or 20s 后自发起）
  // 买家主动发起（昨天验证方向：买家→实体GID→商人ACK→真实握手）
  await sleep(3000);
  log('🤝 买家发起交易 → 商人实体');
  c.send(BUILD.requestExchange(target.GID));
  for (let i = 0; i < 30; i++) { await sleep(700); if (acked || cancelled) break; }
  if (!acked && !cancelled) { log('⏱ 5s 无回执重发'); c.send(BUILD.requestExchange(target.GID)); for (let i = 0; i < 20; i++) { await sleep(700); if (acked || cancelled) break; } }
  if (!acked || acked.result !== 0) { log('❌ 交易窗未开'); await c.quitClean(); return process.exit(1); }
  log('✅ 交易窗已开');
  // 等商人放货
  for (let i = 0; i < 30; i++) { await sleep(700); if (gotItem || cancelled) break; }
  if (cancelled) { log('结果：交易被商人取消（钱校验或其他）'); await c.quitClean(); return process.exit(0); }
  if (!gotItem) { log('❌ 商人未放货'); c.send(BUILD.cancelExchange()); await c.quitClean(); return process.exit(1); }
  // 放钱（ITID=0 即 zeny 通道；amount=金额）→ 等回执 → 锁定 → 执行
  const pay = WRONG ? Math.max(0, total - 1) : total;
  if (total > 0) {
    log(`💰 放钱 ${pay}z（addExchange(0, ${pay})）`);
    c.send(BUILD.addExchange(0, pay));
    await sleep(1500);
    if (!zenyAckSeen) { log('   （无 0x00E9 回执，再放一次）'); c.send(BUILD.addExchange(0, pay)); await sleep(1500); }
  } else log('授权免费订单，跳过放钱');
  log('🔒 我方锁定');
  c.send(BUILD.concludeExchange());
  for (let i = 0; i < 30; i++) { await sleep(700); if (done || cancelled) break; if (!muleLocked) log('   等商人锁定/校验…'); }
  if (cancelled) { log('结果：❌ 商人取消（钱不符 → 正确行为）'); await c.quitClean(); return process.exit(0); }
  if (done) { log('结果：🎉 成交'); }
  else {
    log('▶ 我方执行确认');
    c.send(BUILD.execExchange());
    for (let i = 0; i < 15; i++) { await sleep(700); if (done || cancelled) break; }
    log(done ? '结果：🎉 成交' : cancelled ? '结果：❌ 取消' : '结果：⚠ 超时');
  }
  await sleep(1200);
  await c.quitClean();
  process.exit(0);
}
login.login();
setTimeout(async () => { log('总超时'); await c.quitClean(); process.exit(3); }, 300000);
