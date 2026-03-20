/**
 * AYA Expo Tools — Server Health Monitor
 *
 * Coleta métricas do media server: GPU (nvidia-smi), CPU, RAM, disco, processos.
 * Polling a cada 30s. Mantém histórico dos últimos 60 pontos (30min) para tendências.
 */

const { execFile } = require('child_process')
const os = require('os')
const path = require('path')

// ── Config ───────────────────────────────────────────────────

const POLL_INTERVAL = 30_000       // 30s
const HISTORY_SIZE = 60            // 30min de histórico a 30s
const NVIDIA_SMI = 'C:\\Windows\\System32\\nvidia-smi.exe'
const GPU_QUERY = 'index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,fan.speed,power.draw,power.limit'

// Processos críticos a monitorar
const WATCHED_PROCESSES = ['Arena.exe', 'node.exe', 'chrome.exe', 'rustdesk.exe']

// ── State ────────────────────────────────────────────────────

let _current = null
let _history = []
let _pollTimer = null
let _prevCpuIdle = 0
let _prevCpuTotal = 0
let _alerts = []     // { type, message, timestamp, value, threshold }

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
    // PowerShell — works on Windows 11 where wmic is deprecated
    execFile('powershell.exe', [
      '-NoProfile', '-Command',
      "Get-PSDrive C | Select-Object Used,Free | ConvertTo-Json"
    ], { timeout: 8000 }, (err, stdout) => {
      if (err) {
        resolve(null)
        return
      }

      try {
        const data = JSON.parse(stdout.trim())
        const used = data.Used || 0
        const free = data.Free || 0
        const total = used + free

        resolve({
          free: Math.round(free / 1024 / 1024 / 1024),    // GB
          total: Math.round(total / 1024 / 1024 / 1024),   // GB
          used: Math.round(used / 1024 / 1024 / 1024),     // GB
          pct: total > 0 ? Math.round((used / total) * 100) : 0,
        })
      } catch {
        resolve(null)
      }
    })
  })
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
    newAlerts.push({ type: 'warning', category: 'disk', message: `Disco a ${data.disk.pct}%`, value: data.disk.pct, threshold: THRESHOLDS.diskPct, timestamp: now })
  }

  // Keep last 20 alerts
  _alerts = [...newAlerts, ..._alerts].slice(0, 20)

  return newAlerts
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

    const data = {
      gpus,
      cpu,
      ram,
      disk,
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
}
