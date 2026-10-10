const { DatabaseSync } = require('node:sqlite');
const { migrate, transaction } = require('./schema');
const { ancestorRows } = require('./hierarchy');
const { TaxonomyRepository } = require('./taxonomy-repository');
const { termPayload, namePayload, legacyNames, normalizeLookupValue, invalid } = require('./validation');
const { ApiError, ParentNotFoundError, ParentCycleError, LegacyConflictError } = require('./errors');

const COLUMNS = `t.id,t.translations_json,t.parent_id,t.created_at,t.updated_at,t.cover_json,t.sources_json,ty.slug AS type`;

function legacyTerm(value) {
  const scalar = (names) => Object.fromEntries(Object.entries(names).map(([lang, values]) => [lang, values[0]]));
  return {
    id: value.id, translations: scalar(value.translations), parentId: value.parentId,
    parent: value.parent ? { id: value.parent.id, translations: scalar(value.parent.translations) } : null,
  };
}

function mergeDetails(current, changes) {
  const result = { ...current };
  for (const [lang, value] of Object.entries(changes ?? {})) {
    if (value === null) delete result[lang];
    else result[lang] = { ...result[lang], ...value };
  }
  if (Object.keys(result).length > 50) invalid('details supports at most 50 languages');
  return result;
}

class TermRepository {
  constructor(databasePath) {
    this.database = new DatabaseSync(databasePath);
    try {
      this.database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
      migrate(this.database);
      this.taxonomy = new TaxonomyRepository(this.database);
    } catch (error) { this.database.close(); throw error; }
  }

  row(id, summary = false) {
    return this.database.prepare(`SELECT ${COLUMNS},t.${summary ? 'summaries_json' : 'details_json'} AS details_json
      FROM terms t JOIN term_types ty ON ty.id=t.type_id WHERE t.id=?`).get(id);
  }

  require(id) {
    const row = this.row(id);
    if (!row) throw new ApiError(404, 'term_not_found');
    return row;
  }

  summary(row) { return { id: row.id, type: row.type, translations: JSON.parse(row.translations_json), parentId: row.parent_id }; }

  ancestorRows(id, parentId) { return ancestorRows((parent) => this.row(parent, true), parentId, id); }

  ancestors(id) {
    const row = this.require(id);
    return this.ancestorRows(id, row.parent_id).map((parent) => this.summary(parent));
  }

  relation(kind, id) {
    const table = kind === 'tags' ? 'term_tags' : 'term_categories';
    const column = kind === 'tags' ? 'tag_id' : 'category_id';
    const rows = this.database.prepare(`SELECT x.* FROM ${kind} x JOIN ${table} r ON r.${column}=x.id
      WHERE r.term_id=? ORDER BY x.id`).all(id);
    return rows.map((row) => this.taxonomy.format(kind, row));
  }

  format(row) {
    const ancestors = this.ancestorRows(row.id, row.parent_id).map((parent) => this.summary(parent));
    const tags = this.relation('tags', row.id);
    const categories = this.relation('categories', row.id);
    return {
      ...this.summary(row), details: JSON.parse(row.details_json),
      cover: row.cover_json === null ? null : JSON.parse(row.cover_json), sources: JSON.parse(row.sources_json),
      tagIds: tags.map((tag) => tag.id), categoryIds: categories.map((category) => category.id), tags, categories,
      parent: ancestors.at(-1) ?? null, ancestors, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  get(id) { return this.format(this.require(id)); }

  validateRelations(value, id) {
    const type = this.database.prepare('SELECT id FROM term_types WHERE slug=?').get(value.type);
    if (!type) throw new ApiError(400, 'type_not_found');
    this.ancestorRows(id, value.parentId);
    for (const [kind, ids] of [['tags', value.tagIds], ['categories', value.categoryIds]]) {
      for (const reference of ids) {
        if (!this.taxonomy.row(kind, reference)) throw new ApiError(400, kind === 'tags' ? 'tag_not_found' : 'category_not_found');
      }
    }
    return type.id;
  }

  write(id, value) {
    const stored = Object.fromEntries(['type', 'translations', 'details', 'cover', 'sources', 'parentId', 'tagIds', 'categoryIds']
      .map((field) => [field, value[field]]));
    if (Buffer.byteLength(JSON.stringify(stored)) > 2 * 1024 * 1024) throw new ApiError(413, 'payload_too_large');
    const typeId = this.validateRelations(value, id);
    const summaries = Object.fromEntries(Object.entries(value.details).map(([lang, detail]) => [lang,
      Object.hasOwn(detail, 'summary') ? { summary: detail.summary } : {},
    ]));
    const args = [normalizeLookupValue(value.translations.en[0]), JSON.stringify(value.translations), typeId,
      JSON.stringify(value.details), JSON.stringify(summaries), value.cover === null ? null : JSON.stringify(value.cover),
      JSON.stringify(value.sources), value.parentId];
    if (id === undefined) {
      id = Number(this.database.prepare(`INSERT INTO terms
        (english_key,translations_json,type_id,details_json,summaries_json,cover_json,sources_json,parent_id)
        VALUES (?,?,?,?,?,?,?,?)`).run(...args).lastInsertRowid);
    } else {
      this.database.prepare(`UPDATE terms SET english_key=?,translations_json=?,type_id=?,details_json=?,summaries_json=?,
        cover_json=?,sources_json=?,parent_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(...args, id);
    }
    this.database.prepare('DELETE FROM term_translations WHERE term_id=?').run(id);
    const insert = this.database.prepare('INSERT INTO term_translations VALUES (?,?,?)');
    for (const [lang, names] of Object.entries(value.translations)) {
      for (const name of names) insert.run(id, lang, normalizeLookupValue(name));
    }
    for (const [table, column, ids] of [['term_tags', 'tag_id', value.tagIds], ['term_categories', 'category_id', value.categoryIds]]) {
      this.database.prepare(`DELETE FROM ${table} WHERE term_id=?`).run(id);
      const insertRelation = this.database.prepare(`INSERT INTO ${table} (term_id,${column}) VALUES (?,?)`);
      for (const reference of ids) insertRelation.run(id, reference);
    }
    return this.get(id);
  }

  create(payload) {
    const value = termPayload(payload);
    return transaction(this.database, () => this.write(undefined, {
      type: 'term', details: {}, cover: null, sources: [], parentId: null, tagIds: [], categoryIds: [], ...value,
    }));
  }

  patch(id, payload) {
    return transaction(this.database, () => {
      const current = this.get(id);
      const patch = termPayload(payload, true);
      return this.write(id, { ...current, ...patch, details: mergeDetails(current.details, patch.details) });
    });
  }

  list({ limit = 20, offset = 0, q, from, to, type, parentId, tagId, categoryId } = {}) {
    const clauses = [];
    const args = [];
    if (q !== undefined) {
      clauses.push('EXISTS (SELECT 1 FROM term_translations n WHERE n.term_id=t.id AND n.language_tag=? AND n.normalized_value=?)');
      args.push(from, normalizeLookupValue(q));
    }
    if (type !== undefined) { clauses.push('ty.slug=?'); args.push(type); }
    if (parentId !== undefined) { clauses.push('t.parent_id IS ?'); args.push(parentId); }
    if (tagId !== undefined) { clauses.push('EXISTS (SELECT 1 FROM term_tags r WHERE r.term_id=t.id AND r.tag_id=?)'); args.push(tagId); }
    if (categoryId !== undefined) { clauses.push('EXISTS (SELECT 1 FROM term_categories r WHERE r.term_id=t.id AND r.category_id=?)'); args.push(categoryId); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const source = `FROM terms t JOIN term_types ty ON ty.id=t.type_id${where}`;
    const total = this.database.prepare(`SELECT COUNT(*) AS n ${source}`).get(...args).n;
    const rows = this.database.prepare(`SELECT ${COLUMNS},t.summaries_json AS details_json ${source} ORDER BY t.id LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const items = rows.map((row) => {
      const item = this.format(row);
      if (to !== undefined) { item.source = from ?? null; item.target = to; item.translation = item.translations[to] ?? null; }
      return item;
    });
    return { items, total, limit, offset };
  }

  remove(id) {
    return transaction(this.database, () => {
      this.require(id);
      if (this.database.prepare('SELECT id FROM terms WHERE parent_id=? LIMIT 1').get(id)) throw new ApiError(409, 'term_has_children');
      this.database.prepare('DELETE FROM terms WHERE id=?').run(id);
      return { deleted: true, id };
    });
  }

  changeName(id, payload, remove = false) {
    return transaction(this.database, () => {
      const current = this.get(id);
      const { language, value } = namePayload(payload, remove);
      const names = current.translations[language] ?? [];
      const index = names.findIndex((name) => normalizeLookupValue(name) === normalizeLookupValue(value));
      if (remove) {
        if (index === -1) throw new ApiError(404, 'name_not_found');
        if (['en', 'zh-Hans'].includes(language) && names.length === 1) invalid('cannot remove last required name');
        names.splice(index, 1);
        if (!names.length) delete current.translations[language];
      } else {
        if (index !== -1) return current;
        if (names.length >= 50) invalid('each language supports at most 50 names');
        if (!Object.hasOwn(current.translations, language) && Object.keys(current.translations).length >= 50) {
          invalid('translations supports at most 50 languages');
        }
        current.translations[language] = [...names, value];
      }
      return this.write(id, current);
    });
  }

  matching(value, from) {
    return this.database.prepare(`SELECT t.id,ty.slug AS type FROM terms t JOIN term_types ty ON ty.id=t.type_id
      JOIN term_translations n ON n.term_id=t.id WHERE n.language_tag=? AND n.normalized_value=? ORDER BY t.id`).all(from, normalizeLookupValue(value));
  }

  upsert(input, parentId = null) {
    const submitted = legacyNames(input);
    return transaction(this.database, () => {
      const matches = this.matching(submitted.en[0], 'en');
      if (matches.length > 1) throw new LegacyConflictError('ambiguous_term');
      if (matches.length && matches[0].type !== 'term') throw new LegacyConflictError();
      const existing = matches.length ? this.get(matches[0].id) : null;
      const names = { ...(existing?.translations ?? {}) };
      for (const [lang, submittedNames] of Object.entries(submitted)) {
        const value = submittedNames[0];
        const previous = names[lang] ?? [];
        const aliases = normalizeLookupValue(previous[0] ?? '') === normalizeLookupValue(value) ? previous.slice(1) : previous;
        const seen = new Set();
        names[lang] = [...submittedNames, ...aliases].filter((name) => {
          const normalized = normalizeLookupValue(name);
          if (seen.has(normalized)) return false;
          seen.add(normalized);
          return true;
        });
      }
      for (const [lang, values] of Object.entries(submitted)) {
        for (const value of values) {
          if (this.matching(value, lang).some((row) => row.id !== existing?.id)) throw new LegacyConflictError();
        }
      }
      const value = this.write(existing?.id, {
        type: 'term', details: {}, cover: null, sources: [], tagIds: [], categoryIds: [],
        ...existing, translations: names, parentId,
      });
      return { ...legacyTerm(value), created: !existing };
    });
  }

  find({ value, from }) {
    const matches = this.matching(value, from);
    if (matches.length > 1) throw new LegacyConflictError('ambiguous_term');
    return matches.length ? legacyTerm(this.get(matches[0].id)) : null;
  }
}

module.exports = { TermRepository, ParentNotFoundError, ParentCycleError, normalizeLookupValue };
