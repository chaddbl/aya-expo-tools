const fs = require('fs');
const f = 'C:\\aya-expo-tools\\config\\beleza-astral.json';
const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));

const cam3 = cfg.cameras.find(c => c.id === 'cam-3');
cam3.ip = '192.168.0.101';
cam3.password = 'ac00ac00ac00ac';
cam3.model = 'Intelbras iMD 3C Black';
console.log('cam-3:', cam3.ip, cam3.password);

fs.writeFileSync(f, JSON.stringify(cfg, null, 2), 'utf8');
console.log('Salvo.');
