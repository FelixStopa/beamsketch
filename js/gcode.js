// gcode.js — GRBL-GCode-Erzeugung + Laufzeitschätzung
import { V } from './geom.js';
import { layerNo } from './doc.js';
import { jobBounds } from './cam.js';
import { fmtSpeed } from './units.js';

const f4 = v => (Math.round(v * 10000) / 10000).toString();
/* GCode-Dateien bleiben reines ASCII: Controller und Offline-Leser (SD/TF-Karte)
   kommen mit UTF-8 nicht zurecht, und GRBL wertet Bytes ab 0x80 als
   Echtzeitbefehle (z. B. 0x84 = Safety Door) – auch mitten in Kommentaren. */
const ASCII_MAP = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'Ä': 'Ae', 'Ö': 'Oe', 'Ü': 'Ue', 'ß': 'ss', '–': '-', '—': '-', '…': '...', '„': '"', '“': '"', '”': '"', '×': 'x', '°': ' deg' };
export function toAscii(str) {
  return String(str).replace(/[äöüÄÖÜß–—…„“”×°]/g, c => ASCII_MAP[c])
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '');
}
const f3 = v => (Math.round(v * 1000) / 1000).toString();

export function jobOffset(doc, ops) {
  const m = doc.machine;
  if (m.jobOrigin === 'absolute') return { x: 0, y: 0 };
  if (m.jobOrigin === 'user') return { x: -m.userX, y: -m.userY };
  const b = jobBounds(ops);
  if (!isFinite(b.x0)) return { x: 0, y: 0 };
  const ax = m.jobOriginAnchor % 3, ay = Math.floor(m.jobOriginAnchor / 3);
  const px = b.x0 + (b.x1 - b.x0) * (ax / 2);
  const py = b.y0 + (b.y1 - b.y0) * (ay / 2);
  return { x: -px, y: -py };
}

export function generateGCode(doc, ops, opts = {}) {
  const m = doc.machine;
  const S = m.sScale;
  const off = jobOffset(doc, ops);
  const out = [];
  const w = s => out.push(s);
  const X = p => f4(p.x + off.x), Y = p => f4(p.y + off.y);
  const pw = pct => Math.round(Math.max(0, Math.min(100, pct)) / 100 * S);
  const airOn = m.airAssistM7 ? 'M7' : 'M8';

  const b = jobBounds(ops);
  const grbl = m.firmware !== 'Marlin';
  w('; BeamSketch - ' + m.name + ' (' + m.firmware + ')');
  w('; created: ' + new Date().toISOString().slice(0, 19).replace('T', ' '));
  w('; ' + { absolute: 'absolute coords', current: 'current position', user: 'user origin' }[m.jobOrigin]);
  if (isFinite(b.x0)) w('; Bounds: X' + f3(b.x0 + off.x) + ' Y' + f3(b.y0 + off.y) + ' to X' + f3(b.x1 + off.x) + ' Y' + f3(b.y1 + off.y));
  w('; estimated time: ' + fmtTime(estimateTime(doc, ops).seconds));
  if (m.startGcode && m.startGcode.trim()) m.startGcode.split('\n').forEach(l => w(l));
  w(grbl ? 'G00 G17 G40 G21 G54' : 'G21');
  w('G90');
  if (m.jobOrigin === 'current') w('G92 X0 Y0' + (m.enableZ ? ' Z0' : ''));
  // GRBL fährt G0 immer mit Maximalgeschwindigkeit; ein F nur für G0 braucht nur Marlin
  if (!grbl) w('G0 F' + f3(m.rapidSpeed * 60));
  frameLines(m, b, off).forEach(l => w(l));
  let laserMode = null, air = null, curS = -1, curF = -1, curZ = null;
  let lastLayer = null, lastPass = -1;
  let pos = { x: -off.x, y: -off.y };

  const same = (a, b) => Math.abs(a.x - b.x) < 5e-5 && Math.abs(a.y - b.y) < 5e-5;
  const G0 = p => {
    if (same(pos, p)) return;    // schon da – der nächste G1 setzt die Leistung
    w('G0 X' + X(p) + ' Y' + Y(p) + (curS !== 0 ? ' S0' : ''));
    curS = 0; pos = p;
  };
  const G1 = (p, s, f) => {
    if (same(pos, p)) {          // Bewegung ohne Länge – nur Leistung ggf. setzen
      if (s !== curS) { w('G1 S' + s); curS = s; }
      return;
    }
    let line = 'G1 X' + X(p) + ' Y' + Y(p);
    if (f !== curF) { line += ' F' + f3(f); curF = f; }
    if (s !== curS) { line += ' S' + s; curS = s; }
    w(line); pos = p;
  };

  for (const op of ops) {
    const L = op.layerRef;
    if (L.index !== lastLayer || op.pass !== lastPass) {
      const nm = toAscii(L.name || '').trim();   // z. B. japanischer Name → leer
      w('; Layer ' + layerNo(L.index) + (nm ? ' ' + nm : '') + ': ' + L.mode + ' @ ' + fmtSpeed(L.speed) +
        ', ' + L.maxPower + '% power, pass ' + (op.pass + 1) + '/' + L.passes);
      lastLayer = L.index; lastPass = op.pass;
      const wantAir = !!L.airAssist;
      if (wantAir !== air) { w(wantAir ? airOn : 'M9'); air = wantAir; }
      const mode = L.constantPower ? 'M3' : 'M4';
      if (mode !== laserMode) { w(mode + ' S0'); laserMode = mode; curS = 0; }
      if (m.enableZ && op.z !== curZ) { w('G0 Z' + f3(m.negativeZ ? -op.z : op.z)); curZ = op.z; }
    }
    const feed = op.speed * 60;
    const p = op.pts;
    if (op.kind === 'raster' && op.raster) {
      const a = p[0], bb = p[1];
      const total = V.dist(a, bb);
      if (total < 1e-6) continue;
      const u = { x: (bb.x - a.x) / total, y: (bb.y - a.y) / total };
      const lead = op.lead || 0;
      const start = { x: a.x + u.x * lead, y: a.y + u.y * lead };
      const cellLen = (total - 2 * lead) / op.raster.length;
      G0(a);
      if (lead > 0) G1(start, 0, feed);
      let i = 0;
      const maxP = op.power, minP = op.minPower || 0;
      while (i < op.raster.length) {
        let j = i;
        const v = op.raster[i];
        while (j + 1 < op.raster.length && op.raster[j + 1] === v) j++;
        const end = { x: start.x + u.x * cellLen * (j + 1), y: start.y + u.y * cellLen * (j + 1) };
        const power = v <= 0 ? 0 : pw(minP + (maxP - minP) * v);
        G1(end, power, feed);
        i = j + 1;
      }
      if (lead > 0) G1(bb, 0, feed);
      continue;
    }
    if (!p.length) continue;
    G0(p[0]);
    const sVal = pw(op.power);
    if (op.kind === 'fill' && op.lead) { /* Overscan bereits in Punkten enthalten */ }
    if (L.dotMode) {
      for (const q of p) { w('G1 X' + X(q) + ' Y' + Y(q) + ' F' + f3(feed) + ' S0'); w('G1 S' + sVal); w('G4 P' + f3(L.dotTime / 1000)); w('G1 S0'); curS = 0; }
      continue;
    }
    for (let i = 1; i < p.length; i++) G1(p[i], sVal, feed);
    if (op.closed) G1(p[0], sVal, feed);
  }
  w('G1 S0'); w('M5'); w('M9');
  if (m.returnToFinish) w('G0 X' + f4(m.finishX + off.x) + ' Y' + f4(m.finishY + off.y));
  else if (m.jobOrigin === 'current') w('G0 X0 Y0');
  if (m.endGcode && m.endGcode.trim()) m.endGcode.split('\n').forEach(l => w(l));
  w('M2');
  return toAscii(out.join('\n')) + '\n';
}

/* Rahmen vor dem Job: fährt das Umfangsrechteck ab, damit man vor dem Lasern sieht,
   wo gearbeitet wird. 'laser' = mit Test-Leistung (M3, damit auch an den Ecken sichtbar). */
function frameLines(m, b, off) {
  const mode = m.frameBeforeJob || 'off';
  if (mode === 'off' || !isFinite(b.x0)) return [];
  const pts = [{ x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }, { x: b.x0, y: b.y0 }];
  const P = p => 'X' + f4(p.x + off.x) + ' Y' + f4(p.y + off.y);
  const l = ['; Frame', 'G0 ' + P(pts[0])];
  const laser = mode === 'laser';
  if (laser) l.push('M3 S' + Math.round(Math.max(0, Math.min(100, m.laserFirePower)) / 100 * m.sScale));
  const n = Math.max(1, Math.min(5, Math.round(m.frameRepeat || 1)));
  let first = true;
  for (let k = 0; k < n; k++) for (const p of pts.slice(1)) {
    l.push((laser ? 'G1 ' : 'G0 ') + P(p) + (laser && first ? ' F' + f3((m.frameSpeed || 60) * 60) : ''));
    first = false;
  }
  if (laser) l.push('G1 S0', 'M5');
  if (m.framePause > 0) l.push('G4 P' + f3(m.framePause));
  return l;
}
function frameTime(m, b) {
  if (!m.frameBeforeJob || m.frameBeforeJob === 'off' || !isFinite(b.x0)) return 0;
  const per = 2 * ((b.x1 - b.x0) + (b.y1 - b.y0));
  const v = m.frameBeforeJob === 'laser' ? (m.frameSpeed || 60) : (m.rapidSpeed || 400);
  return per * Math.max(1, Math.min(5, Math.round(m.frameRepeat || 1))) / v + (m.framePause || 0);
}

/* Rahmen-GCode (Frame) */
export function frameGCode(doc, ops, mode = 'box') {
  const m = doc.machine;
  const off = jobOffset(doc, ops);
  const b = jobBounds(ops);
  if (!isFinite(b.x0)) return null;
  const S = Math.round(m.laserFirePower / 100 * m.sScale);
  const pts = [
    { x: b.x0, y: b.y0 }, { x: b.x1, y: b.y0 }, { x: b.x1, y: b.y1 }, { x: b.x0, y: b.y1 }, { x: b.x0, y: b.y0 }
  ];
  const l = ['G90', 'G21'];
  if (m.jobOrigin === 'current') l.push('G92 X0 Y0');
  l.push('M4 S' + S, 'G1 F' + (m.rapidSpeed * 60));
  for (const p of pts) l.push('G1 X' + f4(p.x + off.x) + ' Y' + f4(p.y + off.y));
  l.push('S0', 'M5');
  if (m.jobOrigin === 'current') l.push('G0 X0 Y0');
  return l.join('\n') + '\n';
}

/* ---------------- Laufzeitschätzung ----------------
   Modelliert GRBLs Look-ahead: Kreuzungsgeschwindigkeiten aus der Junction
   Deviation, Vorwärts-/Rückwärtspass, danach trapezförmige Profile je Segment. */
function segTime(L, ve, vx, vmax, a) {
  if (L <= 1e-9) return 0;
  const d1 = Math.max(0, (vmax * vmax - ve * ve) / (2 * a));
  const d2 = Math.max(0, (vmax * vmax - vx * vx) / (2 * a));
  if (d1 + d2 <= L) {
    return (vmax - ve) / a + (vmax - vx) / a + (L - d1 - d2) / vmax;
  }
  const vp = Math.sqrt(Math.max(ve * ve, vx * vx, (2 * a * L + ve * ve + vx * vx) / 2));
  return Math.abs(vp - ve) / a + Math.abs(vp - vx) / a;
}
function pathTime(pts, closed, vmax, a, jd) {
  const P = closed && pts.length > 1 ? pts.concat([pts[0]]) : pts;
  const n = P.length;
  if (n < 2) return 0;
  const len = [], dir = [];
  for (let i = 1; i < n; i++) {
    const dx = P[i].x - P[i - 1].x, dy = P[i].y - P[i - 1].y;
    const l = Math.hypot(dx, dy);
    len.push(l);
    dir.push(l > 1e-12 ? { x: dx / l, y: dy / l } : { x: 0, y: 0 });
  }
  const m = len.length;
  const v = new Array(m + 1).fill(vmax);
  v[0] = 0; v[m] = 0;
  for (let i = 1; i < m; i++) {
    const cosT = -(dir[i - 1].x * dir[i].x + dir[i - 1].y * dir[i].y);
    const sinH = Math.sqrt(Math.max(0, (1 - Math.max(-1, Math.min(1, cosT))) / 2));
    if (sinH >= 0.999999) v[i] = vmax;
    else v[i] = Math.min(vmax, Math.sqrt(a * jd * sinH / (1 - sinH)));
  }
  for (let i = 0; i < m; i++) v[i + 1] = Math.min(v[i + 1], Math.sqrt(v[i] * v[i] + 2 * a * len[i]));
  for (let i = m - 1; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] * v[i + 1] + 2 * a * len[i]));
  let t = 0;
  for (let i = 0; i < m; i++) t += segTime(len[i], v[i], v[i + 1], vmax, a);
  return t;
}
export function estimateTime(doc, ops) {
  const m = doc.machine;
  const aMax = Math.min(m.accelX || 3000, m.accelY || 3000);
  const vRapid = m.rapidSpeed || 400;
  const jd = m.junctionDeviation || 0.01;
  const vLimit = Math.max(m.maxSpeedX || 500, m.maxSpeedY || 400);
  let t = 0, cutLen = 0, rapidLen = 0;
  let pos = { x: 0, y: 0 };
  for (const op of ops) {
    const p = op.pts;
    if (!p.length) continue;
    const dR = V.dist(pos, p[0]);
    if (dR > 1e-9) { t += pathTime([pos, p[0]], false, vRapid, aMax, jd); rapidLen += dR; }
    const vmax = Math.min(op.speed, vLimit);
    let seg = 0;
    for (let i = 1; i < p.length; i++) seg += V.dist(p[i - 1], p[i]);
    if (op.closed && p.length > 1) seg += V.dist(p[p.length - 1], p[0]);
    cutLen += seg;
    t += pathTime(p, op.closed, vmax, aMax, jd);
    if (op.layerRef && op.layerRef.dotMode) t += p.length * (op.layerRef.dotTime || 1) / 1000;
    pos = op.closed ? p[0] : p[p.length - 1];
  }
  t += frameTime(m, jobBounds(ops));
  return { seconds: t, cutLen, rapidLen };
}
export function fmtTime(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), mi = Math.floor((s % 3600) / 60), se = s % 60;
  return (h ? h + ' h ' : '') + (h || mi ? mi + ' min ' : '') + se + ' s';
}
