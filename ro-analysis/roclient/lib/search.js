'use strict';
/**
 * 物品/怪物/商店搜索引擎（V6 客户端本地数据查询）
 * ============================================================
 * 数据源（从 V6 CDN 下载的 JS 数据表，与网页端一致）：
 *   - DB/NpcShopTable.js : 商店→商品映射（搜哪个商店卖什么）
 *   - DB/Mobs/mob_db.js  : 怪物→掉落映射（搜哪个怪掉什么）
 *   - DB/worldData.js    : 地图→怪物分布（怪物在哪个地图）
 *
 * 网络交互（仅飞艇传送，无搜索封包）：
 *   OUT 0x0A49 AIRSHIP_REQUEST — 前往目标地图（已有）
 *   IN  0x0AE5 导航信息（起终点地图 + 路线名）
 *   IN  0x0AD6 导航路线段（264 段 × 11B）
 *
 * 用法：
 *   const search = new ItemSearch();
 *   await search.load();
 *   search.findItemByName('传送卷轴');     // → 哪个商店卖
 *   search.findDropsByItem(501);          // → 哪个怪掉红药
 *   search.findMobsOnMap('prt_fild08');   // → 这个图有什么怪
 *   search.findMapsByMob(1014);          // → 魔菇在哪些图
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const CDN = 'https://post.lastro.cn/ro/src/';
const CACHE = path.join(__dirname, '..', 'data');

function download(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', Origin: 'https://post.lastro.cn' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function parseJsObject(content) {
  // V6 数据表是 define(function(){ return {...}; }); 格式
  // 用 Function 构造器执行 JS 模块（最可靠的解析方式）
  let define_result = null;
  const fakeDefine = (factory) => {
    // factory 是 function(){ return {...}; }
    define_result = factory();
  };
  const fn = new Function('define', content);
  fn(fakeDefine);
  if (define_result) return define_result;
  // 备用：直接提取 return 后的对象字面量
  const m = content.match(/return\s+(\{[\s\S]+?\});?\s*$/);
  if (m) {
    return new Function('return ' + m[1])();
  }
  throw new Error('无法解析数据表格式');
}

class ItemSearch {
  constructor() {
    this.shops = null;    // NpcShopTable
    this.mobs = null;     // mob_db
    this.world = null;    // worldData
    this.items = null;    // ItemDB（如有）
    this.loaded = false;
  }

  async load() {
    if (this.loaded) return;
    fs.mkdirSync(CACHE, { recursive: true });
    const files = [
      { key: 'shops', file: 'DB/NpcShopTable.js', url: CDN + 'DB/NpcShopTable.js' },
      { key: 'mobs', file: 'DB/Mobs/mob_db.js', url: CDN + 'DB/Mobs/mob_db.js' },
      { key: 'world', file: 'DB/worldData.js', url: CDN + 'DB/worldData.js' },
    ];
    for (const { key, file, url } of files) {
      const cachePath = path.join(CACHE, path.basename(file));
      let content;
      if (fs.existsSync(cachePath)) {
        content = fs.readFileSync(cachePath, 'utf8');
      } else {
        content = (await download(url)).toString('utf8');
        fs.writeFileSync(cachePath, content);
      }
      try {
        this[key] = parseJsObject(content);
      } catch (e) {
        console.warn(`[ItemSearch] 解析 ${file} 失败: ${e.message}`);
      }
    }
    // 尝试加载物品名映射表
    const namePath = path.join(CACHE, 'itemnames-zh.json');
    if (fs.existsSync(namePath)) {
      try { this.itemNames = JSON.parse(fs.readFileSync(namePath, 'utf8')); } catch (_) {}
    }
    this.loaded = true;
    console.log(`[ItemSearch] 加载完成: 商店${Object.keys(this.shops || {}).length} 怪物${Object.keys(this.mobs || {}).length} 地图${Object.keys(this.world || {}).length} 物品名${Object.keys(this.itemNames || {}).length}`);
  }

  // ---------- 商店搜索 ----------

  /** 按物品 ITID 搜商店 → [{map, npcName, location, price}] */
  findItemById(itid) {
    if (!this.shops) return [];
    const hits = [];
    for (const [mapName, npcList] of Object.entries(this.shops)) {
      if (!Array.isArray(npcList)) continue;
      for (const npc of npcList) {
        if (!npc.items || !(String(itid) in npc.items)) continue;
        hits.push({ map: mapName, npcName: npc.name, location: npc.location, price: npc.items[String(itid)] });
      }
    }
    return hits;
  }

  /** 按物品名搜商店（需要 itemNames 映射表） */
  findItemByName(name) {
    if (!this.shops || !this.itemNames) return [];
    const itids = Object.entries(this.itemNames)
      .filter(([id, n]) => n.includes(name))
      .map(([id]) => parseInt(id, 10));
    const hits = [];
    for (const itid of itids) hits.push(...this.findItemById(itid));
    return hits;
  }

  // ---------- 怪物掉落搜索 ----------

  /** 按物品 ID 搜掉落怪物 → [{mobId, mobName, dropRate, maps}] */
  findDropsByItem(itid) {
    if (!this.mobs) return [];
    const hits = [];
    for (const [mobId, mob] of Object.entries(this.mobs)) {
      for (let i = 0; i < 8; i++) {
        const dropId = mob[`Drop${i}id`];
        if (dropId === itid) {
          const rate = mob[`Drop${i}per`] || 0;
          const maps = this.findMapsByMob(parseInt(mobId, 10));
          hits.push({ mobId: parseInt(mobId, 10), mobName: mob.kName, dropRate: rate / 100, dropSlot: i, maps });
          break;
        }
      }
    }
    return hits.sort((a, b) => b.dropRate - a.dropRate);
  }

  /** 按物品名搜掉落怪物 */
  findDropsByName(itemName) {
    if (!this.mobs) return [];
    // mob_db 的掉落只有 ID，需要 ItemDB 做名字映射
    // 暂时通过 worldData 的 ItemInfo 或外部映射
    const hits = [];
    for (const [mobId, mob] of Object.entries(this.mobs)) {
      // mob_db 中 kName 是怪物名，掉落物品名不在此表中
      // 需要配合 ItemDB 使用
      hits.push({ mobId, mobName: mob.kName });
    }
    return hits;
  }

  // ---------- 地图信息 ----------

  /** 某地图的怪物分布 → [{mobId, mobName}] */
  findMobsOnMap(mapName) {
    if (!this.world || !this.mobs) return [];
    const map = this.world[mapName.replace(/\.gat$/i, '')];
    if (!map || !map.mobs) return [];
    return map.mobs
      .filter((id) => id > 0 && this.mobs[String(id)])
      .map((id) => ({ mobId: id, mobName: this.mobs[String(id)].kName, level: this.mobs[String(id)].LV }));
  }

  /** 某怪物出现在哪些地图 → [mapName] */
  findMapsByMob(mobId) {
    if (!this.world) return [];
    const maps = [];
    for (const [name, data] of Object.entries(this.world)) {
      if (data.mobs && data.mobs.includes(mobId)) maps.push(name);
    }
    return maps;
  }

  /** 地图中文名 */
  getMapName(mapName) {
    if (!this.world) return mapName;
    const map = this.world[mapName.replace(/\.gat$/i, '')];
    return (map && map.name) || mapName;
  }

  /** 搜索地图（按中文名模糊匹配） */
  searchMaps(keyword) {
    if (!this.world) return [];
    const hits = [];
    for (const [name, data] of Object.entries(this.world)) {
      if ((data.name || '').includes(keyword) || name.includes(keyword.toLowerCase())) {
        hits.push({ map: name, name: data.name, mobs: (data.mobs || []).length });
      }
    }
    return hits;
  }

  // ---------- 综合搜索 ----------

  /** 搜索物品：同时返回卖它的商店 + 掉它的怪物 */
  async searchItem(nameOrId) {
    const isId = typeof nameOrId === 'number' || /^\d+$/.test(nameOrId);
    const itid = isId ? parseInt(nameOrId, 10) : null;
    const name = isId ? null : nameOrId;
    const result = { query: nameOrId, shops: [], drops: [] };
    if (itid != null) {
      result.shops = this.findItemById(itid);
      result.drops = this.findDropsByItem(itid);
    }
    if (name) {
      result.shops = this.findItemByName(name);
      // 按名字搜掉落需要 ItemDB——暂时跳过
    }
    return result;
  }
}

module.exports = { ItemSearch };
