#!/usr/bin/env node
'use strict';
// SmartHunter 实战测试：xiezixing5 → 新手区打怪（全流程在线，不裸断线）
const path = require('path');
const base = path.join(__dirname);
const { ROClient } = require(path.join(base, 'roclient/lib/client'));
const { Bot } = require(path.join(base, 'roclient/lib/bot'));
const { BUILD } = require(path.join(base, 'roclient/lib/protocol'));
const { SmartHunter } = require(path.join(base, 'roclient/lib/smart-hunter'));
const { LoginSession, sleep } = require(path.join(base, 'roclient/lib/modules'));

const OPT = {
  account: process.env.RO_USER || 'xiezixing5',
  password: process.env.RO_PASS || '',
  slot: parseInt(process.env.RO_SLOT || '0', 10),
  map: process.env.RO_MAP || 'prt_fild08',
  x: parseInt(process.env.RO_X || '208', 10),
  y: parseInt(process.env.RO_Y || '235', 10),
  duration: parseInt(process.env.RO_SECONDS || '120', 10),   // 测试时长
};
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);
const c = new ROClient({ line: 'eden', account: OPT.account, password: OPT.password });
const bot = new Bot(c);
const login = new LoginSession(c, { account: OPT.account, password: OPT.password, line: 'eden',
  backoff: { refuse8: 12000, refuse2: 12000, disconnect: 12000, hang: 45000, banned: 12000 } }, log);
let hunter = null;
const t0 = Date.now();

c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500); });
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('banned', (p) => {
  log(`被踢 code=${p.code}`);
  if ([8, 2, 0, 15].includes(p.code)) { try { c.closeAllSockets(); } catch (_) {} login.relogin(12000, '挤号'); }
});
c.on('char_list', (p) => {
  const ch = p.chars.find((x) => x.CharNum === OPT.slot) || p.chars[0];
  log(`角色: ${ch.name} Lv${ch.level}`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('map_enter', async () => {
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  setTimeout(() => main().catch((e) => { log('异常: ' + e.message); cleanup(); }), 3500);
});

async function main() {
  await sleep(2000);
  // ① 关自动战斗（34→0），开拾取（35→1 概率50%）和吃药（36→1）
  c.send(BUILD.notifyUpdateinfo(34, 0));
  await sleep(400);
  c.send(BUILD.notifyUpdateinfo(35, 1));
  await sleep(400);
  c.send(BUILD.notifyUpdateinfo(20, 50));   // 拾取概率 50%
  await sleep(400);
  c.send(BUILD.notifyUpdateinfo(36, 1));   // 自动吃药
  await sleep(400);
  c.send(BUILD.notifyUpdateinfo(21, 60));  // HP<60% 吃药
  log('⚙ 内挂：战斗=OFF 拾取=ON(50%) 吃药=ON(HP<60%)');

  // ② 传送到练级区
  for (let hop = 0; hop < 3 && String(c.mapName).replace(/\.gat$/, '') !== OPT.map; hop++) {
    log(`🚌 飞艇 → ${OPT.map}（当前 ${c.mapName}）`);
    c.send(BUILD.airshipRequest(OPT.map, OPT.x, OPT.y, 1, 14527));
    for (let i = 0; i < 24; i++) { await sleep(500); if (String(c.mapName).replace(/\.gat$/, '') === OPT.map) break; }
    await sleep(2500);
  }
  if (String(c.mapName).replace(/\.gat$/, '') !== OPT.map) { log('❌ 飞艇未达，用当前图'); OPT.map = String(c.mapName).replace(/\.gat$/, ''); }
  bot.updateMap(OPT.map); bot.updatePos(c.position[0], c.position[1]);
  log(`📍 ${c.mapName} @(${c.position})`);

  // ③ 等技能表
  await sleep(2000);
  const skills = (c.skills || []).filter((s) => s.level > 0);
  log(`📚 已学 ${skills.length} 技能: ` + skills.slice(0, 8).map((s) => `#${s.SKID}:${(s.name || '').trim()}Lv${s.level}`).join(' '));

  // ④ 启动 SmartHunter（全打，有技能用技能）
  const skillSlots = [];
  // 法师系技能映射
  // 全职业攻击技能 SKID → range（法师/盗贼/剑士/弓手/商人/服事）
  const SKILL_MAP = {
    // 法师（巫师）
    19: 9, 14: 9, 20: 9, 13: 9, 11: 9, 84: 9, 85: 9, 83: 9, 90: 9, 21: 9, 12: 9, 15: 9,
    // 盗贼
    48: 1, 49: 9,     // 二连矢（近战1格）、投掷石（远程）
    // 剑士
    5: 1, 7: 1,       // 狂击、怒爆
    // 弓手
    46: 9, 47: 9,     // 二连矢、箭雨
    // 商人
    38: 1,            // 金钱攻击
    // 服事
    157: 9, 158: 9,   // 圣光、十字驱魔
  };
  for (const s of skills) {
    const range = SKILL_MAP[s.SKID];
    if (range) skillSlots.push({ SKID: s.SKID, level: Math.min(s.level, 10), range, spCost: 5 });
  }
  log(`⚔ 技能槽: ${skillSlots.map((s) => `#${s.SKID}Lv${s.level}R${s.range}`).join(' ') || '无（纯普攻）'}`);

  hunter = new SmartHunter(c, {
    targets: [],   // 全打
    skills: skillSlots,
    attackRange: 1,
    scanRange: 15,
    center: [OPT.x, OPT.y],
    giveupSec: 20,
    hpPct: 0.4,
    log,
  });
  hunter.setMap(OPT.map, [OPT.x, OPT.y]);
  hunter.start();

  // ⑤ 定时输出统计
  const statsIv = setInterval(() => {
    if (!hunter) return;
    const S = c.stats || {};
    log(`📊 Lv${S.level || '?'} HP${S.hp || '?'}/${S.maxhp || '?'} SP${S.sp || '?'}/${S.maxsp || '?'} 击杀${hunter.kills} 阶段${hunter.stage} 目标${hunter.target ? '#' + hunter.target.job : '无'}`);
  }, 15000);

  // ⑥ 到时间 → 干净退出
  setTimeout(async () => {
    clearInterval(statsIv);
    log('⏱ 测试时间到 → RESTART 干净退出');
    cleanup();
  }, OPT.duration * 1000);
}

function cleanup() {
  if (hunter) hunter.stop();
  c.quitClean().finally(() => {
    log('✅ 优雅退出完成（RESTART，不进离线模式）');
    process.exit(0);
  });
}

login.login();
setTimeout(() => { log('总超时'); cleanup(); }, (OPT.duration + 120) * 1000);
