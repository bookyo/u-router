'use strict';

const express = require('express');
const { buildHealthPayload } = require('./health');
const makeDownloadRouter = require('./routes/download');
const makeAdminRouter = require('./routes/admin');
const { PullManager } = require('./pulls');

// 构建 Edge 应用（不监听端口、不起定时器），index.js 和集成测试共用
function buildApp({ config, db, stats, secret, pulls }) {
  const app = express();
  app.disable('x-powered-by');

  const pullManager =
    pulls ||
    new PullManager({
      db,
      storageDir: config.storageDir,
      allowPrivate: config.allowPrivatePull === true,
      maxConcurrent: config.pullMaxConcurrent,
      pullTimeoutMs: config.pullTimeoutMs,
      pullMaxBytes: config.pullMaxBytes,
    });

  // JSON 体解析（/api/pulls 等管理接口用）；multipart/裸流上传不受影响
  app.use(express.json({ limit: '256kb' }));

  // 客户端断开导致的响应写入错误只记日志，不抛未处理 'error' 崩进程
  app.use((req, res, next) => {
    res.on('error', () => {});
    next();
  });

  // 健康检查始终开放（总控探活用），放在管理鉴权之前
  app.get('/api/health', (req, res) => {
    buildHealthPayload({ config, db })
      .then((payload) => res.json(payload))
      .catch((e) => res.status(500).json({ status: 'error', error: e.message }));
  });

  app.use('/d', makeDownloadRouter({ config, db, stats, secret }));
  app.use(makeAdminRouter({ config, db, stats, secret, pulls: pullManager }));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) {
      console.error(new Date().toISOString(), `[error] ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    }
    const message =
      status >= 500 && process.env.NODE_ENV === 'production' ? 'internal error' : err.message || 'internal error';
    res.status(status).json({ error: message });
  });

  return app;
}

module.exports = buildApp;
