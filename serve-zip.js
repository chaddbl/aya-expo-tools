// Temporary HTTP server to serve the zip for the media server
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Create tar-like archive using a simple approach: serve individual files
const BASE = __dirname;
const PORT = 9999;

// Collect all files
function getFiles(dir, base = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.name === 'node_modules' || e.name === '.git') continue;
    if (e.isDirectory()) {
      files.push(...getFiles(path.join(dir, e.name), rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}

const server = http.createServer((req, res) => {
  if (req.url === '/files.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getFiles(BASE)));
    return;
  }
  
  const filePath = path.join(BASE, decodeURIComponent(req.url));
  if (fs.existsSync(filePath) && !filePath.includes('node_modules')) {
    res.writeHead(200);
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Serving aya-expo-tools on http://0.0.0.0:${PORT}`);
  console.log('Media server can download from: http://192.168.15.146:' + PORT);
  console.log('Or via WireGuard: http://10.253.0.1:' + PORT);
  console.log('\nPress Ctrl+C to stop');
});
