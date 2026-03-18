const http = require('http');

const cameras = ['192.168.0.101', '192.168.0.108', '192.168.0.181'];
const paths = ['/', '/web/', '/index.asp', '/login.asp', '/doc/page/login.asp', '/cgi-bin/snapshot.cgi?channel=1'];

function get(ip, path) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: ip, port: 80, path, method: 'GET', timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, size: Buffer.concat(chunks).length, auth: res.headers['www-authenticate'] || '' }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0 }); });
    req.end();
  });
}

(async () => {
  for (const ip of cameras) {
    console.log(`\n=== ${ip} ===`);
    for (const path of paths) {
      const r = await get(ip, path);
      if (r.status > 0) {
        console.log(`  ${path} → ${r.status} (${r.size}b) ${r.auth ? '['+r.auth.split(' ')[0]+']' : ''}`);
      }
    }
  }
})();
