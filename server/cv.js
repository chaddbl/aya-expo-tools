/**
 * AYA Expo Tools — Computer Vision Manager v2
 *
 * v2: protocolo JSONL stdout (zero latência) em vez de polling de arquivo.
 *     Python emite eventos linha a linha; Node lê e processa em tempo real.
 *     Arquivos (heatmap.png, frame.jpg) ainda servidos como static.
 *
 * API pública (inalterada):
 *   cvManager.start()
 *   cvManager.stop()
 *   cvManager.getStatus()           → { enabled, running, totalCount, perCamera, zones, ... }
 *   cvManager.getDetections(camId)  → { count, detections, zones, fps, timestamp }
 *   cvManager.getHeatmap(camId)     → Buffer (PNG) | null
 *   cvManager.getFrame(camId)       → Buffer (JPEG) | null
 *   cvManager.resetHeatmap(camId)
 *   cvManager.getCounterData()
 *   cvManager.getCounterFrame()
 *
 * Eventos Node.js emitidos:
 *   cvManager.on('detection', { camId, count, fps, zones, detections, timestamp })
 *   cvManager.on('zone_change', { camId, zoneId, count, previous, timestamp }) [futuro]
 *   cvManager.on('ready', { camId, model, format, gpuName, zones })
 *   cvManager.on('error', { camId, message, retriable })
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const CV_DIR = path.join(__dirname, '..', 'cv');
const OUTPUT_DIR = path.join(CV_DIR, 'output');

class CVManager extends EventEmitter {
  constructor(config) {
    super();
    // EventEmitter: sem listener para 'error' → uncaught exception. Handler padrão.
    this.on('error', (err) => {
      console.error(`  👁️ CV [${err?.camId || '?'}] erro: ${err?.message || err}`);
    });
    this.config = config;
    this.cvConfig = config.cv || {};
    this.camerasConfig = config.cameras || [];
    this.enabled = !!this.cvConfig.enabled;

    this.processes = new Map();   // camId → { process, pid, camId }
    this.counterProcess = null;
    this._buffers = new Map();    // camId → string (linha parcial)
    this._cache = new Map();      // camId → último evento 'detection' recebido
    this._readyInfo = new Map();  // camId → evento 'ready' (model, format, gpuName)
    this._configPath = null;      // definido no start()
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  start() {
    if (!this.enabled) {
      console.log('  👁️ CV: desativado (cv.enabled = false no config)');
      return;
    }

    const pythonCmd = this._findPython();
    if (!pythonCmd) {
      console.log('  👁️ CV: Python não encontrado — execute install.bat');
      return;
    }

    const cvCameras = this.cvConfig.cameras || [this.cvConfig.camera || 'cam-1'];
    this._configPath = this._getConfigPath();

    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    console.log(`  👁️ CV v2: iniciando ${cvCameras.length} detector(es) | JSONL protocol`);

    for (const camId of cvCameras) {
      this._startDetector(camId, pythonCmd, this._configPath);
    }

    // Visitor counter (ainda usa arquivo — não muda nesta versão)
    const counterCfg = this.cvConfig.counter;
    if (counterCfg?.enabled) {
      this._startCounter(pythonCmd, this._configPath, counterCfg);
    }
  }

  stop() {
    this.enabled = false;

    // Collect PIDs before killing (needed for tree-kill on Windows)
    const pids = [];
    for (const [camId, entry] of this.processes) {
      console.log(`  👁️ CV [${camId}]: parando (PID ${entry.pid})...`);
      pids.push(entry.pid);
      try { entry.process.kill('SIGTERM'); } catch {}
    }

    if (this.counterProcess) {
      pids.push(this.counterProcess.pid);
      try { this.counterProcess.process.kill('SIGTERM'); } catch {}
    }

    setTimeout(() => {
      for (const [, entry] of this.processes) {
        try { entry.process.kill('SIGKILL'); } catch {}
      }
      this.processes.clear();
      this._buffers.clear();
      if (this.counterProcess) {
        try { this.counterProcess.process.kill('SIGKILL'); } catch {}
        this.counterProcess = null;
      }

      // Windows: taskkill /T kills entire process tree (catches orphan children
      // from venv launcher or any subprocess). Safe even if PIDs already exited.
      if (process.platform === 'win32') {
        const { execSync } = require('child_process');
        for (const pid of pids) {
          try {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
          } catch {} // ignore — process may already be dead
        }
      }
    }, 5000);
  }

  reload(config) {
    this.config = config;
    this.cvConfig = config.cv || {};
    this.camerasConfig = config.cameras || [];
    // Para aplicar mudanças: chamar stop() depois start()
  }

  /**
   * Status agregado — shape mantido compatível com portal-sync e API REST.
   */
  getStatus() {
    const cvCameras = this.cvConfig.cameras || [this.cvConfig.camera || 'cam-1'];
    const strategy = this.cvConfig.countStrategy || 'max';
    const perCamera = {};
    const counts = [];

    for (const camId of cvCameras) {
      const cached = this._cache.get(camId);
      const readyInfo = this._readyInfo.get(camId) || {};
      const count = cached?.count ?? 0;
      counts.push(count);

      perCamera[camId] = {
        count,
        fps: cached?.fps ?? 0,
        running: this.processes.has(camId),
        pid: this.processes.get(camId)?.pid || null,
        model: readyInfo.model || this.cvConfig.model || 'yolo11n',
        format: readyInfo.format || 'unknown',
        gpuName: readyInfo.gpuName || null,
        zones: cached?.zones || {},
        timestamp: cached?.timestamp || null,
      };
    }

    // Agrega zonas respeitando strategy por zona:
    //   "max" (padrão) → câmeras no mesmo espaço físico (ex: cam-1 + cam-3 na sala imersiva)
    //   "sum"          → câmeras em espaços distintos sem sobreposição
    const zonesConfig = this.cvConfig.zones || [];
    const aggregatedZones = {};

    for (const zone of zonesConfig) {
      const zoneStrategy = zone.strategy || 'max';
      const cameras = zone.cameras || {};
      // Suporta cameras como dict (novo) ou array (legado)
      const zoneCamIds = Array.isArray(cameras) ? cameras : Object.keys(cameras);
      const values = zoneCamIds
        .map(cid => perCamera[cid]?.zones?.[zone.id])
        .filter(v => v !== undefined);

      if (values.length === 0) {
        aggregatedZones[zone.id] = 0;
      } else if (zoneStrategy === 'sum') {
        aggregatedZones[zone.id] = values.reduce((a, b) => a + b, 0);
      } else {
        aggregatedZones[zone.id] = Math.max(...values);
      }
    }

    // totalCount: se há zonas configuradas, usa soma das zonas (mais preciso —
    // ignora detecções fora dos polígonos como spots de luz e falsos positivos).
    // Sem zonas: fallback para max de câmeras (comportamento legado).
    const hasZones = zonesConfig.length > 0 && Object.keys(aggregatedZones).length > 0;
    const totalCount = hasZones
      ? Object.values(aggregatedZones).reduce((a, b) => a + b, 0)
      : (strategy === 'sum'
          ? counts.reduce((a, b) => a + b, 0)
          : (counts.length > 0 ? Math.max(...counts) : 0));

    const counterData = this._readCounterData();

    return {
      enabled: this.cvConfig.enabled || false,
      running: this.processes.size > 0,
      cameras: cvCameras.length,
      countStrategy: strategy,
      totalCount,
      zones: aggregatedZones,
      zonesConfig: (this.cvConfig.zones || []).map(z => ({
        id: z.id,
        name: z.name,
        cameras: z.cameras,
        alert: z.alert,
      })),
      perCamera,
      counter: counterData
        ? { running: !!this.counterProcess, pid: this.counterProcess?.pid || null, ...counterData }
        : { running: !!this.counterProcess, enabled: !!(this.cvConfig.counter?.enabled) },
      model: this.cvConfig.model || 'yolo11n',
      gpu: this.cvConfig.gpu ?? 0,
      protocol: 'jsonl-v2',
    };
  }

  getDetections(camId) {
    // Retorna cache em memória (do JSONL) em vez de ler arquivo
    const cached = this._cache.get(camId);
    if (cached) return cached;
    // Fallback: arquivo (backward compat com processos antigos)
    return this._readDetectionsFile(camId);
  }

  getHeatmap(camId) {
    const file = camId
      ? path.join(OUTPUT_DIR, camId, 'heatmap.png')
      : path.join(OUTPUT_DIR, 'heatmap.png');
    if (!fs.existsSync(file)) return null;
    try { return fs.readFileSync(file); } catch { return null; }
  }

  getFrame(camId) {
    const file = camId
      ? path.join(OUTPUT_DIR, camId, 'frame.jpg')
      : path.join(OUTPUT_DIR, 'frame.jpg');
    if (!fs.existsSync(file)) return null;
    try { return fs.readFileSync(file); } catch { return null; }
  }

  resetHeatmap(camId) {
    const dirs = camId ? [path.join(OUTPUT_DIR, camId)] : this._getCameraDirs();
    let ok = true;
    for (const dir of dirs) {
      try {
        const raw = path.join(dir, 'heatmap_raw.npy');
        const png = path.join(dir, 'heatmap.png');
        if (fs.existsSync(raw)) fs.unlinkSync(raw);
        if (fs.existsSync(png)) fs.unlinkSync(png);
      } catch { ok = false; }
    }
    return ok;
  }

  getCounterData() { return this._readCounterData(); }
  getCounterFrame() {
    const file = path.join(OUTPUT_DIR, 'counter', 'frame.jpg');
    if (!fs.existsSync(file)) return null;
    try { return fs.readFileSync(file); } catch { return null; }
  }

  // ─── Private: processo detector ────────────────────────────────────────────

  _startDetector(camId, pythonCmd, configPath) {
    const cam = this.camerasConfig.find(c => c.id === camId);
    if (!cam) {
      console.log(`  👁️ CV: câmera ${camId} não encontrada no config`);
      return;
    }

    // Garante diretório de output por câmera
    const camOutDir = path.join(OUTPUT_DIR, camId);
    if (!fs.existsSync(camOutDir)) fs.mkdirSync(camOutDir, { recursive: true });

    // URL-encode credenciais
    const user = encodeURIComponent(cam.user || 'admin');
    const pass = cam.password ? encodeURIComponent(cam.password) : '';
    const rtspUrl = `rtsp://${user}:${pass}@${cam.ip}:554/cam/realmonitor?channel=1&subtype=0`;

    const args = [
      path.join(CV_DIR, 'detector.py'),
      '--camera-id', camId,
      '--rtsp', rtspUrl,
      '--gpu', String(this.cvConfig.gpu ?? 0),
      '--interval', String(this.cvConfig.interval ?? 0),
      '--model', this.cvConfig.model || 'yolo11n',
      '--confidence', String(this.cvConfig.confidence ?? 0.4),
      '--heatmap-decay', String(this.cvConfig.heatmapDecay ?? 0.999),
      '--imgsz', String(this.cvConfig.imgsz ?? 640),
    ];

    if (configPath) args.push('--config', configPath);
    if (this.cvConfig.noTrt) args.push('--no-trt');

    console.log(`  👁️ CV [${camId}]: iniciando (${this.cvConfig.model || 'yolo11n'}, GPU ${this.cvConfig.gpu ?? 0})`);

    const proc = spawn(pythonCmd, args, {
      cwd: CV_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    // ─── stdout: protocolo JSONL ──────────────────────────────────────────────
    this._buffers.set(camId, '');

    proc.stdout.on('data', (data) => {
      // Acumula buffer (pode chegar fragmentado)
      const buf = (this._buffers.get(camId) || '') + data.toString();
      const lines = buf.split('\n');
      this._buffers.set(camId, lines.pop()); // guarda fragmento incompleto

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Tenta parsear como JSON
        let event;
        try {
          event = JSON.parse(trimmed);
        } catch {
          // Linha de log não-JSON — exibe normalmente
          console.log(`  👁️ [${camId}] ${trimmed}`);
          continue;
        }

        this._handleEvent(camId, event);
      }
    });

    // stderr: logs Python (model loading, warnings, erros internos)
    proc.stderr.on('data', (data) => {
      data.toString().trim().split('\n').forEach(line => {
        if (line.trim()) console.log(`  👁️ [${camId}] ${line.trim()}`);
      });
    });

    proc.on('exit', (code) => {
      console.log(`  👁️ CV [${camId}]: processo encerrado (code ${code})`);
      this.processes.delete(camId);
      this._buffers.delete(camId);

      if (this.enabled && code !== 0) {
        console.log(`  👁️ CV [${camId}]: reiniciando em 10s...`);
        setTimeout(() => {
          if (this.enabled && !this.processes.has(camId)) {
            const py = this._findPython();
            if (py) this._startDetector(camId, py, configPath);
          }
        }, 10000);
      }
    });

    this.processes.set(camId, { process: proc, pid: proc.pid, camId });
  }

  /**
   * Processa evento JSONL recebido do Python.
   * Atualiza cache interno e emite evento Node.js correspondente.
   */
  _handleEvent(camId, event) {
    switch (event.event) {
      case 'ready':
        this._readyInfo.set(camId, {
          model: event.model,
          format: event.format,
          gpuName: event.gpuName,
          zones: event.zones || [],
          resolution: event.resolution,
        });
        console.log(`  👁️ CV [${camId}]: pronto | ${event.format} | GPU: ${event.gpuName} | zonas: ${(event.zones || []).join(', ') || 'nenhuma'}`);
        this.emit('ready', { camId, ...event });
        break;

      case 'detection': {
        // Atualiza cache (em memória — sem I/O de arquivo)
        const payload = {
          count: event.count,
          fps: event.fps,
          zones: event.zones || {},
          detections: event.detections || [],
          resolution: event.resolution,
          model: event.model,
          format: event.format,
          timestamp: event.timestamp,
          camera: camId,
        };
        this._cache.set(camId, payload);
        this.emit('detection', { camId, ...payload });
        break;
      }

      case 'status':
        // Reemite para quem precisar
        this.emit('status', { camId, ...event });
        break;

      case 'error':
        console.error(`  👁️ CV [${camId}] erro: ${event.message}`);
        this.emit('error', { camId, ...event });
        break;

      default:
        // Evento desconhecido — ignora silenciosamente
        break;
    }
  }

  // ─── Visitor Counter (arquivo-based, inalterado) ───────────────────────────

  _startCounter(pythonCmd, configPath, counterCfg) {
    const camId = counterCfg.camera || 'cam-2';
    const cam = this.camerasConfig.find(c => c.id === camId);
    const user = cam ? encodeURIComponent(cam.user || 'admin') : 'admin';
    const pass = cam?.password ? encodeURIComponent(cam.password) : '';
    const rtspUrl = cam
      ? `rtsp://${user}:${pass}@${cam.ip}:554/cam/realmonitor?channel=1&subtype=0`
      : null;

    const args = [
      path.join(CV_DIR, 'counter.py'),
      '--gpu', String(this.cvConfig.gpu ?? 0),
      '--line', counterCfg.line || '500,480,1400,480',
      '--confidence', String(counterCfg.confidence ?? 0.45),
      '--interval', String(counterCfg.interval ?? 0.5),
      '--model', this.cvConfig.model || 'yolo11n',
    ];

    if (rtspUrl) args.push('--rtsp', rtspUrl);
    if (configPath) args.push('--config', configPath);

    console.log(`  👁️ CV [counter]: iniciando em ${camId}`);

    const proc = spawn(pythonCmd, args, {
      cwd: CV_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    proc.stdout.on('data', d => d.toString().trim().split('\n').forEach(l => l.trim() && console.log(`  👁️ [counter] ${l.trim()}`)));
    proc.stderr.on('data', d => d.toString().trim().split('\n').forEach(l => l.trim() && console.error(`  👁️ [counter] [err] ${l.trim()}`)));

    proc.on('exit', (code) => {
      console.log(`  👁️ CV [counter]: encerrado (code ${code})`);
      this.counterProcess = null;
      if (this.enabled && code !== 0) {
        setTimeout(() => {
          if (this.enabled) {
            const py = this._findPython();
            if (py) this._startCounter(py, configPath, counterCfg);
          }
        }, 10000);
      }
    });

    this.counterProcess = { process: proc, pid: proc.pid };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  _readDetectionsFile(camId) {
    const file = camId
      ? path.join(OUTPUT_DIR, camId, 'detections.json')
      : path.join(OUTPUT_DIR, 'detections.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  _readCounterData() {
    const file = path.join(OUTPUT_DIR, 'counter', 'count.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  _getCameraDirs() {
    try {
      return fs.readdirSync(OUTPUT_DIR)
        .filter(d => d.startsWith('cam-'))
        .map(d => path.join(OUTPUT_DIR, d));
    } catch { return []; }
  }

  _findPython() {
    // Venv first — on Windows, the venv launcher spawns system python as a child
    // process, but crucially it activates the virtual environment so the child
    // inherits torch/ultralytics/etc from venv site-packages. Running system
    // Python directly would fail on import (deps not installed globally).
    // The tree-kill in stop() handles orphan child processes on Windows.
    const candidates = [
      path.join(CV_DIR, 'venv', 'Scripts', 'python.exe'),
      path.join(CV_DIR, 'venv', 'bin', 'python'),
      'C:\\Users\\AYA\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
      'C:\\Users\\Ihon\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
      'python',
      'python3',
    ];
    for (const cmd of candidates) {
      try {
        const { execSync } = require('child_process');
        execSync(`"${cmd}" --version`, { stdio: 'ignore', timeout: 5000 });
        return cmd;
      } catch {}
    }
    return null;
  }

  _getConfigPath() {
    // Tenta ler do argv (--config=beleza-astral) ou usa o primeiro config disponível
    const configArg = process.argv.find(a => a.startsWith('--config='));
    const configName = configArg ? configArg.split('=')[1] : null;
    if (configName) {
      const p = path.join(__dirname, '..', 'config', `${configName}.json`);
      if (fs.existsSync(p)) return p;
    }
    // Detecta automaticamente: pega o primeiro config da pasta (exceto template)
    const configDir = path.join(__dirname, '..', 'config');
    try {
      const files = fs.readdirSync(configDir).filter(f => f.endsWith('.json') && f !== 'template.json');
      if (files.length > 0) return path.join(configDir, files[0]);
    } catch {}
    return null;
  }
}

module.exports = { CVManager };
