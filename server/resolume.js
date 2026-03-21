/**
 * AYA Expo Tools — Resolume OSC Controller
 *
 * Envia mensagens OSC para o Resolume Arena via UDP.
 * Sem dependências externas — OSC implementado com dgram nativo do Node.
 *
 * Uso no scheduler:
 *   await resolume.playAll()   ← abre: conecta vídeo + áudio
 *   await resolume.stopAll()   ← fecha: desconecta vídeo + áudio → GPU idle
 *
 * Config em config/beleza-astral.json:
 *   "resolume": {
 *     "osc": { "host": "127.0.0.1", "port": 7000 },
 *     "layers": { "video": 1, "audio": 2 },
 *     "clip": 1,
 *     "autoManage": true
 *   }
 *
 * OSC addresses usados:
 *   /composition/layers/<N>/clips/<N>/connect  → int 1 (play) | int 0 (stop)
 */

const dgram = require('dgram');

class ResolumeOSC {
  constructor(config) {
    const osc = config?.osc || {};
    this.host = osc.host || '127.0.0.1';
    this.port = osc.port || 7000;
    this.videoLayer = config?.layers?.video ?? 1;
    this.audioLayer = config?.layers?.audio ?? 2;
    this.clip       = config?.clip ?? 1;
    this.enabled    = config?.autoManage !== false;
  }

  // ── OSC message builder ──────────────────────────────────────────────────

  /**
   * Monta um pacote OSC com um argumento inteiro.
   * Formato: [addr\0...pad][,i\0\0][int32 big-endian]
   */
  _buildIntMessage(address, value) {
    const addrBuf = this._padString(address);
    const typeBuf = this._padString(',i');
    const argBuf  = Buffer.alloc(4);
    argBuf.writeInt32BE(value, 0);
    return Buffer.concat([addrBuf, typeBuf, argBuf]);
  }

  /** Null-termina e preenche até múltiplo de 4 bytes. */
  _padString(str) {
    const raw = Buffer.from(str + '\0', 'ascii');
    const pad = (4 - (raw.length % 4)) % 4;
    return Buffer.concat([raw, Buffer.alloc(pad)]);
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  _send(address, value) {
    return new Promise((resolve) => {
      const msg    = this._buildIntMessage(address, value);
      const client = dgram.createSocket('udp4');
      client.send(msg, this.port, this.host, (err) => {
        client.close();
        if (err) {
          console.error(`  🎬 Resolume OSC erro: ${address} = ${value} — ${err.message}`);
          resolve(false);
        } else {
          console.log(`  🎬 Resolume OSC → ${address} = ${value}`);
          resolve(true);
        }
      });
    });
  }

  _address(layer, clip) {
    return `/composition/layers/${layer}/clips/${clip}/connect`;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Inicia reprodução — conecta áudio primeiro, vídeo 500ms depois.
   * Usar no open sequence ANTES de ligar os projetores.
   */
  async playAll() {
    if (!this.enabled) return;
    // Áudio primeiro — sem flash visual
    await this._send(this._address(this.audioLayer, this.clip), 1);
    await this._sleep(500);
    await this._send(this._address(this.videoLayer, this.clip), 1);
    console.log('  🎬 Resolume ▶ play — vídeo + áudio');
  }

  /**
   * Para reprodução — desconecta clips → GPU vai para idle.
   * Usar no close sequence ANTES de desligar os projetores.
   */
  async stopAll() {
    if (!this.enabled) return;
    await this._send(this._address(this.videoLayer, this.clip), 0);
    await this._sleep(200);
    await this._send(this._address(this.audioLayer, this.clip), 0);
    console.log('  🎬 Resolume ⏹ stop — GPU idle');
  }

  /**
   * Teste — envia play e loga o resultado (sem afetar projetores).
   */
  async test() {
    console.log(`  🎬 Resolume OSC test → ${this.host}:${this.port}`);
    const ok = await this._send(this._address(this.videoLayer, this.clip), 1);
    return { ok, host: this.host, port: this.port, videoLayer: this.videoLayer, audioLayer: this.audioLayer, clip: this.clip };
  }

  getStatus() {
    return {
      enabled: this.enabled,
      host: this.host,
      port: this.port,
      videoLayer: this.videoLayer,
      audioLayer: this.audioLayer,
      clip: this.clip,
    };
  }
}

module.exports = { ResolumeOSC };
