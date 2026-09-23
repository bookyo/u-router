#!/usr/bin/env node
// 交易请求测试：xiezixing2 完美护士 → morocc(163,96) 蝎子商人
const path = require('path');
const base = '/Users/quyue/www/u-router/ro-analysis';
const { ROClient } = require(path.join(base, 'roclient/lib/client'));
const { Bot } = require(path.join(base, 'roclient/lib/bot'));
const { BUILD } = require(path.join(base, 'roclient/lib/protocol'));
const { LoginSession, sleep } = require(path.join(base, 'roclient/lib/modules'));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);
const c = new ROClient({ line: 'eden', account: 'xiezixing2', password: process.env.RO_PASS || '' });
const bot = new Bot(c);
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); });
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
const login = new LoginSession(c, { account: 'xiezixing2', password: process.env.RO_PASS || '', line: 'eden', backoff: { refuse8: 10000, refuse2: 10000 } }, log);
let acked = null, incoming = null;
c.on('trade_ack', (p) => { acked = p; });
c.on('trade_request', (p) => { incoming = p; });
c.on('banned', (p) => { log(`被踢 code=${p.code}`); if (p.code === 8 || p.code === 2) return; process.exit(2); });
c.on('char_list', (p) => { c.selectChar(p.chars[0].CharNum); });
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('map_enter', async () => {
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  try { await test(); } catch (e) { log('异常: ' + e.message); }
  await c.quitClean(); process.exit(0);
});
async function test() {
  await sleep(3000);
  // 到 morocc 商人点
  if (!String(c.mapName).includes('morocc')) {
    log('飞艇 → morocc');
    c.send(BUILD.airshipRequest('morocc', 163, 97, 1, 14527));
    for (let i = 0; i < 20; i++) { await sleep(500); if (String(c.mapName).includes('morocc')) break; }
    await sleep(2500);
  }
  log(`📍 ${c.mapName} @(${c.position})`);
  // 走到 (163,96) 旁（贴身 1 格）
  bot.updateMap('morocc'); bot.updatePos(c.position[0], c.position[1]);
  await new Promise((r) => bot.walkSmart(164, 96, () => r(), 30000));
  await sleep(2000);
  // 找目标：名字匹配或坐标±3 的 pc 实体
  let target = null;
  for (let round = 0; round < 5 && !target; round++) {
    const pcs = [...c.entities.values()].filter((e) => e.kind === 'pc');
    target = pcs.find((e) => /蝎子商人/.test(e.name || ''));
    // 只认名字：避免误伤路人
    if (!target) { pcs.filter((e) => !e.name).forEach((e) => c.reqName(e.GID)); await sleep(1500); }
  }
  if (!target) {
    log('❌ 视野内没有玩家实体（蝎子商人不在线或不在 163,96？）附近实体: ' +
      [...c.entities.values()].filter((e) => e.kind === 'pc').map((e) => `${e.name || '#' + e.GID}@(${e.pos})`).join(' ').slice(0, 150));
    return;
  }
  log(`🎯 目标: ${target.name || '(未知名)'} GID=${target.GID} @(${target.pos}) 距离 ${Math.max(Math.abs(target.pos[0] - c.position[0]), Math.abs(target.pos[1] - c.position[1]))} 格`);
  if (Math.max(Math.abs(target.pos[0] - c.position[0]), Math.abs(target.pos[1] - c.position[1])) > 2) {
    await new Promise((r) => bot.walkSmart(target.pos[0] + 1, target.pos[1] + 1, () => r(), 20000));
    await sleep(800);
  }
  log('🤝 发送交易请求 0x00E4 ...');
  c.send(BUILD.requestExchange(target.GID));
  for (let i = 0; i < 55; i++) { await sleep(700); if (acked || incoming) break; }  // 等 38s 用户确认
  if (acked) {
    log(`📋 回执 result=${acked.result}（${['已发送待确认', '距离太远', '对方交易中', '交易禁用', '繁忙'][acked.result] || '?'}）对方: ${acked.name}`);
    if (acked.result === 0) { log('✅✅ 对方已接受！交易窗口打开 —— 全链路打通（加物品/锁定/执行留待下阶段）'); await sleep(2500); c.send(BUILD.cancelExchange()); log('已发取消 0x00ED 收尾'); }
  } else if (incoming) {
    log(`⚡ 对方先请求了我们（${incoming.name}）— 服务器撮合成功`);
    c.send(BUILD.cancelExchange());
  } else log('⚠ 10s 无回执（对方可能不在线或封包结构需调整）');
}
login.login();
setTimeout(async () => { log('超时'); await c.quitClean(); process.exit(3); }, 120000);
