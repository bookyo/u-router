'use strict';
// 用最新物品名表（中文覆盖）+ 已存词条标签，从 data/all-shops.json 快照重新生成市场报告（不重新爬店）
// 用法：node regen-report.js [输出文件名]（默认 data/market-report.md；也可传「全店商品一览 MMDD 周X.txt」，两处都会写）
const fs = require('fs');
const path = require('path');
const { ItemDB } = require(path.join(__dirname, 'roclient/lib/itemdb'));

(async () => {
  const db = new ItemDB();
  await db.load();
  console.log(`物品名表: ${db.size()} 条`);

  const REGIONS = [
    { map: 'prontera', name: '普隆德拉（首都）' },
    { map: 'geffen', name: '吉芬' },
    { map: 'morocc', name: '梦罗克' },
    { map: 'payon', name: '斐扬' },
  ];
  const snap = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'all-shops.json'), 'utf8'));
  const shops = snap.shops.filter((s) => s.title);
  const listed = shops.filter((s) => s.items && s.items.length);
  // 旧快照的英文词条标签 → 用中文表按 id+value 重算（组合 ID 自含种族/属性语义，无需参数）
  let zhOpts = null;
  try { zhOpts = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'option-names-zh.json'), 'utf8')); } catch (_) {}
  listed.forEach((s) => s.items.forEach((it) => {
    it.name = db.has(it.ITID) ? db.name(it.ITID) : `#${it.ITID}`;
    if (it.options && it.options.length) {
      it.options.forEach((o) => {
        if (zhOpts && zhOpts[String(o.id)] && (!o.label || /^[\x00-\x7f]+$/.test(o.label) || /^选项#/.test(o.label))) {
          const e = zhOpts[String(o.id)];
          o.label = e.fmt.replace(/#+$/, '').replace('%d%%', o.value + '%').replace('%d', String(o.value));
        }
      });
    }
  }));

  const cityName = (s) => s.cityName || s.mapName || '';
  const optsFmt = (it) => (it.options && it.options.length ? it.options.map((o) => o.label).filter(Boolean).join(' ｜ ') : '—');
  const itemEntries = listed.reduce((a, s) => a + s.items.length, 0);
  const itemIds = new Set(); listed.forEach((s) => s.items.forEach((it) => itemIds.add(it.ITID)));

  const minPrice = new Map();
  for (const s of listed) for (const it of s.items) {
    const cur = minPrice.get(it.ITID);
    if (!cur || it.price < cur.price) minPrice.set(it.ITID, { it, shop: s });
  }
  const best = [...minPrice.values()].sort((a, b) => a.it.price - b.it.price);

  const L = [];
  L.push(`# 多城市市场扫描报告`);
  L.push('');
  L.push(`- 重生成时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC（数据快照：${new Date(snap.updatedAt).toISOString().replace('T', ' ').slice(0, 19)} UTC，未重新爬店）`);
  L.push(`- 店铺总数：**${shops.length}** 家（取得商品列表 ${listed.length} 家）`);
  L.push(`- 商品条目：**${itemEntries}** 条，涉及 **${itemIds.size}** 种物品（装备词条为中文）`);
  L.push('');
  L.push(`## 各城市店铺统计`);
  L.push('');
  L.push(`| 城市 | 店铺数 | 已采集 |`);
  L.push(`|---|---:|---:|`);
  for (const region of REGIONS) {
    const cityShops = shops.filter((s) => cityName(s) === region.name);
    L.push(`| ${region.name} | ${cityShops.length} | ${cityShops.filter((s) => s.items && s.items.length).length} |`);
  }
  const unknownCity = shops.filter((s) => !cityName(s));
  if (unknownCity.length) L.push(`| 未标记 | ${unknownCity.length} | ${unknownCity.filter((s) => s.items).length} |`);
  L.push('');

  L.push(`## 全场最低价索引（${best.length} 种物品）`);
  L.push('');
  L.push(`| 物品 | ITID | 最低价 | 数量 | 词条 | 城市 | 店铺 | 坐标 |`);
  L.push(`|---|---|---:|---:|---|---|---|---|`);
  for (const { it, shop } of best) {
    L.push(`| ${it.name || '#' + it.ITID} | ${it.ITID} | ${it.price.toLocaleString()}z | ${it.qty} | ${optsFmt(it)} | ${cityName(shop)} | ${shop.title.slice(0, 24)} | (${shop.x},${shop.y}) |`);
  }
  L.push('');

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

  const unlisted = shops.filter((s) => !s.items || !s.items.length);
  if (unlisted.length) {
    L.push(`---`);
    L.push(`## 未能获取商品列表的店铺（${unlisted.length} 家）`);
    unlisted.forEach((s) => {
      L.push(`- ${cityName(s)} (${s.x ?? '?'},${s.y ?? '?'}) 「${s.title}」 AID=${s.AID}`);
    });
  }

  const md = L.join('\n') + '\n';
  const out = process.argv[2] ? path.join(__dirname, 'data', process.argv[2]) : path.join(__dirname, 'data', 'market-report.md');
  fs.writeFileSync(out, md);
  fs.writeFileSync(path.join(__dirname, 'data', 'market-report.md'), md);   // 两个名字都保持最新
  console.log(`✅ 报告重生成: ${out}（${shops.length} 店 / ${listed.length} 已采 / ${itemEntries} 条 / ${itemIds.size} 种物品）`);
})().catch((e) => { console.error(e); process.exit(1); });
