'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

function initDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      file_id      TEXT PRIMARY KEY,
      filename     TEXT NOT NULL,
      size         INTEGER NOT NULL,
      sha256       TEXT,
      storage_path TEXT NOT NULL,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS minute_stats (
      minute              INTEGER NOT NULL,
      file_id             TEXT NOT NULL,
      requests            INTEGER NOT NULL DEFAULT 0,
      downloads_started   INTEGER NOT NULL DEFAULT 0,
      downloads_completed INTEGER NOT NULL DEFAULT 0,
      bytes_sent          INTEGER NOT NULL DEFAULT 0,
      s2xx                INTEGER NOT NULL DEFAULT 0,
      s4xx                INTEGER NOT NULL DEFAULT 0,
      s5xx                INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (minute, file_id)
    );

    CREATE INDEX IF NOT EXISTS idx_minute_stats_minute ON minute_stats(minute);

    CREATE TABLE IF NOT EXISTS pulls (
      pull_id          TEXT PRIMARY KEY,
      source_url       TEXT NOT NULL,
      filename         TEXT NOT NULL,
      expected_sha256  TEXT,
      expected_size    INTEGER,
      status           TEXT NOT NULL DEFAULT 'pulling',
      bytes_downloaded INTEGER NOT NULL DEFAULT 0,
      file_id          TEXT NOT NULL,
      error            TEXT,
      attempts         INTEGER NOT NULL DEFAULT 0,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      dedup_key        TEXT
    );
  `);

  // 旧库升级：pulls 增加幂等键列（新库已含）
  try {
    db.exec('ALTER TABLE pulls ADD COLUMN dedup_key TEXT');
  } catch {
    /* 列已存在 */
  }
  // 幂等键必须覆盖终态任务，并由数据库唯一约束兜底。旧版本可能已产生
  // 重复键，升级时保留最早一条，其余清空后再建索引。
  db.exec(`
    UPDATE pulls
       SET dedup_key = NULL
     WHERE dedup_key IS NOT NULL
       AND rowid NOT IN (
         SELECT MIN(rowid) FROM pulls WHERE dedup_key IS NOT NULL GROUP BY dedup_key
       );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pulls_dedup_key
      ON pulls(dedup_key) WHERE dedup_key IS NOT NULL;
  `);

  return db;
}

module.exports = { initDatabase };
