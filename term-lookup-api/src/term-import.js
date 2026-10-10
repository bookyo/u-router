const { ApiError } = require('./errors');
const { fields, invalid, termPayload, normalizeLookupValue } = require('./validation');

function indexedError(error, index) {
  // SQL errors can contain private data. Never return their messages to the client.
  const result = error instanceof ApiError ? error : new ApiError(500, 'storage_error');
  result.index = index;
  return result;
}

function importPayload(payload) {
  fields(payload, ['items', 'dryRun']);
  if (!Array.isArray(payload.items) || payload.items.length < 1 || payload.items.length > 100) {
    invalid('items requires 1–100 entries');
  }
  if (Object.hasOwn(payload, 'dryRun') && typeof payload.dryRun !== 'boolean') invalid('dryRun must be boolean');
  const keys = new Set();
  const items = payload.items.map((item, index) => {
    try {
      fields(item, ['source', 'externalId', 'term'], 'import item');
      if (typeof item.source !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(item.source)) {
        invalid('source must be a lowercase slug of 1–64 characters');
      }
      if (typeof item.externalId !== 'string' || !item.externalId.trim() || item.externalId.length > 256
        || item.externalId !== item.externalId.trim() || /[\u0000-\u001f\u007f]/.test(item.externalId)) {
        invalid('externalId must be non-empty text of at most 256 characters without padding or control characters');
      }
      const key = JSON.stringify([item.source, item.externalId]);
      if (keys.has(key)) invalid('duplicate source + externalId in batch');
      keys.add(key);
      return { source: item.source, externalId: item.externalId, term: termPayload(item.term) };
    } catch (error) { throw indexedError(error, index); }
  });
  return { items, dryRun: payload.dryRun ?? false };
}

function appendTranslations(current, incoming) {
  const result = { ...current };
  for (const [language, names] of Object.entries(incoming)) {
    const merged = [...(current[language] ?? [])];
    const seen = new Set(merged.map(normalizeLookupValue));
    for (const name of names) {
      const normalized = normalizeLookupValue(name);
      if (!seen.has(normalized)) { merged.push(name); seen.add(normalized); }
    }
    result[language] = merged;
  }
  // Validation must not silently reformat existing locally maintained names.
  termPayload({ translations: result });
  return result;
}

function importTerms(repository, payload) {
  const { items, dryRun } = importPayload(payload);
  const database = repository.database;
  const result = { dryRun, created: 0, updated: 0, unchanged: 0, items: [] };
  database.exec('BEGIN IMMEDIATE');
  try {
    const lookup = database.prepare('SELECT term_id FROM term_import_keys WHERE source=? AND external_id=?');
    const insert = database.prepare('INSERT INTO term_import_keys (source,external_id,term_id) VALUES (?,?,?)');
    for (const [index, item] of items.entries()) {
      try {
        const mapping = lookup.get(item.source, item.externalId);
        let id, status;
        if (!mapping) {
          const term = repository.write(undefined, { type: 'term', details: {}, cover: null,
            sources: [], parentId: null, tagIds: [], categoryIds: [], ...item.term });
          id = term.id;
          insert.run(item.source, item.externalId, id);
          status = 'created';
        } else {
          id = mapping.term_id;
          const current = repository.get(id);
          if (item.term.type !== undefined && item.term.type !== current.type) {
            throw new ApiError(409, 'import_type_conflict');
          }
          // Validate supplied references even though existing metadata is never overwritten.
          repository.validateRelations({ ...current, ...item.term }, id);
          const translations = appendTranslations(current.translations, item.term.translations);
          if (JSON.stringify(translations) === JSON.stringify(current.translations)) status = 'unchanged';
          else { repository.write(id, { ...current, translations }); status = 'updated'; }
        }
        result[status]++;
        result.items.push({ index, source: item.source, externalId: item.externalId, id, status });
      } catch (error) { throw indexedError(error, index); }
    }
    // Exercise exactly the same constraints for previews, but persist nothing (including sequences).
    database.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { importTerms };
