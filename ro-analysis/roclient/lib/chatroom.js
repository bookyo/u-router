'use strict';
// 聊天室模块 —— 移植自 OpenKore chat_room 系封包（ServerType0.pm: chat_*/room_*）
// 生命周期：create(0x00D5) → ack(0x00D6)/广播(0x00D7) → 成员加入(0x00DC)/离开(0x00DD)
//           → 改房(0x00DE/0x00DF)、授权(0x00E0/0x00E1)、踢人(0x00E2)、退出(0x00E3)
// 房内消息走普通聊天 0x00F3 发送、0x008E 接收（服务器只广播给房内成员）
const EventEmitter = require('events');
const iconv = require('iconv-lite');

const NAME_LEN = 24;
const gbk = (b) => iconv.decode(b, 'gbk').replace(/\0[\s\S]*$/, '').trim();

// ---------- 纯解析函数（离线可测） ----------
// 0x00D7 ZC.ROOM_NEWENTRY：AID u32, roomID u32, max i16, cur i16, type u8, title GBK
function parseRoomNewEntry(buf) {
  return {
    AID: buf.readUInt32LE(2),
    roomID: buf.readUInt32LE(6),
    maxcount: buf.readInt16LE(10),
    curcount: buf.readInt16LE(12),
    type: buf.readUInt8(14),
    title: gbk(buf.slice(15)),
  };
}
// 0x00DB ZC.ENTER_ROOM：roomID u32 + 成员 {role u32, name 24B}[]
function parseEnterRoom(buf) {
  const roomID = buf.readUInt32LE(2);
  const members = [];
  for (let o = 6; o + 28 <= buf.length; o += 28) {
    members.push({ role: buf.readUInt32LE(o), name: gbk(buf.slice(o + 4, o + 4 + NAME_LEN)) });
  }
  return { roomID, members };
}
// 0x00DC ZC.MEMBER_NEWENTRY（28B）：cur i16 + name 24B
function parseMemberNewEntry(buf) {
  return { curcount: buf.readInt16LE(2), name: gbk(buf.slice(4, 4 + NAME_LEN)) };
}
// 0x00DD ZC.MEMBER_EXIT（29B）：cur i16 + name 24B + type u8（0=自行离开 1=被踢）
function parseMemberExit(buf) {
  return { curcount: buf.readInt16LE(2), name: gbk(buf.slice(4, 4 + NAME_LEN)), type: buf.readUInt8(28) };
}
// 0x00E1 ZC.ROLE_CHANGE（30B）：role u32 + name 24B（role 0=房主）
function parseRoleChange(buf) {
  return { role: buf.readUInt32LE(2), name: gbk(buf.slice(6, 6 + NAME_LEN)) };
}
// 0x008E 房内消息文本 "名字 : 消息" → {speaker, text}（名字含全/半角空格时取第一个 " : " 分隔）
function parseRoomMessage(msg, ownName) {
  const m = /^(.+?)\s:\s(.*)$/s.exec(String(msg));
  if (!m) return null;
  return { speaker: m[1], text: m[2], self: m[1] === ownName };
}

// ---------- 封包构造（发送方向） ----------
// CZ.CREATE_CHATROOM 0x00D5：len u16, size(max人数) u16, type u8(1=公开 0=加密), passwd 8B, title GBK\0
function buildCreateChatroom({ title, limit = 20, type = 1, passwd = '' } = {}) {
  const t = iconv.encode(String(title), 'gbk');
  const len = 2 + 2 + 2 + 1 + 8 + t.length + 1;
  const w = Buffer.alloc(len);
  let o = 0;
  w.writeUInt16LE(0x00D5, o); o += 2;
  w.writeUInt16LE(len, o); o += 2;
  w.writeUInt16LE(limit, o); o += 2;
  w.writeUInt8(type ? 1 : 0, o); o += 1;
  iconv.encode(String(passwd).slice(0, 8), 'gbk').copy(w, o); o += 8; // passwd 8B 不足补 0
  t.copy(w, o);
  return w;
}
// CZ.CHANGE_CHATROOM 0x00DE（布局同 0x00D5）
function buildChangeChatroom(opts) {
  const w = buildCreateChatroom(opts);
  w.writeUInt16LE(0x00DE, 0);
  return w;
}
// CZ.REQ_ROLE_CHANGE 0x00E0：role u32(0=授房主) + name 24B
function buildRoleChange(role, name) {
  const w = Buffer.alloc(2 + 4 + NAME_LEN);
  w.writeUInt16LE(0x00E0, 0);
  w.writeUInt32LE(role >>> 0, 2);
  iconv.encode(String(name).slice(0, 24), 'gbk').copy(w, 6);
  return w;
}
// CZ.REQ_EXPEL_MEMBER 0x00E2：name 24B
function buildExpel(name) {
  const w = Buffer.alloc(2 + NAME_LEN);
  w.writeUInt16LE(0x00E2, 0);
  iconv.encode(String(name).slice(0, 24), 'gbk').copy(w, 2);
  return w;
}
// CZ.EXIT_ROOM 0x00E3：仅 ID
function buildExitRoom() { const w = Buffer.alloc(2); w.writeUInt16LE(0x00E3, 0); return w; }

// ---------- 模块主体 ----------
class ChatRoom extends EventEmitter {
  constructor(client) {
    super();
    this.c = client;
    this.isOpen = false;         // 自己是否开着（房主）或身处房中
    this.isOwner = false;
    this.title = '';
    this.limit = 0;
    this.count = 0;
    this.members = [];           // [{name, role}]（role 0=房主）
    this._wire();
  }

  get ownName() { return (this.c.session && this.c.session.charName) || ''; }
  get isFull() { return this.count >= this.limit; }

  _wire() {
    const c = this.c;
    c.on('packet', ({ pid, pkt }) => {
      if (pid === 0x00D6) {                       // ZC.ACK_CREATE_CHATROOM
        this.emit('create_ack', { result: pkt.readUInt8(2) }); // 0=成功 1=人数超限 2=已存在
      } else if (pid === 0x00D7) {                // ZC.ROOM_NEWENTRY（含自己房间创建成功后的广播）
        const p = parseRoomNewEntry(pkt);
        if (this.isOpen && p.AID === c.session.AID) { // 自己的房间
          this.title = p.title; this.limit = p.maxcount; this.count = p.curcount;
          this.emit('room_update', p);
        }
        this.emit('room_visible', p);             // 视野内出现的房间（1v2 探房/避让用）
      } else if (pid === 0x00D8) {                // ZC.DESTROY_ROOM
        this.emit('room_destroyed', { roomID: pkt.readUInt32LE(2) });
      } else if (pid === 0x00DA) {                // ZC.REFUSE_ENTER_ROOM
        this.emit('enter_refused', { result: pkt.readUInt8(2) }); // 0=满 1=密码错 2=被踢过
      } else if (pid === 0x00DB) {                // ZC.ENTER_ROOM（自己进入了某房间）
        const p = parseEnterRoom(pkt);
        this.isOpen = true;
        this.members = p.members;
        this.count = p.members.length;
        this.isOwner = p.members.some((m) => m.role === 0 && m.name === this.ownName);
        this.emit('room_enter', p);
      } else if (pid === 0x00DC) {                // ZC.MEMBER_NEWENTRY（有人进房）
        const p = parseMemberNewEntry(pkt);
        this.count = p.curcount;
        if (!this.members.some((m) => m.name === p.name)) this.members.push({ name: p.name, role: 1 });
        this.emit('member_join', p);
      } else if (pid === 0x00DD) {                // ZC.MEMBER_EXIT（有人离房）
        const p = parseMemberExit(pkt);
        this.count = p.curcount;
        this.members = this.members.filter((m) => m.name !== p.name);
        if (p.name === this.ownName) { this.isOpen = false; this.isOwner = false; }
        this.emit('member_leave', p);
      } else if (pid === 0x00DF) {                // ZC.CHANGE_CHATROOM（房间属性变更广播）
        const p = parseRoomNewEntry(pkt);
        if (this.isOpen && p.AID === c.session.AID) {
          this.title = p.title; this.limit = p.maxcount; this.count = p.curcount;
        }
        this.emit('room_modified', p);
      } else if (pid === 0x00E1) {                // ZC.ROLE_CHANGE
        const p = parseRoleChange(pkt);
        if (p.role === 0 && p.name === this.ownName) this.isOwner = true;
        this.emit('role_change', p);
      }
    });
    // 房内消息：0x008E（client.dispatch 已解码为 server_msg，文本 "名字 : 消息"）
    c.on('server_msg', (p) => {
      if (!this.isOpen) return;
      const m = parseRoomMessage(p.msg, this.ownName);
      if (!m || m.self) return;
      this.emit('room_message', m);
    });
  }

  // 创建房间（OpenKore chat_room_create）。resolve 于 0x00D6 result=0；limit=2 即"只进一人"
  create({ title, limit = 2, type = 1, passwd = '', timeoutMs = 5000 } = {}) {
    return new Promise((resolve, reject) => {
      const onAck = ({ result }) => {
        clearTimeout(timer);
        this.removeListener('create_ack', onAck);
        if (result === 0) {
          this.isOpen = true; this.isOwner = true;
          this.title = String(title); this.limit = limit; this.count = 1;
          this.members = [{ name: this.ownName, role: 0 }];
          resolve(this);
        } else reject(new Error(`创建聊天室失败 code=${result}（1=人数超限 2=已存在同名房）`));
      };
      const timer = setTimeout(() => {
        this.removeListener('create_ack', onAck);
        reject(new Error('创建聊天室超时'));
      }, timeoutMs);
      this.on('create_ack', onAck); // create_ack 由 _wire 发在本实例上
      this.c.send(buildCreateChatroom({ title, limit, type, passwd }));
    });
  }

  change(opts) { this.c.send(buildChangeChatroom(opts)); }
  bestow(name) { this.c.send(buildRoleChange(0, name)); }   // 转让房主
  kick(name) { this.c.send(buildExpel(name)); }             // 踢人
  leave() { this.c.send(buildExitRoom()); this.isOpen = false; this.isOwner = false; this.members = []; }
  say(text) { this.c.chat(text); }                          // 房内发言（0x00F3，仅房内可见）
}

module.exports = { ChatRoom, parseRoomNewEntry, parseEnterRoom, parseMemberNewEntry, parseMemberExit, parseRoleChange, parseRoomMessage, buildCreateChatroom, buildChangeChatroom, buildRoleChange, buildExpel, buildExitRoom };
