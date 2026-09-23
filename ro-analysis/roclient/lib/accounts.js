'use strict';
/**
 * 账号存档模块（accounts.json 持久化）
 * ============================================================
 * 职责：账号生成(_M 自动注册)、进度记账(每只角色等级)、账号选择策略。
 * 与练级流程解耦，可被任意编排器复用。
 *
 * 记录结构：
 *   { account, password, loginName?, createdAt, status: pending|done|failed|cooldown,
 *     failReason, plan?, chars: [{ name, slot, level, doneAt? }] }
 *
 * 选择策略 pick({ specified, plan, maxAccounts })：
 *   1. specified = "账号名" 或 "账号名:密码"（RO_ACCOUNT）→ 指定账号练级：
 *      存档里有则复用（强制置回 pending），没有则用给定密码建档（无密码则报错）
 *   2. 否则优先续练：同 plan 且 pending 的账号（崩溃恢复，不重复开号）
 *   3. 否则新建账号（打 plan 标记，老存档不混入）
 *   4. 已完成账号数达到 maxAccounts(>0) → 返回 null（收工）
 */
const fs = require('fs');
const crypto = require('crypto');

function randChars(n, set) {
  let s = '';
  for (let i = 0; i < n; i++) s += set[crypto.randomInt(set.length)];
  return s;
}

function genPassword() { // 7 位，必含大小写+数字
  const up = 'ABCDEFGHJKLMNPQRSTUVWXYZ', low = 'abcdefghijkmnpqrstuvwxyz', dig = '23456789';
  const all = up + low + dig;
  let p = [up[crypto.randomInt(up.length)], low[crypto.randomInt(low.length)], dig[crypto.randomInt(dig.length)]];
  for (let i = 3; i < 7; i++) p.push(all[crypto.randomInt(all.length)]);
  for (let i = p.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [p[i], p[j]] = [p[j], p[i]]; }
  return p.join('');
}

class AccountStore {
  constructor(file, opts = {}) {
    this.file = file;
    this.log = opts.log || (() => {});
  }

  load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { return []; }
  }
  save(list) {
    fs.writeFileSync(this.file, JSON.stringify(list, null, 2));
  }

  newAccount(extra = {}) {
    const acct = {
      account: randChars(8, 'abcdefghijkmnpqrstuvwxyz23456789') + '_M', // _M 后缀登录即自动注册
      password: genPassword(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      failReason: '',
      chars: [],
      ...extra,
    };
    const list = this.load();
    list.push(acct);
    this.save(list);
    return acct;
  }

  // 指定账号名（存档 account 字段或去 _M 的 loginName 均可命中）
  find(name) {
    return this.load().find((x) => x.account === name || x.loginName === name) || null;
  }

  _indexOf(acct) {
    return this.load().findIndex((x) => x.account === acct.account && x.createdAt === acct.createdAt);
  }

  update(acct, patch) {
    const list = this.load();
    const i = this._indexOf(acct);
    if (i >= 0) { list[i] = { ...list[i], ...patch }; this.save(list); return list[i]; }
    return null;
  }

  // 记账角色等级；到 lvDone 补 doneAt
  recordChar(acct, name, slot, level, lvDone) {
    const list = this.load();
    const i = this._indexOf(acct);
    if (i < 0) return;
    const ch = list[i].chars.find((c) => c.slot === slot);
    if (ch) {
      ch.level = Math.max(ch.level || 0, level);
      if (level >= lvDone) ch.doneAt = ch.doneAt || new Date().toISOString();
    } else {
      list[i].chars.push({ name, slot, level });
    }
    this.save(list);
  }

  doneCount() {
    return this.load().filter((x) => x.status === 'done').length;
  }

  // 解析 RO_ACCOUNT："name" 或 "name:password"；forceNew=跳过续练/指定，直接开新号
  pick(opts = {}) {
    const { specified, plan, maxAccounts = 0, forceNew } = opts;
    if (!forceNew && specified) {
      const idx = specified.indexOf(':');
      const name = idx > 0 ? specified.slice(0, idx) : specified;
      const password = idx > 0 ? specified.slice(idx + 1) : '';
      const found = this.find(name);
      if (found) {
        const patch = { status: 'pending', failReason: '' };
        if (password) patch.password = password;
        this.log(`🎯 指定账号 ${found.account}（已有角色 ${(found.chars || []).length}）`);
        return this.update(found, patch) || found;
      }
      if (!password) return null; // 陌生账号必须带密码
      this.log(`🎯 指定账号 ${name}（存档外新纪录）`);
      return this.newAccount({
        account: name,
        loginName: name.endsWith('_M') ? name.slice(0, -2) : name,
        password,
        plan,
      });
    }
    // 续练：同 plan 且 pending（崩溃恢复）；forceNew（工作台"新号"标签）跳过
    if (!forceNew) {
      const resume = this.load().find((x) => x.status === 'pending' && x.plan === plan);
      if (resume) { this.log(`▶ 续练账号 ${resume.account}（已有角色 ${(resume.chars || []).length}）`); return resume; }
    }
    if (maxAccounts > 0 && this.doneCount() >= maxAccounts) return null;
    const acct = this.newAccount(plan ? { plan } : {});
    this.log(`🆕 新账号: ${acct.account} / ${acct.password}（_M 登录即注册）`);
    return acct;
  }
}

module.exports = { AccountStore, genPassword, randChars };
