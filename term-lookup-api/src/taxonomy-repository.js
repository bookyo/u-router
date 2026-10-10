const { ApiError } = require('./errors');
const { transaction } = require('./schema');
const { ancestorRows } = require('./hierarchy');
const { taxonomyPayload } = require('./validation');

const TABLES = { types: 'term_types', tags: 'tags', categories: 'categories' };

class TaxonomyRepository {
  constructor(database) { this.database = database; }

  table(kind) {
    const table = TABLES[kind];
    if (!table) throw new ApiError(404, 'not_found');
    return table;
  }

  row(kind, id) { return this.database.prepare(`SELECT * FROM ${this.table(kind)} WHERE id=?`).get(id); }

  require(kind, id) {
    const row = this.row(kind, id);
    if (!row) throw new ApiError(404, `${kind === 'categories' ? 'category' : kind.slice(0, -1)}_not_found`);
    return row;
  }

  summary(row) { return { id: row.id, slug: row.slug, translations: JSON.parse(row.translations_json) }; }

  format(kind, row) {
    const result = this.summary(row);
    if (kind === 'categories') {
      result.parentId = row.parent_id;
      result.ancestors = ancestorRows((id) => this.row(kind, id), row.parent_id, row.id).map((parent) => this.summary(parent));
    }
    return result;
  }

  get(kind, id) { return this.format(kind, this.require(kind, id)); }

  list(kind, { limit = 20, offset = 0, parentId } = {}) {
    const table = this.table(kind);
    const args = [];
    let where = '';
    if (parentId !== undefined) { where = ' WHERE parent_id IS ?'; args.push(parentId); }
    const total = this.database.prepare(`SELECT COUNT(*) AS n FROM ${table}${where}`).get(...args).n;
    const rows = this.database.prepare(`SELECT * FROM ${table}${where} ORDER BY id LIMIT ? OFFSET ?`).all(...args, limit, offset);
    return { items: rows.map((row) => this.format(kind, row)), total, limit, offset };
  }

  create(kind, payload) {
    const value = taxonomyPayload(kind, payload);
    return transaction(this.database, () => {
      if (kind === 'categories') ancestorRows((id) => this.row(kind, id), value.parentId ?? null);
      const columns = kind === 'categories' ? 'slug,translations_json,parent_id' : 'slug,translations_json';
      const args = [value.slug, JSON.stringify(value.translations)];
      if (kind === 'categories') args.push(value.parentId ?? null);
      const id = Number(this.database.prepare(`INSERT INTO ${this.table(kind)} (${columns}) VALUES (${args.map(() => '?')})`).run(...args).lastInsertRowid);
      return this.get(kind, id);
    });
  }

  patch(kind, id, payload) {
    return transaction(this.database, () => {
      const row = this.require(kind, id);
      const value = taxonomyPayload(kind, payload, true);
      if (kind === 'types' && row.slug === 'term' && value.slug !== undefined && value.slug !== 'term') {
        throw new ApiError(409, 'reserved_type');
      }
      const args = [value.slug ?? row.slug, JSON.stringify(value.translations ?? JSON.parse(row.translations_json))];
      let set = 'slug=?,translations_json=?';
      if (kind === 'categories') {
        const parentId = Object.hasOwn(value, 'parentId') ? value.parentId : row.parent_id;
        ancestorRows((parent) => this.row(kind, parent), parentId, id);
        set += ',parent_id=?'; args.push(parentId);
      }
      this.database.prepare(`UPDATE ${this.table(kind)} SET ${set} WHERE id=?`).run(...args, id);
      return this.get(kind, id);
    });
  }

  remove(kind, id) {
    return transaction(this.database, () => {
      const row = this.require(kind, id);
      if (kind === 'types' && row.slug === 'term') throw new ApiError(409, 'reserved_type');
      if (kind === 'types' && this.database.prepare('SELECT id FROM terms WHERE type_id=? LIMIT 1').get(id)) throw new ApiError(409, 'type_in_use');
      if (kind === 'categories' && (
        this.database.prepare('SELECT id FROM categories WHERE parent_id=? LIMIT 1').get(id)
        || this.database.prepare('SELECT term_id FROM term_categories WHERE category_id=? LIMIT 1').get(id)
      )) throw new ApiError(409, 'category_in_use');
      this.database.prepare(`DELETE FROM ${this.table(kind)} WHERE id=?`).run(id);
      return { deleted: true, id };
    });
  }
}

module.exports = { TaxonomyRepository };
