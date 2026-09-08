'use strict';

const mongoose = require('mongoose');

// 连不上不退出进程：总控应该持续重试等待 MongoDB 恢复
async function connectWithRetry(uri, log = console.log) {
  for (;;) {
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
      log('[db] MongoDB 已连接:', uri);
      return;
    } catch (err) {
      log(`[db] 连接失败: ${err.message}，3 秒后重试`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

module.exports = { connectWithRetry };
