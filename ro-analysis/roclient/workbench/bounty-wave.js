'use strict';

const BJ_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HOURS = [0, 6, 12, 18];

function schedule() {
  const raw = process.env.WB_BOUNTY_WAVES;
  const parsed = raw ? [...new Set(raw.split(',').map(Number))].filter((h) => Number.isInteger(h) && h >= 0 && h < 24).sort((a, b) => a - b) : DEFAULT_HOURS;
  const offset = Number(process.env.WB_BOUNTY_WAVE_OFFSET_MIN ?? 15);
  return { hours: parsed.length ? parsed : DEFAULT_HOURS, offsetMs: (Number.isInteger(offset) && offset >= 0 && offset < 60 ? offset : 15) * 60000 };
}

function midnightInBeijing(ms) {
  const date = new Date(ms + BJ_OFFSET_MS);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - BJ_OFFSET_MS;
}

function waveStartAt(time = Date.now()) {
  const ms = Number(time);
  if (!Number.isFinite(ms)) throw new TypeError('invalid bounty wave time');
  const { hours, offsetMs } = schedule();
  const midnight = midnightInBeijing(ms);
  for (const day of [0, -1]) {
    for (let i = hours.length - 1; i >= 0; i--) {
      const boundary = midnight + day * DAY_MS + hours[i] * HOUR_MS + offsetMs;
      if (boundary <= ms) return new Date(boundary).toISOString();
    }
  }
  throw new Error('bounty wave boundary not found');
}

function nextWaveAt(time = Date.now()) {
  const ms = Number(time);
  if (!Number.isFinite(ms)) throw new TypeError('invalid bounty wave time');
  const { hours, offsetMs } = schedule();
  const midnight = midnightInBeijing(ms);
  for (const day of [0, 1]) {
    for (const hour of hours) {
      const boundary = midnight + day * DAY_MS + hour * HOUR_MS + offsetMs;
      if (boundary > ms) return boundary;
    }
  }
  throw new Error('next bounty wave boundary not found');
}

module.exports = { waveStartAt, nextWaveAt };
