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
const network = require('./network');
const commissioning = require('./commissioning');
const tv = require('./tv');

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

// ─── Initialize Managers ───────────────────────────────────
const projectors = new ProjectorManager(config);
const cameras = new CameraManager(config);
const scheduler = new Scheduler(projectors, config);

// ─── Express App ───────────────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'ui')));

// ─── API: Exhibition Info ──────────────────────────────────
app.get('/api/info', (req, res) => {
  res.json({
    exhibition: config.exhibition,
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
  try {
    const buffer = await cam.getSnapshot();
    res.set('Content-Type', 'image/jpeg');
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// ─── API: Config editor ────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json(config);
});

app.put('/api/config', (req, res) => {
  try {
    const updated = req.body;
    const cfgPath = path.join(__dirname, '..', 'config', `${configName}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(updated, null, 2));
    // Update in-memory config (safe fields only)
    Object.assign(config, updated);
    scheduler.updateConfig(config);
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
const LOG_PATH = path.join(__dirname, '..', 'config', 'log.json');

function readLog() {
  if (!fs.existsSync(LOG_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); } catch { return []; }
}

function writeLog(entries) {
  fs.writeFileSync(LOG_PATH, JSON.stringify(entries, null, 2));
}

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

// ─── API: TVs ─────────────────────────────────────────────
app.get('/api/tv', (req, res) => {
  const tvs = config.tvs || [];
  res.json(tvs.map(t => ({ ...t, password: undefined })));
});

app.get('/api/tv/:id/status', async (req, res) => {
  const tvs = config.tvs || [];
  const t = tvs.find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'TV não encontrada' });
  try {
    const online = await tv.isOnline(t);
    res.json({ id: t.id, name: t.name, online });
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
    await tv.powerOff(t);
    res.json({ ok: true, message: `${t.name} desligada via MQTT` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

// ─── API: Health ───────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const inet = await network.checkInternet();
  res.json({
    status: 'ok',
    exhibition: config.exhibition.name,
    uptime: Math.floor(process.uptime()),
    projectors: projectors.getAllStatus().length,
    cameras: cameras.getAllStatus().length,
    tvs: (config.tvs || []).length,
    internet: inet.online,
    schedule: scheduler.enabled,
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
});

// ─── Graceful shutdown ─────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n  Shutting down...');
  projectors.stopPolling();
  cameras.stopPolling();
  scheduler.stop();
  server.close();
  process.exit(0);
});
