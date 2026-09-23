'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ROClient } = require('../lib/client');
const {
  matchesBuyer,
  mayFinalizeSeller,
  tradeSucceeded,
  placementAckMatches,
  ackMatchesBuyer,
  approachSpots,
  receiveMuleTrade,
  retryMuleExchange,
  creditTradeInventory,
  settleMuleDelivery,
  waitForCancelConfirmation,
  findNamedBuyerEntity,
  trustedDirectBuyerIds,
  temporaryLocalBuyerIds,
} = require('../../trade-flow');

test('active seller target must be a visible exact-name buyer, never a caller ID alone', () => {
  const bob = { kind: 'pc', name: 'Bob', GID: 101, AID: 201 };
  const alice = { kind: 'pc', name: 'Alice', GID: 102, AID: 202 };
  assert.equal(findNamedBuyerEntity([bob], 'Alice'), null);
  assert.equal(findNamedBuyerEntity([bob, alice], 'Alice'), alice);
  assert.equal(findNamedBuyerEntity([{ ...alice, name: 'Alice2' }], 'Alice'), null);
});

test('account AID is the direct trade target only with a configured matching API key', () => {
  const target = { buyerGID: 300, buyerAID: 301 };
  assert.deepEqual(trustedDirectBuyerIds('key', 'key', target), [301, 300]);
  assert.equal(trustedDirectBuyerIds('', '', target), null);
  assert.equal(trustedDirectBuyerIds('key', 'wrong', target), null);
  assert.equal(trustedDirectBuyerIds('key', 'key', { buyerGID: 300, buyerAID: 0 }), null);
});

test('temporary local GID override is buyer-bound and expires', () => {
  const lease = { buyer: '蝎子星', buyerAID: 2009054, expiresAt: '2026-09-23T09:10:00Z' };
  const request = { buyer: '蝎子星', buyerGID: 192001, buyerAID: 2009054 };
  const now = Date.parse('2026-09-23T09:00:00Z');
  assert.deepEqual(temporaryLocalBuyerIds(lease, '127.0.0.1', request, now), [2009054, 192001]);
  assert.equal(temporaryLocalBuyerIds(lease, '8.8.8.8', request, now), null);
  assert.equal(temporaryLocalBuyerIds(lease, '127.0.0.1', { ...request, buyer: 'other' }, now), null);
  assert.equal(temporaryLocalBuyerIds(lease, '127.0.0.1', { ...request, buyerAID: 123 }, now), null);
  assert.equal(temporaryLocalBuyerIds(lease, '127.0.0.1', request, Date.parse('2026-09-23T09:10:00Z')), null);
});

test('merchant rejects empty and substring names, but accepts the exact buyer', () => {
  const order = { from: '蝎子买家', buyerGID: 101, buyerAID: 202 };
  assert.equal(matchesBuyer(order, { name: '' }), false);
  assert.equal(matchesBuyer(order, { name: '蝎子' }), false);
  assert.equal(matchesBuyer(order, { name: '蝎子买家2' }), false);
  assert.equal(matchesBuyer(order, { name: '蝎子买家', GID: 999 }), false);
  assert.equal(matchesBuyer(order, { name: '蝎子买家', GID: 202 }), true);
  assert.equal(matchesBuyer(order, { name: ' 蝎子买家 ' }), true);
  assert.equal(matchesBuyer({ ...order, buyerIds: [101, 202, 303] }, { name: '蝎子买家', GID: 303 }), true);
});

test('seller cannot finalize before its item is acknowledged and buyer locked', () => {
  const ready = { hasOrder: true, windowOpen: true, buyerLocked: true, placedAck: true, finalizing: false };
  assert.equal(mayFinalizeSeller({ ...ready, placedAck: false }), false);
  assert.equal(mayFinalizeSeller({ ...ready, buyerLocked: false }), false);
  assert.equal(mayFinalizeSeller({ ...ready, finalizing: true }), false);
  assert.equal(mayFinalizeSeller(ready), true);
});

test('only result zero is a successful exchange', () => {
  assert.equal(tradeSucceeded({ result: 0 }), true);
  assert.equal(tradeSucceeded({ result: 1 }), false);
  assert.equal(tradeSucceeded({}), false);
});

test('0x00EA decodes inventory index before the placement result', () => {
  const client = new ROClient();
  let ack = null;
  client.on('trade_add_ack', (packet) => { ack = packet; });
  client.handlePacket(0x00EA, Buffer.from([0xEA, 0x00, 0x34, 0x12, 0x00]));
  assert.deepEqual(ack, { index: 0x1234, result: 0 });
});

test('merchant ignores failed or unrelated placement acknowledgements', () => {
  assert.equal(placementAckMatches({ index: 17, result: 0 }, 17), true);
  assert.equal(placementAckMatches({ index: 18, result: 0 }, 17), false);
  assert.equal(placementAckMatches({ index: 17, result: 1 }, 17), false);
});

test('merchant refuses a successful exchange ACK for another player ID', () => {
  const order = { buyerIds: [999], verifiedBuyerIds: [101, 202], sentTo: 101 };
  assert.equal(ackMatchesBuyer(order, { result: 3, GID: 101 }), true);
  assert.equal(ackMatchesBuyer(order, { result: 3, GID: 202 }), true);
  assert.equal(ackMatchesBuyer(order, { result: 3, GID: 999 }), false);
  assert.equal(ackMatchesBuyer({ buyerIds: [999], sentTo: 999 }, { result: 3, GID: 999 }), false);
  assert.equal(ackMatchesBuyer(null, { result: 3, GID: 101 }), false);
});

test('inventory credit adds only the missing delta across multiple stacks', () => {
  const inventory = [{ ITID: 444, index: 7, count: 2 }, { ITID: 444, index: 8, count: 3 }];
  assert.equal(creditTradeInventory(inventory, 444, 5, 4, null), true);
  assert.equal(inventory.reduce((n, it) => n + it.count, 0), 9);
  assert.equal(creditTradeInventory(inventory, 444, 5, 4, null), true);
  assert.equal(inventory.reduce((n, it) => n + it.count, 0), 9);
});

test('inventory credit refuses to invent an item with an invalid index', () => {
  const inventory = [];
  assert.equal(creditTradeInventory(inventory, 444, 0, 5, null), false);
  assert.deepEqual(inventory, []);
  assert.equal(creditTradeInventory(inventory, 444, 0, 5, 23), true);
  assert.deepEqual(inventory, [{ ITID: 444, index: 23, count: 5 }]);
});

test('successful trade without a new item index still returns to the bounty NPC without inventing local inventory', () => {
  const inventory = [];
  assert.deepEqual(settleMuleDelivery(inventory, 921, 0, 2, { ok: true, orderId: 'trade-1', itemIndex: null }), {
    delivered: true, locallyTracked: false,
  });
  assert.deepEqual(inventory, []);
});

test('failed trade never advances the bounty task or credits inventory', () => {
  const inventory = [];
  assert.deepEqual(settleMuleDelivery(inventory, 921, 0, 2, { ok: false, orderId: 'trade-2', itemIndex: 27 }), {
    delivered: false, locallyTracked: false,
  });
  assert.deepEqual(inventory, []);
});

test('approach candidates stay within two cells and skip blocked cells', () => {
  const spots = approachSpots([181, 85], (x, y) => !(x === 182 && y === 85));
  assert.ok(spots.length >= 3);
  assert.ok(spots.every(([x, y]) => Math.max(Math.abs(x - 181), Math.abs(y - 85)) <= 2));
  assert.ok(spots.every(([x, y]) => !(x === 182 && y === 85)));
  assert.deepEqual(spots[0], [180, 85]);
});

function setupTrade({ placed = false, earlyRequest = false, result = 0 } = {}) {
  const client = new EventEmitter();
  const sent = [];
  const canceled = [];
  let isPlaced = placed;
  const requestOrder = async () => {
    if (earlyRequest) client.emit('trade_request', { name: '常驻商人' });
    return { ok: true, id: 'order-1', seller: '常驻商人', free: true };
  };
  const readStatus = async () => ({ order: { id: 'order-1', ITID: 444, qty: 5 }, placedAck: isPlaced, windowOpen: true });
  const promise = receiveMuleTrade({
    client, requestOrder, readStatus, cancelOrder: async (id) => canceled.push(id),
    send: (packet) => sent.push(packet),
    build: { ackExchange: () => 'accept', concludeExchange: () => 'lock', execExchange: () => 'execute', cancelExchange: () => 'cancel' },
    ITID: 444, qty: 5, timeoutMs: 90, pollMs: 5, log: () => {},
  });
  return { client, sent, canceled, promise, place: () => { isPlaced = true; }, result };
}

test('buyer listener is active before order request and locks only after merchant placement', async () => {
  const s = setupTrade({ earlyRequest: true });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(s.sent.includes('accept'));
  assert.equal(s.sent.includes('lock'), false);
  s.place();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(s.sent.includes('lock'));
  s.client.emit('trade_conclude', { who: 1 });
  s.client.emit('trade_done', { result: 0 });
  assert.equal((await s.promise).ok, true);
  assert.deepEqual(s.canceled, []);
});

test('buyer retains inventory listener briefly after successful done for a late new-item index', async () => {
  const s = setupTrade({ placed: true, earlyRequest: true });
  await new Promise((resolve) => setTimeout(resolve, 15));
  s.client.emit('trade_conclude', { who: 1 });
  s.client.emit('trade_done', { result: 0 });
  setTimeout(() => s.client.emit('inv_item', { ITID: 444, index: 27 }), 5);
  const outcome = await s.promise;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.itemIndex, 27);
});

test('passive merchant order is initiated only against an exact-name visible merchant', async () => {
  const client = new EventEmitter();
  client.entities = new Map([[1, { kind: 'pc', name: '常驻商人', GID: 300, AID: 301 }]]);
  const sent = [];
  const promise = receiveMuleTrade({
    client, ITID: 444, qty: 5, timeoutMs: 100, pollMs: 5, inventoryWaitMs: 5,
    requestOrder: async () => ({ ok: true, id: 'passive-1', seller: '常驻商人', free: true, passive: true }),
    readStatus: async () => ({ order: { id: 'passive-1', ITID: 444, qty: 5 }, placedAck: true, windowOpen: true }),
    cancelOrder: async () => {}, send: (packet) => sent.push(packet),
    build: { requestExchange: (id) => `request-${id}`, ackExchange: () => 'accept', concludeExchange: () => 'lock', execExchange: () => 'execute', cancelExchange: () => 'cancel' },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(sent.includes('request-300'));
  client.emit('trade_ack', { result: 3, GID: 300 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(sent.includes('lock'));
  client.emit('trade_conclude', { who: 1 });
  client.emit('inv_item', { ITID: 444, index: 28 });
  client.emit('trade_done', { result: 0 });
  assert.equal((await promise).ok, true);
});

test('missing merchant placement times out, cancels only its order, and does not lock', async () => {
  const s = setupTrade();
  await new Promise((resolve) => setTimeout(resolve, 5));
  s.client.emit('trade_request', { name: '常驻商人' });
  const outcome = await s.promise;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.retryable, true);
  assert.equal(s.sent.includes('lock'), false);
  assert.deepEqual(s.canceled, ['order-1']);
});

test('failed server result never reports goods received', async () => {
  const s = setupTrade({ placed: true, earlyRequest: true });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(s.sent.includes('lock'));
  s.client.emit('trade_done', { result: 1 });
  assert.equal((await s.promise).ok, false);
});

test('success packet before peer lock is treated as uncertain, not credited', async () => {
  const s = setupTrade({ placed: true, earlyRequest: true });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.ok(s.sent.includes('lock'));
  s.client.emit('trade_done', { result: 0 });
  const result = await s.promise;
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
});

test('non-free response cancels the just-created merchant order', async () => {
  const canceled = [];
  const outcome = await receiveMuleTrade({
    client: new EventEmitter(), ITID: 444, qty: 5,
    requestOrder: async () => ({ ok: true, id: 'paid-order', seller: '常驻商人', free: false }),
    readStatus: async () => null,
    cancelOrder: async (id) => canceled.push(id),
    send: () => {},
    build: { ackExchange: () => 'accept', concludeExchange: () => 'lock', execExchange: () => 'execute', cancelExchange: () => 'cancel' },
    timeoutMs: 100,
  });
  assert.equal(outcome.ok, false);
  assert.deepEqual(canceled, ['paid-order']);
});

test('failed exchange walks to another axis offset before one more order', async () => {
  let position = [188, 85];
  const walked = [];
  let orders = 0;
  const result = await retryMuleExchange({
    center: [181, 85], spots: [[182, 85], [180, 85], [181, 86]],
    position: () => position,
    walk: async (spot) => { walked.push(spot); position = spot; },
    exchange: async () => { orders++; return orders === 1 ? { ok: false, retryable: true } : { ok: true }; },
    slotIsFree: async () => true,
  });
  assert.equal(result.ok, true);
  assert.equal(orders, 2);
  assert.deepEqual(walked, [[182, 85], [180, 85]]);
});

test('retry stops when previous merchant order still occupies the slot', async () => {
  let orders = 0;
  const result = await retryMuleExchange({
    center: [181, 85], spots: [[182, 85], [180, 85]],
    position: () => [182, 85], walk: async () => {},
    exchange: async () => { orders++; return { ok: false, retryable: true }; },
    slotIsFree: async () => false,
  });
  assert.equal(result.ok, false);
  assert.equal(orders, 1);
});

test('merchant waits for game cancellation before saying an order can be retried', async () => {
  const client = new EventEmitter();
  const pending = waitForCancelConfirmation(client, () => {
    setTimeout(() => client.emit('trade_cancel'), 5);
  }, 50);
  assert.deepEqual(await pending, { kind: 'cancel' });
  assert.equal(client.listenerCount('trade_cancel'), 0);
});

test('unconfirmed game cancellation times out instead of claiming success', async () => {
  const client = new EventEmitter();
  assert.deepEqual(await waitForCancelConfirmation(client, () => {}, 10), { kind: 'timeout' });
});
