/**
 * AYA Expo Tools — Computer Vision Manager (Multi-Camera)
 *
 * Spawns one Python detector per camera.
 * Aggregates counts using configurable strategy:
 *   - "max": total = max count from any single camera (conservative, no over-count)
 *   - "sum": total = sum of all cameras (use only if cameras have zero overlap)
 *
 * Each camera writes to cv/output/<cam-id>/ (detections.json, frame.jpg, heatmap.png)
 * Legacy single-camera writes to cv/output/ (backward compat)
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CV_DIR = path.join(__dirname, '..', 'cv');
const OUTPUT_DIR = path.join(CV_DIR, 'output');

class CVManager {
  constructor(config) {
    this.config = config;
    this.cvConfig = config.cv || {};
    this.camerasConfig = config.cameras || [];
    this.enabled = !!this.cvConfig.enabled;
    this.processes = new Map();  // camId → { process, pid }
    this.counterProcess = null;  // visitor counter process
    this._readInterval = null;
    this._cache = new Map();    // camId → { detections, status }
  }

  // ─── Public API ─────────────────────────────────────────────

  start() {
    if (!this.enabled) {
      console.log('  👁️ CV: desativado (cv.enabled = false no config)');
      return;
    }

    const pythonCmd = this._findPython();
    if (!pythonCmd) {
      console.log('  👁️ CV: Python não encontrado — execute install.bat para instalar');
      return;
    }

    // Determine cameras to run CV on
    const cvCameras = this.cvConfig.cameras || [this.cvConfig.camera || 'cam-1'];
    const configPath = this._getConfigPath();

    console.log(`  👁️ CV: iniciando ${cvCameras.length} detector(es) na GPU ${this.cvConfig.gpu || 1}`);

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    for (const camId of cvCameras) {
      this._startDetector(camId, pythonCmd, configPath);
    }

    // Start visitor counter if configured
    const counterCfg = this.cvConfig.counter;
    if (counterCfg && counterCfg.enabled) {
      this._startCounter(pythonCmd, configPath, counterCfg);
    }

    this._startReading();
  }

  _startDetector(camId, pythonCmd, configPath) {
    // Find camera RTSP from config
    const cam = this.camerasConfig.find(c => c.id === camId);
    if (!cam) {
      console.log(`  👁️ CV: câmera ${camId} não encontrada no config`);
      return;
    }

    const rtspUrl = `rtsp://${cam.user || 'admin'}:${cam.password || ''}@${cam.ip}:554/cam/realmonitor?channel=1&subtype=0`;

    // Ensure per-camera output dir
    const camOutDir = path.join(OUTPUT_DIR, camId);
    if (!fs.existsSync(camOutDir)) fs.mkdirSync(camOutDir, { recursive: true });

    const args = [
      path.join(CV_DIR, 'detector.py'),
      '--camera-id', camId,
      '--rtsp', rtspUrl,
      '--gpu', String(this.cvConfig.gpu || 1),
      '--interval', String(this.cvConfig.interval || 2),
      '--model', this.cvConfig.model || 'yolov8n',
      '--confidence', String(this.cvConfig.confidence || 0.4),
      '--heatmap-decay', String(this.cvConfig.heatmapDecay || 0.999),
      '--imgsz', String(this.cvConfig.imgsz || 640),
    ];

    if (configPath) {
      args.push('--config', configPath);
    }

    console.log(`  👁️ CV [${camId}]: starting detector`);

    const proc = spawn(pythonCmd, args, {
      cwd: CV_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    proc.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line.trim()) console.log(`  👁️ [${camId}] ${line.trim()}`);
      }
    });

    proc.stderr.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line.trim()) console.error(`  👁️ [${camId}] [err] ${line.trim()}`);
      }
    });

    proc.on('exit', (code) => {
      console.log(`  👁️ CV [${camId}]: processo saiu (code ${code})`);
      this.processes.delete(camId);

      // Auto-restart after 10s if still enabled
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

  _startCounter(pythonCmd, configPath, counterCfg) {
    // Find camera RTSP
    const camId = counterCfg.camera || 'cam-2';
    const cam = this.camerasConfig.find(c => c.id === camId);
    const rtspUrl = cam
      ? `rtsp://${cam.user || 'admin'}:${cam.password || ''}@${cam.ip}:554/cam/realmonitor?channel=1&subtype=0`
      : null;

    const args = [
      path.join(CV_DIR, 'counter.py'),
      '--gpu', String(this.cvConfig.gpu || 1),
      '--line', counterCfg.line || '500,480,1400,480',
      '--confidence', String(counterCfg.confidence || 0.45),
      '--interval', String(counterCfg.interval || 0.5),
      '--model', this.cvConfig.model || 'yolov8n',
    ];

    if (rtspUrl) args.push('--rtsp', rtspUrl);
    if (configPath) args.push('--config', configPath);

    console.log(`  👁️ CV [counter]: starting visitor counter on ${counterCfg.camera || 'cam-2'}`);

    const proc = spawn(pythonCmd, args, {
      cwd: CV_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    proc.stdout.on('data', (data) => {
      data.toString().trim().split('\n').forEach(line => {
        if (line.trim()) console.log(`  👁️ [counter] ${line.trim()}`);
      });
    });

    proc.stderr.on('data', (data) => {
      data.toString().trim().split('\n').forEach(line => {
        if (line.trim()) console.error(`  👁️ [counter] [err] ${line.trim()}`);
      });
    });

    proc.on('exit', (code) => {
      console.log(`  👁️ CV [counter]: process exited (code ${code})`);
      this.counterProcess = null;
      if (this.enabled && code !== 0) {
        console.log('  👁️ CV [counter]: restarting in 10s...');
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

  reload(config) {
    this.config = config;
    this.cvConfig = config.cv || {};
    this.camerasConfig = config.cameras || [];
    // Note: does not restart processes — call stop() then start() to apply changes
  }

  stop() {
    this.enabled = false;
    this._stopReading();

    for (const [camId, entry] of this.processes) {
      console.log(`  👁️ CV [${camId}]: parando...`);
      try { entry.process.kill('SIGTERM'); } catch {}
    }

    // Stop counter
    if (this.counterProcess) {
      try { this.counterProcess.process.kill('SIGTERM'); } catch {}
    }

    // Force kill after 5s
    setTimeout(() => {
      for (const [camId, entry] of this.processes) {
        try { entry.process.kill('SIGKILL'); } catch {}
      }
      this.processes.clear();
      if (this.counterProcess) {
        try { this.counterProcess.process.kill('SIGKILL'); } catch {}
        this.counterProcess = null;
      }
    }, 5000);
  }

  /**
   * Get aggregated status (for API and push)
   */
  getStatus() {
    const cvCameras = this.cvConfig.cameras || [this.cvConfig.camera || 'cam-1'];
    const strategy = this.cvConfig.countStrategy || 'max';
    const perCamera = {};
    let totalCount = 0;
    const counts = [];

    for (const camId of cvCameras) {
      const det = this._readDetections(camId);
      const status = this._readStatusFile(camId);
      const count = det?.count ?? 0;
      counts.push(count);

      perCamera[camId] = {
        count,
        fps: det?.fps ?? 0,
        running: this.processes.has(camId),
        pid: this.processes.get(camId)?.pid || null,
        status: status?.status || 'unknown',
        error: status?.error || null,
        timestamp: det?.timestamp || null,
      };
    }

    // Aggregation strategy
    if (strategy === 'sum') {
      totalCount = counts.reduce((a, b) => a + b, 0);
    } else {
      // "max" — conservative: total = highest single-camera count
      totalCount = counts.length > 0 ? Math.max(...counts) : 0;
    }

    // Visitor counter data
    const counterData = this._readCounterData();

    return {
      enabled: this.cvConfig.enabled || false,
      running: this.processes.size > 0,
      cameras: cvCameras.length,
      countStrategy: strategy,
      totalCount,
      perCamera,
      counter: counterData ? {
        running: !!this.counterProcess,
        pid: this.counterProcess?.pid || null,
        ...counterData,
      } : {
        running: !!this.counterProcess,
        enabled: !!(this.cvConfig.counter?.enabled),
      },
      model: this.cvConfig.model || 'yolov8n',
      gpu: this.cvConfig.gpu || 1,
    };
  }

  /**
   * Get detections for a specific camera
   */
  getDetections(camId) {
    return this._readDetections(camId);
  }

  /**
   * Get heatmap for a specific camera (PNG buffer)
   */
  getHeatmap(camId) {
    const file = camId
      ? path.join(OUTPUT_DIR, camId, 'heatmap.png')
      : path.join(OUTPUT_DIR, 'heatmap.png');
    if (!fs.existsSync(file)) return null;
    try { return fs.readFileSync(file); } catch { return null; }
  }

  /**
   * Get annotated frame for a specific camera (JPEG buffer)
   */
  getFrame(camId) {
    const file = camId
      ? path.join(OUTPUT_DIR, camId, 'frame.jpg')
      : path.join(OUTPUT_DIR, 'frame.jpg');
    if (!fs.existsSync(file)) return null;
    try { return fs.readFileSync(file); } catch { return null; }
  }

  /**
   * Reset heatmap for a specific camera (or all)
   */
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

  // ─── Private ────────────────────────────────────────────────

  _readDetections(camId) {
    const file = camId
      ? path.join(OUTPUT_DIR, camId, 'detections.json')
      : path.join(OUTPUT_DIR, 'detections.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  _readStatusFile(camId) {
    const file = camId
      ? path.join(OUTPUT_DIR, camId, 'status.json')
      : path.join(OUTPUT_DIR, 'status.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  _readCounterData() {
    const file = path.join(OUTPUT_DIR, 'counter', 'count.json');
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }

  getCounterData() {
    return this._readCounterData();
  }

  getCounterFrame() {
    const file = path.join(OUTPUT_DIR, 'counter', 'frame.jpg');
    if (!fs.existsSync(file)) return null;
    try { return fs.readFileSync(file); } catch { return null; }
  }

  _getCameraDirs() {
    try {
      return fs.readdirSync(OUTPUT_DIR)
        .filter(d => d.startsWith('cam-'))
        .map(d => path.join(OUTPUT_DIR, d));
    } catch { return []; }
  }

  _findPython() {
    const candidates = [
      path.join(CV_DIR, 'venv', 'Scripts', 'python.exe'),
      path.join(CV_DIR, 'venv', 'bin', 'python'),
      'C:\\Users\\AYA\\AppData\\Local\\Programs\\Python\\Python311\\python.exe',
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
    const configArg = process.argv.find(a => a.startsWith('--config='));
    const configName = configArg ? configArg.split('=')[1] : 'beleza-astral';
    const configPath = path.join(__dirname, '..', 'config', `${configName}.json`);
    return fs.existsSync(configPath) ? configPath : null;
  }

  _startReading() {
    this._readInterval = setInterval(() => {
      const cvCameras = this.cvConfig.cameras || [this.cvConfig.camera || 'cam-1'];
      for (const camId of cvCameras) {
        this._cache.set(camId, {
          detections: this._readDetections(camId),
          status: this._readStatusFile(camId),
        });
      }
    }, 2000);
  }

  _stopReading() {
    if (this._readInterval) {
      clearInterval(this._readInterval);
      this._readInterval = null;
    }
  }
}

module.exports = { CVManager };
