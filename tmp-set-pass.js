const fs = require('fs');
const f = 'C:\\aya-expo-tools\\config\\beleza-astral.json';
const cfg = JSON.parse(fs.readFileSync(f, 'utf8'));

const pass = 'ac00ac00ac00ac';
cfg.cameras.forEach(c => {
  c.password = pass;
  console.log(`${c.id} ${c.ip} → senha setada`);
});

fs.writeFileSync(f, JSON.stringify(cfg, null, 2), 'utf8');
console.log('Salvo.');
