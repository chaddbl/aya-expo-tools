/**
 * AYA Expo Tools — Scheduler
 *
 * Cron-based automation for the full expo operating cycle.
 *
 * Supports two config formats:
 *
 * 1) Simple (same time every day):
 *    { "enabled": true, "powerOn": "09:00", "powerOff": "20:00" }
 *
 * 2) Per-day (different times per weekday):
 *    { "enabled": true, "days": {
 *        "mon": { "open": "10:00", "close": "20:00" },
 *        "tue": { "open": "10:00", "close": "20:00" },
 *        "wed": { "open": "10:00", "close": "20:00" },
 *        "thu": { "open": "10:00", "close": "20:00" },
 *        "fri": { "open": "10:00", "close": "20:00" },
 *        "sat": { "open": "10:00", "close": "18:00" },
 *        "sun": null  // closed
 *    }}
 *
 * Sequences:
 *   Open:  tv-on-all → (warmup delay) → tv-cast-all → projectors-on
 *   Close: projectors-off → tv-stop-all
 */

const cron = require('node-cron');

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_LABELS = {
  sun: 'Domingo', mon: 'Segunda', tue: 'Terça', wed: 'Quarta',
  thu: 'Quinta', fri: 'Sexta', sat: 'Sábado',
};
const DAY_CRON = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

class Scheduler {
  constructor(projectorManager, config, tvModule) {
    this.pm = projectorManager;
    this.tvModule = tvModule || null;
    this.fullConfig = config;
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
    const days = this._normalizeDays();

    if (!days || Object.keys(days).length === 0) {
      console.log('[Scheduler] No schedule days configured');
      return;
    }

    let openCount = 0;

    for (const [dayKey, times] of Object.entries(days)) {
      if (!times || !times.open || !times.close) continue; // day off

      const cronDay = DAY_CRON[dayKey];

      // Open job
      const [oh, om] = times.open.split(':');
      const openExpr = `${parseInt(om)} ${parseInt(oh)} * * ${cronDay}`;
      const openJob = cron.schedule(openExpr, () => {
        console.log(`[Scheduler] ▶ OPEN (${DAY_LABELS[dayKey]}) at ${times.open}`);
        this._runOpenSequence();
      }, { timezone: tz });
      this.jobs.push(openJob);

      // Close job
      const [ch, cm] = times.close.split(':');
      const closeExpr = `${parseInt(cm)} ${parseInt(ch)} * * ${cronDay}`;
      const closeJob = cron.schedule(closeExpr, () => {
        console.log(`[Scheduler] ⏹ CLOSE (${DAY_LABELS[dayKey]}) at ${times.close}`);
        this._runCloseSequence();
      }, { timezone: tz });
      this.jobs.push(closeJob);

      openCount++;
    }

    this.enabled = true;
    const todayTimes = this.getToday();
    const todayStr = todayTimes
      ? `hoje: ${todayTimes.open}–${todayTimes.close}`
      : 'hoje: FECHADO';
    console.log(`[Scheduler] Started — ${openCount} dia(s) configurado(s), ${todayStr} (${tz})`);
    if (this.tvConfig.length > 0 && this.tvModule) {
      console.log(`[Scheduler] TVs included: ${this.tvConfig.length} TVs`);
    }
  }

  /**
   * Normalize config to per-day format.
   * Simple format (powerOn/powerOff) → all 7 days same time.
   */
  _normalizeDays() {
    if (this.config.days) {
      return this.config.days;
    }

    // Legacy simple format → convert to per-day (every day)
    if (this.config.powerOn && this.config.powerOff) {
      const days = {};
      for (const d of DAY_KEYS) {
        days[d] = { open: this.config.powerOn, close: this.config.powerOff };
      }
      return days;
    }

    return null;
  }

  /**
   * Get today's schedule (or null if closed today).
   */
  getToday() {
    const days = this._normalizeDays();
    if (!days) return null;
    const now = new Date();
    // Use timezone-aware day
    const dayIdx = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      timeZone: this.config.timezone || 'America/Sao_Paulo',
    }).format(now).toLowerCase();
    const dayKey = DAY_KEYS.find(d => dayIdx.startsWith(d)) || DAY_KEYS[now.getDay()];
    const times = days[dayKey];
    if (!times || !times.open || !times.close) return null;
    return { day: dayKey, label: DAY_LABELS[dayKey], ...times };
  }

  // ── Open Sequence ──────────────────────────────────────────
  async _runOpenSequence() {
    const delay = this.config.tvWarmupDelay || 30000;
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

      await this._sleep(delay);

      // Step 2: Cast video to each TV
      try {
        this.addLog('tv-cast-all', 'started');
        const mediaServer = this.fullConfig.exhibition?.network?.mediaServer || 'localhost';
        const port = this.serverConfig.port || 3000;
        const baseUrl = `http://${mediaServer}:${port}`;
        for (const t of this.tvConfig) {
          if (!t.videoUrl) continue;
          this.tvModule.startLoop(t, t.videoUrl, {
            title: t.videoTitle || t.name,
            baseUrl,
          });
        }
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

    try {
      this.addLog('power-off-all', 'started');
      await this.pm.powerOffAll();
      this.addLog('power-off-all', 'completed');
    } catch (err) {
      this.addLog('power-off-all', 'error', err.message);
    }

    if (this.tvModule && this.tvConfig.length > 0) {
      try {
        this.addLog('tv-stop-all', 'started');
        for (const t of this.tvConfig) { this.tvModule.stopLoop(t); }
        await Promise.allSettled(this.tvConfig.map(t => this.tvModule.castStop(t)));
        this.addLog('tv-stop-all', 'completed');
      } catch (err) {
        this.addLog('tv-stop-all', 'error', err.message);
      }
    }

    this.addLog('close-sequence', 'completed');
    console.log(`[Scheduler] ⏹ CLOSE sequence completed`);
  }

  async runOpen() { return this._runOpenSequence(); }
  async runClose() { return this._runCloseSequence(); }
  _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  stop() {
    this.jobs.forEach(j => j.stop());
    this.jobs = [];
    this.enabled = false;
  }

  addLog(action, status, detail = '') {
    this.log.unshift({ time: new Date().toISOString(), action, status, detail });
    if (this.log.length > 100) this.log.length = 100;
  }

  getStatus() {
    const days = this._normalizeDays() || {};
    const today = this.getToday();
    return {
      enabled: this.enabled,
      timezone: this.config.timezone || 'America/Sao_Paulo',
      tvWarmupDelay: (this.config.tvWarmupDelay || 30000) / 1000,
      includeTvs: !!(this.tvModule && this.tvConfig.length > 0),
      tvCount: this.tvConfig.length,
      // Per-day schedule
      days,
      // Today's schedule (convenience)
      today: today ? { day: today.day, label: today.label, open: today.open, close: today.close } : null,
      // Legacy fields (backward compat)
      powerOn: today?.open || this.config.powerOn || null,
      powerOff: today?.close || this.config.powerOff || null,
      recentLogs: this.log.slice(0, 20),
    };
  }

  updateConfig(newConfig) {
    if (newConfig.schedule) {
      this.config = newConfig.schedule;
    } else {
      Object.assign(this.config, newConfig);
    }
    this.tvConfig = newConfig.tvs || this.fullConfig.tvs || [];
    if (this.config.enabled) {
      this.start();
    } else {
      this.stop();
    }
  }
}

module.exports = { Scheduler };
