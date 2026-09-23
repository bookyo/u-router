'use strict';
// 赏金 NPC「刷新任务」对话流探针：个人任务 → 刷新 → 记录全部菜单/文本/原始封包
// 用法：RO_USER=xiezixing2 RO_PASS=your_password node probe-bounty-refresh.js
const path = require('path');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));

const OPT = {
  account: process.env.RO_USER || 'xiezixing2',
  password: process.env.RO_PASS || '',
  line: process.env.RO_LINE || 'eden',
  npcX: 165, npcY: 97, contactX: 167, contactY: 98,
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (m) => console.log(`[${ts()}] ${m}`);
const hex = (b, n = 96) => b.slice(0, n).toString('hex').match(/../g).join(' ');

const c = new ROClient({ line: OPT.line, account: OPT.account, password: OPT.password });
const bot = new Bot(c);
const PKTS = [];
for (const pid of [0x00B4, 0x00B5, 0x00B6, 0x00B7, 0x0081]) {
  c.on('packet', (p) => {
    if (p.pid !== pid) return;
    PKTS.push({ pid: '0x' + pid.toString(16), len: p.pkt.length, hex: hex(p.pkt) });
  });
}

const waitMap = async (m, ms = 15000) => {
  for (let i = 0; i < ms / 500; i++) { await sleep(500); if ((c.mapName || '').includes(m)) return true; }
  return false;
};

c.on('login_ok', (p) => c.connectChar(p.ServerList[0].ipStr, p.ServerList[0].port).catch(() => process.exit(1)));
c.on('login_refuse', (p) => { log('登录被拒 code=' + p.ErrorCode); process.exit(1); });
c.on('char_list', (p) => {
  const ch = (p.chars || []).find((x) => x.level >= 30) || (p.chars || [])[0];
  if (!ch) { log('无角色'); process.exit(1); }
  log(`进入 ${ch.name} Lv${ch.level}（zeny=${ch.money}）`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum, ch.money);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500); });

c.on('map_enter', async () => {
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  await sleep(3000);
  bot.updatePos(c.position[0], c.position[1]);
  // 到赏金 NPC
  if (!(c.mapName || '').includes('morocc')) {
    c.airshipTeleport('morocc', 166, 98);
    if (!(await waitMap('morocc'))) { log('到 morocc 失败'); return c.quitClean().then(() => process.exit(1)); }
    await sleep(2500);
    try { c.mapLoaded(); } catch (_) {}
    await sleep(1000);
    bot.updatePos(c.position[0], c.position[1]);
  }
  await new Promise((res) => bot.walkSmart(169, 98, res, 30000));
  await sleep(300);
  await new Promise((res) => bot.walkSmart(OPT.contactX, OPT.contactY, res, 20000));
  await sleep(800);
  // 找赏金 NPC
  let npc = null;
  for (let i = 0; i < 4 && !npc; i++) {
    npc = [...c.entities.values()].find((e) => e.kind === 'npc' && /赏金/.test(e.name || ''));
    if (!npc) { [...c.entities.values()].filter((n) => n.kind === 'npc' && !n.name).forEach((n) => c.reqName(n.GID)); await sleep(1000); }
  }
  if (!npc) { log('未找到赏金NPC'); return c.quitClean().then(() => process.exit(1)); }
  log(`赏金NPC: ${npc.name} @(${npc.pos[0]},${npc.pos[1]}) GID=${npc.GID}`);

  // 对话：顶层选 个人任务；出现含"刷新"的菜单 → 点刷新；其余原样记录后关闭
  let pickedRefresh = false;
  await new Promise((resolve) => {
    let done = false, depth = 0;
    const fin = () => { if (done) return; done = true; cleanup(); setTimeout(resolve, 600); };
    const onSay = (p) => {
      const clean = (p.msg || '').replace(/\^([0-9a-fA-F]{6})/g, '').trim();
      if (clean) log(`💬 ${clean.slice(0, 160)}`);
    };
    const onMenu = (p) => {
      depth++;
      const opts = p.options || [];
      log(`📋(第${depth}层) ${opts.join(' | ').slice(0, 200)}`);
      if (depth > 8) { try { c.closeDialog(p.gid); } catch (_) {} return fin(); }
      const personal = opts.findIndex((o) => /^个人任务$/.test(o.trim()));
      const refresh = opts.findIndex((o) => /刷新/.test(o) && !/取消|返回/.test(o));
      const confirm = opts.findIndex((o) => /确定|是$|确认/.test(o) && !/取消/.test(o));
      if (refresh >= 0) {
        pickedRefresh = true;
        log(`→ 点[${refresh + 1}] ${opts[refresh]}`);
        setTimeout(() => { try { c.chooseMenu(p.gid, refresh + 1); } catch (_) {} }, 600);
        return;
      }
      if (pickedRefresh && confirm >= 0) {
        log(`→ 确认[${confirm + 1}] ${opts[confirm]}`);
        setTimeout(() => { try { c.chooseMenu(p.gid, confirm + 1); } catch (_) {} }, 600);
        return;
      }
      if (personal >= 0 && depth === 1) {
        log('→ 点[个人任务]');
        setTimeout(() => { try { c.chooseMenu(p.gid, personal + 1); } catch (_) {} }, 500);
        return;
      }
      log('→ 关闭（未识别菜单）');
      setTimeout(() => { try { c.closeDialog(p.gid); } catch (_) {} }, 400);
      setTimeout(fin, 2500);
    };
    const onWait = (p) => setTimeout(() => { try { c.nextDialog(p.gid); } catch (_) {} }, 900);
    const onClose = () => fin();
    const cleanup = () => {
      c.removeListener('dialog_say', onSay); c.removeListener('dialog_menu', onMenu);
      c.removeListener('dialog_wait', onWait); c.removeListener('dialog_close', onClose);
    };
    c.on('dialog_say', onSay); c.on('dialog_menu', onMenu);
    c.on('dialog_wait', onWait); c.on('dialog_close', onClose);
    setTimeout(fin, 40000);
    bot.talkTo(npc.GID);
  });
  await sleep(2500);
  log(`结果: ${pickedRefresh ? '已点到刷新选项' : '未见刷新选项'}，封包 ${PKTS.length} 条`);
  require('fs').writeFileSync('/tmp/probe-refresh-packets.json', JSON.stringify({ account: OPT.account, pickedRefresh, pkts: PKTS }, null, 2));
  log('💾 /tmp/probe-refresh-packets.json');
  await c.quitClean();
  setTimeout(() => process.exit(0), 1500);
});
setTimeout(() => { log('超时退出'); c.quitClean().then(() => process.exit(0)); }, 130000);
log('刷新任务探针启动');
c.login().catch((e) => { log('连接失败: ' + e.message); process.exit(1); });
