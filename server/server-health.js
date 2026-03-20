/**
 * AYA Expo Tools — Server Health Monitor
 *
 * Coleta métricas do media server: GPU (nvidia-smi), CPU, RAM, disco, processos.
 * Polling a cada 30s. Mantém histórico dos últimos 60 pontos (30min) para tendências.
 *
 * Log persistente: JSONL por dia em logs/health/YYYY-MM-DD.jsonl
 * Cada linha é um snapshot compacto (timestamp, GPUs, CPU, RAM, disco, alertas).
 * Usado para relatórios e análise forense pós-incidente.
 */

const { execFile } = require('child_process')
const os = require('os')
const fs = require('fs')
const path = require('path')

// ── Config ───────────────────────────────────────────────────

const POLL_INTERVAL = 30_000       // 30s
const HISTORY_SIZE = 60            // 30min de histórico a 30s
const NVIDIA_SMI = 'C:\\Windows\\System32\\nvidia-smi.exe'
const GPU_QUERY = 'index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed,power.draw,power.limit'
// Health logs: use D: drive if available, fallback to local
const LOG_DIR = fs.existsSync('D:\\aya-expo-data\\health-logs')
  ? 'D:\\aya-expo-data\\health-logs'
  : path.join(__dirname, '..', 'logs', 'health')

// Processos críticos a monitorar
const WATCHED_PROCESSES = ['Arena.exe', 'node.exe', 'chrome.exe', 'rustdesk.exe']

// Pastas a medir tamanho (auto-detect D: drive)
const HAS_D_DRIVE = fs.existsSync('D:\\aya-expo-data')
const TRACKED_FOLDERS = {
  media: path.join(__dirname, '..', 'media'),
  timelapse: HAS_D_DRIVE ? 'D:\\aya-expo-data\\timelapse' : path.join(__dirname, '..', 'logs', 'timelapse'),
  healthLogs: LOG_DIR,
  cv: HAS_D_DRIVE ? 'D:\\aya-expo-data\\cv' : path.join(__dirname, '..', 'logs', 'cv'),
}

// ── State ────────────────────────────────────────────────────

let _current = null
let _history = []
let _pollTimer = null
let _prevCpuIdle = 0
let _prevCpuTotal = 0
let _alerts = []     // { type, message, timestamp, value, threshold }
let _storage = null  // folder sizes, refreshed every 5min
let _storageLastPoll = 0
const STORAGE_POLL_INTERVAL = 300_000  // 5min

// Alert thresholds
const THRESHOLDS = {
  gpuTemp: 75,       // °C — warn
  gpuTempCrit: 84,   // °C — critical (1080 Ti throttle point)
  gpuUtil: 95,       // % — sustained high
  cpuUtil: 90,       // %
  ramPct: 90,        // %
  diskPct: 90,       // %
}

// ── GPU via nvidia-smi ───────────────────────────────────────

function queryGpu() {
  return new Promise((resolve) => {
    execFile(NVIDIA_SMI, [
      '--query-gpu=' + GPU_QUERY,
      '--format=csv,noheader,nounits'
    ], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve([])
        return
      }

      const gpus = stdout.trim().split('\n').map(line => {
        const parts = line.split(',').map(s => s.trim())
        return {
          index: parseInt(parts[0]) || 0,
          name: parts[1] || 'Unknown',
          temp: parseInt(parts[2]) || 0,
          utilization: parseInt(parts[3]) || 0,
          memoryUsed: parseInt(parts[4]) || 0,
          memoryTotal: parseInt(parts[5]) || 0,
          fan: parseInt(parts[6]) || 0,
          powerDraw: parseFloat(parts[7]) || 0,
          powerLimit: parseFloat(parts[8]) || 0,
        }
      })

      resolve(gpus)
    })
  })
}

// ── CPU ──────────────────────────────────────────────────────

function getCpuUsage() {
  const cpus = os.cpus()
  let idle = 0, total = 0

  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += cpu.times[type]
    }
    idle += cpu.times.idle
  }

  const diffIdle = idle - _prevCpuIdle
  const diffTotal = total - _prevCpuTotal
  _prevCpuIdle = idle
  _prevCpuTotal = total

  if (diffTotal === 0) return 0
  return Math.round((1 - diffIdle / diffTotal) * 100)
}

// ── RAM ──────────────────────────────────────────────────────

function getRam() {
  const total = os.totalmem()
  const free = os.freemem()
  const used = total - free
  return {
    used: Math.round(used / 1024 / 1024),    // MB
    total: Math.round(total / 1024 / 1024),   // MB
    pct: Math.round((used / total) * 100),
  }
}

// ── Disco ────────────────────────────────────────────────────

function getDisk() {
  return new Promise((resolve) => {
    // PowerShell — get all FileSystem drives
    const cmd = HAS_D_DRIVE
      ? "Get-PSDrive C,D -ErrorAction SilentlyContinue | Select-Object Name,Used,Free | ConvertTo-Json"
      : "Get-PSDrive C | Select-Object Used,Free | ConvertTo-Json"

    execFile('powershell.exe', [
      '-NoProfile', '-Command', cmd
    ], { timeout: 8000 }, (err, stdout) => {
      if (err) { resolve(null); return }

      try {
        const raw = JSON.parse(stdout.trim())
        const drives = Array.isArray(raw) ? raw : [raw]
        const result = {}

        for (const d of drives) {
          const name = (d.Name || 'C').toUpperCase()
          const used = d.Used || 0
          const free = d.Free || 0
          const total = used + free
          result[name] = {
            free: Math.round(free / 1024 / 1024 / 1024),
            total: Math.round(total / 1024 / 1024 / 1024),
            used: Math.round(used / 1024 / 1024 / 1024),
            pct: total > 0 ? Math.round((used / total) * 100) : 0,
          }
        }

        // Primary disk = C for backward compat; add drives array
        resolve({ ...result.C, drives: result })
      } catch {
        resolve(null)
      }
    })
  })
}

// ── Folder Sizes ─────────────────────────────────────────────

function getFolderSizes() {
  const result = {}
  for (const [name, dirPath] of Object.entries(TRACKED_FOLDERS)) {
    try {
      result[name] = getDirSize(dirPath)
    } catch {
      result[name] = { bytes: 0, mb: 0, files: 0 }
    }
  }
  return result
}

function getDirSize(dirPath) {
  let totalBytes = 0
  let totalFiles = 0

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        const sub = getDirSize(fullPath)
        totalBytes += sub.bytes
        totalFiles += sub.files
      } else if (entry.isFile()) {
        try {
          totalBytes += fs.statSync(fullPath).size
          totalFiles++
        } catch { /* skip */ }
      }
    }
  } catch { /* dir doesn't exist */ }

  return { bytes: totalBytes, mb: Math.round(totalBytes / 1024 / 1024), files: totalFiles }
}

// ── Processos ────────────────────────────────────────────────

function getProcesses() {
  return new Promise((resolve) => {
    // tasklist com filtro pelos processos monitorados
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        resolve([])
        return
      }

      const running = []
      const lines = stdout.trim().split('\n')

      for (const proc of WATCHED_PROCESSES) {
        const matches = lines.filter(l => l.toLowerCase().includes(proc.toLowerCase()))
        if (matches.length > 0) {
          // Parse first match for memory
          const parts = matches[0].split('","')
          const mem = parts[4] ? parts[4].replace(/[^0-9]/g, '') : '0'
          running.push({
            name: proc,
            instances: matches.length,
            memoryKB: parseInt(mem) || 0,
          })
        }
      }

      resolve(running)
    })
  })
}

// ── Alertas ──────────────────────────────────────────────────

function checkAlerts(data) {
  const now = new Date().toISOString()
  const newAlerts = []

  if (data.gpus) {
    for (const gpu of data.gpus) {
      if (gpu.temp >= THRESHOLDS.gpuTempCrit) {
        newAlerts.push({ type: 'critical', category: 'gpu-temp', message: `GPU ${gpu.index} a ${gpu.temp}°C — CRÍTICO (throttle a ${THRESHOLDS.gpuTempCrit}°C)`, value: gpu.temp, threshold: THRESHOLDS.gpuTempCrit, timestamp: now })
      } else if (gpu.temp >= THRESHOLDS.gpuTemp) {
        newAlerts.push({ type: 'warning', category: 'gpu-temp', message: `GPU ${gpu.index} a ${gpu.temp}°C — acima de ${THRESHOLDS.gpuTemp}°C`, value: gpu.temp, threshold: THRESHOLDS.gpuTemp, timestamp: now })
      }

      if (gpu.utilization >= THRESHOLDS.gpuUtil) {
        newAlerts.push({ type: 'warning', category: 'gpu-util', message: `GPU ${gpu.index} a ${gpu.utilization}% utilização`, value: gpu.utilization, threshold: THRESHOLDS.gpuUtil, timestamp: now })
      }
    }
  }

  if (data.cpu >= THRESHOLDS.cpuUtil) {
    newAlerts.push({ type: 'warning', category: 'cpu', message: `CPU a ${data.cpu}%`, value: data.cpu, threshold: THRESHOLDS.cpuUtil, timestamp: now })
  }

  if (data.ram && data.ram.pct >= THRESHOLDS.ramPct) {
    newAlerts.push({ type: 'warning', category: 'ram', message: `RAM a ${data.ram.pct}%`, value: data.ram.pct, threshold: THRESHOLDS.ramPct, timestamp: now })
  }

  if (data.disk && data.disk.pct >= THRESHOLDS.diskPct) {
    newAlerts.push({ type: 'warning', category: 'disk', message: `Disco a ${data.disk.pct}% (${data.disk.free}GB livres)`, value: data.disk.pct, threshold: THRESHOLDS.diskPct, timestamp: now })
  }
  if (data.disk && data.disk.free <= 20) {
    newAlerts.push({ type: 'critical', category: 'disk-low', message: `Disco com apenas ${data.disk.free}GB livres — CRÍTICO`, value: data.disk.free, threshold: 20, timestamp: now })
  }

  // Keep last 20 alerts
  _alerts = [...newAlerts, ..._alerts].slice(0, 20)

  return newAlerts
}

// ── Persistent Log (JSONL) ───────────────────────────────────

let _logStream = null
let _logDate = null    // 'YYYY-MM-DD' do arquivo aberto

function ensureLogDir() {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }) } catch { /* já existe */ }
}

function getLogStream() {
  const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  if (_logStream && _logDate === today) return _logStream

  // Fecha stream anterior se mudou de dia
  if (_logStream) {
    try { _logStream.end() } catch { /* ok */ }
  }

  ensureLogDir()
  const filePath = path.join(LOG_DIR, `${today}.jsonl`)
  _logStream = fs.createWriteStream(filePath, { flags: 'a' })
  _logDate = today
  return _logStream
}

function persistLog(data) {
  try {
    // Formato compacto — 1 linha por snapshot, sem processos (muito verboso)
    const entry = {
      t: data.timestamp,
      gpus: (data.gpus || []).map(g => ({
        i: g.index, temp: g.temp, util: g.utilization,
        vram: g.memoryUsed, fan: g.fan, pwr: Math.round(g.powerDraw),
      })),
      cpu: data.cpu,
      ram: data.ram?.pct ?? null,
      ramMB: data.ram?.used ?? null,
      disk: data.disk?.pct ?? null,
      diskFreeGB: data.disk?.free ?? null,
      storageMB: data.storage ? {
        media: data.storage.media?.mb ?? 0,
        timelapse: data.storage.timelapse?.mb ?? 0,
        logs: data.storage.healthLogs?.mb ?? 0,
      } : null,
      resolume: data.resolume ? 1 : 0,
      osUp: data.osUptime,
    }

    // Adiciona alertas somente se existirem (economiza espaço)
    if (data.alerts && data.alerts.length > 0) {
      entry.alerts = data.alerts.map(a => ({ type: a.type, cat: a.category, val: a.value }))
    }

    const stream = getLogStream()
    stream.write(JSON.stringify(entry) + '\n')
  } catch (err) {
    console.error('[server-health] log write error:', err.message)
  }
}

// ── Poll ─────────────────────────────────────────────────────

async function poll() {
  try {
    const [gpus, disk, processes] = await Promise.all([
      queryGpu(),
      getDisk(),
      getProcesses(),
    ])

    const cpu = getCpuUsage()
    const ram = getRam()

    // Storage: refresh every 5min (expensive I/O)
    const now = Date.now()
    if (!_storage || now - _storageLastPoll >= STORAGE_POLL_INTERVAL) {
      _storage = getFolderSizes()
      _storageLastPoll = now
    }

    const data = {
      gpus,
      cpu,
      ram,
      disk,
      storage: _storage,
      processes,
      resolume: processes.some(p => p.name === 'Arena.exe'),
      osUptime: Math.floor(os.uptime()),
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      timestamp: new Date().toISOString(),
    }

    // Check alerts
    const newAlerts = checkAlerts(data)
    data.alerts = newAlerts

    _current = data

    // Persistent log — JSONL por dia
    persistLog(data)

    // History — keep last N points
    _history.push({
      t: Date.now(),
      gpu0Temp: gpus[0]?.temp ?? null,
      gpu0Util: gpus[0]?.utilization ?? null,
      gpu1Temp: gpus[1]?.temp ?? null,
      gpu1Util: gpus[1]?.utilization ?? null,
      cpu,
      ramPct: ram.pct,
    })
    if (_history.length > HISTORY_SIZE) {
      _history = _history.slice(-HISTORY_SIZE)
    }

    return data
  } catch (err) {
    console.error('[server-health] poll error:', err.message)
    return _current
  }
}

// ── Public API ───────────────────────────────────────────────

module.exports = {
  /**
   * Start polling. Call once at startup.
   * @param {number} [interval] — ms between polls (default 30s)
   */
  start(interval = POLL_INTERVAL) {
    // Initial CPU baseline (first reading is always 0)
    getCpuUsage()

    // First poll immediately
    poll().then(() => {
      console.log('  📊 Server health monitor started')
    })

    _pollTimer = setInterval(poll, interval)
  },

  /** Stop polling */
  stop() {
    if (_pollTimer) {
      clearInterval(_pollTimer)
      _pollTimer = null
    }
    if (_logStream) {
      try { _logStream.end() } catch { /* ok */ }
      _logStream = null
    }
  },

  /** Get current snapshot */
  getCurrent() {
    return _current
  },

  /** Get history array (last 30min) */
  getHistory() {
    return _history
  },

  /** Get active alerts */
  getAlerts() {
    return _alerts
  },

  /** Get thresholds (for UI display) */
  getThresholds() {
    return { ...THRESHOLDS }
  },

  /** Force a poll now (returns promise) */
  poll,

  /**
   * List available log dates
   * @returns {string[]} — ['2026-03-20', '2026-03-19', ...]
   */
  getLogDates() {
    try {
      return fs.readdirSync(LOG_DIR)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace('.jsonl', ''))
        .sort()
        .reverse()
    } catch {
      return []
    }
  },

  /**
   * Read log for a specific date
   * @param {string} date — 'YYYY-MM-DD'
   * @param {object} [opts] — { from?: string (HH:MM), to?: string (HH:MM), downsample?: number (seconds) }
   * @returns {object[]} — array of log entries
   */
  readLog(date, opts = {}) {
    const filePath = path.join(LOG_DIR, `${date}.jsonl`)
    if (!fs.existsSync(filePath)) return []

    try {
      const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n')
      let entries = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

      // Time filter
      if (opts.from) {
        const fromTime = `${date}T${opts.from}:00`
        entries = entries.filter(e => e.t >= fromTime)
      }
      if (opts.to) {
        const toTime = `${date}T${opts.to}:59`
        entries = entries.filter(e => e.t <= toTime)
      }

      // Downsample — keep 1 entry per N seconds (for large datasets)
      if (opts.downsample && opts.downsample > 30) {
        const interval = opts.downsample * 1000
        const sampled = []
        let lastTime = 0
        for (const e of entries) {
          const t = new Date(e.t).getTime()
          if (t - lastTime >= interval) {
            sampled.push(e)
            lastTime = t
          }
        }
        entries = sampled
      }

      return entries
    } catch {
      return []
    }
  },

  /**
   * Generate daily summary from log
   * @param {string} date — 'YYYY-MM-DD'
   * @returns {object} — { date, samples, gpu0: {min,max,avg,peak}, cpu: {min,max,avg}, ram: {min,max,avg}, alerts: [...] }
   */
  dailySummary(date) {
    const entries = this.readLog(date)
    if (entries.length === 0) return null

    const gpu0Temps = entries.map(e => e.gpus?.[0]?.temp).filter(t => t != null)
    const gpu1Temps = entries.map(e => e.gpus?.[1]?.temp).filter(t => t != null)
    const cpus = entries.map(e => e.cpu).filter(c => c != null)
    const rams = entries.map(e => e.ram).filter(r => r != null)

    const stats = (arr) => {
      if (arr.length === 0) return null
      const sorted = [...arr].sort((a, b) => a - b)
      return {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: Math.round(arr.reduce((a, b) => a + b, 0) / arr.length),
        p95: sorted[Math.floor(arr.length * 0.95)],
      }
    }

    // Collect all alerts from the day
    const allAlerts = entries.filter(e => e.alerts && e.alerts.length > 0)

    return {
      date,
      samples: entries.length,
      duration: entries.length > 1
        ? Math.round((new Date(entries[entries.length - 1].t) - new Date(entries[0].t)) / 1000 / 60) + ' min'
        : '0 min',
      firstSample: entries[0].t,
      lastSample: entries[entries.length - 1].t,
      gpu0: stats(gpu0Temps),
      gpu1: stats(gpu1Temps),
      cpu: stats(cpus),
      ram: stats(rams),
      alertCount: allAlerts.length,
      alertSamples: allAlerts.slice(0, 10).map(e => ({ t: e.t, alerts: e.alerts })),
    }
  },

  /** Path to log directory (for external access) */
  LOG_DIR,
}
