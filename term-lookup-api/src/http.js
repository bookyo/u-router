const { ApiError } = require('./errors');

function sendJson(response, status, payload) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(payload));
}

function sendError(response, error) {
  if (error instanceof ApiError) {
    const payload = { error: error.error };
    if (error.error === 'validation_error') payload.message = error.message;
    if (Number.isSafeInteger(error.index) && error.index >= 0) payload.index = error.index;
    sendJson(response, error.status, payload);
  } else if (error?.code === 'ERR_SQLITE_ERROR' && error.errcode === 2067) {
    sendJson(response, 409, { error: 'slug_conflict' });
  } else {
    console.error('term operation failed', error?.code || error?.name || 'unknown_error');
    sendJson(response, 500, { error: 'storage_error' });
  }
}

function readJson(request, response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    function fail(error) {
      if (settled) return;
      settled = true;
      reject(error);
    }
    request.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        response.setHeader('connection', 'close');
        request.pause();
        fail(new ApiError(413, 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      try {
        const payload = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
        settled = true;
        resolve(payload);
      } catch { fail(new ApiError(400, 'invalid_json')); }
    });
    request.on('error', () => fail(new ApiError(400, 'invalid_request')));
    request.on('aborted', () => fail(new ApiError(400, 'invalid_request')));
  });
}

module.exports = { sendJson, sendError, readJson };
