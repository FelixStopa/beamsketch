// serial.js — GRBL über Web Serial oder WLAN (FluidNC-WebSocket): Verbinden, Streaming (Character-Counting),
// Jog, Status. Beide Wege liefern denselben Textstrom; nur Öffnen, Senden und Lesen unterscheiden sich.
import { loc } from './i18n.js';
export class GrblSerial {
  constructor() {
    this.port = null; this.reader = null; this.writer = null;
    this.connected = false;
    this.pending = [];         // Längen der gesendeten, noch nicht quittierten Zeilen
    this.queue = [];           // zu sendende Zeilen
    this.RX = 127;
    this.onLine = () => { };
    this.onStatus = () => { };
    this.onProgress = () => { };
    this.onDone = () => { };
    this.streaming = false; this.paused = false;
    this.sentLines = 0; this.totalLines = 0;
    this.status = { state: '-', mpos: [0, 0, 0], wpos: [0, 0, 0], fs: [0, 0] };
    this._buf = '';
  }
  get supported() { return 'serial' in navigator; }

  /* WLAN: FluidNC (und ESP3D) reichen die GRBL-Ausgabe über einen WebSocket durch – Binär-Frames sind
     Controller-Text, Text-Frames Verwaltungsmeldungen (CURRENT_ID, PING …). Eingaben gehen als Binär-Frames
     zurück. host: „192.168.1.50", „fluidnc.local", „host:port" oder eine volle ws://-Adresse. */
  async connectNet(host) {
    const url = netUrl(host);
    if (!url) throw new Error(loc('Bitte die Adresse des Lasers eintragen (z. B. 192.168.1.50).'));
    if (location.protocol === 'https:' && url.startsWith('ws:') && !/^ws:\/\/(localhost|127\.)/.test(url))
      throw new Error(loc('Der Browser erlaubt von einer https-Seite keine unverschlüsselte WLAN-Verbindung. Starte BeamSketch lokal (http://localhost) oder nutze USB.'));
    const ws = new WebSocket(url, ['arduino']);
    ws.binaryType = 'arraybuffer';
    await new Promise((res, rej) => {
      const t = setTimeout(() => { try { ws.close(); } catch (e) { } rej(new Error(loc('Keine Verbindung zu {u}', { u: url }))); }, 6000);
      ws.onopen = () => { clearTimeout(t); res(); };
      ws.onerror = () => { clearTimeout(t); rej(new Error(loc('Keine Verbindung zu {u}', { u: url }))); };
    });
    const dec = new TextDecoder();
    ws.onmessage = ev => {
      if (typeof ev.data === 'string') {
        if (/^(CURRENT_ID|ACTIVE_ID|PING|DHT):/.test(ev.data)) return;
        this._feed(ev.data + (/\n$/.test(ev.data) ? '' : '\n'));
      } else this._feed(dec.decode(ev.data, { stream: true }));
    };
    ws.onclose = () => { if (this.connected) { this.onLine('er', loc('WLAN-Verbindung getrennt')); this._closed(); } };
    this.ws = ws;
    this.connected = true;
    this._poll = setInterval(() => { if (this.connected) this.raw('?'); }, 250);
    await this.sleep(200);
    this.write('\r\n');
    return true;
  }
  _send(bytes) {
    if (this.ws) { if (this.ws.readyState === 1) this.ws.send(bytes); return Promise.resolve(); }
    return this.writer ? this.writer.write(bytes) : Promise.resolve();
  }
  _closed() {
    this.streaming = false; clearInterval(this._poll);
    this.connected = false; this.port = null; this.reader = null; this.writer = null; this.ws = null;
    this.onStatus(this.status);
  }

  async connect(baud = 115200) {
    if (!this.supported) throw new Error(loc('Web Serial wird von diesem Browser nicht unterstützt. Nutze Chrome, Edge oder Opera (Desktop).'));
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: baud, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
    this.connected = true;
    this.writer = this.port.writable.getWriter();
    this._readLoop();
    this._poll = setInterval(() => { if (this.connected) this.raw('?'); }, 250);
    await this.sleep(300);
    this.write('\r\n');
    return true;
  }
  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async disconnect() {
    this.streaming = false;
    clearInterval(this._poll);
    if (this.ws) { const ws = this.ws; this.connected = false; try { ws.close(); } catch (e) { } this._closed(); return; }
    try { if (this.reader) { await this.reader.cancel(); this.reader.releaseLock(); } } catch (e) { }
    try { if (this.writer) { this.writer.releaseLock(); } } catch (e) { }
    try { if (this.port) await this.port.close(); } catch (e) { }
    this.connected = false; this.port = null; this.reader = null; this.writer = null;
  }

  async _readLoop() {
    const dec = new TextDecoder();
    try {
      this.reader = this.port.readable.getReader();
      while (this.connected) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this._feed(dec.decode(value, { stream: true }));
      }
    } catch (e) {
      this.onLine('er', 'Lesefehler: ' + e.message);
    }
  }
  _feed(text) {
    this._buf += text;
    let i;
    while ((i = this._buf.search(/\r\n|\n|\r/)) >= 0) {
      const line = this._buf.slice(0, i).trim();
      this._buf = this._buf.slice(i + 1).replace(/^\n/, '');
      if (line) this._handle(line);
    }
  }

  _handle(line) {
    if (line[0] === '<') { this._parseStatus(line); return; }
    if (line === 'ok' || line.startsWith('error') || line.startsWith('ALARM')) {
      if (this.pending.length) { this.pending.shift(); this.sentLines++; }
      if (line !== 'ok') this.onLine('er', line);
      else this.onLine('rx', line);
      this.onProgress(this.sentLines, this.totalLines);
      this._pump();
      if (this.streaming && !this.queue.length && !this.pending.length) {
        this.streaming = false; this.onDone();
      }
      return;
    }
    this.onLine('rx', line);
  }

  _parseStatus(line) {
    const s = line.replace(/^<|>$/g, '');
    const parts = s.split('|');
    const st = { state: parts[0], mpos: [0, 0, 0], wpos: [0, 0, 0], fs: [0, 0], raw: line };
    for (const p of parts.slice(1)) {
      const [k, v] = p.split(':');
      if (!v) continue;
      const nums = v.split(',').map(Number);
      if (k === 'MPos') st.mpos = nums;
      if (k === 'WPos') st.wpos = nums;
      if (k === 'WCO') st.wco = nums;
      if (k === 'FS' || k === 'F') st.fs = nums;
      if (k === 'Ov') st.ov = nums;
    }
    if (st.wco) this._wco = st.wco;
    if (!st.wpos.some(v => v) && this._wco) st.wpos = st.mpos.map((v, i) => v - (this._wco[i] || 0));
    this.status = st;
    this.onStatus(st);
  }

  async raw(s) { // Echtzeitbefehl ohne Zeilenende – als einzelne Bytes (0x85 Jog-Abbruch darf kein UTF-8 werden)
    if (!this.connected) return;
    await this._send(Uint8Array.from(s, c => c.charCodeAt(0) & 255));
  }
  async write(s) {
    if (!this.connected) return;
    await this._send(new TextEncoder().encode(s));
    if (s.trim() && s !== '?') this.onLine('tx', s.trim());
  }
  // Einzelbefehl (außerhalb des Streams)
  async command(line) {
    if (!this.connected) throw new Error(loc('Nicht verbunden'));
    this.queue.push(line.trim());
    this.totalLines++;
    this._pump();
  }

  _pump() {
    while (this.queue.length && !this.paused) {
      const line = this.queue[0];
      const len = line.length + 1;
      const used = this.pending.reduce((a, b) => a + b, 0);
      if (used + len > this.RX) break;
      this.queue.shift();
      this.pending.push(len);
      this.write(line + '\n');
    }
  }

  stream(gcode) {
    const lines = gcode.split('\n')
      .map(l => l.replace(/;.*$/, '').replace(/\([^)]*\)/g, '').trim())
      .filter(l => l.length);
    this.queue = lines;
    this.totalLines = lines.length;
    this.sentLines = 0;
    this.pending = [];
    this.streaming = true; this.paused = false;
    this._pump();
    return lines.length;
  }
  pause() { this.paused = true; this.raw('!'); }
  resume() { this.paused = false; this.raw('~'); this._pump(); }
  async stop() {
    this.streaming = false; this.queue = []; this.pending = []; this.paused = false;
    await this.raw('\x18'); // Soft-Reset
    await this.sleep(300);
    await this.command('G90');
    await this.command('M5');
  }
  /* Liest die GRBL-Einstellungen ($$) aus – damit lassen sich Arbeitsfläche,
     Geschwindigkeiten und S-Bereich direkt von der Maschine übernehmen. */
  readSettings(timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error(loc('Nicht verbunden')));
      const map = {};
      const prev = this.onLine;
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.onLine = prev;
        if (err) reject(err);
        else if (Object.keys(map).length) resolve(map);
        else reject(new Error(loc('Keine Antwort auf $$ – ist es eine GRBL-Steuerung?')));
      };
      const timer = setTimeout(() => finish(), timeoutMs);
      this.onLine = (kind, line) => {
        prev(kind, line);
        const m = /^\$(\d+)\s*=\s*(-?[\d.]+)/.exec(line);
        if (m) map['$' + m[1]] = parseFloat(m[2]);
        else if (kind === 'rx' && line === 'ok' && Object.keys(map).length) finish();
      };
      this.command('$$').catch(finish);
    });
  }

  home() { return this.command('$H'); }
  unlock() { return this.command('$X'); }
  zero() { return this.command('G92 X0 Y0'); }
  jog(dx, dy, feed = 3000) {
    return this.command(`$J=G91 G21 X${dx} Y${dy} F${feed}`);
  }
  jogCancel() { return this.raw('\x85'); }
  laserTest(pct, sScale, ms) {
    const S = Math.round(pct / 100 * sScale);
    this.command('M3 S' + S);
    setTimeout(() => { this.command('M5 S0'); }, ms || 300);
  }
}

/* Adresse → WebSocket-URL. FluidNC: Port 81 (WebUI 2); eine volle ws://-Adresse wird übernommen. */
export function netUrl(host) {
  host = String(host || '').trim();
  if (!host) return '';
  if (/^wss?:\/\//i.test(host)) return host;
  host = host.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return 'ws://' + (/:\d+$/.test(host) || /^\[.*\]:\d+$/.test(host) ? host : host + ':81') + '/';
}
