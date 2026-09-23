'use strict';
// 猫队练级器 v2 模块离线单测：statplan / skillplan / accounts / protocol.skillUp
// 运行：cd ro-analysis/roclient && npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');
const { BUILD } = require('../lib/protocol');
const { ROClient } = require('../lib/client');
const { StatAllocator, statCost } = require('../lib/statplan');
const { SkillAllocator } = require('../lib/skillplan');
const { AccountStore, genPassword } = require('../lib/accounts');

// 测试替身客户端：记录 send，支持手动推进 stats / 触发事件
class FakeClient extends EventEmitter {
  constructor(stats) {
    super();
    this.stats = stats;
    this.skills = null;
    this.ws = true;
    this.state = 'zone';
    this.sent = [];
  }
  send(buf) { this.sent.push(buf); }
  // 模拟服务器认可加点：0x00BE 语义（stats[key] = value+1, points -= cost）
  ackStat(key, val) {
    this.stats[key] = val + 1;
    this.stats.points = Math.max(0, this.stats.points - statCost(val));
  }
  ackSkill(SKID, level) {
    const s = this.skills.find((x) => x.SKID === SKID);
    s.level = level;
    this.stats.skpoint = Math.max(0, (this.stats.skpoint || 0) - 1);
    this.emit('skill_up_ack', { SKID, level, spcost: s.spcost, attackRange: s.attackRange, upgradable: s.upgradable });
  }
}

test('protocol.skillUp: 0x0112 封包布局（SKID 小端 u16）', () => {
  const buf = BUILD.skillUp(0x1234);
  assert.strictEqual(buf.length, 4);
  assert.strictEqual(buf.readUInt16LE(0), 0x0112);
  assert.strictEqual(buf.readUInt16LE(2), 0x1234);
});

// ---------------- 0x00BD 属性同步（真实抓包回放） ----------------
test('client: ZC.STATUS 0x00BD = point@2 + 六维(值+下一级成本)对@4..15（Lv17 猫实包，成本公式锚定）', () => {
  const c = new ROClient({});
  // 真实封包（vyr6k9zt Mao7nptdj Lv17）：点18，Str10/Agi23/Vit1/Int1/Dex18/Luk1
  // 成本列 2/4/2/2/3/2 与 statCost() 完全吻合（agi23→4, dex18→3），尾部 28B 不解析
  const pkt = Buffer.from(
    'bd0012000a0217040102010212030102' +
    '13001e0000000c0010000a000b000000' +
    'd70090000100010058020000', 'hex');
  let evt = null;
  c.once('status_full', (p) => { evt = p; });
  c.dispatch(0x00BD, pkt);
  assert.strictEqual(evt.point, 18);
  assert.strictEqual(evt.str, 10);
  assert.strictEqual(evt.agi, 23);
  assert.strictEqual(evt.vit, 1);
  assert.strictEqual(evt.int, 1);
  assert.strictEqual(evt.dex, 18);
  assert.strictEqual(evt.luk, 1);
  // 成本与官方公式互验
  assert.strictEqual(evt.cost.agi, statCost(23));
  assert.strictEqual(evt.cost.dex, statCost(18));
  assert.strictEqual(evt.cost.str, statCost(10));
  assert.deepStrictEqual(
    { points: c.stats.points, str: c.stats.str, agi: c.stats.agi, vit: c.stats.vit, int: c.stats.int, dex: c.stats.dex, luk: c.stats.luk },
    { points: 18, str: 10, agi: 23, vit: 1, int: 1, dex: 18, luk: 1 });
});

// ---------------- statplan ----------------
test('statplan: 出生方案按顺序 str→agi→dex，升级方案 dex→19→str→29→agi', async () => {
  const PHASE1 = [['str', 10], ['agi', 10], ['dex', 8]];
  const PHASE2 = [['dex', 19], ['str', 29], ['agi', 99]];
  const c = new FakeClient({ level: 1, points: 50, str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 });
  const sa = new StatAllocator(c, { phases: [PHASE1, PHASE2], log: () => {}, stepDelayMs: 0, settleDelayMs: 0 });
  // 让服务器"秒回执"（0x00BB → stats[key]+1，点数按官方成本扣）
  const KEY_OF = { 13: 'str', 14: 'agi', 15: 'vit', 16: 'int', 17: 'dex', 18: 'luk' };
  c.send = (buf) => {
    assert.strictEqual(buf.readUInt16LE(0), 0x00BB);
    const key = KEY_OF[buf.readUInt16LE(2)];
    c.ackStat(key, c.stats[key]);
  };
  // phase1 成本：str 18 + agi 18 + dex 14 = 50 点，恰好用完
  await sa.allocate();
  assert.strictEqual(c.stats.str, 10);
  assert.strictEqual(c.stats.agi, 10);
  assert.strictEqual(c.stats.dex, 8);
  assert.strictEqual(c.stats.points, 0);
  assert.ok(!sa.done(), 'phase2 未加满');
  // dex 8→19 需 2×3 + 3×8 = 30 点
  c.stats.points = 30;
  await sa.allocate();
  assert.strictEqual(c.stats.dex, 19);
  assert.strictEqual(c.stats.points, 0);
  // str 10→29 需 2 + 3×10 + 4×8 = 64 点
  c.stats.points = 64;
  await sa.allocate();
  assert.strictEqual(c.stats.str, 29);
  // agi 10→99 需 610 点；单轮有 80 次防刷上限，线上由升级事件再触发，这里 drain 到加满
  c.stats.points = 610;
  for (let i = 0; i < 5 && !sa.done(); i++) await sa.allocate();
  assert.strictEqual(c.stats.agi, 99);
  assert.ok(sa.done(), '全方案加满');
});

test('statplan: 点不够时本轮让位不发包，enabled=false 时直接跳过', async () => {
  const c = new FakeClient({ level: 1, points: 1, str: 1, agi: 1, vit: 1, int: 1, dex: 1, luk: 1 });
  const sa = new StatAllocator(c, { phases: [[['str', 10]]], log: () => {}, stepDelayMs: 0, settleDelayMs: 0 });
  await sa.allocate();
  assert.strictEqual(c.sent.length, 0, 'str 1→2 要 2 点，1 点不该发');
  sa.enabled = () => false;
  c.stats.points = 50;
  await sa.allocate();
  assert.strictEqual(c.sent.length, 0, 'enabled=false 必须跳过');
});

// ---------------- skillplan ----------------
test('skillplan: 找到技能→发 0x0112→等 0x010E 回执确认', async () => {
  const c = new FakeClient({ level: 30, skpoint: 3 });
  c.skills = [{ SKID: 5001, name: '新基础技能', level: 0, upgradable: 1 }];
  const sk = new SkillAllocator(c, { skills: [{ name: '新基础技能', level: 1 }], log: () => {} });
  c.send = (buf) => {
    assert.strictEqual(buf.readUInt16LE(0), 0x0112);
    assert.strictEqual(buf.readUInt16LE(2), 5001);
    setTimeout(() => c.ackSkill(5001, 1), 10);
  };
  const r = await sk.ensureAll({ timeoutMs: 500 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.applied, [{ name: '新基础技能', level: 1 }]);
  assert.strictEqual(c.skills.find((s) => s.SKID === 5001).level, 1);
  assert.strictEqual(c.stats.skpoint, 2);
});

test('skillplan: 已达目标等级→skip；找不到技能→failed 带原因', async () => {
  const c1 = new FakeClient({ skpoint: 3 });
  c1.skills = [{ SKID: 5001, name: '新基础技能', level: 1, upgradable: 1 }];
  const r1 = await new SkillAllocator(c1, { skills: [{ name: '新基础技能', level: 1 }], log: () => {} }).ensureAll({ timeoutMs: 100 });
  assert.strictEqual(r1.ok, true);
  assert.deepStrictEqual(r1.skipped, [{ name: '新基础技能', level: 1 }]);
  assert.strictEqual(c1.sent.length, 0);

  const c2 = new FakeClient({ skpoint: 3 });
  c2.skills = [{ SKID: 1, name: '基本技能', level: 0, upgradable: 1 }];
  const r2 = await new SkillAllocator(c2, { skills: [{ name: '新基础技能', level: 1 }], log: () => {} }).ensureAll({ timeoutMs: 100 });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.failed[0].reason, /找不到/);
  assert.strictEqual(c2.sent.length, 0);
});

test('skillplan: SKID 定位优先（服务器下发英文名 SU_BASIC_SKILL 也命中「新基础技能」）', async () => {
  const c = new FakeClient({ level: 30, skpoint: 2 });
  // 真实抓包形态：猫角色技能列表只有一项，Lv0 可升级（probe-skill.js 2026-09-16）
  c.skills = [{ SKID: 5018, type: 0, level: 0, spcost: 0, attackRange: 0, name: 'SU_BASIC_SKILL', upgradable: 1 }];
  const spec = { name: '新基础技能', aliases: ['SU_BASIC_SKILL'], SKID: 5018, level: 1 };
  const sk = new SkillAllocator(c, { skills: [spec], log: () => {} });
  c.send = (buf) => {
    assert.strictEqual(buf.readUInt16LE(0), 0x0112);
    assert.strictEqual(buf.readUInt16LE(2), 5018);
    setTimeout(() => c.ackSkill(5018, 1), 5);
  };
  const r = await sk.ensureAll({ timeoutMs: 500 });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.applied, [{ name: '新基础技能', level: 1 }]);
  // 无 SKID 时靠别名兜底命中
  const c2 = new FakeClient({ skpoint: 2 });
  c2.skills = [{ SKID: 5018, level: 0, name: 'SU_BASIC_SKILL', upgradable: 1 }];
  const sk2 = new SkillAllocator(c2, { skills: [{ name: '新基础技能', aliases: ['SU_BASIC_SKILL'], level: 1 }], log: () => {} });
  assert.ok(sk2.find({ name: '新基础技能', aliases: ['SU_BASIC_SKILL'] }), '别名匹配应命中');
});

test('skillplan: 发出后无回执→failed（不乐观加级）', async () => {
  const c = new FakeClient({ skpoint: 3 });
  c.skills = [{ SKID: 5001, name: '新基础技能', level: 0, upgradable: 1 }];
  const sk = new SkillAllocator(c, { skills: [{ name: '新基础技能', level: 1 }], log: () => {}, ackTimeoutMs: 30, retryDelayMs: 5, attempts: 2 });
  c.send = () => {}; // 服务器不回
  const r = await sk.ensureAll({ timeoutMs: 100 });
  assert.strictEqual(r.ok, false);
  assert.match(r.failed[0].reason, /0x010E 回执/);
  assert.strictEqual(c.skills[0].level, 0, '无回执不得本地加级');
});

// ---------------- accounts ----------------
function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-acct-'));
  return { store: new AccountStore(path.join(dir, 'accounts.json'), { log: () => {} }), dir };
}

test('accounts: 新建/记账/完成后按 maxAccounts 停止', () => {
  const { store, dir } = tempStore();
  const a = store.newAccount({ plan: 'cat30-v2' });
  assert.match(a.account, /^[a-z2-9]{8}_M$/);
  assert.strictEqual(store.load().length, 1);
  store.recordChar(a, 'Maoaaaaaa', 0, 30, 30);
  store.recordChar(a, 'Maobbbbbb', 1, 17, 30);
  store.recordChar(a, 'Maoaaaaaa', 0, 31, 30);   // 等级只增不减
  const saved = store.find(a.account);
  assert.strictEqual(saved.chars[0].level, 31);
  assert.ok(saved.chars[0].doneAt);
  assert.strictEqual(saved.chars[1].level, 17);
  // pending 续练：同 plan
  const picked = store.pick({ plan: 'cat30-v2', maxAccounts: 1 });
  assert.strictEqual(picked.account, a.account);
  // 完成后停止
  store.update(a, { status: 'done' });
  assert.strictEqual(store.pick({ plan: 'cat30-v2', maxAccounts: 1 }), null);
  // maxAccounts=0 无限制：继续开新账号
  const unlimited = store.pick({ plan: 'cat30-v2', maxAccounts: 0 });
  assert.ok(unlimited.account.endsWith('_M'));
  assert.notStrictEqual(unlimited.account, a.account);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accounts: 不同 plan 的 pending 账号不会被续练（老存档隔离）', () => {
  const { store, dir } = tempStore();
  store.newAccount({ plan: 'old-human-plan' });
  const fresh = store.pick({ plan: 'cat30-v2', maxAccounts: 0 });
  assert.notStrictEqual(fresh.account, store.load()[0].account);
  assert.strictEqual(fresh.plan, 'cat30-v2');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accounts: RO_ACCOUNT 指定存档外账号需带密码；指定存档内账号强制回 pending', () => {
  const { store, dir } = tempStore();
  assert.strictEqual(store.pick({ specified: 'stranger', plan: 'p' }), null, '无密码不允许');
  const ext = store.pick({ specified: 'myacct:mypass', plan: 'cat30-v2' });
  assert.strictEqual(ext.account, 'myacct');
  assert.strictEqual(ext.loginName, 'myacct');
  assert.strictEqual(ext.password, 'mypass');
  // 存档内：done 账号被指定时回 pending 继续用
  const done = store.newAccount({ plan: 'cat30-v2' });
  store.update(done, { status: 'done' });
  const again = store.pick({ specified: done.account, plan: 'cat30-v2' });
  assert.strictEqual(again.account, done.account);
  assert.strictEqual(again.status, 'pending');
  // loginName 也能命中
  const byLogin = store.pick({ specified: 'myacct', plan: 'cat30-v2' });
  assert.strictEqual(byLogin.account, 'myacct');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('accounts: genPassword 7 位必含大小写数字', () => {
  for (let i = 0; i < 50; i++) {
    const p = genPassword();
    assert.strictEqual(p.length, 7);
    assert.match(p, /[A-Z]/);
    assert.match(p, /[a-z]/);
    assert.match(p, /\d/);
  }
});
