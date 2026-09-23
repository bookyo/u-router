'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const mongoose = require('mongoose');
const { before, after, test } = require('node:test');

const Edge = require('../src/models/Edge');
const DispatchLog = require('../src/models/DispatchLog');
const EdgeMetric = require('../src/models/EdgeMetric');
const { checkEdge } = require('../src/services/healthCheck');
const { transitionStatus, runRound: runPassiveRound, resetStreak } = require('../src/services/passiveHealth');

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
  process.env.MASTER_ALLOW_PRIVATE_EDGE_URL = 'true';
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
  delete process.env.MASTER_ALLOW_PRIVATE_EDGE_URL;
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

test('被动恢复绑定 health revision，不压过并发主动失败信号', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  await Promise.all([Edge.deleteMany({}), DispatchLog.deleteMany({}), EdgeMetric.deleteMany({})]);
  resetStreak('t-edge');
  const minute = new Date(Math.floor(Date.now() / 60000) * 60000 - 60000);
  await Edge.create({
    edge_id: 't-edge',
    base_url: `http://127.0.0.1:${port}`,
    token_secret: 'x',
    status: 'degraded',
    health: { revision: 0, consecutive_successes: 0, consecutive_failures: 2 },
  });
  await DispatchLog.create({ minute, edge_id: 't-edge', file_id: 'pkg', count: 10 });
  await EdgeMetric.create({
    minute,
    edge_id: 't-edge',
    file_id: 'f1',
    requests: 10,
    s2xx: 10,
    downloads_started: 10,
    downloads_completed: 10,
  });

  const originalUpdateOne = Edge.updateOne.bind(Edge);
  let injected = false;
  Edge.updateOne = async (filter, update, options) => {
    if (!injected && filter && filter.status === 'degraded') {
      injected = true;
      // 被动引擎读取 degraded 后、提交恢复迁移前，主动探活记录了第 3 次失败。
      await originalUpdateOne(
        { edge_id: 't-edge' },
        { $set: { 'health.consecutive_successes': 0 }, $inc: { 'health.consecutive_failures': 1, 'health.revision': 1 } },
      );
    }
    return originalUpdateOne(filter, update, options);
  };
  try {
    await runPassiveRound(
      {
        ratioWindows: { '5m': { sec: 300, minDispatch: 1 } },
        primaryWindow: '5m',
        degradedBelow: 0.9,
        unhealthyBelow: 0.7,
        recoveryPasses: 1,
      },
      noop,
    );
  } finally {
    Edge.updateOne = originalUpdateOne;
  }

  const final = await Edge.findOne({ edge_id: 't-edge' }).lean();
  assert.equal(injected, true);
  assert.equal(final.health.revision, 1);
  assert.equal(final.health.consecutive_failures, 3);
  assert.equal(final.status, 'degraded', '过期的被动恢复不得把节点写成 healthy');
});

test('被动引擎读到已达主动失败阈值的快照时让路，不抢先恢复 healthy', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  await Promise.all([Edge.deleteMany({}), DispatchLog.deleteMany({}), EdgeMetric.deleteMany({})]);
  resetStreak('t-edge');
  const minute = new Date(Math.floor(Date.now() / 60000) * 60000 - 60000);
  await Edge.create({
    edge_id: 't-edge',
    base_url: `http://127.0.0.1:${port}`,
    token_secret: 'x',
    status: 'degraded',
    // 模拟主动探活已原子增加第 3 次失败，但其 CAS 状态迁移尚未执行。
    health: { revision: 1, consecutive_successes: 0, consecutive_failures: 3 },
  });
  await DispatchLog.create({ minute, edge_id: 't-edge', file_id: 'pkg', count: 10 });
  await EdgeMetric.create({
    minute,
    edge_id: 't-edge',
    file_id: 'f1',
    requests: 10,
    s2xx: 10,
    downloads_started: 10,
    downloads_completed: 10,
  });

  await runPassiveRound(
    {
      ratioWindows: { '5m': { sec: 300, minDispatch: 1 } },
      primaryWindow: '5m',
      degradedBelow: 0.9,
      unhealthyBelow: 0.7,
      recoveryPasses: 1,
      unhealthyAfterFailures: 3,
      offlineAfterFailures: 10,
      recoverySuccesses: 3,
    },
    noop,
  );
  const final = await Edge.findOne({ edge_id: 't-edge' }).lean();
  assert.equal(final.status, 'degraded', '主动摘除条件已满足时，被动引擎必须等待主动迁移');
});

test('X-Accel Edge 不具备完成可观测性时跳过被动完成率摘除', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  await Promise.all([Edge.deleteMany({}), DispatchLog.deleteMany({}), EdgeMetric.deleteMany({})]);
  const minute = new Date(Math.floor(Date.now() / 60000) * 60000 - 60000);
  await Edge.create({
    edge_id: 't-edge',
    base_url: `http://127.0.0.1:${port}`,
    token_secret: 'x',
    status: 'healthy',
    health: { payload: { delivery_completion_observable: false } },
  });
  await DispatchLog.create({ minute, edge_id: 't-edge', file_id: 'pkg', count: 100 });
  await EdgeMetric.create({
    minute,
    edge_id: 't-edge',
    file_id: 'f1',
    requests: 100,
    s2xx: 100,
    downloads_started: 100,
    downloads_completed: 0,
  });

  await runPassiveRound(
    {
      ratioWindows: { '5m': { sec: 300, minDispatch: 1 } },
      primaryWindow: '5m',
      degradedBelow: 0.9,
      unhealthyBelow: 0.7,
      recoveryPasses: 1,
      unhealthyAfterFailures: 3,
      offlineAfterFailures: 10,
      recoverySuccesses: 3,
    },
    noop,
  );
  const final = await Edge.findOne({ edge_id: 't-edge' }).lean();
  assert.equal(final.status, 'healthy');
  assert.equal(final.health.last_ratios['5m'], null);
});
