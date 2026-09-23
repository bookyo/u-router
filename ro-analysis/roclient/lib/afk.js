'use strict';
/**
 * AFKBot —— 挂机保姆（2026-09-19）
 * ============================================================
 * 服务器内挂在角色死亡回城后不会自己回挂机图；本模块每小时挤号巡视：
 *   1. 登录绑定角色 → 判定是否还在挂机图（不在=死亡已回城）
 *   2. 死亡恢复：飞艇无坐标随机传送（免费，实测卷轴×0）到挂机图/洞穴入口图
 *      → 洞穴：巡路踩门逐层进入，层内用瞬间移动(SKID26)+巡路逼近下一层门口
 *   3. 重新下发内挂配置（主动/辅助技能、定向怪物、距离等）→ 开自动战斗
 *   4. 裸断线（hardClose）→ 服务器离线内挂接管（leveler 实证真值）
 * 仍存活（在挂机图）→ 直接裸断线，最小打扰。
 */
const { ROClient } = require('./client');
const { Bot } = require('./bot');
const { BUILD } = require('./protocol');
const { BotConfig } = require('./botconfig');
const { LoginSession, sleep } = require('./modules');
const { findChain, chainCandidates } = require('./portals');

const TELETE_SKID = 26;   // AL_TELEPORT 瞬间移动

class AFKBot {
  /**
   * @param cfg { account, password, line='eden', slot, map,
   *              mobs:[id...], atk:{id,lv,pro}, sup:{id,lv,on},
   *              attackDis=1, skillDis=2, extra:{...botconfig 语义名:值}, log }
   */
  constructor(cfg) {
    this.cfg = Object.assign({ line: 'eden', attackDis: 1, skillDis: 2, mobs: [], atk: null, sup: null, extra: {} }, cfg);
    this.log = cfg.log || console.log;
    this.c = new ROClient({ line: this.cfg.line, account: this.cfg.account, password: this.cfg.password });
    this.bot = new Bot(this.c);
    this.bc = new BotConfig(this.c, (m) => this.log(m));
    this.done = false;
    this._wire();
  }

  _wire() {
    const c = this.c, bot = this.bot;
    this.login = new LoginSession(c, {
      account: this.cfg.account, password: this.cfg.password, line: this.cfg.line,
      backoff: { hang: 45000, refuse8: 10000, refuse2: 10000, refuse: 15000, disconnect: 30000, banned: 60000 },
    }, this.log);
    c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500); });
    c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
    c.on('char_list', (p) => {
      const ch = p.chars.find((x) => x.CharNum === this.cfg.slot);
      if (!ch) { this.log(`❌ slot${this.cfg.slot} 不存在（有 ${p.chars.length} 角色）`); return this.finish('no-char', 1); }
      this.charName = ch.name;
      c.session.charName = ch.name;
      c.selectChar(ch.CharNum);
    });
    c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => this.finish('zone-fail', 1)));
    c.on('map_enter', (p) => {
      bot.updatePos(p.pos[0], p.pos[1]); bot.updateMap(c.mapName);
      setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
      setTimeout(() => this.onEnter().catch((e) => { this.log('异常: ' + e.message); this.finish('error', 1); }), 3500);
    });
    c.on('banned', (p) => {
      // code=8/2 = 账号在离线内挂中（占线）——正常情况，挤号重试而不是放弃
      if (p.code === 8 || p.code === 2) {
        this._squeezes = (this._squeezes || 0) + 1;
        if (this._squeezes > 10) { this.log('❌ 挤号 10 次未进入，放弃本轮'); return this.finish('squeeze-fail', 2); }
        this.log(`⏳ 挤号 code=${p.code}（第${this._squeezes}次），15s 后重试`);
        try { this.c.closeAllSockets(); } catch (_) {}
        this.login.relogin(15000, '挤号');
        return;
      }
      this.log(`被踢 code=${p.code}`);
      if (!this.done) this.finish('banned', 2);
    });
    c.on('disconnect', () => {
      if (this.done || this.c.dropping) return;
      this.login.relogin(15000, this._squeezes ? '挤号重试' : '断线');
    });
  }

  mapName() { return (this.c.mapName || '').replace(/\.gat$/i, ''); }
  onMap() { return this.mapName() === this.cfg.map.replace(/\.gat$/i, ''); }

  async onEnter() {
    const alive = this.onMap();
    this.log(`${this.charName} 进图 ${this.c.mapName} @(${this.c.position || '?'}) ${alive ? '✅ 仍在挂机图' : '💀 不在挂机图 → 死亡恢复'}`);
    if (alive) { this.applyConfig(); return this.finish('alive-offline', 0, true); }
    const ok = await this.recover();
    if (!ok) return this.finish('recover-fail', 1);
    this.applyConfig();
    this.finish('recovered-offline', 0, true);
  }

  // ---------- 导航回挂机图 ----------
  async airshipRandom(map) {
    this.log(`🚌 飞艇随机传送 → ${map}`);
    try { this.c.send(BUILD.airshipRequest(map, 0, 0, 1, 14527)); } catch (e) { return false; }
    for (let i = 0; i < 20; i++) { await sleep(500); if (this.mapName() === map) { await sleep(2500); this.bot.updatePos(this.c.position[0], this.c.position[1]); return true; } }
    return this.mapName() === map;
  }

  /** 飞艇定向直飞洞口坐标（用户真值：洞穴门口图可定向传；失败回退随机） */
  async airshipTarget(map, x, y) {
    this.log(`🚌 飞艇定向 → ${map} (${x},${y})`);
    try { this.c.send(BUILD.airshipRequest(map, x, y, 1, 14527)); } catch (e) { return false; }
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if (this.mapName() === map) {
        await sleep(2500);
        this.bot.updatePos(this.c.position[0], this.c.position[1]);
        const p = this.c.position;
        if (p) this.log(`   落点 (${p[0]},${p[1]})，距洞口 ${Math.max(Math.abs(p[0] - x), Math.abs(p[1] - y))} 格`);
        return true;
      }
    }
    return false;
  }

  async teleportSelf() {
    try { this.c.send(BUILD.useSkill(TELETE_SKID, 1, this.c.session.GID)); } catch (_) {}
    await sleep(1400);   // 等 0x0091 落点
    if (this.c.position) this.bot.updatePos(this.c.position[0], this.c.position[1]);
  }

  async gotoPortal(step) {
    // 层内逼近：有瞬间移动技能(SKID26)才做瞬移跳跃（距门 ≤28 格即停），否则直接巡路
    const canTp = (this.c.skills || []).some((s) => s.SKID === TELETE_SKID && s.level > 0);
    if (canTp) {
      for (let i = 0; i < 30; i++) {
        const p = this.bot.pos || this.c.position;
        if (!p) { await sleep(1000); continue; }
        const d = Math.max(Math.abs(p[0] - step.x), Math.abs(p[1] - step.y));
        if (d <= 60) break;
        this.log(`   ✨ 瞬移第${i + 1}跳（距门${d}格）`);
        await this.teleportSelf();
      }
    } else this.log('   （无瞬间移动技能，直接巡路穿层）');
    this.log(`🚶 巡路踩门 (${step.map} ${step.x},${step.y}) → ${step.to}`);
    await new Promise((res) => this.bot.walkSmart(step.x, step.y, () => res(), 180000));
    const arrived = async () => { for (let i = 0; i < 16; i++) { await sleep(500); if (this.mapName() === step.to) return true; } return this.mapName() === step.to; };
    if (await arrived()) return true;
    // 未换图：尝试门格的 4 邻格（部分服门触发格有偏移）
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      await new Promise((res) => this.bot.walkSmart(step.x + dx, step.y + dy, () => res(), 30000));
      if (await arrived()) return true;
    }
    return this.mapName() === step.to;
  }

  async recover() {
    const target = this.cfg.map.replace(/\.gat$/i, '');
    const candidates = chainCandidates(target, 2);
    if (!candidates.length) { this.log(`❌ ${target} 无传送链`); return false; }
    for (const chain of candidates) {
      const entrance = chain[0].map;
      // 状态驱动：按当前图决定下一步（定向落格可能已自动触发进层，须动态识别）
      for (let guard = 0; guard < chain.length + 3 && this.mapName() !== target; guard++) {
        if (this.mapName() === entrance) {
          const step = chain[1];
          if (!step || !(await this.gotoPortal(step))) break;
        } else {
          const step = chain.find((s) => s.map === this.mapName() && s.to);
          if (step) {
            if (!(await this.gotoPortal(step))) break;
          } else {
            // 不在链上（死亡回城等）→ 定向直飞第一个洞口格（落格自动进层）；失败回退随机
            let ok = await this.airshipTarget(entrance, chain[1].x, chain[1].y);
            if (!ok) ok = await this.airshipRandom(entrance);
            if (!ok) { this.log(`   入口 ${entrance} 飞艇未达，试下一候选`); break; }
          }
        }
        await sleep(2000);
      }
      if (this.mapName() === target) {
        this.log(`🎯 到达挂机图 ${this.mapName()} @(${this.c.position})`);
        return true;
      }
    }
    return false;
  }

  // ---------- 内挂配置下发 + 离线 ----------
  applyConfig() {
    const { atk, sup, mobs, attackDis, skillDis, extra } = this.cfg;
    if (atk && atk.id) this.bc.setAutoSkill(atk.id, atk.lv || 10, atk.pro == null ? 100 : atk.pro);
    if (sup && sup.id) this.bc.setSupportSkill(sup.id, sup.lv || 10, sup.on !== false);
    if (mobs && mobs.length) this.bc.targetMobs(mobs);
    this.bc.set(1, attackDis);
    this.bc.set(2, skillDis);
    for (const [k, v] of Object.entries(extra || {})) this.bc.set(/^\d+$/.test(k) ? +k : k, v);
    this.log(`⚙ 配置下发: 主动${atk && atk.id ? '#' + atk.id + 'Lv' + atk.lv : '无'} 辅助${sup && sup.id ? '#' + sup.id : '无'} 定向怪×${mobs.length} 距离${attackDis}/${skillDis}`);
  }

  /** 裸断线（服务器离线内挂接管）；优雅选项用于非挂机场景的干净退出 */
  finish(reason, code = 0, offline = false) {
    if (this.done) return;
    this.done = true;
    this.login.stop();
    const exit = () => process.exit(code);
    if (offline) {
      // 开自动战斗 → 1.5s → 裸断线（V6 离线内挂触发真值：直接掉线才转离线挂机）
      this.bc.set(34, 1);
      setTimeout(() => {
        this.log(`📴 开启自动战斗后裸断线 → 服务器离线内挂接管（${reason}）`);
        try { this.c.dropping = true; this.c.hardClose(); } catch (_) {}
        setTimeout(exit, 800);
      }, 1500);
    } else {
      this.c.quitClean().finally(exit);
    }
  }

  start() { this.login.login(); return this; }
}

module.exports = { AFKBot };
