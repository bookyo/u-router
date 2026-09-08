'use strict';

const DispatchLog = require('../models/DispatchLog');

// 分发量内存聚合：每次分发只动内存计数，每 5 秒批量 UPSERT 进 MongoDB，
// 避免每次 API 调用产生多条数据库写请求。
// MongoDB 长时间不可用时 pending 有上限（默认 10 万条键），超过后丢弃新计数
// 并限频告警——保住进程比保住绝对精确更重要，且此时分发接口本身也基本不可用。
class DispatchRecorder {
  constructor(flushIntervalMs = 5000, { log = () => {}, maxPendingKeys = 100000 } = {}) {
    this.pending = new Map(); // `${minuteMs}|${edgeId}|${downloadId}` -> count
    this.flushIntervalMs = flushIntervalMs;
    this.maxPendingKeys = maxPendingKeys;
    this.log = log;
    this.capWarnedAt = 0;
    this.timer = null;
  }

  record(edgeId, downloadId, n = 1, at = Date.now()) {
    if (this.pending.size >= this.maxPendingKeys) {
      const now = Date.now();
      if (now - this.capWarnedAt > 60000) {
        this.capWarnedAt = now;
        this.log(`[dispatch] 待落库分配量已达上限 ${this.maxPendingKeys} 条键，新计数被丢弃（MongoDB 是否可用？）`);
      }
      return;
    }
    const minuteMs = Math.floor(at / 60000) * 60000;
    const key = `${minuteMs}|${edgeId}|${downloadId}`;
    this.pending.set(key, (this.pending.get(key) || 0) + n);
  }

  start() {
    this.timer = setInterval(() => {
      this.flush().catch((err) => {
        this.log(`[dispatch] 分配量落库失败（保留 ${this.pending.size} 条待重试）: ${err.message}`);
      });
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }

  async flush() {
    if (this.pending.size === 0) return;
    const entries = [...this.pending];
    this.pending = new Map();
    const ops = entries.map(([key, count]) => {
      const [minuteMs, edge_id, file_id] = key.split('|');
      return {
        updateOne: {
          filter: { minute: new Date(Number(minuteMs)), edge_id, file_id },
          update: { $inc: { count } },
          upsert: true,
        },
      };
    });
    try {
      await DispatchLog.bulkWrite(ops, { ordered: false });
    } catch (err) {
      // 写失败把计数放回内存等下个周期重试，尽量不丢分配量。
      // ordered:false 的批量写可能部分成功：真实 MongoBulkWriteError 的形状是
      // writeErrors[].index（指向失败的操作下标），据此只重入队失败的键，
      // 避免已成功落库的计数被重复累计；拿不到可靠下标时保守全部重入队。
      const writeErrors = Array.isArray(err && err.writeErrors) ? err.writeErrors : null;
      const failedIdx =
        writeErrors && writeErrors.length > 0 && writeErrors.every((w) => w && Number.isInteger(w.index))
          ? new Set(writeErrors.map((w) => w.index))
          : null;
      entries.forEach(([key, count], i) => {
        const failed = !failedIdx || failedIdx.has(i);
        if (failed) this.pending.set(key, (this.pending.get(key) || 0) + count);
      });
      throw err;
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    try {
      await this.flush();
    } catch (err) {
      this.log(`[dispatch] 退出前 flush 失败: ${err.message}`);
    }
  }
}

module.exports = { DispatchRecorder };
