'use strict';
// V6 roBrowser 协议常量与封包构造（packetver 20211103, GBK, ClientVer=3）
const { BinaryWriter } = require('./binary');

const GATEWAY = 'wss://port.lastro.cn/';      // WebSocket 网关，路径即目标 ip:port
const LINES = {
  online: { address: '45.248.8.68', port: 28569 }, // V6-Online
  eden:   { address: '45.248.8.68', port: 26569 }, // V6-Eden(N)
  edge:   { address: '45.248.8.68', port: 29569 }, // 电信线路（客户端线路表第 3 条）
};
// 环境变量覆盖登录服地址（测新线路用）
if (process.env.RO_LOGIN_PORT) {
  LINES[process.env.RO_LINE || 'eden'] = {
    address: process.env.RO_LOGIN_HOST || '45.248.8.68',
    port: parseInt(process.env.RO_LOGIN_PORT, 10),
  };
}
const LOGIN_VERSION = 45;   // 0x0064 登录封包里的 version
const CLIENTTYPE = 3;       // langtype 3 → GBK
const EXE_HASH = Buffer.from('83ba069fd7c9e7683c435cecd507b18d', 'hex'); // 0x0204 哈希

// 20211103 生效的发送封包 ID/长度
const PID = {
  EXE_HASHCHECK: 0x0204,
  LOGIN: 0x0064,
  CH_ENTER: 0x0065,
  SELECT_CHAR: 0x0066,
  MAKE_CHAR: 0x0067,
  CZ_ENTER: 0x0436,
  ACTORINIT: 0x007D,
  REQUEST_TIME: 0x0360,
  REQUEST_MOVE: 0x035F,
  REQUEST_ACT: 0x0437,
  REQUEST_CHAT: 0x00F3,
  CONTACTNPC: 0x0090,
  REQNAME: 0x0368,
  ACK_SELECT_DEALTYPE: 0x00C5, // 商店交互：0=购买 1=出售 2=取消
  CHANGE_DIRECTION: 0x009B,    // V6 用老式方向封包（服务器广播为 0x009C；新式 0x0361 会断线）
  AIRSHIP_REQUEST: 0x0A49,     // 私人飞艇/免费传送（世界地图点击，itemid=14527 V6 定制苍蝇翅膀）
  USE_ITEM: 0x0439,            // 20211103 版用道具（index i16@2 + AID u32@4）
  USE_SKILL: 0x0438,            // 20211103 版用技能（level i16@2, SKID u16@4, target u32@6）
  WHISPER: 0x0096,              // 密语（V6 真值：0x0096，receiver 定长 24B；旧 0x00D9 会被当畸形包踢线）
  MARKET_PURCHASE: 0x09D6,      // Market 商店购买：N × {ITID i32 + amount i32}
  MARKET_CLOSE: 0x09D8,         // Market 商店关闭
  SELECT_WARPPOINT: 0x011B,    // 瞬间移动技能选图（SKID u16 + 图名 16B）
  REQ_NEXT_SCRIPT: 0x00B9,
  CLOSE_DIALOG: 0x0146,
  CHOOSE_MENU: 0x00B8,
  NOTIFY_UPDATEINFO: 0x0AFE, // 服务器内置开关：34=自动攻击 35=自动拾取 36=自动进食（nid!=3 线路）
  NOTIFY_ONLYTARGET: 0x0AFD, // 服务器内挂定向怪物：mobID u32 + value u8(1=加/0=移除)
  MAKE_CHAR3: 0x0A39,        // CH.MAKE_CHAR3（2021 新建角，job 字段可建召唤师 4218）
  STATUS_CHANGE: 0x00BB,     // CZ.STATUS_CHANGE（V6 魔改 5B：statusID u16 + 提升幅度 u8）
  CHANGE_DIRECTION: 0x009B,
  ITEM_PICKUP: 0x0362,
  SKILL_UP: 0x0112,          // CZ.SKILL_UP（4B：SKID u16，每发 +1 级；回执 ZC.SKILLINFO_UPDATE 0x010E）
};

const BUILD = {
  exeHashCheck() {
    const w = new BinaryWriter(18);
    w.writeShort(PID.EXE_HASHCHECK); EXE_HASH.copy(w.buf, 2);
    return w.buffer;
  },
  login(id, passwd) {
    const w = new BinaryWriter(55);
    w.writeShort(PID.LOGIN); w.writeULong(LOGIN_VERSION);
    w.writeString(id, 24); w.writeString(passwd, 24); w.writeUChar(CLIENTTYPE);
    return w.buffer;
  },
  chEnter(AID, AuthCode, userLevel, sex) {
    const w = new BinaryWriter(17);
    w.writeShort(PID.CH_ENTER); w.writeULong(AID); w.writeULong(AuthCode);
    w.writeULong(userLevel); w.writeUShort(CLIENTTYPE); w.writeUChar(sex);
    return w.buffer;
  },
  selectChar(slot) {
    const w = new BinaryWriter(3);
    w.writeShort(PID.SELECT_CHAR); w.writeUChar(slot);
    return w.buffer;
  },
  czEnter(AID, GID, AuthCode, sex) {
    const w = new BinaryWriter(23);
    w.writeShort(PID.CZ_ENTER);
    w.buf.writeUInt32LE(AID >>> 0, 2);      // 与真实客户端对齐：AID@2 GID@6 Auth@10 Time@14 Sex@22
    w.buf.writeUInt32LE(GID >>> 0, 6);
    w.buf.writeUInt32LE(AuthCode >>> 0, 10);
    w.buf.writeUInt32LE(0, 14);             // ClientTime 固定 0（真值抓包）
    w.buf.writeUInt8(sex & 0xff, 22);       // Sex = 账号性别（与建角一致，错配会被地图服 0x0081 code=0 拒绝）
    return w.buffer;
  },
  // V6 定制：二级密码(PIN)上报，进图后发送（AID + 4 位 PIN）
  pinReport(AID, pin) {
    const w = new BinaryWriter(10);
    w.writeShort(0x0AFA); w.writeULong(AID); w.writeString(String(pin).slice(0, 4), 4);
    return w.buffer;
  },
  actorInit() { const w = new BinaryWriter(2); w.writeShort(PID.ACTORINIT); return w.buffer; },
  requestTime() {
    const w = new BinaryWriter(6);
    w.writeShort(PID.REQUEST_TIME); w.buf.writeUInt32LE(Date.now() >>> 0, 2);
    return w.buffer;
  },
  requestMove(x, y) {
    const w = new BinaryWriter(5);
    w.writeShort(PID.REQUEST_MOVE); w.writePos(x, y, 0);
    return w.buffer;
  },
  requestAct(targetGID, action) {
    const w = new BinaryWriter(7);
    w.writeShort(PID.REQUEST_ACT); w.writeULong(targetGID); w.writeUChar(action);
    return w.buffer;
  },
  requestChat(msg) {
    const b = require('iconv-lite').encode(msg, 'gbk');
    const w = new BinaryWriter(4 + b.length + 1);
    w.writeShort(PID.REQUEST_CHAT);
    w.buf.writeUInt16LE(4 + b.length + 1, 2);
    b.copy(w.buf, 4); w.buf[w.buf.length - 1] = 0;
    return w.buffer;
  },
  contactNpc(gid) {
    const w = new BinaryWriter(7);
    w.writeShort(PID.CONTACTNPC); w.writeULong(gid); w.writeUChar(1);
    return w.buffer;
  },
  reqName(gid) {
    const w = new BinaryWriter(6);
    w.writeShort(PID.REQNAME); w.writeULong(gid);
    return w.buffer;
  },
  nextScript(gid) {
    const w = new BinaryWriter(6);
    w.writeShort(PID.REQ_NEXT_SCRIPT); w.writeULong(gid);
    return w.buffer;
  },
  closeDialog(gid) {
    const w = new BinaryWriter(6);
    w.writeShort(PID.CLOSE_DIALOG); w.writeULong(gid);
    return w.buffer;
  },
  chooseMenu(gid, num) {
    const w = new BinaryWriter(7);
    w.writeShort(PID.CHOOSE_MENU); w.writeULong(gid); w.writeUChar(num);
    return w.buffer;
  },
  // 朝向封包（老式 0x009B 布局：dir u8 @2, headDir u8 @4），dir 经 [4,3,2,1,0,7,6,5] 映射
  changeDirection(dir, headDir = 0) {
    const w = new BinaryWriter(5);
    w.writeShort(PID.CHANGE_DIRECTION);
    w.buf.writeUInt8(headDir, 2);
    w.buf.writeUInt8([4, 3, 2, 1, 0, 7, 6, 5][(dir + 8) % 8], 4);
    return w.buffer;
  },
  // 私人飞艇免费传送（20211103/≥20180704 格式，34 字节）：
  // 世界地图点击 → type=1 + itemid=14527（V6 定制苍蝇翅膀）→ 免费飞任意支持传送的地图坐标
  // 响应 0x0A4A: 2=无传送卷轴/会员卡 3=该图不支持(洞穴) 4=当前图禁用
  // 用技能（20211103：level i16@2 + SKID u16@4 + target u32@6）
  useSkill(SKID, level, targetGID) {
    const w = new BinaryWriter(10);
    w.writeShort(PID.USE_SKILL);
    w.buf.writeInt16LE(level, 2);
    w.buf.writeUInt16LE(SKID, 4);
    w.buf.writeUInt32LE(targetGID >>> 0, 6);
    return w.buffer;
  },
  // 推车 → 背包 移动物品（2026-09-20 用户抓包真值 0x0127：index i16@2 + amount i32@4，无前置开窗包）
  moveFromStore(index, count) {
    const w = new BinaryWriter(8);
    w.writeShort(0x0127); w.buf.writeInt16LE(index, 2); w.buf.writeInt32LE(count, 4);
    return w.buffer;
  },
  // ---- 玩家交易（经典封包族，客户端注册表实证）----
  requestExchange(gid) {          // CZ.REQUEST_EXCHANGE 0x00E4：对目标发起交易请求
    const w = new BinaryWriter(6);
    w.writeShort(0x00E4); w.writeULong(gid);
    return w.buffer;
  },
  cancelExchange() {              // CZ.CANCEL_EXCHANGE_ITEM 0x00ED：取消交易
    const w = new BinaryWriter(2);
    w.writeShort(0x00ED);
    return w.buffer;
  },
  ackExchange(result = 0) {       // CZ.ACK_EXCHANGE_ITEM 0x00E6：接受(0)/拒绝(1/3)交易请求
    const w = new BinaryWriter(3);
    w.writeShort(0x00E6); w.writeUChar(result);
    return w.buffer;
  },
  addExchange(index, count) {     // CZ.ADD_EXCHANGE_ITEM 0x00E8：放入 index i16 + count i32
    const w = new BinaryWriter(8);
    w.writeShort(0x00E8); w.buf.writeInt16LE(index, 2); w.buf.writeInt32LE(count, 4);
    return w.buffer;
  },
  concludeExchange() {            // CZ.CONCLUDE_EXCHANGE_ITEM 0x00EB：锁定
    const w = new BinaryWriter(2);
    w.writeShort(0x00EB);
    return w.buffer;
  },
  execExchange() {                // CZ.EXEC_EXCHANGE_ITEM 0x00EF：执行
    const w = new BinaryWriter(2);
    w.writeShort(0x00EF);
    return w.buffer;
  },
  // 密语（CZ.WHISPER 0x0096, V6 布局：u16 len + receiver 定长 24B + msg\0；receiver 可为 "NPC:setXXX" 命令通道）
  whisper(receiver, msg) {
    const r = require('iconv-lite').encode(String(receiver).slice(0, 24), 'gbk');
    const m = require('iconv-lite').encode(String(msg), 'gbk');
    const total = 28 + m.length + 1;
    const w = new BinaryWriter(total);
    w.writeShort(PID.WHISPER);
    w.buf.writeUInt16LE(total, 2);
    r.copy(w.buf, 4);                       // receiver 固定 24 字节，不足补 0
    w.buf.fill(0, 4 + r.length, 28);
    m.copy(w.buf, 28);
    w.buf[w.buf.length - 1] = 0;
    return w.buffer;
  },
  // Market 商店购买（0x09D6 变长：N × {ITID i32 + amount i32}）
  marketPurchase(items) {
    const w = new BinaryWriter(4 + 8 * items.length);
    w.writeShort(PID.MARKET_PURCHASE);
    w.buf.writeUInt16LE(4 + 8 * items.length, 2);
    items.forEach((it, i) => {
      w.buf.writeInt32LE(it.ITID, 4 + 8 * i);
      w.buf.writeInt32LE(it.amount, 8 + 8 * i);
    });
    return w.buffer;
  },
  marketClose() { const w = new BinaryWriter(2); w.writeShort(PID.MARKET_CLOSE); return w.buffer; },
  // 用道具（20211103：index i16@2 + AID u32@4，共 8 字节）
  useItem(index, AID) {
    const w = new BinaryWriter(8);
    w.writeShort(PID.USE_ITEM);
    w.buf.writeInt16LE(index, 2);
    w.buf.writeUInt32LE(AID >>> 0, 4);
    return w.buffer;
  },
  // 瞬间移动选图（0x011B: SKID u16 + 16 字节图名，"cancel" 取消）
  selectWarppoint(SKID, mapName) {
    const w = new BinaryWriter(20);
    w.writeShort(PID.SELECT_WARPPOINT);
    w.writeUShort(SKID);
    w.writeString(String(mapName), 16);
    return w.buffer;
  },
  airshipRequest(mapname, x, y, type = 1, itemid = 14527) {
    const w = new BinaryWriter(34);
    w.writeShort(PID.AIRSHIP_REQUEST);
    w.writeString(String(mapname).replace(/\.gat$/i, ''), 16);
    w.writeULong(x >>> 0); w.writeULong(y >>> 0);
    w.writeULong(type >>> 0); w.writeULong(itemid >>> 0);
    return w.buffer;
  },
  ackSelectDealtype(gid, type) {
    const w = new BinaryWriter(7);
    w.writeShort(PID.ACK_SELECT_DEALTYPE); w.writeULong(gid); w.writeUChar(type);
    return w.buffer;
  },
  notifyUpdateinfo(id, value) {
    const w = new BinaryWriter(7);
    w.writeShort(PID.NOTIFY_UPDATEINFO); w.writeUChar(id); w.writeLong(value);
    return w.buffer;
  },
  // 内挂定向怪物列表（0x0AFD, 7B：mobID u32 + value u8）——与网页端"检测目标"复选框同一封包
  notifyOnlytarget(mobID, value = 1) {
    const w = new BinaryWriter(7);
    w.writeShort(PID.NOTIFY_ONLYTARGET);
    w.writeULong(mobID >>> 0); w.writeUChar(value ? 1 : 0);
    return w.buffer;
  },
  // 建角色（CH.MAKE_CHAR3 0x0A39, 36B）——job=4218 召唤师(猫)
  // 外观真值（对照 xiezixing2 正常猫）：head=1（head=0 无头贴图！）、headPal=0、sex=1
  makeChar3(name, slot, job = 4218, headPal = 0, head = 1, sex = 1) {
    const w = new BinaryWriter(36);
    w.writeShort(PID.MAKE_CHAR3);
    w.writeString(String(name), 24);
    w.writeUChar(slot);
    w.writeUShort(headPal); w.writeUShort(head);
    w.writeUShort(job);
    w.writeUShort(0);   // 未知（客户端固定 0）
    w.writeUChar(sex);
    return w.buffer;
  },
  // 加属性点（CZ.STATUS_CHANGE 0x00BB, V6 魔改 5B：statusID u16(13..18) + 提升幅度 u8）
  // 网页端聊天命令 "str+ 3" 即走此封包
  statusChange(statusID, amount = 1) {
    const w = new BinaryWriter(5);
    w.writeShort(PID.STATUS_CHANGE);
    w.writeUShort(statusID); w.writeUChar(amount);
    return w.buffer;
  },
  // 技能加点（CZ.SKILL_UP 0x0112, 4B：SKID u16）——技能窗口"+"按钮，每发 +1 级
  // 服务器回 ZC.SKILLINFO_UPDATE 0x010E（skillID+新等级）确认
  skillUp(SKID) {
    const w = new BinaryWriter(4);
    w.writeShort(PID.SKILL_UP);
    w.writeUShort(SKID);
    return w.buffer;
  },
  // 仓库存取（20211103：0x0364 存入 / 0x0365 取出，index i16@2 + amount i16@4）
  // 存入回执 0x0B44，取出回执 0x00F6；关闭 0x00F7 → 0x00F8
  moveItemToStore(index, amount) {
    const w = new BinaryWriter(8);
    w.writeShort(0x0364);
    w.writeShort(index); w.writeShort(amount);
    return w.buffer;
  },
  moveItemFromStore(index, amount) {
    const w = new BinaryWriter(8);
    w.writeShort(0x0365);
    w.writeShort(index); w.writeShort(amount);
    return w.buffer;
  },
  closeStore() { const w = new BinaryWriter(2); w.writeShort(0x00F7); return w.buffer; },
  // NPC 数字输入框回答（CZ.INPUT_EDITDLG 0x0143, 10B：NAID u32 + value i32）
  // 计算题防挂机弹窗的作答通道（ZC.SAY_DIALOG 0x00B4 出题 + ZC.OPEN_EDITDLG 0x0142 弹框）
  inputEditdlg(NAID, value) {
    const w = new BinaryWriter(10);
    w.writeShort(0x0143);
    w.writeULong(NAID >>> 0); w.writeLong(value | 0);
    return w.buffer;
  },
};

module.exports = { GATEWAY, LINES, PID, BUILD, EXE_HASH, CLIENTTYPE };
