const { isIP } = require('node:net');

const LIMIT = 20;
const WINDOW_MS = 60_000;

function normalizeIp(value) {
  if (typeof value !== 'string' || !isIP(value)) return null;
  if (isIP(value) === 4) return value;
  let canonical;
  try { canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1); } catch { return null; }
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/i.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function trustedIps(values) {
  if (!Array.isArray(values)) throw new Error('trustedProxyIps must be an array of IP addresses');
  return new Set(values.map((value) => {
    const ip = normalizeIp(value);
    if (!ip) throw new Error('trustedProxyIps contains an invalid IP address');
    return ip;
  }));
}

function clientIp(request, trusted) {
  const peer = normalizeIp(request.socket.remoteAddress) ?? 'unknown';
  if (!trusted.has(peer)) return peer;
  const header = request.headers['x-forwarded-for'];
  if (typeof header !== 'string') return peer;
  const chain = header.split(',').map((value) => normalizeIp(value.trim()));
  // Malformed chains fail closed to the socket quota; do not accept arbitrary strings as new IPs.
  if (chain.length > 32 || chain.some((ip) => ip === null)) return peer;
  for (let i = chain.length - 1; i >= 0; i--) if (!trusted.has(chain[i])) return chain[i];
  return chain[0] ?? peer;
}

class ReadRateLimiter {
  constructor({ now = Date.now, maxIps = 100_000 } = {}) {
    this.now = now;
    this.maxIps = maxIps;
    this.buckets = new Map();
    this.nextSweep = 0;
  }

  consume(ip) {
    const now = this.now();
    const cutoff = now - WINDOW_MS;
    if (now >= this.nextSweep) {
      for (const [key, timestamps] of this.buckets) {
        if (timestamps.at(-1) <= cutoff) this.buckets.delete(key);
      }
      this.nextSweep = now + WINDOW_MS;
    }
    let timestamps = this.buckets.get(ip);
    if (!timestamps) {
      // Bound memory under an IP flood; never evict active clients and reset their quota.
      if (this.buckets.size >= this.maxIps) return { allowed: false, remaining: 0, retryAfter: 60 };
      timestamps = [];
      this.buckets.set(ip, timestamps);
    }
    while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
    if (timestamps.length >= LIMIT) {
      return { allowed: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((timestamps[0] + WINDOW_MS - now) / 1000)) };
    }
    timestamps.push(now);
    return { allowed: true, remaining: LIMIT - timestamps.length };
  }
}

module.exports = { ReadRateLimiter, normalizeIp, trustedIps, clientIp, LIMIT };
