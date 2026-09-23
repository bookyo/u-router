// PM2 生态配置 —— 猫队工具链（ro-analysis）
// ============================================================
// 标准用法（只守护 workbench，worker 由工作台自行 spawn）：
//   pm2 start ecosystem.config.js
//   pm2 restart workbench && pm2 logs workbench --lines 100
//
// 商人独立常驻模式（默认关闭！与工作台「常驻商人」标签二选一，
// 同时跑会抢 8790 端口 + 同账号双登 code=8 互踢）：
//   把 ENABLE_MULE 改为 true，然后 pm2 start ecosystem.config.js --only mule
//
// 完整文档见 docs/pm2.md
// ============================================================
const ENABLE_MULE = false;

const workbench = {
  name: 'workbench',
  script: 'roclient/workbench/server.js',
  cwd: __dirname,
  env: {
    NODE_ENV: 'production',
    TZ: 'Asia/Shanghai',            // 日志/时间显示统一为北京时间（波次计算已按 UTC+8 显式换算，不依赖此项）
    WB_PORT: '8787',
    // ===== 安全（云部署必填；留空 = 本地公开模式，无登录页）=====
    WB_APIKEY: '',                  // 工作台登录 KEY：设置后所有页面/API 需登录（/search 公开搜索页除外）
    RO_MULE_KEY: '',                // 商人管理 KEY：8790 的 /price /pull /status 等需携带；且带 KEY 下单=免费交易
    // ===== 业务 =====
    RO_FAKE_IP: 'auto',             // 按账号哈希固定伪装出口 IP（绕 mg/check 终端限制）
    WB_BOUNTY_WAVES: '0,6,12,18',   // 赏金波次（北京时间整点，逗号分隔小时）
    WB_BOUNTY_WAVE_OFFSET_MIN: '15',// 波次后偏移分钟（等服务器刷新稳定再开跑）
    // WB_LVL_MAX: '3',             // 老号练级并发数（默认 3）
    // WB_BOUNTY_COOLDOWN_MIN: '360',  // 兜底冷却分钟（仅当 WB_BOUNTY_WAVES 留空时生效）
    // WB_NO_SWEEP: '1',            // 仅调试/第二实例：跳过启动清扫。正式环境勿开！
    // RO_LINE: 'eden',             // 线路（默认 eden）
  },
  max_memory_restart: '500M',
  kill_timeout: 8000,               // 留时间给优雅收尾（worker 保存进度/RESTART 释放角色）
  autorestart: true,
};

const mule = {
  name: 'mule',
  script: 'mule.js',
  cwd: __dirname,
  env: {
    TZ: 'Asia/Shanghai',
    RO_USER: 'xiezixing4',          // 商人账号
    RO_PASS: process.env.RO_PASS || '',
    RO_SLOT: '0',
    RO_MULE_PORT: '8790',
    RO_MULE_HOST: '127.0.0.1',      // 云部署需公网可达时改 0.0.0.0，并【必须】设置 RO_MULE_KEY
    RO_MULE_KEY: '',                // 同 workbench 的 RO_MULE_KEY 保持一致
  },
  autorestart: true,
  max_restarts: 50,                 // 密码错/维护期反复失败时防无限重启刷屏
};

module.exports = { apps: [workbench, ...(ENABLE_MULE ? [mule] : [])] };
