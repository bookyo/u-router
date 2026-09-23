#!/usr/bin/env node
// 买家测试：xiezixing2 完美护士 → 密语下单 蜗牛壳 30 → 发起交易 → 验收执行
const path = require('path');
const base = '/Users/quyue/www/u-router/ro-analysis';
const { ROClient } = require(path.join(base, 'roclient/lib/client'));
const { Bot } = require(path.join(base, 'roclient/lib/bot'));
const { BUILD } = require(path.join(base, 'roclient/lib/protocol'));
const { LoginSession, sleep } = require(path.join(base, 'roclient/lib/modules'));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);
const WANT = { name: '蜗牛壳', ITID: 946, qty: 30 };
const c = new ROClient({ line: 'eden', account: 'xiezixing2', password: process.env.RO_PASS || '' });
const bot = new Bot(c);
const login = new LoginSession(c, { account: 'xiezixing2', password: process.env.RO_PASS || '', line: 'eden', backoff: { refuse8: 12000, refuse2: 12000, disconnect: 12000, hang: 30000, banned: 30000 } }, log);
let acked = null, gotItem = null, done = false, cancelled = false, muleLocked = false;
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); });
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('trade_ack', (p) => { acked = p; });
c.on('trade_request', (p) => log('⚡(买家收到请求?) ' + p.name));
c.on('trade_item', (p) => { if (p.who) gotItem = p; });
c.on('trade_conclude', (p) => { if (p.who) muleLocked = true; });
c.on('trade_done', () => { done = true; });
c.on('trade_cancel', () => { cancelled = true; });
c.on('whisper_recv', (p) => log(`💬 商人回话: ${p.msg}`));
c.on('banned', (p) => { log(`code=${p.code}`); if ([8, 2, 15].includes(p.code)) { try { c.closeAllSockets(); } catch (_) {} login.relogin(12000, '挤号'); } else process.exit(2); });
c.on('char_list', (p) => { c.selectChar(p.chars[0].CharNum); });
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('map_enter', async () => {
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  setTimeout(() => buy().catch(async (e) => { log('异常: ' + e.message); await c.quitClean(); process.exit(1); }), 3500);
});
async function buy() {
  await sleep(2000);
  // 彻底关内挂（战斗/拾取/进食/药品槽）——内挂状态下服务器禁用交易（result=2 实证）
  for (const id of [34, 35, 36, 57]) { c.send(BUILD.notifyUpdateinfo(id, 0)); await sleep(300); }
  log('⚙ 内挂已全关（34/35/36/57=0），等 2s 生效');
  if (!c.ws || c.ws.readyState !== 1) { for (let i = 0; i < 60 && (!c.ws || c.ws.readyState !== 1); i++) await sleep(1000); }   // 等挤号完成
  if (!c.ws || c.ws.readyState !== 1) { log("❌ 60s 未连上"); process.exit(1); }
  await sleep(2500);
  if (!String(c.mapName).includes('morocc')) {
    c.send(BUILD.airshipRequest('morocc', 164, 96, 1, 14527));
    for (let i = 0; i < 20; i++) { await sleep(500); if (String(c.mapName).includes('morocc')) break; }
    await sleep(2500);
  }
  bot.updateMap('morocc'); bot.updatePos(c.position[0], c.position[1]);
  await new Promise((r) => bot.walkSmart(164, 97, () => r(), 30000));
  await sleep(1500);
  // 找蝎子商人
  let target = null;
  for (let i = 0; i < 20 && !target; i++) {   // 等实体刷新最长 40s（商人可能刚重连）
    target = [...c.entities.values()].find((e) => e.kind === 'pc' && /蝎子商人/.test(e.name || ''));
    if (!target) {
      [...c.entities.values()].filter((e) => e.kind === 'pc' && !e.name).forEach((e) => c.reqName(e.GID));
      if (i % 5 === 4) await new Promise((r) => bot.walkSmart(164, 96, () => r(), 15000));   // 每 8s 微移刷新视野
      await sleep(2000);
    }
  }
  if (!target) { log('❌ 找不到蝎子商人（mule 在线？）'); await c.quitClean(); return process.exit(1); }
  log(`🎯 蝎子商人 GID=${target.GID} @(${target.pos})`);
  if (Math.max(Math.abs(target.pos[0] - c.position[0]), Math.abs(target.pos[1] - c.position[1])) > 2) {
    await new Promise((r) => bot.walkSmart(target.pos[0] + 1, target.pos[1] + 1, () => r(), 20000));
    await sleep(800);
  }
  // ① HTTP 下单（工作台→商人控制口，免密语）
  const before = (c.inventory || []).filter((i) => i.ITID === WANT.ITID).reduce((a, b) => a + (b.count || 1), 0);
  log(`📨 API 下单「${WANT.name} ${WANT.qty}」（当前持有×${before}）`);
  const http = require('http');
  const ord = await new Promise((resolve) => {
    const rq = http.request('http://127.0.0.1:8790/order', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => { try { resolve(JSON.parse(b)); } catch (_) { resolve({ ok: false }); } }); });
    rq.on('error', () => resolve({ ok: false }));
    rq.end(JSON.stringify({ buyer: '完美护士', name: WANT.name, qty: WANT.qty }));
  });
  if (!ord.ok) { log(`❌ 下单失败: ${JSON.stringify(ord)}`); await c.quitClean(); return process.exit(1); }
  // ② 被动等待商人发起（真值方向：物主发起）；下单带自己 GID
  log(`📡 下单（buyerGID=${c.session.GID}）→ 等商人发起交易`);
  const http2 = require('http');
  await new Promise((resolve) => {
    const rq = http2.request('http://127.0.0.1:8790/order', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => { r.resume(); r.on('end', resolve); });
    rq.on('error', resolve);
    rq.end(JSON.stringify({ buyer: '完美护士', name: WANT.name, qty: WANT.qty, buyerGID: c.session.GID }));
  });
  // 收到 0x01F4 → 自动接受
  const onReq = (p) => { log(`🤝 商人 ${p.name} 发起交易 → 自动接受`); c.send(BUILD.ackExchange(0)); };
  c.on('trade_request', onReq);
  // 兼容：20s 商人没发起则买家主动
  setTimeout(() => { if (!acked && !cancelled) { log('⏱ 商人未发起，买家反向发起'); try { c.send(BUILD.requestExchange(target.GID)); } catch (_) {} } }, 20000);
  setTimeout(() => { try { c.send(BUILD.requestExchange(target.GID)); } catch (_) {} }, 40000);
  for (let i = 0; i < 30; i++) { await sleep(700); if (acked || cancelled) break; }
  if (!acked || acked.result !== 0) { log(`❌ 未确认（${acked ? 'result=' + acked.result : '无回执'}）— 请求重发一次`); c.send(BUILD.requestExchange(target.GID)); for (let i = 0; i < 20; i++) { await sleep(700); if (acked || cancelled) break; } }
  if (!acked || acked.result !== 0) { log('❌ 确认失败'); await c.quitClean(); return process.exit(1); }
  log(`✅ 商人已接受（${acked.name}），等放货`);
  // ③ 等商人放货+锁定
  for (let i = 0; i < 45; i++) { await sleep(700); if ((gotItem && muleLocked) || cancelled || done) break; }
  if (cancelled) { log('❌ 交易被取消'); await c.quitClean(); return process.exit(1); }
  if (!gotItem) { log('❌ 10s+ 未见商人放货'); c.send(BUILD.cancelExchange()); await c.quitClean(); return process.exit(1); }
  log(`📦 商人放入 #${gotItem.ITID} ×${gotItem.count}${gotItem.ITID === WANT.ITID && gotItem.count === WANT.qty ? ' ✅ 与订单一致' : ' ❌ 与订单不符'}`);
  // ④ 我方锁定 → 双方锁定后执行
  c.send(BUILD.concludeExchange());
  for (let i = 0; i < 20 && !muleLocked; i++) await sleep(500);
  if (!muleLocked) { log('⚠ 商人未锁定'); }
  log('▶ 发送执行 0x00EF');
  c.send(BUILD.execExchange());
  for (let i = 0; i < 20; i++) { await sleep(500); if (done || cancelled) break; }
  const after = (c.inventory || []).filter((i) => i.ITID === WANT.ITID).reduce((a, b) => a + (b.count || 1), 0);
  log(done ? `🎉 交易执行成功！${WANT.name}: ${before} → ${after}（+${after - before}）` : `⚠ 执行未确认（cancel=${cancelled}），库存 ${before} → ${after}`);
  await sleep(1000);
  await c.quitClean();
  process.exit(done && after - before === WANT.qty ? 0 : 1);
}
login.login();
setTimeout(async () => { log('超时'); await c.quitClean(); process.exit(3); }, 420000);
