const { timingSafeEqual } = require('node:crypto');
const { TermRepository } = require('./term-repository');
const { ApiError } = require('./errors');
const { sendJson, sendError, readJson } = require('./http');
const { fields, legacyNames, legacyLanguage, query } = require('./validation');
const { handleV2 } = require('./v2-routes');
const { ReadRateLimiter, trustedIps, clientIp, LIMIT } = require('./rate-limit');

function hasValidApiKey(request, apiKey) {
  const supplied = request.headers['x-api-key'] || request.headers.authorization?.replace(/^Bearer\s+/i, '');
  if (typeof supplied !== 'string') return false;
  const candidate = Buffer.from(supplied);
  const expected = Buffer.from(apiKey);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function validateTranslations(value) {
  try { legacyNames(value); return null; } catch (error) { return error.message; }
}

function parseParentId(payload) {
  if (!Object.hasOwn(payload, 'parentId') || payload.parentId === null) return { parentId: null };
  if (!Number.isSafeInteger(payload.parentId) || payload.parentId < 1) return { error: 'parentId must be a positive integer or null' };
  return { parentId: payload.parentId };
}

function createApp({ apiKey, databasePath, trustedProxyIps = [], now = Date.now }) {
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('apiKey is required');
  const proxies = trustedIps(trustedProxyIps);
  const limiter = new ReadRateLimiter({ now });
  const repository = new TermRepository(databasePath);

  async function handle(request, response) {
    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/health') { sendJson(response, 200, { status: 'ok' }); return; }
    if (url.pathname.startsWith('/v2/') || url.pathname === '/v1/terms') {
      const validKey = hasValidApiKey(request, apiKey);
      const supplied = Object.hasOwn(request.headers, 'x-api-key') || Object.hasOwn(request.headers, 'authorization');
      if (!validKey && (supplied || request.method !== 'GET')) throw new ApiError(401, 'unauthorized');
      if (!validKey) {
        const result = limiter.consume(clientIp(request, proxies));
        response.setHeader('RateLimit-Limit', String(LIMIT));
        response.setHeader('RateLimit-Remaining', String(result.remaining));
        if (!result.allowed) {
          response.setHeader('Retry-After', String(result.retryAfter));
          throw new ApiError(429, 'rate_limited');
        }
      }
    }
    if (url.pathname.startsWith('/v2/')) { await handleV2(request, response, url, repository); return; }
    if (url.pathname === '/v1/terms') {
      if (request.method === 'POST') {
        query(url.searchParams, []);
        const payload = await readJson(request, response, 64 * 1024);
        fields(payload, ['translations', 'parentId']);
        legacyNames(payload.translations);
        const parent = parseParentId(payload);
        if (parent.error) throw new ApiError(400, 'validation_error', parent.error);
        const { created, ...term } = repository.upsert(payload.translations, parent.parentId);
        sendJson(response, created ? 201 : 200, term);
        return;
      }
      if (request.method === 'GET') {
        const params = url.searchParams;
        query(params, ['q', 'from', 'to']);
        const value = params.get('q');
        if (!value?.trim() || !params.has('from') || !params.has('to')) throw new ApiError(400, 'invalid_query');
        const from = legacyLanguage(params.get('from'));
        const to = legacyLanguage(params.get('to'));
        const term = repository.find({ value, from });
        if (!term) throw new ApiError(404, 'term_not_found');
        sendJson(response, 200, { ...term, source: from, target: to, translation: term.translations[to] ?? null });
        return;
      }
    }
    throw new ApiError(404, 'not_found');
  }

  const app = (request, response) => { handle(request, response).catch((error) => {
    if (!response.destroyed && !response.headersSent) sendError(response, error);
  }); };
  app.close = () => repository.database.close();
  return app;
}

module.exports = { createApp, parseParentId, validateTranslations };
