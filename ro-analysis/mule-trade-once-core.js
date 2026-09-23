'use strict';

function preflightFreePurchase({ account, busy, stock, status, ITID, qty, hasApiKey = false }) {
  if (!account || !Number.isInteger(ITID) || !Number.isInteger(qty) || qty < 1) throw new Error('账号或商品参数无效');
  if ((busy || []).some((entry) => String(entry.account || '').replace(/_M$/, '') === account)) throw new Error(`账号 ${account} 已被工作台占用`);
  if (!stock || !stock.online) throw new Error('商人目录未在线');
  const item = (stock.items || []).find((entry) => entry.ITID === ITID);
  if (!item || item.count < qty) throw new Error(`商人库存不足：需 ${qty} 个`);
  if (!status || !status.online || !String(status.map || '').startsWith('morocc') || !Array.isArray(status.pos)) throw new Error('商人尚未在梦罗克就位');
  if (status.order || status.state !== 'idle') throw new Error('商人正在交易中');
  if (status.pricing !== 'free_all' && !(status.pricing === 'apikey' && hasApiKey)) throw new Error('商人已非免费模式，拒绝自动下单');
  return { item, stand: status.pos.slice(0, 2),
    ...(status.pricing === 'apikey' ? { keyed: true } : {}),
    ...(status.temporaryDirect ? { trustedLocal: true } : {}) };
}

function verifyPurchase({ outcome, lastTrade, beforeStock, afterStock, qty }) {
  return !!(outcome && outcome.ok && outcome.orderId && lastTrade && lastTrade.ok && lastTrade.id === outcome.orderId
    && Number.isFinite(beforeStock) && Number.isFinite(afterStock) && beforeStock - afterStock >= qty);
}

function merchantSeesBuyer({ debug, buyerName, buyerIds, stand }) {
  const ids = new Set((buyerIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0));
  if (!buyerName || !ids.size || !Array.isArray(stand)) return false;
  return (debug && debug.pcs || []).some((pc) => {
    if (String(pc.name || '').trim() !== buyerName || !Array.isArray(pc.pos)) return false;
    const near = Math.max(Math.abs(pc.pos[0] - stand[0]), Math.abs(pc.pos[1] - stand[1])) <= 4;
    return near && [pc.GID, pc.AID].map(Number).some((id) => ids.has(id));
  });
}

async function waitForPurchaseProof({ outcome, beforeStock, qty, ITID, readLastTrade, readStock, timeoutMs = 10000, pollMs = 300 }) {
  if (!outcome || !outcome.ok || !outcome.orderId) throw new Error('买家交易结果未确认');
  const deadline = Date.now() + timeoutMs;
  let lastTrade, afterStock;
  do {
    try {
      [lastTrade, afterStock] = await Promise.all([
        readLastTrade(),
        readStock().then((stock) => (stock.items || []).find((item) => item.ITID === ITID)?.count),
      ]);
      if (verifyPurchase({ outcome, lastTrade, beforeStock, afterStock, qty })) return { lastTrade, afterStock };
      if (lastTrade && lastTrade.id === outcome.orderId && lastTrade.ok === false) throw new Error(`商人报告订单 ${outcome.orderId} 失败`);
    } catch (error) {
      if (error.message.includes('商人报告订单')) throw error;
    }
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline - Date.now())));
  } while (Date.now() <= deadline);
  throw new Error(`成交证据未齐（订单 ${outcome.orderId}，商人库存 ${beforeStock}→${afterStock ?? '未知'}）；不重试`);
}

module.exports = { preflightFreePurchase, verifyPurchase, waitForPurchaseProof, merchantSeesBuyer };
