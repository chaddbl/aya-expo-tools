/**
 * AYA Expo Tools — Network Scanner
 * Ping sweep + port check for device discovery
 */

const { exec } = require('child_process');
const net = require('net');

/**
 * Ping a single host
 */
function ping(ip, timeout = 2000) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? `ping -n 1 -w ${timeout} ${ip}`
      : `ping -c 1 -W ${Math.ceil(timeout / 1000)} ${ip}`;

    exec(cmd, { timeout: timeout + 1000 }, (err, stdout) => {
      if (err) return resolve({ ip, online: false });
      const online = isWin
        ? !stdout.includes('Esgotado') && !stdout.includes('unreachable') && stdout.includes('bytes=')
        : stdout.includes('1 received') || stdout.includes('bytes from');
      resolve({ ip, online });
    });
  });
}

/**
 * Check if a TCP port is open
 */
function checkPort(ip, port, timeout = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);

    socket.connect(port, ip, () => {
      socket.destroy();
      resolve({ ip, port, open: true });
    });

    socket.on('error', () => {
      socket.destroy();
      resolve({ ip, port, open: false });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ip, port, open: false });
    });
  });
}

/**
 * Scan a subnet for responsive hosts
 * @param {string} subnet - e.g. "10.0.1" (first 3 octets)
 * @param {number} start - start host (default 1)
 * @param {number} end - end host (default 254)
 */
async function scanSubnet(subnet, start = 1, end = 254, concurrency = 20) {
  const results = [];
  const ips = [];

  for (let i = start; i <= end; i++) {
    ips.push(`${subnet}.${i}`);
  }

  // Batch ping with concurrency
  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = ips.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map(ip => ping(ip, 1500)));
    results.push(...batchResults.filter(r => r.online));
  }

  return results;
}

/**
 * Check known services on a host
 */
async function identifyHost(ip) {
  const ports = [
    { port: 80,   name: 'HTTP' },
    { port: 443,  name: 'HTTPS' },
    { port: 554,  name: 'RTSP' },
    { port: 4352, name: 'PJLink' },
    { port: 8080, name: 'HTTP-Alt' },
    { port: 3389, name: 'RDP' },
    { port: 22,   name: 'SSH' },
  ];

  const results = await Promise.all(
    ports.map(p => checkPort(ip, p.port, 1500))
  );

  const services = [];
  results.forEach((r, i) => {
    if (r.open) services.push(ports[i].name);
  });

  let type = 'unknown';
  if (services.includes('PJLink')) type = 'projector';
  else if (services.includes('RTSP')) type = 'camera';
  else if (services.includes('RDP')) type = 'computer';
  else if (services.includes('HTTP')) type = 'device';

  return { ip, services, type };
}

/**
 * Full network scan — discover and identify devices
 */
async function fullScan(subnet) {
  console.log(`[Network] Scanning ${subnet}.0/24...`);
  const alive = await scanSubnet(subnet);
  console.log(`[Network] Found ${alive.length} hosts, identifying...`);

  const identified = await Promise.all(
    alive.map(h => identifyHost(h.ip))
  );

  return identified;
}

/**
 * Lê a tabela ARP do sistema e devolve mapa IP → MAC
 * Funciona no Windows (arp -a) e Linux/Mac
 */
function readArpTable() {
  return new Promise((resolve) => {
    exec('arp -a', { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve({});
      const table = {};
      const lines = stdout.split('\n');
      for (const line of lines) {
        // Windows:  192.168.0.50    aa-bb-cc-dd-ee-ff    dynamic
        // Linux:    ? (192.168.0.50) at aa:bb:cc:dd:ee:ff
        const winMatch = line.match(/\s*([\d.]+)\s+([0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2})\s+(\w+)/i);
        if (winMatch) {
          const ip  = winMatch[1];
          const mac = winMatch[2].replace(/-/g, ':').toUpperCase();
          const type = winMatch[3]; // dynamic / static
          if (type !== 'static' || mac !== 'FF:FF:FF:FF:FF:FF') {
            table[ip] = mac;
          }
        }
      }
      resolve(table);
    });
  });
}

/**
 * Descobre o MAC de um IP específico:
 * 1. Pinga o IP para popular a tabela ARP
 * 2. Lê a tabela ARP e devolve o MAC
 */
async function lookupMac(ip) {
  // Pinga 3x com curto intervalo para garantir que entra na tabela ARP
  await Promise.all([
    ping(ip, 1000),
    new Promise(r => setTimeout(r, 300)).then(() => ping(ip, 1000)),
    new Promise(r => setTimeout(r, 600)).then(() => ping(ip, 1000)),
  ]);

  // Aguarda a tabela ARP ser populada
  await new Promise(r => setTimeout(r, 400));

  const table = await readArpTable();
  const mac = table[ip];

  if (!mac) return { ip, mac: null, found: false, hint: 'Dispositivo não respondeu — verifique se está ligado e conectado na rede' };
  return { ip, mac, found: true };
}

/**
 * Varredura completa da subnet com MACs
 * Pinga todos os IPs, lê a tabela ARP uma única vez no final
 * Retorna todos os dispositivos online com IP + MAC + tipo identificado
 */
async function discoverSubnet(subnet, onProgress) {
  const ips = [];
  for (let i = 1; i <= 254; i++) ips.push(`${subnet}.${i}`);

  // Ping sweep em paralelo (lotes de 30)
  let done = 0;
  const alive = [];
  for (let i = 0; i < ips.length; i += 30) {
    const batch = ips.slice(i, i + 30);
    const results = await Promise.all(batch.map(ip => ping(ip, 600)));
    results.forEach(r => { if (r.online) alive.push(r.ip); });
    done += batch.length;
    if (onProgress) onProgress(Math.round(done / ips.length * 60)); // 0–60%
  }

  // Aguarda ARP propagar
  await new Promise(r => setTimeout(r, 600));
  const arpTable = await readArpTable();
  if (onProgress) onProgress(75);

  // Identificar serviços (portas)
  const SERVICE_PORTS = [
    { port: 4352, type: 'projector',  label: 'PJLink' },
    { port: 554,  type: 'camera',     label: 'RTSP' },
    { port: 36669, type: 'tv',        label: 'VIDAA/MQTT' },
    { port: 80,   type: 'device',     label: 'HTTP' },
    { port: 8080, type: 'device',     label: 'HTTP-Alt' },
  ];

  const devices = await Promise.all(alive.map(async ip => {
    const portChecks = await Promise.all(
      SERVICE_PORTS.map(p => checkPort(ip, p.port, 800))
    );
    const openPorts = SERVICE_PORTS.filter((p, i) => portChecks[i].open);
    const mac = arpTable[ip] || null;

    // Tipo inferido pelo primeiro serviço encontrado
    let type = 'unknown';
    if (openPorts.length > 0) type = openPorts[0].type;

    return {
      ip,
      mac,
      type,
      services: openPorts.map(p => p.label),
    };
  }));

  if (onProgress) onProgress(100);
  return devices;
}

/**
 * Check internet connectivity
 */
function checkInternet() {
  return new Promise((resolve) => {
    const req = require('http').get('http://connectivitycheck.gstatic.com/generate_204', {
      timeout: 5000
    }, (res) => {
      resolve({ online: res.statusCode === 204, code: res.statusCode });
      res.resume();
    });
    req.on('error', () => resolve({ online: false }));
    req.on('timeout', () => { req.destroy(); resolve({ online: false }); });
  });
}

module.exports = { ping, checkPort, scanSubnet, identifyHost, fullScan, checkInternet, lookupMac, discoverSubnet, readArpTable };
