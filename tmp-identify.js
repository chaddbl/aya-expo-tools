const { execSync } = require('child_process');
const http = require('http');

const targets = ['192.168.0.86', '192.168.0.182'];

// Ping para popular ARP cache, depois pegar MAC
function getMac(ip) {
  try {
    execSync(`ping -n 1 -w 500 ${ip}`, { stdio: 'ignore' });
    const arp = execSync(`arp -a ${ip}`, { encoding: 'utf8' });
    const match = arp.match(/([0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2})/i);
    return match ? match[1].replace(/-/g, ':').toUpperCase() : null;
  } catch { return null; }
}

// Lookup OUI via macvendors API (HTTP, sem HTTPS)
function lookupOui(mac) {
  return new Promise((resolve) => {
    if (!mac) return resolve('(MAC não encontrado)');
    const oui = mac.replace(/:/g, '').slice(0, 6);
    // Tabela local dos OUIs mais comuns de smartphones
    const known = {
      'FCAD8A': 'Apple (iPhone/iPad)', 'F0D1A9': 'Apple', 'A4C138': 'Apple',
      'BC9FEF': 'Apple', '3C2EFF': 'Apple', 'DC2B2A': 'Apple',
      '744D28': 'Samsung', 'F4F5DB': 'Samsung', '8038BC': 'Samsung',
      'C0EEFB': 'Samsung', '000D3A': 'Samsung',
      '58CB52': 'Xiaomi', 'F48B32': 'Xiaomi', '9C2A83': 'Xiaomi',
      'A086C6': 'Google (Pixel)', '3C5AB4': 'Google',
      '48025E': 'Motorola', '00179A': 'Motorola',
      'E4956E': 'LG', '9841BB': 'Huawei', '306C90': 'Huawei',
      'B4F61C': 'OnePlus', '8C8590': 'OnePlus',
    };
    const vendor = known[oui] || '(fabricante desconhecido)';
    resolve(vendor);
  });
}

// Tentar portas comuns para identificar o dispositivo
function probePorts(ip) {
  const ports = [80, 443, 8080, 8443, 5353, 22, 62078]; // 62078 = lockdownd iOS
  const results = [];
  const checks = ports.map(port => new Promise((resolve) => {
    const net = require('net');
    const s = new net.Socket();
    s.setTimeout(500);
    s.connect(port, ip, () => { s.destroy(); results.push(port); resolve(); });
    s.on('error', () => resolve());
    s.on('timeout', () => { s.destroy(); resolve(); });
  }));
  return Promise.all(checks).then(() => results);
}

(async () => {
  for (const ip of targets) {
    console.log(`\n--- ${ip} ---`);
    const mac = getMac(ip);
    console.log(`MAC: ${mac || '(não encontrado)'}`);
    if (mac) {
      const vendor = await lookupOui(mac);
      console.log(`Fabricante: ${vendor}`);
    }
    const ports = await probePorts(ip);
    console.log(`Portas abertas: ${ports.length ? ports.join(', ') : 'nenhuma detectada'}`);
    if (ports.includes(62078)) console.log('→ PROVÁVEL iPhone (lockdownd na 62078)');
    if (ports.length === 0 && !mac) console.log('→ dispositivo offline ou bloqueando tudo');
  }
})();
