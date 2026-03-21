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
 *   PLAY:  /composition/layers/<N>/clips/<N>/connect  → int 1
 *   STOP:  /composition/layers/<N>/clear              → int 1
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

  _playAddress(layer, clip) {
    // Conecta (play) um clip específico na layer
    return `/composition/layers/${layer}/clips/${clip}/connect`;
  }

  _clearAddress(layer) {
    // Limpa (para) a layer inteira — mapeamento correto do Resolume
    return `/composition/layers/${layer}/clear`;
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Inicia reprodução — conecta áudio primeiro, vídeo 500ms depois.
   * Usar no open sequence ANTES de ligar os projetores.
   * OSC: /composition/layers/N/clips/N/connect → int 1
   */
  async playAll() {
    if (!this.enabled) return;
    // Áudio primeiro — sem flash visual
    await this._send(this._playAddress(this.audioLayer, this.clip), 1);
    await this._sleep(500);
    await this._send(this._playAddress(this.videoLayer, this.clip), 1);
    console.log('  🎬 Resolume ▶ play — vídeo layer ' + this.videoLayer + ' + áudio layer ' + this.audioLayer);
  }

  /**
   * Para reprodução — clear em cada layer.
   * Usar no close sequence ANTES de desligar os projetores.
   * OSC: /composition/layers/N/clear → int 1
   */
  async stopAll() {
    if (!this.enabled) return;
    await this._send(this._clearAddress(this.videoLayer), 1);
    await this._sleep(200);
    await this._send(this._clearAddress(this.audioLayer), 1);
    console.log('  🎬 Resolume ⏹ clear layers ' + this.videoLayer + ' + ' + this.audioLayer);
  }

  /**
   * Teste manual — envia stop e play em sequência.
   * Acessível via POST /api/resolume/test
   */
  async test() {
    console.log(`  🎬 Resolume OSC test → ${this.host}:${this.port}`);
    await this.stopAll();
    await this._sleep(1000);
    await this.playAll();
    return {
      ok: true,
      host: this.host,
      port: this.port,
      videoLayer: this.videoLayer,
      audioLayer: this.audioLayer,
      clip: this.clip,
    };
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
