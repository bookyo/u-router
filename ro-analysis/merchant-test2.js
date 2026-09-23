#!/usr/bin/env node
'use strict';
// 商人买卷轴单测 v2 —— 全部使用可复用模块
const path = require('path');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));
const { BUILD } = require(path.join(__dirname, 'roclient/lib/protocol'));
const { LoginSession, CharRotate, Navigator, NpcTalk, sleep } = require(path.join(__dirname, 'roclient/lib/modules'));

const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] ${m}`);
const c = new ROClient({ line: 'eden', account: 'xiezixing2', password: process.env.RO_PASS || '', verbose: false });
const bot = new Bot(c);
const login = new LoginSession(c, { account: 'xiezixing2', password: process.env.RO_PASS || '', line: 'eden' }, log);
const nav = new Navigator(c, bot, {}, log);
const talk = new NpcTalk(c, bot);
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); log(`⚡ ${p.mapName}`); setTimeout(() => { try { c.mapLoaded(); } catch(_){} }, 1500); });

const rot = new CharRotate(c, { skipSlots: [0], switchGapMs: 0, maxEntryFails: 2 }, async (ch) => {
  log(`=== ${ch.name} 商人测试 ===`);
  // 1. 飞艇到梦罗克商人区
  if (!(await nav.goto('morocc', 147, 104))) { log('飞艇失败'); return; }
  // 2. 走到商人
  await nav.walk(148, 104, 30000);
  // 3. 找道具商人：精确名字优先，且必须在自己 5 格内
  let shop = await talk.find(/道具商人/);
  if (!shop) {
    const near = [...c.entities.values()].filter((e) => e.kind === 'npc' && /商人/.test(e.name || '')
      && e.pos && Math.max(Math.abs(e.pos[0] - 148), Math.abs(e.pos[1] - 104)) <= 5);
    shop = near[0];
  }
  if (!shop) { log('视野内无商人（5格内）'); return; }
  log(`🎯 ${shop.name} GID=${shop.GID} @(${shop.pos[0]},${shop.pos[1]})`);
  // 走到商人身旁（紧贴）
  await nav.walk(shop.pos[0] + 1, shop.pos[1] + 1, 15000);
  await sleep(500);
  // 4. 买卷轴
  // 调试：手动发 contactNpc 并记录原始字节
  const { BinaryWriter } = require(path.join(__dirname, 'roclient/lib/binary'));
  const raw = new BinaryWriter(7);
  raw.writeShort(0x0090); raw.writeULong(shop.GID); raw.writeUChar(1);
  const cryptMask = (c.crypt.keys[0] >>> 16) & 0x7fff;
  log(`🔧 contactNpc 前状态: crypt mask=${cryptMask.toString(16)} 已发包数(估)=${c.packetCounts ? Object.values(c.packetCounts).reduce((a,b)=>a+b,0) : '?'}`);
  log(`🔧 手动 contactNpc: GID=${shop.GID} 原始=${raw.buffer.toString('hex')}`);
  try { c.send(raw.buffer); } catch(e) { log('发送失败: ' + e.message); }
  await sleep(5000);
  log(`5秒后 entities中商人: ${!!c.entities.get(shop.GID)} 状态=${c.state}`);
  const ok = await talk.buy(shop, {
    match: (items) => items.find((it) => (it.discount || it.price) === 5000) || items[items.length - 1],
    amount: 2,
    log,
  });
  log(ok ? '✅ 卷轴到手' : '❌ 购买未确认');
  await sleep(1000);
  // 严格干净退出：关商店窗 → RESTART 回选角 → 关全部 socket
  try { c.send(BUILD.marketClose()); } catch(_) {}
  await sleep(800);
  await c.quitClean();
  process.exit(ok ? 0 : 2);
}, log);
rot.onAllDone = () => { log('全部角色跳过'); process.exit(1); };
login.login();
setTimeout(() => process.exit(3), 180000);
