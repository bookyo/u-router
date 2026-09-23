#!/usr/bin/env node
'use strict';
// --simulate: 离线交易场景回归；--live: 使用 RO_PASS 一次性免费取香菇芽孢×2。
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { preflightFreePurchase, waitForPurchaseProof, merchantSeesBuyer } = require('./mule-trade-once-core');

const mode = process.argv[2];
if (mode === '--simulate') {
  const files = [
    path.join(__dirname, 'roclient/test/mule-trade.test.js'),
    path.join(__dirname, 'roclient/test/mule-trade-once.test.js'),
  ];
  const childEnv = { ...process.env, MULE_SIM_CHILD: '1' };
  delete childEnv.NODE_TEST_CONTEXT; // 从 node:test 启动本脚本时，嵌套 runner 仍要独立输出汇总。
  const result = spawnSync(process.execPath, ['--test', ...files], { encoding: 'utf8', timeout: 15000, env: childEnv });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.status == null ? 1 : result.status;
} else if (mode !== '--live') {
  console.error('用法：node mule-trade-once.js --simulate | --live（真实模式需 RO_PASS）');
  process.exitCode = 2;
} else if (!process.env.RO_PASS) {
  console.error('RO_PASS 必填；密码只从环境变量读取');
  process.exitCode = 2;
} else if (process.env.RO_USER && process.env.RO_USER !== 'xiezixing') {
  console.error('此一次性交易脚本只允许 xiezixing，拒绝切换其他账号');
  process.exitCode = 2;
} else {
  if (!process.env.RO_FAKE_IP) process.env.RO_FAKE_IP = 'auto';
  runLive().catch((error) => { console.error(`预检失败：${error.message}`); process.exitCode = 1; });
}

async function runLive() {
  const ACCOUNT = 'xiezixing';
  const ITEM = '香菇芽孢', ITID = 921, QTY = 2;
  const WB_URL = process.env.WB_URL || 'http://127.0.0.1:8787';
  const MULE_URL = process.env.RO_MULE_URL || 'http://127.0.0.1:8790';
  const log = (message) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`);
  const request = async (base, route, body, timeoutMs = 5000) => {
    const headers = body == null ? {} : { 'Content-Type': 'application/json' };
    if (base === MULE_URL && process.env.RO_MULE_KEY) headers['X-Api-Key'] = process.env.RO_MULE_KEY;
    const response = await fetch(base + route, {
      method: body == null ? 'GET' : 'POST',
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json();
    if (!response.ok && body == null) throw new Error(`${route} HTTP ${response.status}`);
    return data;
  };
  const getMule = (route) => request(MULE_URL, route);
  const cancelOrder = async (id) => {
    const reply = await request(MULE_URL, '/cancel', { id });
    if (!reply || !reply.ok) throw new Error(`订单 ${id} 取消未确认`);
  };
  const check = async () => {
    const [workbench, stock, status] = await Promise.all([
      request(WB_URL, '/api/state'), getMule('/stock'), getMule('/status'),
    ]);
    return preflightFreePurchase({ account: ACCOUNT, busy: workbench.busy, stock, status, ITID, qty: QTY,
      hasApiKey: !!process.env.RO_MULE_KEY });
  };
  let plan = await check();
  log(`预检通过：${ITEM} 库存 ${plan.item.count}，商人 @(${plan.stand.join(',')})，免费取 ${QTY} 个`);

  const { ROClient } = require('./roclient/lib/client');
  const { Bot } = require('./roclient/lib/bot');
  const { BUILD } = require('./roclient/lib/protocol');
  const { LoginSession, sleep } = require('./roclient/lib/modules');
  const { receiveMuleTrade, creditTradeInventory, approachSpots } = require('./trade-flow');
  const line = process.env.RO_LINE || 'eden';
  const client = new ROClient({ line, account: ACCOUNT, password: process.env.RO_PASS });
  const bot = new Bot(client);
  const login = new LoginSession(client, { account: ACCOUNT, password: process.env.RO_PASS, line,
    backoff: { refuse8: 12000, refuse2: 12000, disconnect: 12000, hang: 30000, banned: 30000 } }, log);
  let mapEntries = 0, started = false, stopping = false;
  const timeout = setTimeout(() => stop(3, '总超时，未再次下单'), 300000);
  async function stop(code, message) {
    if (stopping) return;
    stopping = true;
    clearTimeout(timeout);
    login.stop();
    log(message);
    try {
      if (client.state === 'zone' && client.ws && client.ws.readyState === 1) {
        client.rotating = true;
        const charList = new Promise((resolve) => {
          const timer = setTimeout(() => { client.removeListener('char_list', arrived); resolve(false); }, 12000);
          const arrived = () => { clearTimeout(timer); resolve(true); };
          client.once('char_list', arrived);
        });
        client.restartToCharSelect();
        if (await charList) {
          log('已回到角色选择界面，再关闭角色服连接');
          client.hardClose(); // 已退出地图，关闭角色服不会触发离线挂机。
        } else {
          log('⚠ 未确认角色列表，补发优雅退出并关闭连接');
          await client.quitClean();
        }
      } else {
        client.closeAllSockets();
      }
    } catch (error) {
      log(`⚠ 退出清理异常：${error.message}`);
      try { await client.quitClean(); } catch (_) {}
    }
    process.exit(code);
  }
  const distance = (pos, center) => Math.max(Math.abs((pos || [0, 0])[0] - center[0]), Math.abs((pos || [0, 0])[1] - center[1]));
  async function approach(stand) {
    if (!String(client.mapName || '').startsWith('morocc')) {
      log('飞艇前往梦罗克');
      client.airshipTeleport('morocc', stand[0] + 2, stand[1] + 2);
      for (let i = 0; i < 40 && !String(client.mapName || '').startsWith('morocc'); i++) await sleep(500);
      if (!String(client.mapName || '').startsWith('morocc')) throw new Error('未能到达梦罗克');
      await sleep(1500);
    }
    if (distance(client.position, stand) > 3) {
      await bot.updateMap('morocc');
      const spots = approachSpots(stand, (x, y) => !bot.gat || bot.gat.walkable(x, y));
      if (!spots.length) throw new Error('商人周围没有可走格');
      log(`靠近商人：目标 (${spots[0].join(',')})`);
      await new Promise((resolve) => bot.walkSmart(spots[0][0], spots[0][1], resolve, 45000));
    }
    if (distance(client.position, stand) > 4) throw new Error(`距离商人过远：${distance(client.position, stand)} 格`);
    client.mapLoaded();
    for (let i = 0; i < 5; i++) {
      for (const entity of client.entities.values()) if (entity.kind === 'pc' && !entity.name) client.reqName(entity.GID);
      await sleep(500);
    }
    log(`已到商人旁 @(${(client.position || []).slice(0, 2).join(',')})`);
  }
  async function buyOnce() {
    await approach(plan.stand);
    const buyerIds = [client.session.GID, client.session.AID];
    const spots = approachSpots(plan.stand, (x, y) => !bot.gat || bot.gat.walkable(x, y))
      .filter((spot) => spot[0] !== client.position?.[0] || spot[1] !== client.position?.[1]);
    let visible = false;
    const maxMoves = plan.trustedLocal ? 0 : Math.min(spots.length, 6);
    for (let attempt = 0; attempt <= maxMoves; attempt++) {
      visible = merchantSeesBuyer({ debug: await getMule('/debug'), buyerName: client.session.charName, buyerIds, stand: plan.stand });
      if (visible) break;
      if (attempt >= maxMoves) break;
      const spot = spots[attempt];
      log(`商人未确认买家视野，挪到 (${spot.join(',')}) 后重查`);
      await new Promise((resolve) => bot.walkSmart(spot[0], spot[1], resolve, 15000));
      if (distance(client.position, plan.stand) > 4) throw new Error('移动后超出商人交易距离');
      client.mapLoaded();
      await sleep(1200);
    }
    plan = await check(); // 路上可能切号、售罄、占单或由免费变收费。
    if (!visible && !plan.keyed && !plan.trustedLocal) throw new Error('商人视野未核实当前买家，未创建订单');
    log(visible ? '商人视野已确认当前买家角色与 GID/AID'
      : `商人视野未确认；启用${plan.keyed ? ' API key ' : '临时本机租约'}授权 AID 直发`);
    const before = (client.inventory || []).filter((item) => item.ITID === ITID).reduce((sum, item) => sum + (item.count || 1), 0);
    const beforeStock = plan.item.count;
    log(`下单前：背包 ${ITEM}×${before}，商人库存×${beforeStock}`);
    const outcome = await receiveMuleTrade({
      client, ITID, qty: QTY, timeoutMs: 45000, pollMs: 500,
      requestOrder: async () => {
        const reply = await request(MULE_URL, '/trade', {
          buyer: client.session.charName, name: ITEM, ITID, qty: QTY,
          aid: client.session.AID, gid: client.session.GID,
          buyerGID: client.session.GID, buyerAID: client.session.AID,
        }, 15000);
        if (reply && reply.ok && reply.id && (reply.qty !== QTY || reply.name !== ITEM)) {
          await cancelOrder(reply.id);
          return { ok: false, error: '订单物品或数量与预期不符' };
        }
        return reply;
      },
      readStatus: () => getMule('/status'), cancelOrder,
      send: (packet) => client.send(packet), build: BUILD, log,
    });
    if (!outcome.ok) throw new Error(`交易未成功：${outcome.reason || '未知原因'}；不自动二次下单`);
    const { afterStock } = await waitForPurchaseProof({
      outcome, beforeStock, qty: QTY, ITID,
      readLastTrade: () => getMule('/lasttrade'), readStock: () => getMule('/stock'),
    });
    const localCredited = creditTradeInventory(client.inventory || (client.inventory = []), ITID, before, QTY, outcome.itemIndex);
    log(`✅ 成交确认：订单 ${outcome.orderId}，商人库存 ${beforeStock}→${afterStock}，无付款`);
    if (!localCredited) log('⚠ 本地背包账面未能更新；以商人订单和库存为成交证据');
    await stop(0, '测试完成，正常下线');
  }
  client.on('warp_map', (event) => { bot.updateMap(event.mapName); bot.updatePos(event.xPos, event.yPos); });
  client.on('self_move', (event) => bot.updatePos(event.move[2], event.move[3]));
  client.on('banned', (event) => stop(2, `登录被拒 code=${event.code}；不挤号重试`));
  client.on('disconnect', () => stop(2, '连接断开；一次性脚本不自动重登或挤号'));
  client.on('char_refuse', () => stop(2, '选角被拒；不自动重试'));
  client.on('char_list', (event) => {
    if (stopping) return;
    const character = (event.chars || []).find((entry) => entry.level >= 30);
    if (!character) { stop(2, '账号没有可用的 30 级角色'); return; }
    client.session.charName = character.name;
    log(`选角 ${character.name}（slot ${character.CharNum}）`);
    client.selectChar(character.CharNum, character.money).catch((error) => stop(2, `选角发送失败：${error.message}`));
  });
  client.on('zone_info', (event) => client.connectZone(event.ipStr, event.port).catch((error) => stop(2, `连图失败：${error.message}`)));
  client.on('map_enter', () => {
    setTimeout(() => { try { client.mapLoaded(); } catch (_) {} }, 500);
    mapEntries++;
    if (mapEntries === 1) {
      log('刷新式登录：回选角清除离线态');
      client.rotating = true;
      setTimeout(() => { try { client.restartToCharSelect(); } catch (error) { stop(2, `刷新登录失败：${error.message}`); } }, 1200);
      setTimeout(() => { client.rotating = false; }, 4000);
    } else if (!started) {
      started = true;
      setTimeout(() => buyOnce().catch((error) => stop(1, error.message)), 2500);
    }
  });
  process.once('SIGINT', () => stop(130, '用户中断'));
  process.once('SIGTERM', () => stop(143, '收到停止信号'));
  log(`开始一次性免费交易验收：${ACCOUNT}，RO_FAKE_IP=${process.env.RO_FAKE_IP}`);
  login.login();
}
