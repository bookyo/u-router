const { timingSafeEqual } = require('node:crypto');
const {
  ParentCycleError,
  ParentNotFoundError,
  TermRepository,
} = require('./term-repository');

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function hasValidApiKey(request, apiKey) {
  const supplied = request.headers['x-api-key']
    || request.headers.authorization?.replace(/^Bearer\s+/i, '');

  if (typeof supplied !== 'string' || supplied.length !== apiKey.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(supplied), Buffer.from(apiKey));
}

function validateTranslations(translations) {
  if (!translations || typeof translations !== 'object' || Array.isArray(translations)) {
    return 'translations must be an object keyed by language tag';
  }

  for (const [languageTag, value] of Object.entries(translations)) {
    if (!LANGUAGE_TAG.test(languageTag) || typeof value !== 'string' || !value.trim()) {
      return 'translations must contain non-empty string values keyed by language tag';
    }
  }

  if (typeof translations.en !== 'string' || !translations.en.trim()
    || typeof translations['zh-Hans'] !== 'string' || !translations['zh-Hans'].trim()) {
    return 'translations.en and translations.zh-Hans are required';
  }

  return null;
}

function parseParentId(payload) {
  if (!Object.hasOwn(payload, 'parentId') || payload.parentId === null) {
    return { parentId: null };
  }

  if (!Number.isSafeInteger(payload.parentId) || payload.parentId < 1) {
    return { error: 'parentId must be a positive integer or null' };
  }

  return { parentId: payload.parentId };
}

function sendRepositoryError(response, error) {
  if (error instanceof ParentNotFoundError) {
    sendJson(response, 400, { error: 'parent_not_found' });
    return;
  }

  if (error instanceof ParentCycleError) {
    sendJson(response, 400, { error: 'parent_cycle' });
    return;
  }

  if (error?.code === 'ERR_SQLITE_ERROR' && error.errcode === 2067) {
    sendJson(response, 409, { error: 'term_conflict' });
    return;
  }

  console.error('term repository operation failed', error?.code || error?.name || 'unknown_error');
  sendJson(response, 500, { error: 'storage_error' });
}

function createApp({ apiKey, databasePath }) {
  if (!apiKey) {
    throw new Error('apiKey is required');
  }

  const repository = new TermRepository(databasePath);

  return (request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/v1/terms') {
      if (!hasValidApiKey(request, apiKey)) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }

      let body = '';
      let bodyBytes = 0;
      let rejectedForSize = false;
      request.setEncoding('utf8');
      request.on('data', (chunk) => {
        if (rejectedForSize) {
          return;
        }

        bodyBytes += Buffer.byteLength(chunk);
        if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
          rejectedForSize = true;
          request.pause();
          response.setHeader('connection', 'close');
          sendJson(response, 413, { error: 'payload_too_large' });
          return;
        }

        body += chunk;
      });
      request.on('end', () => {
        if (rejectedForSize) {
          return;
        }

        let payload;
        try {
          payload = JSON.parse(body);
        } catch {
          sendJson(response, 400, { error: 'invalid_json' });
          return;
        }

        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
          sendJson(response, 400, { error: 'validation_error', message: 'request body must be an object' });
          return;
        }

        const validationError = validateTranslations(payload.translations);
        if (validationError) {
          sendJson(response, 400, { error: 'validation_error', message: validationError });
          return;
        }

        const parent = parseParentId(payload);
        if (parent.error) {
          sendJson(response, 400, { error: 'validation_error', message: parent.error });
          return;
        }

        try {
          const { created, ...term } = repository.upsert(payload.translations, parent.parentId);
          sendJson(response, created ? 201 : 200, term);
        } catch (error) {
          sendRepositoryError(response, error);
        }
      });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/v1/terms') {
      if (!hasValidApiKey(request, apiKey)) {
        sendJson(response, 401, { error: 'unauthorized' });
        return;
      }

      const value = requestUrl.searchParams.get('q');
      const from = requestUrl.searchParams.get('from');
      const to = requestUrl.searchParams.get('to');
      if (!value || !from || !to || !LANGUAGE_TAG.test(from) || !LANGUAGE_TAG.test(to)) {
        sendJson(response, 400, { error: 'invalid_query' });
        return;
      }

      let term;
      try {
        term = repository.find({ value, from });
      } catch (error) {
        sendRepositoryError(response, error);
        return;
      }
      if (!term) {
        sendJson(response, 404, { error: 'term_not_found' });
        return;
      }

      sendJson(response, 200, {
        ...term,
        source: from,
        target: to,
        translation: term.translations[to] ?? null,
      });
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  };
}

module.exports = { createApp, parseParentId, validateTranslations };
