/**
 * Pack aya-expo-tools into a zip and serve via HTTP
 * Media server downloads with one PowerShell command
 */
const { execSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ZIP_PATH = path.join(__dirname, '..', 'aya-expo-tools.zip');
const PORT = 9999;

// Remove old zip
if (fs.existsSync(ZIP_PATH)) fs.unlinkSync(ZIP_PATH);

// Create zip excluding node_modules, .git, serve files
console.log('📦 Creating zip...');

// Use PowerShell to create zip (exclude node_modules, .git, temp files)
const src = __dirname;
const tempDir = path.join(require('os').tmpdir(), 'aya-expo-pack');

// Clean copy without node_modules
execSync(`rm -rf "${tempDir}" 2>/dev/null; mkdir -p "${tempDir}"`);
execSync(`cp -r "${src}/server" "${tempDir}/"`);
execSync(`cp -r "${src}/ui" "${tempDir}/"`);
execSync(`cp -r "${src}/config" "${tempDir}/"`);
execSync(`cp "${src}/package.json" "${tempDir}/"`);
execSync(`cp "${src}/package-lock.json" "${tempDir}/"`);
execSync(`cp "${src}/install.bat" "${tempDir}/"`);
execSync(`cp "${src}/README.md" "${tempDir}/"`);
execSync(`cp "${src}/.gitignore" "${tempDir}/"`);

// Create zip via PowerShell
execSync(`powershell.exe -Command "Compress-Archive -Path '${tempDir.replace(/\//g, '\\')}\\*' -DestinationPath '${ZIP_PATH.replace(/\//g, '\\')}' -Force"`);

const stats = fs.statSync(ZIP_PATH);
console.log(`✅ Zip created: ${(stats.size / 1024).toFixed(0)} KB`);

// Serve
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/aya-expo-tools.zip') {
    const data = fs.readFileSync(ZIP_PATH);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': data.length,
      'Content-Disposition': 'attachment; filename=aya-expo-tools.zip'
    });
    res.end(data);
    console.log(`📥 Downloaded by ${req.socket.remoteAddress}`);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('GET / to download aya-expo-tools.zip');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🌐 Serving on:`);
  console.log(`   http://localhost:${PORT}/`);
  console.log(`   http://10.253.0.1:${PORT}/  (WireGuard → media server)`);
  console.log(`\n📋 No media server, rodar:`);
  console.log(`   Invoke-WebRequest -Uri "http://10.253.0.1:${PORT}/" -OutFile "$env:TEMP\\aya-expo-tools.zip"`);
  console.log(`   Expand-Archive "$env:TEMP\\aya-expo-tools.zip" -DestinationPath "C:\\aya-expo-tools" -Force`);
  console.log(`   cd C:\\aya-expo-tools; npm install; npm start`);
  console.log(`\nPress Ctrl+C to stop`);
});
