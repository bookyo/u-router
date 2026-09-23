'use strict';
// 聊天自动应答 —— 移植自 OpenKore ChatQueue.pm（消息排队 + 人类节奏延迟 + 规则匹配）
// 用法：
//   const auto = new AutoChat(client, { minDelay: 900, maxDelay: 1800 });
//   auto.rule({ match: '你好', reply: '欢迎~ 直接发商品关键词，我报最低价' });
//   auto.rule({ match: /^(.+)$/, mode: 'regex', reply: async (sp, text) => {...} });
//   room.on('room_message', (m) => auto.feed(m.speaker, m.text, { room }));
class AutoChat {
  /**
   * @param client ROClient（用其 .chat 发送）
   * @param opts {minDelay, maxDelay, cooldownMs} 毫秒
   */
  constructor(client, opts = {}) {
    this.c = client;
    this.minDelay = opts.minDelay != null ? opts.minDelay : 900;
    this.maxDelay = opts.maxDelay != null ? opts.maxDelay : 1800;
    this.defaultCooldown = opts.cooldownMs != null ? opts.cooldownMs : 3000;
    this.rules = [];
    this.queue = [];
    this._busy = false;
    this._lastAt = new Map();     // 规则索引 -> 上次触发时间（冷却）
  }

  /** 添加规则：{match, mode:'exact'|'includes'|'prefix'|'regex', reply, cooldownMs, applies} */
  rule(r) {
    const rule = {
      mode: r.mode || 'includes',
      match: r.match,
      reply: r.reply,
      cooldownMs: r.cooldownMs != null ? r.cooldownMs : this.defaultCooldown,
      applies: r.applies || null,
    };
    if (rule.mode === 'regex' && !(rule.match instanceof RegExp)) {
      rule.match = new RegExp(rule.match, 'i');
    }
    this.rules.push(rule);
    return this; // 链式
  }

  /** 收到消息入口（由 room_message / whisper 等事件喂入）。返回是否命中规则 */
  feed(speaker, text, ctx = {}) {
    for (let i = 0; i < this.rules.length; i++) {
      const rule = this.rules[i];
      if (rule.applies && !rule.applies(speaker, text, ctx)) continue;
      if (!this._match(rule, text)) continue;
      const last = this._lastAt.get(i) || 0;
      if (Date.now() - last < rule.cooldownMs) return false; // 冷却中：忽略（OpenKore 不重复刷屏）
      this._lastAt.set(i, Date.now());
      const reply = typeof rule.reply === 'function' ? rule.reply(speaker, text, ctx) : rule.reply;
      Promise.resolve(reply).then((r) => {
        if (r == null) return;
        const arr = Array.isArray(r) ? r : [r];
        arr.filter((x) => x != null && x !== '').forEach((x) => this.enqueue(String(x)));
      }).catch(() => {});
      return true;
    }
    return false;
  }

  _match(rule, text) {
    const t = String(text).trim();
    switch (rule.mode) {
      case 'exact': return t === String(rule.match);
      case 'prefix': return t.startsWith(String(rule.match));
      case 'regex': return rule.match.test(t);
      case 'includes':
      default: return t.includes(String(rule.match));
    }
  }

  /** 入队一条待发消息（OpenKore ChatQueue 逐条按人类节奏发送） */
  enqueue(text) {
    this.queue.push(text);
    this._drain();
  }

  _drain() {
    if (this._busy || !this.queue.length) return;
    this._busy = true;
    const text = this.queue.shift();
    const delay = this.minDelay + Math.random() * Math.max(0, this.maxDelay - this.minDelay);
    setTimeout(() => {
      try { this.c.chat(text); } catch (_) {}
      this._busy = false;
      this._drain(); // 下一条
    }, delay);
  }
}

module.exports = { AutoChat };
