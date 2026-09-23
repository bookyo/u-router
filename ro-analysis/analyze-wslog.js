'use strict';
// 浏览器 WebSocket 封包日志分析器
// 输入: ro-analysis/data/wslog-browser.json（window.__wsLog 导出）
// 输出: 按 socket 重组的封包流水 + 商店封包专项分析
const fs = require('fs');
const path = require('path');
const iconv = require(path.join(__dirname, 'roclient/node_modules/iconv-lite'));
const SIZES = require(path.join(__dirname, 'roclient/packet_sizes.json'));
const { PacketCrypt } = require(path.join(__dirname, 'roclient/lib/crypt'));

const log = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/wslog-browser.json'), 'utf8'));
const sizeOf = (pid) => SIZES[String(pid)];
const gbk = (b) => iconv.decode(b, 'gbk').replace(/\0[\s\S]*$/, '').trim();

// ---- 按套接字分组 ----
const socks = new Map();
for (const e of log) {
  if (!socks.has(e.id)) socks.set(e.id, { id: e.id, url: '', frames: [] });
  const s = socks.get(e.id);
  if (e.k === 'open') s.url = e.url;
  s.frames.push(e);
}

// ---- 解析一条接收方向的字节流（复用 client.js onData 逻辑，含 4 字节回声处理） ----
function parseStream(buf, label) {
  const pkts = [];
  let off = 0, skippedEcho = 0;
  while (off + 2 <= buf.length) {
    let pid = buf.readUInt16LE(off);
    let size = sizeOf(pid);
    if (size === undefined || size === 0) {
      if (off === 0 && skippedEcho < 2 && buf.length >= 4) { buf = buf.slice(4); skippedEcho++; continue; }
      pkts.push({ err: `未知 0x${pid.toString(16)} @${off}` });
      return pkts;
    }
    if (size < 0) {
      if (off + 4 > buf.length) break;
      size = buf.readUInt16LE(off + 2);
    }
    if (off + size > buf.length) break;
    pkts.push({ pid, buf: buf.slice(off, off + size) });
    off += size;
  }
  if (off < buf.length) pkts.push({ err: `尾包残留 ${buf.length - off}B` });
  return pkts;
}

// ---- 地图服发送方向解密（流式掩码，顺序推进） ----
function decodeZoneOut(frames) {
  const crypt = new PacketCrypt();
  crypt.setKeys('B');
  crypt.init();
  return frames.map((f) => {
    const b = Buffer.from(f.d, 'base64');
    const pid0 = b.readUInt16LE(0);
    const copy = Buffer.from(b);
    crypt.process(copy);
    const pid = copy.readUInt16LE(0);
    return { t: f.t, raw: pid0, decoded: pid, buf: copy };
  });
}

// ============ 主分析 ============
let shopEntries = []; // 0x0131
let vendLists = [];   // 0x0133/0x0800/0x0B3D
let outVendClicks = [];

for (const s of socks.values()) {
  const inFrames = s.frames.filter((f) => f.k === 'in');
  const outFrames = s.frames.filter((f) => f.k === 'out');
  const tag = s.url.replace('wss://port.lastro.cn/', '');
  console.log(`\n===== socket#${s.id} ${tag} — in:${inFrames.length} out:${outFrames.length} =====`);

  // 接收方向流水
  const inBuf = Buffer.concat(inFrames.map((f) => Buffer.from(f.d, 'base64')));
  const pkts = parseStream(inBuf, tag);
  const hist = {};
  for (const p of pkts) {
    const key = p.err ? 'ERR:' + p.err.slice(0, 20) : '0x' + p.pid.toString(16).padStart(4, '0');
    hist[key] = (hist[key] || 0) + 1;
    if (p.pid === 0x0131) {
      const AID = p.buf.readUInt32LE(2);
      shopEntries.push({ t: null, sock: s.id, AID, title: gbk(p.buf.slice(6, 86)) });
    } else if (p.pid === 0x0133 || p.pid === 0x0800 || p.pid === 0x0B3D) {
      const AID = p.buf.readUInt32LE(2);
      const items = [];
      const step = p.pid === 0x0133 ? 22 : 64;
      const start = p.pid === 0x0133 ? 6 : 10;
      for (let o = start; o + step <= p.buf.length; o += step)
        items.push({
          price: p.buf.readInt32LE(o),
          qty: p.buf.readInt16LE(o + 4),
          ITID: p.pid === 0x0133 ? p.buf.readUInt16LE(o + 10) : p.buf.readUInt32LE(o + 10),
        });
      vendLists.push({ pid: p.pid, sock: s.id, AID, n: items.length, items });
    }
  }
  console.log('  收包直方图:', Object.entries(hist).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' '));

  // 发送方向
  if (tag.includes(':26569') || tag.includes(':24322')) {
    for (const f of outFrames) {
      const b = Buffer.from(f.d, 'base64');
      console.log(`  [OUT@${new Date(f.t).toISOString().slice(11, 19)}] ${b.length}B ${b.toString('hex')}`);
    }
  } else {
    const dec = decodeZoneOut(outFrames);
    for (const d of dec) {
      const hex = d.buf.toString('hex');
      console.log(`  [OUT@${new Date(d.t).toISOString().slice(11, 19)}] raw=0x${d.raw.toString(16)} → 0x${d.decoded.toString(16).padStart(4, '0')} ${d.buf.length}B ${hex.slice(0, 60)}`);
      if (d.decoded === 0x0130) outVendClicks.push(d);
    }
  }

  // 精选接收封包细节
  for (const p of pkts) {
    if (p.pid === 0x0131) console.log(`  [0x0131] AID=${p.buf.readUInt32LE(2)} 店名「${gbk(p.buf.slice(6, 86))}」`);
    if (p.pid === 0x0071 || p.pid === 0x0AC5) console.log(`  [0x${p.pid.toString(16)}] 换图 → ${p.buf.slice(2, 18).toString().replace(/\0.*$/, '')}`);
    if (p.err) console.log(`  ⚠ ${p.err}`);
  }
}

console.log('\n========== 商店专项 ==========');
console.log(`STORE_ENTRY(店名气泡): ${shopEntries.length} 条`);
shopEntries.forEach((e) => console.log(`  AID=${e.AID} 「${e.title}」`));
console.log(`商品列表到达: ${vendLists.length} 条`);
vendLists.forEach((v) => {
  const sample = v.items.slice(0, 5).map((i) => `#${i.ITID}×${i.qty}@${i.price}z`).join(' ');
  console.log(`  0x${v.pid.toString(16)} AID=${v.AID} ${v.n}件: ${sample}${v.n > 5 ? ' …' : ''}`);
});
console.log(`客户端主动点击(0x0130 OUT): ${outVendClicks.length} 次`);
console.log(outVendClicks.length === 0 && vendLists.length > 0
  ? '\n★ 结论：商品列表无需点击即广播（走过/进视野即到达）'
  : vendLists.length === 0
    ? '\n结论：捕获期内没有任何商品列表到达（可能没走到商店区）'
    : '\n结论：商品列表与点击行为相关，非广播');
