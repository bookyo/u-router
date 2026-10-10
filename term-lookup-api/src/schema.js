const { legacyNames, normalizeLookupValue } = require('./validation');

const SCHEMA_VERSION = 6;
const IMPORT_SCHEMA = `CREATE TABLE term_import_keys (
  source TEXT NOT NULL, external_id TEXT NOT NULL,
  term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  PRIMARY KEY(source,external_id)
); CREATE INDEX term_import_keys_term ON term_import_keys(term_id);`;
const BUILTIN_TYPES = [
  ['term', 'Term', '术语'], ['person', 'Person', '人物'], ['character', 'Character', '角色'],
  ['work', 'Work', '作品'], ['place', 'Place', '地点'], ['organization', 'Organization', '组织'], ['item', 'Item', '物品'],
];

function transaction(database, action) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = action();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function migrate(database) {
  const version = Number(database.prepare('PRAGMA user_version').get().user_version);
  if (version > SCHEMA_VERSION) throw new Error(`unsupported database schema version ${version}`);
  if (version === SCHEMA_VERSION) return;

  // v5 already has rich content and taxonomy. Do not rebuild it using legacy conversion.
  if (version === 5) {
    transaction(database, () => {
      database.exec(IMPORT_SCHEMA);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
    return;
  }

  transaction(database, () => {
    try {
      const exists = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='terms'").get();
      const legacy = exists ? database.prepare('SELECT * FROM terms ORDER BY id').all() : [];
      if (exists && version < 2) {
        const duplicate = database.prepare(`SELECT language_tag FROM term_translations
          GROUP BY language_tag, normalized_value HAVING COUNT(*) > 1 LIMIT 1`).get();
        if (duplicate) throw new Error(`duplicate normalized translation for ${duplicate.language_tag}`);
      }
      const oldIds = new Map(legacy.map((row) => [row.id, row]));
      const converted = legacy.map((row) => {
        const stored = JSON.parse(row.translations_json);
        const names = legacyNames(stored, true);
        const visited = new Set([row.id]);
        let parentId = row.parent_id ?? null;
        while (parentId !== null) {
          if (visited.has(parentId)) throw new Error('parent cycle');
          visited.add(parentId);
          const parent = oldIds.get(parentId);
          if (!parent) throw new Error('orphan parent');
          parentId = parent.parent_id ?? null;
        }
        return { ...row, names };
      });

      database.exec(`
        CREATE TABLE term_types (
          id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, translations_json TEXT NOT NULL
        );
        CREATE TABLE tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, translations_json TEXT NOT NULL
        );
        CREATE TABLE categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, translations_json TEXT NOT NULL,
          parent_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT
        );
        CREATE INDEX categories_parent ON categories(parent_id);
        CREATE TABLE terms_v5 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          english_key TEXT NOT NULL,
          translations_json TEXT NOT NULL,
          type_id INTEGER NOT NULL REFERENCES term_types(id) ON DELETE RESTRICT,
          details_json TEXT NOT NULL DEFAULT '{}',
          summaries_json TEXT NOT NULL DEFAULT '{}',
          cover_json TEXT,
          sources_json TEXT NOT NULL DEFAULT '[]',
          parent_id INTEGER REFERENCES terms_v5(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
      `);
      const insertType = database.prepare('INSERT INTO term_types (slug,translations_json) VALUES (?,?)');
      for (const [slug, en, zh] of BUILTIN_TYPES) insertType.run(slug, JSON.stringify({ en, 'zh-Hans': zh }));
      const typeId = database.prepare("SELECT id FROM term_types WHERE slug='term'").get().id;
      const insertTerm = database.prepare(`INSERT INTO terms_v5
        (id,english_key,translations_json,type_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`);
      for (const row of converted) insertTerm.run(row.id, normalizeLookupValue(row.names.en[0]), JSON.stringify(row.names), typeId, row.created_at, row.updated_at);
      const updateParent = database.prepare('UPDATE terms_v5 SET parent_id=? WHERE id=?');
      for (const row of converted) updateParent.run(row.parent_id ?? null, row.id);
      if (exists) {
        database.exec('DROP TABLE term_translations');
        if (database.prepare('PRAGMA table_info(terms)').all().some((column) => column.name === 'parent_id')) {
          // Converted rows retain the hierarchy; clear old self-FKs before dropping the table.
          database.exec('UPDATE terms SET parent_id=NULL');
        }
        database.exec('DROP TABLE terms');
      }
      database.exec(`
        ALTER TABLE terms_v5 RENAME TO terms;
        CREATE INDEX terms_english_key ON terms(english_key);
        CREATE INDEX terms_type ON terms(type_id);
        CREATE INDEX terms_parent_lookup ON terms(parent_id);
        CREATE TABLE term_translations (
          term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
          language_tag TEXT NOT NULL, normalized_value TEXT NOT NULL,
          PRIMARY KEY(term_id,language_tag,normalized_value)
        );
        CREATE INDEX term_translations_lookup ON term_translations(language_tag,normalized_value,term_id);
        CREATE TABLE term_tags (
          term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
          tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
          PRIMARY KEY(term_id,tag_id)
        );
        CREATE INDEX term_tags_reverse ON term_tags(tag_id,term_id);
        CREATE TABLE term_categories (
          term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
          category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
          PRIMARY KEY(term_id,category_id)
        );
        CREATE INDEX term_categories_reverse ON term_categories(category_id,term_id);
      `);
      const insertName = database.prepare('INSERT INTO term_translations VALUES (?,?,?)');
      for (const row of converted) {
        for (const [lang, names] of Object.entries(row.names)) {
          for (const name of names) insertName.run(row.id, lang, normalizeLookupValue(name));
        }
      }
      if (database.prepare('PRAGMA foreign_key_check').all().length) throw new Error('foreign key validation failed');
      database.exec(IMPORT_SCHEMA);
      database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    } catch (error) {
      throw new Error(`cannot migrate database: ${error.message}`, { cause: error });
    }
  });
}

module.exports = { migrate, transaction, SCHEMA_VERSION };
