/**
 * AYA Expo Tools — Scheduler
 * Cron-based power on/off for projectors
 */

const cron = require('node-cron');

class Scheduler {
  constructor(projectorManager, config) {
    this.pm = projectorManager;
    this.config = config.schedule || {};
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

    if (this.config.powerOn) {
      const [h, m] = this.config.powerOn.split(':');
      const cronExpr = `${m} ${h} * * *`;
      const job = cron.schedule(cronExpr, async () => {
        console.log(`[Scheduler] Power ON triggered at ${new Date().toISOString()}`);
        this.addLog('power-on', 'scheduled');
        try {
          await this.pm.powerOnAll();
          this.addLog('power-on', 'completed');
        } catch (err) {
          this.addLog('power-on', 'error', err.message);
        }
      }, { timezone: tz });
      this.jobs.push(job);
    }

    if (this.config.powerOff) {
      const [h, m] = this.config.powerOff.split(':');
      const cronExpr = `${m} ${h} * * *`;
      const job = cron.schedule(cronExpr, async () => {
        console.log(`[Scheduler] Power OFF triggered at ${new Date().toISOString()}`);
        this.addLog('power-off', 'scheduled');
        try {
          await this.pm.powerOffAll();
          this.addLog('power-off', 'completed');
        } catch (err) {
          this.addLog('power-off', 'error', err.message);
        }
      }, { timezone: tz });
      this.jobs.push(job);
    }

    this.enabled = true;
    console.log(`[Scheduler] Started — ON: ${this.config.powerOn}, OFF: ${this.config.powerOff} (${tz})`);
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
      recentLogs: this.log.slice(0, 10),
    };
  }

  updateConfig(newConfig) {
    Object.assign(this.config, newConfig);
    if (this.config.enabled) {
      this.start();
    } else {
      this.stop();
    }
  }
}

module.exports = { Scheduler };
