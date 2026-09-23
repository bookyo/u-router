'use strict';
// 自动战斗时段封包分析：心跳节奏 + 内挂配置封包
// 输入：data/wslog-full.json（含 AUTOBATTLE-TEST-START 标记）
const fs = require('fs');
const path = require('path');
const iconv = require(path.join(__dirname, 'roclient/node_modules/iconv-lite'));
const L = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/wslog-full.json'), 'utf8'));
const markIdx = L.findIndex(e => e.k === 'mark' && e.note === 'AUTOBATTLE-TEST-START');
const slice = L.slice(markIdx);

// 当前 zone socket = 标记前最后活跃的 open（无新 open 时取 id 最大）
const opens = L.slice(0, markIdx).filter(e => e.k === 'open');
const zoneId = opens[opens.length - 1].id;
console.log(`== 采集窗口: ${new Date(slice[0].t).toISOString().slice(11,19)} → ${new Date(slice[slice.length-1].t).toISOString().slice(11,19)} (${Math.round((slice[slice.length-1].t-slice[0].t)/1000)}s), zone socket #${zoneId} ==\n`);

// ---------- OUT 解密：从该 socket 第一个 send 起推进密钥流（密钥组 B 纯流式） ----------
let k0 = 1205481659;
const K1 = 453065404, K2 = 592073252;
const allOuts = L.filter(e => e.k === 'out' && e.id === zoneId);
const outsDecoded = allOuts.map(e => {
  const b = Buffer.from(e.d, 'base64');
  k0 = (Math.imul(k0, K1) + K2) >>> 0;
  const mask = (k0 >>> 16) & 0x7fff;
  return { t: e.t, buf: b, pid: (b.readUInt16LE(0) ^ mask) & 0xffff };
});
const markT = slice[0].t;
const winOuts = outsDecoded.filter(o => o.t >= markT);

// ---------- IN 重组解析（明文流；逐帧可能含多包，拼流按 sizes 表切分） ----------
const SIZES = require(path.join(__dirname, 'roclient/packet_sizes.json'));
const inBuf = Buffer.concat(slice.filter(e => e.k === 'in' && e.id === zoneId).map(e => Buffer.from(e.d, 'base64')));
const inPackets = [];
let off = 0;
while (off + 2 <= inBuf.length) {
  const pid = inBuf.readUInt16LE(off);
  let size = SIZES[String(pid)];
  if (size === undefined) { inPackets.push({ pid, off, err: 'unknown' }); break; }
  if (size < 0) size = inBuf.readUInt16LE(off + 2);
  if (off + size > inBuf.length) break;
  inPackets.push({ pid, off, buf: inBuf.slice(off, off + size) });
  off += size;
}

const hist = (arr) => Object.entries(arr.reduce((a, p) => { a['0x' + p.pid.toString(16).padStart(4, '0')] = (a['0x' + p.pid.toString(16).padStart(4, '0')] || 0) + 1; return a; }, {}))
  .sort((a, b) => b[1] - a[1]);

console.log('== OUT（已解密）==', winOuts.length, '个');
hist(winOuts).slice(0, 12).forEach(([k, v]) => console.log('  ', k, '×' + v));
console.log('\n== IN（流重组）==', inPackets.length, '包');
hist(inPackets).slice(0, 15).forEach(([k, v]) => console.log('  ', k, '×' + v));

// ---------- 心跳节奏：0x0360 REQUEST_TIME 间隔 ----------
const heartbeats = winOuts.filter(o => o.pid === 0x0360).map(o => o.t);
console.log('\n== 心跳 0x0360（OUT）==', heartbeats.length, '次');
if (heartbeats.length >= 2) {
  const gaps = heartbeats.slice(1).map((t, i) => t - heartbeats[i]);
  console.log('  间隔(ms):', gaps.join(', '));
  console.log('  平均', Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length), 'ms');
}
// IN 侧 0x0074 服务器时间回应
const time74 = inPackets.filter(p => p.pid === 0x0074);
console.log('  服务器回应 0x0074 ×', time74.length);

// ---------- 内挂配置封包 ----------
console.log('\n== 内挂/配置封包 ==');
const CFG_OUT = { 0x0AFE: 'NOTIFY_UPDATEINFO(自动攻击/拾取/进食开关)', 0x0AFD: 'NOTIFY_ONLYTARGET(定向怪物)', 0x0096: 'WHISPER(NPC:setXXX 命令)', 0x0438: 'USE_SKILL', 0x0439: 'USE_ITEM', 0x0362: 'ITEM_PICKUP', 0x0437: 'REQUEST_ACT(攻击)', 0x035F: 'REQUEST_MOVE(移动)' };
for (const o of winOuts) {
  const name = CFG_OUT[o.pid];
  if (name) {
    const extra = o.pid === 0x0096 ? ' → ' + iconv.decode(o.buf.slice(4, 28), 'gbk').replace(/\0[\s\S]*$/, '') + ' : ' + iconv.decode(o.buf.slice(28), 'gbk').replace(/\0[\s\S]*$/, '')
      : o.pid === 0x0AFE ? ` id=${o.buf[2]} value=${o.buf.readInt32LE(3)}`
      : o.pid === 0x0AFD ? ` mob=${o.buf.readUInt32LE(2)} v=${o.buf[6]}`
      : o.pid === 0x0438 ? ` skill=${o.buf.readUInt16LE(4)} lv=${o.buf.readInt16LE(2)} target=${o.buf.readUInt32LE(6)}`
      : o.pid === 0x0437 ? ` target=${o.buf.readUInt32LE(2)} action=${o.buf[6]}`
      : '';
    console.log(`  [${new Date(o.t).toISOString().slice(11,19)}] OUT 0x${o.pid.toString(16).padStart(4,'0')} ${name}${extra}`);
  }
}
const CFG_IN = { 0x0AF5: 'NOTIFY_LOADINFO(内挂全量设置)', 0x0AF6: 'NOTIFY_RELOADINFOS(单项设置推送)', 0x0AF1: 'NOTIFY_SETTARGET(定向回执)', 0x0AFC: '内挂0x0AFC', 0x0AFB: '内挂0x0AFB', 0x0AF9: '内挂0x0AF9' };
for (const p of inPackets) {
  const name = CFG_IN[p.pid];
  if (name) {
    console.log(`  [流@${p.off}] IN 0x${p.pid.toString(16).padStart(4,'0')} ${name} ${p.buf.slice(2, 16).toString('hex')}`);
  }
}
// 未知 IN 包（高位怪 ID）
const unknowns = inPackets.filter(p => p.err === 'unknown');
if (unknowns.length) {
  console.log('\n⚠ 流解析中断于', '0x' + unknowns[0].pid.toString(16), '@', unknowns[0].off, '/', inBuf.length);
}
