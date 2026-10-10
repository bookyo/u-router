const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const { createApp } = require('../src/app');
const { TermRepository } = require('../src/term-repository');

async function service(t) {
  const directory = mkdtempSync(join(tmpdir(), 'term-import-'));
  const databasePath = join(directory, 'test.sqlite');
  let app, server, base;
  async function start() {
    app = createApp({ apiKey: 'test-key', databasePath });
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() { await new Promise((resolve) => server.close(resolve)); app.close(); }
  await start();
  t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  return {
    databasePath,
    async request(payload, path = '/v2/terms/import', key = 'test-key', method = 'POST') {
      const response = await fetch(base + path, { method,
        headers: { 'content-type': 'application/json', ...(key ? { 'x-api-key': key } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(payload) });
      return { status: response.status, body: await response.json() };
    },
    async total() { return (await this.request(undefined, '/v2/terms', undefined, 'GET')).body.total; },
    async restart() { await stop(); await start(); },
  };
}
function item(externalId = '1', extra = {}) {
  return { source: 'test-games', externalId,
    term: { type: 'work', translations: { en: ['Example'], 'zh-Hans': ['示例'] }, ...extra } };
}
async function imported(s, items, dryRun = false) {
  const response = await s.request({ items, dryRun });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

test('import creates multilingual works with per-item results, retaining same-name identities', async (t) => {
  const s = await service(t);
  const result = await imported(s, [item(), item('2'), { ...item('1'), source: 'other-games' }]);
  assert.deepEqual([result.created, result.updated, result.unchanged], [3, 0, 0]);
  assert.equal(result.dryRun, false);
  assert.deepEqual(result.items.map((x) => x.status), ['created', 'created', 'created']);
  assert.deepEqual(result.items.map((x) => x.index), [0, 1, 2]);
  assert.equal(new Set(result.items.map((x) => x.id)).size, 3);
  assert.equal(await s.total(), 3);
});

test('import requires a valid API key, including dry runs', async (t) => {
  const s = await service(t);
  for (const key of [null, 'wrong']) {
    assert.equal((await s.request({ items: [item()], dryRun: true }, '/v2/terms/import', key)).status, 401);
  }
  assert.equal(await s.total(), 0);
});

test('external identity survives restart and unchanged imports do not mutate timestamps', async (t) => {
  const s = await service(t);
  const first = await imported(s, [item()]);
  const id = first.items[0].id;
  const before = (await s.request(undefined, `/v2/terms/${id}`, undefined, 'GET')).body;
  await s.restart();
  const again = await imported(s, [item()]);
  assert.deepEqual([again.created, again.updated, again.unchanged], [0, 0, 1]);
  assert.equal(again.items[0].id, id);
  assert.deepEqual((await s.request(undefined, `/v2/terms/${id}`, undefined, 'GET')).body, before);
});

test('repeat import preserves preferred-name spelling retained by legacy local edits', async (t) => {
  const s = await service(t);
  const original = item('legacy', { type: 'term' });
  const first = await imported(s, [original]);
  const id = first.items[0].id;
  const local = await s.request({ translations: { en: '  Example  ', 'zh-Hans': '示例' } }, '/v1/terms');
  assert.equal(local.status, 200);
  const before = (await s.request(undefined, `/v2/terms/${id}`, null, 'GET')).body;
  assert.equal(before.translations.en[0], '  Example  ');
  const result = await imported(s, [original]);
  assert.equal(result.unchanged, 1);
  assert.deepEqual((await s.request(undefined, `/v2/terms/${id}`, null, 'GET')).body, before);
});

test('reimport appends normalized aliases and languages without replacing local content or parent', async (t) => {
  const s = await service(t);
  const first = await imported(s, [item('parent'), item('child')]);
  const [parent, child] = first.items.map((x) => x.id);
  await s.request({ parentId: parent, details: { en: { summary: 'Keep me' } },
    cover: { url: 'https://example.com/local.png' }, sources: [{ url: 'https://example.com/local', title: 'Local' }] },
  `/v2/terms/${child}`, 'test-key', 'PATCH');
  const incoming = item('child', { translations: { en: ['EXAMPLE', 'New alias'], 'zh-Hans': ['示例'], ja: ['例'] },
    details: { en: { summary: 'Overwrite?' } }, parentId: null, cover: null, sources: [] });
  const result = await imported(s, [incoming]);
  assert.equal(result.updated, 1);
  const current = (await s.request(undefined, `/v2/terms/${child}`, undefined, 'GET')).body;
  assert.deepEqual(current.translations.en, ['Example', 'New alias']);
  assert.deepEqual(current.translations.ja, ['例']);
  assert.equal(current.parentId, parent);
  assert.equal(current.details.en.summary, 'Keep me');
  assert.equal(current.cover.url, 'https://example.com/local.png');
  assert.equal(current.sources[0].title, 'Local');
  const found = await s.request(undefined, '/v2/terms?q=New%20alias&from=en', undefined, 'GET');
  assert.equal(found.body.items[0].id, child);
});

test('dryRun reports planned creates and updates but persists no terms, names or identities', async (t) => {
  const s = await service(t);
  const first = await imported(s, [item()]);
  const id = first.items[0].id;
  const before = (await s.request(undefined, `/v2/terms/${id}`, undefined, 'GET')).body;
  const update = item('1', { translations: { en: ['Example', 'Preview'], 'zh-Hans': ['示例'] } });
  const db = new DatabaseSync(s.databasePath);
  const sequences = db.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all();
  db.close();
  const preview = await imported(s, [update, item('2')], true);
  assert.equal(preview.dryRun, true);
  assert.deepEqual([preview.created, preview.updated], [1, 1]);
  assert.equal(await s.total(), 1);
  assert.deepEqual((await s.request(undefined, `/v2/terms/${id}`, undefined, 'GET')).body, before);
  const after = new DatabaseSync(s.databasePath);
  try {
    assert.deepEqual(after.prepare('SELECT * FROM sqlite_sequence ORDER BY name').all(), sequences);
    assert.equal(after.prepare('SELECT COUNT(*) AS n FROM term_import_keys').get().n, 1);
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM term_translations WHERE normalized_value='preview'").get().n, 0);
  } finally { after.close(); }
  assert.equal((await imported(s, [item('2')])).created, 1);
});

test('invalid item reports its zero-based index and rolls back the entire batch', async (t) => {
  const s = await service(t);
  const result = await s.request({ items: [item(), item('2', { translations: { en: ['Incomplete'] } })] });
  assert.equal(result.status, 400);
  assert.equal(result.body.index, 1);
  assert.equal(result.body.error, 'validation_error');
  assert.equal(await s.total(), 0);
  assert.equal((await imported(s, [item()])).created, 1);
});

test('unknown references and type conflicts roll back earlier updates and inserts', async (t) => {
  const s = await service(t);
  const first = await imported(s, [item()]);
  const update = item('1', { translations: { en: ['Example', 'Must roll back'], 'zh-Hans': ['示例'] } });
  for (const extra of [{ parentId: 999999 }, { tagIds: [999999] }, { categoryIds: [999999] }, { type: 'missing' }]) {
    const result = await s.request({ items: [update, item('2', extra)] });
    assert.equal(result.status, 400);
    assert.equal(result.body.index, 1);
    assert.equal(await s.total(), 1);
  }
  const conflict = await s.request({ items: [item('new'), item('1', { type: 'character' })] });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.index, 1);
  assert.equal(await s.total(), 1);
  const current = (await s.request(undefined, `/v2/terms/${first.items[0].id}`, undefined, 'GET')).body;
  assert.deepEqual(current.translations.en, ['Example']);
});

test('duplicate identities in one batch are rejected, not silently ordered or merged', async (t) => {
  const s = await service(t);
  const result = await s.request({ items: [item(), item()] });
  assert.equal(result.status, 400);
  assert.equal(result.body.index, 1);
  assert.equal(await s.total(), 0);
});

test('import rejects malformed envelopes, identities, unknown fields and item counts', async (t) => {
  const s = await service(t);
  for (const payload of [null, [], {}, { items: [] }, { items: [item()], dryRun: 'true' },
    { items: [item()], overwrite: true }, { items: Array.from({ length: 101 }, (_, i) => item(String(i))) },
    { items: [{ ...item(), source: '' }] }, { items: [{ ...item(), externalId: '' }] },
    { items: [{ ...item(), externalId: 1 }] }, { items: [{ ...item(), extra: 1 }] }]) {
    const result = await s.request(payload);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'validation_error');
  }
  assert.equal(await s.total(), 0);
});

test('merged language/name limits are validated and batches over 2MB are rejected', async (t) => {
  const s = await service(t);
  await imported(s, [item('1', { translations: { en: Array.from({ length: 50 }, (_, i) => `Name ${i}`), 'zh-Hans': ['示例'] } })]);
  const result = await s.request({ items: [item()] });
  assert.equal(result.status, 400);
  assert.equal(result.body.index, 0);
  const oversized = await s.request({ items: [item()], padding: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(oversized.status, 413);
  assert.equal(await s.total(), 1);
});

test('deleting a term cascades its import key so a later import can create it again', async (t) => {
  const s = await service(t);
  const first = await imported(s, [item()]);
  assert.equal((await s.request(undefined, `/v2/terms/${first.items[0].id}`, 'test-key', 'DELETE')).status, 200);
  assert.equal((await imported(s, [item()])).created, 1);
});

test('storage failure rolls back both imported terms and external keys, without leaking SQL errors', async (t) => {
  const s = await service(t);
  const db = new DatabaseSync(s.databasePath);
  try {
    db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON terms WHEN NEW.english_key='fail'
      BEGIN SELECT RAISE(ABORT, 'private storage detail'); END`);
    const result = await s.request({ items: [item(), item('2', { translations: { en: ['Fail'], 'zh-Hans': ['失败'] } })] });
    assert.equal(result.status, 500);
    assert.equal(result.body.index, 1);
    assert.equal(result.body.error, 'storage_error');
    assert.ok(!JSON.stringify(result.body).includes('private storage detail'));
    assert.equal(await s.total(), 0);
    db.exec('DROP TRIGGER fail_second');
    assert.equal((await imported(s, [item()])).created, 1);
  } finally { db.close(); }
});

test('version 5 upgrade preserves rich content, taxonomy and IDs and adds durable import identity', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'term-import-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'test.sqlite');
  let repo = new TermRepository(path);
  const parent = repo.create(item('parent').term);
  const tag = repo.taxonomy.create('tags', { slug: 'sample-tag', translations: { en: 'Sample', 'zh-Hans': '示例' } });
  const category = repo.taxonomy.create('categories', { slug: 'sample-category', translations: { en: 'Games', 'zh-Hans': '游戏' } });
  const created = repo.create(item().term);
  repo.patch(created.id, { details: { en: { body: '**Retain**', format: 'markdown' } }, parentId: parent.id,
    tagIds: [tag.id], categoryIds: [category.id], cover: { url: 'https://example.com/cover.png' },
    sources: [{ url: 'https://example.com/source', title: 'Retain source' }] });
  const before = repo.get(created.id);
  repo.database.exec('DROP TABLE IF EXISTS term_import_keys; PRAGMA user_version=5');
  repo.database.close();
  repo = new TermRepository(path);
  try {
    assert.deepEqual(repo.get(created.id), before);
    assert.equal(repo.database.prepare('PRAGMA user_version').get().user_version, 6);
    assert.ok(repo.database.prepare("SELECT name FROM sqlite_master WHERE name='term_import_keys'").get());
    assert.equal(repo.database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { repo.database.close(); }
});
