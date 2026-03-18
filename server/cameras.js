/**
 * AYA Expo Tools — Camera Manager
 * RTSP status checking + JPEG snapshot via HTTP
 * Compatible with Intelbras iMD 3C Black and other ONVIF cameras
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

/**
 * Digest auth helper — parses WWW-Authenticate header and computes response
 * Used by Intelbras iMD 3C and most modern Dahua-based cameras
 */
function parseDigestHeader(header) {
  const fields = {};
  const re = /(\w+)="([^"]+)"/g;
  let m;
  while ((m = re.exec(header)) !== null) fields[m[1]] = m[2];
  return fields;
}

function buildDigestAuth(method, uri, user, password, digest) {
  const { realm, nonce, qop } = digest;
  const nc = '00000001';
  const cnonce = crypto.randomBytes(8).toString('hex');
  const ha1 = crypto.createHash('md5').update(`${user}:${realm}:${password}`).digest('hex');
  const ha2 = crypto.createHash('md5').update(`${method}:${uri}`).digest('hex');
  const response = qop
    ? crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex')
    : crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');

  let auth = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (digest.opaque) auth += `, opaque="${digest.opaque}"`;
  return auth;
}

function httpGetWithDigest(url, user, password, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;

    const doRequest = (authHeader) => {
      const opts = {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path,
        method: 'GET',
        timeout,
        headers: authHeader ? { Authorization: authHeader } : {},
      };

      const req = http.request(opts, (res) => {
        if (res.statusCode === 401) {
          const wwwAuth = res.headers['www-authenticate'] || '';
          res.resume();
          if (authHeader) return reject(new Error('Auth failed (credentials incorretos?)'));
          if (wwwAuth.toLowerCase().startsWith('digest')) {
            const digest = parseDigestHeader(wwwAuth);
            const auth = buildDigestAuth('GET', path, user, password, digest);
            doRequest(auth);
          } else if (wwwAuth.toLowerCase().startsWith('basic')) {
            const basic = 'Basic ' + Buffer.from(`${user}:${password}`).toString('base64');
            doRequest(basic);
          } else {
            reject(new Error('Auth scheme não suportado'));
          }
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ buffer: Buffer.concat(chunks), statusCode: res.statusCode }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
      req.end();
    };

    doRequest(null); // primeiro disparo sem auth — câmera devolve 401 com scheme
  });
}

class Camera {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.ip = config.ip;
    this.model = config.model || '';
    this.user = config.user || 'admin';
    this.password = config.password || '';
    this.httpPort = config.httpPort || 80;
    this.rtspPort = config.rtspPort || 554;
    this.channel = config.channel || 1;

    this.state = {
      online: false,
      lastCheck: null,
      snapshotUrl: null,
    };
  }

  /**
   * RTSP URL for this camera
   */
  getRtspUrl(substream = false) {
    const auth = this.password ? `${this.user}:${this.password}@` : `${this.user}@`;
    const subtype = substream ? 1 : 0;
    return `rtsp://${auth}${this.ip}:${this.rtspPort}/cam/realmonitor?channel=${this.channel}&subtype=${subtype}`;
  }

  /**
   * Check if camera HTTP interface is reachable (TCP connect on port 80)
   * iMD 3C retorna 401 no GET / — consideramos online se o TCP responde
   */
  async checkOnline() {
    return new Promise((resolve) => {
      const net = require('net');
      const socket = new net.Socket();
      socket.setTimeout(3000);
      socket.connect(this.httpPort, this.ip, () => {
        socket.destroy();
        this.state.online = true;
        this.state.lastCheck = new Date().toISOString();
        resolve(true);
      });
      socket.on('error', () => {
        this.state.online = false;
        this.state.lastCheck = new Date().toISOString();
        resolve(false);
      });
      socket.on('timeout', () => {
        socket.destroy();
        this.state.online = false;
        this.state.lastCheck = new Date().toISOString();
        resolve(false);
      });
    });
  }

  /**
   * Get JPEG snapshot via HTTP (Intelbras/Dahua compatible)
   * Auto-negotiates Digest or Basic auth — iMD 3C Black uses Digest by default
   */
  async getSnapshot() {
    const url = `http://${this.ip}:${this.httpPort}/cgi-bin/snapshot.cgi?channel=${this.channel}`;
    try {
      const { buffer } = await httpGetWithDigest(url, this.user, this.password);
      this.state.online = true;
      this.state.lastCheck = new Date().toISOString();
      return buffer;
    } catch (err) {
      this.state.online = false;
      this.state.lastCheck = new Date().toISOString();
      throw err;
    }
  }

  getStatus() {
    return {
      id: this.id,
      name: this.name,
      ip: this.ip,
      model: this.model,
      rtsp: this.getRtspUrl(),
      rtspSub: this.getRtspUrl(true),
      ...this.state,
    };
  }
}

class CameraManager {
  constructor(config) {
    this.cameras = new Map();
    this.pollTimer = null;

    for (const c of config.cameras || []) {
      this.cameras.set(c.id, new Camera(c));
    }
  }

  get(id) { return this.cameras.get(id); }
  all() { return Array.from(this.cameras.values()); }

  async checkAll() {
    await Promise.allSettled(this.all().map(c => c.checkOnline()));
    return this.getAllStatus();
  }

  getAllStatus() {
    return this.all().map(c => c.getStatus());
  }

  startPolling(interval = 30000) {
    this.stopPolling();
    this.checkAll();
    this.pollTimer = setInterval(() => this.checkAll(), interval);
  }

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  }
}

module.exports = { Camera, CameraManager };
