'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');

const { initDatabase } = require('../src/db');
const { MinuteStats } = require('../src/stats');
const { sign } = require('../src/token');
const buildApp = require('../src/app');

const SECRET = 'it-secret';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeApp({ maxUploadBytes = 10 * 1024 * 1024, enableXAccel = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-it-'));
  const storageDir = path.join(tmp, 'files');
  fs.mkdirSync(storageDir, { recursive: true });
  const db = initDatabase(':memory:');
  const stats = new MinuteStats(db);
  const config = {
    edgeId: 'edge-it',
    publicBaseUrl: 'http://127.0.0.1',
    storageDir,
    tokenTtlSec: 3600,
    apiKey: '',
    maxUploadBytes,
    enableXAccel,
    xAccelPrefix: '/internal',
    allowPrivatePull: true,
    version: 'test',
  };
  const app = buildApp({ config, db, stats, secret: SECRET });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  config.publicBaseUrl = `http://127.0.0.1:${port}`;
  return { server, port, storageDir, config, db };
}

async function rawUpload(ctx, buf, filename = 'a.bin') {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/files?filename=${filename}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: buf,
  });
  return { status: res.status, body: await res.json() };
}

async function statsFor(ctx, fileId) {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/stats?since=0`);
  const { rows } = await res.json();
  const sum = {
    requests: 0,
    downloads_started: 0,
    downloads_completed: 0,
    bytes_sent: 0,
    s2xx: 0,
    s4xx: 0,
    s5xx: 0,
  };
  for (const r of rows) {
    if (r.file_id !== fileId) continue;
    for (const k of Object.keys(sum)) sum[k] += r[k];
  }
  return sum;
}

test('裸流上传 → 完整下载 → HEAD → 统计精确（HEAD 不计 started）', async () => {
  const ctx = await makeApp();
  try {
    const body = Buffer.alloc(4096, 7);
    const up = await rawUpload(ctx, body, 'a.bin');
    assert.equal(up.status, 201);
    assert.equal(up.body.size, 4096);
    assert.equal(up.body.filename, 'a.bin');

    const dl = await fetch(up.body.download_url);
    assert.equal(dl.status, 200);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), body);

    const head = await fetch(up.body.download_url, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '4096');

    await sleep(80);
    const sum = await statsFor(ctx, up.body.file_id);
    assert.equal(sum.requests, 2);
    assert.equal(sum.s2xx, 2);
    assert.equal(sum.downloads_started, 1); // HEAD 不计入
    assert.equal(sum.downloads_completed, 1);
    assert.equal(sum.bytes_sent, 4096);
  } finally {
    ctx.server.close();
  }
});

test('客户端在下载中途断开：记 started 但不记 completed', async () => {
  const ctx = await makeApp();
  try {
    const size = 32 * 1024 * 1024;
    const storagePath = path.join(ctx.storageDir, 'f_abort.bin');
    fs.writeFileSync(storagePath, Buffer.alloc(size, 9));
    ctx.db
      .prepare(
        "INSERT INTO files (file_id, filename, size, sha256, storage_path, created_at) VALUES ('f_abort', 'abort.bin', ?, NULL, ?, ?)",
      )
      .run(size, storagePath, Date.now());
    const token = sign({ f: 'f_abort', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${ctx.port}/d/${token}`, (res) => {
        res.once('data', () => res.destroy());
        res.once('close', resolve);
      });
      req.once('error', (error) => {
        if (error.code === 'ECONNRESET') resolve();
        else reject(error);
      });
    });
    await sleep(150);
    const sum = await statsFor(ctx, 'f_abort');
    assert.equal(sum.downloads_started, 1);
    assert.equal(sum.downloads_completed, 0);
  } finally {
    ctx.server.close();
  }
});

test('零字节文件返回 Content-Length 0，并计为一次完整交付', async () => {
  const ctx = await makeApp();
  try {
    const storagePath = path.join(ctx.storageDir, 'f_empty.bin');
    fs.writeFileSync(storagePath, Buffer.alloc(0));
    ctx.db
      .prepare(
        "INSERT INTO files (file_id, filename, size, sha256, storage_path, created_at) VALUES ('f_empty', 'empty.bin', 0, NULL, ?, ?)",
      )
      .run(storagePath, Date.now());
    const token = sign({ f: 'f_empty', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const result = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${ctx.port}/d/${token}`, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
        res.on('aborted', () => reject(new Error('零字节响应因长度不符被中止')));
      });
      req.setTimeout(1000, () => req.destroy(new Error('零字节下载超时')));
      req.on('error', reject);
    });
    assert.equal(result.res.statusCode, 200);
    assert.equal(result.res.headers['content-length'], '0');
    assert.equal(result.body.length, 0);
    await sleep(80);
    const sum = await statsFor(ctx, 'f_empty');
    assert.equal(sum.downloads_started, 1);
    assert.equal(sum.downloads_completed, 1);
  } finally {
    ctx.server.close();
  }
});

test('磁盘文件丢失 → 500 且只计失败，不虚增 s2xx/started/completed（回归）', async () => {
  const ctx = await makeApp();
  try {
    ctx.db
      .prepare(
        "INSERT INTO files (file_id, filename, size, sha256, storage_path, created_at) VALUES ('f_ghost', 'ghost.bin', 100, NULL, ?, ?)",
      )
      .run(path.join(ctx.storageDir, 'f_ghost.bin'), Date.now());
    const token = sign({ f: 'f_ghost', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/d/${token}`);
    assert.equal(res.status, 500);
    await sleep(150);
    const sum = await statsFor(ctx, 'f_ghost');
    assert.equal(sum.requests, 1);
    assert.equal(sum.s5xx, 1);
    assert.equal(sum.s2xx, 0); // 旧实现这里是 1：失败请求被计为成功
    assert.equal(sum.downloads_started, 0);
    assert.equal(sum.downloads_completed, 0); // 旧实现 500 的 res.end() 触发 finish 被计为完成
    assert.equal(sum.bytes_sent, 0);
  } finally {
    ctx.server.close();
  }
});

test('磁盘文件丢失时 HEAD 也返回 500，不把探测记成成功交付', async () => {
  const ctx = await makeApp();
  try {
    ctx.db
      .prepare(
        "INSERT INTO files (file_id, filename, size, sha256, storage_path, created_at) VALUES ('f_head_ghost', 'ghost.bin', 100, NULL, ?, ?)",
      )
      .run(path.join(ctx.storageDir, 'f_head_ghost.bin'), Date.now());
    const token = sign({ f: 'f_head_ghost', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/d/${token}`, { method: 'HEAD' });
    assert.equal(res.status, 500);
    await sleep(80);
    const sum = await statsFor(ctx, 'f_head_ghost');
    assert.deepEqual(
      { requests: sum.requests, s2xx: sum.s2xx, s5xx: sum.s5xx, started: sum.downloads_started },
      { requests: 1, s2xx: 0, s5xx: 1, started: 0 },
    );
  } finally {
    ctx.server.close();
  }
});

test('X-Accel 模式先确认磁盘文件可读，缺失文件不下发内部重定向', async () => {
  const ctx = await makeApp({ enableXAccel: true });
  try {
    const health = await (await fetch(`http://127.0.0.1:${ctx.port}/api/health`)).json();
    assert.equal(health.delivery_completion_observable, false);
    ctx.db
      .prepare(
        "INSERT INTO files (file_id, filename, size, sha256, storage_path, created_at) VALUES ('f_xa_ghost', 'ghost.bin', 100, NULL, ?, ?)",
      )
      .run(path.join(ctx.storageDir, 'f_xa_ghost.bin'), Date.now());
    const token = sign({ f: 'f_xa_ghost', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
    const res = await fetch(`http://127.0.0.1:${ctx.port}/d/${token}`);
    assert.equal(res.status, 500);
    assert.equal(res.headers.get('x-accel-redirect'), null);
    await sleep(80);
    const sum = await statsFor(ctx, 'f_xa_ghost');
    assert.deepEqual(
      { requests: sum.requests, s2xx: sum.s2xx, s5xx: sum.s5xx, started: sum.downloads_started },
      { requests: 1, s2xx: 0, s5xx: 1, started: 0 },
    );
  } finally {
    ctx.server.close();
  }
});

test('非法 Range → 416，且 s2xx/started 不被双计数（回归）', async () => {
  const ctx = await makeApp();
  try {
    const up = await rawUpload(ctx, Buffer.alloc(1024, 1), 'b.bin');
    const res = await fetch(up.body.download_url, { headers: { Range: 'bytes=2000-' } });
    assert.equal(res.status, 416);
    await sleep(80);
    const sum = await statsFor(ctx, up.body.file_id);
    assert.equal(sum.requests, 1);
    assert.equal(sum.s4xx, 1);
    assert.equal(sum.s2xx, 0); // 旧实现这里是 1：同一请求同时计入成功与失败
    assert.equal(sum.downloads_started, 0);
  } finally {
    ctx.server.close();
  }
});

test('篡改 token → 403，计入 _invalid 桶', async () => {
  const ctx = await makeApp();
  try {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/d/badtoken`);
    assert.equal(res.status, 403);
    await sleep(80);
    const sum = await statsFor(ctx, '_invalid');
    assert.equal(sum.requests, 1);
    assert.equal(sum.s4xx, 1);
  } finally {
    ctx.server.close();
  }
});

test('multipart 上传正常', async () => {
  const ctx = await makeApp();
  try {
    const fd = new FormData();
    fd.append('file', new Blob([Buffer.alloc(2048, 3)]), 'mp.bin');
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/files`, { method: 'POST', body: fd });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.filename, 'mp.bin');
    assert.equal(body.size, 2048);
  } finally {
    ctx.server.close();
  }
});

test('客户端上传中断 → 不残留半成品文件（回归）', async () => {
  const ctx = await makeApp();
  try {
    await new Promise((resolve) => {
      const req = http.request({
        host: '127.0.0.1',
        port: ctx.port,
        path: '/api/files?filename=aborted.bin',
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(1024 * 1024) },
      });
      req.on('error', () => {});
      req.write(Buffer.alloc(64 * 1024, 1));
      setTimeout(() => req.destroy(), 30);
      setTimeout(resolve, 500);
    });
    await sleep(200);
    assert.equal(fs.readdirSync(ctx.storageDir).length, 0); // 旧实现会留下一个 .bin 半成品
  } finally {
    ctx.server.close();
  }
});

test('超过大小限制 → 413 或连接被拒，且不残留文件', async () => {
  const ctx = await makeApp({ maxUploadBytes: 1024 });
  try {
    let status = 0;
    try {
      const res = await fetch(`http://127.0.0.1:${ctx.port}/api/files?filename=big.bin`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: Buffer.alloc(4096, 9),
      });
      status = res.status;
    } catch {
      /* 服务端提前断开时 fetch 抛错，同样视为拒绝 */
    }
    assert.ok(status === 0 || status === 413);
    await sleep(150);
    assert.equal(fs.readdirSync(ctx.storageDir).length, 0);
  } finally {
    ctx.server.close();
  }
});
