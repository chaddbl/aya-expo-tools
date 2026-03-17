/**
 * AYA Expo Tools — Commissioning
 * Testa cada etapa na sequência real de configuração de uma expo.
 * Segue a ordem: Rede → Resolume → Som → Projetores → Automação → Boot → Câmeras → Acesso
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const net = require('net');
const path = require('path');
const fs = require('fs');

const execAsync = promisify(exec);

// ─── Ping helper ───────────────────────────────────────────
async function ping(ip, timeout = 2000) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32'
      ? `ping -n 1 -w ${timeout} ${ip}`
      : `ping -c 1 -W ${Math.ceil(timeout/1000)} ${ip}`;
    exec(cmd, (err, stdout) => {
      if (err) return resolve({ ok: false, ip });
      const ok = stdout.includes('TTL=') || stdout.includes('ttl=') ||
                 stdout.includes('bytes from') || stdout.toLowerCase().includes('reply from');
      resolve({ ok, ip });
    });
  });
}

// ─── TCP port check ────────────────────────────────────────
async function checkPort(ip, port, timeout = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let resolved = false;
    const done = (ok) => {
      if (!resolved) { resolved = true; sock.destroy(); resolve(ok); }
    };
    sock.setTimeout(timeout);
    sock.connect(port, ip, () => done(true));
    sock.on('error', () => done(false));
    sock.on('timeout', () => done(false));
  });
}

// ─── Windows process check ────────────────────────────────
async function isProcessRunning(processName) {
  if (process.platform !== 'win32') return { ok: false, note: 'Windows only' };
  try {
    const { stdout } = await execAsync(`tasklist /FI "IMAGENAME eq ${processName}" /NH`);
    const running = stdout.toLowerCase().includes(processName.toLowerCase());
    return { ok: running, process: processName };
  } catch {
    return { ok: false, process: processName };
  }
}

// ─── Check Windows startup entries ────────────────────────
async function checkStartupEntries(processName) {
  if (process.platform !== 'win32') return { ok: false, note: 'Windows only' };
  try {
    // Check Task Scheduler
    const { stdout: tasks } = await execAsync(
      `schtasks /query /fo LIST 2>nul | findstr /i "${processName.replace('.exe','')}"`,
      { timeout: 5000 }
    ).catch(() => ({ stdout: '' }));

    // Check startup folder
    const startupPath = path.join(
      process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'
    );
    let startupFiles = [];
    if (fs.existsSync(startupPath)) {
      startupFiles = fs.readdirSync(startupPath);
    }

    // Check registry run key via reg query
    const { stdout: regOut } = await execAsync(
      `reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" 2>nul`,
      { timeout: 5000 }
    ).catch(() => ({ stdout: '' }));

    const inScheduler = tasks.length > 0;
    const inStartup = startupFiles.some(f => f.toLowerCase().includes(processName.toLowerCase().replace('.exe','')));
    const inRegistry = regOut.toLowerCase().includes(processName.toLowerCase().replace('.exe',''));

    return {
      ok: inScheduler || inStartup || inRegistry,
      scheduler: inScheduler,
      startup: inStartup,
      registry: inRegistry,
      startupFiles: startupFiles.slice(0, 10)
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── STEP 1: Rede ─────────────────────────────────────────
async function checkNetwork(config) {
  const gateway = config.exhibition.network?.gateway || '192.168.0.1';
  const mediaServer = config.exhibition.network?.mediaServer || '192.168.0.13';
  const subnet = config.exhibition.network?.subnet || '192.168.0.0/24';

  const gwPing = await ping(gateway);

  // Internet check via DNS
  let internet = { ok: false };
  try {
    const { stdout } = await execAsync('ping -n 1 -w 3000 8.8.8.8', { timeout: 5000 });
    internet = { ok: stdout.includes('TTL=') || stdout.includes('Reply from') };
  } catch { internet = { ok: false }; }

  // Extract current IP of this machine
  let thisIp = 'desconhecido';
  try {
    const { stdout } = await execAsync('ipconfig', { timeout: 3000 });
    const match = subnet.split('.').slice(0,3).join('.');
    const lines = stdout.split('\n');
    for (const line of lines) {
      if (line.includes('IPv4') && line.includes(match)) {
        thisIp = line.split(':').pop().trim();
        break;
      }
    }
  } catch {}

  return {
    ok: gwPing.ok,
    gateway: { ip: gateway, online: gwPing.ok },
    internet: internet,
    thisIp,
    subnet,
    notes: gwPing.ok
      ? `Gateway ${gateway} respondendo. ${internet.ok ? 'Internet ok.' : 'Sem internet (normal em 4G).'}`
      : `Gateway ${gateway} não responde — verificar switch/roteador.`
  };
}

// ─── STEP 2: Resolume ─────────────────────────────────────
async function checkResolume(config) {
  const process = config.resolume?.process || 'Avenue.exe';
  const result = await isProcessRunning(process);
  const contentStatus = config.resolume?.contentStatus || 'pixelmap';
  return {
    ok: result.ok,
    process,
    running: result.ok,
    contentStatus,
    notes: result.ok
      ? `${process} em execução. Status do conteúdo: ${contentStatus}.`
      : `${process} não está rodando. Abrir o Resolume e carregar o pixelmap.`
  };
}

// ─── STEP 3: Som ──────────────────────────────────────────
async function checkAudio(config) {
  // Audio is hard to verify programmatically — we check if the audio interface is listed
  let audioDevices = [];
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync(
        'powershell -Command "Get-WmiObject Win32_SoundDevice | Select-Object Name,Status | ConvertTo-Json"',
        { timeout: 5000 }
      );
      const parsed = JSON.parse(stdout.trim());
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      audioDevices = arr.map(d => ({ name: d.Name, status: d.Status }));
    } catch {}
  }

  const hasAudio = audioDevices.length > 0;
  const interfaceConfig = config.audio?.interface || '';

  return {
    ok: hasAudio,
    devices: audioDevices,
    configuredInterface: interfaceConfig,
    zones: config.audio?.zones || [],
    notes: hasAudio
      ? `${audioDevices.length} dispositivo(s) de áudio detectado(s). Verificar volume e saída correta no Resolume.`
      : 'Nenhum dispositivo de áudio detectado. Verificar interface/placa de som.'
  };
}

// ─── STEP 4: Projetores ───────────────────────────────────
async function checkProjectors(config) {
  const port = config.pjlink?.port || 4352;
  const results = await Promise.all(
    config.projectors.map(async (p) => {
      const hasIp = p.ip && !p.ip.startsWith('0.');
      if (!hasIp) return { id: p.id, name: p.name, ip: p.ip, ok: false, note: 'IP não configurado' };
      const pingOk = await ping(p.ip);
      const portOk = pingOk.ok ? await checkPort(p.ip, port) : false;
      return {
        id: p.id,
        name: p.name,
        ip: p.ip,
        model: p.model,
        ping: pingOk.ok,
        pjlink: portOk,
        ok: pingOk.ok && portOk
      };
    })
  );

  const ok = results.every(r => r.ok);
  const okCount = results.filter(r => r.ok).length;
  return {
    ok,
    projectors: results,
    notes: `${okCount}/${results.length} projetores respondendo via PJLink.`
  };
}

// ─── STEP 5: Automação (Scheduler + Smart Plugs) ─────────
async function checkAutomation(config) {
  const schedule = config.schedule || {};
  const plugs = config.smartplugs || [];

  const scheduleOk = schedule.enabled && schedule.powerOn && schedule.powerOff;

  // Ping smart plugs
  const plugResults = await Promise.all(
    plugs.map(async (p) => {
      if (!p.ip) return { id: p.id, name: p.name, ok: false, note: 'IP não configurado' };
      const pingOk = await ping(p.ip);
      // NovaDigital typically exposes HTTP on port 80
      const httpOk = pingOk.ok ? await checkPort(p.ip, 80, 2000) : false;
      return { id: p.id, name: p.name, ip: p.ip, ping: pingOk.ok, http: httpOk, ok: pingOk.ok };
    })
  );

  const plugsOk = plugResults.every(r => r.ok);
  const ok = scheduleOk && (plugs.length === 0 || plugsOk);

  return {
    ok,
    schedule: {
      enabled: schedule.enabled,
      powerOn: schedule.powerOn,
      powerOff: schedule.powerOff,
      timezone: schedule.timezone,
      ok: scheduleOk
    },
    smartplugs: plugResults,
    notes: [
      scheduleOk
        ? `Scheduler ativo: liga ${schedule.powerOn} / desliga ${schedule.powerOff}`
        : 'Scheduler não configurado — definir horários de liga/desliga.',
      plugs.length > 0
        ? `${plugResults.filter(r=>r.ok).length}/${plugResults.length} smart plugs respondendo.`
        : 'Nenhum smart plug configurado.'
    ].join(' ')
  };
}

// ─── STEP 6: Boot automático ──────────────────────────────
async function checkBootRecovery(config) {
  const resolumeProcess = config.resolume?.process || 'Avenue.exe';
  const serverProcess = 'node.exe';

  const resolumeStartup = await checkStartupEntries(resolumeProcess);
  const serverStartup = await checkStartupEntries(serverProcess);

  // Check if auto-login is configured (needed for unattended boot)
  let autoLogin = { ok: false };
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync(
        `reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v AutoAdminLogon 2>nul`,
        { timeout: 3000 }
      );
      autoLogin = { ok: stdout.includes('0x1') || stdout.includes('1') };
    } catch { autoLogin = { ok: false }; }
  }

  const ok = resolumeStartup.ok;

  return {
    ok,
    resolume: { startup: resolumeStartup.ok, details: resolumeStartup },
    server: { startup: serverStartup.ok, details: serverStartup },
    autoLogin,
    notes: ok
      ? `Resolume configurado para iniciar automaticamente. ${autoLogin.ok ? 'Auto-login ativo.' : 'Verificar auto-login do Windows.'}`
      : 'Resolume NÃO inicializa automaticamente — configurar no Task Scheduler ou pasta Startup.'
  };
}

// ─── STEP 7: Câmeras ──────────────────────────────────────
async function checkCameras(config) {
  const results = await Promise.all(
    config.cameras.map(async (c) => {
      if (!c.ip) return { id: c.id, name: c.name, ok: false, note: 'IP não configurado' };
      const pingOk = await ping(c.ip);
      const rtspOk = pingOk.ok ? await checkPort(c.ip, 554, 3000) : false;
      return {
        id: c.id,
        name: c.name,
        ip: c.ip,
        model: c.model,
        ping: pingOk.ok,
        rtsp: rtspOk,
        ok: pingOk.ok && rtspOk
      };
    })
  );

  const ok = results.every(r => r.ok);
  const okCount = results.filter(r => r.ok).length;
  return {
    ok,
    cameras: results,
    notes: `${okCount}/${results.length} câmeras respondendo na porta RTSP 554.`
  };
}

// ─── STEP 8: Acesso remoto ────────────────────────────────
async function checkRemoteAccess(config) {
  const anydesk = config.remoteAccess?.anydesk || {};
  const tailscale = config.remoteAccess?.tailscale || {};

  const anydeskResult = anydesk.enabled
    ? await isProcessRunning('AnyDesk.exe')
    : { ok: false, note: 'desabilitado' };

  const tailscaleResult = tailscale.enabled
    ? await isProcessRunning('tailscaled.exe')
    : { ok: false, note: 'desabilitado' };

  const ok = (anydesk.enabled && anydeskResult.ok) || (tailscale.enabled && tailscaleResult.ok);

  return {
    ok,
    anydesk: {
      enabled: !!anydesk.enabled,
      running: anydeskResult.ok,
      id: anydesk.id || 'não configurado'
    },
    tailscale: {
      enabled: !!tailscale.enabled,
      running: tailscaleResult.ok,
      ip: tailscale.ip || 'não configurado'
    },
    notes: ok
      ? `Acesso remoto ativo. ${anydesk.enabled && anydeskResult.ok ? `AnyDesk: ${anydesk.id || 'verificar ID'}` : ''}`
      : 'Nenhum acesso remoto ativo — abrir AnyDesk e compartilhar ID com Felipe.'
  };
}

// ─── STEP 9: Conteúdo ─────────────────────────────────────
async function checkContent(config) {
  const status = config.resolume?.contentStatus || 'pixelmap';
  const isReady = status === 'content';
  return {
    ok: isReady,
    contentStatus: status,
    notes: isReady
      ? 'Conteúdo final carregado e em loop.'
      : `Status atual: ${status}. Conteúdo final ainda não foi carregado — normal nesta etapa.`
  };
}

// ─── Run all steps ────────────────────────────────────────
const STEPS = [
  { id: 'network',     label: 'Rede',           fn: checkNetwork },
  { id: 'resolume',    label: 'Resolume',        fn: checkResolume },
  { id: 'audio',       label: 'Som',             fn: checkAudio },
  { id: 'projectors',  label: 'Projetores',      fn: checkProjectors },
  { id: 'automation',  label: 'Automação',       fn: checkAutomation },
  { id: 'boot',        label: 'Boot automático', fn: checkBootRecovery },
  { id: 'cameras',     label: 'Câmeras',         fn: checkCameras },
  { id: 'remote',      label: 'Acesso remoto',   fn: checkRemoteAccess },
  { id: 'content',     label: 'Conteúdo',        fn: checkContent },
];

async function runStep(stepId, config) {
  const step = STEPS.find(s => s.id === stepId);
  if (!step) throw new Error(`Step desconhecido: ${stepId}`);
  const start = Date.now();
  try {
    const result = await step.fn(config);
    return { id: step.id, label: step.label, ...result, duration: Date.now() - start };
  } catch (e) {
    return { id: step.id, label: step.label, ok: false, error: e.message, duration: Date.now() - start };
  }
}

async function runAll(config) {
  const results = {};
  for (const step of STEPS) {
    results[step.id] = await runStep(step.id, config);
  }
  const allOk = Object.values(results).every(r => r.ok);
  const issues = Object.values(results).filter(r => !r.ok).map(r => r.label);
  return {
    ok: allOk,
    exhibition: config.exhibition.name,
    timestamp: new Date().toISOString(),
    steps: results,
    summary: allOk
      ? `Expo comissionada. Todos os sistemas ok.`
      : `${issues.length} ${issues.length === 1 ? 'problema' : 'problemas'}: ${issues.join(', ')}.`
  };
}

// ─── Save/load report ─────────────────────────────────────
function getReportPath() {
  return path.join(__dirname, '..', 'config', 'commissioning-history.json');
}

function saveReport(report) {
  const p = getReportPath();
  let history = [];
  if (fs.existsSync(p)) {
    try { history = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  }
  history.unshift(report); // newest first
  if (history.length > 20) history = history.slice(0, 20); // keep last 20
  fs.writeFileSync(p, JSON.stringify(history, null, 2));
  return report;
}

function loadHistory() {
  const p = getReportPath();
  if (!fs.existsSync(p)) return [];
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

module.exports = { STEPS, runStep, runAll, saveReport, loadHistory };
