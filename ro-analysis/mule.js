#!/usr/bin/env node
'use strict';
/**
 * 永驻商人（mule）：蝎子商人 @ morocc(181,85)
 * 下单：HTTP POST /order {buyer,name|ITID,qty}（工作台/赏金号直连）；密语"物品名 数量"兼容
 * 交易：双方开窗后单次放货(0x00E8)，收到放置成功回执才锁定、执行。
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const base = __dirname;
const { ROClient } = require(path.join(base, 'roclient/lib/client'));
const { Bot } = require(path.join(base, 'roclient/lib/bot'));
const { BUILD } = require(path.join(base, 'roclient/lib/protocol'));
const { LoginSession, sleep } = require(path.join(base, 'roclient/lib/modules'));
const { findNamedBuyerEntity, trustedDirectBuyerIds, temporaryLocalBuyerIds, matchesBuyer, mayFinalizeSeller, tradeSucceeded, placementAckMatches, ackMatchesBuyer, waitForCancelConfirmation } = require('./trade-flow');

const OPT = {
  account: process.env.RO_USER || 'xiezixing4',
  password: process.env.RO_PASS || '',
  slot: parseInt(process.env.RO_SLOT || '0', 10),
  standMap: 'morocc', standX: 181, standY: 85,   // 用户手动就位坐标（2026-09-20）
  port: parseInt(process.env.RO_MULE_PORT || '8790', 10),
  apikey: process.env.RO_MULE_KEY || '',
  host: process.env.RO_MULE_HOST || '127.0.0.1',   // 默认本机；云部署设 0.0.0.0 + RO_MULE_KEY
};
const TEMP_DIRECT_FILE = path.join(base, 'data', 'mule-local-aid-override.json');
const log = (m) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${m}`);

const NAME2ID = (() => {
  const d = JSON.parse(fs.readFileSync(path.join(base, 'data', 'itemnames-zh.json'), 'utf8'));
  const items = Array.isArray(d) ? d : Object.entries(d).map(([k, v]) => ({ ITID: +k, name: v }));
  return new Map(items.map((it) => [String(it.name).trim(), it.ITID]));
})();
const ID2NAME = (() => { const m = new Map(); for (const [k, v] of NAME2ID) m.set(v, k); return m; })();

const c = new ROClient({ line: 'eden', account: OPT.account, password: OPT.password });
const bot = new Bot(c);
const login = new LoginSession(c, { account: OPT.account, password: OPT.password, line: 'eden',
  backoff: { refuse8: 12000, refuse2: 12000, disconnect: 12000, hang: 30000, banned: 30000 } }, log);

// 内挂开关状态跟踪：0x0AFE(id,1) 是【切换】不是设置（用户抓包 2026-09-20：取消攻击也发 22 01）
const botState = { attack: null, pick: null, eat: null };
c.on('server_msg', (p) => {
  const m = p.msg || '';
  if (/开启自动战斗/.test(m)) botState.attack = true;
  else if (/关闭自动战斗/.test(m)) botState.attack = false;
  else if (/开启自动拾取/.test(m)) botState.pick = true;
  else if (/关闭自动拾取/.test(m)) botState.pick = false;
  else if (/开启自动吃药/.test(m)) botState.eat = true;
  else if (/关闭自动吃药/.test(m)) botState.eat = false;
});

let order = null;              // { from, name, ITID, qty, free }
let tradeState = 'idle';       // idle | trading | done
let blindTimer = null;
const PULL_TARGET = 100;       // 推车补货目标：一次补到 100（够的话），别每单只补订单差额（用户规则 2026-09-21）

// ---------- 价目表 & 授权名单 ----------
const PRICES_FILE = path.join(base, 'data', 'mule-prices.json');      // { "ITID": 单价z }，0/缺省=免费但需授权
const AUTH_FILE = path.join(base, 'data', 'mule-auth.json');          // （已废弃：信任改为按通道隔离，不再按名字判定）
const loadJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return dflt; } };
const saveJson = (f, d) => { try { fs.writeFileSync(f, JSON.stringify(d, null, 1)); } catch (_) {} };
const priceOf = (ITID) => { const p = loadJson(PRICES_FILE, {}); return p[String(ITID)] ?? p[ITID] ?? null; };
const setPrice = (ITID, z) => { const p = loadJson(PRICES_FILE, {}); p[String(ITID)] = Math.max(0, z | 0); saveJson(PRICES_FILE, p); };
const isAuthed = (who) => { const list = loadJson(AUTH_FILE, []); return list.some((x) => x && String(who).toLowerCase().includes(String(x).toLowerCase())); };

const allStock = () => [...(c.inventory || []), ...(c.cart || [])];
// 从推车补货到背包（交易只能放背包物品）：index 用推车条目自己的 index
async function pullFromCart(ITID, need) {
  let newIndex = null;
  const onInvItem = (p) => { if (p.ITID === ITID) newIndex = p.index; };
  c.on('inv_item', onInvItem);
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const inv = (c.inventory || []).filter((i) => i.ITID === ITID).reduce((a, b) => a + (b.count || 1), 0);
      if (inv >= need) return true;
      const gap = need - inv;
      const ct = (c.cart || []).find((i) => i.ITID === ITID);
      if (!ct) return false;
      const amt = Math.min(gap, ct.count || 1);
      try { c.send(BUILD.moveFromStore(ct.index, amt)); } catch (_) {}
      await sleep(1200);
      // 本地记账（服务器 0x0125 已同步推车侧；背包侧 count 不回传，按移动量入账）
      const have = (c.inventory || []).find((i) => i.ITID === ITID);
      if (have) have.count += amt;
      else if (newIndex != null) (c.inventory = c.inventory || []).push({ index: newIndex, ITID, type: 0, count: amt, wear: 0, cards: [0, 0, 0, 0] });
    }
    return (c.inventory || []).filter((i) => i.ITID === ITID).reduce((a, b) => a + (b.count || 1), 0) >= need;
  } finally { c.removeListener('inv_item', onInvItem); }
}
const reply = (to, msg) => { try { c.send(BUILD.whisper(to, msg)); } catch (_) {} };

// ---------- 单次放货（锁定/执行由 verifyAndFinish 在钱校验后触发） ----------
// 0x00EA 回执若延迟，重发可能导致多叠放货；因此超时只取消，不再盲发。
let placedAck = false;           // 本次订单已收到放置回执（恰好一叠的保证）
let pendingTradeIndex = null;
let sellerFinalizing = false;
let ackRetryTimer = null;
async function cancelUncertainOrder(od, reason) {
  if (order !== od || od.canceling) return;
  od.canceling = true;
  log(`⚠ ${reason} → 请求游戏端取消，等确认后释放订单`);
  const terminal = await waitForCancelConfirmation(c, () => c.send(BUILD.cancelExchange()), 3000);
  if (order !== od) return;
  if (terminal.kind === 'cancel' || (terminal.kind === 'done' && terminal.result !== 0)) finishOrder(false, { reason });
  else { od.canceling = false; log('⚠ 游戏端取消未确认，保留订单避免误接下一笔'); }
}
function startBlind(od) {
  if (tradeState !== 'idle' && order !== od) return log('⚠ 忽略过期放置任务（订单已更换）');   // 防旧定时器/旧回调把新单的验钱计数清零
  clearTimeout(blindTimer);
  buyerZeny = 0; buyerLocked = false; placedAck = false; pendingTradeIndex = null; sellerFinalizing = false;
  const tryPlace = async () => {
    if (order !== od || od.canceling || tradeState === 'done' || placedAck) { clearTimeout(blindTimer); return; }
    if (!windowOpen) return;   // 窗未确认开（0x01F5 result=0/3）前放置必被丢，等
    // 背包不足量 → 自动从推车补货（统一兜底 /order /trade 密语 三通道：后两者接单不预补，
    // 货全在推车时旧逻辑卡成"背包无此物品→3 分钟订单作废"；开窗后先补货再单次放置）
    const have = (c.inventory || []).filter((i) => i.ITID === od.ITID).reduce((a, b) => a + (b.count || 1), 0);
    if (have < od.qty) {
      const want = Math.max(od.qty, PULL_TARGET);   // 一次多补：目标 100，后续几单就不用再拉
      log(`🛒 背包 ${have}/${od.qty} 不足 → 自动从推车补货 ${od.name}（背包目标 ${want}）`);
      try { await pullFromCart(od.ITID, want); } catch (_) {}
    }
    if (order !== od || od.canceling || placedAck || !windowOpen) return;
    const ready = (c.inventory || []).filter((i) => i.ITID === od.ITID).reduce((a, b) => a + (b.count || 1), 0);
    if (ready < od.qty) { log(`⚠ 补货后仍不足 ${od.name}（${ready}/${od.qty}）`); return cancelUncertainOrder(od, '背包数量不足'); }
    const it = (c.inventory || []).find((i) => i.ITID === od.ITID);   // 只用背包（推车 index 放不进交易窗）
    if (!it) { log(`⚠ 背包与推车均无 ${od.name}（合计 ${have}/${od.qty}）`); return cancelUncertainOrder(od, '背包没有物品'); }
    log(`📤 放入 ${od.name}×${od.qty}（只发一次，等 0x00EA 回执）`);
    pendingTradeIndex = it.index;
    try { c.send(BUILD.addExchange(it.index, od.qty)); } catch (_) { pendingTradeIndex = null; return cancelUncertainOrder(od, '放货发送失败'); }
    blindTimer = setTimeout(() => { if (order === od && !placedAck) cancelUncertainOrder(od, '放货回执超时'); }, 12000);
  };
  tryPlace();
}
let orderWatch = null;
function armOrderWatch(od) {
  od.id = crypto.randomUUID();
  clearTimeout(orderWatch);
  orderWatch = setTimeout(() => {
    if (order === od && tradeState !== 'done') {
      log('⏱ 订单 3 分钟未交割（买家掉线?）→ 作废');
      cancelUncertainOrder(od, '订单超时');
    }
  }, 3 * 60 * 1000);
}
let lastTradeResult = null;   // { ok, at, from } —— 插件轮询判定成交/取消
let cooldownTimer = null;
let cooldownSerial = 0;
function finishOrder(ok, detail) {
  if (!order) return;
  clearTimeout(orderWatch);
  if (ok && order) { log(`✅ 交割完成 → ${order.from}`); try { reply(order.from, `DONE ${order.name}×${order.qty}`); } catch (_) {} }
  else log('✖ 交易未成，订单作废');
  lastTradeResult = { ok: !!ok, at: Date.now(), id: order ? order.id : null, from: order ? order.from : null, ...(detail || {}) };
  clearTimeout(blindTimer);
  clearTimeout(ackRetryTimer);
  ackRetryTimer = null;
  windowOpen = false; buyerLocked = false; placedAck = false; pendingTradeIndex = null; sellerFinalizing = false;
  order = null; tradeState = 'cooldown';
  const serial = ++cooldownSerial;
  clearTimeout(cooldownTimer);
  cooldownTimer = setTimeout(() => {
    if (serial === cooldownSerial && !order && tradeState === 'cooldown') tradeState = 'idle';
  }, 3000);
}

// ---------- 交易流（钱判定版）----------
let buyerZeny = 0;             // 对方累计放入的 zeny（0x00E9 ITID=0 → count 即金额，OpenKore deal_add_other 实证）
let buyerLocked = false;
let windowOpen = false;        // 交易窗真开（我方发起被接受 / 对方请求我方已应答）——盲发前置条件

// 只能对视野里已解析出准确名字的角色主动发交易；调用方 ID 不构成身份凭证。
function sendVerifiedTradeRequest(od, entity) {
  if (order !== od || !entity || !Number.isInteger(entity.GID) || entity.GID <= 0 || String(entity.name || '').trim() !== String(od.from || '').trim()) return false;
  od.verifiedBuyerIds = [entity.GID, entity.AID].map(Number).filter((id) => Number.isInteger(id) && id > 0);
  od.sentTo = entity.GID;
  od.lastAckResult = null;
  try { c.send(BUILD.requestExchange(entity.GID)); return true; } catch (_) { od.sentTo = null; return false; }
}
function sendTrustedTradeRequest(od, ids) {
  if (order !== od || !ids || !ids.length) return false;
  od.verifiedBuyerIds = ids;
  od.sentTo = ids[0];
  od.lastAckResult = null;
  try { c.send(BUILD.requestExchange(ids[0])); return true; } catch (_) { od.sentTo = null; return false; }
}
async function initiateWhenInView(od) {
  for (let i = 0; i < 24 && order === od && tradeState !== 'done' && !windowOpen; i++) {   // 窗开即停（防重试打断已开交易）
    if (windowOpen) return;   // 双保险
    const pcs = [...c.entities.values()].filter((e) => e.kind === 'pc');
    pcs.filter((e) => !e.name).forEach((e) => c.reqName(e.GID));   // 刷新未命名实体（名字匹配需要）
    const ent = findNamedBuyerEntity(pcs, od.from);
    const dist = ent && ent.pos && c.position ? Math.max(Math.abs(ent.pos[0] - c.position[0]), Math.abs(ent.pos[1] - c.position[1])) : 99;
    if (ent && dist <= 4) {
      log(`🤝 商人发起交易 → ${od.from}（距离 ${dist}，实体 GID=${ent.GID} AID=${ent.AID}）`);
      sendVerifiedTradeRequest(od, ent);
      return;
    }
    if (i % 4 === 0) log(`⏳ 等买家 ${od.from} 进视野（GID ${od.buyerGID}，视野 PC×${pcs.length}）…`);
    await sleep(5000);
  }
  if (order === od && !windowOpen) { log('⏱ 买家 2 分钟未进视野，订单作废'); finishOrder(false); }   // windowOpen=true 时是窗开熔断退出，不作废
}
c.on('trade_request', (p) => {
  const nm = String(p.name || '').trim();
  const want = order && String(order.from || '').trim();
  const match = matchesBuyer(order, p);
  // ACK 语义（2026-09-21 官方 UI 实证）：3=接受开窗、4=拒绝、0=距离太远（此前 3/0 用反了）
  if (windowOpen || (order && order.canceling) || !match) {   // 交易中 / 取消中 / 无挂单 / 挂单不属于此人 → 拒绝
    try { c.send(BUILD.ackExchange(4)); } catch (_) {}
    if (!windowOpen) log(`🚫 ${nm} 请求交易 → 拒绝（${order ? `挂单属 ${want}` : '无挂单'}）`);
    return;
  }
  tradeState = 'trading';
  log(`🤝 ${p.name}(Lv${p.level || '?'}) 请求交易 → 立即接受（订单 ${order.name}×${order.qty}${order.free ? '·授权免费' : `·应收 ${order.price}z`}）`);
  try { c.send(BUILD.ackExchange(3)); } catch (_) {}
  windowOpen = true;
  log('→ 已发接受(3)，交易窗开');
  startBlind(order);
});
// 我方发起的回执：3=对方接受（窗开）；0=距离太远 1=不存在 2=忙 → 重试
c.on('trade_ack', (p) => {
  if (!order) {
    if (p.result === 3) { log('⚠ 旧订单迟到的开窗回执 → 取消'); try { c.send(BUILD.cancelExchange()); } catch (_) {} }
    return;
  }
  if (order.canceling) { if (p.result === 3) { try { c.send(BUILD.cancelExchange()); } catch (_) {} } return; }
  if (p.result === 3 && !windowOpen && !ackMatchesBuyer(order, p)) {
    log(`🚫 开窗回执目标 GID=${p.GID} 与订单不符 → 取消`);
    windowOpen = true;
    cancelUncertainOrder(order, '交易对象不符');
    return;
  }
  order.lastAckResult = p.result;
  if (p.result === 3) {
    if (!windowOpen) { windowOpen = true; log('✅ 对方接受，交易窗开'); if (order) startBlind(order); }
  } else if (tradeState === 'trading' && !windowOpen) {
    const rejectedOrder = order;
    log(`⚠ 发起被拒（code=${p.result}），5s 后重新核实买家视野`);
    clearTimeout(ackRetryTimer);
    ackRetryTimer = setTimeout(() => {
      ackRetryTimer = null;
      if (order === rejectedOrder && !windowOpen && !rejectedOrder.canceling) initiateWhenInView(rejectedOrder);
    }, 5000);
  }
});
// 我方放置回执（0x00EA 携带背包 index 和结果）——确认单次放货。
c.on('trade_add_ack', (p) => {
  if (!order || !windowOpen || placedAck || order.canceling) return;
  if (!placementAckMatches(p, pendingTradeIndex)) {
    log(`⚠ 放置回执不匹配 index=${p && p.index} result=${p && p.result}`);
    if (p && p.index === pendingTradeIndex && p.result !== 0) cancelUncertainOrder(order, '放货被拒');
    return;
  }
  placedAck = true;
  clearTimeout(blindTimer);
  log('✅ 放置成功回执 0x00EA 到达 → 停止放置（恰好一叠）');
  verifyAndFinish();
});
// 对方窗内容同步（0x0B42，对方锁定时与 0x00EC 同帧）：ITID=0 即 zeny —— 钱判定唯一真源（0x00E9 从不下发）
c.on('trade_peer_sync', (p) => {
  buyerZeny = p.zeny || 0;
  log(`💰 [0x0B42] 对方窗: ${p.zeny ? `${p.zeny}z` : '无钱'}${p.items.length ? ' + ' + p.items.map((i) => `#${i.ITID}×${i.count}`).join(',') : ''} raw=${p.raw.slice(0, 40)}`);
});
c.on('trade_item', (p) => {
  if (!p.who) return;   // 只关心对方动作
  if (p.ITID === 0) { buyerZeny += p.count; log(`💰 对方放入 ${p.count}z（累计 ${buyerZeny}/${order ? order.price : '?'}z）`); }
  else log(`📥 对方放入 #${p.ITID} ×${p.count}`);
});
c.on('trade_conclude', (p) => {
  if (!p.who) return;
  if (!windowOpen) return log('⚠ 忽略非窗态的锁定事件（旧窗残包）');   // 防旧窗残包污染新单验钱
  buyerLocked = true;
  log(`🔓 对方已锁定`);
  verifyAndFinish();
});
// 交易转出本地扣账：服务器成交后不回背包数量包（0x0B41 无 count）——按单扣减，保持 /stock /inventory
// 与服务器一致（2026-09-21 用户实测：成交后 API 仍报 8 个，实际只剩 3 → 下单门槛错位、买家白跑）
function adjustStockOut(od) {
  if (!od) return;
  const it = (c.inventory || []).find((i) => i.ITID === od.ITID);
  const before = it ? (it.count || 1) : 0;
  if (it) it.count = Math.max(0, before - od.qty);
  log(`📉 交易转出扣账: ${od.name}×${od.qty}（账面 ${before} → ${it ? it.count : 0}）`);
}
c.on('trade_done', (p) => {
  if (!order || !windowOpen) return;
  if (!sellerFinalizing) { log('⚠ 未进入本单执行阶段却收到交易结束包，忽略旧包'); return; }
  if (!tradeSucceeded(p)) { log(`❌ 交易执行失败 result=${p && p.result}，不扣库存`); finishOrder(false, { reason: `执行失败 ${p && p.result}` }); return; }
  tradeState = 'done';
  adjustStockOut(order);
  finishOrder(true);
});
c.on('trade_cancel', () => { if (order && windowOpen) finishOrder(false); });

// 对方锁定后的钱判定：免费订单直接成交；收费订单 核对 累计zeny == 单价×数量，不符→取消
function verifyAndFinish() {
  if (!mayFinalizeSeller({ hasOrder: !!order && !order.canceling, windowOpen, buyerLocked, placedAck, finalizing: sellerFinalizing })) return;
  sellerFinalizing = true;
  const currentOrder = order;
  if (!order.free) {
    if (buyerZeny !== order.price) {
      log(`❌ 钱不符：应收 ${order.price}z，实收 ${buyerZeny}z → 取消交易`);
      cancelUncertainOrder(currentOrder, '钱不符');
      return;
    }
    log(`✅ 钱校验通过：${buyerZeny}z == 单价${order.unit}z × ${order.qty}`);
  }
  // 锁定我方 → 等 0.7s → 执行确认（双方都要按，实测）
  try { c.send(BUILD.concludeExchange()); } catch (_) {}
  setTimeout(() => { if (order === currentOrder && windowOpen) { try { c.send(BUILD.execExchange()); } catch (_) {} } }, 800);
  setTimeout(() => { if (order === currentOrder && windowOpen) { try { c.send(BUILD.execExchange()); } catch (_) {} } }, 2200);   // 重发一手防丢
}

// ---------- 密语下单（兼容） ----------
c.on('whisper_recv', (p) => {
  const m = /^\s*(\S+)\s+(\d+)\s*$/.exec(p.msg || '');
  if (!m || tradeState !== 'idle') return reply(p.from, 'Busy');
  const ITID = NAME2ID.get(m[1]) ?? (m[1].startsWith('#') ? +m[1].slice(1) : null);
  const have = ITID ? allStock().filter((i) => i.ITID === ITID).reduce((a, b) => a + (b.count || 1), 0) : 0;
  if (!ITID || have < +m[2]) return reply(p.from, `Insufficient: ${m[1]} have×${have}`);
  const unit = priceOf(ITID);
  const free = false;   // 密语通道对所有人开放 → 一律按价目表收费（不信任任何名字，防伪造）
  // 注意：免费需求走 HTTP API（localhost 物理隔离）
  order = { from: p.from, name: m[1], ITID, qty: +m[2], unit, free, price: (unit || 0) * (+m[2]) };
  armOrderWatch(order);
  log(`📦 [密语] 订单: ${p.from} → ${m[1]}×${m[2]}${free ? '（授权免费）' : `（应收 ${order.price}z）`}`);
  reply(p.from, free ? `OK (authorized) send trade` : `OK ${order.price}z send trade`);
});

// ---------- HTTP 控制口 ----------
// 订单槽串行化：多人同时下单按到达顺序排队；忙时抢占仅限「幽灵窗(>90s)」或「未开窗且已过 15s 接受期」的旧单
const ORDER_GRACE_MS = 15000, ORDER_STALE_MS = 90000;
let gate = Promise.resolve();
const withGate = (fn) => { const run = gate.then(fn, fn); gate = run.then(() => {}, () => {}); return run; };
const tradeReply = (extra = {}) => ({ ok: true, id: order.id, seller: c.session.charName || '', name: order.name, qty: order.qty, unit: order.unit, price: order.price, free: order.free, ...extra });
async function reclaimSlot(tag) {
  if (tradeState === 'cooldown') return false;
  if (tradeState === 'idle' && !order) return true;
  if (!order) return false;
  const age = order.armedAt ? Date.now() - order.armedAt : ORDER_STALE_MS + 1;
  const fresh = windowOpen ? age < ORDER_STALE_MS : age < ORDER_GRACE_MS;
  if (fresh) return false;   // 窗开着未过期 / 新单等待买家接受期内 → 忙（不可抢）
  log(`♻ [${tag}] 旧单让位（${windowOpen ? '幽灵窗' : '未开窗'} ${Math.round(age / 1000)}s，属 ${order.from}）`);
  const oldOrder = order;
  if (windowOpen) {
    const terminal = await waitForCancelConfirmation(c, () => c.send(BUILD.cancelExchange()), 3000);
    if (terminal.kind === 'timeout' || terminal.kind === 'send_error' || (terminal.kind === 'done' && terminal.result === 0)) return false;
  } else if (oldOrder.sentTo && ![0, 1, 2, 4, 5].includes(oldOrder.lastAckResult)) {
    return false; // 尚有未确认的主动请求；不能把旧回执转嫁给新订单。
  }
  if (order === oldOrder) finishOrder(false, { reason: '旧单让位' });
  await sleep(3100);   // 等本地冷却结束；旧回执不得影响接替订单。
  return tradeState === 'idle';
}
http.createServer((req, res) => {
  // APIKEY 提取：X-Api-Key 头 或 ?key= 参数（设置了 RO_MULE_KEY 时生效：匹配→免费，不匹配→收费）
  const u2 = new URL(req.url, 'http://x');
  const reqKey = req.headers['x-api-key'] || u2.searchParams.get('key') || '';
  const authed = !OPT.apikey || reqKey === OPT.apikey;

  const done = (code, obj) => {
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
      'Access-Control-Allow-Private-Network': 'true',
    });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key', 'Access-Control-Allow-Private-Network': 'true' }); return res.end(); }
  // 管理门禁：启用 RO_MULE_KEY 后，除公开通道（/ 服务信息、/stock 商品目录、/order /trade 购买下单）外
  // 全部接口（/price /pull /auth /cancel /debug /status /inventory …）必须携带匹配的 X-Api-Key
  const PUBLIC_API = new Set(['/', '/stock', '/order', '/trade']);
  if (OPT.apikey && !PUBLIC_API.has(u2.pathname) && !authed) {
    log(`⛔ [${u2.pathname}] 管理接口未授权 → 401`);
    return done(401, { ok: false, error: 'unauthorized（管理接口需 X-Api-Key）' });
  }
  if (u2.pathname === '/order' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      try {
        const o = JSON.parse(body);
        const ITID = o.ITID || NAME2ID.get(String(o.name || '').trim()) || (String(o.name || '').startsWith('#') ? +o.name.slice(1) : null);
        if (!ITID || !o.qty) return done(400, { ok: false, error: 'bad order' });
        if (priceOf(ITID) == null) return done(403, { ok: false, error: 'not for sale（未定价）' });
        // 视野/库存校验放槽位申请前：无效请求不惊动现有交易
        let have = (c.inventory || []).filter((i) => i.ITID === ITID).reduce((a, b) => a + (b.count || 1), 0);
        if (have < o.qty) {
          if (await pullFromCart(ITID, Math.max(+o.qty, PULL_TARGET))) { log(`🛒 已从推车补货 ${ID2NAME.get(ITID) || ITID} 至背包（目标 ${Math.max(+o.qty, PULL_TARGET)}）`); have = (c.inventory || []).filter((i) => i.ITID === ITID).reduce((a, b) => a + (b.count || 1), 0); }
          if (have < o.qty) return done(409, { ok: false, error: 'insufficient', have, need: o.qty });
        }
        const okSlot = await withGate(() => reclaimSlot('order'));
        if (!okSlot) return done(409, { ok: false, error: 'busy', reason: '商人正在交易中，稍后再试' });
        have = (c.inventory || []).filter((i) => i.ITID === ITID).reduce((a, b) => a + (b.count || 1), 0);   // 槽位后复查（防并发超卖）
        if (have < o.qty) return done(409, { ok: false, error: 'insufficient', have, need: o.qty });
        const unit = priceOf(ITID);
        const free = authed;   // 有 APIKEY 且匹配 → 免费；无或不匹配 → 按价目表收费（云部署安全：RO_MULE_KEY 环境变量）
        order = { from: String(o.buyer || 'buyer'), name: ID2NAME.get(ITID) || o.name, ITID, qty: +o.qty, unit, free, price: (unit || 0) * (+o.qty), buyerGID: o.buyerGID || null, buyerAID: o.buyerAID || null };
        armOrderWatch(order);
        order.armedAt = Date.now();
        log(`📦 [API] 订单: ${order.from} → ${order.name}(#${ITID})×${order.qty}${order.free ? '（授权免费）' : `（应收 ${order.price}z）`}${order.buyerGID ? ' buyerGID=' + order.buyerGID : ''}`);
        if (order.buyerGID) {
          // 真值方向：物主（商人）主动发起（06:32 抓包）——但必须等买家进视野（≤4格），否则"距离太远"且盲发全部被丢
          tradeState = 'trading';
          initiateWhenInView(order);
        } else { tradeState = 'trading'; startBlind(order); }   // 被动单也占槽（否则闸门视作 idle 会被并发单覆盖）
        done(200, { ok: true });
      } catch (e) { done(400, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u2.pathname === '/trade' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      try {
        const o = JSON.parse(body);
        // 调用方 ID 不能替代游戏端解析出的准确角色名。
        const matchPcs = () => {
          for (const e of c.entities.values()) {
            if (e.kind !== 'pc') continue;
            if (!e.name) { c.reqName(e.GID); continue; }   // 未命名：请求解析，下一轮重扫可见
          }
          return findNamedBuyerEntity(c.entities.values(), o.buyer);
        };
        let hit = matchPcs();
        if (!hit) {
          // 实体表可能被市场封包洪流冻结 → 仅 ACTORINIT 原地重建视野重扫（商人不动，8s）
          log(`🔍 买家 ${o.buyer} 不在视野 → ACTORINIT 原地重建重扫（商人不动，≤4s）`);
          const deadline = Date.now() + 4000;
          while (!hit && Date.now() < deadline) {
            try { c.mapLoaded(); } catch (_) {}
            await sleep(1500);
            hit = matchPcs();
          }
        }
        if (!String(o.buyer || '').trim()) return done(400, { ok: false, error: 'bad buyer' });
        const ITID = o.ITID || NAME2ID.get(String(o.name || '').trim());
        const haveQty = allStock().filter((i) => i.ITID === ITID).reduce((a, b) => a + (b.count || 1), 0);
        if (!ITID || haveQty <= 0) return done(409, { ok: false, error: 'no stock' });
        if (priceOf(ITID) == null) return done(403, { ok: false, error: 'not for sale（未定价）' });
        const qty6 = Math.max(1, +o.qty || 1);
        if (haveQty < qty6) return done(409, { ok: false, error: 'insufficient', have: haveQty, need: qty6 });   // 量不足早拒（曾放行到放置才被服务器拒，买家白等 40s）
        const free6 = authed;   // 同 /order：APIKEY 匹配免费
        const unit6 = priceOf(ITID);
        const okSlot = await withGate(() => reclaimSlot('trade'));
        if (!okSlot) return done(409, { ok: false, error: 'busy', reason: '商人正在交易中，稍后再试' });
        if (hit && ![...c.entities.values()].some((e) => e === hit)) {   // 排队期间买家离开视野 → 404
          const again = matchPcs();
          if (!again) hit = null;
          else hit = again;
        }
        if (!hit) {
          const localIds = !OPT.apikey ? temporaryLocalBuyerIds(loadJson(TEMP_DIRECT_FILE, null), req.socket.remoteAddress, o) : null;
          const trustedIds = trustedDirectBuyerIds(OPT.apikey, reqKey, o) || localIds;
          if (trustedIds) {
            // API key 授权可长期直发；临时本机测试租约仅限指定角色/AID且自动过期。
            order = { from: o.buyer, name: ID2NAME.get(ITID) || o.name, ITID, qty: qty6, unit: unit6,
              free: free6, price: (unit6 || 0) * qty6, buyerGID: o.buyerGID || null, buyerAID: trustedIds[0],
              buyerIds: trustedIds, trustedDirect: true };
            armOrderWatch(order);
            order.armedAt = Date.now();
            tradeState = 'trading';
            log(`🤝 [/trade] ${localIds ? '临时本机租约' : 'API key'} 授权直发 AID=${trustedIds[0]} → ${o.buyer}（${order.name}×${order.qty}）`);
            if (!sendTrustedTradeRequest(order, trustedIds)) {
              finishOrder(false, { reason: 'GID 直发失败' });
              return done(502, { ok: false, error: 'failed to send trade request' });
            }
            startBlind(order);
            return done(200, tradeReply({ targetAID: trustedIds[0], targetMode: localIds ? 'temporary_local_aid' : 'trusted_aid' }));
          }
          // 没有游戏端已核实的同名实体时，绝不能信任调用方 ID 盲发；只接受同名角色主动请求。
          order = { from: o.buyer || 'buyer', name: ID2NAME.get(ITID) || o.name, ITID, qty: qty6, unit: unit6, free: free6, price: (unit6 || 0) * qty6, buyerGID: null, buyerIds: [] };
          armOrderWatch(order);
          order.armedAt = Date.now();
          tradeState = 'trading';
          log(`🤝 [/trade] 被动单：未核实 ${o.buyer} 的视野身份 → 等其主动发起（${order.name}×${order.qty}${free6 ? '·免费' : `·应收 ${order.price}z`}）`);
          return done(200, tradeReply({ passive: true, hint: '请右键商人点交易' }));
        }
        order = { from: o.buyer || 'buyer', name: ID2NAME.get(ITID) || o.name, ITID, qty: qty6, unit: unit6, free: free6, price: (unit6 || 0) * qty6, buyerGID: hit.GID, buyerAID: hit.AID || null, buyerIds: [hit.GID, hit.AID].filter((n) => Number.isInteger(n) && n > 0) };
        armOrderWatch(order);
        order.armedAt = Date.now();
        tradeState = 'trading';
        log(`🤝 [/trade] 对 ${o.buyer}(GID=${hit.GID}) 发起交易 → 放 ${order.name}×${order.qty}${free6 ? '（授权免费）' : `（应收 ${order.price}z）`}`);
        sendVerifiedTradeRequest(order, hit);
        startBlind(order);
        done(200, tradeReply({ buyerGID: hit.GID }));
      } catch (e) { done(400, { ok: false, error: e.message }); }
    });
    return;
  }
  if (u2.pathname === '/pull' && req.method === 'POST') {   // 手动从推车取物到背包
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      try {
        const o = JSON.parse(body);
        const ITID = o.ITID || NAME2ID.get(String(o.name || '').trim());
        if (!ITID || !o.qty) return done(400, { ok: false, error: 'bad' });
        const ok = await pullFromCart(ITID, +o.qty);
        done(ok ? 200 : 409, { ok, inventory: (c.inventory || []).filter((i) => i.ITID === ITID).reduce((a, b) => a + (b.count || 1), 0) });
      } catch (e) { done(400, { ok: false, error: e.message }); }
    });
    return;
  }
  if (req.url === '/stock' && req.method === 'GET') {
    // 公开库存+价目（浏览器插件用）：合并背包+推车，附单价与商家位置——仅展示已定价商品（未定价=非卖品）
    const merged = new Map();
    for (const it of allStock()) {
      if (priceOf(it.ITID) == null) continue;   // 未定价 = 非卖品，不上目录
      const e = merged.get(it.ITID) || { ITID: it.ITID, name: ID2NAME.get(it.ITID) || '?', count: 0 };
      e.count += it.count || 1;
      merged.set(it.ITID, e);
    }
    return done(200, {
      online: !!(c.ws && c.ws.readyState === 1),
      merchant: { account: OPT.account, map: OPT.standMap, x: OPT.standX, y: OPT.standY },
      items: [...merged.values()].map((e) => ({ ...e, price: priceOf(e.ITID) })).filter((e) => e.count > 0),
    });
  }
  if (req.url === '/price' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => body += d);
    req.on('end', () => {
      try {
        const o = JSON.parse(body);
        const ITID = o.ITID || NAME2ID.get(String(o.name || '').trim());
        if (o.remove === true) {   // 下架：删除价目（目录不再显示）
          const p = loadJson(PRICES_FILE, {});
          delete p[String(ITID)];
          saveJson(PRICES_FILE, p);
          log(`⬇ 下架: ${ID2NAME.get(ITID) || ITID}`);
          return done(200, { ok: true, removed: ITID });
        }
        if (!ITID || o.price == null) return done(400, { ok: false, error: 'need name/ITID + price' });
        setPrice(ITID, +o.price);
        log(`🏷 定价: ${ID2NAME.get(ITID) || ITID} = ${+o.price}z`);
        return done(200, { ok: true, ITID, price: +o.price });
      } catch (e) { return done(400, { ok: false, error: e.message }); }
    });
    return;
  }
  if (req.url === '/auth' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => body += d);
    req.on('end', () => {
      try {
        const o = JSON.parse(body);
        const list = loadJson(AUTH_FILE, []);
        const i = list.findIndex((x) => String(x).toLowerCase() === String(o.name || '').toLowerCase());
        if (o.remove) { if (i >= 0) list.splice(i, 1); }
        else if (i < 0 && o.name) list.push(String(o.name));
        saveJson(AUTH_FILE, list);
        return done(200, { ok: true, auth: list });
      } catch (e) { return done(400, { ok: false, error: e.message }); }
    });
    return;
  }
  if (req.url === '/debug' && req.method === 'GET') {
    const pcs = [...c.entities.values()].filter((e) => e.kind === 'pc').slice(0, 60)
      .map((e) => ({ GID: e.GID, AID: e.AID, name: e.name || '?', pos: e.pos ? [e.pos[0], e.pos[1]] : null }));
    return done(200, { session: c.session, pos: c.position, pcs });
  }
  if (u2.pathname === '/cancel' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      let id = null;
      try { id = body ? JSON.parse(body).id : null; } catch (_) { return done(400, { ok: false, error: 'bad json' }); }
      if (!order) {
        if (id && lastTradeResult && lastTradeResult.id === id && lastTradeResult.ok) return done(409, { ok: false, error: 'order already completed' });
        return done(200, { ok: true, alreadyGone: true });
      }
      if (id && order.id !== id) return done(409, { ok: false, error: 'order changed' });
      const canceling = order;
      if (!windowOpen && (!order.sentTo || [0, 1, 2, 4, 5].includes(order.lastAckResult))) {
        try { c.send(BUILD.cancelExchange()); } catch (_) {}
        finishOrder(false, { reason: '未开窗取消' });
        return done(200, { ok: true, canceled: true });
      }
      const terminal = await waitForCancelConfirmation(c, () => c.send(BUILD.cancelExchange()), 3000);
      if (terminal.kind === 'done' && terminal.result === 0) return done(409, { ok: false, error: 'order already completed' });
      if (terminal.kind === 'timeout' || terminal.kind === 'send_error') return done(504, { ok: false, error: 'game cancellation unconfirmed' });
      if (order === canceling) finishOrder(false, { reason: '取消已确认' });
      return done(200, { ok: true, canceled: true });
    });
    return;
  }
  if (req.url.split('?')[0] === '/status' && req.method === 'GET') {
    const lease = !OPT.apikey && loadJson(TEMP_DIRECT_FILE, null);
    const temporaryDirect = !!(lease && temporaryLocalBuyerIds(lease, '127.0.0.1', {
      buyer: lease.buyer, buyerAID: lease.buyerAID, buyerGID: 1,
    }));
    return done(200, { online: !!(c.ws && c.ws.readyState === 1), map: c.mapName, pos: c.position, order,
      state: tradeState, windowOpen, placedAck, pricing: OPT.apikey ? 'apikey' : 'free_all', temporaryDirect });
  }
  if (req.url === '/lasttrade' && req.method === 'GET') return done(200, lastTradeResult || { ok: null });
  if (u2.pathname === '/inventory' && req.method === 'GET') {
    // 背包/推车分开返回（曾合并成一个列表且无来源标注：同物品两行分不清哪份在哪边，2026-09-21 用户要求分列显示）
    const fmt = (arr) => (arr || []).map((i) => ({ index: i.index, ITID: i.ITID, name: ID2NAME.get(i.ITID) || '?', count: i.count }));
    return done(200, { inventory: fmt(c.inventory), cart: fmt(c.cart) });
  }
  if (u2.pathname === '/') return done(200, { ok: true, service: 'mule', pricing: OPT.apikey ? 'apikey' : 'free_all' });
  done(404, {});
}).listen(OPT.port, OPT.host, () => log(`🔌 控制口 ${OPT.host}:${OPT.port}${OPT.apikey ? '（APIKEY 已启用）' : '（无 KEY，全部免费）'}`));

// ---------- 生命周期 ----------
// 流错位自愈（市场区自定义封包多，错位后实体列表冻结/清空 → 视野 PC×0、交易请求丢失）
c.on('stream_error', () => {
  log('⚠ 流错位 → 清空视野，1.5s 后 ACTORINIT 重建');
  try { c.entities.clear(); } catch (_) {}
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500);
});
// 周期保活：25s 一次 ACTORINIT（刷新实体 + 防空闲踢）
setInterval(() => {
  if (!c.ws || c.state !== 'zone') return;
  try { c.send(BUILD.actorInit()); } catch (_) {}
}, 25 * 1000);
c.on('warp_map', (p) => { bot.updateMap(p.mapName); bot.updatePos(p.xPos, p.yPos); setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 1500); });
c.on('self_move', (p) => bot.updatePos(p.move[2], p.move[3]));
c.on('banned', (p) => { log(`被踢 code=${p.code}`); if (p.code === 8 || p.code === 2) { try { c.closeAllSockets(); } catch (_) {} login.relogin(12000, '挤号'); } });
let muleEntryCount = 0;
c.on('char_list', (p) => {
  const ch = p.chars.find((x) => x.CharNum === OPT.slot) || p.chars[0];
  c.session.charName = ch.name;
  muleEntryCount++;
  log(`选角 #${muleEntryCount}: ${ch.name} (slot${ch.CharNum} Lv${ch.level})`);
  c.selectChar(ch.CharNum);
});
c.on('zone_info', (p) => c.connectZone(p.ipStr, p.port).catch((e) => log('连图失败 ' + e.message)));
c.on('map_enter', async () => {
  setTimeout(() => { try { c.mapLoaded(); } catch (_) {} }, 500);
  await sleep(3000);
  // 刷新式登录：第一次进图立刻 RESTART 回选角再进（清除继承的离线机器人会话）
  if (muleEntryCount === 1) {
    log('♻ 刷新式登录：回选角清除离线态，2s 后重进');
    c.rotating = true;
    try { c.restartToCharSelect(); } catch (_) {}
    setTimeout(() => { c.rotating = false; }, 4000);
    return;
  }
  // 状态感知关内挂：0x0AFE(id,1)=切换（用户抓包实证：取消攻击也发 22 01）
  // 只对"当前开着"的功能发一次翻转；不发 57（总开关语义不明）
  await sleep(2500);
  for (const [id, key, nm] of [[34, 'attack', '战斗'], [35, 'pick', '拾取'], [36, 'eat', '吃药']]) {
    if (botState[key] === true) {
      try { c.send(BUILD.notifyUpdateinfo(id, 1)); } catch (_) {}
      await sleep(900);
      if (botState[key] !== false) { try { c.send(BUILD.notifyUpdateinfo(id, 1)); } catch (_) {} await sleep(900); }
    }
  }
  log(`⚙ 内挂状态: 战斗=${botState.attack} 拾取=${botState.pick} 吃药=${botState.eat}（目标全 false）`);
  try {
    if (!String(c.mapName).includes(OPT.standMap)) {
      log(`飞艇 → ${OPT.standMap}`);
      c.send(BUILD.airshipRequest(OPT.standMap, OPT.standX, OPT.standY, 1, 14527));
      for (let i = 0; i < 20; i++) { await sleep(500); if (String(c.mapName).includes(OPT.standMap)) break; }
      await sleep(2500);
    }
    bot.updateMap(OPT.standMap); bot.updatePos(c.position[0], c.position[1]);
    // 走位重试：落点可能被服务器挪到远处；同城飞艇会被拒(0x0A4A=4)，飞完没拉近就走回去
    for (let att = 0; att < 3; att++) {
      const d = Math.max(Math.abs(c.position[0] - OPT.standX), Math.abs(c.position[1] - OPT.standY));
      if (d <= 3) break;   // 用户手动就位（±3格容忍）：不再走动
      if (d > 30 && att === 0) {
        log(`落点偏 ${d} 格，先试飞艇`);
        c.send(BUILD.airshipRequest(OPT.standMap, OPT.standX, OPT.standY, 1, 14527));
        await sleep(3000);
        bot.updatePos(c.position[0], c.position[1]);
        const d2 = Math.max(Math.abs(c.position[0] - OPT.standX), Math.abs(c.position[1] - OPT.standY));
        if (d2 < d) continue;
      }
      log(`🚶 走回摊位（偏 ${d} 格）`);
      await new Promise((r) => bot.walkSmart(OPT.standX, OPT.standY, () => r(), 120000));
      bot.updatePos(c.position[0], c.position[1]);
    }
    log(`📍 就位 ${c.mapName} @(${c.position})`);
    try { fs.writeFileSync(path.join(base, 'data', 'mule-inventory.json'), JSON.stringify(allStock().map((i) => ({ index: i.index, ITID: i.ITID, name: ID2NAME.get(i.ITID) || '?', count: i.count })), null, 1)); } catch (_) {}
  } catch (e) { log('就位异常: ' + e.message); }
});
// 关闭/暂停 = 优雅下号（RESTART 释放角色，不进离线模式）
const shutdown = async (why) => {
  log(`📴 ${why} → 优雅下号`);
  try { clearTimeout(blindTimer); } catch (_) {}
  try { login.stop(); } catch (_) {}
  try { await c.quitClean(); } catch (_) {}
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

login.login();
log(`=== 永驻商人 ${OPT.account} slot${OPT.slot} ===`);
