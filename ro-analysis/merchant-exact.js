#!/usr/bin/env node
// 完全复刻 index.js questScenario 的商人交互——逐行原版，零改动
const path = require('path');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));
const B = require(path.join(__dirname, 'roclient/lib/protocol')).BUILD;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN',{hour12:false})}] ${m}`);

const c = new ROClient({ line: 'eden', account: 'xiezixing2', password: process.env.RO_PASS || '' });
const bot = new Bot(c);
const waitMap = async (m, ms = 15000) => {
  for (let i = 0; i < ms / 500; i++) { await sleep(500); if ((c.mapName || '').includes(m)) return true; }
  return false;
};
const scanNpc = async (re) => {
  const npcs = [...c.entities.values()].filter((e) => e.kind === 'npc');
  const unnamed = npcs.filter((n) => !n.name);
  if (unnamed.length) { unnamed.forEach((n) => c.reqName(n.GID)); await sleep(1500); }
  return [...c.entities.values()].find((e) => e.kind === 'npc' && re.test(e.name || ''));
};

c.on('login_ok', async (p) => { const s = p.ServerList[0]; await c.connectChar(s.ipStr, s.port); });
c.on('login_refuse', (p) => { log(`被拒 code=${p.ErrorCode}`); process.exit(2); });
c.on('char_list', (p) => {
  const ch = p.chars.find(x => x.CharNum === 1) || p.chars[1];
  log(`角色: ${ch.name}`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); setTimeout(() => { try { c.mapLoaded(); } catch(_){} }, 1500); });
c.on('map_enter', (p) => {
  log(`进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]})`);
  setTimeout(() => { try { c.mapLoaded(); } catch(_){} }, 500);
  setTimeout(() => quest().catch(e => { log('异常: ' + e.message); c.quitClean(); process.exit(1); }), 3000);
});

async function quest() {
  // ===== 1. 飞到赏金 NPC 旁（原版第一步）=====
  log('[1/5] 🚌 飞艇 → morocc 赏金NPC旁 (166,98)');
  c.airshipTeleport('morocc', 166, 98);
  if (!(await waitMap('morocc'))) { log('❌ 飞艇失败'); return; }
  await sleep(3500);
  const bounty = await scanNpc(/赏金/);
  log(`   赏金NPC: ${bounty ? bounty.name + ' @(' + bounty.pos[0] + ',' + bounty.pos[1] + ')' : '未找到'}`);

  // ===== 2. 找商店——原版逻辑 =====
  log('[2/5] 🔍 找赏金NPC左边的道具商店...');
  const shops = [...c.entities.values()].filter((e) => e.kind === 'npc' && e.name && !/赏金|卡普/.test(e.name));
  shops.forEach((n) => log(`   见 NPC: ${n.name} @(${n.pos[0]},${n.pos[1]})`));
  let shop = shops.find((n) => /道具商人|道具店|杂货/.test(n.name));
  if (!shop && bounty) {
    shop = shops
      .filter((n) => /商人|商店|贩卖|百货/.test(n.name) && n.pos[0] < bounty.pos[0])
      .sort((a, b) => (Math.abs(a.pos[1] - bounty.pos[1]) + Math.abs(a.pos[0] - bounty.pos[0])) - (Math.abs(b.pos[1] - bounty.pos[1]) + Math.abs(b.pos[0] - bounty.pos[0])))[0];
  }
  shop = shop || shops.find((n) => /商人|商店/.test(n.name));
  if (!shop) { log('❌ 附近没有商店 NPC'); return; }
  log(`   🏪 ${shop.name} @(${shop.pos[0]},${shop.pos[1]}) → 走过去打开购买`);
  await new Promise((res) => bot.walkSmart(shop.pos[0] + 2, shop.pos[1] + 1, () => res(), 40000));

  // ===== 原版购买——完全一样的代码 =====
  let bought = false;
  c.on('shop_menu', async (p) => {
    log('   商店菜单 → 购买');
    setTimeout(() => c.send(B.ackSelectDealtype(p.gid, 0)), 500);
  });
  c.on('shop_items', async (p) => {
    const items = p.items;
    log(`   商品 ${items.length} 件`);
    items.forEach((it, i) => log(`      [${i}] #${it.ITID} 售价 ${(it.discount || it.price)}z`));
    const scroll = items.find((it) => (it.discount || it.price) === 5000) || items[items.length - 1];
    log(`   📜 选定: #${scroll.ITID} ${(scroll.discount || scroll.price)}z → 购买`);
    setTimeout(() => c.send(B.marketPurchase([{ ITID: scroll.ITID, amount: 1 }])), 800);
  });
  c.on('purchase_result', (p) => {
    bought = p.rs === 0 || p.items.length > 0;
    log(bought ? '   ✅ 购买成功' : '   ❌ 购买失败');
    setTimeout(() => c.send(B.marketClose()), 800);
  });
  bot.talkTo(shop.GID);
  for (let i = 0; i < 16; i++) { await sleep(500); if (bought) break; }
  if (!bought) { log('❌ 购买未确认'); }
  else { log('✅ 已购买传送卷轴'); }
  await sleep(2000);
  await c.quitClean();
  process.exit(bought ? 0 : 1);
}

c.on('banned', (p) => { log(`被踢 ${p.code}`); setTimeout(()=>process.exit(1), 300); });
c.login().catch((e) => { log('ERR ' + e.message); process.exit(1); });
setTimeout(() => process.exit(3), 120000);
