#!/usr/bin/env node
'use strict';
/**
 * 挂机保姆 CLI（工作台 worker 进程）
 * 用法：
 *   node afk-runner.js probe  --account X --pass Y [--line eden]                # 取角色列表（JSON）
 *   node afk-runner.js skills --account X --pass Y --slot N [--line eden]       # 取绑定角色技能（JSON）
 *   node afk-runner.js cycle  --config '<JSON>'                                  # 单次巡视周期
 * cycle config: {account,password,line,slot,map,mobs:[],atk:{id,lv,pro},sup:{id,lv,on},attackDis,skillDis,extra:{}}
 */
const path = require('path');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const cmd = process.argv[2];

if (cmd === 'cycle') {
  const cfg = JSON.parse(arg('config', '{}'));
  const { AFKBot } = require(path.join(__dirname, 'roclient/lib/afk'));
  new AFKBot(cfg).start();
  setTimeout(() => { console.log('⏱ 周期超时'); process.exit(3); }, 15 * 60 * 1000);
  process.on('SIGTERM', () => process.exit(0));
  return;
}

// ---------- probe / skills：只读探查，优雅退出 ----------
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));
const { LoginSession } = require(path.join(__dirname, 'roclient/lib/modules'));
const account = arg('account'), password = arg('pass'), line = arg('line', 'eden'), slot = parseInt(arg('slot', '0'), 10);
const c = new ROClient({ line, account, password });
new Bot(c);
const login = new LoginSession(c, { account, password, line, backoff: { refuse8: 10000, refuse2: 10000 } }, () => {});
c.on('char_list', (p) => {
  if (cmd === 'probe') {
    console.log(JSON.stringify({ ok: true, chars: p.chars.map((x) => ({ slot: x.CharNum, name: x.name, level: x.level, job: x.job })) }));
    return c.quitClean().finally(() => process.exit(0));
  }
  const ch = p.chars.find((x) => x.CharNum === slot);
  if (!ch) { console.log(JSON.stringify({ ok: false, error: 'no-slot' })); process.exit(1); }
  c.session.charName = ch.name;
  c.selectChar(slot);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('map_enter', () => {
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  setTimeout(() => {
    const skills = (c.skills || []).filter((s) => s.level > 0)
      .map((s) => ({ SKID: s.SKID, name: (s.name || '').trim(), level: s.level, range: s.attackRange }));
    console.log(JSON.stringify({ ok: true, char: c.session.charName, map: c.mapName, skills }));
    c.quitClean().finally(() => process.exit(0));
  }, 4000);
});
c.on('banned', (p) => { console.log(JSON.stringify({ ok: false, error: 'banned ' + p.code })); process.exit(2); });
login.login();
setTimeout(() => { console.log(JSON.stringify({ ok: false, error: 'timeout' })); c.quitClean().finally(() => process.exit(3)); }, 120000);
