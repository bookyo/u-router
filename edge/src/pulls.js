'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dnsCallback = require('node:dns').lookup; // callback 形式（undici Agent 用）
const dnsPromises = require('node:dns').promises; // promise 形式（预检用）
const net = require('node:net');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { fetch: undiciFetch, Agent } = require('undici');

// 后台拉取管理器：从源 URL（通常是另一台 Edge 的签名下载链接）拉取文件，
// 边下边算 sha256，完成后注册进 files 表。
//
// 安全与资源限制（默认全开，可按部署环境放宽）：
// - SSRF：默认拒绝私网/回环/链路本地源（含域名解析到私网），不跟随重定向；
//   Edge 之间走内网分发时需显式 PULL_ALLOW_PRIVATE_NET=true
// - 期限：每次尝试整体超时 pullTimeoutMs；流内字节数硬上限 pullMaxBytes
// - 并发：maxConcurrent 个槽位，超出的任务排队（status=queued）
// - 恢复：进程重启后 recover() 重新拉起未完成任务，耗尽重试的直接判失败
//
// 断点续传：网络中断保留已下载部分，下次尝试用 Range 从偏移量续传
//（续传前把已有字节喂回哈希，保证全文件哈希正确）。

const PROGRESS_FLUSH_MS = 2000;

class PullError extends Error {
  constructor(message, dropPartial = false) {
    super(message);
    this.dropPartial = dropPartial;
  }
}

function bad(message, status = 400) {
  const e = new Error(message);
  e.status = status;
  return e;
}

const PRIVATE_HINT = '禁止拉取内网/回环地址（Edge 内网分发需设置 PULL_ALLOW_PRIVATE_NET=true）';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  const v6 = ip.toLowerCase();
  // IPv4-mapped IPv6（::ffff:127.0.0.1 / ::ffff:7f00:1）：fetch 实际会连到内嵌的
  // IPv4 地址，必须按内嵌地址判定，否则可绕过私网过滤
  if (v6.startsWith('::ffff:')) {
    const tail = v6.slice(7);
    if (net.isIPv4(tail)) return isPrivateIp(tail);
    const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
    if (m) {
      const hi = parseInt(m[1], 16);
      const lo = parseInt(m[2], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return true; // 无法解析的映射形式按私网处理
  }
  return (
    v6 === '::' || v6 === '::1' ||
    v6.startsWith('fe80') || // 链路本地
    v6.startsWith('fc') || v6.startsWith('fd') || // ULA
    v6.startsWith('ff') // 组播
  );
}

async function assertPublicSource(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw bad('source_url 无法解析');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw bad(PRIVATE_HINT);
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw bad(PRIVATE_HINT);
    return;
  }
  let addrs;
  try {
    addrs = await dnsPromises.lookup(host, { all: true });
  } catch {
    throw bad(`域名解析失败: ${host}`);
  }
  if (addrs.some((a) => isPrivateIp(a.address))) throw bad(`${host} 解析到内网地址，${PRIVATE_HINT}`);
}

class PullManager {
  constructor({
    db,
    storageDir,
    maxAttempts = 3,
    allowPrivate = false,
    maxConcurrent = 2,
    pullTimeoutMs = 30 * 60 * 1000,
    pullMaxBytes = 10 * 1024 * 1024 * 1024,
    log = console.log,
  } = {}) {
    this.db = db;
    this.storageDir = storageDir;
    this.maxAttempts = maxAttempts;
    this.allowPrivate = allowPrivate;
    this.maxConcurrent = maxConcurrent;
    this.pullTimeoutMs = pullTimeoutMs;
    this.pullMaxBytes = pullMaxBytes;
    this.log = log;

    this.active = 0;
    this.waiters = [];

    // 连接时私网过滤：预检（assertPublicSource）与 fetch 各自解析 DNS 之间存在
    // rebinding 窗口，把过滤下沉到 undici 连接层的 lookup 才是权威判定
    if (allowPrivate) {
      this.fetchImpl = (url, init) => fetch(url, init);
    } else {
      const agent = new Agent({
        connect: {
          lookup: (host, opts, cb) => {
            dnsCallback(host, { ...opts, all: true }, (err, addrs) => {
              if (err) return cb(err);
              const list = Array.isArray(addrs) ? addrs : [addrs];
              const bad = list.find((a) => isPrivateIp(a.address));
              if (bad) return cb(new Error(`目标解析到内网地址: ${bad.address}`));
              if (opts && opts.all) return cb(null, list);
              const first = list[0];
              return cb(null, first.address, first.family);
            });
          },
        },
      });
      this.fetchImpl = (url, init) => undiciFetch(url, { ...init, dispatcher: agent });
    }

    this.insertStmt = db.prepare(
      `INSERT INTO pulls (pull_id, source_url, filename, expected_sha256, expected_size, status,
        bytes_downloaded, file_id, error, attempts, created_at, updated_at, dedup_key)
       VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, 0, ?, ?, ?)`,
    );
    this.getStmt = db.prepare('SELECT * FROM pulls WHERE pull_id = ?');
    this.listStmt = db.prepare('SELECT * FROM pulls ORDER BY created_at DESC LIMIT 1000');
    this.staleStmt = db.prepare(
      "SELECT * FROM pulls WHERE status IN ('queued', 'pulling')",
    );
    this.findActiveByDedupStmt = db.prepare(
      "SELECT pull_id FROM pulls WHERE dedup_key = ? AND status IN ('queued', 'pulling') LIMIT 1",
    );
    this.updateStmt = db.prepare(
      'UPDATE pulls SET status=?, bytes_downloaded=?, error=?, attempts=?, updated_at=? WHERE pull_id=?',
    );
    this.insertFileStmt = db.prepare(
      'INSERT INTO files (file_id, filename, size, sha256, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
  }

  async createPull({ source_url, filename, expected_sha256, expected_size, dedup_key } = {}) {
    if (typeof source_url !== 'string' || !/^https?:\/\/\S+$/i.test(source_url)) {
      throw bad('source_url 必须是 http(s) 地址');
    }
    if (typeof filename !== 'string' || !filename.trim() || filename.length > 255) {
      throw bad('filename 非法（1~255 个字符）');
    }
    const sha = expected_sha256 || null;
    if (sha && !/^[0-9a-f]{64}$/i.test(sha)) throw bad('expected_sha256 必须是 64 位十六进制');
    const size =
      expected_size === undefined || expected_size === null || expected_size === ''
        ? null
        : Number(expected_size);
    if (size !== null && (!Number.isFinite(size) || size < 0)) throw bad('expected_size 非法');
    const dedup = typeof dedup_key === 'string' && dedup_key ? dedup_key.slice(0, 128) : null;
    if (!this.allowPrivate) await assertPublicSource(source_url);

    // 幂等：同一逻辑派发（响应丢失后重试）命中仍在运行的任务，避免重复下载
    if (dedup) {
      const existing = this.findActiveByDedupStmt.get(dedup);
      if (existing) {
        this.log(`[pull] 幂等命中 ${dedup} → ${existing.pull_id}`);
        return existing.pull_id;
      }
    }

    const pullId = `p_${crypto.randomBytes(8).toString('hex')}`;
    const fileId = `f_${crypto.randomBytes(8).toString('hex')}`;
    const now = Date.now();
    this.insertStmt.run(pullId, source_url, filename, sha, size, fileId, now, now, dedup);
    // 后台执行，不阻塞响应；#run 内部消化所有异常
    this.#run(pullId).catch((e) => this.log(`[pull] ${pullId} 任务异常: ${e.message}`));
    return pullId;
  }

  get(pullId) {
    return this.getStmt.get(pullId);
  }

  list() {
    return this.listStmt.all();
  }

  storagePathFor(fileId) {
    return path.join(this.storageDir, `${fileId}.bin`);
  }

  // 进程重启后的恢复：未完成的任务重新拉起（保留已尝试次数），
  // 已耗尽重试的直接判失败——否则总控会永远看到 pulling。
  recover() {
    const rows = this.staleStmt.all();
    let relaunched = 0;
    for (const row of rows) {
      if (row.attempts >= this.maxAttempts) {
        this.#patch(row.pull_id, { status: 'failed', error: '重启前已耗尽重试' });
        continue;
      }
      relaunched += 1;
      this.#run(row.pull_id, row.attempts).catch((e) =>
        this.log(`[pull] ${row.pull_id} 恢复异常: ${e.message}`),
      );
    }
    if (rows.length > 0) this.log(`[pull] 重启恢复：${rows.length} 个未完成任务（重新拉起 ${relaunched} 个）`);
    return rows.length;
  }

  #acquire() {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  #release() {
    const next = this.waiters.shift();
    if (next) {
      next(); // 槽位直接移交给等待者
      return;
    }
    this.active -= 1;
  }

  #patch(pullId, fields) {
    const row = this.get(pullId);
    if (!row) return;
    this.updateStmt.run(
      fields.status ?? row.status,
      fields.bytes_downloaded ?? row.bytes_downloaded,
      fields.error !== undefined ? fields.error : row.error,
      fields.attempts ?? row.attempts,
      Date.now(),
      pullId,
    );
  }

  #cleanupPartial(pullId) {
    const row = this.get(pullId);
    if (row) fs.unlink(this.storagePathFor(row.file_id), () => {});
  }

  async #run(pullId, startAttempt = 0) {
    await this.#acquire();
    try {
      let lastError = '';
      for (let attempt = startAttempt + 1; attempt <= this.maxAttempts; attempt++) {
        try {
          this.#patch(pullId, { attempts: attempt, status: 'pulling', error: '' });
          await this.#attempt(pullId);
          return;
        } catch (e) {
          if (e.dropPartial) this.#cleanupPartial(pullId);
          lastError = e.message || String(e);
          this.#patch(pullId, { error: lastError });
          this.log(`[pull] ${pullId} 第 ${attempt}/${this.maxAttempts} 次尝试失败: ${lastError}`);
        }
      }
      this.#patch(pullId, { status: 'failed', error: lastError });
      // 终态失败清理半成品：总控重派会生成新的 file_id，旧残留没有价值
      this.#cleanupPartial(pullId);
      this.log(`[pull] ${pullId} 重试耗尽，标记失败: ${lastError}`);
    } finally {
      this.#release();
    }
  }

  async #attempt(pullId) {
    const row = this.get(pullId);
    if (!row) return;
    const storagePath = this.storagePathFor(row.file_id);

    let have = 0;
    const hash = crypto.createHash('sha256');
    if (fs.existsSync(storagePath) && fs.statSync(storagePath).size > 0) {
      have = fs.statSync(storagePath).size;
      for await (const chunk of fs.createReadStream(storagePath)) hash.update(chunk);
    }

    const headers = {};
    if (have > 0) headers.Range = `bytes=${have}-`;
    let res;
    try {
      res = await this.fetchImpl(row.source_url, {
        headers,
        redirect: 'error', // 禁止跟随重定向绕过私网检查
        signal: AbortSignal.timeout(this.pullTimeoutMs),
      });
    } catch (e) {
      throw new PullError(`连接源失败: ${e.cause?.message || e.message}`);
    }
    if (have > 0 && res.status !== 206) {
      throw new PullError(`源不支持断点续传（HTTP ${res.status}），丢弃 ${have} 字节重新拉取`, true);
    }
    if (!res.ok) throw new PullError(`源返回 HTTP ${res.status}`);
    if (!res.body) throw new PullError('源返回空响应体');

    // Content-Length 预检：超限直接拒绝，不落盘
    const contentLength = Number(res.headers.get('content-length')) || 0;
    if (this.pullMaxBytes && contentLength && have + contentLength > this.pullMaxBytes) {
      throw new PullError(
        `源文件超过拉取大小上限（${have + contentLength} > ${this.pullMaxBytes} 字节）`,
        true,
      );
    }

    let bytes = have;
    let lastFlush = Date.now();
    const manager = this;
    const maxBytes = this.pullMaxBytes;
    const counting = new Transform({
      transform(chunk, enc, cb) {
        bytes += chunk.length;
        hash.update(chunk);
        if (maxBytes && bytes > maxBytes) {
          cb(new PullError(`已拉取 ${bytes} 字节，超过大小上限 ${maxBytes} 字节`, true));
          return;
        }
        if (Date.now() - lastFlush > PROGRESS_FLUSH_MS) {
          lastFlush = Date.now();
          manager.#patch(pullId, { bytes_downloaded: bytes });
        }
        cb(null, chunk);
      },
    });

    try {
      await pipeline(
        res.body,
        counting,
        fs.createWriteStream(storagePath, have > 0 ? { flags: 'a' } : { flags: 'w' }),
      );
    } catch (e) {
      if (e instanceof PullError) throw e;
      // 传输中断：保留已下载部分，下次尝试 Range 续传
      throw new PullError(`传输中断（已保留 ${bytes} 字节断点）: ${e.message}`);
    }
    this.#patch(pullId, { bytes_downloaded: bytes });

    if (row.expected_size && bytes !== row.expected_size) {
      throw new PullError(`sha256 校验失败：大小不符（期望 ${row.expected_size}，实际 ${bytes}）`, true);
    }
    const digest = hash.digest('hex');
    if (row.expected_sha256 && digest.toLowerCase() !== row.expected_sha256.toLowerCase()) {
      throw new PullError(`sha256 校验失败：期望 ${row.expected_sha256}，实际 ${digest}`, true);
    }

    this.insertFileStmt.run(row.file_id, row.filename, bytes, digest, storagePath, Date.now());
    this.#patch(pullId, { status: 'done', bytes_downloaded: bytes, error: '' });
    this.log(`[pull] ${pullId} 完成：${row.filename} ${bytes} 字节 sha256=${digest.slice(0, 12)}…`);
  }
}

module.exports = { PullManager };
