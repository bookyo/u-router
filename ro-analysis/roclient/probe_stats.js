#!/usr/bin/env node
'use strict';
// 探针：①逐个 statusID(13..18) 各加 1 点，记录 0x00BE/0x00BC 回应 → 摸清 V6 真实映射
//      ②开内挂后静观 3 分钟，打印所有未处理封包 → 捕获防挂机弹窗/踢线触发器
const crypto = require('crypto');
const { ROClient } = require('./lib/client');
const { BUILD } = require('./lib/protocol');

const rand = (n, s) => Array.from({ length: n }, () => s[crypto.randomInt(s.length)]).join('');
const acct = rand(8, 'abcdefghijkmnpqrstuvwxyz23456789');
const pass = 'A1b2c3d';
const charName = 'Mao' + rand(6, 'abcdefghijkmnpqrstuvwxyz23456789');

const c = new ROClient({ line: 'eden', verbosity: 1 });
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
    log(`空账号 → 建猫 ${charName}`);
    c.send(BUILD.makeChar3(charName, 0, 4218, 0, 1, 1));
  }
});
c.on('char_created', (p) => {
  if (p.char) setTimeout(() => c.selectChar(p.char.CharNum), 1500);
});
c.on('zone_info', async (p) => { await c.connectZone(p.ipStr, p.port); });

c.on('map_enter', async (p) => {
  log(`进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]})`);
  setTimeout(() => c.mapLoaded(), 500);
  if (step === 1) {
    step = 2;
    setTimeout(async () => {
      // ① 逐个 statusID 测试：每发一个等回包
      for (const id of [13, 14, 15, 16, 17, 18]) {
        log(`→ 加点测试 statusChange(${id}, 1)`);
        try { c.send(BUILD.statusChange(id, 1)); } catch (e) { log('发送失败 ' + e.message); }
        await new Promise((r) => setTimeout(r, 2000));
      }
      log('① 加点测试完成，8 秒后飞艇去 prt_fild08 开内挂');
      setTimeout(() => {
        log('🚌 飞艇 → prt_fild08');
        try { c.airshipTeleport('prt_fild08', 170, 378); } catch (_) {}
      }, 8000);
    }, 4000);
  }
});

c.on('stat_changed', (p) => log(`   ← 0x00BE 属性变化 statusID=${p.statusID} (${p.key || '?'}) → ${p.value}`));
c.on('status_change_ack', (p) => log(`   ← 0x00BC 加点回执 statusID=${p.statusID} result=${p.result} value=${p.value}`));
c.on('stat_update', (p) => { if (p.key) log(`   ← 0x0ACB ${p.key} = ${p.value}`); });
c.on('status_full', (p) => log(`   ← 0x00BD 全量: 点${p.point} Str${p.str} Agi${p.agi} Vit${p.vit} Int${p.int} Dex${p.dex} Luk${p.luk}`));
c.on('input_dialog', (p) => log(`🔢 数字输入框 NAID=${p.NAID} 题面=${p.question}`));
c.on('dialog_say', (p) => log(`🗣 NPC对话: ${(p.msg || '').slice(0, 80)}`));
c.on('whisper_recv', (p) => log(`💬 [${p.from}] ${p.msg}`));
c.on('server_msg', (p) => log(`📨 ${p.msg}`));
c.on('warp_map', (p) => {
  log(`⚡ 传送 ${p.mapName} @(${p.xPos},${p.yPos})`);
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500);
  if ((p.mapName || '').startsWith('prt_fild08')) {
    setTimeout(() => {
      log('🤖 开内挂（密语 NPC:setautoattack，0x0096）→ 静观 3 分钟');
      try { c.send(BUILD.whisper('NPC:setautoattack', '0')); } catch (_) {}
      setTimeout(async () => {
        log('3 分钟到，主动优雅退出');
        await c.quitClean();
        process.exit(0);
      }, 180000);
    }, 3000);
  }
});
c.on('banned', (p) => { log(`⚠ 被踢 code=${p.code}`); });
c.on('disconnect', () => log('⚡ 断开'));
c.on('login_refuse', (p) => { log('登录被拒 code=' + p.ErrorCode); setTimeout(() => process.exit(1), 1000); });

log(`测试账号: ${acct}_M / ${pass}`);
c.login(acct + '_M', pass, 'eden').catch((e) => { log('登录异常 ' + e.message); process.exit(1); });
