'use strict';
/**
 * 可复用高层模块（组合层）
 * ============================================================
 * 把散落在 leveler.js / bounty-accept.js / bounty-run.js / market-scan.js
 * 里的通用流程抽成可复用模块：
 *
 *   LoginSession  —— 登录/挤号/断线自愈/优雅退出
 *   CharRotate    —— 12+ 角色轮换（RESTART 切角 / 失败跳过 / 进度记录）
 *   Navigator     —— 飞艇定位传送（含洞穴入口格 / 同图跳出 / 回退卷轴）
 *   NpcTalk       —— NPC 对话状态机（翻页/选单/商店购买/输入框）
 *
 * 全部基于 ROClient + Bot + BUILD 三个底层模块。
 */
const { BUILD } = require('./protocol');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================
// ① LoginSession —— 登录与连接自愈
// ============================================================
class LoginSession {
  /**
   * @param {ROClient} client
   * @param {object} opts { account, password, line, hangMs=12000, backoffMs }
   * @param {function} log 日志函数
   */
  constructor(client, opts = {}, log = console.log) {
    this.c = client;
    this.opts = Object.assign({ hangMs: 12000, backoff: { hang: 5 * 60e3, refuse8: 45e3, refuse: 15e3, disconnect: 90e3, banned: 8 * 60e3 } }, opts);
    this.log = log;
    this.seq = 0;              // 重登防并发
    this.timer = null;
    this.attempts = 0;
    this._wire();
  }

  /** 启动登录流程（幂等：重复调用会覆盖旧流程） */
  login() {
    clearTimeout(this.timer);
    const seq = ++this.seq;
    this.attempts++;
    this.log(`🔑 登录尝试 ${this.attempts}（${this.opts.account}@${this.opts.line}）`);
    // 挂起保护
    this.timer = setTimeout(() => {
      this.log('⚠ 登录挂起，退避重试');
      try { this.c.closeAllSockets(); } catch (_) {}
      this.relogin(this.opts.backoff.hang, '登录挂起');
    }, this.opts.hangMs);
    this.c.login(this.opts.account, this.opts.password, this.opts.line)
      .catch((e) => { clearTimeout(this.timer); this.relogin(15e3, '登录异常 ' + e.message); });
    return seq;
  }

  /** 计划重登（只有最新 seq 才会执行） */
  relogin(delayMs, reason) {
    const seq = ++this.seq;
    this.log(`🔄 ${reason}，${Math.round(delayMs / 1000)}s 后重试`);
    setTimeout(() => { if (seq === this.seq) this.login(); }, delayMs);
  }

  stop() { this.seq++; clearTimeout(this.timer); }

  _wire() {
    const c = this.c;
    c.on('login_ok', (p) => {
      this.seq++; clearTimeout(this.timer); this.attempts = 0; this._srvDown = 0;
      const srv = p.ServerList[0];
      if (!srv) { this.log('❌ 无角色服务器'); process.exit(1); }
      this.log(`✅ 登录成功 AID=${p.AID} → 角色服 ${srv.ipStr}:${srv.port}`);
      c.connectChar(srv.ipStr, srv.port).catch(() => this.relogin(10e3, '连角色服失败'));
    });
    c.on('login_refuse', (p) => {
      clearTimeout(this.timer);
      // code=1 疑似服务器宕机：出现两次后改为 10 分钟间隔循环探测（防频繁重登触发风控）
      if (p.ErrorCode === 1 || p.ErrorCode === 3) {
        this._srvDown = (this._srvDown || 0) + 1;
        if (this._srvDown >= 2) {
          this.log(`☢ code=${p.ErrorCode} ×${this._srvDown}：疑似服务器宕机，10 分钟后探测`);
          return this.relogin(10 * 60 * 1000, '服务器宕机探测');
        }
      }
      this.relogin(p.ErrorCode === 8 || p.ErrorCode === 2 ? this.opts.backoff.refuse8 : this.opts.backoff.refuse, `被拒 code=${p.ErrorCode}`);
    });
    c.on('disconnect', () => this.relogin(this.opts.backoff.disconnect, '连接断开'));
  }
}

// ============================================================
// ② CharRotate —— 角色轮换
// ============================================================
class CharRotate {
  /**
   * @param {ROClient} client
   * @param {object} opts { skipSlots:[0], maxEntryFails:3, switchGapMs:45000 }
   * @param {function} onChar  async (char) => 'done'|'skip' —— 每角色主流程
   * @param {function} log
   */
  constructor(client, opts = {}, onChar, log = console.log) {
    this.c = client;
    this.opts = Object.assign({ skipSlots: [0], maxEntryFails: 3, switchGapMs: 45000 }, opts);
    this.onChar = onChar;
    this.log = log;
    this.entryFails = {};
    this.doneSlots = new Set();
    this.rotating = false;
    this._wire();
  }

  _wire() {
    const c = this.c;
    c.on('char_list', (p) => this._pick(p.chars || []));
    c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => this._retry('连图失败')));
    c.on('char_refuse', () => this._retry('选角被拒'));
    c.on('banned', (p) => {
      if (this.rotating) return;
      if (this._cur) {
        this.entryFails[this._cur.CharNum] = (this.entryFails[this._cur.CharNum] || 0) + 1;
        const n = this.entryFails[this._cur.CharNum];
        this.log(`slot${this._cur.CharNum} ${this._cur.name} 进图失败×${n}${n >= this.opts.maxEntryFails ? '（跳过）' : ''}`);
        if (n >= this.opts.maxEntryFails) { this.doneSlots.add(this._cur.CharNum); this._cur = null; }
      }
      this._retry(`被踢 code=${p.code}`, 8 * 60e3);
    });
    c.on('map_enter', async (p) => {
      if (!this._cur) return;
      this.entryFails[this._cur.CharNum] = 0;
      this.log(`🏠 ${this._cur.name} 进图 ${this.c.mapName} @(${p.pos[0]},${p.pos[1]})`);
      setTimeout(() => { try { this.c.mapLoaded(); } catch (_) {} }, 500);
      setTimeout(async () => {
        try { await this.onChar(this._cur); } catch (e) { this.log('流程异常: ' + e.message); }
        this._next();
      }, 2500);
    });
  }

  _pick(chars) {
    if (!chars.length) { this.log('无角色'); process.exit(1); }
    const skip = new Set(this.opts.skipSlots);
    const next = chars.filter((ch) => !this.doneSlots.has(ch.CharNum) && !skip.has(ch.CharNum)
      && (this.entryFails[ch.CharNum] || 0) < this.opts.maxEntryFails)
      .sort((a, b) => a.CharNum - b.CharNum)[0];
    if (!next) return this.onAllDone && this.onAllDone(chars);
    this._cur = next;
    this.log(`[${this.doneSlots.size + 1}/${chars.length}] ${next.name} (slot${next.CharNum} Lv${next.level})`);
    this.c.session.charName = next.name;
    this.c.selectChar(next.CharNum);
  }

  _next() {
    if (this._cur) { this.doneSlots.add(this._cur.CharNum); this._cur = null; }
    this.rotating = true; this.c.rotating = true;
    setTimeout(() => {
      try { this.c.restartToCharSelect(); } catch (e) { this._retry('回选角失败', 30e3); }
      setTimeout(() => { this.rotating = false; }, 3000);
    }, this.opts.switchGapMs);
  }

  _retry(reason, delay = 30e3) {
    if (this.rotating) return;
    this.rotating = true;
    setTimeout(() => { this.rotating = false; this.c.login(); }, delay);
  }
}

// ============================================================
// ③ Navigator —— 飞艇定位传送
// ============================================================
class Navigator {
  /**
   * @param {ROClient} client
   * @param {Bot} bot
   * @param {object} opts { caveEntries: {map:{map,x,y}}, ensureScroll: async ()=>bool }
   */
  constructor(client, bot, opts = {}, log = console.log) {
    this.c = client; this.bot = bot;
    this.caveEntries = Object.assign({
      iz_dun00: { map: 'izlu2dun', x: 108, y: 83 },  // 海底洞窟1层 ← 柏伊亚岚岛传送格（实测）
    }, opts.caveEntries || {});
    this.ensureScroll = opts.ensureScroll || null;
    this.log = log;
  }

  async waitMap(m, ms = 15000) {
    for (let i = 0; i < ms / 500; i++) { await sleep(500); if ((this.c.mapName || '').includes(m)) return true; }
    return false;
  }

  /** 飞艇定位传送（支持洞穴入口格 / 同图先跳出） */
  async goto(map, x, y, cave = false) {
    const here = (this.c.mapName || '').replace(/\.gat$/i, '');
    if (here === map) { this.log(`已在 ${map}`); return true; }
    // 同图飞艇被忽略：先跳回中转站再飞目标
    const entry = cave ? this.caveEntries[map] : null;
    if (entry) {
      this.log(`🚌 飞艇 → ${entry.map} (${entry.x},${entry.y}) 踩入口格`);
      try { this.c.airshipTeleport(entry.map, entry.x, entry.y); } catch (_) { return false; }
      if (await this.waitMap(map, 12000)) { await sleep(3000); this._syncPos(); return true; }
      if (!(await this.waitMap(entry.map, 6000))) return false;
      this.log('入口格未触发，回退直飞', 'warn');
    }
    if (cave && this.ensureScroll && !(await this.ensureScroll())) { this.log('无卷轴，洞穴传送跳过', 'warn'); return false; }
    this.log(`🚌 飞艇 → ${map} (${x},${y})${cave ? '（卷轴）' : ''}`);
    try { this.c.airshipTeleport(map, x, y); } catch (e) { this.log('飞艇发送失败'); return false; }
    if (!(await this.waitMap(map))) { this.log(`到 ${map} 失败`); return false; }
    await sleep(3000);
    this._syncPos();
    return true;
  }

  /** 走到坐标（A* 直线分段巡路） */
  async walk(x, y, timeoutMs = 45000) {
    this.log(`🚶 巡路 → (${x},${y})`);
    await new Promise((res) => this.bot.walkSmart(x, y, () => res(), timeoutMs));
    await sleep(500);
  }

  _syncPos() { if (this.c.position) this.bot.updatePos(this.c.position[0], this.c.position[1]); }
}

// ============================================================
// ④ NpcTalk —— NPC 对话状态机
// ============================================================
class NpcTalk {
  /**
   * @param {ROClient} client
   * @param {Bot} bot
   */
  constructor(client, bot) {
    this.c = client; this.bot = bot;
  }

  /** 视野内找 NPC（名字优先，4 轮重试） */
  async find(re, rounds = 4) {
    for (let i = 0; i < rounds; i++) {
      const hit = [...this.c.entities.values()].find((e) => e.kind === 'npc' && re.test(e.name || ''));
      if (hit) return hit;
      [...this.c.entities.values()].filter((n) => n.kind === 'npc' && !n.name).forEach((n) => this.c.reqName(n.GID));
      await sleep(1500);
    }
    return [...this.c.entities.values()].find((e) => e.kind === 'npc' && re.test(e.name || ''));
  }

  /**
   * 对话流程
   * @param {object} npc 实体（含 GID/pos）
   * @param {function} picker (sayText, options[]) → 数字(1起) | 0(不选) | -1(关闭)
   * @param {object} hooks { onSay(text), timeoutSec=25 }
   */
  talk(npc, picker, hooks = {}) {
    return new Promise(async (resolve) => {
      let resolved = false, lastSay = '';
      const done = () => { if (resolved) return; resolved = true; cleanup(); setTimeout(resolve, 500); };
      const onSay = (p) => {
        const clean = (p.msg || '').replace(/\^[0-9a-fA-F]{6}/g, '').replace(/\s+/g, ' ').trim();
        if (!clean) return;
        lastSay = clean;
        hooks.onSay && hooks.onSay(clean);
      };
      const onMenu = (p) => {
        const choice = picker(lastSay, p.options);
        if (choice === -1) { setTimeout(() => { try { this.c.closeDialog(p.gid); } catch (_) {} }, 300); return; }
        if (choice > 0) setTimeout(() => { try { this.c.chooseMenu(p.gid, choice); } catch (_) {} }, 500);
        else setTimeout(() => { try { this.c.closeDialog(p.gid); } catch (_) {} }, 300);
      };
      const onWait = (p) => setTimeout(() => { try { this.c.nextDialog(p.gid); } catch (_) {} }, 1200);
      const onClose = () => done();
      const cleanup = () => {
        this.c.removeListener('dialog_say', onSay); this.c.removeListener('dialog_menu', onMenu);
        this.c.removeListener('dialog_wait', onWait); this.c.removeListener('dialog_close', onClose);
      };
      this.c.on('dialog_say', onSay); this.c.on('dialog_menu', onMenu);
      this.c.on('dialog_wait', onWait); this.c.on('dialog_close', onClose);
      setTimeout(done, (hooks.timeoutSec || 25) * 1000);
      // 原版真值（index.js questScenario 实测成功 2026-09-16）：
      // 走到 shop.pos+2,+1 → 立刻 bot.talkTo(GID) → contactNpc
      // 不加任何前置 reqName/changeDirection/sleep——过多延迟反而失败！
      try { this.bot.talkTo(npc.GID); } catch (_) { done(); }
    });
  }

  async _walkAdjacent(npc) {
    const { x, y } = { x: npc.pos[0] + 1, y: npc.pos[1] + 1 };
    await new Promise((res) => this.bot.walkSmart(x, y, () => res(), 15000));
    await sleep(500);
  }

  /** 通用选单：按 patterns 依次找，avoid 排除 */
  static pick(options, patterns, avoid = /取消|返回|关闭|结束|离开|谢谢|再见|刷新个人任务|放弃/) {
    for (const re of patterns) {
      const i = options.findIndex((o) => re.test(o) && !avoid.test(o));
      if (i >= 0) return i + 1;
    }
    return 0;
  }

  /** 商店购买（V6 真值流程，2026-09-16 wslog 解码）：
   *    contactNpc → 0x00C4 商店菜单 → 0x00C5(gid,0) 买 → 0x0B77 商品列表(19B/项)
   *    → 0x00C8 老式购买(item u16 + amount u16) → 0x00B0 结果
   */
  buy(npc, { match = (items) => items[items.length - 1], amount = 1, log = console.log } = {}) {
    return new Promise(async (resolve) => {
      let bought = false;
      const onMenu = (p) => {
        log(`  📋(商店菜单) ${(p.options||[]).join(' | ')}`);
        const ci = NpcTalk.pick(p.options, [/购买|商店|买/, /确定/]);
        if (ci) setTimeout(() => { try { this.c.send(BUILD.ackSelectDealtype(p.gid, 0)); } catch (_) {} }, 500);
        else setTimeout(() => { try { this.c.closeDialog(p.gid); } catch (_) {} }, 300);
      };
      const onItems = (p) => {
        const item = match(p.items || []);
        if (!item) { log('  未匹配到目标商品'); return; }
        log(`  🛒 选定 #${item.ITID} ${item.price || item.discount}z ×${amount}`);
        // V6 老式购买 0x00C8（wslog 真值）：item(u16) + amount(u16)
        const w = new (require('./binary').BinaryWriter)(6);
        w.writeShort(0x00C8);
        w.writeUShort(item.ITID); w.writeUShort(amount);
        setTimeout(() => { try { this.c.send(w.buffer); } catch (_) {} }, 600);
      };
      const onBuy = (p) => {
        if (p.rs === 0 || (p.items && p.items.length)) bought = true;
        log(bought ? '  ✅ 购买成功' : `  购买结果 rs=${p.rs}`);
        setTimeout(() => { try { this.c.send(BUILD.marketClose()); } catch (_) {} }, 600);
      };
      this.c.on('dialog_menu', onMenu); this.c.on('shop_items', onItems); this.c.on('purchase_result', onBuy);
      try { this.bot.talkTo(npc.GID); } catch (_) {}
      for (let i = 0; i < 36; i++) { await sleep(500); if (bought) break; }
      this.c.removeListener('dialog_menu', onMenu); this.c.removeListener('shop_items', onItems); this.c.removeListener('purchase_result', onBuy);
      resolve(bought);
    });
  }
}

module.exports = { LoginSession, CharRotate, Navigator, NpcTalk, sleep };
