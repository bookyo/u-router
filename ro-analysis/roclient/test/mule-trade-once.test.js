'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { preflightFreePurchase, verifyPurchase, waitForPurchaseProof, merchantSeesBuyer } = require('../../mule-trade-once-core');
const scriptTest = process.env.MULE_SIM_CHILD === '1' ? test.skip : test;

const ready = () => ({
  account: 'xiezixing',
  busy: [{ account: 'xiezixing4', sys: 'level' }],
  stock: { online: true, items: [{ ITID: 921, name: '香菇芽孢', count: 547, price: 150 }] },
  status: { online: true, map: 'morocc.gat', pos: [181, 85, 0], state: 'idle', order: null, pricing: 'free_all' },
  ITID: 921, qty: 2,
});

test('free trade preflight accepts exactly two in-stock spores from an idle online merchant', () => {
  const result = preflightFreePurchase(ready());
  assert.deepEqual(result, { item: { ITID: 921, name: '香菇芽孢', count: 547, price: 150 }, stand: [181, 85] });
});

test('free trade preflight refuses a workbench-owned buyer account', () => {
  assert.throws(() => preflightFreePurchase({ ...ready(), busy: [{ account: 'xiezixing', sys: 'bounty' }] }), /占用/);
});

test('free trade preflight refuses missing stock, a busy merchant, or a paid merchant', () => {
  assert.throws(() => preflightFreePurchase({ ...ready(), stock: { online: true, items: [{ ITID: 921, name: '香菇芽孢', count: 1, price: 150 }] } }), /库存不足/);
  assert.throws(() => preflightFreePurchase({ ...ready(), status: { ...ready().status, order: { id: 'another' } } }), /正在交易/);
  assert.throws(() => preflightFreePurchase({ ...ready(), status: { ...ready().status, pricing: 'apikey' } }), /免费模式/);
});

test('keyed merchant can be used only when buyer is configured to send an API key', () => {
  const keyed = { ...ready(), status: { ...ready().status, pricing: 'apikey' } };
  assert.throws(() => preflightFreePurchase(keyed), /免费模式/);
  assert.deepEqual(preflightFreePurchase({ ...keyed, hasApiKey: true }).stand, [181, 85]);
});

test('temporary direct-ID state permits an order without a merchant-side entity', () => {
  const plan = preflightFreePurchase({ ...ready(), status: { ...ready().status, temporaryDirect: true } });
  assert.equal(plan.trustedLocal, true);
});

test('purchase proof needs the same successful order and observed stock decrease', () => {
  assert.equal(verifyPurchase({ outcome: { ok: true, orderId: 'ours' }, lastTrade: { ok: true, id: 'ours' }, beforeStock: 547, afterStock: 545, qty: 2 }), true);
  assert.equal(verifyPurchase({ outcome: { ok: true, orderId: 'ours' }, lastTrade: { ok: true, id: 'other' }, beforeStock: 547, afterStock: 545, qty: 2 }), false);
  assert.equal(verifyPurchase({ outcome: { ok: true, orderId: 'ours' }, lastTrade: { ok: true, id: 'ours' }, beforeStock: 547, afterStock: 547, qty: 2 }), false);
});

test('purchase proof waits for merchant receipt and inventory to catch up without placing another order', async () => {
  let receiptReads = 0;
  let stockReads = 0;
  const proof = await waitForPurchaseProof({
    outcome: { ok: true, orderId: 'ours' }, beforeStock: 547, qty: 2, timeoutMs: 100, pollMs: 1,
    readLastTrade: async () => (++receiptReads < 2 ? { ok: true, id: 'previous' } : { ok: true, id: 'ours' }),
    readStock: async () => ({ items: [{ ITID: 921, count: ++stockReads < 3 ? 547 : 545 }] }),
    ITID: 921,
  });
  assert.equal(proof.afterStock, 545);
  assert.ok(receiptReads >= 3);
  assert.ok(stockReads >= 3);
});

test('merchant visibility preflight needs the exact nearby buyer and matching game identity', () => {
  const base = { buyerName: '蝎子星', buyerIds: [2009054, 2009450], stand: [181, 85] };
  assert.equal(merchantSeesBuyer({ ...base, debug: { pcs: [{ name: '蝎子星', GID: 2009450, pos: [182, 85] }] } }), true);
  assert.equal(merchantSeesBuyer({ ...base, debug: { pcs: [{ name: '蝎子星2', GID: 2009450, pos: [182, 85] }] } }), false);
  assert.equal(merchantSeesBuyer({ ...base, debug: { pcs: [{ name: '蝎子星', GID: 123, pos: [182, 85] }] } }), false);
  assert.equal(merchantSeesBuyer({ ...base, debug: { pcs: [{ name: '蝎子星', GID: 2009450, pos: [190, 85] }] } }), false);
});

scriptTest('smoke script simulation runs transaction scenarios without credentials or game login', () => {
  const script = path.join(__dirname, '..', '..', 'mule-trade-once.js');
  const run = spawnSync(process.execPath, [script, '--simulate'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, RO_PASS: '' } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /tests \d+/);
  assert.match(run.stdout, /fail 0/);
});

scriptTest('live smoke script refuses to log in without an environment password', () => {
  const script = path.join(__dirname, '..', '..', 'mule-trade-once.js');
  const run = spawnSync(process.execPath, [script, '--live'], { encoding: 'utf8', timeout: 2000, env: { ...process.env, RO_PASS: '' } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /RO_PASS/);
});

scriptTest('live smoke script checks the workbench before opening a game connection', () => {
  const script = path.join(__dirname, '..', '..', 'mule-trade-once.js');
  const run = spawnSync(process.execPath, [script, '--live'], { encoding: 'utf8', timeout: 3000,
    env: { ...process.env, RO_USER: 'xiezixing', RO_PASS: 'test-only', WB_URL: 'http://127.0.0.1:1' } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /预检失败/);
  assert.doesNotMatch(run.stderr, /test-only/);
});

scriptTest('live smoke script cannot be redirected to another account', () => {
  const script = path.join(__dirname, '..', '..', 'mule-trade-once.js');
  const run = spawnSync(process.execPath, [script, '--live'], { encoding: 'utf8', timeout: 3000,
    env: { ...process.env, RO_USER: 'someone-else', RO_PASS: 'test-only', WB_URL: 'http://127.0.0.1:1' } });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /只允许 xiezixing/);
});
