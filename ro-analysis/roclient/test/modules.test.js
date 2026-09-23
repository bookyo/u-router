'use strict';
// 离线单测：真实浏览器抓包回放（wslog-*.json）+ 合成封包
// 运行：cd ro-analysis/roclient && npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const iconv = require('iconv-lite');
const { Vending, parseVendList, parseStoreEntry, parseSSI } = require('../lib/vending');
const { ChatRoom, parseRoomNewEntry, parseMemberNewEntry, parseMemberExit, parseRoomMessage, buildCreateChatroom } = require('../lib/chatroom');
const { AutoChat } = require('../lib/autochat');
const { ItemDB } = require('../lib/itemdb');

const DATA = path.join(__dirname, '..', '..', 'data');
const SIZES = require(path.join(__dirname, '..', 'packet_sizes.json'));
const loadLog = (f) => {
  const p = path.join(DATA, f);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
};

// 测试替身客户端：emit 'packet'/'server_msg'/'vanish'，捕获 send/chat
class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.entities = new Map();
    this.session = { AID: 2001234, charName: '测试员' };
    this.sent = [];
  }
  send(buf) { this.sent.push(buf); }
  chat(msg) { this.sent.push({ chat: msg }); }
  inject(pid, pkt) {
    if (pid === 0x008E) {
      const body = pkt.slice(4);
      this.emit('server_msg', { msg: iconv.decode(body, 'gbk').replace(/\0[\s\S]*$/, '') });
    } else {
      this.emit('packet', { pid, pkt });
    }
  }
}

// 重组某 socket 的 IN 字节流
function streamOf(log, sockId) {
  return Buffer.concat(log.filter((e) => e.id === sockId && e.k === 'in').map((e) => Buffer.from(e.d, 'base64')));
}
// 从字节流提取变长封包（len 域 + AID 范围校验，防魔数误报）
function extract(buf, marker, headerLen, step) {
  const out = [];
  for (let i = 0; i + headerLen < buf.length; i++) {
    if (buf[i] === (marker & 0xff) && buf[i + 1] === (marker >> 8)) {
      const len = buf.readUInt16LE(i + 2);
      const aid = buf.readUInt32LE(i + 4);
      if (aid >= 1900000 && aid <= 2200000 && (len - headerLen) % step === 0 && i + len <= buf.length) {
        out.push(buf.slice(i, i + len));
        i += len - 1;
      }
    }
  }
  return out;
}
// 定长封包提取（如 0x0131 固定 86B）
function extractFixed(buf, marker, size) {
  const out = [];
  for (let i = 0; i + size <= buf.length; i++) {
    if (buf[i] === (marker & 0xff) && buf[i + 1] === (marker >> 8)) {
      const aid = buf.readUInt32LE(i + 2);
      if (aid >= 1900000 && aid <= 2200000) { out.push(buf.slice(i, i + size)); i += size - 1; }
    }
  }
  return out;
}

// ================= 露天商店 =================
test('真实抓包：普隆德拉 306 家商店 0x0131 标题解析', () => {
  const log = loadLog('wslog-pc.json');
  if (!log) return; // 无抓包环境跳过
  const buf = streamOf(log, 2);
  const shops = extractFixed(buf, 0x0131, 86); // 定长 2+4+80
  assert.ok(shops.length > 100, `视野商店数 ${shops.length} 应过百`);
  const v = new Vending(new FakeClient());
  shops.forEach((p) => {
    const e = parseStoreEntry(p);
    v.shops.set(e.AID, { AID: e.AID, title: e.title, items: null });
  });
  assert.ok([...v.shops.values()].some((s) => /神之金属|巧克力|词条/.test(s.title)), '应包含已知店名');
});

test('真实抓包：0x0B3D 商品列表 6/6 解析（含价格/数量/ITID）', () => {
  const log = loadLog('wslog-pc2.json');
  if (!log) return;
  const buf = streamOf(log, 2);
  const lists = extract(buf, 0x0B3D, 12, 64);
  assert.ok(lists.length >= 6, `商品列表数 ${lists.length} 应不少于 6`);
  const parsed = lists.map((p) => parseVendList(0x0B3D, p));
  // AID=2015214 巧克力店：应含 #985(神之金属) ×20 @2555z
  const choco = parsed.find((v) => v.AID === 2015214);
  assert.ok(choco, '应有巧克力神秘老旧熊掌店');
  const elu = choco.items.find((it) => it.ITID === 985);
  assert.ok(elu && elu.price === 2555 && elu.qty === 20, `985 应为 ×20@2555z，实得 ${JSON.stringify(elu)}`);
  // 全部条目 ITID 应在合理范围
  parsed.forEach((v) => v.items.forEach((it) => {
    assert.ok(it.ITID > 0 && it.ITID < 3000000, `ITID ${it.ITID} 越界`);
    assert.ok(it.price > 0 && it.price < 1e9, `价格 ${it.price} 越界`);
  }));
});

test('Vending 模块：0x0131/0x0132/0x0B3D 事件流（FakeClient）', () => {
  const c = new FakeClient();
  const v = new Vending(c);
  const events = [];
  v.on('shop_seen', (s) => events.push(['seen', s.AID]));
  v.on('shop_listed', (s) => events.push(['listed', s.AID, s.items.length]));
  v.on('shop_gone', (s) => events.push(['gone', s.AID]));
  // 店出现
  const e1 = Buffer.alloc(86);
  e1.writeUInt16LE(0x0131, 0);
  e1.writeUInt32LE(2015000, 2);
  iconv.encode('测试商店ABC', 'gbk').copy(e1, 6);
  c.inject(0x0131, e1);
  assert.equal(v.shops.size, 1);
  // 商品列表（2 件）
  const list = Buffer.alloc(12 + 2 * 64);
  list.writeUInt16LE(0x0B3D, 0);
  list.writeUInt16LE(list.length, 2);
  list.writeUInt32LE(2015000, 4);
  [0, 1].forEach((k) => {
    const o = 12 + k * 64;
    list.writeInt32LE(1500 + k, o);
    list.writeInt16LE(10 + k, o + 4);
    list.writeInt16LE(k, o + 6);
    list.writeUInt8(0, o + 8);
    list.writeUInt32LE(985 + k, o + 9);
  });
  c.inject(0x0B3D, list);
  const shop = v.shops.get(2015000);
  assert.equal(shop.items.length, 2);
  assert.equal(shop.items[0].ITID, 985);
  // 检索（数字 ITID）
  const hit = v.search('985');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].price, 1500);
  assert.equal(v.cheapest('985').shop.title, '测试商店ABC');
  // 店消失
  const e2 = Buffer.alloc(6);
  e2.writeUInt16LE(0x0132, 0);
  e2.writeUInt32LE(2015000, 2);
  c.inject(0x0132, e2);
  assert.equal(v.shops.size, 0);
});

test('Vending：requestList 节流', () => {
  const c = new FakeClient();
  const v = new Vending(c);
  v.shops.set(1, { AID: 1, title: 'x', items: null });
  assert.equal(v.requestList(1), true);
  assert.equal(v.requestList(1), false, '10 秒内应节流');
  assert.equal(c.sent.length, 1);
});

// ================= 聊天室 =================
test('真实抓包：0x00D5 建房 + 0x00D6 成功 + 0x00DD 自离', () => {
  const log = loadLog('wslog-pc3.json');
  if (!log) return;
  const buf = streamOf(log, 5);
  // 0x00D6 回执（紧跟建房之后的那条；魔数可能有误报，这里只验证存在 result=0）
  let ackOk = false;
  for (let i = 0; i + 3 <= buf.length; i++) {
    if (buf[i] === 0xd6 && buf[i + 1] === 0x00 && buf[i + 2] === 0) { ackOk = true; break; }
  }
  assert.ok(ackOk, '应有 0x00D6 result=0');
  // 0x00DD 自己离开
  let selfLeave = null;
  for (let i = 0; i + 29 <= buf.length; i++) {
    if (buf[i] === 0xdd && buf[i + 1] === 0x00) {
      const p = parseMemberExit(buf.slice(i, i + 29));
      if (p.name === '蝎子星传奇') { selfLeave = p; break; }
    }
  }
  assert.ok(selfLeave, '应有房主自身离开事件');
  assert.equal(selfLeave.type, 0);
});

test('ChatRoom：建房流程与房间消息', async () => {
  const c = new FakeClient();
  const room = new ChatRoom(c);
  // 构造 0x00D5 → 校验字节
  const pkt = buildCreateChatroom({ title: '1v2', limit: 2, type: 1 });
  assert.equal(pkt.length, 19);
  assert.equal(pkt.readUInt16LE(0), 0x00D5);
  assert.equal(pkt.readUInt16LE(2), 19);
  assert.equal(pkt.readUInt16LE(4), 2); // 只进一人
  assert.equal(pkt[6], 1);
  assert.equal(pkt.slice(15, 18).toString(), '1v2');
  // 事件流
  const evts = [];
  room.on('member_join', (p) => evts.push(['join', p.name]));
  room.on('member_leave', (p) => evts.push(['leave', p.name]));
  room.on('room_message', (m) => evts.push(['msg', m.speaker, m.text]));
  const created = room.create({ title: '1v2', limit: 2 });
  const ack = Buffer.alloc(3); ack.writeUInt16LE(0x00D6, 0); ack[2] = 0;
  c.inject(0x00D6, ack);
  await created;
  assert.ok(room.isOpen && room.isOwner);
  // 客人加入
  const join = Buffer.alloc(28);
  join.writeUInt16LE(0x00DC, 0);
  join.writeInt16LE(2, 2);
  iconv.encode('客人甲', 'gbk').copy(join, 4);
  c.inject(0x00DC, join);
  assert.equal(room.count, 2);
  assert.ok(room.isFull, 'limit=2 时满员，第三人进不来');
  // 房内消息（0x008E "名字 : 内容"）
  const chat = Buffer.concat([Buffer.from([0x8e, 0x00, 0x00, 0x00]), iconv.encode('客人甲 : 红色药水', 'gbk'), Buffer.from([0])]);
  c.inject(0x008E, chat);
  // 客人离开
  const leave = Buffer.alloc(29);
  leave.writeUInt16LE(0x00DD, 0);
  leave.writeInt16LE(1, 2);
  iconv.encode('客人甲', 'gbk').copy(leave, 4);
  leave[28] = 0;
  c.inject(0x00DD, leave);
  assert.equal(room.count, 1);
  assert.deepEqual(evts.map((e) => e[0]), ['join', 'msg', 'leave']);
  assert.deepEqual(evts[1], ['msg', '客人甲', '红色药水']);
});

test('parseRoomMessage：各种 "名字 : 消息" 形态', () => {
  assert.deepEqual(parseRoomMessage('客人甲 : 985', '测试员'), { speaker: '客人甲', text: '985', self: false });
  assert.deepEqual(parseRoomMessage('测试员 : 你好', '测试员'), { speaker: '测试员', text: '你好', self: true });
  assert.equal(parseRoomMessage('无分隔符消息', 'x'), null);
});

// ================= 自动应答 =================
test('AutoChat：规则匹配/冷却/排队发送', async () => {
  const c = new FakeClient();
  const auto = new AutoChat(c, { minDelay: 1, maxDelay: 2, cooldownMs: 5000 });
  auto.rule({ match: '你好', reply: '欢迎！发关键词查最低价' });
  auto.rule({ match: /^\d+$/, mode: 'regex', reply: (sp, text) => `查到关键词:${text}` });
  const room = { say: (t) => c.chat(t) };
  assert.equal(auto.feed('路人', '你好呀', { room }), true);
  assert.equal(auto.feed('路人', '你好呀', { room }), false, '冷却期内不重复应答');
  assert.equal(auto.feed('路人', '985', { room }), true);
  await new Promise((r) => setTimeout(r, 60));
  const chats = c.sent.filter((s) => s.chat);
  assert.equal(chats.length, 2);
  assert.equal(chats[0].chat, '欢迎！发关键词查最低价');
  assert.equal(chats[1].chat, '查到关键词:985');
});

// ================= 物品名表 =================
test('ItemDB：本地 fixture 解析与检索', async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roclient-itemdb-'));
  const fixture = path.join(fixtureDir, 'idnum.txt');
  try {
    fs.writeFileSync(fixture, '501#\xbba1\xb0a3\xc6\xf7\xb0c7#\r\n512#Apple#\r\n985#Elunium#\r\n'); // CP949 示例
    const db = new ItemDB();
    await db.load({ file: fixture });
    // 512 在 data/itemnames-zh.json 中文覆盖表里是"苹果"（覆盖优先级高于源表/fixture）
    assert.ok(['Apple', '苹果'].includes(db.name(512)), `got ${db.name(512)}`);
    assert.ok(['Elunium', '铝'].includes(db.name(985)), `got ${db.name(985)}`);  // 985 也在中文覆盖表里
    assert.equal(db.name(99999), '#99999');
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

// ================= 退出与危险操作说明 =================
test('危险行为记录：SSI 0x0835 在本服触发踢线（代码约束）', () => {
  // 2026-09-12 实测：发送 0x0835 后立刻 0x0081 code=4 断线；模块保留 ssiSearch 但默认禁用
  const c = new FakeClient();
  const v = new Vending(c, null, { allowSSI: false });
  assert.equal(typeof v.ssiSearch, 'function');
});
