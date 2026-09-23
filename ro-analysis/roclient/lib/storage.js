'use strict';
/**
 * 卡普拉仓库存取模块（2026-09-17 probe-storage.js 实测定稿）
 * ============================================================
 * 协议（20211103 新库存协议，OpenKore 模板对照）：
 *   开仓：对话卡普拉选「使用仓库」（自动扣 60z，无确认弹窗）
 *         → 0x0B08(type=2,"Storage") + 0x0B09(type=2, 堆叠34B/项)
 *           + 0x0B39(type=2, 装备68B/项) + 0x00F2(容量 cur/max)
 *   存入：CZ 0x0364（背包 index i16 + amount i16）→ 0x0B44 回执（含仓库 index）
 *   取出：CZ 0x0365（仓库 index i16 + amount i16）→ 0x00F6 回执
 *   关闭：CZ 0x00F7 → 0x00F8
 *   ★ 仓库状态跨会话保持：未关仓下线，重登服务器自动重推列表（storage.open=true）
 *
 * 依赖：client.js 已解析上述封包并维护 c.storage = { open, stackables[], equips[], count, max }
 * 用法（开仓走调用方的对话引擎，注入 talk 回调避免与 bounty-run 的 talkFlow 耦合）：
 *   const storage = new Storage(c, { log });
 *   await storage.openViaKafra(kafraGID, talk);   // talk = (pickerFn, timeoutSec) => Promise
 *   await storage.depositByITID(601, 1);          // 存 1 个苍蝇翅膀
 *   await storage.withdrawByITID(713, 5);         // 取 5 个空瓶
 *   await storage.close();
 */
const { BUILD } = require('./protocol');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Storage {
  /**
   * @param client ROClient
   * @param opts { log }
   */
  constructor(client, opts = {}) {
    this.c = client;
    this.log = opts.log || (() => {});
    this.ackTimeoutMs = opts.ackTimeoutMs ?? 4000;
    this.retries = opts.retries ?? 2;          // 无回执自动重发次数（网络抖动）
    this.retryDelayMs = opts.retryDelayMs ?? 1200;
  }

  get opened() { return !!(this.c.storage && this.c.storage.open); }
  get stackables() { return (this.c.storage && this.c.storage.stackables) || []; }
  get equips() { return (this.c.storage && this.c.storage.equips) || []; }
  get items() { return [...this.stackables, ...this.equips]; }
  get count() { return (this.c.storage && this.c.storage.count) || this.items.length; }
  get max() { return (this.c.storage && this.c.storage.max) || 600; }

  // 等待仓库打开（开仓对话后 0x0B08/0x0B09/0x00F2 任一到达即算开）
  async waitOpen(timeoutMs = 8000) {
    for (let i = 0; i < timeoutMs / 250; i++) {
      if (this.opened) return true;
      await sleep(250);
    }
    return this.opened;
  }

  // 对话卡普拉开仓。talk = 调用方的对话引擎（(picker, timeoutSec) => Promise），
  // 例：bounty-run 的 talkFlow / probe 的 talkFlow。菜单策略内建：选「使用仓库」+ 确认类。
  // 开仓对话被网络吞掉时自动重试（含首次共 3 次）。
  async openViaKafra(kafraGID, talk) {
    if (this.opened) { this.log('📦 仓库已开（跨会话保持），跳过对话'); return true; }
    for (let i = 0; i <= this.retries; i++) {
      await talk(kafraGID, (say, options) => {
        const j = options.findIndex((o) => /使用仓库/.test(o) && !/VIP/.test(o));
        if (j >= 0) return j + 1;
        const k = options.findIndex((o) => /确定|同意|是$|支付|继续/.test(o));
        if (k >= 0) return k + 1;
        return -1;
      }, 30);
      if (await this.waitOpen()) {
        this.log(`📦 仓库已开：${this.count}/${this.max}（堆叠${this.stackables.length} 装备${this.equips.length}）`);
        return true;
      }
      if (i < this.retries) this.log(`⚠ 开仓无响应（第 ${i + 1} 次），重新对话`);
    }
    this.log('⚠ 仓库未打开（多次对话无响应）');
    return false;
  }

  // 存入：背包 index + 数量 → 等 0x0B44 回执（无回执按 retries 重发；返回回执或 null）
  async deposit(invIndex, amount) {
    for (let i = 0; ; i++) {
      const ack = await this._sendAndWait(BUILD.moveItemToStore(invIndex, amount), 'storage_added', (p) => p);
      if (ack) return ack;
      if (i >= this.retries) { this.log(`⚠ 存入 idx${invIndex}×${amount} ${i + 1} 次均无回执，放弃重试`); return null; }
      this.log(`⚠ 存入 idx${invIndex}×${amount} 无回执（第 ${i + 1} 次），${this.retryDelayMs}ms 后重发`);
      await sleep(this.retryDelayMs);
    }
  }

  // 取出：仓库 index + 数量 → 等 0x00F6 回执（同上带重试）
  async withdraw(storeIndex, amount) {
    for (let i = 0; ; i++) {
      const ack = await this._sendAndWait(BUILD.moveItemFromStore(storeIndex, amount), 'storage_removed', (p) => p);
      if (ack) return ack;
      if (i >= this.retries) { this.log(`⚠ 取出 idx${storeIndex}×${amount} ${i + 1} 次均无回执，放弃重试`); return null; }
      this.log(`⚠ 取出 idx${storeIndex}×${amount} 无回执（第 ${i + 1} 次），${this.retryDelayMs}ms 后重发`);
      await sleep(this.retryDelayMs);
    }
  }

  // 发封包并等回执事件（超时返回 null，不重发——重试策略由调用方/deposit/withdraw 控制）
  async _sendAndWait(buf, event, pred) {
    const ack = this._waitAck(event, pred, 0);
    try { this.c.send(buf); } catch (e) { return null; }
    return ack;
  }

  // 按 ITID 存：从背包找该物品（数量足够者）存 amount 个；返回回执或 null
  async depositByITID(ITID, amount) {
    const inv = (this.c.inventory || []).filter((i) => i.ITID === ITID && (i.count == null || i.count >= amount));
    const it = inv[0];
    if (!it) { this.log(`📦 背包无 #${ITID}×${amount}，无法存入`); return null; }
    const r = await this.deposit(it.index, amount);
    if (r) this.log(`📦 已存 #${ITID}×${amount} → 仓库位 ${r.index}`);
    else this.log(`⚠ 存入 #${ITID}×${amount} 无回执`);
    return r;
  }

  // 按 ITID 取：从仓库列表找该物品取 amount 个（堆叠优先，数量不足报错）
  async withdrawByITID(ITID, amount) {
    const cand = this.items.filter((i) => i.ITID === ITID && (i.count == null || i.count >= amount));
    const it = cand[0] || this.items.find((i) => i.ITID === ITID);
    if (!it) { this.log(`📦 仓库无 #${ITID}，无法取出`); return null; }
    const idx = it.index != null ? it.index : it.ID;
    const r = await this.withdraw(idx, amount);
    if (r) this.log(`📦 已取 #${ITID}×${amount}（仓库位 ${idx}）`);
    else this.log(`⚠ 取出 #${ITID}×${amount}（仓库位 ${idx}）无回执`);
    return r;
  }

  async close() {
    try { this.c.send(BUILD.closeStore()); } catch (_) { return; }
    await new Promise((r) => {
      const t = setTimeout(() => { this.c.removeListener('storage_closed', done); r(); }, 3000);
      const done = () => { clearTimeout(t); r(); };
      this.c.once('storage_closed', done);
    });
    if (this.c.storage) this.c.storage.open = false;
    this.log('📦 仓库已关闭');
  }

  // 统一回执等待：等 event 匹配 pred 或超时（superfluous 参数仅注释用）
  _waitAck(event, pred, pidFor) {
    void pidFor;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.c.removeListener(event, onAck); resolve(null); }, this.ackTimeoutMs);
      const onAck = (p) => { clearTimeout(t); resolve(pred ? pred(p) : p); };
      this.c.once(event, onAck);
    });
  }
}

module.exports = { Storage };
