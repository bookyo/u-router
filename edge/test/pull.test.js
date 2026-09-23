'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { test } = require('node:test');

const { initDatabase } = require('../src/db');
const { MinuteStats } = require('../src/stats');
const { PullManager } = require('../src/pulls');
const buildApp = require('../src/app');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 30000, every = 150) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await sleep(every);
  }
}

async function makeEdge() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-pull-'));
  const storageDir = path.join(tmp, 'files');
  fs.mkdirSync(storageDir, { recursive: true });
  const db = initDatabase(':memory:');
  const stats = new MinuteStats(db);
  const config = {
    edgeId: 'e',
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
  const app = buildApp({ config, db, stats, secret: 'pull-secret' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  config.publicBaseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, port: server.address().port, config, db, storageDir };
}

async function uploadJson(ctx, buf, name) {
  const res = await fetch(`http://127.0.0.1:${ctx.port}/api/files?filename=${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: buf,
  });
  assert.equal(res.status, 201);
  return res.json();
}

test('Edge 互拉：源签名 URL → 后台拉取 → sha256 校验 → 注册文件', async () => {
  const src = await makeEdge();
  const dst = await makeEdge();
  try {
    const buf = crypto.randomBytes(3 * 1024 * 1024);
    const up = await uploadJson(src, buf, 'big.iso');
    const sha = crypto.createHash('sha256').update(buf).digest('hex');

    const res = await fetch(`http://127.0.0.1:${dst.port}/api/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source_url: up.download_url,
        filename: 'big.iso',
        expected_sha256: sha,
        expected_size: buf.length,
      }),
    });
    assert.equal(res.status, 202);
    const { pull_id } = await res.json();

    const done = await waitFor(async () => {
      const p = await (await fetch(`http://127.0.0.1:${dst.port}/api/pulls/${pull_id}`)).json();
      return p.status === 'done' ? p : null;
    });
    assert.ok(done.file_id.startsWith('f_'));
    assert.equal(done.bytes_downloaded, buf.length);
    assert.equal(done.error, null);

    // 目标 Edge 注册了文件，且哈希与源一致
    const files = await (await fetch(`http://127.0.0.1:${dst.port}/api/files`)).json();
    const hit = files.find((f) => f.file_id === done.file_id);
    assert.ok(hit, '拉取完成后应注册到 files 表');
    assert.equal(hit.sha256, sha);
    assert.equal(hit.size, buf.length);

    // 落盘内容逐字节一致
    const stored = fs.readFileSync(path.join(dst.storageDir, `${done.file_id}.bin`));
    assert.deepEqual(stored, buf);
  } finally {
    src.server.close();
    dst.server.close();
  }
});

test('sha256 不匹配 → failed，不注册文件不留残留', async () => {
  const src = await makeEdge();
  const dst = await makeEdge();
  try {
    const buf = crypto.randomBytes(256 * 1024);
    const up = await uploadJson(src, buf, 'bad.iso');
    const res = await fetch(`http://127.0.0.1:${dst.port}/api/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source_url: up.download_url,
        filename: 'bad.iso',
        expected_sha256: '0'.repeat(64),
      }),
    });
    const { pull_id } = await res.json();
    const failed = await waitFor(async () => {
      const p = await (await fetch(`http://127.0.0.1:${dst.port}/api/pulls/${pull_id}`)).json();
      return p.status === 'failed' ? p : null;
    });
    assert.ok(/sha256/.test(failed.error || ''), `error 应说明哈希不符: ${failed.error}`);

    const files = await (await fetch(`http://127.0.0.1:${dst.port}/api/files`)).json();
    assert.equal(files.length, 0, '校验失败不应注册文件');
    await sleep(100);
    assert.equal(fs.readdirSync(dst.storageDir).length, 0, '校验失败不应残留文件');
  } finally {
    src.server.close();
    dst.server.close();
  }
});

test('源拒绝（坏 token 403）→ failed 且报出 HTTP 状态', async () => {
  const dst = await makeEdge();
  try {
    const res = await fetch(`http://127.0.0.1:${dst.port}/api/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_url: `${dst.config.publicBaseUrl}/d/aaaa.bbbb`, filename: 'x.bin' }),
    });
    const { pull_id } = await res.json();
    const failed = await waitFor(async () => {
      const p = await (await fetch(`http://127.0.0.1:${dst.port}/api/pulls/${pull_id}`)).json();
      return p.status === 'failed' ? p : null;
    });
    assert.ok(/403/.test(failed.error || ''), `error 应含 HTTP 403: ${failed.error}`);
    assert.equal(fs.readdirSync(dst.storageDir).length, 0);
  } finally {
    dst.server.close();
  }
});

test('非法拉取请求直接 400', async () => {
  const dst = await makeEdge();
  try {
    const res = await fetch(`http://127.0.0.1:${dst.port}/api/pulls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source_url: 'ftp://x', filename: 'x.bin' }),
    });
    assert.equal(res.status, 400);
  } finally {
    dst.server.close();
  }
});

test('SSRF 防护：默认拒绝私网/回环源，显式允许后放行', async () => {
  const db = initDatabase(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssrf-'));
  const guarded = new PullManager({ db, storageDir: dir, allowPrivate: false, pullTimeoutMs: 500 });
  await assert.rejects(
    () => guarded.createPull({ source_url: 'http://127.0.0.1:9/d/x.y', filename: 'a.bin' }),
    /内网|回环/,
  );
  await assert.rejects(
    () => guarded.createPull({ source_url: 'http://localhost:9/d/x.y', filename: 'a.bin' }),
    /内网|回环/,
  );
  await assert.rejects(
    () => guarded.createPull({ source_url: 'http://192.168.1.1/d/x.y', filename: 'a.bin' }),
    /内网|回环/,
  );
  await assert.rejects(
    () => guarded.createPull({ source_url: 'http://[::1]:9/d/x.y', filename: 'a.bin' }),
    /内网|回环/,
  );

  const open = new PullManager({ db, storageDir: dir, allowPrivate: true, pullTimeoutMs: 500 });
  const id = await open.createPull({ source_url: 'http://127.0.0.1:9/d/x.y', filename: 'a.bin' });
  assert.ok(id.startsWith('p_'));
});

test('SSRF 防护：IPv4-mapped IPv6 不能绕过（回归）', async () => {
  const db = initDatabase(':memory:');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssrf6-'));
  const guarded = new PullManager({ db, storageDir: dir, allowPrivate: false, pullTimeoutMs: 500 });
  // 旧实现对 ::ffff: 形式放行，fetch 实际会连到 127.0.0.1 / 192.168.1.1
  await assert.rejects(
    () => guarded.createPull({ source_url: 'http://[::ffff:127.0.0.1]:9/secret', filename: 'a.bin' }),
    /内网|回环/,
  );
  await assert.rejects(
    () => guarded.createPull({ source_url: 'http://[::ffff:192.168.1.1]/secret', filename: 'a.bin' }),
    /内网|回环/,
  );
  await assert.rejects(
    () => guarded.createPull({ source_url: 'http://[::ffff:a00:1]/secret', filename: 'a.bin' }), // 10.0.0.1 十六进制
    /内网|回环/,
  );
  // fe80::/10 全段都是链路本地，不只 fe80::/16；fe90/febf 都必须拒绝。
  await assert.rejects(
    () => guarded.createPull({ source_url: 'http://[fe90::1]/secret', filename: 'a.bin' }),
    /内网|回环/,
  );
  await assert.rejects(
    () => guarded.createPull({ source_url: 'http://[febf::1]/secret', filename: 'a.bin' }),
    /内网|回环/,
  );
  await assert.rejects(
    () => guarded.createPull({ source_url: 'http://[fec0::1]/secret', filename: 'a.bin' }),
    /内网|回环/,
  );
  await assert.rejects(
    () => guarded.createPull({ source_url: 'http://[::127.0.0.1]/secret', filename: 'a.bin' }),
    /内网|回环/,
  );
  for (const ip of [
    '64:ff9b:1::1',
    '100::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
    '2002:7f00:1::1',
    '3fff::1',
  ]) {
    await assert.rejects(
      () => guarded.createPull({ source_url: `http://[${ip}]/secret`, filename: 'a.bin' }),
      /内网|回环/,
      `${ip} 必须视为非公网地址`,
    );
  }
});

test('幂等键：同一请求无论活跃或终态都返回同一 pull_id', async () => {
  const hold = http.createServer(() => {
    /* 占住槽位 */
  });
  await new Promise((r) => hold.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-'));
  const mgr = new PullManager({
    db: initDatabase(':memory:'),
    storageDir: dir,
    allowPrivate: true,
    maxConcurrent: 1,
    pullTimeoutMs: 400,
  });
  try {
    const a = await mgr.createPull({
      source_url: `http://127.0.0.1:${hold.address().port}/d/x`,
      filename: 'a.bin',
      dedup_key: 't1:e1:1',
    });
    await waitFor(() => (mgr.get(a).status === 'pulling' ? true : null));
    // 同一逻辑派发的重复 POST（如响应丢失后重试）必须命中已有任务
    const b = await mgr.createPull({
      // Master 会为同一逻辑派发重新签名，URL token/exp 可变化；Edge 不能因此
      // 拒绝同一个 dedup_key，因为命中时不会使用新 URL 覆盖旧任务。
      source_url: `http://127.0.0.1:${hold.address().port}/d/new-signed-token`,
      filename: 'a.bin',
      dedup_key: 't1:e1:1',
    });
    assert.equal(b, a);
    // 响应丢失后 Master 可能到下轮才重试，此时任务已经终态；仍必须命中原任务。
    await waitFor(() => (mgr.get(a).status === 'failed' ? true : null));
    const c = await mgr.createPull({
      source_url: `http://127.0.0.1:${hold.address().port}/d/newer-signed-token`,
      filename: 'a.bin',
      dedup_key: 't1:e1:1',
    });
    assert.equal(c, a);
    const dedupIndex = mgr.db
      .prepare("PRAGMA index_list('pulls')")
      .all()
      .find((x) => x.name === 'idx_pulls_dedup_key');
    assert.ok(dedupIndex && dedupIndex.unique === 1, 'dedup_key 必须由数据库唯一约束兜底');

    await assert.rejects(
      () =>
        mgr.createPull({
          source_url: `http://127.0.0.1:${hold.address().port}/d/other`,
          filename: 'other.bin',
          dedup_key: 't1:e1:1',
        }),
      /幂等键.*参数|dedup/i,
      '同键不同请求不能静默返回无关任务',
    );
  } finally {
    hold.close();
  }
});

test('丢弃坏分片后必须等 unlink 完成再开始下一次尝试', async () => {
  const body = Buffer.alloc(256 * 1024, 7);
  let cleanupPending = false;
  let racedRequests = 0;
  const source = http.createServer((req, res) => {
    if (cleanupPending) racedRequests += 1;
    res.writeHead(200, { 'content-length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => source.listen(0, '127.0.0.1', resolve));
  const originalUnlink = fs.unlink;
  fs.unlink = (target, callback) => {
    cleanupPending = true;
    setTimeout(() => {
      originalUnlink(target, (error) => {
        cleanupPending = false;
        callback(error);
      });
    }, 80);
  };
  const mgr = new PullManager({
    db: initDatabase(':memory:'),
    storageDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pull-cleanup-race-')),
    allowPrivate: true,
    maxAttempts: 2,
    pullTimeoutMs: 2000,
    log: () => {},
  });
  try {
    const id = await mgr.createPull({
      source_url: `http://127.0.0.1:${source.address().port}/bad.bin`,
      filename: 'bad.bin',
      expected_sha256: '0'.repeat(64),
    });
    await waitFor(() => (mgr.get(id).status === 'failed' ? true : null));
    assert.equal(racedRequests, 0, '下一次请求不能早于上一次坏分片清理完成');
  } finally {
    await waitFor(() => (!cleanupPending ? true : null));
    fs.unlink = originalUnlink;
    source.close();
  }
});

test('拉取超过 pullMaxBytes 被拒且无残留', async () => {
  const src = await makeEdge();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxb-'));
  const mgr = new PullManager({
    db: initDatabase(':memory:'),
    storageDir: dir,
    allowPrivate: true,
    pullTimeoutMs: 5000,
    pullMaxBytes: 1024,
  });
  try {
    const up = await uploadJson(src, Buffer.alloc(64 * 1024, 1), 'big2.bin');
    const id = await mgr.createPull({ source_url: up.download_url, filename: 'big2.bin' });
    const failed = await waitFor(() => {
      const r = mgr.get(id);
      return r && r.status === 'failed' ? r : null;
    });
    assert.match(failed.error, /大小|上限/);
    await sleep(100);
    assert.equal(fs.readdirSync(dir).length, 0);
  } finally {
    src.server.close();
  }
});

test('并发限制：超出 maxConcurrent 的任务先排队', async () => {
  const hold = http.createServer(() => {
    /* 故意不响应，占住拉取槽位 */
  });
  await new Promise((r) => hold.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-'));
  const mgr = new PullManager({
    db: initDatabase(':memory:'),
    storageDir: dir,
    allowPrivate: true,
    maxConcurrent: 1,
    pullTimeoutMs: 400,
  });
  try {
    const p1 = await mgr.createPull({
      source_url: `http://127.0.0.1:${hold.address().port}/d/x`,
      filename: 'h1.bin',
    });
    await waitFor(() => (mgr.get(p1).status === 'pulling' ? true : null));
    const p2 = await mgr.createPull({
      source_url: `http://127.0.0.1:${hold.address().port}/d/y`,
      filename: 'h2.bin',
    });
    assert.equal(mgr.get(p2).status, 'queued');
    await waitFor(() => (mgr.get(p2).status === 'failed' ? true : null));
  } finally {
    hold.close();
  }
});

test('启动恢复：耗尽重试的 pulling 行直接判失败，未耗尽的重启拉起', async () => {
  const src = await makeEdge();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recover-'));
  const db = initDatabase(':memory:');
  const mgr = new PullManager({ db, storageDir: dir, allowPrivate: true, maxAttempts: 3 });
  try {
    const buf = crypto.randomBytes(64 * 1024);
    const up = await uploadJson(src, buf, 'rec.bin');
    const now = Date.now();
    const ins = db.prepare(
      `INSERT INTO pulls (pull_id, source_url, filename, expected_sha256, expected_size, status,
        bytes_downloaded, file_id, error, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pulling', 0, ?, NULL, ?, ?, ?)`,
    );
    // 模拟重启前中断：一条未完成（attempts=1），一条已耗尽重试（attempts=3）
    ins.run('p_rec1', up.download_url, 'rec.bin', up.sha256, buf.length, 'f_recoverme', 1, now, now);
    ins.run('p_rec2', 'http://127.0.0.1:9/d/dead', 'dead.bin', null, null, 'f_deadrow', 3, now, now);

    await mgr.recover();
    await waitFor(() => (mgr.get('p_rec1').status === 'done' ? true : null));
    assert.equal(
      db.prepare("SELECT file_id FROM files WHERE file_id = 'f_recoverme'").get().file_id,
      'f_recoverme',
    );
    assert.equal(mgr.get('p_rec2').status, 'failed');
  } finally {
    src.server.close();
  }
});
