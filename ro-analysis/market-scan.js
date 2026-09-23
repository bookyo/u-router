#!/usr/bin/env node
'use strict';
// 多城市市场全量扫描：登录 → 逐城市飞艇 → 蛇形巡走 → 点击店铺采商品列表 → 报告
// 城市：普隆德拉(prontera) + 吉芬(geffen) + 梦罗克(morocc) + 斐扬(payon)
// 用法：node market-scan.js [RO_SECONDS=1200]  账号默认 xiezixing2
const path = require('path');
const fs = require('fs');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));
const { BUILD } = require(path.join(__dirname, 'roclient/lib/protocol'));
const { Vending } = require(path.join(__dirname, 'roclient/lib/vending'));
const { ItemDB } = require(path.join(__dirname, 'roclient/lib/itemdb'));

const OPT = {
  account: process.env.RO_USER || 'xiezixing2',
  password: process.env.RO_PASS || '',
  line: process.env.RO_LINE || 'eden',
  slot: parseInt(process.env.RO_CHAR || '1', 10),
  seconds: parseInt(process.env.RO_SECONDS || '1500', 10),
  clickGapMin: 1100,
  clickGapJit: 500,
  radius: 12,
  outDir: path.join(__dirname, 'data'),
};

// ── 扫描区域定义 ──
// 每个城市：落点 + 蛇形网格范围 + 报告用中文地名
const REGIONS = [
  {
    map: 'prontera', name: '普隆德拉（首都）', cx: 156, cy: 117,
    // 2026-09-23 用户反馈中央竖带漏逛：扩为全城网格（西广场 x85-122 / 东横街 x158-197 / 西北区 y260-322 全覆盖）
    grid: { x: [85, 185], y: [60, 310], step: 25 },
  },
  {
    map: 'geffen', name: '吉芬', cx: 120, cy: 68,
    grid: { x: [112, 128], y: [58, 78], step: 10 },   // 小范围
  },
  {
    map: 'morocc', name: '梦罗克', cx: 161, cy: 93,
    grid: { x: [153, 169], y: [83, 103], step: 10 },  // 小范围
  },
  {
    map: 'payon', name: '斐扬', cx: 172, cy: 111,
    grid: { x: [164, 180], y: [101, 121], step: 10 },  // 小范围
  },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);

const c = new ROClient({ line: OPT.line, account: OPT.account, password: OPT.password });
const bot = new Bot(c);
const db = new ItemDB();
const vending = new Vending(c, db);
let finished = false;
const t0 = Date.now();

// ── 登录链路 ──
let attempts = 0;
function startLogin() {
  attempts++;
  log(`登录尝试 ${attempts}（${OPT.account}@${OPT.line}）`);
  c.login().catch((e) => { console.error('连接失败:', e.message); process.exit(1); });
}
c.on('login_ok', (p) => {
  const srv = p.ServerList[0];
  if (!srv) { console.error('无角色服务器'); process.exit(1); }
  c.connectChar(srv.ipStr, srv.port).catch((e) => { console.error('连角色服失败', e.message); process.exit(1); });
});
c.on('login_refuse', (p) => {
  console.error(`登录被拒 code=${p.ErrorCode}`);
  if (attempts < 3 && (p.ErrorCode === 8 || p.ErrorCode === 2)) return setTimeout(startLogin, 30000);
  process.exit(2);
});
c.on('banned', (p) => { console.error(`被踢 code=${p.code}`); finish('banned'); process.exit(2); });
c.on('char_list', (p) => {
  if (!p.chars.length) { console.error('无角色'); process.exit(1); }
  const ch = p.chars.find((x) => x.CharNum === OPT.slot) || p.chars[1] || p.chars[0];
  log(`角色: ${ch.name} Lv${ch.level} → 进图`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch((e) => { console.error('连地图服失败', e.message); process.exit(1); }));
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('warp_map', (p) => {
  bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); bot.standing = false;
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500);
});
c.on('map_enter', (p) => {
  log(`进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]})`);
  bot.updatePos(p.pos[0], p.pos[1]); bot.updateMap(c.mapName);
  setTimeout(() => c.mapLoaded(), 500);
  setTimeout(() => main().catch((e) => { console.error('main 异常', e); finish('error'); }), 3500);
});
c.on('disconnect', () => { if (!finished) { log('⚠ 断线，输出已采集数据'); finish('disconnect'); } });
vending.on('shop_listed', () => {});
vending.on('shop_seen', () => {});

// ── 工具 ──
const walkTo = (x, y, t = 60000) => new Promise((res) => bot.walkSmart(x, y, () => res(), t));
const budget = () => Date.now() - t0 < (OPT.seconds - 30) * 1000;

// 蛇形路点生成
function makeSpots(grid) {
  // 全列蛇形网格（2026-09-23 修复：旧实现每行只走 x 区间两端点，中间区域从未踏足——
  // 用户实测普隆德拉西广场/东横街/西北区全部漏逛）
  const spots = [];
  const [x0, x1] = grid.x, [y0, y1] = grid.y, step = grid.step;
  const cols = [];
  for (let x = x0; x <= x1; x += step) cols.push(x);
  if (cols[cols.length - 1] !== x1) cols.push(x1);
  let flip = 0;
  for (let y = y0; y <= y1; y += step) {
    const row = flip % 2 === 0 ? cols : [...cols].reverse();
    for (const x of row) spots.push([x, y]);
    flip++;
  }
  return spots;
}

// ── 主流程 ──
async function main() {
  await db.load();
  log(`物品名表: ${db.size()} 条`);

  // 停内挂
  for (const id of [34, 36, 57]) { try { c.send(BUILD.notifyUpdateinfo(id, 0)); } catch (_) {} await sleep(300); }
  log('内挂已关闭');

  const master = new Map();   // AID → shop（全城市累积）
  let clickedTotal = 0;
  const regionStats = {};    // map → {shops, listed}

  for (const region of REGIONS) {
    if (!budget()) { log('⏰ 预算不足，跳过后续城市'); break; }
    const mapKey = region.map;

    // 飞艇到城市
    const here = (c.mapName || '').replace(/\.gat$/i, '');
    if (here !== mapKey) {
      log(`\n🚌 飞艇 → ${region.name} ${mapKey} (${region.cx},${region.cy})`);
      c.airshipTeleport(mapKey, region.cx, region.cy);
      let ok = false;
      for (let i = 0; i < 30; i++) { await sleep(500); if ((c.mapName || '').includes(mapKey)) { ok = true; break; } }
      if (!ok) { log(`❌ ${region.name} 飞艇未生效，跳过`); continue; }
      await sleep(4000);
    } else {
      log(`\n📍 已在 ${region.name}`);
    }
    bot.updatePos(c.position[0], c.position[1]);
    log(`${region.name} 采集开始 @(${bot.pos})`);

    // 生成路点
    const spots = makeSpots(region.grid);
    regionStats[mapKey] = { shops: 0, listed: 0 };

    for (let i = 0; i < spots.length && budget(); i++) {
      const [x, y] = spots[i];
      if (bot.pos && (bot.pos[0] !== x || bot.pos[1] !== y)) {
        await walkTo(x, y, 30000);
        await sleep(1800);
      }
      // 点击视野内未采集的店
      const targets = [...vending.shops.values()].filter((s) =>
        s.x != null && s.items == null &&
        Math.max(Math.abs(s.x - bot.pos[0]), Math.abs(s.y - bot.pos[1])) <= OPT.radius);
      for (const s of targets) {
        if (!budget()) break;
        if (vending.requestList(s.AID, { throttleMs: 15000 })) {
          clickedTotal++;
          await sleep(OPT.clickGapMin + Math.random() * OPT.clickGapJit);
        }
      }
      // 收割到累积表 + 记录所属城市
      for (const s of vending.shops.values()) {
        if (!master.has(s.AID)) {
          s.mapName = mapKey;
          s.cityName = region.name;
        }
        master.set(s.AID, s);
      }
      regionStats[mapKey].shops = master.size;
      regionStats[mapKey].listed = [...master.values()].filter((s) => s.items && s.items.length).length;
      log(`  ${region.name} 点${i + 1}/${spots.length} (${bot.pos}) 总店${master.size} 已采${regionStats[mapKey].listed}`);
      saveMaster(master);
    }
  }

  // 最终收割
  for (const s of vending.shops.values()) {
    if (!master.has(s.AID)) { s.mapName = (c.mapName||'').replace('.gat',''); master.set(s.AID, s); }
    else { const m = master.get(s.AID); if (s.items && !m.items) m.items = s.items; }
  }
  await sleep(3000);
  finish('done', master);
}

// ── 累积表落盘 ──
function saveMaster(master) {
  try {
    fs.writeFileSync(path.join(OPT.outDir, 'all-shops.json'), JSON.stringify({
      updatedAt: Date.now(), shops: [...master.values()],
    }, null, 2));
  } catch (_) {}
}

// ── 报告 ──
function finish(reason, master) {
  if (finished) return;
  finished = true;
  if (bot._mon) clearInterval(bot._mon);
  const source = master && master.size ? [...master.values()] : [...vending.shops.values()];
  if (master && master.size) saveMaster(master);

  const shops = source.filter((s) => s.title);
  const listed = shops.filter((s) => s.items && s.items.length);
  const itemEntries = listed.reduce((a, s) => a + s.items.length, 0);
  const itemIds = new Set(); listed.forEach((s) => s.items.forEach((it) => itemIds.add(it.ITID)));

  // 全场最低价
  const minPrice = new Map();
  for (const s of listed) for (const it of s.items) {
    const cur = minPrice.get(it.ITID);
    if (!cur || it.price < cur.price) minPrice.set(it.ITID, { it, shop: s });
  }
  const best = [...minPrice.values()].sort((a, b) => a.it.price - b.it.price);

  const dur = Math.round((Date.now() - t0) / 1000);
  const cityName = (s) => s.cityName || s.mapName || '';
  // 装备词条列（2026-09-23 用户需求：报告必须带词条；label 已由 vending.js 中文表生成）
  const optsFmt = (it) => (it.options && it.options.length ? it.options.map((o) => o.label).filter(Boolean).join(' ｜ ') : '—');

  const L = [];
  L.push(`# 多城市市场扫描报告`);
  L.push('');
  L.push(`- 采集时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC（耗时 ${dur}s，结束原因：${reason}）`);
  L.push(`- 账号/角色：${OPT.account} / ${c.session.charName || '-'}`);
  L.push(`- 扫描城市：${REGIONS.map(r => r.name).join('、')}`);
  L.push(`- 店铺总数：**${shops.length}** 家（取得商品列表 ${listed.length} 家）`);
  L.push(`- 商品条目：**${itemEntries}** 条，涉及 **${itemIds.size}** 种物品`);
  L.push('');

  // 按城市汇总
  L.push(`## 各城市店铺统计`);
  L.push('');
  L.push(`| 城市 | 店铺数 | 已采集 |`);
  L.push(`|---|---:|---:|`);
  for (const region of REGIONS) {
    const cityShops = shops.filter((s) => cityName(s) === region.name);
    const cityListed = cityShops.filter((s) => s.items && s.items.length);
    L.push(`| ${region.name} | ${cityShops.length} | ${cityListed.length} |`);
  }
  const unknownCity = shops.filter((s) => !cityName(s));
  if (unknownCity.length) L.push(`| 未标记 | ${unknownCity.length} | ${unknownCity.filter((s) => s.items).length} |`);
  L.push('');

  // 全场最低价
  L.push(`## 全场最低价索引（${best.length} 种物品）`);
  L.push('');
  L.push(`| 物品 | ITID | 最低价 | 数量 | 词条 | 城市 | 店铺 | 坐标 |`);
  L.push(`|---|---|---:|---:|---|---|---|---|`);
  for (const { it, shop } of best) {
    L.push(`| ${it.name || '#' + it.ITID} | ${it.ITID} | ${it.price.toLocaleString()}z | ${it.qty} | ${optsFmt(it)} | ${cityName(shop)} | ${shop.title.slice(0, 24)} | (${shop.x},${shop.y}) |`);
  }
  L.push('');

  // 按城市分节列店铺明细
  for (const region of REGIONS) {
    const cityListed = listed.filter((s) => cityName(s) === region.name);
    if (!cityListed.length) continue;
    L.push(`---`);
    L.push(`## ${region.name} 店铺明细（${cityListed.length} 家）`);
    cityListed.sort((a, b) => (a.y || 999) - (b.y || 999)).forEach((s, i) => {
      L.push('');
      L.push(`### ${region.name} ${i + 1}. 「${s.title}」`);
      L.push(`- 坐标：**(${s.x},${s.y})** ｜ AID: ${s.AID} ｜ 商品 ${s.items.length} 件`);
      L.push(`- 店主：${s.ownerName || '未知'}`);
      L.push('');
      L.push(`| 物品 | ITID | 数量 | 单价 | 词条 |`);
      L.push(`|---|---|---:|---:|---|`);
      s.items.slice().sort((a, b) => a.price - b.price).forEach((it) => {
        L.push(`| ${it.name || '#' + it.ITID} | ${it.ITID} | ${it.qty} | ${it.price.toLocaleString()}z | ${optsFmt(it)} |`);
      });
    });
    L.push('');
  }

  // 未采集列表
  const unlisted = shops.filter((s) => !s.items || !s.items.length);
  if (unlisted.length) {
    L.push(`---`);
    L.push(`## 未能获取商品列表的店铺（${unlisted.length} 家）`);
    unlisted.forEach((s) => {
      L.push(`- ${cityName(s)} (${s.x ?? '?'},${s.y ?? '?'}) 「${s.title}」 AID=${s.AID}`);
    });
  }

  const md = L.join('\n') + '\n';
  // 2026-09-23 防清库：断线/异常导致 0 店时绝不覆盖报告与 SQLite（曾把 2164 条好数据清成 0）
  if (!shops.length || !listed.length) {
    log(`⚠ 本次无有效采集数据（${reason}）→ 跳过报告与 SQLite 覆盖，保留上次结果`);
    c.quitClean().then(() => process.exit(1)).catch(() => process.exit(1));
    return;
  }
  const mdFile = path.join(OPT.outDir, 'market-report.md');
  fs.writeFileSync(mdFile, md);
  log(`✅ 报告完成: ${mdFile}（${shops.length} 店 / ${listed.length} 已采 / ${itemEntries} 条 / ${itemIds.size} 种物品）`);

  // ── SQLite 词条库（工作台 /search 商品搜索页数据源）。2026-09-22 实证：扫描脚本此前从不写库，
  //    昨天词条是手工导入的、工作台标签收官提示「SQLite 已更新」是空话——接线后 CLI/标签跑完都自动更新 ──
  try {
    const { PoolDB } = require(path.join(__dirname, 'roclient/workbench/db.js'));
    const wdb = new PoolDB(path.join(__dirname, 'roclient/workbench/workbench.db'));
    const rows = listed.flatMap((s) => s.items.map((it) => ({
      ITID: it.ITID, name: it.name || '', price: it.price, qty: it.qty || 1, type: it.type || 0,
      options: it.options || [],
      shopTitle: s.title || '', shopX: s.x, shopY: s.y,
      city: s.cityName || '', mapName: (s.mapName || '').replace('.gat', ''),
      ownerName: s.ownerName || '', ownerAID: s.AID || 0,
    })));
    wdb.marketUpsertAll(rows);
    log(`🗄 SQLite 词条库已更新: ${rows.length} 条（/search 即时可查）`);
  } catch (e) { log(`⚠ SQLite 入库跳过（不影响报告）: ${e.message}`); }

  c.quitClean().then(() => process.exit(0)).catch(() => process.exit(0));
}

setTimeout(() => { log('⏱ 总时限到'); finish('timeout'); }, OPT.seconds * 1000).unref();
process.on('SIGINT', () => { finish('sigint'); });
process.on('uncaughtException', (e) => { console.error('[崩溃]', e.message); finish('crash'); setTimeout(() => process.exit(1), 300); });

log(`=== 多城市市场扫描 === ${OPT.account}@${OPT.line} 城市: ${REGIONS.map(r => r.name).join('、')} 时限${OPT.seconds}s`);
startLogin();
