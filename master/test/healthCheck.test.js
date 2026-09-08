'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const { before, after, test } = require('node:test');

const Edge = require('../src/models/Edge');
const { checkEdge } = require('../src/services/healthCheck');
const { transitionStatus } = require('../src/services/passiveHealth');

const cfg = {
  healthTimeoutMs: 1000,
  healthCheckIntervalSec: 15,
  unhealthyAfterFailures: 3,
  offlineAfterFailures: 10,
  recoverySuccesses: 3,
};
const noop = () => {};

let server;
let port;
let mode = 'ok';
let connected = false;

before(async () => {
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017/urouter_test_health', {
      serverSelectionTimeoutMS: 2000,
    });
    connected = true;
  } catch {
    connected = false;
  }
  server = http.createServer((req, res) => {
    if (mode === 'fail') {
      res.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  server.close();
  if (connected) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});

async function freshEdge() {
  await Edge.deleteMany({});
  return Edge.create({ edge_id: 't-edge', base_url: `http://127.0.0.1:${port}`, token_secret: 'x' });
}

test('探活成功递增计数，且不覆盖被动引擎写入的 last_ratios', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  const edge = await freshEdge();
  await Edge.updateOne({ edge_id: 't-edge' }, { $set: { 'health.last_ratios': { '5m': 0.5 } } });
  mode = 'ok';
  await checkEdge(edge, cfg, noop);
  const doc = await Edge.findOne({ edge_id: 't-edge' }).lean();
  assert.equal(doc.health.consecutive_successes, 1);
  assert.deepEqual(doc.health.last_ratios, { '5m': 0.5 }); // 旧实现整体覆盖 health 会丢掉它
});

test('连续失败 3 次 → unhealthy；连续成功 3 次 → degraded', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  const edge = await freshEdge();
  mode = 'fail';
  for (let i = 0; i < 3; i++) await checkEdge(edge, cfg, noop);
  let doc = await Edge.findOne({ edge_id: 't-edge' }).lean();
  assert.equal(doc.status, 'unhealthy');
  assert.equal(doc.health.consecutive_failures, 3);

  mode = 'ok';
  for (let i = 0; i < 2; i++) await checkEdge(edge, cfg, noop);
  doc = await Edge.findOne({ edge_id: 't-edge' }).lean();
  assert.equal(doc.status, 'unhealthy');
  await checkEdge(edge, cfg, noop);
  doc = await Edge.findOne({ edge_id: 't-edge' }).lean();
  assert.equal(doc.status, 'degraded');
});

test('并发探活计数不丢失（原子 $inc）', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  const edge = await freshEdge();
  mode = 'ok';
  await Promise.all(Array.from({ length: 5 }, () => checkEdge(edge, cfg, noop)));
  const doc = await Edge.findOne({ edge_id: 't-edge' }).lean();
  assert.equal(doc.health.consecutive_successes, 5);
});

test('状态迁移使用 CAS：旧状态不匹配时不覆盖并发写入的新状态', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  await freshEdge(); // 初始 healthy
  const r1 = await transitionStatus('t-edge', 'healthy', 'degraded');
  assert.equal(r1.updated, true);
  let doc = await Edge.findOne({ edge_id: 't-edge' }).lean();
  assert.equal(doc.status, 'degraded');

  // 模拟另一引擎已并发改动状态：用过期的期望状态迁移必须失败且不覆盖
  const r2 = await transitionStatus('t-edge', 'healthy', 'unhealthy');
  assert.equal(r2.updated, false);
  doc = await Edge.findOne({ edge_id: 't-edge' }).lean();
  assert.equal(doc.status, 'degraded', '不应覆盖并发写入的新状态');
});

test('探活状态迁移绑定计数版本：并发改写计数后迟到的迁移必须失败', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  await freshEdge();
  // 场景：三次成功探活应迁 degraded；迁移落库前，并发的一次失败已把计数归零
  await Edge.updateOne(
    { edge_id: 't-edge' },
    { $set: { status: 'unhealthy', 'health.consecutive_successes': 3, 'health.consecutive_failures': 0 } },
  );
  await Edge.updateOne(
    { edge_id: 't-edge' },
    { $set: { 'health.consecutive_successes': 0, 'health.consecutive_failures': 1 } },
  );
  // 仅按状态 CAS 的旧实现会写入 degraded（与最新失败信号矛盾）
  const r = await transitionStatus('t-edge', 'unhealthy', 'degraded', { successes: 3, failures: 0 });
  assert.equal(r.updated, false);
  const doc = await Edge.findOne({ edge_id: 't-edge' }).lean();
  assert.equal(doc.status, 'unhealthy');

  // 不带计数期望（被动引擎场景）仍可用
  const r2 = await transitionStatus('t-edge', 'unhealthy', 'degraded');
  assert.equal(r2.updated, true);
});
