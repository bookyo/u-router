'use strict';
// 快速诊断：登录 → 打印地图/坐标/HP/背包(找传送卷轴14527) → 再发一次飞艇看响应码
const path = require('path');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const c = new ROClient({ line: process.env.RO_LINE || 'eden', account: process.env.RO_USER || 'xiezixing3', password: process.env.RO_PASS || '' });
let attempts = 0;
let airshipCode = null;

c.on('login_ok', (p) => c.connectChar(p.ServerList[0].ipStr, p.ServerList[0].port).catch((e) => { log('连角色服失败', e.message); process.exit(1); }));
c.on('login_refuse', (p) => { log('登录被拒 code=' + p.ErrorCode); if (++attempts < 3) return setTimeout(() => c.login().catch(() => {}), 20000); process.exit(1); });
c.on('char_list', (p) => {
  const ch = p.chars[0];
  log(`角色: ${ch.name} Lv${ch.level} 存档图=${(ch.lastMap || '').replace(/\0/g, '')}`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch((e) => { log('连地图服失败', e.message); process.exit(1); }));
c.on('airship_response', (p) => { airshipCode = p.code; });
c.on('map_enter', async (p) => {
  log(`进图 ${(c.mapName || '').replace(/\.gat$/i, '')} @(${p.pos[0]},${p.pos[1]})`);
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  await sleep(4000); // 等物品栏同步
  const inv = c.inventory || [];
  log(`HP: ${c.stats && c.stats.hp || '?'} / ${c.stats && c.stats.maxhp || '?'}`);
  log(`背包 ${inv.length} 件:`, inv.slice(0, 20).map((i) => `#${i.ITID}×${i.count}`).join(' '));
  const wings = inv.filter((i) => i.ITID === 14527 || i.ITID === 601);
  log(`传送相关:`, wings.length ? wings.map((i) => `#${i.ITID}×${i.count}`).join(' ') : '无(14527卷轴/601苍蝇翅都没找到)');
  // 重发一次飞艇，抓响应码
  log('重发飞艇 → prontera，等待 0x0A4A 响应码…');
  c.airshipTeleport('prontera', 156, 117);
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    if (airshipCode != null) break;
  }
  log('飞艇响应码:', airshipCode != null ? airshipCode : '（15 秒无响应）', '{0/1=受理 2=无卷轴 3=该图不支持 4=当前图禁用}');
  c.quitClean().then(() => process.exit(0));
});
log('诊断启动');
c.login().catch((e) => { log('连接失败:', e.message); process.exit(1); });
