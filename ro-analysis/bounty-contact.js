#!/usr/bin/env node
// 赏金NPC接触测试：道具商人同款问题——站到正确相邻格才能交互
// 尝试多个偏移格，每格：walkSmart到位 → 立刻 talkTo → 选[2]个人任务 → 观察是否有后续包
const path = require('path');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));
const { LoginSession, sleep } = require(path.join(__dirname, 'roclient/lib/modules'));
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);

const ACCOUNT = process.env.RO_USER || 'xiezixing6';
const c = new ROClient({ line: 'eden', account: ACCOUNT, password: process.env.RO_PASS || '' });
const bot = new Bot(c);
const login = new LoginSession(c, { account: ACCOUNT, password: process.env.RO_PASS || '', line: 'eden' }, log);

c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500); });
c.on('char_list', (p) => {
  const ch = p.chars.find((x) => x.CharNum === 0) || p.chars[0];
  log(`角色: ${ch.name}（共${p.chars.length}）`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('map_enter', (p) => {
  log(`进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]})`);
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  setTimeout(() => test().catch(async (e) => { log('异常: ' + e.message); await c.quitClean(); process.exit(1); }), 3000);
});

// 原始封包探针：对话期间记录所有包 PID
let probing = false;
c.on('packet', (p) => {
  if (!probing) return;
  log(`  [包] 0x${p.pid.toString(16).padStart(4, '0')} ${p.pkt.length}B ${p.pkt.slice(0, 24).toString('hex')}`);
});

async function test() {
  // 飞到赏金NPC旁
  log('飞艇 → morocc (166,98)');
  c.airshipTeleport('morocc', 166, 98);
  await sleep(3500);
  bot.updatePos(c.position[0], c.position[1]);
  // 找赏金NPC
  for (let i = 0; i < 5; i++) {
    const hit = [...c.entities.values()].find((e) => e.kind === 'npc' && /赏金/.test(e.name || ''));
    if (hit) break;
    [...c.entities.values()].filter((n) => n.kind === 'npc' && !n.name).forEach((n) => c.reqName(n.GID));
    await sleep(1500);
  }
  const npc = [...c.entities.values()].find((e) => e.kind === 'npc' && /赏金/.test(e.name || ''));
  if (!npc) { log('❌ 未找到赏金NPC'); await c.quitClean(); return process.exit(1); }
  log(`🎯 ${npc.name} @(${npc.pos[0]},${npc.pos[1]}) GID=${npc.GID} 我@(${bot.pos})`);

  // 候选站位（道具商人成功真值是 +2,+1）
  const OFFSETS = [[2, 1], [1, 1], [2, 2], [1, 2], [3, 1]];
  for (const [dx, dy] of OFFSETS) {
    const tx = npc.pos[0] + dx, ty = npc.pos[1] + dy;
    log(`\n━━━ 尝试站位 (${tx},${ty}) = NPC+(${dx},${dy}) ━━━`);
    await new Promise((res) => bot.walkSmart(tx, ty, () => res(), 30000));
    await sleep(600);
    log(`到位 (${bot.pos})`);

    // 对话：开探针 → 立刻 talkTo → 菜单出现选[2] → 观察后续
    const result = await new Promise(async (resolve) => {
      let stage = 'init', menus = 0, says = 0;
      const finish = (r) => { probing = false; cleanup(); setTimeout(() => resolve(r), 400); };
      const onSay = (p) => { says++; if (stage === 'init') stage = 'say'; log(`  💬 ${(p.msg || '').replace(/\^[0-9a-fA-F]{6}/g, '').slice(0, 80)}`); };
      const onWait = (p) => { if (stage === 'menu-wait' || stage === 'say') setTimeout(() => { try { c.nextDialog(p.gid); } catch (_) {} }, 1200); };
      const onMenu = (p) => {
        menus++;
        const opts = p.msg.split(':').filter(Boolean);
        log(`  📋 菜单#${menus}: ${opts.join(' | ').slice(0, 100)}`);
        if (menus === 1) {
          // 顶层菜单 → 个人任务（1基索引=2）
          stage = 'menu-wait';
          setTimeout(() => { try { c.chooseMenu(p.gid, 2); log('  → 已选 [2] 个人任务，等待服务器后续...'); } catch (_) {} }, 600);
        } else {
          // 第二个菜单出现了 = 成功！记录内容
          stage = 'task-menu';
          log(`  🎉 第二级菜单出现（个人任务列表）！`);
          setTimeout(() => { try { c.closeDialog(p.gid); } catch (_) {} }, 300);
          finish({ ok: true, opts });
        }
      };
      const onClose = () => finish({ ok: stage === 'task-menu', stage });
      const cleanup = () => {
        c.removeListener('dialog_say', onSay); c.removeListener('dialog_menu', onMenu);
        c.removeListener('dialog_wait', onWait); c.removeListener('dialog_close', onClose);
      };
      c.on('dialog_say', onSay); c.on('dialog_menu', onMenu);
      c.on('dialog_wait', onWait); c.on('dialog_close', onClose);
      probing = true;
      // 原版真值：到位后立刻 talkTo，不加任何前置
      try { bot.talkTo(npc.GID); } catch (e) { finish({ ok: false, err: e.message }); }
      setTimeout(() => finish({ ok: false, stage, menus, says }), 15000);
    });
    if (result.ok) {
      log(`\n✅✅ 成功站位: NPC+(${dx},${dy}) → 任务列表: ${(result.opts || []).join(' | ')}`);
      await c.quitClean();
      return process.exit(0);
    }
    log(`  ✗ 本站位无后续（stage=${result.stage} menus=${result.menus} says=${result.says}）`);
    // 关闭可能残留的对话状态
    try { c.closeDialog(npc.GID); } catch (_) {}
    await sleep(1200);
  }
  log('\n❌ 所有站位都未出现第二级菜单');
  await c.quitClean();
  process.exit(2);
}

c.on('banned', (p) => { log(`被踢 ${p.code}`); setTimeout(() => process.exit(1), 300); });
login.login();
setTimeout(async () => { log('⏱ 超时'); await c.quitClean(); process.exit(3); }, 240000);
