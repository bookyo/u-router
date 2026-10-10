const assert = require('node:assert/strict');
const test = require('node:test');
const { createServer } = require('node:net');
const { spawn } = require('node:child_process');
const { mkdtempSync, rmSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

test('actual startup entry serves the documented example and persists taxonomy/content after restart', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'terms-startup-'));
  const moduleDirectory = resolve(__dirname, '..');
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  let child;
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const running = child;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { running.kill('SIGKILL'); reject(new Error('server failed graceful shutdown')); }, 5000);
      running.once('exit', (code) => {
        clearTimeout(timeout);
        code === 0 ? resolve() : reject(new Error(`server shutdown code ${code}`));
      });
      running.kill('SIGTERM');
    });
  }
  t.after(async () => { try { await stop(); } finally { rmSync(directory, { recursive: true, force: true }); } });
  async function start() {
    child = spawn(process.execPath, ['src/server.js'], {
      cwd: moduleDirectory,
      env: { ...process.env, API_KEY: 'startup-test-key', DATABASE_PATH: join(directory, 'terms.sqlite'), HOST: '127.0.0.1', PORT: String(port), TRUST_PROXY_IPS: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const running = child;
    await new Promise((resolve, reject) => {
      let output = '';
      let errors = '';
      const timeout = setTimeout(() => reject(new Error('server startup timed out')), 5000);
      running.stderr.on('data', (data) => { errors = (errors + data).slice(-4000); });
      running.once('error', (error) => { clearTimeout(timeout); reject(error); });
      running.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${errors}`)); });
      running.stdout.on('data', (data) => {
        output += data;
        if (output.includes(`listening on http://127.0.0.1:${port}`)) { clearTimeout(timeout); resolve(); }
      });
    });
  }
  async function request(path, method = 'GET', payload, authenticated = true, extraHeaders = {}) {
    const result = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer startup-test-key' } : {}), ...extraHeaders },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return { status: result.status, body: await result.json() };
  }

  await start();
  assert.equal((await request('/health', 'GET', undefined, false)).status, 200);
  assert.equal((await request('/v2/terms', 'GET', undefined, false)).status, 200);
  const tag = await request('/v2/tags', 'POST', { slug: 'electro', translations: { en: 'Electro', 'zh-Hans': '雷元素' } });
  assert.equal(tag.status, 201);
  const category = await request('/v2/categories', 'POST', { slug: 'games', translations: { en: 'Games', 'zh-Hans': '游戏' } });
  assert.equal(category.status, 201);
  const root = await request('/v2/terms', 'POST', {
    type: 'work', translations: { en: ['Genshin Impact'], 'zh-Hans': ['原神'] },
  });
  assert.equal(root.status, 201);
  const example = JSON.parse(readFileSync(join(moduleDirectory, 'docs/examples/character.json'), 'utf8'));
  const created = await request('/v2/terms', 'POST', {
    ...example, parentId: root.body.id, tagIds: [tag.body.id], categoryIds: [category.body.id],
  });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.deepEqual(created.body.ancestors.map((value) => value.id), [root.body.id]);
  const rich = await request(`/v2/terms/${id}/content?language=zh-Hans`);
  assert.match(rich.body.html, /<h2>角色介绍<\/h2>/);
  assert.match(rich.body.html, /<table>/);
  const found = await request(`/v2/terms?q=Ei&from=en&to=zh-Hans&tagId=${tag.body.id}&categoryId=${category.body.id}`);
  assert.equal(found.body.total, 1);
  assert.deepEqual(found.body.items[0].translation, ['雷电将军', '雷电影']);
  const legacy = await request('/v1/terms?q=Ei&from=en&to=zh-Hans');
  assert.equal(legacy.body.translation, '雷电将军');
  for (let i = 0; i < 20; i++) {
    assert.equal((await request('/v2/terms', 'GET', undefined, false, { 'x-forwarded-for': '198.51.100.8' })).status, 200);
  }
  assert.equal((await request('/v2/terms', 'GET', undefined, false, { 'x-forwarded-for': '198.51.100.8' })).status, 429);
  assert.equal((await request('/v2/terms', 'GET', undefined, false, { 'x-forwarded-for': '198.51.100.9' })).status, 200);
  assert.equal((await request('/v2/terms')).status, 200);
  await stop();
  await start();
  const persisted = await request(`/v2/terms/${id}`);
  assert.equal(persisted.status, 200);
  assert.deepEqual(persisted.body.details, example.details);
  assert.deepEqual(persisted.body.cover, example.cover);
  assert.deepEqual(persisted.body.sources, example.sources);
  assert.deepEqual(persisted.body.tagIds, [tag.body.id]);
  assert.deepEqual(persisted.body.categoryIds, [category.body.id]);
  assert.equal(persisted.body.parentId, root.body.id);
  assert.equal((await request(`/v2/terms/${root.body.id}/children`)).body.total, 1);
});
