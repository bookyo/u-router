'use strict';
/**
 * 自研猎怪模块（不依赖服务器内挂）
 * ================================================
 * 循环（每 tick ≈ 1.2s）：
 *   1. 低血喝药：hp/maxhp < hpPct 时用背包里第一个治疗道具（CZ.USE_ITEM 0x0439）
 *   2. 死亡复活：hp == 0 → 3 秒后发 CZ.RESTART(0x00B2 type=0) 回存档点
 *   3. 选目标：entities 里找 kind='mob' 且 job∈targets 的最近者（扫描半径内，跳过黑名单）
 *   4. 贴近：A* 寻路（OpenKore fld2 字段地图）→ 拐点分段（每段直线 ≤12 格）逐段走
 *      无地图数据时回退：8 方向直线中途拐点 + 卡住侧步
 *   5. 攻击：距离 <= attackRange → CZ.REQUEST_ACT(0x0437, action=7) 连续普攻（OpenKore 同款，
 *      一次即锁定；6 秒无伤害反馈重发；20 秒未击杀拉黑换目标）
 *
 * 实体来源：0x09FF/0x007C/0x09FD 进视野与移动（client.entities），0x0080 消失自动剔除；
 * 流错位（未知封包）清空视野重建。
 */
const { BUILD } = require('./protocol');
const { loadMap } = require('./gat');
const { findPath } = require('./pathfinding');

// 常见治疗道具 ITID（红/橙/黄/白药水、牛奶、水果、肉……）
const HEAL_ITEM_IDS = new Set([501, 502, 503, 504, 505, 506, 507, 508, 509, 510, 511, 512, 513, 516, 519, 522, 529, 530, 531, 532, 533, 534, 535, 536, 537, 538, 539, 540, 541, 542, 543, 544, 545, 587, 588]);

const dist2 = (a, b) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])); // 切比雪夫（RO 网格）
const SEG_MAX = 10;   // 服务器单段走路上限 12 格，留余量

class Hunter {
  /**
   * @param client ROClient
   * @param opts { targets:[mobID...], attackRange:1, scanRange:20, hpPct:0.5, tickMs:1200 }
   */
  constructor(client, opts = {}) {
    this.c = client;
    this.targets = new Set(opts.targets || []);
    this.attackRange = opts.attackRange || 1;
    this.scanRange = opts.scanRange || 20;
    this.hpPct = opts.hpPct || 0.5;
    this.tickMs = opts.tickMs || 1200;
    this.walkOnly = !!opts.walkOnly;   // 内挂负责打，本模块只走位
    this.log = opts.log || (() => {});
    this.timer = null;
    this.target = null;          // { gid, job, pos, seenAt }
    this.attacking = new Set();
    this._wp = null;             // A* 拐点队列 [[x,y],...]
    this.field = null;
    this.lastMoveAt = 0;
    this.lastDrinkAt = 0;
    this.dead = false;
    this.kills = 0;
    this._hook();
  }

  setTargets(ids) { this.targets = new Set(ids); this.retreat(); }

  async setMap(mapName, center) {
    this.field = null; this._wp = null;
    if (center) this._center = center;
    try {
      this.field = await loadMap(mapName);
      this.log(`🗺 地图数据 ${mapName.replace(/\.(gat|fld2)$/i, '')} ${this.field.width}×${this.field.height}（A* 寻路就绪）`);
    } catch (e) { this.log(`⚠ 无地图数据(${mapName})，回退直线走位: ${e.message}`); }
  }

  start() {
    if (this.timer) return;
    this.dead = false;
    this.timer = setInterval(() => this.tick().catch(() => {}), this.tickMs);
    this.log(`⚔ 猎怪启动: 目标[${[...this.targets].join(',')}] 攻距${this.attackRange} 扫描${this.scanRange} 低血${Math.round(this.hpPct * 100)}%`);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.target = null;
    this._wp = null;
  }
  retreat() { this.target = null; this._wp = null; this.attacking.clear(); }

  _hook() {
    // 流错位（丢包/僵尸数据）→ 清空视野重建
    this.c.on('stream_error', () => {
      this.c.entities.clear();
      this.target = null;
      this._wp = null;
      this._lastPos = null;
      this._stuckCnt = 0;
      this.log('⚠ 流错位，清空视野重建');
      setTimeout(() => { try { this.c.mapLoaded(); this.log('↻ 已重发 ACTORINIT 重建实体列表'); } catch (_) {} }, 1500);
    });
    // 目标死亡/消失 → 清理并计击杀
    this.c.on('vanish', (p) => {
      if (this.target && p.gid === this.target.gid) {
        if (p.type === 1) { this.kills++; this.log(`🎯 击杀 #${this.target.job} ×${this.kills}`); }
        this.target = null;
        this._wp = null;
      }
      this.attacking.delete(p.gid);
    });
  }

  _findPotion() {
    const inv = this.c.inventory || [];
    return inv.find((it) => HEAL_ITEM_IDS.has(it.ITID) && (it.count == null || it.count > 0)) || null;
  }

  // A* → 拐点队列：方向变化点 + 超长直线每 SEG_MAX 格一切
  _computeWaypoints(tx, ty) {
    if (!this.field) return null;
    const px = this.c.position[0], py = this.c.position[1];
    // 目标格：怪身旁 8 格中离自己最近的可走格（怪自身格被占用，走过去必被服务器拒绝）
    let goal = null, bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = tx + dx, ny = ty + dy;
      if (this.field.walkable(nx, ny)) {
        const d = dist2(this.c.position, [nx, ny]);
        if (d < bestD) { goal = [nx, ny]; bestD = d; }
      }
    }
    if (!goal) return null;
    const path = findPath(this.field, px, py, goal[0], goal[1]);
    if (!path || path.length < 2) return null;
    // 抽拐点：方向变化处；并把长直线切成 ≤SEG_MAX 段
    const wps = [];
    let run = 0, lastDir = null;
    for (let i = 1; i < path.length; i++) {
      const dir = Math.sign(path[i][0] - path[i - 1][0]) + ',' + Math.sign(path[i][1] - path[i - 1][1]);
      run++;
      if (dir !== lastDir || run >= SEG_MAX) {
        wps.push(path[i]);
        run = 0; lastDir = dir;
      }
    }
    if (!wps.length) wps.push(path[path.length - 1]);
    return wps;
  }


  // 在 (x,y) 附近找一圈可走格（侧步/巡逻用）；无 field 时原样返回
  _pickWalkable(x, y, r = 6) {
    if (!this.field) return [x, y];
    if (this.field.walkable(x, y)) return [x, y];
    for (let rr = 1; rr <= r; rr++) {
      for (let k = 0; k < 8; k++) {
        const ang = k * Math.PI / 4;
        const nx = Math.round(x + Math.cos(ang) * rr), ny = Math.round(y + Math.sin(ang) * rr);
        if (this.field.walkable(nx, ny)) return [nx, ny];
      }
    }
    return null;
  }

  async tick() {
    const c = this.c;
    if (!c.ws || c.state !== 'zone' || !c.position) return;
    const S = c.stats || {};
    const hp = S.hp || 0, maxhp = S.maxhp || 0;

    // ① 死亡复活（hp=0 → 回存档点）
    if (maxhp > 0 && hp === 0) {
      if (!this.dead) {
        this.dead = true;
        this.log('💀 角色死亡，3 秒后回存档点复活');
        setTimeout(() => {
          try {
            const w = new (require('./binary').BinaryWriter)(3);
            w.writeShort(0x00B2); w.writeUChar(0);   // CZ.RESTART type=0 = 死亡回城
            this.c.send(w.buffer);
          } catch (_) {}
          setTimeout(() => { this.dead = false; this.retreat(); }, 3000);
        }, 3000);
      }
      return;
    }

    // ② 低血喝药
    if (maxhp > 0 && hp / maxhp < this.hpPct && Date.now() - this.lastDrinkAt > 2000) {
      const pot = this._findPotion();
      if (pot) {
        this.lastDrinkAt = Date.now();
        try { c.send(BUILD.useItem(pot.index, c.session.AID)); this.log(`🧪 HP ${hp}/${maxhp} → 喝药 #${pot.ITID}`); } catch (_) {}
      } else if (!this._warnedNoPot) {
        this._warnedNoPot = true;
        this.log(`⚠ HP ${hp}/${maxhp} 低于阈值但背包无治疗道具`);
      }
    }

    // ③ 目标有效性 + 僵尸检测
    if (this.target) {
      const ent = c.entities.get(this.target.gid);
      if (!ent || Date.now() - this.target.seenAt > 8000) { this.target = null; this._wp = null; }
      else {
        const moved = this.target.pos && dist2(this.target.pos, ent.pos);
        this.target.pos = ent.pos; this.target.seenAt = Date.now();
        if (moved > 3) this._wp = null;             // 怪走远了，路径作废重算
        if (this.attacking.has(this.target.gid) && this._atkAt && Date.now() - (this._atkAt.get(this.target.gid) || 0) > 20000) {
          this._black = this._black || new Map();
          this._black.set(this.target.gid, Date.now() + 30000);
          this.log(`⛔ #${this.target.job} 20 秒未击杀（僵尸/打不动），拉黑 30 秒`);
          this.target = null; this._wp = null;
          return;
        }
      }
    }

    // ④ 重新选目标（最近的合法怪；跳过 30 秒黑名单）
    if (!this.target) {
      let best = null, bestD = Infinity;
      const now = Date.now();
      for (const ent of c.entities.values()) {
        if (ent.kind !== 'mob' || !this.targets.has(ent.job) || !ent.pos) continue;
        if (this._black && this._black.get(ent.GID) > now) continue;
        const d = dist2(c.position, ent.pos);
        if (d < bestD && d <= this.scanRange) { best = ent; bestD = d; }
      }
      if (best) {
        this.target = { gid: best.GID, job: best.job, pos: best.pos, seenAt: Date.now() };
        this._stuckCnt = 0; this._resynced = false; this._wp = null;
        this.log(`👀 锁定 #${best.job} @(${best.pos[0]},${best.pos[1]}) 距${bestD}`);
        return;
      }
      // ④b 无目标 → 先看视野内任意距离的目标怪（可见距离远大于锁定半径），朝它推进；没有才随机巡逻
      let far = null, farD = Infinity;
      const nowMs = Date.now();
      for (const ent of c.entities.values()) {
        if (ent.kind !== 'mob' || !this.targets.has(ent.job) || !ent.pos) continue;
        if (this._black && this._black.get(ent.GID) > nowMs) continue;
        const dd = dist2(c.position, ent.pos);
        if (dd < farD) { far = ent; farD = dd; }
      }
      if (far && farD > this.scanRange && Date.now() - this.lastMoveAt > 4000) {
        // 朝远处目标推进（A* 或直线中途拐点）
        this.lastMoveAt = Date.now();
        try {
          let wp = null;
          if (this.field) {
            const wps = this._computeWaypoints(far.pos[0], far.pos[1]);
            wp = wps && wps[0];
          }
          if (!wp) {
            const ddx = far.pos[0] - c.position[0], ddy = far.pos[1] - c.position[1];
            const cheb = Math.max(Math.abs(ddx), Math.abs(ddy)) || 1;
            wp = [c.position[0] + Math.round(ddx / cheb * SEG_MAX), c.position[1] + Math.round(ddy / cheb * SEG_MAX)];
          }
          c.send(BUILD.requestMove(wp[0], wp[1]));
        } catch (_) {}
        if (Date.now() - (this._approachLogAt || 0) > 15000) {
          this._approachLogAt = Date.now();
          this.log(`🔭 视野目标 #${far.job} @(${far.pos[0]},${far.pos[1]}) 距${farD} → 推进`);
        }
      } else if (!far && Date.now() - this.lastMoveAt > 5000) {
        this.lastMoveAt = Date.now();
        if (this._patrolDir == null || --this._patrolSteps <= 0) {
          const cx = (this._center && this._center[0]) || 197, cy = (this._center && this._center[1]) || 188;
          if (Math.abs(c.position[0] - cx) + Math.abs(c.position[1] - cy) > 55) {
            this._patrolDir = Math.atan2(cy - c.position[1], cx - c.position[0]);
          } else {
            this._patrolDir = Math.random() * Math.PI * 2;
          }
          this._patrolSteps = 5;
        }
        const dx = Math.round(Math.cos(this._patrolDir) * 12);
        const dy = Math.round(Math.sin(this._patrolDir) * 12);
        let nx = Math.max(15, Math.min(370, c.position[0] + dx));
        let ny = Math.max(15, Math.min(370, c.position[1] + dy));
        const cand = this._pickWalkable(nx, ny, 8);
        if (cand && (cand[0] !== c.position[0] || cand[1] !== c.position[1])) {
          try { c.send(BUILD.requestMove(cand[0], cand[1])); } catch (_) {}
        } else this._patrolSteps = 0;   // 撞界/全堵 → 换向
      }
      // 视野怪物普查（60 秒一条，恒打印：0 只也打印以区分"没怪"和"没数据"）
      if (Date.now() - (this._censusAt || 0) > 60000) {
        this._censusAt = Date.now();
        const census = {};
        for (const ent of c.entities.values()) {
          if (ent.kind === 'mob') census[ent.job] = (census[ent.job] || 0) + 1;
        }
        const total = Object.values(census).reduce((a, b) => a + b, 0);
        this.log(`🔎 视野: 实体${c.entities.size} 怪物×${total}` + (total ? ' ' + Object.entries(census).map(([k, v]) => `#${k}×${v}`).join(' ') : '（无）'));
      }
      return;
    }

    // ⑤ 攻击 / 贴近
    const d = dist2(c.position, this.target.pos);
    if (this.walkOnly && d <= this.attackRange + 1) {
      // 贴近到攻击距离+1 即停，服务器内挂自动开打
      this._stuckCnt = 0; this._wp = null;
      return;
    }
    if (d <= this.attackRange) {
      this._stuckCnt = 0; this._wp = null;
      const lastAtk = (this._atkAt && this._atkAt.get(this.target.gid)) || 0;
      if (!this.attacking.has(this.target.gid) || Date.now() - lastAtk > 6000) {
        const isRetry = Date.now() - lastAtk > 6000;
        this.attacking.add(this.target.gid);
        this._atkAt = this._atkAt || new Map();
        this._atkAt.set(this.target.gid, Date.now());
        try { c.send(BUILD.requestAct(this.target.gid, 7)); this.log(isRetry ? `🔁 重攻击 #${this.target.job}` : `⚔ 攻击 #${this.target.job}`); } catch (_) {}
      }
      return;
    }

    // 贴近：优先 A* 拐点；否则直线/中途拐点；卡住侧步；连卡 4 次拉黑
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
      const S2 = c.stats || {};
      // ① 站起（低血自动坐下会被当成定身；站立=0x0437 自己GID action=3）
      try { c.send(BUILD.requestAct(c.session.GID, 3)); } catch (_) {}
      // ② OpenKore 同款：move 到自身位置，解除攻击锁定并让服务器重发 0x0087
      try { c.send(BUILD.requestMove(px, py)); this.log(`♻ 重同步: 站立+自位移 (${px},${py}) HP${S2.hp || '?'}/${S2.maxhp || '?'} SP${S2.sp || '?'}/${S2.maxsp || '?'}`); } catch (_) {}
      return;
    }
    if (this._stuckCnt >= 4) {
      this._black = this._black || new Map();
      this._black.set(this.target.gid, Date.now() + 30000);
      this.log(`⛔ #${this.target.job} 不可达，拉黑 30 秒换目标`);
      this.target = null; this._wp = null;
      return;
    }

    try {
      // A* 路径：无缓存/走完 → 重算；走到拐点 → 弹出下一个
      if (this.field) {
        if (!this._wp || !this._wp.length) {
          this._wp = this._computeWaypoints(this.target.pos[0], this.target.pos[1]);
        }
        while (this._wp && this._wp.length && dist2(c.position, this._wp[0]) === 0) this._wp.shift();
        if (this._wp && this._wp.length) {
          const w = this._wp[0];
          if (this._stuckCnt >= 2) {
            // 拐点也走不动：重算路径
            this._wp = null;
          } else {
            c.send(BUILD.requestMove(w[0], w[1]));
            if (Date.now() - (this._approachLogAt || 0) > 8000) {
              this._approachLogAt = Date.now();
              this.log(`🧭 追击 #${this.target.job} 距${dist2(c.position, this.target.pos)} 我(${c.position[0]},${c.position[1]}) 下一拐点(${w[0]},${w[1]}) 剩${this._wp.length}段`);
            }
            return;
          }
        }
      }
      if (this._stuckCnt >= 2) {
        const perp = Math.random() < 0.5 ? 1 : -1;
        const ddx = Math.abs(this.target.pos[0] - px) || 1;
        const ddy = Math.abs(this.target.pos[1] - py) || 1;
        let cand = this._pickWalkable(px + perp * Math.min(6, ddy), py - perp * Math.min(6, ddx));
        if (!cand) cand = this._pickWalkable(px - perp * 4, py + perp * 4);
        if (cand) {
          c.send(BUILD.requestMove(cand[0], cand[1]));
          this.log(`🧭 卡住，侧步 (${cand[0]},${cand[1]})`);
        }
        return;
      }
      const mx = this.target.pos[0], my = this.target.pos[1];
      const ddx = mx - px, ddy = my - py;
      const cheb = Math.max(Math.abs(ddx), Math.abs(ddy));
      if (cheb > 11) {
        const wx = px + Math.round(ddx / cheb * SEG_MAX);
        const wy = py + Math.round(ddy / cheb * SEG_MAX);
        c.send(BUILD.requestMove(wx, wy));
      } else {
        c.send(BUILD.requestMove(mx + Math.sign(-ddx), my + Math.sign(-ddy))); // 怪身旁朝我的一格
      }
    } catch (_) {}
  }
}

module.exports = { Hunter, HEAL_ITEM_IDS };
