/**
 * AYA Expo Tools — Camera Manager
 * RTSP status checking + JPEG snapshot via HTTP
 * Compatible with Intelbras iMD 3C Black and other ONVIF cameras
 */

const http = require('http');
const { URL } = require('url');

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
   * Check if camera HTTP interface is reachable
   */
  async checkOnline() {
    return new Promise((resolve) => {
      const req = http.get(`http://${this.ip}:${this.httpPort}/`, { timeout: 3000 }, (res) => {
        this.state.online = true;
        this.state.lastCheck = new Date().toISOString();
        res.resume();
        resolve(true);
      });

      req.on('error', () => {
        this.state.online = false;
        this.state.lastCheck = new Date().toISOString();
        resolve(false);
      });

      req.on('timeout', () => {
        this.state.online = false;
        this.state.lastCheck = new Date().toISOString();
        req.destroy();
        resolve(false);
      });
    });
  }

  /**
   * Get JPEG snapshot via HTTP (Intelbras/Dahua compatible)
   */
  async getSnapshot() {
    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${this.user}:${this.password}`).toString('base64');
      const url = `http://${this.ip}:${this.httpPort}/cgi-bin/snapshot.cgi?channel=${this.channel}`;

      const req = http.get(url, {
        timeout: 5000,
        headers: { 'Authorization': `Basic ${auth}` }
      }, (res) => {
        if (res.statusCode === 401) {
          // Try digest auth fallback — for now just report
          reject(new Error('Authentication required (Digest)'));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          this.state.online = true;
          this.state.lastCheck = new Date().toISOString();
          resolve(buffer);
        });
      });

      req.on('error', (err) => reject(err));
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
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
