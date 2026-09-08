'use strict';

const os = require('node:os');
const fs = require('node:fs');

// GET /api/health 响应载荷：总控每 10~30 秒探活一次
async function buildHealthPayload({ config: cfg, db }) {
  let disk = null;
  try {
    const s = await fs.promises.statfs(cfg.storageDir);
    disk = {
      free_bytes: s.bsize * s.bavail,
      total_bytes: s.bsize * s.blocks,
    };
  } catch {
    /* statfs 不可用时置空 */
  }
  const [m1, m5, m15] = os.loadavg();
  const row = db.prepare('SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM files').get();
  return {
    status: 'ok',
    edge_id: cfg.edgeId,
    version: cfg.version,
    uptime_sec: Math.floor(process.uptime()),
    now: new Date().toISOString(),
    load: { m1, m5, m15 },
    memory: {
      rss_bytes: process.memoryUsage().rss,
      total_bytes: os.totalmem(),
      free_bytes: os.freemem(),
    },
    disk,
    files: row.files,
    storage_bytes: row.bytes,
  };
}

module.exports = { buildHealthPayload };
