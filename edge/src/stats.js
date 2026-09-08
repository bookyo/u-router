'use strict';

// 分钟级统计：内存计数器累积，flush 时按 (minute, file_id) 桶 UPSERT 进 SQLite。
// 总控每分钟拉一次 /api/stats?since=...，避免每次下载都打总控。

const STAT_FIELDS = Object.freeze([
  'requests',
  'downloads_started',
  'downloads_completed',
  'bytes_sent',
  's2xx',
  's4xx',
  's5xx',
]);

class MinuteStats {
  constructor(db) {
    this.db = db;
    this.pending = new Map(); // `${minute}|${file_id}` -> { minute, file_id, ...deltas }

    const cols = ['minute', 'file_id', ...STAT_FIELDS];
    const placeholders = cols.map(() => '?').join(', ');
    const updates = STAT_FIELDS.map((f) => `${f} = ${f} + excluded.${f}`).join(', ');
    this.upsertStmt = db.prepare(
      `INSERT INTO minute_stats (${cols.join(', ')}) VALUES (${placeholders})
       ON CONFLICT(minute, file_id) DO UPDATE SET ${updates}`,
    );
    this.selectSinceStmt = db.prepare(
      'SELECT * FROM minute_stats WHERE minute >= ? ORDER BY minute ASC, file_id ASC LIMIT 10000',
    );
  }

  nowMinute() {
    return Math.floor(Date.now() / 60000);
  }

  // minute 可省略（默认当前分钟），测试时可显式传入
  bump(fileId, field, n = 1, minute = this.nowMinute()) {
    if (!STAT_FIELDS.includes(field)) {
      throw new Error(`未知统计字段: ${field}`);
    }
    const key = `${minute}|${fileId}`;
    const bucket = this.pending.get(key) || { minute, file_id: fileId };
    bucket[field] = (bucket[field] || 0) + n;
    this.pending.set(key, bucket);
  }

  flush() {
    if (this.pending.size === 0) return;
    const rows = [...this.pending.values()];
    const tx = this.db.transaction((list) => {
      for (const r of list) {
        this.upsertStmt.run(r.minute, r.file_id, ...STAT_FIELDS.map((f) => r[f] || 0));
      }
    });
    // better-sqlite3 事务同步执行：先落库，成功后才清理内存；
    // 失败抛出时 pending 完整保留，下个周期重试（否则磁盘异常会静默丢统计）
    tx(rows);
    this.pending.clear();
  }

  rowsSince(minute) {
    return this.selectSinceStmt.all(minute);
  }
}

module.exports = { MinuteStats, STAT_FIELDS };
