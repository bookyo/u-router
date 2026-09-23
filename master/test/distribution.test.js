'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const mongoose = require('mongoose');
const { before, after, test } = require('node:test');

const Edge = require('../src/models/Edge');
const File = require('../src/models/File');
const Distribution = require('../src/models/Distribution');
const { createDistribution, runRound } = require('../src/services/distributor');
const { initDatabase } = require('../../edge/src/db');
const { MinuteStats } = require('../../edge/src/stats');
const buildEdgeApp = require('../../edge/src/app');

let connected = false;

before(async () => {
  process.env.MASTER_ALLOW_PRIVATE_EDGE_URL = 'true';
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017/urouter_test_dist', {
      serverSelectionTimeoutMS: 2000,
    });
    connected = true;
  } catch {
    connected = false;
  }
});

after(async () => {
  if (connected) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  delete process.env.MASTER_ALLOW_PRIVATE_EDGE_URL;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 30000, every = 120) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await sleep(every);
  }
}

async function makeEdge(edgeId, secret) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `dist-${edgeId}-`));
  const storageDir = path.join(tmp, 'files');
  fs.mkdirSync(storageDir, { recursive: true });
  const db = initDatabase(':memory:');
  const stats = new MinuteStats(db);
  const config = {
    edgeId,
    publicBaseUrl: 'http://127.0.0.1',
    storageDir,
    tokenTtlSec: 3600,
    apiKey: '',
    maxUploadBytes: 100 * 1024 * 1024,
    enableXAccel: false,
    xAccelPrefix: '/internal',
    allowPrivatePull: true,
    version: 'test',
  };
  const app = buildEdgeApp({ config, db, stats, secret });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { server, port: server.address().port, config, storageDir };
}

async function uploadTo(ctx, buf, name) {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/files?filename=${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: buf,
  });
  assert.equal(res.status, 201);
  return res.json();
}

test('总控编排：源 Edge 文件铺到目标 Edge，sha256 校验并自动登记映射', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  const src = await makeEdge('edge-src', 'secret-src');
  const dst = await makeEdge('edge-dst', 'secret-dst');
  try {
    await Promise.all([Edge.deleteMany({}), File.deleteMany({}), Distribution.deleteMany({})]);
    await Edge.create([
      { edge_id: 'edge-src', base_url: `http://127.0.0.1:${src.port}`, token_secret: 'secret-src' },
      { edge_id: 'edge-dst', base_url: `http://127.0.0.1:${dst.port}`, token_secret: 'secret-dst' },
    ]);

    const buf = crypto.randomBytes(2 * 1024 * 1024);
    const up = await uploadTo(src, buf, 'app.pkg');
    await File.create({
      download_id: 'dist-it',
      filename: 'app.pkg',
      size: buf.length,
      sha256: '',
      edges: [{ edge_id: 'edge-src', edge_file_id: up.file_id, weight: 100 }],
    });

    const cfg = { distributionMaxAttempts: 3, distributionTokenTtlSec: 3600 };
    const task = await createDistribution({ downloadId: 'dist-it', targets: ['edge-dst'] }, cfg);
    assert.equal(task.targets[0].status, 'pending');

    await waitFor(async () => {
      await runRound(cfg);
      const t2 = await Distribution.findOne({ task_id: task.task_id }).lean();
      return t2.status === 'completed' ? t2 : null;
    });

    // File 自动追加目标映射
    const file = await File.findOne({ download_id: 'dist-it' }).lean();
    assert.equal(file.edges.length, 2);
    const dstMap = file.edges.find((e) => e.edge_id === 'edge-dst');
    assert.ok(dstMap && dstMap.edge_file_id);

    // 目标 Edge 上真的有这个文件，且哈希与源一致
    const files = await (await fetch(`http://127.0.0.1:${dst.port}/api/files`)).json();
    const hit = files.find((f) => f.file_id === dstMap.edge_file_id);
    assert.ok(hit, '目标 Edge 应持有文件');
    assert.equal(hit.sha256, up.sha256);

    // 重复分发同一目标 → skipped，不再拉取
    const task2 = await createDistribution({ downloadId: 'dist-it', targets: ['edge-dst'] }, cfg);
    assert.equal(task2.targets[0].status, 'skipped');
    await runRound(cfg);
    const t2 = await Distribution.findOne({ task_id: task2.task_id }).lean();
    assert.equal(t2.status, 'completed');
  } finally {
    src.server.close();
    dst.server.close();
  }
});

test('目标不可达 → 重试耗尽后 failed 并记录错误', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  const src = await makeEdge('edge-src', 'secret-src');
  // 找一个肯定没有服务监听的端口
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const deadPort = probe.address().port;
  probe.close();
  try {
    await Promise.all([Edge.deleteMany({}), File.deleteMany({}), Distribution.deleteMany({})]);
    await Edge.create([
      { edge_id: 'edge-src', base_url: `http://127.0.0.1:${src.port}`, token_secret: 'secret-src' },
      { edge_id: 'edge-dead', base_url: `http://127.0.0.1:${deadPort}`, token_secret: 'x' },
    ]);
    const buf = crypto.randomBytes(64 * 1024);
    const up = await uploadTo(src, buf, 'dead.pkg');
    await File.create({
      download_id: 'dist-dead',
      filename: 'dead.pkg',
      edges: [{ edge_id: 'edge-src', edge_file_id: up.file_id, weight: 100 }],
    });

    const cfg = { distributionMaxAttempts: 2, distributionTokenTtlSec: 3600 };
    const task = await createDistribution({ downloadId: 'dist-dead', targets: ['edge-dead'] }, cfg);
    const finished = await waitFor(async () => {
      await runRound(cfg);
      const t2 = await Distribution.findOne({ task_id: task.task_id }).lean();
      return t2.status !== 'running' ? t2 : null;
    }, 30000, 100);

    assert.equal(finished.status, 'failed');
    assert.equal(finished.targets[0].attempts, 2);
    assert.ok(finished.targets[0].error);
    // 源映射不受影响
    const file = await File.findOne({ download_id: 'dist-dead' }).lean();
    assert.equal(file.edges.length, 1);
  } finally {
    src.server.close();
  }
});

test('拉取状态查询临时失败不会重建任务；stale 超时且重试耗尽才判失败', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  const src = await makeEdge('edge-src', 'secret-src');
  const stub = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/pulls') {
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pull_id: 'stub-pull-1' }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/pulls/')) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const stubPort = stub.address().port;
  try {
    await Promise.all([Edge.deleteMany({}), File.deleteMany({}), Distribution.deleteMany({})]);
    await Edge.create([
      { edge_id: 'edge-src', base_url: `http://127.0.0.1:${src.port}`, token_secret: 'secret-src' },
      { edge_id: 'edge-stub', base_url: `http://127.0.0.1:${stubPort}`, token_secret: 'x' },
    ]);
    const buf = crypto.randomBytes(64 * 1024);
    const up = await uploadTo(src, buf, 'stub.pkg');
    await File.create({
      download_id: 'dist-stub',
      filename: 'stub.pkg',
      edges: [{ edge_id: 'edge-src', edge_file_id: up.file_id, weight: 100 }],
    });

    const cfg = { distributionMaxAttempts: 3, distributionTokenTtlSec: 3600, distributionStaleSec: 3600 };
    const task = await createDistribution({ downloadId: 'dist-stub', targets: ['edge-stub'] }, cfg);

    await runRound(cfg); // 派发成功 → pulling
    let doc = await Distribution.findOne({ task_id: task.task_id }).lean();
    assert.equal(doc.targets[0].status, 'pulling');
    assert.equal(doc.targets[0].attempts, 1);
    assert.equal(doc.targets[0].pull_id, 'stub-pull-1');

    // 查询 500：应保持 pulling 且不增加派发次数（避免与仍在运行的任务重复下载）
    await runRound(cfg);
    doc = await Distribution.findOne({ task_id: task.task_id }).lean();
    assert.equal(doc.targets[0].status, 'pulling');
    assert.equal(doc.targets[0].attempts, 1, '临时查询失败不应触发重新派发');
    assert.equal(doc.targets[0].pull_id, 'stub-pull-1');

    // stale 超时 + 重试耗尽 → failed
    await Distribution.updateOne(
      { task_id: task.task_id, 'targets.edge_id': 'edge-stub' },
      {
        $set: {
          'targets.$.updated_at': new Date(Date.now() - 2 * 3600 * 1000),
          'targets.$.attempts': 3,
        },
      },
    );
    await runRound(cfg);
    doc = await Distribution.findOne({ task_id: task.task_id }).lean();
    assert.equal(doc.targets[0].status, 'failed');
    assert.equal(doc.status, 'failed');
  } finally {
    stub.close();
    src.server.close();
  }
});

// 可配置行为的桩 Edge：记录 POST 的请求体，GET 返回 behavior() 的结果
function makeStubEdge(behavior) {
  const posted = [];
  let counter = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/pulls') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        counter += 1;
        posted.push(JSON.parse(body));
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ pull_id: `stub-pull-${counter}` }));
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/api/pulls/')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(behavior()));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, posted };
}

test('创建 PULL 的响应丢失后复用同一 dedup_key，不重复创建逻辑任务', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  const src = await makeEdge('edge-src', 'secret-src');
  const posted = [];
  let posts = 0;
  const stub = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/pulls') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      posts += 1;
      posted.push(JSON.parse(body));
      if (posts === 1) {
        // Edge 已读完并接受请求，但返回 pull_id 前连接丢失。
        req.socket.destroy();
        return;
      }
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ pull_id: 'same-logical-pull' }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  try {
    await Promise.all([Edge.deleteMany({}), File.deleteMany({}), Distribution.deleteMany({})]);
    await Edge.create([
      { edge_id: 'edge-src', base_url: `http://127.0.0.1:${src.port}`, token_secret: 'secret-src' },
      { edge_id: 'edge-stub', base_url: `http://127.0.0.1:${stub.address().port}`, token_secret: 'x' },
    ]);
    const up = await uploadTo(src, crypto.randomBytes(1024), 'dedup.pkg');
    await File.create({
      download_id: 'dist-dedup',
      filename: 'dedup.pkg',
      size: 1024,
      sha256: up.sha256,
      edges: [{ edge_id: 'edge-src', edge_file_id: up.file_id, weight: 100 }],
    });
    const cfg = { distributionMaxAttempts: 3, distributionTokenTtlSec: 3600, distributionStaleSec: 3600 };
    const task = await createDistribution({ downloadId: 'dist-dedup', targets: ['edge-stub'] }, cfg);

    await runRound(cfg); // POST 已到 Edge，但响应丢失
    let doc = await Distribution.findOne({ task_id: task.task_id }).lean();
    assert.equal(doc.targets[0].status, 'pending');
    assert.ok(doc.targets[0].dedup_key, '不确定响应后必须持久化本轮幂等键');

    await runRound(cfg); // 重试同一逻辑请求
    doc = await Distribution.findOne({ task_id: task.task_id }).lean();
    assert.equal(posted.length, 2);
    assert.equal(posted[1].dedup_key, posted[0].dedup_key, '网络重试不得更换 dedup_key');
    assert.equal(doc.targets[0].status, 'pulling');
    assert.equal(doc.targets[0].pull_id, 'same-logical-pull');
  } finally {
    stub.close();
    src.server.close();
  }
});

test('stale 判定前先查远端：远端已完成则直接完成，不重派（回归）', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  const src = await makeEdge('edge-src', 'secret-src');
  const stub = makeStubEdge(() => ({ status: 'done', file_id: 'f_from_stub', bytes_downloaded: 123 }));
  await new Promise((r) => stub.server.listen(0, '127.0.0.1', r));
  const stubPort = stub.server.address().port;
  try {
    await Promise.all([Edge.deleteMany({}), File.deleteMany({}), Distribution.deleteMany({})]);
    await Edge.create([
      { edge_id: 'edge-src', base_url: `http://127.0.0.1:${src.port}`, token_secret: 'secret-src' },
      { edge_id: 'edge-stub', base_url: `http://127.0.0.1:${stubPort}`, token_secret: 'x' },
    ]);
    const buf = crypto.randomBytes(16 * 1024);
    const up = await uploadTo(src, buf, 'done.pkg');
    await File.create({
      download_id: 'dist-done',
      filename: 'done.pkg',
      edges: [{ edge_id: 'edge-src', edge_file_id: up.file_id, weight: 100 }],
    });

    const cfg = { distributionMaxAttempts: 3, distributionTokenTtlSec: 3600, distributionStaleSec: 3600 };
    const task = await createDistribution({ downloadId: 'dist-done', targets: ['edge-stub'] }, cfg);
    await runRound(cfg); // 派发 → pulling
    // 派发请求必须带稳定幂等键
    assert.ok(stub.posted[0].dedup_key, '派发请求应包含 dedup_key');
    assert.equal(stub.posted[0].dedup_key, `${task.task_id}:edge-stub:1`);

    // 人为把 updated_at 拨回 2 小时前（旧实现此时会先判 stale 重派）
    await Distribution.updateOne(
      { task_id: task.task_id, 'targets.edge_id': 'edge-stub' },
      { $set: { 'targets.$.updated_at': new Date(Date.now() - 2 * 3600 * 1000) } },
    );
    await runRound(cfg); // 应先查远端 → done → 不重派
    const doc = await Distribution.findOne({ task_id: task.task_id }).lean();
    assert.equal(doc.targets[0].status, 'done');
    assert.equal(doc.targets[0].attempts, 1, '远端已完成时不得重派');
    assert.equal(doc.targets[0].edge_file_id, 'f_from_stub');
    assert.equal(doc.status, 'completed');
    const file = await File.findOne({ download_id: 'dist-done' }).lean();
    assert.ok(file.edges.some((e) => e.edge_id === 'edge-stub' && e.edge_file_id === 'f_from_stub'));
  } finally {
    stub.server.close();
    src.server.close();
  }
});

test('远端持续 queued 不刷新 updated_at，超过 stale 窗口后重派（回归）', async (t) => {
  if (!connected) return t.skip('MongoDB 不可用');
  const src = await makeEdge('edge-src', 'secret-src');
  const stub = makeStubEdge(() => ({ status: 'queued', bytes_downloaded: 0 }));
  await new Promise((r) => stub.server.listen(0, '127.0.0.1', r));
  const stubPort = stub.server.address().port;
  try {
    await Promise.all([Edge.deleteMany({}), File.deleteMany({}), Distribution.deleteMany({})]);
    await Edge.create([
      { edge_id: 'edge-src', base_url: `http://127.0.0.1:${src.port}`, token_secret: 'secret-src' },
      { edge_id: 'edge-stub', base_url: `http://127.0.0.1:${stubPort}`, token_secret: 'x' },
    ]);
    const buf = crypto.randomBytes(16 * 1024);
    const up = await uploadTo(src, buf, 'q.pkg');
    await File.create({
      download_id: 'dist-q',
      filename: 'q.pkg',
      edges: [{ edge_id: 'edge-src', edge_file_id: up.file_id, weight: 100 }],
    });

    const cfg = { distributionMaxAttempts: 3, distributionTokenTtlSec: 3600, distributionStaleSec: 3600 };
    const task = await createDistribution({ downloadId: 'dist-q', targets: ['edge-stub'] }, cfg);
    await runRound(cfg); // 派发 → pulling
    await Distribution.updateOne(
      { task_id: task.task_id, 'targets.edge_id': 'edge-stub' },
      { $set: { 'targets.$.updated_at': new Date(Date.now() - 2 * 3600 * 1000) } },
    );
    // 旧实现对 queued 状态每轮刷新 updated_at → 永远不 stale → 保持 pulling
    await runRound(cfg);
    let doc = await Distribution.findOne({ task_id: task.task_id }).lean();
    assert.equal(doc.targets[0].status, 'pending', 'queued 无进展超时后应重派');
    assert.equal(doc.targets[0].attempts, 1, '本轮只置回 pending，重派在下一轮才计入 attempts');
    assert.equal(doc.targets[0].pull_id, '');

    await runRound(cfg);
    doc = await Distribution.findOne({ task_id: task.task_id }).lean();
    assert.equal(stub.posted.length, 2);
    assert.equal(
      stub.posted[1].dedup_key,
      stub.posted[0].dedup_key,
      'stale 后先用原幂等键向 Edge 对账，不能直接创建新任务',
    );
  } finally {
    stub.server.close();
    src.server.close();
  }
});
