/**
 * AYA Expo Tools — Computer Vision Manager
 *
 * Manages the Python CV detector subprocess.
 * Reads detection results from cv/output/ files (file-based IPC).
 * Exposes status, counts, heatmap, and annotated frame via API.
 *
 * Architecture:
 *   Node.js (expo-tools) ──spawns──> Python (cv/detector.py)
 *     │                                  │
 *     │ reads cv/output/detections.json  │ writes every Ns
 *     │ reads cv/output/heatmap.png      │ writes every 10 frames
 *     │ reads cv/output/frame.jpg        │ writes every frame
 *     │ reads cv/output/status.json      │ writes on state change
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const CV_DIR = path.join(__dirname, '..', 'cv');
const OUTPUT_DIR = path.join(CV_DIR, 'output');
const DETECTIONS_FILE = path.join(OUTPUT_DIR, 'detections.json');
const HEATMAP_FILE = path.join(OUTPUT_DIR, 'heatmap.png');
const FRAME_FILE = path.join(OUTPUT_DIR, 'frame.jpg');
const STATUS_FILE = path.join(OUTPUT_DIR, 'status.json');

class CVManager {
  constructor(config) {
    this.config = config;
    this.cvConfig = config.cv || {};
    this.enabled = !!this.cvConfig.enabled;
    this.process = null;
    this._lastDetections = null;
    this._lastStatus = null;
    this._readInterval = null;
  }

  // ─── Public API ─────────────────────────────────────────────

  /**
   * Start the CV detector subprocess
   */
  start() {
    if (!this.enabled) {
      console.log('  👁️ CV: desativado (cv.enabled = false no config)');
      return;
    }

    // Check if Python is available
    const pythonCmd = this._findPython();
    if (!pythonCmd) {
      console.log('  👁️ CV: Python não encontrado — execute install.bat para instalar');
      return;
    }

    const configPath = this._getConfigPath();
    if (!configPath) {
      console.log('  👁️ CV: config path não encontrado');
      return;
    }

    console.log(`  👁️ CV: iniciando detector (GPU ${this.cvConfig.gpu || 1}, câmera ${this.cvConfig.camera || 'cam-1'})`);

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    // Spawn Python process
    const args = [
      path.join(CV_DIR, 'detector.py'),
      '--config', configPath,
    ];

    this.process = spawn(pythonCmd, args, {
      cwd: CV_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.stdout.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line.trim()) console.log(`  👁️ ${line.trim()}`);
      }
    });

    this.process.stderr.on('data', (data) => {
      const lines = data.toString().trim().split('\n');
      for (const line of lines) {
        if (line.trim()) console.error(`  👁️ [err] ${line.trim()}`);
      }
    });

    this.process.on('exit', (code) => {
      console.log(`  👁️ CV: processo saiu (code ${code})`);
      this.process = null;

      // Auto-restart after 10s if still enabled
      if (this.enabled && code !== 0) {
        console.log('  👁️ CV: reiniciando em 10s...');
        setTimeout(() => {
          if (this.enabled) this.start();
        }, 10000);
      }
    });

    // Start reading output files periodically
    this._startReading();
  }

  /**
   * Stop the CV detector
   */
  stop() {
    this.enabled = false;
    this._stopReading();

    if (this.process) {
      console.log('  👁️ CV: parando detector...');
      this.process.kill('SIGTERM');
      // Force kill after 5s if still alive
      setTimeout(() => {
        if (this.process) {
          this.process.kill('SIGKILL');
          this.process = null;
        }
      }, 5000);
    }
  }

  /**
   * Reload config (e.g., camera changed)
   */
  reload(config) {
    this.config = config;
    this.cvConfig = config.cv || {};
    const wasEnabled = this.enabled;
    this.enabled = !!this.cvConfig.enabled;

    if (wasEnabled && !this.enabled) {
      this.stop();
    } else if (!wasEnabled && this.enabled) {
      this.start();
    } else if (this.enabled && this.process) {
      // Restart with new config
      this.stop();
      this.enabled = true;
      setTimeout(() => this.start(), 2000);
    }
  }

  /**
   * Get current status (for API and push)
   */
  getStatus() {
    const status = this._readStatus();
    const detections = this._readDetections();

    return {
      enabled: this.cvConfig.enabled || false,
      running: !!this.process,
      pid: this.process?.pid || null,
      ...status,
      detections: detections ? {
        count: detections.count,
        fps: detections.fps,
        camera: detections.camera,
        resolution: detections.resolution,
        model: detections.model,
        gpu: detections.gpu,
        timestamp: detections.timestamp,
      } : null,
    };
  }

  /**
   * Get latest detections (full data including bounding boxes)
   */
  getDetections() {
    return this._readDetections();
  }

  /**
   * Get heatmap image buffer (PNG)
   */
  getHeatmap() {
    if (!fs.existsSync(HEATMAP_FILE)) return null;
    try {
      return fs.readFileSync(HEATMAP_FILE);
    } catch { return null; }
  }

  /**
   * Get annotated frame buffer (JPEG)
   */
  getFrame() {
    if (!fs.existsSync(FRAME_FILE)) return null;
    try {
      return fs.readFileSync(FRAME_FILE);
    } catch { return null; }
  }

  /**
   * Reset accumulated heatmap
   */
  resetHeatmap() {
    const rawFile = path.join(OUTPUT_DIR, 'heatmap_raw.npy');
    try {
      if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile);
      if (fs.existsSync(HEATMAP_FILE)) fs.unlinkSync(HEATMAP_FILE);
      return true;
    } catch { return false; }
  }

  // ─── Private ────────────────────────────────────────────────

  _findPython() {
    // Check common locations
    const candidates = [
      path.join(CV_DIR, 'venv', 'Scripts', 'python.exe'),   // local venv
      path.join(CV_DIR, 'venv', 'bin', 'python'),            // linux venv
      'python',
      'python3',
    ];

    for (const cmd of candidates) {
      try {
        const { execSync } = require('child_process');
        execSync(`"${cmd}" --version`, { stdio: 'ignore', timeout: 5000 });
        return cmd;
      } catch { /* not found */ }
    }
    return null;
  }

  _getConfigPath() {
    // Find the config file path from process args or default
    const configArg = process.argv.find(a => a.startsWith('--config='));
    const configName = configArg ? configArg.split('=')[1] : 'beleza-astral';
    const configPath = path.join(__dirname, '..', 'config', `${configName}.json`);
    return fs.existsSync(configPath) ? configPath : null;
  }

  _readDetections() {
    if (!fs.existsSync(DETECTIONS_FILE)) return null;
    try {
      const raw = fs.readFileSync(DETECTIONS_FILE, 'utf8');
      return JSON.parse(raw);
    } catch { return this._lastDetections; }
  }

  _readStatus() {
    if (!fs.existsSync(STATUS_FILE)) return {};
    try {
      const raw = fs.readFileSync(STATUS_FILE, 'utf8');
      return JSON.parse(raw);
    } catch { return this._lastStatus || {}; }
  }

  _startReading() {
    // Read output files every 2s to keep cache fresh
    this._readInterval = setInterval(() => {
      this._lastDetections = this._readDetections();
      this._lastStatus = this._readStatus();
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
