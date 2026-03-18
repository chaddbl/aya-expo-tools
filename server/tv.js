/**
 * tv.js — Controle de TVs Hisense VIDAA OS
 *
 * Liga:   Wake-on-LAN (magic packet UDP porta 9)
 * Desliga: MQTT porta 36669 (protocolo nativo VIDAA)
 * Status:  TCP probe porta 36669 — se responde, TV está ligada
 *
 * Pré-requisitos na TV (configurar uma vez):
 *   Configurações → Rede → Wake on LAN: ATIVADO
 *   Configurações → Rede → Wake on WiFi: ATIVADO (se for via WiFi)
 */

const dgram  = require('dgram');
const net    = require('net');
const mqtt   = require('mqtt');

// ── Wake-on-LAN ──────────────────────────────────────────
// Monta o magic packet: 6x FF + 16x MAC
function buildMagicPacket(mac) {
  const hex = mac.replace(/[:\-\.]/g, '');
  if (hex.length !== 12) throw new Error(`MAC inválido: ${mac}`);
  const macBytes = Buffer.from(hex, 'hex');
  const packet   = Buffer.alloc(6 + 16 * 6);
  packet.fill(0xFF, 0, 6);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  return packet;
}

async function powerOn(tv) {
  const mac = tv.mac || '';
  if (!mac || mac === 'TBD' || mac === '') {
    throw new Error('MAC não configurado — adicione em /config.html após encontrar o endereço no roteador');
  }

  const broadcast = tv.broadcastAddr || '192.168.0.255';

  return new Promise((resolve, reject) => {
    try {
      const packet = buildMagicPacket(mac);
      const socket = dgram.createSocket('udp4');

      socket.once('error', err => { socket.close(); reject(err); });
      socket.bind(() => {
        socket.setBroadcast(true);
        // Envia 3x para garantir entrega (UDP não tem confirmação)
        let sent = 0;
        const send = () => {
          socket.send(packet, 0, packet.length, 9, broadcast, err => {
            if (err) { socket.close(); return reject(err); }
            sent++;
            if (sent < 3) setTimeout(send, 100);
            else { socket.close(); resolve(); }
          });
        };
        send();
      });
    } catch (e) {
      reject(e);
    }
  });
}

// ── MQTT Power Off ───────────────────────────────────────
// Protocolo Hisense VIDAA: broker MQTT porta 36669
// Tópico: <mac_sem_colons>/remoteapp/ui/ui_service/data/keyevent
// Payload: { "keyCode": "KEY_POWER", "type": 1, "status": 1 }
async function powerOff(tv) {
  const ip  = tv.ip  || '';
  const mac = tv.mac || '';
  if (!ip) throw new Error('IP não configurado');

  // MAC normalizado: lowercase sem separadores
  const macNorm = mac.replace(/[:\-\.]/g, '').toLowerCase();

  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://${ip}:36669`, {
      username: 'hisenseservice',
      password: 'multimqttservice',
      connectTimeout: 5000,
      reconnectPeriod: 0,
      rejectUnauthorized: false,
    });

    const timeout = setTimeout(() => {
      client.end(true);
      reject(new Error('Timeout — TV não respondeu na porta 36669'));
    }, 8000);

    client.on('connect', () => {
      clearTimeout(timeout);
      // Tenta com MAC no tópico (padrão A51H); fallback sem MAC se necessário
      const topic   = macNorm
        ? `${macNorm}/remoteapp/ui/ui_service/data/keyevent`
        : `remoteapp/ui/ui_service/data/keyevent`;
      const payload = JSON.stringify({ keyCode: 'KEY_POWER', type: 1, status: 1 });

      client.publish(topic, payload, {}, () => {
        setTimeout(() => { client.end(); resolve(); }, 500);
      });
    });

    client.on('error', err => {
      clearTimeout(timeout);
      client.end(true);
      // Erros de certificado são normais em algumas versões VIDAA — não são fatais
      if (err.code === 'ECONNREFUSED') {
        reject(new Error('Conexão recusada — TV pode estar desligada ou IP incorreto'));
      } else {
        reject(err);
      }
    });
  });
}

// ── Status ───────────────────────────────────────────────
// Proba TCP porta 36669: se aceita conexão, TV está ligada e com rede
async function isOnline(tv) {
  const ip = tv.ip || '';
  if (!ip) return false;

  return new Promise(resolve => {
    const socket = new net.Socket();
    socket.setTimeout(3000);
    socket.once('connect', () => { socket.destroy(); resolve(true);  });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error',   () => { socket.destroy(); resolve(false); });
    socket.connect(36669, ip);
  });
}

// ── Volume ───────────────────────────────────────────────
async function setVolume(tv, level) {
  const ip  = tv.ip  || '';
  const mac = tv.mac || '';
  if (!ip) throw new Error('IP não configurado');

  const macNorm = mac.replace(/[:\-\.]/g, '').toLowerCase();

  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtt://${ip}:36669`, {
      username: 'hisenseservice',
      password: 'multimqttservice',
      connectTimeout: 5000,
      reconnectPeriod: 0,
      rejectUnauthorized: false,
    });

    const timeout = setTimeout(() => { client.end(true); reject(new Error('Timeout')); }, 8000);

    client.on('connect', () => {
      clearTimeout(timeout);
      const topic   = macNorm
        ? `${macNorm}/remoteapp/ui/ui_service/data/keyevent`
        : `remoteapp/ui/ui_service/data/keyevent`;
      const payload = JSON.stringify({ keyCode: 'KEY_VOLUMEUP', type: 1, status: 1, value: level });
      client.publish(topic, payload, {}, () => {
        setTimeout(() => { client.end(); resolve(); }, 300);
      });
    });

    client.on('error', err => { clearTimeout(timeout); client.end(true); reject(err); });
  });
}

module.exports = { powerOn, powerOff, isOnline, setVolume };
