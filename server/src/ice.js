// Builds the STUN/TURN server list handed to clients.

import { createHmac, randomBytes } from 'node:crypto';

let cfCache = null; // { servers, expires }

async function cloudflareTurn(config) {
  if (cfCache && cfCache.expires > Date.now()) return cfCache.servers;
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${config.cfTurnKeyId}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.cfTurnToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 86400 }),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN: HTTP ${res.status}`);
  const body = await res.json();
  const servers = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
  cfCache = { servers, expires: Date.now() + 3600_000 };
  return servers;
}

export async function iceServers(config) {
  const servers = [];
  if (config.stunUrls.length) servers.push({ urls: config.stunUrls });
  if (config.turnUrls.length) {
    if (config.turnSecret) {
      // coturn REST API credentials (use-auth-secret / static-auth-secret)
      const username = `${Math.floor(Date.now() / 1000) + config.turnTtl}:${randomBytes(6).toString('hex')}`;
      const credential = createHmac('sha1', config.turnSecret).update(username).digest('base64');
      servers.push({ urls: config.turnUrls, username, credential });
    } else if (config.turnUsername) {
      servers.push({ urls: config.turnUrls, username: config.turnUsername, credential: config.turnPassword });
    } else {
      servers.push({ urls: config.turnUrls });
    }
  }
  if (config.cfTurnKeyId && config.cfTurnToken) {
    try {
      servers.push(...(await cloudflareTurn(config)));
    } catch (e) {
      console.warn('[ice]', e.message);
    }
  }
  return servers;
}
