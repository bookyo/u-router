const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createServer } = require('node:http');
const test = require('node:test');
const { createApp } = require('../src/app');

async function service(t) {
  const directory = mkdtempSync(join(tmpdir(), 'terms-v2-'));
  const databasePath = join(directory, 'terms.sqlite');
  let server;
  let app;
  let baseUrl;
  async function start() {
    app = createApp({ apiKey: 'test-key', databasePath });
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    app.close?.();
  }
  await start();
  t.after(async () => { await stop(); rmSync(directory, { recursive: true, force: true }); });
  return {
    async request(path, method = 'GET', payload, authenticated = true) {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-api-key': 'test-key' } : {}) },
        body: payload === undefined ? undefined : JSON.stringify(payload),
      });
      return { status: response.status, body: await response.json() };
    },
    async restart() { await stop(); await start(); },
  };
}

function term(en = 'Raiden Shogun', zh = '雷电将军', extra = {}) {
  return { type: 'character', translations: { en: [en], 'zh-Hans': [zh] }, ...extra };
}

async function create(s, payload = term()) {
  const result = await s.request('/v2/terms', 'POST', payload);
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

test('v2 persists multilingual content, cover and sources across restart', async (t) => {
  const s = await service(t);
  const details = {
    'zh-Hans': { summary: '角色简介', description: '详细纯文本', body: '## 介绍\n\n**角色**', format: 'markdown' },
    en: { summary: 'Character', body: '# Details', format: 'markdown' },
  };
  const cover = { url: 'https://example.com/cover.jpg', alt: { 'zh-Hans': '封面' } };
  const sources = [{ url: 'https://example.com/source', title: '资料', language: 'zh-Hans' }];
  const created = await create(s, term(undefined, undefined, { details, cover, sources }));
  await s.restart();
  const result = await s.request(`/v2/terms/${created.id}`);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.details, details);
  assert.deepEqual(result.body.cover, cover);
  assert.deepEqual(result.body.sources, sources);
  assert.equal(result.body.type, 'character');
  assert.ok(result.body.createdAt);
  assert.ok(result.body.updatedAt);
});

test('v2 finds every alias with canonical language and normalized name', async (t) => {
  const s = await service(t);
  const created = await create(s, term(undefined, undefined, {
    translations: { EN: ['Raiden Shogun', 'Ei'], 'zh-hans': ['雷电将军', '雷电影'], ja: ['雷電将軍'] },
  }));
  const found = await s.request('/v2/terms?q=%20%EF%BC%A5%EF%BC%A9%20&from=EN&to=zh-hans');
  assert.equal(found.status, 200);
  assert.equal(found.body.total, 1);
  assert.equal(found.body.items[0].id, created.id);
  assert.deepEqual(found.body.items[0].translation, ['雷电将军', '雷电影']);
  assert.deepEqual(found.body.items[0].translations.en, ['Raiden Shogun', 'Ei']);
  const absent = await s.request('/v2/terms?q=Ei&from=en&to=ko');
  assert.equal(absent.body.items[0].translation, null);
});

test('v2 allows same-name concepts and filters combined type and parent', async (t) => {
  const s = await service(t);
  const game = await create(s, term('Game', '游戏', { type: 'work' }));
  const one = await create(s, term('Alice', '爱丽丝', { parentId: game.id }));
  const two = await create(s, term('Alice', '爱丽丝', { type: 'person' }));
  const all = await s.request('/v2/terms?q=Alice&from=en&limit=1&offset=1');
  assert.equal(all.status, 200);
  assert.equal(all.body.total, 2);
  assert.deepEqual(all.body.items.map((item) => item.id), [two.id]);
  const filtered = await s.request(`/v2/terms?q=Alice&from=en&type=character&parentId=${game.id}`);
  assert.deepEqual(filtered.body.items.map((item) => item.id), [one.id]);
  const legacy = await s.request('/v1/terms?q=Alice&from=en&to=zh-Hans');
  assert.equal(legacy.status, 409);
  assert.equal(legacy.body.error, 'ambiguous_term');
});

test('PATCH merges multilingual details, preserves omitted parent and permits explicit clearing', async (t) => {
  const s = await service(t);
  const parent = await create(s, term('Game', '游戏', { type: 'work' }));
  const child = await create(s, term(undefined, undefined, {
    parentId: parent.id,
    details: { en: { summary: 'old', body: 'keep', format: 'markdown' }, ja: { summary: '削除' } },
    cover: { url: 'https://example.com/a.png' },
  }));
  const patched = await s.request(`/v2/terms/${child.id}`, 'PATCH', { details: { en: { summary: '' }, ja: null } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.parentId, parent.id);
  assert.deepEqual(patched.body.details.en, { summary: '', body: 'keep', format: 'markdown' });
  assert.equal(patched.body.details.ja, undefined);
  const cleared = await s.request(`/v2/terms/${child.id}`, 'PATCH', { parentId: null, cover: null });
  assert.equal(cleared.body.parent, null);
  assert.equal(cleared.body.cover, null);
  assert.equal(cleared.body.details.en.body, 'keep');
});

test('children are direct and paginated; ancestors are root-first and cycles roll back', async (t) => {
  const s = await service(t);
  const root = await create(s, term('Root', '根', { type: 'work' }));
  const child = await create(s, term('Child', '子', { parentId: root.id }));
  const leaf = await create(s, term('Leaf', '叶', { parentId: child.id }));
  const children = await s.request(`/v2/terms/${root.id}/children?limit=1`);
  assert.equal(children.body.total, 1);
  assert.deepEqual(children.body.items.map((item) => item.id), [child.id]);
  const ancestors = await s.request(`/v2/terms/${leaf.id}/ancestors`);
  assert.deepEqual(ancestors.body.items.map((item) => item.id), [root.id, child.id]);
  const cycle = await s.request(`/v2/terms/${root.id}`, 'PATCH', { parentId: leaf.id, details: { en: { body: 'bad' } } });
  assert.equal(cycle.status, 400);
  assert.equal(cycle.body.error, 'parent_cycle');
  const unchanged = await s.request(`/v2/terms/${root.id}`);
  assert.equal(unchanged.body.parentId, null);
  assert.deepEqual(unchanged.body.details, {});
  assert.equal((await s.request(`/v2/terms/${root.id}`, 'DELETE')).status, 409);
  assert.equal((await s.request(`/v2/terms/${leaf.id}`, 'DELETE')).status, 200);
  assert.equal((await s.request(`/v2/terms/${leaf.id}`)).status, 404);
});

test('append alias is idempotent; removal protects required names and promotes next name', async (t) => {
  const s = await service(t);
  const created = await create(s);
  for (const value of ['Ei', 'ＥＩ']) {
    const result = await s.request(`/v2/terms/${created.id}/names`, 'POST', { language: 'EN', value });
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.translations.en, ['Raiden Shogun', 'Ei']);
  }
  const removed = await s.request(`/v2/terms/${created.id}/names`, 'DELETE', { language: 'en', value: 'Raiden Shogun' });
  assert.deepEqual(removed.body.translations.en, ['Ei']);
  assert.equal((await s.request(`/v2/terms/${created.id}/names`, 'DELETE', { language: 'en', value: 'Ei' })).status, 400);
  assert.equal((await s.request(`/v2/terms/${created.id}/names`, 'POST', { language: 'ja', value: '雷電' })).status, 200);
  const noJa = await s.request(`/v2/terms/${created.id}/names`, 'DELETE', { language: 'ja', value: '雷電' });
  assert.equal(noJa.body.translations.ja, undefined);
  assert.equal((await s.request('/v2/terms/999/names', 'POST', {})).status, 404);
});

test('type, tag and hierarchical category CRUD supports filtered terms and deletion guards', async (t) => {
  const s = await service(t);
  const type = await s.request('/v2/types', 'POST', { slug: 'skill', translations: { en: 'Skill', 'zh-Hans': '技能' } });
  assert.equal(type.status, 201);
  const tag = await s.request('/v2/tags', 'POST', { slug: 'electro', translations: { en: 'Electro', 'zh-Hans': '雷' } });
  assert.equal(tag.status, 201);
  const category = await s.request('/v2/categories', 'POST', { slug: 'game', translations: { en: 'Game', 'zh-Hans': '游戏' } });
  assert.equal(category.status, 201);
  const sub = await s.request('/v2/categories', 'POST', {
    slug: 'rpg', parentId: category.body.id, translations: { en: 'RPG', 'zh-Hans': '角色扮演' },
  });
  assert.equal(sub.status, 201);
  const created = await create(s, term('Thunder', '雷击', {
    type: 'skill', tagIds: [tag.body.id, tag.body.id], categoryIds: [sub.body.id],
  }));
  assert.equal(created.tags[0].slug, 'electro');
  assert.deepEqual(created.tagIds, [tag.body.id]);
  const listed = await s.request(`/v2/terms?type=skill&tagId=${tag.body.id}&categoryId=${sub.body.id}`);
  assert.deepEqual(listed.body.items.map((item) => item.id), [created.id]);
  const categories = await s.request(`/v2/categories?parentId=${category.body.id}`);
  assert.equal(categories.body.items[0].id, sub.body.id);
  assert.deepEqual(categories.body.items[0].ancestors.map((item) => item.id), [category.body.id]);
  assert.equal((await s.request(`/v2/categories/${category.body.id}`, 'PATCH', { parentId: sub.body.id })).status, 400);
  assert.equal((await s.request(`/v2/categories/${sub.body.id}`, 'DELETE')).status, 409);
  assert.equal((await s.request(`/v2/types/${type.body.id}`, 'DELETE')).status, 409);
  const changed = await s.request(`/v2/types/${type.body.id}`, 'PATCH', { translations: { en: 'Ability', 'zh-Hans': '能力' } });
  assert.equal(changed.body.translations.en, 'Ability');
  assert.equal((await s.request(`/v2/tags/${tag.body.id}`, 'DELETE')).status, 200);
  assert.deepEqual((await s.request(`/v2/terms/${created.id}`)).body.tagIds, []);
  assert.equal((await s.request(`/v2/terms/${created.id}`, 'DELETE')).status, 200);
  assert.equal((await s.request(`/v2/categories/${sub.body.id}`, 'DELETE')).status, 200);
  assert.equal((await s.request(`/v2/categories/${category.body.id}`, 'DELETE')).status, 200);
  assert.equal((await s.request(`/v2/types/${type.body.id}`, 'DELETE')).status, 200);
});

test('slug conflicts and unknown references leave the term unchanged', async (t) => {
  const s = await service(t);
  const payload = { slug: 'game', translations: { en: 'Game', 'zh-Hans': '游戏' } };
  assert.equal((await s.request('/v2/tags', 'POST', payload)).status, 201);
  assert.equal((await s.request('/v2/tags', 'POST', payload)).status, 409);
  const created = await create(s);
  for (const patch of [{ tagIds: [999] }, { categoryIds: [999] }, { parentId: 999 }, { type: 'missing' }]) {
    const response = await s.request(`/v2/terms/${created.id}`, 'PATCH', { ...patch, details: { en: { body: 'should rollback' } } });
    assert.equal(response.status, 400);
  }
  const after = await s.request(`/v2/terms/${created.id}`);
  assert.deepEqual(after.body.details, {});
  assert.deepEqual(after.body.tagIds, []);
});

test('rich text renders headings, tables, links, lists and images without executable markup', async (t) => {
  const s = await service(t);
  const body = '# Title\n\n**bold** and [safe](https://example.com)\n\n- one\n- two\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![cover](https://example.com/a.png)\n\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))\n![bad](data:text/html;base64,AAAA)';
  const created = await create(s, term(undefined, undefined, { details: { en: { body, format: 'markdown' } } }));
  const rendered = await s.request(`/v2/terms/${created.id}/content?language=EN`);
  assert.equal(rendered.status, 200);
  assert.equal(rendered.body.body, body);
  assert.match(rendered.body.html, /<h1>Title<\/h1>/);
  assert.match(rendered.body.html, /<strong>bold<\/strong>/);
  assert.match(rendered.body.html, /<table>/);
  assert.match(rendered.body.html, /<ul>/);
  assert.match(rendered.body.html, /href="https:\/\/example.com"/);
  assert.match(rendered.body.html, /src="https:\/\/example.com\/a.png"/);
  assert.doesNotMatch(rendered.body.html, /<script|<img[^>]*onerror|(?:href|src)="(?:javascript|data):/i);
  assert.equal((await s.request(`/v2/terms/${created.id}/content?language=ja`)).status, 404);
});

test('list summary omits bodies and returns deterministic pagination', async (t) => {
  const s = await service(t);
  const a = await create(s, term('A', '甲', { details: { en: { body: 'large content', summary: 'brief', description: 'details' } } }));
  const b = await create(s, term('B', '乙'));
  const listed = await s.request('/v2/terms?limit=1&offset=0');
  assert.equal(listed.body.total, 2);
  assert.equal(listed.body.limit, 1);
  assert.equal(listed.body.offset, 0);
  assert.deepEqual(listed.body.items.map((item) => item.id), [a.id]);
  assert.equal(listed.body.items[0].details.en.summary, 'brief');
  assert.equal(listed.body.items[0].details.en.body, undefined);
  assert.equal(listed.body.items[0].details.en.description, undefined);
  const second = await s.request('/v2/terms?limit=1&offset=1');
  assert.deepEqual(second.body.items.map((item) => item.id), [b.id]);
});

test('v1 update preserves v2 content and aliases and conflicts never partially write', async (t) => {
  const s = await service(t);
  const created = await create(s, term('cache', '缓存', {
    type: 'term', translations: { en: ['cache', 'cache memory'], 'zh-Hans': ['缓存'] },
    details: { en: { body: 'Keep content' } }, cover: { url: 'https://example.com/a.png' },
  }));
  const update = await s.request('/v1/terms', 'POST', { translations: { en: 'CACHE', 'zh-Hans': '高速缓存' } });
  assert.equal(update.status, 200);
  assert.equal(update.body.id, created.id);
  const detail = await s.request(`/v2/terms/${created.id}`);
  assert.equal(detail.body.details.en.body, 'Keep content');
  assert.equal(detail.body.cover.url, 'https://example.com/a.png');
  assert.deepEqual(detail.body.translations.en, ['CACHE', 'cache memory']);
  const alias = await s.request('/v1/terms?q=cache%20memory&from=en&to=zh-Hans');
  assert.equal(alias.body.translation, '高速缓存');
  await create(s, term('cache', '同名', { type: 'term' }));
  const ambiguous = await s.request('/v1/terms', 'POST', { translations: { en: 'cache', 'zh-Hans': '错误更新' } });
  assert.equal(ambiguous.status, 409);
  assert.equal(ambiguous.body.error, 'ambiguous_term');
  assert.equal((await s.request(`/v2/terms/${created.id}`)).body.translations['zh-Hans'][0], '高速缓存');
});

test('v1 refuses to overwrite another type even when its English name is unique', async (t) => {
  const s = await service(t);
  const created = await create(s);
  const result = await s.request('/v1/terms', 'POST', { translations: { en: 'Raiden Shogun', 'zh-Hans': '错误' } });
  assert.equal(result.status, 409);
  assert.equal((await s.request(`/v2/terms/${created.id}`)).body.translations['zh-Hans'][0], '雷电将军');
});

test('v2 rejects malformed names, content, references and unknown fields', async (t) => {
  const s = await service(t);
  const cases = [
    { translations: { en: 'scalar', 'zh-Hans': ['中文'] } },
    { translations: { en: ['A', 'Ａ'], 'zh-Hans': ['中文'] } },
    { translations: { en: ['A'], EN: ['B'], 'zh-Hans': ['中文'] } },
    { translations: { en: [], 'zh-Hans': ['中文'] } },
    { translations: { en: ['A'], 'zh-Hans': [null] } },
    { translations: { en: ['A'] } },
    { translations: { en: ['A'], 'zh-Hans': ['中文'], 'not a language': ['X'] } },
    { extra: true }, { parentId: -1 }, { tagIds: [0] }, { type: 'not-existing' },
    { cover: { url: 'javascript:alert(1)' } }, { cover: { url: '//example.com/img' } },
    { sources: [{ url: 'file:///etc/passwd', title: 'bad' }] },
    { sources: [{ url: 'https://example.com', title: 123 }] },
    { details: { en: { format: 'html', body: '<p>HTML</p>' } } },
    { details: { en: { summary: 'a'.repeat(2001) } } },
    { details: { en: { description: 'a'.repeat(20001) } } },
    { details: { en: { unexpected: 'x' } } },
    { details: JSON.parse('{"__proto__":{"body":"x"}}') },
  ];
  for (const invalid of cases) {
    const response = await s.request('/v2/terms', 'POST', term('A', '甲', invalid));
    assert.equal(response.status, 400, JSON.stringify(invalid).slice(0, 150));
  }
  assert.equal((await s.request('/v2/terms')).body.total, 0);
});

test('v2 strictly validates query bounds and identifiers', async (t) => {
  const s = await service(t);
  for (const path of [
    '/v2/terms?limit=0', '/v2/terms?limit=101', '/v2/terms?offset=-1', '/v2/terms?offset=1.5',
    '/v2/terms?limit=2&limit=3', '/v2/terms?q=A', '/v2/terms?from=en',
    '/v2/terms?parentId=0', '/v2/terms?tagId=foo', '/v2/terms?unknown=x', '/v2/terms/0',
    '/v2/terms/1x', '/v2/categories?parentId=-1',
  ]) assert.equal((await s.request(path)).status, 400, path);
  assert.equal((await s.request('/v2/terms/999')).status, 404);
  assert.equal((await s.request('/v2/terms/999', 'PATCH', {})).status, 404);
});

test('v2 enforces body and per-language byte limits without storing partial content', async (t) => {
  const s = await service(t);
  const tooLong = await s.request('/v2/terms', 'POST', term('Big', '大', { details: { en: { body: '中'.repeat(175000) } } }));
  assert.equal(tooLong.status, 413);
  const tooLarge = await s.request('/v2/terms', 'POST', term('Huge', '巨', { details: { en: { body: 'x'.repeat(2 * 1024 * 1024) } } }));
  assert.equal(tooLarge.status, 413);
  assert.equal((await s.request('/v2/terms')).body.total, 0);
});

test('all v2 write routes authenticate before modifying any records', async (t) => {
  const s = await service(t);
  for (const [path, method, payload] of [
    ['/v2/terms', 'POST', term()], ['/v2/terms/1', 'PATCH', {}],
    ['/v2/terms/1', 'DELETE'], ['/v2/terms/1/names', 'POST', {}],
    ['/v2/tags', 'POST', {}], ['/v2/categories', 'POST', {}], ['/v2/types/1', 'DELETE'],
  ]) assert.equal((await s.request(path, method, payload, false)).status, 401, path);
  assert.equal((await s.request('/v2/terms')).body.total, 0);
});

test('SQL-special names remain literal exact lookups and cannot bypass filters', async (t) => {
  const s = await service(t);
  const created = await create(s, term("O'Reilly'; DROP TABLE terms; --", '特殊词条'));
  const found = await s.request(`/v2/terms?q=${encodeURIComponent("O'Reilly'; DROP TABLE terms; --")}&from=en`);
  assert.equal(found.body.total, 1);
  assert.equal(found.body.items[0].id, created.id);
  assert.equal((await s.request('/v2/terms')).body.total, 1);
});

test('ASCII body byte overflow returns 413 and does not create a term', async (t) => {
  const s = await service(t);
  const result = await s.request('/v2/terms', 'POST', term('Big', '大', {
    details: { en: { body: 'a'.repeat(512 * 1024 + 1) } },
  }));
  assert.equal(result.status, 413);
  assert.equal((await s.request('/v2/terms')).body.total, 0);
});

test('accumulated PATCH content cannot exceed the stored term byte budget', async (t) => {
  const s = await service(t);
  const details = Object.fromEntries(['en', 'zh-Hans', 'ja', 'ko'].map((lang) => [lang, { body: 'x'.repeat(450000) }]));
  const created = await create(s, term('Large', '大', { details }));
  const result = await s.request(`/v2/terms/${created.id}`, 'PATCH', { details: { fr: { body: 'x'.repeat(450000) } } });
  assert.equal(result.status, 413);
  const found = await s.request(`/v2/terms/${created.id}`);
  assert.equal(found.body.details.fr, undefined);
  assert.equal(found.body.details.en.body.length, 450000);
});

test('default term type cannot be removed or renamed, preserving legacy and default creation', async (t) => {
  const s = await service(t);
  const types = await s.request('/v2/types');
  assert.equal(types.status, 200);
  const defaultType = types.body.items.find((value) => value.slug === 'term');
  assert.ok(defaultType);
  assert.equal((await s.request(`/v2/types/${defaultType.id}`, 'DELETE')).status, 409);
  assert.equal((await s.request(`/v2/types/${defaultType.id}`, 'PATCH', { slug: 'removed' })).status, 409);
  const legacy = await s.request('/v1/terms', 'POST', { translations: { en: 'cache', 'zh-Hans': '缓存' } });
  assert.equal(legacy.status, 201);
});

test('v1 updating through an alias retains the former preferred name as a searchable alias', async (t) => {
  const s = await service(t);
  const created = await create(s, term('Cache', '缓存', {
    type: 'term', translations: { en: ['Cache', 'Cache memory'], 'zh-Hans': ['缓存'] },
  }));
  assert.equal((await s.request('/v1/terms', 'POST', { translations: { en: 'Cache memory', 'zh-Hans': '缓存' } })).status, 200);
  const found = await s.request('/v1/terms?q=cache&from=en&to=zh-Hans');
  assert.equal(found.status, 200);
  assert.equal(found.body.id, created.id);
  assert.deepEqual((await s.request(`/v2/terms/${created.id}`)).body.translations.en, ['Cache memory', 'Cache']);
});

test('name and collection limits reject overflow; replacing translations removes stale indexes', async (t) => {
  const s = await service(t);
  const names = Array.from({ length: 50 }, (_, i) => `Name ${i}`);
  const created = await create(s, term('A', '甲', { translations: { en: names, 'zh-Hans': ['甲'] } }));
  assert.equal((await s.request(`/v2/terms/${created.id}/names`, 'POST', { language: 'en', value: 'Overflow' })).status, 400);
  const replaced = await s.request(`/v2/terms/${created.id}`, 'PATCH', { translations: { en: ['New'], 'zh-Hans': ['新'] } });
  assert.equal(replaced.status, 200);
  assert.equal((await s.request('/v2/terms?q=Name%201&from=en')).body.total, 0);
  assert.equal((await s.request('/v2/terms?q=New&from=en')).body.total, 1);
  for (const invalid of [
    { sources: Array.from({ length: 101 }, () => ({ url: 'https://example.com', title: 'Source' })) },
    { tagIds: Array(101).fill(1) }, { categoryIds: Array(101).fill(1) },
    { translations: { en: ['x'.repeat(257)], 'zh-Hans': ['甲'] } },
  ]) assert.equal((await s.request('/v2/terms', 'POST', term('Bad', '坏', invalid))).status, 400);
});

test('category parent updates preserve omission, detach explicitly and roll back slug conflicts', async (t) => {
  const s = await service(t);
  const parent = await s.request('/v2/categories', 'POST', { slug: 'root', translations: { en: 'Root', 'zh-Hans': '根' } });
  const child = await s.request('/v2/categories', 'POST', { slug: 'child', parentId: parent.body.id, translations: { en: 'Child', 'zh-Hans': '子' } });
  assert.equal(child.status, 201);
  const rename = await s.request(`/v2/categories/${child.body.id}`, 'PATCH', { translations: { en: 'Renamed', 'zh-Hans': '重命名' } });
  assert.equal(rename.body.parentId, parent.body.id);
  assert.equal((await s.request(`/v2/categories/${child.body.id}`, 'PATCH', { slug: 'root', parentId: null })).status, 409);
  assert.equal((await s.request(`/v2/categories/${child.body.id}`)).body.parentId, parent.body.id);
  const detach = await s.request(`/v2/categories/${child.body.id}`, 'PATCH', { parentId: null });
  assert.deepEqual(detach.body.ancestors, []);
  assert.equal(detach.body.parentId, null);
});

test('v1 unique preferred-name updates tolerate pre-existing shared aliases without new collisions', async (t) => {
  const s = await service(t);
  const first = await create(s, term('A', '甲', { type: 'term', translations: { en: ['A', 'Shared'], 'zh-Hans': ['甲'] } }));
  await create(s, term('B', '乙', { type: 'term', translations: { en: ['B', 'Shared'], 'zh-Hans': ['乙'] } }));
  const result = await s.request('/v1/terms', 'POST', { translations: { en: 'A', 'zh-Hans': '更新甲' } });
  assert.equal(result.status, 200);
  assert.equal(result.body.id, first.id);
  assert.deepEqual((await s.request(`/v2/terms/${first.id}`)).body.translations.en, ['A', 'Shared']);
  assert.equal((await s.request('/v1/terms?q=Shared&from=en&to=zh-Hans')).status, 409);
  const collision = await s.request('/v1/terms', 'POST', { translations: { en: 'A', 'zh-Hans': '乙' } });
  assert.equal(collision.status, 409);
  assert.equal((await s.request(`/v2/terms/${first.id}`)).body.translations['zh-Hans'][0], '更新甲');
});
