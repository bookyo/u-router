'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const Busboy = require('busboy');
const { sign } = require('../token');
const { ah } = require('../middleware');

const newFileId = () => `f_${crypto.randomBytes(8).toString('hex')}`;

// 常数时间比较，避免逐字节泄露密钥
function secretEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  return ba.length > 0 && ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// 把上传流写入 storageDir，边写边算大小和 sha256；超限或出错时清理半成品文件。
// 监听 aborted/close（客户端断开时 Node 的请求流发的是这两个事件而不是 error），
// 否则 write stream 悬挂、半成品文件永久留在磁盘上。
// 删除时机在写流彻底 close 之后：open 是异步的，立即 unlink 可能先于文件创建，
// 随后 open 完成反而把孤儿文件落盘（时序竞态）。
function saveStream(stream, { storageDir, maxBytes, lifecycle = null } = {}) {
  return new Promise((resolve, reject) => {
    const fileId = newFileId();
    const storagePath = path.join(storageDir, `${fileId}.bin`);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let settled = false;
    let ended = false;
    let needCleanup = false;

    const out = fs.createWriteStream(storagePath);
    const fail = (err) => {
      if (settled) return;
      settled = true;
      needCleanup = true;
      out.destroy();
      stream.destroy();
      reject(err);
    };

    stream.on('data', (chunk) => {
      size += chunk.length;
      hash.update(chunk);
      if (maxBytes && size > maxBytes) {
        const err = new Error('文件超过大小限制');
        err.status = 413;
        fail(err);
      }
    });
    stream.on('end', () => {
      ended = true;
    });
    stream.on('aborted', () => {
      const err = new Error('客户端中断上传');
      err.status = 400;
      fail(err);
    });
    stream.on('close', () => {
      if (!settled && !ended) {
        const err = new Error('客户端中断上传');
        err.status = 400;
        fail(err);
      }
    });
    stream.on('error', fail);
    if (lifecycle && lifecycle.req) {
      lifecycle.req.on('aborted', () => {
        const err = new Error('客户端中断上传');
        err.status = 400;
        fail(err);
      });
    }
    out.on('error', fail);
    out.on('close', () => {
      if (settled) {
        if (needCleanup) fs.unlink(storagePath, () => {});
        return;
      }
      settled = true;
      resolve({ fileId, storagePath, size, sha256: hash.digest('hex') });
    });
    stream.pipe(out);
  });
}

// since 支持：ISO 时间 / epoch 毫秒 / epoch 秒 / unix 分钟整数，统一折算成 unix 分钟
function parseSinceMinute(q) {
  let t = NaN;
  if (!q) {
    t = Date.now() - 10 * 60000;
  } else if (/^\d+$/.test(q)) {
    const n = Number(q);
    t = n > 1e12 ? n : n > 1e9 ? n * 1000 : n * 60000;
  } else {
    t = Date.parse(q);
  }
  if (Number.isNaN(t)) t = Date.now() - 10 * 60000;
  return Math.floor(t / 60000);
}

function fmtPull(r) {
  return {
    pull_id: r.pull_id,
    status: r.status,
    filename: r.filename,
    source_url: r.source_url,
    expected_sha256: r.expected_sha256,
    expected_size: r.expected_size,
    bytes_downloaded: r.bytes_downloaded,
    file_id: r.file_id,
    error: r.error || null,
    attempts: r.attempts,
    created_at: new Date(r.created_at).toISOString(),
    updated_at: new Date(r.updated_at).toISOString(),
  };
}

module.exports = function adminRouter({ config: cfg, db, stats, secret, pulls }) {
  const router = express.Router();

  // 设置 EDGE_API_KEY 后，/api/*（除 /api/health，它在 app.js 里更早注册）都需要携带
  router.use((req, res, next) => {
    if (!cfg.apiKey) return next();
    if (secretEqual(req.get('x-api-key') || '', cfg.apiKey)) return next();
    return res.status(401).json({ error: 'unauthorized' });
  });

  // 客户端已断开时不要（也无法）回包，避免写已销毁的 socket 报错
  const sendErr = (res, e) => {
    if (res.socket && res.socket.destroyed) return;
    res.status(e.status || 500).json({ error: e.message });
  };

  // 上传文件：multipart/form-data（字段名 file），或裸流 + ?filename=xxx
  router.post('/api/files', (req, res) => {
    const finish = (result, filename) => {
      const exp = Math.floor(Date.now() / 1000) + cfg.tokenTtlSec;
      const token = sign({ f: result.fileId, exp }, secret);
      db.prepare(
        'INSERT INTO files (file_id, filename, size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(result.fileId, filename, result.size, result.sha256, result.storagePath, Date.now());
      res.status(201).json({
        file_id: result.fileId,
        filename,
        size: result.size,
        sha256: result.sha256,
        download_url: `${cfg.publicBaseUrl}/d/${token}`,
        expire: new Date(exp * 1000).toISOString(),
      });
    };

    const ctype = req.headers['content-type'] || '';
    if (ctype.includes('multipart/form-data')) {
      const bb = Busboy({
        headers: req.headers,
        limits: {
          files: 1,
          fileSize: cfg.maxUploadBytes,
          fields: 10, // 限制字段数量/大小，防止恶意 multipart 占内存
          fieldSize: 64 * 1024,
          fieldNameSize: 128,
        },
      });
      let handled = false;
      bb.on('file', (name, file, info) => {
        if (handled) {
          file.resume();
          return;
        }
        handled = true;
        const filename = info.filename || 'upload.bin';
        let limited = false;
        file.on('limit', () => {
          limited = true;
        });
        saveStream(file, { storageDir: cfg.storageDir, lifecycle: { req } })
          .then((r) => {
            if (limited) {
              fs.unlink(r.storagePath, () => {});
              return sendErr(res, Object.assign(new Error('文件超过大小限制'), { status: 413 }));
            }
            finish(r, filename);
          })
          .catch((e) => sendErr(res, e));
      });
      bb.on('error', (e) => sendErr(res, Object.assign(e, { status: 400 })));
      bb.on('close', () => {
        if (!handled) res.status(400).json({ error: 'multipart 里缺少 file 字段' });
      });
      req.pipe(bb);
    } else {
      const filename = String(req.query.filename || req.headers['x-filename'] || 'upload.bin');
      saveStream(req, { storageDir: cfg.storageDir, maxBytes: cfg.maxUploadBytes })
        .then((r) => finish(r, filename))
        .catch((e) => sendErr(res, e));
    }
  });

  router.get(
    '/api/files',
    ah(async (req, res) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 1000, 1), 10000);
      const rows = db
        .prepare('SELECT file_id, filename, size, sha256, created_at FROM files ORDER BY created_at DESC LIMIT ?')
        .all(limit);
      res.json(rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() })));
    }),
  );

  router.delete(
    '/api/files/:fileId',
    ah(async (req, res) => {
      const row = db.prepare('SELECT * FROM files WHERE file_id = ?').get(req.params.fileId);
      if (!row) return res.status(404).json({ error: 'file_id 不存在' });
      db.prepare('DELETE FROM files WHERE file_id = ?').run(row.file_id);
      fs.unlink(row.storage_path, () => {});
      return res.status(204).end();
    }),
  );

  // 总控每分钟拉取：返回 since 之后的分钟统计桶（先 flush 内存计数，保证数据最新）
  router.get(
    '/api/stats',
    ah(async (req, res) => {
      const sinceMinute = parseSinceMinute(req.query.since);
      stats.flush();
      const rows = stats.rowsSince(sinceMinute).map((r) => ({
        ...r,
        minute: new Date(r.minute * 60000).toISOString(),
      }));
      res.json({
        edge_id: cfg.edgeId,
        since: new Date(sinceMinute * 60000).toISOString(),
        rows,
      });
    }),
  );

  // 文件分发：创建后台拉取任务（总控编排用，源通常是另一台 Edge 的签名下载链接）
  router.post(
    '/api/pulls',
    ah(async (req, res) => {
      try {
        const pullId = await pulls.createPull(req.body || {});
        res.status(202).json({ pull_id: pullId });
      } catch (e) {
        sendErr(res, e);
      }
    }),
  );

  router.get(
    '/api/pulls',
    ah(async (req, res) => {
      res.json(pulls.list().map(fmtPull));
    }),
  );

  router.get(
    '/api/pulls/:id',
    ah(async (req, res) => {
      const row = pulls.get(req.params.id);
      if (!row) return res.status(404).json({ error: 'pull_id 不存在' });
      return res.json(fmtPull(row));
    }),
  );

  return router;
};

module.exports.parseSinceMinute = parseSinceMinute;
