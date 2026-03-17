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

module.exports = { ping, checkPort, scanSubnet, identifyHost, fullScan, checkInternet };
