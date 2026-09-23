'use strict';
// 首都市场全量扫描（浏览器传输版）
// 登录验证只放行真实浏览器 → 用 Playwright+Chromium 打开官方客户端页面，
// 挂 WS 钩子拿已认证连接；封包解析/商品采集复用 lib/vending.js 等模块。
// 用法：node market-scan-browser.js [RO_SECONDS=840] [RO_HEADLESS=0 调试]
module.paths.push('/opt/homebrew/lib/node_modules');
const path = require('path');
const fs = require('fs');
const { chromium } = require('@playwright/test');
const iconv = require(path.join(__dirname, 'roclient/node_modules/iconv-lite'));
const { BinaryReader } = require(path.join(__dirname, 'roclient/lib/binary'));
const { loadGat } = require(path.join(__dirname, 'roclient/lib/gat'));
const { findPath } = require(path.join(__dirname, 'roclient/lib/pathfinding'));
const { Vending } = require(path.join(__dirname, 'roclient/lib/vending'));
const { ItemDB } = require(path.join(__dirname, 'roclient/lib/itemdb'));
const SIZES = require(path.join(__dirname, 'roclient/packet_sizes.json'));

const OPT = {
  account: process.env.RO_USER || 'xiezixing3',
  password: process.env.RO_PASS || '',
  map: 'prontera', cx: 156, cy: 117,
  seconds: parseInt(process.env.RO_SECONDS || '840', 10),
  headless: process.env.RO_HEADLESS !== '0',
  clickGapMin: 1100, clickGapJit: 500, radius: 12,
  outDir: path.join(__dirname, 'data'),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);
const t0 = Date.now();

// ============ 页内钩子源码（与 IAB 验证过的版本一致） ============
const HOOK_SRC = `
(() => {
  if (window.__wsHookedV2) return 'already';
  window.__wsHookedV2 = true;
  const log = []; window.__wsLog = log;
  const K0 = 1205481659, K1 = 453065404, K2 = 592073252;
  function b64(buf) {
    let bytes;
    if (buf instanceof ArrayBuffer) bytes = new Uint8Array(buf);
    else if (buf && ArrayBuffer.isView(buf)) bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    else return '';
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const OrigWS = window.WebSocket;
  function HookedWS(url, protocols) {
    const ws = protocols === undefined ? new OrigWS(url) : new OrigWS(url, protocols);
    const id = log.__n || 0; log.__n = id + 1;
    log.push({ k: 'open', id, url: String(url), t: Date.now() });
    ws.addEventListener('message', (ev) => { try { log.push({ k: 'in', id, t: Date.now(), d: b64(ev.data) }); } catch (e) {} });
    const origSend = ws.send.bind(ws);
    ws.send = function (data) {
      try { log.push({ k: 'out', id, t: Date.now(), d: b64(data) }); } catch (e) {}
      return origSend(data);
    };
    ws.addEventListener('close', () => log.push({ k: 'close', id, t: Date.now() }));
    window.__wsSock = ws;
    return ws;
  }
  HookedWS.prototype = OrigWS.prototype;
  Object.defineProperty(window, 'WebSocket', { value: HookedWS, writable: true, configurable: true });
  HookedWS.CONNECTING = 0; HookedWS.OPEN = 1; HookedWS.CLOSING = 2; HookedWS.CLOSED = 3;
  window.__sendGame = function (bytes) {
    const opens = log.filter(e => e.k === 'open');
    const cur = opens[opens.length - 1];
    if (!cur) throw new Error('无连接');
    const n = log.filter(e => e.k === 'out' && e.id === cur.id).length;
    let k0 = K0;
    for (let i = 0; i <= n; i++) k0 = (Math.imul(k0, K1) + K2) >>> 0;
    const mask = (k0 >>> 16) & 0x7fff;
    const u = new Uint8Array(bytes);
    const v = u[0] | (u[1] << 8);
    const o = (v ^ mask) & 0xffff;
    u[0] = o & 0xff; u[1] = (o >> 8) & 0xff;
    return window.__wsSock.send(u.buffer);
  };
  return 'hooked';
})()`;

const CONFIG_MSG = `window.postMessage({
  application: 'Online', servers: 'data/clientinfo.xml', grfList: null,
  remoteClient: '/ro/client_re/', packetver: 'auto', charBlockSize: 0, clientHash: null,
  development: false, api: false, socketProxy: null, packetKeys: false,
  saveFiles: true, skipServerList: true, skipIntro: true, autoLogin: [],
  version: '69.77', BGMFileExtension: ['mp3'],
  plugins: { IntroMessagePc: {}, LoadingDonate: {} }, ClientVer: 5,
}, '*');`;

// ============ 桥：页面 WS ↔ 本地模块（EventEmitter 模拟 ROClient 接口） ============
const EventEmitter = require('events');
class PageBridge extends EventEmitter {
  constructor(page) {
    super();
    this.page = page;
    this.entities = new Map();
    this.session = { AID: 0, charName: '' };
    this.mapName = null;
    this.pos = [0, 0];
    this._cursor = 0;      // 已消费的日志下标
    this._half = null;     // IN 流半包缓存
    this.zoneId = null;
    this.closed = false;
  }
  send(bytes) {
    return this.page.evaluate(`window.__sendGame(${JSON.stringify(Array.from(bytes))})`);
  }
  sendBuf(buf) { return this.send(Array.from(buf)); }
  chat(msg) {
    const name = this.session.charName || '';
    const b = iconv.encode(`${name} : ${msg}`, 'gbk');
    const w = Buffer.alloc(4 + b.length + 1);
    w.writeUInt16LE(0x00F3, 0);
    w.writeUInt16LE(4 + b.length + 1, 2);
    b.copy(w, 4);
    return this.sendBuf(w);
  }
  // 轮询新日志 → 解析收包流 → 派发事件
  async poll() {
    const entries = await this.page.evaluate(`(window.__wsLog || []).slice(${this._cursor})`);
    if (!entries.length) return;
    this._cursor += entries.length;
    for (const e of entries) {
      if (e.k === 'open' && /:2432\d|:26\d{3}|:28\d{3}/.test(e.url)) {
        const zone = e.url.includes(':24323');
        if (zone) { this.zoneId = e.id; this._half = null; }
      }
      if (e.k === 'close' && e.id === this.zoneId) { this.closed = true; this.emit('disconnect'); }
      if (e.k !== 'in' || e.id !== this.zoneId) continue;
      this._feed(Buffer.from(e.d, 'base64'));
    }
  }
  _feed(chunk) {
    let buf = this._half ? Buffer.concat([this._half, chunk]) : chunk;
    this._half = null;
    let off = 0;
    while (off + 2 <= buf.length) {
      const pid = buf.readUInt16LE(off);
      let size = SIZES[String(pid)];
      if (size === undefined) break;
      if (size < 0) size = buf.readUInt16LE(off + 2);
      if (off + size > buf.length) break;
      this._dispatch(pid, buf.slice(off, off + size));
      off += size;
    }
    if (off < buf.length) this._half = buf.slice(off);
  }
  _dispatch(pid, pkt) {
    try {
      if (pid === 0x0AC5 || pid === 0x0071) { // zone_info（角色服连接上的换服通知）
        const r = new BinaryReader(pkt); r.readUShort();
        const gid = r.readULong(); const mapName = r.readBinaryString(16).replace(/\0.*$/, '');
        this.session.GID = gid; this.mapName = mapName;
        this.emit('zone_info', { GID: gid, mapName });
        return;
      }
      if (pid === 0x09FF) { // NEWENTRY9：实体（含露天店主坐标/名字）
        const e = this._parseEntry9(pkt);
        if (e && e.kind === 'pc') { this.entities.set(e.GID, e); this.emit('entity', e); }
        return;
      }
      if (pid === 0x0087) { // 自身移动确认
        const r = new BinaryReader(pkt); r.readUShort(); r.readULong();
        const p = r.readPos2();
        this.pos = [p[2], p[3]];
        this.emit('self_move', p);
        return;
      }
      if (pid === 0x0091) { // 换图
        const mapName = pkt.slice(2, 18).toString().replace(/\0.*$/, '');
        this.mapName = mapName; this.entities.clear(); this._half = null;
        this.pos = [pkt.readInt16LE(18), pkt.readInt16LE(20)];
        this.emit('warp_map', { mapName, xPos: this.pos[0], yPos: this.pos[1] });
        // 换图后补发 ACTORINIT（官方客户端行为）
        this.sendBuf(Buffer.from([0x7d, 0x00]));
        return;
      }
      if (pid === 0x02EB || pid === 0x0A18) { // 进图
        const r = new BinaryReader(pkt); r.readUShort();
        r.readULong(); const p = r.readPos();
        this.pos = [p[0], p[1]];
        this.emit('map_enter', { pos: p });
        setTimeout(() => this.sendBuf(Buffer.from([0x7d, 0x00])), 400);
        return;
      }
      if (pid === 0x0080) { // 实体消失
        const gid = pkt.readUInt32LE(2);
        this.entities.delete(gid);
        this.emit('vanish', { gid, type: pkt.readUInt8(6) });
        return;
      }
      if (pid === 0x008E) { // 聊天（含房内消息，文本 "名字 : 内容"）
        const msg = iconv.decode(pkt.slice(4), 'gbk').replace(/\0[\s\S]*$/, '');
        this.emit('server_msg', { msg });
        return;
      }
      if (pid === 0x095 || pid === 0x0195) { // 名字查询结果
        const name = pkt.slice(2, 26).toString('latin1'); // ASCII 角色名
        return;
      }
      this.emit('packet', { pid, pkt }); // 0x0131/0x0132/0x0B3D 等交给 Vending
    } catch (e) { /* 单包解析失败忽略 */ }
  }
  _parseEntry9(pkt) {
    try {
      const r = new BinaryReader(pkt);
      r.readUShort(); if (SIZES['2431'] < 0) r.readUShort(); // 变长跳长度域
      const e = {};
      e.objecttype = r.readUChar();
      e.GID = r.readULong(); r.readULong(); // AID
      r.readShort(); r.readShort(); r.readShort(); r.readLong(); // speed/body/health/effect
      r.readShort(); r.readShort(); // job head
      r.readULong(); r.readULong(); // weapon shield
      r.readUShort(); r.readUShort(); r.readUShort(); // acc1-3
      r.readShort(); r.readShort(); r.readShort(); // palette x2 headDir
      r.readShort(); r.readULong(); r.readShort(); // Robe GUID GEmblemVer
      r.readShort(); r.readLong(); r.readUChar(); r.readUChar(); // honor virtue pk sex
      e.pos = r.readPos();
      e.name = iconv.decode(pkt.slice(pkt.length - 27, pkt.length - 3), 'gbk').replace(/\0[\s\S]*$/, '').trim();
      e.kind = ({ 0: 'pc', 1: 'warp', 5: 'mob', 6: 'npc', 7: 'pet' })[e.objecttype] || 'other';
      return e;
    } catch (_) { return null; }
  }
}

// ============ 简易步行（A* + ≤12 格直线段 + 0x0087 确认） ============
async function walkTo(br, gat, tx, ty, timeoutMs = 60000) {
  const mkMove = (x, y) => { // 0x035F + writePos(x,y)
    const w = Buffer.alloc(5);
    w.writeUInt16LE(0x035F, 0);
    w[2] = (x >> 2) & 0xff;
    w[3] = ((x & 3) << 6) | (y >> 4);
    w[4] = ((y & 15) << 4);
    return w;
  };
  const t0w = Date.now();
  for (let round = 0; round < 40; round++) {
    if (br.pos[0] === tx && br.pos[1] === ty) return true;
    if (Date.now() - t0w > timeoutMs) return false;
    let path = findPath(gat, br.pos[0], br.pos[1], tx, ty);
    if (!path || path.length < 2) return br.pos[0] === tx && br.pos[1] === ty;
    // 取 ≤12 格的直线前缀
    let far = 1;
    while (far < path.length - 1 && far < 12) {
      const dx0 = path[1][0] - path[0][0], dy0 = path[1][1] - path[0][1];
      const dx = path[far + 1][0] - path[far][0], dy = path[far + 1][1] - path[far][1];
      if (dx !== dx0 || dy !== dy0) break;
      far++;
    }
    const [nx, ny] = path[Math.min(far, path.length - 1)];
    await br.sendBuf(mkMove(nx, ny));
    // 等待位置推进（最多 6s）
    const before = [...br.pos];
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      if (br.pos[0] !== before[0] || br.pos[1] !== before[1]) break;
    }
  }
  return br.pos[0] === tx && br.pos[1] === ty;
}

// ============ 主流程 ============
(async () => {
  const db = new ItemDB();
  await db.load();
  log(`物品名表: ${db.size()} 条`);

  const browser = await chromium.launch({ headless: OPT.headless });
  const ctx = await browser.newContext({ viewport: { width: 900, height: 760 } });
  const page = await ctx.newPage();
  page.on('crash', () => { log('⚠ 页面崩溃'); process.exit(2); });

  await page.goto('https://post.lastro.cn/ro/api.html?69.77', { waitUntil: 'domcontentloaded' });
  await page.evaluate(HOOK_SRC);
  await page.evaluate(CONFIG_MSG); // 手动注入 ROConfig（父页握手替代）
  log('页面与钩子就绪，等待登录表单…');

  // 等登录表单（skipIntro: true，直达）
  await page.waitForSelector('input, [role=textbox], button', { timeout: 30000 }).catch(() => {});
  await sleep(3000);

  const br = new PageBridge(page);
  const vending = new Vending(br, db);
  const pollTimer = setInterval(() => br.poll().catch(() => {}), 700);

  // ---- 登录（DOM 或坐标兜底） ----
  const fillLogin = async () => {
    const boxes = page.getByRole('textbox');
    const n = await boxes.count().catch(() => 0);
    if (n >= 2) {
      await boxes.nth(0).fill(OPT.account);
      await boxes.nth(1).fill(OPT.password);
      return true;
    }
    return false;
  };
  let ok = await fillLogin();
  if (!ok) { // 表单可能是纯 div，坐标兜底
    const rect = await page.evaluate(`(() => {
      const els = [...document.querySelectorAll('*')].filter(e => /登录/.test((e.textContent||'').trim()) && e.children.length <= 2);
      return null;
    })()`);
    ok = await fillLogin();
  }
  try { await page.getByRole('button', { name: '登录' }).click({ timeout: 3000 }); } catch (_) {
    await page.mouse.click(450, 400); // 兜底坐标
  }
  log('已提交登录，等角色选择…');

  // ---- 角色选择：等「确定」按钮（带诊断） ----
  let picked = null;
  for (let i = 0; i < 30; i++) {
    picked = await page.waitForSelector('text=确定', { timeout: 2000 }).catch(() => null);
    if (picked) break;
    if (i % 5 === 4) {
      const bodyTxt = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
      log(`…等选角(${i + 1}s) 页面文本: ${bodyTxt.replace(/\n/g, '|').slice(0, 120)}`);
    }
  }
  if (!picked) {
    await page.screenshot({ path: path.join(OPT.outDir, 'debug-login.png') }).catch(() => {});
    const bodyTxt = (await page.evaluate(() => document.body.innerText).catch(() => '')) || '';
    throw new Error('角色选择界面未出现，页面文本: ' + bodyTxt.replace(/\n/g, '|').slice(0, 200));
  }
  await sleep(1200);
  await page.locator('text=确定').last().click();
  log('已确认选角（slot0），等进图…');

  // 等 zone 连接 + 进图
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (br.zoneId != null && br.entities.size >= 0 && (br.mapName || '').includes(OPT.map)) break;
    if (br.mapName) break;
  }
  log(`进图: ${br.mapName} @(${br.pos})`);
  await sleep(4000); // 等实体/店名铺开
  br.session.charName = '蝎子星传奇';

  // ---- 停内挂 ----
  const mkInfo = (id, v) => { const w = Buffer.alloc(7); w.writeUInt16LE(0x0AFE, 0); w[2] = id; w.writeInt32LE(v, 3); return w; };
  for (const id of [34, 36, 57]) { await br.sendBuf(mkInfo(id, 0)); await sleep(300); }
  log('内挂已关闭');

  // ---- 不在普隆德拉则飞艇 ----
  if ((br.mapName || '').replace(/\.gat$/i, '') !== OPT.map) {
    const air = Buffer.alloc(34);
    air.writeUInt16LE(0x0A49, 0);
    air.write(OPT.map, 2, 'ascii');
    air.writeUInt32LE(OPT.cx, 18); air.writeUInt32LE(OPT.cy, 22);
    air.writeUInt32LE(1, 26); air.writeUInt32LE(14527, 30);
    log(`🚌 飞艇 → ${OPT.map}`);
    await br.sendBuf(air);
    for (let i = 0; i < 30; i++) { await sleep(500); if ((br.mapName || '').includes(OPT.map)) break; }
    await sleep(4000);
  }
  if (!(br.mapName || '').includes(OPT.map)) throw new Error('未能到达普隆德拉: ' + br.mapName);

  const gat = await loadGat(OPT.map);
  log(`📍 开始市场采集 @(${br.pos})，gat ${gat.width}×${gat.height}`);

  // ---- 蛇形点位 + 点击采集 ----
  const spots = [];
  for (let y = 70; y <= 195; y += 25) {
    const xs = ((y / 25) | 0) % 2 === 0 ? [148, 172] : [172, 148];
    for (const x of xs) spots.push([x, y]);
  }
  const budget = () => Date.now() - t0 < (OPT.seconds - 30) * 1000;
  let clicked = 0;
  const clickNearby = async () => {
    const targets = [...vending.shops.values()].filter((s) =>
      s.x != null && s.items == null &&
      Math.max(Math.abs(s.x - br.pos[0]), Math.abs(s.y - br.pos[1])) <= OPT.radius);
    for (const s of targets) {
      if (!budget()) break;
      if (vending.requestList(s.AID, { throttleMs: 15000 })) {
        clicked++;
        await sleep(OPT.clickGapMin + Math.random() * OPT.clickGapJit);
      }
    }
  };
  for (let i = 0; i < spots.length && budget(); i++) {
    const [x, y] = spots[i];
    if (br.pos[0] !== x || br.pos[1] !== y) {
      await walkTo(br, gat, x, y);
      await sleep(1800);
    }
    await clickNearby();
    const listed = [...vending.shops.values()].filter((s) => s.items).length;
    log(`点位 ${i + 1}/${spots.length} (${br.pos}) 店${vending.shops.size} 已采${listed} 点击${clicked}`);
    vending.save(path.join(OPT.outDir, 'prontera-shops.json'));
  }
  await sleep(4000);
  await finish('done');
  clearInterval(pollTimer);
  try { await browser.close(); } catch (_) {}
  process.exit(0);

  // ============ 报告 ============
  async function finish(reason) {
    if (finish.done) return; finish.done = true;
    try { vending.save(path.join(OPT.outDir, 'prontera-shops.json')); } catch (_) {}
    const shops = [...vending.shops.values()].filter((s) => s.title);
    const listed = shops.filter((s) => s.items && s.items.length);
    const itemEntries = listed.reduce((a, s) => a + s.items.length, 0);
    const itemIds = new Set(); listed.forEach((s) => s.items.forEach((it) => itemIds.add(it.ITID)));
    const minPrice = new Map();
    for (const s of listed) for (const it of s.items) {
      const cur = minPrice.get(it.ITID);
      if (!cur || it.price < cur.price) minPrice.set(it.ITID, { it, shop: s });
    }
    const best = [...minPrice.values()].sort((a, b) => a.it.price - b.it.price);
    const dur = Math.round((Date.now() - t0) / 1000);
    const L = [];
    L.push(`# 普隆德拉（首都）市场扫描报告`);
    L.push('');
    L.push(`- 采集时间：${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC（耗时 ${dur}s，结束原因：${reason}）`);
    L.push(`- 账号：${OPT.account}（浏览器传输通道）`);
    L.push(`- 店铺总数：**${shops.length}** 家（取得商品列表 ${listed.length} 家）`);
    L.push(`- 商品条目：**${itemEntries}** 条，涉及 **${itemIds.size}** 种物品`);
    L.push('');
    L.push(`> 物品名取自官方数据表（CP949）；以 ITID 为准。`);
    L.push('');
    L.push(`## 全场最低价索引（${best.length} 种，价格升序）`);
    L.push('');
    L.push(`| 物品 | ITID | 最低价 | 数量 | 店铺 | 坐标 |`);
    L.push(`|---|---|---:|---:|---|---|`);
    for (const { it, shop } of best) {
      L.push(`| ${it.name || '#' + it.ITID} | ${it.ITID} | ${it.price.toLocaleString()}z | ${it.qty} | ${shop.title.slice(0, 24)} | (${shop.x},${shop.y}) |`);
    }
    L.push('');
    L.push(`## 店铺明细（${listed.length} 家，按 y 排序）`);
    listed.sort((a, b) => (a.y || 999) - (b.y || 999) || (a.x || 999) - (b.x || 999)).forEach((s, i) => {
      L.push('');
      L.push(`### ${i + 1}. 「${s.title}」`);
      L.push(`- 坐标：**(${s.x},${s.y})** ｜ AID: ${s.AID} ｜ 商品 ${s.items.length} 件 ｜ 店主: ${s.ownerName || '-'}`);
      L.push('');
      L.push(`| 物品 | ITID | 数量 | 单价 |`);
      L.push(`|---|---|---:|---:|`);
      s.items.slice().sort((a, b) => a.price - b.price).forEach((it) => {
        L.push(`| ${it.name || '#' + it.ITID} | ${it.ITID} | ${it.qty} | ${it.price.toLocaleString()}z |`);
      });
    });
    const rest = shops.filter((s) => !s.items || !s.items.length);
    if (rest.length) {
      L.push('');
      L.push(`## 未取得列表的店铺（${rest.length} 家）`);
      rest.forEach((s) => L.push(`- (${s.x ?? '?'},${s.y ?? '?'}) 「${s.title}」 AID=${s.AID}`));
    }
    const mdFile = path.join(OPT.outDir, 'prontera-market.md');
    fs.writeFileSync(mdFile, L.join('\n') + '\n');
    log(`✅ 报告: ${mdFile}（${shops.length} 店 / ${listed.length} 已采 / ${itemEntries} 条 / ${itemIds.size} 种）`);
  }
})().catch((e) => {
  console.error('[失败]', e.message);
  process.exit(2);
});
process.on('SIGINT', () => { console.log('\n中断'); process.exit(130); });
