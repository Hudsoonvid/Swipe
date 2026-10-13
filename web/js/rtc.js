// WebRTC helpers tuned for low latency remote screens.

const CODEC_MIME = { h264: 'video/H264', vp8: 'video/VP8', vp9: 'video/VP9', av1: 'video/AV1' };

// Puts the preferred codec first in the offer. H.264 is the default because
// it is hardware-encoded/decoded on nearly every phone, tablet and PC.
export function preferCodec(transceiver, pref = 'auto') {
  const caps = globalThis.RTCRtpReceiver?.getCapabilities?.('video');
  if (!caps || !transceiver.setCodecPreferences) return;
  const order = pref === 'auto' ? ['h264', 'vp8', 'vp9', 'av1'] : [pref, 'h264', 'vp8', 'vp9', 'av1'];
  const rank = (c) => {
    const i = order.findIndex((k) => CODEC_MIME[k].toLowerCase() === c.mimeType.toLowerCase());
    if (i < 0) return 100; // rtx / red / ulpfec keep their relative place at the end
    let r = i * 4;
    if (c.mimeType === 'video/H264') {
      const f = c.sdpFmtpLine || '';
      if (!/packetization-mode=1/.test(f)) r += 2;
      if (!/profile-level-id=42e0/.test(f)) r += 1; // constrained baseline decodes everywhere
    }
    return r;
  };
  const codecs = [...caps.codecs].sort((a, b) => rank(a) - rank(b));
  try {
    transceiver.setCodecPreferences(codecs);
  } catch (e) {
    console.warn('setCodecPreferences failed', e);
  }
}

export const QUALITY = {
  auto: { hint: 'detail', degradation: 'balanced', fps: 60, bitrate: 12_000_000 },
  text: { hint: 'text', degradation: 'maintain-resolution', fps: 30, bitrate: 10_000_000 },
  motion: { hint: 'motion', degradation: 'maintain-framerate', fps: 60, bitrate: 12_000_000 },
};

export async function tuneSender(sender, quality = 'auto') {
  const q = QUALITY[quality] || QUALITY.auto;
  if (sender.track) sender.track.contentHint = q.hint;
  try {
    const params = sender.getParameters();
    if (!params.encodings || !params.encodings.length) params.encodings = [{}];
    for (const e of params.encodings) {
      e.maxBitrate = q.bitrate;
      e.maxFramerate = q.fps;
      e.priority = 'high';
      e.networkPriority = 'high';
    }
    params.degradationPreference = q.degradation;
    await sender.setParameters(params);
  } catch (e) {
    console.warn('setParameters failed', e);
  }
}

// Ask the receiver to render frames as soon as they are decoded.
export function tuneReceiver(receiver) {
  try {
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
    if ('playoutDelayHint' in receiver) receiver.playoutDelayHint = 0;
  } catch {
    /* not supported */
  }
}

// Chrome starts screen shares at a very low bitrate and ramps up slowly;
// these hints (ignored by other browsers) make the first seconds sharp.
export function boostStartBitrate(sdp) {
  return sdp.replace(/a=fmtp:(\d+) (.*)\r\n/g, (line, pt, params) => {
    if (/apt=|x-google/.test(params)) return line;
    return `a=fmtp:${pt} ${params};x-google-start-bitrate=3000;x-google-min-bitrate=600;x-google-max-bitrate=12000\r\n`;
  });
}

// Summarized connection stats for the overlay.
export async function readStats(pc, prev = {}) {
  const out = { ...prev };
  const report = await pc.getStats();
  let pair;
  const byId = new Map();
  report.forEach((s) => byId.set(s.id, s));
  report.forEach((s) => {
    if (s.type === 'transport' && s.selectedCandidatePairId) pair = byId.get(s.selectedCandidatePairId);
  });
  report.forEach((s) => {
    if (!pair && s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s;
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      const now = s.timestamp;
      if (prev._t && s.bytesReceived >= prev._bytes) {
        out.kbps = Math.round(((s.bytesReceived - prev._bytes) * 8) / (now - prev._t));
      }
      out._t = now;
      out._bytes = s.bytesReceived;
      out.fps = Math.round(s.framesPerSecond || 0);
      out.width = s.frameWidth;
      out.height = s.frameHeight;
      if (s.jitterBufferEmittedCount) out.bufferMs = Math.round((s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000);
      const codec = s.codecId && byId.get(s.codecId);
      if (codec) out.codec = codec.mimeType.replace('video/', '');
      if (s.framesDecoded && s.totalDecodeTime) out.decodeMs = Math.round((s.totalDecodeTime / s.framesDecoded) * 1000);
    }
  });
  if (pair) {
    if (pair.currentRoundTripTime !== undefined) out.rttMs = Math.round(pair.currentRoundTripTime * 1000);
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    out.relayed = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
    out.network = local?.networkType;
  }
  return out;
}
