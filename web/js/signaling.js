// WebSocket connection to the Swipe server.

export class Signaling extends EventTarget {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this._ping = null;
  }

  connect(timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.close();
          reject(new Error('Could not reach the server (timed out).'));
        }
      }, timeoutMs);
      ws.onopen = () => {
        settled = true;
        clearTimeout(timer);
        this._ping = setInterval(() => this.send({ t: 'ping' }), 20_000);
        resolve();
      };
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('Could not reach the server.'));
        }
      };
      ws.onclose = (e) => {
        clearInterval(this._ping);
        this.dispatchEvent(new CustomEvent('close', { detail: { code: e.code, reason: e.reason } }));
      };
      ws.onmessage = (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === 'pong') return;
        this.dispatchEvent(new CustomEvent('message', { detail: msg }));
      };
    });
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(obj) {
    if (this.open) this.ws.send(JSON.stringify(obj));
  }

  // Resolves with the next message matching the predicate.
  waitFor(pred, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const onMsg = (e) => {
        if (pred(e.detail)) {
          cleanup();
          resolve(e.detail);
        }
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Lost connection to the server.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('The server did not answer in time.'));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.removeEventListener('message', onMsg);
        this.removeEventListener('close', onClose);
      };
      this.addEventListener('message', onMsg);
      this.addEventListener('close', onClose);
    });
  }

  close() {
    clearInterval(this._ping);
    this.ws?.close();
  }
}

export const SERVER_ERRORS = {
  not_found: 'No device is sharing with that code right now. Check the code and that the other device is still sharing.',
  locked: 'Too many wrong passwords for this code. Try again later.',
  rate_limited: 'Too many attempts from this network. Wait a minute and try again.',
  full: 'That device already has the maximum number of viewers.',
  busy: 'Someone else is connecting to that device right now. Try again in a moment.',
  auth_failed: 'Wrong password.',
  kicked: 'The other device ended the connection.',
  timeout: 'The connection took too long to set up.',
  replaced: 'This device started sharing from another window.',
};
