'use strict';
/**
 * 属性加点模块（事件驱动 + 防抖）
 * ============================================================
 * 按 phases 顺序（数组顺序即优先级）把属性加到目标值：
 *   首个未加满的 phase 生效，其内部第一条未达标属性为下一个加点项。
 * 例：猫练级方案
 *   phase1（出生初始）: str→10, agi→10, dex→8
 *   phase2（升级跟进）: dex→19, str→29, agi→99
 *
 * 事件驱动：leveler 把 stat_update/status_full/stat_changed 事件接到 allocate()；
 * 内部防抖（busy 标记），点不够时本轮让位，等下一次同步再触发。
 * 服务器不回执时做一次乐观本地回填（避免刷封包触发反作弊）。
 */
const { BUILD } = require('./protocol');

const STAT_IDS = { str: 13, agi: 14, vit: 15, int: 16, dex: 17, luk: 18 };

// RO 属性点成本：1→2 花 2 点，10→11 花 3 点……
const statCost = (cur) => Math.floor((cur - 1) / 10) + 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class StatAllocator {
  /**
   * @param client ROClient（需已进 zone，用 c.stats 读写状态）
   * @param opts { phases: [[['str',10],...], [...]], log, stepDelayMs, settleDelayMs }
   */
  constructor(client, opts = {}) {
    this.c = client;
    this.phases = opts.phases || [];
    this.log = opts.log || (() => {});
    this.stepDelayMs = opts.stepDelayMs ?? 320;      // 发一次后等服务器回执
    this.settleDelayMs = opts.settleDelayMs ?? 500;  // 没回执时再等一手
    this.onRound = opts.onRound || null;             // 每轮结束回调（工作台状态推送）
    this.busy = false;        // 单飞标记：事件风暴里只跑一轮
    this.enabled = () => true; // 编排器可注入暂停条件（如 30 级收尾中）
  }

  // 是否全部方案已加满（收尾判断用）
  done() {
    const S = this.c.stats || {};
    return this.phases.every((ph) => ph.every(([k, v]) => (S[k] || 0) >= v));
  }

  async allocate() {
    if (this.busy || !this.enabled()) return;
    if (!this.c.stats || this.c.stats.points == null) return;
    this.busy = true;
    try {
      let guard = 0;
      for (;;) {
        if (++guard > 80) break;                        // 单轮最多 80 次防御
        const S = this.c.stats;
        const plan = this.phases.find((ph) => ph.some(([k, v]) => (S[k] || 0) < v));
        if (!plan) break;
        const next = plan.find(([k, v]) => (S[k] || 0) < v);
        if (!next) break;
        const [key] = next;
        const val = S[key] || 1;
        if (statCost(val) > (S.points || 0)) break;     // 点不够，等下次升级/同步再触发
        if (!this.c.ws || this.c.state !== 'zone') break;
        this.c.send(BUILD.statusChange(STAT_IDS[key], 1));
        await sleep(this.stepDelayMs);                 // 等 0x00BE/0x0ACB 回填
        if (!this.c.stats || this.c.stats[key] === val) { // 服务器没认：再等一手，避免刷封包
          await sleep(this.settleDelayMs);
          if (!this.c.stats || this.c.stats[key] === val) {
            this.c.stats.points = Math.max(0, (this.c.stats.points || 0) - statCost(val));
            this.c.stats[key] = val + 1;
          }
        }
      }
      const S = this.c.stats;
      this.log(`✨ 加点轮次完成: Lv${S.level || '?'} 点余${S.points} Str${S.str} Agi${S.agi} Vit${S.vit} Int${S.int} Dex${S.dex} Luk${S.luk}`);
      if (this.onRound) { try { this.onRound(S); } catch (_) {} }
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { StatAllocator, STAT_IDS, statCost };
