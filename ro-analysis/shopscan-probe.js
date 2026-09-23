'use strict';
// 探针：验证「露天商店进视野即广播商品列表/价格（无需点击 0x0130）」
// 流程：登录 → 普隆德拉中心蛇形巡走（纯被动收包）→ 统计 0x0131(店名) 与
//       0x0133/0x0800/0x0B3D(商品列表) 的到达时机 → 最后对最近一家店补发一次
//       0x0130 点击做对照，验证解析器与点击链路。
const path = require('path');
const fs = require('fs');
const iconv = require(path.join(__dirname, 'roclient/node_modules/iconv-lite'));
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));

const OPT = {
  account: process.env.RO_USER || 'xiezixing2',
  password: process.env.RO_PASS || '',
  line: process.env.RO_LINE || 'eden',
  slot: parseInt(process.env.RO_CHAR || '0', 10),
  map: 'prontera',
  cx: parseInt(process.env.RO_TX || '156', 10),
  cy: parseInt(process.env.RO_TY || '191', 10),
  seconds: parseInt(process.env.RO_SECONDS || '280', 10),
};

const c = new ROClient({ line: OPT.line, verbose: !!process.env.RO_VERBOSE });
const bot = new Bot(c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const stats = { storeEntry: 0, listNoClick: 0, listAfterClick: 0, itemsSeen: 0 };
const shops = new Map();      // AID -> { title, x, y }
const vendLists = [];         // 到达时间线
const clicked = new Set();    // 已发过 0x0130 的店
let finished = false;

// ---------- 商店相关封包（client.dispatch 未处理 → 走 'packet' 事件） ----------
c.on('packet', ({ pid, pkt }) => {
  if (pid === 0x0131) { // ZC.STORE_ENTRY（86B 定长：makerAID u32 + 店名 80B GBK）
    stats.storeEntry++;
    const AID = pkt.readUInt32LE(2);
    const title = iconv.decode(pkt.slice(6, 86), 'gbk').replace(/\0[\s\S]*$/, '').trim();
    const e = c.entities.get(AID);
    const s = shops.get(AID) || {};
    shops.set(AID, { ...s, title, x: e ? Math.round(e.pos[0]) : s.x, y: e ? Math.round(e.pos[1]) : s.y });
    log(`  🟨 露天店出现 #${shops.size} 「${title}」 @(${s.x ?? '?'},${s.y ?? '?'})`);
  } else if (pid === 0x0836) {
    const r = parseSSI(pkt);
    ssiResults.push(...r.items);
    log(`  🔎 SSI结果 页(first=${r.first} next=${r.next} 剩余次数=${r.remained}) 条目=${r.items.length} step=${r.step}B 总长=${r.bytes}`);
    r.items.slice(0, 5).forEach((e) => log(`     「${e.title}」 #${e.ITID} ×${e.qty} @${e.price}z AID=${e.AID}`));
    if (r.next) { const w = Buffer.alloc(2); w.writeUInt16LE(0x0838, 0); c.send(w); log('  → 翻页 0x0838'); }
  } else if (pid === 0x0837) {
    const reasons = { 0: '没有成功/空结果', 1: '次数用尽', 2: '太早(冷却)', 3: '关键词太短', 4: '结果太多' };
    log(`  ⚠ SSI失败 0x0837 reason=${pkt.readUInt8(2)} (${reasons[pkt.readUInt8(2)] || '?'})`);
  } else if (pid === 0x083A) {
    log(`  ✅ SSI开放 0x083A openType=${pkt.readInt16LE(2)} 剩余可搜次数=${pkt.readUInt8(4)}`);
  } else if (pid === 0x083D) {
    log(`  📍 SSI点击回坐标: (${pkt.readInt16LE(2)},${pkt.readInt16LE(4)})`);
  } else if (pid === 0x0133 || pid === 0x0800 || pid === 0x0B3D) {
    const v = parseVendList(pid, pkt);
    const after = clicked.has(v.AID);
    if (after) stats.listAfterClick++; else stats.listNoClick++;
    stats.itemsSeen += v.items.length;
    vendLists.push({ t: new Date().toISOString().slice(11, 19), AID: v.AID, n: v.items.length, afterClick: after, pid });
    const sample = v.items.slice(0, 3).map((i) => `#${i.ITID}×${i.qty}@${i.price}z`).join(' ');
    log(`  ${after ? '🟩点击后列表' : '🟩★未点击列表!'} 0x${pid.toString(16)} AID=${v.AID} ${v.items.length}件: ${sample}${v.items.length > 3 ? ' …' : ''}`);
  }
});

function parseVendList(pid, pkt) {
  const AID = pkt.readUInt32LE(2);
  const items = [];
  if (pid === 0x0133) { // 旧版：AID u32 + 22B/项
    for (let o = 6; o + 22 <= pkt.length; o += 22)
      items.push({ price: pkt.readInt32LE(o), qty: pkt.readInt16LE(o + 4), ITID: pkt.readUInt16LE(o + 10) });
  } else { // 0x0800 / 0x0B3D（20211103）：AID u32 + UniqueID u32 + 64B/项
    for (let o = 10; o + 64 <= pkt.length; o += 64)
      items.push({ price: pkt.readInt32LE(o), qty: pkt.readInt16LE(o + 4), ITID: pkt.readUInt32LE(o + 10) });
  }
  return { AID, items };
}

function reqVendList(AID) { // CZ.REQ_BUY_FROMMC
  const w = Buffer.alloc(6);
  w.writeUInt16LE(0x0130, 0);
  w.writeUInt32LE(AID >>> 0, 2);
  c.send(w);
}

// CZ.SEARCH_STORE_INFO (0x0835)：type 0=露天店, 价格区间 0/0 不过滤, 物品ID列表
function searchStoreInfo(itemIds, type = 0) {
  const body = 2 + 1 + 4 + 4 + 1 + 1 + 2 * itemIds.length;
  const w = Buffer.alloc(2 + 2 + body);
  let o = 0;
  w.writeUInt16LE(0x0835, o); o += 2;
  w.writeUInt16LE(2 + body, o); o += 2;   // len
  w.writeUInt8(type, o); o += 1;
  w.writeUInt32LE(0, o); o += 4;          // maxPrice
  w.writeUInt32LE(0, o); o += 4;          // minPrice
  w.writeUInt8(itemIds.length, o); o += 1;
  w.writeUInt8(0, o); o += 1;             // cardCount
  for (const id of itemIds) { w.writeUInt16LE(id, o); o += 2; }
  c.send(w);
}

// CZ.SSILIST_ITEM_CLICK (0x083C)：AID + SSI_ID + ITID → 服务器回 0x083D {x,y}
function ssiClick(AID, SSI_ID, ITID) {
  const w = Buffer.alloc(12);
  w.writeUInt16LE(0x083C, 0);
  w.writeUInt32LE(AID >>> 0, 2);
  w.writeUInt32LE(SSI_ID >>> 0, 6);
  w.writeUInt16LE(ITID, 10);
  c.send(w);
}

// SSI 检索结果缓存（0x0836）
const ssiResults = [];
function parseSSI(pkt) {
  const first = pkt.readUInt8(2), next = pkt.readUInt8(3), remained = pkt.readUInt8(4);
  const rest = pkt.length - 5;
  let step = 0;
  for (const cand of [106, 131, 155]) if (rest % cand === 0 && rest / cand > 0) { step = cand; break; }
  const items = [];
  if (step) {
    for (let o = 5; o + step <= pkt.length; o += step) {
      const e = { SSI_ID: pkt.readUInt32LE(o), AID: pkt.readUInt32LE(o + 4), title: iconv.decode(pkt.slice(o + 8, o + 88), 'gbk').replace(/\0[\s\S]*$/, '').trim() };
      if (step === 106) Object.assign(e, { ITID: pkt.readUInt16LE(o + 88), price: pkt.readInt32LE(o + 91), qty: pkt.readUInt16LE(o + 95) });
      else Object.assign(e, { price: pkt.readInt32LE(o + 88), qty: pkt.readUInt16LE(o + 92), ITID: pkt.readUInt16LE(o + 94) }); // 131B 猜测布局，待实证
      items.push(e);
    }
  }
  return { first, next, remained, step, bytes: pkt.length, items };
}

// ---------- 登录链路（参照 index.js） ----------
let attempts = 0;
function startLogin() {
  attempts++;
  log(`--- 登录尝试 ${attempts}（${OPT.account}@${OPT.line}）---`);
  c.login().catch((e) => { console.error('连接失败:', e.message); process.exit(1); });
}
c.on('login_ok', (p) => {
  const srv = p.ServerList[0];
  if (!srv) { console.error('无角色服务器'); process.exit(1); }
  c.connectChar(srv.ipStr, srv.port).catch((e) => { console.error('连角色服失败', e.message); process.exit(1); });
});
c.on('login_refuse', (p) => {
  console.error(`登录被拒 code=${p.ErrorCode} 来源=${p.from}`);
  if (attempts < 3 && (p.ErrorCode === 8 || p.from === 'zone')) return setTimeout(startLogin, 30000);
  process.exit(1);
});
c.on('banned', (p) => {
  console.error(`被踢 code=${p.code}`);
  if (attempts < 3) return setTimeout(startLogin, 60000);
  process.exit(1);
});
c.on('char_list', (p) => {
  if (!p.chars.length) { console.error('无角色'); process.exit(1); }
  const ch = p.chars.find((x) => x.CharNum === OPT.slot) || p.chars[0];
  log(`角色列表: ${p.chars.map((x) => `slot${x.CharNum}=${x.name}`).join(', ')} → 选 ${ch.name}`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch((e) => { console.error('连地图服失败', e.message); process.exit(1); }));

c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('warp_map', (p) => {
  bot.updateMap(p.mapName);
  bot.updatePos(p.xPos, p.yPos);
  bot.standing = false;
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500);
});
c.on('map_enter', (p) => {
  log(`✅ 进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]})`);
  bot.updatePos(p.pos[0], p.pos[1]);
  bot.updateMap(c.mapName);
  setTimeout(() => c.mapLoaded(), 500);
  setTimeout(() => main().catch((e) => { console.error('main 异常', e); finish(); }), 3500);
});
c.on('input_dialog', (p) => log(`  ⚠ 数字弹窗 NAID=${p.NAID} 题面: ${(p.question || '').slice(0, 50)}`));
c.on('disconnect', () => { if (!finished) { console.error('[断开]'); process.exit(1); } });
c.on('error', (e) => console.error('[error]', e.message));

// ---------- 主流程 ----------
const walkTo = (x, y, t = 60000) => new Promise((res) => bot.walkSmart(x, y, () => res(), t));

async function main() {
  const t0 = Date.now();
  const budget = () => Date.now() - t0 < (OPT.seconds - 40) * 1000;

  if ((c.mapName || '').replace(/\.gat$/i, '') !== OPT.map) {
    log(`🚌 飞艇 → ${OPT.map} (${OPT.cx},${OPT.cy})`);
    c.airshipTeleport(OPT.map, OPT.cx, OPT.cy);
    for (let i = 0; i < 24; i++) { await sleep(500); if ((c.mapName || '').includes(OPT.map)) break; }
    if (!(c.mapName || '').includes(OPT.map)) { log('❌ 飞艇失败'); return finish(); }
    await sleep(3500);
  }

  // 阶段1：出生点先等 8 秒（视野内商店直接到达），再短蛇形巡走（被动观察，绝不发 0x0130）
  log(`\n== 阶段1：出生点静置 8s + 短蛇形（纯被动收包）==`);
  await sleep(8000);
  const lanes = [180, 200];
  let flip = false;
  for (const y of lanes) {
    if (!budget()) break;
    const xs = flip ? [178, 138] : [138, 178];
    flip = !flip;
    for (const x of xs) {
      if (!budget()) break;
      await walkTo(x, y);
      await sleep(2000);
    }
  }
  log(`\n== 阶段1结束：商店 ${shops.size} 家，未点击列表 ${stats.listNoClick} 次，点击后列表 ${stats.listAfterClick} 次 ==`);

  // 阶段2：对照实验 —— 走到最近的 3 家店，各发一次 0x0130
  const withPos = [...shops.entries()].filter(([, s]) => s.x != null);
  withPos.sort((a, b) => dist(a[1]) - dist(b[1]));
  for (const [AID, s] of withPos.slice(0, 3)) {
    log(`\n== 阶段2：点击 「${s.title}」@(${s.x},${s.y})（距 ${dist(s)} 格）==`);
    if (dist(s) > 4) await walkTo(s.x + 2, s.y + 2, 45000);
    await sleep(2500);
    clicked.add(AID);
    log(`→ 发送 0x0130 请求 AID=${AID}`);
    reqVendList(AID);
    await sleep(5000);
  }
  if (!withPos.length) log('\n(视野内没有店铺，跳过对照点击)');

  // 阶段3：SSI 商品检索实测（同一地图全量搜索，无需点击商店）
  log('\n== 阶段3：SSI 检索测试（搜索 501/601/611/985/984）==');
  searchStoreInfo([501, 601, 611, 985, 984]);
  await sleep(6000);
  if (ssiResults.length) {
    const cheap = ssiResults.slice().sort((a, b) => (a.price || Infinity) - (b.price || Infinity))[0];
    if (cheap && cheap.AID) {
      log(`  → 点击最低价结果 「${cheap.title}」#${cheap.ITID}@${cheap.price}z → 请求坐标`);
      ssiClick(cheap.AID, cheap.SSI_ID, cheap.ITID);
      await sleep(4000);
    }
  } else {
    log('  (无结果——服务器可能要求先开启 SSI)');
  }
  finish();
}
const dist = (s) => Math.max(Math.abs(bot.pos[0] - s.x), Math.abs(bot.pos[1] - s.y));

function printSummary() {
  log('\n========== 探针结论 ==========');
  log(`STORE_ENTRY(店名) 到达: ${stats.storeEntry} 次 / ${shops.size} 家`);
  log(`商品列表·未点击到达: ${stats.listNoClick} 次 ★`);
  log(`商品列表·点击后到达: ${stats.listAfterClick} 次`);
  log(`商品条目累计: ${stats.itemsSeen}`);
  log(`SSI 检索结果: ${ssiResults.length} 条`);
  ssiResults.slice(0, 10).forEach((e) => log(`  「${e.title}」 #${e.ITID} ×${e.qty} @${e.price}z`));
  log('店铺明细:');
  shops.forEach((s, AID) => log(`  (${String(s.x).padStart(3)},${String(s.y).padStart(3)}) 「${s.title}」 AID=${AID}`));
  const counts = Object.entries(c.packetCounts || {}).sort((a, b) => b[1] - a[1]).slice(0, 20)
    .map(([k, v]) => `0x${(+k).toString(16).padStart(4, '0')}×${v}`).join(' ');
  log('\n收包统计:', counts);
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'data', 'probe-result.json'), JSON.stringify({
    at: new Date().toISOString(), stats,
    shops: [...shops.entries()].map(([AID, s]) => ({ AID, ...s })),
    vendLists,
  }, null, 2));
  log('已保存 ro-analysis/data/probe-result.json');
}

async function finish() {
  if (finished) return;
  finished = true;
  if (bot._mon) clearInterval(bot._mon);
  printSummary();
  try { await c.quitClean(); } catch (_) {}
  process.exit(0);
}

setTimeout(() => { log('\n[超时] 强制收尾'); finish(); }, OPT.seconds * 1000).unref();
process.on('SIGINT', () => finish());
log(`=== 露天商店广播探针 === 账号=${OPT.account} 线路=${OPT.line}`);
startLogin();
