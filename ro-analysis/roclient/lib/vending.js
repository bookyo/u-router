'use strict';
// 露天商店（vending）模块 —— 移植自 OpenKore Vending.pm / vender_items_list 系
// 能力：
//   1. 店铺注册表：0x0131 店名气泡出现 / 0x0132 消失 / 实体位置联动（OpenKore @venderLists）
//   2. 商品列表获取：0x0130 请求 → 0x0133/0x0800/0x0B3D 解析（OpenKore vender_items_list 22B 及新版 64B 布局）
//   3. 关键词检索 + 最低价（OpenKore Misc::vendingShopcheck 比价逻辑）
//   4. SSI 官方商品检索：0x0835 搜全图露天店 / 0x0836 结果 / 0x083C 点击结果 → 0x083D 回店铺坐标
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
// 词条 ID→名称（kRO 标准随机选项表，openkore item_options.txt 生成；V6 自定义 id 兜底显示 #id）
// 2026-09-23：优先中文表（238 条整表汉化，LastROLTSD 词典句式对齐）；无中文表时回退英文原表
let OPT_NAMES = {};
const optTable = (name) => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', name), 'utf8')); } catch (_) { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'data', name), 'utf8')); } catch (_) { return null; } } };
OPT_NAMES = optTable('option-names-zh.json') || optTable('option-names.json') || {};
function optLabel(id, value) {
  const e = OPT_NAMES[id];
  if (!e) return `选项#${id}+${value}`;
  return e.fmt.replace(/#+$/, '').replace('%d%%', value + '%').replace('%d', String(value));
}

const gbk = (b) => iconv.decode(b, 'gbk').replace(/\0[\s\S]*$/, '').trim();

// ---------- 纯解析函数（离线可测） ----------
// 0x0131 ZC.STORE_ENTRY（86B 定长）：makerAID u32 + 店名 80B GBK
function parseStoreEntry(buf) {
  return { AID: buf.readUInt32LE(2), title: gbk(buf.slice(6, 86)) };
}
// 0x0132 ZC.DISAPPEAR_ENTRY（6B）：makerAID u32
function parseDisappear(buf) {
  return { AID: buf.readUInt32LE(2) };
}
// 0x0133（旧版 22B/项）或 0x0800/0x0B3D（20211103 版 64B/项）→ {AID, items:[{price,qty,ITID,type}]}
// 字段序与 OpenKore vender_items_list 一致：price, count, index, type, ITID...
// 布局实证（PC 端抓包 2026-09-12，普隆德拉）：变长包头 = id(2)+len(2)+AID(4)+UniqueID(4)，条目从 12 起
function parseVendList(pid, buf) {
  const AID = buf.readUInt32LE(4);
  const items = [];
  if (pid === 0x0133) { // 头 8B：id+len+AID；22B/项：price4+count2+index2+type1+ITID2+ident1+damaged1+refine1+card8
    for (let o = 8; o + 22 <= buf.length; o += 22) {
      items.push({
        price: buf.readInt32LE(o),       // 售价
        qty: buf.readInt16LE(o + 4),     // 数量
        index: buf.readInt16LE(o + 6),   // 购买用的列表序号
        type: buf.readUInt8(o + 8),
        ITID: buf.readUInt16LE(o + 9),   // 实证偏移（hexdump 校准 2026-09-12）
      });
    }
  } else { // 头 12B：id+len+AID+UniqueID；64B/项（0x0800/0x0B3D 同构）
    for (let o = 12; o + 64 <= buf.length; o += 64) {
      items.push({
        price: buf.readInt32LE(o),
        qty: buf.readInt16LE(o + 4),
        index: buf.readInt16LE(o + 6),
        type: buf.readUInt8(o + 8),
        ITID: buf.readUInt32LE(o + 9),   // hexdump 实证：type 后第 9 字节起 u32
      });
      // 词条区（2026-09-20 实证 @31 起 5×5B：id u16 + value u8 + param u16；装备带、消耗品全零）
      const it = items[items.length - 1];
      it.options = [];
      for (let k = 0; k < 5; k++) {
        const oid = buf.readUInt16LE(o + 31 + k * 5);
        const val = buf.readUInt8(o + 31 + k * 5 + 2);
        if (oid) it.options.push({ id: oid, value: val, label: optLabel(oid, val) });
      }
    }
  }
  return { AID, items };
}
// 0x0836 ZC.SEARCH_STORE_INFO_ACK：头 3B + 每条 106B（SSI_ID/AID/店名80/ITID u16/类型/价格/数量/精炼/4卡）
function parseSSI(buf) {
  const first = buf.readUInt8(2), next = buf.readUInt8(3), remained = buf.readUInt8(4);
  const rest = buf.length - 5;
  let step = 0;
  for (const cand of [106, 131, 155]) if (rest > 0 && rest % cand === 0) { step = cand; break; }
  const results = [];
  if (step === 106) {
    for (let o = 5; o + 106 <= buf.length; o += 106) {
      results.push({
        SSI_ID: buf.readUInt32LE(o),
        AID: buf.readUInt32LE(o + 4),
        title: gbk(buf.slice(o + 8, o + 88)),
        ITID: buf.readUInt16LE(o + 88),
        type: buf.readUInt8(o + 90),
        price: buf.readInt32LE(o + 91),
        qty: buf.readUInt16LE(o + 95),
        refine: buf.readUInt8(o + 97),
      });
    }
  }
  return { first, next, remained, step, bytes: buf.length, results };
}

// ---------- 封包构造（发送方向） ----------
function buildReqVendList(AID) { // CZ.REQ_BUY_FROMMC 0x0130
  const w = Buffer.alloc(6);
  w.writeUInt16LE(0x0130, 0);
  w.writeUInt32LE(AID >>> 0, 2);
  return w;
}
function buildSearchStoreInfo(itemIds, { type = 0, maxPrice = 0, minPrice = 0 } = {}) { // CZ.SEARCH_STORE_INFO 0x0835
  const body = 1 + 4 + 4 + 1 + 1 + 2 * itemIds.length;
  const w = Buffer.alloc(2 + 2 + body);
  let o = 0;
  w.writeUInt16LE(0x0835, o); o += 2;
  w.writeUInt16LE(2 + body, o); o += 2;
  w.writeUInt8(type, o); o += 1;        // 0=露天店(购买) 1=收购店
  w.writeUInt32LE(maxPrice >>> 0, o); o += 4;
  w.writeUInt32LE(minPrice >>> 0, o); o += 4;
  w.writeUInt8(itemIds.length, o); o += 1;
  w.writeUInt8(0, o); o += 1;           // cardCount
  for (const id of itemIds) { w.writeUInt16LE(id, o); o += 2; }
  return w;
}
function buildSsiNextPage() { const w = Buffer.alloc(2); w.writeUInt16LE(0x0838, 0); return w; }
function buildSsiClose() { const w = Buffer.alloc(2); w.writeUInt16LE(0x083B, 0); return w; }
function buildSsiClick(AID, SSI_ID, ITID) { // CZ.SSILIST_ITEM_CLICK 0x083C → 回 0x083D 坐标
  const w = Buffer.alloc(12);
  w.writeUInt16LE(0x083C, 0);
  w.writeUInt32LE(AID >>> 0, 2);
  w.writeUInt32LE(SSI_ID >>> 0, 6);
  w.writeUInt16LE(ITID, 10);
  return w;
}

// ---------- 模块主体 ----------
class Vending extends EventEmitter {
  /**
   * @param client ROClient
   * @param itemDB ItemDB 实例（可为 null，检索退化为 ITID 数字匹配）
   * @param opts {allowSSI} 默认 false —— 2026-09-12 实测本服发送 0x0835 立刻 0x0081 code=4 踢线，勿开
   */
  constructor(client, itemDB, opts = {}) {
    super();
    this.c = client;
    this.db = itemDB || null;
    this.allowSSI = !!opts.allowSSI;
    this.shops = new Map();     // AID -> {AID, title, ownerName, x, y, items[], listedAt, seenAt}
    this._reqAt = new Map();    // AID -> 上次请求商品列表时间（节流）
    this._lastSsi = null;       // 最近一次 SSI 结果
    this._wire();
  }

  _wire() {
    const c = this.c;
    c.on('packet', ({ pid, pkt }) => {
      if (pid === 0x0131) {
        const p = parseStoreEntry(pkt);
        const s = this.shops.get(p.AID) || { AID: p.AID, items: null };
        s.title = p.title; s.seenAt = Date.now();
        const e = c.entities.get(p.AID);
        if (e && e.pos) { s.x = Math.round(e.pos[0]); s.y = Math.round(e.pos[1]); s.ownerName = e.name || s.ownerName; }
        this.shops.set(p.AID, s);
        this.emit('shop_seen', s);
      } else if (pid === 0x0132) {
        const p = parseDisappear(pkt);
        const s = this.shops.get(p.AID);
        this.shops.delete(p.AID);
        if (s) this.emit('shop_gone', s);
      } else if (pid === 0x0133 || pid === 0x0800 || pid === 0x0B3D) {
        const p = parseVendList(pid, pkt);
        const s = this.shops.get(p.AID);
        if (s) {
          s.items = p.items.map((it) => ({ ...it, name: this.db && this.db.has(it.ITID) ? this.db.name(it.ITID) : `#${it.ITID}` }));
          s.listedAt = Date.now();
          this.emit('shop_listed', s);
        }
      } else if (pid === 0x0836) {
        const p = parseSSI(pkt);
        if (p.step !== 106) this.emit('ssi_warn', { bytes: p.bytes, step: p.step });
        this._lastSsi = p;
        this.emit('ssi_result', p);
        if (p.next) this.c.send(buildSsiNextPage());
      } else if (pid === 0x0837) {
        this.emit('ssi_fail', { reason: pkt.readUInt8(2) }); // 0=无结果 1=次数用尽 2=冷却 3=关键词太短 4=结果太多
      } else if (pid === 0x083A) {
        this.emit('ssi_open', { openType: pkt.readInt16LE(2), searchCntMax: pkt.readUInt8(4) });
      } else if (pid === 0x083D) {
        this.emit('ssi_coord', { x: pkt.readInt16LE(2), y: pkt.readInt16LE(4) });
      }
    });
    // 实体更新（玩家/店主位置、名字）——本服 0x09FF 里 GID 字段=账号ID，与 0x0131 makerAID 同源
    c.on('entity', (e) => {
      if (!e || !e.pos || e.kind !== 'pc') return;
      const s = this.shops.get(e.GID);
      if (s) { s.x = Math.round(e.pos[0]); s.y = Math.round(e.pos[1]); s.ownerName = e.name || s.ownerName; }
    });
    // 店主离开视野（0x0080 由 client 转成 vanish；type 2=离开视野）
    c.on('vanish', (p) => {
      const s = this.shops.get(p.gid);
      if (s && p.type === 2) { s.x = null; s.y = null; } // 位置未知化，店记录保留（标题仍有效）
    });
  }

  // 请求某店商品列表（带节流；OpenKore 里对应点击 vender 打开列表）
  requestList(AID, { throttleMs = 10000 } = {}) {
    const s = this.shops.get(AID);
    if (!s) return false;
    const last = this._reqAt.get(AID) || 0;
    if (Date.now() - last < throttleMs) return false;
    this._reqAt.set(AID, Date.now());
    this.c.send(buildReqVendList(AID));
    return true;
  }

  // 请求视野内（距 cx,cy ≤ radius）所有"还没拿到商品列表"的店
  async requestNearby(cx, cy, { radius = 14, gapMs = 400 } = {}) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let n = 0;
    for (const s of this.shops.values()) {
      if (s.x == null || s.y == null) continue;
      if (Math.max(Math.abs(s.x - cx), Math.abs(s.y - cy)) > radius) continue;
      if (s.items && Date.now() - (s.listedAt || 0) < 5 * 60 * 1000) continue;
      if (this.requestList(s.AID)) { n++; await sleep(gapMs); }
    }
    return n;
  }

  // 巡走扫描：逐路点行走+沿途请求附近商店（OpenKore route+vender 扫摊）
  // waypoints: [[x,y],...]；bot: lib/bot.js 实例；onStep(i,total) 进度回调
  async scanWaypoints(waypoints, bot, { onStep, dwellMs = 2000, shouldStop = () => false } = {}) {
    const walkTo = (x, y, t = 60000) => new Promise((res) => bot.walkSmart(x, y, () => res(), t));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let visited = 0;
    for (let i = 0; i < waypoints.length; i++) {
      if (shouldStop()) break;
      const [x, y] = waypoints[i];
      if (bot.pos && (bot.pos[0] !== x || bot.pos[1] !== y)) await walkTo(x, y);
      visited++;
      const [px, py] = bot.pos || [x, y];
      await this.requestNearby(px, py);
      if (dwellMs) await sleep(dwellMs);
      if (onStep) onStep(i + 1, waypoints.length);
    }
    return { visited, shops: this.shops.size };
  }

  // 关键词检索（OpenKore 比价：返回按价格升序的 全地图/已采集 记录）
  // keyword: 物品名片段 或 纯数字 ITID；返回 [{item, price, qty, shop:{title,x,y,AID,ownerName}}]
  search(keyword, { limit = 10, inStock = false } = {}) {
    const kw = String(keyword).trim();
    const numeric = /^\d+$/.test(kw) ? parseInt(kw, 10) : null;
    const nameHit = this.db && !numeric ? new Set(this.db.idsByName(kw)) : null;
    const out = [];
    for (const s of this.shops.values()) {
      if (!s.items) continue;
      for (const it of s.items) {
        if (inStock && !(it.qty > 0)) continue;
        const hit = numeric != null ? it.ITID === numeric
          : nameHit ? nameHit.has(it.ITID) || it.name.includes(kw)
          : it.name.includes(kw);
        if (!hit) continue;
        out.push({ item: it.name, ITID: it.ITID, price: it.price, qty: it.qty,
          shop: { title: s.title, x: s.x, y: s.y, AID: s.AID, ownerName: s.ownerName } });
      }
    }
    out.sort((a, b) => a.price - b.price);
    return out.slice(0, limit);
  }

  // 最低价一条（1v2 应答回复用）
  cheapest(keyword) { return this.search(keyword, { limit: 1 })[0] || null; }

  // SSI：全图商品检索 —— ⚠ 本服实测发送 0x0835 立即被踢（0x0081 code=4），默认禁用
  ssiSearch(itemIds, opts) {
    if (!this.allowSSI) { this.emit('ssi_warn', { reason: 'disabled', note: '0x0835 在本服触发反挂踢线，构造时传 {allowSSI:true} 显式开启' }); return false; }
    this.c.send(buildSearchStoreInfo(itemIds, opts));
    return true;
  }
  ssiClick(AID, SSI_ID, ITID) { this.c.send(buildSsiClick(AID, SSI_ID, ITID)); }
  ssiClose() { this.c.send(buildSsiClose()); }
  lastSsi() { return this._lastSsi; }

  // 持久化（跨会话的商品记录）
  snapshot() {
    return { updatedAt: Date.now(), shops: [...this.shops.values()].map((s) => ({
      AID: s.AID, title: s.title, ownerName: s.ownerName || null, x: s.x, y: s.y,
      listedAt: s.listedAt || null,
      items: s.items ? s.items.map(({ name, ITID, price, qty }) => ({ name, ITID, price, qty })) : null,
    })) };
  }
  restore(data) {
    if (!data || !Array.isArray(data.shops)) return;
    for (const s of data.shops) this.shops.set(s.AID, { seenAt: 0, ...s });
  }
  save(file) { require('fs').writeFileSync(file, JSON.stringify(this.snapshot(), null, 2)); }
  load(file) { try { this.restore(JSON.parse(require('fs').readFileSync(file, 'utf8'))); } catch (_) {} return this; }
}

module.exports = { Vending, parseStoreEntry, parseDisappear, parseVendList, parseSSI, buildReqVendList, buildSearchStoreInfo, buildSsiClick };
