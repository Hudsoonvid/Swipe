// Sharing side: registers with the server, authenticates each viewer with
// SPAKE2 and streams the screen to it over WebRTC.

import { Spake2 } from './crypto.js';
import { Signaling } from './signaling.js';
import { preferCodec, tuneSender, boostStartBitrate } from './rtc.js';
import { wsUrl } from './config.js';

const INPUT_TYPES = new Set(['pm', 'pd', 'pu', 'wh', 'kd', 'ku', 'tx', 'gesture', 'scroll', 'nav']);

export class HostSession extends EventTarget {
  /**
   * opts: {
   *   server, deviceKey, name, platform, password,
   *   control: 'desktop' | 'touch' | 'none',    what this host can be controlled with
   *   quality, codec,
   *   acquireStream(screenId?): Promise<MediaStream>,
   *   releaseStream?(stream),                    called when nobody is watching
   *   onInput?(event, viewer),
   *   screens?: () => [{id, name}], screenId?: () => id,
   * }
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.password = opts.password;
    this.controlAllowed = true;
    this.code = null;
    this.ice = [];
    this.status = 'offline';
    this.viewers = new Map(); // sid -> ViewerPeer
    this.stream = null;
    this._streamPromise = null;
    this._stopped = true;
    this._retry = 0;
  }

  get control() {
    return this.controlAllowed ? this.opts.control : 'none';
  }

  _setStatus(status, detail = {}) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: { status, code: this.code, ...detail } }));
  }

  async start() {
    this._stopped = false;
    await this._connect();
  }

  async _connect() {
    const sig = new Signaling(wsUrl(this.opts.server));
    this.sig = sig;
    sig.addEventListener('message', (e) => this._onSignal(e.detail));
    sig.addEventListener('close', () => this._onSignalClose(sig));
    this._setStatus('connecting');
    await sig.connect();
    sig.send({ t: 'host', key: this.opts.deviceKey, name: this.opts.name, platform: this.opts.platform, control: this.control });
    const m = await sig.waitFor((m) => m.t === 'hosted' || m.t === 'error');
    if (m.t === 'error') throw new Error(`The server refused to host (${m.error}).`);
    this._retry = 0;
    this.code = m.code;
    this.ice = m.ice || [];
    this._setStatus('online');
  }

  _onSignalClose(sig) {
    if (sig !== this.sig || this._stopped) return;
    for (const v of this.viewers.values()) if (!v.connected) v.close();
    this._setStatus('reconnecting');
    const delay = Math.min(1000 * 2 ** this._retry++, 15_000);
    setTimeout(() => {
      if (this._stopped || sig !== this.sig) return;
      this._connect().catch(() => this._onSignalClose(this.sig));
    }, delay);
  }

  _onSignal(m) {
    switch (m.t) {
      case 'viewer':
        this.viewers.set(m.sid, new ViewerPeer(this, m.sid));
        break;
      case 'left': {
        const v = this.viewers.get(m.sid);
        if (v) {
          v.signalingGone = true;
          if (!v.connected) v.close();
        }
        break;
      }
      case 'msg':
        this.viewers.get(m.from)?.onSignal(m.data);
        break;
      case 'error':
        if (m.error === 'replaced') {
          this._stopped = true;
          this._setStatus('replaced');
        }
        break;
    }
  }

  setPassword(pw) {
    this.password = pw;
  }

  setControlAllowed(allowed) {
    this.controlAllowed = allowed;
    this.sig?.send({ t: 'update', control: this.control });
    this.broadcastInfo();
  }

  infoMessage() {
    return {
      t: 'info',
      name: this.opts.name,
      platform: this.opts.platform,
      control: this.control,
      screens: this.opts.screens?.() || [],
      screen: this.opts.screenId?.() ?? null,
    };
  }

  broadcastInfo() {
    const info = this.infoMessage();
    for (const v of this.viewers.values()) v.sendCtrl(info);
  }

  viewerList() {
    return [...this.viewers.values()].filter((v) => v.authed).map((v) => ({ sid: v.sid, name: v.name, state: v.state }));
  }

  _emitViewers() {
    this.dispatchEvent(new CustomEvent('viewers', { detail: this.viewerList() }));
  }

  kick(sid) {
    const v = this.viewers.get(sid);
    if (!v) return;
    v.close(true);
    this.sig?.send({ t: 'kick', sid });
  }

  async getStream() {
    if (this.stream && this.stream.getVideoTracks().some((t) => t.readyState === 'live')) return this.stream;
    if (!this._streamPromise) {
      this._streamPromise = this.opts
        .acquireStream()
        .then((s) => {
          this.stream = s;
          for (const t of s.getTracks()) t.addEventListener('ended', () => this._onTrackEnded(s));
          return s;
        })
        .finally(() => (this._streamPromise = null));
    }
    return this._streamPromise;
  }

  _onTrackEnded(stream) {
    if (stream !== this.stream) return;
    this.dispatchEvent(new CustomEvent('streamended'));
  }

  // Swap the captured stream (e.g. another monitor) for every viewer.
  async replaceStream(stream) {
    const old = this.stream;
    this.stream = stream;
    for (const t of stream.getTracks()) t.addEventListener('ended', () => this._onTrackEnded(stream));
    const track = stream.getVideoTracks()[0];
    await Promise.all([...this.viewers.values()].map((v) => v.replaceVideo(track)));
    if (old && old !== stream) for (const t of old.getTracks()) t.stop();
    this.broadcastInfo();
  }

  _maybeReleaseStream() {
    if (!this.stream || [...this.viewers.values()].some((v) => v.pc)) return;
    if (this.opts.releaseStream) {
      this.opts.releaseStream(this.stream);
      this.stream = null;
    }
  }

  stop() {
    this._stopped = true;
    for (const v of [...this.viewers.values()]) v.close(true);
    this.sig?.close();
    this.sig = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this._setStatus('offline');
  }
}

class ViewerPeer {
  constructor(host, sid) {
    this.host = host;
    this.sid = sid;
    this.name = 'Viewer';
    this.state = 'auth';
    this.authed = false;
    this.connected = false;
    this.pc = null;
    this._queue = Promise.resolve();
    this._sendQueue = Promise.resolve();
  }

  onSignal(data) {
    this._queue = this._queue.then(() => this._handle(data)).catch((e) => {
      console.warn('viewer', this.sid, e);
      this.close();
    });
  }

  _relay(data) {
    this.host.sig?.send({ t: 'msg', to: this.sid, data });
  }

  _authFailed() {
    this.host.sig?.send({ t: 'authfail', sid: this.sid });
    this.host.dispatchEvent(new CustomEvent('authfail'));
    this.close();
  }

  async _handle(d) {
    if (!d || typeof d !== 'object') return;
    if (d.type === 'pake1' && this.state === 'auth') {
      this.state = 'confirm';
      this.spake = new Spake2('host', this.host.code, this.host.password);
      const Y = await this.spake.start();
      let confirm;
      try {
        confirm = await this.spake.finish(d.X);
      } catch {
        return this._authFailed();
      }
      this._relay({ type: 'pake2', Y, confirm });
    } else if (d.type === 'pake3' && this.state === 'confirm') {
      if (!this.spake.verify(d.confirm)) return this._authFailed();
      this.channel = await this.spake.channel();
      this.spake = null;
      this.authed = true;
      this.state = 'connecting';
      this.host.sig?.send({ t: 'authok', sid: this.sid });
      this.host._emitViewers();
      await this._startPeer();
    } else if (d.type === 'sec' && this.channel) {
      await this._onSecure(await this.channel.open(d));
    }
  }

  _secureSend(obj) {
    this._sendQueue = this._sendQueue
      .then(async () => {
        if (!this.channel) return;
        const sealed = await this.channel.seal(obj);
        this._relay({ type: 'sec', ...sealed });
      })
      .catch((e) => console.warn('secure send failed', e));
    return this._sendQueue;
  }

  async _startPeer() {
    const { host } = this;
    const pc = new RTCPeerConnection({ iceServers: host.ice, bundlePolicy: 'max-bundle' });
    this.pc = pc;
    const stream = await host.getStream();
    if (this.state === 'closed') return;
    for (const track of stream.getTracks()) {
      const tr = pc.addTransceiver(track, { direction: 'sendonly', streams: [stream] });
      if (track.kind === 'video') {
        preferCodec(tr, host.opts.codec);
        this.videoSender = tr.sender;
        await tuneSender(tr.sender, host.opts.quality);
      }
    }
    this.ctrl = pc.createDataChannel('ctrl', { ordered: true });
    this.input = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
    this.ctrl.onopen = () => this.sendCtrl(host.infoMessage());
    for (const ch of [this.ctrl, this.input]) ch.onmessage = (e) => this._onData(e.data);

    pc.onicecandidate = (e) => {
      if (e.candidate) this._secureSend({ type: 'ice', candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        this.connected = true;
        this._restarts = 0;
        this.state = 'connected';
        host._emitViewers();
      } else if (s === 'failed') {
        this._restartIce();
      } else if (s === 'closed') {
        this.close();
      }
    };
    await this._sendOffer();
  }

  async _sendOffer(iceRestart = false) {
    const offer = await this.pc.createOffer({ iceRestart });
    await this.pc.setLocalDescription(offer);
    await this._secureSend({ type: 'offer', sdp: this.pc.localDescription.sdp });
  }

  _restartIce() {
    // Networks change (Wi-Fi -> cellular). Try to find a new path a few times.
    if (this.signalingGone || !this.host.sig?.open || (this._restarts = (this._restarts || 0) + 1) > 3) {
      this.close();
      return;
    }
    this.state = 'reconnecting';
    this.host._emitViewers();
    this._sendOffer(true).catch(() => this.close());
  }

  async _onSecure(m) {
    switch (m.type) {
      case 'hello':
        this.name = String(m.name || 'Viewer').slice(0, 64);
        this.host._emitViewers();
        break;
      case 'answer':
        await this.pc.setRemoteDescription({ type: 'answer', sdp: boostStartBitrate(m.sdp) });
        break;
      case 'ice':
        try {
          await this.pc.addIceCandidate(m.candidate);
        } catch (e) {
          console.warn('addIceCandidate', e);
        }
        break;
      case 'bye':
        this.close();
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
    if (!m || typeof m.t !== 'string') return;
    if (INPUT_TYPES.has(m.t)) {
      if (this.host.control !== 'none') this.host.opts.onInput?.(m, this);
    } else if (m.t === 'screen') {
      this.host.dispatchEvent(new CustomEvent('screenrequest', { detail: m.id }));
    }
  }

  sendCtrl(obj) {
    if (this.ctrl?.readyState === 'open') this.ctrl.send(JSON.stringify(obj));
  }

  async replaceVideo(track) {
    if (this.videoSender) {
      await this.videoSender.replaceTrack(track);
      await tuneSender(this.videoSender, this.host.opts.quality);
    }
  }

  close(sayBye = false) {
    if (this.state === 'closed') return;
    if (sayBye && this.channel) this._secureSend({ type: 'bye' });
    this.state = 'closed';
    try {
      this.pc?.close();
    } catch {
      /* ignore */
    }
    this.pc = null;
    this.connected = false;
    this.host.viewers.delete(this.sid);
    this.host._emitViewers();
    this.host._maybeReleaseStream();
  }
}
