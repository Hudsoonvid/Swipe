# Swipe protocol

Swipe connects a **host** (the device sharing its screen) with one or more **viewers** (the devices watching and controlling it). There are four implementations, and they must agree byte for byte:

| Part | Host | Viewer |
| --- | --- | --- |
| `web/js` (browsers, desktop app) | ✓ | ✓ |
| `android/` (Kotlin) | ✓ | (uses the web viewer) |
| `ios/` (Swift, broadcast extension) | ✓ | (uses the web viewer) |
| `server/` | relays only | relays only |

All three crypto implementations are checked against `docs/test-vectors.json` (`node server/test/gen-vectors.js` regenerates it).

## 1. Signaling (WebSocket `wss://<server>/ws`, JSON text frames)

The server pairs devices and relays messages. It never sees passwords, video or input.

### Host

| Direction | Message | Meaning |
| --- | --- | --- |
| → server | `{t:"host", key, name, platform, control}` | Register. `key` is a random 32-byte base64url secret stored on the device; the server keeps only `SHA-256(key)` and maps it to a stable 9-digit code. `control` is `"desktop"` (mouse and keyboard), `"touch"` or `"none"`. |
| ← server | `{t:"hosted", code, ice}` | `ice` is a list of RTCIceServer objects (STUN, plus TURN with time-limited credentials). |
| ← server | `{t:"viewer", sid}` | A viewer joined; `sid` identifies it. |
| ← server | `{t:"msg", from: sid, data}` | Relayed from that viewer. |
| ← server | `{t:"left", sid}` | The viewer's WebSocket closed. Its peer-to-peer media can keep running. |
| → server | `{t:"msg", to: sid, data}` | Relay to a viewer. |
| → server | `{t:"authok", sid}` / `{t:"authfail", sid}` | Password result. Failures count toward the lockout. |
| → server | `{t:"kick", sid}` | Disconnect a viewer. |
| → server | `{t:"update", control?, name?}` | Change the advertised info. |
| ← server | `{t:"error", error:"replaced"}` | Another connection with the same key took over the code. |

### Viewer

| Direction | Message | Meaning |
| --- | --- | --- |
| → server | `{t:"join", code}` | |
| ← server | `{t:"joined", code, host:{name, platform, control}, ice}` | |
| → / ← server | `{t:"msg", data}` | Relay to or from the host. |
| ← server | `{t:"hostgone"}` | The host's WebSocket closed. |
| ← server | `{t:"error", error, retryIn?}` | One of `not_found`, `locked`, `rate_limited`, `full`, `busy`, `auth_failed`, `kicked`, `timeout`. |

Both sides may send `{t:"ping"}` (answered with `{t:"pong"}`).

**Lockout:** a viewer that receives the host's `pake2` but never authenticates (wrong password, or it disconnects) counts as one failed attempt for that code and IP. Five failures within 15 minutes lock the code for 1, 2, 4, … minutes (capped at 1 hour). Joins are also rate-limited per IP.

## 2. Pairing: SPAKE2 (`data` payloads)

- Group: RFC 3526 2048-bit MODP group (group 14), generator `g = 2`, which generates the subgroup of prime order `q = (p-1)/2`.
- `M = (int(H("swipe-spake2-v1/M/0") ‖ … ‖ H(".../M/8")) mod p)² mod p`, and `N` likewise with label `N`. `H` is SHA-256 and the label strings are UTF-8.
- Normalization:
  - Code: digits only.
  - Password: NFKC, remove ASCII space, tab, CR, LF and `-`, then uppercase. This makes passwords case-insensitive and lets users type the dash or not.
- `w = int(SHA-256("swipe-pake-v1" ‖ 0x00 ‖ code ‖ 0x00 ‖ password))` (256-bit).
- Ephemeral scalars are 40 random bytes.

| Step | Sender | Message |
| --- | --- | --- |
| 1 | viewer | `{type:"pake1", X}` with `X = g^x · M^w mod p` |
| 2 | host | `{type:"pake2", Y, confirm}` with `Y = g^y · N^w mod p` |
| 3 | viewer | `{type:"pake3", confirm}` |

Elements are hex-encoded, 256 bytes big-endian. A receiver rejects any element outside `1 < e < p-1` or with `e^q ≠ 1`.

- Shared value: `K = (Y · N^(q-w))^x = (X · M^(q-w))^y`.
- Transcript: `TT = SHA-256("swipe-pake-v1" ‖ 0x00 ‖ code ‖ 0x00 ‖ X ‖ Y ‖ K ‖ w)`, where `X`, `Y` and `K` are 256 bytes each and `w` is 32 bytes.
- Key derivation: HKDF-SHA256 with input key material `TT`, an empty salt and 32-byte outputs. The `info` labels are:
  - `swipe/confirm/viewer` → `KcV`
  - `swipe/confirm/host` → `KcH`
  - `swipe/enc/v2h` → viewer-to-host encryption key
  - `swipe/enc/h2v` → host-to-viewer encryption key
- Confirmations: `confirm = HMAC-SHA256(Kc, TT)`, hex-encoded. Each side verifies the other's in constant time.

## 3. Encrypted signaling (`{type:"sec", n, c}`)

After pairing, every message between host and viewer is JSON encrypted with AES-256-GCM:

- `n` is a per-direction counter starting at 0. The receiver requires exactly the next value, which rejects replayed or reordered messages.
- Nonce: `0x00000000 ‖ uint64be(n)`.
- AAD: `"swipe/v1"`.
- `c` is base64 of ciphertext ‖ tag.

Because the WebRTC offer and answer (and their DTLS fingerprints) travel only inside this channel, the server cannot man-in-the-middle the media connection.

Plaintext messages:

- `{type:"hello", name, platform}`: viewer to host.
- `{type:"offer", sdp}`: host to viewer. The host is always the offerer; the video is sendonly.
- `{type:"answer", sdp}`: viewer to host.
- `{type:"ice", candidate:{candidate, sdpMid, sdpMLineIndex}}`: either direction.
- `{type:"bye"}`: either direction.

On connection failure the host restarts ICE (new offer) up to 3 times.

## 4. Data channels (created by the host)

- `ctrl`: reliable and ordered. Carries everything except pointer moves.
- `input`: unordered, `maxRetransmits: 0`. Carries pointer moves; a late move is useless.

Host → viewer: `{t:"info", name, platform, control, screens:[{id,name}], screen}`. It is sent when `ctrl` opens and again whenever something changes.

Viewer → host. Coordinates are normalized `0..1` across the shared screen:

| Message | Meaning |
| --- | --- |
| `{t:"pm", x, y}` | pointer move (`input` channel) |
| `{t:"pd", x, y, b}` / `{t:"pu", x, y, b}` | button down/up; `b`: 0 left, 1 middle, 2 right |
| `{t:"wh", x, y, dx, dy}` | wheel, CSS pixels, positive = down/right |
| `{t:"kd", code, key}` / `{t:"ku", code, key}` | key down/up (DOM `KeyboardEvent.code`/`key`); used for special keys, modifiers and shortcuts |
| `{t:"tx", text}` | type text (printable characters, IME, paste) |
| `{t:"gesture", pts:[[x,y,ms],…]}` | touch hosts: one-finger path; a tap or long press is a path that doesn't move |
| `{t:"scroll", x, y, dx, dy}` | touch hosts: scroll (performed as a swipe) |
| `{t:"nav", a}` | touch hosts: `back`, `home`, `recents`, `notifications` |
| `{t:"screen", id}` | switch to another monitor |

Hosts ignore input while `control` is `"none"`.
