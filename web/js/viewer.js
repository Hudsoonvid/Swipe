// Viewing side: joins a code, proves the password with SPAKE2, then receives
// the screen and sends input over WebRTC data channels.

import { Spake2, normalizeCode } from './crypto.js';
import { Signaling, SERVER_ERRORS } from './signaling.js';
import { tuneReceiver, readStats } from './rtc.js';
import { wsUrl } from './config.js';

export class ViewerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class ViewerSession extends EventTarget {
  constructor({ server, code, password, name, platform }) {
    super();
    this.server = server;
    this.code = normalizeCode(code);
    this.password = password;
    this.name = name;
    this.platform = platform;
    this.info = null; // latest host info (from the ctrl channel)
    this.hostInfo = null; // info from the server at join time
    this.state = 'idle';
    this.pc = null;
    this.stream = new MediaStream();
    this._sendQueue = Promise.resolve();
    this._recvQueue = Promise.resolve();
    this._stats = {};
  }

  _setState(state, detail = {}) {
    if (this.state === state) return;
    this.state = state;
    this.dispatchEvent(new CustomEvent('state', { detail: { state, ...detail } }));
  }

  async connect() {
    this._setState('connecting');
    if (!/^\d{9}$/.test(this.code)) throw new ViewerError('bad_code', 'Codes have 9 digits.');
    const sig = new Signaling(wsUrl(this.server));
    this.sig = sig;
    await sig.connect();
    sig.addEventListener('message', (e) => this._onSignal(e.detail));
    sig.addEventListener('close', () => this._onSignalLost());

    sig.send({ t: 'join', code: this.code });
    const joined = await sig.waitFor((m) => m.t === 'joined' || m.t === 'error');
    if (joined.t === 'error') throw new ViewerError(joined.error, this._errorText(joined));
    this.hostInfo = joined.host;
    this.ice = joined.ice || [];
    this.dispatchEvent(new CustomEvent('joined', { detail: joined.host }));

    // SPAKE2: one password guess per attempt; the server never sees it.
    this._setState('authenticating');
    const spake = new Spake2('viewer', this.code, this.password);
    const X = await spake.start();
    const reply = sig.waitFor((m) => (m.t === 'msg' && m.data?.type === 'pake2') || m.t === 'error' || m.t === 'hostgone');
    sig.send({ t: 'msg', data: { type: 'pake1', X } });
    const p2 = await reply;
    if (p2.t === 'error') throw new ViewerError(p2.error, this._errorText(p2));
    if (p2.t === 'hostgone') throw new ViewerError('hostgone', 'The other device stopped sharing.');
    let confirm;
    try {
      confirm = await spake.finish(p2.data.Y);
    } catch {
      throw new ViewerError('protocol', 'The other device sent an invalid response.');
    }
    const ok = spake.verify(p2.data.confirm);
    if (ok) this.channel = await spake.channel();
    sig.send({ t: 'msg', data: { type: 'pake3', confirm } });
    if (!ok) {
      sig.close();
      throw new ViewerError('auth_failed', SERVER_ERRORS.auth_failed);
    }
    this._secureSend({ type: 'hello', name: this.name, platform: this.platform });

    // Wait until media flows (or give up).
    this._setState('negotiating');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new ViewerError(
            'ice',
            'Could not open a direct connection between the devices. If one of them is on mobile data or a strict network, the server needs a TURN relay (see README).'
          )
        );
      }, 30_000);
      const onState = (e) => {
        if (e.detail.state === 'connected') {
          cleanup();
          resolve();
        } else if (e.detail.state === 'closed') {
          cleanup();
          reject(new ViewerError(e.detail.reason || 'closed', e.detail.message || 'The connection was closed.'));
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.removeEventListener('state', onState);
      };
      this.addEventListener('state', onState);
    });
  }

  _errorText(m) {
    if (m.error === 'locked' && m.retryIn) {
      return `${SERVER_ERRORS.locked} (about ${Math.ceil(m.retryIn / 60)} min)`;
    }
    return SERVER_ERRORS[m.error] || `The server said: ${m.error}`;
  }

  _onSignal(m) {
    if (m.t === 'msg' && m.data?.type === 'sec' && this.channel) {
      this._recvQueue = this._recvQueue
        .then(async () => this._onSecure(await this.channel.open(m.data)))
        .catch((e) => {
          console.warn('secure message rejected', e);
          this.close('protocol', 'The connection was tampered with or corrupted.');
        });
    } else if (m.t === 'hostgone') {
      this._hostGone = true;
      if (this.state !== 'connected') this.close('hostgone', 'The other device stopped sharing.');
    } else if (m.t === 'error' && ['kicked', 'timeout', 'auth_failed'].includes(m.error)) {
      this.close(m.error, SERVER_ERRORS[m.error]);
    }
  }

  _onSignalLost() {
    // Once connected, media flows peer-to-peer and survives server hiccups.
    if (this.state !== 'connected' && this.state !== 'closed' && this.channel) {
      this.close('server', 'Lost connection to the server.');
    }
  }

  _secureSend(obj) {
    this._sendQueue = this._sendQueue
      .then(async () => {
        const sealed = await this.channel.seal(obj);
        this.sig?.send({ t: 'msg', data: { type: 'sec', ...sealed } });
      })
      .catch((e) => console.warn('secure send failed', e));
    return this._sendQueue;
  }

  _createPeer() {
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    pc.ontrack = (e) => {
      tuneReceiver(e.receiver);
      this.stream.addTrack(e.track);
      this.dispatchEvent(new CustomEvent('track', { detail: e.track }));
    };
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label === 'ctrl') this.ctrl = ch;
      else if (ch.label === 'input') this.input = ch;
      ch.onmessage = (ev) => this._onData(ev.data);
      ch.onopen = () => this.dispatchEvent(new CustomEvent('channels'));
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this._secureSend({ type: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        clearTimeout(this._failTimer);
        this._setState('connected');
      } else if (s === 'disconnected' || s === 'failed') {
        if (this.state === 'connected') this._setState('reconnecting');
        // The host restarts ICE on failure; give it time before giving up.
        clearTimeout(this._failTimer);
        this._failTimer = setTimeout(() => {
          if (pc.connectionState !== 'connected') this.close('ice', 'The connection was lost.');
        }, s === 'failed' && (this._hostGone || !this.sig?.open) ? 3000 : 20_000);
      }
    };
    return pc;
  }

  async _onSecure(m) {
    switch (m.type) {
      case 'offer': {
        const pc = this.pc || this._createPeer();
        await pc.setRemoteDescription({ type: 'offer', sdp: m.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this._secureSend({ type: 'answer', sdp: pc.localDescription.sdp });
        break;
      }
      case 'ice':
        try {
          await this.pc?.addIceCandidate(m.candidate);
        } catch (e) {
          console.warn('addIceCandidate', e);
        }
        break;
      case 'bye':
        this.close('bye', 'The other device ended the session.');
        break;
    }
  }

  _onData(raw) {
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.t === 'info') {
      this.info = m;
      this.dispatchEvent(new CustomEvent('info', { detail: m }));
    }
  }

  get control() {
    return this.info?.control || 'none';
  }

  // Pointer moves go over the unreliable channel (a late move is useless);
  // everything else is reliable and ordered.
  send(evt) {
    const lossy = evt.t === 'pm';
    let ch = lossy && this.input?.readyState === 'open' ? this.input : this.ctrl;
    if (!ch || ch.readyState !== 'open') return false;
    if (lossy && ch.bufferedAmount > 32_768) return false;
    ch.send(JSON.stringify(evt));
    return true;
  }

  async stats() {
    if (!this.pc) return {};
    this._stats = await readStats(this.pc, this._stats);
    return this._stats;
  }

  close(reason = 'closed', message = '') {
    if (this.state === 'closed') return;
    clearTimeout(this._failTimer);
    if (this.channel && this.sig?.open && reason === 'closed') this._secureSend({ type: 'bye' });
    const finish = () => {
      try {
        this.pc?.close();
      } catch {
        /* ignore */
      }
      this.sig?.close();
    };
    // Let a goodbye message flush first.
    this._sendQueue.then(finish, finish);
    for (const t of this.stream.getTracks()) t.stop();
    this._setState('closed', { reason, message });
  }
}
