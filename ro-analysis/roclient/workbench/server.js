'use strict';
/**
 * 猫队练级工作台服务端
 * ============================================================
 * 多账号并行练级：每个标签页一个账号 worker（node leveler.js 子进程），
 * 通过 SSE 把行动日志/结构化状态实时推给网页。
 *
 * 启动：node workbench/server.js           （默认 http://127.0.0.1:8787）
 *       WB_PORT=9000 node workbench/server.js
 *
 * REST API:
 *   GET  /api/state                     全部标签状态 + 各自最近日志
 *   POST /api/tabs      {mode:'new'|'old', account?, password?, stay?, loop?}   建标签并启动
 *   POST /api/tabs/:id/start            启动/重启（新号标签自动续练自己的账号）
 *   POST /api/tabs/:id/stop             停止（SIGTERM 优雅下线）
 *   POST /api/tabs/:id/clear            清空日志
 *   DELETE /api/tabs/:id                删除标签（停止 worker）
 *   GET  /api/tabs/:id/stream           SSE 日志流（log/event/state 三种消息）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const readline = require('readline');
const { PoolDB } = require('./db');
const { waveStartAt, nextWaveAt } = require('./bounty-wave');
const { cancelDeferredStart, scheduleDeferredStart } = require('./worker-loop');

const PORT = parseInt(process.env.WB_PORT || '8787', 10);
// APIKEY 门禁（云部署用）：WB_APIKEY 留空=公开访问；设置后所有页面/API 需先登录换取 Cookie
const APIKEY = process.env.WB_APIKEY || '';
const KEY_TOKEN = APIKEY ? crypto.createHash('sha256').update('wb:' + APIKEY).digest('hex').slice(0, 40) : '';
function authOk(req) {
  if (!APIKEY) return true;
  const m = /(?:^|;\s*)wb_key=([^;]+)/.exec(req.headers.cookie || '');
  return !!m && m[1] === KEY_TOKEN;
}
const AUTH_BYPASS = new Set(['/search', '/api/market/search', '/api/market/stats', '/api/market/shops', '/api/market/shop', '/api/market/itemmeta']);   // 免鉴权公开页
const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>工作台登录</title>
<style>body{background:#111;color:#ddd;font:14px Menlo,monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#1b1b1f;border:1px solid #2a2a30;border-radius:8px;padding:28px;width:300px;text-align:center}
input{width:100%;padding:8px;margin:14px 0;box-sizing:border-box;background:#151518;border:1px solid #2a2a30;color:#ddd;border-radius:4px}
button{width:100%;padding:8px;background:#1d3a52;border:1px solid #2d5a82;color:#ddd;border-radius:4px;cursor:pointer}
#e{color:#f96;font-size:12px;height:16px}</style></head><body><div class="box">
<b>🛡 工作台受保护</b><input id="k" type="password" placeholder="APIKEY" autofocus>
<button onclick="go()">进入</button><div id="e"></div></div>
<script>async function go(){const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({key:document.getElementById('k').value})});
if(r.ok){location.reload()}else{document.getElementById('e').textContent='密钥错误'}}document.getElementById('k').addEventListener('keydown',e=>{if(e.key==='Enter')go()})</script>
</body></html>`;
const ROOT = __dirname;
const CLIENT_DIR = path.join(ROOT, '..');
const ANALYSIS_DIR = path.join(CLIENT_DIR, '..');
const ACCT_DIR = path.join(ROOT, 'accounts');
const DB_FILE = path.join(ROOT, 'workbench.db');
const MAX_LINES = 2000;          // 每标签服务端环形缓冲（前端另有自动清理）

fs.mkdirSync(ACCT_DIR, { recursive: true });
const db = new PoolDB(DB_FILE);
// 挂机保姆数据源：地图/怪物检索 + 洞穴链预览
const { ItemSearch } = require(path.join(CLIENT_DIR, 'lib', 'search'));
const { findChain } = require(path.join(CLIENT_DIR, 'lib', 'portals'));
const search = new ItemSearch();
search.load().then(() => console.log(`🗺 挂机数据源就绪（${Object.keys(search.world || {}).length} 图）`)).catch((e) => console.error('数据源加载失败', e.message));
function chainPreview(map) {
  try {
    const ch = findChain(map);
    if (!ch) return null;
    return ch.map((s, i) => (i === 0 ? s.map : `${s.map}(${s.x},${s.y})→${s.to}`)).join(' ');
  } catch (_) { return null; }
}

// 标签持久化：重启不丢标签（恢复为 stopped，手动点启动）
const TABS_FILE = path.join(ROOT, 'tabs.json');
function saveTabs() {
  try {
    fs.writeFileSync(TABS_FILE, JSON.stringify([...tabs.values()].map((t) => ({
      id: t.id, name: t.name, mode: t.mode, account: t.account, password: t.password,
      stay: t.stay, loop: t.loop, status: t.status,
    })), null, 2));
  } catch (_) {}
}
function loadTabs() {
  let list = null;
  try { list = JSON.parse(fs.readFileSync(TABS_FILE, 'utf8')); } catch (_) { return; }
  for (const m of list || []) {
    if (!['new', 'old', 'bounty'].includes(m.mode)) continue;
    const t = makeTab(m);
    // 恢复原 id：必须重挂 Map 键（makeTab 已按生成 id set，直接改 t.id 会导致按 id 删除/SSE 失效）
    if (m.id && m.id !== t.id) { tabs.delete(t.id); t.id = m.id; tabs.set(t.id, t); }
    t.state = 'stopped';
    t.stateMsg = '重启恢复';
    Object.assign(t.status, m.status || {});
  }
  if (tabs.size) console.log(`[tabs] 恢复 ${tabs.size} 个标签（stopped）`);
}
setInterval(saveTabs, 3000).unref();
process.on('exit', saveTabs);

// 定期把练满的账号同步入库（leveler 存档：主 accounts.json + 工作台 tab 文件）
function syncPool() {
  const files = [path.join(CLIENT_DIR, 'accounts.json'),
    ...fs.readdirSync(ACCT_DIR).filter((f) => /^tab-.*\.json$/.test(f)).map((f) => path.join(ACCT_DIR, f))];
  const n = db.syncFromFiles(files);
  if (n > 0) console.log(`[pool] 入库 ${n} 个练满账号`);
}
setInterval(syncPool, 30 * 1000).unref();
syncPool();

// ---------------- 标签注册表 ----------------
const tabs = new Map();   // id -> tab
let tabSeq = 0;

function newId() { return 't' + Date.now().toString(36) + (tabSeq++); }

// 从主存档/工作台存档里找账号密码（旧号标签免输密码）
function lookupPassword(name) {
  const files = [path.join(CLIENT_DIR, 'accounts.json'), ...fs.readdirSync(ACCT_DIR).map((f) => path.join(ACCT_DIR, f))];
  for (const f of files) {
    try {
      const list = JSON.parse(fs.readFileSync(f, 'utf8'));
      const hit = list.find((x) => x.account === name || x.loginName === name);
      if (hit) return hit.password;
    } catch (_) {}
  }
  return null;
}

function makeTab(cfg) {
  const id = newId();
  const mode = ['new', 'old', 'bounty'].includes(cfg.mode) ? cfg.mode : 'new';
  const tab = {
    id,
    name: cfg.name || (mode === 'old' ? `旧号 ${cfg.account}` : mode === 'bounty' ? `赏金 ${cfg.account || '自动领号'}` : `新号 ${tabSeq}`),
    mode,
    account: (cfg.account || '').trim(),
    password: (cfg.password || '').trim(),
    stay: !!cfg.stay,             // RO_STAY=1 全程在线（hunter 智能走位）
    loop: !!cfg.loop,             // 新号：练满自动开下一个；赏金：跑完一个账号自动领下一个
    state: 'idle',                // idle|running|done|stopped|error
    stateMsg: '',
    worker: null,
    loopTimer: null,
    lines: [],                    // {ts, text}
    status: {                     // @@ 事件聚合
      account: '', password: '', char: '', level: null, done: 0, total: 12,
      stats: null, lastLevelAt: null, tasks: 0,
    },
    sse: new Set(),
  };
  tabs.set(id, tab);
  return tab;
}

// ---------------- worker 生命周期 ----------------
function workerEnv(tab, resumeAccount) {
  const env = {
    ...process.env,
    RO_EVENTS: '1',
    RO_MAX_ACCOUNTS: '1',
    RO_ACCT_FILE: path.join(ACCT_DIR, `tab-${tab.id}.json`),
    RO_START_DELAY: String(Math.floor(Math.random() * 12)),   // 错峰 0-12s
  };
  if (tab.mode === 'bounty') {
    // 赏金 worker：跑 bounty-run.js（账号来自 DB 账号池）
    Object.assign(env, {
      RO_USER: tab.bountyAccount || tab.account,
      RO_PASS: tab.bountyPassword || tab.password,
      RO_DASH_PORT: 'off',
      RO_OUT: path.join(ACCT_DIR, `bounty-${tab.id}.json`),
      RO_LINE: process.env.RO_LINE || 'eden',
    });
    return env;
  }
  if (tab.stay) env.RO_STAY = '1';
  if (tab.mode === 'old') {
    const pw = tab.password || lookupPassword(tab.account) || '';
    env.RO_ACCOUNT = `${tab.account}:${pw}`;
  } else if (resumeAccount) {
    env.RO_ACCOUNT = `${resumeAccount.account}:${resumeAccount.password}`;   // 续练本标签已开的号
  } else {
    env.RO_NEW = '1';
  }
  return env;
}

// 手动账号冷却（内存态；服务重启丢失可接受——只影响手动号 6h 节流）
const manualCooldown = new Map();   // account → until timestamp

// 赏金标签领号：手动指定账号直接用（密码可从本地存档补；6h 冷却内不领）；否则从 DB 账号池取（排除在跑的）
function claimBountyAccount(tab) {
  if (tab.account) {
    const pw = tab.password || lookupPassword(tab.account) || '';
    if (!pw) return null;   // 指定了账号但找不到密码 → 建标签时已拦截，双保险
    const acct = tab.account.replace(/_M$/, '');
    const cd = manualCooldown.get(acct);
    if (cd && cd > Date.now()) return { cooldownMs: cd - Date.now() };
    return { account: acct, password: pw, bounty_runs: 0, status: 'manual' };
  }
  const busy = [...tabs.values()].filter((t) => t !== tab && t.mode === 'bounty' && t.worker).map((t) => t.bountyAccount);
  return db.claimForBounty(busy);
}

// 找一个没被任何标签占用、还没练满的 pending 账号（新号标签优先复用，避免重启后账号闲置浪费）
const inflightClaims = new Set();   // 本次服务生命周期内已被领走的（防同时启动两个标签抢同一个）
function findIdlePendingAccount() {
  const bound = new Set(inflightClaims);
  for (const t of tabs.values()) {
    if (t.status.account) bound.add(t.status.account.replace(/_M$/, ''));
  }
  for (const f of fs.readdirSync(ACCT_DIR)) {
    if (!/^tab-.*\.json$/.test(f)) continue;
    let list;
    try { list = JSON.parse(fs.readFileSync(path.join(ACCT_DIR, f), 'utf8')); } catch (_) { continue; }
    if (!Array.isArray(list)) continue;
    const cand = list.find((a) => a.status === 'pending' && (a.plan || '') === 'cat30-v2'
      && !bound.has((a.loginName || a.account).replace(/_M$/, '')));
    if (cand) return { account: cand.loginName || cand.account, password: cand.password };
  }
  return null;
}

// 一个账号同时只能有一个 worker（两个 worker 登同一号会 code=8 互踢死循环）。
// 覆盖所有标签形态：运行中 worker / 冷却等待中的赏金标签（其账号仍被占用）
function findAccountClash(wantAcct, excludeTab) {
  const want = wantAcct.replace(/_M$/, '');
  for (const t of tabs.values()) {
    if (t === excludeTab) continue;
    const holds = t.worker || (t.mode === 'bounty' && t.state === 'waiting');
    if (!holds) continue;
    const bound = (t.mode === 'bounty' ? t.bountyAccount : t.status.account) || '';
    if (bound.replace(/_M$/, '') === want) return t;
  }
  return null;
}

// 统一账号占用检查（所有模式启动前）：冲突 → 报错；循环标签 30s 后自动重试
// （练级 worker 完成退出的瞬间会被误判占用，自动重试可自愈）
function guardAccountClash(tab, account) {
  if (!account) return false;
  const clash = findAccountClash(account, tab);
  if (!clash) return false;
  tab.state = 'error';
  tab.stateMsg = 'ACCOUNT_CLASH';
  pushLine(tab, `❌ 账号 ${account} 已被标签「${clash.name}」占用（同账号双 worker 会互踢）${tab.loop ? '，30 秒后自动重试' : '，本标签不启动'}`);
  broadcast(null, { type: 'state', tab: tabState(tab) });
  if (tab.loop) setTimeout(() => { if (tabs.has(tab.id) && !tab.worker) startWorker(tab); }, 30000);
  return true;
}

// 波次边界、完成记录和领号查询共用 bounty-wave.js；不再各自推算下一轮。
const bjClock = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });

// 赏金标签冷却等待：state=waiting + 倒计时，到期自动再领号（>5min 分片轮询，每片刷新倒计时）
function scheduleBountyWait(tab, ms, reason) {
  clearTimeout(tab.waitTimer);
  tab.state = 'waiting';
  tab.stateMsg = 'COOLDOWN';
  const until = new Date(Date.now() + ms);
  pushLine(tab, `⏳ ${reason}，等待至 ${until.toLocaleTimeString('zh-CN', { hour12: false })} 后自动继续（可随时点启动/停止）`);
  broadcast(null, { type: 'state', tab: tabState(tab) });
  tab.waitTimer = setTimeout(() => {
    tab.waitTimer = null;
    if (tabs.has(tab.id) && !tab.worker) startWorker(tab);   // 到期重领；仍在冷却会再次进入等待
  }, Math.min(ms + 15000, 5 * 60 * 1000));
}

function startWorker(tab) {
  // 旧 worker 必须先真正退出；否则旧 exit 回调会误清新 worker 的账号和状态。
  if (tab.worker) {
    pushLine(tab, '⏳ 当前 worker 尚未退出，请先停止并等待退出后再启动');
    return;
  }
  // 手动启动要取代冷却等待，不能留下旧计时器稍后再启动一次。
  clearTimeout(tab.waitTimer);
  tab.waitTimer = null;
  cancelDeferredStart(tab);
  // ---- 账号互斥（2026-09-20）：赏金 > AFK > 练级，高优先级登录时低优先级自动断开并暂停 ----
  const sys = tab.mode === 'bounty' ? 'bounty' : 'level';
  if (!acctAcquire(tab.account || `tab-${tab.id}`, sys, tab)) {
    tab.state = 'paused';
    tab.stateMsg = `账号被 ${acctHolderPretty(tab.account)} 占用，自动暂停（释放后自动恢复）`;
    pushLine(tab, `⏸ ${tab.stateMsg}`);
    broadcast(null, { type: 'state', tab: tabState(tab) });
    return;
  }
  tab.sysHeld = true;
  if (tab.mode === 'bounty') {
    const acc = claimBountyAccount(tab);
    if (acc && acc.cooldownMs) {   // 手动账号在 6h 冷却中
      scheduleBountyWait(tab, acc.cooldownMs, `手动账号 ${tab.account} 还在 6h 任务刷新冷却中`);
      broadcast(null, { type: 'state', tab: tabState(tab) });
      return;
    }
    if (!acc) {
      const info = db.poolCooldownInfo();
      if (info.total > 0 && info.claimable === 0 && info.earliestCooldown) {
        const waitMs = Math.max(0, new Date(info.earliestCooldown).getTime() - Date.now());
        scheduleBountyWait(tab, waitMs, `账号池 ${info.total} 个号都在 6h 任务刷新冷却中`);
      } else {
        tab.state = 'error';
        tab.stateMsg = 'POOL_EMPTY';
        pushLine(tab, '❌ 账号池没有可领的练满账号（等练级标签完成入库，或用手动账号）');
      }
      broadcast(null, { type: 'state', tab: tabState(tab) });
      return;
    }
    if (guardAccountClash(tab, acc.account)) return;
    // 账号互斥：赏金最高优先级——占用即踢停同账号的练级标签与 AFK 巡视
    if (!acctAcquire(acc.account, 'bounty', { name: '' })) {
      pushLine(tab, `⏸ 账号 ${acc.account} 被另一赏金标签(${acctHolderPretty(acc.account)})占用，稍后重试`);
      tab.state = 'paused'; tab.preempted = false;
      setTimeout(() => { if (tab.state === 'paused' && !tab.worker) startWorker(tab); }, 60 * 1000);
      broadcast(null, { type: 'state', tab: tabState(tab) });
      return;
    }
    tab.sysHeld = true;
    tab.bountyAccount = acc.account;
    tab.bountyPassword = acc.password;
    tab.status.tasks = 0;
    tab.status.account = acc.account;
    tab.status.password = acc.password;
    if (acc.status === 'manual') {
      // 手动账号入池（先入池再标记运行，保证运行中状态不被领）：6h 冷却/赏金统计统一在池里管理
      db.upsertExternal(acc.account, acc.password);
      pushLine(tab, `💾 手动账号 ${acc.account} 已加入账号池`);
    }
    const bountyStartedAt = Date.now();
    tab.bountyStartedAt = new Date(bountyStartedAt).toISOString();
    tab.bountyWaveStart = db.markBountyStart(acc.account, bountyStartedAt);   // 记住所属波次，跨边界收官也不记到下一轮
    pushLine(tab, acc.status === 'manual'
      ? `💰 手动指定账号 ${acc.account}`
      : `💰 领号 ${acc.account}（池内第 ${acc.bounty_runs + 1} 次跑赏金）`);
  }
  // 新号标签：优先续练本标签账号 → 回收空闲 pending 账号 → 都没有才 RO_NEW 开新号
  let resume = null;
  if (tab.mode === 'new') {
    if (tab.status.account) resume = { account: tab.status.account, password: tab.status.password };
    else {
      const idle = findIdlePendingAccount();
      if (idle) { inflightClaims.add(idle.account.replace(/_M$/, '')); resume = idle; }
    }
  }
  // 统一账号占用检查：旧号标签 / 续练回收的账号（全新注册号不冲突无需查）
  if (guardAccountClash(tab, tab.mode === 'old' ? tab.account : (resume && resume.account))) return;
  const env = workerEnv(tab, resume);
  const script = tab.mode === 'bounty' ? path.join(ANALYSIS_DIR, 'bounty-run.js') : 'leveler.js';
  tab.state = 'running';
  tab.stateMsg = '';
  if (resume && resume.account !== tab.status.account) {
    tab.status.account = resume.account;
    tab.status.password = resume.password;
    pushLine(tab, `♻ 回收空闲账号 ${resume.account}（重启前练了一半的号，继续练）`);
  }
  const effAcct = tab.mode === 'bounty' ? tab.bountyAccount : (tab.account || (resume && resume.account) || tab.status.account);
  if (effAcct && !tab.sysHeld) {   // 练级标签账号在此刻才确定 → 补取锁（占不上则暂停）
    if (!acctAcquire(effAcct, 'level', { name: tab.name })) {
      tab.state = 'paused'; tab.preempted = true;
      pushLine(tab, `⏸ 账号 ${effAcct} 被 ${acctHolderPretty(effAcct)} 占用，自动暂停（释放后自动恢复）`);
      broadcast(null, { type: 'state', tab: tabState(tab) });
      return;
    }
    tab.sysHeld = true;
  }
  pushLine(tab, `🚀 启动 worker（${tab.mode === 'old' ? `旧号 ${tab.account}` : tab.mode === 'bounty' ? `赏金 ${tab.bountyAccount}` : resume ? `续练 ${resume.account}` : '新号'}${tab.stay ? '，全程在线' : ''}）`);
  const child = spawn(process.execPath, [script], { cwd: tab.mode === 'bounty' ? ANALYSIS_DIR : CLIENT_DIR, env });
  tab.worker = child;
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => ingestLine(tab, line));
  child.stderr.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => ingestLine(tab, '[stderr] ' + l)));
  child.on('exit', (code, signal) => {
    tab.worker = null;
    if (tab.sysHeld) { tab.sysHeld = false; acctRelease(tab.account || tab.bountyAccount); }   // 账号锁随 worker 退出释放
    if (tab.mode === 'bounty') {
      const endedAt = Date.now();
      const nextWave = nextWaveAt(Date.parse(tab.bountyWaveStart || waveStartAt()));
      // 用户停止 = 显式 stopRequested（stopWorker 的按钮/删标签两条路径都已置位）。
      // 纯 signal（崩溃/OOM/SIGKILL/外部 kill）不再算用户停止 → 走 markBountyEnd(error)+波次冷却
      // （2026-09-23 多标签同号死循环排查：旧判定 `signal || stopRequested` 把任何信号死亡都当
      //   用户停止 → 重置账号行，是冷却被幽灵清空的候选路径之一）
      const userStop = tab.stopRequested;
      if (userStop) {
        manualCooldown.delete(tab.bountyAccount);
        // 用户停止/删标签：号回池但【保留波次冷却】（2026-09-23 实录：清冷却 + ready 领号优先 →
        // 同一波内同号被反复重领跑 0 任务死循环——xiezixing 13:12 完成 9 任务冷却生效后，13:20 删标签
        // 把冷却清掉，13:22 又被领）。半途中断的号冷却本来就是空/过期，不受影响照常可领。
        db.db.prepare("UPDATE accounts SET status='bounty_done', note='手动停止（冷却保留）' WHERE account=?").run(tab.bountyAccount);
        console.log(`[pool] ${tab.bountyAccount} 手动停止 → bounty_done（冷却保留）`);
      }
      else db.markBountyEnd(tab.bountyAccount, tab.status.tasks || 0, signal ? 1 : (code || 0), signal ? `异常退出(${signal})` : (code === 0 ? '完成' : '异常'), Math.max(0, nextWave - endedAt), { waveStart: tab.bountyWaveStart, startedAt: tab.bountyStartedAt, endedAt });
      pushLine(tab, `${code === 0 && !userStop ? '🏁 赏金轮次结束' : '⚠ 赏金 worker 退出'}（本号累计任务 ${tab.status.tasks || 0}，code=${code}${signal ? ' signal=' + signal : ''}）`);
      tab.state = code === 0 && !userStop ? 'done' : (userStop ? 'stopped' : 'error');
      tab.stateMsg = code === 0 && !userStop ? 'ROUND_DONE' : '';
      if (tab.loop && !userStop) {
        if (tab.account) {
          // 手动账号：冷却到下一波+偏移再跑（服务器 0/6/12/18 整点刷新）
          manualCooldown.set(tab.bountyAccount, nextWave);
          scheduleBountyWait(tab, Math.max(0, nextWave - Date.now()), `手动账号 ${tab.bountyAccount} 冷却到 北京时间 ${bjClock(nextWave)}（下一波）`);
        } else {
          pushLine(tab, '🔁 循环模式：8 秒后从账号池领下一个号');
          scheduleDeferredStart(tab, 8000, () => tabs.has(tab.id) && tab.state !== 'stopped', () => startWorker(tab));
        }
      }
      tab.stopRequested = false;
      broadcast(null, { type: 'state', tab: tabState(tab) });
      return;
    }
    const finished = tab.stateMsg === 'ACCOUNT_DONE';
    if (tab.state === 'running') {
      if (finished) {
        tab.state = 'done';
        tab.stateMsg = 'ACCOUNT_DONE';
        pushLine(tab, `🎉 账号练满（12 只猫 30 级），worker 退出`);
        syncPool();     // 立即入库，赏金标签马上可领
        pushLine(tab, `💾 已入库账号池（SQLite）`);
        if (tab.loop && tab.mode === 'new') {
          tab.status.account = '';   // 清空续练锚点 → 下次 RO_NEW 开新号
          pushLine(tab, '🔁 循环模式：3 秒后自动开下一个新号');
          scheduleDeferredStart(tab, 3000, () => tabs.has(tab.id) && tab.state !== 'stopped', () => startWorker(tab));
        }
      } else if (signal) {
        tab.state = 'stopped';
        pushLine(tab, `⏹ worker 已停止（signal=${signal}）`);
      } else {
        tab.state = code === 0 ? 'stopped' : 'error';
        pushLine(tab, `⚠ worker 退出 code=${code}`);
      }
    }
    broadcast(null, { type: 'state', tab: tabState(tab) });
  });
  broadcast(null, { type: 'state', tab: tabState(tab) });
}
function stopWorker(tab, silent) {
  cancelDeferredStart(tab);
  if (!tab.worker) return;
  const child = tab.worker;
  tab.stopRequested = true;    // 按钮/删标签都算用户主动停止（原 !silent 漏掉删标签路径，只能靠 signal 兜底——把崩溃也误判成用户停止）
  if (!silent) {
    tab.state = 'stopped';       // 立即反馈到 UI（不等 worker 退出事件）
    pushLine(tab, '⏹ 停止请求（优雅下线，最多等 4 秒）');
    broadcast(null, { type: 'state', tab: tabState(tab) });
  }
  try { child.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => { try { if (tab.worker === child) child.kill('SIGKILL'); } catch (_) {} }, 4000);
}

// ---------------- 日志/事件摄入 ----------------
function pushLine(tab, text) {
  const line = { ts: Date.now(), text };
  tab.lines.push(line);
  if (tab.lines.length > MAX_LINES) tab.lines.splice(0, tab.lines.length - MAX_LINES);
  broadcast(tab, { type: 'log', line });
}

function ingestLine(tab, line) {
  if (line.startsWith('@@')) {
    let evt = null;
    try { evt = JSON.parse(line.slice(2)); } catch (_) {}
    if (!evt) return;
    applyEvent(tab, evt);
    return;
  }
  pushLine(tab, line);
}

function applyEvent(tab, e) {
  const S = tab.status;
  switch (e.t) {
    case 'account':
      S.account = e.account; S.password = e.password; S.total = 12;
      pushLine(tab, `🏷 账号: ${e.account}${e.mode === 'old' ? '（旧号）' : e.mode === 'bounty' ? '（赏金）' : '（新注册）'}`);
      break;
    case 'char':
      S.char = e.name; S.level = e.level; S.done = e.done || S.done; S.total = e.total || S.total;
      break;
    case 'level':
      S.level = e.level; S.lastLevelAt = Date.now();
      break;
    case 'task':       // 赏金：单任务接取
      S.tasks = (S.tasks || 0) + 1;
      pushLine(tab, `📋 接取任务: ${e.name}（${e.char}，本号第 ${S.tasks} 个）`);
      break;
    case 'stats':
      S.stats = e; if (e.level) S.level = e.level;
      break;
    case 'skill':
      pushLine(tab, e.ok ? `🎓 技能加点成功: ${e.name} → Lv${e.level}` : `🎓 技能加点失败: ${e.name} ${e.reason || ''}`);
      break;
    case 'phase':
      pushLine(tab, `📌 ${e.msg}`);
      break;
    case 'account_done':
      tab.stateMsg = 'ACCOUNT_DONE';
      break;
    case 'done':
      tab.stateMsg = 'ACCOUNT_DONE';
      break;
  }
  broadcast(tab, { type: 'state', tab: tabState(tab) });
}

// ---------------- SSE ----------------
function tabState(tab) {
  const { id, name, mode, account, state, stateMsg, stay, loop, status } = tab;
  return { id, name, mode, account, state, stateMsg, stay, loop, status, running: !!tab.worker };
}
function broadcast(tab, msg) {
  const send = (t) => {
    for (const res of t.sse) {
      try { res.write(`data: ${JSON.stringify(msg)}\n\n`); } catch (_) { t.sse.delete(res); }
    }
  };
  if (tab) send(tab);
  else for (const t of tabs.values()) send(t);
}

// ---------------- HTTP ----------------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (_) { resolve({}); } });
  });
}

let marketProc = null;
const marketLogs = [];
const ITEM_META = { names: null, descs: null };   // 在线逛店：物品名/描述缓存（懒加载）

// 爬店启动（手动/定时共用）：上号 → market-scan.js → SQLite 全量入库（2026-09-23 起词条/名称为中文）
// 账号互斥：最低优先级（同常驻商人层）——爬店账号若被赏金/练级占用则不启动，等下个周期
function marketStartScan(reason = 'manual') {
  if (marketProc && !marketProc.killed) return { ok: false, error: 'already running' };
  const cfg = db.marketConfigGet();
  if (!cfg || !cfg.account || !cfg.password) return { ok: false, error: 'no config' };
  if (!acctAcquire(cfg.account, 'level', { name: '爬店' })) return { ok: false, error: `账号 ${cfg.account} 被占用` };
  db.marketConfigPatch({ status: 'running', note: '' });
  if (reason === 'manual') marketLogs.length = 0;
  marketLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${reason === 'timer' ? '⏰ 定时爬店到期' : '▶ 手动爬店'} → 上号 ${cfg.account}（slot${cfg.slot}）`);
  const env = { ...process.env, RO_USER: cfg.account, RO_PASS: cfg.password, RO_CHAR: String(cfg.slot || 0) };
  marketProc = spawn(process.execPath, ['market-scan.js'], { cwd: ANALYSIS_DIR, env });
  const rl = readline.createInterface({ input: marketProc.stdout });
  rl.on('line', (l) => { marketLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${l}`); if (marketLogs.length > 200) marketLogs.shift(); });
  marketProc.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => marketLogs.push(`⚠ ${l.slice(0, 120)}`)));
  marketProc.on('close', (code) => {
    marketProc = null;
    acctRelease(db.marketConfigGet() ? db.marketConfigGet().account : '');
    db.marketConfigPatch({ status: code === 0 ? 'done' : 'error', last_run: new Date().toISOString(), note: code === 0 ? '爬取完成，SQLite 已更新' : `退出码 ${code}` });
  });
  return { ok: true };
}

// 定时爬店调度：每 30s 检查——开关开 + 间隔到 + 无进程在跑 → 自动上号（2026-09-23）
let marketSkipLogAt = 0;
setInterval(() => {
  try {
    if (marketProc && !marketProc.killed) return;
    const cfg = db.marketConfigGet(); if (!cfg) return;
    const iv = (cfg.interval_min || 0) * 60000;
    if (!cfg.enabled || iv <= 0 || !cfg.account || !cfg.password) return;
    const lastMs = cfg.last_run ? new Date(cfg.last_run).getTime() : 0;
    if (Date.now() - lastMs < iv) return;   // 从未爬过（lastMs=0）→ 立即到期
    const r = marketStartScan('timer');
    if (!r.ok && /占用/.test(r.error || '') && Date.now() - marketSkipLogAt > 10 * 60000) {   // 占用等待提示（限流防刷屏）
      marketSkipLogAt = Date.now();
      marketLogs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ⏳ 定时爬店：${r.error}，等待账号释放…`);
    }
  } catch (_) {}
}, 30 * 1000).unref();

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  // ---- APIKEY 门禁：未登录时只放行 /api/login，其余返回登录页或 401 ----
  if (APIKEY && !authOk(req) && !AUTH_BYPASS.has(u.pathname)) {
    if (u.pathname === '/api/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (String(body.key || '') === APIKEY) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `wb_key=${KEY_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000` });
        return res.end('{"ok":true}');
      }
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"ok":false}');
    }
    const isPage = ['/', '/afk', '/lvl', '/mule', '/market'].includes(u.pathname) || u.pathname.startsWith('/static/');
    if (req.method === 'GET' && isPage) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_PAGE);
    }
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end('{"ok":false,"error":"unauthorized"}');
  }
  // 静态
  if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/afk' || u.pathname === '/lvl' || u.pathname === '/mule' || u.pathname === '/market' || u.pathname === '/search' || u.pathname.startsWith('/static/'))) {
    const rel = u.pathname === '/' ? 'index.html' : u.pathname === '/afk' ? 'afk.html' : u.pathname === '/lvl' ? 'lvl.html' : u.pathname === '/mule' ? 'mule.html' : u.pathname === '/market' ? 'market.html' : u.pathname === '/search' ? 'search.html' : u.pathname.replace(/^\/static\//, '');
    const file = path.join(ROOT, 'public', path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch (_) { res.writeHead(404); res.end('not found'); }
    return;
  }
  // SSE
  const mStream = u.pathname.match(/^\/api\/tabs\/([^/]+)\/stream$/);
  if (req.method === 'GET' && mStream) {
    const tab = tabs.get(mStream[1]);
    if (!tab) return sendJSON(res, 404, { error: 'no tab' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`retry: 3000\n\n`);
    res.write(`data: ${JSON.stringify({ type: 'init', tab: tabState(tab), lines: tab.lines.slice(-300) })}\n\n`);
    tab.sse.add(res);
    const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 15000);
    req.on('close', () => { clearInterval(ka); tab.sse.delete(res); });
    return;
  }
  // API
  if (u.pathname === '/api/state' && req.method === 'GET') {
    return sendJSON(res, 200, { tabs: [...tabs.values()].map(tabState), busy: [...acctBusy.entries()].map(([a, h]) => ({ account: a, sys: h.sys, label: h.label })) });
  }
  if (u.pathname === '/api/pool' && req.method === 'GET') {
    const pool = db.pool().map((a) => ({
      account: a.account, status: a.status, chars: a.chars,
      bounty_runs: a.bounty_runs, bounty_tasks: a.bounty_tasks,
      finished_at: a.finished_at, last_bounty_at: a.last_bounty_at, note: a.note,
    }));
    return sendJSON(res, 200, { pool });
  }
  if (u.pathname === '/api/pool' && req.method === 'POST') {
    const body = await readBody(req);
    const acct = String(body.account || '').trim();
    const pw = String(body.password || '').trim() || lookupPassword(acct);
    if (!acct) return sendJSON(res, 400, { error: '必须填账号' });
    if (!pw) return sendJSON(res, 400, { error: '必须填密码（本地存档无该账号记录）' });
    if (!db.upsertExternal(acct, pw)) return sendJSON(res, 400, { error: '添加失败' });
    return sendJSON(res, 200, { ok: true, account: acct.replace(/_M$/, '') });
  }
  const mPool = u.pathname.match(/^\/api\/pool\/([^/]+)$/);
  if (mPool && req.method === 'DELETE') {
    const acct = decodeURIComponent(mPool[1]);
    // 正在被标签运行的号不允许删（先停标签）
    const clash = findAccountClash(acct, null);
    if (clash) return sendJSON(res, 409, { error: `账号正被标签「${clash.name}」运行，请先停止该标签` });
    db.removeAccount(acct);
    return sendJSON(res, 200, { ok: true });
  }
  if (u.pathname === '/api/tabs' && req.method === 'POST') {
    const body = await readBody(req);
    if (body.mode === 'old' && !String(body.account || '').trim()) return sendJSON(res, 400, { error: '旧号必须填账号' });
    if (body.mode === 'old' && !(body.password || '').trim() && !lookupPassword(String(body.account).trim()))
      return sendJSON(res, 400, { error: '本地存档找不到该账号，请补密码' });
    if (body.mode === 'bounty' && String(body.account || '').trim() && !(body.password || '').trim() && !lookupPassword(String(body.account).trim()))
      return sendJSON(res, 400, { error: '手动指定账号但找不到密码（本地存档无记录），请补密码' });
    const tab = makeTab(body);
    startWorker(tab);
    return sendJSON(res, 200, tabState(tab));
  }
  let m = u.pathname.match(/^\/api\/tabs\/([^/]+)\/(start|stop|clear)$/);
  if (m && req.method === 'POST') {
    const tab = tabs.get(m[1]);
    if (!tab) return sendJSON(res, 404, { error: 'no tab' });
    if (m[2] === 'start') { manualCooldown.delete((tab.account || '').replace(/_M$/, '')); startWorker(tab); return sendJSON(res, 200, tabState(tab)); }
    if (m[2] === 'stop') {
      clearTimeout(tab.waitTimer);          // 取消冷却等待
      manualCooldown.delete((tab.account || '').replace(/_M$/, ''));   // 手动操作解除冷却节流
      tab.state = 'stopped';
      tab.stateMsg = '';
      stopWorker(tab);
      return sendJSON(res, 200, tabState(tab));
    }
    if (m[2] === 'clear') { tab.lines = []; broadcast(tab, { type: 'clear' }); return sendJSON(res, 200, tabState(tab)); }
  }
  m = u.pathname.match(/^\/api\/tabs\/([^/]+)$/);
  if (m && req.method === 'DELETE') {
    const tab = tabs.get(m[1]);
    if (!tab) return sendJSON(res, 404, { error: 'no tab' });
    stopWorker(tab, true);
    tabs.delete(m[1]);
    broadcast(null, { type: 'tab-removed', id: m[1] });
    return sendJSON(res, 200, { ok: true });
  }

  // ==================== 常驻商人 API ====================
  if (u.pathname === '/api/mule' && req.method === 'POST') {   // 保存配置（空字段=保留原值——防误清配置：曾有前端默认 POST 的刷新把配置每 4s 清空一次）
    const body = await readBody(req);
    const prev = db.muleGet() || {};
    const acct = String(body.account || '').trim() || prev.account || '';
    const pw = String(body.password || '').trim() || prev.password || '';
    db.muleSet(acct, pw, body.slot != null && String(body.slot) !== '' ? (body.slot | 0) : (prev.slot || 0));
    return sendJSON(res, 200, { ok: true });
  }
  if (u.pathname === '/api/mule' && req.method === 'GET') {
    const cfg = db.muleGet() || {};
    return sendJSON(res, 200, { ...muleStatus(), account: cfg.account ? cfg.account : '', slot: cfg.slot || 0, passwordSet: !!cfg.password });
  }
  if (u.pathname === '/api/mule/start' && req.method === 'POST') return sendJSON(res, 200, { ok: muleStart() });
  if (u.pathname === '/api/mule/stop' && req.method === 'POST') { muleStop(); return sendJSON(res, 200, { ok: true }); }
  if (u.pathname === '/api/mule/game' && req.method === 'GET') return muleProxy(u.search || '/status', res);
  if (u.pathname === '/api/mule/inventory' && req.method === 'GET') return muleProxy('/inventory', res);
  // 价目/推车管理走同源代理：浏览器不再直连 8790（云端可达），代理自动代发管理 KEY
  if (u.pathname === '/api/mule/stock' && req.method === 'GET') return muleProxy('/stock', res);
  if (u.pathname === '/api/mule/price' && req.method === 'POST') { const b = await readBody(req); return muleProxy('/price', res, { method: 'POST', body: b }); }
  if (u.pathname === '/api/mule/pull' && req.method === 'POST') { const b = await readBody(req); return muleProxy('/pull', res, { method: 'POST', body: b }); }

  // ==================== 爬店标签 API ====================
  if (u.pathname === '/api/market/tab' && req.method === 'POST') {
    db.marketConfigInit();
    const body = await readBody(req);
    db.marketConfigSet(body.account || '', body.password || '', body.slot | 0);
    return sendJSON(res, 200, { ok: true });
  }
  if (u.pathname === '/api/market/tab' && req.method === 'GET') {
    db.marketConfigInit();
    const cfg = db.marketConfigGet() || {};
    const iv = (cfg.interval_min || 0) * 60000;
    const lastMs = cfg.last_run ? new Date(cfg.last_run).getTime() : 0;
    return sendJSON(res, 200, { account: cfg.account || '', slot: cfg.slot || 0, passwordSet: !!cfg.password, status: cfg.status || 'idle', lastRun: cfg.last_run || '', note: (cfg.note || '').slice(0, 80), running: !!(marketProc && !marketProc.killed),
      scheduleEnabled: !!cfg.enabled, intervalMin: cfg.interval_min || 0,
      nextRunAt: cfg.enabled && iv > 0 ? new Date(lastMs ? lastMs + iv : Date.now()).toISOString() : null });
  }
  // 定时爬店设置：{enabled, intervalMin}——enabled 复用 market_config.enabled 列做开关
  if (u.pathname === '/api/market/schedule' && req.method === 'POST') {
    const body = await readBody(req);
    const iv = Math.max(0, Math.min(1440, parseInt(body.intervalMin, 10) || 0));
    const enabled = !!body.enabled && iv > 0;
    db.marketConfigInit();
    db.marketConfigPatch({ enabled: enabled ? 1 : 0, interval_min: enabled ? iv : 0, note: enabled ? `定时爬店：每 ${iv} 分钟` : '' });
    console.log(`[market] 定时爬店 ${enabled ? `开启（每 ${iv} 分钟）` : '关闭'}`);
    return sendJSON(res, 200, { ok: true, enabled, intervalMin: enabled ? iv : 0 });
  }
  if (u.pathname === '/api/market/tab/start' && req.method === 'POST') {
    return sendJSON(res, 200, marketStartScan('manual'));
  }
  if (u.pathname === '/api/market/tab/stop' && req.method === 'POST') {
    if (marketProc) { try { marketProc.kill('SIGTERM'); } catch (_) {} setTimeout(() => { try { marketProc && marketProc.kill('SIGKILL'); } catch (_) {} }, 5000); }
    return sendJSON(res, 200, { ok: true });
  }
  if (u.pathname === '/api/market/tab/logs' && req.method === 'GET') {
    return sendJSON(res, 200, { logs: marketLogs.slice(-60) });
  }

  // ==================== 市场商品查询 API ====================
  if (u.pathname === '/api/market/search' && req.method === 'GET') {
    const q = Object.fromEntries(u.searchParams.entries());
    const results = db.marketSearch({
      keyword: q.q || '', city: q.city || '',
      ITID: q.itid ? +q.itid : null,
      minPrice: q.min != null ? +q.min : null,
      maxPrice: q.max != null ? +q.max : null,
      type: q.type != null ? +q.type : null,
      optId: q.opt ? +q.opt : null,
      orderBy: q.order || 'price_asc',
      limit: q.limit ? +q.limit : 50,
    });
    return sendJSON(res, 200, { count: results.length, items: results.map((r) => ({ ...r, options: JSON.parse(r.options || '[]') })) });
  }
  if (u.pathname === '/api/market/stats' && req.method === 'GET') {
    try {
      const total = db.db.prepare('SELECT COUNT(*) as n FROM market_items').get();
      const cities = db.db.prepare('SELECT city, COUNT(*) as n FROM market_items GROUP BY city ORDER BY n DESC').all();
      const lastAt = db.db.prepare('SELECT MAX(scraped_at) as at FROM market_items').get();
      return sendJSON(res, 200, { total: total.n, cities, lastScraped: lastAt.at });
    } catch (_) { return sendJSON(res, 200, { total: 0, cities: [], lastScraped: null }); }
  }

  // ==================== 在线逛店 API（2026-09-23，数据=market_items 聚合）====================
  // 店铺列表：按 店主AID+店名+坐标 聚合（?map=prontera 过滤）
  if (u.pathname === '/api/market/shops' && req.method === 'GET') {
    const map = u.searchParams.get('map') || '';
    try {
      const rows = db.db.prepare(`
        SELECT shop_title, owner_name, owner_aid, city, map_name, shop_x, shop_y,
               COUNT(*) AS items, MIN(price) AS minPrice, MAX(scraped_at) AS at
        FROM market_items ${map ? 'WHERE map_name = ?' : ''}
        GROUP BY owner_aid, shop_title, shop_x, shop_y
        ORDER BY items DESC`).all(...(map ? [map] : []));
      return sendJSON(res, 200, { count: rows.length, shops: rows });
    } catch (_) { return sendJSON(res, 200, { count: 0, shops: [] }); }
  }
  // 店铺详情：该店全部商品
  if (u.pathname === '/api/market/shop' && req.method === 'GET') {
    const q = Object.fromEntries(u.searchParams.entries());
    if (!q.aid || !q.title) return sendJSON(res, 400, { error: 'need aid+title' });
    try {
      const rows = db.db.prepare(`
        SELECT ITID, name, price, qty, type, options, opt_labels FROM market_items
        WHERE owner_aid = ? AND shop_title = ? ORDER BY price ASC`).all(+q.aid, q.title);
      return sendJSON(res, 200, { count: rows.length, items: rows.map((r) => ({ ...r, options: JSON.parse(r.options || '[]') })) });
    } catch (e) { return sendJSON(res, 400, { error: e.message }); }
  }
  // 物品元数据（名称+描述）：?ids=501,502 本地 itemnames-zh / itemdesc-zh（带缓存）
  if (u.pathname === '/api/market/itemmeta' && req.method === 'GET') {
    const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 600).map(Number);
    if (!ITEM_META.names) {
      try { ITEM_META.names = JSON.parse(fs.readFileSync(path.join(ANALYSIS_DIR, 'data', 'itemnames-zh.json'), 'utf8')); } catch (_) { ITEM_META.names = {}; }
      try { ITEM_META.descs = JSON.parse(fs.readFileSync(path.join(ANALYSIS_DIR, 'data', 'itemdesc-zh.json'), 'utf8')); } catch (_) { ITEM_META.descs = {}; }
    }
    const out = {};
    for (const id of ids) out[id] = {
      n: ITEM_META.names[String(id)] || ('#' + id),
      d: String(ITEM_META.descs[String(id)] || '').replace(/\^[0-9a-fA-F]{6}/g, ''),   // 去 ^xxxxxx 颜色码
    };
    return sendJSON(res, 200, out);
  }

  // ==================== 老号练级中心 API ====================
  if (u.pathname === '/api/lvl' && req.method === 'POST') {
    const body = await readBody(req);
    let n = 0;
    const skipped = [];
    for (const ln of String(body.text || '').split(/\r?\n/)) {
      const t = ln.trim();
      if (!t) continue;
      // 宽容格式：半角/全角冒号、Tab、空格分隔均可（取第一个分隔符，密码可含其余字符）
      const i = Math.min(...[':', '：', '\t', ' '].map((c) => t.indexOf(c)).filter((x) => x > 0));
      if (!isFinite(i) || i <= 0) { skipped.push(t.slice(0, 24)); continue; }
      db.lvlUpsert(t.slice(0, i).trim(), t.slice(i + 1).trim());
      n++;
    }
    if (n) lvlStart();
    return sendJSON(res, 200, { ok: true, added: n, skipped });
  }
  if (u.pathname === '/api/lvl' && req.method === 'GET') {
    return sendJSON(res, 200, { accounts: db.lvlList().map((a) => ({ ...a, password: a.password ? '●●●' : '' })), logs: Object.fromEntries([...lvlLogs].map(([k, v]) => [k, v.slice(-60)])), running: [...lvlRunning.keys()], active: lvlActive, max: LVL_MAX });
  }
  if (u.pathname === '/api/lvl/start' && req.method === 'POST') { lvlStart(); return sendJSON(res, 200, { ok: true }); }
  if (u.pathname === '/api/lvl/stop' && req.method === 'POST') { lvlStop(); return sendJSON(res, 200, { ok: true }); }
  m = u.pathname.match(/^\/api\/lvl\/(\d+)\/requeue$/);
  if (m && req.method === 'POST') {
    const rec = db.lvlList().find((a) => a.id === +m[1]);
    if (!rec) return sendJSON(res, 404, { error: 'no account' });
    // 如有挂死的 worker：先杀（SIGTERM 优雅退出），释放并发槽和账号占用
    const w = lvlRunning.get(rec.account);
    if (w) {
      lvlLog(rec.account, '🔁 重新入队：终止卡住的 worker');
      try { w.kill('SIGTERM'); } catch (_) {}
    }
    db.lvlPatch(rec.id, { status: 'pending', note: '手动重新入队' });
    lvlLog(rec.account, '🔁 已重新入队（pending），等待并发槽');
    setTimeout(lvlPump, 1500);
    return sendJSON(res, 200, { ok: true });
  }
  m = u.pathname.match(/^\/api\/lvl\/(\d+)$/);
  if (m && req.method === 'DELETE') { db.lvlDelete(+m[1]); return sendJSON(res, 200, { ok: true }); }

  // ==================== 挂机保姆（AFK）API ====================
  m = u.pathname.match(/^\/api\/afk\/(\d+)\/(probe|skills|run)$/);
  if (m && req.method === 'POST') {
    const rec = db.afkGet(+m[1]);
    if (!rec) return sendJSON(res, 404, { error: 'no account' });
    const act = m[2];
    if (act === 'probe' || act === 'skills') {
      const args = [path.join(ANALYSIS_DIR, 'afk-runner.js'), act, '--account', rec.account, '--pass', rec.password, '--line', rec.line || 'eden'];
      if (act === 'skills') args.push('--slot', String(rec.slot));
      const out = await new Promise((resolve) => {
        let buf = '';
        const p = spawn(process.execPath, args, { cwd: ANALYSIS_DIR });
        p.stdout.on('data', (d) => { buf += d; });
        p.on('close', () => resolve(buf));
        setTimeout(() => { try { p.kill(); } catch (_) {} }, 90 * 1000);
      });
      try {
        // 输出里混有客户端日志：逐行取最后一个可解析的 JSON 对象
        let parsed = null;
        for (const ln of out.split('\n')) {
          const t = ln.trim();
          if (t.startsWith('{') && t.endsWith('}')) { try { parsed = JSON.parse(t); } catch (_) {} }
        }
        if (!parsed) throw new Error('no json');
        return sendJSON(res, 200, parsed);
      }
      catch (_) { return sendJSON(res, 500, { ok: false, error: out.slice(-200) }); }
    }
    afkEnqueue(+m[1], '手动触发');
    return sendJSON(res, 200, { ok: true, queued: true });
  }
  m = u.pathname.match(/^\/api\/afk\/(\d+)$/);
  if (m && req.method === 'DELETE') { db.afkDelete(+m[1]); return sendJSON(res, 200, { ok: true }); }
  if (m && req.method === 'PUT') {
    const body = await readBody(req);
    db.afkPatch(+m[1], body);
    return sendJSON(res, 200, { ok: true });
  }
  if (u.pathname === '/api/afk' && req.method === 'POST') {
    const body = await readBody(req);
    if (!String(body.account || '').trim()) return sendJSON(res, 400, { error: '账号必填' });
    const id = db.afkUpsert(body);
    return sendJSON(res, 200, { ok: true, id });
  }
  if (u.pathname === '/api/afk' && req.method === 'GET') {
    const accounts = db.afkList().map((a) => ({ ...a, password: a.password ? '●●●' : '' }));   // 密码不回传前端
    return sendJSON(res, 200, { accounts, logs: Object.fromEntries([...afkLogs].map(([k, v]) => [k, v.slice(-80)])), running: afkRunning ? afkRunning.id : null });
  }
  if (u.pathname === '/api/afk/maps' && req.method === 'GET') {
    const q = u.searchParams.get('q') || '';
    const list = search.searchMaps(q).slice(0, 40).map((r) => ({ ...r, cname: search.getMapName(r.map), chain: chainPreview(r.map) }));
    return sendJSON(res, 200, { maps: list });
  }
  if (u.pathname === '/api/afk/mobs' && req.method === 'GET') {
    return sendJSON(res, 200, { mobs: search.findMobsOnMap(u.searchParams.get('map') || '').sort((a, b) => (a.level || 0) - (b.level || 0)) });
  }

  res.writeHead(404); res.end('not found');
});

// ==================== 账号互斥锁（赏金 > AFK > 练级） ====================
// 规则：高优先级系统登录某账号时，低优先级持有者自动断开并暂停（不再挤号）；释放后按需自动恢复
const ACCT_PRIO = { bounty: 3, afk: 2, level: 1 };
const ACCT_NAME = { bounty: '赏金', afk: 'AFK挂机', level: '练级' };
const acctBusy = new Map();     // account -> { sys, label }
const normAcct = (a) => String(a || '').replace(/_M$/, '').trim().toLowerCase();
function acctHolderPretty(a) { const h = acctBusy.get(normAcct(a)); return h ? `${ACCT_NAME[h.sys]}${h.label ? '(' + h.label + ')' : ''}` : '?'; }
function acctPreempt(a) {   // 踢掉所有低优先级持有者
  const key = normAcct(a);
  for (const t of tabs.values()) {   // 练级/赏金标签 worker
    if (t.worker && normAcct(t.account) === key && ACCT_PRIO[t.mode === 'bounty' ? 'bounty' : 'level'] < ACCT_PRIO[acctBusy.get(key).sys]) {
      pushLine(t, `⏸ 账号被 ${acctHolderPretty(a)} 接管（优先级更高），自动断开暂停`);
      t.preempted = true;
      stopWorker(t, true);
      t.state = 'paused';
      broadcast(null, { type: 'state', tab: tabState(t) });
    }
  }
  if (afkRunning && normAcct(afkRunning.account) === key && ACCT_PRIO[acctBusy.get(key).sys] > ACCT_PRIO.afk) {
    afkLog(afkRunning.id, `⏸ 账号被 ${acctHolderPretty(a)} 接管，本轮中止`);
    try { afkRunning.proc && afkRunning.proc.kill('SIGTERM'); } catch (_) {}
  }
  for (let i = afkQueue.length - 1; i >= 0; i--) if (normAcct((afkQueue[i].account || '')) === key) afkQueue.splice(i, 1);
}
function acctHolderAlive(key) {   // 持有者存活校验：worker 进程没了=僵尸锁
  if (afkRunning && normAcct(afkRunning.account) === key) return true;
  for (const t of tabs.values()) if (t.sysHeld && t.worker && normAcct(t.mode === 'bounty' ? t.bountyAccount : t.account) === key) return true;
  return false;
}
function acctAcquire(a, sys, meta = {}) {
  const key = normAcct(a);
  if (!key || key.startsWith('tab-')) return true;   // 无账号标签不参与互斥
  let cur = acctBusy.get(key);
  if (cur && !acctHolderAlive(key)) {   // 僵尸锁自愈：持有者 worker 已不存在 → 清除重取
    console.log(`[mutex] 清除僵尸锁 ${key}（原持有 ${ACCT_NAME[cur.sys]}，worker 已不在）`);
    acctBusy.delete(key);
    cur = undefined;
  }
  if (cur && ACCT_PRIO[cur.sys] >= ACCT_PRIO[sys]) {
    cur.label = cur.sys === 'afk' ? acctHolderPretty(a) : `标签${meta.tabId || cur.label || ''}`;
    return false;   // 被同级或更高占用
  }
  if (cur) acctPreempt(a);
  acctBusy.set(key, { sys, label: meta.name || meta.account || '' });
  return true;
}
function acctRelease(a) { const key = normAcct(a); const h = acctBusy.get(key); if (!h) return; acctBusy.delete(key);
  // 释放后：自动恢复被暂停的练级/赏金标签
  for (const t of tabs.values()) if (t.state === 'paused' && t.preempted && normAcct(t.account) === key) { t.preempted = false; pushLine(t, '▶ 账号已释放，自动恢复'); startWorker(t); }
}
// worker 退出（任何原因）→ 释放账号锁
const origStopWorker = stopWorker;
stopWorker = function (tab, silent) { if (tab.sysHeld) { tab.sysHeld = false; acctRelease(tab.account); } origStopWorker(tab, silent); };

// ==================== 老号练级中心：批量 3 并发练到 30 级 ====================
db.lvlInit();
const LVL_MAX = parseInt(process.env.WB_LVL_MAX || '3', 10);
const lvlRunning = new Map();    // account -> child
const lvlLogs = new Map();       // account -> [lines]
let lvlActive = false;
function lvlLog(acct, line) {
  const arr = lvlLogs.get(acct) || [];
  arr.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
  if (arr.length > 300) arr.splice(0, arr.length - 300);
  lvlLogs.set(acct, arr);
}
function lvlPump() {
  if (!lvlActive) return;
  const rows = db.lvlList();
  for (const r of rows) {
    if (lvlRunning.size >= LVL_MAX) break;
    if (r.status !== 'pending' || lvlRunning.has(r.account)) continue;
    if (!acctAcquire(r.account, 'level', { name: '批量练级' })) {   // 被赏金/AFK 占用 → 稍后再试
      db.lvlPatch(r.id, { status: 'pending', note: `账号被 ${acctHolderPretty(r.account)} 占用，等待中` });
      continue;
    }
    const acct = r.account;
    db.lvlPatch(r.id, { status: 'running', note: '' });
    lvlLog(acct, `🚀 开始练级（${[...lvlRunning.keys()].indexOf(acct) + 1}/${LVL_MAX} 并发槽）`);
    const env = { ...process.env, RO_EVENTS: '1', RO_MAX_ACCOUNTS: '1', RO_GIVEUP: '1',
      RO_ACCT_FILE: path.join(ACCT_DIR, `lvl-${acct.replace(/[^a-z0-9_]/gi, '_')}.json`),
      RO_START_DELAY: String(Math.floor(Math.random() * 10)),
      RO_ACCOUNT: `${acct}:${r.password}` };
    const p = spawn(process.execPath, ['leveler.js'], { cwd: CLIENT_DIR, env });
    lvlRunning.set(acct, p);
    const rl = readline.createInterface({ input: p.stdout });
    rl.on('line', (l) => lvlLog(acct, l));
    p.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => lvlLog(acct, '⚠ ' + l.slice(0, 160))));
    p.on('close', (code) => {
      lvlRunning.delete(acct);
      acctRelease(acct);
      // 竞态防护：requeue 已把状态改为 pending 时，close 事件不得覆盖（旧代码误标 done）
      const now = db.lvlList().find((x) => x.id === r.id);
      if (now && now.status === 'running') {
        db.lvlPatch(r.id, { status: code === 0 ? 'done' : 'error', note: code === 0 ? '全部角色已到 30 级' : code === 4 ? '连续4次进图被拒(code=0)，已停号' : `退出码 ${code}` });
        lvlLog(acct, code === 0 ? '🏁 账号练级完成（全角色 30 级）' : `⚠ 退出 code=${code}`);
      } else {
        lvlLog(acct, `worker 退出 code=${code}（状态已为 ${now ? now.status : '?'}，不覆盖）`);
      }
      setTimeout(lvlPump, 3000);   // 补位下一个 pending
    });
  }
}
function lvlStart() { lvlActive = true; lvlPump(); }
function lvlStop() {
  lvlActive = false;
  for (const [acct, p] of lvlRunning) { try { p.kill('SIGTERM'); } catch (_) {} }
  setTimeout(() => { for (const [acct, p] of lvlRunning) { try { p.kill('SIGKILL'); } catch (_) {} } }, 4000);
}

// ==================== 常驻商人（mule）管理：标签式开关，关闭/暂停=优雅下号 ====================
db.muleInit();
let muleProc = null;
const muleStatus = () => ({ running: !!(muleProc && !muleProc.killed), pid: muleProc ? muleProc.pid : null });
function muleStart() {
  if (muleProc && !muleProc.killed) return false;
  const cfg = db.muleGet();
  if (!cfg || !cfg.account || !cfg.password) return false;
  if (!acctAcquire(cfg.account, 'level', { name: '常驻商人' })) return false;   // 账号互斥（最低优先级，可被赏金/AFK 抢占）
  muleProc = spawn(process.execPath, ['mule.js'], {
    cwd: ANALYSIS_DIR,
    env: { ...process.env, RO_USER: cfg.account, RO_PASS: cfg.password, RO_SLOT: String(cfg.slot || 0), RO_MULE_PORT: String(MULE_PORT) },
  });
  // 可选联调日志：保留商人侧交易与封包过程，默认仍不落盘。
  const muleLog = process.env.RO_MULE_LOG ? fs.createWriteStream(process.env.RO_MULE_LOG, { flags: 'a' }) : null;
  muleProc.stdout.on('data', (chunk) => { if (muleLog) muleLog.write(chunk); });
  muleProc.stderr.on('data', (chunk) => { if (muleLog) muleLog.write(chunk); });
  muleProc.on('close', () => { if (muleLog) muleLog.end(); });
  muleProc.on('close', () => { muleProc = null; acctRelease(db.muleGet() ? db.muleGet().account : ''); });
  return true;
}
function muleStop() {
  if (!muleProc) return false;
  try { muleProc.kill('SIGTERM'); } catch (_) {}   // mule.js SIGTERM=优雅下号（RESTART 释放，不进离线模式）
  const p = muleProc; setTimeout(() => { try { p.kill('SIGKILL'); } catch (_) {} }, 6000);
  return true;
}
const MULE_PORT = parseInt(process.env.RO_MULE_PORT || '8790', 10);
const muleProxy = async (path, res, opt = {}) => {   // 透传商人控制口；POST 时代发 RO_MULE_KEY（商人端管理门禁）
  const http = require('http');
  const headers = {};
  const body = opt.body != null ? JSON.stringify(opt.body) : null;
  if (body != null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(body); }
  if (process.env.RO_MULE_KEY) headers['X-Api-Key'] = process.env.RO_MULE_KEY;
  const rq = http.request({ host: '127.0.0.1', port: MULE_PORT, path, method: opt.method || 'GET', headers, timeout: 2500 }, (r) => {
    let b = ''; r.on('data', (d) => b += d); r.on('end', () => { res.writeHead(r.statusCode, { 'Content-Type': 'application/json' }); res.end(b); });
  }).on('error', (e) => { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); });
  if (body != null) rq.write(body);
  rq.end();
};

// ==================== AFK 调度器：每 30s 扫描到期账号（串行执行） ====================
db.afkInit();
const afkLogs = new Map();        // id → [lines]
let afkRunning = null;            // {id, account}
const afkQueue = [];
function afkEnqueue(id, why) {
  if (afkQueue.some((x) => x.id === id) || (afkRunning && afkRunning.id === id)) return;
  const rec0 = db.afkGet(id);
  afkQueue.push({ id, why, account: rec0 ? rec0.account : '' });
  afkPump();
}
function afkLog(id, line) {
  const arr = afkLogs.get(id) || [];
  arr.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
  if (arr.length > 300) arr.splice(0, arr.length - 300);
  afkLogs.set(id, arr);
}
function afkPump() {
  if (afkRunning || !afkQueue.length) return;
  const job = afkQueue.shift();
  const rec = db.afkGet(job.id);
  if (!rec) return afkPump();
  // 账号互斥：赏金占用 → 本轮跳过；练级占用 → 抢占（AFK 优先级更高）
  if (!acctAcquire(rec.account, 'afk', { name: rec.char_name })) {
    afkLog(job.id, `⏸ 账号被 ${acctHolderPretty(rec.account)} 占用，跳过本轮巡视`);
    db.afkPatch(job.id, { status: 'deferred', last_check: new Date().toISOString() });
    return setTimeout(afkPump, 1000);
  }
  afkRunning = { id: job.id, account: rec.account };
  db.afkPatch(job.id, { status: 'running' });
  afkLog(job.id, `▶ 巡视开始（${job.why}）`);
  const cfg = {
    account: rec.account, password: rec.password, line: rec.line || 'eden', slot: rec.slot,
    map: rec.map, mobs: JSON.parse(rec.mobs || '[]'), atk: JSON.parse(rec.atk || '{}'), sup: JSON.parse(rec.sup || '{}'),
    attackDis: rec.attack_dis, skillDis: rec.skill_dis, extra: JSON.parse(rec.extra || '{}'),
    log: (m) => afkLog(job.id, m),
  };
  const p = spawn(process.execPath, [path.join(ANALYSIS_DIR, 'afk-runner.js'), 'cycle', '--config', JSON.stringify(cfg)], { cwd: ANALYSIS_DIR });
  afkRunning.proc = p;
  p.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => afkLog(job.id, l.replace(/^\[[^\]]*\]\s*/, ''))));
  p.stderr.on('data', (d) => afkLog(job.id, '⚠ ' + String(d).trim().slice(0, 160)));
  p.on('close', (code) => {
    const logs = afkLogs.get(job.id) || [];
    const note = logs.slice(-2).join(' ').slice(-240);
    const status = code === 0 ? (/alive-offline/.test(note) ? 'alive' : 'recovered') : 'error';
    db.afkPatch(job.id, { status, last_check: new Date().toISOString(), last_note: note.slice(0, 120) });
    afkLog(job.id, `◼ 巡视结束 code=${code} → ${status}`);
    acctRelease(rec.account);
    afkRunning = null;
    setTimeout(afkPump, 5000);   // 账号间隔 5s，降低连接压力
  });
}
setInterval(() => {
  if (afkRunning || afkQueue.length) return;
  const now = Date.now();
  for (const rec of db.afkList()) {
    if (!rec.enabled || !rec.map || !rec.char_name) continue;
    const last = rec.last_check ? Date.parse(rec.last_check) : 0;
    if (now - last >= rec.interval_min * 60 * 1000) afkEnqueue(rec.id, '定时');
  }
}, 30 * 1000);

server.listen(PORT, '127.0.0.1', () => {
  loadTabs();
  // 启动清扫（2026-09-20）：上次进程退出可能留下孤儿 worker（赏金/AFK/练级 会一直挤号）+ 卡死的 bounty_running 状态
  // WB_NO_SWEEP=1 跳过（测试/第二实例用：不清杀 worker、不重置状态、不自动续练）
  if (process.env.WB_NO_SWEEP === '1') {
    console.log('[启动清扫] 已跳过（WB_NO_SWEEP=1）');
  } else {
    try { const out = require('child_process').execSync("pgrep -f 'afk-runner.js|bounty-run.js|leveler.js|mule.js' || true").toString().trim();
      if (out) { out.split('\n').filter((p) => +p !== process.pid).forEach((p) => { try { process.kill(+p, 'SIGKILL'); } catch (_) {} });
        console.log(`[启动清扫] 击杀孤儿 worker: ${out.split('\n').join(',')}`); } } catch (_) {}
    try { const n = db.db.prepare("UPDATE accounts SET status='ready', note='上次运行中断(启动重置)' WHERE status='bounty_running'").run().changes;
      if (n) console.log(`[启动清扫] 重置 ${n} 个 bounty_running 账号状态`); } catch (_) {}
    try { db.lvlInit(); const n2 = db.db.prepare("UPDATE lvl_accounts SET status='pending', note='服务重启，自动续练' WHERE status='running'").run().changes;
      if (n2) { console.log(`[启动清扫] ${n2} 个练级账号重置为 pending`); setTimeout(() => lvlStart(), 3000); } } catch (_) {}
  }
  console.log(`🐱 猫队练级工作台: http://127.0.0.1:${PORT}`);
});
