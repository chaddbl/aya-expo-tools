/**
 * AYA Expo Tools — Portal Sync
 *
 * Push periódico de status para o Portal AYA via HTTP POST.
 * O portal armazena em memória e distribui via SSE para os browsers conectados.
 *
 * Arquitetura (Ciclo 2):
 *   Expo-tools ──HTTP POST 30s──► Portal /api/expo/[slug]/push
 *                                      └──SSE──► Browser (presença em tempo real)
 *
 * Requisitos do Case Mori (R1, R3):
 *   R1 — Reconnect com backoff exponencial: 5s → 10s → 20s → … → 60s (cap)
 *   R3 — Circuit breaker: 10 falhas em 5min → pausa 30min, depois tenta de novo
 */

const https = require('https')
const http = require('http')
const fs = require('fs')
const path = require('path')
const network = require('./network')
const tv = require('./tv')

// Carrega .env local (se existir) sem dependência de dotenv
// Formato suportado: KEY=VALUE por linha, # para comentários
;(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx < 1) continue
      const key = trimmed.slice(0, eqIdx).trim()
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '')
      if (!(key in process.env)) process.env[key] = val
    }
  } catch { /* ignora .env malformado */ }
})()

class PortalSync {
  /**
   * @param {object} config   — configuração completa da expo
   * @param {object} projectors — ProjectorManager
   * @param {object} cameras    — CameraManager
   * @param {object} scheduler  — Scheduler
   * @param {function} readLog  — retorna array de log entries
   * @param {object} [session]  — referência ao objeto de sessão ativa (Ciclo 3)
   */
  constructor(config, projectors, cameras, schedulerRef, readLog, session, cvManager, serverHealth) {
    this.config = config
    this.projectors = projectors
    this.cameras = cameras
    this.scheduler = schedulerRef
    this.readLog = readLog
    this.session = session || null
    this.cvManager = cvManager || null
    this.serverHealth = serverHealth || null

    // Configuração do portal sync (config/[expo].json → portalSync)
    const ps = config.portalSync || {}
    this.enabled = ps.enabled !== false && !!ps.url
    this.portalUrl = (ps.url || '').replace(/\/$/, '') // sem trailing slash
    this.apiKey = process.env.PORTAL_BOT_API_KEY || ps.apiKey || ''
    this.interval = ps.interval || 30_000 // ms entre pushes

    // Estado interno
    this._running = false
    this._timer = null
    this._camRotation = 0

    // Backoff exponencial
    this._retryDelay = 5_000
    this._maxRetryDelay = 60_000

    // Circuit breaker
    this._failureWindow = [] // timestamps de falhas recentes
    this._circuitOpen = false
    this._circuitOpenUntil = 0
    this._circuitMaxFailures = 10       // falhas no janelamento
    this._circuitWindowMs = 5 * 60_000 // 5 minutos
    this._circuitPauseMs = 30 * 60_000 // pausa de 30 minutos
  }

  // ─── Public ───────────────────────────────────────────────

  start() {
    if (!this.enabled) {
      console.log('  ⚡ Portal sync: desativado (sem portalSync.url no config)')
      return
    }
    if (!this.apiKey) {
      console.log('  ⚡ Portal sync: sem API key (PORTAL_BOT_API_KEY ou portalSync.apiKey)')
      return
    }
    console.log(`  ⚡ Portal sync: → ${this.portalUrl} (a cada ${this.interval / 1000}s)`)
    this._running = true
    this._push() // push imediato no início
  }

  stop() {
    this._running = false
    if (this._timer) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }

  // ─── Circuit Breaker ──────────────────────────────────────

  _isCircuitOpen() {
    if (!this._circuitOpen) return false
    if (Date.now() > this._circuitOpenUntil) {
      this._circuitOpen = false
      this._failureWindow = []
      this._retryDelay = 5_000
      console.log('  ⚡ Portal sync: circuit RESET — retentando...')
      return false
    }
    return true
  }

  _recordFailure() {
    const now = Date.now()
    this._failureWindow.push(now)
    // Remove falhas fora da janela de 5min
    this._failureWindow = this._failureWindow.filter(t => now - t < this._circuitWindowMs)

    if (this._failureWindow.length >= this._circuitMaxFailures) {
      this._circuitOpen = true
      this._circuitOpenUntil = now + this._circuitPauseMs
      const pauseMin = Math.round(this._circuitPauseMs / 60_000)
      console.log(`  ⚡ Portal sync: circuit ABERTO — pausando ${pauseMin}min (${this._failureWindow.length} falhas em 5min)`)
      return
    }

    // Backoff exponencial
    this._retryDelay = Math.min(this._retryDelay * 2, this._maxRetryDelay)
    console.log(`  ⚡ Portal sync: retry em ${this._retryDelay / 1000}s`)
  }

  _recordSuccess() {
    this._retryDelay = 5_000 // reset backoff
    this._failureWindow = [] // limpa falhas anteriores ao sucesso
  }

  // ─── Payload ──────────────────────────────────────────────

  async _getTvStatus() {
    const tvs = this.config.tvs || []
    if (tvs.length === 0) return []

    const results = await Promise.allSettled(tvs.map(async t => {
      try {
        const status = await tv.getStatus(t)
        return {
          id: t.id, name: t.name, model: t.model,
          videoUrl: t.videoUrl, videoTitle: t.videoTitle,
          online: status.online || false,
          isStandBy: status.isStandBy ?? null,
          volume: status.volume || null,
          application: status.application || null,
        }
      } catch {
        return {
          id: t.id, name: t.name, model: t.model,
          videoUrl: t.videoUrl, videoTitle: t.videoTitle,
          online: false, volume: null, application: null,
        }
      }
    }))

    return results.map(r => r.status === 'fulfilled' ? r.value : r.reason)
  }

  _buildCvPayload() {
    if (!this.cvManager) return null
    const status = this.cvManager.getStatus()
    const counter = this.cvManager.getCounterData()

    const payload = {
      enabled: status.enabled,
      running: status.running,
      cameras: status.cameras,
      totalCount: status.totalCount,
      countStrategy: status.countStrategy,
      model: status.model,
      gpu: status.gpu,
      counter: counter || null,
      perCamera: status.perCamera ? Object.fromEntries(
        Object.entries(status.perCamera).map(([k, v]) => [k, { count: v.count, fps: v.fps, running: v.running }])
      ) : undefined,
    }

    // Heatmap: push 1x per hour (base64 PNG of first CV camera)
    const now = Date.now()
    if (!this._lastHeatmapPush || now - this._lastHeatmapPush > 3600_000) {
      const cvCams = this.config.cv?.cameras || []
      const camId = cvCams[0] || null
      if (camId) {
        const buffer = this.cvManager.getHeatmap(camId)
        if (buffer) {
          payload.heatmapBase64 = buffer.toString('base64')
          payload.heatmapCamId = camId
          payload.heatmapUpdatedAt = new Date().toISOString()
          this._lastHeatmapPush = now
        }
      }
    }

    return payload
  }

  async _buildPayload() {
    const slug = this.config.exhibition.slug

    // Health
    let internet = false
    try {
      const inet = await Promise.race([
        network.checkInternet(),
        new Promise(r => setTimeout(() => r({ online: false }), 3_000)),
      ])
      internet = !!inet.online
    } catch { /* ignora */ }

    const health = {
      status: 'ok',
      exhibition: this.config.exhibition.name,
      venue: this.config.exhibition.venue,
      city: this.config.exhibition.city,
      uptime: Math.floor(process.uptime()),
      projectors: this.projectors.getAllStatus().length,
      cameras: this.cameras.getAllStatus().length,
      tvs: (this.config.tvs || []).length,
      internet,
      schedule: this.scheduler.enabled,
      timestamp: new Date().toISOString(),
    }

    const payload = {
      slug,
      pushedAt: new Date().toISOString(),
      health,
      projectors: this.projectors.getAllStatus(),
      cameras: this.cameras.getAllStatus(),
      tvs: await this._getTvStatus(),
      log: this.readLog().slice(0, 50),
      session: this.session ? { active: this.session.active, startedAt: this.session.startedAt, startedBy: this.session.startedBy } : null,
      cv: this.cvManager ? this._buildCvPayload() : null,
      server: this.serverHealth ? this.serverHealth.getCurrent() : null,
      schedule: this.scheduler ? this.scheduler.getStatus() : null,
    }

    // Snapshot de 1 câmera por push (rodízio)
    const cams = this.cameras.getAllStatus()
    if (cams.length > 0) {
      const idx = this._camRotation % cams.length
      const camStatus = cams[idx]
      const cam = this.cameras.get(camStatus.id)
      if (cam) {
        try {
          const buffer = await cam.getSnapshot(false) // SD — mais leve
          payload.cameraSnapshot = {
            camId: camStatus.id,
            data: buffer.toString('base64'),
            contentType: 'image/jpeg',
          }
        } catch { /* câmera inacessível — snapshot omitido */ }
      }
      this._camRotation++
    }

    return payload
  }

  // ─── HTTP Push ────────────────────────────────────────────

  async _httpPost(url, body, apiKey) {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url)
      const mod = parsed.protocol === 'https:' ? https : http
      const data = JSON.stringify(body)

      const req = mod.request({
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: 10_000,
      }, (res) => {
        let body = ''
        res.on('data', d => body += d)
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body })
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`))
          }
        })
      })

      req.on('error', reject)
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout (10s)')) })
      req.write(data)
      req.end()
    })
  }

  // ─── Push Loop ────────────────────────────────────────────

  async _push() {
    if (!this._running) return

    // Circuit breaker check
    if (this._isCircuitOpen()) {
      const waitMs = Math.max(this._circuitOpenUntil - Date.now(), 1_000)
      this._timer = setTimeout(() => this._push(), waitMs)
      return
    }

    const slug = this.config.exhibition.slug
    const pushUrl = `${this.portalUrl}/api/expo/${slug}/push`

    try {
      const payload = await this._buildPayload()
      await this._httpPost(pushUrl, payload, this.apiKey)
      this._recordSuccess()

      if (this._running) {
        this._timer = setTimeout(() => this._push(), this.interval)
      }
    } catch (err) {
      console.error(`  ⚡ Portal sync: falha — ${err.message}`)
      this._recordFailure()

      if (!this._running) return

      if (this._circuitOpen) {
        const waitMs = Math.max(this._circuitOpenUntil - Date.now(), 1_000)
        this._timer = setTimeout(() => this._push(), waitMs)
      } else {
        this._timer = setTimeout(() => this._push(), this._retryDelay)
      }
    }
  }
}

module.exports = { PortalSync }
