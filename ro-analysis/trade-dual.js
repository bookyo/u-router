#!/usr/bin/env node
// 双端合体调试：买家(x2)+商人(x4) 同进程，交易全流程+全封包可见
const path = require('path');
const base = '/Users/quyue/www/u-router/ro-analysis';
const { ROClient } = require(path.join(base, 'roclient/lib/client'));
const { Bot } = require(path.join(base, 'roclient/lib/bot'));
const { BUILD } = require(path.join(base, 'roclient/lib/protocol'));
const { LoginSession, sleep } = require(path.join(base, 'roclient/lib/modules'));
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const mk = (tag) => (m) => console.log(`[${ts()}][${tag}] ${m}`);

// ---------- 商人端 ----------
const mc = new ROClient({ line: 'eden', account: 'xiezixing4', password: process.env.RO_PASS || '' });
const mlog = mk('商人');
const mlogin = new LoginSession(mc, { account: 'xiezixing4', password: process.env.RO_PASS || '', line: 'eden', backoff: { refuse8: 10000, refuse2: 10000 } }, mlog);
mc.on('banned', (p) => { if (p.code === 8 || p.code === 2) { try { mc.closeAllSockets(); } catch (_) {} mlogin.relogin(12000, '挤'); } });
mc.on('char_list', (p) => mc.selectChar(p.chars[0].CharNum));
mc.on('zone_info', (p) => mc.connectZone(p.ipStr, p.port));
mc.on('map_enter', () => { setTimeout(() => { try { mc.mapLoaded(); } catch (_) {} }, 500); mlog('就位'); });
// ===== 钱判定版商人（交易窗内等对方放钱+锁定 → 核对 单价×数量 → 锁+执行） =====
const MULE_PRICE = parseInt(process.env.PRICE || '100', 10);   // 单价 z
const muleItem = () => (mc.inventory || []).find((i) => i.ITID === 946) || (mc.inventory || [])[0];   // 蜗牛壳或首件
let mWin = false, mZeny = 0, mLocked = false;
mc.on('trade_request', (p) => {
  mlog(`🤝 ${p.name}(Lv${p.level}) 请求 → 1s 后接受`);
  setTimeout(() => {
    mc.send(BUILD.ackExchange(0));
    mWin = true; mZeny = 0; mLocked = false;
    mlog('✅ 已接受，交易窗开');
    // 放货（1s 后，用背包 index）
    setTimeout(() => {
      const it = muleItem();
      if (it) { mc.send(BUILD.addExchange(it.index, 5)); mlog(`📤 放入 #${it.ITID}×5`); }
      setTimeout(() => { try { mc.send(BUILD.addExchange(0, 0)); } catch (_) {} }, 600);   // 空放=放完标记
    }, 1200);
  }, 1000);
});
mc.on('trade_item', (p) => {
  if (!p.who) return;
  if (p.ITID === 0) { mZeny += p.count; mlog(`💰 对方放入 ${p.count}z（累计 ${mZeny}/${MULE_PRICE * 5}）`); }
  else mlog(`📥 对方放入 #${p.ITID}×${p.count}`);
});
mc.on('trade_conclude', (p) => {
  if (!p.who) return;
  mLocked = true;
  const expect = MULE_PRICE * 5;
  if (mZeny !== expect) {
    mlog(`❌ 钱不符：应收 ${expect}z 实收 ${mZeny}z → 取消`);
    mc.send(BUILD.cancelExchange());
    return;
  }
  mlog(`✅ 钱校验通过 ${mZeny}z → 商人锁定 → 执行`);
  mc.send(BUILD.concludeExchange());
  setTimeout(() => mc.send(BUILD.execExchange()), 800);
  setTimeout(() => mc.send(BUILD.execExchange()), 2200);
});
mc.on('trade_done', () => mlog('🎉 交易执行完成'));
mc.on('trade_cancel', () => mlog('✖ 取消'));

// ---------- 买家端 ----------
const bc = new ROClient({ line: 'eden', account: 'xiezixing2', password: process.env.RO_PASS || '' });
const blog = mk('买家');
const blogin = new LoginSession(bc, { account: 'xiezixing2', password: process.env.RO_PASS || '', line: 'eden', backoff: { refuse8: 10000, refuse2: 10000 } }, blog);
const bot = new Bot(bc);
bc.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); });
bc.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
bc.on('banned', (p) => { if (p.code === 8 || p.code === 2) { try { bc.closeAllSockets(); } catch (_) {} blogin.relogin(12000, '挤'); } });
bc.on('char_list', (p) => bc.selectChar(p.chars[0].CharNum));
bc.on('zone_info', (p) => bc.connectZone(p.ipStr, p.port));
bc.on('map_enter', () => { setTimeout(() => { try { bc.mapLoaded(); } catch (_) {} }, 500); setTimeout(() => buy().catch((e) => blog('异常 ' + e.message)), 3000); });
let acked = null, muleLocked = false, done = false, cancelled = false, gotItem2 = null;
bc.on('trade_ack', (p) => { acked = p; blog(`🤝 回执 result=${p.result}`); });
bc.on('trade_item', (p) => { blog(`📦 对方放入 #${p.ITID}×${p.count}`); if (p.who) gotItem2 = p; });
bc.on('trade_conclude', (p) => { if (p.who) { muleLocked = true; blog('🔓 商人已锁'); } });
bc.on('trade_done', () => { done = true; blog('🎉 执行成功'); });
bc.on('trade_cancel', () => { cancelled = true; blog('✖ 取消'); });

async function buy() {
  if (!String(bc.mapName).includes('morocc')) {
    bc.send(BUILD.airshipRequest('morocc', 164, 97, 1, 14527));
    for (let i = 0; i < 20; i++) { await sleep(500); if (String(bc.mapName).includes('morocc')) break; }
    await sleep(2500);
  }
  bot.updateMap('morocc'); bot.updatePos(bc.position[0], bc.position[1]);
  await new Promise((r) => bot.walkSmart(164, 96, () => r(), 30000));
  await sleep(1500);
  bc.send(BUILD.notifyUpdateinfo(34, 0));   // 关自动战斗（防服务器禁止战斗态交易）
  let target = null;
  for (let i = 0; i < 5 && !target; i++) {
    target = [...bc.entities.values()].find((e) => e.kind === 'pc' && /蝎子商人/.test(e.name || ''));
    if (!target) { [...bc.entities.values()].filter((e) => e.kind === 'pc' && !e.name).forEach((e) => bc.reqName(e.GID)); await sleep(1200); }
  }
  if (!target) { blog('❌ 找不到蝎子商人'); process.exit(1); }
  blog(`🎯 蝎子商人 GID=${target.GID} 距离${Math.max(Math.abs(target.pos[0] - bc.position[0]), Math.abs(target.pos[1] - bc.position[1]))}格`);
  // HTTP 直下订单（工作台→商人控制口模式），免密语
  const http = require('http');
  const ord = await new Promise((resolve) => {
    const rq = http.request('http://127.0.0.1:8790/order', { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (r) => { let b = ''; r.on('data', (d) => b += d); r.on('end', () => resolve(JSON.parse(b))); });
    rq.on('error', () => resolve({ ok: false }));
    rq.end(JSON.stringify({ buyer: '完美护士', name: '蜗牛壳', qty: 30 }));
  });
  if (!ord.ok) { blog(`❌ 下单失败: ${JSON.stringify(ord)}`); process.exit(1); }
  blog('✅ 订单已下（API），发起交易');
  bc.send(BUILD.requestExchange(target.GID));
  blog('🤝 已发请求，等待...');
  for (let i = 0; i < 25; i++) { await sleep(700); if (acked || cancelled) break; }
  if (!acked || acked.result !== 0) {
    blog(`❌ 无回执 — 发重试请求一次`);
    bc.send(BUILD.requestExchange(target.GID));
    for (let i = 0; i < 20; i++) { await sleep(700); if (acked || cancelled) break; }
    if (!acked) { blog('❌ 两次均无回执'); await Promise.all([bc.quitClean(), mc.quitClean()]); return process.exit(1); }
  }
  // 等商人放货 → 买家放钱（index=0 即 zeny 通道）→ 锁定
  for (let i = 0; i < 25; i++) { await sleep(700); if (gotItem2 || cancelled || done) break; }
  if (!gotItem2) { blog('❌ 商人未放货'); bc.send(BUILD.cancelExchange()); await Promise.all([bc.quitClean(), mc.quitClean()]); return process.exit(1); }
  const PAY = parseInt(process.env.PRICE || '100', 10) * 5 - (process.env.WRONG === '1' ? 1 : 0);
  if (PAY > 0) {
    blog(`💰 放钱 ${PAY}z`);
    bc.send(BUILD.addExchange(0, PAY));
    await sleep(1500);
  }
  if (!cancelled && !done) { bc.send(BUILD.concludeExchange()); blog('🔒 买家锁定'); }
  for (let i = 0; i < 15; i++) { await sleep(700); if (done || cancelled) break; }
  if (!done && !cancelled) { blog('▶ 发执行'); bc.send(BUILD.execExchange()); }
  for (let i = 0; i < 15; i++) { await sleep(600); if (done || cancelled) break; }
  const after = (bc.inventory || []).filter((i) => i.ITID === 946).reduce((a, b) => a + (b.count || 1), 0);
  blog(done ? `🎉🎉 交易闭环成功！蜗牛壳 ×${after}` : `⚠ 未完成 done=${done} cancel=${cancelled} 背包蜗牛壳=${after}`);
  await Promise.all([bc.quitClean(), mc.quitClean()]);
  process.exit(done ? 0 : 1);
}
mlogin.login();
blogin.login();
setTimeout(() => process.exit(3), 180000);
