const { DatabaseSync } = require('node:sqlite');

function normalizeLookupValue(value) {
  return value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

class ParentNotFoundError extends Error {}
class ParentCycleError extends Error {}

class TermRepository {
  constructor(databasePath) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS terms (
        id INTEGER PRIMARY KEY,
        english_key TEXT NOT NULL UNIQUE,
        translations_json TEXT NOT NULL,
        parent_id INTEGER REFERENCES terms(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS term_translations (
        term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
        language_tag TEXT NOT NULL,
        normalized_value TEXT NOT NULL,
        PRIMARY KEY (term_id, language_tag),
        UNIQUE (language_tag, normalized_value)
      );

      CREATE INDEX IF NOT EXISTS term_translations_lookup
        ON term_translations(language_tag, normalized_value);
    `);
    this.migrateTranslationSchema();
    this.migrateParentSchema();

    this.findByEnglish = this.database.prepare(
      'SELECT id FROM terms WHERE english_key = ?',
    );
    this.findById = this.database.prepare(
      'SELECT id, parent_id, translations_json FROM terms WHERE id = ?',
    );
    this.insertTerm = this.database.prepare(
      'INSERT INTO terms (english_key, translations_json, parent_id) VALUES (?, ?, ?)',
    );
    this.updateTerm = this.database.prepare(
      'UPDATE terms SET translations_json = ?, parent_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    );
    this.deleteTranslations = this.database.prepare(
      'DELETE FROM term_translations WHERE term_id = ?',
    );
    this.insertTranslation = this.database.prepare(
      'INSERT INTO term_translations (term_id, language_tag, normalized_value) VALUES (?, ?, ?)',
    );
    this.findTranslation = this.database.prepare(`
      SELECT terms.id, terms.translations_json, terms.parent_id,
        parent.id AS parent_term_id,
        parent.translations_json AS parent_translations_json
      FROM term_translations
      JOIN terms ON terms.id = term_translations.term_id
      LEFT JOIN terms AS parent ON parent.id = terms.parent_id
      WHERE term_translations.language_tag = ?
        AND term_translations.normalized_value = ?
      ORDER BY terms.id ASC
      LIMIT 1
    `);
  }

  migrateParentSchema() {
    const version = Number(this.database.prepare('PRAGMA user_version').get().user_version);
    if (version >= 3) {
      return;
    }

    const columns = this.database.prepare('PRAGMA table_info(terms)').all();
    const hasParentId = columns.some((column) => column.name === 'parent_id');
    let transactionStarted = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      if (!hasParentId) {
        this.database.exec('ALTER TABLE terms ADD COLUMN parent_id INTEGER REFERENCES terms(id) ON DELETE RESTRICT');
      }
      this.database.exec(`
        CREATE INDEX IF NOT EXISTS terms_parent_lookup ON terms(parent_id);
        PRAGMA user_version = 3;
        COMMIT;
      `);
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  migrateTranslationSchema() {
    const version = Number(this.database.prepare('PRAGMA user_version').get().user_version);
    if (version >= 2) {
      return;
    }

    let transactionStarted = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;

      const duplicate = this.database.prepare(`
        SELECT language_tag, normalized_value
        FROM term_translations
        GROUP BY language_tag, normalized_value
        HAVING COUNT(*) > 1
        LIMIT 1
      `).get();
      if (duplicate) {
        throw new Error(
          `cannot migrate database: duplicate normalized translation for ${duplicate.language_tag}`,
        );
      }

      this.database.exec(`
        CREATE TABLE term_translations_v2 (
          term_id INTEGER NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
          language_tag TEXT NOT NULL,
          normalized_value TEXT NOT NULL,
          PRIMARY KEY (term_id, language_tag),
          UNIQUE (language_tag, normalized_value)
        );
        INSERT INTO term_translations_v2 (term_id, language_tag, normalized_value)
          SELECT term_id, language_tag, normalized_value FROM term_translations;
        DROP TABLE term_translations;
        ALTER TABLE term_translations_v2 RENAME TO term_translations;
        CREATE INDEX term_translations_lookup
          ON term_translations(language_tag, normalized_value);
        PRAGMA user_version = 2;
        COMMIT;
      `);
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  resolveParent({ termId, parentId }) {
    if (parentId === null) {
      return null;
    }

    const parent = this.findById.get(parentId);
    if (!parent) {
      throw new ParentNotFoundError('parent term does not exist');
    }

    const visited = new Set();
    let current = parent;
    while (current) {
      if (current.id === termId || visited.has(current.id)) {
        throw new ParentCycleError('parent relationship would create a cycle');
      }
      visited.add(current.id);
      current = current.parent_id === null ? null : this.findById.get(current.parent_id);
    }

    return {
      id: parent.id,
      translations: JSON.parse(parent.translations_json),
    };
  }

  upsert(translations, parentId = null) {
    let transactionStarted = false;
    try {
      this.database.exec('BEGIN IMMEDIATE');
      transactionStarted = true;

      const englishKey = normalizeLookupValue(translations.en);
      const serializedTranslations = JSON.stringify(translations);
      const existing = this.findByEnglish.get(englishKey);
      const created = !existing;
      const parent = this.resolveParent({ termId: existing?.id, parentId });
      const termId = existing
        ? (this.updateTerm.run(serializedTranslations, parentId, existing.id), existing.id)
        : Number(this.insertTerm.run(englishKey, serializedTranslations, parentId).lastInsertRowid);

      this.deleteTranslations.run(termId);
      for (const [languageTag, value] of Object.entries(translations)) {
        this.insertTranslation.run(termId, languageTag, normalizeLookupValue(value));
      }

      this.database.exec('COMMIT');
      transactionStarted = false;
      return { id: termId, translations, parentId, parent, created };
    } catch (error) {
      if (transactionStarted) {
        this.database.exec('ROLLBACK');
      }
      throw error;
    }
  }

  find({ value, from }) {
    const row = this.findTranslation.get(from, normalizeLookupValue(value));
    if (!row) {
      return null;
    }

    return {
      id: row.id,
      translations: JSON.parse(row.translations_json),
      parentId: row.parent_id ?? null,
      parent: row.parent_term_id === null
        ? null
        : {
          id: row.parent_term_id,
          translations: JSON.parse(row.parent_translations_json),
        },
    };
  }
}

module.exports = {
  ParentCycleError,
  ParentNotFoundError,
  TermRepository,
  normalizeLookupValue,
};
