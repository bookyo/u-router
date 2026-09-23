#!/usr/bin/env node
'use strict';
// 探针②：新号建猫 → 进图 → 飞 prt_fild08 → 不开内挂，静观 4 分钟
// 目标：捕获"进图即弹"的验证码/计算题封包 + 断线触发器（verbose 全开）
const crypto = require('crypto');
const { ROClient } = require('./lib/client');
const { BUILD } = require('./lib/protocol');

const rand = (n, s) => Array.from({ length: n }, () => s[crypto.randomInt(s.length)]).join('');
const acct = rand(8, 'abcdefghijkmnpqrstuvwxyz23456789');
const pass = 'A1b2c3d';
const charName = 'Mao' + rand(6, 'abcdefghijkmnpqrstuvwxyz23456789');

const c = new ROClient({ line: 'eden', verbose: true });   // 注意：构造器选项是 verbose
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);
let step = 0;

c.on('login_ok', async (p) => {
  log(`登录成功 AID=${p.AID} sex=${p.Sex}`);
  const s = p.ServerList[0];
  await c.connectChar(s.ipStr, s.port);
});
c.on('char_list', (p) => {
  if (step === 0 && p.chars.length === 0) {
    step = 1;
    log(`空账号 → 建猫 ${charName} (head=1, sex=1)`);
    c.send(BUILD.makeChar3(charName, 0, 4218, 0, 1, 1));
  }
});
c.on('char_created', (p) => { if (p.char) setTimeout(() => c.selectChar(p.char.CharNum), 1500); });
c.on('zone_info', async (p) => { await c.connectZone(p.ipStr, p.port); });

c.on('map_enter', (p) => {
  log(`进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]})`);
  setTimeout(() => c.mapLoaded(), 500);
  if (step === 1) {
    step = 2;
    setTimeout(() => {
      log('🚌 飞艇 → prt_fild08（不开内挂，纯观察）');
      try { c.airshipTeleport('prt_fild08', 170, 378); } catch (_) {}
    }, 6000);
  }
});

c.on('warp_map', (p) => {
  log(`⚡ 传送 ${p.mapName} @(${p.xPos},${p.yPos})`);
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500);
  if ((p.mapName || '').startsWith('prt_fild08')) {
    setTimeout(async () => {
      log('⏳ 静观 4 分钟（重点看弹窗/断线）');
      setTimeout(async () => { log('4 分钟到，优雅退出'); await c.quitClean(); process.exit(0); }, 240000);
    }, 3000);
  }
});

// —— 弹窗相关全部打日志 ——
c.on('input_dialog', (p) => log(`🔢 数字输入框 NAID=${p.NAID} 题面=${p.question}`));
c.on('dialog_say', (p) => log(`🗣 NPC对话 gid=${p.gid}: ${(p.msg || '').slice(0, 100)}`));
c.on('dialog_menu', (p) => log(`📋 NPC菜单 gid=${p.gid}: ${p.options.join(' / ').slice(0, 100)}`));
c.on('dialog_wait', (p) => log(`⏭ NPC对话等待下一步 gid=${p.gid}`));
c.on('dialog_close', (p) => log(`❎ NPC对话关闭 gid=${p.gid}`));
c.on('whisper_recv', (p) => log(`💬 [${p.from}] ${p.msg}`));
c.on('server_msg', (p) => log(`📨 ${p.msg}`));
c.on('npc_chat', (p) => { if (/验证|计算|答题|挂机/.test(p.msg || '')) log(`🗣 ${p.msg}`); });
c.on('banned', (p) => log(`⚠ 被踢 code=${p.code}`));
c.on('disconnect', () => log('⚡ 断开'));
c.on('login_refuse', (p) => { log('登录被拒 code=' + p.ErrorCode); setTimeout(() => process.exit(1), 1000); });

log(`新测试账号: ${acct}_M / ${pass}`);
c.login(acct + '_M', pass, 'eden').catch((e) => { log('登录异常 ' + e.message); process.exit(1); });
