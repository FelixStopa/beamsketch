// galvo.js — Galvo-Laser mit BJJCZ-Steuerung (EZCAD2: Faser- und CO2-Galvos) direkt über WebUSB.
// Das Protokoll folgt galvoplotter aus dem MeerK40t-Projekt (MIT-Lizenz,
// https://github.com/meerk40t/galvoplotter): Jeder Befehl ist 12 Byte lang (6 × uint16, little endian).
// Echtzeitbefehle gehen einzeln raus und liefern 8 Byte Antwort; Listenbefehle (Bewegung, Laser,
// Parameter) werden zu Paketen mit 256 Befehlen (0xC00 Bytes) gebündelt, die die Steuerung abarbeitet.
// Koordinaten: 0…0xFFFF über das Linsenfeld, Mitte 0x8000. Die Arbeitsfläche in BeamSketch ist das
// Linsenfeld (Breite × Höhe der Maschine), ihre Mitte liegt in der Feldmitte.
import { loc } from './i18n.js';

export const GALVO_FIRMWARE = 'EZCAD2';
export const isGalvo = m => !!m && m.firmware === GALVO_FIRMWARE;
export const GALVO_USB = { vendorId: 0x9588, productId: 0x9899 };
const EP_OUT = 2, EP_IN = 8;

// Listenbefehle
const L_JUMP = 0x8001, L_END = 0x8002, L_ON_POINT = 0x8003, L_DELAY = 0x8004, L_MARK = 0x8005,
  L_JUMP_SPEED = 0x8006, L_ON_DELAY = 0x8007, L_OFF_DELAY = 0x8008, L_MARK_FREQ = 0x800A,
  L_POWER_RATIO = 0x800B, L_MARK_SPEED = 0x800C, L_JUMP_DELAY = 0x800D, L_POLY_DELAY = 0x800F,
  L_WRITE_PORT = 0x8011, L_MARK_CURRENT = 0x8012, L_QSWITCH = 0x801B, L_PULSE_WIDTH = 0x8026,
  L_READY = 0x8051;
// Echtzeitbefehle
const ENABLE_LASER = 0x0004, EXECUTE_LIST = 0x0005, SET_PWM_PULSE_WIDTH = 0x0006, GET_VERSION = 0x0007,
  GET_SERIAL = 0x0009, RESET_LIST = 0x0012, RESTART_LIST = 0x0013, WRITE_COR_TABLE = 0x0015,
  SET_CONTROL_MODE = 0x0016, SET_DELAY_MODE = 0x0017, SET_END_OF_LIST = 0x0019, SET_FPK = 0x001A,
  SET_LASER_MODE = 0x001B, SET_TIMING = 0x001C, SET_STANDBY = 0x001D, SET_PWM_HALF_PERIOD = 0x001E,
  STOP_EXECUTE = 0x001F, STOP_LIST = 0x0020, WRITE_PORT = 0x0021, WRITE_ANALOG_1 = 0x0022,
  SET_FPK_PARAM_2 = 0x002E, SET_FLY_RES = 0x0032, FIBER_SET_MO = 0x0033, ENABLE_Z = 0x003A, RESET = 0x0040;
// Statusbits (viertes Wort der Antwort auf GET_VERSION)
const BUSY = 0x04, READY = 0x20;

const PACKET_CMDS = 256, PACKET_BYTES = PACKET_CMDS * 12;

/* Einstellungen der Maschine (Teil von doc.machine.galvo); Startwerte wie bei galvoplotter */
export const GALVO_DEFAULTS = {
  source: 'fiber',        // 'fiber' | 'co2'
  travelSpeed: 2000,      // mm/s für Leerfahrten (Sprünge)
  frameSpeed: 2000,       // mm/s für den Rahmen mit dem Pilotlaser
  lightPin: 8,            // Ausgang für den roten Pilotlaser
  laserPin: 0,            // Ausgang „Laser freigeben"
  delayOn: 100,           // µs Laser-Ein-Verzögerung
  delayOff: 100,          // µs Laser-Aus-Verzögerung
  delayPolygon: 100,      // µs an Ecken
  delayJumpShort: 8,      // µs nach kurzen Sprüngen
  delayJumpLong: 200,     // µs nach langen Sprüngen (> 10 mm)
  delayOpenMo: 8,         // ms nach dem Öffnen des Faser-Masteroszillators
  flipX: false, flipY: false, swapXY: false
};
export const galvoCfg = m => ({ ...GALVO_DEFAULTS, ...((m && m.galvo) || {}) });

const clamp16 = v => Math.max(0, Math.min(0xFFFF, Math.round(v)));
const signed = d => [Math.abs(Math.round(d)), d >= 0 ? 0x0000 : 0x8000];

/* ---------------- Werkzeugwege → Befehlsliste ----------------
   ops kommen aus cam.buildJob (mm, absolute Koordinaten der Arbeitsfläche).
   Ergebnis: { cmds: [[op, v1..v5], …], markLen, jumpLen, seconds } – reine Daten, testbar ohne Gerät. */
function fieldMap(machine) {
  const g = galvoCfg(machine);
  const W = machine.width, H = machine.height;
  const k = Math.min(0x10000 / W, 0x10000 / H);         // Galvo-Einheiten je mm
  const toG = p => {
    let u = (p.x - W / 2) / W, v = (p.y - H / 2) / H;     // -0.5 … 0.5
    if (g.flipX) u = -u;
    if (g.flipY) v = -v;
    if (g.swapXY) [u, v] = [v, u];
    return { x: clamp16(0x8000 + u * 0x10000), y: clamp16(0x8000 + v * 0x10000) };
  };
  const speedCode = mmS => Math.max(1, Math.min(0xFFFF, Math.round(mmS * k / 1000)));   // Galvo-Einheiten je ms
  return { g, k, toG, speedCode };
}

export function buildGalvoProgram(machine, ops) {
  const { g, k, toG, speedCode } = fieldMap(machine);
  const cmds = [];
  const add = (...c) => cmds.push(c);
  let last = { x: 0x8000, y: 0x8000 };
  let jumpDelay = null, markLen = 0, jumpLen = 0, seconds = 0, curPower = null;
  const dist = (a, b) => Math.min(0xFFFF, Math.round(Math.hypot(a.x - b.x, a.y - b.y)));

  const jump = (p) => {
    if (p.x === last.x && p.y === last.y) return;
    const d = dist(p, last), mm = d / k;
    const delay = mm > 10 ? g.delayJumpLong : g.delayJumpShort;
    if (delay !== jumpDelay) { add(L_JUMP_DELAY, ...signed(delay)); jumpDelay = delay; }
    add(L_JUMP, p.x, p.y, 0, d);
    jumpLen += mm; seconds += mm / g.travelSpeed + delay / 1e6;
    last = p;
  };
  const mark = (p, speed) => {
    if (p.x === last.x && p.y === last.y) return;
    const d = dist(p, last), mm = d / k;
    add(L_MARK, p.x, p.y, 0, d);
    markLen += mm; seconds += mm / Math.max(1, speed);
    last = p;
  };
  const setPower = (pct, freq) => {
    pct = Math.max(0, Math.min(100, pct));
    if (pct === curPower) return;
    curPower = pct;
    if (g.source === 'co2') add(L_POWER_RATIO, Math.round(200 * pct / freq));
    else add(L_MARK_CURRENT, Math.round(pct * 0xFFF / 100));
  };

  // Laser freigeben (Pilotlaser aus), Faserlaser: Masteroszillator einschwingen lassen
  add(L_READY);
  if (g.source === 'fiber' && g.delayOpenMo) add(L_DELAY, Math.round(g.delayOpenMo * 100));
  add(L_WRITE_PORT, 1 << g.laserPin);
  add(L_JUMP_SPEED, speedCode(g.travelSpeed));

  let curLayer = null, curSpeed = null;
  for (const op of ops) {
    const L = op.layerRef || {};
    const freq = Math.max(1, L.frequency || 30);
    if (L !== curLayer) {
      curLayer = L;
      if (g.source === 'co2') {
        add(L_MARK_FREQ, clamp16(10000 / freq));
        curPower = null; setPower(op.power ?? L.maxPower, freq);
      } else {
        if (L.pulseWidth > 0) add(L_PULSE_WIDTH, clamp16(L.pulseWidth));
        curPower = null; setPower(op.power ?? L.maxPower, freq);
        add(L_QSWITCH, clamp16(20000 / freq));
      }
      add(L_ON_DELAY, ...signed(g.delayOn));
      add(L_OFF_DELAY, ...signed(g.delayOff));
      add(L_POLY_DELAY, ...signed(g.delayPolygon));
      curSpeed = null;
    }
    if (op.speed !== curSpeed) { add(L_MARK_SPEED, speedCode(op.speed)); curSpeed = op.speed; }
    const pts = op.pts || [];
    if (!pts.length) continue;

    if (op.kind === 'raster' && op.raster) {
      // Bildzeile: Abschnitte gleicher Helligkeit mit eigener Leistung, Weiß wird übersprungen
      const a = pts[0], b = pts[1];
      const total = Math.hypot(b.x - a.x, b.y - a.y);
      if (total < 1e-6) continue;
      const u = { x: (b.x - a.x) / total, y: (b.y - a.y) / total };
      const lead = op.lead || 0;
      const start = { x: a.x + u.x * lead, y: a.y + u.y * lead };
      const cell = (total - 2 * lead) / op.raster.length;
      const at = i => toG({ x: start.x + u.x * cell * i, y: start.y + u.y * cell * i });
      const maxP = op.power, minP = op.minPower || 0;
      let i = 0;
      while (i < op.raster.length) {
        let j = i;
        const v = op.raster[i];
        while (j + 1 < op.raster.length && op.raster[j + 1] === v) j++;
        if (v > 0) {
          jump(at(i));
          setPower(minP + (maxP - minP) * v, freq);
          mark(at(j + 1), op.speed);
        }
        i = j + 1;
      }
      continue;
    }
    setPower(op.power ?? L.maxPower, freq);
    if (L.dotMode) {
      // Punktmodus: an jedem Punkt stehen bleiben und feuern (Einheit 10 µs, je Befehl höchstens 0,6 s)
      for (const q of pts) {
        jump(toG(q));
        let t = Math.round((L.dotTime || 1) * 100);
        seconds += t / 1e5;
        while (t > 0) { const d = Math.min(t, 60000); add(L_ON_POINT, d); t -= d; }
      }
      continue;
    }
    jump(toG(pts[0]));
    for (let i = 1; i < pts.length; i++) mark(toG(pts[i]), op.speed);
    if (op.closed && pts.length > 2) mark(toG(pts[0]), op.speed);
  }
  add(L_END);
  return { cmds, markLen, jumpLen, seconds };
}

/* Rahmen mit dem roten Pilotlaser: Umriss des Jobs mehrfach abfahren (Laser aus) */
export function buildFrameProgram(machine, box, loops = 20) {
  const { g, toG, speedCode } = fieldMap(machine);
  const cmds = [[L_READY], [L_WRITE_PORT, 1 << g.lightPin], [L_JUMP_SPEED, speedCode(g.frameSpeed)],
    [L_JUMP_DELAY, ...signed(g.delayJumpShort)]];
  const corners = [{ x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 }, { x: box.x1, y: box.y1 }, { x: box.x0, y: box.y1 }].map(toG);
  let last = corners[corners.length - 1];
  for (let n = 0; n < loops; n++) for (const p of corners) {
    cmds.push([L_JUMP, p.x, p.y, 0, Math.min(0xFFFF, Math.round(Math.hypot(p.x - last.x, p.y - last.y)))]);
    last = p;
  }
  cmds.push([L_END]);
  return { cmds };
}

/* Befehlsliste in Pakete zu 0xC00 Bytes; freie Plätze füllt galvoplotter mit „Listenende" (0x8002) */
export function packCommands(cmds) {
  const packets = [];
  for (let i = 0; i < cmds.length; i += PACKET_CMDS) {
    const buf = new Uint8Array(PACKET_BYTES);
    const dv = new DataView(buf.buffer);
    for (let j = 0; j < PACKET_CMDS; j++) {
      const c = cmds[i + j] || [L_END];
      for (let w = 0; w < 6; w++) dv.setUint16(j * 12 + w * 2, (c[w] || 0) & 0xFFFF, true);
    }
    packets.push(buf);
  }
  return packets;
}

/* ---------------- USB-Verbindung ---------------- */
export class WebUsbLink {
  static get supported() { return typeof navigator !== 'undefined' && 'usb' in navigator; }
  async open() {
    if (!WebUsbLink.supported) throw new Error(loc('WebUSB wird von diesem Browser nicht unterstützt. Nutze Chrome oder Edge am Computer.'));
    const known = (await navigator.usb.getDevices()).filter(d => d.vendorId === GALVO_USB.vendorId && d.productId === GALVO_USB.productId);
    this.dev = known[0] || await navigator.usb.requestDevice({ filters: [GALVO_USB] });
    try {
      await this.dev.open();
      if (!this.dev.configuration) await this.dev.selectConfiguration(1);
      await this.dev.claimInterface(0);
    } catch (e) {
      throw new Error(loc('Die Galvo-Steuerung lässt sich nicht öffnen ({msg}). Läuft EZCAD oder LightBurn noch? Unter Windows muss der Treiber mit Zadig auf „WinUSB" umgestellt sein.', { msg: e.message }));
    }
  }
  async write(buf) { await this.dev.transferOut(EP_OUT, buf); }
  async read() {
    const r = await this.dev.transferIn(EP_IN, 8);
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }
  async close() {
    try { await this.dev.releaseInterface(0); } catch (e) { /* egal */ }
    try { await this.dev.close(); } catch (e) { /* egal */ }
    this.dev = null;
  }
}

const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) =>
  setTimeout(() => rej(new Error(loc('Die Galvo-Steuerung antwortet nicht ({what}).', { what }))), ms))]);

/* ---------------- Gerät ---------------- */
export class GalvoLaser {
  constructor(link = null) {
    this.link = link;
    this.connected = false;
    this.state = 'idle';             // idle | marking | framing
    this.port = 0;
    this.serial = null;
    this._chain = Promise.resolve();
    this._abort = false;
    this.onState = () => { };
    this.onProgress = () => { };
    this.onDone = () => { };
  }
  get supported() { return WebUsbLink.supported; }
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  _setState(s) { this.state = s; this.onState(s); }

  // ein Befehl = 12 Byte; Schreiben und Lesen bleiben als Paar zusammen
  _tx(buf, read) {
    const run = async () => {
      await withTimeout(this.link.write(buf), 3000, 'write');
      if (!read) return null;
      const r = await withTimeout(this.link.read(), 3000, 'read');
      const dv = new DataView(r.buffer, r.byteOffset, r.byteLength);
      return [0, 1, 2, 3].map(i => r.byteLength >= i * 2 + 2 ? dv.getUint16(i * 2, true) : 0);
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => { });
    return p;
  }
  cmd(op, v1 = 0, v2 = 0, v3 = 0, v4 = 0, v5 = 0, read = true) {
    const buf = new Uint8Array(12), dv = new DataView(buf.buffer);
    [op, v1, v2, v3, v4, v5].forEach((v, i) => dv.setUint16(i * 2, v & 0xFFFF, true));
    return this._tx(buf, read);
  }
  async status() { const r = await this.cmd(GET_VERSION); return r[3]; }
  async _wait(test, ms = 600000) {
    const t0 = Date.now();
    while (!this._abort) {
      if (test(await this.status())) return true;
      if (Date.now() - t0 > ms) throw new Error(loc('Die Galvo-Steuerung antwortet nicht ({what}).', { what: 'status' }));
      await this.sleep(10);
    }
    return false;
  }
  async writePort() { return this.cmd(WRITE_PORT, this.port); }

  async connect(machine, link = null) {
    this.link = link || this.link || new WebUsbLink();
    await this.link.open();
    this.machine = machine;
    try { await this._init(); }
    catch (e) { await this.link.close().catch(() => { }); throw e; }
    this.connected = true;
    this._setState('idle');
    return true;
  }
  async _init() {
    const g = galvoCfg(this.machine);
    const sn = await this.cmd(GET_SERIAL);
    this.serial = sn.map(v => v.toString(16).padStart(4, '0')).join('');
    await this.cmd(GET_VERSION);
    await this.cmd(RESET);
    await this.cmd(WRITE_COR_TABLE, 0);          // keine Korrekturtabelle (gerade Linien im Feld)
    await this.cmd(ENABLE_LASER);
    await this.cmd(SET_CONTROL_MODE, 0);
    await this.cmd(SET_LASER_MODE, 1);
    await this.cmd(SET_DELAY_MODE, 1);
    await this.cmd(SET_TIMING, 1);
    await this.cmd(SET_STANDBY, 2000, 20);
    await this.cmd(SET_FPK, 200);
    await this.cmd(SET_PWM_HALF_PERIOD, 125);
    await this.cmd(SET_PWM_PULSE_WIDTH, 125);
    if (g.source === 'fiber') await this.cmd(FIBER_SET_MO, 0);
    await this.cmd(SET_FPK_PARAM_2, 0xFFB, 1, 409, 100);
    await this.cmd(SET_FLY_RES, 0, 99, 1000, 25);
    await this.cmd(ENABLE_Z);
    await this.cmd(WRITE_ANALOG_1, 0x7FF);
    await this.cmd(ENABLE_Z);
    this.port = 0;
    await this.writePort();
  }
  async disconnect() {
    if (this.state !== 'idle') await this.stop().catch(() => { });
    this.connected = false;
    if (this.link) await this.link.close().catch(() => { });
    this._setState('idle');
  }

  /* Pakete senden: vor jedem Paket auf „bereit" warten; nach dem dritten Paket die Ausführung starten,
     damit die Steuerung immer Nachschub hat (wie galvoplotter) */
  async _stream(cmds, progress) {
    const packets = packCommands(cmds);
    let executing = false;
    for (let i = 0; i < packets.length; i++) {
      if (this._abort) return false;
      if (!await this._wait(s => s & READY)) return false;
      await this._tx(packets[i], false);
      await this.cmd(SET_END_OF_LIST, 0);
      if (i >= 2 && !executing) { await this.cmd(EXECUTE_LIST); executing = true; }
      if (progress) progress(i + 1, packets.length);
    }
    if (!executing && packets.length) await this.cmd(EXECUTE_LIST);
    return this._wait(s => !(s & BUSY));
  }

  /* Job markieren; program aus buildGalvoProgram */
  async run(program) {
    if (!this.connected) throw new Error(loc('Nicht verbunden'));
    if (this.state !== 'idle') throw new Error(loc('Der Laser ist beschäftigt.'));
    const g = galvoCfg(this.machine);
    this._abort = false;
    this._setState('marking');
    try {
      await this.cmd(RESET_LIST);
      this.port |= 1 << g.laserPin;
      this.port &= ~(1 << g.lightPin);
      await this.writePort();
      if (g.source === 'fiber') await this.cmd(FIBER_SET_MO, 1);
      const ok = await this._stream(program.cmds, (n, t) => this.onProgress(n, t));
      if (ok) await this._finish();
      if (ok) this.onDone();
      return ok;
    } catch (e) {
      await this.stop().catch(() => { });
      throw e;
    } finally {
      if (this.state === 'marking') this._setState('idle');
    }
  }
  async _finish() {
    const g = galvoCfg(this.machine);
    if (g.source === 'fiber') await this.cmd(FIBER_SET_MO, 0);
    this.port &= ~(1 << g.laserPin);
    this.port &= ~(1 << g.lightPin);
    await this.writePort();
  }

  /* Rahmen mit dem Pilotlaser – läuft, bis stop() oder ein neuer Auftrag kommt */
  async frame(box) {
    if (!this.connected) throw new Error(loc('Nicht verbunden'));
    if (this.state === 'framing') return this.stop();
    if (this.state !== 'idle') throw new Error(loc('Der Laser ist beschäftigt.'));
    const g = galvoCfg(this.machine);
    const prog = buildFrameProgram(this.machine, box);
    this._abort = false;
    this._setState('framing');
    try {
      this.port &= ~(1 << g.laserPin);
      this.port |= 1 << g.lightPin;
      await this.writePort();
      while (!this._abort) {
        await this.cmd(RESET_LIST);
        if (!await this._stream(prog.cmds)) break;
        await this.sleep(5);     // Stopp-Knopf und Oberfläche kommen zwischen den Runden zum Zug
      }
    } finally {
      if (this.state === 'framing') {
        this.port &= ~(1 << g.lightPin);
        await this.writePort().catch(() => { });
        this._setState('idle');
      }
    }
  }

  pause() { this.paused = true; return this.cmd(STOP_LIST); }
  resume() { this.paused = false; return this.cmd(RESTART_LIST); }

  /* Sofort anhalten: Ausführung stoppen, Liste leeren, Laser und Pilotlaser aus */
  async stop() {
    this._abort = true;
    this.paused = false;
    if (!this.connected) return;
    const g = galvoCfg(this.machine);
    await this.cmd(STOP_EXECUTE);
    if (g.source === 'fiber') await this.cmd(FIBER_SET_MO, 0);
    await this.cmd(RESET_LIST);
    await this._tx(packCommands([[L_END]])[0], false);
    await this.cmd(SET_END_OF_LIST, 0);
    await this.cmd(EXECUTE_LIST);
    this.port &= ~(1 << g.laserPin);
    this.port &= ~(1 << g.lightPin);
    await this.writePort();
    this._setState('idle');
  }
}

export const GALVO_CMD = { L_JUMP, L_MARK, L_END, L_READY, L_WRITE_PORT, L_MARK_SPEED, L_MARK_CURRENT, L_POWER_RATIO, L_QSWITCH, L_MARK_FREQ, L_ON_POINT, EXECUTE_LIST, SET_END_OF_LIST, STOP_EXECUTE, RESET_LIST, WRITE_PORT, FIBER_SET_MO, GET_VERSION };
