#!/usr/bin/env node
// BotConfig 在线验证 v2：读角色技能表 → 用角色真实技能下发 → 断言回执值不被清零
const path = require('path');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));
const { BUILD } = require(path.join(__dirname, 'roclient/lib/protocol'));
const { BotConfig } = require(path.join(__dirname, 'roclient/lib/botconfig'));
const { LoginSession, sleep } = require(path.join(__dirname, 'roclient/lib/modules'));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);

const ACCOUNT = process.env.RO_USER || 'xiezixing3';   // 有 30 级巫师
const c = new ROClient({ line: 'eden', account: ACCOUNT, password: process.env.RO_PASS || '' });
new Bot(c);
const bc = new BotConfig(c, log);
const login = new LoginSession(c, { account: ACCOUNT, password: process.env.RO_PASS || '', line: 'eden' }, log);

const echoes = [];
let skills = [];
c.on('bot_setting', (p) => echoes.push(p));
c.on('skill_list', (list) => {
  skills = list.filter((s) => s.lv > 0);
  log(`📚 已学技能 ${skills.length} 个: ` + skills.slice(0, 12).map((s) => `#${s.SKID}:${(s.name || '').trim()}Lv${s.lv}`).join(' '));
});
c.on('char_list', (p) => {
  const ch = p.chars.find((x) => /巫师|法师/.test(x.name)) || p.chars.find((x) => x.level >= 30) || p.chars[0];
  log(`角色: ${ch.name} Lv${ch.level}`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('map_enter', () => {
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  setTimeout(() => test().catch(async (e) => { log('异常: ' + e.message); await c.quitClean(); process.exit(1); }), 4000);
});

async function test() {
  await sleep(2500);  // 等技能列表
  const firebolt = 19;  // MG_FIREBOLT 标准SKID
  // 无技能则现学（无点数时服务器会忽略）
  for (let i = 0; i < 3; i++) { c.send(BUILD.skillUp(firebolt)); await sleep(300); }
  await sleep(1500);
  log(`📚 学习后技能表 ${skills.length} 个: ` + skills.map((s) => `#${s.SKID}:${(s.name || '').trim()}Lv${s.lv}`).join(' '));
  const hasFB = skills.some((s) => s.SKID === firebolt && s.lv > 0);
  if (!hasFB) log('⚠ 火箭术未学到（无技能点？）— 仍尝试下发设置观察回执');
  const lv = Math.max(1, (skills.find((s) => s.SKID === firebolt) || {}).lv || 3);
  log(`\n=== 下发：主动技能=火箭术#${firebolt} Lv${lv} 100% / 攻击距离1 / 瞬移HP35 ===`);
  echoes.length = 0;
  bc.setAutoSkill(firebolt, lv, 100);
  bc.set('攻击距离', 1);
  bc.set('瞬移HP', 35);
  bc.set('自动战斗', 1);
  bc.set('自动战斗', 0);   // 测完即关，不留下自动战斗
  await sleep(3500);
  log(`\n回执 ${echoes.length} 条: ` + echoes.map((p) => `[${p.id}]=${p.value}`).join(' '));
  const got = {};
  echoes.forEach((p) => { got[p.id] = p.value; });
  let ok = true;
  const chk = (id, v, label) => {
    if (got[id] !== v) { log(`❌ ${label}[${id}] 回执 ${got[id]} ≠ 下发 ${v}`); ok = false; }
    else log(`✅ ${label}[${id}] = ${v}`);
  };
  chk(39, firebolt, '主动技能ID');
  chk(40, lv, '主动技能等级');
  chk(1, 1, '攻击距离');
  log(ok ? '\n🎉 服务器接受并保持设置值 — 内挂封包链路完备' : '\n⚠ 部分值被服务器重置（见上）');
  await sleep(600);
  await c.quitClean();
  process.exit(ok ? 0 : 1);
}

c.on('banned', (p) => { log(`被踢 ${p.code}`); setTimeout(() => process.exit(1), 300); });
login.login();
setTimeout(async () => { log('⏱ 超时'); await c.quitClean(); process.exit(3); }, 120000);
