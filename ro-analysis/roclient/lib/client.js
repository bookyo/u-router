'use strict';
// RO V6 离线测试客户端状态机：网关连接 → 登录 → 选角 → 进地图 → 游戏
const WebSocket = require('ws');
const EventEmitter = require('events');
const crypto = require('crypto');
const { BinaryReader } = require('./binary');
const { PacketCrypt } = require('./crypt');
const { GATEWAY, LINES, BUILD } = require('./protocol');
const SIZES = require('../packet_sizes.json'); // id(number as string) -> 总长(含2字节头, -1=变长)

const sizeOf = (pid) => {
  const s = SIZES[String(pid)];
  return s === undefined ? null : s;
};

class ROClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.line = opts.line || 'eden';
    this.account = opts.account;
    this.password = opts.password;
    this.pin = opts.pin || process.env.RO_PIN || ''; // 二级密码（进图后上报）
    this.isZone = false;
    this.crypt = new PacketCrypt(opts.cryptKeys);
    this.ws = null;
    this.half = null;      // 半包缓存
    this.session = {};     // AID/GID/AuthCode/userLevel/sex
    this.state = 'idle';
    this.entities = new Map(); // GID -> entity
    this.mapName = null;
    this.position = null;  // [x, y, dir]
    this.dialog = null;    // {type:'say'|'wait'|'close'|'menu', gid, msg, options}
    this.verbosity = opts.verbose ? 1 : 0;
    this.keepAliveTimer = null;
  }

  log(...a) { console.log('[client]', ...a); }
  warn(...a) { console.warn('[client]', ...a); }
  dump(tag, buf) {
    if (!this.verbosity) return;
    const rows = [];
    for (let i = 0; i < Math.min(buf.length, 96); i += 16) {
      rows.push(buf.slice(i, i + 16).toString('hex').match(/../g).join(' '));
    }
    console.log(`[dump:${tag}] len=${buf.length}\n` + rows.join('\n'));
  }

  // ---------- 连接 ----------
  connectGateway(host, port, isZone = false) {
    return new Promise((resolve, reject) => {
      // 与真实客户端一致：旧 socket 不主动关闭（由服务器端关闭），避免中断认证传递
      this.isZone = isZone;
      if (isZone) this.crypt.init(); else this.crypt.reset();
      const gateway = process.env.RO_GATEWAY || GATEWAY; // 备用代理：RO_GATEWAY=ws://port.lastro.cn:5999/
      const url = `${gateway}${host}:${port}`;
      this.sockTag = isZone ? 'zone' : (this.state === 'login' ? 'login' : 'char');
      this.log(`连接网关 ${url}${isZone ? ' (zone, 加密开)' : ''}`);
      this.ws = new WebSocket(url, {
        headers: Object.assign({
          Origin: 'https://post.lastro.cn',
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept-Language': 'zh-CN,zh;q=0.9',
        }, process.env.RO_WS_HEADERS ? JSON.parse(process.env.RO_WS_HEADERS) : {}),
        perMessageDeflate: process.env.RO_WS_DEFLATE ? {
          clientNoContextTakeover: true, serverNoContextTakeover: true,
        } : false,
        handshakeTimeout: 15000,
      });
      this._allSockets = this._allSockets || new Set();
      this._allSockets.add(this.ws);
      const sock = this.ws;
      this.ws.binaryType = 'nodebuffer';
      this.ws.on('open', () => resolve());
      this.ws.on('error', (e) => { this.state === 'closed' ? null : reject(e); });
      this.ws.on('close', () => {
        clearInterval(this.keepAliveTimer);
        // 仅当前活动 socket 断开才算业务断线（角色服在移交地图服后会正常关闭旧连接）
        if (sock === this.ws && this.state !== 'closed') {
          const charDied = this.sockTag === 'char';   // 角色服 socket 在角色列表到达前死掉（切角半死路径）
          this.state = 'closed'; this.emit('disconnect');
          // 2026-09-21 xiezixing11 实录：RESTART→连上角色服→socket 8s 后死→state='closed'→
          // 编排器看门狗的 state==='char' 守卫失效 → 永久挂死。补发 charserver_fail 让编排器完整重登
          // （connectChar 的 3 次重试只管握手失败，不管"连上之后死掉"）
          if (charDied) this.emit('charserver_fail');
        }
      });
      this.ws.on('message', (data) => this.onData(data));
    });
  }

  send(buf, opts = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('socket 未连接');
    if (!opts.plain) this.crypt.process(buf); // 部分定制封包（如 0x00F7 重启）服务器按明文读，跳过加密
    this.dump('send', buf);
    this.ws.send(buf);
  }

  // 干净退出的真值序列（2026-09 浏览器抓包实证，网页"回到人物选择界面"）：
  //   C>S 0x00B2 type=1（流式加密） → S>C 0x00B3 type=1 → 客户端静默关闭地图 socket
  //   全程不发 0x018A/REQ_DISCONNECT；服务器在 0x00B2/0x00B3 握手时即释放角色（不进离线模式）
  sendRestart() {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN && this.sockTag === 'zone') {
        const w = new (require('./binary').BinaryWriter)(3);
        w.writeShort(0x00B2); w.writeUChar(1);
        this.send(w.buffer);
        this.log('→ 已发 RESTART (0x00B2 type=1，真值退出序列)');
        return true;
      }
    } catch (_) {}
    return false;
  }

  // 优雅退出：RESTART 握手（等 0x00B3，至多 2.5s）→ 关全部 socket。进程退出前调用
  async quitClean() {
    if (this.state === 'zone' && this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.sendRestart();
      await new Promise((resolve) => {
        const done = () => { clearTimeout(t); this.removeListener('restart_ack', done); resolve(); };
        const t = setTimeout(done, 2500);
        this.once('restart_ack', done);
      });
    }
    this.closeAllSockets();
    this.state = 'closed';
    await new Promise((r) => setTimeout(r, 300));
  }

  close() {
    // 旧式关闭（保留兼容）：地图连接用 RESTART 释放，其余直接关
    this.sendRestart();
    this.state = 'closed';
    clearInterval(this.keepAliveTimer);
    setTimeout(() => { try { this.ws && this.ws.close(); } catch (_) {} }, 2000);
  }

  // ---------- 收包解析循环 ----------
  onData(data) {
    if (process.env.RO_SAVE_FRAMES) {
      this.frameNo = (this.frameNo || 0) + 1;
      try { require('fs').writeFileSync(`/tmp/roframe_${this.sockTag}_${String(this.frameNo).padStart(3, '0')}.bin`, data); } catch (_) {}
    }
    if (this.verbosity) this.dump(`recv-${this.sockTag}`, data);
    this._frames = this._frames || [];
    this._frames.push(data);
    if (this._frames.length > 40) this._frames.splice(0, 10);
    let buf = this.half ? Buffer.concat([this.half, data]) : data;
    this.half = null;
    let off = 0;
    this._trace = this._trace || [];   // 封包边界轨迹（错位诊断用）
    while (off + 2 <= buf.length) {
      // V6 定制：角色服回 4 字节 AID 回声、地图服回 4 字节 GID 回声（非标准封包，直接跳过）
      const expectEcho = this.sockTag === 'char' ? this.session.AID : this.sockTag === 'zone' ? this.session.GID : 0;
      if (expectEcho && off === 0 && buf.length >= 4 && buf.readUInt32LE(0) === expectEcho) {
        this.log(`(跳过 ${this.sockTag} 回声 ${expectEcho})`);
        buf = buf.slice(4); this.half = null;
        continue;
      }
      const pid = buf.readUInt16LE(off);
      let size = sizeOf(pid);
      if (size === null || size === 0) { // 未知/零长度：继续解析不安全，丢弃本帧剩余（避免死循环）
        this.warn(`未知封包 0x${pid.toString(16).padStart(4, '0')}，剩余 ${buf.length - off} 字节，跳过`);
        try {
          require('fs').writeFileSync('/tmp/ro_desync.bin', buf.slice(Math.max(0, off - 120), off + 60));
          require('fs').writeFileSync('/tmp/ro_desync_trace.txt',
            this._trace.map(t => `${t[0]} off=${t[1]} pid=0x${t[2].toString(16)} size=${t[3]}`).join('\n') + `\nDESYNC at off=${off} remaining=${buf.length - off}\n`);
        } catch (_) {}
        this.emit('stream_error', { pid });
        return;
      }
      if (size < 0) {
        if (off + 4 > buf.length) break;
        size = buf.readUInt16LE(off + 2);
      }
      if (off + size > buf.length) break; // 半包，等下一帧
      const pkt = buf.slice(off, off + size);
      this._trace.push([this.sockTag, off, pid, size]);
      if (this._trace.length > 300) this._trace.splice(0, 100);
      this.handlePacket(pid, pkt);
      off += size;
    }
    if (off < buf.length) {
      this.half = buf.slice(off);
      if (this.verbosity || process.env.RO_SAVE_RAW) {
        this.warn(`半包缓存 ${this.half.length} 字节: ${this.half.slice(0, 32).toString('hex')}`);
        try { require('fs').writeFileSync('/tmp/ro_half.bin', this.half); } catch (_) {}
      }
    }
  }

  // ---------- 封包分发 ----------
  handlePacket(pid, pkt) {
    if (this.verbosity >= 2 || process.env.RO_SAVE_RAW) {
      try { require('fs').writeFileSync(`/tmp/ro_pkt_0x${pid.toString(16).padStart(4, '0')}.bin`, pkt); } catch (_) {}
    }
    try {
      this.dispatch(pid, pkt);
    } catch (e) {
      this.warn(`封包 0x${pid.toString(16).padStart(4, '0')} ${pkt.length}B 解析出错（已跳过）: ${e.message} | raw=${pkt.slice(0, 48).toString('hex')}`);
    }
  }

  dispatch(pid, pkt) {
    this.packetCounts = this.packetCounts || {};
    this.packetCounts[pid] = (this.packetCounts[pid] || 0) + 1;
    const r = new BinaryReader(pkt);
    const id = r.readUShort(); // 跳过 ID 头
    if (SIZES[String(pid)] < 0) r.readUShort(); // 变长封包还要跳过 2 字节长度域
    const emit = (name, obj) => this.emit(name, obj);
    switch (pid) {
      // ===== 登录服务器 =====
      case 0x0069: { // AC.ACCEPT_LOGIN（登录服：角色服务器列表）；角色服上 0x0069 是旧式角色列表
        if (this.sockTag !== 'login') { // HC.ACCEPT_ENTER
          const p = { TotalSlotNum: 0, chars: [] };
          p.chars = parseCharBlocks(r);
          emit('char_list', p); return;
        }
        const p = { AuthCode: r.readLong(), AID: r.readULong(), userLevel: r.readULong(), lastLoginIP: r.readULong(), lastLoginTime: r.readBinaryString(26), Sex: r.readUChar(), ServerList: [] };
        while (r.rest >= 32) {
          p.ServerList.push({
            ip: r.readULong(), port: r.readUShort(), name: r.readString(20),
            usercount: r.readUShort(), state: r.readUShort(), property: r.readUShort(),
          });
        }
        this.session = { AID: p.AID, AuthCode: p.AuthCode, userLevel: p.userLevel, sex: p.Sex };
        const ipStr = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
        p.ServerList.forEach((s) => (s.ipStr = ipStr(s.ip)));
        emit('login_ok', p); return;
      }
      case 0x006A: { // AC.REFUSE_LOGIN
        const p = { ErrorCode: r.readUChar(), blockDate: r.readBinaryString(20), from: this.sockTag };
        this.warn(`登录被拒绝 code=${p.ErrorCode} (${this.sockTag})`);
        emit('login_refuse', p); return;
      }
      case 0x0AC4: { // AC.ACCEPT_LOGIN3（2021 格式登录成功，160 字节服务器条目）
        const p = { AuthCode: r.readULong(), AID: r.readULong(), userLevel: r.readULong(), lastLoginIP: r.readULong(), lastLoginTime: r.readBinaryString(24), unknown: r.readShort(), Sex: r.readUChar(), AuthToken: r.readBinaryString(17), ServerList: [] };
        while (r.rest >= 160) {
          p.ServerList.push({
            ip: r.readULong(), port: r.readUShort(), name: r.readString(20),
            usercount: r.readUShort(), state: r.readUShort(), property: r.readUShort(),
            unknown: r.readBinaryString(128),
          });
        }
        this.session = { AID: p.AID, AuthCode: p.AuthCode, userLevel: p.userLevel, sex: p.Sex, token: p.AuthToken };
        const ipStr = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join('.');
        p.ServerList.forEach((s) => (s.ipStr = ipStr(s.ip)));
        emit('login_ok', p); return;
      }
      case 0x083E: { // AC.REFUSE_LOGIN_R2
        emit('login_refuse', { ErrorCode: r.readLong() }); return;
      }

      // ===== 角色服务器 =====
      case 0x082D: { // HC.ACCEPT_ENTER_NEO_UNION_HEADER（仅头 29 字节：槽位信息，无角色数据）
        const p = { TotalSlotNum: r.readUChar(), PremiumStartSlot: r.readUChar(), PremiumEndSlot: r.readUChar(), dummy1: r.readChar(), code: r.readChar() };
        r.seek(20, 1);
        emit('char_slots', p); return;
      }
      case 0x006B:   // HC.ACCEPT_ENTER_NEO_UNION（角色列表：头部大小因服务器而异，自动探测块起点）
      case 0x099D: { // NEO_UNION 列表
        const p = { TotalSlotNum: r.readUChar(), PremiumStartSlot: r.readUChar(), PremiumEndSlot: r.readUChar(), dummy: r.readChar(), code: r.readLong(), time1: r.readULong(), time2: r.readULong(), dummy2: r.readChar(), chars: [] };
        // V6 服头部有额外字节：扫描 17..40 字节处，找剩余长度能被 175 整除且首字段像 GID 的位置
        let start = r.tell();
        for (let probe = r.tell(); probe <= r.tell() + 16; probe++) {
          const rest = pkt.length - probe;
          if (rest > 0 && rest % 175 === 0 && pkt.readUInt32LE(probe) < 100000000) { start = probe; break; }
        }
        const r2 = new BinaryReader(pkt); r2.seek(start);
        p.chars = parseCharBlocks(r2);
        emit('char_list', p); return;
      }
      case 0x006C: { // HC.REFUSE_SELECTCHAR/ENTER（重入被拒：角色还在下线中，须延迟重试）
        let code = 0;
        try { code = r.readUShort(); } catch (_) { try { code = r.readUChar(); } catch (_2) {} }
        this.log(`⚠ 角色服重入被拒 (0x006C code=${code})`);
        emit('char_refuse', { code, from: this.sockTag }); return;
      }
      case 0x006D:   // HC.ACCEPT_MAKECHAR（老 ID，变长）
      case 0x0B6F: { // HC.ACCEPT_MAKECHAR（本服实际使用的新 ID，变长：内含 1 个角色块）
        if (process.env.RO_SAVE_RAW) { try { require('fs').writeFileSync(`/tmp/ro_makechar_0x${pid.toString(16)}.bin`, pkt); } catch (_) {} }
        const r2 = new BinaryReader(pkt);
        let start = 2;
        if (SIZES[String(pid)] < 0) start = 4; // 变长：跳过 u16 长度域
        for (let probe = start; probe <= start + 16 && probe < pkt.length; probe++) {
          const rest = pkt.length - probe;
          if (rest > 0 && rest % 175 === 0 && pkt.readUInt32LE(probe) < 100000000) { start = probe; break; }
        }
        const r3 = new BinaryReader(pkt); r3.seek(start);
        const ch = parseCharBlocks(r3)[0] || null;
        this.log(`🐣 建角成功: ${ch ? `${ch.name} (slot ${ch.CharNum})` : `(块解析失败 len=${pkt.length})`}`);
        emit('char_created', { char: ch }); return;
      }
      case 0x006E: { // HC.REFUSE_MAKECHAR（建角被拒：0=名字非法/重复 2=槽位异常 3=角色已满…）
        const p = { code: r.readUChar() };
        this.warn(`建角被拒 (0x006E code=${p.code})`);
        emit('char_refuse_create', p); return;
      }
      case 0x09A0: emit('charlist_notify', { TotalCnt: r.readLong(), charSlots: r.readLong() }); return;
      case 0x08B9: { // HC.SECOND_PASSWD_LOGIN（PIN 询问，本服不强制，忽略）
        emit('pin_request', { seed: r.readULong(), AID: r.readULong(), state: r.readUShort() }); return;
      }
      case 0x0071: { // HC.NOTIFY_ZONESVR
        const p = { GID: r.readULong(), mapName: r.readBinaryString(16).replace(/\0.*$/, ''), ip: r.readULong(), port: r.readUShort() };
        p.ipStr = [p.ip & 255, (p.ip >>> 8) & 255, (p.ip >>> 16) & 255, (p.ip >>> 24) & 255].join('.');
        this.session.GID = p.GID;
        this.mapName = p.mapName;
        emit('zone_info', p); return;
      }
      case 0x0AC5: { // HC.NOTIFY_ZONESVR2
        const p = { GID: r.readULong(), mapName: r.readBinaryString(16).replace(/\0.*$/, ''), ip: r.readULong(), port: r.readUShort(), unknown: r.readBinaryString(128) };
        p.ipStr = [p.ip & 255, (p.ip >>> 8) & 255, (p.ip >>> 16) & 255, (p.ip >>> 24) & 255].join('.');
        this.session.GID = p.GID;
        this.mapName = p.mapName;
        emit('zone_info', p); return;
      }

      // ===== 地图服务器 =====
      case 0x02EB:   // ZC.ACCEPT_ENTER2
      case 0x0A18: { // ZC.ACCEPT_ENTER3
        const p = { startTime: r.readULong(), pos: r.readPos(), xSize: r.readUChar(), ySize: r.readUChar(), font: r.readShort(), sex: pid === 0x0A18 ? r.readUChar() : undefined };
        this.position = p.pos;
        emit('map_enter', p); return;
      }
      case 0x0074: emit('server_time', { time: r.readULong() }); return; // ZC.NOTIFY_TIME
      case 0x0087: { // ZC.NOTIFY_PLAYERMOVE（自己移动确认）
        const p = { moveStartTime: r.readULong(), move: r.readPos2() };
        this.position = [p.move[2], p.move[3], 0];
        if (this.verbosity || process.env.RO_TRACE) this.log(`🏃 移动确认 (${p.move[0]},${p.move[1]})→(${p.move[2]},${p.move[3]})`);
        emit('self_move', p); return;
      }
      case 0x0081: { // SC.NOTIFY_BAN（被踢）
        const code = r.readUChar();
        this.warn(`被服务器断开 NOTIFY_BAN code=${code}`);
        emit('banned', { code }); this.close(); return;
      }
      case 0x018B: { // ZC.ACK_REQ_DISCONNECT（服务器确认退出：result 0=可以断开 1=需等10秒）
        const p = { result: r.readUShort() };
        this.log(`← 退出确认 (result=${p.result}${p.result === 0 ? '，角色已释放' : '，需等10秒'})`);
        emit('quit_ack', p); return;
      }
      case 0x00B3: { // ZC.RESTART_ACK（3字节：type u8，1=同意回选角）—— 真实抓包实证
        const p = { code: r.readUChar() };
        this.log(`↩ 重启应答 type=${p.code}${p.code ? '（同意）' : '（拒绝）'}`);
        emit('restart_ack', p); return;
      }
      case 0x013A: emit('restart_ack2', {}); return; // 旧 ID，V6 未用

      // ===== 实体 =====
      case 0x09FE: { // ZC.NOTIFY_STANDENTRY9（传送/飞艇落地的站立实体进入——飞来的买家走这个包，2026-09-21 实证漏解析=商人看不到飞来的买家）
        const p = parseNewEntry9(r);
        this.entities.set(p.GID, p);
        emit('entity', p); return;
      }
      case 0x09FF: { // ZC.NOTIFY_NEWENTRY9（V6 实际使用的实体进入包，2021 格式）
        const p = parseNewEntry9(r);
        this.entities.set(p.GID, p);
        emit('entity', p); return;
      }
      case 0x007C: { // ZC.NOTIFY_STANDENTRY_NPC（旧式 NPC）
        const p = { objecttype: r.readUChar(), GID: r.readULong(), speed: r.readShort(), bodyState: r.readShort(), healthState: r.readShort(), effectState: r.readShort(), head: r.readShort(), weapon: r.readShort(), accessory: r.readShort(), job: r.readShort(), shield: r.readShort(), accessory2: r.readShort(), accessory3: r.readShort(), headpalette: r.readShort(), bodypalette: r.readShort(), headDir: r.readShort(), isPKModeON: r.readUChar(), sex: r.readUChar(), pos: r.readPos(), xSize: r.readUChar(), ySize: r.readUChar() };
        p.kind = kindOf(p.objecttype);
        this.entities.set(p.GID, p);
        emit('entity', p); return;
      }
      case 0x02EF: case 0x022C: case 0x0236: case 0x02EE: { // ZC.NOTIFY_STANDENTRY*（旧式实体，本服未见但保留兼容）
        const p = { GID: r.readULong(), speed: r.readShort(), bodyState: r.readShort(), healthState: r.readShort(), effectState: r.readLong(), job: r.readShort(), head: r.readShort(), weapon: r.readLong(), pos: r.readPos(), kind: 'entity' };
        this.entities.set(p.GID, p);
        emit('entity', p); return;
      }
      case 0x0080: { // ZC.NOTIFY_VANISH（实体消失：1=死亡 2=离开视野 3=传送走）
        const p = { gid: r.readULong(), type: r.readUChar() };
        this.entities.delete(p.gid);
        emit('vanish', p); return;
      }
      case 0x008A:   // ZC.NOTIFY_ACT（老 ID）
      case 0x08C8: { // ZC.NOTIFY_ACT（本服攻击结果实际用的 ID，29B，V6 双 ID 绑定同包）
        const p = {
          GID: r.readULong(), targetGID: r.readULong(), startTime: r.readULong(),
          attackMT: r.readLong(), attackedMT: r.readLong(),
          damage: r.readShort(), count: r.readShort(), action: r.readUChar(), leftDamage: r.readShort(),
        };
        if (p.GID === this.session.GID) this.lastMyHit = { ...p, at: Date.now() };  // 自己攻击落地反馈
        emit('attack_notify', p); return;
      }
      case 0x0091: { // ZC.NPCACK_MAPMOVE（NPC 传送本图）
        const p = { mapName: r.readBinaryString(16).replace(/\0.*$/, ''), xPos: r.readShort(), yPos: r.readShort() };
        this.mapName = p.mapName;
        this.position = [p.xPos, p.yPos, 0];
        this.entities.clear(); // 旧图实体全部失效
        this.log(`⚡ 被传送: ${p.mapName} (${p.xPos},${p.yPos})`);
        emit('warp_map', p); return;
      }
      case 0x09FD: { // ZC.NOTIFY_MOVEENTRY（变长，9系列布局：NEWENTRY9 同构但 from/to 双坐标）
        const p = parseMoveEntry9(r);
        const okPos = p.pos && p.pos[0] > 2 && p.pos[1] > 2 && p.pos[0] < 500 && p.pos[1] < 500;
        const old = this.entities.get(p.GID);
        if (okPos) this.entities.set(p.GID, p);              // 坐标合法 → 整块刷新
        else if (old) { old.movedAt = Date.now(); }          // 坐标越界 → 保留旧坐标仅刷新时间（防污染）
        if (process.env.RO_TRACE) this.log(`🦶 #${p.job} (${(p.from||[])[0]},${(p.from||[])[1]})→(${(p.pos||[])[0]},${(p.pos||[])[1]})${okPos ? '' : ' ⚠越界已忽略'}`);
        emit('entity_move', p); return;
      }
      case 0x0092: { // ZC.NPCACK_SERVERMOVE（跨服传送）
        const p = { mapName: r.readBinaryString(16).replace(/\0.*$/, ''), xPos: r.readShort(), yPos: r.readShort(), ip: r.readULong(), port: r.readUShort() };
        p.ipStr = [p.ip & 255, (p.ip >>> 8) & 255, (p.ip >>> 16) & 255, (p.ip >>> 24) & 255].join('.');
        // 跨服传送必须立刻刷新 mapName/坐标（tur_dun03→morocc 实测：不刷则 waitMap 误判"到图失败"
        // 实际人已到达；旧图实体全部失效）
        this.mapName = p.mapName;
        this.position = [p.xPos, p.yPos, 0];
        this.entities.clear();
        emit('warp_server', p); return;
      }
      case 0x0095: case 0x0195: { // ZC.REQNAME_ACK / _2（名字查询结果）
        const p = pid === 0x0095
          ? { GID: r.readULong(), name: r.readString(24), party: r.readString(24), guild: r.readString(24), rank: r.readString(24) }
          : { GID: r.readULong(), name: r.readString(24) };
        const e = this.entities.get(p.GID);
        if (e) e.name = p.name;
        emit('name', p); return;
      }

      // ===== NPC 对话 =====
      case 0x00B4: { // ZC.SAY_DIALOG
        const p = { gid: r.readULong(), msg: r.readString() };
        this.lastSayText = p.msg;                     // 计算题题面可能随后跟 0x0142 输入框，留底
        this.dialog = { type: 'say', ...p };
        emit('dialog_say', p); return;
      }
      case 0x00B5: { // ZC.WAIT_DIALOG（有"下一步"）
        const p = { gid: r.readULong() };
        this.dialog = { type: 'wait', ...p };
        emit('dialog_wait', p); return;
      }
      case 0x00B6: { // ZC.CLOSE_DIALOG —— 必须回 0x0146 确认，否则服务器端对话卡住（走路会被判非法）
        const p = { gid: r.readULong() };
        this.dialog = { type: 'close', ...p };
        setTimeout(() => { try { this.send(BUILD.closeDialog(p.gid)); } catch (_) {} }, 250);
        emit('dialog_close', p); return;
      }
      case 0x00B7: { // ZC.MENU_LIST（":" 分隔菜单）
        const p = { gid: r.readULong(), msg: r.readString() };
        p.options = p.msg.split(':').filter(Boolean);
        this.dialog = { type: 'menu', ...p };
        emit('dialog_menu', p); return;
      }
      case 0x0142: { // ZC.OPEN_EDITDLG（NPC 数字输入框：防挂机计算题弹窗）
        const p = { NAID: r.readULong() };
        p.question = this.lastSayText || (this.dialog && this.dialog.msg) || '';
        this.dialog = { type: 'input', ...p };
        this.log(`🔢 弹出数字输入框 (NAID=${p.NAID}) 题面: ${(p.question || '').slice(0, 60)}`);
        emit('input_dialog', { ...p, kind: 'number' }); return;
      }
      case 0x01D4: { // ZC.OPEN_EDITDLGSTR（NPC 文字输入框）
        const p = { NAID: r.readULong() };
        this.dialog = { type: 'inputstr', ...p };
        emit('input_dialog', { ...p, kind: 'text' }); return;
      }
      case 0x025B: { // ZC.QUEST menu? —— 兜底日志
        emit('unknown', { pid, pkt }); return;
      }

      // ===== 状态 =====
      case 0x0088: { // ZC.NOTIFY_HP_TO_GROUPM（10B：AID u32 + hp i16 + maxhp i16，客户端源码实证）
        // 战斗中的 HP 即时同步流（pay_dun00 被围殴实录）——0x0ACB 只在升级/加点才发，
        // 死亡 hp=0 只走本包；不接入 stats 的话 isDead() 永远看到旧值（2026-09-22 死亡漏检根因）
        const p = { AID: r.readULong(), hp: r.readShort(), maxhp: r.readShort() };
        if (this.session && (p.AID === this.session.AID || p.AID === this.session.GID)) {
          this.stats = { ...(this.stats || {}), hp: p.hp, maxhp: p.maxhp };
          emit('hp', { value: p.hp, maxhp: p.maxhp });
        }
        return;
      }
      case 0x00B1: { // V6 定制参数更新（8B：type u16 + val i32）——type 0x14 = zeny 变更（2026-09-19 实证：购买瞬间下发新余额）
        const p = { type: r.readUShort(), val: r.readLong() };
        if (p.type === 0x14) {
          this.zeny = p.val;
          this.stats = { ...(this.stats || {}), zeny: p.val };
          emit('zeny', { value: p.val });
        }
        return;
      }
      case 0x00B0: { // ZC.PAR_CHANGE（血量/金钱等 8 字节属性；type 语义按 rAthena SP 表）
        const p = { type: r.readUShort(), val: r.readLong() };
        this._params = this._params || {};
        if (!(p.type in this._params)) {
          this._params[p.type] = p.val;
          if (Object.keys(this._params).length <= 30) this.log(`📊 SP[${p.type}] = ${p.val}`);
        }
        emit('sp_update', p);   // 通用属性事件（旧代码只发 hp，其余全被吞）
        // 注：type 24 = 当前负重×10（买空瓶重2 → +20 实证），25 = 最大负重×10，均非 zeny
        if (p.type === 12) emit('hp', { value: p.val });
        return;
      }
      case 0x0141: { // ZC.STATUS
        const p = { ID: r.readUChar(), isBase: r.readUChar(), val: r.readLong() };
        emit('param', p); return;
      }
      case 0x0ACB: { // ZC.UPDATE_EXP（V6 12B：SP类型 u16 + 值 u64；0x09=属性点 0x0b=BaseLv 0x0d..0x12=六维）
        const p = { type: r.readUShort(), value: r.readULong() }; r.seek(4, 1); // u64 高 32 位忽略
        const S = (this.stats = this.stats || {});
        const map = { 0x09: 'points', 0x0b: 'level', 0x0c: 'skpoint', 0x37: 'joblevel', 0x0d: 'str', 0x0e: 'agi', 0x0f: 'vit', 0x10: 'int', 0x11: 'dex', 0x12: 'luk', 0x14: 'zeny', 0x05: 'hp', 0x06: 'maxhp', 0x07: 'sp', 0x08: 'maxsp' };
        const key = map[p.type];
        if (key) S[key] = p.value;
        emit('stat_update', { key, type: p.type, value: p.value }); return;
      }
      case 0x00BD: { // ZC.STATUS（44B，2026-09-16 双猫抓包交叉验证）：
        //   ID(2) + point i16@2 + 六维×(当前值 u8 + 升下一级成本 u8)@4..15 + 尾部 28B(@16=joblevel?)
        //   成本与 statCost() 完全吻合：agi23→4、dex18→3、≤10→2（Lv17 猫实包验证）
        const p = { point: r.readShort(), cost: {} };
        for (const k of ['str', 'agi', 'vit', 'int', 'dex', 'luk']) {
          p[k] = r.readUChar();
          p.cost[k] = r.readUChar();
        }
        this.stats = { ...(this.stats || {}), points: p.point, str: p.str, agi: p.agi, vit: p.vit, int: p.int, dex: p.dex, luk: p.luk };
        this.log(`📊 属性同步: 点${p.point} Str${p.str} Agi${p.agi} Vit${p.vit} Int${p.int} Dex${p.dex} Luk${p.luk}`);
        emit('status_full', p); return;
      }
      case 0x00BC: { // ZC.STATUS_CHANGE_ACK（加点结果：statusID u16 + result u8 + 新值 u8）
        const p = { statusID: r.readUShort(), result: r.readUChar(), value: r.readUChar() };
        if (!p.result) this.warn(`加点失败 statusID=${p.statusID}（点数不足/超限）`);
        emit('status_change_ack', p); return;
      }
      case 0x00BE: { // ZC.STATUS_CHANGE（单项属性变化：statusID u16 + 新值 u8）
        const p = { statusID: r.readUShort(), value: r.readUChar() };
        const key = ({ 13: 'str', 14: 'agi', 15: 'vit', 16: 'int', 17: 'dex', 18: 'luk' })[p.statusID];
        if (key) { this.stats = this.stats || {}; this.stats[key] = p.value; }
        emit('stat_changed', { key, ...p }); return;
      }
      case 0x0AF1: { // ZC.NOTIFY_SETTARGET（内挂定向怪物列表服务器回执：mobid i32 + value u8）
        const p = { mobid: r.readLong(), value: r.readUChar() };
        this.log(`🎯 定向目标回执: mob#${p.mobid} ${p.value ? '已加入' : '已移除'}`);
        emit('onlytarget_ack', p); return;
      }
      case 0x0AF5: { // ZC.NOTIFY_LOADINFO（内挂全量设置：0=攻击距离 1=施法距离，其余为状态镜像；存 raw 供比对）
        const p = { pmdis: r.buf.readUInt8(2), mgdis: r.buf.readUInt8(3) };
        p.raw = r.buf.slice(2).toString('hex');
        this.log(`⚙ 内挂设置下发 (攻击距离${p.pmdis} 技能距离${p.mgdis})`);
        emit('bot_loadinfo', p); return;
      }
      case 0x0AF6: { // ZC.NOTIFY_RELOADINFOS（内挂单项设置推送：id u8 + value i32；34=自动攻击开关）
        const p = { id: r.readUChar(), value: r.readLong() };
        this.log(`⚙ 内挂设置[${p.id}] = ${p.value}`);
        emit('bot_setting', p); return;
      }
      case 0x01F4: { // ZC.REQ_EXCHANGE_ITEM2（V6 交易请求变体 32B：名24B + GID u32 + 等级 i16；客户端 hook 同一处理）
        const p = { name: r.readString(24).replace(/\0.*$/, '').trim(), GID: r.readULong(), level: r.readShort() };
        this.log(`🤝 ${p.name}(Lv${p.level}) 请求与你交易`);
        emit('trade_request', p); return;
      }
      case 0x01F5: { // ZC.ACK_EXCHANGE_ITEM2（9B：result + GID + 等级）——本服实证 result=3=对方接受窗开（rAthena 语义表不可信，2026-09-20 双向抓包）
        const p = { result: r.readUChar(), GID: r.readULong(), level: r.readShort() };
        const why = { 3: '对方接受，交易窗开', 4: '对方拒绝/取消', 0: '距离太远', 1: '对方不存在', 2: '对方已在交易中', 5: '对方离线挂机' }[p.result] || `code${p.result}`;   // 官方 UI 实证：ok=3 cancel=4（2026-09-21）
        this.log(`🤝 交易回执(2): ${why} (raw=${p.result}, GID=${p.GID}, lv=${p.level})`);
        emit('trade_ack', p); return;
      }
      case 0x0B42: { // ZC 交易对方窗内容同步（V6 定制，变长；对方锁定时与 0x00EC 同帧下发。真值 2026-09-20 双向抓包+实盘复核：
        // 条目 = ITID u16@0（0=zeny）+ ?u8@2 + amount u32@3 —— 284z / 500z 双例命中；物品条目 amount 语义未定仅记录）
        const body = pkt.slice(4);
        const ITID = body.length >= 2 ? body.readUInt16LE(0) : 0xffff;
        const amount = body.length >= 7 ? body.readUInt32LE(3) : 0;
        const zeny = ITID === 0 ? amount : 0;
        const items = ITID !== 0 && ITID !== 0xffff ? [{ ITID, count: amount }] : [];
        const p = { zeny, items, raw: body.toString('hex') };
        this.log(`🤝 对方窗同步 0x0B42: 数量=${amount}${ITID ? ` #${ITID}` : ''}（zeny 与物品数量共用此字段，按上下文判读）raw=${p.raw.slice(0, 24)}`);
        emit('trade_peer_sync', p); return;
      }
      case 0x0125: { // ZC 推车物品移出回执（index i16 + amount i32；配合 CZ 0x0127）
        const p = { index: r.readShort(), amount: r.readLong() };
        const ct = (this.cart || []).find((i) => i.index === p.index);
        if (ct) { ct.count -= p.amount; if (ct.count <= 0) this.cart = this.cart.filter((i) => i !== ct); }
        emit('cart_remove', p); return;
      }
      case 0x0B41: { // ZC 背包物品新增/更新（V6 变体：len u16 + index i16 + ITID u32 + flags；count 不在本包）
        const p = { index: r.buf.readInt16LE(4), ITID: r.buf.readUInt32LE(6) };
        emit('inv_item', p); return;
      }
      case 0x00E5: { // ZC.REQ_EXCHANGE_ITEM（对方请求交易；客户端真值 26B=仅对方名 24B）
        const p = { name: r.readString(24).replace(/\0.*$/, '').trim() };
        this.log(`🤝 ${p.name} 请求与你交易`);
        emit('trade_request', p); return;
      }
      case 0x00E7: { // ZC.ACK_EXCHANGE_ITEM（请求回执；真值 3B=仅 result）
        const p = { result: r.readUChar() };
        const why = ['对方接受，交易窗打开', '距离太远', '对方已在交易中', '交易被禁用', '繁忙', '对方拒绝'][p.result] || `code${p.result}`;
        this.log(`🤝 交易回执: ${why}`);
        emit('trade_ack', p); return;
      }
      case 0x00E9: { // ZC.ADD_EXCHANGE_ITEM（放入物品；真值 19B：who u8 + count i32 + ITID u16 + ident/damaged/refine u8×3 + 卡片 8B）
        const p = { who: r.readUChar(), count: r.readLong(), ITID: r.readUShort() };
        this.log(`🤝 交易窗: ${p.who ? '对方' : '我方'}放入 #${p.ITID} ×${p.count}`);
        emit('trade_item', p); return;
      }
      case 0x00EA: { // ZC.ACK_ADD_EXCHANGE_ITEM（5B：index i16 + result u8）
        const p = { index: r.readShort(), result: r.readUChar() };
        this.log(`🤝 放置回执 0x00EA: index=${p.index} result=${p.result}`);
        emit('trade_add_ack', p); return;
      }
      case 0x00EC: { // ZC.CONCLUDE_EXCHANGE_ITEM（对方/自己点锁定：who u8）
        const p = { who: r.readUChar() };
        this.log(`🤝 交易: ${p.who ? '对方' : '我方'}已锁定`);
        emit('trade_conclude', p); return;
      }
      case 0x00EE: { // ZC.CANCEL_EXCHANGE_ITEM（交易被取消）
        this.log('🤝 交易已取消');
        emit('trade_cancel', {}); return;
      }
      case 0x00F0: { // ZC.EXEC_EXCHANGE_ITEM（交易执行结果；真值 3B=result）
        const p = { result: r.readUChar() };
        this.log(`🤝 交易执行: result=${p.result}（0=成功）`);
        emit('trade_done', p); return;
      }
      case 0x00D0: { // ZC.ACK_WHISPER（密语回执：0=成功 其他=目标不存在/违规）
        const p = { result: r.readUChar() };
        this.log(p.result ? `⚠ 密语回执 result=${p.result}（目标不存在/被拒）` : `✅ 密语回执 result=0（已送达）`);
        emit('whisper_ack', p); return;
      }
      case 0x013C: { // ZC.NOTIFY_MAPPROPERTY（4 字节：id + u16）
        emit('map_property', { type: r.readUShort() }); return;
      }
      case 0x0AD5: { // ZC.SECOND_CHECK（V6 二级校验：seed + AID，须回 CHECK_BIN，否则后续动作被踢）
        const p = { pincode: r.readULong(), AID: r.readULong() };
        if (p.AID !== this.session.AID) {   // 防 错位 假包：AID 不符不回应
          this.warn(`二级校验 AID 不符 (${p.AID} ≠ ${this.session.AID})，忽略`);
          return;
        }
        const pin = autoPin(p.pincode, p.AID);
        this.log(`🔐 二级校验 seed=${p.pincode} → 回复 PIN=${pin}`);
        setTimeout(() => {
          try {
            this.send(BUILD.pinReport(p.AID, pin));
            // 注意：不再 converge —— 抓包实证服务器逐包流式解密（浏览器会话前 12 包全用流式掩码）
          } catch (_) {}
        }, 800);
        emit('second_check', p); return;
      }
      case 0x00C4: { // ZC.SELECT_DEALTYPE（商店 NPC：买/卖/取消）
        const p = { gid: r.readULong() };
        this.dialog = { type: 'shop', ...p };
        emit('shop_menu', p); return;
      }
      case 0x00C6: { // ZC.PC_PURCHASE_ITEMLIST（旧版购买列表）
        const p = { items: [] };
        while (r.rest >= 11) p.items.push({ price: r.readLong(), discount: r.readLong(), item: r.readUShort(), type: r.readUChar() });
        emit('shop_items', p); return;
      }
      case 0x0B7A:   // ZC.NPC_MARKET_OPEN（Market 型商店：19B/项，含 ITID/type/price/qty）
      case 0x0B77: { // ZC.PC_PURCHASE_ITEMLIST2（V6 商店商品列表，19 字节/项）
        const p = { items: [] };
        while (r.rest >= 19) {
          p.items.push({ ITID: r.readULong(), price: r.readULong(), discount: r.readULong(), type: r.readUChar(), wear: r.readUShort(), location: r.readULong() });
        }
        this.shopItems = p.items;
        emit('shop_items', p); return;
      }
      case 0x0B4E: { // ZC.NPC_MARKET_PURCHASE_RESULT（购买结果）
        const p = { rs: r.readUShort(), items: [] };
        while (r.rest >= 10) p.items.push({ ITID: r.readULong(), qty: r.readUShort(), price: r.readULong() });
        this.log(`🛍 购买结果 rs=${p.rs}: ` + p.items.map((it) => `#${it.ITID}×${it.qty}(${it.price}z)`).join(', '));
        emit('purchase_result', p); return;
      }
      case 0x008E: { // ZC.NOTIFY_PLAYERCHAT（服务器/系统消息，聊天命令反馈）
        const p = { msg: r.readString() };
        this.log(`📨 ${p.msg.replace(/\^([0-9a-fA-F]{6})/g, '')}`);
        emit('server_msg', p); return;
      }
      case 0x09DE: { // ZC.WHISPER（变长，V6 真实密语 ID=0x09DE；布局 sGID u32 + sender 24B + isAdmin u8(可省) + msg GBK）
        const p = { sGID: r.readULong(), from: r.readString(24) };
        let admin = null;
        try { admin = r.readUChar(); } catch (_) {}
        if (admin === 0 || admin === 1) { p.isAdmin = admin; }
        else r.seek(-1, 1); // isAdmin 域不存在：回退一个字节再读消息
        p.msg = r.readString();
        this.log(`💬 [${p.from}] ${p.msg.replace(/\^([0-9a-fA-F]{6})/g, '')}`);
        emit('whisper_recv', p); return;
      }
      case 0x009A: { // ZC.BROADCAST（全服广播）
        const p = { color: r.readULong(), msg: r.readString() };
        emit('broadcast', p); return;
      }
      case 0x009C: emit('dir_change', { gid: r.readULong() }); return; // ZC.CHANGE_DIRECTION 广播
      case 0x010F: { // ZC.SKILLINFO_LIST（技能列表 37B/项，含 GBK 技能名）
        const skills = [];
        while (r.rest >= 37) {
          skills.push({
            SKID: r.readShort(), type: r.readLong(), level: r.readShort(), spcost: r.readShort(),
            attackRange: r.readShort(), name: r.readString(24), upgradable: r.readChar(),
          });
        }
        this.skills = skills;
        emit('skill_list', skills); return;
      }
      case 0x010E: { // ZC.SKILLINFO_UPDATE（技能升级回执 11B：skillID u16 + lv/sp/range u16 + up u8）
        const p = { SKID: r.readShort(), level: r.readShort(), spcost: r.readShort(), attackRange: r.readShort(), upgradable: r.readUChar() };
        const s = (this.skills || []).find((x) => x.SKID === p.SKID);
        if (s) { s.level = p.level; s.spcost = p.spcost; s.upgradable = p.upgradable; }
        else this.skills = [...(this.skills || []), p];
        emit('skill_up_ack', p); return;
      }
      // V6 内挂技能列表四件套（2026-09-19 从客户端 bundle 实证 PID，37B/项与 0x010F 同构）：
      //   0x0AD1=主动(ATTACK) 0x0AD2=辅助(ADDIS) 0x0AD3=触发(TOUCH) 0x0AD4=解围(QOATTACK)
      case 0x0AD1: case 0x0AD2: case 0x0AD3: case 0x0AD4: {
        const skills = [];
        while (r.rest >= 37) {
          skills.push({
            SKID: r.readShort(), type: r.readLong(), level: r.readShort(), spcost: r.readShort(),
            attackRange: r.readShort(), name: r.readString(24), upgradable: r.readChar(),
          });
        }
        const slot = { 0x0AD1: 'attack', 0x0AD2: 'support', 0x0AD3: 'trigger', 0x0AD4: 'rescue' }[pid];
        this.botSkills = this.botSkills || {};
        this.botSkills[slot] = skills;
        this.log(`📚 内挂${{ attack: '主动', support: '辅助', trigger: '触发', rescue: '解围' }[slot]}技能列表 ${skills.length} 项: ` +
          skills.slice(0, 10).map((s) => `#${s.SKID}:${(s.name || '').trim()}`).join(' '));
        emit('bot_skill_list', { slot, skills }); return;
      }
      case 0x0B20: { // ZC.HORTCUT_KEY_LIST（快捷栏 38 格）
        const p = { rotate: r.readUChar(), tab: r.readShort(), keys: [] };
        for (let i = 0; i < 38; i++) p.keys.push({ isSkill: r.readChar(), ID: r.readULong(), count: r.readShort() });
        this.shortcuts = p;
        emit('shortcuts', p); return;
      }
      case 0x01F0: { // ZC.STORE_NORMAL_ITEMLIST2（推车列表 V6 变体，18B/项，客户端源码真值）
        const p = { items: [], raw: pkt.slice(0, 40).toString('hex') };
        try { r.readShort(); while (r.rest >= 18) { p.items.push({ index: r.readShort(), ITID: r.readUShort(), type: r.readUChar(), IsIdentified: r.readUChar(), count: r.readShort(), WearState: r.readUShort(), card1: r.readUShort(), card2: r.readUShort(), card3: r.readUShort(), card4: r.readUShort() }); } } catch (_) {}
        this.cart = p.items;
        this.log(`🛒 推车同步(0x01F0): ${p.items.length} 件 raw=${p.raw}`);
        emit('cart', p); return;
      }
      case 0x00A5: { // ZC.STORE_NORMAL_ITEMLIST（推车物品列表，变长：10B/项，客户端源码真值）
        const p = { items: [], raw: pkt.slice(0, 40).toString('hex') };
        try { r.readShort(); while (r.rest >= 10) { p.items.push({ index: r.readShort(), ITID: r.readUShort(), type: r.readUChar(), IsIdentified: r.readUChar(), count: r.readShort(), WearState: r.readUShort() }); } } catch (_) {}
        this.cart = p.items;
        this.log(`🛒 推车同步: ${p.items.length} 件 raw=${p.raw}`);
        emit('cart', p); return;
      }
      case 0x02E8: { // ZC.NORMAL_ITEMLIST3（物品栏，22 字节/项：index ITID type ident count wear +4卡+日期）
        const items = [];
        while (r.rest >= 22) {
          const it = { index: r.readShort(), ITID: r.readUShort(), type: r.readUChar(), IsIdentified: r.readUChar(), count: r.readShort(), WearState: r.readUShort() };
          r.seek(12, 1); // 4 张卡片(8) + HireExpireDate(4)
          items.push(it);
        }
        this.inventory = items;
        emit('inventory', items); return;
      }
      case 0x011C: { // ZC.WARPLIST（瞬间移动技能地图列表：SKID + 4×16 字节图名）
        const p = { SKID: r.readUShort(), mapName: [] };
        for (let i = 0; i < 4; i++) p.mapName.push(r.readBinaryString(16).replace(/\0.*$/, ''));
        this.warpList = p;
        this.log(`🌀 WARPLIST SKID=${p.SKID}: ${p.mapName.filter(Boolean).join(', ')}`);
        emit('warp_list', p); return;
      }
      case 0x0ABE: { // ZC.WARPLIST2（变长地图列表）
        const p = { SKID: r.readUShort(), mapName: [] };
        while (r.rest >= 16) p.mapName.push(r.readBinaryString(16).replace(/\0.*$/, ''));
        this.warpList = p;
        this.log(`🌀 WARPLIST2 SKID=${p.SKID}: ${p.mapName.filter(Boolean).join(', ')}`);
        emit('warp_list', p); return;
      }
      case 0x0A4A: { // ZC.PRIVATE_AIRSHIP_RESPONSE（免费传送结果）
        const code = r.readLong();
        const msgs = { 2: '背包无传送卷轴/会员卡', 3: '该地图不支持传送（洞穴）', 4: '当前地图无法使用' };
        this.log(code === 0 || code === 1 ? `🚌 飞艇传送受理 (code=${code})` : `🚌 传送被拒 code=${code}: ${msgs[code] || '未知'}`);
        emit('airship_response', { code }); return;
      }
      case 0x0B09: { // ZC.INVENTORY_ITEMLIST（堆叠物品 34B/项；首字节 type：0=背包 1=手推车 2=仓库）
        const p = { type: r.readUChar(), items: [] };
        while (r.rest >= 34) {
          p.items.push({ index: r.readShort(), ITID: r.readULong(), type: r.readUChar(), count: r.readShort(), wear: r.readULong(), cards: [r.readULong(), r.readULong(), r.readULong(), r.readULong()] });
          r.seek(34 - 2 - 4 - 1 - 2 - 4 - 16, 1); // 剩余 HireExpireDate 等字段按 34 字节对齐
        }
        if (p.type === 2) {   // 仓库窗口：绝不覆盖背包
          this.storage = this.storage || {};
          this.storage.stackables = p.items;
          this.storage.open = true;
          emit('storage_list', { kind: 'stackable', items: p.items });
        } else if (p.type === 1) {   // 手推车：独立存储（2026-09-20 修复：此前覆盖背包导致背包物品"消失"）
          this.cart = p.items;
          this.log(`🛒 推车同步: ${p.items.length} 件`);
          emit('cart_list', p);
        } else {
          this.inventory = p.items;
          this.log(`🎒 物品栏同步: ${p.items.length} 件`);
          emit('inventory', p.items);
        }
        return;
      }
      case 0x0B39: { // ZC.INVENTORY_ITEMLIST_EQUIP（装备 68B/项，OpenKore type9 布局；type 字节分窗口）
        const p = { type: r.readUChar(), items: [] };
        while (r.rest >= 68) {
          const it = { index: r.readShort(), ITID: r.readULong(), type: r.readUChar(), typeEquip: r.readULong(), equipped: r.readULong() };
          it.cards = [r.readULong(), r.readULong(), r.readULong(), r.readULong()];
          it.expire = r.readLong();
          it.bindOnEquip = r.readShort(); it.sprite = r.readShort();
          it.numOptions = r.readUChar(); r.seek(25, 1);   // options 25B
          it.upgrade = r.readUChar(); it.grade = r.readUChar(); it.identified = r.readUChar();
          p.items.push(it);
        }
        if (p.type === 2) {
          this.storage = this.storage || {};
          this.storage.equips = p.items;
          this.storage.open = true;
          emit('storage_list', { kind: 'equip', items: p.items });
        } else {
          emit('inventory_equips', p.items);
        }
        return;
      }
      case 0x0B08: { // ZC.INVENTORY_START（新库存协议开窗：type 2=Storage + 窗口名）
        const p = { type: r.readUChar(), name: r.readString() };
        if (p.type === 2) {
          this.storage = this.storage || {};
          this.storage.open = true;
          emit('storage_open', p);
        }
        return;
      }
      case 0x0B0B: { // ZC.INVENTORY_END（type + flag）
        emit('inv_list_end', { type: r.readUChar(), flag: r.readUChar() });
        return;
      }
      case 0x0B44: { // ZC.ADD_ITEM_TO_STORE4（存入回执 58B：index u16 + amount u32 + ITID u32 + type/identified/broken u8×3 + 卡16B + 选项25B + 精炼/品级）
        const p = { index: r.readShort(), amount: r.readULong(), ITID: r.readULong(), type: r.readUChar(), identified: r.readUChar(), broken: r.readUChar() };
        r.seek(16 + 25, 1);
        p.upgrade = r.readUChar(); p.grade = r.readUChar();
        this.storage = this.storage || {};
        this.storage.stackables = this.storage.stackables || [];
        this.storage.stackables.push(p);   // 简单追加（按 index 去重交给上层）
        emit('storage_added', p); return;
      }
      case 0x00F2: { // ZC.NOTIFY_STOREITEM_COUNTINFO（仓库容量：当前 u16 + 上限 u16）
        const p = { count: r.readUShort(), max: r.readUShort() };
        this.storage = this.storage || {};
        this.storage.count = p.count; this.storage.max = p.max; this.storage.open = true;
        emit('storage_count', p); return;
      }
      case 0x00F6: { // ZC.DELETE_ITEM_FROM_STORE（取出回执：index u16 + amount u32）
        const p = { index: r.readShort(), amount: r.readULong() };
        emit('storage_removed', p); return;
      }
      case 0x00F8: { // ZC.CLOSE_STORE（仓库已关闭）
        if (this.storage) this.storage.open = false;
        emit('storage_closed', {}); return;
      }
      case 0x02C1: { // ZC.NPC_CHAT（NPC 环境喊话/任务 NPC 回应）
        const p = { accountID: r.readULong(), color: r.readULong(), msg: r.readString() };
        this.log(`🗣 NPC喊话: ${p.msg.replace(/\^([0-9a-fA-F]{6})/g, '').slice(0, 70)}`);
        emit('npc_chat', p); return;
      }
      case 0x02D0: emit('config_state', {}); return; // ZC.CONFIG（忽略）
      case 0x022B: { // ZC.AID（进入后服务器广播自己的 GID）
        emit('self_gid', { GID: r.readULong() }); return;
      }
      case 0x02C4: emit('hackshield', { pkt }); return;
    }
    // 未识别封包：交易段（0x00E5-0x00F1 / 0x01F3-0x01F6）无条件打印——放钱/开窗事件可能藏在其中，其余仍按冗余度
    const tradeRange = (pid >= 0x00E5 && pid <= 0x00F1) || (pid >= 0x01F3 && pid <= 0x01F6);
    if (this.verbosity || tradeRange) this.warn(`未处理封包 0x${pid.toString(16).padStart(4, '0')} (${SIZES[String(pid)]}) ${pkt.slice(0, 24).toString('hex')}`);
    this.emit('packet', { pid, pkt });
  }

  // 关闭并清理所有现存 socket（重登/挤号前必须调用，否则旧连接会累积成"重复登录"）
  closeAllSockets() {
    // 地图连接先发 RESTART（真值释放序列：0x00B2 type=1，服务器即刻释放角色，不进离线模式）
    if (this.isZone) this.sendRestart();
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.half = null;
    const socks = this._allSockets ? Array.from(this._allSockets) : [];
    if (this.ws && !socks.includes(this.ws)) socks.push(this.ws);
    // 给优雅退出封包 ~800ms 发出后再关 socket
    setTimeout(() => {
      socks.forEach((s) => {
        try {
          s.removeAllListeners();
          s.on('error', () => {}); // CONNECTING 状态 close 会异步抛 error，必须挂 noop 吸收
          s.close();
        } catch (_) {}
      });
    }, this.isZone ? 800 : 0);
    this._allSockets = new Set();
    this.ws = null;
    this.loginSock = null;
    this.isZone = false;
  }

  // 直接断线（不发 RESTART）：V6 服务器内挂模式的触发条件——
  // 玩家直接掉线才把角色转入服务器离线挂机；RESTART 握手=主动回选角，不触发（2026-09-17 用户实证）
  hardClose() {
    this.state = 'closed';
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    this.half = null;
    const socks = this._allSockets ? Array.from(this._allSockets) : [];
    if (this.ws && !socks.includes(this.ws)) socks.push(this.ws);
    socks.forEach((s) => {
      try {
        s.removeAllListeners();   // 不触发 disconnect 事件（调用方自行安排重连）
        s.on('error', () => {});
        s.close();
      } catch (_) {}
    });
    this._allSockets = new Set();
    this.ws = null;
    this.loginSock = null;
    this.isZone = false;
  }

  // ---------- 高层动作 ----------
  // V6 网页端登录门禁（2026-09-17 浏览器抓包实证）：
  //   点登录 → POST /?r=mg/check&nid=<ClientVer>（Login_debug[userid/user_pass] 表单体）→ 响应 "1" 放行
  //   → 连游戏 ws；连角色服时 POST /?r=mg/checkin&nid=<ClientVer> 回执
  // 直连 ws 暂未被强制校验，但按网页端同构复刻以对齐流量形态（RO_MGCHECK=0 可关）
  async mgCheck(kind, account, password) {
    const NID = { eden: 5, online: 3, edge: 4 }[this.line] || 5;
    const body = new URLSearchParams({ 'Login_debug[userid]': account, 'Login_debug[user_pass]': password }).toString();
    // 谎报出口 IP（实测后端信任 X-Forwarded-For / Client-IP，2026-09-17）：
    //   RO_FAKE_IP=1.2.3.4       全局固定 IP
    //   RO_FAKE_IP=auto          按账号哈希稳定生成——同一账号永远同一伪装 IP（跨会话不变，
    //                            在服务器日志里呈现为"一个正常的固定宽带用户"），不同账号互不相同
    const fake = process.env.RO_FAKE_IP || '';
    let ipHeaders = {};
    if (fake) {
      const ip = fake === 'auto' ? fakeIpForAccount(account) : fake;
      ipHeaders = { 'X-Forwarded-For': ip, 'Client-IP': ip };
    }
    try {
      const r = await fetch('https://post.lastro.cn/?r=mg/' + kind + '&nid=' + NID, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': 'https://post.lastro.cn',
          'Referer': 'https://post.lastro.cn/ro/api.html?70.8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          ...ipHeaders,
        },
        body,
      });
      const text = (await r.text()).trim();
      this.log(`🔐 mg/${kind} → HTTP ${r.status} "${text.slice(0, 60)}"${fake ? `（出口伪装 ${ipHeaders['X-Forwarded-For']}）` : ''}`);
      return text;
    } catch (e) { this.log(`⚠ mg/${kind} 请求失败: ${e.message}`); return null; }
  }

  async login(account, password, line) {
    account = account || this.account; password = password || this.password;
    this.account = account; this.password = password;   // mg/checkin（connectChar 时）需要
    const L = LINES[line || this.line];
    this.closeAllSockets(); // 重登前彻底清理旧连接（轮换挤号关键）
    this.packetCounts = {}; this.frameNo = 0;
    this.entities.clear();
    this._mgCheckinDone = false;
    // 网页端门禁：等 mg/check 放行再连 ws（失败重试 3 次；非 "1" 不硬阻断——服务器暂未强制）
    if (process.env.RO_MGCHECK !== '0') {
      for (let i = 0; i < 3; i++) {
        const r = await this.mgCheck('check', account, password);
        if (r === '1') break;
        if (i < 2) await new Promise((res) => setTimeout(res, 1500));
      }
    }
    this.state = 'connecting';
    await this.connectGateway(L.address, L.port, false);
    this.state = 'login';
    this.send(BUILD.exeHashCheck());
    this.send(BUILD.login(account, password));
  }

  async connectChar(ipStr, port) {
    this.state = 'char';
    this.emit('char_connect', { ip: ipStr, port });
    this.charServer = { ip: ipStr, port }; // 记住角色服地址，角色轮换时重连用
    this.loginSock = this.ws; // 记录登录 socket，等服务器关闭它（会话迁移完成）再选角
    // 网页端同构回执：连上角色服时发 mg/checkin（fire-and-forget，浏览器时序一致）
    if (process.env.RO_MGCHECK !== '0' && !this._mgCheckinDone && this.account) {
      this._mgCheckinDone = true;
      this.mgCheck('checkin', this.account, this.password).catch(() => {});
    }
    await this.connectGateway(ipStr, port, false);
    this.send(BUILD.chEnter(this.session.AID, this.session.AuthCode, this.session.userLevel, this.session.sex));
  }

  // 退回角色选择（2026-09 浏览器真值抓包实证）：
  // CZ.RESTART 0x00B2 type=1 经流式掩码加密后线上即 "f7 00 01"（第12包掩码0x0045 的 XOR 结果）
  // → 服务器回 ZC.RESTART_ACK 0x00B3 (type=1)
  // → 客户端自关全部 socket → ~1.5s 后重连角色服重发 CH.ENTER → 角色列表（秒级切换，不重登）
  restartToCharSelect() {
    const w = new (require('./binary').BinaryWriter)(3);
    w.writeShort(0x00B2); w.writeUChar(1); // 官方 CZ.RESTART type=1 = 返回角色选择
    this.send(w.buffer); // 正常流式掩码加密（抓包实证：第N包用第N个掩码，服务器逐包同步解密）
    this.restartPending = true;
    this.log('↩ 请求返回角色选择 (0x00B2 type=1, 流式加密)');
    let fired = false;
    const proceed = () => {
      if (fired || !this.restartPending || this.rotating !== true) return;
      fired = true;
      this.restartPending = false;
      // 关闭全部旧连接（地图/角色/登录），避免服务端判定账号重复在线（code=8）
      this.ws = null; this.loginSock = null;
      this.isZone = false;
      clearInterval(this.keepAliveTimer);
      (this._allSockets || []).forEach((s) => { try { s.removeAllListeners('close'); s.close(); } catch (_) {} });
      this._allSockets = new Set();
      this.entities.clear();
      // 重连角色服：瞬时网络抖动（如网关 wss 超时）自动重试 3 次；仍失败发 charserver_fail
      // 让编排器走完整重登恢复（旧代码只打日志 → worker 永久挂起，2026-09-19 xiezixing9 实测）
      setTimeout(async () => {
        for (let i = 0; i < 3; i++) {
          try {
            await this.connectChar(this.charServer.ip, this.charServer.port);
            return;
          } catch (e) {
            this.log(`重连角色服失败（第 ${i + 1}/3 次）: ${e.message}`);
            await new Promise((r) => setTimeout(r, 8000));
          }
        }
        this.emit('charserver_fail');
      }, 1500); // 与真实客户端节奏一致（抓包: 关闭→1.5s→重连）
    };
    this.once('restart_ack', (p) => { if (p && p.code) proceed(); });
    setTimeout(proceed, 2500);
  }

  // 等待登录 socket 被服务器关闭（浏览器抓包：选角前登录连接必然已断开）
  waitForLoginClose(timeoutMs = 8000) {
    return new Promise((resolve) => {
      const s = this.loginSock;
      if (!s || s.readyState === WebSocket.CLOSED) return resolve(false);
      const t = setTimeout(() => { try { s.removeListener('close', done); } catch (_) {} resolve(true); }, timeoutMs);
      const done = () => { clearTimeout(t); resolve(false); };
      s.on('close', done);
    });
  }

  async selectChar(slot, charMoney) {
    if (charMoney != null) { this.zeny = charMoney; this.stats = { ...(this.stats || {}), zeny: charMoney }; }
    // 复刻真实客户端：选角前关闭登录 socket（浏览器抓包 close#1 发生在选角前）
    const s = this.loginSock;
    if (s) {
      try { s.removeAllListeners(); s.close(); } catch (_) {}
      this.loginSock = null;
    }
    await new Promise((r) => setTimeout(r, 800));
    const w = new (require('./binary').BinaryWriter)(6);
    w.writeShort(0x0187); w.writeULong(this.session.AID);
    this.send(w.buffer);
    await new Promise((r) => setTimeout(r, 500));
    this.send(w.buffer); // 浏览器抓包：选角前发两次心跳
    await new Promise((r) => setTimeout(r, 500));
    this.send(BUILD.selectChar(slot));
  }

  async connectZone(ipStr, port) {
    this.state = 'zone';
    // 加密模式可由环境变量指定：RO_CRYPT=A|B|0（默认 B，已对真实客户端抓包验证）
    const mode = (process.env.RO_CRYPT || 'B').toUpperCase();
    if (mode === '0') { this.crypt.reset(); }
    else { this.crypt.setKeys(mode); }
    await this.connectGateway(ipStr, port, true);
    this.restartPending = false; // 新图会话开始，清掉旧的重启标记
    await new Promise((res) => setTimeout(res, parseInt(process.env.RO_ZONE_DELAY || '800', 10))); // 等角色服→地图服认证传播（新角色更慢）
    this.send(BUILD.czEnter(this.session.AID, this.session.GID, this.session.AuthCode, this.session.sex));
    // 注意：真实客户端 CZ.ENTER 后不立即发 REQUEST_TIME；心跳推迟到 15 秒后启动
    this.pingStart = Date.now();
    clearInterval(this.keepAliveTimer);
    setTimeout(() => {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = setInterval(() => {
        try {
          const t = new (require('./binary').BinaryWriter)(6);
          t.writeShort(0x0360); t.buf.writeUInt32LE((Date.now() - this.pingStart) >>> 0, 2);
          this.send(t.buffer);
        } catch (_) {}
      }, 15000);
      const t0 = new (require('./binary').BinaryWriter)(6);
      t0.writeShort(0x0360); t0.buf.writeUInt32LE((Date.now() - this.pingStart) >>> 0, 2);
      try { this.send(t0.buffer); } catch (_) {}
    }, 15000);
  }

  mapLoaded() {
    this.send(BUILD.actorInit());
    // 二级校验改为事件驱动（0x0AD5 到达时自动应答），此处不再盲发
  }
  walk(x, y) { this.send(BUILD.requestMove(x, y)); }
  attack(gid) { this.send(BUILD.requestAct(gid, 0)); }
  // 点击 NPC：CONTACTNPC（CHANGE_DIRECTION 在此服实测会引发断线，暂不连发）
  contactNpc(gid, npcPos) {
    void npcPos;
    this.send(BUILD.contactNpc(gid));
  }
  reqName(gid) { this.send(BUILD.reqName(gid)); }
  nextDialog(gid) { this.send(BUILD.nextScript(gid)); }
  closeDialog(gid) { this.send(BUILD.closeDialog(gid)); }
  chooseMenu(gid, num) { this.send(BUILD.chooseMenu(gid, num)); }
  chat(msg) {
    const name = this.session.charName || '';
    this.send(BUILD.requestChat(`${name} : ${msg}`));
  }
  // 免费飞艇传送：任意支持传送的地图坐标（需背包有 14527 传送卷轴或会员）
  airshipTeleport(map, x, y) { this.send(BUILD.airshipRequest(map, x, y)); }
  setAuto(id, on) { this.send(BUILD.notifyUpdateinfo(id, on ? 1 : 0)); } // 34攻击/35拾取/36进食
}

// 角色列表块解析（t=175 布局，与 PacketVerManager.parseCharInfo 一致）
function parseCharBlocks(r) {
  const blocks = [];
  const p = r.rest;
  if (p <= 0) return blocks;
  let t = 175;
  if (p % t !== 0) {
    const cand = [106, 108, 112, 116, 124, 128, 132, 136, 140, 144, 145, 147, 155, 175].filter((n) => p % n === 0);
    if (cand.length === 1) t = cand[0];
  }
  const n = Math.floor(p / t);
  for (let i = 0; i < n; i++) {
    const b = {};
    b.GID = r.readULong();
    b.exp = t > 155 ? Number(r.buf.readBigUInt64LE(r.tell())) : r.readLong(); r.seek(t > 155 ? 8 : 4, 1);
    b.money = r.readLong();
    b.jobexp = t > 155 ? Number(r.buf.readBigUInt64LE(r.tell())) : r.readLong(); r.seek(t > 155 ? 8 : 4, 1);
    b.joblevel = r.readLong();
    b.bodyState = r.readLong(); b.healthState = r.readLong(); b.effectState = r.readLong();
    b.virtue = r.readLong(); b.honor = r.readLong();
    b.jobpoint = r.readShort();
    if (t <= 112) { b.hp = r.readShort(); b.maxhp = r.readShort(); }
    else if (t < 175) { b.hp = r.readLong(); b.maxhp = r.readLong(); }
    else { b.hp = Number(r.buf.readBigUInt64LE(r.tell())); r.seek(8, 1); b.maxhp = Number(r.buf.readBigUInt64LE(r.tell())); r.seek(8, 1); }
    if (t < 175) { b.sp = r.readShort(); b.maxsp = r.readShort(); }
    else { b.sp = Number(r.buf.readBigUInt64LE(r.tell())); r.seek(8, 1); b.maxsp = Number(r.buf.readBigUInt64LE(r.tell())); r.seek(8, 1); }
    b.speed = r.readShort(); b.job = r.readShort(); b.head = r.readShort();
    if (t >= 147) b.body = r.readShort();
    b.weapon = r.readShort(); b.level = r.readShort(); b.sppoint = r.readShort();
    b.accessory = r.readShort(); b.shield = r.readShort(); b.accessory2 = r.readShort(); b.accessory3 = r.readShort();
    b.headpalette = r.readShort(); b.bodypalette = r.readShort();
    b.name = r.readString(24);
    b.Str = r.readUChar(); b.Agi = r.readUChar(); b.Vit = r.readUChar();
    b.Int = r.readUChar(); b.Dex = r.readUChar(); b.Luk = r.readUChar();
    if (t <= 108) { b.CharNum = r.readUShort(); }
    else if (t < 124) { b.CharNum = r.readUShort(); b.haircolor = r.readUShort(); }
    else { b.CharNum = r.readUChar(); b.haircolor = r.readUChar(); }
    if (t === 116) r.seek(4, 1);
    if (t >= 124) { b.bIsChangedCharName = r.readShort(); b.lastMap = r.readBinaryString(t === 124 ? 12 : 16); }
    if (t >= 132) b.DeleteDate = r.readLong();
    if (t >= 136) b.Robe = r.readLong();
    if (t >= 140) b.SlotAddon = r.readLong();
    if (t >= 144) b.RenameAddon = r.readLong();
    if (t >= 145) b.sex = r.readUChar();
    blocks.push(b);
  }
  return blocks;
}

// roBrowser EntityType：0=PC 1=WARP 5=MOB 6=NPC 7=PET 8=HOM 9=MERC 10=ELEM 11=ITEM 12=NPC2
function kindOf(t) {
  return ({ 0: 'pc', 1: 'warp', 5: 'mob', 6: 'npc', 7: 'pet', 8: 'hom', 9: 'merc', 10: 'elem', 11: 'item', 12: 'npc' })[t] || `type${t}`;
}

// V6 自动二级校验（Online_mn.js L 函数逐行对照）：
// PIN = AID 后 4 位，经 seed 打乱表映射为索引序列
function autoPin(seed, AID) {
  let c = seed;
  const d = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let e = 1; e < 10; e++) {
    c = 4 + 2 * c;
    const f = c % (e + 1);
    if (e !== f) { d[e] ^= d[f]; d[f] ^= d[e]; d[e] ^= d[f]; }
  }
  let out = '';
  const digits = String(AID).slice(-4);
  for (const ch of digits) {
    for (let j = 0; j < 10; j++) if (String(ch) === String(d[j])) out += j;
  }
  return out;
}

// ZC.NOTIFY_NEWENTRY9（0x09FF，2021/≥20180704 格式）
function parseNewEntry9(r) {
  return parseEntry9Base(r, false);
}

// ZC.NOTIFY_MOVEENTRY9（0x09FD，变长）：NEWENTRY9 同构，单坐标换成 from/to 双坐标
function parseMoveEntry9(r) {
  return parseEntry9Base(r, true);
}

function parseEntry9Base(r, isMove) {
  const b = {};
  b.objecttype = r.readUChar();
  b.GID = r.readULong(); b.AID = r.readULong();
  b.speed = r.readShort(); b.bodyState = r.readShort(); b.healthState = r.readShort();
  b.effectState = r.readLong(); b.job = r.readShort(); b.head = r.readShort();
  b.weapon = r.readULong(); b.shield = r.readULong();
  b.accessory = r.readUShort(); b.accessory2 = r.readUShort(); b.accessory3 = r.readUShort();
  b.headpalette = r.readShort(); b.bodypalette = r.readShort(); b.headDir = r.readShort();
  b.Robe = r.readShort(); b.GUID = r.readULong(); b.GEmblemVer = r.readShort();
  b.honor = r.readShort(); b.virtue = r.readLong();
  b.isPKModeON = r.readUChar(); b.sex = r.readUChar();
  if (isMove) { b.from = r.readPos(); b.pos = r.readPos(); }
  else { b.pos = r.readPos(); }
  b.xSize = r.readUChar(); b.ySize = r.readUChar(); b.state = r.readUChar();
  b.clevel = r.readShort(); b.font = r.readShort();
  b.maxhp = r.readLong(); b.hp = r.readLong();
  b.isBoss = r.readUChar(); b.body = r.readShort();
  b.name = r.readString(24);
  b.kind = kindOf(b.objecttype);
  b.movedAt = Date.now();
  return b;
}

// 按账号哈希稳定生成伪装 IP（家用宽带首段池）：同账号跨会话恒定，异账号互异
function fakeIpForAccount(account) {
  const h = crypto.createHash('md5').update(String(account || 'anon')).digest();
  const pools = [58, 61, 112, 117, 121, 171, 182, 219];
  return `${pools[h[0] % pools.length]}.${h[1]}.${h[2]}.${1 + (h[3] % 253)}`;
}

module.exports = { ROClient, sizeOf, fakeIpForAccount };
