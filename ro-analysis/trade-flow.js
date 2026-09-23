'use strict';

function findNamedBuyerEntity(entities, buyer) {
  const name = String(buyer || '').trim();
  if (!name) return null;
  return [...entities].find((entity) => entity.kind === 'pc' && String(entity.name || '').trim() === name) || null;
}

function trustedDirectBuyerIds(configuredKey, suppliedKey, request) {
  if (!configuredKey || suppliedKey !== configuredKey) return null;
  const gid = Number(request && request.buyerGID);
  const aid = Number(request && request.buyerAID);
  if (!Number.isSafeInteger(aid) || aid <= 0) return null;
  return [aid, ...(Number.isSafeInteger(gid) && gid > 0 ? [gid] : [])];
}

function temporaryLocalBuyerIds(lease, remoteAddress, request, now = Date.now()) {
  if (!lease || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) return null;
  const expiresAt = Date.parse(lease.expiresAt);
  const gid = Number(request && request.buyerGID);
  const aid = Number(request && request.buyerAID);
  if (!Number.isFinite(expiresAt) || now >= expiresAt || expiresAt - now > 15 * 60 * 1000) return null;
  if (String(request && request.buyer || '').trim() !== lease.buyer || !Number.isSafeInteger(gid) || gid <= 0) return null;
  if (!Number.isSafeInteger(aid) || aid <= 0 || aid !== Number(lease.buyerAID)) return null;
  return [aid, gid];
}

function matchesBuyer(order, request) {
  const expected = String(order && order.from || '').trim();
  const actual = String(request && request.name || '').trim();
  if (!expected || !actual || actual !== expected) return false;
  const requestId = Number(request.GID);
  const ids = [...(Array.isArray(order.buyerIds) ? order.buyerIds : []), order.buyerGID, order.buyerAID]
    .map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return !requestId || !ids.length || ids.includes(requestId);
}

function mayFinalizeSeller(state) {
  return !!(state.hasOrder && state.windowOpen && state.buyerLocked && state.placedAck && !state.finalizing);
}

function tradeSucceeded(packet) {
  return !!packet && packet.result === 0;
}

function placementAckMatches(packet, pendingIndex) {
  return tradeSucceeded(packet) && Number.isInteger(pendingIndex) && packet.index === pendingIndex;
}

function ackMatchesBuyer(order, packet) {
  if (!order || !order.sentTo || !Array.isArray(order.verifiedBuyerIds) || !order.verifiedBuyerIds.includes(Number(order.sentTo)) || !packet || packet.result !== 3) return false;
  if (!packet.GID) return true; // 旧版 0x00E7 不携带 GID，只能依赖已发送的目标与冷却隔离。
  return order.verifiedBuyerIds.includes(Number(packet.GID));
}

function creditTradeInventory(inventory, ITID, before, need, itemIndex) {
  const matching = inventory.filter((it) => it.ITID === ITID);
  const current = matching.reduce((total, it) => total + (it.count || 1), 0);
  const delta = Math.max(0, before + need - current);
  if (!delta) return true;
  const target = matching.find((it) => Number.isInteger(it.index) && it.index >= 0);
  if (target) { target.count = (target.count || 1) + delta; return true; }
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || inventory.some((it) => it.index === itemIndex)) return false;
  inventory.push({ ITID, index: itemIndex, count: delta });
  return true;
}

function settleMuleDelivery(inventory, ITID, before, need, outcome) {
  if (!outcome || !outcome.ok || !outcome.orderId) return { delivered: false, locallyTracked: false };
  return {
    delivered: true,
    locallyTracked: creditTradeInventory(inventory, ITID, before, need, outcome.itemIndex),
  };
}

function waitForCancelConfirmation(client, sendCancel, timeoutMs = 3000) {
  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.removeListener('trade_cancel', onCancel);
      client.removeListener('trade_done', onDone);
      resolve(result);
    };
    const onCancel = () => finish({ kind: 'cancel' });
    const onDone = (packet) => finish({ kind: 'done', result: packet && packet.result });
    client.on('trade_cancel', onCancel);
    client.on('trade_done', onDone);
    timer = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs);
    try { sendCancel(); } catch (e) { finish({ kind: 'send_error', error: e.message }); }
  });
}

function approachSpots(center, walkable) {
  const [x, y] = center;
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]];
  return offsets.map(([dx, dy]) => [x + dx, y + dy]).filter(([tx, ty]) => walkable(tx, ty));
}

async function retryMuleExchange({ center, spots, position, walk, exchange, slotIsFree, onAttempt = () => {}, onFailure = () => {} }) {
  for (let attempt = 0; attempt < spots.length; attempt++) {
    const spot = spots[attempt];
    const current = position();
    const distance = Math.max(Math.abs(current[0] - center[0]), Math.abs(current[1] - center[1]));
    if (attempt > 0 || distance > 3) await walk(spot, attempt, spots.length);
    const landed = position();
    const near = Math.max(Math.abs(landed[0] - center[0]), Math.abs(landed[1] - center[1]));
    if (near > 4) { onFailure({ ok: false, reason: `距商人仍有 ${near} 格`, retryable: true }); continue; }
    onAttempt(attempt, spots.length);
    const outcome = await exchange(attempt);
    if (outcome.ok) return outcome;
    onFailure(outcome);
    if (!outcome.retryable) return outcome;
    if (!(await slotIsFree())) return { ok: false, retryable: false, reason: '旧订单仍未释放' };
  }
  return { ok: false, retryable: false, reason: '交易落点/次数已耗尽' };
}

function receiveMuleTrade({ client, requestOrder, readStatus, cancelOrder, send, build, ITID, qty, timeoutMs = 40000, pollMs = 500, inventoryWaitMs = 1500, log = () => {} }) {
  return new Promise((resolve) => {
    let settled = false;
    let reply = null;
    let request = null;
    let accepted = false;
    let placed = false;
    let locked = false;
    let executing = false;
    let polling = false;
    let itemIndex = null;
    let successPending = false;
    let passiveTarget = null;
    const timers = new Set();
    let pollTimer = null;
    const later = (fn, ms) => {
      const timer = setTimeout(() => { timers.delete(timer); if (!settled) fn(); }, ms);
      timers.add(timer);
    };
    const cleanup = () => {
      client.removeListener('trade_request', onRequest);
      client.removeListener('trade_conclude', onConclude);
      client.removeListener('trade_done', onDone);
      client.removeListener('trade_cancel', onCancel);
      client.removeListener('trade_ack', onAck);
      client.removeListener('inv_item', onInventoryItem);
      if (pollTimer) clearInterval(pollTimer);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
    const finish = async (ok, reason, retryable = true) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!ok) {
        if (accepted) { try { send(build.cancelExchange()); } catch (_) {} }
        if (reply && reply.id) {
          try { await cancelOrder(reply.id); } catch (_) { retryable = false; }
        }
      }
      resolve({ ok, reason, retryable: !ok && retryable && !!(reply && reply.id), orderId: reply && reply.id, itemIndex });
    };
    const lock = () => {
      if (settled || locked || !accepted || !placed) return;
      locked = true;
      try { send(build.concludeExchange()); } catch (e) { finish(false, `锁定发送失败: ${e.message}`); }
      log('🔒 商人已确认放货，我方锁定');
    };
    const poll = async () => {
      if (settled || !accepted || !reply || polling || placed) return;
      polling = true;
      try {
        const state = await readStatus(reply.id);
        if (settled) return;
        if (state && state.order && state.order.id === reply.id && state.order.ITID === ITID && state.order.qty === qty && state.placedAck && state.windowOpen) {
          placed = true;
          lock();
        }
      } catch (_) { /* 下次轮询 */ }
      finally { polling = false; }
    };
    const acceptRequest = () => {
      if (settled || !reply || !request || accepted) return;
      if (!request.name || String(request.name).trim() !== String(reply.seller || '').trim()) {
        log(`⚠ 忽略非商人交易请求: ${request.name || '(空名)'}`);
        request = null;
        return;
      }
      accepted = true;
      try { send(build.ackExchange(3)); } catch (e) { finish(false, `接受发送失败: ${e.message}`); return; }
      log(`🤝 接受 ${request.name} 的交易请求`);
      pollTimer = setInterval(poll, pollMs);
      poll();
    };
    const onAck = (packet) => {
      if (settled || !passiveTarget || accepted || !packet) return;
      if (packet.GID && ![passiveTarget.GID, passiveTarget.AID].includes(packet.GID)) return;
      if (packet.result !== 3) return finish(false, `商人未接受交易 result=${packet.result}`);
      accepted = true;
      pollTimer = setInterval(poll, pollMs);
      poll();
    };
    const onRequest = (p) => { if (!settled && !accepted) { request = p; acceptRequest(); } };
    const onConclude = (p) => {
      if (settled || !p || !p.who || !locked || executing) return;
      executing = true;
      later(() => { try { send(build.execExchange()); } catch (_) {} }, 700);
      later(() => { try { send(build.execExchange()); } catch (_) {} }, 2000);
    };
    const onDone = (p) => {
      if (!accepted) return;
      if (!tradeSucceeded(p)) return finish(false, `执行失败 result=${p && p.result}`);
      if (!placed || !locked || !executing) return finish(false, '成功回执早于本次双方锁定，成交状态不明', false);
      successPending = true;
      if (itemIndex != null) finish(true);
      else later(() => finish(true), inventoryWaitMs);
    };
    const onInventoryItem = (p) => {
      if (p && p.ITID === ITID && Number.isInteger(p.index) && p.index >= 0) {
        itemIndex = p.index;
        if (successPending) finish(true);
      }
    };
    const onCancel = () => { if (!successPending && (reply || accepted)) finish(false, '交易被取消'); };
    client.on('trade_request', onRequest);
    client.on('trade_conclude', onConclude);
    client.on('trade_done', onDone);
    client.on('trade_cancel', onCancel);
    client.on('trade_ack', onAck);
    client.on('inv_item', onInventoryItem);
    later(() => { if (!successPending) finish(false, '交易超时'); }, timeoutMs);
    Promise.resolve().then(requestOrder).then((r) => {
      if (settled) return;
      if (r && r.ok && r.id) reply = r;
      if (!r || !r.ok || !r.free || !r.id || !r.seller) {
        finish(false, r && (r.error || r.reason) || '下单未确认/非免费单', false);
        return;
      }
      if (r.passive) {
        passiveTarget = client.entities && findNamedBuyerEntity(client.entities.values(), r.seller);
        if (!passiveTarget) return finish(false, '商人视野身份未核实，不能主动发交易', true);
        try { send(build.requestExchange(passiveTarget.GID)); } catch (e) { return finish(false, `发起交易失败: ${e.message}`); }
      } else acceptRequest();
    }).catch((e) => finish(false, `下单异常: ${e.message}`, false));
  });
}

module.exports = { findNamedBuyerEntity, trustedDirectBuyerIds, temporaryLocalBuyerIds, matchesBuyer, mayFinalizeSeller, tradeSucceeded, placementAckMatches, ackMatchesBuyer, creditTradeInventory, settleMuleDelivery, waitForCancelConfirmation, approachSpots, retryMuleExchange, receiveMuleTrade };
