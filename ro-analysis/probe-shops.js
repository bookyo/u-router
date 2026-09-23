'use strict';
// 采集商店价格探针：珠宝商人(moc_ruins 109,105) + 玩偶商人(prontera 247,153)
// 打开商店列表记录宝石/娃娃价格 → data/collect-shops.json → 优雅下线
// 用法：RO_USER=xxx RO_PASS=yyy node probe-shops.js
const path = require('path');
const fs = require('fs');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));
const { BUILD } = require(path.join(__dirname, 'roclient/lib/protocol'));

const OPT = {
  account: process.env.RO_USER || 'xiezixing3',
  password: process.env.RO_PASS || '',
  line: process.env.RO_LINE || 'eden',
  out: path.join(__dirname, 'data', 'collect-shops.json'),
};
// 关心的物品（ITID → 名称），两个商店各自记录
const CARE = {
  gem: { 723: '红宝石', 726: '蓝宝石', 728: '黄宝石', 729: '青绿宝石', 719: '紫宝石', 720: '天蓝宝石', 721: '绿宝石', 722: '珍珠', 730: '1克拉钻石' },
  doll: { 740: '疯兔娃娃', 741: '波利娃娃', 742: '苍蝇娃娃' },
  scroll: { 713: '空瓶', 14527: '传送卷轴' },   // 道具商人（买卷轴那家）
};
const SHOPS = [
  { key: 'gem', map: 'moc_ruins', x: 109, y: 105, npc: /珠宝/ },
  { key: 'doll', map: 'prontera', x: 247, y: 153, npc: /玩偶|娃娃/ },
  { key: 'scroll', map: 'morocc', x: 146, y: 103, npc: /道具商人/ },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (m) => console.log(`[${ts()}] ${m}`);

const c = new ROClient({ line: OPT.line, account: OPT.account, password: OPT.password });
c.on('sp_update', (p) => { if (p.type === 24) log(`💰 SP24=${p.val}`); });
c.on('packet', (p) => {
  if (p.pid === 0x00B1) log(`🧪 0x00B1 type=0x${p.pkt.readUInt16LE(2).toString(16)} val=${p.pkt.readInt32LE(4)}`);
});
const bot = new Bot(c);
const prices = { gem: {}, doll: {}, scroll: {}, updatedAt: '' };

const waitMap = async (m, ms = 15000) => {
  for (let i = 0; i < ms / 500; i++) { await sleep(500); if ((c.mapName || '').includes(m)) return true; }
  return false;
};
async function walkTo(x, y, t = 40000) {
  log(`巡路 → (${x},${y})`);
  await new Promise((res) => bot.walkSmart(x, y, () => res(), t));
  await sleep(300);
}
async function scanNpc(re, rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    const hit = [...c.entities.values()].find((e) => e.kind === 'npc' && re.test(e.name || ''));
    if (hit) return hit;
    const unnamed = [...c.entities.values()].filter((n) => n.kind === 'npc' && !n.name);
    if (unnamed.length) unnamed.forEach((n) => c.reqName(n.GID));
    await sleep(1000);
  }
  return [...c.entities.values()].find((e) => e.kind === 'npc' && re.test(e.name || ''));
}

// 打开商店抓价格
function openShop(npc) {
  return new Promise(async (resolve) => {
    let done = false;
    const finish = (ok) => { if (done) return; done = true; cleanup(); setTimeout(() => resolve(ok), 600); };
    const onMenu = (p) => {
      log(`   📋 菜单: ${(p.options || []).join(' | ').slice(0, 100)}`);
      if (/(商店|购买|道具)/.test((p.options || []).join())) setTimeout(() => { try { c.send(BUILD.ackSelectDealtype(p.gid, 0)); } catch (_) {} }, 400);
      else setTimeout(() => { try { c.closeDialog(p.gid); } catch (_) {} finish(false); }, 300);
    };
    const onItems = (p) => {
      const want = {};
      for (const it of p.items || []) {
        if (CARE.gem[it.ITID]) { want[it.ITID] = it.discount || it.price; prices.gem[it.ITID] = it.discount || it.price; }
        if (CARE.doll[it.ITID]) { want[it.ITID] = it.discount || it.price; prices.doll[it.ITID] = it.discount || it.price; }
        if (CARE.scroll[it.ITID]) { want[it.ITID] = it.discount || it.price; prices.scroll[it.ITID] = it.discount || it.price; }
      }
      const found = Object.entries(want).map(([id, p2]) => `${CARE.gem[id] || CARE.doll[id] || CARE.scroll[id]}#${id}=${p2}z`);
      log(`   商品${(p.items || []).length}件，命中: ${found.length ? found.join(' ') : '无（检查ITID！）'}${(p.items || []).length <= 3 ? ' 商品列表:' + (p.items || []).map((i) => `#${i.ITID}/${i.price}`).join(' ') : ''}`);
      if (SHOPS[currentShopIdx] && SHOPS[currentShopIdx].key === 'scroll') {   // 道具商人：zeny 判定实验（空瓶 400z）
        log('   🧪 实验购买 空瓶×1（400z）');
        setTimeout(() => { try { c.send(BUILD.marketPurchase([{ ITID: 713, amount: 1 }])); } catch (_) {} }, 600);
        setTimeout(() => { try { c.send(BUILD.marketClose()); } catch (_) {} finish(true); }, 2400);
      } else {
        setTimeout(() => { try { c.send(BUILD.marketClose()); } catch (_) {} finish(true); }, 500);
      }
    };
    const cleanup = () => {
      c.removeListener('dialog_menu', onMenu); c.removeListener('shop_items', onItems);
      c.removeListener('shop_menu', onShopMenu); c.removeListener('packet', onPkt);
    };
    // 直弹型商人：CONTACTNPC 直接回 0x00C4 商店选择（不经对话菜单）
    const onShopMenu = (p) => {
      log('   🏪 直弹商店菜单 0x00C4 → 选购买');
      setTimeout(() => { try { c.send(BUILD.ackSelectDealtype(p.gid, 0)); } catch (_) {} }, 400);
    };
    const onPkt = (p) => { if (p.pid !== 0x007F) log(`   [包] 0x${p.pid.toString(16)} ${p.pkt.length}B`); };
    c.on('dialog_menu', onMenu); c.on('shop_items', onItems);
    c.on('shop_menu', onShopMenu); c.on('packet', onPkt);
    bot.talkTo(npc.GID);
    setTimeout(() => finish(false), 20000);
  });
}

let currentShopIdx = -1;
async function probeShop(s) {
  currentShopIdx = SHOPS.indexOf(s);
  log(`── ${s.key}: ${s.map} (${s.x},${s.y})`);
  let ok = false;
  for (let attempt = 0; attempt < 2 && !ok; attempt++) {
    c.airshipTeleport(s.map, s.x, s.y);
    ok = await waitMap(s.map, 15000);
    if (!ok) { log(`到 ${s.map} 失败（第${attempt + 1}次），重试`); await sleep(2000); }
  }
  if (!ok) return;
  await sleep(2500);
  bot.updatePos(c.position[0], c.position[1]);
  // 离线战斗残留状态解除（真值组合拳）：关自动攻击 → 以自己 GID 站起 → 自位移重同步
  try { c.send(BUILD.notifyUpdateinfo(34, 0)); } catch (_) {}
  try { c.send(BUILD.requestAct(c.session.GID, 3)); } catch (_) {}
  await sleep(600);
  try { c.send(BUILD.requestMove(c.position[0], c.position[1])); } catch (_) {}
  await sleep(600);
  // 飞艇已落在商人坐标附近，地图数据缺失也无所谓——补 ACTORINIT 让实体同步即可
  try { c.mapLoaded(); } catch (_) {}
  await sleep(1500);
  let npc = await scanNpc(s.npc, 5);
  if (!npc) npc = [...c.entities.values()].filter((e) => e.kind === 'npc' && e.pos &&
    Math.abs(e.pos[0] - s.x) <= 7 && Math.abs(e.pos[1] - s.y) <= 7)[0];
  if (!npc) { log(`未找到商人（实体${c.entities.size}，坐标需核对?）`); return; }
  if (!npc.name) { c.reqName(npc.GID); await sleep(1200); }
  log(`商人: ${npc.name || '#' + npc.GID} @(${npc.pos[0]},${npc.pos[1]})`);
  // 接触落定：找商人 8 邻格里最近的可走格（+(2,+1) 对这两个商人不可走，实测贴墙）
  let spot = null;
  for (let r = 1; r <= 2 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
      if (!dx && !dy) continue;
      const nx = npc.pos[0] + dx, ny = npc.pos[1] + dy;
      if (bot.gat && bot.gat.walkable(nx, ny)) spot = [nx, ny];
    }
  }
  if (!spot) { log('商人周围无可走格'); return; }
  log(`接触格 (${spot[0]},${spot[1]})`);
  if (bot.pos[0] !== spot[0] || bot.pos[1] !== spot[1]) {
    if (bot.pos[0] === spot[0] && bot.pos[1] === spot[1] + 1) await walkTo(spot[0], spot[1] - 2, 12000);
    await walkTo(spot[0], spot[1], 30000);
  } else {
    await walkTo(spot[0] + (spot[0] < npc.pos[0] ? -2 : 2), spot[1], 12000);   // 已在接触格：走开再回来
    await walkTo(spot[0], spot[1], 20000);
  }
  await sleep(500);
  await openShop(npc);
}

c.on('login_ok', (p) => c.connectChar(p.ServerList[0].ipStr, p.ServerList[0].port).catch((e) => { log('连角色服失败 ' + e.message); process.exit(1); }));
c.on('login_refuse', (p) => { log('登录被拒 code=' + p.ErrorCode); process.exit(1); });
c.on('char_list', (p) => {
  const ch = (p.chars || [])[0];
  if (!ch) { log('无角色'); process.exit(1); }
  log(`进入 ${ch.name} Lv${ch.level}`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));   // 位置推进（漏了这根线 bot 会无限误判卡住）
c.on('warp_map', (p) => {
  bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos);
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500);
});
c.on('map_enter', async () => {
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  await sleep(3000);
  bot.updatePos(c.position[0], c.position[1]);
  for (const s of SHOPS) await probeShop(s);
  prices.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OPT.out), { recursive: true });
  fs.writeFileSync(OPT.out, JSON.stringify(prices, null, 2));
  log(`💾 价格表已存 ${OPT.out}`);
  c.quitClean().then(() => process.exit(0));
});
setTimeout(() => { log('超时退出'); c.quitClean().then(() => process.exit(0)); }, 150000);
log('探针启动');
c.login().catch((e) => { log('连接失败: ' + e.message); process.exit(1); });
