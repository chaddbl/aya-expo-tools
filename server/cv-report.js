/**
 * AYA Expo Tools — CV Report Generator
 *
 * Aggregates daily summaries into weekly/monthly/custom range reports.
 * Reads from logs/cv/daily/*.json (produced by cv-logger.js).
 *
 * API:
 *   GET /api/cv/report/week          — current week (mon-sun)
 *   GET /api/cv/report/month         — current month
 *   GET /api/cv/report/last7         — last 7 days
 *   GET /api/cv/report/last30        — last 30 days
 *   GET /api/cv/report/:from/:to     — custom range (YYYY-MM-DD)
 */

const fs = require('fs');
const path = require('path');
const cvLogger = require('./cv-logger');

const DAILY_DIR = path.join(__dirname, '..', 'logs', 'cv', 'daily');

// ── Date helpers ────────────────────────────────────────────

function today() { return new Date().toISOString().slice(0, 10); }

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function mondayOfWeek(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay(); // 0=sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function firstOfMonth(dateStr) {
  return dateStr.slice(0, 8) + '01';
}

function lastOfMonth(dateStr) {
  const d = new Date(dateStr.slice(0, 7) + '-01T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

function dateRange(from, to) {
  const dates = [];
  let d = from;
  while (d <= to) {
    dates.push(d);
    d = addDays(d, 1);
  }
  return dates;
}

// ── Load daily summaries ────────────────────────────────────

function loadDaily(date) {
  // For today, generate on-the-fly
  if (date === today()) {
    return cvLogger.getDailySummary(date);
  }
  const file = path.join(DAILY_DIR, `${date}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// ── Aggregate ───────────────────────────────────────────────

function aggregate(from, to) {
  const dates = dateRange(from, to);
  const days = [];

  for (const date of dates) {
    const summary = loadDaily(date);
    if (summary) {
      days.push({ date, ...summary });
    }
  }

  if (days.length === 0) {
    return {
      from, to,
      daysTotal: dates.length,
      daysWithData: 0,
      message: 'No data available for this period',
    };
  }

  // ── Totals ──
  const totalEntries = days.reduce((a, d) => a + (d.counter?.entries || 0), 0);
  const totalExits = days.reduce((a, d) => a + (d.counter?.exits || 0), 0);
  const avgDaily = Math.round(totalEntries / days.length);

  // ── Peak day ──
  const peakDay = days.reduce((best, d) =>
    (d.counter?.entries || 0) > (best.counter?.entries || 0) ? d : best, days[0]);

  // ── Peak hour across all days ──
  const hourlyAgg = {};
  for (const d of days) {
    for (const [hour, data] of Object.entries(d.counterHourly || {})) {
      if (!hourlyAgg[hour]) hourlyAgg[hour] = { entries: 0, exits: 0, days: 0 };
      hourlyAgg[hour].entries += data.entries || 0;
      hourlyAgg[hour].exits += data.exits || 0;
      hourlyAgg[hour].days++;
    }
  }
  // Average per hour
  const hourlyAvg = {};
  for (const [hour, data] of Object.entries(hourlyAgg)) {
    hourlyAvg[hour] = {
      totalEntries: data.entries,
      avgEntries: +(data.entries / data.days).toFixed(1),
    };
  }
  const peakHour = Object.entries(hourlyAgg)
    .sort((a, b) => b[1].entries - a[1].entries)[0];

  // ── Zone stats ──
  const zoneIds = new Set();
  days.forEach(d => Object.keys(d.zones || {}).forEach(z => zoneIds.add(z)));

  const zoneAgg = {};
  for (const zid of zoneIds) {
    const daysWithZone = days.filter(d => d.zones?.[zid]);
    if (daysWithZone.length === 0) continue;

    const maxOccupancy = Math.max(...daysWithZone.map(d => d.zones[zid].max || 0));
    const avgOccupancy = +(daysWithZone.reduce((a, d) => a + (d.zones[zid].avg || 0), 0) / daysWithZone.length).toFixed(1);
    const avgOccRate = +(daysWithZone.reduce((a, d) => a + (d.zones[zid].occupancyRate || 0), 0) / daysWithZone.length).toFixed(1);
    const totalMinutes = daysWithZone.reduce((a, d) => a + (d.zones[zid].minutesOccupied || 0), 0);

    zoneAgg[zid] = {
      maxOccupancy,
      avgOccupancy,
      avgOccupancyRate: avgOccRate,
      totalMinutesOccupied: totalMinutes,
      totalHoursOccupied: +(totalMinutes / 60).toFixed(1),
    };
  }

  // ── Dwell time ──
  const dwellAgg = {};
  for (const zid of zoneIds) {
    const daysWithDwell = days.filter(d => d.dwell?.[zid]?.samples > 0);
    if (daysWithDwell.length === 0) continue;

    const totalSamples = daysWithDwell.reduce((a, d) => a + d.dwell[zid].samples, 0);
    const weightedAvg = daysWithDwell.reduce((a, d) =>
      a + d.dwell[zid].avgSeconds * d.dwell[zid].samples, 0) / totalSamples;
    const maxDwell = Math.max(...daysWithDwell.map(d => d.dwell[zid].maxSeconds || 0));

    dwellAgg[zid] = {
      samples: totalSamples,
      avgSeconds: Math.round(weightedAvg),
      avgFormatted: weightedAvg >= 60
        ? `${Math.floor(weightedAvg/60)}m${Math.round(weightedAvg%60).toString().padStart(2,'0')}s`
        : `${Math.round(weightedAvg)}s`,
      maxSeconds: maxDwell,
    };
  }

  // ── Day-by-day breakdown ──
  const dailyBreakdown = days.map(d => ({
    date: d.date,
    entries: d.counter?.entries || 0,
    exits: d.counter?.exits || 0,
    peak: d.peak?.count || 0,
    peakTime: d.peak?.time?.slice(11, 16) || null,
    samples: d.samples || 0,
  }));

  // ── Weekday pattern ──
  const weekdayNames = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const weekdayAgg = {};
  for (const d of days) {
    const dow = new Date(d.date + 'T12:00:00Z').getUTCDay();
    const name = weekdayNames[dow];
    if (!weekdayAgg[name]) weekdayAgg[name] = { days: 0, entries: 0 };
    weekdayAgg[name].days++;
    weekdayAgg[name].entries += d.counter?.entries || 0;
  }
  for (const [name, data] of Object.entries(weekdayAgg)) {
    data.avgEntries = Math.round(data.entries / data.days);
  }

  return {
    from,
    to,
    daysTotal: dates.length,
    daysWithData: days.length,
    generatedAt: new Date().toISOString(),

    visitors: {
      total: totalEntries,
      avgDaily,
      peakDay: {
        date: peakDay.date,
        entries: peakDay.counter?.entries || 0,
      },
      peakHour: peakHour ? {
        hour: peakHour[0],
        totalEntries: peakHour[1].entries,
      } : null,
    },

    zones: zoneAgg,
    dwell: dwellAgg,
    hourly: hourlyAvg,
    weekday: weekdayAgg,
    daily: dailyBreakdown,
  };
}

// ── Pre-built ranges ────────────────────────────────────────

function thisWeek() {
  const t = today();
  return aggregate(mondayOfWeek(t), t);
}

function thisMonth() {
  const t = today();
  return aggregate(firstOfMonth(t), t);
}

function last7() {
  const t = today();
  return aggregate(addDays(t, -6), t);
}

function last30() {
  const t = today();
  return aggregate(addDays(t, -29), t);
}

module.exports = { aggregate, thisWeek, thisMonth, last7, last30 };
