'use strict';
// 自动巡路（gat + A*）+ NPC 对话交互
// 关键协议行为（浏览器抓包实证）：
// - 进图后角色可能是"坐下"状态（action=2），走路前必须发 REQUEST_ACT(action=3) 站起
// - 坐着时走路请求会被服务器静默忽略，反复重发会触发反作弊 code=15 踢线
// - 服务器有 MAX_WALKPATH 限制，长路径需分段发送（每段 ≤18 格）
const { loadGat } = require('./gat');
const { findPath } = require('./pathfinding');

const LEG_MAX = 12; // 单段最大直线格数（服务器实测：直线可达才接受，~10-14 格内稳）

// 把 A* 路径压缩成拐点列表（合并同方向连续段）；再切成长度 ≤ LEG_MAX 的直线小段
function pathToLegs(path) {
  const legs = [];
  let start = 0;
  for (let i = 1; i < path.length; i++) {
    const dx1 = path[i][0] - path[i - 1][0], dy1 = path[i][1] - path[i - 1][1];
    const dx0 = path[start + 1] ? path[start + 1][0] - path[start][0] : dx1;
    const dy0 = path[start + 1] ? path[start + 1][1] - path[start][1] : dy1;
    // 方向变化或到末尾 → 结算一段
    if (i === path.length - 1 || dx1 !== dx0 || dy1 !== dy0) {
      const end = i === path.length - 1 ? i : i - 1;
      const segLen = end - start;
      for (let k = LEG_MAX; k < segLen; k += LEG_MAX) legs.push(path[start + k]);
      legs.push(path[end]);
      start = end;
    }
  }
  return legs;
}

class Bot {
  constructor(client) {
    this.c = client;
    this.pos = null;          // [x, y]
    this.mapName = null;
    this.dialog = null;
    this.standing = false;
    this.gat = null;
    this._gatLoads = {};      // 地图名 → Promise
    this._badCells = new Map();   // 实测阻挡格："x,y" → 过期毫秒（卡死时拉黑，A* 重规划绕开）
  }

  updatePos(x, y) { this.pos = [x, y]; }
  updateMap(name) {
    const nm = String(name).replace(/\.gat$/i, '');
    if (this.mapName !== nm) this._badCells.clear();   // 换图：实测阻挡记录不跨图
    this.mapName = nm;
    if (!this._gatLoads[this.mapName]) {
      this._gatLoads[this.mapName] = loadGat(this.mapName)
        .catch((e) => { this.log(`gat 加载失败 ${this.mapName}: ${e.message}`); return null; });
    }
    // 关键修复（2026-09-16）：缓存命中也必须把 this.gat 切回当前图。
    // 旧版只在首次加载时赋值 → 跨图返回后 this.gat 仍是上一张图 →
    // walkable 按错误地图判定 → "目标不可行走" 静默失败（和尚10 卡死根因）
    const want = this.mapName;
    this._gatLoads[want].then((g) => { if (this.mapName === want) this.gat = g; });
    return this._gatLoads[want];
  }
  log(...a) { console.log('[bot]', ...a); }

  stand() {
    this.c.send(require('./protocol').BUILD.requestAct(0, 3)); // action=3 站起
    this.standing = true;
  }

  // ============ A* 巡路 ============
  // walkSmart(tx, ty): 加载地图 gat → A* 全程规划（含实体阻挡）→ 直线分段行走
  walkSmart(tx, ty, onDone, timeoutMs = 120000) {
    const t0 = Date.now();
    const go = async () => {
      if (this.mapName) await this.updateMap(this.mapName);
      if (!this.gat) { this.log(`❌ 无地图数据 ${this.mapName}，巡路失败`); return onDone(new Error(`无地图数据 ${this.mapName}`)); }
      if (!this.gat.walkable(tx, ty)) { this.log(`❌ 目标 (${tx},${ty}) 在 ${this.mapName} 不可行走`); return onDone(new Error(`目标 (${tx},${ty}) 不可行走`)); }
      this.stand();
      await new Promise((r) => setTimeout(r, 600));
      this._march(tx, ty, onDone, t0, timeoutMs, 0);
    };
    go().catch((e) => onDone(e));
  }

  // 视野内实体（NPC/玩家）占格视为阻挡（服务器对穿实体的直线同样拒走）
  blockedByEntities(x, y) {
    for (const e of this.c.entities.values()) {
      if (!e.pos || e.kind === 'pc') continue; // 玩家会移动，不作为长期阻挡
      if (Math.round(e.pos[0]) === x && Math.round(e.pos[1]) === y) return true;
    }
    return false;
  }

  _pruneBad() {
    const now = Date.now();
    for (const [k, exp] of this._badCells) if (exp < now) this._badCells.delete(k);
  }

  // 带实体阻挡的寻路：先按 gat 找路；若失败/穿实体/穿实测阻挡格，把它们标为阻挡重找
  // （实测阻挡=卡死时拉黑的格：gat 表说可走但服务器拒走——V6 地图与 openkore 表有偏差，
  //  2026-09-21 xiezixing8 实录：morocc(166,184) 一带旧逻辑重规划永远算同一条穿墙路线 → 卡死到 NO_NPC 重登）
  _findPathSafe(x, y, tx, ty) {
    this._pruneBad();
    let path = findPath(this.gat, x, y, tx, ty);
    if (!path) return null;
    const throughEntity = path.some(([px, py]) => this.blockedByEntities(px, py));
    if (!throughEntity && this._badCells.size === 0) return path;
    // 复制 gat 并把实体格+实测阻挡格标为阻挡再找一次 → 重规划真正绕开卡死区（自适应"走大道"）
    const { Gat } = require('./gat');
    const types = new Uint8Array(this.gat.types);
    for (const k of this._badCells.keys()) {
      const [bx, by] = k.split(',').map(Number);
      if (bx >= 0 && by >= 0 && bx < this.gat.width && by < this.gat.height) types[by * this.gat.width + bx] = 1;
    }
    for (const e of this.c.entities.values()) {
      if (!e.pos || e.kind === 'pc') continue;
      const ex = Math.round(e.pos[0]), ey = Math.round(e.pos[1]);
      if (ex >= 0 && ey >= 0 && ex < this.gat.width && ey < this.gat.height) types[ey * this.gat.width + ex] = 1;
    }
    const g2 = new Gat(this.gat.width, this.gat.height, types);
    path = findPath(g2, x, y, tx, ty);
    return path || findPath(this.gat, x, y, tx, ty); // 兜底用原图
  }

  // 卡死逃生格：±10 范围随机采样可走格（避开已知阻挡与实体），优先行进方向侧前方
  // （用户算法 2026-09-21：固定 ±2 候选在成片阻挡区会反复撞同一格）
  _pickEscape(px, py, leg) {
    const dx = leg ? Math.sign(leg[0] - px) : 0, dy = leg ? Math.sign(leg[1] - py) : 0;
    const fwd = [], side = [];
    for (let att = 0; att < 20 && fwd.length < 4; att++) {
      const cx = px + Math.floor(Math.random() * 21) - 10;
      const cy = py + Math.floor(Math.random() * 21) - 10;
      if ((cx === px && cy === py) || !this.gat.walkable(cx, cy) || this.blockedByEntities(cx, cy)) continue;
      if (this._badCells.has(`${cx},${cy}`)) continue;
      ((cx - px) * dx + (cy - py) * dy >= 0 ? fwd : side).push([cx, cy]);
    }
    const pool = fwd.length ? fwd : side;
    return pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  }

  _march(tx, ty, onDone, t0, timeoutMs, stuckCount) {
    const tick = () => {
      if (!this.c.ws || this.c.state === 'closed') return onDone(new Error('断线'));
      if (Date.now() - t0 > timeoutMs) return onDone(new Error('巡路超时'));

      const [x, y] = this.pos;
      if (x === tx && y === ty) return onDone(null, this.pos);

      // A* 全程规划 → 直线小段序列（每段与服务器直线校验兼容，避开实体占格）
      const path = this._findPathSafe(x, y, tx, ty);
      if (!path) return onDone(new Error(`无可达路径 (${x},${y})→(${tx},${ty})`));
      if (path.length <= 1) return onDone(null, this.pos);
      const legs = pathToLegs(path);
      this.log(`路线 ${path.length} 格 → ${legs.length} 段直线: ` + legs.slice(0, 6).map((l) => `(${l[0]},${l[1]})`).join('→') + (legs.length > 6 ? '…' : ''));
      this._walkLegs(legs, tx, ty, onDone, t0, timeoutMs, stuckCount);
    };
    tick();
  }

  // 逐段行走：每段等待 0x0087 位置推进；2.5 秒无推进重发，两次重发后重规划
  _walkLegs(legs, tx, ty, onDone, t0, timeoutMs, stuckCount) {
    let legIdx = 0;
    let lastPos = [...this.pos];
    let lastMove = Date.now();
    let resends = 0;
    const sendLeg = () => {
      const leg = legs[legIdx];
      this.c.walk(leg[0], leg[1]);
    };
    sendLeg();
    this._mon = setInterval(() => {
      if (!this.c.ws || this.c.state === 'closed') { clearInterval(this._mon); return onDone(new Error('断线')); }
      const [px, py] = this.pos;
      // 位置推进
      if (px !== lastPos[0] || py !== lastPos[1]) { lastPos = [...this.pos]; lastMove = Date.now(); resends = 0; }
      // 终点
      if (px === tx && py === ty) { clearInterval(this._mon); return onDone(null, this.pos); }
      // 当前段完成（到达段终点±0）→ 下一段
      const leg = legs[legIdx];
      if (leg && px === leg[0] && py === leg[1]) {
        legIdx++;
        if (legIdx >= legs.length) { clearInterval(this._mon); return onDone(null, this.pos); }
        lastMove = Date.now(); resends = 0;
        sendLeg();
        return;
      }
      if (Date.now() - t0 > timeoutMs) { clearInterval(this._mon); return onDone(new Error('巡路超时')); }
      // 卡住处理
      if (Date.now() - lastMove > 2500) {
        lastMove = Date.now();
        if (++resends > 2) {
          clearInterval(this._mon);
          if (++stuckCount > 6) return onDone(new Error(`卡住 (${px},${py})，放弃`));
          this.log(`卡住 @(${px},${py})，重规划（第 ${stuckCount} 次）`);
          this.stand(); // 可能又被置为坐下
          const leg = legs[legIdx];
          // ① 拉黑前进方向前方 1-4 格：服务器实测拒走（gat 说可走是假象）——之后 A* 重规划会绕开该区域
          if (leg) {
            const dx = Math.sign(leg[0] - px), dy = Math.sign(leg[1] - py);
            let added = 0;
            for (let i = 1; i <= 4; i++) {
              const bx = px + dx * i, by = py + dy * i;
              if (bx === leg[0] && by === leg[1]) break;
              if (bx < 0 || by < 0 || !this.gat.walkable(bx, by)) break;
              this._badCells.set(`${bx},${by}`, Date.now() + 30 * 60 * 1000);
              added++;
            }
            if (added) this.log(`🚧 拉黑前方 ${added} 格（服务器实测阻挡），重规划绕开`);
          }
          // ② 侧步：±10 随机逃生格（用户算法 2026-09-21），偏向行进方向侧前方
          const escape = this._pickEscape(px, py, leg);
          if (escape) { this.c.walk(escape[0], escape[1]); this.log(`侧步 → (${escape[0]},${escape[1]})（±10 随机）`); }
          setTimeout(() => this._march(tx, ty, onDone, t0, timeoutMs, stuckCount), 1600); // 等移动生效再重规划
        } else {
          sendLeg();
        }
      }
    }, 300);
  }

  // 点击 NPC 开始对话（含朝向；CHANGE_DIRECTION 在此服会断线，暂不连发）
  talkTo(gid, npcPos) { void npcPos; this.c.contactNpc(gid); }

  // 对话状态机：自动下一步/选择
  handleDialog({ onSay, onMenu, autoClose = true } = {}) {
    this.c.on('dialog_say', (p) => {
      this.dialog = { type: 'say', ...p };
      onSay && onSay(p.gid, p.msg);
    });
    this.c.on('dialog_wait', (p) => {
      setTimeout(() => this.c.nextDialog(p.gid), 350);
    });
    this.c.on('dialog_close', (p) => {
      this.dialog = null;
      if (autoClose) setTimeout(() => this.c.closeDialog(p.gid), 200);
    });
    this.c.on('dialog_menu', (p) => {
      this.dialog = { type: 'menu', ...p };
      let choice = 1;
      if (onMenu) {
        const r = onMenu(p.gid, p.options);
        if (typeof r === 'number') choice = r;
      }
      setTimeout(() => this.c.chooseMenu(p.gid, choice), 400);
    });
  }
}

module.exports = { Bot };
