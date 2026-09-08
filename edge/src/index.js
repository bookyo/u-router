'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const config = require('./config');
const { initDatabase } = require('./db');
const { MinuteStats } = require('./stats');
const { PullManager } = require('./pulls');
const buildApp = require('./app');

const log = (...args) => console.log(new Date().toISOString(), ...args);

let secret = config.tokenSecret;
if (!secret) {
  secret = crypto.randomBytes(24).toString('hex');
  log('[edge] 警告：未设置 TOKEN_SECRET，已生成临时密钥。重启后本机已签发链接全部失效，且总控签发的链接无法通过校验');
}
if (!config.apiKey) {
  log('[edge] ⚠️  未设置 EDGE_API_KEY：上传/删除/统计接口完全开放，仅限开发环境使用');
}

fs.mkdirSync(config.storageDir, { recursive: true });
const db = initDatabase(config.dbPath);
const stats = new MinuteStats(db);

setInterval(() => {
  try {
    stats.flush();
  } catch (e) {
    log(`[stats] flush 失败: ${e.message}`);
  }
}, config.statsFlushIntervalMs).unref?.();

const pulls = new PullManager({
  db,
  storageDir: config.storageDir,
  log,
  allowPrivate: config.allowPrivatePull,
  maxConcurrent: config.pullMaxConcurrent,
  pullTimeoutMs: config.pullTimeoutMs,
  pullMaxBytes: config.pullMaxBytes,
});
// 重启恢复：把中断时还在 pulling/queued 的任务重新拉起（或对耗尽重试的判失败）
pulls.recover();

const app = buildApp({ config, db, stats, secret, pulls });
const server = app.listen(config.port, () =>
  log(`[edge] ${config.edgeId} 监听 :${config.port}（存储目录 ${config.storageDir}）`),
);
// 大文件上传（以及客户端到 Edge 的慢速传输）可能远超 Node 默认的 5 分钟请求超时
server.requestTimeout = 0;

let closing = false;
const shutdown = (sig) => {
  if (closing) return;
  closing = true;
  log(`[edge] 收到 ${sig}，正在退出…`);
  server.close();
  try {
    stats.flush();
  } catch {}
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
