'use strict';
// 离线测试客户端入口：登录 → 角色列表 → 选角 → 进地图 → 收集实体/NPC
const { ROClient } = require('./lib/client');
const iconv = require('iconv-lite');

const OPT = {
  account: process.env.RO_USER || 'xiezixing',
  password: process.env.RO_PASS || '',
  line: process.env.RO_LINE || 'eden', // V6-Eden
  charSlot: parseInt(process.env.RO_CHAR || '0', 10),
  verbose: !!process.env.RO_VERBOSE,
  runSeconds: parseInt(process.env.RO_SECONDS || '45', 10),
};

const c = new ROClient({ line: OPT.line, verbose: OPT.verbose, account: OPT.account, password: OPT.password, pin: process.env.RO_PIN || '2197' });
let stage = 'login';
let rotState = null; // 角色轮换状态（须在事件处理器前声明）
let charServerIdx = 0;
let gotZoneInfo = false;

const t = setTimeout(() => { console.log('\n[超时] 测试窗口结束'); c.close(); process.exit(0); }, OPT.runSeconds * 1000);
t.unref();

c.on('login_ok', (p) => {
  console.log(`\n✅ 登录成功 AID=${p.AID} Sex=${p.Sex} 服务器数=${p.ServerList.length}`);
  p.ServerList.forEach((s, i) => console.log(`   [${i}] ${s.name} ${s.ipStr}:${s.port} 在线=${s.usercount} 状态=${s.state}`));
  const srv = p.ServerList[charServerIdx] || p.ServerList[0];
  if (!srv) { console.log('无可用角色服务器'); process.exit(1); }
  stage = 'char';
  c.connectChar(srv.ipStr, srv.port).catch((e) => { console.error('连角色服失败', e.message); process.exit(1); });
});

let attempts = 0;
function startLogin() {
  attempts++;
  console.log(`--- 第 ${attempts} 次尝试登录 ---`);
  c.login().catch((e) => { console.error('连接失败:', e.message); process.exit(1); });
}
c.on('login_refuse', (p) => {
  const reasons = { 1: '账号不存在/认证失败', 2: '密码错误', 3: '被封禁', 4: '密码过期/邮箱变更', 5: '数据库错误', 6: '封禁至' + p.blockDate, 7: '服务器满', 8: '重复登录保护(会话未释放)', 9: '权限不足(Mobile)', 10: '需要通过网页认证' };
  console.log(`❌ 登录失败 code=${p.ErrorCode} ${reasons[p.ErrorCode] || ''} ${p.blockDate || ''} 来源=${p.from || 'login'}`);
  if (attempts < 6 && (p.ErrorCode === 8 || p.from === 'zone')) {
    const wait = p.from === 'zone' ? 75000 : 30000; // zone 认证失败=幽灵角色未超时，需等更久
    console.log(`   ${Math.round(wait / 1000)} 秒后重试...`);
    setTimeout(startLogin, wait);
    return;
  }
  process.exit(1);
});
c.on('banned', (p) => {
  // 轮换中：被踢（幽灵会话/重复登录）→ 回到挤号循环重试
  if (typeof rotState !== 'undefined' && rotState) {
    console.log(`被踢 code=${p.code} → 15 秒后再挤一次`);
    clearTimeout(rotRetryTimer);
    rotState.waitingList = false;
    if (rotState.phase === 'rotate') rotState.phase = 'squeeze';
    rotRetryTimer = setTimeout(() => rotateSqueeze(), 15000);
    return;
  }
  console.log('被踢 code=', p.code);
  if ((p.code === 8 || p.code === 2) && attempts < 5) {
    console.log('   60 秒后重试...');
    setTimeout(startLogin, 60000);
    return;
  }
  process.exit(1);
});

c.on('char_list', (p) => {
  if (typeof rotState !== 'undefined' && rotState) return; // 轮换中：由轮换循环驱动选角
  console.log(`\n✅ 角色列表（槽位=${p.TotalSlotNum}）`);
  p.chars.forEach((ch, i) => {
    console.log(`   [slot ${ch.CharNum}] ${ch.name} Lv${ch.level} job=${ch.job} HP=${ch.hp}/${ch.maxhp} 地图=${ch.lastMap} Str=${ch.Str} Agi=${ch.Agi} Vit=${ch.Vit}`);
  });
  if (!p.chars.length) { console.log('无角色'); process.exit(0); }
  if (process.env.RO_ROTATE) { rotState = null; return rotateScenario(p.chars); }
  const mine = p.chars.find((ch) => ch.CharNum === OPT.charSlot) || p.chars[0];
  console.log(`\n→ 选择角色 slot=${mine.CharNum} (${mine.name})`);
  c.session.charName = mine.name;
  stage = 'zone-wait';
  c.selectChar(mine.CharNum);
});

c.on('zone_info', (p) => {
  console.log(`\n✅ 地图服务器: ${p.mapName}.gat @ ${p.ipStr}:${p.port} GID=${p.GID}`);
  stage = 'zone';
  gotZoneInfo = true;
  c.connectZone(p.ipStr, p.port).catch((e) => { console.error('连地图服失败', e.message); process.exit(1); });
});

// ============ 测试场景：普隆德拉找卡普拉 → 菜单传送梦罗克 → A* 巡路 (140,90) ============
const { Bot } = require('./lib/bot');
const bot = new Bot(c);
const TARGET = { map: (process.env.RO_MAP || 'morocc').replace(/\.gat$/i, ''), x: parseInt(process.env.RO_TX || '140', 10), y: parseInt(process.env.RO_TY || '90', 10) };
// 卡普拉候选位置（按地图：普隆德拉/艾尔帕兰…），rAthena 常规布局
const KAFRA_SPOTS_BY_MAP = {
  prontera: [[146, 89], [132, 216], [282, 200]],
  izlude: [[134, 93], [196, 129], [122, 148]],
  morocc: [[153, 88], [105, 122]],
};
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('warp_map', (p) => {
  bot.updateMap(p.mapName);
  bot.updatePos(p.xPos, p.yPos);
  bot.standing = false;
  // 换图后服务器重置进图流程：须重发 ACTORINIT（地图加载完成），否则所有动作被忽略
  setTimeout(() => { try { c.mapLoaded(); console.log('→ 换图后已重发 ACTORINIT'); } catch (_) {} }, 1500);
});

c.on('map_enter', (p) => {
  stage = 'zone-connected';
  console.log(`\n✅ 进入地图 ${c.mapName} 出生点 (${p.pos[0]}, ${p.pos[1]})`);
  setTimeout(() => {
    c.mapLoaded();
    console.log('→ 已发送 ACTORINIT');
    bot.updatePos(p.pos[0], p.pos[1]);
    bot.updateMap(c.mapName);
    setTimeout(() => (process.env.RO_QUEST ? questScenario() : process.env.RO_BOUNTY ? bountyScenario() : mainScenario()), 3000);
  }, 500);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 菜单选择策略：优先"梦罗克"，次选"传送服务"类入口，避免"取消/存储/仓库"等
function menuPick(options) {
  const avoid = /取消|返回|关闭|结束|谢谢|存储|仓库|充电|手推车|情报/;
  const patterns = [/梦罗克|摩洛克|莫洛克|morocc/i, /使用传送|传送服务|传送/, /^是$|确定|继续|支付|Zeny/, /普隆德拉|首都/];
  for (const re of patterns) {
    const i = options.findIndex((o) => re.test(o) && !avoid.test(o));
    if (i >= 0) return { idx: i + 1, opt: options[i] };
  }
  const i = options.findIndex((o) => !avoid.test(o));
  return { idx: (i >= 0 ? i : 0) + 1, opt: options[i >= 0 ? i : 0] };
}

async function scanKafra() {
  // 查询视野内所有 NPC 名字，返回带"卡普"的 NPC
  const npcs = [...c.entities.values()].filter((e) => e.kind === 'npc');
  const unnamed = npcs.filter((n) => !n.name);
  if (unnamed.length) {
    unnamed.forEach((n) => c.reqName(n.GID));
    await sleep(1500);
  }
  return npcs.find((n) => /卡普|kafra/i.test(n.name || ''));
}

// 跨图中转表：先走到本图的出口传送格，触发 0x0091 换图后继续主场景
const MAP_HOPS = {
  prt_sewb1: [127, 68],   // 下水道 → 普隆德拉入口
  prt_sewb2: [180, 14],
};

// ============ 角色轮换 ============
// 流程（依据服务器实测行为设计）：
//   阶段A 挤号：反复"重登 → 选目标角色 → 进图"，直到成功进图（幽灵会话会拒绝/踢，需多次挤）
//   阶段B 切角：进图成功后发 RESTART(0x00B2 type=1) → 关地图 socket → 重连角色服 → 选下一个
let rotRetryTimer = null;
// 挤号一次（模块级，供 banned/char_refuse 复用）
function rotateSqueeze() {
  if (!rotState || rotState.phase !== 'squeeze') return;
  rotState.squeezeCount++;
  if (rotState.squeezeCount > rotState.maxSqueeze) {
    console.log(`\n❌ 挤号 ${rotState.maxSqueeze} 次仍无法进入角色（幽灵会话未过期？）`);
    return rotSummary();
  }
  const target = rotState.queue[rotState.idx];
  console.log(`\n🔨 挤号尝试 ${rotState.squeezeCount}/${rotState.maxSqueeze} → ${target ? target.name : '?'}`);
  rotState.waitingList = true;
  c.login().catch((e) => {
    console.log('   登录异常: ' + e.message);
    clearTimeout(rotRetryTimer);
    rotRetryTimer = setTimeout(rotateSqueeze, 20000);
  });
}

function rotSummary() {
  if (!rotState) return;
  console.log('\n📊 轮换结果汇总:');
  rotState.done.forEach((d, i) => console.log(`   [${i + 1}] ${d.name} → ${d.map} (${d.pos}) 技能${d.skills}`));
  console.log(`\n✅ 成功进入 ${rotState.done.length}/${rotState.queue.length} 个角色`);
  const st = rotState;
  rotState = null;
  clearTimeout(rotRetryTimer);
  void st;
  finish();
}

function rotateScenario(firstList) {
  const order = firstList.slice(0, parseInt(process.env.RO_ROTATE_N || '12', 10));
  rotState = {
    queue: order, done: [], idx: 0,
    waitingList: false,     // 角色列表到达时是否要选角
    phase: 'squeeze',       // squeeze=挤角色 / rotate=切后续角色
    squeezeCount: 0,
    maxSqueeze: parseInt(process.env.RO_SQUEEZE || '10', 10),
    inZone: false,          // 当前是否已成功进图
  };
  console.log(`\n🔄 角色轮换开始：共 ${order.length} 个角色（先挤号进第 1 个，再逐个切）\n`);

  // 角色列表到达 → 选角（挤号阶段选第 0 个，切角阶段选当前 idx）
  c.removeAllListeners('char_list');
  c.on('char_list', () => {
    if (!rotState || !rotState.waitingList) return;
    rotState.waitingList = false;
    const ch = rotState.queue[rotState.idx];
    if (!ch) return rotSummary();
    console.log(`── [${rotState.idx + 1}/${rotState.queue.length}] ${ch.name} (slot ${ch.CharNum}, Lv${ch.level} job=${ch.job}, 存档 ${ch.lastMap})`);
    c.session.charName = ch.name;
    c.selectChar(ch.CharNum);
  });

  // 进图成功 = 本轮目标角色进入
  c.removeAllListeners('map_enter');
  c.on('map_enter', (p) => {
    stage = 'zone-connected';
    rotState.inZone = true;
    rotState.squeezeCount = 0; // 进图成功，挤号计数归零
    c.entities.clear(); c.inventory = null; c.skills = null; c._params = {}; c._zenyLogged = false;
    setTimeout(() => c.mapLoaded(), 500);
    setTimeout(() => {
      if (!rotState) return;
      const cur = rotState.queue[rotState.idx];
      if (!cur) return;
      const skills = (c.skills || []).length;
      console.log(`   ✅ ${cur.name} 已进图 ${c.mapName} @(${p.pos[0]},${p.pos[1]}) 技能${skills}项`);
      rotState.done.push({ name: cur.name, map: (c.mapName || '').replace(/\.gat$/, ''), pos: [p.pos[0], p.pos[1]], skills, ok: true });
      rotState.idx++;
      if (rotState.idx >= rotState.queue.length) return rotSummary();
      // ---- 阶段B：切下一个角色（RESTART；若失败会自动回落到挤号）----
      rotState.phase = 'rotate';
      rotState.waitingList = true;
      rotState.inZone = false;
      c.rotating = true;
      c.restartToCharSelect();
      // 切角看门狗：20 秒内没进图 → 退回挤号重试
      clearTimeout(rotRetryTimer);
      rotRetryTimer = setTimeout(() => {
        if (rotState && !rotState.inZone) {
          console.log('   ⏱ 切角超时 → 退回挤号');
          rotState.phase = 'squeeze';
          rotateSqueeze();
        }
      }, 20000);
    }, 6000);
  });

  // 断开：切角阶段属预期；挤号阶段由 banned/超时驱动重试
  c.removeAllListeners('disconnect');
  c.on('disconnect', () => {
    if (!rotState) { console.log('[断开]'); return; }
    if (rotState.phase === 'rotate' && !rotState.inZone) console.log('   (切角中断开，属预期)');
  });

  // 角色服重入被拒 → 回到挤号重试
  c.removeAllListeners('char_refuse');
  c.on('char_refuse', () => {
    if (!rotState) return;
    console.log('   ⚠ 角色服重入被拒 → 回到挤号重试');
    rotState.phase = 'squeeze';
    rotState.waitingList = false;
    clearTimeout(rotRetryTimer);
    rotRetryTimer = setTimeout(rotateSqueeze, 12000);
  });

  rotateSqueeze();
}

// 完整任务链场景：飞到赏金NPC区 → 道具店买传送卷轴 → 飞金字塔一层(洞穴) → 迷路的冒险家对话 → 飞回赏金NPC
async function questScenario() {
  const B = require('./lib/protocol').BUILD;
  const waitMap = async (m, ms = 15000) => {
    for (let i = 0; i < ms / 500; i++) { await sleep(500); if ((c.mapName || '').includes(m)) return true; }
    return false;
  };
  const scanNpc = async (re) => {
    const npcs = [...c.entities.values()].filter((e) => e.kind === 'npc');
    const unnamed = npcs.filter((n) => !n.name);
    if (unnamed.length) { unnamed.forEach((n) => c.reqName(n.GID)); await sleep(1500); }
    return [...c.entities.values()].find((e) => e.kind === 'npc' && re.test(e.name || ''));
  };

  // ===== 1. 飞到赏金 NPC 旁 =====
  console.log('\n[1/5] 🚌 飞艇 → morocc 赏金NPC旁 (166,98)');
  c.airshipTeleport('morocc', 166, 98);
  if (!(await waitMap('morocc'))) { console.log('❌ 飞艇失败'); return finish(); }
  await sleep(3500);
  const bounty = await scanNpc(/赏金/);
  console.log(`   赏金NPC: ${bounty ? bounty.name + ' @(' + bounty.pos[0] + ',' + bounty.pos[1] + ')' : '未找到(不影响)'}`);

  // ===== 2. 赏金NPC左边的道具商店，买最贵的 5000z 传送卷轴 =====
  console.log('\n[2/5] 🔍 找赏金NPC左边的道具商店...');
  const shops = [...c.entities.values()].filter((e) => e.kind === 'npc' && e.name && !/赏金|卡普/.test(e.name));
  shops.forEach((n) => console.log(`   见 NPC: ${n.name} @(${n.pos[0]},${n.pos[1]})`));
  let shop = shops.find((n) => /道具商人|道具店|杂货/.test(n.name));
  if (!shop && bounty) {
    shop = shops
      .filter((n) => /商人|商店|贩卖|百货/.test(n.name) && n.pos[0] < bounty.pos[0])
      .sort((a, b) => (Math.abs(a.pos[1] - bounty.pos[1]) + Math.abs(a.pos[0] - bounty.pos[0])) - (Math.abs(b.pos[1] - bounty.pos[1]) + Math.abs(b.pos[0] - bounty.pos[0])))[0];
  }
  shop = shop || shops.find((n) => /商人|商店/.test(n.name));
  if (!shop) { console.log('❌ 附近没有商店 NPC'); return finish(); }
  console.log(`   🏪 ${shop.name} @(${shop.pos[0]},${shop.pos[1]}) → 走过去打开购买`);
  await new Promise((res) => bot.walkSmart(shop.pos[0] + 2, shop.pos[1] + 1, () => res(), 40000));

  let bought = false;
  c.on('shop_menu', async (p) => {
    console.log('   商店菜单 → 购买');
    setTimeout(() => c.send(B.ackSelectDealtype(p.gid, 0)), 500);
  });
  c.on('shop_items', async (p) => {
    // 传送卷轴 = 最下面(列表末位) 5000z 的商品；优先按价匹配，否则取末位
    const items = p.items;
    console.log(`   商品 ${items.length} 件（全量）:`);
    items.forEach((it, i) => console.log(`      [${i}] #${it.ITID} 售价 ${(it.discount || it.price)}z`));
    const scroll = items.find((it) => (it.discount || it.price) === 5000) || items[items.length - 1];
    console.log(`   📜 选定传送卷轴: #${scroll.ITID} ${(scroll.discount || scroll.price)}z（列表第 ${items.indexOf(scroll) + 1} 项）→ 购买 1 张`);
    setTimeout(() => c.send(B.marketPurchase([{ ITID: scroll.ITID, amount: 1 }])), 800);
  });
  c.on('purchase_result', (p) => {
    bought = p.rs === 0 || p.items.length > 0;
    setTimeout(() => c.send(B.marketClose()), 800);
  });
  bot.talkTo(shop.GID);
  for (let i = 0; i < 16; i++) { await sleep(500); if (bought) break; }
  if (!bought) { console.log('❌ 购买未确认'); return finish(); }
  console.log('   ✅ 已购买传送卷轴');

  // ===== 3. 飞金字塔一层（洞穴，需卷轴）=====
  console.log('\n[3/5] 🚌 飞艇 → 金字塔一层 moc_prydb1 (90,112)');
  await sleep(2000);
  c.airshipTeleport('moc_prydb1', 90, 112);
  if (!(await waitMap('moc_prydb1'))) {
    console.log('❌ 洞穴传送失败（可能仍不支持或卷轴未生效）');
    return finish();
  }
  console.log(`   ✅ 进入金字塔！落点 (${bot.pos})`);
  await sleep(3500);

  // ===== 4. 找迷路的冒险家对话 =====
  console.log('\n[4/5] 🔍 找迷路的冒险家...');
  let guide = await scanNpc(/迷路|冒险家/);
  if (!guide) {
    // 没有直接匹配 → 逐个对话洞内 NPC（对话标题显示真名）
    const cands = [...c.entities.values()].filter((e) => e.kind === 'npc' && e.pos)
      .sort((a, b) => (Math.abs(a.pos[0] - bot.pos[0]) + Math.abs(a.pos[1] - bot.pos[1])) - (Math.abs(b.pos[0] - bot.pos[0]) + Math.abs(b.pos[1] - bot.pos[1])));
    console.log('   由近到远尝试对话: ' + cands.map((n) => `${n.name || '#' + n.GID}@(${n.pos[0]},${n.pos[1]})`).join(', '));
    for (const cand of cands.slice(0, 3)) {
      console.log(`   🧭 对话 ${cand.name || '#' + cand.GID} @(${cand.pos[0]},${cand.pos[1]})`);
      const d = Math.max(Math.abs(bot.pos[0] - cand.pos[0]), Math.abs(bot.pos[1] - cand.pos[1]));
      if (d > 2) await new Promise((res) => bot.walkSmart(cand.pos[0] + 2, cand.pos[1] + 1, () => res(), 40000));
      // 点击后 6 秒内打印所有未处理封包（观察 NPC 反应）
      const probe = (p) => console.log(`   [收] 0x${p.pid.toString(16).padStart(4, '0')} ${p.pkt.slice(0, 24).toString('hex')}`);
      c.on('packet', probe);
      bot.handleDialog({
        onSay: (gid, msg) => console.log(`   💬 ${msg.replace(/\^([0-9a-fA-F]{6})/g, '').slice(0, 70)}`),
        onMenu: (gid, options) => {
          const avoid = /取消|返回|关闭|结束|谢谢|再见/;
          const pats = [/接受|领取|继续|是$|确定|交|完成|帮助|带路/, /.*/];
          for (const re of pats) { const i = options.findIndex((o) => re.test(o) && !avoid.test(o)); if (i >= 0) { console.log(`   📋 ${options.slice(0, 5).join(' | ').slice(0, 70)} → [${i + 1}]`); return i + 1; } }
          return options.length;
        },
      });
      bot.talkTo(cand.GID);
      await sleep(6000);
      c.removeListener('packet', probe);
      await sleep(3000);
      // 对话内容里出现"迷路"即认定找到
      const said = /迷路/.test(require('fs').existsSync('/tmp/ro_quest.log') ? require('fs').readFileSync('/tmp/ro_quest.log', 'utf8').slice(-4000) : '');
      if (said) break;
    }
  } else {
    console.log(`   🧭 ${guide.name} @(${guide.pos[0]},${guide.pos[1]}) → 对话`);
    const d = Math.max(Math.abs(bot.pos[0] - guide.pos[0]), Math.abs(bot.pos[1] - guide.pos[1]));
    if (d > 3) await new Promise((res) => bot.walkSmart(guide.pos[0] + 2, guide.pos[1] + 1, () => res(), 40000));
    bot.handleDialog({
      onSay: (gid, msg) => console.log(`   💬 ${msg.replace(/\^([0-9a-fA-F]{6})/g, '').slice(0, 70)}`),
      onMenu: (gid, options) => {
        const avoid = /取消|返回|关闭|结束|谢谢/;
        const pats = [/接受|领取|继续|是$|确定|交|完成/, /.*/];
        for (const re of pats) { const i = options.findIndex((o) => re.test(o) && !avoid.test(o)); if (i >= 0) { console.log(`   📋 ${options.slice(0, 5).join(' | ').slice(0, 70)} → [${i + 1}]`); return i + 1; } }
        return 1;
      },
    });
    bot.talkTo(guide.GID);
    await sleep(9000);
  }

  // ===== 5. 飞回赏金 NPC =====
  console.log('\n[5/5] 🚌 飞艇回 morocc 赏金NPC旁 (166,98)');
  c.airshipTeleport('morocc', 166, 98);
  const back = await waitMap('morocc');
  if (back) {
    console.log(`   ✅ 回到 morocc (${bot.pos})，任务链闭环完成`);
  } else {
    console.log('   ⚠ 洞穴内飞艇被拒（可能需要走出洞穴或再用卷轴）');
  }
  finish();
}
async function bountyScenario() {
  const SCAN_CENTER = [156, 97]; // 梦罗克中心喷泉
  console.log(`\n🚌 飞艇 → morocc 中心 (${SCAN_CENTER})`);
  c.airshipTeleport('morocc', SCAN_CENTER[0], SCAN_CENTER[1]);
  let ok = false;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if ((c.mapName || '').replace(/\.gat$/i, '') === 'morocc') { ok = true; break; }
  }
  if (!ok) { console.log('❌ 飞艇到 morocc 失败（该线路可能无此图或无传送道具）'); return finish(); }
  console.log(`✅ 已到 morocc (${bot.pos})，开始扫描赏金任务 NPC`);
  await sleep(3500);

  // 网格走位扫描：中心 ±40 范围，每格 ~20 步距，沿途查名字
  const spots = [];
  for (let dy = -40; dy <= 40; dy += 20) for (let dx = -40; dx <= 40; dx += 20) spots.push([156 + dx, 97 + dy]);
  let bounty = null;
  const seen = new Set();
  for (const [sx, sy] of spots) {
    // 每个扫描点：走过去（或飞过去失败就走）
    await new Promise((res) => bot.walkSmart(sx, sy, () => res(), 60000));
    // 查询视野内 NPC 名字
    const npcs = [...c.entities.values()].filter((e) => e.kind === 'npc');
    const unnamed = npcs.filter((n) => !n.name && !seen.has(n.GID));
    unnamed.forEach((n) => { seen.add(n.GID); c.reqName(n.GID); });
    await sleep(1200);
    bounty = [...c.entities.values()].find((e) => e.kind === 'npc' && /赏金|懸賞|委托|委託| bounty/i.test(e.name || ''));
    const named = npcs.filter((n) => n.name).length;
    console.log(`   扫描点 (${bot.pos}) 视野NPC ${named} 个${bounty ? ` ← 🎯 ${bounty.name} @(${bounty.pos[0]},${bounty.pos[1]})` : ''}`);
    if (bounty) break;
  }
  if (!bounty) {
    console.log('\n❌ 中心区域未找到赏金 NPC。已见 NPC:');
    [...c.entities.values()].filter((e) => e.kind === 'npc' && e.name).forEach((n) => console.log(`   (${n.pos[0]},${n.pos[1]}) ${n.name}`));
    return finish();
  }

  // ===== 找到赏金 NPC：先飞去外图，再飞艇直达 NPC 旁 =====
  const NX = bounty.pos[0], NY = bounty.pos[1];
  console.log(`\n🎯 赏金 NPC: ${bounty.name} @ (${NX},${NY}) GID=${bounty.GID}`);
  console.log('🚌 先飞去 prontera（远离验证）...');
  c.airshipTeleport('prontera', 156, 191);
  for (let i = 0; i < 24; i++) { await sleep(500); if ((c.mapName || '').includes('prontera')) break; }
  console.log(`   当前 @ ${c.mapName} (${bot.pos})`);
  await sleep(3000);
  console.log(`\n🚌 回飞：prontera → morocc 赏金NPC旁 (${NX + 1},${NY + 1})`);
  c.airshipTeleport('morocc', NX + 1, NY + 1);
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if ((c.mapName || '').includes('morocc')) break;
  }
  await sleep(2500);
  const d = Math.max(Math.abs(bot.pos[0] - NX), Math.abs(bot.pos[1] - NY));
  console.log(`\n✅ 落点 (${bot.pos})，距赏金 NPC ${d} 格 ${d <= 2 ? '——直达成功，可点击' : ''}`);
  if (d > 2) await new Promise((res) => bot.walkSmart(NX + 1, NY + 1, () => res(), 30000));
  // 点击 NPC 展示对话
  bot.handleDialog({
    onSay: (gid, msg) => console.log(`   💬 ${msg.replace(/\^([0-9a-fA-F]{6})/g, '').slice(0, 60)}`),
    onMenu: (gid, options) => { console.log(`   📋 ${options.slice(0, 6).join(' | ').slice(0, 80)}`); return 1; },
  });
  bot.talkTo(bounty.GID);
  setTimeout(() => { console.log('\n[场景完成] 赏金 NPC 定位 + 跨图直达 + 对话验证'); finish(); }, 10000);
}

async function mainScenario() {
  const cur = (c.mapName || '').replace(/\.gat$/i, '');
  if (cur === TARGET.map) return doFinalWalk();

  // ===== 首选：私人飞艇免费传送（世界地图机制，itemid=14527）=====
  console.log(`\n🚌 尝试飞艇免费传送 → ${TARGET.map} (${TARGET.x},${TARGET.y}) ...`);
  c.airshipTeleport(TARGET.map, TARGET.x, TARGET.y);
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    if ((c.mapName || '').replace(/\.gat$/i, '') === TARGET.map) {
      console.log(`✅ 飞艇传送成功！已到达 ${TARGET.map}`);
      await sleep(4000);
      return doFinalWalk();
    }
  }
  console.log('   飞艇传送未生效，回退卡普拉流程');

  // ===== 兜底：卡普拉传送 =====
  if (MAP_HOPS[cur]) {
    const [hx, hy] = MAP_HOPS[cur];
    console.log(`\n🕳 当前在 ${cur}，走到出口 (${hx},${hy}) ...`);
    const err = await new Promise((res) => bot.walkSmart(hx, hy, (e) => res(e), 150000));
    if (err) console.log(`   出口巡路: ${err.message}`);
    // 等换图
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if ((c.mapName || '').replace(/\.gat$/i, '') !== cur) {
        console.log(`✅ 已切换到 ${c.mapName}`);
        await sleep(3000);
        return mainScenario();
      }
    }
    console.log('   出口未触发换图（出口坐标可能有误）');
    return finish(); // 本图无卡普拉，出口失败直接结束
  }

  // 先查一遍视野内 NPC 名字
  await scanKafra();
  // 优先试 Royal Messenger（疑似城市传送 NPC），再试卡普拉
  const guide = [...c.entities.values()].find((e) => e.kind === 'npc' && /Messenger|信使|引导|使者/.test(e.name || ''));
  const spots = [];
  if (guide) spots.push({ name: guide.name, gid: guide.GID, pos: guide.pos });
  const cur2 = (c.mapName || '').replace(/\.gat$/i, '');
  for (const [kx, ky] of (KAFRA_SPOTS_BY_MAP[cur2] || KAFRA_SPOTS_BY_MAP.prontera)) spots.push({ name: `卡普拉@(${kx},${ky})`, kx, ky });

  for (const spot of spots) {
    let npc = guide && spots[0] === spot ? guide : null;
    if (!npc) {
      console.log(`\n🚶 巡路去 ${spot.name} ...`);
      const err = await new Promise((res) => bot.walkSmart(spot.kx, spot.ky, (e) => res(e), 90000));
      if (err) { console.log(`   巡路失败: ${err.message}`); continue; }
      console.log(`   到达 (${bot.pos})，扫描视野内 NPC ...`);
      npc = await scanKafra();
      if (!npc) { console.log('   附近没有卡普拉'); continue; }
    }
    console.log(`   👩 传送 NPC: ${npc.name} @ (${npc.pos[0]},${npc.pos[1]}) GID=${npc.GID}`);
    await new Promise((res) => bot.walkSmart(npc.pos[0] + 2, npc.pos[1] + 1, () => res(), 45000));
    bot.handleDialog({
      onSay: (gid, msg) => console.log(`   💬 ${msg.replace(/\^([0-9a-fA-F]{6})/g, '')}`),
      onMenu: (gid, options) => {
        const { idx, opt } = menuPick(options);
        console.log(`   📋 ${options.slice(0, 8).join(' | ').slice(0, 100)}`);
        console.log(`      → 选 [${idx}] ${opt}`);
        return idx;
      },
    });
    bot.talkTo(npc.GID);
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if ((c.mapName || '').replace(/\.gat$/i, '') === TARGET.map) {
        console.log(`\n✅ 传送成功！已到达 ${TARGET.map}`);
        await sleep(4000);
        return doFinalWalk();
      }
    }
    console.log('   30 秒未传送到目标图，继续下一个传送点');
    c.entities.clear();
  }
  console.log('\n❌ 未找到能直达梦罗克的传送 NPC');
  finish();
}

async function doFinalWalk() {
  await bot.updateMap(TARGET.map);
  await sleep(1000);
  console.log(`\n🎯 A* 巡路 (${bot.pos}) → (${TARGET.x},${TARGET.y})`);
  bot.walkSmart(TARGET.x, TARGET.y, (err) => {
    if (err) {
      console.log(`❌ 巡路失败: ${err.message}，当前位置 (${bot.pos})`);
    } else {
      const dist = Math.max(Math.abs(bot.pos[0] - TARGET.x), Math.abs(bot.pos[1] - TARGET.y));
      console.log(`\n🎯 到达 (${bot.pos[0]},${bot.pos[1]})，与目标偏差 ${dist} 格 ${dist === 0 ? '——精确到达' : ''}`);
    }
    finish();
  }, 150000);
}

function finish() {
  stage = 'done';
  if (bot._mon) clearInterval(bot._mon);
  c.close();
  setTimeout(() => process.exit(0), 2500);
}

c.on('packet', ({ pid, pkt }) => {
  // 把未处理的大封包存盘供离线分析
  if ([0x082D, 0x099D, 0x006B, 0x06B1].includes(pid)) {
    require('fs').writeFileSync(`/tmp/pkt_0x${pid.toString(16)}.bin`, pkt);
    console.log(`已保存 0x${pid.toString(16)} (${pkt.length}字节) 到 /tmp/`);
  }
});
process.on('exit', () => {
  const c1 = c.packetCounts || {};
  const top = Object.entries(c1).sort((a, b) => b[1] - a[1]).slice(0, 25)
    .map(([k, v]) => `0x${(+k).toString(16).padStart(4, '0')}×${v}`).join(' ');
  console.log('\n📦 收包统计:', top);
});
c.on('dialog_say', (p) => console.log(`\n💬 NPC(${p.gid}) 说: ${p.msg}`));
c.on('dialog_menu', (p) => console.log(`📋 NPC(${p.gid}) 菜单: ${p.options.join(' | ')}`));
c.on('disconnect', () => {
  console.log('[断开]');
  // 只有已进图后的断开才算失败；登录/选角阶段角色服的移交关闭属正常
  if (stage === 'zone-connected' || stage === 'done') process.exit(1);
});
c.on('error', (e) => console.error('[error]', e.message));

console.log(`=== RO V6 离线协议测试 ===`);
console.log(`线路=${OPT.line} 账号=${OPT.account}`);
// 任何退出路径都先发退出封包，避免幽灵会话
process.on('uncaughtException', (e) => { console.error('[崩溃]', e.message); try { c.close(); } catch (_) {} setTimeout(() => process.exit(1), 400); });
process.on('unhandledRejection', (e) => { console.error('[未处理Promise]', e); });
process.on('SIGINT', () => { c.close(); setTimeout(() => process.exit(0), 400); });
startLogin();
