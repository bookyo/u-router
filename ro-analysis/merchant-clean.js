#!/usr/bin/env node
// 干净的模块化商人测试——精确复刻原版成功路径
const path = require('path');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));
const B = require(path.join(__dirname, 'roclient/lib/protocol')).BUILD;
const { LoginSession, Navigator, NpcTalk, sleep } = require(path.join(__dirname, 'roclient/lib/modules'));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] ${m}`);

const c = new ROClient({ line: 'eden', account: 'xiezixing2', password: process.env.RO_PASS || '' });
const bot = new Bot(c);
const login = new LoginSession(c, { account: 'xiezixing2', password: process.env.RO_PASS || '', line: 'eden' }, log);
const talk = new NpcTalk(c, bot);
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); setTimeout(() => { try { c.mapLoaded(); } catch(_){} }, 1500); });
c.on('char_list', (p) => {
  const ch = p.chars.find(x => x.CharNum === 1);
  if (!ch) return;
  log(`角色: ${ch.name}`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port));
c.on('map_enter', (p) => {
  log(`进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]})`);
  setTimeout(() => { try { c.mapLoaded(); } catch(_){} }, 500);
  setTimeout(() => test().catch(e => { log('异常: ' + e.message); c.quitClean().then(()=>process.exit(1)); }), 3000);
});

async function test() {
  // 原版：先飞到 (166,98) 赏金NPC旁
  log('飞艇 → morocc (166,98)');
  c.airshipTeleport('morocc', 166, 98);
  await sleep(3500);
  // 原版：查视野内全部 NPC 名字
  const npcs = [...c.entities.values()].filter((e) => e.kind === 'npc');
  npcs.filter(n => !n.name).forEach(n => c.reqName(n.GID));
  await sleep(2000);
  // 原版：找道具商人
  const shop = [...c.entities.values()].find((e) => e.kind === 'npc' && /道具商人/.test(e.name || ''));
  if (!shop) { log('未找到道具商人'); return c.quitClean().then(()=>process.exit(1)); }
  log(`🏪 ${shop.name} @(${shop.pos[0]},${shop.pos[1]})`);
  // 原版：走到 shop.pos[0]+2, shop.pos[1]+1（不走 +1,+1！）
  await new Promise((res) => bot.walkSmart(shop.pos[0] + 2, shop.pos[1] + 1, () => res(), 40000));
  log(`已走到 (${bot.pos})`);
  // 原版：注册监听 → 立刻 talkTo
  let bought = false;
  c.on('shop_menu', (p) => {
    log('商店菜单 → 购买');
    setTimeout(() => c.send(B.ackSelectDealtype(p.gid, 0)), 500);
  });
  c.on('shop_items', (p) => {
    const scroll = (p.items || []).find((it) => (it.discount || it.price) === 5000);
    log(`商品 ${p.items.length} 件 → ${scroll ? `卷轴 #${scroll.ITID} 5000z` : '无5000z商品'}`);
    if (scroll) setTimeout(() => c.send(B.marketPurchase([{ ITID: scroll.ITID, amount: 1 }])), 800);
  });
  c.on('purchase_result', (p) => {
    bought = p.rs === 0 || p.items.length > 0;
    log(bought ? '✅ 购买成功' : '❌ 购买失败');
    setTimeout(() => c.send(B.marketClose()), 800);
  });
  bot.talkTo(shop.GID);
  for (let i = 0; i < 16; i++) { await sleep(500); if (bought) break; }
  log(bought ? '🎉 完成' : '❌ 超时');
  await sleep(1000);
  await c.quitClean();
  process.exit(bought ? 0 : 1);
}

c.on('banned', (p) => { log(`被踢 ${p.code}`); setTimeout(()=>process.exit(1), 300); });
login.login();
setTimeout(() => process.exit(3), 120000);
