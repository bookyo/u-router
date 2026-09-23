const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

const { createApp } = require('../src/app');
const { TermRepository } = require('../src/term-repository');

async function startTestServer() {
  const directory = mkdtempSync(join(tmpdir(), 'term-lookup-api-'));
  const server = createServer(createApp({
    apiKey: 'test-api-key',
    databasePath: join(directory, 'terms.sqlite'),
  }));

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return {
    status: response.status,
    body: await response.json(),
  };
}

test('creates a bilingual term and looks it up from en to zh-Hans', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());

  const headers = {
    'content-type': 'application/json',
    'x-api-key': 'test-api-key',
  };
  const created = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      translations: {
        en: 'container orchestration',
        'zh-Hans': '容器编排',
      },
    }),
  });

  assert.equal(created.status, 201);
  assert.deepEqual(created.body.translations, {
    en: 'container orchestration',
    'zh-Hans': '容器编排',
  });

  const found = await request(
    service.baseUrl,
    '/v1/terms?q=container%20orchestration&from=en&to=zh-Hans',
    { headers: { 'x-api-key': 'test-api-key' } },
  );

  assert.equal(found.status, 200);
  assert.equal(found.body.translation, '容器编排');
  assert.equal(found.body.translations.en, 'container orchestration');
});

test('creates a term with one parent and returns the parent when queried', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());
  const headers = {
    'content-type': 'application/json',
    'x-api-key': 'test-api-key',
  };

  const parent = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      translations: { en: 'Genshin Impact', 'zh-Hans': '原神' },
    }),
  });
  const child = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      parentId: parent.body.id,
      translations: { en: 'Raiden Shogun', 'zh-Hans': '雷电将军' },
    }),
  });

  assert.equal(child.status, 201);
  assert.deepEqual(child.body.parent, {
    id: parent.body.id,
    translations: { en: 'Genshin Impact', 'zh-Hans': '原神' },
  });

  const found = await request(
    service.baseUrl,
    '/v1/terms?q=Raiden%20Shogun&from=en&to=zh-Hans',
    { headers: { 'x-api-key': 'test-api-key' } },
  );
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.parent, child.body.parent);
});

test('rejects a parent ID that does not exist', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());

  const response = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'test-api-key',
    },
    body: JSON.stringify({
      parentId: 999,
      translations: { en: 'Raiden Shogun', 'zh-Hans': '雷电将军' },
    }),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'parent_not_found');
});

test('rejects self-referential and cyclic parent relationships', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());
  const headers = {
    'content-type': 'application/json',
    'x-api-key': 'test-api-key',
  };

  const game = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({ translations: { en: 'Genshin Impact', 'zh-Hans': '原神' } }),
  });
  const character = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      parentId: game.body.id,
      translations: { en: 'Raiden Shogun', 'zh-Hans': '雷电将军' },
    }),
  });

  const selfReference = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      parentId: character.body.id,
      translations: { en: 'RAIDEN SHOGUN', 'zh-Hans': '雷电将军' },
    }),
  });
  assert.equal(selfReference.status, 400);
  assert.equal(selfReference.body.error, 'parent_cycle');

  const cycle = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      parentId: character.body.id,
      translations: { en: 'GENSHIN IMPACT', 'zh-Hans': '原神' },
    }),
  });
  assert.equal(cycle.status, 400);
  assert.equal(cycle.body.error, 'parent_cycle');
});

test('clears an existing parent when parentId is omitted or null during an update', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());
  const headers = {
    'content-type': 'application/json',
    'x-api-key': 'test-api-key',
  };

  const parent = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({ translations: { en: 'Genshin Impact', 'zh-Hans': '原神' } }),
  });
  await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      parentId: parent.body.id,
      translations: { en: 'Raiden Shogun', 'zh-Hans': '雷电将军' },
    }),
  });
  const clearedByOmission = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({ translations: { en: 'RAIDEN SHOGUN', 'zh-Hans': '雷电将军' } }),
  });

  assert.equal(clearedByOmission.status, 200);
  assert.equal(clearedByOmission.body.parentId, null);
  assert.equal(clearedByOmission.body.parent, null);

  const restored = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      parentId: parent.body.id,
      translations: { en: 'RAIDEN SHOGUN', 'zh-Hans': '雷电将军' },
    }),
  });
  assert.equal(restored.body.parentId, parent.body.id);

  const clearedByNull = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      parentId: null,
      translations: { en: 'RAIDEN SHOGUN', 'zh-Hans': '雷电将军' },
    }),
  });
  assert.equal(clearedByNull.status, 200);
  assert.equal(clearedByNull.body.parentId, null);
  assert.equal(clearedByNull.body.parent, null);

  const queried = await request(
    service.baseUrl,
    '/v1/terms?q=Raiden%20Shogun&from=en&to=zh-Hans',
    { headers: { 'x-api-key': 'test-api-key' } },
  );
  assert.equal(queried.body.parentId, null);
  assert.equal(queried.body.parent, null);
});

test('rejects requests with an incorrect API key before accessing terms', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());

  const response = await request(service.baseUrl, '/v1/terms?q=cache&from=en&to=zh-Hans', {
    headers: { 'x-api-key': 'incorrect-key' },
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'unauthorized');
});

test('requires both en and zh-Hans when creating a term', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());

  const response = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'test-api-key',
    },
    body: JSON.stringify({ translations: { en: 'cache' } }),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'validation_error');
});

test('updates an existing normalized English term instead of creating a duplicate', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());
  const headers = {
    'content-type': 'application/json',
    'x-api-key': 'test-api-key',
  };

  await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      translations: { en: 'cache invalidation', 'zh-Hans': '缓存失效' },
    }),
  });
  const updated = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      translations: {
        en: 'CACHE INVALIDATION',
        'zh-Hans': '高速缓存失效',
        'zh-Hant': '快取失效',
      },
    }),
  });

  assert.equal(updated.status, 200);
  assert.equal(updated.body.translations['zh-Hans'], '高速缓存失效');
  assert.equal(updated.body.translations['zh-Hant'], '快取失效');
});

test('returns null when the term exists but the requested extensible target language is absent', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());
  const headers = {
    'content-type': 'application/json',
    'x-api-key': 'test-api-key',
  };

  await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      translations: { en: 'event loop', 'zh-Hans': '事件循环', ja: 'イベントループ' },
    }),
  });
  const result = await request(
    service.baseUrl,
    '/v1/terms?q=%E4%BA%8B%E4%BB%B6%E5%BE%AA%E7%8E%AF&from=zh-Hans&to=ko',
    { headers: { 'x-api-key': 'test-api-key' } },
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.translation, null);
  assert.equal(result.body.translations.ja, 'イベントループ');
});

test('exposes an unauthenticated health endpoint without term data', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());

  const response = await request(service.baseUrl, '/health');

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ok' });
});

test('rejects a JSON create body larger than the request limit', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());

  const response = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'test-api-key',
    },
    body: JSON.stringify({
      translations: {
        en: 'large payload',
        'zh-Hans': '大请求',
        ja: 'x'.repeat(65 * 1024),
      },
    }),
  });

  assert.equal(response.status, 413);
  assert.equal(response.body.error, 'payload_too_large');
});

test('returns a JSON validation error for a valid JSON body without a translations object', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());

  for (const body of ['null', '[]', '"plain text"']) {
    const response = await request(service.baseUrl, '/v1/terms', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': 'test-api-key',
      },
      body,
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'validation_error');
  }
});

test('returns a JSON parse error for malformed JSON', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());

  const response = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'test-api-key',
    },
    body: '{not-valid-json',
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'invalid_json');
});

test('rejects a duplicate normalized source translation without corrupting the existing term', async (t) => {
  const service = await startTestServer();
  t.after(() => service.close());
  const headers = {
    'content-type': 'application/json',
    'x-api-key': 'test-api-key',
  };

  await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({ translations: { en: 'cache', 'zh-Hans': '缓存' } }),
  });
  const collision = await request(service.baseUrl, '/v1/terms', {
    method: 'POST',
    headers,
    body: JSON.stringify({ translations: { en: 'cache store', 'zh-Hans': '缓存' } }),
  });

  assert.equal(collision.status, 409);
  assert.equal(collision.body.error, 'term_conflict');

  const existing = await request(
    service.baseUrl,
    '/v1/terms?q=cache&from=en&to=zh-Hans',
    { headers: { 'x-api-key': 'test-api-key' } },
  );
  assert.equal(existing.status, 200);
  assert.equal(existing.body.translation, '缓存');
});

test('migrates a legacy lookup table before enforcing canonical translation uniqueness', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'term-lookup-api-legacy-'));
  const databasePath = join(directory, 'terms.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE terms (
      id INTEGER PRIMARY KEY,
      english_key TEXT NOT NULL UNIQUE,
      translations_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE term_translations (
      term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
      language_tag TEXT NOT NULL,
      normalized_value TEXT NOT NULL,
      PRIMARY KEY (term_id, language_tag)
    );
    INSERT INTO terms (id, english_key, translations_json)
      VALUES (1, 'cache', '{"en":"cache","zh-Hans":"缓存"}');
    INSERT INTO term_translations (term_id, language_tag, normalized_value)
      VALUES (1, 'en', 'cache'), (1, 'zh-Hans', '缓存');
  `);
  legacy.close();

  const repository = new TermRepository(databasePath);
  assert.throws(
    () => repository.upsert({ en: 'cache store', 'zh-Hans': '缓存' }),
    (error) => error?.code === 'ERR_SQLITE_ERROR' && error?.errcode === 2067,
  );
});

test('refuses a legacy database with ambiguous translations without altering it', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'term-lookup-api-legacy-conflict-'));
  const databasePath = join(directory, 'terms.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE terms (
      id INTEGER PRIMARY KEY,
      english_key TEXT NOT NULL UNIQUE,
      translations_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE term_translations (
      term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
      language_tag TEXT NOT NULL,
      normalized_value TEXT NOT NULL,
      PRIMARY KEY (term_id, language_tag)
    );
    INSERT INTO terms (id, english_key, translations_json)
      VALUES
        (1, 'cache', '{"en":"cache","zh-Hans":"缓存"}'),
        (2, 'cache store', '{"en":"cache store","zh-Hans":"缓存"}');
    INSERT INTO term_translations (term_id, language_tag, normalized_value)
      VALUES
        (1, 'en', 'cache'), (1, 'zh-Hans', '缓存'),
        (2, 'en', 'cache store'), (2, 'zh-Hans', '缓存');
  `);
  legacy.close();

  assert.throws(
    () => new TermRepository(databasePath),
    /cannot migrate database: duplicate normalized translation/,
  );

  const unchanged = new DatabaseSync(databasePath);
  assert.equal(
    unchanged.prepare("SELECT COUNT(*) AS count FROM term_translations WHERE language_tag = 'zh-Hans'").get().count,
    2,
  );
  unchanged.close();
});

test('migrates a version 2 database by adding parent support without losing terms', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'term-lookup-api-v2-'));
  const databasePath = join(directory, 'terms.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE terms (
      id INTEGER PRIMARY KEY,
      english_key TEXT NOT NULL UNIQUE,
      translations_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE term_translations (
      term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
      language_tag TEXT NOT NULL,
      normalized_value TEXT NOT NULL,
      PRIMARY KEY (term_id, language_tag),
      UNIQUE (language_tag, normalized_value)
    );
    INSERT INTO terms (id, english_key, translations_json)
      VALUES
        (1, 'genshin impact', '{"en":"Genshin Impact","zh-Hans":"原神"}'),
        (2, 'raiden shogun', '{"en":"Raiden Shogun","zh-Hans":"雷电将军"}');
    INSERT INTO term_translations (term_id, language_tag, normalized_value)
      VALUES
        (1, 'en', 'genshin impact'), (1, 'zh-Hans', '原神'),
        (2, 'en', 'raiden shogun'), (2, 'zh-Hans', '雷电将军');
    PRAGMA user_version = 2;
  `);
  legacy.close();

  const repository = new TermRepository(databasePath);
  const updated = repository.upsert(
    { en: 'Raiden Shogun', 'zh-Hans': '雷电将军' },
    1,
  );

  assert.equal(updated.id, 2);
  assert.equal(updated.parentId, 1);
  assert.deepEqual(updated.parent, {
    id: 1,
    translations: { en: 'Genshin Impact', 'zh-Hans': '原神' },
  });
});
