/**
 * AYA Expo Tools — Timelapse Capture
 *
 * Salva snapshot de cada câmera a cada INTERVAL segundos.
 * Estrutura: logs/timelapse/YYYY-MM-DD/cam-1/HHMMSS.jpg
 *
 * Sincronizado com o health log (mesmo timestamp base)
 * para correlacionar temperatura da GPU com o que estava acontecendo na sala.
 *
 * Storage estimate: 4 cams × 60s × 12h/day × ~20KB = ~56MB/day
 */

const fs = require('fs')
const path = require('path')

// Use D: drive if available, fallback to local
const BASE_DIR = fs.existsSync('D:\\aya-expo-data\\timelapse')
  ? 'D:\\aya-expo-data\\timelapse'
  : path.join(__dirname, '..', 'logs', 'timelapse')
const DEFAULT_INTERVAL = 60_000  // 60s

class TimelapseCapture {
  /**
   * @param {object} cameras — CameraManager instance
   * @param {object} [opts]
   * @param {number} [opts.interval] — ms between captures (default 60s)
   */
  constructor(cameras, opts = {}) {
    this.cameras = cameras
    this.interval = opts.interval || DEFAULT_INTERVAL
    this._timer = null
    this._capturing = false
    this._stats = {
      started: null,
      captures: 0,
      errors: 0,
      lastCapture: null,
    }
  }

  start() {
    if (this._timer) return

    // Ensure base dir
    try { fs.mkdirSync(BASE_DIR, { recursive: true }) } catch { /* ok */ }

    this._stats.started = new Date().toISOString()
    console.log(`  📸 Timelapse capture started (every ${this.interval / 1000}s)`)

    // First capture after 10s (let cameras initialize)
    setTimeout(() => this._capture(), 10_000)
    this._timer = setInterval(() => this._capture(), this.interval)
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  async _capture() {
    if (this._capturing) return  // skip if previous capture still running
    this._capturing = true

    const now = new Date()
    const dateStr = now.toISOString().slice(0, 10)  // YYYY-MM-DD
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '')  // HHMMSS

    const allCams = this.cameras.getAllStatus()

    for (const camStatus of allCams) {
      if (!camStatus.online) continue

      const cam = this.cameras.get(camStatus.id)
      if (!cam) continue

      const camDir = path.join(BASE_DIR, dateStr, camStatus.id)

      try {
        // Ensure directory
        fs.mkdirSync(camDir, { recursive: true })

        // Get snapshot (SD — lighter, sufficient for timelapse)
        const buffer = await cam.getSnapshot(false)
        if (!buffer || buffer.length < 1000) continue  // skip bad frames

        const filePath = path.join(camDir, `${timeStr}.jpg`)
        fs.writeFileSync(filePath, buffer)

        this._stats.captures++
        this._stats.lastCapture = now.toISOString()
      } catch (err) {
        this._stats.errors++
        // Silent — don't spam logs for offline cameras
      }
    }

    this._capturing = false
  }

  /** Get capture stats */
  getStats() {
    return { ...this._stats }
  }

  /**
   * List available dates
   * @returns {string[]} — ['2026-03-20', '2026-03-19', ...]
   */
  getDates() {
    try {
      return fs.readdirSync(BASE_DIR)
        .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  /**
   * List frames for a camera on a date
   * @param {string} date — 'YYYY-MM-DD'
   * @param {string} camId — 'cam-1'
   * @returns {{ time: string, file: string, path: string }[]}
   */
  getFrames(date, camId) {
    const dir = path.join(BASE_DIR, date, camId)
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.jpg'))
        .sort()
        .map(f => {
          const t = f.replace('.jpg', '')
          return {
            time: `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`,
            file: f,
            path: path.join(dir, f),
          }
        })
    } catch {
      return []
    }
  }

  /**
   * Get cameras available on a date
   * @param {string} date — 'YYYY-MM-DD'
   * @returns {string[]} — ['cam-1', 'cam-2', ...]
   */
  getCameras(date) {
    const dir = path.join(BASE_DIR, date)
    try {
      return fs.readdirSync(dir)
        .filter(d => d.startsWith('cam-'))
        .sort()
    } catch {
      return []
    }
  }

  /**
   * Get a specific frame as buffer
   * @param {string} date
   * @param {string} camId
   * @param {string} filename — 'HHMMSS.jpg'
   * @returns {Buffer|null}
   */
  getFrame(date, camId, filename) {
    // Sanitize inputs to prevent path traversal
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
    if (!/^cam-\d+$/.test(camId)) return null
    if (!/^\d{6}\.jpg$/.test(filename)) return null

    const filePath = path.join(BASE_DIR, date, camId, filename)
    try {
      return fs.readFileSync(filePath)
    } catch {
      return null
    }
  }

  /**
   * Get frame closest to a given time
   * @param {string} date
   * @param {string} camId
   * @param {string} time — 'HH:MM:SS' or 'HHMMSS'
   * @returns {{ time: string, file: string, path: string } | null}
   */
  getFrameAt(date, camId, time) {
    const target = time.replace(/:/g, '')
    const frames = this.getFrames(date, camId)
    if (frames.length === 0) return null

    // Binary-ish search for closest frame
    let closest = frames[0]
    let minDiff = Infinity
    for (const f of frames) {
      const ft = f.file.replace('.jpg', '')
      const diff = Math.abs(parseInt(ft) - parseInt(target))
      if (diff < minDiff) {
        minDiff = diff
        closest = f
      }
    }
    return closest
  }

  /** Storage stats */
  getStorageStats() {
    const dates = this.getDates()
    let totalFiles = 0
    let totalBytes = 0

    for (const date of dates.slice(0, 7)) {  // last 7 days only
      const cams = this.getCameras(date)
      for (const cam of cams) {
        const frames = this.getFrames(date, cam)
        totalFiles += frames.length
        // Estimate bytes from first frame
        if (frames.length > 0) {
          try {
            const stat = fs.statSync(frames[0].path)
            totalBytes += stat.size * frames.length  // estimate
          } catch { /* ok */ }
        }
      }
    }

    return {
      dates: dates.length,
      files7d: totalFiles,
      estimatedMB7d: Math.round(totalBytes / 1024 / 1024),
      estimatedMBPerDay: dates.length > 0 ? Math.round(totalBytes / Math.min(dates.length, 7) / 1024 / 1024) : 0,
    }
  }
}

module.exports = { TimelapseCapture }
