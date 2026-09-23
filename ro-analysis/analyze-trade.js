'use strict';
// 真机交易抓包分析：解密 OUT + 重组 IN，提取交易封包族完整时序
const fs = require('fs');
const path = require('path');
const iconv = require(path.join(__dirname, 'roclient/node_modules/iconv-lite'));
const L = JSON.parse(fs.readFileSync('/Users/quyue/Downloads/ro-wslog-2026-09-20-06-32-06.json', 'utf8')).log;
const SIZES = require(path.join(__dirname, 'roclient/packet_sizes.json'));

// 每个事件：{t, dir, pid, len, hex}
const events = [];
// OUT 解密：zone socket（含 E4 发起方）用 keyset B 纯流式，从该 socket 第一个 out 起推进
const outsBySock = {};
for (const e of L) {
  if (e.k === 'out') (outsBySock[e.id] = outsBySock[e.id] || []).push(e);
}
let k0 = 1205481659; const K1 = 453065404, K2 = 592073252;
const decoded = new Map();   // out event → pid
for (const [sid, list] of Object.entries(outsBySock)) {
  let kk = 1205481659;
  for (const e of list) {
    const b = Buffer.from(e.d, 'base64');
    kk = (Math.imul(kk, K1) + K2) >>> 0;
    const mask = (kk >>> 16) & 0x7fff;
    decoded.set(e, (b.readUInt16LE(0) ^ mask) & 0xffff);
  }
}
// IN 重组：按 socket 拼流切包
const inFrames = {}, inStreams = {};
for (const e of L) if (e.k === 'in') inFrames[e.id] = (inFrames[e.id] || []).concat(Buffer.from(e.d, 'base64'));
for (const [sid, arr] of Object.entries(inFrames)) inStreams[sid] = Buffer.concat(arr);
const inPackets = [];   // 按顺序近似（单 zone socket 时序可靠）
for (const [sid, buf] of Object.entries(inStreams)) {
  let off = 0;
  while (off + 2 <= buf.length) {
    const pid = buf.readUInt16LE(off);
    let size = SIZES[String(pid)];
    if (size === undefined) { inPackets.push({ sid: +sid, pid, off, len: buf.length - off, tail: true }); break; }
    if (size < 0) { if (off + 4 > buf.length) break; size = buf.readUInt16LE(off + 2); }
    if (off + size > buf.length) break;
    inPackets.push({ sid: +sid, pid, off, len: size, buf: buf.slice(off, off + size) });
    off += size;
  }
}
// 合并时间线
const ins2 = [...inPackets];
const all = [];
let inIdx = 0;
for (const e of L) {
  if (e.k === 'out') all.push({ t: e.t, dir: 'OUT', pid: decoded.get(e), raw: Buffer.from(e.d, 'base64') });
  else if (e.k === 'in') {
    // 按顺序从 inPackets 取（同 socket 保持顺序）
    const p = ins2.find((q) => q.sid === e.id && !q.used && !q.tail);
    if (p) { p.used = true; all.push({ t: e.t, dir: 'IN', pid: p.pid, raw: p.buf }); }
  }
}
all.sort((a, b) => a.t - b.t);
// 交易族过滤
const FAM = new Set([0x00e4, 0x00e5, 0x00e6, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb, 0x00ec, 0x00ed, 0x00ee, 0x00ef, 0x00f0, 0x01f4, 0x01f5]);
const hits = all.filter((p) => FAM.has(p.pid));
console.log(`== 总事件 ${all.length}，交易族 ${hits.length} 个 ==\n`);
for (const p of hits) {
  const hex = p.raw.toString('hex');
  let extra = '';
  if (p.pid === 0x00e4 && p.dir === 'OUT') extra = ' → GID ' + p.raw.readUInt32LE(2);
  if (p.pid === 0x00e6 && p.dir === 'OUT') extra = ' result=' + p.raw.readUInt8(2);
  if (p.pid === 0x00e8 && p.dir === 'OUT') extra = ` index=${p.raw.readInt16LE(2)} count=${p.raw.readInt32LE(4)}`;
  if (p.pid === 0x01f4) { try { extra = ' 发起方=' + iconv.decode(p.raw.slice(2, 26), 'gbk').replace(/\0.*$/, ''); } catch (_) {} }
  if (p.pid === 0x01f5) extra = ` result=${p.raw.readUInt8(2)}`;
  if (p.pid === 0x00e9) extra = ` who=${p.raw.readUInt8(2)} count=${p.raw.readInt32LE(3)} ITID=${p.raw.readUInt16LE(7)}`;
  if (p.pid === 0x00ec) extra = ' who=' + p.raw.readUInt8(2);
  console.log(`${new Date(p.t).toISOString().slice(11, 23)} ${p.dir} 0x${p.pid.toString(16).padStart(4, '0')} ${p.raw.length}B ${hex.slice(0, 60)}${extra}`);
}
// 交易窗口附近的全部 OUT（看有没有我们没发的东西）
console.log('\n== 交易前后 20s 的全部 OUT ==');
if (hits.length) {
  const t0 = hits[0].t, t1 = hits[hits.length - 1].t;
  for (const p of all.filter((x) => x.dir === 'OUT' && x.t >= t0 - 3000 && x.t <= t1 + 3000))
    console.log(`${new Date(p.t).toISOString().slice(11, 23)} OUT 0x${p.pid.toString(16).padStart(4, '0')} ${p.raw.length}B ${p.raw.toString('hex').slice(0, 40)}`);
}
