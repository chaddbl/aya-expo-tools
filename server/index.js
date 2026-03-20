/**
 * AYA Expo Tools — Server
 * Express + WebSocket for real-time updates
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const { ProjectorManager } = require('./pjlink');
const { CameraManager } = require('./cameras');
const { Scheduler } = require('./scheduler');
const { PortalSync } = require('./portal-sync');
const { CVManager } = require('./cv');
const network = require('./network');
const commissioning = require('./commissioning');
const tv = require('./tv');
const serverHealth = require('./server-health');

// ─── Load Config ───────────────────────────────────────────
const configArg = process.argv.find(a => a.startsWith('--config='));
const configName = configArg ? configArg.split('=')[1] : 'beleza-astral';
const configPath = path.join(__dirname, '..', 'config', `${configName}.json`);

if (!fs.existsSync(configPath)) {
  console.error(`Config not found: ${configPath}`);
  console.error(`Available configs:`);
  fs.readdirSync(path.join(__dirname, '..', 'config'))
    .filter(f => f.endsWith('.json') && f !== 'template.json')
    .forEach(f => console.error(`  --config=${f.replace('.json', '')}`));
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
console.log(`\n  ◇ AYA EXPO TOOLS`);
console.log(`  ${config.exhibition.name} — ${config.exhibition.venue}`);
console.log(`  ${config.projectors.length} projetores · ${config.cameras.length} câmeras\n`);

// ─── Log (definido cedo — usado por PortalSync e pelas rotas) ──
const LOG_PATH = path.join(__dirname, '..', 'config', 'log.json');

function readLog() {
  if (!fs.existsSync(LOG_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); } catch { return []; }
}

function writeLog(entries) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2));
}

// ─── Session Manager (Ciclo 3 — R4: proteção contra comandos destrutivos remotos) ─
const session = {
  active: false,
  startedAt: null,
  startedBy: null,
};

// ─── Initialize Managers ───────────────────────────────────
const projectors = new ProjectorManager(config);
const cameras = new CameraManager(config);
const scheduler = new Scheduler(projectors, config);
const cvManager = new CVManager(config);
const portalSync = new PortalSync(config, projectors, cameras, scheduler, readLog, session, cvManager, serverHealth);

function isRemoteCommand(req) {
  // Comandos do portal vêm com header X-Remote-Command
  return req.headers['x-remote-command'] === 'true';
}

// Rotas que são bloqueadas quando sessão está ativa e comando é remoto
const DESTRUCTIVE_PATHS = [
  '/api/projectors/all/off',
  '/api/projectors/all/on',
];
// Padrão regex para rotas individuais de projetores
const PROJECTOR_CMD_RE = /^\/api\/projectors\/[^/]+\/(on|off)$/;

// ─── Express App ───────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'ui')));

// Middleware: bloqueia comandos remotos destrutivos durante sessão ativa
app.use((req, res, next) => {
  if (!session.active || !isRemoteCommand(req)) return next();
  if (req.method !== 'POST') return next();

  const isDestructive = DESTRUCTIVE_PATHS.includes(req.path) || PROJECTOR_CMD_RE.test(req.path);
  if (isDestructive) {
    return res.status(423).json({
      error: 'Sessão ativa — comandos remotos bloqueados',
      session: { active: true, startedAt: session.startedAt, startedBy: session.startedBy },
    });
  }
  next();
});

// ─── API: Session (Ciclo 3 — R4) ───────────────────────────
app.get('/api/session', (req, res) => {
  res.json(session);
});

app.post('/api/session/start', (req, res) => {
  if (session.active) {
    return res.json({ ok: true, message: 'Sessão já ativa', session });
  }
  session.active = true;
  session.startedAt = new Date().toISOString();
  session.startedBy = req.body?.by || 'local';
  broadcast('session', session);

  // Log
  const entries = readLog();
  entries.unshift({ message: `🟢 Sessão iniciada por ${session.startedBy}`, type: 'session', timestamp: session.startedAt });
  if (entries.length > 200) entries.splice(200);
  writeLog(entries);

  console.log(`  🟢 Sessão ativa — comandos remotos destrutivos bloqueados`);
  res.json({ ok: true, session });
});

app.post('/api/session/end', (req, res) => {
  if (!session.active) {
    return res.json({ ok: true, message: 'Sessão já inativa', session });
  }
  session.active = false;
  const endedAt = new Date().toISOString();
  broadcast('session', session);

  // Log
  const entries = readLog();
  entries.unshift({ message: `🔴 Sessão encerrada`, type: 'session', timestamp: endedAt });
  if (entries.length > 200) entries.splice(200);
  writeLog(entries);

  session.startedAt = null;
  session.startedBy = null;
  console.log(`  🔴 Sessão encerrada — comandos remotos liberados`);
  res.json({ ok: true, session });
});

// ─── API: Exhibition Info ──────────────────────────────────
app.get('/api/info', (req, res) => {
  res.json({
    exhibition: config.exhibition,
    slug: config.exhibition.slug || null,
    projetoId: config.exhibition.projetoId || null,
    projectorCount: config.projectors.length,
    cameraCount: config.cameras.length,
    uptime: process.uptime(),
  });
});

// ─── API: Projectors ───────────────────────────────────────
app.get('/api/projectors', (req, res) => {
  res.json(projectors.getAllStatus());
});

app.post('/api/projectors/poll', async (req, res) => {
  try {
    const status = await projectors.pollAll();
    broadcast('projectors', status);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projectors/all/on', async (req, res) => {
  try {
    await projectors.powerOnAll();
    setTimeout(() => projectors.pollAll().then(s => broadcast('projectors', s)), 3000);
    res.json({ ok: true, action: 'power-on-all' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projectors/all/off', async (req, res) => {
  try {
    await projectors.powerOffAll();
    setTimeout(() => projectors.pollAll().then(s => broadcast('projectors', s)), 3000);
    res.json({ ok: true, action: 'power-off-all' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projectors/:id/on', async (req, res) => {
  const p = projectors.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Projector not found' });
  try {
    await p.powerOn();
    setTimeout(() => p.poll().then(s => broadcast('projector', s)), 3000);
    res.json({ ok: true, id: p.id, action: 'power-on' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projectors/:id/off', async (req, res) => {
  const p = projectors.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Projector not found' });
  try {
    await p.powerOff();
    setTimeout(() => p.poll().then(s => broadcast('projector', s)), 3000);
    res.json({ ok: true, id: p.id, action: 'power-off' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projectors/:id/input', async (req, res) => {
  const p = projectors.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Projector not found' });
  const { input } = req.body;
  if (!input) return res.status(400).json({ error: 'input required' });
  try {
    await p.setInput(input);
    res.json({ ok: true, id: p.id, input });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── API: Cameras ──────────────────────────────────────────
app.get('/api/cameras', (req, res) => {
  res.json(cameras.getAllStatus());
});

app.post('/api/cameras/check', async (req, res) => {
  const status = await cameras.checkAll();
  broadcast('cameras', status);
  res.json(status);
});

app.get('/api/cameras/:id/snapshot', async (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });
  const hd = req.query.hd === '1';
  try {
    const buffer = await cam.getSnapshot(hd);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.set('X-Resolution', hd ? '1080p' : '480p');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── MJPEG stream proxy ─────────────────────────────────────
app.get('/api/cameras/:id/stream', async (req, res) => {
  const cam = cameras.get(req.params.id);
  if (!cam) return res.status(404).json({ error: 'Camera not found' });

  const boundary = 'AYAframe';
  res.set({
    'Content-Type': `multipart/x-mixed-replace; boundary=${boundary}`,
    'Cache-Control': 'no-store',
    'Connection': 'close',
  });

  let active = true;
  req.on('close', () => { active = false; });

  const sendFrame = async () => {
    if (!active) return;
    try {
      const buffer = await cam.getSnapshot();
      if (!active) return;
      res.write(`--${boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
      res.write(buffer);
      res.write('\r\n');
    } catch (_) { /* câmera inacessível, tenta de novo */ }
    if (active) setTimeout(sendFrame, 200); // ~5 fps
  };

  sendFrame();
});

// ─── API: Network ──────────────────────────────────────────
app.post('/api/network/scan', async (req, res) => {
  const subnet = config.exhibition.network?.subnet?.split('.').slice(0, 3).join('.') || '10.0.1';
  try {
    const devices = await network.fullScan(subnet);
    res.json({ subnet: `${subnet}.0/24`, devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/network/internet', async (req, res) => {
  const result = await network.checkInternet();
  res.json(result);
});

// ─── API: Schedule ─────────────────────────────────────────
app.get('/api/schedule', (req, res) => {
  res.json(scheduler.getStatus());
});

app.post('/api/schedule', (req, res) => {
  scheduler.updateConfig(req.body);
  res.json(scheduler.getStatus());
});

// ─── Static: config files (plants, pixelmaps) ─────────────
app.use('/files', express.static(path.join(__dirname, '..', 'config')));

// ─── Static: media files (videos for TV cast) ─────────────
app.use('/media', express.static(path.join(__dirname, '..', 'media'), {
  maxAge: '1h',  // cache no browser do Cast receiver
  acceptRanges: true,  // necessário para seek em vídeo
}));

// ─── API: Config editor ────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json(config);
});

app.put('/api/config', (req, res) => {
  try {
    const updated = req.body;
    const cfgPath = path.join(__dirname, '..', 'config', `${configName}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(updated, null, 2));
    // Update in-memory config and reload all managers
    Object.assign(config, updated);
    projectors.reload(config);
    cameras.reload(config);
    scheduler.updateConfig(config);
    cvManager.reload(config);
    res.json({ ok: true, config: updated });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/config/test/projector/:i', async (req, res) => {
  const p = config.projectors[parseInt(req.params.i)];
  if (!p) return res.status(404).json({ ok: false });
  const { ProjectorManager } = require('./pjlink');
  try {
    const net = require('./network');
    const pingOk = await new Promise(resolve => {
      const { exec } = require('child_process');
      exec(`ping -n 1 -w 2000 ${p.ip}`, (err, out) => resolve(!err && (out.includes('TTL=') || out.includes('Reply'))));
    });
    if (!pingOk) return res.json({ ok: false, message: `${p.ip} não responde ao ping. Verifique se está ligado e conectado.` });
    const portOk = await new Promise(resolve => {
      const net2 = require('net');
      const s = new net2.Socket();
      s.setTimeout(2000);
      s.connect(4352, p.ip, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.on('timeout', () => resolve(false));
    });
    res.json({ ok: portOk, message: portOk ? `${p.name} respondendo via PJLink` : `${p.ip} responde ao ping mas PJLink (porta 4352) não está acessível` });
  } catch(e) { res.json({ ok: false, message: e.message }); }
});

app.post('/api/config/test/camera/:i', async (req, res) => {
  const c = config.cameras[parseInt(req.params.i)];
  if (!c) return res.status(404).json({ ok: false });
  try {
    const portOk = await new Promise(resolve => {
      const net2 = require('net');
      const s = new net2.Socket();
      s.setTimeout(3000);
      s.connect(554, c.ip, () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.on('timeout', () => resolve(false));
    });
    res.json({ ok: portOk, message: portOk ? `${c.name} acessível` : `${c.ip} não responde. Verifique o IP e a conexão.` });
  } catch(e) { res.json({ ok: false, message: e.message }); }
});

app.post('/api/config/test/plug/:i', async (req, res) => {
  const p = (config.smartplugs || [])[parseInt(req.params.i)];
  if (!p) return res.status(404).json({ ok: false });
  try {
    const pingOk = await new Promise(resolve => {
      const { exec } = require('child_process');
      exec(`ping -n 1 -w 2000 ${p.ip}`, (err, out) => resolve(!err && (out.includes('TTL=') || out.includes('Reply'))));
    });
    res.json({ ok: pingOk, message: pingOk ? `${p.name} respondendo` : `${p.ip} não responde. Verifique o IP e a conexão.` });
  } catch(e) { res.json({ ok: false, message: e.message }); }
});

// ─── API: Log ──────────────────────────────────────────────
app.get('/api/log', (req, res) => {
  res.json(readLog());
});

app.post('/api/log', (req, res) => {
  const { message, type } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  const entries = readLog();
  entries.unshift({ message, type: type || 'manual', timestamp: new Date().toISOString() });
  if (entries.length > 200) entries.splice(200);
  writeLog(entries);
  res.json({ ok: true });
});

// ─── API: Commissioning ────────────────────────────────────
app.get('/api/commissioning/steps', (req, res) => {
  res.json(commissioning.STEPS.map(s => ({ id: s.id, label: s.label })));
});

app.post('/api/commissioning/run', async (req, res) => {
  try {
    const report = await commissioning.runAll(config);
    commissioning.saveReport(report);
    broadcast('commissioning', report);
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/commissioning/step/:id', async (req, res) => {
  try {
    const result = await commissioning.runStep(req.params.id, config);
    broadcast('commissioning-step', result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/commissioning/history', (req, res) => {
  res.json(commissioning.loadHistory());
});

app.patch('/api/commissioning/content', (req, res) => {
  const { status } = req.body;
  if (!['pixelmap', 'content'].includes(status)) {
    return res.status(400).json({ error: 'status must be pixelmap or content' });
  }
  if (!config.resolume) config.resolume = {};
  config.resolume.contentStatus = status;
  const configPath = path.join(__dirname, '..', 'config', `${configName}.json`);
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!saved.resolume) saved.resolume = {};
  saved.resolume.contentStatus = status;
  fs.writeFileSync(configPath, JSON.stringify(saved, null, 2));
  res.json({ ok: true, contentStatus: status });
});

// ─── API: Descoberta de rede ──────────────────────────────

// Lookup de MAC por IP — pinga o dispositivo e lê a tabela ARP
app.get('/api/discover/mac', async (req, res) => {
  const { ip } = req.query;
  if (!ip) return res.status(400).json({ error: 'Parâmetro ip obrigatório' });
  try {
    const result = await network.lookupMac(ip);
    res.json(result);
  } catch (e) {
    res.status(500).json({ found: false, error: e.message });
  }
});

// Varredura completa — descobre todos os dispositivos na subnet com IP + MAC + tipo
// Usa SSE (Server-Sent Events) para enviar progresso em tempo real
app.get('/api/discover/subnet', async (req, res) => {
  const subnet = req.query.subnet || config.exhibition?.network?.subnet || '192.168.0.0/24';
  // Extrai os 3 primeiros octetos: "192.168.0.0/24" → "192.168.0"
  const base = subnet.replace(/\/\d+$/, '').split('.').slice(0, 3).join('.');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    send({ type: 'start', subnet: `${base}.0/24` });
    const devices = await network.discoverSubnet(base, (pct) => {
      send({ type: 'progress', pct });
    });
    send({ type: 'result', devices });
  } catch (e) {
    send({ type: 'error', message: e.message });
  }
  res.end();
});

// ─── API: TVs (Google Cast + WOL) ─────────────────────────
app.get('/api/tv', (req, res) => {
  const tvs = config.tvs || [];
  res.json(tvs.map(t => ({ ...t, password: undefined })));
});

// ── Bulk TV operations (MUST come before :id routes) ──────
app.post('/api/tv/all/on', async (req, res) => {
  const tvs = config.tvs || [];
  const results = await Promise.allSettled(tvs.map(t => tv.powerOn(t).then(() => ({ id: t.id, ok: true }))));
  res.json(results.map((r, i) => r.status === 'fulfilled' ? r.value : { id: tvs[i].id, ok: false, error: r.reason?.message }));
});

app.post('/api/tv/all/off', async (req, res) => {
  const tvs = config.tvs || [];
  const results = await Promise.allSettled(tvs.map(t => tv.powerOff(t).then(() => ({ id: t.id, ok: true }))));
  res.json(results.map((r, i) => r.status === 'fulfilled' ? r.value : { id: tvs[i].id, ok: false, error: r.reason?.message }));
});

app.post('/api/tv/all/cast', async (req, res) => {
  const tvs = config.tvs || [];
  const mediaServer = config.exhibition?.network?.mediaServer || 'localhost';
  const port = config.server?.port || 3000;
  const baseUrl = `http://${mediaServer}:${port}`;

  const results = await Promise.allSettled(tvs.map(async t => {
    const videoUrl = t.videoUrl;
    if (!videoUrl) return { id: t.id, ok: false, error: 'videoUrl não configurada' };
    const fullUrl = videoUrl.startsWith('http') ? videoUrl : `${baseUrl}${videoUrl}`;
    const result = await tv.castVideo(t, fullUrl, { title: t.videoTitle });
    return { id: t.id, ok: true, ...result };
  }));

  res.json(results.map((r, i) => r.status === 'fulfilled' ? r.value : { id: tvs[i].id, ok: false, error: r.reason?.message }));
});

app.post('/api/tv/all/stop', async (req, res) => {
  const tvs = config.tvs || [];
  const results = await Promise.allSettled(tvs.map(t => tv.castStop(t).then(r => ({ id: t.id, ok: true, ...r }))));
  res.json(results.map((r, i) => r.status === 'fulfilled' ? r.value : { id: tvs[i].id, ok: false, error: r.reason?.message }));
});

// ── Individual TV operations ──────────────────────────────
app.get('/api/tv/:id/status', async (req, res) => {
  const tvs = config.tvs || [];
  const t = tvs.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'TV não encontrada' });
  try {
    const status = await tv.getStatus(t);
    res.json({ id: t.id, name: t.name, ...status });
  } catch (e) {
    res.json({ id: t.id, name: t.name, online: false, error: e.message });
  }
});

app.post('/api/tv/:id/on', async (req, res) => {
  const tvs = config.tvs || [];
  const t = tvs.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'TV não encontrada' });
  try {
    await tv.powerOn(t);
    res.json({ ok: true, message: `Wake-on-LAN enviado para ${t.name}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/tv/:id/off', async (req, res) => {
  const tvs = config.tvs || [];
  const t = tvs.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'TV não encontrada' });
  try {
    const result = await tv.powerOff(t);
    res.json({ ok: true, message: result.message });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cast video to a specific TV
app.post('/api/tv/:id/cast', async (req, res) => {
  const tvs = config.tvs || [];
  const t = tvs.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'TV não encontrada' });
  const { url, title, contentType, loop } = req.body;
  const videoUrl = url || t.videoUrl;
  if (!videoUrl) return res.status(400).json({ error: 'url obrigatória (body ou config tv.videoUrl)' });
  try {
    const result = await tv.castVideo(t, videoUrl, { title: title || t.videoTitle, contentType, loop });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stop cast on a specific TV
app.post('/api/tv/:id/stop', async (req, res) => {
  const tvs = config.tvs || [];
  const t = tvs.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'TV não encontrada' });
  try {
    const result = await tv.castStop(t);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Set volume on a specific TV (0-100)
app.post('/api/tv/:id/volume', async (req, res) => {
  const tvs = config.tvs || [];
  const t = tvs.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'TV não encontrada' });
  const { level } = req.body;
  if (level === undefined) return res.status(400).json({ error: 'level obrigatório (0-100)' });
  try {
    const result = await tv.setVolume(t, level);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// (bulk TV routes defined above, before :id routes)

// ─── API: Computer Vision ──────────────────────────────────
app.get('/api/cv/status', (req, res) => {
  res.json(cvManager.getStatus());
});

app.get('/api/cv/count', (req, res) => {
  const detections = cvManager.getDetections();
  if (!detections) return res.json({ count: null, running: cvManager.getStatus().running });
  res.json({
    count: detections.count,
    camera: detections.camera,
    fps: detections.fps,
    timestamp: detections.timestamp,
  });
});

app.get('/api/cv/detections', (req, res) => {
  const detections = cvManager.getDetections();
  if (!detections) return res.status(503).json({ error: 'CV not running or no data yet' });
  res.json(detections);
});

app.get('/api/cv/heatmap', (req, res) => {
  const buffer = cvManager.getHeatmap();
  if (!buffer) return res.status(404).json({ error: 'No heatmap available' });
  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'no-store');
  res.send(buffer);
});

app.get('/api/cv/frame', (req, res) => {
  const buffer = cvManager.getFrame();
  if (!buffer) return res.status(404).json({ error: 'No frame available' });
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'no-store');
  res.send(buffer);
});

app.post('/api/cv/start', (req, res) => {
  if (cvManager.getStatus().running) return res.json({ ok: true, message: 'Already running' });
  cvManager.enabled = true;
  cvManager.start();
  res.json({ ok: true, message: 'CV starting' });
});

app.post('/api/cv/stop', (req, res) => {
  cvManager.stop();
  res.json({ ok: true, message: 'CV stopping' });
});

app.post('/api/cv/heatmap/reset', (req, res) => {
  const ok = cvManager.resetHeatmap();
  res.json({ ok, message: ok ? 'Heatmap reset' : 'Failed to reset' });
});

// ─── API: Server Health (GPU, CPU, RAM, disco) ────────────
app.get('/api/server/health', (req, res) => {
  const current = serverHealth.getCurrent();
  if (!current) {
    return res.json({ status: 'initializing', message: 'First poll not yet complete' });
  }
  res.json(current);
});

app.get('/api/server/history', (req, res) => {
  res.json(serverHealth.getHistory());
});

app.get('/api/server/alerts', (req, res) => {
  res.json(serverHealth.getAlerts());
});

// ─── API: Health ───────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const inet = await network.checkInternet();
  const cvStatus = cvManager.getStatus();
  const sh = serverHealth.getCurrent();
  res.json({
    status: 'ok',
    exhibition: config.exhibition.name,
    uptime: Math.floor(process.uptime()),
    projectors: projectors.getAllStatus().length,
    cameras: cameras.getAllStatus().length,
    tvs: (config.tvs || []).length,
    internet: inet.online,
    schedule: scheduler.enabled,
    cv: { enabled: cvStatus.enabled, running: cvStatus.running, count: cvStatus.detections?.count ?? null },
    server: sh ? {
      gpus: sh.gpus,
      cpu: sh.cpu,
      ram: sh.ram,
      disk: sh.disk,
      resolume: sh.resolume,
      osUptime: sh.osUptime,
      alerts: sh.alerts || [],
    } : null,
    timestamp: new Date().toISOString(),
  });
});

// ─── WebSocket for real-time updates ───────────────────────
const wss = new WebSocket.Server({ server });
const clients = new Set();

wss.on('connection', (ws) => {
  clients.add(ws);
  // Send initial state
  ws.send(JSON.stringify({
    type: 'init',
    data: {
      exhibition: config.exhibition,
      projectors: projectors.getAllStatus(),
      cameras: cameras.getAllStatus(),
      schedule: scheduler.getStatus(),
    }
  }));

  ws.on('close', () => clients.delete(ws));
});

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, time: Date.now() });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

// ─── Start ─────────────────────────────────────────────────
const PORT = config.server?.port || 3000;
const HOST = config.server?.host || '0.0.0.0';

server.listen(PORT, HOST, () => {
  console.log(`  🌐 http://localhost:${PORT}`);
  console.log(`  🌐 http://${config.exhibition.network?.mediaServer || 'localhost'}:${PORT}\n`);

  // Start polling
  projectors.startPolling(config.pjlink?.pollInterval || 30000);
  cameras.startPolling(30000);
  scheduler.start();
  portalSync.start();
  cvManager.start();
  serverHealth.start();
});

// ─── Uncaught errors — log but don't crash ─────────────────
process.on('uncaughtException', (err) => {
  console.error(`  ❌ Uncaught exception: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error(`  ❌ Unhandled rejection: ${reason}`);
});

// ─── Graceful shutdown ─────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  projectors.stopPolling();
  cameras.stopPolling();
  scheduler.stop();
  portalSync.stop();
  cvManager.stop();
  serverHealth.stop();
  server.close();
  process.exit(0);
});
