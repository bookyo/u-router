const { ApiError } = require('./errors');
const { readJson, sendJson } = require('./http');
const { filters, query, integerQuery, language } = require('./validation');
const { renderContent } = require('./content');
const { importTerms } = require('./term-import');

async function handleV2(request, response, url, repository) {
  const match = /^\/v2\/(terms|types|tags|categories)(?:\/([^/]+))?(?:\/([^/]+))?$/.exec(url.pathname);
  if (!match) throw new ApiError(404, 'not_found');
  const [, kind, rawId, action] = match;
  if (kind === 'terms' && rawId === 'import' && !action) {
    if (request.method !== 'POST') throw new ApiError(404, 'not_found');
    query(url.searchParams, []);
    const payload = await readJson(request, response, 2 * 1024 * 1024);
    sendJson(response, 200, importTerms(repository, payload));
    return;
  }
  const id = rawId === undefined ? undefined : integerQuery(rawId, 1);
  const method = request.method;
  const params = url.searchParams;
  const taxonomy = repository.taxonomy;
  const body = () => readJson(request, response, 2 * 1024 * 1024);
  const send = (value, status = 200) => sendJson(response, status, value);

  if (id === undefined) {
    if (method === 'GET') {
      const options = filters(params, kind);
      send(kind === 'terms' ? repository.list(options) : taxonomy.list(kind, options));
      return;
    }
    query(params, []);
    if (method === 'POST') {
      const payload = await body();
      send(kind === 'terms' ? repository.create(payload) : taxonomy.create(kind, payload), 201);
      return;
    }
  } else if (kind === 'terms' && action) {
    repository.require(id);
    if (method === 'GET' && action === 'children') {
      const options = filters(params, 'terms');
      // The route fixes the parent; never allow a query parameter to silently override it.
      if (params.has('parentId')) throw new ApiError(400, 'invalid_query');
      send(repository.list({ ...options, parentId: id }));
      return;
    }
    if (method === 'GET' && action === 'ancestors') {
      query(params, []);
      send({ items: repository.ancestors(id) });
      return;
    }
    if (method === 'GET' && action === 'content') {
      query(params, ['language']);
      const lang = language(params.get('language'));
      const detail = repository.get(id).details[lang];
      if (!detail) throw new ApiError(404, 'content_not_found');
      send({ id, language: lang, ...detail, format: 'markdown', html: renderContent(detail.body) });
      return;
    }
    query(params, []);
    if (action === 'names' && ['POST', 'DELETE'].includes(method)) {
      send(repository.changeName(id, await body(), method === 'DELETE'));
      return;
    }
  } else if (id !== undefined && !action) {
    query(params, []);
    if (kind === 'terms') repository.require(id);
    else taxonomy.require(kind, id);
    if (method === 'GET') { send(kind === 'terms' ? repository.get(id) : taxonomy.get(kind, id)); return; }
    if (method === 'PATCH') {
      const payload = await body();
      send(kind === 'terms' ? repository.patch(id, payload) : taxonomy.patch(kind, id, payload));
      return;
    }
    if (method === 'DELETE') { send(kind === 'terms' ? repository.remove(id) : taxonomy.remove(kind, id)); return; }
  }
  throw new ApiError(404, 'not_found');
}

module.exports = { handleV2 };
