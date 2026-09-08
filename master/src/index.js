'use strict';

const express = require('express');
const mongoose = require('mongoose');
const config = require('./config');
const { connectWithRetry } = require('./db');
const { requireApiKey } = require('./middleware');
const makeDownloadsRouter = require('./routes/downloads');
const makeFilesRouter = require('./routes/files');
const makeEdgesRouter = require('./routes/edges');
const makeMetricsRouter = require('./routes/metrics');
const makeDistributionsRouter = require('./routes/distributions');
const { DispatchRecorder } = require('./services/dispatchRecorder');
const { startHealthLoop } = require('./services/healthCheck');
const { startPassiveLoop } = require('./services/passiveHealth');
const { startStatsLoop } = require('./services/statsPuller');
const { startDistributorLoop } = require('./services/distributor');

const log = (...args) => console.log(new Date().toISOString(), ...args);

async function main() {
  await connectWithRetry(config.mongoUri, log);

  const app = express();
  app.disable('x-powered-by');

  // 总控自身健康检查对外开放（给负载均衡/监控用）
  app.get('/api/v1/health', (req, res) =>
    res.json({ status: 'ok', service: 'u-router-master', now: new Date().toISOString() }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(requireApiKey(config));

  const recorder = new DispatchRecorder(config.dispatchFlushIntervalMs, { log });
  app.use(makeDownloadsRouter({ recorder, config }));
  app.use(makeFilesRouter());
  app.use(makeEdgesRouter({ config }));
  app.use(makeMetricsRouter({ config }));
  app.use(makeDistributionsRouter({ config }));

  app.use((req, res) => res.status(404).json({ error: 'not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) log(`[error] ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    // 生产环境不回传内部错误细节
    const message =
      status >= 500 && process.env.NODE_ENV === 'production' ? 'internal error' : err.message || 'internal error';
    res.status(status).json({ error: message });
  });

  if (!config.apiKey) {
    log('[master] ⚠️  未设置 MASTER_API_KEY：所有 API（含管理接口）完全开放，仅限开发环境使用');
  }
  if (config.linksRateLimitPerMin <= 0) {
    log('[master] ⚠️  分发接口未启用限流（LINKS_RATE_LIMIT_PER_MIN=0），公网部署建议开启，防止刷 links 虚增分配量导致 Edge 被误摘除');
  }

  const server = app.listen(config.port, () => log(`[master] 监听 :${config.port}`));

  recorder.start();
  startHealthLoop(config, log);
  startPassiveLoop(config, log);
  startStatsLoop(config, log);
  startDistributorLoop(config, log);
  log('[master] 后台任务已启动：主动探活 / 被动比率判定 / Edge 统计拉取 / 文件分发编排');

  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    log(`[master] 收到 ${sig}，正在退出…`);
    server.close();
    await recorder.stop();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((e) => {
  log(`[master] 启动失败: ${e.stack || e}`);
  process.exit(1);
});
