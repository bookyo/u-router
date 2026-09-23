'use strict';
// 仓库（卡普拉）封包探针：对话开仓(60z) → 抓列表/回执布局 → 存1取1 往返 → 关仓下线
// 卡普拉职员 @ morocc (155,98)（用户提供的真值坐标）
// 用法：RO_USER=xxx RO_PASS=yyy node probe-storage.js
const path = require('path');
const fs = require('fs');
const { ROClient } = require(path.join(__dirname, 'roclient/lib/client'));
const { Bot } = require(path.join(__dirname, 'roclient/lib/bot'));
const { BUILD } = require(path.join(__dirname, 'roclient/lib/protocol'));
const { BinaryWriter } = require(path.join(__dirname, 'roclient/lib/binary'));

const OPT = {
  account: process.env.RO_USER || 'xiezixing3',
  password: process.env.RO_PASS || '',
  line: process.env.RO_LINE || 'eden',
  kafra: { map: 'morocc', x: 155, y: 98 },
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (m) => console.log(`[${ts()}] ${m}`);
const hex = (b, n = 48) => b.slice(0, n).toString('hex').match(/../g).join(' ');

const c = new ROClient({ line: OPT.line, account: OPT.account, password: OPT.password });
c.on('sp_update', (p) => { if (p.type === 24) log(`💰 SP24=${p.val}`); });
const bot = new Bot(c);

// ---------- 封包记录 ----------
const PKT_LOG = [];
const KNOWN = new Set([0x007F, 0x0088, 0x009F, 0x00A0, 0x00F3, 0x023B, 0x02CB, 0x02C4, 0x02D1, 0x02D2, 0x02DA, 0x02E8, 0x0306, 0x0307, 0x0308]);
c.on('packet', (p) => {
  if (KNOWN.has(p.pid)) return;
  PKT_LOG.push({ t: ts(), pid: '0x' + p.pid.toString(16).padStart(4, '0'), len: p.pkt.length, hex: hex(p.pkt) });
  log(`[包] 0x${p.pid.toString(16).padStart(4, '0')} ${p.pkt.length}B ${hex(p.pkt, 32)}`);
});
// 仓库相关 ID 的事件（合并单监听，避免 MaxListeners 警告；client.js 解析后仍留原始字节）
const STOR_PIDS = new Set([0x0995, 0x0B44, 0x00F2, 0x00F6, 0x00F8, 0x0A2D, 0x0B39, 0x0B75, 0x0B4D, 0x0B08, 0x0B0B]);
c.on('packet', (p) => {
  if (!STOR_PIDS.has(p.pid)) return;
  PKT_LOG.push({ t: ts(), pid: '0x' + p.pid.toString(16), len: p.pkt.length, hex: p.pkt.toString('hex'), storage: true, raw: p.pkt.toString('base64') });
  log(`[仓库包] 0x${p.pid.toString(16)} ${p.pkt.length}B`);
});

const waitMap = async (m, ms = 15000) => {
  for (let i = 0; i < ms / 500; i++) { await sleep(500); if ((c.mapName || '').includes(m)) return true; }
  return false;
};
async function walkTo(x, y, t = 40000) {
  await new Promise((res) => bot.walkSmart(x, y, () => res(), t));
  await sleep(300);
}
async function scanNpc(re, rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    const hit = [...c.entities.values()].find((e) => e.kind === 'npc' && re.test(e.name || ''));
    if (hit) return hit;
    const un = [...c.entities.values()].filter((n) => n.kind === 'npc' && !n.name);
    if (un.length) un.forEach((n) => c.reqName(n.GID));
    await sleep(1000);
  }
  return [...c.entities.values()].find((e) => e.kind === 'npc' && re.test(e.name || ''));
}
// 对话状态机（精简版 bounty-run talkFlow：菜单选择 + say 记录）
function talkFlow(npcGID, picker, timeoutSec = 30, onSay = null) {
  return new Promise((resolve) => {
    let resolved = false, lastSay = '';
    const done = () => { if (resolved) return; resolved = true; cleanup(); setTimeout(resolve, 500); };
    const onSayE = (p) => {
      const clean = (p.msg || '').replace(/\^([0-9a-fA-F]{6})/g, '').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      lastSay = clean;
      log(`💬 ${clean.slice(0, 100)}`);
      if (onSay) try { onSay(clean); } catch (_) {}
    };
    const onMenu = (p) => {
      const choice = picker(lastSay, p.options, p.gid);
      log(`📋 ${p.options.join(' | ').slice(0, 110)} → ${choice > 0 ? `[${choice}] ${p.options[choice - 1]}` : choice === -1 ? '关闭' : '不选'}`);
      if (choice === -1) { setTimeout(() => { try { c.closeDialog(p.gid); } catch (_) {} }, 300); setTimeout(done, 2500); return; }
      if (choice > 0) setTimeout(() => { try { c.chooseMenu(p.gid, choice); } catch (_) {} }, 500);
      else setTimeout(() => { try { c.closeDialog(p.gid); } catch (_) {} }, 300);
    };
    const onWait = (p) => setTimeout(() => { try { c.nextDialog(p.gid); } catch (_) {} }, 1000);
    const onClose = () => done();
    const cleanup = () => {
      c.removeListener('dialog_say', onSayE); c.removeListener('dialog_menu', onMenu);
      c.removeListener('dialog_wait', onWait); c.removeListener('dialog_close', onClose);
    };
    c.on('dialog_say', onSayE); c.on('dialog_menu', onMenu);
    c.on('dialog_wait', onWait); c.on('dialog_close', onClose);
    setTimeout(done, timeoutSec * 1000);
    bot.talkTo(npcGID);
  });
}

// ---------- 存取封包构造（20211103：0x0364 存 / 0x0365 取，index i16@2 + amount i16@4） ----------
function buildMove(pid, index, amount) {
  const b = Buffer.alloc(8);
  b.writeUInt16LE(pid, 0);
  b.writeInt16LE(index, 2);
  b.writeInt16LE(amount, 4);
  return b;
}

// ---------- 主流程 ----------
let storageOpened = false;
async function main() {
  // 到卡普拉
  c.airshipTeleport(OPT.kafra.map, OPT.kafra.x, OPT.kafra.y);
  if (!(await waitMap(OPT.kafra.map))) throw new Error('到 morocc 失败');
  await sleep(2500);
  bot.updatePos(c.position[0], c.position[1]);
  try { c.mapLoaded(); } catch (_) {}
  await sleep(1500);
  let npc = await scanNpc(/卡普拉/, 5);
  if (!npc) npc = [...c.entities.values()].filter((e) => e.kind === 'npc' && e.pos &&
    Math.abs(e.pos[0] - OPT.kafra.x) <= 7 && Math.abs(e.pos[1] - OPT.kafra.y) <= 7)[0];
  if (!npc) throw new Error('未找到卡普拉');
  if (!npc.name) { c.reqName(npc.GID); await sleep(1200); }
  log(`卡普拉: ${npc.name || '#' + npc.GID} @(${npc.pos[0]},${npc.pos[1]})`);
  // 接触落定
  let spot = null;
  for (let r = 1; r <= 2 && !spot; r++) {
    for (let dy = -r; dy <= r && !spot; dy++) for (let dx = -r; dx <= r && !spot; dx++) {
      if (!dx && !dy) continue;
      if (bot.gat && bot.gat.walkable(npc.pos[0] + dx, npc.pos[1] + dy)) spot = [npc.pos[0] + dx, npc.pos[1] + dy];
    }
  }
  if (spot) {
    await walkTo(spot[0] + 2, spot[1], 15000);
    await walkTo(spot[0], spot[1], 25000);
  }
  await sleep(500);
  // 对话开仓 → 模块化 存1取1 往返 → 关仓（全部走 lib/storage.js）
  const { Storage } = require(path.join(__dirname, 'roclient/lib/storage'));
  const storage = new Storage(c, { log: (m) => log(m) });
  const ok = await storage.openViaKafra(npc.GID, talkFlow);
  if (ok) {
    log(`仓库: ${storage.count}/${storage.max} 堆叠${storage.stackables.length} 装备${storage.equips.length}`);
    log(`仓库前 10: ` + storage.items.slice(0, 10).map((i) => `#${i.ITID}${i.count != null ? '×' + i.count : '(装)'}@${i.index}`).join(' '));
    // 存入测试：苍蝇翅膀601/空瓶713/廉价药水 1 个
    const inv = c.inventory || [];
    const junk = inv.find((i) => [601, 713].includes(i.ITID) && (i.count || 0) >= 1)
      || inv.find((i) => (i.count || 0) >= 2 && (i.ITID >= 501 && i.ITID <= 545 || [756, 757].includes(i.ITID)));
    if (junk) {
      log(`背包测试物品: #${junk.ITID} idx=${junk.index} count=${junk.count}`);
      const ack = await storage.depositByITID(junk.ITID, 1);
      log(`存入回执: ${JSON.stringify(ack)}`);
      if (ack && ack.index != null) {
        await sleep(800);
        const r2 = await storage.withdraw(ack.index, 1);
        log(`取回回执: ${JSON.stringify(r2)}`);
      }
    } else {
      log('背包无测试物品，仅验证取出现有空瓶/卷轴');
      const got = await storage.withdrawByITID(713, 1) || await storage.withdrawByITID(601, 1);
      log(`取出回执: ${JSON.stringify(got)}`);
      if (got && got.index != null) {
        await sleep(800);
        const back = await storage.depositByITID(got.index, 1);   // 取出的是背包 idx？不——depositByITID 按 ITID 找背包
      }
    }
    await storage.close();
    await sleep(1500);
  }

  fs.writeFileSync('/tmp/probe-storage-packets.json', JSON.stringify(PKT_LOG, null, 2));
  log(`💾 封包记录 ${PKT_LOG.length} 条 → /tmp/probe-storage-packets.json`);
  await c.quitClean();
}

c.on('login_ok', (p) => c.connectChar(p.ServerList[0].ipStr, p.ServerList[0].port).catch((e) => { log('连角色服失败 ' + e.message); process.exit(1); }));
c.on('login_refuse', (p) => { log('登录被拒 code=' + p.ErrorCode); process.exit(1); });
c.on('char_list', (p) => {
  const ch = (p.chars || []).find((x) => x.level >= 30) || (p.chars || [])[0];
  if (!ch) { log('无角色'); process.exit(1); }
  log(`进入 ${ch.name} Lv${ch.level}`);
  c.session.charName = ch.name;
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch(() => process.exit(1)));
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500); });
c.on('map_enter', async () => {
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  await sleep(3000);
  bot.updatePos(c.position[0], c.position[1]);
  main().catch((e) => { log('流程异常: ' + e.message); c.quitClean().then(() => process.exit(1)); });
});
setTimeout(() => { log('超时退出'); c.quitClean().then(() => process.exit(0)); }, 180000);
log('仓库探针启动');
c.login().catch((e) => { log('连接失败: ' + e.message); process.exit(1); });
