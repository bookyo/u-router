'use strict';
/**
 * 技能加点模块（收尾阶段用）
 * ============================================================
 * 定位技能（ZC.SKILLINFO_LIST 0x010F）：优先 SKID，否则按名/别名匹配；
 * 逐级发 CZ.SKILL_UP(0x0112)，等服务器回执 ZC.SKILLINFO_UPDATE(0x010E)
 * 确认新等级后再发下一级。
 *
 * 例：猫角色 30 级收尾 → skills: [{ name: '新基础技能', aliases: ['SU_BASIC_SKILL'], SKID: 5018, level: 1 }]
 *
 * ensureAll() 不抛异常，返回 { ok, applied, skipped, failed }：
 *   applied  实际发了加点封包并确认的
 *   skipped  已达目标等级无需加点的
 *   failed   找不到技能 / 不可升级 / 无技能点 / 发送无回执（附原因）
 */
const { BUILD } = require('./protocol');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class SkillAllocator {
  /**
   * @param client ROClient
   * @param opts { skills: [{ name, level }], log, ackTimeoutMs, retryDelayMs, attempts }
   */
  constructor(client, opts = {}) {
    this.c = client;
    this.skills = opts.skills || [];
    this.log = opts.log || (() => {});
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 4000;   // 等 0x010E 回执上限
    this.retryDelayMs = opts.retryDelayMs ?? 1500;
    this.attempts = opts.attempts ?? 3;
  }

  // 技能定位：优先 SKID（服务器侧稳定），否则按名/别名（先精确，再包含）
  // 实测（2026-09-16 probe-skill.js，Eden 线猫角色）：新基础技能 = SU_BASIC_SKILL SKID 5018，
  // 服务器下发的 name 是英文标识 SU_BASIC_SKILL（非中文「新基础技能」），中文匹配只作兜底
  find(spec) {
    const list = this.c.skills || [];
    if (spec.SKID != null) return list.find((s) => s.SKID === spec.SKID) || null;
    const names = [spec.name, ...(spec.aliases || [])].map((n) => String(n).trim());
    const exact = (s) => { const n = String(s.name || '').trim(); return names.includes(n); };
    const fuzzy = (s) => { const n = String(s.name || ''); return names.some((t) => n.includes(t)); };
    return list.find(exact) || list.find(fuzzy) || null;
  }

  // 等待技能列表到位（进图后 0x010F 才到）
  waitForSkillList(timeoutMs = 20000) {
    return new Promise((resolve) => {
      if (this.c.skills && this.c.skills.length) return resolve(true);
      const t = setTimeout(() => { this.c.removeListener('skill_list', done); resolve(false); }, timeoutMs);
      const done = () => { clearTimeout(t); resolve(true); };
      this.c.once('skill_list', done);
    });
  }

  // 把一个技能加到 target 级：发一级 → 等 0x010E 确认 → 下一级
  async raise(sk, target) {
    for (;;) {
      const cur = (this.c.skills || []).find((s) => s.SKID === sk.SKID) || sk;
      if ((cur.level || 0) >= target) return { ok: true, level: cur.level, applied: true };
      if (cur.upgradable === 0) return { ok: false, reason: `技能[${sk.name}]不可升级(upgradable=0)` };
      const pts = this.c.stats && this.c.stats.skpoint;
      if (pts === 0) return { ok: false, reason: `无技能点(还差${target - (cur.level || 0)}级)` };
      // 发一级，等回执（等级上涨即成功）
      const before = cur.level || 0;
      const ackOrTimeout = new Promise((resolve) => {
        const t = setTimeout(() => { this.c.removeListener('skill_up_ack', onAck); resolve(null); }, this.ackTimeoutMs);
        const onAck = (p) => { if (p.SKID === sk.SKID) { clearTimeout(t); resolve(p); } };
        this.c.once('skill_up_ack', onAck);
      });
      try { this.c.send(BUILD.skillUp(sk.SKID)); } catch (e) { return { ok: false, reason: '发送失败: ' + e.message }; }
      const ack = await ackOrTimeout;
      if (!ack) {
        // 服务器没认：本地回填视为失败（不乐观加级，避免错记）
        return { ok: false, reason: `技能[${sk.name}] 0x0112 发出后 ${Math.round(this.ackTimeoutMs / 1000)} 秒无 0x010E 回执` };
      }
      this.log(`🎓 技能[${sk.name}] Lv${before} → Lv${ack.level}（服务器已确认）`);
    }
  }

  // 重试封装：最多 attempts 次（每次间隔 retryDelayMs）
  async ensure(spec) {
    for (let i = 0; i < this.attempts; i++) {
      const sk = this.find(spec);
      if (!sk) return { ok: false, reason: `技能列表里找不到[${spec.name}]${spec.SKID != null ? `(SKID ${spec.SKID})` : ''}` };
      if ((sk.level || 0) >= spec.level) return { ok: true, applied: false, level: sk.level };
      const r = await this.raise(sk, spec.level);
      if (r.ok) return { ...r, applied: true };
      if (i < this.attempts - 1) { this.log(`⚠ ${r.reason}，重试(${i + 2}/${this.attempts})`); await sleep(this.retryDelayMs); }
      else return r;
    }
  }

  async ensureAll(opts = {}) {
    const out = { ok: true, applied: [], skipped: [], failed: [] };
    if (!this.skills.length) return out;
    if (!(await this.waitForSkillList(opts.timeoutMs))) {
      out.ok = false;
      out.failed = this.skills.map((s) => ({ name: s.name, reason: '等待技能列表超时' }));
      return out;
    }
    for (const spec of this.skills) {
      const r = await this.ensure(spec);
      if (!r.ok) { out.ok = false; out.failed.push({ name: spec.name, reason: r.reason }); }
      else if (r.applied) out.applied.push({ name: spec.name, level: r.level });
      else out.skipped.push({ name: spec.name, level: r.level });
    }
    return out;
  }
}

module.exports = { SkillAllocator };
