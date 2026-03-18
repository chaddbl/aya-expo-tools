const http = require('http');

// Teste 1: sem auth — ver o que a câmera pede
const req = http.request({
  hostname: '192.168.0.181', port: 80,
  path: '/cgi-bin/snapshot.cgi?channel=1',
  method: 'GET', timeout: 5000,
}, (res) => {
  console.log('Status:', res.statusCode);
  console.log('WWW-Authenticate:', res.headers['www-authenticate'] || '(none)');
  res.resume();

  if (res.statusCode === 401) {
    const wwwAuth = res.headers['www-authenticate'] || '';
    const isBasic = wwwAuth.toLowerCase().startsWith('basic');
    const isDigest = wwwAuth.toLowerCase().startsWith('digest');
    console.log('Auth type:', isDigest ? 'DIGEST' : isBasic ? 'BASIC' : 'UNKNOWN');

    // Teste 2: Basic auth direto
    const basicAuth = 'Basic ' + Buffer.from('admin:admin').toString('base64');
    const req2 = http.request({
      hostname: '192.168.0.181', port: 80,
      path: '/cgi-bin/snapshot.cgi?channel=1',
      method: 'GET', timeout: 5000,
      headers: { Authorization: basicAuth },
    }, (res2) => {
      console.log('Basic auth status:', res2.statusCode);
      const chunks = [];
      res2.on('data', c => chunks.push(c));
      res2.on('end', () => {
        const buf = Buffer.concat(chunks);
        console.log('Response size:', buf.length, 'bytes');
        console.log('Is JPEG:', buf[0] === 0xFF && buf[1] === 0xD8 ? 'YES' : 'NO');
      });
    });
    req2.on('error', e => console.log('Basic req error:', e.message));
    req2.end();
  } else {
    console.log('No auth needed (status', res.statusCode, ')');
  }
});
req.on('error', e => console.log('Error:', e.message));
req.on('timeout', () => { req.destroy(); console.log('Timeout'); });
req.end();
