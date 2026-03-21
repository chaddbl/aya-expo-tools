/**
 * AYA Expo Tools — CV Daily Logger
 *
 * Samples zone counts every minute and persists to daily JSONL files.
 * At midnight, consolidates a daily summary with counter + zones + peaks.
 *
 * Files produced:
 *   logs/cv/YYYY-MM-DD.jsonl        — minute-by-minute zone samples
 *   logs/cv/daily/YYYY-MM-DD.json   — daily summary (counter + zones + peaks)
 *
 * Usage:
 *   const cvLogger = require('./cv-logger');
 *   cvLogger.start(cvManager);
 *   cvLogger.stop();
 */

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, '..', 'logs', 'cv');
const DAILY_DIR = path.join(LOGS_DIR, 'daily');

let _timer = null;
let _midnightTimer = null;
let _cvManager = null;
let _currentDate = null;

// ── Ensure directories ──────────────────────────────────────────────
function ensureDirs() {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
  fs.mkdirSync(DAILY_DIR, { recursive: true });
}

// ── Today string ────────────────────────────────────────────────────
function today() {
  return new Date().toISOString().slice(0, 10);
}

function nowISO() {
  return new Date().toISOString();
}

// ── Sample: snapshot of zones + counter → append to JSONL ───────────
function sample() {
  if (!_cvManager) return;

  try {
    const status = _cvManager.getStatus();
    if (!status.running) return;

    const entry = {
      t: nowISO(),
      total: status.totalCount,
      zones: status.zones,                    // { "sala-imersiva": 3, "galeria": 1, ... }
      perCamera: {},
    };

    // Per-camera counts (lighter than full status)
    for (const [camId, cam] of Object.entries(status.perCamera || {})) {
      entry.perCamera[camId] = cam.count;
    }

    // Counter data
    if (status.counter && status.counter.entries !== undefined) {
      entry.counter = {
        entries: status.counter.entries,
        exits: status.counter.exits,
        occupancy: status.counter.occupancy,
      };
      if (status.counter.hourly) {
        entry.counterHourly = status.counter.hourly;
      }
    }

    // Append to daily JSONL
    const date = today();
    const file = path.join(LOGS_DIR, `${date}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');

    // Day changed? Consolidate yesterday
    if (_currentDate && _currentDate !== date) {
      consolidate(_currentDate);
    }
    _currentDate = date;

  } catch (e) {
    // Silently ignore — logger should never crash the server
    console.error(`[CV Logger] Sample error: ${e.message}`);
  }
}

// ── Consolidate: daily summary from JSONL ───────────────────────────
function consolidate(date) {
  const file = path.join(LOGS_DIR, `${date}.jsonl`);
  if (!fs.existsSync(file)) return null;

  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n')
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);

    if (lines.length === 0) return null;

    // ── Counter final — use MAX entries/exits seen across all samples ──
    // (handles restarts: counter may reset mid-day, we want cumulative max)
    let maxEntries = 0, maxExits = 0;
    let lastHourly = {};
    for (const l of lines) {
      if (l.counter) {
        if (l.counter.entries > maxEntries) maxEntries = l.counter.entries;
        if (l.counter.exits > maxExits) maxExits = l.counter.exits;
        if (l.counterHourly && Object.keys(l.counterHourly).length > 0) {
          lastHourly = l.counterHourly;
        }
      }
    }
    const counterFinal = { entries: maxEntries, exits: maxExits, occupancy: Math.max(0, maxEntries - maxExits) };
    const counterHourly = lastHourly;

    // ── Zone stats ──
    const zoneIds = Object.keys(lines[0].zones || {});
    const zoneStats = {};

    for (const zoneId of zoneIds) {
      const values = lines.map(l => l.zones?.[zoneId] ?? 0);
      const nonZero = values.filter(v => v > 0);

      zoneStats[zoneId] = {
        max: Math.max(...values),
        avg: values.length > 0 ? +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : 0,
        minutesOccupied: nonZero.length,           // each sample = 1 minute
        minutesTotal: values.length,
        occupancyRate: values.length > 0
          ? +((nonZero.length / values.length) * 100).toFixed(1)
          : 0,
      };
    }

    // ── Total stats ──
    const totals = lines.map(l => l.total || 0);
    const peak = Math.max(...totals);
    const peakEntry = lines.find(l => (l.total || 0) === peak);
    const peakTime = peakEntry?.t || null;

    // ── Hourly breakdown (from zone samples) ──
    const hourlyZones = {};
    for (const entry of lines) {
      const hour = entry.t.slice(11, 13);
      if (!hourlyZones[hour]) hourlyZones[hour] = { samples: 0, total: 0, zones: {} };
      hourlyZones[hour].samples++;
      hourlyZones[hour].total += entry.total || 0;
      for (const [zoneId, count] of Object.entries(entry.zones || {})) {
        if (!hourlyZones[hour].zones[zoneId]) hourlyZones[hour].zones[zoneId] = 0;
        hourlyZones[hour].zones[zoneId] += count;
      }
    }
    // Average per hour
    for (const [hour, data] of Object.entries(hourlyZones)) {
      data.avgTotal = +(data.total / data.samples).toFixed(1);
      for (const zoneId of Object.keys(data.zones)) {
        data.zones[zoneId] = +(data.zones[zoneId] / data.samples).toFixed(1);
      }
      delete data.total;
    }

    const summary = {
      date,
      samples: lines.length,
      firstSample: lines[0].t,
      lastSample: lines[lines.length - 1].t,
      counter: counterFinal,
      counterHourly,
      peak: { count: peak, time: peakTime },
      zones: zoneStats,
      hourly: hourlyZones,
    };

    // Save
    const summaryFile = path.join(DAILY_DIR, `${date}.json`);
    fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
    console.log(`[CV Logger] Daily summary saved: ${summaryFile} (${lines.length} samples)`);

    return summary;

  } catch (e) {
    console.error(`[CV Logger] Consolidate error for ${date}: ${e.message}`);
    return null;
  }
}

// ── Schedule midnight consolidation ─────────────────────────────────
function scheduleMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 5, 0); // 00:00:05 next day (5s buffer)
  const ms = midnight.getTime() - now.getTime();

  _midnightTimer = setTimeout(() => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    console.log(`[CV Logger] Midnight consolidation: ${yesterday}`);
    consolidate(yesterday);
    scheduleMidnight(); // schedule next
  }, ms);

  console.log(`[CV Logger] Next midnight consolidation in ${Math.round(ms / 60000)}min`);
}

// ── Public API ──────────────────────────────────────────────────────

function start(cvManager, intervalMs = 60000) {
  _cvManager = cvManager;
  _currentDate = today();
  ensureDirs();

  // Sample every minute
  _timer = setInterval(sample, intervalMs);

  // Schedule midnight consolidation
  scheduleMidnight();

  console.log(`[CV Logger] Started — sampling every ${intervalMs / 1000}s → logs/cv/`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_midnightTimer) { clearTimeout(_midnightTimer); _midnightTimer = null; }

  // Consolidate current day on stop (partial day)
  if (_currentDate) {
    consolidate(_currentDate);
  }

  console.log('[CV Logger] Stopped');
}

/**
 * Get daily summary (today or specific date).
 * If today, generates on-the-fly from JSONL.
 */
function getDailySummary(date) {
  date = date || today();

  // If requesting today, consolidate on-the-fly
  if (date === today()) {
    return consolidate(date);
  }

  // Otherwise, read from saved file
  const file = path.join(DAILY_DIR, `${date}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * List available daily summaries
 */
function listDays() {
  ensureDirs();
  // Check both JSONL (raw) and daily (consolidated)
  const jsonlDates = fs.readdirSync(LOGS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => f.replace('.jsonl', ''));

  const dailyDates = fs.readdirSync(DAILY_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));

  const allDates = [...new Set([...jsonlDates, ...dailyDates])].sort().reverse();

  return allDates.map(date => {
    const jsonlFile = path.join(LOGS_DIR, `${date}.jsonl`);
    const dailyFile = path.join(DAILY_DIR, `${date}.json`);
    return {
      date,
      hasRaw: fs.existsSync(jsonlFile),
      hasSummary: fs.existsSync(dailyFile),
      rawSizeKB: fs.existsSync(jsonlFile) ? Math.round(fs.statSync(jsonlFile).size / 1024) : 0,
    };
  });
}

module.exports = { start, stop, sample, consolidate, getDailySummary, listDays };
