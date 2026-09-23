#!/usr/bin/env node
// 赏金NPC选单静默诊断：选[2]个人任务后 22s 内记录全部原始封包
// 重点验证：是否收到 0x00B5 wait（导致 nextDialog 死循环）、重发选择是否有效
const path = require('path');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));
const { LoginSession, sleep } = require(path.join(__dirname, 'roclient/lib/modules'));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);

const ACCOUNT = process.env.RO_USER || 'xiezixing6';
const SLOT = parseInt(process.env.RO_SLOT || '1', 10);   // 默认和尚1（16:04 成功过的角色）
const c = new ROClient({ line: 'eden', account: ACCOUNT, password: process.env.RO_PASS || '' });
const bot = new Bot(c);
const login = new LoginSession(c, { account: ACCOUNT, password: process.env.RO_PASS || '', line: 'eden' }, log);

c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500); });
c.on('char_list', (p) => {
  const ch = p.chars.find((x) => x.CharNum === SLOT) || p.chars[0];
  log(`角色: ${ch.name}`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('map_enter', (p) => {
  log(`进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]})`);
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  setTimeout(() => diag().catch(async (e) => { log('异常: ' + e.stack); await c.quitClean(); process.exit(1); }), 3000);
});

// 全程原始封包记录（对话期间）
let probing = false;
const rawLog = [];
c.on('packet', (p) => {
  if (!probing) return;
  const line = `0x${p.pid.toString(16).padStart(4, '0')} ${p.pkt.length}B ${p.pkt.slice(0, 28).toString('hex')}`;
  rawLog.push(line);
  log(`  [包] ${line}`);
});

async function diag() {
  log('飞艇 → morocc (167,98)');
  c.airshipTeleport('morocc', 167, 98);
  await sleep(3500);
  bot.updatePos(c.position[0], c.position[1]);
  // 找赏金NPC
  let npc = null;
  for (let i = 0; i < 5 && !npc; i++) {
    npc = [...c.entities.values()].find((e) => e.kind === 'npc' && /赏金/.test(e.name || ''));
    if (!npc) {
      [...c.entities.values()].filter((n) => n.kind === 'npc' && !n.name).forEach((n) => c.reqName(n.GID));
      await sleep(1500);
    }
  }
  if (!npc) { log('未找到赏金NPC'); await c.quitClean(); return process.exit(1); }
  log(`🎯 ${npc.name} @(${npc.pos[0]},${npc.pos[1]}) 我@(${bot.pos})`);

  // ===== 第 1 轮：自动翻页到顶级菜单，选[2]后只观察（不自动翻页）=====
  await new Promise(async (resolve) => {
    let menus = 0, waited = false, choiceGid = 0;
    const done = () => { probing = false; cleanup(); setTimeout(resolve, 300); };
    const onSay = (p) => log(`  💬 ${(p.msg || '').replace(/\^[0-9a-fA-F]{6}/g, '').slice(0, 90)}`);
    const onWait = (p) => {
      log(`  ⏳ WAIT(0x00B5)${menus === 0 ? ' → 1.2s 后翻页' : '（选单后！不翻页，纯观察）'}`);
      if (menus === 0) setTimeout(() => { try { c.nextDialog(p.gid); } catch (_) {} }, 1200);
      waited = true;
    };
    const onMenu = (p) => {
      menus++;
      log(`  📋 菜单#${menus}: ${p.msg.slice(0, 120)}`);
      if (menus === 1) {
        choiceGid = p.gid;
        setTimeout(() => { log('  → 发送 chooseMenu(2)'); try { c.chooseMenu(p.gid, 2); } catch (_) {} }, 600);
        // 10s 无第二级菜单 → 重发一次
        setTimeout(() => {
          if (menus < 2) { log('  ⚠ 10s 无第二级菜单 → 重发 chooseMenu(2)'); try { c.chooseMenu(choiceGid, 2); } catch (_) {} }
        }, 10600);
      } else {
        log('  🎉 第二级菜单出现!');
        setTimeout(() => { try { c.closeDialog(p.gid); } catch (_) {} }, 400);
      }
    };
    const onClose = () => { log('  ✖ CLOSE(0x00B6) → 回 0x0146 确认'); try { c.closeDialog; } catch (_) {} done(); };
    const cleanup = () => {
      c.removeListener('dialog_say', onSay); c.removeListener('dialog_menu', onMenu);
      c.removeListener('dialog_wait', onWait); c.removeListener('dialog_close', onClose);
    };
    c.on('dialog_say', onSay); c.on('dialog_menu', onMenu);
    c.on('dialog_wait', onWait); c.on('dialog_close', onClose);
    probing = true;
    try { bot.talkTo(npc.GID); } catch (_) { done(); }
    setTimeout(() => { log(`  ⏱ 25s 观察窗结束（菜单x${menus} wait=${waited}）`); done(); }, 25000);
  });

  // 关闭第 1 轮残留对话（防走路被判非法）
  try { c.closeDialog(npc.GID); } catch (_) {}
  await sleep(1500);

  // ===== 第 2 轮：走开再回来重新对话 =====
  log('\n━━━ 第 2 轮：走位落定后重新对话 ━━━');
  await new Promise((res) => bot.walkSmart(171, 98, () => res(), 20000));
  await sleep(500);
  await new Promise((res) => bot.walkSmart(167, 98, () => res(), 20000));
  await sleep(600);
  rawLog.length = 0;
  await new Promise(async (resolve) => {
    let menus = 0;
    const done = () => { probing = false; cleanup(); setTimeout(resolve, 300); };
    const onSay = (p) => log(`  💬 ${(p.msg || '').replace(/\^[0-9a-fA-F]{6}/g, '').slice(0, 90)}`);
    const onWait = (p) => { log('  ⏳ WAIT(0x00B5) → 1.2s 后翻页'); setTimeout(() => { try { c.nextDialog(p.gid); } catch (_) {} }, 1200); };
    const onMenu = (p) => {
      menus++;
      log(`  📋 菜单#${menus}: ${p.msg.slice(0, 120)}`);
      if (menus === 1) {
        setTimeout(() => { log('  → 发送 chooseMenu(2)'); try { c.chooseMenu(p.gid, 2); } catch (_) {} }, 600);
        // 8s 无第二级菜单 → 重发一次
        setTimeout(() => {
          if (menus < 2) { log('  ⚠ 8s 无第二级菜单 → 重发 chooseMenu(2)'); try { c.chooseMenu(p.gid, 2); } catch (_) {} }
        }, 8600);
      } else {
        log('  🎉 第二级菜单出现!');
        setTimeout(() => { try { c.closeDialog(p.gid); } catch (_) {} }, 400);
      }
    };
    const onClose = () => { log('  ✖ CLOSE'); done(); };
    const cleanup = () => {
      c.removeListener('dialog_say', onSay); c.removeListener('dialog_menu', onMenu);
      c.removeListener('dialog_wait', onWait); c.removeListener('dialog_close', onClose);
    };
    c.on('dialog_say', onSay); c.on('dialog_menu', onMenu);
    c.on('dialog_wait', onWait); c.on('dialog_close', onClose);
    probing = true;
    try { bot.talkTo(npc.GID); } catch (_) { done(); }
    setTimeout(() => { log(`  ⏱ 25s 结束（菜单x${menus}）`); done(); }, 25000);
  });

  log('\n诊断完成，优雅退出');
  await c.quitClean();
  process.exit(0);
}

c.on('banned', (p) => { log(`被踢 ${p.code}`); setTimeout(() => process.exit(1), 300); });
login.login();
setTimeout(async () => { log('⏱ 总超时'); await c.quitClean(); process.exit(3); }, 180000);
