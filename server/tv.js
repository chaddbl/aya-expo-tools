/**
 * tv.js — Controle de TVs Hisense via Google Cast + Wake-on-LAN
 *
 * Liga:     Wake-on-LAN (magic packet UDP porta 9)
 * Desliga:  Google Cast — para o app receiver → TV volta ao input padrão
 * Status:   Google Cast API (porta 8009) — isStandBy, isActiveInput, volume
 * Vídeo:    Google Cast — load de URL HTTP servida pelo media server
 * Volume:   Google Cast — setVolume
 *
 * Descoberta (19/03/2026):
 *   Hisense 55A51HUA tem Chromecast built-in (portas 8008/8009/8443)
 *   MQTT porta 36669 NÃO disponível neste modelo
 *   Protocolo Cast dá controle completo: play, stop, volume, status
 */

const dgram = require('dgram');
const net   = require('net');

// castv2-client — lazy loaded (pode não estar instalado em todas as expos)
let CastClient = null;
let DefaultMediaReceiver = null;
try {
  CastClient = require('castv2-client').Client;
  DefaultMediaReceiver = require('castv2-client').DefaultMediaReceiver;
} catch {
  // castv2-client not installed — cast features disabled
}

// ── Wake-on-LAN ──────────────────────────────────────────
function buildMagicPacket(mac) {
  const hex = mac.replace(/[:\-\.]/g, '');
  if (hex.length !== 12) throw new Error(`MAC inválido: ${mac}`);
  const macBytes = Buffer.from(hex, 'hex');
  const packet   = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xFF, 0, 6);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  return packet;
}

async function powerOn(tv) {
  const mac = tv.mac || '';
  if (!mac || mac === 'TBD' || mac === '') {
    throw new Error('MAC não configurado');
  }

  const broadcast = tv.broadcastAddr || '192.168.0.255';

  return new Promise((resolve, reject) => {
    try {
      const packet = buildMagicPacket(mac);
      const socket = dgram.createSocket('udp4');

      socket.once('error', err => { socket.close(); reject(err); });
      socket.bind(() => {
        socket.setBroadcast(true);
        let sent = 0;
        const send = () => {
          socket.send(packet, 0, packet.length, 9, broadcast, err => {
            if (err) { socket.close(); return reject(err); }
            sent++;
            if (sent < 3) setTimeout(send, 100);
            else { socket.close(); resolve(); }
          });
        };
        send();
      });
    } catch (e) { reject(e); }
  });
}

// ── Google Cast ──────────────────────────────────────────

/**
 * Connect to Cast device, run callback, then disconnect.
 * Handles timeout and cleanup automatically.
 */
function withCastClient(ip, timeoutMs, callback) {
  if (!CastClient) {
    return Promise.reject(new Error('castv2-client não instalado — execute npm install'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.close(); } catch { /* ignore */ }
      fn(val);
    };

    const client = new CastClient();

    const timer = setTimeout(() => {
      done(reject, new Error('Cast timeout'));
    }, timeoutMs);

    client.on('error', (err) => {
      done(reject, err);
    });

    try {
      client.connect(ip, () => {
        callback(client)
          .then(result => done(resolve, result))
          .catch(err => done(reject, err));
      });
    } catch (err) {
      done(reject, err);
    }
  });
}

/**
 * Get Cast device status (volume, standby, active input)
 */
async function getStatus(tv) {
  const ip = tv.ip || '';
  if (!ip) return { online: false, error: 'IP não configurado' };

  try {
    const status = await withCastClient(ip, 8000, (client) => {
      return new Promise((resolve, reject) => {
        client.getStatus((err, status) => {
          if (err) reject(err);
          else resolve(status);
        });
      });
    });

    return {
      online: true,
      isActiveInput: status.isActiveInput ?? null,
      isStandBy: status.isStandBy ?? null,
      volume: status.volume ? {
        level: Math.round((status.volume.level || 0) * 100),
        muted: status.volume.muted || false,
      } : null,
      // Check if something is playing
      application: status.applications?.[0]?.displayName || null,
    };
  } catch (err) {
    // Fallback: ping check
    const pingOk = await isReachable(ip);
    return {
      online: pingOk,
      castAvailable: false,
      error: err.message,
    };
  }
}

/**
 * Simple ping/TCP check (fallback when Cast unavailable)
 */
async function isReachable(ip) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(3000);
    // Try Cast port first, then generic
    socket.connect(8009, ip, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => { socket.destroy(); resolve(false); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

/**
 * Check if TV is online (simplified boolean)
 */
async function isOnline(tv) {
  const ip = tv.ip || '';
  if (!ip) return false;
  return isReachable(ip);
}

/**
 * Cast a video to the TV (plays immediately)
 * @param {object} tv — TV config entry
 * @param {string} videoUrl — HTTP URL accessible from the TV's network
 * @param {object} opts — { title, contentType, loop }
 */
async function castVideo(tv, videoUrl, opts = {}) {
  const ip = tv.ip || '';
  if (!ip) throw new Error('IP não configurado');
  if (!CastClient) throw new Error('castv2-client não instalado');

  const title = opts.title || tv.videoTitle || 'AYA Expo';
  const contentType = opts.contentType || 'video/mp4';

  return withCastClient(ip, 15000, (client) => {
    return new Promise((resolve, reject) => {
      client.launch(DefaultMediaReceiver, (err, player) => {
        if (err) return reject(err);

        const media = {
          contentId: videoUrl,
          contentType,
          streamType: 'BUFFERED',
          metadata: {
            type: 0,
            metadataType: 0,
            title,
          },
        };

        // repeatMode in load options
        const loadOpts = { autoplay: true };

        player.load(media, loadOpts, (err, status) => {
          if (err) return reject(err);

          // Set repeat mode after load (some receivers need this separately)
          if (opts.loop !== false) {
            try {
              player.queueUpdate({ repeatMode: 'REPEAT_SINGLE' }, () => {});
            } catch { /* best effort */ }
          }

          resolve({
            playing: true,
            mediaSessionId: status.mediaSessionId,
            playerState: status.extendedStatus?.playerState || status.playerState,
            contentId: videoUrl,
            title,
          });
        });
      });
    });
  });
}

/**
 * Stop playback / close Cast app on TV
 */
async function castStop(tv) {
  const ip = tv.ip || '';
  if (!ip) throw new Error('IP não configurado');
  if (!CastClient) throw new Error('castv2-client não instalado');

  // Use raw castv2 protocol to send STOP to receiver
  return withCastClient(ip, 8000, (client) => {
    return new Promise((resolve, reject) => {
      client.getSessions((err, sessions) => {
        if (err) return reject(err);
        if (!sessions || sessions.length === 0) {
          return resolve({ stopped: true, message: 'Nothing was playing' });
        }
        const session = sessions[0];
        client.receiver.send({
          type: 'STOP',
          sessionId: session.sessionId,
          requestId: Math.floor(Math.random() * 100000),
        });
        // Give it a moment to process
        setTimeout(() => {
          resolve({ stopped: true, sessionId: session.sessionId, appId: session.appId });
        }, 1000);
      });
    });
  });
}

/**
 * Set volume on TV (0-100)
 */
async function setVolume(tv, level) {
  const ip = tv.ip || '';
  if (!ip) throw new Error('IP não configurado');
  if (!CastClient) throw new Error('castv2-client não instalado');

  const normalized = Math.max(0.01, Math.min(1, level / 100)); // mínimo 1% — evita overlay de mudo na Hisense

  return withCastClient(ip, 8000, (client) => {
    return new Promise((resolve, reject) => {
      client.setVolume({ level: normalized }, (err, vol) => {
        if (err) return reject(err);
        resolve({ level: Math.round(vol.level * 100), muted: vol.muted });
      });
    });
  });
}

/**
 * Power off via Cast — stops app, which returns TV to home/input
 * Combined with removing the Cast session, TV may go to standby
 */
async function powerOff(tv) {
  try {
    await castStop(tv);
    return { ok: true, message: 'Cast stopped — TV retorna ao input padrão' };
  } catch (err) {
    throw new Error(`Power off failed: ${err.message}`);
  }
}

// ── Video Loop Monitor ───────────────────────────────────
// Polls Cast status and re-casts when video ends (IDLE state)

const _loopState = new Map();  // tvId → { timer, videoUrl, title, tv, retries }

function startLoop(tv, videoUrl, opts = {}) {
  const id = tv.id;
  stopLoop(tv);

  const title = opts.title || tv.videoTitle || 'AYA Expo';
  const baseUrl = opts.baseUrl || '';
  const fullUrl = videoUrl.startsWith('http') ? videoUrl : `${baseUrl}${videoUrl}`;
  const checkInterval = opts.checkInterval || 15000; // 15s

  console.log(`[TV Loop] ${id}: monitoring started — ${fullUrl}`);

  const state = {
    tv,
    videoUrl: fullUrl,
    title,
    retries: 0,
    maxRetries: 5,
    timer: null,
    casting: false,
  };

  const check = async () => {
    if (state.casting) return; // avoid overlap

    try {
      const status = await getStatus(tv);

      if (!status.online) {
        // TV offline — skip, will retry next cycle
        return;
      }

      // If nothing playing (no application or IDLE), re-cast
      if (!status.application) {
        state.casting = true;
        console.log(`[TV Loop] ${id}: video ended — re-casting`);
        try {
          await castVideo(tv, state.videoUrl, { title: state.title, loop: false });
          state.retries = 0;
          console.log(`[TV Loop] ${id}: re-cast OK`);
        } catch (err) {
          state.retries++;
          console.log(`[TV Loop] ${id}: re-cast failed (${state.retries}/${state.maxRetries}): ${err.message}`);
          if (state.retries >= state.maxRetries) {
            console.log(`[TV Loop] ${id}: max retries reached — stopping loop`);
            stopLoop(tv);
            return;
          }
        }
        state.casting = false;
      }
    } catch {
      // status check failed — skip
    }
  };

  state.timer = setInterval(check, checkInterval);
  _loopState.set(id, state);

  // First cast immediately
  castVideo(tv, state.videoUrl, { title: state.title, loop: false })
    .then(() => console.log(`[TV Loop] ${id}: initial cast OK`))
    .catch(err => console.log(`[TV Loop] ${id}: initial cast failed: ${err.message}`));
}

function stopLoop(tv) {
  const id = tv.id;
  const state = _loopState.get(id);
  if (state) {
    if (state.timer) clearInterval(state.timer);
    _loopState.delete(id);
    console.log(`[TV Loop] ${id}: monitoring stopped`);
  }
}

function isLooping(tv) {
  return _loopState.has(tv.id);
}

function getLoopStatus() {
  const result = {};
  for (const [id, state] of _loopState) {
    result[id] = {
      videoUrl: state.videoUrl,
      title: state.title,
      retries: state.retries,
    };
  }
  return result;
}

module.exports = {
  powerOn,
  powerOff,
  isOnline,
  getStatus,
  castVideo,
  castStop,
  setVolume,
  isReachable,
  startLoop,
  stopLoop,
  isLooping,
  getLoopStatus,
};
