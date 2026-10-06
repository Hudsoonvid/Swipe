// Assigns each host device a stable 9-digit code. A device identifies itself
// with a random secret "device key"; only its SHA-256 is stored, so knowing a
// code does not let anyone else host under it.

import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DAY = 24 * 3600 * 1000;

export function hashKey(key) {
  return createHash('sha256').update(String(key)).digest('base64url');
}

export function isValidDeviceKey(key) {
  return typeof key === 'string' && /^[A-Za-z0-9_-]{22,128}$/.test(key);
}

export class CodeRegistry {
  constructor({ dataDir = '', expiryDays = 60 } = {}) {
    this.byKey = new Map(); // keyHash -> { code, seen }
    this.byCode = new Map(); // code -> keyHash
    this.expiryMs = expiryDays * DAY;
    this.file = dataDir ? path.join(dataDir, 'codes.json') : '';
    this._saveTimer = null;
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const now = Date.now();
      for (const [kh, { code, seen }] of Object.entries(data)) {
        if (now - seen < this.expiryMs && /^\d{9}$/.test(code) && !this.byCode.has(code)) {
          this.byKey.set(kh, { code, seen });
          this.byCode.set(code, kh);
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[codes] could not load', this.file, e.message);
    }
  }

  _scheduleSave() {
    if (!this.file || this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = this.file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.byKey)));
        fs.renameSync(tmp, this.file);
      } catch (e) {
        console.warn('[codes] could not save', e.message);
      }
    }, 2000);
    this._saveTimer.unref?.();
  }

  // Returns the code for a device key, allocating one if needed.
  codeFor(deviceKey) {
    const kh = hashKey(deviceKey);
    const now = Date.now();
    let entry = this.byKey.get(kh);
    if (!entry) {
      this._expire(now);
      let code;
      do {
        code = String(randomInt(100_000_000, 1_000_000_000));
      } while (this.byCode.has(code));
      entry = { code, seen: now };
      this.byKey.set(kh, entry);
      this.byCode.set(code, kh);
    }
    entry.seen = now;
    this._scheduleSave();
    return entry.code;
  }

  _expire(now) {
    for (const [kh, e] of this.byKey) {
      if (now - e.seen > this.expiryMs) {
        this.byKey.delete(kh);
        this.byCode.delete(e.code);
      }
    }
  }
}
