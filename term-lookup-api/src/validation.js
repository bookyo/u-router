const { ApiError } = require('./errors');

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,63})$/;
const REQUIRED_LANGUAGES = ['en', 'zh-Hans'];
const TERM_FIELDS = ['type', 'translations', 'details', 'cover', 'sources', 'parentId', 'tagIds', 'categoryIds'];

function invalid(message) { throw new ApiError(400, 'validation_error', message); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object`);
}
function fields(value, allowed, name = 'payload') {
  object(value, name);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`${name}: unknown field ${key}`);
}
function text(value, name, max, nonempty = false) {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) {
    invalid(`${name} must be ${nonempty ? 'non-empty ' : ''}text of at most ${max} characters`);
  }
  return value;
}
function language(value) {
  if (typeof value !== 'string' || !LANGUAGE_TAG.test(value)) invalid('invalid language tag');
  try { return Intl.getCanonicalLocales(value)[0]; } catch { invalid('invalid language tag'); }
}
function languageMap(value, name, convert) {
  object(value, name);
  const entries = Object.entries(value);
  if (entries.length > 50) invalid(`${name} supports at most 50 languages`);
  const result = {};
  for (const [key, entry] of entries) {
    const canonical = language(key);
    if (Object.hasOwn(result, canonical)) invalid(`duplicate language ${canonical}`);
    result[canonical] = convert(entry, canonical);
  }
  return result;
}
function normalizeLookupValue(value) { return value.normalize('NFKC').trim().toLocaleLowerCase('en-US'); }
function legacyLanguage(value) {
  if (typeof value !== 'string' || !LANGUAGE_TAG.test(value)) invalid('invalid language tag');
  try { return Intl.getCanonicalLocales(value)[0]; } catch { return value; }
}

// Migration and v1 retain the historical contract: new v2 write limits are not data corruption.
function legacyNames(value, allowArrays = false) {
  object(value, 'translations');
  const result = {};
  const entries = Object.entries(value).sort(([left], [right]) =>
    Number(right === legacyLanguage(right)) - Number(left === legacyLanguage(left)));
  for (const [key, entry] of entries) {
    const lang = legacyLanguage(key);
    const names = allowArrays && Array.isArray(entry) ? entry : [entry];
    if (!names.length) invalid('empty stored language names');
    result[lang] ??= [];
    for (const name of names) {
      text(name, 'name', Number.MAX_SAFE_INTEGER, true);
      if (!result[lang].some((existing) => normalizeLookupValue(existing) === normalizeLookupValue(name))) result[lang].push(name);
    }
  }
  for (const required of REQUIRED_LANGUAGES) if (!Object.hasOwn(result, required)) invalid(`translations.${required} is required`);
  return result;
}
function translations(value, arrays = true) {
  const result = languageMap(value, 'translations', (entry, lang) => {
    if (!arrays) return text(entry, `translations.${lang}`, 256, true).trim();
    if (!Array.isArray(entry) || entry.length < 1 || entry.length > 50) invalid('each language requires 1–50 names');
    const names = entry.map((name) => text(name, 'name', 256, true).trim());
    if (new Set(names.map(normalizeLookupValue)).size !== names.length) invalid('duplicate normalized name');
    return names;
  });
  for (const required of REQUIRED_LANGUAGES) if (!Object.hasOwn(result, required)) invalid(`translations.${required} is required`);
  return result;
}
function id(value, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 1) invalid('ID must be a positive safe integer');
  return value;
}
function ids(value) {
  if (!Array.isArray(value) || value.length > 100) invalid('ID list must have at most 100 items');
  return [...new Set(value.map((item) => id(item)))];
}
function slug(value) {
  if (typeof value !== 'string' || !SLUG.test(value)) invalid('invalid slug');
  return value;
}
function url(value) {
  text(value, 'url', 2048, true);
  let parsed;
  try { parsed = new URL(value); } catch { invalid('URL must be absolute HTTP or HTTPS'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid('invalid URL protocol or credentials');
  return value;
}
function details(value, patch) {
  return languageMap(value, 'details', (entry) => {
    if (entry === null && patch) return null;
    fields(entry, ['summary', 'description', 'body', 'format'], 'details entry');
    const result = {};
    if (Object.hasOwn(entry, 'summary')) result.summary = text(entry.summary, 'summary', 2000);
    if (Object.hasOwn(entry, 'description')) result.description = text(entry.description, 'description', 20000);
    if (Object.hasOwn(entry, 'body')) {
      if (typeof entry.body !== 'string') invalid('body must be text');
      if (Buffer.byteLength(entry.body) > 512 * 1024) throw new ApiError(413, 'payload_too_large');
      result.body = entry.body;
    }
    if (Object.hasOwn(entry, 'format')) {
      if (entry.format !== 'markdown') invalid('format must be markdown');
      result.format = entry.format;
    }
    return result;
  });
}
function cover(value) {
  if (value === null) return null;
  fields(value, ['url', 'alt'], 'cover');
  const result = { url: url(value.url) };
  if (Object.hasOwn(value, 'alt')) result.alt = languageMap(value.alt, 'cover.alt', (entry) => text(entry, 'alt', 2000));
  return result;
}
function sources(value) {
  if (!Array.isArray(value) || value.length > 100) invalid('sources must have at most 100 items');
  return value.map((entry) => {
    fields(entry, ['url', 'title', 'language'], 'source');
    const result = { url: url(entry.url), title: text(entry.title, 'source.title', 2000, true) };
    if (Object.hasOwn(entry, 'language')) result.language = language(entry.language);
    return result;
  });
}
function termPayload(value, patch = false) {
  fields(value, TERM_FIELDS);
  const result = {};
  if (!patch || Object.hasOwn(value, 'translations')) result.translations = translations(value.translations);
  for (const [field, convert] of Object.entries({
    type: slug, parentId: (v) => id(v, true), tagIds: ids, categoryIds: ids,
    details: (v) => details(v, patch), cover, sources,
  })) if (Object.hasOwn(value, field)) result[field] = convert(value[field]);
  return result;
}
function taxonomyPayload(kind, value, patch = false) {
  fields(value, kind === 'categories' ? ['slug', 'translations', 'parentId'] : ['slug', 'translations']);
  const result = {};
  if (!patch || Object.hasOwn(value, 'slug')) result.slug = slug(value.slug);
  if (!patch || Object.hasOwn(value, 'translations')) result.translations = translations(value.translations, false);
  if (Object.hasOwn(value, 'parentId')) result.parentId = id(value.parentId, true);
  return result;
}
function namePayload(value, remove = false) {
  fields(value, ['language', 'value']);
  return {
    language: remove ? legacyLanguage(value.language) : language(value.language),
    value: text(value.value, 'value', remove ? Number.MAX_SAFE_INTEGER : 256, true).trim(),
  };
}
function query(params, allowed) {
  for (const key of params.keys()) {
    if (!allowed.includes(key) || params.getAll(key).length !== 1) throw new ApiError(400, 'invalid_query');
  }
}
function integerQuery(value, min, max = Number.MAX_SAFE_INTEGER) {
  if (!/^(0|[1-9]\d*)$/.test(value ?? '')) throw new ApiError(400, 'invalid_query');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new ApiError(400, 'invalid_query');
  return parsed;
}
function pagination(params) {
  return {
    limit: params.has('limit') ? integerQuery(params.get('limit'), 1, 100) : 20,
    offset: params.has('offset') ? integerQuery(params.get('offset'), 0) : 0,
  };
}
function filters(params, kind = 'terms') {
  const allowed = kind === 'terms'
    ? ['q', 'from', 'to', 'type', 'parentId', 'tagId', 'categoryId', 'limit', 'offset']
    : kind === 'categories' ? ['parentId', 'limit', 'offset'] : ['limit', 'offset'];
  query(params, allowed);
  const result = pagination(params);
  if (params.has('q') !== params.has('from')) throw new ApiError(400, 'invalid_query');
  if (params.has('q')) {
    result.q = text(params.get('q'), 'q', 256, true);
    result.from = language(params.get('from'));
  }
  if (params.has('to')) result.to = language(params.get('to'));
  if (params.has('type')) result.type = slug(params.get('type'));
  for (const key of ['parentId', 'tagId', 'categoryId']) {
    if (params.has(key)) result[key] = key === 'parentId' && params.get(key) === 'null' ? null : integerQuery(params.get(key), 1);
  }
  return result;
}

module.exports = {
  ApiError, invalid, fields, language, translations, normalizeLookupValue,
  legacyLanguage, legacyNames, termPayload, taxonomyPayload, namePayload, filters, query, integerQuery,
};
