'use strict';
// 仓库存取模块离线单测：真实抓包回放（probe-storage.js 2026-09-17）+ 模块往返
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const { BUILD } = require('../lib/protocol');
const { Storage } = require('../lib/storage');

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.storage = null;
    this.inventory = [];
    this.sent = [];
    this.ws = true; this.state = 'zone';
  }
  send(buf) { this.sent.push(buf); }
}

test('protocol: 0x0364/0x0365 存取封包布局（index i16 + amount i16）', () => {
  const dep = BUILD.moveItemToStore(25, 3);
  assert.strictEqual(dep.length, 8);
  assert.strictEqual(dep.readUInt16LE(0), 0x0364);
  assert.strictEqual(dep.readInt16LE(2), 25);
  assert.strictEqual(dep.readInt16LE(4), 3);
  const wd = BUILD.moveItemFromStore(7, 12);
  assert.strictEqual(wd.readUInt16LE(0), 0x0365);
  assert.strictEqual(wd.readInt16LE(2), 7);
  assert.strictEqual(wd.readInt16LE(4), 12);
  assert.strictEqual(BUILD.closeStore().readUInt16LE(0), 0x00F7);
});

test('Storage: 开仓判定/存取回执/按 ITID 找位', async () => {
  const c = new FakeClient();
  const st = new Storage(c, { log: () => {}, ackTimeoutMs: 60 });
  // 模拟开仓列表（0x0B09 堆叠 + 0x00F2 容量）
  c.emit('storage_open', { type: 2, name: 'Storage' });
  c.storage = { open: true, stackables: [{ index: 3, ITID: 713, count: 20 }, { index: 4, ITID: 601, count: 74 }], equips: [{ index: 11, ITID: 15009 }], count: 3, max: 600 };
  assert.ok(st.opened);
  assert.strictEqual(st.items.length, 3);

  // 存入：发 0x0364 后服务器回 0x0B44
  setTimeout(() => c.emit('storage_added', { index: 99, amount: 1, ITID: 713 }), 10);
  const ack = await st.deposit(5, 1);
  assert.strictEqual(c.sent[0].readUInt16LE(0), 0x0364);
  assert.deepStrictEqual(ack, { index: 99, amount: 1, ITID: 713 });

  // 取出：发 0x0365 后服务器回 0x00F6
  setTimeout(() => c.emit('storage_removed', { index: 99, amount: 1 }), 10);
  const r2 = await st.withdraw(99, 1);
  assert.strictEqual(c.sent[1].readUInt16LE(0), 0x0365);
  assert.deepStrictEqual(r2, { index: 99, amount: 1 });

  // 按 ITID 取：空瓶 → 仓库位 3
  setTimeout(() => c.emit('storage_removed', { index: 3, amount: 5 }), 10);
  await st.withdrawByITID(713, 5);
  assert.strictEqual(c.sent[2].readUInt16LE(0), 0x0365);
  assert.strictEqual(c.sent[2].readInt16LE(2), 3);

  // 关仓
  setTimeout(() => c.emit('storage_closed', {}), 10);
  await st.close();
  assert.strictEqual(c.sent[3].readUInt16LE(0), 0x00F7);
  assert.strictEqual(c.storage.open, false);
});

test('Storage: 无回执超时不乐观记账', async () => {
  const c = new FakeClient();
  const st = new Storage(c, { log: () => {}, ackTimeoutMs: 40, retries: 0 });
  const ack = await st.deposit(1, 1);   // 服务器不回
  assert.strictEqual(ack, null);
});

test('Storage: 首次无回执自动重发，第二次成功（网络抖动重试）', async () => {
  const c = new FakeClient();
  const st = new Storage(c, { log: () => {}, ackTimeoutMs: 40, retries: 2, retryDelayMs: 10 });
  let sends = 0;
  c.send = (buf) => {
    c.sent.push(buf);
    sends++;
    if (sends === 2) setTimeout(() => c.emit('storage_added', { index: 7, amount: 1, ITID: 601 }), 5);
  };
  const ack = await st.deposit(5, 1);
  assert.strictEqual(sends, 2, '应重发一次');
  assert.deepStrictEqual(ack, { index: 7, amount: 1, ITID: 601 });
});

test('Storage: 重试耗尽返回 null 且不超发', async () => {
  const c = new FakeClient();
  const st = new Storage(c, { log: () => {}, ackTimeoutMs: 30, retries: 2, retryDelayMs: 5 });
  const ack = await st.withdraw(3, 1);   // 始终无回执
  assert.strictEqual(ack, null);
  assert.strictEqual(c.sent.length, 3, '首次 + 2 次重发');
});

// ---------------- 解析器回归（按 2026-09-17 实机实证布局构造；真值：仓库 109/600、
// 存入苍蝇翅膀#601×1 回执 index=1，0x0B39 60 条装备含伊甸园 2456/15009/5583） ----------------
const { ROClient } = require('../lib/client');

// 合成 0x0B39 装备条目（68B，OpenKore type9：index u16 + ITID u32 + type u8 + typeEquip u32 +
// equipped u32 + 卡片16B + expire i32 + bind u16 + sprite u16 + numOpt u8 + 选项25B + 精炼/品级/已鉴定）
function equipEntry(index, ITID) {
  const e = Buffer.alloc(68);
  e.writeUInt16LE(index, 0);
  e.writeUInt32LE(ITID, 2);
  e.writeUInt8(5, 6);        // type
  e.writeUInt32LE(0x0200, 7);
  e.writeUInt8(1, 66);       // identified
  return e;
}
function pktVar(pid, body) {
  const h = Buffer.alloc(4);
  h.writeUInt16LE(pid, 0);
  h.writeUInt16LE(4 + body.length, 2);
  return Buffer.concat([h, body]);
}

test('解析器：0x0B39 仓库装备列表（type=2 → storage 事件，68B/项）', () => {
  const c = new ROClient({});
  const body = Buffer.concat([
    Buffer.from([0x02]),   // window type = 2 (storage)
    equipEntry(11, 2456), equipEntry(12, 15009), equipEntry(13, 5583),
  ]);
  let evt = null;
  c.once('storage_list', (p) => { evt = p; });
  c.dispatch(0x0B39, pktVar(0x0B39, body));
  assert.ok(evt && evt.kind === 'equip');
  assert.strictEqual(evt.items.length, 3);
  assert.deepStrictEqual(evt.items.map((i) => i.ITID), [2456, 15009, 5583]);
  assert.ok(evt.items.every((i) => Array.isArray(i.cards) && i.cards.length === 4));
  assert.strictEqual(evt.items[0].index, 11);
  assert.strictEqual(c.storage.open, true);
  assert.strictEqual(c.inventory, undefined, '仓库列表不得污染背包');
});

test('解析器：0x0B09 type=2 仓库堆叠列表不覆盖背包，type=0 仍进背包', () => {
  const mk34 = (type, idx, itid, count) => {
    const e = Buffer.alloc(34);
    e.writeInt16LE(idx, 0); e.writeUInt32LE(itid, 2); e.writeUInt8(0, 6); e.writeInt16LE(count, 7);
    return e;
  };
  const c = new ROClient({});
  let storageEvt = null, invEvt = null;
  c.once('storage_list', (p) => { storageEvt = p; });
  c.once('inventory', (items) => { invEvt = items; });
  c.dispatch(0x0B09, pktVar(0x0B09, Buffer.concat([[0x02], mk34(2, 3, 713, 20), mk34(2, 4, 601, 74)].map((b) => Buffer.isBuffer(b) ? b : Buffer.from(b)))));
  assert.ok(storageEvt && storageEvt.kind === 'stackable');
  assert.strictEqual(storageEvt.items.length, 2);
  assert.strictEqual(storageEvt.items[0].ITID, 713);
  assert.ok(!invEvt, 'type=2 不得写 inventory');
  c.dispatch(0x0B09, pktVar(0x0B09, Buffer.concat([Buffer.from([0x00]), mk34(0, 1, 501, 5)])));
  assert.deepStrictEqual(invEvt, [{ index: 1, ITID: 501, type: 0, count: 5, wear: 0, cards: [0, 0, 0, 0] }]);
});

test('解析器：0x0B44 存入回执 + 0x00F2 容量 + 0x00F6 取出 + 0x00F8 关仓（真实回执值合成）', () => {
  const c = new ROClient({});
  // 0x0B44：实机真值 index=1 amount=1 ITID=601（苍蝇翅膀往返实测）
  const b44 = Buffer.alloc(56);
  b44.writeUInt16LE(1, 0);        // index
  b44.writeUInt32LE(1, 2);        // amount
  b44.writeUInt32LE(601, 6);      // ITID
  b44.writeUInt8(2, 10);          // type
  b44.writeUInt8(1, 11);          // identified
  let added = null;
  c.once('storage_added', (p) => { added = p; });
  const b44full = Buffer.alloc(58);
  b44full.writeUInt16LE(0x0B44, 0);
  b44.copy(b44full, 2);          // 定长包：id(2) + body(56)，无 len 域
  c.dispatch(0x0B44, b44full);
  assert.strictEqual(added.index, 1);
  assert.strictEqual(added.amount, 1);
  assert.strictEqual(added.ITID, 601);

  let cnt = null;
  c.once('storage_count', (p) => { cnt = p; });
  c.dispatch(0x00F2, Buffer.from([0xf2, 0x00, 0x6d, 0x00, 0x58, 0x02]));   // 109/600 实机真值
  assert.strictEqual(cnt.count, 109);
  assert.strictEqual(cnt.max, 600);

  let rm = null;
  c.once('storage_removed', (p) => { rm = p; });
  c.dispatch(0x00F6, Buffer.from([0xf6, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00]));
  assert.deepStrictEqual(rm, { index: 1, amount: 1 });

  let closed = false;
  c.once('storage_closed', () => { closed = true; });
  c.storage = { open: true };
  c.dispatch(0x00F8, Buffer.from([0xf8, 0x00]));
  assert.ok(closed);
  assert.strictEqual(c.storage.open, false);
});
