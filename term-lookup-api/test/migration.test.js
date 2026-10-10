const assert = require('node:assert/strict');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { TermRepository } = require('../src/term-repository');

function legacy(t, { version = 3, malformed = false, parentId = 1 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'terms-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'terms.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE terms (
      id INTEGER PRIMARY KEY, english_key TEXT NOT NULL UNIQUE, translations_json TEXT NOT NULL,
      parent_id INTEGER REFERENCES terms(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE term_translations (
      term_id INTEGER NOT NULL REFERENCES terms(id), language_tag TEXT NOT NULL, normalized_value TEXT NOT NULL,
      PRIMARY KEY(term_id,language_tag), UNIQUE(language_tag,normalized_value)
    );
    PRAGMA user_version = ${version};
  `);
  const insert = db.prepare('INSERT INTO terms VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(1, 'game', '{"en":"Game","zh-Hans":"游戏"}', null, '2020-01-01', '2020-01-02');
  insert.run(2, 'alice', malformed ? 'not-json' : '{"en":"Alice","zh-Hans":"爱丽丝"}', parentId, '2020-02-01', '2020-02-02');
  db.exec("INSERT INTO term_translations VALUES (1,'en','game'),(1,'zh-Hans','游戏'),(2,'en','alice'),(2,'zh-Hans','爱丽丝')");
  db.close();
  return path;
}

test('migration converts scalar names, preserves IDs, parents and timestamps and is idempotent', (t) => {
  const path = legacy(t);
  let repository = new TermRepository(path);
  assert.equal(Number(repository.database.prepare('PRAGMA user_version').get().user_version), 6);
  let row = repository.get(2);
  assert.deepEqual(row.translations.en, ['Alice']);
  assert.equal(row.parentId, 1);
  assert.equal(row.createdAt, '2020-02-01');
  assert.deepEqual(row.ancestors.map((item) => item.id), [1]);
  repository.database.close();
  repository = new TermRepository(path);
  row = repository.get(2);
  assert.equal(row.updatedAt, '2020-02-02');
  assert.equal(repository.list({ limit: 20, offset: 0 }).total, 2);
  repository.database.close();
});

test('migration rejects malformed stored JSON and rolls back schema and data', (t) => {
  const path = legacy(t, { malformed: true });
  assert.throws(() => new TermRepository(path), /cannot migrate database/);
  const db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(db.prepare('SELECT translations_json FROM terms WHERE id=2').get().translations_json, 'not-json');
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='term_types'").get().n, 0);
  db.close();
});

test('migration rejects orphan parents before changing the legacy database', (t) => {
  const path = legacy(t, { parentId: 999 });
  assert.throws(() => new TermRepository(path), /cannot migrate database/);
  const db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
  db.close();
});

test('migration rejects unknown future versions without downgrading the schema', (t) => {
  const path = legacy(t, { version: 999 });
  assert.throws(() => new TermRepository(path), /unsupported database schema version/);
  const db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 999);
  db.close();
});

test('migration accepts previously valid long names and legacy language tags without dropping translations', (t) => {
  const path = legacy(t);
  const db = new DatabaseSync(path);
  const name = 'a'.repeat(257);
  db.prepare('UPDATE terms SET english_key=?,translations_json=? WHERE id=2').run(name, JSON.stringify({
    en: name, EN: 'Legacy alternate', 'zh-Hans': '长名称', 'en-00': 'Legacy locale',
  }));
  db.prepare("UPDATE term_translations SET normalized_value=? WHERE term_id=2 AND language_tag='en'").run(name);
  db.close();
  const repository = new TermRepository(path);
  const value = repository.get(2);
  assert.deepEqual(value.translations.en, [name, 'Legacy alternate']);
  assert.deepEqual(value.translations['en-00'], ['Legacy locale']);
  assert.equal(repository.find({ value: name, from: 'en' }).id, 2);
  const update = repository.upsert({ en: name, 'zh-Hans': '修改名称', 'en-00': 'Legacy locale' }, 1);
  assert.equal(update.id, 2);
  repository.database.close();
});

test('migrated overlong names can acquire a valid alias and remove the historical name', (t) => {
  const path = legacy(t);
  const db = new DatabaseSync(path);
  const name = 'a'.repeat(257);
  db.prepare('UPDATE terms SET english_key=?,translations_json=? WHERE id=2').run(name, JSON.stringify({ en: name, 'zh-Hans': '长名称' }));
  db.prepare("UPDATE term_translations SET normalized_value=? WHERE term_id=2 AND language_tag='en'").run(name);
  db.close();
  const repository = new TermRepository(path);
  const appended = repository.changeName(2, { language: 'en', value: 'Short alias' });
  assert.deepEqual(appended.translations.en, [name, 'Short alias']);
  const removed = repository.changeName(2, { language: 'en', value: name }, true);
  assert.deepEqual(removed.translations.en, ['Short alias']);
  repository.database.close();
});

test('migration preserves version 4 alias arrays and rebuilds all searchable names', (t) => {
  const path = legacy(t, { version: 4 });
  const db = new DatabaseSync(path);
  db.exec(`DROP TABLE term_translations;
    CREATE TABLE term_translations (
      term_id INTEGER REFERENCES terms(id),language_tag TEXT,normalized_value TEXT,
      PRIMARY KEY(term_id,language_tag,normalized_value),UNIQUE(language_tag,normalized_value)
    );
    INSERT INTO term_translations VALUES (1,'en','game'),(1,'zh-Hans','游戏'),(2,'en','alice'),(2,'en','ally'),(2,'zh-Hans','爱丽丝');`);
  db.prepare('UPDATE terms SET translations_json=? WHERE id=2').run(JSON.stringify({ en: ['Alice', 'Ally'], 'zh-Hans': ['爱丽丝'] }));
  db.close();
  const repository = new TermRepository(path);
  assert.deepEqual(repository.get(2).translations.en, ['Alice', 'Ally']);
  assert.equal(repository.find({ value: 'ally', from: 'en' }).id, 2);
  repository.database.close();
});

test('migration refuses a legacy parent cycle and preserves the original schema', (t) => {
  const path = legacy(t);
  const db = new DatabaseSync(path);
  db.prepare('UPDATE terms SET parent_id=2 WHERE id=1').run();
  db.close();
  assert.throws(() => new TermRepository(path), /cannot migrate database: parent cycle/);
  const unchanged = new DatabaseSync(path);
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(unchanged.prepare('SELECT parent_id FROM terms WHERE id=1').get().parent_id, 2);
  unchanged.close();
});
