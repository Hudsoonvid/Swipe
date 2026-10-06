// Small in-memory token buckets keyed by string (IP address, code, ...).

export class RateLimiter {
  constructor({ capacity, refillPerSec }) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.buckets = new Map();
    this._gc = setInterval(() => this._sweep(), 60_000);
    this._gc.unref?.();
  }

  take(key, cost = 1) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, t: now };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(this.capacity, b.tokens + ((now - b.t) / 1000) * this.refillPerSec);
    b.t = now;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    return true;
  }

  _sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) {
      if (b.tokens + ((now - b.t) / 1000) * this.refillPerSec >= this.capacity) this.buckets.delete(k);
    }
  }

  close() {
    clearInterval(this._gc);
  }
}

// Tracks failed password attempts per code and locks the code with an
// exponential backoff once too many fail.
export class FailureTracker {
  constructor({ threshold, windowMs }) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.entries = new Map(); // key -> { count, first, lockedUntil }
  }

  lockedFor(key) {
    const e = this.entries.get(key);
    if (!e) return 0;
    const now = Date.now();
    if (e.lockedUntil > now) return e.lockedUntil - now;
    if (now - e.first > this.windowMs && e.lockedUntil <= now) this.entries.delete(key);
    return 0;
  }

  fail(key) {
    const now = Date.now();
    let e = this.entries.get(key);
    if (!e || (now - e.first > this.windowMs && e.lockedUntil <= now)) {
      e = { count: 0, first: now, lockedUntil: 0 };
      this.entries.set(key, e);
    }
    e.count++;
    if (e.count >= this.threshold) {
      const over = e.count - this.threshold;
      e.lockedUntil = now + Math.min(60_000 * 2 ** over, 3600_000);
      e.first = now;
    }
  }

  reset(key) {
    this.entries.delete(key);
  }
}
