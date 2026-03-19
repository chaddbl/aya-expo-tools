/**
 * AYA Expo Tools — PJLink Engine
 * Protocolo PJLink Class 1 (TCP porta 4352)
 * Compatível com NEC PE456USL e qualquer projetor PJLink
 */

const net = require('net');
const crypto = require('crypto');

const PJLINK_PORT = 4352;
const TIMEOUT = 5000;

// PJLink Class 1 Commands
const COMMANDS = {
  POWER_ON:     '%1POWR 1\r',
  POWER_OFF:    '%1POWR 0\r',
  POWER_QUERY:  '%1POWR ?\r',
  INPUT_QUERY:  '%1INPT ?\r',
  INPUT_SET:    (n) => `%1INPT ${n}\r`,
  LAMP_QUERY:   '%1LAMP ?\r',
  NAME_QUERY:   '%1NAME ?\r',
  INFO1_QUERY:  '%1INF1 ?\r',  // Manufacturer
  INFO2_QUERY:  '%1INF2 ?\r',  // Model
  CLASS_QUERY:  '%2CLSS ?\r',
  ERROR_QUERY:  '%1ERST ?\r',
};

// Input codes
const INPUTS = {
  'RGB1':   '11', 'RGB2':   '12',
  'VIDEO1': '21', 'VIDEO2': '22',
  'HDMI1':  '31', 'HDMI2':  '32',
  'USB1':   '41', 'USB2':   '42',
  'NET':    '51', 'NET2':   '52',
};

const INPUT_NAMES = Object.fromEntries(
  Object.entries(INPUTS).map(([k, v]) => [v, k])
);

// Power states
const POWER_STATES = {
  '0': 'off',
  '1': 'on',
  '2': 'cooling',
  '3': 'warmup',
};

/**
 * Send a raw PJLink command to a projector
 * Handles authentication (Class 1 digest)
 */
function sendCommand(ip, command, password = '', port = PJLINK_PORT) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = '';
    let authenticated = false;
    let timer;

    timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timeout connecting to ${ip}:${port}`));
    }, TIMEOUT);

    socket.connect(port, ip, () => {
      // Wait for greeting
    });

    socket.on('data', (data) => {
      buffer += data.toString();

      // First response: PJLink greeting
      // "PJLINK 0\r" = no auth required
      // "PJLINK 1 <random>\r" = auth required
      if (!authenticated) {
        const lines = buffer.split('\r');
        const greeting = lines[0];

        if (greeting.startsWith('PJLINK 0')) {
          // No auth
          authenticated = true;
          buffer = '';
          socket.write(command);
        } else if (greeting.startsWith('PJLINK 1')) {
          // Auth required
          const random = greeting.split(' ')[2];
          const hash = crypto.createHash('md5')
            .update(random + password)
            .digest('hex');
          authenticated = true;
          buffer = '';
          socket.write(hash + command);
        } else if (greeting.includes('PJLINK ERRA')) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error('Authentication error'));
          return;
        }
      } else {
        // Response to our command
        if (buffer.includes('\r')) {
          clearTimeout(timer);
          const response = buffer.trim();
          socket.destroy();
          resolve(parseResponse(response));
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Connection error ${ip}: ${err.message}`));
    });

    socket.on('close', () => {
      clearTimeout(timer);
    });
  });
}

/**
 * Parse PJLink response
 */
function parseResponse(raw) {
  // Format: %1XXXX=VALUE
  const match = raw.match(/%(\d)(\w{4})=(.+)/);
  if (!match) return { raw, ok: false, error: 'Invalid response' };

  const [, cls, cmd, value] = match;

  if (value === 'ERR1') return { raw, ok: false, error: 'Undefined command' };
  if (value === 'ERR2') return { raw, ok: false, error: 'Out of parameter' };
  if (value === 'ERR3') return { raw, ok: false, error: 'Unavailable time' };
  if (value === 'ERR4') return { raw, ok: false, error: 'Projector failure' };
  if (value === 'ERRA') return { raw, ok: false, error: 'Authentication error' };

  return { raw, ok: true, command: cmd, value };
}

/**
 * High-level projector API
 */
class Projector {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.ip = config.ip;
    this.model = config.model || '';
    this.defaultInput = config.input || 'HDMI1';
    this.password = config.password || '';
    this.port = config.port || PJLINK_PORT;

    // Cached state
    this.state = {
      power: 'unknown',
      input: 'unknown',
      lamp: null,
      name: '',
      manufacturer: '',
      modelName: '',
      errors: '',
      lastUpdate: null,
      online: false,
    };
  }

  async send(command) {
    try {
      const result = await sendCommand(this.ip, command, this.password, this.port);
      this.state.online = true;
      this.state.lastUpdate = new Date().toISOString();
      return result;
    } catch (err) {
      this.state.online = false;
      this.state.lastUpdate = new Date().toISOString();
      throw err;
    }
  }

  async powerOn() {
    const r = await this.send(COMMANDS.POWER_ON);
    if (r.ok) this.state.power = 'warmup';
    return r;
  }

  async powerOff() {
    const r = await this.send(COMMANDS.POWER_OFF);
    if (r.ok) this.state.power = 'cooling';
    return r;
  }

  async getPower() {
    const r = await this.send(COMMANDS.POWER_QUERY);
    if (r.ok) this.state.power = POWER_STATES[r.value] || r.value;
    return this.state.power;
  }

  async getInput() {
    const r = await this.send(COMMANDS.INPUT_QUERY);
    if (r.ok) this.state.input = INPUT_NAMES[r.value] || r.value;
    return this.state.input;
  }

  async setInput(input) {
    const code = INPUTS[input.toUpperCase()] || input;
    const r = await this.send(COMMANDS.INPUT_SET(code));
    if (r.ok) this.state.input = input.toUpperCase();
    return r;
  }

  async getLamp() {
    const r = await this.send(COMMANDS.LAMP_QUERY);
    if (r.ok) {
      const parts = r.value.split(' ');
      this.state.lamp = { hours: parseInt(parts[0]) || 0, on: parts[1] === '1' };
    }
    return this.state.lamp;
  }

  async getName() {
    const r = await this.send(COMMANDS.NAME_QUERY);
    if (r.ok) this.state.name = r.value;
    return this.state.name;
  }

  async getInfo() {
    try {
      const r1 = await this.send(COMMANDS.INFO1_QUERY);
      if (r1.ok) this.state.manufacturer = r1.value;
    } catch (e) {}
    try {
      const r2 = await this.send(COMMANDS.INFO2_QUERY);
      if (r2.ok) this.state.modelName = r2.value;
    } catch (e) {}
    return { manufacturer: this.state.manufacturer, model: this.state.modelName };
  }

  async getErrors() {
    const r = await this.send(COMMANDS.ERROR_QUERY);
    if (r.ok) this.state.errors = r.value;
    return this.state.errors;
  }

  /**
   * Full status poll — queries power, input, lamp, errors
   */
  async poll() {
    try {
      await this.getPower();
      if (this.state.power === 'on') {
        await this.getInput();
        await this.getLamp();
      }
      this.state.online = true;
    } catch (err) {
      this.state.online = false;
      this.state.power = 'unreachable';
    }
    this.state.lastUpdate = new Date().toISOString();
    return this.getStatus();
  }

  getStatus() {
    return {
      id: this.id,
      ip: this.ip,
      model: this.model,
      ...this.state,
      // Config name wins over PJLink name (which is often empty)
      name: this.name || this.state.name || this.id,
    };
  }
}

/**
 * Projector Manager — manages multiple projectors
 */
class ProjectorManager {
  constructor(config) {
    this.projectors = new Map();
    this.pjlinkConfig = config.pjlink || {};
    this.pollTimer = null;

    for (const p of config.projectors || []) {
      const proj = new Projector({
        ...p,
        password: p.password || this.pjlinkConfig.password || '',
        port: p.port || this.pjlinkConfig.port || PJLINK_PORT,
      });
      this.projectors.set(p.id, proj);
    }
  }

  get(id) {
    return this.projectors.get(id);
  }

  all() {
    return Array.from(this.projectors.values());
  }

  async pollAll() {
    const results = await Promise.allSettled(
      this.all().map(p => p.poll())
    );
    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const p = this.all()[i];
      return { ...p.getStatus(), error: r.reason?.message };
    });
  }

  async powerOnAll() {
    return Promise.allSettled(this.all().map(p => p.powerOn()));
  }

  async powerOffAll() {
    return Promise.allSettled(this.all().map(p => p.powerOff()));
  }

  startPolling(interval) {
    const ms = interval || this.pjlinkConfig.pollInterval || 30000;
    this.stopPolling();
    console.log(`[PJLink] Polling every ${ms / 1000}s`);
    this.pollAll(); // immediate
    this.pollTimer = setInterval(() => this.pollAll(), ms);
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  getAllStatus() {
    return this.all().map(p => p.getStatus());
  }
}

module.exports = { Projector, ProjectorManager, INPUTS, INPUT_NAMES, POWER_STATES };
