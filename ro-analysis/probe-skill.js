'use strict';
// 只读探针：登录 → 进猫角色 → 抓 ZC.SKILLINFO_LIST(0x010F) 技能列表 → 优雅下线
// 用途：确认「新基础技能」的 SKID 与技能列表 GBK 名解码（不发任何加点/移动/传送封包）
// 用法：node probe-skill.js            # 默认用 accounts.json 里的测试账号
//       RO_USER=xxx RO_PASS=yyy RO_CHAR_NAME=MaoXXXX node probe-skill.js
const path = require('path');
const { ROClient } = require(path.join(__dirname, 'roclient', 'lib', 'client'));

const ACCTS = require(path.join(__dirname, 'roclient', 'accounts.json'));
const acct = ACCTS.find((a) => a.status !== 'done') || ACCTS[0];
const USER = process.env.RO_USER || acct.account;
const PASS = process.env.RO_PASS || acct.password;
const WANT = process.env.RO_CHAR_NAME || 'Mao';       // 角色名前缀匹配（猫 = Mao）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const c = new ROClient({ line: process.env.RO_LINE || 'eden', account: USER, password: PASS });
let got = false;

const hardStop = setTimeout(() => { log('⏱ 超时退出'); c.quitClean().then(() => process.exit(0)); }, 45000);

c.on('login_ok', (p) => c.connectChar(p.ServerList[0].ipStr, p.ServerList[0].port).catch((e) => { log('连角色服失败', e.message); process.exit(1); }));
c.on('login_refuse', (p) => { log('登录被拒 code=' + p.ErrorCode); process.exit(1); });
c.on('char_list', (p) => {
  const chars = p.chars || [];
  log(`角色列表: ${chars.map((ch) => `${ch.name}(Lv${ch.level},job${ch.job})`).join(' ')}`);
  const ch = chars.find((x) => x.name.startsWith(WANT)) || chars[0];
  if (!ch) { log('无角色'); process.exit(1); }
  log(`→ 进入 ${ch.name} [slot ${ch.CharNum}]`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch((e) => { log('连地图服失败', e.message); process.exit(1); }));
c.on('map_enter', (p) => {
  log(`进图 ${(c.mapName || '').replace(/\.gat$/i, '')} @(${p.pos[0]},${p.pos[1]})`);
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
});
c.on('skill_list', (list) => {
  got = true;
  log(`📖 技能列表 ${list.length} 项:`);
  list.forEach((s) => log(`   #${String(s.SKID).padStart(5)} Lv${s.level} up=${s.upgradable}  ${s.name}`));
  const hit = list.filter((s) => /新基础技能|基础技能/.test(s.name));
  log(hit.length ? `🎯 基础技能匹配: ${hit.map((s) => `${s.name}#${s.SKID} Lv${s.level} up=${s.upgradable}`).join(', ')}` : '⚠ 未找到含「基础技能」的技能');
  log(`技能点: ${c.stats && c.stats.skpoint}`);
  setTimeout(() => c.quitClean().then(() => process.exit(0)), 800);
});
c.on('disconnect', () => { if (!got) { log('断开且未收到技能列表'); process.exit(1); } });
c.login(USER, PASS).catch((e) => { log('连接失败:', e.message); process.exit(1); });
