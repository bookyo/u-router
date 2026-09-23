'use strict';
/**
 * 练级账号池数据库（SQLite，node:sqlite 内置）
 * ============================================================
 * 练满 12 只 30 级猫的账号入库（status=ready），赏金 worker 从这里领号，
 * 练级（leveler）与赏金（bounty-run）两个阶段的交接点。
 *
 * 表：
 *   accounts  账号池：account/password/status(ready|bounty_running|bounty_done|error)
 *             bounty_runs/bounty_tasks 累计，finished_at 入池时间
 *   chars     每账号 12 只猫：name/slot/level/job
 *   bounty_runs  每次赏金执行记录：account/started_at/ended_at/tasks/exit_code
 *   bounty_wave_done  每账号每波次的完成记录；领号时优先排除
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { waveStartAt, nextWaveAt } = require('./bounty-wave');

class PoolDB {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout = 5000;');   // 多进程并发（工作台 + market-scan 入库）防 SQLITE_BUSY
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        login_name TEXT DEFAULT '',
        plan TEXT DEFAULT '',
        status TEXT DEFAULT 'ready',
        created_at TEXT DEFAULT '',
        finished_at TEXT DEFAULT '',
        bounty_runs INTEGER DEFAULT 0,
        bounty_tasks INTEGER DEFAULT 0,
        last_bounty_at TEXT DEFAULT '',
        note TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS chars (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL,
        name TEXT, slot INTEGER, level INTEGER, job INTEGER DEFAULT 4218,
        UNIQUE(account_id, slot)
      );
      CREATE TABLE IF NOT EXISTS bounty_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT, started_at TEXT, ended_at TEXT,
        tasks INTEGER DEFAULT 0, exit_code INTEGER, note TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS bounty_wave_done (
        account TEXT NOT NULL,
        wave_start TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        tasks INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account, wave_start)
      );
    `);
    // 旧库迁移：加冷却列（NPC 提示"每6小时自动刷新"，跑完的号 6h 内无新任务）
    try { this.db.exec("ALTER TABLE accounts ADD COLUMN cooldown_until TEXT DEFAULT ''"); } catch (_) {}
    // 旧进程可能已记录成功运行，却没有波次完成行；从历史补齐，不改动当前 worker。
    const insertDone = this.db.prepare('INSERT OR IGNORE INTO bounty_wave_done (account,wave_start,completed_at,tasks) VALUES (?,?,?,?)');
    for (const run of this.db.prepare("SELECT account,started_at,ended_at,tasks FROM bounty_runs WHERE exit_code=0 AND ended_at<>''").all()) {
      const endedAt = Date.parse(run.ended_at);
      const startedAt = Date.parse(run.started_at);
      if (run.account && Number.isFinite(endedAt)) insertDone.run(run.account, waveStartAt(Number.isFinite(startedAt) ? startedAt : endedAt), new Date(endedAt).toISOString(), run.tasks || 0);
    }
  }

  // ---------- 账号池 ----------
  // 从 leveler 存档 JSON 导入/更新一个账号（只在全部角色 ≥lv 时入 ready 池）
  importAccount(rec, lvDone = 30) {
    const chars = (rec.chars || []).filter((c) => c && c.name);
    const allDone = chars.length > 0 && chars.every((c) => (c.level || 0) >= lvDone);
    if (!allDone) return false;
    const finishedAt = chars.map((c) => c.doneAt).filter(Boolean).sort().pop() || new Date().toISOString();
    this.db.prepare(`
      INSERT INTO accounts (account, password, login_name, plan, status, created_at, finished_at)
      VALUES (?, ?, ?, ?, 'ready', ?, ?)
      ON CONFLICT(account) DO UPDATE SET
        password=excluded.password, login_name=excluded.login_name, plan=excluded.plan,
        finished_at=excluded.finished_at,
        status=CASE WHEN accounts.status IN ('bounty_running','bounty_done')
                    THEN accounts.status ELSE 'ready' END
    `).run(rec.loginName || stripM(rec.account), rec.password, stripM(rec.account), rec.plan || '', rec.createdAt || '', finishedAt);
    const accId = this.accountId(stripM(rec.account));
    const upCh = this.db.prepare(`
      INSERT INTO chars (account_id, name, slot, level, job) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, slot) DO UPDATE SET name=excluded.name, level=excluded.level`);
    for (const ch of chars) upCh.run(accId, ch.name, ch.slot, ch.level || lvDone, 4218);
    return true;
  }

  accountId(loginName) {
    const row = this.db.prepare('SELECT id FROM accounts WHERE account=?').get(loginName);
    return row ? row.id : null;
  }

  // 扫描 leveler 存档文件（主 accounts.json + 工作台 tab 文件），把 done 账号同步入库
  syncFromFiles(files) {
    let n = 0;
    for (const f of files) {
      let list = null;
      try { list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { continue; }
      if (!Array.isArray(list)) continue;   // 非账号存档结构（如赏金输出 bounty-*.json）
      for (const rec of list) {
        if (this.importAccount(rec)) n++;
      }
    }
    return n;
  }

  // 赏金 worker 领号：必须同时满足冷却到期、本波次未完成。
  claimForBounty(excludeAccounts = [], now = Date.now()) {
    const row = this.db.prepare(`
      SELECT a.* FROM accounts a
      WHERE a.status IN ('ready','bounty_done','error') AND a.account NOT IN (${excludeAccounts.length ? excludeAccounts.map(() => '?').join(',') : "''"})
        AND (a.cooldown_until = '' OR a.cooldown_until <= ?)
        AND NOT EXISTS (SELECT 1 FROM bounty_wave_done d WHERE d.account = a.account AND d.wave_start = ?)
      ORDER BY CASE a.status WHEN 'ready' THEN 0 ELSE 1 END, a.finished_at ASC LIMIT 1
    `).all(...excludeAccounts, new Date(now).toISOString(), waveStartAt(now));
    return row[0] || null;
  }

  // 冷却概况：池里还有号但都在冷却 → 返回最早到期时间（用于"等待冷却"倒计时）
  poolCooldownInfo(now = Date.now()) {
    const rows = this.db.prepare(`
      SELECT a.cooldown_until, d.account IS NOT NULL AS wave_done FROM accounts a
      LEFT JOIN bounty_wave_done d ON d.account=a.account AND d.wave_start=?
      WHERE a.status IN ('ready','bounty_done','error')
    `).all(waveStartAt(now));
    let claimable = 0, earliest = Infinity;
    for (const row of rows) {
      const cooldown = Date.parse(row.cooldown_until);
      if (row.wave_done) earliest = Math.min(earliest, Math.max(nextWaveAt(now), Number.isFinite(cooldown) ? cooldown : 0));
      else if (Number.isFinite(cooldown) && cooldown > now) earliest = Math.min(earliest, cooldown);
      else claimable++;
    }
    return { total: rows.length, claimable, earliestCooldown: Number.isFinite(earliest) ? new Date(earliest).toISOString() : null };
  }

  // 手动添加外部账号入池（工作台表单 / 赏金标签手动账号）：
  // 新号 ready 可被领；已有号只更新密码，保留冷却/状态
  upsertExternal(account, password, plan = 'manual') {
    const acct = String(account || '').trim().replace(/_M$/, '');
    if (!acct || !password) return false;
    this.db.prepare(`
      INSERT INTO accounts (account, password, login_name, plan, status, created_at, finished_at)
      VALUES (?, ?, ?, ?, 'ready', ?, ?)
      ON CONFLICT(account) DO UPDATE SET
        password=excluded.password,
        status=CASE WHEN accounts.status IN ('bounty_running','bounty_done')
                    THEN accounts.status ELSE 'ready' END
    `).run(acct, String(password), acct, plan, new Date().toISOString(), new Date().toISOString());
    return true;
  }

  removeAccount(account) {
    this.db.prepare('DELETE FROM accounts WHERE account=?').run(String(account || '').replace(/_M$/, ''));
  }

  setStatus(account, status, note = '') {
    this.db.prepare('UPDATE accounts SET status=?, note=? WHERE account=?').run(status, note, account);
  }
  markBountyStart(account, startedAt = Date.now()) {
    this.db.prepare(`UPDATE accounts SET status='bounty_running', bounty_runs=bounty_runs+1, last_bounty_at=? WHERE account=?`)
      .run(new Date(startedAt).toISOString(), account);
    console.log(`[pool] markBountyStart ${account} → bounty_running`);
    return waveStartAt(startedAt);
  }
  markBountyEnd(account, tasks, exitCode, note = '', cooldownMs = 6 * 3600 * 1000, options = {}) {
    const now = options.endedAt ?? Date.now();
    const cd = new Date(now + cooldownMs).toISOString();
    const completedAt = new Date(now).toISOString();
    const waveStart = options.waveStart || waveStartAt(now);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE accounts SET status=?, cooldown_until=?, bounty_tasks=bounty_tasks+?, note=? WHERE account=?`)
        .run(exitCode === 0 ? 'bounty_done' : 'error', cd, tasks || 0, note, account);
      this.db.prepare('INSERT INTO bounty_runs (account, started_at, ended_at, tasks, exit_code, note) VALUES (?,?,?,?,?,?)')
        .run(account, options.startedAt || '', completedAt, tasks || 0, exitCode, note);
      if (exitCode === 0) this.db.prepare('INSERT OR IGNORE INTO bounty_wave_done (account,wave_start,completed_at,tasks) VALUES (?,?,?,?)')
        .run(account, waveStart, completedAt, tasks || 0);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    console.log(`[pool] markBountyEnd ${account} → ${exitCode === 0 ? 'bounty_done' : 'error'} 冷却至 ${cd.slice(11, 16)}Z（tasks+${tasks || 0}, ${note}）`);
  }

  pool() {
    return this.db.prepare(`
      SELECT a.*, (SELECT COUNT(*) FROM chars c WHERE c.account_id=a.id) AS chars
      FROM accounts a ORDER BY a.finished_at DESC
    `).all();
  }

  // ==================== 挂机保姆（AFK） ====================
  afkInit() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS afk_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        line TEXT DEFAULT 'eden',
        slot INTEGER DEFAULT 0,
        char_name TEXT DEFAULT '',
        char_level INTEGER DEFAULT 0,
        map TEXT DEFAULT '',
        mobs TEXT DEFAULT '[]',
        atk TEXT DEFAULT '{}',
        sup TEXT DEFAULT '{}',
        attack_dis INTEGER DEFAULT 1,
        skill_dis INTEGER DEFAULT 2,
        extra TEXT DEFAULT '{}',
        interval_min INTEGER DEFAULT 60,
        enabled INTEGER DEFAULT 1,
        status TEXT DEFAULT 'idle',
        last_check TEXT DEFAULT '',
        last_note TEXT DEFAULT ''
      );
    `);
  }
  afkList() {
    return this.db.prepare('SELECT * FROM afk_accounts ORDER BY id').all()
      .map((r) => ({ ...r, mobs: JSON.parse(r.mobs || '[]'), atk: JSON.parse(r.atk || '{}'), sup: JSON.parse(r.sup || '{}'), extra: JSON.parse(r.extra || '{}') }));
  }
  afkUpsert(rec) {
    const cur = this.db.prepare('SELECT id FROM afk_accounts WHERE account=?').get(rec.account);
    if (cur) {
      this.db.prepare(`UPDATE afk_accounts SET password=?, line=?, slot=?, char_name=?, char_level=?, map=?, mobs=?, atk=?, sup=?, attack_dis=?, skill_dis=?, extra=?, interval_min=?, enabled=? WHERE id=?`)
        .run(rec.password || '', rec.line || 'eden', rec.slot | 0, rec.char_name || '', rec.char_level | 0, rec.map || '',
          JSON.stringify(rec.mobs || []), JSON.stringify(rec.atk || {}), JSON.stringify(rec.sup || {}),
          rec.attack_dis | 0 || 1, rec.skill_dis | 0 || 2, JSON.stringify(rec.extra || {}), rec.interval_min || 60, rec.enabled ? 1 : 0, cur.id);
      return cur.id;
    }
    const r = this.db.prepare(`INSERT INTO afk_accounts (account,password,line,slot,char_name,char_level,map,mobs,atk,sup,attack_dis,skill_dis,extra,interval_min,enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(rec.account, rec.password || '', rec.line || 'eden', rec.slot | 0, rec.char_name || '', rec.char_level | 0, rec.map || '',
        JSON.stringify(rec.mobs || []), JSON.stringify(rec.atk || {}), JSON.stringify(rec.sup || {}),
        rec.attack_dis | 0 || 1, rec.skill_dis | 0 || 2, JSON.stringify(rec.extra || {}), rec.interval_min || 60, rec.enabled ? 1 : 0);
    return Number(r.lastInsertRowid);
  }
  afkPatch(id, fields) {
    const cols = { line: 1, slot: 1, char_name: 1, char_level: 1, map: 1, mobs: 'J', atk: 'J', sup: 'J', attack_dis: 1, skill_dis: 1, extra: 'J', interval_min: 1, enabled: 1, status: 1, last_check: 1, last_note: 1, password: 1 };
    const sets = [], vals = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!cols[k]) continue;
      sets.push(`${k}=?`);
      vals.push(cols[k] === 'J' ? JSON.stringify(v) : v);
    }
    if (!sets.length) return;
    vals.push(id);
    this.db.prepare(`UPDATE afk_accounts SET ${sets.join(',')} WHERE id=?`).run(...vals);
  }
  afkDelete(id) { this.db.prepare('DELETE FROM afk_accounts WHERE id=?').run(id); }

  // ==================== 老号练级中心 ====================
  lvlInit() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS lvl_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      status TEXT DEFAULT 'pending',   -- pending/running/done/error
      note TEXT DEFAULT '', updated_at TEXT DEFAULT ''
    );`);
  }
  lvlList() { return this.db.prepare('SELECT * FROM lvl_accounts ORDER BY id').all(); }
  lvlUpsert(acct, pw) {
    if (this.db.prepare('SELECT id FROM lvl_accounts WHERE account=?').get(acct)) {
      this.db.prepare('UPDATE lvl_accounts SET password=?, status=CASE WHEN status=\'done\' THEN \'done\' ELSE \'pending\' END WHERE account=?').run(pw, acct);
      return;
    }
    this.db.prepare('INSERT INTO lvl_accounts (account,password) VALUES (?,?)').run(acct, pw);
  }
  lvlPatch(id, fields) {
    const sets = [], vals = [];
    for (const k of ['status', 'note']) if (fields[k] !== undefined) { sets.push(`${k}=?`); vals.push(fields[k]); }
    if (!sets.length) return;
    sets.push('updated_at=?'); vals.push(new Date().toISOString());
    vals.push(id);
    this.db.prepare(`UPDATE lvl_accounts SET ${sets.join(',')} WHERE id=?`).run(...vals);
  }
  lvlDelete(id) { this.db.prepare('DELETE FROM lvl_accounts WHERE id=?').run(id); }

  // ==================== 爬店标签 ====================
  marketConfigInit() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS market_config (
      id INTEGER PRIMARY KEY CHECK (id=1),
      account TEXT DEFAULT '', password TEXT DEFAULT '',
      slot INTEGER DEFAULT 0, enabled INTEGER DEFAULT 0,
      status TEXT DEFAULT 'idle', last_run TEXT DEFAULT '',
      note TEXT DEFAULT '', interval_min INTEGER DEFAULT 0
    )`);
    try { this.db.exec("INSERT INTO market_config (id) VALUES (1)"); } catch (_) {}
    try { this.db.exec("ALTER TABLE market_config ADD COLUMN interval_min INTEGER DEFAULT 0"); } catch (_) {}   // 旧表升级（列已存在则静默）
  }
  marketConfigGet() { return this.db.prepare('SELECT * FROM market_config WHERE id=1').get(); }
  marketConfigSet(account, password, slot) {
    this.db.prepare('UPDATE market_config SET account=?, password=?, slot=? WHERE id=1').run(account, password, slot);
  }
  marketConfigPatch(fields) {
    const sets = [], vals = [];
    for (const k of ['status', 'last_run', 'note', 'enabled', 'interval_min']) if (fields[k] !== undefined) { sets.push(`${k}=?`); vals.push(fields[k]); }
    if (!sets.length) return;
    vals.push(1);
    this.db.prepare(`UPDATE market_config SET ${sets.join(',')} WHERE id=?`).run(...vals);
  }

  // ==================== 市场商品库（爬店标准化） ====================
  marketInit() {
    this.db.exec(`
      DROP TABLE IF EXISTS market_items;   -- 全量替换式入库（原写作 IF NOT EXISTS 是非法 SQL，一调即炸——2026-09-22）
      CREATE TABLE market_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ITID INTEGER NOT NULL,
        name TEXT DEFAULT '',
        price INTEGER NOT NULL,
        qty INTEGER DEFAULT 1,
        type INTEGER DEFAULT 0,
        options TEXT DEFAULT '[]',
        opt_ids TEXT DEFAULT '',
        opt_labels TEXT DEFAULT '',
        shop_title TEXT DEFAULT '',
        shop_x INTEGER, shop_y INTEGER,
        city TEXT DEFAULT '',
        map_name TEXT DEFAULT '',
        owner_name TEXT DEFAULT '',
        owner_aid INTEGER,
        scraped_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_market_itid ON market_items(ITID);
      CREATE INDEX IF NOT EXISTS idx_market_price ON market_items(price);
      CREATE INDEX IF NOT EXISTS idx_market_city ON market_items(city);
    `);
  }
  marketUpsertAll(items) {
    this.marketInit();
    const stmt = this.db.prepare(`INSERT INTO market_items
      (ITID,name,price,qty,type,options,opt_ids,opt_labels,shop_title,shop_x,shop_y,city,map_name,owner_name,owner_aid,scraped_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const now = new Date().toISOString();
    this.db.exec('BEGIN');
    for (const it of items) {
      const opts = (it.options || []).filter((o) => o.id);
      stmt.run(
        it.ITID, it.name || '', it.price, it.qty || 1, it.type || 0,
        JSON.stringify(opts),
        opts.map((o) => o.id).join(','),
        opts.map((o) => o.label || '').join('|'),
        it.shopTitle || '', it.shopX, it.shopY,
        it.city || '', it.mapName || '',
        it.ownerName || '', it.ownerAID || 0,
        now
      );
    }
    this.db.exec('COMMIT');
  }
  marketSearch(q) {
    const where = [], vals = [];
    if (q.keyword) { where.push('name LIKE ?'); vals.push(`%${q.keyword}%`); }
    if (q.city) { where.push('city = ?'); vals.push(q.city); }
    if (q.ITID) { where.push('ITID = ?'); vals.push(q.ITID); }
    if (q.minPrice != null) { where.push('price >= ?'); vals.push(q.minPrice); }
    if (q.maxPrice != null) { where.push('price <= ?'); vals.push(q.maxPrice); }
    if (q.type != null) { where.push('type = ?'); vals.push(q.type); }
    if (q.optId) { where.push("(',' || opt_ids || ',') LIKE ?"); vals.push(`%,${q.optId},%`); }
    const order = q.orderBy === 'price_desc' ? 'price DESC' : 'price ASC';
    const lim = Math.min(q.limit || 50, 500);
    return this.db.prepare(`SELECT * FROM market_items ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${lim}`).all(...vals);
  }

  // ==================== 常驻商人（mule） ====================
  muleInit() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS mule_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      account TEXT DEFAULT '', password TEXT DEFAULT '', slot INTEGER DEFAULT 0
    );`);
    try { this.db.exec("INSERT INTO mule_config (id) VALUES (1)"); } catch (_) {}
  }
  muleGet() { return this.db.prepare('SELECT * FROM mule_config WHERE id=1').get(); }
  muleSet(account, password, slot) {
    this.db.prepare('UPDATE mule_config SET account=?, password=?, slot=? WHERE id=1').run(account, password, slot);
  }
  afkGet(id) { return this.db.prepare('SELECT * FROM afk_accounts WHERE id=?').get(id); }
}

const stripM = (name) => String(name || '').replace(/_M$/, '');

module.exports = { PoolDB };
