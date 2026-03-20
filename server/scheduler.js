/**
 * AYA Expo Tools — Scheduler
 *
 * Cron-based automation for the full expo operating cycle:
 *   Abertura: tv-on-all → (30s) → tv-cast-all → power-on-all
 *   Fechamento: power-off-all → tv-stop-all
 *
 * Supports:
 * - Projectors (PJLink)
 * - TVs (Google Cast: WOL → Cast video)
 * - Configurable delays between steps
 * - Log of all scheduled actions
 */

const cron = require('node-cron');

class Scheduler {
  /**
   * @param {object} projectorManager — ProjectorManager instance
   * @param {object} config — full expo config
   * @param {object} [tvModule] — tv.js module (powerOn, powerOff, castVideo, castStop)
   */
  constructor(projectorManager, config, tvModule) {
    this.pm = projectorManager;
    this.tvModule = tvModule || null;
    this.config = config.schedule || {};
    this.tvConfig = config.tvs || [];
    this.serverConfig = config.server || {};
    this.jobs = [];
    this.enabled = false;
    this.log = [];
  }

  start() {
    this.stop();

    if (!this.config.enabled) {
      console.log('[Scheduler] Disabled in config');
      return;
    }

    const tz = this.config.timezone || 'America/Sao_Paulo';

    // ── Abertura: tv-on → (delay) → tv-cast → projectors-on ──
    if (this.config.powerOn) {
      const [h, m] = this.config.powerOn.split(':');
      const cronExpr = `${m} ${h} * * *`;
      const job = cron.schedule(cronExpr, () => this._runOpenSequence(), { timezone: tz });
      this.jobs.push(job);
    }

    // ── Fechamento: projectors-off → tv-stop ──
    if (this.config.powerOff) {
      const [h, m] = this.config.powerOff.split(':');
      const cronExpr = `${m} ${h} * * *`;
      const job = cron.schedule(cronExpr, () => this._runCloseSequence(), { timezone: tz });
      this.jobs.push(job);
    }

    this.enabled = true;
    console.log(`[Scheduler] Started — ON: ${this.config.powerOn}, OFF: ${this.config.powerOff} (${tz})`);
    if (this.tvConfig.length > 0 && this.tvModule) {
      console.log(`[Scheduler] TVs included: ${this.tvConfig.length} TVs (WOL → Cast → Stop)`);
    }
  }

  // ── Open Sequence ──────────────────────────────────────────
  async _runOpenSequence() {
    const delay = this.config.tvWarmupDelay || 30000; // ms between TV wake and cast
    console.log(`[Scheduler] ▶ OPEN sequence started at ${new Date().toISOString()}`);
    this.addLog('open-sequence', 'started');

    // Step 1: Wake TVs via WOL
    if (this.tvModule && this.tvConfig.length > 0) {
      try {
        this.addLog('tv-on-all', 'started');
        await Promise.allSettled(this.tvConfig.map(t => this.tvModule.powerOn(t)));
        this.addLog('tv-on-all', 'completed');
        console.log(`[Scheduler] TVs WOL sent, waiting ${delay / 1000}s for boot...`);
      } catch (err) {
        this.addLog('tv-on-all', 'error', err.message);
      }

      // Wait for TVs to boot
      await this._sleep(delay);

      // Step 2: Cast video to each TV
      try {
        this.addLog('tv-cast-all', 'started');
        const baseUrl = `http://${this.serverConfig.host === '0.0.0.0' ? '192.168.0.10' : this.serverConfig.host}:${this.serverConfig.port || 3000}`;
        await Promise.allSettled(this.tvConfig.map(t => {
          const videoUrl = t.videoUrl ? `${baseUrl}${t.videoUrl}` : null;
          if (!videoUrl) return Promise.resolve();
          return this.tvModule.castVideo(t, videoUrl, { title: t.videoTitle || t.name });
        }));
        this.addLog('tv-cast-all', 'completed');
      } catch (err) {
        this.addLog('tv-cast-all', 'error', err.message);
      }
    }

    // Step 3: Power on projectors
    try {
      this.addLog('power-on-all', 'started');
      await this.pm.powerOnAll();
      this.addLog('power-on-all', 'completed');
    } catch (err) {
      this.addLog('power-on-all', 'error', err.message);
    }

    this.addLog('open-sequence', 'completed');
    console.log(`[Scheduler] ▶ OPEN sequence completed`);
  }

  // ── Close Sequence ─────────────────────────────────────────
  async _runCloseSequence() {
    console.log(`[Scheduler] ⏹ CLOSE sequence started at ${new Date().toISOString()}`);
    this.addLog('close-sequence', 'started');

    // Step 1: Power off projectors
    try {
      this.addLog('power-off-all', 'started');
      await this.pm.powerOffAll();
      this.addLog('power-off-all', 'completed');
    } catch (err) {
      this.addLog('power-off-all', 'error', err.message);
    }

    // Step 2: Stop TV casting
    if (this.tvModule && this.tvConfig.length > 0) {
      try {
        this.addLog('tv-stop-all', 'started');
        await Promise.allSettled(this.tvConfig.map(t => this.tvModule.castStop(t)));
        this.addLog('tv-stop-all', 'completed');
      } catch (err) {
        this.addLog('tv-stop-all', 'error', err.message);
      }
    }

    this.addLog('close-sequence', 'completed');
    console.log(`[Scheduler] ⏹ CLOSE sequence completed`);
  }

  // ── Manual trigger (from Portal or local) ──────────────────
  async runOpen() {
    return this._runOpenSequence();
  }

  async runClose() {
    return this._runCloseSequence();
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  stop() {
    this.jobs.forEach(j => j.stop());
    this.jobs = [];
    this.enabled = false;
  }

  addLog(action, status, detail = '') {
    this.log.unshift({
      time: new Date().toISOString(),
      action,
      status,
      detail,
    });
    if (this.log.length > 100) this.log.length = 100;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      powerOn: this.config.powerOn || null,
      powerOff: this.config.powerOff || null,
      timezone: this.config.timezone || 'America/Sao_Paulo',
      tvWarmupDelay: (this.config.tvWarmupDelay || 30000) / 1000,
      includeTvs: !!(this.tvModule && this.tvConfig.length > 0),
      tvCount: this.tvConfig.length,
      recentLogs: this.log.slice(0, 20),
    };
  }

  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);
    // Update parent config reference too
    if (newConfig.enabled !== undefined || newConfig.powerOn || newConfig.powerOff) {
      if (this.config.enabled) {
        this.start();
      } else {
        this.stop();
      }
    }
  }
}

module.exports = { Scheduler };
