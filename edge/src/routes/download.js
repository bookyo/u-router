'use strict';

const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { verify } = require('../token');

// 解析单段 Range 头（bytes=start-end / bytes=start- / bytes=-suffix）
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header || '');
  if (!m) return null;
  const [, s, e] = m;
  if (s === '' && e === '') return null;
  let start;
  let end;
  if (s === '') {
    const suffix = parseInt(e, 10);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInt(s, 10);
    end = e === '' ? size - 1 : parseInt(e, 10);
  }
  if (start > end || start >= size || end >= size) return { invalid: true };
  return { start, end };
}

module.exports = function downloadRouter({ config: cfg, db, stats, secret }) {
  const router = express.Router();
  const getFile = db.prepare('SELECT * FROM files WHERE file_id = ?');

  const handler = (req, res) => {
    const v = verify(req.params.token, secret);
    if (!v.ok) {
      stats.bump('_invalid', 'requests', 1);
      stats.bump('_invalid', 's4xx', 1);
      return res.status(v.reason === 'expired' ? 410 : 403).json({ error: v.reason });
    }

    const fileId = typeof v.payload.f === 'string' ? v.payload.f : '';
    const file = fileId ? getFile.get(fileId) : null;
    if (!file) {
      stats.bump(fileId || '_unknown', 'requests', 1);
      stats.bump(fileId || '_unknown', 's4xx', 1);
      return res.status(404).json({ error: 'file not found' });
    }

    // 成功计数在文件流成功打开之后才执行：
    // 磁盘文件丢失/不可读 → 只计 requests+s5xx（响应 500），不虚增 s2xx/started。
    // downloads_completed 只在完整送达预期长度时计（500/中断的 res.end 不算完成）。
    const countSuccess = () => {
      stats.bump(fileId, 'requests', 1);
      stats.bump(fileId, 's2xx', 1);
      // HEAD 只是探测元数据，不算一次下载开始
      if (req.method !== 'HEAD') stats.bump(fileId, 'downloads_started', 1);
    };
    const failUnreadable = () => {
      stats.bump(fileId, 'requests', 1);
      stats.bump(fileId, 's5xx', 1);
      if (!res.headersSent) res.status(500);
      res.end();
    };
    // HEAD 和 X-Accel 不会由 Node 的 createReadStream 触发 open/error，必须先
    // 真正打开一次文件验证可读性；仅检查数据库记录或 existsSync 会保留竞态。
    const withReadableFile = (next) => {
      fs.open(file.storage_path, 'r', (openErr, fd) => {
        if (openErr) return failUnreadable();
        return fs.close(fd, (closeErr) => {
          if (closeErr) return failUnreadable();
          return next();
        });
      });
    };

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);

    // Nginx/Caddy 前置：鉴权计数后把真正的文件发送交给反向代理
    // Node 无法获知反向代理最终是否完整送达，但至少在下发内部重定向前验证
    // 文件此刻存在且可读，避免已知缺失文件虚增成功统计。
    if (cfg.enableXAccel) {
      return withReadableFile(() => {
        countSuccess();
        const internal = `${cfg.xAccelPrefix.replace(/\/+$/, '')}/${path.basename(file.storage_path)}`;
        res.setHeader('X-Accel-Redirect', internal);
        res.setHeader('Content-Length', file.size);
        return res.status(200).end();
      });
    }

    const size = file.size;
    const range = parseRange(req.headers.range, size);
    if (range && range.invalid) {
      stats.bump(fileId, 'requests', 1);
      stats.bump(fileId, 's4xx', 1);
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }

    let start = 0;
    // 空文件的闭区间不存在；使用 end=-1 得到 len=0。旧实现把 end 钳成 0，
    // 错发 Content-Length: 1，客户端会一直等待不存在的一个字节。
    let end = size === 0 ? -1 : size - 1;
    if (range) {
      start = range.start;
      end = range.end;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    }
    const len = end - start + 1;
    if (req.method === 'HEAD') {
      return withReadableFile(() => {
        res.setHeader('Content-Length', len);
        res.status(range ? 206 : 200);
        countSuccess();
        return res.end();
      });
    }
    res.setHeader('Content-Length', len);
    res.status(range ? 206 : 200);

    let sent = 0;
    let opened = false;
    let finished = false;
    // size=0 时不能带 start/end 选项（end=-1 非法），空文件走默认整读
    const stream = fs.createReadStream(file.storage_path, size > 0 ? { start, end } : undefined);
    stream.on('open', () => {
      opened = true;
      countSuccess();
      stream.pipe(res);
    });
    stream.on('data', (chunk) => {
      sent += chunk.length;
    });
    res.on('finish', () => {
      finished = true;
    });
    res.on('close', () => {
      if (!opened) return;
      stats.bump(fileId, 'bytes_sent', sent);
      if (finished && sent >= len) stats.bump(fileId, 'downloads_completed', 1);
    });
    stream.on('error', () => {
      if (!opened) {
        stats.bump(fileId, 'requests', 1);
        stats.bump(fileId, 's5xx', 1);
        if (!res.headersSent) res.status(500);
        res.end();
      } else {
        // 已按 2xx 计数后中途断流：不重复计 s5xx，通过 completed 缺口体现
        res.destroy();
      }
    });
    return undefined;
  };

  router.get('/:token', handler);
  router.head('/:token', handler);
  return router;
};

module.exports.parseRange = parseRange;
