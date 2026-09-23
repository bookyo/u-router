'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PoolDB } = require('../workbench/db');
const { waveStartAt, nextWaveAt } = require('../workbench/bounty-wave');

function poolFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-bounty-wave-'));
  const dbPath = path.join(dir, 'pool.db');
  const fixture = { pool: new PoolDB(dbPath) };
  t.after(() => { fixture.pool.db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  fixture.add = (account, finishedAt) => fixture.pool.db.prepare(
    "INSERT INTO accounts (account,password,status,finished_at) VALUES (?,?,'ready',?)"
  ).run(account, 'test-only', finishedAt);
  fixture.reopen = () => { fixture.pool.db.close(); fixture.pool = new PoolDB(dbPath); };
  return fixture;
}

test('a completed account is not claimed again in the same wave even if status and cooldown are reset', (t) => {
  const { pool, add } = poolFixture(t);
  add('first', '2026-09-01T00:00:00.000Z');
  add('second', '2026-09-02T00:00:00.000Z');
  pool.markBountyStart('first');
  pool.markBountyEnd('first', 10, 0, '完成');
  pool.db.prepare("UPDATE accounts SET status='ready',cooldown_until='' WHERE account='first'").run();
  assert.equal(pool.claimForBounty().account, 'second');
});

test('Beijing bounty waves change only at 00:15, 06:15, 12:15 and 18:15', () => {
  assert.equal(waveStartAt(Date.parse('2026-09-22T16:14:59Z')), '2026-09-22T10:15:00.000Z');
  assert.equal(waveStartAt(Date.parse('2026-09-22T16:15:00Z')), '2026-09-22T16:15:00.000Z');
  assert.equal(waveStartAt(Date.parse('2026-09-22T22:15:00Z')), '2026-09-22T22:15:00.000Z');
  assert.equal(waveStartAt(Date.parse('2026-09-23T04:15:00Z')), '2026-09-23T04:15:00.000Z');
  assert.equal(waveStartAt(Date.parse('2026-09-23T10:15:00Z')), '2026-09-23T10:15:00.000Z');
  assert.equal(nextWaveAt(Date.parse('2026-09-23T04:14:59Z')), Date.parse('2026-09-23T04:15:00Z'));
});

test('historical successful runs block the current wave after workbench restart', (t) => {
  const fixture = poolFixture(t);
  fixture.add('first', '2026-09-01T00:00:00.000Z');
  fixture.add('second', '2026-09-02T00:00:00.000Z');
  fixture.pool.db.prepare("INSERT INTO bounty_runs (account,started_at,ended_at,tasks,exit_code,note) VALUES (?,'',?,9,0,'完成')")
    .run('first', '2026-09-23T05:12:31.385Z');
  fixture.reopen();
  assert.equal(fixture.pool.claimForBounty([], Date.parse('2026-09-23T05:20:00Z')).account, 'second');
});

test('backfill attributes a cross-boundary run to its recorded start, not its finish', (t) => {
  const fixture = poolFixture(t);
  fixture.add('first', '2026-09-01T00:00:00.000Z');
  fixture.pool.db.prepare("INSERT INTO bounty_runs (account,started_at,ended_at,tasks,exit_code,note) VALUES (?,?,?,?,0,'完成')")
    .run('first', '2026-09-23T04:14:30Z', '2026-09-23T04:16:00Z', 5);
  fixture.reopen();
  const row = fixture.pool.db.prepare('SELECT wave_start FROM bounty_wave_done WHERE account=?').get('first');
  assert.equal(row.wave_start, '2026-09-22T22:15:00.000Z');
});

test('a run finishing after the next boundary belongs to its claimed wave', (t) => {
  const { pool, add } = poolFixture(t);
  add('first', '2026-09-01T00:00:00.000Z');
  const startedAt = Date.parse('2026-09-23T04:14:30Z');
  const wave = pool.markBountyStart('first', startedAt);
  pool.markBountyEnd('first', 5, 0, '完成', 0, { waveStart: wave, endedAt: Date.parse('2026-09-23T04:16:00Z') });
  const row = pool.db.prepare('SELECT wave_start FROM bounty_wave_done WHERE account=?').get('first');
  assert.equal(row.wave_start, '2026-09-22T22:15:00.000Z');
  assert.equal(pool.claimForBounty([], Date.parse('2026-09-23T04:16:01Z')).account, 'first');
});

test('pool wait time sees wave-completed accounts even when their cooldown field is empty', (t) => {
  const { pool, add } = poolFixture(t);
  add('first', '2026-09-01T00:00:00.000Z');
  pool.db.prepare('INSERT INTO bounty_wave_done (account,wave_start,completed_at,tasks) VALUES (?,?,?,10)')
    .run('first', '2026-09-23T04:15:00.000Z', '2026-09-23T05:12:00.000Z');
  const info = pool.poolCooldownInfo(Date.parse('2026-09-23T05:20:00Z'));
  assert.equal(info.total, 1);
  assert.equal(info.claimable, 0);
  assert.equal(info.earliestCooldown, '2026-09-23T10:15:00.000Z');
});

test('two automatic tabs skip a finished account until the next wave, then may reclaim it', (t) => {
  const { pool, add } = poolFixture(t);
  add('first', '2026-09-01T00:00:00.000Z');
  add('second', '2026-09-02T00:00:00.000Z');
  const startedAt = Date.parse('2026-09-23T05:00:00Z');
  assert.equal(pool.claimForBounty([], startedAt).account, 'first');
  const wave = pool.markBountyStart('first', startedAt);
  assert.equal(pool.claimForBounty([], startedAt + 1000).account, 'second');
  pool.markBountyStart('second', startedAt + 1000);
  const endedAt = Date.parse('2026-09-23T05:10:00Z');
  pool.markBountyEnd('first', 10, 0, '完成', Date.parse('2026-09-23T10:15:00Z') - endedAt, { waveStart: wave, endedAt, startedAt: new Date(startedAt).toISOString() });
  pool.db.prepare("UPDATE accounts SET status='ready',cooldown_until='' WHERE account='first'").run();
  assert.equal(pool.claimForBounty(['second'], Date.parse('2026-09-23T05:11:00Z')), null);
  assert.equal(pool.claimForBounty([], Date.parse('2026-09-23T10:15:00Z')).account, 'first');
});

test('zero-task normal completion still blocks same-wave re-claim, while an error does not', (t) => {
  const { pool, add } = poolFixture(t);
  add('finished', '2026-09-01T00:00:00.000Z');
  add('failed', '2026-09-02T00:00:00.000Z');
  const at = Date.parse('2026-09-23T05:00:00Z');
  const wave = pool.markBountyStart('finished', at);
  pool.markBountyEnd('finished', 0, 0, '无任务正常收官', 0, { waveStart: wave, endedAt: at + 1000 });
  pool.db.prepare("UPDATE accounts SET status='ready',cooldown_until='' WHERE account='finished'").run();
  const failedWave = pool.markBountyStart('failed', at);
  pool.markBountyEnd('failed', 0, 1, '异常', 0, { waveStart: failedWave, endedAt: at + 1000 });
  assert.equal(pool.claimForBounty([], at + 2000).account, 'failed');
  assert.equal(pool.db.prepare("SELECT COUNT(*) AS n FROM bounty_wave_done WHERE account='failed'").get().n, 0);
});
