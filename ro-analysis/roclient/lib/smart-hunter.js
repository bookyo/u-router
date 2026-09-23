'use strict';
/**
 * SmartHunter —— OpenKore AI 复刻版（2026-09-21）
 * ============================================================
 * 复刻 OpenKore Attack.pm + CoreLogic.pm 的核心模式：
 *
 *   状态机：IDLE → MOVING_TO_ATTACK → ATTACKING → (kill) → IDLE
 *   attackMethod 优先级：attackSkillSlot[]（技能槽） > weapon（普攻）
 *   monControl：怪物优先级（0=忽略 1=被动 2=主动 3=只打未被碰的）
 *   giveup 计时器：N 秒未击杀 → 拉黑换目标（计时不含走路时间，与 OpenKore 一致）
 *   approach 重算：目标移动 >3 格时重算路径
 *   卡住检测：连续 stuck → 站起 → 自位移重同步 → 侧步（OpenKore unstuck 模式）
 *   巡逻：无目标时朝地图中心偏置随机走（OpenKore randomWalk）
 *
 * 内挂配合（不冲突）：拾取(35)+吃药(36)由服务器管；本模块只管战斗。
 * 每次切角用 RESTART（0x00B2 type=1），绝不裸断线 → 账号永不进离线模式。
 */
const { BUILD } = require('./protocol');
const { loadGat } = require('./gat');
const { findPath } = require('./pathfinding');

const HEAL_ITEM_IDS = new Set([501,502,503,504,505,506,507,508,509,510,511,512,513,516,519,522,529,530,531,532,533,534,535,536,537,538,539,540,541,542,543,544,545,587,588]);
const dist2 = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
const SEG_MAX = 10;
const STAGES = { IDLE: 0, APPROACH: 1, ATTACKING: 2 };

class SmartHunter {
  /**
   * @param client ROClient
   * @param opts {
   *   targets: [mobID...],            // 要打的怪（空=全打）
   *   ignore: [mobID...],             // 忽略的怪
   *   attackRange: 1,                 // 普攻射程（近战1 远程按武器）
   *   scanRange: 20,                  // 选怪半径
   *   skills: [                       // attackSkillSlot（优先级从高到低）
   *     { SKID: 19, level: 10, range: 9, spCost: 10, maxDist: null },
   *   ],
   *   hpPct: 0.5,                     // 喝药阈值
   *   spPct: 0.1,                     // 低于此 SP% 不用技能（留蓝吃药）
   *   giveupSec: 25,                  // 击杀超时（秒，不含走路）
   *   tickMs: 1200,
   *   center: [x, y],                 // 巡逻中心（地图刷怪区）
   *   patrolRadius: 55,               // 超过此距离回中心
   *   log: fn
   * }
   */
  constructor(client, opts = {}) {
    this.c = client;
    this.o = Object.assign({
      targets: [], ignore: [], attackRange: 1, scanRange: 20,
      skills: [], hpPct: 0.5, spPct: 0.1, giveupSec: 25,
      tickMs: 1200, center: null, patrolRadius: 55,
    }, opts);
    this.log = opts.log || (() => {});
    this.timer = null;
    this.stage = STAGES.IDLE;
    // 目标
    this.target = null;          // { gid, job, pos, seenAt, engageAt, lastHitFromMe }
    this._black = new Map();     // gid → 拉黑到期
    // 攻击
    this.attacking = new Set();
    this._atkAt = new Map();
    this._engageAt = 0;          // 开始战斗的时间（giveup 基准）
    this._lastHitFromMe = 0;     // 最后一次我方伤害
    // 寻路
    this._wp = null;
    this.gat = null;
    this._mapName = '';
    this.lastMoveAt = 0;
    // 喝药
    this.lastDrinkAt = 0;
    this._warnedNoPot = false;
    // 死亡
    this.dead = false;
    // 巡逻
    this._patrolDir = null;
    this._patrolSteps = 0;
    // 统计
    this.kills = 0;
    this._censusAt = 0;
    this._hook();
  }

  // ---------- 事件 ----------
  _hook() {
    const c = this.c;
    c.on('vanish', (p) => {
      if (this.target && p.gid === this.target.gid && p.type !== 2) {
        // 1=死亡 3=传送走（2=出视野不一定是死）
        this.kills++;
        this.log(`🏆 击杀 #${this.target.job}（累计 ${this.kills}）`);
        this._clearTarget();
      }
    });
    // 伤害反馈：0x0088 攻击通知（含我方对怪伤害）
    c.on('attack_notify', (p) => {
      if (this.target && p.targetGID === this.target.gid && p.GID === c.session.GID) {
        this._lastHitFromMe = Date.now();
      }
    });
  }

  // ---------- 控制 ----------
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.o.tickMs);
    this.log(`🧝 SmartHunter 启动（目标${this.o.targets.length || '全'}种 技能${this.o.skills.length}个 giveup=${this.o.giveupSec}s）`);
  }
  stop() { clearInterval(this.timer); this.timer = null; this.log('🧝 SmartHunter 停止'); }
  setMap(name, center) {
    this._mapName = String(name).replace(/\.gat$/i, '');
    if (center) this.o.center = center;
    loadGat(this._mapName).then((g) => { this.gat = g; }).catch(() => {});
  }
  setTargets(ids) { this.o.targets = ids || []; this._clearTarget(); }
  setSkills(skills) { this.o.skills = skills || []; }

  // ---------- 核心 tick ----------
  async tick() {
    const c = this.c;
    if (!c.ws || c.state !== 'zone' || !c.position) return;
    const S = c.stats || {};
    const hp = S.hp || 0, maxhp = S.maxhp || 0, sp = S.sp || 0, maxsp = S.maxsp || 0;

    // ① 死亡 → 回城
    if (maxhp > 0 && hp === 0) return this._handleDeath();

    // ② 低血喝药（内挂也管，这里兜底）
    if (maxhp > 0 && hp / maxhp < this.o.hpPct && Date.now() - this.lastDrinkAt > 2000) {
      const pot = this._findPotion();
      if (pot) {
        this.lastDrinkAt = Date.now();
        try { c.send(BUILD.useItem(pot.index, c.session.AID)); } catch (_) {}
      }
    }

    // ③ 目标有效性
    if (this.target) {
      const ent = c.entities.get(this.target.gid);
      if (!ent || !ent.pos || Date.now() - this.target.seenAt > 8000) {
        this._clearTarget(); return;
      }
      const moved = dist2(this.target.pos, ent.pos);
      this.target.pos = ent.pos; this.target.seenAt = Date.now();
      if (moved > 3) this._wp = null;   // 怪走远了 → 重算路径（OpenKore approach_target_route_needs_reset）
      // giveup 计时（OpenKore 风格：只计战斗时间，不计走路）
      if (this._engageAt && Date.now() - this._engageAt > this.o.giveupSec * 1000) {
        if (Date.now() - this._lastHitFromMe > this.o.giveupSec * 1000) {
          this._black.set(this.target.gid, Date.now() + 30000);
          this.log(`⛔ #${this.target.job} ${this.o.giveupSec}s 无伤害反馈 → 拉黑 30s`);
          this._clearTarget(); return;
        }
      }
    }

    // ④ 无目标 → 选怪（OpenKore monControl 优先级模式）
    if (!this.target) {
      const found = this._findTarget();
      if (found) {
        this.target = { gid: found.GID, job: found.job, pos: found.pos, seenAt: Date.now() };
        this.stage = STAGES.APPROACH;
        this._engageAt = 0; this._lastHitFromMe = 0; this._wp = null;
        this._stuckCnt = 0; this._resynced = false;
        this.log(`👀 → #${found.job} @(${found.pos[0]},${found.pos[1]}) 距${dist2(c.position, found.pos)}`);
        return;
      }
      this._patrol();
      return;
    }

    // ⑤ 有目标 → 攻击循环（OpenKore main() 核心）
    this._combat(hp, maxhp, sp, maxsp);
  }

  // ---------- 选怪（OpenKore monControl + 优先级） ----------
  _findTarget() {
    const c = this.c, now = Date.now();
    let best = null, bestScore = -Infinity;
    const targeting = new Set(this.o.targets);
    const ignoring = new Set(this.o.ignore);
    for (const ent of c.entities.values()) {
      if (ent.kind !== 'mob' || !ent.pos) continue;
      if (targeting.size && !targeting.has(ent.job)) continue;
      if (ignoring.has(ent.job)) continue;
      if (this._black.get(ent.GID) > now) continue;
      const d = dist2(c.position, ent.pos);
      if (d > this.o.scanRange) continue;
      // OpenKore 优先级：正在打我的怪（aggressive） > 距离近的怪
      const isAttackingMe = ent.target === c.session.GID;
      const score = (isAttackingMe ? 1000 : 0) - d;
      if (score > bestScore) { best = ent; bestScore = score; }
    }
    return best;
  }

  // ---------- 战斗（OpenKore main() 复刻） ----------
  _combat(hp, maxhp, sp, maxsp) {
    const c = this.c;
    const d = dist2(c.position, this.target.pos);

    // 攻击方式选择（OpenKore attackMethod 优先级：attackSkillSlot > weapon）
    const method = this._pickAttackMethod(sp, maxsp);

    if (method.type === 'skill') {
      // 技能攻击
      if (d <= method.range) {
        // 在射程内 → 施放
        this._wp = null; this.stage = STAGES.ATTACKING;
        if (!this._engageAt) this._engageAt = Date.now();
        if (Date.now() - (this._lastSkillAt || 0) > 2000) {   // 技能 GCD 2s
          this._lastSkillAt = Date.now();
          try {
            c.send(BUILD.useSkill(method.SKID, method.level, this.target.gid));
            this.log(`✨ ${method.name} Lv${method.level} → #${this.target.job} 距${d}`);
          } catch (_) {}
        }
        return;
      }
      // 不在射程 → 走近（APPROACH 阶段）
      this.stage = STAGES.APPROACH;
      this._approach(method.range);
      return;
    }

    // 普攻
    if (d <= this.o.attackRange) {
      this._wp = null; this.stage = STAGES.ATTACKING;
      if (!this._engageAt) this._engageAt = Date.now();
      const lastAtk = this._atkAt.get(this.target.gid) || 0;
      if (!this.attacking.has(this.target.gid) || Date.now() - lastAtk > 6000) {
        this.attacking.add(this.target.gid);
        this._atkAt.set(this.target.gid, Date.now());
        try { c.send(BUILD.requestAct(this.target.gid, 7)); } catch (_) {}
      }
      return;
    }
    this.stage = STAGES.APPROACH;
    this._approach(this.o.attackRange);
  }

  // ---------- 攻击方式选择（OpenKore attackSkillSlot 逻辑） ----------
  _pickAttackMethod(sp, maxsp) {
    // SP 低于阈值 → 不用技能（留蓝给内挂吃药系统）
    if (maxsp > 0 && sp / maxsp < this.o.spPct) return { type: 'weapon' };
    // 技能槽按优先级检查（第一个可用的）
    const learned = new Set((this.c.skills || []).filter((s) => s.level > 0).map((s) => s.SKID));
    for (const sk of this.o.skills) {
      if (!learned.has(sk.SKID)) continue;
      const skill = (this.c.skills || []).find((s) => s.SKID === sk.SKID);
      const lv = Math.min(sk.level || 10, skill ? skill.level : 10);
      if (sk.spCost && sp < sk.spCost * lv) continue;   // SP 不够
      return { type: 'skill', SKID: sk.SKID, level: lv, range: sk.range || 9, name: (skill && skill.name) || `#${sk.SKID}` };
    }
    return { type: 'weapon' };
  }

  // ---------- 走近目标 ----------
  _approach(stopRange) {
    const c = this.c;
    if (Date.now() - this.lastMoveAt < 1500) return;
    const px = c.position[0], py = c.position[1];
    const stuck = this._lastPos && this._lastPos[0] === px && this._lastPos[1] === py;
    this._stuckCnt = stuck ? (this._stuckCnt || 0) + 1 : 0;
    if (!stuck) this._resynced = false;
    this._lastPos = [px, py];
    this.lastMoveAt = Date.now();
    this.attacking.delete(this.target.gid);

    if (this._stuckCnt >= 1 && !this._resynced) {
      this._resynced = true;
      try { c.send(BUILD.requestAct(c.session.GID, 3)); } catch (_) {}       // 站起
      try { c.send(BUILD.requestMove(px, py)); } catch (_) {}                // 自位移重同步
      this.log(`♻ 重同步 (${px},${py})`);
      return;
    }
    if (this._stuckCnt >= 4) {
      this._black.set(this.target.gid, Date.now() + 30000);
      this.log(`⛔ 连卡 4 次 → 拉黑 #${this.target.job}`);
      this._clearTarget(); return;
    }

    // A* 寻路到目标（带射程余量）
    const goal = [this.target.pos[0], this.target.pos[1]];
    let wp = null;
    if (this.gat) {
      if (!this._wp || !this._wp.length) {
        const path = findPath(this.gat, px, py, goal[0], goal[1]);
        if (path) this._wp = this._toWaypoints(path, stopRange);
      }
      wp = this._wp && this._wp[0];
    }
    if (!wp) {
      const dx = goal[0] - px, dy = goal[1] - py;
      const cheb = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
      wp = [px + Math.round(dx / cheb * SEG_MAX), py + Math.round(dy / cheb * SEG_MAX)];
    }
    if (wp) {
      try { c.send(BUILD.requestMove(wp[0], wp[1])); } catch (_) {}
      if (this._wp) this._wp.shift();
    }
  }

  // ---------- 巡逻（无目标时） ----------
  _patrol() {
    const c = this.c;
    if (Date.now() - this.lastMoveAt < 5000) return;
    this.lastMoveAt = Date.now();
    // 先看视野内远处目标怪 → 朝它推进（OpenKore approach far target）
    let far = null, farD = Infinity;
    const targeting = new Set(this.o.targets);
    const now = Date.now();
    for (const ent of c.entities.values()) {
      if (ent.kind !== 'mob' || !ent.pos) continue;
      if (targeting.size && !targeting.has(ent.job)) continue;
      if (this._black.get(ent.GID) > now) continue;
      const dd = dist2(c.position, ent.pos);
      if (dd < farD) { far = ent; farD = dd; }
    }
    if (far && farD > this.o.scanRange) {
      const dx = far.pos[0] - c.position[0], dy = far.pos[1] - c.position[1];
      const cheb = Math.max(Math.abs(dx), Math.abs(dy)) || 1;
      try { c.send(BUILD.requestMove(c.position[0] + Math.round(dx / cheb * SEG_MAX), c.position[1] + Math.round(dy / cheb * SEG_MAX))); } catch (_) {}
      return;
    }
    // 无可见目标 → randomWalk（带中心偏置）
    if (this._patrolDir == null || --this._patrolSteps <= 0) {
      const cx = (this.o.center && this.o.center[0]) || c.position[0];
      const cy = (this.o.center && this.o.center[1]) || c.position[1];
      if (Math.abs(c.position[0] - cx) + Math.abs(c.position[1] - cy) > this.o.patrolRadius) {
        this._patrolDir = Math.atan2(cy - c.position[1], cx - c.position[0]);
      } else {
        this._patrolDir = Math.random() * Math.PI * 2;
      }
      this._patrolSteps = 5;
    }
    const dx = Math.round(Math.cos(this._patrolDir) * 12);
    const dy = Math.round(Math.sin(this._patrolDir) * 12);
    const nx = Math.max(15, Math.min(370, c.position[0] + dx));
    const ny = Math.max(15, Math.min(370, c.position[1] + dy));
    const cand = this._pickWalkable(nx, ny, 8);
    if (cand) try { c.send(BUILD.requestMove(cand[0], cand[1])); } catch (_) {}
    else this._patrolSteps = 0;
    // 视野普查
    if (Date.now() - this._censusAt > 60000) {
      this._censusAt = Date.now();
      const census = {};
      for (const ent of c.entities.values()) if (ent.kind === 'mob') census[ent.job] = (census[ent.job] || 0) + 1;
      const total = Object.values(census).reduce((a, b) => a + b, 0);
      this.log(`🔎 视野: 实体${c.entities.size} 怪×${total} 击杀${this.kills}`);
    }
  }

  // ---------- 辅助 ----------
  _clearTarget() { this.target = null; this._wp = null; this.stage = STAGES.IDLE; this._engageAt = 0; }
  _handleDeath() {
    if (this.dead) return;
    this.dead = true;
    this.log('💀 死亡 → 3s 后回城');
    this._clearTarget();
    setTimeout(() => {
      try {
        const w = new (require('./binary').BinaryWriter)(3);
        w.writeShort(0x00B2); w.writeUChar(0);
        this.c.send(w.buffer);
      } catch (_) {}
      setTimeout(() => { this.dead = false; }, 5000);
    }, 3000);
  }
  _findPotion() {
    return (this.c.inventory || []).find((it) => HEAL_ITEM_IDS.has(it.ITID) && (it.count || 0) > 0);
  }
  _toWaypoints(path, stopRange) {
    if (!path || path.length <= stopRange) return [];
    const wp = [];
    let prev = path[0];
    for (let i = 1; i < path.length - stopRange; i++) {
      const [x, y] = path[i];
      const [px2, py2] = prev;
      if (Math.abs(x - px2) + Math.abs(y - py2) > 1) {   // 拐点
        wp.push([px2, py2]);
      }
      prev = [x, y];
      if (wp.length >= 6) break;
    }
    if (!wp.length) wp.push(path[Math.max(0, path.length - 1 - stopRange)]);
    return wp;
  }
  _pickWalkable(x, y, radius) {
    if (!this.gat) return [x, y];
    for (let r = 0; r <= radius; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        if (this.gat.walkable(x + dx, y + dy)) return [x + dx, y + dy];
      }
    }
    return null;
  }
}

module.exports = { SmartHunter, STAGES };
