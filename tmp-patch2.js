const fs = require('fs');
const f = 'C:\\aya-expo-tools\\config\\beleza-astral.json';
const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));

cfg.cameras.forEach(c => {
  if (c.id === 'cam-1') {
    c.ip = '192.168.0.181';
    c.password = 'admin';
    c.model = 'Intelbras iMD 3C Black';
    console.log('cam-1 OK:', c.ip);
  }
  if (c.id === 'cam-2') {
    c.ip = '192.168.0.108';
    c.password = 'admin';
    c.model = 'Intelbras iMD 3C Black';
    console.log('cam-2 OK:', c.ip);
  }
});

fs.writeFileSync(f, JSON.stringify(cfg, null, 2), 'utf8');
console.log('Salvo.');
