const http = require('http');
const crypto = require('crypto');

function buildDigest(method, path, user, pass, realm, nonce, qop, opaque) {
  const nc = '00000001', cnonce = 'aya00001';
  const ha1 = crypto.createHash('md5').update(`${user}:${realm}:${pass}`).digest('hex');
  const ha2 = crypto.createHash('md5').update(`${method}:${path}`).digest('hex');
  const resp = qop
    ? crypto.createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest('hex')
    : crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex');
  let auth = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${path}", response="${resp}"`;
  if (qop) auth += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (opaque) auth += `, opaque="${opaque}"`;
  return auth;
}

async function tryPass(user, pass, realm, nonce, qop, opaque) {
  return new Promise((resolve) => {
    const path = '/cgi-bin/snapshot.cgi?channel=1';
    const auth = buildDigest('GET', path, user, pass, realm, nonce, qop, opaque);
    const req = http.request({
      hostname: '192.168.0.181', port: 80, path, method: 'GET', timeout: 4000,
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

async function getChallenge() {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '192.168.0.181', port: 80,
      path: '/cgi-bin/snapshot.cgi?channel=1', method: 'GET', timeout: 4000,
    }, (res) => {
      const hdr = res.headers['www-authenticate'] || '';
      res.resume();
      const f = {};
      const re = /(\w+)="([^"]*)"/g; let m;
      while ((m = re.exec(hdr)) !== null) f[m[1]] = m[2];
      resolve(f);
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const c = await getChallenge();
  console.log('Challenge:', JSON.stringify(c));

  const passwords = ['', 'admin', '123456', '888888', '666666', 'Admin123', 'admin123', '12345', 'intelbras', 'Intelbras'];

  for (const pass of passwords) {
    const r = await tryPass('admin', pass, c.realm, c.nonce, c.qop, c.opaque);
    console.log(`admin:${pass || '(blank)'} → ${r.status} ${r.size > 100 ? '✅ JPEG!' : ''}`);
    if (r.status === 200 && r.size > 100) break;
  }
})();
